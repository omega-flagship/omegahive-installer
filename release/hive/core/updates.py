# Purpose: what is waiting to load into the hive, which release or build it runs, who asked for an update, what must
# not be interrupted, and applying updates.
"""Updates (R18): what is waiting to load, who asked, what must not be interrupted, and applying it.

- Apps: the loaded code is compared with its folder on disk (manifest version and a digest of its sources), so a
  changed app shows "update available" whether or not anyone asked.
- Platform: the build this process started from is compared with the source a restart would run.
  A hive installed from a release (~/OmegaHive/app) is no git checkout: it names the release it started from by the
  RELEASE_COMMIT and RELEASE_VERSION its release builder wrote beside hive/, and its installer brings newer releases.
  On a Mac install the launcher names the updater's state file in HIVE_UPDATE_STATE (install/macos/update.py keeps
  there the newest signed release it took, when it checked and why an accepted update failed), so the page can offer
  that release; applying the platform update then runs the updater, which installs it and opens the hive again.
  A run that ends without handing the release on (status not 0) marks its history row failed with why. Check now runs
  the updater's own check at once, instead of waiting for its hourly job, and answers with what it found: the release
  on offer, up to date, or why it could not check; a second press while it runs gets that run's answer.
- Requests: an app's owner can post a note with an update (what changed, receipts); it sits beside the detection.
- Holds: an owner running something that must not be interrupted posts a hold (scope: restart, or one app). Applying
  under a hold is refused; an admin person may override with an explicit, recorded confirmation; a mind never can.
- Applying: an app reloads alone, in place. A platform update restarts the hive: the process exits cleanly and its
  supervisor (launchd KeepAlive) starts it again on the new build; only when the hive knows it is supervised.
- Who: admins from the Updates page; any mind an admin has explicitly allowed `hive-update-apply` (an exact rule,
  never a default or a glob). Every apply is recorded with before/after and any error.
"""

from __future__ import annotations

import asyncio
import datetime
import fcntl
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
from concurrent.futures import Future
from subprocess import Popen, TimeoutExpired, run as run_updater    # Update now's run, Check now's (tests stand in)
from threading import Lock, Thread

