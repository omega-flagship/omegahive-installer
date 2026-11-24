#!/bin/bash
# Purpose: build SWI-Prolog 10.1.14 for Apple Silicon Macs as a relocatable bundle whose janus binds to the hive
# toolchain's conda-forge Python 3.12, plus a janus_swi 1.5.3 wheel linked to that bundle, both for the Mac
# installer's release zip, so a tester's Mac needs neither Command Line Tools nor a 10-minute source build.
#
# Usage: install/macos/build-swipl-bundle.sh [WORKDIR]
#        install/macos/build-swipl-bundle.sh --lock [ROLE...]   (remake locks/bundle-ROLE-osx-arm64.txt from the
#                                            specs below for each ROLE named, tools, py or deps, or all three)
#
#   WORKDIR (default ~/swipl-bundle-build) holds micromamba, three conda-forge environments, the source, the build
#   tree and the staged bundle. The outputs land in OUTDIR (default: this script's folder), each with a .sha256:
#     swipl-10.1.14-macos-arm64.tar.gz
#     janus_swi-1.5.3-cp312-cp312-macosx_11_0_arm64.whl
#
# Every download is pinned (pins.sh beside this script): micromamba by release and sha256, each conda package by URL
# and sha256 in locks/bundle-{tools,py,deps}-osx-arm64.txt, SWI-Prolog by commit, janus-swi by its source release's
# sha256 under pip's --require-hashes, built with the setuptools and wheel the py lock pins.
#
# It needs an Apple Silicon Mac with Apple's Command Line Tools (clang, git, otool, install_name_tool, codesign) and
# network access to conda-forge, GitHub and PyPI. Homebrew, MacPorts and /usr/local never reach the build: the
# compiler sees only the deps environment, and every Mach-O in the result is checked for foreign paths.
#
# The tarball's one root is swipl/; the installer unpacks it into the
# folder that also holds the toolchain environment and the venv ($OH in "Install OmegaHive.command"):
#
#   $OH/swipl/bin/swipl -> ../SWI-Prolog.app/Contents/MacOS/swipl
#   $OH/swipl/SWI-Prolog.app/Contents/
#     MacOS/swipl                     the real executable; the mind sandbox opens the folder two levels above it,
#                                     Contents, so everything swipl reads lives there
#     swipl.home                      "lib/swipl": swipl reads ../swipl.home beside its MacOS folder to find its home
#     lib/swipl/                      the home: boot.prc, library, include, lib/arm64-darwin/*.so
#     Frameworks/                     libswipl and the conda-forge dylibs it and the *.so need (gmp, openssl, ...):
#                                     swipl's prolog_config (apple_bundle_libdir) names Contents/Frameworks as the
#                                     C library folder of any swipl whose executable sits in Contents/MacOS, so
#                                     --dump-runtime-variables, pack builds and janus_swi's setup.py link it there
#   $OH/toolchain/envs/hive/lib       libpython3.12.dylib, which janus.so reaches by a relative rpath
#   $OH/venv                          where janus_swi is installed; its extension reaches libswipl relatively
#
# Every rpath is relative to the image holding it, and dyld resolves them from the real binary even when swipl
# runs through bin/swipl, so the tree works wherever $OH is.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/pins.sh"
# The environments' specs. The build installs only the locks made from them; --lock remakes the locks on purpose.
TOOLS_SPECS="cmake ninja pkg-config"
PY_SPECS="python=3.12 pip setuptools wheel"
# conda-forge names: libyaml is "yaml" there. libxml2 is here only because libarchive links it. Its build without ICU
# (hea22233) leaves out ICU's 35 MB of libraries.
DEPS_SPECS="gmp openssl yaml pcre2 libarchive zlib libxml2-16=2.15.4=hea22233_1"
if [ "${1:-}" = --lock ]; then
  shift
  [ "$#" -gt 0 ] || set -- tools py deps
  for role in "$@"; do
    case $role in tools) specs=$TOOLS_SPECS;; py) specs=$PY_SPECS;; deps) specs=$DEPS_SPECS;;
      *) echo "--lock takes tools, py or deps, not $role" >&2; exit 2;; esac
    # shellcheck disable=SC2086  # specs are words
    /bin/bash "$SCRIPT_DIR/conda-lock.sh" osx-arm64 "$SCRIPT_DIR/locks/bundle-$role-osx-arm64.txt" $specs
  done
  exit 0
