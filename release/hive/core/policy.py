"""Policy engine and approvals: which agent actions run, which wait for a human.

The Omega loop asks ``authorize(agent, command)`` before running each skill.
Human-only skills are always refused.  Otherwise the most specific matching
rule decides (agent scope, then swarm, then hive; an exact skill name beats a
glob), falling back to the defaults below.  ``ask`` files an Approval; once a
human approves it, that exact command is allowed once.
"""

from __future__ import annotations

import fnmatch
import logging
import re
import json
import time

from ..spaces import sexpr
from .db import new_id, now
from .services import CODE_MUTATING, parse_binding

# Skills only an exact allow rule for that very skill can permit: no default, no glob, no swarm or hive rule.
EXPLICIT_ONLY = frozenset({"hive-update-apply", "hive-flow-publish"})

# Every hive skill that exists and was reviewed when added. The "hive-*" default allow covers ONLY these; a new hive skill
# defaults to "ask" until it is reviewed and listed here (Kimi 2026-10-05: the glob silently allowed anything named hive-*).
# test_policy_hive_skills.py fails if a module, skill file or the MCP bridge defines a hive skill missing from this set.
REVIEWED_HIVE_SKILLS = frozenset({
    "hive-apply-op", "hive-apply-ops", "hive-artifact-create", "hive-asset-get", "hive-asset-put", "hive-belief",
    "hive-capabilities", "hive-exhibit", "hive-exhibit-space", "hive-finding", "hive-finding-disposition",
    "hive-finding-response", "hive-findings-read", "hive-flow-cancel", "hive-flow-draft", "hive-flow-drafts",
    "hive-flow-read", "hive-flow-retire", "hive-flow-revise", "hive-flow-run",
    "hive-flow-run-get", "hive-flows", "hive-goal-cancel-ack", "hive-goal-claim", "hive-goal-create",
    "hive-goal-done", "hive-goal-fail", "hive-goal-get", "hive-goal-heartbeat", "hive-goal-propose",
    "hive-goal-review", "hive-goal-wait", "hive-goals", "hive-health", "hive-inventory-boot", "hive-lifecycle-start",
    "hive-lifecycle-status", "hive-lifecycle-stop", "hive-mode", "hive-motivation-create", "hive-motivations",
    "hive-plan-return", "hive-plan-review-context",
    "hive-publish", "hive-query", "hive-report-trace", "hive-request", "hive-review-complete",
    "hive-review-receipts", "hive-revision", "hive-revision-part", "hive-revision-read", "hive-room-post", "hive-rooms", "hive-coffee-note",
    "hive-run-control", "hive-share-deny", "hive-share-grant", "hive-share-offer", "hive-share-request",
    "hive-shared", "hive-shared-body", "hive-shared-page", "hive-shares",
    # J3 host R6.1: a Studio maker's own step calls (modules/hive_studio). Parity with the other two transports: the REST
    # maker routes (GET .../studio-sessions/{sid}/context, POST /api/agent/artifacts/{id}/revisions, POST .../done) take
    # agent_from only, and the MCP tools are routed before any policy skill (mcp.STUDIO_TOOLS); every decision is the
    # host's step fences (maker, open step, execution_id, captured epoch, one proposal, op ids). Listing them here keeps
    # that posture for omega minds instead of asking a person at every step; it allows nothing those fences refuse.
    "hive-studio-context", "hive-studio-done", "hive-studio-publish",
})

# J3 host R7.1: a Studio maker's three step skills (modules/hive_studio). While Studio is on and the mind is the maker of a
# live Studio session (StudioSessions.call_principal), a glob deny or ask (e.g. the Design Director role's "*" deny,
# copied to the mind's scope by Roles.apply) never refuses them: exactly these three are added to that maker's effective
# allow, for that session only. A rule naming one of them exactly still decides; no role definition changes, and every
# other skill, and every other mind (the same role included), is decided as before. The host's step fences still decide
# each call (maker, open step, execution, epoch, one proposal, op ids), as for the REST and MCP transports.
STUDIO_STEP_SKILLS = frozenset({"hive-studio-context", "hive-studio-publish", "hive-studio-done"})

