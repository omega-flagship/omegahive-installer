"""Purpose: verify the Ask's money as Jon designed it on omegahive#294 (item 2): no per-answer cap and no per-thread cap,
the person's monthly allowance and the hive's limits holding each call, and one question when an answer looks expensive.

No network and no paid calls: a scripted model and a fake priced provider, as test_ask_conductor.py and
test_ask_limits_r1.py use. The threshold is the person's: their median answer from their own past turns, so the tests
that are about the pause set it directly and one test reads the rule itself from stored turns.
"""
import time

import pytest

from hive.core import conductor as cmod
from hive.core.config import AskExpensive, Provider
from hive.core.db import new_id, now
from hive.tests.test_ask import ask, cap
from hive.tests.test_ask_conductor import Script, call, closed, on, script, wait  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


@pytest.fixture()
def paid(on, monkeypatch):  # noqa: F811
    """A priced conductor model whose call's worst case is about $0.09, settled at the script's cost."""
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 10, "out": 10}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    return on


def threshold(monkeypatch, hive, usd):
    """This person's expensive_usd, set for a test about the pause (the rule itself has its own test)."""
    monkeypatch.setattr(hive.ask, "expensive_usd", lambda principal: usd)


def says(*texts):
    return [call("say", text=t) for t in texts]


def turn_row(hive, op):
    return hive.db.one("SELECT * FROM ask_turns WHERE operation_id = ? AND principal = 'user:u_ann'", (op,))


def go(client, headers, op, body):  # noqa: F811
    return client.post(f"/api/ask/{op}/go-ahead", headers=headers, json=body)


def question(fs):
    return [f for f in fs if f["phase"] == "go_ahead"]


# ---- no cap of the Ask's own ----------------------------------------------------------------------------------------------

def test_a_turn_spends_past_the_old_quarter_and_its_thread_holds_no_cap(client, paid):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    s = script(client, Script(says("one"), says("two"), says("three"), "done", cost=0.07))
    assert ask(client, paid["ann"], "op-go-free", context=paid["ctx"]).status_code == 202
    fs = wait(hive, "op-go-free", closed)
    # four calls at $0.07: past the $0.25 the turn and the thread were each held to before, with no question under $1
    assert fs[-1]["outcome"] == "complete" and fs[-1]["turn_spent_usd"] == pytest.approx(0.28)
    assert len(s.bodies) == 4 and not question(fs)
    thread = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_ann' AND purpose = 'ask' AND status = 'active'")
    assert float(thread["budget_usd"]) == 0 and cap(hive, coord) is None   # no cap, and the mind's rule untouched
    assert hive.sessions.view(thread)["spent_usd"] == pytest.approx(0.28)   # still counted, by its label
    scopes = {r["scope"] for r in hive.db.all("SELECT scope FROM cost_reservation_scopes")}
    assert f"askturn:{turn_row(hive, 'op-go-free')['id']}" in scopes and f"askthread:{thread['id']}" in scopes
    # the same thread takes the next request: nothing in it is spent out
    script(client, Script("again", cost=0.07))
    assert ask(client, paid["ann"], "op-go-free-2", context=paid["ctx"]).status_code == 202
    assert wait(hive, "op-go-free-2", closed)[-1]["outcome"] == "complete"


