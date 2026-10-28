"""J3 host round R4 (money at call time): a Studio maker's paid calls are bound to one step and one execution.

Plan PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md: §3.6 "Gateway", §6, §8 rows O2-d/e/f/i/j, r1.1 S1 (S1-b, S1-c), S5 (S5-a,
S5-b), K5 (O2-e'), r1.2 E1 and E6.1, r1.3 F1 (F1-b..e, F1-i), r1.4 G1 (F1-a, F1-a2, F1-a3) and G3, r1.8 L6; handoff spec
r2.5 amendment (L6 moved to R4); the R3 follow-ups (epoch on reservations and the <= k filter; the Mac gate's
TRY_SLEEP_ONCE branch; Kimi R3.2 P3). Synthetic only: the real Supervisor over a fake process driver (test_studio_session_r3),
a priced stand-in provider whose chat is a script (no network, no paid call), temporary data directories, no live hive."""
import asyncio
import http.server
import json
import os
import secrets
import subprocess
import threading

import pytest

from hive.core.gateway import GatewayError, signal_send
from hive.tests.test_studio_session_r3 import (Hub, connect, done, drive, epoch_of, in_step, maker_headers,  # noqa: F401
                                               mount, on_loop, open_session, outcome, publish, r3, ses_row, started,
                                               step_row, tick, token_now, upload)
from hive.tests.test_studio_session_r3_handoff import (SAFE_RESTART, _db_copy, control, handoff, new_mind, past,  # noqa: F401
                                                       ready2, restart, stop, stopped_and_released, studio, wait_for)
from hive.tests.test_ask_intents import a, held, release  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, MODEL, add_key, err, s  # noqa: F401

PRICE = {"in": 100, "out": 100}            # USD per million tokens: a call here reserves about a cent


