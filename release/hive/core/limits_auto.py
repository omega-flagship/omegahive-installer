"""Automatic spending limits, worked out from the hive total (PLATFORM_AUTO_BUDGET_LIMITS_PLAN_20261007 §2.2).

A person sets one hive total on the Limits page (the hive-scope ``month`` rule; a ``day`` rule alone counts as day x 30)
and, optionally, one every-mind limit (scope ``every-mind``, period ``month``). Everything else that has no stored value
of its own is derived from those, here, on every read: nothing derived is ever stored, so a change to the total, an
override or the number of teams takes effect at the next check.

Pure: no database, no clock. ``derive(rules, swarms, minds)`` returns the auto value for every (scope, period) key that
has no stored rule. A stored rule always replaces the auto value at its own key (larger or smaller) and never removes
the limits above it; the hive total is itself a stored rule, so it is checked on every paid call whatever the derived
values add up to.

Ratios (Jon approved the plan 2026-10-07):
- team month   = clamp(P x min(1, 2/N), floor = min($1, T), ceiling = T): twice an equal share of the pool P (the total
                 less the teams' own month limits, each capped at T) over the N active teams without one;
- team day     = the team's month (held to T) / 10;
- hive day     = T / 10, when the total is a month rule and no hive day rule is stored;
- hive month   = T (day x 30), when the total is a day rule alone: the month is held too;
- mind month   = only for a mind with no limit of its own (budget_usd 0 and no agent rule other than a session's cap):
                 the every-mind limit when set, else its team's month x min(1, 2/M) for the team's M minds; a mind
                 with no team gets one team share;
- session default = clamp(10% of what the mind has left, $0.25, $100), never above what it has left.

All of it is integer micro-dollars (r7, OmegaReview): every input is converted once at the boundary (to_micros: the
float's shortest decimal, floored to $0.000001; a spend is ceilinged, as reservations count it), every subtraction,
share, clamp and tenth is integer arithmetic (floor division), and a value goes back to dollars (micro / 1e6) only at
the edge. So 0.3 - 0.2 is 300000 - 200000 = 100000, with no float rounding anywhere.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal

MICRO = 1_000_000
SHARE = 2                   # twice an equal share (of the pool between teams, of a team's month between its minds)
FLOOR_MICROS = 1 * MICRO    # a newly active team can always do something (never above the total)
DAY_DIVISOR = 10            # a day may use a tenth of the month
DAYS_PER_MONTH = 30         # a hive day rule alone stands for day x 30 a month
SESSION_DIVISOR, SESSION_MIN_MICROS, SESSION_MAX_MICROS = 10, 250_000, 100 * MICRO


def to_micros(x, up=False):
    """Dollars to whole micro-dollars, exactly once: the float's shortest decimal (repr), floored (a limit), or
    ceilinged with up=True (a spend), never negative."""
    d = Decimal(repr(float(x or 0))) * MICRO
    return max(0, int(d.to_integral_value(rounding=ROUND_CEILING if up else ROUND_FLOOR)))


def dollars(micros):
    return micros / MICRO


def _r(x):
    """A dollar amount floored to the micro-dollar (to_micros and back): never rounded up."""
    return dollars(to_micros(x))


def _money(micros):
    return f"${dollars(micros):,.2f}"


def hive_total(rules):
    """The panel total T: the hive month rule, else the hive day rule x 30, else None (no automatic limits)."""
    by = {(r["scope"], r["period"]): r for r in rules}
    month, day = by.get(("hive", "month")), by.get(("hive", "day"))
    if month is not None:
        t = to_micros(month["limit_usd"])
        return {"limit_usd": dollars(t), "micros": t, "period": "month", "rule_id": month.get("id"),
                "basis": f"hive total {_money(t)} a month"}
    if day is not None:
        d = to_micros(day["limit_usd"])
        t = d * DAYS_PER_MONTH
        return {"limit_usd": dollars(t), "micros": t, "period": "day", "rule_id": day.get("id"),
                "basis": f"hive day limit {_money(d)} x 30 = {_money(t)} a month"}
    return None


def every_mind(rules):
    for r in rules:
        if r["scope"] == "every-mind" and r["period"] == "month":
            e = to_micros(r["limit_usd"])
            return {"limit_usd": dollars(e), "micros": e, "rule_id": r.get("id")}
    return None


def session_default_micros(remaining_micros):
    r = max(0, int(remaining_micros))
    return min(r, min(SESSION_MAX_MICROS, max(SESSION_MIN_MICROS, r // SESSION_DIVISOR)))


def session_default(remaining):
    """A session or task given no budget: a tenth of what the mind has left, at least $0.25, at most $100, and never
    more than it has left (0 when it has nothing left). remaining in dollars (already floored micro-dollars)."""
    return dollars(session_default_micros(to_micros(remaining)))


def _part(amount, count):
    """min(1, 2/count) of amount, in integers."""
    return amount if count <= SHARE else amount * SHARE // count


def derive(rules, swarms, minds):
    """rules: stored rows {scope, period, limit_usd, id}; swarms: [{id, archived, minds}] (minds = non-deleted minds);
    minds: [{id, swarm_id, budget_usd, explicit}] (explicit = it has an agent rule of its own, session caps aside).

    Returns {total, every_mind, active_teams, pool_usd, limits: {(scope, period): {limit_usd, micros, basis}}};
    ``limits`` holds auto values only, for keys with no stored rule, and is empty when there is no hive total."""
    total = hive_total(rules)
    out = {"total": total, "every_mind": every_mind(rules), "active_teams": 0, "pool_usd": None, "limits": {}}
    if total is None:
        return out
    T = total["micros"]
    stored = {(r["scope"], r["period"]): to_micros(r["limit_usd"]) for r in rules}
    own_month = {s["id"] for s in swarms if ("swarm:" + s["id"], "month") in stored}
    active = [s for s in swarms if not s.get("archived") and int(s.get("minds") or 0) > 0 and s["id"] not in own_month]
    N = len(active)
    P = max(0, T - sum(min(stored[("swarm:" + sid, "month")], T) for sid in own_month))
    floor = min(FLOOR_MICROS, T)
    out.update(active_teams=N, pool_usd=dollars(P))
    limits = out["limits"]

    def put(key, micros, basis):
        limits[key] = {"limit_usd": dollars(micros), "micros": micros, "basis": basis}

    def share(n):
        return min(T, max(floor, _part(P, n)))

    def share_basis(n):
        part = "the whole pool" if n <= SHARE else f"twice an equal share ({_money(P)} x 2/{n})"
        pool = _money(P) + " left after the swarms' own limits" if own_month else _money(P)
        return f"{total['basis']}; pool {pool}; {n} active swarm{'s' if n != 1 else ''}: {part}, at least {_money(floor)}"

    if ("hive", "day") not in stored and total["period"] == "month":
        put(("hive", "day"), T // DAY_DIVISOR, f"{total['basis']} / 10 a day")
    if ("hive", "month") not in stored and total["period"] == "day":
        # r4 (OmegaReview): a total set per day is also held per month, or a 31-day month passes day x 30
        put(("hive", "month"), T, total["basis"])

    active_ids = {s["id"] for s in active}
    team_month = {}
    for s in swarms:
        scope = "swarm:" + s["id"]
        if (scope, "month") in stored:
            team_month[s["id"]] = stored[(scope, "month")]
            month_basis = f"its own month limit {_money(team_month[s['id']])}"
        else:
            n = N if s["id"] in active_ids else N + 1   # a team with no minds yet: its share once it has one
            team_month[s["id"]] = share(n)
            put((scope, "month"), team_month[s["id"]], share_basis(n))
            month_basis = f"its auto month {_money(team_month[s['id']])}"
        if (scope, "day") not in stored:
            capped = min(team_month[s["id"]], T)   # an auto value is never above the total
            put((scope, "day"), capped // DAY_DIVISOR,
                f"{month_basis}{' (held to the total)' if capped < team_month[s['id']] else ''} / 10 a day")

    E = out["every_mind"]
    per_team = {}
    for m in minds:
        if m.get("swarm_id"):
            per_team[m["swarm_id"]] = per_team.get(m["swarm_id"], 0) + 1
    for m in minds:
        if to_micros(m.get("budget_usd")) > 0 or m.get("explicit") or ("agent:" + m["id"], "month") in stored:
            continue
        if E is not None:
            put(("agent:" + m["id"], "month"), E["micros"], f"every-mind limit {_money(E['micros'])} a month")
            continue
        sid = m.get("swarm_id")
        if sid in team_month:
            M = max(1, per_team.get(sid, 1))
            pool = min(team_month[sid], T)   # an auto value is never above the total
            part = "all of it" if M <= SHARE else f"twice an equal share ({_money(pool)} x 2/{M})"
            put(("agent:" + m["id"], "month"), _part(pool, M),
                f"its swarm's month {_money(pool)}{' (held to the total)' if pool < team_month[sid] else ''}, "
                f"{M} mind{'s' if M != 1 else ''}: {part}")
        else:
            n = max(N, 1)
            put(("agent:" + m["id"], "month"), share(n), f"no swarm: one swarm share; {share_basis(n)}")
    return out
