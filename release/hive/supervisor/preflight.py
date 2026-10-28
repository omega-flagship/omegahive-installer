"""The first-boot sandbox preflight (J1 design r4 ST3, r4.1 K-2, Kimi r4.1 P3): proof through the real paths.

Run by the local-owner hive (HIVE_LOCAL_OWNER=1) at every start, before any mind is restored. Every check runs inside
the sandbox exactly as a mind or a tool would get it:

- the mind path: ``sandbox.wrap`` (the same call drivers.py makes), with a tiny Python probe as the command;
- the tool path: ``sandbox_run._run_admitted`` (everything ``sandbox_run.run`` does after its app allowlist) with a
  fixed Node probe bundle, when a ``node`` runtime is configured (HIVE_SANDBOX_RUNTIMES).

A canary file is made at ``<data>/preflight/canary``, outside every granted root. Rows per platform (r4 ST3 table):

| row | Linux / WSL | macOS (sandbox-exec) |
|---|---|---|
| read the canary | denied | denied, EPERM |
| write outside the mind/job folder | denied | denied, EPERM |
| write ``<data>/hive.db`` (Kimi r4.1 P3) | denied | denied, EPERM |
| connect to a loopback port not granted | denied | denied, EPERM |
| connect to an outside address | fails | fails |
| the mind reaches the hive port | yes, through the relay | yes, through the loopback rule |
| a granted read root is readable, the same file is not writable (K-2) | yes | yes |
| new pid / net / user namespaces, loopback only | yes | not applicable |
| ``/etc``: a file outside the literal list is denied | yes | not checked (``/private/etc`` is allowed by design) |
| Landlock ABI >= 1, recorded (K-2) | yes | not applicable |

Pass = every row that applies. Fail = ``sandbox.refuse()``: minds and tools stay refused for this process; nothing
falls back to unsandboxed. The receipt is written to ``<data>/preflight/receipt.json`` (and, once,
``first-boot.json``), mode 0600. Linux/WSL rows are coded here and unit-tested; their real runs belong to J1d/J1e.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import time

from . import sandbox

OUTSIDE = ("192.0.2.1", 9)   # TEST-NET-1 (RFC 5737): never routed; a working sandbox denies it before any packet
DENIED_MAC = frozenset({"EPERM"})
DENIED_LINUX = frozenset({"EPERM", "EACCES", "ENOENT", "EROFS"})   # outside the pivot_root view a path does not exist
TIMEOUT = 30

PY_PROBE = r"""
import errno, json, os, socket, sys
canary, outside, db, granted_file, gport, uport, ohost, oport = sys.argv[1:9]
host_ns = json.loads(sys.argv[9])
out = {}
def name(exc):
    return errno.errorcode.get(getattr(exc, "errno", None) or 0, type(exc).__name__)
def fs(key, fn):
    try:
        fn(); out[key] = "allowed"
    except OSError as exc:
        out[key] = name(exc)
def read(p):
    with open(p, "rb") as f: f.read(1)
def write_new(p):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd)
def open_write(p):
    fd = os.open(p, os.O_WRONLY | os.O_APPEND); os.close(fd)   # opened for writing; not one byte is written
