from hive.runtime.native_core import effective_source
"""A mind that has chosen to wait makes no model calls until new input arrives or its wait expires.

The real runtime and loop (Singnet src/loop.metta with the hive hooks) run against a fake agent hub and a fake model that answers every turn with
"wait <seconds>" and counts the calls. Before the fix a single message bought maxNewInputLoops (12) model calls, one
every sleepInterval, all of them waits; now the first wait ends the mind's turns. Each time a mind rests, by a chosen
wait, with its turns spent or with its format retries spent, its loop tells the hive once (hive_commons.rest_check),
and never for the runtime's own retries while their next turn comes by itself, so a person it owes an answer gets one
or is told (hive/core/replies.py).

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
import signal
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
    """An OpenAI-compatible model and agent API: every chat turn is answered with `answer`, or with the turn's entry
    when `answer` is a list (its last entry for every later turn), an int entry refusing that turn with that HTTP
    status; each chat request body is kept; other calls get {}, and each other POST is kept as (time, path, body)."""

    def __init__(self, answer, malformed=False):
        self.answer, self.calls, self.bodies, self.lock = answer, [], [], threading.Lock()
        self.posts = []
        self.malformed = malformed
        model = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, body, status=200):
                raw = json.dumps(body).encode()
                self.send_response(status)
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
                        model.bodies.append(body)
                        turn = len(model.calls)
                    answer = (model.answer[min(turn, len(model.answer)) - 1] if isinstance(model.answer, list)
                              else model.answer)
                    if isinstance(answer, int):
                        self._reply({"error": {"message": "invented refusal", "type": "invented"}}, answer)
                        return
                    self._reply({"id": "x", "object": "chat.completion", "created": 0, "model": "hive",
                                 "choices": [{"index": 0, "finish_reason": "stop",
                                              "message": ({"role": "assistant", "content": None, "tool_calls": [{"id": "bad", "type": "function", "function": {"name": "hive-run-response", "arguments": "{invalid-json"}}]} if model.malformed else {"role": "assistant", "content": answer})}],
                                 "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
                elif self.path.endswith("/embeddings"):
                    items = body.get("input")
                    items = items if isinstance(items, list) else [items]
                    self._reply({"object": "list", "model": "x", "usage": {"prompt_tokens": 1, "total_tokens": 1},
                                 "data": [{"object": "embedding", "index": i, "embedding": [0.1] * 384}
                                          for i in range(len(items))]})
                else:
                    with model.lock:
                        model.posts.append((time.monotonic(), self.path, body))
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

    def test_a_runtime_retry_is_no_rest_only_while_its_next_turn_comes_by_itself(self):
        """A provider back-off and a format failure's first three retries bring the next turn by themselves; the fourth
        format failure in a row rests the mind until input or its wake, so it is a rest the loop reports."""
        from hive.runtime.extensions import hive_helpers as helper
        wait = '((wait "LLM-FORMAT-ERROR retry with complete skill commands"))'
        for kind, attempts, due, seconds in (("format", 1, True, 2), ("format", 2, True, 2), ("format", 3, True, 2),
                                             ("format", 4, False, 0), ("format", 0, False, 0),
                                             ("provider", 0, True, 60), ("provider", 4, True, 60),
                                             ("normal", 0, False, 0), ("normal", 2, False, 0)):
            with self.subTest(kind=kind, attempts=attempts):
                self.assertIs(helper.runtime_retry_due(kind, attempts), due)
                self.assertEqual(helper.chosen_wait_seconds(wait, kind, attempts), seconds)
        # the loop counts attempts with next_format_retry_count, which stops at one past the retries
        attempts = 0
        for expected in (True, True, True, False, False):
            attempts = helper.next_format_retry_count("format", attempts)
            self.assertIs(helper.runtime_retry_due("format", attempts), expected)

    def test_model_authored_format_wait_is_normal_and_transport_remains_sixty(self):
        from hive.runtime.extensions import hive_helpers as helper
        for source, expected in (("wait \"LLM-FORMAT-ERROR retry\"", 0),
                                 ("wait \"LLM-PROVIDER-ERROR retry\"", 60),
                                 ("wait \"LLM-FORMAT-ERRORISH\"", 0),
                                 ('send "LLM-FORMAT-ERROR"', -1)):
            with self.subTest(source=source):
                self.assertEqual(helper.chosen_wait_seconds(helper.model_response_commands(source)), expected)

    def test_malformed_or_empty_batches_execute_no_prefix_commands(self):
        from hive.runtime.extensions import hive_helpers as helper
        for source in ('', 'read-file', 'send "valid prefix"\nread-file', 'read-file\nsend "valid suffix"'):
            with self.subTest(source=source):
                parsed = helper.model_response_commands(source)
                self.assertTrue(parsed.startswith('((wait "LLM-FORMAT-ERROR'), parsed)
                self.assertEqual(helper.chosen_wait_seconds(parsed, "format", 1), 2)
                self.assertNotIn('valid prefix', parsed)
                self.assertNotIn('valid suffix', parsed)
        # A quoted diagnostic word is ordinary command data, not a malformed top-level call.
        source = 'send "(syntax-error invented)"'
        self.assertEqual(helper.model_response_commands(source), helper.signature_balance_parentheses(source))
        hooks = (ROOT / 'hive/runtime/extensions/loop_hooks.metta').read_text()
        self.assertIn('(hive_helpers.prepare_model_response $text (py-call (hive_services.last_response_kind)))', hooks)

    def test_only_a_pure_wait_ends_the_turns(self):
        sys.path.insert(0, str(ROOT / "src"))
        from hive.runtime.extensions import hive_helpers as helper
        cases = {'((wait "900"))': 900, '((wait 900))': 900, '((wait "600 seconds, nothing owed"))': 600,
                 '((wait "10 minutes for the build"))': 600, '((wait "2h"))': 7200, '((wait "15 min"))': 900,
                 '((wait "5 moments"))': 30,
                 '((wait "5"))': 30, '((wait "999999"))': 86400, '((wait "nothing owed"))': 0,
                 '((wait "a \\"q\\" b"))': 0, '((wait "900") (wait "still"))': 900,
                 '((send "hi") (wait "for reply"))': -1, '((query "x"))': -1, '()': -1, '(Error x y)': -1, '': -1,
                 # the shapes the runtime actually prints (agent.log "RESPONSE:"), pinned by the runtime tests below:
                 # an unquoted `wait 30 reason` arrives as one quoted rest-text argument
                 '((wait "30 nothing owed, waiting for Jon"))': 30, '((wait "30"))': 30,
                 # the runtime's own provider-error wait (hive_services.chat): a 60 s back-off (Kimi r1 K8)
                 '((wait "LLM-PROVIDER-NOT-AVAILABLE provider=Hive missing=HIVE_LLM_TOKEN; configure the key"))': 60,
                 '((wait "LLM-PROVIDER-UNKNOWN provider=x; choose a configured provider and restart"))': 60,
                 '((send "hi") (wait "LLM-PROVIDER-UNKNOWN provider=x"))': -1}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(helper.chosen_wait_seconds(text), expected)

    def test_the_loop_honors_the_choice_after_each_response(self):
        loop = effective_source(ROOT)
        self.assertIn("(honor-chosen-wait $sexpr (get-state &lastResponseKind))", loop)
        self.assertIn("(= (honor-chosen-wait $sexpr)", loop)
        self.assertIn("(change-state! &loops 0)", loop.split("(= (honor-chosen-wait $sexpr)")[1].split("(= (hive-boot)")[0])


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
                                cwd=self.tmp, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        self.addCleanup(self._stop, proc)
        self.proc = proc
        wait_for(lambda: self.hub.connections or proc.poll() is not None, timeout=180)
        self.assertTrue(self.hub.connections, self._tail("agent never connected"))
        return proc

    def _stop(self, proc):
        # run.sh spawns swipl. Kill the fixture's own process group so the interpreter cannot outlive its shell.
        # The channel daemon already watches that interpreter and exits when its parent is gone.
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.wait()
        self.log.close()

    def _await_runtime(self, predicate, why, timeout):
        wait_for(lambda: predicate() or self.proc.poll() is not None, timeout=timeout)
        self.assertTrue(predicate(), self._tail(why))

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
        from hive.runtime.extensions import hive_helpers as helper
        shapes, _ = self._response_shapes()
        self.assertTrue(shapes, self._tail("no RESPONSE line"))
        self.assertEqual(set(shapes), {expected_repr}, self._tail("the response repr changed shape"))
        self.assertEqual(helper.chosen_wait_seconds(expected_repr), seconds)

    def _message(self, seq, text):
        """Push to the channel's live connection (its daemon may reconnect while the runtime finishes booting)."""
        frame = json.dumps({"type": "user_message", "seq": seq,
                            "text": json.dumps({"hive": 1, "sender": "user:jon", "conversation_id": "c-1", "text": text})})
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                self.hub.connections[-1].send(frame)
                return
            except Exception:
                time.sleep(0.5)
        self.fail(self._tail("no live hub connection to deliver on"))

    def test_a_chosen_wait_makes_no_calls_until_input_or_expiry(self):
        model = FakeModel("wait 30 nothing owed, waiting for Jon")
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
        self._pin_shape('((wait "30 nothing owed, waiting for Jon"))', 30)

    @staticmethod
    def _rests(model):
        """The rest checks the loop sent (hive_commons.rest_check -> POST /api/agent/replies/rest): (time, path, body)."""
        with model.lock:
            return [p for p in model.posts if p[1].endswith("/api/agent/replies/rest")]

    def test_a_mind_whose_turns_run_out_tells_the_hive_once(self):
        """v0.29: asked for a flow, a mind spent the turns its message bought without answering, then stopped calling
        its model with no wait, so the hive could neither remind it nor tell the person. The loop now reports that rest
        once, after its last turn, and not again while it stays idle."""
        model = FakeModel('pin "still drafting the flow, nothing to say yet"')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, "make a flow that says hello to me")
        self._await_runtime(lambda: self._rests(model), "the spent turns were never reported", 150)
        calls, last_call = model.count(), model.calls[-1]
        self.assertGreater(calls, 1, self._tail("a message buys more than one turn"))
        [(at, _path, body)] = self._rests(model)
        self.assertGreater(at, last_call, self._tail("reported before the last turn"))
        self.assertEqual(body, {"in_flight": []})
        time.sleep(9)   # three more idle iterations (sleepInterval 3 s)
        self.assertEqual((model.count(), len(self._rests(model))), (calls, 1),
                         self._tail("the idle loop called its model or reported again"))

    def test_a_chosen_wait_tells_the_hive_once_and_not_again_while_it_waits(self):
        model = FakeModel("wait 30 nothing owed, waiting for Jon")
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, "rest until I write again")
        self._await_runtime(lambda: self._rests(model), "the chosen wait was never reported", 60)
        self.assertEqual(model.count(), 1)
        self.assertLess(self._rests(model)[0][0] - model.calls[0], 20, self._tail("reported only when the wait ended"))
        time.sleep(9)
        self.assertEqual(len(self._rests(model)), 1, self._tail("reported again during the wait"))

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

    def test_a_malformed_response_retries_soon_without_executing_its_valid_prefix(self):
        model = FakeModel('send "INVENTED_PREFIX_MUST_NOT_RUN"\nread-file')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'try an invented malformed response')
        self.assertTrue(wait_for(lambda: model.count() >= 2, timeout=30), self._tail('no short format retry'))
        elapsed = model.calls[1] - model.calls[0]
        self.assertGreaterEqual(elapsed, 1)
        self.assertLess(elapsed, 15)
        shapes, _ = self._response_shapes()
        self.assertTrue(shapes, self._tail('no parsed response'))
        self.assertTrue(all(row.startswith('((wait "LLM-FORMAT-ERROR') for row in shapes), self._tail('wrong response category'))
        self.assertNotIn('INVENTED_PREFIX_MUST_NOT_RUN', '\n'.join(shapes))
        frames = []
        while not self.hub.received.empty():
            frames.append(self.hub.received.get_nowait())
        self.assertNotIn('INVENTED_PREFIX_MUST_NOT_RUN', json.dumps(frames))
        print(f'native PeTTa malformed-response retry interval: {elapsed:.3f}s; prefix was not sent')

    def test_malformed_tool_call_retries_without_outage_delay(self):
        model = FakeModel('unused', malformed=True)
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'format retry test')
        self.assertTrue(wait_for(lambda: model.count() >= 2, timeout=25), self._tail('format error did not retry'))
        with model.lock:
            elapsed = model.calls[1] - model.calls[0]
        self.assertGreaterEqual(elapsed, 1)
        self.assertLess(elapsed, 15)
        self.assertTrue(any('LLM-FORMAT-ERROR' in row for row in self._response_shapes()[0]), self._tail('wrong error category'))
        self.assertEqual(self._rests(model), [], self._tail('a runtime retry was reported as the mind resting'))

    def test_a_format_failure_keeps_the_last_results_in_the_next_prompt(self):
        # The Code helper read its file, then sent a reply the runtime refused. Before, the refusal's own wait became
        # LAST_SKILL_USE_RESULTS, so the helper read the file again before every retry.
        self._assert_failure_keeps_last_results('read-file "unterminated', 'LLM-FORMAT-ERROR', 60)

    def test_a_provider_failure_keeps_the_last_results_in_the_next_prompt(self):
        # A refused call (the helper's 402 at its cap, an outage) ran nothing either; the retry comes after 60 s.
        self._assert_failure_keeps_last_results(402, 'LLM-PROVIDER-ERROR', 120)

    def _assert_failure_keeps_last_results(self, failing_answer, marker, timeout):
        model = FakeModel(['send "KEEP_RESULTS_MARKER"', failing_answer, 'wait 900 done'])
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'keep the last results across a failed turn')
        self.assertTrue(wait_for(lambda: model.count() >= 3, timeout=timeout), self._tail('no retry after the failure'))
        with model.lock:
            third = model.bodies[2]
        system = next(m["content"] for m in third["messages"] if m["role"] == "system")
        last = system.split("LAST_SKILL_USE_RESULTS: ", 1)[1].split(" CURRENT_INPUT:", 1)[0]
        self.assertIn("KEEP_RESULTS_MARKER", last, self._tail("the failed turn replaced the last results"))
        self.assertNotIn(marker, last)
        self.assertTrue(any(marker in row for row in self._response_shapes()[0]), self._tail('no failed turn'))

    def test_a_message_after_another_command_waits_for_that_commands_result(self):
        # Jon on omega-flagship/omegahive#334: "a mind should report a result only after it comes back. The extra turn
        # is fine." The first reply remembers and announces it in one go; the announcement is held, the next turn's
        # results carry it beside the remember's result, and the person gets only the message sent after that.
        model = FakeModel(['remember "HELD_LESSON"\nsend "HELD_TOO_SOON"', 'send "SENT_AFTER_RESULTS"', 'wait 900 done'])
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'remember this and tell me')
        self.assertTrue(wait_for(lambda: model.count() >= 3, timeout=180), self._tail('no third turn'))
        with model.lock:
            second = model.bodies[1]
        system = next(m["content"] for m in second["messages"] if m["role"] == "system")
        last = system.split("LAST_SKILL_USE_RESULTS: ", 1)[1].split(" CURRENT_INPUT:", 1)[0]
        for seen in ("REMEMBER-SUCCESS", "held-message", "HELD_TOO_SOON", "NOT SENT"):
            self.assertIn(seen, last, self._tail(f"{seen} missing from the next turn's results"))
        sent = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and "SENT_AFTER_RESULTS" not in sent:
            try:
                frame = self.hub.next_frame(timeout=1)
            except Exception:
                continue
            if frame.get("type") == "agent_message":
                sent.append(frame.get("text"))
        self.assertEqual(sent, ["SENT_AFTER_RESULTS"], self._tail("the person got a held message, or not the later one"))

    def test_a_provider_error_wait_retries_after_a_short_back_off(self):
        """Kimi r1 K8: with no usable provider the runtime answers its own wait "LLM-PROVIDER-..."; that is not the
        mind's choice, so it is tried again after 60 s, not after the full wake interval (900 s), and not every 3 s."""
        model = FakeModel("unused")
        self.addCleanup(model.shutdown)
        self._boot(model, provider="NoSuchProvider")
        self._message(1, "are you there?")
        responses = lambda: self._response_shapes()[0]
        self._await_runtime(lambda: len(responses()) >= 1, "the message never got a turn", 60)
        first = time.monotonic()
        self.assertTrue(responses()[0].startswith('((wait "LLM-PROVIDER-UNKNOWN'), self._tail("not the provider wait"))
        time.sleep(45)
        self.assertEqual(len(responses()), 1, self._tail("retried before the back-off"))
        self.assertTrue(wait_for(lambda: len(responses()) >= 2, timeout=40), self._tail("no retry after the back-off"))
        self.assertGreaterEqual(time.monotonic() - first, 55)
        time.sleep(9)
        self.assertEqual(len(responses()), 2, self._tail("the retry did not rest again"))
        self.assertEqual(model.count(), 0)

    def test_persistent_incomplete_batches_exhaust_three_fast_retries_across_wakes(self):
        model = FakeModel('send "INVENTED_PREFIX_MUST_NOT_RUN"\nread-file "unterminated_quote_')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'try an invented persistently incomplete batch')
        self._await_runtime(lambda: model.count() >= 4, 'three fast retries did not happen', 45)
        time.sleep(15)
        self.assertEqual(model.count(), 4, self._tail('format retry budget did not survive the wake'))
        shapes, _ = self._response_shapes()
        self.assertTrue(all(row.startswith('((wait "LLM-FORMAT-ERROR') for row in shapes), self._tail('raw repair admitted a command'))
        frames = []
        while not self.hub.received.empty():
            frames.append(self.hub.received.get_nowait())
        self.assertNotIn('INVENTED_PREFIX_MUST_NOT_RUN', json.dumps(frames))
        print('native PeTTa mixed literal/encoded quote failure: exactly4 calls, then ordinary wake; no prefix sent')

    def test_spent_format_retries_tell_the_hive_once(self):
        """On the v0.30 candidate a mind asked for a code mind sent four malformed batches in a row, rested and made no
        call for twelve minutes, and the hive never learnt it had stopped, so the person got neither the reminder nor
        the note. The three short retries are still no rest; the fourth failure's rest is reported once, after it."""
        model = FakeModel('send "INVENTED_PREFIX_MUST_NOT_RUN"\nread-file "unterminated_quote_')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'try an invented persistently incomplete batch')
        self._await_runtime(lambda: self._rests(model), 'the spent format retries were never reported', 60)
        with model.lock:
            calls = list(model.calls)
        [(at, _path, body)] = self._rests(model)
        self.assertEqual(len(calls), 4, self._tail('the rest came before the fourth failure'))
        self.assertGreater(at, calls[3], self._tail('reported before the fourth failure'))
        self.assertEqual(body, {"in_flight": []})
        time.sleep(9)   # three more idle iterations (sleepInterval 3 s)
        self.assertEqual((model.count(), len(self._rests(model))), (4, 1),
                         self._tail('the resting mind called its model or reported again'))

    def test_model_authored_format_marker_does_not_grant_a_fast_wake(self):
        model = FakeModel('wait "LLM-FORMAT-ERROR invented model text"')
        self.addCleanup(model.shutdown)
        self._boot(model)
        self._message(1, 'choose an invented marker-shaped wait')
        self._await_runtime(lambda: model.count() >= 1, 'no model call', 30)
        time.sleep(15)
        self.assertEqual(model.count(), 1, self._tail('model text spoofed runtime retry credit'))
        self._pin_shape('((wait "LLM-FORMAT-ERROR invented model text"))', 0)
        print('native PeTTa model-authored format marker: ordinary wait, one call only')

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
