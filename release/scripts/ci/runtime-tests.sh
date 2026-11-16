#!/usr/bin/env bash
# runtime-tests.sh [TEST_FILE...] -- tests/'s runtime tests, the ones that boot the core runtime through PeTTa, with
# the pinned toolchain the petta jobs set up. With no files it runs them all (scripts/ci/pr_hive_tests.py --runtime
# --all). core-tests skips them, since it has no PeTTa; hive-petta-smoke runs them when a pull request touches the
# runtime, and hive-petta always.
#
# The tests read HIVE_TEST_PETTA (the toolchain's PeTTa) and HIVE_TEST_CHROMADB_LIB (the petta_lib_chromadb checkout
# setup_petta_env.sh puts in the runtime folder), and skip without them, so a missing one fails here instead. They
# boot PeTTa with the default runtime cache, so the core is composed there first, as core-tests does; without it
# lib_omegaclaw never defines omegaclaw (PeTTa: Unknown procedure omegaclaw/1). Booting also imports Python packages
# hive's requirements leave out: tests/ci-requirements.txt (openai is Omega's provider module, py-landlock its policy
# module) and chromadb (petta_lib_chromadb's module), at the version run 43150069790 passed
# tests/test_wait_quiet_runtime.py with.
set -euo pipefail

export HIVE_TEST_PETTA="${PETTA_PATH:?PETTA_PATH unset: run this after the petta-toolchain action}"
export HIVE_TEST_CHROMADB_LIB="${RUNNER_TEMP:?RUNNER_TEMP unset: run this inside a GitHub Actions job}/omegadots-runtime/repos/petta_lib_chromadb"
for f in "$HIVE_TEST_PETTA/run.sh" "$HIVE_TEST_CHROMADB_LIB/lib_chromadb.metta"; do
  [ -f "$f" ] || { echo "::error::$f is missing, so the runtime tests would skip"; exit 1; }
done

if [ "$#" -eq 0 ]; then
  list=$(python scripts/ci/pr_hive_tests.py --runtime --all)
  [ -n "$list" ] || { echo "::error::no test under tests/ reads HIVE_TEST_PETTA"; exit 1; }
  mapfile -t files <<<"$list"
  set -- "${files[@]}"
fi

python scripts/setup_core.py
python -m pip install -q -c hive/ci-constraints.txt -r tests/ci-requirements.txt
python -m pip install -q 'chromadb==1.5.9'

echo "The $# runtime test modules:"
printf '  %s\n' "$@"
python -m pytest -q -rfEs --durations=25 -o faulthandler_timeout=300 -p no:cacheprovider \
  --basetemp="${TMPDIR:?TMPDIR unset: run this after scripts/ci/job-tmp.sh start}/pytest-runtime" "$@"
