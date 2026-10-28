"""Mind control phase one (r2.12, r2.12.1, r2.13, r2.13.1): the person instruction root, the controller's child routes,
the human team routes and the delegated capability. Fakes only: a fake supervisor and process table, mock models, no
provider calls."""
import asyncio
import datetime
import hashlib
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from hive.core import minds as minds_module
from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

DIGEST = "sha256:" + "ab" * 32


def later(**delta):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(**delta)).isoformat(timespec="seconds")


def person(hive, pid, role="admin"):
    token = secrets.token_urlsafe(24)
    hive.db.insert("people", {"id": pid, "email": f"{pid}@example.test", "name": pid, "role": role, "created_at": now()})
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": f"user:{pid}"})
    return {"Authorization": f"Bearer {token}"}


class World:
    pass


@pytest.fixture()
def w(client, monkeypatch):
    hive = client.app.state.hive
    assert hive.settings.mind_spawn is False            # the switch is off unless the operator turns it on
    sup, running, tokens = hive.supervisor, set(), {}
    sup.start = lambda aid: (sup.calls.append(("start", aid)), running.add(aid))
    sup.stop = lambda aid: (sup.calls.append(("stop", aid)), running.discard(aid))
    sup.prepare = lambda agent, token: tokens.__setitem__(agent["id"], token)
    sup.driver = lambda agent: type("D", (), {"name": "local", "status": staticmethod(lambda aid: "running" if aid in running else "absent")})()
    monkeypatch.setattr(hive.health, "mind_id", lambda: None)
    x = World()
    x.hive, x.running, x.tokens, x.client = hive, running, tokens, client
    x.quinn, x.ann, x.mia = person(hive, "u_quinn"), person(hive, "u_ann"), person(hive, "u_mia", role="member")
    origin = client.post("/api/swarms", json={"name": "Code local", "visibility": "public"}).json()
    x.team = client.post("/api/swarms", json={"name": "Coders", "visibility": "public"}).json()
    x.foreign = client.post("/api/swarms", json={"name": "Others", "visibility": "public"}).json()
    x.origin = origin
    mk = lambda name, swarm, budget=5: client.post("/api/agents", json={"name": name, "swarm_id": swarm["id"], "budget_usd": budget}).json()
    x.ctl, x.helper, x.fctl = mk("Lead", x.team), mk("Helper", x.team), mk("Other lead", x.foreign)
    for swarm, coordinator in ((x.team, x.ctl), (x.foreign, x.fctl)):
        client.patch(f"/api/swarms/{swarm['id']}", json={"coordinator_id": coordinator["id"]})
        client.put(f"/api/swarms/{swarm['id']}/services", json={"kinds": ["code"]})
    hive.minds.templates = hive.minds._load_templates([
        {"template_id": "native-a", "model_id": "mock/echo", "max_allocation_usd": 0.5, "overridable": {"model_id": ["mock/alt"]},
         "controls": ["interrupt", "stop", "pause", "resume", "retire"], "teams": [x.team["id"], x.foreign["id"]]},
        {"template_id": "native-b", "model_id": "mock/echo", "max_allocation_usd": 0.3, "controls": ["stop", "retire"],
         "lifecycle_modes": ["ongoing"], "teams": [x.team["id"]]}])
    assert hive.minds.template_errors == []
    x.task = asyncio.run(hive.goals.create(origin["id"], "Edit code: synthetic", created_by="user:u_quinn"))
    x.grant = hive.services.grant(x.task["id"], "user:u_quinn", "edit", None, 120, by="user:u_quinn")
    # One instruction lifetime per world, read from the clock once: a retry re-sends the same body, so every
    # instruction(w) is the same request unless a test overrides it (MesTTo flake: a per-call until crossed a second).
    x.until = later(hours=2)
    return x


def instruction(w, **over):
    body = {"operation_id": "op-request-1", "to_swarm": w.team["id"], "kind": "code", "title": "Fix the calculator",
            "instruction": "Make add() handle negatives.",
            "origin": {"task_id": w.task["id"], "repository_id": "synthetic", "workspace_id": "ws_1", "scope_id": "sc_1",
                       "scope_digest": DIGEST, "generation": 1},
            "budget": {"limit_usd": 0.8}, "lifetime": {"until": w.until},
            "lease": {"template_ids": ["native-a"], "max_children": 2}}
    body.update(over)
    return body


def submit(w, headers=None, **over):
    return w.client.post("/api/requests", headers=headers or w.quinn, json=instruction(w, **over))


def spawn_body(rq, team, **over):
    body = {"operation_id": "op-spawn-0001", "request_id": rq, "team_id": team["id"], "template_id": "native-a", "model_id": None,
            "initial_prompt": "Read the instruction (sha256:...) and propose.", "lifecycle_mode": "ongoing",
            "lifecycle_limits": None, "allocation_usd": 0.2}
    body.update(over)
    return body


def spawn(w, rq, agent=None, **over):
    return w.client.post("/api/agent/minds", headers=agent_headers(agent or w.ctl), json=spawn_body(rq, w.team, **over))


def enabled(w):
    w.hive.settings.mind_spawn = True


def accepted(w, **over):
    out = submit(w, **over)
    assert out.status_code == 201, out.text
    return out.json()


def child_status(w, child_id, agent=None):
    out = w.client.get("/api/agent/minds/status", headers=agent_headers(agent or w.ctl), params={"child_id": child_id})
    assert out.status_code == 200, out.text
    return out.json()["children"][0]


def control(w, child_id, action, op, agent=None):
    return w.client.post(f"/api/agent/minds/{child_id}/control", headers=agent_headers(agent or w.ctl),
                         json={"operation_id": op, "action": action})


def counts(hive):
    return {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in
            ("requests", "goals", "mind_leases", "mind_children", "mind_reservations", "agents", "mind_operations")}


# ---- disabled by default ---------------------------------------------------------------------------------

def test_spawning_is_off_by_default_and_refuses_before_anything_is_written(w):
    rq = accepted(w)
    before = counts(w.hive)
    out = spawn(w, rq["request_id"])
    assert out.status_code == 403 and out.json()["error"]["code"] == "spawn_disabled"
    assert counts(w.hive) == before and w.hive.collab.get_request(rq["request_id"])["allocated_usd"] == 0
    assert not [c for c in w.hive.supervisor.calls if c[0] == "start"]
    enabled(w)
    assert spawn(w, rq["request_id"]).status_code == 201       # same operation id: the refusal was never recorded


def test_the_switch_comes_from_the_launcher_environment(monkeypatch, tmp_path):
    from hive.core.config import load_settings
    monkeypatch.delenv("HIVE_MIND_SPAWN", raising=False)
    assert load_settings(data_dir=tmp_path).mind_spawn is False
    monkeypatch.setenv("HIVE_MIND_SPAWN", "1")
    monkeypatch.setenv("HIVE_MIND_TEMPLATES", json.dumps([{"template_id": "t1"}]))
    monkeypatch.setenv("HIVE_PERSON_REQUEST_CEILING_USD", "0.25")
    settings = load_settings(data_dir=tmp_path)
    assert settings.mind_spawn is True and settings.mind_templates == [{"template_id": "t1"}] and settings.person_request_ceiling_usd == 0.25
    monkeypatch.setenv("HIVE_MIND_TEMPLATES", "{not json")
    assert load_settings(data_dir=tmp_path).mind_templates == []


def test_a_template_without_stop_and_retire_is_refused_at_registration(w):
    good = {"template_id": "t", "model_id": "mock/echo", "max_allocation_usd": 1, "controls": ["stop", "retire"], "teams": ["s_x"]}
    out = w.hive.minds._load_templates([dict(good, controls=["stop"]), dict(good, max_allocation_usd=101), dict(good, harness="claude"),
                                        dict(good, teams=[]), good, good])
    assert list(out) == ["t"] and len(w.hive.minds.template_errors) == 5


