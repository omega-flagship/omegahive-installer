"""Wakeups: cron or one-shot messages that wake a mind and tell it why."""

from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import new_id, now

UTC = datetime.timezone.utc


class CronError(ValueError):
    pass


def _field(spec, low, high, names=None):
    values = set()
    for part in str(spec).split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            if not step_text.isdigit() or int(step_text) < 1:
                raise CronError(f"bad step {step_text!r}")
            step = int(step_text)
        if part in ("*", ""):
            start, end = low, high
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = _value(a, names), _value(b, names)
        else:
            start = _value(part, names)
            end = high if step > 1 else start
        if not (low <= start <= high and low <= end <= high) or start > end:
            raise CronError(f"value out of range in {spec!r}")
        values.update(range(start, end + 1, step))
    return values


def _value(text, names):
    text = text.strip().lower()
    if names and text in names:
        return names[text]
    if not text.isdigit():
        raise CronError(f"bad value {text!r}")
    return int(text)


DOW = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_cron(expr):
    fields = str(expr).split()
    if len(fields) != 5:
        raise CronError("cron needs 5 fields: minute hour day-of-month month day-of-week")
    minute, hour, dom, month, dow = fields
    days = _field(dow, 0, 7, DOW)
    if 7 in days:
        days = (days - {7}) | {0}
    return {"minute": _field(minute, 0, 59), "hour": _field(hour, 0, 23), "dom": _field(dom, 1, 31),
            "month": _field(month, 1, 12, MON), "dow": days, "dom_any": dom == "*", "dow_any": dow == "*"}


def next_run(expr, after, tz="UTC"):
    """Next time strictly after ``after`` (aware datetime) matching the cron, in UTC."""
    spec = parse_cron(expr)
    zone = ZoneInfo(tz)
    after = after.astimezone(UTC)
    day = after.astimezone(zone).date()
    # A valid calendar schedule can cross a leap-century gap. One Gregorian400-year cycle covers every date and
    # weekday combination; inspect dates, then selected hours/minutes, instead of scanning every intervening minute.
    hours, minutes = sorted(spec["hour"]), sorted(spec["minute"])
    for _ in range(146097 + 1):
        cron_dow = (day.weekday() + 1) % 7
        if spec["dom_any"] or spec["dow_any"]:
            day_ok = day.day in spec["dom"] and cron_dow in spec["dow"]
        else:  # standard cron: either field may match
            day_ok = day.day in spec["dom"] or cron_dow in spec["dow"]
        if day.month in spec["month"] and day_ok:
            candidates = set()
            for hour in hours:
                for minute in minutes:
                    local = datetime.datetime.combine(day, datetime.time(hour, minute))
                    for fold in (0, 1):
                        candidate = local.replace(tzinfo=zone, fold=fold).astimezone(UTC)
                        back = candidate.astimezone(zone)
                        # A gap maps to a different wall time. A normal time has only fold0; an ambiguous time has
                        # two real instants, each eligible strictly after the original UTC cutoff.
                        if back.replace(tzinfo=None) == local and back.fold == fold and candidate > after:
                            candidates.add(candidate)
            if candidates:
                # During a fold, local minute ordering is not UTC ordering (01:11 fold0 precedes01:00 fold1).
                return min(candidates)
        if day == datetime.date.max:
            break
        day += datetime.timedelta(days=1)
    raise CronError("cron never fires")


def _iso(dt):
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z") if dt else None


def _parse_iso(text):
    value = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class Scheduler:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db

    def view(self, row):
        return dict(row, enabled=bool(row["enabled"]))

    def get(self, wakeup_id):
        row = self.db.one("SELECT * FROM wakeups WHERE id = ?", (wakeup_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no wakeup {wakeup_id}")
        return self.view(row)

    def list(self, agent_id):
        return [self.view(r) for r in self.db.all("SELECT * FROM wakeups WHERE agent_id = ? ORDER BY next_run_at",
                                                  (agent_id,))]

    def _next(self, cron, at, tz, after):
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            raise self.hive.error(400, "bad_request", f"unknown timezone {tz!r}")
        if bool(cron) == bool(at):
            raise self.hive.error(400, "bad_request", "give exactly one of cron or at")
        try:
            if cron:
                return _iso(next_run(cron, after, tz))
            when = _parse_iso(at)
        except (CronError, ValueError) as exc:
            raise self.hive.error(400, "bad_request", str(exc))
        return _iso(when) if when > after else None

    def create(self, agent_id, cron=None, at=None, tz="UTC", text=""):
        self.hive.agent(agent_id)
        if not str(text).strip():
            raise self.hive.error(400, "bad_request", "text is required")
        tz = tz or "UTC"
        next_at = self._next(cron, at, tz, datetime.datetime.now(UTC))
        if next_at is None:
            raise self.hive.error(400, "bad_request", "that time is in the past")
        row = {"id": new_id("w"), "agent_id": agent_id, "cron": cron or None, "at": at or None, "tz": tz,
               "text": str(text).strip(), "enabled": 1, "next_run_at": next_at, "last_run_at": None,
               "created_at": now()}
        self.db.insert("wakeups", row)
        wakeup = self.get(row["id"])
        self.hive.events.publish("wakeup.updated", wakeup=wakeup)
        return wakeup

    def update(self, wakeup_id, changes):
        row = self.get(wakeup_id)
        merged = {k: changes.get(k, row[k]) for k in ("cron", "at", "tz", "text")}
        if "cron" in changes and changes["cron"]:
            merged["at"] = None
        if "at" in changes and changes["at"]:
            merged["cron"] = None
        values = dict(merged)
        values["enabled"] = 1 if changes.get("enabled", row["enabled"]) else 0
        values["next_run_at"] = self._next(merged["cron"], merged["at"], merged["tz"] or "UTC",
                                           datetime.datetime.now(UTC))
        self.db.update("wakeups", wakeup_id, values)
        wakeup = self.get(wakeup_id)
        self.hive.events.publish("wakeup.updated", wakeup=wakeup)
        return wakeup

    def delete(self, wakeup_id):
        self.get(wakeup_id)
        self.db.execute("DELETE FROM wakeups WHERE id = ?", (wakeup_id,))
        return {"ok": True}

    async def tick(self, at=None):
        """Fire every due wakeup; returns the ids fired."""
        moment = at or datetime.datetime.now(UTC)
        fired = []
        for row in self.db.all("SELECT * FROM wakeups WHERE enabled = 1 AND next_run_at IS NOT NULL "
                               "AND next_run_at <= ?", (_iso(moment),)):
            try:
                agent = self.hive.agent(row["agent_id"])
            except Exception:
                continue
            await self.hive.send_to_agent(agent["id"], f"[WAKE {row['id']}] {row['text']}", sender="hive:schedule",
                                          extra={"event": "wake", "wakeup_id": row["id"]})
            next_at = _iso(next_run(row["cron"], moment, row["tz"])) if row["cron"] else None
            self.db.update("wakeups", row["id"], {"last_run_at": _iso(moment), "next_run_at": next_at,
                                                  "enabled": 1 if next_at else 0})
            self.hive.events.publish("wakeup.fired", wakeup_id=row["id"], agent_id=agent["id"])
            self.hive.events.publish("wakeup.updated", wakeup=self.get(row["id"]))
            fired.append(row["id"])
        return fired
