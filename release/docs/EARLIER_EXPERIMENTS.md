# Earlier experiments: candidates for inclusion

Several capabilities that are switched off, held or absent in this release were built and tested
in earlier builds or in the separate V2 body. This page lists them with their evidence level,
where the work lives, and what it would take to bring each one into OmegaHive. It is metadata
only: build names, dates, commit ids, test counts and outcomes. No private content of any mind or
app is cited.

**Evidence levels**
- **Verified**: an independent receipt, a signed or logged test run, or a shadow-run receipt with
  exact ids.
- **Reviewed record**: a VERIFIED or ACCEPTED entry in a reviewed handoff or audit, with ids; not
  re-run for this page.
- **Reported**: claimed or self-reported, or carrying material caveats.

"Different body" means the result belongs to the OmegaClaw V2 body (closed repo `omegav2`), not to
this repository's mind loop.

## In this repository, held for activation

| Capability | Evidence | Level | Why it is not on | To bring it in |
|---|---|---|---|---|
| **Reasoning foundation (Hyperon Phase A):** NAL/NARS through the production skill path, honest ERROR/EMPTY results, restart stamp, dedup, private-swarm refusal | Platform branch, 2026-10-05. Independent frozen-export PeTTa run at eb66a37: 45 passed, 1 xfail, 76 subtests. Assembly bf57ed1: **69 passed, 1 xfail, 126 subtests**; assembly gate PASS | Verified | Held deliberately for the reasoning owner's operator-naming ruling and an activation review. Not a defect | The naming ruling, then the reviewed activation ladder: offline MeTTa, scratch hive, two opt-in non-private minds, wider only with the project lead |
| **OBSERVE organ:** experience to atoms, written by the core, not the LLM | Default-off source, 2026-10-05: 2acc9dd, 5c6f217, then **ae47103 SHIP**; independent run **64 passed, 1 skipped, 117 subtests** | Verified (source and tests); no live acceptance | Default-off by design; organ writes to a mind's own memory were approved in principle on 2026-10-05 | Phase B of the tuning plan: shared gates and telemetry, then a two-mind cohort |
| **Zero-reasoning baseline** | Symbolic baseline, 2026-10-05, read-only: 0 executed reasoning calls in 876 non-private traces, with fixed definitions for an after-measure | Verified (as a baseline) | Measured with automatic invocation intentionally unwired | It is the "before" of the rollout. Rerun the same measure after activation |
| **Assume, a predictive-coding organ** (`modules/assume`; FabricPC on JAX) | About 50 skills, graph in MeTTa atoms, symbolic mutation review. Offline run on 2026-10-10 in a scratch copy: `test_assume*.py` and the syntax smoke **50 passed, 12 skipped** (all 12 need FabricPC), 72 subtests; five MeTTa smokes clean on PeTTa. It ran as a warm daemon organ in the V1 body (May to August 2026) | Verified (symbolic side); Reported (JAX side, not run on this host) | Optional; not enabled for hive minds. FabricPC is an external checkout and the installer clones its `main` unpinned | **Should be compatible via the existing `modules/assume` seam.** Pin a FabricPC tag (v0.3.2 or later), provision its venv inside the mind workspace and sandbox, use a CPU-only JAX on the cloud, then run the 12 skipped tests as the qualifier. One MeTTa smoke (boot-loaded-loop) fails to parse when run directly; fix that first |
| **Same libraries in the browser** | The demo commons runs the pinned lib_nal, lib_pln and lib_hive in MeTTaScript (live on the cloud, 3626a88). Parity receipt 2026-10-09: 86 cases against PeTTa ae66fa8, 79 matching, 0 mismatches (7 not compared); 33/33 scenario steps | Verified | Live for the demo; the personal-mind path chose a browser Iter instead (2026-10-09) | Already in. Add a live conformance runner shared by PeTTa and MeTTaScript |
| **Code service and vibe coding** | Live on the owner's Mac hive since 2026-10-08 (Code release 345fde53, host 4abf4e3): real runs recorded, relay probes 7/7, pytest 121 passed | Verified (live receipt) | The cloud install is in review | The reviewed cloud install runbook, with the owner's approvals |
| **Local-only swarms** | Live egress proof on build 1a1b268 (2026-10-04): an outside model call refused (403 `egress_refused`), the local mock allowed (200) | Verified (live receipt) | Used only by a closed app today | Already in (`HIVE_LOCAL_ONLY_SWARMS`) |
| **Syntax membrane and MeTTa capability surface** (V1 patches, vendored here) | V1 locked patches, June 2026: syntax membrane a93be5f (46 tests), capability surface 0275511 (59 passed plus 5 subtests), feedback semantics b9e395e. A six-model autonomy benchmark on a clean test instance | Reviewed record | Already in | Already in; the audit judged the built-in scorecard too generous, so re-score with an independent judge |

