"""Disposable named people and traces only: archived history retains ordinary R13 access."""
from hive.tests.test_core_api import agent_headers, client  # noqa: F401
from hive.tests.test_visibility import person


def test_archive_keeps_trace_identity_and_refuses_foreign_or_revoked_people(client):
    ann, bob = person(client, "u_archive_owner"), person(client, "u_archive_reader")
    swarm = client.post("/api/swarms", headers=ann, json={"name": "Synthetic archive"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Synthetic mind", "kind": "module", "swarm_id": swarm["id"]}).json()
    for i in range(6):
        assert client.post("/api/agent/trace", headers=agent_headers(mind), json={"iteration": i, "response": f"Synthetic {i}", "commands": [{"command": "(synthetic)", "result": "recorded"}]}).status_code == 200
    url = f"/api/agents/{mind['id']}/traces"
    originals = client.get(url, headers=ann).json()
    hive = client.app.state.hive
    assert hive.archive.archive_traces(mind["id"], keep=2) == 4
    index_url = url + "/archive"
    index = client.get(index_url, headers=ann).json()
    day_url = index_url + "/" + index["days"][0]["day"]
    assert client.get(index_url, headers=bob).status_code == 404
    assert client.get(day_url, headers=bob).status_code == 404
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "shared", "shared_with": ["user:u_archive_reader"]}).status_code == 200
    archived = client.get(day_url, headers=bob, params={"limit": 2, "offset": 0}).json()
    page2 = client.get(day_url, headers=bob, params={"limit": 2, "offset": 2}).json()
    by_id = {row["id"]: row for row in originals}
    assert len(archived + page2) == 4
    assert all(row == by_id[row["id"]] for row in archived + page2)
    assert [row["iteration"] for row in archived + page2] == [0, 1, 2, 3]
    assert client.get(day_url, headers=bob, params={"offset": 4}).json() == []
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "private"}).status_code == 200
    assert client.get(index_url, headers=bob).status_code == 404
    assert client.get(day_url, headers=bob).status_code == 404
    assert len(client.get(day_url, headers=ann).json()) == 4
