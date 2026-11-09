"""Gateway gate A r1.1: the llm Idempotency-Key (browser-Iter plan r7.7 §6.2, §10; Dot's rulings of 3 Nov;
hive/core/mind_idempotency.py), and the mint rate limit (§11).

Synthetic people and the scripted model from the r1c tests: no network and no provider calls.
"""
import asyncio
import json
import os
import threading
import time

import pytest

from hive.core import mind_idempotency as idemmod
from hive.core.mind_gateway import MINTS_PER_HOUR, MindGateway
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1c import MSG, ORIGIN, call, code, gw, mint, open_turn, states  # noqa: F401  (fixture)

OTHER = {"messages": [{"role": "user", "content": "something else"}]}


def keyed(client, token, turn, key, body=None):  # noqa: F811
    return call(client, token, turn, body=body, extra={"Idempotency-Key": key})


def gateway_of(client):  # noqa: F811
    """The app's one MindGateway (the route's closure holds it)."""
    for route in client.app.routes:
        if getattr(route, "path", "") == "/api/me/mind/llm/v1/chat/completions":
            for cell in route.endpoint.__closure__ or ():
                if isinstance(cell.cell_contents, MindGateway):
                    return cell.cell_contents
    raise AssertionError("no gateway")


def records(hive):
    if hive.db.one("SELECT name FROM sqlite_master WHERE name = 'mind_idem'") is None:
        return []
    return hive.db.all("SELECT * FROM mind_idem ORDER BY created_at")


def turn_calls(hive, turn):
    return hive.db.one("SELECT calls FROM ask_turns WHERE id = ?", (turn,))["calls"]


# ---- a retry after success --------------------------------------------------------------------------------------------