fi
WORK=${1:-$HOME/swipl-bundle-build}
OUTDIR=${OUTDIR:-$SCRIPT_DIR}
SWIPL_VERSION=${SWIPL_TAG#V}
JANUS_VERSION=$JANUS_SWI_VERSION
# Where the installer puts the toolchain's lib folder and the venv, relative to the folder holding swipl/.
TOOLCHAIN_LIB=${TOOLCHAIN_LIB:-toolchain/envs/hive/lib}
VENV_DIR=${VENV_DIR:-venv}
# The packages every build takes (pins.sh).
PACKAGES=$SWIPL_PACKAGES

say() { printf '== %s\n' "$*"; }
die() { printf 'build-swipl-bundle: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || die "needs an Apple Silicon Mac, this is $(uname -s)/$(uname -m)"
xcrun --find clang >/dev/null 2>&1 || die "needs Apple's Command Line Tools: run xcode-select --install"
for tool in git curl otool install_name_tool codesign shasum; do
  command -v "$tool" >/dev/null || die "needs $tool"
done
case "$WORK$OUTDIR" in *" "*) die "WORKDIR and OUTDIR must not contain spaces (CMake and the rpaths quote nothing)";; esac

MAMBA_ROOT=$WORK/mamba
TOOLS=$WORK/envs/tools
PY=$WORK/envs/py
DEPS=$WORK/envs/deps
SRC=$WORK/src/swipl
BUILD=$WORK/build
STAGE=$WORK/stage            # stands for $OH: stage/swipl is packed, stage/toolchain is only for the checks
BUNDLE=$STAGE/swipl
CONTENTS=$BUNDLE/SWI-Prolog.app/Contents
LOGS=$WORK/logs
TARBALL=$OUTDIR/swipl-$SWIPL_VERSION-macos-arm64.tar.gz
mkdir -p "$WORK" "$LOGS" "$OUTDIR"

# Only Apple's tools and the tools environment are on PATH: no Homebrew compiler, cmake or pkg-config.
export PATH="$TOOLS/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export MAMBA_ROOT_PREFIX=$MAMBA_ROOT
# conda-forge's osx-arm64 libraries target macOS 11; build for the same floor.
export MACOSX_DEPLOYMENT_TARGET=11.0
unset PKG_CONFIG_PATH CPATH LIBRARY_PATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH PYTHONPATH PYTHONHOME VIRTUAL_ENV
export PKG_CONFIG_LIBDIR=$DEPS/lib/pkgconfig

say "micromamba and the conda-forge environments in $WORK/envs"
MICROMAMBA=$MAMBA_ROOT/bin/micromamba
if [ ! -x "$MICROMAMBA" ]; then
  mkdir -p "$MAMBA_ROOT/bin"
  pin_fetch "$(micromamba_url osx-arm64)" "$(micromamba_sha256 osx-arm64)" "$MICROMAMBA" || die "micromamba did not match its pin"
  chmod 755 "$MICROMAMBA"
fi
# Three environments keep three roles apart: tools runs the build (its own ncurses and zlib must not be linked),
# py is the Python janus compiles against, and deps holds exactly the libraries the bundle carries. Each comes from
# its lock, so micromamba installs those exact builds and refuses a file whose sha256 differs.
make_env() {
  local prefix=$1 lock digest
  lock=$SCRIPT_DIR/locks/bundle-$(basename "$1")-osx-arm64.txt
  [ -f "$lock" ] || die "no lock $lock: run $0 --lock"
  # An environment is reused only while it was made from its lock as the lock stands now; one made from an older
  # lock is made again, so a changed lock always reaches the build.
  digest=$(sha256 "$lock" | cut -d' ' -f1)
  [ -f "$prefix/conda-meta/history" ] && [ "$(cat "$prefix/.omegahive-lock-sha256" 2>/dev/null)" = "$digest" ] && return 0
  rm -rf "$prefix"
  "$MICROMAMBA" create -y --no-rc -p "$prefix" -f "$lock" > "$LOGS/env-$(basename "$prefix").log" 2>&1 \
    || die "micromamba could not create $prefix (see $LOGS/env-$(basename "$prefix").log)"
  echo "$digest" > "$prefix/.omegahive-lock-sha256"
}
make_env "$TOOLS"
make_env "$PY"
make_env "$DEPS"
PYVER=$("$PY/bin/python3" -I -c 'import sys; print("%d.%d" % sys.version_info[:2])')
PYEXE=$PY/bin/python$PYVER
[ -f "$PY/lib/libpython$PYVER.dylib" ] || die "$PY has no libpython$PYVER.dylib"

say "swipl-devel $SWIPL_TAG with packages: $PACKAGES"
if [ ! -d "$SRC/.git" ]; then
  git clone -q --depth 1 --branch "$SWIPL_TAG" https://github.com/SWI-Prolog/swipl-devel.git "$SRC"
fi
# The tag is how GitHub serves it; the pinned commit is what is built. Each submodule is the commit the tag records.
[ "$(git -C "$SRC" rev-parse HEAD)" = "$SWIPL_COMMIT" ] || die "$SRC is at $(git -C "$SRC" rev-parse HEAD), not the pinned $SWIPL_COMMIT"
for m in $PACKAGES; do echo "packages/$m"; done | (cd "$SRC" && xargs git submodule update --init --depth 1 -q)

say "configure (log: $LOGS/cmake.log)"
rm -rf "$BUILD" "$STAGE"
# MACOSX_DEPENDENCIES_FROM is swipl's own switch for a private dependency prefix (cmake/port/Darwin.cmake): it puts
# deps on the search path and ignores /opt/homebrew, /opt/local and /usr/local. CMAKE_IGNORE_PREFIX_PATH also drops
# the tools environment, which CMake would otherwise search as its own install prefix.
cmake -G Ninja -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$CONTENTS" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
  -DMACOSX_DEPENDENCIES_FROM="$DEPS" -DCMAKE_PREFIX_PATH="$DEPS" \
  -DCMAKE_IGNORE_PREFIX_PATH="$TOOLS;$PY;/opt/homebrew;/usr/local;/opt/local" \
  -DCMAKE_FIND_FRAMEWORK=NEVER -DCMAKE_FIND_APPBUNDLE=NEVER \
  -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF -DSWIPL_PACKAGES_QT=OFF \
  -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF \
  -DPython_EXECUTABLE="$PYEXE" -DPython_ROOT_DIR="$PY" -DPython_FIND_FRAMEWORK=NEVER \
  -DPython3_EXECUTABLE="$PYEXE" -DPython3_ROOT_DIR="$PY" -DPython3_FIND_FRAMEWORK=NEVER \
  > "$LOGS/cmake.log" 2>&1 || die "cmake failed (see $LOGS/cmake.log)"
# janus looks for "Python", not "Python3": a miss here builds a swipl whose library(janus) is absent.
grep -q "^_Python_INCLUDE_DIR:INTERNAL=$PY/" "$BUILD/CMakeCache.txt" || die "janus would not build against $PY"

say "build and install into $CONTENTS (logs: $LOGS/ninja.log, $LOGS/install.log)"
ninja -C "$BUILD" > "$LOGS/ninja.log" 2>&1 || die "build failed (see $LOGS/ninja.log)"
[ -f "$BUILD/packages/swipy/janus.so" ] || die "janus was not built"
ninja -C "$BUILD" install > "$LOGS/install.log" 2>&1 || die "install failed (see $LOGS/install.log)"

say "arrange SWI-Prolog.app"
HOME_REL=lib/swipl
ARCH=$(basename "$(ls -d "$CONTENTS/$HOME_REL/lib"/*-darwin)")
[ "$ARCH" = arm64-darwin ] || die "unexpected architecture folder $ARCH"
mkdir -p "$CONTENTS/MacOS"
mv "$CONTENTS/$HOME_REL/bin/$ARCH/swipl" "$CONTENTS/MacOS/swipl"
ln -s ../../../../MacOS/swipl "$CONTENTS/$HOME_REL/bin/$ARCH/swipl"
printf '%s\n' "$HOME_REL" > "$CONTENTS/swipl.home"
mkdir -p "$CONTENTS/Frameworks"
mv "$CONTENTS/$HOME_REL/lib/$ARCH"/libswipl*.dylib "$CONTENTS/Frameworks/"
# CMake's bin links, pkg-config file and CMake package name the staging path, which no tester's Mac has.
rm -rf "${CONTENTS:?}/bin" "${CONTENTS:?}/lib/cmake" "${CONTENTS:?}/share/pkgconfig"
mkdir -p "$BUNDLE/bin"
ln -s ../SWI-Prolog.app/Contents/MacOS/swipl "$BUNDLE/bin/swipl"
ln -s "../SWI-Prolog.app/Contents/$HOME_REL/bin/$ARCH/swipl-ld" "$BUNDLE/bin/swipl-ld"

# The fixup and the check are one rule set read two ways: every non-macOS reference is @rpath/<name>, found in
# Contents/Frameworks, or for libpython only, in the toolchain folder beside swipl/; every Mach-O carries exactly
# the rpaths to those of the two places it uses, each relative to itself.
cat > "$WORK/macho.py" <<'PY'
"""Bundle the conda-forge dylibs swipl references, rewrite every rpath relative to its image, and check the tree.

Usage: python -I macho.py fix|check BUNDLE DEPS_LIB TOOLCHAIN_LIB_REL
Time: one otool -l per Mach-O per pass, n = Mach-O files (about 60); the fix pass repeats until no new dylib is
copied, at most the depth of the dependency graph (3 here).
"""
import os, re, shutil, stat, subprocess, sys

SYSTEM = ("/usr/lib/", "/System/")
DEP_CMDS = {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LAZY_LOAD_DYLIB", "LC_LOAD_UPWARD_DYLIB"}
PYLIB = re.compile(r"libpython3\.\d+\.dylib$")


def is_macho(path):
    with open(path, "rb") as f:
        return f.read(4) in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe")


def load_commands(path):
    """Return (id, [deps], [rpaths]) from otool -l, whose records are 'cmd X' followed by 'name P' or 'path P'."""
    out = subprocess.run(["otool", "-l", path], check=True, capture_output=True, text=True).stdout
    ident, deps, rpaths, cmd = None, [], [], None
    for line in out.splitlines():
        words = line.split()
        if len(words) >= 2 and words[0] == "cmd":
            cmd = words[1]
        elif len(words) >= 2 and words[0] in ("name", "path"):
            value = line.split(None, 1)[1].rsplit(" (offset", 1)[0]
            if cmd == "LC_ID_DYLIB":
                ident = value
            elif cmd in DEP_CMDS:
                deps.append(value)
            elif cmd == "LC_RPATH":
                rpaths.append(value)
    return ident, deps, rpaths


class Tree:
    def __init__(self, bundle, deps_lib, toolchain_rel):
        # abspath, not realpath: the staged toolchain folder is a link to the py environment and must stay itself.
        self.bundle = os.path.abspath(bundle)
        self.contents = os.path.join(self.bundle, "SWI-Prolog.app", "Contents")
        self.frameworks = os.path.join(self.contents, "Frameworks")
        self.toolchain_lib = os.path.normpath(os.path.join(os.path.dirname(self.bundle), toolchain_rel))
        self.deps_lib = deps_lib

    def machos(self):
        for root, dirs, files in os.walk(self.contents):
            for name in files:
                path = os.path.join(root, name)
                if not os.path.islink(path) and is_macho(path):
                    yield path

    def rel(self, target, image):
        r = os.path.relpath(target, os.path.dirname(image))
        return "@loader_path" if r == "." else "@loader_path/" + r

    def wanted(self, image, deps):
        """The rpaths image needs: one per place its @rpath references live, Frameworks first."""
        need = [self.toolchain_lib if PYLIB.match(os.path.basename(d)) else self.frameworks
                for d in deps if not d.startswith(SYSTEM)]
        out = []
        for place in sorted(set(need), key=need.index):
            r = self.rel(place, image)
            if r not in out:
                out.append(r)
        return out


def run(*args):
    subprocess.run(args, check=True, capture_output=True, text=True)


def fix(tree):
    os.makedirs(tree.frameworks, exist_ok=True)
    todo, touched, seen = list(tree.machos()), set(), set()
    while todo:
        image = todo.pop()
        if image in seen:
            continue
        seen.add(image)
        ident, deps, rpaths = load_commands(image)
        args = []
        for d in deps:
            base = os.path.basename(d)
            if d.startswith(SYSTEM):
                continue
            want = "@rpath/" + base
            if not PYLIB.match(base):
                dst = os.path.join(tree.frameworks, base)
                if not os.path.exists(dst):
                    src = d if d.startswith("/") else os.path.join(tree.deps_lib, base)
                    if not os.path.exists(src):
                        sys.exit(f"{image} needs {d}, which is not in {tree.deps_lib}")
                    shutil.copyfile(os.path.realpath(src), dst)
                    os.chmod(dst, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
                    run("install_name_tool", "-id", want, dst)
                    touched.add(dst)
                    todo.append(dst)
                    print(f"bundled {base} from {src}")
            if d != want:
                args += ["-change", d, want]
        wanted = tree.wanted(image, deps)
        # Keep one copy of each wanted rpath: dyld rejects or warns on duplicate LC_RPATH entries.
        have = []
        for r in rpaths:
            if r.rstrip("/") not in wanted or r.rstrip("/") in have:
                args += ["-delete_rpath", r]
            else:
                have.append(r.rstrip("/"))
        for r in wanted:
            if r not in have:
                args += ["-add_rpath", r]
        if ident and ident.startswith("/"):
            args += ["-id", "@rpath/" + os.path.basename(ident)]
        if args:
            run("install_name_tool", *args, image)
            touched.add(image)
    for image in sorted(touched):
        run("codesign", "--force", "--sign", "-", image)
    print(f"fixed {len(touched)} of {len(seen)} Mach-O files")


def resolve(tree, image, dep, rpaths):
    if dep.startswith("/"):
        return dep if os.path.exists(dep) else None
    rest = dep.split("/", 1)[1]
    if dep.startswith("@loader_path/"):
        cands = [os.path.join(os.path.dirname(image), rest)]
    elif dep.startswith("@rpath/"):
        cands = [os.path.join(r.replace("@loader_path", os.path.dirname(image), 1), rest) for r in rpaths]
    else:
        return None
    for c in cands:
        if os.path.exists(c):
            return os.path.normpath(c)
    return None


def check(tree):
    problems, count = [], 0
    inside = (tree.contents + os.sep,)
    for image in tree.machos():
        count += 1
        ident, deps, rpaths = load_commands(image)
        if ident and not ident.startswith("@rpath/"):
            problems.append(f"{image}: install name {ident} is not @rpath/, so whatever links it records that path")
        if len(set(rpaths)) != len(rpaths):
            problems.append(f"{image}: duplicate rpaths {rpaths}")
        for r in rpaths:
            if not r.startswith("@loader_path"):
                problems.append(f"{image}: rpath {r} is not relative to the image")
        for d in deps:
            if d.startswith(SYSTEM):
                continue
            if not d.startswith("@rpath/"):
                problems.append(f"{image}: references {d} by a fixed path")
                continue
            hit = resolve(tree, image, d, rpaths)
            base = os.path.basename(d)
            if PYLIB.match(base):
                ok = hit is not None and hit.startswith(tree.toolchain_lib + os.sep)
                if not image.endswith("/janus.so"):
                    problems.append(f"{image}: only janus.so may link {base}")
            else:
                ok = hit is not None and hit.startswith(inside)
            if not ok:
                problems.append(f"{image}: {d} resolves to {hit}")
        signed = subprocess.run(["codesign", "--verify", "--strict", image], capture_output=True, text=True)
        if signed.returncode != 0:
            problems.append(f"{image}: codesign --verify: {signed.stderr.strip()}")
    for p in problems:
        print("PROBLEM", p)
    print(f"checked {count} Mach-O files, {len(problems)} problems")
    return not problems and count > 0


if __name__ == "__main__":
    mode, bundle, deps_lib, toolchain_rel = sys.argv[1:5]
    tree = Tree(bundle, deps_lib, toolchain_rel)
    if mode == "fix":
        fix(tree)
    elif not check(tree):
        sys.exit(1)
PY

say "bundle the conda-forge dylibs, make every rpath relative, ad-hoc sign (log: $LOGS/fixup.log)"
"$PYEXE" -I "$WORK/macho.py" fix "$BUNDLE" "$DEPS/lib" "$TOOLCHAIN_LIB" > "$LOGS/fixup.log" 2>&1 \
  || { tail -5 "$LOGS/fixup.log" >&2; die "fixup failed (see $LOGS/fixup.log)"; }

say "check the tree: every reference inside it, in macOS, or libpython in $TOOLCHAIN_LIB"
# The checks need the toolchain beside swipl/ as the installer makes it; stage/toolchain stands in for it here.
mkdir -p "$STAGE/$(dirname "$TOOLCHAIN_LIB")"
ln -sfn "$PY/lib" "$STAGE/$TOOLCHAIN_LIB"
"$PYEXE" -I "$WORK/macho.py" check "$BUNDLE" "$DEPS/lib" "$TOOLCHAIN_LIB" > "$LOGS/check.log" 2>&1 \
  || { grep PROBLEM "$LOGS/check.log" | head -20 >&2; die "the bundle has foreign references (see $LOGS/check.log)"; }
tail -1 "$LOGS/check.log"
if grep -r -l -E '/opt/homebrew|/usr/local/(opt|Cellar)|/opt/local/' "$CONTENTS" > "$LOGS/foreign-paths.log" 2>/dev/null; then
  head "$LOGS/foreign-paths.log" >&2
  die "files in the bundle name Homebrew, MacPorts or /usr/local paths"
fi

say "run it: version, every package loads, janus calls Python $PYVER"
SWIPL="$BUNDLE/bin/swipl"
"$SWIPL" --version | grep -q "version $SWIPL_VERSION for arm64-darwin" || die "bin/swipl is not $SWIPL_VERSION"
# Every foreign library the build installed must load: dlopen resolves all of its references, so this is the
# runtime twin of macho.py's check. The list comes from the tree, not from a list kept by hand. Each capture below keeps
# going when swipl fails, so die says which check it was.
FOREIGN=$(cd "$CONTENTS/$HOME_REL/lib/$ARCH" && ls *.so | sed 's/\.so$//' | paste -sd, -)
LOADED=$("$SWIPL" -g "forall(member(L, [$FOREIGN]), load_foreign_library(foreign(L))), writeln(ok), halt" 2>&1 | tail -1) || true
[ "$LOADED" = ok ] || die "a foreign library did not load: $LOADED"
JANUS=$("$SWIPL" -g 'use_module(library(janus)), py_call(sys:version, V), split_string(V, " ", "", [N|_]), writeln(N), halt' 2>&1 | tail -1) || true
case "$JANUS" in "$PYVER".*) ;; *) die "janus did not run Python $PYVER: $JANUS";; esac
LIBS=$("$SWIPL" -g 'forall(member(L, [ssl, crypto, pcre, yaml, archive, zlib, sgml, process, editline, uuid, sha, md5, readutil, socket, http/json, http/http_open]), use_module(library(L))), writeln(ok), halt' 2>&1 | tail -1) || true
[ "$LIBS" = ok ] || die "a package library did not load: $LIBS"
say "janus runs Python $JANUS; ssl, crypto, pcre, yaml, archive, zlib and the rest load"

say "pack $TARBALL"
# macOS runs this under bash 3.2, whose parser ends $( ... ) at a case pattern's ")", so the list is built here.
BUNDLED=
for f in "$CONTENTS"/Frameworks/*; do
  case $(basename "$f") in libswipl*) ;; *) BUNDLED="$BUNDLED $(basename "$f")";; esac
done
{
  echo "SWI-Prolog $SWIPL_VERSION ($SWIPL_TAG, $(git -C "$SRC" rev-parse HEAD)) for arm64-darwin, built $(date -u +%Y-%m-%dT%H:%M:%SZ) on macOS $(sw_vers -productVersion)"
  echo "packages: $PACKAGES"
  echo "janus: Python $("$PYEXE" -I -c 'import platform; print(platform.python_version())') from conda-forge; libpython found at \$OH/$TOOLCHAIN_LIB"
  echo "Contents/Frameworks, besides libswipl:$BUNDLED"
  echo "copied from this conda-forge environment:"
  "$MICROMAMBA" list --no-rc -p "$DEPS" 2>/dev/null | awk 'NF>=4 && $1 !~ /^(Name|─|List)/ {print "  " $1 " " $2 " " $3}'
} > "$BUNDLE/BUILD-INFO.txt"
rm -f "$TARBALL" "$TARBALL.sha256"
COPYFILE_DISABLE=1 tar -C "$STAGE" --no-xattrs -czf "$TARBALL" swipl
(cd "$OUTDIR" && shasum -a 256 "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")

say "janus_swi $JANUS_VERSION wheel against the bundle"
WHEELS=$WORK/wheels
rm -rf "$WHEELS" && mkdir -p "$WHEELS/raw" "$WHEELS/unpacked"
# setup.py runs `swipl --dump-runtime-variables` from PATH and links libswipl with an absolute rpath to PLLIBDIR.
# --require-hashes takes only the pinned source release; --no-build-isolation builds it with the py lock's
# setuptools and wheel instead of whatever pip would fetch for an isolated build.
printf 'janus-swi==%s --hash=sha256:%s\n' "$JANUS_VERSION" "$JANUS_SWI_SDIST_SHA256" > "$WHEELS/requirements.txt"
PATH="$BUNDLE/bin:$PATH" "$PYEXE" -I -m pip wheel --no-deps --no-binary janus-swi --no-build-isolation --require-hashes \
  --no-cache-dir -q -w "$WHEELS/raw" -r "$WHEELS/requirements.txt" > "$LOGS/wheel.log" 2>&1 \
  || die "pip wheel failed (see $LOGS/wheel.log)"
RAW=$(ls "$WHEELS/raw/janus_swi-$JANUS_VERSION-"*.whl)
"$PYEXE" -I -m wheel unpack -d "$WHEELS/unpacked" "$RAW" > /dev/null
EXT=$(ls "$WHEELS"/unpacked/janus_swi-"$JANUS_VERSION"/janus_swi/_swipl*.so)
# Installed, the extension sits in $OH/VENV_DIR/lib/pythonX.Y/site-packages/janus_swi; libswipl in Frameworks.
REL=$("$PYEXE" -I -c 'import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
  "/OH/swipl/SWI-Prolog.app/Contents/Frameworks" "/OH/$VENV_DIR/lib/python$PYVER/site-packages/janus_swi")
ARGS=()
while read -r rp; do ARGS+=(-delete_rpath "$rp"); done < <(otool -l "$EXT" | awk '$1=="cmd"{c=$2} $1=="path" && c=="LC_RPATH"{print $2}')
# ${ARGS[@]+...}: bash 3.2 under set -u calls an empty array unbound.
install_name_tool ${ARGS[@]+"${ARGS[@]}"} -add_rpath "@loader_path/$REL" "$EXT"
codesign --force --sign - "$EXT"
otool -L "$EXT" | grep -q '@rpath/libswipl' || die "the janus_swi extension does not link @rpath/libswipl"
rm -f "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*.whl "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*.whl.sha256
"$PYEXE" -I -m wheel pack -d "$OUTDIR" "$WHEELS/unpacked/janus_swi-$JANUS_VERSION" > /dev/null
WHEEL=$(ls "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*.whl)
(cd "$OUTDIR" && shasum -a 256 "$(basename "$WHEEL")" > "$(basename "$WHEEL").sha256")

say "check the tarball and wheel unpacked elsewhere, as a tester's Mac runs them (log: $LOGS/check-relocated.log)"
rm -rf "$WORK/check" && mkdir -p "$WORK/check"
bash "$SCRIPT_DIR/check-swipl-bundle.sh" "$TARBALL" "$WHEEL" "$PY" "$WORK/check" > "$LOGS/check-relocated.log" 2>&1 \
  || { tail -5 "$LOGS/check-relocated.log" >&2; die "the relocated check failed (see $LOGS/check-relocated.log)"; }
grep '^ok: ' "$LOGS/check-relocated.log"

say "done"
cat "$TARBALL.sha256" "$WHEEL.sha256"
ls -l "$TARBALL" "$WHEEL"
