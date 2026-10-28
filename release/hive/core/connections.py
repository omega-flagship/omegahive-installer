"""Connection agreements between swarms (R11): who, why, what is shared at which access, for how long, on what
budget, coordinated by whom. Made by a signed-in admin person; every change is logged; ending is automatic.

A connection confers only its scopes, and only while active:
- memory: {kind: "memory", side: "from"|"to", mind, space, pattern?, access: "read"} -> a time-limited read share
  from that mind's space to the OTHER side's coordinator (the mind coordinates its swarm, so it decides what to
  pass on inside its own swarm, through ordinary exhibits).
- requests: {kind: "requests", direction: "from->to"|"to->from", kinds: [...]} -> the sending side may make cross-
  swarm requests of those kinds even if the receiving swarm does not list them as public services; they draw on
  the connection's budget.
- repository and channel scopes are refused for now (repository access waits for the OmegaCode bridge).

Pause, revoke and expiry close every share at once and stop new requests; in-flight requests are left to finish
or are cancelled, as the agreement says. Revoking never erases what was already read; the record says so.
"""

from __future__ import annotations

import datetime
import json
import math

from .db import new_id, now

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, from_swarm TEXT NOT NULL, to_swarm TEXT NOT NULL, purpose TEXT NOT NULL, deliverable TEXT NOT NULL,
  success TEXT NOT NULL, from_coordinator TEXT NOT NULL, to_coordinator TEXT NOT NULL, scopes TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT, until_revoked INTEGER NOT NULL DEFAULT 0, review_at TEXT,
  budget_usd REAL NOT NULL, allocated_usd REAL NOT NULL DEFAULT 0, on_end TEXT NOT NULL, status TEXT NOT NULL,
  share_ids TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at TEXT NOT NULL, history TEXT NOT NULL)""",
]
ACCESS = {"read"}
ON_END = {"drain", "cancel"}


def _later(days):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=float(days))).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Connections:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for s in SCHEMA:
            self.db.execute(s)

    # ---- reading -----------------------------------------------------------------------------

    def get(self, cid):
        row = self.db.one("SELECT * FROM connections WHERE id = ?", (cid,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no connection {cid}")
        return row

    def view(self, row):
        out = dict(row)
        for k in ("scopes", "share_ids", "history"):
            out[k] = json.loads(row[k])
        out["until_revoked"] = bool(row["until_revoked"])
        out["summary"] = self.summary(out)
        out["note"] = "Ending a connection stops access from then on; it cannot erase what was already read."
        return out

    def summary(self, c):
        names = {r["id"]: r["name"] for r in self.db.all("SELECT id, name FROM swarms")}
        parts = []
        for s in c["scopes"]:
            if s["kind"] == "memory":
                parts.append(f"read '{s['space']}'")
            elif s["kind"] == "requests":
                parts.append(f"{'/'.join(s['kinds'])} requests {s['direction']}")
        until = "until revoked" if c["until_revoked"] else f"until {c['ends_at'][:10]}"
        return (f"{names.get(c['from_swarm'], c['from_swarm'])} ↔ {names.get(c['to_swarm'], c['to_swarm'])} · "
                f"{c['purpose'][:60]} · {', '.join(parts) or 'nothing shared'} · {until} · ${c['budget_usd']:.2f}")

    def list(self, swarm_id=None):
        rows = self.db.all("SELECT * FROM connections ORDER BY created_at DESC")
        return [self.view(r) for r in rows if not swarm_id or swarm_id in (r["from_swarm"], r["to_swarm"])]

    # ---- making one ------------------------------------------------------------------------------

    def _coordinator(self, swarm_id, mind_id, side):
        row = self.db.one("SELECT id, swarm_id FROM agents WHERE id = ? AND deleted = 0", (str(mind_id or ""),))
        if row is None or row["swarm_id"] != swarm_id:
            raise self.hive.error(400, "bad_coordinator", f"the {side} coordinator must be a mind in that swarm")
        return row["id"]

    def _clean_scopes(self, scopes, from_swarm, to_swarm, coordinators):
        if not isinstance(scopes, list) or not scopes:
            raise self.hive.error(400, "bad_scopes", "say what is shared: at least one scope")
        out = []
        for s in scopes:
            kind = (s or {}).get("kind")
            if kind == "memory":
                side = s.get("side")
                if side not in ("from", "to") or s.get("access", "read") not in ACCESS:
                    raise self.hive.error(400, "bad_scopes", "memory scopes are read-only, from one side's mind")
                owner_swarm = from_swarm if side == "from" else to_swarm
                mind = self.db.one("SELECT id, swarm_id FROM agents WHERE id = ? AND deleted = 0", (str(s.get("mind") or ""),))
                if mind is None or mind["swarm_id"] != owner_swarm:
                    raise self.hive.error(400, "bad_scopes", "a memory scope names a mind of the sharing side")
                self.hive.shares._space(mind["id"], s.get("space"))
                out.append({"kind": "memory", "side": side, "mind": mind["id"], "space": s["space"],
                            "pattern": (str(s.get("pattern")).strip() or None) if s.get("pattern") else None, "access": "read"})
            elif kind == "requests":
                if s.get("direction") not in ("from->to", "to->from"):
                    raise self.hive.error(400, "bad_scopes", "requests scopes have a direction: from->to or to->from")
                kinds = sorted({str(k).strip() for k in s.get("kinds") or [] if str(k).strip()})
                if not kinds:
                    raise self.hive.error(400, "bad_scopes", "name the request kinds allowed")
                out.append({"kind": "requests", "direction": s["direction"], "kinds": kinds})
            elif kind in ("repository", "channel"):
                raise self.hive.error(400, "not_yet", f"{kind} scopes are not available yet "
                                      "(repository access arrives with the OmegaCode bridge)")
            else:
                raise self.hive.error(400, "bad_scopes", f"unknown scope kind {kind!r}")
        return out

    async def create(self, data, by):
        hive = self.hive
        f, t = str(data.get("from_swarm") or ""), str(data.get("to_swarm") or "")
        if not f or not t or f == t:
            raise hive.error(400, "bad_request", "connect two different swarms")
        hive.swarm(f), hive.swarm(t)
        purpose = str(data.get("purpose") or "").strip()
        if not purpose:
            raise hive.error(400, "bad_request", "say what the connection is for")
        coordinators = {"from": self._coordinator(f, data.get("from_coordinator"), "from"),
                        "to": self._coordinator(t, data.get("to_coordinator"), "to")}
        scopes = self._clean_scopes(data.get("scopes"), f, t, coordinators)
        until_revoked = bool(data.get("until_revoked"))
        if until_revoked:
            review_days = float(data.get("review_days") or 30)
            ends_at, review_at = None, _later(review_days)
        else:
            days = data.get("days")
            if days is None:
                raise hive.error(400, "bad_request", "set how long it lasts (days), or choose until revoked with a review date")
            days = float(days)
            if not math.isfinite(days) or not 0 < days <= 365:
                raise hive.error(400, "bad_request", "a connection lasts between a moment and a year")
            ends_at, review_at = _later(days), None
        budget = float(data.get("budget_usd", 0))
        if not math.isfinite(budget) or budget < 0 or budget > 100000:
            raise hive.error(400, "bad_request", "budget_usd must be a finite amount")
        on_end = data.get("on_end", "drain")
        if on_end not in ON_END:
            raise hive.error(400, "bad_request", "on_end is drain (let running work finish) or cancel")
        cid = new_id("cn")
        row = {"id": cid, "from_swarm": f, "to_swarm": t, "purpose": purpose[:500],
               "deliverable": str(data.get("deliverable") or "")[:500], "success": str(data.get("success") or "")[:500],
               "from_coordinator": coordinators["from"], "to_coordinator": coordinators["to"], "scopes": json.dumps(scopes),
               "starts_at": now(), "ends_at": ends_at, "until_revoked": int(until_revoked), "review_at": review_at,
               "budget_usd": budget, "allocated_usd": 0.0, "on_end": on_end, "status": "active", "share_ids": "[]",
               "created_by": by, "created_at": now(), "history": json.dumps([{"at": now(), "by": by, "event": "created"}])}
        self.db.insert("connections", row)
        await self._open(self.get(cid))
        return self._emit(cid)

    # ---- effects -------------------------------------------------------------------------------

    def _minutes_left(self, c):
        end = c["ends_at"] or c["review_at"]
        left = (datetime.datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.datetime.now(datetime.timezone.utc)).total_seconds() / 60
        return max(1.0, left)

    async def _open(self, c):
        shares = self.hive.shares
        ids = []
        for s in json.loads(c["scopes"]):
            if s["kind"] != "memory":
                continue
            grantee = c["to_coordinator"] if s["side"] == "from" else c["from_coordinator"]
            minutes = self._minutes_left(c)
            sid = shares._insert(kind="space", swarm_id=self.db.one("SELECT swarm_id FROM agents WHERE id = ?", (s["mind"],))["swarm_id"],
                                 owner_id=s["mind"], grantee_id=grantee, space=s["space"], pattern=s.get("pattern"),
                                 minutes=minutes, reason=f"connection:{c['id']}: {c['purpose'][:200]}", status="active",
                                 initiated_by="connection", decided_at=now(), expires_at=c["ends_at"] or c["review_at"])
            ids.append(sid)
            await shares._tell(grantee, f"[CONNECTION {c['id']}] You may read '{s['space']}' for this connection: "
                                        f"{c['purpose'][:200]}. Read it with hive-shared {sid} *.", sid, "share_offered")
            shares._emit(sid)
        self.db.update("connections", c["id"], {"share_ids": json.dumps(json.loads(c["share_ids"]) + ids)})

    async def _close(self, c, status, by, reason):
        for sid in json.loads(c["share_ids"]):
            share = self.hive.shares.get(sid)
            if share["status"] in ("requested", "active"):
                await self.hive.shares.revoke(sid)
        if c["on_end"] == "cancel" or status == "revoked":
            for r in self.db.all("SELECT id FROM requests WHERE connection_id = ? AND cancelled_at IS NULL", (c["id"],)):
                await self.hive.collab.cancel_request(r["id"], by)
        history = json.loads(c["history"]) + [{"at": now(), "by": by, "event": status, "reason": reason}]
        self.db.update("connections", c["id"], {"status": status, "history": json.dumps(history)})
        return self._emit(c["id"])

    def _emit(self, cid):
        view = self.view(self.get(cid))
        self.hive.events.publish("connection.updated", connection=view)
        return view

    # ---- lifecycle -------------------------------------------------------------------------------

    async def pause(self, cid, by):
        c = self.get(cid)
        if c["status"] != "active":
            raise self.hive.error(409, "not_active", f"connection is {c['status']}")
        return await self._close(c, "paused", by, "paused")

    async def resume(self, cid, by):
        c = self.get(cid)
        if c["status"] != "paused":
            raise self.hive.error(409, "not_paused", f"connection is {c['status']}")
        end = c["ends_at"] or c["review_at"]
        if end and end < now():
            raise self.hive.error(409, "ended", "this connection's time is over; renew it instead")
        self.db.update("connections", cid, {"status": "active", "share_ids": "[]",
                                            "history": json.dumps(json.loads(c["history"]) + [{"at": now(), "by": by, "event": "resumed"}])})
        await self._open(self.get(cid))
        return self._emit(cid)

    async def revoke(self, cid, by, reason=""):
        c = self.get(cid)
        if c["status"] in ("revoked", "ended"):
            raise self.hive.error(409, "closed", f"connection is {c['status']}")
        return await self._close(c, "revoked", by, reason or "revoked")

    async def renew(self, cid, by, days):
        c = self.get(cid)
        days = float(days)
        if not math.isfinite(days) or not 0 < days <= 365:
            raise self.hive.error(400, "bad_request", "renew for between a moment and a year")
        if c["status"] == "revoked":
            raise self.hive.error(409, "revoked", "a revoked connection is not renewed; make a new one")
        if c["status"] == "active":
            await self._close(c, "paused", by, "renewing")
        c = self.get(cid)
        fields = {"review_at": _later(days)} if c["until_revoked"] else {"ends_at": _later(days)}
        self.db.update("connections", cid, dict(fields, status="paused"))
        return await self.resume(cid, by)

    async def expire(self, moment=None):
        moment = moment or now()
        closed = []
        for c in self.db.all("SELECT * FROM connections WHERE status = 'active'"):
            end = c["ends_at"] or c["review_at"]
            if end and end < moment:
                await self._close(c, "ended" if c["ends_at"] else "paused", "hive", "time is up" if c["ends_at"] else "review due")
                closed.append(c["id"])
        return closed

    # ---- requests under a connection --------------------------------------------------------------

    def allows_request(self, from_swarm, to_swarm, kind):
        """The active connection that lets from_swarm send this kind of request to to_swarm, or None."""
        for c in self.db.all("SELECT * FROM connections WHERE status = 'active' AND "
                             "((from_swarm = ? AND to_swarm = ?) OR (from_swarm = ? AND to_swarm = ?))",
                             (from_swarm, to_swarm, to_swarm, from_swarm)):
            timestamp = now()
            deadline = c.get("ends_at") or c.get("review_at")
            if c["starts_at"] > timestamp or (deadline and deadline <= timestamp):
                continue
            for s in json.loads(c["scopes"]):
                if s["kind"] != "requests" or kind not in s["kinds"]:
                    continue
                forward = c["from_swarm"] == from_swarm
                if (s["direction"] == "from->to") == forward:
                    return c
        return None

    def allocate(self, c, asked):
        remaining = c["budget_usd"] - c["allocated_usd"]
        if asked > remaining + 1e-9:
            raise self.hive.error(402, "connection_budget", f"this connection has ${remaining:.2f} left to allocate")
        self.db.execute("UPDATE connections SET allocated_usd = allocated_usd + ? WHERE id = ?", (asked, c["id"]))