class Transport:
    """The provider: a script standing in for gateway.chat. It awaits the send gate exactly where the real transport does
    (signal_send), records what was sent, and can run a hook before the gate, park after it, or fail."""

    def __init__(self, cost=0.002):
        self.cost, self.sent, self.before, self.park, self.fail = cost, [], {}, {}, set()
        self.parked, self.key_of = [], None

    async def chat(self, agent, body):
        hook = self.before.pop(agent["id"], None)
        if hook is not None:
            hook()
        await signal_send()
        self.sent.append(agent["id"])
        parked = self.park.pop(agent["id"], None)
        if parked is not None:
            self.parked.append(parked)
            entered, go = parked
            entered.set()
            while not go.is_set():
                await asyncio.sleep(0.02)
        if agent["id"] in self.fail:
            raise GatewayError(502, "upstream_error", "the provider failed after the call was sent")
        response = {"id": "fake-r4", "model": agent["model"],
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5}}
        key_id = self.key_of(agent) if self.key_of else None                # as the real chat reports its paying key
        return response, {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": self.cost, "key_id": key_id}


@pytest.fixture()
def r4(r3, monkeypatch):
    """R3's world with the maker's model priced and the provider scripted."""
    hive = r3.hive
    monkeypatch.setattr(hive.settings.providers["openrouter"], "prices", {"test/maker": PRICE, "test/embed": PRICE})
    r3.transport = Transport()
    gw = r3.client.app.state.gateway
    r3.transport.key_of = lambda agent: gw.paying_key(agent, "openrouter")[0]
    monkeypatch.setattr(r3.client.app.state.gateway, "chat", r3.transport.chat)
    yield r3
    for entered, go in list(r3.transport.park.values()) + r3.transport.parked:
        go.set()                                                           # never leave a request parked after a failure




BODY = {"messages": [{"role": "user", "content": "draw the headline"}], "max_tokens": 100}


def chat(x, headers=None, body=None):
    return x.client.post("/llm/v1/chat/completions", headers=headers or maker_headers(x), json=body or BODY)


def in_thread(fn, *args):
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", fn(*args)), daemon=True)
    t.start()
    return t, out


def reservations_of(x, agent_id=None):
    rows = x.hive.db.all("SELECT r.*, d.metadata FROM cost_reservations r JOIN cost_reservation_details d ON d.reservation = r.id "
                         "WHERE json_extract(d.metadata, '$.agent') = ? ORDER BY r.rowid", (agent_id or x.maker["id"],))
    for r in rows:
        r["metadata"] = json.loads(r["metadata"])
        r["scopes"] = sorted(s["scope"] for s in x.hive.db.all("SELECT scope FROM cost_reservation_scopes WHERE reservation = ?",
                                                               (r["id"],)))
    return rows


def fenced(x, epoch):
    return bool(x.hive.db.one("SELECT 1 FROM studio_fenced_executions WHERE maker_id = ? AND token_epoch = ?",
                              (x.maker["id"], epoch)))


def commit_done(x, sid, n):
    """Exactly the transaction done() commits (studio_steps.done): the step finished and its (maker, epoch) fence row,
    together. Used where a test needs done to commit at a point inside a request (between the door and the reservation, or
    between the reservation and the send) that an HTTP done cannot reach."""
    st = x.hive.studio
    with x.hive.db.transaction():
        row, step = st._session(sid), st._step(sid, n)
        x.hive.db.execute("UPDATE studio_steps SET state = 'finished', more = 1, done_at = ?, closed_at = ? WHERE session_id = ? "
                          "AND n = ? AND state = 'admitted'", ("2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z", sid, n))
        st._end_execution(row, step, "done")


def before_reservation(x, monkeypatch, fn):
    """Run fn once, after the gateway's door and its step binding and before its reservation (inside Hive.check_budget,
    the last thing the route does before it reserves)."""
    original = x.hive.check_budget
    calls = []

    def check_budget(*args, **kwargs):
        if not calls:
            calls.append(1)
            fn()
        return original(*args, **kwargs)
    monkeypatch.setattr(x.hive, "check_budget", check_budget)


# ---- O2-d / O2-e / E1: the call is bound to its step, reserved under the session and step labels ------------------------

def test_O2d_a_paid_call_with_no_open_step_is_409_with_no_reservation(r4):
    session = open_session(r4)
    m = mount(r4, session["session_id"], session["stream_id"]).json()
    assert m["mount_epoch"] == 1
    r = chat(r4)
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text
    assert reservations_of(r4) == [] and r4.transport.sent == []


def test_O2e_E1_a_call_in_its_step_is_reserved_under_both_labels_gated_and_settled_on_them(r4):
    from hive.core.studio_sessions import scope_label, step_label
    session, sid, m, ack, step = started(r4)
    r = chat(r4)
    assert r.status_code == 200, r.text
    [res] = reservations_of(r4)
    assert {scope_label(sid), step_label(sid, 1)} <= set(res["scopes"])
    meta = res["metadata"]
    assert (meta["studio_session"], meta["studio_step"], meta["execution_id"], meta["maker_execution"], meta["token_epoch"]) == \
        (sid, 1, step["execution_id"], step["maker_execution"], step["token_epoch"])
    assert res["state"] == "settled" and res["actual"] == 2000 and res["dispatched_at"] is not None
    assert r4.transport.sent == [r4.maker["id"]]
    assert studio(r4).scope_spent(step_label(sid, 1)) == pytest.approx(0.002)
    assert studio(r4).scope_spent(scope_label(sid)) == pytest.approx(0.002)


def test_O2e_over_the_step_cap_is_402_the_step_ends_refused_budget_and_the_session_pauses(r4):
    session, sid, m, ack, step = started(r4)
    r4.hive.db.execute("UPDATE studio_sessions SET step_cap_usd = 0.001 WHERE id = ?", (sid,))   # below one call's worst case
    r = chat(r4)
    assert r.status_code == 402, r.text
    assert err(r)["scope"] == f"studiostep:{sid}:1"
    assert reservations_of(r4) == [] and r4.transport.sent == []
    s1 = step_row(r4, sid, 1)
    assert (s1["state"], s1["closed_reason"]) == ("refused_budget", "budget_exhausted")
    assert (ses_row(r4, sid)["state"], ses_row(r4, sid)["state_reason"]) == ("paused", "budget_exhausted")
    assert fenced(r4, step["token_epoch"])                                 # the step's execution makes no more calls
    assert err(chat(r4))["code"] == "studio_fenced"


def test_O2e_prime_the_studio_labels_have_no_subject_and_two_sessions_never_count_against_each_other(r4):
    from hive.core.cost_reservations import BudgetExhausted, Reservations, subject_of
    assert subject_of("studio:ss_" + "a" * 24) is None and subject_of(f"studiostep:ss_{'a' * 24}:3") is None
    res = Reservations(r4.hive.db)
    a_, b_ = "studio:ss_" + "a" * 24, "studio:ss_" + "b" * 24
    res.reserve("k-a", {"n": 1}, 0.9, lambda: [(a_, 1.0, 0)])
    res.reserve("k-b", {"n": 2}, 0.9, lambda: [(b_, 1.0, 0)])            # A's hold is not B's
    with pytest.raises(BudgetExhausted):
        res.reserve("k-a2", {"n": 3}, 0.2, lambda: [(a_, 1.0, 0)])        # A's own hold counts on A's exact label
    assert res.pending(a_) == res.pending(b_) == 900_000


def test_O2f_stop_committed_between_reserve_and_send_aborts_releases_and_nothing_is_sent(r4):
    session, sid, m, ack, step = started(r4)

    def stop_now():
        with r4.hive.db.transaction():
            studio(r4).stop_session(sid)                                    # Stop's one transaction (the control's)
    r4.transport.before[r4.maker["id"]] = stop_now
    r = chat(r4)
    assert r.status_code == 409 and err(r)["code"] in ("studio_fenced", "studio_step_closed"), r.text   # Stop fences at once
    [res] = reservations_of(r4)
    assert res["state"] == "released" and res["dispatched_at"] is None
    assert r4.transport.sent == []


# ---- r1.4 G1 / r1.3 F1: the captured epoch, re-checked in the reservation and at the send gate ----------------------------

def test_F1a_done_then_paid_call_refused_inside_reservation_txn(r4, monkeypatch):
    """The call passed the door inside step 1; done commits before its reservation: refused inside the reservation's own
    transaction, no reservation row, the provider never called."""
    session, sid, m, ack, step = started(r4)
    before_reservation(r4, monkeypatch, lambda: commit_done(r4, sid, 1))
    r = chat(r4)
    assert r.status_code == 409 and err(r)["code"] in ("studio_fenced", "execution_retired"), r.text
    assert reservations_of(r4) == [] and r4.transport.sent == []
    assert step_row(r4, sid, 1)["state"] == "finished"                     # a refusal never rewrites a closed step


def test_F1a2_reserved_before_done_aborts_at_send_gate(r4):
    """F1-a2, and F1-c (the provider send delayed across done): reserved under step 1, done commits, the send gate on
    the reservation's own step aborts and releases it."""
    session, sid, m, ack, step = started(r4)
    r4.transport.before[r4.maker["id"]] = lambda: commit_done(r4, sid, 1)
    r = chat(r4)
    assert r.status_code == 409 and err(r)["code"] in ("studio_fenced", "execution_retired"), r.text
    [res] = reservations_of(r4)
    assert res["state"] == "released" and res["metadata"]["studio_step"] == 1
    assert r4.transport.sent == []


def test_F1a3_capture_between_done_and_rotation_refused(r4):
    """After done and before any rotation (retirement is lazy, G5b) the token still authenticates: its call is refused,
    and a call bound before done that reserves after it is refused inside the reservation transaction."""
    session, sid, m, ack, step = started(r4)
    agent = r4.hive.db.one("SELECT * FROM agents WHERE id = ?", (r4.maker["id"],))
    call = studio(r4).gateway_call(agent)                                  # bound inside step 1
    assert done(r4, sid, 1, step["execution_id"], more=False).status_code == 200
    assert epoch_of(r4) == step["token_epoch"]                             # no rotation: no next step is due
    r = chat(r4)
    assert (r.status_code, err(r)["code"]) == (409, "studio_fenced"), r.text
    from hive.core.cost_reservations import Reservations
    with pytest.raises(Exception) as e:
        studio(r4).reserve_call(call, Reservations(r4.hive.db), "k-late", {"n": 1}, 0.01, lambda: [("hive:month", 100, 0)],
                                {"agent": r4.maker["id"]})
    assert getattr(e.value, "code", None) == "studio_fenced"
    assert reservations_of(r4) == [] and r4.transport.sent == []


def test_F1b_F1d_a_request_of_e_n_that_reserves_after_n_plus_1_is_admitted_is_refused(r4):
    """F1-b / F1-d: authenticated (and bound) under step 1's epoch, it reaches its reservation after the restart that
    admitted step 2: refused, never charged to step 2. A new request with that token is 401 (F1-e)."""
    from hive.core.cost_reservations import Reservations
    session, sid, m, step = ready2(r4)
    agent = r4.hive.db.one("SELECT * FROM agents WHERE id = ?", (r4.maker["id"],))
    old = maker_headers(r4)
    st = studio(r4)
    st.worker.wait_idle(15)
    upload(r4, sid, m, 2, gen=2)
    drive(r4)
    s2 = step_row(r4, sid, 2)
    assert s2["state"] == "admitted" and s2["token_epoch"] == step["token_epoch"] + 1
    from hive.core.studio_gateway import StudioCall
    call = StudioCall(st, agent, ses_row(r4, sid), step)                   # what gateway_call returned for it in step 1
    with pytest.raises(Exception) as e:
        st.reserve_call(call, Reservations(r4.hive.db), "k-old", {"n": 1}, 0.01, lambda: [("hive:month", 100, 0)],
                        {"agent": r4.maker["id"]})
    assert getattr(e.value, "code", None) in ("studio_fenced", "execution_retired")
    assert r4.hive.db.one("SELECT 1 FROM cost_reservations WHERE id = 'k-old'") is None
    assert step_row(r4, sid, 2)["state"] == "admitted"                     # step 2 is untouched by the old call
    assert chat(r4, headers=old).status_code == 401
    assert chat(r4).status_code == 200                                     # the new execution, inside step 2
    assert [r["metadata"]["studio_step"] for r in reservations_of(r4)] == [2]


def test_F1i_a_call_sent_under_n_that_settles_after_n_plus_1_is_admitted_stays_on_n(r4):
    from hive.core.studio_sessions import step_label
    session, sid, m, ack, step = started(r4)
    in_step(r4, sid, step)
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)
    assert entered.wait(15)                                                # sent under step 1, its answer not back yet
    assert done(r4, sid, 1, step["execution_id"], more=True).status_code == 200
    upload(r4, sid, m, 2, gen=2)
    drive(r4, rounds=2, connect_started=False)
    h = handoff(r4, sid)
    assert h["state"] == "settling"                                        # n+1 waits for step 1's call
    r4.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h["id"]))
    drive(r4)
    assert step_row(r4, sid, 2)["state"] == "admitted"
    [res] = reservations_of(r4)
    assert res["state"] == "unknown"                                       # moved at the settle deadline (L3)
    go.set()
    t.join(15)
    assert out["r"].status_code == 200
    [res] = reservations_of(r4)
    assert res["state"] == "settled" and step_label(sid, 1) in res["scopes"] and step_label(sid, 2) not in res["scopes"]
    assert studio(r4).scope_spent(step_label(sid, 1)) == pytest.approx(0.002)
    assert studio(r4).scope_spent(step_label(sid, 2)) == 0


