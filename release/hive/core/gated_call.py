"""One model call under the live send gate: the shared helper (gateway r1a; PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN r1.1 §A).

The same commitment point as the Ask conductor's own `gate`/`go`/`release` (conductor.py, ask-takeover r3 and r5, and
its omegahive#9 yield), for the personal-mind gateway (r1c). The conductor keeps its own copy for now (r1ab.2: its send
gate is live and is not moved in this round); the two must stay the same, and test_mind_gateway_r1 pins that they do:

1. The caller reserves first, in state `reserved` (Reservations.reserve(..., dispatched=False)), or takes no reservation
   (a free call).
2. `GatedCall.run()` checks `still_valid()`, sets gateway.SEND_GATE, and calls `gateway.chat`.
3. At the gate (httpcore's send_request_headers.started trace: after any wait for a pooled connection and after
   connecting) `still_valid()` runs again. If it fails, GateClosed (or whatever still_valid raised) is raised there:
   nothing is sent, and the caller releases the hold (`release()`, Reservations.abort_before_dispatch, which only ever
   releases a `reserved` row). If it passes, the reservation is marked dispatched, once, and the gate yields once to the
   loop before the bytes are handed to the OS.
4. A call that answered without crossing a transport's send boundary (the mock provider) is marked dispatched
   afterwards: it was made all the same.
5. A call that was sent stays a liability: the caller settles it at its real cost or holds it unknown; never released,
   except a refusal: one whose body reports a charge is settled at it, and one guaranteed unbilled by provider and status
   (gateway.UNBILLED_REFUSALS, e.g. OpenRouter 402, with no charge evidence) is released; both by the caller's
   hold_unknown(reservation, exc) (Reservations.settle / release_unbilled).

`still_valid()` returns True to let the call go; it may return False (GateClosed is raised) or raise its own exception
(the conductor raises its _Closed). It runs on the event loop, at the gate, and must not await.

The remaining window is the one documented in gateway.SEND_GATE: the gate yields once after committing, before the bytes
are handed to the OS, so a close committed in that one step sees this one already-authorised call leave; it is then
settled at its real cost. The yield is ours, not the transport's: AnyIO 4.16 no longer yields before its socket write
(omegahive#9), and the boundary must not move with it.
"""

from __future__ import annotations

import asyncio
import contextlib

from .gateway import SEND_GATE


class GateClosed(Exception):
    """still_valid() said no at the gate (or before the call): nothing was sent."""


class GatedCall:
    def __init__(self, gateway, reservations, agent, body, reservation, still_valid, principal=None):
        self.gateway, self.reservations = gateway, reservations
        self.principal = principal   # the trusted caller the call is for (Gateway.admit_subscription), if known
        self.agent, self.body, self.reservation = agent, body, reservation
        self.still_valid = still_valid
        self.started = False   # True once the call is committed: dispatched, and let finish to be settled

    def _check(self):
        if not self.still_valid():
            raise GateClosed()

    async def gate(self):
        """Awaited by the gateway at the send boundary. Once committed it yields once to the loop before the bytes are
        handed to the OS, so a close committed in that one step is seen before they leave, and this one
        already-authorised request still leaves (the conductor's gate, omegahive#9). Fails closed: a failure to mark
        dispatch raises here, before any byte, and the caller releases the hold."""
        if self.started:
            return
        self._check()
        if self.reservation:
            self.reservations.dispatch(self.reservation)
        self.started = True
        await asyncio.sleep(0)   # the step a close committed at dispatch lands in, before the write

    async def run(self):
        """The call itself: (response, usage) from gateway.chat, under the gate."""
        self._check()
        token = SEND_GATE.set(self.gate)
        try:
            out = await (self.gateway.chat(self.agent, self.body, principal=self.principal) if self.principal is not None
                         else self.gateway.chat(self.agent, self.body))
        finally:
            SEND_GATE.reset(token)
        if not self.started:   # answered without passing a transport's send boundary: it was made all the same
            if self.reservation:
                self.reservations.dispatch(self.reservation)
            self.started = True
        return out

    def release(self):
        """A call that never left this process: its hold is released, not left held. A no-op once dispatched
        (abort_before_dispatch refuses a dispatched row; that refusal is swallowed here, the liability stays)."""
        if self.reservation and not self.started:
            with contextlib.suppress(Exception):
                self.reservations.abort_before_dispatch(self.reservation)


def gated_chat(gateway, reservations, agent, body, reservation, still_valid, principal=None):
    """The shared helper (r1.1 §A): a GatedCall for one model call. Await `.run()` (or wrap it in a task to shield it),
    read `.started` to know whether it was committed, and call `.release()` for one that never left."""
    return GatedCall(gateway, reservations, agent, body, reservation, still_valid, principal)
