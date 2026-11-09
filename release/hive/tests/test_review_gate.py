"""R17: format check, then the app's own rule check, then a reviewer marks it done (or returns it)."""
import json

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

VALIDATOR = '''
def describe():
    return {"kinds": [{"id": "n", "role": "other"}]}
def view(ctx, focus, stage):
    return {"nodes": [], "edges": []}
def act(ctx, action, items, params):
    return {"ok": True}
def validate_result(ctx, goal, proposal):
    errors = []
    if not isinstance(proposal, dict) or not proposal.get("sources"):
        errors.append("$.sources: every claim needs at least one source")
    if ctx.validation["request"] is None and goal["binding"].get("needs_request"):
        errors.append("$: no request")
    return {"ok": not errors, "errors": errors}
'''


def _request(client, review=None, validate=None):
    """A requester swarm with a held goal asks a maker swarm for work; returns ids and headers."""
    sw1, (req,) = make_swarm_and_agents(client, n=1)
    sw2 = client.post("/api/swarms", json={"name": "Makers"}).json()
    maker = client.post("/api/agents", json={"name": "Maker", "swarm_id": sw2["id"]}).json()
    client.put(f"/api/swarms/{sw2['id']}/services", json={"kinds": ["design"]})
    own = client.post(f"/api/swarms/{sw1['id']}/goals", json={"title": "need it", "assignee": req["id"]}).json()
    client.post(f"/api/agent/goals/{own['id']}/claim", headers=agent_headers(req))
    constraints = {}
    if review is not None:
        constraints["review"] = review
    if validate:
        constraints["validate"] = validate
    rq = client.post("/api/agent/requests", headers=agent_headers(req), json={"kind": "design", "to_swarm": sw2["id"], "from_goal": own["id"],
                                                                             "title": "make it", "constraints": constraints}).json()
    goal = rq["receiving_goal"]
    client.post(f"/api/agent/goals/{goal}/claim", headers=agent_headers(maker))
    digest = client.get(f"/api/agent/goals/{goal}", headers=agent_headers(maker)).json()["binding_digest"]
    return goal, req, maker, digest


def propose(client, maker, goal, digest, proposal):
    return client.post(f"/api/agent/goals/{goal}/result", headers=agent_headers(maker),
                       json={"status": "done", "result": "here", "data": {"binding_digest": digest, "proposal": proposal}})


def test_cross_swarm_work_is_submitted_then_the_requester_accepts(client):
    goal, req, maker, digest = _request(client)
    out = propose(client, maker, goal, digest, {"deck": 1}).json()
    assert out["status"] == "submitted"                                       # not done until checked
    seen = client.get(f"/api/goals/{goal}").json()
    assert seen["review_by"] == "requester"
    # the author can never accept its own work
    assert client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(maker), json={"decision": "accept"}).status_code == 403
    # the requester's mind reads the submitted goal and accepts it
    assert client.get(f"/api/agent/goals/{goal}", headers=agent_headers(req)).status_code == 200
    done = client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "accept", "notes": "good"}).json()
    assert done["status"] == "done" and done["reviewed_by"] == f"agent:{req['id']}"
    assert [r["action"] for r in client.get(f"/api/goals/{goal}/reviews").json()] == ["submit", "accept"]


def test_returned_work_goes_back_to_the_same_mind_with_notes_and_stops_after_the_limit(client):
    goal, req, maker, digest = _request(client)
    propose(client, maker, goal, digest, {"v": 1})
    assert client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "return"}).status_code == 400   # say why
    back = client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "return", "notes": "the closing slide lost the next experiment"}).json()
    assert back["status"] == "claimed" and back["claimed_by"] == maker["id"] and back["returns"] == 1
    inbox = [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(maker)).json()["messages"]]
    assert any("GOAL-RETURNED" in m["text"] and "next experiment" in m["text"] for m in inbox)
    propose(client, maker, goal, digest, {"v": 2})
    second = client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "return", "notes": "still not"}).json()
    assert second["status"] == "claimed" and second["returns"] == 2
    propose(client, maker, goal, digest, {"v": 3})
    third = client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "return", "notes": "no"}).json()
    assert third["status"] == "failed" and third["returns"] == 3 and "returned 3 times" in third["result"]   # no endless loop


