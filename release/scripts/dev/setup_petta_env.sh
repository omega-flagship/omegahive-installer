#!/usr/bin/env bash
# Build the pinned PeTTa toolchain for OmegaHive / OmegaClaw-Core development and CI, on macOS or Linux.
#
# The pins mirror deploy/setup_runtime.sh (the Linux server install); change them in both places together:
#   Python 3.12 (the interpreter janus is built against and the hive runs on)
#   SWI-Prolog 10.1.14 from swipl-devel, built against that same Python
#   PeTTa at commit ae66fa8
#   janus-swi 1.5.3
#
# SWI-Prolog goes into a private prefix (default ~/swipl-patched), never /usr/local, so it does not shadow a system or
# Homebrew swipl. Homebrew's swipl loads but its Prolog->Python bridge fails ("janus:py_call/4" not found), so every
# hive test would error with "PeTTa failed to start". An existing swipl in the prefix is reused only when it is the
# pinned version and passes the bridge check.
#
# Usage:
#   scripts/dev/setup_petta_env.sh [--prefix DIR] [--petta DIR] [--python PYTHON] [--runtime DIR]
# Defaults: --prefix ~/swipl-patched, --petta ~/PeTTa, --python: $VIRTUAL_ENV/bin/python, else python3.12,
#           --runtime ~/.omegadots/runtime (a run.sh for tests/run_metta_smokes.py).
# Then:
#   export PATH="$HOME/swipl-patched/bin:$PATH" PETTA_PATH="$HOME/PeTTa"
#   python -m pytest -q hive/tests
#
# Build prerequisites: git, cmake, ninja, a C compiler, and the headers for openssl, libarchive, pcre2, libyaml,
# zlib, libedit, gmp. macOS: `brew install cmake ninja openssl@3 libarchive pcre2 libyaml gmp`.
# Debian/Ubuntu: `apt-get install cmake ninja-build libssl-dev libarchive-dev libpcre2-dev libyaml-dev zlib1g-dev
# libedit-dev libgmp-dev`.
set -euo pipefail

SWIPL_REPO="${SWIPL_REPO:-https://github.com/SWI-Prolog/swipl-devel.git}"
SWIPL_TAG="${SWIPL_TAG:-V10.1.14}"
SWIPL_VERSION="${SWIPL_TAG#V}"
PETTA_REPO="${PETTA_REPO:-https://github.com/trueagi-io/PeTTa.git}"
PETTA_REF="${PETTA_REF:-ae66fa8}"
JANUS_VERSION="${JANUS_VERSION:-1.5.3}"
SWIPL_MODULES="clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl"

PREFIX="${SWIPL_PREFIX:-$HOME/swipl-patched}"
PETTA_DIR="${PETTA_DIR:-$HOME/PeTTa}"
RUNTIME_DIR="${OMEGACLAW_ROOT:-$HOME/.omegadots/runtime}"
PYTHON="${PYTHON:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --petta) PETTA_DIR="$2"; shift 2 ;;
    --python) PYTHON="$2"; shift 2 ;;
    --runtime) RUNTIME_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$PYTHON" ]; then
  if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then PYTHON="$VIRTUAL_ENV/bin/python"
  else PYTHON="$(command -v python3.12 || true)"; fi
fi
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || { echo "Python 3.12 not found; pass --python /path/to/python3.12" >&2; exit 1; }
PYVER="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
[ "$PYVER" = "3.12" ] || { echo "$PYTHON is Python $PYVER; OmegaHive needs 3.12" >&2; exit 1; }
PYBASE="$("$PYTHON" -c 'import sys; print(sys.base_prefix)')"
PYEXE="$("$PYTHON" -c 'import sys, pathlib; b = pathlib.Path(sys.base_prefix) / "bin"; print(next((str(p) for p in (b / "python3.12", b / "python3") if p.exists()), sys.executable))')"
SWIPL="$PREFIX/bin/swipl"
# libpython of an interpreter outside the loader path (uv, setup-python, pyenv) must be findable by library(janus).
export LD_LIBRARY_PATH="$PYBASE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH="$PYBASE/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"

bridge_ok() {   # the pinned version, and Prolog->Python through library(janus) gives exactly 42
  [ -x "$SWIPL" ] || return 1
  [ "$("$SWIPL" --version 2>/dev/null | awk '{print $3}')" = "$SWIPL_VERSION" ] || return 1
  [ "$("$SWIPL" -g 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt' 2>/dev/null)" = "42" ]
}

if bridge_ok; then
  echo "swipl: reusing $SWIPL ($SWIPL_VERSION, janus bridge OK)"
