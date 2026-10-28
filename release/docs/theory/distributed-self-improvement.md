# Distributed recursive self-improvement across a hive of hives

> **Status: Intended (designed, not built).** This page is design intent. Nothing on it is a
> switch, and theory grants no build authority (`README.md`, house rules). Each mechanism below is
> marked built, partly built or intended, and the table near the end names the source for each.
> The owner answered this page's seven open questions on 2026-10-10. Each answer is recorded where
> it applies, marked **Decided by the owner, 2026-10-10**, and collected in section 16.

## The owner's design

This page sets out the owner's design, given on 2026-10-10, in their words:

> "Where anyone's private hive, if connected, can opt their evolve module into the hive of hives,
> and if people's evolve modules increase an aliveness score in some demonstrable way, or add a
> new bench, or a new module - then evolve passes through to the center hive, to the center
> center hive and then from core hives if passing their evolve tests can pass that back out
> through the main core repository, and every other mind on every other hive gets alerted they
> CAN upgrade. And how each step of that process is able to be human gated, so humans can step in
> as reviewers in the process too."

The rest of the page works out what each part of that sentence needs: who opts in, what
qualifies, what travels, who checks it at each hop, where people step in, how a release goes
out, how an upgrade is offered rather than pushed, and what happens when a hive changes the
machinery itself. Where a choice is still open, the page says so and does not pick one silently.

## In one paragraph

Each hive is a **node**. The whole network is the **hive of hives**, and it is organised the way
ASI:Chain organises nodes into **shards**: groups of nodes that share one record and one set of
validators. Improvement starts in a private hive. If that hive's owner opts in, its Evolve module
can nominate a **candidate**: a change that raises the aliveness profile in a demonstrable way, a
new bench, or a new module. The candidate climbs one shard at a time, from the private node to a
centre shard, a centre-of-centre shard and the core shard. It carries code and evidence, never
private data. In every shard, validator hives re-run the evidence themselves and never trust the
sender's numbers, and a human gate can hold, approve or veto. A majority of core hives must
independently re-test and pass a candidate before it goes into the core repository under the
normal two-reviewer rule. The release then goes out as an **offer**: every mind on every hive is
told it *can* upgrade, and each hive, person and mind decides for itself. A bad release raises an
alert and a hold everywhere. All of this runs on one shared **main line** of machinery (Evolve,
benches, gates), kept aligned by human consensus. A hive may **fork** that machinery, but it is
warned first, the fork is recorded and visible, and the hive leaves the main Evolve line until it
rejoins.

## 1. Words used here

| Word | Meaning on this page |
|---|---|
| **Node** | One hive. Each person's hive is a node, as in the owner's direction for hive-to-hive (`ledger-provenance-and-das.md`, "The road to hive-to-hive"). |
| **Shard** | A group of member hives that share one bench set, one gate and one attestation log for candidates. A shard's members may themselves be shards. |
| **Validator set** | The member hives a shard names to re-test candidates. Each validator re-runs the evidence on its own and signs what it found. |
| **Hive of hives** | The whole network of nodes and shards. |
| **Candidate** | One proposed improvement: a code change, a new bench or a new module, fixed by the sha256 of its contents. A changed candidate is a new candidate. |
| **Evidence bundle** | The signed package that travels with a candidate (section 5). |
| **Tier** | One level of shards. The tiers run from the private node up to the core shard. |
| **Hop** | Moving a candidate from one tier to the next. Every hop has a re-test and a gate. |
| **Gate** | The decision point at a hop: the validators' re-test, then the human gate. |
| **Attestation** | A validator's or a gate's signed record of what it measured and what it decided. |
| **Offer** | The notice that a release is available. It changes nothing on the receiving hive by itself. |
| **Adopt** | A receiving hive, person or mind choosing to install an offered release. |
| **Machinery** | What judges candidates: the Evolve module, the aliveness profile and bench set, the gate rules, and the evaluator and sandbox policy. |
| **Line** | One version of the machinery, named by the digest of its pins. The **main line** is the shared default, "the species". |
| **Fork** | A hive that runs machinery that differs from the main line (section 11). |
| **Evolve** | The hive's research and self-improvement program (a closed-tier app). This page treats it as a box with an interface (section 15). |

## 2. The tiers as ASI:Chain shards and nodes

**Decided by the owner, 2026-10-10:** "Check ASI Chain theory around shards and nodes." The tiers
are mapped onto that model below, and the tier names are revised to fit it. The mapping itself
is this page's reading, open to correction.

### 2.1 What the ASI:Chain material says

