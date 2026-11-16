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
    assert set(env) == {"PATH", "HOME", "LANG", "PETTA_PATH", "OMEGACLAW_MEMORY_DIR", "LC_ALL", "HIVE_WS_TOKEN",
                        "HF_TOKEN_PATH"}


def test_minds_get_the_model_cache_and_offline_switches_but_never_a_hugging_face_token():
    """T-66's O1: a sandboxed mind loads the embedding model at memory start, so it needs where the model is cached
    and the offline switches; a token, in the environment or in HF_HOME/token, never reaches it."""
    hive_env = {"PATH": "/bin", "HF_HOME": "/opt/omegahive/hf", "HF_HUB_CACHE": "/opt/omegahive/hf/hub",
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_TOKEN": "hf_synthetic",
                "HUGGING_FACE_HUB_TOKEN": "hf_synthetic", "HF_TOKEN_PATH": "/opt/omegahive/hf/token"}
    env = mind_environment(hive_env, {})
    assert {k: env[k] for k in ("HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")} == \
        {"HF_HOME": "/opt/omegahive/hf", "HF_HUB_CACHE": "/opt/omegahive/hf/hub", "HF_HUB_OFFLINE": "1",
         "TRANSFORMERS_OFFLINE": "1"}
    assert "HF_TOKEN" not in env and "HUGGING_FACE_HUB_TOKEN" not in env
    assert env["HF_TOKEN_PATH"] == os.devnull
    # a mind's own variables go on top of the hive's, but never over the token path
    assert mind_environment(hive_env, {"HF_TOKEN_PATH": "/opt/omegahive/hf/token"})["HF_TOKEN_PATH"] == os.devnull
    # nor carry any variable huggingface_hub would take a token from before the token file
    overlay = {"HF_TOKEN": "hf_synthetic", "HUGGING_FACE_HUB_TOKEN": "hf_synthetic",
               "HF_OIDC_RESOURCE": "model:intfloat/e5-large-v2", "HF_OIDC_ID_TOKEN": "synthetic", "TMPDIR": "/t"}
    env = mind_environment(hive_env, overlay)
    assert not {"HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_OIDC_RESOURCE", "HF_OIDC_ID_TOKEN"} & env.keys()
    assert env["TMPDIR"] == "/t"


def test_runtime_roots_grant_the_hub_cache_and_never_hf_home(tmp_path, monkeypatch):
    """HF_HOME also holds a person's token, so only its hub folder, or HF_HUB_CACHE when the deployment sets one,
    becomes readable; with neither set nothing of Hugging Face's is granted."""
    core = pathlib.Path(__file__).resolve().parents[2]
    hf = tmp_path / "hf"
    (hf / "hub").mkdir(parents=True)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.setenv("HF_HOME", str(hf))
    roots = runtime_roots("/nonexistent", core)
    assert str((hf / "hub").resolve()) in roots and str(hf.resolve()) not in roots
    elsewhere = tmp_path / "cache"
    elsewhere.mkdir()
    monkeypatch.setenv("HF_HUB_CACHE", str(elsewhere))
    roots = runtime_roots("/nonexistent", core)
    assert str(elsewhere.resolve()) in roots and str((hf / "hub").resolve()) not in roots
    monkeypatch.delenv("HF_HUB_CACHE")
    monkeypatch.delenv("HF_HOME")
    assert not any(r.startswith(str(tmp_path)) for r in runtime_roots("/nonexistent", core))


def test_a_hub_cache_that_holds_the_token_is_never_granted(tmp_path):
    """An HF_HUB_CACHE set to HF_HOME, or to an ancestor of it such as ~/.cache, would bring the token file into the
    mind's view; such a cache is not granted at all, and neither is one holding a token placed by HF_TOKEN_PATH."""
    from hive.supervisor.sandbox import hf_hub_cache
    hf = tmp_path / "cache" / "huggingface"
    (hf / "hub").mkdir(parents=True)
    assert hf_hub_cache({"HF_HOME": str(hf)}) == str((hf / "hub").resolve())
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(hf)}) is None
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(tmp_path / "cache")}) is None
    assert hf_hub_cache({"XDG_CACHE_HOME": str(tmp_path / "cache"), "HF_HUB_CACHE": str(tmp_path / "cache")}) is None
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_TOKEN_PATH": str(hf / "hub" / "token")}) is None
    assert hf_hub_cache({}) is None


