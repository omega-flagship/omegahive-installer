#!/bin/bash
# Purpose: one double-click on a Mac sets up this folder's hive as the person's own hive in one folder of their home
# ($OMEGAHIVE_HOME, ~/OmegaHive by default), with no administrator password and no questions, and opens it in the
# default browser signed in as its owner (local-owner mode, hive/core/localowner.py). It puts the Omega Hive app in
# ~/Applications and a login item that starts the hive when its owner logs in (omegahive.sh register). Run again from
# the same release, it only does that again, starts the hive and opens it signed in; from another release, it refreshes
# the hive's code in place, keeping its data and settings, then starts it. "Install OmegaClaw.command" beside it still
# sets up a single OmegaClaw agent.
#
# The toolchain is the hive's pinned one (docs/omegaclaw-core.md, STATUS.md): Python 3.12, SWI-Prolog 10.1.14 built
# against it, PeTTa ae66fa8, janus-swi 1.5.3, Node 22.12 or later for the UI. As in Install OmegaClaw.command it is
# user-local: micromamba from conda-forge, so Homebrew is neither needed nor used. On an arm64 Mac a release that
# carries the prebuilt SWI-Prolog bundle and janus-swi wheel beside this script (install/macos/build-swipl-bundle.sh
# makes them) is used as it is, and then nothing is compiled and Apple's Command Line Tools are not needed; otherwise
# SWI-Prolog is built as deploy/setup_runtime.sh builds it, since no 10.1.14 macOS bundle is published.
#
# The Windows installer (install/windows/Install-OmegaHive.ps1) runs this same script on Linux, inside the WSL distro it
# makes for the hive, with OMEGAHIVE_FRONT=windows: the toolchain comes from locks/conda-linux-64.txt with its own GCC,
# SWI-Prolog is built from source with it, macOS's quarantine and signing steps do nothing, and the Windows side
# starts the hive and opens it in the Windows browser instead of this script.
set -euo pipefail

