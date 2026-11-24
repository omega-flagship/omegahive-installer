#!/bin/bash
# Purpose: prove a built SWI-Prolog bundle and janus_swi wheel work where a tester's Mac, or the Windows installer's
# Linux distro, would put them: unpack into a new folder with a new HOME and a bare environment, then check the
# layout, swipl's version and home, Prolog calling Python, Python calling Prolog through the wheel, and PeTTa running
# a MeTTa program that also calls Python, and for the Linux bundle Prolog calling Python where the Linux kit keeps
# its Python too. The tarball's name says which bundle it is, the arm64 Mac's (build-swipl-bundle.sh) or Linux
# x86_64's (build-swipl-bundle-linux.sh).
#
# Usage: install/macos/check-swipl-bundle.sh TARBALL WHEEL PYTHON_PREFIX [WORKDIR]
#
#   PYTHON_PREFIX is a conda-forge Python 3.12 environment; it stands where the installer puts the toolchain,
#   $OH/toolchain/envs/hive. WORKDIR (default: a new folder under ~) becomes $OH's parent and the new HOME.
#   PeTTa is the commit pins.sh names, fetched from GitHub's codeload and kept only if its sha256 matches the pin.
# Prints CHECK-PASSED as its last line when every check holds; any failure exits non-zero naming the check.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/pins.sh"

TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
WHEEL=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
PYPREFIX=$(cd "$3" && pwd)
WORK=${4:-$(mktemp -d "$HOME/swipl-check.XXXXXX")}
# Absolute, since the checks run from inside it: a relative WORKDIR left PATH naming swipl relatively, and after the
# cd below the check said "env: swipl: No such file or directory".
mkdir -p "$WORK" && WORK=$(cd "$WORK" && pwd)
# Where each bundle keeps its real executable and its home, relative to swipl/.
case "$(basename "$TARBALL")" in
  swipl-*-macos-arm64.tar.gz) PLAT=macos-arm64; ARCH=arm64-darwin; REAL=SWI-Prolog.app/Contents/MacOS/swipl
                              HOME_REL=SWI-Prolog.app/Contents/lib/swipl ;;
  swipl-*-linux-x86_64.tar.gz) PLAT=linux-x86_64; ARCH=x86_64-linux; REAL=bin/swipl; HOME_REL=lib/swipl ;;
  *) echo "CHECK-FAILED: $(basename "$TARBALL") names no bundle this check knows" >&2; exit 1 ;;
esac
VERSION=$(basename "$TARBALL" | sed -E "s/^swipl-([0-9.]+)-$PLAT\.tar\.gz\$/\1/")
PYVER=$("$PYPREFIX/bin/python3" -I -c 'import sys; print("%d.%d" % sys.version_info[:2])')

die() { printf 'CHECK-FAILED: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

OH=$WORK/OmegaHive
mkdir -p "$OH/toolchain/envs" "$WORK/home" "$WORK/tmp"
# PYTHON_PREFIX may already be $OH/toolchain/envs/hive, made there as the installer makes it.
[ "$PYPREFIX" = "$OH/toolchain/envs/hive" ] || ln -sfn "$PYPREFIX" "$OH/toolchain/envs/hive"
# Read through a pipe, tar cannot copy a downloaded archive's quarantine onto the files.
tar -xzf - -C "$OH" < "$TARBALL"
if xattr -r "$OH/swipl" 2>/dev/null | grep -q com.apple.quarantine; then die "unpacked files carry com.apple.quarantine"; fi
# The real executable is the one whose grandparent holds everything swipl reads; on a Mac bin/swipl links to it.
[ -f "$OH/swipl/$REAL" ] && [ ! -L "$OH/swipl/$REAL" ] && [ -x "$OH/swipl/$REAL" ] || die "$REAL is not the real executable"
case $PLAT in
  macos-arm64) [ "$(readlink "$OH/swipl/bin/swipl")" = ../SWI-Prolog.app/Contents/MacOS/swipl ] || die "bin/swipl is not the agreed link" ;;
  linux-x86_64) [ "$(cat "$OH/swipl/swipl.home")" = lib/swipl ] || die "swipl.home does not name lib/swipl"
                [ "$(readlink "$OH/swipl/lib/swipl/bin/$ARCH/swipl")" = ../../../../bin/swipl ] \
                  || die "lib/swipl/bin/$ARCH/swipl is not the agreed link to bin/swipl" ;;
esac
ok "unpacked into $OH/swipl, no quarantine, agreed layout"

