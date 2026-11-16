"""Linux mind isolation (namespaces + Landlock): the boundary the macOS profile proves in test_mind_sandbox.py, plus
Review's 6f47d4c bypass probes (an /etc secret, UDP egress, an outside abstract socket, signalling an outside peer).

The integration test runs only on Linux with Landlock and unprivileged user namespaces. On a Mac, run it in a Linux
container (Docker's default seccomp profile blocks unshare, so the container needs seccomp=unconfined):
  docker run --rm --security-opt seccomp=unconfined -v "$PWD":/src -w /src python:3.12-slim \
    sh -c "pip -q install pytest && python -m pytest -q hive/tests/test_mind_sandbox_linux.py"
"""

import contextlib
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

import pytest

from hive.supervisor import landlock, sandbox

LINUX = sys.platform.startswith("linux") and landlock.available()
# The mind launcher (landlock.py) runs only on Linux. A test that starts a tool through it waits for the tool with
# os.waitid (#85's stop, _reap_ending_on_sigterm), which macOS's Python lacks.
LAUNCHER_RUNS_HERE = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the launcher runs on Linux")


def test_profile_lists_only_the_mind_runtime_and_ports(tmp_path):
    mind = tmp_path / "mind"
    mind.mkdir()
    prof = landlock.profile(mind, [tmp_path / "runtime"], [8700, 8724, 8700])
    assert prof["mind_dir"] == str(mind.resolve())
    assert prof["connect_ports"] == [8700, 8724]
    assert str((tmp_path / "runtime").resolve()) in prof["read"]
    assert "/" not in prof["read"] and str(tmp_path) not in prof["read"]
    assert "/etc" not in prof["read"], "never the whole of /etc: deployment secrets live there"
    assert all(p.startswith("/etc/") for p in prof["read"] if p.startswith("/etc"))


def test_wrap_never_runs_unisolated_when_no_backend(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "backend", lambda: None)
    with pytest.raises(RuntimeError):
        sandbox.wrap(["true"], tmp_path, [], tmp_path / "p", "a_x", ports=[8700])


def test_unavailable_without_landlock_or_namespaces(monkeypatch):
    monkeypatch.setattr(landlock, "abi_version", lambda: 0)
    assert landlock.available() is False
    monkeypatch.setattr(landlock, "abi_version", lambda: 8)
    monkeypatch.setattr(landlock, "namespaces_available", lambda: False)
    assert landlock.available() is False
    with pytest.raises(OSError):
        landlock.restrict_files({"mind_dir": "/tmp", "read": [], "connect_ports": []}, abi=0)


def test_wrap_writes_a_linux_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    cmd, path = sandbox.wrap(["/bin/echo", "hi"], tmp_path / "mind", [tmp_path / "rt"], tmp_path / "p", "a_x", ports=[8700])
    assert cmd[:3] == sandbox.launcher() and cmd[3] == path and cmd[4] == "--" and cmd[-2:] == ["/bin/echo", "hi"]
    assert json.loads(open(path).read())["connect_ports"] == [8700]


def test_the_launcher_runs_by_its_own_path(monkeypatch):
    """An AppArmor profile attaches to the file the kernel executes, so the launcher must be that file: executable,
    with a shebang, as deploy/apparmor/omegahive-mind-launcher expects on Ubuntu 23.10+. The shebang runs the
    interpreter sandbox.launcher passes in HIVE_SANDBOX_PYTHON, so PATH never picks what runs under the profile."""
    assert os.access(landlock.__file__, os.X_OK)
    with open(landlock.__file__, encoding="utf-8") as f:
        assert f.readline() == "#!/usr/bin/env -S ${HIVE_SANDBOX_PYTHON} -I -B -S\n"
    monkeypatch.delenv("HIVE_SANDBOX_PYTHON", raising=False)
    env, chosen, path = sandbox.launcher()
    assert env == "/usr/bin/env" and chosen == "HIVE_SANDBOX_PYTHON=" + sys.executable
    assert os.path.samefile(path, landlock.__file__)


def test_the_launchers_interpreter_comes_from_hive_sandbox_python(monkeypatch):
    """HIVE_SANDBOX_PYTHON names the interpreter (an installer sets one only root or the hive's account can change);
    unset or blank, the hive's own. A bare name is refused, never looked up on PATH, and so is a path that is not an
    executable file, which would otherwise fail every launch inside env."""
    chosen = os.path.realpath(sys.executable)
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", chosen)
    assert sandbox.launcher()[1] == "HIVE_SANDBOX_PYTHON=" + chosen
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", "  ")
    assert sandbox.launcher()[1] == "HIVE_SANDBOX_PYTHON=" + sys.executable
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", "python3")
    with pytest.raises(RuntimeError, match="absolute"):
        sandbox.launcher()
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", "/nonexistent/bin/python3")
    with pytest.raises(RuntimeError, match="not an executable file"):
        sandbox.launcher()


def test_an_unconfined_launcher_says_why_it_cannot_isolate(tmp_path):
    """Where Ubuntu restricts unprivileged user namespaces, an unconfined launcher without CAP_SYS_ADMIN fails at
    /proc/self/setgroups, and this names the missing profile for its message. Confined, holding CAP_SYS_ADMIN (bit 21)
    and nothing else, with the restriction off, or without AppArmor, there is nothing to report. The defaults are the
    kernel's own files, so a typo there cannot quietly switch the check off."""
    import inspect
    def refusal(restrict, label, capeff):
        files = {"r": restrict, "l": label, "s": f"Name:\tpython3\nCapEff:\t{capeff}\n"}
        for name, text in files.items():
            if text is not None:
                (tmp_path / name).write_text(text)
            elif (tmp_path / name).exists():
                (tmp_path / name).unlink()
        return landlock.apparmor_refusal(str(tmp_path / "r"), str(tmp_path / "l"), str(tmp_path / "s"))

    everything_but_sys_admin = f"{((1 << 41) - 1) & ~(1 << 21):016x}"
    assert "omegahive-mind-launcher" in refusal("1\n", "unconfined\n", "0000000000000000")
    assert "omegahive-mind-launcher" in refusal("1\n", "unconfined\n", everything_but_sys_admin)
    assert refusal("0\n", "unconfined\n", "0000000000000000") is None
    assert refusal("1\n", "omegahive-mind-launcher (unconfined)\n", "0000000000000000") is None
    assert refusal("1\n", "unconfined\n", f"{1 << 21:016x}") is None
    assert refusal(None, "unconfined\n", "0000000000000000") is None
    assert refusal("1\n", None, "0000000000000000") is None
    defaults = {k: p.default for k, p in inspect.signature(landlock.apparmor_refusal).parameters.items()}
    assert defaults == {"restrict": "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
                        "label": "/proc/self/attr/current", "status": "/proc/self/status"}


