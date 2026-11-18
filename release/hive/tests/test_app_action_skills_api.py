"""Purpose: exercise native app skills through the real host policy, approval and replay routes, and their resume
after an answer lost on the way back."""

import io
import json
import re
import urllib.error
import urllib.parse

from hive.runtime.extensions import helper_apps as apps
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_program_actions import setup


def fields(atom):
    return [json.loads(value) for value in re.findall(r'"(?:\\.|[^"\\])*"', atom)]


def test_generic_skill_obeys_policy_exact_approval_and_idempotency(client, tmp_path, monkeypatch):
    _, mind, _ = setup(client, tmp_path, monkeypatch)
    monkeypatch.setenv("HIVE_API_URL", "http://testserver")
    monkeypatch.setenv("HIVE_WS_TOKEN", mind["token"])
    memory = tmp_path / "memory"
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(memory))
    deliveries, errors = [], []

    def deliver(request, timeout):
        assert timeout == 10
        deliveries.append(json.loads(request.data))
        response = client.post(urllib.parse.urlsplit(request.full_url).path, content=request.data,
                               headers=dict(request.header_items()))
        if response.status_code >= 400:
            errors.append(response.json()["error"]["code"])
            raise urllib.error.HTTPError(request.full_url, response.status_code, "refused", {}, io.BytesIO(response.content))
        return io.BytesIO(response.content)

    monkeypatch.setattr(apps._OPENER, "open", deliver)
    text = json.dumps({"program": "social", "action": "trade", "items": ["p1"], "params": {"quote_id": "q1", "max_cost": 5}})
    assert apps.call("app-act", text).startswith("(AppRefused ") and errors == ["policy_refused"]
    assert client.post("/api/policy", json={"scope": "agent:" + mind["id"], "skill": "program:social:trade", "mode": "ask"}).status_code == 200
    pending = apps.call("app-act", text)
    assert pending.startswith("(AppApprovalRequired ")
    approval_id, key = fields(pending)
    path = memory / "app-actions" / (key + ".json")
    exact = path.read_text()
    resume = json.dumps({"key": key, "approval_id": approval_id})
    assert apps.call("app-resume", resume).startswith("(AppRefused ") and errors[-1] == "not_approved"
    assert client.post("/api/approvals/" + approval_id + "/approve", json={}).status_code == 200

    # The mind owns its memory file. Changing it cannot change what was approved.
    changed = json.loads(exact)
    changed["body"]["params"]["max_cost"] = 500
    path.write_text(json.dumps(changed))
    assert apps.call("app-resume", resume).startswith("(AppRefused ") and errors[-1] == "binding_mismatch"
    path.write_text(exact)
    done = apps.call("app-resume", resume)
    assert done.startswith("(AppResult ") and done.endswith(" authority-none)")
    result = json.loads(fields(done)[1])
    assert result["status"] == "done" and result["detail"]["calls"] == 1
    assert result["detail"]["actor"]["approval"]["id"] == approval_id
    assert apps.call("app-resume", resume) == done
    assert deliveries[-1] == deliveries[-2] == dict(json.loads(exact)["body"], approval_id=approval_id)
    changed["body"]["params"]["max_cost"] = 501
    path.write_text(json.dumps(changed))
    assert apps.call("app-resume", resume).startswith("(AppRefused ") and errors[-1] == "idempotency_conflict"
    activity = client.get("/api/program-activity", params={"program": "social"}).json()
    assert len(activity) == 1 and activity[0]["status"] == "done"


def _losing_host(client, monkeypatch, lose):
    """Deliver each request to the real host; while lose holds True values, drop the answer after the host ran it."""
    deliveries = []

    def deliver(request, timeout):
        deliveries.append(json.loads(request.data))
        response = client.post(urllib.parse.urlsplit(request.full_url).path, content=request.data,
                               headers=dict(request.header_items()))
        if lose and lose.pop(0):
            raise TimeoutError("the answer was lost on the way back")
        if response.status_code >= 400:
            raise urllib.error.HTTPError(request.full_url, response.status_code, "refused", {}, io.BytesIO(response.content))
        return io.BytesIO(response.content)

    monkeypatch.setattr(apps._OPENER, "open", deliver)
    return deliveries


def _mind_skills(client, tmp_path, monkeypatch):
    _, mind, _ = setup(client, tmp_path, monkeypatch)
    monkeypatch.setenv("HIVE_API_URL", "http://testserver")
    monkeypatch.setenv("HIVE_WS_TOKEN", mind["token"])
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path / "memory"))
    return mind


def test_a_resume_after_a_lost_answer_gets_the_hives_record_and_runs_nothing_twice(client, tmp_path, monkeypatch):
    mind = _mind_skills(client, tmp_path, monkeypatch)
    assert client.post("/api/policy", json={"scope": "agent:" + mind["id"], "skill": "program:social:post", "mode": "allow"}).status_code == 200
    deliveries = _losing_host(client, monkeypatch, [True])
    lost = apps.call("app-act", json.dumps({"program": "social", "action": "post", "items": ["p1"], "params": {"text": "hi"}}))
    assert lost.startswith("(AppOutcomeUnknown ")
    key, reason = fields(lost)
    assert reason == "timeout"
    resumed = apps.call("app-resume", json.dumps({"key": key}))
    assert resumed.startswith("(AppResult ")
    result = json.loads(fields(resumed)[1])
    assert result["status"] == "done" and result["detail"]["calls"] == 1   # the host's record of the one run
    assert deliveries[0] == deliveries[1] and deliveries[0]["idempotency_key"] == "app-" + key
    activity = client.get("/api/program-activity", params={"program": "social"}).json()
    assert len(activity) == 1 and activity[0]["status"] == "done"


def test_an_approved_write_whose_answer_was_lost_is_recovered_without_a_second_approval(client, tmp_path, monkeypatch):
    mind = _mind_skills(client, tmp_path, monkeypatch)
    assert client.post("/api/policy", json={"scope": "agent:" + mind["id"], "skill": "program:social:trade", "mode": "ask"}).status_code == 200
    deliveries = _losing_host(client, monkeypatch, [False, True])
    pending = apps.call("app-act", json.dumps({"program": "social", "action": "trade", "items": ["p1"],
                                               "params": {"quote_id": "q1", "max_cost": 5}}))
    approval_id, key = fields(pending)
    assert pending.startswith("(AppApprovalRequired ")
    assert client.post("/api/approvals/" + approval_id + "/approve", json={}).status_code == 200
    lost = apps.call("app-resume", json.dumps({"key": key, "approval_id": approval_id}))
    assert lost.startswith("(AppOutcomeUnknown ") and fields(lost) == [key, "timeout"]
    recovered = apps.call("app-resume", json.dumps({"key": key}))
    assert recovered.startswith("(AppResult ")
    result = json.loads(fields(recovered)[1])
    assert result["status"] == "done" and result["detail"]["calls"] == 1
    assert result["detail"]["actor"]["approval"]["id"] == approval_id
    assert [d["idempotency_key"] for d in deliveries] == ["app-" + key] * 3
    activity = client.get("/api/program-activity", params={"program": "social"}).json()
    assert len(activity) == 1 and activity[0]["status"] == "done"
