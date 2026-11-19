# Purpose: tests of the spend-rate guard: a burst then the month's pace; spend in any window bounded by the burst plus
# the rate under every monthly figure it paces, a payer's, the hive's, a team's and a mind's (property-based); a day or
# total rule and a key's cap left to their limit alone; a call paced by the tightest of its paced figures, holding
# nothing on any; the difference given back when a call settles below its worst case or is released; a refused call
# holding nothing and saying when to retry (429 spend_rate with Retry-After), on the hive's cap and on a mind's own
# month cap; the guard surviving a restart; a call bigger than the burst; a mind looping on calls bigger than the burst
# that settle by themselves held to the month's pace; a person's own live work held by its limits alone, never paced
# or charged (whose own work a mind is doing, a tester's $1 month running Make through the chat route, and a Code
# request's helper and second opinion on a $2 month, the real engine driving it, and a mind answering its person's
# chat or room message until it answers or an Ask turn's time passes); a raised or lowered limit keeping the money
# ahead, so a raised cap frees its burst at once; and the month-apart clock other admission tests give Reservations so
# the guard is full at each of their calls.
"""The spend-rate guard (cost_reservations.guard_charges, its refund trigger, Hive.spend_rate_refusal, Hive.present_for)."""
import datetime
import math
import random

import pytest

from hive.core.ask import TIMEOUT as ASK_TIMEOUT
from hive.core.cost_reservations import BudgetExhausted, GUARD_BURST_SECONDS, GUARD_MONTH_SECONDS, Reservations, SpendRateLimited
from hive.core.create_plan_engine import goal_creator
from hive.core.db import Database, now, stamp_of
from hive.tests.test_code_controller_engine import ORIGIN, add_reviewer, fake, helper_finishes, reviewer_finishes, run, x  # noqa: F401  (fixture)
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL as PAID, _fake_chat, _gateway
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_proposal_tests import SUGGESTION
from hive.tests.test_visibility import person

LABEL, LIMIT = "person:u_0a0b0c0d:month", 50.0
# every monthly figure the guard paces, and the figures it leaves to their limit alone (cost_reservations.guarded)
GUARDED = [LABEL, "hive:month", "swarm:s_0a0b0c0d:month", "agent:a_0a0b0c0d:month"]
LIMIT_ALONE = ["person:u_0a0b0c0d:day", "hive:day", "swarm:s_0a0b0c0d:day", "agent:a_0a0b0c0d:total", "key:k_0a0b0c0d:month"]
RATE = LIMIT / GUARD_MONTH_SECONDS          # dollars a second: $1.67 a day
BURST = LIMIT * GUARD_BURST_SECONDS / GUARD_MONTH_SECONDS   # $5


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class MonthApart:
    """A guard clock that moves a month on at each reading, so the guard is full at every reservation and a test of
    admission's arithmetic sees that alone (Reservations(db, clock=MonthApart())); the guard's pacing is tested here."""
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        self.t += GUARD_MONTH_SECONDS
        return self.t


def rows():
    return [(LABEL, LIMIT, 0.0)]


def guard(tmp_path, clock, name="g.db"):
    return Reservations(Database(tmp_path / name), clock=clock)


def call(res, key, worst, settle_at=None, release=False, label=LABEL):
    """Reserve one call held against label's $50 a month; settle it at settle_at (its worst case by default) or release
    it. Raises SpendRateLimited."""
    res.reserve(key, {"k": key}, worst, lambda: [(label, LIMIT, 0.0)], dispatched=True)
    if release:
        assert res.release_unbilled(key, 402)
    else:
        res.settle(key, worst if settle_at is None else settle_at, lambda: None)


def tat(res, label=LABEL):
    row = res.db.one("SELECT tat FROM limit_rates WHERE label = ?", (label,))
    return None if row is None else row["tat"]


def test_a_burst_then_the_months_pace(tmp_path):
    clock = Clock()
    res = guard(tmp_path, clock)
    for i in range(10):                                                   # the $5 burst: ten $0.50 calls at once
        call(res, f"r{i}", 0.5)
    with pytest.raises(SpendRateLimited) as refused:
        call(res, "r10", 0.5)
    assert refused.value.scope == LABEL and refused.value.limit_usd == LIMIT
    assert refused.value.retry_after == math.ceil(0.5 / RATE) == 25920    # $0.50 at $1.67 a day: 7.2 hours
    clock.t += 25920
    call(res, "r11", 0.5)                                                  # one call's worth has refilled
    with pytest.raises(SpendRateLimited):
        call(res, "r12", 0.5)


