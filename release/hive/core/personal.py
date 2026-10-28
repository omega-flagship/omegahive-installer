"""Personal minds, P1: the identity record (coordination/omegareview/PLATFORM_PERSONAL_MIND_ASK_PLAN_R1_20261008.md).

the owner 2026-10-08: "every user had one". Each named person (a `people` row, principal user:u_..., enabled) has exactly one
personal mind:
- an omega-kind mind, asleep, alone in a swarm of its own; both owned by the person and private (R13);
- named after the person's display name (their name, else the part of their address before the @);
- its money is the person's allowance: its own cap (budget_usd) is 0 and its calls are paid by its owner
  (Hive.payer_for), so the person's month allowance (Hive.my_spend's figure: their month rule, else the member default)
  applies at call time. No lifetime figure is written that would read as the allowance. P2: such a call, paid by that
  same person from the hive's money, is let through to the limits above it even without a hive total, held to their
  month allowance (Budgets.allowance_pays); an admin with no month rule has no allowance, so the usual rules apply.
- alone in its swarm: no other mind is created in, moved into or placed in a personal swarm, and the personal mind is
  never moved out of it (400 personal_swarm). An admin may still delete it; the person's next GET or POST makes another.
- marked: agents.personal_of and swarms.personal_of hold the person's principal; one live mind and one open swarm per
  person, enforced by unique partial indexes.
Created on sign-in (the Google callback and the hive_signin / webhost exchange) and by a one-time idempotent backfill at
startup. Creation never wakes the mind and never calls a model: it is the ordinary create path (row, spaces, workspace
files) with no start, its row written marked and asleep. Memory is the person's browser's (the owner, 2026-10-08): the hive
keeps no memory or history for the personal mind; swarm-answered exchanges wait in personal_inbox.py only until the
person's browser collects them. P2 r3: an Ask turn that speaks as it is stored content-free (ask.py's module notes):
no words, context or answer in ask_turns, ask_events, ask_steers, rooms or the hub; its thread's room reads empty to
everyone but its person, admins included.
Not named people: the loopback operator, minds, the legacy webhost principal user:<username> (no people row) and anyone
signed out. GET/POST /api/me/mind act only on the caller's own mind.
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("hive")

MAX_NAME = 80
SAY = {"person_required": "A personal mind needs a signed-in person with an account here.",
       "invalid": "That isn't in a shape the hive understands.",
       "personal_swarm": "A personal mind lives alone in its own swarm."}


def migrate(db):
    """agents.personal_of / swarms.personal_of (TEXT, NULL for everything else), guarded like hive/core's other ALTERs."""
    for table in ("agents", "swarms"):
        if "personal_of" not in {r["name"] for r in db.all(f"PRAGMA table_info({table})")}:
            db.execute(f"ALTER TABLE {table} ADD COLUMN personal_of TEXT")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS agents_personal_of ON agents(personal_of) "
               "WHERE personal_of IS NOT NULL AND deleted = 0")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS swarms_personal_of ON swarms(personal_of) "
               "WHERE personal_of IS NOT NULL AND archived_at IS NULL")


