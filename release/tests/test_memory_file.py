"""memory_file resolves under OMEGACLAW_MEMORY_DIR and creates the file.

append-file only appends to an existing file; without this a fresh agent's
history write fails, and the failure makes the loop backtrack into another
LLM call.
"""

import importlib
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class MemoryFileTests(unittest.TestCase):
    def test_memory_file_is_created_under_memory_dir(self):
        with tempfile.TemporaryDirectory() as memory:
            old = os.environ.get("OMEGACLAW_MEMORY_DIR")
            os.environ["OMEGACLAW_MEMORY_DIR"] = memory
            sys.path.insert(0, str(ROOT / "src"))
            try:
                import helper_metta

                helper_metta = importlib.reload(helper_metta)
                path = helper_metta.memory_file("history.metta")
                self.assertEqual(path, str(pathlib.Path(memory) / "history.metta"))
                self.assertTrue(pathlib.Path(path).is_file())
                with self.assertRaises(ValueError):
                    helper_metta.memory_file("../escape.metta")
            finally:
                sys.path.remove(str(ROOT / "src"))
                if old is None:
                    os.environ.pop("OMEGACLAW_MEMORY_DIR", None)
                else:
                    os.environ["OMEGACLAW_MEMORY_DIR"] = old
                importlib.reload(helper_metta)


if __name__ == "__main__":
    unittest.main()
