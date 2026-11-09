#!/usr/bin/env bash
# Build a PeTTa test runtime for OmegaClaw-Core / OmegaDots Hive development.
#
# Installs SWI-Prolog (built from GitHub source when the system package is too
# old), clones PeTTa, installs janus-swi, and writes a runtime dir whose run.sh
# can be executed directly by tests/run_metta_smokes.py.
#
# Usage:  scripts/dev/setup_petta_env.sh [RUNTIME_DIR]
# Then:   OMEGACLAW_ROOT=RUNTIME_DIR python3 tests/run_metta_smokes.py <smoke>
set -euo pipefail

SWIPL_TAG="${SWIPL_TAG:-V10.0.2}"
PETTA_DIR="${PETTA_DIR:-$HOME/PeTTa}"
RUNTIME_DIR="${1:-${OMEGACLAW_ROOT:-$HOME/.omegadots/runtime}}"
BUILD_DIR="${SWIPL_BUILD_DIR:-/tmp/swipl-build}"
SWIPL_MODULES="clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl"

swipl_ok() {
  command -v swipl >/dev/null 2>&1 || return 1
  local v
  v="$(swipl --dump-runtime-variables 2>/dev/null | sed -n 's/^PLVERSION="\([0-9]*\)".*/\1/p')"
  [ -n "$v" ] && [ "$v" -ge 90300 ]
}

if swipl_ok; then
  echo "swipl: $(swipl --version)"
else
  echo "Building SWI-Prolog $SWIPL_TAG from source into /usr/local ..."
  rm -rf "$BUILD_DIR"
  git clone -q --depth 1 --branch "$SWIPL_TAG" https://github.com/SWI-Prolog/swipl.git "$BUILD_DIR"
  (cd "$BUILD_DIR" && for m in $SWIPL_MODULES; do echo "packages/$m"; done \
     | xargs git submodule update --init --depth 1 -q)
  mkdir -p "$BUILD_DIR/build"
  (cd "$BUILD_DIR/build" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF \
      -DSWIPL_PACKAGES_QT=OFF -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF \
      -DCMAKE_INSTALL_PREFIX=/usr/local .. >/dev/null && ninja >/dev/null && ninja install >/dev/null)
  swipl --version
fi

python3 -c "import janus_swi" 2>/dev/null || python3 -m pip install -q janus-swi

if [ ! -f "$PETTA_DIR/src/main.pl" ]; then
  git clone -q --depth 1 https://github.com/trueagi-io/PeTTa "$PETTA_DIR"
fi

mkdir -p "$RUNTIME_DIR/repos"
# Smokes git-import! OmegaClaw-Core into ./repos; link this checkout there so
# they exercise local code instead of cloning the upstream repository.
CORE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
rm -rf "$RUNTIME_DIR/repos/OmegaClaw-Core"
ln -sfn "$CORE_DIR" "$RUNTIME_DIR/repos/OmegaClaw-Core"
if [ ! -d "$RUNTIME_DIR/repos/petta_lib_chromadb" ]; then
  git clone -q --depth 1 https://github.com/patham9/petta_lib_chromadb.git "$RUNTIME_DIR/repos/petta_lib_chromadb"
fi
cat > "$RUNTIME_DIR/run.sh" <<RUN
#!/bin/sh
export LANG=\${LANG:-C.UTF-8}
exec sh "$PETTA_DIR/run.sh" "\$@"
RUN
chmod +x "$RUNTIME_DIR/run.sh"
echo "Runtime ready: OMEGACLAW_ROOT=$RUNTIME_DIR (repos/OmegaClaw-Core -> $CORE_DIR)"
