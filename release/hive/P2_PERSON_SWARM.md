# Person-owned app swarms (P2)

An app can declare `swarm_templates` and the `person_swarm` capability in its
manifest. The host parses and hashes the trusted template. A template names at
most eight minds and can supply only `deny` or `ask` rules. It cannot supply an
`allow` rule or select another person's key.

The signed-in person first reads `GET /api/me/app-swarms/{program}/{template}`.
The host card includes each mind's slot, name, persona, model and budget, the
template rules and digest, the person's own provider key, and their own-key
monthly total. `POST .../consent` must return the shown `template_digest`,
`key_id`, `month_usd`, `consent_revision` and `authority_revision`. Revision
values come from the existing consent and app-authority rows; there is no second
consent ledger. A card from before withdrawal or uninstall cannot restore
consent. A changed card requires the person to inspect and approve it again.

`ctx.ensure_person_swarm(template)` is a write capability for the current named
person. A mind, local operator password or read-only app context cannot use it
to provision minds. Without current consent it returns `consent_required` and
creates nothing. With consent it makes a private person-owned swarm and asleep
minds locked to that person's own key. Ordinary keys, payer attribution and
grants keep their existing P3 behavior; this feature supplies no provider key or
paid-call bypass.

## Current authority and revocation

A recorded app binding is distinct from an unbound ordinary mind. A raw host
check re-reads the current ready app, template digest, unwithdrawn consent, current own
key and presence of its monthly total, mind ownership, locked key, and completed setup. Missing,
disabled, errored or integrity-refused apps fail closed. Conflicting bindings
also fail closed. These checks do not call `ensure`, public mind reads, or app
hooks.

Changing only the numeric own-key monthly total leaves existing helpers authorised
and running. Every paid call still obeys the current total through the existing
budget and P3a key checks. Consent to the old number does not freeze the spending
limit, and lowering the total below spend still refuses a paid call that would
cross the current limit. Admission uses a cost estimate; an understated estimate
can let one completed call take actual spend above the total. Actual measured
spend is recorded in full, never clipped to the estimate or cap, and later
admissions continue to check that actual usage against the current total. The
host card JSON includes the fixed `spend_note`: “Your monthly total is checked
before each request. A single request can cost a little more than expected, so
the total can be passed by up to one request.” It contains no app data and is
outside the consent binding. Visible UI rendering is a separate follow-up
change. A template or selected key change, withdrawal, uninstall, or
missing/revoked/expired total retains its existing refusal and reconciliation
behavior; expiry uses the same active-limit filter as paid-call enforcement.

The next ensure, repair or setup still requires consent to the number currently
shown on the private host card. A numeric-only mismatch returns `consent_required`
and that current card without stopping existing helpers or creating/repairing a
slot. The same rule applies when a numeric change is observed between ensure's
entry, slot admission and final check. Effects already admitted before a change
are not undone; this is not a new cross-thread database transaction boundary.
Fresh consent permits setup to continue, preserving finished helper identities.
The program context still receives only `{status: "consent_required"}`; the key
and total remain on the authenticated person's host card. If that final live
consent check succeeds and only the numeric total changes in the last response
window, the content-free ready result may include
`total_changed_during_setup: true`. This advisory adds no authorization, card,
key or amount and performs no additional setup. A total mismatch observed before
the final check, including after a slot, keeps the existing current-card
`consent_required` path; missing, revoked, expired or non-numeric authority
changes never produce the hint.

The next host mind read reconciles a revoked binding toward asleep without
minting or repairing anything. Direct/list/swarm/message projections refresh the
row after cleanup. A stop must have positive supervisor confirmation before the
host reports it as asleep. A busy transition or failed confirmation is exposed
as `error`, with `desired=asleep` and a pending/unconfirmed reason; effects remain
refused. Reads inside an existing database transaction defer stop work until
commit and return a pending projection. A rollback drops that callback; a later
read or reconciliation still checks the invalid authority.

Lifecycle starts, direct supervisor starts, reconciliation and tools resumption
check current authority. The supervisor checks again after preparing the
environment, immediately before calling the driver. Authentication, budget
admission, app-hook/context entry and exact approval redemption also check it.
Model request headers check before and after the existing awaited Studio/Ask
send gate. These are admission boundaries: this change does not undo an effect
already admitted, terminate arbitrary escaped work, or make unreviewed Python
app code a security sandbox. Existing conservative reservation/unknown-outcome
handling remains in force; no new financial ledger is introduced.

