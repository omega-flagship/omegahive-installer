"""Host-owned foundation records. Provisioning never starts a mind or calls a provider.

The existing person_minds binding, ordinary swarm/mind creation, request offers,
policy rules and Minds.templates remain the only stores. Review proposal delivery
is deliberately not claimed by installing its asleep reviewer and offer.
"""
from __future__ import annotations

import fnmatch
import json
import re
import socket
import logging
import secrets
import threading
import time

from .db import now
from . import model_route

log = logging.getLogger("hive")
CODE = "foundation_create_code"
REVIEW = "foundation_review"
CHILD_TEMPLATE = "foundation.code-helper.v1"
FLOW_TEMPLATE = "foundation.flow.v1"
RULE_ORIGIN = "hive:foundation:code:v1"
OFFER_ORIGIN = "host:foundation:offers:v1"
WRITE_SKILLS = ("code-mind-spawn", "code-mind-prompt", "code-mind-control", "code-mind-retry")
READ_SKILLS = ("code-mind-templates", "code-mind-status", "code-mind-scan", "code-mind-request", "code-mind-work")
NATIVE_SKILLS = WRITE_SKILLS + READ_SKILLS
REVIEW_MANDATE = {"id": "code-proposal-second-opinion", "version": "1"}
# A request helper works only on the delegated proposal path. Its direct-workspace open, exec, edit, git,
# merge and test heads are refused at its own agent scope, so the gate denies them and the prompt's SKILLS
# line hides them. NOT denied: the names OmegaCode itself authorizes each proposal-path operation under,
# as the helper (omegacode auth.py SKILLS: code-workspace, code-read, code-search, code-edit, code-run,
# code-cancel, code-verify, code-events, code-artifact, code-checkpoint). Denying those refused the
# helper's own code-proposal-context with policy_refused (live attempt 14). Without code-open a stray
# code-read has no workspace to read. Allowed and untouched: code-proposal-*, code-propose, hive goals.
OMEGACODE_AUTHORIZE_SKILLS = ("code-workspace", "code-read", "code-search", "code-edit", "code-run", "code-cancel",
                              "code-verify", "code-events", "code-artifact", "code-checkpoint")
HELPER_DENIED = ("code-open", "code-replace", "code-exec", "code-create", "code-move", "code-remove", "code-git*",
                 "code-status", "code-changes", "code-check", "code-runs", "code-verifications", "code-output",
                 "code-diagnostics", "code-review", "code-hunk*", "code-select", "code-merge-*", "code-retrieve",
                 "code-proof-*", "code-tools", "code-repos", "code-diff", "code-test-*")
HELPER_NOTE = "Foundation request helper: proposal path only"
HELPER_ORIGIN = "hive:foundation:code-helper:v1"   # the seeded per-agent rules before the helper role; migrated away
HELPER_ROLE = "Foundation request helper"
HELPER_ROLE_PURPOSE = "foundation_code_helper"
HELPER_INSTRUCTION_SKILL = "code-helper-instruction"
HELPER_GUIDANCE = ("You work on a request: read its instruction with code-helper-instruction, read with "
                   "code-proposal-context ws_id and code-proposal-read ws_id path, change only by code-propose, finish "
                   "with hive-goal-propose on your work goal. Never code-open.")
# The helper role's rules: the proposal path only (HELPER_DENIED refused), and its own request's instruction readable.
HELPER_ROLE_RULES = [{"skill": s, "mode": "deny"} for s in HELPER_DENIED] + [{"skill": HELPER_INSTRUCTION_SKILL,
                                                                               "mode": "allow"}]


def foundation_budget_ids(db):
    """Read existing host-purpose identities, never a model or admission decision.

    These records do not participate in automatic equal-share derivation. Stored
    limits, usage and reservations remain the budget consumer's responsibility.
    """
    if db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'") is None:
        return frozenset(), frozenset()
    rows = db.all("SELECT swarm_id, agent_id FROM person_minds WHERE purpose IN (?, ?)", (CODE, REVIEW))
    return (frozenset(row["swarm_id"] for row in rows
                      if isinstance(row["swarm_id"], str) and row["swarm_id"]),
            frozenset(row["agent_id"] for row in rows
                      if isinstance(row["agent_id"], str) and row["agent_id"]))


