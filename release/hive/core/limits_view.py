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
session's total rule share ``agent:<id>:total``, the lower one holding), its headroom, what a lease from it gets by
default and what it may hand on (a session given no budget has no cap of its own, so nothing is sized for it).
``rulings`` are the fixed figures the hive's owner decided (the member allowance). An Ask turn and an Ask thread have no
cap of their own (Jon's design on omegahive#294, item 2), so neither has a row.
``key`` on every row is the exact label a paid call's reservation is checked under.
"""

from __future__ import annotations

import json

from ..spaces.service import SpaceError
from .budgets import dollars, month_pace, to_micros
from .limit_policy import HIVE, NO_TARGET, Asker, Target


def _paid_by(budgets, mind):
    """(payer, own_key, key_id) the page asks paid_without_cap and lifetime_cap_applies with, for one mind. A mind with no
    cap of its own reads as its next paid call would settle (Budgets.settlement: the call path's own key and payer
    lookups), so one its person pays for on their own key reads as the gateway admits it, hive total or not; any other
    mind, or one with no paying key (a free, local or unpriced model, or no key), reads as its person's from the hive's
    money. Time: one settlement per mind with no cap: its key lookups, Hive.user_for and, on the hive's money, one
    rules read."""
    if float(mind["budget_usd"] or 0) <= 0:
        settled = budgets.settlement(mind, mind["model"], turn_bound=False)
        if settled.get("key_id"):
            return settled["payer"], settled["own_key"], settled["key_id"]
    return mind.get("personal_of"), False, None


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


# A cap's scope kind, and what a person calls the thing it is on.
CAPPED = {"agent": "mind", "swarm": "swarm"}

# Each refusal the limit law can give (hive/spaces/lib_limits.metta), as a route answers it: {what} is the mind or swarm
# a cap is on, or the limit's kind. test_limit_policy checks the law gives no word missing here.
REFUSALS = {
    "not-found": (404, "not_found", "no such {what}"),
    "owner-only": (403, "owner_only", "Only this {what}'s owner sets or removes a cap on it. You can ask its owner."),
    "admin-only": (403, "admin_only", "only a hive admin can do that"),
    "unknown-limit": (400, "bad_scope", "the hive has no rule for who sets a {what} limit"),
    "invalid-asker": (403, "forbidden", "the hive can't tell who is asking"),
}


def _decided(hive, viewer, kind, target):
    """The limit law's verdict for this viewer, or the hive itself for none, on a limit of ``kind`` about ``target``, as
    a route answers it: (status, code, message), or None where the law grants it. Python never grants on its own.
    Time: one PeTTa call the first time this question is asked (LimitPolicy), a dict read after."""
    asker = HIVE if viewer is None else Asker("person", viewer.principal, viewer.admin)
    verdict = hive.limit_policy.may(kind, target, asker)
    if verdict == ("Granted",):
        return None
    if verdict[1] not in REFUSALS:
        raise SpaceError(f"the limit law refused with {verdict[1]!r}, which no route answers (limits_view.REFUSALS)")
    status, code, message = REFUSALS[verdict[1]]
    return status, code, message.format(what=CAPPED.get(kind, kind))


def cap_refusal(hive, viewer, kind, row):
    """Why this viewer may not set or remove a cap on the mind (``kind`` agent) or swarm (``kind`` swarm) in ``row``,
    as (status, code, message), or None: the limit law's verdict, which holds who may (lib_limits.metta: its own person
    alone, an admin included refused 403 owner_only). Whether the viewer sees it is the hive's visibility rule
    (Viewer.sees), handed to the law as a fact, so one they don't see is 404 not_found as one that isn't there."""
    target = NO_TARGET if row is None else Target(viewer is None or viewer.sees(row), row.get("owner"),
                                                  row.get("personal_of"))
    return _decided(hive, viewer, kind, target)


def limit_refusal(hive, viewer, scope):
    """Why this viewer may not set or remove the limit on ``scope``, as (status, code, message), or None, the limit
    law deciding: a mind's or a swarm's cap is its own person's (cap_refusal), and every other limit (the hive cap, a
    person's allowance, the every-mind rule, a key's) a hive admin's. POST and DELETE /api/budgets and a changed
    budget_usd on PATCH /api/agents refuse through this, and may_change on limit rows and may_cap on mind and swarm
    views are exactly "this is None", so no flag drifts from its route. Time: one row read for a mind's or swarm's
    scope, and the law's verdict (_decided)."""
    kind, _, ident = scope.partition(":")
    if kind == "agent":
        return cap_refusal(hive, viewer, kind, hive.visibility._agent(ident))
    if kind == "swarm":
        return cap_refusal(hive, viewer, kind, hive.visibility._swarm(ident))
    return _decided(hive, viewer, kind, NO_TARGET)


