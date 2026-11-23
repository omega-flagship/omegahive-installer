#!/usr/bin/env bash
# runtime-tests.sh [TEST_FILE...] -- tests/'s runtime tests, the ones that boot the core runtime through PeTTa, with
# the pinned toolchain the petta jobs set up. With no files it runs them all (scripts/ci/pr_hive_tests.py --runtime
# --all), or with RUNTIME_PARTS set only part RUNTIME_PART of them (scripts/ci/runtime_split.py). core-tests skips them, since it has no PeTTa; hive-petta-smoke runs them when a pull request touches the
# runtime, and hive-petta always.
#
# The tests read HIVE_TEST_PETTA (the toolchain's PeTTa) and HIVE_TEST_CHROMADB_LIB (the petta_lib_chromadb checkout
# setup_petta_env.sh puts in the runtime folder), and skip without them, so a missing one fails here instead. They
# boot PeTTa with the default runtime cache, so the core is composed there first, as core-tests does; without it
# lib_omegaclaw never defines omegaclaw (PeTTa: Unknown procedure omegaclaw/1). Booting also imports Python packages
# hive's requirements leave out, tests/ci-runtime-requirements.txt (tests/ci-requirements.txt, where openai is Omega's
# provider module and py-landlock its policy module, and chromadb, petta_lib_chromadb's module). In hive-runtime the
# petta-toolchain action restored or installed them into the cached Python (runtime-packages), so pip finds them there.
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
  if [ -n "${RUNTIME_PARTS:-}" ]; then
    # The full run's hive-runtime is a matrix: this job runs part RUNTIME_PART of RUNTIME_PARTS, modules or, for a
    # module the weights split by test, pytest node IDs (scripts/ci/runtime_split.py).
    part=$(python scripts/ci/runtime_split.py "${RUNTIME_PART:?RUNTIME_PART unset beside RUNTIME_PARTS}" \
      "$RUNTIME_PARTS" scripts/ci/runtime-test-weights.json "${files[@]}")
    mapfile -t files <<<"$part"
  fi
  set -- "${files[@]}"
fi

python scripts/setup_core.py
python -m pip install -q -c hive/ci-constraints.txt -r tests/ci-runtime-requirements.txt

echo "The $# runtime test modules or tests:"
printf '  %s\n' "$@"
python -m pytest -q -rfEs --durations=25 -o faulthandler_timeout=300 -p no:cacheprovider \
  --basetemp="${TMPDIR:?TMPDIR unset: run this after scripts/ci/job-tmp.sh start}/pytest-runtime" "$@"
