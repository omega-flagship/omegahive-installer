"""First Light, host round R1a: a person's own onboarding progress, their "finish setting up" list, and the first hello.

Plan: PLATFORM_ONBOARDING_PLAN_R1.md (Jon approved it 2026-10-12, "Sure").

- Progress belongs to the signed-in person (their principal, user:u_...), not the browser: it survives sign-out and a
  new device, and an identity change never sees another person's row. Only that person reads or writes it; there is no
  admin route to it. Anyone who is not a named, enabled person (the loopback operator, a mind's token, a family sign-in
  without a people row) is refused with 403 person_required, as /api/me/mind is.
- Beat ids come from one list (BEATS); role paths from ROLE_PATHS. A write naming anything else is refused whole.
- The record carries a `version` that goes up by one on every write. A write may name the version it was made against
  (`version` in the body); a different current version is refused (409 stale_onboarding, with the current record), so
  two tabs never silently overwrite each other. A write without one is unconditional.
- The checklist (GET /api/me/setup) is derived on every read from the live state behind each item (keys, the person's
  progress, Ask preferences, the personal mind's row, harness invites); nothing about it is stored, so it cannot drift.
- The hello (POST /api/me/personal-mind/hello) wakes the person's own personal mind through the ordinary lifecycle wake
  and sends it one hive note in the person's own conversation with it (c_<mind>~<principal>, the chat the page opens),
  through Hive.send_to_agent, the ordinary message path. The mind answers in its own words, on its own model, paid as a
  personal mind's calls always are (Hive.payer_for: its person, from their allowance or their own key), under every
  budget gate on the model route. Before waking anything the host checks, without side effects, that the mind could
  make a call at all (a key, an allowance, room under the limits) and otherwise refuses with a reason the page can show.
  One hello per person and mind: a second call returns the first one (and the greeting, once the mind has sent it),
  never a new message and never a second wake.
- Schema changes are additive only: two new tables. harness_invites.billing (mcp.py) is an added column.
- Own hive H1 (ownhive.py): the monthly_limit item reads the person's own limit on their own keys when they have keys
  (enforced_by "own", set with PUT /api/me/key-limits/self); a guest's reads the limit the host set on their invite
  (enforced_by "invite"), with the route to ask for more and any request still waiting. Everyone else's is as before.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import secrets

from .db import now

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS onboarding_progress (principal TEXT PRIMARY KEY, current_beat TEXT,
  beats_done TEXT NOT NULL DEFAULT '[]', beats_skipped TEXT NOT NULL DEFAULT '[]', role_path TEXT, monthly_spend_usd REAL,
  key_choice TEXT, status TEXT NOT NULL DEFAULT 'in_progress', started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0)""",
    # one hello per person: which mind was greeted, in which conversation, with which hive note
    """CREATE TABLE IF NOT EXISTS onboarding_hello (principal TEXT PRIMARY KEY, mind_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, requested_at TEXT NOT NULL, sent_at TEXT)""",
]

RECORD = "first-light.progress/1"
BEATS = ("arrive", "look", "models", "tools", "apps", "ask", "tour", "hello")
ROLE_PATHS = ("admin", "coder", "researcher", "explorer")
STATUSES = ("not_started", "in_progress", "finished", "skipped")
KEY_CHOICES = ("own-key", "hive-keys")
WRITABLE = ("current_beat", "beats_done", "beats_skipped", "role_path", "monthly_spend_usd", "key_choice", "status")
MAX_SPEND_USD = 10000.0
MAX_BODY = 4096
HELLO_SENDER = "hive:first-light"
# An unsent hello claim older than this is abandoned (a cancel or crash between claim and send); the next POST may retry,
# after first adopting any note that did reach the conversation, so a note is never sent twice.
STALE_CLAIM_SECONDS = 180
GREETING_TOKENS_IN, GREETING_TOKENS_OUT = 8000, 1024   # the nominal greeting call the preflight sizes

