![OmegaClaw banner](/docs/assets/banner.png)

# OmegaClaw Core v0.01a Readiness Walkthrough

OmegaClaw Core is a MeTTa/AtomSpace runtime for building persistent
neural-symbolic agents. This branch is a private readiness snapshot prepared
from live Omega work so OmegaClaw-Core maintainers can review what changed,
why it changed, and where each piece lives.

The main architectural claim is unchanged: OmegaClaw is not a chatbot wrapper.
LLMs are cognition providers. MeTTa/AtomSpace is the language of thought.
Python, JavaScript, shell, channels, web search, and remote agents are membranes
for sensing and acting. Raw trace is preserved exactly; context views may be
bounded or mechanically compacted.

## What Changed Compared With The ASI Alliance Core Baseline

The original core already had the essential agent loop: receive input, build
context, call an LLM provider, parse returned skill expressions, evaluate them,
append history, and continue. This readiness branch keeps that loop, but turns
several live lessons into explicit, reviewable architecture:

| Area | Baseline Shape | v0.01a Shape |
|---|---|---|
| Command parsing | Mostly helper-driven repair around model output | MeTTa-declared `SkillSignature` surface plus fail-closed syntax membrane |
| Memory | Runtime files could be entangled with source imports | Runtime spaces are registered, loaded, saved, and ignored as live state |
| Context | Raw history/results could flood the LLM view | Bounded context views with mechanical payload placeholders; raw files stay exact |
| Skill discovery | Skills existed but were easy for the agent to miss | Symbolic skill cards, topics, args, risks, effects, aliases, and triggers |
| Continuity | History plus prompt carried most working state | `pin` is always-on volatile continuity, separate from durable memory |
| Cleanup | Low-level atom mutation tools were too easy to misuse | Proposal-first cleanup, exact ids/hashes, trace, and expert-tool labeling |
| Modules | Optional bodies could look like core cognition | Module contract with manifests, MeTTa atoms, loader boundary, trace declarations |
| Channels | String notices mixed metadata and dialogue text | Typed `ChannelEvent` boundary separates route/id metadata from message text |
| Reasoning | PLN/NAL usage was under-documented for live skill use | Skill cards and tests clarify quoted truth-valued PLN/NAL shapes |
| Runtime economy | Loop idling and sleep behavior were opaque | Energy/status surfaces and spin counter expose pressure without hidden agency |
| Review | Work was mixed in a live instance | Patch-series map, tests, benchmark harness, and repo-boundary audit |

## Chronological Development Map

1. **Repository/runtime boundary**
   Runtime memory, logs, auth sessions, generated media, and local deployment
   files were excluded from source. See `.gitignore`, `tests/test_repo_boundary.py`,
   and `docs/review/patch-series/patches/00-repo-boundary-runtime-state.patch`.

2. **Syntax command membrane**
   The parser learned command signatures, typed/rest arguments, multiline
   payload lowering, base64 write surfaces, and recovery hints. See
   `src/helper_command_parser.py`, `src/skill_signatures*.metta`,
   `tests/test_syntax_smoke_corpus.py`, and `tests/test_syntax_channels_smoke.py`.

3. **Runtime memory spaces and context boundary**
   Core spaces such as `persistent`, `agenda`, `beliefs`, `world`, `events`,
   `activity`, `skills`, `skill-triggers`, `scratch`, `attention`, `assume`, and
   optional module spaces became registered names instead of guessed raw handles.
   See `src/skills_runtime_spaces.metta`, `src/memory.metta`,
   `src/helper_metta.py`, and `tests/test_memory_runtime.py`.

4. **Skill affordance directory**
   Skills now have symbolic cards and catalog entries that the agent can query.
   The visible context stays small, while full help is available through
   `skill-card`, `skill-help`, `query-skill-space`, and `choose-skill-for`. See
   `src/skills_affordance.metta`, `src/skill_catalog*.metta`,
   `src/skill_affordance*.metta`, and `tests/test_skill_affordance_contract.py`.

