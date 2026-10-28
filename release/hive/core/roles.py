"""Roles: reusable bundles that shape a mind.

A role has a prompt template, a default model, a default budget and approval rules.  Assigning a role
to a mind sets its prompt (the role's text, rendered for that mind, followed by the mind's own extra
instructions in ``persona``), and applies the role's approval rules at the mind's scope.  Editing a role
updates every mind that has it.  Model and budget defaults apply when a mind is created with the role;
after that they are the mind's own.

Template placeholders: {name} (the mind), {swarm} (its swarm's name), {purpose} (its swarm's purpose).
"""

from __future__ import annotations

import json
import re
import threading
import time

from .db import new_id, now

SCHEMA = """
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
  default_model TEXT, default_budget REAL, rules TEXT NOT NULL DEFAULT '[]', builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"""

BUILTIN = [
    ("Generalist", "Thoughtful all-rounder", "You are {name}, a thoughtful generalist in {swarm}. Ask for what you need, say what you are unsure of, and keep your replies short."),
    ("Coordinator", "Turns tasks into work", "You are {name}, the coordinator of {swarm}. Turn each task into small, testable subtasks for the right minds, keep track of what is done and blocked, and report progress plainly."),
    ("Source finder", "Finds and cites sources", "You are {name}, the source finder in {swarm}. Find and summarise primary sources. Cite where each claim comes from and publish only what a source actually says."),
    ("Evidence analyst", "Weighs evidence honestly", "You are {name}, the evidence analyst in {swarm}. Weigh what the swarm finds and publish beliefs with confidence that matches the evidence. Say what would change your mind."),
    ("Sceptic", "Challenges weak claims", "You are {name}, the sceptic in {swarm}. Challenge weak or single-source claims, ask for evidence and flag anything that looks too convenient."),
    ("Planner", "Splits the work", "You are {name}, the planner in {swarm}. Turn the task into small, testable subtasks and keep track of what is done and what is blocked."),
    ("Builder", "Does the work carefully", "You are {name}, the builder in {swarm}. Take one subtask at a time, do it carefully and report exactly what you changed and how you checked it."),
    ("Reviewer", "Checks before done", "You are {name}, the reviewer in {swarm}. Review the work against the task, point out concrete problems and approve only what you have checked."),
    ("Advocate", "Argues for", "You are {name}, the advocate in {swarm}. Make the strongest honest case for the proposition, with evidence."),
    ("Opponent", "Argues against", "You are {name}, the opponent in {swarm}. Make the strongest honest case against the proposition, with evidence."),
    ("Judge", "Decides what holds", "You are {name}, the judge in {swarm}. Weigh both sides fairly, publish what holds up and with what confidence, and explain why."),
]

MODES = ("allow", "ask", "deny")


class RoleError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


MAX_RULES = 100


def render(template, name, swarm="", purpose=""):
    values = {"name": name, "swarm": swarm or "this hive", "purpose": purpose or ""}
    return re.sub(r"\{(name|swarm|purpose)\}", lambda m: values[m.group(1)], template)


