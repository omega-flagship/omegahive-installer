"""Connect any harness to the hive: invite codes and an MCP endpoint.

An admin invites a harness (Claude Code, Codex, Hermes, Kimi, any MCP client) into a swarm with a name and a
role.  The hive returns a one-time code and the exact command to paste into that harness.  The harness
connects to ``/mcp`` (MCP over streamable HTTP, JSON responses) with ``Authorization: Bearer <code>``.
The first connection redeems the code: the harness becomes an outside member of the swarm, and the code
becomes that member's credential.  An unused code expires; a member can be revoked at any time, which
ends the credential.  Works over the tunnel, so a harness on another machine can join.

The tools are the same agent API every mind has, run as that member, through the same policy gate:
whoami/role, inbox, send, goals, claim, result, publish, query.  A member never gains operator authority,
another member's identity, or anything its swarm's rules do not allow.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import time

from ..spaces import sexpr
from .db import new_id, now
from .result_schema import validate as schema_errors

log = logging.getLogger("omegahive.mcp")

HARNESSES = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "hermes": "Hermes Agent",
    "kimi": "Kimi CLI",
    "mcp": "Any MCP client",
}
# How each harness joins, as steps {label, text}; {url} and {code} are filled in when an invite is made (the code is
# shown once). The same shape the Connect page shows (hive/ui ConnectHarness setup()), kept here so every surface
# reads one list. Kimi CLI (Moonshot AI) adds an HTTP MCP server with `kimi mcp add`, like Claude Code.
JOIN = {
    "claude-code": [{"label": "In a terminal",
                     "text": 'claude mcp add --transport http omegahive {url} --header "Authorization: Bearer {code}"'}],
    "codex": [{"label": "Add to ~/.codex/config.toml",
               "text": '[mcp_servers.omegahive]\nurl = "{url}"\nbearer_token_env_var = "OMEGAHIVE_TOKEN"'},
              {"label": "Then, in the shell that runs Codex", "text": "export OMEGAHIVE_TOKEN={code}"}],
    "hermes": [{"label": "Add to the Hermes config (mcp_servers)",
                "text": 'mcp_servers:\n  omegahive:\n    url: "{url}"\n    headers:\n      Authorization: "Bearer {code}"'}],
    "kimi": [{"label": "In a terminal",
              "text": 'kimi mcp add --transport http omegahive {url} --header "Authorization: Bearer {code}"'}],
    "mcp": [{"label": "Server URL (streamable HTTP)", "text": "{url}"},
            {"label": "Header", "text": "Authorization: Bearer {code}"}],
}
# Who pays for an outside harness's thinking. An outside member always thinks on its own model, in its own process:
# "own-subscription" (the default) says it runs on the person's own plan (a Claude, ChatGPT or Kimi subscription);
# "hive-keys" records that it is meant to think on the hive's keys. The hive meters only calls through its own model
# route, so today this is the label people read in the listing; it changes no limit.
BILLING = ("own-subscription", "hive-keys")


def join_steps(harness, url, code):
    """The join steps for one harness with its address and one-time code filled in."""
    return [{"label": s["label"], "text": s["text"].replace("{url}", str(url)).replace("{code}", str(code))}
            for s in JOIN.get(harness, JOIN["mcp"])]


def catalogue():
    """Every supported harness: id, label, the billing choices and the join steps with {url} and {code} unfilled."""
    return [{"id": h, "label": label, "billing": list(BILLING), "default_billing": BILLING[0], "setup": JOIN[h]}
            for h, label in HARNESSES.items()]
PROTOCOL = "2025-06-18"
SCHEMA_MARKER = "s3-r1"  # the schema revision tools/list reports; documented in hive/MCP_S3.md
SERVER_VERSION = "0.2.0"
CURSOR_SECONDS = 600
PAGE_RECORDS = 200
WIRE_HASH = re.compile(r"sha256:[a-f0-9]{64}\Z")
SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_idempotency (
  agent_id TEXT NOT NULL, tool TEXT NOT NULL, idem_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
  response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, tool, idem_key)
);
CREATE TABLE IF NOT EXISTS harness_invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, harness TEXT NOT NULL, name TEXT NOT NULL, swarm_id TEXT NOT NULL,
  role_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL NOT NULL,
  redeemed_at TEXT, agent_id TEXT, revoked_at TEXT
);
"""


def _hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


class McpError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def _props(properties=None, required=None):
    schema = {"type": "object", "properties": properties or {}, "additionalProperties": False}
    if required:
        schema["required"] = required
    return schema


_S = {"type": "string"}
_SUBJECT = {"type": "object", "properties": {"artifact_id": _S, "revision": {"type": "integer", "minimum": 0}, "digest": _S},
            "required": ["artifact_id", "revision", "digest"], "additionalProperties": False}
_TO = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["service", "swarm"]}, "name": _S, "id": _S},
       "required": ["kind"], "additionalProperties": False}

