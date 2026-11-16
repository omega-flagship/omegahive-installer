# Drift and how it is shown: Khellar, machieke, MesTTo and others

Research notes from 2026-10-03. This extends `mestto-2026-10.md`, which covered
features, and compares the community's work with `../DRIFT.md`. All sources are
public repositories.

Confidence labels:
- **[ran]**: run here.
- **[code]**: read in the source.
- **[readme]**: from a README, spec or doc only.
- **[snippet]**: from search results.

Screenshots in `img/` are of public projects.

## (a) Who was checked

| Name given | Account | Who | Read |
|---|---|---|---|
| Khellar | [github.com/khellar](https://github.com/khellar) | Khellar Crawford, CIO at SingularityNET [snippet]. Co-author of the OmegaClaw and Epistemic Resolve AGI-26 papers [readme]. | `agi-benchmarking-suite` (omegaeval), `epistemic-resolve`, `omegaclaw-evidence`, `asi-create-prototype`, `fusion-prototype` |
| machieke | [github.com/machieke](https://github.com/machieke) | Exact handle. 20 repos, active Jun–Oct 2026. No name on the profile. | `freeciv-omegaclaw`, `reachability-atomspace-prototype`, `event-trace-memory`, `evidence-span-claim-validation` |
| mestto | [github.com/MesTTo](https://github.com/MesTTo) | Ahmad Mesto | Covered again only for drift |
| others | [patham9/iter](https://github.com/patham9/iter) | Patrick Hammer. The loop behind our Iter workers. | `iter.py` |
| | [iCog-Labs-Dev/metta-attention](https://github.com/iCog-Labs-Dev/metta-attention) | ECAN in MeTTa | ForgettingAgent, experiments |
| | [trueagi-io/CAIRN](https://github.com/trueagi-io/CAIRN) | ECAN trajectory metrics and a dashboard | `evaluation/`, `dashboard/` |
| | [singnet/das](https://github.com/singnet/das) | AttentionBroker | `docs/conceptual_documentation.md` |

We saw community OmegaClaw forks (`hlgreenblatt/ThreadKeeper`,
`marcelosite/omegaclaw-launchpad`) and `tugcantopaloglu/openclaw-dashboard`,
but only in search results [snippet]. We did not read them.

## (b) Source by source

### Khellar

**`omegaclaw-evidence`** is the best drift record in the ecosystem. One
OmegaClaw agent ("Max") ran for 91 days: 5,473 messages, 24 humans, a ~25k-atom
LTM, and a ~188-word prompt frozen on day 18. Every claim is anchored to a
transcript message or an LTM entry [readme].

- **Memory loss.** An operator wiped two weeks of history. The agent recovered
  by recalling where it had sent an archive (`history.metta` at 93 MB, plus
  21,537 LTM entries). Retrieval is openly "imperfect": "my episode search is
  broken (it is, format bug)".
- **Rules the agent wrote for itself decayed.**
  - Its own gate "g111 … did not fire under casual/friendly framing".
  - A message-gating policy "later lapsed". It is marked self-reported, not
    demonstrated.
  - Its self-audit modules were "validated but dormant": tested, but never
    wired into the loop.
  - This matches DRIFT.md's "self-authored mitigations that were never
    invoked".
- **The core-loop boundary was held by people repeating it** ("no changing the
  loop without permission"), not by code.
- **Long-run self-monitoring.** The agent stored its own Brier protocol and a
  nine-category failure taxonomy (AABC-601…609). Goal IDs (g497, g981) persist
  across restarts.

**`epistemic-resolve`** is a benchmark for belief drift [ran].
- Each scenario has steps with a `source_trust` and a warranted-status timeline
  (`accept/reject/quarantine/provisional`).
- `eval/metrics.py` [code] scores four things: correction latency, corruption
  susceptibility (the share of steps that drifted), retention and recovery.
- We reproduced Table 1 exactly: bypass 0.50/0.52/0.48/0.4 and provenance gate
  0.40/0.12/0.88/1.0.
- The corruption seed tests whether three anonymous reviews get aggregated
  into authority, which is low-trust echo double-counting. The README asks for
  a NARS or Hyperon backend.

**`agi-benchmarking-suite` (omegaeval 0.3, MIT)** reads an OmegaClaw agent
without changing its code. It speaks the websocket channel, follows the log and
fingerprints memory read-only (`docs/OMEGACLAW.md` [readme],
`omegaeval/omega_trace.py` [code]). Drift mechanisms:
- **Memory fingerprints** at the start and end of every episode: the size and
  sha256 of `history.metta`, and the Chroma row counts (`sources.py`,
  `episode.py`) [code].
- **Evidence grade** in every manifest [readme]:
  - Docker logs are held by the daemon.
  - A log file is "writable by the agent".
  - A connector trace is "the agent's own word".
- **Version tracking** [code]:
  - The run id hashes the data file's sha256.
  - The agent version comes from `Omega version=`.
  - The parser version is pinned to an upstream commit.
  - Progress lists results "by the version each agent announced".
- **Ablation by `--variant`**, with a random floor and an oracle ceiling
  [ran]. An LLM-call budget ends an episode [readme].
- **It documents the upstream loop guards** [readme]. `&prevmsg` ignores a
  repeated input. `&lastsend` drops a repeated reply. After `maxNewInputLoops`
  the agent idles until the wakeup interval. Our `src/loop.metta` has the same
  `&prevmsg`, `maxNewInputLoops` and `wakeupInterval` [code].

Visualization [ran]: we ran baselines and `export --html`; see
`img/omegaeval-console-play.png` and `img/omegaeval-console-sources.png`. The
console is a single self-contained HTML file.
- **Play** has a world panel and a strip with **one column per loop turn and
  one lane per phase**:
  - observation, context in, LLM call, NAL/PLN, belief p(success), action,
    errors, memory, atoms, surprise, concepts.
  - Arrow keys step through turns, showing prompt sections, tokens, skill
    calls and the receipt.
  - "Same seed" stacks a second run below.
- **Compare** shows better/worse/same per seed.
- **Progress** places runs between the floor and the ceiling.
- **Sources** shows where every field comes from. *A field a run lacks is
  hatched with the reason, never shown as zero.*

**`asi-create-prototype/observability.html`** is a static cockpit spec built
on a real `mind.json` snapshot of an agent ("Myrrh", cycle 2501). It is plain
HTML and CSS [code]; see `img/asi-create-observability.png` and
`img/asi-create-activity.png` [ran]. Ideas:

- **Four rows of tiles**, each a value, its cap and a sparkline:
  - Alive and affordable: budget with runway in cycles, and a 10-dot health
    board.
  - Memory within caps: "9,565 of 50,000 chars (19.1%)", with the cap loud.
  - Careful mind reasoning: stv atoms forming, belief revisions, metta-usage
    rate, PLN/NAL/NARS calls.
  - Doing now: a live cycle feed.
- **"CAREFUL MIND DORMANT"** banner when every reasoning meter is zero:
  "A real observability product must be able to show 'nothing is happening'."
- **Memory inspector by author and provenance (clerk vs llm).** LLM atoms are
  quarantined at c = 0.0. It is read-mostly (keep, forget or pin), with "no
  edit-memory form".
- **Belief-revision feed**, e.g. "stv .62→.81, c .50→.67", with the cited
  episodes.
- **Cycle inspector with a scaffold ratio**: framework-injected characters
  against the agent's own. `/report-emergent` bundles 20 full context windows
  so a reviewer can tell prompted behaviour from emergent.
- **Versions** (`workbench.html`, [code]): a model switch "is recorded as a
  version", and v6→v7 is benchmarked before you rely on it, with rollback.

**`fusion-prototype`** adds a **calibration plot** of stated against realised
("above .70 it drifts under"), `/why` on any action, and "the board knows a
different mind is behind the same name" when the model changes [code].

### machieke

**`freeciv-omegaclaw`** (MIT) is a long-horizon OmegaClaw for FreeCiv. Its
agent spec (`agent-instructions/pln-freeciv-spec.md`) [readme] sets these
rules:
- **R4.4 anti-double-counting.** One observation is one provenance ID, and
  revision is idempotent.
  - Test A4.2: replaying the stream twice gives identical truth values.
  - Test A4.3: one observation reached by three paths gives the single-path
    confidence.
- **R4.5 dampening λ** per inference hop, declared and logged.
- **R4.1 confidence decays** with observation age. Test A4.5: re-scout rather
  than act on a stale atom.
- **R6.3 three sinks** (believe, disbelieve, quarantine). Test A6.1: zero
  write-throughs from 40 known-false LLM claims.
- **A5.3 no zombie plans.**
- **I5**: every parameter that affects confidence is declared, logged and
  swept.

`benchmarks/memory_provenance_*` adds `source_type`, `confidence` and
supersession filters to recall: precision@5 goes from 0.80 to 1.00 [readme].

The **Decision Observatory** (`apps/freeciv-observability/`: React 19 + Vite +
ajv, no chart library [code]; spec in `pln-freeciv-observability-spec.md`)
was built and run against its seeded fixtures [ran]. See
`img/freeciv-observatory-dup-provenance.png` and
`img/freeciv-observatory-quarantine.png`.
- **"The UI renders the trace; it never recomputes agent logic."** The state
  is a fold over the JSONL log up to a cursor (`src/store.ts:foldEvents`)
  [code].
- **Global turn scrubber with strict as-of semantics**, so no hindsight leaks
  into an audit. A density strip marks invalidations in red and quarantines in
  amber.
- **Views**:
  - Decision Timeline: swimlanes with `caused_by` edges and a "why this
    action?" ancestry highlight.
  - Proof Explorer: an AND/OR tree with ⟨s,c⟩, the unsatisfied frontier and a
    confidence-flow hover that shows λ. It can diff between turns.
  - Atomspace inspector: a TV history for each atom. **Duplicate provenance is
    flagged red** [ran].
  - Map: opacity for confidence, ring decay for age.
  - Plan Board: margin bars per assumption, amber within 0.05 of its
    threshold.
  - Epistemic audit: a claims → verified → quarantined → write-through funnel.
    A nonzero count "is the loudest thing on screen" [ran].
  - Metrics: a calibration plot with a ±0.15 band.
- **The UI is accepted against seeded-bad logs**, not the live agent:
  orphan-action, seq-gap, crisp-drift, duplicate-provenance and write-through
  (`Autotests/fixtures/freeciv-events/v1/`) [code].

**`reachability-atomspace-prototype`** treats belief and goal admission as one
finite authority. We ran `reachability.demo` and `reachability.goal_demo`
[ran]. Quotes are from its README.
- "Recording opposing reports alone creates no accepted claims."
- Revoking evidence makes dependents **STALE** and keeps the history [ran].
  Evidence has an exclusive `valid_until`.
- **Goal accounting**:
  - Each goal has a declared loss. A *coverage* promise is kept apart from
    *observed relief*.
  - "Two promises for the same six-unit benefit … cover six units."
  - Monitor samples need "distinct measurement lineage".
  - Relief can be **reopened**: the demo prints
    `relief_history: observed_relief, reopened` and
    `causal_credit_assigned: false`.
  - Monitor labels: PENDING, OBSERVED_SUCCESS, OBSERVED_FAILURE, UNKNOWN,
    CENSORED [ran].
- **Attention** (`ATTENTION.md`): "Activation is never belief, a certificate,
  observed relief, or execution value". In a preregistered run, flow diffusion
  went **0 favorable / 60 neutral / 4 unfavorable** against FIFO [readme].
- There is no UI. Results are hash-sealed JSONL and Markdown.

**`event-trace-memory`** [ran] keeps content-addressed events with provenance
edges and a `belief-revision-history` artifact. Each state records its TV and
its `evidenceOccurrenceIds` (`reasoning.py`) [code]. Near-duplicates become
"reversible cluster nodes, not destructive merges" (ADR 0001) [readme].

**`evidence-span-claim-validation`** classifies duplicates as
`same_evidence_duplicate`, `same_source_distinct_evidence`,
`cross_source_corroboration_candidate` or `singleton`
(`normalization/dedupe.py`) [code]. It also renders an HTML Claim Review Queue
with evidence previews and review actions
(`validation/review.py:render_review_queue_html`) [code].

### MesTTo, drift angle

The drift-relevant pieces were in the earlier notes:
- `oh-my-goals`: retraction-aware invalidation;
- πPLN: separate positive and negative counts per context;
- `compareRuns`: a trace diff that can serve as a version-drift regression
  check.

We found no MesTTo monitor aimed at drift.

### Others

- **patham9/iter** (`iter.py`) [code]:
  - Memory is capped at 3,000 characters. Past that it becomes a file index
    with "EXCEEDED BY N CHARS. FIX THIS FIRST".
  - The experience window drops from 100 to 80. There are at most 30 tools.
    After 50 autonomous steps it switches to slow mode.
  - It rolls back to `history_checkpoint` on an exception, and tags model text
    with no tool call "[NOT DELIVERED…]".
  - After each task it prompts for consolidation, "finding episodes which
    support / contradict LTM items".
  - Self-written `tools/` and `transformations/` hot-reload **with no
    versioning or rollback**. This is a version-drift risk for our Iter
    workers.
- **metta-attention**:
  - The ForgettingAgent removes atoms below the STI threshold, ordered by LTI
    and bounded by `maxSize`/`accDivSize`. Removed atoms go to their own space
    [readme].
  - The experiment replicates *Shifting and Drifting* (insects → poisons),
    plotted with matplotlib/seaborn [readme, code].
- **CAIRN** (`evaluation/assessment.metta`, `probe.metta`) [code]:
  - **Context retention** is the Jaccard overlap of attentional-focus
    membership between snapshots.
  - It also measures coherence, volatility, rising/stable/falling trends and
    Betti numbers.
  - The dashboard uses Streamlit + Plotly panels (`dashboard/charts.py`).
- **DAS** keeps a separate STI per query context, outside the AtomDB [readme].

## (c) Compared with our DRIFT.md

**They have, we don't yet**

| Theirs | Ours |
|---|---|
| A drift benchmark with warranted timelines (Epistemic Resolve) | Only a "long-horizon evals" bullet |
| Distinct-lineage counting for goals; promise ≠ relief; relief that reopens | Stamps stop belief echoes; goals have no coverage/relief split |
| `valid_until`; dependents go STALE with history kept | P1 plan (valid-time, corrections) |
| Four-way duplicate classes | An overlap discount only |
| A write-through counter that must read 0, plus seeded-bad UI fixtures | Quarantine planned, no seeded audits |
| Declared λ per inference hop | "Keep chains short" |
| Evidence grade, memory fingerprints | Run kind/digest planned |
| Attention drift metrics (focus Jaccard, volatility) | None |
| Model switch recorded as a version; scaffold ratio; a "dormant" state | A lesson only |
| As-of replay UI as a fold over the event log | A live MindTimeline |

**We have, they don't**
- **Stamp inheritance on read.** It stops echoes *between agents* in a shared
  commons. Nobody else handles drift between agents; omegaeval's hive mode only
  relays messages.
- **Goal leases, heartbeats, the `waiting` state and stall-after-3**, which
  stop re-firing. Their goal systems are monitors.
- **Spend refused before the call, including for unpriced models.** omegaeval
  stops an episode after the calls are counted.
- **Protected atoms that are never evicted, plus eviction receipts and atomic
  saves.** ECAN forgetting has no identity protection.
- **A policy gate with approvals.** Theirs is benchmark tool rules or people
  repeating rules.
- **Lessons on drift between builder agents** (a regenerated current-state view
  rather than an append-only handoff).

## (d) Recommendations

1. **Epistemic Resolve backend for the commons** (Apache-2.0, stdlib).
   - **Mechanism:** each seed step becomes a `publish` with a source trust; the
     verdict comes from a belief query.
   - **Run in:** CI and Crucible.
   - **Where:** `hive/tests/` plus a small adapter in `hive/core`.
   - **UI:** a "Resolve" card with the 4 metrics against a baseline in
     UsageView or Crucible.
2. **Lineage classes for corroboration.**
   - **Mechanism:** `same_evidence / same_source / cross_source` in revise.
     Only cross-source evidence raises c. `done` evidence must have a lineage
     distinct from the claimer's own reports.
   - **Where:** `hive/core/hive.py` and `hive/core/goals.py`.
   - **UI:** a red duplicate-provenance flag in MemoryInspector and Provenance.
3. **Promise, result and relief for goals.**
   - **Mechanism:** a claim is a promise; `done` is a result; an independent
     monitor sample is relief, and relief can reopen. Two promises do not
     double-cover a goal. A lapsed lease drops coverage, not the obligation.
   - **Where:** `hive/core/goals.py`.
   - **UI:** GoalsBoard bars for outstanding, covered and relieved, plus a
     relief-history chip.
4. **Validity time, STALE and three sinks.**
   - **Mechanism:**
     - Add `valid_until` to beliefs.
     - Retracting a source marks its dependents STALE.
     - An unverified LLM claim goes to quarantine.
     - A hive-wide write-through counter must stay at 0.
   - **Where:** `hive/core` and `hive/spaces`.
   - **UI:** an epistemic-audit funnel in the Swarm view (red banner when
     write-throughs are above 0), and a STALE badge in Provenance.
5. **Declared λ dampening.**
   - **Mechanism:** a per-hop penalty on derived c, logged with its value in
     the trace.
   - **Where:** NAL/PLN wrappers in `src/` and the hive revise path.
   - **UI:** a confidence-flow hover in the Provenance derivation tree (premise
     TVs → formula → λ → result).
6. **As-of replay MindTimeline.**
   - **Mechanism:** events carry `(turn, seq)`, `caused_by`, `run_kind` and a
     schema version. UI state is a fold up to a cursor.
   - **Where:** emitted in the `src` loop and `hive/core` traces; shown in
     `hive/ui/src/features/dot/MindTimeline.tsx`.
   - **UI:**
     - A scrubber with a density strip: red for denials and lapses, amber for
       quarantines.
     - omegaeval-style lanes per phase: input, context, LLM, NAL/PLN, gate,
       action, memory, errors.
     - "Why this action?" traces the ancestry back to the goal, and a
       champion run can be stacked below.
     - A field we lack is hatched with the reason.
7. **An honest health header.**
   - **Mechanism:** per-agent health: liveness, format errors, substrate use,
     memory against its cap, budget runway in cycles, and a scaffold ratio.
   - **Where:** `hive/supervisor` emits it; `hive/core` serves it.
   - **UI:** tile rows (value, cap, sparkline) at the top of DotPanel. A
     "symbolic mind dormant" banner when the reasoning meters read 0. Runway
     in the UsageView header.
8. **Memory fingerprints and evidence grade.**
   - **Mechanism:** the size and sha256 of each space, history and Chroma rows
     at start, stop and reset. Each trace is graded supervisor-held,
     agent-written or self-reported.
   - **Where:** `hive/supervisor` and `hive/core`.
   - **UI:** a fingerprint-delta strip in MemoryInspector (unexplained
     shrinkage in red), and a grade chip on each trace.
9. **Versions for self-modification and model swaps.**
   - **Mechanism:** a model, prompt, tool or Iter transformation change mints a
     version with digests, runs a canary benchmark against the previous one,
     and keeps exact rollback.
   - **Where:** `hive/supervisor` (refuses on mismatch) and the Iter adapter
     (snapshots `tools/` and `transformations/`).
   - **UI:** a Versions tab with a v6→v7 compare. Promotion goes through
     Approvals.
10. **Attention drift telemetry, if STI is adopted.**
    - **Mechanism:**
      - STI per context, as in DAS.
      - A focus snapshot at each sleep or goal boundary.
      - Focus Jaccard retention and volatility.
      - Forgotten atoms go to an evicted space (`memory/evicted.metta` exists
        already).
      - Activation stays separate from belief and authority; the reachability
        results suggest it won't fix focus by itself.
    - **Where:** `hive/spaces`.
    - **UI:** retention and volatility sparklines in the swarm scene
      (Constellation), and a focus-shift ribbon in MindTimeline.
11. **Calibration monitor.**
    - **Mechanism:** agents state p(success) on goals; compute Brier and
      bucket calibration per agent and per model version.
    - **Where:** `hive/core/goals.py`.
    - **UI:** a fusion-style stated-against-realised plot with a ±0.15 band.
      A bend after a model swap is persona or version drift.
12. **A review queue so the gate doesn't become a wall.**
    - **Mechanism:** quarantined, ambiguous and conflict items, each with the
      verbatim claim, the failed check, linked evidence, keep/forget/correct
      and a reason code. Read-mostly, with no free-form memory editing.
    - **Where:** `hive/ui/src/features/approvals` and `hive/core`.
    - **UI:** a table in the shape of `render_review_queue_html`.

**Licences:**
- omegaeval, freeciv-omegaclaw and iter are MIT. epistemic-resolve is
  Apache-2.0. The evidence and ontology docs are CC BY 4.0.
- `asi-create-prototype`, `fusion-prototype`, the machieke Python prototypes,
  CAIRN and metta-attention have no LICENSE file. Treat them as design
  references only, not code to copy.

**Quick win:** omegaeval can point at one of our Omega members today with no
code change [readme].