@LAUNCHER_RUNS_HERE
def test_the_shebang_starts_the_launcher_on_the_named_interpreter():
    """The command sandbox.launcher returns runs landlock.py through its shebang on HIVE_SANDBOX_PYTHON's interpreter:
    with no profile it reaches main() and prints its usage, on any Linux host."""
    run = subprocess.run(sandbox.launcher(), capture_output=True, text=True, timeout=30)
    assert run.returncode == 2 and run.stderr.startswith("usage: HIVE_SANDBOX_PYTHON="), (run.returncode, run.stderr)


def test_a_launcher_path_with_an_equals_sign_is_refused(monkeypatch):
    """env would read such a path as one more assignment and run the next argument instead."""
    monkeypatch.setattr(sandbox, "__file__", "/opt/omegahive/releases/a=b/omegahive/hive/supervisor/sandbox.py")
    with pytest.raises(RuntimeError, match="must not contain '='"):
        sandbox.launcher()


def test_a_launcher_that_lost_its_exec_bit_is_refused(tmp_path, monkeypatch):
    """A release copied without file modes makes env exit 126 on every launch, and the probe then reports the tool's
    runtime as not executable; refusing up front names the launcher, as interpreter() does for the interpreter."""
    (tmp_path / "landlock.py").write_text("#!/usr/bin/env -S ${HIVE_SANDBOX_PYTHON} -I -S\n")
    monkeypatch.setattr(sandbox, "__file__", str(tmp_path / "sandbox.py"))
    with pytest.raises(RuntimeError, match="not executable"):
        sandbox.launcher()


def _tcp_listener():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(8)

    def loop():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            c.sendall(b"hive")
            c.close()
    threading.Thread(target=loop, daemon=True).start()
    return s.getsockname()[1]


