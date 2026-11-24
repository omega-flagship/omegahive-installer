#!/usr/bin/env python3
"""Purpose: check which prebuilt SWI-Prolog "Install OmegaHive.command" takes on each computer: an arm64 Mac takes the
macOS bundle and wheel, Linux x86_64 (the Windows installer's WSL distro) the Linux ones, each only when both files sit
beside the script, and every other computer, or a release without them, builds SWI-Prolog from source; and where it
unpacks the bundle: on Linux into $OH/swipl itself, the folder a mind's sandbox holds, over an earlier setup's link too,
and on a Mac into a folder of its own behind a link. The blocks that decide are read out of the installer and run with
uname or OS answering for the computer named, so the test reads the installer's own lines rather than a copy of them.

    python3 -m unittest tests/test_swipl_bundle_choice.py
"""
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install" / "macos" / "Install OmegaHive.command"
PINS = ROOT / "install" / "macos" / "pins.sh"
MAC = ("swipl-10.1.14-macos-arm64.tar.gz", "janus_swi-1.5.3-cp312-cp312-macosx_11_0_arm64.whl")
LINUX = ("swipl-10.1.14-linux-x86_64.tar.gz", "janus_swi-1.5.3-cp312-cp312-linux_x86_64.whl")


def choice_block():
    """The installer's lines from its janus version, right after it reads pins.sh, through the PREBUILT test."""
    text = INSTALLER.read_text()
    start = text.index("JANUS_VERSION=$JANUS_SWI_VERSION\n")
    end = text.index("then PREBUILT=1; fi\n", start) + len("then PREBUILT=1; fi\n")
    block = text[start:end]
    assert "SWI_BUNDLE=" in block and "PREBUILT=0" in block and re.search(r"^OS=\$\(uname -s\)$", block, re.M), block
    return block


def chosen(system, machine, present):
    """SWI_BUNDLE, JANUS_WHEEL and PREBUILT, as the block sets them on that computer with those files beside it."""
    with tempfile.TemporaryDirectory() as here:
        for name in present:
            (pathlib.Path(here) / name).write_text("")
        script = (f'uname() {{ case "$1" in -s) echo {system};; -m) echo {machine};; esac; }}\n'
                  f'SCRIPT_DIR={here}\n. "{PINS}"\n{choice_block()}'
                  'printf "%s\\n" "${SWI_BUNDLE##*/}" "${JANUS_WHEEL##*/}" "$PREBUILT"\n')
        out = subprocess.run(["bash", "-euo", "pipefail", "-c", script], check=True, capture_output=True,
                             text=True).stdout.split("\n")
        return out[0], out[1], out[2]


def unpack_lines():
    """The installer's unquarantine, resign and unpack_swipl, and its block that takes the prebuilt bundle, from the
    PREBUILT test through the end of that block, where a source build would start."""
    text = INSTALLER.read_text()
    start = text.index("unquarantine() {")
    end = text.index('  resign "$OH/$dir"\n}\n', start) + len('  resign "$OH/$dir"\n}\n')
    first = text.index('if [ "$PREBUILT" = 1 ]; then\n', end)
    last = text.index('if [ "$PREBUILT" = 0 ] && ! "$OH/swipl/bin/swipl" --version', first)
    return text[start:end] + text[first:last]


