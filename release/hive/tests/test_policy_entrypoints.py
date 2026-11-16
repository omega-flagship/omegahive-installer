"""Purpose: verify that entry paths and default skill families require a person's approval for unreviewed commands."""

import asyncio
import datetime

import pytest

from hive.core import mcp
from hive.core.code_controller_engine import EngineError
from hive.core.create_plan_ports import GoalMinds
from hive.tests.test_ask import ask, world as ask_world
from hive.tests.test_ask_conductor import Script, call as tool_call, closed, on, script, tool_results, wait  # noqa: F401
from hive.tests.test_code_controller_engine import fake, run, x  # noqa: F401
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401
from hive.tests.test_mcp_s3 import agent_row, c, call, member, swarm  # noqa: F401
from hive.tests.test_mind_control import w  # noqa: F401
from modules.hive.src import hive_commons


@pytest.mark.parametrize("head", ["unreviewed-command", "hive-unreviewed", "skill-unreviewed", "beliefs-unreviewed",
                                  "agenda-unreviewed", "events-unreviewed"])
def test_unreviewed_default_family_head_needs_exact_one_shot_consent(client, head):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    command = f'({head} "synthetic")'

    def gate(text=command):
        response = client.post("/api/agent/authorize", headers=agent_headers(mind), json={"command": text})
        assert response.status_code == 200, response.text
        return response.json()

    first = gate()
    assert first["decision"] == "pending"
    assert gate()["approval_id"] == first["approval_id"]
    approval = client.post(f"/api/approvals/{first['approval_id']}/decide", json={"decision": "once"})
    assert approval.status_code == 200, approval.text
    assert gate(f'({head} "different")')["decision"] == "pending"
    assert gate()["decision"] == "allow"
    assert gate()["decision"] == "pending"


def assert_native_hold(client, mind, monkeypatch, approver=None, refused=None):
    """Use the production mind adapter with its HTTP transport bound to this disposable hive."""
    command = '(skill-unreviewed "synthetic")'

    def transport(method, path, payload=None):
        assert (method, path) == ("POST", "/api/agent/authorize")
        result = client.post(path, headers=agent_headers(mind), json=payload)
        assert result.status_code == 200, result.text
        return result.json(), None

    monkeypatch.setattr(hive_commons, "_call", transport)
    first = hive_commons.authorize(command)
    assert first is not True and first.startswith("HIVE-APPROVAL-PENDING ")
    assert hive_commons.authorize(command) == first
    hive = client.app.state.hive
    approval = hive.db.one("SELECT * FROM approvals WHERE agent_id = ? AND command = ? AND status = 'pending'",
                           (mind["id"], command))
    assert approval and approval["decided_by"] is None
    denied = client.post(f"/api/approvals/{approval['id']}/decide", headers=agent_headers(mind),
                         json={"decision": "once"})
    assert denied.status_code == 401
    if refused is not None:   # someone who sees the mind but may not answer for it
        answer = client.post(f"/api/approvals/{approval['id']}/decide", headers=refused, json={"decision": "once"})
        assert answer.status_code == 403 and answer.json()["error"]["code"] == "owner_only", answer.text
    allowed = client.post(f"/api/approvals/{approval['id']}/decide", headers=approver or {}, json={"decision": "once"})
    assert allowed.status_code == 200, allowed.text
    assert hive_commons.authorize(command) is True
    assert hive_commons.authorize(command) is not True


def test_native_ask_coordinator_keeps_the_unknown_skill_hold(client, monkeypatch):
    world = ask_world(client)
    response = ask(client, world["ann"], "policy-native-ask", text="try skill-unreviewed synthetic",
                   context={"swarm_id": world["swarm"]["id"]})
    assert response.status_code == 202, response.text
    assert response.json()["thread"]["mind"]["id"] == world["coord"]["id"]
    # Ann asked, and sees the approval it raised, but answering is the coordinator's owner's or an admin's (#111)
    assert_native_hold(client, world["coord"], monkeypatch, world["jon"], refused=world["ann"])


def test_create_goal_recipient_keeps_the_unknown_skill_hold(client, monkeypatch):
    hive = client.app.state.hive
    _, (mind,) = make_swarm_and_agents(client, n=1)
    engine = hive.create_plans
    who = engine.assignees.resolve(["mind", mind["id"]], "user:operator")
    assert who["resolved"]
    result = client.portal.call(GoalMinds(engine).call, {"plan_id": "pl_policy", "person": "user:operator"},
                                "review", {"reviewer": who}, {"instruction": "try skill-unreviewed synthetic"})
    assert hive.goals.get(result["pending"])["assignee"] == mind["id"]
    assert hive.db.one("SELECT id FROM messages WHERE agent_id = ? AND sender = 'hive:create-plan'", (mind["id"],))
    assert_native_hold(client, mind, monkeypatch)


