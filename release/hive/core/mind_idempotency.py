"""The gateway's Idempotency-Key, gate A (browser-Iter plan r7.7 §6.2, §10; Dot's rulings of 3 Nov).

A retried model call is never a second paid call. Used only by MindGateway.chat, so off unless HIVE_MIND_GATEWAY=1;
nothing here is made until the first call that carries a key.

The key:
- `Idempotency-Key: <1-128 of A-Z a-z 0-9 . _ : ->` on POST /api/me/mind/llm/v1/chat/completions. The broker sends
  `turnId:step` with turnId the Ask operation id, so it is unique per person.
- Its namespace is the PERSON: (principal, key), not the token (Surface's broker review, ruled by Dot). The broker's
  cure for a 401 is a re-mint and tokens last 30 minutes, so a token-scoped key would let a re-minted token resend a
  dispatched call whose answer was lost. A stored outcome is answered to any of that person's live tokens for the same
  personal mind; another person never matches, and a record made for a mind the person no longer has never answers.
- Kept KEEP_SECONDS (1 h; Dot, 3 Nov: the broker's back-off, a re-mint and a token's life), then deleted. After that
  the key has no record, but a paid call's reservation id is derived from the person and the key (call_id_for), so
  its reservation still names the key, in any state, and is never sent again (stand-in r1.1 P1-1):
  - settled at its reported cost, or released unsent: 409 replay_expired (the outcome was known; its answer is no
    longer kept);
  - reserved, dispatched, unknown, or settled at its worst case after being unknown: 409 outcome_unknown.
  A key never reserved (a free call, or one refused before its reservation) is a fresh call. The reservation itself
  refuses a second reservation under that id as well, so this holds even if the record check were skipped.
  Reservation rows are never deleted (cost_reservations.py has no DELETE; unknown holds become settled at 24 h, with
  unknown_at kept), so no separate tombstone is needed.
- An answer past its hour is never replayed (replay checks the record's and the answer's own age), and is erased by
  the sweep (below), not by keyed traffic.
- The record binds a digest of the turn header and the body as sent. The same key with anything else is 422
  idempotency_mismatch, and nothing is sent.
- Without the header a call is not deduplicated (as before). The broker must always send one: it is the only thing
  that stops a retry from paying twice.

When it is written: inside the same SQLite transaction that reserves the call (Reservations.reserve's budgets
callback), before anything is sent; for a call with no reservation (an unpriced free model), in its own transaction
just before the send gate. Two calls racing on one key: the primary key admits one record, the other's reservation
rolls back with it, and it answers 409 in_progress. Nothing can be sent without its record already committed.

What a retry gets:
- `done`: the first call's stored answer, status and body (and its X-Hive-* headers), with `Idempotent-Replay: true`.
  Every terminal answer after the record is written is stored: 200, a refusal at the send gate, an upstream error
  with its held amount.
- `pending` while the first call is still running in this process: 409 in_progress.
- `pending` with nothing running it (the process died, or the call broke, between the send and storing its answer),
  or `unknown`: 409 outcome_unknown. The record turns `unknown` and stays so; the reservation keeps its own state
  (held, as any dispatched call whose outcome was never seen). It is reported, never retried.
- A call cancelled before it was sent leaves no record, so its retry runs.
- A refusal before the record is written leaves none, so its retry is a fresh attempt: a malformed body (400), a spend
  refusal (402) and a rate limit (429) at check_budget, a turn closed or at its ceiling, a reservation refused.

Order matters (Kimi r1.1 P2 #2): claim runs inside Reservations.reserve's budgets callback, so it comes before the
reservation's own binding check, in the same transaction. The record's primary key is the race arbiter (a live
duplicate answers in_progress); the reservation id, derived from the key, is only the guard after the record expires.
Moving claim out of that transaction would turn a live race's in_progress into replay_expired or outcome_unknown.

Restarts: the hive's restarts stop the old process before the new one starts (no rolling overlap), so "running in
this process" (_running) is the only running there is; a record pending at startup reads as unknown.

Where the answer lives (r1.3, Dot's rulings on the stand-in's privacy P1s): the record (state, digest, status) is in
hive.db beside the reservation. The answer itself is the model's text, so it is kept apart, in its own file,
mind_idempotency.db:
- journal_mode=DELETE, not WAL: there is no WAL file to keep old frames, so no reader can pin an erased answer in one.
  secure_delete=ON zeroes a deleted answer's cells and freed pages in the main file; the rollback journal exists only
  while a write transaction runs and is deleted at its commit. synchronous=FULL.
- mode 0600, owned by the service user (the hive's own data directory).
- one connection, ours; reads are short autocommit statements, and no code here holds a read transaction.
- Trust boundary: no other process may open the hive's data files. A process that could would read the answers while
  they are kept anyway; what this file guarantees is that an erased answer is in no file of the directory.
- never logged, and on no read but the replay.

The sweep (sweep, sweep_quietly), which depends on nothing else succeeding (r1.2 and r1.3 rulings). Three steps, each
in its own try, so a failure in one never skips the others:
1. Answers past their OWN age (KEEP_SECONDS) are erased from mind_idempotency.db, reading nothing in hive.db.
2. Orphans: an answer no record in hive.db names (a crash between the two files) is erased once ORPHAN_GRACE old (the
   grace keeps an answer being written right now).
3. Records past their hour are deleted from hive.db (content-free).
It runs at startup, first in every reconcile pass (outside the pass's shared try), and from its own backstop thread
(sweeper, every SWEEP_SECONDS), which does not depend on the reconcile loop or the event loop's thread pool. Step 1 has
its own short lock and always runs; steps 2 and 3 share another lock taken without waiting, and wait at most
HIVE_DB_WAIT for hive.db, so a stuck hive.db never stops a later pass's step 1. The request path never sweeps.

The retention bound, stated (Dot's ruling on the stand-in's r1.4 P1-1): while running, an answer is erased within its
expiry plus the sweep interval. After a crash or a stop: by the startup sweep, after SQLite's journal recovery. A
stopped hive erases nothing, crash or not; a crash in the middle of an erase can leave the old pages in a hot rollback
journal until that recovery, which the next open of the file runs before the startup sweep erases them again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time

from .db import Database
from .hive import HiveError

KEEP_SECONDS = 3600
SWEEP_SECONDS = 60     # the backstop thread's period (MindIdempotency.sweeper), apart from the reconcile pass
ORPHAN_GRACE = 60      # an answer no record names is erased once this old
HIVE_DB_WAIT = 5.0     # steps 2 and 3 wait at most this long for hive.db's connection, then skip the pass
KEY = re.compile(r"[A-Za-z0-9._:-]{1,128}")
DB_NAME = "mind_idempotency.db"

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS mind_idem (principal TEXT NOT NULL, idem_key TEXT NOT NULL, mind_id TEXT NOT NULL,
  digest TEXT NOT NULL, call_id TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, created_at REAL NOT NULL,
  PRIMARY KEY (principal, idem_key))""",
    "CREATE INDEX IF NOT EXISTS mind_idem_created ON mind_idem(created_at)",
]
FILE_MODE = 0o600
ANSWERS = ["CREATE TABLE IF NOT EXISTS mind_idem_answers (call_id TEXT PRIMARY KEY, body TEXT NOT NULL, headers TEXT NOT NULL, "
           "created_at REAL NOT NULL)"]