## In the V2 body (different body; closed repo `omegav2`)

| Capability | Evidence | Level | To bring it in |
|---|---|---|---|
| **NAL running inside a mind's autonomous cycle** | V2 shadow body, Stage-6 "+NAL salience", accepted 2026-07-24: 12 real provider calls, 3 arms × 4 cycles, reproduced JSON-equal; contracts 65/65, body suite 93/93. Leave-one-out ensemble: 28 calls, 7 arms, 7/7 wire predictions (supported, narrow). Earlier component: NAL salience loop 52/52 (2026-07-14) | Verified, narrow | **Needs an adapter.** Run it through the per-cycle `RuntimeHook` (`register-runtime-hook`, phase `cycle`). Persist salience state across turns first (it was rebuilt each turn in V2) |
| **Decisions computed in MeTTa; MeTTa sequencing the cycle** | 2026-07-23 audit: 13 PeTTa invocations per turn computed every decision. 2026-07-24: a MeTTa cycle composer (4 MeTTa files, 0 Python) accepted at build stage; 95/95 focused tests. Later 609 equal MeTTa/PeTTa invocations per arm | Reviewed record | The `cycle` RuntimeHook seam is the entry point; a full resident run of the composer is not recorded |
| **AtomSpace (PeTTa) as the state of record** | V2 whole brain of record, 2026-08-18: 312 components, twin sealed artifacts, dual-cleared. PeTTa ruled the official AtomSpace implementation (2026-08-17) | Reviewed record | Here long-term recall is ChromaDB beside the AtomSpace. A state spine needs the V2 journal, which this repo lacks |
| **Stored context causally changes behaviour** | V2 run-04, 2026-07-20, signed blind receipts: linked controls changed 2/2, unlinked 0/2, structural fabrications 0/7; three-party adjudication 2026-07-28 | Verified (7 traces; not a rate) | A matched benchmark arm (full, sham, severed) in OmegaBench |
| **Atom, vector and history recall linked** | V2 V81r10, 2026-09-20: 14/14 offline integration checks, 3 deterministic provider cycles; autonomous memory route accepted 2026-09-21/22 with 11 tamper refusals reproduced | Verified, offline | Offline and deterministic only; real-model quality unknown. The next context successor was ruled REVISE (2026-09-23) |
| **End to end, with real turns on a real channel** | Talkable shadow 2026-08-19; end-to-end shadow on the assembled body 2026-08-25; Layer-A V10 2026-09-02: 122/122 and 14/14; real-provider WhatsApp turns delivered and acknowledged around 2026-09-15 | Verified / reviewed record | Live admission is gated by the project lead. Turns 29–30 showed recall starvation and a timeout |
| **Native attention bank** | V2, 2026-07-14: conserved STI/LTI economy, 50/50; a paired ablation changed what reached deliberation before any model call; later in a 274/274 seven-component sweep. Persistent focus space assembled (2026-08-17) | Reviewed record | **Needs an adapter** behind `lib_omegaclaw_attention.metta`, replacing `attention_ledger.py`. Note the qualified negative: raw ECAN spreading cut focus precision to 2/3; a utility gate restored 3/3 (synthetic) |
| **Rollback without forgetting; hash-chained journal** | Rollback rehearsal 10/10 (2026-07-15); hash-chained, compare-and-append, fsync'd journal (2026-08-07); segmented journal recovery assembled (2026-08-17). A 250-record chain verified two ways in live use | Reviewed record | See `theory/ledger-provenance-and-das.md`: chain the spaces log first |
| **Two-signer Ed25519 receipts; Merkle inclusion proofs** | Review receipts signed by two pinned keys, 80/80 combined suites; sparse Merkle root gating recall, 135 assertions (in isolation) | Reviewed record | Needed once hives federate; see `theory/ledger-provenance-and-das.md` |
| **Native predictive-coding lab (H5)** | V2 branch, 2026-07-16/17: 61-parameter native PC state with local prediction-error updates; 76/76 Rust/integration plus 126 PeTTa assertions; 14 MeTTa suites 162/162 | Reviewed record (preserved, unfinished) | The MeTTa side **needs an adapter** to the module contract (no JAX needed). The Rust crate is platform-locked and AGPL-3.0, so it is not compatible as-is with this Apache-2.0 repo |
| **LLM is replaceable; state lives in the substrate** | V1 live provider-swap canary, 2026-07-15: the model was swapped under a running body and its stored state carried across (bounded continuity observed) | Reported | Keep the caveats: the probe was leading, not blinded, and the second leg was cut short |
| **Multi-channel minds** | The core's WhatsApp, Telegram and web-control channels carried a long-running mind in production in 2026 (WhatsApp: 3,260+ events) | Reviewed record | Hive minds use the hive channel by design. Slack, Mattermost and IRC had zero production deliveries |

