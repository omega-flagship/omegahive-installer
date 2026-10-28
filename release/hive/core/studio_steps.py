"""J3 host round R3 (O2 core): a Studio session's steps, executions, current-piece custody and the maker's write fence.

Plan: coordination/omegareview/PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md, r1 §3.3-3.6 as amended by r1.1 (S3, S4.3-4, S5 at
step time, S6, K7, K11), r1.2 (E3, E5, E7) and r1.3 (F1, F2, F3, F4); contract J3_ASK_SETS_UP_STUDIO_CONTRACT_R4_3.md
(it wins where they differ); Design's current-piece envelope J3_R4_CURRENT_PIECE_ENVELOPE_R1_20261017.md (opaque here).

Executions (r1.3 F1). Every step runs in its own maker execution, carried by its own agent token: before step n the host
stops the maker (the driver raises if anything survives), rotates its token (agents.token_epoch + 1, written into the
workspace by supervisor.prepare), starts it, and waits for the supervisor's new execution boundary (Ask.note_boundary).
The step records that token_epoch and maker_execution. The token epoch is captured when a request is authenticated
(agent_from returns the row it authenticated) and every in-step act checks it: the captured epoch must equal the
admitted step's, and the step's own execution_id must be named. `done`, a deadline or an interrupt ends the step, fences
its execution permanently (studio_fenced_executions) and retires it the same way before n+1. Any failure holds.

Transport (F3). While a session is live its maker consumes the hub only (the pull inbox refuses); a step is admitted only
with a hub connection authenticated by the current epoch's token. The step message carries no work; the first in-step
context read for (session, step, epoch) starts the cycle and later ones answer already_started.

Mount (E3). O3 mounts by compare-and-swap on the session's mount_epoch and gets a host-issued mount_token; older tokens
are retired forever. Uploads, refreshes, heartbeats and outcomes carry {mount_token, mount_epoch, receiver_generation}.

Piece (r1.1 S3, E7). The latest exact UTF-8 body and the minimal acknowledged tuple of each upload; never parsed. A
refresh (same bytes, same generation) renews freshness with a new host seq; heartbeats renew only the mount lease.

Money at call time (R4, studio_gateway.py): the gateway reservation and SEND_GATE carry the captured epoch and the
step bound at reservation; the studio:<sid> / studiostep:<sid>:<n> rows; L6 op ids. R5: O1 steer interception
(studio_steer.py writes the ask_steers studio columns this round reads), pause/resume; Stop is the release (r1.8 L2).
"""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import logging
import re
import secrets
import time

from .db import now
from .minds import canonical, sha, stamp as rfc3339_ms
from .studio_gateway import StudioGateway
from .studio_handoff import StudioHandoffs
from .studio_steer import StudioSteers

log = logging.getLogger("hive")