# A copy in the Trash, or in a folder macOS doesn't let Terminal read, cannot run: a tester's old copy in ~/.Trash failed
# with only "Operation not permitted". Checked with a real read of the code beside it, since access() can allow a file
# the sandbox then refuses to open.
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
unrunnable() {
  printf '%s\n' "$1" \
    "Download the newest Mac test build from https://github.com/omega-flagship/omegahive-installer/releases," \
    "unzip it in Downloads and double-click Install Omega there."
  printf "Press Return to close this window. "
  read -r _answer || true
  exit 1
}
case "$SELF_DIR/" in */.Trash/*) unrunnable "This copy of Omega is in the Trash, which macOS doesn't let Terminal open." ;; esac
head -c 1 "$SELF_DIR/../../hive/__main__.py" >/dev/null 2>&1 \
  || unrunnable "This copy of Omega is in a folder macOS doesn't let Terminal read: $SELF_DIR"

# Every build runs in an environment this script sets, never the tester's shell's: a tester's exported
# CC=/opt/homebrew/opt/llvm/bin/clang, a compiler that was not there, stopped SWI-Prolog's configure. So the script runs
# itself again under env -i with only these, and CC, CXX, CFLAGS, LDFLAGS, CPPFLAGS, CPATH, LIBRARY_PATH,
# PKG_CONFIG_PATH, SDKROOT, PYTHONPATH, CONDA_* or npm_config_* from the shell never reach a build or the hive.
if [ -z "${OMEGAHIVE_CLEAN_ENV:-}" ]; then
  KEEP=(OMEGAHIVE_CLEAN_ENV=1 "HOME=$HOME" "USER=${USER:-$(/usr/bin/id -un)}" "LOGNAME=${LOGNAME:-$(/usr/bin/id -un)}"
        SHELL=/bin/bash "TERM=${TERM:-xterm-256color}" "LANG=${LANG:-en_US.UTF-8}" "TMPDIR=${TMPDIR:-/tmp}"
        PATH=/usr/bin:/bin:/usr/sbin:/sbin)
  if [ -n "${OMEGAHIVE_HOME:-}" ]; then KEEP+=("OMEGAHIVE_HOME=$OMEGAHIVE_HOME"); fi
  if [ -n "${OMEGAHIVE_FRONT:-}" ]; then KEEP+=("OMEGAHIVE_FRONT=$OMEGAHIVE_FRONT"); fi
  if [ -n "${OMEGAHIVE_WINDOWS_PORTS:-}" ]; then KEEP+=("OMEGAHIVE_WINDOWS_PORTS=$OMEGAHIVE_WINDOWS_PORTS"); fi
  exec /usr/bin/env -i "${KEEP[@]}" /bin/bash "$0" "$@"
fi
# Everything the installer makes in ~/OmegaHive (code, toolchain, runtime, data, logs) is the owner's alone (the
# review of PhysixSNET/omegahive#25, point 2).
umask 077

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$SCRIPT_DIR/../.." && pwd)
OH=${OMEGAHIVE_HOME:-$HOME/OmegaHive}
export OMEGAHIVE_HOME=$OH
MAMBA_ROOT=$OH/toolchain
TOOLCHAIN=$MAMBA_ROOT/envs/hive
BUILD=$OH/build
# Every download is pinned by version and sha256 in pins.sh, and the conda toolchain one package at a time in
# locks/conda-<platform>.txt (the review of PhysixSNET/omegahive#25, point 1): SWIPL_TAG, SWIPL_COMMIT,
# PETTA_COMMIT, PETTA_SHA256, JANUS_SWI_VERSION, JANUS_SWI_SDIST_SHA256, micromamba_url, micromamba_sha256, petta_url,
# pin_fetch.
. "$SCRIPT_DIR/pins.sh"
JANUS_VERSION=$JANUS_SWI_VERSION
# The prebuilt runtime has one root swipl/, unpacked as $OH/swipl; its janus.so finds
# libpython3.12 through an rpath into $OH/toolchain/envs/hive/lib.
SWI_BUNDLE=$SCRIPT_DIR/swipl-10.1.14-macos-arm64.tar.gz
JANUS_WHEEL=$SCRIPT_DIR/janus_swi-$JANUS_VERSION-cp312-cp312-macosx_11_0_arm64.whl
# Create's Code service rides in the release beside the bundle, untracked; with it there, the hive gets Create
# (setup-code.sh lays it out, omegahive.sh runs it beside the hive and enrols it).
CODE_TARBALL=$SCRIPT_DIR/omegacode-309df.tgz
# The Tools app rides in the release the same way, named by the omega-tools commit pins.sh pins; with it there, the
# hive's Tools page lists its tools (setup-tools.sh lays it out, omegahive.sh mounts and pins it).
TOOLS_TARBALL=$SCRIPT_DIR/omega-tools-$(printf '%s' "$OMEGA_TOOLS_COMMIT" | cut -c1-7).tgz
# Studio, the app the hive shows as Create, rides the same way, named by the version pins.sh pins; with it there, the
# hive lists Create (setup-studio.sh lays it out, omegahive.sh mounts and pins it, and create installs it as the owner).
STUDIO_ZIP=$SCRIPT_DIR/omegadesign-$OMEGADESIGN_VERSION.zip
PREBUILT=0
OS=$(uname -s)
if [ "$OS" = Darwin ] && [ "$(uname -m)" = arm64 ] && [ -f "$SWI_BUNDLE" ] && [ -f "$JANUS_WHEEL" ]; then PREBUILT=1; fi
# What a person double-clicks to run this again: this file on a Mac, the release's Install Omega on Windows.
AGAIN="double-click Install OmegaHive.command again"
if [ "${OMEGAHIVE_FRONT:-}" = windows ]; then AGAIN="double-click Install Omega again"; fi

say() { printf '%s\n' "$*"; }
STEP="starting"
# SUBLOG names the log a step's quiet command writes, so a failure shows its end, not only the step's name.
SUBLOG=""
step() { STEP=$1; SUBLOG=""; say ""; say "== $(date '+%H:%M:%S') $1"; }
# What this computer has received on its default route's interface (on a Mac netstat -ib's link row Ibytes, on Linux
# /sys/class/net's rx_bytes), read around each download so a person on slow Wi-Fi sees a line for each one and its
# size. Other traffic on the computer counts too.
rx_bytes() {
  if [ "$OS" = Linux ]; then
    IF=$(awk '$2 == "00000000" {print $1; exit}' /proc/net/route 2>/dev/null)
    cat "/sys/class/net/${IF:-none}/statistics/rx_bytes" 2>/dev/null || echo 0
    return 0
  fi
  IF=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
  if [ -n "$IF" ]; then netstat -ib -I "$IF" 2>/dev/null | awk 'NR == 2 {v = $7} END {print v + 0}'; else echo 0; fi
}
fetching() { say "Downloading $1, about $2 MB..."; RX=$(rx_bytes); T0=$(date +%s); }
# Under a megabyte reads in KB and under a second as such: a tester asked what "Downloaded 0 MB in 0 seconds" meant.
fetched() {
  local got=$(( $(rx_bytes) - RX )) took=$(( $(date +%s) - T0 ))
  if [ "$got" -ge 1048576 ]; then got="$(( got / 1048576 )) MB"; else got="$(( got / 1024 )) KB"; fi
  if [ "$took" -ge 1 ]; then took="in $took seconds"; else took="in under a second"; fi
  say "Downloaded $got $took."
}
# An EXIT trap, not ERR: under macOS's bash 3.2 a failing ( ... ) subshell ends a set -e script without running its ERR
# trap, so a failed SWI-Prolog configure ended the installer with no message.
stopped() {
  status=$?
  [ "$status" -eq 0 ] && return 0
  say ""
  say "Setup stopped while $STEP (exit $status). The full log is $OH/logs/install.log."
  if [ -n "$SUBLOG" ] && [ -f "$SUBLOG" ]; then
    say "The end of $SUBLOG:"
    tail -n 15 "$SUBLOG" || true
  fi
  say "Fix what it names, then $AGAIN: finished steps are kept."
  if [ "${OMEGAHIVE_FRONT:-}" != windows ]; then
    printf "Press Return to close this window. "
    read -r _answer || true
  fi
}
trap stopped EXIT

if [ "$OS" = Darwin ]; then say "OmegaHive for macOS: your own hive, in $OH"; else say "OmegaHive in WSL: your own hive, in $OH"; fi

# Which release this folder holds: the commit the release names in RELEASE_COMMIT (make-mac-release.sh writes it), or
# for a zip of the branch, which has none, a checksum of its files.
if [ -f "$SRC/RELEASE_COMMIT" ]; then
  RELEASE=$(head -n 1 "$SRC/RELEASE_COMMIT")
else
  RELEASE=tree-$(cd "$SRC" && find . -type f ! -path './hive/ui/node_modules/*' ! -name .DS_Store | LC_ALL=C sort \
    | while IFS= read -r f; do sha1 "$f"; done | sha1 | cut -c1-40)
fi
# Starting the hive and opening it signed in: this script does it on a Mac; under the Windows installer
# (OMEGAHIVE_FRONT=windows) the Windows side does, since only it can open the Windows browser and keep WSL running.
open_hive() {
  if [ "${OMEGAHIVE_FRONT:-}" = windows ]; then return 0; fi
  /bin/bash "$OH/app/install/macos/omegahive.sh" open
}
# The Omega Hive app and the login item on a Mac (omegahive.sh register). The hive runs without them, so a failure
# says so, names Start OmegaHive in the folder instead, and leaves the hive set up.
REGISTERED=0
register() {
  [ "$OS" = Darwin ] || return 0
  if /bin/bash "$OH/app/install/macos/omegahive.sh" register; then
    REGISTERED=1
  else
    say "Omega Hive could not be added to Applications or Login Items. Double-click Start OmegaHive in $OH instead."
  fi
}
# Run again from the release the hive was installed from: put the app and the login item in place again, start the
# hive and open it signed in, nothing else. From another release (or an install made before releases were recorded),
# the steps below refresh the code in place and keep data/, venv/, toolchain/, swipl/ and PeTTa/, each step skipping
# what is already there.
REFRESH=0
if [ -f "$OH/installed" ] && [ -x "$OH/venv/bin/python" ]; then
  if [ "$SRC" = "$OH/app" ] || [ "$(sed -n 's/^release=//p' "$OH/installed")" = "$RELEASE" ]; then
    STEP="starting your hive"
    register
    open_hive
    exit 0
  fi
  REFRESH=1
  say "This is a newer release than your hive's: updating its code, keeping your data and settings."
fi

# The folder the installer makes, entry by entry: it replaces app/ only in such a folder (or an empty one), never in one
# OMEGAHIVE_HOME names that holds anything else.
if [ -d "$OH" ] && [ ! -f "$OH/installed" ]; then
  for entry in "$OH"/* "$OH"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "${entry##*/}" in
      app|app.new|app.old|toolchain|build|logs|swipl|swipl-*|PeTTa|PeTTa.new|venv|data|run|code|repos|apps|hive.env|package.json|"Start OmegaHive.command"|.DS_Store) ;;
      *) say "$OH already holds ${entry##*/}, which this installer did not make. Move it, or name another folder."; false ;;
    esac
  done
