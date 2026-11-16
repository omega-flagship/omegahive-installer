# Examples

Three short hands-on exercises, one for each way to extend OmegaHive, plus a
disposable local hive to try them in (not a security sandbox; see its limits in [`SANDBOX.md`](SANDBOX.md)). All of them use invented data only. Each
one is a copy-and-change starting point: run its test, change one thing, run
it again.

| Exercise | You learn | Test |
|---|---|---|
| [`hello-app/`](hello-app/README.md) | The program contract: a plugin with `describe()`, `view()` and `act()`, the contract checker, and mounting it with `HIVE_PLUGIN_DIRS`. | `python -m pytest -q examples/hello-app/tests` |
| [`hello-module/`](hello-module/README.md) | The OmegaClaw module contract: a module with one harmless skill, and how a mind enables it. | `python -m pytest -q examples/hello-module/tests` |
| [`hello-model/`](hello-model/README.md) | Adding your own OpenAI-compatible model server with `HIVE_PROVIDERS_FILE`, and choosing it per mind as `provider/model`. | `python -m pytest -q examples/hello-model/tests` |
| [`SANDBOX.md`](SANDBOX.md) | One command for a disposable local hive on 127.0.0.1, offline, with `hello-app` mounted. Runs as you, with no mind OS sandbox; use a VM or container for adversarial work. | (none; you run it) |

Run every command from the repository root. The examples change no existing
code, and their tests do not start a hive or call a network.

## Toolchain (exact versions)

The same as the repository's [prerequisites](../README.md#prerequisites-exact-versions):

| Tool | Version |
|---|---|
| Python | **3.12**, the same interpreter janus-swi is installed into |
| SWI-Prolog | **10.1.14**, built against that Python 3.12 |
| PeTTa | commit **`ae66fa8`** |
| janus-swi | **1.5.3** |

The SWI-Prolog `bin` folder must be first on `PATH`, and `PETTA_PATH` must name
the PeTTa checkout. The repository README explains why and gives the one-line
bridge check.

What each exercise needs:

- `hello-app` and `hello-model`: Python 3.12 with `hive/requirements.txt`.
  No PeTTa.
- `hello-module`: Python 3.12 and the repository's `src/`. Its last test also
  loads the module in PeTTa; it is skipped when `PETTA_PATH` or `swipl` is
  missing.
- The sandbox: everything above. Node.js only if you want the UI
  (see [`SANDBOX.md`](SANDBOX.md)).

## Where this fits

These exercises are the hands-on end of the onboarding kit. The learning
tracks in the `omegahive-start-here` repository point here. The component
cards and diagrams in the `omegahive-schematics` repository explain the parts
they touch. The contracts themselves are in
[`hive/PROGRAMS.md`](../hive/PROGRAMS.md) (apps),
[`docs/reference-omegaclaw-module-contract.md`](../docs/reference-omegaclaw-module-contract.md)
(modules) and [`hive/README.md`](../hive/README.md) (configuration and providers).
