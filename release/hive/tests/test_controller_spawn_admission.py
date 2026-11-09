
"""Source-only bounded component tests: actual Minds/DB/budget code, inert host/process seams.

No Hive/create_app, PeTTa, API, provider, key, model or real person is constructed.
Foundation fixture values are the narrow admission-interface contract, not proof
of actual Foundation owner/binding validation. Root must select the exact files,
fresh resources and owned runtime before any collection/import/execution.
"""
import asyncio
import contextlib
import datetime
import importlib.util
import json
import pathlib
import sys
import threading
from types import SimpleNamespace

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / "hive/core"
TEAM = "s_" + "1" * 32
CONTROLLER = "a_" + "2" * 32
ADMIN = "u_" + "3" * 32
PRINCIPAL = "user:" + ADMIN
TEMPLATE = "foundation.code-helper.v1"


class ComponentError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details


@pytest.fixture
def modules(monkeypatch):
    # Whole production modules, in their original package context; no body extraction.
    monkeypatch.syspath_prepend(str(ROOT))
    from hive.core.db import Database, new_id, now
    from hive.core.budgets import Budgets
    import hive.core
    cost_spec = importlib.util.spec_from_file_location(
        "hive.core.cost_reservations", CANDIDATE / "cost_reservations.py")
    cost = importlib.util.module_from_spec(cost_spec)
    monkeypatch.setitem(sys.modules, cost_spec.name, cost)
    monkeypatch.setattr(hive.core, "cost_reservations", cost, raising=False)
    cost_spec.loader.exec_module(cost)
    minds_spec = importlib.util.spec_from_file_location(
        "hive.core._controller_budget_candidate_minds", CANDIDATE / "minds.py")
    minds = importlib.util.module_from_spec(minds_spec)
    monkeypatch.setitem(sys.modules, minds_spec.name, minds)
    minds_spec.loader.exec_module(minds)
    assert minds.pending_micros is cost.pending_micros
    return SimpleNamespace(Database=Database, new_id=new_id, now=now, Budgets=Budgets,
                           cost=cost, minds=minds)


