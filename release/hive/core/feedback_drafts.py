"""Purpose: a mind's draft reports, waiting in one person's feedback area until that person dismisses or uses one.

A mind drafts a report with the hive-report-problem skill when something in the hive is broken or confusing for the
person it is talking with. The draft goes nowhere from here: the person opens it in the feedback area, edits it, and only
their own send, copy or save there makes it a report (feedback.py). Each draft waits for one person, and only that person
lists it, deletes it or hears of it: the person whose conversation with the mind it came up in, so what someone told a
mind never lands in another person's area. A draft names that conversation, or the hive works it out from the mind's own
messages (answering); one with no person behind it, from mind-to-mind work or a scheduled goal, waits for the mind's
owner as its approvals name it, else the hive's owner. A mind repeating an open draft (the same person, mind and title)
replaces its words and time and keeps its id, so a looping mind leaves one draft, never a pile."""
from __future__ import annotations

import secrets

from .ask import CONVERSATION as ASK_CONVERSATION
from .db import now
from .feedback import KINDS

TITLE_MAX = 80
TEXT_MAX = 4000

SCHEMA = """CREATE TABLE IF NOT EXISTS feedback_drafts (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  words TEXT NOT NULL, steps TEXT, expected TEXT, conversation TEXT, created TEXT NOT NULL)"""
INDEX = "CREATE INDEX IF NOT EXISTS feedback_drafts_person ON feedback_drafts (principal, created)"
FIELDS = ("kind", "title", "words", "steps", "expected", "conversation")


