"""ask-limits r1: an Ask thread's cap holds that thread's own spend (never the mind's rule), and a spend stop names its limit.

Found in the live Studio walk (2026-10-17): every new Ask thread on a mind was refused with "this request reached its spend
limit for one turn" because an older thread's small cap had been composed into the mind's total rule, which also hid the
limit the person had just raised. No network and no paid calls: a scripted model, a fake priced provider.
"""
import json

import pytest

from hive.core import conductor as cmod
from hive.core.ask import Ask
from hive.core.config import Provider
from hive.core.cost_reservations import BudgetExhausted
from hive.core.gateway import GatewayError
from hive.core.hive import HiveError
from hive.tests.test_ask import ask, cap, reply
from hive.tests.test_ask_conductor import Script, closed, on, script, wait  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


@pytest.fixture()
def paid(on, monkeypatch):  # noqa: F811
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "1")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    return on


def spend_elsewhere(hive, mind, usd):
    """The mind spends on other work (its own calls, another person's thread): recorded as any usage is."""
    hive.record_usage(hive._agent_row(mind["id"]), "fakepaid/x", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": usd}, payer="hive")


def thread_pref(client, headers, usd):  # noqa: F811
    assert client.put("/api/me/ask", headers=headers, json={"thread_budget_usd": usd}).status_code == 200


def done(fs):
    return fs[-1]


# ---- item 1: a stale thread's small cap never holds a new thread --------------------------------------------------------

def test_a_stale_small_thread_cap_never_blocks_a_new_thread_on_the_mind(client, paid):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    s = script(client, Script("one", "two", cost=0.001))
    thread_pref(client, paid["quinn"], 1)
    ask(client, paid["quinn"], "op-lim-old", context=paid["ctx"], text="first")
    assert done(wait(hive, "op-lim-old", closed, principal="user:u_quinn"))["outcome"] == "complete"
    spend_elsewhere(hive, coord, 1.5)   # the mind spends past the old thread's $1 since it opened
    hive.db.execute("UPDATE agents SET budget_usd = 100 WHERE id = ?", (coord["id"],))   # and its limit is raised
    thread_pref(client, paid["ann"], 5)
    ask(client, paid["ann"], "op-lim-new", context=paid["ctx"], text="second")
    fs = wait(hive, "op-lim-new", closed)
    assert done(fs)["outcome"] == "complete", done(fs)
    assert len(s.bodies) == 2
    # no thread's cap became the mind's rule: the mind is held by its own limit, each thread by its own cap
    assert cap(hive, coord) is None
    threads = hive.db.all("SELECT owner, cap_scope, budget_usd FROM work_sessions WHERE agent_id = ? AND status = 'active' ORDER BY created_at", (coord["id"],))
    assert [(t["owner"], t["cap_scope"], t["budget_usd"]) for t in threads] == [("user:u_quinn", "thread", 1.0), ("user:u_ann", "thread", 5.0)]


def test_live_shape_a_clamped_legacy_thread_neither_blocks_nor_hides_the_raised_limit(client, paid, monkeypatch):  # noqa: F811
    """The live Product Design shape: an Ask thread from before this build (composed into the mind's rule with a tiny cap),
    then the person raises the mind's total limit, then new threads open. The new thread runs, the person's limit is the
    mind's rule, and the Limits page shows each thread's cap apart from it."""
    hive, coord = paid["hive"], paid["coord"]
    spend_elsewhere(hive, coord, 3.67)
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")   # an earlier build: the mind answers, the thread composes into the rule
    r = ask(client, paid["quinn"], "op-lim-legacy", text="old", context=paid["ctx"])
    assert r.status_code == 202, r.text
    reply(hive, coord, r.json()["turn_id"] if "turn_id" in r.json() else r.json()["id"])
    legacy = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_quinn' AND status = 'active'")
    assert legacy.get("cap_scope") is None and cap(hive, coord) == 3.92   # $3.67 + the $0.25 thread
    # the person raises the mind's total limit on the Limits page
    assert client.post("/api/budgets", json={"scope": f"agent:{coord['id']}", "period": "total", "limit_usd": 18.91}).status_code == 200
    spend_elsewhere(hive, coord, 0.25)   # $3.92 of $3.92 by the stale thread's measure (live: $3.89 of $3.92, a real estimate above $0.03)
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    s = script(client, Script("fine", cost=0.001))
    ask(client, paid["ann"], "op-lim-after", context=paid["ctx"])
    fs = wait(hive, "op-lim-after", closed)
    assert done(fs)["outcome"] == "complete", done(fs)
    assert len(s.bodies) == 1
    assert cap(hive, coord) == 18.91   # the person's own limit, not the stale thread's $3.92
    # the stale thread keeps its cap on its own spend (carried: what the mind spent while it was the measure)
    moved = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (legacy["id"],))
    assert moved["cap_scope"] == "thread" and moved["carried_usd"] == pytest.approx(0.25)
    page = client.get("/api/budgets/limits").json()
    mind = next(m for m in page["minds"] if m["agent_id"] == coord["id"])
    total = next(r for r in mind["limits"] if r["key"] == f"agent:{coord['id']}:total" and r["period"] == "total")
    assert total["limit_usd"] == 18.91 and total["source"] == "set"
    assert [(t["owner"], t["budget_usd"]) for t in mind["ask_threads"]] == [("user:u_quinn", 0.25), ("user:u_ann", 0.25)]
    assert all(t["key"].startswith("askthread:") for t in mind["ask_threads"])


