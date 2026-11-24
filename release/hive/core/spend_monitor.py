"""Purpose: detect recorded spend anomalies and manage explicit owner-chosen holds on new paid calls."""

from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP
from fractions import Fraction
from math import fsum
from pathlib import Path
import sqlite3
from statistics import quantiles
from uuid import uuid4

from ..spaces import sexpr
from .cost_reservations import micros
from .db import stamp_of


BANDS = ((720, Fraction(2, 100)), (120, Fraction(5, 100)))
SHORT_RATIO = 12
HISTORY_DAYS = 7
MICROS_PER_DOLLAR = 1_000_000
HIVE = "hive"
# The hive's money: a call on one of the hive's keys, or on its owner's own key, which OwnHive.key_owner already reads
# as the hive's and which pays for every hive mind on an own hive. A member's own key is theirs alone (Jon's desk on
# #706, under #615's own-admin rule): its spend counts in that mind's alert and pause, never in the hive's totals or
# its pause. A usage row from before key_person was recorded has none, and counts as the hive's as every row did.
HIVE_MONEY = "(u.key_person IS NULL OR u.key_person = ?)"


def hive_money(key_person, owner):
    """HIVE_MONEY for one call: whether the person whose own key pays it (None for the hive's keys) leaves it the
    hive's."""
    return key_person is None or key_person == owner


SPEND_PAUSE_WORDS = {
    "hive_spend_paused": "The hive owner paused new paid calls. They can resume them in Usage.",
    "mind_spend_paused": "This mind's owner paused new paid calls. They can resume them in Usage.",
}


def _load_law():
    """Load the finite ground relation from MeTTa. Invalid or duplicate rules refuse startup."""
    rules = set()
    for line in Path(__file__).with_suffix(".metta").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        atom = sexpr.parse(line)
        if (not isinstance(atom, list) or len(atom) != 4 or atom[0] != "SpendPermission"
                or atom[1] not in ("hive", "mind") or atom[2] not in ("receive", "view", "pause", "resume")
                or atom[3] not in ("system-owner", "mind-owner")):
            raise ValueError("Invalid spend permission")
        rule = tuple(atom[1:])
        if rule in rules:
            raise ValueError("Duplicate spend permission")
        rules.add(rule)
    return frozenset(rules)


PERMISSIONS = _load_law()


SCHEMA = (
    "CREATE INDEX IF NOT EXISTS spend_usage_positive_at ON usage(created_at) WHERE cost_usd > 0",
    """CREATE TABLE IF NOT EXISTS spend_monitor_position (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        before_id INTEGER NOT NULL, evaluated_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS spend_alerts (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, recipient TEXT NOT NULL, opened_at TEXT NOT NULL,
        closed_at TEXT, last_charge INTEGER NOT NULL, window_seconds INTEGER NOT NULL,
        spent INTEGER NOT NULL, projected INTEGER, cap INTEGER
    )""",
    "CREATE UNIQUE INDEX IF NOT EXISTS spend_alerts_open ON spend_alerts(scope) WHERE closed_at IS NULL",
    "CREATE INDEX IF NOT EXISTS spend_alerts_recipient ON spend_alerts(recipient, opened_at)",
    """CREATE TABLE IF NOT EXISTS spend_pauses (
        scope TEXT PRIMARY KEY, actor TEXT NOT NULL, alert_id TEXT NOT NULL REFERENCES spend_alerts(id)
    )""",
    """CREATE TABLE IF NOT EXISTS spend_pause_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL REFERENCES spend_alerts(id),
        actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('pause','resume')), at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS spend_mind_ownership (
        agent_id TEXT PRIMARY KEY, before_id INTEGER NOT NULL, epoch INTEGER NOT NULL
    )""",
    # Personal binding is optional metadata. Only a change to the owner creates a new ownership epoch.
    """CREATE TRIGGER IF NOT EXISTS spend_mind_new_owner
        AFTER UPDATE OF owner ON agents
        WHEN NEW.owner IS NOT OLD.owner
        BEGIN
            INSERT INTO spend_mind_ownership VALUES (NEW.id, (SELECT COALESCE(MAX(id),0) FROM usage), 1)
            ON CONFLICT(agent_id) DO UPDATE SET before_id = excluded.before_id, epoch = epoch + 1;
            UPDATE spend_alerts SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE scope = NEW.id AND closed_at IS NULL;
            DELETE FROM spend_pauses WHERE scope = NEW.id;
        END""",
)