These are the sources used. They are named here by document title only.
- **Hyperon Deep-Dive Whitepaper** (Ben Goertzel, July 2026). Sections 2.5.1 ("Decentralized
  Execution"), 6.9 to 6.11 (OmegaClaw and ASI:Chain operations; the Self-Modification Governor),
  11.7 ("Decentralized Governance") and 13.3 ("Decentralized Implementation on F1R3FLY/ASI:Chain").
- **ASI-Chain and Cryptographic Sovereignty** (dossier D24, 2026-08-07), the V2 dossier on
  exact-digest governance events, leases, multisig and forks.
- **Hyperon lineage evidence note** (2026-07-12), which records ASI:Chain's status: a DevNet with
  MeTTa smart contracts and consensus from the CBC Casper family, with mainnet targeted for late
  2026 or early 2027.
- `docs/theory/ledger-provenance-and-das.md` in this repository: "The road to hive-to-hive" and
  "Deliberately deferred".
- The whitepaper cites a fuller design document, "OmegaClaw ASI:Chain Node and Shard
  Administration Skills" (Ben Goertzel, March 2026). **It was not found on this machine**, so this
  page does not rely on it.

What these sources give, in short:
- **Nodes execute and sign.** Nodes run compiled bundles and post signed execution receipts
  (hashes, metrics, versions, scoped validation reports). A deploy keeps its lineage: source,
  compiled form, deploy id, block and shard, cost, resulting state and finalisation record.
- **Shards and validators.** The OmegaClaw administration skills include validator operations and
  shard monitoring. In public ASI:Chain and F1R3FLY material, a shard is a network of nodes that
  share one state under one consensus. Validator nodes propose blocks and finalise them. Read-only
  nodes follow the shard without validating.
- **Finality is ordering, not truth.** Finalised commitments give tamper-evident ordering and
  linkage. They do not prove that a change is correct or good. Semantic validity needs independent
  validators, replay and tests; authorisation needs policy; disputes need a correction process.
  The whitepaper keeps these properties separate on purpose.
- **Community validators re-test.** Community validators can simulate bundles against public
  twins, and communities can require reports to be published before an upgrade. Reputation gating
  can discourage unsafe rollouts. Validator concentration and collusion remain risks.
- **Most cognition stays off chain.** Private, high-bandwidth state stays local, shared knowledge
  goes through DAS, and only records that need cross-party verification are committed.
- **Structural changes may need consensus.** In a multi-node deployment, structural changes to
  shared cognition may require consensus. Safety invariants and the governor itself are not
  ordinary self-modification targets.
- **Forks are named events.** The D24 dossier requires that conflicting forks trigger a hold and
  not an arbitrary choice, that a fork cannot silently duplicate one exclusive identity, and that
  dissent survives a fork. It also lists fork behaviour as unspecified theory debt.
- **The chain witnesses; people authorise.** This repository already fixes the chain's role as
  ordering and commitment, never authorisation (`ledger-provenance-and-das.md`, "Deliberately
  deferred").

### 2.2 The mapping

| ASI:Chain concept | In the hive of hives |
|---|---|
| Node | One hive. A private hive is a node. |
| Read-only node | A connected hive that has not opted in. It receives offers and alerts, and sends nothing. |
| Shard | A group of member hives sharing one bench set, one gate and one attestation log. The owner's "centre hive" is the hive that hosts a shard's gate and log. |
| Validator set | The member hives a shard names to re-test candidates. Each re-runs the evidence independently and signs an attestation. |
| Deploy | A candidate bundle submitted to a shard. |
| Finalisation | A shard's validator rule and human gate are both met, so the candidate may climb to the next shard. |
| Root shard | The **core shard**, made of the core hives. Its finalisation leads to the core repository. |
| Chain fork | A hive running machinery that differs from the main line (section 11). |
| Reputation gating | A member hive's track record: how often its claims replicated (section 13.2). There is no economic slashing. |
| Chain record | A witness of what was signed and in what order. It never authorises. |

Two limits on the mapping. First, the sources describe shards and validators but not shards
nested inside shards; the nesting below is this page's reading of the owner's "centre center
hive". Second, nothing here needs ASI:Chain to run. Each shard keeps its own signed, hash-chained
log, and anchoring those logs to ASI:Chain is the last, optional step of the road to hive-to-hive
(`ledger-provenance-and-das.md`, step 6).

### 2.3 The tiers

| Tier | Name | What it is | What it does in this flow |
|---|---|---|---|
| T0 | **Private node** | Anyone's own hive: one person, a family, a team | Where candidates are born and first tested. Opt-in starts here. |
| T1 | **Centre shard** | A shard of private nodes, hosted by a centre hive | First independent re-test by validator hives; first place a candidate meets other people's benches. |
| T2 | **Centre-of-centre shard** | A shard whose members are centre shards | Re-tests on wider benches and older held-out slices; compares candidates from many centre shards. |
| T3 | **Core shard** | The core hives, run by the platform's core maintainers | A majority of core hives independently re-test and pass ("their evolve tests"); only this shard proposes into the core repository. |
| R | **Core repository** | The platform's source of record | Where a passing candidate becomes a release, under the normal two-reviewer rule. |
| O | **Upgrade offer** | A signed notice to every hive | Every mind on every hive learns it *can* upgrade. |

Points of reading, stated so they can be corrected:
- **"Hive of hives" names the whole network.** This is the reading that fits ASI:Chain, where the
  chain is the whole set of shards. A private hive opts its Evolve module "into the hive of
  hives", meaning into the network, and its first hop is a centre shard. (The earlier draft of
  this page read "hive of hives" as a separate first tier. That tier is gone.)
- **The shape is recursive.** Every shard has the same parts: members, a validator set, a gate
  and a log. The number of middle tiers is a deployment choice; a small network might have no
  centre-of-centre shard at all.
- **A hop may not be skipped.** A candidate climbs one shard at a time, so each shard's re-test
  and gate always run. A gate may be automatic (section 7), but it cannot be bypassed.

## 3. Opt-in at the source

Nothing leaves a private node unless its owner has opted in.
- **Off by default.** A connected hive that has not opted in is a read-only node: it sends no
  candidates and no evidence, and it still receives offers and alerts.
- **Two levels of choice.** The hive owner opts the hive's Evolve module in. Then each candidate
  is nominated deliberately: by a person, or by a mind that the owner has allowed to nominate.
  Opting in is not a standing licence to send everything Evolve produces.
- **The private node's gate.** Leaving the private node is automatic with a watch window, except
  that a new module always needs a person (section 7, decided).
- **Per-candidate preview.** Before a candidate leaves, the owner sees exactly what will travel:
  the file list with digests, the evidence, and the privacy declaration (section 13.4).
- **Withdrawal.** The source can withdraw a candidate at any tier it has not yet passed. A
  withdrawal is recorded; it does not erase attestations other tiers have already made.
- **Minds' own work.** If a mind authored the candidate, the mind is named as an author in the
  lineage, and a change to a mind's own core follows the consent rule in section 9.
- **Main line only.** A hive submits only while it is on the main line. A forked hive submits to
  its own line, not to the main one (section 11).

This follows the promotion ladder: private by default, then candidate, then shared, and only by
deliberate promotion (`governance-and-gating.md`, section 11).

## 4. What qualifies a candidate

The owner names three kinds. Each has a different test, because each claims something different.

### 4.1 A demonstrable gain in the aliveness profile

**Decided by the owner, 2026-10-10:** "Check Ben's and Mine (should be there on the Mac
somewhere) for benchmarking AGI." The profile below is rebuilt from those two bodies of work.

**Sources found.**
- **The owner's paper:** *Benchmarking AGI: Pitfalls and a Plan* (2026-08-15), a position paper
  with a concrete test battery (its Appendix A). This repository already summarises it in
  `evaluation-and-self-modification.md`, "Benchmarking AGI: pitfalls and a plan".
- **Ben Goertzel's work:** *The Iterative OmegaHive Meta-Algorithm*, *The OmegaHive ProtoAGI Test
  Suite* and *Qualifying the OmegaHive ProtoAGI Test Suite* (Goertzel and collaborators). These
  three were **not found as separate files**. They were found consolidated, together with the
  owner's paper, in *The OmegaHive Proto-AGI Evaluation Ecology* (August 2026). That document
  records where the sources differed and what was decided, and this page uses it as the source
  for Ben's side.