class InertHost:
    """Only identity records and host presentation/process seams are synthetic."""
    def __init__(self, modules, path):
        self.modules = modules
        self.db = modules.Database(path)
        self.settings = SimpleNamespace(
            mind_spawn=True, mind_spawn_operator_off=False,
            mind_templates=[dict(template_id=TEMPLATE, harness="native", model_id="mock/echo",
                                 role_id=None, max_allocation_usd=.5,
                                 overridable={"model_id": []}, controls=["stop", "retire"],
                                 lifecycle_modes=["deliver", "bounded"], teams=[TEAM])],
            hive_budget_usd=0, swarm_monthly_usd=100, budget_env={},
            person_request_ceiling_usd=1)
        for name, ddl in [
            ("archived_at", "TEXT"), ("coordinator_id", "TEXT"), ("parent_mind_id", "TEXT"),
            ("visibility", "TEXT"), ("owner", "TEXT"), ("shared_with", "TEXT")]:
            self.db.execute("ALTER TABLE swarms ADD COLUMN " + name + " " + ddl)
        self.db.execute("CREATE TABLE people (id TEXT PRIMARY KEY, role TEXT, disabled INTEGER)")
        self.db.execute("CREATE TABLE session_caps (rule_id TEXT, agent_id TEXT, base_limit REAL, installed REAL)")
        self.db.execute("""CREATE TABLE requests (
            id TEXT PRIMARY KEY, kind TEXT, title TEXT, from_swarm TEXT, from_goal TEXT, from_principal TEXT,
            to_swarm TEXT, receiving_goal TEXT, subject TEXT, context_refs TEXT, constraints TEXT,
            acceptance TEXT, budget_root TEXT, limit_usd REAL, allocated_usd REAL, ancestry TEXT, depth INTEGER,
            cancelled_at TEXT, created_at TEXT, connection_id TEXT, idem_key TEXT, idem_digest TEXT)""")
        self.db.execute("""CREATE TABLE goal_grants (
            id TEXT PRIMARY KEY, goal_id TEXT, principal TEXT, revoked_at REAL, expires_at REAL)""")
        self.db.insert("people", dict(id=ADMIN, role="admin", disabled=0))
        self.db.insert("swarms", dict(id=TEAM, name="synthetic", hue=1, created_at=modules.now(),
                                     coordinator_id=CONTROLLER, shared_with="[]"))
        self.db.insert("agents", self.agent_row(CONTROLLER, .5))
        self.ownhive = SimpleNamespace(
            rules=lambda *a: [], subjects=lambda *a: [], grantee_for=lambda *a: None)
        self.budgets = modules.Budgets(self)
        self.costs = modules.cost.Reservations(self.db)
        self.minds = modules.minds.Minds(self)
        self.started = []
        self.finished = []
        self.sent = []
        self.emitted = []
        self.prepare_hook = None
        self.barrier = None
        self._locks = {}
        self._locks_guard = threading.Lock()
        self.minds._start_now = self.started.append
        self.minds.emit = self.emitted.append
        async def send(child, message):
            self.sent.append((child, message))
        self.minds._send = send
        self.refusals = {}
        self.collab = SimpleNamespace(services=lambda _team: ["code"], request_view=lambda row: row)
        self.events = SimpleNamespace(publish=lambda *a, **kw: None)
        self.goals = SimpleNamespace(_create_record=self.create_goal, _emit=lambda *_: None,
                                     announce=self.announce)

    @staticmethod
    def error(status, code, message, details=None):
        return ComponentError(status, code, message, details)

    def agent_row(self, ident, budget):
        return dict(id=ident, name="synthetic", kind="omega", swarm_id=TEAM, model="mock/echo",
                    persona="", hue=1, status="running", desired="running", driver="native",
                    budget_usd=budget, spent_usd=0, token_hash="not-an-auth-token",
                    created_at=self.modules.now(), deleted=0)

    def agent(self, ident):
        row = self.db.one("SELECT * FROM agents WHERE id=?", (ident,))
        if row is None:
            raise self.error(404, "not_found", "synthetic missing agent")
        return row

    _agent_row = agent

    def require_open_swarm(self, ident):
        row = self.db.one("SELECT * FROM swarms WHERE id=?", (ident,))
        if row is None or row["archived_at"]:
            raise self.error(409, "swarm_closed", "synthetic swarm is closed")
        return row

    def new_agent_row(self, name, kind, team, model, persona, _hue, allocation, _options, _role, **kw):
        row = self.agent_row(self.modules.new_id("a"), allocation)
        row.update(name=name, kind=kind, swarm_id=team, model=model, persona=persona,
                   status="stopped", desired="stopped")
        if self.prepare_hook:
            hook, self.prepare_hook = self.prepare_hook, None
            hook()
        return row, "synthetic-never-used-token", _role

    def insert_into_open_swarm(self, table, row, team):
        self.require_open_swarm(team)
        self.db.insert(table, row)

    def finish_agent(self, row, token, role, by=None):
        self.finished.append((row["id"], by))
        self.finished_roles = getattr(self, "finished_roles", []) + [(row["id"], role, by)]

    def _mind_lock(self, ident):
        with self._locks_guard:
            return self._locks.setdefault(ident, threading.RLock())

    @contextlib.contextmanager
    def swarm_membership(self, _team):
        # No synthetic global fence: the actual DB transaction serializes budgets.
        if self.barrier:
            self.barrier.wait(timeout=5)
        yield

    async def announce(self, _row):
        return None

    def create_goal(self, swarm, title, detail, priority, created_by, **kw):
        ident = self.modules.new_id("g")
        row = dict(id=ident, swarm_id=swarm, title=title, detail=detail, priority=priority,
                   status="open", created_by=created_by, created_at=self.modules.now(),
                   updated_at=self.modules.now())
        self.db.insert("goals", row)
        return row

    def seed_request(self, limit=1, max_children=4):
        rid, gid, lid = [self.modules.new_id(p) for p in ("rq", "g", "ls")]
        self.db.insert("goals", dict(id=gid, swarm_id=TEAM, title="synthetic request", priority=.5,
                                   status="open", created_by=PRINCIPAL, created_at=self.modules.now(),
                                   updated_at=self.modules.now()))
        self.db.insert("requests", dict(id=rid, to_swarm=TEAM, receiving_goal=gid, budget_root=rid,
                                      limit_usd=limit, allocated_usd=0, cancelled_at=None))
        until = self.modules.minds.stamp(
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=300))
        self.db.insert("mind_leases", dict(id=lid, request_id=rid, controller_id=CONTROLLER,
                                         team_id=TEAM, template_ids=json.dumps([TEMPLATE]),
                                         max_children=max_children, ceiling_usd=limit, until=until,
                                         issued_by=PRINCIPAL, grant_id="synthetic-grant",
                                         created_at=self.modules.now(), ended_at=None, ended_reason=None))
        return rid, lid

    def spawn_body(self, request, op="spawn:synthetic:0001", allocation=.25):
        return dict(operation_id=op, request_id=request, team_id=TEAM, template_id=TEMPLATE,
                    initial_prompt="synthetic component only", allocation_usd=allocation,
                    model_id=None, lifecycle_mode="deliver", lifecycle_limits=None)

    async def spawn(self, body):
        return await self.minds.spawn(self.agent(CONTROLLER), body)

    def count_children(self):
        return self.db.one("SELECT COUNT(*) AS n FROM mind_children")["n"]

    def own_hold(self, amount=.2):
        return self.costs.reserve("synthetic-own-hold", {"operation": "own"}, amount,
                                 lambda: self.modules.cost.host_budget_snapshot(self, CONTROLLER), metadata={"agent": CONTROLLER},
                                 subjects=["hive", "agent:" + CONTROLLER])

    def bind_foundation(self):
        limits = dict(controller_usd=.50, request_usd=.25, child_usd=.25, max_children=1,
                      lifetime_seconds=600, template_ids=(TEMPLATE,),
                      binding=(PRINCIPAL, "code", TEAM, CONTROLLER, "synthetic-bound-version"))
        self.foundation_limits = limits
        self.foundation = SimpleNamespace(
            controller_ceiling=lambda agent: .50 if agent == CONTROLLER else None,
            prepare_request=lambda team: None,
            admission_limits=lambda team, controller=None:
                dict(self.foundation_limits) if team == TEAM else None,
            spawn_enabled=lambda team: team == TEAM)
        return limits

    def instruction(self, limit=.25, max_children=1, seconds=300):
        task = self.create_goal("s_" + "4" * 32, "origin", "", .5, PRINCIPAL)
        self.db.insert("goal_grants", dict(id=self.modules.new_id("gr"), goal_id=task["id"],
                                         principal=PRINCIPAL, revoked_at=None,
                                         expires_at=__import__("time").time()+1200))
        return dict(operation_id="request:synthetic:0001", kind="code", to_swarm=TEAM,
                    title="synthetic instruction", instruction="component test only",
                    origin=dict(task_id=task["id"], repository_id="repo:synthetic",
                                workspace_id="ws_"+"5"*32, scope_id="scope:synthetic",
                                scope_digest="sha256:"+"6"*64, generation=1),
                    budget={"limit_usd": limit},
                    lifetime={"until": self.modules.minds.stamp(
                        datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=seconds))},
                    lease={"template_ids": [TEMPLATE], "max_children": max_children})


