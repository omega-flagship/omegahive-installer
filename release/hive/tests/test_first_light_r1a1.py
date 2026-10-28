"""First Light R1a.1 (host): a hello claim never sticks (cancel, crash, lost row), GET shows a waiting hello, the
greeting is the mind's own message, egress refusals say so, and the monthly-limit item says whether it is enforced.
Synthetic people, keys and messages only."""

import asyncio
import pathlib

import pytest

from hive.core import onboarding
from hive.core.visibility import Viewer
from hive.tests.test_first_light import _err, hive_app  # noqa: F401  (fixture)
from hive.tests.test_people_api import PETTA, sign_in
from hive.tests.test_personal_mind import _person

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def _notes(hive, mind_id):
    return hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' AND sender = ?",
                       (mind_id, onboarding.HELLO_SENDER))


def _setup(hive_app):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    mind = hive.personal.mind_row(principal)
    return app, c, hive, sup, ana, principal, mind


def _claim(hive, principal, mind, requested_at, message_id=None):
    hive.db.execute("INSERT INTO onboarding_hello (principal, mind_id, conversation_id, message_id, requested_at, sent_at) "
                    "VALUES (?, ?, ?, ?, ?, NULL)",
                    (principal, mind["id"], hive.person_conversation(mind["id"], principal), message_id, requested_at))


OLD = "2026-01-01T00:00:00.000Z"


# ---- 1. the claim never sticks ------------------------------------------------------------------------------------

