#!/usr/bin/env python3
"""Purpose: check the Mac hive updater (install/macos/update.py) and its release side (publish-update.py) against
statements and zips served from loopback: every refusal (signature, app, channel, a replaced key, a rotation no next
key signed, expiry, an older statement, a wrong download, a wrong unzipped folder, a download that changes after its
check, a release whose own trust file would strand the hive), the release and test channels kept apart, next keys
taking over through rotations however many a
hive is behind, every test build's own updater taking the statements publish-update.py signs now, Not now, an offer
nobody answers and how each dialog ending is read, the zip arriving directly or through a browser into Downloads,
Safari's own unzip of it, the hourly launchd job handing the refresh to Terminal, so does an update taken with no
terminal (the Omega Hive app's open), the Updates page's Check now (the offer kept for the page with no dialog, a busy
lock, and why a check could not check kept until one takes a statement), a build without a trust file, a trust file
from before channels, and publishing to a gist or a GitHub release through a stand-in gh; each update ends with the new
release's installer run over the hive.

The direct download is also run against a loopback server whose every answer a test scripts (DirectDownloadTest): after
a stall or a dropped connection it asks for the rest and appends it, it starts over when the server ignores Range or
answers from another byte, and it gives up once tries in a row get no further.

Runs anywhere with OpenSSL 3's libcrypto and zip; the tests that unpack a release run on macOS only, since hives unpack
with ditto (zips are made with zip -y, as make-mac-release.sh does). The test builds' own updaters come from this
repository's mac-hive-v* tags (git fetch --tags):
    python3 -m unittest tests/test_mac_update.py
"""

import datetime
import functools
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
MACOS = ROOT / "install" / "macos"
sys.path.insert(0, str(MACOS))
import release_sig  # noqa: E402

PUBLISH = MACOS / "publish-update.py"
# A release's installer as the hive's update runs it: it refreshes the hive's app, here its release number and the
# trust file the release was built with.
INSTALLER = ('#!/bin/bash\nset -e\n'
             'printf "%s\\n" "$(cat "$(dirname "$0")/../../RELEASE_VERSION")" > "$OMEGAHIVE_HOME/app/RELEASE_VERSION"\n'
             'if [ -f "$(dirname "$0")/update-trust.json" ]; then\n'
             '  cp "$(dirname "$0")/update-trust.json" "$OMEGAHIVE_HOME/app/install/macos/update-trust.json"\nfi\n')
# What publish-update.py asks of gh, played back: a gist's files kept in $GH_STAND_IN_STORE/gists, a release upload
# copied into $GH_STAND_IN_UPLOAD (nowhere when unset, as an upload a hive cannot read), every call logged.
GH_STAND_IN = r'''import json, os, pathlib, re, shutil, sys
store, upload, args = pathlib.Path(os.environ["GH_STAND_IN_STORE"]), os.environ.get("GH_STAND_IN_UPLOAD"), sys.argv[1:]
with open(store / "gh.log", "a") as log:
    log.write(json.dumps(args) + "\n")
gists = store / "gists"
gists.mkdir(exist_ok=True)
if args[:3] == ["api", "--method", "PATCH"] and args[4:] == ["--input", "-"]:
    gist = gists / (args[3].rsplit("/", 1)[-1] + ".json")
    files = json.loads(gist.read_text()) if gist.exists() else {}
    files.update(json.load(sys.stdin)["files"])
    gist.write_text(json.dumps(files))
elif args[:1] == ["api"] and args[2:3] == ["--jq"]:
    files = json.loads((gists / (args[1].rsplit("/", 1)[-1] + ".json")).read_text())
    print(files[json.loads(re.fullmatch(r'\.files\[(".*")\]\.content', args[3]).group(1))]["content"])
elif args[:2] == ["release", "upload"] and "--clobber" in args:
    if upload:
        shutil.copy(args[3], pathlib.Path(upload) / pathlib.Path(args[3]).name)
else:
    sys.exit(f"the stand-in gh does not know {args}")
'''
mac_only = unittest.skipUnless(sys.platform == "darwin", "unpacks a release with macOS's ditto")


