#!/usr/bin/env bash
# job-tmp.sh start|peak -- the job's temporary files go to RAM, not to the machine's slow disk. (T-120, R5)
#
# start: checks that /srv/ci-tmp/<runner user> is on a tmpfs (ci-runner-setup mounts /srv/ci-tmp and creates the
#        folder, mode 0700, at boot), makes <that>/job, sets TMPDIR to it for the later steps, and starts a sampler
#        that records the mount's peak use every 5 s.
# peak:  stops the sampler and prints the peak and the mount's size, so the tmpfs can be sized from real runs.
# The runner's root-owned job hooks empty the folder before and after each job.
set -euo pipefail

ROOT=/srv/ci-tmp
user=$(id -un)
base="$ROOT/$user"
state="${RUNNER_TEMP:?RUNNER_TEMP unset: run this inside a GitHub Actions job}/job-tmp"

used_bytes() { df -B1 --output=used "$ROOT" | tail -n 1 | tr -d ' '; }

case "${1:-}" in
  start)
    fstype=$(findmnt -n -o FSTYPE --target "$base" 2>/dev/null || true)
    if [ ! -d "$base" ] || [ "$fstype" != tmpfs ]; then
      echo "::error::$base is not a folder on a tmpfs (fstype: ${fstype:-none}). Run ci-runner-setup on this machine."
      exit 1
    fi
    mkdir -p "$base/job" "$state"
    echo "TMPDIR=$base/job" >>"$GITHUB_ENV"
    # The hive refuses an upload or folder write that would leave less than HIVE_MIN_FREE_GB free (hive/core/assets.py
    # min_free_bytes, 25 by default), and no write leaves 25 GB free on this tmpfs (8 GiB; run 43114903331 peaked at
    # 559 MiB), so every test that stores a file got 507 there. 1 GB fits inside it and keeps the floor checked; the
    # floor's own tests set theirs.
    echo "HIVE_MIN_FREE_GB=1" >>"$GITHUB_ENV"
    used_bytes >"$state/peak"
    # Detached, with no inherited output, so the step does not wait on it. The runner ends it with the job at the latest.
    # shellcheck disable=SC2016  # expands in the child shell, from its arguments
    nohup bash -c '
      peak=$(cat "$1")
      while sleep 5; do
        u=$(df -B1 --output=used "$2" | tail -n 1 | tr -d " ")
        if [ "$u" -gt "$peak" ]; then peak=$u; echo "$peak" >"$1"; fi
      done' job-tmp-sampler "$state/peak" "$ROOT" </dev/null >/dev/null 2>&1 &
    echo $! >"$state/pid"
    echo "job-tmp: TMPDIR=$base/job on tmpfs $ROOT ($(df -h --output=size "$ROOT" | tail -n 1 | tr -d ' ')), sampler pid $!"
    ;;
  peak)
    if [ ! -f "$state/peak" ]; then echo "job-tmp: no sampler was started"; exit 0; fi
    if [ -f "$state/pid" ]; then kill "$(cat "$state/pid")" 2>/dev/null || echo "job-tmp: the sampler had already stopped"; fi
    now=$(used_bytes)
    peak=$(cat "$state/peak")
    [ "$now" -gt "$peak" ] && peak=$now
    size=$(df -B1 --output=size "$ROOT" | tail -n 1 | tr -d ' ')
    echo "job-tmp: peak use of $ROOT $((peak / 1048576)) MiB of $((size / 1048576)) MiB (5 s samples)"
    ;;
  *) echo "usage: $0 start|peak" >&2; exit 2 ;;
esac