def test_a_legacy_conductor_thread_carries_only_its_own_spend_and_frees_the_mind(client, paid):  # noqa: F811
    """A thread from the build before this one whose turns were all the conductor's (the live case: $0 recorded): moved to
    its own scope with exactly what its own calls cost, and the mind's rule goes back to the person's own limit."""
    hive, coord = paid["hive"], paid["coord"]
    script(client, Script("one", "two", cost=0.004))
    thread_pref(client, paid["quinn"], 0.03)
    ask(client, paid["quinn"], "op-lim-legc", context=paid["ctx"])
    assert done(wait(hive, "op-lim-legc", closed, principal="user:u_quinn"))["outcome"] == "complete"
    old = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_quinn' AND status = 'active'")
    with hive.db.transaction():   # as the earlier build left it: composed into the mind's total rule
        hive.db.execute("UPDATE work_sessions SET cap_scope = NULL WHERE id = ?", (old["id"],))
        hive.db.execute("DELETE FROM cost_reservation_scopes WHERE scope = ?", ("askthread:" + old["id"],))   # no such scope then
        hive.sessions._compose(coord["id"])
    assert cap(hive, coord) == pytest.approx(old["spent_at_start"] + 0.03)
    spend_elsewhere(hive, coord, 1.0)
    assert hive.sessions.adopt_ask_threads() == [old["id"]]
    moved = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (old["id"],))
    # r1.2: its own call is labelled to its scope (the one source), so nothing is carried; its spend is the same $0.004
    assert moved["cap_scope"] == "thread" and moved["carried_usd"] == 0 and hive.sessions.view(moved)["spent_usd"] == 0.004
    assert cap(hive, coord) is None and hive.sessions.view(moved)["spent_usd"] == 0.004


def test_the_thread_cap_holds_the_threads_own_spend_only(client, paid):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    thread_pref(client, paid["ann"], 0.012)
    s = script(client, Script("one", "two", cost=0.004))
    ask(client, paid["ann"], "op-lim-t1", context=paid["ctx"])
    assert done(wait(hive, "op-lim-t1", closed))["outcome"] == "complete"
    spend_elsewhere(hive, coord, 2.0)   # the mind's other spend is not this thread's
    thread = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_ann' AND status = 'active'")
    assert hive.sessions.view(thread)["spent_usd"] == 0.004
    # the next call's worst case (~$0.009) does not fit the thread's $0.012 with $0.004 spent: refused by its own scope
    ask(client, paid["ann"], "op-lim-t2", context=paid["ctx"])
    fs = wait(hive, "op-lim-t2", closed)
    assert len(s.bodies) == 1
    last = done(fs)
    assert last["outcome"] == "spend_cap"
    assert last["limit"]["kind"] == "thread" and last["limit"]["limit_usd"] == 0.012 and last["limit"]["current_usd"] == 0.004
    assert 0 < last["limit"]["estimate_usd"] < 0.012
    assert fs[-2]["text"].startswith("I stopped here: this thread has used its spend limit ($0.00 of $0.01)")
    assert "Start a new thread" in fs[-2]["text"]


def test_a_turn_the_mind_answers_moves_its_thread_back_under_the_minds_rule(client, paid, monkeypatch):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    script(client, Script("one", cost=0.004))
    ask(client, paid["ann"], "op-lim-back1", context=paid["ctx"])
    assert done(wait(hive, "op-lim-back1", closed))["outcome"] == "complete"
    assert cap(hive, coord) is None
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    r = ask(client, paid["ann"], "op-lim-back2", text="the mind answers", context=paid["ctx"])
    assert r.status_code == 202, r.text
    thread = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_ann' AND status = 'active'")
    assert thread["cap_scope"] is None
    # the mind may spend what the thread has left, on the mind's measure: $0.25 - $0.004
    assert cap(hive, coord) == pytest.approx(float(hive._agent_row(coord["id"])["spent_usd"]) + 0.246, abs=1e-6)


# ---- item 2: a spend stop names its limit ---------------------------------------------------------------------------------

