"""The UI events websocket: a browser leaving is quiet, the queue is released, ping and R13 filtering hold."""

import asyncio
import concurrent.futures
import gc
import json
import logging
import threading
import time

import pytest
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocket, WebSocketDisconnect

from hive.core.events import EventBus
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

try:
    from starlette.websockets import WebSocketDisconnected
except ImportError:  # older starlette raised a plain RuntimeError
    WebSocketDisconnected = RuntimeError


def subscribers(client):
    return len(client.app.state.hive.events._queues)


def wait_for_subscribers(client, count, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if subscribers(client) == count:
            return
        time.sleep(0.01)
    raise AssertionError(f"subscribers stayed at {subscribers(client)}, expected {count}")


def assert_quiet(caplog):
    gc.collect()   # an unretrieved task exception is only reported when the task is collected
    for record in caplog.records:
        text = record.getMessage()
        assert "never retrieved" not in text, text
        assert record.exc_info is None, f"traceback logged by {record.name}: {text}"
        assert "Traceback" not in text, text


def close_code(ws, timeout=10.0):
    """The code the server closed with, failing (not hanging) if it never closes."""
    def wait():
        for _ in range(30):
            try:
                ws.receive_text()
            except WebSocketDisconnect as closed:
                return closed.code
        return None
    pool = concurrent.futures.ThreadPoolExecutor(1)
    try:
        return pool.submit(wait).result(timeout)
    except concurrent.futures.TimeoutError:
        raise AssertionError("the server never closed the socket") from None
    finally:
        pool.shutdown(wait=False)


def hello(ws):
    assert json.loads(ws.receive_text())["type"] == "hello"


@pytest.mark.parametrize("code", [1000, 1001, 1005, 1006, 1012])
def test_a_browser_closing_is_quiet_and_releases_its_queue(client, caplog, code):
    caplog.set_level(logging.DEBUG)
    before = subscribers(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        assert subscribers(client) == before + 1
        ws.close(code)
        wait_for_subscribers(client, before)
    assert_quiet(caplog)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING], [r.getMessage() for r in caplog.records]


@pytest.mark.parametrize("failure", [lambda: WebSocketDisconnect(1006),
                                     lambda: WebSocketDisconnected('Cannot call "send" once a close message has been sent.'),
                                     lambda: RuntimeError('Cannot call "send" once a close message has been sent.')])
def test_a_disconnect_during_the_pump_is_quiet_and_releases_its_queue(client, caplog, monkeypatch, failure):
    caplog.set_level(logging.DEBUG)
    real_send = WebSocket.send_text

    async def send_text(self, data):
        if json.loads(data).get("type") == "swarm.updated":
            raise failure()          # the socket dropped under the pump's send
        return await real_send(self, data)

    monkeypatch.setattr(WebSocket, "send_text", send_text)
    before = subscribers(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        client.post("/api/swarms", json={"name": "Beta"})
        wait_for_subscribers(client, before)
    assert_quiet(caplog)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING], [r.getMessage() for r in caplog.records]


def test_an_unexpected_failure_is_logged_once_without_a_traceback(client, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    real_send = WebSocket.send_text

    async def send_text(self, data):
        if json.loads(data).get("type") == "swarm.updated":
            raise ValueError("boom")
        return await real_send(self, data)

    monkeypatch.setattr(WebSocket, "send_text", send_text)
    before = subscribers(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        client.post("/api/swarms", json={"name": "Beta"})
        wait_for_subscribers(client, before)
    assert_quiet(caplog)
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors == ["events websocket failed: ValueError: boom"]


@pytest.mark.parametrize("where", ["visibility", "summary", "hello"])
def test_an_unrelated_runtime_error_with_socket_words_is_not_taken_for_a_disconnect(client, caplog, monkeypatch, where):
    """Review P1 + Kimi K2: only starlette's own closed-socket errors from ws I/O are a disconnect, never a
    look-alike; a failure in the summary, the hello send or the pump logs once, closes 1011 and the handler
    itself releases its queue (checked before the test client tears the session down)."""
    caplog.set_level(logging.DEBUG)
    hive = client.app.state.hive
    message = "visibility database connection is not connected; disconnect after close"

    def boom(*args, **kwargs):
        raise RuntimeError(message)

    before = subscribers(client)
    if where == "visibility":
        monkeypatch.setattr(hive.visibility, "event_visible", boom)
    elif where == "summary":
        monkeypatch.setattr(hive, "summary", boom)
    else:
        real_send = WebSocket.send_text

        async def send_text(self, data):
            if json.loads(data).get("type") == "hello":
                raise RuntimeError(message)
            return await real_send(self, data)

        monkeypatch.setattr(WebSocket, "send_text", send_text)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        if where == "visibility":
            hello(ws)
            client.post("/api/swarms", json={"name": "Beta"})
        assert close_code(ws) == 1011
        wait_for_subscribers(client, before)
    assert_quiet(caplog)
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors == [f"events websocket failed: RuntimeError: {message}"]


def test_a_pump_failure_while_the_handler_is_cancelled_is_logged_exactly_once(client, caplog, monkeypatch):
    """Kimi K3: the handler is cancelled (server shutdown, no close frame) while the pump is raising."""
    caplog.set_level(logging.DEBUG)
    real_send = WebSocket.send_text
    in_send = threading.Event()

    async def send_text(self, data):
        if json.loads(data).get("type") != "swarm.updated":
            return await real_send(self, data)
        in_send.set()
        try:
            await asyncio.sleep(30)
        finally:
            raise ValueError("boom")   # the pump fails on the way out of the cancellation

    monkeypatch.setattr(WebSocket, "send_text", send_text)
    before = subscribers(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        client.post("/api/swarms", json={"name": "Beta"})
        assert in_send.wait(10), "the pump never reached its send"
        # No close frame: leaving the block only cancels the handler, as a shutdown does.
        monkeypatch.setattr(WebSocketTestSession, "close", lambda self, code=1000, reason=None: None)
    wait_for_subscribers(client, before)
    assert_quiet(caplog)
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors == ["events websocket failed: ValueError: boom"]


def test_delivery_to_a_queue_whose_pump_has_ended_is_bounded_and_then_released():
    """Kimi K4: _deliver snapshots the queues; one whose pump has ended (not yet unsubscribed) is fed without
    error but never past its bound, and once unsubscribed it is no longer fed at all."""
    bus = EventBus()
    queue = bus.subscribe()
    for i in range(queue.maxsize + 500):   # nobody reads it: the pump has ended
        bus._deliver(json.dumps({"type": "x", "n": i}))
    assert queue.qsize() == queue.maxsize
    assert json.loads(queue.get_nowait())["n"] == 500       # oldest dropped first
    bus.unsubscribe(queue)
    size = queue.qsize()
    bus._deliver(json.dumps({"type": "x"}))
    assert queue.qsize() == size and not bus._queues
    bus.unsubscribe(queue)                  # a second unsubscribe is harmless


def test_a_failing_pong_send_is_logged_once_and_closes_1011(client, caplog, monkeypatch):
    """Stand-in r2 P2: only JSON decoding of a frame is excused, never an error while sending the pong."""
    caplog.set_level(logging.DEBUG)
    real_send = WebSocket.send_text

    async def send_text(self, data):
        if json.loads(data).get("type") == "pong":
            raise ValueError("pong send failed")
        return await real_send(self, data)

    monkeypatch.setattr(WebSocket, "send_text", send_text)
    before = subscribers(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        ws.send_text("not json")              # still ignored
        ws.send_json(["not", "an", "object"])  # still ignored
        ws.send_json({"type": "ping"})
        assert close_code(ws) == 1011
        wait_for_subscribers(client, before)
    assert_quiet(caplog)
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors == ["events websocket failed: ValueError: pong send failed"]


def test_ping_still_gets_pong(client):
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello(ws)
        ws.send_text("not json")       # ignored, the socket stays up
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_visibility_filtering_is_unchanged(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    bob_token = bob["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/events?token={bob_token}") as bob_ws, \
            client.websocket_connect(f"/api/events?token={client.operator_token}") as admin_ws:
        hello(bob_ws)
        hello(admin_ws)
        private = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
        assert private["visibility"] == "private"
        # the admin sees it (auditability)
        for _ in range(30):
            event = admin_ws.receive_json()
            if event.get("type") == "swarm.updated" and event["swarm"]["id"] == private["id"]:
                break
        else:
            raise AssertionError("admin did not see the swarm")
        # Bob never does: a ping is the barrier
        bob_ws.send_json({"type": "ping"})
        for _ in range(30):
            event = bob_ws.receive_json()
            assert event.get("swarm", {}).get("id") != private["id"], "private swarm reached another member"
            if event.get("type") == "pong":
                break
        else:
            raise AssertionError("no pong barrier")