def test_code_bench_spawned_helper_keeps_the_unknown_skill_hold(x, monkeypatch):
    fake(x, monkeypatch, [(True, "synthetic check passed\n")])
    assert run(x.engine.step(x.rid))["status"] == "writing"
    children = x.hive.db.all("SELECT * FROM mind_children WHERE request_id = ?", (x.rid,))
    assert len(children) == 1
    child = x.hive.agent(children[0]["id"])
    child["token"] = x.tokens[child["id"]]
    assert_native_hold(x.client, child, monkeypatch)


def test_room_recipient_keeps_the_unknown_skill_hold(client, monkeypatch):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    room = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{mind['id']}"]}).json()
    response = client.post(f"/api/rooms/{room['id']}/messages", json={"text": "try skill-unreviewed synthetic"})
    assert response.status_code == 200, response.text
    assert response.json()["delivered_to"] == [f"agent:{mind['id']}"]
    assert_native_hold(client, mind, monkeypatch)


def test_scheduled_recipient_keeps_the_unknown_skill_hold(client, monkeypatch):
    _, (mind,) = make_swarm_and_agents(client, n=1)
    response = client.post(f"/api/agents/{mind['id']}/wakeups",
                           json={"cron": "*/5 * * * *", "text": "try skill-unreviewed synthetic"})
    assert response.status_code == 200, response.text
    wakeup = response.json()
    due = datetime.datetime.fromisoformat(wakeup["next_run_at"].replace("Z", "+00:00"))
    assert wakeup["id"] in client.portal.call(client.app.state.hive.scheduler.tick, due)
    assert_native_hold(client, mind, monkeypatch)


def test_conductor_rejects_an_unknown_tool_instead_of_executing_it(client, on):
    model = script(client, Script([tool_call("skill-unreviewed")], "The tool is unavailable."))
    response = ask(client, on["ann"], "policy-conductor", context=on["ctx"])
    assert response.status_code == 202, response.text
    wait(on["hive"], "policy-conductor", closed)
    assert tool_results(model.bodies[1]) == [{"ok": False, "reason": "unknown_tool"}]
    assert on["hive"].db.all("SELECT * FROM approvals WHERE skill = 'skill-unreviewed'") == []


def test_typed_controllers_reject_unknown_actions_without_a_skill_dispatch(client):
    hive = client.app.state.hive
    with pytest.raises(EngineError, match="unknown action"):
        asyncio.run(hive.create_plans._act({"plan_id": "pl_policy"}, {}, ["skill-unreviewed"]))
    with pytest.raises(EngineError, match="unknown action"):
        asyncio.run(hive.code_controller._act({"request_id": "rq_policy", "member": False}, {}, ["skill-unreviewed"]))


def test_external_member_uses_the_receiving_hives_policy_and_person(client, c, monkeypatch):
    _, (local,) = make_swarm_and_agents(client, n=1)
    assert c.post("/omegahive/mcp", headers=agent_headers(local),
                  json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401
    serving = swarm(c, "Receiving hive")
    code = member(c, serving, "Outside caller")
    mind = agent_row(c, code)
    goal = c.post(f"/api/swarms/{serving['id']}/goals", headers=c.admin, json={"title": "Synthetic member task"}).json()
    assert call(c, code, "hive_goal_claim", {"goal_id": goal["id"]})[1] is None
    # A registered tool mapped to a newly introduced native skill is unreviewed on the receiving hive.
    monkeypatch.setitem(mcp.POLICY, "hive_goal_heartbeat", "skill-unreviewed")
    executed = []
    heartbeat = c.hive.goals.heartbeat

    def observed(*args, **kwargs):
        executed.append(goal["id"])
        return heartbeat(*args, **kwargs)

    monkeypatch.setattr(c.hive.goals, "heartbeat", observed)
    _, error = call(c, code, "hive_goal_heartbeat", {"goal_id": goal["id"]})
    assert executed == [], "the unreviewed member tool ran before a person approved it"
    assert error is not None and error["code"] == "approval_required"
    approval = c.hive.db.one("SELECT * FROM approvals WHERE agent_id = ? AND skill = 'skill-unreviewed'", (mind["id"],))
    assert approval and approval["status"] == "pending"
    assert client.post(f"/api/approvals/{approval['id']}/decide", json={"decision": "once"}).status_code == 404
    allowed = c.post(f"/api/approvals/{approval['id']}/decide", headers=c.admin, json={"decision": "once"})
    assert allowed.status_code == 200, allowed.text
    assert call(c, code, "hive_goal_heartbeat", {"goal_id": goal["id"]})[1] is None
    assert executed == [goal["id"]]
    assert call(c, code, "hive_goal_heartbeat", {"goal_id": goal["id"]})[1]["code"] == "approval_required"
    assert executed == [goal["id"]]
