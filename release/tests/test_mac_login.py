#!/usr/bin/env python3
"""Purpose: check what install/macos/omegahive.sh does around a Mac login, on any OS: register writes the Omega Hive
app (its brand icon, its hive's label as bundle identifier, its script opening what link prints) and the login item
(left as it is when unchanged); the login item starts the hive and its update job; a hive its owner stopped stays
stopped at login until a start or an open; autostart off removes the item, a refresh keeps it off, and on brings it
back; two folders get their own app and item; uninstall removes both and deletes the folder only when its path is
typed; link prints the sign-in link alone, or, when the owner takes an update, hands it to Terminal and prints
nothing; open with no browser and no terminal still finishes, as an install run that way must; and an app whose hive
folder is gone says so. launchctl, osacompile, codesign, sips, iconutil, open and uname are stand-ins on PATH, and the
hive is a stand-in answering its control socket, so the script's own shell code is what runs.

Keep TMPDIR short: the stand-in hive's socket is $OMEGAHIVE_HOME/data/run/control.sock, and a socket path holds at
most 104 bytes on macOS and 108 on Linux.
    python3 -m unittest tests/test_mac_login.py
"""
import json
import os
import pathlib
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "install" / "macos" / "omegahive.sh"
ICON = ROOT / "hive" / "ui" / "public" / "brand" / "favicon-512.png"

# launchd as omegahive.sh uses it, played back in $STAND_IN/launchd.json under a lock: bootstrap loads a plist (the
# hive job starts the stand-in hive; a RunAtLoad job runs its program, here once and to its end), bootout unloads and
# ends the hive, print answers whether a label is loaded, enable and disable keep launchd's disabled list.
LAUNCHCTL = r'''import fcntl, json, os, pathlib, plistlib, signal, subprocess, sys
stand_in = pathlib.Path(os.environ["STAND_IN"])
args = sys.argv[1:]
with open(stand_in / "launchctl.log", "a") as log:
    log.write(json.dumps(args) + "\n")
lock = open(stand_in / "launchd.lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
path = stand_in / "launchd.json"
state = json.loads(path.read_text()) if path.exists() else {"loaded": {}, "disabled": []}
label = args[1].split("/", 2)[2] if args[0] in ("bootout", "print", "enable", "disable") else None
run_after = None
if args[0] == "bootstrap":
    plist = plistlib.loads(pathlib.Path(args[2]).read_bytes())
    if plist["Label"] in state["disabled"] or plist["Label"] in state["loaded"]:
        sys.exit(5)
    entry = {"plist": args[2], "pid": None}
    if plist["ProgramArguments"][-1] == "run":
        sock = plist["EnvironmentVariables"]["OMEGAHIVE_HOME"] + "/data/run/control.sock"
        entry["pid"] = subprocess.Popen([sys.executable, str(stand_in / "hive.py"), sock], start_new_session=True,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid
    elif plist.get("RunAtLoad"):
        run_after = plist
    state["loaded"][plist["Label"]] = entry
elif args[0] == "bootout":
    entry = state["loaded"].pop(label, None)
    if entry is None:
        sys.exit(3)
    if entry["pid"]:
        try:
            os.kill(entry["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
elif args[0] == "print":
    sys.exit(0 if label in state["loaded"] else 113)
elif args[0] in ("enable", "disable"):
    state["disabled"] = sorted(({label} | set(state["disabled"])) - ({label} if args[0] == "enable" else set()))
else:
    sys.exit(f"the stand-in launchctl does not know {args}")
path.write_text(json.dumps(state))
lock.close()
if run_after:
    with open(run_after.get("StandardOutPath", os.devnull), "a") as out:
        subprocess.run(run_after["ProgramArguments"], stdout=out, stderr=out)
'''
# The hive's control socket, as hive/core/localowner.py answers hello and signin.
HIVE = r'''import json, os, signal, socket, sys
path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
if os.path.exists(path):
    os.unlink(path)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
listener.listen(8)
def end(*_):
    listener.close()
    os.unlink(path)
    sys.exit(0)
signal.signal(signal.SIGTERM, end)
while True:
    conn, _ = listener.accept()
    with conn:
        op = json.loads(conn.makefile().readline())["op"]
        answer = {"hello": {"ok": True, "port": 8700, "pid": os.getpid()},
                  "signin": {"ok": True, "url": "http://127.0.0.1:8700/signin#once"}}.get(op, {"ok": False})
        conn.sendall((json.dumps(answer) + "\n").encode())
'''
# hive.core.newhive_helper's control(), the client omegahive.sh's control() imports, on the standard library alone.
CONTROL = '''import json, socket
def control(path, request, timeout=5):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(path))
        sock.sendall((json.dumps(request) + "\\n").encode())
        return json.loads(sock.makefile().readline() or "null")
'''
# osacompile -o APP SOURCE, as macOS's makes an applet: its executable, icon, asset catalog, compiled script (here the
# source itself) and Info.plist.
OSACOMPILE = r'''import pathlib, plistlib, sys
app, source = pathlib.Path(sys.argv[sys.argv.index("-o") + 1]), pathlib.Path(sys.argv[-1])
(app / "Contents" / "MacOS").mkdir(parents=True)
(app / "Contents" / "Resources" / "Scripts").mkdir(parents=True)
(app / "Contents" / "MacOS" / "applet").write_text("applet")
(app / "Contents" / "Resources" / "applet.icns").write_text("AppleScript's icon")
(app / "Contents" / "Resources" / "Assets.car").write_text("AppleScript's asset catalog")
(app / "Contents" / "Resources" / "Scripts" / "main.scpt").write_text(source.read_text())
name = app.name[:-len(".app")]
(app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
    "CFBundleExecutable": "applet", "CFBundleIconFile": "applet", "CFBundleIconName": "applet",
    "CFBundleName": name, "CFBundleIdentifier": "com.apple.ScriptEditor.id." + name.replace(" ", "-")}))
'''
SIPS = 'import shutil, sys\nshutil.copy(sys.argv[sys.argv.index("-z") + 3], sys.argv[sys.argv.index("--out") + 1])\n'
ICONUTIL = ('import os, sys\nfolder, out = sys.argv[sys.argv.index("icns") + 1], sys.argv[sys.argv.index("-o") + 1]\n'
            'open(out, "w").write("icns " + ",".join(sorted(os.listdir(folder))))\n')
