#!/usr/bin/env python3
"""Purpose: check install/ui_pins.py, the rule both release builds run before building the web UI, on a small exported
tree: a file pinned in hive/ui/src/lib/mindSpace/metta/PIN.json and missing from its place lands there from its copy
beside PIN.json or from the Omega core bundle at core-dependency.json's revision, each only with its pinned sha256; a
bundle whose file differs from the pin, or a missing file nothing supplies, stops it with nothing written; a file
already in place is left as it is.

Needs git:
    python3 -m unittest tests/test_ui_pins.py
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "install" / "ui_pins.py"
NAL = b"(= (nal) 1)\n"
HIVE = b"(= (hive) 2)\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class UiPinsTest(unittest.TestCase):
    def setUp(self):
        if not shutil.which("git"):
            self.skipTest("no git on PATH to make a core bundle with")
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="ui-pins-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # The Omega core at one revision, as the release's omega-core-*.bundle prebuilt carries it.
        core = self.tmp / "core"
        core.mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(core), *a], check=True, capture_output=True, text=True).stdout
        git("init", "-q")
        (core / "lib_nal.metta").write_bytes(NAL)
        git("add", "lib_nal.metta")
        git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "core")
        self.revision = git("rev-parse", "HEAD").strip()
        self.bundle = self.tmp / "omega-core-test.bundle"
        git("bundle", "create", "-q", str(self.bundle), "HEAD")
        # The exported tree: PIN.json with lib_hive's copy beside it, and no third_party/Omega files.
        self.code = self.tmp / "omegahive"
        metta = self.code / "hive/ui/src/lib/mindSpace/metta"
        metta.mkdir(parents=True)
        (metta / "lib_hive.metta").write_bytes(HIVE)
        self.pin(NAL)
        (self.code / "core-dependency.json").write_text(json.dumps({"path": "third_party/Omega",
                                                                    "revision": self.revision}))

    def pin(self, nal):
        (self.code / "hive/ui/src/lib/mindSpace/metta/PIN.json").write_text(json.dumps({"files": {
            "lib_nal.metta": {"from": "third_party/Omega/lib_nal.metta", "sha256": sha(nal)},
            "lib_hive.metta": {"from": "hive/spaces/lib_hive.metta", "sha256": sha(HIVE)}}}))

    def run_pins(self, *prebuilt):
        work = self.tmp / "work"
        work.mkdir(exist_ok=True)
        return subprocess.run([sys.executable, "-I", str(SCRIPT), str(self.code), str(work), *map(str, prebuilt)],
                              capture_output=True, text=True)

    def test_missing_files_land_from_their_copy_and_from_the_core_bundle(self):
        done = self.run_pins(self.tmp / "omegacode-x.tgz", self.bundle)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.code / "third_party/Omega/lib_nal.metta").read_bytes(), NAL)
        self.assertEqual((self.code / "hive/spaces/lib_hive.metta").read_bytes(), HIVE)
        self.assertIn(f"pinned third_party/Omega/lib_nal.metta from omega-core-test.bundle at {self.revision[:12]}",
                      done.stdout)
        self.assertIn("pinned hive/spaces/lib_hive.metta from hive/ui/src/lib/mindSpace/metta/lib_hive.metta",
                      done.stdout)

    def test_a_bundle_file_that_is_not_the_pinned_one_stops_with_nothing_written(self):
        self.pin(b"(= (nal) 0)\n")
        done = self.run_pins(self.bundle)
        self.assertEqual(done.returncode, 1)
        self.assertIn("is not its pinned sha256", done.stderr)
        self.assertFalse((self.code / "third_party/Omega/lib_nal.metta").exists())

    def test_a_missing_core_file_without_a_bundle_stops(self):
        done = self.run_pins(self.tmp / "omegacode-x.tgz")
        self.assertEqual(done.returncode, 1)
        self.assertIn("no core bundle has it", done.stderr)
        self.assertFalse((self.code / "third_party/Omega/lib_nal.metta").exists())

    def test_a_file_already_in_place_is_left_as_it_is(self):
        # A checkout with the submodule holds its own files; the rule supplies only what an archive lacks.
        mine = self.code / "third_party/Omega/lib_nal.metta"
        mine.parent.mkdir(parents=True)
        mine.write_bytes(b"(= (checkout) 3)\n")
        done = self.run_pins()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(mine.read_bytes(), b"(= (checkout) 3)\n")
        self.assertEqual((self.code / "hive/spaces/lib_hive.metta").read_bytes(), HIVE)


if __name__ == "__main__":
    unittest.main()