def test_a_cancel_before_the_note_releases_the_claim(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    real = hive.send_to_agent

    async def cancelled(*a, **k):
        raise asyncio.CancelledError()
    hive.send_to_agent = cancelled
    with pytest.raises(asyncio.CancelledError):   # CancelledError is a BaseException, not an Exception
        asyncio.run(hive.onboarding.hello(Viewer(principal, False)))
    assert hive.db.all("SELECT * FROM onboarding_hello") == [] and _notes(hive, mind["id"]) == []
    hive.send_to_agent = real
    r = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert r["created"] is True and len(_notes(hive, mind["id"])) == 1


def test_a_cancel_after_the_note_was_stored_adopts_it(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    real = hive.send_to_agent

    async def stored_then_cancelled(*a, **k):
        await real(*a, **k)
        raise asyncio.CancelledError()
    hive.send_to_agent = stored_then_cancelled
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(hive.onboarding.hello(Viewer(principal, False)))
    hive.send_to_agent = real
    notes = _notes(hive, mind["id"])
    assert len(notes) == 1
    assert hive.db.one("SELECT message_id FROM onboarding_hello")["message_id"] == notes[0]["id"]
    again = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert again["created"] is False and again["message_id"] == notes[0]["id"] and len(_notes(hive, mind["id"])) == 1


def test_an_error_after_the_note_was_stored_returns_the_hello(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    real = hive.send_to_agent

    async def stored_then_failed(*a, **k):
        await real(*a, **k)
        raise RuntimeError("synthetic: delivery failed after the store")
    hive.send_to_agent = stored_then_failed
    r = c.post("/api/me/personal-mind/hello", headers=ana)
    assert r.status_code == 200 and r.json()["created"] is True
    assert r.json()["message_id"] == _notes(hive, mind["id"])[0]["id"]
    hive.send_to_agent = real
    assert c.post("/api/me/personal-mind/hello", headers=ana).json()["created"] is False
    assert len(_notes(hive, mind["id"])) == 1


def test_a_crashed_claim_waits_then_becomes_retryable(hive_app):
    """A claim left by a process that died before the wake: GET and POST show it waiting; once stale, POST retries."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    from hive.core.db import now
    _claim(hive, principal, mind, now())
    got = c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]
    assert got is not None and got["state"] == "waiting" and got["message_id"] is None and got["retryable"] is False
    fresh = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert fresh["created"] is False and fresh["state"] == "waiting" and sup.starts == [] and _notes(hive, mind["id"]) == []
    hive.db.execute("UPDATE onboarding_hello SET requested_at = ?", (OLD,))
    assert c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]["retryable"] is True
    retried = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert retried["created"] is True and retried["message_id"] and retried["retryable"] is False
    assert sup.starts == [mind["id"]] and len(_notes(hive, mind["id"])) == 1


@pytest.mark.parametrize("requested_at", ["fresh", OLD])
def test_a_crash_after_the_note_adopts_it_and_never_resends(hive_app, requested_at):
    """A note stored, then the process died before the stamp: the note is adopted, fresh or stale, and not resent."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    from hive.core.db import now
    _claim(hive, principal, mind, now() if requested_at == "fresh" else requested_at)
    note = hive.enqueue_message(mind["id"], "First Light: (synthetic earlier note)",
                                hive.person_conversation(mind["id"], principal), onboarding.HELLO_SENDER)
    assert c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]["message_id"] == note["id"]
    r = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert r["created"] is False and r["message_id"] == note["id"] and r["retryable"] is False
    assert len(_notes(hive, mind["id"])) == 1 and sup.starts == []


def test_a_lost_claim_row_adopts_the_note_already_in_the_chat(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    first = c.post("/api/me/personal-mind/hello", headers=ana).json()
    hive.db.execute("DELETE FROM onboarding_hello")
    again = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert again["created"] is False and again["message_id"] == first["message_id"]
    assert len(_notes(hive, mind["id"])) == 1 and sup.starts == [mind["id"]]


# ---- 2/3. GET waiting; the greeting is the mind's own --------------------------------------------------------------

def test_greeting_is_only_the_minds_own_message(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    hello = c.post("/api/me/personal-mind/hello", headers=ana).json()
    from hive.core.db import new_id, now
    hive.db.insert("messages", {"id": new_id("m"), "agent_id": mind["id"], "conversation_id": hello["conversation_id"],
                                "direction": "out", "sender": "agent:a_someone_else", "text": "not the greeting",
                                "created_at": now()})
    assert c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]["state"] == "waiting"
    hive.record_agent_message(mind["id"], {"text": "Hi Ana, I'm awake.", "conversation_id": hello["conversation_id"]})
    got = c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]
    assert got["state"] == "greeted" and got["greeting"]["text"] == "Hi Ana, I'm awake."


# ---- 4. gateway codes -----------------------------------------------------------------------------------------------

def test_egress_refusal_has_its_own_reason(hive_app, monkeypatch):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    hive.db.execute("UPDATE agents SET model = 'anthropic/claude-sonnet-5-5' WHERE id = ?", (mind["id"],))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-synthetic-test")
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", f'["{mind["swarm_id"]}"]')
    r = c.post("/api/me/personal-mind/hello", headers=ana)
    assert r.status_code == 403 and _err(r) == "egress_refused"
    assert r.json()["error"]["message"] == onboarding.SAY["egress_refused"]
    hive.db.execute("UPDATE agents SET model = 'nowhere/model' WHERE id = ?", (mind["id"],))
    assert _err(c.post("/api/me/personal-mind/hello", headers=ana)) == "no_model"     # unknown provider: no_model
    hive.db.execute("UPDATE agents SET model = 'not-a-model' WHERE id = ?", (mind["id"],))
    assert _err(c.post("/api/me/personal-mind/hello", headers=ana)) == "no_model"     # bad model id: no_model
    assert sup.starts == [] and hive.db.all("SELECT * FROM onboarding_hello") == []


# ---- the monthly-limit item: enforced or not -----------------------------------------------------------------------

def _monthly(c, headers):
    return next(i for i in c.get("/api/me/setup", headers=headers).json()["items"] if i["id"] == "monthly_limit")


def test_monthly_limit_says_whether_it_is_enforced(hive_app):
    app, c, admin, google, sup = hive_app
    ana, _ = _person(c, admin, google, "ana@example.com", "Ana")
    m = _monthly(c, ana)                                       # a member: the member default caps hive-paid spend
    assert m["enforced"] is True and m["detail"]["enforced_by"] == "member-default" and m["done"] is False
    link = c.post("/api/invites", json={"email": "ad@example.com", "name": "Ad", "role": "admin"}, headers=admin).json()["link"]
    google.account = {"email": "ad@example.com", "email_verified": True, "name": "Ad"}
    c.cookies.clear()
    r, _ = sign_in(c, link.split("invite=")[1])
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies.get("hive_signin")}).json()
    c.cookies.clear()
    ad = {"Authorization": f"Bearer {session['token']}"}
    c.patch("/api/me/onboarding", headers=ad, json={"monthly_spend_usd": 30})
    m = _monthly(c, ad)                                        # an admin with no rule: chosen, but nothing enforces it
    assert m["done"] is True and m["enforced"] is False and m["detail"]["enforced_by"] is None
    assert c.post("/api/budgets", json={"scope": f"person:{session['user']['id']}", "period": "month", "limit_usd": 40},
                  headers=admin).status_code == 200
    m = _monthly(c, ad)                                        # a month rule of their own: enforced
    assert m["enforced"] is True and m["detail"]["enforced_by"] == "rule" and m["detail"]["allowance_usd"] == 40.0


def test_post_alone_adopts_a_note_from_a_crash(hive_app):
    """No GET first: the POST itself adopts the stored note of a fresh, unstamped claim and sends nothing."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    from hive.core.db import now
    _claim(hive, principal, mind, now())
    note = hive.enqueue_message(mind["id"], "First Light: (synthetic earlier note)",
                                hive.person_conversation(mind["id"], principal), onboarding.HELLO_SENDER)
    r = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert r["created"] is False and r["message_id"] == note["id"]
    assert len(_notes(hive, mind["id"])) == 1 and sup.starts == []