# The read tools' schemas are kept exactly equal to the shapes HiveConnect's draft client pins (draft_client.py READ_SCHEMAS);
# limits that schema cannot carry are enforced in code (see _check_args) and published in hive/MCP_S3.md.
TOOLS = [
    {"name": "hive_whoami", "description": "Who you are in the hive: your name, swarm, role and the instructions your role gives you. Read this first.",
     "inputSchema": _props()},
    {"name": "hive_inbox", "description": "New messages for you (from people and minds), after a cursor. Pass the highest seq you have seen as 'after'.",
     "inputSchema": _props({"after": {"type": "integer", "minimum": 0}})},
    {"name": "hive_send", "description": "Reply in a conversation. Use the conversation_id of the message you are answering.",
     "inputSchema": _props({"text": {"type": "string", "maxLength": 8000}, "conversation_id": _S}, ["text"])},
    {"name": "hive_goals", "description": "Your swarm's tasks (goals). status: open (default), claimed, done, or all.",
     "inputSchema": _props({"status": {"type": "string", "enum": ["open", "claimed", "waiting", "done", "failed", "all"]}})},
    {"name": "hive_goal_claim", "description": "Claim an open task (goal) so others know you are on it. A claim is a lease: report a result before it lapses.",
     "inputSchema": _props({"goal_id": _S}, ["goal_id"])},
    {"name": "hive_goal_get", "description": "One task (goal) in full: detail, binding and binding_digest, deadline, result schema and review spec.",
     "inputSchema": _props({"goal_id": _S}, ["goal_id"])},
    {"name": "hive_goal_result",
     "description": "Report on a task (goal) you hold: done with a result, failed with why, or waiting on a person. A bound task needs its binding_digest "
                    "(top level, exactly as hive_goal_get shows it). data is the structured result; it is checked against the task's result schema.",
     "inputSchema": _props({"goal_id": _S, "status": {"type": "string", "enum": ["done", "failed", "waiting"]},
                            "result": {"type": "string", "maxLength": 4000}, "data": {"type": "object"}, "binding_digest": _S},
                           ["goal_id", "status", "result"])},
    {"name": "hive_goal_heartbeat", "description": "Renew the lease on a task (goal) you hold (also resumes it from waiting). Never reopens cancelled, expired or done work.",
     "inputSchema": _props({"goal_id": _S}, ["goal_id"])},
    {"name": "hive_goal_cancel_ack", "description": "Acknowledge that a task (goal) you held was cancelled or expired, and stop work on it.",
     "inputSchema": _props({"goal_id": _S}, ["goal_id"])},
    {"name": "hive_goal_create", "description": "Propose a new task (goal), or a subtask of one you hold, for your swarm.",
     "inputSchema": _props({"title": {"type": "string", "maxLength": 200}, "detail": {"type": "string", "maxLength": 2000}, "parent_id": _S}, ["title"])},
    {"name": "hive_exhibit_read",
     "description": "Read an exhibit shared with you, one page at a time. expected_digest is required: a different digest is refused and no content is returned. "
                    "Follow next_cursor until end is true.",
     "inputSchema": _props({"share_id": _S, "cursor": _S, "expected_digest": _S}, ["share_id", "expected_digest"])},
    {"name": "hive_artifact_read",
     "description": "Read one exact artifact revision. expected_digest is required: a different digest is refused and no content is returned.",
     "inputSchema": _props({"artifact_id": _S, "revision": {"type": "integer"}, "expected_digest": _S}, ["artifact_id", "revision", "expected_digest"])},
    {"name": "hive_revision_read", "description": "Alias of hive_artifact_read.",
     "inputSchema": _props({"artifact_id": _S, "revision": {"type": "integer"}, "expected_digest": _S}, ["artifact_id", "revision", "expected_digest"])},
    {"name": "hive_request",
     "description": "Ask another swarm or a service for work, as a typed request made for a task you hold. idempotency_key is required: a retry with the "
                    "same key and payload returns the first answer and creates nothing new. Returns request_id and goal_id.",
     "inputSchema": _props({"kind": _S, "to": _TO, "subject": _SUBJECT, "from_goal": _S, "title": {"type": "string", "maxLength": 300},
                            "deadline_minutes": {"type": "number", "minimum": 1, "maximum": 43200}, "budget_usd": {"type": "number", "minimum": 0},
                            "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 200}, "contract": {"type": "object"},
                            "detail": {"type": "string", "maxLength": 2000}, "constraints": {"type": "object"}},
                           ["kind", "to", "from_goal", "title", "deadline_minutes", "idempotency_key"])},
    {"name": "hive_motivation_create",
     "description": "Name an aim (a motivation) of your own (scope self, the default) or of your swarm (scope team). The hive records you as "
                    "its creator and scopes it to your swarm, whose people can see it. operation_id is required: a retry with the same id and "
                    "body returns the first motivation and creates nothing new.",
     "inputSchema": _props({"title": {"type": "string", "maxLength": 200}, "why": {"type": "string", "maxLength": 4000},
                            "scope": {"type": "string", "enum": ["self", "team"]},
                            "operation_id": {"type": "string", "pattern": "^[A-Za-z0-9_.:-]{8,120}$"}}, ["title", "operation_id"])},
    {"name": "hive_motivations", "description": "The motivations you created yourself (only those).", "inputSchema": _props()},
    {"name": "hive_capabilities",
     "description": "This member's tool inventory. Until the boot-receipt seam (S4) lands it says availability no-boot-receipt and every skill is unknown.",
     "inputSchema": _props()},
    {"name": "hive_publish", "description": "Publish a belief to your swarm's commons as a MeTTa statement with frequency f and confidence c, e.g. (--> sky blue), 0.9, 0.8. Only claim what you have evidence for.",
     "inputSchema": _props({"statement": {"type": "string", "maxLength": 2000}, "f": {"type": "number", "minimum": 0, "maximum": 1},
                            "c": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1}}, ["statement", "f", "c"])},
    {"name": "hive_query", "description": "Search your swarm's commons with a MeTTa pattern, e.g. (Current (--> sky $x) $tv $stamp).",
     "inputSchema": _props({"pattern": {"type": "string", "maxLength": 2000}}, ["pattern"])},
    {"name": "hive_evidence_query",
     "description": "Query evidence as OmegaAtom snapshots, one snapshot per scope per page, each record with its full lineage closure (premises and withdrawal controls). "
                    "scopes: tagged objects {scope_id} or {grant_id}, optionally with expected_revision; your own scope is always included. "
                    "Follow next_cursor until end is true.",
     "inputSchema": _props({"pattern": _S, "scopes": {"type": "array", "items": {"type": "object"}}, "cursor": _S}, ["pattern"])},
    {"name": "hive_repo_query",
     "description": "Read repository maps (repo-map/1), read-only, as yourself. view: maps (the maps you can see), map (one revision's header "
                    "and coverage), presets, nodes (kind, path_prefix, q), node (node_id with its edges), query (preset + params) or drift "
                    "(from, to). Follow next_cursor while truncated is true.",
     "inputSchema": _props({"view": {"type": "string", "enum": ["maps", "map", "presets", "nodes", "node", "query", "drift"]},
                            "repo": _S, "sha": _S, "node_id": _S, "kind": _S, "path_prefix": _S, "q": _S, "preset": _S,
                            "params": {"type": "object"}, "from": _S, "to": _S,
                            "limit": {"type": "integer", "minimum": 1, "maximum": 200}, "cursor": _S}, ["view"])},
]
# Built, but gated off until the evidence session (S1) lands: not listed, and a call is refused (see _gated).
GATED = {"hive_evidence_publish": {
    "description": "Publish one evidence record with an OmegaAtom envelope (S1). Gated off: the host answers 501 evidence_publish_gated.",
    "inputSchema": _props({"statement": {"type": "string", "maxLength": 2000}, "f": {"type": "number", "minimum": 0, "maximum": 1},
                           "c": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1}, "unknown": {"type": "boolean"},
                           "envelope": {"type": "object"}, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 200}},
                          ["statement", "envelope", "idempotency_key"])}}