def test_the_threshold_is_ten_times_the_persons_median_and_never_over_a_dollar(client, paid):  # noqa: F811
    hive, ask_ = paid["hive"], paid["hive"].ask
    e = hive.settings.ask_expensive   # hive/config.json's figures: Jon's 10 x and $1, 20 answers, 5 before it counts
    assert (e.times, e.over_usd, e.medians, e.fewest) == (10, 1.0, 20, 5)

    def past(usd, closed_=True):
        tid = new_id("at")
        hive.db.insert("ask_turns", {
            "id": tid, "operation_id": "op-" + tid, "principal": "user:u_ann", "body_digest": "d", "thread_id": "se_x",
            "mind_id": paid["coord"]["id"], "swarm_id": paid["swarm"]["id"], "text": "", "via": "typed",
            "context_resolved": "{}", "state": "done" if closed_ else "conducting", "reason": None,
            "room_message_id": "", "delivery_message_id": "", "answer_message_id": None, "deadline": time.time(),
            "mind_spent_at_start": 0, "next_seq": 1, "created_at": now(), "closed_at": now() if closed_ else None,
            "spent_usd_approx": usd, "deleted_at": None})
        time.sleep(0.002)   # created_at orders them

    assert ask_.expensive_usd("user:u_ann") == e.over_usd == 1.0   # no history: $1 alone
    for usd in [0.01] * (e.fewest - 1):
        past(usd)
    past(0.0)                    # a free answer says nothing of what this person's answers cost
    past(0.5, closed_=False)     # nor does a turn still open
    assert ask_.expensive_usd("user:u_ann") == 1.0                       # four paid answers: not yet a median
    past(0.03)
    assert ask_.expensive_usd("user:u_ann") == pytest.approx(e.times * 0.01)   # median $0.01 of five: $0.10
    for usd in [0.2] * e.medians:
        past(usd)
    assert ask_.expensive_usd("user:u_ann") == 1.0                       # the latest 20 at $0.20: ten times is $2, so $1
    assert client.get("/api/me/ask", headers=paid["ann"]).json()["expensive_usd"] == 1.0



def test_the_threshold_and_the_wait_follow_the_hives_settings_not_the_code(client, paid, monkeypatch):  # noqa: F811
    hive, ask_ = paid["hive"], paid["hive"].ask
    assert paid["conductor"].go_ahead_seconds == hive.settings.ask_expensive.wait_seconds
    monkeypatch.setattr(hive.settings, "ask_expensive", AskExpensive(times=3, over_usd=0.5, medians=4, fewest=2,
                                                                     wait_seconds=7))
    assert ask_.expensive_usd("user:u_ann") == 0.5                                   # no history: over_usd alone
    for i, usd in enumerate([0.01, 0.02, 0.9, 0.9, 0.04, 0.05]):                     # the latest four: 0.9 0.9 0.04 0.05
        hive.db.insert("ask_turns", {
            "id": f"at_cfg{i}", "operation_id": f"op-cfg{i}", "principal": "user:u_ann", "body_digest": "d",
            "thread_id": "se_x", "mind_id": paid["coord"]["id"], "swarm_id": paid["swarm"]["id"], "text": "",
            "via": "typed", "context_resolved": "{}", "state": "done", "reason": None, "room_message_id": "",
            "delivery_message_id": "", "answer_message_id": None, "deadline": time.time(), "mind_spent_at_start": 0,
            "next_seq": 1, "created_at": f"2026-11-20T00:00:0{i}Z", "closed_at": now(), "spent_usd_approx": usd,
            "deleted_at": None})
    assert ask_.expensive_usd("user:u_ann") == pytest.approx(min(0.5, 3 * 0.475))    # median of the four, capped
    monkeypatch.setattr(hive.settings, "ask_expensive", AskExpensive(3, 10.0, 4, 2, 7))
    assert ask_.expensive_usd("user:u_ann") == pytest.approx(3 * 0.475)

# ---- the question --------------------------------------------------------------------------------------------------------

