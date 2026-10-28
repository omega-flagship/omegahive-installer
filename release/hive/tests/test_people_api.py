"""Invite-only people: invitations, the hive's own Google sign-in, roles. Google is faked; nothing leaves."""

import base64
import json
import os
import time
import pathlib
import tempfile
import threading
import urllib.parse

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


def make_jwt(claims):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.sig"


class FakeGoogle:
    def __init__(self):
        self.account = {"email": "ana@example.com", "email_verified": True, "name": "Ana"}
        self.claims = {}         # overrides on the ID token Google would issue for self.account (None drops a claim)
        self.no_id_token = False
        self.exchanges = 0       # how many codes reached the token endpoint
        self.fail = None         # "connect" | "token_json" | "token_list" | "userinfo_json" | "userinfo_timeout"
        self.on_userinfo = None  # called when userinfo is served (a controlled interleaving point)

    def userinfo(self):
        return {"sub": "g-" + str(self.account.get("email", "")).lower()} | self.account

    def id_token_claims(self):
        info = self.userinfo()
        claims = {"iss": "https://accounts.google.com", "aud": "cid", "exp": time.time() + 600, "sub": info["sub"],
                  "email": info.get("email"), "email_verified": info.get("email_verified")}
        if "hd" in info:
            claims["hd"] = info["hd"]
        claims.update(self.claims)
        return {k: v for k, v in claims.items() if v is not None}

    def handler(self, request):
        if request.url.host == "oauth2.googleapis.com":
            if self.fail == "connect":
                raise httpx.ConnectError("no route to Google", request=request)
            if self.fail == "token_json":
                return httpx.Response(200, content=b"<html>not json</html>")
            if self.fail == "token_list":
                return httpx.Response(200, json=["at"])
            form = urllib.parse.parse_qs(request.content.decode())
            if form.get("code") == ["good-code"] and form.get("client_secret") == ["shh"]:
                self.exchanges += 1
                tokens = {"access_token": "at"}
                if not self.no_id_token:
                    tokens["id_token"] = make_jwt(self.id_token_claims())
                return httpx.Response(200, json=tokens)
            return httpx.Response(400, json={"error": "invalid_grant"})
        if request.url.host == "openidconnect.googleapis.com":
            if self.fail == "userinfo_timeout":
                raise httpx.ReadTimeout("slow", request=request)
            if self.fail == "userinfo_json":
                return httpx.Response(200, content=b"{broken")
            if self.on_userinfo:
                self.on_userinfo()
            return httpx.Response(200, json=self.userinfo())
        return httpx.Response(404)


@pytest.fixture()
def env(monkeypatch):
    yield from _env(monkeypatch)


@pytest.fixture()
def domain_env(monkeypatch):
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", " SingularityNET.io , ")
    yield from _env(monkeypatch)


def _env(monkeypatch, webhost=False):
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("HIVE_GOOGLE_REDIRECT_URI", "https://hive.example/omegahive/api/auth/google/callback")
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    if not webhost:
        monkeypatch.setenv("HIVE_SSO_USERS", "")
    tmp = tempfile.mkdtemp(prefix="hive-people-")
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    google = FakeGoogle()
    client = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
    app.state.hive.people.client = client
    with TestClient(app, base_url="https://hive.example") as c:
        admin_token = c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        yield c, google, {"Authorization": f"Bearer {admin_token}"}


def sign_in(c, invite=None, code="good-code"):
    """Walk the browser through start -> (Google) -> callback; returns the callback response."""
    start = c.get("/omegahive/api/auth/google/start" + (f"?invite={invite}" if invite else ""), follow_redirects=False)
    assert start.status_code == 303
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["state"][0]
    return c.get(f"/omegahive/api/auth/google/callback?code={code}&state={state}", follow_redirects=False), state


def test_invited_person_signs_in_once_and_then_directly(env):
    c, google, admin = env
    created = c.post("/api/invites", json={"email": "Ana@Example.com", "name": "Ana", "role": "member"}, headers=admin).json()
    assert created["status"] == "pending" and created["link"].startswith("https://hive.example/omegahive/?invite=")
    token = created["link"].split("invite=")[1]
    assert c.get(f"/omegahive/api/auth/invite/{token}").json()["email_hint"] == "an…@example.com"
    r, _ = sign_in(c, token)
    assert r.status_code == 303 and r.headers["location"] == "/omegahive/"
    cookie = r.cookies.get("hive_signin")
    assert cookie and "httponly" in r.headers["set-cookie"].lower() and "path=/omegahive/" in r.headers["set-cookie"].lower()
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie}).json()
    assert session["user"]["email"] == "ana@example.com" and session["user"]["role"] == "member"
    me = c.get("/omegahive/api/auth/me", headers={"Authorization": f"Bearer {session['token']}"}).json()
    assert me["role"] == "member" and me["person"]["name"] == "Ana"
    # the invitation is used up; Ana signs in directly from now on
    assert c.get(f"/omegahive/api/auth/invite/{token}").status_code == 410
    r2, _ = sign_in(c)
    assert r2.headers["location"] == "/omegahive/" and r2.cookies.get("hive_signin")


