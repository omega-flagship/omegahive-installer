#!/bin/bash
# Purpose: give the own hive in $OMEGAHIVE_HOME Studio, the app it shows as Create: omegadesign at the version pins.sh
# names, unpacked from the release's zip (its omegadesign-release/<version>/ folder) into apps/omegadesign and checked
# against the source digest and page lock sha256 in pins.sh, the same two values omegahive.sh pins it to in HIVE_APP_PINS
# at every start, its files left read-only. The hive's owner then installs it and turns it on in Create · Code
# (omegahive.sh create); without it the hive lists no Create.
#
#   OMEGAHIVE_HOME=<hive folder> setup-studio.sh <omegadesign release zip>
#
# Re-running keeps a folder that already holds the pinned release and replaces any other.
set -euo pipefail

OH=${OMEGAHIVE_HOME:?OMEGAHIVE_HOME names the hive folder}
ZIP=${1:?usage: setup-studio.sh <omegadesign release zip>}
PY=$OH/venv/bin/python
STUDIO=$OH/apps/omegadesign
[ -x "$PY" ] && [ -f "$OH/app/hive/core/programs.py" ] || { echo "no finished own hive in $OH" >&2; exit 1; }
. "$(cd "$(dirname "$0")" && pwd)/pins.sh"
umask 077

# The hive's own source digest (Programs.source_digest: plugin.json and every .py and .metta file), so this checks the
# folder exactly as the hive's pin will, and the sha256 of the page lock the pin binds.
digest() {
  (cd "$OH/app" && "$PY" -I -c 'import pathlib, sys; sys.path.insert(0, "."); from hive.core.programs import Programs
print(Programs.source_digest(pathlib.Path(sys.argv[1])))' "$1")
}
pinned() {
  [ -f "$1/plugin.json" ] && [ "$(digest "$1")" = "$OMEGADESIGN_DIGEST" ] \
    && [ -f "$1/ui/bundle.lock.json" ] && [ "$(sha256 "$1/ui/bundle.lock.json" | cut -d ' ' -f 1)" = "$OMEGADESIGN_LOCK_SHA256" ]
}

mkdir -p "$OH/apps" && chmod 700 "$OH/apps"
if pinned "$STUDIO"; then
  echo "Studio is already omegadesign $OMEGADESIGN_VERSION ($STUDIO)."
  exit 0
fi
rm -rf "$STUDIO.new" && mkdir -p "$STUDIO.new"
# A refused bundle leaves nothing behind; the folder already in place, if any, stays as it was.
trap 'rm -rf "$STUDIO.new"' EXIT
# The hive's Python unzips it, which macOS and every Linux the installer serves have, where unzip is not on a fresh
# Ubuntu. Only the release folder's own members come out, each kept inside the new folder; a link or a path that climbs
# out stops the setup.
"$PY" -I - "$ZIP" "omegadesign-release/$OMEGADESIGN_VERSION/" "$STUDIO.new" <<'PY'
import pathlib, sys, zipfile
zip_path, prefix, dest = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3]).resolve()
with zipfile.ZipFile(zip_path) as z:
    members = [m for m in z.infolist() if m.filename.startswith(prefix) and m.filename != prefix]
    if not members:
        raise SystemExit(f"{zip_path} holds no {prefix}")
    for m in members:
        if (m.external_attr >> 16) & 0o170000 == 0o120000:
            raise SystemExit(f"{m.filename} is a link")
        target = (dest / m.filename[len(prefix):]).resolve()
        if dest not in target.parents and target != dest:
            raise SystemExit(f"{m.filename} would land outside the Studio folder")
        if m.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(z.read(m))
PY
xattr -dr com.apple.quarantine "$STUDIO.new" 2>/dev/null || true
pinned "$STUDIO.new" || { echo "Studio in $ZIP is not omegadesign $OMEGADESIGN_VERSION as pinned: download the release again" >&2; exit 1; }
# Only the files go read-only: read-only folders make rm -rf of the hive folder fail (setup-code.sh's rule).
find "$STUDIO.new" -type f -exec chmod a-w {} +
rm -rf "$STUDIO"
mv "$STUDIO.new" "$STUDIO"
echo "Studio is omegadesign $OMEGADESIGN_VERSION in $STUDIO."