fi

# Apple's Command Line Tools give the C compiler SWI-Prolog and janus-swi are built with, needed only without a working
# prebuilt runtime: before anything else when the release has none, or later when its bundle does not run here.
# macOS shows its own install dialog; this waits for it to finish instead of asking. The compilers are then Apple's,
# named outright, as the only C and C++ compilers this script uses, with the SDK they compile against: called by path
# rather than through /usr/bin's shims, clang finds no system headers without SDKROOT ("'stdlib.h' file not found"
# building janus-swi on the Mac mini).
compilers() {
  if [ "$OS" = Linux ]; then
    CC=$TOOLCHAIN/bin/gcc
    CXX=$TOOLCHAIN/bin/g++
    export CC CXX
    return 0
  fi
  if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
    say "Your Mac needs Apple's Command Line Tools. In the dialog macOS opens now, click Install, then Agree."
    xcode-select --install >/dev/null 2>&1 || true
    until xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1; do sleep 10; done
    say "Command Line Tools are installed."
  fi
  CC=$(xcrun --find clang)
  CXX=$(xcrun --find clang++)
  SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
  export CC CXX SDKROOT
}
if [ "$PREBUILT" = 0 ]; then compilers; fi
# Nothing the installer runs from this folder may carry the quarantine a browser download gave the release: macOS can
# copy it onto what is unpacked from it, and Gatekeeper then refuses an ad hoc signed binary (a tester's prebuilt swipl
# failed its version check on v0.4). Each runtime folder is cleared after it is made, before anything runs from it.
unquarantine() { [ "$OS" = Darwin ] || return 0; xattr -dr com.apple.quarantine "$@" 2>/dev/null || true; }
# Testers' Macs called the prebuilt swipl "damaged": Gatekeeper's word for a quarantined, ad hoc signed binary. After
# the quarantine is cleared, every Mach-O file in what was unpacked must pass codesign --verify; one that does not is
# signed again ad hoc here, on this Mac, before anything runs from it. Time: one codesign per Mach-O file (about a
# hundred in the bundle).
resign() {
  [ "$OS" = Darwin ] || return 0
  { find "$@" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0 2>/dev/null || true; } |
    while IFS= read -r -d '' f; do
      file -b "$f" 2>/dev/null | grep -q '^Mach-O' || continue
      codesign --verify "$f" >/dev/null 2>&1 || codesign --force --sign - "$f" >/dev/null 2>&1 \
        || say "could not sign $f again"
    done
}
# A Mac that refused a binary keeps holding any binary it has not yet run at that same real path, whatever its
# signature: on the Mac mini a fresh copy signed under a new identifier stayed held where a quarantined swipl had been
# refused, and a copy in a new folder ran, reached directly or through a link at the refused path. So each unpack of the
# bundle ($1) goes into a folder of its own, swipl-<8 hex>, and $OH/swipl is a link to it. The folder sits beside the
# link, at the depth the bundle's janus.so expects: its rpath reaches the toolchain's libpython seven folders up. From
# stdin, since macOS tar copies an archive file's quarantine onto every file it unpacks.
unpack_swipl() {
  local dir
  dir=swipl-$(uuidgen | cut -c1-8 | tr 'A-F' 'a-f')
  rm -rf "$OH/swipl" "$OH"/swipl-*
  mkdir -p "$OH/$dir"
  tar -xzf - -C "$OH/$dir" --strip-components 1 < "$1"
  ln -s "$dir" "$OH/swipl"
  unquarantine "$OH/$dir"
  resign "$OH/$dir"
}

