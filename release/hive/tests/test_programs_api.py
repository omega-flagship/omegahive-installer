"""Dot programs: contract 0.1 through the hive API, with the public fixture."""

import json
import pathlib

from hive.programs_check import check
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "plugins" / "contract_fixture"


def swarm(client):
    return client.post("/api/swarms", json={"name": "Programs"}).json()


def test_the_fixture_passes_the_standalone_checker():
    assert check(FIXTURE, log=lambda *_: None)
    assert check(FIXTURE, log=lambda *_: None, scenario=True, allow_mutation=True)


def test_question_support_counterevidence_source_and_correction(client):
    s = swarm(client)
    listed = {p["id"]: p for p in client.get("/api/programs").json()}
    assert listed["contract-fixture"]["enabled"] and listed["contract-fixture"]["source"] == "built-in"
    detail = client.get("/api/programs/contract-fixture").json()
    assert detail["describe"]["contract"] == "0.1"
    view = client.post("/api/programs/contract-fixture/view", json={"swarm_id": s["id"]}).json()
    assert view["contract"] == "0.1" and view["revision"] == "r1" and view["focus"] == "q1"
    items = {i["id"]: i for i in view["items"]}
    assert items["c1"]["uncertainty"] == {"method": "nal", "f": 0.8, "c": 0.55}
    assert items["e3"]["uncertainty"]["method"] == "qualitative"           # never converted
    rels = {link["rel"] for link in view["links"]}
    assert {"supports", "contradicts", "qualifies", "depends_on"} <= rels
    assert items["e1"]["sources"][0]["origin"] == items["e2"]["sources"][0]["origin"]  # common origin kept
    opened = client.post("/api/programs/contract-fixture/act",
                         json={"swarm_id": s["id"], "action": "inspect-source", "items": ["e1"],
                               "base_revision": "r1"}).json()
    assert opened["status"] == "done" and opened["detail"]["sources"][0]["locator"] == "p. 4, table 2"
    asked = client.post("/api/programs/contract-fixture/act",
                        json={"swarm_id": s["id"], "action": "correct", "items": ["e1"], "base_revision": "r1"}).json()
    assert asked["status"] == "needs_input"
    fixed = client.post("/api/programs/contract-fixture/act", json={
        "swarm_id": s["id"], "action": "correct", "items": ["e1"], "base_revision": "r1",
        "params": {"text": "Inspection report lists a 5 t rating, valid until 2025", "note": "expiry date missed"}}).json()
    after = {i["id"]: i for i in fixed["graph"]["items"]}
    assert set(after) == set(items) and fixed["graph"]["revision"] == "r2"   # no id lost
    assert after["e1"]["status"] == "corrected" and after["e1"]["revisions"][0]["revision"] == "r1"
    assert "affected-by-correction" in after["c1"]["flags"]
    stale = client.post("/api/programs/contract-fixture/act", json={
        "swarm_id": s["id"], "action": "correct", "items": ["e2"], "base_revision": "r1", "params": {"text": "x"}})
    assert stale.json()["status"] == "stale" and stale.json()["graph"]["revision"] == "r2"


def test_long_actions_become_swarm_goals(client):
    s = swarm(client)
    out = client.post("/api/programs/contract-fixture/act",
                      json={"swarm_id": s["id"], "action": "investigate-gap", "items": ["g1"]}).json()
    assert out["status"] == "started" and out["task"]["kind"] == "goal"
    goals = client.get(f"/api/swarms/{s['id']}/goals").json()
    assert goals[0]["id"] == out["task"]["id"] and goals[0]["created_by"] == "program:contract-fixture"
    cancelled = client.patch(f"/api/goals/{out['task']['id']}", json={"status": "cancelled"}).json()
    assert cancelled["status"] == "cancelled"                                 # cancellation = the goal's own


