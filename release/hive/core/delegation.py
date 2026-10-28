"""A coordinating mind starts and stops the members it coordinates, for tasks assigned to them, under leases a
named person issues. "The mind is the coordinator" made operational; first user: OmegaPurple's coordinator.

- delegation: a signed-in admin person says which members a coordinator may run (same swarm, not external members).
- lease: a signed-in admin person issues one run: coordinator, specialist, an open task assigned to that specialist,
  a duration (at most 15 minutes, never past the task's deadline) and a budget (within the specialist's hard cap).
- the coordinator redeems the lease once to start the specialist, may stop it, and reads its status.
- the hive reconciles every run on its own (finished, failed, cancelled, expired, over budget, or isolation lost:
  stopped), so a crashed coordinator cannot leave a specialist running. A stop counts only when the process is
  observed stopped. A specialist starts only while OS isolation is deployed (HIVE_MIND_SANDBOX=1 and available).
The broker is OmegaPurple's (hive/core/lifecycle_broker.py), unchanged.
"""

from __future__ import annotations

import asyncio
import datetime
import json

from .db import now
from .lifecycle_broker import LifecycleBroker

SCHEMA = """CREATE TABLE IF NOT EXISTS delegations (coordinator_id TEXT NOT NULL, specialist_id TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (coordinator_id, specialist_id))"""


class _Runtime:
    def __init__(self, hive):
        self.hive = hive

    def _process_stopped(self, agent_id):
        sup = self.hive.supervisor
        if sup is None:
            return False  # nothing observed is never "stopped"
        try:
            return sup.driver(self.hive.agent(agent_id)).status(agent_id) != "running"
        except Exception:
            return False

    async def start(self, specialist):
        await asyncio.to_thread(self.hive.lifecycle, specialist, "start")

    async def stop(self, specialist):
        await asyncio.to_thread(self.hive.lifecycle, specialist, "stop")

    async def stopped(self, specialist):
        row = self.hive.db.one("SELECT desired FROM agents WHERE id = ? AND deleted = 0", (specialist,))
        return bool(row and row["desired"] == "stopped" and self._process_stopped(specialist) is True)


class _AuthorityBroker(LifecycleBroker):
    def __init__(self, *args, authority_ready, **kwargs):
        self.authority_ready = authority_ready
        super().__init__(*args, **kwargs)

    async def valid(self, lease):
        allowed = await super().valid(lease) and self.authority_ready(lease)
        if not allowed:
            self.revoke(lease)  # a detected authority loss stays revoked after role restoration
        return allowed


