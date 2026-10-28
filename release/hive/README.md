# OmegaDots Hive

A server plus a web UI that runs swarms of always-on agents ("minds"). Each
agent keeps its own memory. Swarms share a commons of truth-valued beliefs
with evidential provenance. See `../docs/omegadots/PLAN.md` for the full
design and `API.md` for the contract.

```
hive/
  API.md            REST, live events and agent-facing contract
  core/             FastAPI app: auth, agents, swarms, messages, beliefs,
                    agent hub (WebSocket), LLM gateway, live events
  spaces/           lib_hive.metta (shared-space semantics) and the embedded
                    PeTTa service with an operations log for persistence
  supervisor/       agent workspaces plus drivers (local, docker); new
                    substrates such as Kubernetes or Omega Cloud are new drivers
  ui/               web app (see ui/README.md)
  tests/            pytest suite for the server
```

## Run it

1. Set up the runtime once:
   ```
   scripts/dev/setup_petta_env.sh              # Python 3.12 venv active: SWI-Prolog 10.1.14 + PeTTa ae66fa8 + janus-swi 1.5.3
   export PATH=$HOME/swipl-patched/bin:$PATH PETTA_PATH=$HOME/PeTTa
   pip install -r requirements.txt -r hive/requirements.txt
   ```
2. Start the server:
   ```
   HIVE_ADMIN_PASSWORD=change-me python3 -m hive
   ```
3. Open http://127.0.0.1:8700. The built UI is served there; run `npm run build`
   in `hive/ui` first.

Agents default to `mock/echo`, an offline model. It answers in the Omega
skill format:
- `believe (--> a b) 0.9 0.8` publishes a belief;
- `ask <pattern>` queries the commons;
- anything else gets an echo.

So a hive can be tried without any API key. Real models are chosen per agent
as `<provider>/<model>`.

| Variable | Meaning |
|---|---|
| `HIVE_HOST` | Address the server binds to. Default `127.0.0.1`. |
| `HIVE_PORT` | Port the server listens on. Default `8700`. |
| `HIVE_LOG_LEVEL` | Server log level (uvicorn). Default `info`. |
| `HIVE_DATA_DIR` | State directory: SQLite, spaces log, agent workspaces. Default `~/.omegadots/hive`. One hive process owns it for its lifetime through an exclusive lock on `hive.lock`; a second start exits 75 (in use), and one that cannot take the lock exits 78. The startup recovery runs once, under that lock, before serving; if it fails it rolls back and the hive exits 70. |
| `HIVE_ADMIN_PASSWORD` | Operator password. If unset, one is generated into `$HIVE_DATA_DIR/admin-password`. |
| `HIVE_PUBLIC_URL` | URL agents use to reach the hive. Default `http://127.0.0.1:8700`. |
| `HIVE_DRIVER` | `local` (default) or `docker`. |
| `PETTA_PATH` | PeTTa checkout. Default `~/PeTTa`. |
| `HIVE_DEFAULT_MODEL` | Default model for new minds. Default `mock/echo`. |
| `HIVE_EMBEDDING_MODEL` | Embeddings for agent memory. Default `mock/hash`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | Enable those providers (keys stay in the hive). |
| `HIVE_LOCAL_LLM_URL`, `HIVE_LOCAL_LLM_MODELS` | Your own OpenAI-compatible servers (vLLM, SGLang, Ollama). |
| `HIVE_PROVIDERS_FILE` | JSON list of extra providers: `{name, base_url, key_env, models, prices}`. |
| `HIVE_AGENT_IMAGE`, `HIVE_DOCKER_NETWORK` | Docker driver image and network. |

Settings added since the 2026-10-10 handover. All are off or empty by default. Details are in `API.md`
("Metered media", "Studio live sessions", "Local-owner hive and the new hive").

| Variable | Meaning |
|---|---|
| `HIVE_MEDIA_ROUTE` | `on` mounts the host-metered image route `POST /llm/v1/media` and its admin reads. Otherwise absent (404). |
| `HIVE_MEDIA_ALLOW` | JSON `{op: ["agent:a_…" \| "swarm:s_…"]}`: which minds may use each media op. Empty admits nobody; there is no wildcard. |
| `HIVE_MEDIA_BREAKER_REFUSALS` | Billed-but-refused image results in a row that pause a mind's media ops until an admin resets it. Default `2`, at least `1`. |
| `HIVE_STUDIO_SESSIONS` | `1`, `true`, `on` or `yes` turns Studio live sessions on, when every component is present. It cannot turn on on macOS in this build (see `API.md`). |
| `HIVE_STUDIO_MAKER_TEMPLATE` | The id of the reviewed Omega maker mind that members' own Studio makers are shaped from. Without it, members' makers cannot be made. |
| `HIVE_STUDIO_MAKER_MODEL` | Model for members' own Studio makers. Default `openrouter/anthropic/claude-sonnet-5.5`. |
| `HIVE_STUDIO_PROGRAM` | The Studio app's program id. Default `omegadesign`. |
| `HIVE_SAFE_RESTART_PATH` | Where a Mac hive's restart script is, for the Studio self-check. |
| `HIVE_RESTART_PREPARE` | `1` mounts `POST /api/local/restart-prepare` for the Mac test hive's restart script. |
| `HIVE_LOCAL_OWNER` | `1` makes this a local-owner hive (set only by installer launchers): one owner, one-time-link sign-in, loopback only. |
| `HIVE_LOCAL_BROWSER_PORT` | A second loopback browser port, admitted in Host/Origin; must differ from `HIVE_PORT`. Windows: the local gateway's port. Linux: the browser side of the SSH tunnel (no listener on the server). |
| `HIVE_SANDBOX_PYTHON` | The interpreter every Linux mind and tool is launched with; checked at start (a regular file that only root or this account can change). |
| `HIVE_RELEASE_MANIFEST`, `HIVE_RELEASE_SOURCE` | New hive: the verified release's source manifest and its source root, for the installed-source census. |
| `HIVE_REPOMAP_EXTRACTOR` | New hive: the folder of the pinned repository-map extractor. |
| `HIVE_REQUIRED_FEATURES`, `HIVE_INSTALLATION_ID` | New hive: a launcher requiring the feature marker, and the installation id it expects. |

## How an agent is wired

The supervisor gives every mind a workspace under `$HIVE_DATA_DIR/agents/<id>/`:
- an entry `run.metta`;
- links to the shared checkout;
- its own `memory/` (spaces, history, ChromaDB);
- a token file.

It starts the agent with:
- `commchannel=hive` (`modules/channel_hive`: a WebSocket to `/agent-hub` run
  by a daemon process);
- `provider=Hive` (LLM calls through `/llm/v1`; the hive picks the real model,
  injects keys and enforces the agent's budget);
- the `hive-publish` / `hive-query` / `hive-belief` skills (`modules/hive`).

Shared beliefs use `hive/spaces/lib_hive.metta`:
- **Revision** merges beliefs only when their evidence is independent.
- **Choice** applies otherwise.
- **Repeating** a belief reuses the agent's own evidence id, so it cannot
  inflate confidence.

## Tests

The hive tests need a working PeTTa (the pinned toolchain above, with its `bin` first on `PATH`); without it most of
them error rather than skip. Exact versions and the macOS caveat are in the root [`README.md`](../README.md).

```
PATH=$HOME/swipl-patched/bin:$PATH PETTA_PATH=$HOME/PeTTa python -m pytest hive/tests   # server, spaces, gateway
python -m unittest discover -s tests                                                   # agent runtime (repo root)
```
