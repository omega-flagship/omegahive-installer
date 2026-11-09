"""OS-level mind isolation: allowlisted environment; sandbox-exec denies the hive's files, other folders,
outside networks and other local ports, and allows the mind's own folder and the hive on loopback."""
import os
import pathlib
import re
import socket
import subprocess
import sys
import threading

import pytest

from hive.supervisor.sandbox import available, loopback_ports, mind_environment, profile, runtime_roots


def test_minds_never_inherit_secrets_or_app_settings():
    hive_env = {"PATH": "/bin", "HOME": "/h", "LANG": "C", "PETTA_PATH": "/p", "HIVE_GOOGLE_CLIENT_SECRET": "s",
                "OPENROUTER_API_KEY": "k", "ATLAS_DOT_SUBJECT_UUID": "u", "OMEGATRUTH_RESIDENTS": "{}",
                "OMEGACLAW_MEMORY_DIR": "/m", "OMEGACLAW_AUTH_SECRET": "x", "LC_ALL": "C", "AWS_SECRET_ACCESS_KEY": "a"}
    env = mind_environment(hive_env, {"HIVE_WS_TOKEN": "member"})
    assert set(env) == {"PATH", "HOME", "LANG", "PETTA_PATH", "OMEGACLAW_MEMORY_DIR", "LC_ALL", "HIVE_WS_TOKEN"}


def test_loopback_ports_follow_the_host_not_a_constant(tmp_path):
    assert loopback_ports({}) == (8700, 8724)                                           # the live layout is unchanged
    assert loopback_ports({"HIVE_PORT": "8711"}) == (8711,)                              # a disposable host gets only its own port
    assert loopback_ports({"HIVE_PORT": "8711", "HIVE_MIND_SANDBOX_PORTS": "9001, 9002"}) == (8711, 9001, 9002)
    assert loopback_ports({"HIVE_MIND_SANDBOX_PORTS": ""}) == (8700,)                    # explicitly none
    for bad in ("x", "0", "70000", "8700;(allow default)"):
        with pytest.raises(ValueError):
            loopback_ports({"HIVE_PORT": bad})
    text = profile(tmp_path, [], loopback_ports({"HIVE_PORT": "8711"}))
    assert 'localhost:8711' in text and 'localhost:8700' not in text and 'localhost:8724' not in text


PROBE = r'''
import json, socket, sys, pathlib
out = {}
def attempt(name, fn):
    try:
        fn(); out[name] = "ok"
    except Exception as exc:
        out[name] = type(exc).__name__
mind, secret, port = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
attempt("read_own", lambda: (mind / "notes.txt").read_text())
attempt("write_own", lambda: (mind / "new.txt").write_text("x"))
attempt("read_secret", lambda: secret.read_text())
attempt("write_outside", lambda: (secret.parent / "planted.txt").write_text("x"))
attempt("hive_port", lambda: socket.create_connection(("127.0.0.1", port), timeout=2).close())
attempt("other_local_port", lambda: socket.create_connection(("127.0.0.1", port + 1), timeout=2).close())
attempt("internet", lambda: socket.create_connection(("1.1.1.1", 80), timeout=2).close())
def unix():
    s = socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[4])
attempt("unix_socket", unix)
print(json.dumps(out))
'''


@pytest.mark.skipif(sys.platform != "darwin" or not available(), reason="sandbox-exec is macOS only")
def test_sandbox_allows_only_the_mind_folder_and_the_hive(tmp_path):
    mind, hive_data = tmp_path / "agents" / "a_1", tmp_path / "hive-data"
    mind.mkdir(parents=True); hive_data.mkdir()
    (mind / "notes.txt").write_text("mine")
    (hive_data / "admin-password").write_text("secret")
    servers = []
    for port_offset in (0, 1):
        srv = socket.socket(); srv.bind(("127.0.0.1", 0 if port_offset == 0 else servers[0].getsockname()[1] + 1)); srv.listen(4)
        servers.append(srv)
        threading.Thread(target=lambda s=srv: [s.accept() for _ in range(2)], daemon=True).start()
    port = servers[0].getsockname()[1]
    import tempfile
    sockdir = pathlib.Path(tempfile.mkdtemp(prefix="hs", dir="/tmp"))
    dock = socket.socket(socket.AF_UNIX); dock.bind(str(sockdir / "d.sock")); dock.listen(1)
    roots = runtime_roots(os.environ.get("PETTA_PATH", "/nonexistent"), pathlib.Path(__file__).resolve().parents[2])
    prof = tmp_path / "mind.sb"
    prof.write_text(profile(mind, roots + [sys.prefix, sys.base_prefix], ports=(port,)))
    script = tmp_path / "probe.py"
    script.write_text(PROBE)
    # the probe script itself lives outside the mind folder: the profile must allow reading it to run it at all
    prof.write_text(profile(mind, roots + [sys.prefix, sys.base_prefix, str(script)], ports=(port,)))
    run = subprocess.run(["sandbox-exec", "-f", str(prof), sys.executable, str(script), str(mind), str(hive_data / "admin-password"), str(port), str(sockdir / "d.sock")],
                         capture_output=True, text=True, timeout=60)
    import json
    out = json.loads(run.stdout.strip().splitlines()[-1])
    assert out["read_own"] == "ok" and out["write_own"] == "ok" and out["hive_port"] == "ok", (out, run.stderr[-500:])
    for denied in ("read_secret", "write_outside", "other_local_port", "internet", "unix_socket"):
        assert out[denied] != "ok", (denied, out)


