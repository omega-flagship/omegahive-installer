"""The MeTTa coding controller driving one Code request against the REAL scratch OmegaCode service.

Same scratch world as test_code_contract_live_service (a scratch hive on a free port, a scratch OmegaCode from the pinned
release, a synthetic calculator repo; never 8700/8724). Here the engine itself runs inside the scratch hive's own event
loop: the person's request is adopted by the engine, which opens the origin, spawns the helper (a fake process: the test
plays the helper with its real member token and the real proposal client), wakes on the helper's goal event,
authenticates the retained proposal in the person's scope, prepares and runs the proposal test through the real relay
and sandbox, and asks for review. The reviewer is a test double (review delivery is not wired on any hive yet).
Skipped when the release tree, PeTTa, git or sandbox-exec is missing (the harness's own conditions).
"""
import datetime
import time

import pytest

from hive.tests import test_code_contract_live_service as live
from hive.tests.test_code_contract_live_service import REPO_ID, cp, world  # noqa: F401  (fixtures)

pytestmark = live.pytestmark


def wait_for(predicate, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("timed out")


def test_engine_drives_a_request_to_ready_for_you_against_the_real_service(world, cp):
    w, hive = world, world.hive
    live.test_hop1_person_opens_the_repository(w)
    live.test_hop2_workspace_through_the_person_relay(w)
    live.test_hop3_person_scopes_bytes_28_to_29(w)
    engine = hive.code_controller
    hive.settings.code_controller_engine = True
    hive.settings.copy_apply_claims = True
    # the engine acts as itself (its own credential, in-process host paths): nothing here hands it a mind's token

    team = w.http.post("/api/swarms", json={"name": "Coders", "visibility": "public"}, headers=w.op).json()
    ctl = w.http.post("/api/agents", json={"name": "Lead", "swarm_id": team["id"], "budget_usd": 5}, headers=w.op).json()
    assert w.http.patch(f"/api/swarms/{team['id']}", json={"coordinator_id": ctl["id"]}, headers=w.op).status_code == 200
    assert w.http.put(f"/api/swarms/{team['id']}/services", json={"kinds": ["code"]}, headers=w.op).status_code == 200
    hive.minds.templates = hive.minds._load_templates([
        {"template_id": "native-a", "model_id": "mock/echo", "max_allocation_usd": 0.5,
         "controls": ["interrupt", "stop", "pause", "resume", "retire"], "teams": [team["id"]]}])
    w.ctl = ctl
    # the second opinion: a mind of the Code team wearing the foundation reviewer role the hive installs at start
    role = hive.db.one("SELECT id FROM roles WHERE name = 'Foundation proposal reviewer'")["id"]
    reviewer = w.http.post("/api/agents", json={"name": "Second opinion", "swarm_id": team["id"], "budget_usd": 5},
                           headers=w.op).json()
    hive.db.update("agents", reviewer["id"], {"role_id": role})
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat(timespec="seconds")
    origin = {"task_id": w.task_id, "repository_id": REPO_ID, "workspace_id": w.ws["id"], "scope_id": w.scope["id"],
              "scope_digest": "sha256:" + w.scope["digest"], "generation": w.ws["generation"]}
    out = w.http.post("/api/requests", headers=w.jon, json={
        "operation_id": "op-request-engine-1", "to_swarm": team["id"], "kind": "code", "title": "Fix the calculator",
        "instruction": "add() subtracts; make it add.", "origin": origin, "budget": {"limit_usd": 0.8},
        "lifetime": {"until": until}, "lease": {"template_ids": ["native-a"], "max_children": 2}})
    assert out.status_code == 201, out.text
    rid = out.json()["request_id"]

    # the engine (in the hive's loop) opened, read and spawned exactly one helper with a host-composed prompt
    effect = wait_for(lambda: hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'helper' "
                                          "AND state = 'waiting'", (rid,)))
    import json
    body = json.loads(effect["body"])
    child_id = body["child_id"]
    assert w.tokens.get(child_id)
    state = w.http.get(f"/api/requests/{rid}/controller", headers=w.jon).json()
    assert state["status"] == "writing" and [r["kind"] for r in state["journal"]] == ["opened", "read", "think-started"]
    # the helper reads its own request's instruction with its own tool (never pasted into its prompt)
    own = w.http.get("/api/agent/code/helper-instruction", headers={"Authorization": f"Bearer {w.tokens[child_id]}"})
    assert own.status_code == 200 and own.json()["instruction"]["text"] == "add() subtracts; make it add."

    # the helper (played here with its real member token and client) proposes, then finishes its work goal
    helper = cp.DelegatedProposalClient(w.hive_url, w.tokens[child_id])
    try:
        proposed = helper.propose(w.ws["id"], "op-propose-engine-1",
                                  [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+"}])
    finally:
        helper.close()
    sid = proposed["record"]["id"]
    auth = {"Authorization": f"Bearer {w.tokens[child_id]}"}
    claim = w.http.post(f"/api/agent/goals/{body['goal_id']}/claim", headers=auth)
    assert claim.status_code == 200, claim.text
    done = w.http.post(f"/api/agent/goals/{body['goal_id']}/result", headers=auth,
                       json={"status": "done", "result": f"retained {sid}", "data": {"proposal_id": sid}})
    assert done.status_code == 200, done.text

    def status_in(*wanted):
        return wait_for(lambda: (lambda s: s if s["status"] in wanted + ("needs_you", "engine_error") else None)(
            w.http.get(f"/api/requests/{rid}/controller", headers=w.jon).json()), 120)

    # the goal event wakes the engine: candidate -> real prepare + sandbox run -> a review goal for the reviewer mind
    wait_for(lambda: hive.db.one("SELECT 1 FROM code_controller_effects WHERE request_id = ? AND kind = 'review' AND "
                                 "state = 'waiting'", (rid,)), 120)
    state = w.http.get(f"/api/requests/{rid}/controller", headers=w.jon).json()
    assert state["status"] == "reviewing" and state["second_opinion"]["reviewer_id"] == reviewer["id"], state
    review = json.loads(hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'review'",
                                    (rid,))["body"])
    rauth = {"Authorization": f"Bearer {reviewer['token']}"}
    packet = w.http.get(f"/api/agent/goals/{review['goal_id']}", headers=rauth)
    assert packet.status_code == 200, packet.text
    assert w.http.post(f"/api/agent/goals/{review['goal_id']}/claim", headers=rauth).status_code == 200
    done = w.http.post(f"/api/agent/goals/{review['goal_id']}/result", headers=rauth,
                       json={"status": "done", "result": "looks right", "data": {"decision": "pass"}})
    assert done.status_code == 200, done.text
    state = status_in("ready_for_you")
    assert state["status"] == "ready_for_you", state
    assert [r["kind"] for r in state["journal"]] == ["opened", "read", "think-started", "candidate-retained", "dispatched", "tests-pass",
                                                     "dispatched", "review-pass"]
    assert state["candidate"] == sid and state["test"]["exit_code"] == 0 and state["test"]["tested"] is True
    assert state["test"]["logs"]["stdout"]["text"] == "calculator passed\n"
    # nothing was applied: the person's workspace is unchanged
    got = live.proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/files", params={"path": "calculator.py"})
    assert got.status_code == 200 and got.json()["content"] == live.CALCULATOR

    # the person's own Apply (their session, the hive's own origin): consent, the controller's copy_apply capability and
    # Code's proposal-applications over the real relay; only now does the person's file change
    applied = w.http.post(f"/api/requests/{rid}/controller/apply", headers={**w.jon, "Origin": w.hive_url})
    assert applied.status_code == 200, applied.text
    state = applied.json()
    assert state["status"] == "applied", "\n".join(f"{r['kind']} {r['fields']} {r['verdict']} {r['evidence']}" for r in state["journal"][-6:])
    assert [r["kind"] for r in state["journal"]][-3:] == ["approval-needed", "approved", "applied"]
    receipt = state["journal"][-1]["evidence"]
    assert receipt["application_id"].startswith("application_") and receipt["after"]["generation"] == 2
    got = live.proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/files", params={"path": "calculator.py"})
    assert got.status_code == 200 and got.json()["content"] == live.CALCULATOR.replace("a - b", "a + b")
    req = hive.minds._request(rid)
    assert hive.goals.get(req["receiving_goal"])["status"] == "done"
    caps = hive.db.all("SELECT issued_by FROM capabilities WHERE json_extract(claims, '$.proposal_test.request_id') = ? "
                       "OR json_extract(claims, '$.copy_apply.request_id') = ?", (rid, rid))
    assert caps and {c["issued_by"] for c in caps} == {"host:code-controller-engine"}
