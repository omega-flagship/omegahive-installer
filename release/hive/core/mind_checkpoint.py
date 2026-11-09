"""The browser mind's freshness checkpoint, gate A (PLAN_PERSONAL_MIND_BROWSER_ITER_r7_7 §8.3 rule 2-3, §11).

Off unless HIVE_MIND_GATEWAY=1: with it unset the routes answer exactly as an unknown path does and the table is never
made.

What it is: the hive's one trusted record of the newest copy of a person's browser mind, so a restore can fail closed
against it. Per person (one browser mind per personal mind), a single row:
- `seq`: the head, allocated here by compare-and-set and strictly increasing for the life of the row (a reset included),
  so no two writes ever share a seq and an old copy can never match a later head;
- `headDigest`: the device's digest of that head (64 lowercase hex), `keyVersion`: the DK generation it was sealed
  under, `pendingFrom`: a device that announced a newer head it has not landed yet ({deviceId, seq}), and `updated`.
It is content-blind: those fields only. Any other key in a write is refused and nothing is stored; the digest and the
device id have fixed shapes, so no memory text fits in them. The row is never logged, and never on an admin read.

The routes (the §G person gate: exact Origin on writes, Bearer header only, a named admin or member; and an enabled
person). The owner only, by construction: the row is the caller's own, found by their principal, never by an id.
- GET: the head, with `ETag: "<seq>"`. A person with no checkpoint yet reads seq 0 with nulls (ETag "0").
- PUT {headDigest, keyVersion, seq?, pendingFrom?} with `If-Match: "<seq>"`: one atomic conditional UPDATE (or the
  INSERT of seq 1 under the primary key) accepts it only on that head, as seq + 1. Two writers on the same head: exactly
  one wins and the other gets 412 stale_head with the current head, to merge and retry (§8.3 rule 3; no ties). A `seq`
  in the body, if sent, must be that next seq. No If-Match: 428. `keyVersion` never goes down within a chain (D7,
  Dot 3 Nov): a write below the highest one accepted since the last reset (`key_floor`) is 409 key_rollback, since a
  copy under an older key is a resurrection path (§8.3). A reset starts a new chain, so its first PUT may take any
  keyVersion (Surface's broker review, ruled by Dot); a stale device is already stopped there by If-Match (412). `pendingFrom` absent keeps the stored announcement
  (a write never drops one it did not name); null clears it; a new one must name a seq above the head it lands.
- DELETE with `If-Match`: the person's reset (§8.3, "three different events"). The head advances by one and is
  revoked: no digest, no key version, no pending device, `revoked: true`. No copy matches it, so nothing restores. The
  new space's first PUT continues the same seq on that head.
- The personal mind behind the row being replaced (an admin deleted it and the person's next request made another) is
  also a reset: the next access revokes the old mind's head the same way, before anything else is read.
"""

from __future__ import annotations

import re

from .db import now as hive_now
from .hive import HiveError

KEYS = {"seq", "headDigest", "keyVersion", "pendingFrom"}
DIGEST = re.compile(r"[0-9a-f]{64}")
DEVICE = re.compile(r"[A-Za-z0-9_-]{8,64}")
MAX_INT = 2 ** 53 - 1   # the largest integer a browser's JSON reads exactly

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS mind_checkpoints (principal TEXT PRIMARY KEY, mind_id TEXT NOT NULL,
  seq INTEGER NOT NULL, head_digest TEXT, key_version INTEGER, pending_device TEXT, pending_seq INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, key_floor INTEGER NOT NULL DEFAULT 0)""",
]


def _err(status, code, message, details=None):
    return HiveError(status, code, message, details)


def invalid():
    return _err(400, "invalid", "a checkpoint is {headDigest, keyVersion} with an optional seq and pendingFrom")


def etag(seq):
    return f'"{int(seq)}"'


def _int(value, low):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= MAX_INT


def parse(data):
    """The write's fields, checked by shape only. Anything else is refused whole (content-blind by construction)."""
    if not isinstance(data, dict) or set(data) - KEYS or not {"headDigest", "keyVersion"} <= set(data):
        raise invalid()
    digest, version = data["headDigest"], data["keyVersion"]
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest) or not _int(version, 1):
        raise invalid()
    if "seq" in data and not _int(data["seq"], 1):
        raise invalid()
    pending = data.get("pendingFrom", ...)
    if pending is not ... and pending is not None:
        if not isinstance(pending, dict) or set(pending) != {"deviceId", "seq"} \
                or not isinstance(pending["deviceId"], str) or not DEVICE.fullmatch(pending["deviceId"]) \
                or not _int(pending["seq"], 1):
            raise invalid()
    return {"seq": data.get("seq"), "digest": digest, "version": version, "pending": pending}


def if_match(value):
    """The head a write was made on: one strong ETag, `"<seq>"`. None when absent; 412 for any other shape."""
    if value is None:
        return None
    m = re.fullmatch(r'\s*"(0|[1-9][0-9]{0,15})"\s*', value)
    return int(m.group(1)) if m else -1