def test_the_per_turn_cap_is_named(client, paid, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.012")
    from hive.tests.test_ask_conductor import call
    script(client, Script([call("say", text="one")], [call("say", text="two")], "never", cost=0.004))
    ask(client, paid["ann"], "op-lim-turn", context=paid["ctx"])
    fs = wait(paid["hive"], "op-lim-turn", closed)
    last = done(fs)
    assert last["outcome"] == "spend_cap" and last["limit"]["kind"] == "per_turn" and last["limit"]["limit_usd"] == 0.012
    assert "spend limit for one turn" in fs[-2]["text"] and "Ask again" in fs[-2]["text"]


def test_the_minds_own_limit_is_named(client, paid):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    hive.db.execute("UPDATE agents SET budget_usd = 0.001 WHERE id = ?", (coord["id"],))
    s = script(client, Script("never"))
    ask(client, paid["ann"], "op-lim-mind", context=paid["ctx"])
    fs = wait(hive, "op-lim-mind", closed)
    last = done(fs)
    assert s.bodies == [] and last["outcome"] == "spend_cap"
    assert last["limit"] == {"kind": "mind_total", "current_usd": 0.0, "limit_usd": 0.001, "estimate_usd": last["limit"]["estimate_usd"]}
    assert "this mind has reached its own spend limit" in fs[-2]["text"] and "Limits page" in fs[-2]["text"]


def test_the_persons_allowance_and_the_swarms_limit_are_named(client, paid):  # noqa: F811
    hive = paid["hive"]
    hive.db.insert("budgets", {"id": "b_ann", "scope": "person:u_ann", "period": "month", "limit_usd": 0.0001, "note": "", "created_at": "2026-01-01"})
    script(client, Script("never"))
    ask(client, paid["ann"], "op-lim-person", context=paid["ctx"])
    fs = wait(hive, "op-lim-person", closed)
    assert done(fs)["limit"]["kind"] == "member_allowance" and done(fs)["limit"]["limit_usd"] == 0.0001
    assert "your spending allowance" in fs[-2]["text"] and "this month" in fs[-2]["text"]
    hive.db.execute("DELETE FROM budgets WHERE id = 'b_ann'")
    assert client.post("/api/budgets", json={"scope": f"swarm:{paid['swarm']['id']}", "period": "day", "limit_usd": 0.0001}).status_code == 200
    ask(client, paid["ann"], "op-lim-swarm", context=paid["ctx"])
    fs = wait(hive, "op-lim-swarm", closed)
    assert done(fs)["limit"]["kind"] == "swarm" and "this swarm" in fs[-2]["text"] and "today" in fs[-2]["text"]


@pytest.mark.parametrize("code,details,kind", [
    ("spend_limit", {"scope": "hive", "period": "month", "limit_usd": 5, "spent_usd": 5}, "hive"),
    ("spend_limit", {"scope": "key:k_0123abcd", "period": "month", "limit_usd": 5, "spent_usd": 5}, "key"),
    ("spend_limit", {"scope": "keyuse:0123456789abcdef", "period": "month", "limit_usd": 5, "spent_usd": 5}, "own_key_limit"),
    ("own_key_required", {"scope": "use", "pays": "own-key"}, "own_key_required"),
    ("no_key_grant", {"scope": "use", "owner": "user:u_x"}, "no_key_grant"),
    ("own_key_needed", {"scope": "use", "pays": "own-key"}, "own_key_needed"),   # OI-13 r1.2 (Surface O3)
    ("hive_budget_exhausted", {}, "hive"),
    ("budget_exhausted", {}, "mind_total"),
    ("no_budget", {}, "mind_total"),
])
def test_every_check_refusal_maps_to_a_kind_with_its_own_words(paid, code, details, kind):
    detail = paid["conductor"]._check_detail({"id": paid["coord"]["id"], "budget_usd": 1, "spent_usd": 1}, HiveError(402, code, "x", details), 0.01)
    assert detail["kind"] == kind and detail["estimate_usd"] == 0.01
    say = cmod.stop_say(cmod._Stop("spend_cap", detail))
    head = cmod.LIMIT_SAY[kind].split("{amounts}")[0]
    assert say.startswith(head) and "{" not in say
    assert kind in cmod.LIMIT_KINDS and cmod.limit_frame(detail)["kind"] == kind


def _person_default(hive, owner, key_id="k_0f0f0f0f", provider="fakepaid"):
    import time
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": "sk-" + key_id, "created_at": time.time()}
    hive.keyring.ring["defaults"][provider] = key_id


def test_a_turn_on_another_persons_default_key_stops_as_own_key_needed(client, paid):  # noqa: F811
    """OI-13 r1.2 (Surface O3): a conductor turn whose paying key would be another person's own key stops before any
    call, with done.limit.kind own_key_needed and its own words (not the generic spend sentence)."""
    hive = paid["hive"]
    _person_default(hive, "user:u_zed")
    s = script(client, Script("never"))
    ask(client, paid["ann"], "op-lim-ownkey", context=paid["ctx"])
    fs = wait(hive, "op-lim-ownkey", closed)
    assert s.bodies == [] and done(fs)["outcome"] == "spend_cap", done(fs)
    assert done(fs)["limit"]["kind"] == "own_key_needed"
    assert fs[-2]["text"].startswith(cmod.LIMIT_SAY["own_key_needed"].split("{amounts}")[0])
    assert not hive.db.all("SELECT * FROM cost_reservations")


def test_a_turn_switches_to_the_askers_own_key_when_the_default_is_someone_elses(client, paid):  # noqa: F811
    hive = paid["hive"]
    _person_default(hive, "user:u_zed")
    _person_default(hive, "user:u_ann", key_id="k_0a0a0a0b")
    hive.keyring.ring["defaults"]["fakepaid"] = "k_0f0f0f0f"          # Zed's key stays the default
    s = script(client, Script("fine", cost=0.001))
    ask(client, paid["ann"], "op-lim-ownkey2", context=paid["ctx"])
    fs = wait(hive, "op-lim-ownkey2", closed)
    assert done(fs)["outcome"] == "complete", done(fs)
    assert len(s.bodies) == 1
    keys = [json.loads(r["metadata"]).get("key") for r in hive.db.all("SELECT metadata FROM cost_reservation_details")]
    assert keys == ["k_0a0a0a0b"]                                     # reserved on Ann's own key, never Zed's


def test_reservation_refusals_carry_their_row():
    for label, kind in (("askturn:at_1", "per_turn"), ("askthread:se_1", "thread"), ("hive:hard-total", "hive"),
                        ("person:u_0123abcd:month", "member_allowance"), ("swarm:s_0123abcd:day", "swarm")):
        exc = BudgetExhausted(label, 1.0, 0.5, 0.25, 0.3)
        assert str(exc) == "Shared budget exhausted: " + label and isinstance(exc, ValueError)
        scope = label if label.startswith("ask") else label.rpartition(":")[0]
        assert cmod.limit_kind("spend_limit", scope) == kind


def test_a_session_installed_mind_rule_is_named_as_the_session(client, paid):  # noqa: F811
    """An ordinary work session on the mind still caps the whole mind (its calls can't be told apart); the stop says so."""
    hive, coord = paid["hive"], paid["coord"]
    hive.db.execute("UPDATE agents SET budget_usd = 100 WHERE id = ?", (coord["id"],))
    r = client.post("/api/sessions", headers=paid["quinn"], json={"mind": coord["id"], "title": "work", "budget_usd": 0.001})
    assert r.status_code in (200, 201), r.text
    script(client, Script("never"))
    ask(client, paid["quinn"], "op-lim-sess", context=paid["ctx"])
    fs = wait(hive, "op-lim-sess", closed, principal="user:u_quinn")
    assert done(fs)["limit"]["kind"] == "session" and "Ending that session" in fs[-2]["text"]


# ---- not a limit: an unpriced model and a missing key -------------------------------------------------------------------

def test_an_unpriced_model_is_an_error_not_a_spend_limit(client, on, monkeypatch):  # noqa: F811
    hive = on["hive"]
    hive.settings.providers["noprice"] = Provider("noprice", "http://127.0.0.1:9", prices={})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "noprice/x")
    s = script(client, Script("never"))
    ask(client, on["ann"], "op-lim-unpriced", context=on["ctx"])
    fs = wait(hive, "op-lim-unpriced", closed)
    assert s.bodies == [] and done(fs)["outcome"] == "error" and done(fs)["error"] == "unpriced_model" and "limit" not in done(fs)
    assert fs[-2]["text"] == cmod.ERROR_SAY["unpriced_model"]