SAY = {
    "person_required": "Setting up needs a signed-in person with an account here.",
    "invalid": "That isn't in a shape the hive understands.",
    "stale_onboarding": "Your setup changed in another window. Here is where it stands now.",
    "no_model": "Your mind has no model it can think with yet. Choose one for it, or ask an admin.",
    "no_key": "Your mind has no key for its model. Add your own key, or ask an admin to set the hive's.",
    "no_budget": "Your mind has no allowance to think with yet. Ask an admin to set your monthly limit.",
    "spend_limit": "You've reached your spending limit for now, so your mind can't think until it resets or is raised.",
    "own_key_needed": "Your mind would run on someone else's key. Add your own key in Keys, then try again.",
    "hive_limit": "The hive has reached its spending limit, so minds can't think until an admin raises it.",
    "cannot_wake": "Your mind couldn't wake just now. Try again in a moment, or ask an admin.",
    "egress_refused": "Your mind's swarm keeps its thinking on this machine, and its model isn't a local one. "
                      "Choose a local model for it, or ask an admin.",
}
STATUS = {"person_required": 403, "invalid": 400, "stale_onboarding": 409, "no_model": 409, "no_key": 402,
          "no_budget": 402, "spend_limit": 402, "own_key_needed": 402, "hive_limit": 402, "cannot_wake": 409,
          "egress_refused": 403}

ROLE_WORDS = {"admin": "run and set up this hive", "coder": "write and review code with minds",
              "researcher": "research and think things through with minds", "explorer": "look around and see what minds can do"}

# where each "finish setting up" item is fixed (the UI's hash routes; #/first-light is Surface's R2 journey)
ROUTES = {"provider_key": "#/me", "monthly_limit": "#/first-light?beat=models", "ask_prefs": "#/first-light?beat=ask",
          "mind_awake": "#/me/mind", "outside_tool": "#/connect", "onboarding": "#/first-light"}