def test_resume_is_refused_while_spawning_is_off(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    assert control(w, child, "pause", "op-pause-0001").status_code == 202
    w.hive.settings.mind_spawn = False
    out = control(w, child, "resume", "op-resume-001")
    assert out.status_code == 403 and out.json()["error"]["code"] == "spawn_disabled"
    assert child_status(w, child)["state"] == "paused"


# ---- r2.13: the person instruction root -----------------------------------------------------------------

def test_only_a_named_admin_person_submits_an_instruction(w):
    assert w.client.post("/api/requests", json=instruction(w)).json()["error"]["code"] == "person_required"   # operator password
    assert submit(w, headers=w.mia).json()["error"]["code"] == "person_required"                             # a member
    assert submit(w, headers=agent_headers(w.ctl)).status_code == 401                                         # a mind's bearer
    out = submit(w)
    assert out.status_code == 201
    body = out.json()
    assert set(body) == {"request_id", "receiving_goal", "lease_id", "state", "budget", "until"}
    assert body["state"] == "accepted" and body["budget"] == {"root": body["request_id"], "limit_usd": 0.8}
    req = w.hive.collab.get_request(body["request_id"])
    assert req["from_principal"] == "user:u_quinn" and req["from_goal"] == w.task["id"] and req["from_swarm"] == w.origin["id"]
    assert req["to_swarm"] == w.team["id"] and req["budget_root"] == body["request_id"]
    goal = w.hive.goals.get(body["receiving_goal"])
    assert json.loads(goal["binding"])["request_id"] == body["request_id"] and goal["assignee"] == w.ctl["id"]
    lease = w.hive.db.one("SELECT * FROM mind_leases WHERE id = ?", (body["lease_id"],))
    assert lease["issued_by"] == "user:u_quinn" and lease["controller_id"] == w.ctl["id"] and lease["grant_id"] == w.grant["id"]


def test_instruction_replay_is_byte_identical_and_a_changed_body_conflicts(w):
    first = submit(w)
    before = counts(w.hive)
    again = submit(w)
    assert again.status_code == 201 and again.content == first.content and counts(w.hive) == before
    changed = submit(w, title="Something else")
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "operation_conflict"
    assert w.client.post("/api/requests", headers=w.ann, json=instruction(w, title="Something else")).json()["error"]["code"] != \
        "operation_conflict"                                                          # operation ids are per person
    # the original answer survives cancellation and grant revocation
    w.client.post(f"/api/requests/{first.json()['request_id']}/cancel", headers=w.quinn)
    w.hive.services.revoke_grant(w.task["id"], w.grant["id"])
    assert submit(w).content == first.content


def test_a_replay_that_crosses_a_second_boundary_is_still_byte_identical(w, monkeypatch):
    """MesTTo flake (2/10 on 870dea4): the body's lifetime.until is to the second, so a helper that re-derived it from the
    clock on every call sent a different payload when a replay crossed a second boundary (409, correctly). A retry is the
    same request: the client keeps its body. Every clock read here is a full second later than the one before."""
    import types
    real, ticks = datetime.datetime.now(datetime.timezone.utc), iter(range(1, 10_000))

    class Ticking(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return real + datetime.timedelta(seconds=next(ticks))

    monkeypatch.setattr(__import__(__name__, fromlist=["_"]), "datetime",
                        types.SimpleNamespace(datetime=Ticking, timezone=datetime.timezone, timedelta=datetime.timedelta))
    assert later(hours=2) != later(hours=2)                                # the clock really moves between reads
    first = submit(w)
    assert first.status_code == 201, first.text
    again = submit(w)
    assert again.status_code == 201 and again.content == first.content, again.text
    changed = submit(w, lifetime={"until": later(hours=3)})              # a genuinely changed body still conflicts
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "operation_conflict"


@pytest.mark.parametrize("over,code", [
    ({"title": "x" * 201}, "bad_request"), ({"title": ""}, "bad_request"), ({"instruction": "é" * 4097}, "bad_request"),
    ({"kind": "review"}, "bad_request"), ({"budget": {"limit_usd": 0}}, "bad_request"), ({"budget": {"limit_usd": True}}, "bad_request"),
    ({"lifetime": {"until": "2026-10-05T12:00:00"}}, "bad_request"), ({"lifetime": {"until": later(hours=25)}}, "bad_request"),
    ({"lifetime": {"until": later(hours=-1)}}, "bad_request"),
    ({"lease": {"template_ids": ["native-a"], "max_children": 5}}, "bad_request"),
    ({"lease": {"template_ids": ["native-a", "native-a"], "max_children": 1}}, "bad_request"),
    ({"lease": {"template_ids": [f"t{i}" for i in range(9)], "max_children": 1}}, "bad_request"),
    ({"lease": {"template_ids": ["native-zz"], "max_children": 1}}, "template_unknown"),
    ({"budget": {"limit_usd": 1.5}}, "spend_limit"), ({"extra": 1}, "bad_request")])
def test_instruction_wire_limits_and_refusals_create_nothing(w, over, code):
    before = counts(w.hive)
    out = submit(w, **over)
    assert out.json()["error"]["code"] == code, out.text
    assert counts(w.hive) == before


@pytest.mark.parametrize("field,value", [("generation", 0), ("generation", True), ("generation", "1"), ("scope_digest", "ab" * 32),
                                         ("task_id", "")])
def test_origin_fields_are_exact(w, field, value):
    body = instruction(w)
    body["origin"][field] = value
    assert w.client.post("/api/requests", headers=w.quinn, json=body).json()["error"]["code"] == "bad_request"


def test_instruction_origin_destination_and_budget_checks(w):
    other = asyncio.run(w.hive.goals.create(w.origin["id"], "Ann's task", created_by="user:u_ann"))
    w.hive.services.grant(other["id"], "user:u_quinn", "edit", None, 60, by="user:u_ann")
    origin = dict(instruction(w)["origin"], task_id=other["id"])
    assert submit(w, origin=origin).json()["error"]["code"] == "origin_not_held"            # opened by someone else
    w.hive.services.revoke_grant(w.task["id"], w.grant["id"])
    assert submit(w).json()["error"]["code"] == "grant_inactive"
    w.hive.services.grant(w.task["id"], "user:u_quinn", "edit", None, 60, by="user:u_quinn")
    assert submit(w, to_swarm=w.origin["id"]).json()["error"]["code"] == "bad_request"   # not the task's own swarm
    w.client.put(f"/api/swarms/{w.foreign['id']}/services", json={"kinds": []})
    assert submit(w, to_swarm=w.foreign["id"]).json()["error"]["code"] == "not_offered"
    w.hive.db.update("agents", w.ctl["id"], {"budget_usd": 0.5})                       # the controller's remaining hard cap
    assert submit(w).json()["error"]["code"] == "spend_limit"
    w.hive.db.update("agents", w.ctl["id"], {"budget_usd": 5})
    w.hive.db.execute("UPDATE swarms SET archived_at = ? WHERE id = ?", (now(), w.team["id"]))
    assert submit(w).json()["error"]["code"] == "swarm_archived"
    w.hive.db.execute("UPDATE swarms SET archived_at = NULL WHERE id = ?", (w.team["id"],))
    w.hive.goals.update(w.task["id"], {"status": "cancelled"})
    assert submit(w).json()["error"]["code"] == "origin_not_held"


def test_the_request_projects_instruction_origin_and_lease_to_both_swarms(w):
    rq = accepted(w)
    view = w.client.get(f"/api/agent/requests/{rq['request_id']}", headers=agent_headers(w.ctl)).json()
    text = "Make add() handle negatives."
    assert view["context_refs"]["instruction"] == {"text": text, "digest": "sha256:" + hashlib.sha256(text.encode()).hexdigest()}
    assert view["context_refs"]["origin"]["scope_digest"] == DIGEST and view["context_refs"]["origin"]["generation"] == 1
    assert view["lease"] == {"lease_id": rq["lease_id"], "controller_id": w.ctl["id"], "template_ids": ["native-a"],
                             "max_children": 2, "until": rq["until"]}
    origin_mind = w.client.post("/api/agents", json={"name": "Coder", "swarm_id": w.origin["id"]}).json()
    assert w.client.get(f"/api/agent/requests/{rq['request_id']}", headers=agent_headers(origin_mind)).status_code == 200
    assert w.client.get(f"/api/agent/requests/{rq['request_id']}", headers=agent_headers(w.fctl)).status_code == 403


def test_only_the_controller_claims_the_receiving_goal(w):
    rq = accepted(w)
    assert w.client.post(f"/api/agent/goals/{rq['receiving_goal']}/claim", headers=agent_headers(w.helper)).status_code == 403
    assert w.client.post(f"/api/agent/goals/{rq['receiving_goal']}/claim", headers=agent_headers(w.ctl)).status_code == 200


# ---- r2.12 §1-2: templates and spawn ------------------------------------------------------------------------

def test_templates_need_the_controller_and_a_live_lease(w):
    assert w.client.get("/api/agent/minds/templates", headers=agent_headers(w.ctl), params={"team_id": w.team["id"]}).json()["error"]["code"] \
        == "lease_required"
    rq = accepted(w)
    out = w.client.get("/api/agent/minds/templates", headers=agent_headers(w.ctl), params={"team_id": w.team["id"]}).json()
    assert [t["template_id"] for t in out["templates"]] == ["native-a"]          # native-b is registered but not leased
    t = out["templates"][0]
    assert t == {"template_id": "native-a", "harness": "native", "model_id": "mock/echo", "role_id": None, "max_allocation_usd": 0.5,
                 "overridable": {"model_id": ["mock/alt"]}, "controls": ["interrupt", "stop", "pause", "resume", "retire"],
                 "lifecycle_modes": ["deliver", "bounded", "ongoing"]}
    for who in (w.helper, w.fctl):
        assert w.client.get("/api/agent/minds/templates", headers=agent_headers(who), params={"team_id": w.team["id"]}).json()["error"]["code"] \
            == "not_controller"
    w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
    assert w.client.get("/api/agent/minds/templates", headers=agent_headers(w.ctl), params={"team_id": w.team["id"]}).json()["error"]["code"] \
        == "lease_required"


def test_spawn_reserves_from_the_request_root_with_the_child_and_its_first_prompt(w):
    enabled(w)
    rq = accepted(w)
    out = spawn(w, rq["request_id"])
    assert out.status_code == 201, out.text
    body = out.json()
    assert set(body) == {"child_id", "team_id", "request_id", "template_id", "model_id", "reservation_id", "prompt_rev", "state"}
    assert body["state"] == "starting" and body["prompt_rev"] == 1 and body["model_id"] == "mock/echo"
    child = w.hive.agent(body["child_id"])
    assert child["swarm_id"] == w.team["id"] and child["budget_usd"] == 0.2 and child["kind"] == "omega"
    assert w.hive.collab.get_request(rq["request_id"])["allocated_usd"] == pytest.approx(0.2)
    assert ("start", body["child_id"]) in w.hive.supervisor.calls
    st = child_status(w, body["child_id"])
    assert st["controller_id"] == w.ctl["id"] and st["reservation"] == {"reservation_id": body["reservation_id"], "allocated_usd": 0.2,
                                                                        "spent_usd": 0.0, "remaining_usd": 0.2}
    assert st["prompts"] == [{"rev": 1, "mode": "queued", "delivery": "pending", "interrupted": False, "by": f"agent:{w.ctl['id']}",
                              "at": st["prompts"][0]["at"]}]
    assert "text" not in st["prompts"][0]


def test_spawn_retry_returns_the_same_child_and_reservation(w):
    enabled(w)
    rq = accepted(w)
    first = spawn(w, rq["request_id"])
    before = counts(w.hive)
    again = w.client.post("/api/agent/minds", headers=agent_headers(w.ctl),
                          json={k: v for k, v in spawn_body(rq["request_id"], w.team).items() if k not in ("model_id", "lifecycle_limits")})
    assert again.status_code == 201 and again.content == first.content and counts(w.hive) == before   # absent == explicit null
    assert spawn(w, rq["request_id"], allocation_usd=0.1).json()["error"]["code"] == "operation_conflict"
    w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.quinn)
    assert spawn(w, rq["request_id"]).content == first.content                     # a recorded success outlives the request
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0002").json()["error"]["code"] == "request_closed"


def test_operation_ids_are_scoped_to_the_controller(w):
    enabled(w)
    rq = accepted(w)
    assert spawn(w, rq["request_id"]).status_code == 201
    out = spawn(w, rq["request_id"], agent=w.fctl)                                 # same id, other caller: evaluated afresh
    assert out.json()["error"]["code"] == "not_controller"


@pytest.mark.parametrize("over,code", [
    ({"model_id": "mock/nope"}, "bad_request"), ({"lifecycle_mode": "bounded"}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": None, "max_iterations": None, "idle_minutes": None}}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": None, "max_iterations": True, "idle_minutes": None}}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": None, "max_iterations": 10001, "idle_minutes": None}}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": None, "max_iterations": None, "idle_minutes": 10081}}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": "2026-12-01T00:00:00", "max_iterations": None, "idle_minutes": None}}, "bad_request"),
    ({"lifecycle_mode": "bounded", "lifecycle_limits": {"until": later(days=31), "max_iterations": None, "idle_minutes": None}}, "bad_request"),
    ({"lifecycle_limits": {"until": None, "max_iterations": 3, "idle_minutes": None}}, "bad_request"),
    ({"allocation_usd": 0}, "bad_request"), ({"allocation_usd": 101}, "bad_request"), ({"allocation_usd": True}, "bad_request"),
    ({"allocation_usd": 0.6}, "spend_limit"), ({"template_id": "native-b", "allocation_usd": 0.1}, "lease_required"),
    ({"template_id": "native-zz"}, "not_found"), ({"operation_id": "short"}, "bad_request"), ({"surprise": 1}, "bad_request")])
