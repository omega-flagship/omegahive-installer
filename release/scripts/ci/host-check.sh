#!/usr/bin/env bash
# host-check.sh baseline|compare DIR -- did this CI job leave the machine as it found it? (T-120, R4)
#
# Runs as the runner user, reads only. "baseline" records, at the start of a job:
#   - kernel.apparmor_restrict_unprivileged_userns (must be 1 between jobs);
#   - every file and symlink under /etc/apparmor.d, with its sha256 (or link target);
#   - the installed package list (dpkg-query: name, architecture, version, status).
# "compare" records the same at the end of the job, prints any difference and fails on one. On a package difference
# it also prints the dpkg.log lines written since the baseline (unattended-upgrades can install during a job).
# For information only, it lists what the job wrote inside the checkout (git status --porcelain --ignored): those are
# writes to the slow disk instead of $TMPDIR.
#
# What a non-root check cannot see, and so does not claim: the set of loaded AppArmor profiles
# (/sys/kernel/security/apparmor/profiles is root-only), iptables/nftables and ufw rules, the contents of sudoers,
# other users' homes. The root-owned runner hooks installed by ci-runner-setup reset what a job may change.
set -euo pipefail

RESTRICT=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
SWITCH_LOCK=/run/lock/omegahive-switch   # the host prep creates it, root-owned, mode 0666 (scripts/ci/switch-shard.sh)

usage() { echo "usage: $0 baseline|compare DIR" >&2; exit 2; }
[ $# -eq 2 ] || usage
mode=$1 dir=$2

restriction() {
  local v
  v=$(cat "$RESTRICT" 2>/dev/null) || v=missing
  echo "$v"
}

snapshot() { # $1 = output directory
  local out=$1
  mkdir -p "$out"
  restriction >"$out/restriction"
  # Paths, one per line, with sha256 for files and the target for symlinks. An unreadable file is listed as such.
  { find /etc/apparmor.d -xdev \( -type f -o -type l \) -print0 2>/dev/null || true; } | sort -z |
    while IFS= read -r -d '' f; do
      if [ -L "$f" ]; then
        printf '%s -> %s\n' "$f" "$(readlink "$f")"
      elif [ -r "$f" ]; then
        printf '%s %s\n' "$f" "$(sha256sum <"$f" | cut -d' ' -f1)"
      else
        printf '%s unreadable\n' "$f"
      fi
    done >"$out/apparmor.d"
  dpkg-query -W -f='${Package}:${Architecture} ${Version} ${db:Status-Abbrev}\n' | sort >"$out/packages"
  date '+%F %T' >"$out/time"   # local time, the format of /var/log/dpkg.log
}

check_restriction() { # $1 = when
  local v
  v=$(restriction)
  # The value is the machine's, and on a server with several runners the full run's switch shard sets it to 0 under
  # the host's switch lock (scripts/ci/switch-shard.sh), so 0 is right while some job holds that lock, never otherwise.
  # Held only when flock -n exits 1 (the lock is taken); any other failure (unreadable lock file, no flock) is not a
  # hold, so 0 then fails below.
  if [ "$v" = 0 ] && [ -e "$SWITCH_LOCK" ]; then
    local held=0
    flock -n "$SWITCH_LOCK" true 2>/dev/null || held=$?
    if [ "$held" = 1 ]; then
      echo "host-check: restriction 0 $1, under the switch lock held by: $(cat "$SWITCH_LOCK" 2>/dev/null || echo '?')"
      return 0
    fi
  fi
  if [ "$v" != 1 ]; then
    echo "::error::kernel.apparmor_restrict_unprivileged_userns is $v $1, not 1"
    return 1
  fi
}

case "$mode" in
  baseline)
    snapshot "$dir/before"
    check_restriction "at the start of the job"
    echo "host-check: baseline in $dir/before ($(wc -l <"$dir/before/apparmor.d") files under /etc/apparmor.d," \
      "$(wc -l <"$dir/before/packages") packages)"
    ;;
  compare)
    [ -d "$dir/before" ] || { echo "::error::no baseline in $dir/before (the baseline step did not run)"; exit 1; }
    snapshot "$dir/after"
    rc=0
    check_restriction "at the end of the job" || rc=1
    if ! diff -u "$dir/before/apparmor.d" "$dir/after/apparmor.d"; then
      echo "::error::/etc/apparmor.d changed during the job (diff above)"
      rc=1
    fi
    if ! diff -u "$dir/before/packages" "$dir/after/packages"; then
      echo "::error::installed packages changed during the job (diff above)"
      since=$(cat "$dir/before/time")
      echo "dpkg.log since $since:"
      awk -v since="$since" '($1 " " $2) >= since' /var/log/dpkg.log 2>/dev/null || echo "(dpkg.log not readable)"
      rc=1
    fi
    if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE/.git" ]; then
      writes=$(git -C "$GITHUB_WORKSPACE" status --porcelain --ignored 2>/dev/null || true)
      if [ -n "$writes" ]; then
        echo "host-check (information): the job wrote these paths inside the checkout, on disk; first 100:"
        printf '%s\n' "$writes" | head -n 100
      else
        echo "host-check (information): the job wrote nothing inside the checkout"
      fi
    fi
    [ "$rc" -eq 0 ] && echo "host-check: no change to the restriction, /etc/apparmor.d or the package list"
    exit "$rc"
    ;;
  *) usage ;;
esac
