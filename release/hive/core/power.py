"""Off, and Wake all (Jon 2026-10-05). Off records which minds were meant to be awake, then stops every mind through
stop_all; On wakes exactly those that still can. Stop all records the same snapshot, so Wake all restores from it.

One snapshot is pending at a time: a later Off or Stop all adds the minds then awake to it and never replaces the set
Off first recorded. Each mind is added durably under its lock before its stop, so a pass cut short loses nothing. On restores the pending snapshot and marks it restored. Off and On are idempotent on operation_id.
"""

from __future__ import annotations

import contextlib
import json
import threading

from .db import new_id, now

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS power_snapshots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, by TEXT NOT NULL,
  minds TEXT NOT NULL, state TEXT NOT NULL, restored_at TEXT, restored_by TEXT)""",
    """CREATE TABLE IF NOT EXISTS power_operations (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, by TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)""",
)
PENDING = "restored_at IS NULL"   # state 'off' (the hive is off) or 'stopped' (Stop all: on, with a Wake all to offer)


class Power:
    def __init__(self, hive):
        self.hive = hive
        self.lock = threading.RLock()   # Off, On and Stop all one at a time; taken before any mind's lock
        for sql in SCHEMA:
            hive.db.execute(sql)

    def pending(self):
        return self.hive.db.one(f"SELECT * FROM power_snapshots WHERE {PENDING} ORDER BY created_at DESC LIMIT 1")

    @staticmethod
    def wakeable(row, archived):
        return row["desired"] == "awake" and row["kind"] != "module" and not archived

    def hold(self, mind, by, state):
        """stop_all, under self.lock and the mind's lock, BEFORE its stop: the mind is in the pending snapshot durably
        first, so no stop that lands is ever missing from the restore set, whatever fails or ends the process after."""
        with self.hive.db.transaction():
            row = self.pending()
            if row is None:
                self.hive.db.insert("power_snapshots", {"id": new_id("pw"), "created_at": now(), "by": by,
                                                        "minds": json.dumps([mind]), "state": state})
                return
            kept = json.loads(row["minds"])
            values = {} if mind in kept else {"minds": json.dumps(kept + [mind])}
            if state == "off" and row["state"] != "off":   # Stop all, then Off: the hive goes off now
                values.update(state="off", created_at=now(), by=by)
            if values:
                self.hive.db.update("power_snapshots", row["id"], values)

    def record(self, by, state):
        """stop_all, after the pass: Off leaves the hive off even when it found no mind awake. Restore custody is held
        per mind before each stop (hold), never here."""
        if state != "off":
            return
        with self.hive.db.transaction():
            row = self.pending()
            if row is None:
                self.hive.db.insert("power_snapshots", {"id": new_id("pw"), "created_at": now(), "by": by,
                                                        "minds": "[]", "state": "off"})
            elif row["state"] != "off":
                self.hive.db.update("power_snapshots", row["id"], {"state": "off", "created_at": now(), "by": by})

    def view(self, admin):
        db = self.hive.db
        latest = db.one("SELECT * FROM power_snapshots ORDER BY COALESCE(restored_at, created_at) DESC LIMIT 1")
        if latest and latest["state"] == "off":
            out = {"state": "off", "since": latest["created_at"], "by": latest["by"]}
        else:
            on = db.one("SELECT restored_at, restored_by FROM power_snapshots WHERE restored_at IS NOT NULL "
                        "ORDER BY restored_at DESC LIMIT 1")
            out = {"state": "on", "since": on and on["restored_at"], "by": on and on["restored_by"]}
        if admin:
            pending = self.pending()
            out["minds_in_snapshot"] = len(json.loads(pending["minds"])) if pending else 0
        return out

    def set(self, state, operation_id, by):
        if state not in ("off", "on"):
            raise self.hive.error(400, "bad_request", "state is off or on")
        if not isinstance(operation_id, str) or not 0 < len(operation_id) <= 128:
            raise self.hive.error(400, "bad_request", "operation_id is required (at most 128 characters)")
        with self.lock:
            # 'running' until the result is stored: work a failure or restart cut short is retried by a replay; only a
            # finished run (failures reported in it included) is returned as it was.
            done = self.hive.db.one("SELECT * FROM power_operations WHERE operation_id = ?", (operation_id,))
            if done and done["state"] != state:
                raise self.hive.error(409, "operation_conflict", f"operation {operation_id} was a power {done['state']}")
            if done and done["status"] == "done":
                return json.loads(done["result"])
            if done is None:
                self.hive.db.insert("power_operations", {"operation_id": operation_id, "state": state, "by": by,
                                                         "status": "running", "result": "{}", "created_at": now()})
            result = self._off(by) if state == "off" else self._on(by)
            self.hive.db.execute("UPDATE power_operations SET status = 'done', result = ? WHERE operation_id = ?",
                                 (json.dumps(result), operation_id))
        self.hive.events.publish("hive.power", state=result["state"], since=result["since"])
        return result

    def _off(self, by):
        try:
            done = dict(self.hive.stop_all(by=by, power="off"), failed=[])
        except Exception as exc:
            if getattr(exc, "code", None) != "stop_incomplete":
                raise
            done = {"stopped": exc.details["stopped"], "failed": exc.details["failed"]}  # those minds are still up
        return {"state": "off", "since": self.view(False)["since"], **done}

    def _on(self, by):
        row = self.pending()
        woken, skipped, failed = [], [], []
        for mind in json.loads(row["minds"]) if row else []:
            why = []

            def ready(fresh, why=why):
                # Old pending snapshots can predate infrastructure-aware Off.
                # This runs under lifecycle's original mind lock, before start.
                if any(b["agent_id"] == mind for b in self.hive.foundation_infrastructure_bindings()):
                    why.append("foundation infrastructure; use its original request admission")
                    return False
                foundation = getattr(self.hive, "foundation", None)
                if (foundation is not None and getattr(foundation, "hive", None) is self.hive
                        and getattr(foundation, "db", None) is self.hive.db):
                    from .foundation import CODE, REVIEW
                    exists = self.hive.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'")
                    if exists and self.hive.db.one("SELECT 1 FROM person_minds WHERE agent_id = ? AND purpose IN (?, ?)",
                                                  (mind, CODE, REVIEW)):
                        why.append("foundation binding changed; repair required")
                        return False
                swarm = self.hive.db.one("SELECT archived_at FROM swarms WHERE id = ?", (fresh.get("swarm_id"),))
                why.append("swarm archived" if swarm and swarm["archived_at"] else "moved" if fresh.get("moved_to")
                           else None if fresh["status"] in ("stopped", "asleep") else fresh["status"])
                return why[-1] is None
            try:
                self.hive.lifecycle(mind, "start", expect=ready)
            except Exception as exc:
                if getattr(exc, "status", None) == 404:
                    skipped.append({"id": mind, "reason": "deleted"})
                    continue
                failed.append({"id": mind, "error": getattr(exc, "message", None) or str(exc)})
                if getattr(exc, "status", None) is None:   # the start itself failed: recorded, as boot restore does
                    with contextlib.suppress(Exception):
                        self.hive.set_status(mind, "error", error=f"start failed at wake: {exc}")
                continue
            if why and why[-1]:
                skipped.append({"id": mind, "reason": why[-1]})
            else:
                woken.append(mind)
        since = now()
        if row:
            self.hive.db.update("power_snapshots", row["id"], {"state": "restored", "restored_at": since,
                                                               "restored_by": by})
        return {"state": "on", "since": since if row else self.view(False)["since"], "woken": woken,
                "skipped": skipped, "failed": failed}
