# Coding controller R3.12: host mapping

This note is for the builder of `hive/core/code_controller_engine.py`. It lists every observation and action that is
new or changed in R3.12, and how the host should produce or consume each. R3.11.5 stays in this folder unchanged. The
engine keeps working on R3.11.5 until it switches.

- **Reducer:** `coding_controller_r3_12.metta`. Pin it by the sha256 of the committed file.
- **Tests:** `test_coding_controller_r3_12.metta`, 306/306 under `.runtime/PeTTa/run.sh`, run from that directory.
  The tests are the 183 R3.11.5 tests (Ctx shape adapted) plus 123 new ones.
- **R3.11.5 invariants kept:**
  - journal before effect: a rejected observation means no effect;
  - operation ids are unique for the task's lifetime;
  - `applied` comes only from the person's own apply;
  - uncertainty never releases a hold;
  - a readback is never lost.

## Switch-over (constants and shapes)

| Item | R3.11.5 | R3.12 |
|---|---|---|
| `REDUCER` | `coding_controller_r3_11.metta` | `coding_controller_r3_12.metta` |
| `REDUCER_VERSION` | `R3.11.5` | `R3.12` |
| Ctx | `(Ctx task epoch person author max profile)` | `(Ctx task epoch person (authors…) max profile review-policy)` |
| State | 14 fields | 14 fields, unchanged (`STATE_FIELDS` and `state_view` stay) |

**`_ctx`.** Render the authors as a list:

- the controller id;
- every `mind_children` id of the request;
- each candidate's `child_id`.

These are the ids `_excluded_reviewers` already computes, so the reducer now enforces the exclusion as well. The list
may grow between replays. It only ever gains fresh child ids, and a reviewer is never one of those, so replay is
unchanged.

`review-policy` is `review-required` (the default, and R3.11.5 behaviour) or `review-waivable`. Take it from the
person's own setting. Store it on `code_controller_runs` when the run is created, so that every replay uses the same
value.

New values that can appear in the state view:

- `prop` = `(thinking attempt helper)`: a helper attempt is open.
- `tested` = `(failed cand)`: the candidate was refuted by a test, check or review failure, or by the person's changes.
  Treat it as "not tested".
- `reviewed` = `(unreviewed cand)`: no review could run and the policy allowed going on without one.

## Actions

| Action (from `next-action-for root-suggest`) | Host |
|---|---|
| `(do (host-read find-the-relevant-code))`, `(do (host-read read-again-before-editing))` **new** | Replaces `(think find-…)` and `(think read-again-…)` under root-suggest. `_host_read` as today: journal `read` with the scope evidence. No model call. `needs-model` is False. |
| `(think make-the-smallest-change \| repair-from-the-failing-output)` | Unchanged meaning. **First journal `think-started (attempt helper)`**, then spawn or prompt the helper. If the reducer rejects it, do not spawn. |
| `(rest awaiting-helper)` **new** | A helper attempt is open. Wait for its work-goal event and do not spawn another. Replaces the host-only "waiting" check in `_think_change`. On restart, resume the journalled helper effect. |
| `(tell confirm-unreviewed-to-apply c)` **new** | Like `confirm-to-apply`, but the UI must say plainly that no second opinion could run. The `apply` route accepts both `tell` forms. The approval and apply flow are the same. |
| `(tell confirm-to-apply c)`, `(rest awaiting-person-apply)`, `(do (proposal-test …))`, `(do (proposal-review …))`, `(do (reconcile op))`, `(do (code-open-readonly t))` | Unchanged. |

A helper that is still running never delays a read. In `open` and `needs-read` the host read is proposed even while
`prop` is `thinking`. After the read the controller rests `awaiting-helper` again.

## Observations

