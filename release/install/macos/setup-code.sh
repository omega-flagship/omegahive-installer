#!/bin/bash
# Purpose: give the own hive in $OMEGAHIVE_HOME the Code service its Create · Code minds build small apps through, all
# inside the hive's folder, on a port of its own: the published omegacode release (hive/core/code.py
# PUBLISHED_SERVICE_RELEASE) unpacked once from the release's tarball and checked, then made the portable release the
# hive also accepts (PORTABLE_SERVICE_RELEASE) by the checked port and proposal-test patches, checked again and left
# read-only; one disposable git repository the minds build in; a private config naming the service's port and an
# operator token; the seatbelt profile the service and every command it runs are confined to; and the hive.env lines
# that select that release, name the service's config and its launchd plist (in run/, where the hive's release guard is
# told to read it), and turn on proposal-test and copy-apply claims. omegahive.sh writes, starts and stops the job.
#
#   OMEGAHIVE_HOME=<hive folder> setup-code.sh <omegacode release tarball>
#
# Re-running keeps the release, repository, token and the service's state, and rewrites the config, profile and lines.
set -euo pipefail

OH=${OMEGAHIVE_HOME:?OMEGAHIVE_HOME names the hive folder}
TARBALL=${1:?usage: setup-code.sh <omegacode release tarball>}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TOOLCHAIN=$OH/toolchain/envs/hive
PY=$OH/venv/bin/python
CODE=$OH/code
REPO=$OH/repos/small-app
HIVE_PORT=$(sed -n 's/^HIVE_PORT=//p' "$OH/hive.env" 2>/dev/null | tail -n 1)
[ -x "$PY" ] && [ -n "$HIVE_PORT" ] || { echo "no finished own hive in $OH" >&2; exit 1; }
. "$(dirname "$0")/pins.sh"
umask 077
hive_py() { (cd "$OH/app" && "$PY" -I -c "import sys; sys.path.insert(0, '.'); $1" "${@:2}"); }

# The published release the tarball holds and the portable one its patch makes, read from the hive itself so the two
# cannot disagree. The guard pins a release by its folder name and checks the contents with Code._module_digest.
PUBLISHED=$(hive_py 'from hive.core.code import PUBLISHED_SERVICE_RELEASE as r; print(r)')
REL=$(hive_py 'from hive.core.code import PORTABLE_SERVICE_RELEASE as r; print(r)')
digest() { hive_py 'import pathlib; from hive.core.code import Code; print(Code._module_digest(pathlib.Path(sys.argv[1])))' "$1"; }
RELEASE=$CODE/releases/$REL
mkdir -p "$CODE/releases" "$CODE/state" "$CODE/wd" "$CODE/tmp" "$CODE/logs" "$CODE/home" "$OH/repos"
chmod 700 "$CODE" "$CODE/state" "$CODE/wd" "$CODE/tmp" "$CODE/logs" "$CODE/home"
if [ ! -f "$RELEASE/omegacode/__init__.py" ]; then
  rm -rf "$RELEASE.new" && mkdir -p "$RELEASE.new"
  # From stdin, so tar copies no quarantine from the downloaded tarball; cleared anyway
  # before the files are made read-only, after which their attributes cannot change. Only the files: read-only
  # folders made rm -rf of the whole hive folder fail on the Mac mini, and the sandbox already keeps the service out.
  tar -xzf - -C "$RELEASE.new" < "$TARBALL"
  [ "$(digest "$RELEASE.new/omegacode")" = "$PUBLISHED" ] \
    || { echo "the Code release in $TARBALL is not $PUBLISHED: download the release again" >&2; exit 1; }
  # Preserve the published routes while binding each hive's port and its fixed-envelope test contract.
  for adapter in omegacode-port.patch omegacode-proposal-tests.patch; do
    patch -p1 -s -d "$RELEASE.new" -i "$SCRIPT_DIR/$adapter"
  done
  xattr -dr com.apple.quarantine "$RELEASE.new" 2>/dev/null || true
  find "$RELEASE.new/omegacode" -type f -exec chmod a-w {} +
  mv "$RELEASE.new" "$RELEASE"
