"""The Limits page's read model (GET /api/budgets/limits): every limit in force, where it comes from, and what each mind
is checked against, from the same Budgets calls admission and reservations use, so what the page shows is what is
enforced (Jon 2026-10-07: "surely they should match the number I set in the admin panel").

``source`` on every row:
- ``set``: a stored rule (or a mind's own budget_usd): someone chose it on the panel or a form. "Reset to auto" deletes
  the rule (DELETE /api/budgets/{rule_id}) or sets budget_usd to 0 (PATCH /api/agents/{id}).
- ``auto``: derived from the hive total on this read (``basis`` says how); never stored.
- ``session``: a mind total rule a work session installed for its duration (machinery: not reset from the page).
- ``server-settings``: a value from the server's environment in force because the hive has no total yet (``setting``
  names it).
- ``default``: the built-in value in force because the hive has no total and the environment does not set one.
- ``minds[].ask_threads`` (ask-limits r1): each active Ask thread on the mind held by its own cap (key askthread:<id>):
  its budget and its own spend, never folded into the mind's rows.
- ``jon-ruling``: a fixed figure Jon decided (the Ask thread, the conductor turn, the member allowance).

``key`` on every row is the exact label a paid call's reservation is checked under; ``minds[].checked`` lists the keys
for one mind's paid calls, so ``{key: lowest limit_usd}`` over those rows equals the reservation snapshot (a mind's own
budget_usd and a session's total rule share the key ``agent:<id>:total``; the lower one holds).
"""

from __future__ import annotations


def _floor(x):
    from .limits_auto import dollars, to_micros
    return dollars(to_micros(x))


def _row(budgets, scope, period, limit, source, key=None, **extra):
    spent = budgets.spent(scope, period) if period in ("day", "month", "total") else None
    out = {"key": key or f"{scope}:{period}", "scope": scope, "period": period, "limit_usd": round(float(limit), 6),
           "spent_usd": None if spent is None else round(spent, 6), "source": source}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


def scope_visible(hive, viewer, scope):
    """Whether this viewer may see a row about this scope (defence in depth: both routes are admin-only, and an admin
    sees everything). A key's row, and another person's, is admin business; a team's or mind's follows its visibility."""
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
    return kind in ("hive", "every-mind")


