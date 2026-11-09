"""The hub sends a mind its stored messages once each and in hub_seq order (port of upstream omegahive#21, #18).

The channel keeps last_seen_seq as a high-water mark (hive_channel.py, _Daemon.deliver), so a seq that arrives after a
higher one is dropped for good. The first two tests are upstream's. The Studio ones are ours: a message Studio holds
during a handoff stops the flush (nothing newer may overtake it) and goes, in order, on Studio's release; a
never-delivered notice (R8.5) is passed over without blocking what follows. Synthetic data only."""
import asyncio
import json

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_a_mind_gets_each_message_once_and_in_hub_order_around_its_resume(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "before"})           # seq 1, stored while offline
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        ws.send_text(json.dumps({"type": "barrier"}))    # answered only once the hub has registered this socket
        assert json.loads(ws.receive_text())["code"] == "unknown_type"
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "live one"})     # seq 2
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "live two"})     # seq 3
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        got = [json.loads(ws.receive_text()) for _ in range(3)]
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "after"})        # seq 4, live
        got.append(json.loads(ws.receive_text()))
        ws.send_text(json.dumps({"type": "agent_message", "client_seq": "r18", "text": "done"}))
        last = json.loads(ws.receive_text())
    assert [(f["type"], f["seq"], json.loads(f["text"])["text"]) for f in got] == [
        ("user_message", 1, "before"), ("user_message", 2, "live one"), ("user_message", 3, "live two"),
        ("user_message", 4, "after")]
    assert last["type"] == "ack", f"a message came twice: {last}"


def test_a_live_delivery_sends_an_older_undelivered_message_first(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        ws.send_text(json.dumps({"type": "barrier"}))
        assert json.loads(ws.receive_text())["code"] == "unknown_type"
        client.supervisor.hive.enqueue_message(a["id"], "stored, not delivered", None, "user:operator")    # seq 1
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "delivered"})                        # seq 2
        ws.send_text(json.dumps({"type": "barrier"}))
        got = []
        while (frame := json.loads(ws.receive_text()))["type"] != "error":
            got.append((frame["seq"], json.loads(frame["text"])["text"]))
    assert got == [(1, "stored, not delivered"), (2, "delivered")]


class _Studio:
    """A stand-in for Studio's two delivery checks: holds every message while `holding`; never delivers `stale` texts."""
    def __init__(self):
        self.holding, self.stale = False, set()

    def holds_messages(self, agent_id, hub_seq=None):
        return self.holding

    def stale_goal_notice(self, agent_id, message):
        return message.get("text") in self.stale

    def __getattr__(self, name):            # every other Studio hook the hub calls is a no-op here
        return lambda *a, **k: None


def _frames_until_barrier(ws):
    ws.send_text(json.dumps({"type": "barrier"}))
    got = []
    while (frame := json.loads(ws.receive_text()))["type"] != "error":
        got.append((frame["seq"], json.loads(frame["text"])["text"]))
    return got


def test_a_held_message_is_not_overtaken_and_goes_in_order_on_release(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    hive = client.supervisor.hive
    real, hive.studio = getattr(hive, "studio", None), _Studio()
    try:
        with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
            ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "one"})        # seq 1, live
            assert _frames_until_barrier(ws) == [(1, "one")]
            hive.studio.holding = True
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "held"})       # seq 2, held
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "newer"})      # seq 3, must not overtake
            assert _frames_until_barrier(ws) == []
            hive.studio.holding = False
            asyncio.run_coroutine_threadsafe(hive.release_held(a["id"]), hive.events._loop).result(5)   # Studio's release
            assert _frames_until_barrier(ws) == [(2, "held"), (3, "newer")]
    finally:
        hive.studio = real


def test_a_never_delivered_notice_is_passed_over_without_blocking(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    hive = client.supervisor.hive
    real, hive.studio = getattr(hive, "studio", None), _Studio()
    hive.studio.stale.add("stale notice")
    try:
        with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
            ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "stale notice"})   # seq 1, never sent
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "next"})           # seq 2
            assert _frames_until_barrier(ws) == [(2, "next")]
    finally:
        hive.studio = real


def test_resume_on_a_new_socket_after_a_drop_resends_what_the_mind_had_not_seen(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "one"})
        assert _frames_until_barrier(ws) == [(1, "one")]
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "while away"})          # seq 2, offline
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 1}))
        assert _frames_until_barrier(ws) == [(2, "while away")]


