"""Run a pinned tool bundle for an app inside the OS sandbox (capability ``sandbox:run``).

the owner (2026-10-04): Studio is "another app within the hive app". The hive gives apps one generic, isolated way to run
their own tools; apps keep their own operations. Design proved the boundary (studio_sandbox.py, studio_limits.sh);
this is the platform's version of it.

- Who: an app that declares ``sandbox:run`` AND is on the operator's allowlist (HIVE_SANDBOX_RUN_APPS). Both.
- What: a bundle inside the app's own reviewed folder, checked file by file against the app's lock file
  (``<bundle>/bundle.lock.json``: {"files": {"rel/path": "<sha256>"}}) before every run. No other files may exist.
- Which runtime: by name from the operator's map (HIVE_SANDBOX_RUNTIMES, e.g. {"node": "/opt/homebrew/bin/node"}).
- Boundary: sandbox-exec on macOS; existing namespace/Landlock wrapper with no relay ports on Linux. Deny by default; reads = the bundle, the runtime's install
  prefix and system roots; writes = a fresh job folder only. A fixed launcher sets CPU and file-size limits.
  Scrubbed environment; the process group is killed on timeout or cancel. No sandbox → refuse (fail closed).
- Network (r14.4): none. macOS: every network clause is removed from the profile. Linux: a fresh network namespace
  with only loopback and no relay ports; the launcher verifies the namespace and exits 78 if it cannot, and this
  runner refuses a written profile that lists any port.
- available() is the same predicate run() enforces (r14.4, Root): a known boundary, the launcher present, and the
  launcher really able to set its limits here (on Linux: Landlock + namespaces + a working prlimit).
- Returns bytes, never interprets them: exit code, bounded stdout/stderr, and the declared output files.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import tempfile

from ..supervisor.sandbox import MAC_SYSTEM_READ, backend, profile, safe_roots, tools_refused, wrap

LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "supervisor" / "limits.sh"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RUN_PATH = "/usr/bin:/bin"   # the PATH every tool run (and the availability pre-check) gets: prlimit must be on it
MAX_INPUT, MAX_OUTPUT, MAX_STDOUT, MAX_STDERR = 20 * 1024 * 1024, 30 * 1024 * 1024, 256 * 1024, 16 * 1024


def _allowed_apps():
    return {a.strip() for a in os.environ.get("HIVE_SANDBOX_RUN_APPS", "").split(",") if a.strip()}


def _runtimes():
    """Operator map: name -> path, or name -> {"exe": path, "reads": [extra read-only folders]} (e.g. a venv's
    interpreter plus PeTTa/SWI roots). The exe runs exactly as configured (a venv python keeps its packages)."""
    try:
        out = json.loads(os.environ.get("HIVE_SANDBOX_RUNTIMES", "") or "{}")
    except ValueError:
        return {}
    if not isinstance(out, dict):
        return {}
    runtimes = {}
    for k, v in out.items():
        if isinstance(v, str):
            runtimes[k] = {"exe": v, "reads": []}
        elif isinstance(v, dict) and isinstance(v.get("exe"), str):
            runtimes[k] = {"exe": v["exe"], "reads": [r for r in v.get("reads", []) if isinstance(r, str)]}
    return runtimes


def _launcher_works():
    """The fixed launcher, run exactly as a tool run runs it (same shell, same PATH), sets 1 s / 1 KiB limits and execs
    `/bin/sh -c :` (present on every host). On Linux that is the real prlimit path (absent or failing prlimit -> 78 -> False)."""
    import subprocess
    try:
        done = subprocess.run(["/bin/sh", str(LAUNCHER), "1", "1024", "/bin/sh", "-c", ":"], env={"PATH": RUN_PATH},
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def available():
    """True only when run() can really execute a tool on this host: sandbox-exec (macOS) or namespaces + Landlock
    (Linux; backend() already requires both), the fixed launcher present, and the launcher's limit pre-check passing.
    run() refuses on exactly this predicate, so a caller's preflight and the run path cannot disagree."""
    if tools_refused() is not None:   # the local-owner preflight could not verify this path (J1b r1.1)
        return False
    return backend() in {"sandbox-exec", "landlock"} and LAUNCHER.is_file() and _launcher_works()


def verify_bundle(app_dir, bundle):
    """The bundle folder inside the app, exactly matching its lock file. Returns the resolved folder."""
    app_dir = pathlib.Path(app_dir).resolve()
    if not isinstance(bundle, str) or not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", bundle) or ".." in bundle.split("/"):
        raise ValueError("bundle is a plain relative folder inside the app")
    root = (app_dir / bundle).resolve()
    if app_dir not in root.parents or not root.is_dir():
        raise ValueError("bundle must be a folder inside the app")
    lock = json.loads((root / "bundle.lock.json").read_text())
    files = lock.get("files") if isinstance(lock, dict) else None
    if not isinstance(files, dict) or not files:
        raise ValueError("bundle.lock.json lists the bundle's files and their sha256")
    present = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() or p.is_symlink()} - {"bundle.lock.json"}
    if present != set(files):
        raise ValueError("bundle files differ from its lock (extra or missing files)")
    for rel, digest in files.items():
        p = root / rel
        if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            raise ValueError(f"bundle file changed: {rel}")
    return root