# ---- r1.1 S1, E6.1: the monthly total at every reservation -------------------------------------------------------------

def test_S1b_the_self_row_revoked_mid_session_refuses_the_next_call_and_pauses(r4):
    session, sid, m, ack, step = started(r4)
    r4.hive.db.execute("UPDATE key_limits SET revoked_at = '2026-10-19T00:00:00.000Z' WHERE owner = ? AND grantee = 'self' "
                       "AND key_id = '*'", (MIA,))
    r = chat(r4)
    assert (r.status_code, err(r)["code"], err(r)["reason"]) == (402, "spend_limit", "monthly_total_required"), r.text
    assert reservations_of(r4) == [] and r4.transport.sent == []
    assert (step_row(r4, sid, 1)["state"], step_row(r4, sid, 1)["closed_reason"]) == ("refused_budget", "monthly_total_required")
    assert (ses_row(r4, sid)["state"], ses_row(r4, sid)["state_reason"]) == ("paused", "monthly_total_required")


def test_S1c_E61_concurrent_keys_with_an_open_session_hold_refused_exactly_at_the_boundary(r4):
    """E6.1: the session has a dispatched call held under studio:<sid> and Mia's monthly total; her second key spends at
    the same time; the monthly row counts both, and the session's next call is refused at the boundary. The session's
    hold still counts only on its own exact label."""
    from hive.core.cost_reservations import micros
    from hive.core.studio_sessions import scope_label
    hive = r4.hive
    session, sid, m, ack, step = started(r4)
    add_key(hive, "k_0000a002", MIA)
    other = r4.client.post("/api/agents", json={"name": "Other", "swarm_id": r4.home["id"], "model": MODEL, "budget_usd": 5,
                                                "options": {"key": "k_0000a002"}}).json()
    maker = hive.db.one("SELECT * FROM agents WHERE id = ?", (r4.maker["id"],))
    e = r4.client.app.state.gateway.estimate(maker, dict(BODY))[1]
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)                                           # call A: dispatched, held
    assert entered.wait(15)
    assert studio(r4).scope_held(scope_label(sid)) == pytest.approx(micros(e) / 1e6)
    b = chat(r4, headers={"Authorization": f"Bearer {other['token']}"})    # call B, on Mia's other key: settles $0.002
    assert b.status_code == 200, b.text
    limit = (micros(0.002) + 2 * micros(e) - 1) / 1_000_000                # A's hold + B's spend + one more call - 1 micro
    assert limit >= 0.002 + e                                              # without A's hold the next call would fit
    hive.db.execute("UPDATE key_limits SET month_usd = ? WHERE owner = ? AND grantee = 'self' AND key_id = '*'", (limit, MIA))
    c = chat(r4)                                                           # call C, the session's next
    assert c.status_code == 402, c.text
    assert err(c)["scope"].startswith("keyuse:")                # refused by the monthly total itself
    assert ses_row(r4, sid)["state"] == "paused"
    go.set()
    t.join(15)
    assert out["r"].status_code == 200
    held_a = [r for r in reservations_of(r4) if r["state"] == "settled"]
    assert len(held_a) == 1 and scope_label(sid) in held_a[0]["scopes"]
    assert [r for r in reservations_of(r4, other["id"]) if scope_label(sid) in r["scopes"]] == []


