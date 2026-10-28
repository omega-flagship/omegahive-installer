# Dependency Boundary Audit

This audit records the current dependency shape after splitting Python helper
membranes and MeTTa skill organs. It is meant for reviewers preparing a clean
core patch series.

## Core Runtime

Core runtime dependencies remain the existing agent runtime stack:

- `janus-swi`
- `chromadb`
- `sentence-transformers`
- `openai`
- `uagents`

Core imports should stay focused on language-of-thought, memory, reasoning,
provider calls, command syntax, and reviewed space mutation.

## Optional Organs

These organs are intentionally optional body/app surfaces:

- `modules/assume/src/assume_fabricd.py` requires FabricPC plus `jax` and `optax`. It should be
  reviewed as the Assume/FabricPC predictive organ, not as a mandatory chatbot
  dependency.
- `src/audio.py` can use `imageio_ffmpeg` and `whisper` when audio inspection is
  enabled.
- `src/home.py`, `src/glucose.py`, `src/vision.py`, `src/webcam.py`,
  `src/imagegen.py`, and `src/videogen.py` use HTTP/API credentials supplied by
  local runtime configuration.
- Transport-specific channel bridges may depend on Node runtimes and local
  `node_modules`.

## Ignored Live State

The following are present in a running agent environment but must remain out of
source review:

- `memory/*.metta`, `memory/*.json`, `memory/*.jsonl`, `memory/*.db`
- `memory/web/`, `memory/inbox/`, `memory/outbox/`, generated media
- channel bridge auth directories and vendored runtime dependencies
- `.env` and any device, health, model-provider, repository, or channel secrets

Source libraries must not directly import these ignored memory files at load
time. They should bind spaces first, then let runtime initialization create
missing ignored files and import live memory only after the runtime has started.
This preserves both clean-checkout bootability and live identity continuity.

## MeTTa Skill Layout

The public command renderer lives in `src/skill_catalog.metta`. The catalog
content itself is declared as `(SkillCatalog ...)` and `(SkillHelp ...)` atoms
inside organ-local `src/skill_catalog_*.metta` files. Each loader imports only
the catalog atoms for organs it actually provides, so a core-only runtime does
not advertise body, attention, or Assume affordances.

Implementations live in the organ files:

- `src/skills_core.metta`
- `src/skills_memory.metta`
- `src/skills_energy.metta`
- `modules/assume/skills.metta`
- `src/skills_body.metta`
- `src/skills_reasoning_spaces.metta`
- `src/skills_attention.metta`
- `src/skills_space_mutation.metta`

`src/skills.metta` is a compatibility loader only. New behavior should not be
added to the loader.

## Reviewer Rule

If a dependency can see the world, spend money, call an external API, mutate a
device, or depend on local credentials, treat it as a body/app organ. If it
changes memory, reasoning, identity continuity, command syntax, or symbolic
mutation semantics, treat it as core or cognition.
