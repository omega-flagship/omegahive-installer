"""Space bounding keeps protected atoms and leaves receipts; saves are atomic and write only a changed space.

Boots the real runtime through PeTTa, so it is skipped unless a PeTTa checkout
is available (see scripts/dev/setup_petta_env.sh):

    HIVE_TEST_PETTA=~/PeTTa  HIVE_TEST_CHROMADB_LIB=/path/to/petta_lib_chromadb \\
        python3 -m unittest tests.test_memory_safety
"""

import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "tests" / "memory_safety_smoke.metta"
PETTA = os.environ.get("HIVE_TEST_PETTA", "")
CHROMADB_LIB = os.environ.get("HIVE_TEST_CHROMADB_LIB", "")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

sys.path.insert(0, str(ROOT / "src"))


class SaveHelperTests(unittest.TestCase):
    def setUp(self):
        from hive.runtime.extensions import helper_metta
        self.helper = helper_metta
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-save-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.target = self.tmp / "world.metta"

    def _save(self, texts):
        """save_atoms with every fsync counted: a sync is the disk commit an idle mind must not make."""
        from unittest import mock
        with mock.patch.object(self.helper.os, "fsync", wraps=os.fsync) as fsync:
            wrote = self.helper.save_atoms(str(self.target), texts)
        return wrote, fsync.call_count

    def test_a_changed_space_replaces_the_file_whole(self):
        self.target.write_text("(Old atom)\n")
        before = self.target.stat().st_ino
        # one line per atom, as appending each with append-file wrote them; a text with a newline stays one atom's text
        self.assertEqual(self._save(["(New atom)", '(Note "two\nlines é")']), (True, 2))
        self.assertEqual(self.target.read_bytes(), '(New atom)\n(Note "two\nlines é")\n'.encode("utf-8"))
        self.assertNotEqual(self.target.stat().st_ino, before)        # renamed over the old file, never rewritten in place
        self.assertEqual(list(self.tmp.glob("*.saving")), [])

    def test_an_unchanged_space_writes_and_syncs_nothing(self):
        # A disk audit found idle minds committing their memory several times a second: the loop saves every memory
        # space each iteration, and each save rewrote and fsynced the file whether or not the space had changed.
        for texts in ([], ["(Pin core-fact kept)", "(Filler one)"]):
            with self.subTest(atoms=len(texts)):
                self.assertTrue(self._save(texts)[0])
                st = self.target.stat()
                self.assertEqual(self._save(texts), (False, 0))
                after = self.target.stat()
                self.assertEqual((after.st_ino, after.st_size, after.st_mtime_ns), (st.st_ino, st.st_size, st.st_mtime_ns))
                self.assertEqual(list(self.tmp.glob("*.saving")), [])

    def test_a_missing_file_is_written_even_for_an_empty_space(self):
        self.assertEqual(self._save([]), (True, 2))
        self.assertEqual(self.target.read_bytes(), b"")

    def test_a_failed_save_leaves_the_previous_file(self):
        from unittest import mock
        self.target.write_text("(Old atom)\n")
        with mock.patch.object(self.helper.os, "fsync", side_effect=OSError("disk full (invented)")):
            with self.assertRaises(OSError):
                self.helper.save_atoms(str(self.target), ["(New atom)"])
        self.assertEqual(self.target.read_text(), "(Old atom)\n")
        self.assertEqual(list(self.tmp.glob("*.saving")), [])

    def test_protected_heads(self):
        from hive.runtime.extensions import helper_metta as helper

        for atom in ("(Pin x)", "(Identity name \"A\")", "(Goal g1 open)", "(Commitment c)"):
            self.assertTrue(helper.protected_atom(atom), atom)
        for atom in ("(Filler a)", "(Pinata x)", "Pin"):
            self.assertFalse(helper.protected_atom(atom), atom)


@unittest.skipUnless(
    PETTA and (pathlib.Path(PETTA) / "run.sh").exists() and CHROMADB_LIB,
    "set HIVE_TEST_PETTA and HIVE_TEST_CHROMADB_LIB to boot the runtime",
)
class BoundSpaceTests(unittest.TestCase):
    def test_bounding_keeps_protected_atoms_and_writes_receipts(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-bound-"))
        repos = tmp / "repos"
        repos.mkdir()
        (repos / "OmegaClaw-Core").symlink_to(ROOT)
        (repos / "petta_lib_chromadb").symlink_to(pathlib.Path(CHROMADB_LIB).resolve())
        shutil.copy(SMOKE, tmp / "run.metta")
        memory = tmp / "memory"
        env = dict(os.environ, LANG="C.UTF-8", OMEGACLAW_MEMORY_DIR=str(memory), embeddingprovider="OpenAI")
        result = subprocess.run(["sh", str(pathlib.Path(PETTA) / "run.sh"), str(tmp / "run.metta")],
                                cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=600)
        output = ANSI.sub("", result.stdout)
        self.assertEqual(result.returncode, 0, output[-4000:])
        remaining = re.search(r"^\(REMAINING (.*)\)$", output, re.M)
        self.assertIsNotNone(remaining, output[-4000:])
        kept = remaining.group(1)
        self.assertIn("Identity", kept)
        self.assertIn("Pin", kept)
        self.assertIn("one", kept)          # first atoms fit under the limit
        self.assertNotIn("three", kept)     # later filler was dropped
        receipts = (memory / "evicted.metta").read_text()
        self.assertIn("three", receipts)
        self.assertNotIn("core-fact", receipts)
        world = (memory / "world.metta").read_text()
        self.assertIn("core-fact", world)
        self.assertEqual(list(memory.glob("*.saving")), [])
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
