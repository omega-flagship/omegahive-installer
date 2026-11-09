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


def _enrol(c, name="omegacode"):
    return c.post("/api/services/enrol", json={"name": name}, headers=c.admin).json()["enrol_token"]


def _op_register(c, enrol_token, op, address="http://127.0.0.1:8724"):
    body = {"name": "omegacode", "version": "r13", "address": address, "contract": "1", "surfaces": ["code"],
            "capabilities": ["workspace"], "operation_id": op}
    return c.post("/api/services/register", json=body, headers={"Authorization": f"Bearer {enrol_token}"})


def test_operation_registration_replays_the_same_identity_until_ack(c):
    tok, op = _enrol(c), "op_" + "a" * 20
    first = _op_register(c, tok, op)
    assert first.status_code == 200 and first.json()["receipt"]["status"] == "pending"
    again = _op_register(c, tok, op)                                   # response lost: the same request replays
    assert again.status_code == 200
    for k in ("service_id", "service_token", "capability_secret"):
        assert again.json()[k] == first.json()[k]
    svc = first.json()["service_id"]
    listed = {s["id"]: s for s in c.get("/api/services", headers=c.admin).json()}
    assert listed[svc]["enabled"] is False                              # not live before the service acknowledges
    auth = {"Authorization": f"Bearer {first.json()['service_token']}"}
    ack = c.post(f"/api/services/operations/{op}/ack", headers=auth)
    assert ack.status_code == 200 and ack.json()["status"] == "active"
    assert c.post(f"/api/services/operations/{op}/ack", headers=auth).json()["status"] == "active"   # idempotent
    assert c.get(f"/api/services/operations/{op}", headers=auth).json()["service_id"] == svc
    assert _op_register(c, tok, op).status_code == 409                  # no credentials handed out after ack
    listed = {s["id"]: s for s in c.get("/api/services", headers=c.admin).json()}
    assert listed[svc]["enabled"] is True and len([s for s in listed.values() if s["name"] == "omegacode"]) == 1


def test_operation_registration_refuses_conflicts_and_second_identities(c):
    tok, op = _enrol(c), "op_" + "b" * 20
    assert _op_register(c, tok, op).status_code == 200
    assert _op_register(c, tok, op, address="http://127.0.0.1:9999").status_code == 409   # changed request
    assert _op_register(c, tok, "op_" + "c" * 20).status_code == 403                    # same enrolment, new op
    other = _enrol(c)
    assert _op_register(c, other, op).status_code == 409                                # another token cannot recover
    assert _op_register(c, tok, "short").status_code == 400
    bad = {"Authorization": "Bearer not-the-token"}
    assert c.post(f"/api/services/operations/{op}/ack", headers=bad).status_code == 404


def test_revoking_a_pending_registration_stops_its_replay(c):
    tok, op = _enrol(c), "op_" + "d" * 20
    svc = _op_register(c, tok, op).json()["service_id"]
    assert c.delete(f"/api/services/{svc}", headers=c.admin).status_code == 200
    assert _op_register(c, tok, op).status_code == 409


def test_registration_is_atomic_when_the_operation_record_cannot_be_written(c, monkeypatch):
    """A failure after the identity insert rolls the whole step back: the enrolment stays usable and a retry
    recovers one identity (stand-in review P1)."""
    services = c.app.state.hive.services if hasattr(c.app.state, "hive") else None
    tok, op = _enrol(c), "op_" + "e" * 20
    from hive.core import services as module
    real_insert = module.Services._insert_service
    calls = {"n": 0}
    def failing_then_real(self, row, body, enabled):
        result = real_insert(self, row, body, enabled)
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("crash between identity and operation record")
        return result
    monkeypatch.setattr(module.Services, "_insert_service", failing_then_real)
    try:
        _op_register(c, tok, op)
    except RuntimeError:
        pass
    retry = _op_register(c, tok, op)
    assert retry.status_code == 200
    names = [s for s in c.get("/api/services", headers=c.admin).json() if s["name"] == "omegacode"]
    assert len(names) == 1 and names[0]["id"] == retry.json()["service_id"]


def test_an_unacknowledged_registration_expires_with_its_enrolment(c):
    tok, op = _enrol(c), "op_" + "f" * 20
    svc = _op_register(c, tok, op).json()["service_id"]
    db = c.app.state.hive.db
    db.execute("UPDATE service_enrolments SET expires_at = 0 WHERE service_id = ?", (svc,))
    late = _op_register(c, tok, op)
    assert late.status_code == 409 and late.json()["error"]["code"] == "operation_expired"
    assert db.one("SELECT 1 FROM services WHERE id = ?", (svc,)) is None
    assert db.one("SELECT pending_token FROM service_operations WHERE operation_id = ?", (op,))["pending_token"] is None


def test_an_acknowledgement_after_expiry_revokes_instead_of_activating(c):
    """Stand-in re-review P1: ack must not enable a registration whose enrolment already expired."""
    tok, op = _enrol(c), "op_" + "g" * 20
    first = _op_register(c, tok, op).json()
    svc, auth = first["service_id"], {"Authorization": f"Bearer {first['service_token']}"}
    db = c.app.state.hive.db
    db.execute("UPDATE service_enrolments SET expires_at = 0 WHERE service_id = ?", (svc,))
    late = c.post(f"/api/services/operations/{op}/ack", headers=auth)
    assert late.status_code == 409 and late.json()["error"]["code"] == "operation_expired"
    assert db.one("SELECT 1 FROM services WHERE id = ?", (svc,)) is None          # revocation committed
    assert db.one("SELECT pending_token FROM service_operations WHERE operation_id = ?", (op,))["pending_token"] is None
    assert c.post(f"/api/services/operations/{op}/ack", headers=auth).status_code == 404
    assert c.get(f"/api/services/operations/{op}", headers=auth).status_code == 404
    assert _op_register(c, tok, op).status_code == 409