def test_a_missing_key_is_an_error_not_a_spend_limit(client, paid, monkeypatch):  # noqa: F811
    gw = client.app.state.gateway

    def gone(agent, provider_name):
        raise GatewayError(402, "key_unavailable", "gone")
    monkeypatch.setattr(gw, "paying_key", gone)
    script(client, Script("never"))
    ask(client, paid["ann"], "op-lim-key", context=paid["ctx"])
    fs = wait(paid["hive"], "op-lim-key", closed)
    assert done(fs)["outcome"] == "error" and done(fs)["error"] == "key_unavailable"
    assert fs[-2]["text"] == cmod.ERROR_SAY["key_unavailable"]


def test_a_personal_turns_stored_done_frame_keeps_the_limit():
    frame = {"turn_id": "at_1", "phase": "done", "outcome": "spend_cap", "error": None, "text": "words",
             "limit": {"kind": "thread", "current_usd": 0.2, "limit_usd": 0.25, "estimate_usd": 0.06, "note": "x"}}
    out = Ask.content_free(frame)
    assert out["limit"] == {"kind": "thread", "current_usd": 0.2, "limit_usd": 0.25, "estimate_usd": 0.06} and "text" not in out
    assert json.dumps(out)


# ---- r1.1: open liabilities survive the move; admission measures holds; boot adopts whatever the conductor setting ----

def _hold(on, rid, usd, label, subjects=None):  # noqa: F811
    """An open (unknown-outcome) liability, as an earlier build's call left it."""
    res, coord = on["conductor"].reservations, on["coord"]
    res.reserve(rid, {"r": rid}, usd, lambda: [(label, 100, 0)], dispatched=True, subjects=subjects,
                metadata={"agent": coord["id"], "payer": "user:u_quinn", "key": None, "kind": "ask-conductor"})
    res.unknown(rid)
    return res


def _fits(on, thread, usd):  # noqa: F811
    """Whether a new call of this worst case is admitted under the thread's own scope (as Conductor._model reserves)."""
    from hive.core.sessions import thread_scope
    hive, res = on["hive"], on["conductor"].reservations
    fresh = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],))
    try:
        res.reserve("probe-" + str(usd), {"p": usd}, usd, lambda: [(thread_scope(fresh["id"]), float(fresh["budget_usd"]), hive.sessions.thread_spent(fresh))])
    except BudgetExhausted:
        return False
    res.abort_before_dispatch("probe-" + str(usd))
    return True


