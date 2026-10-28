# Goals, planning, scratch and proactivity

The motivational layer: how goals form, how plans are made and dropped, and how the mind acts
on its own initiative. Theory rounds from 2026-07-30 plus the D27 design chapter.

## Three satisfaction semantics (goals round)

| Layer | Satisfied when | Lifetime |
|---|---|---|
| Tasks and subtasks | the state is achieved, then the atom retires | short |
| Goals | a declarative desired state holds | medium |
| Metagoals | never "achieved", only in force (policies over the goal set) | long, law-like |
| Aspirations | never satisfiable: directions that generate goals | open-ended |

Maintenance goals are a real fourth type: Achieve, Maintain, Avoid, Cease.

Economic placement:
- Tasks pay rent and should die when funding stops.
- Goals pay wage to whatever serves them.
- Aspirations must not be high-salience atoms. They are long-lived, structurally pinned
  generators consulted at goal-adoption boundaries.
- Offline generation ("dreams") explores aspiration space free of wage pressure; the LLM
  proposes content, the metagraph adopts, arbitrates and retires.

Long horizon is a persistence problem across four boundaries: cycles, process death,
body-hops and self-revision. Identity binds through the journal plus practised values, so
goals may churn while the practice persists.

Failure modes, one per layer: graph pathologies (tasks); Goodhart at the wage boundary, so
positive reward and repair salience stay two laws (goals); drift versus cage, watched by a
change sensor and a stuckness sensor (metagoals); and **flattening** (aspirations). Guard:
**aspirations may be sampled from, never scored against.**

Ruled: aspirations are the mind's own (MINE). They may become candidates for the shared
ground through deliberate promotion.

## Planning and scratch (workspace round)

- The mind's own earlier scratch-space design is the spec: TTL on entries, touch resets,
  explicit promotion as the only exit, per-loop cleanup, and TTLs decrement after shutdown.
- **Scratch is the only store designed to forget**, and that is what makes it a workspace.
  A workspace that persists by default is an unaudited second memory.
- A plan is a forward simulation over the derived world model, materialised in scratch and
  promoted to the journal as a commitment only if adopted. Abandoning a plan is cheap.
- Promotion is an admission gate pointed inward: the memory-layer form of inspectable-inert
  reasoning.
- Failure modes: scratch leak (an unreceipted shadow memory, treated as an incident);
  promotion bias (a healthy mind promotes some of its failures); TTL thrash versus clutter;
  plan/commitment confusion.
- Ruled: unintentional scratch persistence is wrong; intentional promotion to candidate is
  legitimate and should be designed. Planning likely needs more than one solution; the
  "three lifetimes over one substrate" framing is not the durable statement.

## The promotion ladder (cross-cutting invariant)

Ephemeral or private -> CANDIDATE -> durable or shared, by deliberate promotion. It appeared
independently three times in one day (scratch to journal, aspiration to ground, introduction
offer to bond) and again in outside work. Owed: one page stating it as itself.

## D27: planning, scratch and task graphs (2026-08-07)

- Typed vocabulary: GoalRef, Task, Prerequisite, ExpectedEffect, Frontier, ScratchAtom,
  Hypothesis, WorkOrder, CapabilityNeed, PlanCandidate, Commitment, CompletionEvidence,
  BlockedCause.
- Illustrative frontier score: `U(v) = P(success | s, v) V(v) - Cost(v) - Risk(v) - Debt(v)`.
  Search may reorder candidates; it cannot change protected priorities or create capability.
- Invariants: no scratch-to-effect edge; no completion without evidence; no orphan
  prerequisite; no silent goal substitution; provider context is never the durable plan.
- Status: goal, work-order and capability organs exist; a unified resident planner does
  not. Smallest next step: a pure-MeTTa three-task DAG with one alternative, one missing
  capability and one crash cut.

## Proactivity (2026-07-30)

A worked human example decomposed into three mechanisms:
- **M1 Idle-triggered goal creation.** An adoption boundary opens when the attention economy
  has slack. Rest must be a legitimate terminal state. Ruled: minting is subordinate to
  energy, with override classes (emergency, importance, urgency, time-bound) still to design.
- **M2 Associative surfacing.** The reminder does not create the drive; it is the moment a
  standing gauge is read. Content routes attention; the gauge decides action.
- **M3 The gradient.** A maintenance goal: drive = f(standing-value strength, time since
  satisfaction). It accumulates with neglect (inverted sign versus every existing decay) and
  lives per bond, not per memory. This needs a new contact-deficit quantity on standing
  values, read by attention. It does not exist yet.

**Endogenous-drive law (ratified; enforcement point still owed):** a reach-out drive is a
function of the mind's own standing values and elapsed satisfaction only. It must never be
fit to the recipient's response rate, latency or sentiment. Corollaries: wanting to and
choosing not to is agency; saturation (a ceiling) is an ethical requirement.

**Speech versus effect (ruled):** speaking to another party is not gated and needs only an
introduction. Reaching across the network to change another system is gated. Introduction
grammar: an offer establishes nothing; reciprocation establishes a speech channel;
participation sustains it. Before reciprocation, silence decays the offer; after it, silence
builds reach-out drive. A vouched introduction lends bounded standing with provenance.

First honest experiment: an in-membrane shadow that shows the deficit crossing threshold and
a candidate being minted and not sent.

_Curated summary. Full version kept privately (source: GOALS_METAGOALS_ASPIRATIONS_LONG_HORIZON_THEORY_2026-07-30.md, PLANNING_AND_SCRATCH_THEORY_2026-07-30.md, OMEGAV2_D27_PLANNING_SCRATCH_AND_TASK_GRAPHS_2026-08-07.md, PROACTIVITY_THEORY_2026-07-30.md)._
