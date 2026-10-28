"""G4: a person's own daily spend, read from the existing usage rows. No new money logic.

A usage row's payer is who the call was billed to (hive.record_usage). This read takes only rows whose payer is the
caller, groups them by day in the person's time zone (their notice settings' tz, UTC until set), and splits each day by
own keys vs hive-paid, by mind and by app context (a P14 context or P2 app swarm of theirs; anything else is "other").
It never takes a principal from the request, so nobody reads another person's spend here; admins keep their existing
views (/api/usage, budgets).
"""
from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

UTC = datetime.timezone.utc
MAX_DAYS = 31


def _iso(moment):
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class MeSpend:
    def __init__(self, hive, clock=None):
        self.hive, self.db = hive, hive.db
        self.clock = clock or (lambda: datetime.datetime.now(UTC))

    def days(self, value):
        try:
            days = int(value) if value is not None else 7
        except (TypeError, ValueError):
            days = 0
        if not 1 <= days <= MAX_DAYS:
            raise self.hive.error(400, "bad_request", f"days is 1 to {MAX_DAYS}")
        return days

    def _apps(self, principal):
        """swarm id -> app id, for this person's own app spaces only."""
        out = {}
        for r in self.db.all("SELECT swarm_id, program_id FROM app_person_swarms WHERE principal = ?", (principal,)):
            out[r["swarm_id"]] = r["program_id"]
        for r in self.db.all("SELECT swarm_id, program_id FROM app_person_contexts WHERE principal = ?", (principal,)):
            out[r["swarm_id"]] = r["program_id"]
        return out

    def read(self, principal, days=7, swarms=None):
        """Per local day, oldest first, every day present (zero days included). swarms narrows to one app's own
        context (the frame read); the per-app split is then left out."""
        tz = self.hive.notices.prefs(principal)["tz"] if getattr(self.hive, "notices", None) else "UTC"
        zone = ZoneInfo(tz)
        today = self.clock().astimezone(zone).date()
        first = today - datetime.timedelta(days=days - 1)
        start = datetime.datetime.combine(first, datetime.time(0), tzinfo=zone)
        sql = ("SELECT u.agent_id, a.name, u.key_id, u.swarm_id, u.cost_usd, u.created_at FROM usage u "
               "LEFT JOIN agents a ON a.id = u.agent_id WHERE u.payer = ? AND u.created_at >= ?")
        params = [principal, _iso(start)]
        if swarms is not None:
            sql += f" AND u.swarm_id IN ({','.join('?' * len(swarms)) or 'NULL'})"
            params += list(swarms)
        rows = self.db.all(sql, params)
        own = self.hive.own_key_ids(principal)
        apps = self._apps(principal)
        by_day = {(first + datetime.timedelta(days=i)).isoformat(): {"own_keys_usd": 0.0, "hive_paid_usd": 0.0,
                                                                     "minds": {}, "apps": {}}
                  for i in range(days)}
        for r in rows:
            try:
                stamp = datetime.datetime.fromisoformat(str(r["created_at"]).replace("Z", "+00:00"))
            except ValueError:
                continue
            day = by_day.get((stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)).astimezone(zone).date().isoformat())
            if day is None:
                continue
            cost = float(r["cost_usd"] or 0)
            day["own_keys_usd" if r["key_id"] in own else "hive_paid_usd"] += cost
            m = day["minds"].setdefault(r["agent_id"], {"agent_id": r["agent_id"], "name": r["name"] or r["agent_id"],
                                                        "cost_usd": 0.0})
            m["cost_usd"] += cost
            app = apps.get(r["swarm_id"], "other")
            day["apps"][app] = day["apps"].get(app, 0.0) + cost
        out = []
        for date, d in by_day.items():
            entry = {"date": date, "total_usd": round(d["own_keys_usd"] + d["hive_paid_usd"], 6),
                     "own_keys_usd": round(d["own_keys_usd"], 6), "hive_paid_usd": round(d["hive_paid_usd"], 6),
                     "by_mind": sorted(({**m, "cost_usd": round(m["cost_usd"], 6)} for m in d["minds"].values()),
                                       key=lambda m: -m["cost_usd"])}
            if swarms is None:
                entry["by_app"] = {k: round(v, 6) for k, v in sorted(d["apps"].items())}
            out.append(entry)
        return {"principal": principal, "tz": tz, "days": out,
                "total_usd": round(sum(d["total_usd"] for d in out), 6)}

    def frame_read(self, principal, program_id, days=7):
        """P1 frame op: this person's own totals per day and this app's share; no minds or other apps named."""
        whole = self.read(principal, days)
        here = self.read(principal, days, self.hive.notices.app_spaces(principal, program_id))
        return {"tz": whole["tz"], "days": [{"date": d["date"], "total_usd": d["total_usd"],
                                             "this_app_usd": here["days"][i]["total_usd"]}
                                            for i, d in enumerate(whole["days"])],
                "total_usd": whole["total_usd"], "this_app_usd": here["total_usd"]}
