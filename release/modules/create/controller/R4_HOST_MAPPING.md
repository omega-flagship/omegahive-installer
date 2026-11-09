# Create plan controller R4.3: host mapping

This note is for whoever builds the host engine for Create's plan controller. It lists every observation and action,
who produces or consumes it, and what the host does.

R4.0 (143/143), R4.1 (228/228) and R4.2 (253/253) stay in this folder unchanged. The host should build against R4.3.

- **Reducer:** `create_plan_controller_r4_3.metta`. Pin it by the sha256 of the committed file.
- **Tests:** `test_create_plan_controller_r4_3.metta`, 277/277 under `.runtime/PeTTa/run.sh`, run from that directory.
  - Parts 1–4: every R4.2 test, with two shapes adapted: suite paths, and the fifth Needs field.
  - Part 5: the R4.3 rule.

## What R4.3 changes

This comes from the plan engine's review. A piece must never own the acceptance suite's files, so no build can edit
the checks that judge it.

- **Suite paths.** `tests-authored` / `tests-detected` are now `(op suite (check-paths…))`. The host lists every file
  of the suite. The observation is refused when any piece's files include one (`piece-owns-suite-file`) or when the
  list is empty (`suite-names-no-check-path`). On refusal the tests op stays open: the author writes the suite
  elsewhere, or the host reports `unknown` and `reconciled`, which spends a retry.
- **Reserved paths.** Needs gains a fifth field: `(Needs design-need tests-mode (ReviewFor…) (AssigneeCap…) (Reserved path…)…)`.
  Reserved atoms are data, for example import-shadowing names such as `json.py`, `typing.py` or `conftest.py`.
  `planned` is refused when any piece's files include a reserved path (`piece-owns-reserved-path`). A malformed
  Reserved atom, or a missing fifth field, is `invalid_needs`.
- **Reducer symbols.** `none`, `True`, `False` and `Empty` are never artifact kinds (`reducer-symbol-kind`). A
  ReviewFor naming `none` is `invalid_needs`.
- The state view gains `reserved` and `suite-paths`.

## What R4.2 changed

## What R4.2 changes

This comes from the plan engine's live runs. In R4.1, only lost start, route-fix and run-checks operations counted
against a budget, so a lost integrate, review, preview, author-tests or design could repeat unknown → reconcile →
retry without end. In R4.2:

- Ctx Caps is `(Caps piece-repairs fix-rounds retries)`. `retries` is the plan's retry budget, separate from fix
  rounds.
- Every `reconciled (op)` spends one retry, whatever the operation's kind: plan, design, author-tests, detect-tests,
  run-checks, start, route-fix, review, integrate, preview, or a host effect outside the ledger.
- Failed plans and failed previews spend from the same budget.
- Past the budget, the plan blocks with `(cap-exceeded lost-operations)` and asks the person. The person's answer
  resumes it with a fresh budget.
- A deploy is never retried by the reducer. Its readback is `deployed-confirmed` or `reconciled-not-deployed`, and a
  new deploy needs a fresh go from the person.
- Every other path that repeats work is either capped (piece repairs, fix rounds, retries) or goes through the
  person: an answer, a go, a withdrawal or a cancel.
- **Under it:** each plan piece is built by its own R3.12 task (`modules/code/controller/`). The task id is the `task`
  in `piece-started`.
- **Invariants:**
  - Journal before effect. A rejected observation means no effect.
  - Operation ids are unique for the plan's lifetime. A rejected observation still uses up its id.
  - `deployed` comes only from the person's go: either its own `deployed`, or the readback `deployed-confirmed` of
    that same deploy.
  - Uncertainty never releases a hold.
  - Readback is never lost.
  - The reducer always returns exactly one state. An observation that is not ground, or does not fit its kind's
    shape, is refused.

## Shapes