## Other components with a compatibility path

| Component | Dependencies | Assessment |
|---|---|---|
| **FabricPC engine** (JAX predictive coding, trueagi-io) | Python 3.10+; jax, jaxlib, optax, orbax, flax, chex, jaxtyping, numpy, optuna; GPU on Linux only | **Should be compatible** through `modules/assume` (see above) |
| **Standalone PLN v0.9** (trueagi-io/PLN at 4405956; 14 files pass on pinned PeTTa) | PeTTa | **Should be compatible as a library swap** for `lib_pln.metta`, but it changes truth semantics, so it goes to the PLN author and `reasoning-deviations.md` first |
| **FabricPC A/B experiment package** | As FabricPC | **Needs an adapter**: an OmegaBench lab recipe behind the planned `worker.run` executor seam. A benchmark tool, not cognition |
| **FabricPC transformer demo** (PC versus backprop twin; 108K params, test perplexity 9.12 as recorded) | jax, optax, fabricpc | Reference only; at most an OmegaBench cross-check recipe |
| **AIRIS-successor schema learner** (world model with NAL truth values; 7/7 tests; cross-cell generalisation failed and was reverted) | Python standard library | **Needs a full port** to a MeTTa module |
| **Symega rule learner** (NACE-style world model) | PyMeTTa 0.9.2 | **Needs an adapter**: re-house its rule and evidence laws as a module and move to PeTTa |

## Where this work lives

All of these are existing private repositories the team can be granted access to (ask the
project lead). Nothing listed here is lost; this is where it is. The mapping of each component
to a repository and path should be confirmed with the project lead when access is granted.

| Repository | Relevant contents |
|---|---|
| `physixCN/omegav2` | The V2 body (the source of the "different body" rows above) |
| `physixCN/omega-papers` | Papers and dossiers, for example `dossiers/OMEGAV2_D26_PREDICTIVE_CODING_AND_CONCEPT_FORMATION_2026-08-07.md`, `theory/ARC3_WORLD_MODEL_PREDICTIVE_CODING_THEORY_2026-07-30.md`, `proposals/CODEX_H5_PREDICTIVE_WORLD_MODEL_FOUNDATION_PROPOSAL_V2_2026-07-16.md` |
| `physixCN/omega-experiments` | Experiments and their retained results |
| `physixCN/OmegaV2-HyperonStack` | The Hyperon stack work for V2 |
| `physixCN/fusion-poc-archive` | The Fusion proof-of-concept archive |
| `physixCN/Symega` | The symbolic-first sibling build |
| `physixCN/OmegaClaw-Core-PatchStack` | The OmegaClaw Core patch series |
| `OmegaClaw-HighlyExperimental` | Highly experimental OmegaClaw work |

## Not ready to claim

These are weak, claimed only, negative or retracted. Do not cite them as working.
- **PLN in a loop:** PLN has never been invoked inside any V1 or V2 body loop. It is available as a
  skill and validated as a component only.
- **MORK:** never built or run; evaluated from source only. Its speed-up figure is upstream's own.
- **Child minds, Iter workers, mind moves, media generation working in the hive:** built and
  tested where noted (child minds: 139 tests), but never run live. Media is mock-vendor only.
- **ECAN spreading:** a qualified negative; it needs a utility gate.
- **NAL in V2** is narrow and host-adapted, and its state was not persisted across turns.
- **The provider-swap canary** is bounded and was not blinded.
- **Self-improvement and evolution:** the RSI-possibility audit was a claimed document scan;
  Evolve's capability gain is unmeasured; one real paid Evolve run completed (2026-10-04).
- **The PLN induction fix of 2026-08-04 was retracted.** Never cite it as an improvement.
- **The V2 context successor** was ruled REVISE (2026-09-23); real-model quality and cost are
  unknown.
- **Slack, Mattermost and IRC:** zero production deliveries.
- **Symega:** suite counts are recorded, but no run log was found.
- **V1 self-authored skills:** no evidence.
- **Free-energy or active-inference code:** none exists; it appears only in theory documents.
