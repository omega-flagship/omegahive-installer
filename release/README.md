> V7 full core extraction: run `python3 scripts/setup_core.py` before first launch. See [CORE_MODULARIZATION.md](CORE_MODULARIZATION.md) for the upstream runtime, Hive adapters and validation.

![OmegaHive banner](/docs/assets/banner.png)

# OmegaHive

**Tier: Open (Apache-2.0)**, except three folders that are marked *Closed Source for Product
Consideration* (see [Tiers](#tiers)).

OmegaHive is a server and web UI that runs **swarms of always-on minds** over a shared symbolic
commons. People and minds work together through a policy gate on every action, budgeted spend,
team rooms, an Ask that is available on every page, and a living-canvas UI with several
"experiences" (Classic, Cosmos, Still, Flux, Construct, Canvas, Town).

- The server is in [`hive/`](hive/README.md). The REST/WebSocket contract is in
  [`hive/API.md`](hive/API.md), and the app ("Dot program") contract is in
  [`hive/PROGRAMS.md`](hive/PROGRAMS.md).
- The web UI is in [`hive/ui/`](hive/ui/README.md).
- Native minds run pinned Singnet Omega from `third_party/Omega`, composed with Hive
  extensions and feature modules on **PeTTa** (MeTTa on SWI-Prolog). The core's own walkthrough is in
  [`docs/omegaclaw-core.md`](docs/omegaclaw-core.md).

New here? Read [`docs/START_HERE.md`](docs/START_HERE.md). What works today, and what is
limited, is in [`STATUS.md`](STATUS.md).

## What it is, and what is real today

**The design.** OmegaHive is Hyperon-first. MeTTa/AtomSpace and symbolic reasoning (NAL, PLN)
are the core, and the language model is one organ, not the control plane.

**This release.**
- Every native mind runs on MeTTa (PeTTa). NAL and PLN are loaded in every mind as **working
  skills** it can call (`nal-step`, `pln-step`, `nars-derive`, `metta`).
- Each swarm's commons is a real MeTTa space. Beliefs carry evidence stamps, and revision merges
  only disjoint evidence, so minds that echo each other cannot inflate confidence.
- The same NAL, PLN and commons libraries run unchanged in the browser (MeTTaScript). The live
  demo commons uses them.
- An optional predictive-coding organ (Assume, `modules/assume`) keeps its graph in atoms and
  returns every learned change as reviewable atoms. Its symbolic tests pass offline.
- Governance is enforced, not described: allow/ask/deny policy per skill, exact-bound approvals
  for consequential actions, signed capability tokens, OS sandboxing of minds (Landlock and
  namespaces on Linux), hard spend limits, visibility tiers, and content-addressed, digest-pinned
  app releases. See [`docs/theory/governance-and-gating.md`](docs/theory/governance-and-gating.md)
  and [`docs/theory/ledger-provenance-and-das.md`](docs/theory/ledger-provenance-and-das.md).

**Deliberately not wired in this build.** The language model still drives each mind's loop.
Automatic invocation of reasoning from the loop is **intentionally unplugged** in this release;
it is not broken. Our tuning baseline measured zero reasoning calls with it unplugged, and that
measurement is the starting point of the reasoning rollout, not its result. A reviewed
reasoning foundation (NAL/NARS through the production skill path, with honest failures) passed
its independent assembly gate (69 tests) and is held for a naming ruling and activation review.

**Earlier builds.** Reasoning was exercised and tested in earlier builds. In the separately built
OmegaClaw V2 body (closed repo `omegav2`), per-turn decisions were computed in MeTTa, a NAL
organ ran inside the autonomous cycle in shadow tests, blind signed tests showed stored context
causally changing what the model says, and the body ran end to end on a real channel. Those
results belong to that body; they are cited, not shipped here. Evidence levels and what it would
take to bring each piece in are in
[`docs/EARLIER_EXPERIMENTS.md`](docs/EARLIER_EXPERIMENTS.md).

## Tiers

| Tier | What | Licence |
|---|---|---|
| **Open** | This repository, except the folders below | Apache-2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)) |
| **Closed Source for Product Consideration** | The WhatsApp bridge (`channels/whatsapp_bridge` and `modules/channel_whatsapp/src/whatsapp_bridge`, closed because of a GPL-3 dependency) | All rights reserved; see the `CLOSED_SOURCE.md` in each folder |