PROBE = r'''
import json, os, signal, socket, sys
cfg = json.loads(sys.argv[1])
out = {}
def t(name, f):
    try:
        out[name] = f()
    except OSError as e:
        out[name] = "denied"
def read(p):
    return open(p).read() and "read"
def write(p):
    open(p, "w").write("x"); return "ok"
def tcp(port):
    s = socket.create_connection(("127.0.0.1", port), 3); d = s.recv(10); s.close(); return d.decode() or "empty"
def udp(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b"ESCAPED", ("127.0.0.1", port)); return "sent"
def abstract(name):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect("\0" + name); return "connected"
def kill(pid):
    os.kill(pid, signal.SIGTERM); return "signalled"
t("write_own", lambda: write(cfg["own"]))
t("read_secret", lambda: read(cfg["secret"]))
t("read_etc_secret", lambda: read(cfg["etc_secret"]))
t("write_other", lambda: write(cfg["other"]))
t("tcp_hive", lambda: tcp(cfg["hive_port"]))
t("tcp_other", lambda: tcp(cfg["other_port"]))
t("udp_out", lambda: udp(cfg["udp_port"]))
t("abstract_outside", lambda: abstract(cfg["abstract"]))
t("kill_outside", lambda: kill(cfg["peer_pid"]))
t("proc_hive_environ", lambda: read("/proc/%d/environ" % cfg["hive_pid"]))
def truncate(p):
    os.truncate(p, 0); return "truncated"
def unix(p):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(p); return "connected"
t("truncate_outside", lambda: truncate(cfg["outside_file"]))
t("unix_in_runtime_root", lambda: unix(cfg["runtime_sock"]))
def make_unix():
    socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close(); return "created"
t("create_unix_socket", make_unix)
def pair():
    a, b = socket.socketpair(); a.sendall(b"x"); v = b.recv(1); a.close(); b.close(); return "ok" if v == b"x" else "bad"
t("socketpair", pair)
def dgram_reconnect(target):
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
    a.connect(target); a.send(b"PROBE"); return "reached"
t("dgram_pair_reconnect", lambda: dgram_reconnect(cfg["runtime_dgram"]))
def seqpacket_pair():
    socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET); return "created"
t("seqpacket_pair", seqpacket_pair)
t("read_via_runtime_symlink", lambda: read(cfg["link_secret"]))
out["symlink_target_visible"] = os.path.exists(os.path.dirname(cfg["link_secret"]))
if cfg.get("etc_link"):
    t("read_via_etc_symlink", lambda: read(cfg["etc_link"]))
if cfg.get("nested_file"):
    t("truncate_nested_mount", lambda: truncate(cfg["nested_file"]))
    def ftrunc(p):
        fd = os.open(p, os.O_RDWR); os.ftruncate(fd, 0); os.close(fd); return "truncated"
    t("ftruncate_nested_mount", lambda: ftrunc(cfg["nested_file"]))
t("unix_outside", lambda: unix(cfg["outside_sock"]))
try:
    out["visible_pids"] = len([p for p in os.listdir("/proc") if p.isdigit()])
except OSError:
    out["visible_pids"] = 0
print(json.dumps(out))
'''


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
def test_mind_reaches_only_its_folder_and_the_hive(tmp_path):
    mind = tmp_path / "mind"
    mind.mkdir()
    data = tmp_path / "hive-data"
    data.mkdir()
    (data / "admin-password").write_text("secret")
    other = tmp_path / "other-mind"
    other.mkdir()
    etc_dir = "/etc/omegahive-isolation-test"
    try:   # the deployed secret location (/etc/omegahive/hive.env), simulated where /etc is writable (a container)
        os.makedirs(etc_dir, exist_ok=True)
        etc_secret = os.path.join(etc_dir, "hive.env")
        with open(etc_secret, "w") as f:
            f.write("HIVE_GOOGLE_CLIENT_SECRET=synthetic")
        os.chmod(etc_secret, 0o600)
    except PermissionError:
        etc_secret = "/etc/shadow"   # unreadable for a normal user anyway; the container run covers /etc secrets
    hive_port, other_port = _tcp_listener(), _tcp_listener()
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))
    udp.settimeout(1.5)
    abstract_name = f"hive-isolation-test-{os.getpid()}"
    abs_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    abs_sock.bind("\0" + abstract_name)
    abs_sock.listen(1)
    peer = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "retained.txt").write_text("RETAINED")
    # AF_UNIX paths are capped at 107 bytes, and tmp_path grows with the user and test names (110 on a
    # self-hosted runner): every bound socket lives under a short /tmp folder outside tmp_path instead.
    short = pathlib.Path(tempfile.mkdtemp(prefix="hs-", dir="/tmp"))
    host_unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    host_unix.bind(str(short / "h.sock"))   # outside the mind's folder and every listed root
    host_unix.listen(1)
    runtime_extra = short / "rt"   # a declared read-only runtime root that happens to hold a host socket
    runtime_extra.mkdir()
    rt_unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    rt_unix.bind(str(runtime_extra / "svc.sock"))
    rt_unix.listen(1)
    rt_dgram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)   # Review r4: a datagram host socket in a runtime root
    rt_dgram.bind(str(runtime_extra / "dg.sock"))
    rt_dgram.settimeout(1.0)
    (runtime_extra / "escape").symlink_to(data)   # Kimi r7: an operator-tree symlink out to the hive's data
    etc_link, etc_saved = "/etc/mime.types", None   # Kimi r7: a listed /etc entry that is a symlink to a secret
    try:
        if os.path.lexists(etc_link):
            etc_saved = etc_link + ".hive-test-saved"
            os.rename(etc_link, etc_saved)
        os.symlink(str(data / "admin-password"), etc_link)
    except PermissionError:
        etc_link = None
    nested = runtime_extra / "nested"   # Review r5: a writable mount nested inside a read-only runtime root
    nested.mkdir()
    nested_ok = subprocess.run(["mount", "-t", "tmpfs", "tmpfs", str(nested)], capture_output=True).returncode == 0
    if nested_ok:
        (nested / "retained.txt").write_text("NESTED")
    try:
        cfg = {"own": str(mind / "w.txt"), "secret": str(data / "admin-password"), "etc_secret": etc_secret,
               "other": str(other / "x"), "hive_port": hive_port, "other_port": other_port,
               "udp_port": udp.getsockname()[1], "abstract": abstract_name, "peer_pid": peer.pid,
               "hive_pid": os.getpid(), "outside_file": str(outside / "retained.txt"),
               "outside_sock": str(short / "h.sock"), "runtime_sock": str(runtime_extra / "svc.sock"),
               "runtime_dgram": str(runtime_extra / "dg.sock"),
               "nested_file": str(nested / "retained.txt") if nested_ok else None,
               "link_secret": str(runtime_extra / "escape" / "admin-password"), "etc_link": etc_link}
        script = mind / "probe.py"
        script.write_text(PROBE)
        prof = tmp_path / "p.json"
        runtime = sorted({sys.prefix, sys.base_prefix, os.path.dirname(os.path.realpath(sys.executable)),
                          str(runtime_extra)})
        prof.write_text(json.dumps(landlock.profile(mind, runtime, [hive_port])))
        run = subprocess.run(sandbox.launcher() + [str(prof), "--", sys.executable, str(script),
                             json.dumps(cfg)], capture_output=True, text=True, timeout=60, cwd=mind)
        assert run.returncode == 0, run.stderr
        got = json.loads(run.stdout.strip().splitlines()[-1])
        try:
            leaked = udp.recvfrom(64)[0]
        except socket.timeout:
            leaked = None
        assert got["write_own"] == "ok"
        assert got["tcp_hive"] == "hive", "the hive port answers through the relay"
        assert got["socketpair"] == "ok", "anonymous socket pairs (no address) keep working"
        assert got["symlink_target_visible"] is False, "a runtime symlink must not import an outside path into the view"
        if etc_link:
            assert got["read_via_etc_symlink"] == "denied", "a listed /etc symlink must not import a secret"
        for name in ("read_secret", "read_etc_secret", "write_other", "tcp_other", "abstract_outside",
                     "kill_outside", "proc_hive_environ", "truncate_outside", "unix_outside",
                     "unix_in_runtime_root", "create_unix_socket", "dgram_pair_reconnect", "seqpacket_pair",
                     "read_via_runtime_symlink"):
            assert got[name] == "denied", (name, got)
        assert leaked is None, "UDP left the mind's namespace"
        assert got["visible_pids"] <= 5, "the mind sees only its own pid namespace"
        assert peer.poll() is None, "the outside peer was not signalled"
        assert (outside / "retained.txt").read_text() == "RETAINED", "an outside file was changed"
        try:
            got_dgram = rt_dgram.recv(16)
        except socket.timeout:
            got_dgram = None
        assert got_dgram is None, "a datagram reached the host socket in the runtime root"
        if nested_ok:
            assert got["truncate_nested_mount"] == "denied" and got["ftruncate_nested_mount"] == "denied", got
            assert (nested / "retained.txt").read_text() == "NESTED", "a nested runtime mount was changed"
    finally:
        peer.kill()
        abs_sock.close()
        host_unix.close()
        rt_unix.close()
        rt_dgram.close()
        if nested_ok:
            subprocess.run(["umount", str(nested)], capture_output=True)
        shutil.rmtree(short, ignore_errors=True)
        if etc_link:
            os.unlink(etc_link)
            if etc_saved:
                os.rename(etc_saved, etc_link)
        udp.close()
        if etc_secret.startswith(etc_dir):
            os.unlink(etc_secret)
            os.rmdir(etc_dir)


def test_profile_drops_roots_reached_through_a_symlink(tmp_path):
    """Kimi r9 follow-up 2: the launcher is safe on its own; a symlinked root (which could point anywhere) is
    dropped, never trusted as its target."""
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "secret")
    prof = landlock.profile(tmp_path / "mind", [real, tmp_path / "link"], [8700])
    assert str(real) in prof["read"]
    assert not any("secret" in p or p.endswith("/link") for p in prof["read"])


