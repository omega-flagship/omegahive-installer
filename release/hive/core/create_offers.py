# Purpose: a mind's offer to build something in Create for its person, kept until the person starts it in Create, which
# then plans and builds it under Create's own gates, or sets it aside; a mind never starts a plan itself.
"""Create offers (Jon, 17 Nov 09:03: "Please stop the agents using their own coding skills", "Route them only through
create", "They're bypassing safeguards").

A mind asked to build software (an app, a page, a game, a tool, a script, a change to code) calls hive-create with what
to build (POST /api/agent/create). Create's plans start only on a person's word in their own session (POST
/api/create/plans, the §G person gate: never a mind), so the mind's call makes an offer, not a plan. The person reads it
in their Ask or the mind's chat and presses Start in Create, which starts the plan with the offer's words exactly as if
they had typed them into Create (CreatePlanEngine.start), or Not now. Nothing is built before that press, and the mind is
told so in words it can pass on (OFFERED_NEXT).

Who an offer is for (person_for): the person of the conversation the mind is answering, when it names one (an Ask turn's
asker, else the last person who wrote in that conversation); else the last person who wrote to the mind (Jon on #395:
an offer with no conversation goes to the last person who wrote, not the owner); else, when nobody has written to it,
the person whose own mind it is. A mind reaches only people who wrote to it, or its own person.

States: offered, then started (with the plan it started) or dismissed. One open offer per mind, person and sentence: the
same call again answers the same offer.
"""
from __future__ import annotations

import asyncio
import secrets

from .ask import CONVERSATION as ASK_CONVERSATION
from .create_plan_engine import MAX_SENTENCE
from .db import now
from .program_actions import named_person

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS create_offers (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, principal TEXT NOT NULL,
  sentence TEXT NOT NULL, conversation_id TEXT, state TEXT NOT NULL, plan_id TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS create_offers_person ON create_offers(principal, state, created_at)",
)
STATES = ("offered", "started", "dismissed")
LIST_LIMIT = 20
# a person's own message to a mind: the sender is a named person's principal (program_actions.named_person's shape)
PERSON_SENDER = "sender LIKE 'user:u\\_%' ESCAPE '\\'"
# what the mind reads after its offer (POST /api/agent/create's next), in words it can pass on: nothing is built before
# the person's Start, where the card is (the Ask's thread shows every mind's open offers, a mind's chat its own), and
# never to call it built, as a tester's mind did from the softer "your person can start it in Create" (20 Nov)
OFFERED_NEXT = ("offered, not built. Nothing is built until your person presses Start in Create on the offer card, which "
                "shows in their Ask and in your chat with them. Tell them that, and never say it is built or being built.")


