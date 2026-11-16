# Story to timeline

A film is written as MeTTa story atoms: beats with an intent, transitions, presence, events and an end card. `gen_timeline.metta`, run by PeTTa, compiles them into `timeline.json`, a set of segments and closed-form functions of time. `stateAt.mjs` evaluates the state at any instant *t*, with no clock, no `dt` and no unseeded randomness. Every frame is therefore a pure function of the story, the seed and *t*.

## Run

```
PETTA_RUN=/path/to/PeTTa/run.sh ./run_tests.sh
```

Requires PeTTa (https://github.com/trueagi-io/PeTTa), SWI-Prolog 10.1 or later, Node, and a POSIX shell. The cumulative-clock case is printed as CONTROL: it is expected to leak, and shows why the clock restarts at each change of material.

## What the tests check

- **Determinism:** two compiles produce byte-identical output. Verified on Linux and Mac (sha256 `4c1ea8b01d58a170…`).
- **Story checks:** a story with a gap between beats is refused.
- **Purity:** frames rendered in order equal frames jumped to directly.
- **Split:** two chunks rendered cold, then joined, equal one full run.
- **Edit locality:** changing one beat changes only that beat's frames and its transitions.
- **Control case:** with one cumulative material clock, the same edit fails. This is why the clock restarts at each change of material.
- **Provenance:** every frame names its beat, its intent and what comes next.

The stories here are invented fixtures.