def test_view_folders_are_never_group_writable(tmp_path):
    """Kimi r9 follow-up 1: folders made for the private view are 0755 whatever the hive's umask."""
    old = os.umask(0o002)
    try:
        landlock._mkdirs(str(tmp_path / "a" / "b" / "c"))
    finally:
        os.umask(old)
    for d in ("a", "a/b", "a/b/c"):
        assert (tmp_path / d).stat().st_mode & 0o777 == 0o755, d


def test_a_bad_profile_fails_closed_with_78(tmp_path):
    """r14.2: an unreadable or malformed profile is a setup failure like any other: exit 78, nothing started."""
    marker = tmp_path / "ran"
    bad = ["{not json", "[]", '{"mind_dir": 1}', '{"mind_dir": "/tmp", "read": [], "connect_ports": null}',
           '{"mind_dir": "/tmp", "read": [1]}', '{"mind_dir": "/tmp", "read": [], "dev_rw": "x"}',
           '{"mind_dir": "/tmp", "read": [], "connect_ports": [70000]}', '{"mind_dir": "rel", "read": []}']
    for i, content in enumerate(bad):
        p = tmp_path / f"p{i}.json"
        p.write_text(content)
        assert landlock.main([str(p), "--", "/bin/touch", str(marker)]) == 78, content
    cut = tmp_path / "cut.json"
    cut.write_bytes('{"mind_dir": "/tmp", "read": ["/é'.encode()[:-1])     # truncated mid multi-byte sequence
    assert landlock.main([str(cut), "--", "/bin/touch", str(marker)]) == 78
    assert not (tmp_path / "never.json").exists()
    assert landlock.main([str(tmp_path / "never.json"), "--", "/bin/touch", str(marker)]) == 78
    assert not marker.exists()


# ---- r14.4: the launcher's validation, normalisation and every setup stage, through test-only seams --------------

def _launch_recorder(monkeypatch):
    """Injection seam: Landlock 'available' and launch() replaced by a recorder, so main()'s decisions are observable on
    any host (the shipped launcher has no fault switches)."""
    calls = []
    monkeypatch.setattr(landlock, "available", lambda: True)
    monkeypatch.setattr(landlock, "launch", lambda prof, argv: calls.append((prof, argv)) or 0)
    return calls


def test_nul_bytes_in_any_path_field_fail_closed_with_78(tmp_path, monkeypatch):
    """Kimi r14.3 finding 2: an embedded NUL used to pass validation and crash later (_host_relays ValueError, exit 1).
    Now every path field refuses it: 78, launch never reached."""
    calls = _launch_recorder(monkeypatch)
    nul = "/tmp\u0000x"
    for field in ("mind_dir", "read", "dev_rw", "dev_read", "programs"):
        prof = {"mind_dir": "/tmp", "read": [], "dev_rw": [], "dev_read": [], "connect_ports": []}
        prof[field] = nul if field == "mind_dir" else [nul]
        p = tmp_path / f"{field}.json"
        p.write_text(json.dumps(prof))
        assert "\\u0000" in p.read_text()
        assert landlock.main([str(p), "--", "/bin/true"]) == 78, field
    assert calls == []


def test_profile_lists_are_normalised_and_only_consumed_fields_reach_the_launcher(tmp_path, monkeypatch):
    """Kimi r14.3 finding 2 (device lists; `read` optional like its siblings) and the Kimi/Codex blind spot: absent
    lists become [], one device list present and one absent no longer meets list + tuple, launcher-internal keys never
    come from the file, and an explicit null is still refused."""
    calls = _launch_recorder(monkeypatch)
    p = tmp_path / "p.json"
    p.write_text(json.dumps({"mind_dir": "/tmp", "dev_read": ["/dev/urandom"], "_root": "/", "_cwd": "/"}))
    assert landlock.main([str(p), "--", "/bin/true"]) == 0
    prof = calls[-1][0]
    assert prof == {"mind_dir": "/tmp", "read": [], "dev_rw": [], "dev_read": ["/dev/urandom"], "connect_ports": [], "programs": []}
    assert landlock._devices({"dev_read": ["/dev/urandom"]}) == [("/dev/urandom", False)]
    assert landlock._devices({"dev_rw": ["/dev/null"]}) == [("/dev/null", True)]
    assert landlock._devices({"dev_read": ["/dev/random"], "dev_rw": ["/dev/null"]}) == [("/dev/random", False),
                                                                                          ("/dev/null", True)]
    p.write_text(json.dumps({"mind_dir": "/tmp", "read": [], "dev_rw": None}))
    assert landlock.main([str(p), "--", "/bin/true"]) == 78 and len(calls) == 1


def test_the_profile_wrap_emits_for_an_app_bundle_reaches_launch(tmp_path, monkeypatch):
    """Kimi r14.3 blind spot: refusal coverage alone cannot tell 'correctly refused' from 'wrongly refused a good
    profile'. The exact profile sandbox.wrap() writes for an app-bundle run (no ports) passes validation unchanged and
    reaches launch()."""
    calls = _launch_recorder(monkeypatch)
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    job = tmp_path / "job"
    job.mkdir()
    argv, path = sandbox.wrap(["/bin/sh", "x"], job, [str(tmp_path)], job / ".sandbox-profile", "app-bundle", ports=())
    written = json.loads(open(path).read())
    assert landlock.main(argv[len(sandbox.launcher()):]) == 0 and len(calls) == 1
    got, cmd = calls[0]
    assert cmd == ["/bin/sh", "x"] and written["connect_ports"] == []
    assert {k: got[k] for k in ("mind_dir", "read", "dev_rw", "dev_read", "connect_ports")} == \
        {k: written[k] for k in ("mind_dir", "read", "dev_rw", "dev_read", "connect_ports")}