def test_a_turn_at_its_threshold_asks_once_and_goes_ahead_in_place(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.1)
    s = script(client, Script(says("one"), says("two"), says("three"), "done", cost=0.07))
    ask(client, paid["ann"], "op-go-yes", context=paid["ctx"])
    fs = wait(hive, "op-go-yes", question)
    # $0.14 after two calls reached the $0.10: the third waits for the person, and nothing is redone after
    assert question(fs)[0]["spent_usd"] == pytest.approx(0.14) and question(fs)[0]["limit_usd"] == 0.1
    assert len(s.bodies) == 2 and turn_row(hive, "op-go-yes")["state"] == "conducting"
    assert turn_row(hive, "op-go-yes")["deadline"] > time.time() + hive.settings.ask_expensive.wait_seconds   # Ask.expire leaves it alone
    r = go(client, paid["ann"], "op-go-yes", {"go": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "go": True}
    fs = wait(hive, "op-go-yes", closed)
    assert fs[-1]["outcome"] == "complete" and len(question(fs)) == 1 and len(s.bodies) == 4
    assert turn_row(hive, "op-go-yes")["go_ahead"] == 1
    assert go(client, paid["ann"], "op-go-yes", {"go": True}).json()["error"]["code"] == "not_waiting"


def test_the_wait_is_the_persons_time_not_the_turns(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.05)
    paid["conductor"].turn_seconds = 1.0
    script(client, Script(says("one"), "done", cost=0.07))
    ask(client, paid["ann"], "op-go-slow", context=paid["ctx"])
    wait(hive, "op-go-slow", question)
    time.sleep(1.5)   # longer than the whole turn may run
    assert go(client, paid["ann"], "op-go-slow", {"go": True}).status_code == 200
    assert wait(hive, "op-go-slow", closed)[-1]["outcome"] == "complete"


def test_stop_at_the_question_is_the_persons_stop(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.05)
    s = script(client, Script(says("one"), "never", cost=0.07))
    ask(client, paid["ann"], "op-go-no", context=paid["ctx"])
    wait(hive, "op-go-no", question)
    assert go(client, paid["ann"], "op-go-no", {"go": False}).json() == {"ok": True, "go": False}
    fs = wait(hive, "op-go-no", closed)
    # exactly what POST .../stop gives a conductor turn: refused/stopped, its done frame the outcome cancelled
    assert fs[-1]["phase"] == "done" and fs[-1]["outcome"] == "cancelled" and len(s.bodies) == 1
    assert (turn_row(hive, "op-go-no")["state"], turn_row(hive, "op-go-no")["reason"]) == ("refused", "stopped")


def test_no_answer_stops_as_expensive_and_its_go_ahead_runs_without_asking(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.05)
    paid["conductor"].go_ahead_seconds = 0.3
    script(client, Script(says("one"), "never", cost=0.07))
    ask(client, paid["ann"], "op-go-gone", context=paid["ctx"])
    fs = wait(hive, "op-go-gone", closed)
    assert fs[-1]["outcome"] == "spend_cap"
    assert fs[-1]["limit"] == {"kind": "expensive", "current_usd": 0.07, "limit_usd": 0.05, "estimate_usd": None}
    assert fs[-2]["text"].endswith(cmod.LIMIT_SAY["expensive"].format(amounts=" (about $0.07 so far)"))
    # Go ahead asks again with go_ahead: the same spend, and no question this time
    s = script(client, Script(says("one"), says("two"), "done", cost=0.07))
    assert ask(client, paid["ann"], "op-go-again", context=paid["ctx"], go_ahead=True).status_code == 202
    fs = wait(hive, "op-go-again", closed)
    assert fs[-1]["outcome"] == "complete" and not question(fs) and len(s.bodies) == 3
    assert turn_row(hive, "op-go-again")["go_ahead"] == 1


def test_a_person_who_switched_it_off_is_never_asked(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.05)
    me = client.put("/api/me/ask", headers=paid["ann"], json={"ask_when_expensive": False}).json()
    assert me["ask_when_expensive"] is False and client.get("/api/me/ask", headers=paid["ann"]).json()["ask_when_expensive"] is False
    script(client, Script(says("one"), says("two"), "done", cost=0.07))
    ask(client, paid["ann"], "op-go-off", context=paid["ctx"])
    fs = wait(hive, "op-go-off", closed)
    assert fs[-1]["outcome"] == "complete" and not question(fs)
    assert client.put("/api/me/ask", headers=paid["ann"], json={"ask_when_expensive": True}).json()["ask_when_expensive"] is True


# ---- what the routes take ----------------------------------------------------------------------------------------------

def test_the_go_ahead_route_takes_only_the_askers_answer_while_the_turn_waits(client, paid, monkeypatch):  # noqa: F811
    hive = paid["hive"]
    threshold(monkeypatch, hive, 0.05)
    script(client, Script(says("one"), "done", cost=0.07))
    ask(client, paid["ann"], "op-go-route", context=paid["ctx"])
    wait(hive, "op-go-route", question)
    for body in ({}, {"go": "yes"}, {"go": True, "more": 1}, {"go": 1}):
        r = go(client, paid["ann"], "op-go-route", body)
        assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid"), body
    assert go(client, paid["bob"], "op-go-route", {"go": True}).status_code == 404   # someone else's turn
    assert go(client, paid["ann"], "op-go-nothing", {"go": True}).status_code == 404  # no such turn
    assert go(client, paid["ann"], "op-go-route", {"go": True}).status_code == 200
    assert wait(hive, "op-go-route", closed)[-1]["outcome"] == "complete"
    # a turn that never asked isn't waiting
    script(client, Script("plain", cost=0.001))
    ask(client, paid["ann"], "op-go-never", context=paid["ctx"], go_ahead=True)
    wait(hive, "op-go-never", closed)
    r = go(client, paid["ann"], "op-go-never", {"go": True})
    assert (r.status_code, r.json()["error"]["code"]) == (409, "not_waiting")


def test_the_body_key_and_the_prefs_take_only_their_own_shapes(client, paid):  # noqa: F811
    me = client.get("/api/me/ask", headers=paid["ann"]).json()
    assert me["ask_when_expensive"] is True and me["expensive_usd"] == 1.0
    assert not {"thread_budget_usd", "max_thread_budget_usd"} & set(me)
    for body in ({"thread_budget_usd": 1}, {"ask_when_expensive": "no"}, {"ask_when_expensive": 0}):
        r = client.put("/api/me/ask", headers=paid["ann"], json=body)
        assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid"), body
    for value in (False, "true", 1, None):
        r = ask(client, paid["ann"], "op-go-bad-" + str(value).lower(), context=paid["ctx"], go_ahead=value)
        assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid"), value


# ---- an earlier build's thread caps -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("answering", [False, True])
def test_boot_takes_away_a_cap_an_earlier_builds_ask_thread_installed(client, paid, answering):  # noqa: F811
    """answering: the mind itself is answering a turn on that thread, so boot leaves the thread on the mind's measure
    (rescope 'thread' skips it), and the cap still goes, since boot composes every capped mind again."""
    hive, coord = paid["hive"], paid["coord"]
    spent = float(hive._agent_row(coord["id"])["spent_usd"] or 0)
    # as an earlier build left it: a mind-measured Ask thread whose $0.25 cap was composed into the mind's rule (10)
    sid = new_id("se")
    hive.db.insert("work_sessions", {
        "id": sid, "room_id": "r_old", "agent_id": coord["id"], "goal_id": None, "owner": "user:u_ann", "title": "Ask",
        "status": "active", "budget_usd": 0.25, "spent_at_start": spent, "prev_limit": 10.0, "set_limit": spent + 0.25,
        "workspace": None, "created_at": now(), "ended_at": None, "purpose": "ask", "cap_scope": None, "carried_usd": 0.0})
    if answering:
        tid = new_id("at")
        hive.db.insert("ask_turns", {
            "id": tid, "operation_id": "op-" + tid, "principal": "user:u_ann", "body_digest": "d", "thread_id": sid,
            "mind_id": coord["id"], "swarm_id": paid["swarm"]["id"], "text": "", "via": "typed", "context_resolved": "{}",
            "state": "thinking", "reason": None, "room_message_id": "", "delivery_message_id": "", "answer_message_id": None,
            "deadline": time.time() + 600, "mind_spent_at_start": spent, "next_seq": 1, "created_at": now(),
            "closed_at": None, "spent_usd_approx": 0, "deleted_at": None})
    assert cap(hive, coord) is None
    hive.db.insert("budgets", {"id": new_id("b"), "scope": f"agent:{coord['id']}", "period": "total",
                               "limit_usd": spent + 0.25, "note": "session cap", "created_at": now()})
    hive.db.execute("INSERT INTO session_caps VALUES (?, ?, ?, ?)", (coord["id"], 10.0, spent + 0.25, now()))
    assert cap(hive, coord) == pytest.approx(spent + 0.25)
    hive.sessions.adopt_ask_threads()
    assert cap(hive, coord) == 10.0   # the rule from before any session, back
    assert hive.db.one("SELECT 1 FROM session_caps WHERE agent_id = ?", (coord["id"],)) is None
    assert hive.db.one("SELECT cap_scope FROM work_sessions WHERE id = ?", (sid,))["cap_scope"] == (None if answering else "thread")