def random_calls(rnd):
    """1 to 60 calls, each (the gap before it, up to two days; its worst case, a cent to the whole burst; the share of it
    really spent; released or not), a fifth of the draws taking an edge instead: no gap, a cent or the whole burst, none
    or all of it spent."""
    def pick(edge, draw):
        return edge if rnd.random() < 0.2 else draw
    return [(pick(0.0, rnd.uniform(0, 2 * 86400)), pick(rnd.choice([0.01, BURST]), rnd.uniform(0.01, BURST)),
             pick(rnd.choice([0.0, 1.0]), rnd.random()), rnd.random() < 0.3) for _ in range(rnd.randint(1, 60))]


@pytest.mark.parametrize("label", GUARDED)
def test_what_is_spent_under_any_paced_figure_in_any_window_stays_under_the_burst_plus_the_rate(tmp_path, label):
    rnd = random.Random(107)                                              # seeded: a failing case repeats, and is named
    for case in range(60):
        clock = Clock()
        res = guard(tmp_path, clock, f"g{case}.db")
        spent = []                                                        # (when, what it really cost) for each admitted call
        for i, (gap, worst, share, release) in enumerate(random_calls(rnd)):
            clock.t += gap
            actual = 0.0 if release else round(worst * share, 6)
            try:
                call(res, f"p{i}", worst, settle_at=actual, release=release, label=label)
            except SpendRateLimited as exc:
                assert exc.retry_after >= 1 and res.get(f"p{i}") is None, (case, i)   # nothing held
                continue
            spent.append((clock.t, actual))
        for i, (start, _) in enumerate(spent):
            total = 0.0
            for end, cost in spent[i:]:
                total += cost
                assert total <= BURST + RATE * (end - start) + 1e-6, (case, start, end, total)


@pytest.mark.parametrize("label", LIMIT_ALONE)
def test_a_day_or_total_rule_and_a_keys_cap_are_left_to_their_limit_alone(tmp_path, label):
    res = guard(tmp_path, Clock())
    for i in range(30):                                                   # $15 at once, three bursts: the limit alone holds them
        call(res, f"f{i}", 0.5, label=label)
    assert res.db.one("SELECT COUNT(*) AS n FROM limit_rates")["n"] == 0


def test_a_call_is_paced_by_the_tightest_of_its_paced_figures_and_holds_nothing_on_any(tmp_path):
    clock = Clock()
    res = guard(tmp_path, clock)
    mind = "agent:a_0a0b0c0d:month"
    both = lambda: [(LABEL, LIMIT, 0.0), (mind, 5.0, 0.0)]                # the payer's $50 a month and the mind's own $5
    res.reserve("m1", {"k": "m1"}, 0.5, both, dispatched=True)            # the mind's whole burst, a tenth of its $5
    res.settle("m1", 0.5, lambda: None)
    payer, paced = tat(res), tat(res, mind)
    with pytest.raises(SpendRateLimited) as refused:
        res.reserve("m2", {"k": "m2"}, 0.5, both, dispatched=True)
    assert refused.value.scope == mind and refused.value.limit_usd == 5.0
    assert refused.value.retry_after == math.ceil(0.5 * GUARD_MONTH_SECONDS / 5.0)      # $0.50 at $5 a month: 3 days
    assert res.get("m2") is None and (tat(res), tat(res, mind)) == (payer, paced)       # nothing held, neither charged


def test_settling_below_the_worst_case_or_releasing_gives_the_difference_back(tmp_path):
    clock = Clock()
    res = guard(tmp_path, clock)
    per_dollar = GUARD_MONTH_SECONDS / LIMIT                              # 51840 s of tat a dollar
    call(res, "a", 1.0, settle_at=0.25)                                   # charged a dollar's time, three quarters back
    assert tat(res) == pytest.approx(clock.t + 0.25 * per_dollar)
    call(res, "b", 1.0, release=True)                                     # released: all of it back
    assert tat(res) == pytest.approx(clock.t + 0.25 * per_dollar)
    res.reserve("c", {"k": "c"}, 1.0, rows, dispatched=True)
    res.unknown("c")
    assert tat(res) == pytest.approx(clock.t + 1.25 * per_dollar)        # an unknown call keeps its worst case charged
    assert res.db.one("SELECT COUNT(*) AS n FROM limit_rate_charges")["n"] == 1
    res.settle("c", 1.0, lambda: None)                                    # settled at its worst case: nothing back
    assert tat(res) == pytest.approx(clock.t + 1.25 * per_dollar)
    assert res.db.one("SELECT COUNT(*) AS n FROM limit_rate_charges")["n"] == 0


