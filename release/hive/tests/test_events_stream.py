"""Purpose: tests where answers and the events socket stand in the live stream, and that a page that fell behind is
closed (flagship review #111, the UI re-reading after a gap).

The bus is one stream per process with a count of frames delivered (events.py). The events socket's hello names the
stream and the count at which its subscription began, and every HTTP answer names the count at which its request was
read (Hive-Stream), so the page can tell which of its reads may miss a frame and read those again. A page whose queue
overflowed lost frames, and its socket is closed with 1013 ("try again later") so it reconnects and reads again;
in-process readers keep the plain drop-oldest queue.
"""

import json
import time

from hive.core.events import EventBus
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_events_websocket import close_code


def stream_of(answer):
    stream, at = answer.headers["hive-stream"].split(" ")
    return stream, int(at)


def wait_until(check, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.01)
    raise AssertionError("the condition never held")


def test_answers_and_the_hello_say_where_they_stand_in_the_stream(client):
    bus = client.app.state.hive.events
    stream, before = stream_of(client.get("/api/hive"))
    assert stream == bus.stream and len(stream) == 16
    for n in range(3):
        bus.publish("stream.test", n=n)
    wait_until(lambda: bus.at >= before + 3)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        hello = json.loads(ws.receive_text())
        assert hello["type"] == "hello"
        assert hello["stream"]["id"] == stream and hello["stream"]["at"] >= before + 3
        later, at = stream_of(client.get("/api/hive"))
        assert later == stream and at >= hello["stream"]["at"]


def test_every_answer_carries_its_position_errors_included(client):
    assert stream_of(client.get("/api/swarms"))[0] == client.app.state.hive.events.stream
    missing = client.get("/api/no-such-route")
    assert missing.status_code == 404 and stream_of(missing)[0] == client.app.state.hive.events.stream


def test_a_page_that_fell_behind_is_closed_so_it_reconnects_and_reads_again(client):
    bus = client.app.state.hive.events
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"

        def flood():   # on the hive's own loop, with no await between: the pump cannot drain a frame meanwhile
            for n in range(1500):
                bus._deliver(json.dumps({"type": "stream.flood", "at": "now", "n": n}))

        client.portal.call(flood)
        assert close_code(ws) == 1013


def test_lost_names_exactly_the_queues_that_dropped_a_frame():
    bus = EventBus()
    slow, quick = bus.subscribe(), bus.subscribe()
    for n in range(slow.maxsize):
        bus._deliver(json.dumps({"n": n}))
        quick.get_nowait()
    assert bus.at == slow.maxsize and not bus.lost(slow) and not bus.lost(quick)
    bus._deliver(json.dumps({"n": "one too many"}))
    assert bus.lost(slow) and not bus.lost(quick)
    assert json.loads(slow.get_nowait())["n"] == 1      # the drop itself is unchanged: oldest first
    bus.unsubscribe(slow)
    assert not bus.lost(slow)
    assert EventBus().stream != bus.stream             # another process, another stream
