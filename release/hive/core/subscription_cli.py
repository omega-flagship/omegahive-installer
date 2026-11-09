"""The owner's AI subscription as a model route: who may use it, and how much a day (CLI model route design R3, shape A;
the minimal slice of R3.1 §A/§F/§H and R3.2 §M).

A local bridge (OpenAI-compatible, literal loopback, bearer key) runs the owner's own signed-in CLI (any vendor's: nothing
here is specific to one). Each bridge is one instance of a family of providers (config.SUBSCRIPTIONS): today
``subscription-cli`` (HIVE_SUBSCRIPTION_CLI_URL / _KEY / _MODELS, the original, unchanged) and ``subscription-codex``
(HIVE_SUBSCRIPTION_CODEX_URL / _KEY / _MODELS), so a hive can run on a Claude subscription, a ChatGPT subscription or
any mix. config.py builds them from the environment only, never from the providers file, and refuses any other entry
aimed at any bridge (config.is_subscription is the one test every route uses). It is never ``Provider.local``: that flag means
on-machine for the local-only egress rule and local settlement, and a prompt sent here leaves the machine through the
CLI. Gateway.enforce_egress refuses it for every swarm in HIVE_LOCAL_ONLY_SWARMS.

SubscriptionGate.authorize is the one authority check. The gateway runs it at the estimate, again just before dispatch,
and again at the transport's send boundary (send_request_headers.started, after any awaited send gate), with the egress
rule, so a change of owner, swarm, visibility or policy while a call waits refuses it with nothing sent. Every link:

- where: the bridge address is literal loopback (config.literal_loopback_url, the local-only egress rule's own bar: a
  destination name such as localhost is a lookup, so it is refused), and the hive listens on loopback only (HIVE_HOST,
  127.0.0.1 by default, judged by localowner.LOOPBACK_BINDS, the hive's one rule for its own listen address). The
  hive's public URL is not the test: a hive bound to 127.0.0.1 and reached through a tunnel (Jon's Mac keeps
  HIVE_PUBLIC_URL at loopback and the tunnel host in HIVE_PUBLIC_BASE) qualifies, because what holds the route is the
  owner-and-caller chain below, checked on the server for every call, never who can reach the page. A hive listening on
  another address (a shared or cloud hive) never offers it (R3.1 §A);
- who owns it: the hive owner is a named person (ownhive.owner) and the stored mind is theirs;
- whose swarm: owner_scope, the ONE policy for "whose swarm counts as the owner's" (see there);
- who it is for: the trusted caller principal (the conductor's asker, the mind gateway's token principal) when the
  caller passes one, and always Hive.user_for(mind), must both be the owner, and no open Ask turn of anyone else's
  (a conducting turn included, which user_for does not read) may be on the mind.

Each instance's day dispatch attempts (UTC) are persisted atomically (subscription_cli_attempts, keyed by
(provider, day); an older day-only table is migrated in place, its rows becoming subscription-cli's) and capped by that
instance's <PREFIX>_DAILY_CALLS (default 500; 0 or an unreadable value admits none). Its opt-in swarms are
<PREFIX>_SWARMS. The owner chain below is the same for every instance. An attempt counts whether or not
it is answered, recorded or survives a restart, with one exception: a dispatch whose transport never connected
(ConnectError/ConnectTimeout before the send boundary, so not one byte can have reached the bridge) is released again,
atomically (SubscriptionGate.release). A bridge that is down also starts an in-process cooldown per instance
(BRIDGE_COOLDOWN_FIRST seconds, doubling to BRIDGE_COOLDOWN_MAX while it stays down): until it ends, the owner's calls on
that instance are refused 503 subscription_bridge_down before anything is counted or sent, so a retrying mind cannot
hammer a dead bridge or burn the day's cap on calls that never arrive.

Usage is recorded with its tokens at $0, payer the owner, payer_mode 'plan' (the owner's plan; it may draw on paid usage
credits if they turned them on, so it is never called free). Not here yet (open items): the owner-funded router policy,
the per-mind turn and token budget, and the full origin chain for goals (R3.1 §F).
"""