def test_a_call_bigger_than_the_burst_goes_only_from_a_full_guard(tmp_path):
    clock = Clock()
    res = guard(tmp_path, clock)
    call(res, "small", 0.01)
    with pytest.raises(SpendRateLimited) as refused:                      # $6 is more than the $5 burst
        call(res, "big", 6.0)
    clock.t += refused.value.retry_after
    call(res, "big", 6.0)                                                  # the guard was full again: admitted
    with pytest.raises(SpendRateLimited):
        call(res, "after", 0.01)


def test_a_mind_looping_on_big_calls_that_settle_by_themselves_is_held_to_the_months_pace(tmp_path):
    """A tester's case (Lisbon, v0.27): a mind repeating $5 to $10 calls whose outcome goes unknown. With nobody
    releasing them, each settles at its worst case by itself, so the guard is what holds the loop. On a $50 month the $5
    burst lets the first $7.50 call through from a full guard and the next only once that has refilled, 4.5 days on,
    where the month's figure alone would let six through in the first hour."""
    clock = Clock()
    res = guard(tmp_path, clock)
    admitted = []
    for i in range(6 * 24):                                               # a call every ten minutes for a day
        try:
            res.reserve(f"loop{i}", {"k": f"loop{i}"}, 7.5, rows, dispatched=True)
        except SpendRateLimited:
            assert res.get(f"loop{i}") is None                            # a refused call holds nothing
        else:
            res.unknown(f"loop{i}")
            res.settle(f"loop{i}", 7.5, lambda: None)                      # settled at its worst case, nothing back
            admitted.append(clock.t)
        clock.t += 600
    assert len(admitted) == 1                                              # $7.50 of the $50 in the day
    clock.t = admitted[0] + 7.5 * GUARD_MONTH_SECONDS / LIMIT - 1          # a second before 4.5 days on: not yet
    with pytest.raises(SpendRateLimited):
        call(res, "early", 7.5)
    clock.t += 1
    call(res, "next", 7.5)                                                 # 4.5 days on the guard is full again


def test_the_guard_survives_a_restart(tmp_path):
    clock = Clock()
    res = guard(tmp_path, clock)
    for i in range(10):
        call(res, f"r{i}", 0.5)
    again = guard(tmp_path, clock)                                        # a new process on the same database
    with pytest.raises(SpendRateLimited):
        call(again, "r10", 0.5)


def test_a_call_the_guard_refuses_holds_nothing_and_says_when_to_retry(client):
    h = client.app.state.hive
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": LIMIT}).status_code == 200
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}
    assert client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body).status_code == 200
    import time
    h.db.execute("UPDATE limit_rates SET tat = ? WHERE label = 'hive:month'", (time.time() + GUARD_BURST_SECONDS,))
    before = h.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body)
    assert r.status_code == 429, r.text
    error = r.json()["error"]
    assert error["code"] == "spend_rate" and (error["scope"], error["period"]) == ("hive", "month")
    assert error["say"] == error["message"] and "hive" not in error["say"]  # the mind's wait says the hive's own words
    assert error["retry_after"] >= 1 and r.headers["Retry-After"] == str(error["retry_after"]) and error["until"].endswith("Z")
    assert h.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == before          # nothing held
    assert h.slowed[a["id"]] == error["until"]                                            # announced once, budget.slowed
    assert client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body).status_code == 429
    assert h.slowed[a["id"]] == error["until"]