STAGE_DRIVER = r"""
import os, sys, tempfile
sys.path.insert(0, sys.argv[1])
from hive.supervisor import landlock as L
made = tempfile.mkdtemp
def report(*a, **k):               # each directory the launcher makes (its mind root), so a test checks only its own;
    path = made(*a, **k)
    print("made " + path, flush=True)
    with open(sys.argv[3] + ".made", "a") as f:   # also beside the profile, with the launcher's pid, for a test whose
        f.write(f"{path} {os.getpid()}\n")         # run drops the launcher's stdout (sandbox_run on a cancel)
    return path
tempfile.mkdtemp = report
fail = sys.argv[2]
ids = iter([(7, 1)] + [(7, 2)] * 8)      # P sees the host namespace, A a fresh one (unless a stage says otherwise)
stubs = {
    "available": lambda: True,
    "apparmor_refusal": lambda: None,
    "_enter_namespaces": lambda uid, gid: None,
    "_netns_id": lambda: next(ids),
    "_interfaces": lambda: ["lo"],
    "_private_root": lambda prof: True,
    "_loopback_up": lambda: None,
    "_inner_relays": lambda prof: [],
    "restrict_files": lambda prof, abi=None: None,
    "deny_unix_sockets": lambda: None,
}
for name, f in stubs.items():
    setattr(L, name, f)
def boom(*a, **k):
    raise OSError("injected failure: " + fail)
if fail == "same_netns":
    L._netns_id = lambda: (7, 1)
elif fail == "extra_interface":
    L._interfaces = lambda: ["eth0", "lo"]
elif fail == "nul_in_relay_path":
    real = L._host_relays
    L._host_relays = lambda prof: real(dict(prof, mind_dir=prof["mind_dir"] + "\0x"))
elif fail == "refused_but_isolates":
    L.apparmor_refusal = lambda: "injected reason: the launcher runs unconfined"
elif fail == "refused_and_unshare_fails":
    L.apparmor_refusal = lambda: "injected reason: the launcher runs unconfined"
    L._enter_namespaces = boom
elif fail == "refused_and_netns_shared":
    L.apparmor_refusal = lambda: "injected reason: the launcher runs unconfined"
    L._netns_id = lambda: (7, 1)
elif fail == "first_fork":
    real_fork = os.fork
    def fork_once():
        L.os.fork = real_fork      # only P's first fork fails (EAGAIN), as under a process limit
        raise BlockingIOError(11, "Resource temporarily unavailable")
    L.os.fork = fork_once
elif fail != "none":
    setattr(L, fail, boom)
sys.exit(L.main(sys.argv[3:]))
"""

STAGES = ["_netns_id", "_host_relays", "nul_in_relay_path", "first_fork", "_enter_namespaces", "same_netns",
          "extra_interface", "_private_root", "_loopback_up", "_inner_relays", "restrict_files", "deny_unix_sockets",
          "refused_and_unshare_fails", "refused_and_netns_shared"]


@LAUNCHER_RUNS_HERE
@pytest.mark.parametrize("stage", STAGES)
def test_every_isolation_stage_failure_exits_78_and_never_starts_the_tool(tmp_path, stage):
    """Stand-in r14.3 finding 6: a test-only driver (never shipped) replaces the Linux-only steps with no-ops and makes
    ONE stage fail. Each failure - host setup, namespaces (also with an AppArmor reason to report), the fresh-network
    check (same namespace, or any interface besides loopback), private root, loopback, relays, Landlock, seccomp - exits
    78 and the tool never runs."""
    import pathlib
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    marker = tmp_path / "ran"
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    tool = ["/bin/sh", "-c", ': > "$0"', str(marker)]
    control = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "none", str(prof), "--", *tool],
                             capture_output=True, text=True, timeout=30, cwd=mind)
    assert control.returncode == 0 and marker.exists(), control.stderr   # the driver really reaches the tool
    marker.unlink()
    tmp = tmp_path / "launcher-tmp"
    tmp.mkdir()
    failed = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, stage, str(prof), "--", *tool],
                            capture_output=True, text=True, timeout=30, cwd=mind,
                            env=dict(os.environ, TMPDIR=str(tmp)))
    assert failed.returncode == 78, (stage, failed.returncode, failed.stderr)
    assert "not starting" in failed.stderr and "Traceback" not in failed.stderr, (stage, failed.stderr)
    assert not marker.exists(), stage
    assert list(tmp.iterdir()) == [], (stage, list(tmp.iterdir()))   # nothing of the launcher's under TMPDIR
    made = [line[len("made "):] for line in failed.stdout.splitlines() if line.startswith("made ")]
    assert not [path for path in made if os.path.exists(path)], (stage, made)   # the launcher's empty root was removed


def test_the_mind_root_is_made_in_tmp_whatever_tmpdir_says(tmp_path):
    """The hive gives each mind TMPDIR=<its folder>/tmp (drivers.py) and a reachability probe its job folder
    (sandbox_run.py), but the launcher's own root goes directly in /tmp: the container's R2 AppArmor profile allows the
    launcher's mounts only on /tmp/hive-mind-root-*, and on a fresh 22.04 VM it denied the mount of a root made under a
    probe's TMPDIR. The driver reports the root, then fails setup at the host relays, so P removes it again."""
    import pathlib
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    (mind / "tmp").mkdir(parents=True)
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    run = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "_host_relays", str(prof), "--", "/bin/true"],
                         capture_output=True, text=True, timeout=30, cwd=mind,
                         env=dict(os.environ, TMPDIR=str(mind / "tmp")))
    assert run.returncode == 78, (run.returncode, run.stderr)
    made = [line[len("made "):] for line in run.stdout.splitlines() if line.startswith("made ")]
    assert len(made) == 1, run.stdout
    assert os.path.dirname(made[0]) == "/tmp" and os.path.basename(made[0]).startswith("hive-mind-root-"), made
    assert not os.path.exists(made[0])
    assert list((mind / "tmp").iterdir()) == []


