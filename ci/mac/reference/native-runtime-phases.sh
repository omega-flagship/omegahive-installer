#!/bin/bash
# Mac r12 fresh-public-input CI runtime Source candidate; no app install/signing.
set -euo pipefail
RUN_ENABLED=false
if [ "$RUN_ENABLED" != true ]; then
  echo "DISABLED: independent Source review, exact CI binding and resource admission required" >&2
  exit 78
fi
JOB_DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE_DIR="$JOB_DIR/OmegaHive.bundle"
BUILD_TOOLS="$JOB_DIR/build-tools"
PBS_ARCHIVE="$JOB_DIR/artifacts/cpython-3.12.15+20261013-aarch64-apple-darwin-install_only.tar.gz"
PY_RUNTIME="$BUNDLE_DIR/python/bin/python3.12"
SWI_PREFIX="$BUNDLE_DIR/swipl"
export PATH="$SWI_PREFIX/bin:$BUNDLE_DIR/python/bin:$BUILD_TOOLS/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PYTHONDONTWRITEBYTECODE=1 PIP_CONFIG_FILE=/dev/null PIP_DISABLE_PIP_VERSION_CHECK=1
export PYTHONNOUSERSITE=1 PIP_NO_INDEX=1
export MACOSX_DEPLOYMENT_TARGET=15.0
export HOME="$JOB_DIR/empty-home" TMPDIR="$JOB_DIR/tmp"
test -d "$HOME" && test -d "$TMPDIR"
test -f "$JOB_DIR/CI_PREPARATION_RECEIPT_R1.json"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1
export SWI_HOME_DIR="$SWI_PREFIX/lib/swipl"

