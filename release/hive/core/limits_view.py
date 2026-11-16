# Purpose: the Limits page's read model: the hive cap, each person's monthly allowance and the caps someone set, with
# their spend, holds and room, the old form defaults that can be removed, and what each mind is checked against.
"""The Limits page's read model (GET /api/budgets/limits), from the same Budgets calls admission and reservations use, so
what the page shows is what is enforced (Jon 2026-10-07: "surely they should match the number I set in the admin panel").

Every stored rule is in exactly one of three parts:
- ``hive``: the hive cap (Budgets.hive_cap: the hive month rule, else its day rule) with its spend, what calls not yet
  settled hold against it, its room and this month's pace; and HIVE_BUDGET_USD's all-time cap while the hive has no cap.
- ``people``: one row per enabled person, their monthly allowance on the hive's money with where it comes from
  (``source``: ``set``, their own person:<id> month rule; ``member-default``, the hive's member default; ``visitor``, the
  hive's visitor limit; ``none``, an admin with no rule of their own), their spend, held amount, what's left and their
  pace, and the key owners' grants to them (each holds their calls on that owner's key instead). Editing one sets their
  person:<id> month rule.
- ``caps``: every other stored rule (a swarm's, a mind's, a key's, the every-mind rule, a hive day or total rule beside
  the cap, a person's day or total rule), each with its spend, held amount and room. ``source`` is ``set``, or
  ``session`` for a mind total rule a work session installed for its duration (machinery: not removed from the page).
``old_defaults`` lists stored values that look like an old form's pre-filled figure, each with the change that removes it.
``minds`` says what each mind's paid calls are checked against (``checked``: the reservation labels, so ``{key: lowest
limit_usd}`` over its rows and the hive's and its swarm's equals the reservation snapshot; a mind's own budget_usd and a
session's total rule share ``agent:<id>:total``, the lower one holding), its headroom, the budgets a session or lease gets
by default, and its Ask threads (ask-limits r1: each held by its own cap, askthread:<id>, never folded into its rows).
``rulings`` are the fixed figures the hive's owner decided (the Ask thread, the conductor turn, the member allowance).
``key`` on every row is the exact label a paid call's reservation is checked under.
"""

from __future__ import annotations

import json

from .budgets import dollars, month_pace, to_micros


def _row(budgets, scope, period, limit, source, key=None, spent=None, **extra):
    """One limit as the page shows it: its spend, what calls not yet settled hold against it (held_usd, the same count
    admission adds) and the room left (admission's arithmetic: limit floored, spend ceilinged, holds subtracted), keyed
    by the label a call's reservation is checked under."""
    from .cost_reservations import held_usd
    key = key or f"{scope}:{period}"
    spent = budgets.spent(scope, period) if spent is None else spent
    held = held_usd(budgets.db, key)
    room = dollars(max(0, to_micros(limit) - to_micros(spent, up=True) - to_micros(held, up=True)))
    out = {"key": key, "scope": scope, "period": period, "limit_usd": round(float(limit), 6),
           "spent_usd": round(float(spent), 6), "held_usd": held, "room_usd": room, "source": source}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def scope_visible(hive, viewer, scope):
    """Whether this viewer may see a limit about this scope, with its numbers (Jon on #52: a limit's numbers go only to
    people allowed to see that limit). An admin sees every limit but one about another person's hidden personal mind or
    swarm. Anyone else sees a hive-wide limit, a team's or a mind's limit as they see that team or mind, and a limit on
    their own spending: their allowance (person), their own keys' limit or a grant to them (keyuse, one row per key
    owner, key and grantee: the owner and the grantee), and a limit on a key of theirs (key). Another person's allowance
    and key spending stay theirs and the admins'."""
    kind, _, ident = scope.partition(":")
    if viewer is None:
        return True
    if viewer.admin:   # every scope but another person's hidden personal mind or swarm (Visibility.hide_others_personal)
        return not (kind in ("swarm", "agent") and hive.visibility.hides(viewer, ident))
    if kind == "swarm":
        return viewer.sees(hive.visibility._swarm(ident))
    if kind == "agent":
        return viewer.sees(hive.visibility._agent(ident))
    if kind == "person":
        return viewer.principal == "user:" + ident   # a member sees their own allowance rule
    if kind == "keyuse":
        row = hive.db.one("SELECT owner, grantee FROM key_limits WHERE scope = ? LIMIT 1", (scope,))
        return bool(row) and viewer.principal in (row["owner"], row["grantee"])
    if kind == "key":
        return hive.ownhive.key_person(ident) == viewer.principal
    return kind in ("hive", "every-mind")


