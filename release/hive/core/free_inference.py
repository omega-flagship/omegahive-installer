# Purpose: free inference as a model route: an OpenAI-compatible endpoint on a key the deploy supplies, offered to the
# people in the hive, each held to their model calls a day and the hive to its own, recorded at no cost to the hive, and
# the key never shown to anyone.
"""Free inference (asked for at the 16 Nov standup: "use our own inference and for free ... with some limits"; "we set
up one API key we add to the app").

The deploy puts its key in HIVE_FREE_INFERENCE_KEY (hive.env on a server; nothing else ever holds it) and, when the key
isn't Singularity Compute's, the endpoint it belongs to in HIVE_FREE_INFERENCE_URL. config.py builds the provider ``free`` from them,
with the models HIVE_FREE_INFERENCE_MODELS names (the first is the default a person's mind moves to when they choose free
inference). With no key, or an endpoint the key may not travel to, there is no ``free`` provider, so nothing offers it
and a call on it is refused before anything is sent.

It is a route of its own, like the owner's subscription route (subscription_cli.py), never the provider environment key
it might look like: an environment key is the hive owner's (ownhive.key_owner), which other people use only through
the owner's grants and which the owner's limits count. Here:

- who: the person each call is for (the caller's principal when it knows it, else Hive.user_for), a named and enabled
  person in this hive, whoever owns the mind. A public visitor (signed in on a public hive with no invite) only where
  the deploy opts visitors in, HIVE_FREE_INFERENCE_VISITORS=1. A call for no one in particular is refused. Hive.user_for
  names a mind's owner for everything it does outside an Ask turn or a work session, so its replies in rooms and its
  work on goals count toward its owner's calls, as they would toward the owner's money on a paid route;
- which model: only one the deploy's list holds now (check_model), when a mind's model changes and at every admission;
- how much: each person's model calls a day (UTC), HIVE_FREE_INFERENCE_DAILY_CALLS, 200 by default, and the whole
  hive's, HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS, 2000 by default, so many accounts can't multiply the deploy's spend.
  0 or an unreadable value turns the route off. Free tiers count requests a day too (OpenRouter's free models). Both
  counts are taken in one statement before dispatch, and given back for a call that ends before it commits at the send
  boundary (Gateway.free_uncommitted), when nothing can have reached the endpoint;
- when: only while a person is asking the mind, directly or through a chain they started. A mind's own call (no
  caller naming the person) is refused, counted for no one and sent nowhere, when its last asking (agents.last_asked_at)
  is older than HIVE_FREE_INFERENCE_IDLE_WINDOW_S seconds, 1800 by default (0 turns this off). A person's message stamps
  it now (Hive.mark_asked); another mind's message passes on only the sender's own last asking (Hive.mark_asked_by), and
  a goal assigned, claimed or heartbeaten passes on the goal's (goals.asked_at: a goal a person stands behind, their own,
  their request's or their Create plan's, its making; a mind's goal its maker's last asking; Goals.person_behind,
  Hive.pass_asked), so minds can't keep each other or themselves awake. A mind never asked
  counts from its creation, but passes nothing on. Past the window, a live lease on a goal a person made (or the root of
  its tree) still admits it (FreeGate.on_persons_goal): the runtime sends no heartbeat by itself and a lease outlasts the
  window. Its loop wakes every 15 minutes with up to 8 model calls a wake, and on staging a mind nobody addressed spent
  156 of its person's 200 calls overnight. A call the Ask or a browser turn makes for the person asking is never refused
  for it: that person is the input;
- recorded: the call's tokens, at $0 to the hive, payer the person, payer_mode 'free'. It is not the hive's money, so no
  limit of the hive, a swarm or a person counts it, and the calls a day bound it instead;
- unseen: the gateway sends the key only as the upstream Authorization header; providers.py lists no key row, hint or
  account for it, and redact.py knows it like every key the hive holds.
"""

from __future__ import annotations

import datetime
import os

from .budgets import period_start
from .config import FREE, is_free
from .db import parse_stamp
from .refusals import refused

PAYER_MODE = "free"
DAILY_CALLS_DEFAULT = 200
HIVE_DAILY_CALLS_DEFAULT = 2000   # ten people's full day
SQLITE_MAX = 2 ** 63 - 1          # the largest INTEGER SQLite binds: a larger setting means "no lower bound than this"
TABLE = "free_inference_calls"
FREE_IDLE_WINDOW_S = 1800         # half an hour with nothing from outside a mind and its own calls rest

# Every refusal of this route is a row of refusals.py, each in words written for the person, never a provider's text.


def _calls(name, default):
    """A number of model calls from the environment: unset gives the default; a whole number is taken as it is, from 0 up
    to SQLite's largest integer; anything else (unreadable, negative) gives 0, which turns the route off (closed)."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return min(max(0, int(raw)), SQLITE_MAX)
    except ValueError:
        return 0


def daily_cap():
    """HIVE_FREE_INFERENCE_DAILY_CALLS: each person's model calls a day on the free route."""
    return _calls("HIVE_FREE_INFERENCE_DAILY_CALLS", DAILY_CALLS_DEFAULT)