@dataclass(frozen=True)
class Cap:
    amount: int
    start: datetime | None
    end: datetime | None
    reference_seconds: int

    @property
    def windows(self):
        return tuple(
            window
            for divisor, _ in BANDS
            for window in (self.reference_seconds // divisor, self.reference_seconds // divisor // SHORT_RATIO)
        )


def _cap(conn, moment, server_limit):
    month = moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    next_month = (month + timedelta(days=32)).replace(day=1)
    month_seconds = int((next_month - month).total_seconds())
    rule = conn.execute(
        "SELECT period, limit_usd FROM budgets WHERE scope = 'hive' AND period IN ('day', 'month', 'total') "
        "ORDER BY CASE period WHEN 'month' THEN 0 WHEN 'day' THEN 1 ELSE 2 END, id LIMIT 1"
    ).fetchone()
    if rule is None:
        return Cap(micros(server_limit or 0), None, None, month_seconds)
    amount = micros(rule["limit_usd"])
    if rule["period"] == "day":
        day = moment.replace(hour=0, minute=0, second=0, microsecond=0)
        return Cap(amount, day, day + timedelta(days=1), 86400)
    if rule["period"] == "month":
        return Cap(amount, month, next_month, month_seconds)
    return Cap(amount, None, None, month_seconds)


def _window_totals(conn, moment, windows, owner, start=None):
    """Each mind's spend in each window, and the hive's: what was spent on the hive's money (HIVE_MONEY, ``owner`` the
    hive owner), so a member's own-key spend raises only their mind's alert.
    Time: one bounded index range and group by mind, with eight conditional sums per charge."""
    cutoffs = [stamp_of(moment - timedelta(seconds=window)) for window in windows]
    if start is not None:
        # Include charges at the first instant of the cap period without changing the rolling window's open left edge.
        cutoffs = [max(cutoff, stamp_of(start - timedelta(milliseconds=1))) for cutoff in cutoffs]
    sums = ", ".join(f"SUM(CASE WHEN u.created_at > ? THEN u.cost_usd ELSE 0 END) AS w{i}" for i in range(len(windows)))
    hive_sums = ", ".join(f"SUM(CASE WHEN u.created_at > ? AND {HIVE_MONEY} THEN u.cost_usd ELSE 0 END) AS h{i}"
                          for i in range(len(windows)))
    rows = conn.execute(
        f"SELECT CASE WHEN u.id > COALESCE(o.before_id, 0) THEN u.agent_id END AS scope_id, {sums}, {hive_sums} "
        "FROM usage u LEFT JOIN spend_mind_ownership o ON o.agent_id = u.agent_id "
        "WHERE u.cost_usd > 0 AND u.created_at > ? AND u.created_at <= ? GROUP BY scope_id",
        (*cutoffs, *(value for cutoff in cutoffs for value in (cutoff, owner)), min(cutoffs), stamp_of(moment)),
    ).fetchall()
    raw = {row["scope_id"]: tuple(row[f"w{i}"] for i in range(len(windows))) for row in rows}
    hive_total = tuple(fsum(row[f"h{i}"] for row in rows) for i in range(len(windows)))
    raw.pop(None, None)
    raw[HIVE] = hive_total
    amounts = {scope: tuple(micros(value, ROUND_HALF_UP) for value in values) for scope, values in raw.items()}
    return amounts


def _median_charge(conn, begin, end):
    bounds = (stamp_of(begin), stamp_of(end))
    size = conn.execute(
        "SELECT COUNT(*) FROM usage WHERE cost_usd > 0 AND created_at > ? AND created_at <= ?", bounds
    ).fetchone()[0]
    if not size:
        return None
    values = conn.execute(
        "SELECT cost_usd FROM usage WHERE cost_usd > 0 AND created_at > ? AND created_at <= ? "
        "ORDER BY cost_usd LIMIT ? OFFSET ?", (*bounds, 2 - size % 2, (size - 1) // 2),
    )
    return Fraction(sum(micros(row[0], ROUND_HALF_UP) for row in values), 2 - size % 2)


def _fence(samples):
    lower, _, upper = quantiles(samples, n=4, method="inclusive")
    return upper + Fraction(3, 2) * (upper - lower)


@dataclass(frozen=True)
class Signal:
    active: bool
    stays_open: bool
    window: int
    spent: int
    projected: int | None = None
    forecast_charge: int = 0


def _signal(amounts, history, cap, typical_charge):
    windows = cap.windows
    if history and (cap.amount > 0 or typical_charge is not None):
        thresholds = []
        for i, (seconds, amounts_at_i) in enumerate(zip(windows, zip(*history))):
            floor = (Fraction(cap.amount * seconds, cap.reference_seconds) if cap.amount > 0
                     else typical_charge * Fraction(seconds, windows[i - i % 2]))
            thresholds.append(_fence(tuple(map(Fraction, amounts_at_i))) + floor)
        over = tuple(amount > threshold for amount, threshold in zip(amounts, thresholds))
    elif cap.amount:
        thresholds = tuple(
            cap.amount * fraction * Fraction(windows[i + offset], windows[i])
            for i, (_, fraction) in zip((0, 2), BANDS)
            for offset in (0, 1)
        )
        over = tuple(amount >= threshold for amount, threshold in zip(amounts, thresholds))
    else:
        over = (False,) * len(windows)
    active = [i for i in (0, 2) if over[i] and over[i + 1]]
    evidence = active[0] if active else 2
    return Signal(bool(active), over[0] or over[2], windows[evidence], amounts[evidence])


def _project(conn, moment, cap, amounts, signal, owner):
    if not cap.amount or cap.end is None or cap.start is None:
        return signal
    _, _, long, short = cap.windows
    pace = min(Fraction(amounts[2], long), Fraction(amounts[3], short))
    if not pace:
        return signal
    spent, charge = conn.execute(
        "SELECT COALESCE(SUM(u.cost_usd),0), COALESCE(MAX(u.id),0) FROM usage u "
        f"WHERE u.cost_usd > 0 AND u.created_at >= ? AND u.created_at <= ? AND {HIVE_MONEY}",
        (stamp_of(cap.start), stamp_of(moment), owner),
    ).fetchone()
    remaining_ms = (cap.end - moment) // timedelta(milliseconds=1)
    estimate = micros(spent, ROUND_HALF_UP) + pace * Fraction(remaining_ms, 1000)
    if estimate <= cap.amount:
        return signal
    return Signal(True, True, signal.window if signal.active else long, signal.spent if signal.active else amounts[2],
                  round(estimate), charge)


class SpendMonitor:
    def __init__(self, hive, clock=None):
        self.hive = hive
        self.db = hive.db
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.ledger = (Path(hive.settings.data_dir) / "hive.db").resolve().as_uri() + "?mode=ro"
        with self.db.transaction():
            for statement in SCHEMA:
                self.db.execute(statement)

    def _mind(self, agent_id):
        return self.db.one("SELECT id, name, owner, personal_of FROM agents WHERE id = ? AND deleted = 0", (agent_id,))

    def _mind_owner(self, mind, system_owner):
        if not mind or (mind["personal_of"] and mind["personal_of"] != mind["owner"]):
            return None
        principal = mind["owner"]
        if principal == "user:operator" and principal == system_owner:
            return principal
        if not principal or not principal.startswith("user:u_"):
            return None
        person = self.db.one("SELECT disabled FROM people WHERE id = ?", (principal[5:],))
        return principal if person is not None and not person["disabled"] else None

    def _relation(self, viewer, scope, owner):
        if scope == HIVE:
            return "system-owner" if self.hive.ownhive.acts_as_owner(viewer) else None
        return "mind-owner" if viewer.principal == self._mind_owner(self._mind(scope), owner) else None

    def _snapshot(self, moment, owner):
        """Aggregate comparable history and current charges from one committed WAL read snapshot, the hive's on its
        money alone (HIVE_MONEY, ``owner`` the hive owner)."""
        with closing(sqlite3.connect(self.ledger, uri=True)) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN")
            cap = _cap(conn, moment, self.hive.settings.hive_budget_usd)
            watermark = conn.execute("SELECT COALESCE(MAX(id),0) FROM usage").fetchone()[0]
            windows = cap.windows
            amounts = _window_totals(conn, moment, windows, owner, cap.start)
            oldest = moment - timedelta(days=HISTORY_DAYS, seconds=max(windows))
            covered = conn.execute(
                "SELECT 1 FROM usage WHERE cost_usd > 0 AND created_at <= ? LIMIT 1", (stamp_of(oldest),)
            ).fetchone()
            history = []
            if covered:
                history = [
                    _window_totals(conn, moment - timedelta(days=days), windows, owner)
                    for days in range(1, HISTORY_DAYS + 1)
                ]
            typical = _median_charge(conn, oldest, moment - timedelta(days=1)) if history and not cap.amount else None
            zeroes = (0,) * len(windows)
            signals = {
                scope: _signal(amount, [sample.get(scope, zeroes) for sample in history], cap, typical)
                for scope, amount in amounts.items()
            }
            signals[HIVE] = _project(conn, moment, cap, amounts[HIVE], signals[HIVE], owner)
            epochs = {row["agent_id"]: row["epoch"] for row in conn.execute("SELECT agent_id, epoch FROM spend_mind_ownership")}
        return watermark, cap, signals, epochs

    def sweep(self):
        """Commit one open incident per scope. Stale concurrent snapshots cannot overwrite a newer sweep."""
        moment = self.clock()
        at = stamp_of(moment)
        watermark, cap, signals, epochs = self._snapshot(moment, self.hive.ownhive.owner())
        with self.db.transaction():
            previous = self.db.one("SELECT before_id, evaluated_at FROM spend_monitor_position WHERE singleton = 1")
            if previous and (at, watermark) <= (previous["evaluated_at"], previous["before_id"]):
                return
            owner = self.hive.ownhive.owner()
            opened = {row["scope"]: row for row in self.db.all("SELECT * FROM spend_alerts WHERE closed_at IS NULL")}
            for scope in opened.keys() | signals.keys():
                if scope != HIVE:
                    current = self.db.one("SELECT epoch FROM spend_mind_ownership WHERE agent_id = ?", (scope,))
                    if (current["epoch"] if current else None) != epochs.get(scope):
                        continue
                signal = signals.get(scope)
                row = opened.get(scope)
                person = self._recipient(scope, owner)
                if row and (not signal or not signal.stays_open or person != row["recipient"]):
                    self.db.execute("UPDATE spend_alerts SET closed_at = ? WHERE id = ?", (at, row["id"]))
                    self._refresh(row["recipient"], None)
                    row = None
                if not person or not signal or (row is None and not signal.active):
                    continue
                figures = {
                    "window_seconds": signal.window, "spent": signal.spent, "projected": signal.projected,
                    "cap": cap.amount if scope == HIVE and cap.amount else None,
                }
                if row is not None:
                    changed = {key for key, value in figures.items() if row[key] != value}
                    if not changed:
                        continue
                    # Keep the displayed number between relevant charges. The forecast appearing or clearing still
                    # changes what the alert tells the owner, even when that happens as time passes.
                    if (changed == {"projected"} and row["projected"] is not None and signal.projected is not None
                            and signal.forecast_charge <= row["last_charge"]):
                        continue
                    alert_id = row["id"]
                    self.db.update("spend_alerts", alert_id, {**figures, "last_charge": watermark})
                else:
                    alert_id = "sa_" + uuid4().hex
                    self.db.insert("spend_alerts", {
                        "id": alert_id, "scope": scope, "recipient": person, "opened_at": at, "last_charge": watermark,
                        **figures,
                    })
                self._refresh(person, alert_id)
            self.db.execute(
                "INSERT INTO spend_monitor_position VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET "
                "before_id = excluded.before_id, evaluated_at = excluded.evaluated_at", (watermark, at),
            )

    def _recipient(self, scope, owner):
        kind = "hive" if scope == HIVE else "mind"
        if scope == HIVE:
            if owner == "user:operator":
                eligible = True
            else:
                person = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (owner[5:],))
                eligible = person is not None and not person["disabled"] and person["role"] == "admin"
            return owner if eligible and (kind, "receive", "system-owner") in PERMISSIONS else None
        return self._mind_owner(self._mind(scope), owner) if (kind, "receive", "mind-owner") in PERMISSIONS else None

    def _refresh(self, principal, alert_id):
        self.db.after_commit(lambda: self.hive.events.publish("spend.alert", principal=principal, alert_id=alert_id))

    def _view(self, row, viewer, owner):
        scope = row["scope"]
        kind = "hive" if scope == HIVE else "mind"
        if (kind, "view", self._relation(viewer, scope, owner)) not in PERMISSIONS:
            return None
        if scope != HIVE and row["recipient"] != viewer.principal:
            return None
        mind = self._mind(scope) if scope != HIVE else None
        paused = self._paused(scope, owner)
        action = "resume" if paused else "pause"
        can_control = (paused or row["closed_at"] is None) and (kind, action, self._relation(viewer, scope, owner)) in PERMISSIONS
        return {
            "id": row["id"], "scope": kind, "agent_id": scope if mind else None, "name": mind["name"] if mind else None,
            "opened_at": row["opened_at"], "closed_at": row["closed_at"], "window_seconds": row["window_seconds"],
            "spent_usd": row["spent"] / MICROS_PER_DOLLAR,
            "projected_usd": row["projected"] / MICROS_PER_DOLLAR if row["projected"] is not None else None,
            "limit_usd": row["cap"] / MICROS_PER_DOLLAR if row["cap"] is not None else None,
            "paused": paused, "can_control": can_control,
        }

    def list(self, viewer):
        with self.db.transaction():
            owner = self.hive.ownhive.owner()
            rows = self.db.all(
                "SELECT a.* FROM spend_alerts a LEFT JOIN spend_pauses p ON p.scope = a.scope "
                "WHERE (a.recipient = ? OR a.scope = 'hive') "
                "AND (a.closed_at IS NULL OR p.alert_id = a.id) ORDER BY a.opened_at DESC, a.id",
                (viewer.principal,),
            )
            seen = set()
            alerts = []
            for row in rows:
                alert = self._view(row, viewer, owner)
                if alert is None or (row["closed_at"] and not alert["paused"]) or row["scope"] in seen:
                    continue
                seen.add(row["scope"])
                alerts.append(alert)
            return {"alerts": alerts}

    def _paused(self, scope, owner):
        row = self.db.one("SELECT actor FROM spend_pauses WHERE scope = ?", (scope,))
        return row is not None and (scope == HIVE or row["actor"] == self._mind_owner(self._mind(scope), owner))

    def control(self, alert_id, data, viewer_for):
        if not isinstance(data, dict) or set(data) != {"action"} or data["action"] not in ("pause", "resume"):
            raise self.hive.error(400, "bad_request", "Choose pause or resume.")
        action = data["action"]
        with self.db.transaction():
            viewer = viewer_for()
            owner = self.hive.ownhive.owner()
            row = self.db.one("SELECT * FROM spend_alerts WHERE id = ?", (alert_id,))
            if row is None or self._view(row, viewer, owner) is None:
                raise self.hive.error(404, "not_found", "No such spend alert.")
            scope = row["scope"]
            kind = "hive" if scope == HIVE else "mind"
            if (kind, action, self._relation(viewer, scope, owner)) not in PERMISSIONS:
                raise self.hive.error(403, "owner_only", "Only the owner can change this pause.")
            paused = self._paused(scope, owner)
            if paused == (action == "pause"):
                return self._view(row, viewer, owner)
            if action == "pause":
                if row["closed_at"]:
                    raise self.hive.error(409, "spend_alert_closed", "This spending alert has cleared.")
                self.db.execute(
                    "INSERT INTO spend_pauses VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET "
                    "actor = excluded.actor, alert_id = excluded.alert_id", (scope, viewer.principal, alert_id),
                )
            else:
                self.db.execute("DELETE FROM spend_pauses WHERE scope = ?", (scope,))
            self.db.insert("spend_pause_receipts", {
                "alert_id": alert_id, "actor": viewer.principal, "action": action, "at": stamp_of(self.clock()),
            })
            self._refresh(viewer.principal, None)
            return self._view(row, viewer, owner)

    def require_new_paid_call(self, agent_id, key_id=None):
        """The only effect on admission is a fresh read of explicit holds in the reservation's write transaction. A
        hive pause holds a call on the hive's money only (hive_money): a member's call on their own key goes on, and
        only their own mind's pause holds it."""
        holds = {row["scope"]: row["actor"] for row in self.db.all(
            "SELECT scope, actor FROM spend_pauses WHERE scope IN (?, ?)", (HIVE, agent_id),
        )}
        if not holds:
            return
        owner = self.hive.ownhive.owner()
        if HIVE in holds and hive_money(self.hive.ownhive.key_person(key_id), owner):
            raise self.hive.error(402, "hive_spend_paused", SPEND_PAUSE_WORDS["hive_spend_paused"])
        if agent_id in holds and holds[agent_id] == self._mind_owner(self._mind(agent_id), owner):
            raise self.hive.error(402, "mind_spend_paused", SPEND_PAUSE_WORDS["mind_spend_paused"])
