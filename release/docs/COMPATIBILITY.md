# Compatibility: host and app contract versions

OmegaHive (the host) loads apps ("Dot programs") through the program contract in
`hive/PROGRAMS.md`. The contract has its own version, separate from each repository's version.

## The host

| Host | Version | Contract it implements |
|---|---|---|
| `omegahive` | 0.1.0 (initial import of live release 5617f4e), brought up to the release live on 2026-10-20 (`e5103fb0` plus host R8.4) | **0.1** work graphs (`hive/core/programs.py`, `CONTRACT = "0.1"`), plus the additive **0.2** features: the trusted actor and request identity on `act()`, and action receipts (`committed`, `pending`, `unknown`, `refused`). Since 2026-10-20 also the additive `member_attach` module declaration (host R8.3), read only from an app's digest-pinned release; see `hive/APP_ATTACHMENTS_CANDIDATE.md` |

An app's `plugin.json` declares the contract it implements. An app that declares none is treated as
0.1. Additive 0.2 features do not change the 0.1 contract, so 0.1 apps keep loading.

## Apps

Versions are as declared in each app's `plugin.json` (or `pyproject.toml`) on its `github-ready`
branch, 2026-10-10.

| App repo | Tier | App version | Contract declared | Mount folder | Notes |
|---|---|---|---|---|---|
| `omega-tools` | Open | 0.6.3 | 0.2 | repo root | Cloud ran 0.6.3; the owner's Mac ran 0.6.1 |
| `omegaplanner` | Open | 0.2.1 | 0.1 | `program/` | |
| `omegalibrary` | Open | 0.1.0 | 0.1 | `app/` | Needs `OMEGALIBRARY_DATA` for the contract check |
| `omegahive-candidates` / omegalearn | Open | 0.1.1 | 0.1 | `omegalearn/program/` | Candidate, not admitted |
| `omegahive-candidates` / omegamatch | Open | 0.1.0 | 0.1 | `omegamatch/program/` | Candidate, not admitted |
| `omegahive-candidates` / others (hiveconnect, omegaalignment, omegaatom, omegachill, omegaflow, omegagraft, omegareason) | Open | see each folder | see each folder | — | Candidates and components, not admitted |
| `omegadesign` (Studio) | Closed | 0.4.13-raster-model-hooks on the `github-ready` branch (2026-10-10); **0.4.21** runs on the cloud hive (2026-10-20) | none (0.1) | repo root | The contract checker needs a host that awaits an async `view()`. 0.4.21 declares `member_attach`, which host R8.3 needs to attach members' own Studio makers |
| `omegafusion` | Closed | 0.1.0 | 0.1 | `programs/omegafusion/` | Its candidates (0.2.0 to 0.2.2) declare 0.2 and are unmounted |
| `omegasocial` | Closed | candidates 0.2.0 to 0.2.3 | 0.2 | `candidates/*` | Unmounted candidates only |
| `omegapurple` | Closed | 0.1.0 | 0.1 | `programs/omegapurple/` | Goals-based; Mac only |
| `omegacode` | Closed | 0.1.0 (`pyproject.toml`) | not a program | not mounted | An HTTP service enrolled through `HIVE_CODE_SERVICE_CONFIG`; behind the Linux Code owner contract |
| `omegaatlas`, `omegatruth` | Closed | see each repo | see each repo | see each repo | Code only, no data |
| Built in: `hive/plugins/contract_fixture` | Open | 0.1.0 | 0.1 | in repo | Synthetic test app |
| Built in: `hive/plugins/commons_explorer` | Open | 0.1.0 | 0.1 | in repo | |
| Built in: `hive/plugins/omegaevolve` | Closed folder | 0.3.0 | 0.1 | in repo | |

## Rules

- Check an app against a host with `python -m hive.programs_check <app folder>` from the host
  checkout.
- Exact deployments are pinned by digest (`HIVE_APP_PINS`, the folder plus
  `Programs.source_digest`), never by a version string. With `HIVE_APP_PINS_REQUIRED=1` an unpinned
  app is refused.
- Versioning policy (Semantic Versioning per repository, and how contract changes map to host
  versions) is in `../CONTRIBUTING.md`.
- When the host adds a contract version, add a column here and record the minimum host version each
  app needs.