from .db import new_id, now, parse_stamp

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS update_requests (id TEXT PRIMARY KEY, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  receipts TEXT NOT NULL DEFAULT '[]', requested_by TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  closed_at TEXT, closed_by TEXT)""",
    """CREATE TABLE IF NOT EXISTS update_holds (id TEXT PRIMARY KEY, scope TEXT NOT NULL, reason TEXT NOT NULL, held_by TEXT NOT NULL,
  created_at TEXT NOT NULL, until TEXT, released_at TEXT, released_by TEXT)""",
    """CREATE TABLE IF NOT EXISTS update_history (id TEXT PRIMARY KEY, target TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT, overrode TEXT NOT NULL DEFAULT '[]')""",
]
ROOT = pathlib.Path(__file__).resolve().parents[2]
UPDATE_STATE_ENV = "HIVE_UPDATE_STATE"
VERSION = re.compile(r"[0-9]{1,9}(\.[0-9]{1,9}){0,3}")     # a release number as the Mac updater reads one
# Check now's run of the updater: its one wait is reading the feed, which gives up after 10 seconds (update.py
# check's fetch_bytes), so a run still going after CHECK_WAIT seconds is stuck; it is stopped, and the next press checks.
CHECK_WAIT = 60
BUSY = 3                    # update.py check --page: another run holds run/update.lock, so nothing was checked


def _git(*args):
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _release():
    """The release this code folder was laid out from, {"version", "commit"}: the RELEASE_COMMIT and RELEASE_VERSION a
    release builder writes beside hive/ (version None in a build without a release number). None for a git checkout,
    which has neither and names its build by HEAD."""
    def first_word(name):
        try:
            return ((ROOT / name).read_text().split() or [None])[0]
        except OSError:
            return None
    commit = first_word("RELEASE_COMMIT")
    return {"version": first_word("RELEASE_VERSION"), "commit": commit} if commit else None


def _version_key(text):
    """0.10 above 0.9 above 0.8.1, the dotted numbers compared one by one as the updater compares them; None when
    text is no release number."""
    return tuple(int(part) for part in text.split(".")) if isinstance(text, str) and VERSION.fullmatch(text) else None


def _text(value, cap=600):
    return value[:cap] if isinstance(value, str) else ""


def _ended(code):
    """How a run ended, as the page says it: "the updater was stopped by SIGABRT", "the updater ended with status 1"."""
    if code >= 0:
        return f"the updater ended with status {code}"
    try:
        return f"the updater was stopped by {signal.Signals(-code).name}"
    except ValueError:
        return f"the updater was stopped by signal {-code}"


class Updates:
    def __init__(self, hive):
        self.hive = hive
        for s in SCHEMA:
            hive.db.execute(s)
        self.running_build = _git("rev-parse", "HEAD") or None
        self.running_release = _release()   # read at start, like running_build: the release this process runs
        self.started_at = now()
        self.supervised = os.environ.get("HIVE_SUPERVISED") == "1"
        state = os.environ.get(UPDATE_STATE_ENV)
        self.installer_state = pathlib.Path(state) if state else None
        self._installer_job = None          # the updater an Update now started, while this process knows of it
        self._check = None                  # Check now's run of the updater: its answer, once it has one (Future)
        self._check_lock = Lock()           # one run at a time: a press either starts it or waits on it
        self._close_satisfied()

    def _close_satisfied(self):
        """A restart loads every app from disk: close app requests whose code is now the code running (Truth's up_12de063a)."""
        try:
            disk = self.hive.programs.scan()
        except Exception:
            return
        for r in self.hive.db.all("SELECT * FROM update_requests WHERE status = 'pending' AND target LIKE 'program:%'"):
            pid = r["target"][8:]
            loaded = self.hive.programs.programs.get(pid)
            if loaded and pid in disk and loaded.get("digest") == disk[pid]["digest"] and not loaded.get("error"):
                self.hive.db.execute("UPDATE update_requests SET status = 'applied', closed_at = ?, closed_by = ? WHERE id = ?",
                                     (now(), "hive:restart", r["id"]))

    # ---- what is waiting -------------------------------------------------------------------------------

    def platform(self):
        head = _git("rev-parse", "HEAD") or None
        waiting = []
        if head and self.running_build and head != self.running_build:
            lines = _git("log", "--oneline", "--no-decorate", "-n", "50", f"{self.running_build}..{head}").splitlines()
            waiting = [{"commit": l.split(" ", 1)[0], "subject": l.split(" ", 1)[1] if " " in l else ""} for l in lines]
        return {"target": "platform", "running_build": self.running_build, "running_release": self.running_release,
                "source_build": head, "started_at": self.started_at, "update_available": bool(waiting),
                "commits_waiting": waiting, "supervised": self.supervised, "request": self._open_request("platform"),
                "installer": self.installer()}

    def installer(self):
        """What the Mac updater knows, read from the state file the launcher names in HIVE_UPDATE_STATE: the newest
        signed release it took, offered while it is above the running release (its signed label and notes when the
        updater kept them), when it last took one, why its later checks could not check (the time, the plain reason the
        page says and the log's detail, until a check takes a statement, so an old answer is never shown as current),
        a Not now still waiting out its day, why an accepted update of that release failed, whether a Check now is
        running, and whether the updater is otherwise checking or installing now. None when the launcher named no
        updater: a git checkout, or an install whose launcher has none."""
        if self.installer_state is None:
            return None
        try:
            state = json.loads(self.installer_state.read_text())
        except (OSError, ValueError):
            state = {}
        state = state if isinstance(state, dict) else {}
        newest = state.get("seen") if _version_key(state.get("seen")) else None
        # A release without a number is older than any numbered one, as the updater counts it ("0").
        have = _version_key((self.running_release or {}).get("version")) or (0,)
        offer = None
        if newest and _version_key(newest) > have:
            took = state.get("offer") if isinstance(state.get("offer"), dict) else {}
            took = took if took.get("version") == newest else {}
            offer = {"version": newest, "label": _text(took.get("label")) or f"v{newest}", "notes": _text(took.get("notes"))}
        deferred = state.get("deferred") if isinstance(state.get("deferred"), dict) else {}
        until = deferred.get("until")
        failed = state.get("failed") if isinstance(state.get("failed"), dict) else {}
        # Why the last try to install the release on offer did not finish: the updater's own record, or this hive's
        # history of an Update now run that ended without one (an updater that crashed wrote nothing), the later.
        tries = [t for t in ({"version": failed.get("version"), "error": _text(failed.get("error"), 500),
                              "at": _text(failed.get("at"), 40) or None}, self._failed_run()) if t]
        tries = [t for t in tries if offer and t["version"] == newest]
        last = max(tries, key=lambda t: parse_stamp(t["at"]) or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc),
                   default=None)
        check_failed = state.get("check_failed") if isinstance(state.get("check_failed"), dict) else {}
        return {"newest": newest, "offer": offer,
                "checked_at": _text(state.get("checked"), 40) or None,
                "check_failed": ({"reason": _text(check_failed.get("reason"), 200),
                                  "detail": _text(check_failed.get("detail"), 500),
                                  "at": _text(check_failed.get("at"), 40) or None}
                                 if _text(check_failed.get("reason")) else None),
                "checking": self._checking(),
                "deferred_until": (datetime.datetime.fromtimestamp(until, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                                   if offer and deferred.get("version") == newest and isinstance(until, int) else None),
                "failed": last,
                "updating": self._updating()}

    def _failed_run(self):
        """The newest platform apply, when it was an Update now run that failed: {version, error, at}, else None."""
        row = self.hive.db.one("SELECT * FROM update_history WHERE target = 'platform' ORDER BY at DESC LIMIT 1")
        if not row or row["ok"]:
            return None
        after = json.loads(row["after"])
        if not (isinstance(after, dict) and after.get("installer") is True):
            return None
        return {"version": after.get("release"), "error": _text(row["error"], 500), "at": row["at"]}

    def _updating(self):
        """Whether the updater is checking or installing now: the run an Update now started has not ended, or another
        run (its hourly job, or the launcher's check before a start) holds its lock, run/update.lock. Check now's own
        run holds that lock too, and is named apart (checking). Asking takes a shared lock for an instant, so an hourly
        check starting in that instant skips to the next hour."""
        job = self._installer_job
        if job is not None and job.poll() is None:
            return True
        if self._checking():
            return False                    # the lock is Check now's own run, which the view names apart
        lock = self.installer_state.parent / "update.lock"
        if not lock.exists():
            return False
        try:
            with open(lock, "a") as f:
                fcntl.flock(f, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.flock(f, fcntl.LOCK_UN)
        except BlockingIOError:
            return True
        except OSError:
            return False
        return False

    def apps(self):
        disk = self.hive.programs.scan()
        out = []
        for pid in sorted(set(disk) | set(self.hive.programs.programs)):
            loaded = self.hive.programs.programs.get(pid)
            on_disk = disk.get(pid)
            out.append({"target": f"program:{pid}", "id": pid, "name": (loaded or {}).get("name", pid),
                        "loaded_version": (loaded or {}).get("version"), "loaded_digest": (loaded or {}).get("digest"),
                        "disk_version": (on_disk or {}).get("version"), "disk_digest": (on_disk or {}).get("digest"),
                        "load_error": (loaded or {}).get("error"),
                        "update_available": bool(on_disk) and (not loaded or loaded.get("digest") != on_disk["digest"]
                                                               or loaded.get("version") != on_disk["version"]),
                        "removed_on_disk": bool(loaded) and not on_disk,
                        "request": self._open_request(f"program:{pid}")})
        return out

    def overview(self):
        return {"platform": self.platform(), "apps": self.apps(), "holds": self.holds(),
                "history": self.history(20)}

    # ---- requests from owners ----------------------------------------------------------------------------

    def _target(self, target):
        target = str(target or "")
        if target == "platform":
            return target
        if target.startswith("program:") and target[8:] in (set(self.hive.programs.scan()) | set(self.hive.programs.programs)):
            return target
        raise self.hive.error(400, "bad_target", "target is 'platform' or 'program:<app id>' of an app this hive has")

    def _open_request(self, target):
        row = self.hive.db.one("SELECT * FROM update_requests WHERE target = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", (target,))
        return self._req_view(row) if row else None

    @staticmethod
    def _req_view(r):
        return {**r, "receipts": json.loads(r["receipts"])}

    def request(self, by, data):
        target = self._target(data.get("target"))
        note = str(data.get("note") or "").strip()[:2000]
        receipts = [str(x)[:300] for x in (data.get("receipts") or [])][:20]
        row = {"id": new_id("up"), "target": target, "note": note, "receipts": json.dumps(receipts), "requested_by": by,
               "created_at": now(), "status": "pending", "closed_at": None, "closed_by": None}
        self.hive.db.insert("update_requests", row)
        self._event()
        return self._req_view(row)

    # ---- holds ------------------------------------------------------------------------------------------

    def holds(self, scope=None):
        rows = self.hive.db.all("SELECT * FROM update_holds WHERE released_at IS NULL AND (until IS NULL OR until > ?) ORDER BY created_at", (now(),))
        return [r for r in rows if scope is None or r["scope"] == scope or r["scope"] == "all"]

    def hold(self, by, data):
        scope = str(data.get("scope") or "restart")
        if scope not in ("restart", "all") and not scope.startswith("program:"):
            raise self.hive.error(400, "bad_scope", "scope is 'restart', 'all' or 'program:<app id>'")
        reason = str(data.get("reason") or "").strip()[:500]
        if not reason:
            raise self.hive.error(400, "bad_request", "say why this must not be interrupted")
        until = self._until(data.get("until"))
        row = {"id": new_id("hold"), "scope": scope, "reason": reason, "held_by": by, "created_at": now(), "until": until,
               "released_at": None, "released_by": None}
        self.hive.db.insert("update_holds", row)
        self._event()
        return row

    def _until(self, value):
        """A hold's end as an exact UTC time in the hive's own format, so the string comparisons that release it
        (here and in safe-restart) are time comparisons. Free text such as "tomorrow" used to be stored as given and
        never lapse (Surface, 2026-10-05)."""
        if value is None:
            return None
        import datetime
        try:
            at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_request", "until is an ISO 8601 time with a timezone, e.g. 2026-10-06T09:00:00Z")
        if at.tzinfo is None:
            raise self.hive.error(400, "bad_request", "until needs a timezone (Z or +hh:mm)")
        at = at.astimezone(datetime.timezone.utc)
        moment = datetime.datetime.now(datetime.timezone.utc)
        if not moment < at <= moment + datetime.timedelta(days=7):
            raise self.hive.error(400, "bad_request", "until is in the future and at most 7 days ahead")
        return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def release(self, by, hold_id, admin=False):
        row = self.hive.db.one("SELECT * FROM update_holds WHERE id = ?", (hold_id,))
        if row is None or row["released_at"]:
            raise self.hive.error(404, "not_found", "no such active hold")
        if row["held_by"] != by and not admin:
            raise self.hive.error(403, "forbidden", "only whoever placed a hold (or an admin) releases it")
        self.hive.db.execute("UPDATE update_holds SET released_at = ?, released_by = ? WHERE id = ?", (now(), by, hold_id))
        self._event()
        return {"id": hold_id, "released_by": by}

    # ---- applying ---------------------------------------------------------------------------------------

    def _blocking(self, target):
        scope = "restart" if target == "platform" else target
        return self.holds(scope)

    def apply(self, by, target, override=False, person_admin=False, confirm=None):
        """Apply one update. Under a hold: refused, unless an admin person overrides with confirm == the target."""
        target = self._target(target)
        blocking = self._blocking(target)
        overrode = []
        if blocking:
            if not (override and person_admin and confirm == target):
                raise self.hive.error(409, "held", "held: " + "; ".join(f"{h['held_by']}: {h['reason']}" for h in blocking)
                                      + ". Wait for the hold to be released" + (" (an admin person may override with confirm)" if person_admin else ""),
                                      {"holds": blocking})
            overrode = [h["id"] for h in blocking]
        if target == "platform":
            offer = (self.installer() or {}).get("offer")
            return self._install(by, overrode, offer) if offer else self._restart(by, overrode)
        pid = target[8:]
        before = self.hive.programs.programs.get(pid)
        before_v = {"version": (before or {}).get("version"), "digest": (before or {}).get("digest")}
        after = self.hive.programs.reload_one(pid)
        ok = not after.get("error")
        self._record(target, by, before_v, {"version": after["version"], "digest": after.get("digest")}, ok, after.get("error"), overrode)
        self.hive.db.execute("UPDATE update_requests SET status = 'applied', closed_at = ?, closed_by = ? WHERE target = ? AND status = 'pending'",
                             (now(), by, target))
        self.hive.events.publish("programs.updated", programs=self.hive.programs.list())
        self._event()
        return {"target": target, "ok": ok, "before": before_v, "after": {"version": after["version"], "digest": after.get("digest")},
                "error": after.get("error")}

    def _restart(self, by, overrode):
        if not self.supervised:
            raise self.hive.error(409, "not_supervised", "this hive is not running under a supervisor that would start it again; restart it from its host")
        head = _git("rev-parse", "HEAD") or None
        self._record("platform", by, {"build": self.running_build}, {"build": head, "pending_restart": True}, True, None, overrode)
        self.hive.db.execute("UPDATE update_requests SET status = 'applied', closed_at = ?, closed_by = ? WHERE target = 'platform' AND status = 'pending'",
                             (now(), by))
        self._event()
        try:   # exit after this response is sent; the supervisor starts the new build
            asyncio.get_running_loop().call_later(1.5, os.kill, os.getpid(), signal.SIGTERM)
        except RuntimeError:
            pass
        return {"target": "platform", "ok": True, "restarting": True, "from": self.running_build, "to": head}

    def _updater(self, instead):
        """The updater and the hive folder it updates, (update.py, <OmegaHive>), where the launcher said: update.py
        keeps <OmegaHive>/run/update-state.json, so the folder is the state file's grandparent. Refused (409
        no_updater) when they are not there, the refusal ending with what the person can do instead."""
        state = self.installer_state
        updater = ROOT / "install" / "macos" / "update.py"
        if state is None or state.name != "update-state.json" or state.parent.name != "run" or not updater.is_file():
            raise self.hive.error(409, "no_updater", f"this hive's updater is not where its launcher says; {instead}")
        return updater, state.parent.parent

    @staticmethod
    def _updater_env():
        """The updater's own environment, none of the hive's settings or keys."""
        return {k: v for k, v in os.environ.items()
                if k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "SHELL") or k.startswith("LC_")}

    def _checking(self):
        run = self._check
        return run is not None and not run.done()

    def check(self):
        """Check now (a tester in Lisbon, 16 November: back on wifi, the hive took its own sweet time to notice a new
        version): the updater's own hourly check, `update.py check --home <OmegaHive> --job --page`, at once. It
        keeps what it finds in its state file and asks nothing, since this page offers the release with its own
        Update now, so the answer is the page's: {"result": "offer" | "current" | "failed", "error", "installer"},
        the release on offer, up to date (installer.checked_at says when), or why it could not check. One run at a
        time: a press while one runs waits for that run and gets its answer, as Go's singleflight joins a duplicate
        call; a press while the updater runs on its own (its hourly job, an Update now) is refused, since what that
        run finds reaches this page anyway. Nothing is applied, so holds do not stop a check."""
        with self._check_lock:
            run = self._check
            starts = run is None or run.done()
            if starts:
                updater, home = self._updater("double-click Install Omega in a new release to update")
                if self._updating():
                    raise self.hive.error(409, "updating", "the updater is checking or installing now; "
                                                           "this page shows what it finds once it is done")
                run = self._check = Future()
        if starts:
            try:
                run.set_result(self._run_check(updater, home))
            except BaseException as err:     # every press waiting on this run gets the same answer
                run.set_exception(err)
            self._event()
        result, error = run.result()
        return {"result": result, "error": error, "installer": self.installer()}

    def _run_check(self, updater, home):
        """One run of the updater's check: ("offer" | "current", None) when it took the newest statement, else
        ("failed", why), why being the updater's own reason from its state, how the run ended, or the time bound.
        Time: one updater run, at most CHECK_WAIT seconds."""
        started = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        try:
            done = run_updater([sys.executable, "-I", str(updater), "check", "--home", str(home), "--job", "--page"],
                               cwd=str(home), env=self._updater_env(), stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=CHECK_WAIT)
        except TimeoutExpired:
            return "failed", f"the updater's check went on past {CHECK_WAIT} seconds and was stopped"
        except OSError as err:
            return "failed", _text(f"the updater could not start: {err}", 500)
        if done.returncode == BUSY:
            raise self.hive.error(409, "updating", "the updater is checking or installing now; "
                                                   "this page shows what it finds once it is done")
        if done.returncode != 0:
            lines = [line.strip() for line in f"{done.stdout}\n{done.stderr}".splitlines() if line.strip()]
            return "failed", _text(f"{_ended(done.returncode)}: {lines[-1]}" if lines else _ended(done.returncode), 500)
        inst = self.installer()
        failed, checked = inst["check_failed"], parse_stamp(inst["checked_at"])
        if failed and (parse_stamp(failed["at"]) or started) >= started:
            return "failed", failed["reason"]
        if checked is None or checked < started:
            return "failed", "the updater ended without checking"
        return ("offer" if inst["offer"] else "current"), None

    def _install(self, by, overrode, offer):
        """Update now on an installed Mac release: the updater's own hourly run with the owner's answer given,
        `update.py check --home <OmegaHive> --job --answer Update`, in a session of its own so it outlives this
        process. It reads the feed and checks the signature again, downloads the release (through the owner's browser
        while the release needs a sign-in), verifies it and hands its installer to a Terminal window, which stops this
        hive, refreshes it in place and opens it again on the new release. Only the updater's own environment
        reaches it, none of the hive's settings or keys."""
        updater, home = self._updater("double-click Install Omega in the new release to update")
        if self._updating():
            raise self.hive.error(409, "updating", "the updater is checking or installing now; "
                                                   "this page shows the update once it is done")
        env = self._updater_env()
        log_path = home / "logs" / "update-now.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        mark = log_path.stat().st_size if log_path.exists() else 0      # this run's output starts here
        started = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
        with open(log_path, "a") as log:
            job = Popen([sys.executable, "-I", str(updater), "check", "--home", str(home), "--job",
                                    "--answer", "Update"], cwd=str(home), env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self._installer_job = job
        running = (self.running_release or {}).get("version")
        row = self._record("platform", by, {"release": running}, {"release": offer["version"], "installer": True}, True,
                           None, overrode)
        Thread(target=self._installed, args=(job, row, offer["version"], started, log_path, mark), daemon=True).start()
        self.hive.db.execute("UPDATE update_requests SET status = 'applied', closed_at = ?, closed_by = ? WHERE target = 'platform' AND status = 'pending'",
                             (now(), by))
        self._event()
        return {"target": "platform", "ok": True, "updating": True, "from": running, "to": offer["version"],
                "label": offer["label"]}

    def _installed(self, job, row, version, started, log_path, mark):
        """Once the updater's run ends the page reads its state again. Status 0: the installer has the update in hand
        (or nothing newer was out). Otherwise the run's history row is marked failed with why: the updater's own failed
        when this run wrote one, else how the run ended and its last line of output (a crash writes nothing, as
        macOS's abort in an unsafe libcrypto load did on 10 November)."""
        code = job.wait()
        if code != 0:
            self.hive.db.execute("UPDATE update_history SET ok = 0, error = ? WHERE id = ?",
                                 (self._why(code, version, started, log_path, mark), row))
        self._event()

    def _why(self, code, version, started, log_path, mark):
        try:
            state = json.loads(self.installer_state.read_text())
        except (OSError, ValueError):
            state = {}
        failed = state.get("failed") if isinstance(state, dict) and isinstance(state.get("failed"), dict) else {}
        at = parse_stamp(failed.get("at"))
        if failed.get("version") == version and at is not None and at >= started:
            return _text(failed.get("error"), 500)
        try:
            with open(log_path, "rb") as f:
                f.seek(mark)
                lines = [line.strip() for line in f.read().decode("utf-8", "replace").splitlines() if line.strip()]
        except OSError:
            lines = []
        return _text(f"{_ended(code)}: {lines[-1]}" if lines else _ended(code), 500)

    def _record(self, target, by, before, after, ok, error, overrode):
        row = new_id("uh")
        self.hive.db.insert("update_history", {"id": row, "target": target, "by": by, "at": now(), "before": json.dumps(before),
                                               "after": json.dumps(after), "ok": int(ok), "error": error, "overrode": json.dumps(overrode)})
        return row

    def history(self, limit=50):
        rows = self.hive.db.all("SELECT * FROM update_history ORDER BY at DESC LIMIT ?", (int(limit),))
        return [{**r, "ok": bool(r["ok"]), "before": json.loads(r["before"]), "after": json.loads(r["after"]),
                 "overrode": json.loads(r["overrode"])} for r in rows]

    def _event(self):
        self.hive.events.publish("updates")