@LAUNCHER_RUNS_HERE
def test_the_apparmor_reason_comes_only_with_a_real_failure(tmp_path):
    """The reason apparmor_refusal gives is a prediction, so the launcher reports it only when setting up the
    namespaces actually fails: where setup works anyway the tool runs and nothing is said, and a later step's failure
    is not blamed on AppArmor."""
    import pathlib
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    marker = tmp_path / "ran"
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    tool = ["/bin/sh", "-c", ': > "$0"', str(marker)]
    works = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "refused_but_isolates", str(prof), "--", *tool],
                           capture_output=True, text=True, timeout=30, cwd=mind)
    assert works.returncode == 0 and marker.exists() and "injected reason" not in works.stderr, works.stderr
    marker.unlink()
    fails = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "refused_and_unshare_fails", str(prof), "--",
                            *tool], capture_output=True, text=True, timeout=30, cwd=mind)
    assert fails.returncode == 78 and not marker.exists(), fails.stderr
    assert "injected failure: refused_and_unshare_fails; injected reason: the launcher runs unconfined" in fails.stderr
    later = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "refused_and_netns_shared", str(prof), "--",
                            *tool], capture_output=True, text=True, timeout=30, cwd=mind)
    assert later.returncode == 78 and not marker.exists(), later.stderr
    assert "not starting" in later.stderr and "injected reason" not in later.stderr, later.stderr


@LAUNCHER_RUNS_HERE
def test_the_tool_never_sees_hive_sandbox_python(tmp_path):
    """sandbox.launcher passes HIVE_SANDBOX_PYTHON for the shebang alone: main() drops it, so the tool gets the
    environment the hive gave the launcher."""
    import pathlib
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    seen = tmp_path / "seen"
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    tool = ["/bin/sh", "-c", 'printf %s "${HIVE_SANDBOX_PYTHON-unset}" > "$0"', str(seen)]
    run = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "none", str(prof), "--", *tool],
                         capture_output=True, text=True, timeout=30, cwd=mind,
                         env=dict(os.environ, HIVE_SANDBOX_PYTHON=sys.executable))
    assert run.returncode == 0, run.stderr
    assert seen.read_text() == "unset"


def handles_sigterm(pid):
    """Whether the process has a SIGTERM handler installed (SigCgt in /proc/<pid>/status), so a test signals it only
    once its handler can run."""
    try:
        status = open(f"/proc/{pid}/status").read()
    except OSError:
        return False
    caught = int(next(line.split()[1] for line in status.splitlines() if line.startswith("SigCgt:")), 16)
    return bool(caught >> (signal.SIGTERM - 1) & 1)


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")
def test_sigterm_ends_a_running_launcher_and_removes_its_root(tmp_path):
    """#4's review: the launcher's root in /tmp outlives a SIGKILL, so the hive ends a launcher's group with SIGTERM
    first (sandbox_run._end_group). On SIGTERM the launcher kills its namespace and removes the root, exit 143. The
    stage driver runs it with every isolation step stubbed, here with a tool that sleeps until it is ended."""
    import pathlib
    import time
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    launcher = subprocess.Popen([sys.executable, "-c", STAGE_DRIVER, root, "none", str(prof), "--", "/bin/sleep", "60"],
                                stdout=subprocess.DEVNULL, cwd=mind, start_new_session=True)
    report = pathlib.Path(str(prof) + ".made")
    end = time.monotonic() + 20
    while time.monotonic() < end and not (report.exists() and handles_sigterm(launcher.pid)):
        time.sleep(0.05)
    try:
        assert report.exists() and handles_sigterm(launcher.pid), "the launcher never got to handle SIGTERM"
        made, pid = report.read_text().split()
        assert int(pid) == launcher.pid and os.path.isdir(made)
        os.killpg(launcher.pid, signal.SIGTERM)
        assert launcher.wait(20) == 143
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(launcher.pid, signal.SIGKILL)
        launcher.wait()
    left = os.path.exists(made)
    if left:
        os.rmdir(made)
    assert not left, made


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")
def test_the_tool_starts_with_the_signal_mask_the_launcher_was_started_with(tmp_path):
    """The launcher blocks SIGTERM from the start of launch() (landlock.py, "Stopping"); B restores the mask the
    launcher was started with before it forks the tool, so SIGTERM reaches a tool as it would outside."""
    assert signal.SIGTERM not in signal.pthread_sigmask(signal.SIG_BLOCK, [])   # what the launcher starts with
    root = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps({"mind_dir": str(mind), "read": [], "connect_ports": []}))
    run = subprocess.run([sys.executable, "-c", STAGE_DRIVER, root, "none", str(prof), "--",
                          "/bin/cat", "/proc/self/status"], capture_output=True, text=True, timeout=30, cwd=mind)
    assert run.returncode == 0, run.stderr
    blocked = int(next(line.split()[1] for line in run.stdout.splitlines() if line.startswith("SigBlk:")), 16)
    assert not blocked >> (signal.SIGTERM - 1) & 1, run.stdout


TERM_AT_DRIVER = r"""
import os, signal, sys, tempfile
sys.path.insert(0, sys.argv[1])
from hive.supervisor import landlock as L
made = tempfile.mkdtemp
def report(*a, **k):                   # each directory the launcher makes (its root), wherever it makes it
    path = made(*a, **k)
    with open(sys.argv[3] + ".made", "a") as f:
        f.write(path + "\n")
    return path
tempfile.mkdtemp = report
if sys.argv[2] != "none":
    real = getattr(L, sys.argv[2])
    def term_then(*a, **k):
        os.killpg(0, signal.SIGTERM)   # the launcher's whole group, the caller included
        return real(*a, **k)
    setattr(L, sys.argv[2], term_then)
sys.exit(L.main(sys.argv[3:]))
"""

# Where a SIGTERM to the launcher's group can come, in launch order: P before launch() and with its root made; A before
# and after it unshares; B before its setup and just before it forks the tool; then the running tool.
TERM_AT = ["launch", "_host_relays", "_enter_namespaces", "_verify_fresh_netns", "_loopback_up", "restrict_files",
           "tool"]