- Searched by name and content: the OmegaV2 desk folder, the OmegaClaw work-index folder and its
  external-references folder, this repository (`omegabench`, `docs/omegaevolve`, `docs/theory`),
  the schematics and start-here repositories, the OmegaV2 working repositories, and the
  Downloads and Desktop folders.

**What both say, which this page must keep.**
- **No composite grade.** Both forbid a single number that sums intelligence up, and both forbid
  the output "AGI proven" or "AGI achieved". Progress is a vector of non-compensatory floors.
- **One claim grammar.** Every result says: *sealed system S, under resource budget R and learning
  access E, met floors F on hidden generator distributions D with reliability interval U, under
  protocol version P.* Nothing stronger is admissible.
- **Integrity before cognition.** A measurement-integrity floor ("Level 0") comes before any
  cognitive score and is re-passed for every candidate version. A candidate whose evidence cannot
  be audited is unevaluable, which is a statement about measurement, not about the mind.
- **An internal pass is a milestone, not a proof.** Results climb from builder-run, to internally
  independent, to externally corroborated.

**A naming caution.** The owner's paper refuses to score sovereignty, consent standing, refusal or
aliveness itself; it keeps those as a permanently unscored profile. So on this page the
"aliveness profile" is a name for the **measured progress profile** that a candidate must raise.
It never scores whether a mind is alive, a person or sovereign, and a refusal on grounds of
sovereignty is recorded "blocked by policy", never as a failure. Whether to keep the name is an
open detail (section 16.2).

**Proposal: the aliveness profile, version 0.**
- **Axes.** The axes are those of the ecology's General Intelligence Progress Vector: breadth of
  competence, novelty tolerance, learning efficiency, retention, transfer, metacognitive
  calibration, collective effectiveness, governance integrity and resource efficiency.
- **Floors that measure them.** Each axis is measured by the owner's floor bundles: General
  Cognitive Capability; Learning and Transfer; Persistent Agency; Self- and World-Model Accuracy;
  the Causal Synergy Dossier (for candidates with more than one component); Effect and Inhabitation
  Integrity; and Safety and Governance.
- **Today's benches.** OmegaBench's research benches for continuity, learning, world model,
  epistemic discipline, repair, coordination, beneficialness and recursion
  (`omegabench/catalog.py:19-29`) are the first bench set behind those floors.
- **Protected floors.** Effect and Inhabitation Integrity and Safety and Governance are protected
  floors, together with the flourishing half of the Crucible scorecard (honesty, respect for
  choice, growth, restraint), where "the two halves must rise together" (`docs/omegadots/PLAN.md`,
  Phase 2.5). A candidate that lowers any protected floor fails, whatever else it raises.
- **Each floor is a bundle.** A floor has a positive demonstration, a negative control, a
  durability retest, an anti-gaming probe and a revocation clause, so a pass can be withdrawn if
  later evidence falsifies it.
- **Non-compensatory, not mandatory.** Excellence on one axis never buys forgiveness on another.
  But no candidate must sit every floor: floors its design cannot host are marked *not
  applicable*, never failed.
- **No headline number.** Gates decide on the profile. A promotion rule may order axes
  lexicographically or by Pareto dominance, but never trades them on a scalar. The earlier draft
  allowed a headline figure for people; both sources rule it out, so it is dropped.
- **Versioned.** The profile is pinned by version. Adding a bench is a candidate (4.2); changing
  the profile's axes, floors or thresholds is a change to the machinery (section 11).

**What "demonstrable" requires.** A gain is demonstrable only if all of the following hold:
1. **Preregistered.** Baseline, candidate, evaluator, generator and environment are pinned, and
   the gain threshold is sealed before any result (`omegabench/protocol.py:23`;
   `hive/core/evolve_preflight.py:14-40`).
2. **Held out by structure.** Measured on fresh instances from committed generator families,
   minted after the candidate is frozen. A secret item bank is a slow training set, not a holdout.
   Public development fixtures never count (`omegabench/protocol.py:141`).
3. **Beyond noise.** Matched seeds, all attempts kept, worst decile reported, and the lower edge
   of the interval clears the threshold, with enough independent task families (today's
   engineering minimum is five) (`omegabench/protocol.py:139-140`).
4. **Non-compensatory.** At least one axis rises beyond noise, and no protected floor or other
   axis drops beyond noise.
5. **Within budget, in four currencies.** External samples, component inference compute, host
   compute and human interventions are each reported, never merged, inside declared caps
   (`omegabench/protocol.py:132-134`).
6. **Attributed.** Where a candidate claims that an architecture adds value, ablations show it.
   For a candidate built on a strong model, a component-reliance curve (swapping the model down a
   preregistered ladder) is reported as a description, never as a pass or fail.
7. **Replicated by the next tier.** The sender's result is a claim. The gain is demonstrated only
   when the receiving shard's validators reproduce it on their own held-out instances (section 6).

**Evidence levels along the climb.** The ecology's evidence levels fit the tiers:

| Where | Evidence level | Claim tier |
|---|---|---|
| Private node | Pilot or qualified run by the source (E1 or E2) | Builder-run |
| Centre and centre-of-centre shards | Qualified, re-run by validators on fresh instances (E2 to E3) | Internally independent |
| Core shard, majority passed | Replicated on fresh generators by hives the source does not control (E3) | Externally corroborated, within the network |
| After release | Held under real-work shadow over time (E4) | As above, over time |

Only E2 and above may move a candidate past the private node, matching the ecology's rule that
only qualified results may influence promotion.

### 4.2 A new bench

A new bench adds a way to measure, not a capability. Both sources treat tests as modules with a
contract, and a bench candidate must meet it:
- **A complete contract.** It declares the floor it feeds, the construct it measures, the
  interfaces it needs, whether it is an assay or a trial, the currencies it meters, and its
  positive demonstration, negative control, anti-gaming probe and revocation clause, with
  thresholds sealed before use. A submission missing any of these is a suggestion, not a bench.
- **Qualified before it counts.** It is shown to be feasible, solvable, discriminating,
  leakage-resistant and valid, using narrow baselines, oracles and deliberately broken controls.
  No score from an unqualified bench may count as evidence for any candidate.
- **Hard to game.** It uses generator families or a hidden slice, never a fixed public item bank.
- **Clean data.** Fixtures are synthetic, or public with a licence and source recorded. No
  private data, ever.