def test_mixed_history_migration_keeps_open_liabilities_under_the_threads_cap(client, paid, monkeypatch):  # noqa: F811
    """Stand-in P1 (r1): a thread with a turn the mind answered, a $1 cap and a $0.80 open legacy hold: the move to its own
    scope carried $0 and dropped the hold, so a $0.40 call was then admitted ($1.20 against $1)."""
    hive, coord = paid["hive"], paid["coord"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    thread_pref(client, paid["quinn"], 1)
    r = ask(client, paid["quinn"], "op-lim-mixed", text="old", context=paid["ctx"])
    assert r.status_code == 202, r.text
    reply(hive, coord, r.json()["turn_id"] if "turn_id" in r.json() else r.json()["id"])
    thread = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_quinn' AND status = 'active'")
    res = _hold(paid, "legacy-mixed", 0.80, f"agent:{coord['id']}:total", subjects=["hive", "agent:" + coord["id"]])
    assert cap(hive, coord) == pytest.approx(float(thread["spent_at_start"]) + 1.0)
    assert hive.sessions.adopt_ask_threads() == [thread["id"]]
    assert cap(hive, coord) is None
    assert not _fits(paid, thread, 0.40), "$0.40 admitted on top of a $0.80 open hold under a $1 cap"
    assert _fits(paid, thread, 0.15)
    assert hive.sessions.thread_held(hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],))) == pytest.approx(0.80)
    # the hold settles at its real cost: counted once, as the thread's spend
    res.settle("legacy-mixed", 0.70, lambda: hive.record_usage(hive._agent_row(coord["id"]), "fakepaid/x",
                                                               {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.70}, payer="user:u_quinn"))
    moved = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],))
    assert hive.sessions.view(moved)["spent_usd"] == pytest.approx(0.70) and hive.sessions.thread_held(moved) == 0
    assert not _fits(paid, thread, 0.40) and _fits(paid, thread, 0.25)


def test_a_conductor_threads_open_hold_is_counted_once_not_carried_at_its_worst_case(client, paid):  # noqa: F811
    hive, coord = paid["hive"], paid["coord"]
    script(client, Script("one", cost=0.004))
    thread_pref(client, paid["quinn"], 1)
    ask(client, paid["quinn"], "op-lim-hold", context=paid["ctx"])
    assert done(wait(hive, "op-lim-hold", closed, principal="user:u_quinn"))["outcome"] == "complete"
    old = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_quinn' AND status = 'active'")
    turn = hive.db.one("SELECT id FROM ask_turns WHERE thread_id = ?", (old["id"],))
    with hive.db.transaction():   # as the earlier build left it
        hive.db.execute("UPDATE work_sessions SET cap_scope = NULL WHERE id = ?", (old["id"],))
        hive.db.execute("DELETE FROM cost_reservation_scopes WHERE scope = ?", ("askthread:" + old["id"],))
        hive.sessions._compose(coord["id"])
    res = _hold(paid, "legacy-turn", 0.80, "askturn:" + turn["id"], subjects=["hive", "agent:" + coord["id"]])
    assert hive.sessions.adopt_ask_threads() == [old["id"]]
    moved = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (old["id"],))
    assert moved["carried_usd"] == 0 and hive.sessions.view(moved)["spent_usd"] == 0.004   # r1.2: labelled, not carried
    assert hive.sessions.thread_held(moved) == pytest.approx(0.80)
    assert not _fits(paid, old, 0.40)
    res.settle("legacy-turn", 0.10, lambda: None)
    moved = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (old["id"],))
    assert hive.sessions.view(moved)["spent_usd"] == pytest.approx(0.104) and _fits(paid, old, 0.80)


def test_admission_refuses_a_thread_whose_open_holds_fill_its_cap(client, paid):  # noqa: F811
    """Kimi P2 (r1): the admission gate read settled spend only, so a thread full of open holds opened a turn that then
    stopped at its first reservation; now it is refused at admission with the thread's own spend_limit."""
    hive = paid["hive"]
    script(client, Script("one", "two"))
    thread_pref(client, paid["ann"], 0.03)
    ask(client, paid["ann"], "op-lim-gate1", context=paid["ctx"])
    assert done(wait(hive, "op-lim-gate1", closed))["outcome"] == "complete"
    thread = hive.db.one("SELECT * FROM work_sessions WHERE owner = 'user:u_ann' AND status = 'active'")
    _hold(paid, "held-full", 0.03, "askthread:" + thread["id"])
    r = ask(client, paid["ann"], "op-lim-gate2", context=paid["ctx"])
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit"


def test_boot_adopts_legacy_threads_with_the_conductor_off(monkeypatch):
    """Kimi P2 (r1): adoption at boot ran only when the conductor was on at that moment."""
    import pathlib
    import tempfile

    from fastapi.testclient import TestClient

    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    from hive.tests.test_ask import world
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-test-"))

    def boot():
        app = create_app(load_settings(data_dir=data, admin_password="pw", petta_path=PETTA), supervisor=FakeSupervisor(), reconcile_seconds=0)
        c = TestClient(app)
        c.__enter__()
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        return c
    c = boot()
    try:
        w = world(c)
        r = ask(c, w["ann"], "op-lim-boot", context={"swarm_id": w["swarm"]["id"]})
        assert r.status_code == 202, r.text
        reply(w["hive"], w["coord"], r.json()["turn_id"] if "turn_id" in r.json() else r.json()["id"])
        coord = w["coord"]
        assert cap(w["hive"], coord) == 0.25
    finally:
        c.__exit__(None, None, None)
    c = boot()
    try:
        hive = c.app.state.hive
        assert hive.db.one("SELECT cap_scope FROM work_sessions WHERE agent_id = ?", (coord["id"],))["cap_scope"] == "thread"
        assert cap(hive, coord) is None
    finally:
        c.__exit__(None, None, None)