mkdir -p "$OH/logs" "$BUILD"
# The folder itself is the owner's alone, an older install's included: ditto keeps the release's 0755 modes inside it,
# and only the owner can then reach them.
chmod 700 "$OH"
exec > >(tee -a "$OH/logs/install.log") 2>&1
say "Setup started $(date '+%Y-%m-%d %H:%M:%S') from $SRC"
RX_START=$(rx_bytes)
# Only this folder's toolchain and the system's own tools, whatever else is installed; downloads cached in this folder.
export PATH="$TOOLCHAIN/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export UV_CACHE_DIR="$BUILD/uv-cache" PIP_CACHE_DIR="$BUILD/pip-cache" npm_config_cache="$BUILD/npm-cache"
# pip checks for no newer pip, whose notice told every tester to run "python -m pip install --upgrade pip".
export PIP_DISABLE_PIP_VERSION_CHECK=1

step "installing the toolchain (Python 3.12, Node, build tools) into $MAMBA_ROOT"
# The download each lock makes: the Linux one carries GCC for SWI-Prolog's build (335 MB on the Windows laptop's first run).
TOOLCHAIN_MB=125; if [ "$OS" = Linux ]; then TOOLCHAIN_MB=335; fi
case "$OS/$(uname -m)" in
  Darwin/arm64) PLATFORM=osx-arm64 ;; Darwin/x86_64) PLATFORM=osx-64 ;; Linux/x86_64) PLATFORM=linux-64 ;;
  *) say "Unsupported computer: $OS on $(uname -m)"; false ;;
esac
MICROMAMBA=$MAMBA_ROOT/bin/micromamba
if [ ! -x "$MICROMAMBA" ]; then
  mkdir -p "$MAMBA_ROOT/bin"
  fetching "the package manager (micromamba $MICROMAMBA_VERSION)" 14
  pin_fetch "$(micromamba_url "$PLATFORM")" "$(micromamba_sha256 "$PLATFORM")" "$MICROMAMBA"
  fetched
  chmod 755 "$MICROMAMBA"
fi
export MAMBA_ROOT_PREFIX="$MAMBA_ROOT"
# Each tool the steps below run from the toolchain is checked, git included: an install made before git joined the list
# (v0.1 to v0.3) is made again from the lock rather than left to Apple's git, which needs the Command Line Tools. The
# lock names each package's exact build by URL and sha256, and micromamba checks every one.
if [ ! -x "$TOOLCHAIN/bin/python3.12" ] || [ ! -x "$TOOLCHAIN/bin/node" ] || [ ! -x "$TOOLCHAIN/bin/uv" ] \
   || [ ! -x "$TOOLCHAIN/bin/git" ] || { [ "$OS" = Linux ] && [ ! -x "$TOOLCHAIN/bin/g++" ]; }; then
  fetching "Python 3.12, Node and the build tools" "$TOOLCHAIN_MB"
  # An environment a stopped run left part-made is made again: create refuses an existing folder.
  rm -rf "$TOOLCHAIN"
  # micromamba records each environment it makes in ~/.conda/environments.txt and notes its package cache in
  # ~/.mamba, whatever its settings say (seen in the Windows installer's distro). With HOME at the toolchain folder for
  # this one call, both land in it, so nothing it writes is outside this folder.
  # Its package table, linking lines and notice that a package's link scripts can run code (each build is pinned by
  # sha256 in the lock) go to their own log: in the installer's window, about 300 lines that a person who isn't
  # technical read as a virus warning. A failure shows the log's end.
  SUBLOG=$OH/logs/toolchain.log
  HOME="$MAMBA_ROOT" "$MICROMAMBA" create -y --no-rc -p "$TOOLCHAIN" -f "$SCRIPT_DIR/locks/conda-$PLATFORM.txt" </dev/null \
    > "$SUBLOG" 2>&1
  SUBLOG=""
  fetched
fi
unquarantine "$MAMBA_ROOT"

