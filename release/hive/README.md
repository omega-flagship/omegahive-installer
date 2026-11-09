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
   scripts/dev/setup_petta_env.sh              # SWI-Prolog + PeTTa
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

```
PETTA_PATH=~/PeTTa python3 -m pytest hive/tests          # server, spaces, gateway
python3 -m unittest discover -s tests                    # agent runtime (repo root)
```
