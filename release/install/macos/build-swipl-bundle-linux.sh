#!/bin/bash
# Purpose: build SWI-Prolog 10.1.14 for Linux x86_64 as a relocatable bundle whose janus binds to the hive
# toolchain's conda-forge Python 3.12, plus a janus_swi 1.5.3 wheel linked to that bundle, both for the Windows
# installer's release: its WSL distro runs "Install OmegaHive.command" on Linux, which unpacks them instead of cloning
# SWI-Prolog's sources and their package submodules from GitHub and compiling them. The Linux twin of
# build-swipl-bundle.sh.
#
# Usage: install/macos/build-swipl-bundle-linux.sh [WORKDIR]
#        install/macos/build-swipl-bundle-linux.sh --lock [ROLE...]   (remake locks/bundle-ROLE-linux-64.txt from
#                                                  the specs below for each ROLE named, tools, py or deps, or all three)
#
#   WORKDIR (default ~/swipl-bundle-build-linux) holds micromamba, three conda-forge environments, the source, the
#   build tree and the staged bundle. The outputs land in OUTDIR (default: this script's folder), each with a .sha256:
#     swipl-10.1.14-linux-x86_64.tar.gz
#     janus_swi-1.5.3-cp312-cp312-linux_x86_64.whl
#   JOBS (default: the cores this process may use) sets the build's parallelism.
#
# Every download is pinned as on the Mac (pins.sh beside this script): micromamba by release and sha256, each conda
# package by URL and sha256 in locks/bundle-{tools,py,deps}-linux-64.txt, SWI-Prolog by commit, janus-swi by its
# source release's sha256 under pip's --require-hashes.
#
# It needs a Linux x86_64 host with git, curl, tar and sha256sum, and network access to conda-forge, GitHub and PyPI.
# The compiler is conda-forge's GCC with the glibc 2.28 sysroot beside it, so the bundle asks for nothing newer than
# glibc 2.28 (Ubuntu 20.04 and later, the WSL distro's 26.04 among them); the host's own compiler, headers and
# libraries never reach the build, and every ELF file in the result is checked for references outside it. Every ELF
# file is also stripped of its symbol table and debug sections, which nothing reads at run time.
#
# The tarball's one root is swipl/; the installer unpacks it into the folder that also holds the toolchain environment
# and the venv ($OH in "Install OmegaHive.command"):
#
#   $OH/swipl/bin/swipl                    the real executable. A mind's sandbox reads the folder two levels above
#                                          it (hive/supervisor/sandbox.py runtime_roots), swipl/, so everything swipl
#                                          reads lives there
#   $OH/swipl/swipl.home                   "lib/swipl": swipl reads swipl.home two levels above its real executable
#                                          to find its home, so the compiled-in build path is never used
#   $OH/swipl/lib/swipl/                   the home: boot.prc, library, include, bin/x86_64-linux/swipl (a link to
#                                          ../../../../bin/swipl, for swipl-ld and pack builds)
#   $OH/swipl/lib/swipl/lib/x86_64-linux/  libswipl, the packages' *.so, and the conda-forge libraries they need,
#                                          each renamed with a hash of its bytes as auditwheel's repair does, so a
#                                          library of the same name the process loaded first (the toolchain Python's
#                                          own libssl, say) is never bound in its place
#   $OH/toolchain/envs/hive/lib            libpython3.12.so.1.0, which janus.so reaches by a relative RUNPATH; or
#   $OH/python/lib                         in the Linux kit, which keeps its Python there, so janus.so's RUNPATH names
#                                          it second: a mind's sandbox there shows only the folders it may read, which
#                                          hold python/ and not toolchain/ (hive/supervisor/landlock.py)
#   $OH/venv                               where janus_swi is installed; its extension reaches libswipl relatively
#
# Every RUNPATH is $ORIGIN-relative and the loader expands it from the file's own folder, so the tree works wherever
# $OH is, and the installer's $OH/swipl link to the folder it unpacked into changes nothing.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/pins.sh"
# The environments' specs. The build installs only the locks made from them; --lock remakes the locks on purpose.
# conda-forge's GCC compiles against the sysroot installed beside it, so the 2.28 sysroot is the oldest glibc the
# bundle runs on; binutils comes with the compiler.
TOOLS_SPECS="cmake ninja pkg-config patchelf c-compiler cxx-compiler sysroot_linux-64=2.28"
# The Python janus compiles against: the version the WSL toolchain's lock installs (locks/conda-linux-64.txt).
PY_SPECS="python=3.12.16 pip setuptools wheel"
# conda-forge names: libyaml is "yaml" there. libedit and the ncurses it links come from macOS itself on a Mac.
# libxml2 is here only because libarchive links it. Its build without ICU (hbdfff7e) leaves out ICU's 36 MB of
# libraries and the libstdc++ and libgcc_s that only ICU needs.
DEPS_SPECS="gmp openssl yaml pcre2 libarchive zlib libedit ncurses libxml2-16=2.15.4=hbdfff7e_1"
if [ "${1:-}" = --lock ]; then
  shift
  [ "$#" -gt 0 ] || set -- tools py deps
  for role in "$@"; do
    case $role in tools) specs=$TOOLS_SPECS;; py) specs=$PY_SPECS;; deps) specs=$DEPS_SPECS;;
      *) echo "--lock takes tools, py or deps, not $role" >&2; exit 2;; esac
    # shellcheck disable=SC2086  # specs are words
    /bin/bash "$SCRIPT_DIR/conda-lock.sh" linux-64 "$SCRIPT_DIR/locks/bundle-$role-linux-64.txt" $specs
  done
  exit 0
