# Start here

This repository holds the OmegaHive platform and the OmegaClaw core runtime its native minds run
on. This page tells a new team member (person or agent) which repositories exist, what tier each
is in, and what to read first.

## Repositories and tiers

| Repository | What it is | Tier |
|---|---|---|
| `omegahive` | This repo: the hive server, web UI, OmegaClaw core runtime, benchmark and Commons Explorer | **Open** (Apache-2.0), except the closed folders below |
| `omega-tools` | Tools: advisory skill modules and MeTTa recipes | **Open** (Apache-2.0) |
| `omegaplanner` | Planner: plan checker | **Open** (Apache-2.0) |
| `omegalibrary` | Library: pinned source shelf with page citations | **Open** (Apache-2.0) |
| `omegahive-candidates` | Candidate apps not yet admitted (for example OmegaLearn, OmegaMatch) | **Open** (Apache-2.0) |
| `omegadesign` | Studio: editable creative canvas | **Closed Source for Product Consideration** |
| `omegafusion` | Fusion: forecasting society (synthetic slice) | **Closed Source for Product Consideration** |
| `omegacode` | Code: coding workspaces, runs and verification service. Shipped as an engineering preview (PR #1, 2026-10-20) with its own handoff note | **Closed Source for Product Consideration** |
| `omegasocial` | Social: local social app candidates | **Closed Source for Product Consideration** |
| `omegapurple` | Purple app | **Closed Source for Product Consideration** |
| `omegaatlas` | Atlas: personal-health app (code only, no data) | **Closed Source for Product Consideration** |
| `omegatruth` | Truth: research-truth app (code only, no data) | **Closed Source for Product Consideration** |
| `omegav2` | The Omega V2 mind: body, theory and governance | **Closed Source for Product Consideration** |
| `omegahive` folder `hive/plugins/omegaevolve` | Evolve: research-record registry | **Closed Source for Product Consideration** |
| `omegahive` folder `hive/ui/src/experiences/omegatown` | OmegaTown experience | **Closed Source for Product Consideration** |
| `omegahive` folders `channels/whatsapp_bridge`, `modules/channel_whatsapp/src/whatsapp_bridge` | WhatsApp bridge (GPL-3 dependency, see its `GPL-NOTICE.md`) | **Closed Source for Product Consideration** |
| `physixCN/Symega` (separate, for reference) | Symega: a symbolic-first research build, MeTTa core with the LLM as resolver | Lives separately at github.com/physixCN/Symega |

**What "Closed Source for Product Consideration" means.** The code is shared privately with the
SingularityNET team for evaluation and development. It is not open source: do not publish,
redistribute or relicense it, in whole or in part, and do not copy it into an open repository.
Each closed repository and folder carries a `CLOSED_SOURCE.md` with the notice, and its README
opens with a banner. Final licence terms are for SingularityNET legal to confirm. Closed repos
never contain private data: no memories, records, health data or personal content.

App and contract versions are in `COMPATIBILITY.md`.

## What is real today (read this before the theory)

The design is Hyperon-first: MeTTa/AtomSpace and symbolic reasoning are the core, and the
language model is one organ, not the control plane. In this release:
- every native mind runs on MeTTa (PeTTa) with NAL and PLN as working skills it can call;
- each swarm's commons is a real, evidence-stamped MeTTa space, and the same libraries run in the
  browser;
- automatic reasoning from the mind loop is **deliberately not wired in** (it was tested in
  earlier builds, and a reviewed reasoning foundation is held for activation). The LLM drives each
  loop here.

`theory/` describes the design. Much of it was built and shadow-tested in the separate V2 body
(closed repo `omegav2`): a MeTTa state spine, decisions computed in MeTTa, a NAL organ in the
cycle, an end-to-end shadow and live channel turns. PLN, MORK and full ECAN have not yet run in
any mind's loop. Evidence levels are in `EARLIER_EXPERIMENTS.md`.

## Reading order

1. **The project:** `../README.md`, then `../STATUS.md`, then `introduction.md` (the core's hybrid
   reasoning thesis).
2. **Where the platform stands:** "Live since the handover" in `../STATUS.md` (2026-10-20), then
   `handoff/platform/README.md` and `handoff/platform/status-2026-10-09.md`.
3. **How we work (read before you change anything):** `../CONTRIBUTING.md`,
   `handoff/platform/operating-rules.md` and `handoff/omegav2/working-discipline.md`.
4. **Who owns what:** `handoff/platform/coordination-and-roles.md`.
5. **Platform design:** `handoff/platform/architecture-and-seams.md`,
   `handoff/platform/core-requirements.md`, `../hive/PROGRAMS.md` (the app contract) and
   `MODULARITY.md`.
6. **Governance and provenance:** `theory/governance-and-gating.md` and
   `theory/ledger-provenance-and-das.md`.
7. **Reasoning:** `handoff/platform/hyperon-tuning-and-mind-fitness.md` (the measured starting
   point and rollout plan), `reasoning-deviations.md`, `reference-lib-nal.md`,
   `reference-lib-pln.md`.
8. **Open work:** `handoff/platform/reviewed-plans.md`, `handoff/platform/product-plans.md` and
   `handoff/platform/code-owner-contract.md`.
9. **Earlier work worth bringing in:** `EARLIER_EXPERIMENTS.md`.
10. **Review machinery and evidence:** `handoff/platform/omegareview-role-handoffs.md`,
    `handoff/platform/platform-sessions.md` and `handoff/platform/receipts-index.md`.
11. **The V2 mind-body line:** `handoff/omegav2/README.md`,
    `handoff/omegav2/milestones-and-lanes.md` and `handoff/omegav2/oversight-summary.md`.
12. **Theory:** `theory/README.md`.
13. **Reference and tutorials:** `README.md` in this folder.

## Where the rest lives

Code and papers that are not in this repository are **not lost**. They live in existing private
repositories that team members can be granted access to:

| Repository | What is there |
|---|---|
| `physixCN/omegav2` | The V2 body (see also the closed `omegav2` handover repo) |
| `physixCN/omega-papers` | Theory papers, dossiers and proposals (for example the predictive coding, world model and H5 foundation papers) |
| `physixCN/omega-experiments` | Experiments and their retained results |
| `physixCN/OmegaV2-HyperonStack` | The Hyperon stack pins and work used by V2 |
| `physixCN/fusion-poc-archive` | The Fusion proof-of-concept archive |
| `physixCN/Symega` | The symbolic-first sibling build |
| `physixCN/OmegaClaw-Core-PatchStack` | The OmegaClaw Core patch series |
| `OmegaClaw-HighlyExperimental` | Highly experimental OmegaClaw work |

Ask the project lead for access.

## Rules that travel with these documents

- Private data stays private. No memories, records, health data, corpus or personal content of
  any app or mind is in any handover repository; only code and metadata.
- People are named by role (the project lead, the OmegaClaw author, owners). Agent names (Codex,
  Kimi, Claude) are kept as roles. Public authors of upstream work keep their credits.
- Nothing about the resident mind's personal life, memories, identity or relationships is in this
  repository.
- Theory grants no build authority. A new feature waits for the project lead's OK on its
  reviewed plan. No deploy goes ahead without two independent reviews. Nothing counts as
  accepted without a shadow run.
- The `handoff/` and `theory/` folders are curated summaries of private working documents; each
  names its source by filename. Where a summary conflicts with the live coordination record,
  the record wins.
