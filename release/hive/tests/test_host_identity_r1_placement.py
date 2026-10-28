"""host-identity r1.1: rules a mind brings with it on import record who brought it in (granted_by)."""
from hive.tests.test_placement import _rebundle, client, home, mind_in_swarm  # noqa: F401  (fixtures)
from hive.tests.test_visibility import person


def test_imported_rules_record_the_importing_person(client, home):
    _, mind = mind_in_swarm(client)
    _, other = mind_in_swarm(client, "Other")

    def with_rules(agent_id):
        return lambda m: m.__setitem__("rules", [{"scope": f"agent:{agent_id}", "skill": "write-file", "mode": "deny", "note": "keep"}])
    hive = home.app.state.hive
    ann = person(home, "u_ann")
    sw = home.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    bundle = _rebundle(client.post(f"/api/agents/{mind['id']}/export").content, with_rules(mind["id"]))
    assert home.post(f"/api/agents/import?swarm_id={sw['id']}", headers=ann, content=bundle).status_code == 200
    rule = hive.db.one("SELECT granted_by FROM policy_rules WHERE scope = ?", (f"agent:{mind['id']}",))
    assert rule["granted_by"] == "user:u_ann"                                                # the member who brought it
    admin_sw = home.post("/api/swarms", json={"name": "Home"}).json()
    bundle = _rebundle(client.post(f"/api/agents/{other['id']}/export").content, with_rules(other["id"]))
    assert home.post(f"/api/agents/import?swarm_id={admin_sw['id']}", content=bundle).status_code == 200
    rule = hive.db.one("SELECT granted_by FROM policy_rules WHERE scope = ?", (f"agent:{other['id']}",))
    assert rule["granted_by"] == "user:operator"                                             # the admin who brought it


def test_a_member_cannot_clear_role_rules_an_imported_mind_carries(client, home):
    """host-identity r1.2 (stand-in P1): an imported mind keeps role:... rules but gets no role_id; clearing or setting its
    role would delete them, so a member who may not write policy is refused, judged from the rules actually there."""
    _, mind = mind_in_swarm(client)
    bundle = _rebundle(client.post(f"/api/agents/{mind['id']}/export").content, lambda m: m.__setitem__(
        "rules", [{"scope": f"agent:{mind['id']}", "skill": "write-file", "mode": "deny", "note": "role:Strict"}]))
    hive = home.app.state.hive
    ann = person(home, "u_ann")
    sw = home.post("/api/swarms", json={"name": "Home"}).json()
    assert home.post(f"/api/agents/import?swarm_id={sw['id']}", content=bundle).status_code == 200   # the admin brings it
    home.put(f"/api/agents/{mind['id']}/visibility", json={"visibility": "shared", "shared_with": ["user:u_ann"]})
    assert hive.agent(mind["id"])["role_id"] is None
    plain = next(r for r in home.get("/api/roles").json() if r.get("builtin") and r.get("rules") == [])
    for role_id in (None, plain["id"]):
        r = home.patch(f"/api/agents/{mind['id']}", headers=ann, json={"role_id": role_id})
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    rules = hive.db.all("SELECT mode, note FROM policy_rules WHERE scope = ?", (f"agent:{mind['id']}",))
    assert [(x["mode"], x["note"].startswith("role:Strict")) for x in rules] == [("deny", True)]
    assert home.patch(f"/api/agents/{mind['id']}", json={"role_id": None}).status_code == 200        # the admin may
    assert hive.db.all("SELECT * FROM policy_rules WHERE scope = ?", (f"agent:{mind['id']}",)) == []