def test_gatea_idem_a_retry_after_success_returns_the_same_answer_and_the_provider_is_called_once(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0001")
    first = keyed(client, token, turn, "op-idem-0001:1")
    assert first.status_code == 200 and "idempotent-replay" not in first.headers
    for _ in range(3):
        again = keyed(client, token, turn, "op-idem-0001:1")
        assert again.status_code == 200 and again.headers["idempotent-replay"] == "true"
        assert again.json() == first.json()
        assert {k: v for k, v in again.headers.items() if k.startswith("x-hive-")} == \
            {k: v for k, v in first.headers.items() if k.startswith("x-hive-")}
    assert len(gw["fake"].bodies) == 1 and states(hive) == ["settled"]
    assert turn_calls(hive, turn) == 1                                       # a replay spends no call
    assert [(r["state"], r["status"]) for r in records(hive)] == [("done", 200)]
    assert keyed(client, token, turn, "op-idem-0001:2").status_code == 200   # the next step is a new call
    assert len(gw["fake"].bodies) == 2


def test_gatea_idem_a_refusal_after_the_record_is_kept_too(gw):
    """An upstream failure after the send is a terminal answer: the retry gets it, with its held amount, and nothing
    is sent again."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0002")

    async def broken(agent, body):
        from hive.core.gateway import signal_send
        await signal_send()
        gw["fake"].bodies.append(body)
        raise RuntimeError("provider down")
    client.app.state.gateway.chat = broken
    first = keyed(client, token, turn, "op-idem-0002:1")
    assert (first.status_code, code(first)) == (502, "upstream_error")
    again = keyed(client, token, turn, "op-idem-0002:1")
    assert (again.status_code, again.json()) == (502, first.json()) and again.headers["idempotent-replay"] == "true"
    assert len(gw["fake"].bodies) == 1 and states(hive) == ["unknown"]


# ---- a race on one key ------------------------------------------------------------------------------------------------

def test_gatea_idem_a_concurrent_same_key_race_dispatches_exactly_once(gw):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].delay = 0.3
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0003")
    gate, out = threading.Barrier(6), []

    def one():
        gate.wait()
        out.append(keyed(client, token, turn, "op-idem-0003:1"))
    threads = [threading.Thread(target=one) for _ in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(20)
    ok = [r for r in out if r.status_code == 200 and "idempotent-replay" not in r.headers]
    busy = [r for r in out if r.status_code != 200]
    assert len(ok) == 1 and len(gw["fake"].bodies) == 1, [(r.status_code, r.text) for r in out]
    assert all((r.status_code, code(r)) == (409, "in_progress") for r in busy)
    assert states(hive) == ["settled"] and len(records(hive)) == 1
    later = keyed(client, token, turn, "op-idem-0003:1")
    assert later.status_code == 200 and later.json() == ok[0].json() and len(gw["fake"].bodies) == 1


def test_gatea_idem_the_record_commits_with_the_reservation_or_not_at_all(gw, monkeypatch):
    """A reservation refused after the key was written takes the record with it: the retry is a fresh attempt, not
    a stored refusal, and nothing was sent."""
    client, hive = gw["client"], gw["hive"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.0000001")
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0004")
    r = keyed(client, token, turn, "op-idem-0004:1")
    assert r.status_code == 402 and gw["fake"].bodies == []
    assert records(hive) == [] and states(hive) == []
    assert not gateway_of(client).idem._running


# ---- a crash between the send and the settle ----------------------------------------------------------------------

def test_gatea_idem_a_crash_after_dispatch_is_unknown_and_never_sent_again(gw):
    """The first call is held inside the provider (sent, not settled). A restart loses what this process was running;
    the record and the reservation are what survive. The retry, from a re-minted token, is 409 outcome_unknown and
    nothing is sent again, then or after the first call returns."""
    client, hive = gw["client"], gw["hive"]
    release = threading.Event()

    async def hung(agent, body):
        from hive.core.gateway import signal_send
        await signal_send()
        gw["fake"].bodies.append(body)
        for _ in range(250):   # held until released, at most 5 s (a regression must fail, not hang)
            if release.is_set():
                break
            await asyncio.sleep(0.02)
        return {"id": "r", "choices": [{"index": 0, "message": {"role": "assistant", "content": "late"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}}, \
            {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.001, "key_id": "env:fakepaid"}
    client.app.state.gateway.chat = hung
    a = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0005")
    first = []
    th = threading.Thread(target=lambda: first.append(keyed(client, a, turn, "op-idem-0005:1")))
    th.start()
    try:
        for _ in range(200):
            if gw["fake"].bodies:
                break
            time.sleep(0.02)
        assert len(gw["fake"].bodies) == 1 and states(hive) == ["dispatched"]
        assert [r["state"] for r in records(hive)] == ["pending"]
        gateway_of(client).idem._running.clear()                              # the restart: nothing runs it any more
        b = mint(client, gw["ann"])                                            # the broker's 401 cure: a new token
        for token in (b, a):
            r = keyed(client, token, turn, "op-idem-0005:1")
            assert (r.status_code, code(r)) == (409, "outcome_unknown"), r.text
        assert [r["state"] for r in records(hive)] == ["unknown"]
        release.set()
        th.join(10)
        r = keyed(client, b, turn, "op-idem-0005:1")
        assert (r.status_code, code(r)) == (409, "outcome_unknown")             # it stays unknown
    finally:
        release.set()   # never leave the provider hung, whatever failed
        th.join(10)
    assert len(gw["fake"].bodies) == 1


def test_gatea_idem_a_fresh_process_reads_a_pending_record_as_unknown(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0006")
    assert keyed(client, token, turn, "op-idem-0006:1").status_code == 200
    hive.db.execute("UPDATE mind_idem SET state = 'pending'")               # died after the send, before the answer was kept
    fresh = idemmod.MindIdempotency(hive)
    slot = idemmod.Slot("user:u_ann", gw["mine"]["id"], "op-idem-0006:1", records(hive)[0]["digest"])
    with pytest.raises(Exception) as caught:
        fresh.replay(slot, lambda cid: False)
    assert caught.value.code == "outcome_unknown"
    assert len(gw["fake"].bodies) == 1


# ---- the same key, something else -------------------------------------------------------------------------------------

def test_gatea_idem_the_same_key_with_a_different_body_or_turn_is_422_and_nothing_is_sent(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0007")
    assert keyed(client, token, turn, "op-idem-0007:1").status_code == 200
    r = keyed(client, token, turn, "op-idem-0007:1", body=OTHER)
    assert (r.status_code, code(r)) == (422, "idempotency_mismatch")
    r = keyed(client, token, turn, "op-idem-0007:1", body={**MSG, "max_tokens": 10})   # the same words, one more field
    assert (r.status_code, code(r)) == (422, "idempotency_mismatch")
    other_turn_header = call(client, token, "t-elsewhere", extra={"Idempotency-Key": "op-idem-0007:1"})
    assert (other_turn_header.status_code, code(other_turn_header)) == (422, "idempotency_mismatch")
    assert len(gw["fake"].bodies) == 1 and turn_calls(hive, turn) == 1


@pytest.mark.parametrize("value", ["", "has space", "x" * 129, "semi;colon", "slash/x", "a,b"])
def test_gatea_idem_a_malformed_key_is_400_before_anything(gw, value):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0008")
    r = call(client, token, turn, extra={"Idempotency-Key": value})
    assert r.status_code == 400 and gw["fake"].bodies == [] and turn_calls(hive, turn) == 0


# ---- scope: the person, not the token ----------------------------------------------------------------------------------

def test_gatea_idem_a_reminted_token_gets_the_stored_answer_for_a_lost_one(gw):
    """Dispatch under token A, lose the answer, re-mint to token B (and revoke A): B's retry with the same key and
    body is the stored answer, not a second dispatch."""
    client, hive = gw["client"], gw["hive"]
    a = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0009")
    lost = keyed(client, a, turn, "op-idem-0009:1")                        # the broker never saw this answer
    assert lost.status_code == 200
    assert client.delete("/api/me/mind/session", headers={**gw["ann"], **ORIGIN}).status_code == 200
    b = mint(client, gw["ann"])
    r = keyed(client, b, turn, "op-idem-0009:1")
    assert r.status_code == 200 and r.json() == lost.json() and r.headers["idempotent-replay"] == "true"
    assert len(gw["fake"].bodies) == 1 and turn_calls(hive, turn) == 1


def test_gatea_idem_keys_are_never_shared_across_persons(gw):
    client, hive = gw["client"], gw["hive"]
    bob_mind = hive.personal.ensure("user:u_bob")
    hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE id = ?", (bob_mind["id"],))
    ann_token, bob_token = mint(client, gw["ann"]), mint(client, gw["bob"])
    ann_turn = open_turn(client, gw["ann"], "op-idem-0010")
    assert keyed(client, ann_token, ann_turn, "shared:1").status_code == 200
    # Bob with Ann's key and Ann's turn: never her answer, never a mismatch on her record (his own namespace)
    r = keyed(client, bob_token, ann_turn, "shared:1")
    assert r.status_code == 404 and "idempotent-replay" not in r.headers and code(r) == "not_available"
    # Bob with the same key on his own turn: his own call, whatever it answers, and never Ann's stored one
    bob_turn = open_turn(client, gw["bob"], "op-idem-0011")
    r = keyed(client, bob_token, bob_turn, "shared:1")
    assert "idempotent-replay" not in r.headers and code(r) != "idempotency_mismatch"
    assert {x["principal"] for x in records(hive)} <= {"user:u_ann", "user:u_bob"}
    assert [x["principal"] for x in records(hive)].count("user:u_ann") == 1


def test_gatea_idem_no_key_means_no_dedupe(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0012")
    assert call(client, token, turn).status_code == 200 and call(client, token, turn).status_code == 200
    assert len(gw["fake"].bodies) == 2 and records(hive) == []              # documented: the broker always sends one


def answers_held(client):  # noqa: F811
    return gateway_of(client).idem.answers().one("SELECT COUNT(*) AS n FROM mind_idem_answers")["n"]


def age(hive, seconds=None):
    """Move every record and stored answer past its hour (or by `seconds`), as time passing would."""
    when = time.time() - (idemmod.KEEP_SECONDS + 1 if seconds is None else seconds)
    hive.db.execute("UPDATE mind_idem SET created_at = ?", (when,))
    answers = hive.mind_idempotency.answers()
    answers.execute("UPDATE mind_idem_answers SET created_at = ?", (when,))


def test_gatea_idem_expiry_after_success_is_replay_expired_never_resent(gw):
    """Dot (3 Nov): stored answers are kept 1 h. After that the key has no record, but its reservation (settled) does:
    409 replay_expired, for the same body and for another one; nothing is sent (stand-in r1.1 P1-1)."""
    client, hive = gw["client"], gw["hive"]
    assert idemmod.KEEP_SECONDS == 3600
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0014")
    assert keyed(client, token, turn, "op-idem-0014:1").status_code == 200
    age(hive, 3599)
    assert keyed(client, token, turn, "op-idem-0014:1").headers["idempotent-replay"] == "true"   # inside the hour
    age(hive)
    for body in (None, OTHER):
        r = keyed(client, token, turn, "op-idem-0014:1", body=body)
        assert (r.status_code, code(r)) == (409, "replay_expired"), r.text
    hive.mind_idempotency.sweep()                                            # the request path never sweeps (r1.3)
    assert records(hive) == [] and answers_held(client) == 0                 # the answer is gone
    assert len(gw["fake"].bodies) == 1 and states(hive) == ["settled"] and turn_calls(hive, turn) == 1


@pytest.mark.parametrize("later", ["unknown", "unknown_settled_at_worst_case"])
def test_gatea_idem_expiry_after_an_unknown_outcome_stays_unknown_never_resent(gw, later):
    client, hive = gw["client"], gw["hive"]

    async def broken(agent, body):
        from hive.core.gateway import signal_send
        await signal_send()
        gw["fake"].bodies.append(body)
        raise RuntimeError("provider down")
    client.app.state.gateway.chat = broken
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0017")
    assert code(keyed(client, token, turn, "op-idem-0017:1")) == "upstream_error" and states(hive) == ["unknown"]
    if later == "unknown_settled_at_worst_case":   # cost_reservations.expire_unknown at 24 h: settled, unknown_at kept
        hive.db.execute("UPDATE cost_reservations SET state = 'settled', actual = maximum")
    age(hive)
    client.app.state.gateway.chat = gw["fake"].chat
    for body in (None, OTHER):
        r = keyed(client, token, turn, "op-idem-0017:1", body=body)
        assert (r.status_code, code(r)) == (409, "outcome_unknown"), r.text
    assert len(gw["fake"].bodies) == 1


def test_gatea_idem_expiry_after_a_held_reservation_stays_unknown_never_resent(gw):
    """A call sent and never answered (the reservation still dispatched, its record pending: a crash), past the hour."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0018")
    assert keyed(client, token, turn, "op-idem-0018:1").status_code == 200
    hive.db.execute("UPDATE cost_reservations SET state = 'dispatched', actual = NULL")   # as if it died after the send
    hive.db.execute("UPDATE mind_idem SET state = 'pending'")
    age(hive)
    for body in (None, OTHER):
        r = keyed(client, token, turn, "op-idem-0018:1", body=body)
        assert (r.status_code, code(r)) == (409, "outcome_unknown"), r.text
    assert len(gw["fake"].bodies) == 1 and states(hive) == ["dispatched"]


