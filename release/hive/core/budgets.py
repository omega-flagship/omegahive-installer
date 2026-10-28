"""Spending limits at every level: the hive, a swarm, a mind, a key (and, with sign-in, a person).

A rule is ``(scope, period, limit_usd)``:
- scope: ``hive`` | ``swarm:<id>`` | ``agent:<id>`` | ``person:<id>`` | ``key:<id>`` | ``every-mind`` (month only)
- period: ``day`` | ``month`` (calendar, UTC) | ``total``

Every paid model call is checked against every rule that applies to it, before it is made, with
the call's worst-case cost.  The first rule it would break refuses it (402 ``spend_limit``).

Automatic limits (limits_auto.py): once the hive has a total (its hive-scope month rule, or day rule x 30), every team,
team day, hive day and un-limited mind with no stored rule of its own gets a limit derived from that total, worked out
here on every check (origin ``auto``), so admission and reservations enforce it with no other code.  A stored rule always
wins at its own (scope, period).  The ``every-mind`` rule is not a spending rule: it is the auto month of each mind with
no limit of its own.  With no hive total, each team without a month rule has the fallback monthly limit
(HIVE_SWARM_MONTHLY_USD, 500) as before (origin ``default``).
A mind's own ``budget_usd`` cap and HIVE_BUDGET_USD still apply as before.

Own hive H1 (ownhive.py): a call on a key is also held to the key owner's own limits on it (``keyuse:<scope>``, month): the
owner's own-use limit when the call is theirs (or a pre-H1 person's with no grant: billed to the owner, as before), else
their grant to the person it is for, which replaces the member
default for that person. Budgets.check first refuses a call on a key its payer may not use (OwnHive.use_check). Key
limits are set on their own routes (/api/me/key-limits), never through Budgets.set.
"""

from __future__ import annotations

import datetime
import os
import re

from . import limits_auto
from .db import new_id, now

PERIODS = ("day", "month", "total")
SCOPE = re.compile(r"^(hive|every-mind|swarm:s_[0-9a-f]{8}|agent:a_[0-9a-f]{8}|person:u_[0-9a-f]{8}|key:(k_[0-9a-f]{8}|env:[a-z0-9_-]+))$")


