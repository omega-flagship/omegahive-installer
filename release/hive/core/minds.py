"""Mind control, phase one: a team's controller runs child minds for one request (seam contracts r2.12, r2.12.1,
r2.13 and r2.13.1, coordination/omegacode/, 2026-10-05).

- A person's instruction (POST /api/requests, a named signed-in admin) becomes a request in the team swarm with its own
  budget root, and a lease that same person issues in the same transaction: controller = the team's coordinator, scope
  = that request, the templates and child count it admits, until its deadline. No grant is upgraded into this authority.
- The controller (the team swarm's coordinator, or the mind the team swarm hangs under) spawns children from
  operator-registered templates, reserving each child's allocation from the request root in one conditional write with
  the child row, prompt revision 1 and the archived-swarm condition. The child's own hard cap is its allocation, so
  every model call it makes is held against it by the existing per-call reservations.
- Gaining or using authority (spawn, prompt, resume) needs a live lease and an open request; reading and cleanup
  (status, interrupt, pause, stop, retire) need only identity. People who may clean up: an admin person, or the person
  who issued the request's lease.
- Delivery is accepted, pending, delivered (the hub sent the frame), acknowledged (the child's own hub ack names the
  revision). Only acknowledged proves receipt. A stop is a request until the process end is observed; an observation
  timeout is unknown, never stopped. A child is never restarted by the host: one whose runtime cannot be confirmed is
  recovery_needed.
- Every write carries an operation_id, scoped to its caller. Only a success is recorded; a retry with the same
  canonical payload returns the original status and body byte for byte; the same id with another payload is 409.
- Live spawning and resume stay off unless the operator sets HIVE_MIND_SPAWN=1 (Settings.mind_spawn).
- A delegated Code capability (r2.13.1) is host-issued to a child, read/search/suggest only, on the origin task; its live
  status re-checks child, request, lease, the issuer's origin grant and the origin task on every use.
- A copy_apply capability (linkage slice 3, PLATFORM_COPY_APPLY_AUTHORITY_ANSWER_20261007 §2) is host-issued to the
  request's controller, proposal-apply only, never a run grant, bound to one retained proposal; off unless
  HIVE_COPY_APPLY_CLAIMS=on. Its live status re-checks controller, request, lease and the issuer's edit origin grant.
- Copy-apply consent (r1): the capability is issued only against the request's own person's single-use consent for that
  exact proposal (suggestion id + digest), request binding (request, lease, controller, issuer, origin) and expiry. The
  person gives it by POST /api/requests/{rq}/proposals/{suggestion}/accept after Accept + confirm; the controller's issue
  spends it in the same transaction as the capability. A new accept or a decline voids every earlier consent for that
  proposal and revokes every capability issued under one, atomically; each live-status call re-checks the consent (r3).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime
import hashlib
import hmac
import json
import logging
import math
import re
import secrets
import sqlite3
import time

from .db import latest_stamp, new_id, now, parse_stamp
from .limits_auto import dollars, to_micros

log = logging.getLogger("hive")

OPERATION = re.compile(r"[A-Za-z0-9_.:-]{8,120}")
TEMPLATE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,80}")
RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
MODES = ("deliver", "bounded", "ongoing")
CONTROLS = ("interrupt", "stop", "pause", "resume", "retire")
TEMPLATE_CONTROLS = set(CONTROLS) | {"steer"}
# Code decision 5 (2026-10-05): steer stays unavailable until the native child runtime's steer semantics are qualified;
# until then a template that lists it is refused at registration, so no child can be steered.
STEER_QUALIFIED = False
LIVE = ("starting", "running")
TERMINAL_GOAL = ("done", "failed", "cancelled")
PAGE = 100
CURSOR_SECONDS = 600
STOP_OBSERVE_SECONDS = 60
PROMPT_MAX_BYTES = 8192
CAPABILITY_SECONDS = 900
MAX_ALLOCATION_USD = 100.0
# copy-apply seam §2 check 6: Code's ids and digests, carried byte for byte and compared for equality only
SUGGESTION_ID = re.compile(r"suggestion_[0-9a-f]{32}")
WORKSPACE_ID = re.compile(r"ws_[0-9a-f]{32}")
BARE_DIGEST = re.compile(r"[0-9a-f]{64}")
REQUEST_ID = re.compile(r"rq_[A-Za-z0-9_-]{1,64}")
COPY_APPLY_SECONDS = 300
CONSENT_SECONDS = 600       # an accepted proposal's consent lives ten minutes, or until the controller spends it
OPEN_TASK = ("open", "claimed", "waiting")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS mind_leases (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, controller_id TEXT NOT NULL,
  team_id TEXT NOT NULL, template_ids TEXT NOT NULL, max_children INTEGER NOT NULL, ceiling_usd REAL NOT NULL,
  until TEXT NOT NULL, issued_by TEXT NOT NULL, grant_id TEXT, created_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT)""",
    """CREATE INDEX IF NOT EXISTS mind_leases_request ON mind_leases(request_id)""",
    """CREATE TABLE IF NOT EXISTS mind_children (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, controller_id TEXT NOT NULL,
  team_id TEXT NOT NULL, request_id TEXT NOT NULL, lease_id TEXT NOT NULL, template_id TEXT NOT NULL, model_id TEXT NOT NULL,
  lifecycle_mode TEXT NOT NULL, lifecycle_limits TEXT, state TEXT NOT NULL, paused_reason TEXT,
  recovery_needed INTEGER NOT NULL DEFAULT 0, prompt_rev INTEGER NOT NULL, stop_requested_at REAL, stopped_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS mind_reservations (id TEXT PRIMARY KEY, child_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,
  budget_root TEXT NOT NULL, allocated_usd REAL NOT NULL, released_usd REAL, released_at TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS mind_prompts (child_id TEXT NOT NULL, rev INTEGER NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL,
  delivery TEXT NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL, at TEXT NOT NULL, message_id TEXT,
  delivered_at TEXT, acknowledged_at TEXT, PRIMARY KEY (child_id, rev))""",
    """CREATE TABLE IF NOT EXISTS mind_controls (id TEXT PRIMARY KEY, child_id TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL,
  requested_at TEXT NOT NULL, observed TEXT)""",
    """CREATE TABLE IF NOT EXISTS mind_operations (scope TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
  status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (scope, operation_id))""",
    # slice 3: at most one live copy_apply binding per retained proposal; capability_id is its newest token's capability
    """CREATE TABLE IF NOT EXISTS copy_apply_bindings (request_id TEXT NOT NULL, suggestion_id TEXT NOT NULL,
  suggestion_digest TEXT NOT NULL, controller_id TEXT NOT NULL, operation_id TEXT NOT NULL, capability_id TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (request_id, suggestion_id, suggestion_digest))""",
    # copy-apply consent r1: the request's person accepts (or declines) one exact proposal; an accept is single use,
    # spent by the controller's issue_copy_apply in the same transaction as the capability it admits
    """CREATE TABLE IF NOT EXISTS copy_apply_consents (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, suggestion_id TEXT NOT NULL,
  suggestion_digest TEXT NOT NULL, decision TEXT NOT NULL, principal TEXT NOT NULL, controller_id TEXT NOT NULL,
  lease_id TEXT NOT NULL, binding_digest TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL,
  spent_at REAL, spent_by TEXT, capability_id TEXT, voided_at REAL)""",
    """CREATE INDEX IF NOT EXISTS copy_apply_consents_proposal ON copy_apply_consents(request_id, suggestion_id)""",
]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha(text):
    # surrogatepass: a malformed body still gets a digest, so its operation lookup happens and validation refuses it (400)
    return "sha256:" + hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def stamp(moment):
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    """RFC 3339 with an explicit offset or Z, as an aware datetime; None for anything else."""
    if not isinstance(value, str) or not RFC3339.fullmatch(value):
        return None
    try:
        return datetime.datetime.fromisoformat(value[:-1] + "+00:00" if value[-1] in "Zz" else value.replace("t", "T"))
    except ValueError:
        return None


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def _int(value, low, high):
    return type(value) is int and low <= value <= high


def utf8_size(value):
    """Bytes of value as UTF-8, or None when it is not a string or not encodable (a lone surrogate)."""
    try:
        return len(value.encode("utf-8")) if isinstance(value, str) else None
    except UnicodeEncodeError:
        return None


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


