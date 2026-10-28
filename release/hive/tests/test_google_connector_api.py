"""Google route authority and disclosure boundaries; the synchronous connector is synthetic."""

import asyncio
import pathlib
import threading
import time

import pytest
from fastapi.testclient import TestClient

from hive.core import app as app_module
from hive.core import updates as updates_module
from hive.core.config import load_settings
from hive.core.db import now
from hive.core.google_connector import GoogleConnectorError
from hive.core.hive import token_hash
from hive.tests.test_core_api import FakeSupervisor, PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

QUERY = {"op": "calendar.read", "time_min": "2026-10-26T00:00:00Z", "time_max": "2026-10-27T00:00:00Z", "limit": 10}
PREFIX = "/connector-test"
CALLBACK = PREFIX + "/api/connectors/google/callback"


class SyntheticConnector:
    """Records the trusted route arguments; real token/scope/PKCE tests belong to the core fixture."""

    def __init__(self, hive, settings, backend=None, person_role=None):
        self.hive = hive
        self.redirect_uri = settings.public_url.rstrip("/") + "/api/connectors/google/callback"
        self.calls = []
        self.connected = set()
        self.grants = set()
        self.pending = {}
        self.on_read = None
        self.fail_complete = False

    def record(self, name, *args):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise AssertionError("blocking connector method ran on the event loop")
        self.calls.append((name, threading.get_ident(), args))

    def status(self, principal):
        self.record("status", principal)
        return {"ready": True, "connected": principal in self.connected, "backend": "B",
                "allowed_minds": sorted(agent for person, agent in self.grants if person == principal),
                "calendar_scope": "https://www.googleapis.com/auth/calendar.events.readonly"}

    def configure_client(self, client_id, client_secret):
        self.record("configure", client_id, client_secret)
        return {"ready": True, "backend": "B"}

    def start(self, session, browser):
        self.record("start", dict(session), browser)
        self.pending["synthetic-state"] = (dict(session), browser)
        return {"authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state",
                "expires_at": time.time() + 900}

    def complete(self, state, code, browser):
        self.record("complete", state, code, browser)
        saved = self.pending.pop(state, None)
        if self.fail_complete or saved is None or saved[1] != browser:
            raise GoogleConnectorError(400, "bad_state", "connection could not be completed")
        session = self.hive.db.one("SELECT * FROM sessions WHERE token_hash = ?", (saved[0]["token_hash"],))
        if session is None or session["expires_at"] <= time.time() or session["principal"] != saved[0]["principal"]:
            raise GoogleConnectorError(401, "session_ended", "log in again")
        self.connected.add(session["principal"])
        return self.status(session["principal"])

    def grant_mind(self, session, agent_id, allowed):
        self.record("grant", dict(session), agent_id, allowed)
        principal = session["principal"]
        mind = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if mind is None or mind["owner"] != principal or principal not in self.connected:
            raise GoogleConnectorError(403, "owner_only", "only the current owner can consent")
        if allowed:
            self.grants.add((principal, agent_id))
        else:
            self.grants.discard((principal, agent_id))
        return self.status(principal)

    def disconnect(self, session):
        self.record("disconnect", dict(session))
        principal = session["principal"]
        self.connected.discard(principal)
        self.grants = {grant for grant in self.grants if grant[0] != principal}
        return self.status(principal) | {"revocation": "confirmed"}

    def mind_allowed(self, agent):
        current = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent["id"],))
        return bool(current and current["owner"] == agent.get("owner") and current["owner"] in self.connected and
                    (current["owner"], current["id"]) in self.grants)

    def calendar_read(self, subject, query, agent_id=None):
        self.record("read", dict(subject) if isinstance(subject, dict) else subject, dict(query), agent_id)
        if self.on_read:
            self.on_read()
        return {"op": "calendar.read", "events": [{"title": "Synthetic busy", "start": query["time_min"],
                                                  "end": query["time_max"], "busy": True}], "truncated": False}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "GoogleConnector", SyntheticConnector)
    def fixture_git(*args):
        # The connector API fixture does not exercise the updater or launch host processes.
        assert args == ("rev-parse", "HEAD")
        return "7f4b88bb04b925ae97f804c11952f2a78496654e"
    monkeypatch.setattr(updates_module, "_git", fixture_git)
    settings = load_settings(data_dir=tmp_path, admin_password="pw", petta_path=PETTA, offline=True,
                             base_path=PREFIX, public_url="https://hive.example" + PREFIX)
    app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app, base_url="https://hive.example") as client:
        admin_token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        hive = app.state.hive
        people = {}
        for person_id, name in (("u_calendar_a", "Ana"), ("u_calendar_b", "Bo")):
            principal = "user:" + person_id
            hive.db.insert("people", {"id": person_id, "email": name.lower() + "@example.test", "name": name,
                                      "role": "member", "created_at": now(), "disabled": 0})
            token = "synthetic-session-" + person_id
            hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                        "principal": principal, "expires_at": time.time() + 900})
            people[name] = {"principal": principal, "token": token, "headers": {"Authorization": "Bearer " + token}}
        yield client, hive, hive.google_connector, people, {"Authorization": "Bearer " + admin_token}