# ---- r1.1 S5: drift at call time, and the change routes -------------------------------------------------------------------

def test_S5a_tools_changed_mid_session_refuse_the_next_call_and_hold(r4):
    session, sid, m, ack, step = started(r4)
    r4.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": KEY, "tools": ["shell"]}), r4.maker["id"]))
    r = chat(r4)
    assert (r.status_code, err(r)["code"]) == (409, "role_drift"), r.text
    assert reservations_of(r4) == [] and r4.transport.sent == []
    assert (ses_row(r4, sid)["state"], ses_row(r4, sid)["state_reason"]) == ("held", "binding_drift:role_drift")
    assert (step_row(r4, sid, 1)["state"], step_row(r4, sid, 1)["closed_reason"]) == ("interrupted", "binding_drift:role_drift")
    assert fenced(r4, step["token_epoch"]) and err(chat(r4))["code"] == "studio_fenced"


def test_S5b_a_change_to_the_makers_model_role_or_options_while_live_is_409(r4):
    session, sid, m, ack, step = started(r4)
    for change in ({"model": "openrouter/test/other"}, {"role_id": None}, {"options": {"key": KEY, "tools": []}}):
        r = r4.client.patch(f"/api/agents/{r4.maker['id']}", json=change)
        assert (r.status_code, err(r).get("code")) == (409, "studio_session_live"), (change, r.text)
    row = r4.hive.db.one("SELECT model FROM agents WHERE id = ?", (r4.maker["id"],))
    assert row["model"] == MODEL
    assert r4.client.patch(f"/api/agents/{r4.maker['id']}", json={"name": "Maker Two"}).status_code == 200   # not binding


# ---- O2-i: who a call is for, and the dedicated maker -------------------------------------------------------------------

def test_O2i_user_for_the_maker_is_the_sessions_person_and_ask_and_sessions_are_refused(r4):
    hive = r4.hive
    session, sid, m, ack, step = started(r4)
    maker = hive.db.one("SELECT * FROM agents WHERE id = ?", (r4.maker["id"],))
    assert hive.user_for(maker) == MIA
    r4.client.put(f"/api/agents/{r4.maker['id']}/visibility", json={"visibility": "shared", "shared_with": [MIA]})
    r4.client.put(f"/api/swarms/{r4.home['id']}/visibility", json={"visibility": "shared", "shared_with": [MIA]})
    r = r4.client.post("/api/ask", headers=r4.mg, json={"operation_id": "op-r4-ask-maker-1", "text": "and you?",
                                                         "context": {"mind": r4.maker["id"]}})
    assert (r.status_code, err(r).get("code")) == (409, "coordinator_busy"), r.text
    r = r4.client.post("/api/sessions", json={"mind": r4.maker["id"], "title": "side work"})
    assert (r.status_code, err(r).get("code")) == (409, "coordinator_busy"), r.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM work_sessions WHERE agent_id = ? AND (purpose IS NULL OR purpose != 'ask')",
                       (r4.maker["id"],))["n"] == 0


# ---- O2-j: a restart with an open step ---------------------------------------------------------------------------------------

def test_O2j_restart_with_an_open_step_interrupts_it_and_its_call_stays_unknown_on_its_labels(r4):
    from hive.core.cost_reservations import Reservations
    from hive.core.studio_sessions import step_label
    session, sid, m, ack, step = started(r4)
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)
    assert entered.wait(15)
    with r4.hive.db.transaction() as tx:
        Reservations.recover_startup(tx)                                   # the startup recovery's reservation step
    restart(r4)                                                            # and its Studio step
    s1 = step_row(r4, sid, 1)
    assert s1["state"] == "interrupted" and fenced(r4, step["token_epoch"])
    [res] = reservations_of(r4)
    assert res["state"] == "unknown" and step_label(sid, 1) in res["scopes"]
    go.set()                                                               # the answer arrives after all: settled late, on step 1
    t.join(15)
    [res] = reservations_of(r4)
    assert res["state"] == "settled" and studio(r4).scope_spent(step_label(sid, 1)) == pytest.approx(0.002)