class Roles:
    def __init__(self, hive):
        self.hive = hive
        # host-identity r1.2: held around every write of a role's rules and every role-rule change on a mind, so a check of
        # what a change would touch (touches_policy, carries_rules) and the change itself are one step. Only database
        # work is done under it (never supervisor or event side effects), so it never waits on a mind's lock.
        self.lock = threading.RLock()
        with hive.db._lock:
            hive.db._conn.executescript(SCHEMA)
            columns = {r[1] for r in hive.db._conn.execute("PRAGMA table_info(agents)")}
            if "role_id" not in columns:
                hive.db._conn.execute("ALTER TABLE agents ADD COLUMN role_id TEXT")
            role_columns = {r[1] for r in hive.db._conn.execute("PRAGMA table_info(roles)")}
            if "mandate" not in role_columns:
                hive.db._conn.execute("ALTER TABLE roles ADD COLUMN mandate TEXT")
            if "media" not in role_columns:
                hive.db._conn.execute("ALTER TABLE roles ADD COLUMN media TEXT")
        for name, summary, prompt in BUILTIN:
            if not self.db.one("SELECT 1 FROM roles WHERE name = ?", (name,)):
                self.db.insert("roles", {"id": new_id("role"), "name": name, "summary": summary, "prompt": prompt,
                                         "builtin": 1, "created_at": now(), "updated_at": now()})

    @property
    def db(self):
        return self.hive.db

    def view(self, row, with_minds=True):
        out = {"id": row["id"], "name": row["name"], "summary": row["summary"], "prompt": row["prompt"],
               "default_model": row["default_model"], "default_budget": row["default_budget"],
               "rules": json.loads(row["rules"] or "[]"), "mandate": json.loads(row["mandate"]) if row.get("mandate") else None,
               "media": json.loads(row["media"]) if row.get("media") else [], "builtin": bool(row["builtin"]),
               "created_at": row["created_at"], "updated_at": row["updated_at"]}
        if with_minds:
            out["minds"] = [r["id"] for r in self.db.all("SELECT id FROM agents WHERE role_id = ? AND deleted = 0", (row["id"],))]
        return out

    def list(self):
        return [self.view(r) for r in self.db.all("SELECT * FROM roles ORDER BY builtin DESC, name")]

    def get(self, role_id):
        row = self.db.one("SELECT * FROM roles WHERE id = ?", (role_id,))
        if row is None:
            raise RoleError(404, "not_found", f"no role {role_id}")
        return row

    @staticmethod
    def _clean_rules(rules):
        out = []
        for rule in rules or []:
            if not isinstance(rule, dict):
                raise RoleError(400, "bad_rules", "each rule is {skill, mode}")
            skill, mode = str(rule.get("skill", "")).strip(), rule.get("mode")
            if not re.fullmatch(r"[A-Za-z0-9*?_:.-]{1,60}", skill) or mode not in MODES:
                raise RoleError(400, "bad_rules", "a rule needs a skill name or glob and a mode of allow, ask or deny")
            out.append({"skill": skill, "mode": mode})
        if len(out) > MAX_RULES:
            # never drop rules silently: a role that loses an allow or a deny changes what minds may do
            raise RoleError(400, "too_many_rules", f"a role holds at most {MAX_RULES} rules; use a glob or split the role")
        return out

    def _fields(self, data, partial=False):
        out = {}
        if "name" in data or not partial:
            name = str(data.get("name", "")).strip()
            if not name or len(name) > 40:
                raise RoleError(400, "bad_name", "a role needs a name of up to 40 characters")
            out["name"] = name
        if "summary" in data:
            out["summary"] = str(data.get("summary") or "").strip()[:120]
        if "prompt" in data or not partial:
            prompt = str(data.get("prompt", "")).strip()
            if not prompt or len(prompt) > 6000:
                raise RoleError(400, "bad_prompt", "a role needs a prompt of up to 6000 characters")
            out["prompt"] = prompt
        if "default_model" in data:
            out["default_model"] = str(data["default_model"]).strip() or None if data["default_model"] else None
        if "default_budget" in data:
            value = data["default_budget"]
            out["default_budget"] = None if value in (None, "") else max(0.0, min(float(value), 10000.0))
        if "rules" in data:
            out["rules"] = json.dumps(self._clean_rules(data["rules"]))
        if "mandate" in data:
            m = data["mandate"]
            if m is not None and not (isinstance(m, dict) and set(m) == {"id", "version"}
                                      and all(isinstance(v, str) and v.strip() for v in m.values())):
                raise RoleError(400, "bad_mandate", "a review mandate is {id, version} or null")
            out["mandate"] = json.dumps(m) if m else None
        if "media" in data:
            media = data["media"] or []
            if not isinstance(media, list) or len(media) > 20 or not all(isinstance(x, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", x) for x in media):
                raise RoleError(400, "bad_media", "media is a list of short names such as ui, deck, image, copy")
            out["media"] = json.dumps(sorted(set(media))) if media else None
        return out

    def create(self, data):
        fields = self._fields(data)
        if self.db.one("SELECT 1 FROM roles WHERE name = ?", (fields["name"],)):
            raise RoleError(409, "name_taken", f"a role called {fields['name']!r} exists")
        row = {"id": new_id("role"), "summary": "", "rules": "[]", "builtin": 0, "created_at": now(), "updated_at": now(), **fields}
        self.db.insert("roles", row)
        return self.view(self.get(row["id"]))

    def update(self, role_id, data, by=None):
        self.get(role_id)
        fields = self._fields(data, partial=True)
        if "name" in fields and self.db.one("SELECT 1 FROM roles WHERE name = ? AND id != ?", (fields["name"], role_id)):
            raise RoleError(409, "name_taken", f"a role called {fields['name']!r} exists")
        if fields:
            with self.lock:
                self.db.update("roles", role_id, fields | {"updated_at": now()})
        for agent_id in self.view(self.get(role_id))["minds"]:
            self.apply(agent_id, by=by)  # prompts and rules follow the role
        return self.view(self.get(role_id))

    def remove(self, role_id, by=None):
        role = self.view(self.get(role_id))
        for agent_id in role["minds"]:
            self.assign(agent_id, None, by=by)
        self.db.execute("DELETE FROM roles WHERE id = ?", (role_id,))
        return {"ok": True, "unassigned": len(role["minds"])}

    def duplicate(self, role_id):
        base = self.view(self.get(role_id), with_minds=False)
        name = f"{base['name']} copy"
        n = 2
        while self.db.one("SELECT 1 FROM roles WHERE name = ?", (name,)):
            name, n = f"{base['name']} copy {n}", n + 1
        return self.create({k: base[k] for k in ("summary", "prompt", "default_model", "default_budget", "rules")} | {"name": name})

    # ---- minds -----------------------------------------------------------------------------------

    def prompt_for(self, agent_row):
        """The rendered role text for a mind, or '' when it has no role."""
        if not agent_row.get("role_id"):
            return ""
        role = self.db.one("SELECT * FROM roles WHERE id = ?", (agent_row["role_id"],))
        if role is None:
            return ""
        swarm = self.db.one("SELECT name, description FROM swarms WHERE id = ?", (agent_row.get("swarm_id"),)) if agent_row.get("swarm_id") else None
        return render(role["prompt"], agent_row["name"], swarm["name"] if swarm else "", swarm["description"] if swarm else "")

    def carries_rules(self, role_id):
        """Whether a role carries approval rules (an unknown role or no role: no; unreadable rules count as rules)."""
        row = self.db.one("SELECT rules FROM roles WHERE id = ?", (role_id,)) if role_id else None
        try:
            return bool(row and json.loads(row["rules"] or "[]"))
        except ValueError:
            return True

    def touches_policy(self, agent_id, role_id):
        """host-identity r1.2: whether assigning ``role_id`` to this mind would change any approval rule: apply deletes
        every rule in force at the mind's scope whose note is role:... (whatever put it there: a role, or a bundle that
        carried it in) and inserts the new role's rules. Judged from the rules actually there, not role definitions."""
        there = self.db.one("SELECT 1 FROM policy_rules WHERE scope = ? AND note LIKE 'role:%' AND (expires_at IS NULL OR expires_at > ?)",
                            (f"agent:{agent_id}", time.time()))
        return bool(there) or self.carries_rules(role_id)

    def assign(self, agent_id, role_id, by=None, guard=None):
        """``guard`` (host-identity r1.2) runs under the lock and inside the transaction, before anything changes, and
        refuses by raising; the role, its rules and the check are then one step."""
        if role_id:
            self.get(role_id)
        with self.lock, self.db.transaction():
            if guard is not None:
                guard()
            self.db.update("agents", agent_id, {"role_id": role_id or None})
            self._apply_rules(agent_id, by)
        return self._applied(agent_id)

    def apply(self, agent_id, by=None):
        """Re-apply a mind's role: its approval rules at the mind's scope, and its prompt. ``by`` (host-identity r1.1) is
        recorded as the rules' granted_by; a plain re-apply (by None) keeps the grantor the replaced rules had."""
        with self.lock, self.db.transaction():
            self._apply_rules(agent_id, by)
        return self._applied(agent_id)

    def _apply_rules(self, agent_id, by):
        row = self.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        policy = self.hive.policy
        for rule in policy.rules():
            if rule["scope"] == f"agent:{agent_id}" and str(rule.get("note", "")).startswith("role:"):
                by = by or rule.get("granted_by")
                self.db.execute("DELETE FROM policy_rules WHERE id = ?", (rule["id"],))
        if row and row.get("role_id"):
            role = self.db.one("SELECT * FROM roles WHERE id = ?", (row["role_id"],))
            for rule in json.loads(role["rules"] or "[]") if role else []:
                self.db.insert("policy_rules", {"id": new_id("r"), "scope": f"agent:{agent_id}", "skill": rule["skill"],
                                                "mode": rule["mode"], "note": f"role:{role['name']}", "created_at": now(),
                                                "granted_by": by})

    def _applied(self, agent_id):
        """The side effects of a role change, after its rules are committed and outside the lock."""
        row = self.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        self.hive.events.publish("policy.updated", rules=self.hive.policy.rules())
        if self.hive.supervisor and row:
            self.hive.supervisor.reconfigure(self.hive.agent(agent_id))
        self.hive.emit_agent(agent_id)
        return self.hive.agent(agent_id)