def test_a_minds_own_month_cap_is_paced_and_the_refusal_names_it(client):
    h = client.app.state.hive
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": LIMIT}).status_code == 200
    assert client.post("/api/budgets", json={"scope": f"agent:{a['id']}", "period": "month", "limit_usd": 5.0}).status_code == 200
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}
    assert client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body).status_code == 200
    label = f"agent:{a['id']}:month"
    assert h.db.one("SELECT tat FROM limit_rates WHERE label = ?", (label,)) is not None   # the mind's own cap is paced
    import time
    h.db.execute("UPDATE limit_rates SET tat = ? WHERE label = ?", (time.time() + GUARD_BURST_SECONDS, label))
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body)
    assert r.status_code == 429, r.text
    error = r.json()["error"]
    assert error["code"] == "spend_rate" and (error["scope"], error["period"]) == (f"agent:{a['id']}", "month")
    assert error["limit_usd"] == 5.0 and error["retry_after"] >= 1


def test_a_persons_own_work_is_held_by_its_limits_alone_and_leaves_the_guard_full(tmp_path):
    """A tester's v0.35 gate: on a $1 month a planner call reserves $0.0996 (its prompt plus the 4,096 tokens the hive
    assumes), nearly the whole $0.10 burst, so after one settled at $0.0235 the next waited about 17 hours. A call a
    person's own live work holds (paced=False, Hive.present_for) goes on until the month itself runs out, charging the
    guard nothing; a mind on its own is paced as before."""
    clock = Clock()
    res = guard(tmp_path, clock)
    month = lambda spent: (lambda: [("hive:month", 1.0, spent)])
    res.reserve("alone1", {"k": "alone1"}, 0.0996, month(0.0), dispatched=True)
    res.settle("alone1", 0.0235, lambda: None)
    with pytest.raises(SpendRateLimited) as refused:                     # a mind on its own: the month's pace
        res.reserve("alone2", {"k": "alone2"}, 0.0996, month(0.0235), dispatched=True)
    # 0.0235 x 30 days of tat, plus this call's 0.0996 x 30 days, past the burst's 3 days: about 998 minutes
    assert refused.value.retry_after == math.ceil((0.0235 + 0.0996 - 0.1) * GUARD_MONTH_SECONDS / 1.0)
    charged = tat(res, "hive:month")
    spent, made = 0.0235, 0
    for i in range(60):                                                  # the person's own work: Make's calls, one by one
        try:
            res.reserve(f"own{i}", {"k": f"own{i}"}, 0.0996, month(spent), dispatched=True, paced=False)
        except BudgetExhausted as exc:
            assert exc.scope == "hive:month" and spent + 0.0996 > 1.0     # the month itself, not its pace, stops it
            break
        res.settle(f"own{i}", 0.0235, lambda: None)
        spent, made = round(spent + 0.0235, 6), made + 1
    assert made == 38 and tat(res, "hive:month") == charged             # $0.89 more in one sitting, the guard untouched
    assert res.db.one("SELECT COUNT(*) AS n FROM limit_rate_charges")["n"] == 0


def plan_run(h, person, phase="building"):
    """A Create plan's run as CreatePlanEngine.start records it (the reducer isn't run: only its row is read here)."""
    pid = "plan_" + "0a" * 16
    h.db.insert("create_plan_runs", {"plan_id": pid, "person": person, "sentence": "a tip calculator", "epoch": "ep-test",
                                     "reducer_sha256": "0" * 64, "review_policy": "review-required", "lease": 1,
                                     "piece_cap": 1, "fix_cap": 1, "phase": phase, "status": "building",
                                     "created_at": now(), "updated_at": now()})
    return pid


