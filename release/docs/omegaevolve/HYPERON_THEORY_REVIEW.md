# Hyperon theory review for OmegaEvolve

Reviewed 4 October 2026. Primary research, language specifications, upstream code and the local platform were checked separately. This review does not establish a live Hyperon cognitive system, RSI, AGI or beneficialness.

## Goal and route assessment

Jon's goal is a shared AGI research Omega inside the hive, improving toward Beneficial General Intelligence and beneficial superintelligence, with other minds contributing and building on its work through shared knowledge. The platform has relayed his subsequent decisions: AGI corrects the original AGO typo; OmegaEvolve is an Omega expected to pull ahead of core; the hive owner adopts its own changes; its objective cannot currently self-amend; sharing is chosen per item; the proposed spending envelope is $10/day. No model spending or runtime changes were made in this review.

Continue, with an adjustment: treat the contribution/evaluation workflow as the research infrastructure, and explicitly retain a path toward native self-modeling, reasoning, program learning, cognitive synergy and measured improvement of the research process. A workflow around prompt revisions alone would leave much of the intended destination unimplemented.

## 1. What the primary sources actually support

**Architecture.** Hyperon's 2023 overview distinguishes the infrastructure from cognitive models built on it. AtomSpace supplies shared structured representation; MeTTa supports querying, rewriting and interfacing with other algorithms. CogPrime covers different memory and cognitive functions; LLMs can participate without defining the whole architecture. Specialized spaces and distributed storage are part of the design. Its self-improvement and beneficial-AGI discussions describe a research direction, not achieved guarantees. The roadmap is dated and must not be treated as current delivery evidence. [2023 architectural overview, particularly §§3–5](https://arxiv.org/html/2310.18318v1).