def test_capabilities_errors_and_disable(client, tmp_path, monkeypatch):
    s = swarm(client)
    bad = tmp_path / "nosy"
    bad.mkdir()
    (bad / "plugin.json").write_text(json.dumps({"id": "nosy", "name": "Nosy", "capabilities": []}))
    (bad / "program.py").write_text(
        "def describe():\n    return {'kinds': [{'id': 'claim', 'role': 'claim'}], 'relations': [], 'actions': []}\n"
        "def view(ctx, focus, stage):\n    ctx.beliefs()\n    return {}\n"
        "def act(ctx, action, items, params):\n    return {'status': 'done'}\n")
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "plugin.json").write_text(json.dumps({"id": "broken", "name": "Broken"}))
    (broken / "program.py").write_text(
        "def describe():\n    return {'kinds': [{'id': 'claim', 'role': 'claim'}], 'relations': [], 'actions': []}\n"
        "def view(ctx, focus, stage):\n    return {'revision': '1', 'items': [{'id': 'a', 'kind': 'nope'}]}\n"
        "def act(ctx, action, items, params):\n    return {}\n")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    listed = {p["id"]: p for p in client.post("/api/programs/reload").json()}
    assert listed["nosy"]["source"] == "plugin-dir" and listed["broken"]["enabled"]
    nosy = client.post("/api/programs/nosy/view", json={"swarm_id": s["id"]})
    assert nosy.status_code == 403 and nosy.json()["error"]["code"] == "capability_missing"
    broke = client.post("/api/programs/broken/view", json={"swarm_id": s["id"]})
    assert broke.status_code == 400 and broke.json()["error"]["code"] == "bad_graph"
    client.post("/api/programs/contract-fixture/disable")
    off = client.post("/api/programs/contract-fixture/view", json={"swarm_id": s["id"]})
    assert off.status_code == 409 and off.json()["error"]["code"] == "program_disabled"
    unknown = client.post("/api/programs/broken/act", json={"swarm_id": s["id"], "action": "explode", "items": []})
    assert unknown.status_code == 400


def test_commons_explorer_over_real_beliefs(client):
    from hive.tests.test_core_api import agent_headers, make_swarm_and_agents
    s, (a, b, c) = make_swarm_and_agents(client, n=3)
    for agent, f, conf in ((a, 0.9, 0.8), (b, 0.2, 0.6)):
        client.post("/api/agent/publish", headers=agent_headers(agent),
                    json={"statement": "(--> bridge safe)", "f": f, "c": conf})
    client.post("/api/agent/publish", headers=agent_headers(c), json={"statement": "(--> bridge closed)", "f": 0.7, "c": 0.5})
    overview = client.post("/api/programs/commons-explorer/view", json={"swarm_id": s["id"]}).json()
    ids = {i["id"] for i in overview["items"]}
    assert {"overview", "b:(--> bridge safe)", "b:(--> bridge closed)"} <= ids
    assert any(i["kind"] == "gap" for i in overview["items"])                 # single-source belief
    one = client.post("/api/programs/commons-explorer/view",
                      json={"swarm_id": s["id"], "focus": "b:(--> bridge safe)", "stage": "unfold"}).json()
    rels = {link["rel"] for link in one["links"]}
    assert {"supports", "contradicts", "rivals"} <= rels
    report = next(i for i in one["items"] if i["kind"] == "report")
    opened = client.post("/api/programs/commons-explorer/act", json={
        "swarm_id": s["id"], "action": "inspect-source", "items": [report["id"]],
        "base_revision": one["revision"]}).json()
    assert opened["status"] == "done" and opened["detail"]["sources"][0]["kind"] == "dot"
    compared = client.post("/api/programs/commons-explorer/act", json={
        "swarm_id": s["id"], "action": "compare", "items": ["b:(--> bridge safe)", "b:(--> bridge closed)"],
        "base_revision": one["revision"]}).json()
    assert compared["status"] == "done" and compared["graph"]["stage"] == "compare"
    mapped = client.post("/api/programs/commons-explorer/view",
                         json={"swarm_id": s["id"], "focus": "b:(--> bridge safe)", "stage": "map"}).json()
    assert "b:(--> bridge closed)" in {i["id"] for i in mapped["items"]}
    client.post("/api/agent/publish", headers=agent_headers(c), json={"statement": "(--> river high)", "f": 0.9, "c": 0.5})
    stale = client.post("/api/programs/commons-explorer/act", json={
        "swarm_id": s["id"], "action": "challenge", "items": ["b:(--> bridge safe)"],
        "base_revision": one["revision"]}).json()
    assert stale["status"] == "stale"