@pytest.fixture
def world(modules, tmp_path):
    w = InertHost(modules, tmp_path / "control.sqlite")
    try:
        yield w
    finally:
        w.db._conn.close()


@pytest.mark.parametrize("spent,held", [(.5, 0), (.4, .1), (.1, .4)])
def test_exhausted_controller_spend_and_own_liabilities_refuse_before_insert(world, spent, held):
    w = world
    w.db.execute("UPDATE agents SET spent_usd=? WHERE id=?", (spent, CONTROLLER))
    if held:
        w.own_hold(held)
    rid, _ = w.seed_request()
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code == "spend_limit"
    assert w.count_children() == 0
    assert w.db.one("SELECT allocated_usd FROM requests WHERE id=?", (rid,))["allocated_usd"] == 0
    assert not w.started and not w.finished and not w.sent


def test_existing_child_allocation_blocks_a_second_request(world):
    w = world
    r1, _ = w.seed_request()
    r2, _ = w.seed_request()
    assert asyncio.run(w.spawn(w.spawn_body(r1, allocation=.3)))[0] == 201
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(r2, "spawn:synthetic:0002", .3)))
    assert exc.value.code == "spend_limit"
    assert w.count_children() == 1


def test_competing_requests_are_atomic_on_the_original_database_lock(world):
    w = world
    r1, _ = w.seed_request()
    r2, _ = w.seed_request()
    w.barrier = threading.Barrier(2)
    async def race():
        return await asyncio.gather(w.spawn(w.spawn_body(r1, allocation=.3)),
                                    w.spawn(w.spawn_body(r2, "spawn:synthetic:0002", .3)),
                                    return_exceptions=True)
    results = asyncio.run(race())
    assert sorted(r[0] if isinstance(r, tuple) else r.status for r in results) == [201, 402]
    assert w.count_children() == 1 and len(w.started) == len(w.finished) == 1
    assert w.db.one("SELECT SUM(allocated_usd) AS n FROM requests")["n"] == .3


