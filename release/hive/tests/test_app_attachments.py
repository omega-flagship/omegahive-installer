"""Candidate lifecycle through real HTTP auth, using invented local stores only."""
import hashlib
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
import pytest
from hive.tests.test_core_api import client, agent_headers

def _sibling_root(app):
    """The folder holding the closed-source sibling repo `app` checked out next to this one, or None."""
    return next((p for p in Path(__file__).resolve().parents
                 if (p / app / "candidates/attachment_bridge").exists() and (p / app / "tests/test_action_bridge.py").exists()), None)


def _needs(app):
    return f"needs closed-source sibling repo {app} (Closed Source for Product Consideration)"


ROOTS = {app: _sibling_root(app) for app in ("omegafusion", "omegasocial")}
ROOT = ROOTS["omegafusion"]
pytestmark = pytest.mark.skipif(ROOT is None, reason=_needs("omegafusion"))


def fixture_module(app):
    path = ROOTS[app] / app / "tests/test_action_bridge.py"
    spec = importlib.util.spec_from_file_location("attachment_fixture_" + app, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def named_admin(client):
    # Synthetic sign-in identity in the disposable host. No Google call, live
    # enrollment or credential. The HTTP role resolver still checks this person.
    db = client.app.state.hive.db
    db.insert("people", {"id": "u_fixture", "email": "invented@example.invalid", "name": "Invented admin", "role": "admin", "created_at": "fixture"})
    db.execute("UPDATE sessions SET kind='sso',principal='user:u_fixture' WHERE token_hash=?", (hashlib.sha256(client.operator_token.encode()).hexdigest(),))


def setup_app(client, tmp_path, monkeypatch, app="omegafusion"):
    module = fixture_module(app)
    values = module.setup(client, tmp_path, monkeypatch)
    swarm, mind = values[:2]
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(ROOTS[app] / app / "candidates/attachment_bridge"))
    assert client.post("/api/programs/reload").status_code == 200
    assert client.post(f"/api/programs/{app}/activations", json={"swarm_id": swarm["id"]}).status_code == 403
    named_admin(client)
    assert client.post(f"/api/programs/{app}/activations", json={"swarm_id": swarm["id"]}).status_code == 200
    channels = client.post(f"/api/programs/{app}/offers", json={"mind_id": mind["id"]}).json()["channels_offered"]
    action = "forecast" if app == "omegafusion" else "post"
    data = {"mind_id": mind["id"], "actions": [action], "channels": channels, "policy": {action: "allow"}, "idempotency_key": "review1"}
    params = module.forecast() if app == "omegafusion" else {"channel": values[4], "kind": "chat", "body": "Invented attached chat", "refs": []}
    return module, values, data, params


def attach(client, app, data):
    return client.post(f"/api/programs/{app}/attachments", json=data)


@pytest.mark.parametrize("app", [
    pytest.param(app, marks=pytest.mark.skipif(ROOTS[app] is None, reason=_needs(app))) for app in ("omegafusion", "omegasocial")])
def test_actual_app_attachment_retry_effect_and_revoke(client, tmp_path, monkeypatch, app):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch, app)
    _, mind = values[:2]
    action = data["actions"][0]
    module.policy(client, mind, action)
    assert module.call(client, mind, action, params, "before").status_code == 403
    calls = list(client.supervisor.calls)
    first = attach(client, app, data)
    assert first.status_code == 200, first.text
    aid = first.json()["id"]
    assert first.json()["status"] == "active" and aid.startswith("at_")
    assert attach(client, app, data).json() == first.json()
    assert attach(client, app, dict(data, channels=[])).status_code == 409
    out = module.call(client, mind, action, params, "effect")
    assert out.status_code == 200 and out.json()["status"] == "done", out.text
    assert module.call(client, mind, action, params, "effect").json() == out.json()
    assert client.delete(f"/api/programs/{app}/attachments/{aid}").json()["status"] == "revoked"
    assert module.call(client, mind, action, params, "after").status_code == 403
    assert client.supervisor.calls == calls  # attachment neither creates nor wakes a fleet
    with sqlite3.connect(values[3]) as db:
        table = "forecasts" if app == "omegafusion" else "entries"
        assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 1
    with client.app.state.hive.db._lock:
        assert not client.app.state.hive.db.all("SELECT * FROM policy_rules WHERE note=?", ("attachment:" + aid,))


