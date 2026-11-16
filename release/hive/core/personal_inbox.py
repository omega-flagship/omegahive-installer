"""Held copies for a person's browser memory (personal minds P1 item 4; Jon, 2026-10-08: "the memory lives in the browser").

When a swarm's coordinator answers a person's Ask turn (the ordinary, non-conductor path: Ask.reply -> Ask._close with an
answer), a copy of that exchange (the person's words and the final answer) is held here for that person only, until
their browser collects it into its local memory and acknowledges it; then it is deleted. It is the person's own data:
- not a hive message, not in any mind's history, traces, rooms or memory; no event is published; the personal mind is
  not woken, takes no turn and no model is called;
- read and acknowledged only by its person (GET /api/me/mind/inbox, POST /api/me/mind/inbox/ack); there is no admin
  read of the content (Jon's transparency ruling allows metadata only, and no admin view of this exists to extend);
- never for a private app or swarm (the page's {private: true}, or conductor.names_private on the program, route,
  swarm names, or a swarm that is a private app's home); never for an exchange with the person's own personal mind;
- one per turn; each at most ITEM_BYTES (truncated, flagged); per person at most MAX_ITEMS and MAX_BYTES, the oldest
  dropped first and counted; gone after EXPIRY_DAYS, swept on every write and read and by the reconcile loop.
- stored in its own database file (personal_inbox.db, beside hive.db) with secure_delete on: a deleted item leaves no
  freed cell, moved page or WAL frame behind (Database.erase); the payload is never logged.
The Ask thread's own record of the exchange (ask_turns, its room, its frames, the coordinator's delivery) is the Ask's,
not this copy's: it follows the Ask's own rules (the person's thread delete), unchanged here.
A swarm's own opt-out is a follow-up (swarms have no options mechanism yet).
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import secrets

from .db import Database, now

log = logging.getLogger("hive")

MAX_ITEMS = 200
MAX_BYTES = 2 * 1024 * 1024
ITEM_BYTES = 16 * 1024
WORDS_BYTES = 4 * 1024          # the person's words keep at most this much of an item; the answer has the rest
EXPIRY_DAYS = 7
PAGE = 50
DB_NAME = "personal_inbox.db"
MAX_ACK = 200

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS personal_inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  principal TEXT NOT NULL, mind_id TEXT NOT NULL, turn_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL, payload TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0)""",
    "CREATE INDEX IF NOT EXISTS personal_inbox_principal ON personal_inbox(principal, seq)",
    # what the bounds removed before the browser collected it, per person (counts only, never content)
    """CREATE TABLE IF NOT EXISTS personal_inbox_dropped (principal TEXT PRIMARY KEY, dropped INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""",
]


def _escaped(ch):
    """The UTF-8 bytes one character takes inside the stored JSON string (escapes included: U+0001 is 6)."""
    return len(json.dumps(ch, ensure_ascii=False).encode("utf-8")) - 2


def _cut(text, limit):
    """(the longest prefix of text whose JSON-escaped UTF-8 size is at most `limit`, whether it was cut). One pass over
    the characters: it always ends, whatever the text (stand-in P1 High 2: a cut by raw bytes never shrank escapes)."""
    text, size = str(text), 0
    for i, ch in enumerate(text):
        size += _escaped(ch)
        if size > limit:
            return text[:i], True
    return text, False


def _size(words, answer):
    return len(json.dumps({"words": words, "answer": answer}, ensure_ascii=False).encode("utf-8"))


ENVELOPE = _size("", "")   # the payload's fixed part: {"words": "", "answer": ""}


def fit(words, answer):
    """(words, answer, truncated) whose stored payload is at most ITEM_BYTES: the words take at most WORDS_BYTES of it
    (escaped), the answer the rest. Each is cut once, by its escaped size, so the result fits by construction."""
    words, cut_w = _cut(words, WORDS_BYTES)
    answer, cut_a = _cut(answer, ITEM_BYTES - _size(words, ""))
    return words, answer, cut_w or cut_a


