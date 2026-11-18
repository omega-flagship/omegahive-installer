"""T-101: members sign in with a password the hive makes, until Google sign-in is on.

An admin adds a member by email; the hive makes the password and shows it once. The member signs in with email +
password as that person (never admin, never user:operator). Admins reset or remove it. From outside it works only
while Google is not configured and HIVE_PUBLIC_PASSWORD=1 (the two states .github-private#64 deploys); once Google is
on, the same email continues with Google as the same person row, except the one test account HIVE_TEST_ACCOUNT_EMAIL
and HIVE_TEST_ACCOUNT_PASSWORD name (T-329-env), which keeps its password from outside beside Google while
HIVE_PUBLIC_PASSWORD=1. Wrong guesses from outside wait per account.
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


TESS, TESS_PW = "tess@x.org", "tess-test-password-1"
TESTER = (TESS, TESS_PW)


def make_app(monkeypatch, data=None, google=False, public=True, clock=None, tester=None):
    """A hive under /omegahive in one of the states #64 deploys: Google off + HIVE_PUBLIC_PASSWORD=1 (default), or
    Google on without it. ``data`` reuses a data directory, as a redeploy does. ``tester`` is ``(email, password)``
    for HIVE_TEST_ACCOUNT_EMAIL / _PASSWORD (None for either leaves it unset); by default neither is set."""
    email, password = tester or (None, None)
    for k, v in (("HIVE_TEST_ACCOUNT_EMAIL", email), ("HIVE_TEST_ACCOUNT_PASSWORD", password)):
        monkeypatch.setenv(k, v) if v is not None else monkeypatch.delenv(k, raising=False)
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


def person(c, admin, email):
    """The people row for ``email``, as the admin's people list shows it."""
    return next(p for p in c.get("/api/people", headers=admin).json()["people"] if p["email"] == email)


def stored_hash(c, email):
    return c.app.state.hive.db.one("SELECT password_hash FROM people WHERE email = ?", (email,))["password_hash"]


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


# ---- 4. Google on: only test accounts keep the outside password; everyone else continues with Google ------------

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


