"""A goal's result schema is checked before the goal is done; wrong shapes go back to the same mind (Truth, OmegaDesign)."""
import importlib.util
import json
import pathlib

import pytest

from hive.core.result_schema import SchemaError, check_schema, validate
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["artifact_id", "revision", "digest"],
          "properties": {"artifact_id": {"type": "string", "pattern": "^ar_"}, "revision": {"type": "integer", "minimum": 1},
                         "digest": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}, "notes": {"type": "string", "maxLength": 200}}}
GOOD = {"artifact_id": "ar_1", "revision": 1, "digest": "sha256:" + "a" * 64}


def test_validator_names_every_problem_with_its_path():
    assert validate(GOOD, SCHEMA) == []
    errors = validate({"artifact_id": "x", "revision": 0, "extra": 1}, SCHEMA)
    assert "$: missing required field 'digest'" in errors
    assert any(e.startswith("$: unexpected field(s) ['extra']") for e in errors)
    assert "$.artifact_id: must match ^ar_" in errors and "$.revision: at least 1" in errors
    assert validate({"slides": [{}, {"title": 5}]}, {"type": "object", "properties": {"slides": {"type": "array", "minItems": 5,
                    "items": {"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}}}}}) == [
        "$.slides: at least 5 items (has 2)", "$.slides[0]: missing required field 'title'", "$.slides[1].title: expected string, got int"]
    assert validate(True, {"type": "integer"}) == ["$: expected integer, got bool"]


def test_schemas_outside_the_subset_are_refused_not_ignored():
    with pytest.raises(SchemaError, match="unsupported keyword"):
        check_schema({"type": "object", "oneOf": []})
    with pytest.raises(SchemaError, match="unsupported keyword"):
        check_schema({"properties": {"a": {"format": "email"}}})
    with pytest.raises(SchemaError, match="bad pattern"):
        check_schema({"type": "string", "pattern": "("})
    assert check_schema(SCHEMA) is SCHEMA


def _goal(client, swarm, binding):
    return client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "deck", "binding": binding}).json()


def test_wrong_shape_goes_back_to_the_same_mind_and_every_attempt_is_kept(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    assert client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "x", "binding": {"result_schema": {"anyOf": []}}}).status_code == 400
    g = _goal(client, swarm, {"request": "demo", "result_schema": SCHEMA})
    h = agent_headers(a)
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=h)
    seen = client.get(f"/api/agent/goals/{g['id']}", headers=h).json()
    assert seen["result_schema"] == SCHEMA
    url, digest = f"/api/agent/goals/{g['id']}/result", seen["binding_digest"]
    bad = client.post(url, headers=h, json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": {"text": "ar_1 1 sha"}}})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "result_invalid"
    assert "missing required field 'artifact_id'" in bad.json()["error"]["message"] and "still yours" in bad.json()["error"]["message"]
    assert "plain text, not JSON" in bad.json()["error"]["message"]
    assert client.get(f"/api/goals/{g['id']}").json()["status"] == "claimed"            # not done: the mind can repair it
    text = client.post(url, headers=h, json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal_text": "ar_1 1", "parse_error": "Expecting value"}})
    assert text.status_code == 422 and "not valid JSON (Expecting value)" in text.json()["error"]["message"]
    assert client.post(url, headers=agent_headers(b), json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": GOOD}}).status_code == 403
    ok = client.post(url, headers=h, json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": GOOD}})
    assert ok.status_code == 200 and ok.json()["status"] == "done" and ok.json()["result_data"]["proposal"] == GOOD
    attempts = client.get(f"/api/goals/{g['id']}/attempts").json()
    assert [x["ok"] for x in attempts] == [False, False, True]
    assert json.loads(attempts[0]["raw"]) == {"text": "ar_1 1 sha"} and attempts[1]["raw"] == "ar_1 1"
    assert all(x["digest"].startswith("sha256:") and x["agent_id"] == a["id"] for x in attempts)


def test_without_a_schema_text_is_kept_as_before(client):
    swarm, (a, _b) = make_swarm_and_agents(client)
    g = _goal(client, swarm, {"request": "demo"})
    h = agent_headers(a)
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=h)
    digest = client.get(f"/api/agent/goals/{g['id']}", headers=h).json()["binding_digest"]
    out = client.post(f"/api/agent/goals/{g['id']}/result", headers=h,
                      json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal_text": "plain words", "parse_error": "x"}}).json()
    assert out["status"] == "done" and out["result_data"]["proposal"] == {"text": "plain words"} and "parse_error" not in out["result_data"]


def test_a_request_can_carry_the_schema_for_its_receiving_goal(client):
    sw1, (req,) = make_swarm_and_agents(client, n=1)
    sw2 = client.post("/api/swarms", json={"name": "Makers"}).json()
    maker = client.post("/api/agents", json={"name": "Maker", "swarm_id": sw2["id"]}).json()
    client.put(f"/api/swarms/{sw2['id']}/services", json={"kinds": ["design"]})
    own = client.post(f"/api/swarms/{sw1['id']}/goals", json={"title": "need a deck", "assignee": req["id"]}).json()
    client.post(f"/api/agent/goals/{own['id']}/claim", headers=agent_headers(req))
    base = {"kind": "design", "to_swarm": sw2["id"], "from_goal": own["id"], "title": "deck spec"}
    assert client.post("/api/agent/requests", headers=agent_headers(req), json={**base, "constraints": {"result_schema": {"not": {}}}}).status_code == 400
    rq = client.post("/api/agent/requests", headers=agent_headers(req), json={**base, "constraints": {"result_schema": SCHEMA}}).json()
    goal = rq["receiving_goal"]
    client.post(f"/api/agent/goals/{goal}/claim", headers=agent_headers(maker))
    seen = client.get(f"/api/agent/goals/{goal}", headers=agent_headers(maker)).json()
    assert seen["result_schema"] == SCHEMA
    bad = client.post(f"/api/agent/goals/{goal}/result", headers=agent_headers(maker),
                      json={"status": "done", "result": "r", "data": {"binding_digest": seen["binding_digest"], "proposal": {"artifact_id": "ar_1"}}})
    assert bad.status_code == 422 and bad.json()["error"]["errors"][0].startswith("$: missing required field")


def test_the_skill_shows_the_schema_and_keeps_its_wire_format(monkeypatch):
    src = pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "src" / "hive_commons.py"
    spec = importlib.util.spec_from_file_location("hive_commons_schema", src)
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)
    goal = {"id": "g_1", "status": "claimed", "title": "Deck", "assignee": None, "binding": {"request_id": "rq_1"},
            "binding_digest": "sha256:b", "result_schema": SCHEMA, "detail": "Steps"}
    sent = {}

    def fake(method, path, payload=None):
        if method == "POST":
            sent.update(payload)
            return {"id": "g_1"}, None
        return goal, None
    monkeypatch.setattr(hc, "_call", fake)
    out = hc.goal_get("g_1")
    assert "RESULT SCHEMA" in out and '"required":["artifact_id","revision","digest"]' in out and out.endswith("DETAIL:\nSteps")
    hc.goal_propose("g_1", "ar_1 1 sha256:x")
    assert sent["data"]["proposal"] == {"text": "ar_1 1 sha256:x"} and set(sent["data"]) == {"binding_digest", "proposal"}   # wire unchanged
    hc.goal_propose("g_1", json.dumps(GOOD))
    assert sent["data"]["proposal"] == GOOD