| Item | Shape |
|---|---|
| Ctx | `(Ctx plan epoch person (authors…) (Caps piece-repairs fix-rounds retries) budget review-policy (ReviewFor…))`. See the Ctx details below. |
| Plan needs | `(Needs design-need tests-mode (ReviewFor…) (AssigneeCap selector n)… (Reserved path…)…)`. The plan may add ReviewFor atoms but never remove the hive's. It may cap any selector, and may reserve paths that no piece may own. |
| Graph node | `(Piece id assignee (kinds…) (deps…) (files…))`. id is a symbol; kinds, deps and files are lists of symbols; kinds and files are non-empty. Checked with OmegaPlanner's `validate_plan` codes, plus `file_owned_twice`. |
| Assignee | `(Assignee team swarm)`, `(Assignee mind agent)`, `(Assignee capability cap)`, `(Assignee hive hive cap)` or `(Assignee open cap)`. `open` means any mind or team that offers cap, the whole hive included. The reducer treats it as data. |
| Resolved | Whatever the host resolved: `(team t)`, `(mind m)`, `(hive h agent)`, `(capability c)`, `(hive-wide c)`, and so on. A mind or team selector must resolve to exactly itself; a hive selector to that hive. |
| Evidence | `none`, or `(kind ref)`. Example: `(render shot1)` for a design review. |
| Observation | `(O id kind plan epoch fields)`. It must be ground, its id and kind atomic, and its fields must fit the kind's shape. |
| Query | `(may-start ctx state)` lists the pieces that may start now, under the budget and the per-assignee caps. |

**Ctx details:**
- `budget` is the most pieces that may build at once in this plan.
- The `ReviewFor` atoms are the hive's catalogue of reviews. `(ReviewFor kind review-kind evidence)` says that an
  artifact of `kind` needs `review-kind`, with `evidence` being `none` or an evidence kind such as `render`.
- Every artifact kind in a plan needs at least one ReviewFor, either in Ctx or added by the plan.

## Actions (from `next-action ctx state`)

| Action | Consumer | Host effect, and the observation journalled first |
|---|---|---|
| `(think make-the-plan)` | planner mind | Journal `plan-started (op)`, then call the planner. |
| `(think make-the-design)` | design mind (only for plans with no `design` pieces that declared `design`) | Journal `dispatched (op design plan-ref)`. |
| `(think author-acceptance-tests)` / `(do (detect-tests))` | test author / host scan | Journal `dispatched (op author-tests ref)` or `dispatched (op detect-tests none)`. The result names the suite's check paths, and none may be a piece's file. |
| `(do (run-checks base or ckpt))` | runner | Journal `dispatched (run run-checks ckpt)`. |
| `(do (start-piece p assignee))` | host resolver | Resolve the selector. If someone can take it, journal `piece-started (p task builder resolved)` and open an R3.12 task. If no one can, journal `assignee-unavailable (p)`; do not fall back to someone else. |
| `(do (request-review p cand review-kind))` | reviewer | Journal `dispatched (op review (p cand review-kind))`. Gather the evidence that ReviewFor names; for a design review, render the candidate. |
| `(do (integrate p cand))` | host merge | Journal `dispatched (op integrate (p cand))`. |
| `(do (route-fix p run assignee))` | host resolver | Pick a repairer for the piece's assignee and journal `dispatched (op route-fix (p repairer))`. The repairer is then barred from reviewing. Reopen p's task with the failing output of run. |
| `(tell ask-person q)`, `(tell ask-person (blocked why))`, `(tell ask-person (assignee-unavailable p))` | the person | Show the question, then journal `question-asked (q about)`. For a blocked plan, about is `blocked`; for an unassignable piece, about is `(piece p)`. |
| `(do (preview-deploy ckpt))` | host | Journal `dispatched (op preview ckpt)`. |
| `(tell confirm-deploy plan)` / `(tell confirm-unreviewed-deploy plan)` | the person | Ask for the go in exactly this form. The person's answer is journalled as `deploy-approved (op person form)` with the same form. |
| `(do (deploy op))` | deployer | Deploy under the go. It returns `deployed (op)` or `deploy-refused (op)`. If the outcome is unclear, report `unknown (op)`. |
| `(do (reconcile op))` | host | Read back what happened. For a deploy op, journal `deployed-confirmed (op receipt)` or `reconciled-not-deployed (op)`; a plain `reconciled` is refused. For anything else, journal `reconciled (op)`. |
| `(rest …)` | host | Wait, or the plan is finished. |

