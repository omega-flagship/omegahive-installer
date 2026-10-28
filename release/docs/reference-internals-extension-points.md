> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Internals — Extension Points

Where to plug in new behavior, in order of increasing depth.

## Add a skill

Most common extension. Add the executable skill and its symbolic declarations:

1. A `(= (my-skill $arg) ...)` definition, either pure MeTTa or a `py-call` / `translatePredicate`.
2. A `(SkillSignature ...)` declaration so the syntax membrane knows the command shape.
3. `(SkillCatalog ...)` / `(SkillHelp ...)` entries for full human-readable documentation.
4. Optional `(SkillContextHint ...)` only for tiny always-on bootstrap hints. Most skills should be found through `query-skill-space`, `choose-skill-for`, `explain-skill`, or `skill-card`, not stuffed into the loop prompt.
5. Optional `(SkillContextView ...)` / `(SkillContextPolicy ...)` declarations when a skill produces large transport or artifact payloads that should not dominate the next prompt context.

Full walkthrough: [tutorial-03-writing-a-custom-skill.md](./tutorial-03-writing-a-custom-skill.md).

### Context view policy

Raw `memory/history.metta` is the exact trace and should not be rewritten by
context economy. A skill may still declare that its large payload arguments
should be mechanically compacted in the LLM-facing history view:

```metta
!(add-atom &skills (SkillContextView "write-file" "compact-payload"))
!(add-atom &skills (SkillContextPolicy "write-file" "compact-threshold" 900))
```

This turns an oversized history expression into a compact reference only in the
prompt context:

```metta
(write-file "memory/page.html" "<context-omitted-payload chars=12000 raw-history-preserved>")
```

Use this for artifact, file, media, or transport payloads. Do not use it for
reasoning, memory, belief, world, event, PLN/NAL, or other thought-bearing
atoms. The default policy is full visibility.

## Add a module

A module is a removable package of skills and optional bridge code. Use this
when a capability should be installable as one unit instead of mixed into core.

Recommended layout:

```text
modules/name/
  module.toml
  entry.metta
  skills.metta
  signatures.metta
  catalog.metta
  affordance.metta
  src/optional_bridge.py
```

`entry.metta` imports the module's runtime files. `signatures.metta` and
`catalog.metta` are read by the syntax/catalog membranes only when the module is
enabled. `affordance.metta` should add the module's skill cards, topics, and
general `SkillTrigger` atoms to `&skills` so input-aware context can surface the
right cards immediately after the module loads. If a module has large payload
commands, its `affordance.metta` should also declare their context view policy.

Use `module.toml` to declare dependencies and runtime configuration:

```toml
requires = [
  "python>=3.10",
]

[env]
EXAMPLE_TOKEN = { required = true, secret = true }
```

If a module needs language-specific dependencies, keep them inside the module
folder, for example `requirements.txt`, `pyproject.toml`, or `package.json`.
Dependencies should be inspectable before install, and runtime secrets should be
declared as config, not committed.

Enable the module by adding one import to `modules/loader.metta`:

```metta
!(import! &self (library OmegaClaw-Core ./modules/name/entry.metta))
```

The loader is the module boundary. Installed-but-disabled module folders should
not be visible to the syntax membrane, skill catalog, or runtime.

### Module trace contract

If a module can write verbose traces, make trace behavior explicit and
deployment-controlled. Do not silently write large or private raw logs from a
shareable module.

Use `module.toml` to declare the available trace types, whether they are enabled
by default, and the runtime switch:

```toml
[env]
OMEGACLAW_NAME_TRACE = { required = false, default = "0" }

[trace]
default_enabled = false
writes = [
  "ExampleTrace",
]
```

Use `entry.metta` to expose trace availability as inspectable atoms:

```metta
(RuntimeConfig omegaclaw.module.name OMEGACLAW_NAME_TRACE "optional-default-off")
(TraceAvailable omegaclaw.module.name ExampleTrace)
```

The standard default for potentially large, private, or deployment-specific
traces is off. Skills should still return compact symbolic summaries to the
loop, and full traces should be enabled only by an explicit runtime setting.

## Add a remote skill

Remote-agent skills should live inside a module, with their Python transport
under that module's `src/` directory and their symbolic surface in
`entry.metta`, `skills.metta`, `signatures.metta`, `catalog.metta`, and
`affordance.metta`:

```metta
(= (my-remote-skill $arg)
   (py-call (my_remote_module.my_remote_skill $arg)))
```

Full walkthrough: [tutorial-06-remote-agentverse-skills.md](./tutorial-06-remote-agentverse-skills.md).

## Add a channel

Three touch points:

1. New Python module `channels/myadapter.py` implementing `start_*`, `getLastMessage`, `send_message`.
2. A new branch in `initChannels`, `(receive)`, and `(send $msg)` in `src/channels.metta`.
3. New parameters declared via `(= (MY_*) (empty))` and bound by `configure`.

Full walkthrough: [tutorial-04-adding-a-channel.md](./tutorial-04-adding-a-channel.md).

## Add an LLM provider

In `src/loop.metta`, the main dispatch is:

```metta
(if (== (provider) OpenAI)
    (useGPT ...)
    (if (== (provider) Anthropic)
        (py-call (lib_llm_ext.useClaude $send))
        (if (== (provider) ASICloud)
            (py-call (lib_llm_ext.useMiniMax $send))
            (py-call (lib_llm_ext.useAsi1 $send)))))
```

To add a provider:

1. Implement a call function in `lib_llm_ext.py` (or a new module).
2. Add a branch to the `if` chain.
3. Use the new provider name in the `configure provider ...` line or via command-line `provider=...`.

## Change the prompt

The agent's identity and values are in `memory/prompt.txt`. The run-time prompt template that sandwiches it is in `getContext` in `src/loop.metta`. Edit carefully — the output-format instruction is what keeps the LLM producing valid skill s-expressions.

## Change the embedding model

In `src/memory.metta`, the `embed` function dispatches on `embeddingprovider`:

```metta
(= (embed $str)
   (if (== (embeddingprovider) Local)
       (py-call (lib_llm_ext.useLocalEmbedding (string-safe $str)))
       (useGPTEmbedding (string-safe $str))))
```

To add a new backend, add a branch and implement the Python function.

## Change the reasoning library

`lib_nal.metta` and `lib_pln.metta` are plain MeTTa files loaded by `lib_omegaclaw.metta`. Add new rule definitions directly, or swap in a different logic library entirely — the only required surface is whatever operator the LLM invokes through `(metta ...)`.

## See also

- [reference-internals-loop.md](./reference-internals-loop.md) — the loop is the host for all of the above.
- [reference-python-bridges.md](./reference-python-bridges.md) — bridge conventions.