def call_id_for(principal, key):
    """A keyed call's request id (its reservation's id): one per person and key, so the reservation outlives the record
    and still names the key once the record has expired."""
    return "mi_" + hashlib.sha256(f"{principal}\n{key}".encode("utf-8")).hexdigest()[:40]


class KeyTaken(Exception):
    """Another call holds this key: raised inside the reservation's transaction, so it rolls back with it."""


def _err(status, code, message, details=None):
    return HiveError(status, code, message, details)


def expired(state):
    """A key past its hour whose reservation still exists (state: the reservation's row). Never a fresh call."""
    if state is not None and (state["state"] == "released"
                              or (state["state"] == "settled" and state.get("unknown_at") is None)):
        return _err(409, "replay_expired", "this call already happened; its answer is no longer kept")
    return unknown()


def in_progress():
    return _err(409, "in_progress", "this call is still running; ask again for its answer shortly")


def unknown():
    return _err(409, "outcome_unknown", "this call was sent, but its answer was never seen; it will not be sent again")


class Slot:
    """One keyed call: its namespace, its digest, and what became of its record."""

    def __init__(self, principal, mind_id, key, digest, now=None):
        self.principal, self.mind_id, self.key, self.digest = principal, mind_id, key, digest
        # the one clock reading replay and claim both judge the hour by (Kimi r1.3 P2 #2), so they agree at its edge
        self.now = time.time() if now is None else now
        self.call_id = None
        self.claimed = False     # the record is written in the open transaction, and this process runs the key
        self.committed = False   # that transaction committed: the record stands, and the call may be sent
        self.unsent = False      # it was cancelled before the send: its record goes, so a retry runs