def test_a_mind_is_a_persons_own_work_while_their_session_or_live_plan_holds_it(client):
    h = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client, n=2, model=PAID)
    mind, person = h.agent(a["id"]), "user:u_0a0b0c0d"
    assert h.present_for(mind) is None                                   # on its own
    pid = plan_run(h, person)
    goal = h.goals._create_record(swarm["id"], f"Create plan {pid}: plan", created_by=goal_creator(pid), assignee=a["id"],
                                emit=False)
    h.settings.create_plan_engine = False                                # every install turns it on (Jon on #395)
    assert h.present_for(mind) is None                                   # the plan engine is off: no plan is live
    h.settings.create_plan_engine = True
    assert h.present_for(mind) == person and h.present_for(h.agent(b["id"])) is None
    assert h.user_for(mind) == h.user_for(h.agent(b["id"]))              # who it's for and pays is unchanged
    for status, waited in (("claimed", True), ("waiting", True), ("stalled", True), ("submitted", False),
                           ("done", False), ("failed", False), ("cancelled", False), ("open", True)):
        h.db.execute("UPDATE goals SET status = ? WHERE id = ?", (status, goal["id"]))
        assert (h.present_for(mind) == person) is waited, status          # answered or ended: the plan no longer waits
    for phase, live in (("ready-to-deploy", True), ("deployed", False), ("stopped", False)):
        h.db.execute("UPDATE create_plan_runs SET phase = ? WHERE plan_id = ?", (phase, pid))
        assert (h.present_for(mind) == person) is live, phase
    h.goals._create_record(swarm["id"], "my own idea", created_by=f"agent:{b['id']}", assignee=b["id"], emit=False)
    h.db.execute("UPDATE create_plan_runs SET phase = 'building' WHERE plan_id = ?", (pid,))
    assert h.present_for(h.agent(b["id"])) is None                       # a goal no plan gave it is the mind's own
    h.db.insert("work_sessions", {"id": "ws_0a0b0c0d", "room_id": "r", "agent_id": b["id"], "owner": "user:u_0e0f0a0b",
                                  "title": "pairing", "budget_usd": 1.0, "spent_at_start": 0.0, "created_at": now()})
    assert h.present_for(h.agent(b["id"])) == "user:u_0e0f0a0b" == h.user_for(h.agent(b["id"]))   # a Session holds it


def test_a_mind_on_a_persons_live_plan_spends_to_the_month_limit_unpaced_and_on_its_own_is_paced(client):
    """The tester's $1 hive month through the chat route: a mind on its own gets one call from the full guard and the
    next is paced (429); working a goal of the person's live plan its calls go on until the month refuses one (402),
    charging the guard nothing; with that goal answered it is on its own and paced again."""
    h = client.app.state.hive
    h.settings.create_plan_engine = True
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 1.0}).status_code == 200
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "plan a tip calculator"}], "max_tokens": 800}   # about $0.06 a call
    post = lambda: client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body)
    assert post().status_code == 200
    r = post()
    assert r.status_code == 429 and r.json()["error"]["code"] == "spend_rate"
    charged = h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"]
    pid = plan_run(h, "user:u_0a0b0c0d")
    goal = h.goals._create_record(swarm["id"], f"Create plan {pid}: plan", created_by=goal_creator(pid), assignee=a["id"],
                                emit=False)
    assert [post().status_code for _ in range(3)] == [200, 200, 200]
    h.db.execute("UPDATE goals SET status = 'submitted' WHERE id = ?", (goal["id"],))
    assert post().status_code == 429                                     # answered: the mind is on its own again
    h.db.execute("UPDATE goals SET status = 'claimed' WHERE id = ?", (goal["id"],))
    codes = []
    while not codes or codes[-1] == 200:
        codes.append(post().status_code)
        assert len(codes) <= 20
    assert codes[-1] == 402 and len(codes) > 5                           # the month itself stops it, never its pace
    spent = h.db.one("SELECT COALESCE(SUM(actual), 0) AS n FROM cost_reservations WHERE state = 'settled'")["n"] / 1e6
    assert spent > 0.9                                                   # most of the $1 month, in one sitting
    assert h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"] == charged   # nothing charged


