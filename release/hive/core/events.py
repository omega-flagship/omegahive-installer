"""Fan-out of live events to UI websockets.  Safe to publish from any thread.

The bus is one stream per process: `stream` names it (a restart starts another) and `at` counts the frames delivered so
far, so a read or a subscription can say where in the stream it stands (app.py puts both in the events socket's hello
and in every answer's Hive-Stream header). A reader whose queue overflows loses its oldest frame; `lost(queue)` then
says so, and the events socket closes such a reader so the page reconnects and reads again (frames it never saw are not
in what it holds). In-process readers keep the plain drop-oldest behaviour and their own sweeps.
"""

from __future__ import annotations

import asyncio
import json
import secrets

from .db import now


class EventBus:
    def __init__(self):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue] = set()
        self._lossy: set[asyncio.Queue] = set()   # queues that dropped a frame since they subscribed
        self._listeners = []   # in-process observers (repo maps 1.2): called with (kind, payload); must only enqueue
        self.stream = secrets.token_hex(8)
        self.at = 0

    def listen(self, callback):
        self._listeners.append(callback)

    def bind(self, loop):
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue):
        self._queues.discard(queue)
        self._lossy.discard(queue)

    def lost(self, queue) -> bool:
        """Whether `queue` has dropped a frame: what its reader holds may miss something the stream said."""
        return queue in self._lossy

    def _deliver(self, frame):
        self.at += 1
        for queue in list(self._queues):
            if queue.full():
                try:
                    queue.get_nowait()  # drop the oldest for slow clients
                except asyncio.QueueEmpty:
                    pass
                self._lossy.add(queue)
            queue.put_nowait(frame)

    def publish(self, kind, /, **payload):
        for listener in list(self._listeners):
            try:
                listener(kind, payload)
            except Exception:   # noqa: BLE001  (an observer never breaks a publication)
                pass
        frame = json.dumps(dict(type=kind, at=now(), **payload))
        loop = self._loop
        if loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._deliver(frame)
        else:
            loop.call_soon_threadsafe(self._deliver, frame)


class StreamPositionHeader:
    """ASGI middleware: every HTTP answer says where in the bus's stream its request was read, `Hive-Stream: <stream>
    <at>`, taken as the request arrives, so the answer holds at least what the stream had said by then. The page compares
    it with its events socket's hello and reads again what it read before its subscription began (hive/ui/src/api/
    live.ts); an answer from another stream (the hive restarted) is always older than the socket's. The name stays out
    of X-Hive-, which is the mind gateway's money namespace (mind_gateway.py relays every X-Hive- header and a refusal
    carries none), and RFC 6648 retires the X- prefix for new names anyway."""

    def __init__(self, app, bus: EventBus):
        self.app, self.bus = app, bus

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        value = f"{self.bus.stream} {self.bus.at}".encode("latin-1")

        async def stamped(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), (b"hive-stream", value)]}
            await send(message)

        return await self.app(scope, receive, stamped)