case "${1:-}" in
  fetch-wheels)
    # Network fetch is a separate hash-checked preparation phase, not pip fallback.
    echo 'Use the independently bound public-input preparation worker' >&2
    exit 78
    ;;
  tools)
    BOOTSTRAP_PY="$JOB_DIR/bootstrap/python/bin/python3.12"
    test ! -e "$BUILD_TOOLS"
    "$BOOTSTRAP_PY" -I -B -m venv "$BUILD_TOOLS"
    "$BUILD_TOOLS/bin/python" -I -B -m pip install --no-index --no-deps --no-compile \
      --require-hashes --find-links "$JOB_DIR/wheelhouse" -r "$JOB_DIR/build-tools-requirements.lock"
    ;;
  pcre)
    "$BUILD_TOOLS/bin/cmake" -S "$JOB_DIR/sources/pcre2-src" -B "$JOB_DIR/pcre-build" -G Ninja \
      -DCMAKE_MAKE_PROGRAM="$BUILD_TOOLS/bin/ninja" \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$JOB_DIR/pcre-install" \
      -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
      -DBUILD_SHARED_LIBS=ON -DPCRE2_BUILD_PCRE2_8=ON \
      -DPCRE2_BUILD_PCRE2_16=OFF -DPCRE2_BUILD_PCRE2_32=OFF \
      -DPCRE2_BUILD_PCRE2GREP=OFF -DPCRE2_BUILD_TESTS=OFF -DPCRE2_SUPPORT_JIT=ON \
      -DCMAKE_INSTALL_NAME_DIR=@rpath -DCMAKE_BUILD_WITH_INSTALL_NAME_DIR=ON
    "$BUILD_TOOLS/bin/cmake" --build "$JOB_DIR/pcre-build" --parallel 2
    "$BUILD_TOOLS/bin/cmake" --install "$JOB_DIR/pcre-build"
    test ! -e "$BUNDLE_DIR/lib"
    mkdir "$BUNDLE_DIR/lib" "$JOB_DIR/pcre-include"
    cp "$JOB_DIR/pcre-install/include/pcre2.h" "$JOB_DIR/pcre-include/pcre2.h"
    cp -L "$JOB_DIR/pcre-install/lib/libpcre2-8.0.dylib" "$BUNDLE_DIR/lib/libpcre2-8.0.dylib"
    ;;
  python)
    test "$(shasum -a 256 "$PBS_ARCHIVE" | cut -d' ' -f1)" = ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440
    test ! -e "$BUNDLE_DIR/python"
    tar -xzf "$PBS_ARCHIVE" -C "$BUNDLE_DIR"
    "$PY_RUNTIME" -I -c 'import sys; assert sys.version_info[:3] == (3,12,15); print(sys.version); print(sys.prefix)'
    ;;
  configure)
    # Relative rpaths work for both installed executable and installed plugins.
    # @loader_path alone also permits the build-tree executable beside libswipl.
    REL_RPATH='@loader_path;@loader_path/../../lib/arm64-darwin;@loader_path/../../../../../python/lib;@loader_path/../../../../../lib;@loader_path/../../src'
    "$BUILD_TOOLS/bin/cmake" -S "$JOB_DIR/sources/swipl-src" -B "$JOB_DIR/swipl-build" -G Ninja \
      -DCMAKE_MAKE_PROGRAM="$BUILD_TOOLS/bin/ninja" \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$SWI_PREFIX" \
      -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
      -DOMEGA_RELOCATABLE_RPATH="$REL_RPATH" \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH="$REL_RPATH" \
      -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=OFF \
      -DUSE_GMP=OFF -DUSE_LIBBF=ON -DBUILD_TESTING=OFF -DINSTALL_DOCUMENTATION=OFF \
      -DBUILD_MACOS_BUNDLE=OFF -DBUILD_MACOS_FRAMEWORK=OFF \
      -DSWIPL_PACKAGES_GUI=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF \
      -DSWIPL_PACKAGES_BDB=OFF -DSWIPL_PACKAGES_ARCHIVE=OFF -DSWIPL_PACKAGES_SSL=OFF \
      -DSWIPL_PACKAGES_TERM=OFF -DSWIPL_PACKAGES_TIPC=OFF -DSWIPL_PACKAGES_YAML=OFF \
      -DPython_EXECUTABLE="$PY_RUNTIME" -DPython_ROOT_DIR="$BUNDLE_DIR/python" \
      -DPython_INCLUDE_DIR="$BUNDLE_DIR/python/include/python3.12" \
      -DPython_LIBRARY="$BUNDLE_DIR/python/lib/libpython3.12.dylib" \
      -DPython3_EXECUTABLE="$PY_RUNTIME" -DPython3_ROOT_DIR="$BUNDLE_DIR/python" \
      -DPython3_INCLUDE_DIR="$BUNDLE_DIR/python/include/python3.12" \
      -DPython3_LIBRARY="$BUNDLE_DIR/python/lib/libpython3.12.dylib" \
      -DCPYTHON_VERSION='3.12;EXACT' \
      -DPCRE_INCLUDE_DIR="$JOB_DIR/pcre-include" -DPCRE_LIBRARY="$BUNDLE_DIR/lib/libpcre2-8.0.dylib"
    test -f "$JOB_DIR/swipl-build/packages/swipy/config.h"
    ;;
  build)
    # Installed plugins use loader-relative RPATHs. The initial QLF build runs
    # those plugins before installation, so expose only our own runtime dylibs
    # through the already-declared build-tree ../../src fallback. These relative
    # aliases are build-only and are not installed into the bundle.
    mkdir -p "$JOB_DIR/swipl-build/src"
    ln -sf ../../OmegaHive.bundle/lib/libpcre2-8.0.dylib "$JOB_DIR/swipl-build/src/libpcre2-8.0.dylib"
    ln -sf ../../OmegaHive.bundle/python/lib/libpython3.12.dylib "$JOB_DIR/swipl-build/src/libpython3.12.dylib"
    "$BUILD_TOOLS/bin/cmake" --build "$JOB_DIR/swipl-build" --parallel 2
    ;;
  install)
    "$BUILD_TOOLS/bin/cmake" --install "$JOB_DIR/swipl-build"
    "$SWI_PREFIX/bin/swipl" --version
    ;;
  deps)
    "$PY_RUNTIME" -m pip install --no-index --find-links "$JOB_DIR/wheelhouse" \
      --require-hashes --no-deps --no-compile -r "$JOB_DIR/runtime-requirements.lock"
    ;;
  janus)
    # The exact stock Janus source is copied separately. Its only derivative is
    # the build-only relative rpath, recorded by prepare_bundle.py.
    export SWIPL="$SWI_PREFIX/bin/swipl"
    "$BUILD_TOOLS/bin/python" -I -B -m pip wheel --no-index --no-deps --no-build-isolation \
      --wheel-dir "$JOB_DIR/wheelhouse" "$JOB_DIR/janus-wheel-source"
    "$PY_RUNTIME" -I -B -S "$JOB_DIR/lock_janus.py"
    "$PY_RUNTIME" -m pip install --no-index --no-deps \
      --require-hashes --no-compile --find-links "$JOB_DIR/wheelhouse" -r "$JOB_DIR/janus-requirements.lock"
    "$PY_RUNTIME" -m pip check
    "$PY_RUNTIME" -m pip freeze --all > "$JOB_DIR/final-installed-freeze.txt"
    ;;
  ui)
    echo 'UI uses the separately reviewed fresh-cache/offline worker and parent' >&2
    exit 78
    ;;
  node)
    NODE_ARCHIVE="$JOB_DIR/artifacts/node-v24.22.0-darwin-arm64.tar.gz"
    test "$(shasum -a 256 "$NODE_ARCHIVE" | cut -d' ' -f1)" = 6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5
    test ! -e "$BUNDLE_DIR/node"
    tar -xzf "$NODE_ARCHIVE" -C "$BUNDLE_DIR"
    mv "$BUNDLE_DIR/node-v24.22.0-darwin-arm64" "$BUNDLE_DIR/node"
    "$BUNDLE_DIR/node/bin/node" --version
    ;;
  *) echo 'phase required: tools/python/node/pcre/configure/build/install/deps/janus' >&2; exit 64 ;;
esac
