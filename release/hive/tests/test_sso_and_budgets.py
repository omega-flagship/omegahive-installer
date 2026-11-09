"""Sign-in through the family webhost, the public gate, and spending limits at every level."""

import json
import os
import pathlib
import tempfile
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


def webhost(tmp, sessions, users):
    root = pathlib.Path(tmp) / "webhost"
    root.mkdir()
    (root / "sessions.json").write_text(json.dumps(sessions))
    (root / "users.json").write_text(json.dumps(users))
    return root


@pytest.fixture()
def hive(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="hive-sso-")
    later = int(time.time()) + 3600
    root = webhost(tmp, {"tok-jon": {"username": "jon", "expires": later}, "tok-mia": {"username": "mia", "expires": later},
                         "tok-old": {"username": "jon", "expires": int(time.time()) - 5}},
                   {"jon": {"role": "admin", "name": "Jon Grove"}, "mia": {"role": "family", "name": "Mia"}})
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(root))
    monkeypatch.setenv("HIVE_SSO_USERS", "jon")
    settings = load_settings(data_dir=pathlib.Path(tmp) / "hive", admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive", allow_unpriced=False)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as client:
        yield client


def sso(client, cookie):
    return client.post("/omegahive/api/auth/sso", headers={"Cookie": f"omega_session={cookie}"})


def test_signed_in_allowed_person_gets_a_public_session(hive):
    methods = hive.get("/omegahive/api/auth/methods").json()
    assert methods["public"] is True and methods["password"] is False
    assert methods["sso"]["enabled"] and methods["sso"]["login_url"] == "/login?next=/omegahive/"
    r = sso(hive, "tok-jon")
    assert r.status_code == 200 and r.json()["user"]["username"] == "jon"
    token = r.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert hive.get("/omegahive/api/hive", headers=headers).json()["name"] == "OmegaHive"
    assert hive.get("/omegahive/api/auth/me", headers=headers).json()["principal"] == "user:jon"
    with hive.websocket_connect(f"/omegahive/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
    assert hive.post("/omegahive/api/auth/logout", headers=headers).json() == {"ok": True, "sessions_kept": 0}   # host-identity r1.1
    assert hive.get("/omegahive/api/hive", headers=headers).status_code == 401


def test_others_are_refused(hive):
    for cookie in ("tok-old", "tok-forged", ""):
        r = sso(hive, cookie)
        assert r.status_code == 401 and r.json()["error"]["code"] == "sso_required"
        assert r.json()["error"]["login_url"] == "/login?next=/omegahive/"
    # signed in to the family host, but neither a listed admin nor invited to this hive
    r = sso(hive, "tok-mia")
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_invited"
    # a cookie alone is never an API credential
    assert hive.get("/omegahive/api/hive", headers={"Cookie": "omega_session=tok-jon"}).status_code == 401


def test_public_requests_cannot_reach_agent_routes_or_traverse(hive):
    assert hive.post("/omegahive/llm/v1/chat/completions", json={}).status_code == 404
    assert hive.get("/omegahive/api/agent/inbox").status_code == 404
    assert hive.get("/omegahive/api/agent/goals").status_code == 404
    assert hive.get("/omegahive/agent-hub").status_code == 404
    # the operator's own routes that merely start with "agent" are not agent routes
    token = sso(hive, "tok-jon").json()["token"]
    for route in ("/omegahive/api/agents", "/omegahive/api/hive", "/omegahive/api/swarms", "/omegahive/api/models",
                  "/omegahive/api/programs", "/omegahive/api/approvals", "/omegahive/api/lab/suites", "/omegahive/api/keys",
                  "/omegahive/api/providers", "/omegahive/api/budgets", "/omegahive/api/usage"):
        r = hive.get(route, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, (route, r.status_code, r.text[:200])
    # a proxy header makes even a root path public
    r = hive.post("/api/auth/login", json={"password": "pw"}, headers={"Cf-Connecting-Ip": "203.0.113.9"})
    assert r.status_code == 403
    assert hive.post("/llm/v1/chat/completions", json={}, headers={"X-Forwarded-For": "203.0.113.9"}).status_code == 404
    # the local password still works locally, and local agent routes still answer (401 without a token)
    assert hive.post("/api/auth/login", json={"password": "pw"}).status_code == 200
    assert hive.post("/llm/v1/chat/completions", json={}).status_code == 401


def test_expired_session_is_refused(hive):
    token = sso(hive, "tok-jon").json()["token"]
    app = hive.app
    db = app.state.hive.db
    db.execute("UPDATE sessions SET expires_at = ? WHERE kind = 'sso'", (time.time() - 1,))
    assert hive.get("/omegahive/api/hive", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def _openrouter(hive_client, handler_cost):
    app = hive_client.app
    def handler(request):
        if request.url.path.endswith("/key"):
            return httpx.Response(200, json={"data": {"label": "t"}})
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "acme/alpha", "name": "Alpha", "pricing": {"prompt": "0.00001", "completion": "0.00001"}}]})
        return httpx.Response(200, json={"choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}}],
                                         "usage": {"prompt_tokens": handler_cost, "completion_tokens": 0}})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.state.gateway.client = client
    app.state.hive.providers.client = client