step "copying the hive's code into $OH/app"
if [ "$SRC" != "$OH/app" ]; then
  # A hive running from app/ is stopped first; the end of the setup starts it again from the new code.
  # This release's launcher stops it as well: an older launcher's stop returns while the hive is still exiting, and
  # the start at the end would then find the old hive answering and start nothing.
  if [ "$REFRESH" = 1 ]; then
    /bin/bash "$OH/app/install/macos/omegahive.sh" stop || true
    /bin/bash "$SCRIPT_DIR/omegahive.sh" stop
  fi
  rm -rf "$OH/app.new"
  if [ "$OS" = Darwin ]; then ditto "$SRC" "$OH/app.new"; else cp -pR "$SRC" "$OH/app.new"; fi
  # This folder was approved when its installer was opened; the copy is not quarantined again file by file.
  unquarantine "$OH/app.new"
  # Swapped by rename, as the J1 installer adopts a staged sibling: a run stopped here leaves the old code or the new.
  rm -rf "$OH/app.old"
  if [ -d "$OH/app" ]; then mv "$OH/app" "$OH/app.old"; fi
  mv "$OH/app.new" "$OH/app"
  rm -rf "$OH/app.old"
fi

# The UI builds while SWI-Prolog and the Python packages are made; a bundle with a built hive/ui/dist skips it.
UI_PID=""
if [ ! -f "$OH/app/hive/ui/dist/index.html" ]; then
  say "Downloading the web page's packages, about 55 MB, and building it, in the background (log: $OH/logs/ui-build.log)"
  (cd "$OH/app/hive/ui" && npm ci --no-audit --no-fund && npm run build) > "$OH/logs/ui-build.log" 2>&1 &
  UI_PID=$!
fi

if [ "$PREBUILT" = 1 ]; then
  step "unpacking the prebuilt SWI-Prolog 10.1.14"
  BUNDLE_SHA256=$(cut -d ' ' -f 1 "$SWI_BUNDLE.sha256" 2>/dev/null || true)
  # Nothing in $OH/swipl runs before this installer has signed it here and seen it run, which .omegahive-ran records: a
  # copy an older installer left may be bytes this Mac already refused, and running it would show the tester macOS's
  # "damaged" dialog again. A source build this Mac made after the bundle failed on it is kept, with its own janus.
  SWIPL_RAN=$(cat "$OH/swipl/.omegahive-ran" 2>/dev/null || true)
  if [ "$SWIPL_RAN" = "source $SWIPL_COMMIT" ]; then
    say "Keeping the SWI-Prolog built from source on this Mac before."
    PREBUILT=0
    compilers
  elif [ "$SWIPL_RAN" != "bundle $BUNDLE_SHA256" ]; then
    (cd "$SCRIPT_DIR" && sha256 -c "$(basename "$SWI_BUNDLE").sha256" >/dev/null) \
      || { say "The prebuilt SWI-Prolog does not match its checksum; download the release again"; false; }
    unpack_swipl "$SWI_BUNDLE"
  fi
  # A bundle that does not run here says why, then the hermetic source build takes over rather than setup stopping.
  if [ "$PREBUILT" = 1 ] && { ! SWIPL_SAYS=$("$OH/swipl/bin/swipl" --version 2>&1) \
       || ! printf '%s\n' "$SWIPL_SAYS" | grep -q ' 10\.1\.14 '; }; then
    say "The prebuilt SWI-Prolog did not run on this Mac. It said:"
    say "$SWIPL_SAYS"
    say "Its attributes and signature, for whoever reads this:"
    REAL=$(cd "$OH/swipl/bin" 2>/dev/null && cd "$(dirname "$(readlink swipl 2>/dev/null || echo swipl)")" && pwd)/swipl
    xattr -l "$REAL" 2>&1 | head -n 5 || true
    codesign -dv "$REAL" 2>&1 | head -n 4 || true
    say "Building SWI-Prolog from source instead (a few minutes)."
    rm -rf "$OH/swipl" "$OH"/swipl-*
    PREBUILT=0
    compilers
  fi
fi
if [ "$PREBUILT" = 0 ] && ! "$OH/swipl/bin/swipl" --version 2>/dev/null | grep -q ' 10\.1\.14 '; then
  step "building SWI-Prolog 10.1.14 against the toolchain's Python 3.12 (a few minutes)"
  rm -rf "$BUILD/swipl"
  fetching "SWI-Prolog 10.1.14's source" 40
  git clone --progress --depth 1 --branch "$SWIPL_TAG" https://github.com/SWI-Prolog/swipl-devel.git "$BUILD/swipl"
  [ "$(git -C "$BUILD/swipl" rev-parse HEAD)" = "$SWIPL_COMMIT" ] \
    || { say "SWI-Prolog's $SWIPL_TAG is not the pinned commit $SWIPL_COMMIT"; false; }
  # The packages deploy/setup_runtime.sh builds; janus (packages/swipy) is the one PeTTa needs.
  (cd "$BUILD/swipl" && for m in clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl; do
    echo "packages/$m"; done | xargs git submodule update --init --depth 1 --progress)
  fetched
  mkdir -p "$BUILD/swipl/build"
  # janus looks for "Python", not "Python3": without the -DPython_ flags it binds to another Python or is skipped.
  # MACOSX_DEPENDENCIES_FROM is SWI-Prolog's own switch for where its libraries come from (cmake/port/Darwin.cmake):
  # left to itself on a Mac with Homebrew it printed "Using Homebrew packages from /opt/homebrew" and built against
  # them on a tester's Mac. Pointed at the toolchain, as build-swipl-bundle.sh does, and with the ignore list, no
  # Homebrew, MacPorts or /usr/local library reaches the build.
  SUBLOG=$OH/logs/swipl-cmake.log
  (cd "$BUILD/swipl/build" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$OH/swipl" \
    -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF -DSWIPL_PACKAGES_QT=OFF \
    -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF \
    -DMACOSX_DEPENDENCIES_FROM="$TOOLCHAIN" -DCMAKE_PREFIX_PATH="$TOOLCHAIN" \
    -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local;/opt/local" \
    -DCMAKE_FIND_FRAMEWORK=NEVER -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON \
    -DPython3_EXECUTABLE="$TOOLCHAIN/bin/python3.12" -DPython3_ROOT_DIR="$TOOLCHAIN" \
    -DPython_EXECUTABLE="$TOOLCHAIN/bin/python3.12" -DPython_ROOT_DIR="$TOOLCHAIN" .. > "$OH/logs/swipl-cmake.log")
  grep -q "^_Python_INCLUDE_DIR:INTERNAL=$TOOLCHAIN" "$BUILD/swipl/build/CMakeCache.txt" \
    || { say "SWI-Prolog's janus would not build against $TOOLCHAIN (see $OH/logs/swipl-cmake.log)"; false; }
  SUBLOG=$OH/logs/swipl-build.log
  (cd "$BUILD/swipl/build" && ninja > "$OH/logs/swipl-build.log" && ninja install > "$OH/logs/swipl-install.log")
  SUBLOG=""