def test_roots_never_open_the_whole_disk_or_home():
    from hive.supervisor.sandbox import safe_roots
    home = pathlib.Path.home()
    assert safe_roots(["/", str(home), str(home.parent), "/usr/bin/..", str(home / "x")]) == ["/usr", str((home / "x").resolve())]
    assert "/" not in runtime_roots("/nonexistent", pathlib.Path(__file__).resolve().parents[2])


def test_requested_isolation_fails_closed_when_unavailable(tmp_path, monkeypatch):
    from hive.supervisor import drivers

    class WS:
        def path(self, agent_id):
            p = tmp_path / agent_id; p.mkdir(exist_ok=True); return p
        def command(self, agent, petta):
            return ["true"]
    d = drivers.LocalDriver(WS(), "/nonexistent")
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setattr(drivers, "sandbox_available", lambda: False)
    with pytest.raises(RuntimeError, match="refusing to start"):
        d.start({"id": "a_1", "kind": "omega"}, {})
    assert "a_1" not in d.procs


def test_macos_profile_never_opens_the_terminal(tmp_path):
    """Kimi r9 parity finding: like Linux, a mind may not write the hive's controlling terminal (TIOCSTI)."""
    from hive.supervisor import sandbox
    text = sandbox.profile(tmp_path / "mind", [], [8700])
    assert "/dev/tty" not in text


def test_macos_mind_and_tool_profiles_keep_mach_lookup_denied(tmp_path):
    from hive.core.sandbox_run import sandbox_policy

    for policy in (profile(tmp_path, [], ports=()), sandbox_policy(tmp_path, [])):
        lines = policy.splitlines()
        assert "(deny default)" in lines
        assert not any(re.match(r"\s*\(\s*allow\s+(?:mach|default\b)", line) for line in lines)


def test_macos_empty_ports_never_emit_an_outbound_rule(tmp_path):
    from hive.core.sandbox_run import sandbox_policy

    assert not any(line.startswith("(allow network-outbound")
                   for line in profile(tmp_path, [], ports=()).splitlines())
    tool_lines = sandbox_policy(tmp_path, [], child_processes=False).splitlines()
    assert not any(line.startswith("(allow network-") for line in tool_lines)
    assert "(allow process-fork)" not in tool_lines


def _run_macos_probe(tmp_path, command):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "TMPDIR": str(tmp_path)}
    result = subprocess.run(command, cwd=tmp_path, env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


SECURITY_SERVER_LOOKUP = r'''
import ctypes as c

lib = c.CDLL(None)
lookup = lib.bootstrap_look_up
lookup.argtypes = (c.c_uint, c.c_char_p, c.POINTER(c.c_uint))
lookup.restype = c.c_int
bootstrap_port = c.c_uint.in_dll(lib, "bootstrap_port").value
service_port = c.c_uint()
status = lookup(bootstrap_port, b"com.apple.SecurityServer", c.byref(service_port))
if status == 0:
    deallocate = lib.mach_port_deallocate
    deallocate.argtypes = (c.c_uint, c.c_uint)
    deallocate.restype = c.c_int
    task = c.c_uint.in_dll(lib, "mach_task_self_").value
    assert deallocate(task, service_port.value) == 0
print(status)
'''


@pytest.mark.skipif(sys.platform != "darwin" or not available(), reason="sandbox-exec is macOS only")
def test_macos_mind_and_tool_cannot_lookup_security_server(tmp_path):
    from hive.core.sandbox_run import sandbox_policy

    reads = [sys.prefix, sys.base_prefix]
    command = [sys.executable, "-I", "-B", "-S", "-c", SECURITY_SERVER_LOOKUP]

    # The positive control proves the service is discoverable. No process sends a message to it.
    assert _run_macos_probe(tmp_path, command) == "0", "SecurityServer unavailable in the test's launch namespace"
    for policy in (profile(tmp_path, reads, ports=()), sandbox_policy(tmp_path, reads)):
        status = _run_macos_probe(tmp_path, ["/usr/bin/sandbox-exec", "-p", policy, *command])
        assert status == "1100"  # BOOTSTRAP_NOT_PRIVILEGED


LOOPBACK_CONNECT = r'''
import errno, socket, sys

try:
    with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=2):
        print("connected")
except OSError as exc:
    if exc.errno not in (errno.EPERM, errno.EACCES):
        raise
    print("denied")
'''


@pytest.mark.skipif(sys.platform != "darwin" or not available(), reason="sandbox-exec is macOS only")
def test_macos_empty_mind_ports_and_tool_profile_deny_outbound_loopback(tmp_path):
    from hive.core.sandbox_run import sandbox_policy

    reads = [sys.prefix, sys.base_prefix]
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(2)
        port = listener.getsockname()[1]
        command = [sys.executable, "-I", "-B", "-S", "-c", LOOPBACK_CONNECT, str(port)]

        assert _run_macos_probe(tmp_path, command) == "connected"
        listener.accept()[0].close()
        allowed = profile(tmp_path, reads, ports=(port,))
        assert _run_macos_probe(tmp_path, ["/usr/bin/sandbox-exec", "-p", allowed, *command]) == "connected"
        listener.accept()[0].close()

        empty = profile(tmp_path, reads, ports=())
        tool = sandbox_policy(tmp_path, reads, child_processes=False)
        for policy in (empty, tool):
            assert _run_macos_probe(tmp_path, ["/usr/bin/sandbox-exec", "-p", policy, *command]) == "denied"
