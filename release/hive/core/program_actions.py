"""Minds acting in programs (contract 0.2): POST /api/agent/programs/{program}/act.

The hive, never the request, decides who acts: principal, actor and swarm come from the member token, and a
body that names them is refused.  A program exposes an action to minds only by declaring ``"agents": true``
on it, and a mind may use it only under an explicit policy rule ``program:<program>:<action>`` (normally
written when a person attaches the mind to the app): there is no default allow here.  On ``ask`` the hive
files an approval bound to the exact request (canonical JSON, see ``binding``) and redeems it once, itself,
immediately before calling ``act``.  Every request carries an idempotency key: an identical retry returns the
recorded result; a different request under the same key is refused.  Records here are the activity log of
minds in apps.
"""

import hashlib
import json

from .db import new_id, now

IDENTITY_FIELDS = {"principal", "actor", "swarm_id", "agent_id", "member_id"}
# An app's credentials are its own: the hive never carries one from a caller to an app (agreed with Atlas, 2026-10-04).
REQUEST_KEYS = {"idempotency_key", "client_key", "intent_key", "receipt_key"}   # the hive's own retry keys, not credentials
CREDENTIAL_WORDS = ("credential", "secret", "password", "token", "api_key", "apikey", "authorization", "private_key")

SCHEMA = """
CREATE TABLE IF NOT EXISTS program_actions (
  id TEXT PRIMARY KEY, program TEXT NOT NULL, swarm_id TEXT NOT NULL, principal TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, items TEXT NOT NULL, params_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  approval_id TEXT, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (principal, program, idempotency_key)
);
CREATE INDEX IF NOT EXISTS program_actions_swarm ON program_actions(swarm_id, created_at);
CREATE TABLE IF NOT EXISTS confirm_tokens (
  token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, session_hash TEXT NOT NULL, program TEXT NOT NULL,
  swarm_id TEXT NOT NULL, action TEXT NOT NULL, payload_digest TEXT NOT NULL, expires_at REAL NOT NULL, used_at REAL,
  intent TEXT
);
"""
CONFIRM_TTL = 120   # seconds a host confirm token lives
DIGEST = __import__("re").compile(r"sha256:[0-9a-f]{64}")
MAX_SAFE_INT = 2 ** 53 - 1   # the integers JS and Python both write the same way
CONFIRM_MAX_BYTES = 2 * 1024 * 1024   # a confirmed act's canonical payload (file bytes are not in it), at mint and at act


def named_person(principal):
    """A signed-in person (Google invitee or family sign-in), never the loopback operator password."""
    return isinstance(principal, str) and principal.startswith("user:") and principal != "user:operator"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


RECEIPT_STATES = ("committed", "pending", "refused", "unknown")   # the closed set validate_result enforces


def digest(value):
    return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def confirmable(value):
    """The JSON a confirm digest covers (§9d): objects with string keys, arrays, strings of valid Unicode, booleans,
    null and integers within +-(2^53-1). No floats at all (so no -0, exponents, NaN or Infinity): those are exactly
    where Python and JS write numbers differently, so a browser's digest of them could never be redeemed."""
    try:
        if value is None or isinstance(value, bool):
            return True
        if isinstance(value, str):
            value.encode("utf-8")      # a lone surrogate is refused
            return True
        if isinstance(value, int):
            return -MAX_SAFE_INT <= value <= MAX_SAFE_INT
        if isinstance(value, list):
            return all(confirmable(v) for v in value)
        if isinstance(value, dict):
            return all(isinstance(k, str) and confirmable(k) and confirmable(v) for k, v in value.items())
    except (UnicodeEncodeError, RecursionError):
        pass
    return False


def act_payload(items, params, base_revision, file_meta=None):
    """What a host confirm token binds (PROGRAMS.md §9d): the act's normalized items, params and base_revision, plus
    the file's {name, mime, size, sha256} when one is sent. Its digest is digest(act_payload(...))."""
    return {"items": items, "params": params, "base_revision": base_revision, **({"file": file_meta} if file_meta else {})}


