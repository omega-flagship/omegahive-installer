"""GET /api/auth/me auth_session_ref: an opaque, per-session attribution reference that no route accepts as authority.

Ported from Review's seven copied-host route checks (test_host_session.py),
widened to cross-principal, role and non-authority cases. Disposable DB; Google is faked; nothing leaves."""

import base64
import hashlib
import hmac
import json
import os
import stat
import threading
import pathlib
import tempfile
import time
import urllib.parse

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.hive import token_hash
from hive.core.session_ref import KEY_FILE, SessionRefs, load_or_create_key

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

ME_KEYS = {"principal", "auth_session_ref", "kind", "expires_at", "role", "person", "person_kind", "local_operator"}
PUBLIC = {"x-forwarded-for": "192.0.2.1"}  # what the tunnel adds; marks the request public


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): raise AssertionError("no worker start")
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


class FakeGoogle:
    def __init__(self):
        self.account = {"email": "ana@example.com", "email_verified": True, "name": "Ana"}

    def userinfo(self):
        return {"sub": "g-" + self.account["email"].lower()} | self.account

    def handler(self, request):
        if request.url.host == "oauth2.googleapis.com":
            form = urllib.parse.parse_qs(request.content.decode())
            if form.get("code") == ["good-code"] and form.get("client_secret") == ["shh"]:
                # Google's ID token for this account (unsigned here; the hive checks iss/aud/exp/sub/email)
                enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
                claims = {"iss": "https://accounts.google.com", "aud": "cid", "exp": time.time() + 600,
                          "sub": self.userinfo()["sub"], "email": self.account["email"].lower()}
                return httpx.Response(200, json={"access_token": "at", "id_token": f"{enc({})}.{enc(claims)}.sig"})
            return httpx.Response(400, json={"error": "invalid_grant"})
        if request.url.host == "openidconnect.googleapis.com":
            return httpx.Response(200, json=self.userinfo())
        return httpx.Response(404)


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("HIVE_GOOGLE_REDIRECT_URI", "https://hive.example/omegahive/api/auth/google/callback")
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    monkeypatch.setenv("HIVE_SSO_USERS", "")
    tmp = tempfile.mkdtemp(prefix="hive-session-ref-")
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    google = FakeGoogle()
    app.state.hive.people.client = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
    with TestClient(app, base_url="https://hive.example") as c:
        yield app, c, google


def login(c):
    r = c.post("/api/auth/login", json={"password": "pw"})
    assert r.status_code == 200
    return r.json()["token"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def me(c, token, path="/api/auth/me", **headers):
    return c.get(path, headers={**bearer(token), **headers})


def sso_member(c, google, admin_token, email, name):
    """Invite, sign in through faked Google, exchange the cookie: returns the member's bearer token."""
    google.account = {"email": email, "email_verified": True, "name": name}
    invite = c.post("/api/invites", json={"email": email, "name": name, "role": "member"}, headers=bearer(admin_token)).json()
    start = c.get("/omegahive/api/auth/google/start?invite=" + invite["link"].split("invite=")[1], follow_redirects=False)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["state"][0]
    cb = c.get(f"/omegahive/api/auth/google/callback?code=good-code&state={state}", follow_redirects=False)
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cb.cookies["hive_signin"]}).json()
    c.cookies.clear()
    return session["token"]


def key_of(app):
    return bytes.fromhex((app.state.hive.settings.data_dir / KEY_FILE).read_text())


def expected_ref(app, token):
    return "as1_" + hmac.new(key_of(app), b"hive-auth-session-reference/2\0" + token_hash(token).encode(), hashlib.sha256).hexdigest()


def windows(secret, n=12):
    return {secret[i:i + n] for i in range(len(secret) - n + 1)}


def test_ref_is_stable_within_a_session(env):
    app, c, _ = env
    t = login(c)
    first = me(c, t).json()
    assert set(first) == ME_KEYS
    assert first["auth_session_ref"] == expected_ref(app, t)
    for _ in range(3):
        assert me(c, t).json() == first
    # the legacy ?token= form reads the same session, so the same reference
    assert c.get("/api/auth/me", params={"token": t}).json() == first


def test_ref_differs_across_sessions_of_the_same_principal(env):
    _, c, _ = env
    t1, t2 = login(c), login(c)
    a, b = me(c, t1).json(), me(c, t2).json()
    assert a["principal"] == b["principal"] == "user:operator"
    assert a["auth_session_ref"] != b["auth_session_ref"]


