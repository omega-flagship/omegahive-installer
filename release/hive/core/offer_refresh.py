# Purpose: re-derive the host foundation's Create · Code offer and its swarms' owner whenever one of their inputs changes
# (the boot catalogue of prices, a key added or removed, the Code service enrolled, switched or answering again, a person
# made an admin or no longer one, an owner claim), one run at a time, at start only when the catalogue brought prices
# the start-up ensure could not see, and ended by the lifespan's shutdown before the hive stops.
"""The foundation decides whether Create · Code offers code from the Code service, the keys and the model prices
(Foundation.ensure). It used to decide only at start, before the boot catalogue had priced any model, and at an owner's
sign-in, so a hive whose key or Code service arrived later, and every hive after a restart, said that no swarm takes code
changes until its owner signed in again. OfferRefresh fetches the price catalogue, then runs the foundation's ensure when
something it depends on changed: a key or a Code service change (schedule()), a change to who may own the hive (a
person made an admin or no longer one, an owner claim: the same ensure binds the Code, Review and Research swarms to the
owner), a Code service that answers again after an ensure found it down (the reconcile pass probes it, since it never
calls the hive), or a catalogue that brought prices. The start-up run (schedule(changed=False)) follows the ensure create_app ran moments before, so it ensures again only when the
catalogue brought prices. Never two runs at once, and a change during a run causes exactly one more run after it.

A run outlives the request that started it, so what that request's caller reads next may not show its result yet. The
lifespan ends the refresh with aclose() before the hive stops: no run starts after it, and the one in progress ends first
(an ensure on a worker thread gets SHUTDOWN_GRACE, and an overrun is logged)."""
from __future__ import annotations

import asyncio
import logging

# At shutdown, an ensure already on a worker thread gets this long to finish, as the Ask conductor's cut-off calls get
# LATE_SHUTDOWN_GRACE (hive/core/conductor.py); after it the shutdown goes on and says so.
SHUTDOWN_GRACE = 10.0


class OfferRefresh:
    def __init__(self, prices, ensure):
        self._prices = prices      # async () -> bool: fetch the price catalogue; True when it brought one
        self._ensure = ensure      # async () -> None: the foundation's ensure, which derives the offer
        self._task = None
        self._again = False
        self._changed = False      # a key or Code service change the last ensure did not see
        self._closed = False       # the lifespan is ending: no run starts, and no ensure follows a fetch
        self._ensuring = False     # the run is in the foundation's ensure, on a worker thread

    def schedule(self, changed=True):
        """From the event loop's thread (a route or the lifespan): start a run, or mark the running one to go again.
        changed=False: nothing the offer depends on changed but perhaps the prices (the start-up run). After aclose():
        None, and nothing runs."""
        if self._closed:
            return None
        self._changed = self._changed or changed
        if self._task is not None and not self._task.done():
            self._again = True
            return self._task
        self._task = asyncio.get_running_loop().create_task(self._run())
        return self._task

    async def aclose(self, grace=SHUTDOWN_GRACE):
        """At shutdown, before the hive stops: no run starts after this, and the run in progress ends first. A catalogue
        fetch is cancelled. An ensure already on a worker thread gets up to `grace` seconds, since cancelling the task
        that awaits it would leave the thread writing to a hive whose lifespan has ended. The run's failure, or an ensure
        still running after the grace, is logged and never raised, so the rest of the shutdown still runs."""
        self._closed = True
        task = self._task
        if task is None or task.done():
            return
        if not self._ensuring:
            task.cancel()
        done, _ = await asyncio.wait({task}, timeout=grace)
        log = logging.getLogger("hive")
        if task not in done:
            log.warning("offer refresh: its ensure was still running %g s into the shutdown, which goes on without it",
                        grace)
        elif not task.cancelled() and task.exception() is not None:
            log.warning("offer refresh: the run in progress at shutdown failed (%s)", type(task.exception()).__name__)

    # Time: one catalogue fetch and at most one ensure per schedule() burst; a burst of k schedules during a run costs one
    # more pass, not k.
    async def _run(self):
        while True:
            self._again = False
            changed, self._changed = self._changed, False
            if await self._prices() or changed:
                if self._closed:       # the shutdown began while the catalogue was fetched
                    return
                self._ensuring = True
                try:
                    await self._ensure()
                finally:
                    self._ensuring = False
            if not self._again or self._closed:
                return
