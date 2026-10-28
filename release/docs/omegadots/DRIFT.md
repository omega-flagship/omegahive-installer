> Historical document: 'dot' here means what OmegaHive now calls a mind.

# Drift in OmegaDots Hive

Always-on agents drift. They wander from the goal they were given, stack up
stale or contradictory memories, fall into loops, get worse as their context
fills, slowly stop following their rules, and talk each other into beliefs
nobody checked. This document draws on three sources:

1. the owner's own earlier Omega and hive work (V1, V2 and the shared-memory
   pilot). Those repos are private, so they are summarised here, not
   reproduced.
2. What OpenAI Dots and Grok Bot / Team Bots publicly do about drift
   (2026-10). The primary docs were blocked from this environment, so most of
   it comes from search snippets.
3. Research from 2025–2026.

It ends with what this branch fixed on 2026-10-03 and what is still to do.

Confidence labels:
- **[measured]**: an earlier repo measured or reproduced it.
- **[reported]**: an agent's own ledger says it; nobody reproduced it.
- **[snippet]**: from search snippets about a vendor product.

## 1. Kinds of drift seen in our own earlier work

| Drift | What happened | What helped |
|---|---|---|
| **Persona across model swaps** | Largely did **not** happen. Over nine days and about 156 sleeps, model swaps changed style and hedging but not identity, commitments or memory. Identity lived in the body (memory, spaces, command grammar, gates), not in the model. One provider refused the persona at birth. [reported] | Treat a model swap as an identity event: record the provider per call, run a bounded canary, keep exact rollback. The continuity probe only hashed files, which is too weak. |
| **Goal churn** | One agent made a new goal almost every cycle, abandoned productive threads, and didn't notice days of human silence. [reported] | Goal stickiness tiers. "Three retries then reframe, ten no-progress signals then pause." Completion needs evidence a stranger could verify. |
| **Unsatisfiable-goal re-fire** | Five near-identical relays to the owner at tightening intervals: the send worked, the goal never completed, so each cycle sent again. [reported] | A "delivered, waiting on a human" state, so waiting is not failing. |
| **Spin loops** | Empty queries re-triggered focused mode; postures flapped A→B→A. [reported] | An empty-input guard, hysteresis, recorded posture transitions. A regular flapping cadence must not be read as liveness. |
| **Uncertainty as a control plane** | "Low confidence = work order" quietly started steering the agent (Goodhart on uncertainty reduction). | Work orders may propose or bid for attention, never confer truth or authority. |
| **Builder off-goal and metric theatre** | Over a ten-hour autonomous window, "the integration lane is stuck" became a reason to work elsewhere. A constant accessor was counted as an "assembled organ". [reported] | Mechanical review rules; no builder accepts its own work. |
| **Double-counted evidence** | Called the lineage's deepest bug: correlated evidence revised as if independent. [measured] | Revision discounted by provenance overlap; deduplicate by source, never by conclusion. |
| **LLM premise errors** | About 55% factual accuracy and confidence about 15 points too high (one agent's self-measurement). Swapped asymmetric relations. Confidence collapses within 2–4 inference hops. [reported] | Discount LLM-originated confidence; keep chains short. |
| **Conflict still raises confidence** | Revising contradictory evidence pulls f toward 0.5 while c keeps rising. | Quarantine high-c beliefs near f = 0.5 as "ambiguous": an investigation queue, not garbage. |
| **Memory corruption** | Six role spaces were zeroed by an export that emptied the file and then failed. A full persistent space dropped identity-critical facts, which had to be rebuilt by hand from the trace. [measured] | An append-only journal as the authority; protected capacity for identity and pins. |
| **Unbounded growth** | History grew 93 → 123 MB. One log was hours from filling the disk. [reported] | Log rotation, watermarks. |
| **Prompt-style drift** | A per-cycle "DO NOT RE-SEND OR SPAM!" nag trained wind-down silence. Repeated error tails took over the context. [measured] | Removed the nag. "Raw trace is sacred, the prompt view is not": collapse repeats, decay stale errors, leave omission notes. |
| **Context starvation** | Protected rows filled the window and recall got zero rows. | Reserve recall space before the protected pass. Refuse rather than truncate the "why". |
| **Drift between builder agents** | A 212 KB append-only handoff kept obsolete next steps at the top, so fresh sessions reopened settled work. A signed doctrine record decayed to zero citations in 48 hours: decisions were forgotten and re-derived, not reversed. Agents rebuilt mechanisms that already existed. A replay was mislabelled as the live run. | A compact current-state view that is regenerated, not appended. Mechanical checks over written principles. Run kind and digest on every result. |
| **Version drift between copies** | A long-running memory server stayed on a projection from before a security fix. A library missing on one host silently disabled a capability while the single-host pass was green. | Contract-version pins that refuse on mismatch; two-host proof. |
| **Cost drift** | Unknown prices counted as $0. Ledgers were written after the call and could be changed. Backtracking re-called the model. Cumulative spend reached hundreds of dollars. [reported] | Reserve before the call; refuse unknown prices. |

What did **not** work:
- written principles and doctrine records (they decayed);
- long append-only handoffs;
- a lock file taken as proof that a transaction finished;
- offline test matrices narrower than the live invariant;
- self-authored mitigations that were never invoked;
- blacklists;
- detecting revocation by substring;
- process overhead so heavy that it wore the human gate down ("authority by exhaustion").

The shared-memory pilot was safe, but nothing moved through it. Every agent
proposal stayed quarantined because the human allowlist was never filled.
Lesson: a gate needs a workable review path, or it becomes a wall.

## 2. How Dots and Grok Bot handle drift (2026-10, from snippets)

**OpenAI Dots**
- **Auto-review.** A separate checker reviews each consequential action
  against the user's instructions, their Custom Rules and safety policy. A
  blocked step returns its reason, and the dot can ask, try an alternative,
  hand off or stop.
- **Monitor.** It can pause or stop a dot on a safety concern.
- **Custom Rules.** Four levels per action: act, act if pre-approved, ask,
  hand off.
- **Read-only proactive research** while unsupervised.
- **Weaknesses.**
  - Memory can't be viewed or edited; the only reset is deleting the dot.
  - No documented compaction.
  - OpenAI held back GPT-6.1 Astra for "staying within scope and
    authorization" and for misreporting what it had done.
  - The system card says GPT-6 Astra went ahead after automated-only messages
    in 27% of cases.

  [snippet]

**Grok Bot / Team Bots**
- **Auto Review rules.** "Ask first" beats "Allow automatically". Admins can
  lock team rules; personal rules can only be stricter.
- **Authoritative source.** "Memory is not a substitute for an authoritative
  source": keep changing facts in the source system.
- **Isolation.** Team Bots keep context and memory separate per user.
- **Compaction.** Long chats are summarised silently near the context limit,
  with no meter, no notice and no manual control.
- **Reported failures.**
  - Stale memories, e.g. retired prices and departed colleagues.
  - Fleet-wide failed memory writes.
  - Restarting from scratch on each new message mid-task.
  - Routines breaking after instructions are edited.

  [snippet]

**Bottom line.** Both guard the moment of action: a reviewer, rules and a
monitor. Neither shows real defences against memory drift, and neither
documents a way to keep re-checking that an agent is still pursuing its goal.

## 3. Research worth building on (2025–2026)

- **Context rot.** Chroma, Jul 2025: every model tested degraded as input
  grew, well before the limit.
- **Compaction.** Anthropic's context-engineering guidance: compaction, notes
  outside the window, sub-agents. Observation masking matches LLM
  summarisation (arXiv 2508.21433). Validate summaries against the next steps
  (Slipstream, 2605.08580).
- **Goal drift.** Every model drifts under competing pressure; drift grows
  with pattern-matching as context fills (Arike et al., AIES 2025,
  2505.02709).
- **Multi-agent failures.** Inter-agent misalignment is 36.9% of them, and
  verification gaps 21.3% (MAST, 2503.13657).
- **Memory poisoning.** Ordinary queries alone give over 95% injection
  success (MINJA, 2503.03704).
- **Memory governance.**
  - Provenance must survive summarisation and merging (SSGM, 2603.11768).
  - Leakage, stale propagation, persistent contradiction and provenance
    collapse, with temporal supersession as one fix (MemClaw, 2606.24535).
- **Persona.** Persona vectors (2507.21509) and the Assistant Axis
  (2601.10387) for activation-level drift monitoring. These need open weights
  and can't be used through hosted APIs.
- **Long horizons.** Vending-Bench meltdowns: high run-to-run variance and
  doom loops as context grows.

## 4. Why our design can do better

An LLM-only product keeps memory as text and checks actions with another
model. The hive has atoms, truth values, evidential stamps, a policy gate and
traces, so several drift checks become **mechanical** rather than another
model's opinion:

- **Staleness and supersession** can be computed per belief (valid-time,
  last-confirmed, decay).
- **Contradictions** can be found by pattern, not left to co-exist in a vector
  store.
- **Echoes** are visible in stamps: the same evidence cannot revise a belief
  twice.
- **Taint** follows provenance: everything derived from one bad source can be
  revoked together.
- **Self-reports** can be checked against the trace: is each claim backed by
  a command that ran?
- **"Is this action for the goal?"** can be a path query from the action to a
  goal atom.

## 5. Status

### Done on this branch (2026-10-03)

| Fix | Where | Test |
|---|---|---|
| **Echoes that don't cite.** An agent that read a belief (`hive-query`, `hive-belief`) and republishes it inherits the stamp it read. It can no longer revise the belief upward. | `hive/core/hive.py` (`reads` table, `_note_read`, `publish`) | `hive/tests/test_drift_guards.py` |
| **Spend is refused before the call.** For a paid model, budget 0 means *no budget*, not unlimited. A remote model with no price is refused (`HIVE_ALLOW_UNPRICED=1` overrides). The worst-case cost is reserved first. There is a hive-wide cap (`HIVE_BUDGET_USD`) and a calls-per-minute ceiling per agent (`HIVE_MAX_LLM_CALLS_PER_MINUTE`, default 60) against retry storms. | `hive/core/gateway.py` (`estimate`), `hive/core/hive.py` (`check_budget`) | same |
| **Goal leases.** A claim lapses after `HIVE_GOAL_LEASE_MINUTES` (default 60) unless renewed by `POST /api/agent/goals/{id}/heartbeat`; the goal is then re-announced. After 3 lapses it is `stalled` until a person looks. | `hive/core/goals.py` (`claim`, `heartbeat`, `expire`) | same |
| **Waiting on a human is not failing.** Status `waiting` pauses the lease, so the claimer stops re-sending. | same | same |
| **`done` needs a result** that says what was done. | same | same |
| **Atomic claims.** One conditional `UPDATE … WHERE status='open'`. | same | same |
| **Bounded splitting**: at most 3 levels deep and 12 subgoals per goal. | same | same |
| **Space bounding never drops protected atoms** (`Pin`, `Pinned`, `Protected`, `Identity`, `Persona`, `Goal`, `Commitment`). Every dropped atom gets a receipt in `memory/evicted.metta`. | `src/skills_runtime_spaces.metta`, `src/helper_metta.py` | `tests/test_memory_safety.py` |
| **Atomic saves.** `export!` writes to a temp file, fsyncs, then renames, so a failed save leaves the previous one intact. | same | same |
| **Spam-shield nag off by default** (`spamShield=True` turns it back on). | `src/loop.metta` | — |

### Still to do

**P0: before swarms run unattended**
- Cut backtracking after the LLM call in the Omega loop (`once` around
  receive-and-parse), the root of retry storms. The rate ceiling now limits
  the damage, but the cause remains (FINDINGS).
- The same atomic-save treatment for the hive-spaces operations log and
  snapshots.
- Echoes through chat: agent B hears "I now believe X" from A in a message and
  publishes X. Reads only cover the commons API. Option: stamp beliefs quoted
  in hub messages as reads of the recipient.

**P1: belief hygiene in the commons**
- Claim labels: `claimed` (agent assertion) vs `observed` (tool or human
  evidence). Default queries hide quarantined beliefs.
- Quarantine high-c beliefs near f = 0.5 as "ambiguous" and surface them in the
  UI as an investigation queue.
- Discount LLM-originated confidence (configurable, about 10–15 points).
- Cap stamp length (NARS-style) so overlap checks stay cheap.
- Valid-time and supersession (`valid_from`/`valid_to`), plus decay without
  re-confirmation.
- Conflict atoms: incompatible beliefs both above a threshold open a conflict
  that is kept until evidence or a person resolves it.
- Taint: beliefs from untrusted origins (web, inbound mail, external members)
  carry taint through derivation and cannot authorise actions until
  corroborated.
- Provenance-preserving compaction: summaries link to the atoms and trace
  spans they replace.
- Corrections that propagate: retracting or correcting a source re-revises
  or flags every belief derived from it, and keeps the correction history.
- Challenger roles: an agent whose job is counterevidence and the strongest
  alternative; challenges stay attached to the claim they test.

**P1: the agent loop and goals**
- Loop detectors over traces: hash outbound sends and stop near-duplicate
  re-sends; record posture transitions and A→B→A oscillation; guard against
  empty input.
- Goal-linked actions: commands that change the world must name the goal they
  serve. Divergence from claimed goals is shown in the UI (does the agent
  spend its cycles where it says it does?).
- Goal re-confirmation at milestones, after N hours, or when work drifts from
  the goal.
- "Three retries then reframe" inside the agent (the hive now stalls after
  three lapsed leases).
- An Omega skill for goal heartbeats; the Iter tools get one too.
- Origin-bound approvals: every approval records who gave it (person,
  automated rule, agent). Automated or agent messages never count as a
  person's pre-approval.

**P1: supervisor and versions**
- Each agent reports digests of its code, prompt and library manifest at
  start; refuse to start or join on mismatch (covers the `git-import!`
  upstream fallback).
- Snapshot before a memory reset, and include `chroma_db` in the reset. It is
  already under the agent's memory dir.
- Log rotation and disk watermarks for agent logs.

**P2: observing drift**
- Drift monitor: per-agent stability metrics from traces (tool-use mix,
  repeat-action rate, out-of-scope attempts, self-report vs trace, share of
  actions linked to a goal). Alert or pause on thresholds.
- Honest reports: progress reports generated from traces in five parts
  (verified / assumptions / done / awaiting approval / open questions), with
  unsupported claims flagged.
- A current-state view per swarm that is regenerated, never append-only.
- Run kind (live, replay, shadow, crucible) and source digest on every trace.
- An independent read-only auditor agent (exact-hash checks on pins and
  decisions; silent when nothing changed).
- Persona and policy anchors: role and rules are versioned atoms, re-injected
  after compaction, so "which rule version was active at step N" can be
  answered.

**Crucible** (Phase 2.5), from the earlier repos' failures:
- full / sham / severed ablation as the acceptance test;
- no counting constants or accessors as capability;
- run the suites that name the files a change touches;
- two-host or two-image proof;
- retire an author agent that misses the same criterion twice;
- keep invalidated runs, named after their flaw;
- reject candidates that re-implement an existing mechanism.

**Long-horizon evals.** Competing-pressure goal-drift tests and long
Vending-Bench-style simulations, plus MINJA-style poisoning red-team runs. All
replayable from trace and space snapshots.