def test_google_on_with_public_password_refuses_everyone_but_the_test_account_with_one_answer(monkeypatch):
    """4.5: with Google on and HIVE_PUBLIC_PASSWORD=1, an ordinary member's right password, an unknown email and the
    test account's wrong password get one 401, byte-identical and naming Google, so the answers never tell which
    email is the test account; locally the member's password still works (4.6); the operator password login is
    refused from outside like everywhere else outside."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        ann = add(c, admin)
        token = login(c, "ann@x.org", ann["password"]).json()["token"]   # 4.6: locally it still works
        refused = [login(c, "ann@x.org", ann["password"], outside=True), login(c, "nobody@x.org", "x", outside=True),
                   login(c, TESS, "wrong", outside=True)]
        assert {r.status_code for r in refused} == {401} and len({r.content for r in refused}) == 1
        assert "google" in refused[0].json()["error"]["message"].lower()
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 401
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert c.post(OUT + "/api/auth/login", json={"password": "pw"}).status_code == 403


def test_the_test_account_is_made_at_start_and_signs_in_from_outside_beside_google(monkeypatch, caplog):
    """T-329-env (#336): HIVE_TEST_ACCOUNT_EMAIL + HIVE_TEST_ACCOUNT_PASSWORD make the one test account at start, a
    member marked test_account with that password; with Google on and HIVE_PUBLIC_PASSWORD=1 it signs in from outside
    as that member, and the session counts from outside. The logs name the variable, never the password."""
    with caplog.at_level(logging.DEBUG):
        app = make_app(monkeypatch, google=True, public=True, tester=TESTER)
    with TestClient(app, base_url="https://hive.example") as c:
        tess = person(c, admin_headers(c), TESS)
        assert tess["role"] == "member" and tess["test_account"] is True and tess["password_set"] is True
        assert tess["invited_by"] == "config:HIVE_TEST_ACCOUNT_EMAIL"
        r = login(c, TESS, TESS_PW, outside=True)
        assert r.status_code == 200, r.text
        me = c.get(OUT + "/api/auth/me", headers=bearer(r.json()["token"])).json()
        assert me["principal"] == f"user:{tess['id']}" and me["role"] == "member" and me["kind"] == "member_password"
    assert any("HIVE_TEST_ACCOUNT_EMAIL" in rec.getMessage() for rec in caplog.records)
    assert not any(TESS_PW in rec.getMessage() for rec in caplog.records)


def test_the_test_account_signed_in_from_outside_never_runs_an_admins_hive_wide_routes(monkeypatch):
    """The test account is a member: signed in from outside beside Google, as staging lets it, it is refused on the
    routes that act for the whole hive, reloading, enabling and disabling apps and starting a Lab run (which uses the
    hive's machine and its environment), and none of them takes effect; the operator still does each. Before #307 these
    routes asked only for a session, so the test account's reached all four."""
    app_id = "contract-fixture"   # a built-in app every test hive loads
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        admin, lab = admin_headers(c), c.app.state.hive.lab
        started = []
        monkeypatch.setattr(lab, "_execute", lambda run_id, suite_id: started.append(suite_id))   # no bench process
        tess = bearer(login(c, TESS, TESS_PW, outside=True).json()["token"])
        enabled = lambda: {p["id"]: p["enabled"] for p in c.get("/api/programs", headers=admin).json()}[app_id]  # noqa: E731
        assert enabled() is True
        tries = {path: c.post(OUT + path, headers=tess, **extra) for path, extra in (
            ("/api/programs/reload", {}), (f"/api/programs/{app_id}/disable", {}), (f"/api/programs/{app_id}/enable", {}),
            ("/api/lab/runs", {"json": {"suite": "bench-drift"}}))}
        answers = {path: (r.status_code, r.json()["error"]["code"] if r.status_code >= 400 else None)
                   for path, r in tries.items()}
        assert answers == dict.fromkeys(tries, (403, "admin_only")), answers
        assert enabled() is True and lab.runs() == [] and started == []      # nothing the test account asked happened
        assert c.post(f"/api/programs/{app_id}/disable", headers=admin).json()["enabled"] is False
        assert c.post(f"/api/programs/{app_id}/enable", headers=admin).json()["enabled"] is True
        assert app_id in {p["id"] for p in c.post("/api/programs/reload", headers=admin).json()}
        run = c.post("/api/lab/runs", headers=admin, json={"suite": "bench-drift"}).json()
        assert run["status"] == "running" and [r["id"] for r in lab.runs()] == [run["id"]]


def test_an_existing_member_becomes_the_test_account_and_a_restart_keeps_its_hash(monkeypatch):
    """T-329-env: a member who already has a row is marked at start and gets the setting's password; a restart with
    the same setting leaves the stored hash and the member's sessions alone; a changed password is set and ends that
    member's password sessions, so the old password and its sessions stop working."""
    with TestClient(make_app(monkeypatch, google=True, public=True), base_url="https://hive.example") as c:
        own = add(c, admin_headers(c), TESS)["password"]
        assert login(c, TESS, own, outside=True).status_code == 401   # not the test account yet
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=TESTER),
                    base_url="https://hive.example") as c:
        assert person(c, admin_headers(c), TESS)["test_account"] is True
        assert login(c, TESS, own).status_code == 401   # the setting's password replaced the one the hive made
        token = login(c, TESS, TESS_PW, outside=True).json()["token"]
        before = stored_hash(c, TESS)
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=TESTER),
                    base_url="https://hive.example") as c:
        assert stored_hash(c, TESS) == before
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 200
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=(TESS, "another-tester-pw")),
                    base_url="https://hive.example") as c:
        assert stored_hash(c, TESS) != before
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 401
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401
        assert login(c, TESS, "another-tester-pw", outside=True).status_code == 200