def unseen_limit(row):
    """A limit this viewer may not see (scope_visible), kept in its place among a mind's limits so a page can say a
    spending limit it can't change stops the mind, with nothing about whose limit it is or its numbers."""
    return {**{k: None for k in row}, "hidden": True}


def limit_frame(hive, viewer, text):
    """A budget.refused frame as this receiver may read it: the limit that refused the call (Hive.REFUSAL_LIMIT) only for
    someone who may see that limit (scope_visible), anyone else getting the refusal alone with hidden true. Every other
    frame goes as it is."""
    if not text.startswith('{"type": "budget.refused"'):
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

    def at(rule):   # may_change: whether this viewer may change or remove it (limit_refusal)
        return _row(budgets, rule["scope"], rule["period"], rule["limit_usd"],
                    "session" if rule["id"] in session_rules else "set", rule_id=rule["id"], note=rule["note"] or None,
                    may_change=limit_refusal(hive, viewer, rule["scope"]) is None)

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
        payer, own_key, key_id = _paid_by(budgets, m)
        if budgets.lifetime_cap_applies(m, rules, payer, own_key, key_id):   # a personal mind: its person pays (allowance_pays)
            rows.insert(0, _row(budgets, f"agent:{m['id']}", "lifetime", budget, "set" if budget > 0 else "default",
                                key=f"agent:{m['id']}:total", spent=float(m["spent_usd"] or 0),
                                note=None if budget > 0 else
                            "no paid calls on the hive's money until it has a cap or the hive has one"))
        swarm_keys = [f"swarm:{m['swarm_id']}:{r['period']}" for r in rules if m["swarm_id"] and r["scope"] == f"swarm:{m['swarm_id']}"]
        headroom = budgets.headroom(agent)
        minds.append({"agent_id": m["id"], "name": m["name"], "swarm_id": m["swarm_id"], "kind": m["kind"],
                      "budget_usd": budget, "spent_usd": round(float(m["spent_usd"] or 0), 6),
                      "paid_calls": "allowed" if budget > 0 or budgets.paid_without_cap(m, rules, payer, own_key, key_id) else "no_budget",
                      "limits": rows, "checked": sorted(set([r["key"] for r in rows] + hive_keys + swarm_keys)),
                      "headroom_usd": headroom, "lease_default_usd": dollars(to_micros(budgets.remaining_for(agent)))})
    minds.sort(key=lambda mind: mind["agent_id"] in foundation_minds or mind["swarm_id"] in foundation_swarms)

    named = {s["name"]: s for s in budgets.server_settings(rules)}
    return {
        "hive": hive_part, "people": people, "caps": caps, "old_defaults": old_defaults(budgets, viewer, rules),
        "minds": minds,
        "rulings": [
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
    review). Read-only. Session machinery and $0 swarm rules (deliberately inert) are never listed. A Foundation mind's
    or team's figure is listed like anyone's, since Foundation minds keep no caps of their own (Jon on #256, 23 Nov).
    Time: one read of minds, roles and swarms; r rules."""
    db = budgets.db
    rules = budgets.rules() if rules is None else rules
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
                    "reset": {"method": "PATCH", "path": f"/api/agents/{m['id']}", "body": {"budget_usd": 0}},
                    "may_change": cap_refusal(budgets.hive, viewer, "agent", m) is None})
    names = {s["id"]: s["name"] for s in db.all("SELECT id, name FROM swarms")}
    for r in rules:
        if not (r["scope"].startswith("swarm:") and r["period"] == "month" and not (r["note"] or "").strip()
                and abs(float(r["limit_usd"]) - OLD_SWARM_DEFAULT) < 1e-9):
            continue
        sid = r["scope"][6:]
        name = names.get(sid, sid)
        after = "the hive cap and each payer's allowance" if has_cap else "each payer's allowance and its minds' own caps"
        out.append({"kind": "swarm", "swarm_id": sid, "name": name, "rule_id": r["id"],
                    "current": {"key": f"{r['scope']}:month", "period": "month", "limit_usd": float(r["limit_usd"])},
                    "reasons": [f"equals the old {_money(OLD_SWARM_DEFAULT)} swarm default, with no note"],
                    "change": f"{name}: {_money(r['limit_usd'])} a month -> {after}",
                    "reset": {"method": "DELETE", "path": f"/api/budgets/{r['id']}"},
                    "may_change": limit_refusal(budgets.hive, viewer, r["scope"]) is None})
    return [c for c in out if scope_visible(budgets.hive, viewer, ("agent:" + c["agent_id"]) if c["kind"] == "mind"
                                            else "swarm:" + c["swarm_id"])]
