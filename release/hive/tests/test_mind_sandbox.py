"""OS-level mind isolation: allowlisted environment; sandbox-exec denies the hive's files, other folders,
outside networks and other local ports, and allows the mind's own folder and the hive on loopback."""
import os
import pathlib
import socket
import subprocess
import sys
import threading
import shutil
import tempfile
import unittest
from unittest.mock import patch

import pytest

from hive.supervisor.sandbox import available, loopback_ports, mind_environment, profile, runtime_roots, safe_roots


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


class RuntimeRootsSwiplHomeTests(unittest.TestCase):
    """Pure path grants, using real runtime_roots/safe_roots and never running the SWI fixture."""

    def _roots(self, executable, home):
        with patch.dict(os.environ, {"HOME": str(home), "VIRTUAL_ENV": str(home / "unused-venv")}, clear=True), \
             patch.object(shutil, "which", return_value=str(executable)) as lookup, \
             patch.object(subprocess, "run", side_effect=AssertionError("runtime_roots must not execute SWI-Prolog")), \
             patch.object(subprocess, "Popen", side_effect=AssertionError("runtime_roots must not execute SWI-Prolog")):
            roots = runtime_roots(home / "petta", home / "core")
            lookup.assert_called_once_with("swipl")
            return roots

    def _deep_layout(self, architecture):
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            prefix = root / "runtime"
            swipl_home = prefix / "lib" / "swipl"
            binary = swipl_home / "bin" / architecture / "swipl"
            binary.parent.mkdir(parents=True)
            binary.write_text("synthetic SWI fixture; never executed")
            launcher = prefix / "bin" / "swipl"
            launcher.parent.mkdir()
            launcher.symlink_to("../lib/swipl/bin/" + architecture + "/swipl")
            roots = self._roots(launcher, root / "owner")
            self.assertIn(str(swipl_home.resolve()), roots)
            self.assertNotIn(str(binary.parent.parent.resolve()), roots)
            self.assertEqual(launcher.resolve(), binary.resolve())

    def test_x86_64_deep_linux_binary_grants_complete_swipl_home(self):
        self._deep_layout("x86_64-linux")

    def test_aarch64_deep_linux_binary_grants_complete_swipl_home(self):
        self._deep_layout("aarch64-linux")

    def test_legacy_bin_swipl_root_is_unchanged(self):
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            prefix = root / "legacy-swipl"
            binary = prefix / "bin" / "swipl"
            binary.parent.mkdir(parents=True)
            binary.write_text("synthetic regular SWI fixture; never executed")
            roots = self._roots(binary, root / "owner")
            self.assertIn(str(prefix.resolve()), roots)
            self.assertNotIn(str(prefix.parent.resolve()), roots)

    def test_other_deep_home_name_keeps_parent_parent_fallback(self):
        with tempfile.TemporaryDirectory() as raw:
            root = pathlib.Path(raw)
            other_home = root / "lib" / "other-prolog"
            binary = other_home / "bin" / "aarch64-linux" / "swipl"
            binary.parent.mkdir(parents=True)
            binary.write_text("synthetic nonmatching layout; never executed")
            roots = self._roots(binary, root / "owner")
            self.assertIn(str(binary.parent.parent.resolve()), roots)
            self.assertNotIn(str(other_home.resolve()), roots)

    def test_safe_roots_still_refuses_home_and_ancestors(self):
        with tempfile.TemporaryDirectory() as raw:
            home = pathlib.Path(raw) / "owner"
            allowed = home / "allowed"
            with patch.dict(os.environ, {"HOME": str(home)}, clear=True):
                self.assertEqual(safe_roots(["/", home, home.parent, allowed]), [str(allowed.resolve())])

    def test_runtime_roots_filters_swipl_home_equal_to_owner_home(self):
        with tempfile.TemporaryDirectory() as raw:
            swipl_home = pathlib.Path(raw) / "swipl"
            binary = swipl_home / "bin" / "aarch64-linux" / "swipl"
            binary.parent.mkdir(parents=True)
            binary.write_text("synthetic unsafe home grant; never executed")
            self.assertNotIn(str(swipl_home.resolve()), self._roots(binary, swipl_home))

    def test_runtime_roots_filters_swipl_home_ancestor_of_owner_home(self):
        with tempfile.TemporaryDirectory() as raw:
            swipl_home = pathlib.Path(raw) / "swipl"
            binary = swipl_home / "bin" / "x86_64-linux" / "swipl"
            binary.parent.mkdir(parents=True)
            binary.write_text("synthetic unsafe ancestor grant; never executed")
            home = swipl_home / "users" / "owner"
            self.assertNotIn(str(swipl_home.resolve()), self._roots(binary, home))

    def test_runtime_roots_filters_filesystem_root(self):
        with tempfile.TemporaryDirectory() as raw:
            roots = self._roots(pathlib.Path("/swipl"), pathlib.Path(raw) / "owner")
            self.assertNotIn("/", roots)