def test_spawn_validation_refuses_and_creates_nothing(w, over, code):
    enabled(w)
    rq = accepted(w)
    before = counts(w.hive)
    out = spawn(w, rq["request_id"], **over)
    assert out.json()["error"]["code"] == code, out.text
    assert counts(w.hive) == before


def test_spawn_admission_lease_budget_and_child_bounds(w):
    enabled(w)
    rq = accepted(w, budget={"limit_usd": 0.5})
    assert spawn(w, rq["request_id"], model_id="mock/alt").json()["model_id"] == "mock/alt"            # an admitted override
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0002", allocation_usd=0.31).json()["error"]["code"] == "spend_limit"
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0003", allocation_usd=0.3).status_code == 201
    out = spawn(w, rq["request_id"], operation_id="op-spawn-0004", allocation_usd=0.0001)
    assert out.json()["error"]["code"] == "spend_limit"
    w.hive.db.execute("UPDATE requests SET limit_usd = 5 WHERE id = ?", (rq["request_id"],))
    out = spawn(w, rq["request_id"], operation_id="op-spawn-0005", allocation_usd=0.1)
    assert out.json()["error"] == {"code": "lease_required", "message": out.json()["error"]["message"], "reason": "max_children"}
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0006", agent=w.helper).json()["error"]["code"] == "not_controller"


def test_spawn_needs_a_live_lease_whose_issuer_is_still_an_admin(w):
    enabled(w)
    rq = accepted(w)
    w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'")
    assert spawn(w, rq["request_id"]).json()["error"]["code"] == "lease_required"
    w.hive.db.execute("UPDATE people SET role = 'admin' WHERE id = 'u_quinn'")
    w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
    assert spawn(w, rq["request_id"]).json()["error"]["code"] == "lease_required"


def test_a_foreign_controller_cannot_spend_another_teams_request(w):
    enabled(w)
    rq = accepted(w)
    out = w.client.post("/api/agent/minds", headers=agent_headers(w.fctl), json=spawn_body(rq["request_id"], w.foreign))
    assert out.json()["error"]["code"] == "not_controller"


def test_spawn_into_an_archived_team_is_refused(w):
    enabled(w)
    rq = accepted(w)
    w.hive.db.execute("UPDATE swarms SET archived_at = ? WHERE id = ?", (now(), w.team["id"]))
    before = counts(w.hive)
    assert spawn(w, rq["request_id"]).json()["error"]["code"] == "swarm_archived" and counts(w.hive) == before


# ---- r2.12 §3: prompts and delivery ---------------------------------------------------------------------------

def prompt(w, child, rev, op, mode="queued", agent=None, text="Now handle zero."):
    return w.client.post(f"/api/agent/minds/{child}/prompt", headers=agent_headers(agent or w.ctl),
                         json={"operation_id": op, "mode": mode, "text": text, "expected_rev": rev})