# The stages that need the namespace set up. The driver runs landlock.main from python -c, outside the launcher's
# AppArmor profile, so where the kernel restricts unprivileged user namespaces (scripts/ci/release-tests.sh sets
# apparmor_restrict_unprivileged_userns=1) that setup fails at /proc/self/setgroups and these cannot run.
AFTER_SETUP = TERM_AT[TERM_AT.index("_verify_fresh_netns"):]


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
@pytest.mark.parametrize("at", TERM_AT)
def test_a_sigterm_at_any_moment_ends_the_launchers_group_with_the_launcher_last(tmp_path, at):
    """landlock.py, "Stopping": whenever a SIGTERM reaches the group, the launcher ends its namespace, removes its root
    and exits 143 only once every other member of its group is gone, so the group is empty the moment the launcher is
    reaped, which is the only moment the hive's custody rule lets it look. The tool ignores SIGTERM and has a child, so
    only the namespace's end stops them. Before launch() the launcher has made nothing, and SIGTERM's default action
    ends it."""
    if at in AFTER_SETUP and landlock.apparmor_refusal():
        pytest.skip("an unconfined launcher gets no usable user namespace here (AppArmor's restriction is on)")
    repo = str(pathlib.Path(__file__).resolve().parents[2])
    mind = tmp_path / "mind"
    mind.mkdir()
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps(landlock.profile(mind, [], [])))
    report = pathlib.Path(str(prof) + ".made")
    tool = ["/bin/sh", "-c", 'trap "" TERM; sleep 60 & : > started; wait']
    argv = [sys.executable, "-c", TERM_AT_DRIVER, repo, "none" if at == "tool" else at, str(prof), "--", *tool]
    launcher = subprocess.Popen(argv, cwd=mind, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        if at == "tool":
            end = time.monotonic() + 30
            while not (mind / "started").exists() and time.monotonic() < end:
                time.sleep(0.05)
            assert (mind / "started").exists(), "the tool never started"
            os.killpg(launcher.pid, signal.SIGTERM)
        code = launcher.wait(30)
        with pytest.raises(ProcessLookupError):
            os.killpg(launcher.pid, 0)             # the group was empty when its leader was reaped
        err = launcher.stderr.read()
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(launcher.pid, signal.SIGKILL)   # only what a failed assertion left behind
        launcher.wait()
        launcher.stderr.close()
    made = report.read_text().split() if report.exists() else []
    left = [path for path in made if os.path.exists(path)]
    for path in left:
        os.rmdir(path)
    assert code == (-signal.SIGTERM if at == "launch" else 143), (at, code, err)
    assert "Traceback" not in err, err
    assert len(made) == (0 if at == "launch" else 1), made
    assert left == [], left


def test_programs_to_mirror_names_only_an_absolute_hive_python():
    assert landlock.programs_to_mirror({"HIVE_PYTHON": "/opt/hive/venv/bin/python"}) == ["/opt/hive/venv/bin/python"]
    assert landlock.programs_to_mirror({"HIVE_PYTHON": "python3"}) == []
    assert landlock.programs_to_mirror({}) == []


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
def test_the_channel_python_resolves_through_a_version_alias(tmp_path):
    """2026-10-08 cloud: venv/bin/python -> uv's cpython-3.12-… alias -> cpython-3.12.15-…; the read roots list only
    the real folder, so inside the view the alias was missing and the hub channel failed with ENOENT. HIVE_PYTHON is
    mirrored through every hop; a chain leading outside the allowed roots still dangles."""
    real = tmp_path / "py-3.12.15" / "bin"
    real.mkdir(parents=True)
    prog = real / "py"
    prog.write_text("#!/bin/sh\necho channel-python-ran\n")
    prog.chmod(0o755)
    (tmp_path / "py-3.12").symlink_to(tmp_path / "py-3.12.15")          # the version alias
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").symlink_to(tmp_path / "py-3.12" / "bin" / "py")   # the venv's link to the alias
    outside = tmp_path / "outside" / "bin"
    outside.mkdir(parents=True)
    (outside / "py").write_text("#!/bin/sh\necho escaped\n")
    (outside / "py").chmod(0o755)
    (venv / "escape").symlink_to(outside / "py")
    mind = tmp_path / "mind"
    mind.mkdir()
    runtime = sorted({sys.prefix, sys.base_prefix, os.path.dirname(os.path.realpath(sys.executable)),
                      str(tmp_path / "py-3.12.15"), str(tmp_path / "venv")})
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps(landlock.profile(mind, runtime, [])))
    probe = 'import os,subprocess,sys; p=os.environ["HIVE_PYTHON"]; print(subprocess.run([p],capture_output=True,text=True).stdout.strip() if os.path.exists(p) else "missing")'
    for name, expected in (("python", "channel-python-ran"), ("escape", "missing")):
        env = dict(os.environ, HIVE_PYTHON=str(venv / name))
        run = subprocess.run(sandbox.launcher() + [str(prof), "--", sys.executable, "-c", probe],
                             capture_output=True, text=True, timeout=60, cwd=mind, env=env)
        assert run.returncode == 0, run.stderr
        assert run.stdout.strip().splitlines()[-1] == expected, (name, run.stdout, run.stderr)


