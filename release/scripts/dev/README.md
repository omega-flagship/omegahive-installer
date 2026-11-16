# PeTTa CI runtime

Use Python 3.12 with its headers and shared library. Install the build prerequisites listed in `.github/workflows/ci.yml`, then run the helper as your ordinary user.

```sh
SWIPL_TAG=V10.1.14 PETTA_REF=ae66fa8 JANUS_VERSION=1.5.3 \
  bash scripts/dev/setup_petta_env.sh \
    --prefix "$HOME/swipl-patched" --petta "$HOME/PeTTa" \
    --python /path/to/python3.12 --runtime "$HOME/.omegadots/runtime"
```

The helper builds SWI-Prolog from `swipl-devel` at the selected tag. It installs only into `--prefix`. It checks out the requested PeTTa revision and installs the requested `janus-swi` version into the selected Python environment. Use a virtual environment if you want those Python packages isolated.

Run the same command again to reuse the SWI cache. Reuse requires matching tag, prefix, interpreter and Python version, plus a working Prolog-to-Python bridge at that interpreter's base prefix. Both bridge directions and a MeTTa program returning `42` are checked on every run. The Janus identity check uses the documented [Python attribute access](https://www.swi-prolog.org/pldoc/man?section=janus) through `py_call/2`.

`CMAKE_BUILD_PARALLEL_LEVEL` controls build concurrency. `SWIPL_BUILD_DIR` selects scratch storage, which is `$TMPDIR`, or `/tmp`, by default. Configure, build and install logs remain there after the temporary source tree is removed. Compiler settings such as `CC` and `CFLAGS` from the invoking shell are ignored, and the build uses `cc` and `c++` from `PATH`. `CMAKE_PREFIX_PATH` and `PKG_CONFIG_PATH` can name separately installed build dependencies.

The generated `--runtime/run.sh` preserves the chosen interpreter, SWI path and private Omega runtime cache. It supports `OMEGACLAW_ROOT=<runtime> python tests/run_metta_smokes.py <smoke>`. The old positional runtime argument still works. The helper refuses to overwrite a real `repos/OmegaClaw-Core` directory or a modified PeTTa checkout; choose separate paths for those cases.