def test_gatea_idem_the_reservation_itself_refuses_a_resend_when_the_record_is_gone(gw, monkeypatch):
    """Even past the replay check (it is skipped here), reserving under the key again never sends: the reservation id
    is the key's, so the reservation answers by its own state."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0015")
    assert keyed(client, token, turn, "op-idem-0015:1").status_code == 200
    hive.db.execute("DELETE FROM mind_idem")
    monkeypatch.setattr(hive.mind_idempotency, "replay", lambda slot, reservation: None)
    for body in (None, OTHER):
        r = keyed(client, token, turn, "op-idem-0015:1", body=body)
        assert (r.status_code, code(r)) == (409, "replay_expired"), r.text
    hive.db.execute("UPDATE cost_reservations SET state = 'unknown'")
    assert code(keyed(client, token, turn, "op-idem-0015:1")) == "outcome_unknown"
    assert len(gw["fake"].bodies) == 1
    assert hive.db.one("SELECT state FROM ask_turns WHERE id = ?", (turn,))["state"] == "browser"   # the turn is untouched


def test_gatea_idem_the_reconcile_pass_erases_answers_past_their_hour_without_traffic(gw):
    """Stand-in r1.1 P1-2: no keyed traffic for over an hour, then one production reconcile pass: the answer is gone."""
    from types import SimpleNamespace

    from hive.tests.test_studio_session_r3 import on_loop
    client, hive = gw["client"], gw["hive"]
    x = SimpleNamespace(client=client)
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0019")
    gw["fake"].text = "a passing answer"
    assert keyed(client, token, turn, "op-idem-0019:1").status_code == 200 and answers_held(client) == 1
    on_loop(x, client.app.state.reconcile_once)
    assert answers_held(client) == 1                                         # inside its hour it stays
    age(hive)
    on_loop(x, client.app.state.reconcile_once)
    assert answers_held(client) == 0 and records(hive) == []
    raw = b"".join((hive.settings.data_dir / (idemmod.DB_NAME + x)).read_bytes() for x in ("", "-wal")
                   if (hive.settings.data_dir / (idemmod.DB_NAME + x)).exists())
    assert b"a passing answer" not in raw                                    # erased, not just unlinked (secure_delete)


def test_gatea_idem_startup_sweeps_and_a_hive_that_never_ran_the_gateway_makes_nothing(gw):
    client, hive = gw["client"], gw["hive"]
    path = hive.settings.data_dir / idemmod.DB_NAME
    assert not path.exists()                                                 # create_app's startup sweep made nothing
    fresh = idemmod.MindIdempotency(hive)
    assert fresh.sweep_quietly() == 0 and not path.exists()
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0020")
    assert keyed(client, token, turn, "op-idem-0020:1").status_code == 200
    age(hive)
    restarted = idemmod.MindIdempotency(hive)                                # what the next start runs
    assert restarted.sweep_quietly() == 1 and answers_held(client) == 0


def test_gatea_idem_a_free_call_past_the_hour_is_a_fresh_call(gw):
    client, hive = gw["client"], gw["hive"]
    hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (gw["mine"]["id"],))
    gw["fake"].cost = 0.0
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0016")
    assert keyed(client, token, turn, "op-idem-0016:1").status_code == 200 and states(hive) == []
    assert keyed(client, token, turn, "op-idem-0016:1").headers["idempotent-replay"] == "true"
    assert len(gw["fake"].bodies) == 1
    age(hive)
    r = keyed(client, token, turn, "op-idem-0016:1")
    assert r.status_code == 200 and "idempotent-replay" not in r.headers and len(gw["fake"].bodies) == 2
    assert answers_held(client) == 1                                         # the expired answer erased, the new one kept


def test_gatea_idem_the_stored_answer_is_apart_from_hive_db(gw):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].text = "a distinctive answer"
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0013")
    assert keyed(client, token, turn, "op-idem-0013:1").status_code == 200
    assert "distinctive" not in str(records(hive))
    stored = gateway_of(client).idem.answers().all("SELECT body FROM mind_idem_answers")
    assert len(stored) == 1 and "distinctive" in stored[0]["body"]


# ---- the mint rate limit -------------------------------------------------------------------------------------------

def test_gatea_mint_at_most_ten_per_person_per_hour_across_sessions(gw):
    client, hive = gw["client"], gw["hive"]
    for _ in range(MINTS_PER_HOUR):
        mint(client, gw["ann"])
    r = client.post("/api/me/mind/session", headers={**gw["ann"], **ORIGIN}, json={})
    assert (r.status_code, code(r)) == (429, "mint_rate_limited") and "token" not in r.json()
    assert hive.db.one("SELECT COUNT(*) AS n FROM mind_tokens WHERE principal = 'user:u_ann'")["n"] == MINTS_PER_HOUR
    mint(client, gw["bob"])                                                 # another person is untouched
    hive.db.execute("UPDATE mind_tokens SET created_at = created_at - 3601 WHERE principal = 'user:u_ann'")
    mint(client, gw["ann"])                                                 # an hour on, the window has moved


# ---- r1.2: the sweep depends on nothing else succeeding (stand-in r1.2 P1s, Kimi r1.1 P2/P3) ---------------------------

def one_answer(gw, op, text="an answer to forget"):
    client = gw["client"]
    gw["fake"].text = text
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], op)
    assert keyed(client, token, turn, op + ":1").status_code == 200 and answers_held(client) == 1
    return token, turn


def answer_bytes(hive):
    d = hive.settings.data_dir
    return b"".join((d / (idemmod.DB_NAME + x)).read_bytes() for x in ("", "-wal") if (d / (idemmod.DB_NAME + x)).exists())


@pytest.mark.parametrize("broken", ["scheduler", "supervisor"])
def test_gatea_idem_r12_a_failing_reconcile_step_never_skips_the_sweep(gw, monkeypatch, broken):
    from types import SimpleNamespace

    from hive.tests.test_studio_session_r3 import on_loop
    client, hive = gw["client"], gw["hive"]
    one_answer(gw, "op-idem-0021")

    def boom(*_a, **_k):
        raise RuntimeError("an unrelated step fails every pass")
    if broken == "scheduler":
        async def tick():
            boom()
        monkeypatch.setattr(hive.scheduler, "tick", tick)
    else:
        monkeypatch.setattr(hive.supervisor, "check", boom)
    age(hive)
    on_loop(SimpleNamespace(client=client), client.app.state.reconcile_once)
    assert answers_held(client) == 0 and b"an answer to forget" not in answer_bytes(hive)


def test_gatea_idem_r12_the_backstop_sweeper_runs_with_no_reconcile_loop(gw, monkeypatch):
    """The test app has no reconcile loop at all (reconcile_seconds=0): the lifespan's own sweeper erases it."""
    client, hive = gw["client"], gw["hive"]
    one_answer(gw, "op-idem-0022")
    age(hive)
    monkeypatch.setattr(idemmod, "SWEEP_SECONDS", 0)
    for _ in range(80):
        if answers_held(client) == 0:
            break
        time.sleep(0.1)
    assert answers_held(client) == 0