def test_concurrent_exact_operation_replays_without_double_allocation(world):
    w = world
    rid, _ = w.seed_request()
    w.barrier = threading.Barrier(2)
    body = w.spawn_body(rid)
    async def race():
        return await asyncio.gather(w.spawn(body), w.spawn(body))
    first, second = asyncio.run(race())
    assert first == second and first[0] == 201
    assert w.count_children() == 1 and len(w.started) == len(w.finished) == 1
    assert w.db.one("SELECT allocated_usd FROM requests WHERE id=?", (rid,))["allocated_usd"] == .25


def test_success_replay_does_not_spend_again_after_budget_or_switch_drift(world):
    w = world
    rid, _ = w.seed_request()
    body = w.spawn_body(rid)
    first = asyncio.run(w.spawn(body))
    w.db.execute("UPDATE agents SET spent_usd=budget_usd WHERE id=?", (CONTROLLER,))
    w.settings.mind_spawn = False
    assert asyncio.run(w.spawn(body)) == first
    assert w.count_children() == 1 and len(w.started) == 1


@pytest.mark.parametrize("drift", ["template", "team", "lease_end", "controller_cap"])
def test_atomic_commit_rechecks_current_bindings_and_budget(world, drift):
    w = world
    rid, lid = w.seed_request()
    def change():
        with w.db.transaction():
            if drift == "template":
                w.minds.templates[TEMPLATE] = {**w.minds.templates[TEMPLATE], "model_id": "mock/drift"}
            elif drift == "team":
                w.db.execute("UPDATE swarms SET name='changed' WHERE id=?", (TEAM,))
            elif drift == "lease_end":
                w.db.execute("UPDATE mind_leases SET ended_at=? WHERE id=?", (w.modules.now(), lid))
            else:
                w.db.execute("UPDATE agents SET budget_usd=.1 WHERE id=?", (CONTROLLER,))
    w.prepare_hook = change
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code in {"spawn_binding_changed", "request_closed", "spend_limit"}
    assert w.count_children() == 0 and not w.started and not w.finished


def test_own_controller_reservation_after_spawn_sees_child_commitment(world):
    w = world
    rid, _ = w.seed_request()
    asyncio.run(w.spawn(w.spawn_body(rid, allocation=.4)))
    with pytest.raises(w.modules.cost.BudgetExhausted):
        w.costs.reserve("synthetic-own-after", {"operation": "own-after"}, .2,
                        lambda: w.modules.cost.host_budget_snapshot(w, CONTROLLER),
                        metadata={"agent": CONTROLLER}, subjects=["hive", "agent:"+CONTROLLER])
    assert w.count_children() == 1


@pytest.mark.parametrize("field,value", [
    ("allocation", .26), ("request_limit", .26), ("lease_count", 2),
    ("lease_time", 900), ("template", "other")])
def test_foundation_spawn_applies_narrow_request_child_and_lease_caps(world, field, value):
    w = world
    w.bind_foundation()
    rid, lid = w.seed_request(limit=.25, max_children=1)
    body = w.spawn_body(rid)
    if field == "allocation":
        body["allocation_usd"] = value
        w.db.execute("UPDATE requests SET limit_usd=.5 WHERE id=?", (rid,))
    elif field == "request_limit":
        w.db.execute("UPDATE requests SET limit_usd=? WHERE id=?", (value, rid))
    elif field == "lease_count":
        w.db.execute("UPDATE mind_leases SET max_children=? WHERE id=?", (value, lid))
    elif field == "lease_time":
        until = w.modules.minds.stamp(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=value))
        w.db.execute("UPDATE mind_leases SET until=? WHERE id=?", (until, lid))
    else:
        w.minds.templates[value] = {**w.minds.templates[TEMPLATE], "template_id": value}
        w.db.execute("UPDATE mind_leases SET template_ids=? WHERE id=?", (json.dumps([value]), lid))
        body["template_id"] = value
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(body))
    assert exc.value.code == "foundation_limits"
    assert w.count_children() == 0 and not w.started


