#!/bin/sh
# Purpose: build a Mac release zip: one folder holding "Install Omega.command" to double-click, the hive's code at one
#   commit with its web UI built and its release number (RELEASE_VERSION, from RELEASE_NAME), the update channel its
#   hives follow (install/macos/update-trust.json), and the prebuilt runtime files given, placed in install/macos/ where
#   the installer looks for them. What a public zip carries is install/public_release.py's rule: the exported tree is
#   pruned with it before the UI is built, and the finished zip is checked with it, so a closed part stops the build.
# Usage: make-mac-release.sh <repo> <revision> <out.zip> [prebuilt file ...]
#   RELEASE_NAME        the build's name, printed first by the double-click file; mac-hive-v0.10 numbers it 0.10
#   UPDATE_TRUST        a trust file to ship as it is (after a key rotation, the one publish-update.py rotate wrote), or
#   UPDATE_PUBKEY       the channel's public key(s), space-separated, with UPDATE_NEXT_PUBKEYS (the keys that may replace
#                       them), UPDATE_CHANNEL (default release) and UPDATE_FEED (default the channel's own asset of
#                       omega-flagship/omegahive-installer's mac-update-feed release: omegahive-mac-update.json for the
#                       release channel, omegahive-mac-update-<channel>.json for any other). One of UPDATE_TRUST and
#                       UPDATE_PUBKEY is required, so no build trusts a key its maker did not name.
#   RELEASES_URL        where the double-click file sends someone for a newer build (default omegahive-installer's releases)
#   FEEDBACK_TO         where the feedback area of every hive that installs this release sends reports
#                       (hive/core/feedback.py), below a hive's own HIVE_FEEDBACK_TO; unset leaves the team's board
#   UI_DIST_DIR         a built hive/ui/dist of the same revision to ship instead of building the UI here
#   INSTALLER_IN_REPO   the installer inside the repo (default install/macos/Install OmegaHive.command)
# Cost: one git archive of the revision, one npm ci and UI build (about a minute) unless UI_DIST_DIR is given, one zip
#   of the tree, and one read of the zip to check it.
set -eu

usage() { echo "usage: $0 <repo> <revision> <out.zip> [prebuilt file ...]" >&2; exit 2; }
[ $# -ge 3 ] || usage
REPO=$1 REV=$2 OUT=$3
shift 3
INSTALLER_IN_REPO=${INSTALLER_IN_REPO:-install/macos/Install OmegaHive.command}
RELEASES_URL=${RELEASES_URL:-https://github.com/omega-flagship/omegahive-installer/releases}
[ -n "${UPDATE_TRUST:-}${UPDATE_PUBKEY:-}" ] || {
  echo "no update channel: set UPDATE_TRUST to a trust file, or UPDATE_PUBKEY (with UPDATE_NEXT_PUBKEYS) to its keys" >&2
  exit 2
}
# Each channel reads its own asset of omegahive-installer's mac-update-feed release, so no build points its hives at
# another channel's statements, which they refuse (install/macos/update.py statement_problems): the release channel's
# omegahive-mac-update.json, any other channel C's omegahive-mac-update-C.json.
FEED_RELEASE=https://github.com/omega-flagship/omegahive-installer/releases/download/mac-update-feed
case ${UPDATE_CHANNEL:-release} in
  release) DEFAULT_FEED=$FEED_RELEASE/omegahive-mac-update.json ;;
  *[!a-z0-9-]* | -*)
    [ -n "${UPDATE_FEED:-}${UPDATE_TRUST:-}" ] || {
      echo "UPDATE_CHANNEL $UPDATE_CHANNEL cannot name a feed file:" \
        "use lowercase letters, digits and dashes, or set UPDATE_FEED" >&2
      exit 2
    }
    DEFAULT_FEED= ;;
  *) DEFAULT_FEED=$FEED_RELEASE/omegahive-mac-update-$UPDATE_CHANNEL.json ;;
esac

OUT_DIR=$(CDPATH= cd -- "$(dirname -- "$OUT")" && pwd)
OUT_ABS="$OUT_DIR/$(basename -- "$OUT")"
WORK=$(mktemp -d "$OUT_DIR/release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# The folder carries the build's version, so two downloads unpack side by side as "Omega Hive v0.7" and "Omega Hive v0.8".
TOP="$WORK/Omega Hive${RELEASE_NAME:+ ${RELEASE_NAME#mac-hive-}}"
CODE="$TOP/omegahive"
mkdir -p "$CODE"

# The code at exactly one commit, with its executable bits, plus that commit's id for anyone checking a download.
git -C "$REPO" archive --format=tar "$REV" | tar -x -C "$CODE"
git -C "$REPO" rev-parse "$REV" > "$CODE/RELEASE_COMMIT"
# The release's number (mac-hive-v0.10 gives 0.10): install/macos/update.py compares it with a signed statement's to
# offer a newer build, and publish-update.py refuses to sign a statement whose version differs from it.
case ${RELEASE_NAME:-} in
  mac-hive-v[0-9]*) echo "${RELEASE_NAME#mac-hive-v}" > "$CODE/RELEASE_VERSION" ;;