else
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/swipl-build.XXXXXXXX")"
  trap 'rm -rf "$BUILD_DIR"' EXIT
  echo "Building SWI-Prolog $SWIPL_TAG ($SWIPL_REPO) against $PYEXE into $PREFIX ..."
  git clone -q --depth 1 --branch "$SWIPL_TAG" "$SWIPL_REPO" "$BUILD_DIR/src"
  (cd "$BUILD_DIR/src" && for m in $SWIPL_MODULES; do echo "packages/$m"; done | xargs git submodule update --init --depth 1 -q)
  mkdir -p "$BUILD_DIR/src/build"
  EXTRA=()
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    EXTRA+=("-DCMAKE_PREFIX_PATH=$(brew --prefix openssl@3 2>/dev/null || true);$(brew --prefix libarchive 2>/dev/null || true);$(brew --prefix)")
  fi
  # janus (packages/swipy) looks for "Python", not "Python3": without the -DPython_ flags it silently binds to another
  # Python, or is skipped. PeTTa loads library(janus), so MeTTa cannot run without it.
  (cd "$BUILD_DIR/src/build" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF -DSWIPL_PACKAGES_QT=OFF \
      -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX="$PREFIX" \
      -DPython3_EXECUTABLE="$PYEXE" -DPython3_ROOT_DIR="$PYBASE" \
      -DPython_EXECUTABLE="$PYEXE" -DPython_ROOT_DIR="$PYBASE" ${EXTRA[@]+"${EXTRA[@]}"} .. > ../cmake.log \
    && grep -q "^_Python_INCLUDE_DIR:INTERNAL=$PYBASE" CMakeCache.txt) \
    || { echo "janus would not build against $PYBASE (logs kept in $BUILD_DIR/src)" >&2; trap - EXIT; exit 1; }
  (cd "$BUILD_DIR/src/build" && ninja > ../ninja.log && test -f packages/swipy/janus.so && ninja install > ../install.log) \
    || { echo "SWI-Prolog build failed (logs in $BUILD_DIR/src)" >&2; trap - EXIT; exit 1; }
  bridge_ok || { echo "built $SWIPL, but it is not $SWIPL_VERSION or its janus bridge does not answer 42" >&2; exit 1; }
  echo "swipl: built $SWIPL ($SWIPL_VERSION, janus bridge OK)"
fi

# janus-swi into the same Python, compiled against the swipl just checked.
PATH="$PREFIX/bin:$PATH" "$PYTHON" -m pip install -q "janus-swi==$JANUS_VERSION"
PATH="$PREFIX/bin:$PATH" "$PYTHON" -c 'import janus_swi as j; r = j.query_once("X is 1+1"); assert r.get("X") == 2, r' \
  || { echo "janus-swi $JANUS_VERSION: Python->Prolog bridge failed" >&2; exit 1; }

# PeTTa at the pin.
if [ ! -d "$PETTA_DIR/.git" ]; then git clone -q "$PETTA_REPO" "$PETTA_DIR"; fi
git -C "$PETTA_DIR" cat-file -e "$PETTA_REF^{commit}" 2>/dev/null || git -C "$PETTA_DIR" fetch -q origin
git -C "$PETTA_DIR" checkout -q "$PETTA_REF"

# A MeTTa program through PeTTa: the last output line, without colour codes, must be exactly 42.
CHECK="$(mktemp -d "${TMPDIR:-/tmp}/petta-check.XXXXXXXX")"
printf '(= (f $x) (+ $x 1))\n!(f 41)\n' > "$CHECK/check.metta"
OUT="$(cd "$CHECK" && PATH="$PREFIX/bin:$PATH" sh "$PETTA_DIR/run.sh" "$CHECK/check.metta" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -1)"
rm -rf "$CHECK"
[ "$OUT" = "42" ] || { echo "PeTTa check failed: last line was '$OUT'" >&2; exit 1; }

# The smoke runtime (tests/run_metta_smokes.py): it git-imports OmegaClaw-Core from ./repos, so link this checkout.
mkdir -p "$RUNTIME_DIR/repos"
CORE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$RUNTIME_DIR/repos/OmegaClaw-Core"
ln -sfn "$CORE_DIR" "$RUNTIME_DIR/repos/OmegaClaw-Core"
if [ ! -d "$RUNTIME_DIR/repos/petta_lib_chromadb" ]; then
  git clone -q --depth 1 https://github.com/patham9/petta_lib_chromadb.git "$RUNTIME_DIR/repos/petta_lib_chromadb"
fi
cat > "$RUNTIME_DIR/run.sh" <<RUN
#!/bin/sh
export LANG=\${LANG:-C.UTF-8}
export PATH="$PREFIX/bin:\$PATH"
exec sh "$PETTA_DIR/run.sh" "\$@"
RUN
chmod +x "$RUNTIME_DIR/run.sh"

echo "PETTA-READY swipl=$SWIPL_VERSION petta=$PETTA_REF janus-swi=$JANUS_VERSION python=$PYEXE"
echo "  export PATH=\"$PREFIX/bin:\$PATH\" PETTA_PATH=\"$PETTA_DIR\""
echo "  smoke runtime: OMEGACLAW_ROOT=$RUNTIME_DIR"
