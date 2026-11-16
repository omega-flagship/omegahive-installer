# OmegaReview: native review swarm role handoffs

The Review owner (a Codex agent) prepared a native review swarm for the hive and handed each piece to the Platform owner for integration. These eight handoffs describe what was prepared, what was qualified, and what the platform still had to wire. All of it ran on synthetic inputs with a fake process supervisor and no model calls: it proves structure and routing, not live model reasoning.

Shared principles across every role:
- Every review binds to one immutable artifact revision and one versioned mandate.
- Findings, receipts and dissent are retained and attributed. Vote counts are not evidence.
- No role gets execution authority, budget changes, source grants or automatic recommendations from its review output.
- The host, not model text, supplies authoritative records. Checks on request, grant, role, deadline and claim lease must hold again at write time.

## Native swarm (NATIVE_SWARM)

A stopped native configuration: six versioned mandate roles plus a coordinator, seven minds, default-deny skill rules, a mock model and zero budget. One disposable round passed: six claimed requests on one revision, six attributed findings, completed goals, revoked revision access. A landed-schema bridge translates host requests into the admission protocol: it verifies the body digest, artifact ownership, reviewer role and exact versioned prompt and rules, held goal, lifecycle, mandate and target, and refuses stale or mismatched inputs. The platform later provisioned the swarm and added native role-mandate enforcement; wrong-role writes now return a specific `role_not_eligible` refusal. Pending at the time: assigned dispatch, deadline and lease qualification, coordinator synthesis, and an authenticated read-only bridge for Code review.

## Native policy (NATIVE_POLICY)

A proposed exact allow list for specialist roles (goal list and get, claim, cancel acknowledgement, revision read, finding write, review completion) followed by deny-all. The coordinator stays deny-all until its read and aggregation interface is qualified. A later live read confirmed all six specialist roles carry exactly those allows; an extra shell allow is refused by the bridge. Outstanding: return-and-resubmit custody for QC submissions.

## Assigned dispatch (ASSIGNED_DISPATCH)

One review request has exactly one mandate and version. The host finds members of the receiving swarm whose current role carries that mandate. One candidate is assigned; zero or several are refused rather than guessed. An optional reviewer id selects among eligible members only. Assignment confers no effects. 54 pure checks and about 20 host checks passed. No second scheduler or database.

## Terminal result (TERMINAL_RESULT)

A terminal review receipt that generic goal completion lacked: reviewer, subject, recommendation, rationale, and only database finding ids, with an explicit empty-finding case. The host must create finding rows and complete the goal atomically under fresh lease, deadline, cancellation, revision access and role checks. Unstructured completion of a review goal must be refused or marked unqualified, never treated as full coverage.

## Coordinator (COORDINATOR)

Aggregates authorized request views against host-owned assignments for one exact subject. Preserves every attributed receipt and dissent, reports missing coverage, rejects mismatched reviewer, subject or mandate, and returns no automatic recommendation. A six-reviewer host round verified aggregation, including one reviewer holding while five were unresolved.

## Quality control (QUALITY_CONTROL)

An internal QC mind with a separate review-of-review mandate, so it is never treated as a specialist with disposition authority. QC binds to the immutable specialist receipt digest and returns accepted, needs-revision or unresolved with reasons. It cannot change findings, suppress dissent or confer authority. The coordinator checks QC's own claims; there is no recursive QC chain.

## Assurance (ASSURANCE)

Two further roles. A **regression checker** keeps an immutable baseline manifest and reports pass, regression or unknown per invariant after host, role, prompt, tool or policy changes. A **model quality watcher** compares paired frozen cases (known faults, clean controls, ambiguous evidence) with predeclared scoring, case-level results, cost and latency, and no universal score or false statistical certainty. A same-model watcher is correlated, so disputed labels go to deterministic checks and independent human adjudication. A benchmark comparison helper refuses to let improvement elsewhere hide a critical-case regression. Neither role retrains, switches models or accepts goals.

## Symbolic (SYMBOLIC)

A Hyperon projection of review records. Trusted host records become atoms with immutable digests; payloads are canonical JSON in hex so hostile text can never become MeTTa code. Semantic index predicates (review, subject, mandate, recommendation, finding, coverage, quality check) carry their source digest and refuse alteration. Explicit argument atoms (claims, labels, support and challenge edges, resolving checks) feed structural rules in MeTTa that derive missing-support, contested and missing-resolving-check issues, matching the typed baseline exactly in eight scenarios. These are structural checks: they infer no truth, relevance or calibrated confidence. PLN inference and live integration remain later work.

## State at handoff

Qualified: structure, routing, admission, aggregation and inert symbolic projection. Not qualified: live mind reasoning, QC reasoning, coordinator native wiring, per-request spend, restart continuity, and the Code review bridge. Direct delivery to the platform session was unreliable at the time; the file handoffs are the record.

_Curated summary. Full version kept privately (source: NATIVE_SWARM_HANDOFF.md, NATIVE_POLICY_HANDOFF.md, ASSIGNED_DISPATCH_HANDOFF.md, TERMINAL_RESULT_HANDOFF.md, COORDINATOR_HANDOFF.md, QUALITY_CONTROL_HANDOFF.md, ASSURANCE_HANDOFF.md, SYMBOLIC_HANDOFF.md)._