# ---- G3: every other mind is untouched -----------------------------------------------------------------------------------------

def test_G3_other_minds_paid_calls_are_unchanged_during_a_live_step(r4):
    hive = r4.hive
    session, sid, m, ack, step = started(r4)
    peer = r4.client.post("/api/agents", json={"name": "Peer", "swarm_id": r4.home["id"], "model": MODEL, "budget_usd": 5,
                                               "options": {"key": KEY}}).json()
    row = hive.db.one("SELECT * FROM agents WHERE id = ?", (peer["id"],))
    assert hive.studio.gateway_call(row) is None and hive.user_for(row) != MIA
    r = chat(r4, headers={"Authorization": f"Bearer {peer['token']}"})
    assert r.status_code == 200, r.text
    [res] = reservations_of(r4, peer["id"])
    assert res["state"] == "settled" and not any(s.startswith("studio") for s in res["scopes"])
    assert not set(res["metadata"]) & {"studio_session", "studio_step", "token_epoch", "execution_id"}


# ---- Studio off: nothing changes ----------------------------------------------------------------------------------------------

def test_R4_studio_off_the_gateway_user_for_ask_sessions_and_change_routes_are_as_before(r4, monkeypatch):
    """A persisted live session with an admitted step, then Studio OFF (as at eb006a94 with the setting off): the maker's
    call is reserved dispatched with the old metadata and no Studio label; who pays is the ordinary rule; Ask, Sessions
    and agent changes are not refused; a proposal needs no op ids; the controls 404 even with a malformed body."""
    hive = r4.hive
    session, sid, m, ack, step = started(r4)
    monkeypatch.setattr(hive.studio, "enabled", False)
    maker = hive.db.one("SELECT * FROM agents WHERE id = ?", (r4.maker["id"],))
    assert hive.studio.gateway_call(maker) is None and hive.studio.maker_busy(r4.maker["id"]) is False
    assert hive.user_for(maker) != MIA
    r = chat(r4)
    assert r.status_code == 200, r.text
    [res] = reservations_of(r4)
    assert set(res["metadata"]) == {"agent", "model", "payer", "key", "payload_hash"}
    assert not any(s.startswith("studio") for s in res["scopes"]) and res["state"] == "settled"
    assert r4.client.patch(f"/api/agents/{r4.maker['id']}", json={"model": "openrouter/test/maker"}).status_code == 200
    assert r4.client.post("/api/sessions", json={"mind": r4.maker["id"], "title": "side work"}).status_code in (200, 201)
    pub = r4.client.post(f"/api/agent/artifacts/{session['proposal_artifact_id']}/revisions", headers=maker_headers(r4),
                         json={"body": "{}", "parent": None})
    assert pub.status_code == 200, pub.text                               # the ordinary artifact rules decide
    bad = r4.client.post(f"/api/studio-sessions/{sid}/controls", headers=r4.mg,
                         json={"control_id": "fin-00000001", "action": "finish_stopping", "extra": 1})
    assert (bad.status_code, err(bad)["code"]) == (404, "not_available")   # Kimi R3.2 P3: before the body checks


# ---- embeddings: the same door, binding and gate --------------------------------------------------------------------------------

def test_R4_a_makers_paid_embeddings_call_is_fenced_outside_its_step_and_bound_inside_it(r4, monkeypatch):
    from hive.core.studio_sessions import step_label
    hive = r4.hive
    monkeypatch.setattr(hive.settings, "embedding_model", "openrouter/test/embed")
    sent = []

    async def embeddings(model, data, agent=None):
        await signal_send()
        sent.append(agent["id"])
        return {"object": "list", "data": [], "model": model, "usage": {"prompt_tokens": 7, "total_tokens": 7}}
    monkeypatch.setattr(r4.client.app.state.gateway, "embeddings", embeddings)
    session = open_session(r4)
    mount(r4, session["session_id"], session["stream_id"])
    r = r4.client.post("/llm/v1/embeddings", headers=maker_headers(r4), json={"input": ["a"]})
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text
    assert sent == [] and reservations_of(r4) == []
    hive.db.execute("UPDATE studio_sessions SET state = 'stopped', maker_released = 1 WHERE id = ?", (session["session_id"],))
    session2, sid, m, ack, step = started(r4)
    r = r4.client.post("/llm/v1/embeddings", headers=maker_headers(r4), json={"input": ["a"]})
    assert r.status_code == 200, r.text
    [res] = reservations_of(r4)
    assert res["state"] == "settled" and step_label(sid, 1) in res["scopes"] and res["metadata"]["studio_step"] == 1
    assert sent == [r4.maker["id"]]


# ---- r1.8 L6: op ids are unique for the session's life, across mounts and segments ----------------------------------------------

def _through_step_1(x, ops=("op-a1", "op-a2")):
    session, sid, m, ack, step = started(x)
    in_step(x, sid, step)
    pub = publish(x, session, step["execution_id"], op_ids=list(ops))
    assert pub.status_code == 200, pub.text
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub.json()["n"],
            "digest": step_row(x, sid, 1)["proposal_digest"]}
    return session, sid, m, step, prop


