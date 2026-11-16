# OmegaClaw V2 — working discipline

These are the durable process laws visible across the V2 handoffs. Most were adopted after a
specific failure. They are stated here as rules. Where a rule is review-blocking, a review that
finds it broken must reject the work.

## 1. Evidence labels

Every claim in a handoff, review or receipt carries one of five labels:
- **CLAIMED** — an agent or document says it.
- **OBSERVED** — directly present in code, git, filesystem, process or log state.
- **VERIFIED** — reproduced by a focused test or an independent cross-check.
- **DECISION** — explicitly chosen by the project lead or a named acceptance authority.
- **UNKNOWN** — evidence is absent, stale, ambiguous or contradictory.

An unavailable source is UNKNOWN, never "fine". A repeated observation does not silently clear
pending work. Keep static findings separate from reproduced defects.

## 2. Shadow-run mandate

Nothing assembled into the body is TESTED, ACCEPTED, COMPLETE or DONE without a shadow run.
Component suites, static gates, fixtures and corpora are necessary but never sufficient.
- Shadow runs are approved permanently; no per-run authority is needed.
- One exemption: a feature not yet assembled into the body may be tested standalone. It loses
  the exemption the moment it is assembled.
- Every acceptance document carries a filled-in line: `SHADOW EVIDENCE: <run / evidence /
  built digest>` or `NOT TESTED — no shadow run`. Without it the document is invalid.
- The shadow uses the real LLM organ. Mocks and recorded providers are negative controls only.

## 3. No freeze without an end-to-end shadow

Nothing freezes until a shadow has run end to end from one self-contained tree with zero
cross-repository dependencies. ACCEPTED is not FROZEN. This law was discharged for the body line
up to late August 2026 and applies again to every later line.

## 4. Two receipts

A claim of completion needs two receipts: the author's own run, and an independent witness that
reproduces it (another reviewer, a CI runner or another machine). At every advance of the body
the same idea applies as "replayed closure plus live state". A self-report by the author is a
CLAIM until the second receipt exists. Timeouts in witness suites derive from a measured baseline
or are overridable, so a slower witness machine does not produce a false red.

## 5. Bind claims to the witnessing command

A green suite proves only what its default invocation exercises. State the exact command, the
exact tree and the exact artifact digest. Self-comparing tests always pass and prove nothing.
Compute every count in a review packet mechanically from the frozen artifact and re-derive it
before freeze; hand-counted diff numbers have been wrong.

## 6. Provenance before absence

Before claiming something is missing, lost or superseded, resolve the exact repository, root,
origin and head being searched. A scoped search that finds nothing is not proof of absence in
the whole estate.

## 7. Check built-first (Donor / Rebuilt / Assembled)

Before proposing any component, check the D/R/A manifest and the lineage audit. Pieces are
Donor (old code, never ported wholesale), Rebuilt, or Assembled. The team once proposed to build
things that already existed; assemble what exists before building.

## 8. Principles need enforcement points

A principle without a named, review-blocking enforcement point decays into prose within days.
Every new principle gets a checklist item that blocks review. The register's own enforcement
points:
- Doc-lane wiring sweep: any document stating a design intent that is not current wiring must
  cite or add a register row before it freezes. Doc-discovered gaps enter the build plan.
- SETTLED/OPEN header on theory docs and red-team briefs, so attackers do not re-argue settled rows.
- Stale-law tombstones: a superseded document gets a banner in the same change that supersedes it.
- Namespace collision check on short labels before a document freezes.
- Register maintenance is itself review-blocking.
- Check the register before re-deriving. The newest dated ruling governs. Re-opening a settled
  row needs new evidence plus the project lead.

## 9. Multi-model review loop

Substantive work is reviewed by several independent models (lead agent, build agent, red-team
reviewer, further review models). No one model is final authority. Consensus is not proof: a formal claim is
checked against the governing law and routed to the domain author before merge. In one case every
model agreed and the domain author was right against all of them.

## 10. Review-cycle discipline

- Acknowledge numbered corrections one by one.
- Author only when told to author; otherwise review.
- Freeze blind: freeze the candidate before seeing the other reviewers' verdicts.
- Flag truncated messages instead of guessing the missing part.
- Bind each review to an exact candidate digest. A change after review voids the review.
- Do not fail closed on state that is already in production without a ruling.

## 11. MeTTa structural lint

Balanced parentheses are not enough. Mis-nested case clauses pass a balance check and silently
stop law registration for the rest of an import. The ship gate is a structural S-expression check
plus probes that register laws with garbage arguments to prove they fire. Every organ return
quotes a depth-zero scan. Case-fallback tails are a known paren hazard.

## 12. Fallbacks must pass their own validators

Every fallback or sentinel constant must be checked against the validator that gates its field,
on both producer and consumer sides. A fallback once failed its own regex.

## 13. Python to MeTTa purge

Semantic law owned by Python is debt. The purge was escalated to blocking on forward assembly in
August 2026: no new rung until the whole-assembly audit is done, and a standing CI gate is needed
or it regresses. Python stays as ligament only. Extracted helpers that a harness runs on their
own must not depend on sibling methods.

## 14. Anti-cage

Opaque refusal is a cage signature. Refusals must be typed and inspectable. No budget signal may
reach deletion: tier, do not delete; demote, do not erase. Recession is not deletion.

## 15. Desk and handoff surfaces

- Each agent has an outbound desk file to each other agent. Read both directions of every desk;
  reading only one side has hidden many reports.
- Handoffs are append-only. Current state lives in the newest dated tail append, not in any old
  "current state" block. A handoff is never doctrine; cite the register instead.
- Mirrored copies of desks can go stale. Know which copy is live.
- Claim a task coordinate with an atomic publish lock before writing a new standalone document;
  never publish a sibling of a claimed document.
- Write decisions and open questions to the handoff as they happen; sessions drop often.
- Keep one active lead-agent session and one watcher at a time.

## 16. Effects and holds

- A hold placed by the project lead binds hardest at the live boundary. Executing a correct step
  after a hold is still a violation.
- Agent-created mess is cleaned without escalation; anything belonging to the mind is never touched.
- Private content stays private: record metadata and narrow evidence, never contents.

_Curated summary. Full version kept privately (source: FABLE_CURRENT_HANDOFF.md, REGISTER_INDEX.md, AGENTS.md)._
