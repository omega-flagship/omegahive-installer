#!/usr/bin/env bash
# Purpose: build and verify the pinned PeTTa CI runtime at user-owned prefixes, reusing matching cached builds.
# Usage: setup_petta_env.sh [--prefix DIR] [--petta DIR] [--python EXE] [--runtime DIR]
# The legacy positional runtime directory remains accepted. Python 3.12 and the build prerequisites in ci.yml are required.
set -euo pipefail
CORE_SETUP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SWIPL_TAG="${SWIPL_TAG:-V10.1.14}"
PETTA_REF="${PETTA_REF:-ae66fa8e41dcd5539d614706bd4e5cfb34f9608d}"
JANUS_VERSION="${JANUS_VERSION:-1.5.3}"
PREFIX="${SWIPL_PREFIX:-$HOME/swipl-patched}"
PETTA_DIR="${PETTA_DIR:-$HOME/PeTTa}"
RUNTIME_DIR="${OMEGACLAW_ROOT:-$HOME/.omegadots/runtime}"
PY="${PYTHON:-python3}"
positional=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--petta|--python|--runtime)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in --prefix) PREFIX=$2;; --petta) PETTA_DIR=$2;; --python) PY=$2;; --runtime) RUNTIME_DIR=$2;; esac
      shift 2;;
    -h|--help) sed -n '2,4p' "$0"; exit 0;;
    --*) echo "unknown option: $1" >&2; exit 2;;
    *) [ "$positional" = 0 ] || { echo "only one positional runtime directory is accepted" >&2; exit 2; }
      RUNTIME_DIR=$1; positional=1; shift;;
  esac
done

