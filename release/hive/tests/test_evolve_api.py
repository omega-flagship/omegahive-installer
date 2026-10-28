import time
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401
from hive.tests.test_evolve import contribution, registration


def test_member_contributes_through_existing_policy_and_identity_route(client):
    swarm, agents = make_swarm_and_agents(client, n=1, kind="module")
    agent = agents[0]
    view = client.post("/api/programs/omegaevolve/view", json={"swarm_id": swarm["id"]}).json()
    request = {"action": "contribute", "items": ["objective"], "base_revision": view["revision"],
               "params": {"contribution": contribution()}, "idempotency_key": "synthetic-contribution-1"}
    denied = client.post("/api/agent/programs/omegaevolve/act", headers=agent_headers(agent), json=request)
    assert denied.status_code in (202, 403), denied.text
    client.post("/api/policy", json={"scope": f"agent:{agent['id']}", "skill": "program:omegaevolve:contribute", "mode": "allow"})
    done = client.post("/api/agent/programs/omegaevolve/act", headers=agent_headers(agent), json=request)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done", done.text
    record = next(item for item in done.json()["graph"]["items"] if item["kind"] == "contribution")
    assert record["meta"]["adoption_authorized"] is False
    repeated = client.post("/api/agent/programs/omegaevolve/act", headers=agent_headers(agent), json=request)
    assert repeated.json()["detail"] == done.json()["detail"]


def test_local_password_cannot_seal_owner_registration(client):
    swarm, _ = make_swarm_and_agents(client, n=0)
    graph = client.post("/api/programs/omegaevolve/view", json={"swarm_id": swarm["id"]}).json()
    result = client.post("/api/programs/omegaevolve/act", json={"swarm_id": swarm["id"],
        "action": "register", "items": ["objective"], "base_revision": graph["revision"],
        "params": {"registration": registration()}})
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "refused"


def test_existing_lab_executes_the_protocol_suite(client):
    run = client.post("/api/lab/runs", json={"suite": "tests-evolve"})
    assert run.status_code == 200, run.text
    run_id = run.json()["id"]
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = client.get(f"/api/lab/runs/{run_id}").json()
        if result["status"] != "running":
            break
        time.sleep(.1)
    assert result["status"] == "passed", result
    assert result["passed"] == 35 and result["cases"]


def test_source_retracts_through_member_route_and_other_member_cannot(client):
    swarm, agents = make_swarm_and_agents(client, n=2, kind="module")
    for agent in agents:
        client.post("/api/policy", json={"scope": f"agent:{agent['id']}", "skill": "program:omegaevolve:contribute", "mode": "allow"})
    def contribute_as(agent, payload, key):
        graph = client.post("/api/programs/omegaevolve/view", json={"swarm_id": swarm["id"]}).json()
        return client.post("/api/agent/programs/omegaevolve/act", headers=agent_headers(agent), json={
            "action": "contribute", "items": ["objective"], "base_revision": graph["revision"],
            "params": {"contribution": payload}, "idempotency_key": key})
    initial = contribute_as(agents[0], contribution(), "source")
    assert initial.status_code == 200, initial.text
    source_id = initial.json()["detail"]["record_id"]
    payload = dict(contribution(), title="withdraw", relation="retraction", predecessor=source_id)
    forbidden = contribute_as(agents[1], payload, "other-withdraw")
    assert forbidden.json()["status"] == "refused", forbidden.text
    withdrawn = contribute_as(agents[0], payload, "source-withdraw")
    assert withdrawn.json()["status"] == "done", withdrawn.text
    graph = client.post("/api/programs/omegaevolve/view", json={"swarm_id": swarm["id"]}).json()
    original = next(item for item in graph["items"] if item["id"] == source_id)
    assert original["status"] == "retracted"
    assert original["text"] == contribution()["claim"]


def test_seed_pair_view_is_explicitly_planned_not_live(client):
    swarm, _ = make_swarm_and_agents(client, n=0)
    graph = client.post("/api/programs/omegaevolve/view", json={"swarm_id": swarm["id"]}).json()
    seeds = [item for item in graph["items"] if item["kind"] == "seed"]
    assert {item["meta"]["runtime_kind"] for item in seeds} == {"omega", "iter"}
    assert all(item["meta"]["phase"] == "planned" and item["meta"]["provisioning"] == "unverified" for item in seeds)
    assert len([link for link in graph["links"] if link["rel"] == "subject-of"]) == 2