def unpacked(system, earlier=None):
    """What $OH holds after the prebuilt block runs on that system with a release carrying a small Linux bundle whose
    swipl answers as 10.1.14. earlier: "link" for $OH/swipl left a link to a swipl-<8 hex> folder holding that same
    bundle, as an earlier setup did. Returns (is the swipl entry a link, its target, the swipl folders in $OH, PREBUILT)."""
    with tempfile.TemporaryDirectory() as here:
        here = pathlib.Path(here)
        release, oh = here / "release", here / "OmegaHive"
        (here / "swipl" / "bin").mkdir(parents=True)
        swipl = here / "swipl" / "bin" / "swipl"
        swipl.write_text('#!/bin/sh\necho "SWI-Prolog version 10.1.14 for x86_64-linux"\n')
        swipl.chmod(0o755)
        release.mkdir()
        bundle = release / LINUX[0]
        subprocess.run(["tar", "-czf", str(bundle), "-C", str(here), "swipl"], check=True)
        digest = subprocess.run(["sha256sum", bundle.name], cwd=release, check=True, capture_output=True,
                                text=True).stdout
        (release / (LINUX[0] + ".sha256")).write_text(digest)
        oh.mkdir()
        if earlier == "link":
            (oh / "swipl-0a1b2c3d").mkdir()
            subprocess.run(["tar", "-xzf", str(bundle), "-C", str(oh / "swipl-0a1b2c3d"), "--strip-components", "1"],
                           check=True)
            (oh / "swipl").symlink_to("swipl-0a1b2c3d")
            (oh / "swipl-0a1b2c3d" / ".omegahive-ran").write_text("bundle " + digest.split()[0] + "\n")
        script = (f'. "{PINS}"\nsay() {{ printf "%s\\n" "$*"; }}\nstep() {{ say "== $1"; }}\ncompilers() {{ :; }}\n'
                  f'OS={system} OH={oh} SCRIPT_DIR={release} SWI_BUNDLE={bundle} PREBUILT=1\n'
                  f'{unpack_lines()}printf "%s\\n" "$PREBUILT"\n')
        out = subprocess.run(["bash", "-euo", "pipefail", "-c", script], check=True, capture_output=True,
                             text=True).stdout.splitlines()
        entry = oh / "swipl"
        return (entry.is_symlink(), str(entry.readlink()) if entry.is_symlink() else "",
                sorted(p.name for p in oh.iterdir() if p.name.startswith("swipl")), out[-1])


class BundleLayout(unittest.TestCase):
    # A Linux mind's sandbox shows it only its read roots at their real paths, so the swipl its PATH names
    # ($OH/swipl/bin) must be inside the folder itself, not behind a link in $OH: through a link every mind of a
    # Windows hive stopped with "swipl: not found".
    def test_linux_unpacks_the_bundle_into_the_swipl_folder_itself(self):
        self.assertEqual(unpacked("Linux"), (False, "", ["swipl"], "1"))

    def test_linux_unpacks_again_over_an_earlier_setups_link(self):
        self.assertEqual(unpacked("Linux", earlier="link"), (False, "", ["swipl"], "1"))

    def test_a_mac_unpacks_into_a_folder_of_its_own_behind_a_link(self):
        is_link, target, entries, prebuilt = unpacked("Darwin")
        self.assertTrue(is_link)
        self.assertRegex(target, r"^swipl-[0-9a-f]{8}$")
        self.assertEqual((entries, prebuilt), (sorted(["swipl", target]), "1"))


class BundleChoice(unittest.TestCase):
    def test_an_arm64_mac_takes_the_macos_bundle_when_both_files_are_there(self):
        self.assertEqual(chosen("Darwin", "arm64", MAC + LINUX), MAC + ("1",))

    def test_linux_x86_64_takes_the_linux_bundle_when_both_files_are_there(self):
        self.assertEqual(chosen("Linux", "x86_64", MAC + LINUX), LINUX + ("1",))

    def test_a_release_missing_either_file_builds_from_source(self):
        for files in ((LINUX[0],), (LINUX[1],), MAC, ()):
            with self.subTest(files=files):
                self.assertEqual(chosen("Linux", "x86_64", files)[2], "0")
        self.assertEqual(chosen("Darwin", "arm64", (MAC[0],))[2], "0")

    def test_computers_with_no_bundle_build_from_source(self):
        for system, machine in (("Darwin", "x86_64"), ("Linux", "aarch64")):
            with self.subTest(computer=f"{system}/{machine}"):
                self.assertEqual(chosen(system, machine, MAC + LINUX), ("", "", "0"))


if __name__ == "__main__":
    unittest.main()
