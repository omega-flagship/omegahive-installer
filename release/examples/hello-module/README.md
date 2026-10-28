# hello-module

A minimal OmegaClaw module. It declares one harmless skill, `hello-greet`,
which returns a greeting as text. It stores nothing, calls no Python and has no
effects outside the mind. The contract it follows is
[`docs/reference-omegaclaw-module-contract.md`](../../docs/reference-omegaclaw-module-contract.md).
Its shape copies the small built-in module
[`modules/scheduler_reminders`](../../modules/scheduler_reminders/entry.metta).

| File | What it holds |
|---|---|
| `module.toml` | Package metadata: id, kind, version, entrypoint, what it provides. |
| `entry.metta` | The module's atoms in MeTTa (`Module`, `ModuleKind`, `Provides`, ...) and the imports of the other files. |
| `catalog.metta` | The catalog line and the help text for the topic `hello`. |
| `affordance.metta` | The skill card, topic, risk and effect for `hello-greet`. Every module in `modules/` has one; the contract does not require it. |
| `signatures.metta` | How the command parser reads `hello-greet <name>`: one rest-of-line text argument. |
| `skills.metta` | The skill itself, in plain MeTTa. |
| `tests/test_hello_module.py` | Checks the manifest against the entry atoms, then parses the declarations, then (with PeTTa) loads them. |

## How it fits together

- A mind's command surface is built from MeTTa declarations. The parser reads
  `signatures.metta`, `catalog.metta` and `affordance.metta` only for modules
  named in the active loader (`src/helper_command_parser.py:105` and
  `src/helper_command_parser.py:140`).
- The loader names modules by the pattern `./modules/<name>/entry.metta`
  (`src/helper_command_parser.py:111`). It reads a named module's files only
  from `modules/<name>/` (`src/helper_command_parser.py:152`). So this folder is a template. It must be copied to
  `modules/hello_module/` to be used, and the import lines in `entry.metta` are
  written for that place.
- When a mind boots, `lib_omegaclaw.metta:9` imports `modules/loader.metta`,
  which imports each enabled module's `entry.metta`. The entry imports the
  catalog, affordance, signatures and skills.

## How a mind would enable it

Do this in a scratch clone, not a shared checkout.

1. Copy the folder (without its tests) into the core's modules:

   ```
   mkdir -p modules/hello_module
   cp examples/hello-module/*.metta examples/hello-module/module.toml modules/hello_module/
   ```

2. Add one line to the loader the mind uses:

   ```
   !(import! &self (library OmegaClaw-Core ./modules/hello_module/entry.metta))
   ```

   Which loader that is depends on how the mind runs:
   - **A mind in a hive:** each mind's workspace links `repos/OmegaClaw-Core` to
     the hive's core checkout (`hive/supervisor/workspace.py:181`). Its
     `run.metta` loads `lib_omegaclaw` (`hive/supervisor/workspace.py:24`),
     which imports `modules/loader.metta`. So the line goes in that checkout's
     `modules/loader.metta`, and **every mind on that hive gets the module**.
     There is no per-mind module list today. A mind's `options.tools` is a
     different thing: it is a reviewed tools plan (`hive/supervisor/workspace.py:203`).
   - **One mind from an installer:** the installers write the selection to
     `local/modules-loader.metta` in the OmegaClaw workspace and keep
     `modules/loader.metta` as the source-checkout default
     ([`install/README.md`](../../install/README.md)).
   - **In tests:** set `OMEGACLAW_MODULE_LOADER` to a loader file
     (`src/helper_command_parser.py:132`), as
     [`tests/module_loader_test_utils.py`](../../tests/module_loader_test_utils.py)
     does.

3. Restart the mind. PeTTa compiles calls at import time
   (`lib_omegaclaw.metta:4`), so a running mind does not pick up a new module.

4. Check it. The mind can ask what the module provides:

   ```metta
   (match &self (Provides omegaclaw.example.hello $thing) $thing)
   ```

   It can read the help with `skill-help hello`. Its command is
   `hello-greet Ada`, which returns `(Greeting "hello" "Ada")` as text.

To remove it, delete the loader line and the folder, then restart the mind.

## Run the tests

From the repository root, with the toolchain in [`examples/README.md`](../README.md):

```
PETTA_PATH=/path/to/PeTTa python -m pytest -q examples/hello-module/tests
```

Without `PETTA_PATH` (or without `swipl` on `PATH`), the PeTTa test is skipped
and the parser tests still run.

## Change something and repeat

- Add a second argument to the signature, for example
  `(SkillSignature hello-greet (Arg text greeting) (Arg rest-text name))`, and
  update the skill and the test.
- Add `"skill:hello-wave"` to `provides` in `module.toml` without adding the
  `Provides` atom to `entry.metta`, and watch the first test fail. That is the
  check `tests/test_module_organs.py` runs over every module in `modules/`.
