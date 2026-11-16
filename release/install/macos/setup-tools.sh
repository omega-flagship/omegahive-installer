#!/bin/bash
# Purpose: give the own hive in $OMEGAHIVE_HOME its Tools app: omega-tools at the commit pins.sh names (0.6.1 with its
# reviewed capability-sets.json), unpacked from the release's tarball into apps/omega-tools and checked against the
# source digest and lock sha256 in pins.sh, the same two values omegahive.sh pins it to in HIVE_APP_PINS at every start,
# its files left read-only. Without it the hive's Tools page says "omega-tools-pinned-release-unavailable".
#
#   OMEGAHIVE_HOME=<hive folder> setup-tools.sh <omega-tools release tarball>
#
# Re-running keeps a folder that already holds the pinned release and replaces any other.
set -euo pipefail

OH=${OMEGAHIVE_HOME:?OMEGAHIVE_HOME names the hive folder}
TARBALL=${1:?usage: setup-tools.sh <omega-tools release tarball>}
PY=$OH/venv/bin/python
TOOLS=$OH/apps/omega-tools
[ -x "$PY" ] && [ -f "$OH/app/hive/core/programs.py" ] || { echo "no finished own hive in $OH" >&2; exit 1; }
. "$(cd "$(dirname "$0")" && pwd)/pins.sh"
umask 077

# The hive's own source digest (Programs.source_digest: plugin.json and every .py and .metta file), so this checks the
# folder exactly as the hive's pin will, and the sha256 of the lock the pin binds.
digest() {
  (cd "$OH/app" && "$PY" -I -c 'import pathlib, sys; sys.path.insert(0, "."); from hive.core.programs import Programs
print(Programs.source_digest(pathlib.Path(sys.argv[1])))' "$1")
}
pinned() {
  [ -f "$1/plugin.json" ] && [ "$(digest "$1")" = "$OMEGA_TOOLS_DIGEST" ] \
    && [ "$(sha256 "$1/release-data.lock.json" | cut -d ' ' -f 1)" = "$OMEGA_TOOLS_LOCK_SHA256" ]
}

mkdir -p "$OH/apps" && chmod 700 "$OH/apps"
if pinned "$TOOLS"; then
  echo "The Tools app is already omega-tools $OMEGA_TOOLS_VERSION ($TOOLS)."
  exit 0
fi
rm -rf "$TOOLS.new" && mkdir -p "$TOOLS.new"
# From stdin, so tar copies no quarantine from the downloaded tarball; cleared anyway. Only the
# files go read-only: read-only folders make rm -rf of the hive folder fail (setup-code.sh's rule).
tar -xzf - -C "$TOOLS.new" < "$TARBALL"
xattr -dr com.apple.quarantine "$TOOLS.new" 2>/dev/null || true
pinned "$TOOLS.new" || { echo "the Tools app in $TARBALL is not omega-tools $OMEGA_TOOLS_VERSION as pinned: download the release again" >&2; exit 1; }
find "$TOOLS.new" -type f -exec chmod a-w {} +
rm -rf "$TOOLS"
mv "$TOOLS.new" "$TOOLS"
echo "The Tools app is omega-tools $OMEGA_TOOLS_VERSION in $TOOLS."