fi
WORK=${1:-$HOME/swipl-bundle-build-linux}
OUTDIR=${OUTDIR:-$SCRIPT_DIR}
JOBS=${JOBS:-$(nproc)}
SWIPL_VERSION=${SWIPL_TAG#V}
JANUS_VERSION=$JANUS_SWI_VERSION
# Where the installer puts the toolchain's lib folder and the venv, relative to the folder holding swipl/.
TOOLCHAIN_LIB=${TOOLCHAIN_LIB:-toolchain/envs/hive/lib}
# Where the Linux kit keeps its Python's lib folder, relative to the same folder (its install.py, runtime/python).
KIT_PYTHON_LIB=python/lib
VENV_DIR=${VENV_DIR:-venv}
ARCH=x86_64-linux
GLIBC_FLOOR=2.28

say() { printf '== %s\n' "$*"; }
die() { printf 'build-swipl-bundle-linux: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || die "needs a Linux x86_64 host, this is $(uname -s)/$(uname -m)"
for tool in git curl tar sha256sum; do
  command -v "$tool" >/dev/null || die "needs $tool"
done
case "$WORK$OUTDIR" in *" "*) die "WORKDIR and OUTDIR must not contain spaces (CMake and the RUNPATHs quote nothing)";; esac

MAMBA_ROOT=$WORK/mamba
TOOLS=$WORK/envs/tools
PY=$WORK/envs/py
DEPS=$WORK/envs/deps
SRC=$WORK/src/swipl
BUILD=$WORK/build
STAGE=$WORK/stage            # stands for $OH: stage/swipl is packed, stage/toolchain is only for the checks
BUNDLE=$STAGE/swipl
HOME_REL=lib/swipl
LIBDIR=$BUNDLE/$HOME_REL/lib/$ARCH
LOGS=$WORK/logs
TARBALL=$OUTDIR/swipl-$SWIPL_VERSION-linux-x86_64.tar.gz
mkdir -p "$WORK" "$LOGS" "$OUTDIR"

# Only the tools environment and the system's own git, curl and tar are on PATH; the compilers are named below, so
# no /usr/bin compiler, cmake or pkg-config is ever picked up.
export PATH="$TOOLS/bin:/usr/bin:/bin"
export MAMBA_ROOT_PREFIX=$MAMBA_ROOT
unset PKG_CONFIG_PATH CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH LD_LIBRARY_PATH LD_PRELOAD PYTHONPATH \
  PYTHONHOME VIRTUAL_ENV CFLAGS CXXFLAGS CPPFLAGS LDFLAGS
export PKG_CONFIG_LIBDIR=$DEPS/lib/pkgconfig

say "micromamba and the conda-forge environments in $WORK/envs"
MICROMAMBA=$MAMBA_ROOT/bin/micromamba
if [ ! -x "$MICROMAMBA" ]; then
  mkdir -p "$MAMBA_ROOT/bin"
  pin_fetch "$(micromamba_url linux-64)" "$(micromamba_sha256 linux-64)" "$MICROMAMBA" || die "micromamba did not match its pin"
  chmod 755 "$MICROMAMBA"
fi
# Three environments keep three roles apart, as on the Mac: tools runs the build, py is the Python janus compiles
# against, and deps holds exactly the libraries the bundle carries. Each comes from its lock, so micromamba installs
# those exact builds and refuses a file whose sha256 differs.
make_env() {
  local prefix=$1 lock digest
  lock=$SCRIPT_DIR/locks/bundle-$(basename "$1")-linux-64.txt
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
[ -f "$PY/lib/libpython$PYVER.so.1.0" ] || die "$PY has no libpython$PYVER.so.1.0"
CC=$TOOLS/bin/x86_64-conda-linux-gnu-cc
CXX=$TOOLS/bin/x86_64-conda-linux-gnu-c++
PATCHELF=$TOOLS/bin/patchelf
READELF=$TOOLS/bin/x86_64-conda-linux-gnu-readelf
STRIP=$TOOLS/bin/x86_64-conda-linux-gnu-strip
for tool in "$CC" "$CXX" "$PATCHELF" "$READELF" "$STRIP"; do [ -x "$tool" ] || die "the tools environment has no $tool"; done
SYSROOT=$("$CC" -print-sysroot)
SYSROOT_GLIBC=$(awk '$2 == "__GLIBC__" {M=$3} $2 == "__GLIBC_MINOR__" {m=$3} END {print M "." m}' "$SYSROOT/usr/include/features.h")
[ "$SYSROOT_GLIBC" = "$GLIBC_FLOOR" ] || die "the compiler's sysroot is glibc $SYSROOT_GLIBC, not $GLIBC_FLOOR"

say "swipl-devel $SWIPL_TAG with packages: $SWIPL_PACKAGES"
if [ ! -d "$SRC/.git" ]; then
  git clone -q --depth 1 --branch "$SWIPL_TAG" https://github.com/SWI-Prolog/swipl-devel.git "$SRC"
fi
# The tag is how GitHub serves it; the pinned commit is what is built. Each submodule is the commit the tag records.
[ "$(git -C "$SRC" rev-parse HEAD)" = "$SWIPL_COMMIT" ] || die "$SRC is at $(git -C "$SRC" rev-parse HEAD), not the pinned $SWIPL_COMMIT"
for m in $SWIPL_PACKAGES; do echo "packages/$m"; done | (cd "$SRC" && xargs git submodule update --init --depth 1 -q)

say "configure (log: $LOGS/cmake.log)"
rm -rf "$BUILD" "$STAGE"
# The deps environment is the one place libraries are found. CMAKE_IGNORE_PREFIX_PATH drops the host's /usr, /usr/local
# and /opt and the tools and py environments, which CMake would otherwise search; the compiler's own sysroot holds glibc
# alone. -rpath-link lets the linker follow a deps library's own dependencies (libarchive's xz and zstd) at link time.
LINK="-Wl,-rpath-link,$DEPS/lib"
cmake -G Ninja -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$BUNDLE" \
  -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
  -DCMAKE_PREFIX_PATH="$DEPS" \
  -DCMAKE_IGNORE_PREFIX_PATH="$TOOLS;$PY;/usr;/usr/local;/opt" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK" -DCMAKE_SHARED_LINKER_FLAGS="$LINK" -DCMAKE_MODULE_LINKER_FLAGS="$LINK" \
  -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF -DSWIPL_PACKAGES_QT=OFF \
  -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF \
  -DPython_EXECUTABLE="$PYEXE" -DPython_ROOT_DIR="$PY" \
  -DPython3_EXECUTABLE="$PYEXE" -DPython3_ROOT_DIR="$PY" \
  > "$LOGS/cmake.log" 2>&1 || die "cmake failed (see $LOGS/cmake.log)"
# janus looks for "Python", not "Python3": a miss here builds a swipl whose library(janus) is absent.
grep -q "^_Python_INCLUDE_DIR:INTERNAL=$PY/" "$BUILD/CMakeCache.txt" || die "janus would not build against $PY"
# Every library or header folder the configure found is the deps environment's, the py environment's for janus, or
# the sysroot's glibc: one from the host or the tools environment would be linked from the build machine.
"$PYEXE" -I - "$BUILD/CMakeCache.txt" "$DEPS" "$PY" "$SYSROOT" > "$LOGS/cmake-found.log" <<'PY' || { cat "$LOGS/cmake-found.log" >&2; die "the configure found libraries outside the deps environment"; }
import re, sys
cache, allowed = sys.argv[1], [p.rstrip("/") + "/" for p in sys.argv[2:]]
bad = []
for line in open(cache):
    m = re.match(r"^([A-Za-z0-9_]+(?:LIBRARY|LIBRARIES|INCLUDE_DIR|INCLUDE_DIRS)[A-Za-z0-9_]*):(?:FILEPATH|PATH|STRING)=(/.*)$", line.strip())
    if m and not any((v + "/").startswith(a) for v in m.group(2).split(";") for a in allowed):
        bad.append(m.group(1) + " = " + m.group(2))
print("\n".join(bad) if bad else "every library and header folder is the deps, py or sysroot's")
sys.exit(1 if bad else 0)
PY

say "build and install into $BUNDLE (logs: $LOGS/ninja.log, $LOGS/install.log)"
ninja -C "$BUILD" -j "$JOBS" > "$LOGS/ninja.log" 2>&1 || die "build failed (see $LOGS/ninja.log)"
[ -f "$BUILD/packages/swipy/janus.so" ] || die "janus was not built"
ninja -C "$BUILD" install > "$LOGS/install.log" 2>&1 || die "install failed (see $LOGS/install.log)"

say "arrange the bundle"
[ -x "$BUNDLE/$HOME_REL/bin/$ARCH/swipl" ] && [ -d "$LIBDIR" ] || die "the install left no $HOME_REL/bin/$ARCH/swipl or $HOME_REL/lib/$ARCH"
ls "$LIBDIR"/libswipl.so.* > /dev/null 2>&1 || die "libswipl is not in $LIBDIR"
# CMake's bin links, pkg-config file and CMake package name the staging path, which no tester's computer has.
rm -rf "${BUNDLE:?}/bin" "${BUNDLE:?}/lib/cmake" "${BUNDLE:?}/share/pkgconfig"
mkdir -p "$BUNDLE/bin"
mv "$BUNDLE/$HOME_REL/bin/$ARCH/swipl" "$BUNDLE/bin/swipl"
ln -s ../../../../bin/swipl "$BUNDLE/$HOME_REL/bin/$ARCH/swipl"
ln -s "../$HOME_REL/bin/$ARCH/swipl-ld" "$BUNDLE/bin/swipl-ld"
printf '%s\n' "$HOME_REL" > "$BUNDLE/swipl.home"

# The fixup and the check are one rule set read two ways, as macho.py's are on the Mac: every library a bundle file
# needs is glibc's, or one in lib/x86_64-linux (libswipl or a bundled copy), or for janus.so alone libpython in the
# toolchain folder or the Linux kit's python folder beside swipl/; every ELF file carries exactly the RUNPATH entries
# to the places it uses, each relative to itself, janus.so both of libpython's in that order; nothing asks glibc for
# a version newer than the sysroot's; and no ELF file keeps a symbol table or debug sections.
cat > "$WORK/elf.py" <<'PY'
"""Strip swipl's ELF files, bundle the conda-forge libraries they need, stripped too, under names carrying a hash of
their original bytes, make every RUNPATH relative to the file holding it, and check the tree: the Linux twin of
build-swipl-bundle.sh's macho.py.

Usage: python -I elf.py fix|check BUNDLE LIBDIR DEPS_LIB PYTHON_LIB_RELS GLIBC_FLOOR PATCHELF READELF STRIP
PYTHON_LIB_RELS names the folders libpython may be in, relative to the folder holding the bundle, joined by ":".
Time: one strip per ELF file, n = ELF files (about 55), two patchelf reads per file per pass, one patchelf write per
change, and in the check two readelf runs per file; the fix pass repeats until no new library is copied, at most the
depth of the dependency graph.
"""
import hashlib, os, re, shutil, subprocess, sys

# glibc's own libraries and its loader: every Linux has them, at least at the version the sysroot sets as the floor.
SYSTEM = re.compile(r"^(?:(?:libc|libm|libdl|libpthread|librt|libutil|libresolv|libanl|libnsl|libmvec)\.so\.\d+"
                    r"|ld-linux-x86-64\.so\.2)$")
PYLIB = re.compile(r"^libpython3\.\d+\.so(?:\.\d+)*$")
GLIBC = re.compile(r"Name: GLIBC_(\d+)\.(\d+)")


def is_elf(path):
    with open(path, "rb") as f:
        return f.read(4) == b"\x7fELF"


class Tree:
    def __init__(self, bundle, libdir, deps_lib, python_rels, floor, patchelf, readelf, strip):
        self.bundle = os.path.abspath(bundle)
        self.libdir = os.path.abspath(libdir)
        self.deps_lib = deps_lib
        # abspath, not realpath: the staged toolchain folder is a link to the py environment and must stay itself.
        self.python_libs = [os.path.normpath(os.path.join(os.path.dirname(self.bundle), rel))
                            for rel in python_rels.split(":")]
        self.floor = tuple(int(x) for x in floor.split("."))
        self.patchelf, self.readelf, self.strip = patchelf, readelf, strip

    def elfs(self):
        for root, dirs, files in os.walk(self.bundle):
            for name in sorted(files):
                path = os.path.join(root, name)
                if not os.path.islink(path) and is_elf(path):
                    yield path

    def read(self, flag, path):
        out = subprocess.run([self.patchelf, flag, path], check=True, capture_output=True, text=True).stdout
        return out

    def needed(self, path):
        return self.read("--print-needed", path).split()

    def runpath(self, path):
        return [r for r in self.read("--print-rpath", path).strip().split(":") if r]

    def rel(self, target, image):
        r = os.path.relpath(target, os.path.dirname(image))
        return "$ORIGIN" if r == "." else "$ORIGIN/" + r

    def wanted(self, image, needed):
        """The RUNPATH image needs: one entry per place its libraries may live, lib/x86_64-linux first, and for
        libpython each of its places in order."""
        places = []
        for n in needed:
            if not SYSTEM.match(n):
                places += self.python_libs if PYLIB.match(n) else [self.libdir]
        out = []
        for place in sorted(set(places), key=places.index):
            r = self.rel(place, image)
            if r not in out:
                out.append(r)
        return out


def run(*args):
    subprocess.run(args, check=True, capture_output=True, text=True)


def fix(tree):
    renamed, touched, seen = {}, set(), set()
    todo = list(tree.elfs())
    # Strip before patchelf writes anything, so each file's last change is patchelf's and strip never rewrites a
    # layout patchelf made.
    for image in todo:
        run(tree.strip, "--strip-unneeded", image)
    while todo:
        image = todo.pop()
        if image in seen:
            continue
        seen.add(image)
        for n in tree.needed(image):
            if SYSTEM.match(n) or PYLIB.match(n):
                continue
            if n not in renamed:
                if os.path.exists(os.path.join(tree.libdir, n)):
                    continue            # built here: libswipl
                src = os.path.join(tree.deps_lib, n)
                if not os.path.exists(src):
                    sys.exit(f"{image} needs {n}, which is neither in {tree.libdir} nor in {tree.deps_lib}")
                real = os.path.realpath(src)
                with open(real, "rb") as f:
                    digest = hashlib.sha256(f.read()).hexdigest()[:8]
                stem, so, version = n.partition(".so")
                new = f"{stem}-{digest}{so}{version}"
                dst = os.path.join(tree.libdir, new)
                shutil.copyfile(real, dst)
                os.chmod(dst, 0o755)
                run(tree.strip, "--strip-unneeded", dst)
                run(tree.patchelf, "--set-soname", new, dst)
                renamed[n] = new
                todo.append(dst)
                print(f"bundled {n} from {real} as {new}")
            run(tree.patchelf, "--replace-needed", n, renamed[n], image)
            touched.add(image)
        want = ":".join(tree.wanted(image, tree.needed(image)))
        if ":".join(tree.runpath(image)) != want:
            if want:
                run(tree.patchelf, "--set-rpath", want, image)
            else:
                run(tree.patchelf, "--remove-rpath", image)
            touched.add(image)
    print(f"fixed {len(touched)} of {len(seen)} ELF files, bundling {len(renamed)} libraries")


def resolve(image, name, runpath):
    for r in runpath:
        candidate = os.path.join(r.replace("$ORIGIN", os.path.dirname(image), 1), name)
        if os.path.exists(candidate):
            return os.path.normpath(candidate)
    return None


def check(tree):
    problems, count, newest = [], 0, (0, 0)
    for image in tree.elfs():
        count += 1
        needed, runpath = tree.needed(image), tree.runpath(image)
        if len(set(runpath)) != len(runpath):
            problems.append(f"{image}: duplicate RUNPATH entries {runpath}")
        for r in runpath:
            if not (r == "$ORIGIN" or r.startswith("$ORIGIN/")):
                problems.append(f"{image}: RUNPATH {r} is not relative to the file")
        if runpath != tree.wanted(image, needed):
            problems.append(f"{image}: RUNPATH {runpath} is not the places it uses, {tree.wanted(image, needed)}")
        for n in needed:
            if SYSTEM.match(n):
                continue
            hit = resolve(image, n, runpath)
            if PYLIB.match(n):
                ok = hit is not None and any(hit.startswith(place + os.sep) for place in tree.python_libs)
                if os.path.basename(image) != "janus.so":
                    problems.append(f"{image}: only janus.so may link {n}")
            else:
                ok = hit is not None and hit.startswith(tree.libdir + os.sep)
            if not ok:
                problems.append(f"{image}: {n} resolves to {hit}")
        versions = subprocess.run([tree.readelf, "-V", "--wide", image], check=True, capture_output=True,
                                  text=True).stdout
        for major, minor in GLIBC.findall(versions):
            v = (int(major), int(minor))
            newest = max(newest, v)
            if v > tree.floor:
                problems.append(f"{image}: asks for GLIBC_{major}.{minor}, newer than the floor {tree.floor}")
        sections = subprocess.run([tree.readelf, "-S", "--wide", image], check=True, capture_output=True,
                                  text=True).stdout
        if re.search(r"\] \.(?:symtab|debug_)", sections):
            problems.append(f"{image}: keeps a symbol table or debug sections")
    for p in problems:
        print("PROBLEM", p)
    print(f"checked {count} ELF files, newest glibc asked for {newest[0]}.{newest[1]}, {len(problems)} problems")
    return not problems and count > 0


if __name__ == "__main__":
    mode = sys.argv[1]
    tree = Tree(*sys.argv[2:10])
    if mode == "fix":
        fix(tree)
    elif not check(tree):
        sys.exit(1)
PY

say "strip every ELF file, bundle the conda-forge libraries, make every RUNPATH relative (log: $LOGS/fixup.log)"
"$PYEXE" -I "$WORK/elf.py" fix "$BUNDLE" "$LIBDIR" "$DEPS/lib" "$TOOLCHAIN_LIB:$KIT_PYTHON_LIB" "$GLIBC_FLOOR" "$PATCHELF" "$READELF" \
  "$STRIP" > "$LOGS/fixup.log" 2>&1 || { tail -5 "$LOGS/fixup.log" >&2; die "fixup failed (see $LOGS/fixup.log)"; }
tail -1 "$LOGS/fixup.log"

say "check the tree: every library inside it, glibc's, or libpython in $TOOLCHAIN_LIB or $KIT_PYTHON_LIB; nothing past glibc $GLIBC_FLOOR; no symbol tables"
# The checks need the toolchain beside swipl/ as the installer makes it; stage/toolchain stands in for it here.
mkdir -p "$STAGE/$(dirname "$TOOLCHAIN_LIB")"
ln -sfn "$PY/lib" "$STAGE/$TOOLCHAIN_LIB"
"$PYEXE" -I "$WORK/elf.py" check "$BUNDLE" "$LIBDIR" "$DEPS/lib" "$TOOLCHAIN_LIB:$KIT_PYTHON_LIB" "$GLIBC_FLOOR" "$PATCHELF" "$READELF" \
  "$STRIP" > "$LOGS/check.log" 2>&1 || { grep PROBLEM "$LOGS/check.log" | head -20 >&2; die "the bundle failed its check (see $LOGS/check.log)"; }
tail -1 "$LOGS/check.log"

say "run it: version, home, every package loads, janus calls Python $PYVER"
SWIPL="$BUNDLE/bin/swipl"
"$SWIPL" --version | grep -q "version $SWIPL_VERSION for $ARCH" || die "bin/swipl is not $SWIPL_VERSION for $ARCH"
[ "$("$SWIPL" --home)" = "$BUNDLE/$HOME_REL" ] || die "swipl found its home at $("$SWIPL" --home), not through swipl.home"
# Every foreign library the build installed must load: dlopen resolves all of its references, so this is the
# runtime twin of elf.py's check. The list comes from the tree, not from a list kept by hand. libswipl, which lives in
# the same folder on Linux, and the bundled conda-forge libraries, which carry a hash in their names, are what these
# load, not packages of their own. Each capture below keeps going when swipl fails, so die says which check it was.
FOREIGN=$(cd "$LIBDIR" && ls -- *.so | grep -v -x -E 'libswipl\.so|lib.*-[0-9a-f]{8}\.so' | sed 's/\.so$//' | paste -sd, -)
LOADED=$("$SWIPL" -g "forall(member(L, [$FOREIGN]), load_foreign_library(foreign(L))), writeln(ok), halt" 2>&1 | tail -1) || true
[ "$LOADED" = ok ] || die "a foreign library did not load: $LOADED"
JANUS=$("$SWIPL" -g 'use_module(library(janus)), py_call(sys:version, V), split_string(V, " ", "", [N|_]), writeln(N), halt' 2>&1 | tail -1) || true
case "$JANUS" in "$PYVER".*) ;; *) die "janus did not run Python $PYVER: $JANUS";; esac
LIBS=$("$SWIPL" -g 'forall(member(L, [ssl, crypto, pcre, yaml, archive, zlib, sgml, process, editline, uuid, sha, md5, readutil, socket, http/json, http/http_open]), use_module(library(L))), writeln(ok), halt' 2>&1 | tail -1) || true
[ "$LIBS" = ok ] || die "a package library did not load: $LIBS"
say "janus runs Python $JANUS; ssl, crypto, pcre, yaml, archive, zlib and the rest load"