def test_gatea_idem_r12_answers_go_by_their_own_age_and_orphans_go_too(gw, monkeypatch):
    client, hive = gw["client"], gw["hive"]
    token, turn = one_answer(gw, "op-idem-0023")
    store, answers = hive.mind_idempotency, hive.mind_idempotency.answers()
    # the record still inside its hour, its answer past it: the answer goes by its own age
    answers.execute("UPDATE mind_idem_answers SET created_at = ?", (time.time() - idemmod.KEEP_SECONDS - 1,))
    store.sweep()
    assert answers_held(client) == 0 and len(records(hive)) == 1
    # an orphan (its record deleted, as by a crash between the two files): gone once ORPHAN_GRACE old, not before
    assert keyed(client, token, turn, "op-idem-0023:2").status_code == 200 and answers_held(client) == 1
    hive.db.execute("DELETE FROM mind_idem")
    store.sweep()
    assert answers_held(client) == 1                                         # inside the grace: maybe being written
    answers.execute("UPDATE mind_idem_answers SET created_at = ?", (time.time() - idemmod.ORPHAN_GRACE - 1,))
    store.sweep()
    assert answers_held(client) == 0


def files_holding(hive, text):
    """Every file under the hive's data directory whose bytes hold `text` (the db, a journal, any temp, anything)."""
    found = []
    for path in hive.settings.data_dir.rglob("*"):
        if path.is_file():
            try:
                if text.encode() in path.read_bytes():
                    found.append(path.name)
            except OSError:
                pass
    return found