def test_unsetting_the_test_account_ends_its_outside_sign_in(monkeypatch):
    """T-329-env: restarted without the variables, nobody is the test account: its password session stops counting
    from outside and its next outside login fails like anyone's; on the hive's own machine the session still works."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        token = login(c, TESS, TESS_PW, outside=True).json()["token"]
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 200
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True), base_url="https://hive.example") as c:
        assert person(c, admin_headers(c), TESS)["test_account"] is False
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 401
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 200
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is False


def test_a_changed_address_moves_the_mark(monkeypatch):
    """T-329-env: the hive has one test account. Restarted with another address, the old one is unmarked (it stays a
    member) and the new one is made and marked."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=("tina@x.org", TESS_PW)),
                    base_url="https://hive.example") as c:
        admin = admin_headers(c)
        assert person(c, admin, TESS)["test_account"] is False and person(c, admin, TESS)["role"] == "member"
        assert person(c, admin, "tina@x.org")["test_account"] is True
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401
        assert login(c, "tina@x.org", TESS_PW, outside=True).status_code == 200
        assert sum(p["test_account"] for p in c.get("/api/people", headers=admin).json()["people"]) == 1


def test_a_row_marked_through_the_api_before_is_unmarked_at_start(monkeypatch):
    """T-329-env: a hive that ran #329 may hold rows an admin marked through the API; at start only the environment's
    account keeps the mark, and with the variables unset none does."""
    with TestClient(make_app(monkeypatch, google=True, public=True), base_url="https://hive.example") as c:
        ann = add(c, admin_headers(c))
        db = c.app.state.hive.db
        with db.transaction():
            db.update("people", ann["person"]["id"], {"test_account": 1})   # as #329's PATCH stored it
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True), base_url="https://hive.example") as c:
        assert person(c, admin_headers(c), "ann@x.org")["test_account"] is False
        assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 401


def test_no_request_sets_the_test_account_mark(monkeypatch):
    """T-329-env: the mark comes from the environment only. test_account on POST /api/people/members or PATCH
    /api/people/{id} is a 400 for an admin, whatever the value, naming the variable; a member gets the 403 an
    admin-only route gives, here the test account itself, on the hive's machine and from outside."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        ann = add(c, admin)
        for value in (True, False, "yes", 1, None):
            r = c.patch(f"/api/people/{ann['person']['id']}", json={"test_account": value}, headers=admin)
            assert r.status_code == 400 and "HIVE_TEST_ACCOUNT_EMAIL" in r.json()["error"]["message"], value
            r = c.post("/api/people/members", json={"email": "eve@x.org", "test_account": value}, headers=admin)
            assert r.status_code == 400, value
        member = bearer(login(c, TESS, TESS_PW, outside=True).json()["token"])
        for pre in ("", OUT):
            r = c.patch(f"{pre}/api/people/{ann['person']['id']}", json={"test_account": True}, headers=member)
            assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
            r = c.post(pre + "/api/people/members", json={"email": "eve@x.org", "test_account": True}, headers=member)
            assert r.status_code == 403
        people = {p["email"]: p for p in c.get("/api/people", headers=admin).json()["people"]}
        assert people["ann@x.org"]["test_account"] is False and "eve@x.org" not in people
        assert login(c, "ann@x.org", ann["password"], outside=True).status_code == 401


def test_the_test_account_is_never_made_an_admin_or_given_a_password_by_request(monkeypatch):
    """T-329-env: PATCH role=admin and a password reset on the test account are 400s that say where it comes from;
    its password stays the setting's. Removing its password (and removing the person) stay an admin's."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        tess = person(c, admin, TESS)
        r = c.patch(f"/api/people/{tess['id']}", json={"role": "admin"}, headers=admin)
        assert r.status_code == 400 and "HIVE_TEST_ACCOUNT_EMAIL" in r.json()["error"]["message"]
        r = c.post(f"/api/people/{tess['id']}/password", headers=admin)
        assert r.status_code == 400 and "HIVE_TEST_ACCOUNT_PASSWORD" in r.json()["error"]["message"]
        assert person(c, admin, TESS)["role"] == "member"
        assert login(c, TESS, TESS_PW, outside=True).status_code == 200
        assert c.delete(f"/api/people/{tess['id']}/password", headers=admin).status_code == 200
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401


