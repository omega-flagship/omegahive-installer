"""Portable source controls only; these never start Code, systemd, a socket, or a provider."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import lifecycle_worker as worker
import runtime_preflight
import supervise


ARCHIVES = {}


def unfreeze(root):
    for path in Path(root).rglob("*"):
        if path.is_dir():
            path.chmod(0o700)


class PackageControls(unittest.TestCase):
    def test_exact_reviewed_packages_stage_with_expected_digests(self):
        if not ARCHIVES:
            self.skipTest("supply exact archive inputs")
        with tempfile.TemporaryDirectory() as tmp:
            try:
                for name, archive in ARCHIVES.items():
                    root = Path(tmp) / name
                    root.mkdir()
                    release = worker.stage_archive(archive, root, worker.PINS[name])
                    self.assertEqual(worker.module_digest(release / "omegacode"),
                                     (worker.PINS[name]["modules"], worker.PINS[name]["count"]))
                    self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o555)
                    self.assertEqual(stat.S_IMODE((release / "omegacode/__main__.py").stat().st_mode), 0o444)
            finally:
                unfreeze(tmp)

    def test_wrong_archive_refuses_before_creating_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "wrong.zip"
            archive.write_bytes(b"wrong package")
            output = root / "releases"
            output.mkdir()
            with self.assertRaisesRegex(worker.Refusal, "archive_digest_mismatch"):
                worker.stage_archive(archive, output, worker.PINS["r14"])
            self.assertEqual(list(output.iterdir()), [])

    def test_admitted_hash_does_not_permit_path_escape_or_duplicate_or_symlink(self):
        for variant in ("escape", "duplicate", "symlink"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive = root / "synthetic.zip"
                with zipfile.ZipFile(archive, "w") as zf:
                    if variant == "escape":
                        zf.writestr("src/omegacode/../../escape.py", "invented")
                    elif variant == "duplicate":
                        zf.writestr("src/omegacode/a.py", "invented")
                        with self.assertWarns(UserWarning):
                            zf.writestr("src/omegacode/a.py", "invented again")
                    else:
                        entry = zipfile.ZipInfo("src/omegacode/link.py")
                        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                        zf.writestr(entry, "invented-target")
                pin = {**worker.PINS["r14"], "archive": worker.file_sha(archive)}
                with self.assertRaises(worker.Refusal):
                    worker.stage_archive(archive, root / "release", pin)
                self.assertFalse((root / "escape.py").exists())


class StateControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        home = self.root / "home"
        home.mkdir(mode=0o700)
        (home / "state").mkdir(mode=0o700)
        (home / "state" / "synthetic-retained.txt").write_text("invented retained state\n")
        db = home / "state" / "index.sqlite3"
        with sqlite3.connect(db) as conn:
            conn.executescript("CREATE TABLE grants(id TEXT); CREATE TABLE records(id TEXT); CREATE TABLE operations(id TEXT);")
        self.instance = worker.Worker({"home": str(home), "work_root": str(self.root),
                         "receipts": str(self.root), "uid": os.getuid(), "gid": os.getgid(),
                         "user": "invented", "python": "/unused/python", "case": "full"})
        self.p1 = patch.object(worker, "listeners", return_value=[])
        self.p2 = patch.object(worker, "uid_code_pids", return_value=set())
        self.p1.start()
        self.p2.start()

    def tearDown(self):
        self.p2.stop()
        self.p1.stop()
        self.tmp.cleanup()

    def test_cold_copy_and_matching_state_restore_preserve_database_and_full_tree(self):
        state = self.instance.state
        (state / "artifacts" / "empty-dir").mkdir(parents=True)
        (state / "artifacts" / "invented-blob").write_bytes(b"invented CAS bytes")
        snapshot = self.root / "snapshot"
        before = worker.inventory(state)
        digest = self.instance.copy_state(snapshot)
        self.assertEqual(digest, worker.inventory_sha(before))
        (state / "newer-only-synthetic.txt").write_text("newer bytes must not reach old binary")
        with patch.object(worker.os, "chown"):
            restored = self.instance.restore_state(snapshot)
        self.assertEqual(restored, digest)
        self.assertEqual(worker.inventory(state), before)
        self.assertTrue((self.instance.home / "retained-newer-state/newer-only-synthetic.txt").is_file())
        worker.integrity(state)

    def test_no_copy_or_restore_when_service_or_listener_remains(self):
        for function, value in (("listeners", [{"address": "127.0.0.1"}]), ("uid_code_pids", {1234})):
            with self.subTest(function=function), patch.object(worker, function, return_value=value):
                with self.assertRaisesRegex(worker.Refusal, "state_copy_not_quiescent"):
                    self.instance.copy_state(self.root / "snapshot")
                with self.assertRaisesRegex(worker.Refusal, "restore_not_quiescent"):
                    self.instance.restore_state(self.root / "missing-snapshot")

    def test_symlink_or_hardlink_state_refused(self):
        state = self.instance.state
        marker = state / "synthetic-retained.txt"
        bad = state / "link"
        bad.symlink_to(marker)
        with self.assertRaisesRegex(worker.Refusal, "state_special_file|state_link"):
            worker.inventory(state)
        bad.unlink()
        os.link(marker, bad)
        with self.assertRaisesRegex(worker.Refusal, "state_link"):
            worker.inventory(state)

    def test_uninstall_refuses_authority_or_any_owned_record(self):
        state = self.instance.state
        self.assertFalse(worker.zero_authority(state)["host_registered"])
        for table in ("grants", "records", "operations"):
            with self.subTest(table=table):
                with sqlite3.connect(state / "index.sqlite3") as conn:
                    conn.execute(f"INSERT INTO {table} VALUES ('invented')")
                with self.assertRaises(worker.Refusal):
                    worker.zero_authority(state)
                with sqlite3.connect(state / "index.sqlite3") as conn:
                    conn.execute(f"DELETE FROM {table}")
        (state / "registration.json").write_text('{"invented":"not a credential"}')
        with self.assertRaisesRegex(worker.Refusal, "registration_present"):
            worker.zero_authority(state)

    def test_database_corruption_refused(self):
        (self.instance.state / "index.sqlite3").write_bytes(b"invented corrupt database")
        with self.assertRaises(sqlite3.DatabaseError):
            worker.integrity(self.instance.state)


class UnitControls(unittest.TestCase):
    def test_missing_unit_status_can_be_observed_without_becoming_command_failure(self):
        instance = worker.Worker({"home": "/unused", "work_root": "/unused", "receipts": "/unused",
                                  "uid": 1, "gid": 1, "user": "invented", "python": "/unused/python"})
        with patch.object(instance, "systemctl", return_value="MainPID=0\nLoadState=not-found") as call:
            self.assertEqual(instance.show()["LoadState"], "not-found")
            self.assertEqual(call.call_args.kwargs["expected"], (0, 1))

    def test_receipts_only_include_supplied_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "receipt.json"
            worker.write_json(path, {"ok": False, "reason": "invented_refusal"})
            self.assertEqual(json.loads(path.read_text()), {"ok": False, "reason": "invented_refusal"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class ContainmentVerdictControls(unittest.TestCase):
    def test_systemd_terminal_env_normalizes_signal_names_and_refuses_incomplete_facts(self):
        samples = (("success", "exited", "0", "1", "0"),
                   ("exit-code", "exited", "2", "1", "2"),
                   ("signal", "killed", "KILL", "2", "9"),
                   ("success", "killed", "TERM", "2", "15"),
                   ("timeout", "killed", "15", "2", "15"))
        for result, code, status, expected_code, expected_status in samples:
            self.assertEqual(supervise.normalize_systemd_terminal({"SERVICE_RESULT": result,
                             "EXIT_CODE": code, "EXIT_STATUS": status}),
                             {"Result": result, "ExecMainCode": expected_code, "ExecMainStatus": expected_status})
        for environment in ({}, {"SERVICE_RESULT": "success"},
                            {"SERVICE_RESULT": "success", "EXIT_CODE": "exited", "EXIT_STATUS": "invented"},
                            {"SERVICE_RESULT": "signal", "EXIT_CODE": "killed", "EXIT_STATUS": "999999"}):
            self.assertEqual(supervise.normalize_systemd_terminal(environment), {})

    def test_failure_before_health_can_never_qualify_a_control(self):
        for case in ("refusal", "timeout", "sigterm", "sigkill"):
            observation = {"control_ready_observed": False, "signal_sent": True,
                           "terminal": {"Result": "timeout", "ExecMainStatus": "9"}}
            self.assertFalse(supervise.expected_result({"case": case}, observation))

    def test_kill_requires_actual_signal_and_correct_terminal(self):
        observation = {"control_ready_observed": True, "signal_sent": True,
                       "terminal": {"Result": "signal", "ExecMainCode": "2", "ExecMainStatus": "9"}}
        self.assertTrue(supervise.expected_result({"case": "sigkill"}, observation))
        self.assertFalse(supervise.expected_result({"case": "sigkill"}, {**observation, "signal_sent": False}))
        self.assertFalse(supervise.expected_result({"case": "sigkill"},
                         {**observation, "terminal": {"Result": "exit-code", "ExecMainStatus": "9"}}))

    def test_term_accepts_systemd_clean_signal_semantics_but_rejects_normal_exit(self):
        for result in ("signal", "success"):
            observation = {"control_ready_observed": True, "signal_sent": True,
                           "terminal": {"Result": result, "ExecMainCode": "2", "ExecMainStatus": "15"}}
            self.assertTrue(supervise.expected_result({"case": "sigterm"}, observation))
            observation["terminal"]["ExecMainCode"] = "1"
            self.assertFalse(supervise.expected_result({"case": "sigterm"}, observation))

    def test_timeout_must_be_systemd_timeout_not_early_worker_failure(self):
        observation = {"control_ready_observed": True, "terminal": {"Result": "exit-code"}}
        self.assertFalse(supervise.expected_result({"case": "timeout"}, observation))
        observation["terminal"]["Result"] = "timeout"
        self.assertTrue(supervise.expected_result({"case": "timeout"}, observation))


class RuntimeHookControls(unittest.TestCase):
    def test_startup_hooks_and_external_symlinks_are_rejected_before_interpreter(self):
        for variant in ("pth", "customize", "symlink"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "runtime"
                root.mkdir()
                if variant == "pth":
                    (root / "invented.pth").write_text("import invented\n")
                elif variant == "customize":
                    (root / "sitecustomize.py").write_text("raise RuntimeError('invented')")
                else:
                    (root / "escape").symlink_to("/usr")
                with self.assertRaises(RuntimeError):
                    runtime_preflight._scan_immutable((root,), os.getuid() + 100000)

    def test_service_owned_runtime_and_writable_runtime_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "runtime_service_owned"):
                runtime_preflight._protected_chain(root, os.getuid())
            root.chmod(0o777)
            try:
                with self.assertRaisesRegex(RuntimeError, "runtime_writable"):
                    runtime_preflight._protected_chain(root, os.getuid() + 100000)
            finally:
                root.chmod(0o700)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--r14-archive", type=Path)
    parser.add_argument("--r152-archive", type=Path)
    args, remaining = parser.parse_known_args()
    if args.r14_archive or args.r152_archive:
        if not (args.r14_archive and args.r152_archive):
            parser.error("supply both exact archives")
        ARCHIVES = {"r14": args.r14_archive, "r152": args.r152_archive}
    unittest.main(argv=[__file__, *remaining])