def test_refusals(env):
    c, google, admin = env
    # a stranger without an invitation
    r, _ = sign_in(c)
    assert "signin_error=not_invited" in r.headers["location"] and not r.cookies.get("hive_signin")
    # the invitation is for someone else
    created = c.post("/api/invites", json={"email": "bo@example.com"}, headers=admin).json()
    token = created["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    assert "signin_error=wrong_account" in r.headers["location"]
    # unverified email
    google.account = {"email": "bo@example.com", "email_verified": False}
    r, _ = sign_in(c, token)
    assert "signin_error=email_unverified" in r.headers["location"]
    # a state used twice, or never issued
    google.account = {"email": "bo@example.com", "email_verified": True}
    r, state = sign_in(c, token)
    assert r.headers["location"] == "/omegahive/"
    again = c.get(f"/omegahive/api/auth/google/callback?code=good-code&state={state}", follow_redirects=False)
    assert "signin_error=bad_state" in again.headers["location"]
    forged = c.get("/omegahive/api/auth/google/callback?code=good-code&state=forged", follow_redirects=False)
    assert "signin_error=bad_state" in forged.headers["location"]
    # a revoked invitation
    other = c.post("/api/invites", json={"email": "cy@example.com"}, headers=admin).json()
    c.delete(f"/api/invites/{other['id']}", headers=admin)
    assert c.get("/omegahive/api/auth/google/start?invite=" + other["link"].split("invite=")[1], follow_redirects=False).status_code == 410
    # a bad Google code
    google.account = {"email": "bo@example.com", "email_verified": True}
    r, _ = sign_in(c, code="bad")
    assert "signin_error=google_refused" in r.headers["location"]
    # no cookie, forged cookie
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/sso").status_code == 401
    assert c.post("/omegahive/api/auth/sso", cookies={"hive_signin": "forged"}).status_code == 401


def test_members_are_not_admins_and_removal_revokes(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies["hive_signin"]}).json()
    member = {"Authorization": f"Bearer {session['token']}"}
    assert c.get("/omegahive/api/hive", headers=member).status_code == 200
    for method, path, body in (("POST", "/omegahive/api/invites", {"email": "x@example.com"}), ("GET", "/omegahive/api/people", None),
                               ("POST", "/omegahive/api/budgets", {"scope": "hive", "period": "month", "limit_usd": 1})):
        r = c.request(method, path, json=body, headers=member)
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", path
    person = next(p for p in c.get("/api/people", headers=admin).json()["people"] if p["email"] == "ana@example.com")
    c.patch(f"/api/people/{person['id']}", json={"disabled": True}, headers=admin)
    assert c.get("/omegahive/api/hive", headers=member).status_code == 401
    r, _ = sign_in(c)
    assert "signin_error=not_invited" in r.headers["location"]


def test_admin_invite_rules(env):
    c, google, admin = env
    assert c.post("/api/invites", json={"email": "not-an-email"}, headers=admin).json()["error"]["code"] == "bad_email"
    assert c.post("/api/invites", json={"email": "a@b.co", "role": "god"}, headers=admin).json()["error"]["code"] == "bad_role"
    first = c.post("/api/invites", json={"email": "a@b.co"}, headers=admin).json()
    second = c.post("/api/invites", json={"email": "a@b.co"}, headers=admin).json()
    statuses = {i["id"]: i["status"] for i in c.get("/api/people", headers=admin).json()["invites"]}
    assert statuses[first["id"]] == "revoked" and statuses[second["id"]] == "pending"


def test_logout_revokes_signin_and_expires_its_cookie(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    cookie = r.cookies["hive_signin"]
    set_attrs = r.headers["set-cookie"].lower()
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie}).json()
    bearer = {"Authorization": f"Bearer {session['token']}"}
    assert c.get("/omegahive/api/auth/me", headers=bearer).status_code == 200
    out = c.post("/omegahive/api/auth/logout", headers=bearer, cookies={"hive_signin": cookie})
    assert out.status_code == 200 and out.json() == {"ok": True, "sessions_kept": 0}   # host-identity r1.1: none refused to end
    # the response expires the same cookie: same name, path, (no) domain, HttpOnly, SameSite and Secure as when set
    expire = out.headers["set-cookie"].lower()
    assert expire.startswith('hive_signin=""') or expire.startswith("hive_signin=;")
    assert "max-age=0" in expire and "expires=" in expire
    for attr in ("path=/omegahive/", "httponly", "samesite=lax", "secure"):
        assert attr in set_attrs and attr in expire, attr
    assert "domain=" not in set_attrs and "domain=" not in expire
    # server-side: the old cookie value no longer authenticates, and the bearer session is gone
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie}).status_code == 401
    assert c.get("/omegahive/api/auth/me", headers=bearer).status_code == 401
    # cookie-only sign-out (no bearer, e.g. a page that lost its token) still revokes the sign-in; repeat is harmless
    r2, _ = sign_in(c)
    cookie2 = r2.cookies["hive_signin"]
    c.cookies.clear()
    out2 = c.post("/omegahive/api/auth/logout", cookies={"hive_signin": cookie2})
    assert out2.status_code == 200 and "max-age=0" in out2.headers["set-cookie"].lower()
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie2}).status_code == 401
    assert c.post("/omegahive/api/auth/logout").status_code == 200


def _exchanges(c, cookie, n):
    bearers = []
    for _ in range(n):
        c.cookies.clear()
        bearers.append({"Authorization": f"Bearer {c.post('/omegahive/api/auth/sso', cookies={'hive_signin': cookie}).json()['token']}"})
    return bearers


def test_logout_revokes_every_bearer_exchanged_from_the_signin(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    cookie = r.cookies["hive_signin"]
    other_cookie = sign_in(c)[0].cookies["hive_signin"]      # a second, independent sign-in (another browser)
    bearers, other = _exchanges(c, cookie, 3), _exchanges(c, other_cookie, 1)[0]
    assert all(c.get("/omegahive/api/auth/me", headers=b).status_code == 200 for b in bearers + [other])
    # cookie-only sign-out: the sign-in and every bearer exchanged from it stop working
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/logout", cookies={"hive_signin": cookie}).status_code == 200
    assert [c.get("/omegahive/api/auth/me", headers=b).status_code for b in bearers] == [401, 401, 401]
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie}).status_code == 401
    # the other sign-in is untouched; bearer-only sign-out from it revokes its sign-in and siblings too
    assert c.get("/omegahive/api/auth/me", headers=other).status_code == 200
    siblings = _exchanges(c, other_cookie, 2)
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/logout", headers=other).status_code == 200
    assert [c.get("/omegahive/api/auth/me", headers=b).status_code for b in [other] + siblings] == [401, 401, 401]
    assert c.post("/omegahive/api/auth/sso", cookies={"hive_signin": other_cookie}).status_code == 401
    # bearer-plus-cookie sign-out
    third = sign_in(c)[0].cookies["hive_signin"]
    trio = _exchanges(c, third, 3)
    c.cookies.clear()
    assert c.post("/omegahive/api/auth/logout", headers=trio[0], cookies={"hive_signin": third}).status_code == 200
    assert [c.get("/omegahive/api/auth/me", headers=b).status_code for b in trio] == [401, 401, 401]
    # the admin's password session never came from a sign-in and is unaffected
    assert c.get("/api/auth/me", headers=admin).status_code == 200