def test_a_studio_release_before_the_resume_never_sets_the_new_sockets_mark(client):
    """Review P1: the old socket sent up to seq 2 but the channel kept only seq 1; seq 3 was held. A new socket
    registers, Studio releases BEFORE the channel's resume: nothing goes, and the resume (last_seen 1) then sends
    2 and 3 in order. Before the fix the release set the mark to held - 1 = 2, and seq 2 was lost."""
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    hive = client.supervisor.hive
    real, hive.studio = getattr(hive, "studio", None), _Studio()
    loop = hive.events._loop
    try:
        with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
            ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "one"})
            client.post(f"/api/agents/{a['id']}/messages", json={"text": "two"})
            assert _frames_until_barrier(ws) == [(1, "one"), (2, "two")]
        hive.studio.holding = True
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "held"})            # seq 3
        with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
            ws.send_text(json.dumps({"type": "barrier"}))                                 # registered, not resumed
            assert json.loads(ws.receive_text())["code"] == "unknown_type"
            hive.studio.holding = False
            asyncio.run_coroutine_threadsafe(hive.release_held(a["id"]), loop).result(5)  # release before resume
            assert _frames_until_barrier(ws) == []
            ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 1}))              # the channel kept only 1
            assert _frames_until_barrier(ws) == [(2, "two"), (3, "held")]
    finally:
        hive.studio = real


def test_a_failed_send_stops_the_socket_so_no_later_send_can_skip_it(client):
    """Review P2: the mark is raised before a send; if that send fails and a later one on the same socket succeeded,
    the failed message would be lost. A failed send now ends the socket's live delivery; the next resume resends."""
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    hive = client.supervisor.hive

    class Flaky:
        def __init__(self):
            self.sent, self.fail_next, self.closed = [], True, False

        async def send_text(self, text):
            if self.fail_next:
                self.fail_next = False
                raise RuntimeError("transient")
            self.sent.append(json.loads(text)["seq"])

        async def close(self, code=1000):
            self.closed = True

    flaky = Flaky()
    registered, _ = hive._register_connection(a["id"], flaky, None)
    assert registered
    loop = hive.events._loop
    run = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result(5)  # noqa: E731
    run(hive.replay(a["id"], 0))
    hive.enqueue_message(a["id"], "fails", None, "user:operator")                  # seq 1
    m2 = hive.enqueue_message(a["id"], "would skip it", None, "user:operator")     # seq 2
    assert run(hive.deliver(a["id"], m2)) is False
    assert flaky.sent == [] and flaky.closed and a["id"] not in hive.sent_upto
    assert run(hive.deliver(a["id"], m2)) is False and flaky.sent == []          # nothing more goes on that socket


def test_a_concurrent_flush_cannot_overtake_an_in_flight_send_that_then_fails(client):
    """Review r1.1 P1: flush A sends seq 1 and is suspended in the send; flush B must not send seq 2 meanwhile. When A's
    send fails, the socket's live delivery ends with nothing newer sent, so the channel's resume recovers seq 1."""
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    hive = client.supervisor.hive
    loop = hive.events._loop

    class Slow:
        def __init__(self):
            self.sent, self.gate, self.closed = [], None, False

        async def send_text(self, text):
            seq = json.loads(text)["seq"]
            if seq == 1:
                self.gate = asyncio.Event()
                await self.gate.wait()
                raise RuntimeError("failed after waiting")
            self.sent.append(seq)

        async def close(self, code=1000):
            self.closed = True

    slow = Slow()
    assert hive._register_connection(a["id"], slow, None)[0]
    run = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop)  # noqa: E731
    run(hive.replay(a["id"], 0)).result(5)
    m1 = hive.enqueue_message(a["id"], "one", None, "user:operator")
    m2 = hive.enqueue_message(a["id"], "two", None, "user:operator")
    first = run(hive.deliver(a["id"], m1))
    run(asyncio.sleep(0.05)).result(5)
    second = run(hive.deliver(a["id"], m2))              # waits on the socket's flush lock
    run(asyncio.sleep(0.05)).result(5)
    assert slow.sent == []                               # nothing overtook the in-flight seq 1
    loop.call_soon_threadsafe(slow.gate.set)
    assert first.result(5) is False and second.result(5) is False
    assert slow.sent == [] and slow.closed and a["id"] not in hive.sent_upto
