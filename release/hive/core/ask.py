"""Universal Ask, phase 1 (host side): a person's typed request answered by a swarm's coordinator in an Ask thread.

Contract: UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005.md, with OmegaReview's design review (items 1-5)
and Jon's routing ruling ("ask should be the orchestrator or owner of whatever mind you're talking to"). Phase 1 is text
only: no proposals, app tools, ui changes, confirm tokens, delegation or voice.
- Who answers: the coordinator of the addressed mind's swarm, else of the page's swarm, else of the person's default
  swarm (/api/me/ask), else the person's own personal mind (personal minds P2; personal.py). No coordinator, or one the
  person may not use, is refused; there is no fallback to another mind. A personal mind answers its own person only.
  One exception (Jon 2026-10-09, "any hive I have permission for, should be able to answer through some way"): a swarm
  with no coordinator set, asked with an explicitly addressed mind of that swarm, is answered by that mind for that turn,
  under exactly the coordinator's checks (participation, sees on swarm and mind, personal_of, no external member).
- Who may ask: a named signed-in person who participates in that swarm (admin, its owner, or named in its shared_with,
  as a granted swarm_access request does) and who can see the coordinator. Seeing a public swarm is not enough.
- An Ask thread is a Session (purpose 'ask'): one active per (person, coordinator), with a cap that only tightens; caps
  of several sessions on one mind compose (sessions.py). One turn in flight per thread.
- Admission is one transaction: the turn row (unique per person and operation_id), the person's room message, the mind's
  hub-outbox message (replayed on reconnect, never re-posted) and the 'accepted' frame commit together or not at all.
  A replay returns the original turn; a refusal before that commit leaves nothing.
- A turn is delivered in its own conversation, ask:<turn_id>. The mind's ordinary reply in that conversation (hub,
  /api/agent/messages, hive_send) is the only thing that answers it; a late reply to a closed turn stays in the room.
- Frames ('ask' events) are stored in order, then published, to the asker only; GET /api/ask/{op} pages the same sequence.
- Context reaching the mind is host-resolved names, ids and statuses the person may see; nothing else from the page.
- Refusals use a closed reason set with host-written sentences; host error text never reaches the page.
- A turn that speaks as the asker's own personal mind (personal minds P2; Jon 2026-10-08: its memory and history live in
  the person's browser only) keeps no content on the host: its ask_turns row is written with no text and no context
  (personal = 1: ids, times, state, money and the body digest only), nothing is written to its thread's room or to
  the hub, and its frames are stored content-free (Ask.content_free: an allowlist of ids, enums, money and digests)
  while the live frames to the person carry the words as usual. The question and page context reach the conductor in
  memory only (Conductor.start) and go when the turn ends. A row written before r3 is found by its mind at startup,
  marked and erased (Ask.retire_legacy_personal), and is read as personal by its mind meanwhile. Such a turn needs the conductor (the personal mind is never woken); every read (the person's own views,
  the admin audit, event pages, the thread's room) returns no content for it, by construction and again on read.
  It still controls the hive (Jon 2026-10-09): the conductor's dispatch and POST /api/ask/{op}/intents record and send
  its intents as any turn's; the work handed over is a normal work item in the receiving swarm, visible to it.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import contextvars
import datetime
import json
import logging
import os
import re
import secrets
import threading
import time

from .db import now
from .limits_auto import dollars, to_micros
from .program_actions import CREDENTIAL_WORDS, canonical, digest, named_person
from .visibility import Viewer

log = logging.getLogger("hive")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS ask_turns (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, principal TEXT NOT NULL,
  body_digest TEXT NOT NULL, thread_id TEXT NOT NULL, mind_id TEXT NOT NULL, swarm_id TEXT NOT NULL, text TEXT NOT NULL,
  via TEXT NOT NULL, context_resolved TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, room_message_id TEXT NOT NULL,
  delivery_message_id TEXT NOT NULL, answer_message_id TEXT, deadline REAL NOT NULL, mind_spent_at_start REAL NOT NULL,
  next_seq INTEGER NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, spent_usd_approx REAL, deleted_at TEXT,
  UNIQUE (principal, operation_id))""",
    "CREATE INDEX IF NOT EXISTS ask_turns_open ON ask_turns(state, thread_id)",
    "CREATE INDEX IF NOT EXISTS ask_turns_mind ON ask_turns(mind_id, state)",
    "CREATE INDEX IF NOT EXISTS ask_turns_principal ON ask_turns(principal, created_at)",
    """CREATE TABLE IF NOT EXISTS ask_events (turn_id TEXT NOT NULL, seq INTEGER NOT NULL, principal TEXT NOT NULL,
  frame TEXT NOT NULL, PRIMARY KEY (turn_id, seq))""",
    # an owner-controlled context boundary per mind: a new execution the supervisor started (Ask.note_boundary)
    "CREATE TABLE IF NOT EXISTS ask_boundaries (agent_id TEXT PRIMARY KEY, at TEXT NOT NULL, execution TEXT NOT NULL)",
    # each trace's live audience, decided by the host when the trace is created (never at delivery, never by the mind)
    """CREATE TABLE IF NOT EXISTS ask_trace_scopes (trace_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT NOT NULL,
  principal TEXT, turn_ids TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS ask_prefs (principal TEXT PRIMARY KEY, swarm_id TEXT, thread_budget_usd REAL NOT NULL,
  updated_at TEXT NOT NULL)""",
    # a person's words while a turn is open (POST /api/ask/{op}/steer), one row per (person, steer_id): idempotent
    """CREATE TABLE IF NOT EXISTS ask_steers (principal TEXT NOT NULL, steer_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  body_digest TEXT NOT NULL, text TEXT NOT NULL, via TEXT NOT NULL, at_seq INTEGER NOT NULL, seq INTEGER,
  room_message_id TEXT NOT NULL, delivery_message_id TEXT NOT NULL, created_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'joined',
  new_operation_id TEXT, PRIMARY KEY (principal, steer_id))""",
    "CREATE INDEX IF NOT EXISTS ask_steers_turn ON ask_steers(turn_id)",
]

SAY = {
    "not_available": "That isn't available.",
    "not_allowed": "You can't ask there. Ask an admin to share that swarm with you.",
    "person_required": "Ask needs a signed-in person.",
    "no_mind": "Choose a swarm to ask first.",
    "no_orchestrator": "That swarm has no coordinator to answer. An admin can choose one.",
    "mind_asleep": "The coordinator is asleep. Wake it first; waking spends money, so it is your call.",
    "spend_limit": "This thread has reached its spend limit. Start a new thread to go on.",
    "ask_busy": "The coordinator is still answering your last request. Wait, or stop it.",
    "coordinator_busy": "The coordinator is working for someone else right now. Try again in a moment.",
    "rate_limited": "Too many requests just now. Try again in a little while.",
    "too_large": "That request is too large.",
    "timed_out": "The coordinator didn't answer in time.",
    "operation_conflict": "That request id was already used for a different request.",
    "invalid": "That request isn't in a shape Ask understands.",
    "stopped": "Stopped.",
    "wrong_route": "Requests to admins go to /api/asks.",
}
REASONS = tuple(k for k in SAY if k != "wrong_route")
STATUS = {"not_available": 404, "not_allowed": 403, "person_required": 403, "no_mind": 409, "no_orchestrator": 409, "coordinator_busy": 409,
          "mind_asleep": 409, "spend_limit": 402, "ask_busy": 409, "rate_limited": 429, "too_large": 413,
          "operation_conflict": 409, "invalid": 400, "wrong_route": 400}

MAX_BODY = 32 * 1024
MAX_TEXT = 4000
MAX_ANSWER = 8000
MAX_SELECTION = 20
MAX_VIEW_BYTES = 2048
MAX_VIEW_REFS, MAX_VIEW_ACTS, MAX_SUMMARY = 50, 50, 500
MAX_EVENTS = 64                       # per turn; thinking frames stop at MAX_EVENTS - 4 so the terminal ones always fit
TERMINAL = ("answer", "done", "refused")
TERMINAL_RESERVE = 2                  # answer + done (a refusal is one): kept free by every other phase while the turn is open
PAGE_EVENTS = 100
DEFAULT_BUDGET, MAX_BUDGET = 0.25, 5.0   # Jon 2026-10-05: $0.25 a thread, the person may raise it to $5; never raises a cap
PER_MINUTE, PER_DAY, READS_PER_MINUTE = 10, 300, 60
TIMEOUT = float(os.environ.get("HIVE_ASK_TIMEOUT_SECONDS", "120"))
EMPTY_THREAD_SECONDS = 600   # an Ask thread that never got a turn (a crash or race between thread and admission) ends after this
# the turn states (gateway r1b, Kimi item 4: every inline tuple of them uses one of these two constants; T-LIT scans for any
# other). OPEN: any open turn. conducting: a host-side conductor turn (conductor.py), never the mind's; browser: a turn the
# person's own browser answers through its personal mind (gateway r1b, plan §2.3), never the host's mind either.
OPEN = ("accepted", "thinking", "conducting", "browser")
OPEN_HOST_MIND = ("accepted", "thinking")   # the host's mind itself is answering (the payer rule and traces read these only)


def states_sql(states):
    """A turn-state constant as an SQL list literal: "('accepted', 'thinking')"."""
    return "(" + ", ".join(f"'{s}'" for s in states) + ")"


BODY_KEYS = {"operation_id", "text", "context", "thread", "via"}
# ---- gateway r1b (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.3, r1.1 §E/§H/§I): the browser_mind route -------------------
# Off unless HIVE_MIND_GATEWAY=1; off, an Ask is exactly as before (answer_in is not a key it accepts). On, a turn is a
# browser turn when the request says "answer_in": "browser" (the page sends it only once its broker has booted), the
# person's mind_prefs.browser_mind is on (the default), and the routed mind is the asker's own personal mind
# (personal_of on the row). Such a turn is admitted content-free (personal = 1) in state 'browser': no room or hub write,
# no conductor, the mind never woken; the person's browser answers it and closes it with POST /api/ask/{op}/done.
ANSWER_IN_KEY = "answer_in"
BROWSER_ROUTE = "browser_mind"
DONE_WORDS = ("answered", "incomplete", "spend_cap", "failed", "stopped")
# a browser close word -> (stored state, stored reason): the reason is what CLOSE_OUTCOME reads
DONE_CLOSE = {"answered": ("done", "answered"), "incomplete": ("done", "incomplete"), "spend_cap": ("refused", "spend_limit"),
              "failed": ("refused", "failed"), "stopped": ("refused", "stopped")}


def gateway_enabled():
    return os.environ.get("HIVE_MIND_GATEWAY", "") == "1"


def _seconds(name, default):
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(1.0, value)


def browser_turn_seconds():
    """A browser turn's absolute deadline from admission (plan §2.3, §3.3)."""
    return _seconds("HIVE_ASK_BROWSER_TURN_SECONDS", 600)


def browser_idle_seconds():
    """A browser turn closes when it has been idle this long since admission or its last call (a closed tab)."""
    return _seconds("HIVE_ASK_BROWSER_IDLE_SECONDS", 120)


def browser_past_deadline(t, moment=None):
    """A browser turn past its absolute deadline, or idle past HIVE_ASK_BROWSER_IDLE_SECONDS: the rule expire() applies,
    for the gateway's send gate (r1c), which must refuse at the deadline itself, not once reconciliation has run."""
    moment = time.time() if moment is None else moment
    return t["deadline"] <= moment or (t.get("last_call_at") or 0) <= moment - browser_idle_seconds()


BROWSER_LIVE_SQL = "deadline > ? AND COALESCE(last_call_at, 0) > ?"   # not browser_past_deadline, in SQL


def browser_live_params(moment):
    """The parameters of BROWSER_LIVE_SQL at `moment` (one `now` for both deadlines)."""
    return (moment, moment - browser_idle_seconds())


VIA = ("typed", "voice")   # how the words were made (audit only), on a request and on a steer alike
STEER_KEYS = {"steer_id", "text", "at_seq", "via"}
STEER_ID = re.compile(r"[A-Za-z0-9_.:-]{4,112}")
MAX_STEERS = 20            # per turn (Jon's steering ruling: "at most about 20")
STEER_OPERATION = "steer:"  # a steer on a closed turn starts a fresh turn with operation_id "steer:" + steer_id
STEER_LABEL = ("The person's further words while you work on this turn. They steer it; reply in this conversation as "
               "usual, once.")