def test_an_apps_rule_check_refuses_before_review_and_the_goal_stays_with_the_mind(client, monkeypatch, tmp_path):
    folder = tmp_path / "rules"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "rules", "name": "Rules", "version": "1.0.0"}))
    (folder / "program.py").write_text(VALIDATOR)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    client.app.state.hive.programs.reload()
    goal, req, maker, digest = _request(client, validate="program:rules")
    bad = propose(client, maker, goal, digest, {"claims": ["x"]})
    assert bad.status_code == 422 and "every claim needs at least one source" in bad.json()["error"]["message"]
    assert client.get(f"/api/goals/{goal}").json()["status"] == "claimed"
    assert propose(client, maker, goal, digest, {"claims": ["x"], "sources": ["s1"]}).json()["status"] == "submitted"
    attempts = client.get(f"/api/goals/{goal}/attempts").json()
    assert [a["ok"] for a in attempts] == [False, True]                        # the refused attempt and the submission are both kept
    # an app without a checker refuses rather than waving results through
    goal2, _req2, maker2, digest2 = _request(client, validate="program:nope")
    assert propose(client, maker2, goal2, digest2, {"x": 1}).status_code == 422


def test_people_review_by_name_and_the_password_cannot(client):
    goal, req, maker, digest = _request(client, review="person")
    propose(client, maker, goal, digest, {"deck": 1})
    assert client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "accept"}).status_code == 403
    assert client.post(f"/api/goals/{goal}/review", json={"decision": "accept"}).status_code == 403          # hive password
    jon = person(client, "u_jon", role="admin")
    assert client.post(f"/api/goals/{goal}/review", headers=jon, json={"decision": "accept"}).json()["status"] == "done"


def test_goals_without_review_finish_as_before(client):
    swarm, (a, _b) = make_swarm_and_agents(client)
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "internal"}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(a))
    out = client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(a), json={"status": "done", "result": "ok"}).json()
    assert out["status"] == "done"
    goal, req, maker, digest = _request(client, review="none")
    assert propose(client, maker, goal, digest, {"x": 1}).json()["status"] == "done"


def test_app_owned_request_ids_reach_the_apps_checker(client, monkeypatch, tmp_path):
    """Truth's bound goals carry its own request ids, not hive requests: the checker must still run (found by OmegaTruth)."""
    folder = tmp_path / "rules"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "rules", "name": "Rules", "version": "1.0.0"}))
    (folder / "program.py").write_text(VALIDATOR)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    client.app.state.hive.programs.reload()
    swarm, (a, _b) = make_swarm_and_agents(client)
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "bound", "binding": {"request_id": "app-req-1", "validate": "program:rules"}}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(a))
    digest = client.get(f"/api/agent/goals/{g['id']}", headers=agent_headers(a)).json()["binding_digest"]
    bad = client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(a),
                      json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": {"claims": []}}})
    assert bad.status_code == 422 and "needs at least one source" in bad.json()["error"]["message"]     # the app's own words
    ok = client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(a),
                     json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": {"sources": ["s"]}}}).json()
    assert ok["status"] == "done"                                      # an app's own request: no review default


def test_a_trusted_review_receipt_still_goes_to_a_named_reviewer_of_the_review(client):
    """OmegaReview's QC: a review request that names a reviewer of the review cannot complete straight to done (found by OmegaReview)."""
    import asyncio
    hive = client.app.state.hive
    swarm, (spec_mind, qc) = make_swarm_and_agents(client)
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "review r1", "binding": {"kind": "review", "review": f"agent:{qc['id']}"}}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(spec_mind))
    agent = hive.db.one("SELECT * FROM agents WHERE id = ?", (spec_mind["id"],))
    goal = hive.goals.get(g["id"])
    from hive.core.goals import binding_digest
    out = asyncio.run(hive.goals.result(agent, g["id"], "done", "receipt", {"binding_digest": binding_digest(json.loads(goal["binding"])), "review_receipt": {}}, trusted_review=True))
    assert out["status"] == "submitted"                                    # not done until QC looks
    assert client.post(f"/api/agent/goals/{g['id']}/review", headers=agent_headers(spec_mind), json={"decision": "accept"}).status_code == 403
    assert client.post(f"/api/agent/goals/{g['id']}/review", headers=agent_headers(qc), json={"decision": "accept"}).json()["status"] == "done"
    # a review request with no reviewer named still completes on its receipt, as before
    g2 = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "review r2", "binding": {"kind": "review"}}).json()
    client.post(f"/api/agent/goals/{g2['id']}/claim", headers=agent_headers(spec_mind))
    goal2 = hive.goals.get(g2["id"])
    out2 = asyncio.run(hive.goals.result(agent, g2["id"], "done", "receipt", {"binding_digest": binding_digest(json.loads(goal2["binding"])), "review_receipt": {}}, trusted_review=True))
    assert out2["status"] == "done"


