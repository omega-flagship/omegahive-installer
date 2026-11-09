"""Linkage slice 2, §(a) of PLATFORM_ASK_R2_13_LINKAGE_SPEC r3.6: an Ask turn's host-owned intents and links.

An intent is the host's custody of one exact r2.13 body for one Ask turn. It adds custody, never authority: the
authority is still r2.13 (a named, signed-in admin person submits an exact body through Minds.instruct).
- Record keeps the body with a host-derived key, "ask." + intent id, which binds the destination (R1).
- Submit claims the intent (pending/refused -> dispatching, a new dispatch_id), then calls Minds.instruct with a bind
  that moves dispatching -> linked inside instruct's own transaction. The request is committed if and only if the intent
  is linked (R0). The outcome is settled from the row's state afterwards, never from a status code (S3). A linked
  intent answers its recorded 201 byte for byte (S4).
- Nothing in a running process moves a dispatching intent except its own submit; the §L startup recovery moves what a
  previous process left (R2b, recover_startup).
- code.test queues an action to an existing original request/controller/lease; it never creates another request or grants test execution.
- Links attach a request the same person already made directly. They grant and change nothing.
- Reads are the owner's only; admins see links through the Ask audit routes. Frames are 'ask' frames
  {phase: "intent", intent_id, state, links_rev}, so the asker-only rule applies; they are hints and may be dropped.
"""

from __future__ import annotations

import datetime
import json
import logging
import secrets

from .db import now
from .minds import canonical, parse_time, sha, stamp as rfc3339_ms

