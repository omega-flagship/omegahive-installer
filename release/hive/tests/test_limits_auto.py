"""Automatic limits from the hive total (limits_auto.derive, pure): ratios, overrides, edges and the never-above-T law."""

import random

import pytest

from hive.core import limits_auto as la


def rule(scope, period, limit, rid=None):
    return {"scope": scope, "period": period, "limit_usd": limit, "id": rid or f"b_{abs(hash((scope, period))) % 10**8:08d}"}


def teams(*counts, archived=()):
    return [{"id": f"s_{i:08x}", "archived": i in archived, "minds": c} for i, c in enumerate(counts)]


def minds_for(swarms):
    out = []
    for s in swarms:
        for j in range(s["minds"]):
            out.append({"id": f"a_{len(out):08x}", "swarm_id": s["id"], "budget_usd": 0, "explicit": False})
    return out


def test_no_hive_total_means_no_automatic_limits():
    sw = teams(1, 2)
    d = la.derive([rule("swarm:" + sw[0]["id"], "month", 7)], sw, minds_for(sw))
    assert d["total"] is None and d["limits"] == {}


def test_team_month_is_twice_an_equal_share_with_floor_and_ceiling():
    sw = teams(1, 1, 1, 1, 1, 1, 1, 1, 1)   # 9 active teams
    d = la.derive([rule("hive", "month", 1000)], sw, minds_for(sw))
    assert d["active_teams"] == 9
    for s in sw:
        assert d["limits"][("swarm:" + s["id"], "month")]["limit_usd"] == pytest.approx(1000 * 2 / 9, abs=1e-4)
        assert d["limits"][("swarm:" + s["id"], "day")]["limit_usd"] == pytest.approx(1000 * 2 / 9 / 10, abs=1e-4)
    assert d["limits"][("hive", "day")]["limit_usd"] == 100
    one = la.derive([rule("hive", "month", 1000)], teams(1), [])
    assert one["limits"][("swarm:s_00000000", "month")]["limit_usd"] == 1000      # never above T
    tiny = la.derive([rule("hive", "month", 10)], teams(*[1] * 100), [])
    assert tiny["limits"][("swarm:s_00000000", "month")]["limit_usd"] == 1.0       # the $1 floor
    tinier = la.derive([rule("hive", "month", 0.5)], teams(*[1] * 100), [])
    assert tinier["limits"][("swarm:s_00000000", "month")]["limit_usd"] == 0.5     # floor never above T


def test_override_replaces_auto_at_its_own_key_only_and_shrinks_the_pool():
    sw = teams(1, 1, 1)
    a, b = "swarm:" + sw[0]["id"], "swarm:" + sw[1]["id"]
    d = la.derive([rule("hive", "month", 100), rule(a, "month", 40)], sw, minds_for(sw))
    assert (a, "month") not in d["limits"] and d["limits"][(a, "day")]["limit_usd"] == 4.0   # its day comes from its own month
    assert d["active_teams"] == 2 and d["pool_usd"] == 60
    assert d["limits"][(b, "month")]["limit_usd"] == 60                             # 60 x min(1, 2/2)
    d2 = la.derive([rule("hive", "month", 100), rule(a, "month", 500)], sw, [])
    assert d2["pool_usd"] == 0 and d2["limits"][(b, "month")]["limit_usd"] == 1.0   # override capped at T; floor


def test_explicit_zero_team_stays_zero():
    sw = teams(2, 1)
    z = "swarm:" + sw[0]["id"]
    d = la.derive([rule("hive", "month", 100), rule(z, "month", 0)], sw, minds_for(sw))
    assert (z, "month") not in d["limits"] and d["limits"][(z, "day")]["limit_usd"] == 0
    assert d["limits"][("agent:a_00000000", "month")]["limit_usd"] == 0


