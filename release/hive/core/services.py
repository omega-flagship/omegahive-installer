"""Registered services (e.g. OmegaCode), their capability tokens, collaborator grants and exact approvals.

Registration: an admin issues a one-time enrolment token (POST /api/services/enrol); the service, from
this machine only, presents it to POST /api/services/register and receives a service token (shown
once, stored hashed) and a capability secret.  The service token can only verify and redeem approvals
and check capabilities; it cannot claim goals, post results, read shares or act as an operator.

Capabilities: the hive issues ``hc1.<payload>.<sig>`` where payload is base64url(canonical JSON claims)
and sig = HMAC-SHA256(capability_secret, payload) hex.  Claims mirror the service's own grants:
``{id, iss: "hive", aud: <service_id>, actor, kind: human|agent, task_id, swarm_id, repository_id,
actions[], paths, argv_prefixes, exp, iat, max_runs, max_runtime_seconds, member_hash, grant_id}``.
The service verifies the signature locally, then GET /api/services/capabilities/{id} for live status
(revoked, expired, grant withdrawn, goal no longer claimed) before every mutation.

Approvals for ``code-*`` skills carry the exact binding parsed from the canonical command
``(code-edit task=… swarm=… workspace=… op=… generation=… digest=sha256:…)``; the service redeems one
approval once, for exactly that binding (POST /api/agent/approvals/{id}/redeem).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time

from .db import new_id, now

ACTIONS = {"workspace", "read", "search", "edit", "run", "cancel", "verify", "events", "artifact", "checkpoint"}
DELEGATED_ACTIONS = {"read", "search", "suggest"}   # r2.13.1: a delegated child reads, searches and files proposals only
# Linkage slice 3 (copy-apply seam §2): "proposal-apply" exists ONLY for a host-issued copy_apply purpose capability; it is
# never in ACTIONS, so ordinary issuance refuses it, and a copy_apply capability carries nothing else.
COPY_APPLY_ACTIONS = {"proposal-apply"}
COPY_APPLY_SECONDS = 300
# Linkage slice 4 (linkage spec r3.6 §b.2): "proposal-test" exists ONLY for a host-issued proposal_test purpose capability
# (hive/core/proposal_tests.py); it is never in ACTIONS or HUMAN_ACTIONS, and such a capability carries nothing else.
PROPOSAL_TEST_ACTIONS = {"proposal-test"}
PROPOSAL_TEST_SECONDS = 900
PROPOSAL_TEST_RUNTIME = 600
# What a person's collaborator grant scope allows (stand-in MISSING-UI B1 r3 #1, 2026-10-07). "read" is exactly the
# read-class set Code itself accepts on a read-only grant (omegacode auth.py: action in read/search/events/artifact);
# "workspace" creates a workspace, so it is not read-class. "edit" allows every ACTIONS entry, as before.
GRANT_SCOPE_ACTIONS = {"read": frozenset({"read", "search", "events", "artifact"}), "edit": frozenset(ACTIONS)}


def scope_allows(scope, actions):
    """True when every action is allowed by a grant of this scope; an unknown scope allows nothing."""
    return set(actions) <= GRANT_SCOPE_ACTIONS.get(scope, frozenset())
CODE_MUTATING = {"code-workspace", "code-edit", "code-run", "code-verify", "code-checkpoint"}
LOOPBACK = re.compile(r"^http://127\.0\.0\.1:(\d{2,5})$")
LOCAL_CODE_ISSUER = "local-owner:omegacode:"
LOCAL_CODE_REGISTRATION = {
    "name": "omegacode", "version": "0.1.0", "address": "http://127.0.0.1:8724",
    "contract": "omegacode/1", "surfaces": ["diff", "log", "editor"],
    "capabilities": ["workspaces", "runs", "changesets", "verifications", "events"],
}
BINDING = re.compile(r"^\((code-[a-z]+) task=(\S+) swarm=(\S+) workspace=(\S+) op=(\S+) generation=(\d+) digest=(sha256:[0-9a-f]{64})\)$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', address TEXT NOT NULL,
  contract TEXT NOT NULL DEFAULT '', surfaces TEXT NOT NULL DEFAULT '[]', capabilities TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL, capability_secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS service_enrolments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at REAL NOT NULL,
  used_at TEXT, service_id TEXT, created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_operations (
  operation_id TEXT PRIMARY KEY, enrolment_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
  service_id TEXT NOT NULL, pending_token TEXT, created_at TEXT NOT NULL, acked_at TEXT
);
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, claims TEXT NOT NULL, issued_by TEXT NOT NULL,
  issued_at REAL NOT NULL, expires_at REAL NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS goal_grants (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, principal TEXT NOT NULL, scope TEXT NOT NULL,
  workspace_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL NOT NULL, revoked_at TEXT
);
"""