## Observations (new or changed from R4.0)

| Kind (fields) | Producer | Effect |
|---|---|---|
| `planned (op Plan graph unknowns Needs)` | planner | Checked to the leaf. The effective reviews are Ctx plus the plan's. A plan whose pieces produce `design` may not declare a separate design phase. |
| `piece-started (p task builder resolved)` | host resolver | Refused when the piece is held by a question or unassignable, when the budget or the assignee's cap is full, or when the resolution doesn't fit the selector. |
| `assignee-unavailable (p)` | host resolver | The piece becomes `(unassignable prior)`. The controller asks the person, and the person's answer to the `(piece p)` question returns the piece to the queue. |
| `piece-ready (p op cand)` / `piece-blocked (p op)` | R3.12 task | op is the piece's open start task or route-fix op. A result from a superseded task is refused (review B2). |
| `dispatched (op review (p cand review-kind))` | host | Admitted only for a review kind the piece's artifact kinds need, not yet passed, not in flight, and not held by a question. |
| `dispatched (op route-fix (p repairer))` | host | Names the repairer, who can then never review. |
| `review-pass` / `review-fail (p cand review-kind reviewer evidence)` | reviewer | Replaces R4.0's four kinds. The evidence must match ReviewFor. The piece is reviewed once every review kind it needs has passed. A fail sends the piece back to its assignee and counts one repair. |
| `review-unavailable (p cand review-kind)` | host | Under review-required, the plan blocks. Under review-waivable, that review is waived and the piece marked unreviewed. |
| `integrated (op p cand ckpt)` | host merge | ckpt must be an id never used before in this plan. |
| `question-withdrawn (q person)` | the person only | Refused for a blocked question (review S3). |
| `question-asked (q about)` | host | Any new question clears a go that was given (review S5). |
| `deploy-approved (op person form)` | the person | Refused while any question is open, and when the form differs from the one the person was shown. |
| `deployed-confirmed (op receipt)` | deployer readback | For an unresolved deploy. The person's go landed: → deployed (review S4). |
| `reconciled-not-deployed (op)` | deployer readback | For an unresolved deploy. It did not land: consent is cleared, there is no debt, and a fresh go is needed. |
| `reconciled (op)` | host | Refused for a deploy. Any other lost operation, of any kind, spends one retry (R4.2). |

## Changes from R4.0, and why

| R4.0 | R4.1 | Why |
|---|---|---|
| team ∈ {studio, code} | `(Assignee …)` selector | Jon: don't lock the team; some pieces need a specialist mind, the whole hive or another hive. |
| review kind from team | review kind from `(ReviewFor kind review-kind evidence)` atoms | Jon: the artifact kind decides the review; new kinds need no reducer change. |
| `review-pass (p c v)`, `design-review-pass (p c v ev)`, and the two fails | `review-pass` / `review-fail (p c review-kind reviewer evidence)` | One pair, checked against the atoms. |
| Ctx lease | Ctx budget, plus plan `AssigneeCap` | Per-plan budget, and per-assignee caps when the plan asks. |
| `piece-started (p task builder)` | adds `resolved` | Records who actually took the piece. |
| `piece-ready (p cand)`, `piece-blocked (p)` | add the task or route-fix op | Review B2: a late result from a superseded task was accepted. |
| `question-withdrawn (q)` | adds `person` | Review S3. |
| `deploy-approved (op person)` | adds `form` | Records that the person confirmed the unreviewed form when a review was waived. |
| a plain `reconciled` settled a deploy | `deployed-confirmed` / `reconciled-not-deployed` | Review S4: avoids a double deploy (R3.13's pattern). |
| a deploy question held the go | any open question holds it, and a new question clears it | Review S5. |
| `is-member` (Prolog `member/2`) | a deterministic `has?` | PeTTa trap found while building: `member/2` returns one result per duplicate and unifies variables. |