TOOL_INDEX = {t["name"]: t for t in TOOLS}
# J3 host R6 (open item OI-11): a Studio maker's three calls for a hub (omega-kind) maker, the same handlers as the REST
# maker routes (GET .../studio-sessions/{sid}/context, POST /api/agent/artifacts/{id}/revisions, POST .../steps/{n}/done)
# with this request's own authentication. Listed and callable only while Studio sessions are on; with Studio off they are
# exactly unknown tools, so the surface is unchanged.
_ID = {"type": "string", "minLength": 1, "maxLength": 200}
STUDIO_TOOLS = [
    {"name": "hive_studio_context",
     "description": "Studio maker: read your session context first in every step (session ss_..., the step's execution_id "
                    "ex_... from the studio_step event, after_dir = the last direction seq you read). Returns the step, the "
                    "piece, the person's directions, the proposal artifact and the expected parent.",
     "inputSchema": _props({"session_id": _ID, "execution_id": _ID, "after_dir": {"type": "integer", "minimum": 0}},
                           ["session_id"])},
    {"name": "hive_studio_publish",
     "description": "Studio maker: publish this step's one proposal to the session's proposal artifact (ar_...). body is the "
                    "exact omega-maker-revision-2 JSON text, stored byte for byte; its items[].op_id (1-16, distinct, new in "
                    "this session) are sent beside it, never minted. parent is the context's parent (null for none).",
     "inputSchema": _props({"artifact_id": _ID, "body": {"type": "string", "minLength": 1}, "execution_id": _ID,
                            "parent": {"type": ["integer", "null"], "minimum": 0}}, ["artifact_id", "body", "execution_id"])},
    {"name": "hive_studio_done",
     "description": "Studio maker: finish step n of session ss_... with its execution_id; more = true when the piece needs "
                    "another step of your own, else false. After this the step makes no more calls.",
     "inputSchema": _props({"session_id": _ID, "n": {"type": "integer", "minimum": 1}, "execution_id": _ID,
                            "more": {"type": "boolean"}}, ["session_id", "n", "execution_id", "more"])},
]
STUDIO_INDEX = {t["name"]: t for t in STUDIO_TOOLS}
STUDIO_OP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")   # the host's shape (L6 wire contract), as the Iter tool
STUDIO_MAX_OPS = 16


def studio_op_ids(body):
    """The op ids exactly as the body's items carry them, in order; never minted or rewritten. None unless 1-16 distinct.
    The same rule as hive/templates/iter/tools/hive_studio_publish.py _op_ids."""
    try:
        items = json.loads(body).get("items")
    except (ValueError, AttributeError, TypeError):
        return None
    if not isinstance(items, list) or not 1 <= len(items) <= STUDIO_MAX_OPS:
        return None
    ops = [item.get("op_id") if isinstance(item, dict) else None for item in items]
    if not all(isinstance(op, str) and STUDIO_OP_ID.fullmatch(op) for op in ops) or len(set(ops)) != len(ops):
        return None
    return ops
# the native skill each tool is decided under (r2.4 item 9); None = no native skill, nothing to decide
POLICY = {"hive_whoami": None, "hive_inbox": None, "hive_send": "send", "hive_goals": "hive-goals", "hive_goal_claim": "hive-goal-claim",
          "hive_goal_create": "hive-goal-create", "hive_goal_get": "hive-goal-get", "hive_goal_heartbeat": "hive-goal-heartbeat",
          "hive_goal_cancel_ack": "hive-goal-cancel-ack", "hive_exhibit_read": "hive-shared", "hive_artifact_read": "hive-revision-read",
          "hive_revision_read": "hive-revision-read", "hive_request": "hive-request", "hive_capabilities": "hive-capabilities",
          "hive_motivation_create": "hive-motivation-create", "hive_motivations": "hive-motivations", "hive_publish": "hive-publish", "hive_query": "hive-query", "hive_evidence_query": "hive-query",
          "hive_repo_query": "repo-query",
          "hive_goal_result": ("hive-goal-done", "hive-goal-fail", "hive-goal-wait")}
# hive error codes that reach s3-r1 clients under their contract names (r2.4 item 8)
CODE_MAP = {"goal_expired": "deadline_passed", "request_budget": "spend_limit", "connection_budget": "spend_limit"}
MAX_ID = 200


def _canon(skill, *args):
    """A stable command text, so a person approves exactly what runs (same shape as the sharing routes)."""
    clean = [re.sub(r"[^A-Za-z0-9 _.,:@/-]", "", str(a if a is not None else ""))[:120] for a in args]
    return "(" + skill + "".join(f' "{c}"' for c in clean) + ")"