esac
# Where the feedback area of every hive that installs this release sends reports (hive/core/feedback.py configured),
# below the hive's own HIVE_FEEDBACK_TO; a value the hive could not use stops the build here.
if [ -n "${FEEDBACK_TO:-}" ]; then
  (cd "$CODE" && python3 -B -c 'import sys
from hive.core.feedback import destination
to = destination(sys.argv[1])
sys.exit("FEEDBACK_TO: " + to["reason"] if to["kind"] == "invalid" else 0)' "$FEEDBACK_TO") || exit 2
  printf '%s\n' "$FEEDBACK_TO" > "$CODE/FEEDBACK_TO"
fi

# What the public zip leaves out goes before anything is built from the tree, so no closed part reaches the UI bundle.
python3 -B "$CODE/install/public_release.py" prune "$CODE"

# What a hive trusts comes from its build, never from the repository: the channel, its feed and its keys are this
# build's inputs, written through publish-update.py so a file no hive could use stops the build here.
TRUST="$CODE/install/macos/update-trust.json"
[ ! -e "$TRUST" ] || { echo "the revision carries its own update-trust.json; the build writes it" >&2; exit 1; }
write_trust() {
  set --
  for key in $UPDATE_PUBKEY; do set -- "$@" --pubkey "$key"; done
  for key in ${UPDATE_NEXT_PUBKEYS:-}; do set -- "$@" --next-pubkey "$key"; done
  python3 -B "$CODE/install/macos/publish-update.py" trust --channel "${UPDATE_CHANNEL:-release}" \
    --feed "${UPDATE_FEED:-$DEFAULT_FEED}" "$@" --out "$TRUST"
}
if [ -n "${UPDATE_TRUST:-}" ]; then
  python3 -B "$CODE/install/macos/publish-update.py" trust --from "$UPDATE_TRUST" --out "$TRUST"
else
  write_trust
fi
CHANNEL=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["channel"])' "$TRUST")

if [ -n "${UI_DIST_DIR:-}" ]; then
  test -f "$UI_DIST_DIR/index.html" || { echo "UI_DIST_DIR $UI_DIST_DIR holds no index.html" >&2; exit 1; }
  cp -R "$UI_DIST_DIR" "$CODE/hive/ui/dist"
else
  # The UI's imports from outside hive/ui (third_party/Omega's lib_nal and lib_pln, which an archive never carries, and
  # hive/spaces' lib_hive) are put in place by install/ui_pins.py's rule: each from its pinned copy or the release's
  # Omega core bundle, and only with its pinned sha256.
  python3 -I "$CODE/install/ui_pins.py" "$CODE" "$WORK" "$@"
  # The hive serves hive/ui/dist; building it here spares every Mac the Node install and build.
  (cd "$CODE/hive/ui" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules)
fi
test -f "$CODE/hive/ui/dist/index.html" || { echo "UI build left no dist/index.html" >&2; exit 1; }
# The Omega files pinned above serve only that build: on the Mac the core comes from setup_core.py (omegahive.sh core,
# from the release's bundle), which refuses a third_party/Omega holding files but no checkout.
[ -d "$CODE/third_party/Omega/.git" ] || rm -rf "$CODE/third_party/Omega"

# Prebuilt files ride in the zip untracked, each with its checksum file, which the installer checks before unpacking;
# a missing or wrong one stops the release.
for f in "$@"; do
  test -f "$f" || { echo "no prebuilt file $f" >&2; exit 1; }
  test -f "$f.sha256" || { echo "no checksum file $f.sha256" >&2; exit 1; }
  (cd "$(dirname -- "$f")" && { shasum -a 256 -c "$(basename -- "$f").sha256" 2>/dev/null || sha256sum -c "$(basename -- "$f").sha256"; }) >/dev/null \
    || { echo "$f does not match its checksum file" >&2; exit 1; }
  cp "$f" "$f.sha256" "$CODE/install/macos/"
done

test -x "$CODE/$INSTALLER_IN_REPO" || { echo "no executable installer at $INSTALLER_IN_REPO" >&2; exit 1; }

# The one file a person double-clicks, at the top of the folder the zip unpacks to. macOS keeps Terminal out of the
# Trash and of folders it protects, so the wrapper says what to do instead.
case $CHANNEL in test) KIND="test build " ;; *) KIND= ;; esac
cat > "$TOP/Install Omega.command" <<EOF
#!/bin/sh
here=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
inner="\$here/omegahive/$INSTALLER_IN_REPO"
releases=$RELEASES_URL
# The build's name comes first, so a screenshot shows which build ran.
echo "Omega hive for Mac, ${KIND}${RELEASE_NAME:-unnamed}"
stop() {
  echo "\$1"
  echo "Download the newest Mac build from \$releases, unzip it in Downloads and double-click Install Omega there."
  printf "Press Return to close this window. "
  read _answer || true
  exit 1
}
case "\$here" in
  "\$HOME/.Trash"*|*/.Trash/*) stop "This copy of the installer is in the Trash, which macOS doesn't let Terminal open." ;;
esac
[ -r "\$inner" ] || stop "macOS isn't letting Terminal read this folder: \$here"
exec "\$inner" "\$@"
EOF
chmod 755 "$TOP/Install Omega.command"

rm -f "$OUT_ABS"
(cd "$WORK" && zip -qry "$OUT_ABS" "$(basename -- "$TOP")")
# The finished zip is what gets published, so the rule is checked on it, prebuilt files included.
python3 -B "$CODE/install/public_release.py" check "$OUT_ABS" || { rm -f "$OUT_ABS"; exit 1; }
shasum -a 256 "$OUT_ABS" 2>/dev/null || sha256sum "$OUT_ABS"
