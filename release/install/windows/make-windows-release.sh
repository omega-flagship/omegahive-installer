#!/bin/sh
# Purpose: build a Windows release zip, the Windows twin of install/macos/make-mac-release.sh: one folder holding a
#   single "Install Omega.cmd" to double-click and an omegahive folder with the PowerShell installer, the script it runs
#   inside WSL, the release's name, and the hive's code at one commit (with its web UI built, RELEASE_COMMIT and
#   RELEASE_VERSION) as ONE tarball with its .sha256. A tarball, not a folder of files, because Windows' unzip keeps no
#   Unix modes and WSL reads one file from the Windows disk far faster than three thousand. What a public zip carries is
#   install/public_release.py's rule: the exported tree is pruned with it before packing, and the finished zip,
#   tarball included, is checked with it, so a closed part stops the build.
# Usage: make-windows-release.sh <repo> <revision> <out.zip> [prebuilt file ...]
#   Prebuilt files (Create's omegacode-309df.tgz, the Tools app's omega-tools-4e57d67.tgz, the Omega core's
#   omega-core-a6bd778.bundle, which also gives a UI built here its pinned Omega files) go into the tarball's
#   install/macos/ with their .sha256, as make-mac-release.sh puts them; the Mac-only SWI-Prolog bundle and janus wheel
#   are not needed on Windows.
#   RELEASE_NAME   names the build (win-hive-v0.1 gives "Omega Hive v0.1" and RELEASE_VERSION 0.1)
#   UPDATE_CHANNEL test labels it a test build; any other value, or none, a release
#   UI_DIST_ZIP    a Mac release zip of the same revision whose built hive/ui/dist is reused; a paired release's name
#                  and commit must match that zip's stamped version and commit before packaging starts
#   UI_DIST_DIR    a built dist folder of the same revision itself; UI_VITE_ONLY=1 builds it with vite alone
# Layout of the zip:
#   Omega Hive v0.1/
#     Install Omega.cmd                        <- install/windows/Install OmegaHive.cmd
#     omegahive/
#       Install-OmegaHive.ps1                  <- install/windows/Install-OmegaHive.ps1
#       omegahive-wsl.sh                       <- install/windows/omegahive-wsl.sh
#       RELEASE_NAME                           the name the installer prints first
#       omegahive.tar.gz (+ .sha256)           one root omegahive/: the pruned git archive of the revision,
#                                              hive/ui/dist, RELEASE_COMMIT, RELEASE_VERSION
set -eu

[ $# -ge 3 ] || { echo "usage: $0 <repo> <revision> <out.zip> [prebuilt file ...]" >&2; exit 2; }
REPO=$1 REV=$2 OUT=$3
shift 3
NAME=${RELEASE_NAME:-win-hive-unnamed}
if [ -n "${UI_DIST_ZIP:-}" ]; then
  UI_COMMIT=$(unzip -p "$UI_DIST_ZIP" '*/omegahive/RELEASE_COMMIT')
  [ "$UI_COMMIT" = "$(git -C "$REPO" rev-parse "$REV")" ] \
    || { echo "the Mac UI artifact is from another source commit" >&2; exit 1; }
  case $NAME in
    win-hive-v*)
      UI_VERSION=$(unzip -p "$UI_DIST_ZIP" '*/omegahive/RELEASE_VERSION')
      [ "${NAME#win-hive-v}" = "$UI_VERSION" ] \
        || { echo "the Windows release name does not match the Mac's stamped version $UI_VERSION" >&2; exit 1; }
      ;;
  esac