def owned_mind(hive, principal):
    return hive.create_agent("Calendar reader", "omega", None, "mock/echo", owner=principal)


def connect(connector, person):
    connector.connected.add(person["principal"])


@pytest.mark.parametrize("method,path,payload", [
    ("GET", "/api/connectors/google", None),
    ("POST", "/api/connectors/google/start", {}),
    ("POST", "/api/connectors/google/config", {"client_id": "id", "client_secret": "secret"}),
    ("PUT", "/api/connectors/google/minds/unknown", {"allowed": True}),
    ("POST", "/api/connectors/google/disconnect", {}),
    ("POST", "/api/connectors/google/operations", QUERY),
    ("POST", "/api/agent/connectors/google/operations", QUERY),
])
def test_routes_require_their_own_authenticated_principal(env, method, path, payload):
    client, _, connector, _, _ = env
    assert client.request(method, path, json=payload).status_code == 401
    assert connector.calls == []


def test_only_admin_configures_and_private_fields_are_not_returned(env):
    client, _, connector, people, admin = env
    payload = {"client_id": "synthetic-client", "client_secret": "synthetic-private-value"}
    assert client.post("/api/connectors/google/config", json=payload, headers=people["Ana"]["headers"]).status_code == 403
    assert client.post("/api/connectors/google/config", json=payload | {"principal": "other"}, headers=admin).status_code == 400
    assert client.post("/api/connectors/google/config", json={"client_id": 1, "client_secret": "x"}, headers=admin).status_code == 400
    response = client.post("/api/connectors/google/config", json=payload, headers=admin)
    assert response.json() == {"ready": True, "backend": "B"}
    assert payload["client_secret"] not in response.text
    assert connector.calls[-1][0] == "configure"


def test_status_is_scoped_to_current_session_and_not_a_requested_person(env):
    client, _, connector, people, _ = env
    connect(connector, people["Ana"])
    ana = client.get("/api/connectors/google", headers=people["Ana"]["headers"])
    bo = client.get("/api/connectors/google", headers=people["Bo"]["headers"])
    assert ana.json()["connected"] is True and bo.json()["connected"] is False
    assert ana.headers["cache-control"] == "no-store"


def test_top_level_start_passes_trusted_session_and_uses_distinct_scoped_cookie(env):
    client, _, connector, people, _ = env
    response = client.post(PREFIX + "/api/connectors/google/start", json={}, headers=people["Ana"]["headers"])
    assert response.status_code == 200 and response.json()["authorization_url"].startswith("https://accounts.google.com/")
    call = next(call for call in connector.calls if call[0] == "start")
    assert call[2][0]["token_hash"] == token_hash(people["Ana"]["token"])
    assert call[2][0]["principal"] == people["Ana"]["principal"]
    cookie = response.headers["set-cookie"].lower()
    assert "hive_google_connector=" in cookie and "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
    assert "path=" + CALLBACK in cookie and "hive_signin=" not in cookie
    assert response.headers["cache-control"] == "no-store"
    result = client.get(CALLBACK + "?state=synthetic-state&code=synthetic-code", follow_redirects=False)
    assert result.headers["location"] == PREFIX + "/?google_connector=connected"
    assert "max-age=0" in result.headers["set-cookie"].lower()


def test_callback_rechecks_saved_session_without_authority_from_attribution(env):
    client, hive, connector, people, _ = env
    client.post(PREFIX + "/api/connectors/google/start", json={}, headers=people["Ana"]["headers"])
    hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(people["Ana"]["token"]),))
    result = client.get(CALLBACK + "?state=synthetic-state&code=synthetic-code&auth_session_ref=pretend", follow_redirects=False)
    assert result.headers["location"] == PREFIX + "/?google_connector_error=connection_failed"
    assert not connector.connected
    assert "max-age=0" in result.headers["set-cookie"].lower()


