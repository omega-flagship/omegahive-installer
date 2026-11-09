"""Linkage slice 4: the proposal-test plane, host side (linkage spec r3.6 §b,
PLATFORM_ASK_R2_13_LINKAGE_SPEC_DRAFT_20261006.md; settlement wire PLATFORM_SETTLEMENT_WIRE_FIELD_ANSWERS_20261006.md).

- Issuance (b.1/b.2): the request's controller asks POST /api/agent/code/capability {service, proposal_test} for a
  host-issued claim with actions ["proposal-test"] only, max_runs 0 (launches go only through holds), the operator's argv
  prefixes and stage prepare | run | result. Creation is idempotent under mind_operations scope ptest:<controller>.
  prepare/run carry the lease's grant_id; result carries grant_id null and origin_grant_id for reporting only.
- Live status (c.1/c.2): Services.capability_status runs the generic checks first, then ``reason`` below.
- Preparation binding (b.5), run and time holds (b.6) and the settlement and hold wire (b.6.1) are service routes under
  /api/services/proposal-tests/, Code's service token only. Every answer of b.5/b.6/b.6.1 is minds.canonical bytes; a
  replay answers its recorded bytes before any authority check, and a refusal records nothing.
- Holds are runs and integer seconds in their own table (never USD), on the cost_reservations state-machine pattern; no
  timer and no startup sweep ever releases one. Observations are insert-only (SQLite triggers refuse UPDATE and DELETE).
- Withdrawal ends a test withdrawn:<reason> (persisted): in the same transaction as a request cancel or grant revoke,
  and lazily (status, re-issue, bind, admission, the reconcile cycle) for lease expiry, demotion, controller change,
  lease replacement or grant expiry. Holds are never touched; the result stage's 7-day window counts from ended_at.
- Off unless the operator sets HIVE_PROPOSAL_TEST_CLAIMS=on and HIVE_PROPOSAL_TEST_ARGV_PREFIXES (launcher env file).
The purpose routes themselves (b.7/b.8: launch custody, prepare, launches, GET, cancel) are Code's; nothing here spawns.
"""

from __future__ import annotations

import datetime
import json
import re
import secrets
import time

from .db import now
from .minds import DIGEST, OPEN_TASK, OPERATION, REQUEST_ID, SUGGESTION_ID, WORKSPACE_ID, Minds, _int, _utc_now, canonical, \
    parse_time, sha, stamp
from .services import PROPOSAL_TEST_RUNTIME, PROPOSAL_TEST_SECONDS

TEST_ID = re.compile(r"pt_[0-9a-f]{24}")
RUN_ID = re.compile(r"run_[A-Za-z0-9_-]{1,120}")
BODY_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z")   # b.6.1 (r3.5): kept verbatim
STAGES = ("prepare", "run", "result")
# OPEN-4, provisional upper bounds only (no paid spend, no USD cap)
TEST_RUNS, TEST_SECONDS, REQUEST_RUNS, REQUEST_SECONDS = 4, 600, 8, 1800
MAX_OPEN_TESTS = 8
RESULT_WINDOW = datetime.timedelta(days=7)
MAX_SECONDS = 86400
NON_TERMINAL_CAP = 15            # r3.5: 15 non-terminal observations plus 1 reserved terminal slot
SERVICE_BODY_MAX = 16 * 1024     # §G rule 6
OUTCOMES = ("completed", "failed", "cancelled", "withdrawn", "not_started", "unknown")
PROVENANCE = ("executor_measured", "wall_clock_bound", "unknown")
LAUNCH_STATES = ("never_spawning", "spawning", "running", "ended")
CHARGED = ("dispatched", "unknown", "settled")
TERMINAL = ("settled", "released")
NULL_FORK = {"workspace_id": None, "preparation_digest": None}
USD = {"metered": False, "status": "unknown", "advisory_remaining_usd": None}
HOLD_KEYS = ("hold_id", "test_id", "request_id", "launch_key", "argv_digest", "runtime_seconds_max", "state", "run_id",
             "cleanup", "accounting", "charged_seconds", "overrun_seconds", "observation_count", "created_at", "settled_at")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS proposal_tests (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, request_id TEXT NOT NULL,
  lease_id TEXT NOT NULL, controller_id TEXT NOT NULL, operation_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
  proposal_digest TEXT NOT NULL, normalized_hunks_digest TEXT NOT NULL, parent_workspace_id TEXT NOT NULL,
  parent_generation INTEGER NOT NULL, parent_tree_digest TEXT NOT NULL, preparation TEXT, bind_request_digest TEXT,
  bind_response TEXT, admission_closed TEXT CHECK (admission_closed IS NULL OR admission_closed = 'overrun'),
  created_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT, grant_id TEXT)""",
    """CREATE INDEX IF NOT EXISTS proposal_tests_request ON proposal_tests(request_id)""",
    """CREATE TABLE IF NOT EXISTS proposal_test_holds (id TEXT PRIMARY KEY, test_id TEXT NOT NULL, request_id TEXT NOT NULL,
  launch_key TEXT NOT NULL, capability_id TEXT NOT NULL, argv_digest TEXT NOT NULL, runtime_seconds_max INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatched', 'unknown', 'settled', 'released')), run_id TEXT,
  cleanup TEXT NOT NULL CHECK (cleanup IN ('unobserved', 'observed')),
  accounting TEXT NOT NULL CHECK (accounting IN ('reserved_max', 'executor_measured', 'wall_clock_bound', 'none')),
  charged_seconds INTEGER NOT NULL, overrun_seconds INTEGER NOT NULL, observation_count INTEGER NOT NULL,
  created_at TEXT NOT NULL, settled_at TEXT, admission_digest TEXT NOT NULL, admission_response TEXT,
  UNIQUE (test_id, launch_key))""",
    """CREATE INDEX IF NOT EXISTS proposal_test_holds_request ON proposal_test_holds(request_id)""",
    """CREATE TABLE IF NOT EXISTS hold_observations (hold_id TEXT NOT NULL, seq INTEGER NOT NULL, body_digest TEXT NOT NULL,
  body TEXT NOT NULL, state_before TEXT NOT NULL, state_after TEXT NOT NULL, received_at TEXT NOT NULL, response TEXT NOT NULL,
  UNIQUE (hold_id, seq), UNIQUE (hold_id, body_digest))""",
    # b.6.1 (r3.5): observation rows and their recorded responses are insert-only, never overwritten, deleted or reused
    """CREATE TRIGGER IF NOT EXISTS hold_observations_insert_only_u BEFORE UPDATE ON hold_observations
  BEGIN SELECT RAISE(ABORT, 'hold_observations are insert-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS hold_observations_insert_only_d BEFORE DELETE ON hold_observations
  BEGIN SELECT RAISE(ABORT, 'hold_observations are insert-only'); END""",
    # b.6: run_id is immutable once set; the recorded admission answer is never rewritten; holds are never deleted
    """CREATE TRIGGER IF NOT EXISTS proposal_test_holds_run_id BEFORE UPDATE OF run_id ON proposal_test_holds
  WHEN OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id
  BEGIN SELECT RAISE(ABORT, 'a hold run_id is immutable once set'); END""",
    """CREATE TRIGGER IF NOT EXISTS proposal_test_holds_admission BEFORE UPDATE OF admission_response, admission_digest,
  launch_key, test_id, request_id, runtime_seconds_max ON proposal_test_holds WHEN OLD.admission_response IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a recorded admission is never rewritten'); END""",
    """CREATE TRIGGER IF NOT EXISTS proposal_test_holds_kept BEFORE DELETE ON proposal_test_holds
  BEGIN SELECT RAISE(ABORT, 'holds are never deleted'); END""",
]


