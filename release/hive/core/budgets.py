"""Spending limits at every level: the hive, a swarm, a mind, a key (and, with sign-in, a person).

A rule is ``(scope, period, limit_usd)``:
- scope: ``hive`` | ``swarm:<id>`` | ``agent:<id>`` | ``person:<id>`` | ``key:<id>`` | ``every-mind`` (month only)
- period: ``day`` | ``month`` (calendar, UTC) | ``total``

Every paid model call is checked against every rule that applies to it, before it is made, with
the call's worst-case cost.  The first rule it would break refuses it (402 ``spend_limit``).

Automatic limits (limits_auto.py): once the hive has a total (its hive-scope month rule, or day rule x 30), every ordinary team,
team day, hive day and un-limited mind with no stored rule of its own gets a limit derived from that total, worked out
here on every check (origin ``auto``), so admission and reservations enforce it with no other code.  A stored rule always
wins at its own (scope, period).  The ``every-mind`` rule is not a spending rule: it is the auto month of each mind with
no limit of its own.  With no hive total, each team without a month rule has the fallback monthly limit
(HIVE_SWARM_MONTHLY_USD, 500) as before (origin ``default``).
A mind's own ``budget_usd`` cap and HIVE_BUDGET_USD still apply as before.
The two existing Foundation-purpose bindings and their actors do not participate in automatic shares/defaults;
their explicit caps, stored rules, global spend and reservations remain in force.

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
SCOPE = re.compile(r"^(hive|every-mind|swarm:s_(?:[0-9a-f]{8}|[0-9a-f]{32})|agent:a_(?:[0-9a-f]{8}|[0-9a-f]{32})|person:u_(?:[0-9a-f]{8}|[0-9a-f]{32})|key:(k_(?:[0-9a-f]{8}|[0-9a-f]{32})|env:[a-z0-9_-]+))$")


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
        if not SCOPE.fullmatch(scope):
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
        """A member's monthly allowance when no rule is set (Jon: $50 per family member); admins have none."""
        row = self.db.one("SELECT * FROM people WHERE id = ? AND disabled = 0", (person_id,))
        if row is None or row["role"] == "admin":
            return None
        if row.get("access") in ("guest", "public"):
            # own hive H1: a public visitor, or a guest past their grant (revoked or ended) on a public hive-paid mind,
            # swarm or hive: the hive's visitor limit. A guest's live grant replaces it (Budgets.applicable), and a guest
            # with no visitor limit to fall back on gets none here (OwnHive.use_check refuses their call); a public
            # visitor with none set has the member default.
            visitor = self.hive.ownhive.settings()["visitor_month_usd"]
            if visitor is not None:
                return float(visitor)
            if row.get("access") == "guest":
                return None
        return self.default_allowance()

    def default_allowance(self):
        """The hive's member default month allowance (HIVE_MEMBER_MONTHLY_USD, $50)."""
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
        swarms, minds = self._auto_subjects()
        minds = [dict(m, explicit=m["id"] in explicit) for m in minds]
        return limits_auto.derive(rules, swarms, minds)

    def _foundation_ids(self):
        """Existing host-purpose bindings only; no model/admission/owner lookup."""
        from .foundation import foundation_budget_ids
        return foundation_budget_ids(self.db)

    def _auto_excluded(self, agent):
        swarms, minds = self._foundation_ids()
        return agent.get("swarm_id") in swarms or agent.get("id") in minds

    def _auto_subjects(self):
        """Ordinary share participants; Foundation keeps its explicit bounds.

        Filter before counting, including an exact bound actor whose membership
        has drifted. Nothing here filters usage, stored rules or reservations.
        """
        excluded_swarms, excluded_minds = self._foundation_ids()
        minds = [r for r in self.db.all("SELECT id, swarm_id, budget_usd FROM agents WHERE deleted = 0")
                 if r["id"] not in excluded_minds and r["swarm_id"] not in excluded_swarms]
        counts = {}
        for mind in minds:
            if mind["swarm_id"]:
                counts[mind["swarm_id"]] = counts.get(mind["swarm_id"], 0) + 1
        swarms = [{"id": r["id"], "archived": bool(r["archived_at"]), "minds": counts.get(r["id"], 0)}
                  for r in self.db.all("SELECT id, archived_at FROM swarms ORDER BY created_at")
                  if r["id"] not in excluded_swarms]
        return swarms, minds

    def panel_total(self, rules=None):
        """The hive total a person set on the Limits page, or None: the one source every automatic limit comes from."""
        return limits_auto.hive_total(self.rules() if rules is None else rules)

    # ---- server settings only seed a hive with no total (Jon 2026-10-07) ----------------------------------------------

    def hard_cap(self, rules=None):
        """HIVE_BUDGET_USD, the all-time cap from the server's settings, while the hive has no total on the Limits page;
        0 (none) once it has one. Jon 2026-10-07: "surely they should match the number I set in the admin panel": a
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

    def paid_without_cap(self, agent, rules=None, payer=None, own_key=False, key_id=None, turn_bound=False):
        """True when a paid call by a mind with no cap of its own (budget_usd 0) is let through to the limits above it.
        THE PLAN'S ONE LOOSENING (review-blocking, PLATFORM_AUTO_BUDGET_LIMITS_PLAN §2.3): only once the hive has a
        total. Without one, budget 0 still means no paid calls (402 no_budget), as before, except for a personal mind
        paid by its own person from their month allowance (allowance_pays), or (gateway r1a) a turn-bound call on the
        person's own key held to their one total monthly limit (own_key_bound)."""
        if float(agent.get("budget_usd") or 0) > 0:
            return False
        return ((self.panel_total(rules) is not None and not self._auto_excluded(agent))
                or self.allowance_pays(agent, payer, own_key, rules, key_id)
                or self.own_key_bound(agent, payer, own_key, key_id, turn_bound) is not None)

    # ---- one settlement (First Light, Dot on 50998399): who pays a call, on which key, held by what ----------------------

    GOVERNING_ORIGINS = ("grant", "invite")

    def settlement(self, agent, model, user=None, turn_bound=True):
        """READ-ONLY. How a paid call by this mind (a stored row, or a proposed one) on `model` would settle, worked out by
        the call path's own lookups, never a copy of them: Gateway.paying_key (with OwnHive.own_key_for), the key's stored
        owner as the gateway reads it, Hive.payer_for, OwnHive.use_check and person_key_check, Budgets.applicable and
        paid_without_cap. The one answer for every place that must know who pays: First Light's pickup and creation
        (personal.py) and the mind's page (PersonalMinds.paid_by).
        {model, free, key_id, key_owner, payer, own_key, hive_key, governing_limits, bounded, host_paid, reason}:
        - governing_limits: the finite month limits that hold THIS payer on THIS key: their person:<id> month row (their
          rule, or the member default), a grant or invite on this key to them, or the hive's own total. A swarm, mind or
          key: row also limits the call, but never stands in for these (a key rule is the key's, not the person's bound);
        - bounded: the call would be admitted (its own cap, or paid_without_cap) AND a governing limit holds it;
        - host_paid: on a key no named person owns, paid by `user` from the hive's money, and bounded;
        - reason: why not, when it is not (the refusal's code), else None."""
        from .config import is_subscription
        from .gateway import GatewayError, split_model
        from .hive import HiveError
        hive = self.hive
        out = {"model": model, "free": False, "key_id": None, "key_owner": None, "payer": None, "own_key": False,
               "hive_key": False, "governing_limits": [], "bounded": False, "host_paid": False, "reason": None}
        gw = getattr(hive, "gateway", None)
        try:
            provider_name, name = split_model(model)
            if provider_name == "mock":
                return dict(out, free=True, bounded=True)
            if gw is None:
                return dict(out, reason="no_gateway")
            provider = gw.provider(provider_name)
            if is_subscription(provider_name):
                # R3.2 §M: the owner's plan, never free and never a paying key; bounded by the gate's day call cap. Only
                # what the call path would admit now settles at all: the egress rule, then the gate, for `user` when
                # the caller names who the call is for (as the conductor and the mind gateway pass it)
                gw.enforce_egress(agent, provider_name)
                gw.admit_subscription(agent, principal=user, provider=provider_name)
                return dict(out, payer=hive.ownhive.owner(), own_key=True, subscription=True, payer_mode="plan",
                            bounded=True)
            if provider.local:
                return dict(out, free=True, bounded=True)
            if not provider.priced(name):
                # unbounded whatever HIVE_ALLOW_UNPRICED says: permission to call is not a bound on what it costs, and the
                # mind's own route refuses it anyway (an unpriced estimate is $0, which Reservations.reserve rejects)
                return dict(out, reason="unpriced_model")
            proposed = {**agent, "model": model, "id": agent.get("id") or "", "options": gw.payment_options(agent)}
            key_id, secret = gw.paying_key(proposed, provider_name)
        except GatewayError as exc:
            return dict(out, reason=exc.code)
        if not secret:
            return dict(out, reason="no_key")   # the gateway would send it with no key: nothing pays, it is refused
        key_owner = ((gw.keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if (key_id and gw.keyring) else None
        payer, own_key = hive.payer_for(proposed, key_owner)
        out.update(key_id=key_id, key_owner=key_owner, payer=payer, own_key=own_key,
                   hive_key=hive.ownhive.key_person(key_id) is None)
        try:
            hive.ownhive.person_key_check(proposed, key_id, user=user)
            hive.ownhive.use_check(proposed, key_id, payer)
        except HiveError as exc:
            return dict(out, reason=exc.code)
        governing = []
        if turn_bound:
            # a turn-bound call (the personal mind's own route) is admitted only under the person's ONE monthly total
            # (Hive.check_budget, cost_reservations: monthly_total_required): the same predicate here, so a mind is never
            # selected or described as paid where its calls would be refused (a hive total alone is not it)
            total = self.monthly_total(proposed, payer, own_key, key_id)
            if total is None:
                return dict(out, reason="monthly_total_required")
            governing.append(total)
        if not own_key:   # on the hive's money: what holds THIS payer on THIS key
            person = "person:" + payer[5:] if isinstance(payer, str) and payer.startswith("user:u_") else None
            for scope, period, limit, origin in self.applicable(proposed, key_id, payer, own_key, turn_bound):
                held = (scope == person and period == "month") or origin in self.GOVERNING_ORIGINS or scope == "hive"
                row = (scope, period, float(limit), origin) if isinstance(limit, (int, float)) else None
                if held and row and 0 <= row[2] < float("inf") and row not in governing:
                    governing.append(row)
        cap = float(proposed.get("budget_usd") or 0)
        if cap > 0:
            governing.append((f"agent:{proposed['id']}", "total", cap, "own-cap"))
        admitted = cap > 0 or self.paid_without_cap(proposed, None, payer, own_key, key_id, turn_bound)
        bounded = bool(admitted and governing)
        out.update(governing_limits=governing, bounded=bounded,
                   host_paid=bool(bounded and out["hive_key"] and not own_key and user is not None and payer == user))
        if not bounded:
            out["reason"] = "not_admitted" if not admitted else "no_governing_limit"
        return out

    def lifetime_cap_applies(self, agent, rules=None, payer=None, own_key=False, key_id=None, turn_bound=False):
        """Whether the mind's own budget_usd is one of its reservation rows: always when it is above 0; at 0 only while
        the hive has no total (where it refuses, as no_budget does) and the call is not one allowance_pays or
        own_key_bound admits (the same predicate as paid_without_cap: one source)."""
        if float(agent.get("budget_usd") or 0) > 0:
            return True
        return not self.paid_without_cap(agent, rules, payer, own_key, key_id, turn_bound)

    # ---- gateway r1a (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.6, r1.1 §C/§F, r1.2): one monthly total ----------------

    def monthly_total(self, agent, payer, own_key=False, key_id=None):
        """The person's ONE monthly total that governs a turn-bound call, as (scope, period, limit, origin), or None.
        - On their own key: the key owner's own limit on ALL their keys (key_limits grantee 'self', key '*': a keyuse:
          scope that counts every own-key call of theirs on every route). A limit on one key never satisfies it, nor does
          an admin's person rule (both stay as additional rows).
        - On the hive's money: their month allowance, the row Budgets.applicable already adds for them (their
          person:<id> month rule, else the member default) or a key owner's grant to them.
        Only for a named person paying for their own personal mind."""
        if not isinstance(payer, str) or not payer.startswith("user:u_") or agent.get("personal_of") != payer:
            return None
        own = self.hive.ownhive
        if own_key:
            if own.key_owner(key_id) != payer:
                return None
            row = own.total_row(payer)
            return (row["scope"], "month", float(row["month_usd"]), "own") if row else None
        person = "person:" + payer[5:]
        for scope, period, limit, origin in self.applicable(agent, key_id, payer, False):
            if (scope == person and period == "month") or origin in ("grant", "invite"):
                return (scope, period, limit, origin)
        return None

    def own_key_bound(self, agent, payer, own_key, key_id, turn_bound):
        """The bound that admits a turn-bound own-key call by a $0 personal mind, or None (the one predicate,
        paid_without_cap and lifetime_cap_applies consult it). All must hold: the mind is the payer's personal mind, the
        call is on their own key and they own it in the ring, the mind's own cap is 0, the caller is turn-bound (only the
        personal-mind gateway), and their one total monthly limit exists (monthly_total). Never for any other route."""
        if not turn_bound or not own_key or float(agent.get("budget_usd") or 0) != 0:
            return None
        if not isinstance(payer, str) or agent.get("personal_of") != payer or self.hive.ownhive.key_owner(key_id) != payer:
            return None
        return self.monthly_total(agent, payer, True, key_id)

    def total_required(self, own_key):
        """The one refusal for a turn-bound call with no monthly total (r1.2: the single word monthly_total_required)."""
        say = "Set your monthly limit so your mind can spend on your key." if own_key else \
            "Set your monthly limit so your mind can spend."
        return self.hive.error(402, "spend_limit", say, {
            "kind": "own_key_limit" if own_key else "member_allowance", "reason": "monthly_total_required",
            "scope": None, "period": None, "limit_usd": None, "spent_usd": None})

    def allowance_pays(self, agent, payer=None, own_key=False, rules=None, key_id=None):
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
        if key_id is not None:
            # a grant counts only when it is on THIS key, to this person (the row Budgets.applicable adds); one on some
            # other key bounds nothing here (First Light, sol on 50998399)
            if any(origin in self.GOVERNING_ORIGINS for _, _, _, origin in self.hive.ownhive.rules(key_id, person)):
                return True
        elif self.hive.ownhive.has_grant(person):
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
        its auto day) once the hive has a total; else HIVE_PERSON_REQUEST_CEILING_USD (a seed, Jon 2026-10-07).
        Foundation has no auto share: its own day rule wins, else the original seed; original Minds caps still hold."""
        rules = self.rules()
        if swarm_id in self._foundation_ids()[0]:
            # Purpose-bound requests do not consume an ordinary auto share.
            # A stored day rule, including zero, still wins. Otherwise retain
            # the existing seed; Minds.instruct also enforces its lower cap.
            own = next((r for r in rules if r["scope"] == f"swarm:{swarm_id}" and r["period"] == "day"), None)
            if own is not None:
                return float(own["limit_usd"]), "set"
            env = "HIVE_PERSON_REQUEST_CEILING_USD" in (self.hive.settings.budget_env or {})
            return float(self.hive.settings.person_request_ceiling_usd or 0), "server-settings" if env else "default"
        if self.panel_total(rules) is None:
            env = "HIVE_PERSON_REQUEST_CEILING_USD" in (self.hive.settings.budget_env or {})
            return float(self.hive.settings.person_request_ceiling_usd or 0), "server-settings" if env else "default"
        own = next((r for r in rules if r["scope"] == f"swarm:{swarm_id}" and r["period"] == "day"), None)
        if own is not None:
            return float(own["limit_usd"]), "set"
        auto = self.derive(rules)["limits"].get((f"swarm:{swarm_id}", "day"))
        return (float(auto["limit_usd"]), "auto") if auto else (0.0, "auto")

    def applicable(self, agent, key_id=None, payer=None, own_key=False, turn_bound=False):
        """Every (scope, period, limit, origin) that applies to a call by this mind. A person paying from the
        hive's money is held to their allowance; spend on their own key is theirs and is not. Gateway r1a (r1.1 §F,
        r1.2): a turn-bound call on their own key is also held to an admin-set person:<id> month rule when one exists, as
        an additional row (never the member default, and never a substitute for their own total)."""
        scopes = ["hive", f"agent:{agent['id']}"]
        person_scope = None
        if payer and payer.startswith("user:u_") and not own_key:
            person_scope = "person:" + payer[5:]
            scopes.append(person_scope)
        elif payer and payer.startswith("user:u_") and turn_bound:
            scopes.append("person:" + payer[5:])
        if agent.get("swarm_id"):
            scopes.append(f"swarm:{agent['swarm_id']}")
        if key_id:
            scopes.append(f"key:{key_id}")
        rules = self.rules()
        found = [(r["scope"], r["period"], r["limit_usd"], r["id"]) for r in rules if r["scope"] in scopes]
        swarm_scope = f"swarm:{agent['swarm_id']}" if agent.get("swarm_id") else None
        derived = self.derive(rules)
        if derived["total"] is not None:
            keys = (("hive", "month"), ("hive", "day"))
            if not self._auto_excluded(agent):
                keys += ((swarm_scope, "month"), (swarm_scope, "day"), (f"agent:{agent['id']}", "month"))
            for key in keys:
                auto = derived["limits"].get(key)
                if auto is not None and key[0]:
                    found.append((key[0], key[1], auto["limit_usd"], "auto"))
        else:
            default = self.hive.settings.swarm_monthly_usd
            if swarm_scope and default and not self._auto_excluded(agent) and not any(s == swarm_scope and p == "month" for s, p, _, _ in found):
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

    def check(self, agent, estimate, key_id=None, payer=None, own_key=False, turn_bound=False):
        self.hive.ownhive.use_check(agent, key_id, payer)   # own hive H1: may this payer use this key at all?
        for scope, period, limit, origin in self.applicable(agent, key_id, payer, own_key, turn_bound):
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
            excluded_swarms, _ = self._foundation_ids()
            for swarm in self.hive.swarms():
                if swarm["id"] in excluded_swarms:
                    continue
                scope = f"swarm:{swarm['id']}"
                if scope not in ruled:
                    out.append({"id": f"default:{scope}", "scope": scope, "period": "month", "limit_usd": default,
                                "note": "default for every swarm", "created_at": None,
                                "spent_usd": round(self.spent(scope, "month"), 6), "origin": "default"})
        return out
