> **Current.** This is the module contract the shipped modules and `tests/test_module_organs.py` enforce. See `LEGACY.md` for which other docs are legacy.

# Module Contract

Modules are portable, removable organs. A module can provide skills, channels,
body organs, reasoning organs, providers, memory organs, demo spaces, or
adapters for external Claw-compatible libraries.

The loader/package manifest is useful, but it is not the cognitive contract.
The cognitive contract must be expressed in MeTTa atoms so the agent can inspect
and reason over what is mounted.

## Required Shape

```text
modules/<module-id>/
  module.toml
  entry.metta
  catalog.metta
  signatures.metta
  README.md
  src/ or bridge/ if needed
  tests/
```

`module.toml` is boring package metadata:

```toml
id = "omegaclaw.channel.whatsapp"
kind = "channel"
version = "0.1.0"
entrypoint = "entry.metta"
optional = true

provides = [
  "channel:whatsapp",
  "skill:send-channel",
  "skill:read-channel",
]

requires = [
  "python>=3.10",
  "node>=20",
]

[env]
OMEGACLAW_WA_AUTH_DIR = { required = false, runtime_state = true }
```

`entry.metta` is the important part. It declares the module into `&self`:

```metta
(Module omegaclaw.channel.whatsapp)
(ModuleKind omegaclaw.channel.whatsapp channel)
(Channel whatsapp)
(Provides omegaclaw.channel.whatsapp (Channel whatsapp))
(Provides omegaclaw.channel.whatsapp (Skill send-channel))
(ChannelCapability whatsapp text-send)
(TraceWrites omegaclaw.channel.whatsapp ChannelMessageReceived)
```

## Principles

- Modules are explicit imports, not hidden auto-discovery.
- A module should be removable without breaking core boot.
- Python, JavaScript, and external daemons are membranes, not hidden cognition.
- Runtime secrets and state are declared but never committed.
- If a module acts in the world, it should declare trace semantics.
- If a module starts a daemon, it should declare lifecycle/status affordances.
- Third-party/OpenClaw libraries should enter through adapter modules that
  translate their surface into core MeTTa atoms.

## Space-Backed Organs

If a module introduces a new cognitive space, it must register that space in
MeTTa after binding it. This is the runtime counterpart to declaring
`(SignatureSpace ...)` for the syntax membrane.

```metta
!(bind! &dream (new-space))
!(register-space "dream" &dream imagination)
!(register-space-alias dream "dream")
!(register-space-persistence "dream" ./repos/OmegaClaw-Core/memory/dream.metta runtime-state)
```

After registration, generic memory/reasoning affordances work without core
edits:

```metta
(space-known "dream")
(space-find "dream" "(DreamAtom $x)")
(space-transform "dream" "(Old $x)" "events" "(DreamRetired $x)" "cleanup")
(space-pressure)
(space-persistence)
(load-runtime-space "dream")
(save-runtime-space "dream")
```

Use `register-space-limit` only when the space has a runtime limit state.
Unbounded module spaces are allowed; pressure reporting will mark them
`unbounded`.

Use `register-space-persistence` only when the space should be backed by an
ignored runtime MeTTa file. The Python helper creates safe requested filenames
under the configured memory directory, but the decision that a space is
persistent lives in these MeTTa atoms, not in a hidden Python allow-list.

## Query Examples

The agent can ask what channels exist:

```metta
(match &self (Channel $channel) $channel)
```

The agent can ask what a module provides:

```metta
(match &self (Provides omegaclaw.channel.whatsapp $thing) $thing)
```

The agent can ask which channels can send files:

```metta
(match &self (ChannelCapability $channel file-send) $channel)
```

Large modules use the same pattern. A spatial operating surface can be declared
as an organ/world:

```metta
(Module omegaclaw.os.omega-surface)
(ModuleKind omegaclaw.os.omega-surface operating-surface)
(Surface omega-os)
(Provides omegaclaw.os.omega-surface (Skill open-window))
(SurfaceCapability omega-os live-mind-map)
```

A game or simulation can be declared similarly:

```metta
(Module openclaw.game.metta-maze)
(ModuleKind openclaw.game.metta-maze simulation)
(Simulation metta-maze)
(Provides openclaw.game.metta-maze (Skill observe-game-state))
(SimulationCapability metta-maze state-observable)
```

This keeps modules shareable like packages while preserving the core
core rule: the final affordance surface is symbolic, inspectable, and
composable.