# ---- r1.2: every reservation state, settled before or after the move, counted once under the thread's cap ---------------
# The real Database, Sessions and Reservations over invented rows with a minimal hive (as the MacBook-Hive pack does).

class _Legacy:
    MIND, THREAD, TURN = "a_00000001", "se_fixture", "turn_legacy"

    def __init__(self, tmp_path, mixed):
        from types import SimpleNamespace

        from hive.core import cost_reservations, db as dbmod, sessions
        self.db = dbmod.Database(tmp_path / "legacy.sqlite", hive_schema=False)
        self.db.execute("CREATE TABLE agents (id TEXT PRIMARY KEY, spent_usd REAL NOT NULL, budget_usd REAL NOT NULL)")
        self.db.execute("INSERT INTO agents VALUES (?, 0, 10)", (self.MIND,))
        self.db.execute("CREATE TABLE budgets (id TEXT PRIMARY KEY, scope TEXT NOT NULL, period TEXT NOT NULL, "
                        "limit_usd REAL NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)")
        self.db.execute("CREATE TABLE ask_turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, mind_id TEXT NOT NULL, "
                        "state TEXT NOT NULL, conductor_model TEXT)")
        self.hive = SimpleNamespace(db=self.db, _agent_row=lambda a: self.db.one("SELECT * FROM agents WHERE id = ?", (a,)))
        self.res = cost_reservations.Reservations(self.db)
        self.cr = cost_reservations
        self.sessions = sessions.Sessions(self.hive)
        self.label = sessions.thread_scope(self.THREAD)
        self.db.insert("work_sessions", {"id": self.THREAD, "room_id": "r_x", "agent_id": self.MIND, "goal_id": None,
                                         "owner": "user:u_00000001", "title": "t", "status": "active", "budget_usd": 1.0,
                                         "spent_at_start": 0.0, "prev_limit": None, "set_limit": None, "workspace": None,
                                         "created_at": dbmod.now(), "ended_at": None, "purpose": "ask", "cap_scope": None,
                                         "carried_usd": 0.0})
        if mixed:
            self.db.execute("INSERT INTO ask_turns VALUES ('turn_mind', ?, ?, 'done', NULL)", (self.THREAD, self.MIND))
        self.db.execute("INSERT INTO ask_turns VALUES (?, ?, ?, 'done', 'm/x')", (self.TURN, self.THREAD, self.MIND))
        with self.db.transaction():
            self.sessions._compose(self.MIND)
        self.usage = []

    def hold(self, rid, usd, labels):
        self.res.reserve(rid, {"r": rid}, usd, lambda: [(lab, 100, 0) for lab in labels],
                         metadata={"agent": self.MIND, "payer": "hive"}, subjects=["hive", "agent:" + self.MIND])

    def to_state(self, rid, state):
        if state in ("dispatched", "unknown", "settled"):
            self.res.dispatch(rid)
        if state == "unknown":
            self.res.unknown(rid)
        if state == "released":
            self.res.abort_before_dispatch(rid)
        if state == "settled":
            self.settle(rid)

    def settle(self, rid, usd=0.6):
        if self.res.get(rid)["state"] == "reserved":
            self.res.dispatch(rid)

        def record():
            self.usage.append(usd)
            self.db.execute("UPDATE agents SET spent_usd = spent_usd + ? WHERE id = ?", (usd, self.MIND))
        return self.res.settle(rid, usd, record)

    def thread(self):
        return self.db.one("SELECT * FROM work_sessions WHERE id = ?", (self.THREAD,))

    def liability(self):
        return self.sessions.thread_spent(self.thread()) + self.res.pending(self.label) / 1_000_000

    def fits(self, usd):
        t = self.thread()
        try:
            self.res.reserve(f"probe{usd}", {"p": usd}, usd, lambda: [(self.label, 1.0, self.sessions.thread_spent(t))])
        except self.cr.BudgetExhausted:
            return False
        self.res.abort_before_dispatch(f"probe{usd}")
        return True


def test_stand_in_r11_p1_a_released_hold_settling_late_after_the_move_is_the_threads_spend(tmp_path):
    """Stand-in P1 on r1.1: a legacy conductor hold released, the thread moved, then the provider's answer settles it late
    at $0.70: usage showed $0.70, thread_spent stayed $0, and a $0.40 call was admitted under the $1 cap."""
    lg = _Legacy(tmp_path, mixed=True)
    lg.hold("legacy", 0.8, [f"agent:{lg.MIND}:total", "askturn:" + lg.TURN])
    lg.res.abort_before_dispatch("legacy")
    assert lg.sessions.adopt_ask_threads() == [lg.THREAD]
    assert lg.settle("legacy", 0.7) is True and lg.usage == [0.7]
    assert lg.sessions.thread_spent(lg.thread()) == pytest.approx(0.7)
    assert not lg.fits(0.4) and lg.fits(0.3)


STATES = ("reserved", "dispatched", "unknown", "released", "settled")