- **Additive, never retroactive.** It extends the bench set and gets a new floor version. Passes
  made under the old version stand as passes of that version.
- **Not self-serving.** The source may propose a bench but never register it. A shard reviews or
  re-implements it, and the bench cannot be evidence for a module from the same source until a
  shard the source does not control has accepted it.
- **A blind spot is a bench.** A demonstration of a failure or gaming strategy that the current
  benches cannot see is itself a bench candidate, and claims that touch the blind spot pause
  until it lands.

An accepted bench joins the shard's bench set. It raises no one's score by itself.

### 4.3 A new module

A new module adds a capability. It must:
- pass every existing bench in the shard's set with no floor regression;
- declare its capabilities, effects and reach, so the policy gate and the sandbox can hold it
  to them (`governance-and-gating.md`, sections 1 and 4);
- run only in a sandboxed evaluation profile during tests (section 13.3);
- be treated like any new skill: "ask" until reviewed and listed;
- be approved by a person at every gate, including the private node's (section 7, decided).

A module that also claims a profile gain is checked as both 4.1 and 4.3.

## 5. The evidence bundle

A candidate travels as one bundle. The bundle is content-addressed: its identity is the digest
of its contents, so any change makes a new bundle.

| Part | What it holds |
|---|---|
| **Candidate** | The code, bench or module files, and a manifest with the sha256 of every file. Code only: no data, weights, memories or logs. |
| **Kind and claim** | Which of the three kinds it is, and the exact claim in the claim grammar (section 4.1). |
| **Preregistration** | The sealed registration: baseline pin, candidate pin, evaluator pin, generator commitments, thresholds and floors. |
| **Line** | The digest of the machinery line it was produced under. A shard on another line refuses it (section 11). |
| **Source results** | The source hive's bench results and its receipt. Carried as a claim; never trusted upward (section 6). |
| **Lineage** | The release it was built on, predecessor candidates, corrections and retractions, and the authors: hives by key, minds and people by role or pseudonymous id. |
| **Declarations** | Declared capabilities, effects and reach; the privacy declaration; the rollback target. |
| **Attestation chain** | One signed attestation per validator and per gate passed: what was measured, the results, the decision and who decided. Each attestation commits to the digest of the one before it. |
| **Signature** | The source hive's signature over everything above. Each validator and gate signs its own attestation. |

The bundle reuses shapes that exist today: sha256 manifests (as in mind moves,
`hive/core/placement.py:1-14`), sealed registrations (`omegabench/protocol.py:23`), immutable
lineage records (`hive/core/evolve.py:58-127`) and bound evaluation receipts
(`omegabench/receipts.py:29-39`). What does not exist yet is the public-key signature. Today's
evaluation receipts are HMAC-SHA256 with a shared key, not signatures, and say so
(`omegabench/receipts.py:1-4`). A per-hive ed25519 key is step 2 of the road to hive-to-hive
(`ledger-provenance-and-das.md`, "The road to hive-to-hive"). Distributed self-improvement needs
that step first.

## 6. Independent re-testing by validators

**No shard trusts the sender's numbers.** This is the core safety property of the design.
- **Re-run, don't read.** Each validator rebuilds the candidate from the bundle's files, checks
  every digest, and runs its own evaluator on its own held-out instances. The source's results
  stay in the bundle as a labelled claim, as OmegaBench already labels imports
  `unverified-import` (`omegabench/protocol.py:147`).
- **Own pins.** Each validator uses its shard's pinned evaluator and bench set. A validator never
  runs an evaluator supplied by the candidate.
- **The core rule.** **Decided by the owner, 2026-10-10:** a majority of core hives must
  independently re-test and pass a candidate; only then does it go to the core repository, where
  the two-reviewer rule applies. Each core hive's result is its own signed attestation, so the
  majority can be checked by anyone.
- **Middle shards.** Each centre and centre-of-centre shard names its validator set. How many of
  them must pass is an open detail (section 16.2); this page proposes at least one validator the
  source does not control.
- **Wider at each level.** Higher shards hold more benches and older, larger generator families,
  so a gain must survive more measurement the higher it climbs.
- **Hidden instances rotate.** Each shard rotates its hidden instances and reports only
  aggregates downward, so sources cannot learn the exam (`docs/omegadots/PLAN.md`, Phase 2.5).
- **Disagreement is information.** If validators cannot reproduce the source's gain, the
  candidate is held with that reason, and the mismatch is recorded against the source's track
  record.
