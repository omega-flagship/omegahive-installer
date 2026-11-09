"""G2: person notices with a hive-enforced daily budget.

A mind in a person's OWN space (their P2 app swarm, or their P14 app context: swarm owner == mind owner == that person)
may post a short plain-text notice to that person. Nobody else can: minds in other swarms, apps and other people have no
route to it. The person sets a daily pop-up cap and quiet hours. Over the cap, or in quiet hours, a notice is HELD and
later delivered inside one digest; it is never dropped. A refusal (size, rate, sender) is an answer to the mind, never a
silent loss. Self-set reminders (the host's own wake-up notices) do not count against the cap.

Urgent is a fixed class of four home-safety kinds that may break through quiet hours and the cap. It is accepted only
with a host-verified home-link event; there is no home link yet, so `home_link_verified` answers False and every urgent
notice is refused. Content is stored and served as plain text, never markup.
"""
from __future__ import annotations

import collections
import datetime
import re
import threading
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import new_id, now
from .program_actions import named_person

UTC = datetime.timezone.utc
MAX_BYTES = 500
CAPS = (0, 1, 3, 5, 8)                    # Surface's design; Jon: default 3 a day
DEFAULT_CAP = 3
DEFAULT_QUIET = ("21:00", "07:00")        # local time
URGENT_KINDS = ("smoke_co", "water_leak", "door_open_night", "security_alarm")   # Jon: fixed; nothing else breaks through
MIND_PER_HOUR = 20                        # per sending mind, accepted or held
PERSON_PER_DAY = 200                      # per person per local day, all their minds together
HELD_MAX = 500                            # beyond this a mind is refused (it learns), nothing already held is lost
LIST_MAX = 100
FRAME_BYTES = 6144                        # one P1 op answer stays under app_ask.MAX_BYTES
HHMM = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS notice_prefs (
  principal TEXT PRIMARY KEY, cap INTEGER NOT NULL, quiet_start TEXT, quiet_end TEXT, tz TEXT NOT NULL,
  updated_at TEXT NOT NULL)""",
    # state: delivered | held | digested (a held notice delivered inside digest_id); kind: notice | reminder | digest.
    # delivery: the order things actually reached the person, assigned when delivered or released (NULL while held).
    # Every cursor (the person's and a frame's) reads delivery, never seq, so a release is never behind a cursor.
    """CREATE TABLE IF NOT EXISTS notices (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, agent_id TEXT,
  swarm_id TEXT, kind TEXT NOT NULL, urgent TEXT, text TEXT NOT NULL, counted INTEGER NOT NULL, state TEXT NOT NULL,
  held_reason TEXT, day TEXT NOT NULL, digest_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, delivery INTEGER)""",
    "CREATE INDEX IF NOT EXISTS notices_person ON notices (principal, state, seq)",
)


class Notices:
    def __init__(self, hive, clock=None):
        self.hive, self.db = hive, hive.db
        self.clock = clock or (lambda: datetime.datetime.now(UTC))
        for statement in SCHEMA:
            hive.db.execute(statement)
        self.migrate(hive.db)
        self._lock = threading.Lock()
        self._sent = {}                   # agent_id -> deque of post times within the last hour (process-local)

    @staticmethod
    def migrate(db):
        """The delivery column, its index and the backfill, in one transaction: an interrupted start leaves either
        nothing or all of it. Every start also recovers any delivered or digested row still without a delivery number
        (a partial earlier migration), numbering them after the current ones in posting order, so no delivered
        notice is ever hidden from a cursor."""
        with db.transaction():
            if "delivery" not in {c["name"] for c in db.all("PRAGMA table_info(notices)")}:
                db.execute("ALTER TABLE notices ADD COLUMN delivery INTEGER")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS notices_delivery ON notices (delivery)")
            top = db.one("SELECT COALESCE(MAX(delivery), 0) AS n FROM notices")["n"]
            for i, r in enumerate(db.all("SELECT seq FROM notices WHERE state != 'held' AND delivery IS NULL "
                                         "ORDER BY seq"), 1):
                db.execute("UPDATE notices SET delivery = ? WHERE seq = ?", (top + i, r["seq"]))

    def _error(self, status, code, message):
        return self.hive.error(status, code, message)

    # ---- the person and their settings -----------------------------------------------------------------------------

    def require_person(self, principal):
        """A current, enabled, named member or admin: only a person has notices or sets their budget."""
        row = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (str(principal)[5:],)) \
            if named_person(principal) and str(principal).startswith("user:u_") else None
        if row is None or row["disabled"] or row["role"] not in ("admin", "member"):
            raise self._error(403, "person_required", "only a signed-in person has notices")
        return principal

    def prefs(self, principal):
        row = self.db.one("SELECT * FROM notice_prefs WHERE principal = ?", (principal,))
        if row is None:
            return {"cap": DEFAULT_CAP, "quiet_start": DEFAULT_QUIET[0], "quiet_end": DEFAULT_QUIET[1], "tz": "UTC",
                    "caps": list(CAPS), "urgent_kinds": list(URGENT_KINDS)}
        return {"cap": row["cap"], "quiet_start": row["quiet_start"], "quiet_end": row["quiet_end"], "tz": row["tz"],
                "caps": list(CAPS), "urgent_kinds": list(URGENT_KINDS)}

    def set_prefs(self, principal, data):
        """Person-only. Each field is optional; quiet hours are both times or both null (off)."""
        self.require_person(principal)
        if not isinstance(data, dict) or set(data) - {"cap", "quiet_start", "quiet_end", "tz"}:
            raise self._error(400, "bad_request", "notice settings are cap, quiet_start, quiet_end and tz")
        current = self.prefs(principal)
        merged = {k: data.get(k, current[k]) for k in ("cap", "quiet_start", "quiet_end", "tz")}
        if type(merged["cap"]) is not int or merged["cap"] not in CAPS:
            raise self._error(400, "bad_request", f"cap is one of {', '.join(map(str, CAPS))}")
        quiet = (merged["quiet_start"], merged["quiet_end"])
        if quiet != (None, None) and not all(isinstance(t, str) and HHMM.fullmatch(t) for t in quiet):
            raise self._error(400, "bad_request", "quiet hours are two HH:MM times, or both null for none")
        try:
            ZoneInfo(str(merged["tz"]))
        except (ZoneInfoNotFoundError, ValueError):
            raise self._error(400, "bad_request", "tz is an IANA time zone such as Europe/London") from None
        with self.db.transaction():
            self.db.execute("INSERT INTO notice_prefs (principal, cap, quiet_start, quiet_end, tz, updated_at) "
                            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET cap = excluded.cap, "
                            "quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, tz = excluded.tz, "
                            "updated_at = excluded.updated_at",
                            (principal, merged["cap"], quiet[0], quiet[1], merged["tz"], now()))
        if merged["cap"] > current["cap"]:
            self.release(principal)   # a wider cap may let today's cap holds go now, but only those that now fit
        return self.prefs(principal)

    def _local(self, principal, moment=None):
        p = self.prefs(principal)
        return (moment or self.clock()).astimezone(ZoneInfo(p["tz"])), p

    @staticmethod
    def quiet(p, local):
        start, end = p["quiet_start"], p["quiet_end"]
        if not start or not end or start == end:
            return False
        t = local.strftime("%H:%M")
        return start <= t < end if start < end else (t >= start or t < end)

    # ---- who may post ----------------------------------------------------------------------------------------------

    def _owner_of(self, agent):
        """The person whose own space this mind is in, or a refusal. Only a P2 app swarm or a P14 app context counts:
        the swarm, the mind and the binding must all name the same enabled person, and the space must be private."""
        refused = self._error(403, "not_your_person", "this mind can only send notices to the person whose own space it is in")
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (agent.get("swarm_id"),)) if agent.get("swarm_id") else None
        principal = agent.get("owner")
        if swarm is None or swarm.get("archived_at") or swarm.get("owner") != principal or not named_person(principal) \
                or swarm.get("visibility") != "private":
            raise refused
        bound = self.db.one("SELECT 1 FROM app_person_contexts WHERE swarm_id = ? AND principal = ?",
                            (swarm["id"], principal)) or \
            self.db.one("SELECT 1 FROM app_person_swarms WHERE swarm_id = ? AND principal = ?", (swarm["id"], principal))
        if not bound:
            raise refused
        try:
            self.require_person(principal)
        except Exception:
            raise refused from None
        return principal, swarm["id"]

    def home_link_verified(self, agent, kind, event):
        """The host-side allowlist hook for urgent notices: True only for a home-link event the host itself verified
        (its event type is one of URGENT_KINDS and it came from a home link this person attached). There is no home
        link yet, so nothing is verified and urgent is unavailable."""
        return False

    def _text(self, value):
        if not isinstance(value, str) or not value.strip():
            raise self._error(400, "bad_request", "text is required")
        text = value.strip()
        if len(text.encode("utf-8")) > MAX_BYTES:
            raise self._error(413, "too_large", f"a notice is at most {MAX_BYTES} bytes")
        if CONTROL.search(text):
            raise self._error(400, "bad_request", "a notice is plain text")
        return text

    def _rate(self, agent_id, moment):
        sent = self._sent.setdefault(agent_id, collections.deque())
        while sent and (moment - sent[0]).total_seconds() > 3600:
            sent.popleft()
        if len(sent) >= MIND_PER_HOUR:
            raise self._error(429, "rate_limited", f"a mind may send at most {MIND_PER_HOUR} notices an hour")
        sent.append(moment)

    # ---- posting ---------------------------------------------------------------------------------------------------

    def post(self, agent, data):
        """A mind's notice to its own person. Answers delivered or held (with why); refusals raise."""
        if not isinstance(data, dict) or "text" not in data or set(data) - {"text", "urgent"}:
            raise self._error(400, "bad_request", "a notice is {text} with an optional urgent")
        text = self._text(data["text"])
        principal, swarm_id = self._owner_of(agent)
        if "urgent" in data:
            u = data["urgent"]
            if not isinstance(u, dict) or set(u) != {"kind", "event"} or u["kind"] not in URGENT_KINDS \
                    or not isinstance(u["event"], str) or not 0 < len(u["event"]) <= 120:
                raise self._error(400, "bad_request", f"urgent is {{kind, event}}, kind one of {', '.join(URGENT_KINDS)}")
            if not self.home_link_verified(agent, u["kind"], u["event"]):
                raise self._error(403, "urgent_unavailable",
                                  "urgent notices need a verified home-link event; this hive has none")
            return self._post(principal, agent["id"], swarm_id, "notice", text, counted=False, urgent=u["kind"])
        return self._post(principal, agent["id"], swarm_id, "notice", text, counted=True)

    def reminder(self, agent_id, text):
        """Host-internal (G1 on_fire: notice): a person's own wake-up text, sent to that mind's owner. Not counted
        against the cap; still held in quiet hours. No route reaches this: a mind cannot claim to be a reminder."""
        agent = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if agent is None or not named_person(agent.get("owner")):
            raise self._error(404, "not_found", "no such mind")
        principal = self.require_person(agent["owner"])
        return self._post(principal, agent_id, agent.get("swarm_id"), "reminder", self._text(text), counted=False)

    def _post(self, principal, agent_id, swarm_id, kind, text, counted, urgent=None):
        with self._lock, self.db.transaction():
            digest = self._release(principal)   # yesterday's waiting digest reaches the person before today's notice
            moment = self.clock()
            local, p = self._local(principal, moment)
            day = local.date().isoformat()
            if not urgent and self.db.one("SELECT COUNT(*) AS n FROM notices WHERE principal = ? AND day = ? AND "
                                          "kind != 'digest'", (principal, day))["n"] >= PERSON_PER_DAY:
                raise self._error(429, "rate_limited", f"at most {PERSON_PER_DAY} notices a day reach one person")
            if not urgent and self.db.one("SELECT COUNT(*) AS n FROM notices WHERE principal = ? AND state = 'held'",
                                          (principal,))["n"] >= HELD_MAX:
                raise self._error(429, "rate_limited", "this person has too many notices waiting; try again later")
            if agent_id:
                self._rate(agent_id, moment)
            reason = None
            if urgent:
                pass   # a verified safety alert breaks through quiet hours and the cap; it uses no pop-up
            elif self.quiet(p, local):
                reason = "quiet"
            elif counted and self._delivered_today(principal, day) >= p["cap"]:
                reason = "cap"
            row = {"id": new_id("n"), "principal": principal, "agent_id": agent_id, "swarm_id": swarm_id, "kind": kind,
                   "urgent": urgent, "text": text, "counted": int(counted), "state": "held" if reason else "delivered",
                   "held_reason": reason, "day": day, "digest_id": None, "created_at": now(),
                   "delivered_at": None if reason else now(), "delivery": None if reason else self._next()}
            self.db.insert("notices", row)
        if digest:
            self._publish(principal, self.get(principal, digest))
        self._publish(principal, self.get(principal, row["id"]) if not reason else None)
        return {"id": row["id"], "state": row["state"], **({"held": reason} if reason else {})}

    def _next(self):
        """The next delivery number. Called only under self._lock inside the write transaction."""
        return self.db.one("SELECT COALESCE(MAX(delivery), 0) + 1 AS n FROM notices")["n"]

    def _delivered_today(self, principal, day):
        """Pop-ups used today: counted notices delivered on their own, plus today's cap holds released early because a
        raised cap let them fit (a digest of quiet or earlier holds, and reminders, are free)."""
        return self.db.one("SELECT COUNT(*) AS n FROM notices WHERE principal = ? AND day = ? AND counted = 1 AND "
                           "(state = 'delivered' OR (state = 'digested' AND held_reason = 'cap'))", (principal, day))["n"]

    def _publish(self, principal, notice):
        # Person-only live frame (visibility.event_visible): the person's own, admins included, never anyone else.
        waiting = self.db.one("SELECT COUNT(*) AS n FROM notices WHERE principal = ? AND state = 'held'", (principal,))["n"]
        self.hive.events.publish("notice", principal=principal, notice=notice, waiting=waiting)

    # ---- held -> one digest ----------------------------------------------------------------------------------------

    def release(self, principal, force=False):
        """Fold everything waiting into one digest. Without force it goes outside quiet hours, once something waited
        through quiet hours or since an earlier day (a cap hold waits for the next day). force: the person asked."""
        with self._lock, self.db.transaction():
            digest = self._release(principal, force)
        if digest is None:
            return None
        notice = self.get(principal, digest)
        self._publish(principal, notice)
        return notice

    def _release(self, principal, force=False):
        """Under self._lock in a write transaction: the digest's id, or None. Each released notice gets its delivery
        number now, in the order it was posted, and the digest the next one, so every cursor sees them after it."""
        held = self.db.all("SELECT * FROM notices WHERE principal = ? AND state = 'held' ORDER BY seq", (principal,))
        if not held:
            return None
        local, p = self._local(principal)
        day = local.date().isoformat()
        if not force:
            if self.quiet(p, local):
                return None
            # Quiet holds and earlier days are due now. Today's cap holds wait for tomorrow, unless all of them now fit
            # under the person's current cap (they raised it); then they count against today's cap like any pop-up.
            today = [r for r in held if r["held_reason"] == "cap" and r["day"] == day]
            if today and self._delivered_today(principal, day) + len(today) > p["cap"]:
                held = [r for r in held if r not in today]
            if not held:
                return None
        digest_id, stamp = new_id("n"), now()
        for r in held:
            # pulled by the person ("show them now"), a held notice is not an interruption: it uses none of today's cap
            self.db.execute("UPDATE notices SET state = 'digested', digest_id = ?, delivered_at = ?, delivery = ?, "
                            "counted = counted * ? WHERE seq = ?", (digest_id, stamp, self._next(), 0 if force else 1,
                                                                    r["seq"]))
        self.db.insert("notices", {"id": digest_id, "principal": principal, "agent_id": None, "swarm_id": None,
                                   "kind": "digest", "urgent": None,
                                   "text": f"{len(held)} {'thing' if len(held) == 1 else 'things'} waited for you.",
                                   "counted": 0, "state": "delivered", "held_reason": None, "day": day,
                                   "digest_id": None, "created_at": stamp, "delivered_at": stamp,
                                   "delivery": self._next()})
        return digest_id

    def sweep(self):
        """Reconcile pass: let each person's waiting digest go when its time has come."""
        for row in self.db.all("SELECT DISTINCT principal FROM notices WHERE state = 'held'"):
            try:
                self.release(row["principal"])
            except Exception:   # noqa: BLE001  (one person's bad settings never stop the others)
                continue

    # ---- reads -----------------------------------------------------------------------------------------------------

    def _names(self, rows):
        ids = sorted({r["agent_id"] for r in rows if r["agent_id"]})
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        return {a["id"]: a["name"] for a in self.db.all(f"SELECT id, name FROM agents WHERE id IN ({marks})", ids)}

    def _view(self, r, names, items=None):
        out = {"id": r["id"], "seq": r["delivery"], "kind": r["kind"], "text": r["text"], "agent_id": r["agent_id"],
               "from": names.get(r["agent_id"]) if r["agent_id"] else None, "at": r["delivered_at"] or r["created_at"],
               "posted_at": r["created_at"], "state": r["state"], "urgent": r["urgent"]}
        if items is not None:
            out["items"] = items
        return out

    def get(self, principal, notice_id):
        r = self.db.one("SELECT * FROM notices WHERE id = ? AND principal = ?", (notice_id, principal))
        if r is None:
            return None
        items = self.db.all("SELECT * FROM notices WHERE digest_id = ? ORDER BY delivery", (r["id"],)) if r["kind"] == "digest" else None
        names = self._names([r] + (items or []))
        return self._view(r, names, [self._view(i, names) for i in items] if items is not None else None)

    def list(self, principal, after=0, limit=50):
        """The person's own delivered notices and digests, newest delivery first, after a delivery cursor; held ones are
        counted, not shown (they arrive later inside a digest, which always has a newer delivery number)."""
        self.require_person(principal)
        self.release(principal)
        limit = max(1, min(int(limit), LIST_MAX))
        rows = self.db.all("SELECT * FROM notices WHERE principal = ? AND state = 'delivered' AND delivery > ? "
                           "ORDER BY delivery DESC LIMIT ?", (principal, int(after), limit))
        waiting = self.db.one("SELECT COUNT(*) AS n FROM notices WHERE principal = ? AND state = 'held'", (principal,))["n"]
        return {"notices": [self.get(principal, r["id"]) for r in rows], "waiting": waiting,
                "prefs": self.prefs(principal)}

    def app_spaces(self, principal, program_id):
        """An app's own context for this person: its P14 context (only while that binding still stands) and any P2
        app swarm of theirs for it. Never the person's Ask preference or any other swarm."""
        spaces = []
        apps = getattr(self.hive, "person_apps", None)
        if apps is not None and apps.is_person_app(program_id):
            try:
                spaces.append(apps.frame_swarm(principal, program_id))
            except Exception:   # noqa: BLE001  (no usable context: nothing of it is shown)
                pass
        spaces += [r["swarm_id"] for r in self.db.all("SELECT swarm_id FROM app_person_swarms WHERE principal = ? AND "
                                                     "program_id = ?", (principal, program_id))]
        owned = []
        for swarm_id in dict.fromkeys(s for s in spaces if s):
            row = self.db.one("SELECT owner FROM swarms WHERE id = ?", (swarm_id,))
            if row is not None and row["owner"] == principal:
                owned.append(swarm_id)
        return owned

    def frame_read(self, principal, program_id, after=0):
        """P1 frame op: this person's notices from this app's own context only, in delivery order after the cursor,
        bounded to one op answer. A released notice comes with its digest_id; the digest itself is shown scoped to this
        context (its count and items from here only), after its items. Held ones appear once they are released."""
        spaces = self.app_spaces(principal, program_id)
        if not spaces:
            return {"notices": [], "cursor": int(after), "more": False}
        marks = ",".join("?" * len(spaces))
        rows = self.db.all(f"SELECT * FROM notices WHERE principal = ? AND delivery > ? AND ("
                           f"(state IN ('delivered', 'digested') AND swarm_id IN ({marks})) OR "
                           f"(kind = 'digest' AND id IN (SELECT digest_id FROM notices WHERE principal = ? AND "
                           f"swarm_id IN ({marks})))) ORDER BY delivery LIMIT 20",
                           (principal, int(after), *spaces, principal, *spaces))
        names, out, size, cursor = self._names(rows), [], 0, int(after)
        for r in rows:
            v = {k: x for k, x in self._view(r, names).items() if k != "agent_id"}
            if r["kind"] == "digest":
                n = self.db.one(f"SELECT COUNT(*) AS n FROM notices WHERE digest_id = ? AND swarm_id IN ({marks})",
                                (r["id"], *spaces))["n"]
                v["text"] = f"{n} {'thing' if n == 1 else 'things'} waited for you."
            else:
                v["digest_id"] = r["digest_id"]
            size += len(v["text"].encode("utf-8")) * 2 + 240
            if out and size > FRAME_BYTES:
                break   # the first row always goes (a notice is at most MAX_BYTES), so the cursor always moves
            out.append(v)
            cursor = r["delivery"]
        more = len(out) < len(rows) or len(rows) == 20
        return {"notices": out, "cursor": cursor, "more": more and cursor != int(after)}
