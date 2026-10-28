# Core Patch Boundary

This file records the intended boundary for turning live research work into a
reviewable core contribution. The guiding rule is simple: submit architectural
organs and reusable membranes, not instance-specific runtime state.

## Include In Core Review

- Command syntax membrane:
  - `src/helper_command_parser.py`
  - `src/helper_metta_syntax.py`
  - `src/skill_catalog.metta`
  - `src/skill_signatures.metta`
  - `src/skills.pl`
  - parser, shell-risk, write-surface, and syntax smoke tests
- Structured cognitive spaces and traces:
  - `src/helper.py`
  - `src/helper_metta.py`
  - `src/helper_history.py`
  - `src/helper_promotion.py`
  - `src/helper_reboot.py`
  - `src/loop.metta`
  - `src/memory.metta`
  - `src/skills_core.metta`
  - `src/skills_memory.metta`
  - `src/skills_reasoning_spaces.metta`
  - `src/skills_space_mutation.metta`
  - trace atoms, agenda, beliefs, world, events, activity, and reviewed space
    mutation affordances
  - `src/context.metta`
- Provider abstraction and energy/cost awareness:
  - `lib_llm_ext.py`
  - `src/energy.py`
- Assume / FabricPC predictive organ:
  - `modules/assume/src/assume.py`
  - `modules/assume/src/assume_client.py`
  - `modules/assume/src/assume_fabricd.py`
  - `demos/assume/`
  - Assume tests and MeTTa smokes
- Optional reusable body apps, if reviewed as separate app organs:
  - `src/home.py`
  - `src/vision.py`
  - `src/audio.py`
  - `src/webcam.py`
  - `src/glucose.py`
  - `src/imagegen.py`
  - `src/videogen.py`
  - `channels/router.py`
  - `channels/web_control.py`
  - channel bridge modules and their transport-specific runtimes

## Exclude From Core Review

- Live memory and identity state:
  - `memory/history.metta`
  - `memory/prompt.txt`
  - `memory/*.metta`
  - `memory/*.json`, `memory/*.jsonl`, `memory/*.db`
  - `memory/inbox/`, `memory/outbox/`, `memory/web/`, generated media
- Private web/publication surface:
  - `src/webhost.py`
  - `web/`
  - webhost-specific tests and UI design notes
  - `docs/retired/` UI prototypes
- Live credentials/session state:
  - `.env`
  - channel bridge auth directories and vendored runtime dependencies
  - any home, health, model-provider, repository, or channel credentials

## Current Separation Status

The core import surface now keeps reusable mind/memory membranes separate from
optional body/device organs:

- `lib_omegaclaw.metta` imports core language, memory, reasoning, provider,
  helper, syntax, energy/cost awareness, and core/memory/reasoning skill
  catalogs.
- `lib_omegaclaw.metta` binds the durable cognitive spaces
  (`&persistent`, `&agenda`, `&beliefs`, `&world`, `&events`, `&activity`) as
  empty spaces at source-load time. `src/memory.metta` then creates any missing
  ignored runtime files and imports live memory during `initMemory`. This keeps
  a clean checkout bootable without committing live memory state.
- `modules/assume/entry.metta` imports the optional Assume/FabricPC predictive
  organ, binds its canonical `&assume` space, registers itself as a
  `(RuntimeOrgan "assume" (initAssumeOrgan))`, and loads ignored runtime Assume
  memory only when runtime organs initialize.
- `lib_omegaclaw_attention.metta` imports the optional ECAN-lite attention
  organ, binds its `&attention` space, and reloads ignored runtime attention
  memory through the attention skill surface when needed.
- `lib_omegaclaw_body.metta` imports optional app/device organs such as
  images/video, home control, vision, webcam, audio, health-data apps,
  channel bridges, web-control, routing, publishing, and body/channel/web
  catalog atoms.
- live `run.metta` imports all of these files, so a composed runtime can keep
  its current body while the core review can inspect the mind membrane
  independently.

The live tree also previously imported the local webhost directly. That has
been replaced with `src/publishing.py`, a small optional body membrane:

- `lib_omegaclaw_body.metta` imports `./src/publishing.py`
- `src/skills_body.metta` routes publication skills through `publishing.*`
- when a local `webhost.py` organ exists, `publishing.py` delegates to it
- when no local webhost organ exists, publication skills return a visible
  `PUBLISHING-NOT-CONFIGURED` result instead of breaking the core runtime

Remaining local-only webhost material should still be excluded from the core
review:

- `src/webhost.py`
- `web/`
- webhost-specific tests

## Reviewer Principles

- MeTTa/AtomSpace remains the visible language of thought.
- Python bridges are membranes or body organs, not hidden cognition.
- FabricPC is an executable predictive view; symbolic atoms remain canonical.
- Skill catalogs are imported as MeTTa atoms by each organ loader; the prompt
  should describe only organs present in the current composition.
- Live cognitive spaces are updated only after canonical persistence succeeds.
- Mutation deltas include primitive numeric facts, Python-local judgement atoms,
  and MeTTa-side comparison affordances, not only opaque edge changes.
- Any hallucination-prone summary must be explicitly marked as interpretation,
  not treated as exact trace.
- Exact trace, mutation trace, and outcome evidence must remain inspectable.
- The agent chooses how to use skills; the patch should expose affordances
  rather than hardcode behavioral policy.
- Local deployment configuration belongs in runtime config, never in core
  source.
- Ignored runtime memory files may be exported by the loop, but source libraries
  must not require those files to exist at import time.

## Recommended Patch Sequence

1. Syntax command membrane plus smoke corpus.
2. Structured spaces, trace atoms, and bounded history/result logging.
3. Energy/cost awareness.
4. Assume/FabricPC predictive organ plus `SmartHabitatDemoSpace`.
5. ECAN-lite attention/immune pass.
6. Optional body app organs as independent follow-up patches.
