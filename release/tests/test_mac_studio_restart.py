#!/usr/bin/env python3
"""Purpose: verify the installed Mac restart gate and the delivered Studio restart proof without a live hive."""
import ast
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import shutil
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / "install/macos/safe-restart.py"
GUARD = ROOT / "hive/core/studio_sessions.py"


# Load only the real restart guard's definitions; other Studio imports need a whole hive.
def guard():
    tree = ast.parse(GUARD.read_text())
    names = {"host_platform", "safe_restart_path", "mac_restart_override_adopted"}
    constants = {"MAC_SAFE_RESTART_OVERRIDE_HASHES", "SAFE_RESTART_PATH"}
    body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names
            or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in n.targets)]
    scope = {"hashlib": hashlib}
    exec(compile(ast.Module(body=body, type_ignores=[]), str(GUARD), "exec"), scope)
    return scope


class MacStudioRestartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sr-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "hive with spaces"
        (self.home / "app/install/macos").mkdir(parents=True)
        (self.home / "data").mkdir()
        (self.home / "run").mkdir()
        (self.home / "installed").write_text("installed\n")
        self.commit = "a" * 40
        (self.home / "app/RELEASE_COMMIT").write_text(self.commit + "\n")
        (self.home / "app/install/macos/omegahive.sh").write_text("#!/bin/bash\nexit 0\n")
        self.job = {"Label": "org.omegahive.hive.12345", "ProgramArguments": [
            "/bin/bash", str(self.home / "app/install/macos/omegahive.sh"), "run"],
            "EnvironmentVariables": {"OMEGAHIVE_HOME": str(self.home)}}
        (self.home / "run/hive.plist").write_bytes(plistlib.dumps(self.job))
        self.db = sqlite3.connect(self.home / "data/hive.db")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE agents (id TEXT, status TEXT, desired TEXT, deleted INTEGER, kind TEXT)")
        spec = importlib.util.spec_from_file_location("standalone_safe_restart", ENTRY)
        self.entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.entry)
        self.launcher_patch = patch.object(self.entry.subprocess, "run")
        self.launched = self.launcher_patch.start()
        self.addCleanup(self.launcher_patch.stop)

    def mind(self, status="asleep", desired="asleep", deleted=0, kind="omega"):
        self.db.execute("INSERT INTO agents VALUES ('maker', ?, ?, ?, ?)", (status, desired, deleted, kind))
        self.db.commit()

    def test_only_sleep_or_matching_commit_allows_the_real_launcher_actions(self):
        for status, desired, approval, allowed in (
            ("asleep", "asleep", "", True), ("awake", "awake", "", False),
            ("stopping", "asleep", "", False), ("asleep", "awake", "", False),
            ("awake", "awake", "b" * 40, False), ("awake", "awake", self.commit, True),
            ("asleep", "asleep", "b" * 40, False), (None, "asleep", "", False)):
            with self.subTest(status=status, desired=desired, approval=approval):
                self.db.execute("DELETE FROM agents")
                self.mind(status, desired)
                self.launched.reset_mock()
                if allowed:
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.entry.restart(self.home, approval)
                    self.launched.assert_called_once_with(
                        ["/bin/launchctl", "kickstart", "-k", "-p", f"gui/{os.getuid()}/org.omegahive.hive.12345"], check=True)
                else:
                    with self.assertRaises(self.entry.RestartRefused):
                        self.entry.restart(self.home, approval)
                    self.launched.assert_not_called()

    def test_deleted_and_external_module_minds_do_not_block_the_host(self):
        for deleted, kind in ((1, "omega"), (0, "module")):
            with self.subTest(deleted=deleted, kind=kind):
                self.db.execute("DELETE FROM agents")
                self.mind("awake", "awake", deleted, kind)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.entry.restart(self.home)

    def test_unknown_release_missing_database_and_in_progress_update_refuse(self):
        for invalid in ("short", "", "A" * 40):
            with self.subTest(commit=invalid):
                (self.home / "app/RELEASE_COMMIT").write_text(invalid)
                with self.assertRaises(self.entry.RestartRefused):
                    self.entry.restart(self.home)
        (self.home / "app/RELEASE_COMMIT").write_text(self.commit)
        with open(self.home / "run/update.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(self.entry.RestartRefused):
                self.entry.restart(self.home, self.commit)
        (self.home / "data/hive.db").unlink()
        with self.assertRaises(sqlite3.Error):
            self.entry.restart(self.home, self.commit)
        self.launched.assert_not_called()

    def test_a_failed_restart_is_not_retried_and_releases_the_update_lock(self):
        self.mind()
        self.launched.side_effect = subprocess.CalledProcessError(7, ["/bin/launchctl", "kickstart"])
        with self.assertRaises(subprocess.CalledProcessError):
            self.entry.restart(self.home)
        self.assertEqual(self.launched.call_count, 1)
        with open(self.home / "run/update.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_a_release_changed_before_lock_acquisition_requires_its_new_approval(self):
        self.mind("awake", "awake")
        flock = self.entry.fcntl.flock
        def finish_update_at_acquisition(fd, operation):
            flock(fd, operation)
            (self.home / "app/RELEASE_COMMIT").write_text("b" * 40)
        with patch.object(self.entry.fcntl, "flock", side_effect=finish_update_at_acquisition):
            with self.assertRaises(self.entry.RestartRefused):
                self.entry.restart(self.home, self.commit)
        self.launched.assert_not_called()
        with contextlib.redirect_stdout(io.StringIO()):
            self.entry.restart(self.home, "b" * 40)
        self.launched.assert_called_once()

    def test_a_concurrent_wake_cannot_commit_before_the_replacement_boundary(self):
        self.mind()
        for journal in ("delete", "wal"):
            with self.subTest(journal=journal):
                self.db.execute("PRAGMA journal_mode=" + journal)
                def concurrent_wake(*args, **kwargs):
                    with contextlib.closing(sqlite3.connect(self.home / "data/hive.db", timeout=0)) as other:
                        with self.assertRaises(sqlite3.OperationalError):
                            other.execute("UPDATE agents SET status='starting', desired='awake'")
                self.launched.side_effect = concurrent_wake
                self.entry.restart(self.home)
                self.assertEqual(self.db.execute("SELECT desired FROM agents").fetchone()[0], "asleep")
                self.db.execute("UPDATE agents SET status='asleep', desired='asleep'")
                self.db.commit()
        with contextlib.closing(sqlite3.connect(self.home / "data/hive.db", timeout=0)) as other:
            other.execute("BEGIN IMMEDIATE")
            self.launched.reset_mock()
            with self.assertRaises(sqlite3.OperationalError):
                self.entry.restart(self.home, self.commit)
            self.launched.assert_not_called()

    def test_missing_ambiguous_and_foreign_jobs_refuse(self):
        (self.home / "run/hive.plist").unlink()
        with self.assertRaises(self.entry.RestartRefused):
            self.entry.restart(self.home)
        self.job["EnvironmentVariables"]["OMEGAHIVE_HOME"] = str(self.home.parent / "other")
        (self.home / "run/hive.plist").write_bytes(plistlib.dumps(self.job))
        with self.assertRaises(self.entry.RestartRefused):
            self.entry.restart(self.home)
        self.job["EnvironmentVariables"]["OMEGAHIVE_HOME"] = str(self.home)
        for name in ("hive.plist", "other.plist"):
            (self.home / "run" / name).write_bytes(plistlib.dumps(self.job))
        with self.assertRaises(self.entry.RestartRefused):
            self.entry.restart(self.home)
        self.launched.assert_not_called()

    def test_launcher_selects_its_mac_artifact_and_preserves_an_owner_path(self):
        self.launcher_patch.stop()
        macos = self.home / 'app/install/macos'
        (macos / 'pins.sh').write_text('OMEGA_TOOLS_DIGEST=t\nOMEGA_TOOLS_LOCK_SHA256=l\n'
            'OMEGADESIGN_DIGEST=s\nOMEGADESIGN_LOCK_SHA256=k\n')
        (self.home / 'venv/bin').mkdir(parents=True)
        (self.home / 'venv/bin/python').symlink_to(sys.executable)
        source = (ROOT / 'install/macos/omegahive.sh').read_text()
        body = source.split('app_settings() {\n', 1)[1].split('\n}\n', 1)[0]
        shell = 'OH=$1; TOOLCHAIN=$OH/toolchain/envs/hive; OS=$2\napp_settings() {\n' + body + '\n}\napp_settings\n'
        for host, owner in (('Darwin', ''), ('Darwin', '/owner/reviewed.py'), ('Linux', ''), ('Linux', '/owner/reviewed.py')):
            with self.subTest(host=host, owner=owner):
                env = {k: v for k, v in os.environ.items() if k != 'HIVE_SAFE_RESTART_PATH'}
                if owner: env['HIVE_SAFE_RESTART_PATH'] = owner
                done = subprocess.run(['/bin/bash', '-c', shell, 'settings', str(self.home), host],
                    env=env, text=True, capture_output=True, check=True)
                exports = dict(shlex.split(line)[1].split('=', 1) for line in done.stdout.splitlines())
                if host == 'Darwin' and not owner:
                    self.assertEqual(exports['HIVE_SAFE_RESTART_PATH'], str(macos / 'safe-restart.py'))
                else:
                    self.assertNotIn('HIVE_SAFE_RESTART_PATH', exports)

    def test_shipped_entrypoint_passes_the_guard_and_missing_or_changed_bytes_refuse(self):
        real = self.home / "app/install/macos/safe-restart.py"
        shutil.copy(ENTRY, real)
        scope = guard()
        scope["host_platform"] = lambda: "darwin"
        with patch.dict(os.environ, {"HIVE_SAFE_RESTART_PATH": str(real)}):
            self.assertTrue(scope["mac_restart_override_adopted"]())
            real.write_bytes(real.read_bytes() + b"\n# changed\n")
            self.assertFalse(scope["mac_restart_override_adopted"]())
            real.unlink()
            self.assertFalse(scope["mac_restart_override_adopted"]())
        scope["host_platform"] = lambda: "linux"
        scope["safe_restart_path"] = lambda: self.fail("Linux/WSL must not request a Mac host script")
        self.assertTrue(scope["mac_restart_override_adopted"]())


if __name__ == "__main__":
    unittest.main()
