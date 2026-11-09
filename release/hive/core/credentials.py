"""Session credentials: sessions reconnect to the hive by themselves (session onboarding DESIGN_R2 §R, §S, §U, §W, §X, §Z).

A local AI session (Claude Code, Codex) reaches the hive through ``/mcp`` with a member credential. Before this module the
only credential was ``agents.token_hash``, typed by hand into a client config; a rebuilt hive left every such entry dead
until a person went to the machine. Now:

- **The host issues credentials itself.** ``agent_credentials`` rows of kind ``bridged-session`` are issued only by the
  host: over the owner-local launch socket (``session_launch.py``; peer uid == the hive's uid, loopback-only hive, R2.1 §A)
  either for an owner's launch ticket (``POST /api/admin/session-bridges``, R2 §3 / R2.1 §E) or, with no ticket, for the
  two minds on the named exception list (``BRIDGE_EXCEPTION``, R2.1 §J; R2.8 §X "no owner session needed"). The token goes
  over that socket to the launcher's memory and from there only into the launched session's environment (§R). It is never
  written to a file, argv, a log or tool output; the hive keeps only its hash.
- **Pending until verified (§R).** A new row is ``pending``: every MCP tool but ``hive_whoami`` is refused, and every other
  surface refuses it, until a ``hive_whoami`` from that binding succeeds; then it is ``active``. A pending row expires.
- **Mixed context is read-only and /mcp-only (§N, §P, §W, X-a).** A ``mixed_context`` row is accepted only by ``/mcp`` and
  there only for ``MIXED_CONTEXT_READS``. Every other caller of ``Hive.authenticate_agent`` refuses it with 403 before any
  handler code runs: the surface is a parameter with a closed default (W-a), so a route that names no surface refuses it.
- **Fencing (R3.3 §P).** A row carries the agent's ``token_epoch`` at issue and is valid only while it still matches.
- **Two retirement rules kept apart (§X).** ``retire_legacy_credential`` makes one mind's legacy ``agents.token_hash``
  unmatchable by compare-and-swap, records the old hash first so a rerun can roll back, and leaves ``token_epoch`` alone,
  so the verified bridged credential stays valid (§S, §U). Mind retire/move (minds.py, placement.py) is a different
  operation that changes the epoch and ends every credential; it is not touched here.
- **Disconnect is not delete (R2 §3).** ``revoke`` ends one credential and keeps the mind.
"""

from __future__ import annotations

import secrets
import time

from .db import new_id, now

KIND = "bridged-session"
TOKEN_PREFIX = "ohb1_"
PENDING_SECONDS = 600
TICKET_SECONDS = 1800
SURFACE_MCP = "mcp"
# R2.1 §J: exactly these two, and no member can be added (a test pins the list).
BRIDGE_EXCEPTION = ("Dot", "Surface")
BRIDGE_SWARM = "Team sessions"
HARNESSES = ("claude-code", "codex")
# R2.4 §P + R2.6 §T, narrowed by R2.7 §V / R2.8 §Y: the read tools a mixed-context bridge may call. Kept as data and checked
# by name; anything not listed is refused. hive_query, hive_evidence_query, hive_artifact_read, hive_revision_read and
# hive_exhibit_read are left off: each passes caller text to the policy gate or to shares, which can file or record it
# (§V: "a tool that can't meet this comes off the list"). The tools listed run their policy check on the non-filing path.
MIXED_CONTEXT_READS = frozenset({"hive_whoami", "hive_capabilities", "hive_inbox", "hive_goals", "hive_goal_get",
                                 "hive_motivations", "hive_repo_query"})