def test_a_restart_closes_update_requests_its_load_already_satisfied(client):
    hive = client.app.state.hive
    from hive.core.db import new_id, now
    hive.db.insert("update_requests", {"id": new_id("up"), "target": "program:contract-fixture", "note": "", "receipts": "[]",
                                       "requested_by": "user:operator", "created_at": now(), "status": "pending", "closed_at": None, "closed_by": None})
    hive.updates._close_satisfied()
    row = hive.db.one("SELECT status, closed_by FROM update_requests WHERE target = 'program:contract-fixture'")
    assert dict(row) == {"status": "applied", "closed_by": "hive:restart"}


def test_a_cancel_during_the_check_wins_over_the_result(client, monkeypatch):
    """Race found by OmegaMatch: a goal cancelled while its result is being checked must stay cancelled."""
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "slow check", "binding": {"validate": "program:x"}}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(a))
    digest = client.get(f"/api/agent/goals/{g['id']}", headers=agent_headers(a)).json()["binding_digest"]

    def slow_checker(program_id, goal, proposal):
        hive.goals.update(goal["id"], {"status": "cancelled"})       # a person cancels meanwhile
        return []
    monkeypatch.setattr(hive.programs, "validate_goal_result", slow_checker)
    r = client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(a),
                    json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": {}}})
    assert r.status_code == 409 and r.json()["error"]["code"] == "goal_changed"
    assert client.get(f"/api/goals/{g['id']}").json()["status"] == "cancelled"
    assert client.get(f"/api/goals/{g['id']}/reviews").json() == []      # no stale submission recorded


def test_a_checker_sees_the_stored_revision_not_the_workers_claim(client, monkeypatch, tmp_path):
    folder = tmp_path / "design"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "design", "name": "Design", "version": "1.0.0"}))
    (folder / "program.py").write_text(VALIDATOR.replace('''def validate_result(ctx, goal, proposal):
    errors = []''', '''def validate_result(ctx, goal, proposal):
    rev = ctx.artifact_revision(proposal.get("artifact_id"), proposal.get("revision", 0))
    if rev is None:
        return {"errors": ["$.artifact_id: no such stored revision"]}
    if rev["digest"] != proposal.get("digest"):
        return {"errors": ["$.digest: does not match the stored revision"]}
    return {"ok": True}
    errors = []'''))
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    hive = client.app.state.hive
    hive.programs.reload()
    goal, req, maker, digest = _request(client, validate="program:design", review="none")
    art = client.post("/api/agent/artifacts", headers=agent_headers(maker), json={"kind": "deck-spec", "title": "d"}).json()
    rev = client.post(f"/api/agent/artifacts/{art['id']}/revisions", headers=agent_headers(maker), json={"body": "{}", "parent": None}).json()
    wrong = propose(client, maker, goal, digest, {"artifact_id": art["id"], "revision": 1, "digest": "sha256:" + "0" * 64})
    assert wrong.status_code == 422 and "does not match the stored revision" in wrong.json()["error"]["message"]
    assert propose(client, maker, goal, digest, {"artifact_id": art["id"], "revision": 1, "digest": rev["digest"]}).json()["status"] == "done"


def test_returned_and_resubmitted_work_keeps_every_version(client):
    """After a return, the first submission is still recoverable (found by OmegaReview)."""
    goal, req, maker, digest = _request(client)
    propose(client, maker, goal, digest, {"version": "first"})
    client.post(f"/api/agent/goals/{goal}/review", headers=agent_headers(req), json={"decision": "return", "notes": "again"})
    propose(client, maker, goal, digest, {"version": "second"})
    kept = [json.loads(a["raw"]) for a in client.get(f"/api/goals/{goal}/attempts").json()]
    assert [k["data"]["proposal"]["version"] for k in kept] == ["first", "second"]


def test_the_named_reviewer_is_told_when_work_is_waiting(client):
    swarm, (author, qc) = make_swarm_and_agents(client)
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "check me", "binding": {"review": f"agent:{qc['id']}"}}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(author))
    digest = client.get(f"/api/agent/goals/{g['id']}", headers=agent_headers(author)).json()["binding_digest"]
    client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(author), json={"status": "done", "result": "r", "data": {"binding_digest": digest}})
    inbox = [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(qc)).json()["messages"]]
    assert any(m.get("event") == "review_waiting" and m.get("goal_id") == g["id"] for m in inbox)
