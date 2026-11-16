# Purpose: tests of the spend-rate guard: a burst then the month's pace; spend in any window bounded by the burst plus
# the rate under every monthly figure it paces, a payer's, the hive's, a team's and a mind's (property-based); a day or
# total rule and a key's cap left to their limit alone; a call paced by the tightest of its paced figures, holding
# nothing on any; the difference given back when a call settles below its worst case or is released; a refused call
# holding nothing and saying when to retry (429 spend_rate with Retry-After), on the hive's cap and on a mind's own
# month cap; the guard surviving a restart; a call bigger than the burst; an Ask turn's stop saying when the person can
# carry on; a mind looping on calls bigger than the burst that settle by themselves held to the month's pace; and the
# month-apart clock other admission tests give Reservations so the guard is full at each of their calls.
"""The spend-rate guard (cost_reservations.guard_charges, its refund trigger, Hive.spend_rate_refusal)."""
import math
import random

import pytest

from hive.core.conductor import _Stop, limit_frame, stop_say
from hive.core.cost_reservations import GUARD_BURST_SECONDS, GUARD_MONTH_SECONDS, Reservations, SpendRateLimited
from hive.core.db import Database
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL as PAID, _fake_chat, _gateway

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


def test_an_ask_turn_the_guard_pauses_says_when_the_person_can_carry_on():
    detail = {"code": "spend_rate", "kind": "spend_rate", "scope": "person:u_0a0b0c0d", "period": "month",
              "limit_usd": LIMIT, "retry_after": 90, "until": "2026-11-12T03:40:00Z", "estimate_usd": 0.05}
    assert stop_say(_Stop("spend_cap", detail)) == ("I stopped here: this is spending faster than this month allows, so "
                                                    "it's pausing for a moment. You can carry on in about 2 minutes.")
    frame = limit_frame(detail)
    assert frame["kind"] == "spend_rate" and frame["retry_after"] == 90 and frame["until"] == "2026-11-12T03:40:00Z"
