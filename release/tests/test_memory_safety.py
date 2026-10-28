"""Space bounding keeps protected atoms and leaves receipts; saves are atomic.

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
    def test_commit_replaces_only_when_complete(self):
        import helper_metta as helper

        tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-save-"))
        target = tmp / "world.metta"
        target.write_text("(Old atom)\n")
        saving = helper.save_begin(str(target))
        # Until the commit, the previous save is untouched.
        self.assertEqual(target.read_text(), "(Old atom)\n")
        pathlib.Path(saving).write_text("(New atom)\n")
        self.assertIs(helper.save_commit(saving, str(target)), True)
        self.assertEqual(target.read_text(), "(New atom)\n")
        self.assertFalse(pathlib.Path(saving).exists())
        shutil.rmtree(tmp, ignore_errors=True)

    def test_protected_heads(self):
        import helper_metta as helper

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