fi
# A mind's sandbox may read the folder two levels above the real swipl (hive/supervisor/sandbox.py runtime_roots).
# The source install links bin/swipl to lib/swipl/bin/<arch>/swipl, whose grandparent leaves out SWI-Prolog's library,
# so there bin/swipl becomes a two-line wrapper whose own grandparent is $OH/swipl, the whole install; that build
# still finds its home, compiled in. The bundle keeps its link: its target's grandparent is SWI-Prolog.app/Contents,
# all of it, and janus_swi finds the bundle's home only through the link (through a wrapper it looked beside /bin/sh
# and stopped, "could not find SWI-Prolog home", on the Mac mini's first prebuilt run).
if [ "$PREBUILT" = 0 ] && [ -L "$OH/swipl/bin/swipl" ]; then
  REAL_SWIPL=$(cd "$OH/swipl/bin" && cd "$(dirname "$(readlink swipl)")" && pwd)/swipl
  rm "$OH/swipl/bin/swipl"
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL_SWIPL" > "$OH/swipl/bin/swipl"
  chmod 755 "$OH/swipl/bin/swipl"
fi
unquarantine "$OH/swipl"
SWIPL_SAYS=$("$OH/swipl/bin/swipl" --version 2>&1) || true
printf '%s\n' "$SWIPL_SAYS" | grep -q ' 10\.1\.14 ' || { say "SWI-Prolog is not 10.1.14. It said:"; say "$SWIPL_SAYS"; false; }
if [ "$PREBUILT" = 1 ]; then echo "bundle $BUNDLE_SHA256"; else echo "source $SWIPL_COMMIT"; fi > "$OH/swipl/.omegahive-ran"

step "fetching PeTTa at $PETTA_COMMIT"
# PeTTa as GitHub's tarball of the pinned commit, kept only when its sha256 matches; an install that holds that commit
# already (a git clone from v0.1 to v0.5, or this tarball) keeps it.
PETTA_HAS=$(cat "$OH/PeTTa/.omegahive-commit" 2>/dev/null || git -C "$OH/PeTTa" rev-parse HEAD 2>/dev/null || true)
if [ "$PETTA_HAS" != "$PETTA_COMMIT" ]; then
  fetching "PeTTa" 1
  pin_fetch "$(petta_url)" "$PETTA_SHA256" "$BUILD/petta.tar.gz"
  fetched
  rm -rf "$OH/PeTTa.new" && mkdir -p "$OH/PeTTa.new"
  tar -xzf - -C "$OH/PeTTa.new" --strip-components 1 < "$BUILD/petta.tar.gz"
  printf '%s\n' "$PETTA_COMMIT" > "$OH/PeTTa.new/.omegahive-commit"
  rm -rf "$OH/PeTTa"
  mv "$OH/PeTTa.new" "$OH/PeTTa"
fi
unquarantine "$OH/PeTTa"

step "installing the hive's Python packages into $OH/venv"
# The packages are this release's hash-locked list for this Mac: hive/requirements.txt and what the minds import, at the
# versions of the Linux installer's release lock, wheels only, every file checked by its sha256
# (install/macos/python-lock.py makes the list). janus-swi comes after, built for this SWI-Prolog. A refresh whose
# release locks the same list installs none.
PYLOCK=$SCRIPT_DIR/locks/python-$PLATFORM.txt
REQUIREMENTS=$(sha1 < "$PYLOCK" | cut -c1-40)
if [ "$REFRESH" = 1 ] && [ "$(sed -n 's/^requirements=//p' "$OH/installed")" = "$REQUIREMENTS" ] \
   && [ -x "$OH/venv/bin/python" ]; then
  say "The hive's Python packages are unchanged."
else
  # Made again from nothing, so the venv holds exactly the list: an older install's torch and the rest go with it.
  rm -rf "$OH/venv"
  "$TOOLCHAIN/bin/python3.12" -m venv "$OH/venv"
  fetching "the hive's Python packages" "$(sed -n 's/^# download: \([0-9]*\) MB$/\1/p' "$PYLOCK")"
  # uv's line for each of about a hundred packages goes to its own log, as the toolchain's does.
  SUBLOG=$OH/logs/python-packages.log
  uv pip install --python "$OH/venv/bin/python" --require-hashes --only-binary :all: -r "$PYLOCK" > "$SUBLOG" 2>&1
  SUBLOG=""
  fetched
