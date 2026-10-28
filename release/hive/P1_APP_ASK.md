# App-scoped Ask presentation (P1)

An opaque app frame may present the person's existing Ask after host consent to
that app's exact pinned release. The host keeps identity, Ask limits, payment,
approvals and action execution. The frame receives no token.

## Consent and frame authority

The trusted host card names the app, pinned digest/version and says “may send to
and show your Ask while open”. Its opaque two-minute reference binds the named
person, host session, app, digest and consent epoch. A changed release needs fresh
consent. Revocation tombstones the old identity; a later consent gets a new one
and cannot resume the revoked binding's turns. Only content-free metadata persists.

`programs.ui_bundle` binds returned UI bytes to the captured reviewed lock and
returns the release descriptor atomically, including a byte/lock ABA swap check.
Unpinned apps may render without a positive release descriptor: legacy omission
or `null` both leave P1 unavailable. Positive pinned descriptors are atomic with
the returned verified UI bytes.

A new document gets a new generation and fifteen-second monotonic lease. The
trusted parent renews every five seconds only while visible, connected and
presenting Ask. Lapsed generations require a fresh generation, not renewal.
There are at most 128 generations/person/UTC day and 256 live process-local cards.
An independent 250 ms server sweep restores host presentation after a dead frame,
even with ordinary supervisor reconciliation disabled. Restart preserves consent,
suspends old generations and offers their same turns to the host.

## One canonical turn and one presentation owner

There is no second Ask or transcript. Consent-scoped deterministic IDs use the
existing Ask turn/steer uniqueness and body digest for replay/conflicts. The
host-only admission binding hashes the original bounded request, so host context
changes on reload do not create a second effect. Final admission rechecks session,
consent, release, generation and epoch after awaits, before messages or spend.
An empty pre-admission thread may remain under existing Ask repair semantics.

Only consent-started operations resume in a new generation. A trusted host gesture
may initially hand one exact own operation to the first generation; that initial
membership is generation-bound and never re-handed on reload. Raw frame `handoff`
only yields an already-bound operation. It cannot select the initial snapshot or
prove a human gesture. Other host turns remain unavailable after preference changes.

Each turn has one host or exact-frame owner and an epoch. Reclaim is nonterminal:
the host rejoins the same canonical operation, never `Ask.takeover`. A host that
has actively resumed needs explicit human handback with its expected epoch. A
frame may reacquire a host-offered turn, never an active host's turn silently.

Turn transitions acquire their mutex before a short DB transaction, with no await
inside. Leave/sign-out/revoke set independent generation fences before waiting
on either gate. Final resume/admission checks them again. Teardown waits only
after releasing other turn/DB gates; no P2/mind lock is acquired here. This is
single-process ordering, not distributed locking.

## Acts, unknown outcomes and recovery

New acts are stamped before emission with their original
`{kind, generation_id, owner_epoch}`. P1 host/frame executors must pass a shared
once-only `act-claim` gate before effects, then recheck identity/generation/epoch
after the await. Results check the same exact recipient and pending act once.
Old frame acts remain frame-stamped after handback and cannot use the host result
route. Ordinary pre-P1 host turns retain existing result compatibility.

Duplicate, failed or unknown claims never authorize execution or retry. Lapse,
leave, revoke and handover settle unanswered old acts as `no_result` once,
including claims whose effects may already have occurred. They are never
reassigned or reissued. No protocol can undo an already admitted browser effect.

Persisted P1 bindings add safe `app_ask: true` markers to Ask views and new events.
The host marks recovered turns before historical events and suppresses automatic
legacy proposal/presence/revert effects for P1 turns, surviving reload/cache
eviction. A trusted initial handoff is provisionally tracked before its request.

## Bounded protocol

P1 uses closed JSON operations capped at 8,192 UTF-8 bytes at both parent and
streamed HTTP boundaries. Generic bridge operations keep 2 KiB. Frame identity,
credentials, approvals and routing authority are refused; app/target context is
host-derived. Private context keeps existing Ask privacy fences. Services and
arbitrary iframe origins are excluded.

Logical subscriptions read existing canonical Ask events; no websocket token or
whole-thread push is added. Personal events are deliberately content-free in the
DB, so their same existing live projection uses a generation-only memory outbox,
never a durable transcript. It holds at most sixteen events/61,440 serialized
bytes, is cleared on ACK/unsubscribe/fence, and fails closed on overflow. Missing
old ephemeral bodies never fall back to private history; resumed subscriptions
start at their new live boundary. Limits are sixteen subscriptions, twenty
operations/second with burst forty, 61,440 bytes/projected event and 3,072 raw bytes/chunk. Exact cursors, byte lengths and SHA256 bind each chunk; every
wire response fits 8 KiB. Old-recipient acts project unavailable, never relabeled.

The parent allows one globally unacknowledged chunk/in-flight poll and at most
8,192 serialized pending-envelope bytes, with fair round-robin eight total
polls/second and a two-second ACK deadline. Renewal is independent. The logical
payload allocations are 61,440 server-outbox + 8,192 ACK-pending + 61,440 frame
reassembly bytes = 131,072 total. This excludes object overhead/RSS and arbitrary
app JavaScript heap; it is not a browser memory hard cap. Overflow/stall suspends the generation and stops renewal. Repeated
cursors are effect-free; oversized events fail closed and restore the host.

## Thread preparation and admission

The UI response for an
unpinned app is unchanged: no extra `release` key. A legacy lock without `scripts` may still
pin verified files that are not served. Every returned byte remains bound to the
captured lock, and parts mode still requires the exact declared file set. A
positive pinned release keeps the same atomic digest/version descriptor.

A new P1 Ask thread now prepares through the existing asynchronous session seam
without writing a goal, assignment note, room, cap or event. After that await,
Ask checks current frame authority and commits the prepared thread and canonical
Ask turn in one short transaction. The lock order is principal admission, turn,
swarm membership, then DB; no await occurs under those gates. Duplicate awaited
preparations recheck the canonical operation and shared thread before creating
anything. Goal, room and Ask notices are deferred until outer commit and dropped
on rollback. The P1 bookkeeping goal emits no separate assignment prompt: the
canonical Ask delivery is the one request. Ordinary session creation retains its
existing goal-announcement behavior through the shared install helper.

P1 routing/preparation is also write-free: it does not trigger ordinary Ask expiry
maintenance or change cap scope. Scope migration and a fresh held/spent check run
inside final admission after the current binding check, with duplicate replay
resolved first. Any refusal rolls scope writes back with the thread/turn. The
ordinary host Ask maintenance path is preserved.

Duplicate empty Ask-thread cleanup is not done inside the rollbackable P1
admission; P1 leaves it to the ordinary maintenance path, and ordinary Ask
cleanup is unchanged.

## Tests

Backend tests in `hive/tests/test_app_ask_p1.py` cover person/Origin/card/digest
gates; cross-app, turn and person isolation; existing Ask replay and conflicts;
initial-only handoff; lapse, restart, revoke and sign-out; nonterminal reclaim and
epoch compare-and-set; the leave/resume barrier; final admission after an await;
chunk bytes, cursors and digests; once-only claims and results with lost-claim
expiry; fencing after thread preparation; rollback with no publication; concurrent
preparation; and legacy UI and closed-parts compatibility. UI tests cover wire
bounds, ACK and backpressure, callback fences and executor behavior. All fixtures
are synthetic; no model or provider is called. Actual browser frame behavior is
not covered by these tests.