PY=$(command -v "$PY") || { echo "selected Python was not found" >&2; exit 2; }
PY=$("$PY" -I -c 'import os,sys; print(os.path.abspath(sys.executable))')
"$PY" -I -c 'import sys; sys.version_info[:2] == (3, 12) or sys.exit("Python 3.12 is required")'
PYBASE=$("$PY" -I -c 'import sys; print(sys.base_prefix)')
PYVERSION=$("$PY" -I -c 'import platform; print(platform.python_version())')
PYINCLUDE=$("$PY" -I -c 'import sysconfig; print(sysconfig.get_path("include"))')
[ -f "$PYINCLUDE/Python.h" ] || { echo "the selected Python needs its headers" >&2; exit 2; }
mkdir -p "$PREFIX" "$RUNTIME_DIR"
PREFIX=$(cd "$PREFIX" && pwd -P)
RUNTIME_DIR=$(cd "$RUNTIME_DIR" && pwd -P)
PATH="$PREFIX/bin:$(dirname "$PY"):$PATH"
export LD_LIBRARY_PATH="$PYBASE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
VIRTUAL_ENV=$("$PY" -I -c 'import sys; print(sys.prefix if sys.prefix != sys.base_prefix else "")')
export PATH VIRTUAL_ENV
export OMEGACLAW_RUNTIME_CACHE="${OMEGACLAW_RUNTIME_CACHE:-$RUNTIME_DIR/cache/omega-runtime}"
unset CC CXX CPP CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CPATH LIBRARY_PATH SDKROOT CMAKE_TOOLCHAIN_FILE
CC=$(command -v cc) && CXX=$(command -v c++) || { echo "the build needs a C and a C++ compiler on PATH as cc and c++" >&2; exit 2; }
export CC CXX
BUILD_ROOT="${SWIPL_BUILD_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$BUILD_ROOT"
INPUTS=$("$PY" -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$SWIPL_TAG" "$PREFIX" "$PY" "$PYBASE" "$PYVERSION")
STAMP=$PREFIX/.omegahive-build-inputs.json

# The CI cache is a candidate, not proof: it must also load the selected embedded Python.
swipl_version_matches() {
  local version
  version=$("$PREFIX/bin/swipl" --version) || return 1
  [[ "$version" == "SWI-Prolog version ${SWIPL_TAG#V} "* ]]
}

swipl_matches() {
  [ -x "$PREFIX/bin/swipl" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$INPUTS" ] || return 1
  swipl_version_matches || return 1
  local base
  base=$("$PREFIX/bin/swipl" -q -g 'use_module(library(janus)),py_call(sys:base_prefix,B),write(B),nl,halt' 2>/dev/null) || return 1
  [ "$base" = "$PYBASE" ]
}

run_logged() {
  local log=$1 rc; shift
  "$@" > "$log" 2>&1 || { rc=$?; echo "failed; log: $log" >&2; tail -n 35 "$log" >&2; return "$rc"; }
}

rebuilt=0
if swipl_matches; then
  echo "Reusing SWI-Prolog $SWIPL_TAG at $PREFIX (Python $PYVERSION)."
else
  rebuilt=1
  build=$(mktemp -d "$BUILD_ROOT/swipl.XXXXXXXX")
  trap 'rm -rf "$build"' EXIT
  echo "Building SWI-Prolog $SWIPL_TAG at $PREFIX against $PYBASE."
  git clone -q --depth 1 --branch "$SWIPL_TAG" https://github.com/SWI-Prolog/swipl-devel.git "$build/src"
  modules=(clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl)
  paths=(); for module in "${modules[@]}"; do paths+=("packages/$module"); done
  git -C "$build/src" submodule update --init --depth 1 -q -- "${paths[@]}"
  # CMake must not silently select the runner's system Python or inherit a stale CC/CFLAGS setting.
  run_logged "$build.configure.log" env -i HOME="$HOME" PATH="$PATH" LD_LIBRARY_PATH="$LD_LIBRARY_PATH" \
    CMAKE_PREFIX_PATH="${CMAKE_PREFIX_PATH:-}" PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-}" \
    cmake -S "$build/src" -B "$build/out" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
    -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF \
    -DSWIPL_PACKAGES_QT=OFF -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DPython_EXECUTABLE="$PY" -DPython_ROOT_DIR="$PYBASE" -DPython_INCLUDE_DIR="$PYINCLUDE" -DPython_FIND_STATIC_LIBS=OFF \
    -DPython3_EXECUTABLE="$PY" -DPython3_ROOT_DIR="$PYBASE"
  run_logged "$build.build.log" cmake --build "$build/out" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-$(getconf _NPROCESSORS_ONLN)}"
  [ -f "$build/out/packages/swipy/janus.so" ] || { echo "the selected Python's Janus library was not built" >&2; exit 1; }
  run_logged "$build.install.log" cmake --install "$build/out"
  echo "Built SWI commit $(git -C "$build/src" rev-parse HEAD); logs: $build.*.log"
fi
swipl_version_matches || { echo "SWI-Prolog does not match $SWIPL_TAG" >&2; exit 1; }
[ "$("$PREFIX/bin/swipl" -q -g 'use_module(library(janus)),py_call(sys:base_prefix,B),write(B),nl,halt')" = "$PYBASE" ]
printf '%s\n' "$INPUTS" > "$STAMP"

if [ ! -e "$PETTA_DIR/.git" ]; then
  [ ! -e "$PETTA_DIR" ] || [ -z "$(ls -A "$PETTA_DIR")" ] || { echo "$PETTA_DIR is not an empty directory or a PeTTa git checkout" >&2; exit 2; }
  git clone -q --filter=blob:none https://github.com/trueagi-io/PeTTa.git "$PETTA_DIR"
fi
PETTA_DIR=$(cd "$PETTA_DIR" && pwd -P)
[ -z "$(git -C "$PETTA_DIR" status --porcelain --untracked-files=no)" ] || { echo "$PETTA_DIR has local changes; use a separate --petta directory" >&2; exit 2; }
if ! target=$(git -C "$PETTA_DIR" rev-parse --verify "$PETTA_REF^{commit}" 2>/dev/null); then
  git -C "$PETTA_DIR" fetch -q origin
  target=$(git -C "$PETTA_DIR" rev-parse --verify "$PETTA_REF^{commit}")
