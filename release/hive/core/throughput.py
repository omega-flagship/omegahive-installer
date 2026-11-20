"""How many messages minds may send each other: a throughput limit per mind and per swarm (the owner, 2026-11-11, in place
of "K mind turns, then wait for a person").

- A mind-to-mind message is one delivery from agent:A to agent:B (a post naming two minds counts twice), in any room or
  DM. Counted over the last hour.
- Each mind may send at most its limit per hour (its own, else the hive's default for minds): no mind becomes a spambot.
- Each swarm's minds together may send at most the swarm's limit per hour (its own, else the hive's default for swarms).
- Priority: once a swarm has used PRIORITY_FROM of its hour, the rest goes to minds further from their own limit: the
  fuller the swarm, the less of its own limit a mind may have used to still get through (all of it at PRIORITY_FROM, none
  at the swarm's limit).
- A mind whose spending headroom is gone (budgets.headroom_micros, every limit on it, its swarm's included) is not
  sent mind messages: each would cost a model call it cannot make. A mind on the free route costs no money: it is judged
  by the free calls left today instead (FreeGate, its person's and the hive's), never by money.
- Over a limit, a message is refused now, never queued (a late release would distort time); the hive says so in the room
  and tells the sender once per NOTICE_SECONDS, with when to try again.
"""

from __future__ import annotations

import datetime

from .config import is_free
from .db import now

