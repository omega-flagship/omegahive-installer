"""Sessions: a focused working thread with one mind, like a Claude Code or Codex session, built on rooms (R15).

A session is a room of kind ``session`` (you and one mind; the mind hears every message) bound to:
- a goal, assigned to that mind, so the work has a purpose, can be reviewed and is marked done like any goal;
- an optional code workspace (OmegaCode), whose changes keep their exact-approval gates;
- a spend cap: from the mind's spend when the session starts. The cap is enforced with the mind's hard total budget
  rule, which a session only ever tightens (never raises); ending the session puts the previous rule back.
  Several sessions on one mind (Ask threads with a swarm's coordinator, ordinary sessions) compose: one record per mind
  (session_caps) owns the rule, which is always min(the rule before any session, every active session's cap). It is
  recomputed atomically on every start and end, so ends in any order restore exactly; a rule someone else set since the
  last install becomes the new base and is never overwritten by a restore (OmegaReview Ask design review, item 4).
ask-limits r1: an Ask thread answered by the host's conductor (cap_scope 'thread') is the exception. Each of its paid calls
is reserved under the thread's own scope (askthread:<id>, thread_scope below), counted against that thread's own spend
(thread_spent), so it never installs or tightens the mind's total rule: before, a stale thread with a small cap held
every later thread on the mind (from any person) under min(its cap), and raising the mind's limit changed nothing.
An Ask thread whose turns the mind itself answers (conductor off) still composes into the mind's rule as above
(cap_scope 'mind'), because that mind's calls cannot be told apart by thread; rescope() moves a thread between the two
with its spend carried over.
Its timeline merges the room's messages with the mind's own steps since the session started (what it ran, read or
changed, from its traces) and its approval requests, so a person can follow the work and decide approvals in place.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .db import new_id, now
from .limits_auto import dollars, to_micros


@dataclass(frozen=True)
class _PreparedAskSession:
    """Host-only write-free preparation; it carries no authority by itself."""
    manager: object
    principal: str
    data: dict
    agent: dict
    title: str
    budget: float
    cap_scope: str | None

SCHEMA = """CREATE TABLE IF NOT EXISTS work_sessions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  goal_id TEXT, owner TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', budget_usd REAL NOT NULL,
  spent_at_start REAL NOT NULL, prev_limit REAL, set_limit REAL, workspace TEXT, created_at TEXT NOT NULL, ended_at TEXT)"""
CAPS = """CREATE TABLE IF NOT EXISTS session_caps (agent_id TEXT PRIMARY KEY, base_limit REAL, installed REAL, updated_at TEXT NOT NULL)"""
# ask-limits r1.3: a migration label that is NOT call attribution. When a mixed-history thread leaves the mind's rule,
# _attribute labels the mind's ambiguous holds (calls that cannot be told apart by thread) with askthread:<id> so the
# thread's cap keeps counting them; each such label is also recorded here, "ambiguous, shared by threads X, Y". A row
# here never makes a hold "another thread's call": every other mixed thread still takes it (stand-in P1 on r1.2).
SHARED = """CREATE TABLE IF NOT EXISTS ask_shared_holds (reservation TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(reservation, thread_id))"""
MAX_TIMELINE = 400


def thread_scope(session_id):
    """The reservation label an own-scope Ask thread's calls are held under (ask-limits r1)."""
    return f"askthread:{session_id}"


def own_scope(s):
    return bool(s) and s.get("cap_scope") == "thread"


def _same(a, b):
    return a is not None and b is not None and abs(float(a) - float(b)) < 1e-9


