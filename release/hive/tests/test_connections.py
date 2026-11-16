"""Connection agreements between swarms (R11): purpose, scopes, coordinators, duration, budget; pause, revoke, expire."""
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_shares_api import write_space


def mind(client, swarm, name, mandate=None):
    role = client.post("/api/roles", json={"name": f"{name} r{swarm['id']}", "prompt": "p", "mandate": mandate}).json()["id"] if mandate else None
    return client.post("/api/agents", json={"name": name, "kind": "module", "swarm_id": swarm["id"], "role_id": role}).json()


def call(client, who, method, path, body=None):
    return client.request(method, path, headers=agent_headers(who), json=body)


def setup(client):
    A, B = (client.post("/api/swarms", json={"name": n}).json() for n in ("Research", "Build"))
    a_lead, a_member, b_lead = mind(client, A, "Ada", {"id": "pricing", "version": "1"}), mind(client, A, "Ari"), mind(client, B, "Bo")
    write_space(client, a_lead, "findings", ["(finding pricing-claim-1 supported)", "(finding pricing-claim-2 weak)"])
    return A, B, a_lead, a_member, b_lead


def agreement(A, B, a_lead, b_lead, **over):
    return dict({"from_swarm": A["id"], "to_swarm": B["id"], "purpose": "Validate the pricing page", "deliverable": "evidence review",
                 "from_coordinator": a_lead["id"], "to_coordinator": b_lead["id"], "days": 14, "budget_usd": 5,
                 "scopes": [{"kind": "memory", "side": "from", "mind": a_lead["id"], "space": "findings", "access": "read"},
                            {"kind": "requests", "direction": "to->from", "kinds": ["review"]}]}, **over)


def test_what_a_connection_needs(client):
    A, B, a_lead, a_member, b_lead = setup(client)
    base = agreement(A, B, a_lead, b_lead)
    for bad, code in [(dict(base, purpose=" "), 400), (dict(base, to_swarm=A["id"]), 400), (dict(base, from_coordinator=b_lead["id"]), 400),
                      (dict(base, days=None), 400), (dict(base, days=400), 400), (dict(base, budget_usd="nan"), 400),
                      (dict(base, scopes=[{"kind": "repository", "repo": "x"}]), 400),
                      (dict(base, scopes=[{"kind": "memory", "side": "from", "mind": a_lead["id"], "space": "findings", "access": "write"}]), 400),
                      (dict(base, scopes=[{"kind": "memory", "side": "to", "mind": a_lead["id"], "space": "findings"}]), 400)]:
        assert client.post("/api/connections", json=bad).status_code == code, bad
    c = client.post("/api/connections", json=base).json()
    assert c["status"] == "active" and c["ends_at"] and "Research ↔ Build" in c["summary"] and "cannot erase" in c["note"]


def test_shared_memory_reaches_only_the_other_coordinator_and_ends_with_the_connection(client):
    A, B, a_lead, a_member, b_lead = setup(client)
    c = client.post("/api/connections", json=agreement(A, B, a_lead, b_lead)).json()
    sid = c["share_ids"][0]
    read = call(client, b_lead, "GET", f"/api/agent/shares/{sid}/atoms")
    assert read.status_code == 200 and read.json()["total"] == 2
    assert call(client, a_member, "GET", f"/api/agent/shares/{sid}/atoms").status_code == 403
    paused = client.post(f"/api/connections/{c['id']}/pause", json={}).json()
    assert paused["status"] == "paused" and call(client, b_lead, "GET", f"/api/agent/shares/{sid}/atoms").status_code == 410
    resumed = client.post(f"/api/connections/{c['id']}/resume", json={}).json()
    assert resumed["status"] == "active" and call(client, b_lead, "GET", f"/api/agent/shares/{resumed['share_ids'][0]}/atoms").status_code == 200
    hive = client.app.state.hive
    hive.db.update("connections", c["id"], {"ends_at": "2000-01-01T00:00:00.000Z"})
    import asyncio
    assert c["id"] in asyncio.run(hive.agreements.expire())
    ended = client.get(f"/api/connections/{c['id']}").json()
    assert ended["status"] == "ended" and call(client, b_lead, "GET", f"/api/agent/shares/{resumed['share_ids'][0]}/atoms").status_code == 410
    assert ended["history"][-1]["event"] == "ended"


def test_requests_flow_only_in_the_agreed_direction_and_draw_on_its_budget(client):
    A, B, a_lead, a_member, b_lead = setup(client)
    goal = client.post(f"/api/swarms/{B['id']}/goals", json={"title": "ship pricing", "assignee": b_lead["name"]}).json()
    call(client, b_lead, "POST", f"/api/agent/goals/{goal['id']}/claim")
    ask = {"kind": "review", "to_swarm": A["id"], "title": "Check claims", "from_goal": goal["id"], "budget_usd": 2,
           "constraints": {"mandates": [{"id": "pricing", "version": "1"}]}}
    assert call(client, b_lead, "POST", "/api/agent/requests", ask).status_code == 403          # no connection yet
    c = client.post("/api/connections", json=agreement(A, B, a_lead, b_lead)).json()
    rq = call(client, b_lead, "POST", "/api/agent/requests", ask).json()
    assert rq["connection_id"] == c["id"] and client.get(f"/api/connections/{c['id']}").json()["allocated_usd"] == 2
    over = call(client, b_lead, "POST", "/api/agent/requests", dict(ask, budget_usd=4))
    assert over.status_code == 402 and over.json()["error"]["code"] == "connection_budget"
    ga = client.post(f"/api/swarms/{A['id']}/goals", json={"title": "x", "assignee": a_lead["name"]}).json()
    call(client, a_lead, "POST", f"/api/agent/goals/{ga['id']}/claim")
    reverse = call(client, a_lead, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": B["id"], "title": "r", "from_goal": ga["id"],
                                                                  "constraints": {"mandates": [{"id": "pricing", "version": "1"}]}})
    assert reverse.status_code == 403                                                            # only to->from was agreed
    revoked = client.post(f"/api/connections/{c['id']}/revoke", json={"reason": "done"}).json()
    assert revoked["status"] == "revoked" and call(client, b_lead, "GET", f"/api/agent/requests/{rq['id']}").json()["state"] == "cancelled"
    assert call(client, b_lead, "POST", "/api/agent/requests", ask).status_code == 403          # nothing new after revoke
    assert client.post(f"/api/connections/{c['id']}/resume", json={}).status_code == 409
