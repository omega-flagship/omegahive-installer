"""Registered services, hive-signed capabilities, collaborator grants and exact code approvals."""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
DIGEST = "sha256:" + "ab" * 32


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


@pytest.fixture()
def c():
    tmp = tempfile.mkdtemp(prefix="hive-svc-")
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        client.admin = {"Authorization": "Bearer " + client.post("/api/auth/login", json={"password": "pw"}).json()["token"]}
        yield client


def register(c, name="omegacode"):
    enrol = c.post("/api/services/enrol", json={"name": name}, headers=c.admin).json()
    body = {"name": name, "version": "0.1.0", "address": "http://127.0.0.1:8724", "contract": "omegacode/1",
            "surfaces": ["diff", "log", "editor"], "capabilities": ["workspaces", "runs"]}
    r = c.post("/api/services/register", json=body, headers={"Authorization": f"Bearer {enrol['enrol_token']}"})
    return enrol, body, r


def verify(token, secret):
    prefix, payload, sig = token.split(".")
    assert prefix == "hc1"
    assert hmac.compare_digest(sig, hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest())
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def mind_with_goal(c):
    swarm = c.post("/api/swarms", json={"name": "Code local"}, headers=c.admin).json()
    mind = c.post("/api/agents", json={"name": "Coder", "kind": "omega", "swarm_id": swarm["id"], "model": "mock/echo"}, headers=c.admin).json()
    goal = c.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "fix the bug"}, headers=c.admin).json()
    agent = {"Authorization": f"Bearer {mind['token']}"}
    assert c.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent).status_code == 200
    return swarm, mind, goal, agent


def test_enrolment_is_one_time_local_and_named(c):
    enrol, body, r = register(c)
    assert r.status_code == 200
    reg = r.json()
    assert reg["service_id"].startswith("svc_") and reg["service_token"] and reg["capability_secret"]
    again = c.post("/api/services/register", json=body, headers={"Authorization": f"Bearer {enrol['enrol_token']}"})
    assert again.status_code == 403 and again.json()["error"]["code"] == "enrolment_invalid"
    e2 = c.post("/api/services/enrol", json={"name": "omegacode"}, headers=c.admin).json()
    wrong = c.post("/api/services/register", json=body | {"name": "other"}, headers={"Authorization": f"Bearer {e2['enrol_token']}"})
    assert wrong.json()["error"]["code"] == "enrolment_name"
    remote = c.post("/api/services/register", json=body | {"address": "http://10.0.0.5:8724"}, headers={"Authorization": f"Bearer {e2['enrol_token']}"})
    assert remote.json()["error"]["code"] == "bad_address"
    proxied = c.post("/api/services/register", json=body, headers={"Authorization": f"Bearer {e2['enrol_token']}", "X-Forwarded-For": "203.0.113.1"})
    assert proxied.status_code == 403
    listed = c.get("/api/services", headers=c.admin).json()
    assert [s["name"] for s in listed] == ["omegacode"] and "capability_secret" not in json.dumps(listed)
    # a service token is not an operator or a mind
    svc = {"Authorization": f"Bearer {reg['service_token']}"}
    assert c.get("/api/hive", headers=svc).status_code == 401
    assert c.get("/api/agent/goals", headers=svc).status_code == 401