def test_a_code_requests_helper_and_second_opinion_are_its_persons_own_work_until_they_are_done_with_it(x, monkeypatch):
    """A tester's v0.36 gate on a $2 hive month: a Code helper's first call came from the full guard and its second was
    held about 13 hours, so the request sat writing with no candidate. Here the real engine drives a request while its
    minds call the chat route. The helper is the asking person's from its spawn until the request ends and its
    allocation goes back, and the second opinion from its wake until it answers: past the guard's pace their calls go
    on, held by the person's limits alone and charging the guard nothing. A reviewer that has answered, a helper whose
    request has ended, and the controller mind throughout are on their own and paced."""
    h, jon = x.hive, "user:u_jon"
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    reviewer = add_reviewer(x)
    assert x.client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 2.0}).status_code == 200
    _fake_chat(_gateway(x.client), delay=0)
    body = {"messages": [{"role": "user", "content": "propose the change"}], "max_tokens": 800}   # about $0.06 a call
    post = lambda headers: x.client.post("/llm/v1/chat/completions", headers=headers, json=body).status_code
    seen, spawn, wake = {}, h.minds.spawn, h.send_to_agent

    async def spawn_and_look(agent, data, acting=None):     # the helper's first moment, before its attempt names it
        out = await spawn(agent, data, acting=acting)
        child = h.db.one("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))["id"]
        seen["helper"] = h.present_for(h.agent(child))
        return out

    async def wake_and_look(agent_id, text, **kw):           # the reviewer's first moment, before its review waits
        if agent_id == reviewer["id"]:
            seen["reviewer"] = h.present_for(h.agent(agent_id))
        return await wake(agent_id, text, **kw)
    monkeypatch.setattr(h.minds, "spawn", spawn_and_look)
    monkeypatch.setattr(h, "send_to_agent", wake_and_look)
    for mind in (x.ctl, reviewer):
        h.db.update("agents", mind["id"], {"model": PAID})
    ctl, rev = agent_headers(x.ctl), agent_headers(reviewer)
    codes = []
    while not codes or codes[-1] == 200:                      # the controller on its own: the burst, then the pace
        codes.append(post(ctl))
        assert len(codes) <= 10
    assert codes[-1] == 429
    charged = h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"]

    assert run(x.engine.step(x.rid))["status"] == "writing"   # one helper attempt open
    child = h.db.one("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))["id"]
    h.db.update("agents", child, {"model": PAID})
    helper = {"Authorization": f"Bearer {x.tokens[child]}"}
    assert seen["helper"] == jon == h.present_for(h.agent(child))
    assert h.present_for(h.agent(reviewer["id"])) is None and h.present_for(h.agent(x.ctl["id"])) is None
    assert [post(helper), post(helper), post(ctl)] == [200, 200, 429]   # past the guard's pace, the person's own work goes

    helper_finishes(x, 1, SUGGESTION)                         # tested, and the reviewer woken; the helper is still theirs
    assert x.engine.view(x.rid)["status"] == "reviewing"
    assert seen["reviewer"] == jon == h.present_for(h.agent(reviewer["id"])) == h.present_for(h.agent(child))
    assert [post(rev), post(rev), post(helper), post(ctl)] == [200, 200, 200, 429]

    reviewer_finishes(x, "pass")                              # answered: the reviewer is on its own again
    assert x.engine.view(x.rid)["status"] == "ready_for_you"
    assert h.present_for(h.agent(reviewer["id"])) is None and post(rev) == 429
    out = x.client.post(f"/api/requests/{x.rid}/controller/apply", headers={**x.jon, **ORIGIN})
    assert out.status_code == 200 and out.json()["status"] == "applied"   # delivered: the helper stopped, its allocation back
    assert h.present_for(h.agent(child)) is None
    assert h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"] == charged   # nothing charged


def test_a_mind_answering_its_persons_chat_or_room_message_is_their_live_work_until_it_answers(client):
    """A tester's v0.38 hive: her minds answering her in their chat and in a room were paced like a mind alone, so on her
    month their calls waited on the guard ("Spending faster than this month allows") at about $0.05 each. A person's
    message the mind hasn't answered yet holds it for them, in its chat or in a room that @mentioned it, until it answers
    there or an Ask turn's TIMEOUT has passed since they sent it; another mind's message never holds it."""
    h = client.app.state.hive
    ana = person(client, "u_ana")
    swarm, (a, b) = make_swarm_and_agents(client, n=2, model=PAID)
    for mind in (a, b):
        h.db.update("agents", mind["id"], {"owner": "user:u_ana"})          # Ana's own minds, Dot0 and Dot1
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 1.0}).status_code == 200
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "alphabetize the list"}], "max_tokens": 800}   # about $0.06 a call
    post = lambda mind: client.post("/llm/v1/chat/completions", headers=agent_headers(mind), json=body).status_code
    assert [post(a), post(a)] == [200, 429]                                 # on its own: one call, then the pace
    charged = h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"]
    mind = lambda m: h.agent(m["id"])

    said = client.post(f"/api/agents/{a['id']}/messages", headers=ana, json={"text": "what's on my list?"})
    assert said.status_code == 200, said.text
    chat = said.json()["conversation_id"]
    assert h.present_for(mind(a)) == "user:u_ana" and h.present_for(mind(b)) is None
    assert [post(a), post(a), post(b)] == [200, 200, 429]                   # answering Ana, past the guard's pace
    h.record_agent_message(a["id"], {"text": "three things", "conversation_id": chat})
    assert h.present_for(mind(a)) is None and post(a) == 429                # answered: on its own again

    room = client.post("/api/rooms", json={"kind": "group", "name": "Lists", "members": ["user:u_ana", f"agent:{a['id']}",
                                                                                    f"agent:{b['id']}"]}).json()
    asked = client.post(f"/api/rooms/{room['id']}/messages", headers=ana, json={"text": "@Dot1 please alphabetize the list"})
    assert asked.status_code == 200 and asked.json()["delivered_to"] == [f"agent:{b['id']}"], asked.text
    assert h.present_for(mind(b)) == "user:u_ana" and h.present_for(mind(a)) is None   # only the mind she @mentioned
    assert [post(b), post(a)] == [200, 429]
    h.record_agent_message(b["id"], {"text": "done", "conversation_id": room.get("alias") or room["id"]})
    assert h.present_for(mind(b)) is None and post(b) == 429

    h.enqueue_message(b["id"], "and the next list?", f"c_{b['id']}", f"agent:{a['id']}")   # another mind asking: on its own
    assert h.present_for(mind(b)) is None
    late = client.post(f"/api/agents/{b['id']}/messages", headers=ana, json={"text": "still there?"}).json()
    assert h.present_for(mind(b)) == "user:u_ana"
    old = stamp_of(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=ASK_TIMEOUT + 1))
    h.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (old, late["id"]))
    assert h.present_for(mind(b)) is None and post(b) == 429                # sent longer ago than an Ask turn waits
    assert h.db.one("SELECT tat FROM limit_rates WHERE label = 'hive:month'")["tat"] == charged   # nothing charged


