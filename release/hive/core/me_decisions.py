"""P4b: bounded, current-authority person reads. No reader grants or repairs authority."""

from __future__ import annotations

import base64
import binascii
import datetime
import fnmatch
import hashlib
import json
import math
import os
import pathlib
import re
import sqlite3
import stat
import time
import types
from dataclasses import dataclass

from .db import now
from .policy import HIGH_RISK


CATEGORIES = ("approvals", "limit_requests", "own_requests", "ask_intents", "studio_sessions")
DEFAULT_LIMIT, MAX_LIMIT, SCAN_LIMIT = 25, 50, 500
CURSOR_BYTES, DECISIONS_BYTES, STUDIO_BYTES = 512, 1024 * 1024, 256 * 1024
SOURCE_JSON_BYTES = 32768
STUDIO_STATES = frozenset(("active", "paused", "stopping", "stopped", "held"))
INTENT_STATES = frozenset(("pending", "refused", "dispatching"))
PERSON = re.compile(r"user:u_[A-Za-z0-9_-]{1,40}\Z")
from .keyids import STORED as STORED_KEY
KEY = re.compile(STORED_KEY + r"\Z")   # keyids: the one grammar (a stored key)


@dataclass(frozen=True)
class Person:
    viewer: object
    named: bool

    @property
    def principal(self):
        return self.viewer.principal

    @property
    def admin(self):
        return self.viewer.admin


def human_session(hive, session, role):
    """Positive P4b personhood; never manufacture it from Viewer's fallback principal."""
    def refused():
        raise hive.error(401, "unauthorized", "a current signed-in person is required")

    if not isinstance(session, dict) or session.get("kind") not in ("password", "sso", "member_password"):
        refused()
    expires = session.get("expires_at")
    if expires is not None and (type(expires) not in (int, float) or not math.isfinite(expires) or expires <= time.time()):
        refused()
    role = role() if callable(role) else role  # trusted host callback, evaluated only after kind/expiry validation
    principal = session.get("principal")
    if session["kind"] == "password":
        if principal not in (None, "", "user:operator") or role != "admin":
            refused()
        return False                  # genuinely migrated password rows may lack a principal/expiry
    if (not isinstance(principal, str) or not principal.startswith("user:") or principal == "user:operator"
            or len(principal) > 128 or any(ord(c) < 32 or ord(c) == 127 for c in principal)
            or role not in ("admin", "member") or expires is None):
        refused()
    if session["kind"] == "member_password" and (not principal.startswith("user:u_") or role != "member"):
        refused()
    if principal.startswith("user:u_"):
        if PERSON.fullmatch(principal) is None:
            refused()
        row = hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        if row is None or row["disabled"]:
            refused()
        if session["kind"] == "member_password":
            if row["role"] not in ("admin", "member"):
                refused()
        elif row["role"] != role:
            refused()
    # The app adapter's existing role_of has checked the current family allowlist for a family SSO identity.
    return True


def _object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate field")
        out[key] = value
    return out


