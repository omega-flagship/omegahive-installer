"""The real runtime talks to an agent hub through commchannel=hive.

Skipped unless a PeTTa checkout is configured (scripts/dev/setup_petta_env.sh):

    HIVE_TEST_PETTA=~/PeTTa  HIVE_TEST_CHROMADB_LIB=/path/to/petta_lib_chromadb \
        python3 -m unittest tests.test_channel_hive_runtime
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

from test_channel_hive import FakeHub, serve, wait_for

ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "tests" / "hive_channel_runtime_smoke.metta"
PETTA = os.environ.get("HIVE_TEST_PETTA", "")
CHROMADB_LIB = os.environ.get("HIVE_TEST_CHROMADB_LIB", "")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


@unittest.skipUnless(
    serve is not None and PETTA and (pathlib.Path(PETTA) / "run.sh").exists() and CHROMADB_LIB,
    "set HIVE_TEST_PETTA and HIVE_TEST_CHROMADB_LIB to boot the runtime",
)
class HiveChannelRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-channel-"))
        repos = self.tmp / "repos"
        repos.mkdir()
        (repos / "OmegaClaw-Core").symlink_to(ROOT)
        (repos / "petta_lib_chromadb").symlink_to(pathlib.Path(CHROMADB_LIB).resolve())
        shutil.copy(SMOKE, self.tmp / "run.metta")
        self.hub = FakeHub()

    def tearDown(self):
        self.hub.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_round_trip_through_router(self):
        env = dict(
            os.environ,
            LANG="C.UTF-8",
            commchannel="hive",
            HIVE_WS_URL=f"ws://127.0.0.1:{self.hub.port}",
            HIVE_WS_TOKEN="agent-alpha",
            OMEGACLAW_MEMORY_DIR=str(self.tmp / "memory"),
            embeddingprovider="OpenAI",
        )
        # PeTTa prints a lot while compiling; a pipe would fill and block it.
        log_path = self.tmp / "agent.log"
        log = open(log_path, "w")
        proc = subprocess.Popen(
            ["sh", str(pathlib.Path(PETTA) / "run.sh"), str(self.tmp / "run.metta")],
            cwd=self.tmp,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            self.assertTrue(wait_for(lambda: self.hub.connections, timeout=120), "agent never connected")
            self.assertEqual(self.hub.next_frame(timeout=10), {"type": "resume", "last_seen_seq": None})
            self.assertEqual(self.hub.tokens[-1], "Bearer agent-alpha")
            envelope = {"hive": 1, "sender": "user:jon", "conversation_id": "c-1", "text": "ping"}
            self.hub.push(1, json.dumps(envelope))
            reply = self.hub.next_frame(timeout=60)
            self.assertEqual(reply["type"], "agent_message")
            self.assertEqual(reply["text"], "pong from the agent")
            self.assertEqual(reply["conversation_id"], "c-1")
            proc.wait(timeout=60)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            log.close()
        output = ANSI.sub("", log_path.read_text(errors="replace"))
        self.assertEqual(proc.returncode, 0, output[-4000:])
        received = re.search(r"^\(HIVE-RECEIVED (.*)\)$", output, re.M | re.S)
        self.assertIsNotNone(received, output[-4000:])
        self.assertIn("channel=hive", output)
        self.assertIn("text=ping", output)
        self.assertIn("connected=true", output)


if __name__ == "__main__":
    unittest.main()
