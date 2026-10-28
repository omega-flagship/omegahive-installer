"""A mind that has chosen to wait makes no model calls until new input arrives or its wait expires.

The real runtime and loop (src/loop.metta) run against a fake agent hub and a fake model that answers every turn with
"wait <seconds>" and counts the calls. Before the fix a single message bought maxNewInputLoops (12) model calls, one
every sleepInterval, all of them waits; now the first wait ends the mind's turns.

Skipped unless a PeTTa checkout and the chromadb lib are configured:

    HIVE_TEST_PETTA=~/PeTTa  HIVE_TEST_CHROMADB_LIB=/path/to/petta_lib_chromadb \
        python3 -m unittest tests.test_wait_quiet_runtime
"""

import http.server
import sys
import sysconfig
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from test_channel_hive import FakeHub, serve, wait_for

ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "tests" / "wait_quiet_runtime_smoke.metta"
PETTA = os.environ.get("HIVE_TEST_PETTA", "")
CHROMADB_LIB = os.environ.get("HIVE_TEST_CHROMADB_LIB", "")


class FakeModel:
    """An OpenAI-compatible model and agent API: every chat turn is answered with `answer`; other calls get {}."""

    def __init__(self, answer):
        self.answer, self.calls, self.lock = answer, [], threading.Lock()
        model = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, body):
                raw = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self._reply({"ops": []} if self.path.endswith("/control") else {})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path.endswith("/chat/completions"):
                    with model.lock:
                        model.calls.append(time.monotonic())
                    self._reply({"id": "x", "object": "chat.completion", "created": 0, "model": "hive",
                                 "choices": [{"index": 0, "finish_reason": "stop",
                                              "message": {"role": "assistant", "content": model.answer}}],
                                 "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
                elif self.path.endswith("/embeddings"):
                    items = body.get("input")
                    items = items if isinstance(items, list) else [items]
                    self._reply({"object": "list", "model": "x", "usage": {"prompt_tokens": 1, "total_tokens": 1},
                                 "data": [{"object": "embedding", "index": i, "embedding": [0.1] * 384}
                                          for i in range(len(items))]})
                else:
                    self._reply({})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def count(self):
        with self.lock:
            return len(self.calls)

    def shutdown(self):
        self.server.shutdown()


class ChosenWaitShapeTests(unittest.TestCase):
    """The loop's reading of a response (helper.chosen_wait_seconds) and its one call site; no runtime needed."""

    def test_only_a_pure_wait_ends_the_turns(self):
        sys.path.insert(0, str(ROOT / "src"))
        import helper
        cases = {'((wait "900"))': 900, '((wait 900))': 900, '((wait "600 seconds, nothing owed"))': 600,
                 '((wait "10 minutes for the build"))': 600, '((wait "2h"))': 7200, '((wait "15 min"))': 900,
                 '((wait "5 moments"))': 30,
                 '((wait "5"))': 30, '((wait "999999"))': 86400, '((wait "nothing owed"))': 0,
                 '((wait "a \\"q\\" b"))': 0, '((wait "900") (wait "still"))': 900,
                 '((send "hi") (wait "for reply"))': -1, '((query "x"))': -1, '()': -1, '(Error x y)': -1, '': -1,
                 # the shapes the runtime actually prints (agent.log "RESPONSE:"), pinned by the runtime tests below:
                 # an unquoted `wait 30 reason` arrives as one quoted rest-text argument
                 '((wait "30 nothing owed, waiting for the owner"))': 30, '((wait "30"))': 30,
                 # the runtime's own provider-error wait (lib_llm_ext.callProvider): a 60 s back-off (Kimi r1 K8)
                 '((wait "LLM-PROVIDER-NOT-AVAILABLE provider=Hive missing=HIVE_LLM_TOKEN; configure the key"))': 60,
                 '((wait "LLM-PROVIDER-UNKNOWN provider=x; choose a configured provider and restart"))': 60,
                 '((send "hi") (wait "LLM-PROVIDER-UNKNOWN provider=x"))': -1}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(helper.chosen_wait_seconds(text), expected)

    def test_the_loop_honors_the_choice_after_each_response(self):
        loop = (ROOT / "src" / "loop.metta").read_text()
        self.assertIn("($_ (honor-chosen-wait $sexpr)))", loop)
        self.assertIn("(= (honor-chosen-wait $sexpr)", loop)
        self.assertIn("(change-state! &loops 0)", loop.split("(= (honor-chosen-wait $sexpr)")[1].split("(= (omegaclaw)")[0])


@unittest.skipUnless(
    serve is not None and PETTA and (pathlib.Path(PETTA) / "run.sh").exists() and CHROMADB_LIB,
    "set HIVE_TEST_PETTA and HIVE_TEST_CHROMADB_LIB to boot the runtime",
)
class WaitQuietRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="wait-quiet-"))
        repos = self.tmp / "repos"
        repos.mkdir()
        (repos / "OmegaClaw-Core").symlink_to(ROOT)
        (repos / "petta_lib_chromadb").symlink_to(pathlib.Path(CHROMADB_LIB).resolve())
        shutil.copy(SMOKE, self.tmp / "run.metta")
        self.hub = FakeHub()

    def tearDown(self):
        self.hub.shutdown()
        if not os.environ.get("KEEP_WAIT_QUIET_TMP"):
            shutil.rmtree(self.tmp, ignore_errors=True)

    def _boot(self, model, provider="Hive"):
        api = f"http://127.0.0.1:{model.port}"
        env = dict(os.environ, LANG="C.UTF-8", commchannel="hive",
                   HIVE_WS_URL=f"ws://127.0.0.1:{self.hub.port}", HIVE_WS_TOKEN="agent-alpha", HIVE_API_URL=api,
                   HIVE_AGENT_ID="a_wait", OMEGACLAW_MEMORY_DIR=str(self.tmp / "memory"), provider=provider,
                   HIVE_LLM_URL=f"{api}/llm/v1", HIVE_LLM_TOKEN="agent-alpha", OPENAI_BASE_URL=f"{api}/llm/v1",
                   OPENAI_API_KEY="agent-alpha", embeddingprovider="OpenAI",
                   # as a local mind runs on this machine: the hive's own interpreter for the channel, its packages
                   # for the Python embedded in PeTTa
                   HIVE_PYTHON=sys.executable,
                   PYTHONPATH=os.pathsep.join(p for p in [sysconfig.get_paths()["purelib"], os.environ.get("PYTHONPATH")] if p),
                   PATH=os.pathsep.join([os.path.dirname(sys.executable), os.environ.get("PATH", "")]))
        self.log = open(self.tmp / "agent.log", "w")
        proc = subprocess.Popen(["sh", str(pathlib.Path(PETTA) / "run.sh"), str(self.tmp / "run.metta"), "--silent"],
                                cwd=self.tmp, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.addCleanup(self._stop, proc)
        self.assertTrue(wait_for(lambda: self.hub.connections, timeout=180), self._tail("agent never connected"))
        return proc

    def _stop(self, proc):
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        self.log.close()

    def _tail(self, why):
        try:
            return why + "\n" + (self.tmp / "agent.log").read_text(errors="replace")[-3000:]
        except OSError:
            return why

    def _response_shapes(self):
        """The parsed responses the runtime printed, as `repr` gives them to helper.chosen_wait_seconds."""
        import re
        log = (self.tmp / "agent.log").read_text(errors="replace")
        return re.findall(r"^\(RESPONSE: (.*)\)$", log, re.M), log.count("(---------iteration ")

    def _pin_shape(self, expected_repr, seconds):
        """Kimi r1 K2: pin the repr the runtime really produces, and that the helper reads it as the wait it is."""
        sys.path.insert(0, str(ROOT / "src"))
        import helper
        shapes, _ = self._response_shapes()
        self.assertTrue(shapes, self._tail("no RESPONSE line"))
        self.assertEqual(set(shapes), {expected_repr}, self._tail("the response repr changed shape"))
        self.assertEqual(helper.chosen_wait_seconds(expected_repr), seconds)

    def _message(self, seq, text):
        """Push to the channel's live connection (its daemon may reconnect while the runtime finishes booting)."""
        frame = json.dumps({"type": "user_message", "seq": seq,
                            "text": json.dumps({"hive": 1, "sender": "user:quinn", "conversation_id": "c-1", "text": text})})
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                self.hub.connections[-1].send(frame)
                return
            except Exception:
                time.sleep(0.5)
        self.fail(self._tail("no live hub connection to deliver on"))

    def test_a_chosen_wait_makes_no_calls_until_input_or_expiry(self):
        model = FakeModel("wait 30 nothing owed, waiting for the owner")
        self.addCleanup(model.shutdown)
        self._boot(model)
        self.assertEqual(model.count(), 0, "a clean boot listens without spending model turns")
        self._message(1, "rest until I write again")
        self.assertTrue(wait_for(lambda: model.count() >= 1, timeout=60), self._tail("the message never reached the model"))
        first = model.calls[0]
        # The wait asked for 30 seconds: before it expires the mind makes no further call (the old loop made one every
        # sleepInterval, 3 s, for the 12 turns a message buys).
        time.sleep(max(0.0, first + 24 - time.monotonic()))
        self.assertEqual(model.count(), 1, self._tail(f"calls during the chosen wait: {model.count()}"))
        # Its wait expires: it gets one turn, answers wait again, and is quiet again.
        self.assertTrue(wait_for(lambda: model.count() >= 2, timeout=30), self._tail("the wait never expired"))
        self.assertGreaterEqual(model.calls[1] - first, 29)
        time.sleep(9)
        self.assertEqual(model.count(), 2, self._tail(f"calls after the expiry turn: {model.count()}"))
        # New input wakes it at once, for one turn only while it keeps choosing to wait.
        self._message(2, "one more thing")
        self.assertTrue(wait_for(lambda: model.count() >= 3, timeout=30), self._tail("new input did not reach the model"))
        time.sleep(9)
        self.assertEqual(model.count(), 3, self._tail(f"calls after new input: {model.count()}"))
        # the three calls are the first message, the wait's expiry and the second message: none at boot
        self._pin_shape('((wait "30 nothing owed, waiting for the owner"))', 30)

    def test_a_clean_boot_with_no_input_makes_no_calls(self):
        """Kimi r1 K1: the no-input soak. A booted mind with no input and its wake not yet due makes no model call at
        all, over many loop iterations (sleepInterval is 3 s; its first autonomous wake is wakeupInterval, 900 s, after
        boot). The calls a quiet mind makes are input, a chosen wait expiring, and its wakes; nothing at boot."""
        model = FakeModel("wait 30 nothing owed")
        self.addCleanup(model.shutdown)
        self._boot(model)
        start = time.monotonic()
        _, before = self._response_shapes()
        while time.monotonic() - start < 21:
            self.assertEqual(model.count(), 0, self._tail(f"a call with no input after boot: {model.count()}"))
            time.sleep(1)
        shapes, after = self._response_shapes()
        self.assertGreaterEqual(after - before, 4, self._tail("the loop did not keep iterating during the soak"))
        self.assertEqual((model.count(), shapes), (0, []), self._tail("no call and no response with no input"))

    def test_a_provider_error_wait_retries_after_a_short_back_off(self):
        """Kimi r1 K8: with no usable provider the runtime answers its own wait "LLM-PROVIDER-..."; that is not the
        mind's choice, so it is tried again after 60 s, not after the full wake interval (900 s), and not every 3 s."""
        model = FakeModel("unused")
        self.addCleanup(model.shutdown)
        self._boot(model, provider="NoSuchProvider")
        self._message(1, "are you there?")
        responses = lambda: self._response_shapes()[0]
        self.assertTrue(wait_for(lambda: len(responses()) >= 1, timeout=60), self._tail("the message never got a turn"))
        first = time.monotonic()
        self.assertTrue(responses()[0].startswith('((wait "LLM-PROVIDER-UNKNOWN'), self._tail("not the provider wait"))
        time.sleep(45)
        self.assertEqual(len(responses()), 1, self._tail("retried before the back-off"))
        self.assertTrue(wait_for(lambda: len(responses()) >= 2, timeout=40), self._tail("no retry after the back-off"))
        self.assertGreaterEqual(time.monotonic() - first, 55)
        time.sleep(9)
        self.assertEqual(len(responses()), 2, self._tail("the retry did not rest again"))
        self.assertEqual(model.count(), 0)

    def test_the_quoted_wait_form_rests_the_same(self):
        """Kimi r1 K2: `wait "30"` (quoted) is the same chosen wait as `wait 30`."""
        model = FakeModel('wait "30"')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, "rest a moment")
        self.assertTrue(wait_for(lambda: model.count() >= 1, timeout=60), self._tail("the message never reached the model"))
        first = model.calls[0]
        time.sleep(max(0.0, first + 20 - time.monotonic()))
        self.assertEqual(model.count(), 1, self._tail(f"calls during the quoted wait: {model.count()}"))
        self._pin_shape('((wait "30"))', 30)


if __name__ == "__main__":
    unittest.main()