@pytest.mark.parametrize("history,owner", [("mixed", "turn"), ("mixed", "mind"), ("conductor", "turn"), ("conductor", "mind")])
@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("settle", ["before", "after", "never"])
def test_every_state_and_settle_time_counts_once(tmp_path, history, owner, state, settle):
    """A legacy $0.80 hold, owned by the thread's own conductor turn (askturn label) or only by the mind (the mind's own
    call, no turn label), in each state, settled at $0.60 before the move, after it, or never. The thread's cap sees it
    while open, its real cost once settled, exactly once; a conductor-only thread never takes the mind's own calls."""
    if state == "settled" and settle != "before":
        pytest.skip("a settled hold settled before the move by definition")
    lg = _Legacy(tmp_path, mixed=history == "mixed")
    labels = [f"agent:{lg.MIND}:total"] + (["askturn:" + lg.TURN] if owner == "turn" else [])
    lg.hold("legacy", 0.8, labels)
    if state != "settled":
        lg.to_state("legacy", state)
    if settle == "before" or state == "settled":
        lg.settle("legacy")
    lg.sessions.adopt_ask_threads()
    assert lg.thread()["cap_scope"] == "thread"
    if settle == "after":
        lg.settle("legacy")
    assert lg.usage in ([], [0.6]) and len(lg.usage) == (0 if settle == "never" and state != "settled" else 1)
    ours = history == "mixed" or owner == "turn"
    settled = bool(lg.usage)
    open_now = lg.res.get("legacy")["state"] in ("reserved", "dispatched", "unknown")
    expect = (0.6 if settled else 0.8 if open_now else 0.0) if ours else 0.0
    assert lg.liability() == pytest.approx(expect, abs=1e-6), (lg.thread()["carried_usd"], lg.res.get("legacy")["state"])
    assert lg.fits(0.4) == (expect + 0.4 <= 1.0 + 1e-9)
    # moving again changes nothing (idempotent)
    lg.sessions.adopt_ask_threads()
    assert lg.liability() == pytest.approx(expect, abs=1e-6)


@pytest.mark.parametrize("state", ["reserved", "unknown"])
def test_a_hold_labelled_with_another_turn_is_not_this_threads(tmp_path, state):
    """MacBook-Hive pack release_* controls (failed on r1.1): another Ask turn's hold on the same mind stays that turn's;
    releasing this thread's own hold frees the thread's allowance entirely."""
    lg = _Legacy(tmp_path, mixed=True)
    lg.hold("legacy", 0.8, [f"agent:{lg.MIND}:total", "askturn:" + lg.TURN])
    lg.to_state("legacy", state)
    lg.hold("unrelated", 0.1, [f"agent:{lg.MIND}:total", "askturn:unrelated"])
    lg.sessions.adopt_ask_threads()
    if state == "reserved":
        lg.res.abort_before_dispatch("legacy")
    else:
        lg.cr.resolve(lg.res, "legacy", "release", "no charge", "user:u_00000001")
    assert lg.res.pending(f"agent:{lg.MIND}:total") / 1e6 == pytest.approx(0.1)
    assert lg.res.pending("askturn:unrelated") / 1e6 == pytest.approx(0.1)
    assert lg.liability() == pytest.approx(0.0, abs=1e-9)


# ---- r1.3: an ambiguous hold stays with every mixed thread, whatever order they move in (stand-in P1 on r1.2) ---------

def _thread(lg, tid, mixed=True, turn_state="done"):
    from hive.core import db as dbmod
    lg.db.insert("work_sessions", {"id": tid, "room_id": "r_" + tid, "agent_id": lg.MIND, "goal_id": None,
                                   "owner": "user:u_00000001", "title": "t", "status": "active", "budget_usd": 1.0,
                                   "spent_at_start": 0.0, "prev_limit": None, "set_limit": None, "workspace": None,
                                   "created_at": dbmod.now(), "ended_at": None, "purpose": "ask", "cap_scope": None,
                                   "carried_usd": 0.0})
    if mixed:
        lg.db.execute("INSERT INTO ask_turns VALUES (?, ?, ?, ?, NULL)", ("mt_" + tid, tid, lg.MIND, turn_state))
    lg.db.execute("INSERT INTO ask_turns VALUES (?, ?, ?, 'done', 'm/x')", ("ct_" + tid, tid, lg.MIND))
    return tid


def _of(lg, tid):
    from hive.core import sessions
    t = lg.db.one("SELECT * FROM work_sessions WHERE id = ?", (tid,))
    label = sessions.thread_scope(tid)
    return t, label, lg.sessions.thread_spent(t), lg.res.pending(label) / 1_000_000


def _fits_on(lg, tid, usd):
    t, label, spent, _ = _of(lg, tid)
    rid = f"probe_{tid}_{usd}"
    try:
        lg.res.reserve(rid, {"p": rid}, usd, lambda: [(label, 1.0, spent)])
    except lg.cr.BudgetExhausted:
        return False
    lg.res.abort_before_dispatch(rid)
    return True


def _ambiguous(lg, threads):
    lg.hold("mindcall", 0.8, [f"agent:{lg.MIND}:total"])   # untagged: the mind's own call, no Ask turn or thread label
    lg.to_state("mindcall", "unknown")
    moved = lg.sessions.adopt_ask_threads()
    assert sorted(moved) == sorted(threads)
    return moved


