# Coding controller R3.13: host mapping (delta on R3_12_HOST_MAPPING.md)

- **Reducer:** `coding_controller_r3_13.metta`, with `REDUCER_VERSION` `R3.13`. Pin it by the sha256 of the committed file.
- **Tests:** `test_coding_controller_r3_13.metta`, 353/353 under `.runtime/PeTTa/run.sh`, run from that directory.
  That is the 306 R3.12 tests (one adapted, see below) plus 47 new ones.
- **Unchanged from R3.12:** Ctx, the state shape, and every action. Everything in `R3_12_HOST_MAPPING.md` still applies.
- **Kept invariants:**
  - journal before effect;
  - operation ids are unique for the task's lifetime;
  - delivery is produced only by the person's own consented apply;
  - uncertainty never releases a hold;
  - a readback is never lost.

## The shortcut this closes

Before R3.13, when an apply's outcome was unknown, the host could only journal plain `reconciled (op)`, even when
Code's readback proved the apply had landed. The reducer then moved to needs-read with the candidate stale, and only a
host-only hold stopped a re-think.

## New observations

| Kind (fields) | Produce it when | Effect |
|---|---|---|
| `applied-confirmed (op cand receipt)` | `_reconcile` for an apply op whose earlier attempt was journalled `unknown (op)`, when Code's readback (the proposal application for this request and suggestion) shows that this apply landed. `receipt` is a reference such as the application id or receipt digest; it is never `none`. Keep the full readback as evidence. | Delivered, exactly as `applied (op cand person)` would have been: `(rest done)`, nothing outstanding. It confirms the same consented apply and creates no new one, so the person's apply stays the only producer. |
| `reconciled-not-applied (op cand)` | The same readback proves the apply did **not** land, and also proves the candidate is still current: retention, parent generation and tree digest unchanged. | Back to `ready`. The consent is cleared, op is retired with no debt, and no re-think is needed. `(tell confirm-to-apply cand)` (or the unreviewed form) comes back, and a new apply needs a new approval id. This is the same outcome as a definite `apply-refused` that arrived late. |

Both kinds are accepted only when all of the following hold. Otherwise the reducer answers
`(rejected not-the-unknown-confirmed-apply)`:

- the confirmation still names this op and this candidate;
- an `unknown (op)` was journalled for this op;
- op is the only unresolved operation;
- nothing is outstanding in the ledger;
- the phase is the `reconcile` that the unknown left;
- nothing is pending;
- the candidate still meets the ready guard: tested, required checks done, and reviewed or waived under a
  `review-waivable` policy.

`reconciled-not-applied` is additionally refused if a `stale` was journalled since the apply's `approval-needed`.
`applied-confirmed` is not refused for that reason, because the landed apply is itself a likely cause of the stale.

## Fallbacks (journal under a new obs id)

- **Rejected `applied-confirmed`:** journal plain `reconciled (op)` with the readback as evidence. This happens when the
  confirmation was already cleared, for example by a stop, a supersede or a late failure, which turned the apply into
  debt; or when there is other debt; or when the task is terminal. A stopped task stays stopped. In a live phase the
  controller re-reads, which is correct, because the origin did change.
- **Rejected `reconciled-not-applied`:** journal `reconciled-current (op cand)` if its own rules hold (fresh
  generation, re-test and re-review). Otherwise journal plain `reconciled (op)`.
- **Readback inconclusive:** journal nothing, and retry the readback on a later wake. op stays unresolved.

## Also changed: an R3.12 gap found while testing

`reconciled-current (op cand)` is now refused with `origin-stale-since` if a `stale` was journalled since op was
created. Op creation means: `dispatched`, `approval-needed`, `proposal-executing` or `think-started` naming op. An op
with no creation in the journal, such as an open, counts any stale.

In R3.12 it was possible to drain a run with `stale`, so the phase was needs-read, and then re-retain the candidate by
readback, skipping the read. When this rejection happens, the host journals plain `reconciled (op)`.

One carried R3.12 test was adapted for this. Its unresolved op `x` had no creation after an earlier stale, so a run
dispatched after the read now stands in for it. The test's assertion is unchanged.