def test_hive_day_rule_alone_is_the_total_x_30_and_keeps_its_own_day():
    d = la.derive([rule("hive", "day", 25)], teams(1), [])
    assert d["total"]["limit_usd"] == 750 and d["total"]["period"] == "day" and ("hive", "day") not in d["limits"]
    assert d["limits"][("hive", "month")]["limit_usd"] == 750                     # a day-only total is held per month too
    d = la.derive([rule("hive", "month", 1000), rule("hive", "day", 25)], teams(1), [])
    assert ("hive", "day") not in d["limits"]


def test_mind_month_share_every_mind_and_who_is_auto():
    sw = teams(4, 1, 0)
    ms = minds_for(sw)
    ms[1]["budget_usd"] = 5                       # its own lifetime cap: not auto
    ms[2]["explicit"] = True                      # an agent rule of its own: not auto
    ms.append({"id": "a_0000abcd", "swarm_id": None, "budget_usd": 0, "explicit": False})
    rules = [rule("hive", "month", 1000)]
    d = la.derive(rules, sw, ms)
    team = d["limits"][("swarm:" + sw[0]["id"], "month")]["limit_usd"]
    assert d["active_teams"] == 2 and team == 1000                                    # 1000 x min(1, 2/2)
    assert d["limits"][("agent:a_00000000", "month")]["limit_usd"] == pytest.approx(team * 2 / 4)
    assert ("agent:a_00000001", "month") not in d["limits"] and ("agent:a_00000002", "month") not in d["limits"]
    assert d["limits"][("agent:a_0000abcd", "month")]["limit_usd"] == 1000            # no team: one team share
    # a team with no minds yet is priced as the next active team
    assert d["limits"][("swarm:" + sw[2]["id"], "month")]["limit_usd"] == pytest.approx(1000 * 2 / 3, abs=1e-4)
    e = la.derive(rules + [rule("every-mind", "month", 20)], sw, ms)
    assert e["every_mind"]["limit_usd"] == 20 and e["limits"][("agent:a_00000000", "month")]["limit_usd"] == 20


def test_zero_total_and_no_teams():
    d = la.derive([rule("hive", "month", 0)], teams(1), minds_for(teams(1)))
    assert all(v["limit_usd"] == 0 for v in d["limits"].values())
    d = la.derive([rule("hive", "month", 50)], [], [])
    assert d["active_teams"] == 0 and list(d["limits"]) == [("hive", "day")] and d["limits"][("hive", "day")]["limit_usd"] == 5.0


def test_archived_teams_are_not_active():
    sw = teams(1, 1, archived=(1,))
    d = la.derive([rule("hive", "month", 100)], sw, [])
    assert d["active_teams"] == 1


def test_session_default():
    assert la.session_default(100) == 10 and la.session_default(1) == 0.25 and la.session_default(0.1) == 0.1
    assert la.session_default(5000) == 100 and la.session_default(0) == 0 and la.session_default(-3) == 0