**Reflection.** The 2021 metagraph-rewriting paper represents both programs and execution traces within the same formal substrate. Programs can inspect and transform programs, including themselves. Its higher-category/Ruliad discussion describes mathematical structure; the author explicitly leaves practical efficiency questions unresolved. External groundings remain relevant in real implementations. Reflection establishes a route for expressing self-change, not a reason that a proposed change is an improvement. [Reflective metagraph rewriting, §§4–6](https://arxiv.org/html/2112.08272v1).

**General intelligence and cognitive synergy.** Patternist theory relates diverse cognitive processes through common representations. Synergy concerns processes helping one another when they get stuck, with costs involved in alternative paths; it is more specific than multiple agents sharing a database. These are proposed organizing principles, not a proof that a particular implementation is generally intelligent. [General theory of general intelligence, especially §7](https://arxiv.org/html/2103.15100v3).

**Common algorithmic structure.** The chronomorphism/Galois-connection paper studies reasoning, evolutionary program learning, mining, clustering and attention in a shared formal framework. Some decomposition arguments depend on mutual associativity and other stated conditions. Those conditions need to be instantiated for the actual operations used. [Patterns of Cognition](https://arxiv.org/html/2102.10581v1).

**Current cognitive direction.** The AGI-25 architectural chapter's accessible abstract describes PRIMUS memories, attention and a goal-driven cognitive cycle, with LLMs, formal reasoners and program learners as specialized participants. Its AGI/ASI timing is a prospective roadmap. I read the publisher's abstract and references; the subscription chapter's full text was unavailable, so this is not a full-text review of that chapter. [Publisher record](https://link.springer.com/chapter/10.1007/978-3-032-00686-8_18).

**World modeling.** The December 2025 PRIMUS paper proposes coupled symbolic, dynamic and associative representations. It calls for persistent identity and evidence anchoring: symbolic abstractions retain paths back to underlying observations. Proposed grounding includes competing hypotheses and provenance. These are useful design constraints, not verification that our hive implements that architecture. [PRIMUS world-modeling paper, especially §§3–4](https://singularitynet.io/wp-content/uploads/2025/12/PRIMUS-world-modeling_v2.pdf).

**Experimental cognitive kernel.** ActPC-Chem explores goal-guided rewriting, prediction errors and integration with AIRIS and PLN. It is explicitly a preliminary proposal and uses virtual-bug thought experiments. That supports an experiment family; it does not supply measured evidence of a general cognitive kernel or justify replacing the current scheduler. [ActPC-Chem](https://arxiv.org/html/2412.16547v1).

**Goal stability.** The metagoals paper considers fixed-point approaches to stability and moderated evolution. It explicitly characterizes its treatment as semi-formal, with important conditions and heuristic argument sketches. It distinguishes contraction-based reasoning from existence arguments involving Schauder-style results. [Metagoals paper](https://arxiv.org/html/2412.16559v1).

**Motivation.** MetaMo's publisher abstract proposes a modular appraisal/decision framework with stability assumptions. The full subscription chapter was unavailable here. No claim is made that MetaMo is installed or its assumptions hold in OmegaEvolve. [MetaMo publisher record](https://link.springer.com/chapter/10.1007/978-3-032-00686-8_34).

**Language semantics.** The reference specification describes type-directed evaluation, pattern matching, module contexts and grounded execution; it is the specification for its named implementation. Atoms prefixed for evaluation execute rather than merely being recorded. Backend behavior must be qualified rather than inferred from the language's theoretical scope. [MeTTa specification](https://trueagi-io.github.io/hyperon-experimental/metta/).

**Uncertain reasoning.** The current MeTTa-native PLN repository describes strength/confidence values, evidence identifiers for overlap handling, deductive/inductive/abductive inference, and resource-bounded inference control. This is an implementation claim supported by source availability, not a local integration receipt. [Upstream PLN](https://github.com/trueagi-io/PLN).

## 2. Mathematical limits that matter for this build

The following are my analysis of applicability, not claims that the sources prove OmegaEvolve's properties.

- **Representation is not execution equivalence.** A graph describing an interpreter, optimizer or external tool does not automatically reproduce its semantics. A native self-model must account for the interpreter revision, groundings, state, budgets and effects. Any claimed replacement needs a concrete equivalence witness or bounded behavioral evidence.
- **Shared syntax is not shared meaning.** Two minds using the same atoms can disagree about entity identity, time, units, uncertainty and evidence independence. Vocabulary alignment needs explicit mappings and unresolved states; collisions must not silently merge meanings.
- **Galois connections need an actual order and adjunction.** For a proposed abstraction/concretization pair, specify the domains, ordering and laws rather than borrowing the term for arbitrary conversion code. Test information loss and counterexamples. Chronomorphism language does not make arbitrary effectful rewrites associative or reversible.
- **A fixed point need not be attractive.** Consider the continuous map `F(x,y)=(-y,x)` on the compact convex square `[-1,1]^2`. The origin is a fixed point, yet starting at `(1,0)` produces a four-step cycle. Existence alone does not establish convergence of our iterative updates.
- **Convergence need not be beneficial.** A constant update map toward a harmful goal can be contractive. A stability argument therefore needs separately justified values, a meaningful metric and demonstrated applicability to the actual update process. Freezing an objective string does not freeze its operational interpretation.
- **Distributional stability can hide individual failures.** Even if aggregate behavior stabilizes, particular trajectories or people may experience unacceptable outcomes. Track per-case effects and tails, not only mean scores.
- **A changing metric can disguise drift.** Preserve versions of criteria and mappings between old and new interpretations. Evaluate changes against earlier protected commitments as well as the current rubric. OmegaEvolve cannot currently amend its objective through this route.
- **Truth values are method-specific.** Preserve evidence sets, source dependence, inference rules and uncertainty methods. A scalar confidence from an LLM cannot be substituted for PLN confidence, NAL evidential confidence or a permission decision without a justified mapping.
- **Rollback has an effect boundary.** Restoring a prompt or atom revision cannot undo every message, disclosure or physical action already performed. The first experiments should use disposable targets, and later receipts must identify what restoration actually covers.

## 3. What is verified locally

Local PeTTa is pinned at `ae66fa8e41dcd5539d614706bd4e5cfb34f9608d`; its worktree has an untracked Python cache, so this is not a claim of a pristine checkout. The source exposes mutation, import and Python/Prolog interoperation. Type declarations and named spaces are not, by themselves, effect sandboxes. The reference implementation's semantics are not assumed identical to PeTTa's. [PeTTa upstream](https://github.com/trueagi-io/PeTTa).

The platform source inspected for this review includes native `hive/spaces/lib_hive.metta`. Its shared beliefs use evidence stamps, check overlapping support and separate publishing rights from statements. Its revision formula is documented as matching the local NAL revision rule. That is specific implemented machinery; it should not be described as the complete Hyperon reasoning or distributed AtomSpace stack. Runtime reachability, grants and shared-knowledge continuity were not tested against the running hive here.

An isolated candidate was prepared on platform commit `eafd78913f762030f9a8c9304c4c29efc71f62e9`. The active platform subsequently moved; the candidate remains pinned to its own base. It adds immutable claim records, provenance/uncertainty requirements, owner-sealed offline registrations and an existing-Lab qualification suite. Raw contribution fields never become executable MeTTa. A native prototype represents records by opaque digests while the original records retain their text and evidence locators.

Native matching and a typed accessor were exercised in a disposable PeTTa process, with exact result matching and an empty error stream using the patched Prolog executable. The first Homebrew attempt returned the expected results but also an interoperation initialization error; it was not treated as a clean receipt. See `NATIVE_PROJECTION_RECEIPT.json`.

This prototype is deliberately small: it proves local representation/query plumbing, not installed shared knowledge, self-inspection of the full Omega body, real provider behavior, independent scientific review or adopted improvement.

## 4. What to build and measure next

These are design recommendations derived from the review.

1. **Retain the workflow candidate as the research spine.** Give every contribution, experiment, result, criticism and adoption an identity, revision, evidence linkage and uncertainty. Corrections and retractions must remain traceable to their original sources and invalidate dependent conclusions where applicable.
2. **Add native research meaning, not only digest lookup.** Develop typed relations for hypothesis, evidence, experiment, baseline, candidate, result, counterevidence, dependency and self-model. Keep source identity and custody explicit; preserve links from abstractions to original evidence. Derive no permission from those atoms.
3. **Make the self-model executable and inspectable in stages.** Represent actual available reasoning rules, programs, groundings and resource constraints, with source pins and observed traces. Start by predicting a bounded run, comparing the prediction with its observed trace and explaining mismatches. A claimed self-model should identify its own missing parts.
4. **Test cognitive synergy with ablations.** Compare equal-budget LLM-only, typed-memory, native-reasoning and combined routes. Include tasks requiring contradiction handling, source dependence, transfer, program repair and recovery. Measure whether one process resolves another's stuck cases rather than only counting messages.
5. **Test recursion across successive cycles.** Cycle one improves a research capability; cycle two uses it on new work. Compare quality, effort, cost and reproducibility with the unchanged baseline. A better result on one fixed task is capability evidence; a better subsequent improvement process is stronger recursive evidence. Neither alone establishes general intelligence.
6. **Treat beneficialness as continual evidence.** Specify affected parties, protected commitments, assessment owners, evidence and dissent. Keep known capability gain and unresolved beneficialness separate. Assess interpretation drift as well as literal objective edits.
7. **Pin and qualify the chosen backend.** Establish supported types, matching, multiple solutions, groundings, imports, persistence, restart and resource behavior before learning new executable rules. Qualify PLN integration separately. Do not install a second motivational selector or broaden authority merely because a theory describes one.

The first prompt/skill-help repair experiment remains useful, provided it is labeled a starting diagnostic. It should grow into this wider sequence rather than becoming the definition of OmegaEvolve's success.

## 5. Coverage and unresolved items

Full-text architecture, reflection, general-theory, cognitive-algorithm, metagoal and ActPC sources were accessed; the world-modeling PDF's relevant representation and grounding sections were reviewed. Publisher abstracts and references, not full chapters, were available for the AGI-25 architecture and MetaMo chapters. Current language specification and upstream PLN/PeTTa documentation were checked. New Wiki summaries were useful for discovery but were not treated as substitutes for papers or runtime verification.

This is a thorough architecture/applicability review, not a formal verification of all cited mathematics. No claim is made that the proposed self-modification dynamics satisfy contraction, compactness, convexity, continuity, independence or a beneficialness invariant. Those remain concrete research obligations.

Public source snapshots and hashes for the initial full-text/source captures are in `research/sources.json`. Local qualification receipts and the platform handoff separately record candidate evidence. No private Atlas or OmegaTruth material was used in this review.
