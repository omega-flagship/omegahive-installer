"""Purpose: a mind's word to its person's stage: show something, bring something back beside it, or compare two things,
which that person's open pages arrange in MeTTa (hive/ui/src/screens/arrange) and draw over whatever look is open.

Only the person the mind is answering receives it, never everyone who can see the mind: in a shared swarm a mind showing
one member a photo must not rearrange another member's screen. A mind's own skill (POST /api/agent/stage) reaches the
asker of the Ask turn it is serving (Ask.trace_scope, judged by the mind's execution pinned when its request was
authenticated, as a trace is), or, outside the Ask, the person whose own space the mind is in (the rule notices use) or
whose own mind it is (personal.py), as when a person asks their own mind in its own chat to show them something, or
the person whose own chat with the mind it is answering (chat_person: a member asking a team swarm's mind in its chat);
a turn serving more than one person, or nobody, shows nothing, and the mind is told why. On a hive whose Ask the
conductor answers (conductor.py, on by default), the mind it speaks as says the same through its show, recall and
compare tools, to that turn's asker.

Each item must be one that person may see (an artifact of a swarm they see, a mind or a task they see), and the frame
names each item with its kind, so the page arranges it in the same event without looking it up. Nothing runs: a view
shown still waits for its person's Run it. Each statement is kept in a short per-person log with a sequence number, so
a page whose socket dropped reads what it missed (GET /api/me/stage?after=n).

The conductor may name a creation by the title the person gave it instead of its id (titled): the creations that
person may see with that title, else those whose title holds it. It shows one only when exactly one answers, and names
two or more back so the person is asked which, never picking one for them.
"""
from __future__ import annotations

import collections
import threading
import unicodedata

from .db import now, parse_stamp
from .mcp import _canon as canonical_command
from .visibility import Viewer

# what each statement names: one item, or the pair compared (the image first, over its text)
SAYS = {"show": 1, "recall": 1, "compare": 2}
# how an item names a creation, a mind or a task by id; anything else the conductor gives is a creation's title (titled)
ITEM_IDS = ("ar_", "a_", "g_")
# a page that missed more than this many of its person's statements re-reads only these; older ones can no longer change
# what its stage draws (the newest Show or Compare anchors it)
LOG_KEPT = 64
GOAL_HELD = ("claimed", "waiting", "submitted")
# how long ago a creation was made, in words: each unit and its length in seconds, used while the age is under the
# next row's start (minutes under an hour, hours under two days, then days)
AGES = (("minute", 60, 3600), ("hour", 3600, 2 * 86400), ("day", 86400, None))


def title_form(text):
    """A title as a person might say it: Unicode-folded (NFKC), case-folded, its spacing collapsed and quotes around it
    dropped, so '"Harbour  at DUSK"' and 'Harbour at dusk' are one title."""
    folded = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    return folded.strip("\"'“”‘’").strip()


def made_ago(stamp, at):
    """How long before `at` a stored stamp was, in words that read the same in every time zone: 'just now' under a
    minute, then 'N minutes ago', 'N hours ago' under two days, 'N days ago' (AGES); None for a stamp that isn't one. A
    stamp after `at` (clocks apart) is just now. The hive is never told its person's zone, so a day it named was the UTC
    day: on v0.31, at 03:07 AEDT on the 16th, three pictures made that night were each named as made on the 15th."""
    made, moment = parse_stamp(stamp), parse_stamp(at)
    if made is None or moment is None:
        return None
    seconds = max(0, int((moment - made).total_seconds()))
    if seconds < 60:
        return "just now"
    for unit, size, below in AGES:
        if below is None or seconds < below:
            n = seconds // size
            return f"{n} {unit}{'' if n == 1 else 's'} ago"


