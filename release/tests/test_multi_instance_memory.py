"""Two agents booted from one checkout keep separate, persistent memory.

Boots the real runtime through PeTTa, so it is skipped unless a PeTTa checkout
is available (see scripts/dev/setup_petta_env.sh):

    HIVE_TEST_PETTA=~/PeTTa  HIVE_TEST_CHROMADB_LIB=/path/to/petta_lib_chromadb \
        python3 -m unittest tests.test_multi_instance_memory
"""

import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "tests" / "multi_instance_memory_smoke.metta"
PETTA = os.environ.get("HIVE_TEST_PETTA", "")
CHROMADB_LIB = os.environ.get("HIVE_TEST_CHROMADB_LIB", "")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


@unittest.skipUnless(
    PETTA and (pathlib.Path(PETTA) / "run.sh").exists() and CHROMADB_LIB,
    "set HIVE_TEST_PETTA and HIVE_TEST_CHROMADB_LIB to boot the runtime",
)
class MultiInstanceMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-multi-"))
        self.repos = self.tmp / "repos"
        self.repos.mkdir()
        (self.repos / "OmegaClaw-Core").symlink_to(ROOT)
        (self.repos / "petta_lib_chromadb").symlink_to(pathlib.Path(CHROMADB_LIB).resolve())
        self.repo_world = ROOT / "memory" / "world.metta"
        self.repo_world_before = self.repo_world.read_bytes() if self.repo_world.exists() else None

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def boot(self, agent_id):
        # PeTTa resolves imports against the entry file's directory and
        # git-import! clones into ./repos, so each agent gets its own dir with
        # its own entry file and a link to the shared checkout.
        agent_dir = self.tmp / agent_id
        agent_dir.mkdir(exist_ok=True)
        if not (agent_dir / "repos").exists():
            (agent_dir / "repos").symlink_to(self.repos)
        shutil.copy(SMOKE, agent_dir / "run.metta")
        env = dict(
            os.environ,
            LANG="C.UTF-8",
            HIVE_INSTANCE_ID=agent_id,
            OMEGACLAW_MEMORY_DIR=str(agent_dir / "memory"),
            embeddingprovider="OpenAI",
        )
        result = subprocess.run(
            ["sh", str(pathlib.Path(PETTA) / "run.sh"), str(agent_dir / "run.metta")],
            cwd=agent_dir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=600,
        )
        output = ANSI.sub("", result.stdout)
        self.assertEqual(result.returncode, 0, output[-4000:])
        loaded = re.search(r"^\(LOADED-MARKERS \((.*)\)\)$", output, re.M)
        self.assertIsNotNone(loaded, output[-4000:])
        return agent_dir, loaded.group(1).split()

    def test_agents_keep_separate_persistent_memory(self):
        alpha_dir, alpha_first = self.boot("alpha")
        beta_dir, beta_first = self.boot("beta")
        _, alpha_second = self.boot("alpha")

        self.assertEqual(alpha_first, [])
        self.assertEqual(beta_first, [])
        self.assertEqual(alpha_second, ["alpha"])

        self.assertIn("(InstanceMarker alpha)", (alpha_dir / "memory" / "world.metta").read_text())
        beta_world = (beta_dir / "memory" / "world.metta").read_text()
        self.assertIn("(InstanceMarker beta)", beta_world)
        self.assertNotIn("alpha", beta_world)
        self.assertTrue((alpha_dir / "chroma_db").is_dir())
        self.assertTrue((beta_dir / "chroma_db").is_dir())

        after = self.repo_world.read_bytes() if self.repo_world.exists() else None
        self.assertEqual(after, self.repo_world_before, "checkout memory/ must not be written")


if __name__ == "__main__":
    unittest.main()