def test_L6_op_id_reuse_across_segments_refused(r4):
    hive = r4.hive
    session, sid, m, step, prop = _through_step_1(r4)
    assert step_row(r4, sid, 1)["op_ids"] == json.dumps(["op-a1", "op-a2"])
    done(r4, sid, 1, step["execution_id"], more=True)
    ack2 = upload(r4, sid, m, 2, gen=2).json()
    assert outcome(r4, sid, 1, m, prop, ack2).status_code == 200
    m2 = mount(r4, sid, session["stream_id"], expected=m["mount_epoch"], gen=2).json()   # a new segment: remount
    assert m2["mount_epoch"] == m["mount_epoch"] + 1
    upload(r4, sid, m2, 3, gen=3)
    drive(r4)
    s2 = step_row(r4, sid, 2)
    in_step(r4, sid, s2)
    revisions = hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?",
                            (session["proposal_artifact_id"],))["n"]
    r = publish(r4, session, s2["execution_id"], op_ids=["op-b1", "op-a2"], parent=1)
    assert (r.status_code, err(r)["code"]) == (409, "op_id_reused"), r.text
    assert err(r)["op_ids"] == ["op-a2"] and err(r)["steps"] == [1]
    assert hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?",
                       (session["proposal_artifact_id"],))["n"] == revisions
    assert step_row(r4, sid, 2)["proposal_n"] is None                      # nothing written
    assert publish(r4, session, s2["execution_id"], op_ids=["op-b1", "op-b2"], parent=1).status_code == 200


def test_L6_op_ids_are_required_distinct_and_the_outcome_must_name_the_declared_ones(r4):
    session, sid, m, ack, step = started(r4)
    in_step(r4, sid, step)
    for ops in (None, [], ["dup", "dup"], ["x" * 81], [str(i) for i in range(17)]):
        payload = {"body": "{}", "parent": None, "execution_id": step["execution_id"]}
        if ops is not None:
            payload["op_ids"] = ops
        r = r4.client.post(f"/api/agent/artifacts/{session['proposal_artifact_id']}/revisions", headers=maker_headers(r4),
                           json=payload)
        assert r.status_code == 400, (ops, r.text)
    pub = publish(r4, session, step["execution_id"], op_ids=["op-c1"])
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub.json()["n"],
            "digest": step_row(r4, sid, 1)["proposal_digest"]}
    done(r4, sid, 1, step["execution_id"], more=False)
    ack2 = upload(r4, sid, m, 2, gen=2).json()
    r = outcome(r4, sid, 1, m, prop, ack2, op_ids=None)                   # null: none named
    assert r.status_code == 400, r.text                                    # a validated outcome names the op ids it read
    r = outcome(r4, sid, 1, m, prop, ack2, op_ids=["op-zz"])
    assert (r.status_code, err(r)["code"]) == (409, "op_ids_mismatch"), r.text
    assert step_row(r4, sid, 1)["outcome"] is None                         # held, not skipped
    ok = outcome(r4, sid, 1, m, prop, ack2)
    assert ok.status_code == 200 and ok.json()["op_ids"] == ["op-c1"]


def test_L6_fresh_segment_does_not_release_prior_reservation(r4):
    """A new segment (remount, new receiver generation) proves nothing about earlier operations: step 1's unknown call
    stays held on its own labels, and its op ids stay recorded."""
    from hive.core.studio_sessions import step_label
    session, sid, m, step, prop = _through_step_1(r4, ops=("op-d1",))
    r4.transport.fail.add(r4.maker["id"])
    r = chat(r4)
    assert r.status_code == 502
    [res] = reservations_of(r4)
    assert res["state"] == "unknown" and step_label(sid, 1) in res["scopes"]
    m2 = mount(r4, sid, session["stream_id"], expected=m["mount_epoch"], gen=2).json()
    upload(r4, sid, m2, 2, gen=2)
    tick(r4)
    [res] = reservations_of(r4)
    assert res["state"] == "unknown" and step_label(sid, 1) in res["scopes"]
    assert r4.hive.db.one("SELECT step FROM studio_op_ids WHERE session_id = ? AND op_id = 'op-d1'", (sid,))["step"] == 1


# ---- R3 follow-up: the epoch on reservations, and the <= k filter -------------------------------------------------------------

def test_R4_open_reservations_counts_epoch_le_k_and_unrecorded_never_newer(r4):
    from hive.core.cost_reservations import Reservations
    res = Reservations(r4.hive.db)
    aid = r4.maker["id"]
    for key, meta in (("k-e3", {"agent": aid, "token_epoch": 3}), ("k-e4", {"agent": aid, "token_epoch": 4}),
                      ("k-none", {"agent": aid})):
        res.reserve(key, {"k": key}, 0.01, lambda: [("hive:month", 100, 0)], metadata=meta, subjects=["agent:" + aid])
    ids = lambda k: sorted(r["id"] for r in studio(r4).open_reservations(aid, k))   # noqa: E731
    assert ids(3) == ["k-e3", "k-none"]                                    # a newer epoch's call is not epoch <= 3
    assert ids(4) == ["k-e3", "k-e4", "k-none"]
    assert ids(None) == ["k-e3", "k-e4", "k-none"]                         # the R3 reading
    assert ids(2) == ["k-none"]                                            # no recorded epoch: counted (fail-closed)


# ---- R3 follow-up: the Mac gate's TRY_SLEEP_ONCE branch ---------------------------------------------------------------------------