class Minds:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        self._secret = secrets.token_bytes(32)          # cursors last ten minutes; a hive restart simply expires them
        self.template_errors = []
        self.templates = self._load_templates(hive.settings.mind_templates)

    def err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    # ---- templates (operator-registered in the launcher) --------------------------------------------

    def _load_templates(self, raw):
        out = {}
        for entry in raw or []:
            try:
                t = self._template(entry)
            except (ValueError, TypeError, KeyError) as exc:
                self.template_errors.append(str(exc))
                log.error("mind template refused: %s", exc)
                continue
            if t["template_id"] in out:
                self.template_errors.append(f"duplicate template {t['template_id']}")
                continue
            out[t["template_id"]] = t
        return out

    @staticmethod
    def _template(e):
        if not isinstance(e, dict):
            raise ValueError("a template is an object")
        tid = e["template_id"]
        if not isinstance(tid, str) or not TEMPLATE_ID.fullmatch(tid):
            raise ValueError("template_id is 1-80 of [A-Za-z0-9_.:-]")
        if e.get("harness", "native") != "native":
            raise ValueError(f"{tid}: phase one runs native children only")
        model = e["model_id"]
        if not isinstance(model, str) or not model.strip():
            raise ValueError(f"{tid}: model_id is required")
        role = e.get("role_id")
        if role is not None and (not isinstance(role, str) or not role):
            raise ValueError(f"{tid}: role_id is a role id or null")
        ceiling = e["max_allocation_usd"]
        if not _number(ceiling) or type(ceiling) is bool or not 0 < ceiling <= MAX_ALLOCATION_USD:
            raise ValueError(f"{tid}: max_allocation_usd is more than 0 and at most {MAX_ALLOCATION_USD}")
        overrides = (e.get("overridable") or {}).get("model_id") or []
        if not isinstance(overrides, list) or not all(isinstance(m, str) and m for m in overrides):
            raise ValueError(f"{tid}: overridable.model_id is a list of model ids")
        controls = e.get("controls")
        if not isinstance(controls, list) or not set(controls) <= TEMPLATE_CONTROLS or not {"stop", "retire"} <= set(controls):
            raise ValueError(f"{tid}: controls are among {sorted(TEMPLATE_CONTROLS)} and always include stop and retire")
        if "steer" in controls and not STEER_QUALIFIED:
            raise ValueError(f"{tid}: steer is not yet qualified for native children; leave it out")
        modes = e.get("lifecycle_modes", list(MODES))
        if not isinstance(modes, list) or not modes or not set(modes) <= set(MODES):
            raise ValueError(f"{tid}: lifecycle_modes are among {list(MODES)}")
        teams = e.get("teams")
        if not isinstance(teams, list) or not teams or not all(isinstance(s, str) and s for s in teams):
            raise ValueError(f"{tid}: teams lists the swarms it is registered for")
        return {"template_id": tid, "harness": "native", "model_id": model, "role_id": role, "max_allocation_usd": float(ceiling),
                "overridable": {"model_id": sorted(set(overrides))}, "controls": [c for c in (*CONTROLS, "steer") if c in controls],
                "lifecycle_modes": [m for m in MODES if m in modes], "teams": sorted(set(teams))}

    @staticmethod
    def template_view(t):
        return {k: t[k] for k in ("template_id", "harness", "model_id", "role_id", "max_allocation_usd", "overridable",
                                  "controls", "lifecycle_modes")}

    def registered(self, team_id):
        return [t for t in self.templates.values() if team_id in t["teams"]]

    # ---- authority -------------------------------------------------------------------------------

    def _team(self, team_id):
        row = self.db.one("SELECT * FROM swarms WHERE id = ?", (str(team_id or ""),))
        if row is None:
            raise self.err(404, "not_found", f"no swarm {team_id}")
        return row

    def _member(self, agent_id, swarm_id=None):
        row = self.db.one("SELECT id, swarm_id FROM agents WHERE id = ? AND deleted = 0", (agent_id,)) if agent_id else None
        return bool(row) and (swarm_id is None or row["swarm_id"] == swarm_id)

    def controllers(self, team):
        """The team swarm's coordinator (a current member) and the mind the team swarm hangs under (holarchy)."""
        out = set()
        if team.get("coordinator_id") and self._member(team["coordinator_id"], team["id"]):
            out.add(team["coordinator_id"])
        if team.get("parent_mind_id") and self._member(team["parent_mind_id"]):
            out.add(team["parent_mind_id"])
        return out

    def _require_controller(self, agent, team_id):
        team = self._team(team_id)
        if agent["id"] not in self.controllers(team):
            raise self.err(403, "not_controller", "only the swarm's controller does this")
        return team

    def _admin_current(self, principal):
        if not isinstance(principal, str) or not principal.startswith("user:") or principal == "user:operator":
            return False
        person = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        return bool(person and person["role"] == "admin" and not person["disabled"])

    def lease_live(self, lease):
        return bool(lease) and not lease["ended_at"] and lease["until"] > now() and self._admin_current(lease["issued_by"])

    def _lease(self, lease_id):
        return self.db.one("SELECT * FROM mind_leases WHERE id = ?", (lease_id,))

    def request_open(self, req):
        if not req or req.get("cancelled_at"):
            return False
        goal = self.db.one("SELECT status FROM goals WHERE id = ?", (req["receiving_goal"],)) if req.get("receiving_goal") else None
        return bool(goal) and goal["status"] not in TERMINAL_GOAL

    def _request(self, request_id):
        return self.db.one("SELECT * FROM requests WHERE id = ?", (str(request_id or ""),))

    def is_child(self, agent_id):
        return self.db.one("SELECT 1 FROM mind_children WHERE id = ?", (agent_id,)) is not None

    def require_startable(self, child_id):
        """Called by Hive.lifecycle under the per-mind lock before a child's process starts: the child must still be
        'starting' (spawned or resumed, nothing withdrawn since), its request open, its lease live, its allocation not
        spent and spawning switched on. Anything else refuses the start (409 start_withdrawn)."""
        child = self._child(child_id)
        reason = None
        if child["state"] != "starting":
            reason = f"the child is {child['state']}"
        elif not self.hive.settings.mind_spawn:
            reason = "spawning is off"
        elif not self.request_open(self._request(child["request_id"])):
            reason = "the request is cancelled or finished"
        elif not self.lease_live(self._lease(child["lease_id"])):
            reason = "the lease is no longer live"
        elif self._exhausted(child):
            reason = "the allocation is spent"
        if reason:
            raise self.err(409, "start_withdrawn", f"start withdrawn: {reason}")

    def _child(self, child_id):
        row = self.db.one("SELECT * FROM mind_children WHERE id = ?", (str(child_id or ""),))
        if row is None:
            raise self.err(404, "not_found", f"no child {child_id}")
        return row

    # ---- operation ids: only successes are recorded, replayed byte for byte ------------------------

    def _operation(self, data):
        op = data.get("operation_id")
        if not isinstance(op, str) or not OPERATION.fullmatch(op):
            raise self.err(400, "bad_request", "operation_id is 8-120 of [A-Za-z0-9_.:-]")
        return op

    def _replay(self, scope, op, digest):
        row = self.db.one("SELECT * FROM mind_operations WHERE scope = ? AND operation_id = ?", (scope, op))
        if row is None:
            return None
        if row["digest"] != digest:
            raise self.err(409, "operation_conflict", "this operation_id was already used with a different payload")
        return row["status"], row["body"].encode()

    def _record(self, scope, op, digest, status, body):
        text = canonical(body)
        self.db.execute("INSERT INTO mind_operations VALUES (?, ?, ?, ?, ?, ?)", (scope, op, digest, status, text, now()))
        return status, text.encode()

    def _raced(self, scope, op, digest):
        """A concurrent write with the same operation id won: answer as its replay."""
        out = self._replay(scope, op, digest)
        if out is None:
            raise self.err(409, "operation_conflict", "the same operation_id was used concurrently; retry to read the answer")
        return out

    @staticmethod
    def _fields(data, allowed):
        if not isinstance(data, dict):
            raise Minds._bad("expected a JSON object")
        unknown = set(data) - set(allowed)
        if unknown:
            raise Minds._bad(f"unknown fields: {sorted(unknown)}")

    @staticmethod
    def _bad(message, **details):
        from .hive import HiveError
        return HiveError(400, "bad_request", message, details or None)

    # ---- r2.13: a person's instruction becomes a request with a request-bound lease ----------------

    REQUEST_FIELDS = ("operation_id", "to_swarm", "kind", "title", "instruction", "origin", "budget", "lifetime", "lease")
    ORIGIN_FIELDS = ("task_id", "repository_id", "workspace_id", "scope_id", "scope_digest", "generation")

    def _instruction_body(self, data):
        self._fields(data, self.REQUEST_FIELDS)
        missing = [k for k in self.REQUEST_FIELDS if k not in data]
        if missing:
            raise self._bad(f"missing fields: {missing}")
        text = lambda v, n=200: isinstance(v, str) and 0 < len(v) <= n
        if data["kind"] != "code":
            raise self._bad("kind is 'code'")
        if not text(data["to_swarm"], 80):
            raise self._bad("to_swarm is the receiving swarm's id")
        if utf8_size(data["title"]) is None or not 1 <= len(data["title"]) <= 200:
            raise self._bad("title is 1 to 200 characters")
        instruction = data["instruction"]
        if not 1 <= (utf8_size(instruction) or 0) <= 8192:
            raise self._bad("instruction is 1 to 8192 bytes of UTF-8 text")
        origin = data["origin"]
        if not isinstance(origin, dict) or set(origin) != set(self.ORIGIN_FIELDS):
            raise self._bad(f"origin is exactly {list(self.ORIGIN_FIELDS)}")
        for key in ("task_id", "repository_id", "workspace_id", "scope_id"):
            if not text(origin[key]):
                raise self._bad(f"origin.{key} is a reference of at most 200 characters")
        if not isinstance(origin["scope_digest"], str) or not DIGEST.fullmatch(origin["scope_digest"]):
            raise self._bad("origin.scope_digest is sha256:<64 hex>")
        if not _int(origin["generation"], 1, 2 ** 53):
            raise self._bad("origin.generation is a positive integer")
        budget = data["budget"]
        if not isinstance(budget, dict) or set(budget) != {"limit_usd"} or not _number(budget["limit_usd"]) or type(budget["limit_usd"]) is bool \
                or budget["limit_usd"] <= 0:
            raise self._bad("budget is {limit_usd: a number more than 0}")
        lifetime = data["lifetime"]
        until = parse_time(lifetime.get("until")) if isinstance(lifetime, dict) and set(lifetime) == {"until"} else None
        if until is None:
            raise self._bad("lifetime is {until: RFC 3339 with an offset or Z}")
        if until <= _utc_now() or until > _utc_now() + datetime.timedelta(hours=24):
            raise self._bad("lifetime.until is in the future and at most 24 hours ahead")
        lease = data["lease"]
        if not isinstance(lease, dict) or set(lease) != {"template_ids", "max_children"}:
            raise self._bad("lease is {template_ids, max_children}")
        ids = lease["template_ids"]
        if not isinstance(ids, list) or not 1 <= len(ids) <= 8 or not all(isinstance(t, str) and t for t in ids) or len(set(ids)) != len(ids):
            raise self._bad("lease.template_ids is 1 to 8 unique template ids")
        if not _int(lease["max_children"], 1, 4):
            raise self._bad("lease.max_children is an integer from 1 to 4")
        return until

    async def instruct(self, principal, data, bind=None):
        """POST /api/requests (r2.13 + r2.13.1). The caller is a named, signed-in admin person (checked by the route).
        bind (linkage r3.6 §(a) S2, the Ask intent link): called with the recorded 201 body inside the same transaction,
        right after _record; if it raises, the request, goal, lease and operation record all roll back with it. A replay
        never calls it (nothing is written); a _raced answer calls it in its own transaction with the recorded body."""
        if not isinstance(data, dict):
            raise self._bad("expected a JSON object")
        op = self._operation(data)
        digest = sha(canonical({"route": "request", "body": data}))
        replay = self._replay(principal, op, digest)
        if replay is not None:
            return replay
        until = self._instruction_body(data)
        origin, lease_in = data["origin"], data["lease"]
        task = self.db.one("SELECT * FROM goals WHERE id = ?", (origin["task_id"],))
        if task is None or task["created_by"] != principal:
            raise self.err(403, "origin_not_held", "you did not open that task")
        if task["status"] not in ("open", "claimed", "waiting"):
            raise self.err(403, "origin_not_held", f"that task is {task['status']}")
        grant = self._origin_grant(origin["task_id"], principal)
        if grant is None:
            raise self.err(403, "grant_inactive", "you hold no active grant on that task")
        to_swarm = data["to_swarm"]
        team = self._team(to_swarm)
        self.hive.require_open_swarm(to_swarm)
        if to_swarm == task["swarm_id"]:
            raise self._bad("to_swarm is the coordinator's swarm, not the task's own swarm")
        if "code" not in self.hive.collab.services(to_swarm):
            raise self.err(403, "not_offered", "that swarm does not offer 'code'")
        controller = team.get("coordinator_id") if self._member(team.get("coordinator_id"), to_swarm) else None
        if controller is None:
            raise self._bad("that swarm has no controller (coordinator) to take the request")
        unknown = [t for t in lease_in["template_ids"] if t not in {x["template_id"] for x in self.registered(to_swarm)}]
        if unknown:
            raise self.err(422, "template_unknown", "templates not registered for that swarm", template_ids=unknown)
        limit = float(data["budget"]["limit_usd"])
        ceiling, _source = self.hive.budgets.request_ceiling(to_swarm)   # the team's day once the hive has a total
        if limit > ceiling + 1e-9:
            raise self.err(402, "spend_limit", f"a person's instruction carries at most ${ceiling:.2f}", ceiling_usd=ceiling)
        ctl = self.hive.agent(controller)
        remaining = self.hive.budgets.remaining_for(ctl)   # its own cap; a $0 controller under a hive total: its auto limits
        if limit > remaining + 1e-9:
            raise self.err(402, "spend_limit", f"the swarm's controller has ${remaining:.2f} left under its limits",
                           remaining_usd=round(remaining, 6))
        text = data["instruction"]
        rid, lease_id, until_s = new_id("rq"), new_id("ls"), stamp(until)
        context = {"origin": dict(origin), "instruction": {"text": text, "digest": sha(text)}}
        try:
            with self.db.transaction():
                binding = {"request_id": rid, "kind": "code", "from_swarm": task["swarm_id"], "subject_digest": None}
                receiving = self.hive.goals._create_record(to_swarm, data["title"], "", 0.5, created_by=f"request:{rid}",
                                                           binding=binding, assignee=controller, emit=False)
                row = {"id": rid, "kind": "code", "title": data["title"], "from_swarm": task["swarm_id"], "from_goal": task["id"],
                       "from_principal": principal, "to_swarm": to_swarm, "receiving_goal": receiving["id"], "subject": None,
                       "context_refs": canonical(context), "constraints": "{}", "acceptance": "[]", "budget_root": rid,
                       "limit_usd": limit, "allocated_usd": 0.0, "ancestry": "[]", "depth": 0, "cancelled_at": None,
                       "created_at": now(), "connection_id": None, "idem_key": op, "idem_digest": digest}
                self.db.insert("requests", row)
                self.db.insert("mind_leases", {"id": lease_id, "request_id": rid, "controller_id": controller, "team_id": to_swarm,
                                               "template_ids": canonical(lease_in["template_ids"]),
                                               "max_children": lease_in["max_children"], "ceiling_usd": limit, "until": until_s,
                                               "issued_by": principal, "grant_id": grant["id"], "created_at": now(),
                                               "ended_at": None, "ended_reason": None})
                out = self._record(principal, op, digest, 201, {
                    "request_id": rid, "receiving_goal": receiving["id"], "lease_id": lease_id, "state": "accepted",
                    "budget": {"root": rid, "limit_usd": limit}, "until": until_s})
                if bind is not None:
                    bind({"request_id": rid, "receiving_goal": receiving["id"], "lease_id": lease_id})
        except sqlite3.IntegrityError:
            if bind is None:
                return self._raced(principal, op, digest)
            with self.db.transaction():
                out = self._raced(principal, op, digest)
                bind(json.loads(out[1]))
            return out
        self.hive.goals._emit(receiving["id"])
        await self.hive.goals.announce(receiving)
        self.hive.events.publish("request.updated", request=self.hive.collab.request_view(self._request(rid)))
        return out

    def _origin_grant(self, task_id, principal):
        return self.db.one("SELECT * FROM goal_grants WHERE goal_id = ? AND principal = ? AND revoked_at IS NULL AND expires_at > ? "
                           "ORDER BY expires_at DESC LIMIT 1", (task_id, principal, time.time()))

    def spend_view(self, request_id):
        """Live envelope of a request with children: what they spent, what their unresolved calls still hold, and what is
        left of the limit after both (shrinks as they spend, not only at retire; Kimi #2)."""
        req = self._request(request_id)
        children = [r["id"] for r in self.db.all("SELECT id FROM mind_children WHERE request_id = ?", (request_id,))]
        spent = sum(self._spent(c) for c in children)
        held = sum(self._held(c) for c in children)
        return {"spent_usd": round(spent, 6), "held_usd": round(held, 6),
                "remaining_usd": dollars(max(0, to_micros(req["limit_usd"]) - to_micros(spent, up=True) - to_micros(held, up=True)))}

    def lease_view(self, request_id):
        lease = self.db.one("SELECT * FROM mind_leases WHERE request_id = ? ORDER BY created_at LIMIT 1", (request_id,))
        if lease is None:
            return None
        return {"lease_id": lease["id"], "controller_id": lease["controller_id"], "template_ids": json.loads(lease["template_ids"]),
                "max_children": lease["max_children"], "until": lease["until"]}

    # ---- r2.12 §1: templates ---------------------------------------------------------------------

    def templates_for(self, agent, team_id):
        if not team_id:
            raise self._bad("team_id is required")
        self._require_controller(agent, team_id)
        leases = [l for l in self.db.all("SELECT * FROM mind_leases WHERE controller_id = ? AND team_id = ?", (agent["id"], team_id))
                  if self.lease_live(l)]
        if not leases:
            raise self.err(403, "lease_required", "you hold no live lease for this swarm")
        admitted = {t for l in leases for t in json.loads(l["template_ids"])}
        return {"templates": [self.template_view(t) for t in self.registered(team_id) if t["template_id"] in admitted]}

    def team_templates(self, swarm_id):
        """A person's read (the r2.13 instruction form): every template registered for a team, which is what a request's
        lease.template_ids may name for that to_swarm (else 422 template_unknown). The same projection as templates_for,
        but not narrowed to a live lease, because a person composes the request that creates the lease. The caller has
        already checked visibility (operator/check_path); a team that does not exist is 404 here too. Writes nothing."""
        team = self._team(swarm_id)
        return {"to_swarm": team["id"], "templates": [self.template_view(t) for t in self.registered(team["id"])]}

    # ---- r2.12 §2: spawn ---------------------------------------------------------------------------

    SPAWN_FIELDS = ("operation_id", "request_id", "team_id", "template_id", "model_id", "initial_prompt", "lifecycle_mode",
                    "lifecycle_limits", "allocation_usd")
    LIMIT_FIELDS = ("until", "max_iterations", "idle_minutes")

    def _spawn_canonical(self, data):
        self._fields(data, self.SPAWN_FIELDS)
        body = {k: data.get(k) for k in self.SPAWN_FIELDS}
        limits = body["lifecycle_limits"]
        if isinstance(limits, dict):
            body["lifecycle_limits"] = {**limits, **{k: limits.get(k) for k in self.LIMIT_FIELDS}}
        return body

    def _spawn_validate(self, body):
        for key in ("request_id", "team_id", "template_id"):
            if not isinstance(body[key], str) or not 0 < len(body[key]) <= 120:
                raise self._bad(f"{key} is required")
        if body["model_id"] is not None and (not isinstance(body["model_id"], str) or not body["model_id"]):
            raise self._bad("model_id is null or a model id")
        prompt = body["initial_prompt"]
        if not 1 <= (utf8_size(prompt) or 0) <= PROMPT_MAX_BYTES:
            raise self._bad(f"initial_prompt is 1 to {PROMPT_MAX_BYTES} bytes of valid UTF-8 (never truncated)")
        mode = body["lifecycle_mode"]
        if mode not in MODES:
            raise self._bad(f"lifecycle_mode is one of {list(MODES)}")
        limits = body["lifecycle_limits"]
        if mode != "bounded":
            if limits is not None:
                raise self._bad("lifecycle_limits is null unless lifecycle_mode is bounded")
        else:
            if not isinstance(limits, dict) or set(limits) != set(self.LIMIT_FIELDS) or all(limits[k] is None for k in self.LIMIT_FIELDS):
                raise self._bad("bounded needs lifecycle_limits {until, max_iterations, idle_minutes} with at least one set")
            if limits["max_iterations"] is not None and not _int(limits["max_iterations"], 1, 10000):
                raise self._bad("max_iterations is an integer from 1 to 10000")
            if limits["idle_minutes"] is not None and not _int(limits["idle_minutes"], 1, 10080):
                raise self._bad("idle_minutes is an integer from 1 to 10080")
            if limits["until"] is not None:
                until = parse_time(limits["until"])
                if until is None:
                    raise self._bad("until is RFC 3339 with an explicit offset or Z")
                if until <= _utc_now() or until > _utc_now() + datetime.timedelta(days=30):
                    raise self._bad("until is in the future and at most 30 days ahead")
                limits = {**limits, "until": stamp(until)}
        allocation = body["allocation_usd"]
        if not _number(allocation) or type(allocation) is bool or not 0 < allocation <= MAX_ALLOCATION_USD:
            raise self._bad(f"allocation_usd is a number more than 0 and at most {MAX_ALLOCATION_USD:g}")
        return limits

    async def spawn(self, agent, data):
        op = self._operation(data if isinstance(data, dict) else {})
        body = self._spawn_canonical(data)
        scope, digest = f"agent:{agent['id']}", sha(canonical({"route": "spawn", "body": body}))
        replay = self._replay(scope, op, digest)
        if replay is not None:
            return replay
        limits = self._spawn_validate(body)
        if not self.hive.settings.mind_spawn:
            raise self.err(403, "spawn_disabled", "child spawning is off on this hive (HIVE_MIND_SPAWN); the operator turns it on")
        team = self._require_controller(agent, body["team_id"])
        self.hive.require_open_swarm(team["id"])
        template = self.templates.get(body["template_id"])
        if template is None or team["id"] not in template["teams"]:
            raise self.err(404, "not_found", "no such template registered for this swarm")
        req = self._request(body["request_id"])
        if req is None:
            raise self.err(404, "not_found", f"no request {body['request_id']}")
        for retired in self.db.all("SELECT id FROM mind_children WHERE request_id = ? AND state = 'retired'", (req["id"],)):
            self._rebalance(retired["id"])       # settle the root's books first (kept even if this spawn is refused)
        req = self._request(req["id"])
        parent = self.db.one("SELECT swarm_id FROM agents WHERE id = ?", (team.get("parent_mind_id"),)) if team.get("parent_mind_id") else None
        if req["to_swarm"] not in {agent["swarm_id"], (parent or {}).get("swarm_id")} - {None}:
            raise self.err(403, "not_controller", "that request is not for your swarm")
        if not self.request_open(req):
            raise self.err(409, "request_closed", "that request is cancelled or finished")
        leases = [l for l in self.db.all("SELECT * FROM mind_leases WHERE request_id = ? AND controller_id = ? AND team_id = ? "
                                         "ORDER BY created_at", (req["id"], agent["id"], team["id"])) if self.lease_live(l)]
        lease = next((l for l in leases if template["template_id"] in json.loads(l["template_ids"])), None)
        if lease is None:
            raise self.err(403, "lease_required", "no live lease of yours admits this template for this request")
        if body["model_id"] is not None and body["model_id"] not in template["overridable"]["model_id"]:
            raise self._bad("model_id is null or one of the template's overridable models")
        if body["lifecycle_mode"] not in template["lifecycle_modes"]:
            raise self._bad(f"this template runs {template['lifecycle_modes']}")
        allocation = float(body["allocation_usd"])
        if allocation > template["max_allocation_usd"] + 1e-9:
            raise self.err(402, "spend_limit", f"this template allows at most ${template['max_allocation_usd']:.2f}")
        if allocation > req["limit_usd"] - req["allocated_usd"] + 1e-9:
            raise self.err(402, "spend_limit", f"the request has ${req['limit_usd'] - req['allocated_usd']:.2f} left",
                           remaining_usd=round(req["limit_usd"] - req["allocated_usd"], 6))
        model = body["model_id"] or template["model_id"]
        shared = json.loads(team.get("shared_with") or "[]")
        row, token, role = self.hive.new_agent_row(f"{template['template_id']} {secrets.token_hex(2)}", "omega", team["id"], model, "",
                                                   None, allocation, None, template["role_id"], owner=team.get("owner"),
                                                   visibility=team.get("visibility") or "private", shared_with=shared)
        child_id, res_id, at = row["id"], new_id("res"), now()

        def commit_and_start():
            # The rule (stand-in r9): the new mind's lock (taken before its row exists) and the team swarm's fence, held
            # from the insert through finish_agent and the start, all on this one worker thread (the lock is per thread).
            with self.hive._mind_lock(child_id), self.hive.swarm_membership(team["id"]):
                try:
                    with self.db.transaction():
                        for retired in self.db.all("SELECT id FROM mind_children WHERE request_id = ? AND state = 'retired'", (req["id"],)):
                            self._rebalance(retired["id"])   # a late charge on a retired sibling is held before anything new is
                        cur = self.db.execute("UPDATE requests SET allocated_usd = allocated_usd + ? WHERE id = ? AND cancelled_at IS NULL "
                                              "AND allocated_usd + ? <= limit_usd + 1e-9", (allocation, req["id"], allocation))
                        if cur.rowcount != 1:
                            if self._request(req["id"])["cancelled_at"]:
                                raise self.err(409, "request_closed", "that request was cancelled")
                            raise self.err(402, "spend_limit", "the request's budget root has no room for this allocation")
                        if not self.request_open(self._request(req["id"])) or not self.lease_live(self._lease(lease["id"])):
                            raise self.err(409, "request_closed", "the request or its lease closed")
                        spawned = self.db.one("SELECT COUNT(*) AS n FROM mind_children WHERE lease_id = ?", (lease["id"],))["n"]
                        if spawned >= lease["max_children"]:
                            raise self.err(403, "lease_required", f"this lease admits {lease['max_children']} children and all are spawned",
                                           reason="max_children")
                        self.hive.insert_into_open_swarm("agents", row, team["id"])     # archived-swarm condition, in this write
                        seq = self.db.one("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mind_children")["n"]
                        self.db.insert("mind_children", {"id": child_id, "seq": seq, "controller_id": agent["id"], "team_id": team["id"],
                                                         "request_id": req["id"], "lease_id": lease["id"], "template_id": template["template_id"],
                                                         "model_id": model, "lifecycle_mode": body["lifecycle_mode"],
                                                         "lifecycle_limits": canonical(limits) if limits is not None else None,
                                                         "state": "starting", "paused_reason": None, "recovery_needed": 0, "prompt_rev": 1,
                                                         "stop_requested_at": None, "stopped_at": None, "created_at": at, "updated_at": at})
                        self.db.insert("mind_reservations", {"id": res_id, "child_id": child_id, "request_id": req["id"],
                                                             "budget_root": req["budget_root"], "allocated_usd": allocation,
                                                             "released_usd": None, "released_at": None, "created_at": at})
                        message = self._prompt_row(child_id, 1, "queued", body["initial_prompt"], f"agent:{agent['id']}")
                        out = self._record(scope, op, digest, 201, {
                            "child_id": child_id, "team_id": team["id"], "request_id": req["id"], "template_id": template["template_id"],
                            "model_id": model, "reservation_id": res_id, "prompt_rev": 1, "state": "starting"})
                except sqlite3.IntegrityError:
                    return None, self._raced(scope, op, digest)
                self.hive.finish_agent(row, token, role, by=lease["issued_by"])   # r1.1: the admin whose lease admits it
                self._start_now(child_id)
                return message, out

        message, out = await asyncio.to_thread(commit_and_start)
        if message is None:
            return out
        await self._send(child_id, message)
        self.emit(child_id)
        return out

    def _prompt_row(self, child_id, rev, mode, text, by):
        """Revision rev and the hub message carrying it, inside the caller's transaction."""
        seq = self.db.one("SELECT COALESCE(MAX(hub_seq), 0) + 1 AS n FROM messages WHERE agent_id = ?", (child_id,))["n"]
        message = {"id": new_id("m"), "agent_id": child_id, "conversation_id": f"c_{child_id}", "direction": "in", "sender": by,
                   "text": text, "hub_seq": seq, "created_at": now(),
                   "extra": canonical({"mind_prompt": {"child_id": child_id, "rev": rev, "mode": mode}})}
        self.db.insert("messages", message)
        self.db.execute("INSERT INTO mind_prompts (child_id, rev, mode, text, delivery, interrupted, by, at, message_id) "
                        "VALUES (?, ?, ?, ?, 'accepted', 0, ?, ?, ?)", (child_id, rev, mode, text, by, message["created_at"], message["id"]))
        return message

    async def _send(self, child_id, message):
        if not await self.hive.deliver(child_id, message):
            self.db.execute("UPDATE mind_prompts SET delivery = 'pending' WHERE child_id = ? AND message_id = ? AND delivery = 'accepted'",
                            (child_id, message["id"]))

    # ---- r2.12 §3: prompt ----------------------------------------------------------------------------

    async def prompt(self, agent, child_id, data):
        op = self._operation(data if isinstance(data, dict) else {})
        self._fields(data, ("operation_id", "mode", "text", "expected_rev"))
        body = {k: data.get(k) for k in ("operation_id", "mode", "text", "expected_rev")}
        scope, digest = f"agent:{agent['id']}", sha(canonical({"route": "prompt", "child_id": child_id, "body": body}))
        replay = self._replay(scope, op, digest)
        if replay is not None:
            return replay
        if body["mode"] not in ("steer", "queued"):
            raise self._bad("mode is steer or queued")
        if not 1 <= (utf8_size(body["text"]) or 0) <= PROMPT_MAX_BYTES:
            raise self._bad(f"text is 1 to {PROMPT_MAX_BYTES} bytes of valid UTF-8 (never truncated)")
        if not _int(body["expected_rev"], 0, 2 ** 53):
            raise self._bad("expected_rev is the current revision (an integer)")
        child = self._child(child_id)
        if child["controller_id"] != agent["id"]:
            raise self.err(403, "not_controller", "only this child's controller prompts it")
        if not self.lease_live(self._lease(child["lease_id"])):
            raise self.err(403, "lease_required", "the lease this child runs under is no longer live")
        if not self.request_open(self._request(child["request_id"])):
            raise self.err(409, "request_closed", "this child's request is cancelled or finished")
        template = self.templates.get(child["template_id"]) or {"controls": []}
        if body["mode"] == "steer" and "steer" not in template["controls"]:
            raise self.err(422, "unsupported_control", "this template does not support steer")
        if child["state"] in ("stop_requested", "stopped", "retired"):
            raise self.err(422, "unsupported_control", f"the child is {child['state']}")
        rev = body["expected_rev"] + 1
        try:
            with self.db.transaction():
                cur = self.db.execute("UPDATE mind_children SET prompt_rev = ?, updated_at = ? WHERE id = ? AND prompt_rev = ?",
                                      (rev, now(), child_id, body["expected_rev"]))
                if cur.rowcount != 1:
                    current = self._child(child_id)["prompt_rev"]
                    raise self.err(409, "stale_revision", f"the current revision is {current}", current_rev=current)
                message = self._prompt_row(child_id, rev, body["mode"], body["text"], f"agent:{agent['id']}")
                out = self._record(scope, op, digest, 202, {"prompt_rev": rev, "delivery": "accepted"})
        except sqlite3.IntegrityError:
            return self._raced(scope, op, digest)
        if child["state"] in LIVE or child["state"] == "unknown":
            await self._send(child_id, message)
        else:
            self.db.execute("UPDATE mind_prompts SET delivery = 'pending' WHERE child_id = ? AND rev = ?", (child_id, rev))
        self.emit(child_id)
        return out

    def delivered(self, child_id, message):
        """The hub sent a prompt frame (hive.deliver, also on the child's resume replay)."""
        with contextlib.suppress(ValueError, TypeError, KeyError):
            rev = json.loads(message["extra"])["mind_prompt"]["rev"]
            cur = self.db.execute("UPDATE mind_prompts SET delivery = 'delivered', delivered_at = ? WHERE child_id = ? AND rev = ? "
                                  "AND delivery IN ('accepted', 'pending')", (now(), child_id, rev))
            if cur.rowcount:
                self.emit(child_id)

    def acknowledge(self, child_id, rev):
        """The child's own hub ack names a revision it holds: 'acknowledged' the first time, 'duplicate' after that,
        'refused' for a revision this child does not have. The child holding it is the proof, so an ack also settles a
        revision the host still shows accepted or pending (its frame went by replay)."""
        if not self.is_child(child_id) or not _int(rev, 1, 2 ** 53):
            return "refused"
        cur = self.db.execute("UPDATE mind_prompts SET delivery = 'acknowledged', acknowledged_at = ? WHERE child_id = ? AND rev = ? "
                              "AND delivery IN ('accepted', 'pending', 'delivered')", (now(), child_id, rev))
        if cur.rowcount:
            self.emit(child_id)
            return "acknowledged"
        row = self.db.one("SELECT delivery FROM mind_prompts WHERE child_id = ? AND rev = ?", (child_id, rev))
        return "duplicate" if row and row["delivery"] == "acknowledged" else "refused"

    def _interrupt_deliveries(self, child_id):
        self.db.execute("UPDATE mind_prompts SET interrupted = 1 WHERE child_id = ? AND delivery = 'delivered'", (child_id,))

    # ---- r2.12 §4: control (agents and people share one path) ---------------------------------------

    async def control(self, agent, child_id, data):
        op = self._operation(data if isinstance(data, dict) else {})
        self._fields(data, ("operation_id", "action"))
        body = {"operation_id": op, "action": data.get("action")}
        scope, digest = f"agent:{agent['id']}", sha(canonical({"route": "control", "child_id": child_id, "body": body}))
        replay = self._replay(scope, op, digest)
        if replay is not None:
            return replay
        action = body["action"]
        if action not in CONTROLS:
            raise self._bad(f"action is one of {list(CONTROLS)}")
        child = self._child(child_id)
        if child["controller_id"] != agent["id"]:
            raise self.err(403, "not_controller", "only this child's controller controls it")
        template = self.templates.get(child["template_id"]) or {"controls": ["stop", "retire"]}
        if action not in template["controls"]:
            raise self.err(422, "unsupported_control", f"this template does not support {action}")
        if action == "resume":    # gaining authority again: a live lease, an open request, and spawning switched on
            if not self.lease_live(self._lease(child["lease_id"])):
                raise self.err(403, "lease_required", "the lease this child runs under is no longer live")
            if not self.request_open(self._request(child["request_id"])):
                raise self.err(409, "request_closed", "this child's request is cancelled or finished")
            if not self.hive.settings.mind_spawn:
                raise self.err(403, "spawn_disabled", "child spawning is off on this hive (HIVE_MIND_SPAWN)")
        return await self._apply(child, action, f"agent:{agent['id']}", scope, op, digest)

    async def team_control(self, principal, admin, team_id, child_id, data):
        """POST /api/teams/{team}/children/{child}/control: an admin person, or the person who issued the request's lease.
        Cleanup only (stop, retire); no live lease or open request needed (r2.12.1 §1)."""
        op = self._operation(data if isinstance(data, dict) else {})
        self._fields(data, ("operation_id", "action"))
        body = {"operation_id": op, "action": data.get("action")}
        digest = sha(canonical({"route": "team-control", "team_id": team_id, "child_id": child_id, "body": body}))
        replay = self._replay(principal, op, digest)
        if replay is not None:
            return replay
        child = self.db.one("SELECT * FROM mind_children WHERE id = ? AND team_id = ?", (child_id, team_id))
        if child is None:
            raise self.err(404, "not_found", "no such swarm or child")
        if body["action"] not in ("stop", "retire"):
            raise self.err(422, "unsupported_control", "people stop or retire a child")
        lease = self._lease(child["lease_id"])
        if not admin and (lease or {}).get("issued_by") != principal:
            raise self.err(403, "forbidden", "an admin person, or the person who issued this request's lease, cleans up its children")
        return await self._apply(child, body["action"], principal, principal, op, digest)

    def _pause_reason(self, child):
        """Why a live child must pause now, or None: request, lease, budget, then its own limits."""
        if not self.request_open(self._request(child["request_id"])):
            return "request_cancelled"
        if not self.lease_live(self._lease(child["lease_id"])):
            return "lease_expired"
        if self._exhausted(child):
            return "budget_exhausted"
        if self._limit_reached(child):
            return "limit_reached"
        return None

    def _exhausted(self, child):
        agent = self.db.one("SELECT budget_usd, spent_usd FROM agents WHERE id = ?", (child["id"],)) or {}
        res = self.db.one("SELECT allocated_usd FROM mind_reservations WHERE child_id = ?", (child["id"],)) or {"allocated_usd": 0}
        refused = (self.hive.refusals.get(child["id"]) or {}).get("code") in ("budget_exhausted", "no_budget")
        return float(agent.get("spent_usd") or 0) >= float(res["allocated_usd"]) - 1e-9 or refused

    def _limit_reached(self, child):
        limits = json.loads(child["lifecycle_limits"]) if child["lifecycle_limits"] else {}
        if limits.get("until") and limits["until"] <= now():
            return True
        if limits.get("max_iterations") is not None:
            turns = self.db.one("SELECT COUNT(*) AS n FROM usage WHERE agent_id = ?", (child["id"],))["n"]
            if turns >= limits["max_iterations"]:
                return True
        if limits.get("idle_minutes") is not None:
            # idle = no real input (Hive.mark_input) and no own action since; model spend does not count as activity
            agent = self.db.one("SELECT last_active_at, last_input_at FROM agents WHERE id = ?", (child["id"],)) or {}
            last = parse_stamp(latest_stamp(agent.get("last_input_at"), agent.get("last_active_at")) or child["created_at"])
            if last and _utc_now() - last >= datetime.timedelta(minutes=limits["idle_minutes"]):
                return True
        if child["lifecycle_mode"] == "deliver" and any(g["status"] in ("done", "submitted") for g in self._request_work(child)):
            return True       # a submitted result ends this worker's deliver lifecycle; it is not acceptance or quality
        return False

    def _request_work(self, child):
        """Goals this child claimed that belong to its own request: the request's execution (receiving) goal, a subgoal
        under it, or a goal whose host binding names the request (Code decision 3). Any other goal the child happens to
        have claimed is not this request's work."""
        req = self._request(child["request_id"])
        if req is None:
            return []
        return self.db.all(
            "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT g.id FROM goals g JOIN tree t ON g.parent_id = t.id) "
            "SELECT id, status, result, result_data, binding FROM goals WHERE claimed_by = ? AND "
            "(id IN (SELECT id FROM tree) OR json_extract(binding, '$.request_id') = ?) ORDER BY updated_at, id",
            (req["receiving_goal"], child["id"], req["id"]))

    async def _apply(self, child, action, by, scope, op, digest):
        child_id, at = child["id"], now()
        state, effect, observed = child["state"], None, None
        changes = {}
        if state == "retired":
            raise self.err(422, "unsupported_control", "the child is retired")
        if action == "interrupt":
            effect = "interrupt"
        elif action == "pause":
            if state in LIVE:
                changes, effect = {"state": "paused", "paused_reason": None}, "stop"
            elif state != "paused":
                raise self.err(422, "unsupported_control", f"the child is {state}")
        elif action == "resume":
            if state not in ("paused", "unknown"):
                raise self.err(422, "unsupported_control", f"only a paused child resumes; this one is {state}")
            if self._exhausted(child):
                raise self.err(402, "spend_limit", "this child's allocation is spent")
            if self._limit_reached(child):
                raise self.err(422, "unsupported_control", "this child reached its lifecycle limit")
            changes, effect = {"state": "starting", "paused_reason": None, "recovery_needed": 0}, "start"
        elif action == "stop":
            if state == "stopped":
                observed = {"state": "stopped", "at": child["stopped_at"]}
            else:
                changes, effect = {"state": "stop_requested", "stop_requested_at": time.time()}, "stop"
        elif action == "retire":
            if state != "stopped":
                raise self.err(422, "unsupported_control", "retire needs a stopped child; stop it first")
            changes, effect = {"state": "retired"}, "retire"
        try:
            with self.db.transaction():
                if changes:
                    sets = ", ".join(f"{k} = ?" for k in changes)
                    cur = self.db.execute(f"UPDATE mind_children SET {sets}, updated_at = ? WHERE id = ? AND state = ?",
                                          (*changes.values(), at, child_id, state))
                    if cur.rowcount != 1:
                        raise self.err(409, "state_changed", "the child changed state meanwhile; read its status and retry")
                if effect == "retire":
                    self._release(child_id)
                self.db.insert("mind_controls", {"id": new_id("mc"), "child_id": child_id, "action": action, "by": by,
                                                 "requested_at": at, "observed": canonical(observed) if observed else None})
                out = self._record(scope, op, digest, 202, {"action": action, "requested_at": at, "observed": None})
        except sqlite3.IntegrityError:
            return self._raced(scope, op, digest)
        if effect in ("stop", "interrupt"):
            self._interrupt_deliveries(child_id)
        if effect == "interrupt":
            ws = self.hive.connections.get(child_id)
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.send_text(json.dumps({"type": "mind_control", "action": "interrupt"}))
        elif effect == "stop":
            await self._stop_process(child_id)
            if action == "stop":
                self._observe_stop(child_id)
        elif effect == "start":
            await self._start(child_id)
            await self._redeliver(child_id)
        elif effect == "retire":
            with contextlib.suppress(Exception):
                await self._stop_process(child_id)
            self.db.execute("UPDATE agents SET token_hash = ?, desired = 'stopped' WHERE id = ?",
                            (hashlib.sha256(secrets.token_bytes(32)).hexdigest(), child_id))   # its credential ends with it
        self.emit(child_id)
        return out

    def _release(self, child_id):
        """Retire: from now on the child's share of the request root is only what it spent plus what its unresolved
        model calls still hold (S5 reserved, dispatched or unknown); the rest goes back (OmegaReview B2). History stays."""
        res = self.db.one("SELECT * FROM mind_reservations WHERE child_id = ?", (child_id,))
        if res is None or res["released_at"]:
            return
        self.db.execute("UPDATE mind_reservations SET released_usd = 0, released_at = ? WHERE id = ?", (now(), res["id"]))
        self._rebalance(child_id)

    def _held(self, child_id):
        """USD still held for this child's model calls whose cost is not yet known (S5 cost_reservations)."""
        if not self.db.one("SELECT 1 FROM sqlite_master WHERE name = 'cost_reservation_details'"):
            return 0.0
        row = self.db.one("SELECT COALESCE(SUM(r.maximum), 0) AS m FROM cost_reservations r JOIN cost_reservation_details d "
                          "ON d.reservation = r.id WHERE json_extract(d.metadata, '$.agent') = ? AND r.state IN "
                          "('reserved', 'dispatched', 'unknown')", (child_id,))
        return row["m"] / 1_000_000

    def _spent(self, child_id):
        return float((self.db.one("SELECT spent_usd FROM agents WHERE id = ?", (child_id,)) or {}).get("spent_usd") or 0)

    def _rebalance(self, child_id):
        """A retired child's refund is recomputed, never added to: target = allocation - spent - still held. A settlement
        or a person's release that frees a hold refunds the difference once; a late charge (even after a release)
        takes it back into the request root, so the root never under-counts what was spent or is still owed."""
        with self.db.transaction():
            res = self.db.one("SELECT * FROM mind_reservations WHERE child_id = ?", (child_id,))
            if res is None or not res["released_at"]:
                return
            # integer micro-dollars (r7): allocation floored, spend and holds ceilinged: never refund more than is free
            target = dollars(max(0, to_micros(res["allocated_usd"]) - to_micros(self._spent(child_id), up=True)
                                 - to_micros(self._held(child_id), up=True)))
            delta = dollars(to_micros(target) - to_micros(res["released_usd"] or 0.0))   # integers: both are whole micros
            if delta == 0:
                return
            self.db.execute("UPDATE requests SET allocated_usd = MAX(0, allocated_usd - ?) WHERE id = ?", (delta, res["request_id"]))
            self.db.execute("UPDATE mind_reservations SET released_usd = ? WHERE id = ?", (target, res["id"]))

    def _process_running(self, child_id):
        sup = self.hive.supervisor
        try:
            return sup.driver(self.hive.agent(child_id)).status(child_id) == "running"
        except Exception:
            return False

    def _stop_stray(self, child_id):
        with self.hive._mind_lock(child_id):
            if self._child(child_id)["state"] in ("paused", "stopped", "retired") and self._process_running(child_id):
                log.warning("child %s ran while %s; stopping it", child_id, self._child(child_id)["state"])
                self.hive.lifecycle(child_id, "stop")

    async def _start(self, child_id):
        """Start (or resume) the process; the authority and state re-check happens inside Hive.lifecycle's lock."""
        await asyncio.to_thread(self._start_now, child_id)

    def _start_now(self, child_id):
        try:
            self.hive.lifecycle(child_id, "start")
        except Exception as exc:
            if getattr(exc, "code", None) == "start_withdrawn":
                # Withdrawn before it ran. A stop or cancel already set its own state; a lease or budget lost silently
                # leaves the child paused with that reason, never "starting" with nothing running.
                child = self._child(child_id)
                if child["state"] == "starting":
                    self.db.execute("UPDATE mind_children SET state = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? "
                                    "AND state = 'starting'", (self._pause_reason(child), now(), child_id))
                self.emit(child_id)
                return
            log.warning("child %s did not start: %s", child_id, exc)
            self.db.execute("UPDATE mind_children SET state = 'unknown', recovery_needed = 1, updated_at = ? WHERE id = ? "
                            "AND state = 'starting'", (now(), child_id))

    async def _stop_process(self, child_id):
        if self.hive.supervisor is not None:
            await asyncio.to_thread(self.hive.lifecycle, child_id, "stop")

    def _process_ended(self, child_id):
        """Observed, never assumed: no supervisor or no reading is not an end."""
        sup = self.hive.supervisor
        if sup is None:
            return False
        try:
            return sup.driver(self.hive.agent(child_id)).status(child_id) != "running"
        except Exception:
            return False

    def _observe_stop(self, child_id):
        child = self._child(child_id)
        if child["state"] not in ("stop_requested", "unknown") or not self._process_ended(child_id):
            return False
        at = now()
        with self.db.transaction():
            self.db.execute("UPDATE mind_children SET state = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND state IN "
                            "('stop_requested', 'unknown')", (at, at, child_id))
            self.db.execute("UPDATE mind_controls SET observed = ? WHERE child_id = ? AND action = 'stop' AND observed IS NULL",
                            (canonical({"state": "stopped", "at": at}), child_id))
        return True

    async def _redeliver(self, child_id):
        for row in self.db.all("SELECT m.* FROM mind_prompts p JOIN messages m ON m.id = p.message_id WHERE p.child_id = ? AND "
                               "p.delivery IN ('accepted', 'pending') ORDER BY p.rev", (child_id,)):
            await self._send(child_id, row)

    def _set(self, child_id, **changes):
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.db.execute(f"UPDATE mind_children SET {sets}, updated_at = ? WHERE id = ?", (*changes.values(), now(), child_id))

    # ---- r2.12 §5: status (and the human team projection) --------------------------------------------

    def child_view(self, row, text=False):
        agent = self.db.one("SELECT last_active_at FROM agents WHERE id = ?", (row["id"],)) or {}
        spent = float((self.db.one("SELECT spent_usd FROM agents WHERE id = ?", (row["id"],)) or {}).get("spent_usd") or 0)
        res = self.db.one("SELECT * FROM mind_reservations WHERE child_id = ?", (row["id"],))
        prompts = []
        for p in self.db.all("SELECT * FROM mind_prompts WHERE child_id = ? ORDER BY rev", (row["id"],)):
            item = {"rev": p["rev"], "mode": p["mode"], "delivery": p["delivery"], "interrupted": bool(p["interrupted"]),
                    "by": p["by"], "at": p["at"]}
            if text:
                item["text"] = p["text"]
            prompts.append(item)
        controls = [{"action": c["action"], "requested_at": c["requested_at"], "observed": json.loads(c["observed"]) if c["observed"] else None,
                     "by": c["by"]} for c in self.db.all("SELECT * FROM mind_controls WHERE child_id = ? ORDER BY requested_at, rowid", (row["id"],))]
        results = [{"goal_id": g["id"], "status": g["status"],
                    "result_digest": sha(canonical(json.loads(g["result_data"]) if g["result_data"] else g["result"] or ""))}
                   for g in self._request_work(row) if g["status"] in ("done", "failed", "submitted")]
        allocated = float(res["allocated_usd"]) if res else 0.0
        remaining = 0.0 if not res or res["released_at"] else max(0.0, allocated - spent - self._held(row["id"]))
        return {"child_id": row["id"], "controller_id": row["controller_id"], "request_id": row["request_id"], "team_id": row["team_id"],
                "template_id": row["template_id"], "model_id": row["model_id"], "lifecycle_mode": row["lifecycle_mode"],
                "lifecycle_limits": json.loads(row["lifecycle_limits"]) if row["lifecycle_limits"] else None,
                "state": row["state"], "paused_reason": row["paused_reason"], "recovery_needed": bool(row["recovery_needed"]),
                "prompt_rev": row["prompt_rev"], "prompts": prompts, "controls": controls,
                "reservation": {"reservation_id": res["id"] if res else None, "allocated_usd": round(allocated, 6),
                                "spent_usd": round(spent, 6), "remaining_usd": round(remaining, 6)},
                "progress": {"last_turn_at": self._last_turn(row["id"], agent.get("last_active_at")), "results": results}}

    def _last_turn(self, child_id, last_active_at):
        """The child's last turn: its last metered model call or its last own action, whichever is later (spend no
        longer moves agents.last_active_at, so the call is read from usage)."""
        last = self.db.one("SELECT MAX(created_at) AS at FROM usage WHERE agent_id = ?", (child_id,)) or {}
        return latest_stamp(last.get("at"), last_active_at)

    def _cursor(self, caller, selector, value, after):
        payload = base64.urlsafe_b64encode(canonical({"c": caller, "s": selector, "v": value, "a": after,
                                                      "e": int(time.time()) + CURSOR_SECONDS}).encode()).decode().rstrip("=")
        return payload + "." + hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()

    def _after(self, cursor, caller, selector, value):
        if cursor is None:
            return 0
        try:
            payload, sig = str(cursor).split(".", 1)
            if not hmac.compare_digest(sig, hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()):
                raise ValueError
            data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            if (data["c"], data["s"], data["v"]) != (caller, selector, value) or data["e"] < time.time() or type(data["a"]) is not int:
                raise ValueError
            return data["a"]
        except (ValueError, KeyError, TypeError):
            raise self.err(400, "bad_cursor", "that cursor is not for this caller and selector, or it expired") from None

    def _page(self, where, params, caller, selector, value, cursor, text=lambda row: False):
        after = self._after(cursor, caller, selector, value)
        rows = self.db.all(f"SELECT * FROM mind_children WHERE {where} AND seq > ? ORDER BY seq LIMIT ?", (*params, after, PAGE + 1))
        page = rows[:PAGE]
        return {"children": [self.child_view(r, text(r)) for r in page], "snapshot_at": now(),
                "next_cursor": self._cursor(caller, selector, value, page[-1]["seq"]) if len(rows) > PAGE else None}

    def status(self, agent, child_id=None, team_id=None, request_id=None, cursor=None):
        chosen = [(k, v) for k, v in (("child_id", child_id), ("team_id", team_id), ("request_id", request_id)) if v is not None]
        if len(chosen) != 1 or not chosen[0][1]:
            raise self._bad("give exactly one of child_id, team_id or request_id")
        selector, value = chosen[0]
        if selector == "child_id" and self._child(value)["controller_id"] != agent["id"]:
            raise self.err(403, "not_controller", "only this child's controller reads its status")
        if selector == "team_id":
            self._require_controller(agent, value)          # a controller OF that team, not merely of some child (Kimi #3)
        if selector == "request_id":
            req = self._request(value)
            if req is None:
                raise self.err(404, "not_found", f"no request {value}")
            leased = self.db.one("SELECT 1 FROM mind_leases WHERE request_id = ? AND controller_id = ?", (value, agent["id"]))
            if not leased and agent["id"] not in self.controllers(self._team(req["to_swarm"])):
                raise self.err(403, "not_controller", "only a controller of this request reads its children")
        column = {"child_id": "id", "team_id": "team_id", "request_id": "request_id"}[selector]
        return self._page(f"{column} = ? AND controller_id = ?", (value, agent["id"]), f"agent:{agent['id']}", selector, value, cursor)

    def team_children(self, viewer, team_id, cursor=None):
        """GET /api/teams/{team}/children: every child of the team (the route already checked the person sees the team).
        Prompt text only for a person who may read that child's request."""
        if self.db.one("SELECT 1 FROM swarms WHERE id = ?", (team_id,)) is None:
            raise self.err(404, "not_found", "no such swarm")       # the same answer as a swarm this person cannot see
        readable = {}

        def text(row):
            if row["request_id"] not in readable:
                req = self._request(row["request_id"])
                readable[row["request_id"]] = bool(req) and bool(
                    self.hive.visibility.filter_items(viewer, [{"from_swarm": req["from_swarm"], "to_swarm": req["to_swarm"]}]))
            return readable[row["request_id"]]
        return self._page("team_id = ?", (team_id,), viewer.principal, "team_id", team_id, cursor, text)

    # ---- events, runtime observations, reconciliation --------------------------------------------------

    def emit(self, child_id):
        row = self.db.one("SELECT * FROM mind_children WHERE id = ?", (child_id,))
        if row is not None:
            self.hive.events.publish("mind.updated", swarm_id=row["team_id"], child=self.child_view(row))

    def connected(self, agent_id):
        child = self.db.one("SELECT state, recovery_needed FROM mind_children WHERE id = ?", (agent_id,))
        if child and (child["state"] == "starting" or (child["state"] == "unknown" and child["recovery_needed"])):
            self._set(agent_id, state="running", recovery_needed=0)
            self.emit(agent_id)

    def disconnected(self, agent_id):
        if self.is_child(agent_id):
            self._interrupt_deliveries(agent_id)   # sent but not acknowledged: kept, marked interrupted, never dropped
            self.emit(agent_id)

    def exited(self, agent_id):
        """The supervisor found a child that should be awake not running: observed, recorded, never restarted."""
        child = self._child(agent_id)
        self.hive.set_status(agent_id, "stopped", desired="stopped")
        self._interrupt_deliveries(agent_id)
        if child["state"] in ("stop_requested", "unknown"):
            self._observe_stop(agent_id)
        elif child["state"] in LIVE:
            self._set(agent_id, state="stopped", stopped_at=now(), recovery_needed=1)
        self.emit(agent_id)

    def restored(self, row):
        """Hive boot: a child keeps whatever runtime is observed; one not observed running is flagged, not restarted."""
        child = self._child(row["id"])
        if row["desired"] == "awake" or row["status"] in ("awake", "starting"):
            self.hive.set_status(row["id"], "stopped", desired="stopped")
        if child["state"] in (*LIVE, "stop_requested"):
            self._interrupt_deliveries(row["id"])
            self._set(row["id"], state="unknown", recovery_needed=1)

    async def request_cancelled(self, request_id):
        """r2.12 §6: this request's children pause (request_cancelled) and its lease ends; nothing else is touched."""
        with self.db.transaction():   # the lease end and its proposal tests' withdrawal endings commit together (c.4)
            self.db.execute("UPDATE mind_leases SET ended_at = ?, ended_reason = 'request_cancelled' WHERE request_id = ? AND ended_at IS NULL",
                            (now(), request_id))
            tests = getattr(self.hive, "proposal_tests", None)
            if tests is not None:
                tests.request_cancelled(request_id)
        for child in self.db.all("SELECT * FROM mind_children WHERE request_id = ? AND state != 'retired'", (request_id,)):
            await self._pause(child, "request_cancelled")

    async def _pause(self, child, reason):
        await asyncio.to_thread(self._pause_locked, child["id"], reason)
        self.emit(child["id"])

    def _pause_locked(self, child_id, reason):
        """The state change and the stop hold the mind's lifecycle lock together, so no start can slip between them."""
        with self.hive._mind_lock(child_id):
            child = self._child(child_id)
            if child["state"] == "retired":
                return
            live = child["state"] in LIVE
            at = now()
            cur = self.db.execute("UPDATE mind_children SET state = ?, paused_reason = ?, updated_at = ? WHERE id = ? AND state = ?",
                                  ("paused" if live else child["state"], reason, at, child_id, child["state"]))
            if cur.rowcount and (live or child["paused_reason"] != reason):   # the host's pause is in the audit trail too
                self.db.insert("mind_controls", {"id": new_id("mc"), "child_id": child_id, "action": "pause",
                                                 "by": f"host:{reason}", "requested_at": at, "observed": None})
            if live:
                self._interrupt_deliveries(child_id)
                if self.hive.supervisor is not None:
                    with contextlib.suppress(Exception):
                        self.hive.lifecycle(child_id, "stop")

    async def reconcile(self):
        """Pause what lost its authority or budget, observe stops, and time unobserved ones out to unknown."""
        for child in self.db.all("SELECT * FROM mind_children WHERE state IN ('starting', 'running', 'paused', 'stop_requested', 'unknown')"):
            try:
                if child["state"] in ("stop_requested", "unknown"):
                    if self._observe_stop(child["id"]):
                        self.emit(child["id"])
                    elif child["state"] == "stop_requested" and time.time() - (child["stop_requested_at"] or 0) > STOP_OBSERVE_SECONDS:
                        self._set(child["id"], state="unknown")      # never stopped by timeout, and no replacement follows
                        self.emit(child["id"])
                elif child["state"] in LIVE:
                    reason = self._pause_reason(child)
                    if reason:
                        await self._pause(child, reason)
                elif child["state"] == "paused" and child["paused_reason"] != "request_cancelled" \
                        and not self.request_open(self._request(child["request_id"])):
                    await self._pause(child, "request_cancelled")
            except Exception as exc:
                log.warning("mind reconcile %s: %s", child["id"], exc)
        for child in self.db.all("SELECT * FROM mind_children WHERE state IN ('paused', 'stopped', 'retired')"):
            try:
                if self.hive.supervisor is not None and self._process_running(child["id"]):
                    await asyncio.to_thread(self._stop_stray, child["id"])   # defence in depth; the lock guard is the fix
            except Exception as exc:
                log.warning("mind reconcile %s: %s", child["id"], exc)
        for child in self.db.all("SELECT id FROM mind_children WHERE state = 'retired'"):
            try:
                self._rebalance(child["id"])
            except Exception as exc:
                log.warning("mind reconcile %s: %s", child["id"], exc)
        tests = getattr(self.hive, "proposal_tests", None)
        if tests is not None:          # linkage c.4: persist lazy withdrawals (lease until, grant expiry, demotion)
            try:
                tests.reconcile()
            except Exception as exc:
                log.warning("proposal test reconcile: %s", exc)

    # ---- r2.13.1: the delegated proposal capability ----------------------------------------------------

    def issue_delegated(self, agent, member_token, data):
        """A child of an instruction request asks the host for its Code capability (re-issued while the request lives)."""
        self._fields(data, ("delegated", "service"))
        if data.get("delegated") is not True:
            raise self._bad("delegated: true")
        child = self.db.one("SELECT * FROM mind_children WHERE id = ?", (agent["id"],))
        if child is None:
            raise self.err(403, "not_delegated", "only a child running for an instruction request gets a delegated capability")
        req, lease = self._request(child["request_id"]), self._lease(child["lease_id"])
        context = json.loads(req["context_refs"]) if req and req["context_refs"] else None
        origin = context.get("origin") if isinstance(context, dict) else None
        if not origin or not lease or not lease.get("grant_id"):
            raise self.err(403, "not_delegated", "this child's request carries no person origin")
        claims = {"actor": agent["id"], "task_id": origin["task_id"], "grant_id": lease["grant_id"],
                  "delegated": self._delegation(child, req, lease, origin)}
        reason = self.delegated_reason(claims)
        if reason is not None:
            raise self.err(403, "capability_withdrawn", f"no delegated capability now: {reason}", reason=reason)
        task = self.db.one("SELECT swarm_id FROM goals WHERE id = ?", (origin["task_id"],))
        left = (parse_time(lease["until"]) - _utc_now()).total_seconds()
        services = self.hive.services
        svc = services.by_name(str(data.get("service") or "omegacode"))
        return services.issue(svc["id"], actor=agent["id"], kind="agent", task_id=origin["task_id"], swarm_id=task["swarm_id"],
                              repository_id=origin["repository_id"], actions=["read", "search", "suggest"],
                              ttl_seconds=int(max(1, min(CAPABILITY_SECONDS, left))), member_token=member_token,
                              grant_id=lease["grant_id"], by="host:minds", delegated=claims["delegated"])

    @staticmethod
    def _delegation(child, req, lease, origin):
        return {"request_id": req["id"], "controller_id": child["controller_id"], "execution_goal": req["receiving_goal"],
                "issuer": lease["issued_by"],
                "origin_scope": {"scope_id": origin["scope_id"], "scope_digest": origin["scope_digest"], "generation": origin["generation"]}}

    def delegated_reason(self, claims):
        """None while a delegated capability may act; otherwise why it is withdrawn."""
        d = claims.get("delegated")
        if not isinstance(d, dict):
            return "malformed"
        child = self.db.one("SELECT * FROM mind_children WHERE id = ?", (claims.get("actor"),))
        if child is None or child["state"] == "retired" or not self._member(child["id"]):
            return "child_retired"
        if (child["request_id"], child["controller_id"]) != (d.get("request_id"), d.get("controller_id")):
            return "child_mismatch"
        req = self._request(child["request_id"])
        if not self.request_open(req) or req["receiving_goal"] != d.get("execution_goal"):
            return "request_closed"
        lease = self._lease(child["lease_id"])
        if not self.lease_live(lease) or lease["issued_by"] != d.get("issuer"):
            return "lease_expired"
        grant = self.db.one("SELECT * FROM goal_grants WHERE id = ?", (claims.get("grant_id"),))
        if claims.get("grant_id") != lease["grant_id"] or grant is None or grant["revoked_at"] or grant["expires_at"] <= time.time() or grant["principal"] != d.get("issuer") \
                or grant["goal_id"] != claims.get("task_id"):
            return "grant_withdrawn"
        task = self.db.one("SELECT status FROM goals WHERE id = ?", (claims.get("task_id"),))
        if task is None or task["status"] not in ("open", "claimed", "waiting"):
            return "task_closed"
        return None

    # ---- linkage slice 3: the controller's copy_apply purpose capability (copy-apply seam §2) ----------------

    COPY_APPLY_FIELDS = ("operation_id", "request_id", "proposal", "expected")

    def _copy_apply_body(self, data):
        """Closed issuance body; Code's values are checked against their patterns and never converted (check 6)."""
        self._fields(data, ("service", "copy_apply"))
        if str(data.get("service") or "omegacode") != "omegacode":
            raise self._bad("copy_apply is an omegacode capability")
        body = data.get("copy_apply")
        self._fields(body, self.COPY_APPLY_FIELDS)
        missing = [k for k in self.COPY_APPLY_FIELDS if k not in body]
        if missing:
            raise self._bad(f"missing fields: {missing}")
        self._operation(body)
        if not isinstance(body["request_id"], str) or not REQUEST_ID.fullmatch(body["request_id"]):
            raise self._bad("request_id is the request's rq_ id")
        proposal, expected = body["proposal"], body["expected"]
        self._fields(proposal, ("suggestion_id", "suggestion_digest"))
        self._fields(expected, ("generation", "tree_digest"))
        if not isinstance(proposal.get("suggestion_id"), str) or not SUGGESTION_ID.fullmatch(proposal["suggestion_id"]):
            raise self._bad("proposal.suggestion_id is suggestion_<32 hex>")
        if not isinstance(proposal.get("suggestion_digest"), str) or not BARE_DIGEST.fullmatch(proposal["suggestion_digest"]):
            raise self._bad("proposal.suggestion_digest is a bare 64-hex digest")
        if not _int(expected.get("generation"), 1, 2 ** 53):
            raise self._bad("expected.generation is a whole number from 1")
        if not isinstance(expected.get("tree_digest"), str) or not BARE_DIGEST.fullmatch(expected["tree_digest"]):
            raise self._bad("expected.tree_digest is a bare 64-hex digest")
        return body

    def _request_lease(self, request_id):
        return self.db.one("SELECT * FROM mind_leases WHERE request_id = ? ORDER BY created_at LIMIT 1", (request_id,))

    @staticmethod
    def _request_origin(req):
        try:
            context = json.loads(req["context_refs"]) if req and req["context_refs"] else None
        except ValueError:
            return None
        origin = context.get("origin") if isinstance(context, dict) else None
        return origin if isinstance(origin, dict) else None

    @staticmethod
    def _grant_edits(grant, principal, task_id, workspace_id):
        """The issuer's origin grant still carries edit authority over the origin workspace (check 4). A read grant never
        becomes edit authority because an instruction arrived under it."""
        return bool(grant) and grant["scope"] == "edit" and grant["principal"] == principal and grant["goal_id"] == task_id \
            and grant["workspace_id"] in (None, workspace_id)

    def _controller_current(self, agent_id, lease):
        team = self.db.one("SELECT * FROM swarms WHERE id = ?", (lease["team_id"],)) if lease else None
        return bool(team) and not self.is_child(agent_id) and lease["controller_id"] == agent_id \
            and agent_id in self.controllers(team)

    def _copy_apply_binding(self, agent, body):
        """Issuance checks 1-6, in order; the binding and expiry they admit."""
        if self.is_child(agent["id"]):
            raise self.err(403, "not_controller", "a delegated child never applies a proposal", reason="delegated_child")
        req = self._request(body["request_id"])
        if req is None:
            raise self.err(404, "not_found", f"no request {body['request_id']}")
        lease = self._request_lease(req["id"])
        if lease is None:
            raise self.err(403, "lease_required", "this request has no lease")
        if not self._controller_current(agent["id"], lease):
            raise self.err(403, "not_controller", "only the request's current controller applies its proposals")
        if not self.request_open(req):
            raise self.err(409, "request_closed", "the request is cancelled or finished")
        if not self.lease_live(lease):
            raise self.err(403, "lease_required", "the request's lease is no longer live")
        origin = self._request_origin(req)          # check 5: origin values come from the host, never from the body
        if origin is None or not lease["grant_id"]:
            raise self.err(403, "not_controller", "this request carries no person origin", reason="no_origin")
        grant = self.db.one("SELECT * FROM goal_grants WHERE id = ?", (lease["grant_id"],))
        if grant is None or grant["revoked_at"] or grant["expires_at"] <= time.time() or grant["principal"] != lease["issued_by"] \
                or grant["goal_id"] != origin.get("task_id"):
            raise self.err(403, "grant_withdrawn", "the issuer's origin grant is no longer active")
        if not self._grant_edits(grant, lease["issued_by"], origin.get("task_id"), origin.get("workspace_id")):
            raise self.err(403, "origin_grant_read_only", "the issuer's origin grant does not carry edit authority on that workspace")
        task = self.db.one("SELECT swarm_id, status FROM goals WHERE id = ?", (origin["task_id"],))
        if task is None or task["status"] not in OPEN_TASK:
            raise self.err(409, "task_closed", "the origin task is closed")
        text = lambda v: isinstance(v, str) and 0 < len(v) <= 200
        if not (text(origin.get("repository_id")) and text(origin.get("scope_id"))
                and isinstance(origin.get("workspace_id"), str) and WORKSPACE_ID.fullmatch(origin["workspace_id"])
                and isinstance(origin.get("scope_digest"), str) and DIGEST.fullmatch(origin["scope_digest"])):
            raise self.err(409, "origin_invalid", "the request's origin is not a Code workspace scope this capability can bind")
        binding = {"purpose": "workspace-copy-apply", "operation_id": body["operation_id"], "request_id": req["id"],
                   "lease_id": lease["id"], "controller_id": agent["id"], "execution_goal": req["receiving_goal"],
                   "issuer": lease["issued_by"], "origin_grant_id": lease["grant_id"],
                   "origin": {k: origin[k] for k in ("task_id", "repository_id", "workspace_id", "scope_id", "scope_digest")},
                   "proposal": dict(body["proposal"]), "expected": dict(body["expected"])}
        exp = min(int(time.time()) + COPY_APPLY_SECONDS, int(parse_time(lease["until"]).timestamp()))
        return binding, task, lease, exp

    # ---- copy-apply consent r1: the request's person accepts one exact proposal ------------------------------------

    @staticmethod
    def _consent_binding_digest(request_id, lease_id, controller_id, issuer, origin_grant_id, execution_goal, origin):
        """The request binding a consent is for: the same host values the copy_apply binding carries (never the body's)."""
        return sha(canonical({"request_id": request_id, "lease_id": lease_id, "controller_id": controller_id, "issuer": issuer,
                              "origin_grant_id": origin_grant_id, "execution_goal": execution_goal,
                              "origin": {k: (origin or {}).get(k) for k in ("task_id", "repository_id", "workspace_id",
                                                                            "scope_id", "scope_digest")}}))

    @staticmethod
    def consent_view(row):
        out = {k: row[k] for k in ("request_id", "suggestion_id", "suggestion_digest", "decision", "principal", "created_at")}
        if row["decision"] == "accept":
            out |= {"consent_id": row["id"], "controller_id": row["controller_id"], "expires_in": CONSENT_SECONDS,
                    "expires_at": stamp(datetime.datetime.fromtimestamp(row["expires_at"], datetime.timezone.utc))}
        return out

    def copy_apply_consent(self, principal, request_id, suggestion_id, data, decision):
        """POST /api/requests/{request_id}/proposals/{suggestion_id}/accept|decline {suggestion_digest}: the request's own
        named person, after Accept + confirm (or Reject), records consent for one exact proposal. An accept is bound to
        the proposal id and digest, the request binding, this person, the request's controller and ten minutes; it is
        single use. Either decision voids every earlier accept for that proposal, spent or not (one consent lives at a
        time), and withdraws every capability already issued under one in the same transaction (r3), so applying it again
        needs the controller to spend the newest accept."""
        assert decision in ("accept", "decline")
        self._fields(data, ("suggestion_digest",))
        digest = data.get("suggestion_digest")
        if not isinstance(suggestion_id, str) or not SUGGESTION_ID.fullmatch(suggestion_id):
            raise self._bad("the proposal id is suggestion_<32 hex>")
        if not isinstance(digest, str) or not BARE_DIGEST.fullmatch(digest):
            raise self._bad("suggestion_digest is the proposal's bare 64-hex digest")
        req = self._request(request_id)
        if req is None:
            raise self.err(404, "not_found", f"no request {request_id}")
        lease = self._request_lease(req["id"])
        if lease is None:
            raise self.err(403, "lease_required", "this request has no lease")
        if principal != lease["issued_by"]:
            raise self.err(403, "not_request_person", "only the person who made this request accepts or declines its proposals")
        origin = self._request_origin(req)
        t = time.time()
        with self.db.transaction():
            if decision == "accept":
                if not self.request_open(req):
                    raise self.err(409, "request_closed", "the request is cancelled or finished")
                if not self.lease_live(lease):
                    raise self.err(403, "lease_required", "the request's lease is no longer live")
                if origin is None or not lease["grant_id"]:
                    raise self.err(403, "not_controller", "this request carries no person origin", reason="no_origin")
            # copy-apply consent r3 (stand-in consent r2 P1): either decision replaces every earlier accept for this
            # proposal, spent or not, and withdraws every capability issued under any of them, in this one transaction;
            # only the newest decision can be acted on, and a capability never outlives the consent it spent
            self._void_consents(req["id"], suggestion_id, t)
            row = {"id": "cns_" + secrets.token_hex(16), "request_id": req["id"], "suggestion_id": suggestion_id, "suggestion_digest": digest,
                   "decision": decision, "principal": principal, "controller_id": lease["controller_id"], "lease_id": lease["id"],
                   "binding_digest": self._consent_binding_digest(req["id"], lease["id"], lease["controller_id"], lease["issued_by"],
                                                                  lease["grant_id"], req["receiving_goal"], origin),
                   "created_at": now(), "expires_at": t + CONSENT_SECONDS if decision == "accept" else None,
                   "spent_at": None, "spent_by": None, "capability_id": None, "voided_at": None}
            self.db.insert("copy_apply_consents", row)
        return self.consent_view(row)

    def _void_consents(self, request_id, suggestion_id, t):
        """Inside the caller's transaction: void every accept for this proposal and revoke every capability issued under
        any accept for it, voided or not (a capability names its consent in claims.copy_apply_consent; the consent row
        also records the one it last admitted). Idempotent; a capability already revoked stays as it is."""
        accepts = "SELECT id FROM copy_apply_consents WHERE request_id = ? AND suggestion_id = ? AND decision = 'accept'"
        caps = self.db.all(
            "SELECT id FROM capabilities WHERE revoked_at IS NULL AND (json_extract(claims, '$.copy_apply_consent.consent_id') IN "
            f"({accepts}) OR id IN (SELECT capability_id FROM copy_apply_consents WHERE request_id = ? AND suggestion_id = ? "
            "AND decision = 'accept' AND capability_id IS NOT NULL))", (request_id, suggestion_id, request_id, suggestion_id))
        for cap in caps:
            self.hive.services.revoke_capability(cap["id"])
        self.db.execute("UPDATE copy_apply_consents SET voided_at = ? WHERE request_id = ? AND suggestion_id = ? "
                        "AND decision = 'accept' AND voided_at IS NULL", (t, request_id, suggestion_id))

    def _consent_current(self, claims):
        """copy-apply consent r3: a copy_apply capability acts only while the consent it names is this proposal's newest
        decision, an unvoided accept by the binding's issuer for the binding's controller and exact proposal, and that
        consent's capability is this one. Re-checked on every live-status call, so a capability issued under a consent
        that was later replaced or withdrawn (or one naming a consent that never existed) is refused even if its
        revocation were missed (a pre-r3 database)."""
        c, named = claims.get("copy_apply") or {}, claims.get("copy_apply_consent")
        p = c.get("proposal") if isinstance(c.get("proposal"), dict) else {}
        if not isinstance(named, dict) or not isinstance(named.get("consent_id"), str):
            return False
        row = self.db.one("SELECT * FROM copy_apply_consents WHERE id = ?", (named["consent_id"],))
        if row is None or row["decision"] != "accept" or row["voided_at"] is not None or row["capability_id"] != claims.get("id"):
            return False
        if (row["request_id"], row["suggestion_id"], row["suggestion_digest"], row["principal"], row["controller_id"], row["created_at"]) \
                != (c.get("request_id"), p.get("suggestion_id"), p.get("suggestion_digest"), c.get("issuer"), claims.get("actor"),
                    named.get("accepted_at")):
            return False
        newest = self.db.one("SELECT id FROM copy_apply_consents WHERE request_id = ? AND suggestion_id = ? "
                             "ORDER BY created_at DESC, rowid DESC LIMIT 1", (row["request_id"], row["suggestion_id"]))
        return newest is not None and newest["id"] == row["id"]

    def _copy_apply_consent(self, agent, binding, spent_by, replay):
        """The one consent this issue may use, or the refusal: 403 consent_required (none live for this exact proposal),
        409 consent_stale (a live consent for this proposal, given before it or its request binding changed). A replay
        of the operation that spent a consent re-issues under that consent while it has not expired or been voided;
        after that, a replay needs a fresh accept like any other issue."""
        p, t = binding["proposal"], time.time()
        want = self._consent_binding_digest(binding["request_id"], binding["lease_id"], binding["controller_id"], binding["issuer"],
                                            binding["origin_grant_id"], binding["execution_goal"], binding["origin"])
        rows = self.db.all("SELECT * FROM copy_apply_consents WHERE request_id = ? AND suggestion_id = ? AND decision = 'accept' "
                           "AND voided_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC",
                           (binding["request_id"], p["suggestion_id"], t))
        exact = lambda r: r["suggestion_digest"] == p["suggestion_digest"] and r["binding_digest"] == want \
            and r["controller_id"] == agent["id"] and r["principal"] == binding["issuer"]
        if replay:      # the consent this operation already spent, while it lives; else a fresh one, as for a new issue
            row = next((r for r in rows if r["spent_by"] == spent_by and exact(r)), None)
            if row is not None:
                return row
        live = [r for r in rows if r["spent_at"] is None]
        row = next((r for r in live if exact(r)), None)
        if row is not None:
            return row
        if live:
            raise self.err(409, "consent_stale", "the person accepted this proposal before it or its request binding changed; "
                           "they accept the current proposal again")
        declined = self.db.one("SELECT decision FROM copy_apply_consents WHERE request_id = ? AND suggestion_id = ? "
                               "AND suggestion_digest = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                               (binding["request_id"], p["suggestion_id"], p["suggestion_digest"]))
        raise self.err(403, "consent_required", "the request's person has not accepted and confirmed this exact proposal",
                       reason="declined" if declined and declined["decision"] == "decline" else "no_consent")

    def issue_copy_apply(self, agent, member_token, data):
        """POST /api/agent/code/capability {service, copy_apply}: the request's controller asks for the one-proposal
        copy capability. Idempotent under mind_operations scope capply:<controller_id>: a replay returns the same binding
        with a freshly signed token (a new capability id; the binding's earlier capability is revoked, so one lives)."""
        if not self.hive.settings.copy_apply_claims:
            raise self.err(503, "copy_apply_off", "copy_apply capabilities are off on this hive (HIVE_COPY_APPLY_CLAIMS)")
        body = self._copy_apply_body(data)
        scope, op = f"capply:{agent['id']}", body["operation_id"]
        digest = sha(canonical({"route": "copy_apply", "body": data}))
        services = self.hive.services
        svc = services.by_name("omegacode")
        proposal = body["proposal"]
        with self.db.transaction():                 # one write: checks, binding, operation record and capability together
            recorded = self._replay(scope, op, digest)
            binding, task, lease, exp = self._copy_apply_binding(agent, body)
            if recorded is not None and json.loads(recorded[1])["copy_apply"] != binding:
                raise self.err(409, "operation_conflict", "this operation_id is bound to another copy binding")
            consent = self._copy_apply_consent(agent, binding, f"{scope}/{op}", replay=recorded is not None)
            # the capability never outlives the person's consent window: an application lands only inside the time they
            # agreed to, the window Surface's "with your OK" checks (Code consent-reference r1 audit, OI-4)
            exp = min(exp, int(consent["expires_at"]))
            if exp <= int(time.time()):
                raise self.err(403, "consent_required", "that consent ends before this capability could be used",
                               reason="consent_spent")
            key = (binding["request_id"], proposal["suggestion_id"], proposal["suggestion_digest"])
            held = self.db.one("SELECT * FROM copy_apply_bindings WHERE request_id = ? AND suggestion_id = ? AND suggestion_digest = ?", key)
            if held and (held["controller_id"], held["operation_id"]) != (agent["id"], op):
                if self._controller_current(held["controller_id"], lease):
                    raise self.err(409, "binding_exists", "this proposal already has a live copy binding")
                # its controller is no longer current: that binding is not live, so this controller takes the proposal over
            if recorded is None:
                self._record(scope, op, digest, 200, {"copy_apply": binding})
            if held and held["capability_id"]:
                services.revoke_capability(held["capability_id"])
            issued = services.issue(svc["id"], actor=agent["id"], kind="agent", task_id=binding["origin"]["task_id"],
                                    swarm_id=task["swarm_id"], repository_id=binding["origin"]["repository_id"],
                                    actions=["proposal-apply"], max_runs=0, max_runtime_seconds=0, member_token=member_token,
                                    grant_id=lease["grant_id"], by="host:minds", copy_apply=binding, exp=exp,
                                    copy_apply_consent={"consent_id": consent["id"], "accepted_at": consent["created_at"]})
            self.db.execute("INSERT OR REPLACE INTO copy_apply_bindings VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (*key, agent["id"], op, issued["claims"]["id"], held["created_at"] if held else now()))
            # spend the consent with the capability, by one conditional write (two racing issues cannot both pass), and
            # re-check its expiry at the spend instant (stand-in consent r1 P2): a consent that expired while this issue
            # ran refuses here, and the raise rolls the capability and binding back with it
            spent = time.time()
            cur = self.db.execute("UPDATE copy_apply_consents SET spent_at = COALESCE(spent_at, ?), spent_by = ?, capability_id = ? "
                                  "WHERE id = ? AND voided_at IS NULL AND expires_at > ? AND (spent_at IS NULL OR spent_by = ?)",
                                  (spent, f"{scope}/{op}", issued["claims"]["id"], consent["id"], spent, f"{scope}/{op}"))
            if cur.rowcount != 1:
                raise self.err(403, "consent_required", "that consent expired, was spent or was withdrawn", reason="consent_spent")
        return issued

    def copy_apply_reason(self, claims):
        """(None, status) while a copy_apply capability may act; otherwise (why it is withdrawn, status). The same checks
        as issuance, re-run on every status call; order: consent_withdrawn (r3), not_controller, request_closed, lease_expired,
        origin_grant_read_only."""
        c = claims.get("copy_apply")
        status = {"request_open": False, "lease_live": False, "controller_current": False}
        if not isinstance(c, dict) or not isinstance(c.get("origin"), dict):
            return "malformed", status
        req, lease = self._request(c.get("request_id")), self._lease(c.get("lease_id"))
        origin = self._request_origin(req) or {}
        status["controller_current"] = bool(lease) and claims.get("actor") == c.get("controller_id") \
            and lease["request_id"] == c.get("request_id") and self._controller_current(claims.get("actor"), lease)
        status["request_open"] = self.request_open(req) and req["receiving_goal"] == c.get("execution_goal") \
            and all(origin.get(k) == v for k, v in c["origin"].items())
        status["lease_live"] = self.lease_live(lease) and lease["issued_by"] == c.get("issuer") \
            and lease["grant_id"] == claims.get("grant_id") == c.get("origin_grant_id")
        if not self._consent_current(claims):
            return "consent_withdrawn", status
        if not status["controller_current"]:
            return "not_controller", status
        if not status["request_open"]:
            return "request_closed", status
        if not status["lease_live"]:
            return "lease_expired", status
        grant = self.db.one("SELECT * FROM goal_grants WHERE id = ?", (claims.get("grant_id"),))
        if not self._grant_edits(grant, c.get("issuer"), claims.get("task_id"), c["origin"].get("workspace_id")):
            return "origin_grant_read_only", status
        task = self.db.one("SELECT status FROM goals WHERE id = ?", (claims.get("task_id"),))
        if task is None or task["status"] not in OPEN_TASK:
            return "task_closed", status
        return None, status
