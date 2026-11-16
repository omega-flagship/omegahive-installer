#!/usr/bin/env python3
# Purpose: write install/macos/locks/python-PLATFORM.txt, the hash-locked Python packages the Mac installer (and, for
# linux-64, the Windows installer's WSL distro) puts in ~/OmegaHive/venv: hive/requirements.txt plus what the hive's minds import beyond it, at the versions of the Linux installer's
# release lock (locks/core.lock) wherever that version has a wheel for the platform, wheels only, each file by sha256.
#
# Usage: python3 install/macos/python-lock.py [--upgrade] [PLATFORM ...]   PLATFORM: osx-arm64, osx-64, linux-64 (default: all)
# Needs uv on PATH and network access to PyPI. A rerun keeps every version a lock already holds and resolves only what
# hive/requirements.txt adds or changes, as uv pip compile does with an existing output file; --upgrade moves every
# version on purpose. The installer only reads the locks.
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
# ci/linux-x86/inputs/core.lock, branch release/hive-20261109 of omega-flagship/omegahive-installer, byte for byte:
# the version list the Linux installer installs, so both installers share it.
CORE = HERE / "locks" / "core.lock"
# The minds import these at load, and core.lock has none of them: lib_llm_ext.py imports openai on its first line,
# lib_omegaclaw_core.metta imports petta_lib_chromadb's lib_chromadb, which imports chromadb, and the pinned core's
# profile/policy.py, which its lib_omega.metta imports, imports py_landlock at the top on every platform. The root
# requirements.txt pins py-landlock for Linux only, but its wheel is pure Python and reaches Landlock only when a
# policy is applied, which off Linux fails inside the core's own exception handler, so the pin holds here for every
# platform. The rest of the root requirements.txt stays out: sentence-transformers (with torch) serves only Local
# embeddings, and the hive sets its minds' embeddingprovider to OpenAI (hive/supervisor/workspace.py, which
# hive/runtime/hive_services.py hands to the core's configure); uagents and websocket-client serve the agentverse and
# mattermost modules, which modules/loader.metta does not load.
MINDS = ["openai", "chromadb", "py-landlock"]
# janus-swi is installed apart, as the release's prebuilt wheel or this sdist by its own sha256 (pins.sh).
APART = {"janus-swi"}
# linux-64 is the Windows installer's WSL distro (Ubuntu 26.04, glibc 2.43): wheels for glibc 2.39 or older, the floor
# the toolchain's own sysroot sets.
TARGETS = {"osx-arm64": ("aarch64-apple-darwin", r"macosx_\d+_\d+_(arm64|universal2)"),
           "osx-64": ("x86_64-apple-darwin", r"macosx_\d+_\d+_(x86_64|universal2|intel)"),
           "linux-64": ("x86_64-manylinux_2_39", r"(^|\.)(manylinux_2_\d+|manylinux2014|manylinux2010|manylinux1|linux)_x86_64")}
PIN = re.compile(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?==([^\s;\\]+)", re.M)


def pypi_files(name, version):
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as reply:
        return json.load(reply)["urls"]


def wheels_for(files, platform_tag):
    """The files of one release a CPython 3.12 on this platform can install: its wheels whose tags fit."""
    fit = []
    for f in files:
        name = f["filename"]
        if not name.endswith(".whl"):
            continue
        python_tag, abi_tag, platform = name[:-4].split("-")[-3:]
        python_ok = "cp312" in python_tag or "py3" in python_tag or abi_tag == "abi3"
        if python_ok and (platform == "any" or re.search(platform_tag, platform)):
            fit.append(f)
    return fit


def hive_requirements():
    """hive/requirements.txt without its -c lines: core.lock holds every pin those constraint files name (checked
    here), so the pins reach the resolver as core pins, which a platform without their wheel can leave out."""
    req = REPO / "hive" / "requirements.txt"
    core = {n.lower(): v for n, v in PIN.findall(CORE.read_text())}
    kept = []
    for line in req.read_text().splitlines():
        if line.startswith("-c "):
            for n, v in PIN.findall((req.parent / line[3:].strip()).read_text()):
                if core.get(n.lower()) != v:
                    sys.exit(f"{line[3:].strip()} pins {n}=={v}, which locks/core.lock does not: update core.lock first")
        else:
            kept.append(line)
    return "\n".join(kept) + "\n"


def minds_requirements():
    """MINDS at the root requirements.txt's pin where it pins one, without its platform marker, so the minds get the
    version dev/latest names; the others at core.lock's versions or the resolver's."""
    root = {re.sub(r"[-_.]+", "-", n.lower()): v for n, v in PIN.findall((REPO / "requirements.txt").read_text())}
    return [f"{m}=={root[m]}" if m in root else m for m in MINDS]


def lock(platform, upgrade):
    target, platform_tag = TARGETS[platform]
    pins = [(n, v) for n, v in PIN.findall(CORE.read_text()) if n.lower() not in APART]
    # Time: one PyPI JSON request per core pin (52) and later per locked package (about 90).
    kept = [(n, v) for n, v in pins if wheels_for(pypi_files(n, v), platform_tag)]
    left = sorted(f"{n}=={v}" for n, v in set(pins) - set(kept))
    out = HERE / "locks" / f"python-{platform}.txt"
    with tempfile.TemporaryDirectory() as tmp:
        constraints = pathlib.Path(tmp, "core-constraints.txt")
        constraints.write_text("".join(f"{n}=={v}\n" for n, v in kept))
        hive = pathlib.Path(tmp, "hive-requirements.in")
        hive.write_text(hive_requirements())
        minds = pathlib.Path(tmp, "minds.in")
        minds.write_text("".join(f"{m}\n" for m in minds_requirements()))
        body = pathlib.Path(tmp, "lock.txt")
        if out.exists():
            body.write_text(out.read_text())   # uv prefers the versions its output file already pins, unless --upgrade
        # Run from the temp folder with relative names, so each '# via' line names an input file, never the temp path,
        # and a rerun changes only what the requirements change.
        subprocess.run(["uv", "pip", "compile", hive.name, minds.name,
                        "-c", constraints.name, "--generate-hashes", "--only-binary", ":all:",
                        "--python-version", "3.12", "--python-platform", target, "--no-header", "--quiet",
                        "-o", body.name, *(["--upgrade"] if upgrade else [])], check=True, cwd=tmp)
        text = body.read_text()
    locked = PIN.findall(text)
    # The download a fresh install makes: the largest fitting wheel of each locked package, so never an undercount.
    size = sum(max(f["size"] for f in wheels_for(pypi_files(n, v), platform_tag)) for n, v in locked)
    who = "the Windows installer's WSL distro" if platform.startswith("linux") else "the Mac installer"
    header = (f"# Python packages for {who} on {platform}, made by install/macos/python-lock.py: "
              f"hive/requirements.txt and {', '.join(MINDS)}\n"
              f"# at locks/core.lock's versions (the Linux installer's release lock), wheels only. "
              f"Core pins with no wheel for "
              f"{platform}, left to the resolver: {', '.join(left) or 'none'}.\n"
              f"# Install with: uv pip install --require-hashes --only-binary :all: -r THIS_FILE\n"
              f"# download: {round(size / 1048576)} MB\n")
    out.write_text(header + text)
    print(f"{out.relative_to(REPO)}: {len(locked)} packages, about {round(size / 1048576)} MB; left to the resolver: "
          f"{', '.join(left) or 'none'}")


if __name__ == "__main__":
    args = sys.argv[1:]
    for platform in [a for a in args if a != "--upgrade"] or list(TARGETS):
        lock(platform, "--upgrade" in args)