def test_foundation_controller_cap_preserves_lower_actual_cap(world):
    w = world
    w.bind_foundation()
    w.db.execute("UPDATE agents SET budget_usd=.2 WHERE id=?", (CONTROLLER,))
    rid, _ = w.seed_request(.25, 1)
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code == "spend_limit" and w.count_children() == 0


def test_foundation_controller_ceiling_applies_when_stored_cap_is_higher(world):
    w = world
    w.bind_foundation()
    w.db.execute("UPDATE agents SET budget_usd=1, spent_usd=.3 WHERE id=?", (CONTROLLER,))
    rid, _ = w.seed_request(.25, 1)
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code == "spend_limit" and w.count_children() == 0


def test_foundation_one_child_count_is_per_request_not_reset_by_a_new_lease(world):
    w = world
    w.bind_foundation()
    rid, lid = w.seed_request(.25, 1)
    first = json.loads(asyncio.run(w.spawn(w.spawn_body(rid)))[1])
    # Seed the actual released/retired bookkeeping: a new lease cannot erase this lifetime count.
    with w.db.transaction():
        w.db.execute("UPDATE mind_children SET state='retired' WHERE id=?", (first["child_id"],))
        w.minds._release(first["child_id"])
        lease = dict(w.minds._lease(lid))
        lease["id"] = w.modules.new_id("ls")
        w.db.insert("mind_leases", lease)
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid, "spawn:synthetic:0002")))
    assert exc.value.code == "lease_required"
    assert w.count_children() == 1


@pytest.mark.parametrize("change", ["budget", "count", "template", "lifetime"])
def test_foundation_person_instruction_limits_use_actual_request_path(world, change):
    w = world
    w.bind_foundation()
    data = w.instruction()
    if change == "budget":
        data["budget"]["limit_usd"] = .26
    elif change == "count":
        data["lease"]["max_children"] = 2
    elif change == "template":
        w.minds.templates["other"] = {**w.minds.templates[TEMPLATE], "template_id": "other"}
        data["lease"]["template_ids"] = ["other"]
    else:
        data["lifetime"]["until"] = w.modules.minds.stamp(
            datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=900))
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.minds.instruct(PRINCIPAL, data))
    assert exc.value.code == "foundation_limits"
    assert w.db.one("SELECT COUNT(*) AS n FROM requests")["n"] == 0


def test_foundation_request_success_and_same_key_replay_keep_original_budget_and_lease(world):
    w = world
    w.bind_foundation()
    data = w.instruction()
    first = asyncio.run(w.minds.instruct(PRINCIPAL, data))
    assert first[0] == 201
    assert asyncio.run(w.minds.instruct(PRINCIPAL, data)) == first
    req = w.db.one("SELECT * FROM requests")
    lease = w.db.one("SELECT * FROM mind_leases")
    assert req["limit_usd"] == .25 and lease["max_children"] == 1
    assert json.loads(lease["template_ids"]) == [TEMPLATE]
    assert w.db.one("SELECT COUNT(*) AS n FROM requests")["n"] == 1


def test_explicit_operator_off_beats_foundation_exception_and_global_on(world):
    w = world
    w.bind_foundation()
    w.settings.mind_spawn_operator_off = True
    rid, _ = w.seed_request(.25, 1)
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code == "spawn_disabled" and not w.started


def test_foundation_exception_is_team_scoped_without_global_enable(world):
    w = world
    w.bind_foundation()
    w.settings.mind_spawn = False
    rid, _ = w.seed_request(.25, 1)
    assert w.minds._spawn_enabled(TEAM)
    assert not w.minds._spawn_enabled("s_" + "7" * 32)
    assert asyncio.run(w.spawn(w.spawn_body(rid)))[0] == 201