class Onboarding:
    def __init__(self, hive, gateway=None):
        self.hive = hive
        self.gateway = gateway
        for statement in SCHEMA:
            hive.db.execute(statement)
        # additive (R1a.2): which request owns an unsent claim; only that request may send and stamp the note
        if "claim_token" not in {r["name"] for r in hive.db.all("PRAGMA table_info(onboarding_hello)")}:
            hive.db.execute("ALTER TABLE onboarding_hello ADD COLUMN claim_token TEXT")

    # ---- who ------------------------------------------------------------------------------------------------------

    def _refuse(self, code, **details):
        return self.hive.error(STATUS[code], code, SAY[code], details or None)

    def person(self, viewer):
        """The enabled people row behind the caller, or 403 person_required. Only that person's own principal is used
        from here on, so no route can name another person."""
        person = self.hive.personal.person(getattr(viewer, "principal", None))
        if person is None:
            raise self._refuse("person_required")
        return person

    # ---- progress -------------------------------------------------------------------------------------------------

    @staticmethod
    def blank():
        return {"current_beat": None, "beats_done": [], "beats_skipped": [], "role_path": None, "monthly_spend_usd": None,
                "key_choice": None, "status": "not_started", "started_at": None, "finished_at": None, "updated_at": None,
                "version": 0}

    def _row(self, principal):
        row = self.hive.db.one("SELECT * FROM onboarding_progress WHERE principal = ?", (principal,))
        if row is None:
            return self.blank()
        return {"current_beat": row["current_beat"], "beats_done": json.loads(row["beats_done"]),
                "beats_skipped": json.loads(row["beats_skipped"]), "role_path": row["role_path"],
                "monthly_spend_usd": row["monthly_spend_usd"], "key_choice": row["key_choice"], "status": row["status"],
                "started_at": row["started_at"], "finished_at": row["finished_at"], "updated_at": row["updated_at"],
                "version": int(row["version"])}

    @staticmethod
    def view(record):
        return {"record": RECORD, **record, "beats": list(BEATS), "role_paths": list(ROLE_PATHS)}

    def get(self, viewer):
        """GET /api/me/onboarding: the caller's own record; a blank one (version 0) if they have never started."""
        person = self.person(viewer)
        return self.view(self._row("user:" + person["id"]))

    @staticmethod
    def check(data, base):
        """The writable fields of `data` applied over `base`, validated; raises ValueError naming the first problem."""
        if not isinstance(data, dict):
            raise ValueError("body must be an object")
        extra = set(data) - set(WRITABLE) - {"version"}
        if extra:
            raise ValueError("unknown fields: " + ", ".join(sorted(map(str, extra))))
        out = dict(base)
        for key in WRITABLE:
            if key in data:
                out[key] = data[key]
        if out["current_beat"] is not None and out["current_beat"] not in BEATS:
            raise ValueError("current_beat must be one of " + ", ".join(BEATS))
        for key in ("beats_done", "beats_skipped"):
            value = out[key]
            if not isinstance(value, list) or not all(isinstance(b, str) and b in BEATS for b in value):
                raise ValueError(f"{key} must be a list of beats ({', '.join(BEATS)})")
            out[key] = [b for b in BEATS if b in value]   # one order, no repeats
        both = set(out["beats_done"]) & set(out["beats_skipped"])
        if both:
            raise ValueError("a beat is either done or skipped, not both: " + ", ".join(b for b in BEATS if b in both))
        if out["role_path"] is not None and out["role_path"] not in ROLE_PATHS:
            raise ValueError("role_path must be one of " + ", ".join(ROLE_PATHS))
        spend = out["monthly_spend_usd"]
        if spend is not None:
            if isinstance(spend, bool) or not isinstance(spend, (int, float)) or not 0 <= spend <= MAX_SPEND_USD \
                    or spend != spend:
                raise ValueError(f"monthly_spend_usd must be a number from 0 to {MAX_SPEND_USD:g}")
            out["monthly_spend_usd"] = round(float(spend), 2)
        if out["key_choice"] is not None and out["key_choice"] not in KEY_CHOICES:
            raise ValueError("key_choice must be one of " + ", ".join(KEY_CHOICES))
        if out["status"] not in STATUSES[1:]:
            raise ValueError("status must be one of " + ", ".join(STATUSES[1:]))
        if "version" in data and (isinstance(data["version"], bool) or not isinstance(data["version"], int)
                                  or data["version"] < 0):
            raise ValueError("version must be a whole number (the record's version the write was made against)")
        return out

    def write(self, viewer, data, replace):
        """PUT (replace=True: every writable field from the body, the rest back to blank) or PATCH (only those given)."""
        person = self.person(viewer)
        principal = "user:" + person["id"]
        hive = self.hive
        with hive.db.transaction():   # compare and set in one step: no other write lands between the read and the write
            current = self._row(principal)
            base = dict(self.blank() if replace else current)
            if base["status"] == "not_started":   # any write starts the journey
                base["status"] = "in_progress"
            try:
                record = self.check(data, base)
            except ValueError as exc:
                raise self.hive.error(400, "invalid", f"{SAY['invalid']} {exc}") from None
            if "version" in data and data["version"] != current["version"]:
                raise self._refuse("stale_onboarding", current=self.view(current))
            stamp = now()
            record["started_at"] = current["started_at"] or stamp
            if record["status"] in ("finished", "skipped"):
                same = current["status"] == record["status"]
                record["finished_at"] = current["finished_at"] if same and current["finished_at"] else stamp
            else:
                record["finished_at"] = None
            record["updated_at"] = stamp
            record["version"] = current["version"] + 1
            hive.db.execute(
                "INSERT INTO onboarding_progress (principal, current_beat, beats_done, beats_skipped, role_path, "
                "monthly_spend_usd, key_choice, status, started_at, finished_at, updated_at, version) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET "
                "current_beat = excluded.current_beat, beats_done = excluded.beats_done, "
                "beats_skipped = excluded.beats_skipped, role_path = excluded.role_path, "
                "monthly_spend_usd = excluded.monthly_spend_usd, key_choice = excluded.key_choice, status = excluded.status, "
                "started_at = excluded.started_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at, "
                "version = excluded.version",
                (principal, record["current_beat"], json.dumps(record["beats_done"]), json.dumps(record["beats_skipped"]),
                 record["role_path"], record["monthly_spend_usd"], record["key_choice"], record["status"],
                 record["started_at"], record["finished_at"], record["updated_at"], record["version"]))
        return self.view(record)

    # ---- the "finish setting up" list: derived on every read, never stored -----------------------------------------

    def _own_keys(self, principal):
        keyring = getattr(self.hive, "keyring", None)
        keys = ((keyring.ring.get("keys") if keyring else None) or {}).values()
        return sum(1 for k in keys if k.get("owner") == principal)

    def setup(self, viewer):
        """GET /api/me/setup: the signed-in person's own list, each item read from the one place its truth lives."""
        person = self.person(viewer)
        principal = "user:" + person["id"]
        hive = self.hive
        progress = self._row(principal)
        own_keys = self._own_keys(principal)
        spend = hive.my_spend(principal)
        mind = hive.personal.mind_row(principal)
        joined = hive.db.one(
            "SELECT COUNT(*) AS n FROM harness_invites h JOIN agents a ON a.id = h.agent_id AND a.deleted = 0 "
            "WHERE h.created_by = ? AND h.redeemed_at IS NOT NULL AND h.revoked_at IS NULL", (principal,))["n"]

        def item(key, label, done, optional=False, **detail):
            return {"id": key, "label": label, "done": bool(done), "optional": optional, "route": ROUTES[key],
                    "detail": detail}

        own = hive.ownhive.setup_limit(principal, own_keys)   # own hive H1: your own limit, or a guest's invite limit
        guest = hive.ownhive.access(principal) == "guest"
        if own is None:
            # enforced: a month limit the model route applies to this person's hive-paid spend at call time
            # (Budgets.applicable: their person:<id> month rule, else the member default; an admin with no rule has none)
            monthly = {**item("monthly_limit", "Choose how much you'll spend a month", progress["monthly_spend_usd"] is not None,
                              chosen_usd=progress["monthly_spend_usd"], allowance_usd=spend["allowance_usd"],
                              allowance_origin=spend["allowance_origin"], enforced_by=spend["allowance_origin"]),
                       "enforced": spend["allowance_origin"] is not None}
        else:
            # enforced at call time as a key limit (Budgets.applicable keyuse:<scope>): the person's own limit on their
            # own keys, or the host's grant to a guest
            label = "Your monthly limit from your host" if guest else "Choose how much your own minds may spend a month"
            monthly = {**item("monthly_limit", label, own["done"], chosen_usd=progress["monthly_spend_usd"],
                              allowance_usd=own["limit_usd"], allowance_origin=own["enforced_by"],
                              **{k: v for k, v in own.items() if k not in ("done", "enforced")}),
                       "enforced": own["enforced"]}

        items = [
            item("provider_key", "Connect your own model key, or choose to use the hive's",
                 own_keys > 0 or progress["key_choice"] == "hive-keys" or guest, own_keys=own_keys,
                 choice=progress["key_choice"], guest=guest),
            monthly,
            item("ask_prefs", "Set up your Ask: who answers, and what a conversation may spend",
                 hive.db.one("SELECT 1 FROM ask_prefs WHERE principal = ?", (principal,)) is not None),
            item("mind_awake", "Wake your personal mind and say hello",
                 mind is not None and (mind.get("last_active_at") is not None or mind["status"] in ("awake", "starting")),
                 mind_id=mind["id"] if mind else None, status=mind["status"] if mind else None),
            item("outside_tool", "Bring in an outside tool, such as Claude Code, Codex or Kimi", joined > 0, optional=True,
                 joined=joined),
            item("onboarding", "Finish First Light, or skip it", progress["status"] in ("finished", "skipped"),
                 status=progress["status"]),
        ]
        required = [i for i in items if not i["optional"]]
        return {"items": items, "done": sum(i["done"] for i in required), "total": len(required),
                "complete": all(i["done"] for i in required)}

    # ---- wake and greet ---------------------------------------------------------------------------------------------

    def preflight(self, mind):
        """Whether the mind could make one greeting call now, without side effects (no rate counter, no refusal record,
        no reservation): the model route's own gates run again, for real, on the call the mind makes."""
        from .config import is_subscription
        from .gateway import GatewayError, split_model
        hive, gw = self.hive, self.gateway
        if gw is None:
            return None
        try:
            provider_name, model = split_model(mind["model"])
            provider = gw.provider(provider_name)
            gw.enforce_egress(mind, provider_name)
        except GatewayError as exc:   # each gateway code to the sentence that matches it
            raise self._refuse("egress_refused" if exc.code == "egress_refused" else "no_model") from None
        if provider.local:
            return None   # local and mock models cost nothing
        if is_subscription(provider_name):
            # the owner's plan: no price and no paying key by design; ready exactly when the gate would admit it now
            try:
                gw.admit_subscription(mind, provider=provider_name)
            except GatewayError:
                raise self._refuse("no_model") from None
            return None
        if not provider.priced(model) and not hive.settings.allow_unpriced:
            raise self._refuse("no_model")
        try:
            key_id, secret = gw.paying_key(mind, provider_name)
        except GatewayError:
            raise self._refuse("no_key") from None
        if not secret:
            raise self._refuse("no_key")
        keys = ((gw.keyring.ring.get("keys") if gw.keyring else None) or {})
        key_owner = (keys.get(key_id) or {}).get("owner") if key_id else None
        payer, own_key = hive.payer_for(mind, key_owner)
        estimate = gw.cost(provider, model, GREETING_TOKENS_IN, GREETING_TOKENS_OUT)
        budgets = hive.budgets
        if float(mind.get("budget_usd") or 0) <= 0 and not budgets.paid_without_cap(mind, None, payer, own_key):
            raise self._refuse("no_budget")
        if float(mind.get("budget_usd") or 0) > 0 and float(mind.get("spent_usd") or 0) + estimate > float(mind["budget_usd"]):
            raise self._refuse("spend_limit")
        try:
            budgets.check(mind, estimate, key_id, payer, own_key)
        except Exception as exc:   # a HiveError 402 spend_limit (budgets.check raises nothing else)
            if getattr(exc, "code", None) == "own_key_needed":   # OI-13: another person's key, not a spend limit
                raise self._refuse("own_key_needed") from None
            if getattr(exc, "status", None) == 402:
                raise self._refuse("spend_limit", **{k: v for k, v in (exc.details or {}).items()
                                                     if k in ("period", "limit_usd", "spent_usd")}) from None
            raise
        cap = budgets.hard_cap()
        if cap and budgets.hard_total_spent() + estimate > cap:
            raise self._refuse("hive_limit")
        return None

    def _apps_on(self):
        programs = getattr(self.hive, "programs", None)
        if programs is None:
            return []
        try:
            return [p["name"] for p in programs.list() if p.get("enabled")][:12]
        except Exception:   # noqa: BLE001  (an app that fails to list never stops a hello)
            return []

    def note(self, name, role_path, apps):
        """The hive's note asking the mind for its first greeting: plain words, no instructions beyond the greeting."""
        lines = [f"First Light: {name} has just set up the hive and is opening a chat with you for the first time.",
                 f"Please greet {name} by name in a sentence or two, in your own words, and say that you're awake."]
        if role_path in ROLE_WORDS:
            lines.append(f"They told the hive they will mostly {ROLE_WORDS[role_path]}.")
        if apps:
            lines.append("Apps switched on in this hive: " + ", ".join(apps) + ".")
        lines.append("Offer them one useful first thing to do together, in one line, based on that.")
        return "\n".join(lines)

    def _hello_row(self, principal):
        return self.hive.db.one("SELECT * FROM onboarding_hello WHERE principal = ?", (principal,))

    def _greeting(self, row):
        """The mind's first message in the hello conversation after the note, or None while it has not answered."""
        if not row or not row.get("message_id"):
            return None
        reply = self.hive.db.one(
            "SELECT id, text, created_at FROM messages WHERE agent_id = ? AND conversation_id = ? AND direction = 'out' "
            "AND sender = ? AND created_at >= ? ORDER BY created_at, rowid LIMIT 1",
            (row["mind_id"], row["conversation_id"], "agent:" + row["mind_id"], row["sent_at"] or row["requested_at"]))
        return dict(reply) if reply else None

    def _note(self, mind_id, conversation_id):
        """The first First Light note already in this conversation with this mind, or None."""
        return self.hive.db.one(
            "SELECT id, created_at FROM messages WHERE agent_id = ? AND conversation_id = ? AND direction = 'in' "
            "AND sender = ? ORDER BY created_at, rowid LIMIT 1", (mind_id, conversation_id, HELLO_SENDER))

    def _adopt(self, principal, row):
        """An unsent claim whose note did reach the conversation (a cancel or crash after the send, before the stamp):
        record that note as the hello's. Returns the row, stamped if a note was found."""
        if row is None or row["message_id"]:
            return row
        note = self._note(row["mind_id"], row["conversation_id"])
        if note is None:
            return row
        self.hive.db.execute("UPDATE onboarding_hello SET message_id = ?, sent_at = ? WHERE principal = ? AND mind_id = ? "
                             "AND message_id IS NULL", (note["id"], note["created_at"], principal, row["mind_id"]))
        return self._hello_row(principal)

    @staticmethod
    def _stale(row):
        """An unsent claim older than STALE_CLAIM_SECONDS: whoever made it is gone, so a new POST may retry."""
        if row is None or row["message_id"]:
            return False
        try:
            claimed = datetime.datetime.fromisoformat(str(row["requested_at"]).replace("Z", "+00:00"))
        except ValueError:
            return True
        age = (datetime.datetime.now(datetime.timezone.utc) - claimed).total_seconds()
        return age > STALE_CLAIM_SECONDS

    def hello_view(self, row, mind, created):
        greeting = self._greeting(row)
        return {"mind": {"id": mind["id"], "name": mind["name"], "status": mind["status"]},
                "conversation_id": row["conversation_id"], "message_id": row["message_id"],
                "requested_at": row["requested_at"], "state": "greeted" if greeting else "waiting",
                "greeting": greeting, "created": created, "retryable": self._stale(row)}

    def hello_get(self, viewer):
        """GET /api/me/personal-mind/hello: the hello so far, including one still waiting to be sent (null only when
        none was asked for this mind). Never wakes or sends; it may record a note that already reached the chat."""
        person = self.person(viewer)
        principal = "user:" + person["id"]
        mind = self.hive.personal.mind_row(principal)
        row = self._hello_row(principal)
        if mind is None or row is None or row["mind_id"] != mind["id"]:
            return {"hello": None}
        return {"hello": self.hello_view(self._adopt(principal, row), self.hive.agent(mind["id"]), False)}

    async def hello(self, viewer):
        """POST /api/me/personal-mind/hello: wake the caller's own personal mind and ask it for a first greeting.
        Idempotent per person and mind: a repeat returns the first hello, sends nothing and wakes nothing. An unsent
        claim is recoverable: a note that reached the chat is adopted, and a claim abandoned for STALE_CLAIM_SECONDS is
        retried; a claim is released on any interruption (cancellation included) before its note was sent."""
        from starlette.concurrency import run_in_threadpool
        person = self.person(viewer)
        principal = "user:" + person["id"]
        hive = self.hive
        mind = await run_in_threadpool(hive.personal.ensure, principal)
        conversation = hive.person_conversation(mind["id"], principal)

        def current():
            row = self._adopt(principal, self._hello_row(principal))
            if row is not None and row["mind_id"] == mind["id"] and not self._stale(row):
                return row
            return None
        existing = current()
        if existing is not None:
            return self.hello_view(existing, hive.agent(mind["id"]), False)
        self.preflight(mind)
        token = secrets.token_hex(16)   # this request's claim; a stale retry replaces it with its own
        with hive.db.transaction():   # the claim, under the connection lock: one hello per person and mind
            again = current()
            if again is not None:
                return self.hello_view(again, hive.agent(mind["id"]), False)
            # a hello for a mind that is gone, or a stale unsent claim, is replaced (and with it the old owner's token)
            hive.db.execute("DELETE FROM onboarding_hello WHERE principal = ?", (principal,))
            note = self._note(mind["id"], conversation)   # a note already said (its claim row lost): adopt, never resend
            hive.db.execute("INSERT INTO onboarding_hello (principal, mind_id, conversation_id, message_id, requested_at, "
                            "sent_at, claim_token) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (principal, mind["id"], conversation, note["id"] if note else None, now(),
                             note["created_at"] if note else None, token))
            if note is not None:
                return self.hello_view(self._hello_row(principal), hive.agent(mind["id"]), False)
        progress = self._row(principal)
        text = self.note(self.hive.personal.display_name(person), progress["role_path"], self._apps_on())
        lost = []   # set when the fence finds this request no longer owns the claim

        @contextlib.contextmanager
        def owned():
            """The note is stored only while this request still owns an unsent claim and no note is in the chat yet;
            the check, the insert (send_to_agent's enqueue, a savepoint inside) and the stamp are one transaction."""
            with hive.db.transaction():
                mine = hive.db.one("SELECT 1 FROM onboarding_hello WHERE principal = ? AND mind_id = ? AND claim_token = ? "
                                   "AND message_id IS NULL", (principal, mind["id"], token)) is not None
                if mine and self._note(mind["id"], conversation) is not None:
                    mine = False   # reconcile under the claim: a note is already in the chat (adopted below), never a second
                if not mine:
                    lost.append(True)
                yield mine
                if mine:
                    stored = self._note(mind["id"], conversation)
                    hive.db.execute("UPDATE onboarding_hello SET message_id = ?, sent_at = ? WHERE principal = ? "
                                    "AND claim_token = ? AND message_id IS NULL",
                                    (stored["id"], stored["created_at"], principal, token))
        try:
            if mind["status"] not in ("awake", "starting"):   # the ordinary wake: the supervisor starts it, nothing else
                await run_in_threadpool(hive.lifecycle, mind["id"], "wake",
                                        lambda fresh: fresh["status"] not in ("awake", "starting"))
            await hive.send_to_agent(mind["id"], text, conversation, sender=HELLO_SENDER,
                                     extra={"event": "first_light_hello"}, fence=owned)
        except BaseException as exc:   # cancellation too: never leave a claim stuck
            row = self._adopt(principal, self._hello_row(principal))   # the note may have been stored before the fault
            if lost and isinstance(exc, Exception):   # another request owns the hello now: report it, touch nothing
                if row is not None and row["mind_id"] == mind["id"]:
                    return self.hello_view(row, hive.agent(mind["id"]), False)
                raise self._refuse("cannot_wake") from None
            if row is not None and row["message_id"]:
                if isinstance(exc, Exception):
                    return self.hello_view(row, hive.agent(mind["id"]), row.get("claim_token") == token)
                raise
            hive.db.execute("DELETE FROM onboarding_hello WHERE principal = ? AND claim_token = ? AND message_id IS NULL",
                            (principal, token))   # nothing was said under this claim: the next call may try again
            if getattr(exc, "status", None) in (409, 503):
                raise self._refuse("cannot_wake") from None
            raise
        return self.hello_view(self._hello_row(principal), hive.agent(mind["id"]), True)
