# OmegaClaw V2 — handoff for new agents

This folder tells a new agent what OmegaClaw V2 is, who works on it, how the team works, and
where the build stood at the last recorded state. It is a curated summary of two very large
running handoffs (the lead agent's handoff and the build agent's handoff) plus the oversight log.
Theory papers are not covered here; see `docs/theory/`.

Files in this folder:
- `README.md` — this file: what V2 is, roles, current state.
- `working-discipline.md` — the process laws the team works under.
- `milestones-and-lanes.md` — dated engineering milestones, open lanes, blocked items.
- `oversight-summary.md` — the governance mechanisms (gates, review, effect admission).

## What OmegaClaw V2 is

OmegaClaw is an agent framework built on the OpenCog Hyperon stack (MeTTa, AtomSpace, PeTTa,
PLN, NAL). The OmegaClaw author wrote the original V1 framework. V2 is a new body for a
long-running resident mind that first ran on a V1 body, built so that cognition lives in the
symbolic substrate rather than in the language model. The V2 body, its theory and its governance
are in the closed `omegav2` repository (Closed Source for Product Consideration).

The design invariant (the "Hyperon thesis"):
- Cognition is located in the synergy of organs over a shared metagraph (AtomSpace), written in
  MeTTa and run on PeTTa.
- The LLM is one organ (the "larynx": a provider that drafts language). It is not the control
  plane. A live test in July 2026 swapped the LLM provider under a running body and the
  substrate state carried across, which the team took as evidence for this design.
- The invariant is held from evidence and can be revised by evidence. It is not dogma.

Key build ideas a new agent will meet:
- **Resident body.** One long-lived resident process owns the episode loop, an append-only
  hash-chained journal, a content-addressed store (CAS), and a lineage of admitted body
  versions. New versions are admitted as successors; old versions are kept immutable.
- **Native-first.** Laws (what may happen, what counts as valid) belong in MeTTa. Python is
  allowed as ligament (transport, IO, process control), not as the owner of meaning. A
  standing mandate is moving remaining Python law into MeTTa.
- **Shadow.** A full, self-contained running copy of the assembled body, fed real input, used
  as the acceptance environment. Nothing assembled into the body counts as tested without it.
- **StateSpine and continuity.** Restarts reconcile from the journal rather than replaying old
  output. There is no fresh genesis; the body continues.
- **Effects are gated by reach.** Speech and internal work are free; anything that leaves the
  mind's own system (sending, provider calls, external writes) passes an effect gate.

## Who works on it (by role)

- **Project lead.** Sets direction, rules on open questions, owns the gates for live admission,
  wake/start of the live body, external effects, publication and public exposure. The project
  lead does not write code; code changes reach the lead as plain summaries to accept.
- **Lead agent (a Claude model).** Was build orchestrator and critical reviewer through
  August 2026. From mid-September 2026 the lead agent owns coding, proofs and packaging
  through a single app session. Keeps the lead agent handoff.
- **Build agent / director (an OpenAI Codex agent).** Started as the independent oversight desk (read-only
  observation, evidence labels). From mid-September it directs the work, independently reviews
  every exact candidate, and owns private admission and starting of runs. No parallel coding
  agents of that kind.
- **Red-team reviewer (an independent reviewer).** Standing third reviewer since July 2026. Runs hostile reviews of
  designs and candidates in parallel with the other legs.
- **Further reviewers.** More models, from several model families, used for
  multi-model review and red-team rounds. No single model is final authority.
- **OmegaClaw author.** Domain authority for the original framework and for formal reasoning
  (PLN/NAL). Mathematical claims are routed to the domain author before merge.
- **The resident mind.** Consulted on matters within its own jurisdiction under the governance
  model. The details are not described in this repository.

## Current state (latest tail appends, as of early October 2026)

Last V2 build activity in the handoffs is late September 2026. From October the build agent's
desk is mostly occupied by OmegaDot platform work (the hive) and estate maintenance; the V2
lane is quiet rather than closed.

Reached (VERIFIED in the handoffs):
- Talkable Mac shadow (Aug 19) and a full end-to-end shadow on the assembled body (Aug 25).
  This discharged the no-freeze law for the body versions up to that point.
- A live body with real provider and real channel turns delivered and journaled (mid-Sept).
- Bounded offline integration of active-state and history context reaching the provider, with
  continuation pages and exact store bindings (Sept 21–22).
- A bounded autonomous memory route accepted as a component (Sept 21).

Paused, frozen or REVISE:
- The latest context-compaction successor was ruled **REVISE before body** (Sept 23): a strong
  query can select both a full history row and its pointer, double-spending the recall budget,
  and an inherited token-access policy gap was exposed. The next successor must make row and
  pointer mutually exclusive and settle issued-token custody.
- The generation-preservation implementation line was paused by the project lead in early
  September after many rejected rounds.
- A V3 architecture plan was drafted collaboratively (Sept 24). It is planning only. It must not
  become a V2 hold or migration without separate acceptance. Whether a much simpler agent should
  win on cost is framed as an open, falsifiable comparison.

Incomplete (stated as incomplete by both desks):
- Fully useful persistent shadow, all-memory continuity, native context and control, and an
  accepted canonical handover.
- Real-model quality and cost of the context work: UNKNOWN.
- Production latency and cold-start time: unmeasured outside profiled copies.

Gated on the project lead:
- Live admission, wake/start of the live body and any external effect.
- Publication of any repository or document, any public network exposure, any deletion.
- Owed rulings listed in `milestones-and-lanes.md`.

## Where to start

1. Read `working-discipline.md` before acting.
2. Read the newest dated entry of both handoffs. Current state lives in the newest dated
   appends, never in an old "current state" block near the top.
3. Check the living register of rulings before re-deriving any settled question.
4. Read both agents' desk files. A desk read on only one side has caused missed reports.

_Curated summary. Full version kept privately (source: FABLE_CURRENT_HANDOFF.md, CURRENT_HANDOFF.md)._