PIECE_MAX_BYTES = 256 * 1024
PROPOSAL_MAX_BYTES = 32 * 1024
PIECE_MIN_INTERVAL_S = 1.0
FRESH_SECONDS = 30            # r1.2 E7: settled with Design
MOUNT_LEASE_SECONDS = 60      # r1.2 E3: settled with Design
START_WINDOW_SECONDS = 60     # r1.3 F1.6: a new boundary must be observed within this after a start (Platform-owned)
BOUNDARY_POLL_SECONDS = 0.2
ACKS_KEPT = 64
MAX_UNREAD_DIRECTIONS = 20
TERMINAL = ("applied", "refused", "accepted-no-source-change", "invalid")
OUTCOMES = TERMINAL + ("unknown",)
CLOSED = ("finished", "timed_out", "timed_out_unread", "interrupted", "refused_budget")
LIVE = ("active", "paused", "stopping")
MOUNT_ID = re.compile(r"[A-Za-z0-9_-]{8,80}")
ATTEMPT_ID = re.compile(r"[A-Za-z0-9_.:-]{8,80}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
CONTROL_ID = re.compile(r"[A-Za-z0-9_.:-]{8,80}")
SAFE_INT = 2 ** 53 - 1
STEP_SENDER = "hive:studio"
RETIREMENT_REASONS = ("execution_retirement_failed", "credential_write_failed", "rotation_conflict", "restart_failed",
                      "boundary_unobserved", "transport_unobserved", "delivery_failed", "credential_missing",
                      "handoff_interrupted", "handoff_stale", "handoff_retry_exhausted", "maker_unresponsive",
                      "delivery_uncertain")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS studio_steps (session_id TEXT NOT NULL, n INTEGER NOT NULL, state TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE, token_epoch INTEGER NOT NULL, maker_execution TEXT NOT NULL, readmit_of INTEGER,
  admitted_at TEXT NOT NULL, deadline TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, direction_seqs TEXT NOT NULL DEFAULT '[]',
  cycle_started_at TEXT, read_at TEXT, piece_read TEXT, piece_read_seq INTEGER, proposal_n INTEGER, proposal_digest TEXT,
  published_at TEXT, more INTEGER, done_at TEXT, closed_at TEXT, outcome TEXT, outcome_reason TEXT, outcome_digest TEXT,
  outcome_answer TEXT, piece_upload TEXT, piece_upload_seq INTEGER, mount_epoch INTEGER, receiver_generation INTEGER,
  outcome_at TEXT, PRIMARY KEY (session_id, n))""",
    """CREATE TABLE IF NOT EXISTS studio_piece (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL, scene_ref TEXT NOT NULL, edit_generation INTEGER NOT NULL, mount_epoch INTEGER NOT NULL,
  at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS studio_piece_acks (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL, scene_ref TEXT NOT NULL, edit_generation INTEGER NOT NULL, mount_epoch INTEGER NOT NULL,
  refresh INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (session_id, seq))""",
    """CREATE TABLE IF NOT EXISTS studio_controls (session_id TEXT NOT NULL, control_id TEXT NOT NULL, action TEXT NOT NULL,
  body_digest TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (session_id, control_id))""",
    # E3: retired mount tokens are never accepted or reinstalled
    """CREATE TABLE IF NOT EXISTS studio_mount_retired (token_sha256 TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  mount_epoch INTEGER NOT NULL, at TEXT NOT NULL)""",
    # F5.5: each mount attempt's recorded result, for a lost compare-and-swap response
    """CREATE TABLE IF NOT EXISTS studio_mount_attempts (session_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  body_digest TEXT NOT NULL, outcome TEXT NOT NULL, mount_epoch INTEGER NOT NULL, answer TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (session_id, attempt_id))""",
    # r1.2 E2 / r1.3 F1.4 / r1.4 G1: an ended step's execution stays fenced, keyed on (maker, token epoch) since the
    # epoch is what a request captures at authentication; nothing ever deletes a row
    """CREATE TABLE IF NOT EXISTS studio_fenced_executions (maker_id TEXT NOT NULL, token_epoch INTEGER NOT NULL,
  execution TEXT NOT NULL, session_id TEXT NOT NULL, step INTEGER, reason TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (maker_id, token_epoch))""",
]
SESSION_COLUMNS = [
    ("mount_epoch", "INTEGER NOT NULL DEFAULT 0"), ("mount_token_sha256", "TEXT"), ("mount_auth", "TEXT"),
    ("mount_expires_at", "TEXT"),
    # r1.3 F1: unprepared -> preparing -> ready -> in_step -> unprepared ...; failed holds the session
    ("execution_state", "TEXT NOT NULL DEFAULT 'unprepared'"), ("ready_epoch", "INTEGER"), ("ready_execution", "TEXT"),
    ("ready_at", "TEXT"),
]
# R3 reads the studio columns of ask_steers; R5's O1 interception writes them (plan §4, r1.1 K6)
STEER_COLUMNS = [("studio_session_id", "TEXT"), ("studio_seq", "INTEGER"), ("studio_step", "INTEGER"),
                 ("studio_read_at", "TEXT"),
                 # R5 (plan §4.3): a direction's recorded answer, replayed byte for byte
                 ("studio_answer", "TEXT")]


def _t(text):
    return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00")) if text else None


def _utc():
    return datetime.datetime.now(datetime.timezone.utc)


def _after(seconds):
    return rfc3339_ms(_utc() + datetime.timedelta(seconds=seconds))


def _safe_int(value, low=0):
    return type(value) is int and low <= value <= SAFE_INT


def _sha_text(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def tuple_of(row):
    """The acknowledged upload tuple (contract r4.3 lines 75-77): the only proof of custody."""
    return {"seq": row["seq"], "body_sha256": row["body_sha256"], "scene_ref": json.loads(row["scene_ref"]),
            "edit_generation": row["edit_generation"]}


class StudioSteps(StudioGateway, StudioHandoffs, StudioSteers):
    """Mixed into StudioSessions (studio_sessions.py); uses its hive, gateway, _err/_bad/_not_available, _own, _source,
    _monthly_total, _headroom, _app_attached, _person_ok, scope readers and notice."""

    TOKEN_ROTATION = True            # r1.3 F4.2 component: this build rotates a maker's token per execution
    # the person controls this build offers; the self-check needs pause, resume and stop here (r1.4 G5d): R3 added stop
    # and finish_stopping (handoff spec r2.4 §5), R5 pause and resume. Stop is also the release (r1.8 L2.3): there is no
    # separate release_maker control
    CONTROL_ACTIONS = ("rebind_source", "retry_retirement", "stop", "finish_stopping", "pause", "resume")
    STUDIO_ONLY_ACTIONS = ("stop", "finish_stopping", "retry_retirement", "pause", "resume")

    def _init_steps(self):
        db = self.hive.db
        for statement in SCHEMA:
            db.execute(statement)
        for table, columns in (("studio_sessions", SESSION_COLUMNS), ("ask_steers", STEER_COLUMNS),
                               ("agents", [("token_epoch", "INTEGER NOT NULL DEFAULT 0")])):
            if not db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)):
                continue
            have = {r["name"] for r in db.all(f"SELECT name FROM pragma_table_info('{table}')")}
            for column, kind in columns:
                if column not in have:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        db.execute("CREATE INDEX IF NOT EXISTS ask_steers_studio ON ask_steers(studio_session_id, studio_seq)") \
            if db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ask_steers'") else None
        self.connection_epochs = {}      # agent id -> (id of the registered socket, the token epoch it authenticated with)
        self._init_handoff()             # handoff spec r2.4: worker, owner, sweep, Stop, delivery (studio_handoff.py)
        self._init_gateway()             # R4: op-id ledger, step close reasons (studio_gateway.py)

    # ---- shared reads --------------------------------------------------------------------------------------------

    def _session(self, session_id):
        return self.hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (str(session_id),))

    def _steps(self, session_id):
        return self.hive.db.all("SELECT * FROM studio_steps WHERE session_id = ? ORDER BY n", (session_id,))

    def _step(self, session_id, n):
        return self.hive.db.one("SELECT * FROM studio_steps WHERE session_id = ? AND n = ?", (session_id, int(n))) \
            if str(n).isdigit() else None

    def _open_step(self, session_id):
        return self.hive.db.one("SELECT * FROM studio_steps WHERE session_id = ? AND state = 'admitted'", (session_id,))

    def _piece(self, session_id):
        return self.hive.db.one("SELECT * FROM studio_piece WHERE session_id = ?", (session_id,))

    def _maker_session(self, agent, session_id):
        row = self._session(session_id)
        if row is None or agent.get("id") is None or row["maker_id"] != agent["id"]:
            raise self._not_available()
        return row

    def live_session_of(self, maker_id):
        """The maker's live session admitted under the host-recomputed consent (R2.4: a held or legacy session never
        restricts a mind's ordinary work; a held session's own executions stay fenced by studio_fenced_executions)."""
        from .studio_sessions import CONSENT_PAYLOAD_VERSION
        return self.hive.db.one("SELECT * FROM studio_sessions WHERE maker_id = ? AND state IN ('active', 'paused', "
                                "'stopping') AND consent_payload_version >= ? ORDER BY created_at DESC LIMIT 1",
                                (maker_id, CONSENT_PAYLOAD_VERSION))

    def _boundary(self, maker_id):
        """(seq, execution) of the maker's current supervisor execution boundary (Ask.note_boundary)."""
        return self.hive.ask.boundary(maker_id)

    def _epoch(self, maker_id):
        row = self.hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (maker_id,))
        return row["token_epoch"] if row else None

    def fenced(self, maker_id, token_epoch):
        """r1.4 G1 (iii): (maker, epoch) was fenced by done, a deadline, an interrupt or Stop."""
        return token_epoch is not None and bool(self.hive.db.one(
            "SELECT 1 FROM studio_fenced_executions WHERE maker_id = ? AND token_epoch = ?", (maker_id, token_epoch)))

    def _retired(self, agent, step):
        """r1.4 G1, inside the consuming transaction, against rows it read: (i) the bound step is admitted, (ii) the
        epoch captured at authentication is the step's, (iii) that (maker, epoch) is not fenced. Returns the refusal."""
        epoch = agent.get("token_epoch") if isinstance(agent, dict) else None
        if step is None or step["state"] != "admitted" or epoch != step["token_epoch"] or self.fenced(agent["id"], epoch):
            return self._err(409, "execution_retired", "That execution is not the open step's.")
        return None

    def piece_state(self, row, piece=None):
        """current | missing | revoked | stale (r1.1 S3.3, r1.2 E7): a live mount lease, the latest acknowledged upload
        came from that mount, and it was acknowledged (a refresh included) within FRESH_SECONDS. Heartbeats never count."""
        piece = piece if piece is not None else self._piece(row["id"])
        if not row.get("mount_token_sha256") or not row.get("mount_expires_at") or _t(row["mount_expires_at"]) <= _utc():
            return "revoked"
        if piece is None:
            return "missing"
        if piece["mount_epoch"] != row["mount_epoch"]:
            return "revoked"
        if _t(piece["at"]) + datetime.timedelta(seconds=FRESH_SECONDS) < _utc():
            return "stale"
        return "current"

    # ---- events --------------------------------------------------------------------------------------------------

    def _step_event(self, session_id, n, phase):
        """The body-free, person-scoped studio.step event (rule studio_person), after commit: the receipt card's hint to
        fetch the ledger. Ids, step, phase, proposal revision and outcome; never a body or direction text."""
        hive = self.hive
        row, step = self._session(session_id), self._step(session_id, n)
        if row is None or step is None:
            return
        notice = {"session_id": row["id"], "stream_id": row["stream_id"], "goal_id": row["goal_id"], "step": step["n"],
                  "phase": phase, "step_state": step["state"], "execution_id": step["execution_id"],
                  "proposal_artifact_id": row["proposal_artifact_id"], "proposal_revision": step["proposal_n"],
                  "outcome": step["outcome"], "session_state": row["state"], "updated_at": now()}
        hive.db.after_commit(lambda: hive.events.publish("studio.step", **notice))

    def _session_event(self, session_id):
        hive = self.hive
        row = self._session(session_id)
        turn = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (row["ask_turn_id"],)) if row else None
        if row is None or turn is None:
            return
        notice = {**self.notice(row, turn), "state_reason": row["state_reason"]}
        hive.db.after_commit(lambda: hive.events.publish("studio.session", **notice))

    def _set_state(self, session_id, state, reason):
        self.hive.db.execute("UPDATE studio_sessions SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?",
                             (state, reason, now(), session_id))
        self._session_event(session_id)

    def _hold(self, session_id, reason, execution_state=None):
        with self.hive.db.transaction():
            if execution_state:
                self.hive.db.execute("UPDATE studio_sessions SET execution_state = ? WHERE id = ?", (execution_state, session_id))
            row = self._session(session_id)
            if row and row["state"] in ("active", "paused"):
                self._set_state(session_id, "held", reason)

    # ---- person-side mount authority (r1.2 E3, r1.3 F5.5) --------------------------------------------------------

    def _person_session(self, viewer, session_id):
        """_own (owner + swarm visibility, K1). A person who no longer sees the swarm pauses the session
        (mount_revoked) and gets 404."""
        row = self._session(session_id) if isinstance(session_id, str) else None
        if row is None or row["principal"] != viewer.principal:
            raise self._not_available()
        try:
            return self._own(viewer, session_id)
        except Exception:
            raise self._revoked(row["id"]) from None

    def _revoked(self, session_id):
        """A 404 that also pauses the session (mount_revoked). The pause is written by _revoking after the refused
        transaction rolled back, so it is never lost with it."""
        exc = self._not_available()
        exc.studio_revoke = session_id
        return exc

    def _revoking(self, fn, *args):
        try:
            return fn(*args)
        except Exception as exc:
            sid = getattr(exc, "studio_revoke", None)
            if sid:
                with self.hive.db.transaction():
                    row = self._session(sid)
                    if row is not None and row["state"] == "active":
                        self._set_state(sid, "paused", "mount_revoked")
            raise

    def _mount_fields(self, data):
        for key in ("mount_token", "mount_epoch", "receiver_generation"):
            if key not in data:
                raise self._bad("the body carries {mount_token, mount_epoch, receiver_generation}")
        if not isinstance(data["mount_token"], str) or not _safe_int(data["mount_epoch"], 1) \
                or not _safe_int(data["receiver_generation"], 1):
            raise self._bad("mount_token is the host's token, mount_epoch and receiver_generation positive integers")

    def _current_mount(self, row, auth, data):
        """The act's mount is the session's current, live one (E3): the token, the epoch and the receiver generation
        all equal the current mount's, from the same sign-in. A retired token or old epoch: stale_mount; another
        receiver generation: stale_receiver; the current token from another sign-in: 404 and the session pauses."""
        token_sha = _sha_text(data["mount_token"])
        if row["mount_token_sha256"] and token_sha == row["mount_token_sha256"] and auth != row["mount_auth"]:
            raise self._revoked(row["id"])
        if (not row["mount_token_sha256"] or token_sha != row["mount_token_sha256"]
                or data["mount_epoch"] != row["mount_epoch"]):
            raise self._err(409, "stale_mount", "That Studio frame is no longer the current one; mount again.",
                            mount_epoch=row["mount_epoch"])
        if _t(row["mount_expires_at"]) <= _utc():
            raise self._err(409, "stale_mount", "That Studio frame's lease ran out; mount again.", reason="lease_expired",
                            mount_epoch=row["mount_epoch"])
        if data["receiver_generation"] != row["receiver_generation"]:
            raise self._err(409, "stale_receiver", "That receiver generation is not the mounted one; mount again.")

    MOUNT_KEYS = {"expected_epoch", "receiver_generation", "stream_id", "mount_id", "attempt_id"}

    def mount(self, *args):
        return self._revoking(self._mount, *args)

    def _mount(self, viewer, session_id, data, auth):
        """POST /api/studio-sessions/{sid}/mount {expected_epoch, receiver_generation, stream_id, mount_id, attempt_id}:
        compare-and-swap on mount_epoch. The same attempt_id with the same body answers that attempt's recorded result."""
        if not isinstance(data, dict) or set(data) != self.MOUNT_KEYS:
            raise self._bad("the body is exactly {expected_epoch, receiver_generation, stream_id, mount_id, attempt_id}")
        if not (data["expected_epoch"] is None or _safe_int(data["expected_epoch"], 1)):
            raise self._bad("expected_epoch is null for the first mount, else the last mount_epoch seen")
        if not _safe_int(data["receiver_generation"], 1):
            raise self._bad("receiver_generation is a positive integer")
        if not isinstance(data["mount_id"], str) or not MOUNT_ID.fullmatch(data["mount_id"]):
            raise self._bad("mount_id is 8-80 letters, digits, _ or -")
        if not isinstance(data["attempt_id"], str) or not ATTEMPT_ID.fullmatch(data["attempt_id"]):
            raise self._bad("attempt_id is 8-80 letters, digits or . _ : -")
        digest = sha(canonical(data))
        db = self.hive.db
        with db.transaction():
            row = self._person_session(viewer, session_id)
            seen = db.one("SELECT * FROM studio_mount_attempts WHERE session_id = ? AND attempt_id = ?",
                          (row["id"], data["attempt_id"]))
            if seen is not None:
                if seen["body_digest"] != digest:
                    raise self._err(409, "operation_conflict", "That mount attempt id was used with another body.")
                answer = json.loads(seen["answer"])
                if seen["outcome"] != "mounted":
                    raise self._err(409, "mount_conflict", "Another frame mounted first.", mount_epoch=answer["mount_epoch"])
                return answer
            if data["stream_id"] != row["stream_id"]:
                raise self._err(409, "stream_mismatch", "That frame is bound to another Studio stream.")
            if row["state"] not in ("active", "paused"):
                raise self._err(409, "session_closed", "That Studio session has ended.", state=row["state"])
            current = row["mount_epoch"] or 0
            if (data["expected_epoch"] or 0) != current:
                db.insert("studio_mount_attempts", {"session_id": row["id"], "attempt_id": data["attempt_id"],
                                                    "body_digest": digest, "outcome": "mount_conflict",
                                                    "mount_epoch": current, "answer": canonical({"mount_epoch": current}),
                                                    "at": now()})
                # recorded, so a lost answer reads back as this conflict (F5.5)
                db.after_commit(lambda: None)
                conflict = True
            else:
                conflict = False
                token = "mt_" + secrets.token_hex(12)
                epoch, stamp, expires = current + 1, now(), _after(MOUNT_LEASE_SECONDS)
                if row["mount_token_sha256"]:
                    db.execute("INSERT OR IGNORE INTO studio_mount_retired VALUES (?,?,?,?)",
                               (row["mount_token_sha256"], row["id"], current, stamp))
                db.execute("UPDATE studio_sessions SET mount_epoch = ?, mount_token_sha256 = ?, mount_auth = ?, "
                           "receiver_generation = ?, mount_expires_at = ?, updated_at = ? WHERE id = ?",
                           (epoch, _sha_text(token), auth, data["receiver_generation"], expires, stamp, row["id"]))
                answer = {"session_id": row["id"], "stream_id": row["stream_id"], "mount_epoch": epoch, "mount_token": token,
                          "receiver_generation": data["receiver_generation"], "lease_expires_at": expires,
                          "goal_id": row["goal_id"], "proposal_artifact_id": row["proposal_artifact_id"],
                          "scene_id": json.loads(row["piece"])["scene_id"]}
                db.insert("studio_mount_attempts", {"session_id": row["id"], "attempt_id": data["attempt_id"],
                                                    "body_digest": digest, "outcome": "mounted", "mount_epoch": epoch,
                                                    "answer": canonical(answer), "at": stamp})
        if conflict:
            raise self._err(409, "mount_conflict", "Another frame mounted first.", mount_epoch=current)
        return answer

    def mount_readback(self, viewer, session_id, attempt_id):
        """GET /api/studio-sessions/{sid}/mount?attempt_id=: {mount_epoch, outcome}; the token only if that attempt won
        and is still the current mount."""
        row = self._own(viewer, session_id)
        seen = self.hive.db.one("SELECT * FROM studio_mount_attempts WHERE session_id = ? AND attempt_id = ?",
                                (row["id"], str(attempt_id or "")))
        out = {"session_id": row["id"], "current_mount_epoch": row["mount_epoch"],
               "lease_expires_at": row["mount_expires_at"], "attempt": None}
        if seen is not None:
            out["attempt"] = {"attempt_id": seen["attempt_id"], "outcome": seen["outcome"], "mount_epoch": seen["mount_epoch"]}
            if seen["outcome"] == "mounted" and seen["mount_epoch"] == row["mount_epoch"]:
                out["attempt"]["mount_token"] = json.loads(seen["answer"])["mount_token"]
        return out

    def unmount(self, *args):
        return self._revoking(self._unmount, *args)

    def _unmount(self, viewer, session_id, data, auth):
        """DELETE /api/studio-sessions/{sid}/mount {mount_token}: retire the token and revoke the lease (idempotent)."""
        if not isinstance(data, dict) or set(data) != {"mount_token"} or not isinstance(data["mount_token"], str):
            raise self._bad("the body is exactly {mount_token}")
        token_sha = _sha_text(data["mount_token"])
        db = self.hive.db
        with db.transaction():
            row = self._person_session(viewer, session_id)
            if token_sha == row["mount_token_sha256"]:
                db.execute("INSERT OR IGNORE INTO studio_mount_retired VALUES (?,?,?,?)",
                           (token_sha, row["id"], row["mount_epoch"], now()))
                db.execute("UPDATE studio_sessions SET mount_token_sha256 = NULL, mount_auth = NULL, mount_expires_at = NULL, "
                           "updated_at = ? WHERE id = ?", (now(), row["id"]))
            elif not db.one("SELECT 1 FROM studio_mount_retired WHERE token_sha256 = ? AND session_id = ?", (token_sha, row["id"])):
                raise self._err(409, "stale_mount", "That isn't a mount of this session.")
        return {"session_id": row["id"], "unmounted": True, "piece_state": "revoked"}

    def heartbeat(self, *args):
        return self._revoking(self._heartbeat, *args)

    def _heartbeat(self, viewer, session_id, data, auth):
        """POST /api/studio-sessions/{sid}/mount/heartbeat {mount_token, mount_epoch, receiver_generation}: renews the
        mount lease only. It never renews piece freshness (r1.2 E7)."""
        if not isinstance(data, dict) or set(data) != {"mount_token", "mount_epoch", "receiver_generation"}:
            raise self._bad("the body is exactly {mount_token, mount_epoch, receiver_generation}")
        self._mount_fields(data)
        db = self.hive.db
        with db.transaction():
            row = self._person_session(viewer, session_id)
            if row["state"] not in ("active", "paused"):
                raise self._err(409, "session_closed", "That Studio session has ended.", state=row["state"])
            self._current_mount(row, auth, data)
            expires = _after(MOUNT_LEASE_SECONDS)
            db.execute("UPDATE studio_sessions SET mount_expires_at = ? WHERE id = ?", (expires, row["id"]))
        return {"session_id": row["id"], "mount_epoch": row["mount_epoch"], "lease_expires_at": expires,
                "piece_state": self.piece_state(self._session(row["id"]))}

    # ---- upload and refresh (r1.1 S3.2, r1.2 E7) -----------------------------------------------------------------

    @staticmethod
    def _ack_view(piece, refresh=False):
        return {**tuple_of(piece), "acknowledged_at": piece["at"], "refresh": bool(refresh)}

    UPLOAD_KEYS = {"seq", "body", "scene_ref", "edit_generation", "mount_token", "mount_epoch", "receiver_generation"}

    def upload(self, *args):
        return self._revoking(self._upload, *args)

    def _upload(self, viewer, session_id, data, auth):
        """PUT /api/studio-sessions/{sid}/piece {seq, body, scene_ref, edit_generation, mount_token, mount_epoch,
        receiver_generation}. The body is the exact UTF-8 text of Design's envelope; the host hashes it and never parses
        it. The same bytes and generation as the latest acknowledged upload, at the next seq, is a refresh (E7)."""
        if not isinstance(data, dict) or set(data) != self.UPLOAD_KEYS:
            raise self._bad("the body is exactly {seq, body, scene_ref, edit_generation, mount_token, mount_epoch, "
                            "receiver_generation}")
        self._mount_fields(data)
        body = data["body"]
        if not isinstance(body, str) or not body:
            raise self._bad("body is the piece snapshot's exact text")
        try:
            raw = body.encode("utf-8")
        except UnicodeEncodeError:
            raise self._bad("body is valid UTF-8 text") from None
        if len(raw) > PIECE_MAX_BYTES:
            raise self._err(413, "piece_too_large", "That piece is larger than 256 KB; it was not shared.",
                            limit_bytes=PIECE_MAX_BYTES, bytes=len(raw))
        ref = data["scene_ref"]
        if not (isinstance(ref, dict) and set(ref) == {"scene_id", "revision", "digest"} and isinstance(ref["scene_id"], str)
                and _safe_int(ref["revision"], 1) and isinstance(ref["digest"], str) and DIGEST.fullmatch(ref["digest"])):
            raise self._bad("scene_ref is exactly {scene_id, revision: positive integer, digest: sha256:<64 hex>}")
        if not _safe_int(data["seq"], 1) or not _safe_int(data["edit_generation"], 0):
            raise self._bad("seq is a positive integer and edit_generation a non-negative integer")
        body_sha = "sha256:" + hashlib.sha256(raw).hexdigest()
        db = self.hive.db
        with db.transaction():
            row = self._person_session(viewer, session_id)
            if row["state"] not in ("active", "paused"):
                raise self._err(409, "session_closed", "That Studio session has ended.", state=row["state"])
            self._current_mount(row, auth, data)
            if ref["scene_id"] != json.loads(row["piece"])["scene_id"]:
                raise self._err(409, "scene_mismatch", "That frame holds another piece than this Studio session's.")
            piece = self._piece(row["id"])
            last = piece["seq"] if piece else 0
            if piece and data["seq"] == last:
                ack = db.one("SELECT * FROM studio_piece_acks WHERE session_id = ? AND seq = ?", (row["id"], last))
                if (piece["body_sha256"], json.loads(piece["scene_ref"]), piece["edit_generation"]) == \
                        (body_sha, ref, data["edit_generation"]):
                    return self._ack_view(piece, ack and ack["refresh"])     # a lost response: the same tuple
                raise self._err(409, "stale_piece", "That upload number is taken; send the next one.", seq=last)
            if data["seq"] != last + 1:
                raise self._err(409, "stale_piece", "Send the next upload number.", seq=last)
            refresh = False
            if piece:
                same_bytes = piece["body_sha256"] == body_sha and json.loads(piece["scene_ref"]) == ref
                if data["edit_generation"] < piece["edit_generation"]:
                    raise self._err(409, "stale_generation", "That capture is older than the shared one.",
                                    edit_generation=piece["edit_generation"])
                if data["edit_generation"] == piece["edit_generation"]:
                    if not same_bytes:
                        raise self._err(409, "generation_reused", "The same edit generation with other bytes.")
                    refresh = True                                     # E7: a stable re-observation of unchanged art
                elif same_bytes:
                    raise self._err(409, "generation_without_change",
                                    "A refresh keeps its edit generation; a higher one needs changed art.")
                if _t(piece["at"]) + datetime.timedelta(seconds=PIECE_MIN_INTERVAL_S) > _utc():
                    raise self._err(429, "rate_limited", "One piece upload a second; send the newest one shortly.",
                                    retry_after_ms=1000)
            stamp = now()
            db.execute("INSERT OR REPLACE INTO studio_piece (session_id, seq, body, body_sha256, scene_ref, edit_generation, "
                       "mount_epoch, at) VALUES (?,?,?,?,?,?,?,?)",
                       (row["id"], data["seq"], body, body_sha, canonical(ref), data["edit_generation"], row["mount_epoch"], stamp))
            db.execute("INSERT INTO studio_piece_acks (session_id, seq, body_sha256, scene_ref, edit_generation, mount_epoch, "
                       "refresh, at) VALUES (?,?,?,?,?,?,?,?)", (row["id"], data["seq"], body_sha, canonical(ref),
                                                                  data["edit_generation"], row["mount_epoch"],
                                                                  1 if refresh else 0, stamp))
            db.execute("DELETE FROM studio_piece_acks WHERE session_id = ? AND seq <= ? AND seq NOT IN "
                       "(SELECT piece_read_seq FROM studio_steps WHERE session_id = ? AND piece_read_seq IS NOT NULL "
                       "UNION SELECT piece_upload_seq FROM studio_steps WHERE session_id = ? AND piece_upload_seq IS NOT NULL)",
                       (row["id"], data["seq"] - ACKS_KEPT, row["id"], row["id"]))
            return self._ack_view(self._piece(row["id"]), refresh)

    # ---- executions: the handoff (studio_handoff.py) retires e_n and prepares e_{n+1}; here the step side ----------

    def _requeue(self, session_id, n):
        """r1.4 G5(a): a step that ends with no settled outcome (timed out, interrupted, stopped, nothing published)
        gives its directions back to the queue, so no remark is lost."""
        self.hive.db.execute("UPDATE ask_steers SET studio_step = NULL, studio_read_at = NULL, delivery_message_id = '' "
                             "WHERE studio_session_id = ? AND studio_step = ?", (session_id, n))

    def _end_execution(self, row, step, reason):
        """In the caller's transaction (the one that closes the step): fence (maker, e_n) permanently and mark the maker
        unprepared, so a verified retirement (G4) precedes n+1. Retirement itself runs lazily, only when n+1 is about to
        be admitted (r1.4 G5b): until then the finished execution is idle and fenced."""
        db = self.hive.db
        db.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, step, "
                   "reason, at) VALUES (?,?,?,?,?,?,?)", (row["maker_id"], step["token_epoch"], step["maker_execution"],
                                                          row["id"], step["n"], reason, now()))
        db.execute("UPDATE studio_sessions SET execution_state = 'unprepared', ready_epoch = NULL, ready_execution = NULL, "
                   "ready_at = NULL WHERE id = ?", (row["id"],))

    def _expire(self, session_id):
        """An open step past its deadline closes: timed_out_unread if the maker never read its context (E4c), else
        timed_out. Either way its execution is fenced and retired before n+1."""
        stamp = now()
        row = self._session(session_id)
        for step in self.hive.db.all("SELECT * FROM studio_steps WHERE session_id = ? AND state = 'admitted'", (session_id,)):
            if _t(step["deadline"]) <= _utc():
                state = "timed_out" if step["cycle_started_at"] else "timed_out_unread"
                self.hive.db.execute("UPDATE studio_steps SET state = ?, closed_at = ? WHERE session_id = ? AND n = ? "
                                     "AND state = 'admitted'", (state, stamp, session_id, step["n"]))
                self._end_execution(row, step, state)
                if step["proposal_n"] is None:
                    self._requeue(session_id, step["n"])
                self._step_event(session_id, step["n"], "closed")

    # ---- step admission (§3.4 as amended by r1.1 S6, r1.3 F1/F3) -------------------------------------------------

    def _drift(self, row):
        """S5 at step time: the maker's binding is exactly what the person confirmed. Returns a refusal code or None."""
        from .gateway import GatewayError, split_model
        from .studio_sessions import _options
        maker = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row["maker_id"],))
        if maker is None or maker["swarm_id"] != row["swarm_id"]:
            return "maker_not_member"
        if maker["model"] != row["model"]:
            return "model_drift"
        if (maker.get("role_id") or None) != row["role_id"] or list(_options(maker).get("tools") or []) != json.loads(row["tools"]):
            return "role_drift"
        try:
            key_id = self.gateway.paying_key(maker, split_model(maker["model"])[0])[0]
        except GatewayError:
            key_id = None
        if key_id != row["key_id"]:
            return "key_drift"
        if not self._app_attached({"program_id": row["program_id"], "swarm_id": row["swarm_id"],
                                   "maker_id": row["maker_id"], "app_pin": json.loads(row["app_pin"])}):
            return "attachment_drift"
        if not self.execution_qualified(maker):
            return "execution_binding_unqualified"
        if not self._person_ok(row["principal"]):
            return "person_required"
        return None

    def _budget_room(self, row):
        """The step pre-check (contract §6, "a pre-check, not a step-wide hold"): the monthly total, every reservation
        row and the session cap each have room for the step ceiling. Reserves nothing. None, or (code, details)."""
        from .cost_reservations import ROUND_FLOOR, micros
        from .hive import HiveError
        from .studio_sessions import scope_label
        step_cap = float(row["step_cap_usd"])
        maker = self.hive.db.one("SELECT * FROM agents WHERE id = ?", (row["maker_id"],))
        try:
            self._monthly_total(row["principal"], maker, row["key_id"], bool(row["own_key"]), step_cap)
            self._headroom(row["maker_id"], row["key_id"], row["payer"], bool(row["own_key"]), step_cap)
        except HiveError as exc:
            details = exc.details if isinstance(getattr(exc, "details", None), dict) else {}
            return (details.get("reason") or exc.code), details
        label = scope_label(row["id"])
        room = micros(row["cap_usd"], ROUND_FLOOR) - micros(self.scope_spent(label)) - micros(self.scope_held(label))
        if micros(step_cap) > room:
            return "budget_exhausted", {"scope": label}
        return None

    def _queued(self, session_id):
        return self.hive.db.all("SELECT * FROM ask_steers WHERE studio_session_id = ? AND studio_step IS NULL "
                                "AND studio_cancelled_at IS NULL ORDER BY studio_seq", (session_id,))

    def _admissible(self, row):
        """None when the next step may be admitted now, else the hold reason."""
        if not self.enabled:
            return "studio_off"
        if row["state"] != "active":
            return "not_active"
        if _t(row["expires_at"]) <= _utc():
            return "window_ended"
        steps = self._steps(row["id"])
        last = steps[-1] if steps else None
        if last and last["state"] == "admitted":
            return "step_open"
        if len(steps) >= row["max_steps"]:
            return "max_steps"
        if last and last["proposal_n"] is not None and last["outcome"] not in TERMINAL:
            return "outcome_pending"                  # a published revision without a terminal outcome blocks
        readmit = bool(last and last["state"] == "timed_out_unread" and last["readmit_of"] is None)
        if last and not (last["more"] == 1 or readmit or self._queued(row["id"])):
            return "no_work"
        # the execution (both proofs, the k+1 epoch, zero old reservations) is the handoff admission's (admit_from)
        piece = self._piece(row["id"])
        state = self.piece_state(row, piece)
        if state != "current":
            return "piece_" + state
        if last and last["outcome_at"]:
            # r1.1 S3.5: the next step sees the piece after its predecessor's outcome
            if not (piece["seq"] == last["piece_upload_seq"] or _t(piece["at"]) > _t(last["outcome_at"])):
                return "piece_stale"
        return None

    async def advance(self, session_id):
        """After an upload, outcome, done, control or steer (and by the sweep): step deadlines, then a new attempt when
        the session has work and no open handoff row, then an admission if this session's row has both proofs."""
        if not self.enabled:
            return None
        self.sweep_session(session_id)
        row = self.hive.db.one("SELECT id FROM studio_handoffs WHERE session_id = ? AND state = 'awaiting_proof'",
                               (session_id,))
        return self.admit_from(row["id"]) if row else None

    # ---- maker routes (r1.2 E5, r1.3 F1.3, F3.4) -----------------------------------------------------------------

    def context(self, agent, session_id, execution_id=None, after_dir=None):
        """GET /api/agent/studio-sessions/{sid}/context?execution_id=&after_dir=. It counts only for the active session's
        admitted step, named by its execution_id, with the G1 checks passing inside this transaction (the step admitted,
        the epoch captured at authentication is the step's, that epoch not fenced). The first counting read starts the
        cycle: it binds directions, marks them read and records piece_read. A later counting read answers
        already_started and only adds what changed (r1.4 G5a): a newer acknowledged piece (piece_read is updated) and
        directions queued since. Anything else is a preview that changes nothing. A fenced epoch gets the state only."""
        db = self.hive.db
        with db.transaction():
            row = self._maker_session(agent, session_id)
            self._expire(row["id"])
            row = self._session(row["id"])
            fenced_now = self.fenced(row["maker_id"], agent.get("token_epoch"))
            if row["state"] not in ("active", "paused") or fenced_now:
                return {"session_id": row["id"], "stream_id": row["stream_id"], "state": row["state"],
                        "state_reason": row["state_reason"], "fenced": bool(fenced_now), "step": None, "piece": None,
                        "directions": [], "preview": True}
            step = self._open_step(row["id"])
            counts = (row["state"] == "active" and step is not None and execution_id == step["execution_id"]
                      and self._retired(agent, step) is None)
            piece = self._piece(row["id"])
            state = self.piece_state(row, piece)
            directions = db.all("SELECT * FROM ask_steers WHERE studio_session_id = ? AND studio_seq > ? ORDER BY studio_seq",
                                (row["id"], int(after_dir or 0)))
            already = bool(counts and step["cycle_started_at"])
            current = {**self._ack_view(piece), "body": piece["body"]} if state == "current" else None
            disclosed, shown = (current if not counts else None), [] if counts else directions
            if counts:
                stamp = now()
                newer = current is not None and (step["piece_read_seq"] is None or piece["seq"] > step["piece_read_seq"])
                if not already or newer:
                    disclosed = current
                fresh = [d for d in directions if d["studio_step"] is None or (d["studio_step"] == step["n"] and not d["studio_read_at"])]
                if not already:
                    fresh_seqs = set(json.loads(step["direction_seqs"])) | {d["studio_seq"] for d in directions
                                                                            if d["studio_step"] in (None, step["n"])}
                    fresh = [d for d in directions if d["studio_seq"] in fresh_seqs]
                seqs = sorted({d["studio_seq"] for d in fresh})
                if seqs:
                    db.execute("UPDATE ask_steers SET studio_step = ?, studio_read_at = COALESCE(studio_read_at, ?) "
                               "WHERE studio_session_id = ? AND studio_seq IN (%s)" % ",".join("?" * len(seqs)),
                               (step["n"], stamp, row["id"], *seqs))
                bound = sorted(set(json.loads(step["direction_seqs"])) | set(seqs))
                db.execute("UPDATE studio_steps SET cycle_started_at = COALESCE(cycle_started_at, ?), read_at = ?, "
                           "direction_seqs = ? WHERE session_id = ? AND n = ?", (stamp, stamp, canonical(bound), row["id"], step["n"]))
                if disclosed is not None:
                    db.execute("UPDATE studio_steps SET piece_read = ?, piece_read_seq = ? WHERE session_id = ? AND n = ?",
                               (canonical(tuple_of(piece)), piece["seq"], row["id"], step["n"]))
                shown = fresh
            last = db.one("SELECT MAX(n) AS n FROM artifact_revisions WHERE artifact_id = ?", (row["proposal_artifact_id"],))["n"]
            from .studio_sessions import scope_label, step_label
            label = scope_label(row["id"])
            out = {"session_id": row["id"], "stream_id": row["stream_id"], "goal_id": row["goal_id"], "state": row["state"],
                   "state_reason": row["state_reason"], "proposal_artifact_id": row["proposal_artifact_id"], "parent": last,
                   "scene_id": json.loads(row["piece"])["scene_id"], "preview": not counts, "already_started": already,
                   "step": None, "piece": disclosed, "piece_state": state,
                   "money": {"cap_usd": row["cap_usd"], "spent_usd": round(self.scope_spent(label), 6),
                             "held_usd": self.scope_held(label), "step_cap_usd": row["step_cap_usd"]},
                   "steps": [self._step_view(s, maker=True) for s in self._steps(row["id"])[-3:]],
                   "directions": [{"seq": d["studio_seq"], "steer_id": d["steer_id"], "text": d["text"],
                                   "at": d["created_at"]} for d in shown]}
            if step is not None and counts:
                remaining = max(0.0, (_t(step["deadline"]) - _utc()).total_seconds())
                out["step"] = {"n": step["n"], "execution_id": step["execution_id"], "deadline": step["deadline"],
                               "remaining_s": round(remaining, 3),
                               "step_spent_usd": round(self.scope_spent(step_label(row["id"], step["n"])), 6),
                               "published": step["proposal_n"] is not None}
            return out

    async def done(self, agent, session_id, n, data):
        """POST /api/agent/studio-sessions/{sid}/steps/{n}/done {more, execution_id}: closes step n and fences (maker, e_n)
        in one transaction (r1.4 G1). Retirement waits until a next step is due (G5b). Idempotent with the same body;
        after a timeout or stop, step_closed. Not proof of any canvas effect."""
        if not isinstance(data, dict) or set(data) != {"more", "execution_id"} or type(data["more"]) is not bool:
            raise self._bad("the body is exactly {more: true|false, execution_id}")
        db = self.hive.db
        with db.transaction():
            row = self._maker_session(agent, session_id)
            self._expire(row["id"])
            step = self._step(row["id"], n)
            if step is None:
                raise self._not_available()
            more = 1 if data["more"] else 0
            if data["execution_id"] != step["execution_id"]:
                raise self._err(409, "execution_retired", "That execution is not this step's.")
            if step["state"] == "finished":
                if step["more"] != more:
                    raise self._err(409, "operation_conflict", "That step was already finished with the other answer.")
                return self._step_view(step, maker=True)
            if step["state"] != "admitted":
                raise self._err(409, "step_closed", "That step already closed.", state=step["state"])
            refused = self._retired(agent, step)                 # r1.4 G1, inside this transaction
            if refused is not None:
                raise refused
            stamp = now()
            # finished and the (maker, e_n) fence row commit together, in this one transaction (r1.4 G1)
            db.execute("UPDATE studio_steps SET state = 'finished', more = ?, done_at = ?, closed_at = ? "
                       "WHERE session_id = ? AND n = ? AND state = 'admitted'", (more, stamp, stamp, row["id"], step["n"]))
            self._end_execution(row, step, "done")
            self._step_event(row["id"], step["n"], "closed")
            view = self._step_view(self._step(row["id"], step["n"]), maker=True)
        asyncio.get_running_loop().create_task(self.advance(row["id"]))
        return view

    # ---- the write fence (r1.1 S4.1, S4.3, K11; r1.3 F1.3) -------------------------------------------------------

    def revision_fence(self, agent, art, body, principal, execution_id=None, op_ids=None):
        """Called by collab.add_revision inside its transaction, before the insert. Returns a binder(revision row) for the
        proposal artifact, or None. Raises the refusal otherwise; nothing is written. r3.1: with Studio off it fences
        nothing, so every write is decided by the ordinary artifact rules exactly as before (persisted rows included).
        R4 (r1.8 L6): a proposal carries its op_ids beside execution_id, outside body (never parsed); an op id any earlier
        proposal of the session declared is refused (op_id_reused), and the binder records them with the revision."""
        if not self.enabled:
            return None
        db = self.hive.db
        writer_is_person = agent.get("id") is None and str(principal or "").startswith("user:")
        if not writer_is_person and db.one("SELECT 1 FROM studio_sessions WHERE source_artifact_id = ? AND state IN "
                                           "('active', 'paused', 'stopping')", (art["id"],)):
            raise self._err(409, "session_piece_person_only",
                            "While a Studio session is live, only its person changes this piece.")
        row = db.one("SELECT * FROM studio_sessions WHERE proposal_artifact_id = ?", (art["id"],))
        if row is None:
            return None
        if writer_is_person or agent.get("id") != row["maker_id"] or (principal and principal != f"agent:{agent['id']}"):
            raise self._err(403, "not_session_maker", "Only this Studio session's maker writes its proposals.")
        self._expire(row["id"])
        step = self._open_step(row["id"])
        if row["state"] not in ("active", "paused") or step is None:
            raise self._err(409, "step_closed", "No Studio step is open for a proposal.", state=row["state"])
        if execution_id != step["execution_id"] or self._retired(agent, step) is not None:     # r1.4 G1, in add_revision's txn
            raise self._err(409, "execution_retired", "That execution is not the open step's.")
        if step["proposal_n"] is not None:
            raise self._err(409, "step_already_published", "This step already has its proposal.", step=step["n"],
                            revision=step["proposal_n"])
        size = len(body.encode("utf-8", "surrogatepass")) if isinstance(body, str) else 0
        if size > PROPOSAL_MAX_BYTES:
            raise self._err(413, "proposal_too_large", "A Studio proposal is at most 32 KB.", limit_bytes=PROPOSAL_MAX_BYTES)
        piece = self._piece(row["id"])
        # J3 host R8.4: stale = no read, no piece, or changed content; E7 refreshes since the read are not a change
        if step["piece_read_seq"] is None or piece is None or not self._same_content(piece, step):
            raise self._err(409, "stale_piece_read", "The piece changed since your context read.",
                            read_seq=step["piece_read_seq"], latest_seq=piece["seq"] if piece else None)
        ops = self._op_ids(op_ids)                                       # r1.8 L6, in add_revision's transaction
        self.op_ids_check(row["id"], ops)

        def bind(revision):
            db.execute("UPDATE studio_steps SET proposal_n = ?, proposal_digest = ?, published_at = ? WHERE session_id = ? "
                       "AND n = ? AND proposal_n IS NULL", (revision["n"], revision["digest"], now(), row["id"], step["n"]))
            self.op_ids_record(row["id"], step["n"], revision["n"], ops)
            self._step_event(row["id"], step["n"], "proposal_ready")
        return bind

    @staticmethod
    def _same_content(piece, step):
        """J3 host R8.4: the maker's context read is stale only if the piece's CONTENT changed since it. An E7 refresh
        (the frame re-uploading unchanged art: same body_sha256, scene_ref and edit_generation) bumps seq but changes
        nothing the maker read, so it must not refuse a valid proposal. The read's tuple is step["piece_read"]
        (tuple_of at read time); seq is deliberately left out of the comparison. Upload numbering (put_piece), the
        outcome custody floor (ack seq >= piece_read_seq), ack retention and the S3.5 admission check keep seq order."""
        read = json.loads(step["piece_read"]) if step["piece_read"] else None
        if not read:
            return False
        return (piece["body_sha256"], json.loads(piece["scene_ref"]), piece["edit_generation"]) == \
            (read.get("body_sha256"), read.get("scene_ref"), read.get("edit_generation"))

    def gateway_fence(self, agent):
        """At the gateway's door, before any body read or reservation (R3 part of r1.3 F1.3/F4): a fenced execution never
        calls (studio_fenced); the maker of a live session calls only inside its admitted step, with the token epoch
        captured on this request's authentication and the step's own execution (else studio_step_closed /
        execution_retired). R4 carries the captured epoch through reserve, SEND_GATE and settlement."""
        if not self.enabled:              # R2.4: with Studio off nothing can be stepped, so nothing is fenced
            return None
        agent_id = agent["id"]
        # G3: scoped to makers. Another mind has no session and no fence rows, so nothing below applies to it
        if self.fenced(agent_id, agent.get("token_epoch")):
            return self._err(409, "studio_fenced", "This mind's Studio execution has ended; it makes no more calls.")
        row = self.live_session_of(agent_id)
        if row is None:
            return None
        step = self._open_step(row["id"])
        if step is None:
            return self._err(409, "studio_step_closed", "This mind is making a Studio piece; it works only inside an open step.",
                             session_id=row["id"])
        if self._retired(agent, step) is not None or self._boundary(agent_id)[1] != step["maker_execution"]:
            return self._err(409, "execution_retired", "That execution is not the open step's.", session_id=row["id"])
        return None

    def hub_only(self, agent_id):
        """F3.2: while a maker has a live session it consumes the hub only. r3.1: never with Studio off."""
        if self.enabled and self.live_session_of(agent_id) is not None:
            return self._err(409, "studio_hub_only", "This mind reads its Studio steps through the hub only.")
        return None

    def connected(self, agent, ws):
        """The hub registered this socket, authenticated with this token epoch (agent_hub, after agent_connected). The
        socket keeps that connect-time capture for its life (r1.4 G2)."""
        self.connection_epochs[agent["id"]] = (id(ws), agent.get("token_epoch"))
        self.connected_registration(agent, ws)      # H3.1: proof (b) for a maker Studio owns

    def hub_epoch(self, maker_id):
        """The captured epoch of the maker's currently registered socket, or None (r1.4 G2: the registered socket's
        own epoch, never "some connection exists")."""
        ws = self.hive.connections.get(maker_id)
        record = self.connection_epochs.get(maker_id)
        return record[1] if ws is not None and record and record[0] == id(ws) else None

    # ---- outcome (r1.1 S3.5, r1.2 E3) ----------------------------------------------------------------------------

    OUTCOME_KEYS = {"mount_token", "mount_epoch", "receiver_generation", "proposal", "outcome", "piece_upload",
                    "piece_before", "piece_after", "receipt_digest"}

    def outcome(self, *args):
        return self._revoking(self._outcome, *args)

    def _outcome(self, viewer, session_id, n, data, auth):
        """POST /api/studio-sessions/{sid}/steps/{n}/outcome: the person's frame reports the exact receiver's outcome for
        step n's proposal, bound to an acknowledged upload of the current mount. Idempotent per step; frame-reported."""
        if not isinstance(data, dict) or not self.OUTCOME_KEYS <= set(data) <= self.OUTCOME_KEYS | {"reason", "op_ids"}:
            raise self._bad("the body is {mount_token, mount_epoch, receiver_generation, proposal, outcome, reason?, "
                            "piece_upload, piece_before, piece_after, receipt_digest, op_ids?}")
        self._mount_fields(data)
        if data["outcome"] not in OUTCOMES:
            raise self._bad(f"outcome is one of {list(OUTCOMES)}")
        prop, up = data["proposal"], data["piece_upload"]
        if not (isinstance(prop, dict) and set(prop) == {"artifact_id", "revision", "digest"}):
            raise self._bad("proposal is exactly {artifact_id, revision, digest}")
        if not (isinstance(up, dict) and set(up) == {"seq", "body_sha256", "scene_ref", "edit_generation"}):
            raise self._bad("piece_upload is exactly the acknowledged {seq, body_sha256, scene_ref, edit_generation}")
        for key in ("piece_before", "piece_after"):
            if len(canonical(data[key])) > 2048:
                raise self._bad(f"{key} is the app's small reference, at most 2 KB")
        if "reason" in data and (not isinstance(data["reason"], str) or len(data["reason"]) > 300):
            raise self._bad("reason is at most 300 characters")
        if not isinstance(data["receipt_digest"], str) or not DIGEST.fullmatch(data["receipt_digest"]):
            raise self._bad("receipt_digest is sha256:<64 hex>")
        op_ids = self._op_ids(data.get("op_ids"), required=False)          # R4 L6: the receiver's validated op ids
        # the replay key leaves the mount out: a lost answer replays after a remount too
        digest = sha(canonical({k: v for k, v in data.items() if k not in ("mount_token", "mount_epoch", "receiver_generation")}))
        db = self.hive.db
        with db.transaction():
            row = self._person_session(viewer, session_id)
            step = self._step(row["id"], n)
            if step is None:
                raise self._not_available()
            if step["outcome"] is not None:
                if step["outcome_digest"] == digest:
                    return json.loads(step["outcome_answer"])          # the recorded answer
                if step["outcome"] in TERMINAL or data["outcome"] == "unknown":
                    raise self._err(409, "operation_conflict", "That step's outcome is already recorded.",
                                    outcome=step["outcome"])
            self._current_mount(row, auth, data)
            bound = {"artifact_id": row["proposal_artifact_id"], "revision": step["proposal_n"], "digest": step["proposal_digest"]}
            if step["proposal_n"] is None or prop != bound:
                raise self._err(409, "wrong_proposal", "That isn't the proposal bound to this step; hold, do not skip.",
                                proposal=bound if step["proposal_n"] is not None else None)
            self.op_ids_outcome(step, data["outcome"], op_ids)
            ack = db.one("SELECT * FROM studio_piece_acks WHERE session_id = ? AND seq = ?",
                         (row["id"], up["seq"])) if _safe_int(up.get("seq"), 1) else None
            if (ack is None or tuple_of(ack) != up or ack["mount_epoch"] != row["mount_epoch"]
                    or (step["piece_read_seq"] is not None and ack["seq"] < step["piece_read_seq"])):
                raise self._err(409, "piece_custody_missing", "Share the piece that shows this outcome first.")
            stamp = now()
            answer = {"session_id": row["id"], "stream_id": row["stream_id"], "step": step["n"],
                      "execution_id": step["execution_id"], "proposal": bound, "outcome": data["outcome"],
                      "reason": data.get("reason"), "op_ids": op_ids, "piece_upload": up, "mount_epoch": row["mount_epoch"],
                      "receiver_generation": row["receiver_generation"], "frame_reported": True, "recorded_at": stamp}
            db.execute("UPDATE studio_steps SET outcome = ?, outcome_reason = ?, outcome_digest = ?, outcome_answer = ?, "
                       "piece_upload = ?, piece_upload_seq = ?, mount_epoch = ?, receiver_generation = ?, outcome_at = ? "
                       "WHERE session_id = ? AND n = ?",
                       (data["outcome"], data.get("reason"), digest, canonical(answer), canonical(up), up["seq"],
                        row["mount_epoch"], row["receiver_generation"], stamp, row["id"], step["n"]))
            self._step_event(row["id"], step["n"], "outcome")
            return answer

    # ---- person controls: rebind_source (r1.1 S4.4), retry_retirement (r1.3 F1.6), stop / finish_stopping (handoff spec
    # r2.4 §5), pause / resume (R5, plan §3.3) -------------------------------------------------------------------------

    def controls(self, viewer, session_id, data, admin=False):
        """POST /api/studio-sessions/{sid}/controls. rebind_source, retry_retirement {override?}, stop, finish_stopping
        (an admin may stop and finish stopping any session through /admin-controls), pause and resume. Stop is the
        release (r1.8 L2.3; no separate release_maker). Idempotent per control_id."""
        if not isinstance(data, dict) or "control_id" not in data or "action" not in data:
            raise self._bad("the body is {control_id, action, ...}")
        if not isinstance(data["control_id"], str) or not CONTROL_ID.fullmatch(data["control_id"]):
            raise self._bad("control_id is 8-80 letters, digits or . _ : -")
        action = data["action"]
        if action in self.STUDIO_ONLY_ACTIONS and not self.enabled:
            # r3.1 (stand-in R3 #2): with Studio off these controls change no state and dispatch no job. R4 (Kimi R3.2
            # P3): before the body-shape checks, so a malformed body is 404 as well, never 400. R5: pause and resume too
            raise self._not_available()
        if action == "rebind_source":
            if set(data) != {"control_id", "action", "artifact_id"} or not isinstance(data["artifact_id"], str):
                raise self._bad("rebind_source is exactly {control_id, action, artifact_id}")
        elif action == "retry_retirement":         # §4: an explicit action opens one new attempt (J6 counts it)
            if not {"control_id", "action"} <= set(data) <= {"control_id", "action", "override"} \
                    or ("override" in data and type(data["override"]) is not bool):
                raise self._bad("retry_retirement is exactly {control_id, action, override?: true|false}")
        elif action in ("stop", "finish_stopping", "pause", "resume"):
            if set(data) != {"control_id", "action"}:
                raise self._bad(f"{action} is exactly {{control_id, action}}")
        if action not in self.CONTROL_ACTIONS or (admin and action not in ("stop", "finish_stopping")):
            raise self._err(400, "bad_request", "That control is not available.", reason="not_a_control")
        digest = sha(canonical(data))
        db = self.hive.db
        submit_stop = open_attempt = False
        with db.transaction():
            if admin:
                if not getattr(viewer, "admin", False):
                    raise self._not_available()
                row = self._session(session_id)
                if row is None:
                    raise self._not_available()
            else:
                row = self._own(viewer, session_id)
            seen = db.one("SELECT * FROM studio_controls WHERE session_id = ? AND control_id = ?", (row["id"], data["control_id"]))
            if seen is not None:
                if seen["body_digest"] != digest:
                    raise self._err(409, "operation_conflict", "That control id was used for another control.")
                return json.loads(seen["result"])
            stamp = now()
            if action == "rebind_source":
                if row["state"] not in ("active", "paused"):
                    raise self._err(409, "session_closed", "That Studio session has ended.", state=row["state"])
                new = self._source(viewer, {"swarm_id": row["swarm_id"],
                                            "piece": {"source_ref": {"artifact_id": data["artifact_id"]}}}, row["id"])
                latest = db.one("SELECT author FROM artifact_revisions WHERE artifact_id = ? ORDER BY n DESC LIMIT 1", (new,))
                if latest is None or latest["author"] != row["principal"]:
                    raise self._err(409, "source_not_bindable", "Only your own kept source can be bound.")
                db.execute("UPDATE studio_sessions SET source_artifact_id = ?, updated_at = ? WHERE id = ?", (new, stamp, row["id"]))
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "source_artifact_id": new, "previous_source_artifact_id": row["source_artifact_id"], "at": stamp}
            elif action == "retry_retirement":
                reason = str(row["state_reason"] or "")
                if row["state"] != "held" or reason not in RETIREMENT_REASONS:
                    raise self._err(409, "not_held_for_retirement", "Nothing is waiting for a retry.", state=row["state"])
                if self._open_handoff_of(row["maker_id"]) is not None:
                    raise self._err(409, "handoff_in_progress", "A restart is already in progress.")
                self._set_state(row["id"], "active", None)
                open_attempt = True
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "retrying": reason, "override": bool(data.get("override")), "at": stamp}
            elif action == "pause":
                self._pause(row)
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "state": "paused", "state_reason": "paused_by_person", "at": stamp}
            elif action == "resume":
                was = row["state"]
                self._resume(row)
                open_attempt = was == "paused"
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "state": "active", "at": stamp}
            elif action == "stop":
                submit_stop = self.stop_session(row["id"])           # §5.1: one immediate transaction
                db.execute("UPDATE studio_sessions SET stop_control_id = COALESCE(stop_control_id, ?) WHERE id = ?",
                           (data["control_id"], row["id"]))
                fresh = self._session(row["id"])
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "state": fresh["state"], "stop": self.stop_view(fresh), "at": stamp}
            else:
                # §5.3: clears both flags; S once, no J6 charge. Kimi R3 #4 / R3.1 #2: with a job still outstanding for
                # the maker, nothing is reset or submitted (the sweep picks S up after it)
                submit_stop = self.finish_stopping(row["id"])
                result = {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                          "state": "stopping", "at": stamp}
            db.insert("studio_controls", {"session_id": row["id"], "control_id": data["control_id"], "action": action,
                                          "body_digest": digest, "result": canonical(result), "at": stamp})
        if submit_stop:
            self.submit_stop(row["id"])
        if open_attempt and self.open_attempt(row["id"], explicit=True, override=bool(data.get("override"))) is None \
                and action == "retry_retirement":
            fresh = self._session(row["id"])
            result = {**result, "attempt_opened": False, "state": fresh["state"], "state_reason": fresh["state_reason"]}
        return result

    def _pause(self, row):
        """Plan §3.3 pause, in the control's transaction: no new step is admitted (admission needs `active`); an open step
        goes on to its own end; an attempt already under way stops short of admission (admit_from re-checks the
        state). Idempotent on a paused session."""
        if row["state"] == "paused":
            return
        if row["state"] != "active":
            raise self._err(409, "not_active", "Only a running Studio session can be paused.", state=row["state"])
        self._set_state(row["id"], "paused", "paused_by_person")

    def _resume(self, row):
        """Plan §3.3 resume, only from paused, in the control's transaction: the person still sees the home (_own), the
        window is open, the maker's binding is unchanged (r1.1 S5: payer, key, model, role/tools, attachment,
        qualification), the consent payload recomputes to what the person confirmed (K10), and a step fits (the step
        pre-check; checked before the consent payload so a spent month reads as money, not as a changed card). Any refusal leaves the session paused: a drift needs a new intent (fresh consent); Stop is always
        there. Idempotent on an active session."""
        if row["state"] == "active":
            return
        if row["state"] == "stopping":
            raise self._err(409, "studio_stopping", "That Studio session is stopping.", state=row["state"])
        if row["state"] == "held":
            raise self._err(409, "not_paused", "That Studio session is held; retry or stop it.", state=row["state"],
                            state_reason=row["state_reason"])
        if row["state"] != "paused":
            raise self._err(409, "session_closed", "That Studio session has ended.", state=row["state"])
        if _t(row["expires_at"]) <= _utc():
            raise self._err(409, "window_ended", "That Studio session's time is up; start a new one.")
        drift = self._drift(row) or self._payer_drift(row)
        if drift:
            raise self._err(409, drift, "Something you confirmed changed; confirm a new Studio session.")
        refused = self._budget_room(row)
        if refused:
            code, details = refused
            raise self._err(402, "budget_exhausted" if code == "budget_exhausted" else "spend_limit",
                            "There isn't room for another step under your limits.", reason=code,
                            **{k: v for k, v in details.items() if k in ("scope", "limit")})
        if self._consent_drift(row):
            raise self._err(409, "consent_mismatch", "What you confirmed no longer matches; confirm a new Studio session.")
        self._set_state(row["id"], "active", None)

    def _payer_drift(self, row):
        """r1.1 S5 / §6.4 at resume: the maker's paying key still bills the session's person as consented."""
        record = ((getattr(self.gateway, "keyring", None) and self.gateway.keyring.ring.get("keys")) or {}).get(row["key_id"]) or {}
        payer, own_key = self._payer_as_if(row["principal"], record.get("owner"))
        return None if (payer, bool(own_key)) == (row["payer"], bool(row["own_key"])) else "payer_mismatch"

    def _consent_drift(self, row):
        """r1.1 K10 at resume: recompute the consent payload from the recorded request and today's values; True when its
        digest is no longer the one the person confirmed. A failure to recompute counts as drift."""
        from .hive import HiveError
        from .studio_sessions import consent_digest, consent_payload
        intent = self.hive.db.one("SELECT body FROM ask_intents WHERE id = ?", (row["intent_id"],))
        maker = self.hive.db.one("SELECT * FROM agents WHERE id = ?", (row["maker_id"],))
        if intent is None or maker is None:
            return True
        try:
            request = json.loads(intent["body"])["request"]
            # the payload carries the monthly total's kind and limit, never what is left of it: no fit test here (cap 0)
            monthly = self._monthly_total(row["principal"], maker, row["key_id"], bool(row["own_key"]), 0.0)
            payload = consent_payload(request, own_key=bool(row["own_key"]), monthly=monthly)
        except (HiveError, KeyError, TypeError, ValueError):
            return True
        return consent_digest(payload) != row["consent_digest"]

    # ---- views ---------------------------------------------------------------------------------------------------

    def _step_view(self, step, maker=False):
        out = {"n": step["n"], "state": step["state"], "execution_id": step["execution_id"],
               "token_epoch": step["token_epoch"], "admitted_at": step["admitted_at"], "deadline": step["deadline"],
               "read_at": step["read_at"], "piece_read": json.loads(step["piece_read"]) if step["piece_read"] else None,
               "proposal_revision": step["proposal_n"], "proposal_digest": step["proposal_digest"],
               "published_at": step["published_at"], "more": None if step["more"] is None else bool(step["more"]),
               "outcome": step["outcome"], "outcome_reason": step["outcome_reason"],
               "piece_upload": json.loads(step["piece_upload"]) if step["piece_upload"] else None,
               "outcome_at": step["outcome_at"], "direction_seqs": json.loads(step["direction_seqs"]),
               "closed_reason": step.get("closed_reason"),
               "op_ids": json.loads(step["op_ids"]) if step.get("op_ids") else None}
        if not maker:
            from .studio_sessions import step_label
            label = step_label(step["session_id"], step["n"])
            out.update({"message_id": step["message_id"], "maker_execution": step["maker_execution"],
                        "receiver_generation": step["receiver_generation"], "mount_epoch": step["mount_epoch"],
                        # F5.1: what was reserved and spent under this step's own label (diagnosis, not the guarantee)
                        "spend": {"scope": label, "spent": round(self.scope_spent(label), 6), "held": self.scope_held(label)}})
        return out

    def steps_view(self, row):
        return [self._step_view(s) for s in self._steps(row["id"])]

    def directions_view(self, row):
        return [{"seq": d["studio_seq"], "steer_id": d["steer_id"],
                 "state": "read" if d["studio_read_at"] else ("delivered" if d["studio_step"] else
                                                              ("cancelled" if d.get("studio_cancelled_at") else "queued")),
                 "step": d["studio_step"]}
                for d in self.hive.db.all("SELECT * FROM ask_steers WHERE studio_session_id = ? ORDER BY studio_seq",
                                          (row["id"],))]

    def piece_view(self, row):
        piece = self._piece(row["id"])
        return {"latest": self._ack_view(piece) if piece else None, "piece_state": self.piece_state(row, piece),
                "mount": {"mount_epoch": row["mount_epoch"], "receiver_generation": row["receiver_generation"],
                          "lease_expires_at": row["mount_expires_at"]},
                "execution": {"state": row["execution_state"], "ready_epoch": row["ready_epoch"],
                              "handoff": (self._latest_handoff(row["id"]) or {}).get("state")}}

    def audit(self, viewer, session_id):
        """GET /api/studio-sessions/{sid}/audit (K7): admins only, read-only. Binding, states, step tuples and money;
        never the piece body or direction text."""
        if not viewer.admin:
            raise self._not_available()
        row = self._session(session_id)
        if row is None:
            raise self._not_available()
        from .studio_sessions import scope_label
        label = scope_label(row["id"])
        keep = ("id", "intent_id", "principal", "ask_turn_id", "swarm_id", "program_id", "maker_id", "goal_id",
                "proposal_artifact_id", "stream_id", "source_artifact_id", "payer", "own_key", "key_id", "model", "role_id",
                "cap_usd", "step_cap_usd", "step_window_s", "max_steps", "expires_at", "consent_digest",
                "consent_payload_version", "state", "state_reason", "receiver_generation", "mount_epoch", "mount_expires_at",
                "execution_state", "ready_epoch", "created_at", "updated_at")
        fenced = self.hive.db.all("SELECT execution, token_epoch, step, reason, at FROM studio_fenced_executions "
                                  "WHERE session_id = ? ORDER BY at", (row["id"],))
        return {"session": {k: row[k] for k in keep}, "app_pin": json.loads(row["app_pin"]), "tools": json.loads(row["tools"]),
                "steps": self.steps_view(row), "piece": self.piece_view(row), "directions": self.directions_view(row),
                "fenced_executions": fenced, "handoffs": self.handoff_view(row), "stop": self.stop_view(row),
                "worker": self.worker_view(),
                "credential_reason": row.get("credential_reason"),
                "budget": {"scope": label, "cap": row["cap_usd"], "spent": round(self.scope_spent(label), 6),
                           "held": self.scope_held(label, ("reserved", "dispatched")),
                           "unknown": self.scope_held(label, ("unknown",))}}

    # ---- recovery (r1.1 S6.5, r1.3 F1.6) -------------------------------------------------------------------------

    async def reconcile(self):
        """The reconcile loop's Studio pass is the handoff sweep (handoff spec r2.4 §1): tick()."""
        await self.tick()

    @staticmethod
    def recover_startup(tx):
        """Part of the startup recovery step "studio" (exclusive.STEPS): a step still open when the previous process ended
        is interrupted and its execution fenced; a maker mid-preparation or in a step is unprepared, so retirement (a new
        boundary) runs before any next step. Nothing becomes zero effects. Returns the count of interrupted steps."""
        if not tx.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'studio_steps'"):
            return 0
        stamp = now()
        steps = tx.all("SELECT s.*, x.maker_id FROM studio_steps s JOIN studio_sessions x ON x.id = s.session_id "
                       "WHERE s.state = 'admitted'")
        for s in steps:
            tx.execute("UPDATE studio_steps SET state = 'interrupted', closed_at = ? WHERE session_id = ? AND n = ?",
                       (stamp, s["session_id"], s["n"]))
            tx.execute("INSERT OR IGNORE INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, step, "
                       "reason, at) VALUES (?,?,?,?,?,?,?)", (s["maker_id"], s["token_epoch"], s["maker_execution"],
                                                              s["session_id"], s["n"], "interrupted", stamp))
            if s["proposal_n"] is None:      # r1.4 G5a: an unsettled step gives its directions back to the queue
                tx.execute("UPDATE ask_steers SET studio_step = NULL, studio_read_at = NULL, delivery_message_id = '' "
                           "WHERE studio_session_id = ? AND studio_step = ?", (s["session_id"], s["n"]))
        if tx.one("SELECT 1 FROM pragma_table_info('studio_sessions') WHERE name = 'execution_state'"):
            tx.execute("UPDATE studio_sessions SET execution_state = 'unprepared', ready_epoch = NULL, ready_execution = NULL "
                       "WHERE execution_state IN ('preparing', 'ready', 'in_step')")
        # handoff spec r2.4 §8.8: under the new process's flock, before the first request or reconcile, every open
        # handoff row of the old process holds handoff_interrupted (its session too); stopping sessions keep their
        # persisted stop_verified / release_phase and the sweep resumes job S
        if tx.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'studio_handoffs'"):
            rows = tx.all("SELECT * FROM studio_handoffs WHERE state IN ('in_progress', 'settling', 'installing', "
                          "'starting', 'awaiting_proof')")
            for h in rows:
                tx.execute("UPDATE studio_handoffs SET state = 'held', reason = 'handoff_interrupted', updated_at = ? "
                           "WHERE id = ?", (stamp, h["id"]))
                tx.execute("UPDATE studio_sessions SET state = 'held', state_reason = 'handoff_interrupted', updated_at = ? "
                           "WHERE id = ? AND state IN ('active', 'paused')", (stamp, h["session_id"]))
            return len(steps) + len(rows)
        return len(steps)
