#!/bin/bash
# Purpose: write micromamba explicit lock files that pin every conda-forge package of an environment by URL and
# sha256, so `micromamba create -f LOCK` installs exactly those builds and refuses any file whose checksum differs.
# Given what only a source build of SWI-Prolog or janus-swi needs after --, the packages nothing else needs go to
# LOCK's build twin (conda-linux-64-build.txt beside conda-linux-64.txt), which `micromamba install -f` adds to an
# environment made from LOCK only when a source build runs.
#
# Usage: install/macos/conda-lock.sh [--pin OLD_LOCK] PLATFORM LOCK SPEC... [-- BUILD_SPEC...]
#   PLATFORM    osx-arm64 or osx-64 (a lock for either can be made on either kind of Mac), or linux-64 or
#               linux-aarch64 for the Windows installer's WSL distro (made on a Linux host or a Mac alike)
#   LOCK        the file to write, for example install/macos/locks/conda-osx-arm64.txt
#   SPEC        what the toolchain needs, as micromamba takes it: python=3.12 "nodejs>=22.12,<27" uv ...
#   BUILD_SPEC  what only a source build needs: cmake ninja c-compiler ... Both lists are solved together, so the
#               two locks agree, and LOCK holds every package SPEC's packages depend on, the way conda-lock files a
#               lock's packages under main or dev from one solve.
#   --pin       solve to exactly the builds OLD_LOCK and its build twin name, refusing a solve that differs, so a lock
#               can be split, or its specs regrouped, without moving any package.
# The solve runs the micromamba pinned in pins.sh, fetched once into ~/.cache/omegahive-pins and checked there.
# Rerun it to move a lock to newer builds on purpose; the installer and the bundle build only ever read locks.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/pins.sh"
PIN=""
if [ "${1:-}" = --pin ]; then PIN=$2; shift 2; fi
[ "$#" -ge 3 ] || { echo "usage: $0 [--pin OLD_LOCK] PLATFORM LOCK SPEC... [-- BUILD_SPEC...]" >&2; exit 2; }
PLATFORM=$1; LOCK=$2; shift 2
case "$PLATFORM" in osx-arm64|osx-64|linux-64|linux-aarch64) ;;
  *) echo "PLATFORM is osx-arm64, osx-64, linux-64 or linux-aarch64, not $PLATFORM" >&2; exit 2;; esac
SPECS=() BUILD_SPECS=()
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do SPECS+=("$1"); shift; done
if [ "$#" -gt 0 ]; then shift; BUILD_SPECS=("$@"); fi
[ "${#SPECS[@]}" -gt 0 ] || { echo "no SPEC before --" >&2; exit 2; }
TWIN=${LOCK%.txt}-build.txt

# The solve runs the pinned micromamba built for this host; --platform makes it solve for PLATFORM.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) HOST=osx-arm64 ;; Darwin/x86_64) HOST=osx-64 ;;
  Linux/x86_64) HOST=linux-64 ;; Linux/aarch64) HOST=linux-aarch64 ;;
  *) echo "no micromamba is pinned for this host, $(uname -s)/$(uname -m)" >&2; exit 2 ;;
esac
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/omegahive-pins/micromamba-$MICROMAMBA_VERSION-$HOST
if [ ! -x "$CACHE" ]; then
  mkdir -p "$(dirname "$CACHE")"
  pin_fetch "$(micromamba_url "$HOST")" "$(micromamba_sha256 "$HOST")" "$CACHE"
  chmod 755 "$CACHE"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/conda-lock.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# With --pin, each package the old locks name joins the solve as its exact name, version and build, read from its