class MindCheckpoints:
    def __init__(self, hive):
        self.hive = hive
        self._made = False

    @property
    def db(self):
        return self.hive.db

    def _schema(self):
        if not self._made:
            for statement in SCHEMA:
                self.db.execute(statement)
            self._made = True

    # ---- the head ------------------------------------------------------------------------------------------------

    @staticmethod
    def view(row):
        if row is None:
            return {"seq": 0, "headDigest": None, "keyVersion": None, "pendingFrom": None, "revoked": False, "updated": None}
        pending = {"deviceId": row["pending_device"], "seq": row["pending_seq"]} if row["pending_device"] else None
        return {"seq": row["seq"], "headDigest": row["head_digest"], "keyVersion": row["key_version"],
                "pendingFrom": pending, "revoked": bool(row["revoked"]), "updated": row["updated_at"]}

    def _row(self, principal):
        return self.db.one("SELECT * FROM mind_checkpoints WHERE principal = ?", (principal,))

    def _revoke(self, row, mind_id):
        """One step past the row's head, revoked (a reset). Returns whether this call moved it (the CAS on its seq)."""
        cur = self.db.execute("UPDATE mind_checkpoints SET mind_id = ?, seq = seq + 1, head_digest = NULL, key_version = NULL, "
                              "pending_device = NULL, pending_seq = NULL, revoked = 1, updated_at = ?, key_floor = 0 "
                              "WHERE principal = ? AND seq = ?", (mind_id, hive_now(), row["principal"], row["seq"]))
        return cur.rowcount == 1

    def _current(self, principal, mind_id):
        """The caller's row, with a replaced personal mind's head revoked first. Its own transaction, committed before the
        caller's compare-and-set, so a 412 that follows never reports a revocation it rolled back."""
        with self.db.transaction():
            row = self._row(principal)
            if row is not None and row["mind_id"] != mind_id:
                self._revoke(row, mind_id)
                row = self._row(principal)
            return row

    def _person(self, viewer):
        """The caller's principal and their personal mind's id; 403 person_required for anyone else."""
        personal = self.hive.personal
        if personal.person(viewer.principal) is None:
            raise personal._refuse(403, "person_required")
        mind = personal.ensure(viewer.principal)
        return viewer.principal, mind["id"]

    def stale(self, row):
        return _err(412, "stale_head", "another copy moved your mind's head; fetch it, merge and try again",
                    {"head": self.view(row)})

    # ---- the person's own routes -----------------------------------------------------------------------------------

    def get(self, viewer):
        """GET /api/me/mind/checkpoint: the caller's head."""
        principal, mind_id = self._person(viewer)
        self._schema()
        return self.view(self._current(principal, mind_id))

    def put(self, viewer, data, match):
        """PUT /api/me/mind/checkpoint: advance the caller's head by one, only on the head named in If-Match."""
        principal, mind_id = self._person(viewer)
        want = parse(data)
        if match is None:
            raise _err(428, "if_match_required", "say which head this copy follows (If-Match)")
        self._schema()
        self._current(principal, mind_id)
        with self.db.transaction():   # BEGIN IMMEDIATE: the read and the conditional write below are one step
            row = self._row(principal)
            head = 0 if row is None else row["seq"]
            if match != head:
                raise self.stale(row)
            seq = head + 1
            if want["seq"] is not None and want["seq"] != seq:
                raise invalid()
            if row is not None and want["version"] < row["key_floor"]:   # D7: never back to an older key within a chain
                raise _err(409, "key_rollback", "this copy is sealed under an older key than your mind's newest",
                           {"head": self.view(row)})
            pending = want["pending"]
            if pending is ...:   # absent: an announcement stands until a write that saw it clears it (null)
                device, pending_seq = (row["pending_device"], row["pending_seq"]) if row is not None else (None, None)
            elif pending is None:
                device = pending_seq = None
            elif pending["seq"] <= seq:   # an announcement names a head newer than the one this write lands
                raise invalid()
            else:
                device, pending_seq = pending["deviceId"], pending["seq"]
            stamp = hive_now()
            if row is None:   # the first head: the primary key admits one insert, the CAS for seq 0
                cur = self.db.execute("INSERT OR IGNORE INTO mind_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                                      (principal, mind_id, seq, want["digest"], want["version"], device, pending_seq, stamp,
                                       want["version"]))
            else:
                cur = self.db.execute("UPDATE mind_checkpoints SET seq = ?, head_digest = ?, key_version = ?, pending_device = ?, "
                                      "pending_seq = ?, revoked = 0, updated_at = ?, key_floor = ? WHERE principal = ? AND seq = ?",
                                      (seq, want["digest"], want["version"], device, pending_seq, stamp, want["version"],
                                       principal, head))
            if cur.rowcount != 1:
                raise self.stale(self._row(principal))
            return self.view(self._row(principal))

    def reset(self, viewer, match):
        """DELETE /api/me/mind/checkpoint: the person's reset revokes the head, one step on (only on the If-Match head)."""
        principal, mind_id = self._person(viewer)
        if match is None:
            raise _err(428, "if_match_required", "say which head this reset follows (If-Match)")
        self._schema()
        self._current(principal, mind_id)
        with self.db.transaction():   # BEGIN IMMEDIATE: the read and the conditional write below are one step
            row = self._row(principal)
            head = 0 if row is None else row["seq"]
            if match != head:
                raise self.stale(row)
            if row is None:   # nothing was ever checkpointed: the reset still takes seq 1, so no first copy matches it
                self.db.execute("INSERT OR IGNORE INTO mind_checkpoints VALUES (?, ?, 1, NULL, NULL, NULL, NULL, 1, ?, 0)",
                                (principal, mind_id, hive_now()))
            elif not self._revoke(row, mind_id):
                raise self.stale(self._row(principal))
            return self.view(self._row(principal))