class CreateOffers:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        self._locks = {}   # offer id -> lock: two presses at once start one plan, the second answers with it

    def _err(self, status, code, message):
        return self.hive.error(status, code, message)

    def view(self, row):
        agent = self.db.one("SELECT id, name FROM agents WHERE id = ?", (row["agent_id"],))
        return {"id": row["id"], "mind": {"id": agent["id"], "name": agent["name"]} if agent else None,
                "sentence": row["sentence"], "state": row["state"], "plan_id": row["plan_id"],
                "created_at": row["created_at"]}

    def _last_writer(self, agent_id, conversation_id=None):
        """The person who last wrote to this mind (in that conversation, when one is named), or None. Time: one indexed
        read of the mind's messages, newest first."""
        where, args = "agent_id = ? AND direction = 'in' AND " + PERSON_SENDER, [agent_id]
        if conversation_id is not None:
            where += " AND conversation_id = ?"
            args.append(conversation_id)
        row = self.db.one(f"SELECT sender FROM messages WHERE {where} ORDER BY hub_seq DESC LIMIT 1", args)
        return row["sender"] if row else None

    def person_for(self, agent, conversation_id=None):
        """The person an offer from this mind is for, or None (module notes). Example: a mind answering an Ask turn
        (conversation "ask:at_...") offers to that turn's asker; with no conversation named it offers to whoever wrote to
        it last, and a person's own mind nobody has written to offers to that person. Time: at most three indexed reads."""
        conversation = str(conversation_id or "")
        if conversation.startswith(ASK_CONVERSATION):
            turn = self.db.one("SELECT principal FROM ask_turns WHERE id = ? AND mind_id = ?",
                               (conversation[len(ASK_CONVERSATION):], agent["id"]))
            if turn is not None and named_person(turn["principal"]):
                return turn["principal"]
        if conversation:
            writer = self._last_writer(agent["id"], conversation)
            if writer is not None:
                return writer
        writer = self._last_writer(agent["id"])
        if writer is not None:
            return writer
        own = agent.get("personal_of")
        return own if own and named_person(own) else None

    def _publish(self, row):
        """After the commit, the offer's news to its person only (visibility.EVENT_RULES "person"), ids and state only."""
        self.db.after_commit(lambda: self.hive.events.publish(
            "create.offer", principal=row["principal"], offer_id=row["id"], agent_id=row["agent_id"], state=row["state"]))

    def offer(self, agent, data):
        """POST /api/agent/create {sentence, conversation_id?}: the mind's offer for its person. Returns (status, view
        and next, what the mind is told): 201 for a new offer, 200 for the same open offer again. Nothing is built here."""
        data = data if isinstance(data, dict) else {}
        sentence = str(data.get("sentence") or "").strip()
        if not sentence or len(sentence) > MAX_SENTENCE:
            raise self._err(400, "bad_request", f"say what to build in 1-{MAX_SENTENCE} characters")
        if not self.hive.create_plans.enabled():
            raise self._err(409, "not_available", "Create isn't switched on in this hive, so nothing can be built here")
        person = self.person_for(agent, data.get("conversation_id"))
        if person is None:
            raise self._err(403, "person_required", "no person is talking with this mind to offer it to")
        conversation = data.get("conversation_id") if isinstance(data.get("conversation_id"), str) else None
        with self.db.transaction():
            same = self.db.one("SELECT * FROM create_offers WHERE agent_id = ? AND principal = ? AND sentence = ? "
                               "AND state = 'offered'", (agent["id"], person, sentence))
            if same is not None:
                return 200, {**self.view(same), "next": OFFERED_NEXT}
            stamp = now()
            row = {"id": "cof_" + secrets.token_hex(12), "agent_id": agent["id"], "principal": person,
                   "sentence": sentence, "conversation_id": conversation, "state": "offered", "plan_id": None,
                   "created_at": stamp, "updated_at": stamp}
            self.db.insert("create_offers", row)
            self._publish(row)
        return 201, {**self.view(row), "next": OFFERED_NEXT}

    def list_for(self, principal, mind=None):
        """GET /api/me/create-offers?mind=: this person's open offers, newest first, one mind's when named."""
        where, args = "principal = ? AND state = 'offered'", [principal]
        if mind:
            where += " AND agent_id = ?"
            args.append(mind)
        rows = self.db.all(f"SELECT * FROM create_offers WHERE {where} ORDER BY created_at DESC, id LIMIT ?",
                           (*args, LIST_LIMIT))
        return [self.view(r) for r in rows]

    def _own(self, principal, offer_id):
        row = self.db.one("SELECT * FROM create_offers WHERE id = ? AND principal = ?", (offer_id, principal))
        if row is None:   # someone else's offer is the same answer as none
            raise self._err(404, "not_found", f"no offer {offer_id}")
        return row

    async def start(self, engine, principal, offer_id):
        """POST /api/create/offers/{id}/start, the person's press (behind the §G person gate): the plan starts with the
        offer's words, as POST /api/create/plans would start it. Pressed again, it answers the plan already started.
        Returns {offer, plan}."""
        lock = self._locks.setdefault(offer_id, asyncio.Lock())
        async with lock:
            row = self._own(principal, offer_id)
            if row["state"] == "started":
                return {"offer": self.view(row), "plan": engine.view(row["plan_id"])}
            if row["state"] != "offered":
                raise self._err(409, "offer_closed", "this offer was set aside; ask the mind again to build it")
            plan = await engine.start(principal, row["sentence"])
            with self.db.transaction():
                self.db.execute("UPDATE create_offers SET state = 'started', plan_id = ?, updated_at = ? WHERE id = ?",
                                (plan["plan_id"], now(), offer_id))
                row = self._own(principal, offer_id)
                self._publish(row)
            return {"offer": self.view(row), "plan": plan}

    def dismiss(self, principal, offer_id):
        """POST /api/create/offers/{id}/dismiss: Not now. An offer already started stays started."""
        with self.db.transaction():
            row = self._own(principal, offer_id)
            if row["state"] == "offered":
                self.db.execute("UPDATE create_offers SET state = 'dismissed', updated_at = ? WHERE id = ?",
                                (now(), offer_id))
                row = self._own(principal, offer_id)
                self._publish(row)
        return self.view(row)