def _digest_of(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def _epoch(moment):
    try:
        return datetime.datetime.fromisoformat(str(moment).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _atom():
    """OmegaAtom's own validator and projection; the host reuses them and re-implements nothing.

    OMEGAATOM_PATH names the directory that holds the ``omegaatom`` package when it is not already importable."""
    try:
        import omegaatom.envelope as envelope
        import omegaatom.projection as projection
    except ImportError:
        path = os.environ.get("OMEGAATOM_PATH")
        if path and path not in sys.path:
            sys.path.insert(0, path)
        try:
            import omegaatom.envelope as envelope
            import omegaatom.projection as projection
        except ImportError:
            raise McpError(501, "evidence_unavailable", "OmegaAtom's validator is not installed on this host") from None
    return envelope, projection


def _matches(pattern, value, binding):
    """Structural match of a parsed pattern against an atom statement: $variables bind consistently, all else is exact."""
    if isinstance(pattern, sexpr.Var):
        if pattern in binding:
            return binding[pattern] == value
        binding[pattern] = value
        return True
    if isinstance(pattern, list):
        return (isinstance(value, list) and len(value) == len(pattern)
                and all(_matches(p, v, binding) for p, v in zip(pattern, value)))
    if isinstance(pattern, (int, float)) and isinstance(value, (int, float)) and not isinstance(pattern, bool):
        return pattern == value
    return isinstance(value, str) and str(pattern) == value


class Harnesses:
    def __init__(self, hive):
        self.hive = hive
        with hive.db._lock:
            hive.db._conn.executescript(SCHEMA)
        # additive (First Light R1a): who pays for the harness's thinking, shown in the listing
        if "billing" not in {r["name"] for r in hive.db.all("PRAGMA table_info(harness_invites)")}:
            hive.db.execute("ALTER TABLE harness_invites ADD COLUMN billing TEXT NOT NULL DEFAULT 'own-subscription'")
        self.calls = {}  # agent_id -> recent call times, for a per-member rate limit
        self._key = secrets.token_bytes(32)  # signs cursors; a restart ends open cursors, which live ten minutes anyway
        self._idem_lock = asyncio.Lock()
        self.evidence_source = None  # callable(scope_id) -> OmegaAtom snapshot; the host's evidence store (S1) plugs in here

    @property
    def db(self):
        return self.hive.db

    # ---- invitations -----------------------------------------------------------------------------

    def invite(self, harness, name, swarm_id, role_id=None, ttl_minutes=60, by="user:operator", billing=None):
        if harness not in HARNESSES:
            raise McpError(400, "bad_harness", f"harness is one of {sorted(HARNESSES)}")
        billing = BILLING[0] if billing is None else billing
        if billing not in BILLING:
            raise McpError(400, "bad_billing", f"billing is one of {list(BILLING)}")
        name = str(name or "").strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.-]{0,31}", name):
            raise McpError(400, "bad_name", "a name is 1-32 letters, digits, spaces, dots, dashes or underscores")
        if self.db.one("SELECT 1 FROM agents WHERE lower(name) = lower(?) AND deleted = 0", (name,)):
            raise McpError(409, "name_taken", f"{name} is already in the hive")
        self.hive.swarm(swarm_id)
        self.hive.require_open_swarm(swarm_id)   # no new outside member joins a retired swarm
        if role_id:
            self.hive.roles.get(role_id)
        ttl = max(5.0, min(float(ttl_minutes or 60), 7 * 24 * 60))
        code = "ohv1_" + secrets.token_urlsafe(32)
        row = {"id": new_id("hi"), "code_hash": _hash(code), "harness": harness, "name": name, "swarm_id": swarm_id,
               "role_id": role_id, "created_by": by, "created_at": now(), "expires_at": time.time() + ttl * 60,
               "billing": billing}
        self.db.insert("harness_invites", row)
        return self.view(row | {"redeemed_at": None, "agent_id": None, "revoked_at": None}), code

    def view(self, row):
        status = "revoked" if row["revoked_at"] else "connected" if row["redeemed_at"] else (
            "expired" if row["expires_at"] <= time.time() else "waiting")
        return {k: row[k] for k in ("id", "harness", "name", "swarm_id", "role_id", "created_by", "created_at", "expires_at",
                                    "redeemed_at", "agent_id", "revoked_at")} | {
            "status": status, "harness_label": HARNESSES.get(row["harness"], row["harness"]),
            "billing": row.get("billing") or BILLING[0]}

    def list(self):
        return [self.view(r) for r in self.db.all("SELECT * FROM harness_invites ORDER BY created_at DESC LIMIT 200")]

    def get(self, invite_id):
        row = self.db.one("SELECT * FROM harness_invites WHERE id = ?", (invite_id,))
        if row is None:
            raise McpError(404, "not_found", f"no invitation {invite_id}")
        return self.view(row)

    def revoke(self, invite_id):
        row = self.db.one("SELECT * FROM harness_invites WHERE id = ?", (invite_id,))
        if row is None:
            raise McpError(404, "not_found", f"no invitation {invite_id}")
        self.db.execute("UPDATE harness_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now(), invite_id))
        if row["agent_id"]:
            self.hive.delete_agent(row["agent_id"])  # the credential ends with the member
        return self.get(invite_id)

    # ---- the credential --------------------------------------------------------------------------

    def member(self, token):
        """The member behind a bearer token: an existing member, or a fresh invite redeemed now."""
        if not token:
            return None
        agent = self.hive.authenticate_agent(token)
        if agent is not None:
            return agent
        if not token.startswith("ohv1_"):
            return None
        row = self.db.one("SELECT * FROM harness_invites WHERE code_hash = ?", (_hash(token),))
        if row is None or row["revoked_at"] or row["redeemed_at"] or row["expires_at"] <= time.time():
            return None
        created = self.hive.create_agent(row["name"], "module", row["swarm_id"], "mock/echo", "", None, 0, None, row["role_id"],
                                         by=row["created_by"])   # host-identity r1.1: the admin who made the invite gave the role
        # the code becomes this member's credential; nothing else knows it
        self.db.execute("UPDATE agents SET token_hash = ? WHERE id = ?", (_hash(token), created["id"]))
        cur = self.db.execute("UPDATE harness_invites SET redeemed_at = ?, agent_id = ? WHERE id = ? AND redeemed_at IS NULL",
                              (now(), created["id"], row["id"]))
        if cur.rowcount != 1:  # redeemed concurrently
            self.hive.delete_agent(created["id"])
            return self.hive.authenticate_agent(token)
        self.hive.events.publish("harness.connected", invite=self.get(row["id"]))
        return self.hive.authenticate_agent(token)

    def rate_ok(self, agent_id, limit=120):
        moment = time.monotonic()
        recent = [t for t in self.calls.get(agent_id, []) if moment - t < 60]
        if len(recent) >= limit:
            self.calls[agent_id] = recent
            return False
        recent.append(moment)
        self.calls[agent_id] = recent
        return True

    # ---- MCP ------------------------------------------------------------------------------------

    async def handle(self, agent, message):
        """One JSON-RPC message; returns the response object, or None for a notification."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
        method, mid = message["method"], message.get("id")
        if mid is None:
            return None  # notifications (e.g. notifications/initialized) need no answer
        if method == "initialize":
            return self._ok(mid, {"protocolVersion": PROTOCOL, "capabilities": {"tools": {"listChanged": False}},
                                  "serverInfo": {"name": "omegahive", "version": SERVER_VERSION},
                                  "instructions": f"You are {agent['name']}, a member of an OmegaHive swarm. Call hive_whoami first, then check hive_inbox and hive_goals regularly."})
        if method == "ping":
            return self._ok(mid, {})
        if method == "tools/list":
            return self._ok(mid, {"tools": TOOLS + STUDIO_TOOLS if self._studio_on() else TOOLS,
                                  "_meta": {"x-hive-schema": SCHEMA_MARKER}})
        if method == "tools/call":
            params = message.get("params")
            try:
                if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                    raise McpError(400, "bad_request", "params must be an object with a tool name")
                args = params.get("arguments")
                args = {} if args is None else args
                if not isinstance(args, dict):
                    raise McpError(400, "bad_request", "arguments must be an object")
                name = params["name"]
                return self._ok(mid, self._result(name, await self.call(agent, name, args)))
            except Exception as exc:  # hive errors carry a status and code; anything else is ours and stays opaque
                return self._fail(mid, exc)
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}

    @staticmethod
    def _ok(mid, result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    @staticmethod
    def _fail(mid, exc):
        """s3-r1: every tool error is a JSON-RPC error, -32000, with data {code, http_status, message}."""
        status, code = getattr(exc, "status", None), getattr(exc, "code", None)
        if not isinstance(status, int) or not isinstance(code, str):
            log.exception("mcp tool failed")
            status, code, message, details = 500, "internal_error", "the hive could not complete that call", None
        else:
            message, details = str(getattr(exc, "message", None) or exc)[:500], getattr(exc, "details", None)
            if code == "result_invalid" and status == 422:
                code = "schema_invalid"
            elif code in CODE_MAP:
                code = CODE_MAP[code]
        data = {"code": code, "http_status": status, "message": message}
        if details:
            data["details"] = details
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": message, "data": data}}

    @staticmethod
    def _summary(name, value):
        """The one-line text beside structuredContent."""
        if not isinstance(value, dict):
            return f"{name}: ok"
        facts = []
        for key in ("id", "status", "share_id", "artifact_id", "revision", "request_id", "goal_id", "returned", "end", "availability"):
            if key in value and not isinstance(value[key], (dict, list)):
                facts.append(f"{key}={value[key]}")
        if isinstance(value.get("goals"), list):
            facts.append(f"{len(value['goals'])} tasks")
        if isinstance(value.get("snapshots"), list):
            facts.append(f"{sum(len(s['records']) for s in value['snapshots'])} records")
        return re.sub(r"\s+", " ", f"{name}: ok" + (" (" + ", ".join(facts) + ")" if facts else ""))[:300]

    def _result(self, name, value):
        if not isinstance(value, dict):
            value = {"value": value}
        value = json.loads(json.dumps(value, ensure_ascii=False))  # plain JSON, exactly what a client will parse
        return {"content": [{"type": "text", "text": self._summary(name, value)}], "structuredContent": value, "isError": False}

    # ---- argument checks, cursors, policy -----------------------------------------------------------

    def _check_args(self, name, args):
        schema = (TOOL_INDEX.get(name) or STUDIO_INDEX.get(name) or GATED[name])["inputSchema"]
        problems = schema_errors(args, schema)
        for key in ("goal_id", "share_id", "artifact_id", "from_goal", "parent_id", "conversation_id"):
            if isinstance(args.get(key), str) and not 0 < len(args[key]) <= MAX_ID:
                problems.append(f"$.{key}: 1 to {MAX_ID} characters")
        if isinstance(args.get("expected_digest"), str) and not WIRE_HASH.fullmatch(args["expected_digest"]):
            problems.append("$.expected_digest: must be sha256:<64 hex>")
        if isinstance(args.get("binding_digest"), str) and not WIRE_HASH.fullmatch(args["binding_digest"]):
            problems.append("$.binding_digest: must be sha256:<64 hex>")
        if isinstance(args.get("pattern"), str) and not 0 < len(args["pattern"]) <= 2000:
            problems.append("$.pattern: 1 to 2000 characters")
        if isinstance(args.get("cursor"), str) and not 0 < len(args["cursor"]) <= 2000:
            problems.append("$.cursor: 1 to 2000 characters")
        if isinstance(args.get("scopes"), list) and len(args["scopes"]) > 100:
            problems.append("$.scopes: at most 100 scopes")
        if isinstance(args.get("revision"), int) and args["revision"] < 0:
            problems.append("$.revision: at least 0")
        if problems:
            raise McpError(400, "bad_request", "; ".join(problems[:6])[:500])

    def _enforce(self, agent, skill, *parts):
        self.hive.policy.enforce(agent, skill, _canon(skill, *parts))

    def _cursor_make(self, kind, agent, binding, position, expires):
        body = {"k": kind, "m": agent["id"], "b": binding, "i": position, "x": int(min(time.time() + CURSOR_SECONDS, expires or 2**62))}
        raw = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
        return raw + "." + hmac.new(self._key, raw.encode(), "sha256").hexdigest()[:32]

    def _cursor_read(self, token, kind, agent, binding):
        """An opaque cursor is bound to the member, the resource and its exact digest/revision, and lives ten minutes at most."""
        try:
            raw, sig = token.split(".")
            if not hmac.compare_digest(sig, hmac.new(self._key, raw.encode(), "sha256").hexdigest()[:32]):
                raise ValueError
            body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
            ok = body["k"] == kind and body["m"] == agent["id"] and type(body["i"]) is int and body["i"] >= 0
        except (ValueError, KeyError, TypeError):
            raise McpError(400, "bad_cursor", "that cursor is not valid for this call") from None
        if not ok:
            raise McpError(400, "bad_cursor", "that cursor is not valid for this call")
        if body["x"] <= time.time():
            raise McpError(410, "cursor_expired", "that cursor has expired; start the read again")
        if body["b"] != binding:
            raise McpError(409, "stale_revision" if kind == "evidence" else "digest_mismatch",
                           "the resource changed since this cursor was issued; start the read again")
        return body["i"]

    # ---- the tools ---------------------------------------------------------------------------------

    def _studio_on(self):
        studio = getattr(self.hive, "studio", None)
        return bool(studio is not None and getattr(studio, "enabled", False))

    async def call(self, agent, name, args):
        hive = self.hive
        if name in STUDIO_INDEX and self._studio_on():
            # OI-11 / r1.4 G2: the agent row this request authenticated with (its token epoch captured on arrival), never
            # re-read here; the host's own consuming transactions decide (context, revision_fence, done). Like the REST
            # maker routes, no native skill decides these calls.
            self._check_args(name, args)
            return await getattr(self, "_t_" + name)(agent, args)
        if name in GATED:
            self._check_args(name, args)
            raise McpError(501, "evidence_publish_gated", "evidence publication is not enabled on this host yet (S1)")
        if name not in TOOL_INDEX:
            raise McpError(404, "unknown_tool", f"no tool {name}")
        self._check_args(name, args)
        agent = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent["id"],)) or agent
        skill = POLICY[name]
        if isinstance(skill, str) and name not in ("hive_publish", "hive_query", "hive_evidence_query", "hive_send", "hive_exhibit_read",
                                                    "hive_artifact_read", "hive_revision_read", "hive_request", "hive_repo_query"):
            self._enforce(agent, skill, args.get("goal_id") or args.get("title") or "")  # decided under the native skill name
        return await getattr(self, "_t_" + name)(agent, args)

    # ---- Studio maker tools (OI-11) ------------------------------------------------------------------

    async def _t_hive_studio_context(self, agent, args):
        return self.hive.studio.context(agent, args["session_id"], args.get("execution_id") or None, args.get("after_dir") or 0)

    async def _t_hive_studio_publish(self, agent, args):
        body = args["body"]
        ops = studio_op_ids(body)
        if ops is None:
            raise McpError(400, "op_ids_invalid", "body must be omega-maker-revision-2 JSON whose items carry 1-16 distinct "
                           "op_id strings; nothing was sent")
        hive, artifact_id = self.hive, args["artifact_id"]
        try:
            view = hive.collab.add_revision(agent, artifact_id, {"body": body, "parent": args.get("parent"),
                                                                 "execution_id": args["execution_id"], "op_ids": ops})
        except Exception as exc:   # noqa: BLE001  (only the one refusal below is answered; anything else is re-raised)
            details = getattr(exc, "details", None) or {}
            if getattr(exc, "code", None) != "step_already_published" or type(details.get("revision")) is not int:
                raise
            # R6.2 (Kimi R6.0): the host checked this execution first, so the proposal is this step's own, published
            # earlier (e.g. by a process that ended before a redelivery): answer it rather than fail the step.
            existing = hive.db.one("SELECT r.digest, s.op_ids FROM artifact_revisions r JOIN studio_steps s ON "
                                   "s.proposal_n = r.n JOIN studio_sessions x ON x.id = s.session_id AND "
                                   "x.proposal_artifact_id = r.artifact_id WHERE r.artifact_id = ? AND r.n = ?",
                                   (artifact_id, details["revision"]))
            if existing is None:
                raise
            return {"artifact_id": artifact_id, "revision": details["revision"], "digest": existing["digest"],
                    "op_ids": json.loads(existing["op_ids"]) if existing["op_ids"] else None, "already_published": True}
        studio = hive.db.one("SELECT id FROM studio_sessions WHERE proposal_artifact_id = ?", (artifact_id,))
        if studio:
            await hive.studio.advance(studio["id"])
        return {"artifact_id": artifact_id, "revision": view.get("n"), "digest": view.get("digest"), "op_ids": ops}

    async def _t_hive_studio_done(self, agent, args):
        return await self.hive.studio.done(agent, args["session_id"], args["n"],
                                           {"more": args["more"], "execution_id": args["execution_id"]})

    async def _t_hive_whoami(self, agent, args):
        hive = self.hive
        view = hive.agent(agent["id"])
        swarm = hive.swarm(agent["swarm_id"]) if agent.get("swarm_id") else None
        return {"id": view["id"], "name": view["name"], "swarm": {"id": swarm["id"], "name": swarm["name"], "purpose": swarm["description"]} if swarm else None,
                "role": view.get("role_prompt") or None, "instructions": view.get("persona") or None}

    async def _t_hive_inbox(self, agent, args):
        after = args.get("after", 0)
        if after is None:
            after = 0
        if type(after) is not int or after < 0:   # an exact, non-negative seq; no floats, no rewinding below zero (Kimi)
            raise McpError(400, "bad_request", "after is a non-negative integer seq")
        out = self.hive.inbox(agent["id"], after)
        messages = []
        for m in out["messages"]:
            try:
                body = json.loads(m["text"])
            except ValueError:
                body = {"text": m["text"]}
            messages.append({"seq": m["seq"], "from": body.get("sender"), "conversation_id": body.get("conversation_id"), "text": body.get("text")})
        return {"messages": messages}

    async def _t_hive_send(self, agent, args):
        text = str(args.get("text") or "").strip()
        if not text:
            raise McpError(400, "empty", "text is required")
        self._enforce(agent, "send", args.get("conversation_id") or "")
        msg = self.hive.record_agent_message(agent["id"], {"text": text, "conversation_id": args.get("conversation_id"), "client_seq": new_id("mcp")})
        return {"sent": msg["id"], "conversation_id": msg["conversation_id"]}

    async def _t_hive_goals(self, agent, args):
        status = args.get("status") or "open"
        goals = self.hive.goals.list(agent["swarm_id"], None if status == "all" else status) if agent.get("swarm_id") else []
        return {"goals": [{k: g.get(k) for k in ("id", "title", "detail", "status", "priority", "claimed_by", "parent_id", "result", "lease_until")} for g in goals[:100]]}

    async def _t_hive_goal_claim(self, agent, args):
        return self.hive.goals.claim(agent, args["goal_id"])

    async def _t_hive_goal_get(self, agent, args):
        return self.hive.goals.for_agent(agent, args["goal_id"])

    async def _t_hive_goal_heartbeat(self, agent, args):
        return self.hive.goals.heartbeat(agent, args["goal_id"])

    async def _t_hive_goal_cancel_ack(self, agent, args):
        return self.hive.goals.cancel_ack(agent, args["goal_id"])

    async def _t_hive_goal_result(self, agent, args):
        hive, status = self.hive, args["status"]
        top, data = args.get("binding_digest"), args.get("data")
        # A person approving this sees, and is bound to, the binding digest and a digest of the exact result (Kimi 2026-10-04).
        # The person sees a readable excerpt of the result; the full digest binds the approval to exactly that content.
        closing = _digest_of({"result": args["result"], "data": data, "status": status})
        excerpt = " ".join(str(args["result"]).split())[:100]
        self._enforce(agent, {"done": "hive-goal-done", "waiting": "hive-goal-wait"}.get(status, "hive-goal-fail"),
                      args["goal_id"], top or "-", excerpt, closing)
        if isinstance(data, dict) and "binding_digest" in data and data["binding_digest"] != top:
            # the digest lives at the top level only; a different one nested in the data is a conflict, never a choice
            raise McpError(409, "binding_mismatch", "data.binding_digest conflicts with the top-level binding_digest")
        # the structured result travels as the goal's proposal, which is where its result schema and app validator look
        goal = await hive.goals.result(agent, args["goal_id"], status, args["result"], {"proposal": data} if data is not None else None,
                                 top_digest=top, strict_binding=True)
        await hive.goals.notify_parent(goal)
        return goal

    async def _t_hive_goal_create(self, agent, args):
        if not agent.get("swarm_id"):
            raise McpError(400, "no_swarm", "you are not in a swarm")
        return await self.hive.goals.create(agent["swarm_id"], str(args.get("title", "")), str(args.get("detail", "")), 0.5,
                                            args.get("parent_id"), created_by=f"agent:{agent['id']}")

    async def _t_hive_motivation_create(self, agent, args):
        return self.hive.motivations.agent_create(agent, args)

    async def _t_hive_motivations(self, agent, args):
        return self.hive.motivations.agent_list(agent)

    async def _t_hive_publish(self, agent, args):
        self.hive.policy.enforce(agent, "hive-publish", f"(hive-publish {args.get('statement')} {args.get('f')} {args.get('c')})")
        return self.hive.publish(agent["id"], str(args.get("statement", "")), float(args.get("f")), float(args.get("c")))

    async def _t_hive_query(self, agent, args):
        self.hive.policy.enforce(agent, "hive-query", f"(hive-query {args.get('pattern')})")
        return self.hive.query(agent["id"], str(args.get("pattern", "")))

    async def _t_hive_exhibit_read(self, agent, args):
        hive, share_id, expected = self.hive, args["share_id"], args["expected_digest"]
        share = hive.shares.get(share_id)
        # identity and the grant come first; only then may the member learn that a digest differs, and never the content
        if share["grantee_id"] != agent["id"]:
            raise McpError(403, "forbidden", "this share is not yours")
        if share["status"] != "active" or (share["expires_at"] and share["expires_at"] < now()):
            raise McpError(410, "share_closed", f"share is {share['status']}" + (" (expired)" if share["status"] == "active" else ""))
        if share["kind"] != "exhibit":
            raise McpError(409, "not_exhibit", "hive_exhibit_read reads exhibits; this share is a memory space")
        exhibit = hive.db.one("SELECT digest FROM exhibits WHERE id = ?", (share["exhibit_id"],))
        if not exhibit or exhibit["digest"] != expected:
            raise McpError(409, "digest_mismatch", "the exhibit's digest is not the one you expected; nothing was returned")
        expires = _epoch(share["expires_at"]) if share["expires_at"] else None
        binding = [share_id, expected]
        offset = self._cursor_read(args["cursor"], "exhibit", agent, binding) if args.get("cursor") else 0
        page = hive.shares.read(agent, share_id, None, PAGE_RECORDS, offset)  # re-checks the grant and the policy on every page
        following = page["next_offset"]
        return {"share_id": share_id, "title": page["title"], "source": page["source"], "digest": page["digest"], "body": page["body"],
                "body_bytes": page["body_bytes"], "atoms": page["atoms"], "total": page["total"], "offset": page["offset"],
                "returned": page["returned"], "expires_at": page["expires_at"],
                "next_cursor": self._cursor_make("exhibit", agent, binding, following, expires) if following is not None else None,
                "end": following is None}

    async def _t_hive_artifact_read(self, agent, args):
        hive, artifact_id, n, expected = self.hive, args["artifact_id"], args["revision"], args["expected_digest"]
        self._enforce(agent, "hive-revision-read", artifact_id, n)
        view = hive.collab.read_revision(agent, artifact_id, n)  # owner, or a live request on exactly this revision, else refused
        if view["digest"] != expected:
            raise McpError(409, "digest_mismatch", "the revision's digest is not the one you expected; nothing was returned")
        # An exact retained revision stays readable after newer ones exist; nothing here ever substitutes the latest.
        return {"artifact_id": artifact_id, "revision": view["n"], "digest": view["digest"], "body": view["body"], "parent": view["parent"],
                "author": view["author"], "created_at": view["created_at"], "dependency_graph": view["dependency_graph"],
                "assets": []}  # artifact revisions carry no asset linkage today

    _t_hive_revision_read = _t_hive_artifact_read

    async def _t_hive_request(self, agent, args):
        hive = self.hive
        key = args["idempotency_key"]
        # An explicit null and an absent optional field are the same request (Kimi): neither changes the digest.
        payload = _digest_of({k: v for k, v in args.items() if k != "idempotency_key" and v is not None})
        async with self._idem_lock:
            # Route and decide first: a recorded key never answers for a member whose policy now refuses the request
            # (Kimi 2026-10-04: the replay path was self-authorizing).
            target = args["to"]
            if target["kind"] == "swarm":
                if not isinstance(target.get("id"), str) or not target["id"] or set(target) - {"kind", "id"}:
                    raise McpError(400, "bad_request", "to {kind: swarm} needs exactly an id")
                to_swarm = target["id"]
            else:
                if not isinstance(target.get("name"), str) or not target["name"] or set(target) - {"kind", "name"}:
                    raise McpError(400, "bad_request", "to {kind: service} needs exactly a name")
                providers = sorted({o["provider_swarm"] for o in hive.collab.service_catalogue(agent["swarm_id"])["offers"]
                                    if o["service"] == target["name"] and o["provider_swarm"] != agent["swarm_id"]})
                if len(providers) != 1:
                    raise McpError(404 if not providers else 409, "not_offered" if not providers else "service_ambiguous",
                                   f"no swarm offers {target['name']!r} to you" if not providers
                                   else f"several swarms offer {target['name']!r}; name one with to {{kind: swarm}}")
                to_swarm = providers[0]
            self._enforce(agent, "hive-request", args["kind"], to_swarm, args["from_goal"])
            # A retry answers with the identity of the first request (read its state with hive_goal_get), and creates nothing.
            row = hive.db.one("SELECT payload_digest, response FROM mcp_idempotency WHERE agent_id = ? AND tool = 'hive_request' AND idem_key = ?",
                              (agent["id"], key))
            if row is not None:
                if row["payload_digest"] != payload:
                    raise McpError(409, "idempotency_conflict", "that idempotency_key was already used with a different request")
                return json.loads(row["response"])
            made = hive.collab.request_by_idempotency(f"agent:{agent['id']}", key)
            if made is not None:
                if made["idem_digest"] != payload:
                    raise McpError(409, "idempotency_conflict", "that idempotency_key was already used with a different request")
                return {"request_id": made["id"], "goal_id": made["receiving_goal"]}
            constraints = dict(args.get("constraints") or {})
            if "contract" in args:
                if "contract" in constraints and constraints["contract"] != args["contract"]:
                    raise McpError(400, "bad_request", "contract is given twice, differently")
                constraints["contract"] = args["contract"]  # an exact selection, stored with the request; the host gives it no other meaning
            data = {"kind": args["kind"], "to_swarm": to_swarm, "title": args["title"], "from_goal": args["from_goal"],
                    "deadline_minutes": args["deadline_minutes"], "constraints": constraints,
                    "idem_key": key, "idem_digest": payload}
            for field in ("subject", "budget_usd", "detail"):
                if args.get(field) is not None:
                    data[field] = args[field]

            def record(request_row):   # inside the request's own transaction: both records exist, or neither
                hive.db.insert("mcp_idempotency", {"agent_id": agent["id"], "tool": "hive_request", "idem_key": key,
                                                   "payload_digest": payload, "created_at": now(),
                                                   "response": json.dumps({"request_id": request_row["id"], "goal_id": request_row["receiving_goal"]})})
            request = await hive.collab.create_request(agent, data, on_commit_record=record)
            return {"request_id": request["id"], "goal_id": request["receiving_goal"]}

    async def _t_hive_capabilities(self, agent, args):
        """This member's S4 inventory exactly as the native API reports it (current, stale or absent receipt, with the
        policy decision beside each skill), so the transport never invents or hides evidence (OmegaReview B2).
        Bridge tools are listed apart under `mcp_tools`: discovery of what this transport offers, with the live policy
        decision for each, never a claim that anything is loaded or callable."""
        view = self.hive.inventory.view(agent["id"])
        policy, at = self.hive.policy, now()
        tools = []
        for tool, skill in sorted(POLICY.items()):
            names = () if skill is None else ((skill,) if isinstance(skill, str) else skill)
            decisions = {n: dict(zip(("decision", "reason"), policy.decide(agent, n)), snapshot_at=at) for n in names}
            tools.append({"tool": tool, "policy": decisions})
        return {**view, "mcp_tools": tools}

    async def _t_hive_evidence_query(self, agent, args):
        hive = self.hive
        source = self.evidence_source or getattr(hive, "evidence_snapshot", None)
        if source is None:
            raise McpError(501, "evidence_store_absent", "this host holds no OmegaAtom evidence records yet (S1)")
        envelope, projection = _atom()
        try:
            pattern = sexpr.parse(args["pattern"], allow_vars=True)
        except sexpr.SexprError as exc:
            raise McpError(400, "bad_pattern", str(exc)) from None
        hive.policy.enforce(agent, "hive-query", f"(hive-query {args['pattern']})")
        scopes = [{"scope_id": agent["swarm_id"]}] if agent.get("swarm_id") else []
        for tag in args.get("scopes") or []:
            keys = set(tag) if isinstance(tag, dict) else set()
            ok = (len(keys & {"scope_id", "grant_id"}) == 1 and keys <= {"scope_id", "grant_id", "expected_revision"}
                  and all(isinstance(tag.get(k), str) and 0 < len(tag[k]) <= 2000 for k in keys & {"scope_id", "grant_id"})
                  and (type(tag.get("expected_revision", 0)) is int and tag.get("expected_revision", 0) >= 0))
            if not ok:
                raise McpError(400, "bad_request", "a scope is {scope_id} or {grant_id}, optionally with an integer expected_revision")
            if "grant_id" in tag:
                raise McpError(404, "not_found", "no such grant")  # S2 grants do not exist on this host yet
            if tag["scope_id"] != agent.get("swarm_id"):
                raise McpError(403, "forbidden", "that scope is neither yours nor granted to you")
            if any(s["scope_id"] == tag["scope_id"] for s in scopes):
                scopes = [dict(s, **tag) if s["scope_id"] == tag["scope_id"] else s for s in scopes]  # own scope, with its expected_revision
            else:
                scopes.append(tag)
        units, bindings = [], []
        for tag in scopes:
            snapshot = source(tag["scope_id"])
            if snapshot is None:
                continue
            try:
                snapshot = envelope.validate(snapshot)
                if tag.get("expected_revision") is not None and snapshot["revision"] != tag["expected_revision"]:
                    raise McpError(409, "stale_revision", "the scope's revision is not the one you expected; nothing was returned")
                roots = [r["id"] for r in snapshot["records"] if _matches(pattern, r["statement"], {})]
                pages = projection.project_pages(snapshot, roots, record_limit=PAGE_RECORDS)
            except envelope.Refused as exc:
                raise McpError(422, "closure_refused", str(exc)[:300]) from None
            bindings.append([tag["scope_id"], snapshot["revision"], envelope.digest(snapshot)])
            units.extend((tag["scope_id"], page["snapshot"]) for page in pages)
        binding = [_digest_of([args["pattern"], bindings])]
        position = self._cursor_read(args["cursor"], "evidence", agent, binding) if args.get("cursor") else 0
        if not units:
            return {"snapshots": [], "closure_complete": True, "result_complete": True, "next_cursor": None, "end": True}
        if position >= len(units):
            raise McpError(400, "bad_cursor", "that cursor is past the end of the results")
        scope_id, page = units[position]
        last = position == len(units) - 1
        return {"snapshots": [page], "scope_id": scope_id, "closure_complete": True, "result_complete": last,
                "next_cursor": None if last else self._cursor_make("evidence", agent, binding, position + 1, None), "end": last}

    async def _t_hive_repo_query(self, agent, args):
        """The same read engine as GET/POST /api/repo-maps (repomap.py), as this member, read-only; no write view exists."""
        from .repomap import Caller
        maps, view = self.hive.repo_maps, args["view"]
        self._enforce(agent, "repo-query", view, args.get("repo"), args.get("sha"), args.get("preset"))
        who = Caller(f"agent:{agent['id']}", swarm_id=agent.get("swarm_id"), agent=agent)
        need = {"map": ("repo", "sha"), "presets": ("repo",), "nodes": ("repo", "sha"), "node": ("repo", "sha", "node_id"),
                "query": ("repo", "sha", "preset"), "drift": ("repo", "from", "to")}.get(view, ())
        missing = [k for k in need if not args.get(k)]
        if missing:
            raise McpError(400, "bad_request", f"view {view} needs {', '.join(missing)}")
        if view == "maps":
            return {"maps": maps.list(who)}
        if view == "map":
            return maps.header(who, args["repo"], args["sha"])
        if view == "presets":
            return maps.presets(who, args["repo"])
        if view == "nodes":
            return maps.nodes(who, args["repo"], args["sha"], args.get("kind"), args.get("path_prefix"), args.get("q"),
                              args.get("limit"), args.get("cursor"))
        if view == "node":
            return maps.node(who, args["repo"], args["sha"], args["node_id"], args.get("limit"), args.get("cursor"))
        if view == "query":
            query = {k: args[k] for k in ("preset", "params", "limit", "cursor") if args.get(k) is not None}
            return maps.query(who, args["repo"], args["sha"], query)
        return maps.drift(who, args["repo"], args["from"], args["to"], args.get("limit"), args.get("cursor"))
