# Reasoning libraries: deviations from the references

This is the public summary of an internal NAL/PLN literature audit (two rounds, 2026-10-09, with
an independent red-team review). It says where this repository's reasoning libraries match the
references, where they differ, and what is still open for the domain author.

**The libraries stay unchanged in this release, by the owner's ruling.** PLN in particular stays
as it is and can be upgraded by its author. This page documents; it does not propose code
changes. Any change to truth semantics goes to the domain author before merge.

References used: Wang, *NAL Specification* (sections 3.4, 7.4 and Tables 3.4, 3.8, 3.10, 7.3);
ONA `Truth.c`; OpenNARS; the PLN book; OpenCog PLN rules; trueagi-io/PLN at commit `4405956`.
Runtime: PeTTa `ae66fa8`. The numbers in the reference pages come from
[`probes/nal_pln_reference_probe.metta`](./probes/nal_pln_reference_probe.metta).

## What matches

- **NAL truth functions match Wang and ONA:** deduction, abduction, induction, exemplification,
  comparison, analogy, resemblance, intersection, union, difference, negation, expectation,
  eternalize, the decomposition family, and w2c/c2w with k = 1. Revision matches except the cap
  (item 3).
- **NAL deduction's fast confidence decay** (`c = f₁f₂c₁c₂`) is by design in NAL, and the PLN fork
  shares it.
- **The structural reliance constant** ⟨1, 0.9⟩ is Wang's own device (Theorem 48) and ONA's
  `RELIANCE 0.9`, not an invented premise.
- **PLN strength formulas** trace to the PLN book and OpenCog, and the truth block is identical to
  trueagi-io/PLN at `4405956` after renaming.
- **The commons** (`hive/spaces/lib_hive.metta`) revises only disjoint evidence and chooses by
  confidence otherwise, matching Wang's choice rule.

## Deviations and hazards

1. **Duplicate load and the `|-` collision.** `lib_omegaclaw_core.metta` loads `lib_nal` and also
   PeTTa's `lib_nars`. Both define every `Truth_*` helper, and both define `|-`: ours as a
   deduplicating two-order wrapper, PeTTa's as 51 raw one-order rules without stamps. Inside a
   running mind, `nal-step` therefore returns our list plus raw duplicates, and helpers return
   several identical answers (`Truth_Revision` returned 9 with both libraries, 16 with `lib_pln`
   also loaded, since each doubled helper multiplies). PeTTa's `Truth_Union` also returned two
   malformed answers without `stv`. Loading `lib_nal` alone gives one clean list.
2. **No stamps on the skill path.** `nal-step`, `pln-step` and `belief-revision-candidate` carry
   no evidential base. Revising a belief against itself raises confidence (⟨1, 0.9⟩ with itself
   gives c = 0.947) and also derives tautologies such as `(--> wolf wolf)`. The commons does use
   stamps; the skills do not. So repeating a premise *can* inflate confidence on the skill path.
3. **Revision cap and guards.** NAL (`lib_nal`) and the commons (`lib_hive`) cap revised
   confidence at 0.99, as ONA does. PLN caps at 1.0. Neither has ONA's c = 0 and c = 1 guards: at
   c = 1, NAL raises a division error and PLN silently returns nothing. The cap stops counting
   evidence at w = 99. The inner `max(c, c₁, c₂)` has no effect, because revision never lowers
   confidence.
4. **Five revision rules in one estate:** `lib_nal` `Truth_Revision`; `lib_hive`
   `hive-truth-revision` (a copy of the first); `lib_pln` `Truth__Revision` (cap 1.0); the UI
   simulator `nal.ts` (no cap); and the Tools app's provenance revision (a Jaccard-overlap
   discount and a 0.9999 cap).
5. **PLN specifics.**
   - Every term probability is the constant `STV` ⟨0.1, 0.9⟩ (`lib_pln.metta:49`).
   - Confidence is NARS-style (k = 1, product confidences), not PLN count-based confidence and
     not OpenCog's `0.9 × min(cAB, cBC)`.
   - Modus ponens uses a 0.02 background term (OpenCog uses 0.2).
   - Inversion copies the strength instead of applying Bayes, with c = 0.6 × cB × cAB; it is a
     one-premise rule, so `pln-step` cannot reach it.
   - The induction and abduction rules put the shared term in a slot the audit flags as wrong
     (trueagi-io/PLN has the same wiring). The constant prior masks it today.
   - Three PLN lineages exist: this fork, trueagi-io/PLN at `4405956`, and PeTTa's bundled
     `lib_pln` (which uses `min` confidences and is not loaded). None is yet named canonical.
6. **Commons storage.** `hive-integrate!` keeps a single `Current` belief per statement. When
   stamps overlap, the loser leaves the revision pool, although its assertion stays recorded as
   `Asserted`. NARS implementations keep a belief table per concept.
7. **Structural reliance where Wang says r = 1.** The similarity symmetry rule
   (`lib_nal.metta:117`) composes no compound term, yet applies r = 0.9. All 19 one-premise
   structural rules are unreachable from `nal-step` anyway; `nars-derive` reaches PeTTa's own.
8. **Abductive detachment** `{B, A ⇒ B} ⊢ A` (`lib_nal.metta:197`) takes A's frequency from the
   implication, as ONA and PeTTa do; Wang Table 7.3 and OpenNARS differ.

## Open questions for the domain author

1. Abductive detachment: should A's frequency come from the implication or from B?
2. One revision cap for NAL and PLN? Port ONA's c = 0 and c = 1 guards?
3. Should `nal-step` and `pln-step` carry stamps, or is overlap checking the caller's job?
4. Should the commons keep a small belief table per statement?
5. Which PLN lineage is canonical?
6. PLN confidences: products, or OpenCog's `min` with α = 0.9?
7. Modus ponens background term: 0.02 or 0.2?
8. Inversion: strength copy or Bayes? Should one-premise PLN rules be reachable from
   `pln-step`, and with what echo guard?
9. PLN k: 1 or a larger PLN/OpenCog value?
10. `STV` default: a constant ⟨0.1, 0.9⟩ or empty unless declared? Fix the induction/abduction
    slot order now?
11. Structural reliance: r = 1 where no compound term is composed or decomposed? Should the 19
    one-premise structural rules be reachable from `nal-step`?
12. Should the core load both `lib_nal` and `lib_nars` under the shared `|-` name? (A platform
    code question; nothing was changed.)
13. Ask memory: should a repeated statement count as new evidence?

## What is planned

A reviewed "honest truth values" plan (one evidence-count representation with f and c derived)
cleared review and waits for the owner's OK. The reviewed reasoning foundation
(`EARLIER_EXPERIMENTS.md`) already makes reasoning failures honest and fixes the collision on its
branch; it is held for activation.