@pytest.mark.parametrize("query", ["error=private-provider-error", "state=synthetic-state", "code=secret-code", "state=bad&code=secret-code"])
def test_callback_failure_is_bounded_same_origin_and_clears_binding(env, query):
    client, _, _, _, _ = env
    result = client.get(CALLBACK + "?" + query, follow_redirects=False)
    assert result.status_code == 303
    assert result.headers["location"] in (PREFIX + "/?google_connector_error=cancelled",
                                           PREFIX + "/?google_connector_error=connection_failed")
    assert "secret-code" not in result.headers["location"] and "private-provider-error" not in result.headers["location"]
    assert "max-age=0" in result.headers["set-cookie"].lower()
    assert result.headers["cache-control"] == "no-store"


def test_consent_navigation_refuses_iframes(env):
    client, _, connector, people, _ = env
    headers = people["Ana"]["headers"] | {"Sec-Fetch-Dest": "iframe"}
    assert client.post("/api/connectors/google/start", json={}, headers=headers).status_code == 403
    result = client.get(CALLBACK + "?state=x&code=y", headers={"Sec-Fetch-Dest": "iframe"}, follow_redirects=False)
    assert result.headers["location"].endswith("google_connector_error=connection_failed")
    assert connector.calls == []


def test_start_on_root_alias_binds_cookie_to_configured_prefixed_callback(env):
    client, _, connector, people, _ = env
    ana = people["Ana"]
    started = client.post("/api/connectors/google/start", json={}, headers=ana["headers"])
    assert started.status_code == 200
    assert "Path=" + CALLBACK in started.headers["set-cookie"]
    completed = client.get(CALLBACK + "?state=synthetic-state&code=synthetic-code", follow_redirects=False)
    assert completed.status_code == 303
    assert completed.headers["location"] == PREFIX + "/?google_connector=connected"
    assert ana["principal"] in connector.connected
    assert "hive_google_connector" not in client.cookies


def test_mind_consent_is_exact_boolean_and_has_no_admin_ownership_bypass(env):
    client, hive, connector, people, admin = env
    ana, bo = people["Ana"], people["Bo"]
    mind = owned_mind(hive, ana["principal"])
    connect(connector, ana)
    path = "/api/connectors/google/minds/" + mind["id"]
    for forbidden in (bo["headers"], admin):
        assert client.put(path, json={"allowed": True}, headers=forbidden).status_code in (403, 404)
    for body in ({"allowed": 1}, {"allowed": "true"}, {"allowed": True, "principal": ana["principal"]}):
        assert client.put(path, json=body, headers=ana["headers"]).status_code == 400
    response = client.put(path, json={"allowed": True}, headers=ana["headers"])
    assert response.status_code == 200 and response.json()["allowed_minds"] == [mind["id"]]
    grant = [call for call in connector.calls if call[0] == "grant"][-1]
    assert grant[2][0]["token_hash"] == token_hash(ana["token"])
    assert client.put(path, json={"allowed": False}, headers=ana["headers"]).json()["allowed_minds"] == []


@pytest.mark.parametrize("payload", [QUERY | {"op": "calendar.write"}, QUERY | {"principal": "user:other"},
                                    QUERY | {"agent_id": "other"}, {key: value for key, value in QUERY.items() if key != "time_max"}])
@pytest.mark.parametrize("path", ["/api/connectors/google/operations", "/api/agent/connectors/google/operations"])
def test_operation_envelope_is_closed_and_read_only(env, payload, path):
    client, hive, connector, people, _ = env
    mind = owned_mind(hive, people["Ana"]["principal"])
    headers = {"Authorization": "Bearer " + mind["token"]} if "/agent/" in path else people["Ana"]["headers"]
    assert client.post(path, json=payload, headers=headers).status_code == 400
    assert not [call for call in connector.calls if call[0] == "read"]


@pytest.mark.parametrize("path", ["/api/connectors/google/operations", "/api/agent/connectors/google/operations"])
def test_operation_defaults_missing_limit_to_twenty(env, path):
    client, hive, connector, people, _ = env
    ana = people["Ana"]
    mind = owned_mind(hive, ana["principal"])
    connect(connector, ana)
    connector.grants.add((ana["principal"], mind["id"]))
    headers = {"Authorization": "Bearer " + mind["token"]} if "/agent/" in path else ana["headers"]
    response = client.post(path, json={k: v for k, v in QUERY.items() if k != "limit"}, headers=headers)
    assert response.status_code == 200
    call = next(call for call in connector.calls if call[0] == "read")
    assert call[2][1] == {"time_min": QUERY["time_min"], "time_max": QUERY["time_max"], "limit": 20}