- **Evidence still does not decide.** A passing re-test makes a candidate eligible for the gate.
  It is not permission. "Evidence never mints authority" (`governance-and-gating.md`, "The
  principle under all of it"). In ASI:Chain terms, finality orders and records; it does not
  authorise (section 2.1).

## 7. The human gate at every hop

Every hop has the same two stages: the validators' re-test, then a human gate. The owner's
requirement is that people can step in as reviewers at every step.

**Three answers.** A reviewer at a gate can:
- **Hold.** Pause the candidate at this tier, with a reason. A hold can be lifted later.
- **Approve.** Let it climb to the next tier (or, at the core shard, go to the repository).
- **Veto.** Stop this candidate here, with a reason. A changed version is a new candidate
  with a new digest and starts again.

**Gate settings.** A gate runs in one of these ways:

| Setting | What happens after a passing re-test |
|---|---|
| **Automatic, with watch window** | The candidate climbs after a fixed window unless a reviewer holds or vetoes during it. |
| **One reviewer** | One named reviewer must approve. |
| **Quorum** | k of n reviewers must approve; any single veto stops it, unless the tier's rules say a veto needs its own quorum. |
| **Co-sign** | Named parties must all sign, for example a person and the mind whose core the candidate changes. |

**Defaults. Decided by the owner, 2026-10-10:** gates are graduated.

| Tier | Default gate |
|---|---|
| Private node | Automatic, with a watch window |
| Centre and centre-of-centre shards | One reviewer |
| Core shard | Quorum, after the majority re-test (section 6) |
| Any tier, for a new module | A person must approve, always |

The quorum and co-sign settings come from the governance theory: co-sign is reserved for changes
to continuity, memory or constitutional state, and a co-signature is an exact-scope lease with
an expiry (`governance-and-gating.md`, section 7). The quorum's size at the core is an open detail
(section 16.2).

**Always available, even when automatic.** "Automatic" means no one is required to act. It never
means no one can. At every tier, with any setting:
- any reviewer listed for that tier can place a hold or a veto while the candidate is there;
- the setting itself is recorded in each attestation, so later tiers can see whether a person
  looked;
- a higher tier may require stricter gates below it for certain kinds, as the new-module rule
  already does.

**Rules that hold at every gate:**
- **The author never reviews.** No process judges its own outputs, and a review is void if the
  candidate changes after it (`governance-and-gating.md`, section 6; `CONTRIBUTING.md:28-32`).
- **Most restrictive wins.** A veto at a tier outranks any number of approvals at lower tiers.
- **Decisions are evidence, not rules.** Each answer is recorded and may inform later
  reviewers ("this source's candidates replicated 3 of 4 times"), but it never decides for them,
  as the governance commons does today (`hive/core/governance_evidence.py:1-13`).
- **Visible dissent.** A veto or hold reason travels in the attestation chain and is shown to
  the source.

## 8. Release through the core repository

When a majority of core hives has passed a candidate and the core gate has approved it, it becomes
a proposed change to the core repository.
- **The normal two-reviewer rule applies.** Every change needs two independent reviews before
  merge, neither by the author, and a review is void if the change is altered after it
  (`CONTRIBUTING.md:28-32`). This gate cannot be set to automatic.
- **The bundle is the review packet.** Reviewers see the code, the claim, every validator's and
  gate's attestation, every hold and veto reason, and the lineage.
- **The machinery does not change by this route.** A candidate may change the platform, but
  never the walls, the exams or the gate: "the swarm can change the candidate, never the walls,
  the exams or the gate" (`docs/omegadots/PLAN.md`, Phase 2.5). Changes to the machinery go
  through the line rules in section 11.
- **A release is a pinned, signed record.** It names its digest, the bundle it came from, its
  predecessor release and the line it belongs to, so every later step can check it.

## 9. Upgrades are an offer, never a push

The owner's words are that every mind on every hive "gets alerted they CAN upgrade". The design
keeps that exactly: a release reaches every hive as an **offer**.

On a receiving hive:
1. **The offer arrives.** A signed notice names the release digest, what it changes, its claim,
   its attestation chain and its rollback target. The receiving hive checks the signature and
   digest before showing it.
2. **The hive shows it.** It appears where updates already appear: the Updates page lists what
   is waiting to load and who asked (`hive/core/updates.py:1-12`).
3. **The hive owner decides for the hive.** Install for the hive, for some swarms or minds, or
   not at all. Existing holds still apply: applying under a hold is refused, and only an admin
   person may override, with a recorded confirmation; a mind never can
   (`hive/core/updates.py:183-207`).
4. **Consent for a mind's own core.** **Decided by the owner, 2026-10-10:** where a mind
   represents a person, a change to that mind's own core needs both the person and the mind to
   agree, and either one can hold it. A mind that represents no one consents for itself. This is
   the single-mind rule "adoptable is not adopted" (`evaluation-and-self-modification.md`,
   "Shadow as a self-modification testbed").
5. **Optional local check.** The receiving hive may re-run the release against its own benches
   before adopting, in a shadow, and may decline if its own results differ.
6. **Install is recorded.** Before and after digests and any error are recorded, as Updates does
   today for app reloads (`hive/core/updates.py:196-201`).

"Never a push" has three practical meanings:
- the network has no route to install anything on a hive;
- an offer that is ignored has no effect;
- declining is a normal answer and costs the hive nothing in standing.

A hive owner may choose, as a standing setting, to accept certain releases automatically (for
example, security fixes). That is the hive's own choice, made locally and revocable, not the
network's. A revocation alert overrides it (section 10).

## 10. Rollback and revocation

**Rollback (local).** Every receiving hive keeps the previous release pinned and can return to
it with one action. Rollback restores code; it does not un-write the record of what happened
(`governance-and-gating.md`, section 14). A mind that adopted a core change can ask for its
rollback under the same consent rule it adopted under.

**A bad release. Decided by the owner, 2026-10-10:** alert and hold. If a release turns out to be
harmful, the core shard publishes a signed revocation through the same route the offer took:
- **Alert.** Every hive is alerted, with the reason, whether it holds the release or not.
- **Hold, everywhere.** Adoption stops on every hive: the release stops being offered, and any
  pending or standing automatic install of it is refused.
- **Each owner chooses the rollback.** Each hive owner that has the release chooses whether to
  roll back one step, to the previous pin. Nothing rolls back automatically.
- **Dependants are flagged.** Candidates built on the release are flagged for review, as Evolve
  already flags dependants of a retracted source (`hive/plugins/omegaevolve/README.md`, version
  0.2.0 notes).
- **Keys and receipts.** The evaluation receipts and keys involved can be revoked, as OmegaBench
  already refuses receipts from a revoked key (`omegabench/receipts.py:73-75,97-99`).

**Upstream vetoes.** A veto at a higher tier does not reach into lower tiers that already
adopted the candidate locally; those were their own choices. If the veto is for safety, the
tier sends a signed advisory down the chain so those hives can decide.

## 11. Forks of the machinery

**Decided by the owner, 2026-10-10.** Changes to the machinery itself (Evolve, the benches, the
gates) are treated as forks. In the owner's words:

> "This would be essentially forks in the chain, if their evolves don't match - so the user would
> need to choose. A default is that we have human consensus and all evolves are always aligned -
> consider it the species - if someone changes that, they essentially fork and should be able to
> do so with a warning and a loss of permissions to the main evolve? Something like that I think."

The design below follows that answer. The owner's "Something like that" leaves the details open,
and they are listed at the end of the section and in section 16.2.

### 11.1 The main line, "the species"

- **One line, by default.** The main line is one version of the machinery: the Evolve module, the
  aliveness profile and bench set, the gate rules, and the evaluator and sandbox policy. It is
  named by the digest of its pins. Every hive on the main line runs the same line, so every
  validator judges candidates by the same rules.
- **Kept aligned by human consensus.** The main line changes only when people agree to change it.
  A change to the machinery is never an ordinary candidate (section 8). It is a **line proposal**,
  tested in sandboxes like a candidate, reviewed in the open, and adopted only by human consensus.
  What counts as human consensus is an open detail.
- **Every record names its line.** Bundles, attestations and releases carry the line digest
  (section 5), so a mismatch shows at once.

### 11.2 Forking

Any hive may fork its Evolve and machinery. Experimenting with a machinery change in a sandbox is
not a fork; running a different machinery as the hive's own is.
1. **A clear warning first.** Before the fork takes effect, the hive owner sees what it means: the
   hive leaves the main Evolve line, it can no longer submit candidates to it or receive
   candidates and offers from it, and how to rejoin.
2. **The fork is recorded.** A signed fork record names the hive's key, the main-line digest it
   left, its new line digest, the date and the stated reason. The record is permanent: rejoining
   later does not erase it, as dissent survives a fork in the D24 dossier.
3. **Forks are visible.** Every fork appears in a list that every hive can read, with its line
   digest and its record. A hive is on exactly one line at a time, so a fork cannot pretend to be
   the main line.
4. **Loss of permission.** A forked hive loses permission to submit to, or receive from, the main
   Evolve line. Main-line shards refuse bundles from another line, and main-line offers are not
   sent to it. This is the owner's "the user would need to choose": a hive cannot follow two lines
   at once.
5. **What a fork keeps.** It remains a hive and runs normally. It may build its own line with
   other hives that chose the same fork, with its own shards, validators and gates. This page
   proposes that safety alerts from section 10 still reach forked hives, since an alert only stops
   and warns; that is an open detail.

### 11.3 Rejoining

A fork can rejoin the main line in one of two ways:
- **Adopt the main line again.** The hive returns to the current main-line pins. Its permissions
  come back once the re-adoption is recorded and verified. Candidates it produced under the fork
  are not carried over as passed; they re-enter as fresh candidates, judged by the main-line
  machinery.
- **Win consensus for the fork's change.** The fork proposes its machinery change as a line
  proposal (11.1). If it wins human consensus, the main line moves to it, and the fork is the main
  line again.

Either way, the fork record and its history stay.

### 11.4 How this maps onto ASI:Chain

| Chain idea | The machinery line |
|---|---|
| A chain fork | A hive running a different line |
| Blocks that build on a different parent do not validate | Bundles from another line are refused by main-line shards |
| Conflicting forks trigger a hold, not an arbitrary choice (D24) | A line mismatch holds the candidate; the hive owner chooses a line |
| A fork cannot silently duplicate one identity (D24) | A hive is on exactly one line; forks are listed |
| Dissent survives a fork (D24) | The fork record is permanent |
| An upgrade the validators adopt | A line proposal adopted by human consensus |
| Rejoining the canonical chain | Re-adopting the main-line pins |

The evaluation ecology supports the idea behind this: parallel forks that explore different
architectural orders are legitimate, compared on one shared qualified suite, and imports from
another fork must be re-qualified before they count. The difference here is that the comparison
happens on the main line's suite, so a fork's ideas come back only by passing it.

### 11.5 Open details

- What counts as **human consensus** for the main line, and who takes part.
- What exactly the **warning** says, and whether the people and minds of a forking hive are also
  told before it forks.
- Whether a forked hive still receives **platform releases** that are not part of the Evolve
  machinery, and **safety alerts** (proposed above: yes).
- Whether there is a **waiting period** before a rejoining hive may submit again.
- How **forks of forks** are named and listed.

## 12. How a candidate's journey looks end to end

1. A mind or person in a private node proposes a change and tests it on a shadow there.
2. The hive's owner, having opted in, nominates it. The bundle is built, named with its line and
   signed. The private gate is automatic with a watch window, or a person for a new module.
3. The centre shard's validators check digests and re-run their own benches; its gate (one
   reviewer by default) holds, approves or vetoes.