fi
git -C "$PETTA_DIR" checkout -q --detach "$target"
[ -f "$PETTA_DIR/src/main.pl" ] || { echo "the selected PeTTa revision has no src/main.pl" >&2; exit 1; }
echo "PeTTa: $(git -C "$PETTA_DIR" rev-parse HEAD)."
if [ "$rebuilt" = 1 ] || ! "$PY" -I -c 'import importlib.metadata,sys; assert importlib.metadata.version("janus-swi") == sys.argv[1]' "$JANUS_VERSION" 2>/dev/null; then
  "$PY" -m pip install --force-reinstall --no-deps --no-binary=janus-swi "janus-swi==$JANUS_VERSION"
fi

"$PY" "$CORE_SETUP_ROOT/scripts/setup_core.py"
mkdir -p "$RUNTIME_DIR/repos"
if [ -e "$RUNTIME_DIR/repos/OmegaClaw-Core" ] && [ ! -L "$RUNTIME_DIR/repos/OmegaClaw-Core" ]; then
  echo "$RUNTIME_DIR/repos/OmegaClaw-Core is a real directory; choose another --runtime" >&2; exit 2
fi
ln -sfn "$CORE_SETUP_ROOT" "$RUNTIME_DIR/repos/OmegaClaw-Core"
if [ ! -d "$RUNTIME_DIR/repos/petta_lib_chromadb" ]; then
  git clone -q --depth 1 https://github.com/patham9/petta_lib_chromadb.git "$RUNTIME_DIR/repos/petta_lib_chromadb"
fi
"$PY" -I - "$RUNTIME_DIR/run.sh" "$PREFIX" "$PY" "$PYBASE" "$PETTA_DIR" "$VIRTUAL_ENV" "$OMEGACLAW_RUNTIME_CACHE" <<'PY'
import pathlib,shlex,sys
dest,prefix,python,base,petta,venv,cache=sys.argv[1:]
q=shlex.quote
p=pathlib.Path(dest)
p.write_text('#!/bin/sh\n# Purpose: run the pinned PeTTa with its verified Python and SWI-Prolog.\n'
             + 'export LANG=${LANG:-C.UTF-8}\n'
             + 'export PATH='+q(prefix+'/bin:'+str(pathlib.Path(python).parent))+':"$PATH"\n'
             + 'export LD_LIBRARY_PATH='+q(base+'/lib')+'${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n'
             + 'export VIRTUAL_ENV='+q(venv)+'\n'
             + 'export PETTA_PATH='+q(petta)+'\n'
             + 'export OMEGACLAW_RUNTIME_CACHE='+q(cache)+'\n'
             + 'exec sh '+q(petta+'/run.sh')+' "$@"\n')
p.chmod(0o755)
PY

# Always re-check both bridges and actual MeTTa execution, including on a cache hit.
"$PY" -I -c 'import janus_swi as j; r=j.query_once("X is 20+22"); assert r.get("X") == 42, r'
[ "$("$PREFIX/bin/swipl" -q -g 'use_module(library(janus)),py_call(operator:add(20,22),V),write(V),nl,halt')" = 42 ]
[ "$("$PREFIX/bin/swipl" -q -g 'use_module(library(janus)),py_call(sys:base_prefix,B),write(B),nl,halt')" = "$PYBASE" ]
check=$(mktemp -d "$RUNTIME_DIR/check.XXXXXXXX")
printf '(= (f $x) (+ $x 1))\n!(f 41)\n' > "$check/check.metta"
run_logged "$check/output.log" "$RUNTIME_DIR/run.sh" "$check/check.metta"
OUT=$("$PY" -I -c 'import pathlib,re,sys; s=re.sub(r"\x1b\[[0-9;]*m", "", pathlib.Path(sys.argv[1]).read_text()); print(s.strip().splitlines()[-1])' "$check/output.log")
[ "$OUT" = 42 ] || { echo "PeTTa returned '$OUT', expected 42; log: $check/output.log" >&2; exit 1; }
echo "Runtime checked: Python->Prolog 42, Prolog->Python 42 on $PYBASE, MeTTa 42; janus-swi $JANUS_VERSION."
echo "Runtime ready: OMEGACLAW_ROOT=$RUNTIME_DIR (repos/OmegaClaw-Core -> $CORE_SETUP_ROOT)"