def test_gatea_idem_r13_the_answers_file_has_no_wal_secure_delete_and_mode_0600(gw):
    import stat
    client, hive = gw["client"], gw["hive"]
    one_answer(gw, "op-idem-0028")
    answers = hive.mind_idempotency.answers()
    assert answers.one("PRAGMA journal_mode")["journal_mode"] == "delete"
    assert answers.execute("PRAGMA secure_delete").fetchone()[0] == 1
    assert answers.execute("PRAGMA synchronous").fetchone()[0] == 2                     # FULL
    path = hive.settings.data_dir / idemmod.DB_NAME
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not (hive.settings.data_dir / (idemmod.DB_NAME + "-wal")).exists()
    assert not (hive.settings.data_dir / (idemmod.DB_NAME + "-journal")).exists()       # only during a transaction


def test_gatea_idem_r13_an_erased_answer_is_in_no_file_even_with_another_connection_of_ours_open(gw):
    """Stand-in r1.3 P1-1: with no WAL there is nothing a reader can pin. Another connection of ours stays open across
    the erase (short autocommit reads, as all of ours are); afterwards the answer is in no file of the directory."""
    import sqlite3
    client, hive = gw["client"], gw["hive"]
    one_answer(gw, "op-idem-0029", "a pinned answer")
    assert files_holding(hive, "a pinned answer") == [idemmod.DB_NAME]
    other = sqlite3.connect(str(hive.settings.data_dir / idemmod.DB_NAME))
    try:
        assert other.execute("SELECT COUNT(*) FROM mind_idem_answers").fetchone()[0] == 1   # a read, then idle
        age(hive)
        assert hive.mind_idempotency.sweep() == 1
        assert other.execute("SELECT COUNT(*) FROM mind_idem_answers").fetchone()[0] == 0
        assert files_holding(hive, "a pinned answer") == []
    finally:
        other.close()
    assert files_holding(hive, "a pinned answer") == []