def _gate_with_sleep_once(x, tmp_path, keep_awake_ids):
    """Every line of the adopted safe-restart.sh before its launchctl, with TRY_SLEEP_ONCE=1: its one sleep request goes
    by the real curl to a local forwarder that answers with this hive's real /api/local/restart-prepare (and refreshes the
    gate's database copy afterwards, as the live database would be). Only three constants are rewritten: the database path,
    the token file path and the hive URL; sleep is a no-op so the 60 s wait loop runs at once."""
    lines = SAFE_RESTART.read_text().splitlines()
    end = next(i for i, line in enumerate(lines) if line.lstrip().startswith("launchctl"))
    db = tmp_path / "gate" / "hive.db"
    _db_copy(x, db)
    token = secrets.token_urlsafe(24)
    token_file = tmp_path / "gate" / "restart-prepare.token"
    token_file.write_text(token)
    (x.hive.settings.data_dir / "restart-prepare.token").write_text(token)
    seen = []

    class Forward(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            seen.append(data)
            r = x.client.post("/api/local/restart-prepare", content=data,
                              headers={"Authorization": self.headers.get("Authorization", ""),
                                       "Content-Type": "application/json"})
            _db_copy(x, db)
            out = r.content
            self.send_response(r.status_code)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Forward)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/api/local/restart-prepare"
    body = []
    for line in lines[1:end]:
        if line.startswith("DB="):
            line = f'DB="{db}"'
        elif line.strip().startswith("TOKEN_FILE="):
            line = f'  TOKEN_FILE="{token_file}"'
        body.append(line.replace("http://127.0.0.1:8700/api/local/restart-prepare", url))
    assert sum("TOKEN_FILE=" in b for b in body) == 1 and sum(url in b for b in body) == 1
    script = tmp_path / "gate" / "mac-gate-sleep-once.sh"
    script.write_text("#!/bin/sh\npgrep() { return 1; }\nsleep() { :; }\n" + "\n".join(body) + "\necho GATE_PASSED\n")
    env = {**os.environ, "TRY_SLEEP_ONCE": "1",
           "HIVE_RESIDENT_MINDS": ",".join(r["id"] for r in x.hive.db.all("SELECT id FROM agents") if r["id"] not in keep_awake_ids)}
    try:
        done_ = subprocess.run(["/bin/sh", str(script)], capture_output=True, text=True, env=env, timeout=60)
    finally:
        server.shutdown()
    return done_.returncode, done_.stdout, seen


def test_mac_gate_try_sleep_once_asks_once_a_studio_owned_maker_refuses_and_the_gate_keeps_the_hive_up(r4, tmp_path,
                                                                                                     monkeypatch):
    if not SAFE_RESTART.exists():
        pytest.skip("hive-local/safe-restart.sh is not on this machine")
    if "TRY_SLEEP_ONCE" not in SAFE_RESTART.read_text():
        pytest.skip("the adopted safe-restart.sh has no TRY_SLEEP_ONCE branch")
    hive = r4.hive
    monkeypatch.setattr(hive.settings, "restart_prepare", True)
    session, sid, m, ack, step = started(r4)
    sleeper = new_mind(r4, "Sleeper")
    rc, out, seen = _gate_with_sleep_once(r4, tmp_path, {r4.maker["id"], sleeper["id"]})
    assert rc == 3 and "NOT restarting: still awake" in out and r4.maker["id"] in out, out
    assert len(seen) == 1                                                  # asked once, never retried
    assert "studio_owned" in out                                           # the hive's own answer: the maker refused
    status = {r["id"]: r["status"] for r in hive.db.all("SELECT id, status FROM agents WHERE id IN (?, ?)",
                                                         (r4.maker["id"], sleeper["id"]))}
    assert status == {r4.maker["id"]: "awake", sleeper["id"]: "asleep"}   # the ordinary mind slept; Studio's did not
    stop(r4, sid)
    stopped_and_released(r4, sid)                                          # Stop releases the maker, asleep
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (sleeper["id"],))
    rc, out, seen = _gate_with_sleep_once(r4, tmp_path, {r4.maker["id"], sleeper["id"]})
    assert rc == 0 and "all minds asleep" in out and "GATE_PASSED" in out, out
    assert len(seen) == 1


# ==== r4.1: the send gate of embeddings and media sits at the transport's send-header boundary ==========================
# A real httpx/httpcore transport to a local vendor (so the gateway's trace fires where it does in production), wrapped so
# a test can hold a request in the transport (as a wait for a pooled connection would) or fail it before anything is sent.

import base64 as _b64    # noqa: E402
import copy as _copy     # noqa: E402

import httpx             # noqa: E402

from hive.tests.test_media_route import PIN as MEDIA_PIN, png  # noqa: E402


class LocalVendor:
    """POST /embeddings and /images on 127.0.0.1: records every request that actually arrived."""

    def __init__(self):
        self.posts = []
        vendor = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                vendor.posts.append(self.path)
                if self.path.endswith("/images"):
                    out = {"created": 1, "data": [{"b64_json": _b64.b64encode(png()).decode()}],
                           "usage": {"prompt_tokens": 0, "completion_tokens": 4175, "total_tokens": 4175, "cost": 0.035}}
                else:
                    out = {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}],
                           "model": "test/embed", "usage": {"prompt_tokens": 7, "total_tokens": 7}}
                data = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"


class HeldTransport(httpx.AsyncBaseTransport):
    """The real transport, with an optional hold (entered, go) before it and an optional failure before any byte."""

    def __init__(self):
        self.inner = httpx.AsyncHTTPTransport()
        self.hold, self.fail = None, False

    async def handle_async_request(self, request):
        if self.hold is not None:
            entered, go = self.hold
            self.hold = None
            entered.set()
            while not go.is_set():
                await asyncio.sleep(0.02)
        if self.fail:
            raise httpx.ConnectError("vendor unreachable (before anything was sent)")
        return await self.inner.handle_async_request(request)

    async def aclose(self):
        await self.inner.aclose()


@pytest.fixture()
def media_on(monkeypatch):
    """Listed before r4/vend: the media route exists only when HIVE_MEDIA_ROUTE=on at app start."""
    monkeypatch.setenv("HIVE_MEDIA_ROUTE", "on")