class MindIdempotency:
    def __init__(self, hive):
        self.hive = hive
        self._lock = threading.Lock()
        self._answers = None
        self._running = set()   # (principal, key) of the keyed calls this process is running now
        self._made = False
        # r1.4 (Dot): step 1 has its own short lock and always runs; steps 2 and 3 share another, taken without
        # waiting, so a sweep stuck on hive.db never holds up the next pass's step 1
        self._ageing = threading.Lock()
        self._upkeep = threading.Lock()

    @property
    def db(self):
        return self.hive.db

    def records(self):
        """The records' table in hive.db, made on first use."""
        if not self._made:
            for statement in SCHEMA:
                self.db.execute(statement)
            self._made = True

    def answers(self):
        """The answers' own database (module notes: no WAL, secure delete, 0600). Opening it touches nothing in hive.db."""
        with self._lock:
            if self._answers is None:
                path = self.hive.settings.data_dir / DB_NAME
                os.close(os.open(path, os.O_RDWR | os.O_CREAT, FILE_MODE))
                os.chmod(path, FILE_MODE)
                answers = Database(path, hive_schema=False)   # opens in WAL; switched before anything is written
                # a -wal an older build left (r1.2 kept the answers in WAL) is folded into the main file first, and must
                # be gone afterwards: otherwise its frames, plaintext included, would outlive every erase (Kimi r1.3 P2)
                busy = answers.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
                mode = answers.execute("PRAGMA journal_mode = DELETE").fetchone()[0]
                wal = path.with_name(DB_NAME + "-wal")
                if busy or str(mode).lower() != "delete" or wal.exists():
                    answers._conn.close()
                    raise RuntimeError(f"{DB_NAME} could not leave WAL mode ({mode}, busy {busy})")
                answers.execute("PRAGMA secure_delete = ON")
                answers.execute("PRAGMA synchronous = FULL")
                for statement in ANSWERS:
                    answers.execute(statement)
                self._answers = answers
            return self._answers

    # ---- the request -------------------------------------------------------------------------------------------------

    @staticmethod
    def key(headers):
        """The request's key, or None when it sends none. One header, of the key's shape, else 400."""
        values = headers.getlist("idempotency-key")
        if not values:
            return None
        if len(values) != 1 or not KEY.fullmatch(values[0]):
            raise _err(400, "invalid", "Idempotency-Key is 1 to 128 of A-Z a-z 0-9 . _ : -")
        return values[0]

    @staticmethod
    def digest(turn_id, data):
        text = json.dumps({"turn": turn_id, "body": data}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def sweep_quietly(self):
        """One sweep from startup or the reconcile pass. Makes nothing when nothing was ever made (a hive that never ran
        the gateway). Never raises."""
        try:
            if self._answers is None and not (self.hive.settings.data_dir / DB_NAME).exists():
                return 0
            return self.sweep()
        except Exception:   # noqa: BLE001
            logging.getLogger("hive").exception("mind idempotency sweep failed")
            return 0

    def sweeper(self, stop):
        """The backstop thread's body (app.py starts it, named mind-answer-sweeper): a sweep every SWEEP_SECONDS until
        `stop` (a threading.Event) is set. Its own thread, so neither the reconcile loop nor the thread pool can hold
        it up."""
        last = time.monotonic()
        while not stop.wait(1.0):
            if time.monotonic() - last >= SWEEP_SECONDS:
                last = time.monotonic()
                self.sweep_quietly()

    def sweep(self, now=None):
        """One pass: the three steps in the module notes, each in its own try. Returns how many answers it erased.
        Step 1 takes its own lock (waiting only for another step 1, which touches nothing but the answers' file). Steps
        2 and 3 run only if no other pass is in them (else skipped, at once), and only once hive.db's connection is
        theirs within HIVE_DB_WAIT (else skipped): a hive.db that is stuck or slow can never stop a later step 1."""
        log = logging.getLogger("hive")
        moment = time.time() if now is None else now
        cutoff, erased = moment - KEEP_SECONDS, 0
        with self._ageing:
            try:   # 1. by their own age, in the answers' file alone
                answers = self.answers()
                with answers.transaction():
                    erased += answers.erase("DELETE FROM mind_idem_answers WHERE created_at <= ?", (cutoff,))
            except Exception:   # noqa: BLE001
                log.exception("mind idempotency: erasing answers past their hour failed")
        if not self._upkeep.acquire(blocking=False):
            return erased   # another pass is in steps 2-3 (perhaps stuck on hive.db): it is not waited for
        try:
            hive_lock = getattr(self.db, "_lock", None)
            if hive_lock is not None and not hive_lock.acquire(timeout=HIVE_DB_WAIT):
                log.warning("mind idempotency: hive.db was busy; orphans and records wait for the next pass")
                return erased
            try:
                try:   # 2. orphans, which needs hive.db's records
                    self.records()
                    named = {r["call_id"] for r in self.db.all("SELECT call_id FROM mind_idem")}
                    answers = self.answers()
                    old = [r["call_id"] for r in answers.all("SELECT call_id FROM mind_idem_answers WHERE created_at <= ?",
                                                              (moment - ORPHAN_GRACE,))]
                    with answers.transaction():
                        for call_id in old:
                            if call_id not in named:
                                erased += answers.erase("DELETE FROM mind_idem_answers WHERE call_id = ?", (call_id,))
                except Exception:   # noqa: BLE001
                    log.exception("mind idempotency: erasing orphaned answers failed")
                try:   # 3. the content-free records
                    self.records()
                    self.db.execute("DELETE FROM mind_idem WHERE created_at <= ?", (cutoff,))
                except Exception:   # noqa: BLE001
                    log.exception("mind idempotency: deleting expired records failed")
            finally:
                if hive_lock is not None:
                    hive_lock.release()
        finally:
            self._upkeep.release()
        return erased

    def replay(self, slot, reservation):
        """None when the key is free; else the stored answer as (status, body, headers), or the refusal for its state.
        reservation(call_id): the reservation row under that id, or None (a record past its hour is gone, its
        reservation is not). It never sweeps (the request path stays short); a record or answer past its hour that the
        sweep has not reached yet is treated as gone."""
        self.records()
        cutoff = slot.now - KEEP_SECONDS
        row = self.db.one("SELECT * FROM mind_idem WHERE principal = ? AND idem_key = ? AND created_at > ?",
                          (slot.principal, slot.key, cutoff))
        if row is None:
            held = reservation(call_id_for(slot.principal, slot.key))
            if held is not None:
                raise expired(held)   # past its hour: reserved once under this key, so it is never sent again
            return None
        if row["digest"] != slot.digest or row["mind_id"] != slot.mind_id:
            raise _err(422, "idempotency_mismatch", "this Idempotency-Key was used for a different call")
        if row["state"] == "done":
            stored = self.answers().one("SELECT * FROM mind_idem_answers WHERE call_id = ? AND created_at > ?",
                                        (row["call_id"], cutoff))
            if stored is not None:
                return row["status"], json.loads(stored["body"]), json.loads(stored["headers"])
        elif row["state"] == "pending" and (slot.principal, slot.key) in self._running:
            raise in_progress()
        # pending with nothing running it, unknown, or done without its answer: it stays unknown, and is said so
        self.db.execute("UPDATE mind_idem SET state = 'unknown' WHERE principal = ? AND idem_key = ? AND state != 'unknown'",
                        (slot.principal, slot.key))
        raise unknown()

    # ---- the call -----------------------------------------------------------------------------------------------------

    def claim(self, slot, call_id):
        """Write the record, inside the caller's transaction (the reservation's, or its own). KeyTaken if it is held."""
        self.records()
        # a record past its hour that no sweep has reached yet no longer holds the key (replay treated it as gone)
        self.db.execute("DELETE FROM mind_idem WHERE principal = ? AND idem_key = ? AND created_at <= ?",
                        (slot.principal, slot.key, slot.now - KEEP_SECONDS))
        cur = self.db.execute("INSERT OR IGNORE INTO mind_idem (principal, idem_key, mind_id, digest, call_id, state, "
                              "created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                              (slot.principal, slot.key, slot.mind_id, slot.digest, call_id, time.time()))
        if cur.rowcount != 1:
            raise KeyTaken()
        # before the commit (the transaction holds the connection's lock, so no reader sees the record before this),
        # so a reader never takes a running call for an orphaned one
        self._running.add((slot.principal, slot.key))
        slot.call_id, slot.claimed = call_id, True

    def finish(self, slot, status, body, headers):
        """The call's terminal answer: stored first, then the record marked done (a failure between them reads as
        unknown, never as a free key). A record already reported unknown stays unknown."""
        answers = self.answers()
        with answers.transaction():
            answers.execute("INSERT OR REPLACE INTO mind_idem_answers VALUES (?, ?, ?, ?)",
                            (slot.call_id, json.dumps(body, ensure_ascii=False), json.dumps(headers), time.time()))
        self.db.execute("UPDATE mind_idem SET state = 'done', status = ? WHERE principal = ? AND idem_key = ? "
                        "AND call_id = ? AND state = 'pending'", (int(status), slot.principal, slot.key, slot.call_id))

    def forget(self, slot):
        """Cancelled before the send: the record goes, so the retry runs."""
        self.db.execute("DELETE FROM mind_idem WHERE principal = ? AND idem_key = ? AND call_id = ? AND state = 'pending'",
                        (slot.principal, slot.key, slot.call_id))

    def leave(self, slot):
        """The call is no longer running here (answered, refused, or broken: a record still pending then reads as
        unknown)."""
        if slot.claimed:
            self._running.discard((slot.principal, slot.key))