| Kind (fields) | Produce it when | Replaces (R3.11.5 shortcut) |
|---|---|---|
| `think-started (attempt helper)` **new** | Before every helper spawn or prompt, in `_think_change`. The attempt id is a fresh, lifetime-unique operation id that no run, approval or proposal execution uses, for example `think-<n>` from the journal. `helper` is the child id on a reprompt. On a first spawn the child id is not known yet, so use the spawn operation id (`cce.spawn.<rid>.<seq>`). Once the child exists, the Ctx authors list covers it. | Nothing. The helper call is now journalled in the reducer as well as in the effects table. |
| `think-failed (attempt)` **new** | The open attempt ended without a usable proposal. This covers: the work goal failed or was cancelled; `no_single_proposal`; a definite `controller_lookup` refusal; a definite spawn or prompt failure after `think-started`; and a `candidate-retained` that the reducer rejected (for example because the origin went stale). Each costs one repair. Past `max_repairs` the request is blocked. A transient lookup error is retried, not journalled. | `refused` from `helper-refused-*`, `helper-failed-*`, `helper-noproposal-*` and `cand-refused-*`, which went straight to blocked. |
| `review-unavailable (cand)` **new** | `_find_reviewer` returns None for the current candidate, and no review is in flight. Journal it once per candidate. **review-required:** the receipt is `(accepted (review-unavailable blocked))` and the request moves to `needs_you`, exactly as `check-unavailable` does. **review-waivable:** the receipt is `(accepted (review-unavailable waived))` and the request moves to `ready` with `confirm-unreviewed-to-apply`. | The host-only `review="unavailable"` flag and the `review_unavailable` status, which left the phase at green with `proposal-review` repeating. |
| `reconciled-current (op cand)` **new** | The readback in `_reconcile` proves all of the following: (a) op had no effect on the origin, or its result is history only; (b) the candidate's retention (suggestion id and digest) and its parent generation and tree digest are still the origin's; (c) op is the only unresolved operation and no run is open. If so, the candidate gets a fresh validation generation (re-test, re-review) with no helper call. Otherwise use plain `reconciled (op)`. Rejection reasons: `reconcile-not-clean`, `not-the-current-candidate`, `hold-kept`. Re-journal under a new id as plain `reconciled`. | Plain `reconciled`, followed by a fresh read and a new helper call to recreate the same candidate. |
| `changes-requested (cand person)` **new** | The person's Ask for changes, while the request is green or ready. Keep their words as evidence. Do not dispatch anything. The next `think` prompt includes their words: add `changes-requested` to `_failing_output`. It costs no repair, and it refutes the candidate. | A forged `dispatched (person-review-n review cand)` plus `review-fail (cand person rq)`. **R3.12 rejects that path**, because the person is not an independent reviewer. |
| `apply-refused (op)` **new** | A definite no for the confirmed apply, with nothing applied. This covers: a capability-stage refusal; a relay 4xx; and Code's own refusal (4xx, or 5xx with an error code). The apply's ledger entry is retired with no debt, and the request returns to `ready` (`confirm-to-apply` again; a new apply uses a new approval id). If Code's refusal says the origin moved (generation or tree mismatch), journal `stale` right after. If the reducer rejects it with `not-the-confirmed-apply` (for example the confirmation was already superseded and the apply became debt), journal `reconciled (op)` with the refusal as the readback. | `refused` from `refused-apply-*`, which blocked the request and turned the apply into debt. |
| `refused ()` | Stays for definite refusals that are not about the apply or a helper, such as an open refusal (`no_code_origin`, claim failed) or a test-prepare refusal. It still blocks. | |
| `review-pass` / `review-fail (cand reviewer rq)` | Unchanged fields. The reducer now rejects a reviewer who is in the Ctx authors, who is named by any `think-started`, or who is the person. | |
| Under root-suggest, `proposed (pid read\|search d)` | Now always rejected. Reading is the host's. `suggest` is the only model proposal. | |

## Status hints (`_status`)

| Situation | Status |
|---|---|
| `blocked` after `review-unavailable blocked` | `needs_you`; the evidence names the missing reviewer |
| `ready` with `(tell confirm-unreviewed-to-apply c)` | `ready_for_you`, with an "unreviewed" flag in the view |
| `(rest awaiting-helper)` | `writing` or `repairing`, from the phase, as today |

The `review_unavailable` status is no longer needed under R3.12.

## Rejected deltas

None of the seven deltas was rejected. Two were narrowed, to keep R3.11.5 invariants:

- **Delta 1.** Root-suggest additionally refuses read/search proposals, so that the reducer never implies a model call
  for reading.
- **Delta 4.** `reconciled-current` requires a clean reconcile and an unrefuted candidate. A refuted candidate is
  marked `(failed c)` and stays marked across `stale` and a plain `reconcile`.