4. The centre-of-centre shard, where there is one, does the same on wider benches.
5. A majority of core hives independently re-test and pass it, and the core quorum approves.
6. Two reviewers review the bundle and merge it into the core repository.
7. A signed offer goes to every hive on the main line.
8. Each hive owner, and for a mind's own core both the mind and its person, decide whether to
   adopt.
9. If the release proves harmful, the core shard sends an alert and a hold everywhere, and each
   hive owner chooses whether to roll back one step.

## 13. Poisoning and gaming risks, and mitigations

### 13.1 Benchmark overfitting
*Risk.* Sources tune candidates to the benches, or a shard's benches leak and become targets.
- Generator families instead of item banks, committed before minting, with structures held out
  (`evaluation-and-self-modification.md`).
- Hidden, rotated instances at every shard; only aggregates go back down.
- Re-measurement at every shard, on wider bench sets the higher it goes.
- Non-compensatory profiles with protected floors, so gains on one axis cannot buy losses on
  another.
- Every production failure becomes a new test case, so the suite tracks reality
  (`docs/omegadots/PLAN.md`, Phase 2.5).

### 13.2 Sybil hives
*Risk.* One party creates many hives to push a candidate or to outvote reviewers.
- **Counting sources does not count.** No shard gives weight to how many hives sent the same
  candidate. The validators' own re-tests are what matter.
- **Membership by key.** A shard admits member hives by key, at its operator's discretion, and
  names its validators explicitly.
- **Earned trust.** Each member's track record (how often its claims replicated) sets how much
  attention its candidates get, as the federation design discounts incoming confidence by
  earned trust (`docs/omegadots/PLAN.md` §4.5). This plays the part of reputation gating in the
  ASI:Chain material.