def test_upgrade_ends_legacy_unlinked_signin_bearers_once(monkeypatch, capsys):
    """Bearers exchanged before sessions.signin_hash existed cannot be revoked by sign-out, so the upgrade that adds
    the column ends them (once); the password session survives and later bearers are untouched by a reopen."""
    import sqlite3
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("HIVE_GOOGLE_REDIRECT_URI", "https://hive.example/omegahive/api/auth/google/callback")
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    monkeypatch.setenv("HIVE_SSO_USERS", "")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-people-upgrade-"))

    def opened():
        settings = load_settings(data_dir=tmp, admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
        app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
        app.state.hive.people.client = httpx.AsyncClient(transport=httpx.MockTransport(FakeGoogle().handler))
        return TestClient(app, base_url="https://hive.example")

    with opened() as c:
        admin = {"Authorization": f"Bearer {c.post('/api/auth/login', json={'password': 'pw'}).json()['token']}"}
        token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
        cookie = sign_in(c, token)[0].cookies["hive_signin"]
        legacy = _exchanges(c, cookie, 2)
        assert all(c.get("/omegahive/api/auth/me", headers=b).status_code == 200 for b in legacy)
    # make it the pre-upgrade database: the sessions table without signin_hash
    conn = sqlite3.connect(tmp / "hive.db")
    conn.execute("ALTER TABLE sessions DROP COLUMN signin_hash")
    conn.commit(); conn.close()
    capsys.readouterr()
    with opened() as c:
        assert "ended 2 unlinked sign-in session(s)" in capsys.readouterr().out
        assert [c.get("/omegahive/api/auth/me", headers=b).status_code for b in legacy] == [401, 401]
        assert c.get("/api/auth/me", headers=admin).status_code == 200          # the password session survives
        fresh = _exchanges(c, cookie, 1)[0]                                       # signing in again works, linked
        assert c.get("/omegahive/api/auth/me", headers=fresh).status_code == 200
    with opened() as c:                                                           # idempotent: no second purge
        assert "unlinked sign-in session" not in capsys.readouterr().out
        assert c.get("/omegahive/api/auth/me", headers=fresh).status_code == 200
        assert c.get("/api/auth/me", headers=admin).status_code == 200
        c.cookies.clear()
        assert c.post("/omegahive/api/auth/logout", cookies={"hive_signin": cookie}).status_code == 200
        assert c.get("/omegahive/api/auth/me", headers=fresh).status_code == 401


# ---- domain allowlist (HIVE_SIGNIN_DOMAINS) -------------------------------------------------------------------------

SNET = {"email": "dee@singularitynet.io", "email_verified": True, "name": "Dee", "hd": "singularitynet.io", "sub": "g-dee"}


def _people(c, admin):
    return {p["email"]: p for p in c.get("/api/people", headers=admin).json()["people"]}


def _err(r):
    loc = r.headers["location"]
    return urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("signin_error", [None])[0]


def test_domain_member_enrols_once_as_member_with_audit(domain_env):
    c, google, admin = domain_env
    hive = c.app.state.hive
    assert hive.people.signin_domains == ("singularitynet.io",)
    start = c.get("/omegahive/api/auth/google/start", follow_redirects=False)
    assert urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["hd"] == ["singularitynet.io"]
    sent = []
    publish = hive.events.publish
    hive.events.publish = lambda kind, **kw: (sent.append((kind, kw)), publish(kind, **kw))[1]
    google.account = dict(SNET)
    r, _ = sign_in(c)
    assert r.headers["location"] == "/omegahive/" and r.cookies.get("hive_signin")
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies["hive_signin"]}).json()
    assert session["user"]["role"] == "member"
    dee = _people(c, admin)["dee@singularitynet.io"]
    assert dee["role"] == "member" and dee["invited_by"] == "domain:singularitynet.io" and dee["name"] == "Dee"
    assert dee["google_bound"] is True
    assert [k for k, kw in sent if k == "people.updated" and kw["person"]["id"] == dee["id"]] == ["people.updated"]
    from hive.core.visibility import event_rule
    assert event_rule("people.updated") == "admin"
    # never admin: the domain path cannot grant it, and a second sign-in does not re-enrol or change the role
    r, _ = sign_in(c)
    assert r.headers["location"] == "/omegahive/"
    assert _people(c, admin)["dee@singularitynet.io"]["role"] == "member"
    assert len([k for k, _ in sent if k == "people.updated"]) == 1
    # uppercase from Google is normalised (domains are case-insensitive), still exact
    google.account = {"email": "Eve@SingularityNET.IO", "email_verified": True, "hd": "SingularityNET.io"}
    google.claims = {"email": "eve@singularitynet.io"}
    r, _ = sign_in(c)
    assert r.headers["location"] == "/omegahive/"
    assert _people(c, admin)["eve@singularitynet.io"]["role"] == "member"


@pytest.mark.parametrize("account,claims", [
    ({**SNET, "email_verified": False}, {}),                                                     # unverified
    ({**SNET, "email_verified": "false"}, {}),
    ({**SNET, "email": "dee@eng.singularitynet.io", "hd": "eng.singularitynet.io"}, {}),           # subdomain
    ({**SNET, "email": "dee@eng.singularitynet.io"}, {}),
    ({**SNET, "email": "dee@singularitynet.io.evil.com", "hd": "singularitynet.io.evil.com"}, {}),  # lookalikes
    ({**SNET, "email": "dee@singularitynet.io.evil.com"}, {}),
    ({**SNET, "email": "dee@evilsingularitynet.io", "hd": "evilsingularitynet.io"}, {}),
    ({**SNET, "email": "dee@evilsingularitynet.io"}, {}),
    ({**SNET, "email": "singularitynet.io@gmail.com", "hd": "singularitynet.io"}, {}),
    ({k: v for k, v in SNET.items() if k != "hd"}, {}),                                          # no hd: not Workspace
    ({**SNET, "hd": "evil.com"}, {}),                                                            # hd mismatch
    ({**SNET, "hd": "SINGULARITYNET.IO.evil.com"}, {}),
    (SNET, {"hd": "evil.com"}),                                                                  # ID token hd mismatch
    ({k: v for k, v in SNET.items() if k != "hd"}, {"hd": None}),                                # hd nowhere
    (SNET, {"email": "other@singularitynet.io"}),                                                # token for another address
])
def test_domain_refusals(domain_env, account, claims):
    c, google, admin = domain_env
    google.account, google.claims = dict(account), dict(claims)
    r, _ = sign_in(c)
    assert _err(r) and not r.cookies.get("hive_signin")
    assert set(_people(c, admin)) == set()   # nothing created