# X-a: the single exception to §W and §P, for the §J pair's own mind only.
MIGRATION_TOOL = "hive_migrate_retire_legacy"

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_credentials (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, binding_id TEXT NOT NULL, harness TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, status TEXT NOT NULL, mixed_context INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL, activated_at TEXT, revoked_at TEXT, revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS agent_credentials_agent ON agent_credentials(agent_id, status);
CREATE TABLE IF NOT EXISTS session_bridge_tickets (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, harness TEXT NOT NULL, mixed_context INTEGER NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at REAL NOT NULL, used_at TEXT, credential_id TEXT
);
CREATE TABLE IF NOT EXISTS session_bridge_exception (
  name TEXT PRIMARY KEY, agent_id TEXT NOT NULL, bound_at TEXT NOT NULL, bound_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_bridge_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_credential_migrations (
  agent_id TEXT PRIMARY KEY, old_hash TEXT NOT NULL, new_hash TEXT NOT NULL, started_at TEXT NOT NULL
);
"""

LIVE = ("pending", "active")


class Credentials:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        with self.db._lock:
            self.db._conn.executescript(SCHEMA)
            cols = {r[1] for r in self.db._conn.execute("PRAGMA table_info(agents)").fetchall()}
            if "token_epoch" not in cols:   # the same column studio_steps adds; fencing needs it on every hive
                self.db._conn.execute("ALTER TABLE agents ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0")

    def _err(self, status, code, message):
        return self.hive.error(status, code, message)

    @staticmethod
    def _hash(token):
        from .hive import token_hash
        return token_hash(token)

    # ---- authentication (Hive.authenticate_agent calls this when no legacy hash matched) ----------------------------

    def _live(self, token):
        """(credential row, agent row) for a valid credential, else (None, None)."""
        if type(token) is not str or not token.startswith(TOKEN_PREFIX):
            return None, None
        cred = self.db.one("SELECT * FROM agent_credentials WHERE token_hash = ?", (self._hash(token),))
        if cred is None or cred["status"] not in LIVE:
            return None, None
        if cred["status"] == "pending" and (cred["expires_at"] or 0) <= time.time():
            return None, None
        agent = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (cred["agent_id"],))
        if agent is None or int(agent.get("token_epoch") or 0) != int(cred["epoch"]):
            return None, None
        return cred, agent

    def authenticate(self, token, surface=None):
        """The agent row, or None. A restricted credential (pending or mixed context) at any surface but /mcp raises 403
        (W-a: never None, because some routes fall back to a person check when the agent check answers None)."""
        cred, agent = self._live(token)
        if cred is None:
            return None
        if (cred["status"] == "pending" or cred["mixed_context"]) and surface != SURFACE_MCP:
            raise self._err(403, "credential_surface_refused", "this credential is not accepted here")
        return agent

    def context(self, token):
        """What /mcp needs to restrict the call, keyed on the credential row (R2.6 §T: before the agent row is reloaded)."""
        cred, _ = self._live(token)
        if cred is None:
            return None
        return {"id": cred["id"], "agent_id": cred["agent_id"], "status": cred["status"],
                "mixed_context": bool(cred["mixed_context"]), "exception": self._excepted(cred["agent_id"])}

    def activate(self, credential_id):
        """The pending credential's own hive_whoami succeeded (§R): it becomes active and stops expiring."""
        self.db.execute("UPDATE agent_credentials SET status = 'active', activated_at = ?, expires_at = NULL "
                        "WHERE id = ? AND status = 'pending'", (now(), credential_id))

    # ---- issuance (host only: the launch socket calls these) --------------------------------------------------------

    # ---- the §J exception, bound by immutable mind id (§E), with its end (X-a) -----------------------------------------

    def _setting(self, key):
        row = self.db.one("SELECT value FROM session_bridge_settings WHERE key = ?", (key,))
        return row["value"] if row else None

    def _set_setting(self, key, value):
        self.db.execute("INSERT INTO session_bridge_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET "
                        "value = excluded.value", (key, value))

    def exception_ended(self):
        return self._setting("exception_ended_at") is not None

    def end_exception(self, by):
        """R2.1 §J ends: the migration tool stops existing and no new mind can be bound by name. Minds already bound keep
        relaunching read-only to their own id."""
        if not self.exception_ended():
            self._set_setting("exception_ended_at", now())
            self._set_setting("exception_ended_by", by)
        return self.exception_view()

    def exception_view(self):
        bound = {r["name"]: r["agent_id"] for r in self.db.all("SELECT name, agent_id FROM session_bridge_exception")}
        return {"names": list(BRIDGE_EXCEPTION), "bound": bound, "ended_at": self._setting("exception_ended_at")}

    def _excepted(self, agent_id):
        """The migration tool's gate: the mind id recorded for a §J name at first issuance, while the exception lasts."""
        if self.exception_ended():
            return False
        return self.db.one("SELECT 1 FROM session_bridge_exception WHERE agent_id = ?", (agent_id,)) is not None

    def issue(self, agent_id, binding_id, harness, mixed_context=True, by="host:session-launch", replace=False):
        """A new pending bridged-session credential: (view, token). One live credential per mind (R2 §3): a relaunch of
        the same binding replaces its own; another binding is refused unless replace (a disconnect of the other)."""
        if harness not in HARNESSES:
            raise self._err(400, "bad_harness", f"harness is one of {list(HARNESSES)}")
        if type(binding_id) is not str or not 8 <= len(binding_id) <= 128 or not binding_id.replace("-", "").replace("_", "").isalnum():
            raise self._err(400, "bad_binding", "the session binding is 8-128 letters, digits, dashes or underscores")
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        with self.db.transaction():
            agent = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if agent is None:
                raise self._err(404, "not_found", "no such mind")
            live = self.db.all("SELECT id, binding_id FROM agent_credentials WHERE agent_id = ? AND kind = ? AND status IN "
                               "('pending', 'active')", (agent_id, KIND))
            others = [r for r in live if r["binding_id"] != binding_id]
            if others and not replace:
                raise self._err(409, "already_bridged", "this mind is connected to another session; disconnect it first")
            for r in live:
                self._revoke_row(r["id"], "replaced")
            row = {"id": new_id("cr"), "agent_id": agent_id, "kind": KIND, "binding_id": binding_id, "harness": harness,
                   "token_hash": self._hash(token), "epoch": int(agent.get("token_epoch") or 0), "status": "pending",
                   "mixed_context": 1 if mixed_context else 0, "created_by": by, "created_at": now(),
                   "expires_at": time.time() + PENDING_SECONDS, "activated_at": None, "revoked_at": None,
                   "revoked_reason": None}
            self.db.insert("agent_credentials", row)
        return self.view(row), token

    def _revoke_row(self, credential_id, reason):
        return self.db.execute("UPDATE agent_credentials SET status = 'revoked', revoked_at = ?, revoked_reason = ? "
                               "WHERE id = ? AND status IN ('pending', 'active')", (now(), reason, credential_id)).rowcount

    def revoke(self, credential_id, reason="disconnected"):
        """Disconnect: ends this credential only; the mind and its knowledge stay (R2 §3)."""
        if self.db.one("SELECT 1 FROM agent_credentials WHERE id = ?", (credential_id,)) is None:
            raise self._err(404, "not_found", "no such credential")
        self._revoke_row(credential_id, reason)
        return self.view(self.db.one("SELECT * FROM agent_credentials WHERE id = ?", (credential_id,)))

    @staticmethod
    def view(row):
        return {k: row[k] for k in ("id", "agent_id", "kind", "binding_id", "harness", "epoch", "status", "created_by",
                                    "created_at", "activated_at", "revoked_at", "revoked_reason")} | {
            "mixed_context": bool(row["mixed_context"])}

    def list(self):
        return [self.view(r) for r in self.db.all("SELECT * FROM agent_credentials ORDER BY created_at DESC LIMIT 200")]

    # ---- owner launch tickets (R2 §3 / R2.1 §E: create or attach, owner-authorised) ---------------------------------

    def ticket(self, agent_id, harness, by, mixed_context=True):
        """An owner's one-time launch ticket for one mind. The id is not a secret: it is redeemed only over the
        owner-local launch socket, by a process of the hive's own operating-system account."""
        if harness not in HARNESSES:
            raise self._err(400, "bad_harness", f"harness is one of {list(HARNESSES)}")
        if self.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (agent_id,)) is None:
            raise self._err(404, "not_found", "no such mind")
        row = {"id": new_id("sb"), "agent_id": agent_id, "harness": harness, "mixed_context": 1 if mixed_context else 0,
               "created_by": by, "created_at": now(), "expires_at": time.time() + TICKET_SECONDS, "used_at": None,
               "credential_id": None}
        self.db.insert("session_bridge_tickets", row)
        return {k: row[k] for k in ("id", "agent_id", "harness", "created_by", "created_at", "expires_at")} | {
            "mixed_context": bool(row["mixed_context"])}

    def redeem_ticket(self, ticket_id, binding_id, replace=False):
        with self.db.transaction():
            row = self.db.one("SELECT * FROM session_bridge_tickets WHERE id = ?", (ticket_id,))
            if row is None or row["used_at"] or row["expires_at"] <= time.time():
                raise self._err(404, "not_found", "no such open launch ticket")
            view, token = self.issue(row["agent_id"], binding_id, row["harness"], bool(row["mixed_context"]),
                                     by=f"ticket:{ticket_id}", replace=replace)
            used = self.db.execute("UPDATE session_bridge_tickets SET used_at = ?, credential_id = ? WHERE id = ? AND used_at IS NULL",
                                   (now(), view["id"], ticket_id)).rowcount
            if used != 1:
                raise self._err(409, "ticket_used", "that launch ticket was used meanwhile")
        return view, token

    def exception_mind(self, name, harness, binding_id, replace=False):
        """R2.1 §J / R2.8 X-a: one of the two named minds, with no owner session. Binds to the existing mind of that exact
        name (attach), or creates it, with no role, in the host's own sessions team. Always mixed context (X-a)."""
        if name not in BRIDGE_EXCEPTION:
            raise self._err(403, "not_excepted", "only an owner's launch ticket can connect this session")
        bound = self.db.one("SELECT agent_id FROM session_bridge_exception WHERE name = ?", (name,))
        if bound is not None:   # the immutable id recorded at first issuance; never re-resolved by name
            agent = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (bound["agent_id"],))
            if agent is None:
                raise self._err(409, "exception_mind_gone", "the mind this session was bound to no longer exists")
        else:
            if self.exception_ended():
                raise self._err(403, "exception_ended", "the named exception has ended; use an owner's launch ticket")
            agent = self._bind_exception_mind(name)
        return self.issue(agent["id"], binding_id, harness, True, by="host:session-launch:exception", replace=replace)

    def _bind_exception_mind(self, name):
        """First issuance for a §J name: attach only to the one live mind of that name that the hive's owner owns, or
        create it in the host's own sessions team (its id kept in a host setting, never looked up by name)."""
        hive = self.hive
        owner = hive.ownhive.owner() if getattr(hive, "ownhive", None) is not None else None
        live = self.db.all("SELECT * FROM agents WHERE name = ? AND deleted = 0", (name,))
        if len(live) > 1:
            raise self._err(409, "ambiguous_mind", "more than one mind has this name; the owner connects it with a ticket")
        if live:
            agent = live[0]
            if not owner or agent.get("owner") != owner:
                raise self._err(403, "not_owner_mind", "that mind is not the hive owner's; the owner connects it with a ticket")
        else:
            swarm_id = self._setting("swarm_id")
            if not swarm_id or self.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)) is None:
                swarm = hive.create_swarm(BRIDGE_SWARM, "Local AI sessions connected to this hive (read-only bridges).",
                                          owner=None if owner in (None, "user:operator") else owner)
                swarm_id = swarm["id"]
                self._set_setting("swarm_id", swarm_id)
            created = hive.create_agent(name, "module", swarm_id, "mock/echo", "", None, 0, None, None,
                                        owner=None if owner in (None, "user:operator") else owner, by="host:session-launch")
            # the create path hands back a member token; nobody keeps it: make it unmatchable at once
            self.db.execute("UPDATE agents SET token_hash = ? WHERE id = ?", (self._hash(secrets.token_urlsafe(32)), created["id"]))
            agent = self.db.one("SELECT * FROM agents WHERE id = ?", (created["id"],))
        self.db.execute("INSERT OR IGNORE INTO session_bridge_exception (name, agent_id, bound_at, bound_by) VALUES (?,?,?,?)",
                        (name, agent["id"], now(), "host:session-launch"))
        row = self.db.one("SELECT agent_id FROM session_bridge_exception WHERE name = ?", (name,))
        if row["agent_id"] != agent["id"]:
            raise self._err(409, "exception_bound_meanwhile", "this name was bound meanwhile; launch again")
        return agent

    # ---- §S/§U/§X: retiring the legacy credential (epoch unchanged) ------------------------------------------------

    def _in_flight(self, agent_id):
        try:
            return self.db.one("SELECT 1 FROM flow_runs WHERE actor_ref = ? AND status = 'running' LIMIT 1", (agent_id,)) is not None
        except Exception:   # noqa: BLE001  (no flows table on this hive: nothing in flight)
            return False

    def retire_legacy_credential(self, agent_id):
        """§S step 1: make the legacy agents.token_hash unmatchable, compare-and-swap, token_epoch unchanged. The old hash
        is saved first (§X) so an interrupted run can roll back. Idempotent: a migration already recorded answers its state."""
        with self.db.transaction():
            started = self.db.one("SELECT * FROM legacy_credential_migrations WHERE agent_id = ?", (agent_id,))
            if started is not None:
                return {"state": "retired", "unchanged": True}
            agent = self.db.one("SELECT id, token_hash FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if agent is None:
                raise self._err(404, "not_found", "no such mind")
            if self._in_flight(agent_id):
                raise self._err(409, "in_flight", "a flow fenced on the old credential is still running; retry when it ends")
            new_hash = self._hash(secrets.token_urlsafe(32))   # its token is never kept or shown
            self.db.insert("legacy_credential_migrations", {"agent_id": agent_id, "old_hash": agent["token_hash"],
                                                            "new_hash": new_hash, "started_at": now()})
            moved = self.db.execute("UPDATE agents SET token_hash = ? WHERE id = ? AND token_hash = ?",
                                    (new_hash, agent_id, agent["token_hash"])).rowcount
            if moved != 1:
                raise self._err(409, "credential_changed", "the mind's credential changed meanwhile; nothing was retired")
        return {"state": "retired", "unchanged": False}

    def confirm_legacy_retire(self, agent_id):
        """§U step 4: the bridged credential answered hive_whoami again; the migration is done and its record goes."""
        gone = self.db.execute("DELETE FROM legacy_credential_migrations WHERE agent_id = ?", (agent_id,)).rowcount
        return {"state": "done", "unchanged": gone == 0}

    def rollback_legacy_retire(self, agent_id):
        """§U: the re-check failed or the run was interrupted: restore the old hash (compare-and-swap from the random one)."""
        with self.db.transaction():
            row = self.db.one("SELECT * FROM legacy_credential_migrations WHERE agent_id = ?", (agent_id,))
            if row is None:
                return {"state": "none", "unchanged": True}
            moved = self.db.execute("UPDATE agents SET token_hash = ? WHERE id = ? AND token_hash = ?",
                                    (row["old_hash"], agent_id, row["new_hash"])).rowcount
            if moved != 1:   # the credential changed since retirement: nothing restored, the record kept for a person
                return {"state": "rollback_failed", "unchanged": True}
            self.db.execute("DELETE FROM legacy_credential_migrations WHERE agent_id = ?", (agent_id,))
        return {"state": "rolled_back", "unchanged": False}


class RestrictedCredentialGate:
    """R2.8 W-a: the surface check as middleware, before routing. A pending or mixed-context bridged-session credential
    (Authorization bearer or X-Hive-Token) reaching anything but /mcp is refused with 403 before any route, validator or
    handler runs, for HTTP and websockets alike. Hive.authenticate_agent's closed default stays as the second layer."""

    def __init__(self, app, hive):
        self.app, self.hive = app, hive

    @staticmethod
    def _token(scope):
        for name, value in scope.get("headers") or ():
            if name in (b"authorization", b"x-hive-token"):
                text = value.decode("latin-1").strip()
                if text.lower().startswith("bearer "):
                    text = text[7:].strip()
                if text.startswith(TOKEN_PREFIX):
                    return text
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            token = self._token(scope)
            if token is not None:
                path, root = scope.get("path", ""), scope.get("root_path", "")
                if root and path.startswith(root):
                    path = path[len(root):]
                if path != "/mcp":
                    from starlette.concurrency import run_in_threadpool
                    ctx = await run_in_threadpool(self.hive.credentials.context, token)
                    if ctx is not None and (ctx["status"] == "pending" or ctx["mixed_context"]):
                        if scope["type"] == "websocket":
                            await send({"type": "websocket.close", "code": 4403})
                            return
                        from starlette.responses import JSONResponse
                        await JSONResponse({"error": {"code": "credential_surface_refused",
                                                      "message": "this credential is not accepted here"}}, status_code=403)(scope, receive, send)
                        return
        await self.app(scope, receive, send)
