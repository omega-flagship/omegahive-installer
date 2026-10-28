# Reviewed platform plans (state at 2026-10-09)

Every platform plan goes to two independent reviewers (a GPT-based reviewer and a reviewer from a different model family) before anything is built. A plan that clears review still waits for the project lead's OK before implementation. This file gives one section per plan family, using the latest revision.

| Plan family | Latest revision | Review state | Next gate |
|---|---|---|---|
| Mind memory with multiple indexes | 2nd, with one amendment | Passed the first independent review; the second reviewer's blockers are closed | project lead's OK; stage 0 backup gate |
| Personal mind as the Ask | 1st, with the project lead's rulings | Rulings recorded; the first two parts deployed | further steps per review |
| Tools 0.6.3 native-mind acceptance | 3rd | Review asked the 2nd for fixes first; the 3rd answers them | A passing review of the 3rd, then one capped live run |
| Mind-space worker CSP (host part) | 1st | Plan only | built after the wiring plan is approved |
| Cloud Code first cut (install runbook) | 4th | The 3rd passed one review and the other asked for fixes first; the 4th is unverified | independent re-check, both reviewers, three yeses |
| Honest truth values | 4th | Passed the first independent review; the second reviewer passed it at the 2nd | project lead's OK; one domain ruling |
| Scratch confined Code instance runbook | draft after the 2nd | At the previous draft one review asked for fixes first, the other passed | re-review |
| Cloud Code plan | 1st | Passed, with implementation gates | superseded by the owner contract |
| Loop purpose tuning | 1st | Review asked for fixes first | revision (owned by Surface) |
| Surface plans (browser personal mind, hive view scaling, mind MeTTa wiring) | 6th / 2nd / 5th | Passed | project lead's OK (Surface owns the texts) |

## 1. Mind memory: one record, many indexes

**Idea.** Today a mind's memory sits in three stores that do not know each other: a vector store (found by meaning), symbolic spaces (found by pattern) and a history file (found by time). The vector store's id is thrown away. The plan makes one memory one record with one id; every way of searching becomes an index pointing back to that id. Recall asks every index at once, merges fairly (reciprocal rank fusion), follows links a little, reasons over the small result and writes conclusions back with sources.

**Key rules.**
- Nothing can be lost: each memory is first written in full to a durable canonical store; every index is a rebuildable projection.
- Existing memories are copied, never moved. Originals stay until a backup restore has been proven.
- The in-mind working set is a non-destructive cache: only durably committed records may leave it, and they can always come back.
- Privacy has two parts: where memory is stored (with its mind, or in the person's browser), and what is sent to the model (exactly today's gates, however many new search modes exist).
- **A1:** a separate `Words` fingerprint atom carries a salted fingerprint of a memory's words, so a forgotten memory stays forgotten if re-delivered under a new id.

**Stages.** 0: synthetic backup and restore round trip (blocks import and rebuild). 1: canonical store, id-first remember, text and time lanes, fusion, bounded promotion, reconciler. 1b: copy-only legacy import. 1c: projection rebuild with rename swap. 2: structured writes with stamps (needs a domain ruling on revision first). 3: typed links and the hot cache. 4: reasoning with a rule allowlist and stamp-overlap check. 5: consolidation and retire. 6: personal minds in the browser, qualified separately. Every stage is off by default until its benchmark and review pass; a shadow run is required before anything is called accepted.

**Open.** Clarify browser-to-host transmission versus model disclosure; specify a write barrier for import and rebuild; make several implementation checks explicit.

## 2. Personal mind as the Ask

**Idea.** Every named person has one personal mind, asleep in a swarm of its own, created automatically on first sign-in (or by a startup backfill), with zero model calls. The Ask speaks as that mind.

**Rulings recorded.**
- When a person talks to a swarm, that swarm's coordinator answers. A memory-only copy goes to the person's mind: no turn, no model call, no wake.
- The personal mind's memory lives in the person's browser. The hive holds only identity, routing, billing and version. Swarm copies wait on the hive for that person only, bounded and expiring after 7 days.
- Memory must survive a cleared cache: download and restore (M1), a linked folder (M2), a local hive linked to the cloud (M3, later) and an encrypted cloud backup (M4, later).
- Personal apps live in the person's own swarm; everything else comes from an app store of reviewed, pinned releases.
- Versions are pinned triples (body template, model, conductor revision); the person adopts the best benchmarked version with one click and can roll back.

