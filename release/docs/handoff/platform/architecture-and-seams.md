# Platform architecture and seams

The durable design decisions behind OmegaHive, the platform that hosts minds, swarms and apps. Written 2026-10-03 to 2026-10-06 and still governing. Status labels: built, approved, proposed.

## Two governing directions (project lead)

- **Modular systems.** Each capability is usable on its own (library, tool, mind, swarm or app). Nobody has to adopt a whole stack.
- **Hyperon principles.** The parts meet in AtomSpace, where PLN, NAL, attention and motivation reason over them. The LLM is one organ, not the control plane. (Design principle. In this release the LLM still drives each mind's loop and reasoning is called as a skill; see §D0 below and the root README.)

## Seam rule (standing, all work past and future)

A feature "takes part" in reasoning when its facts and decisions land as truth-valued, evidence-stamped atoms in a MeTTa commons, integrated by lib_hive revision and stamped so echoes cannot inflate confidence. Reasoning results return as advisory, inspectable inputs. Authority (policy, consent, spending, effects) stays with people and policy. Plain code with no atom trail is a gap.

Built: approvals and people's requests each record one NAL observation in a governance commons; swarm commons carry minds' beliefs. Candidate seams: policy suggestions from the governance commons, service matching, goals and motivation ranking, spend-per-outcome beliefs, reliability beliefs, social/trust metadata, and app verdicts published as evidence. Private apps (Truth, Atlas) take part at interface level only.

## D0. Foundation first

The post-takeover study found: the model is the control plane in every mind; two NAL rule sets clash and duplicate answers; PLN term priors are a stub; a mind's own beliefs are never revised; the commons held almost nothing. Foundation work, reusing donor code from Symega and OmegaV2: one NAL in the mind with PLN in its own space, real PLN priors, stamped revision of a mind's own beliefs, a per-cycle hook where the core (not the model) runs bounded NAL, and the security fixes. Check what is built before building anything.

## D1. One module, many deployments

Each capability ships once as an owner package with a manifest (id, version, provides, consumes, effects described never granted, entrypoints, source pins). The consumer picks a deployment: library, native skill, app (program contract), service, or mind/swarm template. The single registry is the Tools owner's family, slot, implementation catalogue. Private owners use the library deployment inside their own swarm, so their data never travels.

## D2. One substrate, one evidence envelope

All cross-module knowledge is atoms. The envelope (owned by OmegaAtom, accepted as v0.1) adds sidecar atoms keyed by evidence id: Source, Status (observed, inferred, hypothetical, predicted, interventional, simulated, borrowed-prior), Scope, Premises (derived atoms only) and Retracted. Unknown truth is absent, never invented. One observation is f with c 0.5 and its own stamp. Repeated reads are not new evidence. Stamp overlap blocks revision. Retraction is itself evidence; nothing is deleted.

## D3. Reasoning is a faculty, not a coordinator

OmegaReason lives inside OmegaAtom. Atom keeps custody of spaces, envelope, lineage and maintenance. Reason runs inference, hypothesis, attention and meta-reasoning, and only proposes into client spaces through Atom. Its rules are also a library, so any swarm can reason locally and use the Reason service only for specialist work, over the existing bound-request route. No new scheduler, bus or registry.

## D4. Host seams (contracts frozen per seam when built)

| Seam | What | State (lane receipts) |
|---|---|---|
| S1 | `publish_evidence(statement, f, c, envelope)` with capability `evidence:write`; host-issued evidence ids; idempotency key bound to the payload digest; outcome `integrated` means substrate only | lane brief; still gated as of 2026-10-05 |
| S1b | `retract_evidence`; retraction authority checked by the host | lane brief; to ship before any promotion |
| S2 | Scoped cross-swarm reads by explicit grant: exact retained revision, or require-current; digest mismatch, stale revision and closed grant refusals; every read logged | proposed |
| S3 | MCP member bridge: outside members get the same goal, exhibit, artifact, request, capability and evidence tools as native minds, under the same policy names | built in a lane branch (first schema revision; offline and disposable-host tests) |
| S4 | Per-mind tool inventory from a boot receipt the mind posts; no receipt means every skill is unknown; no secrets | built in a lane branch (L0/L1) |
| S5 | Budget correctness: atomic shared reservation across all scopes, output allowance, truncation guard | built; review fixes landed in a lane branch |
| S6 | Improvement delivery: learning events and improvement packages bound to minds through attachments; five distinct delivery states | proposed |

## D5 to D9

- **Shared schemas owned once:** the atom envelope (OmegaAtom) and LearningEvent / ImprovementPackage (OmegaLearn). Consumers do not fork them.
- **Authority invariant:** reasoning and learning produce advice; effect atoms describe, never execute; proposals never mint grants; adoption goes through the five-answer approvals; hard caps stay hard.
- **Acceptance ladder:** L0 owner offline tests; L1 disposable host with real MeTTa; L2 live local hive with synthetic data under a restart hold; L3 native mind run under an explicit cap. Capability claims also need a matched baseline run.
- **Joint experiment E1:** a correction that propagates across modules and survives retraction and restart, scored against sham and severed arms. It falsifies the architecture if the combined arm does not beat the best single arm at equal cost.
- **Process:** owners build in their own folder; the platform integrates and deploys under owners' holds.

## Module boundary (Tools, Atom, Reason)

Tools owns primitive classification, recipes and the catalogue. OmegaAtom owns space custody, the envelope, lineage and maintenance. OmegaReason owns inference. Across any boundary: structured typed data with reviewed operations, variables only in declared slots, no free MeTTa evaluator. Inside a mind's own sandbox, native MeTTa is unchanged. Independently authored engines register with a manifest and a conformance suite, admitted only after the suite passes.

## Minds, harnesses, roles and the holarchy

- A **mind** is a swarm member with identity, role, budget, paying key, approval rules and a harness.
- A **harness** is how a mind runs: Omega (OmegaClaw on PeTTa), Iter, outside member over MCP; Claude Code, Codex, Hermes and generic agents planned. The hive is the one scheduler, budget and gate for all of them. Code-running harnesses are admin-only, folder-confined and hard-capped.
- A **role** bundles prompt, default model and budget, tools and approval rules.
- **Holarchy:** a mind can host an inner swarm and be its face. Goals flow down, results flow up, budgets nest, boundaries hold at every level, with depth and size limits.

## Hive core (approved design, not built)

A living metagraph at the centre of the scene: OmegaAtom as mind, Evolve as body, every other app an organ. Notices arrive in five tiers by salience, not by source (murmur, beat, tug, bloom, breach). Notability is an attention value computed in MeTTa; a discovery blooms only with an independent review or benchmark receipt; dismiss and open actions become per-person NAL evidence. Organs opt in per event kind; private apps send metadata only.

## Related

- Standing requirements R1 to R20: `core-requirements.md`.
- Product plans built on these seams: `product-plans.md`.
- Why the symbolic layer was idle and the tuning plan: `hyperon-tuning-and-mind-fitness.md`.
- App contract: `../../../hive/PROGRAMS.md`.

_Curated summary. Full version kept privately (source: PLATFORM_MODULAR_HYPERON_DIRECTION_20261004.md, PLATFORM_SEAM_CONTRACTS_DRAFT_20261004.md, PLATFORM_REASONING_SEAMS_20261004.md, PLATFORM_ROOT_METTA_FOUNDATIONS_DIRECTION_20261004.md, PLATFORM_HIVE_CORE_DESIGN_20261004.md, MINDS_HARNESSES_ROLES_SHARING.md, PLATFORM_STUDY_20261004.md)._
