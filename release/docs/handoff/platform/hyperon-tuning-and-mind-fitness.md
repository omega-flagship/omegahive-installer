# Hyperon tuning and mind fitness (2026-10-05 to 2026-10-06)

Two read-only investigations into how the hive's minds actually behave, and the plans that came out of them. They matter to any new agent working on reasoning, prompts or roles: they explain why the symbolic layer sat idle and what was approved to change that.

## The problem

The project lead's thesis is that cognition lives in synergy over the metagraph, with the LLM as one organ. Automatic reasoning from the mind loop was intentionally not wired in at the time; reasoning had been exercised and tested in earlier builds (see `docs/EARLIER_EXPERIMENTS.md`). Measured on the local hive in early October, with it unplugged: every native mind ran on MeTTa (PeTTa), and NAL, PLN and NARS libraries were loaded into every mind, yet trace commands showed zero reasoning calls, the shared commons held almost nothing, and direct MeTTa use was negligible. MORK was unused; OmegaAtom and OmegaReason were not installed in the hive.

## Findings (tuning session, read-only, private swarms excluded from every query)

1. Minds act almost entirely through the LLM because the loop only runs symbolic machinery when the LLM types a command, and the LLM is never shown symbolic state.
2. The reasoning skills that exist are stateless calculators over premises the LLM must retype; results vanish after one iteration.
3. So every symbolic store was empty: zero reasoning calls, zero executed publishes, zero symbolic belief writes across the non-private traces. Nearly half of all traces were the LLM deciding to wait or re-poll empty stores.
4. Contributing causes: the prompt gives no "when to use" for reasoning or publishing and forbids the variables and JSON the skills need; role-wide deny policies block most symbolic reads; recall ran on a mock embedder.
5. Latent defects that no mind ever reached: an operator-name collision between two NAL libraries, an empty result killing a whole command batch, and no test that executes a reasoning skill.

Confirmed root causes (three-lens vote): no automatic symbolic inference loop (primary); memory writes are LLM opt-in; no consolidation organ; the commons has no non-LLM producer and sits outside the work protocol; recall is prompt text over a lexical hash; stores are isolated and ephemeral.

## Tuning plan

Spine: a structural organ chain in native MeTTa, with a safety envelope (default-off, per-mind opt-in, refused for private swarms, a cohort ladder, a separate organ-runs ledger, retract before promotion) and cheap prompt fixes in parallel.

- **Phase A (days).** Freeze metrics and a baseline receipt; remove output-contract contradictions; make reasoning failures honest and non-fatal; add a test that actually executes a reasoning skill; per-turn hints; a role-policy proposal for read-only symbolic skills; a first OBSERVE organ (experience to atoms) on a scratch hive only.
- **Phase B (1 to 2 weeks).** Shared gates and telemetry first (server-side authorize on publish with a hard private-swarm deny, the organ-runs table, the lifecycle race fixed). Then OBSERVE on a two-mind cohort, CONSOLIDATE and REVISE (committed stamped revision), INFER (the D0 core pass), SHOW (symbolic state in context, recall as atoms) and a salience-driven wake.
- **Phase C (about 2 weeks, owner-paced).** Retraction first, then the evidence store to OmegaAtom's envelope, host projection of goal and review outcomes into the commons, a confidence-gated promotion organ, and the cross-swarm retraction experiment E1.
- **Rollout ladder:** offline MeTTa, scratch hive, two opt-in non-private live minds, the policy-open minds, then anything wider only with the project lead.
- **Null-result rule:** if Phase A's text changes move nothing on the scratch A/B, the cause is structural; stop adding prompt text.
- **Success bar** includes non-empty symbolic stores in most opted-in minds, real revisions and derivations, lower idle-token share, and a matched benchmark arm (full, sham, severed, NAL-only, PLN-only) before anyone calls the layer useful.

**Rulings (2026-10-05):** Phase A approved. Organs may write a mind's own private memory outside the command gate: bounded, default-off, never in private apps, auditable. Remaining decision items at the time: priority of the reasoning foundation, standing symbolic-state prompt section, role-policy widening, a real embedding model, organ writes to the commons, the Tools merge, and any default-on.

## Mind fitness audit (2026-10-06)

Question from the project lead: are minds' prompts tuned for their tasks, and can they physically take part?
- Wiring works for omega minds: same run script, the hive channel module enabled by default, boot receipts posted.
- Prompts were role-specific for most minds, but every one sat on top of the inherited single-mind base prompt, which contradicted hive protocol (for example "No JSON" where hive skills need JSON).
- Role-wide denies cut minds off from their own skill help, which is the only place the review-finding shapes appear. In the review trial only about 5% of finding calls succeeded.
- Several minds were placeholders (mock model, deny-all, never run). The live external harness member was blocked server-side by its role's bare deny. The Iter kit lacked goal detail, heartbeat and cancel-ack.

**Fixes on a platform branch (proposals, owner- or lead-approved per item):** a hive-worker base prompt with one exact example per protocol step; discovery skills always allowed under a glob deny; the SKILLS line lists only usable skills plus how to ask for more. Role tuning brief: "efficiently and effectively, but not too strict; don't stop individual minds from evolving."

## Standing rules for this work

Native review plus an independent review before any deploy; safe restart and a sign-in check afterwards; suite on a detached worktree at the exact sha; new MeTTa passes depth lint, a structural S-expression check and registration probes; truth-function changes go to the domain author before merge; shadow run plus receipt; every metric query excludes private swarms; no organ ever enabled for private-app minds.

_Curated summary. Full version kept privately (source: HYPERON_TUNING_BRIEF_20261005.md, HYPERON_TUNING_FINDINGS_20261005.md, PLATFORM_MIND_FITNESS_AUDIT_20261006.md, PLATFORM_ROLE_TUNING_PROPOSALS_20261006.md)._