def limits(budgets, viewer=None):
    hive, db = budgets.hive, budgets.db
    settings = hive.settings
    env = settings.budget_env or {}
    rules = budgets.rules()
    derived = budgets.derive(rules)
    foundation_swarms, foundation_minds = budgets._foundation_ids()
    auto_swarms, _ = budgets._auto_subjects()
    auto_counts = {s["id"]: s["minds"] for s in auto_swarms}
    total = derived["total"]
    stored = {(r["scope"], r["period"]): r for r in rules}
    session_rules = budgets.session_cap_rules()

    def at(scope, period):
        r = stored.get((scope, period))
        if r is not None:
            return _row(budgets, scope, period, r["limit_usd"], "session" if r["id"] in session_rules else "set",
                        rule_id=r["id"], note=r["note"] or None)
        auto = derived["limits"].get((scope, period))
        if auto is not None:
            return _row(budgets, scope, period, auto["limit_usd"], "auto", basis=auto["basis"])
        return None

    hive_rows = [x for x in (at("hive", p) for p in ("month", "day", "total")) if x]
    cap = budgets.hard_cap(rules)
    if cap:
        hive_rows.append(_row(budgets, "hive", "all-time", cap, "server-settings" if "HIVE_BUDGET_USD" in env else "default",
                              key="hive:hard-total", setting="HIVE_BUDGET_USD"))
        hive_rows[-1]["spent_usd"] = round(budgets.hard_total_spent(), 6)

    fallback = None
    if total is None and settings.swarm_monthly_usd:
        fallback = ("server-settings" if "HIVE_SWARM_MONTHLY_USD" in env else "default", float(settings.swarm_monthly_usd))

    teams, team_rows = [], {}
    for s in db.all("SELECT s.id, s.name, s.archived_at, (SELECT COUNT(*) FROM agents a WHERE a.swarm_id = s.id AND "
                    "a.deleted = 0) AS minds FROM swarms s ORDER BY s.created_at"):
        scope = f"swarm:{s['id']}"
        month, day, lifetime = at(scope, "month"), at(scope, "day"), at(scope, "total")
        if month is None and fallback and s["id"] not in foundation_swarms:
            month = _row(budgets, scope, "month", fallback[1], fallback[0], setting="HIVE_SWARM_MONTHLY_USD")
        ceiling, ceiling_source = budgets.request_ceiling(s["id"])
        team_rows[s["id"]] = [x for x in (month, day, lifetime) if x]
        teams.append({"swarm_id": s["id"], "name": s["name"], "archived": bool(s["archived_at"]), "minds": s["minds"],
                      "active": not s["archived_at"] and auto_counts.get(s["id"], 0) > 0 and (scope, "month") not in stored,
                      "month": month, "day": day, "total": lifetime,
                      "request_ceiling": {"limit_usd": _floor(ceiling), "source": ceiling_source}})

    teams = [t for t in teams if scope_visible(hive, viewer, "swarm:" + t["swarm_id"])]
    # Retain every visible host-purpose row and its actual rules/spend. The
    # existing ordinary sequence remains first, rather than being displaced
    # by Foundation records provisioned before a person's first swarm.
    teams.sort(key=lambda team: team["swarm_id"] in foundation_swarms)
    hive_keys = {r["key"]: r for r in hive_rows}
    minds = []
    for m in db.all("SELECT * FROM agents WHERE deleted = 0 ORDER BY created_at"):
        if not scope_visible(hive, viewer, "agent:" + m["id"]):
            continue
        agent = hive.agent_view(m)
        own = [r for r in rules if r["scope"] == f"agent:{m['id']}"]
        rows = [at(r["scope"], r["period"]) for r in own]
        auto_month = None if (f"agent:{m['id']}", "month") in stored else at(f"agent:{m['id']}", "month")
        if auto_month:
            rows.append(auto_month)
        budget = float(m["budget_usd"] or 0)
        if budgets.lifetime_cap_applies(m, rules, m.get("personal_of")):   # a personal mind: its person pays (allowance_pays)
            lifetime = _row(budgets, f"agent:{m['id']}", "lifetime", budget, "set" if budget > 0 else "default",
                            key=f"agent:{m['id']}:total",
                            note=None if budget > 0 else "no paid calls until it has a limit or the hive has a total")
            lifetime["spent_usd"] = round(float(m["spent_usd"] or 0), 6)
            rows.insert(0, lifetime)
        checked = [r["key"] for r in rows] + list(hive_keys)
        member_rows = team_rows.get(m["swarm_id"], [])
        if m["id"] in foundation_minds or m["swarm_id"] in foundation_swarms:
            # An exact bound actor moved to another swarm still keeps stored
            # rules, but does not acquire that swarm's automatic/default share.
            member_rows = [r for r in member_rows if r["source"] in ("set", "session")]
        checked += [r["key"] for r in member_rows]
        headroom = budgets.headroom(agent)
        session_default = budgets.session_default(agent)
        minds.append({"agent_id": m["id"], "name": m["name"], "swarm_id": m["swarm_id"], "kind": m["kind"],
                      "budget_usd": budget, "spent_usd": round(float(m["spent_usd"] or 0), 6),
                      "auto": auto_month is not None,
                      "paid_calls": "allowed" if budget > 0 or budgets.paid_without_cap(m, rules, m.get("personal_of")) else "no_budget",
                      "limits": rows, "checked": sorted(set(checked)),
                      # ask-limits r1: Ask threads held by their own cap, reported apart from the mind's own limits (which
                      # they never change): each thread's calls are checked under its key as well
                      "ask_threads": hive.sessions.ask_threads(m["id"]),
                      "headroom_usd": headroom,
                      "session_default_usd": 1.0 if session_default is None else session_default,
                      "lease_default_usd": _floor(min(budgets.remaining_for(agent),
                                                      1.0 if session_default is None else session_default))})
    minds.sort(key=lambda mind: mind["agent_id"] in foundation_minds or mind["swarm_id"] in foundation_swarms)

    every = stored.get(("every-mind", "month"))
    others = [_row(budgets, r["scope"], r["period"], r["limit_usd"], "set", rule_id=r["id"], note=r["note"] or None)
              for r in rules if r["scope"].startswith(("person:", "key:")) and scope_visible(hive, viewer, r["scope"])]
    from .ask import DEFAULT_BUDGET, MAX_BUDGET
    named = {s["name"]: s for s in budgets.server_settings(rules)}
    return {
        "auto": total is not None,
        "total": None if total is None else {
            "key": f"hive:{total['period']}", "limit_usd": round(total["limit_usd"], 6), "period": total["period"],
            "monthly_usd": round(total["limit_usd"], 6), "rule_id": total["rule_id"], "source": "set", "basis": total["basis"],
            "spent_usd": round(budgets.spent("hive", total["period"]), 6)},
        "every_mind": None if every is None else {"limit_usd": float(every["limit_usd"]), "rule_id": every["id"],
                                                  "source": "set", "applies": total is not None},
        "active_teams": derived["active_teams"], "pool_usd": derived["pool_usd"],
        "hive": hive_rows, "teams": teams, "minds": minds, "others": others,
        "request_ceiling": {"source": "auto" if total is not None else
                            ("server-settings" if named["HIVE_PERSON_REQUEST_CEILING_USD"]["set"] else "default"),
                            "limit_usd": None if total is not None else float(settings.person_request_ceiling_usd or 0),
                            "basis": "each receiving swarm's day limit" if total is not None else "one figure for every swarm"},
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


PREFILLS = (5.0, 10.0)            # the per-mind numbers the forms used to send as if typed (plan §2.6)
OLD_TEAM_DEFAULT = 500.0          # HIVE_SWARM_MONTHLY_USD's old built-in value, sent by the new-team form
MACHINERY_NOTES = ("session cap", "restored after session")


def _money(x):
    return f"${float(x):,.2f}"


def auto_candidates(budgets, viewer=None):
    """Stored values that look like an old form default, each beside the automatic value it would take if reset
    (GET /api/budgets/auto-candidates). Read-only: it writes nothing. Session machinery and $0 team rules (deliberately
    inert registrations) are never listed. Nothing here is reset without a person confirming each change."""
    db = budgets.db
    rules = budgets.rules()
    derived = budgets.derive(rules)
    foundation_swarms, foundation_minds = budgets._foundation_ids()
    has_total = derived["total"] is not None
    session_rules = budgets.session_cap_rules()
    machinery = {r["id"] for r in rules if r["id"] in session_rules or r["note"] in MACHINERY_NOTES}
    own_rules = {}
    for r in rules:
        if r["scope"].startswith("agent:") and r["id"] not in machinery:
            own_rules.setdefault(r["scope"][6:], []).append(r)
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
        auto = None
        if has_total and m["id"] not in own_rules:
            swarms, participants = budgets._auto_subjects()
            minds = [dict(a, budget_usd=0 if a["id"] == m["id"] else a["budget_usd"],
                          explicit=a["id"] in own_rules) for a in participants]
            from . import limits_auto
            value = limits_auto.derive(rules, swarms, minds)["limits"].get((f"agent:{m['id']}", "month"))
            auto = value["limit_usd"] if value else None
        after = (f"Auto ({_money(auto)} a month)" if auto is not None else
                 "no automatic limit until the hive has a total (paid calls stop)" if not has_total else
                 "its own other limits only")
        out.append({"kind": "mind", "agent_id": m["id"], "name": m["name"], "swarm_id": m["swarm_id"],
                    "current": {"key": f"agent:{m['id']}:total", "period": "lifetime", "limit_usd": budget},
                    "reasons": reasons, "auto_usd": auto,
                    "change": f"{m['name']}: {_money(budget)} lifetime cap -> {after}",
                    "reset": {"method": "PATCH", "path": f"/api/agents/{m['id']}", "body": {"budget_usd": 0}}})
    names = {s["id"]: s["name"] for s in db.all("SELECT id, name FROM swarms")}
    for r in rules:
        if not (r["scope"].startswith("swarm:") and r["period"] == "month" and not (r["note"] or "").strip()
                and abs(float(r["limit_usd"]) - OLD_TEAM_DEFAULT) < 1e-9):
            continue
        sid = r["scope"][6:]
        if sid in foundation_swarms:
            continue  # never offer to turn an explicit Foundation rule into auto
        auto = None
        if has_total:
            value = budgets.derive([x for x in rules if x["id"] != r["id"]])["limits"].get((r["scope"], "month"))
            auto = value["limit_usd"] if value else None
        name = names.get(sid, sid)
        after = f"Auto ({_money(auto)} a month)" if auto is not None else \
            f"the server's fallback ({_money(budgets.hive.settings.swarm_monthly_usd or 0)} a month) until the hive has a total"
        out.append({"kind": "team", "swarm_id": sid, "name": name, "rule_id": r["id"],
                    "current": {"key": f"{r['scope']}:month", "period": "month", "limit_usd": float(r["limit_usd"])},
                    "reasons": [f"equals the old {_money(OLD_TEAM_DEFAULT)} swarm default, with no note"], "auto_usd": auto,
                    "change": f"{name}: {_money(r['limit_usd'])} a month -> {after}",
                    "reset": {"method": "DELETE", "path": f"/api/budgets/{r['id']}"}})
    out = [c for c in out if scope_visible(budgets.hive, viewer, ("agent:" + c["agent_id"]) if c["kind"] == "mind"
                                           else "swarm:" + c["swarm_id"])]
    return {"auto": has_total, "candidates": out}