_REACHABLE = {}   # probe key -> monotonic time of the last successful probe (bounded, oldest evicted)
REACHABLE_TTL, REACHABLE_MAX = 300, 64


def _granted(kind, reads):
    """The read roots the sandbox will actually grant for `reads`, as resolved real paths: what sandbox.wrap and
    sandbox_policy pass on (safe_roots), then, on Linux, the launcher profile's own already-resolved filter."""
    roots = safe_roots(reads)
    if kind == "landlock":
        from ..supervisor import landlock
        roots = [r for r in roots if os.path.realpath(r) == os.path.normpath(os.path.abspath(r))]
        roots += [r for r in landlock.SYSTEM_READ if r != "/proc"]
    else:
        roots += list(MAC_SYSTEM_READ)
    return tuple(sorted(set(roots)))


def _probe_key(kind, exe, granted):
    """Everything the probe's answer depends on: backend, the exe as configured and as resolved (with its identity),
    and the exact granted roots. A config, backend, symlink, interpreter content or permission change (mode, owner,
    ctime: Root r3) is a new key, never a stale hit."""
    try:
        st = os.stat(exe)
        ident = (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
    except OSError:
        ident = None
    return (kind, exe, os.path.realpath(exe), ident, granted)


def _runtime_reachable(kind, exe, reads):
    """Probe, through the same boundary a job gets (Linux: launcher, profile shape and programs mirror; macOS: the same
    sandbox-exec policy), that `exe` is executable inside it (test -x; nothing of the runtime itself runs). Successes
    are cached briefly under a key that covers everything the answer depends on; failures are never cached, so a
    fixed host recovers on the next job. Each miss costs one sandboxed /bin/sh spawn: an intended admission cost."""
    import subprocess, time
    key = _probe_key(kind, exe, _granted(kind, reads))
    if time.monotonic() - _REACHABLE.get(key, -1e9) < REACHABLE_TTL:
        return True
    with tempfile.TemporaryDirectory(prefix="sbx-probe-") as folder:
        job = pathlib.Path(folder).resolve()
        probe = ["/bin/sh", "-c", 'test -x "$0"', exe]
        if kind == "landlock":
            argv, _ = wrap(probe, job, list(reads) + [str(LAUNCHER)], job / ".sandbox-profile",
                           "runtime-probe", ports=(), programs=(exe,))
        else:
            argv = ["/usr/bin/sandbox-exec", "-p", sandbox_policy(job, reads)] + probe
        try:
            ok = subprocess.run(argv, cwd=job, env={"PATH": RUN_PATH, "HOME": str(job), "TMPDIR": str(job)},
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
    if ok:
        _REACHABLE.pop(key, None)
        _REACHABLE[key] = time.monotonic()
        while len(_REACHABLE) > REACHABLE_MAX:
            _REACHABLE.pop(next(iter(_REACHABLE)))
    return ok


def sandbox_policy(job, reads):
    """The hive's deny-by-default profile with every network clause removed (empty ports alone would not be safe)."""
    reads = [r for r in safe_roots(reads)]
    lines = profile(job, reads).splitlines()
    policy = "\n".join(line for line in lines if not line.startswith("(allow network-")) + "\n"
    return policy + "(allow file-read* (literal " + json.dumps(str(LAUNCHER)) + "))\n"


async def run(program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools",
              cpu_seconds=10, file_bytes=30 * 1024 * 1024, timeout=30):
    """Run ``runtime <bundle>/<entry> args...`` in a fresh job folder. See the module docstring."""
    if program["id"] not in _allowed_apps():
        raise PermissionError(f"{program['id']} is not allowed to run sandboxed tools on this hive (HIVE_SANDBOX_RUN_APPS)")
    return await _run_admitted(program, entry, args, inputs, outputs, runtime, bundle, cpu_seconds, file_bytes, timeout)


async def _run_admitted(program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools",
                        cpu_seconds=10, file_bytes=30 * 1024 * 1024, timeout=30):
    """Everything run() does after the app allowlist: the one execution path, also driven by the local-owner hive's
    sandbox preflight (hive/supervisor/preflight.py) with its own fixed bundle, so the preflight proves this path."""
    kind = backend()
    if kind not in {"sandbox-exec", "landlock"} or not await asyncio.to_thread(available):   # off the event loop
        raise RuntimeError("sandbox unavailable: refusing to run tools unsandboxed")
    runtimes = _runtimes()
    if runtime not in runtimes or not pathlib.Path(runtimes[runtime]["exe"]).is_file():
        raise ValueError(f"runtime is one of: {', '.join(sorted(runtimes)) or 'none configured'}")
    if type(cpu_seconds) is not int or not 1 <= cpu_seconds <= 60 or type(file_bytes) is not int or not 1024 <= file_bytes <= MAX_OUTPUT:
        raise ValueError("cpu_seconds 1..60, file_bytes 1 KiB..30 MiB")
    if not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
        raise ValueError("timeout 1..120 seconds")
    root = verify_bundle(program["path"], bundle)
    entry_path = (root / str(entry)).resolve()
    if root not in entry_path.parents or not entry_path.is_file():
        raise ValueError("entry is a file in the bundle")
    args = [str(a) for a in (args or ())]
    if len(args) > 32 or any(len(a) > 4096 for a in args):
        raise ValueError("at most 32 arguments of 4096 characters")
    inputs = inputs or {}
    outputs = list(outputs or ())
    for name in list(inputs) + outputs:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError("input/output names are plain file names")
    if sum(len(v) for v in inputs.values()) > MAX_INPUT:
        raise ValueError("inputs exceed 20 MiB")
    exe = pathlib.Path(runtimes[runtime]["exe"]).absolute()     # run as configured: a venv interpreter keeps its venv
    real = pathlib.Path(os.path.realpath(exe))
    reads = [str(root)] + list(runtimes[runtime]["reads"])
    for e in {exe, real}:   # the runtime's own install prefix, both as configured and as resolved
        reads.append(str(e.parent.parent if e.parent.name == "bin" else e.parent))
        for prefix in ("/opt/homebrew", "/usr/local"):   # its shared libraries (read only), as minds already have
            if str(e).startswith(prefix + "/"):
                reads += [f"{prefix}/opt", f"{prefix}/lib", f"{prefix}/Cellar"]
    # Admission must observe what execution needs, on both backends (Kimi runtime-mirror r1, r2): the runtime's real
    # path lies under the roots the sandbox will actually grant (not the raw list), and the exact exe is executable
    # inside the same boundary the job will get.
    granted = [pathlib.Path(r) for r in _granted(kind, reads)]
    if not any(real == r or r in real.parents for r in granted):
        raise RuntimeError(f"sandbox unavailable: runtime {runtime!r} resolves outside its read roots")
    if not await asyncio.to_thread(_runtime_reachable, kind, str(exe), tuple(reads)):
        raise RuntimeError(f"sandbox unavailable: runtime {runtime!r} is not executable inside the sandbox view")
    with tempfile.TemporaryDirectory(prefix="sbx-") as folder:
        job = pathlib.Path(folder).resolve()
        for name, data in inputs.items():
            (job / name).write_bytes(data if isinstance(data, bytes) else str(data).encode())
        if kind == "landlock":
            command = ["/bin/sh", str(LAUNCHER), str(cpu_seconds), str(file_bytes),   # exact bytes (limits.sh)
                       str(exe), str(entry_path), *args]
            # Inputs/outputs are flat NAMEs, so this job-owned metadata folder cannot collide with them.
            # The wrapper reads this profile before executing the tool; no token or authority is stored here.
            # The runtime is exec'd by limits.sh, not as argv[0]: name it so the launcher mirrors its symlink chain
            # (a venv python -> uv's version alias -> the real interpreter; without it: "exec: ...: not found").
            argv, written = wrap(command, job, reads + [str(LAUNCHER)], job / ".sandbox-profile",
                                 "app-bundle", ports=(), programs=(str(exe),))
            # No network: the profile the launcher will read must list no relay port (the namespace itself is
            # verified fresh and loopback-only by the launcher, which exits 78 otherwise).
            try:
                ports = json.loads(pathlib.Path(written).read_text()).get("connect_ports")
            except (OSError, ValueError, AttributeError):
                ports = None
            if ports != []:
                raise RuntimeError("sandbox unavailable: the tool profile would allow network access; refusing")
        else:
            argv = ["/usr/bin/sandbox-exec", "-p", sandbox_policy(job, reads), "/bin/sh", str(LAUNCHER),
                    str(cpu_seconds), str(file_bytes), str(exe), str(entry_path), *args]
        env = {"PATH": RUN_PATH, "TMPDIR": str(job), "HOME": str(job), "LANG": "en_US.UTF-8", "OPENSSL_CONF": "/dev/null"}
        proc = await asyncio.create_subprocess_exec(*argv, cwd=job, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    start_new_session=True)
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        except BaseException:   # timeout or cancellation: the whole process group goes
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            with contextlib.suppress(Exception):
                await proc.wait()
            raise
        produced = {}
        for name in outputs:
            p = job / name
            if p.is_file() and not p.is_symlink() and p.stat().st_size <= MAX_OUTPUT:
                produced[name] = p.read_bytes()
        return {"exit": proc.returncode, "stdout": stdout[:MAX_STDOUT], "stderr": stderr[:MAX_STDERR],
                "stdout_truncated": len(stdout) > MAX_STDOUT, "outputs": produced,
                "missing_outputs": [n for n in outputs if n not in produced]}