class FeedbackDrafts:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self.db.execute(SCHEMA)
        self.db.execute(INDEX)

    def person_of(self, agent):
        """The person a mind's own drafts wait for, those naming no conversation: its owner when that is a person, as its
        approvals name it (policy.py require_approval_owner), else the hive's owner, the one admin every hive has; None
        when there is neither."""
        owner = agent.get("owner")
        if isinstance(owner, str) and owner.startswith("user:"):
            return owner
        ownhive = getattr(self.hive, "ownhive", None)
        principal = ownhive.owner() if ownhive is not None else None
        return principal if isinstance(principal, str) and principal.startswith("user:") else None

    def answering(self, agent):
        """The conversation a draft naming none came up in, worked out from the mind's own messages by the reply binding
        its hive channel uses for a plain reply (modules/channel_hive/src/hive_channel.py): only a person's conversation
        waits for an answer, never another mind's or the hive's. With one person's conversation waiting and its message the
        last the mind received, that one; with none waiting, the conversation of the last message received when a person
        sent it; else None, a draft with no person behind it (mind-to-mind work, a scheduled goal, a Health question),
        which waits for the mind's own person (Jon on #366). Several people waiting, or another message arriving after the
        one waiting, could be any of them, so it is a 400 naming them unless each is the mind's own person: the mind names
        the conversation then. Messages are ordered by rowid, the order they were stored in, since two can share a
        millisecond. Cost: two reads of the mind's inbound messages through messages_agent_dir_conv, one MAX per
        conversation a person wrote in."""
        agent_id = agent["id"]
        waiting = self.db.all(
            "SELECT i.conversation_id, i.sender, i.last FROM (SELECT conversation_id, sender, MAX(rowid) AS last "
            "FROM messages WHERE agent_id = ? AND direction = 'in' AND sender LIKE 'user:%' GROUP BY conversation_id) i "
            "WHERE i.last > COALESCE((SELECT MAX(rowid) FROM messages o WHERE o.agent_id = ? AND o.direction = 'out' "
            "AND o.conversation_id = i.conversation_id), 0) ORDER BY i.last", (agent_id, agent_id))
        last = self.db.one("SELECT conversation_id, sender, MAX(rowid) AS seq FROM messages WHERE agent_id = ? AND "
                           "direction = 'in'", (agent_id,))
        if last["seq"] is None:
            return None
        person_sent = str(last["sender"]).startswith("user:")
        if not waiting:
            return last["conversation_id"] if person_sent else None
        if len(waiting) == 1 and waiting[0]["last"] == last["seq"]:
            return waiting[0]["conversation_id"]
        own = self.person_of(agent)
        if own is not None and all(w["sender"] == own for w in waiting) and (not person_sent or last["sender"] == own):
            return None
        ids = [w["conversation_id"] for w in waiting]
        raise self.hive.error(400, "bad_draft", "this mind may be answering any of " + ", ".join(ids[:5])
                              + (f" and {len(ids) - 5} more" if len(ids) > 5 else "")
                              + ", so name the conversation the problem came up in")

    def person_for(self, agent, conversation):
        """(The person a draft waits for, the conversation it came up in): the person of the conversation it names or,
        naming none, of the one the mind is answering (answering), so Bob's chat with Ana's public mind stays Bob's and
        never reaches Ana (Jon on #366): a
        person's chat with the mind and the operator's own c_<mind> as hive.conversation_owner names them, an Ask turn of
        this mind by its asker. The conversation must hold a message that person sent this mind, since a mind may send into
        any conversation id it picks; one without, or one no single person has (a room), is a 400, so no draft lands with
        someone the mind never heard from. A draft with no person behind it is the mind's own (person_of), with no
        conversation."""
        named = conversation is not None
        if not named:
            conversation = self.answering(agent)
            if conversation is None:
                return self.person_of(agent), None
        agent_id = agent["id"]
        if conversation.startswith(ASK_CONVERSATION):
            turn = self.db.one("SELECT principal FROM ask_turns WHERE id = ? AND mind_id = ?",
                               (conversation[len(ASK_CONVERSATION):], agent_id))
            person = turn["principal"] if turn else None
        else:
            person = self.hive.conversation_owner(agent_id, conversation)
        if isinstance(person, str) and person.startswith("user:") and self.db.one(
                "SELECT 1 FROM messages WHERE agent_id = ? AND conversation_id = ? AND direction = 'in' AND sender = ? LIMIT 1",
                (agent_id, conversation, person)) is not None:
            return person, conversation
        if named:
            raise self.hive.error(400, "bad_draft", "conversation is not one of this mind's conversations with one person "
                                                    "who wrote to it there, so no feedback area can hold the draft")
        raise self.hive.error(400, "bad_draft", f"the conversation this mind is answering, {conversation}, is not one "
                                                "person's, so name the conversation the problem came up in")

    def _checked(self, data):
        """The draft's fields as given, or a 400 naming what is wrong."""
        def bad(reason):
            return self.hive.error(400, "bad_draft", reason)
        if not isinstance(data, dict):
            raise bad("send a JSON object: {kind, title, words, steps?, expected?, conversation?}")
        unknown = sorted(set(data) - set(FIELDS))
        if unknown:
            raise bad(f"unknown field {unknown[0]}: a draft has kind, title, words, steps, expected and conversation")
        if data.get("kind") not in KINDS:
            raise bad(f"kind is one of {', '.join(KINDS)}")
        out = {"kind": data["kind"]}
        for field in ("title", "words", "steps", "expected", "conversation"):
            value = data.get(field)
            if value is not None and not isinstance(value, str):
                raise bad(f"{field} is text")
            out[field] = value.strip() if isinstance(value, str) else None
        if not out["title"]:
            raise bad("title is required")
        if "\n" in out["title"] or len(out["title"]) > TITLE_MAX:
            raise bad(f"title is one line of at most {TITLE_MAX} characters")
        if not out["words"]:
            raise bad("words is required: what happened, in the person's terms")
        for field in ("words", "steps", "expected"):
            if out[field] is not None and len(out[field]) > TEXT_MAX:
                raise bad(f"{field} is at most {TEXT_MAX} characters")
        if out["conversation"] is not None and len(out["conversation"]) > 200:
            raise bad("conversation is the id of the conversation the problem came up in")
        for field in ("steps", "expected", "conversation"):
            out[field] = out[field] or None
        return out

    def _view(self, row, name=None):
        if name is None:
            mind = self.db.one("SELECT name FROM agents WHERE id = ?", (row["agent"],))
            name = mind["name"] if mind else None
        return {"id": row["id"], "kind": row["kind"], "title": row["title"], "words": row["words"], "steps": row["steps"],
                "expected": row["expected"], "created": row["created"],
                "source": {"kind": "mind", "agent": row["agent"], "name": name, "conversation": row["conversation"]}}

    def draft(self, agent, data):
        """A mind drafts a report for the person of the conversation it came up in, named or worked out, or for its own
        person when no person is behind it (POST /api/feedback/drafts; person_for). Repeating an open draft's title
        replaces it in place. Sends nothing anywhere: feedback.draft tells the person it is waiting."""
        fields = self._checked(data)
        principal, fields["conversation"] = self.person_for(agent, fields["conversation"])
        if principal is None:
            raise self.hive.error(409, "no_person", "no person owns this mind or the hive, so no feedback area can hold the draft")
        at = now()
        with self.db.transaction():
            same = self.db.one("SELECT id FROM feedback_drafts WHERE principal = ? AND agent = ? AND title = ?",
                               (principal, agent["id"], fields["title"]))
            draft_id = same["id"] if same else "fd-" + secrets.token_hex(4)
            self.db.execute(
                "INSERT INTO feedback_drafts (id, principal, agent, kind, title, words, steps, expected, conversation, created) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, "
                "words = excluded.words, steps = excluded.steps, expected = excluded.expected, "
                "conversation = excluded.conversation, created = excluded.created",
                (draft_id, principal, agent["id"], fields["kind"], fields["title"], fields["words"], fields["steps"],
                 fields["expected"], fields["conversation"], at))
            row = self.db.one("SELECT * FROM feedback_drafts WHERE id = ?", (draft_id,))
        self.hive.events.publish("feedback.draft", principal=principal, draft=self._view(row, agent.get("name")))
        return {"id": draft_id, "for": principal}

    def list(self, principal):
        """The drafts waiting for this person, newest first (GET /api/feedback/drafts)."""
        rows = self.db.all("SELECT * FROM feedback_drafts WHERE principal = ? ORDER BY created DESC, id", (principal,))
        return {"drafts": [self._view(r) for r in rows]}

    def delete(self, principal, draft_id):
        """The person dismisses or has used a draft (DELETE /api/feedback/drafts/{id}). Another person's draft and an
        unknown id are both 404, so an id says nothing about whose it is."""
        row = self.db.one("SELECT principal FROM feedback_drafts WHERE id = ?", (str(draft_id),))
        if row is None or row["principal"] != principal:
            raise self.hive.error(404, "not_found", "no such draft")
        self.db.execute("DELETE FROM feedback_drafts WHERE id = ?", (str(draft_id),))
        self.hive.events.publish("feedback.draft.removed", principal=principal, id=str(draft_id))
