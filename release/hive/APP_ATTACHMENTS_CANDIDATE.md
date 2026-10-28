# Reviewed app attachment backend candidate

> **Status (2026-10-20).** This page is the original candidate note. The backend is now part of the host
> (`hive/core/program_attachments.py`), and the routes below are served by `hive/core/app.py`. The host additions
> since are in "Host-made Studio makers" at the end of this page.

Isolated Fusion-owned implementation based on platform 97a05a3. Not mounted or
live. Review/cherry-pick by the platform owner; never copy this checkout over an
active platform. No UI changes, models, listeners, fleets, grants in the shared
host, budgets or external effects were run by this qualification.

Named authenticated admin required for activation, offer, bind and detach. The
loopback password cannot approve lifecycle access. Attachment-capable programs
opt in through private offer/bind/unbind hooks; legacy programs retain their route.

Routes under /api/programs/{program}:
- POST /activations {swarm_id}; DELETE /activations/{swarm_id}
- POST /offers {mind_id}
- POST /attachments {mind_id,actions,channels,policy,expires_at?,idempotency_key}
- GET /attachments; DELETE /attachments/{attachment_id}

Policy maps every reviewed action to allow or ask. Channels null means none.
Binding creates no host authority until the hook succeeds and the host commits
its attachment and rules atomically. Hook key and trusted command key equal the
server-generated at_ attachment id. Mind actions receive id/actor/channels in
ctx.actor.attachment. Existing explicit app restrictions cannot be weakened.
Expiration, inactive activation, wrong swarm, missing attachment-owned rule or
revoked status denies before app action delivery. Approvals bind the attachment
id, so detach/re-attach cannot reuse an old approval. Existing ordinary mind
budgets still apply; this adds no budget or attachment-specific meter.

Detach revokes host authority and deletes its owned rules before invoking the
app unbind hook. Failures remain unbind_pending, with zero host action authority,
for reconciliation. Host failure after a successful bind leaves binding and no
rules; retry uses the same key. Stale binding snapshots cannot resurrect a revoked
record. Recovery authority is the stored original named reviewer/revoker, not an
invented background identity. Already-running effects cannot be retroactively
cancelled; the app-side transaction journal provides its own effect boundary.

Qualification uses real TestClient HTTP routes and token/role resolution, a fake
process supervisor and synthetic sign-in person records in an ephemeral database.
It is not a Google SSO integration or living-UI test. Both actual app attachment
candidates run against invented disposable stores. No listener is created.

Re-run from this checkout with PETTA_PATH=<OmegaDot>/.runtime/PeTTa and the local
venv312 Python: -m pytest -q hive/tests/test_app_attachments.py
hive/tests/test_program_actions.py hive/tests/test_programs_api.py
hive/tests/test_program_refusal.py hive/tests/test_core_api.py . App-specific tests
skip if the owner-local Fusion/Social candidate repos are absent.

Remaining: review card and registry integration, persisted mind notification,
attachment-specific budget qualification, activation state projection, human
correction/review workflow, signed opt-in global hive collaboration, identity and
team agreements, invitation/export/receiving policy and encrypted transport.
Social acceptance remains an agreement, never an execution grant.

## Inbox and named-human activity continuation

Attachment grant and revoke transitions now persist inbox notices inside the same
host transaction as the permission transition. Notice identity/key, reviewed scope,
policy, actor lineage and expiry are retained; retries do not duplicate them, rollback
leaves no notice, and cleanup failure still leaves the host-revocation notice. The
existing inbox/hub replay delivers across disconnects. Best-effort delivery never
calls lifecycle wake/start; sleeping minds stay asleep. Live delivery is unqualified.

Proposed opt-in `person_activity: true` action metadata records named-human actions
in the same host activity ledger, with stable command record ids. Current sign-in
role/key and active app are required. Swarm is part of the intent digest. Retries
always reach the app's current scope/membership guard, never an authorization cache.
A refused retry preserves an existing committed receipt as history. Existing other
operator actions remain unchanged. Programs using the opt-in must implement domain
idempotence; this extension is pending platform owner acceptance.

OmegaSocial's new human_bridge separately checks accepted membership and exact
unexpired person scopes in a disposable local ledger inside each transaction.
Human/mind and human/human proposals remain agreements, not execution grants.
No actual human enrollment, private data, provider calls, workers or listeners were
introduced. The human reader/composer and real sign-in/scope review UI remain open.

## Host-made Studio makers (host rounds R7 to R8.3)

Each member's own Studio maker is attached to the Studio app by the host
(`ProgramAttachments.host_attach_studio_maker`), not by an admin. This is the one
audited exception to admin-only attachment, and it applies only to the Studio
program and to a maker the host made for that person and that person owns.

- The row is written with actor `hive:studio-maker`, the maker's own private
  Studio swarm, no expiry and no binding, and `ask` on every action in its scope.
  It is audited (`studio_maker_audit`). No activation row is written; Studio
  counts as active in that one swarm through a derived check (R8.2).
- No app hook runs. A hook-free app is attached with every action it offers to
  minds and no channels.
- **`member_attach` (R8.3).** An app with hooks (`offer`, `bind`, `unbind`) is
  attached only when it exports `member_attach = {"actions": [...], "channels":
  None | []}`, and only when the loaded app is its digest-pinned release
  (`HIVE_APP_PINS`) with the pin's digest. Each declared action must be one the
  app offers to minds. The scope is then exactly the declaration, copied, and
  never re-read from the live module. A malformed declaration counts as none, and
  the attach is refused 409 `studio_maker_attach_unsupported`. Changing the
  declaration needs a new reviewed, pinned app version. Studio 0.4.21 declares it.
- **Open:** the host attach writes no per-action `policy_rules` rows, and
  `authorize()` on the mind path requires exactly one. A maker's own direct app
  actions on that path would therefore be refused 403 `attachment_refused`.
  Studio sessions do not use that path today (the maker publishes through the
  Studio session tools); the fix is a follow-up.
