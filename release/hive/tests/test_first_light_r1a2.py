"""First Light R1a.2 (host): a hello claim is owned by a token. Only the request that still owns an unsent claim may
store the note and stamp it, in one transaction with the note's insert; cleanup is scoped to the token. A stale-claim
retry racing the original request yields exactly one note and one consistent message_id. Synthetic data only."""

import asyncio
import pathlib
import threading

import pytest

from hive.core import onboarding
from hive.core.visibility import Viewer
from hive.tests.test_first_light import hive_app  # noqa: F401  (fixture)
from hive.tests.test_first_light_r1a1 import OLD, _notes, _setup
from hive.tests.test_people_api import PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def _race(hive, principal, mind, retry_first=True):
    """Request A claims and blocks in its wake; its claim goes stale; request B retries and finishes (or not, when
    retry_first is False the retry is skipped); then A resumes. Returns (A's result, B's result)."""
    gate, entered = threading.Event(), threading.Event()
    real = hive.lifecycle
    calls = []

    def lifecycle(agent_id, action, expect=None):
        calls.append(action)
        if len(calls) == 1:          # A's wake: hold it until B has finished
            entered.set()
            assert gate.wait(30)
        return real(agent_id, action, expect)
    hive.lifecycle = lifecycle

    async def main():
        a = asyncio.create_task(hive.onboarding.hello(Viewer(principal, False)))
        while not entered.is_set():
            await asyncio.sleep(0.01)
        a_token = hive.db.one("SELECT claim_token FROM onboarding_hello")["claim_token"]
        b = None
        if retry_first:
            hive.db.execute("UPDATE onboarding_hello SET requested_at = ?", (OLD,))   # A's claim looks abandoned
            b = await hive.onboarding.hello(Viewer(principal, False))
        gate.set()
        return a_token, await a, b
    try:
        return asyncio.run(main())
    finally:
        hive.lifecycle = real


def test_stale_retry_racing_the_original_request_sends_exactly_one_note(hive_app):
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    a_token, a, b = _race(hive, principal, mind)
    notes = _notes(hive, mind["id"])
    assert len(notes) == 1                                                     # one note, never two
    row = hive.db.one("SELECT * FROM onboarding_hello")
    assert row["message_id"] == notes[0]["id"] == b["message_id"]            # the retry's note, not overwritten
    assert row["claim_token"] != a_token                                      # the retry owns the hello
    assert b["created"] is True and a["created"] is False and a["message_id"] == notes[0]["id"]
    got = c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]
    assert got["message_id"] == notes[0]["id"] and got["state"] == "waiting"
    again = c.post("/api/me/personal-mind/hello", headers=ana).json()        # and nothing more is ever sent
    assert again["created"] is False and len(_notes(hive, mind["id"])) == 1


def test_original_request_still_owning_its_claim_sends_and_stamps(hive_app):
    """No retry in between: the original request still owns its claim, so it sends the one note and stamps it."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    a_token, a, _ = _race(hive, principal, mind, retry_first=False)
    notes = _notes(hive, mind["id"])
    row = hive.db.one("SELECT * FROM onboarding_hello")
    assert len(notes) == 1 and a["created"] is True and row["message_id"] == notes[0]["id"] == a["message_id"]
    assert row["claim_token"] == a_token


def test_a_superseded_request_cleans_up_nothing_of_the_new_claim(hive_app):
    """The original request fails after losing its claim: the new owner's unsent claim survives untouched."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    real = hive.send_to_agent

    async def fail_after_takeover(*a, **k):
        hive.db.execute("UPDATE onboarding_hello SET claim_token = 'someone-else'")   # a retry took the claim
        raise RuntimeError("synthetic: failed after the takeover")
    hive.send_to_agent = fail_after_takeover
    with pytest.raises(RuntimeError):
        asyncio.run(hive.onboarding.hello(Viewer(principal, False)))
    hive.send_to_agent = real
    row = hive.db.one("SELECT * FROM onboarding_hello")
    assert row is not None and row["claim_token"] == "someone-else" and row["message_id"] is None
    assert _notes(hive, mind["id"]) == []


def test_claim_token_column_is_added_to_an_r1a_table(monkeypatch):
    """An onboarding_hello table from R1a/R1a.1 (no claim_token) gains the column; its rows keep working."""
    import sqlite3
    import tempfile
    from hive.tests.test_personal_mind import _env
    tmp = tempfile.mkdtemp(prefix="hive-fl2-old-")
    con = sqlite3.connect(pathlib.Path(tmp) / "hive.db")
    con.execute("""CREATE TABLE onboarding_hello (principal TEXT PRIMARY KEY, mind_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, requested_at TEXT NOT NULL, sent_at TEXT)""")
    con.commit()
    con.close()
    app, _, _, _ = _env(monkeypatch, tmp)
    assert "claim_token" in {r["name"] for r in app.state.hive.db.all("PRAGMA table_info(onboarding_hello)")}


def test_both_requests_mid_wake_only_the_current_owner_sends(hive_app):
    """A blocks in its wake, its claim goes stale, B claims and also blocks in its wake; A resumes first. A no longer
    owns the claim, so it sends nothing; B, the owner, sends the one note."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    gates = [threading.Event(), threading.Event()]
    entered = [threading.Event(), threading.Event()]
    real = hive.lifecycle
    calls = []

    def lifecycle(agent_id, action, expect=None):
        n = len(calls)
        calls.append(action)
        if n < 2:
            entered[n].set()
            assert gates[n].wait(30)
        return real(agent_id, action, expect)
    hive.lifecycle = lifecycle

    async def main():
        a = asyncio.create_task(hive.onboarding.hello(Viewer(principal, False)))
        while not entered[0].is_set():
            await asyncio.sleep(0.01)
        a_token = hive.db.one("SELECT claim_token FROM onboarding_hello")["claim_token"]
        hive.db.execute("UPDATE onboarding_hello SET requested_at = ?", (OLD,))
        b = asyncio.create_task(hive.onboarding.hello(Viewer(principal, False)))
        while not entered[1].is_set():
            await asyncio.sleep(0.01)
        gates[0].set()
        ra = await a
        assert _notes(hive, mind["id"]) == []          # A, superseded, sent nothing
        gates[1].set()
        return a_token, ra, await b
    try:
        a_token, a, b = asyncio.run(main())
    finally:
        hive.lifecycle = real
    notes = _notes(hive, mind["id"])
    row = hive.db.one("SELECT * FROM onboarding_hello")
    assert len(notes) == 1 and b["created"] is True and a["created"] is False
    assert row["message_id"] == notes[0]["id"] == b["message_id"] and row["claim_token"] != a_token


def test_a_note_that_appears_during_the_wake_is_adopted_not_duplicated(hive_app):
    """Reconcile under the claim: if a First Light note is already in the chat when the owner comes to send, the owner
    sends nothing and the hello records that note."""
    app, c, hive, sup, ana, principal, mind = _setup(hive_app)
    real = hive.lifecycle
    planted = {}

    def lifecycle(agent_id, action, expect=None):
        planted["note"] = hive.enqueue_message(mind["id"], "First Light: (synthetic note from elsewhere)",
                                               hive.person_conversation(mind["id"], principal), onboarding.HELLO_SENDER)
        return real(agent_id, action, expect)
    hive.lifecycle = lifecycle
    try:
        r = c.post("/api/me/personal-mind/hello", headers=ana).json()
    finally:
        hive.lifecycle = real
    assert len(_notes(hive, mind["id"])) == 1 and r["message_id"] == planted["note"]["id"]