def _hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def _local_code_operation(enrolment):
    issuer = enrolment["created_by"] if enrolment is not None else ""
    return issuer.removeprefix(LOCAL_CODE_ISSUER) if issuer.startswith(LOCAL_CODE_ISSUER) else None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def parse_binding(command):
    """(skill, binding) for a canonical mutating code command, else (None, None)."""
    m = BINDING.match(str(command).strip())
    if not m:
        return None, None
    skill, task, swarm, workspace, op, generation, digest = m.groups()
    generation = int(generation)
    return skill, {"task_id": task, "swarm_id": swarm, "workspace_id": None if workspace == "none" else workspace,
                   "operation_id": None if op == "none" else op,
                   "expected_generation": None if generation == 0 else generation, "payload_digest": digest}


class ServiceError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class Services:
    def __init__(self, hive):
        self.hive = hive
        with hive.db._lock:
            hive.db._conn.executescript(SCHEMA)
            columns = {r[1] for r in hive.db._conn.execute("PRAGMA table_info(approvals)")}
            if "binding" not in columns:
                hive.db._conn.execute("ALTER TABLE approvals ADD COLUMN binding TEXT")

    @property
    def db(self):
        return self.hive.db

    # ---- enrolment and registration ----------------------------------------------------------

    def enrol(self, name, by, ttl_minutes=15, *, local_token=None):
        name = str(name or "").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name):
            raise ServiceError(400, "bad_name", "a service name is 2-31 lowercase letters, digits or dashes")
        if local_token is not None:
            if name != LOCAL_CODE_REGISTRATION["name"] or not re.fullmatch(
                    LOCAL_CODE_ISSUER + r"[A-Za-z0-9_-]{16,128}", by) or not re.fullmatch(
                        r"[A-Za-z0-9_-]{43}", local_token):
                raise ServiceError(403, "local_code_enrolment", "invalid local Code enrolment")
        token = local_token if local_token is not None else secrets.token_urlsafe(32)
        row = {"id": new_id("se"), "name": name, "token_hash": _hash(token), "expires_at": time.time() + max(1.0, min(float(ttl_minutes or 15), 24 * 60)) * 60,
               "created_by": by}
        self.db.insert("service_enrolments", row)
        return {"enrolment_id": row["id"], "name": name, "enrol_token": token, "expires_at": row["expires_at"]}

    def register(self, enrol_token, body, client_host, *, local_code=False):
        if client_host not in ("127.0.0.1", "::1"):
            raise ServiceError(403, "local_only", "services register from this machine only")
        row = self.db.one("SELECT * FROM service_enrolments WHERE token_hash = ?", (_hash(enrol_token),))
        operation_id = body.get("operation_id")
        local_operation = _local_code_operation(row)
        if local_code:
            if local_operation is None or body != LOCAL_CODE_REGISTRATION | {"operation_id": local_operation}:
                raise ServiceError(403, "local_code_enrolment", "local Code registration does not match the reserved operation")
        elif local_operation is not None:
            raise ServiceError(403, "local_only", "local Code registration requires the owner control socket")
        if operation_id is not None:
            return self._register_operation(row, operation_id, body)
        with self.db.transaction():
            row = self.db.one("SELECT * FROM service_enrolments WHERE token_hash = ?", (_hash(enrol_token),))
            if row is None or row["used_at"] or row["expires_at"] <= time.time():
                raise ServiceError(403, "enrolment_invalid", "the enrolment token is invalid, used or expired")
            if _local_code_operation(row) is not None:
                raise ServiceError(403, "local_only", "local Code registration requires the owner control socket")
            self._require_code_slot(row, body)
            return self._insert_service(row, body, enabled=1)

    def _require_code_slot(self, enrolment, body):
        # Serialize initial inserts for this address/name against the owner's
        # outstanding automatic enrolment. Ordinary service replay is unaffected.
        name, address = LOCAL_CODE_REGISTRATION["name"], LOCAL_CODE_REGISTRATION["address"]
        if enrolment["name"] != name and body.get("address") != address:
            return
        if _local_code_operation(enrolment) is not None:
            conflict = self.db.one("SELECT id FROM services WHERE name = ? OR address = ?", (name, address))
        else:
            conflict = self.db.one(
                "SELECT e.id FROM service_enrolments e LEFT JOIN service_operations o ON o.enrolment_id = e.id "
                "WHERE e.name = ? AND e.created_by LIKE ? AND e.expires_at > ? "
                "AND (e.used_at IS NULL OR (o.operation_id IS NOT NULL AND o.acked_at IS NULL AND o.pending_token IS NOT NULL))",
                (name, LOCAL_CODE_ISSUER + "%", time.time()))
        if conflict:
            raise ServiceError(409, "local_code_enrolment", "Code registration is reserved by another enrolment")

    def _insert_service(self, row, body, enabled):
        if str(body.get("name", "")) != row["name"]:
            raise ServiceError(403, "enrolment_name", f"this enrolment is for {row['name']!r}")
        address = str(body.get("address", ""))
        m = LOOPBACK.match(address)
        if not m or not (1024 <= int(m.group(1)) <= 65535):
            raise ServiceError(400, "bad_address", "a service address is http://127.0.0.1:<port>")
        surfaces = [s for s in body.get("surfaces") or [] if isinstance(s, str) and re.fullmatch(r"[a-z]{2,20}", s)]
        capabilities = [c for c in body.get("capabilities") or [] if isinstance(c, str) and re.fullmatch(r"[a-z]{2,30}", c)]
        service_id = new_id("svc")
        token, secret = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        registered = now()
        self.db.insert("services", {"id": service_id, "name": row["name"], "version": str(body.get("version", ""))[:40],
                                    "address": address, "contract": str(body.get("contract", ""))[:40],
                                    "surfaces": json.dumps(surfaces), "capabilities": json.dumps(capabilities),
                                    "token_hash": _hash(token), "capability_secret": secret, "enabled": enabled,
                                    "registered_at": registered})
        self.db.execute("UPDATE service_enrolments SET used_at = ?, service_id = ? WHERE id = ?", (now(), service_id, row["id"]))
        return {"service_id": service_id, "service_token": token, "capability_secret": secret, "address": address,
                "registered_at": registered}

    # ---- crash-safe registration (Code enrolment seam R1): one operation, one identity, replayable until ack ----

    @staticmethod
    def _request_digest(body):
        # over the fields as they will be stored (normalised), so a harmless re-encoding is not a conflict
        fields = {"name": str(body.get("name", "")), "version": str(body.get("version", ""))[:40],
                  "address": str(body.get("address", "")), "contract": str(body.get("contract", ""))[:40],
                  "surfaces": [x for x in body.get("surfaces") or [] if isinstance(x, str) and re.fullmatch(r"[a-z]{2,20}", x)],
                  "capabilities": [x for x in body.get("capabilities") or []
                                   if isinstance(x, str) and re.fullmatch(r"[a-z]{2,30}", x)]}
        return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def _operation_receipt(self, op):
        return {"operation_id": op["operation_id"], "request_digest": op["request_digest"],
                "service_id": op["service_id"], "status": "active" if op["acked_at"] else "pending"}

    def _register_operation(self, enrolment, operation_id, body):
        """The same operation, token and request replay the same pending identity and credentials until the service
        acknowledges them; a changed request is a conflict; nothing makes a second identity for one enrolment."""
        if type(operation_id) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", operation_id):
            raise ServiceError(400, "bad_operation", "operation_id is 16-128 URL-safe characters")
        if enrolment is None:
            raise ServiceError(403, "enrolment_invalid", "the enrolment token is invalid, used or expired")
        digest = self._request_digest(body)
        expired = False
        with self.db.transaction():                                    # one atomic step: enrolment, identity, operation
            enrolment = self.db.one("SELECT * FROM service_enrolments WHERE id = ?", (enrolment["id"],))
            op = self.db.one("SELECT * FROM service_operations WHERE operation_id = ?", (operation_id,))
            if op is not None:
                if op["enrolment_id"] != enrolment["id"] or op["request_digest"] != digest:
                    raise ServiceError(409, "operation_conflict", "this operation was made with another request")
                if op["acked_at"] or not op["pending_token"]:
                    raise ServiceError(409, "operation_complete", "this registration is already acknowledged")
                svc = self.db.one("SELECT * FROM services WHERE id = ?", (op["service_id"],))
                if svc is None:
                    raise ServiceError(409, "operation_revoked", "this pending registration was revoked")
                # an unacknowledged registration lives only as long as its enrolment: then it is revoked
                if enrolment["expires_at"] <= time.time():
                    self._revoke_pending(svc["id"], operation_id)
                    expired = True
                else:
                    return {"service_id": svc["id"], "service_token": op["pending_token"],
                            "capability_secret": svc["capability_secret"], "address": svc["address"],
                            "registered_at": svc["registered_at"], "receipt": self._operation_receipt(op)}
            if not expired:
                if enrolment["used_at"] or enrolment["expires_at"] <= time.time():
                    raise ServiceError(403, "enrolment_invalid", "the enrolment token is invalid, used or expired")
                self._require_code_slot(enrolment, body)
                result = self._insert_service(enrolment, body, enabled=0)
                self.db.insert("service_operations", {"operation_id": operation_id, "enrolment_id": enrolment["id"],
                                                      "request_digest": digest, "service_id": result["service_id"],
                                                      "pending_token": result["service_token"], "created_at": now()})
                op = self.db.one("SELECT * FROM service_operations WHERE operation_id = ?", (operation_id,))
                return result | {"receipt": self._operation_receipt(op)}
        # the revocation above is committed before the refusal is reported
        raise ServiceError(409, "operation_expired", "this pending registration expired; enrol again")

    def _pending_service(self, operation_id, token):
        op = self.db.one("SELECT * FROM service_operations WHERE operation_id = ?", (operation_id,))
        svc = self.db.one("SELECT * FROM services WHERE id = ?", (op["service_id"],)) if op else None
        if op is None or svc is None or not token or not hmac.compare_digest(svc["token_hash"], _hash(token)):
            raise ServiceError(404, "not_found", "no such operation for this service")
        return op, svc

    def _revoke_pending(self, service_id, operation_id):
        self.db.execute("DELETE FROM services WHERE id = ?", (service_id,))
        self.db.execute("UPDATE service_operations SET pending_token = NULL WHERE operation_id = ?", (operation_id,))

    def acknowledge(self, operation_id, token, *, local_code=False):
        """The service saved its credentials: the identity becomes live and the held copy of the token is dropped.
        Idempotent. A registration not acknowledged before its enrolment expired is revoked instead."""
        with self.db.transaction():                                    # enable and drop the held token together
            op, svc = self._pending_service(operation_id, token)
            enrolment = self.db.one("SELECT * FROM service_enrolments WHERE id = ?", (op["enrolment_id"],))
            if (_local_code_operation(enrolment) is not None) != local_code:
                raise ServiceError(403, "local_only", "local Code acknowledgement requires the owner control socket")
            if op["acked_at"]:
                return self._operation_receipt(op)
            expired = enrolment is None or enrolment["expires_at"] <= time.time()
            if expired:
                self._revoke_pending(svc["id"], operation_id)
            else:
                self.db.execute("UPDATE services SET enabled = 1 WHERE id = ?", (svc["id"],))
                self.db.execute("UPDATE service_operations SET acked_at = ?, pending_token = NULL WHERE operation_id = ?",
                                (now(), operation_id))
                return self._operation_receipt(self.db.one("SELECT * FROM service_operations WHERE operation_id = ?",
                                                           (operation_id,)))
        # the revocation above is committed before the refusal is reported
        raise ServiceError(409, "operation_expired", "this pending registration expired; enrol again")

    def operation(self, operation_id, token):
        op, _svc = self._pending_service(operation_id, token)
        return self._operation_receipt(op)

    def view(self, row):
        return {"id": row["id"], "name": row["name"], "version": row["version"], "address": row["address"],
                "contract": row["contract"], "surfaces": json.loads(row["surfaces"]),
                "capabilities": json.loads(row["capabilities"]), "enabled": bool(row["enabled"]),
                "registered_at": row["registered_at"], "last_seen_at": row["last_seen_at"]}

    def list(self):
        return [self.view(r) for r in self.db.all("SELECT * FROM services ORDER BY registered_at")]

    def get(self, service_id):
        row = self.db.one("SELECT * FROM services WHERE id = ?", (service_id,))
        if row is None:
            raise ServiceError(404, "not_found", f"no service {service_id}")
        return row

    def by_name(self, name):
        row = self.db.one("SELECT * FROM services WHERE name = ? AND enabled = 1 ORDER BY registered_at DESC LIMIT 1", (name,))
        if row is None:
            raise ServiceError(503, "service_unavailable", f"no {name} service is registered")
        return row

    def set_enabled(self, service_id, enabled):
        self.get(service_id)
        self.db.execute("UPDATE services SET enabled = ? WHERE id = ?", (1 if enabled else 0, service_id))
        return self.view(self.get(service_id))

    def remove(self, service_id):
        self.get(service_id)
        self.db.execute("DELETE FROM services WHERE id = ?", (service_id,))
        self.db.execute("UPDATE capabilities SET revoked_at = ? WHERE service_id = ? AND revoked_at IS NULL", (now(), service_id))
        return {"ok": True}

    def authenticate(self, token):
        """The registered, enabled service behind a service token, else None."""
        if not token:
            return None
        row = self.db.one("SELECT * FROM services WHERE token_hash = ? AND enabled = 1", (_hash(token),))
        if row:
            self.db.execute("UPDATE services SET last_seen_at = ? WHERE id = ?", (now(), row["id"]))
        return row

    # ---- collaborator grants on a goal -------------------------------------------------------

    def grant(self, goal_id, principal, scope="edit", workspace_id=None, ttl_minutes=120, by="user:operator"):
        if not self.db.one("SELECT 1 FROM goals WHERE id = ?", (goal_id,)):
            raise ServiceError(404, "not_found", f"no task {goal_id}")
        if scope not in ("edit", "read"):
            raise ServiceError(400, "bad_scope", "scope is edit or read")
        if not re.fullmatch(r"user:[A-Za-z0-9_]+", str(principal)):
            raise ServiceError(400, "bad_principal", "grants are for people (user:<id>)")
        ttl = max(5.0, min(float(ttl_minutes or 120), 24 * 60))
        row = {"id": new_id("gr"), "goal_id": goal_id, "principal": principal, "scope": scope, "workspace_id": workspace_id,
               "created_by": by, "created_at": now(), "expires_at": time.time() + ttl * 60}
        self.db.insert("goal_grants", row)
        return self.grant_view(row | {"revoked_at": None})

    @staticmethod
    def grant_view(row):
        active = not row["revoked_at"] and row["expires_at"] > time.time()
        return {k: row[k] for k in ("id", "goal_id", "principal", "scope", "workspace_id", "created_by", "created_at",
                                    "expires_at", "revoked_at")} | {"active": active}

    def grants(self, goal_id):
        return [self.grant_view(r) for r in self.db.all("SELECT * FROM goal_grants WHERE goal_id = ? ORDER BY created_at", (goal_id,))]

    def revoke_grant(self, goal_id, grant_id):
        if not self.db.one("SELECT 1 FROM goal_grants WHERE id = ? AND goal_id = ?", (grant_id, goal_id)):
            raise ServiceError(404, "not_found", f"no grant {grant_id}")
        with self.db.transaction():   # the grant, its capabilities and its proposal tests' withdrawal endings together (c.4)
            self.db.execute("UPDATE goal_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now(), grant_id))
            self.db.execute("UPDATE capabilities SET revoked_at = ? WHERE revoked_at IS NULL AND claims LIKE ?", (now(), f'%"grant_id":"{grant_id}"%'))
            tests = getattr(self.hive, "proposal_tests", None)
            if tests is not None:
                tests.grant_revoked(grant_id)
        return self.grant_view(self.db.one("SELECT * FROM goal_grants WHERE id = ?", (grant_id,)))

    # ---- capabilities ------------------------------------------------------------------------

    def issue(self, service_id, *, actor, kind, task_id, swarm_id, repository_id, actions, paths=None, argv_prefixes=None,
              ttl_seconds=900, max_runs=20, max_runtime_seconds=600, member_token=None, grant_id=None, by="user:operator",
              delegated=None, copy_apply=None, proposal_test=None, exp=None, copy_apply_consent=None):
        service = self.get(service_id)
        if not service["enabled"]:
            raise ServiceError(409, "service_disabled", "that service is disabled")
        if paths is not None and (not isinstance(paths, list) or not paths):
            # Absent means the legacy whole-repository scope; an explicit empty list must never mean the same.
            raise ServiceError(400, "bad_paths", "paths, when given, is a non-empty list of relative paths; leave it out for the whole repository")
        if sum(p is not None for p in (delegated, copy_apply, proposal_test)) > 1:
            raise ServiceError(400, "purpose_exclusive", "a capability carries at most one purpose")
        actions = sorted(set(actions or []))
        allowed = COPY_APPLY_ACTIONS if copy_apply is not None else DELEGATED_ACTIONS if delegated is not None \
            else PROPOSAL_TEST_ACTIONS if proposal_test is not None else ACTIONS
        if not actions or not set(actions) <= allowed:
            raise ServiceError(400, "bad_actions", f"actions are a subset of {sorted(allowed)}")
        if copy_apply is not None and (kind != "agent" or not grant_id or int(max_runs) != 0 or int(max_runtime_seconds) != 0
                                       or argv_prefixes or exp is None):
            # host-issued only (hive/core/minds.py issue_copy_apply): never a run grant, always the lease's grant
            raise ServiceError(400, "bad_purpose", "a copy_apply capability is an agent's, on a grant, with no runs and an exact expiry")
        if (copy_apply is None) != (copy_apply_consent is None) or (copy_apply_consent is not None and (
                not isinstance(copy_apply_consent, dict) or set(copy_apply_consent) != {"consent_id", "accepted_at"}
                or not all(isinstance(v, str) and v for v in copy_apply_consent.values()))):
            # copy-apply consent r2: a copy_apply capability always names the person's consent it spent, and nothing else does
            raise ServiceError(400, "bad_purpose", "a copy_apply capability carries the consent it spent, and only it does")
        if proposal_test is not None:
            # host-issued only (hive/core/proposal_tests.py): never an ordinary run grant (max_runs 0: launches go only
            # through holds), the lease's grant for prepare/run and grant_id null for result (b.2), an exact expiry
            result = isinstance(proposal_test, dict) and proposal_test.get("stage") == "result"
            if kind != "agent" or int(max_runs) != 0 or int(max_runtime_seconds) != PROPOSAL_TEST_RUNTIME or exp is None \
                    or not argv_prefixes or (grant_id is not None) == result:
                raise ServiceError(400, "bad_purpose", "a proposal_test capability is an agent's, with no ordinary runs, the "
                                                       "operator's argv, an exact expiry, and a grant except at the result stage")
        if exp is not None and copy_apply is None and proposal_test is None:
            raise ServiceError(400, "bad_purpose", "an exact expiry is for a purpose capability only")
        if kind not in ("human", "agent"):
            raise ServiceError(400, "bad_kind", "kind is human or agent")
        if kind == "agent" and not member_token:
            raise ServiceError(400, "member_required", "an agent capability binds the mind's own token")
        if kind == "human" and not grant_id and actor != "user:operator":
            raise ServiceError(400, "grant_required", "a person's capability on a task needs a collaborator grant")
        if copy_apply is not None:
            # Defence in depth (MISSING-UI B1 r3 #1): a copy_apply capability writes the workspace copy, so its lease grant
            # must still be an edit grant, whatever minds.py already checked.
            grant = self.db.one("SELECT scope FROM goal_grants WHERE id = ?", (grant_id,))
            if grant is None or grant["scope"] != "edit":
                raise ServiceError(403, "grant_scope", "a copy_apply capability needs the issuer's edit grant")
        if kind == "human" and grant_id:
            # Defence in depth: a person's capability never carries more than their grant's scope allows, whoever calls.
            grant = self.db.one("SELECT scope FROM goal_grants WHERE id = ?", (grant_id,))
            if grant is None or not scope_allows(grant["scope"], actions):
                raise ServiceError(403, "grant_scope", f"a {grant['scope'] if grant else 'missing'} grant does not allow {actions}")
        ttl = max(30, min(int(ttl_seconds or 900), 12 * 3600))
        issued = time.time()
        if exp is not None:
            # copy_apply: exp = min(now + 300 s, lease.until), and never at or before now; Code checks 0 < exp - iat <= 300
            issued = float(int(issued))
            exp = int(exp)
            if not issued < exp <= issued + (COPY_APPLY_SECONDS if copy_apply is not None else PROPOSAL_TEST_SECONDS):
                raise ServiceError(403, "lease_required", "the lease ends before this purpose capability could be used")
            ttl = exp - issued
        claims = {"id": new_id("cap"), "iss": "hive", "aud": service_id, "actor": actor, "kind": kind, "task_id": task_id,
                  "swarm_id": swarm_id, "repository_id": repository_id, "actions": actions, "paths": paths or [],
                  "argv_prefixes": argv_prefixes or [], "iat": int(issued), "exp": int(issued + ttl),
                  "max_runs": int(max_runs), "max_runtime_seconds": int(max_runtime_seconds),
                  "member_hash": hashlib.sha256(member_token.encode()).hexdigest() if member_token else None,
                  "grant_id": grant_id}
        if delegated is not None:
            claims["delegated"] = delegated     # host-issued only (hive/core/minds.py); its live status is checked below
        if copy_apply is not None:
            claims["copy_apply"] = copy_apply   # host-issued only (hive/core/minds.py issue_copy_apply); live status below
            # copy-apply consent r2: which consent authorised it, beside (never inside) the closed copy_apply binding
            claims["copy_apply_consent"] = copy_apply_consent
        if proposal_test is not None:
            claims["proposal_test"] = proposal_test   # host-issued only (hive/core/proposal_tests.py); live status below
        self.db.insert("capabilities", {"id": claims["id"], "service_id": service_id, "claims": canonical(claims).decode(),
                                        "issued_by": by, "issued_at": issued, "expires_at": claims["exp"]})
        payload = base64.urlsafe_b64encode(canonical(claims)).decode().rstrip("=")
        signature = hmac.new(service["capability_secret"].encode(), payload.encode(), hashlib.sha256).hexdigest()
        return {"token": f"hc1.{payload}.{signature}", "claims": claims}

    def capability_status(self, service, capability_id):
        row = self.db.one("SELECT * FROM capabilities WHERE id = ? AND service_id = ?", (capability_id, service["id"]))
        if row is None:
            return {"id": capability_id, "active": False, "reason": "unknown"}
        claims = json.loads(row["claims"])
        reason = None
        if row["revoked_at"]:
            reason = "revoked"
        elif row["expires_at"] <= time.time():
            reason = "expired"
        elif claims.get("grant_id"):
            grant = self.db.one("SELECT * FROM goal_grants WHERE id = ?", (claims["grant_id"],))
            if grant is None or grant["revoked_at"] or grant["expires_at"] <= time.time():
                reason = "grant_withdrawn"
        # linkage r3.6 c.2: the task_closed check is skipped only for a stored result-stage proposal_test claim (keyed on
        # the verified claims row, never on anything the caller sends); result claims carry grant_id null, so the grant
        # check above never applies to them either. Every other capability keeps both checks exactly as before.
        result_stage = isinstance(claims.get("proposal_test"), dict) and claims["proposal_test"].get("stage") == "result"
        if reason is None and claims.get("task_id") and not result_stage:
            goal = self.db.one("SELECT status FROM goals WHERE id = ?", (claims["task_id"],))
            if goal is None or goal["status"] in ("cancelled", "failed", "done"):
                reason = "task_closed"
        if reason is None and not result_stage and service.get("name") == LOCAL_CODE_REGISTRATION["name"]:
            available = getattr(getattr(self.hive, "code", None), "local_enrolment_available", None)
            if available is not None and not available():
                reason = "code_enrolment_unavailable"
        if reason is None and "delegated" in claims:
            reason = self.hive.minds.delegated_reason(claims)   # r2.13.1: child, request, lease, origin grant, origin task
        out = {"id": capability_id, "active": reason is None, "reason": reason, "claims": claims}
        if "copy_apply" in claims:
            # copy-apply seam §2: generic reasons first, then not_controller, request_closed, lease_expired, origin_grant_read_only
            purpose, status = self.hive.minds.copy_apply_reason(claims)
            if reason is None:
                reason = purpose
            out.update(active=reason is None, reason=reason, copy_apply_status=status)
        if "proposal_test" in claims:
            # linkage r3.6 c.1/c.2: generic reasons first, then the proposal-test reasons; plus stage, lease, test, origin
            purpose, status = self.hive.proposal_tests.reason(claims)
            if reason is None:
                reason = purpose
            out.update(status, active=reason is None, reason=reason)
        return out

    def revoke_capability(self, capability_id):
        if not self.db.one("SELECT 1 FROM capabilities WHERE id = ?", (capability_id,)):
            raise ServiceError(404, "not_found", f"no capability {capability_id}")
        self.db.execute("UPDATE capabilities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now(), capability_id))
        return {"id": capability_id, "revoked": True}

    # ---- exact approvals ---------------------------------------------------------------------

    def approval_view(self, row):
        return {k: row[k] for k in ("id", "agent_id", "skill", "command", "status", "decided_by", "created_at", "decided_at")} | {
            "binding": json.loads(row["binding"]) if row.get("binding") else None, "redeemed_at": row.get("redeemed_at")}

    def redeem(self, approval_id, binding):
        row = self.db.one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        if row is None:
            raise ServiceError(404, "not_found", f"no approval {approval_id}")
        if row["skill"] not in CODE_MUTATING or not row.get("binding"):
            raise ServiceError(409, "not_redeemable", "only exact code approvals are redeemed here")
        if row["status"] != "approved" or row.get("redeemed_at"):
            raise ServiceError(409, "approval_redeemed" if row.get("redeemed_at") else "not_approved",
                               f"approval is {row['status']}{' and already redeemed' if row.get('redeemed_at') else ''}")
        if canonical(json.loads(row["binding"])) != canonical(binding or {}):
            raise ServiceError(409, "binding_mismatch", "the binding differs from what was approved")
        with self.hive._mind_lock(row["agent_id"]):
            self.hive.person_swarms.require_current(row["agent_id"])
            if self.hive.policy._ceiling(row["agent_id"], row["skill"]) == "deny":
                raise ServiceError(403, "policy_refused", "the app template no longer allows this approval")
            cur = self.db.execute("UPDATE approvals SET status = 'used', redeemed_at = ? WHERE id = ? AND status = 'approved' AND redeemed_at IS NULL",
                                  (now(), approval_id))
        if cur.rowcount != 1:
            raise ServiceError(409, "approval_redeemed", "approval was redeemed concurrently")
        updated = self.db.one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        self.hive.events.publish("approval.updated", approval={k: v for k, v in updated.items() if k != "binding"})
        return self.approval_view(updated)