from __future__ import annotations

import json
import math
import os
import threading
import time

from .budgets import period_start
from .config import SUBSCRIPTION_CLI, is_subscription, literal_loopback_url, subscription_env
from .gateway import GatewayError
from .localowner import LOOPBACK_BINDS

PAYER_MODE = "plan"
DEFAULT_DAILY_CALLS = 500
BRIDGE_COOLDOWN_FIRST = 60.0    # seconds refused after the bridge is first found unreachable
BRIDGE_COOLDOWN_MAX = 600.0     # the longest cooldown while it stays unreachable

REFUSED = "This model runs on the hive owner's own plan; only the owner's own private minds may use it."


def daily_cap(provider=SUBSCRIPTION_CLI):
    """<PREFIX>_DAILY_CALLS (HIVE_SUBSCRIPTION_CLI_DAILY_CALLS for subscription-cli): dispatch attempts a day for that
    instance. Unreadable or negative admits none (closed); not a subscription instance admits none."""
    if not is_subscription(provider):
        return 0
    raw = subscription_env(provider, "DAILY_CALLS")
    if not raw:
        return DEFAULT_DAILY_CALLS
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def allowed_swarms(provider=SUBSCRIPTION_CLI):
    """<PREFIX>_SWARMS (HIVE_SUBSCRIPTION_CLI_SWARMS for subscription-cli; environment only, default none): a JSON list
    of swarm ids the owner opts in for that instance beyond their private swarms, parsed like HIVE_LOCAL_ONLY_SWARMS.
    Anything unreadable admits none."""
    raw = subscription_env(provider, "SWARMS")
    if not raw:
        return frozenset()
    try:
        value = json.loads(raw)
    except ValueError:
        return frozenset()
    if not isinstance(value, list) or not all(isinstance(s, str) and s for s in value):
        return frozenset()
    return frozenset(value)


def hive_bound_to_loopback():
    """The address the hive listens on (HIVE_HOST, as hive/__main__.py passes it to uvicorn): loopback only."""
    return os.environ.get("HIVE_HOST", "127.0.0.1").strip() in LOOPBACK_BINDS


def owner_scope(owner, mind, swarm, swarm_minds, allowed=None):
    """THE policy for whose swarm counts as the owner's. owner: the hive owner's principal; mind: the stored mind row;
    swarm: its stored swarm row; swarm_minds: the owners of every live mind in that swarm; allowed: the opted-in swarm
    ids (allowed_swarms() when None).

    Always: a named owner; the mind is theirs; the swarm exists, is not archived, and the owner created it or it is
    their personal swarm.
    - by default: the swarm is private, personal or not (a shared or public personal swarm is refused), and every live
      mind in it is the owner's;
    - opted in (its id in the instance's <PREFIX>_SWARMS): a swarm the owner created, whatever its visibility (for
      example Create's Code team, which the foundation makes public). The calling mind must still be the owner's, and
      who calls is still held to the owner by the caller checks.
    An owner-wide scope ("every mind the owner owns", on the owner's own hive) would be one more branch here, behind its
    own environment switch; no caller changes."""
    allowed = allowed_swarms() if allowed is None else allowed
    if not str(owner or "").startswith("user:u_") or not mind or not swarm:
        return False
    if mind.get("owner") != owner or swarm.get("archived_at"):
        return False
    created = swarm.get("owner") == owner
    if swarm.get("id") in allowed:
        return created
    private = (swarm.get("visibility") or "public") == "private"
    theirs = created or swarm.get("personal_of") == owner
    return private and theirs and bool(swarm_minds) and all(o == owner for o in swarm_minds)


TABLE = "subscription_cli_attempts"