class Delegation:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(SCHEMA)
        hive.db.execute("CREATE TABLE IF NOT EXISTS lifecycle_authorities (lease TEXT PRIMARY KEY, issued_by TEXT NOT NULL)")
        path = hive.settings.data_dir / "lifecycle" / "runs.sqlite"
        self.broker = _AuthorityBroker(path, _Runtime(hive), self._task_state, self._isolation_ready, self._member, self._spend, authority_ready=self._lease_authority)

    # ---- host adapters (trusted) ---------------------------------------------------------------

    def _admin_current(self, principal):
        if not isinstance(principal, str) or not principal.startswith("user:") or principal == "user:operator":
            return False
        person = self.hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        return bool(person and person["role"] == "admin" and not person["disabled"])

    def _lease_authority(self, lease):
        row = self.hive.db.one("SELECT issued_by FROM lifecycle_authorities WHERE lease = ?", (lease,))
        return bool(row and self._admin_current(row["issued_by"]))

    def _member(self, coordinator, specialist):
        grant = self.hive.db.one("SELECT created_by FROM delegations WHERE coordinator_id = ? AND specialist_id = ?", (coordinator, specialist))
        if not grant or not self._admin_current(grant["created_by"]):
            return False
        try:
            left, right = self.hive.agent(coordinator), self.hive.agent(specialist)
        except Exception:
            return False
        return left["swarm_id"] == right["swarm_id"] and right["kind"] != "module"

    def _task_state(self, specialist, task):
        goal, agent = self.hive.goals.get(task), self.hive.agent(specialist)
        if goal["swarm_id"] != agent["swarm_id"]:
            raise PermissionError("foreign swarm task")
        status = {"done": "completed", "stalled": "failed", "claimed": "open"}.get(goal["status"], goal["status"])
        deadline = goal.get("deadline_at")
        return {"task_status": status, "assignee": goal.get("assignee"),
                "deadline_epoch": datetime.datetime.fromisoformat(deadline.replace("Z", "+00:00")).timestamp() if deadline else None,
                "budget_remaining": self.hive.budgets.remaining_for(agent)}

    def _isolation_ready(self, specialist):
        """Deployed OS isolation for this specialist: the local driver with the sandbox requested and available, and,
        once its process runs, the boundary that process actually has (not the setting)."""
        from ..supervisor.sandbox import available, mind_sandbox_requested
        if not mind_sandbox_requested() or not available():
            return False
        sup = self.hive.supervisor
        if sup is None:
            return False
        try:
            agent = self.hive.agent(specialist)
            driver = sup.driver(agent)
        except Exception:
            return False
        if getattr(driver, "name", None) != "local":
            return False
        if driver.status(specialist) == "running":
            return bool((getattr(driver, "isolation", {}) or {}).get(specialist, {}).get("os_sandbox"))
        return True

    def _spend(self, specialist):
        return float(self.hive.agent(specialist).get("spent_usd") or 0)

    # ---- people ----------------------------------------------------------------------------------

    def set_delegation(self, coordinator_id, specialist_ids, by):
        coord = self.hive.agent(coordinator_id)
        for sid in specialist_ids:
            s = self.hive.agent(sid)
            if s["swarm_id"] != coord["swarm_id"] or s["kind"] == "module" or sid == coordinator_id:
                raise self.hive.error(400, "bad_delegation", "a coordinator runs other native minds of its own swarm")
        self.hive.db.execute("DELETE FROM delegations WHERE coordinator_id = ?", (coordinator_id,))
        for sid in specialist_ids:
            self.hive.db.execute("INSERT INTO delegations VALUES (?, ?, ?, ?)", (coordinator_id, sid, by, now()))
        return self.delegations(coordinator_id)

    def delegations(self, coordinator_id=None):
        rows = self.hive.db.all("SELECT * FROM delegations" + (" WHERE coordinator_id = ?" if coordinator_id else ""),
                                (coordinator_id,) if coordinator_id else ())
        return rows

    def issue(self, data, by):
        if not self._admin_current(by):
            raise self.hive.error(403, "person_admin_required", "current admin person required")
        for key in ("coordinator", "specialist", "task"):
            if not isinstance(data.get(key), str) or not data[key].strip():
                raise self.hive.error(400, "bad_request", "coordinator, specialist and task are required")
        try:
            lease = self.broker.issue(data["coordinator"], data["specialist"], data["task"],
                                      seconds=float(data.get("seconds", 60)), budget_usd=float(data.get("budget_usd", 0)))
        except Exception as exc:
            import sqlite3
            if isinstance(exc, sqlite3.IntegrityError):
                raise self.hive.error(409, "active_run", "that member already has a run")
            raise self.hive.error(403, "lease_refused", f"lease refused: {exc}")
        self.hive.db.execute("INSERT INTO lifecycle_authorities VALUES (?, ?)", (lease, by))
        return {"lease": lease, "coordinator": data["coordinator"], "specialist": data["specialist"], "task": data["task"]}

    # ---- the coordinator ---------------------------------------------------------------------

    def _row(self, agent, lease):
        try:
            row = self.broker.row(str(lease or ""))
        except (PermissionError, TypeError):
            raise self.hive.error(403, "lease_refused", "unknown lease")
        if row["coordinator"] != agent["id"]:
            raise self.hive.error(403, "forbidden", "not your lease")
        return row

    async def start(self, agent, lease):
        row = self._row(agent, lease)
        try:
            await self.broker.authorize(row["coordinator"], row["specialist"], row["task"], row["lease"])
            await asyncio.wait_for(self.broker.start(row["specialist"], row["task"], row["lease"]), 10)
        except PermissionError as exc:
            raise self.hive.error(403, "lease_refused", str(exc))
        return {"specialist": row["specialist"], "task": row["task"], "start_requested": True}

    async def stop(self, agent, lease):
        row = self._row(agent, lease)
        await asyncio.wait_for(self.broker.stop(row["specialist"], row["task"], row["lease"]), 10)
        return {"specialist": row["specialist"], "stop_observed": await self.broker.stopped(row["specialist"], row["task"], row["lease"])}

    async def status(self, agent, lease):
        row = self._row(agent, lease)
        state = await self.broker.observe(row["specialist"], row["task"], row["lease"])
        return {"specialist": row["specialist"], "task": row["task"], "task_status": state["task_status"],
                "budget_exhausted": state["budget_exhausted"], "lease_valid": await self.broker.valid(row["lease"]),
                "stop_observed": await self.broker.stopped(row["specialist"], row["task"], row["lease"])}

    async def reconcile(self):
        return await self.broker.reconcile()
