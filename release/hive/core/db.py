"""SQLite control-plane store.  Beliefs live in hive-spaces, not here."""

from __future__ import annotations

import datetime
import json
import secrets
import contextlib
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  hue INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, swarm_id TEXT,
  model TEXT NOT NULL, persona TEXT NOT NULL DEFAULT '', hue INTEGER NOT NULL,
  status TEXT NOT NULL, desired TEXT NOT NULL DEFAULT 'stopped', driver TEXT NOT NULL,
  budget_usd REAL NOT NULL DEFAULT 0, spent_usd REAL NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL, evidence_counter INTEGER NOT NULL DEFAULT 0,
  hub_last_seen INTEGER, last_active_at TEXT, created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
  hub_seq INTEGER, client_seq TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS messages_agent_dir_conv ON messages(agent_id, direction, conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_seq ON messages(agent_id, client_seq);
CREATE TABLE IF NOT EXISTS assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, swarm_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  statement TEXT NOT NULL, f REAL NOT NULL, c REAL NOT NULL, stamp TEXT NOT NULL,
  outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assertions_stmt ON assertions(swarm_id, statement);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_agent ON usage(agent_id, created_at);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, period TEXT NOT NULL, limit_usd REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, skill TEXT NOT NULL, mode TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, skill TEXT NOT NULL, command TEXT NOT NULL,
  reason TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_agent ON approvals(agent_id, status);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', priority REAL NOT NULL, status TEXT NOT NULL,
  created_by TEXT NOT NULL, claimed_by TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_swarm ON goals(swarm_id, status);
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, iteration INTEGER NOT NULL,
  input TEXT, response TEXT NOT NULL, commands TEXT NOT NULL, llm_ms INTEGER, tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_agent ON traces(agent_id, id);
CREATE TABLE IF NOT EXISTS wakeups (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron TEXT, at TEXT, tz TEXT NOT NULL, text TEXT NOT NULL,
  enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reads (
  agent_id TEXT NOT NULL, swarm_id TEXT NOT NULL, statement TEXT NOT NULL, stamp TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (agent_id, statement)
);
CREATE TABLE IF NOT EXISTS control_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, op TEXT NOT NULL, taken INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_idle (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, owed TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL, last_noticed_at TEXT NOT NULL, last_input_at TEXT,
  idle_calls INTEGER NOT NULL DEFAULT 0, idle_spend_usd REAL NOT NULL DEFAULT 0,
  question TEXT NOT NULL, asked_at TEXT NOT NULL, asked_by TEXT NOT NULL, conversation_id TEXT, message_id TEXT,
  reply TEXT, replied_at TEXT, reply_message_id TEXT, status TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS health_idle_agent ON health_idle(agent_id, asked_at);
"""


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_stamp(value):
    """A stored stamp as an aware UTC datetime, or None: compare stamps by time, never as text (a stamp with an offset or
    another precision sorts wrongly as a string; Kimi idle-minds r1 K5/K7). Naive stamps are read as UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.datetime.fromisoformat(text.replace("t", "T").replace(" ", "T", 1))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(datetime.timezone.utc)


def stamp_of(moment):
    """An aware datetime in the store's one stamp format (now()'s): what SQL text comparisons are made against."""
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def latest_stamp(*values):
    """The latest of these stamps by time (the stamp as stored), or None when none parses."""
    parsed = [(parse_stamp(v), v) for v in values]
    parsed = [(m, v) for m, v in parsed if m is not None]
    return max(parsed, key=lambda p: p[0])[1] if parsed else None


def new_id(prefix):
    return f"{prefix}_{secrets.token_hex(4)}"


class Database:
    def __init__(self, path, hive_schema=True):
        """hive_schema False: a side database that keeps its own tables (personal_inbox.db), not the hive's."""
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._lock = threading.RLock()
        if not hive_schema:
            return
        with self._lock:
            self._conn.executescript(SCHEMA)
            columns = {r[1] for r in self._conn.execute("PRAGMA table_info(agents)")}
            for column, ddl in (("last_error", "TEXT"), ("idle_sleep_minutes", "REAL NOT NULL DEFAULT 0"),
                                ("options", "TEXT"),
                                ("last_input_at", "TEXT")):   # real input, never spend (Hive.mark_input; Health idle pass)
                if column not in columns:
                    self._conn.execute(f"ALTER TABLE agents ADD COLUMN {column} {ddl}")
            goal_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(goals)")}
            for column, ddl in (("lease_until", "TEXT"), ("attempts", "INTEGER NOT NULL DEFAULT 0"),
                                ("assignee", "TEXT"), ("binding", "TEXT"), ("result_data", "TEXT"),
                                ("cancel_ack_at", "TEXT"), ("cancel_ack_by", "TEXT"), ("deadline_at", "TEXT"),
                                ("submitted_at", "TEXT"), ("reviewed_by", "TEXT"), ("reviewed_at", "TEXT"),
                                ("review_notes", "TEXT"), ("returns", "INTEGER NOT NULL DEFAULT 0")):
                if column not in goal_columns:
                    self._conn.execute(f"ALTER TABLE goals ADD COLUMN {column} {ddl}")
            approval_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(approvals)")}
            if "redeemed_at" not in approval_columns:
                self._conn.execute("ALTER TABLE approvals ADD COLUMN redeemed_at TEXT")
            session_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(sessions)")}
            for column, ddl in (("kind", "TEXT NOT NULL DEFAULT 'password'"), ("principal", "TEXT"), ("expires_at", "REAL"),
                                ("signin_hash", "TEXT")):   # the hive_signin a bearer was exchanged from (sign-out revokes them together)
                if column == "signin_hash" and column not in session_columns:
                    # Bearers exchanged before this column existed cannot be tied to their sign-in, so sign-out could
                    # not revoke them: end them once, atomically with adding the column (so this runs exactly once).
                    # People sign in again; password sessions stay.
                    self._conn.execute("BEGIN IMMEDIATE")
                    try:
                        self._conn.execute(f"ALTER TABLE sessions ADD COLUMN {column} {ddl}")
                        ended = self._conn.execute("DELETE FROM sessions WHERE kind = 'sso' AND signin_hash IS NULL").rowcount
                    except BaseException:
                        self._conn.rollback()
                        raise
                    self._conn.commit()
                    print(f"[hive] sessions upgrade: ended {ended} unlinked sign-in session(s)")
                elif column not in session_columns:
                    self._conn.execute(f"ALTER TABLE sessions ADD COLUMN {column} {ddl}")
            rule_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(policy_rules)")}
            if "expires_at" not in rule_columns:          # "For a time" rules end on their own
                self._conn.execute("ALTER TABLE policy_rules ADD COLUMN expires_at REAL")
            if "origin" not in rule_columns:              # who made the rule: 'answer' = a person answering an approval
                self._conn.execute("ALTER TABLE policy_rules ADD COLUMN origin TEXT NOT NULL DEFAULT ''")
                for prefix in ("always allowed when approving ", "never, when refusing ", "allowed for "):
                    self._conn.execute("UPDATE policy_rules SET origin = 'answer' WHERE substr(note, 1, ?) = ?", (len(prefix), prefix))
            if "granted_by" not in rule_columns:          # host-identity r1: who answered; NULL for older rules (no backfill)
                self._conn.execute("ALTER TABLE policy_rules ADD COLUMN granted_by TEXT")
            usage_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(usage)")}
            if "key_id" not in usage_columns:
                self._conn.execute("ALTER TABLE usage ADD COLUMN key_id TEXT")
            if "swarm_id" not in usage_columns:
                self._conn.execute("ALTER TABLE usage ADD COLUMN swarm_id TEXT")
            if "resolved_model" not in usage_columns:   # what the provider says actually answered (may differ from an alias)
                self._conn.execute("ALTER TABLE usage ADD COLUMN resolved_model TEXT")
            if "payer" not in usage_columns:            # who pays: a person (user:u_...) or the hive
                self._conn.execute("ALTER TABLE usage ADD COLUMN payer TEXT")
            message_columns = {r[1] for r in self._conn.execute("PRAGMA table_info(messages)")}
            if "extra" not in message_columns:
                self._conn.execute("ALTER TABLE messages ADD COLUMN extra TEXT")

    def execute(self, sql, params=()):
        with self._lock:
            return self._conn.execute(sql, params)

    def one(self, sql, params=()):
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    @contextlib.contextmanager
    def transaction(self):
        """All writes inside commit together or not at all. Nests (a savepoint inside an open transaction).
        Holds the connection lock for the duration, so keep the work short and never await inside it."""
        pending = []
        with self._lock:
            nested = self._conn.in_transaction
            name = f"tx_{id(object())}"
            if not hasattr(self, "_after_commit"):
                self._after_commit = []
            mark = len(self._after_commit)
            self._conn.execute(f"SAVEPOINT {name}" if nested else "BEGIN IMMEDIATE")
            try:
                yield self
            except BaseException:
                if nested:
                    self._conn.execute(f"ROLLBACK TO {name}")
                    self._conn.execute(f"RELEASE {name}")
                    del self._after_commit[mark:]          # what this savepoint queued never happened
                else:
                    self._conn.rollback()
                    self._after_commit.clear()
                raise
            else:
                if nested:
                    self._conn.execute(f"RELEASE {name}")
                else:
                    self._conn.commit()
                    pending, self._after_commit = self._after_commit, []
        for fn in pending:   # only after the outermost commit is durable, and outside the connection lock (a remote call may wait)
            try:
                fn()
            except Exception as exc:  # a notice failing never undoes committed data
                print(f"[hive] after-commit callback failed: {exc}")

    def after_commit(self, fn):
        """Run fn once the outermost open transaction commits; drop it if that transaction (or the savepoint
        it was queued in) rolls back.  Outside a transaction, run it now.  For notices about committed data
        (found by OmegaDesign 2026-10-04: a revision notice escaped a rolled-back publication)."""
        with self._lock:
            if self._conn.in_transaction:
                if not hasattr(self, "_after_commit"):
                    self._after_commit = []
                self._after_commit.append(fn)
                return
        fn()

    def erase(self, sql, params=()):
        """A DELETE whose rows must leave no copy in the database files (personal_inbox.py: content held only until the
        person's browser collects it). SQLite's secure_delete is on for this statement only, so the freed cells and
        pages are overwritten with zeros (the connection's own setting is restored after it); once the outermost
        transaction commits, the WAL is checkpointed into the main file and truncated, so no older frame still holds
        the rows. Returns the statement's rowcount. A checkpoint another reader blocks is logged and retried by the
        next erase."""
        with self._lock:
            before = self._conn.execute("PRAGMA secure_delete").fetchone()[0]
            self._conn.execute("PRAGMA secure_delete = ON")
            try:
                count = self._conn.execute(sql, params).rowcount
            finally:
                self._conn.execute(f"PRAGMA secure_delete = {int(before)}")
            if count:
                self.after_commit(self.truncate_wal)
            return count

    @contextlib.contextmanager
    def secure_writes(self):
        """secure_delete on for everything inside (overwritten and freed cells are zeroed), restored after; then the WAL
        is checkpointed and truncated, so no older frame keeps what was rewritten. Wrap it around the transaction."""
        with self._lock:
            before = self._conn.execute("PRAGMA secure_delete").fetchone()[0]
            self._conn.execute("PRAGMA secure_delete = ON")
            try:
                yield self
            finally:
                self._conn.execute(f"PRAGMA secure_delete = {int(before)}")
        self.truncate_wal()

    def truncate_wal(self):
        """Checkpoint every WAL frame into the main file and truncate the WAL. True when it completed."""
        with self._lock:
            busy, _log, _done = self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if busy:
            print("[hive] wal checkpoint was blocked by a reader; erased rows may stay in the WAL until the next one")
        return not busy

    def guarded_execute(self, sql, params, guards):
        """Recheck host read guards and save within one write transaction.

        Guards must be host-owned read functions, never application callbacks.
        None means a guard changed; no mutation is committed in that case.
        """
        with self._lock:
            nested = self._conn.in_transaction
            self._conn.execute("SAVEPOINT result_custody" if nested else "BEGIN IMMEDIATE")
            try:
                if not all(guard() for guard in guards):
                    if nested:
                        self._conn.execute("ROLLBACK TO result_custody")
                        self._conn.execute("RELEASE result_custody")
                    else:
                        self._conn.rollback()
                    return None
                cur = self._conn.execute(sql, params)
                self._conn.execute("RELEASE result_custody") if nested else self._conn.commit()
                return cur
            except BaseException:
                if nested:
                    self._conn.execute("ROLLBACK TO result_custody")
                    self._conn.execute("RELEASE result_custody")
                else:
                    self._conn.rollback()
                raise

    def all(self, sql, params=()):
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def insert(self, table, values):
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        with self._lock:
            cur = self._conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(values.values()))
            return cur.lastrowid

    def update(self, table, key, values):
        sets = ", ".join(f"{k} = ?" for k in values)
        with self._lock:
            self._conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*values.values(), key))

    @staticmethod
    def dumps(value):
        return json.dumps(value)