class MeDecisions:
    def __init__(self, hive, authenticate):
        self.hive, self.db, self.authenticate = hive, hive.db, authenticate
        self.person = None
        self.identity = None
        self.emitted = []
        self.program_cache = {}
        self.program_read_bytes = {}
        self.final_programs = set()
        self.finalizing = False
        self.fs_bytes = self.fs_entries = self.fs_stats = 0
        self.visibility_reads = 0

    def _error(self, status, code, message):
        return self.hive.error(status, code, message)

    def _current(self):
        person = self.authenticate()
        identity = (person.principal, person.admin, person.named)
        if self.identity is not None and identity != self.identity:
            raise self._error(401, "unauthorized", "the signed-in authority changed; restart this read")
        self.person, self.identity = person, identity
        return person

    def _bad(self):
        return self._error(400, "bad_request", "invalid person-read query or cursor")

    def _invalid(self):
        return self._error(409, "read_unavailable", "a current record cannot be projected safely")

    def _text(self, value, maximum=128):
        if (not isinstance(value, str) or not 1 <= len(value) <= maximum
                or any(ord(c) < 32 or ord(c) == 127 for c in value)):
            raise self._invalid()
        try:
            value.encode("utf-8")
        except UnicodeError:
            raise self._invalid() from None
        return value

    def _stamp(self, value):
        value = self._text(value, 64)
        try:
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("naive date")
        except ValueError:
            raise self._invalid() from None
        return value

    def _json(self, value):
        if not isinstance(value, str) or len(value.encode("utf-8")) > SOURCE_JSON_BYTES:
            raise self._invalid()
        try:
            decoded = json.loads(value, object_pairs_hook=_object)
        except (ValueError, TypeError):
            raise self._invalid() from None
        if not isinstance(decoded, dict):
            raise self._invalid()
        return decoded

    @staticmethod
    def _encoded(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

    def _queries(self, pairs, studio):
        self._current()             # even an empty store or malformed query needs a real person first
        try:
            data = _object(pairs)
        except (ValueError, TypeError):
            raise self._bad() from None
        # token is an existing operator transport, not a cursor/authority selector. It was authenticated already.
        allowed = {"limit", "token", "cursor"} if studio else {"limit", "token", *(c + "_cursor" for c in CATEGORIES)}
        if set(data) - allowed:
            raise self._bad()
        raw = data.get("limit", str(DEFAULT_LIMIT))
        if not isinstance(raw, str) or len(raw) > 2 or re.fullmatch(r"[1-9][0-9]?", raw) is None or not 1 <= int(raw) <= MAX_LIMIT:
            raise self._bad()
        return int(raw), data

    def _cursor(self, value, category):
        if value is None:
            return None
        if not isinstance(value, str) or not 1 <= len(value.encode("utf-8")) <= CURSOR_BYTES:
            raise self._bad()
        try:
            if re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
                raise ValueError("alphabet")
            raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
            decoded = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
            if (not isinstance(decoded, dict) or set(decoded) != {"v", "category", "created_at", "id"}
                    or type(decoded["v"]) is not int or decoded["v"] != 1 or decoded["category"] != category):
                raise ValueError("shape")
            if (not isinstance(decoded["id"], str) or not 1 <= len(decoded["id"]) <= 128
                    or any(ord(c) < 32 or ord(c) == 127 for c in decoded["id"])
                    or not isinstance(decoded["created_at"], str) or not 1 <= len(decoded["created_at"]) <= 64):
                raise ValueError("values")
            stamp = datetime.datetime.fromisoformat(decoded["created_at"].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise ValueError("naive cursor")
        except (ValueError, TypeError, UnicodeError, binascii.Error):
            raise self._bad() from None
        return decoded

    def _next(self, category, item):
        value = {"v": 1, "category": category, "created_at": item["created_at"], "id": item["id"]}
        encoded = base64.urlsafe_b64encode(self._encoded(value)).decode("ascii").rstrip("=")
        if len(encoded.encode("utf-8")) > CURSOR_BYTES:
            raise self._invalid()
        return encoded

    def _source(self, category):
        me = self.person.principal
        # All SQL identifiers and ordering are fixed here, never cursor- or caller-supplied.
        if category == "approvals":
            return ("approvals", "status = 'pending'", (),
                    "id,agent_id,skill,risk,status,created_at,CASE WHEN length(CAST(binding AS BLOB)) <= 32768 THEN binding ELSE NULL END AS binding")
        if category == "limit_requests":
            return "limit_requests", "owner = ? AND status = 'pending'", (me,), "id,requested_by,owner,key_id,agent_id,status,created_at"
        if category == "own_requests":
            return ("person_requests", "requested_by = ?", (me,),
                    "id,kind,requested_by,status,created_at,CASE WHEN length(CAST(payload AS BLOB)) <= 32768 THEN payload ELSE NULL END AS payload")
        if category == "ask_intents":
            return ("ask_intents", "principal = ? AND deleted_at IS NULL", (me,),
                    "id,principal,turn_id,kind,state,created_at,updated_at,expires_at,request_operation_id,request_digest,deleted_at")
        if category == "studio_sessions":
            return "studio_sessions", "principal = ?", (me,), "id,principal,swarm_id,state,created_at,updated_at"
        raise self._bad()

    def _rows(self, category, cursor=None, item_id=None):
        table, where, args, columns = self._source(category)
        if item_id is not None:
            return self.db.one(f"SELECT {columns} FROM {table} WHERE ({where}) AND id = ?", (*args, item_id))
        if cursor is not None:
            where += " AND (created_at < ? OR (created_at = ? AND id < ?))"
            args = (*args, cursor["created_at"], cursor["created_at"], cursor["id"])
        return self.db.all(f"SELECT {columns} FROM {table} WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ?", (*args, SCAN_LIMIT))

    def _page(self, category, limit, raw_cursor):
        self._current()
        if category in ("ask_intents", "studio_sessions") and not self.person.named:
            if raw_cursor is not None:
                raise self._error(409, "cursor_stale", "restart this category from its current authorized beginning")
            return {"items": [], "next_cursor": None}
        cursor = self._cursor(raw_cursor, category)
        if cursor is not None:
            anchor = self._project(category, cursor["id"])
            if anchor is None or anchor["created_at"] != cursor["created_at"]:
                raise self._error(409, "cursor_stale", "restart this category from its current authorized beginning")
        candidates = self._rows(category, cursor)
        accepted = []
        for row in candidates:
            item = self._project(category, row["id"])
            if item is None:
                continue
            if item["created_at"] != row["created_at"]:
                raise self._error(409, "read_changed", "the ordered record changed; restart the read")
            accepted.append(item)
            if len(accepted) == limit + 1:
                break
        more = len(accepted) > limit
        if not more and len(candidates) == SCAN_LIMIT:
            raise self._error(503, "read_scan_bound", "the bounded read cannot establish a complete page; restart later")
        items = accepted[:limit]
        for item in items:
            self.emitted.append((category, item))
        return {"items": items, "next_cursor": self._next(category, items[-1]) if more else None}

    def _finish(self, answer, maximum):
        # No DB transaction or mind mutex is held while current authorizers run.
        self.finalizing = True
        for category, item in self.emitted:
            if self._project(category, item["id"]) != item:
                raise self._error(409, "read_changed", "current eligibility changed; restart the read")
        self._current()
        if len(self._encoded(answer)) > maximum:
            raise self._error(503, "read_response_bound", "the bounded read cannot return this response")
        return answer

    def decisions(self, query_pairs):
        limit, data = self._queries(query_pairs, False)
        pages = {c: self._page(c, limit, data.get(c + "_cursor")) for c in CATEGORIES}
        return self._finish({"schema": "hive.me-decisions/1", "categories": pages}, DECISIONS_BYTES)

    def studio_sessions(self, query_pairs):
        limit, data = self._queries(query_pairs, True)
        page = self._page("studio_sessions", limit, data.get("cursor"))
        return self._finish({"schema": "hive.me-studio-sessions/1", **page}, STUDIO_BYTES)

    def _project(self, category, item_id):
        self._current()
        row = self._rows(category, item_id=item_id)
        if row is None:
            return None
        projected = getattr(self, "_" + category)(row)
        if projected is not None:
            self._text(projected["id"])
            self._stamp(projected["created_at"])
        return projected

    def _visibility_one(self, sql, args):
        self.visibility_reads += 1
        if self.visibility_reads > 16384:
            raise self._unknown()
        try:
            return self.db.one(sql, args)
        except sqlite3.Error:
            raise self._unknown() from None

    def _targets(self, value, extra):
        """The inherited id scan, bounded before extraction; no global personal-id inventory or hidden cache."""
        targets, nodes = set(), [0]

        def charge():
            nodes[0] += 1
            if nodes[0] > 512:
                raise self._unknown()

        def add(table, identifier):
            identifier = self._text(identifier)
            targets.add((table, identifier))
            if len(targets) > 64:
                raise self._unknown()

        def named(obj, depth=0):
            charge()
            if not isinstance(obj, dict):
                return
            if depth > 3:
                raise self._unknown()
            if len(obj) > 64:
                raise self._unknown()
            for key, val in obj.items():
                charge()
                if key in ("agent_id", "mind_id", "mind", "about") and isinstance(val, str) and val.startswith("a_"):
                    add("agents", val)
                elif key in ("swarm_id", "from_swarm", "to_swarm") and isinstance(val, str) and val:
                    add("swarms", val)
                elif key == "room_id" and isinstance(val, str):
                    add("rooms", val)
                elif key == "conversation_id" and isinstance(val, str):
                    if val.startswith("r_"):
                        add("rooms", val)
                    elif val.startswith("team_"):
                        self.visibility_reads += 1
                        if self.visibility_reads > 16384:
                            raise self._unknown()
                        try:
                            rooms = self.db.all("SELECT id FROM rooms WHERE alias = ? LIMIT 2", (self._text(val),))
                        except sqlite3.Error:
                            raise self._unknown() from None
                        if len(rooms) > 1:
                            raise self._unknown()
                        add("rooms", rooms[0]["id"] if rooms else "r_unknown")
                    elif val.startswith("ask:"):
                        # Metadata-only equivalent of reviewed Ask.room_for, with each lookup charged; no
                        # whole Ask row/text, expiry, maintenance or cross-person payload is read here.
                        ask = getattr(self.hive, "ask", None)
                        turn = self._visibility_one("SELECT thread_id FROM ask_turns WHERE id = ?", (self._text(val)[4:],)) if ask is not None else None
                        thread = self._visibility_one("SELECT room_id FROM work_sessions WHERE id = ?", (turn["thread_id"],)) if turn else None
                        room = thread["room_id"] if thread else None
                        add("rooms", room or "r_unknown")
                elif key == "id" and isinstance(val, str) and val.startswith("a_"):
                    add("agents", val)
                elif key == "id" and isinstance(val, str) and val.startswith("s_"):
                    add("swarms", val)
                elif isinstance(val, dict):
                    named(val, depth + 1)

        def additional(obj, depth=0):
            charge()
            if not isinstance(obj, dict):
                return
            if depth > 3:
                raise self._unknown()
            if len(obj) > 64:
                raise self._unknown()
            for key, val in obj.items():
                charge()
                if key == "owner_swarm" and isinstance(val, str):
                    add("swarms", val)
                elif key == "owners" and isinstance(val, list):
                    if len(val) > 200:
                        raise self._unknown()
                    for identifier in val:
                        if isinstance(identifier, str):
                            add("swarms", identifier)
                elif key in ("created_by", "by") and isinstance(val, str) and val.startswith("agent:a_"):
                    add("agents", val[6:])
                elif isinstance(val, dict):
                    additional(val, depth + 1)
                elif isinstance(val, list):
                    if len(val) > 200:
                        raise self._unknown()
                    for item in val:
                        additional(item, depth + 1)

        named(value)
        if extra:
            additional(value)
        return targets

    def _visible(self, value, viewer=None, personal_only=False):
        viewer = self.person.viewer if viewer is None else viewer
        if personal_only and (not viewer.admin or getattr(viewer, "audit", False)):
            return True                  # inherited member informational own-request behavior
        from .visibility import Viewer
        member = Viewer(viewer.principal, False)
        targets = self._targets(value, bool(viewer.admin))
        for table, identifier in sorted(targets):
            if table == "rooms":
                room = self._visibility_one("SELECT swarm_id FROM rooms WHERE id = ?", (identifier,))
                if not viewer.admin and not personal_only:
                    # Current P4b authority projectors name agents/swarms, never room membership. Do not replace
                    # an unknown room authorizer with guessed access if this internal contract later expands.
                    raise self._unknown()
                if room is None or not room.get("swarm_id"):
                    continue
                table, identifier = "swarms", self._text(room["swarm_id"])
            # table is the fixed two-value set produced above, never a caller-controlled SQL identifier.
            row = self._visibility_one(f"SELECT id,owner,visibility,shared_with,personal_of FROM {table} WHERE id = ?", (identifier,))
            if viewer.admin:
                if (not getattr(viewer, "audit", False) and row is not None and row.get("personal_of") is not None
                        and row["personal_of"] != viewer.principal and not member.sees(row)):
                    return False
            elif row is None or not viewer.sees(row):
                return False
        return True

    def _agent(self, agent_id):
        row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if row is None or not self._visible({"agent_id": agent_id}):
            return None
        _binding, valid = self._binding_for(row)
        return row if valid else None

    def _binding_for(self, agent):
        # PersonSwarms.current is not transitively read-pure: template() calls Programs._ready. Mirror its
        # recorded template/consent/oldest-provider-key/month-total/finished/owner/options predicates here.
        bindings = self.db.all("SELECT * FROM app_person_minds WHERE agent_id = ? LIMIT 2", (agent["id"],))
        if not bindings:
            return None, True
        binding = bindings[0]
        if len(bindings) != 1:
            return binding, False
        if not self._person_exists(binding["principal"]) or agent.get("owner") != binding["principal"] or not binding["finished"]:
            return binding, False
        program = binding["program_id"]
        entry = self.hive.programs.programs.get(program)
        if entry is None:
            return binding, False
        if not isinstance(entry, dict):
            raise self._unknown()
        if entry.get("error") or program in self.hive.programs.disabled or "person_swarm" not in entry.get("capabilities", []):
            return binding, False
        templates = entry.get("swarm_templates")
        if not isinstance(templates, dict):
            raise self._unknown()
        template = templates.get(binding["template_id"])
        if template is None:
            return binding, False
        if not isinstance(template, dict) or not isinstance(template.get("minds"), list) or not 1 <= len(template["minds"]) <= 64:
            raise self._unknown()
        authority = self.db.one("SELECT * FROM app_authority WHERE program = ?", (program,))
        if authority and (authority["grants_revoked"] or authority["disabled"]):
            return binding, False
        if not self._program_integrity(entry, agent["swarm_id"], authority):
            return binding, False
        digest = self._text(template.get("digest"))
        consent = self.db.one("SELECT * FROM app_person_consents WHERE principal = ? AND program_id = ? AND template_id = ?",
                              (binding["principal"], program, binding["template_id"]))
        if consent is None or consent["withdrawn_at"] or consent["template_digest"] != digest or binding["template_digest"] != digest:
            return binding, False
        providers = set()
        for mind in template["minds"]:
            if not isinstance(mind, dict) or not isinstance(mind.get("model"), str) or not mind["model"].partition("/")[0]:
                raise self._unknown()
            providers.add(mind["model"].partition("/")[0])
        if len(providers) != 1:
            return binding, False
        keys = ((self.hive.keyring.ring.get("keys") if getattr(self.hive, "keyring", None) else None) or {})
        if not isinstance(keys, dict) or len(keys) > SCAN_LIMIT:
            raise self._unknown()
        own = []
        for value in keys.values():
            if not isinstance(value, dict):
                raise self._unknown()
            if value.get("owner") == binding["principal"] and value.get("provider") in providers:
                created = value.get("created_at") or 0
                if type(created) not in (int, float) or not math.isfinite(created):
                    raise self._unknown()
                own.append(value)
        own.sort(key=lambda value: value.get("created_at") or 0)  # stable, exactly the inherited first-key rule
        if not own or own[0].get("id") != consent["key_id"]:
            return binding, False
        monthly = self.db.one("SELECT month_usd FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                              "AND revoked_at IS NULL", (binding["principal"],))
        if monthly is not None and (type(monthly["month_usd"]) not in (int, float) or not math.isfinite(monthly["month_usd"])):
            raise self._unknown()
        total = float(monthly["month_usd"]) if monthly else None
        if total != consent["month_usd"]:
            return binding, False
        options = self._json(agent.get("options") or "{}")
        if options.get("key_locked") is not True or options.get("key") != consent["key_id"]:
            return binding, False
        return binding, True

    def _stored_owner(self):
        row = self.db.one("SELECT owner FROM hive_owner WHERE id = 1")
        return row["owner"] if row else None        # do not call OwnHive.owner -> ensure_owner

    def _person_exists(self, principal):
        if not isinstance(principal, str) or PERSON.fullmatch(principal) is None:
            return False
        row = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        return bool(row and not row["disabled"] and row["role"] in ("admin", "member"))

    def _key_authority(self, key_id):
        """(addressed current owner, named-key owner for payer_for), with positive existence first."""
        if not isinstance(key_id, str):
            raise self._invalid()
        if key_id.startswith("env:"):
            provider = key_id[4:]
            if re.fullmatch(r"[a-z0-9_-]+", provider) is None:
                raise self._invalid()
            if provider not in (getattr(self.hive.settings, "providers", None) or {}):
                return None
            owner = self._stored_owner()
            if owner is None:
                raise self._invalid()
            return owner, None
        if KEY.fullmatch(key_id) is None:
            raise self._invalid()
        keyring = getattr(self.hive, "keyring", None)
        record = ((keyring.ring.get("keys") if keyring else None) or {}).get(key_id)
        if record is None:
            return None
        if not isinstance(record, dict):
            raise self._invalid()
        if record.get("id", key_id) != key_id:
            raise self._invalid()
        owner = record.get("owner")
        if isinstance(owner, str) and PERSON.fullmatch(owner):
            return (owner, owner) if self._person_exists(owner) else None
        if owner not in (None, "", "hive", "user:operator"):
            raise self._invalid()
        owner = self._stored_owner()
        if owner is None:
            raise self._invalid()
        return owner, None

    def _payer(self, user, named_key_owner):
        # Read-only equivalent of the accepted payer_for decision, without access()->owner()->migration.
        if not named_key_owner:
            return user
        if user == named_key_owner or not isinstance(user, str) or not user.startswith("user:u_"):
            return named_key_owner
        person = self.db.one("SELECT access, disabled FROM people WHERE id = ?", (user[5:],))
        if person is None or person["disabled"]:
            return None
        access = "owner" if user == self._stored_owner() else person.get("access") or "legacy"
        if access not in ("owner", "legacy", "guest", "public"):
            raise self._unknown()
        granted = self.db.one("SELECT id FROM key_limits WHERE grantee = ? AND owner = ? AND revoked_at IS NULL "
                              "AND (ends_at IS NULL OR ends_at > ?) LIMIT 1",
                              (user, named_key_owner, now()))
        return user if access in ("guest", "public") or granted else named_key_owner

    def _ceiling(self, agent_id, skill):
        rules = self.db.all("SELECT CASE WHEN length(skill) <= 128 THEN skill ELSE NULL END AS skill, mode "
                            "FROM app_template_rules WHERE agent_id = ? LIMIT ?", (agent_id, SCAN_LIMIT))
        if len(rules) == SCAN_LIMIT:
            raise self._error(503, "read_scan_bound", "template rule inspection exceeded the bounded read")
        modes = set()
        for rule in rules:
            if not isinstance(rule["skill"], str) or rule["mode"] not in ("ask", "deny"):
                raise self._invalid()
            if fnmatch.fnmatchcase(skill, rule["skill"]):
                modes.add(rule["mode"])
        return "deny" if "deny" in modes else "ask" if "ask" in modes else None

    def _approvals(self, row):
        agent = self._agent(row["agent_id"])
        if agent is None:
            return None
        options = self._json(agent.get("options") or "{}")
        if options.get("approvals") not in (None, "owner_only"):
            return None   # Invalid stored policy is not advertised as actionable.
        if options.get("approvals") == "owner_only" and agent.get("owner") != self.person.principal:
            return None   # Audit stays readable through ordinary reads, not this person's actionable decisions.
        skill = self._text(row["skill"])
        if row["risk"] not in ("medium", "high"):
            raise self._invalid()
        cap = self._ceiling(agent["id"], skill)
        if cap == "deny":
            return None
        exact = skill.startswith("program:")
        once = True
        if exact:
            program_answers = self._program_approval(row, agent)
            if not program_answers:
                return None
            once = program_answers["once"]
        durable = (self.person.admin or agent.get("owner") == self.person.principal
                   or self._stored_owner() == self.person.principal)
        positive = bool(durable and not exact and row["risk"] != "high" and skill not in HIGH_RISK and cap is None)
        return {"kind": "approval", "id": row["id"], "agent_id": self._text(row["agent_id"]), "skill": skill,
                "risk": row["risk"], "state": "pending", "created_at": row["created_at"],
                "answers": {"once": once, "for": positive, "always": positive, "no": True, "never": bool(durable and not exact)}}

    def _own_requests(self, row):
        if row["kind"] not in ("mind", "allowance", "swarm_access") or row["status"] not in ("pending", "granted", "declined"):
            raise self._invalid()
        payload = self._json(row["payload"])
        # Explicit ownership was already applied in SQL; retain the underlying request's scope visibility.
        if not self._visible({"payload": payload}, personal_only=True):
            return None
        return {"kind": "own_request", "id": row["id"], "request_kind": row["kind"], "state": row["status"], "created_at": row["created_at"]}

    def _ask_intents(self, row):
        if not self.person.named:
            return None
        if row["state"] in ("linked", "abandoned"):
            return None
        if row["kind"] not in ("code.request", "studio.session", "code.test") or row["state"] not in INTENT_STATES:
            raise self._invalid()
        if row["kind"] == "code.request" and not self.person.admin:
            return None
        turn = self.db.one("SELECT principal, deleted_at FROM ask_turns WHERE id = ?", (row["turn_id"],))
        if turn is None or turn["principal"] != self.person.principal or turn["deleted_at"]:
            return None
        self.hive.ask.intents._audit(row)       # integrity mismatch remains its existing409; it never changes state
        if row["state"] != "dispatching":
            expiry = datetime.datetime.fromisoformat(self._stamp(row["expires_at"]).replace("Z", "+00:00"))
            if expiry <= datetime.datetime.now(datetime.timezone.utc):
                return None
        return {"kind": "ask_intent", "id": row["id"], "intent_kind": row["kind"], "state": row["state"],
                "created_at": row["created_at"], "updated_at": self._stamp(row["updated_at"])}

    def _studio_sessions(self, row):
        if not self.person.named:
            return None
        if row["state"] not in STUDIO_STATES:
            raise self._invalid()
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (row["swarm_id"],))
        if swarm is None or not self.person.viewer.sees(swarm) or not self._visible({"swarm_id": row["swarm_id"]}):
            return None
        return {"kind": "studio_session", "id": row["id"], "state": row["state"], "created_at": row["created_at"],
                "updated_at": self._stamp(row["updated_at"])}

    def _program_approval(self, row, agent):
        parts = row["skill"].split(":")
        if len(parts) != 3 or any(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", p) is None for p in parts[1:]):
            raise self._invalid()
        _, program, action = parts
        binding = self._json(row["binding"] or "{}")
        if (binding.get("program") != program or binding.get("action") != action
                or binding.get("actor") != agent["id"] or binding.get("principal") != "agent:" + agent["id"]
                or binding.get("swarm_id") != agent.get("swarm_id")):
            return False
        current, valid = self._binding_for(agent)
        if current is not None:
            if not valid or current["template_digest"] != binding.get("person_template_digest"):
                return False
        elif binding.get("person_template_digest") is not None:
            return False
        programs = self.hive.programs
        entry = programs.programs.get(program)
        if entry is None:
            return False
        if not isinstance(entry, dict) or entry.get("id") != program or type(entry.get("module")) is not types.ModuleType:
            raise self._unknown()
        if entry.get("error") or program in programs.disabled:
            return False
        describe = entry.get("describe")
        actions = describe.get("actions") if isinstance(describe, dict) else None
        if not isinstance(actions, list) or len(actions) > 128 or not all(isinstance(a, dict) for a in actions):
            raise self._unknown()
        declared = [a for a in actions if a.get("id") == action]
        if len(declared) != 1 or declared[0].get("agents") is not True:
            return False
        authority = self.db.one("SELECT * FROM app_authority WHERE program = ?", (program,))
        if authority and (authority["grants_revoked"] or authority["disabled"]):
            return False
        if not self._program_integrity(entry, agent["swarm_id"], authority):
            return False
        required = callable(vars(entry["module"]).get("bind")) or bool(self.db.one("SELECT 1 FROM app_activations WHERE program = ?", (program,)))
        if required and not self._attachment_current(program, action, agent, binding):
            return False
        if not required and binding.get("attachment_id") is not None:
            return False
        return {"once": bool(self.person.named or declared[0].get("approver") != "person")}

    def _unknown(self):
        return self._error(503, "authority_unavailable", "current authority cannot be established within this bounded read")

    def _attachment_current(self, program, action, agent, binding):
        row = self.db.one("SELECT * FROM app_attachments WHERE program = ? AND mind = ? AND status = 'active'", (program, agent["id"]))
        if row is None or row["swarm"] != agent["swarm_id"] or row["id"] != binding.get("attachment_id"):
            return False
        if not self._attachment_active(program, agent["swarm_id"]):
            return False
        if row["expires"]:
            if datetime.datetime.fromisoformat(self._stamp(row["expires"]).replace("Z", "+00:00")) <= datetime.datetime.now(datetime.timezone.utc):
                return False
        scope = self._json(row["scope"])
        if not isinstance(scope.get("actions"), list) or action not in scope["actions"]:
            return False
        current_binding = self._json(row["binding"]) if row.get("binding") else None
        if current_binding != binding.get("attachment_binding"):
            return False
        skill = "program:" + program + ":" + action
        own = self.db.all("SELECT mode FROM policy_rules WHERE note = ? AND skill = ? LIMIT 2", ("attachment:" + row["id"], skill))
        if len(own) != 1 or own[0]["mode"] not in ("allow", "ask", "deny"):
            return False
        rules = self.db.all("SELECT scope,skill,mode,note FROM policy_rules WHERE scope IN (?,?,?) AND skill LIKE 'program:%' "
                            "AND (expires_at IS NULL OR expires_at > ?) LIMIT ?",
                            ("agent:" + agent["id"], "swarm:" + agent["swarm_id"], "hive", time.time(), SCAN_LIMIT))
        if len(rules) == SCAN_LIMIT:
            raise self._unknown()
        modes = {r["mode"] for r in rules if not (r.get("note") or "").startswith("attachment:") and fnmatch.fnmatchcase(skill, r["skill"])}
        if modes - {"allow", "ask", "deny"}:
            raise self._invalid()
        mode = "deny" if "deny" in modes else "ask" if "ask" in modes else own[0]["mode"]
        return mode != "deny"

    def _attachment_active(self, program, swarm_id):
        row = self.db.one("SELECT active FROM app_activations WHERE program = ? AND swarm = ?", (program, swarm_id))
        if row is not None:
            if row["active"] not in (0, 1):
                raise self._invalid()
            return bool(row["active"])
        # Same positive host-Studio predicate as host_studio_active, without its catch-all conversion of an
        # unknown read failure to an ordinary denial. These host helpers only read existing configuration/state.
        from .studio_makers import PURPOSE, program_setting
        makers = getattr(self.hive, "studio_makers", None)
        if makers is None or not makers.enabled() or program != program_setting():
            return False
        binding = self.db.one("SELECT principal, agent_id FROM person_minds WHERE swarm_id = ? AND purpose = ? "
                              "AND agent_id IS NOT NULL", (swarm_id, PURPOSE))
        if binding is None:
            return False
        home = self.db.one("SELECT owner FROM swarms WHERE id = ? AND archived_at IS NULL", (swarm_id,))
        if home is None or home["owner"] != binding["principal"]:
            return False
        attachment = self.db.one("SELECT by_person,expires FROM app_attachments WHERE program = ? AND swarm = ? "
                                 "AND mind = ? AND status = 'active' AND request_key = ?",
                                 (program, swarm_id, binding["agent_id"], self.hive.app_attachments.host_key(binding["agent_id"])))
        if attachment is None or attachment["by_person"] != binding["principal"]:
            return False
        return not attachment["expires"] or datetime.datetime.fromisoformat(
            self._stamp(attachment["expires"]).replace("Z", "+00:00")) > datetime.datetime.now(datetime.timezone.utc)

    def _program_integrity(self, entry, swarm_id, authority):
        program = entry["id"]
        pins = self.hive.programs.pins
        if not isinstance(pins, dict):
            raise self._unknown()
        declared_pin = program in pins
        pin = pins[program] if declared_pin else None
        if declared_pin and not isinstance(pin, dict):
            raise self._unknown()
        raw_config = os.environ.get("HIVE_APP_GRANT_RENEWAL") or "{}"
        if len(raw_config.encode()) > 65536:
            raise self._unknown()
        try:
            configs = json.loads(raw_config, object_pairs_hook=_object)
        except ValueError:
            raise self._unknown() from None
        if not isinstance(configs, dict):
            raise self._unknown()
        config = configs.get(program)
        if config is not None and not isinstance(config, dict):
            raise self._unknown()
        if authority and authority.get("restored_at") and (
                not authority.get("restore_applied_at") or authority["restore_applied_at"] < authority["restored_at"]):
            return False
        if authority and authority.get("grant_vars"):
            try:
                names_at_start = json.loads(authority["grant_vars"])
            except ValueError:
                raise self._unknown() from None
            names_now = config.get("vars") if isinstance(config, dict) else None
            if (not isinstance(names_at_start, list) or not all(isinstance(n, str) for n in names_at_start)
                    or not isinstance(names_now, list) or not all(isinstance(n, str) for n in names_now)
                    or sorted(names_at_start) != sorted(names_now)):
                raise self._unknown()
        # Cached bytes never establish a new authority: mutable registry/env and filesystem identities are checked
        # again on every use, and final emission performs one additional full source-hash pass per pinned program.
        try:
            semantic = self._encoded({"pin": pin, "config": config, "path": str(entry.get("path") or ""), "digest": entry.get("digest")})
        except (TypeError, ValueError, UnicodeError):
            raise self._unknown() from None
        if len(semantic) > 65536:
            raise self._unknown()
        cached = self.program_cache.get(program)
        fresh = cached is None or cached[0] != semantic or (self.finalizing and program not in self.final_programs)
        if declared_pin:
            environment = pin.get("env", {}) if isinstance(pin, dict) else None
            if (not isinstance(environment, dict) or len(environment) > 128
                    or any(not isinstance(name, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name) is None
                           or not isinstance(expected, str) or not expected
                           for name, expected in environment.items())):
                raise self._unknown()
            if any(os.environ.get(name) != expected for name, expected in environment.items()):
                raise self._error(409, "app_integrity", "an app is no longer its pinned release")
            if fresh:
                snapshot = self._check_pin(entry, pin)
                self.program_cache[program] = (semantic, snapshot)
                if self.finalizing:
                    self.final_programs.add(program)
            else:
                try:
                    self._check_snapshot(pathlib.Path(str(entry["path"])), cached[1])
                except (OSError, UnicodeError, ValueError):
                    raise self._unknown() from None
        if config is not None and not self._grants_current(entry, swarm_id, config, authority):
            return False
        return True

    def _grants_current(self, entry, swarm_id, config, authority):
        owner, names, release, digest = (config.get(k) for k in ("owner", "vars", "release", "digest"))
        if (authority is None or authority.get("owner") != owner or authority["grants_revoked"]
                or not isinstance(owner, str) or not isinstance(names, list) or not 1 <= len(names) <= 32
                or not all(isinstance(n, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", n) for n in names)
                or len(set(names)) != len(names) or not isinstance(release, str) or not release
                or not isinstance(digest, str) or not digest or not isinstance(config.get("swarms"), list)):
            raise self._unknown()
        if not self._person_exists(owner) and not (owner == self.person.principal and self.person.named):
            return False
        if not str(entry.get("path") or "").startswith(release.rstrip("/") + "/") or entry.get("digest") != digest:
            return False
        if swarm_id not in config["swarms"]:
            return False
        fields, scope = config.get("fields"), config.get("scope")
        if (not isinstance(fields, dict) or set(fields) != set(names) or not isinstance(scope, dict) or not scope
                or not all(isinstance(v, str) and v for v in scope.values())):
            raise self._unknown()
        total = 0
        for name in names:
            raw = os.environ.get(name)
            if not raw:
                return False
            total += len(raw.encode())
            if len(raw.encode()) > SOURCE_JSON_BYTES or total > 262144:
                raise self._unknown()
            try:
                value = json.loads(raw, object_pairs_hook=_object)
            except ValueError:
                raise self._unknown() from None
            items = value if isinstance(value, list) else [value]
            keys = fields[name]
            if not isinstance(keys, list) or "expires_at" not in keys or not all(isinstance(k, str) for k in keys):
                raise self._unknown()
            if not items or len(items) > 128:
                raise self._unknown()
            for item in items:
                if not isinstance(item, dict) or set(item) != set(keys):
                    raise self._unknown()
                expiry = item.get("expires_at")
                if type(expiry) not in (int, float) or not math.isfinite(expiry):
                    raise self._unknown()
                if expiry <= time.time() or ("operations" in item and item["operations"] != ["read"]):
                    return False
                if "principal" in item and item["principal"] != owner:
                    return False
                if any(item[k] != v for k, v in scope.items() if k in item):
                    return False
        return True

    @staticmethod
    def _signature(value):
        return value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns

    def _open_directory(self, folder):
        folder = pathlib.Path(folder)
        if not folder.is_absolute() or ".." in folder.parts or len(folder.parts) > 128:
            raise self._unknown()
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            for part in folder.parts[1:]:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                os.close(fd)
                fd = nxt
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _snapshot(self, folder):
        skip = {"__pycache__", ".git", "node_modules", ".venv", "venv", "data", "store", "var"}
        directories, files = {}, {}
        entries = 0

        def visit(fd, relative):
            nonlocal entries
            if len(directories) >= 64 or len(pathlib.PurePosixPath(relative).parts) > 8:
                raise self._unknown()
            before = os.fstat(fd)
            directories[relative] = self._signature(before)
            names = []
            with os.scandir(fd) as stream:
                for item in stream:
                    entries += 1
                    self.fs_entries += 1
                    if entries > 4096 or self.fs_entries > 16384:
                        raise self._unknown()
                    names.append(item.name)       # bounds checked before collecting/sorting ignored entries too
            for name in sorted(names):
                if name in skip:
                    continue
                rel = (relative + "/" if relative else "") + name
                meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(meta.st_mode):
                    raise self._unknown()
                if stat.S_ISDIR(meta.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        if self._signature(os.fstat(child)) != self._signature(meta):
                            raise self._unknown()
                        visit(child, rel)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(meta.st_mode):
                    if meta.st_nlink != 1:
                        raise self._unknown()
                    files[rel] = self._signature(meta)
                else:
                    raise self._unknown()
            if self._signature(os.fstat(fd)) != self._signature(before):
                raise self._unknown()

        fd = self._open_directory(folder)
        try:
            visit(fd, "")
        finally:
            os.close(fd)
        return directories, files

    def _read_program_file(self, folder, relative, signature, budget):
        parts = pathlib.PurePosixPath(relative).parts
        if (not parts or pathlib.PurePosixPath(relative).is_absolute() or ".." in parts
                or len(parts) > 9 or set(parts[:-1]) & {"__pycache__", ".git", "node_modules", ".venv", "venv", "data", "store", "var"}):
            raise self._unknown()
        fd = self._open_directory(folder.joinpath(*parts[:-1]))
        try:
            handle = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                meta = os.fstat(handle)
                if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or self._signature(meta) != signature
                        or meta.st_size > 8 * 1024 * 1024):
                    raise self._unknown()
                chunks = []
                total = 0
                while True:
                    value = os.read(handle, 65536)
                    if not value:
                        break
                    total += len(value)
                    budget[0] += len(value)
                    self.fs_bytes += len(value)
                    if total > meta.st_size or budget[0] > 8 * 1024 * 1024 or self.fs_bytes > 32 * 1024 * 1024:
                        raise self._unknown()
                    chunks.append(value)
                if total != meta.st_size or self._signature(os.fstat(handle)) != signature:
                    raise self._unknown()
                return b"".join(chunks)
            finally:
                os.close(handle)
        finally:
            os.close(fd)

    def _check_snapshot(self, folder, snapshot):
        directories, files = snapshot
        for relative, signature in (*directories.items(), *files.items()):
            self.fs_stats += 1
            if self.fs_stats > 65536:
                raise self._unknown()
            candidate = folder / relative
            fd = self._open_directory(candidate if relative in directories else candidate.parent)
            try:
                meta = os.fstat(fd) if relative in directories else os.stat(candidate.name, dir_fd=fd, follow_symlinks=False)
                if self._signature(meta) != signature:
                    raise self._unknown()
            finally:
                os.close(fd)

    def _check_pin(self, entry, pin):
        if (not isinstance(pin, dict) or set(pin) - {"release", "digest", "files", "env"}
                or not isinstance(pin.get("release"), str) or not isinstance(pin.get("digest"), str)
                or re.fullmatch(r"sha256:[0-9a-f]{64}", pin["digest"]) is None):
            raise self._unknown()
        folder = pathlib.Path(str(entry.get("path") or ""))
        release = pathlib.Path(pin["release"])
        if folder != release or not folder.is_absolute() or ".." in folder.parts:
            raise self._unknown()
        files, environment = pin.get("files", {}), pin.get("env", {})
        if (not isinstance(files, dict) or len(files) > 512 or not isinstance(environment, dict) or len(environment) > 128
                or any(not isinstance(k, str) or not isinstance(v, str) or not v for k, v in environment.items())):
            raise self._unknown()
        try:
            snapshot = self._snapshot(folder)
            paths = snapshot[1]
            sources = [p for p in paths if pathlib.PurePosixPath(p).suffix in (".py", ".metta")]
            if "plugin.json" not in paths or len(sources) > 512:
                raise self._unknown()
            ordered = ["plugin.json"] + sorted(sources, key=pathlib.PurePosixPath)
            if "ui/bundle.lock.json" in paths:
                ordered.append("ui/bundle.lock.json")
            if any(not isinstance(relative, str) for relative in files) or len(set(ordered) | set(files)) > 512:
                raise self._unknown()
            contents, budget = {}, self.program_read_bytes.setdefault(entry["id"], [0])
            digest = hashlib.sha256()
            for relative in ordered:
                content = self._read_program_file(folder, relative, paths[relative], budget)
                contents[relative] = content
                digest.update(relative.encode("utf-8") + b"\0" + content + b"\0")
            if "sha256:" + digest.hexdigest() != pin["digest"] or entry.get("digest") != pin["digest"]:
                return self._pin_refused()
            for relative, expected in files.items():
                if (not isinstance(relative, str) or not isinstance(expected, str)
                        or re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", expected) is None or relative not in paths):
                    raise self._unknown()
                content = contents.get(relative)
                if content is None:
                    content = self._read_program_file(folder, relative, paths[relative], budget)
                if hashlib.sha256(content).hexdigest() != expected.removeprefix("sha256:"):
                    return self._pin_refused()
            if any(os.environ.get(name) != expected for name, expected in environment.items()):
                return self._pin_refused()
            if self._snapshot(folder) != snapshot:
                raise self._unknown()
            self._check_snapshot(folder, snapshot)
            return snapshot
        except (OSError, UnicodeError, ValueError):
            raise self._unknown() from None

    def _pin_refused(self):
        # A known mismatch is a current integrity refusal, not a new publishing/entry.error mutation.
        raise self._error(409, "app_integrity", "an app is no longer its pinned release")

    def _limit_requests(self, row):
        if not self._person_exists(row["requested_by"]) or row["requested_by"] == self.person.principal:
            return None
        if self.person.principal != "user:operator" and not self._person_exists(self.person.principal):
            return None
        agent_id, key_id = row["agent_id"], row["key_id"]
        if key_id == "*":
            if agent_id:             # old/default-derived wildcard cannot stand for a current concrete payer
                return None
            if row["owner"] == "user:operator":
                stored = self._stored_owner()
                if stored is None:
                    raise self._unknown()
                if stored != row["owner"]:
                    return None
            elif not self._person_exists(row["owner"]):
                return None
        else:
            key = self._key_authority(key_id)
            if key is None or key[0] != row["owner"]:
                return None
            if not agent_id:         # concrete requests are recorded for a selected mind, not an inferred default
                return None
            agent = self._agent(agent_id)
            if agent is None:
                return None
            from .visibility import Viewer
            requester = self.db.one("SELECT role,disabled FROM people WHERE id = ?", (row["requested_by"][5:],))
            if requester is None or requester["disabled"]:
                return None
            requester_view = Viewer(row["requested_by"], requester["role"] == "admin")
            if not self._visible({"agent_id": agent_id}, viewer=requester_view):
                return None
            options = self._json(agent.get("options") or "{}")
            current_key = options.get("key")
            model = agent.get("model") or self.hive.settings.default_model or ""
            if not isinstance(model, str) or not model.partition("/")[0]:
                raise self._invalid()
            provider = model.partition("/")[0]
            if not current_key:
                keyring = getattr(self.hive, "keyring", None)
                current_key = ((keyring.ring.get("defaults") if keyring else None) or {}).get(provider) or "env:" + provider
            if current_key != key_id:
                return None
            if key_id.startswith("env:"):
                if key_id != "env:" + provider:
                    return None
            elif self.hive.keyring.ring["keys"][key_id].get("provider") != provider:
                return None
            user = self._user_for(agent)
            # A first grant can intentionally move billing from key owner to requester. A different current
            # user/payer may not inherit this stored request merely because its addressed key still exists.
            if user != row["requested_by"] or self._payer(user, key[1]) not in (user, row["owner"]):
                return None
        if agent_id is not None:
            self._text(agent_id)
        return {"kind": "limit_request", "id": row["id"], "agent_id": agent_id, "state": "pending",
                "created_at": row["created_at"], "answers": {"approve": True, "adjust": True, "decline": True}}

    def _user_for(self, agent):
        # Reviewed Hive.user_for -> Studio.call_principal -> live_session_of are raw DB readers. In particular,
        # do not call Hive.payer_for, whose access() branch can migrate the hive owner.
        return self.hive.user_for(agent)