def test_domain_for_fails_closed(domain_env):
    c, google, admin = domain_env
    people = c.app.state.hive.people
    assert people.domain_for("dee@singularitynet.io", SNET, "singularitynet.io") == "singularitynet.io"
    assert people.domain_for("dee@singularitynet.io", SNET, None) is None
    assert people.domain_for("dee@singularitynet.io", {**SNET, "email_verified": False}, "singularitynet.io") is None
    assert people.domain_for("dee@singularitynet.io", {**SNET, "email_verified": None}, "singularitynet.io") is None


def test_domain_does_not_revive_a_disabled_person(domain_env):
    c, google, admin = domain_env
    google.account = dict(SNET)
    sign_in(c)
    dee = _people(c, admin)["dee@singularitynet.io"]
    c.patch(f"/api/people/{dee['id']}", json={"disabled": True}, headers=admin)
    r, _ = sign_in(c)
    assert _err(r) == "not_invited" and not r.cookies.get("hive_signin")
    assert _people(c, admin)["dee@singularitynet.io"]["disabled"] is True


def test_invites_still_work_and_keep_their_role_with_domains(domain_env):
    c, google, admin = domain_env
    token = c.post("/api/invites", json={"email": "boss@singularitynet.io", "role": "admin"}, headers=admin).json()["link"].split("invite=")[1]
    google.account = {**SNET, "email": "boss@singularitynet.io", "sub": "g-boss"}
    r, _ = sign_in(c, token)
    assert r.headers["location"] == "/omegahive/"
    boss = _people(c, admin)["boss@singularitynet.io"]
    assert boss["role"] == "admin" and boss["invited_by"] == "user:operator"
    # an invite for one address never lets another domain address in through the invite
    token = c.post("/api/invites", json={"email": "fay@singularitynet.io"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    assert _err(r) == "wrong_account"


def test_empty_setting_is_exactly_invite_only(env):
    c, google, admin = env
    assert c.app.state.hive.people.signin_domains == ()
    start = c.get("/omegahive/api/auth/google/start", follow_redirects=False)
    assert "hd" not in urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)
    google.account = dict(SNET)
    r, _ = sign_in(c)
    assert _err(r) == "not_invited" and not r.cookies.get("hive_signin")
    assert "dee@singularitynet.io" not in _people(c, admin)


def test_signin_domains_parsing_and_hint(monkeypatch):
    from hive.core.people import signin_domains
    assert signin_domains("") == ()
    assert signin_domains(" A.io, b.org ,,a.io") == ("a.io", "b.org")
    assert signin_domains("@a.io, x@a.io, .a.io, a.io., nodot, a b.io") == ()


def test_two_domains_give_no_hint(monkeypatch):
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", "singularitynet.io,example.org")
    gen = _env(monkeypatch)
    c, google, admin = next(gen)
    try:
        start = c.get("/omegahive/api/auth/google/start", follow_redirects=False)
        assert "hd" not in urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)
        google.account = {"email": "gil@example.org", "email_verified": True, "hd": "example.org"}
        r, _ = sign_in(c)
        assert r.headers["location"] == "/omegahive/"
        assert _people(c, admin)["gil@example.org"]["invited_by"] == "domain:example.org"
    finally:
        gen.close()


# ---- identity binding to Google's sub (FIX-FIRST 1) ----------------------------------------------------------------

def _admin_env(monkeypatch, domains=""):
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", "owner@singularitynet.io")
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", domains)
    return _env(monkeypatch)


@pytest.mark.parametrize("domains", ["", "singularitynet.io"])
def test_standin_repro_consumer_account_never_gets_the_bound_admin(monkeypatch, domains):
    """The stand-in's reproduction: a consumer Google account reporting the same verified email, no hd."""
    gen = _admin_env(monkeypatch, domains)
    c, google, admin = next(gen)
    try:
        google.account = {"email": "owner@singularitynet.io", "email_verified": True, "hd": "singularitynet.io", "sub": "g-real"}
        r, _ = sign_in(c)
        assert r.headers["location"] == "/omegahive/"
        quinn = _people(c, admin)["owner@singularitynet.io"]
        assert quinn["role"] == "admin" and quinn["google_bound"] is True
        google.account = {"email": "owner@singularitynet.io", "email_verified": True, "sub": "g-consumer"}
        r, _ = sign_in(c)
        assert _err(r) == "identity_mismatch" and not r.cookies.get("hive_signin")
        # even with an hd claim, a different subject is refused: no silent rebind
        google.account = {"email": "owner@singularitynet.io", "email_verified": True, "hd": "singularitynet.io", "sub": "g-other"}
        r, _ = sign_in(c)
        assert _err(r) == "identity_mismatch"
        assert c.app.state.hive.db.one("SELECT google_sub FROM people WHERE email = 'owner@singularitynet.io'")["google_sub"] == "g-real"
    finally:
        gen.close()


def test_unbound_listed_domain_admin_needs_hd_before_first_binding(monkeypatch):
    """Trust on first use cannot be won by a consumer account for an address in a listed Workspace domain."""
    gen = _admin_env(monkeypatch, "singularitynet.io")
    c, google, admin = next(gen)
    try:
        google.account = {"email": "owner@singularitynet.io", "email_verified": True, "sub": "g-consumer"}
        r, _ = sign_in(c)
        assert _err(r) == "domain_unverified" and not r.cookies.get("hive_signin")
        assert _people(c, admin)["owner@singularitynet.io"]["google_bound"] is False
    finally:
        gen.close()