def unseen_limit(row):
    """A limit this viewer may not see (scope_visible), kept in its place among a mind's limits so a page can say a
    spending limit it can't change stops the mind, with nothing about whose limit it is or its numbers."""
    return {**{k: None for k in row}, "hidden": True}


def limit_frame(hive, viewer, text):
    """A budget.refused or budget.slowed frame as this receiver may read it: the limit that refused or paced the call
    (Hive.REFUSAL_LIMIT) only for someone who may see that limit (scope_visible), anyone else getting the event alone
    with hidden true (a pace keeps its until). Every other frame goes as it is."""
    if not text.startswith(('{"type": "budget.refused"', '{"type": "budget.slowed"')):
        return text
    try:
        event = json.loads(text)
    except ValueError:
        return text
    scope = event.get("scope")
    if not isinstance(scope, str) or scope_visible(hive, viewer, scope):
        return text
    return json.dumps({**{k: v for k, v in event.items() if k not in hive.REFUSAL_LIMIT}, "hidden": True})


def limits(budgets, viewer=None):
    """GET /api/budgets/limits. Time: r stored rules, p people and m minds, each row one spend and one held query, and
    each mind its headroom (its applicable rows); a page read, never on a call's path."""
    hive, db = budgets.hive, budgets.db
    settings = hive.settings
    env = settings.budget_env or {}
    rules = budgets.rules()
    stored = {(r["scope"], r["period"]): r for r in rules}
    session_rules = budgets.session_cap_rules()
    foundation_swarms, foundation_minds = budgets._foundation_ids()
    cap = budgets.hive_cap(rules)

    def at(rule):
        return _row(budgets, rule["scope"], rule["period"], rule["limit_usd"],
                    "session" if rule["id"] in session_rules else "set", rule_id=rule["id"], note=rule["note"] or None)

    # 1. the hive cap, and the server's all-time cap while there is none
    cap_row = at(stored[("hive", cap["period"])]) if cap else None
    all_time = None
    hard = budgets.hard_cap(rules)
    if hard:
        all_time = _row(budgets, "hive", "all-time", hard, "server-settings" if "HIVE_BUDGET_USD" in env else "default",
                        key="hive:hard-total", spent=budgets.hard_total_spent(), setting="HIVE_BUDGET_USD")
    month_spent = budgets.spent("hive", "month")
    hive_part = {"cap": cap_row, "all_time": all_time, "month_spent_usd": round(month_spent, 6),
                 "pace_usd_per_day": month_pace(month_spent)}

    # 2. one row per person: their allowance on the hive's money and the grants on owners' keys
    people = []
    for p in db.all("SELECT * FROM people WHERE disabled = 0 ORDER BY created_at"):
        scope, principal = f"person:{p['id']}", f"user:{p['id']}"
        if not scope_visible(hive, viewer, scope):
            continue
        own = stored.get((scope, "month"))
        if own is not None:
            allowance = at(own)
        else:
            figure = budgets.member_allowance(p["id"])
            visitor = p.get("access") in ("guest", "public") and hive.ownhive.settings()["visitor_month_usd"] is not None
            allowance = None if figure is None else _row(budgets, scope, "month", figure,
                                                         "visitor" if visitor else "member-default")
        spent = budgets.spent(scope, "month")
        grants = hive.ownhive._active(db.all("SELECT * FROM key_limits WHERE grantee = ? AND revoked_at IS NULL "
                                             "ORDER BY created_at", (principal,)))
        people.append({"person_id": p["id"], "principal": principal, "name": p["name"], "role": p["role"],
                       "access": p.get("access"), "allowance": allowance,
                       "source": allowance["source"] if allowance else "none",
                       "spent_usd": round(spent, 6), "pace_usd_per_day": month_pace(spent),
                       "grants": [hive.ownhive.limit_view(g) for g in grants]})

    # 3. every other stored rule: the caps someone set
    in_parts = {cap_row["rule_id"]} if cap_row else set()
    in_parts |= {r["id"] for r in rules if r["scope"].startswith("person:") and r["period"] == "month"}
    caps = [at(r) for r in rules if r["id"] not in in_parts and scope_visible(hive, viewer, r["scope"])]

    # what each mind's paid calls are checked against, for the pages that read a mind's limits
    hive_keys = [f"hive:{r['period']}" for r in rules if r["scope"] == "hive"] + ([all_time["key"]] if all_time else [])
    minds = []
    for m in db.all("SELECT * FROM agents WHERE deleted = 0 ORDER BY created_at"):
        if not scope_visible(hive, viewer, "agent:" + m["id"]):
            continue
        agent = hive.agent_view(m)
        rows = [at(r) for r in rules if r["scope"] == f"agent:{m['id']}"]
        every = budgets.every_mind_row(m, rules)
        if every is not None:
            rows.append(_row(budgets, every[0], every[1], every[2], "every-mind",
                             rule_id=stored[("every-mind", "month")]["id"]))
        budget = float(m["budget_usd"] or 0)
        if budgets.lifetime_cap_applies(m, rules, m.get("personal_of")):   # a personal mind: its person pays (allowance_pays)
            rows.insert(0, _row(budgets, f"agent:{m['id']}", "lifetime", budget, "set" if budget > 0 else "default",
                                key=f"agent:{m['id']}:total", spent=float(m["spent_usd"] or 0),
                                note=None if budget > 0 else "no paid calls until it has a cap or the hive has one"))
        research = getattr(hive, "research", None)
        month_cap = research.controller_month(m["id"]) if research is not None else None
        if month_cap is not None:   # the Research coordinator: its spawn ceiling is the month cap, not a lifetime (research.py)
            rows = [r for r in rows if r["key"] not in (f"agent:{m['id']}:total", f"agent:{m['id']}:month")]
            rows.insert(0, _row(budgets, f"agent:{m['id']}", "month", month_cap, "set", key=f"agent:{m['id']}:month",
                                note="the Research swarm's month cap: what its researchers may be given"))
        swarm_keys = [f"swarm:{m['swarm_id']}:{r['period']}" for r in rules if m["swarm_id"] and r["scope"] == f"swarm:{m['swarm_id']}"]
        headroom = budgets.headroom(agent)
        session_default = budgets.session_default(agent)
        given = 1.0 if session_default is None else session_default
        minds.append({"agent_id": m["id"], "name": m["name"], "swarm_id": m["swarm_id"], "kind": m["kind"],
                      "budget_usd": budget, "spent_usd": round(float(m["spent_usd"] or 0), 6),
                      "paid_calls": "allowed" if budget > 0 or budgets.paid_without_cap(m, rules, m.get("personal_of")) else "no_budget",
                      "limits": rows, "checked": sorted(set([r["key"] for r in rows] + hive_keys + swarm_keys)),
                      "ask_threads": hive.sessions.ask_threads(m["id"]),
                      "headroom_usd": headroom, "session_default_usd": given,
                      "lease_default_usd": dollars(to_micros(min(budgets.remaining_for(agent), given)))})
    minds.sort(key=lambda mind: mind["agent_id"] in foundation_minds or mind["swarm_id"] in foundation_swarms)

    from .ask import DEFAULT_BUDGET, MAX_BUDGET
    named = {s["name"]: s for s in budgets.server_settings(rules)}
    return {
        "hive": hive_part, "people": people, "caps": caps, "old_defaults": old_defaults(budgets, viewer, rules),
        "minds": minds,
        "rulings": [
            {"name": "ask_thread", "limit_usd": DEFAULT_BUDGET, "max_usd": MAX_BUDGET, "source": "jon-ruling"},
            {"name": "conductor_turn", "limit_usd": named["HIVE_ASK_CONDUCTOR_TURN_USD"]["value"],
             "source": "server-settings" if named["HIVE_ASK_CONDUCTOR_TURN_USD"]["set"] else "jon-ruling",
             "setting": "HIVE_ASK_CONDUCTOR_TURN_USD"},
            {"name": "member_month", "limit_usd": named["HIVE_MEMBER_MONTHLY_USD"]["value"],
             "source": "server-settings" if named["HIVE_MEMBER_MONTHLY_USD"]["set"] else "jon-ruling",
             "setting": "HIVE_MEMBER_MONTHLY_USD"},
        ],
        "server_settings": list(named.values()),
    }