fi
OUT_DIR=$(CDPATH= cd -- "$(dirname -- "$OUT")" && pwd)
OUT_ABS="$OUT_DIR/$(basename -- "$OUT")"
WORK=$(mktemp -d "$OUT_DIR/release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
TOP="$WORK/Omega Hive ${NAME#win-hive-}"
CODE="$WORK/omegahive"
mkdir -p "$TOP/omegahive" "$CODE"

git -C "$REPO" archive --format=tar "$REV" | tar -x -C "$CODE"
git -C "$REPO" rev-parse "$REV" > "$CODE/RELEASE_COMMIT"
case $NAME in win-hive-v[0-9]*) echo "${NAME#win-hive-v}" > "$CODE/RELEASE_VERSION" ;; esac
# Where the feedback area of every hive that installs this release sends reports (hive/core/feedback.py configured),
# below the hive's own HIVE_FEEDBACK_TO; a value the hive could not use stops the build here.
if [ -n "${FEEDBACK_TO:-}" ]; then
  (cd "$CODE" && python3 -B -c 'import sys
from hive.core.feedback import destination
to = destination(sys.argv[1])
sys.exit("FEEDBACK_TO: " + to["reason"] if to["kind"] == "invalid" else 0)' "$FEEDBACK_TO") || exit 2
  printf '%s\n' "$FEEDBACK_TO" > "$CODE/FEEDBACK_TO"
fi
# What the public zip leaves out goes before anything is built or packed from the tree.
python3 -B "$CODE/install/public_release.py" prune "$CODE"

if [ -n "${UI_DIST_DIR:-}" ]; then
  cp -R "$UI_DIST_DIR" "$CODE/hive/ui/dist"
elif [ -n "${UI_DIST_ZIP:-}" ]; then
  mkdir "$WORK/ui"
  unzip -q "$UI_DIST_ZIP" '*/omegahive/hive/ui/dist/*' -d "$WORK/ui"
  mv "$WORK"/ui/*/omegahive/hive/ui/dist "$CODE/hive/ui/dist"
else
  # The UI's imports from outside hive/ui (third_party/Omega's lib_nal and lib_pln, which an archive never carries, and
  # hive/spaces' lib_hive) are put in place by install/ui_pins.py's rule, as the Mac build does: each from its pinned
  # copy or the release's Omega core bundle (the omega-core-*.bundle prebuilt), and only with its pinned sha256.
  python3 -I "$CODE/install/ui_pins.py" "$CODE" "$WORK" "$@"
  if [ -n "${UI_VITE_ONLY:-}" ]; then
    # vite alone writes the same dist/; npm run build adds tsc's type check and two output checks, which take over ten
    # minutes on a loaded machine and change no file.
    (cd "$CODE/hive/ui" && npm ci --no-audit --no-fund && npx vite build && rm -rf node_modules)
  else
    (cd "$CODE/hive/ui" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules)
  fi
fi
test -f "$CODE/hive/ui/dist/index.html" || { echo "no hive/ui/dist/index.html" >&2; exit 1; }
# The Omega files pinned above serve only that build: inside WSL the core comes from setup_core.py (omegahive.sh core,
# from the release's bundle), which refuses a third_party/Omega holding files but no checkout.
[ -d "$CODE/third_party/Omega/.git" ] || rm -rf "$CODE/third_party/Omega"

for f in "$@"; do
  test -f "$f.sha256" || { echo "no checksum file $f.sha256" >&2; exit 1; }
  (cd "$(dirname -- "$f")" && sha256sum -c "$(basename -- "$f").sha256") >/dev/null || { echo "$f does not match its checksum file" >&2; exit 1; }
  cp "$f" "$f.sha256" "$CODE/install/macos/"
done

# The archive's own modes (0755 and 0644) ride inside the tarball, which Windows' unzip leaves untouched.
(cd "$WORK" && tar -czf "$TOP/omegahive/omegahive.tar.gz" omegahive)
(cd "$TOP/omegahive" && sha256sum omegahive.tar.gz > omegahive.tar.gz.sha256)
for f in Install-OmegaHive.ps1 omegahive-wsl.sh; do cp "$CODE/install/windows/$f" "$TOP/omegahive/$f"; done
cp "$CODE/install/windows/Install OmegaHive.cmd" "$TOP/Install Omega.cmd"
case ${UPDATE_CHANNEL:-release} in test) LABEL="test build $NAME" ;; *) LABEL=$NAME ;; esac
printf '%s\r\n' "$LABEL" > "$TOP/omegahive/RELEASE_NAME"

rm -f "$OUT_ABS"
(cd "$WORK" && zip -qry "$OUT_ABS" "$(basename -- "$TOP")")
# The finished zip is what gets published, so the rule is checked on it, the code tarball and prebuilt files included.
python3 -B "$CODE/install/public_release.py" check "$OUT_ABS" || { rm -f "$OUT_ABS"; exit 1; }
sha256sum "$OUT_ABS"