def test_inside_hf_home_only_its_hub_folder_is_granted_and_a_file_never_is(tmp_path):
    """physixCN's point on #5: a cache pointed at HF_HOME/stored_tokens, or anywhere in HF_HOME other than its hub
    folder, would let a mind read a person's tokens; inside HF_HOME only hub/ is granted, and a file is never a
    cache."""
    from hive.supervisor.sandbox import hf_hub_cache
    hf = tmp_path / "hf"
    model = hf / "hub" / "models--intfloat--e5-large-v2"
    model.mkdir(parents=True)
    (hf / "assets").mkdir()
    (hf / "stored_tokens").write_text("[token]\nhf_token = hf_synthetic\n")
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(hf / "stored_tokens")}) is None
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(hf / "assets")}) is None
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(model)}) == str(model.resolve())
    outside = tmp_path / "not-a-folder"
    outside.write_text("x")
    assert hf_hub_cache({"HF_HOME": str(hf), "HF_HUB_CACHE": str(outside)}) is None
    assert hf_hub_cache({"HF_HOME": str(tmp_path / "missing")}) is None   # no hub folder yet: nothing to grant


def test_paths_are_read_as_huggingface_hub_reads_them(tmp_path):
    """huggingface_hub expands ~ and $VAR in HF_HOME, HF_HUB_CACHE and HF_TOKEN_PATH, so the check does too: a token
    placed with ~ or $VAR inside the cache keeps that cache out of reach, and a cache named with them is granted
    where it really is."""
    from hive.supervisor.sandbox import hf_hub_cache, hf_path
    (tmp_path / "hf" / "hub").mkdir(parents=True)
    (tmp_path / "models").mkdir()
    env = {"HOME": str(tmp_path), "ROOT": str(tmp_path)}
    assert hf_path("~/hf", env) == f"{tmp_path}/hf"
    assert hf_path("${ROOT}/x/$ROOT", env) == f"{tmp_path}/x/{tmp_path}"
    assert hf_path("$UNSET/x", env) == "$UNSET/x"   # an unknown variable stays, as in os.path.expandvars
    assert hf_hub_cache({**env, "HF_HUB_CACHE": "~/models", "HF_TOKEN_PATH": "~/models/token"}) is None
    assert hf_hub_cache({**env, "HF_HUB_CACHE": "$ROOT/models", "HF_TOKEN_PATH": "${ROOT}/models/token"}) is None
    assert hf_hub_cache({**env, "HF_HUB_CACHE": "~/models"}) == str((tmp_path / "models").resolve())
    assert hf_hub_cache({**env, "HF_HOME": "$ROOT/hf"}) == str((tmp_path / "hf" / "hub").resolve())
    assert hf_hub_cache({**env, "HF_HOME": "~/hf", "HF_HUB_CACHE": "~/hf"}) is None


def test_hf_path_is_os_path_expandvars_of_expanduser():
    """hf_path() is huggingface_hub's own expansion with env as the environment, edge cases included: an empty HOME,
    no HOME (the password database), ~user, ${{x}, unknown and malformed variables."""
    from unittest import mock
    from hive.supervisor.sandbox import hf_path
    values = ["~", "~/", "~/x", "~//x", "~root/x", "~nobody-here/x", "x~/y", "/a/~/x", "", "$A/x", "${A}/x",
              "${{A}/x", "${A}}/x", "$A$B", "a$Ab", "${}/x", "$/x", "${A", "$A_1", "$1", "$UNSET/x", "~/$A", "$T/x"]
    envs = [{"HOME": "/h", "A": "/a", "B": "b", "{A": "/brace", "T": "~/t"}, {"HOME": "/h/", "A": "/a"},
            {"HOME": "/", "A": "/a"}, {"HOME": "", "A": "/a"}, {"A": "/a"}]
    for env in envs:
        for value in values:
            with mock.patch.dict(os.environ, env, clear=True):
                expected = os.path.expandvars(os.path.expanduser(value))
            assert hf_path(value, env) == expected, (env, value)


