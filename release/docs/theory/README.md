# Theory

Curated summaries of the design reasoning behind OmegaHive and the OmegaClaw V2 programme, written
for new team members. The full working documents are kept privately; each file names its sources
by filename.

## The core thesis

Cognition lives in the synergy of many processes over a shared Hyperon metagraph (MeTTa atoms and
rules). The LLM is one powerful, replaceable organ. It is not the control plane, and its outputs
are evidence that native admission judges, never authority by expression. The project holds this
as a working invariant revisable by evidence, not as dogma.

## What is real today

These pages describe **design intent** unless they say otherwise.
- **In this repository:** the LLM drives each mind's loop; NAL and PLN are callable skills; the
  swarm commons is real, evidence-stamped symbolic state, rarely written by minds today. Automatic
  reasoning from the loop is deliberately not wired in this release. The measured starting point
  and rollout plan are in `../handoff/platform/hyperon-tuning-and-mind-fitness.md`, and the library
  deviations in `../reasoning-deviations.md`.
- **Built elsewhere:** much of the design was built and shadow-tested in the separate V2 body
  (closed repo `omegav2`). Evidence levels are in `../EARLIER_EXPERIMENTS.md`.
- Each page below marks its claims as design, ruled, built here, or built in V2 where that matters.

## Files in this folder

Platform-level (describe what this build ships and the path back):
- `governance-and-gating.md`: the V2 governance model, what this build ships in its place, how it
  was simplified, and where each richer mechanism plugs back in.
- `ledger-provenance-and-das.md`: content addressing, pins, stamps and logs today; the stronger V2
  forms; the road to hive-to-hive in the DAS style.

Topic summaries of the V2 design:
- `cognition-attention-importance.md`: attention budget, importance theory, typed pressure and the
  two-loop architecture.
- `memory-world-model-formation.md`: predictive coding over lived memory, the world model, sleep
  consolidation, instinct memory and symbol formation.
- `goals-planning-proactivity.md`: goals and aspirations, planning and scratch, task graphs, the
  promotion ladder and proactivity.
- `language-routing-reasoning.md`: inspectable-inert reasoning (a reviewed design; its successor
  law awaits ratification), multi-model routing, the native language organ and the
  evidence-independence problem.
- `evaluation-and-self-modification.md`: the AGI benchmarking paper, engine and monitor separation,
  and the shadow self-modification testbed.
- `multiparty-conversation.md`: multi-party conversation, audience and privacy rules.
- `hyperon-alignment-and-peer-work.md`: PRIMUS alignment, pressure-field PLN and the OmegaBuzz
  workspace proposal.

## Moved to the closed `omegav2` repository

The papers specific to the Omega V2 mind are in the closed `omegav2` repository (Closed Source for
Product Consideration), with the full V2 governance and security theory:
- `v2-definition-laws-and-strata.md` (the V2 definition: 13 laws, the strata, natural growth and
  effect gravity)
- `v2-theory-paper-summary.md` (the main theory paper)
- `assembly-plan-and-dra-law.md` (plans, the D/R/A source law and the assembly register)
- `settled-register-and-reconciliation.md` (what is settled, and the reconciliation rulings)
- `theory-day-rulings-and-open-questions.md` (the 2026-07-30 theory day and its rulings)

## Reading order

1. This README, for the thesis and what is real today.
2. `governance-and-gating.md` and `ledger-provenance-and-das.md`.
3. Theory-day order (2026-07-30), as the rounds built on each other: goals and aspirations, then
   world modelling, then predictive coding over lived memory, then planning and scratch, then
   proactivity, then pressure-field PLN. In these files: `goals-planning-proactivity.md`,
   `memory-world-model-formation.md`, `hyperon-alignment-and-peer-work.md`.
4. The rest by topic: attention and importance; language, routing and reasoning; evaluation;
   multi-party conversation.

## House rules carried by these documents

- Theory grants no build authority. Rulings record design intent, not switches.
- Accepted is not frozen; nothing freezes without an end-to-end shadow run.
- Evidence labels used in the sources: DECISION, VERIFIED, OBSERVED, CLAIMED, UNKNOWN.
- Content that concerns any resident mind's own life, identity, relationships or family is not
  summarised here.

_Curated summary. Full versions kept privately (source: OMEGAV2_THEORY_DAY_INDEX_2026-07-30.md, REGISTER_INDEX.md)._