LOGS = ('import json, os, sys\n'
        'open(os.path.join(os.environ["STAND_IN"], "{name}.log"), "a").write(json.dumps(sys.argv[1:]) + "\\n")\n')


class MacLoginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="ml-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(self.end_hives)
        self.stand_in = self.tmp / "s"
        self.bin = self.stand_in / "bin"
        self.bin.mkdir(parents=True)
        for name, body in (("launchctl", LAUNCHCTL), ("osacompile", OSACOMPILE), ("sips", SIPS),
                           ("iconutil", ICONUTIL), ("codesign", LOGS.format(name="codesign")),
                           ("open", LOGS.format(name="open"))):
            self.tool(name, f"#!{sys.executable}\n{body}")
        self.tool("uname", "#!/bin/sh\necho Darwin\n")
        (self.stand_in / "hive.py").write_text(HIVE)
        # A space in the home folder, as in the app's own name, checks the quoting of every path.
        self.home = self.tmp / "h 1"
        self.oh = self.install(self.home / "OmegaHive")
        sock = str(self.oh / "data" / "run" / "control.sock")
        self.assertLessEqual(len(sock.encode()), 103, f"{sock} is too long for a socket path: use a shorter TMPDIR")

    def tool(self, name, text):
        (self.bin / name).write_text(text)
        (self.bin / name).chmod(0o755)

    def install(self, oh):
        """A finished install as omegahive.sh reads one: installed, hive.env, the venv's and the toolchain's Python,
        and app/ holding this omegahive.sh, update.py, the brand icon and the stand-in control client."""
        (oh / "logs").mkdir(parents=True)
        (oh / "installed").write_text("release=test\n")
        (oh / "hive.env").write_text("HIVE_PORT=8700\nHIVE_OWNER_SETTING=kept\n")
        (oh / "venv" / "bin").mkdir(parents=True)
        (oh / "venv" / "bin" / "python").symlink_to(sys.executable)
        toolchain = oh / "toolchain" / "envs" / "hive" / "bin"
        toolchain.mkdir(parents=True)
        # update.py check as open runs it: its arguments kept, its exit status the test's choice (10, an update taken).
        (toolchain / "python3.12").write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$STAND_IN/update-args"\n'
                                              'exit "$(cat "$STAND_IN/update-exit" 2>/dev/null || echo 0)"\n')
        (toolchain / "python3.12").chmod(0o755)
        macos = oh / "app" / "install" / "macos"
        macos.mkdir(parents=True)
        shutil.copy(SCRIPT, macos / "omegahive.sh")
        shutil.copy(SCRIPT.parent / "update.py", macos / "update.py")
        core = oh / "app" / "hive" / "core"
        core.mkdir(parents=True)
        (oh / "app" / "hive" / "__init__.py").write_text("")
        (core / "__init__.py").write_text("")
        (core / "newhive_helper.py").write_text(CONTROL)
        (oh / "app" / "hive" / "ui" / "public" / "brand").mkdir(parents=True)
        shutil.copy(ICON, oh / "app" / "hive" / "ui" / "public" / "brand" / "favicon-512.png")
        return oh

    def env(self, oh=None):
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:/usr/bin:/bin", "STAND_IN": str(self.stand_in),
               "LANG": "C"}
        if oh is not None:
            env["OMEGAHIVE_HOME"] = str(oh)
        return env

    def run_script(self, *args, oh=None, answer=""):
        """omegahive.sh in a session of its own, so it has no terminal, as from the app or launchd."""
        return subprocess.run(["/bin/bash", str((oh or self.oh) / "app" / "install" / "macos" / "omegahive.sh"), *args],
                              env=self.env(oh), input=answer, capture_output=True, text=True, start_new_session=True)

    def ok(self, *args, **kw):
        done = self.run_script(*args, **kw)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done.stdout

    def label(self, oh=None):
        crc = subprocess.run(["cksum"], input=str(oh or self.oh), capture_output=True, text=True, check=True)
        return "org.omegahive.hive." + crc.stdout.split()[0]

    def login_plist(self, oh=None):
        return self.home / "Library" / "LaunchAgents" / f"{self.label(oh)}.login.plist"

    def launchd(self):
        path = self.stand_in / "launchd.json"
        return json.loads(path.read_text()) if path.exists() else {"loaded": {}, "disabled": []}

    def log_in(self, oh=None):
        """What launchd does with the login item at a login: bootstrap it, which runs its program once."""
        subprocess.run([str(self.bin / "launchctl"), "bootstrap", f"gui/{os.getuid()}", str(self.login_plist(oh))],
                       env=self.env(), check=True)

    def restart(self):
        """A logout or restart: launchd ends every job of the session, with no stop of the hive's own."""
        for label in list(self.launchd()["loaded"]):
            subprocess.run([str(self.bin / "launchctl"), "bootout", f"gui/{os.getuid()}/{label}"], env=self.env())

    def end_hives(self):
        for entry in self.launchd()["loaded"].values():
            if entry["pid"]:
                try:
                    os.kill(entry["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def login_log(self):
        return (self.oh / "logs" / "login.log").read_text()

    # --- the app and the login item ---------------------------------------------------------------------------------

    def test_register_writes_the_app_and_the_login_item_its_owner_finds(self):
        said = self.ok("register")
        app = self.home / "Applications" / "Omega Hive.app"
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], self.label())
        self.assertEqual(info["CFBundleName"], "Omega Hive")
        self.assertNotIn("CFBundleIconName", info)     # applet.icns, the brand icon, is the app's icon
        self.assertFalse((app / "Contents" / "Resources" / "Assets.car").exists())
        sizes = (app / "Contents" / "Resources" / "applet.icns").read_text()
        self.assertEqual(sizes.count("icon_"), 10, sizes)
        script = (app / "Contents" / "Resources" / "Scripts" / "main.scpt").read_text()
        self.assertIn('set signinLink to do shell script quoted form of (POSIX path of (path to resource "omegahive")) '
                      '& " link"', script)
        self.assertIn("open location signinLink", script)
        self.assertIn("display alert", script)
        signed = [json.loads(line) for line in (self.stand_in / "codesign.log").read_text().splitlines()]
        self.assertEqual([args[:3] for args in signed], [["--force", "--sign", "-"]])
        self.assertTrue(signed[0][3].endswith("/Omega Hive.app"))
        # The app's program runs this folder's omegahive.sh, its path quoted for the shell.
        program = app / "Contents" / "Resources" / "omegahive"
        self.assertTrue(os.access(program, os.X_OK))
        status = subprocess.run([str(program), "status"], env=self.env(), capture_output=True, text=True)
        self.assertEqual(status.stdout, "not running\n", status.stderr)
        item = plistlib.loads(self.login_plist().read_bytes())
        self.assertEqual(item, {"Label": self.label() + ".login", "ProgramArguments": [str(program), "login"],
                                "RunAtLoad": True, "Umask": 0o077, "StandardOutPath": f"{self.oh}/logs/login.log",
                                "StandardErrorPath": f"{self.oh}/logs/login.log"})
        self.assertIn("Omega Hive is in your Applications folder", said)
        self.assertIn("starts your hive when you log in", said)

    def test_a_login_item_that_holds_what_register_writes_is_left_as_it_is(self):
        self.ok("register")
        before = self.login_plist().stat()
        self.ok("register")
        after = self.login_plist().stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))

    def test_two_folders_get_their_own_app_and_login_item(self):
        self.ok("register")
        other = self.install(self.home / "Test hives" / "OmegaHive")
        self.ok("register", oh=other)
        apps = sorted(p.name for p in (self.home / "Applications").iterdir())
        self.assertEqual(apps, ["Omega Hive (OmegaHive " + self.label(other).rsplit(".", 1)[1] + ").app",
                                "Omega Hive.app"])
        self.assertNotEqual(self.label(), self.label(other))
        self.assertTrue(self.login_plist().exists() and self.login_plist(other).exists())

    def test_an_app_whose_hive_folder_is_gone_says_so(self):
        self.ok("register")
        shutil.rmtree(self.oh / "app")
        program = self.home / "Applications" / "Omega Hive.app" / "Contents" / "Resources" / "omegahive"
        done = subprocess.run([str(program), "link"], env=self.env(), capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn(f"No hive is installed in {self.oh} any more", done.stderr)

    # --- logging in -------------------------------------------------------------------------------------------------

    def test_the_login_item_starts_the_hive_and_its_update_job(self):
        self.ok("register")
        self.log_in()
        loaded = self.launchd()["loaded"]
        self.assertIn(self.label(), loaded)
        self.assertIn(self.label() + ".update", loaded)
        self.assertIn("login: starting the hive", self.login_log())
        self.assertTrue(self.ok("status").startswith("running on http://127.0.0.1:8700"))

    def test_a_hive_its_owner_stopped_stays_stopped_at_login_until_it_is_opened(self):
        self.ok("register")
        self.log_in()
        self.assertIn("stays stopped when you log in", self.ok("stop"))
        self.assertTrue((self.oh / "run" / "stopped").exists())
        self.restart()
        self.log_in()
        self.assertNotIn(self.label(), self.launchd()["loaded"])
        self.assertIn("login: not started, since its owner stopped it at", self.login_log())
        self.assertIn("Your hive is open in your browser", self.ok("open"))
        self.assertFalse((self.oh / "run" / "stopped").exists())
        self.assertEqual(json.loads((self.stand_in / "open.log").read_text()), ["http://127.0.0.1:8700/signin#once"])
        # Opened, the hive starts at the next login again.
        self.restart()
        self.log_in()
        self.assertIn(self.label(), self.launchd()["loaded"])

    # --- the switch ---------------------------------------------------------------------------------------------------

    def test_autostart_off_removes_the_item_a_refresh_keeps_it_off_and_on_brings_it_back(self):
        self.ok("register")
        self.assertEqual(self.ok("autostart", "status"), "on\n")
        self.assertIn("no longer starts when you log in", self.ok("autostart", "off"))
        self.assertFalse(self.login_plist().exists())
        self.assertEqual((self.oh / "hive.env").read_text(),
                         "HIVE_PORT=8700\nHIVE_OWNER_SETTING=kept\nHIVE_START_AT_LOGIN=off\n")
        self.assertEqual(self.ok("autostart", "status"), "off\n")
        # A refresh runs register again: the app comes back up to date, the item stays away.
        self.assertIn("does not start when you log in", self.ok("register"))
        self.assertTrue((self.home / "Applications" / "Omega Hive.app").exists())
        self.assertFalse(self.login_plist().exists())
        # A login item left over from before still starts nothing.
        self.assertIn("login: starting at login is off", self.ok("login"))
        self.assertNotIn(self.label(), self.launchd()["loaded"])
        subprocess.run([str(self.bin / "launchctl"), "disable", f"gui/{os.getuid()}/{self.label()}.login"],
                       env=self.env(), check=True)
        self.ok("autostart", "on")
        self.assertTrue(self.login_plist().exists())
        self.assertEqual((self.oh / "hive.env").read_text(), "HIVE_PORT=8700\nHIVE_OWNER_SETTING=kept\n")
        self.assertEqual(self.launchd()["disabled"], [])
        self.log_in()
        self.assertIn(self.label(), self.launchd()["loaded"])

    # --- uninstall ----------------------------------------------------------------------------------------------------

    def test_uninstall_removes_the_app_and_the_item_and_deletes_the_folder_only_on_its_typed_path(self):
        self.ok("register")
        self.log_in()
        kept = self.ok("uninstall", answer="\n")
        self.assertIn(f"Kept {self.oh}.", kept)
        self.assertEqual(self.launchd()["loaded"], {})
        self.assertFalse((self.home / "Applications" / "Omega Hive.app").exists())
        self.assertFalse(self.login_plist().exists())
        self.assertTrue((self.oh / "installed").exists())
        self.assertIn(f"Kept {self.oh}.", self.ok("uninstall", answer="OmegaHive\n"))   # not its path
        self.assertIn(f"Deleted {self.oh}.", self.ok("uninstall", answer=f"{self.oh}/\n"))
        self.assertFalse(self.oh.exists())

    def test_uninstall_where_no_hive_is_installed_says_so_and_removes_only_what_a_deleted_folder_left(self):
        script = str(self.oh / "app" / "install" / "macos" / "omegahive.sh")

        def uninstall(oh):
            return subprocess.run(["/bin/bash", script, "uninstall"], env=self.env(oh), input="", capture_output=True,
                                  text=True, start_new_session=True)
        self.ok("register")
        nowhere = self.home / "No hive here"
        refused = uninstall(nowhere)
        self.assertEqual(refused.returncode, 1)
        self.assertIn(f"No hive is installed in {nowhere}", refused.stdout + refused.stderr)
        self.assertNotIn("stopped", refused.stdout + refused.stderr)
        self.assertTrue(self.login_plist().exists() and (self.home / "Applications" / "Omega Hive.app").exists())
        other = self.install(self.home / "Test hives" / "OmegaHive")
        self.ok("register", oh=other)
        app = next(p for p in (self.home / "Applications").iterdir() if p.name != "Omega Hive.app")
        shutil.rmtree(other)                                        # its owner deleted the folder by hand
        left = uninstall(other)
        self.assertEqual(left.returncode, 0, left.stdout + left.stderr)
        self.assertIn(f"No hive is installed in {other}. The login item and {app} it left are removed.", left.stdout)
        self.assertFalse(self.login_plist(other).exists() or app.exists())
        self.assertTrue(self.login_plist().exists() and (self.home / "Applications" / "Omega Hive.app").exists())

    # --- the app's link, and open with no terminal ------------------------------------------------------------------

    def test_link_prints_the_sign_in_link_alone_for_the_app_to_open(self):
        self.assertEqual(self.ok("link"), "http://127.0.0.1:8700/signin#once\n")
        self.assertIn(self.label(), self.launchd()["loaded"])
        self.assertFalse((self.stand_in / "open.log").exists())     # the app opens it, not the script

    def test_link_hands_an_update_its_owner_takes_to_terminal_and_starts_no_old_hive(self):
        (self.stand_in / "update-exit").write_text("10")
        self.assertEqual(self.ok("link"), "")
        args = (self.stand_in / "update-args").read_text().splitlines()
        self.assertEqual(args, ["-I", f"{self.oh}/app/install/macos/update.py", "check", "--home", str(self.oh),
                                "--terminal"])
        self.assertNotIn(self.label(), self.launchd()["loaded"])

    def test_open_with_no_browser_and_no_terminal_still_finishes(self):
        # The installer's last step runs open, and an install over SSH has neither.
        self.tool("open", "#!/bin/sh\nexit 1\n")
        self.assertIn("Your browser did not open. Open Omega Hive to get a new sign-in link.", self.ok("open"))
        args = (self.stand_in / "update-args").read_text().splitlines()
        self.assertEqual(args[-2:], ["--home", str(self.oh)])      # no --terminal: a taken update runs where open does


if __name__ == "__main__":
    unittest.main()
