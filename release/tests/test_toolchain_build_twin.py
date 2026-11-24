#!/usr/bin/env python3
"""Purpose: check the split of the WSL toolchain's conda lock and the installer's use of it. install/macos/conda-lock.sh
writes locks/conda-linux-64.txt with what the toolchain needs and its build twin, locks/conda-linux-64-build.txt, with
what only a source build of SWI-Prolog or janus-swi adds (GCC, cmake, ninja and SWI-Prolog's libraries).
"Install OmegaHive.command" makes the toolchain from the first and adds the twin only before a source build, so a
Windows setup whose prebuilt SWI-Prolog runs downloads no compiler. build_tools is read out of the installer and run
with a stand-in micromamba, so the test runs the installer's own lines rather than a copy of them.

    python3 -m unittest tests/test_toolchain_build_twin.py
"""
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCKS = ROOT / "install" / "macos" / "locks"
INSTALLER = ROOT / "install" / "macos" / "Install OmegaHive.command"
BASE, TWIN = LOCKS / "conda-linux-64.txt", LOCKS / "conda-linux-64-build.txt"
LINE = re.compile(r"^https://conda\.anaconda\.org/conda-forge/(?:linux-64|noarch)/([^/#]+)\.(?:conda|tar\.bz2)"
                  r"#sha256:[0-9a-f]{64}$")


def packages(lock):
    """Each package a lock names, by name, from its name-version-build file name."""
    names = []
    for line in lock.read_text().splitlines():
        if line.startswith("https://"):
            m = LINE.match(line)
            assert m, f"{lock.name}: {line}"
            names.append(m.group(1).rsplit("-", 2)[0])
    return names


def function(name):
    """A shell function's whole definition as the installer writes it: its one line, or from its name to the line
    that closes it."""
    text = INSTALLER.read_text()
    start = text.index(f"\n{name}() {{") + 1
    first = text[start:text.index("\n", start)]
    if first.rstrip().endswith("; }"):
        return first + "\n"
    return text[start:text.index("\n}\n", start) + 3]


def run_build_tools(twin_lines, recorded):
    """What build_tools does with a twin of those lines and a toolchain whose conda-meta holds the recorded stems:
    the micromamba command it runs, if any, and what it says."""
    with tempfile.TemporaryDirectory() as here:
        here = pathlib.Path(here)
        (here / "locks").mkdir()
        if twin_lines is not None:
            (here / "locks" / "conda-linux-64-build.txt").write_text(
                "# conda-forge lock for linux-64: what a source build adds\n# download: 201 MB\n@EXPLICIT\n"
                + "".join(f"{l}\n" for l in twin_lines))
        (here / "toolchain" / "conda-meta").mkdir(parents=True)
        for stem in recorded:
            (here / "toolchain" / "conda-meta" / f"{stem}.json").write_text("{}")
        (here / "logs").mkdir()
        mamba = here / "micromamba"
        mamba.write_text(f'#!/bin/bash\nprintf "%s\\n" "$*" >> "{here}/calls"\n')
        mamba.chmod(0o755)
        script = (f"SCRIPT_DIR={here}; PLATFORM=linux-64; TOOLCHAIN={here}/toolchain; OH={here}; MAMBA_ROOT={here}\n"
                  f"MICROMAMBA={mamba}; SUBLOG=''\n"
                  'fetching() { echo "fetching: $1, $2 MB"; }\nfetched() { echo fetched; }\n'
                  f"{function('download_mb')}\n{function('build_tools')}\nbuild_tools\n")
        said = subprocess.run(["bash", "-euo", "pipefail", "-c", script], check=True, capture_output=True,
                              text=True).stdout
        calls = (here / "calls").read_text().splitlines() if (here / "calls").exists() else []
        return [c.replace(str(here), "HERE") for c in calls], said.replace(str(here), "HERE")


GCC = "https://conda.anaconda.org/conda-forge/linux-64/gcc-15.3.0-hc6a0c74_7.conda#sha256:" + "0" * 64
CMAKE = "https://conda.anaconda.org/conda-forge/linux-64/cmake-4.4.5-hff7ac6b_0.conda#sha256:" + "1" * 64


class BuildTwinLocks(unittest.TestCase):
    def test_the_two_locks_share_no_package_and_name_every_build_by_sha256(self):
        base, twin = packages(BASE), packages(TWIN)
        self.assertEqual(len(base), len(set(base)))
        self.assertEqual(len(twin), len(set(twin)))
        self.assertEqual(set(base) & set(twin), set())

    def test_the_toolchain_lock_holds_no_compiler_and_the_twin_holds_the_source_build(self):
        base, twin = set(packages(BASE)), set(packages(TWIN))
        for tool in ("gcc", "gxx", "gcc_impl_linux-64", "gxx_impl_linux-64", "binutils_impl_linux-64",
                     "sysroot_linux-64", "c-compiler", "cxx-compiler", "cmake", "ninja", "pkg-config"):
            with self.subTest(tool=tool):
                self.assertNotIn(tool, base)
                self.assertIn(tool, twin)
        for tool in ("python", "nodejs", "uv", "git", "pip"):
            with self.subTest(tool=tool):
                self.assertIn(tool, base)

    def test_each_lock_says_its_download_and_the_twin_names_the_lock_it_completes(self):
        for lock in sorted(LOCKS.glob("conda-*.txt")):
            with self.subTest(lock=lock.name):
                self.assertRegex(lock.read_text(), r"(?m)^# download: [0-9]+ MB$")
        self.assertIn("into an environment made from conda-linux-64.txt", TWIN.read_text().splitlines()[1])


class BuildTwinInstall(unittest.TestCase):
    def test_a_toolchain_without_the_twins_packages_gets_them_in_one_install(self):
        calls, said = run_build_tools([GCC, CMAKE], ["gcc-15.3.0-hc6a0c74_7"])
        self.assertEqual(calls, ["install -y --no-rc -p HERE/toolchain -f HERE/locks/conda-linux-64-build.txt"])
        self.assertIn("fetching: the build tools for SWI-Prolog's source build (GCC, cmake and ninja), 201 MB", said)

    def test_a_toolchain_that_holds_every_package_downloads_nothing(self):
        self.assertEqual(run_build_tools([GCC, CMAKE], ["gcc-15.3.0-hc6a0c74_7", "cmake-4.4.5-hff7ac6b_0"]),
                         ([], ""))

    def test_a_platform_whose_lock_has_no_twin_adds_nothing(self):
        self.assertEqual(run_build_tools(None, []), ([], ""))

    def test_only_the_source_builds_add_the_twin(self):
        text = INSTALLER.read_text()
        calls = [m.start() for m in re.finditer(r"(?m)^\s*build_tools$", text)]
        self.assertEqual(len(calls), 2, calls)
        swipl = text.index('step "building SWI-Prolog 10.1.14')
        janus = text.index("--no-binary janus-swi")
        self.assertTrue(swipl < calls[0] < text.index("cmake -G Ninja", swipl), "the twin comes before SWI-Prolog's cmake")
        self.assertTrue(text.rindex("\nelse\n", 0, janus) < calls[1] < janus, "the twin comes before janus-swi's build")
        toolchain = text[text.index('step "installing the toolchain'):swipl]
        self.assertNotIn("conda-$PLATFORM-build.txt\" </dev/null", toolchain)
        self.assertNotIn("bin/g++", toolchain)


if __name__ == "__main__":
    unittest.main()
