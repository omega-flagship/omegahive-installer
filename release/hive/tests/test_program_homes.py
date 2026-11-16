import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_homes_list_configured_then_remembered_swarms_the_caller_can_see(client, monkeypatch):
    a = client.post("/api/swarms", json={"name": "A", "visibility": "public"}).json()
    b = client.post("/api/swarms", json={"name": "B", "visibility": "public"}).json()
    pid = client.get("/api/programs").json()
    pid = (pid.get("programs", pid) if isinstance(pid, dict) else pid)[0]["id"]
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({pid: [b["id"], "s_unknown"]}))
    homes = client.get(f"/api/programs/{pid}/homes").json()["homes"]
    assert [h["swarm_id"] for h in homes] == [b["id"]]           # unknown/invisible swarms never listed
    client.app.state.hive.db.execute("INSERT INTO program_homes VALUES (?, ?, ?)", (pid, a["id"], "2026-10-04T00:00:00Z"))
    homes = client.get(f"/api/programs/{pid}/homes").json()["homes"]
    assert [h["swarm_id"] for h in homes] == [b["id"], a["id"]] and homes[1]["why"] == "opened here before"