"Closed Source for Product Consideration" means the code is shared privately with the
SingularityNET team for evaluation and development. Do not republish, redistribute or relicense
it as open code. The full list of repositories and their tiers is in
[`docs/START_HERE.md`](docs/START_HERE.md#repositories-and-tiers).

Parts of the core derive from OmegaClaw Core (MIT, Patrick Hammer); that notice is kept in
[`NOTICE`](NOTICE).

## Prerequisites (exact versions)

| Tool | Version | Why |
|---|---|---|
| Python | **3.12** (the same interpreter you install janus into) | server, tests |
| SWI-Prolog | **10.1.14** (`swipl-devel`), built against that Python 3.12 | PeTTa needs a working `library(janus)` Prolog-to-Python bridge |
| PeTTa | commit **`ae66fa8`** (`github.com/trueagi-io/PeTTa`) | the MeTTa runtime minds and the shared spaces run on |
| janus-swi | **1.5.3** | Python-to-Prolog bridge |
| Node.js | **22.12 or later** (or 24) | UI build and tests (vitest 5 and vite 8 need it) |

**macOS warning.** Homebrew's SWI-Prolog 10.0.2 loads, but its bridge fails with
`janus:py_call/4` not found, and then every hive test errors with "PeTTa failed to start". Build
10.1.14 into a private prefix (for example `~/swipl-patched`) against Python 3.12, following the
cmake steps in [`deploy/setup_runtime.sh`](deploy/setup_runtime.sh) (the `-DPython_EXECUTABLE`
and `-DPython_ROOT_DIR` flags matter). Put that `bin` folder **first on `PATH`** whenever you run
the hive or its tests.

Check the bridge before going further; it must print `42`:

```bash
swipl -g 'use_module(library(janus)), py_call(operator:add(20,22),V), print(V), nl, halt'
```

## Quick start

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r hive/requirements.txt          # server; add -r requirements.txt for OmegaClaw minds
pip install janus-swi==1.5.3
git clone https://github.com/trueagi-io/PeTTa ~/PeTTa && git -C ~/PeTTa checkout ae66fa8
export PETTA_PATH=~/PeTTa PATH=$HOME/swipl-patched/bin:$PATH
(cd hive/ui && npm ci && npm run build)       # build the UI
HIVE_ADMIN_PASSWORD=change-me HIVE_DATA_DIR=$PWD/.hive-data python -m hive
```

Open http://127.0.0.1:8700 (set `HIVE_PORT` if 8700 is taken). Minds default to `mock/echo`, an
offline model, so no API key is needed to try it. Server deployment is in
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md); the settings template is `deploy/hive.env.example`.

`scripts/dev/setup_petta_env.sh` is a convenience script; check that what it installs matches the
table above.

## Running the tests

```bash
export PETTA_PATH=~/PeTTa PATH=$HOME/swipl-patched/bin:$PATH
python -m pytest -q -p no:cacheprovider hive/tests     # hive server; about 11 minutes
python -m unittest discover -q -s tests                # OmegaClaw core; PeTTa-free
(cd hive/ui && npx tsc -b --noEmit && npx vitest run)  # UI
```

- **The hive tests need a working PeTTa.** Without it most of them error rather than skip.
- A few hive tests exercise app repositories checked out next to this one (for example
  `../omegafusion`). They need those checkouts.
- Last measured (2026-10-10, this tree, with the toolchain above): `hive/tests` **2414 passed,
  0 failed, 66 skipped**. Tests that need sibling closed-source repos skip with that reason. Current counts
  and known issues are in [`STATUS.md`](STATUS.md).
- For a change, run the tests for the area you changed plus a smoke run. The full `hive/tests`
  suite is for core plumbing (auth, spaces, gateway, supervisor). See
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Settings

The full list is in [`hive/README.md`](hive/README.md) and `deploy/hive.env.example`. The ones you
need first:

| Setting | Default | What it does |
|---|---|---|
| `HIVE_HOST` | `127.0.0.1` | Address the server binds to. A sandboxed mind reaches the hive only at `127.0.0.1`, so with any bind other than `127.0.0.1`, `localhost` or `0.0.0.0` the hive refuses to start local minds and says why |
| `HIVE_PORT` | `8700` | Port the server listens on |
| `HIVE_LOG_LEVEL` | `info` | Server log level |
| `HIVE_DATA_DIR` | `~/.omegadots/hive` | State: SQLite, spaces log, mind workspaces. One hive process owns it (exclusive lock) |
| `HIVE_ADMIN_PASSWORD` | generated into `$HIVE_DATA_DIR/admin-password` | Operator password |
| `HIVE_PUBLIC_URL` | `http://127.0.0.1:8700` | The hive's address as browsers and outside services see it (sign-in callbacks, MCP links), and the URL docker minds dial. Local minds dial `HIVE_HOST` and `HIVE_PORT` |
| `HIVE_DEFAULT_MODEL` | `mock/echo` | Model for new minds |
| `HIVE_EMBEDDING_MODEL` | `mock/hash` | Embeddings for mind memory |
| `HIVE_DRIVER` | `local` | `local` or `docker`. The mind sandbox is for minds on the local driver; a docker mind runs in its container |
| `HIVE_MIND_SANDBOX` | on | Minds run in the OS sandbox (Landlock on Linux, sandbox-exec on macOS) unless this is `0`. The hive checks at start that it works and says so; where it can't, minds don't start until it's fixed or this is `0` |
| `HIVE_MIND_SANDBOX_PORTS` | `8724` (the Code service) while `HIVE_PORT` is unset, otherwise none | Other ports on `127.0.0.1` a sandboxed mind may reach besides the hive's own, comma-separated. Setting it replaces the default, so list `8724` too if minds need it. A sandboxed mind has no other route, so a channel that goes online from inside the mind, such as Telegram or a WhatsApp bridge the mind starts itself, doesn't work in the sandbox. A WhatsApp bridge started outside it is reached by listing its port, `3055`, here |
| `HIVE_PLUGIN_DIRS`, `HIVE_APP_PINS` | unset | Where apps are mounted from, and the digest each must match |
| `PETTA_PATH` | `~/PeTTa` | The PeTTa checkout |
| `OMEGA_PRIVATE_FAMILY_NAMES` | unset | Your own names to add to the "no real people in demo data" guard (`hive/ui/src/api/sim/noRealPeople.test.ts`) |

## Related repositories

Apps live in their own repositories and are mounted with `HIVE_PLUGIN_DIRS`. Each one is checked
against the contract with `python -m hive.programs_check <app folder>`. App and contract versions
are in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md); the tier of every repository is in
[`docs/START_HERE.md`](docs/START_HERE.md#repositories-and-tiers).

## More

- [`docs/FEATURES.md`](docs/FEATURES.md): every feature, its state and where it lives.
- [`docs/MODULARITY.md`](docs/MODULARITY.md): how modular the code is and where to be careful.
- [`docs/reasoning-deviations.md`](docs/reasoning-deviations.md): where the NAL/PLN libraries
  differ from the references.
- [`docs/omegaclaw-core.md`](docs/omegaclaw-core.md): the OmegaClaw Core readiness walkthrough, which
  opened the root README of the line merged in from dev/latest; [`docs/README.md`](docs/README.md) indexes the
  core's tutorials and references, and reviewer files are under `docs/review/`.
- [`CHANGELOG.md`](CHANGELOG.md), [`CONTRIBUTING.md`](CONTRIBUTING.md),
  [`SECURITY.md`](SECURITY.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Safety note

Depending on what is enabled, minds can read and write files, run shell commands, reach networks,
send messages and call model providers. Run the hive in an isolated environment, turn on the mind
sandbox for anything beyond local trials, commit no secrets, and grant only the permissions an
experiment needs.