## 3. Tools 0.6.3: native-mind acceptance

**Stage A (the review ask).** One omega mind, not told the tool's name, chooses and calls one native tool from its registered surface, receives the frozen result and relays it. The plan fixes authority, abort conditions before any change, a full snapshot, temporary caps read back before wake, observable units and deadlines, pass criteria E1 to E6, ordered cleanup on every exit, a $0.50 cap, and a receipt that opens with a fixed scope sentence (it is not evidence of semantic tool discovery).
**Stage B.** Caller adapters for Foundations recipes and for the iter harness; a new feature needing the project lead's OK.
**Stage C.** An MCP program-act tool for module members; proposal only.

## 4. Mind-space worker CSP (host part)

On one exactly matched worker asset only, the host adds a deny-all Content-Security-Policy and `nosniff`. No eval or wasm allowances are needed. Tests check the header on the matching chunk only. A page-wide policy is a separate round.

## 5. Cloud Code first cut (install runbook)

Installs the Code service on the cloud hive with execution disabled and copy-apply off, against a synthetic repository only. Approved by the project lead in principle: the Code account, its directories and a loopback-only service. The third revision moved registration offline so no credential reaches the Code port, made state per-run with an append-only journal, and re-checks the hive release just before restart. The fourth limits what leaves the host to one allowlisted receipt export (names, sizes and hashes only for everything else) and makes the Git-config restore decide before it mutates. **The fourth revision is unverified:** its author's shell was blocked part-way, so its kit hashes were never computed. Next: read every changed file, compute hashes independently, send to both reviewers. It still needs three explicit yeses and a quiet window of about ten hive restarts.

## 6. Honest truth values

**Idea.** A truth value must say where it came from. Three sources: author estimate (default), app-claimed computed (with a basis, shown as "not checked by the hive"), and hive-computed (host only). A program cannot produce hive-computed; the host downgrades any attempt.
**Stage 1.** Commons beliefs are labelled from replayed MeTTa state: the publish op writes a single-assignment `Lineage` atom beside `Current`. Only an actual revision on an anchored lineage counts as computed; an unanchored state is sticky until a reset or replay. UI marks estimates and claims visibly.
**Stage 2.** Evolve benchmark truth computed in MeTTa from per-family counts (the proposition is "mean delta over baseline is positive" per task family), stored as counts, read only by assessment-record digest.
**Open.** A domain ruling on counts versus a bound; whether the browser MeTTa copy wants lineage; whether the Truth app wants to send app-claimed values.

## 7. Scratch confined Code instance runbook

A draft runbook for a scratch Code instance on a local port, revised several times against an independent reviewer's findings. Not run. Superseded in practice by the Linux owner contract and the cloud first-cut runbook.

## 8. Related audit: NAL and PLN against the literature

The second check (read-only) found NAL matches the reference NARS implementation and the published theory, with duplicate results explained by two loaded rule libraries. Per the project lead's ruling, PLN stays as it is. Disagreements are routed to the domain author.

_Curated summary. Full version kept privately (source: PLATFORM_MIND_MEMORY_MULTI_INDEX_PLAN_R2_20261009.md, PLATFORM_MIND_MEMORY_MULTI_INDEX_PLAN_R2_AMENDMENT_A1_20261009.md, PLATFORM_PERSONAL_MIND_ASK_PLAN_R1_20261008.md, PLATFORM_TOOLS_NATIVE_ACCEPTANCE_PLAN_R3_20261008.md, PLATFORM_WORKER_CSP_HOST_PLAN_R1_20261009.md, PLATFORM_CLOUD_CODE_FIRST_CUT_RUNBOOK_R4_20261009.md, PLATFORM_HONEST_TRUTH_VALUES_PLAN_R4_20261009.md, PLATFORM_CODE_SCRATCH345F_RUNBOOK_r2.5_20261008.md, PLATFORM_NAL_PLN_LITERATURE_AUDIT_R2_20261009.md, and the matching *_STANDIN_VERDICT.md files)._
