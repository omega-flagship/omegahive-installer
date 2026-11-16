# Purpose: notices at 50, 80 and 100% of each person's monthly allowance and of the hive's monthly cap, each threshold
# sent once a month for the figure in force, and the 100% notice when admission refuses a call on one of them.
"""Limit notices (#107, PR C), the way a cloud budget alerts: a threshold fires once per budget period.

After a paid call's usage row commits (Hive.record_usage queues after_usage with Database.after_commit, so a notice is
only ever about spend that stands, and is posted outside the transaction's lock), the payer's monthly allowance on the
hive's money and the hive's monthly cap are each compared with this month's spend, the same figure admission counts
(Budgets.spent). Crossing 50, 80 or 100% of a figure writes a row to limit_notices(label, month, threshold,
limit_micros); only a new row posts a notice, so two calls settling at once post it once and a restart never repeats
it. A call that crosses several thresholds at once, or a figure lowered under the spend, marks each and posts one notice
for the highest. A raised or lowered figure is a new figure, so its thresholds notify again.

Every notice goes through Notices.from_hive: the person's quiet hours hold it for their digest, and it never uses one of
their daily pop-ups. The person gets their own allowance's notices; the admins get the hive cap's and any person's
100%. A person's 100% from spend also asks the admins for more (PersonRequests.auto_allowance, once a month), as
admission refusing on their allowance already does (Hive.note_refusal).
"""

from __future__ import annotations

import logging

from .budgets import period_start, to_micros
from .db import now

THRESHOLDS = (50, 80, 100)
SCHEMA = ("CREATE TABLE IF NOT EXISTS limit_notices (label TEXT NOT NULL, month TEXT NOT NULL, threshold INTEGER NOT NULL, "
          "limit_micros INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (label, month, threshold, limit_micros))")
log = logging.getLogger("hive.limits")


def _money(usd):
    return f"${float(usd):,.2f}"


class LimitNotices:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(SCHEMA)

    def allowance(self, payer):
        """(scope, limit) of this payer's monthly allowance on the hive's money: their person:<id> month rule, else the
        member default; None for a payer who is no named person, or an admin with no rule of their own."""
        if not isinstance(payer, str) or not payer.startswith("user:u_"):
            return None
        pid = payer[5:]
        rule = next((r for r in self.hive.budgets.rules() if r["scope"] == f"person:{pid}" and r["period"] == "month"), None)
        limit = float(rule["limit_usd"]) if rule is not None else self.hive.budgets.member_allowance(pid)
        return None if limit is None else (f"person:{pid}", limit)

    def after_usage(self, payer):
        """A paid call's usage row committed: the payer's allowance and the hive's month cap, each against this month's
        spend. A hive whose cap is a day rule gets no monthly notice. Time: two spend queries and one rule read."""
        found = self.allowance(payer)
        if found is not None:
            self._check(found[0], found[1], ask=True)
        cap = self.hive.budgets.hive_cap()
        if cap is not None and cap["period"] == "month":
            self._check("hive", cap["limit_usd"], ask=False)

    def refused(self, scope, period, limit):
        """Admission refused a call on this limit: its 100% notice, once for this figure this month. A person's refusal
        has already asked the admins for more (Hive.note_refusal)."""
        if period == "month" and (scope == "hive" or str(scope).startswith("person:u_")):
            self._notify(scope, float(limit), self.hive.budgets.spent(scope, "month"), [100], ask=False)

    def _check(self, scope, limit, ask):
        spent = self.hive.budgets.spent(scope, "month")
        # integer micro-dollars: crossed when spent x 100 >= limit x threshold, never a float a hair short of it
        crossed = [t for t in THRESHOLDS if to_micros(spent, up=True) * 100 >= to_micros(limit) * t]
        if crossed:
            self._notify(scope, limit, spent, crossed, ask)

    def _mark(self, label, month, threshold, limit_micros):
        """True when this threshold of this figure had not been noticed this month (the row is new)."""
        return self.hive.db.execute("INSERT OR IGNORE INTO limit_notices VALUES (?, ?, ?, ?, ?)",
                                    (label, month, threshold, limit_micros, now())).rowcount == 1

    def _notify(self, scope, limit, spent, crossed, ask):
        limit_micros = to_micros(limit)
        if limit_micros <= 0:
            return   # a $0 figure admits nothing: there is no share of it to tell anyone about
        month = period_start("month")[:7]
        new = [t for t in crossed if self._mark(f"{scope}:month", month, t, limit_micros)]
        if not new:
            return
        top = max(new)
        if scope == "hive":
            text = (f"The hive's {_money(limit)} monthly cap has no room left ({_money(spent)} spent this month), so paid "
                    f"calls wait until it's raised or the month ends." if top == 100 else
                    f"The hive has used {top}% of its {_money(limit)} monthly cap ({_money(spent)} spent this month).")
            for admin in self._admins():
                self._post(admin, text)
            return
        person = "user:" + scope[7:]
        if top == 100:
            self._post(person, f"Your {_money(limit)} monthly allowance has no room left ({_money(spent)} spent this "
                               f"month), so paid calls on the hive's money wait until it's raised or the month ends. The "
                               f"admins have been asked for more.")
            name = (self.hive.db.one("SELECT name FROM people WHERE id = ?", (scope[7:],)) or {}).get("name") or "A person"
            for admin in self._admins():
                if admin != person:
                    self._post(admin, f"{name}'s {_money(limit)} monthly allowance has no room left ({_money(spent)} "
                                      f"spent this month). A request for more is waiting in Requests.")
            if ask:
                self.hive.person_requests.auto_allowance(person, limit)   # stop, notify, ask: once a month
        else:
            self._post(person, f"You've used {top}% of your {_money(limit)} monthly allowance ({_money(spent)} spent "
                               f"this month).")

    def _admins(self):
        return [f"user:{r['id']}" for r in self.hive.db.all(
            "SELECT id FROM people WHERE role = 'admin' AND disabled = 0 AND id LIKE 'u\\_%' ESCAPE '\\' ORDER BY created_at")]

    def _post(self, principal, text):
        from .hive import HiveError
        try:
            self.hive.notices.from_hive(principal, text)
        except HiveError as exc:   # someone disabled since, or at their day's notice limit: the threshold stays marked
            log.warning("limit notice to %s not posted: %s %s", principal, exc.code, exc.message)