class MacUpdateTest(unittest.TestCase):
    def setUp(self):
        """A hive at release 0.9 whose update-trust.json, written as a release build writes it, takes the test
        channel's statements signed by a test key, and a loopback server for statements and zips."""
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="mac-update-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.key = self.tmp / "key.json"
        self.pubkey = release_sig.new_key_file(self.key, "test")
        self.serve = self.tmp / "serve"
        self.serve.mkdir()
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(self.serve))
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)     # cleanups run last first
        self.base = f"http://127.0.0.1:{httpd.server_address[1]}"
        # update.py reads update-trust.json beside itself: a copy runs from the hive's app folder, as on a hive.
        self.home = self.tmp / "OmegaHive"
        self.macos = self.home / "app" / "install" / "macos"
        self.macos.mkdir(parents=True)
        for name in ("update.py", "release_sig.py", "publish-update.py"):
            shutil.copy(MACOS / name, self.macos / name)
        self.write_trust(self.macos / "update-trust.json", self.pubkey)
        (self.home / "app" / "RELEASE_VERSION").write_text("0.9\n")
        self.downloads = self.tmp / "Downloads"
        self.downloads.mkdir()

    # --- helpers ---------------------------------------------------------------------------------------------------

    def write_trust(self, path, *keys, channel="test", next_keys=(), feed=None):
        """A trust file as a release build writes it, through publish-update.py trust."""
        argv = [sys.executable, str(PUBLISH), "trust", "--channel", channel, "--feed", feed or f"{self.base}/feed.json",
                "--out", str(path)]
        for key in keys:
            argv += ["--pubkey", key]
        for key in next_keys:
            argv += ["--next-pubkey", key]
        subprocess.run(argv, check=True, capture_output=True)

    def make_zip(self, version, keys=None, next_keys=(), channel="test", feed=None, raw_trust=None, trust_file=True):
        """A release zip shaped as make-mac-release.sh makes it (zip -qry of "Omega Hive"), with an executable and a
        link for the tree digest, whose installer sets the hive's RELEASE_VERSION. Its trust file lists keys (the test
        key by default) for channel, or is raw_trust as given, or is missing without trust_file."""
        top = self.tmp / f"build-{version}" / "Omega Hive"
        shutil.rmtree(top.parent, ignore_errors=True)
        code = top / "omegahive"
        (code / "install" / "macos").mkdir(parents=True)
        (code / "RELEASE_VERSION").write_text(f"{version}\n")
        trust = code / "install" / "macos" / "update-trust.json"
        if not trust_file:
            pass
        elif raw_trust is not None:
            trust.write_text(json.dumps(raw_trust))
        else:
            self.write_trust(trust, *(keys or [self.pubkey]), channel=channel, next_keys=next_keys, feed=feed)
        installer = code / "install" / "macos" / "Install OmegaHive.command"
        installer.write_text(INSTALLER)
        installer.chmod(0o755)
        (top / "Install Omega.command").symlink_to("omegahive/install/macos/Install OmegaHive.command")
        out = self.serve / f"release-{version}.zip"
        out.unlink(missing_ok=True)
        if not shutil.which("zip"):
            self.skipTest("no zip on PATH to make a release zip with")
        subprocess.run([shutil.which("zip"), "-qry", str(out), "Omega Hive"], cwd=top.parent, check=True)
        return out

    def publish(self, zip_path, days=30, key=None):
        out = self.serve / "feed.json"
        subprocess.run([sys.executable, str(PUBLISH), "sign", str(zip_path), "--notes", "a test release",
                        "--url", f"{self.base}/{zip_path.name}", "--days", str(days), "--key", str(key or self.key),
                        "--out", str(out)], check=True, capture_output=True)
        return json.loads(out.read_text())

    def statement_for(self, zip_path, version, key=None):
        """A test-channel statement for zip_path signed by hand, as a careless or hostile signer could make one that
        publish-update.py refuses to sign, served as the feed."""
        data = zip_path.read_bytes()
        expires = datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=30)
        st = {"app": "omegahive-mac", "channel": "test", "version": version, "label": f"v{version}", "notes": "",
              "url": f"{self.base}/{zip_path.name}", "zip_sha256": hashlib.sha256(data).hexdigest(),
              "zip_length": len(data), "tree_sha256": release_sig.tree_digest_of_zip(zip_path),
              "expires": expires.strftime("%Y-%m-%dT%H:%M:%SZ")}
        doc = {"statement": st, "sig": release_sig.load_key_file(key or self.key).sign(release_sig.message(st))}
        (self.serve / "feed.json").write_text(json.dumps(doc))
        return doc

    def new_key(self, name):
        """A fresh key file in this test's folder and its public half."""
        path = self.tmp / f"{name}.json"
        return path, release_sig.new_key_file(path, name)

    def rotate(self, trust, key, *next_pubkeys):
        """publish-update.py rotate over trust, as the release machine runs it: the trust file it writes, read."""
        out = self.tmp / f"rotated-{len(list(self.tmp.glob('rotated-*')))}.json"
        argv = [sys.executable, str(PUBLISH), "rotate", str(trust), "--key", str(key), "--out", str(out)]
        for pubkey in next_pubkeys:
            argv += ["--next-pubkey", pubkey]
        done = subprocess.run(argv, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return out, json.loads(out.read_text())

    def check(self, *extra, home=None):
        home = home or self.home
        return subprocess.run([sys.executable, "-I", str(home / "app" / "install" / "macos" / "update.py"), "check",
                               "--home", str(home), *extra], capture_output=True, text=True)

    def hives_of_test_builds(self):
        """(tag, hive folder) for every test build tagged mac-hive-v* in this repository whose release carries an
        updater: a hive at release 0.9 running that tag's own update.py and release_sig.py, with the trust file its
        build wrote, from the tag's own trust writer or, before channels, its committed file, now naming this test's
        loopback feed and test key."""
        try:
            listed = subprocess.run(["git", "-C", str(ROOT), "tag", "-l", "mac-hive-v*"], check=True,
                                    capture_output=True, text=True).stdout.split()
        except (OSError, subprocess.CalledProcessError):
            listed = []
        hives = []
        for tag in sorted(listed, key=lambda t: [int(n) for n in t[len("mac-hive-v"):].split(".")]):
            home = self.tmp / f"hive-{tag}"
            macos = home / "app" / "install" / "macos"
            macos.mkdir(parents=True)
            for name in ("update.py", "release_sig.py", "publish-update.py", "update-trust.json"):
                got = subprocess.run(["git", "-C", str(ROOT), "show", f"{tag}:install/macos/{name}"],
                                     capture_output=True)
                if got.returncode == 0:
                    (macos / name).write_bytes(got.stdout)
            if not (macos / "update.py").exists():
                continue                    # builds before the updater are updated by a download, as they always were
            feed = f"{self.base}/feed.json"
            if (macos / "update-trust.json").exists():
                legacy = json.loads((macos / "update-trust.json").read_text())
                (macos / "update-trust.json").write_text(json.dumps(dict(legacy, feed=feed, pubkey=self.pubkey)))
            else:
                subprocess.run([sys.executable, str(macos / "publish-update.py"), "trust", "--channel", "test", "--feed",
                                feed, "--pubkey", self.pubkey, "--out", str(macos / "update-trust.json")],
                               check=True, capture_output=True)
            (home / "app" / "RELEASE_VERSION").write_text("0.9\n")
            hives.append((tag, home))
        if not hives:
            self.skipTest("no mac-hive-v* tag with an updater in this clone (git fetch --tags)")
        return hives

    def opener(self, body):
        """A stand-in for /usr/bin/open: a shell script given the body to run with the URL in $1."""
        path = self.tmp / "opener.sh"
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
        return str(path)

    def stand_in_gh(self, upload_to=None):
        """The environment for publish-update.py with GH_STAND_IN first on PATH as gh."""
        folder = self.tmp / "bin"
        folder.mkdir(exist_ok=True)
        gh = folder / "gh"
        gh.write_text(f"#!{sys.executable}\n# Purpose: stand in for gh in the publish tests.\n{GH_STAND_IN}")
        gh.chmod(0o755)
        env = dict(os.environ, PATH=f"{folder}:{os.environ['PATH']}", GH_STAND_IN_STORE=str(self.tmp))
        if upload_to:
            env["GH_STAND_IN_UPLOAD"] = str(upload_to)
        return env

    def run_publish(self, zip_path, *extra, env):
        return subprocess.run([sys.executable, str(PUBLISH), "publish", str(zip_path), "--url",
                               f"{self.base}/{zip_path.name}", "--key", str(self.key), *extra],
                              env=env, capture_output=True, text=True)

    def gh_calls(self):
        return [json.loads(line) for line in (self.tmp / "gh.log").read_text().splitlines()]

    def installed(self):
        return (self.home / "app" / "RELEASE_VERSION").read_text().strip()

    def log(self):
        path = self.home / "logs" / "update.log"
        return path.read_text() if path.exists() else ""

    def state(self):
        return json.loads((self.home / "run" / "update-state.json").read_text())

    def assert_nothing_taken(self):
        """No statement taken and no key retired: the state holds at most its channel and why the check could not
        check, which the Updates page says."""
        path = self.home / "run" / "update-state.json"
        state = json.loads(path.read_text()) if path.exists() else {}
        self.assertEqual(set(state) - {"channel", "check_failed"}, set(), state)

    # --- what an owner gets ----------------------------------------------------------------------------------------

    @mac_only
    def test_a_newer_signed_release_installs_through_its_own_installer(self):
        self.publish(self.make_zip("0.10"))           # 0.10 is above 0.9 number by number, though not as text
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.10")
        self.assertIn("updated to v0.10", self.log())
        again = self.check("--answer", "Update")      # now up to date: nothing is offered
        self.assertEqual(again.returncode, 0)
        self.assertIn("up to date: release 0.10, newest 0.10", self.log())

    def test_not_now_waits_a_day_and_records_the_choice(self):
        self.publish(self.make_zip("0.10"))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertEqual(self.state()["deferred"]["version"], "0.10")
        self.assertEqual(self.state()["seen"], "0.10")

    @mac_only
    def test_an_offer_nobody_answers_waits_for_no_day_and_is_offered_again(self):
        # The hourly job's dialog gives up after ten minutes when nobody is at the Mac.
        self.publish(self.make_zip("0.10"))
        self.assertEqual(self.check("--answer", "No answer").returncode, 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertNotIn("deferred", self.state())
        self.assertIn("offered v0.10 (version 0.10) over release 0.9: No answer", self.log())
        done = self.check("--answer", "Update")       # the next check offers it again, and the owner takes it
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.10")

    def test_each_dialog_ending_reads_as_its_answer(self):
        import update
        statement = {"label": "v0.10", "version": "0.10", "notes": "a test release"}
        endings = [((0, "button returned:Update to v0.10, gave up:false", ""), "Update"),
                   ((1, "", "execution error: User canceled. (-128)"), "Not now"),     # the Not now button
                   ((0, "button returned:, gave up:true", ""), "No answer"),           # ten minutes, nobody there
                   ((1, "", "execution error: No user interaction allowed. (-1713)"), "No answer")]   # no screen
        real = update.osascript
        try:
            for (code, out, err), want in endings:
                update.osascript = lambda script, env, r=(code, out, err): subprocess.CompletedProcess([], *r)
                self.assertEqual(update.ask(statement, "0.9"), want, (code, out, err))
        finally:
            update.osascript = real

    @mac_only
    def test_a_private_release_comes_through_the_browser_as_a_zip(self):
        z = self.make_zip("0.10")
        doc = self.publish(z)
        held = shutil.move(z, self.tmp / "held.zip")  # the URL now answers 404, as a private release's does
        (self.downloads / "something-else.zip").write_bytes(b"not it")
        opener = self.opener(f'(sleep 3; cp "{held}" "{self.downloads}/Omega-Hive-Mac (1).zip") &\n')
        done = self.check("--answer", "Update", "--opener", opener, "--downloads", str(self.downloads), "--wait", "60")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.10")
        self.assertIn(doc["statement"]["label"], self.log())

    @mac_only
    def test_safaris_unzipped_folder_is_taken_by_its_signed_tree(self):
        z = self.make_zip("0.10")
        self.publish(z)
        held = shutil.move(z, self.tmp / "held.zip")
        (self.downloads / "Omega Hive").mkdir()       # the first install's folder is still there
        # Safari: unzips into "Omega Hive 2", keeps no zip, and Finder leaves a .DS_Store once the owner looks in.
        opener = self.opener(f'(sleep 3; mkdir "{self.tmp}/x"; /usr/bin/ditto -x -k "{held}" "{self.tmp}/x"; '
                             f'mv "{self.tmp}/x/Omega Hive" "{self.downloads}/Omega Hive 2"; '
                             f'printf junk > "{self.downloads}/Omega Hive 2/.DS_Store") &\n')
        done = self.check("--answer", "Update", "--opener", opener, "--downloads", str(self.downloads), "--wait", "60")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.10")
        self.assertIn("Omega Hive 2", self.log())

    @mac_only
    def test_the_hourly_job_hands_the_refresh_to_terminal_while_the_hive_runs(self):
        self.publish(self.make_zip("0.10"))
        opener = self.opener(f'printf "%s\\n" "$@" > "{self.tmp}/opened"\n')
        not_running = self.check("--job", "--answer", "Update", "--opener", opener)
        self.assertEqual(not_running.returncode, 0)
        self.assertFalse((self.home / "run" / "update-state.json").exists())   # no hive, so not even a look
        run = self.home / "data" / "run"
        run.mkdir(parents=True)
        # The running hive, as its control socket. A socket path holds at most 104 bytes on macOS: run these tests
        # with a short TMPDIR, as a hive's own ~/OmegaHive/data/run/control.sock is short.
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(run / "control.sock"))
        listener.listen(4)
        self.addCleanup(listener.close)
        done = self.check("--job", "--answer", "Update", "--opener", opener)
        self.assertEqual(done.returncode, 0, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.9")     # the job runs no installer itself
        opened = (self.tmp / "opened").read_text().split("\n")
        self.assertEqual(opened[:2], ["-a", "Terminal"])
        script = pathlib.Path(opened[2])
        self.assertIn(f"export OMEGAHIVE_HOME='{self.home}'", script.read_text())
        subprocess.run([str(script)], check=True)     # what Terminal runs
        self.assertEqual(self.installed(), "0.10")
        self.assertIn("handed v0.10's installer to Terminal", self.log())

    @mac_only
    def test_an_update_taken_with_no_terminal_goes_to_terminal_and_exits_10(self):
        # The Omega Hive app's open: no hive need run, and exit 10 keeps open from starting the old hive, since the
        # installer in Terminal refreshes and opens it.
        self.publish(self.make_zip("0.10"))
        opener = self.opener(f'printf "%s\\n" "$@" > "{self.tmp}/opened"\n')
        done = self.check("--terminal", "--answer", "Update", "--opener", opener)
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.9")     # nothing here runs the installer
        opened = (self.tmp / "opened").read_text().split("\n")
        self.assertEqual(opened[:2], ["-a", "Terminal"])
        subprocess.run([opened[2]], check=True)     # what Terminal runs
        self.assertEqual(self.installed(), "0.10")
        self.assertIn("handed v0.10's installer to Terminal", self.log())

    # --- whom a hive trusts ----------------------------------------------------------------------------------------

    def test_a_release_hive_never_takes_a_test_channel_statement_whichever_key_signs_it(self):
        self.write_trust(self.macos / "update-trust.json", self.pubkey, channel="release")
        self.publish(self.make_zip("0.10"))           # a test build's statement, signed with the very key it trusts
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("it is for channel 'test', not this hive's 'release'", self.log())
        self.publish(self.make_zip("0.11", channel="release"))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual(self.state()["seen"], "0.11")

    def test_a_release_hive_refuses_whatever_the_test_key_signs(self):
        """A hive built from a release build trusts its release key alone, with the next key that may replace it."""
        release_key, release_pubkey = self.new_key("release")
        _, release_next = self.new_key("release-next")
        self.write_trust(self.macos / "update-trust.json", release_pubkey, channel="release", next_keys=[release_next])
        self.publish(self.make_zip("0.10"))           # a test build's statement, signed with the test key
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        # Whoever holds the test key cannot make one for the release channel either: the hive does not hold that key.
        forged = self.publish(self.make_zip("0.10"))
        forged["statement"]["channel"] = "release"
        forged["sig"] = release_sig.load_key_file(self.key).sign(release_sig.message(forged["statement"]))
        (self.serve / "feed.json").write_text(json.dumps(forged))
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertEqual(self.log().count("does not check against the release keys"), 2)
        self.assert_nothing_taken()
        self.publish(self.make_zip("0.10", keys=[release_pubkey], channel="release", next_keys=[release_next]),
                     key=release_key)
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual((self.state()["channel"], self.state()["seen"]), ("release", "0.10"))

    def test_a_test_hive_refuses_whatever_the_release_key_signs(self):
        """A test build's hive (setUp's) trusts the test key alone, whichever channel a release-key statement names."""
        release_key, release_pubkey = self.new_key("release")
        self.publish(self.make_zip("0.10", keys=[release_pubkey], channel="release"), key=release_key)
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        doc = self.publish(self.make_zip("0.10", keys=[release_pubkey]), key=release_key)
        self.assertEqual(doc["statement"]["channel"], "test")
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertEqual(self.log().count("does not check against the release keys"), 2)
        self.assertEqual(self.installed(), "0.9")
        self.assert_nothing_taken()
        self.publish(self.make_zip("0.10"))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual((self.state()["channel"], self.state()["seen"]), ("test", "0.10"))

    def test_a_next_key_takes_over_through_its_rotation_and_the_key_it_replaced_signs_nothing_more(self):
        next_key, next_pubkey = self.new_key("next")
        _, third_pubkey = self.new_key("third")
        trust = self.macos / "update-trust.json"
        self.write_trust(trust, self.pubkey, next_keys=[next_pubkey])
        # A next key signs no statement by itself: only its rotation makes it the key.
        self.publish(self.make_zip("0.10", keys=[next_pubkey]), key=next_key)
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertIn("does not check against the release keys", self.log())
        self.assert_nothing_taken()
        # The release machine replaces the key; the next release is built with the trust file rotate writes.
        _, rotated = self.rotate(trust, next_key, third_pubkey)
        self.assertEqual((rotated["seq"], rotated["keys"], rotated["next_keys"]), (1, [next_pubkey], [third_pubkey]))
        zip_path = self.make_zip("0.10", raw_trust=rotated)
        # The rotation stands on its own, as a TUF root does: the replaced key is retired even while the statement
        # beside it has expired and is not taken.
        doc = self.publish(zip_path, key=next_key, days=-1)
        self.assertEqual(doc["rotations"], rotated["rotations"])
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertIn("the release keys moved to rotation 1: the 1 key(s) it replaced sign nothing more here", self.log())
        self.assertIn("could not check: the newest statement (version 0.10) expired", self.log())
        self.assertEqual(self.state()["retired"], [self.pubkey])
        self.assertNotIn("seen", self.state())
        self.publish(zip_path, key=next_key)
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual(self.state()["seen"], "0.10")
        # From then on the replaced key is refused, though this hive's own trust file still lists it.
        self.publish(self.make_zip("0.11"))
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertIn("refused a statement signed by a key a rotation replaced", self.log())
        self.assertEqual(self.state()["seen"], "0.10")

    def test_a_hive_any_number_of_rotations_behind_follows_them_all(self):
        second_key, second = self.new_key("second")
        third_key, third = self.new_key("third")
        _, fourth = self.new_key("fourth")
        first_trust = self.tmp / "first-trust.json"
        self.write_trust(first_trust, self.pubkey, next_keys=[second])
        shutil.copy(first_trust, self.macos / "update-trust.json")   # this hive has the channel's first keys
        second_trust, _ = self.rotate(first_trust, second_key, third)
        third_trust, rotated = self.rotate(second_trust, third_key, fourth)
        doc = self.publish(self.make_zip("0.12", raw_trust=rotated), key=third_key)
        self.assertEqual([r["rotation"]["seq"] for r in doc["rotations"]], [1, 2])
        self.assertEqual(self.check("--answer", "Not now").returncode, 0, self.log())
        self.assertEqual(self.state()["seen"], "0.12")
        self.assertEqual(sorted(self.state()["retired"]), sorted([self.pubkey, second]))
        # publish-update.py verify reads the feed as a hive of any release of the channel does.
        for trust in (first_trust, second_trust, third_trust):
            ok = subprocess.run([sys.executable, str(PUBLISH), "verify", f"{self.base}/feed.json", "--trust", str(trust)],
                                capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)

    def test_a_rotation_its_next_key_did_not_sign_is_refused_and_stops_the_check(self):
        next_key, next_pubkey = self.new_key("next")
        thief, thief_pubkey = self.new_key("thief")
        self.write_trust(self.macos / "update-trust.json", self.pubkey, next_keys=[next_pubkey])
        doc = self.publish(self.make_zip("0.10"))     # a statement this hive takes once the feed holds no bad rotation

        def record(body, signer):
            return {"rotation": body, "sig": release_sig.load_key_file(signer).sign(
                release_sig.message(body, release_sig.ROTATION))}
        to_thief = {"app": "omegahive-mac", "channel": "test", "seq": 1, "keys": [thief_pubkey], "next_keys": []}
        to_next = {"app": "omegahive-mac", "channel": "test", "seq": 1, "keys": [next_pubkey],
                   "next_keys": [thief_pubkey]}
        cases = [([record(to_thief, self.key)], "its keys were not the next keys of the rotation before it"),
                 ([record(to_thief, thief)], "its keys were not the next keys of the rotation before it"),
                 ([record(to_next, self.key)], "refused key rotation 1: no key it names signed it"),
                 ([record(to_next, next_key), record(dict(to_next, next_keys=[]), next_key)],
                  "two claim rotation 1")]
        for rotations, why in cases:
            (self.serve / "feed.json").write_text(json.dumps(dict(doc, rotations=rotations)))
            self.assertEqual(self.check("--answer", "Update").returncode, 0)
            self.assertIn(why, self.log())
        self.assert_nothing_taken()
        (self.serve / "feed.json").write_text(json.dumps(doc))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.assertEqual(self.state()["seen"], "0.10")

    def test_rotate_takes_only_a_next_key_and_fresh_next_keys(self):
        next_key, next_pubkey = self.new_key("next")
        _, fresh = self.new_key("fresh")
        trust = self.tmp / "trust.json"
        self.write_trust(trust, self.pubkey, next_keys=[next_pubkey])
        out = self.tmp / "refused.json"
        for key, next_pubkey_given, why in ((self.key, fresh, "not one of the trust file's next keys"),
                                            (next_key, self.pubkey, "has already been a current key"),
                                            (next_key, next_pubkey, "has already been a current key")):
            done = subprocess.run([sys.executable, str(PUBLISH), "rotate", str(trust), "--key", str(key),
                                   "--next-pubkey", next_pubkey_given, "--out", str(out)], capture_output=True, text=True)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn(why, done.stderr)
        self.assertFalse(out.exists())
        # A trust file whose rotation was edited after rotate signed it is no trust file to build or sign with.
        rotated_path, rotated = self.rotate(trust, next_key, fresh)
        rotated["rotations"][0]["rotation"]["next_keys"] = [self.pubkey]
        rotated["next_keys"] = [self.pubkey]
        rotated_path.write_text(json.dumps(rotated))
        done = subprocess.run([sys.executable, str(PUBLISH), "sign", str(self.make_zip("0.10", raw_trust=rotated)),
                               "--url", f"{self.base}/release-0.10.zip", "--key", str(next_key)],
                              capture_output=True, text=True)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("rotation 1 is not one a hive would take", done.stderr)

    def test_no_edited_rotation_record_ever_redirects_a_hives_keys(self):
        """Exhaustively over a chain of four rotations: a hive holding the trust file of any point of the chain walks
        to its last keys, retiring each key on the way; and with any one record edited after it was signed, or signed by
        the key it replaces, the walk from any point either stops before that record or is refused, so a hive only ever
        holds keys the chain named. Time: 7 edits x 4 records x 5 starting points, each walk at most 4 checks."""
        import update
        keys = [self.new_key(f"chain-{n}") for n in range(6)]     # keys[0] first; keys[5] the last next key
        _, stranger = self.new_key("stranger")                     # a key the chain never names
        path = self.tmp / "chain-trust.json"
        self.write_trust(path, keys[0][1], next_keys=[keys[1][1]])
        trusts = [json.loads(path.read_text())]
        for n in range(1, 5):
            path, trust = self.rotate(path, keys[n][0], keys[n + 1][1])
            trusts.append(trust)
        chain = trusts[-1]["rotations"]
        for start in range(5):
            self.assertEqual(update.walk(trusts[start], chain),
                             (4, [keys[4][1]], [keys[n][1] for n in range(start, 4)]))

        def resigned(record, n):
            body = record["rotation"]
            return dict(record, sig=release_sig.load_key_file(keys[n - 1][0]).sign(
                release_sig.message(body, release_sig.ROTATION)))
        edits = {"signature": lambda r, n: dict(r, sig=r["sig"][:-1] + ("1" if r["sig"][-1] == "0" else "0")),
                 "keys": lambda r, n: dict(r, rotation=dict(r["rotation"], keys=[keys[0][1]])),
                 "next keys": lambda r, n: dict(r, rotation=dict(r["rotation"], next_keys=[stranger])),
                 "seq": lambda r, n: dict(r, rotation=dict(r["rotation"], seq=9)),
                 "channel": lambda r, n: dict(r, rotation=dict(r["rotation"], channel="release")),
                 "app": lambda r, n: dict(r, rotation=dict(r["rotation"], app="another-app")),
                 "signed by the key it replaces": resigned}
        for what, edit in edits.items():
            for n in range(1, 5):
                edited = chain[:n - 1] + [edit(chain[n - 1], n)] + chain[n:]
                for start in range(5):
                    with self.subTest(edit=what, rotation=n, start=start):
                        try:
                            seq, now, _ = update.walk(trusts[start], edited)
                        except update.UpdateError:
                            self.assertLess(start, n)       # refused only where the edited record lies ahead
                            continue
                        self.assertEqual(now, [keys[seq][1]])
                        self.assertTrue(seq < n or start >= n, (seq, now))

    def test_every_test_build_with_an_updater_takes_the_statements_signed_now(self):
        """Hives of every earlier test build keep updating on the test channel: each runs its own release's updater
        against a statement publish-update.py signs now."""
        hives = self.hives_of_test_builds()
        self.publish(self.make_zip("0.24"))
        for tag, home in hives:
            with self.subTest(tag=tag):
                self.assertEqual(self.check("--answer", "Not now", home=home).returncode, 0)
                log = (home / "logs" / "update.log").read_text()
                self.assertIn("offered v0.24 (version 0.24) over release 0.9: Not now", log)

    @mac_only
    def test_every_test_build_with_an_updater_installs_the_release_signed_now(self):
        hives = self.hives_of_test_builds()
        self.publish(self.make_zip("0.24"))
        for tag, home in hives:
            with self.subTest(tag=tag):
                done = self.check("--answer", "Update", home=home)
                self.assertEqual(done.returncode, 10, done.stderr + (home / "logs" / "update.log").read_text())
                self.assertEqual((home / "app" / "RELEASE_VERSION").read_text().strip(), "0.24")

    @mac_only
    def test_a_rotated_release_installs_and_the_hive_follows_the_next_rotation(self):
        second_key, second = self.new_key("second")
        third_key, third = self.new_key("third")
        _, fourth = self.new_key("fourth")
        self.write_trust(self.macos / "update-trust.json", self.pubkey, next_keys=[second])
        second_trust, rotated = self.rotate(self.macos / "update-trust.json", second_key, third)
        self.publish(self.make_zip("0.10", raw_trust=rotated), key=second_key)
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(json.loads((self.macos / "update-trust.json").read_text())["seq"], 1)
        _, rotated = self.rotate(second_trust, third_key, fourth)
        self.publish(self.make_zip("0.11", raw_trust=rotated), key=third_key)
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.11")
        self.assertEqual(sorted(self.state()["retired"]), sorted([self.pubkey, second]))

    @mac_only
    def test_a_release_whose_own_trust_file_would_strand_the_hive_is_never_run(self):
        _, other = self.new_key("other")
        # Each zip is made in its turn: they share one file name, so each replaces the one served before it.
        for made, why in (({"trust_file": False}, "has no update-trust.json this updater reads"),
                          ({"channel": "release"}, "follows channel 'release', not this hive's"),
                          ({"keys": [other]}, "does not lead to the key that signed it")):
            self.statement_for(self.make_zip("0.10", **made), "0.10")
            done = self.check("--answer", "Update")
            self.assertEqual(done.returncode, 1, done.stderr + self.log())
            self.assertIn(why, self.state()["failed"]["error"])
            self.assertEqual(self.installed(), "0.9")

    def test_a_statement_no_key_of_the_hive_signed_is_refused(self):
        other = self.tmp / "other.json"
        other_pubkey = release_sig.new_key_file(other, "other")
        with self.assertRaises(subprocess.CalledProcessError):   # the zip's trust file lists the hive's key, not this
            self.publish(self.make_zip("0.10"), key=other)
        self.publish(self.make_zip("0.10", keys=[other_pubkey]), key=other)   # a zip trusting another key, signed so
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertIn("does not check against the release keys", self.log())
        doc = self.publish(self.make_zip("0.11"))
        doc["statement"]["version"] = "0.12"                    # an edited statement
        (self.serve / "feed.json").write_text(json.dumps(doc))
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertEqual(self.log().count("does not check against the release keys"), 2)

    def test_a_build_made_without_a_trust_file_takes_no_updates(self):
        (self.macos / "update-trust.json").unlink()
        self.publish(self.make_zip("0.10"))
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("no update-trust.json: this build was made without an update channel", self.log())
        state = self.state()                                    # nothing taken, and the Updates page can say why
        self.assertEqual(list(state), ["check_failed"])
        self.assertEqual(state["check_failed"]["reason"], "this build takes no updates")
        self.assertIn("this build was made without an update channel", state["check_failed"]["detail"])

    @mac_only
    def test_a_trust_file_from_before_channels_is_the_test_channel(self):
        """Releases 0.10 to 0.13 shipped {app, feed, pubkey}: publish signs their zips' statements for the test
        channel, and this updater reads such a file as the test channel with its one key."""
        legacy = {"app": "omegahive-mac", "feed": f"{self.base}/feed.json", "pubkey": self.pubkey}
        (self.macos / "update-trust.json").write_text(json.dumps(legacy))
        doc = self.publish(self.make_zip("0.10", raw_trust=legacy))
        self.assertEqual(doc["statement"]["channel"], "test")
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertEqual(self.installed(), "0.10")

    def test_the_trust_writer_refuses_a_file_no_hive_could_use(self):
        out = self.tmp / "trust.json"
        feed = ["--feed", f"{self.base}/feed.json"]
        for bad in (feed + ["--pubkey", "abc"],
                    feed + ["--pubkey", self.pubkey, "--next-pubkey", self.pubkey],
                    ["--feed", "http://example.com/feed.json", "--pubkey", self.pubkey]):
            done = subprocess.run([sys.executable, str(PUBLISH), "trust", "--channel", "test", "--out", str(out), *bad],
                                  capture_output=True, text=True)
            self.assertNotEqual(done.returncode, 0, bad)
            self.assertIn("no hive could use that trust file", done.stderr)
        self.assertFalse(out.exists())

    # --- what a hive refuses ---------------------------------------------------------------------------------------

    def test_an_expired_statement_is_could_not_check(self):
        doc = self.publish(self.make_zip("0.10"))
        doc["statement"]["expires"] = "2020-01-01T00:00:00Z"
        doc["sig"] = release_sig.load_key_file(self.key).sign(release_sig.message(doc["statement"]))
        (self.serve / "feed.json").write_text(json.dumps(doc))
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertIn("could not check: the newest statement (version 0.10) expired", self.log())
        failed = self.state()["check_failed"]
        self.assertEqual(failed["reason"], "the newest release in the feed has expired")
        self.assertIn("expired at 2020-01-01T00:00:00Z", failed["detail"])
        self.assertNotIn("seen", self.state())                 # an expired statement is never taken

    def test_an_older_statement_after_a_newer_one_is_refused(self):
        self.publish(self.make_zip("0.12"))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)
        self.publish(self.make_zip("0.11"))                     # validly signed, but older than one already seen
        self.assertEqual(self.check("--answer", "Update").returncode, 0)
        self.assertIn("refused statement version 0.11, below version 0.12", self.log())

    def test_a_download_that_is_not_the_signed_zip_is_refused_before_unpacking(self):
        z = self.make_zip("0.10")
        self.publish(z)
        z.write_bytes(z.read_bytes() + b"x")                    # longer than the statement says
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("longer than the", self.log())
        self.assertFalse((self.home / "build" / "update-0.10" / "unpacked").exists())

    def test_the_taken_statement_and_its_check_time_are_kept_for_the_updates_page(self):
        self.publish(self.make_zip("0.10"))
        before = datetime.datetime.now(datetime.UTC).replace(microsecond=0)
        self.assertEqual(self.check("--answer", "No answer").returncode, 0)
        state = self.state()
        self.assertEqual(state["offer"], {"version": "0.10", "label": "v0.10", "notes": "a test release"})
        checked = datetime.datetime.strptime(state["checked"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC)
        self.assertLessEqual(before, checked)
        self.assertNotIn("failed", state)

    def test_the_pages_check_keeps_the_offer_for_the_page_and_asks_nothing(self):
        """Check now on the Updates page (a tester back on wifi waited an hour for the hourly check, 16 November): the
        hourly path with no dialog, since the page offers the release itself, and a Not now in the dialog does not
        hide it from a check its owner asked for."""
        import update
        self.publish(self.make_zip("0.10"))
        self.assertEqual(self.check("--answer", "Not now").returncode, 0)          # the dialog's Not now: a day

        def asked(st, installed):
            raise AssertionError(f"the page's check opened the update dialog for {st['label']}")
        # in this process, as the hive's copy would run: its trust file, and a dialog that fails the test if opened
        with mock.patch.object(update, "TRUST_FILE", self.macos / "update-trust.json"), \
                mock.patch.object(update, "ask", asked):
            self.assertEqual(update.main(["check", "--home", str(self.home), "--page"]), 0)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("found v0.10 (version 0.10) over release 0.9 for the Updates page", self.log())
        state = self.state()
        self.assertEqual(state["offer"], {"version": "0.10", "label": "v0.10", "notes": "a test release"})
        self.assertEqual(state["deferred"]["version"], "0.10")                     # the dialog's answer still stands
        self.assertNotIn("check_failed", state)

    def test_the_pages_check_says_another_run_holds_the_lock(self):
        import fcntl
        self.publish(self.make_zip("0.10"))
        (self.home / "run").mkdir()
        with open(self.home / "run" / "update.lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertEqual(self.check("--page").returncode, 3)                   # the page says the updater is busy
            self.assertEqual(self.check("--answer", "Update").returncode, 0)        # the hourly job just skips
        self.assertFalse((self.home / "run" / "update-state.json").exists())         # and neither checked anything

    def test_a_check_that_could_not_check_says_why_until_one_takes_a_statement(self):
        done = self.check("--page")                     # nothing is served at the feed yet: HTTP 404
        self.assertEqual(done.returncode, 0, done.stderr)
        failed = self.state()["check_failed"]
        self.assertEqual(failed["reason"], "the release feed couldn't be reached")      # what the page says
        self.assertIn(f"could not check {self.base}/feed.json", failed["detail"])        # what the log says
        at = datetime.datetime.strptime(failed["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC)
        self.assertLess(abs((datetime.datetime.now(datetime.UTC) - at).total_seconds()), 60)
        doc = self.publish(self.make_zip("0.10"))
        doc["sig"] = "0" * 128                          # signed by nobody: refused, and the page says so
        (self.serve / "feed.json").write_text(json.dumps(doc))
        self.assertEqual(self.check("--page").returncode, 0)
        failed = self.state()["check_failed"]
        self.assertEqual(failed["reason"], "the newest release in the feed didn't check out")
        self.assertIn("does not check against the release keys", failed["detail"])
        self.publish(self.make_zip("0.9"))              # the running release: up to date, and nothing failed
        self.assertEqual(self.check("--page").returncode, 0)
        self.assertIn("up to date: release 0.9, newest 0.9", self.log())
        state = self.state()
        self.assertNotIn("check_failed", state)
        self.assertEqual(state["seen"], "0.9")

    @mac_only
    def test_a_failed_update_says_why_in_the_state_until_one_succeeds(self):
        z = self.make_zip("0.10")
        self.publish(z)
        good = z.read_bytes()
        z.write_bytes(good + b"x")                              # longer than the statement says
        self.assertEqual(self.check("--answer", "Update").returncode, 1)
        failed = self.state()["failed"]
        self.assertEqual(failed["version"], "0.10")
        self.assertIn("longer than the", failed["error"])
        z.write_bytes(good)
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())
        self.assertNotIn("failed", self.state())

    @mac_only
    def test_an_unzipped_folder_that_differs_from_the_signed_tree_is_never_run(self):
        z = self.make_zip("0.10")
        self.publish(z)
        held = shutil.move(z, self.tmp / "held.zip")
        opener = self.opener(f'(mkdir "{self.tmp}/x"; /usr/bin/ditto -x -k "{held}" "{self.tmp}/x"; '
                             f'printf "echo pwned\\n" >> "{self.tmp}/x/Omega Hive/omegahive/install/macos/Install OmegaHive.command"; '
                             f'mv "{self.tmp}/x/Omega Hive" "{self.downloads}/Omega Hive") &\n')
        done = self.check("--answer", "Update", "--opener", opener, "--downloads", str(self.downloads), "--wait", "8")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("no download of v0.10 with the right checksum", self.log())

    def update_changed_after_its_check(self, shape):
        """An update through the browser whose download in Downloads, Safari's folder or the zip, changes right after
        from_browser checked it, as anything running as this user could change it: a line is added to its installer.
        update.py runs in this process, so the change lands between the check and the copy. The status and whether
        the changed installer ran."""
        import update
        z = self.make_zip("0.10")
        self.publish(z)
        held = shutil.move(z, self.tmp / "held.zip")
        ran = self.tmp / "changed-installer-ran"
        if shape == "folder":
            opener = self.opener(f'(mkdir "{self.tmp}/x"; /usr/bin/ditto -x -k "{held}" "{self.tmp}/x"; '
                                 f'mv "{self.tmp}/x/Omega Hive" "{self.downloads}/Omega Hive") &\n')
        else:
            opener = self.opener(f'(sleep 1; cp "{held}" "{self.downloads}/Omega-Hive-Mac.zip") &\n')
        checked = update.from_browser

        def then_changed(*args):
            got = checked(*args)
            folder = got if got.is_dir() else self.tmp / "y" / "Omega Hive"
            if not got.is_dir():
                subprocess.run(["/usr/bin/ditto", "-x", "-k", str(got), str(self.tmp / "y")], check=True)
            with open(folder / "omegahive" / update.INSTALLER, "a") as f:
                f.write(f'touch "{ran}"\n')
            if not got.is_dir():
                got.unlink()
                subprocess.run([shutil.which("zip"), "-qry", str(got), "Omega Hive"], cwd=folder.parent, check=True)
            return got

        with mock.patch.object(update, "from_browser", then_changed), \
                mock.patch.object(update, "TRUST_FILE", self.macos / "update-trust.json"):
            status = update.main(["check", "--home", str(self.home), "--answer", "Update", "--opener", opener,
                                  "--downloads", str(self.downloads), "--wait", "60"])
        return status, ran.exists()

    @mac_only
    def test_a_folder_that_changes_after_its_check_is_never_run(self):
        status, ran = self.update_changed_after_its_check("folder")
        self.assertEqual(status, 1, self.log())
        self.assertFalse(ran)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("the release changed after it was checked", self.log())

    @mac_only
    def test_a_zip_that_changes_after_its_check_is_never_unpacked(self):
        status, ran = self.update_changed_after_its_check("zip")
        self.assertEqual(status, 1, self.log())
        self.assertFalse(ran)
        self.assertEqual(self.installed(), "0.9")
        self.assertIn("the download changed after it was checked", self.log())
        self.assertFalse((self.home / "build" / "update-0.10" / "unpacked" / "Omega Hive").exists())

    # --- the release side ------------------------------------------------------------------------------------------

    @mac_only
    def test_a_zips_tree_digest_is_its_unzipped_folders(self):
        z = self.make_zip("0.10")
        out = self.tmp / "unzipped"
        subprocess.run(["/usr/bin/ditto", "-x", "-k", str(z), str(out)], check=True)
        folder = out / "Omega Hive"
        (folder / ".DS_Store").write_bytes(b"Finder's")       # not the release's, so not in the digest
        self.assertEqual(release_sig.tree_digest_of_zip(z), release_sig.tree_digest_of_dir(folder))
        os.chmod(folder / "omegahive" / "RELEASE_VERSION", 0o755)   # an execute bit is part of the tree
        self.assertNotEqual(release_sig.tree_digest_of_zip(z), release_sig.tree_digest_of_dir(folder))

    def test_publish_verify_reads_a_statement_as_a_hive_does(self):
        z = self.make_zip("0.10")
        self.publish(z)
        for trust in (self.macos / "update-trust.json", z):   # a trust file, or the release zip holding one
            ok = subprocess.run([sys.executable, str(PUBLISH), "verify", f"{self.base}/feed.json", "--trust",
                                 str(trust)], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            self.assertIn("version 0.10 on channel test", ok.stdout)

    def test_publish_writes_the_gist_the_zips_feed_names_and_reads_it_back(self):
        z = self.make_zip("0.10", feed="https://gist.githubusercontent.com/tester/abc123/raw/omegahive-mac-update.json")
        wrong = self.run_publish(z, "--gist", "def456", env=self.stand_in_gh())
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn("the zip's hives read gist abc123", wrong.stderr)
        self.assertFalse((self.tmp / "gh.log").exists())       # refused before gh wrote anything
        done = self.run_publish(z, "--gist", "abc123", env=self.stand_in_gh())
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call[:4] for call in self.gh_calls()],
                         [["api", "--method", "PATCH", "/gists/abc123"], ["api", "/gists/abc123", "--jq",
                                                                          '.files["omegahive-mac-update.json"].content']])
        served = json.loads((self.tmp / "gists" / "abc123.json").read_text())["omegahive-mac-update.json"]["content"]
        self.assertEqual(json.loads(served)["statement"]["channel"], "test")

    @mac_only
    def test_publish_to_a_release_uploads_the_feeds_asset_and_reads_it_as_a_hive_does(self):
        feed = f"{self.base}/omegahive-mac-update.json"
        z = self.make_zip("0.10", feed=feed)
        done = self.run_publish(z, "--release", "mac-hive-v0.10", "--repo", "omega-flagship/omegahive-installer",
                                env=self.stand_in_gh(upload_to=self.serve))
        self.assertEqual(done.returncode, 0, done.stderr)
        (call,) = self.gh_calls()
        self.assertEqual(call[:3], ["release", "upload", "mac-hive-v0.10"])
        self.assertEqual(pathlib.Path(call[3]).name, "omegahive-mac-update.json")
        self.assertEqual(call[4:], ["--clobber", "--repo", "omega-flagship/omegahive-installer"])
        self.write_trust(self.macos / "update-trust.json", self.pubkey, feed=feed)   # a hive built to read that feed
        done = self.check("--answer", "Update")
        self.assertEqual(done.returncode, 10, done.stderr + self.log())

    def test_publish_says_why_when_hives_cannot_read_what_it_wrote(self):
        z = self.make_zip("0.10", feed=f"{self.base}/omegahive-mac-update.json")
        no_gist = self.run_publish(z, "--gist", "abc123", env=self.stand_in_gh())   # this zip's feed is no gist
        self.assertNotEqual(no_gist.returncode, 0)
        self.assertIn("is no gist's raw file", no_gist.stderr)
        # The upload lands where no hive reads, as one into a private repository's release does.
        unread = self.run_publish(z, "--release", "mac-hive-v0.10", env=self.stand_in_gh())
        self.assertNotEqual(unread.returncode, 0)
        self.assertIn("hives cannot read", unread.stderr)
        self.assertIn("HTTP 404", unread.stderr)

    def test_publish_uploads_only_to_the_release_its_feed_names(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("publish_update", PUBLISH)
        publish_update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(publish_update)
        feed = ("https://github.com/omega-flagship/omegahive-installer/releases/download/mac-update-feed/"
                "omegahive-mac-update.json")
        self.assertEqual(publish_update.release_of(feed), ("omega-flagship/omegahive-installer", "mac-update-feed"))
        for other in (f"{self.base}/omegahive-mac-update.json",
                      "https://github.com/omega-flagship/omegahive-installer/releases/latest/download/feed.json",
                      "https://gist.githubusercontent.com/tester/abc123/raw/omegahive-mac-update.json"):
            self.assertIsNone(publish_update.release_of(other), other)
        z = self.make_zip("0.10", feed=feed)
        for extra, wrong in ((["--release", "mac-hive-v0.10"], "not release mac-hive-v0.10"),
                             (["--release", "mac-update-feed", "--repo", "omega-flagship/omegahive"],
                              "not release mac-update-feed of omega-flagship/omegahive")):
            done = self.run_publish(z, *extra, env=self.stand_in_gh())
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("the zip's hives read release mac-update-feed of omega-flagship/omegahive-installer",
                          done.stderr)
            self.assertIn(wrong, done.stderr)
        self.assertFalse((self.tmp / "gh.log").exists())       # refused before gh uploaded anything


class DirectDownloadTest(unittest.TestCase):
    """update.download against a loopback server that answers each request as the test's plan says, one step per
    request (the last repeated): a step honours Range unless "range" is False, answers a 206 from "start" when given,
    answers "status" alone when given, and sends only "send" bytes of its body before it stalls past the client's
    timeout or closes the connection ("then"). The statement is the served bytes' length and sha256."""

    TIMEOUT = 0.5       # the client's stall limit here, as 60 s is on a hive
    STALL = 1.5         # how long a stalling step stays silent, past TIMEOUT
    WAITS = (0, 0, 0)   # no waiting between retries here; three retries without progress after the first such try

    def setUp(self):
        spec = importlib.util.spec_from_file_location("mac_update", MACOS / "update.py")
        self.update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.update)
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="mac-download-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.dest = self.tmp / "release.zip"
        self.data = os.urandom(300_000)
        self.asked, self.plan = [], [{}]        # each request's Range header (None when it sent none); the steps
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                rng = self.headers.get("Range")
                test.asked.append(rng)
                step = test.plan[min(len(test.asked), len(test.plan)) - 1]
                if "status" in step:
                    self.send_error(step["status"])
                    return
                partial = "start" in step or (rng is not None and step.get("range", True))
                start = step.get("start", int(rng.partition("=")[2].rstrip("-")) if rng else 0) if partial else 0
                body = test.data[start:]
                self.send_response(206 if partial else 200)
                if partial:
                    self.send_header("Content-Range", f"bytes {start}-{len(test.data) - 1}/{len(test.data)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body[:step.get("send", len(body))])
                    self.wfile.flush()
                    if "send" in step:
                        if step.get("then") == "stall":
                            time.sleep(test.STALL)
                        self.close_connection = True
                        self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass                            # the client gave up on this answer first

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)             # cleanups run last first
        self.st = {"url": f"http://127.0.0.1:{httpd.server_address[1]}/release.zip", "zip_length": len(self.data),
                   "zip_sha256": hashlib.sha256(self.data).hexdigest()}

    def download(self):
        return self.update.download(self.st, self.dest, timeout=self.TIMEOUT, waits=self.WAITS)

    def test_a_stall_mid_body_resumes_from_the_byte_reached(self):
        self.plan = [{"send": 100_000, "then": "stall"}, {}]
        self.assertEqual(self.download(), self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(self.asked, [None, "bytes=100000-"])

    def test_a_dropped_connection_resumes_from_the_byte_reached(self):
        self.plan = [{"send": 120_000, "then": "close"}, {}]
        self.assertEqual(self.download(), self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(self.asked, [None, "bytes=120000-"])

    def test_a_server_ignoring_range_has_the_download_start_over(self):
        self.plan = [{"send": 150_000, "then": "close"}, {"range": False}]
        self.assertEqual(self.download(), self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(self.asked, [None, "bytes=150000-"])

    def test_a_206_from_another_byte_is_dropped_and_the_whole_zip_asked_for(self):
        self.plan = [{"send": 90_000, "then": "close"}, {"start": 50_000, "send": 0, "then": "close"}, {}]
        self.assertEqual(self.download(), self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(self.asked, [None, "bytes=90000-", None])

    def test_progress_resets_the_count_so_many_stalls_still_finish(self):
        # four drops, more than WAITS allows in a row, each after a further 60,000 bytes
        self.plan = [{"send": 60_000, "then": "close"}] * 4 + [{}]
        self.assertEqual(self.download(), self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(self.asked, [None, "bytes=60000-", "bytes=120000-", "bytes=180000-", "bytes=240000-"])

    def test_a_server_that_never_sends_more_ends_after_the_tries_without_progress(self):
        self.plan = [{"send": 80_000, "then": "close"}, {"send": 0, "then": "close"}]
        with self.assertRaises(self.update.UpdateError) as caught:
            self.download()
        self.assertIn(f"stopped at 0.1 of 0.3 MB after {len(self.WAITS) + 1} tries in a row got no further",
                      str(caught.exception))
        self.assertEqual(self.asked, [None] + ["bytes=80000-"] * (len(self.WAITS) + 1))
        self.assertFalse(self.dest.exists())

    def test_a_url_that_needs_a_sign_in_goes_to_the_browser(self):
        self.plan = [{"status": 404}]
        self.assertIsNone(self.download())
        self.assertEqual(self.asked, [None])
        self.assertFalse(self.dest.exists())

    def test_bytes_that_are_not_the_statements_are_refused(self):
        self.st["zip_sha256"] = hashlib.sha256(b"another zip").hexdigest()
        with self.assertRaises(self.update.UpdateError) as caught:
            self.download()
        self.assertIn("length or sha256 differs", str(caught.exception))
        self.assertFalse(self.dest.exists())


if __name__ == "__main__":
    unittest.main()