fi
# Everything the release's hive asks for must now be installed: a list behind hive/requirements.txt stops here by name.
"$OH/venv/bin/python" -m pip install --dry-run --no-index -q -r "$OH/app/hive/requirements.txt" \
  || { say "This release's Python list lacks what hive/requirements.txt asks for (named above)."; false; }
# janus-swi is installed again on every run, for the SWI-Prolog this run uses: pip keeps an installed janus-swi of the
# same version, and one built for the other SWI-Prolog cannot load this one (a source-built janus finds libswipl only
# at the source layout's absolute path; dexter-head saw pip skip the wheel over it on the Mac mini).
if [ "$PREBUILT" = 1 ]; then
  (cd "$SCRIPT_DIR" && sha256 -c "$(basename "$JANUS_WHEEL").sha256" >/dev/null) \
    || { say "The prebuilt janus-swi does not match its checksum; download the release again"; false; }
  PATH="$OH/swipl/bin:$PATH" "$OH/venv/bin/python" -m pip install -q --no-index --force-reinstall --no-deps "$JANUS_WHEEL"
else
  # The source release by its PyPI sha256, built with the hash-locked build tools of the Linux installer
  # (locks/janus-build.lock is its ci/linux-x86/inputs/build.lock, release/hive-20261109, byte for byte).
  printf 'janus-swi==%s --hash=sha256:%s\n' "$JANUS_VERSION" "$JANUS_SWI_SDIST_SHA256" > "$BUILD/janus.req"
  "$OH/venv/bin/python" -m pip install -q --no-cache-dir --require-hashes -r "$SCRIPT_DIR/locks/janus-build.lock"
  PATH="$OH/swipl/bin:$PATH" "$OH/venv/bin/python" -m pip install -q --no-cache-dir --no-build-isolation \
    --force-reinstall --no-deps --require-hashes --no-binary janus-swi -r "$BUILD/janus.req"
fi
resign "$OH/venv/lib/python3.12/site-packages/janus_swi"
unquarantine "$OH/venv"

# The Omega core this release's minds run on (omegahive.sh core): set up again on every run, since a refresh brings
# app/ without it; from the release's own bundle, so it downloads nothing. git's lines go to their own log.
step "setting up the Omega core the minds run on"
SUBLOG=$OH/logs/omega-core.log
/bin/bash "$OH/app/install/macos/omegahive.sh" core > "$SUBLOG" 2>&1
SUBLOG=""
tail -n 1 "$OH/logs/omega-core.log"

step "checking the runtime: Python to Prolog, Prolog to Python, and a MeTTa program"
RUN="env PATH=$OH/swipl/bin:$OH/venv/bin:$PATH VIRTUAL_ENV=$OH/venv"
$RUN "$OH/venv/bin/python" -c 'import janus_swi as j; r = j.query_once("X is 1+1"); assert r.get("X") == 2, r'
test "$($RUN "$OH/swipl/bin/swipl" -g 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt' 2>/dev/null)" = "42" \
  || { say "SWI-Prolog cannot call Python (library(janus))"; false; }
mkdir -p "$BUILD/check"
printf '(= (f $x) (+ $x 1))\n!(f 41)\n' > "$BUILD/check/check.metta"
OUT=$(cd "$BUILD/check" && $RUN sh "$OH/PeTTa/run.sh" "$BUILD/check/check.metta" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -n 1)
test "$OUT" = "42" || { say "PeTTa's check printed '$OUT', not 42"; false; }
say "Runtime checked: janus both ways, and MeTTa printed 42."

if [ -n "$UI_PID" ]; then
  step "finishing the hive's web page"
  wait "$UI_PID" || { say "The web page did not build. The end of $OH/logs/ui-build.log:"; tail -n 20 "$OH/logs/ui-build.log"; false; }
fi
test -f "$OH/app/hive/ui/dist/index.html" || { say "The web page is missing (hive/ui/dist/index.html)"; false; }

step "setting up your hive"
mkdir -p "$OH/data" && chmod 700 "$OH/data"
# The port: 8700, or the first in steps of 10 above it that is free with the port CODE_PORT_OFFSET above it, where
# Create's Code service will listen (pins.sh), so a service another hive left on 8724 cannot take a new hive's; kept
# in hive.env after the first run since the browser keeps the owner's session for that address. On a Mac a port is
# free when nothing answers on it (curl's 7 is a refused connection). In WSL a closed loopback port can time out
# instead (curl's 28 on every port under mirrored networking, measured on the test laptop), so there a port is free
# when this account can bind it and, under the Windows installer, Windows itself does not listen on it
# (OMEGAHIVE_WINDOWS_PORTS, from the Windows side).
port_free() {
  if [ "$OS" = Linux ]; then
    case " ${OMEGAHIVE_WINDOWS_PORTS:-} " in *" $1 "*) return 1 ;; esac
    "$TOOLCHAIN/bin/python3.12" -I -c 'import socket, sys; socket.socket().bind(("127.0.0.1", int(sys.argv[1])))' "$1" \
      2>/dev/null
    return
  fi
  code=0
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" || code=$?
  [ "$code" -eq 7 ]
}
if ! grep -q '^HIVE_PORT=' "$OH/hive.env" 2>/dev/null; then
  P=8700
  while ! { port_free "$P" && port_free "$((P + CODE_PORT_OFFSET))"; }; do
    P=$((P + 10)); [ "$P" -le 8890 ] || { say "No free port from 8700 to 8890"; false; }
  done
  printf 'HIVE_PORT=%s\n' "$P" > "$OH/hive.env"