class PersonalMinds:
    def __init__(self, hive):
        self.hive = hive
        migrate(hive.db)
        self._lock = threading.RLock()   # one creation at a time (the unique indexes are the backstop)

    # ---- who has one ----------------------------------------------------------------------------------------------

    def person(self, principal):
        """The enabled people row behind a principal, or None (operator, minds, legacy webhost principals, guests)."""
        if not isinstance(principal, str) or not principal.startswith("user:u_"):
            return None
        return self.hive.db.one("SELECT * FROM people WHERE id = ? AND disabled = 0", (principal[5:],))

    @staticmethod
    def display_name(person):
        name = str(person.get("name") or "").strip() or str(person.get("email") or "").split("@")[0].strip()
        return (name or "Me")[:MAX_NAME]

    def allowance(self, principal):
        spend = self.hive.my_spend(principal)
        return spend["allowance_usd"], spend["allowance_origin"]

    @staticmethod
    def default_model():
        """A new personal mind's model: HIVE_ASK_CONDUCTOR_MODEL when set, else None (the hive default)."""
        return os.environ.get("HIVE_ASK_CONDUCTOR_MODEL", "").strip() or None

    def acting_as(self, principal, mind):
        """{mind_id, name} when `mind` (a row) is this person's own personal mind, else None: who a turn speaks as."""
        if mind and principal and mind.get("personal_of") == principal:
            return {"mind_id": mind["id"], "name": mind["name"]}
        return None

    def thread_person(self, room_id):
        """The person whose personal mind's Ask thread this room is, else None (any other room)."""
        row = self.hive.db.one("SELECT a.personal_of FROM work_sessions s JOIN agents a ON a.id = s.agent_id "
                               "WHERE s.room_id = ? AND s.purpose = 'ask' AND a.personal_of IS NOT NULL", (room_id,))
        return row["personal_of"] if row else None

    def mind_row(self, principal):
        return self.hive.db.one("SELECT * FROM agents WHERE personal_of = ? AND deleted = 0", (principal,))

    def _swarm_row(self, principal):
        return self.hive.db.one("SELECT * FROM swarms WHERE personal_of = ? AND archived_at IS NULL", (principal,))

    # ---- alone in its own swarm --------------------------------------------------------------------------------------

    def refuse_join(self, swarm_id, personal_of=None):
        """A new or arriving mind may enter a personal swarm only as that person's own personal mind."""
        if not swarm_id:
            return
        row = self.hive.db.one("SELECT personal_of FROM swarms WHERE id = ?", (swarm_id,))
        if row and row["personal_of"] and row["personal_of"] != personal_of:
            raise self._refuse(400, "personal_swarm")
        if personal_of and not (row and row["personal_of"] == personal_of):
            raise self._refuse(400, "personal_swarm")

    def refuse_move(self, agent_row, target_swarm_id):
        """Moves: a personal mind never leaves its swarm, and no other mind moves into a personal swarm."""
        if agent_row.get("personal_of") and target_swarm_id != agent_row.get("swarm_id"):
            raise self._refuse(400, "personal_swarm")
        if target_swarm_id and target_swarm_id != "new":
            self.refuse_join(target_swarm_id, agent_row.get("personal_of"))

    # ---- creation: never wakes, never calls a model ---------------------------------------------------------------

    def ensure(self, principal, name=None):
        """The person's personal mind row, made if missing (idempotent); None for anyone who is not a named person."""
        person = self.person(principal)
        if person is None:
            return None
        with self._lock:
            row = self.mind_row(principal)
            if row is not None:
                return row
            hive = self.hive
            name = (str(name).strip()[:MAX_NAME] if name and str(name).strip() else None) or self.display_name(person)
            swarm = self._swarm_row(principal)
            if swarm is None:
                made = hive.create_swarm(name, "Personal mind", owner=principal, visibility="private")
                hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (principal, made["id"]))
                swarm = self._swarm_row(principal)
            # the ordinary create path (row, spaces, workspace files), written marked and asleep; it starts nothing.
            # budget_usd 0: the person pays (payer_for: the owner), so their month allowance is the limit at call time.
            # its model (P2): the Ask conductor's (HIVE_ASK_CONDUCTOR_MODEL), else the hive default; a conductor turn
            # that speaks as this mind uses it (ask.py); the person changes it later through versions (P3/P4)
            agent = hive.create_agent(name, "omega", swarm["id"], self.default_model(), "", None, 0.0, None, None,
                                      principal, "private", None, personal_of=principal)
            hive.db.execute("UPDATE swarms SET coordinator_id = ? WHERE id = ?", (agent["id"], swarm["id"]))
            hive.events.publish("swarm.updated", swarm=hive.swarm(swarm["id"]))
            log.info("personal mind %s made for %s", agent["id"], principal)
            return self.mind_row(principal)

    def ensure_quietly(self, principal):
        """For sign-in: a failure is logged and never fails the sign-in."""
        try:
            return self.ensure(principal)
        except Exception:   # noqa: BLE001
            log.exception("personal mind for %s could not be made", principal)
            return None

    def backfill(self):
        """Once at startup: every enabled person without one gets one. Idempotent; one failure never stops the rest."""
        made = 0
        for p in self.hive.db.all("SELECT id FROM people WHERE disabled = 0 ORDER BY created_at"):
            principal = "user:" + p["id"]
            if self.mind_row(principal) is not None:
                continue
            if self.ensure_quietly(principal) is not None:
                made += 1
        if made:
            log.info("personal minds: backfilled %d", made)
        return made

    # ---- the person's own routes ----------------------------------------------------------------------------------

    def _refuse(self, status, code):
        return self.hive.error(status, code, SAY[code])

    def view(self, row):
        """The plan's shape. version / adopted_at / previous_version_id stay null until P3/P4 register versions."""
        allowance, origin = self.allowance(row["personal_of"])
        return {"id": row["id"], "name": row["name"], "swarm_id": row["swarm_id"], "status": row["status"],
                "budget_usd": float(row["budget_usd"] or 0), "allowance_usd": allowance, "allowance_origin": origin,
                "version": None, "adopted_at": None, "previous_version_id": None, "created_at": row["created_at"]}

    def get(self, viewer):
        """GET /api/me/mind: the caller's own; made now if it is missing (never null for a named person)."""
        if self.person(viewer.principal) is None:
            raise self._refuse(403, "person_required")
        return {"mind": self.view(self.ensure(viewer.principal))}

    def post(self, viewer, data):
        """POST /api/me/mind {name}: rename the caller's own mind (and its swarm), or make it if missing."""
        if self.person(viewer.principal) is None:
            raise self._refuse(403, "person_required")
        if not isinstance(data, dict) or set(data) - {"name"} or "name" not in data \
                or not isinstance(data["name"], str) or not data["name"].strip():
            raise self._refuse(400, "invalid")
        name = data["name"].strip()[:MAX_NAME]
        hive = self.hive
        with self._lock:
            row = self.mind_row(viewer.principal)
            if row is None:
                return {"mind": self.view(self.ensure(viewer.principal, name)), "created": True}
            if row["name"] != name:   # the ordinary update paths (the workspace prompt is rewritten; nothing starts)
                hive.update_agent(row["id"], {"name": name})
                if row["swarm_id"] and (self._swarm_row(viewer.principal) or {}).get("id") == row["swarm_id"]:
                    hive.update_swarm(row["swarm_id"], {"name": name})
            return {"mind": self.view(self.mind_row(viewer.principal)), "created": False}