def test_ref_differs_across_principals(env):
    _, c, google = env
    admin = login(c)
    ana = sso_member(c, google, admin, "ana@example.com", "Ana")
    bo = sso_member(c, google, admin, "bo@example.com", "Bo")
    refs = {}
    for token in (admin, ana, bo):
        body = me(c, token).json()
        refs[body["principal"]] = body["auth_session_ref"]
    assert len(refs) == 3 and len(set(refs.values())) == 3


def test_ref_contains_neither_bearer_nor_token_hash(env):
    _, c, google = env
    admin = login(c)
    ana = sso_member(c, google, admin, "ana@example.com", "Ana")
    for token in (admin, ana):
        body = me(c, token).json()
        ref, raw = body["auth_session_ref"], me(c, token).text
        assert ref.startswith("as1_") and len(ref) == 68 and all(ch in "0123456789abcdef" for ch in ref[4:])
        for secret in (token, token_hash(token)):
            assert secret not in raw
            assert not any(w in ref for w in windows(secret)), "a 12-char window of a secret leaked into the ref"


@pytest.mark.parametrize("headers", [{}, bearer("forged"), {"Authorization": "Bearer "}])
def test_unauthenticated_gets_no_ref(env, headers):
    _, c, _ = env
    r = c.get("/api/auth/me", headers=headers)
    assert r.status_code == 401 and "auth_session_ref" not in r.text


def test_expired_and_logged_out_sessions_get_no_ref(env):
    app, c, _ = env
    expired, gone, kept = login(c), login(c), login(c)
    app.state.hive.db.execute("UPDATE sessions SET expires_at=? WHERE token_hash=?", (time.time() - 1, token_hash(expired)))
    r = me(c, expired)
    assert r.status_code == 401 and "auth_session_ref" not in r.text
    assert c.post("/api/auth/logout", headers=bearer(gone)).status_code == 200
    r = me(c, gone)
    assert r.status_code == 401 and "auth_session_ref" not in r.text
    assert me(c, kept).status_code == 200  # logout revoked only its own session


def test_public_password_refusal_and_roles_unchanged(env):
    _, c, google = env
    admin = login(c)
    # a password session from outside this machine is still refused, through the prefix and through proxy headers
    for r in (me(c, admin, "/omegahive/api/auth/me"), me(c, admin, **PUBLIC)):
        assert r.status_code == 401 and "auth_session_ref" not in r.text
    local = me(c, admin).json()
    assert (local["principal"], local["kind"], local["role"], local["person"], local["person_kind"], local["local_operator"]) == \
        ("user:operator", "password", "admin", None, "operator", True)
    ana = sso_member(c, google, admin, "ana@example.com", "Ana")
    via_public = me(c, ana, "/omegahive/api/auth/me").json()
    assert set(via_public) == ME_KEYS
    assert via_public["kind"] == "sso" and via_public["role"] == "member"
    assert via_public["person"]["name"] == "Ana" and via_public["person_kind"] == "person" and via_public["local_operator"] is False
    assert via_public == me(c, ana).json()  # same session, same answer locally or publicly
    # the member is still not an admin
    assert c.get("/omegahive/api/people", headers=bearer(ana)).status_code == 403


def test_nothing_accepts_the_ref_as_authority(env):
    _, c, google = env
    admin = login(c)
    ana = sso_member(c, google, admin, "ana@example.com", "Ana")
    admin_ref = me(c, admin).json()["auth_session_ref"]
    ana_ref = me(c, ana).json()["auth_session_ref"]
    for ref in (admin_ref, ana_ref):
        # as a bearer, a query token, or an agent token: unauthenticated
        assert c.get("/api/auth/me", headers=bearer(ref)).status_code == 401
        assert c.get("/api/hive", headers=bearer(ref)).status_code == 401
        assert c.get("/api/auth/me", params={"token": ref}).status_code == 401
        assert c.get("/api/agent/inbox", headers=bearer(ref)).status_code == 401
        # in a header or as a session cookie with no bearer: unauthenticated
        for name in ("X-Auth-Session-Ref", "X-Hive-Session", "auth_session_ref"):
            assert c.get("/api/hive", headers={name: ref}).status_code == 401
        assert c.get("/api/hive", cookies={"omega_session": ref}).status_code == 401
        c.cookies.clear()
        # as the password
        assert c.post("/api/auth/login", json={"password": ref}).status_code == 401
    # the member presenting the admin's ref, in headers or a body, gains nothing
    escalation = {**bearer(ana), "X-Auth-Session-Ref": admin_ref}
    assert c.get("/omegahive/api/people", headers=escalation).status_code == 403
    r = c.post("/omegahive/api/invites", json={"email": "x@example.com", "auth_session_ref": admin_ref}, headers=escalation)
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
    assert me(c, ana, "/omegahive/api/auth/me", **{"X-Auth-Session-Ref": admin_ref}).json()["auth_session_ref"] == ana_ref