def test_existing_people_bind_on_next_signin_and_admin_can_clear(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    ana = _people(c, admin)["ana@example.com"]
    assert ana["google_bound"] is True
    # an old row with no binding (made before this column existed) binds on its next sign-in
    hive = c.app.state.hive
    hive.db.execute("UPDATE people SET google_sub = NULL WHERE id = ?", (ana["id"],))
    google.account = {**google.account, "sub": "g-ana-2"}
    r, _ = sign_in(c)
    assert r.headers["location"] == "/omegahive/"
    assert hive.db.one("SELECT google_sub FROM people WHERE id = ?", (ana["id"],))["google_sub"] == "g-ana-2"
    google.account = {**google.account, "sub": "g-ana-3"}
    r, _ = sign_in(c)
    assert _err(r) == "identity_mismatch"
    # an admin explicitly clears the binding; the next Google account binds, and old sessions are gone
    out = c.patch(f"/api/people/{ana['id']}", json={"clear_google_identity": True}, headers=admin).json()
    assert out["google_bound"] is False
    r, _ = sign_in(c)
    assert r.headers["location"] == "/omegahive/"
    assert hive.db.one("SELECT google_sub FROM people WHERE id = ?", (ana["id"],))["google_sub"] == "g-ana-3"
    # a non-boolean flag does not clear
    c.patch(f"/api/people/{ana['id']}", json={"clear_google_identity": "yes"}, headers=admin)
    assert _people(c, admin)["ana@example.com"]["google_bound"] is True


def test_domain_person_needs_hd_on_every_signin(domain_env):
    c, google, admin = domain_env
    google.account = dict(SNET)
    sign_in(c)
    google.account = {k: v for k, v in SNET.items() if k != "hd"}            # same sub, hd gone
    r, _ = sign_in(c)
    assert _err(r) == "domain_unverified" and not r.cookies.get("hive_signin")


def test_migration_adds_columns_to_an_old_people_table(monkeypatch):
    import sqlite3
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-people-old-"))
    for k, v in (("HIVE_GOOGLE_CLIENT_ID", "cid"), ("HIVE_GOOGLE_CLIENT_SECRET", "shh"), ("HIVE_SSO_USERS", ""),
                 ("HIVE_GOOGLE_REDIRECT_URI", "https://hive.example/omegahive/api/auth/google/callback")):
        monkeypatch.setenv(k, v)
    settings = load_settings(data_dir=tmp, admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    db = app.state.hive.db
    # rebuild the old shapes, then construct People again as an upgraded hive would
    db.execute("DROP TABLE people")
    db.execute("CREATE TABLE people (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', "
               "role TEXT NOT NULL, invited_by TEXT, created_at TEXT NOT NULL, last_seen_at TEXT, disabled INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO people (id, email, role, created_at) VALUES ('u_old', 'old@example.com', 'admin', 'x')")
    db.execute("DROP TABLE oauth_states")
    db.execute("CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, invite_id TEXT, created_at REAL NOT NULL)")
    from hive.core.people import People
    People(app.state.hive, None)
    assert {r["name"] for r in db.all("PRAGMA table_info(people)")} >= {"google_sub"}
    assert {r["name"] for r in db.all("PRAGMA table_info(oauth_states)")} >= {"browser_hash"}
    assert db.one("SELECT google_sub FROM people WHERE id = 'u_old'")["google_sub"] is None


# ---- login CSRF: state bound to the starting browser (FIX-FIRST 2) -------------------------------------------------

def test_callback_in_another_browser_is_refused_before_the_code_exchange(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    start = c.get(f"/omegahive/api/auth/google/start?invite={token}", follow_redirects=False)
    set_cookie = start.headers["set-cookie"].lower()
    assert "hive_oauth=" in set_cookie and "httponly" in set_cookie and "samesite=lax" in set_cookie
    assert "secure" in set_cookie and "path=/omegahive/" in set_cookie
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["state"][0]
    # the attacker's unused callback URL, opened by a victim browser that never started a sign-in
    with TestClient(c.app, base_url="https://hive.example") as victim:
        r = victim.get(f"/omegahive/api/auth/google/callback?code=good-code&state={state}", follow_redirects=False)
    assert _err(r) == "state_mismatch" and not r.cookies.get("hive_signin")
    assert google.exchanges == 0
    # a wrong cookie value is refused the same way
    start = c.get("/omegahive/api/auth/google/start", follow_redirects=False)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start.headers["location"]).query)["state"][0]
    c.cookies.set("hive_oauth", "forged", domain="hive.example", path="/omegahive/")
    r = c.get(f"/omegahive/api/auth/google/callback?code=good-code&state={state}", follow_redirects=False)
    assert _err(r) == "state_mismatch" and google.exchanges == 0


def test_browser_binding_cookie_is_cleared_after_use(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    r, _ = sign_in(c, token)
    assert r.headers["location"] == "/omegahive/"
    cleared = [h for h in r.headers.get_list("set-cookie") if h.lower().startswith("hive_oauth=")]
    assert cleared and ("max-age=0" in cleared[0].lower() or "expires=" in cleared[0].lower())
    r, _ = sign_in(c, code="bad")
    assert any(h.lower().startswith("hive_oauth=") for h in r.headers.get_list("set-cookie"))


# ---- ID token checks (FIX-FIRST 4) ---------------------------------------------------------------------------------

@pytest.mark.parametrize("claims", [
    {"iss": "https://evil.example"}, {"iss": None}, {"aud": "someone-else"}, {"aud": ["other", "cid"]},
    {"aud": None}, {"exp": 1}, {"exp": None}, {"exp": "9999999999"}, {"sub": "g-someone-else"}, {"sub": None},
    {"email": "mallory@example.com"}, {"email": None},
])
def test_id_token_claims_are_checked(env, claims):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    google.claims = claims
    r, _ = sign_in(c, token)
    assert _err(r) == "bad_id_token" and not r.cookies.get("hive_signin")
    assert "ana@example.com" not in _people(c, admin)


def test_id_token_required_and_valid_shapes_pass(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    google.no_id_token = True
    r, _ = sign_in(c, token)
    assert _err(r) == "bad_id_token"
    google.no_id_token = False
    google.claims = {"iss": "accounts.google.com", "aud": ["cid", "other"], "azp": "cid"}
    r, _ = sign_in(c, token)
    assert r.headers["location"] == "/omegahive/"


# ---- webhost sign-in and the offered sign-in (FIX-FIRST 3) ----------------------------------------------------------

def _webhost(monkeypatch, tmp, email):
    """A companion webhost session file pair whose user has linked this Google email."""
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / "sessions.json").write_text(json.dumps({"fam-tok": {"username": "dee", "expires": int(time.time()) + 3600}}))
    (tmp / "users.json").write_text(json.dumps({"dee": {"name": "Dee", "google_email": email, "google_linked_at": 1}}))
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(tmp))
    monkeypatch.setenv("HIVE_SSO_USERS", "someone-else")


def test_webhost_signin_refuses_domain_people_and_google_is_offered(monkeypatch):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "dee@singularitynet.io")
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", "singularitynet.io")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        methods = c.get("/omegahive/api/auth/methods").json()
        assert methods["sso"]["login_url"] == "/omegahive/api/auth/google/start"
        google.account = dict(SNET)
        sign_in(c)
        assert _people(c, admin)["dee@singularitynet.io"]["invited_by"] == "domain:singularitynet.io"
        c.cookies.clear()
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "google_signin_required"
        # a live invitation for a listed-domain address is not consumed through the webhost path either
        hive = c.app.state.hive
        hive.db.execute("DELETE FROM people WHERE email = 'dee@singularitynet.io'")
        c.post("/api/invites", json={"email": "dee@singularitynet.io"}, headers=admin)
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 403
        assert [i["status"] for i in c.get("/api/people", headers=admin).json()["invites"]] == ["pending"]
    finally:
        gen.close()


