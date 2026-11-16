"""Real pinned Google SDKs with synthetic, in-process transports only.

Missing/wrong dependencies are failures. This fixture never substitutes SDK
classes, discovery/build, Credentials or Flow, and never opens a real socket.
Source authored separately from Root's admitted native execution: NOT_RUN.
"""

import base64
import contextlib
import hashlib
import importlib.metadata
import inspect
import io
import json
import logging
import math
import os
import pathlib
import socket
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import urllib.response
from email.message import Message
from types import SimpleNamespace

import httplib2
import pytest
import requests
from google.auth.credentials import Credentials as GoogleCredentialsBase
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import HttpRequest
from requests_oauthlib import OAuth2Session

from hive.core.google_backend import CALENDAR_SCOPE, GoogleLibraryBackend
from hive.core.google_connector import GoogleConnector, GoogleConnectorError


CLIENT_ID = "sdk-fixture-client"
CLIENT_SECRET = "sdk-fixture-client-secret-1234567890"
REFRESH_TOKEN = "sdk-fixture-person-refresh-token"
ROTATED_REFRESH_TOKEN = "sdk-fixture-rotated-refresh-token"
ACCESS_TOKEN = "sdk-fixture-access-token-in-memory"
CALLBACK = "https://hive.example/base/api/connectors/google/callback"
AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"
CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
PRIVATE_DESCRIPTION = "sdk-fixture-private-description-must-not-escape"


class FixtureDB:
    """Fresh synthetic rows only; no SQLite file or real account is opened."""

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
        with self._lock:
            yield self


def fixture_event(title="Synthetic appointment", **extra):
    return {"summary": title, "start": {"dateTime": "2026-10-26T10:00:00Z"},
            "end": {"dateTime": "2026-10-26T11:00:00Z"}, "transparency": "opaque",
            "description": PRIVATE_DESCRIPTION, "attendees": [{"email": "synthetic-private@example.test"}]} | extra


