"""Requests from people to the hive's admins (the owner, 2026-10-04).

A member asks; an admin decides, with the same five answers as every approval: Once, For a time, Always, No, Never.
- once: grant this request.
- for:   grant it, and grant the same kind of request from this person automatically for N minutes.
- always: grant it, and from now on grant this kind from this person automatically.
- no:    decline this request.
- never: decline it, and from now on decline this kind from this person automatically.

Kinds:
- mind:          a new mind in a swarm the requester can see, owned by them and billed to them (their allowance or key).
- allowance:     a monthly allowance for the requester (also raised automatically, once a month, when they run out).
- swarm_access:  being shared into a swarm they cannot yet see.
Nothing a member asks for spends shared money or reaches shared work until it is granted.
"""

from __future__ import annotations

import json
import time

from .db import new_id, now
from .limits_auto import dollars, to_micros

KINDS = ("mind", "allowance", "swarm_access")
SCHEMA = [
    """CREATE TABLE IF NOT EXISTS person_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, requested_by TEXT NOT NULL,
  payload TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
  decided_at TEXT, decision TEXT, result TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS person_request_rules (id TEXT PRIMARY KEY, person TEXT NOT NULL, kind TEXT NOT NULL,
  mode TEXT NOT NULL, expires_at REAL, created_at TEXT NOT NULL, created_by TEXT NOT NULL)""",
]