def test_foundation_binding_drift_between_preflight_and_commit_refuses(world):
    w = world
    w.bind_foundation()
    rid, _ = w.seed_request(.25, 1)
    def change():
        with w.db.transaction():
            w.foundation_limits["binding"] = (PRINCIPAL, "code", TEAM, CONTROLLER, "changed")
    w.prepare_hook = change
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid)))
    assert exc.value.code == "spawn_binding_changed"
    assert w.count_children() == 0 and not w.started


def test_zero_controller_cap_without_a_governing_hive_total_still_refuses(world):
    w = world
    w.db.execute("UPDATE agents SET budget_usd=0 WHERE id=?", (CONTROLLER,))
    rid, _ = w.seed_request()
    with pytest.raises(ComponentError) as exc:
        asyncio.run(w.spawn(w.spawn_body(rid, allocation=.01)))
    assert exc.value.code == "spend_limit" and w.count_children() == 0


def test_zero_controller_uses_original_governing_auto_limits_when_present(world):
    w = world
    w.db.execute("UPDATE agents SET budget_usd=0 WHERE id=?", (CONTROLLER,))
    w.budgets.set("hive", "month", 1000)
    rows = w.modules.cost.host_budget_snapshot(w, CONTROLLER)
    assert rows and not any(label == "agent:" + CONTROLLER + ":total" for label, _, _ in rows)
    assert all(limit > 0 for _, limit, _ in rows)
    rid, _ = w.seed_request()
    assert asyncio.run(w.spawn(w.spawn_body(rid, allocation=.01)))[0] == 201



@pytest.mark.parametrize("amount,accepted", [(.25, True), (.250001, False), (.60, False)])
def test_foundation_ceiling_also_bounds_own_controller_reserve_after_child(world, amount, accepted):
    w = world
    w.bind_foundation()
    w.db.execute("UPDATE agents SET budget_usd=1 WHERE id=?", (CONTROLLER,))
    rid, _ = w.seed_request(.25, 1)
    assert asyncio.run(w.spawn(w.spawn_body(rid)))[0] == 201
    rows = w.modules.cost.host_budget_snapshot(w, CONTROLLER)
    assert next(limit for label, limit, _ in rows if label == "agent:"+CONTROLLER+":total") == .50
    def reserve():
        return w.costs.reserve("foundation-own-after-child", {"unit": "own"}, amount,
                              lambda: w.modules.cost.host_budget_snapshot(w, CONTROLLER),
                              metadata={"agent": CONTROLLER}, subjects=["hive", "agent:"+CONTROLLER])
    if accepted:
        assert reserve()["new"] is True
        assert w.costs.pending("agent:"+CONTROLLER+":total") == 500000
    else:
        with pytest.raises(w.modules.cost.BudgetExhausted):
            reserve()
        assert w.costs.get("foundation-own-after-child") is None
    assert w.count_children() == 1


def test_foundation_helper_persona_and_its_role_come_with_the_spawn(world):
    """The request helper's guidance comes from the foundation and its proposal-only rules from its ROLE: the template's
    role_id reaches the new row, and finish_agent applies it (by the lease's issuer) before the child is started. No
    rules are seeded per agent any more."""
    w = world
    w.bind_foundation()
    w.foundation.child_persona = lambda template: "Invented helper guidance" if template["template_id"] == TEMPLATE else None
    w.minds.templates[TEMPLATE] = dict(w.minds.templates[TEMPLATE], role_id="role_invented_helper")
    rid, _ = w.seed_request(.25, 1)
    child = json.loads(asyncio.run(w.spawn(w.spawn_body(rid)))[1])["child_id"]
    assert w.agent(child)["persona"] == "Invented helper guidance"
    assert w.finished_roles == [(child, "role_invented_helper", PRINCIPAL)]


def test_spawn_without_foundation_helper_hooks_keeps_an_empty_persona(world):
    w = world
    w.bind_foundation()   # the narrow admission stub alone: no persona, no rules
    rid, _ = w.seed_request(.25, 1)
    child = json.loads(asyncio.run(w.spawn(w.spawn_body(rid)))[1])["child_id"]
    assert w.agent(child)["persona"] == ""