5. **Context-view payload compaction**
   Large write/file/web payloads are replaced in the LLM-facing view by a
   mechanical placeholder such as `context-omitted-payload`. No semantic summary
   is invented, and raw history remains exact on disk. See `src/helper_metta.py`,
   `SkillContextView`, `SkillContextPolicy`, and `tests/test_memory_runtime.py`.

6. **Pin, energy, and spin pressure**
   `pin` became an always-on continuity skill for volatile working state. Energy
   and spin surfaces expose cost/loop pressure, but the agent still decides what
   to do. See `src/skills_core.metta`, `src/energy.py`, `src/attention_ledger.py`,
   `tests/attention_spin_counter_smoke.metta`, and `tests/test_energy.py`.

7. **Symbolic cleanup hardening**
   Cleanup moved toward candidate/proposal/commit workflows. Low-level exact atom
   tools remain available but are labeled as expert tools. See
   `src/skills_memory.metta`, `src/skills_space_mutation.metta`,
   `tests/space_merge_atoms_smoke.metta`, and `tests/test_memory_runtime.py`.

8. **Module contract and loader boundary**
   Optional organs now declare package metadata in `module.toml` and cognitive
   affordances in MeTTa atoms. Core no longer needs to import optional bodies
   directly. See `docs/reference-omegaclaw-module-contract.md`, `modules/*`,
   `modules/loader.metta`, and `tests/test_module_contract.py`.

9. **Channel modularization and typed events**
   WhatsApp, Telegram, Mattermost, web control, Slack, IRC, mock, and web search
   are treated as channel modules or adapters. The important new boundary is
   `ChannelEvent`: transport metadata is not dialogue text. See
   `docs/reference-channels.md`, `modules/channel_router`,
   `modules/channel_whatsapp`, `channels/whatsapp.py`, and
   `tests/test_channel_event_normalization.py`.

10. **Situated senses and apps**
    Vision, webcam, audio, glucose, Home Assistant, image/video generation,
    publishing, VM, Game Boy, and code-hand work are represented as optional
    body/app modules. They expose affordances and trace; they do not become
    hidden cognition. See `modules/sense_*`, `modules/health_glucose`,
    `modules/home_assistant`, `modules/gameboy`, `modules/omega_vm`, and
    `docs/reference-omega-organ-map.md`.

11. **Assume/FabricPC predictive organ**
    `assume` is a symbolic graph space Omega can fill with situations, features,
    actions, edges, outcomes, errors, and reviewed writeback pressure. FabricPC is
    a daemon membrane over that graph, not a replacement mind. See
    `modules/assume`, `tests/test_assume*.py`, and
    `docs/review/assume-fabric-demo-review.md`.

12. **Agentverse remote-agent module**
    Remote discovery, registration, listener, inbox, trace, and AgentChatProtocol
    calls are behind an optional module boundary. See `modules/agentverse`,
    `tests/test_agentverse_module.py`, and
    `docs/tutorial-06-remote-agentverse-skills.md`.

## Architecture In This Version

```text
run.metta
  -> lib_omegaclaw.metta               standard ordered composition
     -> lib_omegaclaw_core.metta       core substrate and memory membrane
     -> modules/loader.metta           enabled module affordances and channels
     -> lib_omegaclaw_attention.metta  attention/immune organ
     -> src/loop.metta                 sense -> reason -> act -> verify -> remember
  -> modules/assume/entry.metta        symbolic assumption graph organ
```

The separation to look for during review:

- **Identity and memory**: MeTTa spaces and exact history, not provider state.
- **Reasoning**: MeTTa/NAL/PLN/Assume atoms, not Python semantic decisions.
- **Action**: skill calls and module membranes with explicit outcomes.
- **Provider choice**: LLM and embedding providers are replaceable membranes.
- **Modules**: optional organs declare what they provide before they are loaded.
- **Trace**: external actions and runtime state transitions append evidence.

## How To Review The Patch Families

The review map is in `docs/review/patch-series/README.md`. The generated patch
bundles under `docs/review/patch-series/patches/` are organized so a core
maintainer can inspect smaller layers rather than one giant live diff.

Useful starting points:

- `docs/review/clean-patch-boundary.md` explains what belongs upstream, what is
  optional body/module work, and what remains local runtime state.
- `docs/review/dependency-boundary-audit.md` separates core dependencies from
  optional organs and deployment credentials.