def test_revocation_cleanup_failure_stops_access_and_reconciles(client, tmp_path, monkeypatch):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch)
    aid = attach(client, "omegafusion", data).json()["id"]
    hive = client.app.state.hive
    plugin = hive.programs._ready("omegafusion")["module"]
    original = plugin.unbind
    def fail(*args): raise RuntimeError("invented cleanup failure")
    monkeypatch.setattr(plugin, "unbind", fail)
    result = client.delete(f"/api/programs/omegafusion/attachments/{aid}")
    assert result.status_code >= 400
    assert hive.app_attachments.row(aid)["status"] == "unbind_pending"
    assert module.call(client, values[1], "forecast", params, "refused").status_code == 403
    monkeypatch.setattr(plugin, "unbind", original)
    client.portal.call(hive.app_attachments.reconcile)
    assert hive.app_attachments.row(aid)["status"] == "revoked"


def test_bind_committed_host_grant_failed_retry_and_stale_reconcile(client, tmp_path, monkeypatch):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch)
    hive = client.app.state.hive
    update = hive.db.update
    def fail(table, key, patch):
        if table == "app_attachments" and patch.get("status") == "active": raise RuntimeError("invented host commit failure")
        return update(table, key, patch)
    with monkeypatch.context() as m:
        m.setattr(hive.db, "update", fail)
        with pytest.raises(RuntimeError): attach(client, "omegafusion", data)
    row = hive.db.one("SELECT * FROM app_attachments")
    assert row["status"] == "binding"
    assert not hive.db.all("SELECT * FROM policy_rules WHERE note=?", ("attachment:" + row["id"],))
    assert not hive.db.all("SELECT * FROM messages WHERE agent_id=?", (values[1]["id"],))
    assert module.call(client, values[1], "forecast", params, "before-retry").status_code == 403
    retried = attach(client, "omegafusion", data)
    assert retried.json()["status"] == "active"
    with sqlite3.connect(values[3]) as db:
        assert db.execute("SELECT version FROM bindings").fetchone()[0] == 1
    client.delete(f"/api/programs/omegafusion/attachments/{row['id']}")
    client.portal.call(hive.app_attachments.finish_bind, row)  # stale pending snapshot must not resurrect
    assert hive.app_attachments.row(row["id"])["status"] == "revoked"


def test_scope_expiry_deactivation_and_approval_attachment_binding(client, tmp_path, monkeypatch):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch)
    for patch in ({"actions": ["seed"]}, {"channels": ["foreign"]}, {"expires_at": "2000-01-01T00:00:00Z"}, {"policy": {"forecast": "allow", "execute": "allow"}}):
        assert attach(client, "omegafusion", dict(data, **patch)).status_code == 400
    data["policy"]["forecast"] = "ask"
    aid = attach(client, "omegafusion", data).json()["id"]
    pending = module.call(client, values[1], "forecast", params, "ask").json()
    assert pending["status"] == "approval_required"
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={})
    client.delete(f"/api/programs/omegafusion/attachments/{aid}")
    second = attach(client, "omegafusion", dict(data, idempotency_key="review2")).json()
    assert module.call(client, values[1], "forecast", params, "ask", approval_id=pending["approval_id"]).status_code == 409
    hive = client.app.state.hive
    hive.db.update("app_attachments", second["id"], {"expires": "2000-01-01T00:00:00Z"})
    assert module.call(client, values[1], "forecast", params, "expired").status_code == 403
    client.portal.call(hive.app_attachments.reconcile)
    assert hive.app_attachments.row(second["id"])["status"] == "revoked"
    attach(client, "omegafusion", dict(data, idempotency_key="review3"))
    assert client.delete(f"/api/programs/omegafusion/activations/{values[0]['id']}").json()["active"] is False
    assert module.call(client, values[1], "forecast", params, "inactive").status_code == 403