def test_body_cap_and_empty_action_envelopes(env):
    client, _, connector, people, _ = env
    headers = people["Ana"]["headers"]
    for path in ("/api/connectors/google/start", "/api/connectors/google/disconnect"):
        assert client.post(path, json={"principal": "other"}, headers=headers).status_code == 400
    assert client.post("/api/connectors/google/operations", json=QUERY | {"large": "x" * 5000}, headers=headers).status_code == 413
    assert not [call for call in connector.calls if call[0] in ("start", "disconnect", "read")]


def test_person_read_passes_trusted_session_and_only_query_to_worker(env):
    client, _, connector, people, _ = env
    ana = people["Ana"]
    connect(connector, ana)
    response = client.post("/api/connectors/google/operations", json=QUERY, headers=ana["headers"])
    assert response.status_code == 200 and response.json()["events"][0]["title"] == "Synthetic busy"
    call = next(call for call in connector.calls if call[0] == "read")
    assert call[2][0]["token_hash"] == token_hash(ana["token"])
    assert call[2][0]["principal"] == ana["principal"]
    assert call[2][1:] == ({k: v for k, v in QUERY.items() if k != "op"}, None)
    assert response.headers["cache-control"] == "no-store"
    assert call[1] != threading.get_ident()


def test_person_result_is_withheld_if_saved_session_ends_during_read(env):
    client, hive, connector, people, _ = env
    ana = people["Ana"]
    connect(connector, ana)
    connector.on_read = lambda: hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(ana["token"]),))
    response = client.post("/api/connectors/google/operations", json=QUERY, headers=ana["headers"])
    assert response.status_code == 401 and "Synthetic busy" not in response.text


def test_disconnect_passes_only_current_session_and_preserves_other_person(env):
    client, _, connector, people, _ = env
    for person in people.values():
        connect(connector, person)
    response = client.post("/api/connectors/google/disconnect", json={}, headers=people["Ana"]["headers"])
    assert response.json()["connected"] is False and response.json()["revocation"] == "confirmed"
    assert connector.connected == {people["Bo"]["principal"]}
    call = next(call for call in connector.calls if call[0] == "disconnect")
    assert call[2][0]["token_hash"] == token_hash(people["Ana"]["token"])


@pytest.mark.parametrize("restriction", ["deny", "ask"])
def test_agent_execution_requires_consent_and_policy_allow_then_uses_live_owner(env, restriction):
    client, hive, connector, people, _ = env
    ana = people["Ana"]
    mind = owned_mind(hive, ana["principal"])
    headers = {"Authorization": "Bearer " + mind["token"]}
    path = "/api/agent/connectors/google/operations"
    hive.policy.add_rule("agent:" + mind["id"], "calendar-read", "allow")
    assert client.post(path, json=QUERY, headers=headers).status_code == 403
    connect(connector, ana)
    connector.grants.add((ana["principal"], mind["id"]))
    assert client.post(path, json=QUERY, headers=headers).status_code == 200
    call = [call for call in connector.calls if call[0] == "read"][-1]
    assert call[2] == (ana["principal"], {k: v for k, v in QUERY.items() if k != "op"}, mind["id"])
    hive.policy.add_rule("agent:" + mind["id"], "calendar-read", restriction)
    before = len([call for call in connector.calls if call[0] == "read"])
    assert client.post(path, json=QUERY, headers=headers).status_code == 403
    assert len([call for call in connector.calls if call[0] == "read"]) == before


@pytest.mark.parametrize("change", ["revoke", "owner", "owner_with_consent", "policy", "delete"])
def test_agent_result_is_withheld_after_consent_ownership_or_policy_change(env, change):
    client, hive, connector, people, _ = env
    ana = people["Ana"]
    mind = owned_mind(hive, ana["principal"])
    connect(connector, ana)
    connector.grants.add((ana["principal"], mind["id"]))

    def update():
        if change == "revoke":
            connector.grants.clear()
        elif change in ("owner", "owner_with_consent"):
            hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (people["Bo"]["principal"], mind["id"]))
            if change == "owner_with_consent":
                connect(connector, people["Bo"])
                connector.grants.add((people["Bo"]["principal"], mind["id"]))
        elif change == "policy":
            hive.policy.add_rule("agent:" + mind["id"], "calendar-read", "deny")
        else:
            hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (mind["id"],))

    connector.on_read = update
    response = client.post("/api/agent/connectors/google/operations", json=QUERY,
                           headers={"Authorization": "Bearer " + mind["token"]})
    assert response.status_code in (401, 403) and "Synthetic busy" not in response.text