# J3 host R8: the two image skills (media.OPS) join that carve-out, for a PERSON'S OWN Studio maker only (the host
# studio_maker binding), while it is the maker of that person's live, admitted session (StudioMakers.live_media_person:
# active or paused, window open, epoch not fenced). Exactly as R7.1: a glob deny or ask never refuses them, a rule naming
# one exactly still decides, no role changes, and every other mind (the shared maker and the template included) is decided
# as before. The media route still applies every money gate (own key only, consent, caps, reservation, send gate, pin,
# breaker).
STUDIO_MEDIA_SKILLS = frozenset({"generate-image", "generate-image-quality"})

# Read-only discovery of a mind's own skill manual (mind fitness 2026-10-06): help, cards, aliases and the skill
# directory never leave the mind and change nothing. A glob rule (a role's "*" deny) never refuses them, so a mind can
# always read how to use the skills it is allowed and see what it could ask for. Only a rule naming one exactly can.
DISCOVERY_SKILLS = frozenset({"skill-help", "skill-card", "skill-aliases", "explain-skill", "query-skill-space"})

HUMAN_ONLY = ["change-password", "transfer-funds", "pay*", "purchase*", "code-network", "code-publish"]

DEFAULT_ALLOW = ["send", "wait", "pin", "hive-*", "query", "remember", "episodes", "search", "web-search",
                 "read-file", "space-find", "space-count", "space-examples", "space-pressure", "skill-*",
                 "beliefs-*", "agenda-*", "events-*", "energy-status", "channel-status",
                 # OmegaCode reads (hive/core/services.py): no change outside the workspace
                 "code-read", "code-search", "code-diff", "code-events", "code-artifact", "code-cancel"]
DEFAULT_ASK = ["shell", "shell-confirm", "metta", "write-file*", "append-file*", "send-file*", "codex-*",
               "space-transform", "remove-atom", "*-commit", "restart-omega",
               # OmegaCode changes: each one approved for its exact binding, redeemed once by the service
               "code-workspace", "code-edit", "code-run", "code-verify", "code-checkpoint", "code-select", "code-git-export", "code-git-original-export", "code-merge-apply"]

FILE_SKILLS = {"read-file", "write-file", "append-file"}
HIGH_RISK = {"shell-confirm", "metta", "space-transform", "remove-atom", "restart-omega"}
SCOPE_RANK = {"agent": 0, "swarm": 1, "hive": 2}


def command_skill(command):
    """Skill name of a command such as (shell "ls"); None if unparseable."""
    try:
        tokens = sexpr.tokenize(str(command))
    except ValueError:
        return None
    if len(tokens) >= 2 and tokens[0] == "(" and isinstance(tokens[1], str) and tokens[1] not in "()":
        return str(tokens[1])
    return None


_TEXT_ONLY_SYNTAX_ERROR = re.compile(r'\(\s*syntax-error(?:\s+"(?:[^"\\]|\\.)*")*\s*\)', re.S)


def _only_text_arguments(command):
    """True for (syntax-error "text" "text" ...): every argument a quoted string, nothing nested or executable."""
    return _TEXT_ONLY_SYNTAX_ERROR.fullmatch(str(command).strip()) is not None


def _minutes_ago(minutes):
    import datetime
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ts(value):
    """created_at as a sortable number (stored as ISO text or a float)."""
    try:
        return float(value)
    except (TypeError, ValueError):
        import datetime
        try:
            return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0


ANSWER_NOTES = ("always allowed when approving ", "never, when refusing ", "allowed for ")   # only to mark rules that predate policy_rules.origin
ORIGIN_ANSWER = "answer"     # a rule created by a person answering an approval (Always / For a time / Never)
ORIGIN_MEMBER = "member"     # host-authored provenance for a member restricting their own mind (P3c)
# How restrictive each rule mode is when rules tie (lower wins).  Explicit: an unknown mode raises, it is never
# quietly ranked.
RESTRICTIVENESS = {"deny": 0, "ask": 1, "allow": 2}


def restrictiveness(mode):
    try:
        return RESTRICTIVENESS[mode]
    except KeyError:
        raise ValueError(f"unknown policy mode {mode!r}") from None


def _matches(pattern, skill):
    return fnmatch.fnmatchcase(skill, pattern)