- `docs/reference-omegaclaw-module-contract.md` describes the module shape.
- `docs/reference-channels.md` documents the `ChannelEvent` contract.
- `docs/reference-omega-organ-map.md` explains the mind/body/sense/hand split.

Run the review gate before publishing a patch series:

```bash
python3 docs/review/review_audit.py
```

By default this runs source-boundary, secret, and patch-boundary checks against
the integrated branch. To additionally require every changed review-surface file
to be represented in the generated patch series and to apply-check each patch
against a clean baseline, set:

```bash
OMEGACLAW_REVIEW_STRICT_PATCH_SERIES=1 \
OMEGACLAW_REVIEW_PATCH_BASELINE=<baseline-ref> \
python3 docs/review/review_audit.py
```

## Tests And Benchmarks

Fast focused checks:

```bash
python3 -m unittest -q \
  tests/test_repo_boundary.py \
  tests/test_patch_contracts.py \
  tests/test_module_contract.py \
  tests/test_skill_affordance_contract.py \
  tests/test_channel_event_normalization.py \
  tests/test_syntax_smoke_corpus.py \
  tests/test_syntax_channels_smoke.py \
  tests/test_memory_runtime.py
```

MeTTa smoke runner:

```bash
python3 tests/run_metta_smokes.py --list
python3 tests/run_metta_smokes.py tests/module_contract_smoke.metta
```

Benchmark harness:

```bash
python3 docs/review/benchmark_suite.py --loops 1000
```

The benchmark suite measures parser latency, workload parsing, deterministic
context fixture size, local cost-ledger availability, repository footprint, and
smoke-test availability. It does not spend provider tokens by default.

Latest local validation snapshot, 2026-05-28:

| Check | Result |
|---|---|
| `python3 -m unittest discover -q tests` | 286 tests, OK |
| `python3 docs/review/review_audit.py` | PASS: secret scan, memory boundary, patch boundary, imports, review surface, patch apply |
| `python3 docs/review/benchmark_suite.py --loops 200` | 7/7 representative workloads parsed on baseline and candidate |
| Skill surface | 776 baseline declarations, 794 candidate declarations, 1.023x |
| Modules | 26 baseline, 27 candidate |
| Parser throughput | 65,903/sec baseline, 76,716/sec candidate, 0 errors |
| Fixed prompt estimate | 12,240 baseline tokens, 12,436 candidate tokens, +196 |
| Assume/Fabric demo | baseline unavailable, candidate OK with 57 features, 17 actions, 117 edges |

These are local reproducibility numbers, not a claim about provider quality or
live autonomy. The benchmark uses deterministic fixtures and local probes unless
explicitly extended.

## What Is Intentionally Not In GitHub

The following are local runtime/deployment artifacts and should stay out of the
public/private source release:

- `memory/history.metta`, runtime memories, logs, inboxes, traces, and generated
  pages/media.
- WhatsApp auth/session state and bridge `node_modules`.
- Home Assistant, glucose, provider, channel, and webhost credentials.
- Local website/webhost project files such as `web/omega-os/`, `src/webhost.py`,
  and webhost-only tests.
- Private ROMs or emulator save states under `memory/runtime/gameboy/`.
- Live deployment prompts or family/person-specific memories.

The repository boundary tests and `.gitignore` should fail or hide these if they
try to enter source control.

## Installation

The recommended install path is the interactive installer. It is designed for a
clean machine: it installs dependencies, asks what to name the agent, enables
default-on modules automatically, asks about optional modules, asks which
channel and LLM provider to configure, writes local secrets to
`~/OmegaClaw/.env`, and creates a launcher for future runs.

### macOS Installer

Download or clone this repository, then double-click:

```text
install/macos/Install OmegaClaw.command
```

The installer opens Apple's command-line tools installer if needed. It then
creates a pinned user-local OmegaClaw runtime under
`~/OmegaClaw/.micromamba` and `~/OmegaClaw/.local`, even if Homebrew is
installed. The runtime uses Python 3.11, Node.js >=20 <27, Git, build tools,
and the SWI-Prolog 10.0.2-1 universal macOS app bundle with Janus patched to
the local Python runtime. Before configuration starts, the installer verifies
Python, Node.js, Git, SWI-Prolog, and an actual SWI-Prolog Janus `py_call`
smoke test. No sudo is required.