DEFAULT_MIND = 20          # messages an hour a mind may send other minds, unless set
DEFAULT_SWARM = 100        # messages an hour a swarm's minds may send together, unless set
MAX_PER_HOUR = 10000
WINDOW = 3600
PRIORITY_FROM = 0.8
NOTICE_SECONDS = 900
SENDER = "hive:throughput"

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS throughput_limits (scope TEXT PRIMARY KEY, per_hour INTEGER NOT NULL)",
    """CREATE TABLE IF NOT EXISTS mind_sends (sender TEXT NOT NULL, target TEXT NOT NULL, swarm_id TEXT, room_id TEXT,
  created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS mind_sends_sender ON mind_sends(sender, created_at)",
    "CREATE INDEX IF NOT EXISTS mind_sends_swarm ON mind_sends(swarm_id, created_at)",
]


def _stamp(seconds_ago=0):
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds_ago)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _age(stamp):
    t = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()


def clean_limit(value, field="messages_per_hour"):
    """A limit as stored: a whole number 0..MAX_PER_HOUR, or None (inherit)."""
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_PER_HOUR:
        raise ValueError(f"{field} is a whole number from 0 to {MAX_PER_HOUR}, or null for the hive default")
    return value


class Throughput:
    def __init__(self, hive):
        self.hive = hive
        self._noticed = {}                 # sender agent id -> monotonic time of its last refusal notice
        for s in SCHEMA:
            hive.db.execute(s)

    # ---- limits ----------------------------------------------------------------------------------------------

    def _stored(self, scope):
        row = self.hive.db.one("SELECT per_hour FROM throughput_limits WHERE scope = ?", (scope,))
        return row["per_hour"] if row else None

    def _store(self, scope, value):
        if value is None:
            self.hive.db.execute("DELETE FROM throughput_limits WHERE scope = ?", (scope,))
        else:
            self.hive.db.execute("INSERT INTO throughput_limits VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET per_hour = excluded.per_hour",
                                 (scope, value))

    def defaults(self):
        mind, swarm = self._stored("hive:mind"), self._stored("hive:swarm")
        return {"mind": DEFAULT_MIND if mind is None else mind, "swarm": DEFAULT_SWARM if swarm is None else swarm}

    def set_defaults(self, data):
        for key in ("mind", "swarm"):
            if key in data:
                try:
                    self._store(f"hive:{key}", clean_limit(data[key], key))
                except ValueError as exc:
                    raise self.hive.error(400, "bad_request", str(exc))
        return self.view()

    def set_limit(self, scope, value):
        try:
            self._store(scope, clean_limit(value))
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc))

    def mind_limit(self, agent_id):
        own = self._stored(f"agent:{agent_id}")
        return self.defaults()["mind"] if own is None else own

    def swarm_limit(self, swarm_id):
        own = self._stored(f"swarm:{swarm_id}")
        return self.defaults()["swarm"] if own is None else own

    # ---- use ---------------------------------------------------------------------------------------------------

    def used(self, column, value):
        return self.hive.db.one(f"SELECT COUNT(*) AS n FROM mind_sends WHERE {column} = ? AND created_at > ?",
                                (value, _stamp(WINDOW)))["n"]

    def _next_free(self, column, value, limit):
        """Minutes until the window has room again under this limit."""
        if limit <= 0:
            return None
        rows = self.hive.db.all(f"SELECT created_at FROM mind_sends WHERE {column} = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?",
                                (value, _stamp(WINDOW), limit))
        if len(rows) < limit:
            return 0
        return max(1, int((WINDOW - _age(rows[-1]["created_at"])) // 60) + 1)

    def mind_view(self, agent_id):
        return {"messages_per_hour": self._stored(f"agent:{agent_id}"), "messages_per_hour_effective": self.mind_limit(agent_id),
                "messages_last_hour": self.used("sender", f"agent:{agent_id}")}

    def swarm_view(self, swarm_id):
        return {"messages_per_hour": self._stored(f"swarm:{swarm_id}"), "messages_per_hour_effective": self.swarm_limit(swarm_id),
                "messages_last_hour": self.used("swarm_id", swarm_id)}

    def view(self):
        return {"defaults": self.defaults(), "priority_from": PRIORITY_FROM, "window_seconds": WINDOW}

    # ---- admission ---------------------------------------------------------------------------------------------

    def _refusal(self, sender_id, swarm_id, target_id):
        """Why agent sender_id may not send one more message to target_id now (text, minutes to wait), or None."""
        me = f"agent:{sender_id}"
        mine, cap = self.used("sender", me), self.mind_limit(sender_id)
        if mine >= cap:
            return (f"it has sent its {cap} messages to minds this hour", self._next_free("sender", me, cap))
        if swarm_id:
            ours, scap = self.used("swarm_id", swarm_id), self.swarm_limit(swarm_id)
            if ours >= scap:
                return (f"its swarm has sent its {scap} mind messages this hour", self._next_free("swarm_id", swarm_id, scap))
            busy = scap * PRIORITY_FROM
            if ours >= busy and scap > busy:
                allowed = 1 - (ours - busy) / (scap - busy)         # 1 at PRIORITY_FROM, 0 at the swarm's limit
                if mine / cap > allowed:
                    return ("its swarm is near its hourly limit and minds that have sent less go first",
                            self._next_free("sender", me, max(1, int(cap * allowed))))
        target = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (target_id,))
        if target is not None and is_free(str(target.get("model") or "").partition("/")[0]):
            return self._free_refusal(target)
        if target is not None and self._paid(target):
            head = self.hive.budgets.headroom_micros(target)
            if head is not None and head <= 0:
                return (f"{target['name']} has no budget left to answer", None)
        return None

    def _paid(self, agent):
        """Whether the mind's model calls cost money (a local or mock model never runs out of budget, nor does the free
        route: the deploy's key, held to free calls a day)."""
        provider = self.hive.settings.providers.get(str(agent.get("model") or "").partition("/")[0])
        return provider is not None and not provider.local and provider.name != "mock" and not is_free(provider.name)

    def _free_refusal(self, target):
        """Why a mind on the free route can't answer a mind message now, or None: only its person's or the hive's free
        calls being used up today. A read (FreeGate.admit, dispatch=False): it counts no call. idle_guard=False: a
        delivery is not a call, and the mind's own wake call meets the idle guard itself. Any other refusal (the route
        off, the model dropped, no person) is the mind's own call's to say."""
        gate = getattr(getattr(self.hive, "gateway", None), "free_gate", None)   # set by app.py; a bare Hive has none
        if gate is None:
            return None
        from .gateway import GatewayError
        try:
            gate.admit(target, dispatch=False, idle_guard=False)
        except GatewayError as e:
            if e.code == "free_inference_daily_cap":
                return (f"{target['name']}'s person has used up today's free calls (they come back at midnight UTC)", None)
            if e.code == "free_inference_hive_daily_cap":
                return ("the hive has used up today's free calls (they come back at midnight UTC)", None)
        return None

    def admit(self, sender_id, targets, room_id=None):
        """Split targets (agent:<id> members) into (admitted, refused), recording each admitted one as sent now.
        refused: [(member, reason, minutes or None)]."""
        a = self.hive.db.one("SELECT swarm_id FROM agents WHERE id = ?", (sender_id,))
        swarm_id = a["swarm_id"] if a else None
        admitted, refused = [], []
        with self.hive.db.transaction():   # one admission at a time: two sends never both take the last slot
            for member in targets:
                why = self._refusal(sender_id, swarm_id, member[6:])
                if why:
                    refused.append((member, *why))
                    continue
                self.hive.db.execute("INSERT INTO mind_sends VALUES (?, ?, ?, ?, ?)", (f"agent:{sender_id}", member, swarm_id, room_id, now()))
                admitted.append(member)
        return admitted, refused

    def should_notice(self, sender_id):
        """Whether to tell the sender about a refusal now: once per NOTICE_SECONDS, so the notices never spam it."""
        import time
        t = time.monotonic()
        last = self._noticed.get(sender_id)
        if last is not None and t - last < NOTICE_SECONDS:
            return False
        self._noticed[sender_id] = t
        return True
