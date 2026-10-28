> **Current.** Rewritten for this handover from PeTTa probes; see `docs/reasoning-deviations.md`.

# Reference — `lib_pln.metta`

Probabilistic Logic Networks (PLN): a probabilistic reasoning framework for the AtomSpace. In
OmegaClaw it is the engine for property-based categorical inference and for `Implication` over
`Inheritance` structures. Minds call it as a skill (`pln-step`, or `|~` inside the `metta`
skill); the mind loop does not invoke it automatically in this release.

**Status by the owner's ruling:** `lib_pln.metta` stays as it is in this release. It is the
OmegaClaw fork of trueagi-io/PLN (its truth functions equal trueagi-io/PLN at commit `4405956`
after renaming `Truth_` to `Truth__`). It can be upgraded by its author, and any change to its
truth semantics goes to the domain author first. The differences from the PLN book and OpenCog
are listed in [`reasoning-deviations.md`](./reasoning-deviations.md).

Every number on this page comes from the committed probe
[`probes/nal_pln_reference_probe.metta`](./probes/nal_pln_reference_probe.metta) (output in
[`probes/nal_pln_reference_probe.out`](./probes/nal_pln_reference_probe.out), PeTTa `ae66fa8`).

---

## Relations

| Atom | Meaning |
|---|---|
| `Inheritance` | Probabilistic "is-a" relation. |
| `Implication` | Conditional probability: `(Implication P Q)` ≈ `P(Q | P)`. |
| `Similarity`, `Equivalence`, `Member`, `Evaluation`, `Not` | As in PLN. |
| `IntSet` | Intensional set: members share a property. |

Truth values use NAL's `(stv strength confidence)` format, read probabilistically. Confidence
uses the NARS-style mapping with k = 1 (`w2c(w) = w / (w + 1)`), not PLN's count-based
confidence.

**Term probabilities are a constant.** `(= (STV $X) (stv 0.1 0.9))` (`lib_pln.metta:49`) gives
every term the same prior. Deduction, induction and abduction strengths are computed against that
stub prior, so treat their strengths as placeholders until real term probabilities exist.

---

## The `|~` operator and what is reachable

`(|~ premise1 premise2)` (`lib_pln.metta:306-307`) tries the two-premise `|~pln` rules in both
premise orders and removes exact duplicates.

- **Reachable from `pln-step` and `|~`:** revision, modus ponens, symmetric modus ponens
  (Similarity links), deduction, induction and abduction (Inheritance and Implication), the
  Evaluation-over-Inheritance rules, transitive similarity, evaluation implication and member
  deduction.
- **Not reachable:** the one-premise rules (negation elimination, inheritance and implication
  inversion, equivalence to implication). So `pln-step` never returns an inverted echo of a
  single fact.
- Use the plain relation names (`Inheritance`, `Implication`, ...), not OpenCog's
  `InheritanceLink` or `ImplicationLink`; those are different atoms and do not match.
- Inference is forward only; there is no chainer.

---

## Rule catalogue

### Modus ponens

**Shape:** `P` and `(Implication P Q)` ⊢ `Q` (`lib_pln.metta:196-199`).

```
s = Ps × PQs + 0.02 × (1 − Ps)       (PLN book 5.7.1, with a background term)
c = Ps × PQs × Pc × PQc
```

Probe: `Truth__ModusPonens (stv 0.8 0.9) (stv 0.9 0.9)` gives `(stv 0.724 0.583)`.

### Deduction, induction and abduction

On `Inheritance` or `Implication` links (`lib_pln.metta:216-240`), using the PLN-book strength
formulas with the constant term prior above, and product confidences
(for example deduction `c = sAB × sBC × cAB × cBC`). With NAL-style k = 1 confidence, abduction
and induction from two `c = 0.9` premises top out at `w2c(0.81) = 0.4475`, the same ceiling as NAL.

### Revision

**Shape:** two beliefs about the same statement (`lib_pln.metta:117-124`).

```
w_i   = c_i / (1 − c_i)
w     = w₁ + w₂
f_out = (w₁ f₁ + w₂ f₂) / w
c_out = min(1.0, w / (w + 1))
```

This is the same formula as NAL revision **except the cap**: PLN caps at 1.0, NAL at 0.99. A
premise with `c = 1.0` makes `c2w` divide by zero; the safe division returns empty, so the
revision silently produces nothing (probe). Keep confidences below 1.0.

---

## Invocation

Through the `pln-step` skill or the `metta` skill. Variables use `$1`, `$2`, …

### Modus ponens example

```metta
(metta (|~ ((Implication (Inheritance $1 (IntSet Feathered))
                         (Inheritance $1 Bird)) (stv 1.0 0.9))
           ((Inheritance Pingu (IntSet Feathered)) (stv 1.0 0.9))))
```

Output: `(Inheritance Pingu Bird) (stv 1.0 0.81)`.

### Abduction example

```metta
(metta (|~ ((Inheritance bird flyer)  (stv 1.0 0.9))
           ((Inheritance robin flyer) (stv 1.0 0.9))))
```

Output: **both** directions, `(Inheritance robin bird)` and `(Inheritance bird robin)`, each
`(stv 1.0 0.4475)`. Both appear because `|~` tries both premise orders. Abduction gives
hypotheses worth testing, not actionable conclusions.

---

## NAL or PLN

| Situation | Engine |
|---|---|
| Asymmetric chain `A → B → C` | NAL `\|-` |
| Observed effect, seeking cause (simple) | NAL `\|-` abduction |
| Merging independent evidence | Either; same formula, different confidence cap (0.99 in NAL, 1.0 in PLN) |
| Property-based categorical inference | PLN `\|~` |
| `Implication` over `Inheritance` structures, `Evaluation` predicates | PLN `\|~` |
| Real-time or temporal reasoning | Not served by a stock engine. ONA is the planned future target (see [reference-lib-ona.md](./reference-lib-ona.md), experimental, not installed) |

When in doubt, try NAL first.

---

## See also

- [reasoning-deviations.md](./reasoning-deviations.md): differences from PLN/OpenCog and the open questions for the domain author.
- [reference-lib-nal.md](./reference-lib-nal.md): sibling symbolic engine.
- [reference-lib-ona.md](./reference-lib-ona.md): planned temporal engine (experimental, not installed).
- [reference-orchestration.md](./reference-orchestration.md): engine selection.
- [tutorial-05-reasoning-with-nal-pln.md](./tutorial-05-reasoning-with-nal-pln.md): worked examples.