@pytest.mark.parametrize("restart", [False, True])
def test_an_admin_address_is_never_the_test_account(monkeypatch, caplog, restart):
    """T-329-env: an address in HIVE_ADMIN_EMAILS is skipped (logged) and the hive starts; it stays an admin and its
    password never counts from outside. A test account whose address is later listed is promoted and loses the mark."""
    data = None
    if restart:
        with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
            data = c.app.state.data_dir
    monkeypatch.setenv("HIVE_ADMIN_EMAILS", TESS)
    with caplog.at_level(logging.WARNING):
        app = make_app(monkeypatch, data=data, google=True, public=True, tester=TESTER)
    with TestClient(app, base_url="https://hive.example") as c:
        tess = person(c, admin_headers(c), TESS)
        assert tess["role"] == "admin" and tess["test_account"] is False
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is False
    assert any("never a test account" in rec.getMessage() or "an admin never is" in rec.getMessage()
               for rec in caplog.records)


def test_a_disabled_member_is_not_made_the_test_account(monkeypatch):
    """T-329-env: a disabled row with the address is skipped, never re-enabled or given the password, and no second
    row is made; the hive starts."""
    with TestClient(make_app(monkeypatch, google=True, public=True), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        tess = add(c, admin, TESS)
        assert c.patch(f"/api/people/{tess['person']['id']}", json={"disabled": True}, headers=admin).status_code == 200
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=TESTER),
                    base_url="https://hive.example") as c:
        admin = admin_headers(c)
        rows = [p for p in c.get("/api/people", headers=admin).json()["people"] if p["email"] == TESS]
        assert len(rows) == 1 and rows[0]["disabled"] is True and rows[0]["test_account"] is False
        assert rows[0]["password_set"] is False
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401


def test_disabling_the_test_account_clears_its_mark_until_the_next_start(monkeypatch):
    """T-329-env (QA N1): disabling the test account drops its mark with its password, so a later re-enabling (an
    admin's, or an invite accepted as an admin) never leaves a marked row; the next start marks it again while it is
    the environment's enabled member, with the setting's password."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        admin = admin_headers(c)
        tess = person(c, admin, TESS)
        r = c.patch(f"/api/people/{tess['id']}", json={"disabled": True}, headers=admin)
        assert r.status_code == 200 and r.json()["test_account"] is False
        assert c.patch(f"/api/people/{tess['id']}", json={"disabled": False}, headers=admin).status_code == 200
        again = person(c, admin, TESS)
        assert again["test_account"] is False and again["password_set"] is False
        assert login(c, TESS, TESS_PW, outside=True).status_code == 401
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=True, public=True, tester=TESTER),
                    base_url="https://hive.example") as c:
        assert person(c, admin_headers(c), TESS)["test_account"] is True
        assert login(c, TESS, TESS_PW, outside=True).status_code == 200


def test_a_marked_admin_row_never_counts_from_outside(monkeypatch):
    """T-329-env E4 (QA N2): should a marked row ever be an admin (data written around the API), its password session
    stops counting from outside, its outside login is refused and the card no longer offers member passwords; on the
    hive's own machine the session still works."""
    with TestClient(make_app(monkeypatch, google=True, public=True, tester=TESTER), base_url="https://hive.example") as c:
        token = login(c, TESS, TESS_PW, outside=True).json()["token"]
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 200
        tess_id = person(c, admin_headers(c), TESS)["id"]   # before the transaction: a request inside it would wait
        db = c.app.state.hive.db                             # on the test's own lock forever
        with db.transaction():
            db.update("people", tess_id, {"role": "admin"})   # the mark stays
        assert c.get(OUT + "/api/auth/me", headers=bearer(token)).status_code == 401
        assert login(c, TESS, TESS_PW, outside=True).status_code != 200
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is False
        assert c.get("/api/auth/me", headers=bearer(token)).status_code == 200


