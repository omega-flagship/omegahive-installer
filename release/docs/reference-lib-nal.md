> **Current.** Rewritten for this handover from PeTTa probes; see `docs/reasoning-deviations.md`.

# Reference — `lib_nal.metta`

Non-Axiomatic Logic (NAL): a logic of uncertain reasoning with evidence-based truth values. NAL is
OmegaClaw's symbolic engine for inheritance and implication reasoning. In this release minds call
it as a skill (`nal-step`, or `|-` inside the `metta` skill); the mind loop does not invoke it
automatically (see the root `README.md`, "What is real today").

Every number on this page comes from a scripted PeTTa run committed alongside it:
[`probes/nal_pln_reference_probe.metta`](./probes/nal_pln_reference_probe.metta), with its
recorded output in [`probes/nal_pln_reference_probe.out`](./probes/nal_pln_reference_probe.out)
(PeTTa `ae66fa8`). The probe loads `lib_nal` and `lib_pln` only. Where this library differs from
Wang's NAL and from ONA, see [`reasoning-deviations.md`](./reasoning-deviations.md).

---

## Truth value format

Every NAL statement carries `(stv frequency confidence)`:

- `frequency` ∈ [0.0, 1.0]: how often the statement held among observed evidence.
- `confidence` ∈ [0.0, 1.0): how much evidence supports that frequency.

**Negation** is `(stv 0.0 c)` for a negative statement; `Truth_Negation` maps `f` to `1 − f`.

Evidence weight and confidence convert with k = 1: `w2c(w) = w / (w + 1)` and
`c2w(c) = c / (1 − c)`. Confidence 1.0 is outside the domain (`c2w` divides by zero; see
`reasoning-deviations.md`).

---

## Core relations

| Relation | Meaning |
|---|---|
| `-->` | **Inheritance.** `(--> a b)` ≈ "`a` is a kind of `b`". Asymmetric. |
| `==>` | **Implication.** `(==> P Q)` ≈ "if `P` then `Q`". |
| `<->` | **Similarity.** `(<-> a b)` ≈ "`a` and `b` are similar". |
| `×` | **Product.** `(× sam garfield)` ≈ the ordered pair. |
| `[]`, `{}` | **Property set** and **instance set**. |
| `∩`, `∪`, `−`, `~` | Intersections and differences (NAL-3). |
| `∧`, `∨`, `¬` | Conjunction, disjunction, negation of statements (NAL-5). |

---

## The `|-` operator and what is reachable

`(|- premise1 premise2)` (`lib_nal.metta:201-202`) tries the NAL rules `|-nal` in **both premise
orders**, collects every conclusion, and removes exact duplicates. So one call can return several
conclusions, for example an inheritance and a similarity from the same pair.

- **Reachable from `nal-step` and `|-`:** the two-premise rules (revision, syllogisms,
  comparison, analogy, resemblance, NAL-3 and NAL-5 decomposition, NAL-4 relation rules,
  implication syllogisms, conditional deduction and abduction).
- **Not reachable from `nal-step`:** the 19 one-premise structural rules (for example
  `(<-> S P) ⊢ (<-> P S)`, set and intersection decomposition, `(∧ A B) ⊢ A`). `|-` takes two
  arguments. PeTTa's own one-premise rules are reached through `nars-derive`, which also checks
  stamps.
- **Collision note.** The core also loads PeTTa's `lib_nars`, which defines its own `|-` rules
  and `Truth_*` helpers under the same names. Inside a running mind, `nal-step` can therefore
  return extra raw copies. See `reasoning-deviations.md`, item 1.
- **No stamps on the skill path.** `nal-step` does not track evidence. Revising a belief against
  itself raises its confidence. The swarm commons (`lib_hive`) does track stamps.

---

## Rule catalogue

### Deduction

**Shape:** `(--> A B)` and `(--> B C)` ⊢ `(--> A C)` (`lib_nal.metta:110`).

```
f = f₁ × f₂
c = f₁ × f₂ × c₁ × c₂
```

Deduction also emits the **exemplification** conclusion `(--> C A)` with `f = 1`,
`c = w2c(f₁ × f₂ × c₁ × c₂)`.

### Induction (shared subject)

**Shape:** `(--> A B)` and `(--> A C)` ⊢ `(--> C B)` (`lib_nal.metta:111`). Generalising from
shared instances.

```
f = f₁
c = w2c(f₂ × c₁ × c₂)
```

Because `|-` tries both premise orders, the call also returns `(--> B C)`, and the comparison rule
adds `(<-> B C)`. Probe: `(--> a b)` and `(--> a c)` at `(stv 1.0 0.9)` give `(--> c b)`,
`(--> b c)`, `(<-> c b)` and `(<-> b c)`, each `(stv 1.0 0.4475)`.

### Abduction (shared predicate)

**Shape:** `(--> A C)` and `(--> B C)` ⊢ `(--> B A)` (`lib_nal.metta:112`). Seeking a cause from a
shared effect.

```
f = f₂
c = w2c(f₁ × c₁ × c₂)
```

**Confidence ceiling:** with two premises at `c = 0.9`, the most abduction or induction can give
is `w2c(0.81) = 0.4475`. Use revision to build up evidence.

### Revision: merging independent evidence

**Shape:** two beliefs about the same statement (`lib_nal.metta:92-99, 108`).