def period_start(period, moment=None):
    moment = moment or datetime.datetime.now(datetime.timezone.utc)
    if period == "day":
        start = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        start = moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        return None
    return start.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Budgets:
    def __init__(self, hive):
        self.hive = hive

    @property
    def db(self):
        return self.hive.db

    def rules(self):
        return self.db.all("SELECT * FROM budgets ORDER BY created_at")

    def set(self, scope, period, limit_usd, note=""):
        if not SCOPE.match(scope):
            raise self.hive.error(400, "bad_scope", "scope is hive, every-mind, swarm:<id>, agent:<id>, person:<id> or key:<id>")
        if period not in PERIODS:
            raise self.hive.error(400, "bad_period", f"period is one of {list(PERIODS)}")
        if scope == "every-mind" and period != "month":
            raise self.hive.error(400, "bad_period", "the every-mind limit is a month limit")
        try:
            limit = float(limit_usd)
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_limit", "limit_usd must be a number") from None
        if not (limit >= 0) or limit > 1_000_000:
            raise self.hive.error(400, "bad_limit", "limit_usd must be between 0 and 1,000,000")
        kind, _, ident = scope.partition(":")
        if kind == "swarm":
            self.hive.swarm(ident)
        elif kind == "agent":
            self.hive.agent(ident)
        existing = self.db.one("SELECT id FROM budgets WHERE scope = ? AND period = ?", (scope, period))
        if existing:
            self.db.execute("UPDATE budgets SET limit_usd = ?, note = ? WHERE id = ?", (limit, str(note)[:200], existing["id"]))
            return self.db.one("SELECT * FROM budgets WHERE id = ?", (existing["id"],))
        row = {"id": new_id("b"), "scope": scope, "period": period, "limit_usd": limit, "note": str(note)[:200], "created_at": now()}
        self.db.insert("budgets", row)
        return row

    def remove(self, rule_id):
        if not self.db.one("SELECT 1 FROM budgets WHERE id = ?", (rule_id,)):
            raise self.hive.error(404, "not_found", f"no budget rule {rule_id}")
        self.db.execute("DELETE FROM budgets WHERE id = ?", (rule_id,))
        return {"ok": True}

    def spent(self, scope, period):
        kind, _, ident = scope.partition(":")
        if kind == "keyuse":
            return self.hive.ownhive.spent(scope)   # a key-limit scope is a month limit (ownhive.py)
        if kind == "every-mind":
            return 0.0   # a default for each mind, not a pool: nothing is spent against it
        column = {"hive": None, "swarm": "swarm_id", "agent": "agent_id", "key": "key_id", "person": "payer"}[kind]
        if kind == "person":
            ident = f"user:{ident}"
        sql, params = "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE 1=1", []
        if column:
            sql += f" AND {column} = ?"
            params.append(ident)
        start = period_start(period)
        if start:
            sql += " AND created_at >= ?"
            params.append(start)
        return float(self.db.one(sql, params)["s"])

    def member_allowance(self, person_id):
        """A member's monthly allowance when no rule is set (the owner: $50 per family member); admins have none."""
        row = self.db.one("SELECT * FROM people WHERE id = ? AND disabled = 0", (person_id,))
        if row is None or row["role"] == "admin":
            return None
        if row.get("access") == "guest":
            return None   # own hive H1: a guest's limit is the host's grant (their invite limit), never a member default
        if row.get("access") == "public":   # a public visitor: the hive's visitor limit, when the owner set one
            visitor = self.hive.ownhive.settings()["visitor_month_usd"]
            if visitor is not None:
                return float(visitor)
        try:
            return float(os.environ.get("HIVE_MEMBER_MONTHLY_USD", "50"))
        except ValueError:
            return 50.0

    # ---- automatic limits (limits_auto.py) ----------------------------------------------------------------------------

    def session_cap_rules(self):
        """{rule id: base limit} for each mind total rule a work session installed (sessions.py session_caps): machinery,
        not a limit a person set. A base of None means the mind had no total rule of its own before the session."""
        rows = self.db.all("SELECT b.id, c.base_limit, c.installed, b.limit_usd FROM budgets b JOIN session_caps c "
                           "ON b.scope = 'agent:' || c.agent_id AND b.period = 'total' WHERE c.installed IS NOT NULL")
        return {r["id"]: r["base_limit"] for r in rows if abs(float(r["limit_usd"]) - float(r["installed"])) < 1e-9}

    def derive(self, rules=None):
        """The automatic limits for the hive as it is now (limits_auto.derive over the stored rules and the counts)."""
        rules = self.rules() if rules is None else rules
        machinery = {rid for rid, base in self.session_cap_rules().items() if base is None}
        explicit = {r["scope"][6:] for r in rules if r["scope"].startswith("agent:") and r["id"] not in machinery}
        swarms = [{"id": r["id"], "archived": bool(r["archived_at"]), "minds": r["minds"]} for r in self.db.all(
            "SELECT s.id, s.archived_at, (SELECT COUNT(*) FROM agents a WHERE a.swarm_id = s.id AND a.deleted = 0) AS minds "
            "FROM swarms s ORDER BY s.created_at")]
        minds = [{"id": r["id"], "swarm_id": r["swarm_id"], "budget_usd": r["budget_usd"], "explicit": r["id"] in explicit}
                 for r in self.db.all("SELECT id, swarm_id, budget_usd FROM agents WHERE deleted = 0")]
        return limits_auto.derive(rules, swarms, minds)

    def panel_total(self, rules=None):
        """The hive total a person set on the Limits page, or None: the one source every automatic limit comes from."""
        return limits_auto.hive_total(self.rules() if rules is None else rules)

    # ---- server settings only seed a hive with no total (the owner 2026-10-07) ----------------------------------------------

    def hard_cap(self, rules=None):
        """HIVE_BUDGET_USD, the all-time cap from the server's settings, while the hive has no total on the Limits page;
        0 (none) once it has one. The owner 2026-10-07: "surely they should match the number I set in the admin panel": a
        server setting never overrides the panel, it only seeds a hive that has no panel total."""
        return 0.0 if self.panel_total(rules) is not None else float(self.hive.settings.hive_budget_usd or 0)

    def hard_total_spent(self):
        return float(self.db.one("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage")["total"])

    def server_settings(self, rules=None):
        """Every spending setting from the server's environment, what it is, and whether it applies right now. ``set``:
        the process found it in its environment (the Limits page shows it as "from server settings"); ``applies``: it
        changes a limit now. The three seeds apply only while the hive has no total; the other two have no panel
        setting above them (a person's own month rule still replaces the member allowance)."""
        from .conductor import turn_cap_usd
        s, env = self.hive.settings, self.hive.settings.budget_env or {}
        seeded = self.panel_total(rules) is None
        out = []
        def item(name, value, applies, effect):
            out.append({"name": name, "value": value, "set": name in env, "applies": bool(applies), "effect": effect})
        item("HIVE_BUDGET_USD", float(s.hive_budget_usd or 0), seeded and s.hive_budget_usd,
             "an all-time cap on the whole hive" if seeded else "not used: the hive total on the Limits page replaces it")
        item("HIVE_SWARM_MONTHLY_USD", float(s.swarm_monthly_usd or 0), seeded and s.swarm_monthly_usd,
             "the month limit of each swarm without one" if seeded else "not used: swarm limits come from the hive total")
        item("HIVE_PERSON_REQUEST_CEILING_USD", float(s.person_request_ceiling_usd or 0), seeded,
             "the most one person's instruction may carry" if seeded
             else "not used: an instruction carries at most the receiving swarm's day limit")
        try:
            member = float(os.environ.get("HIVE_MEMBER_MONTHLY_USD", "50"))
        except ValueError:
            member = 50.0
        item("HIVE_MEMBER_MONTHLY_USD", member, True, "the month allowance of each member with no limit of their own")
        item("HIVE_ASK_CONDUCTOR_TURN_USD", turn_cap_usd(), True, "the most one Ask conductor turn may spend")
        return out

    def paid_without_cap(self, agent, rules=None, payer=None, own_key=False):
        """True when a paid call by a mind with no cap of its own (budget_usd 0) is let through to the limits above it.
        THE PLAN'S ONE LOOSENING (review-blocking, PLATFORM_AUTO_BUDGET_LIMITS_PLAN §2.3): only once the hive has a
        total. Without one, budget 0 still means no paid calls (402 no_budget), as before, except for a personal mind
        paid by its own person from their month allowance (allowance_pays)."""
        if float(agent.get("budget_usd") or 0) > 0:
            return False
        return self.panel_total(rules) is not None or self.allowance_pays(agent, payer, own_key, rules)

    def lifetime_cap_applies(self, agent, rules=None, payer=None, own_key=False):
        """Whether the mind's own budget_usd is one of its reservation rows: always when it is above 0; at 0 only while
        the hive has no total (where it refuses, as no_budget does) and the call is not one allowance_pays admits."""
        if float(agent.get("budget_usd") or 0) > 0:
            return True
        return self.panel_total(rules) is None and not self.allowance_pays(agent, payer, own_key, rules)

    def allowance_pays(self, agent, payer=None, own_key=False, rules=None):
        """Personal minds P2: a person's personal mind (budget_usd 0, personal.py) making a call paid by that same person
        from the hive's money is held to that person's month allowance, the limit Budgets.applicable already adds for
        them (their person:<id> month rule, else the member default), instead of a cap of its own. No new limit: True
        only when that allowance exists, so the call is always bounded by it (and by every other rule that applies:
        the thread's cap, the swarm, the hive, the turn's cap). Never for another payer, a person's own key, or an
        admin with no month rule (who has no allowance: the rules above apply unchanged)."""
        person = agent.get("personal_of")
        if not person or payer != person or own_key or not str(person).startswith("user:u_"):
            return False
        if float(agent.get("budget_usd") or 0) > 0:
            return False
        pid = person[5:]
        rules = self.rules() if rules is None else rules
        if any(r["scope"] == "person:" + pid and r["period"] == "month" for r in rules):
            return True
        if self.hive.ownhive.has_grant(person):
            return True   # own hive H1: a key owner's grant to this person bounds the call (Budgets.applicable)
        return self.member_allowance(pid) is not None

    # ---- derived defaults (plan H5) ------------------------------------------------------------------------------------

    def headroom_micros(self, agent):
        """What the mind can still spend under every limit on it now (its own cap, rules, auto limits, the hard total),
        in integer micro-dollars (limits floored, spend ceilinged, as reservations count); None when nothing limits it.
        Spend held by open reservations is not subtracted: this sizes defaults, it admits nothing."""
        m = limits_auto.to_micros
        heads = [m(limit) - m(self.spent(scope, period), up=True) for scope, period, limit, _ in self.applicable(agent)]
        if self.lifetime_cap_applies(agent):
            heads.append(m(agent.get("budget_usd")) - m(self._stored_spent(agent), up=True))
        cap = self.hard_cap()
        if cap:
            heads.append(m(cap) - m(self.hard_total_spent(), up=True))
        return max(0, min(heads)) if heads else None

    def headroom(self, agent):
        micros = self.headroom_micros(agent)
        return None if micros is None else limits_auto.dollars(micros)

    def _stored_spent(self, agent):
        """The mind's stored spend: an agent view rounds it to 6 places, which can round it down (OmegaReview r6)."""
        row = self.db.one("SELECT spent_usd FROM agents WHERE id = ?", (agent["id"],))
        return float((row or agent).get("spent_usd") or 0)

    def remaining_for(self, agent):
        """What a mind may hand on (a person's instruction to a controller, a lifecycle lease): what its own cap leaves
        when it has one, as before; with none, what its auto limits leave once the hive has a total; else nothing."""
        if float(agent.get("budget_usd") or 0) > 0:
            m = limits_auto.to_micros
            return limits_auto.dollars(max(0, m(agent["budget_usd"]) - m(self._stored_spent(agent), up=True)))
        if self.paid_without_cap(agent):
            return self.headroom(agent) or 0.0
        return 0.0

    def session_default(self, agent):
        """The budget of a session or task given none: a tenth of the mind's headroom, $0.25 to $100, never above it,
        once the hive has a total; None without one (the caller keeps its fixed default)."""
        if self.panel_total() is None:
            return None
        return limits_auto.dollars(limits_auto.session_default_micros(self.headroom_micros(agent) or 0))

    def request_ceiling(self, swarm_id):
        """(ceiling, source) for one person's instruction to a team: the receiving team's day limit (its own rule, or
        its auto day) once the hive has a total; else HIVE_PERSON_REQUEST_CEILING_USD (a seed, the owner 2026-10-07)."""
        rules = self.rules()
        if self.panel_total(rules) is None:
            env = "HIVE_PERSON_REQUEST_CEILING_USD" in (self.hive.settings.budget_env or {})
            return float(self.hive.settings.person_request_ceiling_usd or 0), "server-settings" if env else "default"
        own = next((r for r in rules if r["scope"] == f"swarm:{swarm_id}" and r["period"] == "day"), None)
        if own is not None:
            return float(own["limit_usd"]), "set"
        auto = self.derive(rules)["limits"].get((f"swarm:{swarm_id}", "day"))
        return (float(auto["limit_usd"]), "auto") if auto else (0.0, "auto")

    def applicable(self, agent, key_id=None, payer=None, own_key=False):
        """Every (scope, period, limit, origin) that applies to a call by this mind. A person paying from the
        hive's money is held to their allowance; spend on their own key is theirs and is not."""
        scopes = ["hive", f"agent:{agent['id']}"]
        person_scope = None
        if payer and payer.startswith("user:u_") and not own_key:
            person_scope = "person:" + payer[5:]
            scopes.append(person_scope)
        if agent.get("swarm_id"):
            scopes.append(f"swarm:{agent['swarm_id']}")
        if key_id:
            scopes.append(f"key:{key_id}")
        rules = self.rules()
        found = [(r["scope"], r["period"], r["limit_usd"], r["id"]) for r in rules if r["scope"] in scopes]
        swarm_scope = f"swarm:{agent['swarm_id']}" if agent.get("swarm_id") else None
        derived = self.derive(rules)
        if derived["total"] is not None:
            for key in (("hive", "month"), ("hive", "day"), (swarm_scope, "month"), (swarm_scope, "day"), (f"agent:{agent['id']}", "month")):
                auto = derived["limits"].get(key)
                if auto is not None and key[0]:
                    found.append((key[0], key[1], auto["limit_usd"], "auto"))
        else:
            default = self.hive.settings.swarm_monthly_usd
            if swarm_scope and default and not any(s == swarm_scope and p == "month" for s, p, _, _ in found):
                found.append((swarm_scope, "month", default, "default"))
        own = self.hive.ownhive
        keyed = own.rules(key_id, payer)   # own hive H1: the key owner's own limit, or their grant to this payer
        found.extend(keyed)
        granted = any(origin in ("grant", "invite") for _, _, _, origin in keyed)
        if person_scope and not granted and not any(s == person_scope and p == "month" for s, p, _, _ in found):
            allowance = self.member_allowance(person_scope[7:])   # the compatibility fallback: no grant holds them
            if allowance is not None:
                found.append((person_scope, "month", allowance, "member-default"))
        return found

    def check(self, agent, estimate, key_id=None, payer=None, own_key=False):
        self.hive.ownhive.use_check(agent, key_id, payer)   # own hive H1: may this payer use this key at all?
        for scope, period, limit, origin in self.applicable(agent, key_id, payer, own_key):
            spent = self.spent(scope, period)
            if spent + estimate > limit:
                label = {"day": "today", "month": "this month", "total": "in total"}[period]
                raise self.hive.error(402, "spend_limit",
                                      f"{scope} has spent ${spent:.2f} of its ${limit:.2f} limit {label}; this call could cost "
                                      f"up to ${estimate:.4f}", {"scope": scope, "period": period, "limit_usd": limit,
                                                                  "spent_usd": round(spent, 6), "rule": origin})

    def overview(self):
        """Rules with their current spend, plus every automatic limit (origin ``auto``, with its ``basis``); with no hive
        total, the fallback monthly limit of each swarm without a rule instead (origin ``default``)."""
        out = []
        rules = self.rules()
        for r in rules:
            out.append(dict(r, spent_usd=round(self.spent(r["scope"], r["period"]), 6), origin="rule"))
        derived = self.derive(rules)
        if derived["total"] is not None:
            for (scope, period), auto in derived["limits"].items():
                out.append({"id": f"auto:{scope}:{period}", "scope": scope, "period": period, "limit_usd": auto["limit_usd"],
                            "note": "auto from the hive total", "basis": auto["basis"], "created_at": None,
                            "spent_usd": round(self.spent(scope, period), 6), "origin": "auto"})
            return out
        default = self.hive.settings.swarm_monthly_usd
        if default:
            ruled = {r["scope"] for r in rules if r["period"] == "month"}
            for swarm in self.hive.swarms():
                scope = f"swarm:{swarm['id']}"
                if scope not in ruled:
                    out.append({"id": f"default:{scope}", "scope": scope, "period": "month", "limit_usd": default,
                                "note": "default for every swarm", "created_at": None,
                                "spent_usd": round(self.spent(scope, "month"), 6), "origin": "default"})
        return out