say "pack $TARBALL"
BUNDLED=$(cd "$LIBDIR" && ls -- *.so* | grep -E '^lib.*-[0-9a-f]{8}\.so' | paste -sd ' ' -)
{
  echo "SWI-Prolog $SWIPL_VERSION ($SWIPL_TAG, $(git -C "$SRC" rev-parse HEAD)) for $ARCH, built $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(. /etc/os-release && echo "$PRETTY_NAME") with conda-forge GCC $("$CC" -dumpversion) against glibc $GLIBC_FLOOR"
  echo "packages: $SWIPL_PACKAGES"
  echo "janus: Python $("$PYEXE" -I -c 'import platform; print(platform.python_version())') from conda-forge; libpython found at \$OH/$TOOLCHAIN_LIB or \$OH/$KIT_PYTHON_LIB"
  echo "lib/swipl/lib/$ARCH, bundled from conda-forge under hashed names: $BUNDLED"
  echo "copied from this conda-forge environment:"
  "$MICROMAMBA" list --no-rc -p "$DEPS" 2>/dev/null | awk 'NF>=4 && $1 !~ /^(Name|─|List)/ {print "  " $1 " " $2 " " $3}'
} > "$BUNDLE/BUILD-INFO.txt"
rm -f "$TARBALL" "$TARBALL.sha256"
tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$TARBALL" swipl
(cd "$OUTDIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")