class Stage:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self._lock = threading.Lock()
        self._seq = 0
        self._logs: dict[str, collections.deque] = {}

    def _error(self, status, code, message):
        return self.hive.error(status, code, message)

    def _viewer(self, principal):
        """The person as GET /api/artifacts and GET /api/agents judge them: the loopback operator is an admin; a person
        is their current role; a disabled or unknown one sees nothing."""
        if principal == "user:operator":
            return Viewer(principal, True)
        row = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (str(principal)[5:],)) \
            if str(principal).startswith("user:u_") else None
        if row is None or row["disabled"]:
            raise self._error(403, "no_person", "the person this turn answers is not signed in to this hive")
        return Viewer(principal, row["role"] == "admin")

    def audience(self, agent, pin):
        """The one person this mind's statement goes to, or a refusal saying why it goes to nobody."""
        scope = self.hive.ask.trace_scope(agent["id"], pin[1], pin[2])
        if scope is not None:
            if scope["scope"] == "asker" and scope["principal"]:
                return scope["principal"]
            raise self._error(409, "no_single_person", "this turn answers more than one person, so it shows nothing")
        own = self.hive.notices.own_person(agent)
        if own is not None:
            return own[0]
        # a person's own mind belongs to that one person (personal.py: one live mind per person, which joins no other
        # swarm), so outside the Ask it shows things to them; on v0.31 a person asked theirs in its own chat to make a
        # picture and show it, and this rule alone counted only an app's own space for a person
        if agent.get("personal_of"):
            return agent["personal_of"]
        person = self.chat_person(agent)
        if person is not None:
            return person
        raise self._error(403, "no_person", "a mind shows things only to the person whose Ask or own chat it is "
                                            "answering, or to the person whose own mind it is or whose own space it is in")

    def chat_person(self, agent):
        """The person whose own chat with this mind it is answering, found as the mind's hive channel binds a plain reply
        (modules/channel_hive hive_channel.py, mind-chat-identity r2), so a show goes where the mind's answer goes: the
        one person's chat holding a message from them that the mind has not answered since; with none waiting, the chat
        the mind last spoke in since its current execution began, when that chat is a person's and they spoke in it;
        with no record of when its execution began, no chat it spoke in can be told to be the one it is answering, so
        only a waiting person's chat answers.
        Both are told by the order the hive wrote the messages (rowid) and the boundary's message mark (Ask.note_boundary),
        never by clock stamps, which a reply and the next boundary can share within one millisecond.
        A person's chat is the loopback operator's c_<mind> or a named person's c_<mind>~<principal>,
        which only that person speaks in (Hive.may_post); rooms and Ask turns keep their own rules. None when no person's
        chat answers; a refusal when people wait in more than one, as a turn serving several askers shows nothing.
        Time: one grouped read over this mind's chat messages, one read of its last message and one of its boundary."""
        mid = agent["id"]
        own, named = f"c_{mid}", f"c_{mid}~user:"
        chats = {r["conversation_id"]: r for r in self.db.all(
            "SELECT conversation_id, MAX(CASE WHEN direction = 'in' AND sender LIKE 'user:%' THEN rowid END) AS heard, "
            "MAX(CASE WHEN direction = 'out' THEN rowid END) AS said FROM messages WHERE agent_id = ? "
            "AND (conversation_id = ? OR substr(conversation_id, 1, ?) = ?) GROUP BY conversation_id",
            (mid, own, len(named), named))}
        waiting = sorted(c for c, r in chats.items() if r["heard"] is not None and (r["said"] is None or r["heard"] > r["said"]))
        if len(waiting) > 1:
            raise self._error(409, "no_single_person", "people are waiting for this mind in more than one chat, so it "
                                                       "shows nothing")
        if waiting:
            return self.hive.conversation_owner(mid, waiting[0])
        last = self.db.one("SELECT rowid AS written, conversation_id FROM messages WHERE agent_id = ? AND direction = 'out' "
                           "ORDER BY rowid DESC LIMIT 1", (mid,))
        began = self.db.one("SELECT message_mark FROM ask_boundaries WHERE agent_id = ?", (mid,))
        # a chat the mind spoke in before its current execution began is not what it is answering now, and without a
        # start record any chat it spoke in may be from before it
        if last is None or began is None or last["written"] <= began["message_mark"]:
            return None
        chat = chats.get(last["conversation_id"])
        return self.hive.conversation_owner(mid, last["conversation_id"]) if chat and chat["heard"] is not None else None

    def _item(self, key, who):
        """The item as the page arranges it, when this person may see it; anything else is answered as not there."""
        missing = self._error(404, "not_found", f"{key} is not something this person can see")
        if not isinstance(key, str) or not 0 < len(key) <= 140:
            raise self._error(400, "bad_request", "each item is an id: ar_ (a creation), a_ (a mind) or g_ (a task)")
        if key.startswith("ar_"):
            art = self.db.one("SELECT * FROM artifacts WHERE id = ?", (key,))
            seen = art is not None and bool(self.hive.visibility.swarms(
                who, [s for s in self.hive.swarms() if s["id"] == art["owner_swarm"] and not s.get("archived_at")]))
            if not seen:
                raise missing
            return {"key": key, "source": "artifact", "stored": str(art["kind"])}
        if key.startswith("a_"):
            if not any(a["id"] == key for a in self.hive.visibility.agents(who, self.hive.agents())):
                raise missing
            return {"key": key, "source": "mind"}
        if key.startswith("g_"):
            goal = self.db.one("SELECT id, swarm_id FROM goals WHERE id = ?", (key,))
            seen = goal is not None and bool(self.hive.visibility.swarms(
                who, [s for s in self.hive.swarms() if s["id"] == goal["swarm_id"] and not s.get("archived_at")]))
            if not seen:
                raise missing
            return {"key": key, "source": "task"}
        raise self._error(400, "bad_request", "each item is an id: ar_ (a creation), a_ (a mind) or g_ (a task)")

    def titled(self, title, principal):
        """The creations this person may see that the title they gave names, newest first, each by name and id with
        what it is and how long ago it was made (made_ago): those whose title is that title (title_form), else those
        whose title holds it; an empty title names none. Seen as _item sees an artifact: one of a swarm they see that is
        not archived. Time: one visibility pass over the hive's swarms, then n title comparisons, n = the hive's
        creations."""
        wanted = title_form(title) if isinstance(title, str) else ""
        if not wanted:
            return []
        who = self._viewer(principal)
        at = now()
        live = [s for s in self.hive.swarms() if not s.get("archived_at")]
        seen = {s["id"] for s in self.hive.visibility.swarms(who, live)}
        rows = [r for r in self.db.all("SELECT id, kind, title, owner_swarm, created_at FROM artifacts "
                                       "ORDER BY created_at DESC, id") if r["owner_swarm"] in seen]
        exact = [r for r in rows if title_form(r["title"]) == wanted]
        found = exact or [r for r in rows if wanted in title_form(r["title"])]
        return [{"kind": "artifact", "id": r["id"], "name": r["title"], "stored": str(r["kind"]),
                 "made": made_ago(r["created_at"], at)} for r in found]

    def _task(self, agent):
        """The task the statement belongs to: the one task this mind holds now, else none (interest is kept per task)."""
        rows = self.db.all("SELECT id FROM goals WHERE claimed_by IN (?, ?) AND status IN (?, ?, ?)",
                           (agent["id"], f"agent:{agent['id']}", *GOAL_HELD))
        return rows[0]["id"] if len(rows) == 1 else None

    def say(self, agent, data, principal):
        """A mind's statement to one person's stage: {say: show|recall|compare, items: [id, ...]}. principal: the person
        it goes to (audience, or a conductor turn's asker). Answers what was said and to whom; every refusal is an answer
        to the mind, never a silent loss."""
        if not isinstance(data, dict) or set(data) != {"say", "items"} or data["say"] not in SAYS \
                or not isinstance(data["items"], list) or len(data["items"]) != SAYS[data["say"]]:
            raise self._error(400, "bad_request", "a stage statement is {say: show|recall|compare, items}: one item to "
                                                  "show or recall, two to compare")
        say = data["say"]
        # the host decides as the mind's own gate did, so a direct call is held to the same rule
        self.hive.policy.enforce(agent, f"hive-{say}", canonical_command(f"hive-{say}", *data["items"]))
        who = self._viewer(principal)
        items = [self._item(k, who) for k in data["items"]]
        if say == "compare" and items[0]["key"] == items[1]["key"]:
            raise self._error(400, "bad_request", "compare two different things")
        task = self._task(agent)
        with self._lock:
            self._seq += 1
            entry = {"seq": self._seq, "agent_id": agent["id"], "say": say, "items": items, "task": task}
            self._logs.setdefault(principal, collections.deque(maxlen=LOG_KEPT)).append(entry)
        # a person-only frame (visibility.event_visible): theirs, never an admin's or anyone else's
        self.hive.events.publish("stage.said", principal=principal, **entry)
        return {"said": say, "items": [i["key"] for i in items], "to": "the person you are answering", "seq": entry["seq"]}

    def since(self, principal, after=0):
        """This person's statements after `after`, oldest first: what a page whose socket dropped missed."""
        with self._lock:
            return [e for e in self._logs.get(principal, ()) if e["seq"] > int(after)]
