#!/usr/bin/env python3
"""Purpose: check install/public_release.py, the rule for what a public Mac or Windows release zip carries: prune
leaves out every folder marked CLOSED_SOURCE.md that PUBLISHED does not name and every KEPT_OUT component (Evolve,
OmegaTown, Assist), Evolve by every file named for it, keeps a published folder only with its licence beside it, and
check refuses a zip, Mac or Windows shaped, carrying any of them, inside the Windows code tarball and the archives a zip
carries too. The last tests prune this repository's own tree and find exactly its closed parts gone and the WhatsApp
bridge kept with libsignal's licence, and find no Evolve file tracked, or named in the tracked release manifest, while
the rule keeps Evolve out.

    python3 -m unittest tests/test_public_release.py
"""
import hashlib
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "install"))
import public_release  # noqa: E402

# sha256 of the LICENSE file in libsignal 6.0.0, the version the bridge's package-lock.json names: the GNU GPL v3 text.
LIBSIGNAL_LICENSE_SHA256 = "c61f12da7cdad526bdcbed47a4c0a603e60dbbfdaf8b66933cd088e9132c303f"


def tgz(members):
    """A gzipped tarball holding members, {name: bytes}."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return out.getvalue()


class PublicReleaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="public-release-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def tree(self, extra=None, licence=True):
        """A release's omegahive/ folder shaped as the repository's: the closed Evolve plugin and OmegaTown folder,
        Evolve's docs and its files in other layers (a core module, its MeTTa library, a test, a UI module and a built
        chunk), an unknown closed folder, the published bridge (with its licence unless told otherwise), and open code a
        careless rule could catch: the Tools app's home assistant module and the Commons Explorer plugin."""
        root = self.tmp / "omegahive"
        files = {
            "hive/plugins/omegaevolve/CLOSED_SOURCE.md": "closed", "hive/plugins/omegaevolve/program.py": "x = 1",
            "hive/ui/src/experiences/omegatown/CLOSED_SOURCE.md": "closed",
            "hive/ui/src/experiences/omegatown/README.md": "town",
            "docs/omegaevolve/SEED_PAIR.md": "seed", "research/secret/CLOSED_SOURCE.md": "closed",
            "research/secret/model.py": "y = 2",
            "channels/whatsapp_bridge/CLOSED_SOURCE.md": "closed", "channels/whatsapp_bridge/bridge.mjs": "//",
            "hive/core/evolve_seed.py": "evolve", "hive/spaces/lib_evolve.metta": "evolve",
            "hive/tests/test_omegabench_evolve.py": "evolve", "hive/ui/src/features/tasks/EvolveObjective.tsx": "evolve",
            "hive/ui/dist/assets/evolvePc-1a2b3c.js": "evolve",
            "modules/tools_home_assistant/entry.metta": "open", "hive/plugins/commons_explorer/plugin.json": "{}",
        }
        if licence:
            files["channels/whatsapp_bridge/LICENSE-libsignal-GPL-3.0"] = "GNU GENERAL PUBLIC LICENSE"
        files.update(extra or {})
        for rel, text in files.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
        return root

    def mac_zip(self, root, name="mac.zip", extra=None):
        """A Mac-shaped zip of root: "Omega Hive v9/omegahive/..." beside the double-click file."""
        path = self.tmp / name
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Omega Hive v9/Install Omega.command", "#!/bin/sh\n")
            for f in sorted(root.rglob("*")):
                if f.is_file():
                    zf.write(f, "Omega Hive v9/omegahive/" + f.relative_to(root).as_posix())
            for rel, data in (extra or {}).items():
                zf.writestr("Omega Hive v9/omegahive/" + rel, data)
        return path

    def windows_zip(self, root, name="win.zip"):
        """A Windows-shaped zip of root: the code as one omegahive.tar.gz beside the installer files."""
        members = {"omegahive/" + f.relative_to(root).as_posix(): f.read_bytes()
                   for f in sorted(root.rglob("*")) if f.is_file()}
        path = self.tmp / name
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Omega Hive v9/Install Omega.cmd", "@echo off\r\n")
            zf.writestr("Omega Hive v9/omegahive/Install-OmegaHive.ps1", "# installer\n")
            zf.writestr("Omega Hive v9/omegahive/omegahive.tar.gz", tgz(members))
        return path

    def test_prune_leaves_out_closed_and_kept_out_parts_and_keeps_open_and_published_ones(self):
        root = self.tree()
        removed = public_release.prune(root)
        self.assertEqual(removed, ["docs/omegaevolve", "hive/core/evolve_seed.py", "hive/plugins/omegaevolve",
                                   "hive/spaces/lib_evolve.metta", "hive/tests/test_omegabench_evolve.py",
                                   "hive/ui/dist/assets/evolvePc-1a2b3c.js", "hive/ui/src/experiences/omegatown",
                                   "hive/ui/src/features/tasks/EvolveObjective.tsx", "research/secret"])
        for kept in ("channels/whatsapp_bridge/bridge.mjs", "channels/whatsapp_bridge/LICENSE-libsignal-GPL-3.0",
                     "modules/tools_home_assistant/entry.metta", "hive/plugins/commons_explorer/plugin.json"):
            self.assertTrue((root / kept).is_file(), kept)
        self.assertEqual(public_release.prune(root), [])       # a pruned tree has nothing left to leave out

    def test_prune_refuses_a_published_folder_without_its_licence_before_removing_anything(self):
        root = self.tree(licence=False)
        with self.assertRaises(SystemExit) as refused:
            public_release.prune(root)
        self.assertIn("channels/whatsapp_bridge is published only with LICENSE-libsignal-GPL-3.0", str(refused.exception))
        self.assertTrue((root / "hive/plugins/omegaevolve/program.py").is_file())

    def test_check_names_every_part_a_mac_zip_may_not_carry(self):
        root = self.tree()
        found = public_release.problems(self.mac_zip(root, "unpruned.zip"))
        joined = "\n".join(found)
        for expected in ("hive/plugins/omegaevolve/program.py: Evolve stays out of public zips",
                         "hive/ui/src/experiences/omegatown/README.md: OmegaTown stays out of public zips",
                         "docs/omegaevolve/SEED_PAIR.md: Evolve stays out of public zips",
                         "hive/core/evolve_seed.py: Evolve stays out of public zips",
                         "hive/ui/dist/assets/evolvePc-1a2b3c.js: Evolve stays out of public zips",
                         "research/secret: marked Closed Source for Product Consideration"):
            self.assertIn(expected, joined)
        self.assertNotIn("whatsapp_bridge", joined)               # published, and its licence is beside it
        self.assertNotIn("tools_home_assistant", joined)
        public_release.prune(root)
        self.assertEqual(public_release.problems(self.mac_zip(root, "pruned.zip")), [])

    def test_check_refuses_assist_by_name_and_inside_carried_archives(self):
        root = self.tree()
        public_release.prune(root)
        assist_prebuilt = self.mac_zip(root, "prebuilt.zip", {"install/macos/omegaassist-0.1.tgz": tgz({"a": b"x"})})
        self.assertIn("install/macos/omegaassist-0.1.tgz: Assist stays out of public zips",
                      public_release.problems(assist_prebuilt))
        carried = self.mac_zip(root, "carried.zip",
                               {"install/macos/omega-tools-1.tgz": tgz({"omega-tools/omegaassist/plugin.json": b"{}"})})
        self.assertIn("install/macos/omega-tools-1.tgz: carries omega-tools/omegaassist/plugin.json, and Assist stays out "
                      "of public zips", public_release.problems(carried))

    def test_check_refuses_evolve_built_into_a_carried_ui_archive(self):
        root = self.tree()
        public_release.prune(root)
        carried = self.mac_zip(root, "ui.zip",
                               {"install/macos/ui-dist-r9.tar.gz": tgz({"dist/assets/EvolveObjective-9f8e7d.js": b"x"})})
        self.assertEqual(public_release.problems(carried),
                         ["install/macos/ui-dist-r9.tar.gz: carries dist/assets/EvolveObjective-9f8e7d.js, and Evolve "
                          "stays out of public zips"])

    def test_check_reads_inside_the_windows_code_tarball(self):
        root = self.tree()
        joined = "\n".join(public_release.problems(self.windows_zip(root, "unpruned.zip")))
        self.assertIn("hive/plugins/omegaevolve/program.py: Evolve stays out of public zips", joined)
        self.assertIn("research/secret: marked Closed Source for Product Consideration", joined)
        public_release.prune(root)
        self.assertEqual(public_release.problems(self.windows_zip(root, "pruned.zip")), [])
        (root / "channels/whatsapp_bridge/LICENSE-libsignal-GPL-3.0").unlink()
        self.assertEqual(public_release.problems(self.windows_zip(root, "unlicensed.zip")),
                         ["channels/whatsapp_bridge: published only with LICENSE-libsignal-GPL-3.0 beside it, and the "
                          "zip has none"])

    def test_check_refuses_a_zip_with_no_release_folder(self):
        path = self.tmp / "empty.zip"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("readme.txt", "nothing")
        self.assertEqual(len(public_release.problems(path)), 1)
        self.assertIn("holds no release folder", public_release.problems(path)[0])

    def test_this_repositorys_tree_prunes_to_exactly_its_closed_parts(self):
        """git archive of HEAD, as a release build exports it: prune removes each marked folder PUBLISHED does not
        name and each KEPT_OUT path, nothing else, and every published folder stays with libsignal's own licence."""
        root = self.tmp / "omegahive"
        root.mkdir()
        archive = subprocess.run(["git", "-C", str(ROOT), "archive", "--format=tar", "HEAD"], capture_output=True)
        if archive.returncode != 0:
            self.skipTest(f"no git history to archive: {archive.stderr.decode()[:200]}")
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tf:
            tf.extractall(root, filter="tar")
        marked = {m.parent.relative_to(root).as_posix() for m in root.rglob(public_release.MARKER)}
        expected = {folder for folder in marked if folder not in public_release.PUBLISHED}
        expected |= {p.relative_to(root).as_posix() for p in root.rglob("*")
                     if public_release.kept_out(p.relative_to(root).as_posix())
                     and public_release.kept_out(p.parent.relative_to(root).as_posix()) is None}
        expected = {e for e in expected if not any(e.startswith(f + "/") for f in expected)}
        self.assertEqual(set(public_release.prune(root)), expected)
        for folder, licence in public_release.PUBLISHED.items():
            if (root / folder).exists():
                self.assertEqual(hashlib.sha256((root / folder / licence).read_bytes()).hexdigest(),
                                 LIBSIGNAL_LICENSE_SHA256, folder)
        self.assertFalse(any(public_release.kept_out(p.relative_to(root).as_posix()) for p in root.rglob("*")))

    def test_main_carries_no_evolve_file_while_the_rule_keeps_it_out(self):
        """Jon on omega-flagship/omegahive#106 (12 Nov 2026, issuecomment-6829941322): Evolve is out of scope for the
        launch candidate, so it is out of main as well as every public release until it launches. While KEPT_OUT keeps
        Evolve out, no tracked file may be Evolve's, so a carry or merge that brings one back fails here before a
        release is built from it."""
        tracked = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True)
        if tracked.returncode != 0:
            self.skipTest(f"no git index to read: {tracked.stderr.decode()[:200]}")
        names = [n for n in tracked.stdout.decode().split("\0") if n]
        self.assertIn("install/public_release.py", names)
        self.assertEqual([n for n in names if public_release.kept_out(n) == "Evolve"], [])

    def test_the_tracked_release_manifest_names_no_evolve_path(self):
        """RELEASE_FILES.json rides in every public zip, since the release builds git-archive the revision, so while
        KEPT_OUT keeps Evolve out the manifest may not name an Evolve path either (review on #284).
        scripts/build_release.py rewrites it from the tracked tree."""
        manifest = json.loads((ROOT / "RELEASE_FILES.json").read_text())
        self.assertIn("install/public_release.py", manifest)
        self.assertEqual([n for n in manifest if public_release.kept_out(n) == "Evolve"], [])


if __name__ == "__main__":
    unittest.main()
