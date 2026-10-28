"""The mind is the coordinator: a swarm has a coordinating member and may sit inside another swarm's mind."""
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_coordinator_parent_and_no_cycles(client):
    outer, inner, innermost = (client.post("/api/swarms", json={"name": n}).json() for n in ("Org", "Team", "Squad"))
    lead = client.post("/api/agents", json={"name": "Lead", "kind": "module", "swarm_id": outer["id"]}).json()
    tl = client.post("/api/agents", json={"name": "TL", "kind": "module", "swarm_id": inner["id"]}).json()
    sq = client.post("/api/agents", json={"name": "SQ", "kind": "module", "swarm_id": innermost["id"]}).json()
    assert client.patch(f"/api/swarms/{inner['id']}", json={"coordinator_id": lead["id"]}).status_code == 400   # not a member
    team = client.patch(f"/api/swarms/{inner['id']}", json={"coordinator_id": tl["id"], "parent_mind_id": lead["id"]}).json()
    assert team["coordinator_id"] == tl["id"] and team["parent_swarm_id"] == outer["id"]
    assert client.get(f"/api/swarms/{outer['id']}").json()["child_swarm_ids"] == [inner["id"]]
    client.patch(f"/api/swarms/{innermost['id']}", json={"parent_mind_id": tl["id"]})
    cyc = client.patch(f"/api/swarms/{outer['id']}", json={"parent_mind_id": sq["id"]})
    assert cyc.status_code == 400 and cyc.json()["error"]["code"] == "nesting_cycle"
    assert client.patch(f"/api/swarms/{inner['id']}", json={"parent_mind_id": tl["id"]}).status_code == 400   # its own member
    assert client.patch(f"/api/swarms/{inner['id']}", json={"parent_mind_id": None}).json()["parent_swarm_id"] is None