@pytest.mark.parametrize("email, password, variable", [
    ("a@x.org,b@x.org", TESS_PW, "HIVE_TEST_ACCOUNT_EMAIL"),
    ("a@x.org b@x.org", TESS_PW, "HIVE_TEST_ACCOUNT_EMAIL"),
    ("a@x.org;b@x.org", TESS_PW, "HIVE_TEST_ACCOUNT_EMAIL"),
    ("not-an-address", TESS_PW, "HIVE_TEST_ACCOUNT_EMAIL"),
    (TESS, None, "HIVE_TEST_ACCOUNT_PASSWORD"),
    (TESS, "short-pw", "HIVE_TEST_ACCOUNT_PASSWORD"),
    (TESS, "it's-a-long-password", "HIVE_TEST_ACCOUNT_PASSWORD"),
    (TESS, "two-lines\nof-password", "HIVE_TEST_ACCOUNT_PASSWORD"),
    (TESS, "carriage-return\rin-it", "HIVE_TEST_ACCOUNT_PASSWORD"),
    (TESS, "ends-with-a-backslash\\", "HIVE_TEST_ACCOUNT_PASSWORD"),
    (None, TESS_PW, "HIVE_TEST_ACCOUNT_PASSWORD"),
])
def test_a_bad_test_account_setting_stops_the_hive_naming_only_the_variable(monkeypatch, caplog, email, password,
                                                                             variable):
    """T-329-env: the hive does not start on a bad setting (a list, not an address, a password missing or refused by
    the press's D21 rules, a password without an address); the error names the variable, never the password."""
    with caplog.at_level(logging.DEBUG), pytest.raises(RuntimeError) as refused:
        make_app(monkeypatch, tester=(email, password))
    assert variable in str(refused.value)
    if password:
        assert password not in str(refused.value)
        assert not any(password in rec.getMessage() for rec in caplog.records)


def test_the_test_account_needs_the_public_password_switch(monkeypatch):
    """T-329-env: without HIVE_PUBLIC_PASSWORD=1 the test account is refused from outside like everyone (4.2), so the
    deployer's switch stays the gate for any password from outside."""
    with TestClient(make_app(monkeypatch, google=True, public=False, tester=TESTER), base_url="https://hive.example") as c:
        r = login(c, TESS, TESS_PW, outside=True)
        assert r.status_code == 403 and r.json()["error"]["code"] == "password_login_local_only"
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is False


@pytest.mark.parametrize("google", [False, True])
def test_the_sign_in_methods_offer_only_ways_in_that_count_there(monkeypatch, google):
    """GET /api/auth/methods, the sign-in card's ways in: from outside never the operator's password (password is
    false with HIVE_PUBLIC_PASSWORD=1 too, since its session never counts there); member passwords from outside while
    Google is off, and once it is on only while the test account has a password; on the hive's own machine both."""
    with TestClient(make_app(monkeypatch, google=google, public=True), base_url="https://hive.example") as c:
        outside = c.get(OUT + "/api/auth/methods").json()
        assert outside["password"] is False and outside["member_password"] is (not google)
        if google:
            assert outside["sso"]["login_url"] == OUT + "/api/auth/google/start"
        data = c.app.state.data_dir
    with TestClient(make_app(monkeypatch, data=data, google=google, public=True, tester=TESTER),
                    base_url="https://hive.example") as c:
        admin = admin_headers(c)
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is True
        c.delete(f"/api/people/{person(c, admin, TESS)['id']}/password", headers=admin)
        assert c.get(OUT + "/api/auth/methods").json()["member_password"] is (not google)
        local = c.get("/api/auth/methods").json()
        assert local["password"] is True and local["member_password"] is True