def test_existing_restriction_membership_role_and_null_channels(client, tmp_path, monkeypatch):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch)
    swarm, mind = values[:2]
    route = "/api/programs/omegafusion/attachments"
    assert client.post(route, headers=agent_headers(mind), json=data).status_code == 401
    hive = client.app.state.hive
    hive.db.update("people", "u_fixture", {"role": "member"})
    assert attach(client, "omegafusion", data).status_code == 403
    hive.db.update("people", "u_fixture", {"role": "admin"})
    aid = attach(client, "omegafusion", dict(data, channels=None)).json()["id"]
    assert module.call(client, mind, "forecast", params, "none").json()["status"] == "refused"
    client.delete(f"{route}/{aid}")
    aid = attach(client, "omegafusion", dict(data, idempotency_key="review2")).json()["id"]
    module.policy(client, mind, "forecast", "ask")
    assert module.call(client, mind, "forecast", params, "must-ask").json()["status"] == "approval_required"
    module.policy(client, mind, "forecast", "deny")
    assert module.call(client, mind, "forecast", params, "must-deny").status_code == 403
    # Moving a mind cannot carry another swarm's activation/attachment with it.
    hive.db.update("agents", mind["id"], {"swarm_id": "s_foreign"})
    assert module.call(client, mind, "forecast", params, "moved").status_code == 403


def test_reload_without_hooks_cannot_drop_existing_lifecycle_gate(client, tmp_path, monkeypatch):
    module, values, data, params = setup_app(client, tmp_path, monkeypatch)
    aid = attach(client, 'omegafusion', data).json()['id']
    client.delete(f'/api/programs/omegafusion/attachments/{aid}')
    module.policy(client, values[1], 'forecast', 'allow')
    monkeypatch.setenv('HIVE_PLUGIN_DIRS', str(module.PLUGIN))
    assert client.post('/api/programs/reload').status_code == 200
    assert module.call(client, values[1], 'forecast', params, 'reload-bypass').status_code == 403


def test_attachment_inbox_notices_are_atomic_once_and_never_wake(client, tmp_path, monkeypatch):
    _, values, data, _ = setup_app(client, tmp_path, monkeypatch)
    hive = client.app.state.hive
    mind = values[1]
    hive.db.update('agents',mind['id'],{'status':'asleep'})
    calls = list(client.supervisor.calls)
    aid = attach(client,'omegafusion',data).json()['id']
    assert attach(client,'omegafusion',data).json()['id'] == aid
    notices = hive.db.all('SELECT * FROM messages WHERE agent_id=? ORDER BY hub_seq',(mind['id'],))
    assert len(notices) == 1 and notices[0]['sender'] == 'user:u_fixture'
    assert json.loads(notices[0]['extra'])['phase'] == 'active'
    plugin = hive.programs._ready('omegafusion')['module']
    unbind = plugin.unbind
    def fail(*args): raise RuntimeError('invented cleanup failure')
    monkeypatch.setattr(plugin,'unbind',fail)
    assert client.delete(f'/api/programs/omegafusion/attachments/{aid}').status_code == 500
    notices = hive.db.all('SELECT * FROM messages WHERE agent_id=? ORDER BY hub_seq',(mind['id'],))
    assert [json.loads(n['extra'])['phase'] for n in notices] == ['active','revoked']
    assert [n['hub_seq'] for n in notices] == [1,2]
    assert hive._agent_row(mind['id'])['status'] == 'asleep' and client.supervisor.calls == calls
    monkeypatch.setattr(plugin,'unbind',unbind)
    assert client.delete(f'/api/programs/omegafusion/attachments/{aid}').status_code == 200
    assert len(hive.db.all('SELECT * FROM messages WHERE agent_id=?',(mind['id'],))) == 2
    delivered = []
    async def record(agent, message): delivered.append(json.loads(message['extra'])['phase'])
    monkeypatch.setattr(hive,'deliver',record)
    client.portal.call(hive.replay,mind['id'],0)
    assert delivered == ['active','revoked']