@pytest.mark.parametrize("via", ["sweep", "reconcile"])
def test_gatea_idem_r13_hive_db_failing_every_read_still_erases_expired_answers(gw, monkeypatch, via):
    """Stand-in r1.3 P1-2: step 1 reads nothing in hive.db, so a broken hive.db never keeps an answer past its hour."""
    from types import SimpleNamespace

    from hive.tests.test_studio_session_r3 import on_loop
    client, hive = gw["client"], gw["hive"]
    one_answer(gw, "op-idem-0030", "an answer behind a broken hive")
    age(hive)

    def broken(*_a, **_k):
        raise RuntimeError("hive.db is failing")
    for name in ("one", "all", "execute", "transaction"):
        monkeypatch.setattr(hive.db, name, broken)
    if via == "sweep":
        assert hive.mind_idempotency.sweep_quietly() == 1
    else:
        on_loop(SimpleNamespace(client=client), client.app.state.reconcile_once)
    monkeypatch.undo()
    assert answers_held(client) == 0 and files_holding(hive, "an answer behind a broken hive") == []


def test_gatea_idem_r13_a_failing_step_never_skips_the_others(gw, monkeypatch):
    """Step 1 failing (the answers' age query) still runs the orphan and record steps; each is logged on its own."""
    client, hive = gw["client"], gw["hive"]
    token, turn = one_answer(gw, "op-idem-0031")
    hive.db.execute("DELETE FROM mind_idem")                                   # an orphan
    hive.mind_idempotency.answers().execute("UPDATE mind_idem_answers SET created_at = ?",
                                            (time.time() - idemmod.ORPHAN_GRACE - 1,))
    real = hive.mind_idempotency.answers().erase

    def erase(sql, params=()):
        if "created_at <=" in sql:
            raise RuntimeError("step 1 fails")
        return real(sql, params)
    monkeypatch.setattr(hive.mind_idempotency.answers(), "erase", erase)
    assert hive.mind_idempotency.sweep() == 1 and answers_held(client) == 0


def test_gatea_idem_r13_the_backstop_is_its_own_thread(gw):
    assert any(t.name == "mind-answer-sweeper" and t.is_alive() and t.daemon for t in threading.enumerate())


def plant(hive, n, text="a planted answer", age_s=None):
    """n answers straight into the answers' file (no hive.db), past their hour unless age_s says otherwise."""
    answers = hive.mind_idempotency.answers()
    when = time.time() - (idemmod.KEEP_SECONDS + 1 if age_s is None else age_s)
    with answers.transaction():
        for _ in range(n):
            answers.execute("INSERT INTO mind_idem_answers VALUES (?, ?, ?, ?)",
                            (f"mi_{os.urandom(8).hex()}", json.dumps({"t": text}), "{}", when))


class HeldLock:
    """Holds a lock from another thread until released, as a stuck hive.db connection would."""

    def __init__(self, lock):
        self.lock, self.go, self.held = lock, threading.Event(), threading.Event()
        self.thread = threading.Thread(target=self._hold, daemon=True)
        self.thread.start()
        assert self.held.wait(5)

    def _hold(self):
        with self.lock:
            self.held.set()
            self.go.wait(30)

    def release(self):
        self.go.set()
        self.thread.join(5)


def test_gatea_idem_r14_a_stuck_hive_db_never_stops_step_1_on_any_pass(gw, monkeypatch):
    """Stand-in r1.4 P1-2: hive.db is held for the whole test. Every pass still erases the answers past their hour
    (step 1), and skips steps 2-3 after HIVE_DB_WAIT."""
    hive = gw["hive"]
    monkeypatch.setattr(idemmod, "HIVE_DB_WAIT", 0.2)
    hive.mind_idempotency.records()
    stuck = HeldLock(hive.db._lock)
    try:
        for n in (1, 2, 3):
            plant(hive, n, f"pass {n} answer")
            started = time.monotonic()
            assert hive.mind_idempotency.sweep_quietly() == n
            assert time.monotonic() - started < 3
            assert files_holding(hive, f"pass {n} answer") == []
    finally:
        stuck.release()