# file name (name-version-build.conda: conda allows no dash in a version or a build string).
PINNED=()
if [ -n "$PIN" ]; then
  OLD_TWIN=${PIN%.txt}-build.txt
  while IFS= read -r spec; do PINNED+=("$spec"); done < <(
    cat "$PIN" $([ -f "$OLD_TWIN" ] && echo "$OLD_TWIN") | /usr/bin/python3 -I -c '
import re, sys
for line in sys.stdin:
    m = re.match(r"https://\S+/([^/#]+)\.(?:conda|tar\.bz2)#", line)
    if m:
        name, version, build = m.group(1).rsplit("-", 2)
        print(f"{name}[version=\"=={version}\",build=\"{build}\"]")')
  [ "${#PINNED[@]}" -gt 0 ] || { echo "$PIN names no package" >&2; exit 2; }
fi
# A dry run solves without installing; LINK lists every package the environment would hold, with its URL, the
# sha256 conda-forge's repodata publishes for it, and what it depends on. An empty array is written ${a[@]+"${a[@]}"}:
# a Mac's /bin/bash, 3.2, calls a bare "${a[@]}" of none an unbound variable under set -u.
MAMBA_ROOT_PREFIX=$WORK/root "$CACHE" create --dry-run --json --no-rc -y -p "$WORK/env" --platform "$PLATFORM" \
  --override-channels -c conda-forge "${SPECS[@]}" ${BUILD_SPECS[@]+"${BUILD_SPECS[@]}"} ${PINNED[@]+"${PINNED[@]}"} \
  > "$WORK/solve.json"
/usr/bin/python3 -I - "$WORK/solve.json" "$LOCK" "$TWIN" "$PLATFORM" "$MICROMAMBA_VERSION" "${SPECS[*]}" \
  "${BUILD_SPECS[*]-}" "$PIN" <<'PY'
import json, os, re, sys, time
solve, lock, twin, platform, version, specs, build_specs, pin = sys.argv[1:9]
links = json.load(open(solve))["actions"]["LINK"]
by_name = {pkg["name"]: pkg for pkg in links}
for pkg in links:
    if len(pkg.get("sha256") or "") != 64:
        sys.exit(f"conda-forge published no sha256 for {pkg.get('url')}")
    if not isinstance(pkg.get("size"), int):
        sys.exit(f"conda-forge published no size for {pkg.get('url')}")

def name(spec):
    # A spec's or a dependency's package name ends at its first version, build or bracket character:
    # "nodejs>=22.12,<27" is nodejs, "openssl >=3.5.4,<4.0a0" is openssl, "c-compiler" is c-compiler.
    return re.split(r"[=<>!~ \[]", spec.strip(), maxsplit=1)[0]

def line(pkg):
    return f"{pkg['url']}#sha256:{pkg['sha256']}"

def download(pkgs):
    # The installer's notice reads this line, in MB of 1048576 bytes as python-lock.py writes its own.
    return f"# download: {round(sum(pkg['size'] for pkg in pkgs) / 1048576)} MB\n"

if pin:
    old = set()
    for path in (pin, pin[:-len(".txt")] + "-build.txt"):
        if os.path.exists(path):
            old |= {l.strip() for l in open(path) if l.startswith("https://")}
    new = {line(pkg) for pkg in links}
    if new != old:
        sys.exit("the pinned solve differs from " + pin + ":\n  only now: " + "\n  only now: ".join(sorted(new - old))
                 + "\n  only before: " + "\n  only before: ".join(sorted(old - new)))
# The toolchain's lock holds every package SPEC's roots reach through their dependencies, virtual packages
# (__glibc, __osx) aside, so it holds what solving SPEC alone installs. micromamba gives every python it installs pip
# (add_pip_as_python_dependency, on by default), which no repodata record lists, so python's edges take pip too.
# Time: one visit per package and per dependency edge of the solve.
roots = [name(s) for s in specs.split()]
missing = [r for r in roots if r not in by_name]
if missing:
    sys.exit(f"the solve holds no package for {missing}")
base, todo = set(), list(roots)
while todo:
    n = todo.pop()
    if n in base:
        continue
    base.add(n)
    implied = ["pip"] if n == "python" and "pip" in by_name else []
    for dep in (by_name[n].get("depends") or []) + implied:
        d = name(dep)
        if d.startswith("__"):
            continue
        if d not in by_name:
            sys.exit(f"{n} depends on {dep}, which the solve does not hold")
        todo.append(d)
rest = [pkg for pkg in links if pkg["name"] not in base]
if rest and not build_specs:
    sys.exit(f"{len(rest)} packages are outside SPEC's dependencies with no BUILD_SPEC to own them")
solved = time.strftime("%Y-%m-%d", time.gmtime())
if pin:
    first = open(pin).readline()
    m = re.search(r"solved (\d{4}-\d{2}-\d{2})", first)
    solved = f"{m.group(1) if m else 'earlier'}, rewritten {solved}"
note = f"; what only a source build adds, for {build_specs}, is in {os.path.basename(twin)}" if build_specs else ""
base_pkgs = [by_name[n] for n in base]
with open(lock + ".part", "w") as f:
    f.write(f"# conda-forge lock for {platform}, solved {solved} by micromamba {version} from: {specs}{note}\n"
            "# Made by install/macos/conda-lock.sh; install with: micromamba create -p PREFIX -f THIS_FILE\n"
            + download(base_pkgs))
    f.write("@EXPLICIT\n" + "\n".join(sorted(line(pkg) for pkg in base_pkgs)) + "\n")
if build_specs:
    with open(twin + ".part", "w") as f:
        f.write(f"# conda-forge lock for {platform}: what a source build adds to {os.path.basename(lock)}, solved with it"
                f" {solved} by micromamba {version} from: {build_specs}\n"
                f"# Made by install/macos/conda-lock.sh; add with: micromamba install -p PREFIX -f THIS_FILE, into an"
                f" environment made from {os.path.basename(lock)}\n" + download(rest))
        f.write("@EXPLICIT\n" + "\n".join(sorted(line(pkg) for pkg in rest)) + "\n")
print(f"{lock}: {len(base)} packages" + (f"; {twin}: {len(rest)} packages" if build_specs else ""))
PY
mv "$LOCK.part" "$LOCK"
# A lock made without BUILD_SPEC has no twin: one an earlier split left would add packages nothing solved with it.
if [ -n "${BUILD_SPECS[*]-}" ]; then mv "$TWIN.part" "$TWIN"; else rm -f "$TWIN"; fi