MODEL_PROBE = r'''
import importlib.util, json, os, pathlib
out = {}
def t(name, f):
    try:
        out[name] = f()
    except OSError as e:
        out[name] = type(e).__name__
home = pathlib.Path(os.environ["HF_HOME"])
repo = home / "hub" / "models--intfloat--e5-large-v2"
t("model", lambda: (repo / "snapshots" / (repo / "refs" / "main").read_text() / "config.json").read_text())
t("token", lambda: (home / "token").read_text())
t("token_path", lambda: pathlib.Path(os.environ["HF_TOKEN_PATH"]).read_text())
if importlib.util.find_spec("huggingface_hub"):
    # the library's own offline load: it reads its token file before resolving the cache
    from huggingface_hub import hf_hub_download
    t("library", lambda: pathlib.Path(hf_hub_download("intfloat/e5-large-v2", "config.json",
                                                       local_files_only=True)).read_text())
print(json.dumps(out))
'''


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
def test_a_mind_loads_the_cached_model_and_never_reads_a_hugging_face_token(tmp_path, monkeypatch):
    """T-66's O1 through the real boundary: with the roots runtime_roots grants and the environment
    mind_environment builds, a mind reads a model from the hub cache, by hand and through huggingface_hub when it is
    installed, while HF_HOME/token, a person's token, stays out of reach."""
    hf = tmp_path / "hf"
    repo = hf / "hub" / "models--intfloat--e5-large-v2"
    (repo / "snapshots" / "f169b11e").mkdir(parents=True)
    (repo / "snapshots" / "f169b11e" / "config.json").write_text('{"model_type": "bert"}')
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text("f169b11e")
    (hf / "token").write_text("hf_synthetic")
    monkeypatch.setenv("HF_HOME", str(hf))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    mind = tmp_path / "mind"
    mind.mkdir()
    granted = [r for r in sandbox.runtime_roots("/nonexistent", pathlib.Path(__file__).resolve().parents[2])
               if r.startswith(str(tmp_path))]
    assert granted == [str((hf / "hub").resolve())]
    library = importlib.util.find_spec("huggingface_hub")
    # In the hive the library sits in its venv, which runtime_roots grants; here it may sit in a user site instead,
    # granted the same way so the library's own load runs inside.
    site_dir = [os.path.dirname(os.path.dirname(library.origin))] if library else []
    runtime = sorted({sys.prefix, sys.base_prefix, os.path.dirname(os.path.realpath(sys.executable)), *granted,
                      *site_dir})
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps(landlock.profile(mind, runtime, [])))
    env = sandbox.mind_environment(dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1"), {})
    run = subprocess.run(sandbox.launcher() + [str(prof), "--", sys.executable, "-c", MODEL_PROBE],
                         capture_output=True, text=True, timeout=60, cwd=mind, env=env)
    assert run.returncode == 0, run.stderr
    got = json.loads(run.stdout.strip().splitlines()[-1])
    assert got["model"] == '{"model_type": "bert"}', got
    assert got["token"] in ("FileNotFoundError", "PermissionError"), got
    assert got["token_path"] == "", got
    if library:
        assert got["library"] == '{"model_type": "bert"}', got


def test_profile_programs_are_listed_and_merged_with_hive_python(tmp_path):
    prof = landlock.profile(tmp_path, [tmp_path], [], programs=["/opt/x/venv/bin/python", "/opt/x/venv/bin/python", ""])
    assert prof["programs"] == ["/opt/x/venv/bin/python"]
    assert landlock.programs_to_mirror({"HIVE_PYTHON": "/a/py"}, prof) == ["/a/py", "/opt/x/venv/bin/python"]
    assert landlock.programs_to_mirror({}, {"programs": ["/a/py", "/a/py"]}) == ["/a/py"]
    assert landlock.programs_to_mirror({}, None) == []


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
def test_a_profile_program_resolves_through_a_version_alias(tmp_path):
    """2026-10-08 cloud: an app runtime (venv python -> uv alias -> real interpreter) exec'd by limits.sh failed with
    'exec: ...: not found' because only the real folder was in the view. A program the profile names is mirrored
    through every hop; one leading outside the allowed roots still dangles."""
    real = tmp_path / "py-3.12.15" / "bin"
    real.mkdir(parents=True)
    prog = real / "py"
    prog.write_text("#!/bin/sh\necho runtime-ran\n")
    prog.chmod(0o755)
    (tmp_path / "py-3.12").symlink_to(tmp_path / "py-3.12.15")
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").symlink_to(tmp_path / "py-3.12" / "bin" / "py")
    mind = tmp_path / "mind"
    mind.mkdir()
    runtime = sorted({sys.prefix, sys.base_prefix, os.path.dirname(os.path.realpath(sys.executable)),
                      str(tmp_path / "py-3.12.15"), str(tmp_path / "venv")})
    prof = tmp_path / "p.json"
    prof.write_text(json.dumps(landlock.profile(mind, runtime, [], programs=[str(venv / "python")])))
    probe = 'import os,subprocess,sys; p=sys.argv[1]; print(subprocess.run([p],capture_output=True,text=True).stdout.strip() if os.path.exists(p) else "missing")'
    env = {k: v for k, v in os.environ.items() if k != "HIVE_PYTHON"}
    run = subprocess.run(sandbox.launcher() + [str(prof), "--", sys.executable, "-c", probe, str(venv / "python")],
                         capture_output=True, text=True, timeout=60, cwd=mind, env=env)
    assert run.returncode == 0, run.stderr
    assert run.stdout.strip().splitlines()[-1] == "runtime-ran", (run.stdout, run.stderr)


def test_profile_programs_are_strict_and_bounded(tmp_path):
    with pytest.raises(ValueError):
        landlock.profile(tmp_path, [], [], programs=["relative/python"])
    with pytest.raises(ValueError):
        landlock.profile(tmp_path, [], [], programs=[f"/opt/p{i}" for i in range(landlock.MAX_PROGRAMS + 1)])
    with pytest.raises(ValueError):
        landlock.profile(tmp_path, [], [], programs=["/" + "x" * landlock.MAX_PROGRAM_PATH])
    with pytest.raises(ValueError):
        landlock._check_profile({"mind_dir": "/tmp", "programs": [f"/opt/p{i}" for i in range(landlock.MAX_PROGRAMS + 1)]})


@pytest.mark.skipif(not LINUX, reason="needs Linux with Landlock and unprivileged user namespaces")
def test_runtime_reachable_probes_the_exact_view(tmp_path, monkeypatch):
    """Admission observes execution (Kimi runtime-mirror r1): the probe sees a venv->alias->real chain the same way a
    job does, and refuses one whose real target lies outside the read roots."""
    from hive.core import sandbox_run
    monkeypatch.setattr(sandbox_run, "_REACHABLE", {})
    real = tmp_path / "py-3.12.15" / "bin"
    real.mkdir(parents=True)
    (real / "py").write_text("#!/bin/sh\nexit 0\n")
    (real / "py").chmod(0o755)
    (tmp_path / "py-3.12").symlink_to(tmp_path / "py-3.12.15")
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python").symlink_to(tmp_path / "py-3.12" / "bin" / "py")
    good = (str(tmp_path / "py-3.12.15"), str(tmp_path / "venv"))
    assert sandbox_run._runtime_reachable("landlock", str(venv / "python"), good) is True
    monkeypatch.setattr(sandbox_run, "_REACHABLE", {})
    assert sandbox_run._runtime_reachable("landlock", str(venv / "python"), (str(tmp_path / "venv"),)) is False   # real target not readable
