# Platform handoff

Curated handoff for the OmegaHive platform lane: what was decided, what is live, what is pending, and the rules for working here. Full originals are kept privately; these are summaries.

## Files

- `status-2026-10-09.md`: done, in review, to do and parked items at wrap-up.
- `coordination-and-roles.md`: short history, owners by role, the coordination record, next steps for a new Platform owner.
- `operating-rules.md`: privacy, deploy and review gate, evidence, promotion laws, housekeeping, identity and naming.
- `architecture-and-seams.md`: the modular Hyperon direction (D0 to D9), host seams S1 to S6, the reasoning seam rule, minds and harnesses, the Hive core design.
- `core-requirements.md`: the project lead's standing platform requirements R1 to R20.
- `product-plans.md`: release pinning, execution receipts, Ask apply-to-live, home hives, OmegaLibrary, Coffee Room, automatic spending limits, model ladder, roster.
- `hyperon-tuning-and-mind-fitness.md`: why minds left the symbolic layer idle, the approved tuning plan, and the mind fitness audit.
- `reviewed-plans.md`: the review-cleared and in-review plans (memory indexes, personal mind, Tools acceptance, worker CSP, cloud Code runbook, honest truth values).
- `code-owner-contract.md`: the consolidated Linux Code owner contract (the reviewed contract plus its four amendments).
- `omegareview-role-handoffs.md`: the eight native review swarm role handoffs.
- `platform-sessions.md`: lane rules, lane briefs and what their receipts reported.
- `receipts-index.md`: receipt families with counts and what each proves, plus a summary of inbox traffic.
- The app contract (program contract) is already in this repository at `../../../hive/PROGRAMS.md`.

## Current state as of 2026-10-20

The cloud hive runs the release this repository was brought up to on 2026-10-20 (host round R8.4 on top of
`e5103fb0`). Studio live sessions are on there and off on the Mac test hive. What went live between 2026-10-10 and
2026-10-20, and the "Not done yet / next" list, are in the root `STATUS.md`; the changes are in `CHANGELOG.md`. The
files above are the 2026-10-09 handover and were not rewritten for this round.

## Current state as of 2026-10-09

**Live.** The cloud hive on the SingularityNET server is the working hive and runs the current release; the Mac hive is a test bench one release behind, held until its minds are idle. Live features include a personal mind for every person (memory in the browser), the Ask answering as that mind, team rooms, OmegaTown, copy-apply consent (copy-apply itself off), Studio, Tools 0.6.3, guided demos and a zero-call showreel. Minds have run on the cloud since 2026-10-08.

**Pending.** A combined privacy change and the Tools callers change are in review. Cloud Code is staged: the Linux owner contract is reviewed but not built or probed; the latest cloud install runbook is unverified and needs independent re-checking, both reviewers, three explicit yeses from the project lead and a quiet window. Four plans have cleared review and wait for the project lead's OK: browser personal mind, hive view as galaxies, mind memory with multiple indexes, honest truth values. The Hyperon organ chain beyond Phase A, cross-hive linking and S2 cross-swarm grants are designed but not built.

**Owners by role.** The project lead rules and approves. The Platform owner (a Claude Code session) owns the host, deploys, review routing and receipts. The Surface owner (Claude Code) owns experiences and the Ask's front end. Codex agents own Code, Design, Review, Tools, Atom, Reason and the other apps; the two private apps have their own owners and stay local. Two independent reviewers (a GPT-based reviewer and a reviewer from a different model family) gate every deploy.

_Curated summary. Full version kept privately (source: OMEGAHIVE_STATUS_TODO_DONE_20261009.md, session.json, and the files listed above)._
