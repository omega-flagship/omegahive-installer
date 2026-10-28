"""Sessions: a goal, a room and a spend cap with one mind; the cap only tightens and is restored at the end."""
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_a_session_binds_goal_room_and_a_tightening_budget(client):
    _, (a, _b) = make_swarm_and_agents(client)
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Fix the flaky test", "budget_usd": 2}).json()
    assert s["status"] == "active" and s["goal"]["title"] == "Fix the flaky test" and s["mind"]["id"] == a["id"]
    hive = client.app.state.hive
    goal = hive.goals.get(s["goal_id"])
    assert goal["assignee"] == a["id"]
    rule = hive.db.one("SELECT * FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))
    assert rule and abs(rule["limit_usd"] - 2.0) < 1e-9                      # spent 0 + session cap 2
    room = client.get(f"/api/rooms/{s['room_id']}").json()
    assert room["kind"] == "session" and room["settings"]["minds_follow"] is True
    sent = client.post(f"/api/rooms/{s['room_id']}/messages", json={"text": "start with the logs"}).json()
    assert sent["delivered_to"] == [f"agent:{a['id']}"]                      # the mind hears every message
    client.post("/api/agent/trace", headers=agent_headers(a), json={"iteration": 1, "response": "r",
                "commands": [{"command": "(read-file \"x\")", "result": "ok"}, {"command": "(pin \"p\")", "result": "PIN"}]})
    tl = client.get(f"/api/sessions/{s['id']}/timeline").json()
    kinds = [i["type"] for i in tl["items"]]
    assert "message" in kinds and "step" in kinds
    step = next(i for i in tl["items"] if i["type"] == "step")
    assert [c["command"] for c in step["steps"]] == ['(read-file "x")']       # pins and waits are not steps
    ended = client.post(f"/api/sessions/{s['id']}/end").json()
    assert ended["status"] == "ended"
    assert hive.db.one("SELECT * FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",)) is None


def test_a_session_never_raises_a_tighter_existing_cap(client):
    _, (a, _b) = make_swarm_and_agents(client)
    client.post("/api/budgets", json={"scope": f"agent:{a['id']}", "period": "total", "limit_usd": 0.5})
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Small", "budget_usd": 5}).json()
    hive = client.app.state.hive
    assert hive.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))["limit_usd"] == 0.5
    client.post(f"/api/sessions/{s['id']}/end")
    assert hive.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))["limit_usd"] == 0.5
    assert client.post("/api/rooms", json={"kind": "session", "name": "x", "members": []}).status_code == 400


def test_session_lists_the_minds_workspaces_with_a_revoked_short_grant(client, monkeypatch):
    _, (a, _b) = make_swarm_and_agents(client)
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Code it", "budget_usd": 1}).json()
    code = client.app.state.code if hasattr(client.app.state, "code") else None
    hive = client.app.state.hive
    calls = []
    import json as _json

    async def fake_proxy(principal, method, path, query, body, task_id, grant_id, repository_id):
        calls.append((path, task_id, grant_id, repository_id))
        return 200, _json.dumps([{"id": "ws_1", "base_commit": "abc", "status": "active"}]).encode(), "application/json"
    import hive.core.app as appmod  # noqa: F401
    target = None
    for route in client.app.routes:
        if getattr(route, "path", "") == "/api/sessions/{session_id}/workspaces":
            target = route.endpoint
    code_obj = target.__closure__ and next(c.cell_contents for c in target.__closure__ if type(c.cell_contents).__name__ == "Code")
    monkeypatch.setattr(code_obj, "repos", {"demo": {}})
    monkeypatch.setattr(code_obj, "proxy", fake_proxy)
    out = client.get(f"/api/sessions/{s['id']}/workspaces").json()
    assert out["workspaces"] == [{"id": "ws_1", "base_commit": "abc", "status": "active", "repository_id": "demo"}]
    assert calls[0][0] == f"/v1/tasks/{s['goal_id']}/workspaces" and calls[0][1] == s["goal_id"]
    grant = hive.db.one("SELECT * FROM goal_grants WHERE id = ?", (calls[0][2],))
    assert grant["revoked_at"]                                              # the read grant does not linger


def test_usage_records_the_model_the_provider_reports(client):
    _, (a, _b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.record_usage(hive.agent(a["id"]), "openrouter/~anthropic/claude-sonnet-latest",
                      {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.0}, "anthropic/claude-sonnet-5.5")
    row = hive.usage(a["id"])[-1]
    assert row["model"] == "openrouter/~anthropic/claude-sonnet-latest" and row["resolved_model"] == "anthropic/claude-sonnet-5.5"


def test_a_deleted_mind_never_breaks_the_session_list(client):
    _, (a, b) = make_swarm_and_agents(client)
    gone = client.post("/api/sessions", json={"mind": a["id"], "title": "Old work", "budget_usd": 1}).json()
    kept = client.post("/api/sessions", json={"mind": b["id"], "title": "Current work", "budget_usd": 1}).json()
    client.post(f"/api/sessions/{gone['id']}/end")
    client.app.state.hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (a["id"],))
    listed = client.get("/api/sessions")
    assert listed.status_code == 200
    by_id = {s["id"]: s for s in listed.json()}
    assert by_id[kept["id"]]["mind"]["status"] != "removed"
    assert by_id[gone["id"]]["mind"] == {"id": a["id"], "name": a["name"], "hue": a.get("hue"), "status": "removed"}
    assert client.get(f"/api/sessions/{gone['id']}/timeline").status_code == 200
    assert client.post(f"/api/sessions/{gone['id']}/end").json()["status"] == "ended"


def test_a_session_ends_cleanly_when_its_mind_was_deleted_mid_session(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    cap = lambda m: hive.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{m['id']}",))
    client.post("/api/budgets", json={"scope": f"agent:{a['id']}", "period": "total", "limit_usd": 50})   # a prior cap
    capped = client.post("/api/sessions", json={"mind": a["id"], "title": "Capped", "budget_usd": 1}).json()
    bare = client.post("/api/sessions", json={"mind": b["id"], "title": "Bare", "budget_usd": 1}).json()
    assert cap(a)["limit_usd"] < 50 and cap(b) is not None
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id IN (?, ?)", (a["id"], b["id"]))   # deleted while active
    for s in (capped, bare):
        ended = client.post(f"/api/sessions/{s['id']}/end")
        assert ended.status_code == 200 and ended.json()["status"] == "ended" and ended.json()["mind"]["status"] == "removed"
    assert abs(cap(a)["limit_usd"] - 50) < 1e-9          # the prior cap comes back exactly
    assert cap(b) is None                                 # no prior cap: the session's is removed
    hive.db.execute("DELETE FROM agents WHERE id = ?", (a["id"],))   # a row physically gone still lists as removed
    listed = {s["id"]: s for s in client.get("/api/sessions").json()}
    assert listed[capped["id"]]["mind"]["status"] == "removed"