def test_webhost_signin_unchanged_without_domains(monkeypatch):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "ana@example.com")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        # the hive's own Google flow is offered whenever it is set up (bound people can only use it); a webhost session
        # already in the browser is still exchanged by POST /api/auth/sso
        methods = c.get("/omegahive/api/auth/methods").json()
        assert methods["sso"]["login_url"] == "/omegahive/api/auth/google/start"
        c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin)
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 200 and r.json()["user"]["email"] == "ana@example.com"
    finally:
        gen.close()


# ---- round 3: webhost path vs Google binding, azp/exp, atomic binding, every outcome clears (f947b22 FIX-FIRST) -----

@pytest.mark.parametrize("allowed", [False, True])
def test_standin_repro_webhost_path_refuses_a_bound_admin_outside_the_allowlist(monkeypatch, allowed):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "quinn@example.com")
    if allowed:
        monkeypatch.setenv("HIVE_SSO_USERS", "dee")      # the webhost user is a listed webhost admin
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", "quinn@example.com")
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", "singularitynet.io")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        assert c.app.state.hive.people.required_domain("quinn@example.com") is None   # outside the allowlist
        google.account = {"email": "quinn@example.com", "email_verified": True, "sub": "g-quinn"}
        r, _ = sign_in(c)
        assert r.headers["location"] == "/omegahive/"
        assert _people(c, admin)["quinn@example.com"]["google_bound"] is True
        hive = c.app.state.hive
        before = hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"]
        c.cookies.clear()
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "google_signin_required"
        assert r.json()["error"]["login_url"] == "/omegahive/api/auth/google/start"
        assert hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"] == before   # no session of any kind issued
    finally:
        gen.close()


@pytest.mark.parametrize("claims", [
    {"azp": "other-client"}, {"aud": ["cid"], "azp": "other-client"}, {"aud": ["cid", "other"]},
    {"exp": float("nan")}, {"exp": float("inf")}, {"exp": float("-inf")}, {"exp": True}, {"exp": "9999999999"},
])
def test_id_token_azp_and_exp_edges(env, claims):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    google.claims = claims
    r, _ = sign_in(c, token)
    assert _err(r) == "bad_id_token" and "ana@example.com" not in _people(c, admin)


def test_id_token_matching_azp_passes(env):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    google.claims = {"azp": "cid", "aud": ["cid"]}
    r, _ = sign_in(c, token)
    assert r.headers["location"] == "/omegahive/"


def _disabled_unbound_with_invite(c, admin):
    """ana: an existing, disabled, unbound person with a live re-invitation."""
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    sign_in(c, token)
    hive = c.app.state.hive
    ana = _people(c, admin)["ana@example.com"]
    c.patch(f"/api/people/{ana['id']}", json={"disabled": True}, headers=admin)
    hive.db.execute("UPDATE people SET google_sub = NULL WHERE id = ?", (ana["id"],))
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    return hive, ana["id"], token


def _latest_invite(c, admin):
    return c.get("/api/people", headers=admin).json()["invites"][0]["status"]   # newest first


def test_losing_a_binding_race_changes_nothing(env):
    """Subject B binds while A's callback is talking to Google: A is refused and consumed no invitation, restored no one."""
    c, google, admin = env
    hive, ana_id, token = _disabled_unbound_with_invite(c, admin)
    google.account = {**google.account, "sub": "g-A"}
    google.on_userinfo = lambda: hive.db.execute("UPDATE people SET google_sub = 'g-B' WHERE id = ? AND google_sub IS NULL", (ana_id,))
    r, _ = sign_in(c, token)
    assert _err(r) == "identity_mismatch" and not r.cookies.get("hive_signin")
    row = hive.db.one("SELECT * FROM people WHERE id = ?", (ana_id,))
    assert row["google_sub"] == "g-B" and row["disabled"] == 1
    assert _latest_invite(c, admin) == "pending"