log = logging.getLogger("hive")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS ask_intents (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, principal TEXT NOT NULL,
  kind TEXT NOT NULL, request_operation_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, request_digest TEXT NOT NULL,
  destination TEXT NOT NULL, instruction_digest TEXT NOT NULL, state TEXT NOT NULL, dispatch_id TEXT,
  dispatch_started_at TEXT, last_dispatch TEXT, last_refusal TEXT, request_id TEXT, lease_id TEXT, receiving_goal TEXT,
  deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL)""",
    # at most one live intent per turn, whether or not a dispatch is in flight (a.2)
    "CREATE UNIQUE INDEX IF NOT EXISTS ask_intents_live ON ask_intents(turn_id) WHERE state IN ('pending', 'dispatching')",
    "CREATE INDEX IF NOT EXISTS ask_intents_principal ON ask_intents(principal, created_at)",
    "CREATE INDEX IF NOT EXISTS ask_intents_turn ON ask_intents(turn_id, created_at)",
    # a request the same person made directly, attached to a turn (POST /api/ask/{op}/links)
    """CREATE TABLE IF NOT EXISTS ask_links (turn_id TEXT NOT NULL, request_id TEXT NOT NULL, principal TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (turn_id, request_id))""",
]

KIND = "code.request"
TEST = "code.test"
STUDIO = "studio.session"   # J3 host R2 (G1): studio_sessions.py; named people, members included, may record and send it
# each kind's own gate (plan §3.2): code.request stays the r2.13 named-admin path; studio.session is any named person's
KINDS = {KIND: {"admin_only": True}, STUDIO: {"admin_only": False}, TEST: {"admin_only": False}}
KEY_PREFIX = "ask."
STATES = ("pending", "dispatching", "linked", "refused", "abandoned")
TURN_MAX_AGE = datetime.timedelta(hours=24)
LIST_LIMIT = 50


def _iso_time(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


class Intents:
    def __init__(self, ask):
        self.ask = ask
        self.hive = ask.hive
        for statement in SCHEMA:
            self.hive.db.execute(statement)

    # ---- errors --------------------------------------------------------------------------------------------------

    def _err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    def _bad(self, message, **details):
        return self._err(400, "bad_request", message, **details)

    def _not_available(self):
        return self._err(404, "not_available", "That isn't available.")

    # ---- rows, views and frames ------------------------------------------------------------------------------------

    def _turn(self, viewer, operation_id):
        """The caller's own, undeleted Ask turn; anyone else's (or a deleted one) is 404 not_available."""
        t = self.hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?", (viewer.principal, str(operation_id)))
        if t is None or t["deleted_at"]:
            raise self._not_available()
        return t

    def _row(self, intent_id):
        return self.hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (str(intent_id),))

    def _own(self, viewer, intent_id):
        row = self._row(intent_id)
        if row is None or row["principal"] != viewer.principal:
            raise self._not_available()
        return row

    def _links_rev(self, turn_id):
        row = self.hive.db.one("SELECT links_rev FROM ask_turns WHERE id = ?", (turn_id,))
        return int(row["links_rev"]) if row else 0

    def _bump(self, turn_id):
        """Inside the transaction that changes an intent or link of this turn (a.2): links_rev + 1."""
        self.hive.db.execute("UPDATE ask_turns SET links_rev = links_rev + 1 WHERE id = ?", (turn_id,))

    def _frame(self, turn_id, intent_id, state, **extra):
        """Inside the same transaction, after _bump: an intent frame, or None when the turn's shared frame quota is spent
        (Ask._frame keeps the terminal places; frames are hints, the view is the record)."""
        return self.ask._frame(turn_id, "intent", intent_id=intent_id, state=state, links_rev=self._links_rev(turn_id), **extra)

    def view(self, row, links_rev=None):
        body = json.loads(row["body"] or "{}")
        if row["kind"] == STUDIO:
            return self._studio_view(row, body, links_rev)
        if row["kind"] == TEST:
            result = self._studio_view(row, {"request": {}}, links_rev)
            result.update(request=body.get("request"), title="Test retained proposal",
                          session_id=None, acceptance="queued_only")
            return result
        lifetime = body.get("lifetime") if isinstance(body.get("lifetime"), dict) else {}
        return {"intent_id": row["id"], "turn_id": row["turn_id"], "kind": row["kind"], "state": row["state"],
                "request_operation_id": row["request_operation_id"], "request_digest": row["request_digest"],
                "destination": json.loads(row["destination"]), "title": body.get("title"),
                "instruction": body.get("instruction"),   # the owner's own words; the read routes are owner-only
                "instruction_digest": row["instruction_digest"], "budget": body.get("budget"),
                "until": lifetime.get("until"), "last_dispatch": json.loads(row["last_dispatch"]) if row["last_dispatch"] else None,
                "last_refusal": json.loads(row["last_refusal"]) if row["last_refusal"] else None,
                "dispatch_id": row["dispatch_id"], "dispatch_started_at": row["dispatch_started_at"],
                "request_id": row["request_id"], "lease_id": row["lease_id"], "receiving_goal": row["receiving_goal"],
                "deleted": bool(row["deleted_at"]),
                "links_rev": self._links_rev(row["turn_id"]) if links_rev is None else links_rev,
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def _studio_view(self, row, body, links_rev=None):
        """The common intent view for a studio.session intent: the same fields, the person's own request (owner-only
        reads) and, once linked, its session id."""
        request = body.get("request") if isinstance(body.get("request"), dict) else None
        session = self.hive.db.one("SELECT id FROM studio_sessions WHERE intent_id = ?", (row["id"],)) if row["kind"] == STUDIO and row["state"] == "linked" else None
        return {"intent_id": row["id"], "turn_id": row["turn_id"], "kind": row["kind"], "state": row["state"],
                "request_operation_id": row["request_operation_id"], "request_digest": row["request_digest"],
                "destination": json.loads(row["destination"]), "title": (request or {}).get("title"),
                "instruction": None, "instruction_digest": row["instruction_digest"], "budget": None,
                "until": row["expires_at"], "request": request,
                "last_dispatch": json.loads(row["last_dispatch"]) if row["last_dispatch"] else None,
                "last_refusal": json.loads(row["last_refusal"]) if row["last_refusal"] else None,
                "dispatch_id": row["dispatch_id"], "dispatch_started_at": row["dispatch_started_at"],
                "request_id": row["request_id"], "lease_id": row["lease_id"], "receiving_goal": row["receiving_goal"],
                "session_id": session["id"] if session else None, "deleted": bool(row["deleted_at"]),
                "links_rev": self._links_rev(row["turn_id"]) if links_rev is None else links_rev,
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def links(self, turn_id):
        """The durable link view of one turn: every intent, then every attached direct request. Every intent passes the
        R3 audit first (an inconsistent one makes the whole read 409 operation_conflict and changes nothing)."""
        intents = self.hive.db.all("SELECT * FROM ask_intents WHERE turn_id = ? ORDER BY created_at, id", (turn_id,))
        for r in intents:
            self._audit(r)
        out = [{"intent_id": r["id"], "request_id": r["request_id"], "state": r["state"],
                "to_swarm": json.loads(r["destination"]).get("to_swarm"),
                "last_refusal": json.loads(r["last_refusal"]) if r["last_refusal"] else None}
               for r in intents]
        out += [{"intent_id": None, "request_id": r["request_id"], "state": "linked", "to_swarm": r["to_swarm"], "last_refusal": None}
                for r in self.hive.db.all("SELECT l.request_id, q.to_swarm FROM ask_links l LEFT JOIN requests q ON q.id = l.request_id "
                                          "WHERE l.turn_id = ? ORDER BY l.created_at, l.request_id", (turn_id,))]
        return out

    def turn_view(self, viewer, operation_id):
        """GET /api/ask/{op}/links: the owner's read of one turn's intents and links."""
        t = self._turn(viewer, operation_id)
        rev = self._links_rev(t["id"])
        intents = self.hive.db.all("SELECT * FROM ask_intents WHERE turn_id = ? ORDER BY created_at, id", (t["id"],))
        for r in intents:                                  # R3 before any intent is returned
            self._audit(r)
        return {"operation_id": t["operation_id"], "turn_id": t["id"], "links_rev": rev, "links": self.links(t["id"]),
                "intents": [self.view(r, rev) for r in intents]}

    def get(self, viewer, intent_id):
        row = self._own(viewer, intent_id)
        self._audit(row)
        return self.view(row)

    def list(self, viewer, state=None, limit=LIST_LIMIT):
        if state is not None and state not in STATES:
            raise self._bad(f"state is one of {list(STATES)}")
        if type(limit) is not int or not 1 <= limit <= LIST_LIMIT:
            raise self._bad(f"limit is 1 to {LIST_LIMIT}")
        sql, params = "SELECT * FROM ask_intents WHERE principal = ?", [viewer.principal]
        if state is not None:
            sql, params = sql + " AND state = ?", params + [state]
        rows = self.hive.db.all(sql + " ORDER BY created_at DESC, id DESC LIMIT ?", (*params, limit))
        for r in rows:                                     # R3 before any intent is returned
            self._audit(r)
        return {"intents": [self.view(r) for r in rows]}

    # ---- R3: a read-only integrity audit -----------------------------------------------------------------------------

    def _operation(self, row):
        return self.hive.db.one("SELECT * FROM mind_operations WHERE scope = ? AND operation_id = ?",
                                (row["principal"], row["request_operation_id"]))

    def _audit(self, row):
        """A linked intent has its matching operation record and an unlinked one has none. A mismatch is logged and
        answered 409 operation_conflict; it never changes state."""
        op = self._operation(row)
        if row["state"] == "linked":
            ok = op is not None and op["digest"] == row["request_digest"]
        else:
            ok = op is None
        if not ok:
            log.error("ask: intent %s (%s) does not match its operation record (%s); nothing changed", row["id"], row["state"],
                      "present" if op else "absent")
            raise self._err(409, "operation_conflict", "That intent's record does not match; nothing was changed.",
                            intent_id=row["id"])
        return op

    # ---- record ------------------------------------------------------------------------------------------------------

    def _gate(self, kind, admin):
        """The kind's own gate: code.request needs a named admin person (r2.13); studio.session any named person."""
        if KINDS.get(kind, {"admin_only": True})["admin_only"] and not admin:
            raise self._err(403, "person_required", "a named, signed-in admin person sends instructions")

    def record(self, viewer, operation_id, data, admin=None):
        """POST /api/ask/{op}/intents {kind: "code.request", request: <r2.13 body without operation_id>}, or
        {kind: "studio.session", request: <the studio request>} (J3 host R2).
        Returns (status, view): 201 for a new intent, 200 for the same body as the turn's live pending intent.
        admin: the route's named-admin check (app._person_admin); in process it is the viewer's admin flag."""
        from .ask import forbidden
        hive = self.hive
        self._gate(data.get("kind") if isinstance(data, dict) else None, viewer.admin if admin is None else admin)
        t = self._turn(viewer, operation_id)
        created = _iso_time(t["created_at"])
        if created is None or datetime.datetime.now(datetime.timezone.utc) - created > TURN_MAX_AGE:
            raise self._bad("that Ask turn is more than 24 hours old; ask again", reason="turn_too_old")
        if forbidden(data):
            raise self._bad("authority, identity and money are derived by the hive", fields=forbidden(data))
        if set(data) != {"kind", "request"}:
            raise self._bad("the body is exactly {kind, request}")
        if data["kind"] not in KINDS:
            raise self._bad(f"kind is one of {sorted(KINDS)}")
        if data["kind"] == TEST:
            raise self._bad("code.test requires the original asynchronous retained-Source record path")
        if data["kind"] == STUDIO:
            return self._record_studio(viewer, t, created, data["request"])
        request = data["request"]
        if not isinstance(request, dict):
            raise self._bad("request is the r2.13 body without operation_id")
        if "operation_id" in request:
            raise self._bad("operation_id is host-derived; leave it out of the request")
        intent_id = "ai_" + secrets.token_hex(12)
        body = {**request, "operation_id": KEY_PREFIX + intent_id}
        hive.minds._instruction_body(body)          # only r2.13 names, the r2.13 shape and limits (400 bad_request)
        # the intent's authority window never outlives its turn's: until = min(until, turn created + 24 h)
        cap = created + TURN_MAX_AGE
        if cap <= datetime.datetime.now(datetime.timezone.utc):
            raise self._bad("that Ask turn is more than 24 hours old; ask again", reason="turn_too_old")
        if parse_time(body["lifetime"]["until"]) > cap:
            body["lifetime"] = {"until": rfc3339_ms(cap)}
        same = canonical({k: v for k, v in body.items() if k != "operation_id"})
        origin = body["origin"]
        destination = canonical({"to_swarm": body["to_swarm"], "task_id": origin["task_id"],
                                 "workspace_id": origin["workspace_id"], "repository_id": origin["repository_id"]})
        frames = []
        with hive.db.transaction():
            t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (t["id"],))
            if t["deleted_at"]:
                raise self._not_available()
            live = hive.db.one("SELECT * FROM ask_intents WHERE turn_id = ? AND state IN ('pending', 'dispatching')", (t["id"],))
            if live is not None:
                if live["state"] == "dispatching":
                    raise self._err(409, "intent_in_flight", "That turn's intent is being sent; wait for it to settle.",
                                    intent_id=live["id"], dispatch_id=live["dispatch_id"],
                                    dispatch_started_at=live["dispatch_started_at"])
                kept = {k: v for k, v in json.loads(live["body"]).items() if k != "operation_id"}
                if live["kind"] == KIND and canonical(kept) == same:
                    self._audit(live)                      # R3 before the intent is returned
                    return 200, self.view(live)
                raise self._err(409, "intent_pending", "That turn already has an intent waiting to be sent.", intent_id=live["id"])
            stamp = now()
            refused_rows = hive.db.all("SELECT * FROM ask_intents WHERE turn_id = ? AND state = 'refused'", (t["id"],))
            for refused in refused_rows:                   # R3 on every predecessor before any of them is replaced
                self._audit(refused)
            for refused in refused_rows:
                hive.db.execute("UPDATE ask_intents SET state = 'abandoned', updated_at = ? WHERE id = ? AND state = 'refused'",
                                (stamp, refused["id"]))
                self._bump(t["id"])
                frames.append(self._frame(t["id"], refused["id"], "abandoned"))
            hive.db.insert("ask_intents", {
                "id": intent_id, "turn_id": t["id"], "principal": viewer.principal, "kind": KIND,
                "request_operation_id": body["operation_id"], "body": canonical(body),
                "request_digest": sha(canonical({"route": "request", "body": body})),     # the digest instruct records
                "destination": destination, "instruction_digest": sha(body["instruction"]), "state": "pending",
                "dispatch_id": None, "dispatch_started_at": None, "last_dispatch": None, "last_refusal": None,
                "request_id": None, "lease_id": None, "receiving_goal": None, "deleted_at": None,
                "created_at": stamp, "updated_at": stamp, "expires_at": body["lifetime"]["until"]})
            self._bump(t["id"])
            frames.append(self._frame(t["id"], intent_id, "pending"))
        self.ask._publish(frames)
        return 201, self.view(self._row(intent_id))

    async def record_async(self, viewer, operation_id, data, admin=None):
        """Same existing POST route; only code.test needs the original async Source read."""
        if not isinstance(data, dict) or data.get("kind") != TEST:
            return self.record(viewer, operation_id, data, admin=admin)
        from .code_test_intents import clean, current, verify
        self._gate(TEST, viewer.admin if admin is None else admin)
        if set(data) != {"kind", "request"}:
            raise self._bad("the body is exactly {kind, request}")
        t = self._turn(viewer, operation_id)
        created = _iso_time(t["created_at"])
        if created is None or datetime.datetime.now(datetime.timezone.utc) - created > TURN_MAX_AGE:
            raise self._bad("that Ask turn is more than24 hours old", reason="turn_too_old")
        request = clean(self, data["request"])
        context, _ = await verify(self, viewer, request)
        req, lease, origin, grant, _ = context
        cap = min(created + TURN_MAX_AGE, parse_time(lease["until"]),
                  datetime.datetime.fromtimestamp(grant["expires_at"], datetime.timezone.utc))
        if cap <= datetime.datetime.now(datetime.timezone.utc):
            raise self._err(403, "code_test_lease", "the original request window has expired")
        intent_id = "ai_" + secrets.token_hex(12)
        body = {"kind": TEST, "request": request}
        same, frames = canonical(body), []
        with self.hive.db.transaction():
            if current(self, viewer.principal, request) != context:
                raise self._err(403, "code_test_lease", "the original request context changed")
            t = self.hive.db.one("SELECT * FROM ask_turns WHERE id=?", (t["id"],))
            if t["deleted_at"]:
                raise self._not_available()
            live = self.hive.db.one("SELECT * FROM ask_intents WHERE turn_id=? AND state IN ('pending','dispatching')", (t["id"],))
            if live is not None:
                if live["state"] == "dispatching":
                    raise self._err(409, "intent_in_flight", "that intent is being sent", intent_id=live["id"])
                if live["kind"] == TEST and live["body"] == same:
                    self._audit(live)
                    return 200, self.view(live)
                raise self._err(409, "intent_pending", "that turn already has an intent", intent_id=live["id"])
            refused_rows = self.hive.db.all("SELECT * FROM ask_intents WHERE turn_id=? AND state='refused'", (t["id"],))
            for refused in refused_rows:
                self._audit(refused)
            for refused in refused_rows:
                self.hive.db.execute("UPDATE ask_intents SET state='abandoned',updated_at=? WHERE id=? AND state='refused'", (now(), refused["id"]))
                self._bump(t["id"])
                frames.append(self._frame(t["id"], refused["id"], "abandoned"))
            at = now()
            self.hive.db.insert("ask_intents", {
                "id": intent_id, "turn_id": t["id"], "principal": viewer.principal, "kind": TEST,
                "request_operation_id": KEY_PREFIX + intent_id, "body": same,
                "request_digest": sha(canonical({"route": TEST, "body": body})),
                "destination": canonical({"to_swarm": req["to_swarm"], "task_id": origin["task_id"],
                    "workspace_id": origin["workspace_id"], "repository_id": origin["repository_id"]}),
                "instruction_digest": sha(canonical(request)), "state": "pending",
                "dispatch_id": None, "dispatch_started_at": None, "last_dispatch": None, "last_refusal": None,
                "request_id": None, "lease_id": None, "receiving_goal": None, "deleted_at": None,
                "created_at": at, "updated_at": at, "expires_at": rfc3339_ms(cap)})
            self._bump(t["id"])
            frames.append(self._frame(t["id"], intent_id, "pending"))
        self.ask._publish(frames)
        return 201, self.view(self._row(intent_id))

    def _record_studio(self, viewer, t, created, request):
        """Record one studio.session intent: the exact canonical request and its digest, and nothing else. The intent's
        own window ends with its turn's 24 hours (as code.request's lifetime is capped); the session's window is set
        from window_minutes when it is admitted. 404 while Studio sessions are off (plan r1.3 F4.2)."""
        hive = self.hive
        hive.studio.require_enabled()
        if isinstance(request, dict) and request.get("maker_id") is None and getattr(hive, "studio_makers", None) is not None:
            # R7: no maker named: the person's own Studio maker. Made on demand here exactly as POST /api/studio/setup
            # makes it (apps ready on install, Jon 10-27: a mind's handoff from the Ask must not stop at "set up your
            # Studio maker first"); ensure() keeps every guard: Studio on, a named person, their own key (402
            # own_key_needed with nothing made). The Studio home, app pin, key, model, role and tools the request did not
            # carry are the host's current values. Recording sends nothing: submitting stays the person's own act.
            # Only a person with no maker yet gets one made; an existing binding is used exactly as before (never re-resolved
            # or re-audited here: admission keeps judging a changed key as it always has).
            makers = hive.studio_makers
            row = makers.bound(viewer.principal) or makers.ensure(viewer.principal)[0]
            request = makers.fill(viewer.principal, {k: v for k, v in request.items() if k != "maker_id"}, row)
        cleaned = hive.studio.clean_request(request)
        hive.studio.refuse_others_maker(viewer.principal, cleaned["maker_id"])   # R7, before anything is stored
        intent_id = "ai_" + secrets.token_hex(12)
        body = {"kind": STUDIO, "request": cleaned}
        same = canonical(body)
        destination = canonical({"to_swarm": cleaned["swarm_id"], "maker_id": cleaned["maker_id"],
                                 "program_id": cleaned["program_id"]})
        frames = []
        with hive.db.transaction():
            t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (t["id"],))
            if t["deleted_at"]:
                raise self._not_available()
            live = hive.db.one("SELECT * FROM ask_intents WHERE turn_id = ? AND state IN ('pending', 'dispatching')", (t["id"],))
            if live is not None:
                if live["state"] == "dispatching":
                    raise self._err(409, "intent_in_flight", "That turn's intent is being sent; wait for it to settle.",
                                    intent_id=live["id"], dispatch_id=live["dispatch_id"],
                                    dispatch_started_at=live["dispatch_started_at"])
                if live["kind"] == STUDIO and live["body"] == same:
                    self._audit(live)
                    return 200, self.view(live)
                raise self._err(409, "intent_pending", "That turn already has an intent waiting to be sent.", intent_id=live["id"])
            stamp = now()
            refused_rows = hive.db.all("SELECT * FROM ask_intents WHERE turn_id = ? AND state = 'refused'", (t["id"],))
            for refused in refused_rows:
                self._audit(refused)
            for refused in refused_rows:
                hive.db.execute("UPDATE ask_intents SET state = 'abandoned', updated_at = ? WHERE id = ? AND state = 'refused'",
                                (stamp, refused["id"]))
                self._bump(t["id"])
                frames.append(self._frame(t["id"], refused["id"], "abandoned"))
            hive.db.insert("ask_intents", {
                "id": intent_id, "turn_id": t["id"], "principal": viewer.principal, "kind": STUDIO,
                "request_operation_id": KEY_PREFIX + intent_id, "body": same,
                "request_digest": sha(canonical({"route": STUDIO, "body": body})),
                "destination": destination, "instruction_digest": sha(cleaned["detail"]), "state": "pending",
                "dispatch_id": None, "dispatch_started_at": None, "last_dispatch": None, "last_refusal": None,
                "request_id": None, "lease_id": None, "receiving_goal": None, "deleted_at": None,
                "created_at": stamp, "updated_at": stamp, "expires_at": rfc3339_ms(created + TURN_MAX_AGE)})
            self._bump(t["id"])
            frames.append(self._frame(t["id"], intent_id, "pending"))
        self.ask._publish(frames)
        return 201, self.view(self._row(intent_id))

    # ---- submit: S1-S4 ---------------------------------------------------------------------------------------------

    def _answer(self, row):
        """S4: the linked intent's answer is the recorded r2.13 status and body, exactly: Minds._replay on the stored
        key and request_digest, as instruct's own replay answers, so it holds after expiry, cancel, a links_rev change
        or a deleted thread. Current intent metadata is served by the reads only."""
        self._audit(row)
        return self.hive.minds._replay(row["principal"], row["request_operation_id"], row["request_digest"])

    def _link(self, intent_id, dispatch_id, recorded):
        """The bind instruct runs inside its own transaction after _record: dispatching(dispatch_id) -> linked. Zero rows
        raises, so the request, goal, lease and operation record all roll back with it (R0)."""
        hive = self.hive
        moved = hive.db.execute("UPDATE ask_intents SET state = 'linked', request_id = ?, lease_id = ?, receiving_goal = ?, "
                                "updated_at = ? WHERE id = ? AND state = 'dispatching' AND dispatch_id = ?",
                                (recorded["request_id"], recorded["lease_id"], recorded["receiving_goal"], now(),
                                 intent_id, dispatch_id)).rowcount
        if moved != 1:
            raise self._err(409, "operation_conflict", "That intent is no longer being sent; nothing was created.",
                            intent_id=intent_id)
        turn_id = self._row(intent_id)["turn_id"]
        self._bump(turn_id)
        # the turn's frame names what the hand-off created (Surface receipts r1 §4): its goal, and a Studio session
        extra = {"goal_id": recorded["receiving_goal"]} if recorded.get("receiving_goal") else {}
        if recorded.get("session_id"):
            extra["session_id"] = recorded["session_id"]
        frame = self._frame(turn_id, intent_id, "linked", request_id=recorded["request_id"], **extra)
        hive.db.after_commit(lambda: self.ask._publish([frame]))

    async def submit(self, viewer, intent_id, admin=None):
        hive = self.hive
        admin = viewer.admin if admin is None else admin
        if not admin:                                      # a member: their own studio.session or code.test intent, else 403 as before
            found = self._row(intent_id)
            if found is None or found["principal"] != viewer.principal or found["kind"] not in (STUDIO, TEST):
                self._gate(KIND, False)
        row = self._own(viewer, intent_id)
        if row["kind"] == STUDIO:
            hive.studio.require_enabled()                  # plan r1.3 F4.2: off means not available, replays included
        if row["state"] == "linked":                       # S4: a replay creates nothing
            return self._answer(row)
        if row["state"] in ("pending", "refused"):
            self._audit(row)                               # R3, read-only, before anything moves
        dispatch_id, frames = "ad_" + secrets.token_hex(12), []
        with hive.db.transaction():                        # S1: the claim
            claimed = hive.db.execute(
                "UPDATE ask_intents SET state = 'dispatching', dispatch_id = ?, dispatch_started_at = ?, updated_at = ? "
                "WHERE id = ? AND principal = ? AND state IN ('pending', 'refused') AND deleted_at IS NULL",
                (dispatch_id, now(), now(), row["id"], viewer.principal)).rowcount == 1
            if claimed:
                self._bump(row["turn_id"])
                frames.append(self._frame(row["turn_id"], row["id"], "dispatching", dispatch_id=dispatch_id))
        if not claimed:
            row = self._row(row["id"])
            if row["state"] == "linked":
                return self._answer(row)
            if row["state"] == "dispatching":
                raise self._err(409, "intent_in_flight", "That intent is being sent; wait for it to settle.",
                                intent_id=row["id"], dispatch_id=row["dispatch_id"], dispatch_started_at=row["dispatch_started_at"])
            raise self._err(409, "intent_closed", "That intent was abandoned or its thread deleted; it can't be sent.",
                            intent_id=row["id"])
        self.ask._publish(frames)
        stored = self._row(row["id"])
        body = json.loads(stored["body"])     # the stored body; the browser never re-sends it
        error = None
        try:                                               # S2: the dispatch, linked inside instruct's transaction
            if stored["kind"] == STUDIO:                   # J3 R2: one admission transaction. No goal announce (plan r1.1
                # S6.1): the session's step message is the maker's only prompt, and it names the goal
                goal = hive.studio.admit(viewer, stored, bind=lambda recorded: self._link(row["id"], dispatch_id, recorded))
                hive.goals._emit(goal["id"])
            elif stored["kind"] == TEST:
                from .code_test_intents import dispatch
                await dispatch(self, viewer, stored, bind=lambda recorded: self._link(row["id"], dispatch_id, recorded))
            else:
                await hive.minds.instruct(viewer.principal, body, bind=lambda recorded: self._link(row["id"], dispatch_id, recorded))
        except BaseException as exc:                       # noqa: BLE001  (settled by row state below, then re-raised)
            error = exc
        return self._settle(row["id"], dispatch_id, error)  # S3

    def _settle(self, intent_id, dispatch_id, error):
        """S3: settle by the row's state, never by the status code. Linked: the recorded answer (also when a post-commit
        await raised). Still dispatching(dispatch_id): instruct's transaction did not commit (R0), so the intent becomes
        refused (an HTTP 4xx), pending (anything else) or abandoned (its thread was deleted meanwhile)."""
        from .hive import HiveError
        hive = self.hive
        row = self._row(intent_id)
        if row["state"] == "linked":
            if error is not None and not isinstance(error, Exception):
                raise error                                # cancellation and the like still propagate
            return self._answer(row)
        if row["state"] != "dispatching" or row["dispatch_id"] != dispatch_id:
            log.error("ask: intent %s left dispatching(%s) outside its own settle (now %s)", intent_id, dispatch_id, row["state"])
            if error is not None and not isinstance(error, Exception):
                raise error
            raise self._err(409, "operation_conflict", "That intent changed while it was being sent; nothing was created.",
                            intent_id=intent_id)
        # R0 first: if this key's record exists (a raced winner, or a replay), the request exists, so the intent links
        # from that record under the same CAS; a 409 operation_conflict from instruct is never proof of a refusal.
        op = self._operation(row)
        if op is not None and op["digest"] == row["request_digest"]:
            try:
                with hive.db.transaction():
                    self._link(intent_id, dispatch_id, json.loads(op["body"]))
            except HiveError:
                log.error("ask: intent %s could not link from its operation record", intent_id)
            else:
                log.warning("ask: intent %s linked from its operation record after %s", intent_id,
                            type(error).__name__ if error is not None else "an unlinked answer")
                if error is not None and not isinstance(error, Exception):
                    raise error
                return self._answer(self._row(intent_id))
        raced = isinstance(error, HiveError) and error.code == "operation_conflict"
        refused = isinstance(error, HiveError) and 400 <= error.status < 500 and not raced
        code = error.code if isinstance(error, HiveError) else (type(error).__name__ if error is not None else "not_linked")
        stamp = now()
        if row["deleted_at"]:
            state, outcome = "abandoned", ("refused" if refused else "not_committed")
        elif refused:
            state, outcome = "refused", "refused"
        else:
            state, outcome = "pending", "not_committed"
        last_dispatch = canonical({"dispatch_id": dispatch_id, "outcome": outcome, "code": code, "at": stamp})
        frames = []
        with hive.db.transaction():
            moved = hive.db.execute(
                "UPDATE ask_intents SET state = ?, last_dispatch = ?, last_refusal = CASE WHEN ? THEN ? ELSE last_refusal END, "
                "updated_at = ? WHERE id = ? AND state = 'dispatching' AND dispatch_id = ?",
                (state, last_dispatch, refused, canonical({"code": code, "status": getattr(error, "status", None), "at": stamp}),
                 stamp, intent_id, dispatch_id)).rowcount
            if moved == 1:
                self._bump(row["turn_id"])
                frames.append(self._frame(row["turn_id"], intent_id, state))
        self.ask._publish(frames)
        if error is not None:
            raise error
        # instruct returned without linking: only a replay of an operation record this intent never wrote can do that
        log.error("ask: intent %s: instruct answered without the link; settled %s", intent_id, state)
        raise self._err(409, "operation_conflict", "That intent's record does not match; nothing was created.", intent_id=intent_id)

    # ---- abandon -----------------------------------------------------------------------------------------------------

    def abandon(self, viewer, intent_id):
        hive = self.hive
        row = self._own(viewer, intent_id)
        if row["state"] in ("pending", "refused"):
            self._audit(row)
        frames = []
        with hive.db.transaction():
            moved = hive.db.execute("UPDATE ask_intents SET state = 'abandoned', updated_at = ? WHERE id = ? AND state IN ('pending', 'refused')",
                                    (now(), row["id"])).rowcount == 1
            if moved:
                self._bump(row["turn_id"])
                frames.append(self._frame(row["turn_id"], row["id"], "abandoned"))
        self.ask._publish(frames)
        row = self._row(row["id"])
        if row["state"] == "dispatching":
            raise self._err(409, "intent_in_flight", "That intent is being sent; it can't be abandoned now.",
                            intent_id=row["id"], dispatch_id=row["dispatch_id"], dispatch_started_at=row["dispatch_started_at"])
        if row["state"] == "linked":
            raise self._err(409, "intent_linked", "That intent's request was created; cancel the request instead.",
                            intent_id=row["id"], request_id=row["request_id"])
        return self.view(row)                              # abandoned (now, or already: idempotent)

    # ---- links -------------------------------------------------------------------------------------------------------

    def attach(self, viewer, operation_id, data):
        """POST /api/ask/{op}/links {request_id}: attach the caller's own direct request. Grants and changes nothing on the
        request; idempotent per (turn, request). Returns (status, link view)."""
        hive = self.hive
        t = self._turn(viewer, operation_id)
        if set(data) != {"request_id"} or not isinstance(data["request_id"], str) or not 0 < len(data["request_id"]) <= 200:
            raise self._bad("the body is exactly {request_id}")
        req = hive.db.one("SELECT id, from_principal, to_swarm FROM requests WHERE id = ?", (data["request_id"],))
        # links are cross-swarm by design (a turn's intents go to the Code team swarm) and grant nothing; the Link view
        # names each request's to_swarm instead
        if req is None or req["from_principal"] != viewer.principal:
            raise self._not_available()
        frames = []
        with hive.db.transaction():
            t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (t["id"],))
            if t["deleted_at"]:
                raise self._not_available()
            intent = hive.db.one("SELECT id FROM ask_intents WHERE turn_id = ? AND request_id = ?", (t["id"], req["id"]))
            exists = intent is not None or hive.db.one("SELECT 1 FROM ask_links WHERE turn_id = ? AND request_id = ?", (t["id"], req["id"]))
            if not exists:
                hive.db.insert("ask_links", {"turn_id": t["id"], "request_id": req["id"], "principal": viewer.principal,
                                             "created_at": now()})
                self._bump(t["id"])   # its own phase: a direct link is not an intent
                frames.append(self.ask._frame(t["id"], "link", request_id=req["id"], links_rev=self._links_rev(t["id"])))
        self.ask._publish(frames)
        return (200 if exists else 201), {"operation_id": t["operation_id"], "turn_id": t["id"], "request_id": req["id"],
                                          "to_swarm": req["to_swarm"],
                                          "intent_id": intent["id"] if intent else None, "state": "linked",
                                          "links_rev": self._links_rev(t["id"])}

    # ---- thread deletion and startup recovery --------------------------------------------------------------------------

    def on_delete(self, turn_id, stamp):
        """Inside delete_thread's transaction (a.5): pending/refused -> abandoned; linked keeps ids and digests;
        dispatching keeps its key, digest, dispatch_id and state (a commit still links; a non-commit is abandoned by
        its own settle or by recovery). Every body is blanked. The request itself is never cancelled here."""
        db = self.hive.db
        rows = db.all("SELECT id FROM ask_intents WHERE turn_id = ?", (turn_id,))
        if not rows:
            return
        db.execute("UPDATE ask_intents SET state = 'abandoned' WHERE turn_id = ? AND state IN ('pending', 'refused')", (turn_id,))
        db.execute("UPDATE ask_intents SET body = '{}', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE turn_id = ?",
                   (stamp, stamp, turn_id))
        self._bump(turn_id)

    @staticmethod
    def recover_startup(tx):
        """Step 2 of the one combined §L startup recovery (R2b), inside its transaction: a dispatching intent left by a
        previous process did not commit (a committed dispatch is already linked, R0), so it becomes pending with
        last_dispatch.outcome "not_committed_restart", or abandoned when its thread was deleted. Returns the count."""
        if not tx.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ask_intents'"):
            return 0
        turns_rev = bool(tx.one("SELECT 1 FROM pragma_table_info('ask_turns') WHERE name = 'links_rev'"))
        stamp = now()
        rows = tx.all("SELECT id, turn_id, dispatch_id, deleted_at FROM ask_intents WHERE state = 'dispatching'")
        for r in rows:
            last = canonical({"dispatch_id": r["dispatch_id"], "outcome": "not_committed_restart", "code": None, "at": stamp})
            tx.execute("UPDATE ask_intents SET state = ?, last_dispatch = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'",
                       ("abandoned" if r["deleted_at"] else "pending", last, stamp, r["id"]))
            if turns_rev:
                tx.execute("UPDATE ask_turns SET links_rev = links_rev + 1 WHERE id = ?", (r["turn_id"],))
        return len(rows)