class PersonRequests:
    def __init__(self, hive):
        self.hive = hive
        for s in SCHEMA:
            hive.db.execute(s)

    def view(self, r):
        return {**r, "payload": json.loads(r["payload"]), "result": json.loads(r["result"]) if r["result"] else None}

    def list(self, viewer):
        rows = self.hive.db.all("SELECT * FROM person_requests ORDER BY created_at DESC LIMIT 300")
        mine = [self.view(r) for r in rows if viewer.admin or r["requested_by"] == viewer.principal]
        return self.hive.visibility.hide_others_personal(viewer, mine)

    def _rule(self, person, kind):
        return self.hive.db.one("SELECT * FROM person_request_rules WHERE person = ? AND kind = ? AND (expires_at IS NULL OR expires_at > ?) "
                                "ORDER BY created_at DESC LIMIT 1", (person, kind, time.time()))

    def _clean(self, kind, payload):
        if kind not in KINDS:
            raise self.hive.error(400, "bad_request", f"kind is one of {', '.join(KINDS)}")
        payload = payload if isinstance(payload, dict) else {}
        if kind == "mind":
            name = str(payload.get("name") or "").strip()[:60]
            if not name or not payload.get("swarm_id"):
                raise self.hive.error(400, "bad_request", "a mind request needs a name and a swarm")
            self.hive.swarm(str(payload["swarm_id"]))
            try:
                budget = float(payload.get("budget_usd", 5))
            except (TypeError, ValueError):
                raise self.hive.error(400, "bad_request", "budget_usd is a number") from None
            if not 0 < budget <= 500:
                raise self.hive.error(400, "bad_request", "a mind budget is more than $0 and at most $500")
            return {"name": name, "swarm_id": str(payload["swarm_id"]), "model": str(payload.get("model") or "")[:200] or None,
                    "purpose": str(payload.get("purpose") or "")[:2000], "budget_usd": budget}
        if kind == "allowance":
            try:
                monthly = float(payload.get("monthly_usd"))
            except (TypeError, ValueError):
                raise self.hive.error(400, "bad_request", "monthly_usd is a number") from None
            if not 0 < monthly <= 10_000:
                raise self.hive.error(400, "bad_request", "an allowance is more than $0 and at most $10,000 a month")
            return {"monthly_usd": monthly}
        swarm_id = str(payload.get("swarm_id") or "")
        self.hive.swarm(swarm_id)
        return {"swarm_id": swarm_id}

    async def create(self, viewer, data):
        person = viewer.principal
        if not person.startswith("user:u_"):
            raise self.hive.error(403, "person_required", "requests come from a signed-in person")
        kind = str(data.get("kind") or "")
        payload = self._clean(kind, data.get("payload"))
        if kind == "mind":
            swarm = self.hive.swarm(payload["swarm_id"])
            if not viewer.sees(swarm):
                raise self.hive.error(404, "not_found", "no such swarm")
        row = {"id": new_id("pr"), "kind": kind, "requested_by": person, "payload": json.dumps(payload),
               "note": str(data.get("note") or "")[:1000], "status": "pending", "decided_by": None, "decided_at": None,
               "decision": None, "result": None, "created_at": now()}
        self.hive.db.insert("person_requests", row)
        rule = self._rule(person, kind)
        if rule:   # a standing answer from an admin: apply it without asking again
            return await self._settle(row["id"], "once" if rule["mode"] == "allow" else "no", f"rule:{rule['id']}")
        self.hive.events.publish("person_request.created", request=self.view(row))
        return self.view(row)

    def auto_allowance(self, person, monthly_now):
        """When a member runs out, ask the admins once a month for more (the owner: stop, notify, request card)."""
        month = now()[:7]
        if self.hive.db.one("SELECT 1 FROM person_requests WHERE requested_by = ? AND kind = 'allowance' AND created_at >= ?",
                            (person, month)):
            return
        # the proposed allowance, floored to the cent in integer micro-dollars (never rounded up, OmegaReview r8)
        now_micros = to_micros(monthly_now)
        proposed = max(now_micros * 2, now_micros + 25 * 1_000_000)
        payload = {"monthly_usd": dollars(proposed // 10_000 * 10_000)}
        row = {"id": new_id("pr"), "kind": "allowance", "requested_by": person, "payload": json.dumps(payload),
               "note": f"Ran out of the ${monthly_now:.0f} monthly allowance; their minds are paused until it is raised.",
               "status": "pending", "decided_by": None, "decided_at": None, "decision": None, "result": None, "created_at": now()}
        self.hive.db.insert("person_requests", row)
        self.hive.events.publish("person_request.created", request=self.view(row))

    async def decide(self, admin_principal, request_id, decision, minutes=None):
        if decision not in ("once", "for", "always", "no", "never"):
            raise self.hive.error(400, "bad_request", "decision is once, for, always, no or never")
        r = self.hive.db.one("SELECT * FROM person_requests WHERE id = ?", (request_id,))
        if r is None:
            raise self.hive.error(404, "not_found", "no such request")
        if r["status"] != "pending":
            raise self.hive.error(409, "not_pending", f"this request is {r['status']}")
        expires = None
        if decision == "for":
            try:
                minutes = int(minutes)
            except (TypeError, ValueError):
                raise self.hive.error(400, "bad_request", "say for how many minutes") from None
            if not 1 <= minutes <= 30 * 24 * 60:
                raise self.hive.error(400, "bad_request", "for a time is 1 minute to 30 days")
            expires = time.time() + minutes * 60
        if decision in ("for", "always", "never"):
            self.hive.db.insert("person_request_rules", {"id": new_id("prr"), "person": r["requested_by"], "kind": r["kind"],
                                                         "mode": "deny" if decision == "never" else "allow", "expires_at": expires,
                                                         "created_at": now(), "created_by": admin_principal})
        return await self._settle(request_id, decision, admin_principal)

    async def _settle(self, request_id, decision, by):
        r = self.hive.db.one("SELECT * FROM person_requests WHERE id = ?", (request_id,))
        granted = decision in ("once", "for", "always")
        result = self._apply(r) if granted else None
        if not by.startswith("rule:"):   # a standing answer applied again is not a new observation
            from .governance_evidence import ask_statement
            self.hive.governance.record(request_id, ask_statement(r["requested_by"], r["kind"]), granted)
        self.hive.db.execute("UPDATE person_requests SET status = ?, decided_by = ?, decided_at = ?, decision = ?, result = ? WHERE id = ?",
                             ("granted" if granted else "declined", by, now(), decision, json.dumps(result) if result else None, request_id))
        out = self.view(self.hive.db.one("SELECT * FROM person_requests WHERE id = ?", (request_id,)))
        self.hive.events.publish("person_request.updated", request=out)
        return out

    def _apply(self, r):
        payload, person = json.loads(r["payload"]), r["requested_by"]
        if r["kind"] == "mind":
            agent = self.hive.create_agent(payload["name"], "omega", payload["swarm_id"], payload.get("model"), payload.get("purpose") or "",
                                           None, payload["budget_usd"], None, None, person, "private", None)
            return {"agent_id": agent["id"], "name": agent["name"]}
        if r["kind"] == "allowance":
            self.hive.budgets.set("person:" + person[5:], "month", payload["monthly_usd"], f"granted request {r['id']}")
            return {"monthly_usd": payload["monthly_usd"]}
        from .visibility import Viewer
        row = self.hive.db.one("SELECT visibility, shared_with FROM swarms WHERE id = ?", (payload["swarm_id"],))
        shared = json.loads(row["shared_with"] or "[]")
        if person not in shared:
            shared.append(person)
        visibility = row["visibility"] if row["visibility"] in ("shared", "public") else "shared"
        self.hive.visibility.set("swarms", payload["swarm_id"], Viewer("user:operator", True), visibility, shared)
        self.hive.events.publish("swarm.updated", swarm=self.hive.swarm(payload["swarm_id"]))
        return {"swarm_id": payload["swarm_id"], "visibility": visibility}