fi
if [ "$OS" = Darwin ]; then
  cat > "$OH/Start OmegaHive.command" <<'EOF'
#!/bin/bash
# Purpose: start the hive in this folder if it is not running, and open it in the browser signed in as its owner.
OMEGAHIVE_HOME=$(cd "$(dirname "$0")" && pwd) exec /bin/bash "$(dirname "$0")/app/install/macos/omegahive.sh" open
EOF
  chmod 755 "$OH/Start OmegaHive.command"
fi

# On Linux the service runs as a systemd user unit (omegahive.sh start_code_unit), which the hive's guard reads there.
if [ -f "$CODE_TARBALL" ]; then
  step "setting up Create: the Code service your hive's minds build small apps with"
  (cd "$SCRIPT_DIR" && sha256 -c "$(basename "$CODE_TARBALL").sha256" >/dev/null) \
    || { say "Create's Code service does not match its checksum; download the release again"; false; }
  OMEGAHIVE_HOME=$OH /bin/bash "$SCRIPT_DIR/setup-code.sh" "$CODE_TARBALL"
fi
if [ -f "$TOOLS_TARBALL" ]; then
  step "installing Tools: the skills of thought your hive's minds can use"
  (cd "$SCRIPT_DIR" && sha256 -c "$(basename "$TOOLS_TARBALL").sha256" >/dev/null) \
    || { say "The Tools app does not match its checksum; download the release again"; false; }
  OMEGAHIVE_HOME=$OH /bin/bash "$SCRIPT_DIR/setup-tools.sh" "$TOOLS_TARBALL"
fi
if [ -f "$STUDIO_ZIP" ]; then
  step "installing Studio: the app your hive shows as Create, where you make things"
  (cd "$SCRIPT_DIR" && sha256 -c "$(basename "$STUDIO_ZIP").sha256" >/dev/null) \
    || { say "Studio does not match its checksum; download the release again"; false; }
  OMEGAHIVE_HOME=$OH /bin/bash "$SCRIPT_DIR/setup-studio.sh" "$STUDIO_ZIP"
fi
{ say "installed=$(date '+%Y-%m-%dT%H:%M:%S%z')"; say "source=$SRC"; say "release=$RELEASE"; say "requirements=$REQUIREMENTS"
  say "swipl=10.1.14 swipl_commit=$SWIPL_COMMIT petta=$PETTA_COMMIT janus_swi=$JANUS_VERSION micromamba=$MICROMAMBA_VERSION"
  if [ -f "$OH/code/config.json" ]; then say "create=$(sed -n 's/^HIVE_CODE_SERVICE_RELEASE=//p' "$OH/hive.env" | tail -n 1)"; fi
  if [ -f "$OH/apps/omega-tools/plugin.json" ]; then say "tools=omega-tools $OMEGA_TOOLS_VERSION $OMEGA_TOOLS_COMMIT"; fi
  if [ -f "$OH/apps/omegadesign/plugin.json" ]; then say "studio=omegadesign $OMEGADESIGN_VERSION"; fi
  say "python=$("$OH/venv/bin/python" -c 'import platform; print(platform.python_version())') node=$("$TOOLCHAIN/bin/node" --version)"; } > "$OH/installed"
rm -rf "$BUILD/swipl" "$BUILD/check"
say "This setup downloaded about $(( ($(rx_bytes) - RX_START) / 1048576 )) MB in all."

if [ "${OMEGAHIVE_FRONT:-}" = windows ]; then
  say ""
  say "Your hive is set up in $OH. Windows starts it and opens it in your browser next."
  exit 0
fi
step "adding Omega Hive to your Applications folder and Login Items"
register
step "starting your hive and opening it in your browser"
# Create is extra: a Code service that cannot enrol leaves the hive itself set up, and says so.
if [ -f "$OH/code/config.json" ]; then
  /bin/bash "$OH/app/install/macos/omegahive.sh" create \
    || say "Create's Code service could not be enrolled; the hive works without Create. Its log: $OH/code/logs/service.log"
fi
open_hive
say ""
say "Done. Your hive keeps running after you close this window."
if [ "$REGISTERED" = 1 ]; then
  say "To open it again, open Omega Hive from your Applications folder, Launchpad or Spotlight."
else
  say "To open it again, double-click \"Start OmegaHive\" in your OmegaHive folder ($OH)."
fi
say "To use real minds, add your AI key in the hive: You & your keys."
if [ -f "$OH/code/config.json" ]; then
  if [ -f "$OH/apps/omegadesign/plugin.json" ]; then
    say "To make something, open Create in your hive's apps; small apps it builds are in $OH/repos/small-app."
  else
    say "To have minds build a small app, open Code in the hive and ask Create; they build it in $OH/repos/small-app."
  fi
fi