## Serialization, withdrawal and uninstall

Provisioning and withdrawal share a `(principal, app)` fence across all of that
app's templates. App authority publication has a broader per-app fence. When
mind locks are needed, the order is app, principal/app, sorted mind locks, then
a short database transaction. Slot creation/repair additionally takes the shared
tools-choice fence before its mind lock, matching ordinary create/update calls.
Authority publication and read cleanup do not request that tools fence while
holding mind locks. Read/run checks never acquire either app fence
from inside a mind transition. Read cleanup tries a raw mind lock without
waiting in the inverse order.

`POST .../withdraw` retains a tombstone and sleeps the affected minds; it does
not delete them. `DELETE /api/programs/{program}` is an admin-only logical host
uninstall: it disables and removes the loaded app, withdraws its consents,
removes its template rules, and reconciles its minds. It does not remove source
files or delete minds. Missing apps discovered on reload/startup retain the
same consent tombstone behavior. Reloading/enabling the same release cannot
reuse withdrawn consent. A fresh card and consent are required. A partial
provisioning operation and uninstall are serialized, so crash repair cannot
resurrect an uninstalled app's setup.

An unfinished slot can be removed and recreated under live consent. A finished
slot keeps its identity and history. Fresh consent to a replacement own key or
template repairs that person's stopped slot in place and replaces its template
rules. A moved or differently owned finished mind requires explicit owner
resolution; it is not silently deleted or returned as ready.

## Policy and approvals

The template ceiling runs before normal skill precedence, discovery, explicit
allows and live role rules. The separate `program:*` action resolver applies the
same ceiling before its precedence and again after attachment review. An
attachment's reviewed mode cannot widen a template `deny` or `ask`. Ordinary
stricter rules still win. Exact app approvals bind the template digest along
with the existing request and attachment binding. Redemptions and final hook
admission re-read current authority. Both durable-answer interfaces keep a
template-capped approval once-only instead of writing a durable allow.

## Duplicate rules, provisioning intent and consent details

Duplicate normalized skill patterns now make the app fail to load with a clear duplicate-pattern error, in either rule order. Create and repair also aggregate the strongest mode per skill, `deny` over `ask`, and the storage upsert never replaces a deny with ask within that write. This defensive path matters even if a caller bypasses the normal manifest parser; explicit fresh consent to a genuinely changed template remains a separate authority transition.

Program provisioning now requires the host's current recorded `person_activity: true` act, its protected host confirmation and stable intent/idempotency key. Ordinary actions are not silently converted to person activity, and ordinary non-provisioning dispatch remains unchanged. The host binds exact context, program, swarm, action, command record/key/digest, principal and stored actor before plugin invocation, then rechecks the stored running action at provisioning time. Context attributes such as actor, command, program, read_only and capabilities are not authority for this method. Mind, view, hook, unbound and retained contexts refuse. Background tasks that inherit a context lose authority when the parent act succeeds, fails or is cancelled: a shared active flag is cleared in finally. This is an in-process API/integrity guard, not an arbitrary hostile Python memory or OS sandbox.

Inside a program, missing consent returns exactly `{status: "consent_required"}`. It never includes a consent card, key id or monthly total. The authenticated same-person host card and consent routes remain the place to inspect and confirm those details. A valid recorded person can still receive ready ids for their own consented setup.

Consent still compares the currently selected own key with the exact key_id shown on the card. A second, earlier-dated own key introduced between viewing and consenting makes the old card stale. Adding another own key for that provider later can change the selected oldest key and require looking again and consenting again before repair. No new hive-paid fallback is introduced.

A policy ceiling read fault still denies. Its warning records only the exception type, without an exception message, traceback or private database details.

## Tests

`hive/tests/test_person_swarms_p2.py` and `hive/tests/test_person_swarm_boundaries_p2.py` use synthetic data. They cover HTTP approvals, supervisor starts and reads, revocation, template readiness, attachment ceilings, stale consent, replacement-key repair, bounded withdrawal and uninstall races, numeric-only total changes (`hive/tests/test_person_swarm_total_consent_p2_1.py`), duplicate rule patterns in both orders, the protected person-activity flow with forged fields, stale and background contexts, earlier-dated key races, warning privacy, and a stale awake row attempting a host-authorized program action. Stop and send-gate fixtures are synthetic; production driver behavior and paid dispatch are outside this test scope.