class PersonalInbox:
    def __init__(self, hive):
        self.hive = hive
        # its own database file in the hive's (locked) data directory, with secure_delete on for every statement: a held
        # copy is the person's data until their browser collects it, and once deleted (ack, expiry, bound) no freed
        # cell, moved page or WAL frame keeps it (Database.erase truncates the WAL after each erase). Stand-in P1 High 1.
        self.db = Database(hive.settings.data_dir / DB_NAME, hive_schema=False)
        self.db.execute("PRAGMA secure_delete = ON")
        for s in SCHEMA:
            self.db.execute(s)

    # ---- the fence -------------------------------------------------------------------------------------------------

    def _private_homes(self):
        """Swarms that are a private app's home (HIVE_APP_HOMES, activations, where it was opened)."""
        from .conductor import names_private
        homes = set()
        try:
            configured = json.loads(os.environ.get("HIVE_APP_HOMES", "") or "{}")
        except ValueError:
            configured = {}
        for program, swarms in (configured.items() if isinstance(configured, dict) else []):
            if names_private(program) and isinstance(swarms, list):
                homes.update(str(s) for s in swarms)
        for sql in ("SELECT program, swarm FROM app_activations WHERE active = 1", "SELECT program, swarm FROM program_homes"):
            try:
                homes.update(r["swarm"] for r in self.hive.db.all(sql) if names_private(r["program"]))
            except Exception:   # noqa: BLE001  a hive without that table has no such homes
                pass
        return homes

    def private(self, turn):
        """Whether this turn's exchange belongs to a private app or swarm (then it is never copied). Fails closed."""
        from .conductor import names_private
        try:
            context = json.loads(turn.get("context_resolved") or "{}") or {}
        except ValueError:
            return True
        if not isinstance(context, dict) or context.get("private"):
            return True
        program = context.get("program") or {}
        values = [context.get("route"), program.get("id"), program.get("name")]
        for key in ("swarm", "page_swarm", "addressed"):
            if isinstance(context.get(key), dict):
                values.append(context[key].get("name"))
        view = context.get("view") if isinstance(context.get("view"), dict) else {}
        for ref in [*(context.get("selection") or []), *(view.get("refs") or [])]:   # resolved refs: ids and names
            if isinstance(ref, dict):
                values += [ref.get("id"), ref.get("name")]
        values += [a for a in view.get("acts") or [] if isinstance(a, str)]
        swarm = self.hive.db.one("SELECT id, name FROM swarms WHERE id = ?", (turn.get("swarm_id"),))
        if swarm is None:
            return True
        values.append(swarm["name"])
        if any(names_private(v) for v in values if v):
            return True
        return swarm["id"] in self._private_homes()

    # ---- writing: from Ask.reply only --------------------------------------------------------------------------------

    def hold(self, turn, answer_text):
        """Hold a copy of one answered, non-conductor turn for its person. Returns the item id, or None (not copied).
        Never wakes a mind, sends nothing, calls no model and publishes nothing."""
        hive = self.hive
        if turn.get("conductor_model"):
            return None
        principal = turn.get("principal")
        mind = hive.personal.mind_row(principal) if hive.personal.person(principal) else None
        if mind is None or mind["id"] == turn.get("mind_id") or mind["swarm_id"] == turn.get("swarm_id"):
            return None   # no personal mind, or the exchange was with it: nothing to hold
        if self.private(turn):
            return None
        words, answer, truncated = fit(turn.get("text") or "", answer_text or "")
        payload = json.dumps({"words": words, "answer": answer}, ensure_ascii=False)
        item_id = "pi_" + secrets.token_hex(10)
        with self.db.transaction():
            self._sweep()
            cur = self.db.execute("INSERT OR IGNORE INTO personal_inbox (id, principal, mind_id, turn_id, created_at, bytes, "
                                  "payload, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                  (item_id, principal, mind["id"], turn["id"], now(), len(payload.encode("utf-8")), payload,
                                   1 if truncated else 0))
            if cur.rowcount != 1:
                return None   # this turn is already held (one per turn)
            self._bound(principal)
        return item_id

    def _bound(self, principal):
        """Over MAX_ITEMS or MAX_BYTES for this person: the oldest go first, counted."""
        db, dropped = self.db, 0
        while True:
            row = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM personal_inbox WHERE principal = ?", (principal,))
            if row["n"] <= MAX_ITEMS and row["b"] <= MAX_BYTES:
                break
            db.erase("DELETE FROM personal_inbox WHERE seq = (SELECT MIN(seq) FROM personal_inbox WHERE principal = ?)", (principal,))
            dropped += 1
        if dropped:
            self._count(principal, "dropped", dropped)

    def _count(self, principal, column, n):
        self.db.execute(f"INSERT INTO personal_inbox_dropped (principal, {column}, updated_at) VALUES (?, ?, ?) "
                             f"ON CONFLICT(principal) DO UPDATE SET {column} = {column} + excluded.{column}, "
                             "updated_at = excluded.updated_at", (principal, n, now()))

    def _sweep(self, moment=None):
        """Items older than EXPIRY_DAYS are deleted, and counted per person. Returns how many."""
        moment = moment or datetime.datetime.now(datetime.timezone.utc)
        cutoff = (moment - datetime.timedelta(days=EXPIRY_DAYS)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        db = self.db
        with db.transaction():
            rows = db.all("SELECT principal, COUNT(*) AS n FROM personal_inbox WHERE created_at < ? GROUP BY principal", (cutoff,))
            if not rows:
                return 0
            db.erase("DELETE FROM personal_inbox WHERE created_at < ?", (cutoff,))
            for r in rows:
                self._count(r["principal"], "expired", r["n"])
        return sum(r["n"] for r in rows)

    def sweep(self, moment=None):
        try:
            return self._sweep(moment)
        except Exception:   # noqa: BLE001
            log.exception("personal inbox sweep failed")
            return 0

    # ---- the person's own routes -----------------------------------------------------------------------------------------

    def _person(self, viewer):
        if self.hive.personal.person(viewer.principal) is None:
            raise self.hive.personal._refuse(403, "person_required")
        return viewer.principal

    def items(self, viewer, after=None, limit=PAGE):
        """GET /api/me/mind/inbox: the caller's own held copies, oldest first."""
        principal = self._person(viewer)
        self.sweep()
        try:
            limit = max(1, min(PAGE, int(limit)))
        except (TypeError, ValueError):
            raise self.hive.personal._refuse(400, "invalid") from None
        floor = 0
        if after:
            mark = self.db.one("SELECT seq FROM personal_inbox WHERE id = ? AND principal = ?", (str(after), principal))
            if mark is None:   # collected meanwhile (or never the caller's): by the opaque id's order, start at the beginning
                floor = 0
            else:
                floor = mark["seq"]
        rows = self.db.all("SELECT * FROM personal_inbox WHERE principal = ? AND seq > ? ORDER BY seq LIMIT ?",
                                (principal, floor, limit + 1))
        more = len(rows) > limit
        rows = rows[:limit]
        out = []
        for r in rows:
            payload = json.loads(r["payload"])
            out.append({"id": r["id"], "turn_id": r["turn_id"], "created_at": r["created_at"], "words": payload["words"],
                        "answer": payload["answer"], "truncated": bool(r["truncated"])})
        counts = self.db.one("SELECT dropped, expired FROM personal_inbox_dropped WHERE principal = ?", (principal,)) or {}
        return {"items": out, "next": out[-1]["id"] if more and out else None,
                "dropped": int(counts.get("dropped") or 0), "expired": int(counts.get("expired") or 0)}

    def ack(self, viewer, data):
        """POST /api/me/mind/inbox/ack {ids}: delete the caller's own items among ids (idempotent; others ignored)."""
        principal = self._person(viewer)
        ids = data.get("ids") if isinstance(data, dict) and set(data) == {"ids"} else None
        if not isinstance(ids, list) or len(ids) > MAX_ACK or not all(isinstance(i, str) and 0 < len(i) <= 64 for i in ids):
            raise self.hive.personal._refuse(400, "invalid")
        deleted = 0
        if ids:
            marks = ",".join("?" * len(ids))
            deleted = self.db.erase(f"DELETE FROM personal_inbox WHERE principal = ? AND id IN ({marks})",
                                         (principal, *ids))
        self.sweep()
        return {"deleted": deleted}
