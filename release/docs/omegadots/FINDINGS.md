# OmegaDots Hive — findings from Phase 0

These are runtime facts and bugs found while building Phase 0. Fixed ones say
where. Upstream ones need reporting to their repositories; this session can
only read them.

## Fixed in this fork

| Finding | Effect | Fix |
|---|---|---|
| `save-runtime-space` and `bound-space!` never worked: `export!` and `bound-space!` were defined in `src/skills_memory.metta`, which is imported **after** `src/skills_runtime_spaces.metta`. PeTTa compiles a call at import time, so a call to a function defined later stays an inert literal. | Runtime memory spaces (persistent, beliefs, world, …) were **never saved across restarts**. Each save wrote an empty file. Per-iteration space bounding never ran either. | Both definitions moved into `skills_runtime_spaces.metta`, ahead of their callers. Covered by `tests/test_multi_instance_memory.py` (reload after restart) and the assume persistence smokes. |
| The MeTTa side used fixed `(library OmegaClaw-Core ./memory/…)` paths, while the Python helpers used `OMEGACLAW_MEMORY_DIR`. Scratch spaces used a path relative to the working directory. | Setting `OMEGACLAW_MEMORY_DIR` split one agent's memory across two places (files created in one, loaded from the other; history written to one, read from the other). Two agents could not share a checkout. | `(memory-file "<name>")` → `helper.memory_file`. |
| Under janus, **Python threads only run while Prolog is inside a `py-call`**. They are frozen during Prolog `sleep`; verified with a ticker probe that showed 0 ticks across a 1 s Prolog sleep and 99 ticks across a 1 s Python sleep. | Thread-based channels (upstream `wschat`, this fork's Telegram/WhatsApp pollers) only make progress during LLM or `receive` calls. While the loop is idle they cannot answer keepalive pings, reconnect, or take in messages. | The hive channel runs its socket in a **separate daemon process** and talks to the agent through JSONL files. Other channels in this fork still have the issue; see the open items below. |
| Inside the embedded interpreter, `sys.executable` is the `swipl` binary. | Any `subprocess.Popen([sys.executable, …])` starts a Prolog prompt instead of Python. | `hive_channel._python_executable()`. Other modules should be checked for the same pattern. |
| A Python `""` returned through `py-call` does not compare equal to MeTTa `""`. | `(!= (receive) "")` is true even when there is no message. | Use `(string_length …)`, as the loop already does. |
| Any failure after the LLM call inside a loop iteration makes PeTTa **backtrack into earlier choice points and call the LLM again**. There is no error and no iteration marker. | One message became hundreds of paid LLM calls and repeated actions. In the first hive run, an agent published the same belief over 200 times. | Root causes fixed (the next three rows). Still open: the loop should `once`/`cut` right after the LLM call, so that a later failure cannot replay it. |
| `append-file` requires an existing file. A fresh per-agent memory dir had no `history.metta`. | The history write failed, which caused the backtracking above. | `helper.memory_file` creates the file. Covered by `tests/test_memory_file.py`. |
| `skill-recall-cards-for-signals` and `all-wait-commands?` had both a `()` clause and a general clause, so the empty list matched twice. | Every recursion level forked, multiplying results. | Single-clause `if` forms. |
| `input-recall` always used local sentence-transformers embeddings, whatever `embeddingprovider` said, and an exception there dropped the message. | Without local embeddings, agents silently ignored every message. | It honours the provider and degrades to no recall. |
| PeTTa resolves `import!` paths against the **main file's** directory, not the importing file's directory. | A library cannot reliably import a sibling file by relative path, and `import!` swallows the error. | `hive/spaces/lib_hive.metta` is self-contained, and a test checks that its revision rule matches `lib_nal`. |

## Open in this fork

- **Smoke runner path model.** `tests/run_metta_smokes.py` runs `tests/<file>.metta` from the runtime's working directory. PeTTa resolves Python imports against `tests/`, while `git-import!` puts `repos/` under the runtime directory. As a result, 13 existing smokes fail with `No module named 'helper'` (and similar), both before and after Phase 0. Fix options:
  - the runner copies each smoke next to the runtime's `run.metta`, or
  - smokes import Python by absolute library path.
- **Smokes test whatever `git-import!` fetched.** `asi-alliance/OmegaClaw-Core` now redirects to `singnet/Omega`, so in a fresh runtime the smokes exercise **upstream** code rather than this checkout. `scripts/dev/setup_petta_env.sh` now links the checkout into `repos/`.
- **Space bounding now runs.** Before the fix it was a no-op. Agents with large spaces will now be trimmed to their configured `register-space-limit` budgets each iteration. Review the limits.
- **Thread starvation in other channels.** Telegram, WhatsApp and Agentverse listeners should move to the daemon pattern, or the loop should spend its idle time in a Python sleep instead of a Prolog sleep.

- **Agent Docker image not built in the dev sandbox.** `hive/docker/agent.Dockerfile` needs Debian packages, and this session's egress policy denies `deb.debian.org` (HTTP 403). The docker driver itself is tested against a real daemon using a stand-in image (`hive/tests/test_docker_driver.py`). Build the image where Debian mirrors are reachable.

## Upstream bugs (verified)

| Repository | Location | Bug |
|---|---|---|
| trueagi-io/PeTTa | `lib/lib_spaces.metta` `migrateAtoms` | Adds the atom back into `$FromSpace` and removes it from `$FromSpace`. `$ToSpace` is never written. |
| trueagi-io/PeTTa | `src/metta.pl` `'import!'` | `catch(importer_helper(...), _, fail)` swallows every import error silently. |
| trueagi-io/PeTTa | (missing) | `new-space` is not defined, although examples use `(bind! &x (new-space))`. It only works because any `&name` acts as a space. |
| singnet/Omega | `lib_omega.metta:26` | `!(import! &self (library Omega ./src/context))`: `src/context*` does not exist. The import silently fails. |
| singnet/Omega | `profile/policy.py:113` | `if rw is None: ro = []` should reset `rw`. A YAML `read_write:` with no entries makes `rw` None and crashes later in `apply()`. |
| singnet/Omega | `profile/policy.py:114` | Reads `policy.get('include_workdir')` at the top level, but `policy.yaml` declares it under `filesystem_policy`, so the setting is ignored. |
| singnet/Omega | `channels/wschat.py` | Thread-based socket; subject to the janus thread starvation described above. |