@pytest.fixture()
def vend(r4, monkeypatch):
    hive = r4.hive
    gw = r4.client.app.state.gateway
    r4.vendor = LocalVendor()
    provider = hive.settings.providers["openrouter"]
    monkeypatch.setattr(provider, "base_url", r4.vendor.url)
    monkeypatch.setattr(provider, "media", {"image.generate": _copy.deepcopy(MEDIA_PIN)})
    monkeypatch.setattr(hive.settings, "embedding_model", "openrouter/test/embed")
    monkeypatch.setattr(hive.settings, "media_allow", {"image.generate": [f"agent:{r4.maker['id']}"]})
    r4.transport_held = HeldTransport()
    monkeypatch.setattr(gw, "client", httpx.AsyncClient(transport=r4.transport_held, trust_env=False))
    yield r4
    r4.vendor.server.shutdown()


def embed(x, headers=None):
    return x.client.post("/llm/v1/embeddings", headers=headers or maker_headers(x), json={"input": ["the headline"]})


def image(x, op="op-r41-image-0001", headers=None):
    return x.client.post("/llm/v1/media", headers=headers or maker_headers(x),
                         json={"op": "image.generate", "operation_id": op, "prompt": "a quiet garden at dusk"})


def _step_ends_while_the_transport_waits(x, send):
    session, sid, m, ack, step = started(x)
    entered, go = threading.Event(), threading.Event()
    x.transport_held.hold = (entered, go)
    t, out = in_thread(send, x)
    try:
        assert entered.wait(15)                                            # the request is in the transport, not sent
        x.while_waiting = reservations_of(x)[0]["state"]                   # asserted by the caller, after the send checks
        assert done(x, sid, 1, step["execution_id"], more=False).status_code == 200   # retirement wins
    finally:
        go.set()
    t.join(15)
    return out["r"], sid


def test_r41_embeddings_step_ends_while_the_transport_waits_nothing_is_sent_and_the_hold_is_released(vend):
    r, sid = _step_ends_while_the_transport_waits(vend, embed)
    assert r.status_code == 409 and err(r)["code"] in ("studio_fenced", "execution_retired"), r.text
    assert vend.vendor.posts == []
    [res] = reservations_of(vend)
    assert res["state"] == "released" and res["dispatched_at"] is None
    assert getattr(vend, "while_waiting", "reserved") == "reserved"        # never dispatched while waiting in the transport


def test_r41_media_step_ends_while_the_transport_waits_nothing_is_sent_and_the_hold_is_released(media_on, vend):
    r, sid = _step_ends_while_the_transport_waits(vend, image)
    assert r.status_code == 409 and err(r)["code"] in ("studio_fenced", "execution_retired"), r.text
    assert vend.vendor.posts == []
    [res] = reservations_of(vend)
    assert res["state"] == "released" and res["dispatched_at"] is None
    assert getattr(vend, "while_waiting", "reserved") == "reserved"        # never dispatched while waiting in the transport
    row = vend.hive.db.one("SELECT billing, refusal FROM media_results WHERE reservation = ?", (res["id"],))
    assert (row["billing"], row["refusal"]) == ("released", "studio_retired")   # never recorded as dispatched


def test_r41_embeddings_a_request_that_fails_before_any_byte_is_released_not_held_unknown(vend):
    session, sid, m, ack, step = started(vend)
    vend.transport_held.fail = True
    with pytest.raises(httpx.ConnectError):                                # the route re-raises it, as before R4
        embed(vend)
    assert vend.vendor.posts == []
    [res] = reservations_of(vend)
    assert res["state"] == "released" and res["dispatched_at"] is None
    assert getattr(vend, "while_waiting", "reserved") == "reserved"        # never dispatched while waiting in the transport


def test_r41_a_makers_embeddings_and_media_in_step_pass_the_gate_at_send_and_settle_on_the_step(media_on, vend):
    from hive.core.studio_sessions import step_label
    session = open_session(vend)
    mount(vend, session["session_id"], session["stream_id"])
    r = image(vend)
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed"), r.text   # the door, outside a step
    assert vend.vendor.posts == [] and reservations_of(vend) == []
    vend.hive.db.execute("UPDATE studio_sessions SET state = 'stopped', maker_released = 1 WHERE id = ?", (session["session_id"],))
    session2, sid, m, ack, step = started(vend)
    assert embed(vend).status_code == 200
    r = image(vend)
    assert r.status_code == 200, r.text
    assert sorted(p.rsplit("/", 1)[-1] for p in vend.vendor.posts) == ["embeddings", "images"]
    rows = reservations_of(vend)
    assert len(rows) == 2 and all(r_["state"] == "settled" and r_["dispatched_at"] is not None for r_ in rows)
    assert all(step_label(sid, 1) in r_["scopes"] and r_["metadata"]["studio_step"] == 1 for r_ in rows)
    media = vend.hive.db.one("SELECT billing FROM media_results")
    assert media["billing"] == "settled"


def test_r41_studio_off_paid_embeddings_and_media_are_as_before(media_on, vend, monkeypatch):
    """Runtime parity with Studio OFF (a persisted live session with an admitted step): the maker's paid embeddings and
    media are reserved dispatched with the old metadata, no Studio label, no send gate, and settled."""
    session, sid, m, ack, step = started(vend)
    monkeypatch.setattr(vend.hive.studio, "enabled", False)
    assert embed(vend).status_code == 200
    r = image(vend)
    assert r.status_code == 200, r.text
    rows = reservations_of(vend)
    # merge with OI-13 r1.2 (R7): embeddings now carry their paying key in the metadata, as chat and media do
    assert [set(r_["metadata"]) for r_ in rows] == [{"agent", "model", "payer", "key", "kind", "payload_hash"},
                                                    {"agent", "model", "payer", "key", "kind", "payload_hash"}]
    assert all(r_["state"] == "settled" and not any(s.startswith("studio") for s in r_["scopes"]) for r_ in rows)
    assert len(vend.vendor.posts) == 2
    assert vend.hive.db.one("SELECT billing FROM media_results")["billing"] == "settled"
