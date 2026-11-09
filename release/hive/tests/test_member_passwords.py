"""T-101: members sign in with a password the hive makes, until Google sign-in is on.

An admin adds a member by email; the hive makes the password and shows it once. The member signs in with email +
password as that person (never admin, never user:operator). Admins reset or remove it. From outside it works only
while Google is not configured and HIVE_PUBLIC_PASSWORD=1 (the two states .github-private#64 deploys); once Google is
on, the same email continues with Google as the same person row. Wrong guesses from outside wait per account.
"""

import logging
import math
import os
import pathlib
import re
import subprocess
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient
from xkcdpass import xkcd_password

from hive.core import people as people_module
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.sso import AccountAttempts
from hive.tests.test_people_api import FakeGoogle, FakeSupervisor, sign_in

import httpx

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

OUT = "/omegahive"   # a request under the base path is from outside (PublicGate)
GOOGLE = {"HIVE_GOOGLE_CLIENT_ID": "cid", "HIVE_GOOGLE_CLIENT_SECRET": "shh",
          "HIVE_GOOGLE_REDIRECT_URI": "https://hive.example/omegahive/api/auth/google/callback"}


def make_app(monkeypatch, data=None, google=False, public=True, clock=None):
    """A hive under /omegahive in one of the states #64 deploys: Google off + HIVE_PUBLIC_PASSWORD=1 (default), or
    Google on without it. ``data`` reuses a data directory, as a redeploy does."""
    for k, v in GOOGLE.items():
        monkeypatch.setenv(k, v) if google else monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HIVE_PUBLIC_PASSWORD", "1") if public else monkeypatch.delenv("HIVE_PUBLIC_PASSWORD", raising=False)
    monkeypatch.setenv("HIVE_SSO_USERS", "")
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    data = data or tempfile.mkdtemp(prefix="hive-member-pw-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    app.state.data_dir = data
    if clock is not None:
        app.state.member_attempts.clock = lambda: clock[0]
    return app


@pytest.fixture()
def hive(monkeypatch):
    with TestClient(make_app(monkeypatch), base_url="https://hive.example") as c:
        yield c, admin_headers(c)


def admin_headers(c):
    return {"Authorization": f"Bearer {c.post('/api/auth/login', json={'password': 'pw'}).json()['token']}"}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def add(c, admin, email="ann@x.org", **extra):
    r = c.post("/api/people/members", json={"email": email} | extra, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()


def login(c, email, password, outside=False):
    return c.post((OUT if outside else "") + "/api/auth/login", json={"email": email, "password": password})


def assert_three_words(password):
    """T-108: three words from the hive's list, joined by two dashes."""
    words = password.split("-")
    assert len(words) == 3 and all(w in people_module.PASSWORD_WORDS for w in words), password


# ---- 1. admin adds a member; the password is shown once; stored as a slow salted hash ----------------------------

def test_admin_adds_a_member_and_gets_the_password_once(hive):
    """1.1, 1.6"""
    c, admin = hive
    made = add(c, admin, name="Ann")
    assert made["person"]["email"] == "ann@x.org" and made["person"]["role"] == "member"
    assert made["person"]["password_set"] is True and "shown once" in made["note"].lower()
    assert_three_words(made["password"])
    member = bearer(login(c, "ann@x.org", made["password"]).json()["token"])
    assert c.post("/api/people/members", json={"email": "bo@x.org"}, headers=member).status_code == 403
    assert c.post("/api/people/members", json={"email": "bo@x.org"}).status_code == 401


def test_two_adds_make_different_passwords(hive):
    """1.6: the hive makes the password (secrets); an admin cannot choose it."""
    c, admin = hive
    a = add(c, admin, "a@x.org", password="chosen")["password"]
    b = add(c, admin, "b@x.org")["password"]
    assert a != b and "chosen" not in (a, b)


def test_the_password_appears_nowhere_after_it_is_shown(hive):
    """1.3: people list, one person, invitations, people.* events, /api/auth/me, /api/settings."""
    c, admin = hive
    events = []
    bus = c.app.state.hive.events
    original = bus.publish
    bus.publish = lambda kind, **kw: (events.append((kind, kw)), original(kind, **kw))[1]
    made = add(c, admin)
    pid, pw = made["person"]["id"], made["password"]
    reset = c.post(f"/api/people/{pid}/password", headers=admin).json()["password"]
    member = bearer(login(c, "ann@x.org", reset).json()["token"])
    seen = [c.get("/api/people", headers=admin).text, c.get(f"/api/people/{pid}", headers=admin).text,
            c.get("/api/auth/me", headers=member).text, c.get("/api/settings", headers=admin).text, repr(events)]
    assert any(kind.startswith("people.") for kind, _ in events)
    for text in seen:
        assert pw not in text and reset not in text


def test_adding_and_resetting_log_no_password(hive, caplog):
    """1.4"""
    c, admin = hive
    with caplog.at_level(logging.DEBUG):
        made = add(c, admin)
        reset = c.post(f"/api/people/{made['person']['id']}/password", headers=admin).json()["password"]
        login(c, "ann@x.org", "wrong", outside=True)
        login(c, "ann@x.org", reset, outside=True)
    for record in caplog.records:
        text = record.getMessage() + repr(record.args)
        assert made["password"] not in text and reset not in text


def test_the_store_holds_a_salted_scrypt_hash_not_the_password(hive):
    """1.5: no plaintext in the row or the database files; scrypt with a per-member salt."""
    c, admin = hive
    first = add(c, admin, "a@x.org")
    second = add(c, admin, "b@x.org")
    db = c.app.state.hive.db
    rows = {r["email"]: r["password_hash"] for r in db.all("SELECT email, password_hash FROM people")}
    assert rows["a@x.org"].startswith("scrypt$") and first["password"] not in rows["a@x.org"]
    people = c.app.state.hive.people
    same = [people.password_hash("same-password") for _ in range(2)]
    assert same[0] != same[1] and all(people.password_matches(h, "same-password") for h in same)
    for f in pathlib.Path(c.app.state.data_dir).rglob("*"):
        if f.is_file():
            raw = f.read_bytes()
            assert first["password"].encode() not in raw and second["password"].encode() not in raw


def test_adding_an_email_that_already_has_a_person_is_refused(hive):
    """1.7: refused with 409; the admin resets the existing person's password instead."""
    c, admin = hive
    add(c, admin, "ann@x.org")
    again = c.post("/api/people/members", json={"email": " ANN@x.org"}, headers=admin)
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_member"
    assert len(c.app.state.hive.db.all("SELECT id FROM people WHERE email = 'ann@x.org'")) == 1


# ---- 2. member sign-in -------------------------------------------------------------------------------------------

@pytest.mark.parametrize("outside", [False, True])
def test_a_member_signs_in_as_that_person_never_admin(hive, outside):
    """2.1, 2.2 (trap T1, locally and from outside), 2.3"""
    c, admin = hive
    made = add(c, admin)
    pre = OUT if outside else ""
    token = login(c, "ann@x.org", made["password"], outside=outside).json()["token"]
    me = c.get(pre + "/api/auth/me", headers=bearer(token)).json()
    assert me["principal"] == f"user:{made['person']['id']}" and me["role"] == "member"
    assert me["person"]["email"] == "ann@x.org" and me["person_kind"] == "person" and me["local_operator"] is False
    assert c.get(pre + "/api/people", headers=bearer(token)).status_code == 403
    assert c.post(pre + "/api/settings/password/rotate", headers=bearer(token)).status_code == 403
    assert c.get("/api/auth/me", headers=admin).json()["principal"] == "user:operator"


def test_a_member_promoted_to_admin_stays_a_member_on_a_password_session(hive):
    """2.2: a password session is never admin; an admin signs in with Google or the operator password."""
    c, admin = hive
    made = add(c, admin)
    c.patch(f"/api/people/{made['person']['id']}", json={"role": "admin"}, headers=admin)
    token = login(c, "ann@x.org", made["password"]).json()["token"]
    assert c.get("/api/auth/me", headers=bearer(token)).json()["role"] == "member"
    assert c.get("/api/people", headers=bearer(token)).status_code == 403


def test_every_failed_member_login_answers_the_same_401(hive):
    """2.4: wrong password, unknown email, removed and disabled member: same status, byte-identical body."""
    c, admin = hive
    add(c, admin, "ann@x.org")
    removed = add(c, admin, "rem@x.org")
    disabled = add(c, admin, "dis@x.org")
    c.delete(f"/api/people/{removed['person']['id']}/password", headers=admin)
    c.patch(f"/api/people/{disabled['person']['id']}", json={"disabled": True}, headers=admin)
    answers = [login(c, "ann@x.org", "wrong"), login(c, "nobody@x.org", "wrong"),
               login(c, "rem@x.org", removed["password"]), login(c, "dis@x.org", disabled["password"])]
    assert {r.status_code for r in answers} == {401}
    assert len({r.content for r in answers}) == 1


@pytest.mark.parametrize("outside", [False, True])
def test_a_non_ascii_member_password_is_a_401_never_a_500(hive, outside):
    """Lead a558fa24 (fit with #27, which fixes the operator's non-ASCII 500): the compare is on scrypt bytes, so a
    non-ASCII or unencodable password, or a non-ASCII email, is the plain 401 from inside and outside."""
    c, admin = hive
    # one member per case: from outside, a second wrong try on one account would wait (2.x), not reach the check
    for i, (password, email_of) in enumerate([("pässwörd-ü", None), ("密码🔑", None), ("lone-surrogate", None),
                                               (None, lambda e: "ä" + e), (None, None)]):
        email = f"m{i}@x.org"
        made = add(c, admin, email)
        typed = password if password is not None else made["password"] + ("é" if email_of is None else "")
        if typed == "lone-surrogate":   # JSON may carry an unpaired \ud800 that no UTF-8 encoder accepts
            r = c.post((OUT if outside else "") + "/api/auth/login", headers={"Content-Type": "application/json"},
                       content=('{"email": "%s", "password": "\\ud800x"}' % email).encode())
        else:
            r = login(c, email_of(email) if email_of else email, typed, outside=outside)
        assert r.status_code == 401, (i, r.status_code, r.text)
        assert r.json()["error"]["code"] == "unauthorized"
    fresh = add(c, admin, "ok@x.org")
    assert login(c, "ok@x.org", fresh["password"], outside=outside).status_code == 200


def test_an_unknown_email_still_runs_a_hash_check(hive, monkeypatch):
    """2.5: the unknown-email path checks a dummy hash, so it costs what a wrong password costs."""
    c, _ = hive
    people = c.app.state.hive.people
    checked = []
    original = people.password_matches
    monkeypatch.setattr(people, "password_matches", lambda h, p: (checked.append(h), original(h, p))[1])
    assert login(c, "nobody@x.org", "wrong").status_code == 401
    assert checked and checked[0].startswith("scrypt$")


def test_email_is_matched_as_people_matches_it(hive):
    """2.6"""
    c, admin = hive
    made = add(c, admin, "ann@x.org")
    token = login(c, " Ann@X.org", made["password"]).json()["token"]
    assert c.get("/api/auth/me", headers=bearer(token)).json()["person"]["email"] == "ann@x.org"


def test_the_operator_password_login_is_unchanged(hive):
    """2.3: no email -> the operator password, as before."""
    c, _ = hive
    assert c.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    assert c.post("/api/auth/login", json={"email": "", "password": "pw"}).status_code == 200


# ---- 3. reset and remove ------------------------------------------------------------------------------------------

def test_reset_shows_a_new_password_once_and_ends_only_that_members_password_sessions(hive):
    """3.1, 3.2"""
    c, admin = hive
    ann = add(c, admin, "ann@x.org")
    bo = add(c, admin, "bo@x.org")
    ann_old = bearer(login(c, "ann@x.org", ann["password"]).json()["token"])
    bo_token = bearer(login(c, "bo@x.org", bo["password"]).json()["token"])
    reset = c.post(f"/api/people/{ann['person']['id']}/password", headers=admin)
    assert reset.status_code == 200 and reset.json()["ended_sessions"] == 1
    new = reset.json()["password"]
    assert new != ann["password"] and "shown once" in reset.json()["note"].lower()
    assert c.get("/api/auth/me", headers=ann_old).status_code == 401
    assert login(c, "ann@x.org", ann["password"]).content == login(c, "nobody@x.org", "x").content
    assert login(c, "ann@x.org", new).status_code == 200
    assert c.get("/api/auth/me", headers=bo_token).status_code == 200
    assert c.get("/api/auth/me", headers=admin).status_code == 200


def test_reset_keeps_the_members_google_sessions(monkeypatch):
    """3.2: a reset ends password sessions only; a Google session of the same person stays."""
    with TestClient(make_app(monkeypatch, google=True, public=False), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        google = FakeGoogle()
        google.account = {"email": "ann@x.org", "email_verified": True, "name": "Ann"}
        c.app.state.hive.people.client = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
        made = add(c, admin, "ann@x.org")
        response, _ = sign_in(c)
        token = c.post(OUT + "/api/auth/sso", cookies={"hive_signin": response.cookies["hive_signin"]}).json()["token"]
        c.post(f"/api/people/{made['person']['id']}/password", headers=admin)
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 200


def test_removing_the_password_ends_its_sessions_and_its_login(hive):
    """3.3: DELETE drops the hash and ends the member's password sessions; disabling ends every session and drops
    the hash too."""
    c, admin = hive
    ann = add(c, admin, "ann@x.org")
    bo = add(c, admin, "bo@x.org")
    ann_token = bearer(login(c, "ann@x.org", ann["password"]).json()["token"])
    bo_token = bearer(login(c, "bo@x.org", bo["password"]).json()["token"])
    gone = c.delete(f"/api/people/{ann['person']['id']}/password", headers=admin)
    assert gone.status_code == 200 and gone.json()["person"]["password_set"] is False
    assert c.get("/api/auth/me", headers=ann_token).status_code == 401
    assert login(c, "ann@x.org", ann["password"]).status_code == 401
    c.patch(f"/api/people/{bo['person']['id']}", json={"disabled": True}, headers=admin)
    assert c.get("/api/auth/me", headers=bo_token).status_code == 401
    row = c.app.state.hive.db.one("SELECT password_hash FROM people WHERE id = ?", (bo["person"]["id"],))
    assert row["password_hash"] is None
    c.patch(f"/api/people/{bo['person']['id']}", json={"disabled": False}, headers=admin)
    assert login(c, "bo@x.org", bo["password"]).status_code == 401


def test_only_admins_reset_or_remove_and_not_their_own_access(hive):
    """3.4"""
    c, admin = hive
    ann = add(c, admin, "ann@x.org")
    member = bearer(login(c, "ann@x.org", ann["password"]).json()["token"])
    pid = ann["person"]["id"]
    assert c.post(f"/api/people/{pid}/password", headers=member).status_code == 403
    assert c.delete(f"/api/people/{pid}/password", headers=member).status_code == 403
    assert c.post("/api/people/u_nobody/password", headers=admin).status_code == 404


def test_a_password_is_for_members_only(hive):
    """An admin person signs in with Google or the operator password; reset refuses an admin row."""
    c, admin = hive
    ann = add(c, admin, "ann@x.org")
    c.patch(f"/api/people/{ann['person']['id']}", json={"role": "admin"}, headers=admin)
    r = c.post(f"/api/people/{ann['person']['id']}/password", headers=admin)
    assert r.status_code == 400 and r.json()["error"]["code"] == "member_only"


def test_rotating_the_operator_password_keeps_member_sessions(hive):
    """3.5 (trap T3)"""
    c, admin = hive
    ann = add(c, admin)
    member = bearer(login(c, "ann@x.org", ann["password"]).json()["token"])
    assert c.post("/api/settings/password/rotate", headers=admin).status_code == 200
    assert c.get("/api/auth/me", headers=member).status_code == 200


# ---- 4. Google on: outside member password login refused; the same email continues with Google -----------------

def test_google_off_and_public_password_member_works_from_outside(hive):
    """4.1 (trap T2): the outside session counts on later outside requests."""
    c, admin = hive
    ann = add(c, admin)
    token = login(c, "ann@x.org", ann["password"], outside=True).json()["token"]
    assert c.get(OUT + "/api/auth/me", headers=bearer(token)).json()["role"] == "member"


def test_google_on_refuses_outside_member_login_like_the_operators(monkeypatch):
    """4.2: 403 password_login_local_only, byte-identical for the operator, a real member and an unknown email."""
    with TestClient(make_app(monkeypatch, google=True, public=False), base_url="https://hive.example") as c:
        ann = add(c, admin_headers(c))
        answers = [c.post(OUT + "/api/auth/login", json={"password": "pw"}),
                   login(c, "ann@x.org", ann["password"], outside=True), login(c, "nobody@x.org", "x", outside=True)]
        assert {r.status_code for r in answers} == {403}
        assert len({r.content for r in answers}) == 1
        assert answers[0].json()["error"]["code"] == "password_login_local_only"


def test_google_on_with_public_password_still_refuses_outside_member_login(monkeypatch):
    """4.5 (not a #64 state): members are refused from outside exactly as in 4.2; the operator password keeps working
    from outside, as HIVE_PUBLIC_PASSWORD=1 says."""
    with TestClient(make_app(monkeypatch, google=True, public=True), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        ann = add(c, admin)
        token = login(c, "ann@x.org", ann["password"]).json()["token"]   # 4.6: locally it still works
        refused = [login(c, "ann@x.org", ann["password"], outside=True), login(c, "nobody@x.org", "x", outside=True)]
        assert {r.status_code for r in refused} == {403} and len({r.content for r in refused}) == 1
        assert refused[0].json()["error"]["code"] == "password_login_local_only"
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 401
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert c.post(OUT + "/api/auth/login", json={"password": "pw"}).status_code == 200


def test_turning_google_on_stops_an_earlier_member_session_counting_from_outside(monkeypatch):
    """4.3: redeployed with Google (and without HIVE_PUBLIC_PASSWORD, as #64 writes it), an earlier member password
    session gets 401 from outside; on the hive's own machine it still works (4.6)."""
    with TestClient(make_app(monkeypatch), base_url="https://hive.example") as c:
        ann = add(c, admin_headers(c))
        token = login(c, "ann@x.org", ann["password"], outside=True).json()["token"]
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=False), base_url="https://hive.example") as c:
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 401
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 200


def test_the_same_email_continues_with_google_as_the_same_person(monkeypatch):
    """4.4: added by password, then Google with the same verified email: same row, same id and role, no invitation."""
    with TestClient(make_app(monkeypatch), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        ann = add(c, admin, "ann@x.org")
        member = bearer(login(c, "ann@x.org", ann["password"]).json()["token"])
        assert c.get("/api/auth/me", headers=member).status_code == 200
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=False), base_url="https://hive.example") as c:
        google = FakeGoogle()
        google.account = {"email": "ann@x.org", "email_verified": True, "name": "Ann"}
        c.app.state.hive.people.client = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
        response, _ = sign_in(c)
        assert response.status_code == 303, response.text
        token = c.post(OUT + "/api/auth/sso", cookies={"hive_signin": response.cookies["hive_signin"]}).json()["token"]
        me = c.get(OUT + "/api/auth/me", headers=bearer(token)).json()
        assert me["principal"] == f"user:{ann['person']['id']}" and me["role"] == "member"
        assert len(c.app.state.hive.db.all("SELECT id FROM people WHERE email = 'ann@x.org'")) == 1


# ---- 5. guessing waits, per account --------------------------------------------------------------------------------

@pytest.fixture()
def timed(monkeypatch):
    clock = [1000.0]
    with TestClient(make_app(monkeypatch, clock=clock), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        yield c, admin, clock


def test_wrong_member_passwords_from_outside_wait_longer_each_time(timed):
    """5.2, 5.5: no wait after one typo, then 1 s, 3 s; the right password waits too; a right one resets."""
    c, admin, clock = timed
    ann = add(c, admin)
    assert login(c, "ann@x.org", "nope", outside=True).status_code == 401
    assert login(c, "ann@x.org", "nope", outside=True).status_code == 401
    early = login(c, "ann@x.org", ann["password"], outside=True)
    assert early.status_code == 429 and early.headers["Retry-After"] == "1"
    assert early.json()["error"]["code"] == "too_many_attempts" and early.json()["error"]["retry_after_seconds"] == 1
    clock[0] += 1
    assert login(c, "ann@x.org", "nope", outside=True).status_code == 401
    assert login(c, "ann@x.org", ann["password"], outside=True).headers["Retry-After"] == "3"
    clock[0] += 3
    assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 200
    assert login(c, "ann@x.org", "nope", outside=True).status_code == 401
    assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 200


def test_the_wait_stops_at_an_hour_and_a_hundred_close_that_account(timed):
    """5.2: at most an hour; 100 wrong in a row close outside login for that account until an admin resets it."""
    c, admin, clock = timed
    ann = add(c, admin)
    for _ in range(20):
        clock[0] += 3600
        login(c, "ann@x.org", "nope", outside=True)
    assert login(c, "ann@x.org", "x", outside=True).headers["Retry-After"] == "3600"
    for _ in range(80):
        clock[0] += 3600
        login(c, "ann@x.org", "nope", outside=True)
    clock[0] += 3600
    closed = login(c, "ann@x.org", ann["password"], outside=True)
    assert closed.status_code == 429 and closed.json()["error"]["code"] == "password_login_closed"
    new = c.post(f"/api/people/{ann['person']['id']}/password", headers=admin).json()["password"]
    assert login(c, "ann@x.org", new, outside=True).status_code == 200


def test_a_local_member_sign_in_reopens_a_closed_account(timed):
    """5.5 and the agreed reopening: a right local sign-in by the member clears that account's count."""
    c, admin, clock = timed
    ann = add(c, admin)
    for _ in range(100):
        clock[0] += 3600
        login(c, "ann@x.org", "nope", outside=True)
    assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 429
    assert login(c, "ann@x.org", ann["password"]).status_code == 200
    assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 200


def test_waits_are_per_account(timed):
    """5.3: A waiting does not delay B or the operator; the operator's wrong passwords do not delay members."""
    c, admin, clock = timed
    a = add(c, admin, "a@x.org")
    b = add(c, admin, "b@x.org")
    for _ in range(3):
        login(c, "a@x.org", "nope", outside=True)
    assert login(c, "a@x.org", a["password"], outside=True).status_code == 429
    assert login(c, "b@x.org", b["password"], outside=True).status_code == 200
    assert c.post(OUT + "/api/auth/login", json={"password": "pw"}).status_code == 200
    for _ in range(3):
        c.post(OUT + "/api/auth/login", json={"password": "nope"})
    assert login(c, "b@x.org", b["password"], outside=True).status_code == 200


def test_unknown_emails_wait_like_real_ones(timed):
    """5.4: the 401/429 pattern does not tell which emails exist."""
    c, admin, _ = timed
    add(c, admin, "ann@x.org")
    for email in ("ann@x.org", "nobody@x.org"):
        answers = [login(c, email, "nope", outside=True) for _ in range(3)]
        assert [r.status_code for r in answers] == [401, 401, 429]
        assert answers[2].headers["Retry-After"] == "1"


def test_local_wrong_member_passwords_never_wait_or_count(timed):
    """5.5"""
    c, admin, _ = timed
    ann = add(c, admin)
    for _ in range(5):
        assert login(c, "ann@x.org", "nope").status_code == 401
    assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 200


def test_the_attempt_table_is_bounded():
    """Agreed with QA: counts for typed emails are kept in memory, so the table drops idle entries and has a cap;
    an account that is waiting or closed is the last to go."""
    clock = [0.0]
    table = AccountAttempts(clock=lambda: clock[0], cap=10)
    for _ in range(100):
        table.failed("closed@x.org")
    for i in range(3):
        table.failed(f"waiting{i}@x.org")
        table.failed(f"waiting{i}@x.org")
    for i in range(50):
        table.failed(f"spray{i}@x.org")
    assert len(table) <= 10
    assert table.wait("closed@x.org") is None
    assert all(table.wait(f"waiting{i}@x.org") > 0 for i in range(3))
    clock[0] += 2 * AccountAttempts.LONGEST_WAIT
    table.failed("late@x.org")
    assert table.wait("closed@x.org") is None and len(table) <= 10
    assert "spray0@x.org" not in table.keys()


# ---- T-108, T-109: a password is three words from xkcdpass's EFF long list, joined by dashes ----------------------

def test_the_word_list_is_xkcdpass_eff_long_without_dashed_words():
    words = people_module.PASSWORD_WORDS
    assert len(words) == 7772 and len(set(words)) == len(words) >= people_module.PASSWORD_WORDS_MIN
    assert list(words) == sorted(words) and all(re.fullmatch(r"[a-z]+", w) for w in words)
    assert words[0] == "abacus" and words[-1] == "zoom" and "t-shirt" not in words
    assert 3 * math.log2(len(words)) > 38.7   # the strength the docs give (about 38.8 bits)
    path = people_module.password_words_file()
    # abspath, not resolve(): xkcdpass and people.py build the path that way, so a symlinked site-packages still matches
    static = pathlib.Path(os.path.dirname(os.path.abspath(xkcd_password.__file__))) / "static"
    assert path.name == "eff-long" and path.parent == static
    lines = path.read_text(encoding="utf-8").split()
    assert len(lines) == 7776 and sorted(set(lines) - set(words)) == ["drop-down", "felt-tip", "t-shirt", "yo-yo"]


def test_a_password_is_three_list_words_with_two_dashes():
    made = [people_module.new_password() for _ in range(200)]
    for password in made:
        assert password.count("-") == 2
        assert_three_words(password)
    assert len(set(made)) == len(made)   # two calls differ (a repeat in 200 has odds of about 1 in 10^7)
    assert people_module.new_password(("ab", "cd")) in {f"{a}-{b}-{c}" for a in ("ab", "cd") for b in ("ab", "cd")
                                                      for c in ("ab", "cd")}


def test_add_and_reset_both_make_the_password_with_the_helper(hive, monkeypatch):
    c, admin = hive
    made = add(c, admin, "ann@x.org")
    assert_three_words(made["password"])
    reset = c.post(f"/api/people/{made['person']['id']}/password", headers=admin).json()["password"]
    assert_three_words(reset)
    assert reset != made["password"]
    assert login(c, "ann@x.org", reset).status_code == 200
    monkeypatch.setattr(people_module, "new_password", lambda: "otter-maple-quiet")
    bo = add(c, admin, "bo@x.org")
    assert bo["password"] == "otter-maple-quiet"
    monkeypatch.setattr(people_module, "new_password", lambda: "quiet-otter-maple")
    assert c.post(f"/api/people/{bo['person']['id']}/password", headers=admin).json()["password"] == "quiet-otter-maple"
    assert login(c, "bo@x.org", "quiet-otter-maple").status_code == 200


def test_login_checks_the_password_exactly_as_typed(hive):
    """Item 3 of T-108: no lowercasing or trimming of what the member types."""
    c, admin = hive
    password = add(c, admin, "ann@x.org")["password"]
    for typed in (password.upper(), password.capitalize(), f" {password}", f"{password} ", password.replace("-", " ")):
        assert login(c, "ann@x.org", typed).status_code == 401, typed
    assert login(c, "ann@x.org", password).status_code == 200


def write_words(tmp_path, words, name="words.txt"):
    path = tmp_path / name
    path.write_text("\n".join(words) + "\n", encoding="utf-8")
    return path


def test_the_word_list_check_filters_and_refuses_a_missing_or_short_list(tmp_path):
    enough = [f"w{''.join(chr(97 + (i // 26 ** k) % 26) for k in range(3))}" for i in range(2048)]
    noise = ["Upper", "t-shirt", "café", "two words", "", "1234", enough[0]]   # left out, or a repeat
    assert people_module.load_password_words(write_words(tmp_path, noise + enough)) == tuple(sorted(enough))
    assert people_module.load_password_words(write_words(tmp_path, [f"  {w}\t" for w in enough])) == tuple(sorted(enough))
    for path, match in ((tmp_path / "nowhere.txt", "cannot be read"),
                        (write_words(tmp_path, enough[:-1] + noise), "holds 2047 words; at least 2048 are needed")):
        with pytest.raises(RuntimeError, match=match):
            people_module.load_password_words(path)
    bad = tmp_path / "bad.txt"
    bad.write_bytes(b"\xff\xfe" + "\n".join(enough).encode())
    with pytest.raises(RuntimeError, match="cannot be read"):
        people_module.load_password_words(bad)


@pytest.mark.parametrize("found", [None, "/usr/share/dict/words", "eff-long"])
def test_only_the_list_xkcdpass_ships_is_taken(monkeypatch, found):
    """xkcdpass's locate_wordfile falls back to a system dictionary when its own file is missing; the hive refuses."""
    monkeypatch.setattr(xkcd_password, "locate_wordfile", lambda name=None: found)
    with pytest.raises(RuntimeError, match="xkcdpass does not ship it"):
        people_module.password_words_file()


STARTUP = """
import os, pathlib, sys
case = sys.argv[1]
if case == "no-package":
    sys.modules["xkcdpass"] = None   # import xkcdpass then fails as if it were not installed
else:
    from xkcdpass import xkcd_password
    if case == "missing":
        xkcd_password.locate_wordfile = lambda name=None: "/usr/share/dict/words"   # what it gives without eff-long
    real = pathlib.Path.read_text
    def read_text(self, *args, **kwargs):
        text = real(self, *args, **kwargs)
        return "\\n".join(text.splitlines()[:2047]) if self.name == "eff-long" else text   # fewer than 2048 words
    if case == "short":
        pathlib.Path.read_text = read_text
import hive.core.people
"""


@pytest.mark.parametrize("case", ["no-package", "missing", "short"])
def test_the_hive_does_not_start_without_a_full_word_list(case):
    """Importing people.py (which every hive start does) fails loudly; there is no weaker fallback."""
    root = pathlib.Path(__file__).resolve().parents[2]
    done = subprocess.run([sys.executable, "-c", STARTUP, case], cwd=root, capture_output=True, text=True, timeout=60,
                          env={**os.environ, "PYTHONPATH": os.pathsep.join((str(root), str(pathlib.Path(xkcd_password.__file__).resolve().parent.parent)))})
    assert done.returncode != 0
    expected = {"no-package": "ModuleNotFoundError: import of xkcdpass halted",
                "missing": "RuntimeError: member password word list 'eff-long' cannot be read: xkcdpass does not ship it",
                "short": "at least 2048 are needed"}[case]
    assert expected in done.stderr, done.stderr


# Private-fork policy: every typed identifier has the same retention, pruning and lockout behaviour.
@pytest.mark.parametrize("traffic", ["paced", "flood", "closure", "idle"])
def test_member_and_unknown_have_identical_observable_guess_traces(timed, monkeypatch, traffic):
    c, admin, clock = timed
    add(c, admin, "ann@x.org")
    attempts = c.app.state.member_attempts
    attempts.cap = 5
    work = []
    real_check = people_module.password_matches
    def checked(stored, password):
        work.append((stored.startswith("scrypt$"), password))
        return real_check(stored, password)
    monkeypatch.setattr(c.app.state.hive.people, "password_matches", checked)
    def failure(email):
        before = len(work)
        r = login(c, email, "wrong", outside=True)
        return r.status_code, r.json(), r.headers.get("Retry-After"), len(work) - before
    # Replay the same ordered traffic with only the target identifier changed. Two target keys in one
    # shared table can have different eviction histories simply because one request arrives first.
    traces = []
    for email in ("ann@x.org", "nobody@x.org"):
        for key in attempts.keys():
            attempts.clear(key)
        clock[0] = 1000.0
        trace = []
        for turn in range(101 if traffic in ("paced", "closure") else 7):
            if traffic == "paced":
                clock[0] += 2 * AccountAttempts.LONGEST_WAIT
                login(c, f"junk{turn}@x.org", "wrong", outside=True)
            elif traffic == "flood":
                clock[0] += AccountAttempts.LONGEST_WAIT
                for n in range(12):
                    login(c, f"flood{turn}-{n}@x.org", "wrong", outside=True)
            elif traffic == "idle":
                clock[0] += 2 * AccountAttempts.LONGEST_WAIT
            else:
                clock[0] += AccountAttempts.LONGEST_WAIT
            trace.append(failure(email))
            assert len(attempts) <= attempts.cap
        traces.append(trace)
    assert traces[0] == traces[1]
    assert all(valid_hash for valid_hash, _ in work)
    assert all(item[3] == (1 if item[0] == 401 else 0) for item in traces[0])
    if traffic == "closure":
        assert traces[0][-1][0] == 429
        assert traces[0][-1][1]["error"]["code"] == "password_login_closed"


def test_member_does_not_inherit_operator_counter_or_public_operator_session_policy(timed):
    c, admin, _ = timed
    made = add(c, admin)
    member = bearer(login(c, "ann@x.org", made["password"], outside=True).json()["token"])
    assert c.get(OUT + "/api/auth/me", headers=member).status_code == 200
    # The existing private-fork public operator-session restriction stays unchanged.
    assert c.get(OUT + "/api/auth/me", headers=admin).status_code == 401
    assert c.app.state.password_attempts.failures == 0