@pytest.mark.parametrize("seed", range(60))
def test_property_admitted_spend_never_passes_the_total(seed):
    """Random hives over a 31-day month: a call is admitted only when every applicable limit (stored or auto, the total
    included) has room; day limits reset each day. Whatever the derived values add up to, floors included, everything
    admitted in the month stays within T, whether the total was set per month or per day (T = day x 30)."""
    rnd = random.Random(seed)
    per_day = seed % 3 == 0                       # a total set per day alone
    T = rnd.choice([0, 0.5, 3, 50, 1000])
    sw = teams(*[rnd.randint(0, 4) for _ in range(rnd.randint(0, 12))])
    ms = minds_for(sw)
    rules = [rule("hive", "day", T / 30) if per_day else rule("hive", "month", T)]
    for s in sw:
        if rnd.random() < 0.3:
            rules.append(rule("swarm:" + s["id"], rnd.choice(["month", "day"]), rnd.choice([0, 1, 7, 500, 5000])))
    if rnd.random() < 0.5:
        rules.append(rule("every-mind", "month", rnd.choice([0.5, 20, 5000])))
    d = la.derive(rules, sw, ms)
    assert T - 30e-6 <= d["total"]["limit_usd"] <= T                    # a day total is floor(day) x 30: never above
    limits = {(r["scope"], r["period"]): r["limit_usd"] for r in rules}
    limits.update({k: v["limit_usd"] for k, v in d["limits"].items()})
    assert ("hive", "month") in limits                                   # the month is always held
    for k, v in d["limits"].items():
        assert 0 <= v["limit_usd"] <= max(T, d["every_mind"]["limit_usd"] if d["every_mind"] and k[0].startswith("agent:") else T) + 1e-9
    month, admitted = {}, 0.0
    for _day in range(31) if ms else ():
        today = {}
        for _ in range(40):
            m = rnd.choice(ms)
            keys = [("hive", "month"), ("hive", "day"), ("swarm:" + m["swarm_id"], "month"), ("swarm:" + m["swarm_id"], "day"),
                    ("agent:" + m["id"], "month")]
            keys = [k for k in keys if k in limits]
            cost = rnd.choice([0.01, 0.1, 0.5, 2, 20])
            if all((today if k[1] == "day" else month).get(k, 0) + cost <= limits[k] + 1e-9 for k in keys):
                for k in keys:
                    book = today if k[1] == "day" else month
                    book[k] = book.get(k, 0) + cost
                admitted += cost
    assert admitted <= T + 1e-9


def test_derived_limits_never_round_up():
    """r5: a day rule of $0.010002 is a total of $0.30006; no derived value may exceed its exact figure (the old 4-place
    rounding enforced $0.3001)."""
    from decimal import Decimal
    sw = teams(1, 3, 2)
    ms = minds_for(sw)
    for rules in ([rule("hive", "day", 0.010002)], [rule("hive", "month", 0.30006)], [rule("hive", "month", 7.0000999)],
                  [rule("hive", "month", 1000), rule("every-mind", "month", 0.1234567)],
                  [rule("hive", "month", 0.333333333), rule("swarm:" + sw[0]["id"], "month", 0.1111119)]):
        d = la.derive(rules, sw, ms)
        T = Decimal(repr(d["total"]["limit_usd"]))
        if rules[0]["period"] == "day":
            assert d["limits"][("hive", "month")]["limit_usd"] == 0.30006
            assert Decimal(repr(d["limits"][("hive", "month")]["limit_usd"])) <= Decimal("0.010002") * 30
        for (scope, period), v in d["limits"].items():
            exact = Decimal(repr(v["limit_usd"]))
            assert exact == exact.quantize(Decimal("0.000001"))                      # micro-dollars
            cap = Decimal(repr(d["every_mind"]["limit_usd"])) if d["every_mind"] and scope.startswith("agent:") else T
            assert exact <= cap, (scope, period, exact, cap)
            if period == "day":
                assert exact <= T / 10 or scope == "hive", (scope, exact)
    assert la.session_default(0.2500009) == 0.25 and la.session_default(3.33333399) == 0.333333


def test_micro_dollars_are_exact_integers_with_no_float_heuristics():
    """r7: converted once, floored; arithmetic in integers. No rounding promotes a value across a micro boundary."""
    assert la.to_micros(0.2499999996) == 249999 and la.to_micros(0.2500009996) == 250000
    assert la.to_micros(0.3) - la.to_micros(0.2) == 100000
    assert la.to_micros(0.2500006) == 250000 and la.to_micros(0.30006) == 300060 and la.to_micros(-1) == 0
    assert la.to_micros(0.0000004, up=True) == 1 and la.to_micros(0.2, up=True) == 200000
    rnd = random.Random(3)
    for _ in range(2000):                                    # a session default never exceeds the headroom
        head = rnd.choice([0, 1, 249_999, 250_000, 250_001, 2_499_999, 10**9, rnd.randrange(0, 10**10)])
        d = la.session_default_micros(head)
        assert 0 <= d <= head and (head == 0 or d >= min(head, la.SESSION_MIN_MICROS))
        assert d <= la.SESSION_MAX_MICROS
