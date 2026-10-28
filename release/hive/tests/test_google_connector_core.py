"""Synthetic OAuth/Calendar checks. No Hive app, native engine or network required.

Authored for Root's separately admitted runtime validation; author did not run
these tests or import application source while implementing this source lane.
"""

import base64
import contextlib
import hashlib
import importlib.metadata
import io
import json
import logging
import os
import sqlite3
import stat
import sys
import threading
import time
import urllib.parse
from types import ModuleType, SimpleNamespace

import pytest

from hive.core import google_connector as module
from hive.core import google_backend as backend_module
from hive.core.google_backend import CALENDAR_SCOPE, CalendarPage, GoogleLibraryBackend, GoogleMCPBackend, _quiet_libraries
from hive.core.google_connector import GoogleConnector, GoogleConnectorError


class MemoryDB:
    """Only a fresh, synthetic in-memory database; no account files are opened."""

    def __init__(self):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(":memory:", isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE people (id TEXT PRIMARY KEY, disabled INTEGER, role TEXT);
            CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at TEXT, kind TEXT,
                                   principal TEXT, expires_at REAL, signin_hash TEXT);
            CREATE TABLE signins (token_hash TEXT PRIMARY KEY, person_id TEXT, expires_at REAL);
            CREATE TABLE agents (id TEXT PRIMARY KEY, owner TEXT, deleted INTEGER);
        """)

    def execute(self, sql, params=()):
        with self._lock:
            return self.conn.execute(sql, params)

    def one(self, sql, params=()):
        with self._lock:
            row = self.conn.execute(sql, params).fetchone()
            return dict(row) if row is not None else None

    @contextlib.contextmanager
    def transaction(self):
        # Reentrant to model the host's nested transactions and synchronous hooks.
        with self._lock:
            yield self


class FakeBackend:
    name = "B"
    available = True

    def __init__(self):
        self.exchanges = 0
        self.verifiers = []
        self.pages = []
        self.page_calls = []
        self.revoked = []
        self.on_exchange = None
        self.on_page = None
        self.on_revoke = None
        self.exchange_error = None
        self.page_error = None
        self.revoke_error = None
        self.token = "synthetic-refresh-token-1234567890"
        self.scopes = [CALENDAR_SCOPE]
        self.revocation_confirmed = True
        self.rotation_tokens = []
        self.current_refresh_token = self.token
        self.refresh_inputs = []
        self.page_failed = False

    def authorization_url(self, client, redirect_uri, state, verifier):
        self.verifiers.append(verifier)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
            "client_id": client["client_id"], "redirect_uri": redirect_uri, "state": state,
            "response_type": "code", "scope": CALENDAR_SCOPE, "code_challenge": challenge,
            "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent",
        })

    def exchange(self, client, redirect_uri, state, code, verifier):
        self.exchanges += 1
        assert verifier == self.verifiers[-1]
        if self.on_exchange:
            self.on_exchange()
        if self.exchange_error:
            raise self.exchange_error
        return {"refresh_token": self.token, "scopes": self.scopes,
                "access_token": "synthetic-access-token-must-not-persist"}

    def calendar_page(self, client, refresh_token, time_min, time_max, page_token, page_size):
        assert refresh_token == self.current_refresh_token
        self.refresh_inputs.append(refresh_token)
        self.page_calls.append({"time_min": time_min, "time_max": time_max,
                                "page_token": page_token, "page_size": page_size})
        if self.on_page:
            self.on_page()
        if self.page_error:
            raise self.page_error
        rotated = self.rotation_tokens.pop(0) if self.rotation_tokens else refresh_token
        self.current_refresh_token = rotated
        return CalendarPage(self.pages.pop(0) if self.pages else {"items": []}, rotated, self.page_failed)

    def revoke(self, token):
        self.revoked.append(token)
        if self.on_revoke:
            self.on_revoke()
        if self.revoke_error:
            raise self.revoke_error
        return self.revocation_confirmed


def seed_person(db, person_id="one", *, role="member", signin=True):
    db.execute("INSERT INTO people VALUES (?, 0, ?)", (person_id, role))
    session = {"token_hash": "session-" + person_id, "created_at": "2026-10-26T12:00:00Z", "kind": "sso",
               "principal": "user:" + person_id, "expires_at": time.time() + 3600,
               "signin_hash": "signin-" + person_id if signin else None}
    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", tuple(session.values()))
    if signin:
        db.execute("INSERT INTO signins VALUES (?, ?, ?)", (session["signin_hash"], person_id, session["expires_at"]))
    return session


@pytest.fixture
def env(tmp_path):
    db, backend = MemoryDB(), FakeBackend()
    session = seed_person(db)
    other = seed_person(db, "two", role="admin")
    db.execute("INSERT INTO agents VALUES ('a_one', 'user:one', 0)")
    db.execute("INSERT INTO agents VALUES ('a_other', 'user:two', 0)")
    settings = SimpleNamespace(data_dir=tmp_path, public_url="https://hive.example/base")
    connector = GoogleConnector(SimpleNamespace(db=db), settings, backend)
    connector.configure_client("synthetic-client", "synthetic-client-secret-1234567890")
    yield SimpleNamespace(connector=connector, backend=backend, db=db, settings=settings,
                          session=session, other=other, nonce="browser-binding-" + "x" * 32)
    db.conn.close()


def begin(env):
    result = env.connector.start(env.session, env.nonce)
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(result["authorization_url"]).query)["state"][0]
    return state, result


def connect(env):
    state, _ = begin(env)
    return env.connector.complete(state, "synthetic-code", env.nonce)


def query(**overrides):
    return {"time_min": "2026-10-26T00:00:00Z", "time_max": "2026-10-27T00:00:00+00:00"} | overrides


def event(**overrides):
    return {"summary": "Private appointment", "start": {"dateTime": "2026-10-26T12:00:00Z"},
            "end": {"dateTime": "2026-10-26T13:00:00Z"}, "transparency": "opaque"} | overrides


def error_code(expected, call):
    with pytest.raises(GoogleConnectorError) as caught:
        call()
    assert caught.value.code == expected
    return caught.value


def test_constructor_without_google_dependencies_is_unconfigured_and_offline(tmp_path, monkeypatch):
    def absent(package):
        raise importlib.metadata.PackageNotFoundError(package)
    monkeypatch.setattr(importlib.metadata, "version", absent)
    db = MemoryDB()
    session = seed_person(db)
    connector = GoogleConnector(SimpleNamespace(db=db), SimpleNamespace(data_dir=tmp_path, public_url="http://127.0.0.1:8700"))
    assert connector.status(session) == {"ready": False, "connected": False, "backend": "B",
                                         "allowed_minds": [], "calendar_scope": CALENDAR_SCOPE}
    assert not (tmp_path / "google-connector").exists()
    assert GoogleLibraryBackend().available is False
    db.conn.close()


def test_backend_a_is_unavailable_without_fallback_or_provider_call(env):
    connector = GoogleConnector(SimpleNamespace(db=env.db), env.settings, GoogleMCPBackend())
    assert not connector.status(env.session)["ready"]
    error_code("connector_unavailable", lambda: connector.start(env.session, env.nonce))


def test_status_does_not_inherit_person_grant_for_admin_operator_or_other_person(env):
    connect(env)
    for principal in (env.other, "user:operator", "role:admin"):
        status = env.connector.status(principal)
        assert not status["connected"] and status["allowed_minds"] == []
        assert set(status) == {"ready", "connected", "backend", "allowed_minds", "calendar_scope"}


def test_pkce_state_browser_session_person_and_fixed_callback(env):
    state, result = begin(env)
    args = urllib.parse.parse_qs(urllib.parse.urlsplit(result["authorization_url"]).query)
    assert args["redirect_uri"] == ["https://hive.example/base/api/connectors/google/callback"]
    assert args["code_challenge_method"] == ["S256"]
    assert args["scope"] == [CALENDAR_SCOPE]
    assert args["code_challenge"] != [env.backend.verifiers[-1]]
    assert result["expires_at"] <= time.time() + 600
    assert "verifier" not in result and state not in env.connector._pending
    assert env.connector.complete(state, "code", env.nonce)["connected"]
    assert env.backend.exchanges == 1
    error_code("invalid_state", lambda: env.connector.complete(state, "code", env.nonce))
    assert env.backend.exchanges == 1


def test_wrong_browser_consumes_state_before_exchange(env):
    state, _ = begin(env)
    error_code("invalid_state", lambda: env.connector.complete(state, "code", "other-browser"))
    error_code("invalid_state", lambda: env.connector.complete(state, "code", env.nonce))
    assert env.backend.exchanges == 0


def test_new_start_supersedes_old_state_and_never_persists_verifiers(env):
    old, _ = begin(env)
    current, _ = begin(env)
    assert current != old
    error_code("invalid_state", lambda: env.connector.complete(old, "code", env.nonce))
    body = env.connector._path.read_text()
    assert all(verifier not in body for verifier in env.backend.verifiers)
    assert env.connector.complete(current, "code", env.nonce)["connected"]


def test_expired_state_refused_without_exchange(env, monkeypatch):
    state, result = begin(env)
    monkeypatch.setattr(module.time, "time", lambda: result["expires_at"] + 1)
    error_code("invalid_state", lambda: env.connector.complete(state, "code", env.nonce))
    assert env.backend.exchanges == 0


@pytest.mark.parametrize("sql", [
    "DELETE FROM sessions WHERE principal = 'user:one'",
    "UPDATE sessions SET expires_at = 1 WHERE principal = 'user:one'",
    "UPDATE sessions SET principal = 'user:two' WHERE principal = 'user:one'",
    "UPDATE people SET disabled = 1 WHERE id = 'one'",
    "DELETE FROM signins WHERE person_id = 'one'",
    "UPDATE signins SET expires_at = 1 WHERE person_id = 'one'",
    "UPDATE signins SET person_id = 'two' WHERE person_id = 'one'",
])
def test_original_session_person_and_signin_rechecked_before_exchange(env, sql):
    state, _ = begin(env)
    env.db.execute(sql)
    with pytest.raises(GoogleConnectorError):
        env.connector.complete(state, "code", env.nonce)
    assert env.backend.exchanges == 0
    assert not env.connector.status("user:one")["connected"]


@pytest.mark.parametrize("sql", [
    "DELETE FROM sessions WHERE principal = 'user:one'",
    "UPDATE people SET disabled = 1 WHERE id = 'one'",
    "DELETE FROM signins WHERE person_id = 'one'",
])
def test_session_fence_after_exchange_rejects_commit_and_revokes_new_token(env, sql):
    state, _ = begin(env)
    env.backend.on_exchange = lambda: env.db.execute(sql)
    with pytest.raises(GoogleConnectorError):
        env.connector.complete(state, "code", env.nonce)
    assert env.backend.revoked == [env.backend.token]
    assert not env.connector._data["people"]
    assert env.backend.token not in env.connector._path.read_text()


def test_disconnect_during_exchange_prevents_late_token_resurrection(env):
    state, _ = begin(env)
    env.backend.on_exchange = lambda: env.connector.disconnect(env.session)
    error_code("connection_changed", lambda: env.connector.complete(state, "code", env.nonce))
    assert not env.connector.status(env.session)["connected"]
    assert env.backend.revoked == [env.backend.token]


def test_refresh_only_private_atomic_store_reloads_and_does_not_touch_signin(env):
    before = env.db.one("SELECT * FROM signins WHERE person_id = 'one'")
    connect(env)
    path = env.connector._path
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    body = path.read_text()
    assert env.backend.token in body
    assert "synthetic-access-token-must-not-persist" not in body
    assert all(v not in body for v in env.backend.verifiers)
    assert "id_token" not in body and "access_token" not in body and "verifier" not in body
    assert env.db.one("SELECT * FROM signins WHERE person_id = 'one'") == before
    reloaded = GoogleConnector(SimpleNamespace(db=env.db), env.settings, env.backend)
    assert reloaded.status(env.session)["connected"]
    assert reloaded._data["people"]["user:one"]["owner"] == "user:one"
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.parametrize("scopes", [[CALENDAR_SCOPE, "https://www.googleapis.com/auth/calendar"], [], ["openid"]])
def test_wider_or_wrong_scopes_refused_and_new_token_revoked(env, scopes):
    env.backend.scopes = scopes
    state, _ = begin(env)
    error_code("scope_refused", lambda: env.connector.complete(state, "code", env.nonce))
    assert env.backend.revoked == [env.backend.token]
    assert env.backend.token not in env.connector._path.read_text()


def test_no_refresh_token_does_not_claim_connected(env):
    env.backend.token = None
    state, _ = begin(env)
    error_code("google_unavailable", lambda: env.connector.complete(state, "code", env.nonce))
    assert not env.connector.status(env.session)["connected"]


def test_dangerous_client_change_refused_until_accounts_disconnected(env):
    connect(env)
    error_code("client_in_use", lambda: env.connector.configure_client("other", "another-secret"))
    assert env.connector.configure_client("synthetic-client", "synthetic-client-secret-1234567890")["ready"]
    env.connector.disconnect(env.session)
    assert env.connector.configure_client("other", "another-secret")["ready"]


@pytest.mark.parametrize("principal,agent_id", [("user:two", "a_one"), ("user:one", "a_other"), ("user:one", "a_missing")])
def test_consent_has_no_admin_hive_owner_generic_policy_or_foreign_mind_bypass(env, principal, agent_id):
    connect(env)
    error_code("mind_consent_required", lambda: env.connector.grant_mind(principal, agent_id, True))
    assert not env.connector.mind_allowed({"id": agent_id, "owner": "user:one"})


def test_exact_mind_consent_toggles_and_current_owner_is_authoritative(env):
    connect(env)
    assert not env.connector.mind_allowed({"id": "a_one", "owner": "user:one"})
    assert env.connector.grant_mind(env.session, "a_one", True)["allowed_minds"] == ["a_one"]
    assert env.connector.mind_allowed({"id": "a_one", "owner": "forged"})
    env.db.execute("UPDATE agents SET owner = 'user:two' WHERE id = 'a_one'")
    assert not env.connector.mind_allowed({"id": "a_one", "owner": "user:one"})
    assert env.connector.status(env.session)["allowed_minds"] == []


def test_deleted_mind_and_nonboolean_consent_are_refused(env):
    connect(env)
    error_code("invalid_consent", lambda: env.connector.grant_mind(env.session, "a_one", 1))
    env.db.execute("UPDATE agents SET deleted = 1 WHERE id = 'a_one'")
    error_code("mind_consent_required", lambda: env.connector.grant_mind(env.session, "a_one", True))


def test_minimal_calendar_projection_and_truthful_pagination(env):
    connect(env)
    env.backend.pages = [
        {"items": [event(summary="x" * 240, description="SECRET_DESCRIPTION", attendees=[{"email": "secret@example.test"}])],
         "nextPageToken": "page-two"},
        {"items": [event(summary="Day off", start={"date": "2026-10-26"}, end={"date": "2026-10-27"},
                          transparency="transparent")]},
    ]
    result = env.connector.calendar_read(env.session, query(op="calendar.read"))
    assert result == {"op": "calendar.read", "events": [
        {"title": "x" * 200, "start": "2026-10-26T12:00:00Z", "end": "2026-10-26T13:00:00Z", "busy": True},
        {"title": "Day off", "start": "2026-10-26", "end": "2026-10-27", "busy": False},
    ], "truncated": True}
    assert len(env.backend.page_calls) == 2
    assert env.backend.page_calls[0]["page_size"] == 20
    assert env.backend.page_calls[1]["page_token"] == "page-two"
    assert "SECRET_DESCRIPTION" not in json.dumps(result) and "secret@example.test" not in json.dumps(result)


def test_agent_read_requires_exact_consent_in_execution_even_after_preflight(env):
    connect(env)
    error_code("mind_consent_required", lambda: env.connector.calendar_read("user:one", query(), agent_id="a_one"))
    assert not env.backend.page_calls
    env.connector.grant_mind(env.session, "a_one", True)
    env.backend.pages = [{"items": [event()]}]
    assert env.connector.calendar_read("user:one", query(), agent_id="a_one")["events"]


@pytest.mark.parametrize("mutation", ["move", "delete", "disable", "ungrant", "disconnect", "regrant"])
def test_inflight_agent_result_refused_after_ownership_or_consent_epoch_changes(env, mutation):
    connect(env)
    env.connector.grant_mind(env.session, "a_one", True)
    env.backend.pages = [{"items": [event(description="private")], "nextPageToken": "do-not-fetch"}]
    def mutate():
        if mutation == "move":
            env.db.execute("UPDATE agents SET owner = 'user:two' WHERE id = 'a_one'")
        elif mutation == "delete":
            env.db.execute("UPDATE agents SET deleted = 1 WHERE id = 'a_one'")
        elif mutation == "disable":
            env.db.execute("UPDATE people SET disabled = 1 WHERE id = 'one'")
        elif mutation == "ungrant":
            env.connector.grant_mind(env.session, "a_one", False)
        elif mutation == "disconnect":
            env.connector.disconnect(env.session)
        else:
            env.connector.grant_mind(env.session, "a_one", False)
            env.connector.grant_mind(env.session, "a_one", True)
    env.backend.on_page = mutate
    with pytest.raises(GoogleConnectorError) as caught:
        env.connector.calendar_read("user:one", query(), agent_id="a_one")
    assert caught.value.status in {401, 403, 409}
    assert len(env.backend.page_calls) == 1
    assert "private" not in str(caught.value)


def test_human_read_rechecks_original_session_after_io(env):
    connect(env)
    env.backend.pages = [{"items": [event()]}]
    env.backend.on_page = lambda: env.db.execute("DELETE FROM sessions WHERE token_hash = ?", (env.session["token_hash"],))
    error_code("session_changed", lambda: env.connector.calendar_read(env.session, query()))
    error_code("session_required", lambda: env.connector.calendar_read("user:one", query()))


@pytest.mark.parametrize("changes", [
    {"op": "calendar.write"}, {"limit": True}, {"limit": 0}, {"limit": 101}, {"limit": "10"},
    {"limit": 1.5}, {"calendar_id": "foreign"}, {"time_min": "2026-10-26T00:00:00"},
    {"time_min": "2026-10-26"}, {"time_max": "2026-10-26T00:00:00Z"},
    {"time_max": "2026-11-27T00:00:00Z"}, {"time_min": "2026-99-26T00:00:00Z"},
])
def test_invalid_or_unbounded_calendar_query_refused_before_io(env, changes):
    connect(env)
    with pytest.raises(GoogleConnectorError) as caught:
        env.connector.calendar_read(env.session, query(**changes))
    assert caught.value.status == 400
    assert not env.backend.page_calls


def test_exact_31_day_interval_and_explicit_timezone_offset_accepted(env):
    connect(env)
    result = env.connector.calendar_read(env.session, query(time_min="2026-10-26T01:00:00+01:00",
                                                           time_max="2026-11-26T00:00:00Z", limit=100))
    assert result["events"] == [] and not result["truncated"]
    assert env.backend.page_calls[0]["page_size"] == 50


def test_item_limit_stops_pagination_and_marks_truncation(env):
    connect(env)
    env.backend.pages = [{"items": [event(), event()], "nextPageToken": "more"}]
    result = env.connector.calendar_read(env.session, query(limit=2))
    assert len(result["events"]) == 2 and result["truncated"]
    assert len(env.backend.page_calls) == 1


def test_last_page_clipped_title_is_marked_truncated_without_next_page(env):
    connect(env)
    env.backend.pages = [{"items": [event(summary="z" * 201)]}]
    result = env.connector.calendar_read(env.session, query())
    assert result["events"][0]["title"] == "z" * 200
    assert result["truncated"] is True
    assert len(env.backend.page_calls) == 1


def test_page_limit_is_total_not_per_page_and_marks_truncation(env):
    connect(env)
    env.backend.pages = [{"items": [], "nextPageToken": "page-" + str(i)} for i in range(8)]
    result = env.connector.calendar_read(env.session, query(limit=100))
    assert len(env.backend.page_calls) == 4
    assert result["events"] == [] and result["truncated"]


@pytest.mark.parametrize("pages", [
    [{"items": [event(), event()]}],
    [{"items": "bad-personal-body"}],
    [{"items": [{"description": "private-body-with-no-time"}]}],
    [{"items": [], "nextPageToken": "same"}, {"items": [], "nextPageToken": "same"}],
])
def test_malformed_or_overlarge_provider_pages_fail_with_constant_safe_error(env, pages):
    connect(env)
    env.backend.pages = pages
    caught = error_code("google_unavailable", lambda: env.connector.calendar_read(env.session, query(limit=1)))
    assert caught.status == 502
    assert caught.message == "Google could not complete this request."
    assert env.backend.token not in str(caught) and "personal" not in str(caught)


def test_provider_exceptions_never_expose_bodies_tokens_or_verifiers(env):
    state, _ = begin(env)
    env.backend.exchange_error = RuntimeError("private response " + env.backend.token + env.backend.verifiers[-1])
    caught = error_code("google_unavailable", lambda: env.connector.complete(state, "code", env.nonce))
    assert caught.message == "Google could not complete this request."
    assert caught.__suppress_context__
    env.backend.exchange_error = None
    connect(env)
    env.backend.page_error = RuntimeError("private event body " + env.backend.token)
    caught = error_code("google_unavailable", lambda: env.connector.calendar_read(env.session, query()))
    assert caught.message == "Google could not complete this request." and caught.__suppress_context__


@pytest.mark.parametrize("failure", [False, True])
def test_disconnect_removes_local_token_and_consent_before_provider_revocation(env, failure):
    connect(env)
    env.connector.grant_mind(env.session, "a_one", True)
    def already_removed():
        assert env.backend.token not in env.connector._path.read_text()
        assert not env.connector.status(env.session)["connected"]
        assert not env.connector.mind_allowed({"id": "a_one"})
    env.backend.on_revoke = already_removed
    if failure:
        env.backend.revoke_error = TimeoutError("secret network diagnostic")
    result = env.connector.disconnect(env.session)
    assert not result["connected"] and result["allowed_minds"] == []
    assert result["revocation"] == ("unconfirmed" if failure else "confirmed")
    assert env.backend.revoked == [env.backend.token]
    assert env.backend.token not in env.connector._path.read_text()
    reloaded = GoogleConnector(SimpleNamespace(db=env.db), env.settings, env.backend)
    assert not reloaded.status(env.session)["connected"]
    assert reloaded._data["people"]["user:one"]["revocation"] == result["revocation"]


def test_disconnect_pending_state_and_empty_disconnect_are_honest(env):
    state, _ = begin(env)
    assert env.connector.disconnect(env.session)["revocation"] == "not_needed"
    error_code("invalid_state", lambda: env.connector.complete(state, "code", env.nonce))
    assert not env.backend.revoked


def test_disconnect_finishes_removal_but_rechecks_session_before_returning_after_io(env):
    connect(env)
    env.backend.on_revoke = lambda: env.db.execute("DELETE FROM sessions WHERE token_hash = ?", (env.session["token_hash"],))
    error_code("session_changed", lambda: env.connector.disconnect(env.session))
    assert env.backend.token not in env.connector._path.read_text()
    assert env.connector._data["people"]["user:one"]["revocation"] == "confirmed"


def test_atomic_write_failure_keeps_prior_bytes_and_fails_closed(env, monkeypatch):
    connect(env)
    before = env.connector._path.read_bytes()
    def fail_replace(source, destination):
        raise OSError("synthetic-disk-error")
    monkeypatch.setattr(module.os, "replace", fail_replace)
    error_code("connector_storage", lambda: env.connector.disconnect(env.session))
    assert env.connector._path.read_bytes() == before
    assert not env.connector.status(env.session)["connected"]
    assert env.backend.revoked == [env.backend.token]
    assert not list(env.connector._directory.glob("*.tmp"))


def test_store_rejects_public_mode_or_symlink_instead_of_loading_tokens(env, tmp_path):
    connect(env)
    os.chmod(env.connector._path, 0o644)
    error_code("connector_storage", lambda: GoogleConnector(SimpleNamespace(db=env.db), env.settings, env.backend))
    os.chmod(env.connector._path, 0o600)
    target = tmp_path / "fixture-only.json"
    env.connector._path.rename(target)
    env.connector._path.symlink_to(target)
    error_code("connector_storage", lambda: GoogleConnector(SimpleNamespace(db=env.db), env.settings, env.backend))


@pytest.mark.parametrize("url", ["https://evil.example/?redirect=x", "http://hive.local:8700", "http://testserver",
                                  "https://u:p@hive.example", "https://hive.example/#fragment", "//hive.example",
                                  "file:///tmp/test", "http://[", "https://hive.example:bad", "https://hive.example/\n"])
def test_unconfigured_optional_connector_allows_startup_but_refuses_oauth_on_unsafe_origins(tmp_path, url):
    db = MemoryDB()
    session = seed_person(db)
    connector = GoogleConnector(SimpleNamespace(db=db), SimpleNamespace(data_dir=tmp_path, public_url=url), FakeBackend())
    assert not connector.status(session)["ready"] and connector.redirect_uri is None
    error_code("invalid_public_url", lambda: connector.configure_client("client", "secret"))
    error_code("invalid_public_url", lambda: connector.start(session, "x" * 32))
    assert not (tmp_path / "google-connector").exists()
    db.conn.close()


def test_backend_must_return_pinned_google_authorization_url_and_s256(env):
    env.backend.authorization_url = lambda *args: "https://evil.example/?token=secret"
    error_code("google_unavailable", lambda: env.connector.start(env.session, env.nonce))
    assert not env.connector._pending and not env.backend.exchanges


def test_existing_debug_oauth_handlers_and_children_cannot_log_provider_secrets():
    prefixes = ("oauthlib", "requests_oauthlib", "google.auth", "google.oauth2", "googleapiclient",
                "google_auth_oauthlib", "google_auth_httplib2")
    parent = logging.getLogger("oauthlib")
    child = logging.getLogger("requests_oauthlib.synthetic.oauth2_session")
    hive = logging.getLogger("hive.synthetic.google-log-test")
    names = set(prefixes) | {name for name in list(logging.root.manager.loggerDict)
                             if any(name.startswith(prefix + ".") for prefix in prefixes)} | {hive.name}
    saved = {name: (list(logging.getLogger(name).handlers), logging.getLogger(name).propagate,
                    logging.getLogger(name).disabled, logging.getLogger(name).level) for name in names}
    secret_output, hive_output = io.StringIO(), io.StringIO()
    try:
        for logger in (parent, child):
            logger.disabled = False
            logger.setLevel(logging.DEBUG)
            logger.addHandler(logging.StreamHandler(secret_output))
            logger.propagate = True
        hive.disabled = False
        hive.setLevel(logging.DEBUG)
        hive.handlers = [logging.StreamHandler(hive_output)]
        hive.propagate = False
        _quiet_libraries()
        parent.debug("refresh_token=synthetic-secret")
        child.debug("code_verifier=synthetic-verifier")
        # A child created later also meets the already-silent ancestor sink.
        later = logging.getLogger("oauthlib.synthetic.created_after_suppression")
        later.setLevel(logging.DEBUG)
        later.debug("personal event body")
        hive.debug("unrelated hive diagnostics still work")
        assert secret_output.getvalue() == ""
        assert hive_output.getvalue() == "unrelated hive diagnostics still work\n"
    finally:
        for name, (handlers, propagate, disabled, level) in saved.items():
            logger = logging.getLogger(name)
            logger.handlers, logger.propagate, logger.disabled = handlers, propagate, disabled
            logger.setLevel(level)


def install_fake_module(monkeypatch, name, **attributes):
    """Synthetic modules only: exercise the backend seam without installed SDKs."""
    parts = name.split(".")
    for count in range(1, len(parts) + 1):
        dotted = ".".join(parts[:count])
        fake = ModuleType(dotted)
        fake.__path__ = []
        if count == len(parts):
            fake.__dict__.update(attributes)
        if count == len(parts) or dotted not in sys.modules:
            monkeypatch.setitem(sys.modules, dotted, fake)


def test_official_library_flow_uses_web_callback_pkce_timeout_and_refresh_only(monkeypatch):
    calls = []
    flows = []
    class Flow:
        @staticmethod
        def from_client_config(config, **kwargs):
            calls.append((config, kwargs))
            class BoundFlow:
                credentials = SimpleNamespace(refresh_token="only-refresh")
                oauth2session = SimpleNamespace(token={"scope": [CALENDAR_SCOPE], "access_token": "never-return"})
                def authorization_url(self, **options):
                    calls.append(options)
                    return "synthetic-url", options["state"]
                def fetch_token(self, **options):
                    calls.append(options)
            flow = BoundFlow()
            flows.append(flow)
            return flow
    install_fake_module(monkeypatch, "google_auth_oauthlib.flow", Flow=Flow)
    client = {"client_id": "client", "client_secret": "private-client-secret"}
    backend = GoogleLibraryBackend()
    assert backend.authorization_url(client, "https://hive.example/api/connectors/google/callback", "state", "verifier") == "synthetic-url"
    config, kwargs = calls[0]
    assert config["web"]["auth_uri"] == "https://accounts.google.com/o/oauth2/v2/auth"
    assert config["web"]["token_uri"] == "https://oauth2.googleapis.com/token"
    assert kwargs["code_verifier"] == "verifier" and kwargs["autogenerate_code_verifier"] is False
    assert kwargs["scopes"] == (CALENDAR_SCOPE,)
    assert kwargs["redirect_uri"] == "https://hive.example/api/connectors/google/callback"
    assert calls[1] == {"state": "state", "access_type": "offline", "prompt": "consent", "include_granted_scopes": "false"}
    assert backend.exchange(client, kwargs["redirect_uri"], "state", "code", "verifier") == {
        "refresh_token": "only-refresh", "scopes": [CALENDAR_SCOPE]}
    assert calls[-1] == {"code": "code", "timeout": 10.0}
    assert all(flow.oauth2session.max_redirects == 0 for flow in flows)


@pytest.mark.parametrize("failure", [None, "build", "execute", "service_close", "session_close"])
def test_official_calendar_glue_uses_transient_credentials_static_discovery_and_finite_io(monkeypatch, failure):
    seen = {}
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args):
            seen["session_closed"] = True
            if failure == "session_close": raise RuntimeError("private session cleanup diagnostic")
        def mount(self, prefix, adapter): seen["adapter"] = (prefix, adapter)
    class Request:
        def __init__(self, session): seen["request_session"] = session
        def __call__(self, url, **kwargs): seen["refresh_request"] = (url, kwargs)
    class Credentials:
        granted_scopes = None
        def __init__(self, **kwargs):
            seen["credentials"] = kwargs
            self.refresh_token = kwargs["refresh_token"]
        def refresh(self, request):
            request("https://oauth2.googleapis.com/token", timeout=999999)
            self.refresh_token = "rotated-refresh"
    class Http:
        def __init__(self, **kwargs): seen["http"] = kwargs
        def close(self): seen["http_closed"] = True
    class AuthorizedHttp:
        def __init__(self, credentials, **kwargs): seen["authorized_http"] = kwargs
        def close(self): seen["authorized_http_closed"] = True
    class Service:
        def events(self): return self
        def list(self, **kwargs): seen["list"] = kwargs; return self
        def execute(self, **kwargs):
            seen["execute"] = kwargs
            if failure == "execute": raise RuntimeError("private execute diagnostic")
            return {"items": []}
        def close(self):
            seen["service_closed"] = True
            if failure == "service_close": raise RuntimeError("private cleanup diagnostic")
    def build(*args, **kwargs):
        seen["build"] = (args, kwargs)
        if failure == "build": raise RuntimeError("private build diagnostic")
        return Service()
    install_fake_module(monkeypatch, "httplib2", Http=Http)
    install_fake_module(monkeypatch, "requests", Session=Session,
                        adapters=SimpleNamespace(HTTPAdapter=lambda **kwargs: kwargs))
    install_fake_module(monkeypatch, "google.auth.transport.requests", Request=Request)
    install_fake_module(monkeypatch, "google.oauth2.credentials", Credentials=Credentials)
    install_fake_module(monkeypatch, "google_auth_httplib2", AuthorizedHttp=AuthorizedHttp)
    install_fake_module(monkeypatch, "googleapiclient.discovery", build=build)
    result = GoogleLibraryBackend().calendar_page({"client_id": "client", "client_secret": "private"},
                                                 "refresh", "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", "page", 20)
    assert isinstance(result, CalendarPage) and result.refresh_token == "rotated-refresh"
    assert result.failed is (failure is not None)
    assert result.page == ({} if failure else {"items": []})
    assert seen["credentials"]["token"] is None and seen["credentials"]["refresh_token"] == "refresh"
    assert seen["adapter"] == ("https://", {"max_retries": 0})
    assert seen["refresh_request"][1]["timeout"] == 10.0
    assert seen["request_session"].max_redirects == 0
    assert seen["http"] == {"timeout": 10.0}
    assert seen["authorized_http"]["max_refresh_attempts"] == 0
    assert seen["build"][0] == ("calendar", "v3")
    assert seen["build"][1]["static_discovery"] is True
    assert seen["build"][1]["cache_discovery"] is False
    if failure != "build":
        assert seen["list"]["calendarId"] == "primary" and seen["list"]["maxResults"] == 20
        assert seen["list"]["pageToken"] == "page" and seen["list"]["singleEvents"] is True
        assert "description" not in seen["list"]["fields"] and "attendees" not in seen["list"]["fields"]
        assert seen["execute"] == {"num_retries": 0} and seen["service_closed"]
    assert seen["session_closed"]


def test_revoke_has_fixed_endpoint_form_body_no_redirects_and_finite_timeout(monkeypatch):
    seen = {}
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Opener:
        def open(self, request, **kwargs):
            seen["request"], seen["options"] = request, kwargs
            return Response()
    def opener(handler):
        seen["handler"] = handler
        return Opener()
    monkeypatch.setattr(backend_module.urllib.request, "build_opener", opener)
    assert GoogleLibraryBackend().revoke("synthetic-refresh") is True
    request = seen["request"]
    assert request.full_url == "https://oauth2.googleapis.com/revoke"
    assert request.get_method() == "POST" and "synthetic-refresh" not in request.full_url
    assert urllib.parse.parse_qs(request.data.decode()) == {"token": ["synthetic-refresh"]}
    assert seen["options"] == {"timeout": 10.0}
    assert seen["handler"].redirect_request(None, None, 302, "redirect", {}, "https://evil.example") is None


def test_typed_calendar_metadata_does_not_expose_tokens_or_personal_page_in_repr():
    response = CalendarPage({"description": "private-event-body"}, "private-refresh-token", True)
    assert repr(response) == "CalendarPage(failed=True)"


def test_rotation_is_atomic_preserves_exact_consent_epoch_and_feeds_next_page(env):
    connect(env)
    env.connector.grant_mind(env.session, "a_one", True)
    before = env.connector._data["people"]["user:one"].copy()
    env.backend.rotation_tokens = ["first-rotated-refresh-token", "second-rotated-refresh-token"]
    env.backend.pages = [{"items": [event()], "nextPageToken": "next"}, {"items": [event()]}]
    assert len(env.connector.calendar_read("user:one", query(limit=2), agent_id="a_one")["events"]) == 2
    assert env.backend.refresh_inputs == [env.backend.token, "first-rotated-refresh-token"]
    after = env.connector._data["people"]["user:one"]
    assert after["refresh_token"] == "second-rotated-refresh-token"
    assert after["epoch"] == before["epoch"] and after["allowed_minds"] == before["allowed_minds"]
    assert env.connector._epochs["user:one"] == before["epoch"]
    persisted = env.connector._path.read_text()
    assert "second-rotated-refresh-token" in persisted and env.backend.token not in persisted
    assert "first-rotated-refresh-token" not in persisted


def test_failed_read_after_refresh_persists_rotation_then_refuses_partial_data(env):
    connect(env)
    epoch = env.connector._epochs["user:one"]
    env.backend.rotation_tokens = ["valid-rotated-token-after-failure"]
    env.backend.page_failed = True
    env.backend.pages = [{"items": [event(description="must-not-publish")]}]
    error_code("google_unavailable", lambda: env.connector.calendar_read(env.session, query()))
    assert env.connector._data["people"]["user:one"]["refresh_token"] == "valid-rotated-token-after-failure"
    assert env.connector._epochs["user:one"] == epoch
    env.backend.page_failed = False
    assert env.connector.calendar_read(env.session, query())["events"] == []
    assert env.backend.refresh_inputs == [env.backend.token, "valid-rotated-token-after-failure"]


def test_provider_json_cannot_supply_private_rotation_or_failure_control(env):
    connect(env)
    env.backend.pages = [{"items": [event()], "refresh_token": "provider-json-poison", "failed": True}]
    result = env.connector.calendar_read(env.session, query())
    assert result["events"] and "provider-json-poison" not in env.connector._path.read_text()
    assert env.connector._data["people"]["user:one"]["refresh_token"] == env.backend.token


@pytest.mark.parametrize("rotation", [None, "", "x" * 16385])
def test_invalid_typed_rotation_cannot_replace_current_token(env, rotation, monkeypatch):
    connect(env)
    before = env.connector._path.read_bytes()
    monkeypatch.setattr(env.backend, "calendar_page", lambda *args: CalendarPage({"items": []}, rotation))
    error_code("google_unavailable", lambda: env.connector.calendar_read(env.session, query()))
    assert env.connector._path.read_bytes() == before


def test_atomic_rotation_write_failure_fails_closed_without_changing_consent_or_disk(env, monkeypatch):
    connect(env)
    env.connector.grant_mind(env.session, "a_one", True)
    before_bytes = env.connector._path.read_bytes()
    before = env.connector._data["people"]["user:one"].copy()
    env.backend.rotation_tokens = ["must-not-survive-failed-write"]
    def failed_replace(*args): raise OSError("synthetic rotation storage failure")
    monkeypatch.setattr(module.os, "replace", failed_replace)
    error_code("connector_storage", lambda: env.connector.calendar_read("user:one", query(), agent_id="a_one"))
    assert env.connector._path.read_bytes() == before_bytes
    assert env.connector._data["people"]["user:one"] == before
    assert env.connector._epochs["user:one"] == before["epoch"]
    assert not env.connector.mind_allowed({"id": "a_one"})
    assert not list(env.connector._directory.glob("*.tmp"))


def test_concurrent_same_owner_reads_use_serial_rotations_without_consent_change(env, monkeypatch):
    connect(env)
    epoch = env.connector._epochs["user:one"]
    first_started, release_first, second_attempted, second_io = [threading.Event() for _ in range(4)]
    original = env.backend.calendar_page
    calls, results, errors = [], [], []
    env.backend.rotation_tokens = ["concurrent-first-rotated-token", "concurrent-second-rotated-token"]
    def controlled(*args):
        calls.append(True)
        if len(calls) == 1:
            first_started.set()
            assert release_first.wait(3), "first synthetic request was not released"
        else:
            second_io.set()
        return original(*args)
    monkeypatch.setattr(env.backend, "calendar_page", controlled)
    def read(second=False):
        if second: second_attempted.set()
        try: results.append(env.connector.calendar_read(env.session, query()))
        except Exception as exc: errors.append(exc)
    first = threading.Thread(target=read, daemon=True)
    second = threading.Thread(target=lambda: read(True), daemon=True)
    try:
        first.start()
        assert first_started.wait(2)
        second.start()
        assert second_attempted.wait(2)
        assert not second_io.wait(0.05), "same-owner provider calls overlapped"
    finally:
        release_first.set()
        first.join(3)
        if second.ident is not None: second.join(3)
    assert not first.is_alive() and not second.is_alive() and not errors and len(results) == 2
    assert env.backend.refresh_inputs == [env.backend.token, "concurrent-first-rotated-token"]
    assert env.connector._data["people"]["user:one"]["refresh_token"] == "concurrent-second-rotated-token"
    assert env.connector._epochs["user:one"] == epoch


def test_disconnect_fences_immediately_while_owner_read_is_blocked_and_rotation_cannot_resurrect(env, monkeypatch):
    connect(env)
    started, release, disconnected = [threading.Event() for _ in range(3)]
    original = env.backend.calendar_page
    errors, disconnect_errors = [], []
    env.backend.rotation_tokens = ["late-rotated-token-must-not-resurrect"]
    def blocked(*args):
        started.set()
        assert release.wait(3), "synthetic provider request was not released"
        return original(*args)
    monkeypatch.setattr(env.backend, "calendar_page", blocked)
    def read():
        try: env.connector.calendar_read(env.session, query())
        except Exception as exc: errors.append(exc)
    def disconnect():
        try: env.connector.disconnect(env.session)
        except Exception as exc: disconnect_errors.append(exc)
        finally: disconnected.set()
    reader = threading.Thread(target=read, daemon=True)
    remover = threading.Thread(target=disconnect, daemon=True)
    try:
        reader.start()
        assert started.wait(2)
        remover.start()
        assert disconnected.wait(1), "disconnect waited behind the provider-read lock"
        assert not disconnect_errors and not env.connector.status(env.session)["connected"]
    finally:
        release.set()
        reader.join(3)
        if remover.ident is not None: remover.join(3)
    assert not reader.is_alive() and not remover.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], GoogleConnectorError)
    assert errors[0].code == "connection_changed"
    assert "late-rotated-token-must-not-resurrect" not in env.connector._path.read_text()


def family_session(env, username="legacyfamily"):
    session = {"token_hash": "family-" + username, "created_at": "2026-10-26T12:00:00Z", "kind": "sso",
               "principal": "user:" + username, "expires_at": time.time() + 3600, "signin_hash": None}
    env.db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", tuple(session.values()))
    return session


def test_legacy_family_requires_current_trusted_role_and_exact_owner_consent(env):
    session = family_session(env)
    error_code("person_required", lambda: env.connector.start(session, env.nonce))
    roles = {session["principal"]: "admin"}
    env.connector._person_role = roles.get
    env.db.execute("INSERT INTO agents VALUES ('family-mind', 'user:legacyfamily', 0)")
    state = env.connector.start(session, env.nonce)["authorization_url"]
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(state).query)["state"][0]
    assert env.connector.complete(state, "family-code", env.nonce)["connected"]
    assert env.connector.grant_mind(session, "family-mind", True)["allowed_minds"] == ["family-mind"]
    assert env.connector.mind_allowed({"id": "family-mind"})
    roles.clear()
    assert not env.connector.mind_allowed({"id": "family-mind"})
    error_code("person_required", lambda: env.connector.calendar_read(session, query()))


def test_legacy_family_allowlist_removal_during_io_refuses_result_and_rotation(env):
    session = family_session(env)
    roles = {session["principal"]: "member"}
    env.connector._person_role = roles.get
    started = env.connector.start(session, env.nonce)
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(started["authorization_url"]).query)["state"][0]
    env.connector.complete(state, "family-code", env.nonce)
    env.backend.rotation_tokens = ["family-late-rotation"]
    env.backend.on_page = roles.clear
    error_code("person_required", lambda: env.connector.calendar_read(session, query()))
    assert "family-late-rotation" not in env.connector._path.read_text()


def test_legacy_disabled_people_match_and_named_missing_row_and_operator_never_bypass(env):
    env.connector._person_role = lambda principal: "admin"
    disabled = family_session(env, "disabledfamily")
    env.db.execute("INSERT INTO people VALUES ('disabledfamily', 1, 'admin')")
    missing_named = family_session(env, "u_missing")
    operator = family_session(env, "operator")
    for session in (disabled, missing_named, operator):
        error_code("person_required", lambda: env.connector.start(session, env.nonce))
