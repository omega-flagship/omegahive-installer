#!/bin/bash
# Purpose: write a micromamba explicit lock file that pins every conda-forge package of an environment by URL and
# sha256, so `micromamba create -f LOCK` installs exactly those builds and refuses any file whose checksum differs.
#
# Usage: install/macos/conda-lock.sh PLATFORM LOCK SPEC...
#   PLATFORM  osx-arm64 or osx-64 (a lock for either can be made on either kind of Mac), or linux-64 or linux-aarch64
#             for the Windows installer's WSL distro (made on a Linux host or a Mac alike)
#   LOCK      the file to write, for example install/macos/locks/conda-osx-arm64.txt
#   SPEC      what to solve, as micromamba takes it: python=3.12 "nodejs>=22.12,<27" uv ...
# The solve runs the micromamba pinned in pins.sh, fetched once into ~/.cache/omegahive-pins and checked there.
# Rerun it to move a lock to newer builds on purpose; the installer and the bundle build only ever read locks.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/pins.sh"
[ "$#" -ge 3 ] || { echo "usage: $0 PLATFORM LOCK SPEC..." >&2; exit 2; }
PLATFORM=$1; LOCK=$2; shift 2
case "$PLATFORM" in osx-arm64|osx-64|linux-64|linux-aarch64) ;;
  *) echo "PLATFORM is osx-arm64, osx-64, linux-64 or linux-aarch64, not $PLATFORM" >&2; exit 2;; esac

# The solve runs the pinned micromamba built for this host; --platform makes it solve for PLATFORM.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) HOST=osx-arm64 ;; Darwin/x86_64) HOST=osx-64 ;;
  Linux/x86_64) HOST=linux-64 ;; Linux/aarch64) HOST=linux-aarch64 ;;
  *) echo "no micromamba is pinned for this host, $(uname -s)/$(uname -m)" >&2; exit 2 ;;
esac
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/omegahive-pins/micromamba-$MICROMAMBA_VERSION-$HOST
if [ ! -x "$CACHE" ]; then
  mkdir -p "$(dirname "$CACHE")"
  pin_fetch "$(micromamba_url "$HOST")" "$(micromamba_sha256 "$HOST")" "$CACHE"
  chmod 755 "$CACHE"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/conda-lock.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# A dry run solves without installing; LINK lists every package the environment would hold, with its URL and the
# sha256 conda-forge's repodata publishes for it.
MAMBA_ROOT_PREFIX=$WORK/root "$CACHE" create --dry-run --json --no-rc -y -p "$WORK/env" --platform "$PLATFORM" \
  --override-channels -c conda-forge "$@" > "$WORK/solve.json"
/usr/bin/python3 -I - "$WORK/solve.json" "$LOCK.part" "$PLATFORM" "$MICROMAMBA_VERSION" "$*" <<'PY'
import json, sys, time
solve, out, platform, version, specs = sys.argv[1:6]
links = json.load(open(solve))["actions"]["LINK"]
lines = []
for pkg in links:
    if len(pkg.get("sha256") or "") != 64:
        sys.exit(f"conda-forge published no sha256 for {pkg.get('url')}")
    lines.append(f"{pkg['url']}#sha256:{pkg['sha256']}")
with open(out, "w") as f:
    f.write(f"# conda-forge lock for {platform}, solved {time.strftime('%Y-%m-%d', time.gmtime())} by micromamba {version}"
            f" from: {specs}\n# Made by install/macos/conda-lock.sh; install with: micromamba create -p PREFIX -f THIS_FILE\n")
    f.write("@EXPLICIT\n" + "\n".join(sorted(lines)) + "\n")
print(f"{out[:-5]}: {len(lines)} packages")
PY
mv "$LOCK.part" "$LOCK"