### Windows Installer

The Windows wrapper installs only the base WSL packages up front. Optional module system dependencies such as VM or firewall tooling are installed later by the shared installer only when their modules are selected.

Download or clone this repository, then double-click:

```text
install/windows/Install OmegaClaw.cmd
```

OmegaClaw runs on Windows through Ubuntu on WSL. The installer installs or uses
WSL/Ubuntu, installs the Linux dependencies there, then creates `~/OmegaClaw`
inside WSL and places a `Start OmegaClaw.cmd` launcher on the Windows desktop.

### What The Installer Configures

The installer asks once for:

- agent name, used to personalize the workspace-local prompt;
- primary channel: mock, web control, Telegram, IRC, Mattermost, Slack, or WhatsApp;
- optional non-channel modules whose `module.toml` has `default_enabled = false`;
- LLM provider and model: OpenRouter, OpenAI, Anthropic, ASICloud, ASIOne, or Ollama;
- provider/channel API keys and auth values needed by those choices.

The selected primary channel module is enabled automatically. Other channel
modules stay disabled unless you deliberately enable them later, so a normal
install does not assume WhatsApp.

It writes selected module imports to `~/OmegaClaw/local/modules-loader.metta`,
writes the chosen agent name to `~/OmegaClaw/local/prompt.txt`, writes a
non-secret MeTTa config overlay to `~/OmegaClaw/local/runtime-config.metta`, and
writes local secrets to `.env`. The tracked repo files remain clean so later
`git pull` works predictably. Re-running the generated launcher uses the saved
configuration and does not ask again. Use `python install/installer_common.py
--workspace ~/OmegaClaw --repair` from the public clone to repair stale launch
files without re-entering secrets.

The generated composition imports the loop last, after modules and attention.
This is required because the loop compiles against the active `initChannels`,
`receive`, and attention functions.

See `install/README.md` for more detail.

### Manual Source Install

Prerequisites:

- Git
- Python 3 with `venv`
- SWI-Prolog 9.1.12 or later

Install through a PeTTa checkout:

```bash
git clone https://github.com/trueagi-io/PeTTa
cd PeTTa
mkdir -p repos
git clone https://github.com/physixCN/OmegaClaw-Core.git repos/OmegaClaw-Core
git clone https://github.com/patham9/petta_lib_chromadb.git repos/petta_lib_chromadb
cp repos/OmegaClaw-Core/run.metta ./
```

Create a Python environment and install dependencies:

```bash
python3 -m venv ./.venv
source ./.venv/bin/activate
python3 -m pip install -r ./repos/OmegaClaw-Core/requirements.txt
```

Optional CPU-only PyTorch install for local embeddings:

```bash
python3 -m pip install --index-url https://download.pytorch.org/whl/cpu torch
```

## Running

Choose a provider and export the relevant key:

| Provider | Env Var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| ASICloud | `ASI_API_KEY` |
| ASIOne | `ASIONE_API_KEY` |
| Ollama-compatible | `OLLAMA_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Start from the PeTTa root:

```bash
OMEGACLAW_AUTH_SECRET=<channel-secret> sh run.sh run.metta IRC_channel="<irc-channel>"
```

Then authenticate from the configured IRC channel:

```text
auth <channel-secret>
```

Runtime settings can be overridden as MeTTa command-line arguments:

```bash
sh run.sh run.metta provider=OpenAI LLM=gpt-4.1 commchannel=irc IRC_channel=##omegaclaw
```

## Documentation Index

Start with `docs/README.md` for tutorials and references. Important reviewer
files are under `docs/review/`. Release notes are in `CHANGELOG.md`.

## Safety Note

OmegaClaw is experimental autonomous-agent infrastructure. Depending on enabled
modules, it can read and write files, execute shell commands, access networks,
send messages, call providers, and start local daemons. Run it in an isolated
environment, commit no secrets, and grant only the permissions needed for the
experiment you are actually running.

OmegaClaw is provided as-is under the repository license.