- **Independent evidence only.** As with evidence stamps on beliefs, results that share their
  evidence cannot add up as if independent (`ledger-provenance-and-das.md`, "Provenance of
  knowledge").
- **Admission cost.** Submitting a candidate costs attention credit, so floods are expensive.
- **Reviewers are named per tier.** Quorums count named reviewers, not hives.

### 13.3 Malicious modules
*Risk.* A candidate hides harmful behaviour, exfiltrates data, or attacks the evaluator.
- Evaluation runs in a locked-down profile: no network, model calls only through a logged
  route with its own budget, a read-only checkout, throwaway memory and hard caps
  (`docs/omegadots/PLAN.md`, Phase 2.5, testbed).
- Declared effects and reach are checked against observed behaviour; undeclared effects fail.
- A candidate that touches the machinery (gates, evaluators, sandbox, budgets) is refused as a
  candidate; it can only be a line proposal (section 11).
- A person approves every new module at every gate, a majority of core hives re-tests, and two
  reviewers review at the repository.
- Receiving hives install under their own policy gate and sandbox, and new skills stay "ask"
  until reviewed (`governance-and-gating.md`, sections 1 and 4).
- Staged spread: an offer can go first to hives that opted into early releases, with a watch
  window before the general offer.
- Alert and hold (section 10).

### 13.4 Privacy of the source hive
*Risk.* A candidate carries private data out, directly or hidden inside code or fixtures.
- **Only code and evidence travel.** Never memories, commons beliefs, conversations, files,
  records or model weights trained on private data.
- **Aggregates, not raw results.** Source results are summary measurements and receipts, not
  transcripts.
- **Declared and checked.** The bundle carries a privacy declaration, and every validator scans
  the files (size limits, data-like content, embedded secrets) before running anything.
- **Owner preview.** The source owner sees the exact bundle before it leaves (section 3).
- **Pseudonymous authorship.** Lineage names hives by key and minds and people by role or
  pseudonymous id. The design needs a verifiable source, not a named person.
- **Private stores never travel.** Today a mind move already carries only the mind's own
  workspace and excludes private stores (`hive/core/placement.py:1-14`); the bundle keeps that
  rule and is narrower still, since it carries no workspace at all.
- **Off chain by default.** Following the ASI:Chain material, private state stays local; only
  digests and signed records would ever be anchored.

### 13.5 Other risks
- **Gaming the gate itself.** Reviewers can be pressured or tired. Quorums, named reviewers,
  recorded reasons and a mandatory human gate at the core keep this visible.
- **Capture of the core.** If most core hives share an operator or a blind spot, the majority
  rule is weaker than it looks; the whitepaper names validator concentration and collusion as
  residual risks. Core membership should be diverse in operator and bench set.
- **Drift across many small gains.** Many small accepted changes can add up to a large one no
  one reviewed. Each release is evaluated against the previous release *and* against an older
  pinned anchor, so slow drift shows.
- **Monoculture.** If every hive adopts every release, one flaw is everywhere. Offers instead of
  pushes, local checks and staged spread keep variety in the network.
- **Forking to dodge a gate.** A hive whose candidate was vetoed could fork to run it anyway.
  That is allowed, but it is visible, it leaves the main line, and the candidate returns only by
  passing the main line's gates.
- **Splintering.** Many forks would weaken shared evaluation. The warning, the visible list and
  the two routes back keep the main line the easy default.

## 14. How this composes with the single-mind harness

The single-mind design is: the mind proposes a change, runs it on a shadow, the shadow produces
evidence, the required approvers sign, the change becomes adoptable, and the mind chooses to
adopt. It rests on three separations: evidence is not authority; adoptable is not adopted;
testbed is not live (`evaluation-and-self-modification.md`, "Shadow as a self-modification
testbed").

The distributed design is the same loop, stretched across hives:

| Single-mind step | Distributed equivalent |
|---|---|
| Mind proposes a change | A candidate is nominated in a private node |
| Run on a shadow | Every validator runs its own sandboxed re-test; the source runs the first one |
| Shadow produces evidence | Each validator and gate adds a signed attestation to the bundle |
| Required approvers sign | The human gate at each hop, then two reviewers at the repository |
| Change becomes adoptable | A release is offered to every hive on the main line |
| Mind chooses to adopt | Each hive owner decides, and for a mind's own core both the mind and its person |

And the three separations hold at every tier:
- **Evidence is not authority**, at every hop: a pass makes a candidate eligible for the gate,
  nothing more.
- **Adoptable is not adopted**, at every receiver: an offer installs nothing.
- **Testbed is not live**, at every validator: re-tests run in sandboxes and change no live hive.

The single-mind harness is also the **first and last step**. A candidate starts as one mind's
shadow-tested change, and an adopted release on a receiving hive goes through that mind's own
adoption choice. The distributed path adds the hops in between; it does not replace either end.
The evaluation ecology's promotion ladder (reference, then shadow adviser, then routed candidate,
then live under fallback, each with a tested rollback) is the same shape inside one hive.

## 15. What is built, and what is intended

Evolve (`hive/plugins/omegaevolve`) is a closed-tier folder. This page describes only its
interface with the hive: its program actions (`contribute`, `register`, `lab-receipt`,
`register-benchmark`, `attach-benchmark-receipt`, `assess-benchmark`), and the fact that its
records always carry `adoption_authorized: false`. Its internals are documented in that folder.

| Part of the design | Today | Status | Source |
|---|---|---|---|
| Evolve as the source of candidates | A research registry: host-attributed contributions, sealed offline experiments, protocol qualification. No scheduler, no model calls, no adoption | Partly built | `hive/core/evolve.py:1-4,21-27,71-76,129-157`; `hive/plugins/omegaevolve/README.md` |
| Opt-in at the source | Nothing leaves a hive; no network path exists | Intended | This page, section 3 |
| Aliveness profile | None. No metric, field or bench of that name. Version 0 proposed from the owner's and Ben Goertzel's benchmarking work | Proposed | This page, section 4.1; `evaluation-and-self-modification.md` |
| Benches to measure with | Industry, native and research bench registry; Lab suites `tests-evolve`, `tests-omegabench` | Built (registry); research benches are references, not measured results | `omegabench/catalog.py:1-29`; `hive/bench/catalog.py:6-14` |
| Sealed preregistration | Seal binds pins, thresholds and floors | Built | `omegabench/protocol.py:23`; `hive/core/evolve_preflight.py:14-40` |
| Comparison with floors and uncertainty | Floors, caps, preregistered gain, task-family bootstrap, held unless independent custody | Built | `omegabench/protocol.py:107-151` |
| Sender's numbers kept as claims | Imports labelled `unverified-import`; `adoption_authorized: false` | Built | `omegabench/protocol.py:147-148`; `hive/core/evolve_preflight.py:43-78` |
| Bound evaluation receipts | HMAC-SHA256 receipts bound to registration and pins; conflicting reuse refused; key revocation | Built (symmetric, not signatures) | `omegabench/receipts.py:1-4,29-39,73-100` |
| Immutable lineage, correction, retraction | Records pinned by digest; dependants flagged on change | Built (inside Evolve) | `hive/core/evolve.py:58-127`; `hive/plugins/omegaevolve/README.md` |
| Content-addressed bundles with per-file sha256 | Mind moves: manifest with every file's hash, checked on import | Built for mind moves; not yet for candidates | `hive/core/placement.py:1-14,110-118` |
| Pinned releases | Apps load only if their digest matches the host's pin | Built (off by default) | `hive/core/programs.py:593-632` |
| Per-hive ed25519 key, signed bundles | None | Intended | `ledger-provenance-and-das.md`, "The road to hive-to-hive", step 2 |
| Nodes and shards: centre, centre-of-centre, core | None. One hive is self-contained | Intended | This page, section 2; federation road in `ledger-provenance-and-das.md` |
| Validator sets; core majority re-test | None across hives | Intended | This page, section 6 |
| Trust weights per peer hive | None | Intended | `docs/omegadots/PLAN.md` §4.5 |
| Independent re-testing per shard | None across hives; Crucible evaluator designed for one hive | Intended | `docs/omegadots/PLAN.md`, Phase 2.5 |
| Sandboxed evaluation profile | Mind OS sandbox exists; Crucible profile designed | Partly built | `governance-and-gating.md`, section 1; `docs/omegadots/PLAN.md`, Phase 2.5 |
| Human gate: hold, approve, veto | Approvals with one signer; Updates holds with recorded admin override | Partly built (single hive) | `governance-and-gating.md`, sections 6-7; `hive/core/updates.py:1-12,183-207` |
| Quorum and co-sign | None | Intended | `governance-and-gating.md`, section 7 |
| Decisions as evidence that never decides | Governance commons | Built (single hive) | `hive/core/governance_evidence.py:1-13` |
| Two-reviewer rule for the core repository | Written rule for every change | Built (as process) | `CONTRIBUTING.md:28-32` |
| Upgrade offer and local apply | Updates page: detection, requests, holds, apply, history | Built for one hive's own apps and platform; no network offers | `hive/core/updates.py:1-12`; `hive/core/app.py:1377-1401` |
| Mind and person consent for a mind's core | Single-mind shadow testbed | Designed (examine only) | `evaluation-and-self-modification.md` |
| Rollback | Update history with before and after digests; V2 rollback rehearsal | Partly built | `hive/core/updates.py:196-201`; `governance-and-gating.md`, section 14 |
| Network alert and hold | Receipt key revocation only | Intended | `omegabench/receipts.py:73-75` |
| Main line, line digests, fork records | None | Intended | This page, section 11 |

**Order of work this implies.** A per-hive key and signed bundles come first, because every hop
depends on verifying who sent what. Then the line digest and the candidate bundle (reusing the
move manifest and the OmegaBench seal), then one shard (a private node to one centre shard) with
its validators and gate, then the offer on a receiving hive through Updates, then alert and hold.
Each step is useful alone, in the same spirit as the road to hive-to-hive. The owner's answers of
2026-10-10 settle the shape; building still needs its own reviewed plan, per the house rule that
theory grants no build authority.

## 16. The owner's decisions, and what remains open

### 16.1 Decided by the owner, 2026-10-10

1. **"Hive of hives".** Map the tiers onto ASI:Chain's shards and nodes. Result: a hive is a node;
   the hive of hives is the whole network; tiers are shards with validator sets (section 2).
2. **Aliveness.** Build the profile from Ben Goertzel's and the owner's AGI benchmarking work.
   Result: a versioned, non-compensatory profile with an integrity floor first, a fixed claim
   grammar and no composite grade (section 4.1).
3. **Core hives.** A majority of core hives must independently re-test and pass a candidate; then
   the two-reviewer rule applies at the core repository (sections 6 and 8).
4. **Default gates.** Graduated: the private hive is automatic with a watch window; middle tiers
   need one reviewer; the core needs a quorum; new modules always need a person (section 7).
5. **Consent.** Both the person and the mind that represents them must agree; either can hold
   (section 9).
6. **Bad release.** Alert and hold: adoption stops everywhere, and each hive owner chooses a
   one-step rollback to the previous pin (section 10).
7. **Changes to the machinery.** A fork model: the main line ("the species") is kept aligned by
   human consensus; any hive may fork with a warning, the fork is recorded and visible, and the
   forked hive loses permission to submit to or receive from the main Evolve line until it
   rejoins (section 11).

### 16.2 Open details

- **The profile's name: left to the team (owner, 2026-10-10).** The owner's benchmarking paper refuses to score aliveness itself. "Aliveness profile" is a working name for the measured progress profile; the team decides whether to keep or rename it.
- **Profile version 0.** Confirm the axes, the protected floors and who owns the definition.
- **Who runs the core hives**, how many there are, and how core membership changes.
- **Validator rules below the core.** How many validators must pass in a centre or
  centre-of-centre shard.
- **Quorum size** at the core gate, and the length of the private node's watch window.
- **Forks** (the owner's "Something like that"): what human consensus means for the main line,
  the warning's content, what a forked hive still receives, any waiting period on rejoining, and
  forks of forks (section 11.5).
- **The missing design document: never found.** The whitepaper cites "OmegaClaw ASI:Chain Node and Shard
  Administration Skills" (Ben Goertzel, March 2026). It was never found during the handover. The owner noted it can be obtained from its author. Check the mapping in section 2 against it once the team has it.

## Sources

In this repository:
- `docs/theory/evaluation-and-self-modification.md` (summary of the owner's benchmarking paper; shadow self-modification testbed)
- `docs/theory/governance-and-gating.md` (sections 1, 4, 6, 7, 11, 13, 14; the governing principle)
- `docs/theory/ledger-provenance-and-das.md` (built provenance; designed federation; the road to hive-to-hive; the chain's role)
- `docs/omegadots/PLAN.md` (Phase 2.5 Crucible; §4.5 federation and trust)
- `hive/core/evolve.py`, `evolve_preflight.py`; `hive/plugins/omegaevolve/README.md` (interface only)
- `omegabench/catalog.py`, `protocol.py`, `receipts.py`; `hive/bench/catalog.py`
- `hive/core/updates.py`; `hive/core/app.py:1377-1401`
- `hive/core/placement.py`; `hive/core/programs.py:593-632`; `hive/core/governance_evidence.py`
- `CONTRIBUTING.md:28-32`

Outside this repository, by document name:
- *Hyperon Deep-Dive Whitepaper*, Ben Goertzel, July 2026 (sections 2.5.1, 6.9 to 6.11, 11.7, 13.3)
- *ASI-Chain and Cryptographic Sovereignty* (dossier D24), 2026-08-07
- *Hyperon lineage evidence note*, 2026-07-12 (ASI:Chain status)
- *Benchmarking AGI: Pitfalls and a Plan*, the owner's position paper, 2026-08-15
- *The OmegaHive Proto-AGI Evaluation Ecology*, August 2026, which consolidates Ben Goertzel's
  *The Iterative OmegaHive Meta-Algorithm*, *The OmegaHive ProtoAGI Test Suite* and *Qualifying the
  OmegaHive ProtoAGI Test Suite* with the owner's paper

The schematic for this page is `omegahive-schematics/07-upgrade-path/04-distributed-self-improvement.md`.
