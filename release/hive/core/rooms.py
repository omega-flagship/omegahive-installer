"""Rooms: DMs, groups, channels and projects as one thing (R15).

A room has members (people `user:...`, minds `agent:a_...`) and one transcript. Its kind is a preset:
- dm:      exactly two members; minds in it answer every message
- group:   invite-only
- channel: listed for whoever may see it (private/shared/public, as R13) and joinable by them
- project: a group with work attached (step 4)
Changing the kind later keeps the room, its members and its whole history (step 3).

Cost: every message a mind receives can cost a model call, so rooms deliver deliberately.
- A person's message reaches the minds it @mentions; in a DM, the one mind. With `minds_follow` on, it reaches every
  mind member.
- A mind's message reaches only the minds it @mentions, and only while the run of mind messages since the last person
  spoke is under `turn_cap` (default 3). Then the room waits for a person, and says so once.
- A mind receives the new message plus a short digest of what it missed in that room (at most DIGEST_LINES lines of
  DIGEST_CHARS characters), never the whole history.
- Minds that are not addressed are not woken.
The Coffee Room (Jon, 2026-10-06; PLATFORM_COFFEE_ROOM_PLAN_20261006.md): one built-in room per hive
(kind "coffee", alias "coffee") that every person and every eligible mind belongs to automatically, so everyone has
somewhere to meet and then break off (a DM or group created with `origin` links back to the message it came from).
- Public minds in public swarms join; a private or shared mind or swarm joins only if an admin opts it in; an admin may
  opt any mind out; app modules never join.
- It wakes no one by itself: @mentions as in any room; "@here" from a person also reaches up to HERE_MAX awake minds.
- An awake mind may post an unprompted note (note=true) at most once per NOTE_SECONDS; a note never wakes anyone.
- Everyone signed in to the hive can read it, and minds are told so on every delivery.
Team rooms (Jon, 2026-10-08, after "Patswarm": minds in one swarm had no way to reach each other): every unarchived
swarm has one private group room (alias team_<swarm>, bound by swarm_id) holding its owner and its minds, made with the
swarm and kept in step as minds join, leave, move or are deleted, and as the swarm is renamed or changes owner. It follows
every room rule: a mind's post reaches only the minds it @mentions, under the turn cap. A mind joins only if the swarm's
owner may see it, and the only people in it are that owner and admins who open it (seeing a shared or public swarm is not
membership), so the room reveals nothing to anyone. Its shape is the hive's, not the owner's: visibility, kind, name,
settings and members cannot be edited (the topic can). A retired (archived) swarm's team room stays open
with its history for the minds still in that swarm (retired is not quiet): nothing joins it, but minds that move away or are
deleted, and people who may no longer be there, still leave. A deleted swarm's team room is archived. A room that already
holds the alias but is not this swarm's is never adopted; that, and a team room archived by hand, is logged once and
shown on the Health page for the swarm's minds. The only way into a team room is the room itself: a direct message never
lands there, and a delivery re-checks, under the team lock, that the mind still belongs before it is sent.
Delivery uses the existing per-mind message path with the room's id as the conversation, so a mind's ordinary reply
lands back in the room. The one-to-one chats that existed before rooms are DM rooms (alias c_<mind>), history kept.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import threading

from .db import new_id, now

#: who Health is in a mind's messages (health.py reads it from here: it imports rooms, never the other way round)
HEALTH_SENDER = "hive:health"

log = logging.getLogger("hive")

KINDS = ("dm", "group", "channel", "project", "session", "coffee")
LEVELS = ("private", "shared", "public")
MAX_TEXT = 8000
MAX_MEMBERS = 200
TURN_CAP = 3
DIGEST_LINES = 8
DIGEST_CHARS = 300
COFFEE = "coffee"                 # the Coffee Room's kind and alias
COFFEE_MAX_MEMBERS = 2000
HERE_MAX = 5                      # "@here" reaches at most this many awake minds
NOTE_SECONDS = 3600               # one unprompted note per mind per hour
COFFEE_NOTICE = "Everyone in the hive can read the Coffee Room; keep private memory out of it."
TEAM = "team_"                    # a swarm's team room has the alias team_<swarm id>
TEAM_MINDS = ("omega", "iter")    # minds, not outside members or app modules
# A swarm's room is shown as "<swarm> room" with this topic (host-wording r1: a swarm is never called a team). Rooms made
# before r1 were stored as "<swarm> team" with LEGACY_TEAM_TOPIC; their rows are never rewritten for the wording: they are
# shown in the new words (shown_room) and the sync accepts the old stored name as current (team_room_names).
TEAM_ROOM_TOPIC = "Your swarm's own room: minds reach each other here with @Name."
LEGACY_TEAM_TOPIC = "Your swarm's team room: minds reach each other here with @Name."
LEGACY_TEAM_SUFFIX = " team"


def team_room_names(swarm_name):
    """(the name a swarm's room is given now, the name it was given before r1), both cut to 80 like every room name."""
    return f"{swarm_name} room"[:80], f"{swarm_name}{LEGACY_TEAM_SUFFIX}"[:80]

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', shared_with TEXT NOT NULL DEFAULT '[]', alias TEXT UNIQUE,
  swarm_id TEXT, settings TEXT NOT NULL DEFAULT '{}', seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL, member TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0, delivered_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member))""",
    "CREATE INDEX IF NOT EXISTS room_members_member ON room_members(member)",
    """CREATE TABLE IF NOT EXISTS coffee_prefs (agent_id TEXT PRIMARY KEY, choice TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS room_messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
  sender TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', delivered_to TEXT NOT NULL DEFAULT '[]',
  mind_run INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (room_id, seq))""",
]


def _member(m):
    m = str(m or "").strip()
    if m.startswith("agent:a_") or m.startswith("user:"):
        if len(m) <= 100:
            return m
    raise ValueError(f"a member is a person (user:...) or a mind (agent:a_...), not {m[:40]!r}")


def _compact(name):
    """A name with case, spaces and punctuation left out, for matching @mentions typed without them."""
    return re.sub(r"[\W_]+", "", str(name).lower())


class Rooms:
    def __init__(self, hive):
        self.hive = hive
        self._coffee_lock = threading.Lock()     # one membership sync at a time: a stale snapshot can never be applied
        self._team_lock = threading.Lock()       # the same for team rooms
        self._team_warned = set()                # (swarm, problem) already logged: a wedged room is logged once
        for s in SCHEMA:
            hive.db.execute(s)
        self._add_column("rooms", "origin", "TEXT")
        self._add_column("room_messages", "note", "INTEGER NOT NULL DEFAULT 0")
        self._add_column("room_messages", "here_reached", "TEXT NOT NULL DEFAULT '[]'")
        # sol and Kimi on 7cf0ca57: a mirrored copy's provenance (the messages row it copies) and Health's verified mark
        self._add_column("room_messages", "source_message_id", "TEXT")
        self._add_column("room_messages", "health_check", "INTEGER NOT NULL DEFAULT 0")
        self._migrate_dms()
        try:
            self.sync_teams()      # existing swarms gain their team room (idempotent; each swarm on its own)
        except Exception:   # noqa: BLE001  -- never stops the hive starting; the next mind or swarm change retries
            log.exception("swarm room sync failed at startup")

    def _add_column(self, table, column, decl):
        if column not in {c["name"] for c in self.hive.db.all(f"PRAGMA table_info({table})")}:
            self.hive.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

    # ---- records -----------------------------------------------------------------------------------

    def _coffee_fresh(self, room_id):
        """row(), with the Coffee Room created on first use and its membership current (people and minds come and go)."""
        if str(room_id) == COFFEE:
            return self.ensure_coffee()
        r = self.row(room_id)
        if r["kind"] == COFFEE:
            self.sync_coffee(r)
        return r

    def row(self, room_id):
        r = self.hive.db.one("SELECT * FROM rooms WHERE id = ? OR alias = ?", (str(room_id), str(room_id)))
        if r is None or r["archived"]:
            raise self.hive.error(404, "not_found", "no such room")
        return r

    def members(self, room_id):
        return self.hive.db.all("SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at", (room_id,))

    def _is_member(self, room_id, member):
        return self.hive.db.one("SELECT 1 FROM room_members WHERE room_id = ? AND member = ?", (room_id, member)) is not None

    def view(self, r, viewer=None):
        members = self.members(r["id"])
        out = {k: r[k] for k in ("id", "kind", "name", "topic", "owner", "visibility", "swarm_id", "seq", "created_at", "updated_at")}
        out["name"], out["topic"] = self.shown_room(r)
        if r["kind"] == COFFEE:
            out["alias"] = COFFEE
        out["shared_with"] = json.loads(r["shared_with"])
        out["settings"] = self._settings(r)
        name = self._display(r)
        out["members"] = [{"member": m["member"], "role": m["role"], "name": name(m["member"])} for m in members]
        out["origin"] = json.loads(r["origin"]) if r["origin"] else None
        out["pinned"] = r["kind"] == COFFEE
        if viewer is not None:
            me = next((m for m in members if m["member"] == viewer.principal), None)
            out["unread"] = max(0, r["seq"] - me["read_seq"]) if me else 0
            out["joined"] = me is not None
            out["me"] = viewer.principal
        return out

    def _settings(self, r):
        s = json.loads(r["settings"] or "{}")
        return {"minds_follow": bool(s.get("minds_follow", False)), "turn_cap": int(s.get("turn_cap", TURN_CAP))}

    def _name(self, member):
        if member.startswith("agent:"):
            a = self.hive.db.one("SELECT name FROM agents WHERE id = ?", (member[6:],))
            return a["name"] if a else member
        if member.startswith("user:u_"):
            p = self.hive.db.one("SELECT * FROM people WHERE id = ?", (member[5:],))
            if p:
                return p.get("name") or p.get("email") or member
        if member.startswith("system:"):
            return "Hive" if member == "system:hive" else member[7:].capitalize()
        if member == HEALTH_SENDER:
            return "Health"
        return "You" if member == "user:operator" else member[5:]

    def _display(self, r):
        """How members are named in room r: by name only in the Coffee Room (never an email), as usual elsewhere."""
        return self._public_name if r["kind"] == COFFEE else self._name

    def _public_name(self, member):
        """In the Coffee Room a person is shown by name only, never by email (the whole hive reads it)."""
        if member.startswith("user:u_"):
            p = self.hive.db.one("SELECT name FROM people WHERE id = ?", (member[5:],))
            return (p["name"] if p and p["name"] else "Member")
        return self._name(member)

    # ---- who sees what --------------------------------------------------------------------------------

    def can_see(self, viewer, r):
        if viewer.admin or self._is_member(r["id"], viewer.principal) or r["kind"] == COFFEE:
            return True             # the Coffee Room is for everyone signed in to this hive
        if r["kind"] != "channel":
            return False          # DMs and groups are for their members only
        if r["visibility"] == "public":
            return True
        return r["visibility"] == "shared" and viewer.principal in json.loads(r["shared_with"])

    def get(self, viewer, room_id):
        r = self._coffee_fresh(room_id)
        if not self.can_see(viewer, r):
            raise self.hive.error(404, "not_found", "no such room")
        return r

    def list(self, viewer):
        self.ensure_coffee()
        rows = self.hive.db.all("SELECT * FROM rooms WHERE archived = 0 ORDER BY updated_at DESC")
        rows = self.hive.visibility.hide_others_personal(viewer, [r for r in rows if self.can_see(viewer, r)],
                                                         lambda r: self._personal_ids(viewer, r))
        return [self.view(r, viewer) for r in rows]

    def _personal_ids(self, viewer, r):
        """The swarm and mind ids that make a room someone's personal room (for an admin's default list): none when the
        admin could see the room as a member; otherwise its swarm and its mind members."""
        from .visibility import Viewer
        if self.can_see(Viewer(viewer.principal, False), r):
            return []
        return [r.get("swarm_id")] + [m["member"][6:] for m in self.members(r["id"]) if m["member"].startswith("agent:")]

    # ---- creating and membership ----------------------------------------------------------------------

    def create(self, viewer, data):
        kind = data.get("kind", "group")
        if kind == "session":
            raise self.hive.error(400, "bad_request", "start a session from Sessions; it binds a task and a budget")
        if kind not in KINDS:
            raise self.hive.error(400, "bad_request", f"kind is one of {', '.join(KINDS)}")
        if kind == COFFEE:
            raise self.hive.error(400, "bad_request", "the hive has one Coffee Room already")
        origin = self._origin(viewer, data.get("origin"))
        try:
            others = [_member(m) for m in (data.get("members") or [])]
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc))
        others = [m for m in dict.fromkeys(others) if m != viewer.principal]
        for m in others:
            self._check_exists(m)
        if kind == "dm":
            if len(others) != 1:
                raise self.hive.error(400, "bad_request", "a DM is you and one other member")
            return self.dm(viewer.principal, others[0], origin=origin)
        if len(others) + 1 > MAX_MEMBERS:
            raise self.hive.error(400, "bad_request", f"a room holds at most {MAX_MEMBERS} members")
        visibility = data.get("visibility", "private")
        if visibility not in LEVELS:
            raise self.hive.error(400, "bad_request", f"visibility is one of {', '.join(LEVELS)}")
        name = str(data.get("name") or "").strip()[:80]
        if not name:
            raise self.hive.error(400, "bad_request", "a room needs a name")
        room = {"id": new_id("r"), "kind": kind, "name": name, "topic": str(data.get("topic") or "")[:500],
                "owner": viewer.principal, "visibility": visibility, "shared_with": "[]", "alias": None, "swarm_id": None,
                "settings": json.dumps(self._clean_settings(data.get("settings") or {})), "seq": 0,
                "created_at": now(), "updated_at": now(), "archived": 0, "origin": origin}
        self.hive.db.insert("rooms", room)
        self._add(room["id"], viewer.principal, "owner")
        for m in others:
            self._add(room["id"], m)
        self._event(room["id"], "created")
        return self.view(self.row(room["id"]), viewer)

    def _origin(self, viewer, origin):
        """A room started from a message ("Talk privately" / "Start a group") remembers where it came from. Only a
        message the creator can see may be named; the link grants nothing."""
        if origin in (None, {}, ""):
            return None
        if not isinstance(origin, dict) or set(origin) != {"room_id", "message_id"}:
            raise self.hive.error(400, "bad_request", "origin is {room_id, message_id}")
        r = self.get(viewer, str(origin["room_id"]))
        m = self.hive.db.one("SELECT id FROM room_messages WHERE id = ? AND room_id = ?", (str(origin["message_id"]), r["id"]))
        if m is None:
            raise self.hive.error(404, "not_found", "no such message in that room")
        return json.dumps({"room_id": r["id"], "message_id": m["id"]})

    def dm(self, a, b, origin=None):
        """The one DM between two members (created on first use; an origin is kept only on creation)."""
        pair = sorted([a, b])
        existing = self.hive.db.one(
            "SELECT r.* FROM rooms r JOIN room_members x ON x.room_id = r.id AND x.member = ? "
            "JOIN room_members y ON y.room_id = r.id AND y.member = ? WHERE r.kind = 'dm' AND r.archived = 0",
            (pair[0], pair[1]))
        if existing:
            return self.view(existing)
        room = {"id": new_id("r"), "kind": "dm", "name": "", "topic": "", "owner": a, "visibility": "private",
                "shared_with": "[]", "alias": None, "swarm_id": None, "settings": "{}", "seq": 0,
                "created_at": now(), "updated_at": now(), "archived": 0, "origin": origin}
        self.hive.db.insert("rooms", room)
        self._add(room["id"], a, "owner")
        self._add(room["id"], b)
        return self.view(self.row(room["id"]))

    def _add(self, room_id, member, role="member"):
        self.hive.db.execute("INSERT OR IGNORE INTO room_members VALUES (?, ?, ?, ?, 0, 0)", (room_id, member, role, now()))
        seq = self.hive.db.one("SELECT seq FROM rooms WHERE id = ?", (room_id,))["seq"]
        # a newcomer starts at the present: no back-delivery of history it was not part of
        self.hive.db.execute("UPDATE room_members SET delivered_seq = ?, read_seq = ? WHERE room_id = ? AND member = ? AND delivered_seq = 0",
                             (seq, seq, room_id, member))

    def _check_exists(self, member):
        if member.startswith("agent:") and self.hive.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (member[6:],)) is None:
            raise self.hive.error(404, "not_found", f"no such mind {member[6:]}")

    def is_team(self, r):
        return bool(r["swarm_id"]) and r["alias"] == TEAM + str(r["swarm_id"])

    def shown_room(self, r):
        """(name, topic) as shown. Display only: a swarm's room stored before r1 as "<swarm> team" with the old default
        topic reads "<swarm> room" with the new one; the row keeps what it was written with. A topic its owner changed,
        and every other room, are shown as stored. (A swarm's room cannot be renamed by hand: its name follows the swarm.)"""
        name, topic = r["name"], r["topic"]
        if self.is_team(r):
            if name.endswith(LEGACY_TEAM_SUFFIX):
                name = name[:-len(LEGACY_TEAM_SUFFIX)] + " room"
            if topic == LEGACY_TEAM_TOPIC:
                topic = TEAM_ROOM_TOPIC
        return name, topic

    def _manage(self, viewer, r):
        if self.is_team(r):
            raise self.hive.error(400, "bad_request", "a swarm's room holds its owner and its minds; it follows the swarm")
        if r["kind"] == COFFEE:
            raise self.hive.error(400, "bad_request", "everyone is in the Coffee Room; an admin opts a mind in or out from the mind")
        if r["kind"] == "dm":
            raise self.hive.error(400, "bad_request", "a DM's members are fixed")
        if not (viewer.admin or r["owner"] == viewer.principal):
            raise self.hive.error(403, "owner_only", "only the room's owner or an admin changes its members or settings")

    def add_members(self, viewer, room_id, members):
        r = self.get(viewer, room_id)
        try:
            members = [_member(m) for m in members or []]
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc))
        joining_self = members == [viewer.principal] and r["kind"] == "channel"
        if not joining_self:
            self._manage(viewer, r)
        for m in members:
            self._check_exists(m)
        if len(self.members(r["id"])) + len(members) > MAX_MEMBERS:
            raise self.hive.error(400, "bad_request", f"a room holds at most {MAX_MEMBERS} members")
        for m in members:
            self._add(r["id"], m)
        self._touch(r["id"])
        self._event(r["id"], "members")
        return self.view(self.row(r["id"]), viewer)

    def remove_member(self, viewer, room_id, member):
        r = self.get(viewer, room_id)
        if member != viewer.principal or r["kind"] == COFFEE:
            self._manage(viewer, r)
        elif r["kind"] == "dm":
            raise self.hive.error(400, "bad_request", "a DM's members are fixed")
        if member == r["owner"]:
            raise self.hive.error(400, "bad_request", "the owner cannot leave; give the room to someone else first")
        self.hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (r["id"], member))
        self._touch(r["id"])
        self._event(r["id"], "members")
        return self.view(self.row(r["id"]), viewer)

    def _clean_settings(self, s):
        out = {}
        if "minds_follow" in s:
            out["minds_follow"] = bool(s["minds_follow"])
        if "turn_cap" in s:
            cap = s["turn_cap"]
            if not isinstance(cap, int) or isinstance(cap, bool) or not 0 <= cap <= 20:
                raise self.hive.error(400, "bad_request", "turn_cap is a whole number from 0 to 20")
            out["turn_cap"] = cap
        return out

    def update(self, viewer, room_id, data):
        r = self.get(viewer, room_id)
        if r["kind"] == COFFEE:
            if not viewer.admin or not set(data) <= {"name", "topic"}:
                raise self.hive.error(400, "bad_request", "the Coffee Room stays as it is; an admin may rename it or change its topic")
        elif r["kind"] == "dm" and set(data) <= {"kind", "name", "topic"} and data.get("kind") not in (None, "dm"):
            if not (viewer.admin or self._is_member(r["id"], viewer.principal)):
                raise self.hive.error(403, "owner_only", "only a member turns a DM into a room")
        elif self.is_team(r):
            if not set(data) <= {"topic"} or not (viewer.admin or r["owner"] == viewer.principal):
                raise self.hive.error(400, "bad_request", "a swarm's room follows its swarm; its owner or an admin may change its topic")
        elif r["kind"] != COFFEE:
            self._manage(viewer, r)
        changes = {}
        if "name" in data:
            name = str(data["name"] or "").strip()[:80]
            if not name:
                raise self.hive.error(400, "bad_request", "a room needs a name")
            changes["name"] = name
        if "topic" in data:
            changes["topic"] = str(data["topic"] or "")[:500]
        if "visibility" in data:
            if data["visibility"] not in LEVELS:
                raise self.hive.error(400, "bad_request", f"visibility is one of {', '.join(LEVELS)}")
            changes["visibility"] = data["visibility"]
        if "settings" in data:
            changes["settings"] = json.dumps({**json.loads(r["settings"] or "{}"), **self._clean_settings(data["settings"] or {})})
        if "kind" in data and data["kind"] != r["kind"]:     # step 3: a room changes kind and keeps its members and history
            kind = data["kind"]
            if kind == COFFEE:
                raise self.hive.error(400, "bad_request", "the hive has one Coffee Room; a room cannot become one")
            if kind not in KINDS:
                raise self.hive.error(400, "bad_request", f"kind is one of {', '.join(KINDS)}")
            if kind == "dm":
                raise self.hive.error(400, "bad_request", "a room cannot become a DM; start a DM instead")
            if "session" in (kind, r["kind"]):
                raise self.hive.error(400, "bad_request", "a session stays a session")
            changes["kind"] = kind
            if not (changes.get("name") or r["name"]):
                raise self.hive.error(400, "bad_request", "name the room when a DM becomes a " + kind)
        if "swarm_id" in data and data["swarm_id"] is None and r["swarm_id"]:
            changes["swarm_id"] = None                       # the swarm's chat goes on as its own room; the swarm stays
        if changes:
            changes["updated_at"] = now()
            self.hive.db.update("rooms", r["id"], changes)
            self._event(r["id"], "updated")
        return self.view(self.row(r["id"]), viewer)

    # ---- the Coffee Room -----------------------------------------------------------------------------------

    def _coffee_id(self):
        r = self.hive.db.one("SELECT id FROM rooms WHERE alias = ?", (COFFEE,))
        return r["id"] if r else None

    def ensure_coffee(self):
        """The hive's one Coffee Room, created on first use, with its membership brought up to date. Creation is
        check-and-insert under the Coffee Room lock (and INSERT OR IGNORE on the unique alias), so two first visits at
        once never collide."""
        r = self.hive.db.one("SELECT * FROM rooms WHERE alias = ?", (COFFEE,))
        if r is None:
            with self._coffee_lock:
                self._create_coffee()
            r = self.hive.db.one("SELECT * FROM rooms WHERE alias = ?", (COFFEE,))
        self.sync_coffee(r)
        return r

    def _create_coffee(self):
        if self.hive.db.one("SELECT 1 FROM rooms WHERE alias = ?", (COFFEE,)) is None:
            row = {
                "id": new_id("r"), "kind": COFFEE, "name": "Coffee Room",
                "topic": "Everyone in the hive meets here. Talk privately or start a group from any message.",
                "owner": "system:hive", "visibility": "public", "shared_with": "[]", "alias": COFFEE, "swarm_id": None,
                "settings": "{}", "seq": 0, "created_at": now(), "updated_at": now(), "archived": 0, "origin": None}
            cols = ", ".join(row)
            self.hive.db.execute(f"INSERT OR IGNORE INTO rooms ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))

    def coffee_status(self, agent):
        """'member', 'opted_out', 'private' (private or shared mind or swarm; an admin may opt it in) or 'not_a_mind'."""
        if agent["kind"] not in ("omega", "iter") or agent["deleted"]:
            return "not_a_mind"
        pref = self.hive.db.one("SELECT choice FROM coffee_prefs WHERE agent_id = ?", (agent["id"],))
        if pref:
            return "member" if pref["choice"] == "in" else "opted_out"
        # Joining by default only when both the mind and its swarm are public: the room is readable by the whole hive,
        # so a private or shared mind (or one in a private or shared swarm) is never revealed without an admin's choice.
        swarm = self.hive.db.one("SELECT visibility FROM swarms WHERE id = ?", (agent["swarm_id"],)) if agent["swarm_id"] else None
        public = agent["visibility"] == "public" and (swarm is None or swarm["visibility"] == "public")
        return "member" if public else "private"

    def set_coffee(self, agent_id, member, by):
        agent = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if agent is None:
            raise self.hive.error(404, "not_found", f"no such mind {agent_id}")
        if agent["kind"] not in ("omega", "iter"):
            raise self.hive.error(400, "bad_request", "app modules do not join the Coffee Room")
        self.hive.db.execute("INSERT INTO coffee_prefs VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET "
                             "choice = excluded.choice, by = excluded.by, at = excluded.at",
                             (agent_id, "in" if member else "out", by, now()))
        self.ensure_coffee()
        return self.coffee_status(self.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,)))

    def _coffee_wanted(self):
        wanted = {"user:operator"}
        try:
            wanted |= {f"user:{p['id']}" for p in self.hive.db.all("SELECT id FROM people WHERE disabled = 0")}
        except Exception:     # the people table may not exist yet while the hive starts
            pass
        for a in self.hive.db.all("SELECT * FROM agents WHERE deleted = 0"):
            if self.coffee_status(a) == "member":
                wanted.add(f"agent:{a['id']}")
        return wanted

    def is_coffee(self, conversation_id):
        if not conversation_id:
            return False
        r = self.hive.db.one("SELECT kind FROM rooms WHERE id = ? OR alias = ?", (str(conversation_id), str(conversation_id)))
        return r is not None and r["kind"] == COFFEE

    def sync_coffee(self, r=None):
        with self._coffee_lock, self.hive.db.transaction():   # read and applied as one change (same class as r5 P1)
            self._sync_coffee_locked(r)

    def _sync_coffee_locked(self, r=None):
        r = r or self.hive.db.one("SELECT * FROM rooms WHERE alias = ?", (COFFEE,))
        if r is None:
            return
        wanted = self._coffee_wanted()
        have = {m["member"] for m in self.members(r["id"])}
        for m in sorted(wanted - have)[:max(0, COFFEE_MAX_MEMBERS - len(have))]:
            self._add(r["id"], m)
        for m in have - wanted:
            self.hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (r["id"], m))
        if wanted != have:
            self._event(r["id"], "members")

    # ---- rooms and swarms (step 4: a channel can become a swarm, a swarm has a room) -----------------------

    def become_swarm(self, viewer, room_id, move_minds=()):
        """Make a swarm from this room. The room stays, linked as the swarm's channel; chosen mind members move in."""
        r = self.get(viewer, room_id)
        self._manage(viewer, r)            # refuses the Coffee Room too
        if r["swarm_id"]:
            raise self.hive.error(409, "already_swarm", "this room already belongs to a swarm")
        members = {m["member"] for m in self.members(r["id"])}
        moving = [str(m) for m in move_minds or []]
        for m in moving:
            if f"agent:{m}" not in members:
                raise self.hive.error(400, "bad_request", f"{m} is not a mind in this room")
        if moving and not viewer.admin:
            raise self.hive.error(403, "admin_only", "moving minds between swarms is an admin decision")
        for m in moving:   # refused before the swarm is made: a personal mind stays alone in its own swarm
            row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (m,))
            if row:
                self.hive.personal.refuse_move(row, "new")
        swarm = self.hive.create_swarm(r["name"] or "New swarm", r["topic"] or "", owner=viewer.principal,
                                       visibility=r["visibility"], shared_with=json.loads(r["shared_with"]))
        self.hive.db.update("rooms", r["id"], {"swarm_id": swarm["id"], "kind": "channel" if r["kind"] == "dm" else r["kind"],
                                               "updated_at": now()})
        for m in moving:
            self.hive.update_agent(m, {"swarm_id": swarm["id"]})
        self._event(r["id"], "updated")
        return {"room": self.view(self.row(r["id"]), viewer), "swarm": self.hive.swarm(swarm["id"])}

    def swarm_room(self, viewer, swarm_id):
        """The room the swarm is talked to in as a group: its team room, or an older channel bound to it while the team room
        is healthy. With no healthy team room it refuses (409, naming the repair) rather than make a room of its own."""
        swarm = self.hive.swarm(swarm_id)
        r = self.hive.db.one("SELECT * FROM rooms WHERE swarm_id = ? AND archived = 0 AND kind IN ('channel', 'project', 'group') "
                             "ORDER BY created_at, rowid LIMIT 1", (swarm_id,))
        if r is not None and self.is_team(r):
            # Seeing the swarm is not membership (stand-in S1, Kimi K4): its owner and admins join, members read it,
            # anyone else gets "not found". A read that changes nothing announces nothing (Kimi K3).
            self.sync_team(swarm_id)
            with self._team_lock, self.hive.db.transaction():   # check and join: one change (Kimi r3 K3, r5 P1)
                r = self.row(r["id"])
                if not self._is_member(r["id"], viewer.principal):
                    if not (viewer.admin or viewer.principal == r["owner"]):
                        raise self.hive.error(404, "not_found", "no such room")
                    self._add(r["id"], viewer.principal)
                    self._touch(r["id"])
                    self._event(r["id"], "members")
            return self.view(self.row(r["id"]), viewer)
        # An older room bound to the swarm (or none, if its team room cannot be made): the same rule (Kimi K1). Its
        # members read it; only the swarm's owner or an admin joins or creates it; anyone else gets "not found".
        lead = viewer.admin or viewer.principal == (swarm.get("owner") or "user:operator")
        if r is None or self.team_problem({"kind": "omega", "swarm_id": swarm_id}):
            # No healthy team room: never fall back to making a room shared like the swarm (Kimi r4 K1). Only a swarm
            # with an older channel and a healthy team room still opens that channel.
            if not lead:
                raise self.hive.error(404, "not_found", "no such room")
            raise self.hive.error(409, "team_room_unavailable", "this swarm's room is unavailable; an admin repairs it "
                                                                f"with POST /api/swarms/{swarm_id}/team-room/repair")
        if not lead and not self._is_member(r["id"], viewer.principal):
            raise self.hive.error(404, "not_found", "no such room")
        changed = False
        owner = swarm.get("owner") or "user:operator"
        owner_admin = self._is_admin(owner)
        seen = [a["id"] for a in self.hive.db.all("SELECT * FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,))
                if self._owner_sees(owner, a, owner_admin)]   # as in the team room (Kimi r3 K4)
        for m in [f"agent:{m}" for m in seen] + [viewer.principal]:
            if not self._is_member(r["id"], m):
                self._add(r["id"], m)
                changed = True
        if changed:                 # a read that changes nothing announces nothing (Kimi K6)
            self._event(r["id"], "members")
        return self.view(self.row(r["id"]), viewer)

    # ---- team rooms: every swarm's minds can reach each other ---------------------------------------------

    def team_room(self, swarm_id):
        """The swarm's team room row (archived or not), or None."""
        return self.hive.db.one("SELECT * FROM rooms WHERE alias = ?", (TEAM + str(swarm_id),))

    def sync_teams(self):
        """Every unarchived swarm has its team room with the right minds; a deleted swarm's team room is archived. Each
        swarm on its own: one that fails is logged and left for the next sync, never stopping the rest or the hive."""
        for s in self.hive.db.all("SELECT id FROM swarms"):     # retired ones too: their rooms still lose who left
            try:
                self.sync_team(s["id"])
            except Exception:   # noqa: BLE001
                log.exception("swarm room sync failed for swarm %s; the next sync retries it", s["id"])
        for r in self.hive.db.all("SELECT id, swarm_id, alias FROM rooms WHERE alias LIKE 'team\\_%' ESCAPE '\\' AND archived = 0 "
                                  "AND NOT EXISTS (SELECT 1 FROM swarms s WHERE s.id = rooms.swarm_id)"):
            if not self.is_team(r):
                continue    # a room holding the alias that is not a team room is never ours to archive (Kimi K7)
            self.hive.db.update("rooms", r["id"], {"archived": 1, "updated_at": now()})
            log.info("swarm room %s archived: its swarm %s is gone", r["id"], r["swarm_id"])
            self._event(r["id"], "updated")

    def sync_team(self, swarm_id):
        # the roster is read and applied in one database transaction, so a move or delete (which revokes in its own
        # transaction) lands wholly before the read or wholly after the apply: a stale roster never re-adds (r5 P1)
        with self._team_lock, self.hive.db.transaction():
            return self._sync_team_locked(swarm_id)

    def _sync_team_locked(self, swarm_id):
        swarm = self.hive.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if swarm is None:
            return None
        retired = bool(swarm.get("archived_at"))   # no room is made and nobody joins; who left still leaves (stand-in R2)
        owner = swarm.get("owner") or "user:operator"
        name, legacy_name = team_room_names(swarm["name"])
        r = self.team_room(swarm_id)
        created = False
        if r is None and retired:
            return None
        if r is None:
            row = {"id": new_id("r"), "kind": "group", "name": name,
                   "topic": TEAM_ROOM_TOPIC, "owner": owner,
                   "visibility": "private", "shared_with": "[]", "alias": TEAM + swarm_id, "swarm_id": swarm_id,
                   "settings": "{}", "seq": 0, "created_at": now(), "updated_at": now(), "archived": 0, "origin": None}
            cols = ", ".join(row)
            self.hive.db.execute(f"INSERT OR IGNORE INTO rooms ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
            r = self.team_room(swarm_id)
            created = r is not None and r["id"] == row["id"]
        if r is None or not self.is_team(r) or r["swarm_id"] != swarm_id:
            # another room holds this swarm's alias (Kimi K1): never adopt it, never touch its members
            self._warn_once(swarm_id, "alias", "swarm room for swarm %s not made: room %s already holds the alias %s",
                            swarm_id, r["id"] if r else "?", TEAM + swarm_id)
            return None
        if r["archived"]:           # archived by hand: never brought back or duplicated (Kimi K3: said once)
            self._warn_once(swarm_id, "archived", "swarm room %s for swarm %s was archived by hand; its minds have no swarm room",
                            r["id"], swarm_id)
            return None
        self._team_warned -= {(swarm_id, "alias"), (swarm_id, "archived")}
        # a room stored before r1 under "<swarm> team" is current while the swarm keeps its name: never rewritten for the
        # wording alone; a renamed swarm's room takes the new form
        fix = {} if retired else {k: v for k, v in (("name", name), ("owner", owner)) if r[k] != v
                                  and not (k == "name" and r[k] == legacy_name)}
        if fix:                     # the room follows its swarm's name and owner (Kimi K2)
            self.hive.db.update("rooms", r["id"], {**fix, "updated_at": now()})
            if "owner" in fix:
                self.hive.db.execute("UPDATE room_members SET role = 'member' WHERE room_id = ? AND member = ?", (r["id"], r["owner"]))
                self.hive.db.execute("UPDATE room_members SET role = 'owner' WHERE room_id = ? AND member = ?", (r["id"], owner))
            r = self.team_room(swarm_id)
        have = {m["member"] for m in self.members(r["id"])}
        wanted, gone = set(), set()
        if self._eligible_person(owner):
            wanted.add(owner)
        owner_admin = self._is_admin(owner)
        for m in have:
            if m.startswith("user:") and m != owner and not self._is_admin(m):
                gone.add(m)         # people in it are its owner and admins only (a former owner leaves)
            elif m.startswith("agent:"):
                a = self.hive.db.one("SELECT deleted, swarm_id FROM agents WHERE id = ?", (m[6:],))
                if a is None or a["deleted"] or a["swarm_id"] != swarm_id:
                    gone.add(m)     # deleted or moved away
        for a in self.hive.db.all("SELECT * FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,)):
            if a["kind"] in TEAM_MINDS:
                if self._owner_sees(owner, a, owner_admin):
                    wanted.add(f"agent:{a['id']}")
                else:
                    gone.add(f"agent:{a['id']}")   # a mind the owner may not see never shows up in the owner's room
        for m in gone & have:
            self.hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (r["id"], m))
        left = len(have - gone)
        lead = swarm.get("coordinator_id")
        # the owner first, then the coordinator (Kimi K5), then by id; a retired swarm's room takes nobody new
        joining = [] if retired else sorted(wanted - have, key=lambda m: (m != owner, m != f"agent:{lead}", m))
        room_for = max(0, MAX_MEMBERS - left)
        if len(joining) > room_for:
            log.warning("swarm room %s for swarm %s is at the member limit (%d): %d left out: %s", r["id"], swarm_id,
                        MAX_MEMBERS, len(joining) - room_for, ", ".join(joining[room_for:][:20]))
        for m in joining[:room_for]:
            self._add(r["id"], m, "owner" if m == owner else "member")
        if created or fix or joining[:room_for] or (gone & have):
            self._touch(r["id"])
            roster = bool(joining[:room_for] or (gone & have))
            self._event(r["id"], "created" if created else "members" if roster else "updated")   # one event per change
        return r

    def repair_team(self, viewer, swarm_id):
        """An admin's remedy for a wedged team room (Kimi r3 K2): a team room archived by hand is reopened with its
        history; a room squatting on the alias keeps its members and history but gives the alias up, and the team
        room is then made. Logged and announced."""
        if not viewer.admin:
            raise self.hive.error(403, "admin_only", "only an admin repairs a swarm's room")
        swarm = self.hive.swarm(swarm_id)
        if swarm.get("archived_at"):
            raise self.hive.error(409, "swarm_archived", f"{swarm['name']} is archived; restore it first")
        with self._team_lock, self.hive.db.transaction():
            r = self.team_room(swarm_id)
            if r is not None and self.is_team(r) and r["swarm_id"] == swarm_id and r["archived"]:
                self.hive.db.update("rooms", r["id"], {"archived": 0, "updated_at": now()})
                log.warning("swarm room %s for swarm %s reopened by %s", r["id"], swarm_id, viewer.principal)
                self._event(r["id"], "updated")
            elif r is not None and not (self.is_team(r) and r["swarm_id"] == swarm_id):
                # it keeps its members and history as an ordinary room, bound to no swarm (Kimi r4 K2)
                self.hive.db.execute("UPDATE rooms SET alias = NULL, swarm_id = NULL, updated_at = ? WHERE id = ?", (now(), r["id"]))
                log.warning("room %s gave up the alias %s (repair by %s); swarm %s gets its swarm room", r["id"],
                            TEAM + swarm_id, viewer.principal, swarm_id)
                self._event(r["id"], "updated")
            r = self._sync_team_locked(swarm_id)
        if r is None:
            raise self.hive.error(409, "team_room_unavailable", "the swarm's room could not be made; see the log")
        return self.view(self.row(r["id"]), viewer)

    def revoke_team_seats(self, agent_id):
        """Called inside the transaction that moves or deletes a mind: it leaves every team room that is not its own
        swarm's in that same commit, so no stale seat lets it read, list or post there before the sync (stand-in r4 P1).
        Returns the rooms it left, to announce once the commit is done."""
        rows = self.hive.db.all("SELECT r.id FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.member = ? "
                                "WHERE r.alias = 'team_' || r.swarm_id AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = ? "
                                "AND a.deleted = 0 AND a.swarm_id = r.swarm_id)", (f"agent:{agent_id}", agent_id))
        for r in rows:
            self.hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (r["id"], f"agent:{agent_id}"))
        return [r["id"] for r in rows]

    def _warn_once(self, swarm_id, problem, message, *args):
        if (swarm_id, problem) not in self._team_warned:
            self._team_warned.add((swarm_id, problem))
            log.warning(message, *args)

    def team_problem(self, agent):
        """Why a mind has no usable team room, or None: for the Health page (Kimi K2/K3)."""
        if agent.get("kind") not in TEAM_MINDS or not agent.get("swarm_id"):
            return None
        swarm = self.hive.db.one("SELECT archived_at FROM swarms WHERE id = ?", (agent["swarm_id"],))
        if swarm is None or swarm["archived_at"]:
            return None
        r = self.team_room(agent["swarm_id"])
        if r is None:
            return "its swarm has no room yet (the last sync failed; the next mind or swarm change retries it)"
        if not self.is_team(r) or r["swarm_id"] != agent["swarm_id"]:
            return f"room {r['id']} already holds the alias {r['alias']}, so its swarm has no room"
        if r["archived"]:
            return f"its swarm's room {r['id']} was archived by hand"
        return None

    def _eligible_person(self, principal):
        if principal == "user:operator":
            return True
        if not principal.startswith("user:"):
            return False
        try:
            return self.hive.db.one("SELECT 1 FROM people WHERE id = ? AND disabled = 0", (principal[5:],)) is not None
        except Exception:     # the people table may not exist yet while the hive starts
            return False

    def _is_admin(self, principal):
        if principal == "user:operator":
            return True
        if not principal.startswith("user:u_"):
            return False
        try:
            p = self.hive.db.one("SELECT role FROM people WHERE id = ? AND disabled = 0", (principal[5:],))
        except Exception:     # the people table may not exist yet while the hive starts
            return False
        return bool(p and p["role"] == "admin")

    @staticmethod
    def _owner_sees(principal, agent, admin):
        """The visibility rule (visibility.Viewer.sees) for the swarm's owner, admins included."""
        from .visibility import Viewer
        return Viewer(principal, admin).sees(agent)

    # ---- messages ------------------------------------------------------------------------------------

    def message_view(self, m, coffee_id=False):
        coffee_id = self._coffee_id() if coffee_id is False else coffee_id
        name = self._public_name if m["room_id"] == coffee_id else self._name
        return {"id": m["id"], "room_id": m["room_id"], "seq": m["seq"], "sender": m["sender"], "name": name(m["sender"]),
                "text": m["text"], "mentions": json.loads(m["mentions"]), "delivered_to": json.loads(m["delivered_to"]),
                "note": bool(m["note"]), "here_reached": json.loads(m["here_reached"] or "[]"), "created_at": m["created_at"],
                **({"health_check": True} if m.get("health_check") else {})}

    def messages(self, viewer, room_id, after=0, limit=100):
        r = self.get(viewer, room_id)
        person = self.hive.personal.thread_person(r["id"])
        if person is not None and person != viewer.principal:
            return []   # a personal mind's Ask thread: never written to (ask.py), and never read by anyone else, admins included
        rows = self.hive.db.all("SELECT * FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
                                (r["id"], int(after), min(max(int(limit), 1), 500))) if not after else \
            self.hive.db.all("SELECT * FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                             (r["id"], int(after), min(max(int(limit), 1), 500)))
        rows = sorted(rows, key=lambda m: m["seq"])
        if rows and self._is_member(r["id"], viewer.principal):
            self.hive.db.execute("UPDATE room_members SET read_seq = MAX(read_seq, ?) WHERE room_id = ? AND member = ?",
                                 (rows[-1]["seq"], r["id"], viewer.principal))
        coffee_id = self._coffee_id()
        # Mind-DM mirrors (including legacy system:hive [WAKE ...] notes) retain c_<mind> after conversion.
        # Resolve provenance from this canonical stored row, for both ID and alias requests and direct consumers.
        # Other room aliases do not identify a mind; new schedule-mirroring paths must retain that provenance.
        alias = r.get("alias") or ""
        agent_id = alias[2:] if alias.startswith("c_") else None
        return [self.hive.visibility.project_person_message(viewer, self.message_view(m, coffee_id), agent_id=agent_id) for m in rows]

    def mentions(self, room_id, text):
        """Mind members named in the text, in the order written, each once. Each @ names at most one mind: @a_<id> is that
        mind (an id comes first, stand-in R4); otherwise the longest name written out there ('@Review Intent' wins over
        Review), unless the whole @token, case, spaces and punctuation left out, is a longer name ('@Review.Intent' or
        '@devilsadvocate'); a token is never matched to a name it only begins."""
        minds = [m["member"] for m in self.members(room_id) if m["member"].startswith("agent:")]
        ids = {m[6:].lower(): m for m in minds}
        named = sorted(((self._name(m).lower(), m) for m in minds), key=lambda x: -len(x[0]))
        compact = {}
        for name, m in named:
            compact.setdefault(_compact(name), m)
        found, lowered = [], text.lower()
        for at in re.finditer(r"(?<![\w@])@", lowered):
            rest = lowered[at.end():]
            by_id = re.match(r"a_[a-z0-9_-]+", rest)
            pick = (None, ids[by_id.group(0)]) if by_id and by_id.group(0) in ids else None
            if pick is None:
                exact = next(((name, m) for name, m in named if name and re.match(re.escape(name) + r"(?![\w-])", rest)), None)
                token = _compact(re.match(r"[^\s@]*", rest).group(0))
                whole = (token, compact[token]) if token in compact else None
                pick = whole if whole and (exact is None or len(token) > len(_compact(exact[0]))) else exact
            if pick and pick[1] not in found:
                found.append(pick[1])
        return found

    def _append(self, room_id, sender, text, mentions, mind_run, note=False, here=(), source_message_id=None, health_check=False):
        with self.hive.db._lock:
            seq = self.hive.db.one("SELECT seq FROM rooms WHERE id = ?", (room_id,))["seq"] + 1
            self.hive.db.execute("UPDATE rooms SET seq = ?, updated_at = ? WHERE id = ?", (seq, now(), room_id))
        msg = {"id": new_id("rm"), "room_id": room_id, "seq": seq, "sender": sender, "text": text,
               "mentions": json.dumps(mentions), "delivered_to": "[]", "mind_run": mind_run, "created_at": now(),
               "note": 1 if note else 0, "here_reached": json.dumps(list(here)),
               "source_message_id": source_message_id, "health_check": 1 if health_check else 0}
        self.hive.db.insert("room_messages", msg)
        if not sender.startswith("agent:"):
            self.hive.db.execute("UPDATE room_members SET read_seq = ? WHERE room_id = ? AND member = ?", (seq, room_id, sender))
        return msg

    async def post(self, viewer, room_id, text):
        """A person speaks in a room."""
        r = self.get(viewer, room_id)
        text = self._text(text)
        with self._seat(r, viewer.principal) as seated:     # the seat and the stored message: one transaction
            if not seated:
                raise self.hive.error(403, "not_member", "join the room to speak in it")
            mentions = self.mentions(r["id"], text)
            minds = [m["member"] for m in self.members(r["id"]) if m["member"].startswith("agent:")]
            here = []
            if r["kind"] == "dm" or (r["kind"] != COFFEE and self._settings(r)["minds_follow"]):
                targets = minds
            else:
                targets = mentions
                if r["kind"] == COFFEE and re.search(r"(?<![\w@])@here\b", text):
                    here = self._awake(minds, exclude=mentions)
                    targets = mentions + here
            msg = self._append(r["id"], viewer.principal, text, mentions, 0, here=here)
        await self._deliver(r, msg, targets)
        return self.message_view(self.hive.db.one("SELECT * FROM room_messages WHERE id = ?", (msg["id"],)))

    def _awake(self, minds, exclude=()):
        """Up to HERE_MAX awake minds among `minds`, most recently active first: who an @here reaches."""
        ids = [m[6:] for m in minds if m not in exclude]
        if not ids:
            return []
        rows = self.hive.db.all(f"SELECT id FROM agents WHERE status = 'awake' AND deleted = 0 AND id IN ({','.join('?' * len(ids))}) "
                                "ORDER BY COALESCE(last_active_at, '') DESC, id LIMIT ?", (*ids, HERE_MAX))
        return [f"agent:{a['id']}" for a in rows]

    def record_note(self, agent_id, room_id, text):
        """An unprompted note from an awake mind in the Coffee Room: at most one per NOTE_SECONDS, never waking anyone."""
        r = self._coffee_fresh(room_id)
        me = f"agent:{agent_id}"
        if r["kind"] != COFFEE:
            raise self.hive.error(400, "bad_request", "notes are for the Coffee Room; elsewhere just speak")
        text = self._text(text)
        with self._seat(r, me) as seated:
            if not seated:
                raise self.hive.error(404, "not_found", "no such room")
            last = self.hive.db.one("SELECT created_at FROM room_messages WHERE room_id = ? AND sender = ? AND note = 1 "
                                    "ORDER BY seq DESC LIMIT 1", (r["id"], me))
            if last is not None:
                from datetime import datetime, timezone
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(last["created_at"].replace("Z", "+00:00"))).total_seconds()
                if age < NOTE_SECONDS:
                    raise self.hive.error(429, "note_too_soon", f"one note an hour; the next in {int((NOTE_SECONDS - age) // 60) + 1} minutes")
            run = self.hive.db.one("SELECT mind_run FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1", (r["id"],))
            msg = self._append(r["id"], me, text, [], run["mind_run"] if run else 0, note=True)   # keeps the turn count
            self.hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?", (msg["seq"], r["id"], me))
        self._event(r["id"], "message")
        return self.message_view(self.hive.db.one("SELECT * FROM room_messages WHERE id = ?", (msg["id"],)))

    def record_mind(self, agent_id, room_id, text):
        """A mind speaks in a room it belongs to. Returns (room, message, minds to deliver to)."""
        r = self._coffee_fresh(room_id)
        me = f"agent:{agent_id}"
        text = self._text(text)
        with self._seat(r, me) as seated:     # the seat (in a team room: the mind's current swarm) and the post: one transaction
            if not seated:
                raise self.hive.error(404, "not_found", "no such room")
            last = self.hive.db.one("SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1", (r["id"],))
            run = (last["mind_run"] + 1) if last and last["sender"].startswith(("agent:", "system:")) and last["mind_run"] else 1
            mentions = [m for m in self.mentions(r["id"], text) if m != me]
            msg = self._append(r["id"], me, text, mentions, run)
            self.hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?", (msg["seq"], r["id"], me))
            targets = mentions
            if mentions and run > self._settings(r)["turn_cap"]:
                targets = []
                self._append(r["id"], "system:hive", f"Minds have spoken {run} times in a row; the room waits for a person "
                                                     "before minds answer each other again.", [], run)
        self._event(r["id"], "message")
        return r, msg, targets

    async def mind_post(self, agent_id, room_id, text, note=False):
        if note:
            return self.record_note(agent_id, room_id, text)
        r, msg, targets = self.record_mind(agent_id, room_id, text)
        if targets:
            await self._deliver(r, msg, targets)
        return self.message_view(self.hive.db.one("SELECT * FROM room_messages WHERE id = ?", (msg["id"],)))

    def _text(self, text):
        if not isinstance(text, str) or not text.strip():
            raise self.hive.error(400, "bad_request", "a message needs text")
        if len(text) > MAX_TEXT:
            raise self.hive.error(413, "too_large", f"a message is at most {MAX_TEXT} characters")
        return text

    async def _deliver(self, r, msg, targets):
        delivered = []
        for member in targets:
            if member == msg["sender"]:
                continue
            agent_id = member[6:]
            mark = self.hive.db.one("SELECT delivered_seq FROM room_members WHERE room_id = ? AND member = ?", (r["id"], member))
            if mark is None:
                continue            # no longer a member: never sent the message, nor history from the start (stand-in R3)
            missed = self.hive.db.all("SELECT sender, text FROM room_messages WHERE room_id = ? AND seq > ? AND seq < ? AND sender != ? "
                                      "ORDER BY seq DESC LIMIT ?", (r["id"], mark["delivered_seq"], msg["seq"], member, DIGEST_LINES))
            name = self._display(r)
            digest = [f"{name(m['sender'])}: {m['text'][:DIGEST_CHARS]}" for m in reversed(missed)]
            room = {"id": r["id"], "kind": r["kind"], "name": self.shown_room(r)[0] or "DM"}
            extra = {"room": room, "sender_name": name(msg["sender"])}
            if digest:
                extra["earlier"] = digest
            if r["kind"] == COFFEE:
                extra["notice"] = COFFEE_NOTICE
            try:
                await self.hive.send_to_agent(agent_id, msg["text"], conversation_id=r["alias"] or r["id"], sender=msg["sender"],
                                              extra=extra, from_room=True, fence=lambda: self._seat(r, member))
            except Exception:  # a mind that cannot receive must not stop the others
                continue
            self.hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?", (msg["seq"], r["id"], member))
            delivered.append(member)
        if delivered:
            self.hive.db.execute("UPDATE room_messages SET delivered_to = ? WHERE id = ?", (json.dumps(delivered), msg["id"]))
        self._event(r["id"], "message")

    @contextlib.contextmanager
    def _seat(self, r, member):
        """Authorise and write atomically: the one rule for every write that a room membership authorises (a person's
        post, a mind's post or note, a mirrored message, a delivery). It opens one database transaction on the hive's
        single locked connection, re-reads the member's current seat (and, in a team room, the mind's current swarm,
        deleted state, kind and the owner's sight of it), and yields whether it holds; the caller's write happens inside
        the same transaction. A move, delete, visibility change or sync therefore lands wholly before the check (refused)
        or wholly after the write (stand-in r3 P1, r5 P1/P2). No team lock is taken here and nothing awaits inside."""
        with self.hive.db.transaction():
            ok = self._is_member(r["id"], member)
            if ok and self.is_team(r) and member.startswith("agent:"):
                a = self.hive.db.one("SELECT * FROM agents WHERE id = ?", (member[6:],))
                swarm = self.hive.db.one("SELECT owner FROM swarms WHERE id = ?", (r["swarm_id"],))
                owner = (swarm or {}).get("owner") or "user:operator"
                ok = (a is not None and swarm is not None and not a["deleted"] and a["swarm_id"] == r["swarm_id"]
                      and a["kind"] in TEAM_MINDS and self._owner_sees(owner, a, self._is_admin(owner)))   # Kimi r3 K5
            yield ok

    def is_team_conversation(self, conversation_id):
        r = self.room_for_conversation(conversation_id) if conversation_id else None
        return r is not None and self.is_team(r)

    # ---- the per-mind message path ---------------------------------------------------------------------

    def room_for_conversation(self, conversation_id):
        if not conversation_id:
            return None
        return self.hive.db.one("SELECT * FROM rooms WHERE (id = ? OR alias = ?) AND archived = 0", (conversation_id, conversation_id))

    def legacy_dm(self, agent_id):
        """The DM behind a mind's classic one-to-one chat (conversation c_<mind>): the operator and the mind."""
        alias = f"c_{agent_id}"
        r = self.hive.db.one("SELECT * FROM rooms WHERE alias = ?", (alias,))
        if r is None:
            room = self.dm("user:operator", f"agent:{agent_id}")
            self.hive.db.execute("UPDATE rooms SET alias = ? WHERE id = ? AND alias IS NULL", (alias, room["id"]))
            r = self.row(room["id"])
        return r

    def mirror_in(self, agent_id, conversation_id, sender, text, source_message_id=None, health_check=False):
        """A message sent to a mind outside rooms (the classic chat, a lease note, an alert): keep the DM transcript whole.
        source_message_id: the messages row this copies (its provenance). health_check: Hive.verified_health_question
        proved it Health's question (its text is already the people's words); it keeps Health as its sender."""
        conversation_id = conversation_id or f"c_{agent_id}"
        r = self.room_for_conversation(conversation_id)
        if r is None and conversation_id == f"c_{agent_id}":
            r = self.legacy_dm(agent_id)
        if r is None:
            return
        # G1: retain schedule provenance if this DM is later shared or made public; its full text stays stored.
        who = sender if sender.startswith(("user:", "agent:")) or sender == "hive:schedule" or (health_check and sender == HEALTH_SENDER) else "system:hive"
        with self._seat(r, f"agent:{agent_id}") as seated:
            if not seated:
                return
            msg = self._append(r["id"], who, str(text)[:MAX_TEXT], [], 0, source_message_id=source_message_id, health_check=health_check)
            self.hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?", (msg["seq"], r["id"], f"agent:{agent_id}"))
            self.hive.db.execute("UPDATE room_messages SET delivered_to = ? WHERE id = ?", (json.dumps([f"agent:{agent_id}"]), msg["id"]))
        self._event(r["id"], "message")

    def mirror_out(self, agent_id, conversation_id, text):
        """A mind's ordinary reply lands in the room its conversation belongs to. Returns a delivery to run, or None."""
        conversation_id = conversation_id or f"c_{agent_id}"
        r = self.room_for_conversation(conversation_id)
        if r is None and conversation_id == f"c_{agent_id}":
            r = self.legacy_dm(agent_id)
        if r is None or not str(text).strip() or not self._is_member(r["id"], f"agent:{agent_id}"):
            return None
        r, msg, targets = self.record_mind(agent_id, r["id"], str(text)[:MAX_TEXT])
        return self._deliver(r, msg, targets) if targets else None

    def _migrate_dms(self):
        """Each classic one-to-one chat becomes a DM room with its history (once)."""
        db = self.hive.db
        for row in db.all("SELECT DISTINCT agent_id FROM messages WHERE conversation_id = 'c_' || agent_id"):
            alias = f"c_{row['agent_id']}"
            if db.one("SELECT 1 FROM rooms WHERE alias = ?", (alias,)) or db.one("SELECT 1 FROM agents WHERE id = ?", (row["agent_id"],)) is None:
                continue
            room = self.legacy_dm(row["agent_id"])
            seq = 0
            for m in db.all("SELECT * FROM messages WHERE agent_id = ? AND conversation_id = ? ORDER BY created_at, rowid", (row["agent_id"], alias)):
                seq += 1
                sender = m["sender"] if m["direction"] == "out" or m["sender"].startswith("user:") else "system:hive"
                db.execute("INSERT INTO room_messages (id, room_id, seq, sender, text, mentions, delivered_to, mind_run, created_at) "
                           "VALUES (?,?,?,?,?,?,?,?,?)",
                           (new_id("rm"), room["id"], seq, sender, m["text"][:MAX_TEXT], "[]", "[]", 0, m["created_at"]))
            db.execute("UPDATE rooms SET seq = ?, updated_at = COALESCE((SELECT MAX(created_at) FROM room_messages WHERE room_id = ?), updated_at) WHERE id = ?",
                       (seq, room["id"], room["id"]))
            db.execute("UPDATE room_members SET delivered_seq = ?, read_seq = ? WHERE room_id = ?", (seq, seq, room["id"]))

    # ---- mind-side views ---------------------------------------------------------------------------------

    def agent_rooms(self, agent_id):
        self.sync_coffee()        # a mind never sees a stale Coffee Room roster (visibility may have changed)
        rows = self.hive.db.all("SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.member = ? AND r.archived = 0 "
                                "ORDER BY r.updated_at DESC LIMIT 50", (f"agent:{agent_id}",))
        return [{"id": r["id"], "kind": r["kind"], "name": self.shown_room(r)[0] or "DM", "topic": self.shown_room(r)[1],
                 "team": self.is_team(r),
                 "members": [self._display(r)(m["member"]) for m in self.members(r["id"])]} for r in rows]

    def _touch(self, room_id):
        self.hive.db.execute("UPDATE rooms SET updated_at = ? WHERE id = ?", (now(), room_id))

    def _event(self, room_id, what):
        self.hive.events.publish("room", room_id=room_id, what=what)