say "janus_swi $JANUS_VERSION wheel against the bundle"
WHEELS=$WORK/wheels
rm -rf "$WHEELS" && mkdir -p "$WHEELS/raw" "$WHEELS/unpacked"
# setup.py runs `swipl --dump-runtime-variables` from PATH and links libswipl with an absolute rpath to PLLIBDIR.
# --require-hashes takes only the pinned source release; --no-build-isolation builds it with the py lock's
# setuptools and wheel instead of whatever pip would fetch for an isolated build. CC and LDSHARED name the tools
# environment's GCC, since the py environment's sysconfig names a compiler by its bare name.
printf 'janus-swi==%s --hash=sha256:%s\n' "$JANUS_VERSION" "$JANUS_SWI_SDIST_SHA256" > "$WHEELS/requirements.txt"
PATH="$BUNDLE/bin:$PATH" CC="$CC" LDSHARED="$CC -shared" "$PYEXE" -I -m pip wheel --no-deps --no-binary janus-swi \
  --no-build-isolation --require-hashes --no-cache-dir -q -w "$WHEELS/raw" -r "$WHEELS/requirements.txt" \
  > "$LOGS/wheel.log" 2>&1 || die "pip wheel failed (see $LOGS/wheel.log)"
RAW=$(ls "$WHEELS/raw/janus_swi-$JANUS_VERSION-"*.whl)
"$PYEXE" -I -m wheel unpack -d "$WHEELS/unpacked" "$RAW" > /dev/null
EXT=$(ls "$WHEELS"/unpacked/janus_swi-"$JANUS_VERSION"/janus_swi/_swipl*.so)
"$STRIP" --strip-unneeded "$EXT"
# Installed, the extension sits in $OH/VENV_DIR/lib/pythonX.Y/site-packages/janus_swi, and libswipl in the bundle's
# lib/x86_64-linux.
REL=$("$PYEXE" -I -c 'import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' \
  "/OH/swipl/$HOME_REL/lib/$ARCH" "/OH/$VENV_DIR/lib/python$PYVER/site-packages/janus_swi")