class Sessions:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(SCHEMA)
        hive.db.execute(CAPS)
        hive.db.execute(SHARED)
        columns = {r["name"] for r in hive.db.all("PRAGMA table_info(work_sessions)")}
        if "purpose" not in columns:
            hive.db.execute("ALTER TABLE work_sessions ADD COLUMN purpose TEXT")   # 'ask': a Universal Ask thread (ask.py)
        if "cap_scope" not in columns:   # ask-limits r1: 'thread' (own reservation scope) | NULL/'mind' (the mind's total rule)
            hive.db.execute("ALTER TABLE work_sessions ADD COLUMN cap_scope TEXT")
        if "carried_usd" not in columns:   # a thread moved to its own scope: what it had spent by the mind's measure then
            hive.db.execute("ALTER TABLE work_sessions ADD COLUMN carried_usd REAL NOT NULL DEFAULT 0")

    def _row(self, viewer, session_id):
        s = self.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (session_id,))
        if s is None or not (viewer.admin or s["owner"] == viewer.principal):
            raise self.hive.error(404, "not_found", "no such session")
        return s

    def view(self, s):
        # A session outlives its mind and goal: a deleted or missing mind shows as removed, a missing goal as null; neither fails the list
        agent = self.hive.db.one("SELECT id, name, hue, status, spent_usd, deleted FROM agents WHERE id = ?", (s["agent_id"],))
        agent = dict(agent) if agent else {"id": s["agent_id"], "name": "", "hue": None, "status": "removed", "deleted": 1}
        if agent.get("deleted"):
            agent["status"] = "removed"
        if own_scope(s):
            spent = self.thread_spent(s)
        else:
            spent = max(0.0, float(agent.get("spent_usd") or 0) - float(s["spent_at_start"]))
        goal = self.hive.db.one("SELECT id, title, status FROM goals WHERE id = ?", (s["goal_id"],)) if s["goal_id"] else None
        return {**{k: s[k] for k in ("id", "room_id", "agent_id", "goal_id", "owner", "title", "status", "budget_usd",
                                      "created_at", "ended_at")}, "purpose": s.get("purpose"),
                "cap_scope": "thread" if own_scope(s) else "mind",
                "workspace": json.loads(s["workspace"]) if s["workspace"] else None,
                "spent_usd": round(spent, 6), "mind": {"id": agent["id"], "name": agent["name"], "hue": agent.get("hue"),
                                                       "status": agent.get("status")},
                "goal": {"id": goal["id"], "title": goal["title"], "status": goal["status"]} if goal else None}

    def list(self, viewer):
        rows = self.hive.db.all("SELECT * FROM work_sessions ORDER BY created_at DESC LIMIT 200")
        rows = self.hive.visibility.hide_others_personal(viewer, [s for s in rows if viewer.admin or s["owner"] == viewer.principal],
                                                         lambda s: [s.get("agent_id")] + self._room_swarm(s))
        return [self.view(s) for s in rows]

    def _room_swarm(self, s):
        r = self.hive.db.one("SELECT swarm_id FROM rooms WHERE id = ?", (s.get("room_id"),)) if s.get("room_id") else None
        return [r["swarm_id"]] if r else []

    async def create(self, viewer, data, purpose=None, cap_scope=None, *, _prepare_ask=False):
        agent = self.hive.agent(str(data.get("mind") or ""))
        if not agent.get("swarm_id"):
            raise self.hive.error(400, "bad_request", "a session's mind must belong to a swarm (its task lives there)")
        title = str(data.get("title") or "").strip()[:200]
        if not title:
            raise self.hive.error(400, "bad_request", "say what the session is for")
        raw = data.get("budget_usd")
        if raw is None or raw == "":
            # none given: a tenth of what the mind has left once the hive has a total (plan H5); $1 as before without one
            auto = self.hive.budgets.session_default(agent)
            if auto is not None and auto <= 0:
                raise self.hive.error(402, "spend_limit", f"{agent['name']} has nothing left under its limits")
            raw = 1.0 if auto is None else auto
        try:
            budget = float(raw)
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_request", "budget_usd is a number") from None
        if not 0 < budget <= 100:
            raise self.hive.error(400, "bad_request", "a session budget is more than $0 and at most $100")
        self.studio_free(agent["id"])
        self.payer_free(agent["id"], viewer.principal, purpose)   # early, before the goal: the check that counts is below
        if _prepare_ask:
            if purpose != "ask":
                raise self.hive.error(400, "bad_request", "only an Ask thread can be prepared")
            # No goal, assignment note, room, cap or event exists before the
            # caller's final generation check after this await returns.
            return _PreparedAskSession(self, viewer.principal, dict(data), dict(agent), title, budget, cap_scope)
        goal_args = (agent["swarm_id"], title, str(data.get("detail") or "")[:4000])
        if purpose == "ask" and agent.get("status") not in ("awake", "starting"):
            # an Ask thread on a mind that is not running (a conductor turn, which never wakes or uses it; a personal
            # mind, P2): its goal is recorded without the assignment note, which would wake the mind (send_to_agent)
            goal = self.hive.goals._create_record(*goal_args, created_by=viewer.principal, assignee=agent["id"])
        else:
            goal = await self.hive.goals.create(*goal_args, created_by=viewer.principal, assignee=agent["id"])
        return self._install(viewer, data, agent, title, budget, purpose, cap_scope, goal)

    def commit_prepared_ask(self, viewer, prepared):
        """Inside Ask's final short transaction and swarm fence; never awaits.

        Ordinary session creation keeps its existing goal announcement path.
        A P1 Ask goal is bookkeeping only: the admitted Ask delivery is its
        one prompt, so no earlier assignment note can escape a refused turn.
        """
        if (not isinstance(prepared, _PreparedAskSession) or prepared.manager is not self
                or prepared.principal != viewer.principal or not self.hive.db._conn.in_transaction):
            raise self.hive.error(409, "not_available", "the prepared Ask thread is unavailable")
        agent = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (prepared.agent["id"],))
        if agent is None or agent.get("swarm_id") != prepared.agent["swarm_id"]:
            raise self.hive.error(409, "not_available", "the prepared Ask mind changed")
        self.studio_free(agent["id"])
        self.payer_free(agent["id"], viewer.principal, "ask")
        goal = self.hive.goals._create_record(agent["swarm_id"], prepared.title,
                    str(prepared.data.get("detail") or "")[:4000], created_by=viewer.principal,
                    assignee=agent["id"], emit=False)
        self.hive.db.after_commit(lambda: self.hive.goals._emit(goal["id"]))
        return self._install(viewer, prepared.data, agent, prepared.title, prepared.budget,
                             "ask", prepared.cap_scope, goal)

    def _install(self, viewer, data, agent, title, budget, purpose, cap_scope, goal):
        rooms = self.hive.rooms
        room = {"id": new_id("r"), "kind": "session", "name": title[:80], "topic": f"Session with {agent['name']}",
                "owner": viewer.principal, "visibility": "private", "shared_with": "[]", "alias": None,
                "swarm_id": None, "settings": json.dumps({"minds_follow": True}), "seq": 0,
                "created_at": now(), "updated_at": now(), "archived": 0}
        spent = float(self.hive._agent_row(agent["id"])["spent_usd"] or 0)   # stored, not the view's rounding (r6)
        workspace = data.get("workspace")
        s = {"id": new_id("se"), "room_id": room["id"], "agent_id": agent["id"], "goal_id": goal["id"], "owner": viewer.principal,
             "title": title, "status": "active", "budget_usd": budget, "spent_at_start": spent, "prev_limit": None,
             "set_limit": None, "workspace": json.dumps(workspace) if isinstance(workspace, dict) else None,
             "created_at": now(), "ended_at": None, "purpose": purpose,
             "cap_scope": "thread" if (purpose == "ask" and cap_scope == "thread") else None, "carried_usd": 0.0}
        try:
            with self.hive.db.transaction():   # the room, the session and the mind's composed cap commit together
                self.studio_free(agent["id"])
                self.payer_free(agent["id"], viewer.principal, purpose)
                self.hive.db.insert("rooms", room)
                rooms._add(room["id"], viewer.principal, "owner")
                rooms._add(room["id"], f"agent:{agent['id']}")
                self.hive.db.insert("work_sessions", s)
                base, installed = self._compose(agent["id"])
                self.hive.db.execute("UPDATE work_sessions SET prev_limit = ?, set_limit = ? WHERE id = ?", (base, installed, s["id"]))
        except Exception:
            self.hive.db.execute("UPDATE goals SET status = 'cancelled', updated_at = ? WHERE id = ?", (now(), goal["id"]))
            raise
        self.hive.db.after_commit(lambda: rooms._event(room["id"], "created"))
        return self.view(s)

    def end(self, viewer, session_id):
        s = self._row(viewer, session_id)
        if s["status"] != "active":
            return self.view(s)
        from .media import open_liabilities
        with self.hive.db.transaction():
            # Ending restores the outer cap, which must not fund an uncertain call or a call still being admitted. Checked
            # inside the same write transaction a reservation takes (BEGIN IMMEDIATE), so a reservation either commits
            # first and is seen here, or sees this end and refuses (media.py re-checks the sessions in its transaction).
            fresh = self.hive.db.one("SELECT status FROM work_sessions WHERE id = ?", (s["id"],))
            if fresh["status"] != "active":
                return self.view(self.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (s["id"],)))
            held = open_liabilities(self.hive.db, s["agent_id"])
            if held:
                raise self.hive.error(409, "liabilities_open", "this mind has calls whose cost is not settled; a person "
                                      "resolves them before the session ends", {"reservations": held[:20]})
            # A running mind: refused only while the media route is on, and never for an Ask thread. Unconditionally it
            # would forbid ending any ordinary session on the always-awake Ask coordinator (test_ask OmegaReview B1/item 4
            # contracts); the admission race itself is closed above and in media.py for every switch position.
            mind = self.hive.db.one("SELECT status FROM agents WHERE id = ?", (s["agent_id"],))
            if (getattr(self.hive.settings, "media_route", False) and s.get("purpose") != "ask"
                    and mind and mind["status"] in ("awake", "starting")):
                raise self.hive.error(409, "mind_running", "stop or sleep the mind before ending its session: a running "
                                      "mind could start a call under the restored cap")
            self.hive.db.execute("UPDATE work_sessions SET status = 'ended', ended_at = ? WHERE id = ?", (now(), s["id"]))
            self._compose(s["agent_id"], legacy=s)
        ask = getattr(self.hive, "ask", None)
        if ask is not None:   # an Ask turn still open on this thread stops with it: the thread's cap no longer holds
            ask.thread_ended(s["id"])
        self.hive.rooms._event(s["room_id"], "updated")
        return self.view(self.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (s["id"],)))

    def end_for(self, principal):
        """host-identity r1: sign-out or revoked access ends the person's own work. Their open Ask turns stop (ask.py's
        Stop path) and each active session they own ends through end() above, so its cap is restored and nothing more is
        billed to them. Minds keep running; personal and hive minds' own work is not touched. A session end() refuses
        (unsettled calls, a running mind while the media route is on) stays active: each is returned, logged, and sent to
        admins as a ``sessions.kept`` event (r1.1), so a person sees to it."""
        from .visibility import Viewer
        ask = getattr(self.hive, "ask", None)
        if ask is not None:
            ask.cancel_for(principal)
        kept = []
        for s in self.hive.db.all("SELECT id FROM work_sessions WHERE owner = ? AND status = 'active'", (principal,)):
            try:
                self.end(Viewer("user:operator", True), s["id"])
            except Exception as exc:   # noqa: BLE001 - one refusal must not stop the rest ending
                kept.append({"session": s["id"], "code": getattr(exc, "code", type(exc).__name__)})
        if kept:
            import logging
            logging.getLogger("hive").warning("%s left: %d session(s) stay active: %s", principal, len(kept), kept)
            self.hive.events.publish("sessions.kept", principal=principal, sessions=kept)
        return kept

    def studio_free(self, agent_id):
        """J3 R4 (plan §3.6, O2-i): no Session on a mind Studio owns (a dedicated maker); inert with Studio off."""
        studio = getattr(self.hive, "studio", None)
        if studio is not None and studio.maker_busy(agent_id):
            raise self.hive.error(409, "coordinator_busy", "this mind is making a Studio piece right now; try again when "
                                  "that session ends")

    def payer_free(self, agent_id, principal, purpose=None):
        """One payer person per mind at a time (OmegaReview Ask B1): Hive.payer_for cannot tell whose work a model call
        is, so an ordinary session is refused while another person's ordinary session or open Ask turn is on the mind.
        Ask threads (purpose 'ask') are checked per turn by ask.py instead; an idle Ask thread pays for nothing."""
        if purpose == "ask" or not str(principal).startswith("user:u_"):
            return
        other = self.hive.db.one("SELECT 1 FROM work_sessions WHERE agent_id = ? AND status = 'active' AND (purpose IS NULL OR purpose != 'ask') "
                                 "AND owner LIKE 'user:u\\_%' ESCAPE '\\' AND owner != ?", (agent_id, principal))
        from .ask import OPEN_HOST_MIND, states_sql
        turn = self.hive.db.one(f"SELECT 1 FROM ask_turns WHERE mind_id = ? AND state IN {states_sql(OPEN_HOST_MIND)} AND principal != ?",
                                (agent_id, principal)) if getattr(self.hive, "ask", None) else None
        if other or turn:
            raise self.hive.error(409, "payer_conflict", "another person is working with this mind right now; try again when they finish")

    def _write_cap(self, agent_id, limit, note):
        scope = f"agent:{agent_id}"
        rule = self.hive.db.one("SELECT id FROM budgets WHERE scope = ? AND period = 'total'", (scope,))
        if limit is None:
            if rule:
                self.hive.db.execute("DELETE FROM budgets WHERE id = ?", (rule["id"],))
        elif rule:
            self.hive.db.execute("UPDATE budgets SET limit_usd = ?, note = ? WHERE id = ?", (float(limit), note, rule["id"]))
        else:
            self.hive.db.insert("budgets", {"id": new_id("b"), "scope": scope, "period": "total", "limit_usd": float(limit),
                                            "note": note, "created_at": now()})

    def _compose(self, agent_id, legacy=None):
        """Call inside a transaction. Make the mind's total rule min(base, every active session's cap), or the base again
        when none is active. Returns (base, installed); installed is None while the base itself is the tighter rule."""
        db = self.hive.db
        rule = db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{agent_id}",))
        current = float(rule["limit_usd"]) if rule else None
        own = db.one("SELECT * FROM session_caps WHERE agent_id = ?", (agent_id,))
        if own is None and legacy is not None and legacy.get("set_limit") is not None and _same(current, legacy["set_limit"]):
            own = {"base_limit": legacy["prev_limit"], "installed": legacy["set_limit"]}   # a session from before session_caps
        ours = own is not None and own["installed"] is not None and _same(current, own["installed"])
        base = own["base_limit"] if ours else current   # a rule changed by anyone else since our install is the base now
        # integer micro-dollars, each input floored once: a cap never exceeds its exact inputs (OmegaReview r7)
        caps = [to_micros(r["spent_at_start"]) + to_micros(r["budget_usd"])
                for r in db.all("SELECT spent_at_start, budget_usd FROM work_sessions WHERE agent_id = ? AND status = 'active' "
                                "AND (cap_scope IS NULL OR cap_scope != 'thread')", (agent_id,))]   # an own-scope thread: never
        if not caps:
            if ours:
                self._write_cap(agent_id, base, "restored after session")
            db.execute("DELETE FROM session_caps WHERE agent_id = ?", (agent_id,))
            return base, None
        cap = dollars(min(caps))
        installed = None
        if base is None or cap < base:
            installed = cap
            if not _same(current, cap):
                self._write_cap(agent_id, cap, "session cap")
        elif ours:
            self._write_cap(agent_id, base, "restored after session")
        db.execute("INSERT INTO session_caps VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET base_limit = excluded.base_limit, "
                   "installed = excluded.installed, updated_at = excluded.updated_at", (agent_id, base, installed, now()))
        return base, installed

    # ---- ask-limits r1: an Ask thread's own cap ------------------------------------------------------------------------

    def thread_spent(self, s):
        """An own-scope thread's settled spend: the settled cost of every reservation under its scope (the one
        authoritative source, in whatever state it settled: a call settled late after a release counts the same), plus
        carried_usd, only what no reservation accounts for (_carried). Open holds are not spend; a reservation counts them against the scope
        itself (Reservations.pending), so a cap is never exceeded by calls still in flight."""
        from .cost_reservations import settled_usd   # gateway r1a: Reservations.settled, the one source (T-SET)
        return float(s.get("carried_usd") or 0) + settled_usd(self.hive.db, thread_scope(s["id"]))

    def thread_held(self, s):
        """An own-scope thread's open holds (reserved, dispatched or unknown calls under its scope), in USD: what a
        reservation counts beside its spend (Reservations.pending of the exact label). r1.1 (Kimi P2): admission measures
        spend plus these, the same quantity the reservation does."""
        db = self.hive.db
        if not db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_reservation_scopes'"):
            return 0.0
        return db.one("SELECT COALESCE(SUM(r.maximum), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
                      "ON c.reservation = r.id WHERE c.scope = ? AND r.state IN ('reserved', 'dispatched', 'unknown')",
                      (thread_scope(s["id"]),))["n"] / 1_000_000

    def rescope(self, agent_id, to, session_id=None):
        """Move active Ask threads on this mind to their own scope ('thread') or back to the mind's rule ('mind'), spend
        carried over, then recompose the mind's rule; returns the ids moved. To 'thread' (a conductor turn is admitted on
        the mind): every 'mind' Ask thread on it with no turn of the mind's own still open; each carries what it has
        spent so far: every reservation its old cap counted is put under its own scope first (_attribute, r1.1/r1.2), so no
        hold or settlement, however late, is dropped, and _carried adds only what no reservation accounts for. To 'mind' (a turn the mind itself
        will answer): only session_id, restarted on the mind's measure at its own spend so far. That sets spent_at_start to
        mind spend now minus the thread's spend, which may be lower than before: deliberate, so the thread's own spend is
        counted once and spend the mind made on other work while the thread had its own scope is not charged to it."""
        from .ask import OPEN_HOST_MIND, states_sql
        db = self.hive.db
        moved = []
        with db.transaction():
            mind = self.hive._agent_row(agent_id) if db.one("SELECT 1 FROM agents WHERE id = ?", (agent_id,)) else None
            mind_spent = float((mind or {}).get("spent_usd") or 0)
            if to == "thread":
                rows = db.all("SELECT * FROM work_sessions w WHERE agent_id = ? AND status = 'active' AND purpose = 'ask' "
                              "AND (cap_scope IS NULL OR cap_scope != 'thread') AND NOT EXISTS (SELECT 1 FROM ask_turns t "
                              f"WHERE t.thread_id = w.id AND t.state IN {states_sql(OPEN_HOST_MIND)})", (agent_id,))
                for r in rows:
                    self._attribute(r)
                    carried = self._carried(r, mind_spent)
                    db.execute("UPDATE work_sessions SET cap_scope = 'thread', carried_usd = ? WHERE id = ?", (carried, r["id"]))
                    moved.append(r["id"])
            elif to == "mind" and session_id:
                r = db.one("SELECT * FROM work_sessions WHERE id = ? AND agent_id = ? AND status = 'active' AND cap_scope = 'thread'",
                           (session_id, agent_id))
                if r is not None:
                    db.execute("UPDATE work_sessions SET cap_scope = NULL, carried_usd = 0, spent_at_start = ? WHERE id = ?",
                               (mind_spent - self.thread_spent(r), r["id"]))
                    moved.append(r["id"])
            if moved:
                self._compose(agent_id)
        return moved

    def _carried(self, r, mind_spent):
        """What a thread moving to its own scope carries beyond its own scope's reservations, called after _attribute has
        labelled them. r1.2: the thread's spend has one authoritative source, the settled cost of every reservation under
        askthread:<id> (thread_spent), and carried_usd is only what no reservation can account for.
        - Every turn answered by the conductor: 0. Each of its calls was reserved under askturn:<turn>, and _attribute has
          labelled all of them, in every state, so whatever settled, settles or settles late after a release is counted
          there once.
        - Any turn the mind answered itself: the mind's spend since the thread started (the old rule's measure; those
          calls have no other), minus the settled cost already under the label, which that spend includes (each settle
          records usage on the mind), so it is not counted twice. A labelled call not yet settled is not in the mind's
          spend yet; it is counted by the label when it settles."""
        db = self.hive.db
        if not db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_reservation_scopes'"):
            return max(0.0, mind_spent - float(r["spent_at_start"]))
        if not self._mixed(r):
            return 0.0
        return max(0.0, mind_spent - float(r["spent_at_start"]) - self.thread_spent({**dict(r), "carried_usd": 0}))

    def _mixed(self, r):
        """Whether the mind itself answered a turn of this thread (its calls cannot be told apart by thread). A conductor
        turn never reached the mind, and neither did a browser turn (gateway r1b: route 'browser_mind')."""
        db = self.hive.db
        if "route" in {c["name"] for c in db.all("PRAGMA table_info(ask_turns)")}:
            return bool(db.one("SELECT 1 FROM ask_turns WHERE thread_id = ? AND conductor_model IS NULL "
                               "AND (route IS NULL OR route != 'browser_mind')", (r["id"],)))
        return bool(db.one("SELECT 1 FROM ask_turns WHERE thread_id = ? AND conductor_model IS NULL", (r["id"],)))

    def _attribute(self, r):
        """Before a thread leaves the mind's rule, label with its own scope (askthread:<id>) every reservation the old rule
        counted for it and that can still change its spend (r1.1 open holds; r1.2 every state, stand-in P1):
        - always, every call of its own conductor turns (askturn:<turn>), in any state: reserved, dispatched, unknown,
          released (a released call can still settle late: Reservations.settle) and settled;
        - with mixed history, also every hold the mind's total rule counted and that is not settled yet (reserved,
          dispatched, unknown or released; subject agent:<id>, '*', or no subjects: Reservations.pending), since those calls
          cannot be told apart by thread, except a call labelled with another Ask turn (askturn:<x>, x not a turn of
          this thread) or another thread (askthread:<y>): that one is attributable there and is left alone (MacBook-Hive
          pack, release_* controls). Settled ones are already in the mind's spend that _carried carries.
        Conservative: a hold that turns out to be other work counts against this thread, as it did against the old rule.
        A label is a scope row (INSERT OR IGNORE), so a reservation counts once however many times it is labelled.
        r1.3 (stand-in P1 on r1.2): a label this sweep adds is also recorded in ask_shared_holds, so it stays distinct from
        real call attribution; every mixed thread on the mind takes the ambiguous hold, each exactly once, in any order
        (over-counting across threads is conservative; the old per-thread rules each counted it too)."""
        db = self.hive.db
        if not db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_reservation_scopes'"):
            return
        label = thread_scope(r["id"])
        db.execute("INSERT OR IGNORE INTO cost_reservation_scopes(reservation, scope) SELECT DISTINCT c.reservation, ? "
                   "FROM cost_reservation_scopes c JOIN ask_turns t ON c.scope = 'askturn:' || t.id WHERE t.thread_id = ?",
                   (label, r["id"]))
        if self._mixed(r):
            # the ambiguous holds: what the mind's total rule counted, not settled yet, and not attributable elsewhere. A call
            # labelled with another Ask turn, or with another thread by real attribution, belongs there and is left alone;
            # another thread's migration label (ask_shared_holds, r1.3) is not attribution, so the hold stays this
            # thread's too, whatever order the threads move in.
            ambiguous = ("SELECT r.id FROM cost_reservations r "
                         "WHERE r.state IN ('reserved', 'dispatched', 'unknown', 'released') AND (EXISTS (SELECT 1 FROM "
                         "cost_reservation_subjects j WHERE j.reservation = r.id AND j.subject IN (?, '*')) OR NOT EXISTS "
                         "(SELECT 1 FROM cost_reservation_subjects j WHERE j.reservation = r.id)) "
                         "AND NOT EXISTS (SELECT 1 FROM cost_reservation_scopes o WHERE o.reservation = r.id AND ("
                         "(o.scope LIKE 'askturn:%' AND o.scope NOT IN (SELECT 'askturn:' || t.id FROM ask_turns t WHERE t.thread_id = ?)) "
                         "OR (o.scope LIKE 'askthread:%' AND o.scope != ? AND NOT EXISTS (SELECT 1 FROM ask_shared_holds m "
                         "WHERE m.reservation = o.reservation AND o.scope = 'askthread:' || m.thread_id))))")
            args = ("agent:" + r["agent_id"], r["id"], label)
            # record the migration label first, only where the thread does not already hold the call by real attribution
            # (its own turn's call, labelled above), so a real label is never downgraded to a shared one
            db.execute("INSERT OR IGNORE INTO ask_shared_holds(reservation, thread_id, created_at) SELECT a.id, ?, ? FROM ("
                       + ambiguous + ") a WHERE NOT EXISTS (SELECT 1 FROM cost_reservation_scopes c WHERE c.reservation = a.id "
                       "AND c.scope = ?)", (r["id"], now(), *args, label))
            db.execute("INSERT OR IGNORE INTO cost_reservation_scopes(reservation, scope) SELECT a.id, ? FROM (" + ambiguous + ") a",
                       (label, *args))

    def adopt_ask_threads(self):
        """At boot (r1.1: whether or not the conductor is on; a turn the mind answers moves its own thread back): every
        mind's active Ask threads move to their own scope (rescope 'thread'), so a
        stale thread's rule left by an earlier build stops holding the mind and a person's own limit is back in force."""
        moved = []
        for r in self.hive.db.all("SELECT DISTINCT agent_id FROM work_sessions WHERE status = 'active' AND purpose = 'ask' "
                                  "AND (cap_scope IS NULL OR cap_scope != 'thread')"):
            moved += self.rescope(r["agent_id"], "thread")
        return moved

    def ask_threads(self, agent_id):
        """The mind's active own-scope Ask threads with their caps and spend, for the Limits page (reported apart from the
        mind's own limit, which they never change)."""
        out = []
        for s in self.hive.db.all("SELECT * FROM work_sessions WHERE agent_id = ? AND status = 'active' AND purpose = 'ask' "
                                  "AND cap_scope = 'thread' ORDER BY created_at", (agent_id,)):
            out.append({"id": s["id"], "owner": s["owner"], "key": thread_scope(s["id"]), "budget_usd": float(s["budget_usd"]),
                        "spent_usd": round(self.thread_spent(s), 6), "created_at": s["created_at"]})
        return out

    def timeline(self, viewer, session_id):
        """Messages, the mind's steps and its approval requests since the session began, oldest first."""
        s = self._row(viewer, session_id)
        until = s["ended_at"] or "9999"
        items = [{"type": "message", "at": m["created_at"], **m}
                 for m in self.hive.rooms.messages(viewer, s["room_id"], 0, 500)]
        for t in self.hive.db.all("SELECT * FROM traces WHERE agent_id = ? AND created_at >= ? AND created_at <= ? "
                                  "ORDER BY created_at LIMIT ?", (s["agent_id"], s["created_at"], until, MAX_TIMELINE)):
            steps = [c for c in json.loads(t["commands"] or "[]") if not str(c.get("command", "")).startswith(("(pin", "(wait"))]
            if steps:
                items.append({"type": "step", "at": t["created_at"], "iteration": t["iteration"],
                              "steps": [{"command": c.get("command", "")[:600], "result": str(c.get("result", ""))[:1200],
                                         "gated": c.get("gated")} for c in steps]})
        for a in self.hive.db.all("SELECT * FROM approvals WHERE agent_id = ? AND created_at >= ? AND created_at <= ? "
                                  "ORDER BY created_at", (s["agent_id"], s["created_at"], until)):
            items.append({"type": "approval", "at": a["created_at"], "id": a["id"], "skill": a["skill"],
                          "command": a["command"][:600], "reason": a["reason"], "risk": a["risk"], "status": a["status"]})
        items.sort(key=lambda i: i["at"])
        return {"session": self.view(s), "items": items[-MAX_TIMELINE:]}