def hive_daily_cap():
    """HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS: the whole hive's model calls a day on the free route."""
    return _calls("HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS", HIVE_DAILY_CALLS_DEFAULT)


def idle_window():
    """HIVE_FREE_INFERENCE_IDLE_WINDOW_S: seconds after the last input from outside a mind (Hive.mark_asked) that its own
    calls are still admitted. Unset gives FREE_IDLE_WINDOW_S; 0 turns resting off; anything unreadable or negative keeps
    the default, so a typo never lets idle minds spend."""
    raw = os.environ.get("HIVE_FREE_INFERENCE_IDLE_WINDOW_S", "").strip()
    if not raw:
        return FREE_IDLE_WINDOW_S
    try:
        value = int(raw)
    except ValueError:
        return FREE_IDLE_WINDOW_S
    return value if value >= 0 else FREE_IDLE_WINDOW_S


def visitors_admitted():
    """HIVE_FREE_INFERENCE_VISITORS=1: public visitors may use free inference too. Unset or anything else: they may not."""
    return os.environ.get("HIVE_FREE_INFERENCE_VISITORS", "").strip() == "1"


def until_midnight_utc(moment=None):
    """Seconds until the next UTC midnight, when the day's free calls come back (the day the counts use, period_start)."""
    moment = moment or datetime.datetime.now(datetime.timezone.utc)
    return ((moment.replace(hour=0, minute=0, second=0, microsecond=0) + datetime.timedelta(days=1)) - moment).total_seconds()


def check_model(providers, label):
    """A model label on the free route names a model the deploy pays for now, or it is refused: the deploy chose what its
    key runs (HIVE_FREE_INFERENCE_MODELS, or a providers file's free entry), and a mind naming another model, or keeping
    one the deploy has since dropped, would spend the key on it. Every other route passes. Example: with the list
    ['minimax/minimax-m3.1-flash'], 'free/minimax/minimax-m3.1-flash' passes and 'free/deepseek/x' is refused (403)."""
    route, _, model = str(label or "").partition("/")
    if not is_free(route):
        return
    provider = providers.get(FREE)
    if provider is None:
        raise refused("free_inference_off", 403)
    if model not in provider.models:
        offered = ", ".join(provider.models)
        raise refused("free_model_not_offered", 403, model=model or "that model",
                      offered=f" It offers {offered}." if offered else "")