class SyntheticGoogle:
    def __init__(self):
        self.unexpected = []
        self.token_calls = []
        self.calendar_calls = []
        self.revoke_calls = []
        self.pages = {None: {"items": [fixture_event()]}}
        self.rotate_refresh = False
        self.current_refresh_token = REFRESH_TOKEN
        self.refresh_scope = CALENDAR_SCOPE
        self.exchange_failure = False
        self.refresh_failure = False
        self.calendar_failure = False
        self.calendar_malformed = False
        self.revoke_status = 200
        self.on_revoke = None

    def forbidden(self, label):
        # The list is checked at teardown as well: the connector's safe-error
        # conversion must never hide a real or unrecognised transport attempt.
        self.unexpected.append(label)
        raise AssertionError("Unexpected endpoint or external network attempt")

    @staticmethod
    def _form(body):
        if isinstance(body, bytes):
            body = body.decode("utf-8")
        return urllib.parse.parse_qs(body or "", keep_blank_values=True)

    @staticmethod
    def _response(request, status, payload):
        response = requests.Response()
        response.status_code = status
        response.reason = "Synthetic response"
        response.url = request.url
        response.request = request
        response.headers = {"Content-Type": "application/json"}
        response.encoding = "utf-8"
        response._content = json.dumps(payload).encode("utf-8")
        return response

    def requests_send(self, session, request, **kwargs):
        if request.url != TOKEN_ENDPOINT or request.method != "POST":
            return self.forbidden("requests endpoint")
        timeout = kwargs.get("timeout")
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 120:
            return self.forbidden("requests timeout")
        form = self._form(request.body)
        grant = form.get("grant_type")
        if grant not in (["authorization_code"], ["refresh_token"]):
            return self.forbidden("OAuth grant type")
        if grant == ["refresh_token"] and form.get("refresh_token") != [self.current_refresh_token]:
            return self.forbidden("stale refresh token")
        headers = {key.lower(): value for key, value in request.headers.items()}
        self.token_calls.append({"form": form, "headers": headers, "timeout": timeout,
                                 "max_redirects": session.max_redirects})
        if grant == ["authorization_code"] and self.exchange_failure:
            return self._response(request, 400, {"error": "invalid_grant", "error_description": PRIVATE_DESCRIPTION + REFRESH_TOKEN})
        if grant == ["refresh_token"] and self.refresh_failure:
            return self._response(request, 400, {"error": "invalid_grant", "error_description": PRIVATE_DESCRIPTION + REFRESH_TOKEN})
        payload = {"access_token": ACCESS_TOKEN, "expires_in": 3600, "token_type": "Bearer", "scope": CALENDAR_SCOPE}
        if grant == ["authorization_code"]:
            payload["refresh_token"] = REFRESH_TOKEN
            self.current_refresh_token = REFRESH_TOKEN
        elif self.rotate_refresh:
            payload["refresh_token"] = ROTATED_REFRESH_TOKEN
            self.current_refresh_token = ROTATED_REFRESH_TOKEN
        if grant == ["refresh_token"]:
            if self.refresh_scope is None:
                payload.pop("scope")
            else:
                payload["scope"] = self.refresh_scope
        return self._response(request, 200, payload)

    def http_request(self, http, uri, method="GET", body=None, headers=None, **kwargs):
        parsed = urllib.parse.urlsplit(uri)
        endpoint = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        if endpoint != CALENDAR_ENDPOINT or method != "GET" or body is not None or parsed.fragment:
            return self.forbidden("httplib2 endpoint")
        query = urllib.parse.parse_qs(parsed.query)
        normal_headers = {key.lower(): value for key, value in (headers or {}).items()}
        if normal_headers.get("authorization") != "Bearer " + ACCESS_TOKEN:
            return self.forbidden("Calendar authorization")
        if http.timeout != 10.0:
            return self.forbidden("Calendar timeout")
        self.calendar_calls.append({"query": query, "headers": normal_headers, "timeout": http.timeout})
        if self.calendar_failure:
            payload = {"error": {"code": 503, "message": PRIVATE_DESCRIPTION + REFRESH_TOKEN}}
            return httplib2.Response({"status": "503", "content-type": "application/json"}), json.dumps(payload).encode()
        if self.calendar_malformed:
            return httplib2.Response({"status": "200", "content-type": "application/json"}), b"not-json-private-body"
        page_token = query.get("pageToken", [None])[0]
        if page_token not in self.pages:
            return self.forbidden("Calendar page token")
        return (httplib2.Response({"status": "200", "content-type": "application/json"}),
                json.dumps(self.pages[page_token]).encode("utf-8"))

    def urllib_https_open(self, handler, request):
        if request.full_url != REVOKE_ENDPOINT or request.get_method() != "POST":
            return self.forbidden("urllib endpoint")
        self.revoke_calls.append({"url": request.full_url, "form": self._form(request.data),
                                  "timeout": getattr(request, "timeout", None), "headers": dict(request.header_items())})
        if self.on_revoke:
            self.on_revoke()
        headers = Message()
        headers["Content-Type"] = "application/json"
        if self.revoke_status == 302:
            headers["Location"] = "https://unrecognised.invalid/never-follow"
        response = urllib.response.addinfourl(io.BytesIO(b"{}"), headers, request.full_url, self.revoke_status)
        response.msg = "Synthetic response"
        return response


@pytest.fixture
def sdk_transport(monkeypatch):
    google = SyntheticGoogle()
    # Patch the real base classes. OAuth2Session's inherited transport and the
    # actual AuthorizedHttp wrapper both reach these methods normally.
    monkeypatch.setattr(requests.Session, "send", lambda session, request, **kwargs: google.requests_send(session, request, **kwargs))
    monkeypatch.setattr(httplib2.Http, "request", lambda http, uri, *args, **kwargs: google.http_request(http, uri, *args, **kwargs))
    monkeypatch.setattr(urllib.request.HTTPSHandler, "https_open", lambda handler, request: google.urllib_https_open(handler, request))
    monkeypatch.setattr(urllib.request.HTTPHandler, "http_open", lambda *args, **kwargs: google.forbidden("plain HTTP"))
    for name in ("getaddrinfo", "create_connection"):
        monkeypatch.setattr(socket, name, lambda *args, **kwargs: google.forbidden("socket or DNS"))
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, lambda *args, **kwargs: google.forbidden("socket operation"))
    yield google
    assert google.unexpected == [], "An unexpected endpoint/network attempt was caught"


