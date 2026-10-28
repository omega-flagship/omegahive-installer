"""Hive channel daemon and agent-side facade against a local agent hub."""

import importlib.util
import json
import os
import pathlib
import queue
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "modules" / "channel_hive" / "src" / "hive_channel.py"
ROUTER_SRC = ROOT / "modules" / "channel_router" / "src"

try:
    from websockets.sync.server import serve
except ImportError:  # pragma: no cover
    serve = None


def load_channel():
    spec = importlib.util.spec_from_file_location("hive_channel_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_for(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class FakeHub:
    """Minimal agent hub: records frames, lets the test push user messages."""

    def __init__(self, port=0):
        self.received = queue.Queue()
        self.tokens = []
        self.connections = []
        self.server = serve(self._handler, "127.0.0.1", port)
        self.port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def _handler(self, ws):
        self.tokens.append(ws.request.headers.get("Authorization"))
        self.connections.append(ws)
        try:
            for raw in ws:
                self.received.put(json.loads(raw))
        except Exception:
            pass

    def push(self, seq, text):
        self.connections[-1].send(json.dumps({"type": "user_message", "seq": seq, "text": text}))

    def next_frame(self, timeout=10.0):
        return self.received.get(timeout=timeout)

    def drop_clients(self):
        for ws in list(self.connections):
            try:
                ws.close()
            except Exception:
                pass

    def shutdown(self):
        self.drop_clients()
        self.server.shutdown()


@unittest.skipIf(serve is None, "websockets is not installed")
class HiveChannelTests(unittest.TestCase):
    def setUp(self):
        self.memory = tempfile.mkdtemp(prefix="hive-channel-mem-")
        self._old_memory = os.environ.get("OMEGACLAW_MEMORY_DIR")
        os.environ["OMEGACLAW_MEMORY_DIR"] = self.memory
        self.channel = load_channel()
        self.hub = FakeHub()
        self.url = f"ws://127.0.0.1:{self.hub.port}"

    def tearDown(self):
        self.channel.stop_hive()
        pid_file = pathlib.Path(self.memory) / "hive" / "daemon.pid"
        if pid_file.exists():
            pid = json.loads(pid_file.read_text())["pid"]
            wait_for(lambda: not self.channel._pid_alive(pid), timeout=5)
        self.hub.shutdown()
        if self._old_memory is None:
            os.environ.pop("OMEGACLAW_MEMORY_DIR", None)
        else:
            os.environ["OMEGACLAW_MEMORY_DIR"] = self._old_memory
        shutil.rmtree(self.memory, ignore_errors=True)

    def connect(self, expected_resume=None):
        self.assertIn("HIVE-CHANNEL-STARTED", self.channel.start_hive(self.url, "agent-token"))
        self.assertEqual(self.hub.next_frame(), {"type": "resume", "last_seen_seq": expected_resume})
        self.assertTrue(wait_for(lambda: "connected=true" in self.channel.status()))

    def test_disabled_without_url(self):
        os.environ.pop("HIVE_WS_URL", None)
        self.assertIn("HIVE-CHANNEL-DISABLED", self.channel.start_hive("", ""))

    def test_bearer_token_resume_and_single_daemon(self):
        self.connect()
        self.assertEqual(self.hub.tokens[-1], "Bearer agent-token")
        self.assertIn("HIVE-CHANNEL-ALREADY-RUNNING", self.channel.start_hive(self.url, "agent-token"))

    def test_plain_messages_are_batched_and_deduplicated(self):
        self.connect()
        self.hub.push(1, "hello")
        self.hub.push(2, "again")
        self.hub.push(2, "again")  # replayed duplicate
        self.hub.push(1, "old replay")
        self.assertTrue(wait_for(lambda: "received=2" in self.channel.status()))
        time.sleep(0.3)
        self.assertEqual(self.channel.getLastMessage(), "hello\n\nagain")
        self.assertEqual(self.channel.getLastMessage(), "")

    def test_envelope_becomes_channel_event_and_reply_carries_conversation(self):
        sys.path.insert(0, str(ROUTER_SRC))
        try:
            self.connect()
            envelope = {"hive": 1, "sender": "user:quinn", "conversation_id": "c-42", "text": "status?"}
            self.hub.push(1, json.dumps(envelope))
            self.assertTrue(wait_for(lambda: "received=1" in self.channel.status()))
            block = self.channel.getLastMessage()
            self.assertTrue(block.startswith("CHANNEL_EVENT"), block)
            self.assertIn("channel=hive", block)
            self.assertIn("sender=user:quinn", block)
            self.assertIn("text=status?", block)

            self.assertEqual(self.channel.send_message("all good"), "HIVE-MESSAGE-QUEUED")
            reply = self.hub.next_frame()
            self.assertEqual(reply["type"], "agent_message")
            self.assertEqual(reply["text"], "all good")
            self.assertEqual(reply["conversation_id"], "c-42")
            self.assertTrue(reply["client_seq"])
        finally:
            sys.path.remove(str(ROUTER_SRC))

    def test_messages_queued_while_disconnected_are_flushed_after_resume(self):
        self.connect()
        self.hub.push(5, "before drop")
        self.assertTrue(wait_for(lambda: "received=1" in self.channel.status()))
        self.assertEqual(self.channel.getLastMessage(), "before drop")

        self.hub.drop_clients()
        self.assertTrue(wait_for(lambda: "connected=false" in self.channel.status()))
        self.channel.send_message("queued while offline")

        self.assertEqual(self.hub.next_frame(timeout=15), {"type": "resume", "last_seen_seq": 5})
        self.assertEqual(self.hub.next_frame()["text"], "queued while offline")

    def test_restarted_daemon_resumes_from_persisted_sequence(self):
        self.connect()
        self.hub.push(7, "seen before sleep")
        self.assertTrue(wait_for(lambda: "received=1" in self.channel.status()))
        self.channel.stop_hive()
        self.assertTrue(wait_for(lambda: "daemon=down" in self.channel.status()))

        self.connect(expected_resume=7)
        self.assertEqual(self.channel.getLastMessage(), "seen before sleep")

    def test_daemon_left_by_another_agent_process_is_replaced(self):
        self.connect()
        folder = pathlib.Path(self.memory) / "hive"
        record = json.loads((folder / "daemon.pid").read_text())
        record["owner"] = 1  # pretend a previous agent process started it
        (folder / "daemon.pid").write_text(json.dumps(record))
        started = self.channel.start_hive(self.url, "agent-token")
        self.assertIn("HIVE-CHANNEL-STARTED", started)
        self.assertFalse(self.channel._pid_alive(record["pid"]))
        self.assertTrue(wait_for(lambda: "connected=true" in self.channel.status(), timeout=10))

    # ---- mind control over the socket: the child's own prompt_ack, only after admission (r2.12 §3) ------------

    def prompt(self, seq, rev, mode="queued", child="a_child001", text="do the thing"):
        self.hub.push(seq, json.dumps({"hive": 1, "sender": "agent:a_lead", "conversation_id": "c_a_child001", "text": text,
                                       "mind_prompt": {"child_id": child, "rev": rev, "mode": mode}}))

    def no_frame(self, wait=0.6):
        try:
            frame = self.hub.next_frame(timeout=wait)
        except queue.Empty:
            return True
        self.fail(f"unexpected frame {frame}")

    def answer(self, rev, status):
        self.hub.connections[-1].send(json.dumps({"type": "prompt_ack", "rev": rev, "acknowledged": status == "acknowledged",
                                                  "status": status}))

    def setUp_identity(self):
        self._old_id = os.environ.get("HIVE_AGENT_ID")
        os.environ["HIVE_AGENT_ID"] = "a_child001"         # the supervisor sets this for every native mind
        self.addCleanup(lambda: os.environ.pop("HIVE_AGENT_ID", None) if self._old_id is None
                        else os.environ.__setitem__("HIVE_AGENT_ID", self._old_id))

    def test_a_prompt_is_acknowledged_only_after_the_agent_admits_it(self):
        self.setUp_identity()
        self.connect()
        self.prompt(1, 1)
        self.assertTrue(wait_for(lambda: "received=1" in self.channel.status()))
        self.no_frame()                                                      # receipt by the daemon is not an ack
        block = self.channel.getLastMessage()
        self.assertIn("mind_prompt_rev=1", block)
        self.assertIn("mind_prompt_mode=queued", block)
        self.assertIn("do the thing", block)
        self.assertEqual(self.hub.next_frame(), {"type": "prompt_ack", "child_id": "a_child001", "rev": 1})

    def test_a_foreign_prompt_is_never_published_or_acknowledged(self):
        self.setUp_identity()
        self.connect()
        self.prompt(1, 1, child="a_someone_else", text="FOREIGN")
        self.hub.push(2, "plain hello")
        self.assertTrue(wait_for(lambda: "received=2" in self.channel.status()))
        block = self.channel.getLastMessage()
        self.assertNotIn("FOREIGN", block)
        self.assertEqual(block, "plain hello")
        self.no_frame()

    def test_each_revision_is_acknowledged_alone_and_never_applied_twice(self):
        self.setUp_identity()
        self.connect()
        self.prompt(1, 1, text="first")
        self.prompt(2, 2, mode="steer", text="second")
        self.assertTrue(wait_for(lambda: "received=2" in self.channel.status()))
        block = self.channel.getLastMessage()
        self.assertLess(block.index("first"), block.index("second"))          # hub sequence order = host revision order
        self.assertIn("mind_prompt_mode=steer", block)
        self.assertEqual(sorted(self.hub.next_frame()["rev"] for _ in range(2)), [1, 2])
        self.prompt(3, 2, text="second")                                     # the same revision arrives again
        self.assertTrue(wait_for(lambda: "received=3" in self.channel.status()))
        self.assertEqual(self.channel.getLastMessage(), "")                  # not handed to the agent twice
        self.no_frame()                                                      # its ack is already out on this connection

    def test_acks_are_resent_after_a_reconnect_until_the_hub_confirms_and_refusals_are_kept_apart(self):
        self.setUp_identity()
        self.connect()
        self.prompt(1, 1)
        self.prompt(2, 2)
        self.assertTrue(wait_for(lambda: "received=2" in self.channel.status()))
        self.channel.getLastMessage()
        self.assertEqual(sorted(self.hub.next_frame()["rev"] for _ in range(2)), [1, 2])   # the hub never answered
        self.hub.drop_clients()
        self.assertEqual(self.hub.next_frame(timeout=15), {"type": "resume", "last_seen_seq": 2})
        self.assertEqual(sorted(self.hub.next_frame()["rev"] for _ in range(2)), [1, 2])   # lost: sent again
        self.answer(1, "duplicate")
        self.answer(2, "refused")
        folder = pathlib.Path(self.memory) / "hive"
        self.assertTrue(wait_for(lambda: (folder / "refused.json").exists() and (folder / "confirmed.json").exists()))
        self.assertEqual(json.loads((folder / "confirmed.json").read_text()), [1])          # duplicate = the hub has it
        self.assertEqual(json.loads((folder / "refused.json").read_text()), [2])            # refused is not "accepted"
        self.no_frame()                                                                     # no retry storm on this connection
        self.hub.drop_clients()
        self.assertEqual(self.hub.next_frame(timeout=15), {"type": "resume", "last_seen_seq": 2})
        self.assertEqual(self.hub.next_frame(), {"type": "prompt_ack", "child_id": "a_child001", "rev": 2})
        self.no_frame()

    def test_a_retained_prompt_survives_a_daemon_restart_and_is_acknowledged_once_admitted(self):
        self.setUp_identity()
        self.connect()
        self.prompt(4, 1)
        self.assertTrue(wait_for(lambda: "received=1" in self.channel.status()))
        self.channel.stop_hive()                                             # before the agent read it
        self.assertTrue(wait_for(lambda: "daemon=down" in self.channel.status()))
        self.connect(expected_resume=4)
        self.no_frame()
        self.assertIn("mind_prompt_rev=1", self.channel.getLastMessage())
        self.assertEqual(self.hub.next_frame()["rev"], 1)


class AdmissionTests(unittest.TestCase):
    """getLastMessage's admission (Review B3 identity, B4 durability) without a daemon: invented inboxes, real functions."""

    OWN = "a_own_child"

    def setUp(self):
        self.memory = tempfile.mkdtemp(prefix="hive-admission-")
        self.saved = {k: os.environ.get(k) for k in ("OMEGACLAW_MEMORY_DIR", "HIVE_AGENT_ID")}
        os.environ["OMEGACLAW_MEMORY_DIR"] = self.memory
        os.environ["HIVE_AGENT_ID"] = self.OWN
        self.channel = load_channel()
        self.folder = pathlib.Path(self.memory) / "hive"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.seq = 0

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        shutil.rmtree(self.memory, ignore_errors=True)

    def push(self, text):
        self.seq += 1
        with open(self.folder / "inbox.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"seq": self.seq, "text": text}) + "\n")

    def prompt(self, rev, child=None, text="INSTRUCTION", mode="queued", meta=None):
        meta = {"child_id": child or self.OWN, "rev": rev, "mode": mode} if meta is None else meta
        self.push(json.dumps({"hive": 1, "sender": "agent:a_lead", "conversation_id": "c_x", "text": text, "mind_prompt": meta}))

    def state(self):
        return json.loads((self.folder / "admission.json").read_text())

    def admitted(self):
        return [(a[0], a[1]) for a in self.state()["admitted"]]

    # B3: identity

    def test_own_prompt_and_ordinary_messages_pass(self):
        self.prompt(1)
        self.push("plain")
        out = self.channel.getLastMessage()
        self.assertIn("INSTRUCTION", out)
        self.assertIn("mind_prompt_rev=1", out)
        self.assertTrue(out.endswith("plain"))
        self.assertEqual(self.admitted(), [(self.OWN, 1)])

    def test_foreign_unbound_and_malformed_prompts_never_become_input_or_admission(self):
        cases = [dict(child="a_foreign_child"), dict(meta={"child_id": "", "rev": 1, "mode": "queued"}),
                 dict(meta={"child_id": self.OWN, "rev": 0, "mode": "queued"}), dict(meta={"child_id": self.OWN, "rev": True, "mode": "queued"}),
                 dict(meta={"child_id": self.OWN, "rev": 1, "mode": "shout"}), dict(meta=[]), dict(meta={})]
        for i, case in enumerate(cases):
            self.prompt(i + 1, text=f"BAD{i}", **case)
        self.push(json.dumps({"hive": 1, "sender": "x", "text": "NULLMETA", "mind_prompt": None}))
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual(self.admitted(), [])
        os.environ.pop("HIVE_AGENT_ID")                                       # unbound process: even its "own" id is refused
        self.prompt(9, child=self.OWN, text="UNBOUND")
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual(self.admitted(), [])

    # B4: durability

    def test_an_admission_write_fault_advances_nothing_and_the_instruction_is_read_next_time(self):
        self.prompt(1)
        original = self.channel._write_json

        def faulty(path, value):
            if str(path).endswith("admission.json"):
                raise OSError("disk full (invented)")
            return original(path, value)
        self.channel._write_json = faulty
        with self.assertRaises(OSError):
            self.channel.getLastMessage()
        self.assertFalse((self.folder / "admission.json").exists())          # no cursor, no admission, so no ACK
        self.channel._write_json = original
        self.assertIn("INSTRUCTION", self.channel.getLastMessage())
        self.assertEqual(self.admitted(), [(self.OWN, 1)])

    def test_a_fault_on_a_later_commit_keeps_the_earlier_batch_and_reads_the_new_one_again(self):
        self.prompt(1, text="ONE")
        self.assertIn("ONE", self.channel.getLastMessage())
        self.prompt(2, text="TWO")
        original = self.channel._write_json
        self.channel._write_json = lambda path, value: (_ for _ in ()).throw(OSError("invented")) \
            if str(path).endswith("admission.json") else original(path, value)
        with self.assertRaises(OSError):
            self.channel.getLastMessage()
        self.channel._write_json = original
        out = self.channel.getLastMessage()
        self.assertIn("TWO", out)
        self.assertNotIn("ONE", out)                                        # the same process consumed ONE
        self.assertEqual(self.admitted(), [(self.OWN, 1), (self.OWN, 2)])

    def test_a_consumer_that_dies_after_return_gets_the_batch_again_after_restart_once(self):
        from unittest import mock
        self.prompt(1, text="LOSTONCE")
        with mock.patch.object(self.channel.os, "getpid", return_value=111):
            self.assertIn("LOSTONCE", self.channel.getLastMessage())       # returned, then the process died
        with mock.patch.object(self.channel.os, "getpid", return_value=222):
            again = self.channel.getLastMessage()
            self.assertIn("LOSTONCE", again)
            self.assertIn("redelivered=1", again)
            self.assertEqual(self.channel.getLastMessage(), "")            # this process came back: consumed
        self.assertEqual(self.admitted(), [(self.OWN, 1)])                  # admitted once, never twice

    def test_an_altered_duplicate_is_refused_not_published(self):
        self.prompt(1, text="ORIGINAL")
        self.channel.getLastMessage()
        self.prompt(1, text="ALTERED")
        self.prompt(1, text="ORIGINAL")
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual(len(self.state()["conflicts"]), 1)
        self.assertEqual(self.admitted(), [(self.OWN, 1)])

    def test_corrupt_admission_state_fails_closed_and_is_visible(self):
        self.prompt(1)
        (self.folder / "admission.json").write_text("{not json")
        with self.assertRaises(self.channel.AdmissionCorrupt):
            self.channel.getLastMessage()
        self.assertIn("admission=corrupt", self.channel.status())
        self.assertEqual((self.folder / "admission.json").read_text(), "{not json")   # nothing guessed or overwritten

    def test_the_legacy_cursor_is_honoured(self):
        self.push("already read before the upgrade")
        (self.folder / "inbox.offset").write_text(json.dumps((self.folder / "inbox.jsonl").stat().st_size))
        self.push("new")
        self.assertEqual(self.channel.getLastMessage(), "new")

    def test_the_daemon_acks_only_admitted_revisions_once_per_connection(self):
        self.prompt(1)
        self.prompt(2, child="a_foreign_child")
        self.channel.getLastMessage()
        daemon = self.channel._Daemon(self.folder, "ws://invented", "", 0)
        sent = []
        ws = type("WS", (), {"send": lambda _self, frame: sent.append(json.loads(frame))})()
        daemon.acked = set()
        daemon.send_acks(ws)
        daemon.send_acks(ws)
        self.assertEqual(sent, [{"type": "prompt_ack", "child_id": self.OWN, "rev": 1}])
        daemon.deliver({"type": "prompt_ack", "rev": 1, "acknowledged": True, "status": "acknowledged"})
        daemon.acked = set()                                                 # a new connection
        daemon.send_acks(ws)
        self.assertEqual(len(sent), 1)                                       # confirmed: never again

    # B5: retention beyond ADMITTED_KEEP

    def confirm(self, revs, bulk=False):
        """The hub's acknowledged answers through the real daemon; bulk writes the same confirmed.json in one step."""
        if bulk:
            path = self.folder / "confirmed.json"
            old = json.loads(path.read_text()) if path.exists() else []
            path.write_text(json.dumps(sorted(set(old) | set(revs))))
            return
        daemon = self.channel._Daemon(self.folder, "ws://invented", "", 0)
        for rev in revs:
            daemon.deliver({"type": "prompt_ack", "rev": rev, "acknowledged": True, "status": "acknowledged"})

    def acks_on_a_new_connection(self):
        daemon = self.channel._Daemon(self.folder, "ws://invented", "", 0)
        sent = []
        daemon.send_acks(type("WS", (), {"send": lambda _self, frame: sent.append(json.loads(frame)["rev"])})())
        return sent

    def test_review_b5_probe_an_old_altered_revision_is_not_admitted_again(self):
        # Review's probe (receipts-local/omegareview-mind-control-60f4e46/review-retention.py), unchanged in substance.
        c, f = self.channel, self.channel.channel_dir()
        os.environ["HIVE_AGENT_ID"] = "own"

        def push(rev, text):
            envelope = json.dumps({"hive": 1, "text": text, "mind_prompt": {"child_id": "own", "rev": rev, "mode": "queued"}})
            with (f / "inbox.jsonl").open("a") as h:
                h.write(json.dumps({"seq": (c.ADMITTED_KEEP + 2 if text == "ALTERED OLD REVISION" else rev), "text": envelope}) + "\n")
        for rev in range(1, c.ADMITTED_KEEP + 2):
            push(rev, "original")
        c.getLastMessage()
        c.getLastMessage()
        push(1, "ALTERED OLD REVISION")
        result = c.getLastMessage()
        self.assertNotIn("ALTERED OLD REVISION", result, "evicted revision admitted again with changed body")

    def fill_past_the_cache(self):
        last = self.channel.ADMITTED_KEEP + 5
        for rev in range(1, last + 1):
            self.prompt(rev, text=f"ORIGINAL {rev}")
        self.assertIn(f"ORIGINAL {last}", self.channel.getLastMessage())
        self.confirm(range(1, last + 1), bulk=True)
        self.prompt(last + 1, text="NEWEST")
        self.assertIn("NEWEST", self.channel.getLastMessage())           # commits the big batch; compaction runs
        self.confirm([last + 1])
        return last + 1

    def test_old_identical_and_altered_duplicates_are_refused_after_compaction_and_after_restart(self):
        from unittest import mock
        newest = self.fill_past_the_cache()
        state = self.state()
        self.assertLessEqual(len(state["admitted"]), self.channel.ADMITTED_KEEP)
        self.assertEqual(state["archived"], {self.OWN: [[1, newest - self.channel.ADMITTED_KEEP]]})
        self.assertNotIn((self.OWN, 1), self.admitted())                     # its digest was compacted
        self.prompt(1, text="ORIGINAL 1")
        self.prompt(1, text="ALTERED OLD REVISION")
        self.prompt(2, text="ORIGINAL 2")
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual([r[:2] for r in self.state()["archived_repeats"]], [[self.OWN, 1], [self.OWN, 1], [self.OWN, 2]])
        # a different process on a freshly loaded module (restart), reading the same durable state
        self.channel = load_channel()
        with mock.patch.object(self.channel.os, "getpid", return_value=424242):
            self.prompt(1, text="ALTERED AFTER RESTART")
            self.prompt(3, text="ORIGINAL 3")
            self.prompt(newest, text="ALTERED NEWEST")
            self.prompt(newest + 1, text="NEXT")
            out = self.channel.getLastMessage()
        self.assertNotIn("ALTERED", out)
        self.assertNotIn("ORIGINAL 3", out)
        self.assertIn("NEXT", out)
        self.assertEqual(self.state()["conflicts"][-1][:2], [self.OWN, newest])      # still comparable: a conflict
        self.assertEqual(self.state()["archived"], {self.OWN: [[1, newest + 1 - self.channel.ADMITTED_KEEP]]})
        self.assertEqual(len(self.admitted()), self.channel.ADMITTED_KEEP)           # NEXT is pending, so it stays

    def test_unconfirmed_revisions_are_never_compacted_so_their_ack_stays_pending(self):
        last = self.channel.ADMITTED_KEEP + 20
        for rev in range(1, last + 1):
            self.prompt(rev)
        self.channel.getLastMessage()
        self.confirm((r for r in range(1, last + 1) if r not in (5, 7)), bulk=True)      # the hub never answered 5 and 7
        self.prompt(last + 1)
        self.channel.getLastMessage()
        admitted = self.admitted()
        self.assertIn((self.OWN, 5), admitted)
        self.assertIn((self.OWN, 7), admitted)
        self.assertNotIn((self.OWN, 6), admitted)
        self.assertEqual(self.state()["archived"], {self.OWN: [[1, 4], [6, 6], [8, last + 1 - self.channel.ADMITTED_KEEP + 2]]})
        self.assertEqual(self.acks_on_a_new_connection(), [5, 7, last + 1])  # pending ACKs survive compaction
        self.confirm([5, 7, last + 1])
        self.assertEqual(self.acks_on_a_new_connection(), [])
        self.prompt(5, text="ALTERED")
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual(self.state()["conflicts"][-1][:2], [self.OWN, 5])

    def test_with_no_confirmation_at_all_nothing_is_compacted_or_forgotten(self):
        last = self.channel.ADMITTED_KEEP + 3
        for rev in range(1, last + 1):
            self.prompt(rev, text="ORIGINAL")
        self.channel.getLastMessage()
        self.channel.getLastMessage()
        self.assertEqual(len(self.admitted()), last)
        self.assertEqual(self.state()["archived"], {})
        self.prompt(1, text="ALTERED")
        self.prompt(1, text="ORIGINAL")
        self.assertEqual(self.channel.getLastMessage(), "")
        self.assertEqual(len(self.state()["conflicts"]), 1)
        self.assertEqual(len(self.acks_on_a_new_connection()), last)

    def test_the_in_flight_batch_survives_compaction_and_is_redelivered_after_a_restart(self):
        from unittest import mock
        keep = self.channel.ADMITTED_KEEP
        last = keep + 10
        with mock.patch.object(self.channel.os, "getpid", return_value=111):
            for rev in range(1, last + 1):
                self.prompt(rev, text=f"BODY {rev}")
            self.channel.getLastMessage()                                # handed out, then the reader died
        self.confirm(range(1, last + 1), bulk=True)                      # the hub confirmed every ACK meanwhile
        self.prompt(last + 1, text="AFTER")
        with mock.patch.object(self.channel.os, "getpid", return_value=222):
            out = self.channel.getLastMessage()
            state = self.state()
            self.assertIn("redelivered=1", out)
            self.assertIn("BODY 1\n", out + "\n")
            self.assertIn("AFTER", out)
            self.assertEqual(len(state["inflight"]["records"]), last + 1)
            self.assertEqual(state["archived"], {})                      # confirmed but in custody: none compacted
            self.assertEqual(len(self.admitted()), last + 1)
            self.assertEqual(self.channel.getLastMessage(), "")          # came back: the batch is committed
        self.assertEqual(self.state()["inflight"], None)
        self.assertEqual(self.state()["archived"], {self.OWN: [[1, last + 1 - keep]]})
        self.assertEqual(len(self.admitted()), keep)
        self.assertIn((self.OWN, last + 1), self.admitted())             # AFTER's ACK is still pending
        self.prompt(1, text="BODY 1")
        self.assertEqual(self.channel.getLastMessage(), "")              # and the compacted revision stays refused

    def test_the_daemon_keeps_every_confirmation_admission_still_holds(self):
        last = self.channel.ADMITTED_KEEP + 30
        for rev in range(1, last + 1):
            self.prompt(rev)
        self.channel.getLastMessage()
        self.confirm(range(1, last + 1))
        self.assertEqual(json.loads((self.folder / "confirmed.json").read_text()), list(range(1, last + 1)))
        self.assertEqual(self.acks_on_a_new_connection(), [])                # no old revision re-ACKed forever
        self.prompt(last + 1)
        self.channel.getLastMessage()                                        # commits; compaction runs
        self.confirm([last + 1])                                             # the next answer prunes confirmed.json
        self.assertLess(len(self.admitted()), last)
        kept = json.loads((self.folder / "confirmed.json").read_text())
        self.assertEqual(kept, [a[1] for a in self.state()["admitted"]])     # only what admission still holds


if __name__ == "__main__":
    unittest.main()