fi
DIGEST=$(digest "$RELEASE/omegacode")
[ "$DIGEST" = "$REL" ] || { echo "the Code release's contents give $DIGEST, not $REL: download the release again" >&2; exit 1; }
# Releases an older setup unpacked here go: only the selected one runs.
for old in "$CODE/releases"/*; do [ "$old" = "$RELEASE" ] || rm -rf "$old"; done
# The service's port: the hive's own plus pins.sh's CODE_PORT_OFFSET (8700 gives 8724, the published release's port),
# so two own hives on one Mac, whose ports differ by tens, never share one. Re-runs keep it, as they keep the hive's.
CODE_PORT=$((HIVE_PORT + CODE_PORT_OFFSET))

# One disposable small-app repository with a real project check the controller can run on its candidate.
if [ ! -d "$REPO/.git" ]; then
  mkdir -p "$REPO"
  printf '%s\n' "# Small app" "" "A repository your hive's minds build small web apps in: index.html loads style.css and app.js," \
    "and app.js draws into <main id=\"app\">. Nothing here is kept." > "$REPO/README.md"
  cat > "$REPO/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Small app</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main id="app"></main>
  <script type="module" src="./app.js"></script>
</body>
</html>
HTML
  printf '%s\n' '// The app the hive builds lives here. It draws into <main id="app"> in index.html.' \
    'const app = document.getElementById("app");' \
    'app.textContent = "Nothing here yet: ask the hive to build something.";' > "$REPO/app.js"
  printf '%s\n' 'body {' '  font-family: system-ui, sans-serif;' '  margin: 2rem;' '}' > "$REPO/style.css"
  cp "$SCRIPT_DIR/check-app.py" "$REPO/check_app.py"
  "$TOOLCHAIN/bin/git" -C "$REPO" init -q -b main
  "$TOOLCHAIN/bin/git" -C "$REPO" add README.md index.html app.js style.css check_app.py
  "$TOOLCHAIN/bin/git" -C "$REPO" -c user.name="Your hive" -c user.email=hive@localhost commit -qm "Start the small app"
fi
# Add the installer-owned check on upgrades, preserving existing app files and unrelated staged work.
"$PY" -I - "$REPO/check_app.py" "$SCRIPT_DIR/check-app.py" <<'PY'
import hashlib, pathlib, shutil, sys
target, source = map(pathlib.Path, sys.argv[1:])
if target.exists() and target.read_bytes() != source.read_bytes():
    if hashlib.sha256(target.read_bytes()).hexdigest() != '0143f44b1eb8211d18f08f63c4068a4f9cc353e1e499233303256dee3f5ad962':
        raise SystemExit('check_app.py has personal changes; restore the installer check before upgrading')
if not target.exists() or target.read_bytes() != source.read_bytes():
    shutil.copyfile(source, target)
PY
if ! "$TOOLCHAIN/bin/git" -C "$REPO" cat-file -e HEAD:check_app.py 2>/dev/null; then
  "$TOOLCHAIN/bin/git" -C "$REPO" add -- check_app.py
  "$TOOLCHAIN/bin/git" -C "$REPO" -c user.name="Your hive" -c user.email=hive@localhost \
    commit --only -qm "Add the small app project check" -- check_app.py
elif ! "$TOOLCHAIN/bin/git" -C "$REPO" diff --quiet HEAD -- check_app.py; then
  "$TOOLCHAIN/bin/git" -C "$REPO" add -- check_app.py
  "$TOOLCHAIN/bin/git" -C "$REPO" -c user.name="Your hive" -c user.email=hive@localhost \
    commit --only -qm "Update the small app project check" -- check_app.py
fi

# The operator token is made once and never printed; the config is the service's whole view of this hive.
[ -f "$CODE/operator-token" ] || "$PY" -I -c 'import secrets, sys; open(sys.argv[1], "x").write(secrets.token_urlsafe(48))' \
  "$CODE/operator-token"
chmod 600 "$CODE/operator-token"
"$PY" -I "$SCRIPT_DIR/code-runtime.py" prepare "$OH" "$CODE" "$REPO" "$HIVE_PORT" "$CODE_PORT" \
  "$REL" "$OH/run/family.omegahive.omegacode.plist"
echo "Create's Code service is set up in $CODE, building in $REPO."
