"""J3 host round R3: the maker handoff, Stop and step delivery.

Specification: coordination/omegareview/PLATFORM_J3R4_HOST_HANDOFF_SPEC_R2.md r2.4 (sha256 79556a75...), which replaces
every handoff, Stop, admission-delivery and credential-file section of PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md; G1, G2, G3,
G5, H2, H3.1 and L6 of the plan still stand. Section numbers below are the spec's.

Actors (§1):
  * the Studio worker: one daemon thread per job, at most one outstanding job per maker, in three classes with their
    own threads and FIFOs (S 4, attempts 10, cleanup 2; precedence S > attempts > cleanup). Every lifecycle, credential,
    file and driver operation runs in a worker job, never on the event loop;
  * the handoff owner: a per-maker non-blocking threading.Lock taken for a whole job, plus owner_boot on rows;
  * the supervisor's mind lock (Supervisor.transition), taken by a job only around a verified stop, a rotate + renames
    + start, and the stop path's rotate + renames;
  * the sweep (tick(), from the reconcile coroutine right after supervisor.check()): reads rows, writes short
    conditional DB transactions, submits jobs and creates delivery tasks. No filesystem access, no lifecycle call;
  * delivery tasks: one per admitted step, at most SENDS_IN_FLIGHT sends hive-wide, a 10 s budget from the slot;
  * the Stop route: one immediate DB transaction, then job S.

Nothing here runs while HIVE_STUDIO_SESSIONS is off (StudioSessions.enabled false): the sweep returns at once, nothing
is owned, no message is held back, and Supervisor.check keeps its blocking per-mind pass.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import datetime
import hashlib
import json
import logging
import os
import pathlib
import secrets
import threading
import time

from .db import now
from .minds import stamp as rfc3339_ms

log = logging.getLogger("hive")

SETTLE_S = 660                 # §4: gateway timeout 600 s (gateway.py) plus 60 s
STOPPING_S = 780               # §5.1
JOB_STUCK_S = 300              # §1
STALE_S = 120                  # §4 interrupted boot: an in_progress row with no outstanding job
PROOF_WINDOW_S = 60            # §4: doubled per attempt of the same step (60/120/240)
ATTEMPTS_PER_HOUR = 3          # J6 (spec r2.5 §4): retries per rolling hour per session; a step's first attempt never counts
STATUS_TIMEOUT_S = 5.0         # r3.2: the bound on a driver status() read for the person-visible stop status
DELIVERY_BUDGET_S = 10.0       # §6
DELIVERY_RETRY_S = 0.25        # §6.1
SENDS_IN_FLIGHT = 4            # §1 W
CLASSES = {"S": 4, "attempt": 10, "cleanup": 2}
PRECEDENCE = ("S", "attempt", "cleanup")
OPEN_ROWS = ("in_progress", "settling", "installing", "starting", "awaiting_proof")
LIVE = ("active", "paused")    # the spec's `live`
ENDED = "stopped"              # the spec's `ended`
OWNED_SESSION_STATES = ("active", "paused", "held", "stopping")
HANDOFF_REASONS = ("handoff_interrupted", "handoff_stale", "handoff_retry_exhausted", "stopped", "maker_unresponsive",
                   "delivery_uncertain")

# ---- file I/O (§3), each step through a hook so tests can fail or park it ------------------------------------------

HOOK = None          # tests: HOOK(kind, path) with kind in write | fsync | rename | dirsync; it may raise or block


def _hook(kind, path):
    if HOOK is not None:
        HOOK(kind, pathlib.Path(path))


def _token_hash(token):
    return hashlib.sha256(str(token).encode()).hexdigest()


def token_file(root, epoch):
    return pathlib.Path(root) / f"token-e{int(epoch)}"


def pending_file(root, epoch):
    return pathlib.Path(root) / f"pending-token-e{int(epoch)}"


def file_hash(path):
    try:
        return _token_hash(pathlib.Path(path).read_text(encoding="utf-8").strip())
    except OSError:
        return None


def _read_epoch(path):
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(text) if text.isdigit() else None


def write_fsync(path, text):
    """Mode 0600, written, fsynced, closed."""
    _hook("write", path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, str(text).encode("utf-8"))
        _hook("fsync", path)
        os.fsync(fd)
    finally:
        os.close(fd)


def rename(src, dst):
    _hook("rename", dst)
    os.replace(src, dst)


def dir_fsync(root):
    _hook("dirsync", root)
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def new_token():
    token = secrets.token_urlsafe(32)
    return token, _token_hash(token)


def write_pending(root, epoch, token):
    """§3 prepare steps 2-3: pending-token-e<k+1> at 0600 + fsync, then current.tmp = k+1 + fsync. Nothing it writes
    authenticates anything: the hub checks agents.token_hash, which only the DB rotate changes."""
    write_fsync(pending_file(root, epoch), token)
    write_fsync(pathlib.Path(root) / "current.tmp", str(int(epoch)))


def ensure_pointer_tmp(root, epoch):
    if _read_epoch(pathlib.Path(root) / "current.tmp") != int(epoch):
        write_fsync(pathlib.Path(root) / "current.tmp", str(int(epoch)))


def install(root, epoch, expected_hash):
    """§3 install (under transition, after the DB rotate): two renames, no fsync. Idempotent: a token file already in
    place with the expected hash is kept."""
    root = pathlib.Path(root)
    if file_hash(token_file(root, epoch)) != expected_hash:
        rename(pending_file(root, epoch), token_file(root, epoch))
    if _read_epoch(root / "current") != int(epoch):
        if _read_epoch(root / "current.tmp") != int(epoch):
            raise OSError(f"no pointer file for epoch {epoch}")
        rename(root / "current.tmp", root / "current")


def point(root, epoch):
    root = pathlib.Path(root)
    write_fsync(root / "current.tmp", str(int(epoch)))
    rename(root / "current.tmp", root / "current")


def repair(root, epoch, db_hash):
    """§3 repair, at the start of every job, under the owner. Returns ok | repaired | credential_missing. It never
    asserts anything about the process or about fencing. The legacy single `token` file (every mind before its first
    handoff) counts as token-e<epoch> when it hashes to the DB: it is copied into the per-epoch scheme, never moved."""
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)
    status = "ok"
    if file_hash(token_file(root, epoch)) != db_hash:
        if file_hash(pending_file(root, epoch)) == db_hash:
            rename(pending_file(root, epoch), token_file(root, epoch))
            status = "repaired"
        elif _read_epoch(root / "current") is None and file_hash(root / "token") == db_hash:
            write_fsync(token_file(root, epoch), (root / "token").read_text(encoding="utf-8").strip())
            status = "repaired"
        else:
            status = "credential_missing"
    if status != "credential_missing" and _read_epoch(root / "current") != int(epoch):
        point(root, epoch)
        status = "repaired"
    for path in root.iterdir():            # stray pending files of any epoch but the next one
        name = path.name
        if name.startswith("pending-token-e") and name[len("pending-token-e"):].isdigit() \
                and int(name[len("pending-token-e"):]) != int(epoch) + 1:
            path.unlink(missing_ok=True)
    tmp = _read_epoch(root / "current.tmp")
    if (root / "current.tmp").exists() and tmp != int(epoch) + 1:
        (root / "current.tmp").unlink(missing_ok=True)
    return status


def cleanup(root, keep_epoch):
    """Old token-e<i < keep> files, and the legacy `token` once the per-epoch scheme holds the credential. Worker only."""
    root = pathlib.Path(root)
    removed = []
    if not root.exists():
        return removed
    for path in root.iterdir():
        name = path.name
        if name.startswith("token-e") and name[len("token-e"):].isdigit() and int(name[len("token-e"):]) < int(keep_epoch):
            path.unlink(missing_ok=True)
            removed.append(name)
    if (root / "current").exists() and (root / "token").exists():
        (root / "token").unlink(missing_ok=True)
        removed.append("token")
    return removed


# ---- the worker (§1) -------------------------------------------------------------------------------------------------

class Job:
    __slots__ = ("maker", "cls", "kind", "fn", "ref", "started_at", "submitted_at", "thread")

    def __init__(self, maker, cls, kind, fn, ref):
        self.maker, self.cls, self.kind, self.fn, self.ref = maker, cls, kind, fn, ref
        self.started_at, self.submitted_at, self.thread = None, time.monotonic(), None


class StudioWorker:
    """One daemon thread per job; at most one outstanding job per maker (`jobs[maker]`, set at submit, cleared in the
    job's finally); each class has its own threads and FIFO. A stuck thread is never killed."""

    def __init__(self, caps=None):
        self.caps = dict(caps or CLASSES)
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self.jobs = {}
        self.queues = {c: collections.deque() for c in self.caps}
        self.running = {c: set() for c in self.caps}
        self.history = collections.deque(maxlen=256)      # (class, kind, maker) in start order
        self._paused = False

    def submit(self, maker, cls, kind, fn, ref=None):
        with self._lock:
            if maker in self.jobs:
                return False
            job = Job(maker, cls, kind, fn, ref)
            self.jobs[maker] = job
            self.queues[cls].append(job)
            self._pump()
            return True

    def _pump(self):
        if self._paused:
            return
        for cls in PRECEDENCE:
            queue = self.queues[cls]
            while queue and len(self.running[cls]) < self.caps[cls]:
                job = queue.popleft()
                job.started_at = time.monotonic()
                self.running[cls].add(job)
                self.history.append((cls, job.kind, job.maker))
                job.thread = threading.Thread(target=self._run, args=(job,), daemon=True,
                                              name=f"studio-{cls}-{job.kind}-{job.maker}")
                job.thread.start()

    def _run(self, job):
        try:
            job.fn()
        except Exception:   # noqa: BLE001  (a job's own failure transitions are written by the job; this is a bug)
            log.exception("studio %s job for %s failed", job.kind, job.maker)
        finally:
            with self._lock:
                self.running[job.cls].discard(job)
                if self.jobs.get(job.maker) is job:
                    del self.jobs[job.maker]
                self._pump()
                self._idle.notify_all()

    def pause(self):
        with self._lock:
            self._paused = True

    def resume(self):
        with self._lock:
            self._paused = False
            self._pump()

    def outstanding(self, maker):
        with self._lock:
            return maker in self.jobs

    def job_of(self, maker):
        with self._lock:
            return self.jobs.get(maker)

    def stuck(self, limit=None):
        limit = JOB_STUCK_S if limit is None else limit
        moment = time.monotonic()
        with self._lock:
            return [j for jobs in self.running.values() for j in jobs if moment - j.started_at > limit]

    def counts(self):
        stuck = {id(j) for j in self.stuck()}
        with self._lock:
            return {c: {"running": len(self.running[c]), "queued": len(self.queues[c]),
                        "stuck": sum(1 for j in self.running[c] if id(j) in stuck)} for c in self.caps}

    def wait_idle(self, timeout=10.0):
        with self._idle:
            return self._idle.wait_for(lambda: not self.jobs, timeout)


# ---- the handoff, Stop and delivery (§2-§6), mixed into StudioSessions through StudioSteps ---------------------------

def _utc():
    return datetime.datetime.now(datetime.timezone.utc)


def _t(text):
    return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00")) if text else None


def _after(seconds):
    return rfc3339_ms(_utc() + datetime.timedelta(seconds=seconds))


def _passed(text):
    return text is not None and _t(text) <= _utc()


HANDOFF_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS studio_handoffs (id TEXT PRIMARY KEY, maker_id TEXT NOT NULL, session_id TEXT NOT NULL,
  step_n INTEGER NOT NULL, attempt INTEGER NOT NULL, from_epoch INTEGER NOT NULL, to_epoch INTEGER NOT NULL, token_hash TEXT,
  state TEXT NOT NULL, owner_boot TEXT NOT NULL, deadline TEXT, window_s INTEGER NOT NULL, reason TEXT,
  boundary_before INTEGER, proven_at TEXT, override INTEGER NOT NULL DEFAULT 0, job_stuck_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    # §2: at most one open row per maker
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_handoffs_open_maker ON studio_handoffs(maker_id) "
    "WHERE state IN ('in_progress', 'settling', 'installing', 'starting', 'awaiting_proof')",
    "CREATE INDEX IF NOT EXISTS studio_handoffs_session ON studio_handoffs(session_id, created_at)",
    # H3.1: a maker's registered hub socket, the epoch it authenticated with and the connection's nonce
    """CREATE TABLE IF NOT EXISTS studio_hub_registrations (agent_id TEXT PRIMARY KEY, epoch INTEGER, nonce TEXT,
  at TEXT NOT NULL)""",
    # §4 admission queues a cleanup job; the sweep submits it (it deletes nothing itself)
    """CREATE TABLE IF NOT EXISTS studio_cleanups (maker_id TEXT PRIMARY KEY, keep_epoch INTEGER NOT NULL,
  at TEXT NOT NULL)""",
]
HANDOFF_SESSION_COLUMNS = [
    ("stop_verified", "INTEGER NOT NULL DEFAULT 0"),
    # rows made before R3 were never owned by a handoff: released. admit() inserts 0 for every new session
    ("maker_released", "INTEGER NOT NULL DEFAULT 1"),
    ("stopping_deadline", "TEXT"), ("settle_deadline", "TEXT"), ("release_token_hash", "TEXT"),
    ("release_epoch", "INTEGER"), ("release_phase", "TEXT NOT NULL DEFAULT 'none'"), ("current_handoff", "TEXT"),
    ("stop_failed", "INTEGER NOT NULL DEFAULT 0"), ("release_stale", "INTEGER NOT NULL DEFAULT 0"),
    ("stop_status", "TEXT"), ("credential_reason", "TEXT"), ("job_stuck_at", "TEXT"), ("finish_count", "INTEGER NOT NULL DEFAULT 0"),
]
HANDOFF_STEP_COLUMNS = [("delivery_id", "TEXT"), ("delivery_nonce", "TEXT"), ("delivered_at", "TEXT"),
                        ("delivery_outcome", "TEXT")]


class StudioHandoffs:
    """Uses the StudioSteps / StudioSessions helpers: hive, enabled, _session, _steps, _open_step, _epoch, _boundary,
    _set_state, _session_event, _step_event, _requeue, _admissible, _drift, _budget_room, _queued, _expire."""

    def _init_handoff(self):
        db = self.hive.db
        for statement in HANDOFF_SCHEMA:
            db.execute(statement)
        for table, columns in (("studio_sessions", HANDOFF_SESSION_COLUMNS), ("studio_steps", HANDOFF_STEP_COLUMNS),
                               ("ask_steers", [("studio_cancelled_at", "TEXT")])):
            if not db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)):
                continue
            have = {r["name"] for r in db.all(f"SELECT name FROM pragma_table_info('{table}')")}
            for column, kind in columns:
                if column not in have:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        self.boot = secrets.token_hex(8)            # owner_boot of this process
        self.worker = StudioWorker()
        self._owners = {}
        self._owners_guard = threading.Lock()
        self.deliveries = {}                        # (session, step) -> delivery task
        self._sends = 0
        self._held_from = {}                        # maker -> lowest hub_seq held back while owned (§6)

    # ---- small reads ---------------------------------------------------------------------------------------------

    def _handoff(self, row_id):
        return self.hive.db.one("SELECT * FROM studio_handoffs WHERE id = ?", (row_id,))

    def _latest_handoff(self, session_id):
        return self.hive.db.one("SELECT * FROM studio_handoffs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC "
                                "LIMIT 1", (session_id,))

    def _open_handoff_of(self, maker_id):
        return self.hive.db.one("SELECT * FROM studio_handoffs WHERE maker_id = ? AND state IN "
                                "('in_progress', 'settling', 'installing', 'starting', 'awaiting_proof')", (maker_id,))

    def _db_hash(self, maker_id):
        row = self.hive.db.one("SELECT token_hash FROM agents WHERE id = ?", (maker_id,))
        return row["token_hash"] if row else None

    def _root(self, maker_id):
        root = pathlib.Path(self.hive.supervisor.workspace.path(maker_id))
        root.mkdir(parents=True, exist_ok=True)
        return root

    def open_reservations(self, maker_id, k=None):
        """The maker's reservations still reserved or dispatched, by subject or metadata, of epoch <= k. R4 records the
        captured token epoch on every reservation a live session's maker makes (studio_gateway.py, the reservation's
        metadata), so a reservation recorded under a newer epoch than k is not counted (Kimi R3 #3, stand-in R3 #5). A
        reservation that carries no epoch (made before Studio bound the maker, or by a host path) is counted whatever k
        is: the fail-closed side, as before R4. k None counts every one (the R3 reading)."""
        sql = ("SELECT r.id, r.state FROM cost_reservations r LEFT JOIN cost_reservation_details d ON d.reservation = r.id "
               "WHERE r.state IN ('reserved', 'dispatched') AND ("
               "EXISTS (SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation = r.id AND j.subject = ?) OR "
               "(json_valid(d.metadata) AND json_extract(d.metadata, '$.agent') = ?))")
        params = ["agent:" + maker_id, maker_id]
        if k is not None:
            sql += (" AND (d.metadata IS NULL OR NOT json_valid(d.metadata) OR json_type(d.metadata, '$.token_epoch') "
                    "IS NOT 'integer' OR json_extract(d.metadata, '$.token_epoch') <= ?)")
            params.append(int(k))
        return self.hive.db.all(sql, tuple(params))

    # ---- §2 ownership ----------------------------------------------------------------------------------------------

    def studio_owns(self, maker_id):
        """True while the maker has a live, held or stopping session, an ended one not yet released, or an open handoff
        row. Only consent-v2 sessions with Studio on (R2.4: legacy or held-off rows never restrict a mind)."""
        if not getattr(self, "enabled", False):
            return False
        from .studio_sessions import CONSENT_PAYLOAD_VERSION
        db = self.hive.db
        return bool(db.one("SELECT 1 FROM studio_sessions WHERE maker_id = ? AND consent_payload_version >= ? AND "
                           "(state IN ('active', 'paused', 'held', 'stopping') OR (state = ? AND maker_released = 0)) "
                           "LIMIT 1", (maker_id, CONSENT_PAYLOAD_VERSION, ENDED))
                    or self._open_handoff_of(maker_id))

    def owned_refusal(self, agent_id):
        if self.studio_owns(agent_id):
            return self._err(409, "studio_owned", "This mind is making a Studio piece; Studio starts and stops it.")
        return None

    def holds_messages(self, agent_id, hub_seq=None):
        """§6: while owned and the latest handoff row is not done, ordinary queued messages wait (replayed after the
        admission). Inert with Studio off."""
        if not getattr(self, "enabled", False) or not self.studio_owns(agent_id):
            return False
        latest = self.hive.db.one("SELECT state, reason FROM studio_handoffs WHERE maker_id = ? ORDER BY created_at DESC, "
                                  "rowid DESC LIMIT 1", (agent_id,))
        if latest is None or latest["state"] == "done" or (latest["state"] == "held" and latest["reason"] == "stopped"):
            return False
        if hub_seq is not None:
            self._held_from[agent_id] = min(self._held_from.get(agent_id, hub_seq), hub_seq)
        return True

    def connected_registration(self, agent, ws):
        """H3.1: the hub registered this socket; for a maker Studio owns, record its captured epoch and the connection
        nonce (proof b)."""
        if not getattr(self, "enabled", False) or not self.studio_owns(agent["id"]):
            return
        nonce = self.hive.boot_nonce.get(agent["id"]) if self.hive.connections.get(agent["id"]) is ws else None
        if nonce is None:
            return
        with self.hive.db.transaction():
            self.hive.db.execute("INSERT OR REPLACE INTO studio_hub_registrations (agent_id, epoch, nonce, at) VALUES "
                                 "(?,?,?,?)", (agent["id"], agent.get("token_epoch"), nonce, now()))

    def disconnected(self, agent_id):
        if not getattr(self, "enabled", False):
            return
        with self.hive.db.transaction():
            self.hive.db.execute("DELETE FROM studio_hub_registrations WHERE agent_id = ?", (agent_id,))

    # ---- locks -----------------------------------------------------------------------------------------------------

    @contextlib.contextmanager
    def _owned(self, maker_id):
        """The handoff owner (§1): non-blocking; a job that can't take it exits at once (resubmitted on a later tick)."""
        with self._owners_guard:
            lock = self._owners.setdefault(maker_id, threading.Lock())
        got = lock.acquire(blocking=False)
        try:
            yield got
        finally:
            if got:
                lock.release()

    def _transition(self, maker_id):
        sup = self.hive.supervisor
        if callable(getattr(sup, "transition", None)):
            return sup.transition(maker_id)
        if callable(getattr(sup, "lock", None)):
            return sup.lock(maker_id)
        return contextlib.nullcontext()

    def _verified_stop(self, maker_id):
        """stop + verify_stopped (adopted groups included, H2); raises when there is no positive proof."""
        sup = self.hive.supervisor
        sup.stop(maker_id)
        self._verify(maker_id)

    STATUS_WORDS = ("running", "exited", "absent", "stopped", "starting", "unknown")

    def _status_word(self, maker_id):
        """Kimi R3 #5: the person sees only the driver's status word; the raw exception text stays in the log.
        r3.2 (stand-in R3.1 #1): the driver's status() may block on process or Docker I/O (Docker's subprocess has no
        timeout), so it is never called inside a database transaction, and it is bounded here: it runs on its own daemon
        thread and an answer later than STATUS_TIMEOUT_S reads "unknown" (the thread is left to finish; the driver itself
        is unchanged)."""
        # Kimi R3.2 F2: at most one probe per maker. While an earlier read is still parked, no second thread is started;
        # the word is "unknown" (bounded threads, whatever the call rate)
        probes = self.__dict__.setdefault("_status_probes", {})
        earlier = probes.get(maker_id)
        if earlier is not None and earlier.is_alive():
            earlier.join(STATUS_TIMEOUT_S)
            if earlier.is_alive():
                return "unknown"                     # still parked: keep it, start nothing (Kimi R5 #2)
            word = earlier.answer[0] if earlier.answer else "unknown"
            return word if word in self.STATUS_WORDS else "unknown"   # it just answered: use it, start nothing
        answer = []

        def ask():
            try:
                sup = self.hive.supervisor
                answer.append(sup.driver(sup._agent(maker_id)).status(maker_id))
            except Exception:   # noqa: BLE001
                answer.append("unknown")
        probe = threading.Thread(target=ask, daemon=True, name=f"studio-status-{maker_id}")
        probe.answer = answer
        probes[maker_id] = probe
        probe.start()
        probe.join(STATUS_TIMEOUT_S)
        word = answer[0] if answer else "unknown"
        return word if word in self.STATUS_WORDS else "unknown"

    def _verify(self, maker_id):
        verify = getattr(self.hive.supervisor, "verify_stopped", None)
        if not callable(verify):
            raise RuntimeError("this supervisor cannot verify a stop")
        verify(maker_id)

    # ---- shared DB pieces (callers hold a transaction) ---------------------------------------------------------------

    def _fence_epoch(self, maker_id, epoch, session_id, reason):
        """§4 job A step 4 / §5.2 step 2: fence (maker, k), release reserved reservations of epoch <= k, and mark every
        admitted-but-unreported step of epoch <= k interrupted (its directions back to the queue when unpublished)."""
        db = self.hive.db
        stamp = now()
        execution = self._boundary(maker_id)[1] or ""
        db.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, step, "
                   "reason, at) VALUES (?,?,?,?,?,?,?)", (maker_id, epoch, execution, session_id, None, reason, stamp))
        for r in self.open_reservations(maker_id, epoch):
            if r["state"] == "reserved":
                # abort_before_dispatch (cost_reservations.py), conditional: a dispatch that won keeps its row
                db.execute("UPDATE cost_reservations SET state = 'released' WHERE id = ? AND state = 'reserved'", (r["id"],))
        for step in db.all("SELECT s.* FROM studio_steps s JOIN studio_sessions x ON x.id = s.session_id WHERE "
                           "x.maker_id = ? AND s.state = 'admitted' AND s.token_epoch <= ? AND s.outcome IS NULL",
                           (maker_id, epoch)):
            db.execute("UPDATE studio_steps SET state = 'interrupted', closed_at = ? WHERE session_id = ? AND n = ? AND "
                       "state = 'admitted'", (stamp, step["session_id"], step["n"]))
            db.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, "
                       "step, reason, at) VALUES (?,?,?,?,?,?,?)", (maker_id, step["token_epoch"], step["maker_execution"],
                                                                    step["session_id"], step["n"], "interrupted", stamp))
            if step["proposal_n"] is None:
                self._requeue(step["session_id"], step["n"])
            self._step_event(step["session_id"], step["n"], "closed")

    def unknown_move(self, maker_id, k=None):
        """§4 the conditional dispatched -> unknown move; rowcount 0 means it settled concurrently (success). R4: of
        epoch <= k."""
        db = self.hive.db
        moved = 0
        for r in self.open_reservations(maker_id, k):
            if r["state"] == "dispatched":
                moved += db.execute("UPDATE cost_reservations SET state = 'unknown', unknown_at = COALESCE(unknown_at, ?) "
                                    "WHERE id = ? AND state = 'dispatched'", (time.time(), r["id"])).rowcount
        return moved

    def _hold_row(self, row_id, reason):
        """An open row -> held <reason>; its live session holds with the same reason. Never reopened automatically."""
        db = self.hive.db
        with db.transaction():
            row = self._handoff(row_id)
            if row is None or row["state"] not in OPEN_ROWS:
                return False
            db.execute("UPDATE studio_handoffs SET state = 'held', reason = ?, updated_at = ? WHERE id = ? AND state = ?",
                       (reason, now(), row_id, row["state"]))
            ses = self._session(row["session_id"])
            if ses is not None and ses["state"] in LIVE:
                self._set_state(ses["id"], "held", reason)
        return False

    def _job_ref(self, kind, ref):
        return {"kind": kind, "ref": ref}

    def _repair(self, maker_id, session_id=None):
        """§3 repair at the start of a job; a credential_missing result is a display reason only."""
        status = repair(self._root(maker_id), self._epoch(maker_id), self._db_hash(maker_id))
        if status == "credential_missing" and session_id:
            with self.hive.db.transaction():
                self.hive.db.execute("UPDATE studio_sessions SET credential_reason = 'credential_missing' WHERE id = ?",
                                     (session_id,))
        return status

    def _prepare_files(self, maker_id, epoch, recorded, record):
        """§3 prepare, owner only, no mind lock: reuse a pending file whose hash is the recorded one; otherwise a fresh
        token whose hash is recorded first (record(hash) in its own transaction), then the files."""
        root = self._root(maker_id)
        if recorded and file_hash(pending_file(root, epoch)) == recorded:
            ensure_pointer_tmp(root, epoch)
            return recorded
        token, digest = new_token()
        with self.hive.db.transaction():
            record(digest)
        write_pending(root, epoch, token)
        return digest

    def _rotate_to(self, maker_id, expected, digest):
        """G3 compare-and-swap on one row, in the caller's transaction. Returns True when it moved."""
        return self.hive.db.execute("UPDATE agents SET token_hash = ?, token_epoch = token_epoch + 1 WHERE id = ? AND "
                                    "token_epoch = ? AND deleted = 0", (digest, maker_id, expected)).rowcount == 1

    # ---- §4 an attempt -----------------------------------------------------------------------------------------------

    def has_work(self, ses):
        """§4 "new admissible work": step 1 once a current piece exists; after a closed step, more=1, the one
        re-admission of an unread step, or queued directions, with its published revision settled (G5b: no work, no
        restart)."""
        from .studio_steps import TERMINAL
        if self.piece_state(ses) != "current" or _passed(ses["expires_at"]):
            return False
        steps = self._steps(ses["id"])
        if len(steps) >= ses["max_steps"]:
            return False
        last = steps[-1] if steps else None
        if last is None:
            return True
        if last["state"] == "admitted" or (last["proposal_n"] is not None and last["outcome"] not in TERMINAL):
            return False
        return last["more"] == 1 or (last["state"] == "timed_out_unread" and last["readmit_of"] is None) \
            or bool(self._queued(ses["id"]))

    def retries_this_hour(self, session_id):
        hour_ago = rfc3339_ms(_utc() - datetime.timedelta(hours=1))
        return self.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ? AND attempt > 1 AND "
                                "created_at > ?", (session_id, hour_ago))["n"]

    def open_attempt(self, session_id, explicit=False, override=False):
        """§4 opening, in one transaction: the session live (active), its latest row done or none (a held latest row
        only by an explicit action), new admissible work, and the J6 budget (r2.5 §4: only retries count, 3 per rolling hour;
        past it only {override:true}). Inserts the row in_progress from the DB epoch; returns its id."""
        if not getattr(self, "enabled", False):
            return None
        db = self.hive.db
        with db.transaction():
            ses = self._session(session_id)
            if ses is None or ses["state"] != "active":
                return None
            latest = self._latest_handoff(session_id)
            # a held latest row reopens only by an explicit action; Stop's own `held stopped` row never blocks anything
            # later (r2.5 §4, Kimi R3 #1)
            if latest is not None and (latest["state"] in OPEN_ROWS or (latest["state"] == "held" and not explicit
                                                                        and latest["reason"] != "stopped")):
                return None
            if self._open_step(session_id) is not None or not self.has_work(ses):
                return None
            if self._open_handoff_of(ses["maker_id"]) is not None:
                return None
            steps = self._steps(session_id)
            step_n = (steps[-1]["n"] if steps else 0) + 1
            attempt = db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ? AND step_n = ?",
                             (session_id, step_n))["n"] + 1
            # spec r2.5 §4 (Platform ruling 2026-10-18): only retries count against J6. A retry is a second or later
            # attempt for the same step (the same pending work); the first handoff of each new step never counts
            if attempt > 1 and self.retries_this_hour(session_id) >= ATTEMPTS_PER_HOUR and not override:
                self._set_state(session_id, "held", "handoff_retry_exhausted")
                return None
            k = self._epoch(ses["maker_id"])
            row_id = "ho_" + secrets.token_hex(10)
            stamp = now()
            db.insert("studio_handoffs", {"id": row_id, "maker_id": ses["maker_id"], "session_id": session_id,
                                          "step_n": step_n, "attempt": attempt, "from_epoch": k, "to_epoch": k + 1,
                                          "token_hash": None, "state": "in_progress", "owner_boot": self.boot,
                                          "deadline": None, "window_s": PROOF_WINDOW_S * 2 ** min(attempt - 1, 4),
                                          "reason": None, "override": 1 if override else 0,
                                          "created_at": stamp, "updated_at": stamp})
            db.execute("UPDATE studio_sessions SET current_handoff = ?, updated_at = ? WHERE id = ?",
                       (row_id, stamp, session_id))
        self.worker.submit(ses["maker_id"], "attempt", "A", lambda: self.job_a(row_id), row_id)
        return row_id

    def job_a(self, row_id):
        """§4 job A: repair; prepare k+1 (no lock; a failure leaves the maker running on k, unfenced); under transition a
        verified stop and, in one transaction, the fence of k, the release of reserved, the interrupted marks and
        settling with a 660 s deadline."""
        db = self.hive.db
        row = self._handoff(row_id)
        if row is None:
            return
        maker = row["maker_id"]
        with self._owned(maker) as got:
            if not got:
                return
            self._repair(maker, row["session_id"])
            row, ses = self._handoff(row_id), self._session(row["session_id"])
            if row["state"] != "in_progress" or ses is None or ses["state"] in ("stopping", ENDED):
                return
            k = self._epoch(maker)
            if k != row["from_epoch"]:
                return self._hold_row(row_id, "handoff_stale")

            def record(digest):
                db.execute("UPDATE studio_handoffs SET token_hash = ?, updated_at = ? WHERE id = ?", (digest, now(), row_id))
            try:
                self._prepare_files(maker, k + 1, row["token_hash"], record)
            except Exception as exc:   # noqa: BLE001
                log.warning("studio handoff %s: credential write failed: %s", row_id, exc)
                return self._hold_row(row_id, "credential_write_failed")
            with self._transition(maker):
                ses = self._session(row["session_id"])
                if ses["state"] in ("stopping", ENDED) or self._handoff(row_id)["state"] != "in_progress":
                    return                                      # Stop committed meanwhile: job S stops and releases
                before = self._boundary(maker)[0]
                try:
                    self._verified_stop(maker)
                except Exception as exc:   # noqa: BLE001  (the driver raised: something may have survived)
                    log.warning("studio handoff %s: verified stop failed: %s", row_id, exc)
                    return self._hold_row(row_id, "execution_retirement_failed")
                with db.transaction():
                    if self._handoff(row_id)["state"] != "in_progress":
                        return
                    self._fence_epoch(maker, k, row["session_id"], "handoff")
                    db.execute("UPDATE studio_handoffs SET state = 'settling', deadline = ?, boundary_before = ?, "
                               "updated_at = ? WHERE id = ? AND state = 'in_progress'",
                               (_after(SETTLE_S), before, now(), row_id))
                    db.execute("UPDATE agents SET status = 'stopped' WHERE id = ?", (maker,))

    def job_b(self, row_id):
        """§4 job B: revalidate; under transition verify_stopped, the install authorisation (rotate CAS + installing,
        requiring the session live), renames, the start authorisation (starting, requiring live), start, awaiting_proof;
        then the directory fsync outside the lock."""
        db = self.hive.db
        row = self._handoff(row_id)
        if row is None:
            return
        maker, attempt, k = row["maker_id"], row["attempt"], row["from_epoch"]
        with self._owned(maker) as got:
            if not got:
                return
            self._repair(maker, row["session_id"])
            with db.transaction():
                row, ses = self._handoff(row_id), self._session(row["session_id"])
                if row["state"] != "settling" or row["attempt"] != attempt or row["from_epoch"] != k:
                    return
                if ses is None or ses["state"] not in LIVE:
                    return
                if self._epoch(maker) != k or not row["token_hash"]:
                    stale = True
                else:
                    stale = False
                    if _passed(row["deadline"]):
                        self.unknown_move(maker, k)
                    if self.open_reservations(maker, k):
                        return
            if stale:
                return self._hold_row(row_id, "handoff_stale")
            root = self._root(maker)
            if file_hash(pending_file(root, k + 1)) != row["token_hash"]:
                # §3 prepare's reuse rule: a pending file that no longer hashes to the recorded one is re-prepared (a new
                # token, its hash recorded first) before anything is installed; the epoch still advances only at the rotate
                def record(digest):
                    db.execute("UPDATE studio_handoffs SET token_hash = ?, updated_at = ? WHERE id = ? AND state = 'settling'",
                               (digest, now(), row_id))
                try:
                    self._prepare_files(maker, k + 1, None, record)
                except Exception as exc:   # noqa: BLE001
                    log.warning("studio handoff %s: credential re-prepare failed: %s", row_id, exc)
                    return self._hold_row(row_id, "credential_write_failed")
                row = self._handoff(row_id)
            with self._transition(maker):
                try:
                    self._verify(maker)
                except Exception as exc:   # noqa: BLE001
                    log.warning("studio handoff %s: verify_stopped raised: %s", row_id, exc)
                    return self._hold_row(row_id, "execution_retirement_failed")
                with db.transaction():                          # install authorisation (linearised against Stop)
                    row, ses = self._handoff(row_id), self._session(row["session_id"])
                    if ses["state"] not in LIVE or row["state"] != "settling" or row["attempt"] != attempt:
                        return
                    if not self._rotate_to(maker, k, row["token_hash"]):
                        conflict = True
                    else:
                        conflict = False
                        db.execute("UPDATE studio_handoffs SET state = 'installing', updated_at = ? WHERE id = ? AND "
                                   "state = 'settling'", (now(), row_id))
                if conflict:
                    return self._hold_row(row_id, "rotation_conflict")
                try:
                    install(root, k + 1, row["token_hash"])
                except Exception as exc:   # noqa: BLE001
                    log.warning("studio handoff %s: renames failed: %s", row_id, exc)
                    return self._hold_row(row_id, "credential_missing")
                with db.transaction():                          # start authorisation
                    ses = self._session(row["session_id"])
                    if ses["state"] not in LIVE or self._handoff(row_id)["state"] != "installing":
                        return                                  # Stop won: never start; S fences k+1, releases to k+2
                    db.execute("UPDATE studio_handoffs SET state = 'starting', updated_at = ? WHERE id = ?", (now(), row_id))
                    db.execute("UPDATE agents SET desired = 'awake', status = 'starting', last_active_at = ? WHERE id = ?",
                               (now(), maker))
                try:
                    self.hive.supervisor.start(maker)
                except Exception as exc:   # noqa: BLE001
                    log.warning("studio handoff %s: start failed: %s", row_id, exc)
                    return self._hold_row(row_id, "restart_failed")
                with db.transaction():
                    db.execute("UPDATE studio_handoffs SET state = 'awaiting_proof', deadline = ?, updated_at = ? WHERE "
                               "id = ? AND state = 'starting'", (_after(row["window_s"]), now(), row_id))
            try:
                dir_fsync(root)
            except Exception as exc:   # noqa: BLE001  (repair restores the files by hash from the pending names)
                log.warning("studio handoff %s: directory fsync failed: %s", row_id, exc)

    def _proofs(self, h):
        """(a) a new, non-adopted boundary differing from the one at the stop; (b) a registration with epoch k+1 whose
        nonce is the current connection's. Returns (boundary execution, registration nonce) or None."""
        seq, execution = self._boundary(h["maker_id"])
        if h["boundary_before"] is None or seq <= h["boundary_before"] or not execution \
                or str(execution).endswith(":adopted"):
            return None
        reg = self.hive.db.one("SELECT * FROM studio_hub_registrations WHERE agent_id = ?", (h["maker_id"],))
        if reg is None or reg["epoch"] != h["to_epoch"] or reg["nonce"] != self.hive.boot_nonce.get(h["maker_id"]):
            return None
        return execution, reg["nonce"]

    def admit_from(self, row_id):
        """§4 admission, one transaction: both proofs, agents.token_epoch == k+1, the G1/§3.4 conditions and zero
        reservations of epoch <= k. Inserts step n+1 bound to (k+1, delivery_id, delivery_nonce), sets the row done and
        queues the cleanup. The delivery task is created after the commit. Returns the step row or None."""
        import json
        from .minds import canonical
        db = self.hive.db
        with db.transaction():
            h = self._handoff(row_id)
            if h is None or h["state"] != "awaiting_proof":
                return None
            proofs = self._proofs(h)
            if proofs is None:
                return None
            if not h["proven_at"]:
                db.execute("UPDATE studio_handoffs SET proven_at = ? WHERE id = ?", (now(), row_id))
            execution, nonce = proofs
            maker = h["maker_id"]
            if self._epoch(maker) != h["to_epoch"] or self.open_reservations(maker, h["from_epoch"]):
                return None
            self._expire(h["session_id"])
            ses = self._session(h["session_id"])
            if self._admissible(ses) is not None:
                return None
            drift = self._drift(ses)
            if drift:
                self._set_state(ses["id"], "held", "binding_drift:" + drift)
                return None
            refused = self._budget_room(ses)
            if refused:
                self._set_state(ses["id"], "paused", refused[0])
                return None
            steps = self._steps(ses["id"])
            last = steps[-1] if steps else None
            n = (last["n"] if last else 0) + 1
            execution_id = "ex_" + secrets.token_hex(12)
            delivery_id = "dl_" + secrets.token_hex(12)
            stamp = now()
            queued = [d["studio_seq"] for d in self._queued(ses["id"])]
            db.insert("studio_steps", {"session_id": ses["id"], "n": n, "state": "admitted", "execution_id": execution_id,
                                       "token_epoch": h["to_epoch"], "maker_execution": execution,
                                       "readmit_of": last["n"] if (last and last["state"] == "timed_out_unread") else None,
                                       "admitted_at": stamp, "deadline": _after(ses["step_window_s"]),
                                       "message_id": delivery_id, "direction_seqs": canonical(queued),
                                       "delivery_id": delivery_id, "delivery_nonce": nonce})
            if queued:
                db.execute("UPDATE ask_steers SET studio_step = ?, delivery_message_id = ? WHERE studio_session_id = ? "
                           "AND studio_step IS NULL AND studio_cancelled_at IS NULL", (n, delivery_id, ses["id"]))
            db.execute("UPDATE studio_handoffs SET state = 'done', updated_at = ? WHERE id = ?", (stamp, row_id))
            db.execute("UPDATE studio_sessions SET execution_state = 'in_step', ready_epoch = ?, ready_execution = ?, "
                       "ready_at = ?, updated_at = ? WHERE id = ?", (h["to_epoch"], execution, stamp, stamp, ses["id"]))
            db.execute("INSERT OR REPLACE INTO studio_cleanups (maker_id, keep_epoch, at) VALUES (?,?,?)",
                       (maker, h["to_epoch"], stamp))
            self._step_event(ses["id"], n, "admitted")
            frame = json.dumps({"type": "studio_step", "session_id": ses["id"], "step": n, "epoch": h["to_epoch"],
                                "delivery_id": delivery_id, "execution_id": execution_id})
        self._start_delivery(ses["id"], n, maker, delivery_id, nonce, frame)
        held = self._held_from.pop(maker, None)
        if held is not None:
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(self.hive.replay(maker, held - 1))
        return self._step(ses["id"], n)

    # ---- §6 delivery -----------------------------------------------------------------------------------------------

    def _start_delivery(self, session_id, n, maker, delivery_id, nonce, frame):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        coro = self._deliver(session_id, n, maker, delivery_id, nonce, frame)
        if loop is None:                       # no loop (a worker thread or a plain call): run it to completion here
            asyncio.run(coro)
            return
        self.deliveries[(session_id, n)] = loop.create_task(coro)

    async def _deliver(self, session_id, n, maker, delivery_id, nonce, frame):
        try:
            while self._sends >= SENDS_IN_FLIGHT:            # waiting for a slot blocks nothing; the budget starts after
                await asyncio.sleep(0.02)
            self._sends += 1
            try:
                result = await self._send(maker, nonce, frame)
            finally:
                self._sends -= 1
            self.delivery_outcome(session_id, n, delivery_id, result)
        finally:
            self.deliveries.pop((session_id, n), None)

    def _conn_lock(self, maker):
        lock = getattr(self.hive.supervisor, "lock", None)
        return lock(maker) if callable(lock) else None

    async def _send(self, maker, nonce, frame):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DELIVERY_BUDGET_S
        lock = self._conn_lock(maker)
        while True:                          # §6.1: never a blocking acquire on the event loop
            if lock is None or lock.acquire(blocking=False):
                try:
                    ws, current = self.hive.connections.get(maker), self.hive.boot_nonce.get(maker)
                finally:
                    if lock is not None:
                        lock.release()
                break
            if loop.time() + DELIVERY_RETRY_S >= deadline:
                return "delivery_uncertain"
            await asyncio.sleep(DELIVERY_RETRY_S)
        if ws is None or current != nonce:
            return "delivery_uncertain"
        try:
            await asyncio.wait_for(ws.send_text(frame), max(0.0, deadline - loop.time()))
            return "delivered"
        except (asyncio.TimeoutError, TimeoutError):
            return "maker_unresponsive"
        except Exception:   # noqa: BLE001  (a disconnect from withdraw_connection included)
            return "delivery_uncertain"

    def delivery_outcome(self, session_id, n, delivery_id, result):
        """§6 outcome writes, each conditional on the exact admission: a newer state, a finished outcome, a stopping,
        ended, released or superseded session is never touched."""
        db = self.hive.db
        with db.transaction():
            if result == "delivered":
                db.execute("UPDATE studio_steps SET delivered_at = ?, delivery_outcome = 'delivered' WHERE session_id = ? "
                           "AND n = ? AND delivery_id = ? AND delivered_at IS NULL AND state IN ('admitted', 'finished')",
                           (now(), session_id, n, delivery_id))
                return
            moved = db.execute("UPDATE studio_steps SET state = 'interrupted', delivery_outcome = ?, closed_at = ? WHERE "
                               "session_id = ? AND n = ? AND delivery_id = ? AND state = 'admitted' AND outcome IS NULL "
                               "AND delivered_at IS NULL",
                               (result, now(), session_id, n, delivery_id)).rowcount
            if moved != 1:
                return
            step, ses = self._step(session_id, n), self._session(session_id)
            db.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, "
                       "step, reason, at) VALUES (?,?,?,?,?,?,?)", (ses["maker_id"], step["token_epoch"],
                                                                    step["maker_execution"], session_id, n, result, now()))
            if step["proposal_n"] is None:
                self._requeue(session_id, n)
            latest = self._latest_handoff(session_id)
            held = db.execute("UPDATE studio_sessions SET state = 'held', state_reason = ?, updated_at = ? WHERE id = ? "
                              "AND state IN ('active', 'paused') AND current_handoff = ? AND maker_released = 0",
                              (result, now(), session_id, latest["id"] if latest else "")).rowcount
            self._step_event(session_id, n, "closed")
            if held:
                self._session_event(session_id)

    async def settle_deliveries(self):
        """Tests and shutdown: wait for the open delivery tasks."""
        while self.deliveries:
            await asyncio.gather(*list(self.deliveries.values()), return_exceptions=True)

    # ---- §5 Stop ---------------------------------------------------------------------------------------------------

    def stop_session(self, session_id):
        """§5.1, in the caller's transaction: from live or held, the session stopping (780 s deadline), queued
        directions cancelled, admitted steps stopped and their epochs fenced (G1 refuses at once), any open handoff row
        closed held stopped. Idempotent for stopping or ended. Returns True when job S should be submitted."""
        db = self.hive.db
        ses = self._session(session_id)
        if ses["state"] in ("stopping", ENDED):
            return ses["state"] == "stopping"
        if ses["state"] not in ("active", "paused", "held"):
            raise self._err(409, "session_closed", "That Studio session has ended.", state=ses["state"])
        stamp = now()
        db.execute("UPDATE studio_sessions SET state = 'stopping', state_reason = 'stopped', stopping_deadline = ?, "
                   "stop_verified = 0, stop_failed = 0, release_stale = 0, fenced_at = COALESCE(fenced_at, ?), "
                   "updated_at = ? WHERE id = ?", (_after(STOPPING_S), stamp, stamp, session_id))
        # R5 (plan §5): the goal is cancelled in the fence's transaction (a terminal state; a finished goal is left as it
        # is). R8.5 (live 2026-10-20): the host settles it there too, as the host actor, and the maker is sent no
        # GOAL-CANCELLED: its step is fenced and job S stops it, so there is nothing for it to stop or acknowledge, and a
        # stored notice was read first by the maker's NEXT session (a personal maker's role denies the ack skill), which
        # spent its whole step 1 on it. Only the goal's update event follows the commit.
        from .studio_makers import HOST_ACTOR
        cancelled = db.execute("UPDATE goals SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN "
                               "('open', 'claimed', 'waiting', 'stalled', 'submitted')", (stamp, ses["goal_id"])).rowcount
        settled = db.execute("UPDATE goals SET cancel_ack_at = ?, cancel_ack_by = ? WHERE id = ? AND status = 'cancelled' "
                             "AND cancel_ack_at IS NULL", (stamp, HOST_ACTOR, ses["goal_id"])).rowcount
        if cancelled or settled:
            db.after_commit(lambda gid=ses["goal_id"]: self._goal_cancelled(gid))
        db.execute("UPDATE ask_steers SET studio_cancelled_at = ? WHERE studio_session_id = ? AND studio_step IS NULL "
                   "AND studio_cancelled_at IS NULL", (stamp, session_id))
        for step in db.all("SELECT * FROM studio_steps WHERE session_id = ? AND state = 'admitted'", (session_id,)):
            db.execute("UPDATE studio_steps SET state = 'stopped', closed_at = ? WHERE session_id = ? AND n = ? AND "
                       "state = 'admitted'", (stamp, session_id, step["n"]))
            db.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, "
                       "step, reason, at) VALUES (?,?,?,?,?,?,?)", (ses["maker_id"], step["token_epoch"],
                                                                    step["maker_execution"], session_id, step["n"],
                                                                    "stopped", stamp))
            self._step_event(session_id, step["n"], "closed")
        db.execute("UPDATE studio_handoffs SET state = 'held', reason = 'stopped', updated_at = ? WHERE session_id = ? "
                   "AND state IN ('in_progress', 'settling', 'installing', 'starting', 'awaiting_proof')",
                   (stamp, session_id))
        self._session_event(session_id)
        return True

    def _goal_cancelled(self, goal_id):
        """After Stop's commit: the goal's update event only. R8.5: no GOAL-CANCELLED to the maker (Stop settled the goal
        as the host); the ledger and goal row are the record."""
        with contextlib.suppress(Exception):
            self.hive.goals._emit(goal_id)

    def stale_goal_notice(self, agent_id, message):
        """R8.5: whether ``message`` is a goal-cancelled notice for a stopping or ended Studio session's own goal,
        addressed to that session's maker. Such a notice is never delivered (Hive.deliver: live and hub replay alike): Stop settles that
        goal as the host, and a notice stored before R8.5 must not pre-empt a later session's step. Read-only; the stored
        message is kept. Every other message, and every other mind, is unaffected."""
        if str(message.get("sender") or "") != "hive:goals" or not message.get("extra"):
            return False
        try:
            extra = json.loads(message["extra"]) if isinstance(message["extra"], str) else message["extra"]
        except (TypeError, ValueError):
            return False
        if not isinstance(extra, dict) or extra.get("event") != "goal_cancelled" or not extra.get("goal_id"):
            return False
        try:
            # R8.5 r1 (Kimi): only a goal the host has settled (or that was acknowledged) is dropped, so a cancel ack is never
            # silently owed; startup recovery settles the cancelled goals of sessions ended before R8.5 (studio_sessions).
            return self.hive.db.one("SELECT 1 FROM studio_sessions s JOIN goals g ON g.id = s.goal_id WHERE s.goal_id = ? "
                                    "AND s.maker_id = ? AND s.state IN (?, ?) AND g.cancel_ack_at IS NOT NULL",
                                    (str(extra["goal_id"]), agent_id, "stopping", ENDED)) is not None
        except Exception:   # noqa: BLE001  (no Studio tables: nothing is a Studio notice)
            return False

    def submit_stop(self, session_id):
        ses = self._session(session_id)
        if ses is None:
            return False
        return self.worker.submit(ses["maker_id"], "S", "S", lambda: self.job_s(session_id), session_id)

    def finish_stopping(self, session_id):
        """§5.3, in the caller's transaction: clear both flags, a new 780 s deadline; the caller submits S once. Kimi R3.1
        #2: while a job for the maker is still outstanding a press changes nothing (no flag, deadline or count churn).
        Returns True when it reset the session (so S should be submitted)."""
        ses = self._session(session_id)
        if ses["state"] != "stopping":
            raise self._err(409, "not_stopping", "That Studio session is not stopping.", state=ses["state"])
        if self.worker.outstanding(ses["maker_id"]):
            return False
        self.hive.db.execute("UPDATE studio_sessions SET stop_failed = 0, release_stale = 0, stopping_deadline = ?, "
                             "finish_count = finish_count + 1, updated_at = ? WHERE id = ?",
                             (_after(STOPPING_S), now(), session_id))
        return True

    def job_s(self, session_id):
        """§5.2 job S: repair; the verified stop (once, stop_verified); settle against its own 660 s settle_deadline;
        the release (prepare -> installed -> durable, persisted, so a crash never causes a second release rotation);
        the conditional final commit releasing the maker; old files deleted."""
        db = self.hive.db
        ses = self._session(session_id)
        if ses is None:
            return
        maker = ses["maker_id"]
        with self._owned(maker) as got:
            if not got:
                return
            self._repair(maker, session_id)
            ses = self._session(session_id)
            if ses["state"] != "stopping" or ses["stop_failed"]:
                return
            if not ses["stop_verified"]:                                       # step 2
                with self._transition(maker):
                    k = self._epoch(maker)
                    try:
                        self._verified_stop(maker)
                    except Exception as exc:   # noqa: BLE001
                        log.warning("studio stop %s: the maker could not be stopped: %s", session_id, exc)
                        word = self._status_word(maker)          # r3.2: driver I/O before, never inside, a transaction
                        with db.transaction():
                            db.execute("UPDATE studio_sessions SET stop_failed = 1, stop_status = ?, updated_at = ? WHERE "
                                       "id = ?", (word, now(), session_id))
                        return
                    with db.transaction():
                        if self._session(session_id)["state"] != "stopping":
                            return
                        db.execute("UPDATE agents SET desired = 'asleep', status = 'asleep' WHERE id = ?", (maker,))
                        self._fence_epoch(maker, k, session_id, "stopped")
                        db.execute("UPDATE studio_sessions SET stop_verified = 1, settle_deadline = ?, stop_status = NULL, "
                                   "updated_at = ? WHERE id = ?", (_after(SETTLE_S), now(), session_id))
                with contextlib.suppress(Exception):
                    self.hive.emit_agent(maker)
            with db.transaction():                                             # step 3
                ses = self._session(session_id)
                k = self._epoch(maker)                 # the fenced epoch, or (after a release rotation) above it
                if _passed(ses["settle_deadline"]):
                    self.unknown_move(maker, k)
                if self.open_reservations(maker, k):
                    return
            root = self._root(maker)
            if not self._release(session_id, maker, root):
                return
            self._finish_release(session_id, maker, root)

    def _files_match(self, maker, root, epoch):
        return epoch is not None and file_hash(token_file(root, epoch)) == self._db_hash(maker) \
            and _read_epoch(pathlib.Path(root) / "current") == epoch

    def _phase_reset(self, session_id):
        """§5.2a after a proven credential loss: the only second release rotation."""
        with self.hive.db.transaction():
            self.hive.db.execute("UPDATE studio_sessions SET release_phase = 'none', release_epoch = NULL, "
                                 "release_token_hash = NULL, credential_reason = 'credential_missing', updated_at = ? "
                                 "WHERE id = ?", (now(), session_id))

    def _release(self, session_id, maker, root):
        """§5.2 steps 4-5. True when the release is installed (go to step 6)."""
        db = self.hive.db
        ses = self._session(session_id)
        k = self._epoch(maker)
        if ses["release_phase"] in ("installed", "durable"):
            if k == ses["release_epoch"] and self._files_match(maker, root, k):
                return True
            self._repair(maker, session_id)
            if k == ses["release_epoch"] and self._files_match(maker, root, k):
                return True
            self._phase_reset(session_id)
            ses = self._session(session_id)
        # step 4: prepare for k+1, reusing a valid pending file
        def record(digest):
            db.execute("UPDATE studio_sessions SET release_token_hash = ? WHERE id = ?", (digest, session_id))
        try:
            digest = self._prepare_files(maker, k + 1, ses["release_token_hash"] if ses["release_epoch"] in (None, k + 1)
                                         else None, record)
        except Exception as exc:   # noqa: BLE001
            log.warning("studio stop %s: release prepare failed: %s", session_id, exc)
            with db.transaction():
                db.execute("UPDATE studio_sessions SET credential_reason = 'credential_write_failed' WHERE id = ?",
                           (session_id,))
            return False
        with db.transaction():
            db.execute("UPDATE studio_sessions SET release_epoch = ?, release_phase = 'prepared', release_token_hash = ?, "
                       "updated_at = ? WHERE id = ?", (k + 1, digest, now(), session_id))
        # step 5, under transition
        with self._transition(maker):
            ses = self._session(session_id)
            if ses["state"] != "stopping" or not ses["stop_verified"]:
                return False
            try:
                self._verify(maker)
            except Exception as exc:   # noqa: BLE001
                log.warning("studio stop %s: verify_stopped raised before the release: %s", session_id, exc)
                word = self._status_word(maker)                  # r3.2: driver I/O before, never inside, a transaction
                with db.transaction():
                    db.execute("UPDATE studio_sessions SET stop_failed = 1, stop_verified = 0, stop_status = ?, "
                               "updated_at = ? WHERE id = ?", (word, now(), session_id))
                return False
            if self._epoch(maker) != k:
                self._repair(maker, session_id)
                now_k = self._epoch(maker)
                if now_k == ses["release_epoch"] and self._files_match(maker, root, now_k):
                    return True
                self._phase_reset(session_id)
                return False
            with db.transaction():
                moved = self._rotate_to(maker, k, digest)
                if moved:
                    db.execute("UPDATE studio_sessions SET release_phase = 'installed', updated_at = ? WHERE id = ?",
                               (now(), session_id))
                else:
                    db.execute("UPDATE studio_sessions SET release_stale = 1, updated_at = ? WHERE id = ?",
                               (now(), session_id))
            if not moved:
                return False
            try:
                install(root, k + 1, digest)
            except Exception as exc:   # noqa: BLE001
                log.warning("studio stop %s: release renames failed: %s", session_id, exc)
                with db.transaction():
                    db.execute("UPDATE studio_sessions SET credential_reason = 'credential_missing' WHERE id = ?",
                               (session_id,))
                return False
        return True

    def _finish_release(self, session_id, maker, root):
        """§5.2 step 6, owner only: directory fsync -> durable; the conditional final commit; old files deleted."""
        db = self.hive.db
        try:
            dir_fsync(root)
        except Exception as exc:   # noqa: BLE001  (stay installed; the next S re-attempts the fsync only)
            log.warning("studio stop %s: directory fsync failed: %s", session_id, exc)
            return
        with db.transaction():
            db.execute("UPDATE studio_sessions SET release_phase = 'durable', updated_at = ? WHERE id = ? AND "
                       "release_phase IN ('installed', 'durable')", (now(), session_id))
        _hook("final", root)
        k = self._epoch(maker)
        if not self._files_match(maker, root, k):
            return                              # ownership clears only once token-e<current> is the DB's credential
        with db.transaction():
            db.execute("UPDATE studio_sessions SET maker_released = 1, state = ?, stopped_at = ?, updated_at = ? WHERE "
                       "id = ? AND state = 'stopping'", (ENDED, now(), now(), session_id))
            self._session_event(session_id)
        cleanup(root, k)

    def job_cleanup(self, maker_id):
        """A queued cleanup (admission or release): old token-e<i < keep> files. Worker only, under the owner."""
        db = self.hive.db
        with self._owned(maker_id) as got:
            if not got:
                return
            row = db.one("SELECT * FROM studio_cleanups WHERE maker_id = ?", (maker_id,))
            if row is None:
                return
            keep = min(row["keep_epoch"], self._epoch(maker_id))
            cleanup(self._root(maker_id), keep)
            with db.transaction():
                db.execute("DELETE FROM studio_cleanups WHERE maker_id = ? AND keep_epoch = ?", (maker_id, row["keep_epoch"]))

    # ---- the sweep (§1, §4, §5.3) ------------------------------------------------------------------------------------

    def boot_fence(self):
        """§4 interrupted boot: an open row of another owner_boot -> held handoff_interrupted."""
        for h in self.hive.db.all("SELECT id FROM studio_handoffs WHERE owner_boot != ? AND state IN ('in_progress', "
                                  "'settling', 'installing', 'starting', 'awaiting_proof')", (self.boot,)):
            self._hold_row(h["id"], "handoff_interrupted")

    def mark_stuck(self):
        """§1: a job running past 300 s is marked (DB only) on its session; the thread is never killed."""
        db = self.hive.db
        for job in self.worker.stuck():
            ref = job.ref
            sid = ref if job.kind == "S" else None
            if sid is None and isinstance(ref, str) and ref.startswith("ho_"):
                h = self._handoff(ref)
                sid = h["session_id"] if h else None
                db.execute("UPDATE studio_handoffs SET job_stuck_at = COALESCE(job_stuck_at, ?) WHERE id = ?", (now(), ref))
            if sid is None:
                row = db.one("SELECT id FROM studio_sessions WHERE maker_id = ? ORDER BY created_at DESC LIMIT 1",
                             (job.maker,))
                sid = row["id"] if row else None
            if sid:
                db.execute("UPDATE studio_sessions SET job_stuck_at = COALESCE(job_stuck_at, ?) WHERE id = ?", (now(), sid))

    async def tick(self):
        """§1 the sweep: observe, write conditional DB state, dispatch. No filesystem access, no lifecycle call."""
        if not getattr(self, "enabled", False):
            return
        db = self.hive.db
        self.boot_fence()
        self.mark_stuck()
        for h in db.all("SELECT * FROM studio_handoffs WHERE state = 'in_progress'"):
            if h["owner_boot"] == self.boot and not self.worker.outstanding(h["maker_id"]) \
                    and _t(h["updated_at"]) + datetime.timedelta(seconds=STALE_S) < _utc():
                self._hold_row(h["id"], "handoff_stale")
        for h in db.all("SELECT * FROM studio_handoffs WHERE state = 'settling'"):
            with db.transaction():
                if _passed(h["deadline"]):
                    self.unknown_move(h["maker_id"], h["from_epoch"])
                empty = not self.open_reservations(h["maker_id"], h["from_epoch"])
            if empty:
                self.worker.submit(h["maker_id"], "attempt", "B", lambda i=h["id"]: self.job_b(i), h["id"])
        for h in db.all("SELECT * FROM studio_handoffs WHERE state = 'awaiting_proof'"):
            try:
                if self.admit_from(h["id"]) is None:
                    fresh = self._handoff(h["id"])
                    if fresh["state"] == "awaiting_proof" and not fresh["proven_at"] and _passed(fresh["deadline"]):
                        self._hold_row(h["id"], "boundary_unobserved")
            except Exception:   # noqa: BLE001  (one row never stops the sweep)
                log.exception("studio admission failed for %s", h["id"])
        for ses in db.all("SELECT * FROM studio_sessions WHERE state = 'stopping'"):
            if _passed(ses["stopping_deadline"]) and not ses["release_stale"]:
                db.execute("UPDATE studio_sessions SET release_stale = 1 WHERE id = ? AND state = 'stopping' AND "
                           "release_stale = 0", (ses["id"],))
            if not ses["stop_failed"] and not self.worker.outstanding(ses["maker_id"]):
                self.submit_stop(ses["id"])
        for ses in db.all("SELECT id, maker_id, expires_at FROM studio_sessions WHERE state IN ('active', 'paused', 'held') "
                          "AND consent_payload_version >= 2"):
            if _passed(ses["expires_at"]):
                try:
                    self.expire_session(ses["id"])
                except Exception:   # noqa: BLE001
                    log.exception("studio expiry failed for %s", ses["id"])
        for ses in db.all("SELECT id FROM studio_sessions WHERE state IN ('active', 'paused')"):
            try:
                self.sweep_session(ses["id"])
            except Exception:   # noqa: BLE001
                log.exception("studio sweep failed for %s", ses["id"])
        for row in db.all("SELECT maker_id FROM studio_cleanups"):
            if not self.worker.outstanding(row["maker_id"]):
                self.worker.submit(row["maker_id"], "cleanup", "cleanup", lambda m=row["maker_id"]: self.job_cleanup(m),
                                   row["maker_id"])

    def expire_session(self, session_id):
        """Plan §5: window expiry runs the same Stop as the person's, recorded as control_id "expiry" (idempotent)."""
        from .minds import canonical
        db = self.hive.db
        submit = False
        with db.transaction():
            ses = self._session(session_id)
            if ses is None or ses["state"] not in ("active", "paused", "held") or not _passed(ses["expires_at"]):
                return False
            submit = self.stop_session(session_id)
            db.execute("UPDATE studio_sessions SET state_reason = 'window_ended', stop_control_id = COALESCE("
                       "stop_control_id, 'expiry') WHERE id = ?", (session_id,))
            stamp = now()
            db.execute("INSERT OR IGNORE INTO studio_controls (session_id, control_id, action, body_digest, result, at) "
                       "VALUES (?,?,?,?,?,?)", (session_id, "expiry", "stop", "", canonical(
                           {"session_id": session_id, "control_id": "expiry", "action": "stop", "state": "stopping",
                            "reason": "window_ended", "at": stamp}), stamp))
        if submit:
            self.submit_stop(session_id)
        return True

    def sweep_session(self, session_id):
        """A live session: step deadlines, the E4c second unread, and a new attempt when it has work and no open row."""
        db = self.hive.db
        with db.transaction():
            self._expire(session_id)
            ses = self._session(session_id)
            steps = self._steps(session_id)
            last = steps[-1] if steps else None
            if ses["state"] == "active" and last and last["state"] == "timed_out_unread" and last["readmit_of"] is not None:
                self._set_state(session_id, "held", "delivery_failed")       # E4c: the one re-admission went unread too
                return
        self.open_attempt(session_id)

    # ---- views -----------------------------------------------------------------------------------------------------

    def stop_view(self, ses):
        """Person and admin: what Stop is doing, in words."""
        message = None
        if ses.get("stop_failed"):
            message = "Studio's mind couldn't be stopped." + (f" ({ses['stop_status']})" if ses.get("stop_status") else "")
            if (ses.get("finish_count") or 0) > 0:
                message += " An administrator must stop the process."
        elif ses.get("release_stale"):
            message = "Studio didn't finish stopping."
        elif ses.get("job_stuck_at"):
            message = "Studio is waiting on stuck work (disk or process)."
        from .studio_sessions import scope_label
        label = scope_label(ses["id"])
        in_flight = self.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations r JOIN cost_reservation_scopes c ON "
                                     "c.reservation = r.id WHERE c.scope = ? AND r.state IN ('reserved', 'dispatched')",
                                     (label,))["n"]
        from .studio_makers import HOST_ACTOR
        goal = self.hive.db.one("SELECT status, cancel_ack_at, cancel_ack_by FROM goals WHERE id = ?", (ses["goal_id"],)) \
            if ses.get("goal_id") else None
        cancel_ack = None
        if goal is not None and goal["status"] == "cancelled":
            # R8.5: settled by the host at Stop is never shown as the maker's acknowledgement
            cancel_ack = ("settled" if goal["cancel_ack_by"] == HOST_ACTOR else "acknowledged") if goal["cancel_ack_at"] \
                else "pending"
        return {"state": ses["state"] if ses["state"] in ("stopping", ENDED) else None,
                # R5 (plan §5 "Confirmation"): "Stopped" only at state stopped; reserved or dispatched calls under the
                # session's label; unknown billing as its own line, never released; the maker's ack shown, never gating
                "fenced_at": ses.get("fenced_at"), "in_flight": in_flight,
                "unknown_usd": self.scope_held(label, ("unknown",)), "cancel_ack": cancel_ack,
                "stop_verified": bool(ses.get("stop_verified")), "stop_failed": bool(ses.get("stop_failed")),
                "release_stale": bool(ses.get("release_stale")), "release_phase": ses.get("release_phase"),
                "maker_released": bool(ses.get("maker_released")), "stopping_deadline": ses.get("stopping_deadline"),
                "settle_deadline": ses.get("settle_deadline"), "message": message,
                "finish_stopping": ses["state"] == "stopping" and bool(ses.get("stop_failed") or ses.get("release_stale"))}

    def handoff_view(self, ses):
        rows = self.hive.db.all("SELECT * FROM studio_handoffs WHERE session_id = ? ORDER BY created_at, rowid", (ses["id"],))
        used = self.retries_this_hour(ses["id"])
        words = {"maker_unresponsive": "Studio's mind isn't responding.",
                 "delivery_uncertain": "The step may not have reached Studio's mind; it was not confirmed.",
                 "handoff_retry_exhausted": "Studio has used its restarts for this hour."}
        return {"retries_this_hour": used, "retries_per_hour": ATTEMPTS_PER_HOUR,
                "retries_left": max(0, ATTEMPTS_PER_HOUR - used),
                "message": words.get(ses.get("state_reason")) if ses.get("state") == "held" else None,
                "rows": [{k: r[k] for k in ("id", "step_n", "attempt", "from_epoch", "to_epoch", "state", "reason",
                                            "deadline", "window_s", "created_at")} for r in rows]}

    def worker_view(self):
        """Admins (§1, §8.7-8.8): per-class running, queued and stuck counts and the stuck makers."""
        stuck = self.worker.stuck()
        out = {"classes": self.worker.counts(), "stuck_makers": sorted({j.maker for j in stuck})}
        processes = {}
        for maker in out["stuck_makers"]:           # §8.8: the driver's recorded process (group/pid) for an OS stop
            try:
                processes[maker] = self.hive.supervisor.execution(maker)
            except Exception:   # noqa: BLE001
                processes[maker] = None
        out["stuck_processes"] = processes
        if stuck:
            out["message"] = ("Studio work is stuck on disk or process I/O; restart the hive to recover (progress is "
                              "kept). If a Stop is stuck before its asleep commit, first stop the maker's process group at "
                              "the OS level; if that unblocks the stop, it completes on its own.")
        return out
