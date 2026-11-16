from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_driver_is_set_only_to_a_known_driver_and_only_while_stopped(client):
    client.supervisor.drivers = {"local": object(), "docker": object()}
    _, (a, _b) = make_swarm_and_agents(client)
    bad = client.patch(f"/api/agents/{a['id']}", json={"driver": "ssh"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_driver"
    ok = client.patch(f"/api/agents/{a['id']}", json={"driver": "docker"})
    assert ok.status_code == 200 and ok.json()["driver"] == "docker"
    client.app.state.hive.db.update("agents", a["id"], {"status": "awake"})
    busy = client.patch(f"/api/agents/{a['id']}", json={"driver": "local"})
    assert busy.status_code == 409 and busy.json()["error"]["code"] == "mind_running"
