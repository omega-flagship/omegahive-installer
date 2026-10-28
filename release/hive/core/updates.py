"""Updates (R18): what is waiting to load, who asked, what must not be interrupted, and applying it.

- Apps: the loaded code is compared with its folder on disk (manifest version and a digest of its sources), so a
  changed app shows "update available" whether or not anyone asked.
- Platform: the build this process started from is compared with the source a restart would run.
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
import json
import os
import pathlib
import signal
import subprocess

from .db import new_id, now

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


def _git(*args):
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


class Updates:
    def __init__(self, hive):
        self.hive = hive
        for s in SCHEMA:
            hive.db.execute(s)
        self.running_build = _git("rev-parse", "HEAD") or None
        self.started_at = now()
        self.supervised = os.environ.get("HIVE_SUPERVISED") == "1"
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
        return {"target": "platform", "running_build": self.running_build, "source_build": head, "started_at": self.started_at,
                "update_available": bool(waiting), "commits_waiting": waiting, "supervised": self.supervised,
                "request": self._open_request("platform")}

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
            return self._restart(by, overrode)
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

    def _record(self, target, by, before, after, ok, error, overrode):
        self.hive.db.insert("update_history", {"id": new_id("uh"), "target": target, "by": by, "at": now(), "before": json.dumps(before),
                                               "after": json.dumps(after), "ok": int(ok), "error": error, "overrode": json.dumps(overrode)})

    def history(self, limit=50):
        rows = self.hive.db.all("SELECT * FROM update_history ORDER BY at DESC LIMIT ?", (int(limit),))
        return [{**r, "ok": bool(r["ok"]), "before": json.loads(r["before"]), "after": json.loads(r["after"]),
                 "overrode": json.loads(r["overrode"])} for r in rows]

    def _event(self):
        self.hive.events.publish("updates")