def _assert_each_holds_then_spends(lg, threads):
    for tid in threads:
        assert _of(lg, tid)[3] == pytest.approx(0.8), tid
        assert not _fits_on(lg, tid, 0.4) and _fits_on(lg, tid, 0.2), tid
    assert lg.settle("mindcall", 0.7) is True and lg.usage == [0.7]   # usage recorded once, on the mind
    for tid in threads:
        _, _, spent, held = _of(lg, tid)
        assert spent == pytest.approx(0.7) and held == pytest.approx(0.0), tid   # counted exactly once, at its real cost
        assert not _fits_on(lg, tid, 0.4) and _fits_on(lg, tid, 0.3), tid
    lg.sessions.adopt_ask_threads()   # moving again changes nothing
    for tid in threads:
        assert _of(lg, tid)[2] == pytest.approx(0.7), tid


def test_stand_in_r12_p1_two_mixed_threads_both_keep_the_ambiguous_hold(tmp_path):
    """Stand-in P1 on r1.2: two mixed-history $1 threads, one untagged $0.80 unknown mind hold. r1.2 held $0.80 and $0;
    settling at $0.70 left the second thread's spend at $0 and a $0.40 call was admitted."""
    lg = _Legacy(tmp_path, mixed=True)
    second = _thread(lg, "se_second")
    threads = _ambiguous(lg, [lg.THREAD, second])
    _assert_each_holds_then_spends(lg, threads)
    shared = {r["thread_id"] for r in lg.db.all("SELECT thread_id FROM ask_shared_holds WHERE reservation = 'mindcall'")}
    assert shared == {lg.THREAD, second}   # recorded as a migration label, shared by both, not as attribution


def test_three_mixed_threads_each_keep_the_ambiguous_hold(tmp_path):
    lg = _Legacy(tmp_path, mixed=True)
    threads = _ambiguous(lg, [lg.THREAD, _thread(lg, "se_b"), _thread(lg, "se_c")])
    _assert_each_holds_then_spends(lg, threads)


def test_order_reversed_mixed_threads_each_keep_the_ambiguous_hold(tmp_path):
    """The same with the threads met in the other order (the fixture's thread inserted last)."""
    lg = _Legacy(tmp_path, mixed=True)
    first = lg.thread()
    lg.db.execute("DELETE FROM work_sessions WHERE id = ?", (lg.THREAD,))
    other = _thread(lg, "se_a_first")
    lg.db.insert("work_sessions", dict(first))
    order = [r["id"] for r in lg.db.all("SELECT id FROM work_sessions WHERE agent_id = ? ORDER BY rowid", (lg.MIND,))]
    assert order == [other, lg.THREAD]
    threads = _ambiguous(lg, [other, lg.THREAD])
    _assert_each_holds_then_spends(lg, threads)


def test_a_mixed_thread_moving_later_still_takes_a_hold_an_earlier_thread_was_given(tmp_path):
    """Across time, not only within one loop: the second thread has a turn the mind is still answering, so it moves only
    on a later adoption, after the first thread's migration labelled the hold."""
    lg = _Legacy(tmp_path, mixed=True)
    late = _thread(lg, "se_late", turn_state="thinking")
    assert _ambiguous(lg, [lg.THREAD]) == [lg.THREAD]
    lg.db.execute("UPDATE ask_turns SET state = 'done' WHERE id = ?", ("mt_" + late,))
    assert lg.sessions.adopt_ask_threads() == [late]
    _assert_each_holds_then_spends(lg, [lg.THREAD, late])


def test_real_attribution_to_another_thread_still_excludes_while_shared_labels_do_not(tmp_path):
    """A call another thread made under its own scope (askthread:<a>, real attribution) and another thread's own Ask turn
    stay theirs; only the mind's ambiguous hold is shared. A conductor-only thread takes none of the mind's calls."""
    lg = _Legacy(tmp_path, mixed=True)
    lg.hold("mindcall", 0.8, [f"agent:{lg.MIND}:total"])
    lg.to_state("mindcall", "unknown")
    lg.hold("a_own", 0.1, [f"agent:{lg.MIND}:total", "askthread:se_elsewhere"])
    lg.hold("a_turn", 0.05, [f"agent:{lg.MIND}:total", "askturn:turn_elsewhere"])
    second = _thread(lg, "se_second")
    solo = _thread(lg, "se_solo", mixed=False)
    lg.sessions.adopt_ask_threads()
    for tid in (lg.THREAD, second):
        assert _of(lg, tid)[3] == pytest.approx(0.8), tid
    assert _of(lg, solo)[3] == pytest.approx(0.0)
    assert lg.db.one("SELECT COUNT(*) AS n FROM ask_shared_holds WHERE reservation IN ('a_own', 'a_turn')")["n"] == 0


def test_a_threads_own_turn_call_is_never_downgraded_to_a_shared_label(tmp_path):
    """The thread's own conductor turn's call is real attribution (labelled first); the mixed sweep must not record it as
    shared, and another mixed thread never takes it."""
    lg = _Legacy(tmp_path, mixed=True)
    lg.hold("own", 0.3, [f"agent:{lg.MIND}:total", "askturn:" + lg.TURN])
    second = _thread(lg, "se_second")
    lg.sessions.adopt_ask_threads()
    assert lg.db.one("SELECT COUNT(*) AS n FROM ask_shared_holds WHERE reservation = 'own'")["n"] == 0
    assert _of(lg, lg.THREAD)[3] == pytest.approx(0.3)
    assert _of(lg, second)[3] == pytest.approx(0.0)