class FreeGate:
    """Admits each call on the free route for the person it is for, under their calls and the hive's for the day."""

    SCHEMA = (f"CREATE TABLE IF NOT EXISTS {TABLE} (person TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL, "
              "PRIMARY KEY (person, day))")
    DAY_INDEX = f"CREATE INDEX IF NOT EXISTS {TABLE}_day ON {TABLE} (day)"   # the hive's day: one index range

    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(self.SCHEMA)
        hive.db.execute(self.DAY_INDEX)

    def offered(self):
        """Whether this hive offers free inference now: a remote free route holding a key and a model, with calls a day for
        each person and for the hive (0 of either turns it off)."""
        provider = self.hive.settings.providers.get(FREE)
        return (provider is not None and bool(provider.api_key) and not provider.local and bool(provider.models)
                and daily_cap() > 0 and hive_daily_cap() > 0)

    def person_for(self, agent, principal=None):
        """The named, enabled person a call by this mind is for: the caller's principal when it knows it, else
        Hive.user_for on the stored mind (a proposed one, id "", is read as given). Refused otherwise, and a public
        visitor is refused unless the deploy opts visitors in."""
        hive = self.hive
        if principal is None:
            stored = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent.get("id"),)) \
                if isinstance(agent, dict) and agent.get("id") else None
            principal = hive.user_for(stored or agent)
        access = hive.ownhive.access(principal) if isinstance(principal, str) and principal.startswith("user:u_") else None
        if access is None:
            raise refused("free_inference_person_only", 403)
        if access == "public" and not visitors_admitted():
            raise refused("free_inference_invited_only", 403)
        return principal

    def authorize(self, agent, principal=None):
        """The route's authority over a call, the day's counts aside: offered, the deploy's model, a person it admits.
        Returns that person. Gateway.chat asks it again at the send boundary, after any wait, so a call whose person was
        disabled or removed meanwhile is refused there with nothing sent. The route and its models can't change while
        the hive runs (the providers load once, at start), so for them the second asking repeats the first."""
        if not self.offered():
            raise refused("free_inference_off", 403)
        check_model(self.hive.settings.providers, (agent or {}).get("model") if isinstance(agent, dict) else None)
        return self.person_for(agent, principal)

    def admit(self, agent, principal=None, dispatch=False, idle_guard=True):
        """Authorized (above), then resting (resting, below), then the day: the person's calls and the hive's.
        dispatch=True counts this call for both in one statement (atomic: refused past either cap) and returns its ticket
        (person, day) for release; False only checks there is room and returns None. idle_guard=False: the question is
        whether the route would serve this mind at all (First Light's preflight, Budgets.settlement), not whether its own
        call may go now.
        Time: one indexed sum over the day's rows, d = the people who used it today, per admission."""
        person = self.authorize(agent, principal)
        if idle_guard and principal is None and self.resting(agent):
            raise refused("free_inference_idle", 429)
        limit, ceiling, day = daily_cap(), hive_daily_cap(), period_start("day")
        if not dispatch:
            if self.used(person, day) >= limit or self.hive_used(day) >= ceiling:
                raise self._full(person, day, limit)
            return None
        db = self.hive.db
        with db.transaction():   # one statement pair under the connection lock; SQLite makes it atomic across processes
            db.execute(f"INSERT OR IGNORE INTO {TABLE} (person, day, calls) VALUES (?, ?, 0)", (person, day))
            counted = db.execute(f"UPDATE {TABLE} SET calls = calls + 1 WHERE person = ? AND day = ? AND calls < ? "
                                 f"AND (SELECT COALESCE(SUM(calls), 0) FROM {TABLE} WHERE day = ?) < ?",
                                 (person, day, limit, day, ceiling)).rowcount
        if counted != 1:
            raise self._full(person, day, limit)
        return person, day

    def resting(self, agent, moment=None):
        """Whether a stored mind's own call meets nobody asking: no input from outside it (agents.last_asked_at, stamped
        by Hive.mark_asked) within idle_window() seconds. A mind never asked counts from its creation (created_at), so a
        new mind gets the window once; one made before this guard and never asked since rests at once (the migration
        fills last_asked_at from last_input_at, so a mind in use doesn't). Past the window, a live lease on a goal a
        person made still admits it (on_persons_goal). Never
        last_input_at or last_active_at: the mind's own messages and beliefs stamp the first, its inbox polls, tool calls
        and starts the second, so either would let a mind keep itself awake. An unreadable stamp is resting. A proposed
        mind (no id) never is: it makes no calls of its own. Example: asked 10 minutes ago, or never asked and made 10
        minutes ago -> False; asked 40 minutes ago, or never asked and made 40 minutes ago -> True (window 1800)."""
        window = idle_window()
        agent_id = agent.get("id") if isinstance(agent, dict) else None
        if window <= 0 or not agent_id:
            return False
        row = self.hive.db.one("SELECT last_asked_at, created_at FROM agents WHERE id = ?", (agent_id,))
        asked = parse_stamp((row["last_asked_at"] or row["created_at"]) if row else None)
        moment = moment or datetime.datetime.now(datetime.timezone.utc)
        if asked is not None and (moment - asked).total_seconds() < window:
            return False
        return not self.on_persons_goal(agent_id, moment)

    def on_persons_goal(self, agent_id, moment):
        """Whether the mind holds a live lease on a goal a person made (claimed by it, lease_until still ahead;
        Goals.person_made): its loop sends no heartbeat by itself and the lease outlasts the window, so a person's goal
        must not rest mid-run and expire. A goal a mind made for itself never counts. Time: one indexed read of the
        mind's claimed goals."""
        stamp = moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        held = self.hive.db.all("SELECT * FROM goals WHERE claimed_by = ? AND status = 'claimed' AND lease_until > ?",
                                (agent_id, stamp))
        return any(self.hive.goals.person_made(goal) for goal in held)

    def _full(self, person, day, limit):
        """The refusal for a day with no room: the person's own when they reached their calls, else the hive's (a call given
        back in between reads as the hive's: it was the hive's ceiling that refused)."""
        if self.used(person, day) >= limit:
            return refused("free_inference_daily_cap", 429, retry_after=until_midnight_utc(), limit=limit)
        return refused("free_inference_hive_daily_cap", 429, retry_after=until_midnight_utc(), limit=hive_daily_cap())

    def release(self, ticket):
        """Give back one counted call that ended before it committed at the send boundary (Gateway.free_uncommitted), on the
        day it was counted, never below zero; the hive's count, a sum of the people's, follows."""
        if not ticket:
            return
        person, day = ticket
        with self.hive.db.transaction():
            self.hive.db.execute(f"UPDATE {TABLE} SET calls = calls - 1 WHERE person = ? AND day = ? AND calls > 0",
                                 (person, day))

    def used(self, person, day=None):
        row = self.hive.db.one(f"SELECT calls FROM {TABLE} WHERE person = ? AND day = ?", (person, day or period_start("day")))
        return int(row["calls"]) if row else 0

    def hive_used(self, day=None):
        row = self.hive.db.one(f"SELECT COALESCE(SUM(calls), 0) AS calls FROM {TABLE} WHERE day = ?",
                               (day or period_start("day"),))
        return int(row["calls"]) if row else 0