def test_the_test_account_setting_reads_two_variables():
    """T-329-env, the parser alone: neither set is None; the address is trimmed and lowercased; the password is kept
    exactly as given."""
    read = people_module.configured_test_account
    assert read({}) is None and read({"HIVE_TEST_ACCOUNT_EMAIL": " ", "HIVE_TEST_ACCOUNT_PASSWORD": ""}) is None
    assert read({"HIVE_TEST_ACCOUNT_EMAIL": " Tess@X.org ", "HIVE_TEST_ACCOUNT_PASSWORD": " Pass word 1 "}) == (
        "tess@x.org", " Pass word 1 ")
    assert people_module.tester_password_problem("ten-chars!") is None


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
    """5.2: at most an hour; 100 wrong in a row close outside login for that account until an admin resets it, even
    when each comes only once its wait is over (an hour forgives one failure's wait, never the run of them)."""
    c, admin, clock = timed
    ann = add(c, admin)
    waits = []
    for _ in range(100):
        answer = login(c, "ann@x.org", "nope", outside=True)
        while answer.status_code == 429:
            assert answer.json()["error"]["code"] == "too_many_attempts"
            waits.append(int(answer.headers["Retry-After"]))
            clock[0] += waits[-1]
            answer = login(c, "ann@x.org", "nope", outside=True)
        assert answer.status_code == 401
    assert max(waits) == 3600 and waits.count(3600) == 100 - 13
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
    """5.3: A waiting does not delay B; the operator's login from outside is refused before anything counts, so it
    never delays members either."""
    c, admin, clock = timed
    a = add(c, admin, "a@x.org")
    b = add(c, admin, "b@x.org")
    for _ in range(3):
        login(c, "a@x.org", "nope", outside=True)
    assert login(c, "a@x.org", a["password"], outside=True).status_code == 429
    assert login(c, "b@x.org", b["password"], outside=True).status_code == 200
    for _ in range(3):
        assert c.post(OUT + "/api/auth/login", json={"password": "nope"}).status_code == 403
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
    """Agreed with QA: counts for typed emails are kept in memory, so the table has a cap; an account that is waiting
    or closed is the last to go."""
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


def test_a_quiet_hour_forgives_one_failure_instead_of_resetting_the_count():
    """The one trunk's rule: a typed email's count decays, one failure forgiven per hour without a new one, and is
    never reset by a quiet spell, so guesses paced an hour apart never buy back the short early waits."""
    clock = [0.0]
    table = AccountAttempts(clock=lambda: clock[0])
    for _ in range(12):
        clock[0] += table.wait("ann@x.org")
        table.failed("ann@x.org")
    assert table.wait("ann@x.org") == 2 ** 11 - 1             # after 12 failures
    clock[0] += AccountAttempts.LONGEST_WAIT                  # an hour after the 12th: one forgiven, 11 left
    table.failed("ann@x.org")
    assert table.wait("ann@x.org") == 2 ** 11 - 1             # 12 again, not 1
    clock[0] += 3 * AccountAttempts.LONGEST_WAIT              # three hours: 9 left
    table.failed("ann@x.org")
    assert table.wait("ann@x.org") == 2 ** 9 - 1
    clock[0] += 50 * AccountAttempts.LONGEST_WAIT             # all forgiven: the next typo waits nothing
    table.failed("ann@x.org")
    assert table.wait("ann@x.org") == 0


def test_guesses_as_fast_as_the_waits_allow_still_close_the_login_at_the_limit():
    """Waits stop growing at an hour, the pace at which failures are forgiven, so the waits level off at an hour; the
    failures since the last right password do not decay, and LIMIT of them close the outside login however slowly they
    came. Quiet time never reopens it; a clear (a right password, an admin's reset) does."""
    clock = [0.0]
    table = AccountAttempts(clock=lambda: clock[0])
    waits = []
    for _ in range(AccountAttempts.LIMIT):
        wait = table.wait("ann@x.org")
        assert wait is not None
        clock[0] += wait
        table.failed("ann@x.org")
        waits.append(table.wait("ann@x.org"))
    assert waits[:12] == [2 ** i - 1 for i in range(12)]
    assert waits[12:-1] == [AccountAttempts.LONGEST_WAIT] * (AccountAttempts.LIMIT - 13) and waits[-1] is None
    clock[0] += 1000 * AccountAttempts.LONGEST_WAIT
    assert table.wait("ann@x.org") is None
    table.clear("ann@x.org")
    assert table.wait("ann@x.org") == 0


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


def test_member_does_not_inherit_the_public_operator_session_policy(timed):
    c, admin, _ = timed
    made = add(c, admin)
    member = bearer(login(c, "ann@x.org", made["password"], outside=True).json()["token"])
    assert c.get(OUT + "/api/auth/me", headers=member).status_code == 200
    # The existing private-fork public operator-session restriction stays unchanged.
    assert c.get(OUT + "/api/auth/me", headers=admin).status_code == 401
