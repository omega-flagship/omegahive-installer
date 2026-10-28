"""Fan-out of live events to UI websockets.  Safe to publish from any thread."""

from __future__ import annotations

import asyncio
import json

from .db import now


class EventBus:
    def __init__(self):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue] = set()

    def bind(self, loop):
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue):
        self._queues.discard(queue)

    def _deliver(self, frame):
        for queue in list(self._queues):
            if queue.full():
                try:
                    queue.get_nowait()  # drop the oldest for slow clients
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(frame)

    def publish(self, kind, /, **payload):
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