def test_binding_decision_and_writes_are_one_transaction(env):
    """Controlled interleaving: B's conditional bind is fired from another thread right after A's callback has read the
    person row, and given time to run. It cannot land between A's read and A's writes; afterwards it is a no-op."""
    c, google, admin = env
    hive, ana_id, token = _disabled_unbound_with_invite(c, admin)
    google.account = {**google.account, "sub": "g-A"}
    original = hive.db.one
    fired, other = [], []

    def b_binds():
        hive.db.execute("UPDATE people SET google_sub = 'g-B' WHERE id = ? AND google_sub IS NULL", (ana_id,))

    def one(sql, params=()):
        row = original(sql, params)
        if not fired and sql.startswith("SELECT * FROM people WHERE email = ?"):
            fired.append(True)
            t = threading.Thread(target=b_binds)
            t.start()
            other.append(t)
            t.join(0.3)               # B gets every chance to run here
            other.append(t.is_alive())  # True: B is held off while A decides and writes
        return row

    hive.db.one = one
    try:
        r, _ = sign_in(c, token)
    finally:
        hive.db.one = original
    other[0].join(5)
    assert fired and other[1] is True and not other[0].is_alive()
    row = hive.db.one("SELECT * FROM people WHERE id = ?", (ana_id,))
    assert not _err(r) and row["google_sub"] == "g-A" and row["disabled"] == 0 and _latest_invite(c, admin) == "accepted"


@pytest.mark.parametrize("fail", ["connect", "token_json", "token_list", "userinfo_json", "userinfo_timeout"])
def test_google_endpoint_failures_are_stable_and_clear_the_cookie(env, fail):
    c, google, admin = env
    google.fail = fail
    r, _ = sign_in(c)
    assert r.status_code == 303 and _err(r) == "google_unavailable"
    assert any(h.lower().startswith("hive_oauth=") for h in r.headers.get_list("set-cookie"))
    assert not r.cookies.get("hive_signin")


def test_unexpected_callback_errors_still_clear_the_cookie(env):
    c, google, admin = env

    async def boom(*a, **k):
        raise RuntimeError("unexpected")

    c.app.state.hive.people.callback = boom
    r, _ = sign_in(c)
    assert r.status_code == 303 and _err(r) == "signin_failed"
    assert any(h.lower().startswith("hive_oauth=") for h in r.headers.get_list("set-cookie"))


# ---- round 4: the webhost path decides before it writes (049a9ff FIX-FIRST) ----------------------------------------

@pytest.mark.parametrize("allowed", [False, True])
def test_webhost_path_refuses_a_disabled_bound_admin_without_restoring_or_consuming(monkeypatch, allowed):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "quinn@example.com")
    if allowed:
        monkeypatch.setenv("HIVE_SSO_USERS", "dee")
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", "quinn@example.com")
    monkeypatch.setenv("HIVE_SIGNIN_DOMAINS", "singularitynet.io")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        hive = c.app.state.hive
        assert hive.people.required_domain("quinn@example.com") is None              # outside the allowlist
        google.account = {"email": "quinn@example.com", "email_verified": True, "sub": "g-quinn"}
        assert sign_in(c)[0].headers["location"] == "/omegahive/"
        quinn = _people(c, admin)["quinn@example.com"]
        assert quinn["role"] == "admin" and quinn["google_bound"] is True
        c.patch(f"/api/people/{quinn['id']}", json={"disabled": True}, headers=admin)
        c.post("/api/invites", json={"email": "quinn@example.com", "role": "admin"}, headers=admin)
        sessions = hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"]
        c.cookies.clear()
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "google_signin_required"
        assert r.json()["error"]["login_url"] == "/omegahive/api/auth/google/start"
        row = hive.db.one("SELECT * FROM people WHERE id = ?", (quinn["id"],))
        assert row["disabled"] == 1 and row["google_sub"] == "g-quinn"
        assert c.get("/api/people", headers=admin).json()["invites"][0]["status"] == "pending"
        assert hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"] == sessions
    finally:
        gen.close()


def test_webhost_path_still_restores_an_unbound_disabled_person_by_invitation(monkeypatch):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "ana@example.com")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        hive = c.app.state.hive
        c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin)
        assert c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"}).status_code == 200
        ana = _people(c, admin)["ana@example.com"]
        assert ana["google_bound"] is False
        c.patch(f"/api/people/{ana['id']}", json={"disabled": True}, headers=admin)
        assert c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"}).status_code == 403
        c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin)
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 200 and r.json()["user"]["email"] == "ana@example.com"
        assert hive.db.one("SELECT disabled FROM people WHERE id = ?", (ana["id"],))["disabled"] == 0
    finally:
        gen.close()


def test_webhost_decision_rolls_back_with_its_session(monkeypatch):
    """If the session cannot be written, the invitation the webhost path accepted is not consumed either."""
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "ana@example.com")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        hive = c.app.state.hive
        c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin)
        original = hive.db.insert

        def insert(table, values):
            if table == "sessions" and str(values.get("principal", "")).startswith("user:u_"):
                raise RuntimeError("disk full")
            return original(table, values)

        hive.db.insert = insert
        try:
            with TestClient(c.app, base_url="https://hive.example", raise_server_exceptions=False) as other:
                assert other.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"}).status_code == 500
        finally:
            hive.db.insert = original
        assert "ana@example.com" not in _people(c, admin)
        assert c.get("/api/people", headers=admin).json()["invites"][0]["status"] == "pending"
    finally:
        gen.close()


# ---- HIVE_ADMIN_EMAILS: a listed email is always an admin (upgrade, never downgrade, never re-enable) --------------

def _reload_people(c, monkeypatch, listed):
    """Construct People again with HIVE_ADMIN_EMAILS = listed, as a restarted hive would on the same database."""
    from hive.core.people import People
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", listed)
    return People(c.app.state.hive, None)


def _row(c, email):
    return c.app.state.hive.db.one("SELECT * FROM people WHERE email = ?", (email,))


