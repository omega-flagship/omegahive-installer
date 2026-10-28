"""Swarm goals: posted by people or minds, claimed and finished by minds.

Anti-drift rules (docs/omegadots/DRIFT.md):
- A claim is a lease.  The claimer renews it with a heartbeat; when it lapses
  the goal goes back to the swarm, and after MAX_ATTEMPTS lapses it is
  ``stalled`` until a person looks at it, instead of being re-tried forever.
- ``waiting`` means "delivered, waiting on a person": not failing, so the
  claimer does not keep re-sending, and its lease is paused.
- ``done`` needs a result that says what was done.
- Splitting is bounded in depth and fan-out, so one goal cannot spawn an
  unbounded tree of subgoals.
"""

from __future__ import annotations

import datetime
import hashlib
import inspect
import json

from .db import new_id, now
from .result_schema import SchemaError, check_schema, validate as validate_result

STATUSES = {"open", "claimed", "waiting", "stalled", "submitted", "done", "failed", "cancelled"}
# Where a status change may not go from: a finished goal stays finished (a retry of a failed goal is a fresh start).
TERMINAL_NEXT = {"done": set(), "cancelled": set(), "failed": {"open"}}
UNFINISHED = ("open", "claimed", "waiting", "stalled", "submitted")
MAX_RETURNS = 3   # a reviewer may send work back this many times; then the goal fails rather than loop
MAX_ATTEMPTS = 3
MAX_DEPTH = 4
MAX_CHILDREN = 12
MAX_BINDING_BYTES = 16 * 1024
MAX_RESULT_DATA_BYTES = 256 * 1024
BINDING_KEYS = ("request_id", "base_revision", "snapshot_digest")


def binding_digest(binding):
    """A stable digest of a goal's binding, so a proposal can prove which request it answers."""
    return "sha256:" + hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _later(minutes):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


