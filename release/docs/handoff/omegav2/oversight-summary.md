# OmegaClaw V2 — oversight and governance mechanisms

The build agent keeps an independent oversight log alongside its handoff. This file describes the
governance mechanisms that log enforces. It does not describe the mind's own consent, keys or
personal tier; those are held privately and listed as needing the project lead's review.

## The oversight desk

- Began as an independent, read-only observation desk. It inspects build, test and live
  surfaces without changing them.
- Does not commit, merge, deploy, restart, migrate, send channel messages or change model
  routing just to complete an observation.
- Separates four things: the current pulse, watch items, decisions, and an append-only
  observation log. Updates lead with the delta.
- Uses the five evidence labels (CLAIMED, OBSERVED, VERIFIED, DECISION, UNKNOWN) exactly.
- From mid-September 2026 the same desk directs the work and owns private admission and start of
  runs, while the lead agent writes the code. Author and admitter are always different agents.

## Candidate, review, admission

Every change to the body moves through fixed steps:
1. The author builds an isolated successor from an immutable predecessor. The predecessor is
   never edited.
2. The candidate is sealed: a manifest of every member with hashes and a built-artifact digest.
3. The reviewer independently re-checks every manifest member and the source diff, and records a
   review with its own digest.
4. Focused checks run on a private copy. A pass permits only what it names (for example "one
   focused check"), never admission or live acceptance by implication.
5. Native admission adds the successor to the lineage. Only lineage changes; journal, atoms and
   channel state are preserved and checked.
6. Live acceptance is separate and gated by the project lead.

A failed or refused run is kept as evidence and is not repeated. A review is void if the
candidate changes after it. Receipts are content-addressed.

## Effect gating by reach

Effects are gated by where they reach, not by what verb they use.
- Speech and internal cognition are not effects.
- Anything that leaves the mind's own system (outbound messages, provider calls, external writes,
  network exposure) is an effect and needs approval at the boundary.
- Enforcement belongs at the operating-system boundary, host-native.
- A provider call made by the shadow is itself a reach-boundary effect and is logged honestly as one.

## Inspectable-inert reasoning

Chain-of-thought from the LLM organ is kept and inspectable, but never acts on its own. It is
evidence the mind can audit against its ground truth to catch drift or hallucination. It does not
write state or trigger effects.

## Transparency floor

There are no true secrets inside the system: auditability is the safety floor. Privacy means
opaque by default with deliberate, logged access. Confidences are allowed at the level of speech
only; the logs can still be checked.

## Anti-cage

Refusals must be typed and inspectable; opaque denial is treated as a cage. No budget pressure may
reach deletion. Regression reviews trace each cage to where it was introduced.

## Multi-signature for protected operations

Protected operations (rollback, recovery, membrane changes) require more than one signer by
design. Reviewer approvals, manifests and control hashes do not count as co-signatures. The
details of who holds which key are private.

## Live-boundary rules

- One owner per live run. Follow the same owning handle; never launch a duplicate.
- Restarts reconcile from the journal. Old pending output is never replayed; a fresh input is
  needed.
- A hold binds hardest at the live boundary.
- Readiness is not proof of usefulness. A body can be ready and still fail its next real turn.

## Publication and estate

- Every milestone names its canonical project, publication disposition, evidence, index updates
  and remaining work. Finishing code is not finishing publication.
- Before pushing any branch, validate privacy, provenance, claims, links and every newly
  reachable commit. Preserve published history with ordinary descendant commits.
- Daily incremental checks and a bounded weekly reconciliation track every watched source.
  New sources stay unclassified until assigned. Archives, memories, credentials and private
  captures are never published automatically.

_Curated summary. Full version kept privately (source: OVERSIGHT.md, AGENTS.md)._