def test_a_relative_hub_cache_is_never_granted(tmp_path, monkeypatch):
    """A mind runs in its own folder, so a relative HF_HUB_CACHE names a different folder for the mind than for the
    hive: granting the hive's would open one of its folders to minds and still not the cache the mind reads."""
    from hive.supervisor.sandbox import hf_hub_cache
    (tmp_path / "hub").mkdir()
    monkeypatch.chdir(tmp_path)
    assert hf_hub_cache({"HF_HUB_CACHE": "hub"}) is None
    assert hf_hub_cache({"HF_HUB_CACHE": "."}) is None
    assert hf_hub_cache({"HF_HOME": "."}) is None
    assert hf_hub_cache({"HF_HUB_CACHE": str(tmp_path / "hub")}) == str((tmp_path / "hub").resolve())


def test_the_deployed_layout_grants_the_model_volume_hub_and_no_token(tmp_path):
    """omegahive-deploy's image sets HF_HOME (the model volume, mounted read-only) and the offline switches, and no
    HF_HUB_CACHE; model-fill.sh puts the model under HF_HOME/hub and its marker in HF_HOME. A mind reads hub/ alone,
    gets HF_HOME and the switches to find the model offline, and no token source."""
    from hive.supervisor.sandbox import hf_hub_cache
    hf = tmp_path / "opt" / "omegahive" / "hf"
    (hf / "hub" / "models--intfloat--e5-large-v2" / "snapshots").mkdir(parents=True)
    (hf / ".omegahive-model").write_text("intfloat/e5-large-v2\n")
    hive_env = {"PATH": "/usr/bin", "HOME": str(tmp_path / "home"), "HF_HOME": str(hf), "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1", "HIVE_MIND_SANDBOX": "1"}
    assert hf_hub_cache(hive_env) == str((hf / "hub").resolve())
    env = mind_environment(hive_env, {"HIVE_WS_TOKEN": "member"})
    assert {k: env.get(k) for k in ("HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE",
                                    "HF_TOKEN_PATH")} == \
        {"HF_HOME": str(hf), "HF_HUB_CACHE": None, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
         "HF_TOKEN_PATH": os.devnull}
    assert not {"HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_OIDC_RESOURCE", "HF_OIDC_ID_TOKEN"} & env.keys()


def test_huggingface_hub_in_a_mind_reads_the_granted_cache_and_no_token_file(tmp_path):
    """The grant is where huggingface_hub itself, started with a mind's environment, looks for the model, and its
    token file is /dev/null, for the deployed layout and for caches named with ~ and $VAR."""
    pytest.importorskip("huggingface_hub")
    from hive.supervisor.sandbox import hf_hub_cache
    hf = tmp_path / "hf"
    (hf / "hub").mkdir(parents=True)
    (tmp_path / "models").mkdir()
    base = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "ROOT": str(tmp_path), "HF_HUB_OFFLINE": "1"}
    probe = "from huggingface_hub import constants as c; print(c.HF_HUB_CACHE); print(c.HF_TOKEN_PATH)"
    for hf_env in ({"HF_HOME": str(hf)}, {"HF_HOME": "~/hf"}, {"HF_HOME": "$ROOT/hf"},
                   {"HF_HOME": str(hf), "HF_HUB_CACHE": "~/models"}):
        hive_env = {**base, **hf_env}
        env = mind_environment(hive_env, {"ROOT": str(tmp_path)})
        out = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, check=True)
        cache, token = out.stdout.splitlines()
        assert str(pathlib.Path(cache).resolve()) == hf_hub_cache(hive_env), hf_env
        assert token == os.devnull


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