REVIEWS_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_reviews (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at TEXT NOT NULL,
  by TEXT NOT NULL, action TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', result_digest TEXT)"""
ATTEMPTS_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  at TEXT NOT NULL, ok INTEGER NOT NULL, errors TEXT NOT NULL, raw TEXT NOT NULL, digest TEXT NOT NULL)"""


class Goals:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.db.execute(ATTEMPTS_SCHEMA)
        self.db.execute(REVIEWS_SCHEMA)
        self.db.execute("CREATE INDEX IF NOT EXISTS goal_attempts_goal ON goal_attempts(goal_id, at)")

    # ---- result schemas: the shape a result must have before the goal is done (hive/core/result_schema.py) ----

    def result_schema(self, goal):
        """The goal's own binding.result_schema, else its request's constraints.result_schema, else None."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        if isinstance(binding.get("result_schema"), dict):
            return binding["result_schema"]
        if binding.get("request_id"):
            req = self.db.one("SELECT constraints FROM requests WHERE id = ?", (binding["request_id"],))
            constraints = json.loads(req["constraints"]) if req and req.get("constraints") else {}
            if isinstance(constraints.get("result_schema"), dict):
                return constraints["result_schema"]
        return None

    def attempts(self, goal_id):
        self.get(goal_id)
        rows = self.db.all("SELECT * FROM goal_attempts WHERE goal_id = ? ORDER BY at, rowid", (goal_id,))
        return [{**r, "ok": bool(r["ok"]), "errors": json.loads(r["errors"])} for r in rows]

    def _record_attempt(self, goal_id, agent_id, raw, errors):
        text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False, sort_keys=True)
        self.db.insert("goal_attempts", {"id": new_id("ga"), "goal_id": goal_id, "agent_id": agent_id, "at": now(),
                                         "ok": int(not errors), "errors": json.dumps(errors), "raw": text[:MAX_RESULT_DATA_BYTES],
                                         "digest": "sha256:" + hashlib.sha256(text.encode()).hexdigest()})

    def _check_result(self, goal, agent, data):
        """With a result schema, refuse a done result of the wrong shape (the goal stays claimed for repair)."""
        schema = self.result_schema(goal)
        data = data or {}
        if schema is None:
            if "proposal_text" in data:   # no schema: unparseable text is kept as text, as before
                data = {**{k: v for k, v in data.items() if k not in ("proposal_text", "parse_error")}, "proposal": {"text": data["proposal_text"]}}
            return data
        if "proposal_text" in data:
            raw, errors = data["proposal_text"], [f"$: not valid JSON ({data.get('parse_error') or 'could not parse'}); send the result as one JSON object"]
        elif "proposal" in data:
            raw = data["proposal"]
            errors = validate_result(raw, schema)
            if errors and isinstance(raw, dict) and set(raw) == {"text"} and "text" not in (schema.get("properties") or {}):
                errors.insert(0, "$: your result was plain text, not JSON; send one JSON object that fits the schema")
        else:
            raw, errors = data, ["$: no result object; finish with hive-goal-propose <task id> <JSON result>"]
        self._record_attempt(goal["id"], agent["id"], raw, errors)
        if errors:
            raise self.hive.error(422, "result_invalid",
                                  f"result does not fit this task's result schema ({len(errors)} problem(s)): " + "; ".join(errors)
                                  + ". The task is still yours: fix these and propose again.", {"errors": errors})
        return {k: v for k, v in data.items() if k != "parse_error"}

    # ---- R17: an app's own rule check, then a reviewer marks it done ------------------------------------

    def _bound(self, goal, key):
        """A goal's own binding[key], else its request's constraints[key]."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        if key in binding:
            return binding[key]
        if binding.get("request_id"):
            req = self.db.one("SELECT constraints, kind FROM requests WHERE id = ?", (binding["request_id"],))
            constraints = json.loads(req["constraints"]) if req and req.get("constraints") else {}
            if key in constraints:
                return constraints[key]
        return None

    def validator(self, goal):
        v = self._bound(goal, "validate")
        return v if isinstance(v, str) and v.startswith("program:") else None

    def review_spec(self, goal):
        """Who must accept this goal's result: none | requester | person | agent:<id> | mandate:<id>.
        Cross-swarm requests default to the requester (review requests finish through their own receipts)."""
        spec = self._bound(goal, "review")
        if isinstance(spec, dict):
            spec = spec.get("by")
        if spec in (None, ""):
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            # only a real cross-swarm request (the hive wrote from_swarm into its binding), never an app's own request ids
            real = binding.get("from_swarm") and binding.get("request_id") and self.db.one("SELECT 1 FROM requests WHERE id = ?", (binding["request_id"],))
            return "requester" if real and binding.get("kind") != "review" else "none"
        spec = str(spec)
        if spec in ("none", "requester", "person") or spec.startswith(("agent:a_", "mandate:")):
            return spec
        return "person"   # an unknown spec never means "no review"

    async def _run_validator(self, goal, agent, raw):
        target = self.validator(goal)
        if not target:
            return []
        try:
            out = self.hive.programs.validate_goal_result(target[8:], self.view(goal), raw)
            if inspect.isawaitable(out):   # an app's validate_result may be async (r2.9)
                out = await out
        except Exception as exc:   # a missing or failing validator refuses completion; nothing private leaks
            return [f"$: the result could not be checked by {target} ({getattr(exc, 'message', type(exc).__name__)}); try again later"]
        return out

    def _record_review(self, goal_id, by, action, notes="", result_digest=None):
        self.db.insert("goal_reviews", {"id": new_id("gr"), "goal_id": goal_id, "at": now(), "by": by, "action": action,
                                        "notes": str(notes or "")[:4000], "result_digest": result_digest})

    def _notify_reviewer(self, goal):
        """Tell the reviewer that work is waiting (a named mind, or the requesting mind); people see it on the board."""
        spec = self.review_spec(goal)
        target = None
        if spec.startswith("agent:"):
            target = spec[6:]
        elif spec == "requester":
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            req = self.db.one("SELECT from_principal FROM requests WHERE id = ?", (binding.get("request_id"),)) if binding.get("request_id") else None
            if req and str(req["from_principal"]).startswith("agent:"):
                target = req["from_principal"][6:]
        if not target:
            return
        note = (f"[REVIEW-WAITING {goal['id']}] {goal['title']}: submitted for your review. Read it with hive-goal-get {goal['id']}, "
                f"then hive-goal-review {goal['id']} accept|return \"notes\". You may never review your own work.")
        try:
            import asyncio
            asyncio.get_running_loop().create_task(self.hive.send_to_agent(target, note, sender="hive:goals",
                                                                          extra={"event": "review_waiting", "goal_id": goal["id"]}))
        except RuntimeError:
            pass

    def reviews(self, goal_id):
        self.get(goal_id)
        return self.db.all("SELECT * FROM goal_reviews WHERE goal_id = ? ORDER BY at, rowid", (goal_id,))

    def may_review(self, goal, reviewer):
        """reviewer: {"kind": "agent", "agent": row} or {"kind": "person", "principal", "admin"}. Returns (ok, why)."""
        spec = self.review_spec(goal)
        if spec == "none":
            return False, "this task does not take a review"
        if reviewer["kind"] == "agent" and reviewer["agent"]["id"] == goal["claimed_by"]:
            return False, "the author cannot review its own work"
        if reviewer["kind"] == "person":
            if reviewer.get("admin"):
                return True, "admin person"
            return (spec == "person", "a named person reviews this task" if spec == "person" else f"this task is reviewed by {spec}")
        agent = reviewer["agent"]
        if spec == f"agent:{agent['id']}":
            return True, "named reviewer"
        if spec.startswith("mandate:"):
            role = self.db.one("SELECT mandate FROM roles WHERE id = ?", (agent.get("role_id"),)) if agent.get("role_id") else None
            mandate = json.loads(role["mandate"]) if role and role.get("mandate") else None
            return (bool(mandate) and mandate.get("id") == spec[8:], f"needs a mind holding the {spec[8:]} mandate")
        if spec == "requester":
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            return (agent.get("swarm_id") == binding.get("from_swarm"), "a mind of the requesting swarm reviews this task")
        return False, f"this task is reviewed by {spec}"

    async def review(self, goal_id, reviewer, decision, notes=""):
        """Accept a submitted result (the goal is done) or return it with notes (back to the same mind)."""
        goal = self.get(goal_id)
        if goal["status"] != "submitted":
            raise self.hive.error(409, "not_submitted", f"task is {goal['status']}, not waiting for review")
        ok, why = self.may_review(goal, reviewer)
        if not ok:
            raise self.hive.error(403, "not_reviewer", why)
        by = f"agent:{reviewer['agent']['id']}" if reviewer["kind"] == "agent" else reviewer["principal"]
        digest = "sha256:" + hashlib.sha256((goal.get("result_data") or goal.get("result") or "").encode()).hexdigest()
        if decision == "accept":
            self.db.update("goals", goal_id, {"status": "done", "reviewed_by": by, "reviewed_at": now(), "updated_at": now()})
            self._record_review(goal_id, by, "accept", notes, digest)
            out = self._emit(goal_id)
            await self.notify_parent(out)
            return out
        if decision != "return":
            raise self.hive.error(400, "bad_request", "decision is accept or return")
        if not str(notes or "").strip():
            raise self.hive.error(400, "bad_request", "say what to change when returning work")
        returns = int(goal.get("returns") or 0) + 1
        self._record_review(goal_id, by, "return", notes, digest)
        if returns >= MAX_RETURNS:
            self.db.update("goals", goal_id, {"status": "failed", "returns": returns, "review_notes": str(notes)[:4000], "updated_at": now(),
                                              "result": f"returned {returns} times by its reviewer; last notes: {str(notes)[:300]}"})
            return self._emit(goal_id)
        # Back to its holder only while the holder is a live mind, judged in the write itself (stand-in r3): a holder
        # deleted between the read and this write never gets the work back; it reopens, unclaimed, for another mind.
        back = self.db.execute(
            "UPDATE goals SET status = 'claimed', returns = ?, review_notes = ?, lease_until = ?, updated_at = ? "
            "WHERE id = ? AND status = 'submitted' AND claimed_by IS ? AND claimed_by IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM agents WHERE id = goals.claimed_by AND deleted = 0)",
            (returns, str(notes)[:4000], _later(self.hive.settings.goal_lease_minutes), now(), goal_id, goal["claimed_by"]))
        if back.rowcount != 1:
            opened = self.db.execute(
                "UPDATE goals SET status = 'open', claimed_by = NULL, assignee = NULL, lease_until = NULL, returns = ?, "
                "review_notes = ?, updated_at = ? WHERE id = ? AND status = 'submitted'",
                (returns, str(notes)[:4000], now(), goal_id))
            if opened.rowcount != 1:
                raise self.hive.error(409, "goal_changed", "this task changed while it was being reviewed; read it again")
            reopened = self._emit(goal_id)
            await self.announce(reopened)
            return reopened
        if goal["claimed_by"]:
            await self.hive.send_to_agent(goal["claimed_by"], f"[GOAL-RETURNED {goal_id}] {goal['title']}: your reviewer sent it back "
                                          f"({returns} of {MAX_RETURNS - 1} returns). Their notes: {str(notes)[:1500]}. Fix this and propose again.",
                                          sender="hive:goals", extra={"event": "goal_returned", "goal_id": goal_id})
        return self._emit(goal_id)

    def get(self, goal_id):
        row = self.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no task {goal_id}")
        return row

    @staticmethod
    def view(row):
        out = dict(row)
        for key in ("binding", "result_data"):
            out[key] = json.loads(row[key]) if row.get(key) else None
        out["binding_digest"] = binding_digest(out["binding"]) if out["binding"] else None
        return out

    def view_full(self, row):
        out = self.view(row)
        out["review_by"] = self.review_spec(row)
        out["validate"] = self.validator(row)
        return out

    def list(self, swarm_id, status=None):
        sql, params = "SELECT * FROM goals WHERE swarm_id = ?", [swarm_id]
        if status:
            sql += " AND status = ?"
            params.append(status)
        # review_by on list rows and goal.updated events too, so a board can show "awaiting review" (Surface audit 8)
        return [{**self.view(r), "review_by": self.review_spec(r)}
                for r in self.db.all(sql + " ORDER BY priority DESC, created_at", params)]

    def for_agent(self, agent, goal_id):
        goal = self.get(goal_id)
        if goal["swarm_id"] != agent["swarm_id"] and not (goal["status"] == "submitted" and self.may_review(goal, {"kind": "agent", "agent": agent})[0]):
            raise self.hive.error(403, "forbidden", "task is in another swarm")
        return {**self.view_full(goal), "result_schema": self.result_schema(goal)}

    def depth(self, goal):
        depth = 0
        while goal["parent_id"] and depth < MAX_DEPTH + 1:
            goal = self.get(goal["parent_id"])
            depth += 1
        return depth

    def _emit(self, goal_id):
        row = self.get(goal_id)
        goal = {**self.view(row), "review_by": self.review_spec(row)}
        self.hive.events.publish("goal.updated", goal=goal)
        return goal

    async def create(self, swarm_id, title, detail="", priority=0.5, parent_id=None, created_by="user:operator",
                     assignee=None, binding=None, deadline_minutes=None):
        goal = self._create_record(swarm_id, title, detail, priority, parent_id, created_by,
                                   assignee, binding, deadline_minutes)
        await self.announce(goal)
        return goal

    def _create_record(self, swarm_id, title, detail="", priority=0.5, parent_id=None, created_by="user:operator",
                     assignee=None, binding=None, deadline_minutes=None, *, goal_id=None, emit=True):
        self.hive.swarm(swarm_id)
        self.hive.require_open_swarm(swarm_id)
        if not str(title).strip():
            raise self.hive.error(400, "bad_request", "title is required")
        assignee_id = None
        if assignee:
            rows = self.db.all("SELECT id, name FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,))
            match = [r for r in rows if r["id"] == assignee] or [r for r in rows if r["name"].lower() == str(assignee).lower()]
            if not match:
                raise self.hive.error(404, "not_found", f"no mind {assignee!r} in this swarm to assign")
            assignee_id = match[0]["id"]
        if binding is not None:
            if not isinstance(binding, dict):
                raise self.hive.error(400, "bad_request", "binding must be an object")
            if len(json.dumps(binding)) > MAX_BINDING_BYTES:
                raise self.hive.error(413, "too_large", "a binding is limited to 16 KB")
            if "result_schema" in binding:
                try:
                    check_schema(binding["result_schema"])
                except SchemaError as exc:
                    raise self.hive.error(400, "bad_result_schema", str(exc))
        if parent_id:
            parent = self.get(parent_id)
            if parent["swarm_id"] != swarm_id:
                raise self.hive.error(400, "bad_request", "parent task is in another swarm")
            author = created_by.removeprefix("agent:")
            if created_by.startswith("agent:") and parent["claimed_by"] != author:
                raise self.hive.error(403, "forbidden", "only the mind that claimed a task can split it")
            if self.depth(parent) + 1 >= MAX_DEPTH:
                raise self.hive.error(400, "too_deep", f"tasks can be split at most {MAX_DEPTH - 1} levels deep")
            children = self.db.one("SELECT COUNT(*) AS n FROM goals WHERE parent_id = ?", (parent_id,))["n"]
            if children >= MAX_CHILDREN:
                raise self.hive.error(400, "too_many_subgoals", f"a task can have at most {MAX_CHILDREN} subtasks")
        stamp = now()
        row = {"id": goal_id or new_id("g"), "swarm_id": swarm_id, "parent_id": parent_id or None,
               "title": str(title).strip()[:300], "detail": str(detail or "")[:4000],
               "priority": max(0.0, min(1.0, float(priority if priority is not None else 0.5))),
               "status": "open", "created_by": created_by, "claimed_by": None, "result": None,
               "assignee": assignee_id, "binding": json.dumps(binding) if binding is not None else None,
               "deadline_at": _later(float(deadline_minutes)) if deadline_minutes else None,
               "created_at": stamp, "updated_at": stamp}
        if parent_id:
            # Admission and cancellation on another DB connection serialize at
            # the INSERT: a stale held-parent check never creates late children.
            cols=", ".join(row);marks=", ".join("?" for _ in row)
            guard="id=? AND status IN ('open','claimed','waiting')"
            args=[parent_id]
            if created_by.startswith("agent:"):
                guard+=" AND claimed_by=? AND status IN ('claimed','waiting')"
                args.append(created_by[6:])
            with self.hive.swarm_membership(swarm_id):   # fenced while its swarm is deleted or restored
                inserted=self.db.execute(f"INSERT INTO goals ({cols}) SELECT {marks} WHERE EXISTS (SELECT 1 FROM goals WHERE {guard}) AND {self.hive.OPEN_SWARM_SQL}",(*row.values(),*args,swarm_id))
            if inserted.rowcount!=1:
                self.hive.require_open_swarm(swarm_id)   # an archived swarm says so, rather than blaming the parent
                raise self.hive.error(409,"parent_inactive","the parent no longer admits subtasks")
        else:
            self.hive.insert_into_open_swarm("goals", row, swarm_id)   # atomic with archive (OmegaReview)
        return self._emit(row["id"]) if emit else self.view(self.get(row["id"]))

    async def announce(self, goal):
        """Tell the swarm's awake members (or only the assignee, awake or not), except whoever posted it. A Studio
        session's goal is never announced (J3 plan r1.1 S6.1): its step message is the maker's only prompt."""
        binding = goal.get("binding")
        if isinstance(binding, str):
            try:
                binding = json.loads(binding)
            except ValueError:
                binding = None
        if isinstance(binding, dict) and binding.get("kind") == "studio.session":
            return
        author = goal["created_by"].removeprefix("agent:")
        envelope_text = (f"New goal {goal['id']} (priority {goal['priority']:.2f}): {goal['title']}"
                         + (f" - {goal['detail']}" if goal["detail"] else ""))
        if goal.get("assignee"):
            envelope_text = (f"Assigned to you: {envelope_text}. Read it with hive-goal-get {goal['id']}, claim it with "
                             f"hive-goal-claim {goal['id']}, and finish with hive-goal-propose {goal['id']} {{json}} or "
                             f"hive-goal-done {goal['id']} <what was done>.")
        for member in self.db.all("SELECT id, status, kind FROM agents WHERE swarm_id = ? AND deleted = 0",
                                  (goal["swarm_id"],)):
            if goal.get("assignee") and member["id"] != goal["assignee"]:
                continue
            if member["id"] == author:
                continue
            # An assignee always hears about its goal, even while stopped: the message waits in its inbox, so a
            # mind started later still learns it holds the goal (found 2026-10-03: a stopped Scientist never did).
            if not goal.get("assignee") and member["kind"] != "module" and member["status"] not in ("awake", "starting"):
                continue
            await self.hive.send_to_agent(member["id"], envelope_text, sender="hive:goals",
                                          extra={"event": "goal", "goal_id": goal["id"]})

    def update(self, goal_id, changes):
        goal = self.get(goal_id)
        values = {}
        if "status" in changes:
            if goal["status"] == "submitted" and changes["status"] == "done":
                raise self.hive.error(409, "needs_review", "this result is waiting for its reviewer: accept or return it with a review")
            if changes["status"] not in STATUSES:
                raise self.hive.error(400, "bad_request", f"status must be one of {sorted(STATUSES)}")
            if changes["status"] != goal["status"] and changes["status"] not in TERMINAL_NEXT.get(goal["status"], STATUSES):
                raise self.hive.error(409, "goal_closed", f"this task is {goal['status']}; it cannot be moved to {changes['status']}")
            values["status"] = changes["status"]
            if changes["status"] == "open":
                # Re-opening (e.g. a stalled goal) is a fresh start: no holder, no lapses.
                values.update(claimed_by=None, lease_until=None, attempts=0)
        if "priority" in changes:
            values["priority"] = max(0.0, min(1.0, float(changes["priority"])))
        for key in ("title", "detail"):
            if key in changes:
                values[key] = str(changes[key])
        if values:
            values["updated_at"] = now()
            self.db.update("goals", goal["id"], values)
        return self._emit(goal_id)

    async def notify_cancelled(self, goal_id):
        """Tell whoever holds (or was assigned) a cancelled goal, so it stops and acknowledges."""
        goal = self.get(goal_id)
        if goal["status"] != "cancelled":
            return
        await self._close_bound(goal, "GOAL-CANCELLED", "goal_cancelled")

    async def _close_bound(self, goal, tag, event):
        """Revoke a bound goal's snapshot shares and tell its holder or assignee to stop."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        for share_id in binding.get("share_ids") or []:
            try:
                await self.hive.shares.revoke(share_id)   # the snapshot stops being readable
            except Exception as exc:  # already closed shares are fine
                if getattr(exc, "status", None) not in (404, 409):
                    raise
        for agent_id in {goal["claimed_by"], goal.get("assignee")} - {None}:
            await self.hive.send_to_agent(agent_id, f"[{tag} {goal['id']}] {goal['title']} - stop and "
                                                    f"acknowledge with cancel-ack", sender="hive:goals",
                                          extra={"event": event, "goal_id": goal["id"]})

    def cancel_ack(self, agent, goal_id):
        goal = self.get(goal_id)
        expired = goal["status"] == "failed" and goal.get("deadline_at") and goal["deadline_at"] < now()
        if goal["status"] != "cancelled" and not expired:
            raise self.hive.error(409, "not_cancelled", f"task is {goal['status']}")
        if agent["id"] not in (goal["claimed_by"], goal.get("assignee")):
            raise self.hive.error(403, "forbidden", "only the holder or assignee acknowledges a cancellation")
        if not goal.get("cancel_ack_at"):
            self.db.update("goals", goal_id, {"cancel_ack_at": now(), "cancel_ack_by": agent["id"]})
        return self._emit(goal_id)

    def claim(self, agent, goal_id):
        if getattr(self.hive, "newhive", None) is not None:   # new-hive R1a: unclassified work holds before readiness
            self.hive.newhive.require_coding("goal_claim")
        goal = self.get(goal_id)
        if goal["swarm_id"] != agent["swarm_id"]:
            raise self.hive.error(403, "forbidden", "task is in another swarm")
        if goal.get("assignee") and goal["assignee"] != agent["id"]:
            raise self.hive.error(403, "not_assigned", "this task is assigned to another mind")
        # One conditional UPDATE, so two minds claiming at once cannot both win.
        # ...and only by a live mind, in the same statement (stand-in r3): a claim authenticated before its mind's delete
        # cannot land after the release that delete made.
        cursor = self.db.execute(
            "UPDATE goals SET status = 'claimed', claimed_by = ?, lease_until = ?, attempts = attempts + 1, "
            "updated_at = ? WHERE id = ? AND status = 'open' "
            "AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted = 0)",
            (agent["id"], _later(self.hive.settings.goal_lease_minutes), now(), goal_id, agent["id"]))
        if cursor.rowcount != 1:
            if not self.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (agent["id"],)):
                raise self.hive.error(409, "mind_deleted", "this mind was deleted; it cannot claim work")
            goal = self.get(goal_id)
            if goal["claimed_by"] == agent["id"] and goal["status"] in ("claimed", "waiting"):
                return self.heartbeat(agent, goal_id)  # claiming a goal you already hold renews it
            raise self.hive.error(409, "not_open", f"task is {goal['status']}"
                                  + (f" by {goal['claimed_by']}" if goal["claimed_by"] else ""))
        self.hive.mark_input(agent["id"])   # a claim is real input to the idle signal (spend never is)
        return self._emit(goal_id)

    def heartbeat(self, agent, goal_id):
        """Renew the claimer's lease; also resumes a goal that was waiting on a person."""
        goal = self.get(goal_id)
        if goal["claimed_by"] != agent["id"] or goal["status"] not in ("claimed", "waiting"):
            raise self.hive.error(409, "not_claimed", "you do not hold this task")
        lease = _later(self.hive.settings.goal_lease_minutes)
        if goal.get("deadline_at"):
            # a heartbeat never outlives the hard deadline: past it the goal is expired, not renewable
            if goal["deadline_at"] <= now():
                raise self.hive.error(409, "goal_expired", "this task's deadline has passed")
            lease = min(lease, goal["deadline_at"])
        # Only while nothing changed since the read and the holder is a live mind, in the same statement (stand-in r4):
        # a heartbeat racing a delete's release can never put the task back to claimed with no holder.
        cur = self.db.execute(
            "UPDATE goals SET status = 'claimed', updated_at = ?, lease_until = ? WHERE id = ? AND status = ? "
            "AND claimed_by IS ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted = 0)",
            (now(), lease, goal_id, goal["status"], agent["id"], agent["id"]))
        if cur.rowcount != 1:   # released, reassigned or its mind deleted meanwhile: as if the lease had lapsed
            raise self.hive.error(409, "not_claimed", "you do not hold this task")
        self.hive.mark_input(agent["id"])   # the holder saying it is still on owed work
        return self._emit(goal_id)

    async def result(self, agent, goal_id, status, result, data=None, trusted_review=False, top_digest=None, strict_binding=False):
        goal = self.get(goal_id)
        if goal["status"] == "cancelled":
            raise self.hive.error(409, "goal_cancelled", "this task was cancelled; acknowledge with cancel-ack")
        if goal.get("deadline_at") and goal["deadline_at"] < now() and goal["status"] not in ("done", "failed"):
            raise self.hive.error(409, "goal_expired", "this task's deadline has passed")
        if goal["claimed_by"] != agent["id"]:
            raise self.hive.error(403, "forbidden", "only the mind that claimed a task can finish it")
        if data is not None:
            if not isinstance(data, dict):
                raise self.hive.error(400, "bad_request", "data must be an object")
            if len(json.dumps(data)) > MAX_RESULT_DATA_BYTES:
                raise self.hive.error(413, "too_large", "result data is limited to 256 KB")
        if goal.get("binding"):
            binding = json.loads(goal["binding"])
            if binding.get("kind") == "review" and status == "done" and not trusted_review:
                # a review is finished only through its structured receipt, never a generic "done"
                raise self.hive.error(409, "review_needs_receipt", "finish a review with hive-review-complete "
                                      "(its findings, recommendation and rationale); a plain done is not a review")
            echoed = (data or {}).get("binding")
            expected = binding_digest(binding)
            if strict_binding and status == "done" and top_digest != expected:
                # the MCP bridge: the digest is mandatory, top-level and exact on a bound goal
                raise self.hive.error(409, "binding_mismatch", "a result for a bound task must carry its binding_digest exactly")
            if status == "done" and not strict_binding and echoed != binding and (data or {}).get("binding_digest") != expected and top_digest != expected:
                raise self.hive.error(409, "binding_mismatch",
                                      "a result for a bound task must echo its binding (or binding_digest) exactly")
        elif strict_binding and top_digest is not None and status == "done":
            raise self.hive.error(409, "binding_mismatch", "this task has no binding, so a binding_digest does not apply")
        text_in = str(result or "").strip()
        if goal["status"] in ("done", "failed") and goal["status"] == status and len(text_in) <= 4000 \
                and (goal.get("result") or "") == text_in \
                and (json.loads(goal["result_data"]) if goal.get("result_data") else None) == data:
            return self.view(goal)   # an identical retry (e.g. after a lost response) is accepted once more
        if goal["status"] not in ("claimed", "waiting"):
            raise self.hive.error(409, "not_claimed", f"task is {goal['status']}")
        if status not in ("done", "failed", "waiting"):
            raise self.hive.error(400, "bad_request", "status must be done, failed or waiting")
        text = str(result or "").strip()
        if status == "done" and not text:
            raise self.hive.error(400, "no_result", "say what was done: a task is not done without a result")
        submit = False
        read_guards = ()
        if status == "done" and not trusted_review:
            data = self._check_result(goal, agent, data)
            raw = (data or {}).get("proposal", data)
            problems = await self._run_validator(goal, agent, raw)
            read_guards = getattr(problems, "read_guards", ())
            if problems:
                self._record_attempt(goal["id"], agent["id"], raw, problems)
                raise self.hive.error(422, "result_invalid", f"result refused by {self.validator(goal)} ({len(problems)} problem(s)): "
                                      + "; ".join(problems[:12]) + ". The task is still yours: fix these and propose again.",
                                      {"errors": problems[:12]})
            submit = self.review_spec(goal) != "none"
        elif status == "done" and trusted_review:
            # a review receipt is admitted on the trusted path, but if the request names a reviewer of the review
            # (e.g. OmegaReview's QC mind) it still goes to that reviewer first (bypass found by OmegaReview)
            explicit = self._bound(goal, "review")
            submit = explicit not in (None, "", "none") and self.review_spec(goal) != "none"
        values = {"status": "submitted" if submit else status, "result": text[:4000], "updated_at": now()}
        if submit:
            values.update(submitted_at=now(), lease_until=None)
        if data is not None:
            values["result_data"] = json.dumps(data)
        if status == "waiting":
            values["lease_until"] = None
        # Save only if nothing changed the goal while its result was being checked (a cancel or re-open during a slow
        # app validator must win, not be overwritten; race found by OmegaMatch).
        sets = ", ".join(f"{k} = ?" for k in values)
        sql = f"UPDATE goals SET {sets} WHERE id = ? AND status = ? AND claimed_by IS ? AND updated_at = ?"
        params = (*values.values(), goal_id, goal["status"], goal["claimed_by"], goal["updated_at"])
        cur = self.db.guarded_execute(sql, params, read_guards) if read_guards else self.db.execute(sql, params)
        if cur is None:
            raise self.hive.error(409, "validation_context_changed", "the stored review context changed while this result was checked; read it again and propose again")
        if cur.rowcount != 1:
            raise self.hive.error(409, "goal_changed", "this task changed while your result was being checked "
                                  "(cancelled, re-opened or reassigned); read it again before doing anything else")
        if submit:
            # every submission for review is kept whole, so a return-and-resubmit never loses what was first submitted
            # (the schema gate already records its attempts; trusted receipts and unschema'd results did not; found by OmegaReview)
            if trusted_review or self.result_schema(goal) is None:
                self._record_attempt(goal_id, agent["id"], {"result": text, "data": data}, [])
            self._record_review(goal_id, f"agent:{agent['id']}", "submit", "", "sha256:" + hashlib.sha256(text.encode()).hexdigest())
            self._notify_reviewer(goal)
        self.hive.mark_input(agent["id"])   # a result is meaningful output
        return self._emit(goal_id)

    def release_rows(self, agent_id, by, why):
        """A deleted mind's unfinished work, released in the caller's transaction (its soft delete); events after commit.
        open / claimed / waiting / stalled where it is assignee or holder: back to open, unassigned and unclaimed, and
        nothing else (attempts and returns stay). submitted: the submission and its history stay pending review and
        only the dead assignee is cleared; a return then reopens it (see review), never to the deleted mind. Each change
        is conditional on the row read and is noted on the task's review trail. Returns the changed task ids."""
        changed = []
        for goal in self.db.all("SELECT * FROM goals WHERE (assignee = ? OR claimed_by = ?) "
                                "AND status IN ('open', 'claimed', 'waiting', 'stalled', 'submitted')", (agent_id, agent_id)):
            if goal["status"] == "submitted":
                if goal.get("assignee") != agent_id:
                    continue   # the submitter's own record stays; a return reopens it
                sets, note = "assignee = NULL", why + "; the submission stays for review"
            else:
                # only what makes it claimable: attempts, returns, results and reviews stay as history (Kimi K4)
                sets = "status = 'open', assignee = NULL, claimed_by = NULL, lease_until = NULL"
                note = why
            cur = self.db.execute(f"UPDATE goals SET {sets}, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?",
                                  (now(), goal["id"], goal["status"], goal["updated_at"]))
            if cur.rowcount == 1:
                self._record_review(goal["id"], by, "released", note)
                changed.append(goal["id"])
        return changed

    async def expire(self, moment=None):
        """Release claims whose lease lapsed; stall goals that keep lapsing."""
        moment = moment or now()
        released = []
        # A deadline is a hard time budget: past it the goal fails, its snapshot shares are revoked and the
        # holder is told, whatever state it is in.
        for goal in self.db.all("SELECT * FROM goals WHERE deadline_at IS NOT NULL AND deadline_at < ? "
                                "AND status IN ('open', 'claimed', 'waiting', 'stalled')", (moment,)):
            self.db.update("goals", goal["id"], {"status": "failed", "lease_until": None, "updated_at": now(),
                                                 "result": "deadline passed before a result arrived"})
            await self._close_bound(goal, "GOAL-EXPIRED", "goal_expired")
            self._emit(goal["id"])
            released.append(goal["id"])
        for goal in self.db.all("SELECT * FROM goals WHERE status = 'claimed' AND lease_until IS NOT NULL "
                                "AND lease_until < ?", (moment,)):
            if goal["attempts"] >= MAX_ATTEMPTS:
                self.db.update("goals", goal["id"], {"status": "stalled", "lease_until": None, "updated_at": now(),
                                                     "result": f"stalled: {goal['attempts']} claims lapsed "
                                                               f"without a result (last {goal['claimed_by']})"})
                self._emit(goal["id"])
            else:
                self.db.update("goals", goal["id"], {"status": "open", "claimed_by": None, "lease_until": None,
                                                     "updated_at": now()})
                await self.announce(self._emit(goal["id"]))
            released.append(goal["id"])
        return released

    async def notify_parent(self, goal):
        """When the last subgoal finishes, tell whoever holds the parent, with the results."""
        if not goal["parent_id"]:
            return
        parent = self.get(goal["parent_id"])
        children = self.db.all("SELECT * FROM goals WHERE parent_id = ?", (parent["id"],))
        if parent["status"] != "claimed" or any(c["status"] in UNFINISHED for c in children):
            return
        summary = "; ".join(f"{c['title']}: {c['status']} - {c['result'] or ''}".strip(" -") for c in children)
        await self.hive.send_to_agent(parent["claimed_by"], f"[SUBGOALS-DONE {parent['id']}] {summary}",
                                      sender="hive:goals", extra={"event": "subgoals_done", "goal_id": parent["id"]})

    @staticmethod
    def dumps(value):
        return json.dumps(value)
