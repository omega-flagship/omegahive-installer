import pytest
pytest.importorskip("hive.core.app")
from hive.tests.test_core_api import client, agent_headers  # noqa: E402,F401


def test_canonical_boards_follow_claim_and_completion(client):
    swarm = client.post("/api/swarms", json={"name": "Invented builders"}).json()
    mind = client.post("/api/agents", json={"name": "Invented builder", "kind": "module", "swarm_id": swarm["id"]}).json()
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Invented work", "assignee": mind["id"]}).json()
    paths = [f"/api/boards/mind?entity_id={mind['id']}", f"/api/boards/swarm?entity_id={swarm['id']}", "/api/boards/grand"]
    for path in paths:
        assert client.get(path).json()["goals"][0]["id"] == goal["id"]
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(mind)).status_code == 200
    for path in paths:
        assert client.get(path).json()["goals"][0]["status"] == "claimed"
    assert client.post(f"/api/agent/goals/{goal['id']}/result", headers=agent_headers(mind), json={"status": "done", "result": "synthetic work done"}).status_code == 200
    for path in paths:
        assert client.get(path).json()["goals"][0]["status"] == "done"


def test_member_board_scope_and_admin_discovery(client):
    swarm = client.post("/api/swarms", json={"name": "Invented A"}).json()
    minds = [client.post("/api/agents", json={"name": n, "kind": "module", "swarm_id": swarm["id"]}).json() for n in ["One", "Two"]]
    goals = [client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": n, "assignee": m["id"]}).json() for n, m in zip(["A", "B"], minds)]
    own = client.get("/api/agent/board", headers=agent_headers(minds[0]))
    assert own.status_code == 200
    assert [g["id"] for g in own.json()["goals"]] == [goals[0]["id"]]
    for path in ["/api/boards/grand", "/api/match?need=plan"]:
        assert client.get(path, headers=agent_headers(minds[0])).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer invalid"}).status_code == 401


def test_service_discovery_labels_unknowns_and_has_no_assignment_effect(client):
    swarm = client.post("/api/swarms", json={"name": "Invented Planner"}).json()
    client.put(f"/api/swarms/{swarm['id']}/services", json={"kinds": ["plan"]})
    match = client.get("/api/match?need=plan").json()
    assert match["advisory_only"] is True
    candidate = match["candidates"][0]
    assert candidate["entity_id"] == swarm["id"]
    assert candidate["verified_capabilities"] == []
    assert candidate["capacity"] == "unknown" and candidate["eligibility"] == "unverified"
    assert client.get(f"/api/swarms/{swarm['id']}/goals").json() == []
    assert client.get("/api/match?need=not-offered").json()["candidates"] == []
    assert client.get("/api/match").status_code == 400
    assert client.get("/api/boards/mind").status_code == 400


def test_board_routes_precede_built_ui_and_prefixed_mount(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from hive.core import app as app_module
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    dist = tmp_path / "ui"
    dist.mkdir()
    (dist / "index.html").write_text("synthetic UI")
    monkeypatch.setattr(app_module, "UI_DIST", dist)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    settings.base_path = "/synthetic"
    app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as browser:
        token = browser.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        browser.headers["Authorization"] = "Bearer " + token
        result = browser.get("/api/boards/grand")
        assert result.status_code == 200
        assert result.json()["source"] == "canonical-hive"
        assert browser.get("/api/match?need=plan").status_code == 200
        # Password sessions are local only: a mounted route must reach its
        # auth guard (401), rather than disappear behind the UI (404).
        for path in ("/api/boards/grand", "/api/match?need=plan"):
            assert browser.get("/synthetic" + path).status_code == 401


def test_role_matching_is_advisory_and_never_assigns(client):
    swarm = client.post("/api/swarms", json={"name": "Synthetic role matching"}).json()
    role = next(r for r in client.get("/api/roles").json() if r["name"] == "Planner")
    mind = client.post("/api/agents", json={"name": "Synthetic planner", "kind": "module", "swarm_id": swarm["id"], "role_id": role["id"]}).json()
    result = client.get("/api/match?kind=mind&need=planner").json()
    candidate = next(c for c in result["candidates"] if c["entity_id"] == mind["id"])
    assert result["advisory_only"] and not result["execution_authorized"]
    assert candidate["matched_role"]["id"] == role["id"]
    assert candidate["verified_capabilities"] == [] and candidate["eligibility"] == "unverified"
    assert client.get(f"/api/swarms/{swarm['id']}/goals").json() == []
    assert client.get("/api/match?kind=unknown&need=planner").status_code == 400


def test_assistance_board_retains_origin_owner_and_separate_helper(client):
    from hive.tests.test_collab import mind, held_goal, call
    origin = client.post("/api/swarms", json={"name": "Synthetic origin"}).json()
    receiving = client.post("/api/swarms", json={"name": "Synthetic helpers"}).json()
    owner, helper = mind(client, origin, "Synthetic owner"), mind(client, receiving, "Synthetic helper")
    source = held_goal(client, origin, owner)
    client.put(f"/api/swarms/{receiving['id']}/services", json={"kinds": ["assist"]})
    response = call(client, owner, "POST", "/api/agent/requests", {"kind": "assist", "to_swarm": receiving["id"], "from_goal": source["id"], "title": "Synthetic bounded help"})
    assert response.status_code == 200
    req = response.json()
    assert call(client, helper, "POST", f"/api/agent/goals/{req['receiving_goal']}/claim").status_code == 200
    for path in ("/api/boards/grand", f"/api/boards/mind?entity_id={owner['id']}", f"/api/boards/swarm?entity_id={receiving['id']}"):
        request = next(r for r in client.get(path).json()["requests"] if r["id"] == req["id"])
        assert request["origin_owner"] == owner["id"]
        assert request["receiving_holder"] == helper["id"]
    original = next(g for g in client.get(f"/api/swarms/{origin['id']}/goals").json() if g["id"] == source["id"])
    assert original["claimed_by"] == owner["id"]
    scoped = client.get("/api/agent/board", headers=agent_headers(helper)).json()
    assert all("origin_owner" not in r and "receiving_holder" not in r for r in scoped["requests"])