```
w_i   = c_i / (1 − c_i)
w     = w₁ + w₂
f_out = (w₁ f₁ + w₂ f₂) / w
c_out = min(0.99, w / (w + 1))
```

When evidence agrees, confidence grows; when it disagrees, frequency moves between the two while
confidence still grows, so contradiction is visible. If every input has `f = 1.0`, the result
has `f = 1.0`.

**Check points (probe, revising one source at a time):**

| Sources at `(stv 1.0 0.45)` | Result |
|---|---|
| 2 | `(stv 1.0 0.621)` |
| 3 | `(stv 1.0 0.711)` |
| 5 | `(stv 1.0 0.804)` |

Two induced instances at `c = 0.42` revise to `c = 0.592`.

### Conditional deduction (modus ponens)

**Shape:** `A` and `(==> A B)` ⊢ `B` (`lib_nal.metta:191`). Same truth function as deduction.

### Conjunctive antecedents

**Shape:** `A` and `(==> (∧ A B) C)` ⊢ `(==> B C)` (`lib_nal.metta:194-196`). Probe:
`(--> p q)` with `(==> (∧ (--> p q) (--> r s)) (--> t u))`, both `(stv 1.0 0.9)`, gives
`(==> (--> r s) (--> t u)) (stv 1.0 0.81)`.

### Conditional abduction

**Shape:** `B` and `(==> A B)` ⊢ `A` (`lib_nal.metta:197`), using the abduction truth function.
Probe: `(--> x y) (stv 1.0 0.9)` with `(==> (--> w z) (--> x y)) (stv 0.9 0.9)` gives
`(--> w z) (stv 0.9 0.4475)`. Which premise the frequency should come from is an open question
for the domain author (`reasoning-deviations.md`).

### Implication chaining

**Shape:** `(==> A B)` and `(==> B C)` ⊢ `(==> A C)` (`lib_nal.metta:179`), with the deduction
truth function. Probe: two `(stv 1.0 0.9)` implications give `(==> A C) (stv 1.0 0.81)`. Each call
does one step; to follow a longer chain, call it again on the result.

### Similarity, comparison, analogy and resemblance (NAL-2)

Two-premise rules at `lib_nal.metta:118-124`. They match fixed argument positions, so a premise
written the other way round may not match the same rule; and the one-premise symmetry rule
`(<-> S P) ⊢ (<-> P S)` is not reachable from `nal-step`. Write both orientations if you rely on
symmetry.

### NAL-3 decomposition

Two-premise decomposition rules exist (`lib_nal.metta:149-160`), for example `(--> S M)` and
`(--> (∩ S P) M)` ⊢ `(--> P M)`. The one-premise set and intersection decomposition rules
(`:135-147`) are not reachable from `nal-step`.

### Negation

Via `(stv 0.0 c)` or `(¬ A)`. Negated premises propagate through the higher-order rules at
`lib_nal.metta:192-199`.

### Higher-order via proxy

Atomic labels can stand for rules as subjects, for example
`(--> birdRule reliable)` and `(--> reliable trustworthy)`.

---

## Invocation

Through the `nal-step` skill or the `metta` skill. Variables use `$1`, `$2`, …

### Deduction

```metta
(metta (|- ((--> sam human)    (stv 1.0 0.9))
           ((--> human mortal) (stv 1.0 0.9))))
```

### Implication with variable unification

```metta
(metta (|- ((==> (--> (× $1 elephant) eat) (--> $1 ([] dangerous))) (stv 1.0 0.9))
           ((--> (× tiger elephant) eat)                            (stv 1.0 0.9))))
```

### Revision

```metta
(metta (|- ((--> wolf animal) (stv 1.0 0.45))
           ((--> wolf animal) (stv 1.0 0.45))))
```

Output: `(--> wolf animal) (stv 1.0 0.621)`, plus self-referential side conclusions such as
`(--> wolf wolf) (stv 1.0 0.168)` from the syllogistic rules matching the same premise twice.
These are artefacts of the skill path having no stamps; ignore them, or use the commons, which
checks stamps.

---

## Multi-hop degradation, in numbers

Chained deduction with every premise at `(stv 1.0 0.9)` (probe):

| Hops | Output `c` |
|---|---|
| 1 | 0.810 |
| 2 | 0.729 |
| 3 | 0.656 |
| 4 | 0.590 |

With `f = 1` everywhere, `c` after n hops is `0.9^(n+1)`. In general each hop multiplies
confidence by `f₁ × f₂ × c₂`, so it falls much faster when frequencies are below 1: two
`(stv 0.5 0.9)` premises already give `c = 0.2025`. This decay is by design in NAL. Keep chains
short and use revision to restore confidence.

---

## See also

- [reasoning-deviations.md](./reasoning-deviations.md): where this library differs from the
  references, and the open questions for the domain author.
- [tutorial-05-reasoning-with-nal-pln.md](./tutorial-05-reasoning-with-nal-pln.md): worked examples.
- [reference-lib-pln.md](./reference-lib-pln.md): the probabilistic counterpart.
- [reference-lib-ona.md](./reference-lib-ona.md): planned real-time / temporal engine (experimental, not installed).
- [reference-orchestration.md](./reference-orchestration.md): when to pick NAL or PLN.
- [reference-failure-modes.md](./reference-failure-modes.md): known failure rates for NAL-using chains.