CONDUCTOR_KEY = "conductor"   # {"model": ...}: an admin's per-request A/B pick; accepted only while the conductor is on
# the person's own memory notes for this turn (Jon's memory ruling): <= 20 strings or {id, text}, <= 8 KB; always accepted
# and shape-checked, used only while the conductor and HIVE_ASK_MEMORY are on, in
# that turn's model context and never stored or logged (the turn's body digest covers them; nothing else keeps them)
NOTES_KEY = "memory_notes"
# how a conductor turn closed elsewhere reads in its done frame (conductor.OUTCOMES is the whole enum)
CONDUCTOR_OUTCOME = {"stopped": "cancelled", "takeover": "cancelled", "timed_out": "time_cap", "spend_limit": "spend_cap"}
# gateway r1b (r1.1 §I, Kimi item 5): the ONE map from a close reason to done.outcome, for a conductor turn and a browser
# turn alike (_close); it extends CONDUCTOR_OUTCOME with the browser's close words. Anything else reads "error".
CLOSE_OUTCOME = {**CONDUCTOR_OUTCOME, "answered": "complete", "incomplete": "incomplete", "failed": "error",
                 "spend_cap": "spend_cap", "call_cap": "call_cap"}
# the person took the page back mid-turn (POST /api/ask/{op}/takeover): a conductor turn's own close reason (never a refusal
# the page is told; its done frame says outcome "cancelled" with taken_over: true)
TAKEOVER = "takeover"
CONTEXT_KEYS = {"route", "experience", "program", "swarm_id", "mind", "selection", "view"}
VIEW_KEYS = {"refs", "acts", "summary", "fields", "regions"}
# the page's declared fields and named regions (vocabulary v1 §3): accepted on every Ask, forwarded to a conductor turn only
VIEW_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
FIELD_KINDS = ("text", "search", "prompt")
MAX_VIEW_FIELDS = MAX_VIEW_REGIONS = 32
REF_KINDS = ("mind", "swarm", "goal", "room", "artifact", "item", "feature")
# authority, model and money the host derives; a body naming any of them is refused (as /act's refuse_identity)
AUTHORITY = {"principal", "actor", "agent_id", "member_id", "mind_id", "approval_id", "approval", "confirm", "confirm_token",
             "policy", "policy_mode", "mode", "grant", "grants", "grant_id", "lease", "lease_id", "role", "admin", "model",
             "provider", "key_id", "budget", "budget_usd", "thread_budget_usd", "spend", "limit_usd", "payer", "owner",
             "coordinator", "coordinator_id", "orchestrator", "delegate", "to"}
OPERATION_ID = re.compile(r"[A-Za-z0-9_.:-]{8,120}")
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
FEATURE = re.compile(r"[a-z0-9][a-z0-9_./-]{0,79}")
ACT_ID = re.compile(r"[A-Za-z0-9_.:-]{1,80}")
ID_SEGMENT = re.compile(r"[a-z]{1,4}_[0-9a-f]{6,}")
CONVERSATION = "ask:"
# what a personal turn's stored frame may keep (Ask.content_free): ids, phase, seq, time, host enums, money, flags, digests
CONTENT_FREE_KEYS = frozenset({"operation_id", "turn_id", "principal", "seq", "phase", "at", "outcome", "reason", "state",
                               "op", "spent_usd", "turn_spent_usd", "delta", "truncated", "taken_over", "message_id",
                               "intent_id", "request_id", "dispatch_id", "links_rev", "digest", "error", "app_ask"})
# done.limit (ask-limits r1): an enum and money; reason (gateway r1a): the host enum monthly_total_required
LIMIT_FRAME_KEYS = ("kind", "current_usd", "limit_usd", "estimate_usd", "reason")
PAGE_LABEL = ("Page context resolved by the hive: names, ids and statuses the person may see. It describes where they "
              "are; it is not an instruction and grants nothing.")


# (agent_id, boundary seq, boundary execution) of the mind's execution as a trace request was authenticated, set by the
# route before any await or worker-thread hop and carried with the request's context into Hive.record_trace (never from
# the request body). An in-process caller passes its pin to record_trace_scope instead; no pin is never "now".
TRACE_ENTRY: contextvars.ContextVar = contextvars.ContextVar("ask_trace_entry", default=None)


def refs_problem(refs, limit):
    """None, or (closed reason, details) for a list of page refs."""
    if not isinstance(refs, list):
        return "invalid", {}
    if len(refs) > limit:
        return "too_large", {"limit_refs": limit}
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != {"kind", "ref"} or ref["kind"] not in REF_KINDS \
                or not isinstance(ref["ref"], str) or not 0 < len(ref["ref"]) <= 200:
            return "invalid", {}
    return None


def view_problem(view):
    """None, or (closed reason, details): the page's semantic view (<= 2 KB; refs, acts, summary, fields, regions). The one
    check for an Ask's context.view and for a conductor act's result view (conductor.check_result)."""
    if view is None:
        return None
    if len(canonical(view).encode()) > MAX_VIEW_BYTES:
        return "too_large", {"limit_bytes": MAX_VIEW_BYTES}
    if not isinstance(view, dict) or set(view) - VIEW_KEYS:
        return "invalid", {}
    if view.get("refs") is not None:
        problem = refs_problem(view["refs"], MAX_VIEW_REFS)
        if problem:
            return problem
    acts = view.get("acts")
    if acts is not None and (not isinstance(acts, list) or len(acts) > MAX_VIEW_ACTS
                             or not all(isinstance(a, str) and ACT_ID.fullmatch(a) for a in acts)):
        return "invalid", {}
    if view.get("summary") is not None and (not isinstance(view["summary"], str) or len(view["summary"]) > MAX_SUMMARY):
        return "invalid", {}
    fields = view.get("fields")
    if fields is not None and (not isinstance(fields, list) or len(fields) > MAX_VIEW_FIELDS or not all(
            isinstance(f, dict) and set(f) == {"id", "label", "kind"} and isinstance(f["id"], str) and VIEW_ID.fullmatch(f["id"])
            and isinstance(f["label"], str) and 0 < len(f["label"]) <= 80 and f["label"].isprintable()
            and f["kind"] in FIELD_KINDS for f in fields)):
        return "invalid", {}
    regions = view.get("regions")
    if regions is not None and (not isinstance(regions, list) or len(regions) > MAX_VIEW_REGIONS
                                or not all(isinstance(r, str) and VIEW_ID.fullmatch(r) for r in regions)):
        return "invalid", {}
    return None


def refusal(hive, reason, status=None, **details):
    return hive.error(status or STATUS.get(reason, 400), reason, SAY[reason], details or None)


def forbidden(data):
    return sorted(k for k in data if isinstance(k, str) and (k.lower() in AUTHORITY or k.lower() == "key"
                  or k.lower().endswith("_key") or any(w in k.lower() for w in CREDENTIAL_WORDS)))


