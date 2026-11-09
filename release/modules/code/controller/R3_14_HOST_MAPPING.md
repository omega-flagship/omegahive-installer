# Coding controller R3.14: host mapping for plan members (delta on R3.13)

This note is for the Create plan engine (R4.1). R3.14 lets each per-piece task run as a coding controller in its own
right, in a new `plan-member` profile, instead of building pieces through a model goal that returns files.

- **Reducer:** `coding_controller_r3_14.metta`. Pin it by the sha256 of the committed file.
- **Tests:** `test_coding_controller_r3_14.metta`, 430/430 under `.runtime/PeTTa/run.sh`, run from that directory.
  That is all 353 R3.13 tests, unchanged, plus 77 new ones.
- **Unchanged:** root-suggest and delegated behave exactly as in R3.13, so `R3_12_HOST_MAPPING.md` and
  `R3_13_HOST_MAPPING.md` still hold for Code requests. `applied` stays the person's own. The state shape (14 fields)
  is unchanged.

## Ctx for a member

`(Ctx <member-task-id> <budget-ref> <person> (<plan-controller> <helpers…>) <max-repairs> plan-member <policy>)`

- **Epoch slot:** carries the member's plan budget reference instead of a request lease. Every observation must carry
  that same budget reference, or it is refused as `wrong-task`.
- **Budget ends:** journal `cancelled`, as for the end of a lease.
- **`<policy>`:** comes from the plan's ReviewFor for this piece:
  - `plan-reviewed`: the plan's review stands in for a per-piece review.
  - `review-required`: the piece gets its own independent review. The author-set rules from R3.12 apply.

  Any other pairing refuses every observation with `profile-policy-mismatch`: `review-waivable` with plan-member, or
  `plan-reviewed` with any other profile.

## Actions (`next-action-for plan-member`)

| Action | Host |
|---|---|
| `(do (piece-open t))` | Open the piece's own fork, path-scoped to the piece, then journal `opened`. |
| `(do (host-read find-the-relevant-code \| read-again-before-editing))` | Read the piece scope (no model), then journal `read`. |
| `(think make-the-smallest-change \| repair-from-the-failing-output)` | As in R3.12: `think-started` first, then the helper. On a repair the prompt carries the `member-refix` failing reference. |
| `(do (code-exec t))`, `(do (run-check m))`, `(do (review-request c))` | On the piece fork. `dispatched` first, as ever. A review is requested only under `review-required`. |
| `(tell member-ready c)` | Tell the plan that candidate c is tested, its required checks are done, and it is reviewed as ReviewFor says. Nobody is asked to apply. |
| `(rest awaiting-helper \| awaiting-results \| needs-person \| done \| stopped)`, `(do (reconcile op))` | As in R3.12 and R3.13. |

## Observations

| Kind (fields) | Produce it when | Effect |
|---|---|---|
| `changed (c required)` | An edit landed on the piece fork inside the piece path. The host enforces the path and never journals an out-of-piece change. | A new candidate in a fresh validation generation (same as delegated). |
| `proposed (pid edit d)` | The only model proposal a member may make. `read` and `search` proposals are refused, because reading is the host's. `suggest` is refused too. | Same as R3.8. |
| `scope-refused (pid)` **new** | The host checked a **pending or selected** edit proposal and it reaches outside the piece path. Check at selection, before `proposal-executing`. | The proposal is dropped and it costs one repair (blocked past the cap). Once the proposal is executing it is too late: report `proposal-done` or `unknown (op)`. |
| `integrated (op cand ckpt)` **new** | The plan integrated this member's candidate. `op` is the plan's integration operation id, unique for the task's lifetime. `ckpt` is the plan checkpoint reference. | **The only producer of `delivered` for a member.** Accepted only in `ready`, for the current candidate, with nothing pending, confirmed, outstanding or unresolved, and with tested, checks done and review as policy says. Otherwise the answer is `not-the-member-ready-candidate`. A reused op gets `operation-id-reused`. A terminal task gets `terminal`. |
| `member-refix (op cand failing-ref)` **new** | The plan's check failed for the member-ready candidate. `failing-ref` points at the failing output; keep that output as evidence for the repair prompt. | One repair (blocked past the cap); the phase moves to `red` and the candidate is refuted, so no readback can re-retain it. Accepted only in `ready`, for the current candidate, with a reference that is not `none`. A refix for a stale candidate (the member has moved on), or one that arrives after delivery, is refused. |

### Note on `member-refix` fields

`member-refix` carries `cand`, a field the builder's `(op failing-ref)` form did not have. Without it, the reducer
cannot tell a refix for a superseded candidate from one for the current candidate. Every other result kind already
names its candidate. A failure the plan finds **after** `integrated` belongs to the plan, which handles it with a new
member task; a delivered member stays delivered.

## Not in a member's profile

These kinds answer `not-in-plan-member-profile`:

- `approval-needed`
- `approved`
- `applied`
- `applied-confirmed`
- `reconciled-not-applied`
- `apply-refused`
- `changes-requested`

`candidate-retained` keeps its R3.11 answer.

The person speaks to the plan, not to the member. The plan routes the person's wishes back through `member-refix`.

`integrated`, `member-refix` and `scope-refused` answer `plan-member-only` under root-suggest and delegated.