# A bare environment: a new HOME (no ~/.config/swi-prolog), only this folder's tools and macOS's on PATH.
BARE=(env -i "HOME=$WORK/home" "TMPDIR=$WORK/tmp" "LANG=en_US.UTF-8" "PATH=$OH/swipl/bin:$OH/venv/bin:/usr/bin:/bin")
cd "$WORK/tmp"

V=$("${BARE[@]}" swipl --version)
case "$V" in "SWI-Prolog version $VERSION for $ARCH") ;; *) die "swipl --version printed: $V";; esac
ok "$V"

HOMEDIR=$("${BARE[@]}" swipl --home)
[ "$HOMEDIR" = "$OH/swipl/$HOME_REL" ] || die "swipl found its home at $HOMEDIR"
ok "home $HOMEDIR"

R=$("${BARE[@]}" swipl -g 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt' 2>&1 | tail -1)
[ "$R" = 42 ] || die "Prolog to Python: py_call(operator:add(20, 22)) printed: $R"
P=$("${BARE[@]}" swipl -g 'use_module(library(janus)), py_call(sys:version, V), split_string(V, " ", "", [N|_]), writeln(N), halt' 2>&1 | tail -1)
case "$P" in "$PYVER".*) ;; *) die "janus runs Python $P, not $PYVER";; esac
ok "Prolog to Python: py_call(operator:add(20, 22)) = 42 in Python $P"

# The Linux kit keeps its Python in python/ beside swipl/ and has no toolchain/ (its deploy/linux/install.py), and a
# mind's sandbox there shows only the folders it may read, python/ among them; janus.so names that place second, so
# Prolog must call Python in that layout too.
if [ "$PLAT" = linux-x86_64 ]; then
  KIT=$WORK/kit-layout
  mkdir -p "$KIT" && tar -xzf - -C "$KIT" < "$TARBALL" && ln -sfn "$PYPREFIX" "$KIT/python"
  R=$(env -i "HOME=$WORK/home" "TMPDIR=$WORK/tmp" "LANG=en_US.UTF-8" "PATH=$KIT/swipl/bin:/usr/bin:/bin" \
    swipl -g 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt' 2>&1 | tail -1)
  [ "$R" = 42 ] || die "Prolog to Python with python/ beside swipl/ and no toolchain/: py_call(operator:add(20, 22)) printed: $R"
  ok "Prolog to Python with python/ beside swipl/ and no toolchain/, as the Linux kit lays it out: 42"
fi

"${BARE[@]}" "$PYPREFIX/bin/python$PYVER" -m venv "$OH/venv"
# --no-index: the wheel installs from the file alone, nothing compiles and nothing downloads.
"${BARE[@]}" "$OH/venv/bin/python" -m pip install -q --no-index --disable-pip-version-check "$WHEEL" || die "pip install of $WHEEL failed"
# pip writes the files itself, so a downloaded wheel's quarantine stays on the .whl and off what macOS will load.
if xattr -r "$OH/venv/lib/python$PYVER/site-packages/janus_swi" 2>/dev/null | grep -q com.apple.quarantine; then
  die "pip-installed janus_swi files carry com.apple.quarantine"
fi
R=$("${BARE[@]}" "VIRTUAL_ENV=$OH/venv" "$OH/venv/bin/python" -c 'import janus_swi as j; r = j.query_once("X is 1+1"); assert r.get("X") == 2, r; print(r["X"])')
[ "$R" = 2 ] || die "Python to Prolog: janus_swi.query_once printed: $R"
ok "Python to Prolog: janus_swi.query_once('X is 1+1') = 2 from $(basename "$WHEEL")"

pin_fetch "$(petta_url)" "$PETTA_SHA256" "$WORK/petta.tar.gz" || die "PeTTa $PETTA_COMMIT did not match its pin"
mkdir -p "$OH/PeTTa" && tar -xzf - -C "$OH/PeTTa" --strip-components 1 < "$WORK/petta.tar.gz"
printf '%s\n' '!(+ 40 2)' '!(py-call (math.sqrt 1764))' > "$WORK/tmp/check.metta"
OUT=$("${BARE[@]}" "VIRTUAL_ENV=$OH/venv" sh "$OH/PeTTa/run.sh" "$WORK/tmp/check.metta" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
printf '%s\n' "$OUT" | grep -qx 42 || die "PeTTa did not print 42: $OUT"
printf '%s\n' "$OUT" | grep -qx 42.0 || die "PeTTa's py-call did not print 42.0: $OUT"
ok "PeTTa $PETTA_COMMIT: !(+ 40 2) = 42 and !(py-call (math.sqrt 1764)) = 42.0"
echo CHECK-PASSED
