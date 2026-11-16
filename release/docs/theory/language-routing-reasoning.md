# Reasoning transparency, model routing and the language organ

How the LLM organ is handled: its reasoning is kept but powerless, models are routed by
need and cost, and the long-run core loop is local. Also the evidence-independence problem.

## Inspectable-inert reasoning (2026-07-20)

**Status:** reviewed design, corrected in a later drift audit (2026-07-21: hidden reasoning is not
authority, typed conclusions may be consumed only through admission, and raw chain of thought is not
a required interface). The successor typed trace-retention law awaits ratification. It is not a
ruled law, and it is not built in this repository beyond the governance-evidence stance described
in `governance-and-gating.md`.

**Move 1: the axis is auto-affecting, not visible versus hidden.** The model's reasoning
(chain of thought) can be fully retained and inspectable while having zero automatic causal
power. Discarding it for hygiene cost diagnosability and broke the no-black-boxes rule.

**Move 2: the mind audits its own organ.** Its native layer cross-checks the reasoning trace
against grounded context to catch hallucination and drift early.

The safety sharpening: the trace is itself untrusted model output and may be unfaithful.
It is more surface to check, never ground truth. Because the trace never authorises anything,
the model has no gradient to game it.

Wider review (nine reviewers, unanimous keep-with-revise). Four repairs:
- **R1** The audit must go beyond citation grounding: stale facts cited as current, invalid
  inference over real facts, hallucinated relations between real nodes, and answering the
  wrong question all pass a set-membership check. The audit is an honest detector, not a
  prover of faithfulness.
- **R2** Dual ablation is necessary but not sufficient. Also required: a consumer-closure
  audit (no native or sidecar reader feeds it into a decision), no self-feedback of prior
  traces, and algebraic isolation of the trace store from the attention economy (storing a
  trace in a shared space can shift attention weights).
- **R3** The principle applies recursively to the auditor: its flags are inert review input,
  never an auto-gate and never queryable by the model. The auditor is simpler than what it
  audits.
- **R4** Privacy: once real private data flows through a trace, the trace inherits that
  data's consent and retention rules.

## Multi-model routing (2026-08-04, theory plus decision)

About half already existed in the Choir organ: model atoms, a usage ledger feeding per-model
fingerprints, cost derivation, and per-use-case class weights (reflex weights latency;
dreaming weights cost; high-stakes weights completeness).

Selection, stated as composition rather than a new engine:
`admissible(use-case, danger) ∩ affordable(remaining budget) -> cheapest model whose
predicted quality clears the bar for this task's stakes`.

Ruled shape:
- **Self-expanding registry**: the project lead seeds the initial set; new models enter as
  proposed providers, the mind flags the candidate, and they are tested and ranked by results.
- **Sufficiency, not maximisation**, with the bar set by the stakes of this instance (a draft
  needs less than a final version of the same artifact).
- **Danger gates by authority, never by score**: e.g. self-modification code goes only to a
  trusted model class; the mind's own voice stays its own choice. No budget pressure
  overrides a hard gate.
- Model swap is not an identity event. Model scores are auditable beliefs revised by evidence.
- **Core-loop correction**: the core loop must not run on an expensive remote model. The
  long-run target is a local predictive-coding core loop; remote models are dispatched
  specialists for work the loop does not touch. The core loop is the router's host, not its
  output.

Two named hard problems (v2): automated evaluation of a new provider without hand testing,
and an automated quality bar. Review flagged a spend-pump risk when routing, borrowing and no
artificial fatigue combine; the fix is a hard borrow ceiling the router must consult.

## Native language organ (2026-07-31)

- **A transformer written in MeTTa is a category error.** The opacity of a transformer is in
  its weights, not its code. Moving the arithmetic into MeTTa makes the mechanism transparent
  while the meaning stays opaque, at enormous cost. Dense float arithmetic is host mechanics.
- **Natively owned, not natively multiplied**: MeTTa owns what a parameter means, when it may
  change, what the organ is for and what its output may do.
- A from-scratch model trained only on the mind's own life would be too weak to speak a
  natural language. Content purity applies to the world-model organ; the language organ was
  ruled transitional and borrowed.
- **The good move**: convert a small model (around 0.5B parameters) into a narrow language
  orchestrator. Knowledge lives in the journal and atom memory, so the organ only needs to
  parse intent, pick among native options, emit well-formed structure and phrase output.
  Gains: no remote provider dependency, tractable interpretability, weights as local
  governable state, cheap always-on running. Cost: weaker fluency; failure mode is
  "stutters", not "acts wrongly", because admission is fail-closed.
- A "predictive-coding hat", four increasingly invasive options: a PC outer loop with frozen
  weights (surprise feeds salience); bounded online adaptation under the self-modification
  pipeline and promotion ladder; identifying the organ's attention with the salience
  economy (one attention economy for both layers, the research prize); and shrinking
  distillation.
- Staging, cheapest first: local small orchestrator against an existing ten-cycle baseline,
  then the PC outer loop, then bounded adaptation, then the identification experiment.
- A voice change is the mind's own decision, not an engineering choice.

## The independence problem (2026-08-20)

From a functional-core research call:
- Proposer-versus-adjudicator is largely settled in code: memory truth values derive from
  supporting and contradicting episodes, not from the model's assertion.
- The real distinction is **independence**: a model's claim about the world, checked
  against the world, is evidence; a model's claim about its own confidence is not.
- In NAL and PLN, confidence is an evidence count (`c = n / (n + k)`), so grounding a truth
  value means counting independent supporting and contradicting episodes.
- Open: what makes two episodes independent. Ten paraphrases of one conversation count as
  ten and are worth one. The same defect affects any single-subject time-series method.
- Formal claims should be checked with the domain authors before quoting.

_Curated summary. Full version kept privately (source: THEORY_INSPECTABLE_INERT_REASONING_2026-07-20.md, THEORY_INSPECTABLE_INERT_REVIEW_SYNTHESIS_2026-07-20.md, KIMI_THEORY_INSPECTABLE_INERT_REDTEAM_2026-07-20.md, MULTI_MODEL_ROUTING_THEORY_2026-08-04.md, MULTI_MODEL_ROUTING_DECISION_2026-08-04.md, NATIVE_LANGUAGE_ORGAN_THEORY_2026-07-31.md, THEORY_NOTE_INDEPENDENCE_PROBLEM_2026-08-20.md)._