def migrate_attempts(db):
    """subscription_cli_attempts keyed by (provider, day). A table from before the family (day TEXT PRIMARY KEY) is
    rebuilt in one transaction (BEGIN IMMEDIATE: another process opening the same hive waits, then sees it done), its
    rows kept as subscription-cli's, so no day's count is lost or reset. Idempotent."""
    def legacy():
        cols = {c["name"] for c in db.all(f"PRAGMA table_info({TABLE})")}
        return bool(cols) and "provider" not in cols
    if legacy():
        with db.transaction():
            if legacy():
                db.execute(f"ALTER TABLE {TABLE} RENAME TO {TABLE}_day_only")
                db.execute(SubscriptionGate.SCHEMA)
                db.execute(f"INSERT INTO {TABLE} (provider, day, calls) SELECT ?, day, calls FROM {TABLE}_day_only",
                           (SUBSCRIPTION_CLI,))
                db.execute(f"DROP TABLE {TABLE}_day_only")
    db.execute(SubscriptionGate.SCHEMA)


class SubscriptionGate:
    """One gate for every subscription instance: provider names which one (subscription-cli by default, so a caller of
    the single-instance shape is unchanged). The chain is the same for each; the bridge, the cap and the opt-in swarms
    are the instance's own."""
    SCHEMA = (f"CREATE TABLE IF NOT EXISTS {TABLE} (provider TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL, "
              "PRIMARY KEY (provider, day))")

    def __init__(self, hive, clock=time.monotonic):
        self.hive = hive
        self.clock = clock
        self._down = {}   # provider -> (cooldown ends at, consecutive strikes); in-process only, never persisted
        self._down_lock = threading.Lock()
        migrate_attempts(hive.db)

    def admit(self, agent, principal=None, dispatch=False, provider=SUBSCRIPTION_CLI):
        """authorize, then the instance's bridge cooldown, then its day cap: dispatch=True records this attempt
        (atomically, refused past the cap) and returns its ticket (the day it was counted on, for release); False only
        checks there is room."""
        self.authorize(agent, principal, preview=not dispatch, provider=provider)
        self._bridge_check(provider)
        return self._attempt(dispatch, provider)

    def release(self, provider, ticket):
        """Undo one counted attempt that never reached the bridge (Gateway.subscription_transport_failed): the same
        transaction style as the counter, on the day it was counted, never below zero."""
        if not ticket:
            return
        db = self.hive.db
        with db.transaction():
            db.execute(f"UPDATE {TABLE} SET calls = calls - 1 WHERE provider = ? AND day = ? AND calls > 0",
                       (provider, ticket))

    def bridge_down(self, provider):
        """The bridge could not be reached: refuse this instance for a cooldown. A failure while a cooldown is already
        running (calls that were in flight together) does not lengthen it; one after it ended doubles it, to the max."""
        with self._down_lock:
            now = self.clock()
            until, strikes = self._down.get(provider, (0.0, 0))
            if now < until:
                return
            strikes += 1
            self._down[provider] = (now + min(BRIDGE_COOLDOWN_FIRST * 2 ** min(strikes - 1, 16), BRIDGE_COOLDOWN_MAX), strikes)

    def bridge_up(self, provider):
        """The bridge was reached: no cooldown, and the next failure starts from the first step again."""
        with self._down_lock:
            self._down.pop(provider, None)

    def bridge_cooldown(self, provider=SUBSCRIPTION_CLI):
        """Seconds left in this instance's cooldown (0 when none)."""
        with self._down_lock:
            until, _ = self._down.get(provider, (0.0, 0))
        return max(0.0, until - self.clock())

    def _bridge_check(self, provider):
        left = self.bridge_cooldown(provider)
        if left > 0:
            raise GatewayError(503, "subscription_bridge_down",
                               f"The plan's local bridge is not reachable; calls on it resume in {math.ceil(left)} s.")

    def authorize(self, agent, principal=None, preview=False, provider=SUBSCRIPTION_CLI):
        """Raise GatewayError unless this call may use the owner's subscription (instance `provider`) now. The refusal
        never says which link failed, nor who the owner is."""
        try:
            allowed = is_subscription(provider) and (
                self._preview(agent, principal, provider) if preview and isinstance(agent, dict) and agent.get("id") == ""
                and agent.get("_foundation_preview") is True else self._chain(agent, principal, provider))
        except Exception:   # noqa: BLE001  (anything unreadable is a refusal, never an admission)
            allowed = False
        if not allowed:
            raise GatewayError(403, "subscription_owner_only", REFUSED)

    def _chain(self, agent, principal, provider_name=SUBSCRIPTION_CLI):
        hive = self.hive
        if not isinstance(agent, dict) or not agent.get("id"):
            return False
        provider = hive.settings.providers.get(provider_name)
        if provider is None or provider.local or not literal_loopback_url(provider.base_url) or not hive_bound_to_loopback():
            return False
        owner = hive.ownhive.owner()
        if not str(owner or "").startswith("user:u_"):
            return False
        if principal is not None and principal != owner:
            return False
        # the stored row, never the caller's copy (a stale copy could name another swarm than egress was checked for)
        mind = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent["id"],))
        if mind is None or not mind.get("swarm_id") or agent.get("swarm_id") != mind["swarm_id"]:
            return False
        swarm = hive.db.one("SELECT * FROM swarms WHERE id = ?", (mind["swarm_id"],))
        minds = [r["owner"] for r in hive.db.all("SELECT owner FROM agents WHERE swarm_id = ? AND deleted = 0",
                                                 (mind["swarm_id"],))]
        if not owner_scope(owner, mind, swarm, minds, allowed_swarms(provider_name)):
            return False
        if hive.user_for(mind) != owner:
            return False
        from .ask import OPEN, states_sql   # every open turn: conducting and browser included (user_for reads fewer)
        others = hive.db.one(f"SELECT COUNT(*) AS n FROM ask_turns WHERE mind_id = ? AND state IN {states_sql(OPEN)} "
                             "AND principal != ?", (mind["id"], owner))
        return not (others and others["n"])

    def _preview(self, agent, principal, provider_name=SUBSCRIPTION_CLI):
        """A not-yet-made Foundation helper (id "", marked _foundation_preview) for a settlement preview only: never a
        dispatch (admit(dispatch=True) never takes this branch, and the real child's call goes through _chain with its
        stored row). Same owner, provider and swarm links as _chain; the caller must name the owner."""
        hive = self.hive
        provider = hive.settings.providers.get(provider_name)
        if provider is None or provider.local or not literal_loopback_url(provider.base_url) or not hive_bound_to_loopback():
            return False
        owner = hive.ownhive.owner()
        if not str(owner or "").startswith("user:u_") or principal != owner or agent.get("owner") != owner:
            return False
        swarm = hive.db.one("SELECT * FROM swarms WHERE id = ?", (agent.get("swarm_id"),))
        minds = [r["owner"] for r in hive.db.all("SELECT owner FROM agents WHERE swarm_id = ? AND deleted = 0",
                                                 (agent.get("swarm_id"),))] + [owner]
        return owner_scope(owner, agent, swarm, minds, allowed_swarms(provider_name))

    def attempts_today(self, provider=SUBSCRIPTION_CLI):
        row = self.hive.db.one(f"SELECT calls FROM {TABLE} WHERE provider = ? AND day = ?", (provider, period_start("day")))
        return int(row["calls"]) if row else 0

    def _attempt(self, dispatch, provider=SUBSCRIPTION_CLI):
        limit, day = daily_cap(provider), period_start("day")
        full = GatewayError(429, "subscription_daily_cap",
                            "This plan route has reached its call limit for today; it resets at midnight UTC.")
        if not dispatch:
            if self.attempts_today(provider) >= limit:
                raise full
            return None
        db = self.hive.db
        with db.transaction():   # one statement pair under the connection lock; SQLite makes it atomic across processes
            db.execute(f"INSERT OR IGNORE INTO {TABLE} (provider, day, calls) VALUES (?, ?, 0)", (provider, day))
            counted = db.execute(f"UPDATE {TABLE} SET calls = calls + 1 WHERE provider = ? AND day = ? AND calls < ?",
                                 (provider, day, limit)).rowcount
        if counted != 1:
            raise full
        return day