def conn(key, host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(3)
    try:
        s.connect((host, int(port))); out[key] = "allowed"
    except socket.timeout:
        out[key] = "timeout"
    except OSError as exc:
        out[key] = name(exc)
    finally:
        s.close()
fs("read_canary", lambda: read(canary))
fs("write_outside", lambda: write_new(outside))
fs("write_hive_db", lambda: open_write(db))
fs("write_own_folder", lambda: write_new(os.path.join(os.getcwd(), "preflight-ok")))
fs("read_granted", lambda: read(granted_file))
fs("write_granted", lambda: open_write(granted_file))
conn("connect_granted", "127.0.0.1", gport)
conn("connect_ungranted", "127.0.0.1", uport)
conn("connect_outside", ohost, oport)
if sys.platform.startswith("linux"):
    ns = {}
    for kind in ("pid", "net", "user"):
        try:
            ns[kind] = os.readlink("/proc/self/ns/" + kind) != host_ns.get(kind)
        except OSError:
            ns[kind] = False
    out["new_namespaces"] = ns
    try:
        out["interfaces"] = sorted(n for _, n in socket.if_nameindex())
    except OSError:
        out["interfaces"] = None
    fs("read_etc_unlisted", lambda: read("/etc/hostname"))
    fs("read_etc_listed", lambda: read("/etc/hosts"))
print(json.dumps(out))
"""

NODE_PROBE = r"""
const fs = require('fs'), net = require('net');
const [canary, outside, db, granted, gport, uport, ohost, oport] = process.argv.slice(2);
const out = {};
function f(key, fn) { try { fn(); out[key] = 'allowed'; } catch (e) { out[key] = e.code || 'error'; } }
f('read_canary', () => fs.readFileSync(canary));
f('write_outside', () => fs.writeFileSync(outside, 'x', { flag: 'wx' }));
f('write_hive_db', () => fs.closeSync(fs.openSync(db, 'a')));
f('write_own_folder', () => fs.writeFileSync('preflight-ok', 'x', { flag: 'wx' }));
function conn(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) });
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve('allowed'); });
    s.on('error', (e) => { clearTimeout(t); resolve(e.code || 'error'); });
  });
}
(async () => {
  out.connect_granted = await conn('127.0.0.1', gport);
  out.connect_ungranted = await conn('127.0.0.1', uport);
  out.connect_outside = await conn(ohost, oport);
  process.stdout.write(JSON.stringify(out));
})();
"""


def _platform():
    if sys.platform == "darwin":
        return "mac"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def _listener():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s


def _host_namespaces():
    out = {}
    for kind in ("pid", "net", "user"):
        with contextlib.suppress(OSError):
            out[kind] = os.readlink(f"/proc/self/ns/{kind}")
    return out


def _fresh(folder):
    folder = pathlib.Path(folder)
    if folder.is_symlink():
        folder.unlink()
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(mode=0o700, parents=True)
    return folder


def _write_private(path, text):
    path = pathlib.Path(path)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _probe_reads():
    """What the Python probe needs to start inside the mind profile: its venv and the interpreter it was made from."""
    exe = pathlib.Path(os.path.realpath(sys.executable))
    roots = {sys.prefix, sys.base_prefix, str(exe.parent.parent)}
    return [r for r in roots if r]


def _row(rows, row_id, path, check, expect, got, ok, applies=True):
    rows.append({"id": row_id, "path": path, "check": check, "expect": expect, "got": got,
                 "pass": bool(ok) if applies else None, "applies": applies})


def evaluate(platform, path, result, *, mind):
    """The ST3 rows for one probe result (pure: unit-tested for every platform)."""
    rows = []
    denied = DENIED_MAC if platform == "mac" else DENIED_LINUX
    want = "EPERM" if platform == "mac" else "denied"
    get = (result or {}).get
    _row(rows, f"{path}.read_canary", path, "reading the canary is denied", want, get("read_canary"), get("read_canary") in denied)
    _row(rows, f"{path}.write_outside", path, "writing outside the mind/job folder is denied", want, get("write_outside"),
         get("write_outside") in denied)
    _row(rows, f"{path}.write_hive_db", path, "writing <data>/hive.db is denied (Kimi r4.1 P3)", want, get("write_hive_db"),
         get("write_hive_db") in denied)
    _row(rows, f"{path}.write_own_folder", path, "writing its own folder is allowed (the sandbox is not simply broken)",
         "allowed", get("write_own_folder"), get("write_own_folder") == "allowed")
    _row(rows, f"{path}.connect_ungranted", path, "connecting to a loopback port not granted is denied",
         want if platform == "mac" else "not allowed", get("connect_ungranted"),
         get("connect_ungranted") in DENIED_MAC if platform == "mac" else get("connect_ungranted") not in (None, "allowed"))
    _row(rows, f"{path}.connect_outside", path, "connecting to an outside address fails", "not allowed",
         get("connect_outside"), get("connect_outside") not in (None, "allowed"))
    if mind:
        _row(rows, "mind.connect_hive", path, "the mind reaches the hive port (granted loopback)", "allowed",
             get("connect_granted"), get("connect_granted") == "allowed")
        _row(rows, "mind.read_granted", path, "a file in a granted read root is readable (K-2)", "allowed",
             get("read_granted"), get("read_granted") == "allowed")
        _row(rows, "mind.write_granted", path, "the same granted file is not writable (K-2)", want, get("write_granted"),
             get("write_granted") in denied)
        linux = platform == "linux"
        ns = get("new_namespaces") or {}
        _row(rows, "mind.namespaces", path, "new pid, net and user namespaces", "all new", ns or None,
             all(ns.get(k) for k in ("pid", "net", "user")), applies=linux)
        _row(rows, "mind.loopback_only", path, "only the loopback interface exists", ["lo"], get("interfaces"),
             get("interfaces") == ["lo"], applies=linux)
        _row(rows, "mind.etc_unlisted", path, "/etc outside the literal list is denied", "denied", get("read_etc_unlisted"),
             get("read_etc_unlisted") in denied, applies=linux)
    else:
        _row(rows, "tool.connect_loopback", path, "a tool has no network, even to a loopback listener", "not allowed",
             get("connect_granted"), get("connect_granted") not in (None, "allowed"))
    return rows


def _mind_probe(pf, data_dir, granted, ungranted, host_ns):
    mind_dir = _fresh(pf / "mind")
    read_root = _fresh(pf / "read-root")
    granted_file = read_root / "granted.txt"
    granted_file.write_text("preflight\n")
    command = [sys.executable, "-I", "-S", "-c", PY_PROBE, str(pf / "canary"), str(pf / "outside-mind"),
               str(pathlib.Path(data_dir) / "hive.db"), str(granted_file), str(granted), str(ungranted),
               OUTSIDE[0], str(OUTSIDE[1]), json.dumps(host_ns)]
    argv, profile = sandbox.wrap(command, mind_dir, _probe_reads() + [str(read_root)], pf / "profiles", "preflight",
                                 ports=(granted,), programs=(sys.executable,))
    done = subprocess.run(argv, cwd=mind_dir, env={"PATH": "/usr/bin:/bin", "HOME": str(mind_dir), "LANG": "C.UTF-8"},
                          stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    return _last_json(done.stdout), {"argv0": argv[0], "exit": done.returncode, "profile": profile}


def _tool_probe(pf, data_dir, granted, ungranted):
    from ..core import sandbox_run
    app = _fresh(pf / "app")
    tools = app / "tools"
    tools.mkdir()
    (tools / "probe.js").write_text(NODE_PROBE)
    lock = {"files": {"probe.js": hashlib.sha256((tools / "probe.js").read_bytes()).hexdigest()}}
    (tools / "bundle.lock.json").write_text(json.dumps(lock))
    program = {"id": "omegahive-preflight", "path": str(app)}
    out = asyncio.run(sandbox_run._run_admitted(
        program, "probe.js", args=[str(pf / "canary"), str(pf / "outside-tool"), str(pathlib.Path(data_dir) / "hive.db"),
                                   str(pf / "read-root" / "granted.txt"), str(granted), str(ungranted),
                                   OUTSIDE[0], str(OUTSIDE[1])],
        runtime="node", bundle="tools", cpu_seconds=10, timeout=TIMEOUT))
    return _last_json(out["stdout"]), {"exit": out["exit"]}


def _last_json(raw):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw or "")
    for line in reversed(text.strip().splitlines()):
        with contextlib.suppress(ValueError):
            value = json.loads(line)
            if isinstance(value, dict):
                return value
    return None


def run(data_dir):
    """Run every row that applies on this host; returns the receipt (never raises for a failed check)."""
    data_dir = pathlib.Path(data_dir)
    platform = _platform()
    receipt = {"version": 1, "platform": platform, "at": time.time(), "rows": [], "pass": False, "status": "fail",
               "minds": False, "tools": False, "reason": None,
               "backend": sandbox.backend(), "sandbox_python": os.environ.get("HIVE_SANDBOX_PYTHON") or None,
               "landlock_abi": None, "tool_path": None, "mind_path": None}
    if receipt["backend"] is None:
        receipt["reason"] = "this computer has no OS sandbox the hive can use"
        return receipt
    pf = data_dir / "preflight"
    pf.mkdir(mode=0o700, exist_ok=True)
    os.chmod(pf, 0o700)
    (pf / "canary").write_text(secrets.token_hex(16))
    for stale in ("outside-mind", "outside-tool"):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(pf / stale)
    granted, ungranted = _listener(), _listener()
    try:
        gport, uport = granted.getsockname()[1], ungranted.getsockname()[1]
        if platform == "linux":
            from . import landlock
            abi = landlock.abi_version()
            receipt["landlock_abi"] = abi
            _row(receipt["rows"], "host.landlock_abi", "host", "Landlock ABI >= 1 (K-2)", ">= 1", abi, abi >= 1)
        try:
            result, meta = _mind_probe(pf, data_dir, gport, uport, _host_namespaces())
        except Exception as exc:   # the probe could not even run: every mind row fails
            result, meta = None, {"error": f"{type(exc).__name__}: {exc}"}
        receipt["mind_path"] = meta
        receipt["rows"] += evaluate(platform, "mind", result, mind=True)
        from ..core import sandbox_run
        if "node" in sandbox_run._runtimes():
            try:
                result, meta = _tool_probe(pf, data_dir, gport, uport)
            except Exception as exc:
                result, meta = None, {"error": f"{type(exc).__name__}: {exc}"}
            receipt["tool_path"] = meta
            receipt["rows"] += evaluate(platform, "tool", result, mind=False)
        else:
            receipt["tool_path"] = {"skipped": "no node runtime is configured (HIVE_SANDBOX_RUNTIMES); tools cannot run"}
    finally:
        granted.close()
        ungranted.close()
    failed = [r["id"] for r in receipt["rows"] if r["applies"] and not r["pass"]]
    tools_checked = any(r["id"].startswith("tool.") for r in receipt["rows"])
    if not any(r["id"].startswith("mind.") for r in receipt["rows"]):
        failed = failed or ["mind.rows_missing"]   # no mind row at all is never a verified mind path
    # J1b r1.1 (stand-in r1.0 P2-2): three outcomes. "pass" only when both paths were exercised and every row passed;
    # "incomplete" when every row that ran passed but the tool rows were skipped (minds verified, tools unverified and
    # kept refused); "fail" otherwise (minds and tools refused).
    if failed:
        receipt["status"] = "fail"
        receipt["reason"] = f"sandbox checks failed: {', '.join(failed)}"
    elif not tools_checked:
        receipt["status"] = "incomplete"
        receipt["reason"] = ("tools unverified: no node runtime is configured (HIVE_SANDBOX_RUNTIMES), so the tool "
                             "rows did not run; minds may run, tools stay refused")
    else:
        receipt["status"] = "pass"
        receipt["reason"] = None
    receipt["pass"] = receipt["status"] == "pass"
    receipt["minds"] = not failed
    receipt["tools"] = receipt["pass"]
    return receipt


def run_and_record(data_dir):
    """run(), the receipt written (0600), and on failure every mind and tool refused for this process."""
    data_dir = pathlib.Path(data_dir)
    try:
        receipt = run(data_dir)
    except Exception as exc:   # anything unexpected is a failed preflight, never a pass
        receipt = {"version": 1, "platform": _platform(), "at": time.time(), "rows": [], "pass": False,
                   "status": "fail", "minds": False, "tools": False,
                   "reason": f"the sandbox preflight could not run: {type(exc).__name__}: {exc}"}
    status = receipt.get("status")
    if status == "incomplete" and receipt.get("minds") and not receipt.get("pass"):
        sandbox.refuse_tools(receipt["reason"])   # minds were verified; tools were not, so they stay refused
    elif status != "pass" or not receipt.get("pass"):
        sandbox.refuse(receipt["reason"])         # anything else that is not a complete pass refuses minds and tools
    with contextlib.suppress(OSError):
        pf = data_dir / "preflight"
        pf.mkdir(mode=0o700, exist_ok=True)
        text = json.dumps(receipt, indent=1, default=str)
        _write_private(pf / "receipt.json", text)
        if not (pf / "first-boot.json").exists():
            _write_private(pf / "first-boot.json", text)
    return receipt