def test_gatea_idem_r14_a_pass_stuck_in_steps_2_3_never_holds_up_the_next_passs_step_1(gw, monkeypatch):
    """One pass waits in steps 2-3 on a stuck hive.db (HIVE_DB_WAIT long); a second pass meanwhile erases at once and
    skips steps 2-3 without waiting."""
    hive = gw["hive"]
    monkeypatch.setattr(idemmod, "HIVE_DB_WAIT", 5.0)
    store = hive.mind_idempotency
    store.records()
    store.answers()                                                           # the file exists, so passes run
    stuck = HeldLock(hive.db._lock)
    first = threading.Thread(target=store.sweep_quietly, daemon=True)
    try:
        first.start()
        for _ in range(50):   # until the first pass is in steps 2-3
            if store._upkeep.locked():
                break
            time.sleep(0.02)
        assert store._upkeep.locked()
        plant(hive, 2, "an answer behind a stuck pass")
        started = time.monotonic()
        assert store.sweep_quietly() == 2
        assert time.monotonic() - started < 1.0
        assert files_holding(hive, "an answer behind a stuck pass") == []
    finally:
        stuck.release()
        first.join(10)


def test_gatea_idem_r14_the_startup_sweep_erases_after_a_restart_with_expired_rows(gw):
    """Stand-in r1.4 P1-1, the stated bound: after a stop or a crash, the next start's sweep (on a new connection,
    after SQLite's own recovery) erases what expired meanwhile."""
    hive = gw["hive"]
    plant(hive, 2, "an answer from before the stop")
    hive.mind_idempotency.answers()._conn.close()                             # the old process is gone
    restarted = idemmod.MindIdempotency(hive)
    assert restarted.sweep_quietly() == 2
    assert files_holding(hive, "an answer from before the stop") == []


def test_gatea_idem_r14_the_startup_sweep_erases_after_a_hot_journal(gw, tmp_path):
    """A crash in the middle of an erase, as near as a test can: a copy of the files taken while a delete of the
    answers is open (its rollback journal holding the old pages, plaintext included) is opened as a restart would.
    SQLite rolls the journal back on open, and the startup sweep then erases the answers; nothing of them is left."""
    import shutil
    import sqlite3
    from types import SimpleNamespace
    hive = gw["hive"]
    plant(hive, 3, "an answer caught mid-erase")
    hive.mind_idempotency.answers()._conn.close()
    src = hive.settings.data_dir / idemmod.DB_NAME
    writer = sqlite3.connect(str(src), isolation_level=None)
    writer.execute("PRAGMA cache_size = 1")                                   # spill: the db file changes before commit
    writer.execute("PRAGMA secure_delete = ON")
    writer.execute("BEGIN IMMEDIATE")
    writer.execute("DELETE FROM mind_idem_answers")
    crashed = tmp_path / "crashed"
    crashed.mkdir()
    for name in (idemmod.DB_NAME, idemmod.DB_NAME + "-journal"):
        if (src.parent / name).exists():
            shutil.copy2(src.parent / name, crashed / name)
    writer.execute("ROLLBACK")
    writer.close()
    assert (crashed / (idemmod.DB_NAME + "-journal")).exists()
    restarted = idemmod.MindIdempotency(SimpleNamespace(settings=SimpleNamespace(data_dir=crashed), db=hive.db))
    assert restarted.sweep_quietly() == 3
    held = [p.name for p in crashed.iterdir() if b"an answer caught mid-erase" in p.read_bytes()]
    assert held == []


def test_gatea_idem_r14_a_wal_left_by_an_older_build_is_folded_in_and_gone(gw, tmp_path):
    """Kimi r1.3 P2 #1: a -wal from r1.2 (answers kept in WAL) is checkpointed into the main file and removed before
    the switch to DELETE; its plaintext is then erased like any expired answer."""
    import shutil
    import sqlite3
    from types import SimpleNamespace
    hive = gw["hive"]
    old = tmp_path / "older"
    old.mkdir()
    conn = sqlite3.connect(str(old / idemmod.DB_NAME), isolation_level=None)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA wal_autocheckpoint = 0")
    conn.execute(idemmod.ANSWERS[0])
    conn.execute("INSERT INTO mind_idem_answers VALUES ('mi_old', '\"a walled old answer\"', '{}', ?)",
                 (time.time() - idemmod.KEEP_SECONDS - 1,))
    left = tmp_path / "left"
    left.mkdir()
    for name in (idemmod.DB_NAME, idemmod.DB_NAME + "-wal"):
        shutil.copy2(old / name, left / name)                                 # what a crashed r1.2 process left
    conn.close()
    assert (left / (idemmod.DB_NAME + "-wal")).stat().st_size > 0
    store = idemmod.MindIdempotency(SimpleNamespace(settings=SimpleNamespace(data_dir=left), db=hive.db))
    answers = store.answers()
    assert answers.one("PRAGMA journal_mode")["journal_mode"] == "delete"
    assert not (left / (idemmod.DB_NAME + "-wal")).exists()
    assert answers.one("SELECT COUNT(*) AS n FROM mind_idem_answers")["n"] == 1   # folded in, not lost
    assert store.sweep_quietly() == 1
    assert [p.name for p in left.iterdir() if b"a walled old answer" in p.read_bytes()] == []