@pytest.fixture
def sdk_host(tmp_path, sdk_transport):
    db = FixtureDB()
    db.execute("INSERT INTO people VALUES ('fixture-person', 0, 'member')")
    expires = time.time() + 3600
    session = {"token_hash": "fixture-session", "created_at": "2026-10-26T12:00:00Z", "kind": "sso",
               "principal": "user:fixture-person", "expires_at": expires, "signin_hash": "fixture-signin"}
    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)", tuple(session.values()))
    db.execute("INSERT INTO signins VALUES ('fixture-signin', 'fixture-person', ?)", (expires,))
    db.execute("INSERT INTO agents VALUES ('fixture-mind', 'user:fixture-person', 0)")
    settings = SimpleNamespace(data_dir=tmp_path, public_url="https://hive.example/base")
    connector = GoogleConnector(SimpleNamespace(db=db), settings)
    assert isinstance(connector.backend, GoogleLibraryBackend)
    assert connector.configure_client(CLIENT_ID, CLIENT_SECRET)["ready"] is True
    yield SimpleNamespace(db=db, connector=connector, settings=settings, session=session,
                          nonce="sdk-browser-binding-" + "x" * 40, google=sdk_transport)
    db.conn.close()


def start_flow(host):
    started = host.connector.start(host.session, host.nonce)
    args = urllib.parse.parse_qs(urllib.parse.urlsplit(started["authorization_url"]).query)
    state = args["state"][0]
    verifier = host.connector._pending[hashlib.sha256(state.encode()).hexdigest()]["verifier"]
    return state, verifier, started


def connect(host):
    state, verifier, started = start_flow(host)
    result = host.connector.complete(state, "sdk-synthetic-code", host.nonce)
    assert result["connected"] is True
    return verifier, started


def calendar_query(**extra):
    return {"time_min": "2026-10-26T00:00:00Z", "time_max": "2026-10-27T00:00:00Z"} | extra


def test_sdk_versions_are_exact_root_pins():
    assert {name: importlib.metadata.version(name) for name in (
        "google-auth", "google-auth-oauthlib", "google-api-python-client")} == {
            "google-auth": "2.62.0", "google-auth-oauthlib": "1.5.0", "google-api-python-client": "2.201.0"}
    target = os.environ.get("HIVE_G5_GOOGLE_PACKAGE_TARGET")
    if target:
        target = pathlib.Path(target).resolve()
        for actual in (Flow, Credentials, GoogleCredentialsBase, build):
            origin = pathlib.Path(inspect.getfile(actual)).resolve()
            assert origin.is_relative_to(target), "An official SDK import came from outside Root's pinned target"


