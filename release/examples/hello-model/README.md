# hello-model

How to add your own model server to a hive, and pick it for one mind. The
sample [`providers.json`](providers.json) adds an invented provider called
`labbox`: a self-hosted, OpenAI-compatible server on the same machine, with two
models and prices. Nothing in this folder starts a server or calls one.

## The providers file

`HIVE_PROVIDERS_FILE` names a JSON file holding a list of provider records
([`hive/README.md`](../../hive/README.md), configuration table). At start-up
the hive reads each record into a `Provider` and adds it to the built-in ones
(`hive/core/config.py:121`). A record with the name of a built-in provider
replaces that provider. If the file does not exist, it is skipped without
a warning (`hive/core/config.py:124`), so check the path when a provider is
missing.

| Field | Meaning | In the sample |
|---|---|---|
| `name` | The provider part of `provider/model`. | `labbox` |
| `base_url` | The OpenAI-compatible base URL. The hive posts to `<base_url>/chat/completions` (`hive/core/gateway.py:366`). | a loopback address |
| `key_env` | Environment variable holding the key, if the server needs one. An operator can also store a key from the UI. | `LABBOX_API_KEY` |
| `local` | `true` for a server you run yourself. | `true` |
| `models` | Model names offered in the model picker. | `tiny-chat-7b`, `tiny-chat-1b` |
| `prices` | USD per million tokens, `{"in", "out"}`, by model name. `"*"` is the default for models without their own entry (`hive/core/config.py:37`). | `tiny-chat-7b` 0.05 / 0.10; others 0.01 / 0.02 |

The fields are those of the `Provider` dataclass (`hive/core/config.py:16`).
An unknown field stops the hive from starting, because each record is passed
to it as keyword arguments (`hive/core/config.py:126`).

## What `local` changes

- **Budgets.** A call to a local provider is never reserved or refused against
  a budget (`hive/core/gateway.py:295`). A remote provider with no price for the
  model is refused (`hive/core/gateway.py:297`). `HIVE_ALLOW_UNPRICED=1` does not
  work around this today: the call then fails closed at the reservation step
  (finding K12 in `omegahive-schematics/07-upgrade-path/FINDINGS.md`). Price the
  model instead.
- **Recorded cost.** The prices still set the cost recorded for each call
  (`hive/core/gateway.py:336` and `hive/core/gateway.py:373`). That cost is
  written to the usage table and added to the mind's spent total
  (`hive/core/hive.py:1735`). So prices on a local provider are bookkeeping,
  for example to compare it with a hosted model.
- **The model picker.** A local provider's models are listed without a key.
  A remote provider's models are listed only once it has a key
  (`hive/core/hive.py:299`).
- **Local-only swarms.** A swarm listed in `HIVE_LOCAL_ONLY_SWARMS` may use only
  `mock` or a provider that is `local` and whose `base_url` is a literal
  loopback address (`hive/core/gateway.py:230`). `labbox` qualifies.

If your server is on another machine, set `local` to `false`, give it a key
and prices, and its calls are metered against budgets like any hosted model.

## Choose it for one mind

A mind's model is one string, `<provider>/<model>`. The gateway splits it at
the first `/` (`hive/core/gateway.py:58`). For the sample:

```
labbox/tiny-chat-7b
```

Set it when the mind is made, or change it later
([`hive/API.md`](../../hive/API.md), agents):

- `POST /api/agents` with `{"name": ..., "kind": "omega", "model": "labbox/tiny-chat-7b"}`;
- `PATCH /api/agents/{id}` with `{"model": "labbox/tiny-chat-7b"}`;
- or pick it in the mind's model picker, which lists `GET /api/models`.

Other minds keep their own models. The hive default for new minds is
`HIVE_DEFAULT_MODEL`, which is `mock/echo` unless set.

## Try it

From the repository root, with the toolchain in [`examples/README.md`](../README.md):

```
python -m pytest -q examples/hello-model/tests
```

The test loads the file through `load_settings()` and
`hive/core/providers.py` (`ProviderStore`). It checks that `labbox`, its models
and its prices are registered, and that the built-in providers are still there.
It also checks how the gateway treats a `labbox/...` mind. Its HTTP clients use
a transport that fails the test on any network call.

To use it in the sandbox, add `HIVE_PROVIDERS_FILE=$PWD/examples/hello-model/providers.json`
to the environment before running [`examples/run-sandbox.sh`](../run-sandbox.sh).
A `labbox` mind then needs a real OpenAI-compatible server at that address. The
built-in `local` provider (`HIVE_LOCAL_LLM_URL`, `HIVE_LOCAL_LLM_MODELS`) is the
other way to reach one server without a file.
