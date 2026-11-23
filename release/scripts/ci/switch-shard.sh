#!/usr/bin/env bash
# switch-shard.sh -- the full run's switch shard: the hive test files that need the AppArmor userns switch
# (scripts/ci/hive-switch-files.txt), at restriction 0 from the checkout, then the mind-sandbox tests at 1 from a
# release (release-tests.sh). (T-211; Kabir, 2026-11-20)
#
# The restriction is the machine's, and the full run's shards share machines, several runners each. So only this
# shard changes it, every other job there leaves it alone (petta-toolchain's lift-userns: 'false'), and at most one
# switch shard runs per machine at a time: it holds the host's switch lock, an flock on /run/lock/omegahive-switch,
# from before it sets 0 until after it has set 1 again and removed the release. The kernel drops an flock when its
# holder dies, so a killed job leaves no stale hold. The lock file holds the holder's runner, run and start, which a
# waiting shard prints when its wait runs out and host-check.sh prints when it finds 0 under the lock.
#
# Runs as one step, so the trap covers every exit after the lock: success, a failure, a cancel (SIGTERM, SIGINT) or
# the step's timeout, and sets 1 and removes the release on each. A kill -9 skips it, as it skips any step: the next
# switch shard's first act under the lock sets 1, and the runner's root-owned job hooks do too.
#
# Takes no arguments; reads from the environment:
#   HIVE_SWITCH_LOCK_WAIT_S  seconds to wait for the lock before failing (the runner's .env, set by the host prep;
#                            no value in this repository)
#   HIVE_SHARD, HIVE_SHARD_REPORT, HIVE_SHARD_WEIGHTS, HIVE_SWITCH_FILES, PYTHONPATH  as for the other shards
#                            (scripts/ci/hive_shard.py); HIVE_SHARD names the last shard, the switch shard
#   HIVE_TEST_TIMEOUT_S      the per-test limit, as for the other shards (scripts/ci/hive_test_timeout.py)
#   TMPDIR                   the job's tmpfs (job-tmp.sh)
# The host prep (ci-runner-add-host) creates the lock file root-owned with mode 0666, since fs.protected_regular
# refuses to open another runner's file in /run/lock.
#
# On GitHub's machine (RUNNER_ENVIRONMENT github-hosted) one job has the machine, so there is no lock and no wait.
set -euo pipefail

LOCK=/run/lock/omegahive-switch
SYSCTL=(sudo -n /usr/sbin/sysctl -w)
KEY=kernel.apparmor_restrict_unprivileged_userns
hosted=false
[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && hosted=true

if ! $hosted; then
  wait_s=${HIVE_SWITCH_LOCK_WAIT_S:-}
  case "$wait_s" in
    ''|*[!0-9]*)
      echo "::error::HIVE_SWITCH_LOCK_WAIT_S must be whole seconds, got '${wait_s}': set it in the runner's .env"
      exit 1 ;;
  esac
  if [ ! -w "$LOCK" ]; then
    echo "::error::$LOCK is missing or not writable for $(id -un): the host prep (ci-runner-add-host) creates it"
    exit 1
  fi
  exec 9<>"$LOCK"   # fd 9 is inherited: a child that outlives this script holds the lock until the runner reaps it
  echo "switch-shard: waiting up to ${wait_s}s for $LOCK"
  if ! flock -w "$wait_s" 9; then
    echo "::error::the switch lock was still held after ${wait_s}s, by: $(cat "$LOCK" 2>/dev/null || echo '?')"
    exit 1
  fi
  printf 'runner %s, run %s attempt %s, since %s\n' "${RUNNER_NAME:-?}" "${GITHUB_RUN_ID:-?}" \
    "${GITHUB_RUN_ATTEMPT:-?}" "$(date -u +%FT%TZ)" >"$LOCK"
  echo "switch-shard: holding the switch lock ($(cat "$LOCK"))"
fi

restore() {
  local rc=$?
  "${SYSCTL[@]}" "$KEY=1" || rc=1
  if ! $hosted; then
    sudo -n /usr/local/sbin/omegahive-ci-release --remove || rc=1
    : >"$LOCK" || true
  fi
  echo "switch-shard: restriction $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns), lock released"
  exit "$rc"
}
# A cancel gives the step about 10 s from SIGINT to SIGKILL: a pytest teardown slower than that skips restore and can
# leave 0, which the next host-check reports as an error (the next switch shard, or the job hooks, set 1 again).
trap restore EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Under the lock no other job may hold 0, so a 0 here is left by a job that died: set 1 first, then lift.
"${SYSCTL[@]}" "$KEY=1"
"${SYSCTL[@]}" "$KEY=0"
mkdir -p "$(dirname "${HIVE_SHARD_REPORT:?}")"
# Both parts run, so a failure at 0 does not hide the release's; the step fails if either did.
rc=0
python -m pytest -v -rfEsxX --durations=25 -p hive_test_timeout \
  -p hive_shard -o junit_family=xunit1 --junitxml="$(dirname "$HIVE_SHARD_REPORT")/junit.xml" \
  -p no:cacheprovider --basetemp="${TMPDIR:?}/pytest" hive/tests || rc=$?
bash scripts/ci/release-tests.sh || rc=$?
exit "$rc"