def test_swarm_default_limit_and_rules_at_every_level(hive):
    token = hive.post("/api/auth/login", json={"password": "pw"}).json()["token"]
    hive.headers["Authorization"] = f"Bearer {token}"
    _openrouter(hive, 100_000)  # each call costs $1.00 at $10/M
    assert hive.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-x", "label": "T"}).status_code == 200
    hive.get("/api/providers/openrouter/catalog")
    swarm = hive.post("/api/swarms", json={"name": "Alpha"}).json()
    mind = hive.post("/api/agents", json={"name": "Vega", "kind": "omega", "swarm_id": swarm["id"], "model": "openrouter/acme/alpha",
                                          "budget_usd": 1000}).json()
    overview = hive.get("/api/budgets").json()
    default = next(b for b in overview if b["scope"] == f"swarm:{swarm['id']}")
    assert default["limit_usd"] == 500 and default["period"] == "month" and default["origin"] == "default"

    def call():
        return hive.post("/llm/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}], "max_tokens": 1},
                         headers={"Authorization": f"Bearer {mind['token']}"})

    assert call().status_code == 200
    # a tighter rule on the mind refuses the next call, naming the rule
    rule = hive.post("/api/budgets", json={"scope": f"agent:{mind['id']}", "period": "day", "limit_usd": 0.5}).json()
    r = call()
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit" and r.json()["error"]["scope"] == f"agent:{mind['id']}"
    hive.delete(f"/api/budgets/{rule['id']}")
    # the swarm's own rule replaces the default
    hive.post("/api/budgets", json={"scope": f"swarm:{swarm['id']}", "period": "month", "limit_usd": 0.5})
    r = call()
    assert r.status_code == 402 and r.json()["error"]["scope"] == f"swarm:{swarm['id']}"
    hive.post("/api/budgets", json={"scope": f"swarm:{swarm['id']}", "period": "month", "limit_usd": 500})
    assert call().status_code == 200
    # the hive-wide rule applies to every mind
    hive.post("/api/budgets", json={"scope": "hive", "period": "total", "limit_usd": 1.5})
    assert call().status_code == 402
    spent = {b["scope"]: b["spent_usd"] for b in hive.get("/api/budgets").json()}
    assert spent["hive"] == pytest.approx(2.0)
    bad = hive.post("/api/budgets", json={"scope": "swarm:nope", "period": "month", "limit_usd": 5})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_scope"


def test_prefix_without_slash_redirects(hive):
    r = hive.get("/omegahive", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/omegahive/"
    r = hive.get("/omegahive?invite=abc", follow_redirects=False)
    assert r.headers["location"] == "/omegahive/?invite=abc"


def _named_hive(monkeypatch, linked=True, disabled=0):
    tmp = tempfile.mkdtemp(prefix="hive-sso-named-")
    later = int(time.time()) + 3600
    jon = {"role": "admin", "name": "Jon Grove", "google_email": "Jon@Example.org"}
    if linked:
        jon["google_linked_at"] = later - 7200
    root = webhost(tmp, {"tok-jon": {"username": "jon", "expires": later}}, {"jon": jon})
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(root))
    monkeypatch.setenv("HIVE_SSO_USERS", "jon")
    settings = load_settings(data_dir=pathlib.Path(tmp) / "hive", admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive", allow_unpriced=False)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    app.state.hive.db.insert("people", {"id": "u_jon0001", "email": "jon@example.org", "name": "Jon", "role": "admin",
                                        "invited_by": "test", "created_at": "2026-10-04T00:00:00Z", "last_seen_at": None,
                                        "disabled": disabled})
    return app


def test_family_login_with_a_verified_linked_google_address_is_the_named_person(monkeypatch):
    with TestClient(_named_hive(monkeypatch)) as client:
        r = sso(client, "tok-jon")
        assert r.status_code == 200 and r.json()["user"]["id"] == "u_jon0001"
        me = client.get("/omegahive/api/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}"}).json()
        assert me["principal"] == "user:u_jon0001"


def test_unlinked_address_or_disabled_person_stays_the_family_username(monkeypatch):
    for kwargs in ({"linked": False}, {"disabled": 1}):
        with TestClient(_named_hive(monkeypatch, **kwargs)) as client:
            r = sso(client, "tok-jon")
            assert r.status_code == 200 and r.json()["user"]["username"] == "jon"


def test_a_live_invite_is_accepted_through_the_verified_family_sign_in(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="hive-sso-invite-")
    later = int(time.time()) + 3600
    root = webhost(tmp, {"tok-ly": {"username": "mia", "expires": later}},
                   {"mia": {"role": "family", "name": "Mia", "google_email": "Mia@Example.org", "google_linked_at": later - 60}})
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(root))
    monkeypatch.setenv("HIVE_SSO_USERS", "jon")
    settings = load_settings(data_dir=pathlib.Path(tmp) / "hive", admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive", allow_unpriced=False)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    hive_ = app.state.hive
    hive_.db.insert("invites", {"id": "i_ly", "email": "mia@example.org", "name": "Mia", "role": "member",
                                "token_hash": "x", "created_by": "user:operator", "created_at": "2026-10-04T00:00:00Z",
                                "expires_at": time.time() + 3600, "accepted_at": None, "accepted_by": None, "revoked_at": None})
    with TestClient(app) as client:
        r = sso(client, "tok-ly")
        assert r.status_code == 200 and r.json()["user"]["role"] == "member"
        person_id = r.json()["user"]["id"]
        assert hive_.db.one("SELECT accepted_by FROM invites WHERE id = 'i_ly'")["accepted_by"] == person_id
        again = sso(client, "tok-ly")                                   # next time: simply that person
        assert again.status_code == 200 and again.json()["user"]["id"] == person_id