def _bytes(value):
    return canonical(value).encode("utf-8")


def _exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def _match(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _body_time(value):
    """b.6.1 (r3.5) embedded body timestamp: RFC 3339 UTC Z with 0-6 fractional digits AND a real calendar date and time
    (no month 99, no 25:00, no Feb 30, no leap second the host cannot verify). Valid input is kept verbatim by the caller."""
    if not _match(BODY_TIME, value):
        return False
    try:
        datetime.datetime(int(value[0:4]), int(value[5:7]), int(value[8:10]), int(value[11:13]), int(value[14:16]),
                          int(value[17:19]))
    except ValueError:
        return False
    return True


class ProposalTests:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        if "grant_id" not in {r["name"] for r in self.db.all("PRAGMA table_info(proposal_tests)")}:
            # r3: the origin grant a test was created under (its lease's grant then), so revoking it ends the test
            # whatever its lease carries now; rows from r1/r2 read it from their lease
            self.db.execute("ALTER TABLE proposal_tests ADD COLUMN grant_id TEXT")
        self.fault = lambda step: None      # test hook (W18): called inside the settle transaction after the insert

    @property
    def minds(self):
        return self.hive.minds

    def err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    def _test(self, test_id):
        return self.db.one("SELECT * FROM proposal_tests WHERE id = ?", (str(test_id or ""),))

    def _current_lease(self, request_id):
        """The request's current lease: its newest (a later lease replaces an earlier one, c.2 `replaced`)."""
        return self.db.one("SELECT * FROM mind_leases WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                           (request_id,))

    def _team_controller(self, agent_id, lease):
        team = self.db.one("SELECT * FROM swarms WHERE id = ?", (lease["team_id"],)) if lease else None
        return bool(team) and agent_id in self.minds.controllers(team)

    def _grant_active(self, lease, origin):
        grant = self.db.one("SELECT * FROM goal_grants WHERE id = ?", (lease["grant_id"],)) if lease and lease["grant_id"] else None
        return bool(grant) and not grant["revoked_at"] and grant["expires_at"] > time.time() \
            and grant["principal"] == lease["issued_by"] and grant["goal_id"] == (origin or {}).get("task_id")

    def _creation_grant_active(self, test, lease, origin):
        """The grant the test was created under (r1/r2 rows: their lease's grant) is still active."""
        grant_id = test.get("grant_id") or lease["grant_id"]
        if grant_id == lease["grant_id"]:
            return self._grant_active(lease, origin)
        return self._grant_active(dict(lease, grant_id=grant_id), origin)

    def _task_open(self, origin):
        task = self.db.one("SELECT status FROM goals WHERE id = ?", ((origin or {}).get("task_id"),))
        return bool(task) and task["status"] in OPEN_TASK

    @staticmethod
    def _bound_fork(test):
        if not test or not test["preparation"]:
            return None
        prep = json.loads(test["preparation"])
        return {"workspace_id": prep["fork_workspace_id"], "preparation_digest": prep["preparation_digest"]}

    # ---- c.4 / b.8: host-owned withdrawal endings (persisted; holds are never touched) --------------------------------

    def _withdrawal(self, test):
        """Why an open test's own authority is withdrawn (from its own lease, request and creation grant, never from a
        caller's claim), else None. First match, every label reachable:
        - lease_replaced: the request's current lease is not the test's own lease_id. Evaluated first, so a replacement
          that also changes the controller is stamped as the replacement. (No production path creates a second lease for a
          request today, minds.py instruct; this guards the c.2 `replaced` state for when one does.)
        - not_controller: the test's controller is no longer its lease's controller or in controllers(team).
        - request_closed: the request was cancelled, or its receiving goal is terminal (done, failed or cancelled). One
          label for both, exactly c.2's; the request-cancel hook stamps it in the cancel transaction.
        - grant_withdrawn: the grant the test was created under, or its lease's grant, is revoked or expired.
        - lease_revoked: the lease ended, or its issuer is no longer a current admin.
        - lease_expired: the lease's until has passed.
        - task_closed: the origin task is closed while the request is still open (closing the origin task does not
          cancel the request)."""
        lease, req = self.minds._lease(test["lease_id"]), self.minds._request(test["request_id"])
        origin = self.minds._request_origin(req)
        current = self._current_lease(test["request_id"])
        if lease is None or current is None or current["id"] != test["lease_id"]:
            return "lease_replaced"
        if lease["controller_id"] != test["controller_id"] or not self._team_controller(test["controller_id"], lease):
            return "not_controller"
        if not self.minds.request_open(req):
            return "request_closed"
        if not self._grant_active(lease, origin) or not self._creation_grant_active(test, lease, origin):
            return "grant_withdrawn"
        if lease["ended_at"] or not self.minds._admin_current(lease["issued_by"]):
            return "lease_revoked"
        if lease["until"] <= now():
            return "lease_expired"
        if not self._task_open(origin):
            return "task_closed"
        return None

    def _end(self, where, params, reason):
        """End the matching open tests withdrawn:<reason>, in the caller's transaction (or its own). Holds are unchanged."""
        with self.db.transaction():
            return self.db.execute(f"UPDATE proposal_tests SET ended_at = ?, ended_reason = ? WHERE ended_at IS NULL AND {where}",
                                   (now(), f"withdrawn:{reason}", *params)).rowcount

    def sweep(self, test_id):
        """Lazily persist a withdrawal the host did not see happen (lease expiry, issuer demoted, controller reassigned,
        grant expiry). Returns the current test row (None when there is no such test)."""
        with self.db.transaction():
            test = self._test(test_id)
            if test is None or test["ended_at"]:
                return test
            reason = self._withdrawal(test)
            if reason is not None:
                self._end("id = ?", (test["id"],), reason)
                test = self._test(test_id)
            return test

    def sweep_request(self, request_id):
        for row in self.db.all("SELECT id FROM proposal_tests WHERE request_id = ? AND ended_at IS NULL", (request_id,)):
            self.sweep(row["id"])

    def request_cancelled(self, request_id):
        """Hook: Minds.request_cancelled, in the same transaction that ends the request's lease."""
        return self._end("request_id = ?", (request_id,), "request_closed")

    def grant_revoked(self, grant_id):
        """Hook: Services.revoke_grant, in the same transaction that revokes the grant and its capabilities."""
        # by the grant the test was created under AND by its lease's grant now, so neither identity escapes a revocation
        return self._end("(grant_id = ? OR lease_id IN (SELECT id FROM mind_leases WHERE grant_id = ?))", (grant_id, grant_id),
                         "grant_withdrawn")

    def reconcile(self):
        """Hook: Minds.reconcile, the periodic cycle that catches lazy causes (lease until, grant expiry, demotion)."""
        for row in self.db.all("SELECT id FROM proposal_tests WHERE ended_at IS NULL"):
            self.sweep(row["id"])

    @staticmethod
    def _result_window_open(test):
        if not test["ended_at"]:
            return True
        ended = parse_time(test["ended_at"])
        return ended is not None and _utc_now() < ended + RESULT_WINDOW

    # ---- aggregates (b.6): runs and integer seconds, per test and per request ---------------------------------------

    def _used(self, column, value):
        row = self.db.one(f"SELECT COUNT(*) AS runs, COALESCE(SUM(charged_seconds), 0) AS seconds FROM proposal_test_holds "
                          f"WHERE {column} = ? AND state IN ('dispatched', 'unknown', 'settled')", (value,))
        return int(row["runs"]), int(row["seconds"])

    def _allowance(self, test, lease):
        t_runs, t_secs = self._used("test_id", test["id"])
        r_runs, r_secs = self._used("request_id", test["request_id"])
        test_left = {"runs_remaining": max(0, TEST_RUNS - t_runs), "runtime_seconds_remaining": max(0, TEST_SECONDS - t_secs)}
        request_left = {"runs_remaining": max(0, REQUEST_RUNS - r_runs),
                        "runtime_seconds_remaining": max(0, REQUEST_SECONDS - r_secs)}
        until = parse_time(lease["until"]) if lease else None
        to_until = max(0, int((until - _utc_now()).total_seconds())) if until else 0
        per_launch = min(PROPOSAL_TEST_RUNTIME, test_left["runtime_seconds_remaining"],
                         request_left["runtime_seconds_remaining"], to_until)
        if not test_left["runs_remaining"] or not request_left["runs_remaining"]:
            per_launch = 0
        return {"until": lease["until"] if lease else None, "per_launch_max_runtime_seconds": per_launch,
                "test": test_left, "request": request_left, "usd": dict(USD)}

    # ---- b.1 issuance ------------------------------------------------------------------------------------------------

    CREATE_FIELDS = ("operation_id", "request_id", "proposal", "parent")
    PROPOSAL_FIELDS = ("proposal_id", "proposal_digest", "normalized_hunks_digest")

    def _create_body(self, body):
        Minds._fields(body, self.CREATE_FIELDS)
        missing = [k for k in self.CREATE_FIELDS if k not in body]
        if missing:
            raise Minds._bad(f"missing fields: {missing}")
        self.minds._operation(body)
        if not _match(REQUEST_ID, body["request_id"]):
            raise Minds._bad("request_id is the request's rq_ id")
        self._proposal(body["proposal"])
        parent = body["parent"]
        if not _exact(parent, ("generation", "tree_digest")):
            # B5: the parent workspace is host-derived from the request's origin; a caller-supplied one is refused
            raise Minds._bad("parent is exactly {generation, tree_digest}; the parent workspace comes from the request's origin")
        if not _int(parent["generation"], 1, 2 ** 53) or not _match(DIGEST, parent["tree_digest"]):
            raise Minds._bad("parent.generation is a whole number from 1 and parent.tree_digest is sha256:<64 hex>")

    def _proposal(self, proposal):
        if not _exact(proposal, self.PROPOSAL_FIELDS):
            raise Minds._bad(f"proposal is exactly {list(self.PROPOSAL_FIELDS)}")
        if not _match(SUGGESTION_ID, proposal["proposal_id"]):
            raise Minds._bad("proposal.proposal_id is suggestion_<32 hex>")
        if not _match(DIGEST, proposal["proposal_digest"]) or not _match(DIGEST, proposal["normalized_hunks_digest"]):
            raise Minds._bad("proposal_digest and normalized_hunks_digest are sha256:<64 hex>")

    def issue(self, agent, member_token, data, by="host:proposal_tests"):
        """POST /api/agent/code/capability {service, proposal_test}: create (or replay) a test, or re-issue a stage claim."""
        settings = self.hive.settings
        if not settings.proposal_test_claims or not settings.proposal_test_argv_prefixes:
            raise self.err(503, "proposal_tests_off", "proposal_test capabilities are off on this hive (HIVE_PROPOSAL_TEST_CLAIMS "
                                                      "and HIVE_PROPOSAL_TEST_ARGV_PREFIXES)")
        Minds._fields(data, ("service", "proposal_test", "actions"))
        if str(data.get("service") or "omegacode") != "omegacode":
            raise Minds._bad("proposal_test is an omegacode capability")
        if "actions" in data and data["actions"] != ["proposal-test"]:
            raise self.err(400, "bad_actions", "a proposal_test capability carries exactly ['proposal-test']")
        body = data.get("proposal_test")
        if not isinstance(body, dict):
            raise Minds._bad("proposal_test is an object")
        if "test_id" in body:
            return self._reissue(agent, member_token, body, by)
        self._create_body(body)
        scope, op = f"ptest:{agent['id']}", body["operation_id"]
        digest = sha(canonical({"route": "proposal_test", "body": data}))
        svc = self.hive.services.by_name("omegacode")
        self.sweep_request(body["request_id"])       # own transaction: a refusal below never rolls a withdrawal ending back
        with self.db.transaction():          # one write: checks, replacement, test row, operation record and capability
            recorded = self.minds._replay(scope, op, digest)       # a different payload under this id: 409 operation_conflict
            req = self.minds._request(body["request_id"])
            if req is None:
                raise self.err(404, "not_found", f"no request {body['request_id']}")
            lease = self._current_lease(req["id"])
            test = self._test(json.loads(recorded[1])["test_id"]) if recorded is not None else None
            if test is not None and (lease is None or lease["id"] != test["lease_id"]):
                # never combine lease identities: a replay of a test whose lease was replaced issues nothing
                raise self.err(403, "lease_required", "the test's lease was replaced")
            if test is not None and test["ended_at"]:
                # a persisted ending answers before any live-authority check (the sweep above stamped any lazy cause)
                raise self.err(409, "test_ended", f"that test ended ({test['ended_reason']})", ended_reason=test["ended_reason"])
            self._check_controller(agent, lease)
            origin = self._check_live(req, lease)
            if test is None:
                proposal, parent = body["proposal"], body["parent"]
                at = now()
                self.db.execute("UPDATE proposal_tests SET ended_at = ?, ended_reason = 'replaced' WHERE request_id = ? AND "
                                "proposal_id = ? AND proposal_digest != ? AND ended_at IS NULL",
                                (at, req["id"], proposal["proposal_id"], proposal["proposal_digest"]))
                open_tests = self.db.one("SELECT COUNT(*) AS n FROM proposal_tests WHERE request_id = ? AND ended_at IS NULL",
                                         (req["id"],))["n"]
                if open_tests >= MAX_OPEN_TESTS:
                    raise self.err(409, "test_limit", f"a request has at most {MAX_OPEN_TESTS} open tests")
                test = {"id": "pt_" + secrets.token_hex(12), "service_id": svc["id"], "request_id": req["id"],
                        "lease_id": lease["id"], "controller_id": agent["id"], "operation_id": op, **proposal,
                        "parent_workspace_id": origin["workspace_id"], "parent_generation": parent["generation"],
                        "parent_tree_digest": parent["tree_digest"], "preparation": None, "bind_request_digest": None,
                        "bind_response": None, "admission_closed": None, "created_at": at, "ended_at": None, "ended_reason": None,
                        "grant_id": lease["grant_id"]}
                self.db.insert("proposal_tests", test)
                self.minds._record(scope, op, digest, 200, {"test_id": test["id"]})
            stage = "run" if test["preparation"] else "prepare"
            return self._issue_stage(agent, member_token, test, stage, req, lease, origin, by)

    def _check_controller(self, agent, lease, test=None):
        """Checks 1 and 2: not a child; the lease's controller (and the test's), still in controllers(team)."""
        if self.minds.is_child(agent["id"]):
            raise self.err(403, "not_controller", "a delegated child never runs a proposal test", reason="delegated_child")
        if lease is None:
            raise self.err(403, "lease_required", "this request has no lease")
        if lease["controller_id"] != agent["id"] or not self._team_controller(agent["id"], lease) \
                or (test is not None and test["controller_id"] != agent["id"]):
            raise self.err(403, "not_controller", "only the request's current controller runs its proposal tests")

    def _check_live(self, req, lease):
        """Checks 3-5: request open and lease live; the origin grant active and the origin task open; the parent workspace
        host-derived from the request's origin (never the body)."""
        if not self.minds.request_open(req):
            raise self.err(409, "request_closed", "the request is cancelled or finished")
        if not self.minds.lease_live(lease):
            raise self.err(403, "lease_required", "the request's lease is no longer live")
        origin = self.minds._request_origin(req)
        if origin is None or not lease["grant_id"]:
            raise self.err(403, "capability_withdrawn", "this request carries no person origin", reason="no_origin")
        if not self._grant_active(lease, origin):
            raise self.err(403, "capability_withdrawn", "the issuer's origin grant is no longer active", reason="grant_withdrawn")
        if not self._task_open(origin):
            raise self.err(403, "capability_withdrawn", "the origin task is closed", reason="task_closed")
        text = lambda v: isinstance(v, str) and 0 < len(v) <= 200
        if not (_match(WORKSPACE_ID, origin.get("workspace_id")) and text(origin.get("repository_id"))
                and text(origin.get("scope_id")) and _match(DIGEST, origin.get("scope_digest"))
                and _int(origin.get("generation"), 1, 2 ** 53)):
            raise self.err(409, "origin_invalid", "the request's origin is not a Code workspace scope a test can bind")
        return origin

    def _reissue(self, agent, member_token, body, by="host:proposal_tests"):
        Minds._fields(body, ("test_id", "stage"))
        if not _match(TEST_ID, body["test_id"]):
            raise Minds._bad("test_id is pt_<24 hex>")
        stage = body.get("stage")
        if "stage" in body and stage not in STAGES:
            raise Minds._bad(f"stage is one of {list(STAGES)}")
        self.sweep(body["test_id"])                 # own transaction, kept even when this re-issue is refused
        with self.db.transaction():
            test = self._test(body["test_id"])
            if test is None:
                raise self.err(404, "not_found", f"no test {body['test_id']}")
            req, lease = self.minds._request(test["request_id"]), self.minds._lease(test["lease_id"])
            origin = self.minds._request_origin(req)
            if stage == "result":
                # b.8: while the caller is still the test's controller and not a child, and the test exists (up to 7
                # days after it ended), even after the lease, request or grant lapsed
                if self.minds.is_child(agent["id"]):
                    raise self.err(403, "not_controller", "a delegated child never runs a proposal test", reason="delegated_child")
                if test["controller_id"] != agent["id"] or not self._team_controller(agent["id"], lease):
                    raise self.err(403, "not_controller", "only the test's controller reads its result")
                if not self._result_window_open(test):
                    raise self.err(409, "test_ended", "that test ended more than 7 days ago")
                if origin is None:
                    raise self.err(403, "capability_withdrawn", "this request carries no person origin", reason="no_origin")
                return self._issue_stage(agent, member_token, test, "result", req, lease, origin, by)
            current = self._current_lease(test["request_id"])
            self._check_controller(agent, current, test)
            if test["ended_at"]:
                raise self.err(409, "test_ended", f"that test ended ({test['ended_reason']})")
            if current is None or current["id"] != test["lease_id"]:
                raise self.err(403, "lease_required", "the test's lease was replaced")
            origin = self._check_live(req, lease)
            bound = self._bound_fork(test)
            stage = stage or ("run" if bound else "prepare")
            if stage == "prepare" and bound:
                raise self.err(409, "already_bound", "this test is already bound; re-issue run, or replay the original bind",
                               bound_fork=bound)
            if stage == "run" and not bound:
                raise self.err(409, "not_bound", "this test has no bound preparation yet")
            return self._issue_stage(agent, member_token, test, stage, req, lease, origin, by)

    def _issue_stage(self, agent, member_token, test, stage, req, lease, origin, by="host:proposal_tests"):
        at = int(time.time())
        until = int(parse_time(lease["until"]).timestamp())
        exp = at + PROPOSAL_TEST_SECONDS if stage == "result" else min(at + PROPOSAL_TEST_SECONDS, until)
        bound = self._bound_fork(test)
        claim = {
            "purpose": "proposal-test", "stage": stage, "test_id": test["id"], "request_id": test["request_id"],
            "lease_id": test["lease_id"], "controller_id": test["controller_id"], "execution_goal": req["receiving_goal"],
            "issuer": lease["issued_by"],
            "origin_scope": {"scope_id": origin["scope_id"], "scope_digest": origin["scope_digest"],
                             "generation": origin["generation"]},
            "proposal": {k: test[k] for k in self.PROPOSAL_FIELDS},
            "parent": {"workspace_id": test["parent_workspace_id"], "generation": test["parent_generation"],
                       "tree_digest": test["parent_tree_digest"]},
            # r3.3: prepare is always null; run is the bound fork; result is the bound fork at issue, or null if never bound
            "fork": dict(NULL_FORK) if stage == "prepare" or bound is None else bound,
            "allowance": self._allowance(test, lease)}
        if stage == "result":
            claim["origin_grant_id"] = lease["grant_id"]      # reporting only (b.2): the claim's own grant_id is null
        task = self.db.one("SELECT swarm_id FROM goals WHERE id = ?", (origin["task_id"],))
        return self.hive.services.issue(
            test["service_id"], actor=agent["id"], kind="agent", task_id=origin["task_id"],
            swarm_id=task["swarm_id"] if task else None, repository_id=origin["repository_id"], actions=["proposal-test"],
            argv_prefixes=self.hive.settings.proposal_test_argv_prefixes, max_runs=0,
            max_runtime_seconds=PROPOSAL_TEST_RUNTIME, member_token=member_token,
            grant_id=None if stage == "result" else lease["grant_id"], by=by, proposal_test=claim, exp=exp)

    # ---- c.1/c.2 live status ------------------------------------------------------------------------------------------

    def reason(self, claims):
        """(None, status) while a proposal_test capability may act; otherwise (why it is withdrawn, status). status adds
        the c.1 fields: stage, lease, test and origin. Called by Services.capability_status after the generic checks."""
        pt = claims.get("proposal_test")
        if not isinstance(pt, dict) or pt.get("stage") not in STAGES:
            return "malformed", {}
        stage, actor = pt["stage"], claims.get("actor")
        if isinstance(pt.get("test_id"), str):
            self.sweep(pt["test_id"])
        test, lease, req = self._test(pt.get("test_id")), self.minds._lease(pt.get("lease_id")), self.minds._request(pt.get("request_id"))
        origin = self.minds._request_origin(req)
        current = self._current_lease(req["id"]) if req else None
        request_open = self.minds.request_open(req)
        grant_active = self._grant_active(lease, origin)
        lease_state = None
        if lease:
            if current is None or current["id"] != lease["id"] or (test and test["ended_reason"] == "replaced"):
                lease_state = "replaced"
            elif lease["ended_at"] or not self.minds._admin_current(lease["issued_by"]) or not grant_active or not request_open:
                lease_state = "revoked"
            elif lease["until"] <= now():
                lease_state = "expired"
            else:
                lease_state = "active"
        bound = self._bound_fork(test)
        status = {
            "stage": stage,
            "lease": {"lease_id": lease["id"], "state": lease_state, "until": lease["until"]} if lease else None,
            "test": {"test_id": test["id"], "state": "ended" if test["ended_at"] else "open", "ended_reason": test["ended_reason"],
                     "bound_fork": bound, "admission_closed": test["admission_closed"]} if test else None,
            "origin": {"grant": "active" if grant_active else "withdrawn", "task": "open" if self._task_open(origin) else "closed",
                       "request": "open" if request_open else "closed"}}
        if stage != "result" and test is not None and test["ended_at"]:
            # once ended, the persisted ended_reason is the status reason (never a recomputed, possibly different cause)
            ended = test["ended_reason"] or ""
            return (ended[len("withdrawn:"):] if ended.startswith("withdrawn:") else "test_ended"), status
        if self.minds.is_child(actor):
            return "delegated_child", status
        controller = bool(test) and bool(lease) and actor == test["controller_id"] == pt.get("controller_id") \
            and (test["request_id"], test["lease_id"]) == (pt.get("request_id"), pt.get("lease_id")) \
            and self._team_controller(actor, lease)
        claim_fork = pt.get("fork")
        if stage == "result":
            # r3.1 clarification 3: inactive only for its own revocation/expiry (generic), not_controller, delegated_child,
            # or the test missing or past its 7-day window; lease/request/grant/task losses are reported, never decisive
            if not controller:
                return "not_controller", status
            if not self._result_window_open(test):
                return "test_ended", status
            if claim_fork != NULL_FORK and claim_fork != bound:
                return "fork_mismatch", status
            return None, status
        if not controller or lease["controller_id"] != actor:
            return "not_controller", status
        if not request_open or req["receiving_goal"] != pt.get("execution_goal"):
            return "request_closed", status
        if lease_state != "active" or lease["issued_by"] != pt.get("issuer") or claims.get("grant_id") != lease["grant_id"]:
            return {"replaced": "lease_replaced", "expired": "lease_expired"}.get(lease_state, "lease_revoked"), status
        if stage == "prepare":
            # r3.3: a prepare claim's fork is null for its whole lifetime and is never compared with bound_fork
            return (None if claim_fork == NULL_FORK else "malformed"), status
        if bound is None or claim_fork != bound:
            return "fork_mismatch", status
        return None, status

    # ---- service ownership (b.5 step 1, b.6 step 1, b.6.1 step 1) -----------------------------------------------------

    def _owned_test(self, service, test_id):
        test = self._test(test_id) if _match(TEST_ID, test_id) else None
        if test is None:
            raise self.err(404, "not_found", f"no test {test_id}")
        if test["service_id"] != service["id"]:
            raise self.err(403, "service_mismatch", "that test belongs to another service")
        return test

    def _owned_capability(self, service, test, capability_id):
        """The named capability must exist, be this service's, and belong to this test. Nothing else is checked yet."""
        row = self.db.one("SELECT * FROM capabilities WHERE id = ?", (capability_id,)) if isinstance(capability_id, str) else None
        claims = json.loads(row["claims"]) if row else {}
        pt = claims.get("proposal_test")
        if row is None or row["service_id"] != service["id"] or not isinstance(pt, dict) or pt.get("test_id") != test["id"]:
            raise self.err(403, "service_mismatch", "that capability is not this service's capability for this test")
        return pt

    def _withdrawn(self, service, capability_id, stage, pt):
        """A new bind or admission: the capability is this test's <stage> claim and its live status is active."""
        if pt.get("stage") != stage:
            raise self.err(403, "capability_withdrawn", f"this needs the test's {stage} capability", reason=f"not_{stage}_stage")
        status = self.hive.services.capability_status(service, capability_id)
        if not status["active"]:
            raise self.err(403, "capability_withdrawn", f"the capability is not active: {status['reason']}", reason=status["reason"])

    # ---- b.5 preparation binding --------------------------------------------------------------------------------------

    BIND_FIELDS = ("capability_id", "operation_id", "fork_workspace_id", "proposal", "parent", "test_tree_digest",
                   "preparation_digest")

    def _bind_body(self, data):
        if not _exact(data, self.BIND_FIELDS):
            raise Minds._bad(f"the bind body is exactly {list(self.BIND_FIELDS)}")
        self.minds._operation(data)
        if not _match(WORKSPACE_ID, data["fork_workspace_id"]):
            raise Minds._bad("fork_workspace_id is ws_<32 hex>")
        self._proposal(data["proposal"])
        parent = data["parent"]
        if not _exact(parent, ("workspace_id", "generation", "tree_digest")) or not _match(WORKSPACE_ID, parent["workspace_id"]) \
                or not _int(parent["generation"], 1, 2 ** 53) or not _match(DIGEST, parent["tree_digest"]):
            raise Minds._bad("parent is exactly {workspace_id: ws_<32 hex>, generation, tree_digest: sha256:<64 hex>}")
        if not _match(DIGEST, data["test_tree_digest"]) or not _match(DIGEST, data["preparation_digest"]):
            raise Minds._bad("test_tree_digest and preparation_digest are sha256:<64 hex>")

    def bind(self, service, test_id, data):
        """POST /api/services/proposal-tests/{test_id}/preparation -> (201, recorded bytes)."""
        test = self._owned_test(service, test_id)
        pt = self._owned_capability(service, test, data.get("capability_id"))
        self._bind_body(data)
        digest = sha(canonical(data))
        # Sweep first, in its own transaction, so a refusal below never rolls a withdrawal ending back. It is safe before
        # the replay: an ending changes only the test row, and the replay answers from the recorded bind alone.
        self.sweep(test["id"])
        with self.db.transaction():
            test = self._test(test["id"])
            if test["preparation"]:          # replay before a new bind, whatever the capability, lease, request or grant now
                if digest == test["bind_request_digest"]:
                    return 201, test["bind_response"].encode("utf-8")
                if data["operation_id"] == json.loads(test["preparation"])["operation_id"]:
                    raise self.err(409, "operation_conflict", "this operation_id bound the test with a different body")
                raise self.err(409, "fork_mismatch", "this test is already bound to another preparation",
                               bound_fork=self._bound_fork(test))
            self._withdrawn(service, data["capability_id"], "prepare", pt)
            parent = {"workspace_id": test["parent_workspace_id"], "generation": test["parent_generation"],
                      "tree_digest": test["parent_tree_digest"]}
            if data["proposal"] != {k: test[k] for k in self.PROPOSAL_FIELDS} or data["parent"] != parent:
                raise self.err(409, "fork_mismatch", "the proposal or parent differs from the test")
            bound_at = stamp(_utc_now())
            answer = {"test_id": test["id"], "fork_workspace_id": data["fork_workspace_id"],
                      "test_tree_digest": data["test_tree_digest"], "preparation_digest": data["preparation_digest"],
                      "bound_at": bound_at}
            prep = {k: data[k] for k in ("fork_workspace_id", "test_tree_digest", "preparation_digest", "operation_id",
                                         "capability_id")} | {"bound_at": bound_at}
            text = canonical(answer)
            cur = self.db.execute("UPDATE proposal_tests SET preparation = ?, bind_request_digest = ?, bind_response = ? "
                                  "WHERE id = ? AND preparation IS NULL", (canonical(prep), digest, text, test["id"]))
            if cur.rowcount != 1:
                raise self.err(409, "fork_mismatch", "this test was bound concurrently")
        return 201, text.encode("utf-8")

    # ---- b.6 admission ------------------------------------------------------------------------------------------------

    def admit(self, service, test_id, data):
        """POST /api/services/proposal-tests/{test_id}/holds -> (201, recorded bytes)."""
        test = self._owned_test(service, test_id)
        pt = self._owned_capability(service, test, data.get("capability_id"))
        if not _exact(data, ("capability_id", "launch_key", "argv_digest", "runtime_seconds")) \
                or not _match(OPERATION, data["launch_key"]) or not _match(DIGEST, data["argv_digest"]) \
                or not _int(data["runtime_seconds"], 1, PROPOSAL_TEST_RUNTIME):
            raise Minds._bad("the hold body is exactly {capability_id, launch_key: 8-120 of [A-Za-z0-9_.:-], "
                             "argv_digest: sha256:<64 hex>, runtime_seconds: 1-600}")
        digest = sha(canonical(data))
        # Sweep first, in its own transaction (see bind). Endings never touch holds, and the replay below answers from the
        # recorded admission alone, so an ending can never change a replayed answer.
        self.sweep(test["id"])
        with self.db.transaction():
            hold = self.db.one("SELECT * FROM proposal_test_holds WHERE test_id = ? AND launch_key = ?", (test["id"], data["launch_key"]))
            if hold is not None:     # replay before a new admission: no authority check runs, nothing is created
                if hold["admission_digest"] == digest:
                    return 201, hold["admission_response"].encode("utf-8")
                raise self.err(409, "operation_conflict", "this launch_key was admitted with a different body")
            test = self._test(test["id"])
            self._withdrawn(service, data["capability_id"], "run", pt)
            if not test["preparation"]:
                raise self.err(409, "not_bound", "this test has no bound preparation")
            if test["admission_closed"]:
                raise self.err(409, "admission_closed", f"this test is closed to new holds ({test['admission_closed']})")
            lease = self.minds._lease(test["lease_id"])
            room = self._allowance(test, lease)
            if data["runtime_seconds"] > room["per_launch_max_runtime_seconds"]:
                raise self.err(409, "allowance_exhausted", "no room for this run under the test and request allowances",
                               allowance=room)
            hold_id = "ph_" + secrets.token_hex(12)
            self.db.insert("proposal_test_holds", {
                "id": hold_id, "test_id": test["id"], "request_id": test["request_id"], "launch_key": data["launch_key"],
                "capability_id": data["capability_id"], "argv_digest": data["argv_digest"],
                "runtime_seconds_max": data["runtime_seconds"], "state": "dispatched", "run_id": None, "cleanup": "unobserved",
                "accounting": "reserved_max", "charged_seconds": data["runtime_seconds"], "overrun_seconds": 0,
                "observation_count": 0, "created_at": stamp(_utc_now()), "settled_at": None, "admission_digest": digest,
                "admission_response": None})
            text = canonical({"hold_id": hold_id, "launch_key": data["launch_key"], "state": "dispatched",
                              "runtime_seconds": data["runtime_seconds"], "allowance": self._allowance(test, lease)})
            self.db.execute("UPDATE proposal_test_holds SET admission_response = ? WHERE id = ?", (text, hold_id))
        return 201, text.encode("utf-8")

    # ---- b.6.1 settlement and the hold wire ---------------------------------------------------------------------------

    @staticmethod
    def hold_view(row):
        return {"hold_id": row["id"], **{k: row[k] for k in HOLD_KEYS if k != "hold_id"}}

    @staticmethod
    def observation_view(row):
        return {"seq": row["seq"], "body_digest": row["body_digest"], "body": json.loads(row["body"]),
                "state_before": row["state_before"], "state_after": row["state_after"], "received_at": row["received_at"]}

    def _settle_body(self, data):
        bad = Minds._bad
        if not _exact(data, ("outcome", "run_id", "runtime", "cleanup", "evidence", "receipt_digest")):
            raise bad("the settle body is exactly {outcome, run_id, runtime, cleanup, evidence, receipt_digest}")
        outcome, run_id, runtime, cleanup, evidence = (data[k] for k in ("outcome", "run_id", "runtime", "cleanup", "evidence"))
        if outcome not in OUTCOMES:
            raise bad(f"outcome is one of {list(OUTCOMES)}")
        if run_id is not None and not _match(RUN_ID, run_id):
            raise bad("run_id is run_<id> or null")
        if not _exact(runtime, ("seconds", "provenance")) or runtime["provenance"] not in PROVENANCE:
            raise bad(f"runtime is exactly {{seconds, provenance}}, provenance one of {list(PROVENANCE)}")
        seconds = runtime["seconds"]
        if seconds is not None and not _int(seconds, 0, MAX_SECONDS):
            raise bad(f"runtime.seconds is a whole number from 0 to {MAX_SECONDS}, or null (never a boolean)")
        if (runtime["provenance"] == "unknown") != (seconds is None):
            raise bad("provenance unknown goes with seconds null, and a known provenance with whole seconds")
        if run_id is not None and seconds is not None and seconds < 1:
            raise bad("a spawned run with a known duration reports at least 1 second (rounded up)")
        if outcome == "not_started" and run_id is not None:
            raise bad("not_started carries run_id null")
        if outcome not in ("not_started", "unknown") and run_id is None:
            raise bad(f"{outcome} carries the run's run_id")
        if not _exact(cleanup, ("descendants_stopped", "observed_at")) or type(cleanup["descendants_stopped"]) is not bool:
            raise bad("cleanup is exactly {descendants_stopped: true|false, observed_at}")
        stamp_in = cleanup["observed_at"]
        if stamp_in is not None and not _body_time(stamp_in):
            raise bad("cleanup.observed_at is a real RFC 3339 UTC date and time with Z and 0-6 fractional digits, or null")
        if cleanup["descendants_stopped"] and stamp_in is None:
            raise bad("cleanup.observed_at is required when descendants_stopped is true")
        if not _exact(evidence, ("launch_record_state", "launch_record_rev")) or evidence["launch_record_state"] not in LAUNCH_STATES \
                or not _int(evidence["launch_record_rev"], 0, 2 ** 53):
            raise bad(f"evidence is exactly {{launch_record_state: one of {list(LAUNCH_STATES)}, launch_record_rev: a whole number}}")
        if data["receipt_digest"] is not None and not _match(DIGEST, data["receipt_digest"]):
            raise bad("receipt_digest is sha256:<64 hex> or null")

    @staticmethod
    def _charge(hold, data):
        """The b.6 charging table: (state, cleanup, accounting, charged_seconds, overrun_seconds) after this body."""
        maximum, seconds = hold["runtime_seconds_max"], data["runtime"]["seconds"]
        if data["outcome"] == "not_started":
            return "released", "observed", "none", 0, 0
        if data["outcome"] == "unknown" or not data["cleanup"]["descendants_stopped"]:
            return "unknown", "unobserved", "reserved_max", maximum, 0
        if seconds is None:
            return "settled", "observed", "reserved_max", maximum, 0
        return "settled", "observed", data["runtime"]["provenance"], seconds, max(0, seconds - maximum)

    def _hold(self, service, test_id, hold_id):
        test = self._owned_test(service, test_id)
        hold = self.db.one("SELECT * FROM proposal_test_holds WHERE id = ? AND test_id = ?", (str(hold_id or ""), test["id"]))
        if hold is None:
            raise self.err(404, "not_found", f"no hold {hold_id} in this test")
        return test, hold

    def settle(self, service, test_id, hold_id, data):
        """POST …/holds/{hold_id}/settle -> (200, bytes): a new accepted body, or the recorded bytes of an identical one."""
        test, hold = self._hold(service, test_id, hold_id)
        self._settle_body(data)
        text = canonical(data)
        digest = sha(text)
        with self.db.transaction():          # BEGIN IMMEDIATE: competing bodies serialize; no await inside
            hold = self.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (hold["id"],))
            seen = self.db.one("SELECT response FROM hold_observations WHERE hold_id = ? AND body_digest = ?", (hold["id"], digest))
            if seen is not None:             # replay first: at every limit, after the terminal transition, whatever the state
                return 200, seen["response"].encode("utf-8")
            if hold["state"] in TERMINAL:
                raise self.err(409, "hold_settled", f"this hold is {hold['state']}", hold=self.hold_view(hold))
            if hold["run_id"] is not None and data["run_id"] != hold["run_id"]:
                raise self.err(409, "run_mismatch", "this hold is bound to another run", hold_run_id=hold["run_id"])
            if data["outcome"] == "not_started" and (data["evidence"]["launch_record_state"] != "never_spawning"
                                                     or hold["state"] != "dispatched"):
                raise self.err(400, "not_started_unproven", "not_started releases a hold only from dispatched, with "
                                                            "launch_record_state never_spawning")
            state, cleanup, accounting, charged, overrun = self._charge(hold, data)
            if state == "unknown":
                non_terminal = self.db.one("SELECT COUNT(*) AS n FROM hold_observations WHERE hold_id = ? AND state_after = 'unknown'",
                                           (hold["id"],))["n"]
                if non_terminal >= NON_TERMINAL_CAP:
                    raise self.err(409, "observation_limit", "the non-terminal observations are full; the terminal slot is reserved",
                                   hold=self.hold_view(hold), terminal_slot_reserved=True)
            last = self.db.one("SELECT MAX(received_at) AS at FROM hold_observations WHERE hold_id = ?", (hold["id"],))["at"]
            received = max(stamp(_utc_now()), last or "")
            seq = hold["observation_count"] + 1
            self.db.execute("UPDATE proposal_test_holds SET state = ?, cleanup = ?, accounting = ?, charged_seconds = ?, "
                            "overrun_seconds = ?, run_id = ?, observation_count = ?, settled_at = ? WHERE id = ? AND observation_count = ?",
                            (state, cleanup, accounting, charged, overrun, hold["run_id"] or data["run_id"], seq,
                             received if state in TERMINAL else None, hold["id"], hold["observation_count"]))
            if overrun:   # the executor's time bound failed: this test takes no new holds; the request total is reduced
                self.db.execute("UPDATE proposal_tests SET admission_closed = 'overrun' WHERE id = ? AND admission_closed IS NULL",
                                (test["id"],))
            after = self.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (hold["id"],))
            observation = {"seq": seq, "body_digest": digest, "body": data, "state_before": hold["state"], "state_after": state,
                           "received_at": received}
            response = canonical({"hold": self.hold_view(after), "observation": observation})
            self.db.execute("INSERT INTO hold_observations (hold_id, seq, body_digest, body, state_before, state_after, received_at, "
                            "response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (hold["id"], seq, digest, text, hold["state"], state, received, response))
            self.fault("settle_after_insert")
        return 200, response.encode("utf-8")

    def _snapshot(self, hold):
        rows = self.db.all("SELECT * FROM hold_observations WHERE hold_id = ? ORDER BY seq", (hold["id"],))
        return _bytes({"hold": self.hold_view(hold), "observations": [self.observation_view(r) for r in rows]})

    def read(self, service, test_id, hold_id):
        """GET …/holds/{hold_id} -> {hold, observations}: current state, never recorded, no live authority needed."""
        _, hold = self._hold(service, test_id, hold_id)
        return 200, self._snapshot(hold)

    def read_by_key(self, service, test_id, launch_key):
        """GET …/holds?launch_key= -> {hold, observations}, or {hold: null, observations: []} when never admitted."""
        test = self._owned_test(service, test_id)
        if not _match(OPERATION, launch_key):
            raise Minds._bad("launch_key is 8-120 of [A-Za-z0-9_.:-]")
        hold = self.db.one("SELECT * FROM proposal_test_holds WHERE test_id = ? AND launch_key = ?", (test["id"], launch_key))
        return 200, (self._snapshot(hold) if hold else _bytes({"hold": None, "observations": []}))