class HiveFoundation:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self._lock = threading.RLock()
        self._fault = lambda stage: None  # Source controls only, never exposed to callers
        # The existing host-purpose binding table, also used by StudioMakers.
        self.db.execute("""CREATE TABLE IF NOT EXISTS person_minds (
          principal TEXT NOT NULL, purpose TEXT NOT NULL, agent_id TEXT, swarm_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (principal, purpose))""")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS person_minds_foundation_purpose "
                        "ON person_minds(purpose) WHERE purpose IN "
                        "('foundation_create_code','foundation_review')")
        # Host provenance for a role the foundation created (a role's name is never provenance): purpose -> role id.
        self.db.execute("""CREATE TABLE IF NOT EXISTS foundation_roles (
          purpose TEXT PRIMARY KEY, role_id TEXT NOT NULL, created_at TEXT NOT NULL)""")

    def _error(self, message):
        return self.hive.error(409, "foundation_unavailable", message)

    def _binding(self, purpose):
        return self.db.one("SELECT * FROM person_minds WHERE purpose = ?", (purpose,))

    def _owner_read(self):
        # The read-only projection of the existing owner authority; unlike
        # OwnHive.owner/ensure_owner this never publishes first-admin adoption.
        row = self.hive.ownhive._row()
        if row and row["owner"] != "user:operator":
            return row["owner"]
        first = self.hive.ownhive._first_admin()
        return "user:" + first["id"] if first else "user:operator"

    def _busy(self, team_id):
        return bool(self.db.one("SELECT 1 FROM mind_leases WHERE team_id = ? AND ended_at IS NULL "
                                "AND until > ? LIMIT 1", (team_id, now())) or
                    self.db.one("SELECT 1 FROM requests r JOIN goals g ON g.id = r.receiving_goal "
                                "WHERE r.to_swarm = ? AND r.cancelled_at IS NULL "
                                "AND g.status NOT IN ('done','failed','cancelled') LIMIT 1", (team_id,)))

    def _blocked_rule(self, agent_id, team_id, skill):
        """Do not recreate a host allow over an active person's ask/deny."""
        scopes = {"hive", "swarm:" + team_id, "agent:" + agent_id}
        for row in self.db.all("SELECT * FROM policy_rules"):
            if (row["scope"] in scopes and row["mode"] in ("ask", "deny")
                    and fnmatch.fnmatchcase(skill, row["skill"])
                    and (not row.get("expires_at") or row["expires_at"] > time.time())):
                return True
        return False

    def _expire_old_allows(self, current_agent):
        # Only this module's own stale native grants, never a person's rule.
        changed = False
        stamp = time.time()
        for row in self.db.all("SELECT * FROM policy_rules WHERE origin = ?", (RULE_ORIGIN,)):
            if (row["scope"] != "agent:" + current_agent and row["skill"] in NATIVE_SKILLS
                    and row["mode"] == "allow"
                    and (not row.get("expires_at") or row["expires_at"] > stamp)):
                self.db.execute("UPDATE policy_rules SET expires_at = ? WHERE id = ?",
                                (stamp, row["id"]))
                changed = True
        return changed

    def _rules(self, agent, team, owner):
        changed = self._expire_old_allows(agent["id"])
        for skill in NATIVE_SKILLS:
            if self._blocked_rule(agent["id"], team["id"], skill):
                # The host's older agent allow must not outrank a later person's
                # broader hive/swarm refusal under the ordinary policy ranking.
                for row in self.db.all("SELECT * FROM policy_rules WHERE origin = ? AND scope = ? "
                                       "AND skill = ? AND mode = 'allow'",
                                       (RULE_ORIGIN, "agent:" + agent["id"], skill)):
                    if not row.get("expires_at") or row["expires_at"] > time.time():
                        self.db.execute("UPDATE policy_rules SET expires_at = ? WHERE id = ?",
                                        (time.time(), row["id"]))
                        changed = True
                continue
            rows = self.db.all("SELECT * FROM policy_rules WHERE scope = ? AND skill = ? "
                               "AND mode = 'allow'", ("agent:" + agent["id"], skill))
            if any(not row.get("expires_at") or row["expires_at"] > time.time() for row in rows):
                continue
            self.hive.policy.add_rule("agent:" + agent["id"], skill, "allow",
                                      note="Host foundation controller only", origin=RULE_ORIGIN,
                                      publish=False, granted_by=owner)
            changed = True
        return changed

    @staticmethod
    def _is_helper(template):
        return isinstance(template, dict) and template.get("_foundation") == CHILD_TEMPLATE

    def child_persona(self, template):
        """The request helper's standing guidance; None for every other template."""
        return HELPER_GUIDANCE if self._is_helper(template) else None

    def helper_role(self):
        """The request helper's role, created once by the foundation with host provenance (foundation_roles), as
        _review_role does for the reviewer: proposal-path-only rules plus its own instruction read. Spawn assigns it
        through the template's role_id, and Roles.apply puts its rules at the child's scope (note role:<name>). A person
        may edit the role like any other; the host never re-creates a role by name."""
        row = self.db.one("SELECT role_id FROM foundation_roles WHERE purpose = ?", (HELPER_ROLE_PURPOSE,))
        if row is not None:
            role = self.db.one("SELECT * FROM roles WHERE id = ?", (row["role_id"],))
            if role is None:
                raise self._error("The foundation helper role was removed; a person restores it or clears its binding.")
            return role
        if self.db.one("SELECT 1 FROM roles WHERE name = ?", (HELPER_ROLE,)):
            raise self._error("The foundation helper role name is already in use.")
        with self.db.transaction():
            role = self.hive.roles.create({
                "name": HELPER_ROLE, "summary": "Code request helper: proposal path only",
                "prompt": HELPER_GUIDANCE, "rules": HELPER_ROLE_RULES, "mandate": None, "media": []})
            self.db.execute("INSERT INTO foundation_roles (purpose, role_id, created_at) VALUES (?, ?, ?)",
                            (HELPER_ROLE_PURPOSE, role["id"], now()))
        return self.db.one("SELECT * FROM roles WHERE id = ?", (role["id"],))

    def helper_role_problem(self):
        """Read-only: plain words when the helper role this hive bound is missing, else None (never creates)."""
        row = self.db.one("SELECT role_id FROM foundation_roles WHERE purpose = ?", (HELPER_ROLE_PURPOSE,))
        if row is None:
            return "The request helper role has not been created yet; helpers would start without their restrictions."
        if self.db.one("SELECT 1 FROM roles WHERE id = ?", (row["role_id"],)) is None:
            return ("The request helper role was removed, so a helper would have no proposal-path restrictions; "
                    "restore the role or clear its binding.")
        return None

    def migrate_helpers(self):
        """Helpers spawned before the role carry seeded agent-scope denials (origin HELPER_ORIGIN): give each its role
        and remove the seeded rules; the role's rules replace them in the same step. Idempotent."""
        role = self.helper_role()
        agents = sorted({r["scope"][len("agent:"):] for r in self.db.all(
            "SELECT scope FROM policy_rules WHERE origin = ? AND scope LIKE 'agent:%'", (HELPER_ORIGIN,))})
        moved = []
        for agent_id in agents:
            with self.hive.roles.lock, self.db.transaction():
                assigned = self.db.execute("UPDATE agents SET role_id = ? WHERE id = ? AND role_id IS NULL",
                                           (role["id"], agent_id)).rowcount
                holds = self.db.one("SELECT 1 FROM agents WHERE id = ? AND role_id = ?", (agent_id, role["id"]))
                if not (assigned == 1 or holds):
                    # it already holds another role: its seeded denials stay, so it is never left unrestricted
                    continue
                self.hive.roles._apply_rules(agent_id, None)
                self.db.execute("DELETE FROM policy_rules WHERE origin = ? AND scope = ?", (HELPER_ORIGIN, "agent:" + agent_id))
            moved.append(agent_id)
        if moved:
            self.hive.events.publish("policy.updated", **self.hive.policy.rule_views())
        return moved

    def _review_role(self):
        role = self.db.one("SELECT * FROM roles WHERE name = ?", ("Foundation proposal reviewer",))
        if role is not None:
            # A name alone is not provenance for taking an existing role.
            raise self._error("The foundation reviewer role name is already in use.")
        return self.hive.roles.create({
            "name": "Foundation proposal reviewer", "summary": "Bounded Code proposal second opinion",
            "prompt": "Review only the proposal and evidence explicitly supplied in an authorized request. "
                      "Do not fetch private source, edit, test, copy or confirm on a person's behalf. "
                      "Say what is unverified; never review your own work.",
            "rules": [], "mandate": None, "media": []})

    def _need(self, purpose):
        return "foundation-code:proposal" if purpose == CODE else "foundation-review:second-opinion"

    def _choice(self, agent, need, selected=None):
        # The canonical router uses the gateway's actual paying key/payer/limits.
        # No model is called by this read-only decision.
        return model_route.choose(need, getattr(self.hive, "keyring", None), self.hive.ownhive,
            pins="check", selected=selected,
            settle=lambda model: self.hive.budgets.settlement(
                agent, model, user=self.hive.user_for(agent), turn_bound=False))

    def _initial_model(self, row, purpose):
        need = self._need(purpose)
        explicit = model_route.configured(need)
        if explicit:
            return explicit, False  # a pin is retained even while unavailable
        fallback, operator = model_route.fallback()
        if operator:
            return fallback, False  # an explicit demonstration choice is not picked up
        choice = self._choice(row, need)
        return choice.get("route") or model_route.DEMO_DEFAULT, True

    def _checked_binding(self, purpose, binding, owner):
        """Raw custody; owner/coordinator writes hold original membership + DB transaction.

        Hive.swarm_view intentionally masks a coordinator outside the member set.
        That presentation is not authority to clear or replace the stored choice.
        """
        if self._binding(purpose) != binding or self._owner_read() != owner:
            raise self._error("The current foundation binding or owner changed.")
        team = self.db.one("SELECT * FROM swarms WHERE id=?", (binding["swarm_id"],))
        if not team or team.get("archived_at"):
            raise self._error("A foundation swarm is missing or archived; its history is retained.")
        if team.get("owner") != binding["principal"]:
            raise self._error("A person's different foundation swarm owner is not replaced.")
        agent = self.db.one("SELECT * FROM agents WHERE id=?", (binding["agent_id"],)) if binding["agent_id"] else None
        if binding["agent_id"] and not agent:
            raise self._error("A bound controller row is missing; no replacement or lease transfer is inferred.")
        if agent and agent["deleted"]:
            raise self._error("A deleted foundation controller is not recreated over a person's stop.")
        if agent and (agent["swarm_id"] != team["id"] or agent.get("owner") != binding["principal"]
                      or agent["kind"] != "omega" or agent["driver"] != "local"):
            raise self._error("A foundation controller binding has drifted; no foreign mind is adopted.")
        if team.get("coordinator_id") not in (None,binding["agent_id"]):
            raise self._error("A person's different coordinator is not replaced.")
        return team,agent

    def _finish_bound(self, binding):
        """Retry original preparation on the SAME published identity; no duplicate mind.

        The row/binding are durable first. A crash before or during workspace
        preparation leaves created/stopped, never startable. The existing stopped
        token CAS makes a later retry's token the only current credential.
        """
        hive = self.hive
        aid, team_id = binding["agent_id"], binding["swarm_id"]
        with hive._mind_lock(aid), hive.swarm_membership(team_id):
            with self.db.transaction():
                _, row = self._checked_binding(binding["purpose"],binding,binding["principal"])
            row = self.db.one("SELECT * FROM agents WHERE id=? AND deleted=0", (aid,))
            if (not row or row["status"] != "created" or row["desired"] != "stopped"
                    or row["driver"] != "local" or self._binding(binding["purpose"]) != binding):
                raise self._error("Only the original unfinished foundation controller may be prepared.")
            if self._busy(team_id):
                raise self._error("An unfinished controller has an original live request or lease.")
            token = secrets.token_urlsafe(32)
            role = hive.roles.get(row["role_id"]) if row.get("role_id") else None
            hive.finish_agent(row, token, role, by=binding["principal"])
            hive.rotate_token(aid, row.get("token_epoch", 0), token)
            self._fault("controller-prepared")
            with self.db.transaction():
                _, fresh = self._checked_binding(binding["purpose"],binding,binding["principal"])
                if (fresh["status"] != "created"
                        or fresh["desired"] != "stopped" or fresh["deleted"]):
                    raise self._error("The original unfinished controller changed before completion.")
                self.db.execute("UPDATE agents SET status='asleep',desired='asleep' WHERE id=?", (aid,))
                self.db.after_commit(lambda aid=aid: hive.emit_agent(aid))

    def _ensure_team(self, purpose, name, owner, budget):
        hive = self.hive
        binding = self._binding(purpose)
        if binding is None:
            # One durable boundary: team and existing-purpose binding publish
            # together. A retry never adopts a team by its display name.
            with self.db.transaction():
                if self._owner_read() != owner:
                    raise self._error("The foundation owner changed before initial swarm publication.")
                if self._binding(purpose) is None:
                    team = hive.create_swarm(name, "Host foundation; no work runs at startup.",
                                              owner=owner, visibility="public", _defer_events=True)
                    self._fault("before-team-publication")
                    stamp = now()
                    self.db.execute("INSERT INTO person_minds "
                        "(principal,purpose,agent_id,swarm_id,created_at,updated_at) VALUES (?,?,NULL,?,?,?)",
                        (owner,purpose,team["id"],stamp,stamp))
            self._fault("team-bound")
            binding = self._binding(purpose)
        # Fine-grained check before adoption; never hold DB across preparation.
        with hive.swarm_membership(binding["swarm_id"]), self.db.transaction():
            team,agent = self._checked_binding(purpose,binding,owner)
            if binding["principal"] != owner:
                if self._busy(team["id"]):
                    raise self._error("Foundation ownership waits for the original request and lease to close.")
                self.db.execute("UPDATE swarms SET owner=? WHERE id=?", (owner,team["id"]))
                if agent:
                    self.db.execute("UPDATE agents SET owner=? WHERE id=?", (owner,agent["id"]))
                self.db.execute("UPDATE person_minds SET principal=?,updated_at=? WHERE purpose=?", (owner,now(),purpose))
                binding = self._binding(purpose)
                team,agent = self._checked_binding(purpose,binding,owner)
                self.db.after_commit(lambda sid=team["id"]:
                    hive.events.publish("swarm.updated",swarm=hive.swarm(sid)))
                if agent:
                    self.db.after_commit(lambda aid=agent["id"]: hive.emit_agent(aid))
        if agent is None:
            # Existing producer decomposition, as used by Minds.spawn: ordinary
            # validation and original insert. Role, mind, coordinator and binding
            # commit together before finish_agent touches its workspace.
            with hive.roles.lock, hive.swarm_membership(team["id"]), self.db.transaction():
                team,current_agent = self._checked_binding(purpose,binding,owner)
                if current_agent is not None or self._busy(team["id"]):
                    raise self._error("The original foundation creation binding changed.")
                role = self._review_role() if purpose == REVIEW else None
                persona = ("Coordinate only the original person-bound request and supplied evidence. "
                           "Preserve its grant, scope, lease, budget and retained operation keys. "
                           "Never retry UNKNOWN, self-review, or increase limits.")
                row, _, cleaned_role = hive.new_agent_row(name+" controller", "omega", team["id"],
                    model_route.DEMO_DEFAULT, persona, budget_usd=budget,
                    role_id=role["id"] if role else None, owner=owner, visibility="private", by=owner)
                model, host_set = self._initial_model(row, purpose)
                row.update(model=model, driver="local")
                hive.insert_into_open_swarm("agents", row, team["id"])
                if host_set:
                    model_route.record(self.db,row["id"],model,self._need(purpose))
                self._fault("before-controller-publication")
                self.db.execute("UPDATE person_minds SET agent_id=?,updated_at=? WHERE purpose=?",
                                (row["id"],now(),purpose))
                self.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?", (row["id"],team["id"]))
            self._fault("controller-bound")
            binding = self._binding(purpose)
            agent = self.db.one("SELECT * FROM agents WHERE id=?", (binding["agent_id"],))
        if agent["status"] == "created" and agent["desired"] == "stopped":
            self._finish_bound(binding)
        agent = self.db.one("SELECT * FROM agents WHERE id=? AND deleted=0", (binding["agent_id"],))
        if (not agent or agent["swarm_id"] != team["id"] or agent.get("owner") != owner
                or agent["kind"] != "omega" or agent["driver"] != "local"):
            raise self._error("A foundation controller binding has drifted; no foreign mind is adopted.")
        with hive.swarm_membership(team["id"]), self.db.transaction():
            current,agent = self._checked_binding(purpose,binding,owner)
            if current.get("coordinator_id") is None:
                if self._busy(team["id"]):
                    raise self._error("An active original request cannot acquire a repaired coordinator.")
                hive.update_swarm(team["id"], {"coordinator_id":agent["id"]}, _defer_events=True)
        return self._binding(purpose), self.db.one("SELECT * FROM swarms WHERE id=?", (team["id"],)), agent

    def _refresh_model(self, purpose):
        """Move only a host-recorded placeholder/unpayable model, never an explicit choice.

        Mind lock before DB lock matches the original update path. Active requests
        and leases keep the original model; admission then reports unavailable.
        """
        b = self._binding(purpose)
        if not b or not b["agent_id"]:
            return
        hive = self.hive
        with hive._mind_lock(b["agent_id"]):
            row = self.db.one("SELECT * FROM agents WHERE id=? AND deleted=0", (b["agent_id"],))
            if (not row or row["desired"] in ("stopped","paused") or row["status"] in ("stopped","paused","error")
                    or b != self._binding(purpose) or self._busy(b["swarm_id"])
                    or model_route.held(self.db,row["id"]) != row["model"]):
                return
            need = self._need(purpose)
            if self._choice(row,need,selected=row["model"]).get("route"):
                return
            choice = self._choice(row,need)
            model = choice.get("route")
            if not model or model_route.is_demo(model):
                return
            with self.db.transaction():
                if self._busy(b["swarm_id"]) or b != self._binding(purpose):
                    return
                hive._update_agent_locked(row["id"], {"model":model}, by=model_route.HOST_ACTOR)
                if choice.get("policy") == "operator-pin":
                    model_route.forget(self.db,row["id"])
                else:
                    model_route.record(self.db,row["id"],model,need)

    def _template(self, tid, team_id, controller):
        """Called while holding db.transaction, the same lock as atomic spawn."""
        model = controller["model"]
        prior = self.hive.minds.templates.get(tid)
        if prior is not None and prior.get("_foundation") != tid:
            raise self._error("An operator template already uses a foundation template id.")
        cap = min(float(prior["max_allocation_usd"]), 0.25) if prior else 0.25
        role = self.helper_role()["id"] if tid == CHILD_TEMPLATE else None   # the helper's restrictions travel as its role
        entry = self.hive.minds._template({
            "template_id": tid, "harness": "native", "model_id": (prior["model_id"] if prior and prior["model_id"] != prior.get("_foundation_model") else model),
            "role_id": role, "max_allocation_usd": cap, "controls": ["stop", "retire"],
            "lifecycle_modes": ["deliver", "bounded"]}, swarm_ids=[team_id])
        entry["_foundation"] = tid
        entry["_foundation_model"] = (prior.get("_foundation_model") if prior and prior["model_id"] != prior.get("_foundation_model") else model)
        if prior != entry:
            self.hive.minds.templates[tid] = entry

    def _code_available(self):
        code = getattr(self.hive,"code",None)
        if code is None:
            return False  # foundation startup precedes the later Code assignment
        try:
            self.hive.services.by_name("omegacode")
            code.require_intended_release()
            return True
        except Exception as error:
            if getattr(error, "code", None) in ("service_unavailable", "code_disabled", "service_release_mismatch",
                                                "intended_release_required", "not_available"):
                return False
            raise

    def _code_reachable(self, service):
        """Bounded anonymous protocol observation, never authority or loaded-source proof.

        Use only outside the DB transaction. Admission still uses the original
        pure configured-release guard; this observation only gates advertising.
        """
        if self.db._conn.in_transaction:
            raise self._error("Code availability observation must precede atomic admission.")
        address = service.get("address")
        match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{2,5})", address) if isinstance(address,str) else None
        if not match or not 1024 <= int(match[1]) <= 65535:
            return False
        port = int(match[1])
        deadline = time.monotonic() + 1.0
        def remaining():
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("Code availability observation expired")
            return left
        try:
            # Numeric AF_INET endpoint: no resolver, environment proxy, redirect,
            # credential, registration, capability, project or provider request.
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
                connection.settimeout(remaining())
                connection.connect(("127.0.0.1",port))
                connection.settimeout(remaining())
                connection.sendall(("GET /v1/capabilities HTTP/1.1\r\nHost: 127.0.0.1:" + str(port)
                                    + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n").encode("ascii"))
                received = bytearray()
                while b"\r\n\r\n" not in received:
                    if len(received) >= 4096:
                        return False
                    connection.settimeout(remaining())
                    part = connection.recv(min(1024,4096-len(received)))
                    if not part:
                        return False
                    received.extend(part)
                head,body = bytes(received).split(b"\r\n\r\n",1)
                lines = head.decode("ascii").split("\r\n")
                if not re.fullmatch(r"HTTP/1\.[01] 401(?: [\x20-\x7e]*)?",lines[0]) or len(lines) > 33:
                    return False
                headers = {}
                for line in lines[1:]:
                    if len(line) > 1024 or ":" not in line:
                        return False
                    key,value = line.split(":",1)
                    key = key.lower()
                    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9a-z-]+",key) or key in headers:
                        return False
                    headers[key] = value.strip()
                length = headers.get("content-length","")
                if ("transfer-encoding" in headers or not re.fullmatch(r"[0-9]{1,4}",length)
                        or int(length) > 4096
                        or headers.get("content-type","").split(";",1)[0].strip().lower() != "application/json"):
                    return False
                length = int(length)
                while len(body) <= length:
                    connection.settimeout(remaining())
                    part = connection.recv(min(1024,length+1-len(body)))
                    if not part:
                        break
                    body += part
                if len(body) != length:
                    return False
                def unique(pairs):
                    result = {}
                    for key,value in pairs:
                        if key in result:
                            raise ValueError("duplicate Code availability field")
                        result[key] = value
                    return result
                answer = json.loads(body.decode("utf-8"),object_pairs_hook=unique)
                remaining()
                return answer == {"error":"authentication_required","message":"a scoped bearer capability is required"}
        except (OSError, ValueError, UnicodeError, RecursionError):
            return False

    def _code_offer_observation(self, controller):
        # No network observation or model selection is performed under DB lock.
        if not self._code_available():
            return False
        if not self._choice(controller,self._need(CODE),selected=controller["model"]).get("route"):
            return False
        try:
            service = self.hive.services.by_name("omegacode")
            identity = (service.get("id"),service.get("address"))
            if not identity[0] or not self._code_reachable(service):
                return False
            fresh = self.hive.services.by_name("omegacode")
            return identity if ((fresh.get("id"),fresh.get("address")) == identity and self._code_available()) else None
        except Exception as error:
            if getattr(error,"code",None) == "service_unavailable":
                return False
            raise

    def _offer_current(self, binding, previous, observation):
        """Fresh read-only funding check inside the original publication transaction.

        The local observation names only the enabled registration observed at
        the outside-DB socket boundary. It grants nothing and is not cached.
        """
        _,current = self._checked_binding(CODE,binding,binding["principal"])
        if not observation or not current or not previous or current["model"] != previous["model"]:
            return False
        if not self._code_available():
            return False
        try:
            service = self.hive.services.by_name("omegacode")
        except Exception as error:
            if getattr(error,"code",None) == "service_unavailable":
                return False
            raise
        if (service.get("id"),service.get("address")) != observation:
            return False
        # Re-read key/payer/options/budget facts for the CURRENT stored row.
        # This canonical choice performs no model call or socket observation.
        return bool(self._choice(current,self._need(CODE),selected=current["model"]).get("route"))

    def _sync_offer(self, team_id, kind, available):
        """Manage only new host-origin rows; a person's preferences are authoritative.

        No legacy migration exists: Foundation has not been deployed. Review has
        no automatic offer until authorized proposal-context delivery qualifies.
        """
        row = self.db.one("SELECT * FROM swarm_services WHERE swarm_id = ?", (team_id,))
        kinds = self.hive.collab.services(team_id)
        private = self.hive.collab.connection_services(team_id)
        if row is not None and row["set_by"] != OFFER_ORIGIN:
            if kind == "review" and kind in kinds + private:
                raise self._error("A person's Review offer conflicts with held proposal delivery; its owner must resolve it.")
            return kind in kinds  # never rewrite, withdraw or publicize a person's row
        desired = sorted((set(kinds)-{kind}) | ({kind} if available and kind not in private else set()))
        if desired != kinds:
            self.hive.collab.set_services(team_id,desired,OFFER_ORIGIN,connection_only_kinds=private)
        return kind in desired

    @staticmethod
    def _code_description(available):
        return ("Code service available; original person/request/lease admission is still required." if available
                else "Code is unavailable: a matching reachable service and a real supported funded route are required.")

    def ensure(self, principal=None):
        """One host step; existing lower caps, spends, stops and refusals are untouched."""
        with self._lock:
            owner = self.hive.ownhive.owner()  # existing user:operator, then actual first admin
            code_b, code, ctl = self._ensure_team(CODE, "Create · Code", owner, 0.50)
            self.helper_role()
            self.migrate_helpers()
            review_b, review, reviewer = self._ensure_team(REVIEW, "Review", owner, 0.25)
            self._refresh_model(CODE)
            self._refresh_model(REVIEW)
            ctl = self.db.one("SELECT * FROM agents WHERE id=?", (ctl["id"],))
            observation = self._code_offer_observation(ctl)
            with self.db.transaction():
                for binding, team, agent in ((code_b, code, ctl), (review_b, review, reviewer)):
                    current = self.db.one("SELECT * FROM swarms WHERE id = ?", (team["id"],))
                    if (self._binding(binding["purpose"]) != binding or not current
                            or current.get("owner") != owner or current.get("archived_at")
                            or current.get("coordinator_id") != agent["id"]):
                        raise self._error("The current foundation binding changed before registration.")
                available = self._offer_current(code_b,ctl,observation)
                description = self._code_description(available)
                rules_changed = self._rules(ctl, code, owner)
                self._sync_offer(code["id"],"code",available)
                self._sync_offer(review["id"],"review",False)
                self.db.execute("UPDATE swarms SET description = ? WHERE id = ? AND description != ?",
                                (description, code["id"], description))
            self._fault("rules-bound")
            # The DB binding is durable before changing process-local templates.
            # This second transaction takes exactly the lock used by atomic spawn;
            # it has no DB writes that could roll back against an in-memory edit.
            with self.db.transaction():
                _,fresh_ctl = self._checked_binding(CODE,code_b,code_b["principal"])
                self._template(CHILD_TEMPLATE, code["id"], fresh_ctl)
                # Native template registration only, not a published Flow artifact,
                # Flow skill, or admission to a Code lease.
                self._template(FLOW_TEMPLATE, code["id"], fresh_ctl)
            self._fault("templates-registered")
            if rules_changed:
                self.hive.events.publish("policy.updated", **self.hive.policy.rule_views())
            people = ([principal] if principal else
                      ["user:" + p["id"] for p in self.db.all("SELECT id FROM people WHERE disabled = 0")])
            studio = []
            for person in people:
                if self.hive.personal.person(person) is None:
                    continue
                try:
                    row, made = self.hive.studio_makers.ensure(person)
                    studio.append({"principal": person, "state": "available", "agent_id": row["id"]})
                except Exception as error:
                    if getattr(error, "code", None) not in ("not_available", "own_key_needed", "person_required"):
                        raise
                    studio.append({"principal": person, "state": "unavailable", "reason": error.code})
            return {"code_team": code["id"], "controller": ctl["id"], "code_available": available,
                    "review_team": review["id"], "reviewer": reviewer["id"], "studio": studio,
                    "review_proposal_routing": "pending-authorized-context-integration"}

    def ensure_quietly(self, principal=None):
        from .hive import HiveError  # runtime import: Hive constructs Foundation
        try:
            return self.ensure(principal)
        except HiveError as error:
            from .studio_makers import program_setting
            # Public configured context, not an inferred origin; never log the
            # exception message/details or allow fields to add journal lines.
            log.warning("hive foundation refused studio_program=%s reason=%s; existing records retained",
                        json.dumps(program_setting()[:128], ensure_ascii=True),
                        json.dumps(str(error.code)[:128], ensure_ascii=True))
            return None
        except Exception:
            log.exception("hive foundation could not be completed; existing records retained")
            return None

    def prepare_request(self, team_id):
        """Only request preflight, after replay and outside the caller's DB lock.

        This is the same idempotent model pickup as startup/sign-in, not a loop or
        an authority grant. Atomic admission still validates all current facts.
        """
        with self._lock:
            b = self._binding(CODE)
            if b is None or b["swarm_id"] != team_id:
                return None
            if self.db._conn.in_transaction:
                raise self._error("Foundation model pickup must precede atomic request admission.")
            self._refresh_model(CODE)
            ctl = self.db.one("SELECT * FROM agents WHERE id=? AND deleted=0", (b["agent_id"],))
            if ctl:
                with self.db.transaction():
                    if b != self._binding(CODE):
                        raise self._error("Foundation binding changed before template pickup.")
                    self._template(CHILD_TEMPLATE,team_id,ctl)
            observation = self._code_offer_observation(ctl) if ctl else None
            with self.db.transaction():
                available = self._offer_current(b,ctl,observation)
                offered = self._sync_offer(team_id,"code",available)
                description = self._code_description(available)
                self.db.execute("UPDATE swarms SET description=? WHERE id=? AND description!=?",
                                (description,team_id,description))
            if not available:
                raise self._error(self._code_description(False))
            if not offered:
                raise self._error("Code is unavailable under the person's current offer settings; no preference was changed.")
            return self.admission_limits(team_id)

    def admission_limits(self, team_id, controller_id=None):
        """None for generic teams; a stale foundation team refuses, never falls through."""
        with self.db.transaction():
            b = self._binding(CODE)
            if b is None or b["swarm_id"] != team_id:
                return None
            team = self.db.one("SELECT * FROM swarms WHERE id = ?", (team_id,))
            agent = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (b["agent_id"],))
            owner = self._owner_read()
            if (not team or not agent or b["principal"] != owner or team.get("owner") != owner
                    or agent.get("owner") != owner or team.get("archived_at")
                    or team.get("coordinator_id") != agent["id"] or agent["swarm_id"] != team_id
                    or agent["kind"] != "omega" or agent.get("driver") != "local"
                    or agent.get("desired") in ("stopped", "paused")
                    or agent.get("status") in ("stopped", "paused", "error")
                    or (controller_id is not None and controller_id != agent["id"])):
                raise self._error("The exact foundation team/controller is not currently admitted.")
            template = self.hive.minds.templates.get(CHILD_TEMPLATE)
            if (not template or template.get("_foundation") != CHILD_TEMPLATE
                    or template not in self.hive.minds.registered(team_id, exact=True) or not self._code_available()):
                raise self._error("Code is unavailable until its matching service and built-in template are ready.")
            if not self._choice(agent,self._need(CODE),selected=agent["model"]).get("route"):
                raise self._error("The current controller has no real supported funded route.")
            child = {"id":"", "owner":agent["owner"], "swarm_id":team_id, "_foundation_preview": True,
                     "model":template["model_id"], "options":None,
                     "budget_usd":min(float(template["max_allocation_usd"]),0.25)}
            if not self._choice(child,self._need(CODE),selected=child["model"]).get("route"):
                raise self._error("The current helper template has no real supported funded route.")
            if any(self._blocked_rule(agent["id"], team_id, skill) for skill in NATIVE_SKILLS):
                raise self._error("A person's current native-control refusal remains effective.")
            return {"controller_usd": 0.50, "request_usd": 0.25, "child_usd": 0.25,
                    "max_children": 1, "lifetime_seconds": 600, "template_ids": (CHILD_TEMPLATE,),
                    "binding": (b["principal"], b["purpose"], b["swarm_id"], b["agent_id"], b["updated_at"])}

    def controller_ceiling(self, agent_id):
        """Canonical budget snapshot input; no pickup/producer/mind lock.

        Lifecycle stops do not enlarge a stored liability's ceiling. Currentness
        of execution, service, route, lease and policy is checked by admission.
        """
        b = self._binding(CODE)
        if b is None or b["agent_id"] != agent_id:
            return None
        team = self.db.one("SELECT * FROM swarms WHERE id=?", (b["swarm_id"],))
        agent = self.db.one("SELECT * FROM agents WHERE id=?", (agent_id,))
        owner = self._owner_read()
        if (not team or not agent or b["principal"] != owner or team.get("owner") != owner
                or agent.get("owner") != owner or team.get("archived_at") or agent["deleted"]
                or team.get("coordinator_id") != agent_id or agent["swarm_id"] != team["id"]
                or agent["kind"] != "omega" or agent["driver"] != "local"):
            raise self._error("The foundation controller budget binding is not current.")
        return 0.50

    def spawn_enabled(self, team_id):
        if getattr(self.hive.settings, "mind_spawn_operator_off", False):
            return False
        try:
            return self.admission_limits(team_id) is not None
        except Exception:
            return False