def test_real_flow_s256_state_fixed_url_and_authorization_code_verifier(sdk_host):
    host = sdk_host
    actual = host.connector.backend._flow({"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}, CALLBACK, "v" * 64)
    assert isinstance(actual, Flow) and isinstance(actual.oauth2session, OAuth2Session)
    state, verifier, started = start_flow(host)
    parsed = urllib.parse.urlsplit(started["authorization_url"])
    assert urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", "")) == AUTH_ENDPOINT
    args = urllib.parse.parse_qs(parsed.query)
    expected_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
    assert args["state"] == [state] and args["code_challenge_method"] == ["S256"]
    assert args["code_challenge"] == [expected_challenge] and args["redirect_uri"] == [CALLBACK]
    assert args["scope"] == [CALENDAR_SCOPE] and args["access_type"] == ["offline"]
    assert args["response_type"] == ["code"] and args["client_id"] == [CLIENT_ID]
    assert verifier not in started["authorization_url"] and not host.google.token_calls
    result = host.connector.complete(state, "sdk-synthetic-code", host.nonce)
    assert result["connected"] and len(host.google.token_calls) == 1
    call = host.google.token_calls[0]
    assert call["form"]["grant_type"] == ["authorization_code"]
    assert call["form"]["code"] == ["sdk-synthetic-code"] and call["form"]["code_verifier"] == [verifier]
    assert call["form"]["redirect_uri"] == [CALLBACK]
    if "authorization" in call["headers"]:
        scheme, encoded = call["headers"]["authorization"].split(" ", 1)
        assert scheme.lower() == "basic" and base64.b64decode(encoded).decode() == CLIENT_ID + ":" + CLIENT_SECRET
    else:
        assert call["form"]["client_id"] == [CLIENT_ID] and call["form"]["client_secret"] == [CLIENT_SECRET]
    assert call["timeout"] == 10.0 and call["max_redirects"] == 0
    body = host.connector._path.read_text()
    assert REFRESH_TOKEN in body and ACCESS_TOKEN not in body and verifier not in body
    with pytest.raises(GoogleConnectorError) as replay:
        host.connector.complete(state, "sdk-synthetic-code", host.nonce)
    assert replay.value.code == "invalid_state" and len(host.google.token_calls) == 1


def test_real_credentials_refresh_performs_transport_and_accepts_refresh_token_rotation(sdk_transport):
    sdk_transport.rotate_refresh = True
    credentials = Credentials(token=None, refresh_token=REFRESH_TOKEN, token_uri=TOKEN_ENDPOINT,
                              client_id=CLIENT_ID, client_secret=CLIENT_SECRET, scopes=[CALENDAR_SCOPE])
    assert isinstance(credentials, GoogleCredentialsBase) and credentials.token is None
    with requests.Session() as session:
        session.max_redirects = 0
        credentials.refresh(Request(session=session))
    assert credentials.token == ACCESS_TOKEN and credentials.refresh_token == ROTATED_REFRESH_TOKEN
    assert credentials.valid and credentials.expiry is not None
    assert len(sdk_transport.token_calls) == 1
    assert sdk_transport.token_calls[0]["form"]["grant_type"] == ["refresh_token"]
    assert sdk_transport.token_calls[0]["form"]["refresh_token"] == [REFRESH_TOKEN]


def test_real_static_discovery_build_performs_no_discovery_network(sdk_transport):
    service = build("calendar", "v3", http=httplib2.Http(timeout=10), static_discovery=True, cache_discovery=False)
    try:
        request = service.events().list(calendarId="primary", timeMin="2026-10-26T00:00:00Z",
                                        timeMax="2026-10-27T00:00:00Z", maxResults=1,
                                        fields="items(summary,start,end)")
        assert isinstance(request, HttpRequest) and request.uri.startswith(CALENDAR_ENDPOINT + "?")
        assert not sdk_transport.token_calls and not sdk_transport.calendar_calls
    finally:
        service.close()


def test_real_calendar_client_minimal_fields_time_limit_paging_and_transient_access(sdk_host):
    host = sdk_host
    verifier, _ = connect(host)
    host.google.pages = {
        None: {"items": [fixture_event()], "nextPageToken": "sdk-page-two"},
        "sdk-page-two": {"items": [fixture_event("Free", transparency="transparent")]},
    }
    result = host.connector.calendar_read(host.session, calendar_query(limit=2))
    assert result == {"op": "calendar.read", "events": [
        {"title": "Synthetic appointment", "start": "2026-10-26T10:00:00Z", "end": "2026-10-26T11:00:00Z", "busy": True},
        {"title": "Free", "start": "2026-10-26T10:00:00Z", "end": "2026-10-26T11:00:00Z", "busy": False},
    ], "truncated": False}
    calls = host.google.calendar_calls
    assert len(calls) == 2
    assert [c["query"]["maxResults"] for c in calls] == [["2"], ["1"]]
    assert "pageToken" not in calls[0]["query"] and calls[1]["query"]["pageToken"] == ["sdk-page-two"]
    for call in calls:
        args = call["query"]
        assert args["timeMin"] == ["2026-10-26T00:00:00Z"] and args["timeMax"] == ["2026-10-27T00:00:00Z"]
        assert args["singleEvents"] == ["true"] and args["orderBy"] == ["startTime"]
        assert args["fields"] == ["nextPageToken,items(summary,start(date,dateTime),end(date,dateTime),transparency,status)"]
        assert "attendees" not in args["fields"][0] and "description" not in args["fields"][0]
    refreshes = [call for call in host.google.token_calls if call["form"]["grant_type"] == ["refresh_token"]]
    assert len(refreshes) == 2 and all(call["timeout"] == 10.0 for call in refreshes)
    persisted = host.connector._path.read_text()
    for secret in (ACCESS_TOKEN, verifier, PRIVATE_DESCRIPTION, "synthetic-private@example.test"):
        assert secret not in persisted and secret not in json.dumps(result)


def test_real_calendar_total_page_bound_and_title_clipping_are_truthful(sdk_host):
    host = sdk_host
    connect(host)
    host.google.pages = {None: {"items": [fixture_event("x" * 201)], "nextPageToken": "p1"},
                         "p1": {"items": [], "nextPageToken": "p2"},
                         "p2": {"items": [], "nextPageToken": "p3"},
                         "p3": {"items": [], "nextPageToken": "p4"},
                         "p4": {"items": [fixture_event("must-not-fetch")]}}
    result = host.connector.calendar_read(host.session, calendar_query(limit=100))
    assert len(host.google.calendar_calls) == 4
    assert result["events"][0]["title"] == "x" * 200 and result["truncated"] is True


def test_real_calendar_item_cap_does_not_fetch_another_page(sdk_host):
    host = sdk_host
    connect(host)
    host.google.pages = {None: {"items": [fixture_event()], "nextPageToken": "must-not-fetch"}}
    result = host.connector.calendar_read(host.session, calendar_query(limit=1))
    assert len(host.google.calendar_calls) == 1 and len(result["events"]) == 1 and result["truncated"] is True


@pytest.mark.parametrize("scope", [None, CALENDAR_SCOPE])
def test_real_refresh_rotation_is_persisted_for_next_page_without_changing_consent(sdk_host, scope):
    host = sdk_host
    connect(host)
    host.connector.grant_mind(host.session, "fixture-mind", True)
    before = host.connector._data["people"][host.session["principal"]].copy()
    host.google.rotate_refresh = True
    host.google.refresh_scope = scope
    host.google.pages = {None: {"items": [fixture_event()], "nextPageToken": "rotated-page"},
                         "rotated-page": {"items": [fixture_event("Second")]}}
    result = host.connector.calendar_read(host.session["principal"], calendar_query(limit=2), agent_id="fixture-mind")
    assert len(result["events"]) == 2 and not result["truncated"]
    refreshes = [call for call in host.google.token_calls if call["form"]["grant_type"] == ["refresh_token"]]
    assert [call["form"]["refresh_token"] for call in refreshes] == [[REFRESH_TOKEN], [ROTATED_REFRESH_TOKEN]]
    after = host.connector._data["people"][host.session["principal"]]
    assert after["refresh_token"] == ROTATED_REFRESH_TOKEN
    assert after["epoch"] == before["epoch"] and after["allowed_minds"] == before["allowed_minds"]
    persisted = host.connector._path.read_text()
    assert ROTATED_REFRESH_TOKEN in persisted and REFRESH_TOKEN not in persisted and ACCESS_TOKEN not in persisted


def test_real_explicitly_widened_refresh_scope_is_refused_before_calendar_or_rotation_persistence(sdk_host):
    host = sdk_host
    connect(host)
    before = host.connector._path.read_bytes()
    host.google.rotate_refresh = True
    host.google.refresh_scope = CALENDAR_SCOPE + " https://www.googleapis.com/auth/calendar"
    with pytest.raises(GoogleConnectorError) as caught:
        host.connector.calendar_read(host.session, calendar_query())
    assert caught.value.code == "google_unavailable" and not host.google.calendar_calls
    assert host.connector._path.read_bytes() == before
    assert ROTATED_REFRESH_TOKEN not in host.connector._path.read_text()


def test_real_rotation_survives_calendar_failure_and_next_read_uses_it(sdk_host):
    host = sdk_host
    connect(host)
    epoch = host.connector._epochs[host.session["principal"]]
    host.google.rotate_refresh = True
    host.google.calendar_failure = True
    with pytest.raises(GoogleConnectorError) as caught:
        host.connector.calendar_read(host.session, calendar_query())
    assert caught.value.code == "google_unavailable"
    assert host.connector._data["people"][host.session["principal"]]["refresh_token"] == ROTATED_REFRESH_TOKEN
    assert host.connector._epochs[host.session["principal"]] == epoch
    host.google.calendar_failure = False
    assert host.connector.calendar_read(host.session, calendar_query())["events"]
    refreshes = [call for call in host.google.token_calls if call["form"]["grant_type"] == ["refresh_token"]]
    assert [call["form"]["refresh_token"] for call in refreshes] == [[REFRESH_TOKEN], [ROTATED_REFRESH_TOKEN]]


@pytest.mark.parametrize("transport", ["httplib2", "requests"])
def test_real_rotation_survives_transport_cleanup_failure_without_publishing_partial_events(sdk_host, monkeypatch, transport):
    host = sdk_host
    connect(host)
    host.google.rotate_refresh = True
    actual_class = httplib2.Http if transport == "httplib2" else requests.Session
    original_close = actual_class.close
    failures = []
    def fail_once(instance):
        original_close(instance)
        if not failures:
            failures.append(True)
            raise RuntimeError("synthetic private transport cleanup failure")
    monkeypatch.setattr(actual_class, "close", fail_once)
    with pytest.raises(GoogleConnectorError) as caught:
        host.connector.calendar_read(host.session, calendar_query())
    assert caught.value.code == "google_unavailable" and failures == [True]
    assert host.connector._data["people"][host.session["principal"]]["refresh_token"] == ROTATED_REFRESH_TOKEN
    assert host.connector.calendar_read(host.session, calendar_query())["events"]
    refreshes = [call for call in host.google.token_calls if call["form"]["grant_type"] == ["refresh_token"]]
    assert [call["form"]["refresh_token"] for call in refreshes] == [[REFRESH_TOKEN], [ROTATED_REFRESH_TOKEN]]


@pytest.mark.parametrize("stage", ["exchange", "refresh", "calendar", "calendar_malformed"])
def test_real_sdk_failures_produce_safe_constant_errors_without_retrying_calendar(sdk_host, stage):
    host = sdk_host
    if stage == "exchange":
        state, verifier, _ = start_flow(host)
        host.google.exchange_failure = True
        operation = lambda: host.connector.complete(state, "sdk-synthetic-code", host.nonce)
    else:
        verifier, _ = connect(host)
        setattr(host.google, stage + "_failure" if stage != "calendar_malformed" else stage, True)
        operation = lambda: host.connector.calendar_read(host.session, calendar_query())
    with pytest.raises(GoogleConnectorError) as caught:
        operation()
    assert caught.value.status == 502 and caught.value.code == "google_unavailable"
    assert str(caught.value) == "Google could not complete this request." and caught.value.__suppress_context__
    for secret in (CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN, verifier, PRIVATE_DESCRIPTION):
        assert secret not in str(caught.value)
    assert len(host.google.calendar_calls) <= 1


@pytest.mark.parametrize("status,expected", [(200, "confirmed"), (302, "unconfirmed")])
def test_real_urllib_revoke_form_fixed_endpoint_and_redirect_refusal(sdk_host, status, expected):
    host = sdk_host
    connect(host)
    host.google.revoke_status = status
    def removed_before_revoke():
        assert REFRESH_TOKEN not in host.connector._path.read_text()
        assert host.connector.status(host.session)["connected"] is False
    host.google.on_revoke = removed_before_revoke
    result = host.connector.disconnect(host.session)
    assert result["connected"] is False and result["revocation"] == expected
    assert len(host.google.revoke_calls) == 1
    call = host.google.revoke_calls[0]
    assert call["url"] == REVOKE_ENDPOINT and call["form"] == {"token": [REFRESH_TOKEN]} and call["timeout"] == 10.0
    assert REFRESH_TOKEN not in call["url"]


def test_real_sdk_debug_handlers_do_not_receive_tokens_verifier_or_event_bodies(sdk_host, caplog):
    host = sdk_host
    logger = logging.getLogger("requests_oauthlib.oauth2_session")
    saved = (list(logger.handlers), logger.propagate, logger.disabled, logger.level)
    output = io.StringIO()
    try:
        logger.handlers = [logging.StreamHandler(output)]
        logger.propagate = True
        logger.disabled = False
        logger.setLevel(logging.DEBUG)
        caplog.set_level(logging.DEBUG)
        verifier, _ = connect(host)
        host.connector.calendar_read(host.session, calendar_query())
        host.connector.disconnect(host.session)
        captured = output.getvalue() + caplog.text
        for secret in (CLIENT_SECRET, REFRESH_TOKEN, ACCESS_TOKEN, verifier, PRIVATE_DESCRIPTION, "Synthetic appointment"):
            assert secret not in captured
    finally:
        logger.handlers, logger.propagate, logger.disabled, level = saved
        logger.setLevel(level)