def test_gatea_idem_r14_replay_and_claim_judge_the_hour_by_one_clock_reading(gw):
    """Kimi r1.3 P2 #2: at exactly KEEP_SECONDS both treat the record as gone; a hair inside, both as live. The reading
    is the request's (here 10 s old, as a slow request's would be): time passing after it never changes the verdict."""
    hive = gw["hive"]
    store = hive.mind_idempotency
    store.records()
    now = time.time() - 10
    for age_s, live in ((idemmod.KEEP_SECONDS, False), (idemmod.KEEP_SECONDS - 0.001, True)):
        hive.db.execute("DELETE FROM mind_idem")
        hive.db.execute("INSERT INTO mind_idem (principal, idem_key, mind_id, digest, call_id, state, status, created_at) "
                        "VALUES ('user:u_ann', 'k:1', ?, 'd', 'mi_x', 'unknown', NULL, ?)", (gw["mine"]["id"], now - age_s))
        slot = idemmod.Slot("user:u_ann", gw["mine"]["id"], "k:1", "d", now)
        if live:
            with pytest.raises(Exception) as caught:
                store.replay(slot, lambda cid: None)
            assert caught.value.code == "outcome_unknown"
            with pytest.raises(idemmod.KeyTaken):
                with hive.db.transaction():
                    store.claim(slot, "mi_y")
        else:
            assert store.replay(slot, lambda cid: None) is None
            with hive.db.transaction():
                store.claim(slot, "mi_y")
            assert hive.db.one("SELECT call_id FROM mind_idem")["call_id"] == "mi_y"
            store.leave(slot)


def test_gatea_idem_r13_the_request_path_never_sweeps(gw, monkeypatch):
    client, hive = gw["client"], gw["hive"]

    def no(*_a, **_k):
        raise AssertionError("the request path swept")
    monkeypatch.setattr(hive.mind_idempotency, "sweep", no)
    monkeypatch.setattr(hive.mind_idempotency, "sweep_quietly", no)
    token, turn = one_answer(gw, "op-idem-0033")
    assert keyed(client, token, turn, "op-idem-0033:1").headers["idempotent-replay"] == "true"
    age(hive)                                                                    # past its hour, not yet swept
    assert code(keyed(client, token, turn, "op-idem-0033:1")) == "replay_expired"
    assert len(gw["fake"].bodies) == 1


def test_gatea_idem_r12_claim_runs_inside_reserves_budgets_callback(gw, monkeypatch):
    """Kimi r1.1 P2 #2, pinned: the record is claimed while Reservations.reserve runs, inside its open transaction."""
    client, hive = gw["client"], gw["hive"]
    res, store = gateway_of(client).reservations, hive.mind_idempotency
    inside, seen = [], []
    real_reserve, real_claim = res.reserve, store.claim

    def reserve(*a, **k):
        inside.append(True)
        try:
            return real_reserve(*a, **k)
        finally:
            inside.pop()

    def claim(slot, call_id):
        seen.append((bool(inside), hive.db._conn.in_transaction))
        return real_claim(slot, call_id)
    monkeypatch.setattr(res, "reserve", reserve)
    monkeypatch.setattr(store, "claim", claim)
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0026")
    assert keyed(client, token, turn, "op-idem-0026:1").status_code == 200
    assert seen == [(True, True)]


def test_gatea_idem_r12_a_keyed_429_keeps_no_record_and_the_retry_is_fresh(gw, monkeypatch):
    """Kimi r1.1 P3 #3: a rate limit at check_budget comes before the record, as a 402 does."""
    from hive.core.hive import HiveError
    client, hive = gw["client"], gw["hive"]
    real, calls = hive.check_budget, []

    def limited(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise HiveError(429, "rate_limited", "slow down")
        return real(*a, **k)
    monkeypatch.setattr(hive, "check_budget", limited)
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idem-0027")
    r = keyed(client, token, turn, "op-idem-0027:1")
    assert (r.status_code, code(r)) == (429, "rate_limited") and records(hive) == [] and gw["fake"].bodies == []
    r = keyed(client, token, turn, "op-idem-0027:1")
    assert r.status_code == 200 and "idempotent-replay" not in r.headers and len(gw["fake"].bodies) == 1
