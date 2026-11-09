"""Personal minds, P1: the identity record (PLATFORM_PERSONAL_MIND_ASK_PLAN_R1_20261008.md).

Jon 2026-10-08: "every user had one". Each named person (a `people` row, principal user:u_..., enabled) has exactly one
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
Created on sign-in (the Google callback and the hive_signin / family exchange) and by a one-time idempotent backfill at
startup. Creation never wakes the mind and never calls a model: it is the ordinary create path (row, spaces, workspace
files) with no start, its row written marked and asleep. Memory is the person's browser's (Jon, 2026-10-08): the hive
keeps no memory or history for the personal mind; swarm-answered exchanges wait in personal_inbox.py only until the
person's browser collects them. P2 r3: an Ask turn that speaks as it is stored content-free (ask.py's module notes):
no words, context or answer in ask_turns, ask_events, ask_steers, rooms or the hub; its thread's room reads empty to
everyone but its person, admins included.
Not named people: the loopback operator, minds, the legacy family principal user:<username> (no people row) and anyone
signed out. GET/POST /api/me/mind act only on the caller's own mind.
"""

from __future__ import annotations

import logging
import threading

from .db import now as hive_now

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
    # gateway r1b (plan §2.4): the person's one personal-mind setting, its own table (ask_prefs' upsert is positional).
    # No row reads ON (r1.1, Jon (a): "on by default, thats why they give the API key"). On no list or audit.
    db.execute("CREATE TABLE IF NOT EXISTS mind_prefs (principal TEXT PRIMARY KEY, browser_mind INTEGER NOT NULL, "
               "updated_at TEXT NOT NULL)")


