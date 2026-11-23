#!/usr/bin/env python3
"""Purpose: check the release builds, install/macos/make-mac-release.sh and install/windows/make-windows-release.sh, on
this repository's HEAD with a stand-in built UI: each zip leaves out what install/public_release.py keeps out, carries
the WhatsApp bridge with libsignal's licence beside it and passes the rule's check; the Mac build writes the update
channel its inputs name (each channel reads its own feed asset of omega-flagship/omegahive-installer unless told
otherwise), refuses to build without one or with a channel that cannot name a feed, and stops without leaving a zip
when a prebuilt Assist archive would ship.

The builds export HEAD, so they check what is committed. Needs git, zip and sha256sum (or shasum):
    python3 -m unittest tests/test_release_build.py
"""
import hashlib
import io
import json
import os
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

MAC_BUILD = ROOT / "install" / "macos" / "make-mac-release.sh"
WINDOWS_BUILD = ROOT / "install" / "windows" / "make-windows-release.sh"
RELEASE_FEED = ("https://github.com/omega-flagship/omegahive-installer/releases/download/mac-update-feed/"
                "omegahive-mac-update.json")
KEY, NEXT_KEY, TEST_KEY = "a" * 64, "b" * 64, "c" * 64


class ReleaseBuildTest(unittest.TestCase):
    def setUp(self):
        if subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--verify", "HEAD"], capture_output=True).returncode:
            self.skipTest("the release builds export a git revision, and this tree has none")
        for tool in ("zip", "unzip"):
            if not shutil.which(tool):
                self.skipTest(f"no {tool} on PATH")
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="release-build-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.dist = self.tmp / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<!doctype html><title>Omega hive</title>\n")

    def build(self, script, out_name, *prebuilt, **env):
        """Run a release build of HEAD into tmp/out_name with the stand-in UI and env added to os.environ."""
        out = self.tmp / out_name
        clean = {k: v for k, v in os.environ.items() if not k.startswith(("UPDATE_", "UI_DIST", "RELEASE_NAME", "FEEDBACK_TO"))}
        done = subprocess.run(["/bin/sh", str(script), str(ROOT), "HEAD", str(out), *map(str, prebuilt)],
                              env=dict(clean, UI_DIST_DIR=str(self.dist), **env), capture_output=True, text=True)
        return done, out

    def member(self, zip_path, suffix):
        with zipfile.ZipFile(zip_path) as zf:
            (name,) = [n for n in zf.namelist() if n.endswith(suffix)]
            return zf.read(name)

    def test_a_release_build_trusts_only_the_keys_it_is_given_and_reads_the_installer_repos_feed(self):
        done, out = self.build(MAC_BUILD, "mac.zip", UPDATE_PUBKEY=KEY, UPDATE_NEXT_PUBKEYS=NEXT_KEY,
                               RELEASE_NAME="mac-hive-v9.9")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(public_release.problems(out), [])
        trust = json.loads(self.member(out, "omegahive/install/macos/update-trust.json"))
        self.assertEqual((trust["channel"], trust["feed"], trust["keys"], trust["next_keys"]),
                         ("release", RELEASE_FEED, [KEY], [NEXT_KEY]))
        self.assertEqual(self.member(out, "omegahive/RELEASE_VERSION"), b"9.9\n")
        # built without FEEDBACK_TO: no destination of its own, so its hives keep the board or their own setting
        with zipfile.ZipFile(out) as zf:
            self.assertFalse([n for n in zf.namelist() if n.endswith("omegahive/FEEDBACK_TO")])
        wrapper = self.member(out, "/Install Omega.command").decode()
        self.assertIn('echo "Omega hive for Mac, mac-hive-v9.9"', wrapper)
        self.assertIn("releases=https://github.com/omega-flagship/omegahive-installer/releases", wrapper)
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        self.assertFalse([n for n in names if public_release.kept_out(n)])
        self.assertFalse([n for n in names if n.endswith("/CLOSED_SOURCE.md")
                          and n.split("/omegahive/", 1)[1].rpartition("/")[0] not in public_release.PUBLISHED])
        for folder, licence in public_release.PUBLISHED.items():
            text = self.member(out, f"omegahive/{folder}/{licence}")
            self.assertTrue(text.lstrip().startswith(b"GNU GENERAL PUBLIC LICENSE"), folder)

    def test_a_test_build_ships_the_trust_file_it_is_given_as_it_is(self):
        trust_file = self.tmp / "test-trust.json"
        subprocess.run([sys.executable, str(ROOT / "install" / "macos" / "publish-update.py"), "trust", "--channel",
                        "test", "--feed", "https://gist.githubusercontent.com/tester/abc123/raw/feed.json", "--pubkey",
                        TEST_KEY, "--out", str(trust_file)], check=True, capture_output=True)
        done, out = self.build(MAC_BUILD, "mac-test.zip", UPDATE_TRUST=str(trust_file), RELEASE_NAME="mac-hive-v9.8")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(self.member(out, "omegahive/install/macos/update-trust.json")),
                         json.loads(trust_file.read_text()))
        self.assertIn('echo "Omega hive for Mac, test build mac-hive-v9.8"',
                      self.member(out, "/Install Omega.command").decode())

    def test_a_test_channel_build_reads_its_own_channels_feed(self):
        # The release feed carries release statements, which a test hive refuses, so a test build's default is its own.
        done, out = self.build(MAC_BUILD, "mac-test-channel.zip", UPDATE_PUBKEY=TEST_KEY, UPDATE_CHANNEL="test",
                               RELEASE_NAME="mac-hive-v9.6")
        self.assertEqual(done.returncode, 0, done.stderr)
        trust = json.loads(self.member(out, "omegahive/install/macos/update-trust.json"))
        self.assertEqual((trust["channel"], trust["feed"], trust["keys"]),
                         ("test", RELEASE_FEED.replace("omegahive-mac-update.json", "omegahive-mac-update-test.json"),
                          [TEST_KEY]))

    def test_a_channel_that_cannot_name_a_feed_is_refused_before_anything_is_built(self):
        done, out = self.build(MAC_BUILD, "mac-odd-channel.zip", UPDATE_PUBKEY=TEST_KEY, UPDATE_CHANNEL="Test Builds")
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn("cannot name a feed file", done.stderr)
        self.assertFalse(out.exists())
        self.assertEqual(list(self.tmp.glob("release.*")), [])

    def test_a_build_without_an_update_channel_is_refused_before_anything_is_built(self):
        done, out = self.build(MAC_BUILD, "none.zip")
        self.assertEqual(done.returncode, 2)
        self.assertIn("no update channel", done.stderr)
        self.assertFalse(out.exists())

    def test_a_build_given_an_assist_prebuilt_stops_and_leaves_no_zip(self):
        prebuilt = self.tmp / "omegaassist-0.1.tgz"
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as tf:
            info = tarfile.TarInfo("omegaassist/plugin.json")
            info.size = 2
            tf.addfile(info, io.BytesIO(b"{}"))
        prebuilt.write_bytes(data.getvalue())
        (self.tmp / "omegaassist-0.1.tgz.sha256").write_text(
            f"{hashlib.sha256(prebuilt.read_bytes()).hexdigest()}  omegaassist-0.1.tgz\n")
        done, out = self.build(MAC_BUILD, "assist.zip", prebuilt, UPDATE_PUBKEY=KEY, RELEASE_NAME="mac-hive-v9.7")
        self.assertEqual(done.returncode, 1)
        self.assertIn("install/macos/omegaassist-0.1.tgz: Assist stays out of public zips", done.stderr)
        self.assertFalse(out.exists())

    def test_a_windows_build_leaves_out_closed_parts_and_ships_the_bridge_licence(self):
        done, out = self.build(WINDOWS_BUILD, "win.zip", RELEASE_NAME="win-hive-v9.9")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(public_release.problems(out), [])
        self.assertEqual(self.member(out, "omegahive/RELEASE_NAME"), b"win-hive-v9.9\r\n")
        with tarfile.open(fileobj=io.BytesIO(self.member(out, "omegahive/omegahive.tar.gz"))) as tf:
            names = tf.getnames()
        self.assertIn("omegahive/channels/whatsapp_bridge/LICENSE-libsignal-GPL-3.0", names)
        self.assertFalse([n for n in names if public_release.kept_out(n)])

    def test_a_release_built_with_a_feedback_destination_carries_it_and_one_the_hive_cannot_use_stops_the_build(self):
        to = "https://reports.example.org/hive"
        done, out = self.build(MAC_BUILD, "mac-to.zip", UPDATE_PUBKEY=KEY, RELEASE_NAME="mac-hive-v9.9", FEEDBACK_TO=to)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.member(out, "omegahive/FEEDBACK_TO"), f"{to}\n".encode())
        done, out = self.build(WINDOWS_BUILD, "win-to.zip", RELEASE_NAME="win-hive-v9.9", FEEDBACK_TO=to)
        self.assertEqual(done.returncode, 0, done.stderr)
        with tarfile.open(fileobj=io.BytesIO(self.member(out, "omegahive/omegahive.tar.gz"))) as tf:
            self.assertEqual(tf.extractfile("omegahive/FEEDBACK_TO").read(), f"{to}\n".encode())
        for script, name in ((MAC_BUILD, "mac-bad.zip"), (WINDOWS_BUILD, "win-bad.zip")):
            done, out = self.build(script, name, UPDATE_PUBKEY=KEY, FEEDBACK_TO="ftp://reports.example.org")
            self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
            self.assertIn("FEEDBACK_TO: the feedback destination must be an https address, an http address on this machine "
                          "or at HIVE_FEEDBACK_SERVICE_HOST, or none", done.stderr)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