def _iso(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Ask:
    def __init__(self, hive):
        self.hive = hive
        for s in SCHEMA:
            hive.db.execute(s)
        if "execution" not in {r["name"] for r in hive.db.all("PRAGMA table_info(ask_boundaries)")}:
            hive.db.execute("ALTER TABLE ask_boundaries ADD COLUMN execution TEXT NOT NULL DEFAULT ''")
        turn_columns = {r["name"] for r in hive.db.all("PRAGMA table_info(ask_turns)")}
        if "deleted_at" not in turn_columns:
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN deleted_at TEXT")
        if "cleared_at" not in turn_columns:   # a context boundary after this turn closed (Ask.note_boundary)
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN cleared_at TEXT")
        if "cleared_seq" not in turn_columns:  # ...and which one (the mind's boundary sequence)
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN cleared_seq INTEGER")
        if "conductor_model" not in turn_columns:   # set only for a conductor turn (conductor.py); NULL is phase 1
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN conductor_model TEXT")
        if "seq" not in {r["name"] for r in hive.db.all("PRAGMA table_info(ask_boundaries)")}:
            hive.db.execute("ALTER TABLE ask_boundaries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
        steer_columns = {r["name"] for r in hive.db.all("PRAGMA table_info(ask_steers)")}
        if "outcome" not in steer_columns:   # joined (an open turn) | new_turn (a closed turn: bound to its source turn)
            hive.db.execute("ALTER TABLE ask_steers ADD COLUMN outcome TEXT NOT NULL DEFAULT 'joined'")
        if "new_operation_id" not in steer_columns:
            hive.db.execute("ALTER TABLE ask_steers ADD COLUMN new_operation_id TEXT")
        if "personal" not in turn_columns:   # 1: a personal-mind turn, stored content-free (the module notes)
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN personal INTEGER NOT NULL DEFAULT 0")
        if "links_rev" not in turn_columns:   # linkage r3.6 a.2: + 1 in every transaction that changes the turn's intents or links
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN links_rev INTEGER NOT NULL DEFAULT 0")
        # gateway r1b: route 'browser_mind' (NULL: every other turn); calls and last_call_at, counted by the gateway (r1c);
        # last_call_at starts at admission, so the idle deadline runs from admission or the last call
        if "route" not in turn_columns:
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN route TEXT")
        if "calls" not in turn_columns:
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN calls INTEGER NOT NULL DEFAULT 0")
        if "last_call_at" not in turn_columns:
            hive.db.execute("ALTER TABLE ask_turns ADD COLUMN last_call_at REAL")
        from .ask_intents import Intents
        self.intents = Intents(self)
        # Kimi ask-p1-r6 1: a database that ran 8716093 marked cleared turns by time only (cleared_at, no cleared_seq).
        # Such a turn was cleared by the mind's boundary row as it stands (any later boundary would have set its mark),
        # so it takes that boundary's seq once, here. cleared_seq is the only mark: cleared_at is never written or read.
        hive.db.execute("UPDATE ask_turns SET cleared_seq = (SELECT b.seq FROM ask_boundaries b WHERE b.agent_id = ask_turns.mind_id) "
                        "WHERE cleared_at IS NOT NULL AND cleared_seq IS NULL "
                        "AND EXISTS (SELECT 1 FROM ask_boundaries b WHERE b.agent_id = ask_turns.mind_id)")
        self._locks: dict[str, asyncio.Lock] = {}
        # Kimi ask-p1-r6 2: one lock per mind orders every execution pin against every boundary record
        self._boundary_locks: dict[str, threading.RLock] = {}
        self._boundary_guard = threading.Lock()
        self._reads: dict[str, collections.deque] = {}
        self.conductor = None   # conductor.Conductor, attached by the app; used only while HIVE_ASK_CONDUCTOR=1
        self.retire_legacy_personal()   # r2-era personal turns: marked, and their content erased (stand-in r3 High 1)

    # ---- who answers, and whether this person may ask there -----------------------------------------------------

    def _swarm(self, swarm_id):
        return self.hive.db.one("SELECT * FROM swarms WHERE id = ?", (str(swarm_id or ""),))

    def _mind(self, mind_id):
        return self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (str(mind_id or ""),))

    @staticmethod
    def participates(viewer, swarm):
        """Explicit swarm participation, not visibility: an admin, the swarm's owner, or a person named in its shared_with
        (what a granted swarm_access request adds). A public swarm's other viewers do not qualify."""
        if viewer.admin or swarm.get("owner") == viewer.principal:
            return True
        try:
            return viewer.principal in json.loads(swarm.get("shared_with") or "[]")
        except ValueError:
            return False

    def orchestrator(self, viewer, swarm_id, addressed=None):
        """The swarm's coordinator, if this person may ask it; otherwise a closed refusal. Never another mind, except:
        when the swarm has no coordinator set and `addressed` (a mind the request explicitly addressed) belongs to it,
        that mind answers this turn in the coordinator's place, under the very same checks below."""
        swarm = self._swarm(swarm_id)
        if swarm is None or not viewer.sees(swarm) or swarm.get("archived_at"):
            raise refusal(self.hive, "not_available")
        if not self.participates(viewer, swarm):
            raise refusal(self.hive, "not_allowed")
        cid = swarm.get("coordinator_id")
        mind = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND swarm_id = ? AND deleted = 0", (cid, swarm["id"])) if cid else None
        if not cid and addressed is not None and addressed.get("swarm_id") == swarm["id"]:
            mind = self._mind(addressed["id"])   # re-read: the same row the coordinator path would read (not deleted)
            if mind is not None and (mind.get("swarm_id") != swarm["id"] or mind.get("kind") == "module"):
                raise refusal(self.hive, "not_allowed")   # an external member takes no Ask turn
        if mind is None:
            raise refusal(self.hive, "no_orchestrator")
        if not viewer.sees(mind):
            raise refusal(self.hive, "not_allowed")
        if mind.get("personal_of") and mind["personal_of"] != viewer.principal:   # a personal mind speaks for its person only
            raise refusal(self.hive, "not_allowed")
        return swarm, mind

    def _route(self, viewer, data):
        """Jon's order: the addressed mind's swarm coordinator; the page's swarm coordinator; the thread's coordinator;
        the default swarm's coordinator; else the person's own personal mind (the coordinator of their personal swarm,
        personal.py; none: no_mind). A swarm with no coordinator set is answered by the addressed mind, if any (orchestrator).
        Returns (swarm, answering mind, addressed mind or None)."""
        hive, ctx = self.hive, data.get("context") or {}
        addressed = None
        if ctx.get("mind") is not None:
            addressed = self._mind(ctx["mind"])
            if addressed is None or not viewer.sees(addressed):
                raise refusal(hive, "not_available")
        else:
            for ref in ctx.get("selection") or []:
                if ref.get("kind") == "mind":
                    row = self._mind(ref.get("ref"))
                    if row is not None and viewer.sees(row):
                        addressed = row
                        break
        thread = None
        if data.get("thread") is not None:
            thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ? AND purpose = 'ask' AND owner = ? AND status = 'active'",
                                 (str(data["thread"]), viewer.principal))
            if thread is None:
                raise refusal(hive, "not_available")
        if addressed is not None:
            if not addressed.get("swarm_id"):
                raise refusal(hive, "no_orchestrator")
            swarm_id = addressed["swarm_id"]
        elif ctx.get("swarm_id") is not None:
            swarm_id = ctx["swarm_id"]
        elif thread is not None:
            swarm_id = (self._mind(thread["agent_id"]) or {}).get("swarm_id")
            if not swarm_id:
                raise refusal(hive, "not_available")
        else:   # the person's chosen default swarm wins; with none, their own personal mind (personal minds P2)
            pref = hive.db.one("SELECT swarm_id FROM ask_prefs WHERE principal = ?", (viewer.principal,))
            if pref and pref["swarm_id"]:
                swarm_id = pref["swarm_id"]
            else:
                personal = hive.personal.mind_row(viewer.principal)
                if personal is None or not personal.get("swarm_id"):
                    raise refusal(hive, "no_mind")
                swarm_id = personal["swarm_id"]
        swarm, mind = self.orchestrator(viewer, swarm_id, addressed)
        if thread is not None and thread["agent_id"] != mind["id"]:
            raise refusal(hive, "invalid")
        return swarm, mind, addressed

    def eligible_swarms(self, viewer):
        out = []
        for s in self.hive.db.all("SELECT * FROM swarms WHERE archived_at IS NULL ORDER BY name"):
            with contextlib.suppress(Exception):
                swarm, mind = self.orchestrator(viewer, s["id"])
                out.append({"id": swarm["id"], "name": swarm["name"], "orchestrator": {"id": mind["id"], "name": mind["name"], "status": mind["status"]}})
        return out

    def prefs(self, viewer):
        row = self.hive.db.one("SELECT * FROM ask_prefs WHERE principal = ?", (viewer.principal,))
        current = None
        if row and row["swarm_id"]:
            with contextlib.suppress(Exception):
                swarm, mind = self.orchestrator(viewer, row["swarm_id"])
                current = {"id": swarm["id"], "name": swarm["name"], "orchestrator": {"id": mind["id"], "name": mind["name"], "status": mind["status"]}}
        return {"swarm_id": row["swarm_id"] if row else None, "swarm": current,
                "thread_budget_usd": float(row["thread_budget_usd"]) if row else DEFAULT_BUDGET,
                "max_thread_budget_usd": MAX_BUDGET, "eligible": self.eligible_swarms(viewer),
                "capabilities": self.capabilities()}

    def put_prefs(self, viewer, data):
        hive = self.hive
        if not named_person(viewer.principal):
            raise refusal(hive, "person_required")
        if set(data) - {"swarm_id", "mind_id", "thread_budget_usd"} or ("swarm_id" in data and "mind_id" in data):
            raise refusal(hive, "invalid")
        current = hive.db.one("SELECT * FROM ask_prefs WHERE principal = ?", (viewer.principal,)) or {}
        swarm_id = current.get("swarm_id")
        if "mind_id" in data:   # a mind stands for its swarm: its coordinator answers
            mind = self._mind(data["mind_id"]) if isinstance(data["mind_id"], str) else None
            if mind is None or not viewer.sees(mind):
                raise refusal(hive, "not_available")
            data = {**data, "swarm_id": mind.get("swarm_id")}
            if not data["swarm_id"]:
                raise refusal(hive, "no_orchestrator")
        if "swarm_id" in data:
            swarm_id = data["swarm_id"]
            if swarm_id is not None:
                if not isinstance(swarm_id, str):
                    raise refusal(hive, "invalid")
                self.orchestrator(viewer, swarm_id)
        budget = float(current.get("thread_budget_usd") or DEFAULT_BUDGET)
        if "thread_budget_usd" in data:
            value = data["thread_budget_usd"]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= MAX_BUDGET:
                raise refusal(hive, "invalid", limit_usd=MAX_BUDGET)
            budget = dollars(to_micros(value))   # floored to the micro-dollar, never rounded up (OmegaReview r8)
            if budget <= 0:
                raise refusal(hive, "invalid", limit_usd=MAX_BUDGET)
        hive.db.execute("INSERT INTO ask_prefs VALUES (?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET swarm_id = excluded.swarm_id, "
                        "thread_budget_usd = excluded.thread_budget_usd, updated_at = excluded.updated_at",
                        (viewer.principal, swarm_id, budget, now()))
        return self.prefs(viewer)

    # ---- the page's context: names, ids and statuses only ---------------------------------------------------------

    def _check_refs(self, refs, limit):
        problem = refs_problem(refs, limit)
        if problem:
            raise refusal(self.hive, problem[0], **problem[1])

    def _check_context(self, ctx):
        """Shape only (no reads): every refusal about the page's context happens before anything is resolved or written."""
        hive = self.hive
        if ctx is None:
            return
        if not isinstance(ctx, dict):
            raise refusal(hive, "invalid")
        if forbidden(ctx):
            raise refusal(hive, "not_allowed", 400)
        if "private" in ctx:   # a private app's page (Atlas/Truth) sends exactly {private: true}, nothing else
            if ctx != {"private": True} or ctx["private"] is not True:
                raise refusal(hive, "invalid")
            return
        if set(ctx) - CONTEXT_KEYS:
            raise refusal(hive, "invalid")
        for k, n in (("route", 120), ("program", 120), ("swarm_id", 200), ("mind", 200)):
            if ctx.get(k) is not None and (not isinstance(ctx[k], str) or not 0 < len(ctx[k]) <= n):
                raise refusal(hive, "invalid")
        if ctx.get("experience") is not None and not (isinstance(ctx["experience"], str) and SLUG.fullmatch(ctx["experience"])):
            raise refusal(hive, "invalid")
        if ctx.get("selection") is not None:
            self._check_refs(ctx["selection"], MAX_SELECTION)
        problem = view_problem(ctx.get("view"))
        if problem:
            raise refusal(hive, problem[0], **problem[1])

    def _resolve(self, viewer, kind, ref):
        """One ref as the person may see it (names, ids and statuses only), or None: unknown and hidden look alike."""
        db = self.hive.db
        if kind == "mind":
            r = self._mind(ref)
            return {"kind": kind, "id": r["id"], "name": r["name"], "status": r["status"]} if r and viewer.sees(r) else None
        if kind == "swarm":
            r = self._swarm(ref)
            return {"kind": kind, "id": r["id"], "name": r["name"]} if r and viewer.sees(r) else None
        if kind == "goal":
            r = db.one("SELECT id, title, status, swarm_id FROM goals WHERE id = ?", (ref,))
            return {"kind": kind, "id": r["id"], "name": r["title"], "status": r["status"]} \
                if r and viewer.sees(self._swarm(r["swarm_id"])) else None
        if kind == "room":
            r = db.one("SELECT * FROM rooms WHERE id = ? AND archived = 0", (ref,))
            return {"kind": kind, "id": r["id"], "name": self.hive.rooms.shown_room(r)[0] or "DM", "status": r["kind"]} \
                if r and self.hive.rooms.can_see(viewer, r) else None
        if kind == "artifact":
            r = db.one("SELECT id, title, owner_swarm FROM artifacts WHERE id = ?", (ref,))
            return {"kind": kind, "id": r["id"], "name": r["title"]} if r and viewer.sees(self._swarm(r["owner_swarm"])) else None
        if kind == "feature":
            return {"kind": kind, "id": ref} if FEATURE.fullmatch(ref) else None
        return None   # app items are app data: never in phase 1 (declared reads come later, contract 3)

    def _refs(self, viewer, refs):
        out = []
        for ref in refs or []:
            r = self._resolve(viewer, ref["kind"], ref["ref"])
            if r is not None and r not in out:
                out.append(r)
        return out

    def _context(self, viewer, ctx, swarm, addressed, conducted=False):
        hive, ctx, page = self.hive, ctx or {}, {}
        if ctx.get("private") is True:   # the page's own private marker: the same as the host's detection below
            return {"private": True}
        from .conductor import names_private
        if names_private(ctx.get("program")) or names_private(ctx.get("route")):
            # a private app's page, judged on the raw names with the conductor's canonical fence (NFKC, percent-decoding,
            # case; unsettled reads as private) before the route is cut down below: for every turn, as the page's own
            # private marker is. Nothing it sent reaches the model, and personal_inbox never holds a copy (stand-in P1
            # High 3: '/programs/ATLAS/view' and '/programs/%61tlas/view' were cut to 'programs/view' and then copied)
            return {"private": True}
        if ctx.get("route"):   # a route may embed ids; those reach the mind only as resolved refs, never raw
            segments = [s for s in ctx["route"].split("/") if s and not ID_SEGMENT.fullmatch(s) and FEATURE.fullmatch(s)]
            if segments:
                page["route"] = "/".join(segments)
        if ctx.get("experience"):
            page["experience"] = ctx["experience"]
        page["swarm"] = {"id": swarm["id"], "name": swarm["name"]}
        if addressed is not None:   # context only: the coordinator gains no authority over it in phase 1
            page["addressed"] = {"id": addressed["id"], "name": addressed["name"], "status": addressed["status"]}
        if ctx.get("swarm_id") and ctx["swarm_id"] != swarm["id"]:
            other = self._resolve(viewer, "swarm", ctx["swarm_id"])
            if other:
                page["page_swarm"] = {"id": other["id"], "name": other["name"]}
        program = ctx.get("program")
        entry = hive.programs.programs.get(program) if program else None
        if entry is not None and (viewer.admin or hive.programs.admitted(viewer.principal, program, swarm["id"])):
            page["program"] = {"id": program, "name": str((entry.get("describe") or {}).get("name") or program)[:120]}
        selection = self._refs(viewer, ctx.get("selection"))
        if selection:
            page["selection"] = selection
        view = ctx.get("view") or {}
        refs, acts = self._refs(viewer, view.get("refs")), list(dict.fromkeys(view.get("acts") or []))
        fields = regions = []
        if conducted:   # declared fields (their labels: the only app-authored text forwarded) and regions, deduplicated
            refs = [r for r in refs if not names_private(r["id"])]
            acts = [a for a in acts if not names_private(a)]
            seen, fields = set(), []
            for f in view.get("fields") or []:
                if f["id"] not in seen and not names_private(f["id"]):
                    seen.add(f["id"])
                    fields.append({"id": f["id"], "label": f["label"], "kind": f["kind"]})
            regions = [r for r in dict.fromkeys(view.get("regions") or []) if not names_private(r)]
        if refs or acts or fields or regions:   # a view's summary (page prose) is dropped: no app-authored prose is forwarded
            page["view"] = {k: v for k, v in (("refs", refs), ("acts", acts), ("fields", fields), ("regions", regions)) if v}
        return page

    # ---- admission ----------------------------------------------------------------------------------------------

    def _validate(self, data):
        hive = self.hive
        if "kind" in data:
            raise refusal(hive, "wrong_route")
        if forbidden(data):   # 400 like /act's refuse_identity: the request itself is malformed
            raise refusal(hive, "not_allowed", 400)
        # memory_notes are accepted whatever the switches (Surface: the page may always send them) and validated for
        # shape; they reach a turn only while the conductor and HIVE_ASK_MEMORY are both on (Ask.memory_on)
        if set(data) - BODY_KEYS - {NOTES_KEY} - ({CONDUCTOR_KEY} if self._conducting() else set()) \
                - ({ANSWER_IN_KEY} if gateway_enabled() else set()):
            raise refusal(hive, "invalid")
        if ANSWER_IN_KEY in data and (data[ANSWER_IN_KEY] != "browser" or CONDUCTOR_KEY in data):
            raise refusal(hive, "invalid")   # r1.1 §E: one value only, and never with an A/B conductor pick
        if NOTES_KEY in data:
            from .conductor import check_notes
            if not check_notes(data[NOTES_KEY]):
                raise refusal(hive, "invalid")
        if not isinstance(data.get("operation_id"), str) or not OPERATION_ID.fullmatch(data["operation_id"]):
            raise refusal(hive, "invalid")
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            raise refusal(hive, "invalid")
        if len(text) > MAX_TEXT:
            raise refusal(hive, "too_large", limit_chars=MAX_TEXT)
        if data.get("via", "typed") not in VIA:
            raise refusal(hive, "invalid")
        if data.get("thread") is not None and (not isinstance(data["thread"], str) or len(data["thread"]) > 120):
            raise refusal(hive, "invalid")
        self._check_context(data.get("context"))

    def _conducting(self):
        return self.conductor is not None and self.conductor.enabled()

    def memory_on(self):
        """The browser-side memory's host piece (memory_notes reach the model; the remember tool): conductor and
        HIVE_ASK_MEMORY both on."""
        from .conductor import memory_enabled
        return self._conducting() and memory_enabled()

    def capabilities(self):
        """The on/off switches the page needs, and nothing else (GET /api/me/ask `capabilities`)."""
        caps = {"conductor": self._conducting(), "memory": self.memory_on()}
        # J3 host R7.1: Surface O3 opens live Studio only on capabilities.studio_sessions === true. Published only when
        # the startup self-check passed (StudioSessions.enabled) AND members' own makers can be made (the template is
        # set and usable); otherwise absent, so the Studio-off answer is byte-identical to before
        studio, makers = getattr(self.hive, "studio", None), getattr(self.hive, "studio_makers", None)
        if studio is not None and getattr(studio, "enabled", False) and makers is not None and makers.template_ready():
            caps["studio_sessions"] = True
            caps["studio_directions"] = True   # R7.3: steer interception (R5) exists wherever Studio sessions do
        # Protocol support, constrained by the Code execution resource gate.
        # This strict boolean is never a person/grant/budget admission. An
        # older/unknown protocol still omits it. Linux discovery uses only
        # the same original Host owner's retained aggregate health; actual
        # request admission and live-kernel placement remain per operation.
        try:
            from . import ask_intents, code_test_intents, code_project_tests
        except ImportError:
            pass
        else:
            kinds = getattr(ask_intents, "KINDS", None)
            intent_type = getattr(ask_intents, "Intents", None)
            if (intent_type is not None and type(getattr(self, "intents", None)) is intent_type
                    and getattr(ask_intents, "TEST", None) == "code.test"
                    and type(kinds) is dict and kinds.get("code.test") == {"admin_only": False}
                    and all(callable(getattr(intent_type, name, None)) for name in ("record_async", "submit"))
                    and all(callable(getattr(code_test_intents, name, None)) for name in ("clean", "current", "verify", "dispatch"))
                    and callable(getattr(code_project_tests, "execution_available", None))):
                caps["code_test_intents"] = code_project_tests.execution_available(self.hive)
        return caps

    def _quota_ok(self, principal):
        t = time.time()
        rows = self.hive.db.one("SELECT SUM(created_at >= ?) AS minute, COUNT(*) AS day FROM ask_turns WHERE principal = ? AND created_at >= ?",
                                (_iso(t - 60), principal, _iso(t - 86400)))
        return (rows["minute"] or 0) < PER_MINUTE and (rows["day"] or 0) < PER_DAY

    def read_ok(self, principal):
        q = self._reads.setdefault(principal, collections.deque())
        t = time.monotonic()
        while q and q[0] < t - 60:
            q.popleft()
        if len(q) >= READS_PER_MINUTE:
            return False
        q.append(t)
        return True

    def _active_thread(self, principal, mind_id):
        return self.hive.db.one("SELECT * FROM work_sessions WHERE owner = ? AND agent_id = ? AND purpose = 'ask' AND status = 'active' "
                                "ORDER BY created_at DESC LIMIT 1", (principal, mind_id))

    def _studio_busy(self, mind_id):
        """J3 R4 (plan §3.6, O2-i): a mind Studio owns is a dedicated maker; an Ask turn on it, conducted or not, is
        refused. Inert with Studio off."""
        studio = getattr(self.hive, "studio", None)
        return bool(studio is not None and studio.maker_busy(mind_id))

    def _payer_conflict(self, principal, mind_id):
        """Another person's open turn, or another person's ordinary session, on this coordinator: Hive.payer_for could not
        tell whose work a model call is, so the turn is refused rather than billed to the wrong person (OmegaReview B1)."""
        db = self.hive.db
        return bool(db.one(f"SELECT 1 FROM ask_turns WHERE mind_id = ? AND state IN {states_sql(OPEN_HOST_MIND)} AND principal != ?", (mind_id, principal))
                    or db.one("SELECT 1 FROM work_sessions WHERE agent_id = ? AND status = 'active' AND (purpose IS NULL OR purpose != 'ask') "
                              "AND owner LIKE 'user:u\\_%' ESCAPE '\\' AND owner != ?", (mind_id, principal)))

    def browser_turn(self, viewer, mind):
        """gateway r1b (plan §2.3, r1.1 §E): may this request's turn be a browser turn? The flag, the person's preference
        (on by default, mind_prefs) and the routed mind's row: it is the asker's own personal mind (personal_of, never
        identity or acting_as). The request's answer_in marker is the fourth condition, checked by the caller."""
        return (gateway_enabled() and bool(mind.get("personal_of")) and mind["personal_of"] == viewer.principal
                and self.hive.personal.browser_mind_on(viewer.principal))

    def _decide(self, viewer, data, body_digest, conducted=False, browser=False, *, write_free=False):
        """Under the person's lock, no awaits: replay, quota, route, sleep, busy, payer and spend. Returns
        (existing turn view, None) for a replay, else (None, (swarm, mind, addressed, context, thread or None)).
        browser: the request carries answer_in (gateway r1b); refused not_available (409) unless browser_turn."""
        hive = self.hive
        if not write_free:
            self.expire()   # ordinary host maintenance, never a P1 pre-admission side effect
        existing = hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?", (viewer.principal, data["operation_id"]))
        if existing:   # a replay: the original turn, no new quota, delivery or spend
            if existing["body_digest"] != body_digest:
                raise refusal(hive, "operation_conflict")
            return self.view(existing), None
        if not self._quota_ok(viewer.principal):
            raise refusal(hive, "rate_limited")
        swarm, mind, addressed = self._route(viewer, data)
        if browser and not self.browser_turn(viewer, mind):
            raise refusal(hive, "not_available", 409)
        # a conductor turn never wakes or uses the mind; nor does a browser turn, and only for the asker's own personal
        # mind (browser_turn above, on the row): mind_asleep stays for every other mind, awake or asleep (r1.1 §E)
        if not conducted and not browser and mind["status"] not in ("awake", "starting"):
            raise refusal(hive, "mind_asleep", mind={"id": mind["id"], "name": mind["name"]})
        if not conducted and not browser and mind.get("personal_of"):
            # a personal mind answers only through the conductor: the ordinary path would queue the person's words in the
            # hub outbox and the room, which a personal mind's turn never writes (its history is the browser's)
            raise refusal(hive, "not_available")
        context = self._context(viewer, data.get("context"), swarm, addressed, conducted or browser)
        thread = self._active_thread(viewer.principal, mind["id"])
        # ask-limits r1: a conductor turn's thread is held by its own cap (sessions.py, scope 'thread'), and so is every
        # other Ask thread on the mind, so none of them holds the mind's total rule; a turn the mind answers itself moves
        # its own thread back under the mind's rule, the only measure the mind's calls have
        if not write_free:
            if conducted or browser:   # a browser turn's thread is held by its own cap, as a conductor turn's (plan §2.3)
                hive.sessions.rescope(mind["id"], "thread")
            elif thread is not None and thread.get("cap_scope") == "thread":
                hive.sessions.rescope(mind["id"], "mind", thread["id"])
        if thread is not None:
            thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],))
        if thread is not None:
            busy = hive.db.one(f"SELECT operation_id FROM ask_turns WHERE thread_id = ? AND state IN {states_sql(OPEN)}", (thread["id"],))
            if busy:
                raise refusal(hive, "ask_busy", operation_id=busy["operation_id"])
        if not conducted and self._payer_conflict(viewer.principal, mind["id"]):
            raise refusal(hive, "coordinator_busy")
        if self._studio_busy(mind["id"]):
            raise refusal(hive, "coordinator_busy")
        if thread is not None and not write_free:
            tv = hive.sessions.view(thread)
            # r1.1 (Kimi P2): an own-scope thread is measured as its reservation measures it, spend plus open holds
            held = hive.sessions.thread_held(thread) if thread.get("cap_scope") == "thread" else 0.0
            if tv["spent_usd"] + held >= float(thread["budget_usd"]) - 1e-9:
                raise refusal(hive, "spend_limit", thread=self._thread_brief(tv))
        return None, (swarm, mind, addressed, context, thread)

    async def create(self, viewer, data, *, app_binding=None):
        hive = self.hive
        if not named_person(viewer.principal):
            raise refusal(hive, "person_required")
        self._validate(data)
        browser = data.get(ANSWER_IN_KEY) == "browser"   # only ever present with HIVE_MIND_GATEWAY=1 (_validate)
        conducted = self._conducting() and not browser   # once admitted, a browser turn is never re-routed
        model = self.conductor.model_for(viewer, data.get(CONDUCTOR_KEY)) if conducted else None
        body_digest = app_binding["request_digest"] if app_binding is not None else digest(data)
        lock = self._locks.setdefault(viewer.principal, asyncio.Lock())
        async with lock:   # short: the decision only, never held across an await (Kimi ask-p1 2)
            replay, decided = self._decide(viewer, data, body_digest, conducted, browser, write_free=app_binding is not None)
        if replay is not None:
            if app_binding is not None:
                with hive.db.transaction():
                    self.hive.app_ask.before_admit(app_binding)
                    self.hive.app_ask._member(self.hive.app_ask._lookup(app_binding["generation"]), replay["operation_id"])
            return replay
        swarm, mind, addressed, context, thread = decided
        if model is not None and data.get(CONDUCTOR_KEY) is None and hive.personal.acting_as(viewer.principal, mind):
            model = mind.get("model") or model   # the conductor speaks as the person's personal mind, with its model
        prepared_thread = None
        if thread is None:   # outside the lock; an empty thread left by a race or a crash is adopted next time, or swept
            pref = hive.db.one("SELECT thread_budget_usd FROM ask_prefs WHERE principal = ?", (viewer.principal,))
            budget = min(float(pref["thread_budget_usd"]) if pref else DEFAULT_BUDGET, MAX_BUDGET)
            try:
                prepared_thread = await hive.sessions.create(
                    viewer, {"mind": mind["id"], "title": "Ask thread", "budget_usd": budget}, purpose="ask",
                    cap_scope="thread" if model is not None or browser else None,
                    **({"_prepare_ask": True} if app_binding is not None else {}))
            except Exception as exc:   # logged; the page gets the closed reason only
                log.warning("ask: thread for %s with %s refused: %s", viewer.principal, mind["id"], exc)
                raise refusal(hive, "not_available") from None
        async with lock:   # short again: the admission transaction (no awaits inside)
            gate = hive.app_ask.admission_gate(app_binding) if app_binding is not None else contextlib.nullcontext()
            # P1 prepares across the await without writes. The ordinary Ask
            # path is unchanged. Lock order is turn, swarm membership, DB;
            # leave sets its independent generation fence before waiting.
            membership = hive.swarm_membership(swarm["id"]) if app_binding is not None else contextlib.nullcontext()
            transaction = hive.db.transaction() if app_binding is not None else contextlib.nullcontext()
            with gate, membership, transaction:
                existing = None
                if app_binding is not None:
                    hive.app_ask.before_admit(app_binding)
                    # Another awaited preparation may already have committed
                    # this operation, or installed its shared Ask thread.
                    existing = hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?",
                                           (viewer.principal, data["operation_id"]))
                    if existing is not None:
                        if existing["body_digest"] != body_digest:
                            raise refusal(hive, "operation_conflict")
                        hive.app_ask._member(hive.app_ask._lookup(app_binding["generation"]), data["operation_id"])
                    elif prepared_thread is not None and self._active_thread(viewer.principal, mind["id"]) is None:
                        hive.sessions.commit_prepared_ask(viewer, prepared_thread)
                if existing is not None:
                    outbox, turn_id = None, existing["id"]
                else:
                    outbox, turn_id = self._admit(viewer, data, body_digest, swarm, mind, context, model, browser,
                                                   app_binding=app_binding)
                if app_binding is not None:
                    hive.app_ask.before_admit(app_binding)
        if browser:   # the person's browser answers: nothing reaches the mind, the conductor or the room
            return self.view(self._row(turn_id))
        if model is not None and outbox is True:   # a new conductor turn: the host answers; nothing reaches the mind
            row = self._row(turn_id)
            # a personal turn's words and context were never stored: the conductor holds them in memory for this turn only
            content = {"text": data["text"], "context": context} if row["personal"] else None
            self.conductor.start(row, data.get(NOTES_KEY) if self.memory_on() else None, content=content)
            return self.view(self._row(turn_id))
        if outbox is None or outbox is True:
            return self.view(self._row(turn_id))
        with contextlib.suppress(Exception):   # not connected: the hub replays the outbox when it reconnects
            await hive.deliver(mind["id"], outbox)
        return self.view(self._row(turn_id))

    def _admit(self, viewer, data, body_digest, swarm, mind, context, model=None, browser=False, *, app_binding=None):
        """model: a conductor turn's model (conductor.py): admitted the same way, but nothing is queued for the mind and it
        opens as 'conducting'. browser (gateway r1b): a browser turn, content-free like a personal conductor turn, opens
        as 'browser' with route 'browser_mind'; nothing is queued for the mind and no conductor runs. Returns (outbox,
        turn_id); outbox is True for a new conductor or browser turn, None for a replay."""
        hive = self.hive
        threads = hive.db.all("SELECT * FROM work_sessions WHERE owner = ? AND agent_id = ? AND purpose = 'ask' AND status = 'active' "
                              "ORDER BY created_at", (viewer.principal, mind["id"]))
        if not threads:   # ended between the decision and now (New thread, deletion): nothing was admitted
            raise refusal(hive, "not_available")
        thread = threads[0]
        if app_binding is None:
            # Ordinary Ask cleanup may end empty duplicate threads. A P1
            # admission is still rollbackable: Sessions.end's inherited
            # external notices must not escape a later authority refusal.
            # Leave that unrelated cleanup to the ordinary maintenance path.
            for extra_thread in threads[1:]:
                if not hive.db.one("SELECT 1 FROM ask_turns WHERE thread_id = ?", (extra_thread["id"],)):
                    hive.sessions.end(Viewer("user:operator", True), extra_thread["id"])
        turn_id = "at_" + secrets.token_hex(12)   # global: binds the delivery, the reply and every frame
        conversation = CONVERSATION + turn_id
        extra = {"room": {"id": thread["room_id"], "kind": "session", "name": "Ask thread"},
                 "sender_name": hive.rooms._name(viewer.principal),
                 "ask": {"turn_id": turn_id, "reply_in": conversation, "label": PAGE_LABEL, "context": context}}
        frames = []
        personal = (model is not None or browser) and hive.personal.acting_as(viewer.principal, mind) is not None
        with hive.db.transaction():   # admission: all of this commits together, or nothing does
            if app_binding is not None:
                hive.app_ask.before_admit(app_binding)   # after thread creation/awaits, before any message or spend
            existing = hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?", (viewer.principal, data["operation_id"]))
            if existing:   # the same request admitted meanwhile: that turn, nothing new
                if existing["body_digest"] != body_digest:
                    raise refusal(hive, "operation_conflict")
                return None, existing["id"]
            if app_binding is not None:
                # P1 preflight was write-free. Re-scope and re-read the actual
                # held/spent measure only after final authority, atomically
                # with this turn; any later refusal rolls the scope back too.
                if model is not None:
                    hive.sessions.rescope(mind["id"], "thread")
                elif thread.get("cap_scope") == "thread":
                    hive.sessions.rescope(mind["id"], "mind", thread["id"])
                thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],))
                tv = hive.sessions.view(thread)
                held = hive.sessions.thread_held(thread) if thread.get("cap_scope") == "thread" else 0.0
                if tv["spent_usd"] + held >= float(thread["budget_usd"]) - 1e-9:
                    raise refusal(hive, "spend_limit", thread=self._thread_brief(tv))
            if not self._quota_ok(viewer.principal):
                raise refusal(hive, "rate_limited")
            busy = hive.db.one(f"SELECT operation_id FROM ask_turns WHERE thread_id = ? AND state IN {states_sql(OPEN)}", (thread["id"],))
            if busy:
                raise refusal(hive, "ask_busy", operation_id=busy["operation_id"])
            if model is None and self._payer_conflict(viewer.principal, mind["id"]):
                raise refusal(hive, "coordinator_busy")
            if self._studio_busy(mind["id"]):          # J3 R4, inside the admission transaction too
                raise refusal(hive, "coordinator_busy")
            # a personal turn writes nothing to its room: the person's words stay in their browser (and in this request)
            room_msg = None if personal else hive.rooms._append(thread["room_id"], viewer.principal, data["text"], [], 0)
            if model is None and not browser:
                outbox = hive.enqueue_message(mind["id"], data["text"], conversation, viewer.principal, extra)
                hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?",
                                (room_msg["seq"], thread["room_id"], f"agent:{mind['id']}"))
                hive.db.execute("UPDATE room_messages SET delivered_to = ? WHERE id = ?", (json.dumps([f"agent:{mind['id']}"]), room_msg["id"]))
            else:
                outbox = True
            hive.db.insert("ask_turns", {
                "id": turn_id, "operation_id": data["operation_id"], "principal": viewer.principal, "body_digest": body_digest,
                "thread_id": thread["id"], "mind_id": mind["id"], "swarm_id": swarm["id"],
                "text": "" if personal else data["text"], "personal": 1 if personal else 0,
                "via": data.get("via", "typed"), "context_resolved": "{}" if personal else json.dumps(context),
                "state": "browser" if browser else "accepted" if model is None else "conducting", "reason": None,
                "room_message_id": room_msg["id"] if room_msg else "",
                "delivery_message_id": outbox["id"] if model is None and not browser else "",
                "answer_message_id": None,
                "deadline": time.time() + (browser_turn_seconds() if browser else TIMEOUT) if model is None else self.conductor.deadline(),
                "mind_spent_at_start": float(self._mind(mind["id"])["spent_usd"] or 0),
                "next_seq": 1, "created_at": now(), "closed_at": None, "spent_usd_approx": None, "deleted_at": None,
                **({"conductor_model": model} if model is not None else {}),
                **({"route": BROWSER_ROUTE, "calls": 0, "last_call_at": time.time()} if browser else {})})
            if app_binding is not None:
                hive.app_ask.admitted(app_binding, self._row(turn_id))
            frames.append(self._frame(turn_id, "accepted", thread=self._thread_brief(hive.sessions.view(thread)),
                                      acting_as=hive.personal.acting_as(viewer.principal, mind)))
        def publish():
            self._publish(frames)
            if model is None and not browser:
                hive.events.publish("message", message=hive.message_view(outbox))
            if room_msg is not None:
                hive.rooms._event(thread["room_id"], "message")
        # A P1 session and its turn share the outer admission transaction;
        # neither live frames nor message/room notices escape its rollback.
        hive.db.after_commit(publish)
        return outbox, turn_id

    # ---- frames ---------------------------------------------------------------------------------------------------

    def _row(self, turn_id):
        return self.hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn_id,))

    def _frame(self, turn_id, phase, **fields):
        """Call inside a transaction: store the next frame of this turn and return it for publishing after commit, or
        None when the turn's one shared quota has no place for it. The quota is MAX_EVENTS frames per turn: terminal
        frames (answer, done, refused) always fit, because every other phase stops short of them: while the turn is
        open, steer and intent frames keep the last TERMINAL_RESERVE places free, and thinking frames stop four short
        (the last one saying the rest were not kept). A dropped frame is a hint lost, never the record. A conductor
        turn's frames share the same quota: its acts, `dispatched` frames and `say` deltas (an `answer` with delta: true
        is a hint, not the terminal answer) keep the reserve too, so its final answer and done always fit."""
        t = self._row(turn_id)
        if (phase not in TERMINAL or fields.get("delta")) and phase != "thinking":
            if t["next_seq"] > MAX_EVENTS - (TERMINAL_RESERVE if t["state"] in OPEN else 0):
                return None
        if phase == "thinking" and t["next_seq"] > MAX_EVENTS - 4:
            return None
        if phase == "thinking" and t["next_seq"] == MAX_EVENTS - 4:   # the last one says the rest were not kept
            fields = {"step": "", "truncated": True}
        fields = self._frame_for_asker(t["principal"], fields)
        frame = {"operation_id": t["operation_id"], "turn_id": t["id"], "principal": t["principal"], "seq": t["next_seq"],
                 "phase": phase, **fields, "at": now()}
        if getattr(self.hive, "app_ask", None) is not None and self.hive.db.one(
                "SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (turn_id,)):
            frame["app_ask"] = True
        # a personal turn's stored frame is content-free; the returned (published, asker-only) frame keeps its words
        stored = self.content_free(frame) if t["personal"] else frame
        self.hive.db.execute("INSERT INTO ask_events VALUES (?, ?, ?, ?)", (t["id"], t["next_seq"], t["principal"], json.dumps(stored)))
        self.hive.db.execute("UPDATE ask_turns SET next_seq = next_seq + 1 WHERE id = ?", (t["id"],))
        return frame

    REFUSAL_FIELDS = ("limit", "error", "say")

    def _frame_for_asker(self, principal, fields):
        """keyview at the source (Dot and Kimi on bef0f01b): a frame's refusal fields (limit, error, say) are stored,
        replayed with HTTP 200 and published on the websocket, where no response projection reaches them, so they are
        projected here, once, for the turn's asker: no key id, key:<id> scope, label or other person they may not see."""
        seer = getattr(self.hive, "key_seer_for", None)
        if seer is None or not any(k in fields for k in self.REFUSAL_FIELDS):
            return fields
        may_see = seer(principal)
        if may_see is None:   # a hive admin or the hive's owner: everything
            return fields
        from .keyview import redact_error
        part = {k: fields[k] for k in self.REFUSAL_FIELDS if k in fields}
        return {**fields, **redact_error(part, may_see, principal)}   # descriptive fields only (say, limit.scope, ...)

    @staticmethod
    def content_free(frame):
        """A personal turn's frame as the host keeps it: an allowlist of content-free metadata (stand-in r3 High 2), and
        nothing else. Kept: the frame's ids, phase, seq and time; host enums (outcome, reason, state, op); money; flags;
        digests; an act's act_id and kind; the thread's ids and money; acting_as's mind id. Every other field is dropped,
        whoever wrote it (words, labels, captions, routes, targets, refs, entities, prefs, step text, steer ids, the
        host's refusal sentence), and so is every non-scalar value outside those three shapes. Marked personal: true."""
        out = {k: v for k, v in frame.items()
               if k in CONTENT_FREE_KEYS and (v is None or isinstance(v, (str, int, float, bool)))}
        act = frame.get("act")
        if isinstance(act, dict):
            out["act"] = {k: act[k] for k in ("act_id", "kind") if isinstance(act.get(k), str)}
        thread = frame.get("thread")
        if isinstance(thread, dict):
            mind = thread.get("mind") if isinstance(thread.get("mind"), dict) else {}
            out["thread"] = {"id": thread.get("id"), "mind": {"id": mind.get("id")},
                             "budget_usd": thread.get("budget_usd"), "spent_usd": thread.get("spent_usd")}
        limit = frame.get("limit")
        if isinstance(limit, dict):
            out["limit"] = {k: limit.get(k) for k in LIMIT_FRAME_KEYS
                            if (k != "reason" or k in limit)   # reason (gateway r1a) only when the frame names one
                            and (limit.get(k) is None or isinstance(limit.get(k), (str, int, float)))}
        acting = frame.get("acting_as")
        if "acting_as" in frame:
            out["acting_as"] = {"mind_id": acting.get("mind_id")} if isinstance(acting, dict) else None
        recipient = frame.get("recipient")
        if isinstance(recipient, dict) and set(recipient) == {"kind", "generation_id", "owner_epoch"}:
            out["recipient"] = recipient
        out["personal"] = True
        return out

    def _personal_turn_sql(self):
        """Turns that spoke as a personal mind: their mind is a personal mind (only its person may ask it)."""
        return "SELECT t.id, t.thread_id FROM ask_turns t JOIN agents a ON a.id = t.mind_id WHERE a.personal_of IS NOT NULL"

    def retire_legacy_personal(self):
        """At startup, idempotent: a personal mind's turn written before r3 (personal = 0, its words, context, frames,
        room messages, hub messages, steers and intents kept as any turn's) is marked personal and its content erased,
        as a new one never writes it: the row keeps no text or context, its frames are made content-free, its thread's
        room is emptied, its hub messages and steers lose their words, its intents their bodies (Intents.on_delete).
        Done with secure_delete on and the WAL truncated after, so no freed cell or older frame keeps it. Returns the
        number of turns retired."""
        hive = self.hive
        rows = hive.db.all(self._personal_turn_sql() + " AND t.personal = 0")
        if not rows:
            return 0
        with hive.db.secure_writes(), hive.db.transaction():
            stamp = now()
            rooms = set()
            for r in rows:
                tid = r["id"]
                hive.db.execute("UPDATE ask_turns SET text = '', context_resolved = '{}', personal = 1, answer_message_id = NULL "
                                "WHERE id = ?", (tid,))
                for e in hive.db.all("SELECT seq, frame FROM ask_events WHERE turn_id = ?", (tid,)):
                    hive.db.execute("UPDATE ask_events SET frame = ? WHERE turn_id = ? AND seq = ?",
                                    (json.dumps(self.content_free(json.loads(e["frame"]))), tid, e["seq"]))
                hive.db.execute("UPDATE ask_steers SET text = '' WHERE turn_id = ?", (tid,))
                hive.db.execute("UPDATE messages SET text = '', extra = NULL WHERE conversation_id = ?", (CONVERSATION + tid,))
                self.intents.on_delete(tid, stamp)
                s = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (r["thread_id"],))
                if s and s["room_id"]:
                    rooms.add(s["room_id"])
            for room in rooms:
                hive.db.execute("DELETE FROM room_messages WHERE room_id = ?", (room,))
        log.info("ask: %d personal-mind turn(s) from before r3 marked and their content erased", len(rows))
        return len(rows)

    def _publish(self, frames):
        for f in frames:
            if f:
                app_ask = getattr(self.hive, "app_ask", None)
                if app_ask is not None:
                    app_ask.capture_live(f)
                self.hive.events.publish("ask", **{k: v for k, v in f.items() if k != "at"})

    @staticmethod
    def _addressed(context_json):
        a = (json.loads(context_json or "{}") or {}).get("addressed")
        return {"id": a["id"], "name": a["name"]} if isinstance(a, dict) and a.get("id") else None

    def _thread_brief(self, view):
        """A thread as the page shows it; `addressed` is the mind its latest turn was addressed to (or null)."""
        last = self.hive.db.one("SELECT context_resolved FROM ask_turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1", (view["id"],))
        return {"id": view["id"], "mind": {"id": view["mind"]["id"], "name": view["mind"]["name"]},
                "budget_usd": view["budget_usd"], "spent_usd": view["spent_usd"],
                "addressed": self._addressed(last["context_resolved"]) if last else None}

    def _host_limit(self, thread, thread_spent):
        """done.limit of a spend stop closed by the host (expiry, or a browser's /done spend_cap): the thread's own cap,
        named with the host's figures, when the thread is spent by its own measure (spend plus open holds, as admission
        measures it); otherwise the host cannot name it: kind unknown, figures null (ask-limits r1; gateway r1b)."""
        held = self.hive.sessions.thread_held(thread) if thread.get("cap_scope") == "thread" else 0.0
        if thread_spent is not None and thread_spent + held >= float(thread["budget_usd"]) - 1e-9:
            return {"kind": "thread", "current_usd": thread_spent, "limit_usd": float(thread["budget_usd"]), "estimate_usd": None}
        return {"kind": "unknown", "current_usd": None, "limit_usd": None, "estimate_usd": None}

    def _close(self, turn_id, state, reason=None, answer=None, limit=None, error=None):
        """The one terminal transition: open -> done (with its answer) or refused. Whoever commits first wins.
        limit / error (gateway r1c): a conductor or browser turn's done frame names the limit that refused the call (the
        host's own figures, conductor.limit_frame) or the error code (unpriced_model, key_unavailable), as the
        conductor's own close does."""
        hive, frames = self.hive, []
        with hive.db.transaction():
            t = self._row(turn_id)
            if t is None or t["state"] not in OPEN:
                return False
            mind = hive.db.one("SELECT spent_usd, model FROM agents WHERE id = ?", (t["mind_id"],))
            if t.get("route") == BROWSER_ROUTE:   # gateway r1b: the turn's own calls, by their reservations (askturn:<id>)
                from .cost_reservations import settled_usd
                spent = round(settled_usd(hive.db, "askturn:" + t["id"]), 6)
            else:
                spent = round(max(0.0, float(mind["spent_usd"] or 0) - float(t["mind_spent_at_start"])), 6) if mind else None
            hive.db.execute("UPDATE ask_turns SET state = ?, reason = ?, closed_at = ?, spent_usd_approx = ?, answer_message_id = ? WHERE id = ?",
                            (state, reason, now(), spent, answer["id"] if answer else None, turn_id))
            thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
            thread_spent = hive.sessions.view(thread)["spent_usd"] if thread else None
            if t["state"] in OPEN and t["state"] not in OPEN_HOST_MIND:
                # a conductor or browser turn ends in done with the fixed outcome enum (CLOSE_OUTCOME, one map for both,
                # r1.1 §I), never free text
                extra = {"taken_over": True} if reason == TAKEOVER else {}
                if reason == "spend_limit" and limit is not None:   # gateway r1c: the limit that refused the call
                    extra["limit"] = limit
                elif reason == "spend_limit" and thread:   # the host's own limit, never the page's (conductor.limit_frame)
                    extra["limit"] = self._host_limit(thread, thread_spent)
                if error is not None:
                    extra["error"] = error
                frames.append(self._frame(turn_id, "done", spent_usd=thread_spent, turn_spent_usd=spent,
                                          outcome=CLOSE_OUTCOME.get(reason, "error"), **extra))
            elif answer is not None:
                frames.append(self._frame(turn_id, "answer", text=answer["text"][:MAX_ANSWER], message_id=answer["id"]))
                frames.append(self._frame(turn_id, "done", spent_usd=thread_spent, turn_spent_usd=spent, outcome="answered"))
            else:
                frames.append(self._frame(turn_id, "refused", reason=reason, say=SAY[reason], spent_usd=thread_spent, turn_spent_usd=spent))
        self._publish(frames)
        if t["state"] == "conducting" and self.conductor is not None:   # stopped, ended, deleted or expired: its loop ends
            self.conductor.cancel(turn_id)
        if t.get("route") == BROWSER_ROUTE:   # gateway r1e: the outcome, after the close committed (advisory, never read back)
            with contextlib.suppress(Exception):
                hive.mindgateway.turn_closed(turn_id, mind["model"] if mind else None, CLOSE_OUTCOME.get(reason, "error"))
        return True

    # ---- the mind's side --------------------------------------------------------------------------------------------

    def reply(self, agent_id, conversation_id, text):
        """A mind's message in conversation ask:<turn_id>. Only the turn's own coordinator binds; it lands in the thread's
        room either way, and answers the turn only while that turn is open."""
        text = str(text)[:MAX_ANSWER]   # once, here: the room copy, the answer frame and recovery all carry this text
        with self.hive.db.transaction():   # the tombstone check and the room copy are one step against a deletion
            t = self._row(str(conversation_id)[len(CONVERSATION):])
            if t is None or t["mind_id"] != agent_id or t["deleted_at"] or not text.strip():
                return None
            thread = self.hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (t["thread_id"],))
            _room, msg, _targets = self.hive.rooms.record_mind(agent_id, thread["room_id"], text)
        if self._close(t["id"], "done", answer=msg):
            try:   # a copy held only for the asker's browser memory (personal_inbox.py); never wakes or calls anything
                self.hive.personal_inbox.hold(t, msg["text"])
            except Exception:
                log.exception("personal inbox hold failed for turn %s", t["id"])
        return msg

    def deleted(self, conversation_id):
        """Whether this Ask conversation's thread was deleted by its owner (a durable tombstone on the turn row)."""
        t = self.hive.db.one("SELECT deleted_at FROM ask_turns WHERE id = ?", (str(conversation_id)[len(CONVERSATION):],))
        return bool(t and t["deleted_at"])

    def asker(self, conversation_id):
        t = self.hive.db.one("SELECT principal FROM ask_turns WHERE id = ?", (str(conversation_id)[len(CONVERSATION):],))
        return t["principal"] if t else None

    def boundary_lock(self, agent_id):
        """The mind's boundary lock (Kimi ask-p1-r6 2). note_boundary holds it across its transaction and pin() across its
        read, so every pin is wholly before or wholly after a boundary. Only these two take it, each around one short
        database step and nothing else, so it nests inside the supervisor's mind lock (Supervisor.start) and never
        around it; the trace route takes it on the event loop and never takes the supervisor's lock, which a start
        holds across the driver's whole start (seconds of docker run)."""
        with self._boundary_guard:
            return self._boundary_locks.setdefault(agent_id, threading.RLock())

    def note_boundary(self, agent_id, execution):
        """Supervisor.start, after it returned and the driver reports a new running execution identity: the mind's working
        context begins again here. Turns closed before this stop shaping its traces; an open turn still does. A no-op
        start (already running) or a failed one never reaches this. The evidence is the boundary: an empty identity,
        or the one this mind's current boundary already records, is no new execution and records nothing (Kimi
        ask-p1-r6, sharpest). Returns the new boundary's seq, or None."""
        execution = str(execution or "")[:200]
        if not execution:
            log.warning("ask: boundary for %s without execution evidence; none recorded", agent_id)
            return None
        with self.boundary_lock(agent_id), self.hive.db.transaction():   # marks, not clock comparisons
            current = self.boundary(agent_id)
            if current[1] == execution:
                log.warning("ask: boundary for %s names the execution already recorded; none recorded", agent_id)
                return None
            seq = current[0] + 1
            self.hive.db.execute("UPDATE ask_turns SET cleared_seq = ? WHERE mind_id = ? AND cleared_seq IS NULL "
                                 f"AND state NOT IN {states_sql(OPEN_HOST_MIND)}", (seq, agent_id))
            self.hive.db.execute("INSERT INTO ask_boundaries (agent_id, at, execution, seq) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) "
                                 "DO UPDATE SET at = excluded.at, execution = excluded.execution, seq = excluded.seq",
                                 (agent_id, now(), execution, seq))
        return seq

    def boundary(self, agent_id):
        """(seq, execution) of the mind's current boundary; (0, None) before its first."""
        row = self.hive.db.one("SELECT seq, execution FROM ask_boundaries WHERE agent_id = ?", (agent_id,))
        return (int(row["seq"]), row["execution"]) if row else (0, None)

    def boundary_seq(self, agent_id):
        return self.boundary(agent_id)[0]

    def pin(self, agent_id):
        """(agent_id, seq, execution): the mind's execution as a trace request is authenticated, ordered against boundaries."""
        with self.boundary_lock(agent_id):
            return (agent_id, *self.boundary(agent_id))

    def trace_entry(self, agent_id):
        """Pin the mind's current execution for a trace request, at authentication (the route; reset in its finally)."""
        return TRACE_ENTRY.set(self.pin(agent_id))

    def _turns(self, agent_id, after_seq):
        return self.hive.db.all("SELECT id, principal, deleted_at FROM ask_turns WHERE mind_id = ? AND (cleared_seq IS NULL OR cleared_seq > ?) "
                                "AND conductor_model IS NULL AND (route IS NULL OR route != ?)",
                                (agent_id, int(after_seq), BROWSER_ROUTE))   # a conductor or browser turn never reached the mind

    @staticmethod
    def _withheld(rows):
        return {"scope": "withheld", "principal": None, "turn_ids": sorted(r["id"] for r in rows)} if rows else None

    def trace_scope(self, agent_id, entry_seq=None, entry_execution=None):
        """The live audience of a trace this mind is creating now (OmegaReview cdcd26b B1: time and unbound calls prove
        nothing). Candidate source turns: every Ask turn this mind has served that no context boundary has cleared (a
        turn is cleared only by a new execution started after it closed; Ask.note_boundary marks it). None: an ordinary trace (existing rules). One asker and
        no deleted turn: that asker only. Anything else: no live audience (admins keep HTTP audit).
        entry_seq/entry_execution: the pin of the execution that sent the trace. A stored trace is always judged by its
        pin (record_trace_scope); entry_seq=None is a read of the mind's view as it stands, for inspection only."""
        current_seq, current_execution = self.boundary(agent_id)
        if entry_seq is None:
            entry_seq = current_seq
        elif int(entry_seq) > current_seq or (int(entry_seq) == current_seq and entry_execution != current_execution):
            # the pin names a boundary the mind's record does not hold (Kimi ask-p1-r6, sharpest): the counter alone
            # proves nothing, so no turn this mind ever served may widen the audience
            log.warning("ask: trace pin %s/%s for %s does not match its boundary %s/%s; withheld", entry_seq, entry_execution,
                        agent_id, current_seq, current_execution)
            return self._withheld(self._turns(agent_id, -1))
        # a request admitted under an earlier execution keeps that execution's view: turns cleared by a boundary after it
        # entered still count (OmegaReview 8716093: an old in-flight trace never takes the new, wider audience)
        rows = self._turns(agent_id, entry_seq)
        if not rows:
            return None
        people = {r["principal"] for r in rows}
        if len(people) == 1 and not any(r["deleted_at"] for r in rows):
            return {"scope": "asker", "principal": people.pop(), "turn_ids": sorted(r["id"] for r in rows)}
        return self._withheld(rows)

    def record_trace_scope(self, trace_id, agent_id, pin=None):
        """Called by Hive.record_trace before the trace is published. pin: the sending execution's (agent_id, seq,
        execution), passed by an in-process caller (Hive.record_trace(..., pin=Ask.pin(...))) or set by the trace route
        (TRACE_ENTRY). Without a pin for this mind
        the trace is never judged by the current boundary (Kimi ask-p1-r6 3): if the mind ever served an Ask turn it is
        withheld, and the fallback is logged. Fails closed: an error withholds it from live delivery."""
        try:
            entry = pin if pin is not None else TRACE_ENTRY.get()
            if entry is None or entry[0] != agent_id or len(entry) != 3:
                scope = self._withheld(self._turns(agent_id, -1))
                log.warning("ask: trace %s for %s stored without an execution pin; %s", trace_id, agent_id,
                            "withheld" if scope else "no Ask turn, ordinary")
            else:
                scope = self.trace_scope(agent_id, entry[1], entry[2])
        except Exception:
            log.exception("ask: trace scope for %s failed; withheld", agent_id)
            scope = {"scope": "withheld", "principal": None, "turn_ids": []}
        if scope is not None:
            self.hive.db.execute("INSERT OR REPLACE INTO ask_trace_scopes VALUES (?, ?, ?, ?, ?)",
                                 (int(trace_id), agent_id, scope["scope"], scope["principal"], json.dumps(scope["turn_ids"])))
        return scope

    def trace_audience(self, trace_id):
        return self.hive.db.one("SELECT scope, principal FROM ask_trace_scopes WHERE trace_id = ?", (int(trace_id),))

    def room_for(self, conversation_id):
        t = self._row(str(conversation_id)[len(CONVERSATION):]) if str(conversation_id).startswith(CONVERSATION) else None
        s = self.hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (t["thread_id"],)) if t else None
        return s["room_id"] if s else None

    def on_thinking(self, agent_id, phase, payer=None):
        """A model call by this mind reaches an Ask turn only when it is attributable to it: exactly one open turn on the
        mind, and the call is billed to that turn's asker (Kimi ask-p1 1: never another person's frames)."""
        turns = self.hive.db.all(f"SELECT id, principal FROM ask_turns WHERE mind_id = ? AND state IN {states_sql(OPEN_HOST_MIND)}", (agent_id,))
        if len(turns) != 1 or turns[0]["principal"] != payer:
            return
        for t in turns:
            with self.hive.db.transaction():
                if self.hive.db.execute(f"UPDATE ask_turns SET state = 'thinking' WHERE id = ? AND state IN {states_sql(OPEN_HOST_MIND)}",
                                        (t["id"],)).rowcount != 1:
                    continue
                frame = self._frame(t["id"], "thinking", step=str(phase or "")[:200])
            self._publish([frame])

    # ---- terminal transitions besides an answer --------------------------------------------------------------------

    def expire(self, moment=None):
        """Open turns past their deadline close: spend_limit when the thread's cap is spent, otherwise timed_out. A browser
        turn (gateway r1b) closes timed_out (outcome time_cap) at its absolute deadline, or once it has been idle
        HIVE_ASK_BROWSER_IDLE_SECONDS since admission or its last call."""
        moment = time.time() if moment is None else moment
        for t in self.hive.db.all("SELECT * FROM ask_turns WHERE state = 'browser' AND (deadline <= ? OR COALESCE(last_call_at, 0) <= ?)",
                                  (moment, moment - browser_idle_seconds())):
            self._close(t["id"], "refused", "timed_out")
        for t in self.hive.db.all(f"SELECT * FROM ask_turns WHERE state IN {states_sql(OPEN)} AND deadline <= ?", (moment,)):
            thread = self.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
            spent = bool(thread) and self.hive.sessions.view(thread)["spent_usd"] >= float(thread["budget_usd"]) - 1e-9
            self._close(t["id"], "refused", "spend_limit" if spent else "timed_out")
        for s in self.hive.db.all("SELECT id FROM work_sessions WHERE purpose = 'ask' AND status = 'active' AND created_at <= ? AND NOT EXISTS "
                                  "(SELECT 1 FROM ask_turns WHERE thread_id = work_sessions.id)", (_iso(moment - EMPTY_THREAD_SECONDS),)):
            with contextlib.suppress(Exception):   # a thread that never got a turn: end it, so its cap is released
                self.hive.sessions.end(Viewer("user:operator", True), s["id"])

    def thread_ended(self, thread_id):
        for t in self.hive.db.all(f"SELECT id FROM ask_turns WHERE thread_id = ? AND state IN {states_sql(OPEN)}", (thread_id,)):
            self._close(t["id"], "refused", "stopped")

    def cancel_for(self, principal):
        """host-identity r1: sign-out or revoked access. Every open turn the person asked stops, through the same
        terminal transition as their own Stop (a conductor turn's loop is cancelled with it), so none runs on, or keeps
        naming them as its payer, after they have gone."""
        for t in self.hive.db.all(f"SELECT id FROM ask_turns WHERE principal = ? AND state IN {states_sql(OPEN)}",
                                  (principal,)):
            self._close(t["id"], "refused", "stopped")

    def month_remaining(self, mind_id):
        """What the person's one monthly total (Budgets.monthly_total) leaves for their personal mind's calls now, after
        settled spend and open holds, in USD; None when the call would be free (a local or mock model) or no monthly total
        exists (each call is then refused monthly_total_required). Advisory, for the page: it admits nothing."""
        hive, c = self.hive, self.conductor
        try:
            from .gateway import split_model
            agent = hive._agent_row(mind_id)
            provider_name, _ = split_model(agent["model"])
            gw = c.gateway
            if gw.provider(provider_name).local or provider_name == "mock":
                return None
            key_id = gw.paying_key(agent, provider_name)[0]
            key_owner = ((gw.keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if (key_id and gw.keyring) else None
            payer, own_key = hive.payer_for(agent, key_owner)
            row = hive.budgets.monthly_total(agent, payer, own_key, key_id)
            if row is None:
                return None
            scope, period, limit, _origin = row
            held = c.reservations.pending(f"{scope}:{period}") / 1_000_000
            return dollars(max(0, to_micros(limit) - to_micros(hive.budgets.spent(scope, period) + held, up=True)))
        except Exception:   # noqa: BLE001  (advisory only: never fails a read)
            return None

    def done(self, viewer, operation_id, data):
        """POST /api/ask/{op}/done {outcome} (gateway r1b, plan §2.3): the person's browser closes its own browser turn.
        The turn's owner only; a browser turn only (anything else: 404 not_available, as for an unknown op). outcome is
        one close word (DONE_WORDS), stored through the one terminal transition (_close, CLOSE_OUTCOME); a spend stop
        carries the host's own limit, never the page's. It releases nothing (a held call stays held) and is idempotent:
        a repeat, or a turn the host already closed, answers the turn as it stands."""
        hive = self.hive
        t = self._own(viewer, operation_id)
        if t.get("route") != BROWSER_ROUTE:
            raise refusal(hive, "not_available")
        if not isinstance(data, dict) or set(data) != {"outcome"} or data["outcome"] not in DONE_WORDS:
            raise refusal(hive, "invalid")
        if t["state"] == "browser":
            state, reason = DONE_CLOSE[data["outcome"]]
            self._close(t["id"], state, reason)
        return self.view(self._row(t["id"]))

    def stop(self, viewer, operation_id):
        t = self._own(viewer, operation_id)
        self._close(t["id"], "refused", "stopped")
        return self.view(self._row(t["id"]))

    def takeover(self, viewer, operation_id):
        """POST /api/ask/{op}/takeover: the person took the page back while a conductor turn was steering it. The turn's
        owner only (anyone else, an admin included: 404 not_available, as for an unknown op); a conductor turn only (the
        conductor off, or a coordinator turn: 404 not_available, nothing changes). An open turn closes at once through
        the one terminal transition (_close: reason 'takeover', a done frame published to every view the person has
        open, the loop cancelled so no further model call or act follows). Idempotent: a repeat, or a turn already
        closed by an earlier takeover, answers the same; a turn that had already ended another way answers its own
        state, unchanged."""
        t = self._own(viewer, operation_id)
        if t["reason"] != TAKEOVER:
            if self.conductor is None or not t.get("conductor_model") or (t["state"] in OPEN and t["state"] != "conducting"):
                raise refusal(self.hive, "not_available")
            self._close(t["id"], "refused", TAKEOVER)
            t = self._row(t["id"])
        return {"operation_id": t["operation_id"], "turn_id": t["id"],
                "state": "taken_over" if t["reason"] == TAKEOVER else t["state"], "ended_at": t["closed_at"]}

    def delete_thread(self, viewer, thread_id):
        """The person's own "delete this thread" (Jon 2026-10-05, retention like room history): the thread ends (its cap is
        restored, an open turn stops), its room is archived and emptied, and the request and answer text of its turns and
        their hub messages is removed. The turn rows stay, without text, so the audit still shows that they happened."""
        hive = self.hive
        s = hive.db.one("SELECT * FROM work_sessions WHERE id = ? AND purpose = 'ask'", (str(thread_id),))
        if s is None or s["owner"] != viewer.principal:
            raise refusal(hive, "not_available")
        hive.sessions.end(viewer, s["id"])
        turns = [t["id"] for t in hive.db.all("SELECT id FROM ask_turns WHERE thread_id = ?", (s["id"],))]
        with hive.db.transaction():   # serialized with Hive.record_agent_message's tombstone check
            for tid in turns:
                stamp = now()
                hive.db.execute("UPDATE ask_turns SET text = '', context_resolved = '{}', deleted_at = ? WHERE id = ?", (stamp, tid))
                hive.db.execute("UPDATE ask_steers SET text = '' WHERE turn_id = ?", (tid,))
                self.intents.on_delete(tid, stamp)   # linkage a.5: in the same transaction as the intent rows
                for e in hive.db.all("SELECT seq, frame FROM ask_events WHERE turn_id = ?", (tid,)):
                    frame = json.loads(e["frame"])
                    act = frame.get("act") if isinstance(frame.get("act"), dict) else {}
                    dispatched = frame.get("phase") == "dispatched"
                    if frame.get("phase") == "memory":   # a remember frame's stored copy: its op and digest go too
                        frame.update({"op": "", "digest": ""})
                        frame.pop("item", None)
                        hive.db.execute("UPDATE ask_events SET frame = ? WHERE turn_id = ? AND seq = ?", (json.dumps(frame), tid, e["seq"]))
                        continue
                    if dispatched or "text" in frame or "label" in frame or any(k in act for k in ("text", "caption", "label")):
                        for k in ("text", "label") + (("intent_id", "intent_kind") if dispatched else ()):
                            if k in frame:
                                frame[k] = ""
                        if dispatched and isinstance(frame.get("to"), dict):   # a conductor hand-off's ids go with the thread
                            frame["to"] = {**frame["to"], "ref": "", **({"name": ""} if "name" in frame["to"] else {})}
                        for k in ("text", "caption", "label"):   # a conductor act's words (conductor.py)
                            if k in act:
                                act[k] = ""
                        hive.db.execute("UPDATE ask_events SET frame = ? WHERE turn_id = ? AND seq = ?", (json.dumps(frame), tid, e["seq"]))
                hive.db.execute("UPDATE messages SET text = '', extra = NULL WHERE conversation_id = ?", (CONVERSATION + tid,))
            hive.db.execute("DELETE FROM room_messages WHERE room_id = ?", (s["room_id"],))
            hive.db.execute("UPDATE rooms SET archived = 1, updated_at = ? WHERE id = ?", (now(), s["room_id"]))
        hive.rooms._event(s["room_id"], "updated")
        return {"deleted": s["id"], "turns": len(turns)}

    # ---- steering an open turn (Jon's fluid-steering ruling; the host contract's phase 1.1) -------------------------

    def _steer_body(self, data):
        hive = self.hive
        if not isinstance(data, dict):
            raise refusal(hive, "invalid")
        if forbidden(data):
            raise refusal(hive, "not_allowed", 400)
        if set(data) - STEER_KEYS or not {"steer_id", "text", "at_seq"} <= set(data):
            raise refusal(hive, "invalid")
        if not isinstance(data["steer_id"], str) or not STEER_ID.fullmatch(data["steer_id"]):
            raise refusal(hive, "invalid")
        text = data["text"]
        if not isinstance(text, str) or not text.strip():
            raise refusal(hive, "invalid")
        if len(text) > MAX_TEXT:
            raise refusal(hive, "too_large", limit_chars=MAX_TEXT)
        if type(data["at_seq"]) is not int or data["at_seq"] < 0:
            raise refusal(hive, "invalid")
        via = data.get("via", "typed")
        if via not in VIA:   # recorded as a request's is; anything else is refused, never coerced
            raise refusal(hive, "invalid")
        return {"steer_id": data["steer_id"], "text": text, "at_seq": data["at_seq"], "via": via}

    def _steer_answer(self, turn, steer):
        return {"steer_id": steer["steer_id"], "operation_id": turn["operation_id"], "turn_id": turn["id"], "new_turn": False,
                "seq": steer["seq"], "via": steer["via"]}

    async def steer(self, viewer, operation_id, data, *, app_binding=None):
        """POST /api/ask/{operation_id}/steer {steer_id, text, at_seq, via?}: the person's words while their turn is open.
        Requester only; idempotent on steer_id (the same body answers the same result; another body is 409
        operation_conflict). An open turn: the words join it as a person message in its thread and are delivered to its
        coordinator in the turn's own conversation, with an asker-only 'steer' frame; no new turn, no new budget, at
        most MAX_STEERS. A closed turn: the words start a fresh turn ("steer:" + steer_id) in the same swarm, never
        dropped. `via` (typed|voice, default typed) is recorded either way; any other value is refused."""
        hive = self.hive
        if not named_person(viewer.principal):
            raise refusal(hive, "person_required")
        body = self._steer_body(data)
        body_digest = app_binding["request_digest"] if app_binding is not None else digest(body)
        t = self._own(viewer, operation_id)
        prior = hive.db.one("SELECT * FROM ask_steers WHERE principal = ? AND steer_id = ?", (viewer.principal, body["steer_id"]))
        if prior is not None:   # the durable binding answers first, even after the source turn's thread was deleted
            if prior["body_digest"] != body_digest or prior["turn_id"] != t["id"]:
                raise refusal(hive, "operation_conflict")
            if prior["outcome"] == "joined":
                return self._steer_answer(t, prior)
            if prior["outcome"] == "studio":   # J3 R5 (O1): a Studio direction's recorded answer, byte for byte
                return self._studio_replay(prior)
            fresh = hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?",
                                (viewer.principal, prior["new_operation_id"]))
            if fresh is not None:
                return self._new_turn_answer(body, self.view(fresh))
        if t["deleted_at"]:
            raise refusal(hive, "not_available")
        lock = self._locks.setdefault(viewer.principal, asyncio.Lock())
        frames, outbox, thread = [], None, None
        studio = getattr(hive, "studio", None) if getattr(getattr(hive, "studio", None), "enabled", False) else None
        studio_answer = studio_room = None
        async with lock:   # short: one transaction, no awaits inside
            gate = hive.app_ask.admission_gate(app_binding) if app_binding is not None else contextlib.nullcontext()
            with gate, hive.db.transaction():
                if app_binding is not None:
                    hive.app_ask.before_admit(app_binding)
                prior = hive.db.one("SELECT * FROM ask_steers WHERE principal = ? AND steer_id = ?", (viewer.principal, body["steer_id"]))
                if prior is not None:   # bound to its source turn and its whole body (steer_id, text, at_seq, via)
                    if prior["body_digest"] != body_digest or prior["turn_id"] != t["id"]:
                        raise refusal(hive, "operation_conflict")
                    if prior["outcome"] == "joined":
                        return self._steer_answer(t, prior)
                    if prior["outcome"] == "studio":
                        return self._studio_replay(prior)
                t = self._row(t["id"])
                # J3 R5 (O1, plan §4.1): the person's own Studio session bound to this turn takes the steer, whatever the
                # turn's state, before the conducting refusal and the closed-turn fresh turn. None with Studio off.
                bound = studio.steer_session(viewer.principal, t) if prior is None and studio is not None else None
                if prior is not None:
                    pass                # a closed-turn steer already bound: its fresh turn is replayed below
                elif bound is not None:
                    studio_answer, frame, studio_room = studio.direction(self, viewer, t, bound, body, body_digest)
                    frames.append(frame)
                elif t["state"] in OPEN and t["state"] not in OPEN_HOST_MIND:
                    # a conductor turn never reaches the mind and its loop takes no steering; nor does a browser turn (its
                    # person's browser holds the words): refused, nothing written
                    raise refusal(hive, "not_available")
                elif t["state"] in OPEN and not t["deleted_at"]:
                    if hive.db.one("SELECT COUNT(*) AS n FROM ask_steers WHERE turn_id = ? AND outcome = 'joined'", (t["id"],))["n"] >= MAX_STEERS:
                        raise refusal(hive, "rate_limited", limit_steers=MAX_STEERS)
                    if body["at_seq"] >= t["next_seq"]:   # the page cannot have seen a frame the turn has not sent
                        raise refusal(hive, "invalid")
                    thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
                    conversation = CONVERSATION + t["id"]
                    room_msg = hive.rooms._append(thread["room_id"], viewer.principal, body["text"], [], 0)
                    extra = {"room": {"id": thread["room_id"], "kind": "session", "name": "Ask thread"},
                             "sender_name": hive.rooms._name(viewer.principal),
                             "ask": {"turn_id": t["id"], "reply_in": conversation, "label": STEER_LABEL,
                                     "steer": {"steer_id": body["steer_id"], "at_seq": body["at_seq"], "via": body["via"]}}}
                    outbox = hive.enqueue_message(t["mind_id"], body["text"], conversation, viewer.principal, extra)
                    hive.db.execute("UPDATE room_members SET delivered_seq = ? WHERE room_id = ? AND member = ?",
                                    (room_msg["seq"], thread["room_id"], f"agent:{t['mind_id']}"))
                    hive.db.execute("UPDATE room_messages SET delivered_to = ? WHERE id = ?",
                                    (json.dumps([f"agent:{t['mind_id']}"]), room_msg["id"]))
                    # the shared quota: the words always reach the room and the mind; the frame only when it has a place
                    frame = self._frame(t["id"], "steer", steer_id=body["steer_id"], text=body["text"], at_seq=body["at_seq"],
                                        via=body["via"])
                    frames.append(frame)
                    hive.db.insert("ask_steers", {
                        "principal": viewer.principal, "steer_id": body["steer_id"], "turn_id": t["id"], "body_digest": body_digest,
                        "text": body["text"], "via": body["via"], "at_seq": body["at_seq"], "seq": frame["seq"] if frame else None,
                        "room_message_id": room_msg["id"], "delivery_message_id": outbox["id"], "created_at": now(),
                        "outcome": "joined", "new_operation_id": None})
                else:                   # closed: bind steer_id to this source turn and body before the fresh turn exists
                    hive.db.insert("ask_steers", {   # a personal turn's steer keeps its digest only (no words on the host)
                        "principal": viewer.principal, "steer_id": body["steer_id"], "turn_id": t["id"], "body_digest": body_digest,
                        "text": "" if t["personal"] else body["text"], "via": body["via"], "at_seq": body["at_seq"], "seq": None,
                        "room_message_id": "", "delivery_message_id": "", "created_at": now(),
                        "outcome": "new_turn", "new_operation_id": STEER_OPERATION + body["steer_id"]})
        if studio_answer is not None:
            # queued for the maker: nothing is pushed per remark (plan §4.4). The session advances at once (r1.5 H3.3: a
            # direction is a direct trigger), which admits a next step only when no step is open and the session is active
            self._publish([f for f in frames if f])
            if studio_room:
                hive.rooms._event(studio_room, "message")
            try:
                await studio.advance(studio_answer["studio"]["session_id"])
            except Exception:   # noqa: BLE001  (the sweep picks the session up on its next tick)
                log.exception("studio advance after a direction failed")
            return studio_answer
        if outbox is not None:
            self._publish(frames)
            hive.events.publish("message", message=hive.message_view(outbox))
            hive.rooms._event(thread["room_id"], "message")
            with contextlib.suppress(Exception):   # not connected: the hub replays the outbox when it reconnects
                await hive.deliver(t["mind_id"], outbox)
            return self._steer_answer(t, {**body, "seq": frames[0]["seq"] if frames[0] else None})
        # the turn has closed: the words become a fresh request in the same swarm (its coordinator answers), never dropped
        fresh = await self.create(viewer, {"operation_id": STEER_OPERATION + body["steer_id"], "text": body["text"],
                                           "via": body["via"], "context": {"swarm_id": t["swarm_id"]}}, app_binding=app_binding)
        return self._new_turn_answer(body, fresh)

    @staticmethod
    def _studio_replay(prior):
        """J3 R5 (O1): a Studio direction answers its recorded bytes on replay (plan §4.3)."""
        return json.loads(prior["studio_answer"]) if prior.get("studio_answer") else None

    @staticmethod
    def _new_turn_answer(body, fresh):
        return {"steer_id": body["steer_id"], "operation_id": fresh["operation_id"], "turn_id": fresh["turn_id"],
                "new_turn": True, "thread": fresh["thread"], "state": fresh["state"], "via": fresh["via"]}

    @staticmethod
    def recover_startup(tx):
        """Step 2 of the one combined §L startup recovery: the Ask intent sweep (linkage r3.6 a.4 R2b)."""
        from .ask_intents import Intents
        return Intents.recover_startup(tx)

    # ---- reading -----------------------------------------------------------------------------------------------------

    def _own(self, viewer, operation_id):
        t = self.hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?", (viewer.principal, str(operation_id)))
        if t is None:
            raise refusal(self.hive, "not_available")
        return t

    def events(self, turn_id, after=0, limit=PAGE_EVENTS):
        limit = max(1, min(int(limit), PAGE_EVENTS))
        rows = self.hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? AND seq > ? ORDER BY seq LIMIT ?", (turn_id, int(after), limit + 1))
        frames = [json.loads(r["frame"]) for r in rows[:limit]]
        if self._is_personal(turn_id):   # stored content-free already; read content-free again, for whoever reads
            frames = [self.content_free(f) for f in frames]
        return {"events": frames, "next_after": frames[-1]["seq"] if frames else int(after), "more": len(rows) > limit}

    def get(self, viewer, operation_id, after=0, limit=PAGE_EVENTS):
        if not self.read_ok(viewer.principal):
            raise refusal(self.hive, "rate_limited")
        self.expire()
        t = self._own(viewer, operation_id)
        return {**self.view(t), "links_rev": int(t["links_rev"]), "links": self.intents.links(t["id"]), **self.events(t["id"], after, limit)}

    def _is_personal(self, turn_id):
        """By the row's mark, or by its mind being a personal mind (a row the mark has not reached reads the same)."""
        row = self.hive.db.one("SELECT t.personal, a.personal_of FROM ask_turns t LEFT JOIN agents a ON a.id = t.mind_id "
                               "WHERE t.id = ?", (turn_id,))
        return bool(row and (row["personal"] or row["personal_of"]))

    def view(self, t):
        if t["personal"] or self._is_personal(t["id"]):   # never stored; never returned, to anyone (it lives in the browser)
            t = {**t, "text": "", "context_resolved": "{}"}
        thread = self.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
        view = {"operation_id": t["operation_id"], "turn_id": t["id"],
                # a conductor turn at work reads as 'thinking' (the page's closed state set); its model is shown beside it
                "state": "thinking" if t["state"] == "conducting" else t["state"], "reason": t["reason"],
                "thread": self._thread_brief(self.hive.sessions.view(thread)) if thread else None,
                "text": t["text"], "via": t["via"], "context": json.loads(t["context_resolved"]),
                "addressed": self._addressed(t["context_resolved"]),
                "answer_message_id": t["answer_message_id"], "created_at": t["created_at"], "closed_at": t["closed_at"],
                "turn_spent_usd": t["spent_usd_approx"]}
        if getattr(self.hive, "app_ask", None) is not None and self.hive.db.one(
                "SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (t["id"],)):
            view["app_ask"] = True
        if t.get("conductor_model"):
            view["conductor"] = {"model": t["conductor_model"]}
        if t.get("route") == BROWSER_ROUTE:   # gateway r1b: the route, the interim turn guard and the monthly total's room
            from .conductor import turn_cap_usd
            view["route"] = BROWSER_ROUTE
            view["cap_usd"] = turn_cap_usd()
            view["month_remaining_usd"] = self.month_remaining(t["mind_id"]) if t["state"] == "browser" else None
        # who the turn speaks as: the asker's own personal mind ({mind_id, name}), else null (a swarm's coordinator)
        view["acting_as"] = self.hive.personal.acting_as(t["principal"], self.hive.db.one("SELECT * FROM agents WHERE id = ?", (t["mind_id"],)))
        return view

    def list(self, viewer, limit=50):
        self.expire()
        rows = self.hive.db.all("SELECT * FROM ask_turns WHERE principal = ? ORDER BY created_at DESC LIMIT ?",
                                (viewer.principal, max(1, min(int(limit), 200))))
        return [self.view(r) for r in rows]

    def audit(self, limit=100, principal=None, before=None):
        """Every person's turns, for admins (no true secrets): text, resolved context and state, newest first. A personal
        mind's turn shows its metadata only: the host keeps no text, context or answer for it (view, events)."""
        self.expire()
        sql, params = "SELECT * FROM ask_turns WHERE 1 = 1", []
        if principal:
            sql, params = sql + " AND principal = ?", params + [principal]
        if before:
            sql, params = sql + " AND created_at < ?", params + [before]
        rows = self.hive.db.all(sql + " ORDER BY created_at DESC LIMIT ?", (*params, max(1, min(int(limit), 200))))
        return [{**self.view(r), "principal": r["principal"], "mind_id": r["mind_id"], "swarm_id": r["swarm_id"]} for r in rows]

    def audit_turn(self, turn_id, after=0, limit=PAGE_EVENTS):
        t = self._row(turn_id)
        if t is None:
            raise refusal(self.hive, "not_available")
        return {**self.view(t), "principal": t["principal"], "mind_id": t["mind_id"], "swarm_id": t["swarm_id"],
                "links_rev": int(t["links_rev"]), "links": self.intents.links(t["id"]), **self.events(t["id"], after, limit)}