class Policy:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.recent = {}  # agent_id -> {command: decision}, for traces

    # ---- rules ----------------------------------------------------------------------

    def rules(self):
        """Rules in force: a rule given "for a time" stops applying when it expires."""
        return self.db.all("SELECT * FROM policy_rules WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at", (time.time(),))

    def add_rule(self, scope, skill, mode, note="", expires_at=None, origin="", publish=True, granted_by=None):
        if mode not in ("allow", "ask", "deny"):
            raise self.hive.error(400, "bad_request", "mode must be allow, ask or deny")
        kind, _, ref = str(scope).partition(":")
        if kind not in SCOPE_RANK or (kind != "hive" and not ref):
            raise self.hive.error(400, "bad_request", "scope must be hive, swarm:<id> or agent:<id>")
        if not str(skill).strip():
            raise self.hive.error(400, "bad_request", "skill is required")
        row = {"id": new_id("r"), "scope": scope, "skill": str(skill).strip(), "mode": mode,
               "note": str(note or ""), "created_at": now(), "expires_at": float(expires_at) if expires_at else None,
               "origin": str(origin or "")}
        if granted_by:   # host-identity r1: the person whose answer made this rule
            row["granted_by"] = str(granted_by)
        self.db.insert("policy_rules", row)
        if publish:   # inside a caller's transaction, the caller publishes once after its commit
            self.hive.events.publish("policy.updated", rules=self.rules())
        return row

    def _supersede(self, agent_id, skill):
        """A person's new answer for (mind, skill) replaces their earlier answers: those rules stop applying now.
        They are expired, not deleted, so the record of what was answered stays."""
        for rule in self.rules():
            if rule["scope"] == f"agent:{agent_id}" and rule["skill"] == skill and rule.get("origin") == ORIGIN_ANSWER:
                self.db.execute("UPDATE policy_rules SET expires_at = ? WHERE id = ?", (time.time() - 0.001, rule["id"]))

    def delete_rule(self, rule_id):
        self.db.execute("DELETE FROM policy_rules WHERE id = ?", (rule_id,))
        self.hive.events.publish("policy.updated", rules=self.rules())
        return {"ok": True}

    def _member_person(self, authenticate, expected=None):
        """A trusted, synchronous host callback re-reads the request session; never take a person from client data.
        Keep the people row authoritative for every user suffix, without inferring membership from its spelling."""
        if not callable(authenticate):
            raise self.hive.error(403, "member_only", "a current member session is required")
        principal = authenticate()
        if not isinstance(principal, str) or not principal.startswith("user:") or not principal[5:]:
            raise self.hive.error(403, "member_only", "a current member session is required")
        if expected is not None and principal != expected:
            raise self.hive.error(403, "identity_changed", "the signed-in person changed; reload and try again")
        person = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        if person is None or person.get("disabled") or person.get("role") != "member":
            raise self.hive.error(403, "member_only", "a current member session is required")
        return principal

    def _member_agent_scope(self, scope):
        if not isinstance(scope, str) or scope != scope.strip():
            raise self.hive.error(400, "bad_request", "member rules must use agent:<owned mind id>")
        if scope == "hive" or (scope.startswith("swarm:") and scope[6:]):
            raise self.hive.error(403, "admin_only", "only a hive admin or the hive's owner can change hive or swarm rules")
        if not scope.startswith("agent:") or not scope[6:]:
            raise self.hive.error(400, "bad_request", "member rules must use agent:<owned mind id>")
        return scope[6:]

    def _member_owned_mind(self, agent_id, principal):
        row = self.db.one("SELECT id, owner, deleted FROM agents WHERE id = ?", (agent_id,))
        if row is None or row.get("deleted") or row.get("owner") != principal:
            # The same refusal for missing, deleted, unowned and foreign minds reveals no existence.
            raise self.hive.error(403, "owner_only", "only a mind you currently own can be restricted")

    def member_add_rule(self, scope, skill, mode, note="", *, authenticate):
        """P3c: a current member may only add an ask/deny on a mind they currently own.
        The callback must re-read host authentication without awaiting; it is repeated inside the durable write fence."""
        principal = self._member_person(authenticate)
        # Current personhood is checked first; malformed input remains 400, valid forbidden policy writes are 403.
        if mode not in ("allow", "ask", "deny"):
            raise self.hive.error(400, "bad_request", "mode must be allow, ask or deny")
        if not isinstance(skill, str) or not skill.strip():
            raise self.hive.error(400, "bad_request", "skill is required")
        if not isinstance(note, str) or note.startswith("role:"):
            # Roles._apply_rules owns this legacy note namespace and removes its rows when a role is re-applied.
            raise self.hive.error(400, "bad_request", "note must be text outside the reserved role: namespace")
        agent_id = self._member_agent_scope(scope)
        if mode == "allow":
            raise self.hive.error(403, "admin_only", "only a hive admin or the hive's owner can grant allow rules")
        with self.hive._mind_lock(agent_id), self.db.transaction():
            self._member_person(authenticate, expected=principal)
            self._member_owned_mind(agent_id, principal)
            row = self.add_rule(scope, skill, mode, note, origin=ORIGIN_MEMBER, publish=False, granted_by=principal)
            self.db.after_commit(lambda: self.hive.events.publish("policy.updated", rules=self.rules()))
        return row

    def member_delete_rule(self, rule_id, *, authenticate):
        """Only this member's host-marked P3c rows, still on their own live mind, may be removed by the member path."""
        principal = self._member_person(authenticate)
        if not isinstance(rule_id, str) or not rule_id:
            raise self.hive.error(400, "bad_request", "rule id is required")
        before = self.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule_id,))
        if before is None:
            raise self.hive.error(404, "not_found", "rule not found")
        scope = before.get("scope")
        if not isinstance(scope, str) or not scope.startswith("agent:") or not scope[6:]:
            raise self.hive.error(403, "member_rule_only", "only your member-created rules can be deleted")
        agent_id = scope[6:]
        with self.hive._mind_lock(agent_id), self.db.transaction():
            self._member_person(authenticate, expected=principal)
            current = self.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule_id,))
            if current != before:
                raise self.hive.error(409, "rule_changed", "this rule changed meanwhile; reload and try again")
            if (current.get("origin") != ORIGIN_MEMBER or current.get("granted_by") != principal
                    or current.get("mode") not in ("ask", "deny")):
                raise self.hive.error(403, "member_rule_only", "only your member-created rules can be deleted")
            self._member_owned_mind(agent_id, principal)
            if self.db.execute("DELETE FROM policy_rules WHERE id = ?", (rule_id,)).rowcount != 1:
                raise self.hive.error(409, "rule_changed", "this rule changed meanwhile; reload and try again")
            self.db.after_commit(lambda: self.hive.events.publish("policy.updated", rules=self.rules()))
        return {"ok": True}

    def _outside_folder(self, agent, command):
        """Why a file skill's path is refused, or None. Minds run as the same OS user as the hive, so the gate
        keeps file skills inside the mind's own folder (its working directory): the hive's secrets, other minds'
        folders and private apps are never reachable through them. Symlinks are resolved before the check."""
        import pathlib
        try:
            tokens = sexpr.tokenize(str(command))
        except ValueError:
            return "unparseable path"
        if len(tokens) < 4 or tokens[2] in ("(", ")") or not isinstance(tokens[2], str):
            return "the path must be a plain text path, not a computed expression"
        raw = str(tokens[2])
        if "$" in raw:
            return "the path must be a plain text path, not a variable"
        folder = (self.hive.settings.agents_dir / agent["id"]).resolve()
        target = pathlib.Path(raw).expanduser()
        target = (target if target.is_absolute() else folder / target).resolve()
        if target != folder and folder not in target.parents:
            return "files outside your own folder are not reachable; use paths inside your working folder"
        return None

    def _live_studio_maker(self, agent):
        """R7.1: True while Studio is on and this mind is the maker of a live Studio session (inert with Studio off)."""
        studio = getattr(self.hive, "studio", None)
        try:
            return bool(studio is not None and agent.get("id") and studio.call_principal(agent["id"]))
        except Exception:   # noqa: BLE001  (a policy read never fails open on an error: not a live maker)
            return False

    def _live_personal_maker(self, agent):
        """R8: True while this mind is a person's own Studio maker making that person's live session (inert otherwise)."""
        makers = getattr(self.hive, "studio_makers", None)
        try:
            return bool(makers is not None and makers.live_media_person(agent))
        except Exception:   # noqa: BLE001
            return False

    def _ceiling(self, agent_id, skill):
        swarms = getattr(getattr(self, "hive", None), "person_swarms", None)
        try:
            return swarms.ceiling(agent_id, skill) if swarms is not None else None
        except Exception as exc:   # noqa: BLE001  (a ceiling read never fails open: deny)
            logging.getLogger("hive").warning("app template ceiling read failed (%s); denying", type(exc).__name__)
            return "deny"

    def decide(self, agent, skill):
        """(mode, reason) without approvals. Calendar consent is a prerequisite. App platform P2's template ceiling
        precedes normal policy and its discovery/Studio carve-outs; subsequent rules can only tighten these bounds."""
        if skill == "calendar-read":
            connector = getattr(self.hive, "google_connector", None)
            try:
                allowed = connector is not None and connector.mind_allowed(agent) is True
            except Exception:
                allowed = False
            if not allowed:
                return "deny", "this mind needs its owner's Google consent"
        cap = self._ceiling(agent.get("id"), skill)
        if cap == "deny":
            return "deny", "the app that set up this mind does not allow this"
        mode, reason = self._decide(agent, skill)
        if cap == "ask" and mode == "allow":
            return "ask", "the app that set up this mind asks a person first"
        return mode, reason

    def _decide(self, agent, skill):
        if any(_matches(p, skill) for p in HUMAN_ONLY):
            return "deny", "human-only action"
        if skill in EXPLICIT_ONLY:
            exact = [r for r in self.rules() if r["scope"] == f"agent:{agent['id']}" and r["skill"] == skill]
            if exact and exact[-1]["mode"] == "allow":
                return "allow", exact[-1]["note"] or "explicit rule"
            return "deny", f"{skill} needs an exact allow rule for this mind (an admin grants it)"
        scopes = {"hive": 2, f"agent:{agent['id']}": 0}
        if agent.get("swarm_id"):
            scopes[f"swarm:{agent['swarm_id']}"] = 1
        # An unreviewed hive skill is never allowed by a glob rule (e.g. "hive-*"): only a rule naming it exactly can
        # allow it. Glob deny/ask rules still apply, since they only restrict (Kimi 2026-10-05).
        unreviewed = skill.startswith("hive-") and skill not in REVIEWED_HIVE_SKILLS
        studio_step = skill in STUDIO_STEP_SKILLS and self._live_studio_maker(agent)
        studio_media = skill in STUDIO_MEDIA_SKILLS and self._live_personal_maker(agent)   # R8
        studio_open = studio_step or studio_media
        candidates = []
        for rule in self.rules():
            if rule["scope"] in scopes and _matches(rule["skill"], skill):
                exact = 0 if rule["skill"] == skill else 1
                if unreviewed and exact and rule["mode"] == "allow":
                    continue
                if skill in DISCOVERY_SKILLS and exact and rule["mode"] != "allow":
                    continue   # discovery stays readable under a glob deny or ask (see DISCOVERY_SKILLS)
                if studio_open and exact and rule["mode"] != "allow":
                    continue   # R7.1/R8: a live maker's step (and own maker's image) skills under a glob deny or ask
                candidates.append((scopes[rule["scope"]], exact, rule))
        if studio_step and not candidates:
            return "allow", "a live Studio maker's step skill"
        if studio_media and not candidates:
            return "allow", "a person's own live Studio maker's image skill"
        if candidates:
            # Most specific scope, then exact before glob; within the same scope and specificity the most
            # restrictive rule wins (deny, then ask, then allow) and then the newest.  A person's later answer
            # replaces their earlier one for the same mind and skill (see _supersede), so "Never" after "Always"
            # takes effect, and a role or admin rule can never quietly outvote a refusal.
            candidates.sort(key=lambda c: (c[0], c[1], restrictiveness(c[2]["mode"]), -_ts(c[2]["created_at"])))
            rule = candidates[0][2]
            return rule["mode"], rule["note"] or f"rule {rule['skill']} ({rule['scope']})"
        if unreviewed:
            return "ask", "a hive skill not yet reviewed: a person decides until it is listed"
        if any(_matches(p, skill) for p in DEFAULT_ALLOW):
            return "allow", "default"
        if any(_matches(p, skill) for p in DEFAULT_ASK):
            return "ask", "side effects outside the agent need a human"
        return "allow", "default"

    MAX_DECISIONS = 400

    def decisions(self, agent, skills):
        """{skill: mode} for the skills a mind's prompt names, so it advertises only what it may use or ask for.
        Read-only: no approval is filed and nothing is recorded; the gate still decides every command."""
        if not isinstance(skills, list) or len(skills) > self.MAX_DECISIONS:
            raise self.hive.error(400, "bad_request", f"skills is a list of at most {self.MAX_DECISIONS} skill names")
        out = {}
        for skill in skills:
            if not isinstance(skill, str) or not 0 < len(skill) <= 80:
                raise self.hive.error(400, "bad_request", "each skill is a name of 1-80 characters")
            out[skill] = self.decide(agent, skill)[0]
        return {"decisions": out}

    # ---- authorize --------------------------------------------------------------------

    def authorize(self, agent, command):
        command = str(command).strip()
        skill = command_skill(command)
        if skill is None:
            return {"decision": "deny", "message": "HIVE-DENIED unparseable command"}
        if skill in FILE_SKILLS:
            outside = self._outside_folder(agent, command)
            if outside:
                return {"decision": "deny", "message": f"HIVE-DENIED {skill}: {outside}"}
        if skill == "syntax-error" and _only_text_arguments(command):
            # the mind's own parser reporting a malformed command back to the mind: no effect, never a human's job
            return {"decision": "allow"}
        mode, reason = self.decide(agent, skill)
        decision = None
        if mode == "deny":
            decision = {"decision": "deny", "message": f"HIVE-DENIED {skill}: {reason}"}
        elif mode == "allow":
            decision = {"decision": "allow"}
        elif skill in CODE_MUTATING:
            # Exact coding operations are never consumed here: the service redeems the approval for its
            # exact binding (services.redeem).  Report the approval, filing one if none is open.
            open_ = self.db.one(
                "SELECT * FROM approvals WHERE agent_id = ? AND command = ? AND status IN ('pending', 'approved') "
                "AND redeemed_at IS NULL ORDER BY created_at LIMIT 1", (agent["id"], command))
            if open_ is None:
                _, binding = parse_binding(command)
                if binding is None:
                    decision = {"decision": "deny", "message": f"HIVE-DENIED {skill}: not a canonical bound operation"}
                else:
                    open_ = self._file(agent, skill, command, reason, binding)
            if decision is None:
                decision = {"decision": "pending", "approval_id": open_["id"], "approved": open_["status"] == "approved",
                            "message": f"HIVE-APPROVAL {open_['id']} ({open_['status']}): retry the operation with this approval id."}
        else:
            granted = self.db.one(
                "SELECT * FROM approvals WHERE agent_id = ? AND command = ? AND status = 'approved' "
                "ORDER BY created_at LIMIT 1", (agent["id"], command))
            if granted:
                self.db.execute("UPDATE approvals SET status = 'used' WHERE id = ?", (granted["id"],))
                self.hive.events.publish("approval.updated", approval=self.approval(granted["id"]))
                decision = {"decision": "allow", "approval_id": granted["id"]}
            else:
                pending = self.db.one(
                    "SELECT * FROM approvals WHERE agent_id = ? AND command = ? AND status = 'pending'",
                    (agent["id"], command))
                approval = pending or self._file(agent, skill, command, reason)
                decision = {"decision": "pending", "approval_id": approval["id"],
                            "message": f"HIVE-APPROVAL-PENDING {approval['id']}: a human must approve {command}. "
                                       "You will get a message when it is approved; then issue the same command again."}
        self.recent.setdefault(agent["id"], {})[command] = (
            "ask" if decision["decision"] == "pending" else decision["decision"])
        return decision

    def enforce(self, agent, skill, command):
        """Apply the policy to an action taken directly through the HTTP API.

        The Omega loop asks ``authorize`` before running a skill; external
        members (and any client) call the routes directly, so disclosure routes
        enforce the same rules here. ``deny`` refuses. ``ask`` needs a human:
        either an approval the agent's own gate just used for this skill (one
        redemption each), or an approval of this exact canonical command, filed
        on the first attempt and allowed once after a human approves it.
        """
        mode, reason = self.decide(agent, skill)
        if mode == "allow":
            return
        if mode == "deny":
            raise self.hive.error(403, "policy_denied", f"{skill} is denied for {agent['name']}: {reason}")
        recent = self.db.one(
            "SELECT * FROM approvals WHERE agent_id = ? AND skill = ? AND status = 'used' AND redeemed_at IS NULL "
            "AND decided_at >= ? ORDER BY decided_at DESC LIMIT 1",
            (agent["id"], skill, _minutes_ago(30)))
        gate_used = recent and self.recent.get(agent["id"], {}).get(recent["command"]) is not None
        if gate_used:
            self.db.execute("UPDATE approvals SET redeemed_at = ? WHERE id = ?", (now(), recent["id"]))
            return
        decision = self.authorize(agent, command)
        if decision["decision"] == "allow":
            if decision.get("approval_id"):
                self.db.execute("UPDATE approvals SET redeemed_at = ? WHERE id = ?", (now(), decision["approval_id"]))
            return
        if decision["decision"] == "pending":
            raise self.hive.error(403, "approval_required",
                                  f"{skill} needs a person's approval ({decision['approval_id']}); send the same "
                                  "request again once it is approved", {"approval_id": decision["approval_id"]})
        raise self.hive.error(403, "policy_denied", decision.get("message", f"{skill} is denied"))

    def _file(self, agent, skill, command, reason, binding=None):
        row = {"id": new_id("p"), "agent_id": agent["id"], "skill": skill, "command": command,
               "reason": reason, "risk": "high" if skill in HIGH_RISK else "medium", "status": "pending",
               "decided_by": None, "created_at": now(), "decided_at": None}
        if binding is not None:
            row["binding"] = json.dumps(binding, sort_keys=True)
        self.db.insert("approvals", row)
        self.hive.events.publish("approval.created", approval={k: v for k, v in row.items() if k != "binding"} | (
            {"binding": binding} if binding else {}))
        return row

    # ---- approvals ------------------------------------------------------------------------

    def approval(self, approval_id):
        row = self.db.one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no approval {approval_id}")
        return row

    def approvals(self, status=None):
        if status:
            return self.db.all("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC", (status,))
        return self.db.all("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 500")

    DECISIONS = ("once", "for", "always", "no", "never")

    def require_approval_owner(self, approval, operator):
        """P3b write guard. Audit reads do not call it; no admin/hive-owner bypass."""
        mind = self.db.one("SELECT owner, options FROM agents WHERE id = ? AND deleted = 0", (approval["agent_id"],))
        if mind is None:
            raise self.hive.error(404, "not_found", "the approval's mind no longer exists")
        try:
            options = json.loads(mind.get("options") or "{}")
            if not isinstance(options, dict) or options.get("approvals") not in (None, "owner_only"):
                raise ValueError()
        except (TypeError, ValueError):
            raise self.hive.error(409, "approval_policy_unavailable", "the mind's approval policy cannot be read safely") from None
        owner_only = options.get("approvals") == "owner_only"
        if owner_only and (not mind.get("owner") or mind["owner"] != operator):
            raise self.hive.error(403, "approval_owner_only", "only this mind's owner can answer its approvals")
        return owner_only

    async def answer(self, approval_id, decision, operator="user:operator", minutes=None, guard=None):
        """Five answers; commit any durable rule with the decision, before async notices."""
        if decision not in self.DECISIONS:
            raise self.hive.error(400, "bad_request", "decision is once, for, always, no or never")
        return await self.decide_approval(approval_id, decision in ("once", "for", "always"), operator,
                                         guard=guard, decision=decision, minutes=minutes)

    async def decide_approval(self, approval_id, approve, operator="user:operator", remember=False, *, guard=None,
                              decision=None, minutes=None):
        # No await between the current actor/owner/flag check and the complete decision.
        # Durable rules commit with status; notifications run after this short locked transaction.
        initial = self.approval(approval_id)
        policy_changed = False
        with self.hive._mind_lock(initial["agent_id"]), self.db.transaction():
            if guard is not None and guard() != operator:
                raise self.hive.error(401, "unauthorized", "the signed-in authority changed")
            row = self.approval(approval_id)
            if row["agent_id"] != initial["agent_id"]:
                raise self.hive.error(409, "approval_changed", "reload this approval before answering")
            self.require_approval_owner(row, operator)
            if row["status"] != "pending":
                raise self.hive.error(409, "not_pending", f"approval is {row['status']}")
            exact = str(row["skill"]).startswith("program:")
            if decision is not None:
                if decision not in self.DECISIONS:
                    raise self.hive.error(400, "bad_request", "decision is once, for, always, no or never")
                if exact and decision in ("for", "always"):
                    raise self.hive.error(400, "exact_only", "app actions are approved one exact request at a time")
                if row["risk"] == "high" and decision in ("for", "always"):
                    raise self.hive.error(400, "one_at_a_time", "high-risk actions are approved one at a time")
                if decision == "for":
                    try:
                        minutes = int(minutes)
                    except (TypeError, ValueError):
                        raise self.hive.error(400, "bad_request", "say for how many minutes") from None
                    if not 1 <= minutes <= 7 * 24 * 60:
                        raise self.hive.error(400, "bad_request", "for a time is 1 minute to 7 days")
                if decision in ("for", "always") and self._ceiling(row["agent_id"], row["skill"]):
                    decision = "once"   # P2: a durable answer cannot lower the template ceiling
                approve = decision in ("once", "for", "always")
                remember = decision == "always"
            if approve and remember and exact:
                raise self.hive.error(400, "exact_only", "app actions are approved one exact request at a time; they cannot be remembered")
            if approve and remember and (row.get("risk") == "high" or row["skill"] in HIGH_RISK):
                raise self.hive.error(400, "one_at_a_time", "high-risk actions are approved one at a time")
            if remember and self._ceiling(row["agent_id"], row["skill"]):
                remember = False
            status = "approved" if approve else "denied"
            cur = self.db.execute("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
                                  (status, operator, now(), approval_id))
            if cur.rowcount != 1:
                raise self.hive.error(409, "not_pending", "approval was answered concurrently")
            if approve and remember:
                self._supersede(row["agent_id"], row["skill"])
                self.add_rule(f"agent:{row['agent_id']}", row["skill"], "allow",
                              f"always allowed when approving {approval_id}", origin=ORIGIN_ANSWER, granted_by=operator, publish=False)
                policy_changed = True
            if decision in ("for", "never") and not exact:
                self._supersede(row["agent_id"], row["skill"])
            if decision == "for":
                self.add_rule(f"agent:{row['agent_id']}", row["skill"], "allow",
                              f"allowed for {minutes} min when approving {approval_id}", expires_at=time.time() + minutes * 60,
                              origin=ORIGIN_ANSWER, granted_by=operator, publish=False)
                policy_changed = True
            if decision == "never" and not exact:
                self.add_rule(f"agent:{row['agent_id']}", row["skill"], "deny", f"never, when refusing {approval_id}",
                              origin=ORIGIN_ANSWER, granted_by=operator, publish=False)
                policy_changed = True
            updated = self.approval(approval_id)
        if policy_changed:
            self.hive.events.publish("policy.updated", rules=self.rules())
        from .governance_evidence import approval_statement
        self.hive.governance.record(approval_id, approval_statement(row["agent_id"], row["skill"]), approve)
        self.hive.events.publish("approval.updated", approval=updated)
        note = (f"[APPROVED {approval_id}] {row['command']}" if approve
                else f"[DENIED {approval_id}] {row['command']} - do not retry it")
        await self.hive.send_to_agent(row["agent_id"], note, sender="hive:approvals")
        if exact:
            await self.hive.program_actions.notify_decision(updated)
        return updated

    def gate_of(self, agent_id, command):
        return self.recent.get(agent_id, {}).get(str(command).strip())

    @staticmethod
    def dumps(value):
        return json.dumps(value)
