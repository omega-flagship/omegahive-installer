> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Reference — Python and Prolog Bridges

MeTTa handles reasoning and control flow; bridges handle everything that needs a library ecosystem.

## `lib_llm_ext.py`

LLM and embedding bridges.

| Function | Purpose |
|---|---|
| `useClaude(prompt)` | Call an Anthropic Claude model. Used when `provider = Anthropic`. |
| `useMiniMax(prompt)` | Call MiniMax. Used when `provider = ASICloud` (or similar routing). |
| `useAsi1(prompt)` | Call ASI1. Used when `provider = ASIOne`. |
| `useLocalEmbedding(str)` | Compute an embedding with a locally loaded model. Used when `embeddingprovider = Local`. |
| `initLocalEmbedding()` | Load the local embedding model once at startup. |

OpenAI calls go through MeTTa-side helpers (`useGPT`, `useGPTEmbedding`) that are defined elsewhere in the library but use the same LLM call pattern.

## `modules/agentverse/src/agentverse_bridge.py`

Optional Agentverse/uAgents remote-agent transport membrane.

| Function | Purpose |
|---|---|
| `agentverse_status()` | Report uAgents availability and trace/search paths without exposing secrets. |
| `agentverse_discover_atoms(query, limit)` | Search Agentverse and return candidate atoms for `&agentverse`. |
| `agentverse_record_agent(name, address, schema, capability)` | Mirror a chosen remote agent into a local registry file. |
| `agentverse_call(address, schema, payload)` | Send a typed AgentChatProtocol message to a raw remote address. |
| `agentverse_ask(destination, schema, payload)` | Send a typed request to a registered remote agent. |
| `agentverse_inbox()` | Inspect listener acknowledgement and reply state. |
| `agentverse_trace()` | Return recent local Agentverse trace atoms. |

Agentverse is loaded only through `modules/agentverse/entry.metta`; there is no
core-level compatibility facade.

## `src/helper.py`

String and time utilities used by the loop.

| Function | Purpose |
|---|---|
| `signature_balance_parentheses(str)` | Canonical syntax command membrane. Reads MeTTa `SkillSignature` declarations, lowers friendly command text into safe MeTTa skill calls, and fails closed with `wait`/`syntax-error`. |
| `balance_parentheses(str)` | Compatibility wrapper for `signature_balance_parentheses`. |
| `normalize_string(obj)` | Render a skill return value into a string safe to embed in the next prompt. |
| `around_time(ts, n)` | Backs `(episodes ts)` — returns `n` lines of `memory/history.metta` around `ts`. |

## `src/skills.pl`

Prolog helpers imported via `import_prolog_functions_from_file`.

| Predicate | Purpose |
|---|---|
| `shell/2` | Run a shell command and capture stdout. Rejects apostrophes. |
| `first_char/2` | Return the first character of a string — used by the loop to detect whether the LLM produced a valid s-expression. |

## Calling conventions

- MeTTa to Python: `(py-call (module.function arg1 arg2 ...))`.
- MeTTa to Prolog: `(translatePredicate (predicate ...))` for side-effecting predicates, or `!(import_prolog_function name)` to lift a Prolog function into MeTTa.

## See also

- [reference-internals-loop.md](./reference-internals-loop.md) — where these bridges are invoked.
- [reference-internals-extension-points.md](./reference-internals-extension-points.md) — where to add new bridges.