def test_admin_emails_upgrade_a_domain_member_at_startup_with_audit(domain_env, monkeypatch, caplog):
    """The cloud lockout: Quinn's SNET address came in by the domain allowlist as a member, then was listed."""
    c, google, admin = domain_env
    google.account = dict(SNET)
    assert sign_in(c)[0].headers["location"] == "/omegahive/"
    assert _row(c, "dee@singularitynet.io")["role"] == "member"
    with caplog.at_level("WARNING", logger="hive"):
        _reload_people(c, monkeypatch, " DEE@SingularityNET.io ,, ")   # case and whitespace, empty entries
    row = _row(c, "dee@singularitynet.io")
    assert row["role"] == "admin" and row["disabled"] == 0
    assert row["invited_by"] == "domain:singularitynet.io"              # origin kept: the Workspace check still holds
    assert row["promoted_by"] == "config:HIVE_ADMIN_EMAILS" and row["promoted_at"]
    assert any("promoted" in r.getMessage() and row["id"] in r.getMessage() and "startup" in r.getMessage()
               for r in caplog.records)
    view = _people(c, admin)["dee@singularitynet.io"]
    assert view["role"] == "admin" and view["promoted_by"] == "config:HIVE_ADMIN_EMAILS"
    assert c.app.state.hive.db.one("SELECT COUNT(*) AS n FROM people WHERE email = 'dee@singularitynet.io'")["n"] == 1


def test_admin_emails_upgrade_at_signin_and_publish(monkeypatch, caplog):
    gen = _admin_env(monkeypatch)
    c, google, admin = next(gen)
    try:
        google.account = {"email": "owner@singularitynet.io", "email_verified": True, "sub": "g-quinn"}
        assert sign_in(c)[0].headers["location"] == "/omegahive/"
        quinn = _people(c, admin)["owner@singularitynet.io"]
        assert quinn["role"] == "admin" and quinn["promoted_by"] is None    # created as admin: no upgrade happened
        c.patch(f"/api/people/{quinn['id']}", json={"role": "member"}, headers=admin)
        assert _row(c, "owner@singularitynet.io")["role"] == "member"
        published = []
        events = c.app.state.hive.events
        original = events.publish
        events.publish = lambda kind, **payload: (published.append((kind, payload)), original(kind, **payload))
        try:
            with caplog.at_level("WARNING", logger="hive"):
                r, _ = sign_in(c)
        finally:
            events.publish = original
        assert r.headers["location"] == "/omegahive/"
        row = _row(c, "owner@singularitynet.io")
        assert row["role"] == "admin" and row["promoted_by"] == "config:HIVE_ADMIN_EMAILS" and row["promoted_at"]
        assert any("promoted" in m.getMessage() and "signin" in m.getMessage() for m in caplog.records)
        notices = [p for k, p in published if k == "people.updated" and p.get("change") == "promoted"]
        assert len(notices) == 1 and notices[0]["via"] == "config" and notices[0]["previous_role"] == "member"
        assert notices[0]["trigger"] == "signin" and notices[0]["person"]["role"] == "admin"
        # already an admin: the next sign-in changes nothing and announces nothing
        stamp = row["promoted_at"]
        published.clear()
        events.publish = lambda kind, **payload: published.append((kind, payload))
        try:
            sign_in(c)
        finally:
            events.publish = original
        assert not [p for k, p in published if p.get("change") == "promoted"]
        assert _row(c, "owner@singularitynet.io")["promoted_at"] == stamp
    finally:
        gen.close()


def test_admin_emails_upgrade_on_the_webhost_path(monkeypatch):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-webhost-"))
    _webhost(monkeypatch, tmp, "quinn@example.com")
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", "quinn@example.com")
    gen = _env(monkeypatch, webhost=True)
    c, google, admin = next(gen)
    try:
        quinn = _row(c, "quinn@example.com")
        c.patch(f"/api/people/{quinn['id']}", json={"role": "member"}, headers=admin)
        r = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"})
        assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
        assert _row(c, "quinn@example.com")["promoted_by"] == "config:HIVE_ADMIN_EMAILS"
    finally:
        gen.close()


def test_admin_emails_never_downgrade_and_leave_unlisted_rows_alone(env, monkeypatch):
    c, google, admin = env
    token = c.post("/api/invites", json={"email": "ana@example.com"}, headers=admin).json()["link"].split("invite=")[1]
    sign_in(c, token)
    hive = c.app.state.hive
    hive.db.insert("people", {"id": "u_boss", "email": "boss@example.com", "name": "", "role": "admin",
                              "invited_by": "user:operator", "created_at": "2026-10-07T00:00:00Z"})
    before = {e: dict(_row(c, e)) for e in ("boss@example.com", "ana@example.com")}
    _reload_people(c, monkeypatch, "someone-else@example.com, ana@example.co")   # not an exact match for ana
    for email, row in before.items():
        assert dict(_row(c, email)) == row                       # unlisted: untouched, admin not downgraded
    assert _row(c, "ana@example.com")["role"] == "member"
    # a listed admin stays an admin, with no promotion stamp
    _reload_people(c, monkeypatch, "boss@example.com")
    assert dict(_row(c, "boss@example.com")) == before["boss@example.com"]
    # and an unlisted member signing in stays a member
    sign_in(c)
    assert _row(c, "ana@example.com")["role"] == "member" and _row(c, "ana@example.com")["promoted_by"] is None


def test_admin_emails_never_enable_a_disabled_row(domain_env, monkeypatch):
    c, google, admin = domain_env
    google.account = dict(SNET)
    sign_in(c)
    dee = _row(c, "dee@singularitynet.io")
    c.patch(f"/api/people/{dee['id']}", json={"disabled": True}, headers=admin)
    people = _reload_people(c, monkeypatch, "dee@singularitynet.io")
    row = _row(c, "dee@singularitynet.io")
    assert row["disabled"] == 1 and row["role"] == "member" and row["promoted_by"] is None
    # the running app's People sees the list too: the sign-in is still refused and changes nothing
    c.app.state.hive.people.admin_emails = people.admin_emails
    r, _ = sign_in(c)
    assert _err(r) == "not_invited" and not r.cookies.get("hive_signin")
    row = _row(c, "dee@singularitynet.io")
    assert row["disabled"] == 1 and row["role"] == "member" and row["promoted_by"] is None