class ProgramActions:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for statement in SCHEMA.split(";"):
            if statement.strip():
                self.db.execute(statement)

    # ---- the trusted actor ---------------------------------------------------------------------

    @staticmethod
    def mind_actor(agent):
        return {"principal": f"agent:{agent['id']}", "kind": "mind", "id": agent["id"], "name": agent["name"], "role": None,
                "local_operator": False, "member_id": agent["id"], "swarm_id": agent["swarm_id"], "route": "agent", "approval": None}

    @staticmethod
    def person_actor(session, role, swarm_id):
        principal = session.get("principal") or "user:operator"
        return {"principal": principal, "kind": "person", "id": principal.split(":", 1)[1], "name": principal.split(":", 1)[1],
                "role": role, "local_operator": session.get("kind") == "password" or principal == "user:operator",
                "member_id": None, "swarm_id": swarm_id, "route": "operator", "approval": None}

    @staticmethod
    def person_viewer(session, role, swarm_id):
        """Final proposed read shape; action actor shape remains unchanged."""
        actor = ProgramActions.person_actor(session, role, swarm_id)
        return {"kind": "operator" if actor["local_operator"] else "person",
                "person_id": None if actor["local_operator"] else actor["id"],
                "principal": actor["principal"], "role": actor["role"],
                "local_operator": actor["local_operator"], "member_id": None,
                "swarm_id": swarm_id, "route": "operator"}

    @staticmethod
    def refuse_identity(hive, body, params):
        named = (IDENTITY_FIELDS & set(body or {})) | (IDENTITY_FIELDS & set(params or {}))
        if named:
            raise hive.error(400, "identity_in_request", f"the hive sets who acts; remove {', '.join(sorted(named))}")
        keys = [k for k in list(body or {}) + list(params or {}) if isinstance(k, str) and k.lower() not in REQUEST_KEYS
                and (k.lower() == "key" or k.lower().endswith("_key") or any(w in k.lower() for w in CREDENTIAL_WORDS))]
        if keys:
            raise hive.error(400, "credential_in_request", f"apps hold their own credentials; never send one ({', '.join(sorted(set(keys)))})")

    # ---- minds -----------------------------------------------------------------------------------

    async def agent_act(self, agent, program_id, body):
        self.hive.person_swarms.require_current(agent["id"])
        hive = self.hive
        body = body if isinstance(body, dict) else {}
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise hive.error(400, "bad_request", "params must be an object")
        self.refuse_identity(hive, {k: v for k, v in body.items() if k not in ("params",)}, params)
        if "file" in body:
            raise hive.error(403, "person_required", "only a signed-in person sends a file to an app")
        if not agent.get("swarm_id"):
            raise hive.error(400, "no_swarm", "this mind is not in a swarm")
        action, items = str(body.get("action") or ""), body.get("items") or []
        key, base_revision = str(body.get("idempotency_key") or ""), body.get("base_revision")
        if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            raise hive.error(400, "bad_request", "items must be a list of item ids")
        if not 1 <= len(key) <= 120:
            raise hive.error(400, "bad_request", "idempotency_key is required (1-120 characters)")
        entry = hive.programs._ready(program_id)
        declared = next((a for a in entry["describe"].get("actions", []) if a.get("id") == action), None)
        if declared is None:
            raise hive.error(400, "bad_request", f"{program_id} has no action {action!r}")
        if declared.get("agents") is not True:
            raise hive.error(403, "not_for_minds", f"{program_id} does not let minds use {action!r}")
        skill = f"program:{program_id}:{action}"
        mode, reason = self.decide(agent, skill)
        actor = self.mind_actor(agent)
        if hive.app_attachments.required(entry):
            attachment, reviewed_mode = hive.app_attachments.authorize(program_id, agent, action)
            actor["attachment"] = attachment
            if mode != "deny": mode = reviewed_mode
        mode, reason = self._cap(agent, skill, mode, reason)
        binding_params = {k: params.get(k) for k in declared.get("binding_params", [])}
        binding = {"principal": actor["principal"], "actor": actor["id"], "swarm_id": agent["swarm_id"], "program": program_id,
                   "action": action, "items": items, "binding_params": binding_params, "payload_digest": digest(params),
                   "base_revision": base_revision, "idempotency_key": key}
        person_binding, _reason = hive.person_swarms.current(agent["id"])
        if person_binding is not None:
            binding["person_template_digest"] = person_binding["template_digest"]
        if actor.get("attachment"):
            binding["attachment_id"] = actor["attachment"]["id"]
            if actor["attachment"].get("binding"):
                binding["attachment_binding"] = actor["attachment"]["binding"]   # r2.6: approvals bind it
        params_digest = digest({"action": action, "items": items, "params": params, "base_revision": base_revision})

        prior = self.db.one("SELECT * FROM program_actions WHERE principal = ? AND program = ? AND idempotency_key = ?",
                            (actor["principal"], program_id, key))
        if prior is not None:
            if (json.loads(prior["actor"]).get("attachment") or {}).get("id") != (actor.get("attachment") or {}).get("id"):
                raise hive.error(409, "attachment_changed", "command key belongs to another attachment")
            if prior["params_digest"] != params_digest:
                raise hive.error(409, "idempotency_conflict", "this idempotency key was used for a different request")
            if prior["status"] == "running":
                raise hive.error(409, "in_progress", "this request is still running")
        if mode == "deny":
            raise hive.error(403, "policy_refused", f"{skill}: {reason}")
        # r15: an action the app declares `"effect": "read"` changes nothing, so it is safe to run again. Its result (which
        # may be disclosed content, e.g. a library page) is never stored, only a digest; a repeat re-runs the read under
        # the current grants instead of replaying a stored copy, and the app's ctx is read-only (enforced by the hive).
        read_effect = declared.get("effect") == "read"
        if prior is not None and prior["status"] == "done" and declared.get("revalidate") is not True and not read_effect:
            # An ordinary effect retry returns its old receipt without consuming
            # its one-shot approval again. Sensitive disclosures opt in below.
            hive.person_swarms.require_current(agent["id"])
            return json.loads(prior["result"])
        if prior is not None and prior["status"] == "done" and not read_effect:
            hive.person_swarms.require_current(agent["id"])
            # Explicitly idempotent sensitive actions recheck app grants on every
            # disclosure. Keep the original activity record rather than replacing it.
            # Recovery repeats no effect, so it never asks for or spends a second approval: the original single-use
            # approval travels as the recorded fact it is (a current policy deny was already refused above).
            actor["approval"] = json.loads(prior["actor"]).get("approval")
            actor["recovery"] = True
            # the app rechecks current access and returns this, unchanged; it never re-runs the effect
            command = {"idempotency_key": key, "record_id": prior["id"], "route": "agent",
                       "action": action, "items": items, "params_digest": params_digest,
                       "base_revision": base_revision, "revalidation_supported": True,
                       "recorded_result": json.loads(prior["result"]) if prior["result"] else None}
            return await hive.programs.act(program_id, agent["swarm_id"], action, items, params,
                                           base_revision, actor=actor, command=command)
        if mode == "ask":
            hive.person_swarms.require_current(agent["id"])
            actor["approval"] = self._approval(agent, skill, binding, body.get("approval_id"), declared.get("approver") == "person")
            if actor["approval"].get("pending"):
                return {"status": "approval_required", "approval_id": actor["approval"]["id"],
                        "message": f"a person must approve {skill}; repeat the same request with this approval_id"}
        row_id = prior["id"] if prior else new_id("pa")
        row = {"id": row_id, "program": program_id, "swarm_id": agent["swarm_id"], "principal": actor["principal"],
               "actor": json.dumps(actor), "action": action, "items": json.dumps(items), "params_digest": params_digest,
               "idempotency_key": key, "approval_id": (actor["approval"] or {}).get("id"), "status": "running",
               "result": None, "created_at": now(), "finished_at": None}
        if prior:   # a re-run records who it ran as now, including a fresh approval (stand-in r15 P2)
            self.db.update("program_actions", row_id, {"status": "running", "approval_id": row["approval_id"],
                                                       "actor": row["actor"]})
        else:
            self.db.insert("program_actions", row)
        try:
            hive.person_swarms.require_current(agent["id"])
            fresh_mode = self._cap(agent, skill, mode, reason)[0]
            current_binding, _reason = hive.person_swarms.current(agent["id"])
            if current_binding is not None and current_binding["template_digest"] != binding.get("person_template_digest"):
                raise hive.error(409, "binding_changed", "the person-owned setup changed; ask again")
            if fresh_mode != mode:
                raise hive.error(409, "policy_changed", "the app template policy changed; ask again")
            if fresh_mode == "deny":
                raise hive.error(403, "policy_refused", "the app template no longer allows this action")
            command = {"idempotency_key": key, "record_id": row_id, "route": "agent", "action": action, "items": items,
                       "params_digest": params_digest, "base_revision": base_revision,
                       "revalidation_supported": declared.get("revalidate") is True}
            result = await hive.programs.act(program_id, agent["swarm_id"], action, items, params, base_revision,
                                             actor=actor, command=command, read_only=read_effect)
        except Exception:
            self.db.update("program_actions", row_id, {"status": "failed", "finished_at": now()})
            raise
        stored = {"redacted": "read", "digest": digest(result), "status": result.get("status")} if read_effect else result
        self.db.update("program_actions", row_id, {"status": "done", "result": json.dumps(stored), "finished_at": now()})
        hive.events.publish("program.action", record={"id": row_id, "program": program_id, "swarm_id": agent["swarm_id"],
                                                      "actor": actor["id"], "action": action, "status": result.get("status")})
        return result

    def _cap(self, agent, skill, mode, reason):
        cap = self.hive.policy._ceiling(agent.get("id"), skill)
        if cap == "deny":
            return "deny", "the app template does not allow this action"
        if cap == "ask" and mode == "allow":
            return "ask", "the app template asks a person first"
        return mode, reason

    def decide(self, agent, skill):
        cap = self._cap(agent, skill, "allow", "")
        if cap[0] == "deny":
            return cap
        return self._cap(agent, skill, *self._decide(agent, skill))

    def _decide(self, agent, skill):
        """Only rules written for app actions count (skill patterns starting 'program:'): a hive-wide '*' allow,
        or the default allow for ordinary skills, never lets a mind act in an app. The most specific scope wins,
        then an exact skill over a pattern; with no such rule the answer is deny."""
        import fnmatch
        from .policy import restrictiveness
        if any(fnmatch.fnmatchcase(skill, p) for p in __import__("hive.core.policy", fromlist=["HUMAN_ONLY"]).HUMAN_ONLY):
            return "deny", "human-only action"
        scopes = {f"agent:{agent['id']}": 0, f"swarm:{agent['swarm_id']}": 1, "hive": 2}
        rules = [r for r in self.db.all("SELECT * FROM policy_rules WHERE skill LIKE 'program:%' AND (expires_at IS NULL OR expires_at > ?)",
                                         (__import__("time").time(),))
                 if r["scope"] in scopes and fnmatch.fnmatchcase(skill, r["skill"])]
        if not rules:
            return "deny", "the mind is not attached to this app action"
        rules.sort(key=lambda r: (scopes[r["scope"]], 0 if r["skill"] == skill else 1,
                                  restrictiveness(r["mode"]), r["created_at"]))
        rule = rules[0]
        return rule["mode"], rule["note"] or f"rule {rule['skill']} ({rule['scope']})"

    def _approval(self, agent, skill, binding, approval_id, person_only=False):
        hive = self.hive
        command = f"({skill} {canonical(binding)})"
        if not approval_id:
            open_ = self.db.one("SELECT * FROM approvals WHERE agent_id = ? AND command = ? AND status IN ('pending', 'approved') "
                                "AND redeemed_at IS NULL ORDER BY created_at LIMIT 1", (agent["id"], command))
            if open_ is None:
                open_ = hive.policy._file(agent, skill, command, "an app action needs a person's approval", binding)
            return {"id": open_["id"], "pending": True}
        row = self.db.one("SELECT * FROM approvals WHERE id = ?", (str(approval_id),))
        if row is None or row["agent_id"] != agent["id"] or row["skill"] != skill:
            raise hive.error(409, "binding_mismatch", "that approval is not for this mind and action")
        if row["status"] != "approved" or row.get("redeemed_at"):
            raise hive.error(409, "not_approved", f"approval is {row['status']}{' and already used' if row.get('redeemed_at') else ''}")
        if canonical(json.loads(row["binding"] or "{}")) != canonical(binding):
            raise hive.error(409, "binding_mismatch", "the request differs from what was approved")
        if person_only and not named_person(row.get("decided_by")):
            raise hive.error(409, "person_approval_required",
                             "this action needs a named signed-in person's approval; the local operator password is not one")
        with hive._mind_lock(agent["id"]):
            hive.person_swarms.require_current(agent["id"])
            if self._cap(agent, skill, "allow", "")[0] == "deny":
                raise hive.error(403, "policy_refused", "the app template no longer allows this approval")
            cur = self.db.execute("UPDATE approvals SET status = 'used', redeemed_at = ? WHERE id = ? AND status = 'approved' AND redeemed_at IS NULL",
                                  (now(), row["id"]))
        if cur.rowcount != 1:
            raise hive.error(409, "not_approved", "approval was used concurrently")
        return {"id": row["id"], "binding_digest": digest(binding), "approved_by": row.get("decided_by")}

    def _person_file(self, actor, program_id, swarm_id, declared, file):
        """One file from the person's device, for an action that declares accepts_file (Surface G2, 2026-10-05).
        Checked against the declared types and size, only for a named person the app has admitted here; the program
        receives the bytes, the hive keeps none of them (only name, type, size and sha256 enter the intent digest)."""
        if file is None:
            return None
        accepts = declared.get("accepts_file")
        if not accepts:
            raise self.hive.error(400, "file_not_accepted", f"{declared.get('id') or 'this action'} does not take a file")
        if not named_person(actor["principal"]) or actor.get("local_operator"):
            raise self.hive.error(403, "person_required", "only a signed-in person sends a file to an app")
        if not self.hive.programs.admitted(actor["principal"], program_id, swarm_id):
            raise self.hive.error(403, "app_not_opened", f"open {program_id} in this swarm first; it decides who may use it")
        if (not isinstance(file, dict) or set(file) != {"name", "mime", "size", "content_base64"}
                or not isinstance(file["name"], str) or not 1 <= len(file["name"]) <= 255
                or type(file["size"]) is not int or not isinstance(file["content_base64"], str)):
            raise self.hive.error(400, "bad_file", "a file is {name, mime, size, content_base64}")
        if file["mime"] not in accepts["mimes"]:
            raise self.hive.error(415, "file_type_refused", f"this action takes {', '.join(accepts['mimes'])}")
        if len(file["content_base64"]) > -(-accepts["max_bytes"] // 3) * 4:   # bounded before decoding (Kimi next9 #3)
            raise self.hive.error(413, "file_too_large", f"this action takes files up to {accepts['max_bytes']} bytes")
        if not 0 < file["size"] <= accepts["max_bytes"]:
            raise self.hive.error(413, "file_too_large", f"this action takes files up to {accepts['max_bytes']} bytes")
        import base64, binascii, hashlib
        try:
            data = base64.b64decode(file["content_base64"], validate=True)
        except (binascii.Error, ValueError):
            raise self.hive.error(400, "bad_file", "content_base64 is not base64")
        if len(data) != file["size"]:
            raise self.hive.error(400, "bad_file", "size does not match the bytes sent")
        return {"name": file["name"], "mime": file["mime"], "size": len(data),
                "sha256": "sha256:" + hashlib.sha256(data).hexdigest(), "bytes": data}

    def _activity_person(self, actor):
        return named_person(actor["principal"]) and not actor.get("local_operator") and actor.get("role") in {"admin", "member"}

    def mint_confirm(self, actor, session_hash, program_id, swarm_id, data):
        """The host's confirm token for one act the person just confirmed in its own DecisionDialog (§9d). Same gates
        as the act route; bound to principal, session, program, swarm, action and payload digest; single use, 120 s."""
        hive = self.hive
        if not isinstance(data, dict) or set(data) != {"swarm_id", "action", "payload", "payload_digest"}:
            raise hive.error(400, "bad_request", "confirm takes exactly swarm_id, action, payload and payload_digest")
        action, payload, payload_digest = data["action"], data["payload"], data["payload_digest"]
        if not isinstance(payload_digest, str) or not DIGEST.fullmatch(payload_digest):
            raise hive.error(400, "bad_request", "payload_digest is sha256:<64 lowercase hex>")
        if not isinstance(payload, dict) or not set(payload) <= {"items", "params", "base_revision", "file"}:
            raise hive.error(400, "bad_request", "payload is {items?, params?, base_revision?, file?} exactly as the act will send them")
        # normalized exactly as the act normalizes its body, so a null here digests as the act will
        payload = act_payload(payload.get("items") or [], payload.get("params") or {}, payload.get("base_revision"), payload.get("file"))
        self._confirmable(payload)
        if digest(payload) != payload_digest:   # the host's canonical form disagrees with the hive's: say so now
            raise hive.error(400, "confirm_digest_mismatch", "payload_digest is not the hive's digest of payload (see §9d)")
        from .programs import confirms
        entry = hive.programs._ready(program_id)
        declared = next((a for a in entry["describe"].get("actions", []) if a.get("id") == action), None)
        if declared is None:
            raise hive.error(400, "bad_request", f"{program_id} has no action {action!r}")
        if not confirms(declared):
            raise hive.error(400, "confirm_not_needed", f"{action!r} does not take a host confirm")
        if declared.get("approver") == "person" and not named_person(actor["principal"]):
            raise hive.error(403, "person_required", f"{action!r} needs a named signed-in person, not the local operator password")
        if declared.get("person_activity") is True:
            if not self._activity_person(actor):
                raise hive.error(403, "person_required", "named person required")
            if hive.app_attachments.required(entry) and not hive.app_attachments.active(program_id, swarm_id):
                raise hive.error(403, "app_inactive", "activate the app in this swarm before human participation")
        import secrets, time
        token, expires = "hct_" + secrets.token_urlsafe(32), time.time() + CONFIRM_TTL
        self.db.execute("DELETE FROM confirm_tokens WHERE expires_at < ?", (time.time() - 86400,))   # a done intent's recovery for a day
        self.db.insert("confirm_tokens", {"token_hash": hashlib.sha256(token.encode()).hexdigest(), "principal": actor["principal"],
                                          "session_hash": session_hash, "program": program_id, "swarm_id": swarm_id,
                                          "action": action, "payload_digest": payload_digest, "expires_at": expires, "used_at": None,
                                          "intent": None})
        import datetime
        at = datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"confirm_token": token, "expires_at": at, "expires_in": CONFIRM_TTL}

    def _confirmable(self, payload):
        if not confirmable(payload):
            raise self.hive.error(400, "confirm_unsupported_value", "a confirmed act carries only text, true/false, null, lists, "
                                  "objects and whole numbers up to 2^53-1; no decimals (§9d)")
        if len(canonical(payload).encode()) > CONFIRM_MAX_BYTES:
            raise self.hive.error(413, "confirm_payload_too_large", f"a confirmed act's items and params are limited to "
                                  f"{CONFIRM_MAX_BYTES // 1048576} MB as canonical JSON (§9d)")

    def _take_confirm(self, actor, session_hash, program_id, swarm_id, action, payload, token, intent=None, recovery=False):
        """Spend the act's confirm token. It must match everything it was minted for. Every effectful delivery needs an
        unused, unexpired token, spent by one conditional UPDATE (two racing acts cannot both pass) and bound to the
        intent record it delivers. The one exception is ``recovery``: the hive returning a DONE intent's recorded result
        without delivering anything again may present the token already spent on that same intent (§9d). A failed or
        unknown intent is never re-run under a spent token: that needs a fresh confirm from the person."""
        if token is None:
            raise self.hive.error(403, "confirm_required", f"{action!r} needs the person's confirm in the host first")
        self._confirmable(payload)
        import time
        t = time.time()
        spendable = "(used_at IS NULL AND expires_at > ?)" + (" OR intent = ?" if recovery and intent else "")
        cur = self.db.execute(
            "UPDATE confirm_tokens SET used_at = COALESCE(used_at, ?), intent = COALESCE(intent, ?) WHERE token_hash = ? "
            "AND principal = ? AND session_hash = ? AND program = ? AND swarm_id = ? AND action = ? AND payload_digest = ? "
            f"AND ({spendable})",
            (t, intent, hashlib.sha256(str(token).encode()).hexdigest(), actor["principal"], session_hash or "",
             program_id, swarm_id, action, digest(payload), t, *([intent] if recovery and intent else [])))
        if cur.rowcount != 1:
            raise self.hive.error(403, "confirm_invalid", "that confirm is used, expired or for a different act")

    async def person_act(self, actor, program_id, swarm_id, data, session_hash=None, *,
                         _on_person_swarm_consent_required=None):
        """The operator route: a person acts. Same trusted delivery as minds; the key is optional here."""
        hive = self.hive
        entry = hive.programs._ready(program_id)
        action = str(data.get("action", ""))
        declared = next((a for a in entry["describe"].get("actions", []) if a.get("id") == action), {})
        if declared.get("approver") == "person" and not named_person(actor["principal"]):
            raise hive.error(403, "person_required", f"{action!r} needs a named signed-in person, not the local operator password")
        key = data.get("idempotency_key")
        if key is not None and not (isinstance(key, str) and 1 <= len(key) <= 120):
            raise hive.error(400, "bad_request", "idempotency_key must be 1-120 characters")
        items, params, base_revision = data.get("items") or [], data.get("params") or {}, data.get("base_revision")
        file = self._person_file(actor, program_id, swarm_id, declared, data.get("file"))
        meta = {k: file[k] for k in ("name", "mime", "size", "sha256")} if file else None
        extra = {"file": meta} if meta else {}             # file-less digests are unchanged
        from .programs import confirms
        confirm = (lambda intent=None, recovery=False: self._take_confirm(
                       actor, session_hash, program_id, swarm_id, action, act_payload(items, params, base_revision, meta),
                       data.get("confirm_token"), intent, recovery)) if confirms(declared) else (lambda intent=None, recovery=False: None)
        if confirms(declared):
            self._confirmable(act_payload(items, params, base_revision, meta))   # before anything digests it
        command = {"idempotency_key": key, "record_id": None, "route": "operator", "action": action, "items": items,
                   "params_digest": digest({"action": action, "items": items, "params": params, "base_revision": base_revision, **extra}),
                   "base_revision": base_revision, **({"file": meta} if meta else {})}
        # Proposed opt-in for named-human app actions. Existing app/operator
        # behavior is unchanged. Always deliver exact retries through the app's
        # current scope/membership gate; a historical result grants no access.
        if declared.get("person_activity") is not True:
            confirm()
            return await hive.programs.act(program_id, swarm_id, action, items, params, base_revision, actor=actor, command=command, file=file)
        if not self._activity_person(actor) or key is None:
            raise hive.error(403, "person_required", "named person and stable intent key required")
        if hive.app_attachments.required(entry) and not hive.app_attachments.active(program_id, swarm_id):
            raise hive.error(403, "app_inactive", "activate the app in this swarm before human participation")
        params_digest = digest({"swarm_id": swarm_id, "action": action, "items": items, "params": params, "base_revision": base_revision, **extra})
        prior = self.db.one("SELECT * FROM program_actions WHERE principal=? AND program=? AND idempotency_key=?", (actor["principal"], program_id, key))
        if prior and (prior["params_digest"] != params_digest or json.loads(prior["actor"]).get("kind") != "person"):
            raise hive.error(409, "idempotency_conflict", "this intent belongs to a different person request")
        if prior and prior["status"] == "running":
            raise hive.error(409, "in_progress", "this person request is still running")
        row_id = prior["id"] if prior else new_id("pa")
        # a done intent's recovery delivers nothing and may show the token it spent; any other delivery spends a fresh one
        confirm(row_id, recovery=bool(prior and prior["status"] == "done"))
        if prior and prior["status"] == "done":
            # A completed person request retried with the same intent is a recovery, exactly as for minds: the app
            # rechecks current access and returns the recorded result; it never runs the effect again (found by
            # OmegaDesign: a lost save response retried published a second artifact). The record stays as it was.
            command.update(record_id=prior["id"], params_digest=params_digest, revalidation_supported=True,
                           recorded_result=json.loads(prior["result"]) if prior["result"] else None)
            # a recovery never re-delivers the file: the app sees its name, type, size and digest in the command only
            return await hive.programs.act(program_id, swarm_id, action, items, params, base_revision,
                                           actor=dict(actor, recovery=True), command=command)
        command.update(record_id=row_id, params_digest=params_digest,
                       **({"prior_failed": True} if prior and prior["status"] == "failed" else {}))   # outcome of the last try unknown
        if prior:
            self.db.update("program_actions", row_id, {"status":"running", "finished_at":None})
        else:
            self.db.insert("program_actions", {"id":row_id,"program":program_id,"swarm_id":swarm_id,"principal":actor["principal"],"actor":json.dumps(actor),
                                               "action":action,"items":json.dumps(items),"params_digest":params_digest,"idempotency_key":key,"approval_id":None,
                                               "status":"running","result":None,"created_at":now(),"finished_at":None})
        try:
            notice = ({"_on_person_swarm_consent_required": _on_person_swarm_consent_required}
                      if _on_person_swarm_consent_required is not None else {})
            result = await hive.programs.act(program_id, swarm_id, action, items, params, base_revision,
                                             actor=actor, command=command, file=file, **notice)
        except Exception:
            self.db.update("program_actions", row_id, {"status":"failed","finished_at":now()})
            raise
        old_result = json.loads(prior["result"]) if prior and prior.get("result") else None
        if result.get("status") == "refused" and old_result and old_result.get("receipt", {}).get("state") == "committed":
            # Refused retry cannot erase the historical commit or make it
            # readable via a cache. Return the refusal, preserve its receipt.
            self.db.update("program_actions", row_id, {"status":prior["status"],"finished_at":prior["finished_at"]})
        else:
            self.db.update("program_actions", row_id, {"status":"done","result":json.dumps(self._retained(result, meta)),"finished_at":now()})
        hive.events.publish("program.action", record={"id":row_id,"program":program_id,"swarm_id":swarm_id,"actor":actor["id"],"action":action,"status":result.get("status")})
        return result

    @staticmethod
    def _retained(result, file_meta):
        """What the hive keeps of an app's answer. For an intent that carried a file, metadata only: the status, the
        receipt's state, a digest of the whole answer and the file's name, type, size and digest. The answer itself
        reaches the person but is never stored, so nothing the app echoes from the file is kept, and a recovery gets
        back only this (OmegaReview next9 B2). Answers without a file are kept as before."""
        if not file_meta:
            return result
        receipt = result.get("receipt") if isinstance(result.get("receipt"), dict) else None
        return {"status": result.get("status"), "retained": "metadata-only", "result_digest": digest(result),
                # the receipt's state only: an app-chosen receipt id could carry file content (OmegaReview next10)
                **({"receipt": {"state": receipt.get("state")}} if receipt and receipt.get("state") in RECEIPT_STATES else {}),
                "file": dict(file_meta)}

    async def notify_decision(self, approval):
        """Tell the program a person decided on one of its actions: optional hook on_approval(ctx, event).
        Informational only: the decision itself never runs the action (the mind's exact retry does)."""
        import logging
        try:
            _, program_id, action = str(approval["skill"]).split(":", 2)
            entry = self.hive.programs._ready(program_id)   # integrity gate: a drifted app hears nothing (Kimi next7)
            hook = getattr(entry.get("module"), "on_approval", None)
            if not callable(hook):
                return
            binding = json.loads(approval.get("binding") or "{}")
            from .programs import ProgramContext
            ctx = ProgramContext(self.hive, binding.get("swarm_id", ""), entry)
            declared = next((a for a in entry["describe"].get("actions", []) if a.get("id") == action), {})
            ctx.read_only = declared.get("effect") == "read"   # a read action's hook writes nothing either (r15)
            event = {"type": "approval.decided", "approval_id": approval["id"], "action": action,
                     "decision": approval["status"], "decided_by": approval.get("decided_by"),
                     "decided_by_named_person": named_person(approval.get("decided_by")), "decided_at": approval.get("decided_at"),
                     "mind_id": approval["agent_id"], "binding_digest": digest(binding) if binding else None,
                     "idempotency_key": binding.get("idempotency_key")}
            out = hook(ctx, event)
            if hasattr(out, "__await__"):
                await out
        except Exception:  # a program's hook must never break the approval itself
            logging.getLogger("hive").exception("on_approval hook failed for %s", approval.get("id"))

    def activity(self, swarm_id=None, program=None, limit=100):
        sql, args = "SELECT id, program, swarm_id, principal, action, items, status, approval_id, created_at, finished_at FROM program_actions WHERE 1=1", []
        if swarm_id:
            sql += " AND swarm_id = ?"; args.append(swarm_id)
        if program:
            sql += " AND program = ?"; args.append(program)
        rows = self.db.all(sql + " ORDER BY created_at DESC LIMIT ?", (*args, min(int(limit), 500)))
        return [dict(r, items=json.loads(r["items"])) for r in rows]