class PersonalMinds:
    def __init__(self, hive):
        self.hive = hive
        migrate(hive.db)
        from .model_route import migrate as migrate_routes
        migrate_routes(hive.db)
        self._lock = threading.RLock()   # one creation at a time (the unique indexes are the backstop)

    # ---- who has one ----------------------------------------------------------------------------------------------

    def person(self, principal):
        """The enabled people row behind a principal, or None (operator, minds, legacy family principals, guests)."""
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

    def settlement(self, agent, model):
        """How a call by this person's mind (a stored row, or the one about to be made) on `model` would settle: the one
        read-only answer (Budgets.settlement) that the pickup, creation and the page all use."""
        return self.hive.budgets.settlement(agent, model, user=agent.get("personal_of"))

    def host_route(self, agent):
        """The hive's one decision call (model_route.choose) for this person's mind, with pins checked and every route
        fact settled for THIS mind: an operator pin or a roster route counts only when a call on it would be on a key no
        named person owns, paid by this person from the hive's money, and held by a finite limit on that key and payer
        (their month allowance, a grant on that key, or the hive's total). The same bar for creation and for the pickup
        (Dot, 50998399: no trusted pin for a person's mind). {'route', 'policy', 'fact'} or {'refused'}."""
        from .model_route import choose
        hive = self.hive
        return choose("personal-mind:dialogue", getattr(hive, "keyring", None), getattr(hive, "ownhive", None),
                      pins="check", settle=lambda model: self.settlement(agent, model))

    def pick_up_host_provider(self, row):
        """A personal mind still on the demonstration model THE HOST SET moves to the host's route once there is one (a
        key the host gains later, or a mind made before the host had one): no step for the person. Decided entirely under
        the mind's lock, and written there (hive._update_agent_locked):
        - provenance: only a demonstration model the host itself set and still records (model_route.held) moves; one
          anyone chose (mock/echo again included) or an older mind with no record is left as it is;
        - the route and the wallet, as one: host_route, whose every fact is this mind's settlement (Budgets.settlement),
          checked again for the chosen model under the lock: the hive's key, this person paying from the hive's money,
          admitted, and held by their month allowance, a grant on that key, or the hive's total. Otherwise nothing moves.
        Returns the row as it now is."""
        from .model_route import HOST_ACTOR, held, is_demo
        if row is None or not is_demo(row.get("model")):
            return row
        hive = self.hive
        with hive._mind_lock(row["id"]):
            fresh = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row["id"],))
            if fresh is None or not is_demo(fresh["model"]) or held(hive.db, fresh["id"]) != fresh["model"]:
                return self.mind_row(row["personal_of"])
            choice = self.host_route(fresh)
            model = choice.get("route")
            if not model or is_demo(model):
                log.info("personal mind %s stays on the demonstration model: %s", fresh["id"], choice.get("refused"))
                return self.mind_row(row["personal_of"])
            settled = self.settlement(fresh, model)
            if not settled["host_paid"]:
                log.info("personal mind %s stays on the demonstration model: %s", fresh["id"], settled["reason"] or "not host-paid")
                return self.mind_row(row["personal_of"])
            try:
                hive._update_agent_locked(fresh["id"], {"model": model}, by=HOST_ACTOR)
            except Exception:   # noqa: BLE001  (the mind keeps working as it was; the next sign-in tries again)
                log.exception("personal mind %s could not move to the host's route", fresh["id"])
                return self.mind_row(row["personal_of"])
        log.info("personal mind %s moved from the demonstration model to %s (%s)", row["id"], model, choice.get("policy"))
        return self.mind_row(row["personal_of"])

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

    def ensure(self, principal, name=None, pick_up=True):
        """The person's personal mind row, made if missing (idempotent); None for anyone who is not a named person."""
        person = self.person(principal)
        if person is None:
            return None
        with self._lock:
            row = self.mind_row(principal)
            if row is not None:
                return self.pick_up_host_provider(row) if pick_up else row
            hive = self.hive
            name = (str(name).strip()[:MAX_NAME] if name and str(name).strip() else None) or self.display_name(person)
            swarm = self._swarm_row(principal)
            if swarm is None:
                made = hive.create_swarm(name, "Personal mind", owner=principal, visibility="private")
                hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (principal, made["id"]))
                swarm = self._swarm_row(principal)
            # the ordinary create path (row, spaces, workspace files), written marked and asleep; it starts nothing.
            # budget_usd 0: the person pays (payer_for: the owner), so their month allowance is the limit at call time.
            # its model: host_route, the pickup's own bar (a pin or a route counts only when this mind's call on it would
            # be the hive's, paid by this person and held by a limit); a refusal makes it on model_route.fallback.
            from .model_route import fallback
            proposed = {"id": "", "name": name, "owner": principal, "personal_of": principal, "swarm_id": swarm["id"],
                        "budget_usd": 0.0, "options": None}
            choice = self.host_route(proposed)
            # who chose it: the host for a roster route it settled, or for the built-in fallback; an operator pin that
            # settled, or the operator's demonstration pin or default, is the operator's. The host's choice is recorded in
            # the insert's own transaction (create_agent host_need), so no edit can come between; any later change by
            # anyone else forgets it (hive.update_agent), and only a recorded model moves.
            if choice.get("route"):
                model, hosts = choice["route"], choice.get("policy") == "roster-rule"
            else:
                model, operators = fallback()
                hosts = not operators
            agent = hive.create_agent(name, "omega", swarm["id"], model, "", None, 0.0, None, None,
                                      principal, "private", None, personal_of=principal,
                                      host_need="personal-mind:dialogue" if hosts else None)
            hive.db.execute("UPDATE swarms SET coordinator_id = ? WHERE id = ?", (agent["id"], swarm["id"]))
            hive.events.publish("swarm.updated", swarm=hive.swarm(swarm["id"]))
            log.info("personal mind %s made for %s", agent["id"], principal)
            return self.mind_row(principal)

    def ensure_quietly(self, principal, pick_up=True):
        """For sign-in: a failure is logged and never fails the sign-in."""
        try:
            row = self.ensure(principal, pick_up=pick_up)
        except Exception:   # noqa: BLE001
            log.exception("personal mind for %s could not be made", principal)
            row = None
        foundation = getattr(self.hive, "foundation", None)
        if foundation is not None:
            foundation.ensure_quietly(principal)
        return row

    def backfill(self):
        """Once at startup: every enabled person without one gets one. Idempotent; one failure never stops the rest."""
        made = 0
        for p in self.hive.db.all("SELECT id FROM people WHERE disabled = 0 ORDER BY created_at"):
            principal = "user:" + p["id"]
            if self.mind_row(principal) is not None:
                continue
            # boot: only minds that are missing are made; none is moved here (a move happens at that person's own
            # sign-in or First Light read, one at a time)
            if self.ensure_quietly(principal, pick_up=False) is not None:
                made += 1
        if made:
            log.info("personal minds: backfilled %d", made)
        return made

    # ---- the person's own routes ----------------------------------------------------------------------------------

    def _refuse(self, status, code):
        return self.hive.error(status, code, SAY[code])

    # ---- gateway r1b: the browser-mind preference and the capability flag (plan §2.4) --------------------------------

    def browser_mind_on(self, principal):
        """The person's mind_prefs.browser_mind; no row reads on (Jon's default)."""
        row = self.hive.db.one("SELECT browser_mind FROM mind_prefs WHERE principal = ?", (principal,))
        return True if row is None else bool(row["browser_mind"])

    def capabilities(self):
        """GET /api/me/mind `capabilities`: one setting, HIVE_MIND_GATEWAY, for gateway and browser_mind; browser_mind is
        also false while the host cannot serve the mind frame with its header (plan §2.5; r1d's hive.mind_frame.available(),
        which is None, so false, when the flag was off at boot). Windows and the device inbox are not built."""
        from .ask import gateway_enabled
        on = gateway_enabled()
        frame_server = getattr(self.hive, "mind_frame", None)   # r1d's MindFrame; None when the flag was off at boot
        try:
            frame = bool(frame_server.available()) if frame_server is not None else False
        except Exception:   # noqa: BLE001  (fail closed)
            frame = False
        return {"gateway": on, "browser_mind": on and frame, "windows": False, "device_inbox": False}

    def view(self, row):
        """The plan's shape. version / adopted_at / previous_version_id stay null until P3/P4 register versions. With
        HIVE_MIND_GATEWAY=1 (gateway r1b) it also says browser_mind, the person's preference."""
        from .ask import gateway_enabled
        allowance, origin = self.allowance(row["personal_of"])
        out = {"id": row["id"], "name": row["name"], "swarm_id": row["swarm_id"], "status": row["status"],
               "budget_usd": float(row["budget_usd"] or 0), "allowance_usd": allowance, "allowance_origin": origin,
               "version": None, "adopted_at": None, "previous_version_id": None, "created_at": row["created_at"]}
        out["model"] = row.get("model")
        out["paid_by"] = self.paid_by(row, allowance)
        if gateway_enabled():
            out["browser_mind"] = self.browser_mind_on(row["personal_of"])
        return out

    def paid_by(self, row, allowance=None):
        """Who pays this mind's model calls, in plain words, read from the call's own settlement (Budgets.settlement; Dot,
        50998399), never worked out apart from it: free, refused (and why), the person's own key, another person's key,
        or the hive's money and the limit that holds it."""
        s = self.settlement(row, row.get("model"))
        person = row.get("personal_of")
        if s["free"]:
            return "no one: this model costs nothing"
        if s["reason"] and not s["key_id"]:
            return f"no one yet: a call on this model would be refused ({s['reason']})"
        if s["own_key"] and s["payer"] == person:
            return "you, on your own key" if s["bounded"] else "you, on your own key, once you set your monthly limit"
        if not s["hive_key"]:
            if s["bounded"] and s["payer"] == person:
                return "another person's key, within the limit they gave you"
            return f"no one yet: a call would be on another person's key and refused ({s['reason'] or 'not yours'})"
        if not s["bounded"]:
            return f"no one yet: no limit would hold a call, so it is refused ({s['reason']})"
        origins = {origin for _, _, _, origin in s["governing_limits"]}
        scopes = {scope for scope, _, _, _ in s["governing_limits"]}
        if person and "person:" + person[5:] in scopes:
            return "the hive, within your monthly allowance"
        if origins & {"grant", "invite"}:
            return "the hive, within the limit granted to you"
        return "the hive, within the hive's total"

    def _with_capabilities(self, out):
        from .ask import gateway_enabled
        if gateway_enabled():
            out["capabilities"] = self.capabilities()
        return out

    def get(self, viewer):
        """GET /api/me/mind: the caller's own; made now if it is missing (never null for a named person)."""
        if self.person(viewer.principal) is None:
            raise self._refuse(403, "person_required")
        return self._with_capabilities({"mind": self.view(self.ensure(viewer.principal))})

    def post(self, viewer, data):
        """POST /api/me/mind {name}: rename the caller's own mind (and its swarm), or make it if missing. With
        HIVE_MIND_GATEWAY=1 (gateway r1b) it also takes {browser_mind: bool}, with or without name."""
        from .ask import gateway_enabled
        if self.person(viewer.principal) is None:
            raise self._refuse(403, "person_required")
        keys = {"name", "browser_mind"} if gateway_enabled() else {"name"}
        if not isinstance(data, dict) or set(data) - keys or not set(data) & keys \
                or ("name" in data and (not isinstance(data["name"], str) or not data["name"].strip())) \
                or ("browser_mind" in data and not isinstance(data["browser_mind"], bool)):
            raise self._refuse(400, "invalid")
        name = data["name"].strip()[:MAX_NAME] if "name" in data else None
        hive = self.hive
        with self._lock:
            if "browser_mind" in data:
                hive.db.execute("INSERT INTO mind_prefs VALUES (?, ?, ?) ON CONFLICT(principal) DO UPDATE SET "
                                "browser_mind = excluded.browser_mind, updated_at = excluded.updated_at",
                                (viewer.principal, 1 if data["browser_mind"] else 0, hive_now()))
            row = self.mind_row(viewer.principal)
            if row is None:
                return self._with_capabilities({"mind": self.view(self.ensure(viewer.principal, name)), "created": True})
            if name is not None and row["name"] != name:   # the ordinary update paths (the workspace prompt is rewritten; nothing starts)
                hive.update_agent(row["id"], {"name": name})
                if row["swarm_id"] and (self._swarm_row(viewer.principal) or {}).get("id") == row["swarm_id"]:
                    hive.update_swarm(row["swarm_id"], {"name": name})
            return self._with_capabilities({"mind": self.view(self.mind_row(viewer.principal)), "created": False})