PREFILLS = (5.0, 10.0)            # the per-mind numbers the old forms sent as if typed
OLD_SWARM_DEFAULT = 500.0         # the old built-in month default of every swarm, sent by the old new-swarm form
MACHINERY_NOTES = ("session cap", "restored after session")


def _money(x):
    return f"${float(x):,.2f}"


def old_defaults(budgets, viewer=None, rules=None):
    """Stored values that look like an old form's pre-filled figure, each with the one change that removes it: a mind's
    lifetime cap equal to $5, $10 or its role's default (reset: budget_usd 0, so it has no cap of its own and the hive
    cap, its payer's allowance and any every-mind rule hold it), and a swarm month rule of $500 with no note (reset:
    remove the rule). They stay until someone removes them; the Limits page removes them all in one action (the #107
    review). Read-only. Session machinery, $0 swarm rules (deliberately inert) and Foundation's explicit caps are never
    listed. Time: one read of minds, roles and swarms; r rules."""
    db = budgets.db
    rules = budgets.rules() if rules is None else rules
    foundation_swarms, foundation_minds = budgets._foundation_ids()
    has_cap = budgets.hive_cap(rules) is not None
    every = next((r for r in rules if r["scope"] == "every-mind" and r["period"] == "month"), None)
    session_rules = budgets.session_cap_rules()
    machinery = {r["id"] for r in rules if r["id"] in session_rules or r["note"] in MACHINERY_NOTES}
    ruled = {r["scope"][6:] for r in rules if r["scope"].startswith("agent:") and r["id"] not in machinery}
    roles = {r["id"]: r for r in db.all("SELECT id, name, default_budget FROM roles")} if db.one(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles'") else {}
    cols = {c["name"] for c in db.all("PRAGMA table_info(agents)")}
    out = []
    for m in db.all("SELECT * FROM agents WHERE deleted = 0 AND budget_usd > 0 ORDER BY created_at"):
        if m["id"] in foundation_minds or m["swarm_id"] in foundation_swarms:
            continue  # explicit host-purpose caps are not an old form default
        budget = float(m["budget_usd"])
        role = roles.get(m["role_id"]) if "role_id" in cols and m["role_id"] else None
        reasons = []
        if any(abs(budget - p) < 1e-9 for p in PREFILLS):
            reasons.append(f"equals a form's pre-filled {_money(budget)}")
        if role and role["default_budget"] and abs(budget - float(role["default_budget"])) < 1e-9:
            reasons.append(f"equals the {role['name']} role's default {_money(budget)}")
        if not reasons:
            continue
        if not has_cap:
            after = "no paid calls until the hive has a cap"
        elif every is not None and m["id"] not in ruled:
            after = f"the every-mind cap ({_money(every['limit_usd'])} a month), the hive cap and its payer's allowance"
        else:
            after = "the hive cap, its payer's allowance and the caps set on it"
        out.append({"kind": "mind", "agent_id": m["id"], "name": m["name"], "swarm_id": m["swarm_id"],
                    "current": {"key": f"agent:{m['id']}:total", "period": "lifetime", "limit_usd": budget},
                    "reasons": reasons, "change": f"{m['name']}: {_money(budget)} lifetime cap -> {after}",
                    "reset": {"method": "PATCH", "path": f"/api/agents/{m['id']}", "body": {"budget_usd": 0}}})
    names = {s["id"]: s["name"] for s in db.all("SELECT id, name FROM swarms")}
    for r in rules:
        if not (r["scope"].startswith("swarm:") and r["period"] == "month" and not (r["note"] or "").strip()
                and abs(float(r["limit_usd"]) - OLD_SWARM_DEFAULT) < 1e-9):
            continue
        sid = r["scope"][6:]
        if sid in foundation_swarms:
            continue  # an explicit Foundation rule is never offered for removal
        name = names.get(sid, sid)
        after = "the hive cap and each payer's allowance" if has_cap else "each payer's allowance and its minds' own caps"
        out.append({"kind": "swarm", "swarm_id": sid, "name": name, "rule_id": r["id"],
                    "current": {"key": f"{r['scope']}:month", "period": "month", "limit_usd": float(r["limit_usd"])},
                    "reasons": [f"equals the old {_money(OLD_SWARM_DEFAULT)} swarm default, with no note"],
                    "change": f"{name}: {_money(r['limit_usd'])} a month -> {after}",
                    "reset": {"method": "DELETE", "path": f"/api/budgets/{r['id']}"}})
    return [c for c in out if scope_visible(budgets.hive, viewer, ("agent:" + c["agent_id"]) if c["kind"] == "mind"
                                            else "swarm:" + c["swarm_id"])]