def test_capabilities_are_signed_checked_and_revocable(c):
    _, _, r = register(c)
    reg = r.json()
    svc = {"Authorization": f"Bearer {reg['service_token']}"}
    swarm, mind, goal, agent = mind_with_goal(c)
    cap = c.post("/api/agent/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read", "edit"]}, headers=agent).json()
    claims = verify(cap["token"], reg["capability_secret"])
    assert claims["kind"] == "agent" and claims["actor"] == mind["id"] and claims["aud"] == reg["service_id"]
    assert claims["member_hash"] == hashlib.sha256(mind["token"].encode()).hexdigest()
    # a narrowed request stays narrowed (security fix 2026-10-04); bad paths and unknown fields refuse
    narrow = c.post("/api/agent/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read"],
                                                        "paths": ["calculator.py"]}, headers=agent).json()
    assert verify(narrow["token"], reg["capability_secret"])["paths"] == ["calculator.py"]
    for bad in ({"paths": ["/etc/passwd"]}, {"paths": ["../x"]}, {"paths": "calculator.py"}, {"scope": "everything"}):
        r = c.post("/api/agent/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read"]} | bad,
                   headers=agent)
        assert r.status_code == 400, bad
    status = c.get(f"/api/services/capabilities/{claims['id']}", headers=svc).json()
    assert status["active"] is True
    # tampering breaks the signature
    prefix, payload, sig = cap["token"].split(".")
    forged = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))) | {"actions": ["run"]}
    forged_payload = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode().rstrip("=")
    assert not hmac.compare_digest(sig, hmac.new(reg["capability_secret"].encode(), forged_payload.encode(), hashlib.sha256).hexdigest())
    # revocation and a closed task both end it
    c.delete(f"/api/services/capabilities/{claims['id']}", headers=c.admin)
    assert c.get(f"/api/services/capabilities/{claims['id']}", headers=svc).json() == {"id": claims["id"], "active": False, "reason": "revoked", "claims": claims}
    cap2 = c.post("/api/agent/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read"]}, headers=agent).json()
    c.patch(f"/api/goals/{goal['id']}", json={"status": "cancelled"}, headers=c.admin)
    assert c.get(f"/api/services/capabilities/{cap2['claims']['id']}", headers=svc).json()["reason"] == "task_closed"
    # only the claimer gets a capability
    other = c.post("/api/agents", json={"name": "Other", "kind": "omega", "swarm_id": swarm["id"], "model": "mock/echo"}, headers=c.admin).json()
    r = c.post("/api/agent/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read"]},
               headers={"Authorization": f"Bearer {other['token']}"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "goal_not_owned"


def test_human_collaborator_grant(c):
    _, _, r = register(c)
    reg = r.json()
    svc = {"Authorization": f"Bearer {reg['service_token']}"}
    swarm, mind, goal, agent = mind_with_goal(c)
    grant = c.post(f"/api/goals/{goal['id']}/grants", json={"scope": "edit", "workspace_id": "ws_1"}, headers=c.admin).json()
    assert grant["active"] and grant["principal"] == "user:operator"
    # the mind keeps its claim; the person gets a separate capability tied to the grant
    assert c.get(f"/api/agent/goals/{goal['id']}", headers=agent).json()["claimed_by"] == mind["id"]
    cap = c.post("/api/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read", "edit"], "grant_id": grant["id"]}, headers=c.admin).json()
    claims = verify(cap["token"], reg["capability_secret"])
    assert claims["kind"] == "human" and claims["grant_id"] == grant["id"] and claims["swarm_id"] == swarm["id"]
    assert [g["id"] for g in c.get(f"/api/goals/{goal['id']}/grants", headers=svc).json()] == [grant["id"]]
    c.delete(f"/api/goals/{goal['id']}/grants/{grant['id']}", headers=c.admin)
    status = c.get(f"/api/services/capabilities/{claims['id']}", headers=svc).json()
    assert status["active"] is False and status["reason"] in ("revoked", "grant_withdrawn")
    bad = c.post("/api/code/capability", json={"task_id": goal["id"], "repository_id": "synthetic", "actions": ["edit"], "grant_id": grant["id"]}, headers=c.admin)
    assert bad.status_code == 403 and bad.json()["error"]["code"] == "grant_invalid"


def test_exact_code_approvals_are_redeemed_once_by_the_service(c):
    _, _, r = register(c)
    svc = {"Authorization": f"Bearer {r.json()['service_token']}"}
    swarm, mind, goal, agent = mind_with_goal(c)
    command = f"(code-edit task={goal['id']} swarm={swarm['id']} workspace=ws_1 op=op-1 generation=3 digest={DIGEST})"
    first = c.post("/api/agent/authorize", json={"command": command}, headers=agent).json()
    assert first["decision"] == "pending" and first["approved"] is False
    approval_id = first["approval_id"]
    binding = {"task_id": goal["id"], "swarm_id": swarm["id"], "workspace_id": "ws_1", "operation_id": "op-1",
               "expected_generation": 3, "payload_digest": DIGEST}
    view = c.get(f"/api/agent/approvals/{approval_id}", headers=svc).json()
    assert view["binding"] == binding and view["skill"] == "code-edit" and view["agent_id"] == mind["id"]
    assert c.post(f"/api/agent/approvals/{approval_id}/redeem", json={"binding": binding}, headers=svc).json()["error"]["code"] == "not_approved"
    c.post(f"/api/approvals/{approval_id}/approve", json={}, headers=c.admin)
    # the generic gate never consumes it
    again = c.post("/api/agent/authorize", json={"command": command}, headers=agent).json()
    assert again["decision"] == "pending" and again["approved"] is True and again["approval_id"] == approval_id
    changed = binding | {"payload_digest": "sha256:" + "cd" * 32}
    assert c.post(f"/api/agent/approvals/{approval_id}/redeem", json={"binding": changed}, headers=svc).json()["error"]["code"] == "binding_mismatch"
    assert c.post(f"/api/agent/approvals/{approval_id}/redeem", json={"binding": binding}, headers=svc).json()["status"] == "used"
    assert c.post(f"/api/agent/approvals/{approval_id}/redeem", json={"binding": binding}, headers=svc).json()["error"]["code"] == "approval_redeemed"
    # a mind cannot redeem, and creation with null workspace/generation parses to null
    assert c.post(f"/api/agent/approvals/{approval_id}/redeem", json={"binding": binding}, headers=agent).status_code == 401
    create = f"(code-workspace task={goal['id']} swarm={swarm['id']} workspace=none op=create-1 generation=0 digest={DIGEST})"
    pid = c.post("/api/agent/authorize", json={"command": create}, headers=agent).json()["approval_id"]
    assert c.get(f"/api/agent/approvals/{pid}", headers=svc).json()["binding"]["workspace_id"] is None
    # malformed mutating commands are refused, publishing is human-only, reads are allowed
    bad = c.post("/api/agent/authorize", json={"command": f"(code-run {DIGEST})"}, headers=agent).json()
    assert bad["decision"] == "deny"
    assert c.post("/api/agent/authorize", json={"command": f"(code-publish {DIGEST})"}, headers=agent).json()["decision"] == "deny"
    assert c.post("/api/agent/authorize", json={"command": f'(code-read "{DIGEST}")'}, headers=agent).json()["decision"] == "allow"