def test_a_raised_limit_frees_its_larger_burst_at_once_and_a_lowered_one_slows_at_once(tmp_path):
    """Raising a limit used to shorten each wait in proportion but free no burst: the time ahead stayed as the old pace
    had counted it, up to 3 days. The money ahead is what is kept, so a raised cap admits a call at once and a lowered
    one waits for its own pace, and a call open across the change gives back its share at the new pace."""
    clock = Clock()
    res = guard(tmp_path, clock)
    cap = {"usd": 50.0}
    rows = lambda: [(LABEL, cap["usd"], 0.0)]
    for i in range(4):                                                     # $4 settled at its worst case, $1 still open
        res.reserve(f"s{i}", {"k": i}, 1.0, rows, dispatched=True)
        res.settle(f"s{i}", 1.0, lambda: None)
    res.reserve("open", {"k": "open"}, 1.0, rows, dispatched=True)
    with pytest.raises(SpendRateLimited):                                  # the $5 burst of a $50 month is spent
        res.reserve("late", {"k": "late"}, 1.0, rows, dispatched=True)
    cap["usd"] = 500.0                                                     # raised tenfold: $5 ahead is a tenth of the burst
    res.reserve("raised", {"k": "raised"}, 1.0, rows, dispatched=True)
    assert tat(res) == pytest.approx(clock.t + 6.0 * GUARD_MONTH_SECONDS / 500.0)       # $6 ahead at the new pace
    assert res.release_unbilled("open", 402)
    assert tat(res) == pytest.approx(clock.t + 5.0 * GUARD_MONTH_SECONDS / 500.0)       # the open dollar comes back whole
    cap["usd"] = 10.0                                                      # lowered: $5 ahead is past a $1 burst
    with pytest.raises(SpendRateLimited) as slowed:
        res.reserve("lowered", {"k": "lowered"}, 0.5, rows, dispatched=True)
    assert slowed.value.retry_after == math.ceil((5.0 + 0.5 - 1.0) * GUARD_MONTH_SECONDS / 10.0)



def test_a_spending_limit_s_refusal_tells_the_mind_why_without_naming_the_limit(client):
    """A mind's wait shows the refusal's say to anyone who reads the mind, so a spending limit's refusal names no limit
    there (the limit's scope can name a person or a key); its message and fields keep the limit for whoever may see it."""
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 0.05}).status_code == 200
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 4096}   # about $0.31, past the $0.05 month
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(a), json=body)
    assert r.status_code == 402, r.text
    error = r.json()["error"]
    assert error["say"] == "A spending limit has no room for this call." and error["scope"] == "hive"