"$PATCHELF" --set-rpath "\$ORIGIN/$REL" "$EXT"
# The extension needs libswipl and glibc alone: anything else would be a library the wheel does not carry.
EXTRA=$("$PATCHELF" --print-needed "$EXT" | grep -v -x -E 'libswipl\.so\.[0-9]+|(libc|libm|libdl|libpthread|librt)\.so\.[0-9]+' || true)
[ -z "$EXTRA" ] || die "the janus_swi extension also needs $EXTRA"
"$PATCHELF" --print-needed "$EXT" | grep -q -x -E 'libswipl\.so\.[0-9]+' || die "the janus_swi extension does not link libswipl"
rm -f "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*linux*.whl "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*linux*.whl.sha256
"$PYEXE" -I -m wheel pack -d "$OUTDIR" "$WHEELS/unpacked/janus_swi-$JANUS_VERSION" > /dev/null
WHEEL=$(ls "$OUTDIR"/janus_swi-"$JANUS_VERSION"-*linux_x86_64.whl)
(cd "$OUTDIR" && sha256sum "$(basename "$WHEEL")" > "$(basename "$WHEEL").sha256")

say "check the tarball and wheel unpacked elsewhere, as a tester's distro runs them (log: $LOGS/check-relocated.log)"
rm -rf "$WORK/check" && mkdir -p "$WORK/check"
bash "$SCRIPT_DIR/check-swipl-bundle.sh" "$TARBALL" "$WHEEL" "$PY" "$WORK/check" > "$LOGS/check-relocated.log" 2>&1 \
  || { tail -5 "$LOGS/check-relocated.log" >&2; die "the relocated check failed (see $LOGS/check-relocated.log)"; }
grep '^ok: ' "$LOGS/check-relocated.log"

say "done"
cat "$TARBALL.sha256" "$WHEEL.sha256"
ls -l "$TARBALL" "$WHEEL"