def test_prompt_revisions_conflicts_and_replay(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    stale = prompt(w, child, 0, "op-prompt-001")
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_revision" and stale.json()["error"]["current_rev"] == 1
    first = prompt(w, child, 1, "op-prompt-001")
    assert first.status_code == 202 and first.json() == {"prompt_rev": 2, "delivery": "accepted"}
    assert prompt(w, child, 1, "op-prompt-001").content == first.content
    assert prompt(w, child, 1, "op-prompt-001", text="other").json()["error"]["code"] == "operation_conflict"
    assert prompt(w, child, 2, "op-prompt-002", agent=w.fctl).json()["error"]["code"] == "not_controller"
    assert prompt(w, child, 2, "op-prompt-003", mode="steer").json()["error"]["code"] == "unsupported_control"   # not qualified
    assert prompt(w, child, 2, "op-prompt-003").status_code == 202
    assert child_status(w, child)["prompt_rev"] == 3


def test_steer_needs_the_template_to_list_it(w):
    enabled(w)
    rq = accepted(w, lease={"template_ids": ["native-a", "native-b"], "max_children": 2})
    child = spawn(w, rq["request_id"], template_id="native-b", allocation_usd=0.1).json()["child_id"]
    assert prompt(w, child, 1, "op-prompt-001", mode="steer").json()["error"]["code"] == "unsupported_control"
    assert control(w, child, "pause", "op-pause-0001").json()["error"]["code"] == "unsupported_control"


def test_delivered_is_not_acknowledged_until_the_child_acks_its_revision(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    assert child_status(w, child)["prompts"][0]["delivery"] == "pending"
    with w.client.websocket_connect("/agent-hub", headers={"Authorization": f"Bearer {w.tokens[child]}"}) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        frame = json.loads(ws.receive_text())
        # Merge with live: the hub registers after the socket's accept (Review B1 fence), so running is observable
        # once the hub answers, not at the instant the connect returns.
        assert child_status(w, child)["state"] == "running"
        assert frame["type"] == "user_message" and json.loads(frame["text"])["mind_prompt"] == {"child_id": child, "rev": 1, "mode": "queued"}
        st = child_status(w, child)
        assert st["prompts"][0]["delivery"] == "delivered"                       # sent is not received
        prompt(w, child, 1, "op-prompt-001")
        json.loads(ws.receive_text())
        ws.send_text(json.dumps({"type": "prompt_ack", "rev": 1}))
        assert json.loads(ws.receive_text()) == {"type": "prompt_ack", "rev": 1, "acknowledged": True, "status": "acknowledged"}
        ws.send_text(json.dumps({"type": "prompt_ack", "rev": 1}))
        assert json.loads(ws.receive_text())["status"] == "duplicate"           # already had it: not a refusal
        ws.send_text(json.dumps({"type": "prompt_ack", "rev": 9}))
        assert json.loads(ws.receive_text()) == {"type": "prompt_ack", "rev": 9, "acknowledged": False, "status": "refused"}
        assert [p["delivery"] for p in child_status(w, child)["prompts"]] == ["acknowledged", "delivered"]
    st = child_status(w, child)                                                    # the hub connection ended before rev 2 was acked
    assert [(p["delivery"], p["interrupted"]) for p in st["prompts"]] == [("acknowledged", False), ("delivered", True)]
    assert w.hive.minds.acknowledge(w.ctl["id"], 2) == "refused"                    # only the child's own ack counts


def test_interrupt_marks_unacknowledged_deliveries(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    with w.client.websocket_connect("/agent-hub", headers={"Authorization": f"Bearer {w.tokens[child]}"}) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        ws.receive_text()
        out = control(w, child, "interrupt", "op-interrupt1")
        assert out.status_code == 202 and json.loads(ws.receive_text()) == {"type": "mind_control", "action": "interrupt"}
        assert child_status(w, child)["prompts"][0] == {**child_status(w, child)["prompts"][0], "delivery": "delivered", "interrupted": True}


def test_a_paused_childs_prompt_waits_pending_and_is_redelivered_on_resume(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    control(w, child, "pause", "op-pause-0001")
    assert child not in w.running
    prompt(w, child, 1, "op-prompt-001")
    assert child_status(w, child)["prompts"][1]["delivery"] == "pending"
    assert control(w, child, "resume", "op-resume-001").status_code == 202
    st = child_status(w, child)
    assert st["state"] == "starting" and child in w.running


# ---- r2.12.1 §1: authority per operation ---------------------------------------------------------------------

def test_prompt_and_resume_need_live_authority_but_status_and_cleanup_do_not(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    control(w, child, "pause", "op-pause-0001")
    w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
    assert prompt(w, child, 1, "op-prompt-001").json()["error"]["code"] == "lease_required"
    assert control(w, child, "resume", "op-resume-001").json()["error"]["code"] == "lease_required"
    assert child_status(w, child)["state"] == "paused"
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    assert control(w, child, "retire", "op-retire-001").status_code == 202
    assert child_status(w, child)["state"] == "retired"


def test_cancelling_one_request_pauses_only_its_children(w):
    enabled(w)
    one = accepted(w)
    two = accepted(w, operation_id="op-request-2")
    a = spawn(w, one["request_id"]).json()["child_id"]
    b = spawn(w, two["request_id"], operation_id="op-spawn-0002").json()["child_id"]
    assert w.client.post(f"/api/requests/{one['request_id']}/cancel", headers=w.quinn).status_code == 200
    sa, sb = child_status(w, a), child_status(w, b)
    assert (sa["state"], sa["paused_reason"]) == ("paused", "request_cancelled") and a not in w.running
    assert (sb["state"], sb["paused_reason"]) == ("running" if b in w.hive.connections else "starting", None) and b in w.running
    assert w.hive.db.one("SELECT ended_reason FROM mind_leases WHERE id = ?", (one["lease_id"],))["ended_reason"] == "request_cancelled"
    assert w.hive.db.one("SELECT ended_at FROM mind_leases WHERE id = ?", (two["lease_id"],))["ended_at"] is None
    assert prompt(w, a, 1, "op-prompt-001").json()["error"]["code"] == "lease_required"
    assert prompt(w, b, 1, "op-prompt-002").status_code == 202
    page = w.client.get("/api/agent/minds/status", headers=agent_headers(w.ctl), params={"request_id": one["request_id"]}).json()
    assert [c["child_id"] for c in page["children"]] == [a]                                   # status never hides a closed request


def test_exhaustion_and_expiry_pause_one_envelope_without_touching_the_other(w):
    enabled(w)
    one, two = accepted(w), accepted(w, operation_id="op-request-2")
    a = spawn(w, one["request_id"]).json()["child_id"]
    b = spawn(w, two["request_id"], operation_id="op-spawn-0002").json()["child_id"]
    w.hive.db.execute("UPDATE agents SET spent_usd = 0.2 WHERE id = ?", (a,))
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, a)["paused_reason"] == "budget_exhausted" and child_status(w, b)["paused_reason"] is None
    w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", two["lease_id"]))
    asyncio.run(w.hive.minds.reconcile())
    assert (child_status(w, b)["state"], child_status(w, b)["paused_reason"]) == ("paused", "lease_expired")
    assert child_status(w, a)["paused_reason"] == "budget_exhausted"
    assert control(w, a, "resume", "op-resume-001").json()["error"]["code"] == "spend_limit"


def test_bounded_limits_pause_with_limit_reached(w):
    enabled(w)
    rq = accepted(w)
    limits = {"until": None, "max_iterations": 1, "idle_minutes": None}
    child = spawn(w, rq["request_id"], lifecycle_mode="bounded", lifecycle_limits=limits).json()["child_id"]
    assert child_status(w, child)["lifecycle_limits"] == limits
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, child)["state"] in ("starting", "running")
    w.hive.db.insert("usage", {"agent_id": child, "model": "mock/echo", "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0,
                               "created_at": now()})
    asyncio.run(w.hive.minds.reconcile())
    assert (child_status(w, child)["state"], child_status(w, child)["paused_reason"]) == ("paused", "limit_reached")


# ---- r2.12 §4: control, observed stop, retire ---------------------------------------------------------------------

def test_stop_is_a_request_until_the_process_end_is_observed(w, monkeypatch):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.hive.supervisor.stop = lambda aid: w.hive.supervisor.calls.append(("stop", aid))     # the process does not end
    out = control(w, child, "stop", "op-stop-00001")
    assert out.status_code == 202 and out.json() == {"action": "stop", "requested_at": out.json()["requested_at"], "observed": None}
    st = child_status(w, child)
    assert st["state"] == "stop_requested" and st["controls"][-1]["observed"] is None
    assert control(w, child, "retire", "op-retire-001").json()["error"]["code"] == "unsupported_control"
    w.hive.db.execute("UPDATE mind_children SET stop_requested_at = ? WHERE id = ?", (time.time() - 3600, child))
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, child)["state"] == "unknown"                                   # a timeout is never "stopped"
    assert control(w, child, "retire", "op-retire-001").json()["error"]["code"] == "unsupported_control"
    w.running.discard(child)                                                              # now the supervisor sees it end
    asyncio.run(w.hive.minds.reconcile())
    st = child_status(w, child)
    assert st["state"] == "stopped" and st["controls"][-1]["observed"]["state"] == "stopped"
    assert control(w, child, "stop", "op-stop-00001").content == out.content              # replay of the original 202


def test_retire_releases_the_unused_reservation_and_keeps_history(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"], allocation_usd=0.4).json()["child_id"]
    token = w.tokens[child]
    w.hive.db.execute("UPDATE agents SET spent_usd = 0.15 WHERE id = ?", (child,))
    assert control(w, child, "retire", "op-retire-001").json()["error"]["code"] == "unsupported_control"   # stop first
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    assert child_status(w, child)["state"] == "stopped"
    assert control(w, child, "retire", "op-retire-001").status_code == 202
    st = child_status(w, child)
    assert st["state"] == "retired" and st["reservation"]["remaining_usd"] == 0 and st["reservation"]["spent_usd"] == 0.15
    assert w.hive.collab.get_request(rq["request_id"])["allocated_usd"] == pytest.approx(0.15)
    assert [p["rev"] for p in st["prompts"]] == [1] and [c["action"] for c in st["controls"]] == ["stop", "retire"]
    assert w.hive.authenticate_agent(token) is None                                       # its credential ended with it
    assert control(w, child, "stop", "op-stop-00002").json()["error"]["code"] == "unsupported_control"


def test_unknown_actions_and_foreign_controllers_are_refused(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    assert control(w, child, "explode", "op-boom-00001").json()["error"]["code"] == "bad_request"
    assert control(w, child, "stop", "op-stop-00001", agent=w.fctl).json()["error"]["code"] == "not_controller"
    assert control(w, "a_00000000", "stop", "op-stop-00001").json()["error"]["code"] == "not_found"


# ---- r2.12 §5 + r2.12.1 §2: status, pagination, visibility -------------------------------------------------------

def test_status_pages_bind_their_cursor_to_caller_and_selector(w, monkeypatch):
    enabled(w)
    monkeypatch.setattr(minds_module, "PAGE", 2)
    rq = accepted(w, lease={"template_ids": ["native-a"], "max_children": 3}, budget={"limit_usd": 0.9})
    made = [spawn(w, rq["request_id"], operation_id=f"op-spawn-000{i}", allocation_usd=0.1).json()["child_id"] for i in range(3)]
    get = lambda params, agent=None: w.client.get("/api/agent/minds/status", headers=agent_headers(agent or w.ctl), params=params)
    first = get({"team_id": w.team["id"]}).json()
    assert [c["child_id"] for c in first["children"]] == made[:2] and first["next_cursor"] and first["snapshot_at"]
    second = get({"team_id": w.team["id"], "cursor": first["next_cursor"]}).json()
    assert [c["child_id"] for c in second["children"]] == made[2:] and second["next_cursor"] is None
    w.client.patch(f"/api/swarms/{w.team['id']}", json={"parent_mind_id": w.fctl["id"]})   # fctl now co-controls the team
    assert get({"team_id": w.team["id"]}, w.fctl).json()["children"] == []                 # but controls none of its children
    for params, agent in (({"team_id": w.team["id"], "cursor": first["next_cursor"]}, w.fctl),
                          ({"request_id": rq["request_id"], "cursor": first["next_cursor"]}, None),
                          ({"team_id": w.team["id"], "cursor": first["next_cursor"] + "x"}, None)):
        assert get(params, agent).json()["error"]["code"] == "bad_cursor"
    monkeypatch.setattr(minds_module, "CURSOR_SECONDS", -1)
    stale = get({"team_id": w.team["id"]}).json()["next_cursor"]
    assert get({"team_id": w.team["id"], "cursor": stale}).json()["error"]["code"] == "bad_cursor"
    assert get({"team_id": w.team["id"], "child_id": made[0]}).json()["error"]["code"] == "bad_request"
    assert get({}).json()["error"]["code"] == "bad_request"


def test_a_foreign_controller_sees_none_of_another_teams_children(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    get = lambda params: w.client.get("/api/agent/minds/status", headers=agent_headers(w.fctl), params=params)
    assert get({"team_id": w.team["id"]}).json()["error"]["code"] == "not_controller"          # Kimi #3: of THAT team
    assert get({"request_id": rq["request_id"]}).json()["error"]["code"] == "not_controller"
    assert get({"child_id": child}).json()["error"]["code"] == "not_controller"
    assert get({"team_id": w.foreign["id"]}).json()["children"] == []                          # its own team: none of ours
    assert get({"request_id": "rq_00000000"}).json()["error"]["code"] == "not_found"
    assert w.client.get("/api/agent/minds/status", headers=agent_headers(w.helper), params={"child_id": child}).status_code == 403


def test_reattachment_by_identity_after_a_coordinator_restart(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.hive.db.update("agents", w.ctl["id"], {"desired": "awake"})   # merge with live: admitted only while meant awake
    with w.client.websocket_connect("/agent-hub", headers=agent_headers(w.ctl)):
        pass                                                                                  # the coordinator comes and goes
    page = w.client.get("/api/agent/minds/status", headers=agent_headers(w.ctl), params={"team_id": w.team["id"]}).json()
    assert [(c["child_id"], c["state"], c["recovery_needed"]) for c in page["children"]] == [(child, "starting", False)]
    assert child in w.running


def test_a_hive_restart_flags_unconfirmed_children_and_never_restarts_them(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.running.clear()
    starts = len([c for c in w.hive.supervisor.calls if c[0] == "start"])
    asyncio.run(w.hive.restore())
    st = child_status(w, child)
    assert (st["state"], st["recovery_needed"]) == ("unknown", True)
    assert len([c for c in w.hive.supervisor.calls if c[0] == "start"]) == starts
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0002").status_code == 201    # max_children 2: unknown still counts
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0003").json()["error"]["code"] == "lease_required"


def test_the_supervisor_never_restarts_a_child_that_ended(w):
    from hive.supervisor.drivers import Supervisor
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.running.discard(child)
    real = Supervisor.__new__(Supervisor)
    real.hive, real._restarts = w.hive, {}
    real.driver, real.start = w.hive.supervisor.driver, lambda aid: pytest.fail("restarted a child")
    real.lock = w.hive.supervisor.lock
    # Merge with live (lifecycle fence): check() also reads the stop flag and the in-transition marks.
    import threading
    real._stop, real._transitions, real._locks_guard = threading.Event(), {}, threading.Lock()
    real.check()
    st = child_status(w, child)
    assert (st["state"], st["recovery_needed"]) == ("stopped", True)


# ---- human team routes -----------------------------------------------------------------------------------------

def test_people_read_a_teams_children_by_visibility(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    page = w.client.get(f"/api/teams/{w.team['id']}/children", headers=w.ann).json()
    assert [c["child_id"] for c in page["children"]] == [child] and "next_cursor" in page
    assert page["children"][0]["prompts"][0]["text"].startswith("Read the instruction")       # an admin may read the request
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.origin["id"],))
    member = w.client.get(f"/api/teams/{w.team['id']}/children", headers=w.mia).json()
    assert member["children"][0]["state"] and "text" not in member["children"][0]["prompts"][0]   # sees the team, not the request
    w.hive.db.execute("UPDATE swarms SET visibility = 'shared', shared_with = '[\"user:u_mia\"]' WHERE id = ?", (w.origin["id"],))
    assert "text" in w.client.get(f"/api/teams/{w.team['id']}/children", headers=w.mia).json()["children"][0]["prompts"][0]
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.team["id"],))
    assert w.client.get(f"/api/teams/{w.team['id']}/children", headers=w.mia).status_code == 404


def team_templates(w, sid, headers):
    return w.client.get(f"/api/teams/{sid}/templates", headers=headers)


def test_people_read_a_teams_registered_templates_without_a_lease(w):
    before = counts(w.hive)
    for who in (w.quinn, w.mia):                                     # an admin and a plain member who sees the team
        out = team_templates(w, w.team["id"], who)
        assert out.status_code == 200, out.text
        page = out.json()
        assert page["to_swarm"] == w.team["id"] and [t["template_id"] for t in page["templates"]] == ["native-a", "native-b"]
        assert page["templates"][1] == {"template_id": "native-b", "harness": "native", "model_id": "mock/echo", "role_id": None,
                                        "max_allocation_usd": 0.3, "overridable": {"model_id": []}, "controls": ["stop", "retire"],
                                        "lifecycle_modes": ["ongoing"]}
        assert set(page) == {"to_swarm", "templates"}
    assert [t["template_id"] for t in team_templates(w, w.foreign["id"], w.mia).json()["templates"]] == ["native-a"]
    assert team_templates(w, w.origin["id"], w.mia).json() == {"to_swarm": w.origin["id"], "templates": []}
    assert counts(w.hive) == before                                # a read: no lease, request, goal or operation written


def test_the_person_template_read_matches_the_mind_read_field_for_field(w):
    accepted(w, lease={"template_ids": ["native-a", "native-b"], "max_children": 2})
    mind = w.client.get("/api/agent/minds/templates", headers=agent_headers(w.ctl), params={"team_id": w.team["id"]}).json()
    person_view = team_templates(w, w.team["id"], w.mia).json()
    assert person_view["templates"] == mind["templates"]


def test_the_person_template_read_hides_teams_the_person_cannot_see(w):
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.team["id"],))
    hidden, missing = team_templates(w, w.team["id"], w.mia), team_templates(w, "s_00000000", w.mia)
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == missing.json()                         # a private team's existence is not revealed
    assert team_templates(w, w.team["id"], w.quinn).status_code == 200      # its owner (here also an admin) still reads it
    assert team_templates(w, "s_00000000", w.ann).json()["error"]["code"] == "not_found"   # an admin, no such team
    w.hive.db.execute("UPDATE swarms SET visibility = 'shared', shared_with = '[\"user:u_mia\"]' WHERE id = ?", (w.team["id"],))
    assert team_templates(w, w.team["id"], w.mia).status_code == 200


def test_the_person_template_read_needs_a_session_and_refuses_a_mind(w):
    url = f"/api/teams/{w.team['id']}/templates"
    assert w.client.get(url, headers={"Authorization": ""}).status_code == 401           # signed out
    assert w.client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 401
    for mind in (w.ctl, w.helper):                                 # a mind's token is not a person session (as POST /api/requests)
        out = w.client.get(url, headers=agent_headers(mind))
        assert out.status_code == 401 and out.json()["error"]["code"] == "unauthorized"


def test_the_person_template_read_takes_the_bearer_header_only(w):
    url = f"/api/teams/{w.team['id']}/templates"
    token = w.mia["Authorization"].split(" ", 1)[1]                # a valid person session
    assert w.client.get(url, headers=w.mia).status_code == 200
    out = w.client.get(url, headers={"Authorization": ""}, params={"token": token})
    assert out.status_code == 401 and out.json()["error"]["code"] == "unauthorized"   # §G.1: no ?token=
    out = w.client.get(url)                                        # the loopback operator password is not a person
    assert out.status_code == 403 and out.json()["error"]["code"] == "person_required"


def test_child_status_events_reach_only_people_who_see_the_team(w):
    from hive.core.visibility import Viewer
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    row = w.hive.db.one("SELECT * FROM mind_children WHERE id = ?", (child,))
    frame = json.dumps({"type": "mind.updated", "swarm_id": w.team["id"], "child": w.hive.minds.child_view(row)})
    mia = Viewer("user:u_mia", False)
    assert w.hive.visibility.event_visible(mia, frame)
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.team["id"],))
    assert not w.hive.visibility.event_visible(mia, frame)


