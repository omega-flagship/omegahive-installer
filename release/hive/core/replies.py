"""Purpose: a person who writes to a mind gets an answer, or is told the mind stopped without one.

On v0.28 a tester's mind was asked in its own chat for a code mind, and another for a flow. Each explored, failed,
read its empty task list and went to rest with the person told nothing: hive-goals lists swarm tasks, not what a
person asked in chat. On v0.29 a mind asked for a flow spent the ten turns a message buys, then stopped calling its
model without a word or a wait. So the mind's loop tells the hive whenever it rests, whichever way: its turns ran out
or it chose a wait (loop_hooks.metta hive-rest-check, hive_commons.rest_check). While a person's message in one of its
direct chats has no answer from it:

- owed(agent_id): each direct chat (c_<mind>, c_<mind>~<person>...) whose newest message from a person is newer than
  the mind's newest message there. Rooms, Ask turns and the hive's own notes owe nothing here.
- rest(agent, in_flight): the first rest after such a message sends the mind HIVE-REPLY-OWED, which quotes the message,
  names the conversation to answer in and only the mind reads. It arrives as new input, so the loop gives the mind
  fresh turns to answer. If it rests again without answering, the hive leaves a note in that chat, which the person
  sees and the mind reads: the mind stopped without answering. Each happens once per message. A conversation the mind
  has an answer queued for (in_flight: its channel has not sent it yet) owes nothing at that rest.
The loop never reports the runtime's own retries while their next turn comes by itself (a provider back-off, a format
failure within its three retries), which are not the mind resting; a format failure past them rests the mind and is
reported.
"""
from __future__ import annotations

from .db import now

SCHEMA = ("""CREATE TABLE IF NOT EXISTS reply_duties (message_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  reminded_at TEXT NOT NULL, noted_at TEXT)""",)
EXCERPT = 120                          # characters of the person's message quoted back to the mind and the person
REMINDER_SENDER = "hive:reply-reminder"  # a hive note only the mind reads (Hive.mind_only)
NOTE_SENDER = "hive:reply-owed"        # a hive note people read too (Hive.PEOPLE_NOTE_SENDERS)


def excerpt(text):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= EXCERPT else flat[:EXCERPT - 1].rstrip() + "…"


class Replies:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        for statement in SCHEMA:
            hive.db.execute(statement)

    def owed(self, agent_id, limit=5):
        """Newest first: each direct chat of this mind whose newest message from a person has no later message from the
        mind. Time: one pass over this mind's inbound person messages in direct chats, with two indexed lookups each
        (messages_agent_dir_conv)."""
        own, prefix = f"c_{agent_id}", f"c_{agent_id}~"
        rows = self.db.all(
            "SELECT m.* FROM messages m WHERE m.agent_id = ? AND m.direction = 'in' AND m.sender LIKE 'user:%' "
            "AND (m.conversation_id = ? OR substr(m.conversation_id, 1, ?) = ?) "
            "AND m.rowid = (SELECT MAX(p.rowid) FROM messages p WHERE p.agent_id = m.agent_id "
            "AND p.direction = 'in' AND p.conversation_id = m.conversation_id AND p.sender LIKE 'user:%') "
            "AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.agent_id = m.agent_id AND o.direction = 'out' "
            "AND o.conversation_id = m.conversation_id AND o.rowid > m.rowid) "
            "ORDER BY m.rowid DESC LIMIT ?", (agent_id, own, len(prefix), prefix, limit))
        return [{"message_id": r["id"], "conversation_id": r["conversation_id"], "from": r["sender"],
                 "from_name": self.hive.sender_name(r["sender"]) or "the person", "text": excerpt(r["text"]),
                 "at": r["created_at"]} for r in rows]

    async def rest(self, agent, in_flight=()):
        """{"sent": "reminder" | "note" | None, "message_id"?}: what the hive sent because this mind rested while it
        owed a person an answer. Its newest unanswered message gets HIVE-REPLY-OWED to the mind the first time and the
        note in the person's chat the second; nothing after that, and nothing while an answer there is queued."""
        queued = {str(c) for c in in_flight or ()}
        owed = [o for o in self.owed(agent["id"], limit=len(queued) + 1) if o["conversation_id"] not in queued]
        if not owed:
            return {"sent": None}
        o = owed[0]
        with self.db.transaction():
            first = self.db.execute(
                "INSERT OR IGNORE INTO reply_duties (message_id, agent_id, reminded_at) VALUES (?, ?, ?)",
                (o["message_id"], agent["id"], now())).rowcount == 1
            noting = not first and self.db.execute(
                "UPDATE reply_duties SET noted_at = ? WHERE message_id = ? AND noted_at IS NULL",
                (now(), o["message_id"])).rowcount == 1
        if first:
            await self.hive.send_to_agent(
                agent["id"], f'HIVE-REPLY-OWED {o["from_name"]} asked you "{o["text"]}" and has no answer from you yet. '
                             f"Answer them before you rest: send-hive-to {o['conversation_id']} <what you did, or why "
                             "you stopped and what they can do>.",
                o["conversation_id"], sender=REMINDER_SENDER, extra={"reply_owed": o["message_id"]})
            return {"sent": "reminder", "message_id": o["message_id"]}
        if noting:
            name = agent.get("name") or "This mind"
            await self.hive.send_to_agent(
                agent["id"], f'{name} stopped without answering "{o["text"]}". {name}, tell {o["from_name"]} what you '
                             "did, or why you stopped and what they can do.",
                o["conversation_id"], sender=NOTE_SENDER, extra={"reply_owed": o["message_id"]})
            return {"sent": "note", "message_id": o["message_id"]}
        return {"sent": None}
