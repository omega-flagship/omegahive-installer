> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Tutorial 03 — Writing a Custom Skill

**Goal:** add a new skill the agent can call, end-to-end.

## Prerequisites

- A local clone of OmegaClaw-Core (so you can edit MeTTa source).
- Familiarity with running the agent — see [Usage](/docs/omegaclaw-core.md#running).

## The anatomy of a skill

A skill is three things:

1. **An entry in the skill catalogue** in `src/skill_catalog.metta` (the `getSkills` list) so the LLM learns it exists.
2. **A MeTTa definition** of how the skill executes, in the appropriate `src/skills_*.metta` organ. Pure-MeTTa skills are written directly; skills that need system access delegate to Python or Prolog.
3. **Optional Python/Prolog glue** imported through `py-call` or `translatePredicate`.

## Example: a `word-count` skill

We'll add `(word-count "some text")` that returns the number of whitespace-separated tokens.

### Step 1 — Declare it in the catalogue

Open `src/skill_catalog.metta` and add a catalogue line:

```metta
"- Count whitespace-separated words in a string: (word-count string_in_quotes)"
```

This text is concatenated into the prompt so the LLM knows the skill is callable.

### Step 2 — Define the implementation in the right organ

Choose the closest MeTTa organ file:

- `src/skills_core.metta` — core runtime, file IO, reboot, generic execution helpers
- `src/skills_memory.metta` — structured memory/world/belief/event/agenda writes and reads
- `src/skills_energy.metta` — energy, attention mode, cycle-status, loop pacing affordances
- `modules/assume/skills.metta` — Assume/FabricPC prediction and mutation-review affordances
- `src/skills_body.metta` — optional devices/apps such as vision, audio, glucose, publishing, house control
- `src/skills_reasoning_spaces.metta` — MeTTa/NAL/PLN and read-only space inspection
- `src/skills_attention.metta` — attention ledger and ECAN-lite immune affordances
- `src/skills_space_mutation.metta` — explicit reviewed space mutation/retirement utilities

For this pure text helper, `src/skills_core.metta` is a reasonable home:

```metta
(= (word-count $str)
   (progn (translatePredicate (split_string $str " " "" $parts))
          (length $parts)))
```

If you prefer Python, register a function in a `.py` module and call `(py-call (mymodule.word_count $str))`.

`src/skills.metta` remains as a compatibility loader for humans and older imports. New implementations should go into the organ file, not back into that loader.

### Step 3 — Test

Restart the agent. Ask:

```
how many words are in "the quick brown fox"?
```

The LLM should emit `(word-count "the quick brown fox")` and respond with `4`.

## Conventions

- Skill names are lowercase, hyphen-separated.
- Every argument is a string literal in quotes. Variables are forbidden in LLM-generated skill calls (the loop rejects them in `getContext`).
- Return a value that is safe to render into the `LAST_SKILL_USE_RESULTS` context — the loop runs the result through `helper.normalize_string`.
- If your skill may fail, wrap error-producing subcalls in `catch` or let them fall through to the loop's `HandleError`.

## Verification

- The new skill appears in the prompt (search logs for `word-count`).
- The LLM invokes it without prompting tweaks.
- The return value shows up in `LAST_SKILL_USE_RESULTS` on the next turn.

## Next steps

- [reference-internals-skill-dispatch.md](./reference-internals-skill-dispatch.md) — how dispatch works.
- [reference-internals-extension-points.md](./reference-internals-extension-points.md) — other places to hook in.
- [tutorial-06-remote-agentverse-skills.md](./tutorial-06-remote-agentverse-skills.md) — delegate skills to a remote agent instead of running them locally.