def test_people_clean_up_children_admin_or_lease_issuer_only(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    url = f"/api/teams/{w.team['id']}/children/{child}/control"
    act = lambda headers, action, op: w.client.post(url, headers=headers, json={"operation_id": op, "action": action})
    assert w.client.post(url, json={"operation_id": "op-human-0001", "action": "stop"}).json()["error"]["code"] == "person_required"
    assert act(w.mia, "stop", "op-human-0001").json()["error"]["code"] == "forbidden"
    assert act(w.ann, "pause", "op-human-0001").json()["error"]["code"] == "unsupported_control"
    foreign = w.client.post(f"/api/teams/{w.foreign['id']}/children/{child}/control", headers=w.ann,
                            json={"operation_id": "op-human-0001", "action": "stop"})
    assert foreign.status_code == 404
    w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'")                  # the issuer, no longer an admin
    w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
    out = act(w.quinn, "stop", "op-human-0001")
    assert out.status_code == 202 and out.json()["observed"] is None
    assert act(w.quinn, "stop", "op-human-0001").content == out.content
    assert act(w.quinn, "retire", "op-human-0001").json()["error"]["code"] == "operation_conflict"
    assert act(w.ann, "retire", "op-human-0001").status_code == 202                           # person-scoped ids
    st = child_status(w, child)
    assert st["state"] == "retired" and [(c["action"], c["by"]) for c in st["controls"]] == [("stop", "user:u_quinn"), ("retire", "user:u_ann")]
    assert st["controls"][0]["observed"]["state"] == "stopped"


# ---- r2.13.1: delegated capability ---------------------------------------------------------------------------

def service(w):
    token = secrets.token_urlsafe(24)
    w.hive.db.insert("services", {"id": "svc_code", "name": "omegacode", "version": "1", "address": "http://127.0.0.1:8724",
                                  "contract": "omegacode/1", "surfaces": "[]", "capabilities": "[]",
                                  "token_hash": hashlib.sha256(token.encode()).hexdigest(), "capability_secret": "secret",
                                  "registered_at": now()})
    return {"Authorization": f"Bearer {token}"}


def test_a_child_gets_a_host_issued_delegated_capability_whose_status_is_live(w):
    enabled(w)
    svc = service(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    mine = {"Authorization": f"Bearer {w.tokens[child]}"}
    out = w.client.post("/api/agent/code/capability", headers=mine, json={"delegated": True})
    assert out.status_code == 200, out.text
    claims = out.json()["claims"]
    assert claims["actor"] == child and claims["kind"] == "agent" and claims["actions"] == ["read", "search", "suggest"]
    assert (claims["task_id"], claims["swarm_id"], claims["repository_id"]) == (w.task["id"], w.origin["id"], "synthetic")
    assert claims["grant_id"] == w.grant["id"] and claims["exp"] - claims["iat"] <= 900
    assert claims["delegated"] == {"request_id": rq["request_id"], "controller_id": w.ctl["id"], "execution_goal": rq["receiving_goal"],
                                   "issuer": "user:u_quinn", "origin_scope": {"scope_id": "sc_1", "scope_digest": DIGEST, "generation": 1}}
    status = lambda: w.client.get(f"/api/services/capabilities/{claims['id']}", headers=svc).json()
    assert status()["active"] is True and status()["claims"] == claims
    w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.quinn)
    assert status() == {**status(), "active": False, "reason": "request_closed"}
    again = w.client.post("/api/agent/code/capability", headers=mine, json={"delegated": True})
    assert again.status_code == 403 and again.json()["error"]["reason"] == "request_closed"


@pytest.mark.parametrize("withdraw,reason", [
    (lambda w, rq, c: w.hive.db.execute("UPDATE goal_grants SET revoked_at = ? WHERE id = ?", (now(), w.grant["id"])), "grant_withdrawn"),
    (lambda w, rq, c: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"])),
     "lease_expired"),
    (lambda w, rq, c: w.hive.db.execute("UPDATE goals SET status = 'cancelled' WHERE id = ?", (w.task["id"],)), "task_closed"),
    (lambda w, rq, c: w.hive.db.execute("UPDATE goals SET status = 'done' WHERE id = ?", (rq["receiving_goal"],)), "request_closed"),
    (lambda w, rq, c: w.hive.db.execute("UPDATE mind_children SET state = 'retired' WHERE id = ?", (c,)), "child_retired")])
def test_delegated_status_withdraws_on_each_lifecycle_loss(w, withdraw, reason):
    enabled(w)
    svc = service(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    claims = w.client.post("/api/agent/code/capability", headers={"Authorization": f"Bearer {w.tokens[child]}"},
                           json={"delegated": True}).json()["claims"]
    withdraw(w, rq, child)
    out = w.client.get(f"/api/services/capabilities/{claims['id']}", headers=svc).json()
    assert out["active"] is False and out["reason"] in (reason, "task_closed" if reason == "task_closed" else reason)


def test_delegation_is_only_for_children_and_suggest_only_for_delegation(w):
    service(w)
    out = w.client.post("/api/agent/code/capability", headers=agent_headers(w.ctl), json={"delegated": True})
    assert out.status_code == 403 and out.json()["error"]["code"] == "not_delegated"
    with pytest.raises(Exception) as refused:
        w.hive.services.issue("svc_code", actor=w.ctl["id"], kind="agent", task_id=w.task["id"], swarm_id=w.origin["id"],
                              repository_id="synthetic", actions=["read", "suggest"], member_token="t")
    assert refused.value.code == "bad_actions"
    with pytest.raises(Exception) as refused:
        w.hive.services.issue("svc_code", actor=w.ctl["id"], kind="agent", task_id=w.task["id"], swarm_id=w.origin["id"],
                              repository_id="synthetic", actions=["edit"], member_token="t", delegated={"request_id": "rq_x"})
    assert refused.value.code == "bad_actions"


# ---- correction: who cancels a request (cancelling also pauses its children) ---------------------------------

def test_another_member_or_a_mind_cannot_cancel_and_nothing_changes(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    url = f"/api/requests/{rq['request_id']}/cancel"
    out = w.client.post(url, headers=w.mia)                                       # a member who sees both swarms
    assert out.status_code == 403 and out.json()["error"]["code"] == "forbidden"
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.origin["id"],))
    assert w.client.post(url, headers=w.mia).status_code == 404                     # one who cannot see the request
    assert w.client.post(url, headers=agent_headers(w.ctl)).status_code == 401      # a mind's token is not a session
    assert w.client.post(url, headers=agent_headers(w.helper)).status_code == 401
    assert w.hive.collab.get_request(rq["request_id"])["cancelled_at"] is None
    st = child_status(w, child)
    assert st["state"] in ("starting", "running") and st["paused_reason"] is None and child in w.running
    assert w.hive.db.one("SELECT ended_at FROM mind_leases WHERE id = ?", (rq["lease_id"],))["ended_at"] is None


def test_the_issuer_cancels_even_after_losing_admin(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'")
    out = w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.quinn)
    assert out.status_code == 200 and out.json()["by"] == "user:u_quinn"
    assert child_status(w, child)["paused_reason"] == "request_cancelled"


def test_an_admin_cancels_a_request_they_did_not_issue(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id IN (?, ?)", (w.origin["id"], w.team["id"]))
    out = w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.ann)
    assert out.status_code == 200 and out.json()["by"] == "user:u_ann"
    assert child_status(w, child)["paused_reason"] == "request_cancelled"
    assert w.client.post("/api/requests/rq_00000000/cancel", headers=w.ann).status_code == 404


# ---- correction 2, B1: a queued start or resume re-checks authority under the per-mind lock --------------------

import threading

from hive.core.cost_reservations import Reservations, host_budget_snapshot, resolve


def held_start(w, monkeypatch):
    """Hold every lifecycle start at the door of Hive.lifecycle (before its lock), as Review's probe does."""
    entered, release = threading.Event(), threading.Event()
    original = w.hive.lifecycle

    def delayed(aid, action):
        if action == "start":
            entered.set()
            assert release.wait(5)
        return original(aid, action)
    monkeypatch.setattr(w.hive, "lifecycle", delayed)
    return entered, release


def test_cancel_between_admission_and_start_never_starts_the_child(w, monkeypatch):
    enabled(w)
    rq = accepted(w)
    entered, release = held_start(w, monkeypatch)

    async def run():
        task = asyncio.create_task(w.hive.minds.spawn(w.ctl, spawn_body(rq["request_id"], w.team)))
        assert await asyncio.to_thread(entered.wait, 5)
        w.hive.db.execute("UPDATE requests SET cancelled_at = ? WHERE id = ?", (now(), rq["request_id"]))
        # r10: the spawn holds the child's lock from its insert through its start, so the cancel's pause waits for the
        # held start rather than slipping in before it; release the start while the cancel is in flight.
        cancel = asyncio.create_task(w.hive.minds.request_cancelled(rq["request_id"]))
        await asyncio.sleep(0.2)
        release.set()
        await cancel
        return await task
    try:
        status, _ = asyncio.run(run())
    finally:
        release.set()
    child = w.hive.db.one("SELECT * FROM mind_children WHERE request_id = ?", (rq["request_id"],))
    assert status == 201 and child["id"] not in w.running
    assert (child["state"], child["paused_reason"]) == ("paused", "request_cancelled")


def test_a_lease_lost_before_the_start_runs_refuses_it_and_says_why(w, monkeypatch):
    enabled(w)
    rq = accepted(w)
    entered, release = held_start(w, monkeypatch)

    async def run():
        task = asyncio.create_task(w.hive.minds.spawn(w.ctl, spawn_body(rq["request_id"], w.team)))
        assert await asyncio.to_thread(entered.wait, 5)
        w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", rq["lease_id"]))
        release.set()
        return await task
    try:
        asyncio.run(run())
    finally:
        release.set()
    child = w.hive.db.one("SELECT * FROM mind_children WHERE request_id = ?", (rq["request_id"],))
    assert child["id"] not in w.running and (child["state"], child["paused_reason"]) == ("paused", "lease_expired")


def test_a_stop_that_wins_before_a_queued_resume_keeps_the_child_stopped(w, monkeypatch):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    assert control(w, child, "pause", "op-pause-0001").status_code == 202 and child not in w.running
    entered, release = held_start(w, monkeypatch)
    m = w.hive.minds

    async def run():
        task = asyncio.create_task(m.control(w.ctl, child, {"operation_id": "op-resume-001", "action": "resume"}))
        assert await asyncio.to_thread(entered.wait, 5)
        await m.control(w.ctl, child, {"operation_id": "op-stop-00001", "action": "stop"})
        release.set()
        return await task
    try:
        asyncio.run(run())
    finally:
        release.set()
    st = child_status(w, child)
    assert child not in w.running and st["state"] == "stopped" and st["controls"][-1]["observed"]["state"] == "stopped"


def test_nobody_starts_a_paused_child_around_the_controller(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    control(w, child, "pause", "op-pause-0001")
    out = w.client.post(f"/api/agents/{child}/start")                                  # the operator's own start route
    assert out.status_code == 409 and out.json()["error"]["code"] == "start_withdrawn" and child not in w.running


def test_reconcile_stops_a_process_running_for_a_paused_child(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    control(w, child, "pause", "op-pause-0001")
    w.running.add(child)                                                                 # however it got there
    asyncio.run(w.hive.minds.reconcile())
    assert child not in w.running and child_status(w, child)["state"] == "paused"


# ---- correction 2, B2: retirement refunds only funds no model call still holds -----------------------------------

def call(w, child, key, state, usd=0.1):
    calls = Reservations(w.hive.db)
    calls.reserve(key, {"invented": key}, usd, lambda: host_budget_snapshot(w.hive, child), metadata={"agent": child},
                  dispatched=state != "reserved")
    if state == "unknown":
        calls.unknown(key)
    return calls


def settle(w, calls, key, child, usd):
    calls.settle(key, usd, lambda: w.hive.record_usage(w.hive.agent(child), "mock/echo",
                                                       {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd}))


def retire(w, child):
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    assert control(w, child, "retire", "op-retire-001").status_code == 202


def allocated(w, rq):
    return round(w.hive.collab.get_request(rq["request_id"])["allocated_usd"], 6)


@pytest.mark.parametrize("state", ["reserved", "dispatched", "unknown"])
def test_retire_keeps_every_unresolved_call_liability_in_the_request(w, state):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    call(w, child, "call-1", state)
    assert child_status(w, child)["reservation"]["remaining_usd"] == 0.1                # held is not available either
    retire(w, child)
    assert allocated(w, rq) == 0.1
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.1                                                       # still held, still counted


def test_settlement_before_retire_refunds_the_rest(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    calls = call(w, child, "call-1", "dispatched")
    settle(w, calls, "call-1", child, 0.04)
    retire(w, child)
    assert allocated(w, rq) == 0.04


def test_settlement_after_retire_refunds_once(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    calls = call(w, child, "call-1", "unknown")
    retire(w, child)
    settle(w, calls, "call-1", child, 0.04)
    for _ in range(3):
        asyncio.run(w.hive.minds.reconcile())
        assert allocated(w, rq) == 0.04                                                  # refunded once, never again


def test_a_person_release_then_a_late_charge_never_overspends(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    calls = call(w, child, "call-1", "unknown")
    retire(w, child)
    resolve(calls, "call-1", "release", "provider shows no charge", "user:u_quinn")
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.0
    settle(w, calls, "call-1", child, 0.07)                                              # the provider answers after all
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.07
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.07


def test_a_late_charge_is_held_again_before_the_next_spawn_without_waiting_for_reconcile(w):
    enabled(w)
    rq = accepted(w, budget={"limit_usd": 0.4})
    child = spawn(w, rq["request_id"], allocation_usd=0.3).json()["child_id"]
    calls = call(w, child, "call-1", "unknown", usd=0.2)
    retire(w, child)
    resolve(calls, "call-1", "release", "no charge seen", "user:u_quinn")
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.0
    settle(w, calls, "call-1", child, 0.2)                                               # late: $0.20 really was spent
    out = spawn(w, rq["request_id"], operation_id="op-spawn-0002", allocation_usd=0.3)
    assert out.json()["error"]["code"] == "spend_limit" and allocated(w, rq) == 0.2
    assert spawn(w, rq["request_id"], operation_id="op-spawn-0003", allocation_usd=0.2).status_code == 201
    assert allocated(w, rq) == 0.4


# ---- correction 2, Code decisions: steer held back, prompt bytes, deliver bound to the request ---------------------

def test_steer_stays_unavailable_until_qualified(w, monkeypatch):
    t = {"template_id": "t", "model_id": "mock/echo", "max_allocation_usd": 0.2, "controls": ["stop", "retire", "steer"],
         "teams": [w.team["id"]]}
    assert w.hive.minds._load_templates([t]) == {} and "steer" in w.hive.minds.template_errors[-1]
    monkeypatch.setattr(minds_module, "STEER_QUALIFIED", True)
    assert list(w.hive.minds._load_templates([t])) == ["t"]


def raw_post(w, url, headers, body):
    """The body as ASCII-escaped JSON, so a lone surrogate reaches the server as the \\uXXXX escape a client could send."""
    return w.client.post(url, headers={**headers, "Content-Type": "application/json"}, content=json.dumps(body))


@pytest.mark.parametrize("text,ok", [("x", True), ("é" * 4096, True), ("é" * 4096 + "x", False), ("", False),
                                     ("\ud800", False), ("a" * 8192, True)])
def test_prompts_are_one_to_8192_bytes_of_valid_utf8_never_truncated(w, text, ok):
    enabled(w)
    rq = accepted(w)
    out = raw_post(w, "/api/agent/minds", agent_headers(w.ctl), spawn_body(rq["request_id"], w.team, initial_prompt=text))
    assert (out.status_code == 201) is ok, out.text
    if ok:
        child = out.json()["child_id"]
        assert w.hive.db.one("SELECT text FROM mind_prompts WHERE child_id = ?", (child,))["text"] == text
        assert prompt(w, child, 1, "op-prompt-001", text=text).status_code == 202
    else:
        assert out.json()["error"]["code"] == "bad_request"


def test_an_unencodable_title_or_instruction_is_refused_not_a_server_error(w):
    assert raw_post(w, "/api/requests", w.quinn, instruction(w, title="\ud800")).json()["error"]["code"] == "bad_request"
    assert raw_post(w, "/api/requests", w.quinn, instruction(w, instruction="ok \udfff")).json()["error"]["code"] == "bad_request"
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    out = raw_post(w, f"/api/agent/minds/{child}/prompt", agent_headers(w.ctl),
                   {"operation_id": "op-prompt-001", "mode": "queued", "text": "\ud800", "expected_rev": 1})
    assert out.json()["error"]["code"] == "bad_request"


def test_deliver_stops_only_on_this_requests_own_work(w):
    enabled(w)
    rq = accepted(w)
    child_id = spawn(w, rq["request_id"], lifecycle_mode="deliver").json()["child_id"]
    child = {**w.hive.agent(child_id), "id": child_id}
    other = asyncio.run(w.hive.goals.create(w.team["id"], "unrelated chore"))
    w.hive.goals.claim(child, other["id"])
    asyncio.run(w.hive.goals.result(child, other["id"], "done", "finished something else"))
    asyncio.run(w.hive.minds.reconcile())
    st = child_status(w, child_id)
    assert st["state"] in ("starting", "running") and st["progress"]["results"] == []     # not this request's work
    w.client.post(f"/api/agent/goals/{rq['receiving_goal']}/claim", headers=agent_headers(w.ctl))
    sub = asyncio.run(w.hive.goals.create(w.team["id"], "the request's work", parent_id=rq["receiving_goal"],
                                          created_by=f"agent:{w.ctl['id']}"))
    w.hive.goals.claim(child, sub["id"])
    asyncio.run(w.hive.goals.result(child, sub["id"], "done", "proposal filed"))
    asyncio.run(w.hive.minds.reconcile())
    st = child_status(w, child_id)
    assert (st["state"], st["paused_reason"]) == ("paused", "limit_reached")
    assert [r["goal_id"] for r in st["progress"]["results"]] == [sub["id"]]


def test_an_ack_naming_another_child_is_not_counted(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    with w.client.websocket_connect("/agent-hub", headers={"Authorization": f"Bearer {w.tokens[child]}"}) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        ws.receive_text()
        ws.send_text(json.dumps({"type": "prompt_ack", "child_id": "a_someone", "rev": 1}))
        assert json.loads(ws.receive_text())["acknowledged"] is False
        assert child_status(w, child)["prompts"][0]["delivery"] == "delivered"
        ws.send_text(json.dumps({"type": "prompt_ack", "child_id": child, "rev": 1}))     # the runtime's own frame shape
        assert json.loads(ws.receive_text())["acknowledged"] is True



# ---- correction 2, Kimi kimi-mind-control-p1 -------------------------------------------------------------------

def test_team_control_gates_the_person_before_revealing_whether_a_team_exists(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    body = {"operation_id": "op-human-0001", "action": "stop"}
    real, fake = f"/api/teams/{w.team['id']}/children/{child}/control", f"/api/teams/s_00000000/children/{child}/control"
    for url in (real, fake):                                                           # the local operator: same answer
        out = w.client.post(url, json=body)
        assert out.status_code == 403 and out.json()["error"]["code"] == "person_required"
    w.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = 'user:u_quinn' WHERE id = ?", (w.team["id"],))
    hidden, missing = w.client.post(real, headers=w.mia, json=body), w.client.post(fake, headers=w.mia, json=body)
    assert hidden.status_code == missing.status_code == 404 and hidden.json()["error"]["code"] == missing.json()["error"]["code"]
    assert w.client.post(fake, headers=w.ann, json=body).status_code == 404               # an admin, no such team
    page = lambda sid, h: w.client.get(f"/api/teams/{sid}/children", headers=h)
    assert page(w.team["id"], w.mia).status_code == page("s_00000000", w.mia).status_code == 404
    assert page("s_00000000", w.ann).json()["error"]["code"] == "not_found"


def test_the_request_view_shows_the_envelope_shrink_as_children_spend(w):
    enabled(w)
    rq = accepted(w)
    view = lambda: w.client.get(f"/api/agent/requests/{rq['request_id']}", headers=agent_headers(w.ctl)).json()["budget"]
    assert view() == {"root": rq["request_id"], "limit_usd": 0.8, "allocated_usd": 0.0, "spent_usd": 0.0, "held_usd": 0.0,
                      "remaining_usd": 0.8}
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.hive.record_usage(w.hive.agent(child), "mock/echo", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.05})
    call(w, child, "call-1", "dispatched", usd=0.03)
    b = view()
    assert (b["allocated_usd"], b["spent_usd"], b["held_usd"], b["remaining_usd"]) == (0.2, 0.05, 0.03, 0.72)
    person = [r for r in w.client.get("/api/requests", headers=w.quinn).json() if r["id"] == rq["request_id"]][0]["budget"]
    assert person["remaining_usd"] == 0.72                                                 # the person sees it too


def test_a_cancel_pause_is_in_the_childs_audit_trail(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    w.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=w.quinn)
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    st = child_status(w, child)
    assert [(c["action"], c["by"]) for c in st["controls"]] == [("pause", "host:request_cancelled"), ("stop", f"agent:{w.ctl['id']}")]


def test_a_delegated_capability_is_bound_to_the_exact_grant_its_lease_was_issued_under(w):
    enabled(w)
    service(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    claims = w.client.post("/api/agent/code/capability", headers={"Authorization": f"Bearer {w.tokens[child]}"},
                           json={"delegated": True}).json()["claims"]
    second = w.hive.services.grant(w.task["id"], "user:u_quinn", "edit", None, 120, by="user:u_quinn")   # also active
    assert w.hive.minds.delegated_reason(claims) is None
    assert w.hive.minds.delegated_reason({**claims, "grant_id": second["id"]}) == "grant_withdrawn"


def test_a_mind_that_is_not_a_child_gets_no_prompt_ack_answer(w):
    # Merge with live: the hub admits a hive-run mind only while it is meant to be awake (Review B1 admission fence).
    w.hive.db.update("agents", w.ctl["id"], {"desired": "awake"})
    with w.client.websocket_connect("/agent-hub", headers=agent_headers(w.ctl)) as ws:
        ws.send_text(json.dumps({"type": "prompt_ack", "rev": 1}))
        ws.send_text(json.dumps({"type": "agent_message", "client_seq": "cs-1", "text": "hello"}))
        assert json.loads(ws.receive_text())["type"] == "ack"                             # the next answer is the message's


# ---- correction 3: the identity the channel checks is the one the supervisor assembles -------------------------

def test_the_assembled_mind_environment_binds_the_channel_to_its_own_child_id(w, tmp_path, monkeypatch):
    """B3 binding in the exact assembly: Workspace.env (what every driver starts a mind with), filtered by the same
    mind_environment the local driver uses, carries HIVE_AGENT_ID = this child; the channel admits only that child."""
    import importlib.util
    import pathlib
    from hive.supervisor.sandbox import mind_environment
    from hive.supervisor.workspace import Workspace
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"]).json()["child_id"]
    workspace = Workspace(w.hive.settings)
    agent = w.hive.agent(child)
    workspace.create(agent, w.tokens[child])
    env = mind_environment({"HIVE_AGENT_ID": "a_from_the_hive_process", "PATH": "/usr/bin"},
                           workspace.env(agent, "ws://127.0.0.1:1/agent-hub", "http://127.0.0.1:1"))
    assert env["HIVE_AGENT_ID"] == child and env["commchannel"] == "hive"           # the mind's own id wins
    source = pathlib.Path(__file__).resolve().parents[2] / "modules" / "channel_hive" / "src" / "hive_channel.py"
    spec = importlib.util.spec_from_file_location("hive_channel_assembly", source)
    channel = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(channel)
    memory = tmp_path / "memory"
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(memory))
    monkeypatch.setenv("HIVE_AGENT_ID", env["HIVE_AGENT_ID"])
    inbox = channel.channel_dir() / "inbox.jsonl"
    with w.client.websocket_connect("/agent-hub", headers={"Authorization": f"Bearer {w.tokens[child]}"}) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 0}))
        frame = json.loads(ws.receive_text())                                     # the host's real frame for rev 1
    foreign = json.loads(frame["text"])
    foreign["mind_prompt"]["child_id"], foreign["text"] = "a_other_child", "FOREIGN"
    inbox.write_text(json.dumps({"seq": 1, "text": frame["text"]}) + "\n" + json.dumps({"seq": 2, "text": json.dumps(foreign)}) + "\n")
    out = channel.getLastMessage()
    assert "mind_prompt_rev=1" in out and "FOREIGN" not in out


def test_a_spawn_holds_the_fence_and_the_childs_lock_from_insert_through_start(w):
    """Stand-in r9: the fence was released after the insert, before finish_agent and the start."""
    import threading
    enabled(w)
    rq = accepted(w)
    seen = {}
    sup, start = w.hive.supervisor, w.hive.supervisor.start
    def start_and_look(aid):
        seen["writers"] = w.hive._swarm_writers.get(w.team["id"], 0)
        lock = w.hive._mind_lock(aid)
        seen["owned"] = lock._is_owned()                     # this thread holds the child's lock
        out = []
        t = threading.Thread(target=lambda: out.append(lock.acquire(timeout=0.2) and (lock.release() or True)))
        t.start(); t.join(2)
        seen["others_blocked"] = out == [False]
        return start(aid)
    sup.start = start_and_look
    finish = w.hive.finish_agent
    def finish_and_look(row, token, role, **kw):   # kw: by (host-identity r1.1, the role's grantor)
        seen["writers_at_finish"] = w.hive._swarm_writers.get(w.team["id"], 0)
        return finish(row, token, role, **kw)
    w.hive.finish_agent = finish_and_look
    out = spawn(w, rq["request_id"])
    assert out.status_code == 201, out.text
    assert seen["writers_at_finish"] == 1 and seen["writers"] >= 1     # the start nests its own fence inside
    assert seen["owned"] is True and seen["others_blocked"] is True
    assert w.hive._swarm_writers.get(w.team["id"], 0) == 0   # released once it is done