# K2 (Kimi, person-session review): the reference is keyed per deployment.

def unkeyed_candidates(token):
    """What a bearer holder (or a sessions-table reader) could compute without the deployment key."""
    th = token_hash(token)
    out = set()
    for domain in (b"hive-auth-session-reference/1\0", b"hive-auth-session-reference/2\0"):
        for material in (th.encode(), token.encode()):
            out.add("as1_" + hashlib.sha256(domain + material).hexdigest())
            for guess in (b"", th.encode(), token.encode(), b"\0" * 32):
                out.add("as1_" + hmac.new(guess, domain + material, hashlib.sha256).hexdigest())
    return out


def test_bearer_holder_cannot_recompute_the_ref(env):
    app, c, _ = env
    t = login(c)
    ref = me(c, t).json()["auth_session_ref"]
    assert ref not in unkeyed_candidates(t)
    assert ref == expected_ref(app, t)  # it is the keyed HMAC, and only the key file makes it computable


def test_key_file_created_on_first_use_0600(env):
    app, c, _ = env
    path = app.state.hive.settings.data_dir / KEY_FILE
    t = login(c)
    me(c, t)
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert len(path.read_text()) == 64 and len(key_of(app)) == 32
    assert not list(path.parent.glob(f".{KEY_FILE}.*.tmp"))  # no temp files left behind


def _app(data_dir):
    settings = load_settings(data_dir=data_dir, admin_password="pw", petta_path=PETTA, offline=True)
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


def test_ref_stable_across_restart_with_same_key_and_changes_under_a_new_key(tmp_path):
    with TestClient(_app(tmp_path)) as c:
        t = login(c)
        before = me(c, t).json()["auth_session_ref"]
    with TestClient(_app(tmp_path)) as c:  # restart: same data dir, same key, same session row
        assert me(c, t).json()["auth_session_ref"] == before
    (tmp_path / KEY_FILE).write_text(hashlib.sha256(b"a different deployment key").hexdigest())
    with TestClient(_app(tmp_path)) as c:
        after = me(c, t).json()
        assert after["principal"] == "user:operator"  # the session itself is untouched
        assert after["auth_session_ref"] != before


@pytest.mark.parametrize("content", ["", "not a key", "ab" * 31, "AB" * 32, "zz" * 32])
def test_malformed_key_is_replaced_never_unkeyed(tmp_path, content):
    (tmp_path / KEY_FILE).write_text(content)
    key = load_or_create_key(tmp_path)
    assert len(key) == 32 and (tmp_path / KEY_FILE).read_text() == key.hex()
    assert stat.S_IMODE((tmp_path / KEY_FILE).stat().st_mode) == 0o600
    with TestClient(_app(tmp_path)) as c:
        t = login(c)
        ref = me(c, t).json()["auth_session_ref"]
    assert ref == "as1_" + hmac.new(key, b"hive-auth-session-reference/2\0" + token_hash(t).encode(), hashlib.sha256).hexdigest()
    assert ref not in unkeyed_candidates(t)


def test_loose_key_permissions_are_tightened(tmp_path):
    key = load_or_create_key(tmp_path)
    (tmp_path / KEY_FILE).chmod(0o644)
    assert load_or_create_key(tmp_path) == key
    assert stat.S_IMODE((tmp_path / KEY_FILE).stat().st_mode) == 0o600


def test_concurrent_first_use_agrees_on_one_key(tmp_path):
    keys, barrier = [], threading.Barrier(8)

    def first_use():
        barrier.wait()
        keys.append(SessionRefs(tmp_path).key())

    threads = [threading.Thread(target=first_use) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len(keys) == 8 and len(set(keys)) == 1
    assert (tmp_path / KEY_FILE).read_text() == keys[0].hex()
