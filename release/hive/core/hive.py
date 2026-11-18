# Purpose: the hive's service layer: minds, teams, messages, beliefs, and the usage each paid call records.
"""The Hive service layer: agents, swarms, messages, beliefs, usage."""

from __future__ import annotations

import logging
import asyncio
import collections
import hashlib
import contextlib
import json
import datetime
import itertools
import os
import pathlib
import random
import re
import secrets
import sqlite3
import stat
import time
import threading
from functools import wraps

from ..spaces import beliefs as linked_beliefs, sexpr
from ..spaces.service import SpaceService
from .config import FREE, Settings
from .db import Database, latest_stamp, new_id, now, parse_stamp
from .health import HEALTH_QUESTION, HEALTH_QUESTION_TAG, HEALTH_SENDER, for_people
from .events import EventBus
from .goals import Goals
from .lab import Lab
from .shares import Shares
from .programs import Programs
from .budgets import Budgets
from .services import Services
from .roles import Roles
from .mcp import Harnesses
from .policy import Policy
from .providers import clean_options
from .schedule import Scheduler

log = logging.getLogger("hive")
SEND_TIMEOUT = 30      # seconds a hub send may take before it counts as failed (the socket is then ended)
CLOSE_TIMEOUT = 5
_HEALTH_FALLBACK_LOGGED: set[str] = set()   # message ids whose unreadable extra was logged (Hive._health_question)

AGENT_KINDS = {"omega", "iter", "module"}
EDITABLE = {"name", "swarm_id", "model", "persona", "hue", "budget_usd", "idle_sleep_minutes", "options", "driver"}


TRACE_TEXT_MAX = 16000   # per command and per result in a trace; longer text is cut and marked (sha256 of the whole)


class HiveError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def token_hash(token):
    return hashlib.sha256(str(token).encode()).hexdigest()


class Admission:
    """A hub admission: the mind and the lifecycle generation seen before the socket was accepted (always truthy).
    It authorises nothing by itself; Hive._register_connection re-checks it after the accept."""
    __slots__ = ("agent_id", "generation")

    def __init__(self, agent_id, generation):
        self.agent_id, self.generation = agent_id, generation

    def __repr__(self):
        return f"Admission({self.agent_id!r}, generation={self.generation!r})"

def serialized_tools_choices(function):
    @wraps(function)
    def wrapped(self, *args, **kwargs):
        # One scratch-hive control plane: concurrent choices cannot admit two
        # synthetic minds between checking the cap and storing their options.
        with self._tools_choices_lock:
            return function(self, *args, **kwargs)
    return wrapped


class Hive:
    def __init__(self, settings: Settings, supervisor=None):
        self.settings = settings
        self._tools_choices_lock = threading.RLock()
        # The per-swarm fence (Platform ruling on 94b5cff): a delete or restore holds its swarm; membership writes
        # (create, join, move in or out, start) count themselves in. Neither waits: whichever comes second gets 409.
        self._swarm_ops, self._swarm_writers, self._swarm_ops_lock = {}, collections.Counter(), threading.Lock()
        self._own_mind_locks: dict[str, threading.RLock] = {}
        self.db = Database(settings.data_dir / "hive.db")
        self.spaces = SpaceService(settings.data_dir / "spaces", petta_path=settings.petta_path)
        self.events = EventBus()
        self.supervisor = supervisor
        self.connections: dict[str, object] = {}  # agent_id -> hub websocket
        # A principal's current role ("admin", "member", or None when no current person holds it), which create_app wires
        # to its role_of. Until it is wired, no mind's publishing adds words to a swarm's vocabulary (grows_vocabulary).
        self.person_role = None
        # agent_id -> (its hub websocket, the highest hub_seq sent on it, None until that socket's resume is answered).
        # The channel keeps last_seen_seq as a high-water mark and drops a seq at or below it (hive_channel.py,
        # _Daemon.deliver), so a socket gets the mind's stored messages in hub_seq order, each once (upstream #18/#21).
        self.sent_upto: dict[str, tuple[object, int | None]] = {}
        # agent_id -> one lock: a socket's flushes run one at a time, each send completing (or failing and ending the
        # socket's live delivery) before the next flush reads the mark (review r1.1 P1: an in-flight send that later
        # failed could be overtaken by a concurrent flush's successful newer send, and lost)
        self.flush_locks: dict[str, asyncio.Lock] = {}
        self._closing: set[asyncio.Task] = set()   # background closes of sockets whose send was cancelled
        self.boot_generation: dict[str, int] = {}  # agent_id -> connections since the hive started
        self.boot_nonce: dict[str, str] = {}       # agent_id -> nonce of its current connection
        self.name = "OmegaHive"
        self.policy = Policy(self)
        self.goals = Goals(self)
        self.scheduler = Scheduler(self)
        self.lab = Lab(self)
        self.shares = Shares(self)
        self.programs = Programs(self)
        from .person_swarms import PersonSwarms
        self.person_swarms = PersonSwarms(self)   # app platform P2: person-owned swarms from an app's reviewed template
        self.budgets = Budgets(self)
        # A mind whose soft delete committed but whose cleanup (spaces, events) has not finished: retried, idempotently.
        # released: the goal ids whose goal.updated is still to be published (stand-in r4 P2). generation: the mind's
        # deletion generation this record belongs to (stand-in r6): it acts only while the mind is still deleted at that
        # generation. The step flags record what is done, so a retry runs only what is left (agent.deleted once).
        self.db.execute("CREATE TABLE IF NOT EXISTS mind_cleanup (agent_id TEXT PRIMARY KEY, swarm_id TEXT, "
                        "created_at TEXT NOT NULL, released TEXT NOT NULL DEFAULT '[]')")
        have = {r["name"] for r in self.db.all("PRAGMA table_info(mind_cleanup)")}
        for column, ddl in (("released", "TEXT NOT NULL DEFAULT '[]'"), ("generation", "INTEGER NOT NULL DEFAULT 0"),
                            ("announce", "INTEGER NOT NULL DEFAULT 1"), ("spaces_revoked", "INTEGER NOT NULL DEFAULT 0"),
                            ("agent_deleted_published", "INTEGER NOT NULL DEFAULT 0"),
                            ("swarm_announced", "INTEGER NOT NULL DEFAULT 0"), ("coffee_synced", "INTEGER NOT NULL DEFAULT 0")):
            if column not in have:
                self.db.execute(f"ALTER TABLE mind_cleanup ADD COLUMN {column} {ddl}")
        # team rooms (rooms.py) read a swarm's minds on every mind change
        self.db.execute("CREATE INDEX IF NOT EXISTS agents_swarm ON agents(swarm_id)")
        if "deletion_gen" not in {r["name"] for r in self.db.all("PRAGMA table_info(agents)")}:
            self.db.execute("ALTER TABLE agents ADD COLUMN deletion_gen INTEGER NOT NULL DEFAULT 0")
        columns = {r["name"] for r in self.db.all("PRAGMA table_info(swarms)")}
        for column in ("coordinator_id", "parent_mind_id", "archived_at", "archived_by"):
            if column not in columns:
                self.db.execute(f"ALTER TABLE swarms ADD COLUMN {column} TEXT")
        self.refusals = {}  # agent_id -> {count, last_at, code, message}: model calls refused for spending
        self.slowed = {}  # agent_id -> until: paid calls the spend-rate guard is pacing (spend_rate_refusal)
        from .visibility import Visibility
        self.visibility = Visibility(self)
        from .personal import PersonalMinds
        self.personal = PersonalMinds(self)   # one personal mind per named person (personal.py)
        from .ownhive import OwnHive
        self.ownhive = OwnHive(self)   # own hive H1: the owner, limits on your own keys, pays, use invites (ownhive.py)
        from .personal_inbox import PersonalInbox
        self.personal_inbox = PersonalInbox(self)   # swarm-answered exchanges held only until the person's browser collects them
        from .motivations import Motivations
        self.motivations = Motivations(self)
        from .health import Health
        self.health = Health(self)
        from .program_actions import ProgramActions
        self.program_actions = ProgramActions(self)
        from .app_drafts import AppDrafts
        self.app_drafts = AppDrafts(self)
        from .feedback import Feedback
        self.feedback = Feedback(self, self.settings.feedback_to)   # feedback and bug reports: destination, errors (feedback.py)
        from .feedback_drafts import FeedbackDrafts
        self.feedback_drafts = FeedbackDrafts(self)   # minds' draft reports, waiting for their person (feedback_drafts.py)
        from .program_attachments import ProgramAttachments
        self.app_attachments = ProgramAttachments(self)
        from .collab import Collab
        self.collab = Collab(self)
        from .flows import Flows
        self.flows = Flows(self)
        from .connections import Connections
        self.agreements = Connections(self)  # connection agreements between swarms (not hub websockets)
        from .delegation import Delegation
        self.delegation = Delegation(self)
        from .assets import Assets
        from .archive import Archive
        self.assets = Assets(self)
        self.archive = Archive(self)
        from .rooms import Rooms
        self.rooms = Rooms(self)
        from .throughput import Throughput
        self.throughput = Throughput(self)   # how many messages minds may send each other (per mind, per swarm)
        from .sessions import Sessions
        self.sessions = Sessions(self)
        from .ask import Ask
        self.ask = Ask(self)
        from .app_ask import AppAsk
        self.app_ask = AppAsk(self)   # P1 metadata/leases; the existing Ask remains the only turn authority
        from .app_links import AppLinks
        self.app_links = AppLinks(self)   # P12/P13 host metadata, confirmations and one-use entry
        from .person_apps import PersonApps
        self.person_apps = PersonApps(self)   # P14: install review, each person's own app context, ready on first open
        from .notices import Notices
        self.notices = Notices(self)   # G2: a person's own minds may notify them, within the budget the person sets
        from .replies import Replies
        self.replies = Replies(self)   # a person's message to a mind is answered, or they are told it stopped
        from .stage import Stage
        self.stage = Stage(self)   # a mind's Show, Recall or Compare, to the one person its turn answers
        from .me_spend import MeSpend
        self.me_spend = MeSpend(self)   # G4: a person's own spend per day, read from the usage rows
        from .governance_evidence import GovernanceEvidence
        self.governance = GovernanceEvidence(self)
        from .mindgateway_evidence import MindGatewayEvidence
        self.mindgateway = MindGatewayEvidence(self)   # gateway r1e: advisory, write-only; off unless HIVE_MIND_GATEWAY=1
        from .placement import Placement
        self.placement = Placement(self)
        from .person_requests import PersonRequests
        self.person_requests = PersonRequests(self)
        from .limit_notices import LimitNotices
        self.limit_notices = LimitNotices(self)   # 50, 80 and 100% of each allowance and the hive cap, once a month
        from .updates import Updates
        self.updates = Updates(self)
        from .explore import Explorer
        self.explorer = Explorer(self)
        self.services = Services(self)
        self.roles = Roles(self)
        self.harnesses = Harnesses(self)
        from .inventory import Inventory
        self.inventory = Inventory(self)
        from .power import Power
        self.power = Power(self)
        from .minds import Minds
        self.minds = Minds(self)   # mind control r2.12/r2.13: children a team's controller runs under a person's lease
        from .proposal_tests import ProposalTests
        self.proposal_tests = ProposalTests(self)   # linkage slice 4 (r3.6 §b): proposal-test claims, bind, holds, settlement
        from .code_controller_engine import CodeControllerEngine
        self.code_controller = CodeControllerEngine(self)   # Create - Code: the MeTTa reducer drives each Code request
        from .create_plan_engine import CreatePlanEngine
        self.create_plans = CreatePlanEngine(self)   # Create plans: the MeTTa plan controller R4.0 drives each plan
        from .create_offers import CreateOffers
        self.create_offers = CreateOffers(self)   # a mind's hive-create: an offer its person starts in Create, or not
        from .repomap import RepoMaps
        self.repo_maps = RepoMaps(self)   # repo-map/1 Slice A: admin-loaded, read-only repository maps (repomap.py)
        from .credentials import Credentials
        self.credentials = Credentials(self)   # session onboarding R2.8: host-issued bridged-session credentials (credentials.py)
        self.newhive = None   # new-hive R1a (newhive.py): set by create_app only on a marked new installation
        self.last_llm = {}  # agent_id -> (latency_ms, tokens) of its latest model call
        self.llm_calls = {}  # agent_id -> monotonic times of its calls in the last minute
        # Each mind's beliefs reach its swarm's view from its own last save (the linked beliefs section below).
        self._held_lock = threading.Lock()   # guards the three below, and is never held while the database is used
        self._held_keys = {}   # agent_id -> (inode, size, mtime) of the beliefs file its linked space was loaded from
        self._held_tickets = itertools.count(1)   # one per load started and per unload
        self._held_floor = {}   # agent_id -> ticket of its last mount or unload: a load started before it mounts nothing
        self.link_all()

    # ---- serialisation ---------------------------------------------------------------

    def agent_view(self, row, guard=True):
        if guard and getattr(self, "person_swarms", None) is not None:
            row = self.person_swarms.read_row(row)
        return {
            "id": row["id"], "name": row["name"], "kind": row["kind"], "swarm_id": row["swarm_id"],
            "model": row["model"], "persona": row["persona"], "hue": row["hue"],
            "status": row["status"], "driver": row["driver"],
            "budget_usd": row["budget_usd"], "spent_usd": round(row["spent_usd"], 6),
            "connected": row["id"] in self.connections,
            "idle_sleep_minutes": row.get("idle_sleep_minutes") or 0,
            "options": json.loads(row["options"]) if row.get("options") else {},
            "role_id": row.get("role_id"),
            "role_prompt": self.roles.prompt_for(row) if getattr(self, "roles", None) else "",
            "last_error": row.get("last_error"),
            "owner": row.get("owner"), "visibility": row.get("visibility") or "public", "pays": row.get("pays") or "own-key",
            # a person's own mind (personal.py), told by its prompt that it is alone; never whose (personal_of)
            "personal": bool(row.get("personal_of")),
            "shared_with": json.loads(row.get("shared_with") or "[]"),
            # the owner's link setting (set_belief_link), so a page keys its read of GET belief-link on agent events
            "belief_link": json.loads(row["belief_link"]) if row.get("belief_link") is not None else None,
            "last_active_at": row["last_active_at"], "last_input_at": row.get("last_input_at"), "created_at": row["created_at"],
            "moved_to": row.get("moved_to"), "moved_to_name": row.get("moved_to_name"), "moved_at": row.get("moved_at"),
            "throughput": self.throughput.mind_view(row["id"]) if getattr(self, "throughput", None) else None,
        }

    def swarm_view(self, row):
        members = [m["id"] for m in self.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0 ORDER BY created_at", (row["id"],))]
        if getattr(self, "person_swarms", None) is not None:
            for agent_id in members:
                self.person_swarms.read_row(self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,)))
        coordinator = row.get("coordinator_id") if row.get("coordinator_id") in members else None
        parent = self.db.one("SELECT swarm_id FROM agents WHERE id = ? AND deleted = 0", (row["parent_mind_id"],)) if row.get("parent_mind_id") else None
        children = [r["id"] for r in self.db.all("SELECT id FROM swarms WHERE parent_mind_id IN (SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0)", (row["id"],))] if members else []
        services = self.db.one("SELECT kinds FROM swarm_services WHERE swarm_id = ?", (row["id"],)) if self.db.one("SELECT name FROM sqlite_master WHERE name = 'swarm_services'") else None
        return dict(row, shared_with=json.loads(row.get("shared_with") or "[]"), visibility=row.get("visibility") or "public",
                    member_ids=members, coordinator_id=coordinator, parent_mind_id=row.get("parent_mind_id") if parent else None,
                    parent_swarm_id=parent["swarm_id"] if parent else None, child_swarm_ids=children,
                    services=json.loads(services["kinds"]) if services else [],
                    throughput=self.throughput.swarm_view(row["id"]) if getattr(self, "throughput", None) else None)

    def update_swarm(self, swarm_id, data, *, _defer_events=False):
        """Name, description, the coordinating mind (a member) and the parent mind (a mind elsewhere that contains
        this swarm: the holarchy). Nesting never cycles and is at most four levels deep. Fenced (stand-in r3): held
        under this swarm's and the parent mind's swarm's membership fence, so a rename or attach never lands mid
        delete or restore (409 swarm_busy), and validated inside it."""
        pid = data.get("parent_mind_id") if "parent_mind_id" in data else None
        parent = self.db.one("SELECT swarm_id FROM agents WHERE id = ? AND deleted = 0", (pid,)) if pid else None
        with self.swarm_membership(swarm_id, (parent or {}).get("swarm_id")):
            return self._update_swarm_fenced(swarm_id, data, (parent or {}).get("swarm_id"),
                                             _defer_events=_defer_events)

    def _update_swarm_fenced(self, swarm_id, data, fenced_parent_swarm, *, _defer_events=False):
        row = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if row is None:
            raise HiveError(404, "not_found", "no such swarm")
        values = {}
        if "name" in data:
            if not str(data["name"]).strip():
                raise HiveError(400, "bad_request", "name is required")
            values["name"] = str(data["name"]).strip()[:80]
        if "description" in data:
            values["description"] = str(data["description"] or "")[:2000]
        if "coordinator_id" in data:
            cid = data["coordinator_id"]
            if cid and not self.db.one("SELECT 1 FROM agents WHERE id = ? AND swarm_id = ? AND deleted = 0", (cid, swarm_id)):
                raise HiveError(400, "bad_coordinator", "the coordinator must be a mind in this swarm")
            values["coordinator_id"] = cid or None
        if "parent_mind_id" in data:
            pid = data["parent_mind_id"]
            if pid:
                mind = self.db.one("SELECT swarm_id FROM agents WHERE id = ? AND deleted = 0", (pid,))
                if mind is None or mind["swarm_id"] == swarm_id:
                    raise HiveError(400, "bad_parent", "the parent is a mind in another swarm")
                if mind["swarm_id"] != fenced_parent_swarm:   # it moved between the read and the fence: read again
                    raise HiveError(409, "parent_moved", "the parent mind moved meanwhile; try again")
                depth, at = 1, mind["swarm_id"]
                while at:
                    if at == swarm_id:
                        raise HiveError(400, "nesting_cycle", "that would put this swarm inside itself")
                    depth += 1
                    if depth > 4:
                        raise HiveError(400, "too_deep", "swarms nest at most four levels")
                    up = self.db.one("SELECT parent_mind_id FROM swarms WHERE id = ?", (at,))
                    nxt = self.db.one("SELECT swarm_id FROM agents WHERE id = ?", (up["parent_mind_id"],)) if up and up["parent_mind_id"] else None
                    at = nxt["swarm_id"] if nxt else None
            values["parent_mind_id"] = pid or None
        if values:
            sets = ", ".join(f"{k} = ?" for k in values)
            sql, params = f"UPDATE swarms SET {sets} WHERE id = ?", [*values.values(), swarm_id]
            if values.get("parent_mind_id"):   # the parent is still a live mind in the swarm validated, in this statement
                sql += " AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted = 0 AND swarm_id IS ?)"
                params += [values["parent_mind_id"], fenced_parent_swarm]
            if self.db.execute(sql, params).rowcount != 1:
                if not self.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)):
                    raise HiveError(404, "not_found", "no such swarm")
                raise HiveError(409, "parent_moved", "the parent mind moved or was deleted meanwhile; try again")
        swarm = self.swarm(swarm_id)
        if _defer_events:
            # Foundation encloses this mutation in its binding transaction. Both
            # the notice and room work wait for its outermost durable commit.
            def notify():
                self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
                if "name" in values:
                    self._team_sync(swarm_id)
            self.db.after_commit(notify)
        else:
            self.events.publish("swarm.updated", swarm=swarm)
            if "name" in values:
                self._team_sync(swarm_id)    # its team room is named after it
        return swarm

    def _agent_row(self, agent_id, guard=True):
        row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if row is None:
            raise HiveError(404, "not_found", "no such agent")
        return self.person_swarms.read_row(row) if guard and getattr(self, "person_swarms", None) is not None else row

    def agent(self, agent_id):
        return self.agent_view(self._agent_row(agent_id))

    def emit_agent(self, agent_id):
        self.events.publish("agent.updated", agent=self.agent(agent_id))

    # ---- hive ----------------------------------------------------------------------------

    def summary(self, viewer=None):
        """The hive's figures; its belief count, for a person, holds only the swarms they may see, as the beliefs
        routes refuse the rest (Visibility.check_path), and an admin's leaves out what their views hide unaudited."""
        agents = self.db.all("SELECT status, spent_usd FROM agents WHERE deleted = 0")
        swarms = self.db.all("SELECT * FROM swarms")
        hidden = self.visibility.hidden_ids(viewer)
        beliefs = sum(self.belief_count(s["id"], viewer) for s in swarms
                      if viewer is None or (viewer.sees(dict(s)) and s["id"] not in hidden))
        return {
            "name": self.name, "version": "0.1.0", "agents": len(agents), "swarms": len(swarms),
            "awake": sum(1 for a in agents if a["status"] == "awake"), "beliefs": beliefs,
            "spent_usd": round(sum(a["spent_usd"] for a in agents), 6),
            "limits": {"goal_lease_minutes": self.settings.goal_lease_minutes,
                       "hive_budget_usd": self.budgets.hard_cap(),   # the cap in force: 0 once the hive has a total
                       "max_llm_calls_per_minute": self.settings.max_llm_calls_per_minute},
        }

    def model_catalog(self):
        """The operator-configured model ids, whether or not a key is set: every configured provider's models as
        <provider>/<model> (the source models() offers). The only model names the gateway evidence may publish (its
        model_symbol); any other value is published as other-model. The fetched OpenRouter catalogue is deliberately
        not part of it (r1e.2): its ids come off the network, so they are never a naming source."""
        return frozenset(f"{p.name}/{m}" for p in self.settings.providers.values() for m in p.models)

    def models(self, can_pay=None):
        """can_pay(provider) (keyview R9): for a caller who may not see every key, whether THEY could pay with that
        provider; None: the hive-wide view (an admin, or no caller)."""
        out = []
        for provider in self.settings.providers.values():
            store = getattr(self, "providers", None)
            has_key = bool(provider.api_key) or (store is not None and any(
                r["provider"] == provider.name for r in store.ring["keys"].values()))
            if can_pay is not None and not provider.local and provider.name != "mock":
                has_key = can_pay(provider.name)
            if provider.name != "mock" and not provider.local and not has_key:
                continue
            for model in provider.models:
                out.append({"id": f"{provider.name}/{model}", "provider": provider.name,
                            "label": model, "local": provider.local})
        return out

    # ---- swarms -----------------------------------------------------------------------------

    def swarms(self):
        return [self.swarm_view(r) for r in self.db.all("SELECT * FROM swarms ORDER BY created_at")]

    def swarm(self, swarm_id):
        row = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if row is None:
            raise HiveError(404, "not_found", "no such swarm")
        return self.swarm_view(row)

    def _visibility_fields(self, owner, visibility, shared_with):
        from .visibility import clean
        try:
            visibility, people = clean(visibility or "private", shared_with)
        except ValueError as exc:
            raise HiveError(400, "bad_visibility", str(exc)) from None
        return {"owner": owner or "user:operator", "visibility": visibility, "shared_with": json.dumps(people)}

    # The swarm must EXIST and be unarchived (Kimi K1 on 065e22d): "no archived row" was also true of a swarm deleted, or
    # never there, so a write could land in a swarm that delete-with-minds had just removed.
    OPEN_SWARM_SQL = "EXISTS (SELECT 1 FROM swarms WHERE id = ? AND archived_at IS NULL)"

    def insert_into_open_swarm(self, table, row, swarm_id):
        """Insert while the swarm is open. Every agent insert reserves its namespace under the existing DB guard."""
        with self.swarm_membership(swarm_id), (self.db.transaction() if table == "agents" else contextlib.nullcontext()):
            if table == "agents":
                self.placement._check_workspace_namespace(row["id"], self.settings.agents_dir / row["id"])
                if self.db.one("SELECT 1 FROM agents WHERE id = ?", (row["id"],)):
                    raise HiveError(409, "workspace_identity_conflict", "another mind already owns this identity; try again")
            if swarm_id is None:
                self.db.insert(table, row)
                return
            cols, marks = ", ".join(row), ", ".join("?" for _ in row)
            cur = self.db.execute(f"INSERT INTO {table} ({cols}) SELECT {marks} WHERE {self.OPEN_SWARM_SQL}",
                                  (*row.values(), swarm_id))
            if cur.rowcount != 1:
                self.refuse_closed_swarm(swarm_id)

    def update_in_open_swarm(self, table, key, values, swarm_id, expect=None):
        """db.update, but only while swarm_id exists and is not archived, in the same statement. expect: the row's
        fields as the caller judged them (e.g. placement: source swarm, moved_to, deleted). The fences are taken on
        the target and on that source, then the row is read again and the write requires those fields unchanged, so
        the source swarm's fence cannot be bypassed by a stale read (409 placement_stale)."""
        sets = ", ".join(f"{k} = ?" for k in values)
        expect = dict(expect or {})
        source = expect.get("swarm_id") if "swarm_id" in expect else None
        with self.swarm_membership(swarm_id, source):
            if expect:
                now_row = self.db.one(f"SELECT * FROM {table} WHERE id = ?", (key,))
                if now_row is None or any(now_row.get(k) != v for k, v in expect.items()):
                    raise HiveError(409, "placement_stale", "this mind changed meanwhile; try again")
            cond = "".join(f" AND {k} IS ?" for k in expect)
            cur = self.db.execute(f"UPDATE {table} SET {sets} WHERE id = ?{cond} AND {self.OPEN_SWARM_SQL}",
                                  (*values.values(), key, *expect.values(), swarm_id))
        if cur.rowcount != 1:
            if expect:
                now_row = self.db.one(f"SELECT * FROM {table} WHERE id = ?", (key,))
                if now_row is None or any(now_row.get(k) != v for k, v in expect.items()):
                    raise HiveError(409, "placement_stale", "this mind changed meanwhile; try again")
            self.refuse_closed_swarm(swarm_id)

    def refuse_closed_swarm(self, swarm_id):
        """The refusal after a guarded write did not land: archived (409, named) or gone (404)."""
        self.require_open_swarm(swarm_id)
        if not self.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)):
            raise HiveError(404, "not_found", "that swarm no longer exists")
        raise HiveError(409, "swarm_archived", "that swarm was archived")

    def require_open_swarm(self, swarm_id):
        """An archived swarm is retired: nothing new starts, joins or is asked of it there (Kimi 2026-10-05)."""
        if swarm_id:
            with self._swarm_ops_lock:   # mid delete or restore, say so first: the fenced write would refuse anyway
                if self._swarm_ops.get(swarm_id, threading.get_ident()) != threading.get_ident():
                    raise self.error(409, "swarm_busy", "this swarm is being deleted or restored right now; try again shortly")
        row = self.db.one("SELECT name, archived_at FROM swarms WHERE id = ?", (swarm_id,)) if swarm_id else None
        if row and row.get("archived_at"):
            raise HiveError(409, "swarm_archived", f"{row['name']} is archived; restore it first")

    def archive_swarm(self, swarm_id, by):
        """Retire a swarm that has history: hidden from lists, nothing deleted, restorable. Refused while any of its minds
        is awake, so archiving never strands running work (Jon 2026-10-05: retire the old Apps local swarm)."""
        self.swarm(swarm_id)
        with self.db.transaction():   # the busy check and the archive commit together: no mind can start in between
            busy = self.db.all("SELECT name FROM agents WHERE swarm_id = ? AND deleted = 0 AND kind != 'module' "
                               "AND (status IN ('awake', 'starting') OR desired = 'awake')", (swarm_id,))
            if busy:
                raise self.error(409, "swarm_busy", "stop or move these minds first: " + ", ".join(r["name"] for r in busy))
            # Work already running keeps writing even after the door closes: finish or cancel it first (Kimi round 3).
            self._refuse_live_flow(swarm_id)
            self.db.execute("UPDATE swarms SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL",
                            (now(), by, swarm_id))
        self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
        return self.swarm(swarm_id)

    def _refuse_live_flow(self, swarm_id):
        if self._live_flow(swarm_id):
            raise self.error(409, "swarm_busy", "a flow is still running here; let it finish or cancel it first")

    def _live_flow(self, swarm_id):
        has_flows = self.db.one("SELECT name FROM sqlite_master WHERE name = 'flow_runs'")
        # A run counts only while one of its step goals is still live, so a wedged 'running' row whose work has all
        # ended cannot make a swarm unarchivable (Kimi 2026-10-05).
        return bool(has_flows and self.db.one(
                "SELECT 1 FROM flow_runs r WHERE r.swarm_id = ? AND r.status = 'running' AND (NOT EXISTS "
                "(SELECT 1 FROM flow_steps s WHERE s.run_id = r.id) OR EXISTS (SELECT 1 FROM flow_steps s JOIN goals g "
                "ON g.id = s.goal_id WHERE s.run_id = r.id AND g.status NOT IN ('done', 'failed', 'cancelled'))) LIMIT 1",
                (swarm_id,)))

    @contextlib.contextmanager
    def _swarm_operation(self, swarm_id):
        """One structural operation per swarm at a time (delete, delete with minds, restore), held for the whole of it,
        and the fence for its membership: while it is held, every create, join, move in or out and start there is
        refused (409 swarm_busy), so the operation works on a frozen roster; it is refused itself while one is in flight."""
        with self._swarm_ops_lock:
            if swarm_id in self._swarm_ops or self._swarm_writers.get(swarm_id):
                raise self.error(409, "swarm_busy", "this swarm is changing right now (a delete, restore or membership "
                                                    "change); try again shortly")
            self._swarm_ops[swarm_id] = threading.get_ident()
        try:
            yield
        finally:
            with self._swarm_ops_lock:
                self._swarm_ops.pop(swarm_id, None)

    @contextlib.contextmanager
    def swarm_membership(self, *swarm_ids):
        """Held around any write that changes who or what is in a swarm. Refused while another thread holds the swarm's
        operation; the operation's own thread passes (its nested writes are part of it)."""
        ids = [i for i in dict.fromkeys(swarm_ids) if i]
        me = threading.get_ident()
        with self._swarm_ops_lock:
            for i in ids:
                if self._swarm_ops.get(i, me) != me:
                    raise self.error(409, "swarm_busy", "this swarm is being deleted or restored right now; try again shortly")
            for i in ids:
                self._swarm_writers[i] += 1
        try:
            yield
        finally:
            with self._swarm_ops_lock:
                for i in ids:
                    self._swarm_writers[i] -= 1
                    if self._swarm_writers[i] <= 0:
                        del self._swarm_writers[i]

    def restore_swarm(self, swarm_id):
        with self._swarm_operation(swarm_id):
            return self._restore_swarm(swarm_id)

    def _restore_swarm(self, swarm_id):
        self.swarm(swarm_id)
        self.db.execute("UPDATE swarms SET archived_at = NULL, archived_by = NULL WHERE id = ?", (swarm_id,))
        self._team_sync(swarm_id)
        self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
        return self.swarm(swarm_id)

    def _swarm_contents(self, swarm_id):
        one = lambda sql: self.db.one(sql, (swarm_id,))["n"]
        return {"minds": one("SELECT COUNT(*) AS n FROM agents WHERE swarm_id = ? AND deleted = 0 AND kind != 'module'"),
                "members": one("SELECT COUNT(*) AS n FROM agents WHERE swarm_id = ? AND deleted = 0 AND kind = 'module'"),
                "goals": one("SELECT COUNT(*) AS n FROM goals WHERE swarm_id = ?"),
                "artifacts": one("SELECT COUNT(*) AS n FROM artifacts WHERE owner_swarm = ?"),
                "child_swarms": one("SELECT COUNT(*) AS n FROM swarms WHERE parent_mind_id IN "
                                    "(SELECT id FROM agents WHERE swarm_id = ?)")}

    @staticmethod
    def _counted(counts, keys):
        words = {"minds": ("mind", "minds"), "members": ("external member", "external members"), "goals": ("task", "tasks"),
                 "artifacts": ("artifact", "artifacts"), "child_swarms": ("child swarm", "child swarms")}
        return ", ".join(f"{counts[k]} {words[k][counts[k] != 1]}" for k in keys if counts.get(k))

    def delete_swarm(self, swarm_id):
        """Remove an empty swarm: no minds, goals, artifacts or child swarms. Anything with history is kept. A swarm that
        still has minds can be removed together with them by delete_swarm_with_minds (the error says so)."""
        with self._swarm_operation(swarm_id):
            return self._delete_empty_swarm(swarm_id)

    def _delete_empty_swarm(self, swarm_id):
        self.swarm(swarm_id)
        counts = self._swarm_contents(swarm_id)
        blocking = self._counted(counts, ("minds", "members", "goals", "artifacts", "child_swarms"))
        if blocking:
            detail = {"counts": counts, "with_minds": bool(counts["minds"])}
            if counts["minds"]:
                detail["hint"] = "send {with_minds: true, confirm: <the swarm's exact name>} to delete it together with its minds"
            raise self.error(409, "swarm_not_empty", "only an empty swarm can be deleted; this one has " + blocking, detail)
        self._hard_delete_swarm(swarm_id)
        return {"deleted": swarm_id}

    def _hard_delete_swarm(self, swarm_id):
        self.db.execute("DELETE FROM budgets WHERE scope = ?", (f"swarm:{swarm_id}",))
        self.db.execute("DELETE FROM swarms WHERE id = ?", (swarm_id,))
        self._team_sync()            # its team room is archived
        self.events.publish("swarm.deleted", swarm_id=swarm_id)

    def delete_swarm_with_minds(self, swarm_id, confirm, by):
        """Jon 2026-10-07: delete a swarm and its minds in one step (a warning, not a lock). Held under the swarm's
        operation guard throughout. Order, so nothing running is ever stranded: (1) refuse a live flow; (2) stop every
        awake/starting mind through the API's stop path (re-judged under its lock: one that left the swarm is not
        touched), refusing the whole operation, before anything is deleted, if any cannot be stopped; (3) archive the
        swarm, whose busy check and write are one transaction, so from here no mind starts, joins or is created there;
        (4) delete each mind with delete_agent, conditional on it still being in this swarm (a mind moved away is skipped
        and reported), then release its unfinished assignments back to open; (5) with no history left, hard-delete the
        swarm; with history (tasks, artifacts, external members) it stays archived: hidden, restorable, nothing lost.
        A mind that cannot be deleted after the archive gives a structured answer, not an exception: the swarm stays
        archived with nothing running, and the same request finishes the job."""
        with self._swarm_operation(swarm_id):
            out = self._delete_swarm_with_minds(swarm_id, confirm, by)
        # keyview (Dot on a0975c2f): its minds were deleted on _delete_one's path; once the outcome is settled, the
        # tombstones of removed keys only they named go too (a partial outcome leaves the rest for startup's reconcile)
        self.reconcile_removed_keys()
        return out

    @staticmethod
    def _kept_after_minds(counts):
        """What keeps a swarm (archived, not deleted) once its minds are gone: the final step's rule, and the preview's."""
        return {k: counts[k] for k in ("goals", "artifacts", "members", "minds") if counts.get(k)}

    def _history_reason(self, kept):
        return "it has history (" + self._counted(kept, ("goals", "artifacts", "members", "minds")) + ")"

    def delete_preview(self, swarm_id):
        """Read-only (Surface, r3): what delete-with-minds would do now. Writes nothing and takes no guard. An advisory
        snapshot only (Kimi K2): `would`, `busy` and the counts can change before a confirmed delete, which re-checks
        everything itself, inside the fence, and is the only authority on what happens."""
        swarm = self.swarm(swarm_id)
        counts = self._swarm_contents(swarm_id)
        awake = [{"id": r["id"], "name": r["name"]} for r in self.db.all(
            "SELECT id, name FROM agents WHERE swarm_id = ? AND deleted = 0 AND kind != 'module' "
            "AND (status IN ('awake', 'starting') OR desired = 'awake') ORDER BY created_at", (swarm_id,))]
        kept = self._kept_after_minds(dict(counts, minds=0))   # its minds go; the rest is what the final step judges
        minds = "SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0 AND kind != 'module'"
        estimate = self.db.one(   # the same rows Goals.release_rows would change
            f"SELECT COUNT(*) AS n FROM goals WHERE (status IN ('open', 'claimed', 'waiting', 'stalled') AND "
            f"(assignee IN ({minds}) OR claimed_by IN ({minds}))) OR (status = 'submitted' AND assignee IN ({minds}))",
            (swarm_id, swarm_id, swarm_id))["n"]
        with self._swarm_ops_lock:
            held = swarm_id in self._swarm_ops or bool(self._swarm_writers.get(swarm_id))
        busy = ("a delete, restore or membership change is in progress" if held
                else "a flow is still running here" if self._live_flow(swarm_id) else False)
        return {"name": swarm["name"], "counts": counts, "awake_minds": awake,
                "would": "archive" if kept else "delete",
                "reason": self._history_reason(kept) if kept else "nothing would remain once its minds are deleted",
                "released_tasks_estimate": estimate, "busy": busy}

    def _delete_swarm_with_minds(self, swarm_id, confirm, by):
        swarm = self.swarm(swarm_id)
        if not isinstance(confirm, str) or confirm != swarm["name"]:
            raise self.error(400, "confirm_mismatch", "confirm must be the swarm's exact name",
                             {"expected": swarm["name"]})   # admins only, past the visibility check (Kimi K4)
        self._refuse_live_flow(swarm_id)
        minds = self.db.all("SELECT id, name, status, desired FROM agents WHERE swarm_id = ? AND deleted = 0 "
                            "AND kind != 'module' ORDER BY created_at", (swarm_id,))
        here = lambda row: row["swarm_id"] == swarm_id   # re-judged under the mind's lock: a mind that moved is left alone
        failed, stopped = [], []
        for mind in minds:
            try:
                if mind["status"] in ("awake", "starting") or mind["desired"] == "awake":
                    self.lifecycle(mind["id"], "stop", expect=here)
                    stopped.append({"id": mind["id"], "name": mind["name"]})
                # every mind, whatever its row says: one running untracked (its row says stopped) is found here (Kimi K1)
                self._verify_gone(mind["id"])
            except HiveError as exc:
                if exc.status != 404:   # deleted since the listing: nothing to stop
                    failed.append({"id": mind["id"], "name": mind["name"], "error": exc.message})
            except Exception as exc:
                failed.append({"id": mind["id"], "name": mind["name"], "error": str(exc) or type(exc).__name__})
        if failed:
            stopped = [m for m in stopped if m["id"] not in {f["id"] for f in failed}]
            raise self.error(409, "minds_unstoppable", "nothing was deleted; these minds could not be stopped: "
                             + ", ".join(f["name"] for f in failed),
                             {"failed": failed, "stopped_minds": stopped})   # stopped by this call, still not deleted
        self.archive_swarm(swarm_id, by)   # refuses (swarm_busy) if a mind woke in between; still nothing deleted
        deleted, skipped, released, error, pending = [], [], 0, None, []
        why = f"released: its mind was deleted with swarm {swarm['name']} by {by}"
        # A retry first finishes the cleanup a previous attempt committed but could not complete.
        for left in self.db.all("SELECT agent_id FROM mind_cleanup WHERE swarm_id = ? ORDER BY created_at", (swarm_id,)):
            try:
                if self.finish_mind_cleanup(left["agent_id"]):   # False: stale (the mind is live again); not ours
                    deleted.append(left["agent_id"])
            except Exception as exc:
                pending.append(left["agent_id"])
                error = error or {"code": "cleanup_failed", "message": str(exc) or type(exc).__name__,
                                  "mind": left["agent_id"]}
        # Safety net: tasks still held by or assigned to a mind already deleted in this swarm (a tombstone) are released.
        for dead in self.db.all(f"SELECT DISTINCT a.id FROM agents a JOIN goals g ON g.swarm_id = ? AND "
                                f"(g.assignee = a.id OR g.claimed_by = a.id) WHERE a.swarm_id = ? AND a.deleted = 1 "
                                f"AND g.status IN ('open', 'claimed', 'waiting', 'stalled', 'submitted')", (swarm_id, swarm_id)):
            with self.db.transaction():
                repaired = self.goals.release_rows(dead["id"], by, f"released: its mind was already deleted ({why})")
            for goal_id in repaired:
                self.goals._emit(goal_id)
            released += len(repaired)
        for mind in minds if error is None else []:
            committed = False
            try:
                freed, cleanup_error = self._delete_one(mind["id"], swarm_id, by, why, announce=False)
                committed, released = True, released + len(freed)   # recorded before anything after the commit can fail
                if cleanup_error is not None:
                    raise cleanup_error
            except HiveError as exc:
                if not committed and exc.status == 404:            # deleted since the listing: already gone
                    continue
                if not committed and exc.code == "mind_moved":     # moved out since the listing: not this swarm's
                    skipped.append({"id": mind["id"], "name": mind["name"], "reason": "moved to another swarm"})
                    continue
                error = {"code": exc.code, "message": exc.message, "mind": mind["id"]}
            except Exception as exc:
                # before the commit, the failure is the stop: the process or container was not confirmed gone
                error = {"code": "cleanup_failed" if committed else "minds_unstoppable",
                         "message": str(exc) or type(exc).__name__, "mind": mind["id"]}
            if committed:
                (pending if error else deleted).append(mind["id"])   # a committed delete is reported, cleaned or not
            if error:
                break
        def detached_now():   # from the final state (Kimi K2): child swarms whose parent is a mind this call deleted
            gone = deleted + pending
            marks = ", ".join("?" for _ in gone)
            return [r["id"] for r in self.db.all(f"SELECT id FROM swarms WHERE parent_mind_id IN ({marks}) "
                                                  "ORDER BY created_at", gone)] if gone else []
        if error:
            detached = detached_now()
            remaining = [r["id"] for r in self.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0 "
                                                       "AND kind != 'module' ORDER BY created_at", (swarm_id,))]
            self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
            result = {"swarm": "archived", "deleted_minds": deleted + pending, "remaining_minds": remaining, "error": error,
                      "hint": "the swarm is archived and none of its minds is running; send the same request again to "
                              "finish, or restore the swarm to keep the minds that remain",
                      "released_tasks": released}
            if pending:
                result["cleanup_pending"] = pending   # deleted; their cleanup finishes on the retry
            if skipped:
                result["skipped_minds"] = skipped
            if detached:
                result["detached_swarms"] = detached
            return result
        with self.db.transaction():
            detached = detached_now()
            kept = self._kept_after_minds(self._swarm_contents(swarm_id))
            if not kept:
                self.db.execute("DELETE FROM budgets WHERE scope = ?", (f"swarm:{swarm_id}",))
                self.db.execute("DELETE FROM swarms WHERE id = ?", (swarm_id,))
        if not kept:
            self.events.publish("swarm.deleted", swarm_id=swarm_id)
            result = {"deleted_minds": deleted, "swarm": "deleted"}
        else:
            self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))   # once, after all the minds went
            result = {"deleted_minds": deleted, "swarm": "archived", "reason": self._history_reason(kept)}
        result["released_tasks"] = released
        if skipped:
            result["skipped_minds"] = skipped
        if detached:   # as with a single mind's delete, its child swarms are kept and now stand on their own
            result["detached_swarms"] = detached
        return result

    def create_swarm(self, name, description="", hue=None, owner=None, visibility="private", shared_with=None, *, _defer_events=False):
        if not str(name).strip():
            raise HiveError(400, "bad_request", "name is required")
        row = {"id": new_id("s"), "name": str(name).strip(), "description": str(description or ""),
               "hue": int(hue if hue is not None else random.randrange(360)) % 360, "created_at": now(),
               **self._visibility_fields(owner, visibility, shared_with)}
        self.db.insert("swarms", row)
        swarm = self.swarm_view(row)
        if _defer_events:
            # Keep the original notice then room-sync order, outside the outer
            # connection lock; rollback drops both without taking a room lock.
            def notify():
                self.events.publish("swarm.updated", swarm=self.swarm(row["id"]))
                self._team_sync(row["id"])
            self.db.after_commit(notify)
        else:
            self.events.publish("swarm.updated", swarm=swarm)
            self._team_sync(row["id"])   # then its team room, where its minds reach each other (rooms.py)
        return swarm

    # ---- agents -------------------------------------------------------------------------------

    def agents(self):
        return [self.agent_view(r) for r in self.db.all("SELECT * FROM agents WHERE deleted = 0 ORDER BY created_at")]

    def _options(self, value, model=None, hidden_key=False):
        """hidden_key (keyview, sol on 59dfe1ff): the key is one the caller may not see (kept unchanged, never chosen by
        them): a mismatch is refused in words that name no key, label or provider."""
        try:
            options = clean_options(value)
        except ValueError as exc:
            raise HiveError(400, "bad_options", str(exc)) from exc
        key = options.get("key")
        store = getattr(self, "providers", None)
        if key and store is not None:
            provider = str(model or "").partition("/")[0]
            if key.startswith("env:"):
                if key[4:] != provider or not store.env_key_view(provider):
                    raise HiveError(400, "bad_key", f"no environment key for {provider}")
            else:
                record = store.ring["keys"].get(key)
                if record is None:
                    if hidden_key:   # a kept key that is gone, for a caller who may not see it: nothing named
                        raise HiveError(404, "unknown_key", "This mind's assigned key is gone; its owner can choose another.")
                    raise HiveError(404, "unknown_key", "no such key")   # as check_key_use words it: never the id
                if record["provider"] != provider:
                    if hidden_key:
                        raise HiveError(400, "key_provider_mismatch", "This mind's key is for another provider; its owner "
                                        "can change the key or the model.")
                    raise HiveError(400, "key_provider_mismatch",   # never a key's label (keyview R7)
                                    f"that key is a {record['provider']} key; this mind runs on {provider}")
        return options

    def check_key_lock(self, owner, old, new, by):
        """App platform P3a: only the mind's owner sets or clears options.key_locked, or changes its key while locked,
        and a locked mind's key must be a key its owner holds: never an environment key, the hive's, or another person's.
        Applied to every options write (create, patch, host-made minds), so no update path moves a locked mind's payer."""
        old, new = old or {}, new or {}
        was, now = bool(old.get("key_locked")), bool(new.get("key_locked"))
        if was and "key_locked" not in new:
            raise HiveError(409, "lock_confirm", "send key_locked: true to keep the lock, or key_locked: false to unlock")
        protected_change = was != now or (was and old.get("key") != new.get("key"))
        if protected_change and (not owner or by != owner):
            raise HiveError(403, "key_lock_owner_only", "only this mind's owner can lock, unlock or change its locked paying key")
        if now:
            key = new.get("key")
            holder = self.ownhive.key_person(key) if key and not key.startswith("env:") else None
            if not owner or holder != owner:
                raise HiveError(403, "own_key_only", "a key-locked mind runs only on its owner's own key; choose one of your keys")

    @staticmethod
    def check_approval_options(owner, old, new, by):
        """P3b: only this mind's owner changes its optional approval-answer policy.
        Full options replacement is also a clear when it omits an existing owner_only flag."""
        if (old or {}).get("approvals") != (new or {}).get("approvals") and (not owner or by != owner):
            raise HiveError(403, "approval_owner_only", "only this mind's owner can set or clear its approval policy")

    @staticmethod
    def check_key_use(key, may_use, current=None):
        """OI-13: refuse a mind's new assigned key that the caller may not spend (may_use: the app's key_permit for the
        caller; None means any key). The key already stored (current) is never refused, so an edit that leaves it alone
        works whoever's key it is. A refused key is answered as an unknown one (404 unknown_key)."""
        if key and may_use is not None and key != current and not may_use(key):
            # r1.1 (Kimi #4): answered exactly as a key that does not exist, so key ids cannot be probed; keyview (sol on
            # f4bb6907): without echoing the id, which a refused caller may not see
            raise HiveError(404, "unknown_key", "no such key")

    def reconcile_removed_keys(self):
        """keyview (sol and Kimi on 1edef3b4): every removed key's tombstone that no mind names any more is dropped (at
        startup, for orphans from before, and after any deletion of minds). Never raises: a tombstone kept a little longer
        only lets its own former owner keep recognising the id."""
        store = getattr(self, "providers", None)
        tombs = set((getattr(store, "ring", None) or {}).get("removed") or {})
        if not tombs:
            return
        try:   # ONE scan of the minds and ONE keyring write, however many tombstones (Dot on a0975c2f)
            named = set()
            for row in self.db.all("SELECT options FROM agents WHERE deleted = 0 AND options LIKE '%\"key\"%'"):
                key = (json.loads(row["options"] or "{}") or {}).get("key")
                if key in tombs:
                    named.add(key)
            store.forget_removed_many(tombs - named)
        except Exception:   # noqa: BLE001
            log.exception("keyview: removed keys' tombstones could not be reconciled")

    def forget_removed_key_if_unused(self, key_id):
        """keyview (Kimi on 593fde34): a removed key's tombstone (ProviderStore.removed_by) is kept only while a mind still
        names it; once none does, it is dropped."""
        store = getattr(self, "providers", None)
        if store is None or not key_id or key_id not in (store.ring.get("removed") or {}):
            return
        for row in self.db.all("SELECT options FROM agents WHERE deleted = 0 AND options LIKE ?", (f'%"{key_id}"%',)):
            if (json.loads(row["options"] or "{}") or {}).get("key") == key_id:
                return
        store.forget_removed(key_id)

    def key_usage(self):
        rows = self.db.all("SELECT key_id, COALESCE(SUM(cost_usd), 0) AS spent FROM usage WHERE key_id IS NOT NULL GROUP BY key_id")
        return {r["key_id"]: r["spent"] for r in rows}

    def minds_by_key(self):
        """Who each key pays for: minds assigned to it, and, for a provider default, minds with no key of their own."""
        store = getattr(self, "providers", None)
        out = {}
        for row in self.db.all("SELECT id, name, hue, status, model, options FROM agents WHERE deleted = 0"):
            provider = row["model"].partition("/")[0]
            if store is None or provider in ("mock", "local", FREE):   # free inference: the deploy's key, in no key's list
                continue
            assigned = (json.loads(row["options"]) if row.get("options") else {}).get("key")
            key = assigned or store.ring["defaults"].get(provider) or f"env:{provider}"
            out.setdefault(key, []).append({"id": row["id"], "name": row["name"], "hue": row["hue"],
                                            "status": row["status"], "assigned": bool(assigned)})
        return out

    def _coffee_sync(self, strict=False):
        """Keep the Coffee Room's membership in step with the minds (rooms.py); never let it break a mind change.
        strict: recorded cleanup (finish_mind_cleanup) needs to know it failed, so the record stays for a retry."""
        if strict:
            self.rooms.sync_coffee()
            self._team_sync_now()    # never holds a mind's cleanup record: the next sync puts it right
            return
        # Never inside the caller's transaction: the room syncs take their own locks, and a caller holding the database
        # (a model refresh updating a mind) while another thread held a room lock and waited for the database froze
        # the hive. After the outermost commit (or now, outside a transaction) they read committed rows.
        self.db.after_commit(self._coffee_sync_now)

    def _coffee_sync_now(self):
        try:
            self.rooms.sync_coffee()
        except Exception:   # noqa: BLE001
            log.exception("coffee room sync failed")
        self._team_sync_now()

    def _team_sync(self, swarm_id=None):
        """Keep the swarms' team rooms in step (rooms.py); never let it break a swarm or mind change. Runs after the
        caller's transaction commits (or now, outside one), never inside it: see _coffee_sync."""
        self.db.after_commit(lambda: self._team_sync_now(swarm_id))

    def _team_sync_now(self, swarm_id=None):
        if getattr(self, "rooms", None) is None:
            return                   # still starting: Rooms brings every swarm's team room up to date when it loads
        try:
            self.rooms.sync_team(swarm_id) if swarm_id else self.rooms.sync_teams()
        except Exception:   # noqa: BLE001
            log.exception("swarm room sync failed")


    @serialized_tools_choices
    def create_agent(self, name, kind="omega", swarm_id=None, model=None, persona="", hue=None, budget_usd=0.0,
                     options=None, role_id=None, owner=None, visibility="private", shared_with=None, personal_of=None, by=None,
                     privileged=True, approval_guard=None, host_need=None):
        """host_need (First Light, sol on 50998399): the host itself chose this mind's model for that need, so it is
        recorded (model_route.record) in the same transaction as the insert, before any edit can reach the mind; an edit
        afterwards forgets it (update_agent). Never set for a model anyone else chose."""
        row, token, role = self.new_agent_row(name, kind, swarm_id, model, persona, hue, budget_usd, options, role_id,
                                              owner, visibility, shared_with, personal_of, by=by, approval_guard=approval_guard)
        # The rule (stand-in r9): the new mind's lock, taken before its row is visible, and its swarm's fence, held from
        # the insert through finish_agent (spaces, workspace, role, announcement).
        with self._mind_lock(row["id"]), self.swarm_membership(swarm_id):
            # host-identity r1.2: someone who may not write policy (privileged False: not a hive admin or the hive's owner)
            # gets only a role carrying no rules. Re-checked under the roles lock through the insert, so a role edit that
            # adds rules lands either before (refused here) or after (the edit then applies to this mind as the admin's act).
            approval_options = json.loads(row.get("options") or "{}")
            atomic = approval_options.get("approvals") == "owner_only" or host_need
            with self.roles.lock, (self.db.transaction() if atomic else contextlib.nullcontext()):
                if approval_options.get("approvals") == "owner_only":
                    actor = approval_guard() if approval_guard is not None else by
                    self.check_approval_options(row.get("owner"), {}, approval_options, actor)
                if role and not privileged and self.roles.carries_rules(role["id"]):
                    raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can give a mind a role that carries approval rules")
                self.insert_into_open_swarm("agents", row, swarm_id)   # the namespace guard, nested in this transaction
                if host_need:
                    from .model_route import record
                    record(self.db, row["id"], row["model"], host_need)
            # a person who may not write policy is never recorded as granting rules (any a role has came from an admin's edit)
            return self.finish_agent(row, token, role, by=(by or owner) if privileged else None)

    def new_agent_row(self, name, kind="omega", swarm_id=None, model=None, persona="", hue=None, budget_usd=0.0,
                      options=None, role_id=None, owner=None, visibility="private", shared_with=None, personal_of=None,
                      by=None, approval_guard=None):
        """The row and token of a new mind, not yet written (mind control writes it inside its own transaction).
        personal_of: only personal.py, for a person's own mind (made asleep; it starts nothing)."""
        if not str(name).strip():
            raise HiveError(400, "bad_request", "name is required")
        if kind not in AGENT_KINDS:
            raise HiveError(400, "bad_request", f"kind must be one of {sorted(AGENT_KINDS)}")
        if swarm_id:
            self.swarm(swarm_id)
            self.require_open_swarm(swarm_id)
        self.personal.refuse_join(swarm_id, personal_of)   # a personal swarm holds its person's mind alone
        role = self.roles.get(role_id) if role_id else None
        if role:  # a role's defaults apply only where the caller gave nothing
            model = model or role["default_model"]
            if not budget_usd and role["default_budget"] is not None:
                budget_usd = role["default_budget"]
        if model:   # chosen by the caller or the role: on the free route, only a model the deploy offers now
            from .free_inference import check_model
            check_model(self.settings.providers, model)
        options = self._options(options, model or self.settings.default_model)
        if options.get("approvals") == "owner_only":
            actor = approval_guard() if approval_guard is not None else by
            self.check_approval_options(owner, {}, options, actor)
        if options.get("key_locked"):   # app platform P3a: every creation path, host-made minds included (by: the owner)
            self.check_key_lock(owner, {}, options, by or owner)
        self.validate_tools(kind, options, model or self.settings.default_model)
        # Allocation is a preflight; the shared insert path rechecks under BEGIN IMMEDIATE. A generated collision
        # never grants authority over an old record, directory or dangling link. No historical ids are rewritten.
        for _ in range(16):
            agent_id = new_id("a")
            root = self.settings.agents_dir / agent_id
            try:
                with self.db.transaction():
                    self.placement._check_workspace_namespace(agent_id, root)
                    if self.db.one("SELECT 1 FROM agents WHERE id = ?", (agent_id,)) or root.exists() or root.is_symlink():
                        continue
            except HiveError as exc:
                if exc.code != "workspace_identity_conflict":
                    raise
                continue
            break
        else:
            raise HiveError(409, "workspace_identity_conflict", "could not allocate a free mind workspace; try again")
        token = secrets.token_urlsafe(32)
        row = {
            "id": agent_id, "name": str(name).strip(), "kind": kind, "swarm_id": swarm_id or None,
            "model": model or self.settings.default_model, "persona": str(persona or ""),
            "options": json.dumps(options) if options else None,
            "role_id": role["id"] if role else None,
            "hue": int(hue if hue is not None else random.randrange(360)) % 360,
            "status": "created", "desired": "stopped", "driver": self.settings.default_driver,
            "budget_usd": float(budget_usd or 0), "spent_usd": 0.0, "token_hash": token_hash(token),
            "created_at": now(), **self._visibility_fields(owner, visibility, shared_with),
        }
        if personal_of:   # one statement: marked and asleep as it is written (the unique index guards one per person)
            row.update(personal_of=personal_of, status="asleep", desired="asleep")
        return row, token, role

    def finish_agent(self, row, token, role, by=None):
        """Everything after a new mind's row is committed: spaces, workspace, role, announcement."""
        swarm_id = row["swarm_id"]
        kind = row["kind"]
        with self.db.transaction():
            self.placement._check_workspace_namespace(row["id"], self.settings.agents_dir / row["id"])
        if swarm_id:
            self.join_commons(row["id"], swarm_id)
            self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
        if self.supervisor:
            self.supervisor.prepare(self.agent(row["id"]), token)
            if kind != "module":
                self.placement.write_body(row["id"])
        if role:
            self.roles.apply(row["id"], by=by)   # host-identity r1.1: the role's rules record who gave the mind its role
        agent = self.agent(row["id"])
        self.events.publish("agent.updated", agent=agent)
        self._coffee_sync()
        return dict(agent, token=token)

    def convert_to_native(self, agent_id):
        """Make a stopped outside member (kind module) a native mind (omega) in place: same id, role, rules and
        history; a fresh token (the old outside token stops working); its workspace built as for a new mind.
        Asked for by OmegaReview so its reviewers can actually run (2026-10-04)."""
        # The rule (stand-in r10): the mind's lock and its swarm's fence through the re-check, the write, preparation,
        # role and notifications; the conversion never lands in a swarm being deleted or restored, or a retired one.
        with self._mind_lock(agent_id):
            row = self._agent_row(agent_id)
            with self.swarm_membership(row["swarm_id"]):
                if row["kind"] != "module":
                    raise HiveError(409, "not_module", f"{agent_id} is already {row['kind']}")
                if row["status"] not in ("created", "stopped"):
                    raise HiveError(409, "not_stopped", "stop it first")
                self.require_open_swarm(row["swarm_id"])
                token = secrets.token_urlsafe(32)
                with self.db.transaction():
                    self.placement._check_workspace_namespace(agent_id, self.settings.agents_dir / agent_id)
                    sql = ("UPDATE agents SET kind = 'omega', token_hash = ?, status = 'created', desired = 'stopped' WHERE id = ? "
                           "AND deleted = 0 AND kind = 'module' AND swarm_id IS ? AND status IN ('created', 'stopped')")
                    params = [token_hash(token), agent_id, row["swarm_id"]]
                    if row["swarm_id"]:
                        sql, params = sql + " AND " + self.OPEN_SWARM_SQL, params + [row["swarm_id"]]
                    if self.db.execute(sql, params).rowcount != 1:
                        raise HiveError(409, "mind_changed", "this member changed meanwhile; reload and try again")
                if self.supervisor:
                    self.supervisor.prepare(self.agent(agent_id), token)
                if row.get("role_id"):
                    self.roles.apply(agent_id)
                self.emit_agent(agent_id)
                return self.agent(agent_id)

    @serialized_tools_choices
    def unassign_stored_key(self, agent_id, key_id, by=None):
        """Remove only this still-assigned unlocked key, preserving all fresh unrelated options.
        The async key-removal route may have queued an old options snapshot before the mind changed."""
        with self._mind_lock(agent_id), self.swarm_membership():
            row = self._agent_row(agent_id)
            options = json.loads(row.get("options") or "{}")
            if options.get("key") != key_id or options.get("key_locked"):
                return False
            del options["key"]
            # Already in the same tools/mind fences as update_agent: do not re-enter a supervisor transition.
            self._update_agent_locked(agent_id, {"options": options}, by=by)
            return True

    @serialized_tools_choices
    def update_agent(self, agent_id, changes, expected_tools=None, by=None, privileged=True, may_use_key=None, approval_guard=None):
        """The whole update under the mind's lock; a move also holds the fences of both swarms for all of it, its space
        revoke/grant and notifications included (the rule; stand-in r9)."""
        with self._mind_lock(agent_id):
            row = self._agent_row(agent_id)
            target = changes.get("swarm_id") if "swarm_id" in changes else row["swarm_id"]
            fences = (row["swarm_id"], target) if target != row["swarm_id"] else ()
            with self.swarm_membership(*fences):
                out = self._update_agent_locked(agent_id, changes, expected_tools, by, privileged, may_use_key, approval_guard)
        old_key = (json.loads(row.get("options") or "{}") or {}).get("key")
        if old_key and "options" in changes and (changes.get("options") or {}).get("key") != old_key:
            self.forget_removed_key_if_unused(old_key)   # keyview: moved off a removed key; drop it once nobody names it
        return out

    def _update_agent_locked(self, agent_id, changes, expected_tools=None, by=None, privileged=True, may_use_key=None, approval_guard=None):
        row = self._agent_row(agent_id)
        approval_change = False
        studio = getattr(self, "studio", None)
        # J3 R4 (plan r1.1 S5): the binding a person consented to is not changed under a live Studio session (inert off)
        refused = studio.change_refusal(agent_id, changes) if studio is not None else None
        if refused is not None:
            raise refused
        if expected_tools is not None and json.loads(row['options'] or '{}').get('tools', []) != expected_tools:
            raise HiveError(409, 'tools_changed', 'Tool selection changed; reload before saving')
        role_change = "role_id" in changes
        new_role = changes.get("role_id")
        changes = {k: v for k, v in changes.items() if k in EDITABLE}
        if 'model' in changes and changes['model'] != row['model']:
            # a move onto the free route takes only a model the deploy offers now; a model kept as it was is judged at
            # each call instead, so a mind left on one the deploy dropped can still be renamed or moved off it
            from .free_inference import check_model
            check_model(self.settings.providers, changes['model'])
        # Refuse a Tool change before existing swarm grant/revoke side effects.
        if changes.get('driver') and changes['driver'] != 'local' and (changes.get('options',json.loads(row['options'] or '{}')) or {}).get('tools'):
            raise HiveError(400,'tools_refused','Tools candidate requires the local driver')
        if 'model' in changes and 'options' not in changes:
            # keyview (sol on 16842acb): a model-only edit keeps the mind's assigned key, so that key must suit the new
            # model's provider; refused here, in words that name nothing to a caller who may not see it, rather than
            # left to fail later at the gateway
            kept = json.loads(row['options'] or '{}')
            if kept.get('key'):
                hidden = bool(may_use_key is not None and not may_use_key(kept['key']))
                self._options(kept, changes['model'], hidden_key=hidden)
        if 'options' in changes:
            # keyview (sol on 59dfe1ff): the key is authorized BEFORE any check whose words carry a key's details: a
            # changed key the caller may not use is refused exactly as a key that does not exist (check_key_use), and
            # one they keep unchanged without being able to see it is judged in words that name nothing (_options)
            try:
                cleaned = clean_options(changes['options'])
            except ValueError as exc:
                raise HiveError(400, "bad_options", str(exc)) from exc
            stored_key = json.loads(row['options'] or '{}').get('key')
            self.check_key_use(cleaned.get('key'), may_use_key, stored_key)   # OI-13, now first
            hidden = bool(cleaned.get('key') and may_use_key is not None and not may_use_key(cleaned['key']))
            options = self._options(cleaned, changes.get('model') or row['model'], hidden_key=hidden)
            old_options = json.loads(row['options'] or '{}')
            approval_change = old_options.get("approvals") != options.get("approvals")
            if approval_change:
                actor = approval_guard() if approval_guard is not None else by
                self.check_approval_options(row.get("owner"), old_options, options, actor)
            self.check_key_lock(row.get('owner'), json.loads(row['options'] or '{}'), options, by)   # app platform P3a
            makers = getattr(self, "studio_makers", None)
            if options.get('key') and makers is not None:
                # J3 R7.2: a person's own Studio maker takes only a key that person owns (or none), admins included
                refused = makers.key_refusal(agent_id, options.get('key'), "patch")
                if refused is not None:
                    raise refused
            self.validate_tools(row['kind'], options, changes.get('model') or row['model'], agent_id)
            changes['options'] = json.dumps(options) if options else None
        elif 'model' in changes:
            self.validate_tools(row['kind'], json.loads(row['options'] or '{}'), changes['model'], agent_id)
        if role_change:
            # host-identity r1.2: the role first, before any other change lands, with the policy check inside roles.assign's
            # lock and transaction: someone who may not write policy cannot change a role when that would delete or insert
            # any approval rule at this mind's scope (refused here, nothing changed). Persists agents.role_id.
            def guard():
                if not privileged and self.roles.touches_policy(agent_id, new_role or None):
                    raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can change a role that carries approval rules")
            self.roles.assign(agent_id, new_role or None, by=by, guard=guard)
        if "swarm_id" in changes and changes["swarm_id"] != row["swarm_id"]:
            self.personal.refuse_move(row, changes["swarm_id"])   # a personal mind stays alone in its own swarm
            if row["status"] in ("awake", "starting"):   # a running mind keeps its swarm's spaces mid-turn: stop it first
                raise HiveError(409, "mind_running", f"stop {row['name']} before moving it to another swarm")
            if changes["swarm_id"]:
                self.swarm(changes["swarm_id"])
            # One conditional statement, under the fence of both swarms: never into a deleted or retired swarm, never
            # while running, and only from the swarm read above (a move that raced this one wins; this one is refused).
            target = changes["swarm_id"]
            sql = ("UPDATE agents SET swarm_id = ? WHERE id = ? AND deleted = 0 AND swarm_id IS ? "
                   "AND status NOT IN ('awake', 'starting')")
            params = [target, agent_id, row["swarm_id"]]
            if target:
                sql, params = sql + " AND " + self.OPEN_SWARM_SQL, params + [target]
            with self.db.transaction():   # the move and leaving the old team room are one commit (rooms.py)
                cur = self.db.execute(sql, params)   # under the mind's lock and both fences (update_agent)
                left = self.rooms.revoke_team_seats(agent_id) if cur.rowcount == 1 else []
            for room_id in left:
                self.rooms._event(room_id, "members")
            if cur.rowcount != 1:
                if target:
                    self.require_open_swarm(target)
                    if not self.db.one("SELECT 1 FROM swarms WHERE id = ?", (target,)):
                        raise HiveError(404, "not_found", "that swarm no longer exists")
                fresh = self._agent_row(agent_id)
                if fresh["swarm_id"] != row["swarm_id"]:
                    raise HiveError(409, "mind_moved", f"{row['name']} was moved meanwhile; reload and try again")
                raise HiveError(409, "mind_running", "stop this mind before moving it")
            if row["swarm_id"]:
                self.leave_commons(agent_id, row["swarm_id"])
            if changes["swarm_id"]:
                self.join_commons(agent_id, changes["swarm_id"])
        if "driver" in changes:
            known = set(getattr(self.supervisor, "drivers", {}) or {}) or {self.settings.default_driver}
            if changes["driver"] not in known:
                raise self.error(400, "bad_driver", f"driver is one of: {', '.join(sorted(known))}")
            if changes["driver"] != row["driver"] and row["status"] not in ("created", "stopped"):
                raise self.error(409, "mind_running", "stop the mind before changing where it runs")
        if "hue" in changes:
            changes["hue"] = int(changes["hue"]) % 360
        moved_to = changes.pop("swarm_id", row["swarm_id"])   # written above, conditionally, or not at all: never twice
        from . import model_route

        def provenance():
            # model provenance (model_route), in the same transaction as the model change: the host's own choice is
            # recorded; anyone else's change forgets it, so the host never moves a model a person or an admin chose
            if "model" not in changes:
                return
            if by == model_route.HOST_ACTOR:
                model_route.record(self.db, agent_id, changes["model"], "personal-mind:dialogue")
            else:
                model_route.forget(self.db, agent_id)
        if changes:
            if "model" in changes:
                model_route.migrate(self.db)                     # its table exists before the transaction opens
            if approval_change:
                with self.db.transaction():
                    fresh = self._agent_row(agent_id, guard=False)
                    actor = approval_guard() if approval_guard is not None else by
                    self.check_approval_options(fresh.get("owner"), json.loads(fresh.get("options") or "{}"), options, actor)
                    self.db.update("agents", agent_id, changes)
                    provenance()
            else:
                with self.db.transaction():
                    self.db.update("agents", agent_id, changes)
                    provenance()
        if self.supervisor and ({"model", "persona", "name"} & changes.keys()):
            self.supervisor.reconfigure(self.agent(agent_id))
        if self.supervisor and row['kind'] == 'omega' and 'options' in changes and (
            (json.loads(row['options'] or '{}').get('tools', [])) != options.get('tools', [])
        ):
            # Only the changed mind; rebuild while stopped, resume if it was awake.
            self.supervisor.reconfigure_tools(self.agent(agent_id))
        for swarm_id in {row["swarm_id"], moved_to} - {None}:
            self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
        self.emit_agent(agent_id)
        self._coffee_sync()
        return self.agent(agent_id)

    def validate_tools(self, kind, options, model, agent_id=None):
        if not options.get('tools'): return
        from .tools import ToolRegistry
        try:
            if kind not in AGENT_KINDS:
                raise ValueError('unsupported Tools caller kind')
            registry = ToolRegistry(self.settings.core_root, self.programs)
            import os
            import sys
            plan = registry.plan(options['tools'], self.settings.petta_path,
                                 os.environ.get('OMEGACLAW_PYTHON_EXECUTABLE') or sys.executable)
            registry.preflight(plan)
        except (ValueError, KeyError, OSError) as exc:
            raise HiveError(400, 'tools_refused', str(exc)) from exc

    def delete_agent(self, agent_id, expect_swarm=..., announce_swarm=True, by="user:operator"):
        """Soft-delete one mind (memory stays on disk), end to end under its lock and its swarm's fence (Platform rule
        on 3a2a609): stop (verified), soft delete and the release of its unfinished tasks in one transaction, a cleanup
        record with its deletion generation, then the cleanup itself. A cleanup failure after the commit is raised but
        recorded, and finished by the next finish_mind_cleanup (a retry, or the swarm's delete-with-minds)."""
        _, error = self._delete_one(agent_id, expect_swarm, by,
                                    f"released: its mind was deleted by {by}", announce=announce_swarm)
        if error is not None:
            raise error   # the outcome is not settled: startup's reconcile picks the tombstone up later
        self.reconcile_removed_keys()   # keyview: a removed key's tombstone goes with the last mind that named it
        return {"ok": True}

    def _delete_one(self, agent_id, expect_swarm, by, why, announce=True):
        """Returns (released task ids, the cleanup error or None). Raises before the commit (nothing deleted)."""
        with self._mind_lock(agent_id):
            row = self._agent_row(agent_id)
            with self.swarm_membership(row["swarm_id"]):
                _, released = self._soft_delete_locked(agent_id, expect_swarm, by, why, announce)
                try:
                    self.finish_mind_cleanup(agent_id)
                except Exception as exc:   # committed: the record keeps what is left
                    return released, exc
                return released, None

    def _verify_gone(self, agent_id):
        """Raise unless the supervisor confirms the mind's process or container is gone. A stop can do nothing (a mind
        the supervisor does not track, or one it cannot read), so the stop alone is no proof. Supervisors without
        verify_stopped (stand-ins in tests) are taken at their word."""
        verify = getattr(self.supervisor, "verify_stopped", None) if self.supervisor else None
        if callable(verify):
            verify(agent_id)

    def _locked_soft_delete(self, agent_id, expect_swarm=..., release_by=None, why="", announce=True):
        if self.supervisor:
            with self._mind_lock(agent_id):
                return self._soft_delete_locked(agent_id, expect_swarm, release_by, why, announce)
        return self._soft_delete_locked(agent_id, expect_swarm, release_by, why, announce)

    def _soft_delete_locked(self, agent_id, expect_swarm=..., release_by=None, why="", announce=True):
        """expect_swarm: delete only while the mind is still in that swarm, judged here under its lock and again in the
        write itself (409 mind_moved). release_by: in the SAME transaction its unfinished tasks are released
        (Goals.release_rows). The stop comes first and raises unless the process or container is confirmed gone."""
        row = self._agent_row(agent_id)
        if expect_swarm is not ... and row["swarm_id"] != expect_swarm:
            raise HiveError(409, "mind_moved", f"{row['name']} has moved to another swarm")
        if self.supervisor:
            self.supervisor.stop(agent_id)
            self._verify_gone(agent_id)   # positively, before the delete commits (Kimi K1 on 021ef16)
        sql = ("UPDATE agents SET deleted = 1, status = 'stopped', desired = 'stopped', deletion_gen = deletion_gen + 1 "
               "WHERE id = ? AND deleted = 0")
        params = (agent_id,)
        if expect_swarm is not ...:
            sql, params = sql + " AND swarm_id IS ?", (agent_id, expect_swarm)
        with self.db.transaction():
            if self.db.execute(sql, params).rowcount != 1:
                fresh = self._agent_row(agent_id)   # 404 if it was deleted meanwhile
                raise HiveError(409, "mind_moved", f"{fresh['name']} has moved to another swarm")
            self.forget_live_memo()   # its agent:* messages fail closed at once on the live socket
            makers = getattr(self, "studio_makers", None)
            if makers is not None:      # J3 R7: a personal Studio maker's binding and host attachment end with it
                makers.forget(agent_id)
            person_swarms = getattr(self, "person_swarms", None)
            if person_swarms is not None:   # app platform P2: an app-made mind's binding and template rules end with it
                person_swarms.forget(agent_id)
            released = self.goals.release_rows(agent_id, release_by, why) if release_by else []
            left = self.rooms.revoke_team_seats(agent_id)   # a deleted mind leaves its team room in the same commit
            gen = self.db.one("SELECT deletion_gen FROM agents WHERE id = ?", (agent_id,))["deletion_gen"]
            self.db.execute("INSERT OR REPLACE INTO mind_cleanup (agent_id, swarm_id, created_at, released, generation, "
                            "announce) VALUES (?, ?, ?, ?, ?, ?)",
                            (agent_id, row["swarm_id"], now(), json.dumps(released), gen, int(bool(announce))))
        for room_id in left:
            self.rooms._event(room_id, "members")
        return row, released

    def finish_mind_cleanup(self, agent_id):
        """The after-commit steps of a deleted mind, in order: revoke its spaces, goal.updated for each task its delete
        released, agent.deleted, the swarm's update (unless the caller announces once itself) and the Coffee Room sync.
        The whole run holds the mind's lock and its swarm's fence (Platform rule on 3a2a609). Each step is marked done
        when it succeeds, and every change to the record (each mark, the final removal) is conditioned on the record's
        generation, so a retry runs only what is left (agent.deleted once) and a stale caller changes nothing. The
        record acts only while the mind is still deleted at that generation; otherwise it is dropped untouched."""
        with self._mind_lock(agent_id):
            record = self.db.one("SELECT * FROM mind_cleanup WHERE agent_id = ?", (agent_id,))
            if record is None:
                return False
            gen = record["generation"]
            mind = self.db.one("SELECT deleted, deletion_gen FROM agents WHERE id = ?", (agent_id,))
            if mind is None or not mind["deleted"] or mind["deletion_gen"] != gen:
                self.db.execute("DELETE FROM mind_cleanup WHERE agent_id = ? AND generation = ?", (agent_id, gen))
                return False
            swarm_id = record["swarm_id"]
            def mark(sets, params=()):
                self.db.execute(f"UPDATE mind_cleanup SET {sets} WHERE agent_id = ? AND generation = ?",
                                (*params, agent_id, gen))
            with self.swarm_membership(swarm_id):
                if swarm_id and not record["spaces_revoked"]:
                    self.leave_commons(agent_id, swarm_id)
                    mark("spaces_revoked = 1")
                pending = json.loads(record["released"] or "[]")
                while pending:
                    self.goals._emit(pending[0])
                    pending = pending[1:]
                    mark("released = ?", (json.dumps(pending),))
                if not record["agent_deleted_published"]:
                    self.events.publish("agent.deleted", agent_id=agent_id)
                    mark("agent_deleted_published = 1")
                if swarm_id and record["announce"] and not record["swarm_announced"]:
                    if self.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)):
                        self.events.publish("swarm.updated", swarm=self.swarm(swarm_id))
                    mark("swarm_announced = 1")
                if not record["coffee_synced"]:
                    self._coffee_sync(strict=True)   # a failure keeps the record (stand-in r5)
                    mark("coffee_synced = 1")
                self.db.execute("DELETE FROM mind_cleanup WHERE agent_id = ? AND generation = ?", (agent_id, gen))
            return True

    def settle_cleanup_before_return(self, agent_id):
        """A deleted mind coming back (an import over its row): its pending cleanup is finished now, while it is still
        deleted; if that fails, the record is dropped, so nothing stale ever acts on the mind once it is live."""
        try:
            self.finish_mind_cleanup(agent_id)
        except Exception:   # noqa: BLE001
            log.exception("cleanup of %s before its return failed; dropping the stale record", agent_id)
            self.db.execute("DELETE FROM mind_cleanup WHERE agent_id = ?", (agent_id,))

    def set_status(self, agent_id, status, desired=None, error=None):
        values = {"status": status, "last_error": error if status == "error" else None}
        if status == "starting":   # every start stamps its moment, as _start_locked does: health times 'unconnected' from it
            values["last_active_at"] = now()
        if desired:
            values["desired"] = desired
        self.db.update("agents", agent_id, values)
        if status in ("starting", "stopped", "error"):   # S4: the last boot receipt no longer describes a running process
            self.inventory.invalidate(agent_id)
        self.emit_agent(agent_id)

    def _mind_lock(self, agent_id):
        """The supervisor's per-mind lock, held as a transition: reconciliation neither interleaves from another thread
        nor re-enters on this one until the change is recorded (production Supervisor always has it:
        test_stop_reconcile_race pins it). A stand-in supervisor without one, as in tests, gets its plain lock or no
        serialization rather than an error."""
        for name in ("transition", "lock"):
            lock = getattr(self.supervisor, name, None)
            if callable(lock):
                return lock(agent_id)
        # No supervisor lock (no supervisor, or a stand-in without one): the hive's own per-mind lock, so existence and
        # membership changes still serialize per mind (Platform rule on 3a2a609).
        with self._swarm_ops_lock:
            return self._own_mind_locks.setdefault(agent_id, threading.RLock())

    def lifecycle(self, agent_id, action, expect=None):
        """expect: for callers acting on a row they read earlier (boot restore, wake on message, idle sleep), a test of
        the fresh row under the lock; when it no longer holds, nothing happens (a stop that won is never undone)."""
        self._agent_row(agent_id)
        if self.supervisor is None:
            raise HiveError(503, "no_supervisor", "no supervisor configured")
        with self._mind_lock(agent_id):   # start/stop/sleep, moves and reconciliation never interleave for one mind
            row = self._agent_row(agent_id)
            if expect is not None and not expect(row):
                return self.agent(agent_id)
            # J3 host R3 (handoff spec r2.4 §2): a maker Studio owns is started and stopped only by Studio's jobs; every
            # caller of lifecycle (wake on message, idle sleep, boot restore, admin routes, ...) gets 409 studio_owned.
            # Inert with Studio off (studio_owns is false)
            studio = getattr(self, "studio", None)
            refused = studio.owned_refusal(agent_id) if studio is not None else None
            if refused is not None:
                raise refused
            return self._lifecycle_locked(agent_id, row, action)

    def sleep_if_idle(self, agent_id, moment=None):
        """Idle sleep for one candidate, re-judged under the mind's lock: a mind stopped since the candidate list was
        read, or one that had real input since (last_input_at, or a start or own action on last_active_at), is left as
        it is. Model spend moves neither, so a mind spending with nothing coming in still sleeps when its owner set
        idle_sleep_minutes; Health's own question does not count as input either."""
        return self.lifecycle(agent_id, "sleep", expect=lambda row: self._idle(row, moment))

    def sleep_idle_minds(self, moment=None):
        """One idle-sleep pass (the reconcile loop's): each candidate on its own, so one mind whose stop fails, or one
        deleted after the listing, never keeps the minds after it awake."""
        slept, failed = [], []
        for agent_id in self.idle_candidates(moment):
            try:
                self.sleep_if_idle(agent_id, moment)
                slept.append(agent_id)
            except HiveError as exc:
                if exc.status != 404:   # deleted since the listing: nothing to sleep
                    failed.append(agent_id)
                    log.warning("idle sleep of %s failed: %s", agent_id, exc)
            except Exception as exc:
                failed.append(agent_id)
                log.warning("idle sleep of %s failed: %s", agent_id, exc)
        return {"slept": slept, "failed": failed}

    def sleep_for_restart(self, keep=()):
        """The Mac restart script's one try (Jon 2026-10-18, "normal sleep"): ask each awake mind, residents in keep
        aside, to sleep once through the ordinary lifecycle Sleep; no retry. Each on its own, as sleep_idle_minds: one
        failure never keeps the others awake. Modules are never touched."""
        rows = self.db.all("SELECT id FROM agents WHERE status = 'awake' AND deleted = 0 AND kind != 'module' ORDER BY id")
        asked = [row["id"] for row in rows if row["id"] not in set(keep)]
        slept, failed = [], []
        for agent_id in asked:
            try:
                self.lifecycle(agent_id, "sleep")
                slept.append(agent_id)
            except HiveError as exc:
                if exc.status != 404:   # deleted since the listing: nothing to sleep
                    failed.append({"id": agent_id, "error": exc.code})
                    log.warning("restart prepare: sleep of %s failed: %s", agent_id, exc.code)
            except Exception as exc:   # noqa: BLE001
                failed.append({"id": agent_id, "error": "internal"})
                log.warning("restart prepare: sleep of %s failed: %s", agent_id, type(exc).__name__)
        log.info("restart prepare: asked %d, slept %d, failed %d, kept %d", len(asked), len(slept), len(failed),
                 len(rows) - len(asked))
        return {"asked": asked, "slept": slept, "failed": failed}

    def _lifecycle_locked(self, agent_id, row, action):
        if row.get("moved_to") and action in ("start", "wake"):
            raise HiveError(409, "moved", f"{row['name']} now lives on {row.get('moved_to_name') or row['moved_to']}")
        if row["kind"] == "module" and action in ("start", "wake"):
            raise HiveError(400, "external_member",
                            "this member runs outside the hive; it connects with its token instead")
        if action in ("start", "wake"):
            if self.newhive is not None:   # new-hive R1a (r1.2.1 §A): no mind wakes or spends before coding readiness
                self.newhive.require_coding("mind_start")
            with self.swarm_membership(row.get("swarm_id")):   # no start while its swarm is being deleted or restored
                return self._start_locked(agent_id, row)
        return self._stop_locked(agent_id, row, action)

    def _start_locked(self, agent_id, row):
        self.person_swarms.require_current(agent_id)
        if self.minds.is_child(agent_id):
            # Under this mind's lock, immediately before the effect: a cancel, lease loss or stop that won before this
            # queued start refuses it here (OmegaReview B1, 1986fd8/a0a27a0), never later by reconcile.
            self.minds.require_startable(agent_id)
        self.require_open_swarm(row.get("swarm_id"))   # early, readable refusal; the write below is the guard
        # The reservation and the open-swarm condition are one statement, so it is atomic with archive_swarm:
        # either archive sees 'starting' and refuses, or this sees the archive and refuses (OmegaReview race).
        cur = self.db.execute(
            "UPDATE agents SET status = 'starting', desired = 'awake', last_error = NULL, last_active_at = ? "
            "WHERE id = ? AND (swarm_id IS NULL OR NOT EXISTS (SELECT 1 FROM swarms WHERE id = agents.swarm_id "
            "AND archived_at IS NOT NULL))", (now(), agent_id))
        if cur.rowcount != 1:
            self.require_open_swarm(row.get("swarm_id"))
            raise HiveError(409, "swarm_archived", "that swarm was archived")
        self.inventory.invalidate(agent_id)            # S4: the last boot receipt no longer describes a running process
        self.emit_agent(agent_id)
        from ..supervisor.drivers import StartRefused
        try:
            self.supervisor.start(agent_id)
        except StartRefused as exc:
            # it cannot run here as configured (e.g. an Iter without Docker): say why, on the mind, and leave it
            # stopped so the reconciler does not retry it blindly; starting it again after the fix tries again
            self.set_status(agent_id, "error", desired="stopped", error=f"start refused: {exc}")
            raise HiveError(409, "start_refused", str(exc))
        return self.agent(agent_id)

    def _stop_locked(self, agent_id, row, action):
        if action == "stop":
            self.supervisor.stop(agent_id)
            self.set_status(agent_id, "stopped", desired="stopped")
        elif action == "sleep":
            self.supervisor.stop(agent_id)
            self.set_status(agent_id, "asleep", desired="asleep")
        else:
            raise HiveError(400, "bad_request", f"unknown action {action}")
        return self.agent(agent_id)

    def authenticate_agent(self, token, surface=None):
        """The member behind a token. surface (session onboarding R2.8 §W, W-a): where the call arrives; "mcp" only at
        /mcp. A restricted bridged-session credential (pending or mixed context) is refused with 403 at every other
        surface, including a caller that names none (closed default)."""
        if not token:
            return None
        row = self.db.one("SELECT * FROM agents WHERE token_hash = ? AND deleted = 0", (token_hash(token),))
        if row is None and getattr(self, "credentials", None) is not None:
            row = self.credentials.authenticate(token, surface)
        if row is not None:
            binding, reason = self.person_swarms.current(row["id"])
            if binding is not None and reason is not None:
                self.person_swarms.read_row(row)
                return None
        return row

    # ---- messages -----------------------------------------------------------------------------

    def message_view(self, row):
        """A message as stored: the text exactly as the mind sent or received it (Health's question keeps its id tag,
        which the mind answers by). A verified Health question (_health_question: its stored event, never its text) is
        marked health_check; what a person reads of it is health.people_message, applied where answers and events
        leave for people (app.py), never here."""
        view = {k: row[k] for k in ("id", "agent_id", "conversation_id", "direction", "sender", "text", "created_at")}
        view["sender_name"] = self.sender_name(row["sender"])
        if self.verified_health_question(dict(row)):
            view["health_check"] = True
        elif self.mind_only(dict(row)):
            view["mind_only"] = True   # a people page leaves it out of the chat; the mind's copy is untouched
        # a room delivery copies a room message (rooms._deliver names it in extra.room), its source: a link to this
        # message opens that one in its room; an unreadable extra names none (as verified_health_question reads it)
        try:
            extra = json.loads(dict(row).get("extra") or "{}")
        except ValueError:
            extra = None
        room = extra.get("room") if isinstance(extra, dict) else None
        if isinstance(room, dict) and room.get("message_id"):
            view["source_message_id"] = room["message_id"]
        return view

    # hive notes written in people's words: a person's own scheduled wakeup (schedule.py, the text they set), shown to
    # whoever may read it (Visibility.project_person_message). Health's verified question is the other (people_message).
    PEOPLE_NOTE_SENDERS = ("hive:schedule", "hive:reply-owed")

    def mind_only(self, message):
        """A hive note only its mind reads: the hive instructing the mind, as goals.announce's "Assigned to you: ... Read it
        with hive-goal-get ..." does, or an approval, a share or file notice, a code packet, First Light's request for a
        greeting, a Health alert. It stays whole in the mind's own log and on its socket; every view of it that people
        read is marked mind_only (message_view, the DM room copy), so a chat page leaves it out instead of drawing it as
        the mind's words (a Lisbon tester's own mind showed its goal instructions in its chat). A person's scheduled
        wakeup, the hive's note that a mind stopped without answering them (replies.py) and Health's verified question
        are people's words, and stay. Inbound only: a mind's own message never is."""
        if not isinstance(message, dict) or message.get("direction", "in") != "in":
            return False
        sender = str(message.get("sender") or "")
        return (sender.startswith("hive:") and sender not in self.PEOPLE_NOTE_SENDERS
                and not self.verified_health_question(message))

    def verified_health_question(self, message):
        """For DISPLAY (sol and Kimi on 7cf0ca57): Health's idle question proven by its structured event alone, sender
        Health and extra.event health_question (IdleWatch.ask writes it), read from the stored row when a live view
        carries none. No text fallback: a row with no or unreadable extra is not marked and keeps its words. (Routing
        keeps _health_question's text fallback, which fails closed for whose chat a row belongs to.)"""
        if not isinstance(message, dict) or message.get("sender") != HEALTH_SENDER:
            return False
        extra = message.get("extra")
        if extra is None and "extra" not in message and message.get("id"):
            stored = self.db.one("SELECT extra FROM messages WHERE id = ?", (message["id"],))
            extra = stored["extra"] if stored else None
        if isinstance(extra, str):
            try:
                extra = json.loads(extra)
            except ValueError:
                return False
        return isinstance(extra, dict) and extra.get("event") == HEALTH_QUESTION

    def sender_name(self, sender):
        """Who sent a message, for display: a person's name, a mind's name, or None (the loopback operator, the hive)."""
        sender = str(sender or "")
        if sender.startswith("agent:"):
            a = self.db.one("SELECT name FROM agents WHERE id = ?", (sender[6:],))
            return a["name"] if a else None
        if sender.startswith("user:u_"):
            p = self.db.one("SELECT name, email FROM people WHERE id = ?", (sender[5:],))
            return (p.get("name") or p.get("email")) if p else None
        if sender.startswith("user:") and sender != "user:operator" and len(sender) > 5:
            return sender[5:].capitalize()          # a family sign-in principal (as /api/auth/me names it)
        return None

    # ---- one person's chat with a mind (mind-chat-identity r1) ---------------------------------------------------
    # The classic chat (c_<mind>) is the loopback operator's; each named person talks to a mind in their own
    # conversation, c_<mind>~<principal>, and reads only that one. A conversation chosen by id belongs to whoever spoke
    # in it first. Room and Ask conversations keep their own rules (rooms.can_see, the asker); so do the hive's own
    # notes to a mind and a mind's output outside anyone's conversation (the ordinary visibility rules).

    def person_conversation(self, agent_id, principal):
        return f"c_{agent_id}" if principal == "user:operator" else f"c_{agent_id}~{principal}"

    def _shared_conversation(self, agent_id, conversation_id):
        """A room's or an Ask turn's conversation: judged by those rules, never as one person's chat."""
        conversation_id = str(conversation_id or "")
        if conversation_id.startswith("ask:"):
            return True
        if conversation_id == f"c_{agent_id}" or conversation_id.startswith(f"c_{agent_id}~"):
            return False
        return self.rooms.room_for_conversation(conversation_id) is not None

    def conversation_owner(self, agent_id, conversation_id):
        """The person a mind's conversation belongs to, or None (a room, an Ask turn, or no person spoke in it)."""
        conversation_id = str(conversation_id or f"c_{agent_id}")
        if conversation_id == f"c_{agent_id}":
            return "user:operator"
        if conversation_id.startswith(f"c_{agent_id}~user:"):
            return self._named_owner(agent_id, conversation_id)
        if self._shared_conversation(agent_id, conversation_id):
            return None
        first = self.db.one("SELECT sender FROM messages WHERE agent_id = ? AND conversation_id = ? AND direction = 'in' "
                            "AND sender LIKE 'user:%' ORDER BY created_at, rowid LIMIT 1", (agent_id, conversation_id))
        return first["sender"] if first else None

    @staticmethod
    def _named_owner(agent_id, conversation_id):
        """The person a conversation id names: c_<mind>~<principal> or c_<mind>~<principal>~<their own suffix>."""
        return conversation_id[len(f"c_{agent_id}~"):].split("~", 1)[0]

    def may_post(self, agent_id, conversation_id, principal):
        """Whether a named person may speak into a (non-room) conversation they named: only one bound to them by its id,
        c_<mind>~<principal>[~<suffix>]. A new conversation is created in that namespace, so it is theirs from the first
        message; anyone else's, the operator's c_<mind>, and any id of unknown ownership are refused, admins included
        (r3: Kimi, stand-in). Admins audit other people's chats read-only, with ?include=all."""
        conversation_id = str(conversation_id or "")
        return (principal != "user:operator" and conversation_id.startswith(f"c_{agent_id}~user:")
                and self._named_owner(agent_id, conversation_id) == principal)

    def chat_visible(self, principal, message):
        """For one stored or published message: False when it is another person's chat with the mind; True when it is
        this person's own; None when it is not anyone's chat (the ordinary rules decide). Both directions: the mind's
        replies in a person's conversation are that person's chat as much as what was said to it.
        The loopback operator reads the whole stream of a shared or public mind (None), but on a personal mind it is
        scoped like any other admin: its person's conversations are theirs, both directions (Kimi idle-minds r2.1
        sharpest); the operator's own c_<mind> stays the operator's."""
        agent_id, conversation_id = message.get("agent_id"), message.get("conversation_id")
        if not agent_id:
            return None
        personal = self._personal_of(agent_id, memo=True)   # chat_visible serves the live socket: a 2 s memo
        if principal == "user:operator" and not personal:
            return None
        sender, inbound = str(message.get("sender") or ""), message.get("direction") == "in"
        if inbound and sender == principal:
            return True
        owner = self.conversation_owner(agent_id, conversation_id)
        if owner is None:
            return None
        if owner == principal:
            return True
        # a personal mind: only real hive notes (hive:* senders) are no one's chat; another mind's message to it is
        # its person's, like theirs (Kimi idle-minds r2 sharpest). Elsewhere a mind's message is a note only from a
        # real, non-deleted mind; an agent:* sender that resolves to none fails closed (Kimi idle-minds r2.1 #1).
        noted = sender.startswith("hive:") if personal else self._noted_sender(sender, memo=True)
        if inbound and noted and not self._health_question(message):
            return None                     # the hive's own note to the mind (goals, alerts, schedule...)
        return False                        # Health's idle question follows the chat it sits in (idle-minds r2)

    def _noted_sender(self, sender, memo=False):
        """On a shared or public mind, whether an inbound sender in someone else's conversation is a note (not their
        chat): anything but a person, and an agent:* sender only when it is a real, non-deleted mind. The same rule as
        messages()' SQL (_NOTED_SQL)."""
        if sender.startswith("user:"):
            return False
        if sender.startswith("agent:"):
            return self._real_mind(sender[6:], memo)
        return True

    def _real_mind(self, agent_id, memo=False):
        """Whether this id is a real, non-deleted mind here (agent:* senders: _noted_sender, _is_input)."""
        if memo:
            return self._live_memo(("real", agent_id), lambda: self._real_mind(agent_id))
        return self.db.one("SELECT 1 AS x FROM agents WHERE id = ? AND deleted = 0", (agent_id,)) is not None

    LIVE_MEMO_S = 2.0

    def _live_memo(self, key, compute):
        """A 2 s memo for the live socket's per-frame lookups (Kimi idle-minds r2.2 #3), like Visibility.hidden_ids'
        2 s cache on a viewer. Only chat_visible (live frames) reads through it; HTTP reads, messages()' SQL and every
        write path look up fresh. A soft delete clears it (forget_live_memo), so a deleted mind's agent:* sender fails
        closed at once; personal_of is set when a mind is made and never changes."""
        memo = self.__dict__.setdefault("_live_memo_cache", {})
        hit = memo.get(key)
        at = time.monotonic()
        if hit is not None and at - hit[0] < self.LIVE_MEMO_S:
            return hit[1]
        value = compute()
        if len(memo) > 4096:
            memo.clear()
        memo[key] = (at, value)
        return value

    def forget_live_memo(self):
        self.__dict__.get("_live_memo_cache", {}).clear()

    # messages()' SQL for _noted_sender (shared and public minds) and for a personal mind (real hive notes only)
    _NOTED_SQL = ("(sender NOT LIKE 'user:%' AND (sender NOT LIKE 'agent:%' "
                  "OR substr(sender, 7) IN (SELECT id FROM agents WHERE deleted = 0)))")
    _PERSONAL_NOTED_SQL = "sender LIKE 'hive:%'"

    def _health_question(self, message):
        """Health's idle question (health.py IdleWatch.ask): it names what the mind owes (goals, who wrote to it), so
        it is never shown as a hive note in someone else's chat; its record is read through the Health idle routes.
        Decided by the structured event IdleWatch.ask writes (extra.event, Kimi idle-minds r2 #2), read from the stored
        row when a live frame carries none; the text prefix only for a row with no (or unreadable) extra, which fails closed."""
        if message.get("sender") != HEALTH_SENDER:
            return False
        extra = message.get("extra")
        if extra is None and "extra" not in message and message.get("id"):   # a live frame (message_view): the stored row
            stored = self.db.one("SELECT extra FROM messages WHERE id = ?", (message["id"],))
            extra = stored["extra"] if stored else None
        if isinstance(extra, str):          # as stored: JSON text (the same rule as messages()' SQL)
            try:
                extra = json.loads(extra)
            except ValueError:
                # an extra is present but unreadable: the text prefix decides, failing closed; say so once per message
                # so the divergence is observable (Kimi idle-minds r2.1 #2)
                mid = str(message.get("id") or "")
                if mid not in _HEALTH_FALLBACK_LOGGED and len(_HEALTH_FALLBACK_LOGGED) < 10000:
                    _HEALTH_FALLBACK_LOGGED.add(mid)
                    log.warning("hive:health message %s has an unreadable extra; judged by its text prefix", mid or "?")
                return str(message.get("text") or "").startswith(HEALTH_QUESTION_TAG)
        elif extra is None:
            return str(message.get("text") or "").startswith(HEALTH_QUESTION_TAG)
        return isinstance(extra, dict) and extra.get("event") == HEALTH_QUESTION

    def _others_conversations(self, agent_id, principal):
        """The conversations of this mind that belong to someone other than this person."""
        owners = {f"c_{agent_id}": "user:operator"}
        named = f"c_{agent_id}~user:"
        for r in self.db.all("SELECT DISTINCT conversation_id FROM messages WHERE agent_id = ? AND substr(conversation_id, 1, ?) = ?",
                             (agent_id, len(named), named)):
            # a conversation bound to a person by its id is theirs even if only the hive or the mind spoke in it yet
            # (Health's question to a personal mind is sent there: idle-minds r2)
            owners[r["conversation_id"]] = self._named_owner(agent_id, r["conversation_id"])
        rows = self.db.all("SELECT conversation_id, sender FROM messages WHERE agent_id = ? AND direction = 'in' "
                           "AND sender LIKE 'user:%' ORDER BY created_at, rowid", (agent_id,))
        for r in rows:
            c = r["conversation_id"]
            if c in owners:
                continue
            if c.startswith(f"c_{agent_id}~user:"):
                owners[c] = self._named_owner(agent_id, c)
            elif not self._shared_conversation(agent_id, c):
                owners[c] = r["sender"]
        return sorted(c for c, o in owners.items() if o != principal)

    def _personal_of(self, agent_id, memo=False):
        """The person whose personal mind this is, or None."""
        if memo:
            return self._live_memo(("personal", agent_id), lambda: self._personal_of(agent_id))
        try:
            row = self.db.one("SELECT personal_of FROM agents WHERE id = ?", (agent_id,))
        except sqlite3.OperationalError:          # personal_of not added yet (personal.migrate runs later)
            return None
        return row.get("personal_of") if row else None

    def messages(self, agent_id, conversation_id=None, limit=200, principal=None):
        """A mind's messages. With a principal, only what that person may read of its chats: their own conversations,
        their own messages, and what is no one's conversation (the caller still applies the ordinary visibility)."""
        self._agent_row(agent_id)
        sql = "SELECT * FROM messages WHERE agent_id = ?"
        params = [agent_id]
        if conversation_id:
            sql += " AND conversation_id = ?"
            params.append(conversation_id)
        scope, scope_params = self.reader_scope(agent_id, principal)
        sql += scope + " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        params += [*scope_params, int(limit)]
        return [self.message_view(r) for r in reversed(self.db.all(sql, params))]

    def reader_scope(self, agent_id, principal):
        """The SQL (" AND ...", params) for the messages rows of this mind one person may read: messages() and a
        placement export that is not its person's or an admin's audit (stand-in idle-minds r2.2 P1 #2) share it.
        No principal: every row (an audit, or the mind's own migration)."""
        # The loopback operator reads the whole stream, except a personal mind's: its person's chats with it are theirs
        # (Jon 2026-10-09; idle-minds r2), so the operator is scoped there like any other admin. Audit is ?include=all.
        personal = self._personal_of(agent_id)
        if not principal or (principal == "user:operator" and not personal):
            return "", []
        others = self._others_conversations(agent_id, principal)
        if not others:
            return "", []
        # in someone else's chat a person reads their own messages and the hive's notes to the mind; on a personal mind
        # only real hive notes (hive:*), never another mind's message (Kimi idle-minds r2 sharpest); never Health's
        # question (its structured event, chat_visible's rule)
        noted = self._PERSONAL_NOTED_SQL if personal else self._NOTED_SQL
        # messages.extra is NULL or JSON text written by json.dumps (enqueue_message); never a bare dict or other text.
        # json_valid() relies on that; anything else falls to the text prefix, failing closed (Kimi idle-minds r2.1 #3)
        sql = (f" AND (conversation_id NOT IN ({','.join('?' * len(others))}) "
               f"OR (direction = 'in' AND (sender = ? OR ({noted} AND NOT (sender = ? AND ("
               "CASE WHEN json_valid(extra) THEN COALESCE(json_extract(extra, '$.event') = ?, 0) "
               "ELSE substr(text, 1, ?) = ? END))))))")
        return sql, [*others, principal, HEALTH_SENDER, HEALTH_QUESTION, len(HEALTH_QUESTION_TAG), HEALTH_QUESTION_TAG]

    def enqueue_message(self, agent_id, text, conversation_id, sender, extra=None):
        """Store a message for a mind in its hub outbox (replayed on reconnect from hub_seq); the caller delivers it."""
        with self.db.transaction():
            seq = self.db.one("SELECT COALESCE(MAX(hub_seq), 0) AS seq FROM messages WHERE agent_id = ?", (agent_id,))["seq"] + 1
            message = {
                "id": new_id("m"), "agent_id": agent_id, "conversation_id": conversation_id or f"c_{agent_id}",
                "direction": "in", "sender": sender, "text": str(text), "hub_seq": seq, "created_at": now(),
                "extra": json.dumps(extra) if extra else None,
            }
            self.db.insert("messages", message)
            if self._is_input(agent_id, sender, extra):
                self.mark_input(agent_id, message["created_at"])
        return message

    def _is_input(self, agent_id, sender, extra):
        """Whether an inbound message is real input to the idle signal: anything a person or mind sends, but none of
        the hive's own housekeeping (hive:* senders: Health's questions and alerts, goal and review notes, schedule
        wakes, approvals, shares), except a goal assigned directly to this mind (Kimi idle-minds r1 K3: machine chatter
        must not keep a mind awake against its owner's idle_sleep_minutes). An agent:* sender is input only from a real,
        non-deleted mind (_noted_sender's resolution): a message from a mind that does not exist is no one's input
        (Kimi idle-minds r2.2 sharpest)."""
        sender = str(sender or "")
        if sender.startswith("agent:"):
            return self._real_mind(sender[6:])
        if not sender.startswith("hive:"):
            return True
        if not isinstance(extra, dict) or extra.get("event") != "goal" or not extra.get("goal_id"):
            return False
        goal = self.db.one("SELECT assignee FROM goals WHERE id = ?", (extra["goal_id"],))
        return bool(goal and goal["assignee"] == agent_id)

    def mark_input(self, agent_id, at=None):
        """The idle signal (agents.last_input_at): real input to a mind or meaningful output from it. Stamped on an
        inbound message from a person or mind (or a goal assigned to this mind; never the hive's housekeeping notes, see
        _is_input), a goal claim, heartbeat or result, a published belief and a message the mind sends. Model spend
        never stamps it: a mind thinking with nothing coming in is what Health notices (health.py idle pass), and what
        an owner's idle_sleep_minutes counts from."""
        self.db.execute("UPDATE agents SET last_input_at = ? WHERE id = ?", (at or now(), agent_id))

    async def send_to_agent(self, agent_id, text, conversation_id=None, sender="user:operator", extra=None, from_room=False,
                            fence=None, wake=True):
        row = self._agent_row(agent_id)
        if not str(text).strip():
            raise HiveError(400, "bad_request", "text is required")
        if str(conversation_id or "").startswith("ask:"):
            raise HiveError(400, "bad_request", "Ask turns are answered through /api/ask")   # only ask.py addresses a turn
        if not from_room and self.rooms.is_coffee(conversation_id):
            # The Coffee Room delivers only through itself (mentions, a person's @here, the public-room notice).
            raise HiveError(400, "bad_request", "speak in the Coffee Room through the room, not a direct message")
        if not from_room and self.rooms.is_team_conversation(conversation_id):
            # a swarm's team room is reached only through the room, by its members (stand-in R1)
            raise HiveError(400, "bad_request", "speak in a swarm's room through the room, not a direct message")
        # research.py: the Research swarm's coordinator never thinks. Policy denies it every skill by a host rule no
        # person's rule reaches, and research starts from Ask, so a model turn here could only tell the person to get an
        # administrator to enable a skill nobody can give (tester report 11-13). What is sent to it is kept but never
        # reaches or wakes it, and a person or mind who wrote to it gets the hive's own answer: where research starts.
        research = getattr(self, "research", None)
        answered = research is not None and research.is_coordinator(agent_id)
        if answered:
            extra, wake = {**(extra or {}), "host_answered": True}, False
        if wake and self.newhive is not None and row["status"] == "asleep" and self.supervisor:
            # new-hive R1b (Kimi R1a P2-4): this delivery would wake the mind, and no mind wakes before coding readiness;
            # refuse before anything is stored, mirrored or published, so the person never sees a half-delivered message
            self.newhive.require_coding("mind_wake")
        if fence is None:
            message = self.enqueue_message(agent_id, text, conversation_id, sender, extra)
        else:   # a room delivery: the mind's place is re-checked and the message stored under one fence (rooms.py)
            with fence() as allowed:
                if not allowed:
                    raise HiveError(409, "not_member", "that mind is no longer in the room")
                message = self.enqueue_message(agent_id, text, conversation_id, sender, extra)
        if not from_room:   # the classic chat and hive notes keep the mind's DM room whole (R15)
            try:
                # the DM room copy is the people's transcript (sol and Kimi on 7cf0ca57): a VERIFIED Health question goes
                # in untagged, from Health, marked health_check, with its source message's id (the tagged canonical row
                # the mind read); anything else, a Health alert quoting the tag included, goes in exactly as sent, and a
                # note only the mind reads (mind_only) goes in marked, so the room stays whole and people's pages leave it out
                verified = self.verified_health_question(message)
                self.rooms.mirror_in(agent_id, message["conversation_id"], sender,
                                     for_people(sender, message["text"]) if verified else message["text"],
                                     source_message_id=message["id"], health_check=verified,
                                     mind_only=not verified and self.mind_only(message))
            except Exception:
                log.exception("room mirror failed for %s", agent_id)
        view = self.message_view(message)
        self.events.publish("message", message=view)
        if answered:
            if str(sender).startswith(("user:", "agent:")):   # the hive's own notes (hive:*) need no answer
                from .research import COORDINATOR_REPLY
                self.record_agent_message(agent_id, {"text": COORDINATOR_REPLY, "conversation_id": message["conversation_id"],
                                                     "client_seq": "host-answer-" + message["id"]})
            return view
        await self.deliver(agent_id, message)
        # J3 R5.1: wake=False stores and delivers only (a connected mind gets it; a sleeping one reads it whenever it is
        # next woken for another reason). Studio's GOAL-CANCELLED uses it, so a Stop never starts the mind it stopped
        if wake and row["status"] == "asleep" and self.supervisor:
            try:
                self.lifecycle(agent_id, "wake", expect=lambda fresh: fresh["status"] == "asleep")
            except HiveError as exc:
                if exc.code != "studio_owned":
                    raise
                # J3 R3: the wake is refused while Studio owns the maker; the message stays queued for it
        return view

    def envelope(self, message):
        body = {"hive": 1, "sender": message["sender"], "conversation_id": message["conversation_id"],
                "message_id": message["id"], "text": message["text"]}
        if str(message["sender"]).startswith("user:") and message["sender"] != "user:operator":
            name = self.sender_name(message["sender"])   # who is speaking, by name (a room's extra may say it too)
            if name:
                body["sender_name"] = name
        if message.get("extra"):
            body.update(json.loads(message["extra"]))
        return json.dumps(body)

    async def deliver(self, agent_id, message):
        """Send a stored message on the mind's socket now, after any older one the socket has not had. False when it did
        not go: no socket, a socket whose resume is not answered yet (the replay sends it, in order), a message Studio
        holds or never delivers, or a failed send (the next connection's resume sends it). Port of upstream #21."""
        ws = self.connections.get(agent_id)
        if not await self._flush(agent_id, ws):
            return False
        mark = self.sent_upto.get(agent_id)
        return (mark is not None and mark[0] is ws and mark[1] is not None and mark[1] >= message["hub_seq"]
                and not self._never_delivered(agent_id, message))

    async def replay(self, agent_id, last_seen):
        """Answer a mind's resume (only the channel's resume frame calls this): send every stored message after
        last_seen that this socket has not had, in hub_seq order, and deliver live from then on. Nothing goes live
        before it, so a message stored while the mind was offline never follows a newer one, which the channel would
        drop as already seen (upstream #18/#21). A second resume on the same socket never moves the mark back."""
        ws = self.connections.get(agent_id)
        mark = self.sent_upto.get(agent_id)
        if ws is None or mark is None or mark[0] is not ws:
            return
        if mark[1] is None:
            self.sent_upto[agent_id] = (ws, int(last_seen or 0))
        await self._flush(agent_id, ws)

    async def release_held(self, agent_id):
        """Studio's release after a handoff: send what it held, in order, on a socket whose resume is answered. On a
        socket not yet resumed it does nothing; that socket's own resume sends the released messages (review P1: a
        release must never set a new socket's mark in place of the channel's real last_seen)."""
        await self._flush(agent_id, self.connections.get(agent_id))

    def _never_delivered(self, agent_id, message):
        """R8.5: a Studio session's own GOAL-CANCELLED never reaches its maker (Stop settled it); and a message the hive
        answered itself (send_to_agent, the Research coordinator) never reaches the mind, a resume's replay included."""
        if message.get("extra") and json.loads(message["extra"]).get("host_answered") is True:
            return True
        studio = getattr(self, "studio", None)
        stale = getattr(studio, "stale_goal_notice", None)
        return stale is not None and bool(stale(agent_id, message))

    async def _flush(self, agent_id, ws):
        lock = self.flush_locks.setdefault(agent_id, asyncio.Lock())
        async with lock:
            return await self._flush_locked(agent_id, ws)

    async def _flush_locked(self, agent_id, ws):
        """Send ws the mind's stored messages above its mark, in hub_seq order; False if ws is not the mind's live
        socket, its resume is not answered, or a send failed. Runs under the mind's flush lock, so flushes never
        interleave; the mark is still raised before each send, and the identity and mark are re-read per row, so a
        flush that waited on the lock sends nothing twice and nothing after a higher seq.
        Studio (J3 R3, handoff spec r2.4 §6): a held message STOPS the flush without raising the mark (nothing newer may
        overtake it); Studio's release replays from there. A never-delivered notice (R8.5) is passed over: the mark
        rises past it and it is not sent."""
        mark = self.sent_upto.get(agent_id)
        if ws is None or mark is None or mark[0] is not ws or mark[1] is None:
            return False
        studio = getattr(self, "studio", None)
        rows = self.db.all(
            "SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' AND hub_seq > ? AND text != '' ORDER BY hub_seq",   # '' = a deleted Ask
            (agent_id, mark[1]),
        )
        for row in rows:
            mark = self.sent_upto.get(agent_id)
            if mark is None or mark[0] is not ws:
                return False                     # withdrawn or replaced meanwhile
            if row["hub_seq"] <= mark[1]:
                continue                         # an interleaved flush sent it
            if studio is not None and studio.holds_messages(agent_id, row["hub_seq"]):
                return True                      # held: nothing at or after it goes until Studio releases
            self.sent_upto[agent_id] = (ws, row["hub_seq"])
            if self._never_delivered(agent_id, row):
                continue
            try:
                # bounded: a send that never resolves would hold this mind's flush lock, so its replacement connection
                # would wait too (review r1.2, liveness); a timeout counts as a failed send
                await asyncio.wait_for(
                    ws.send_text(json.dumps({"type": "user_message", "seq": row["hub_seq"], "text": self.envelope(row)})),
                    SEND_TIMEOUT)
            except asyncio.CancelledError:
                # cancelled mid-send: the frame may or may not have gone, and the mark is already past it. End the
                # socket the same way, closing it in the background (this task is being cancelled), then let the
                # cancellation through.
                close = self._end_live_delivery(agent_id, ws)
                if close is not None:
                    task = asyncio.ensure_future(self._close_failed(close))
                    self._closing.add(task)
                    task.add_done_callback(self._closing.discard)
                raise
            except Exception:
                # the mark is already past this seq, so nothing more may go on this socket: a later send succeeding
                # would leave this one lost (review P2). The socket stops being live and is closed; the channel
                # reconnects and its resume resends from its own last_seen.
                close = self._end_live_delivery(agent_id, ws)
                if close is not None:
                    await self._close_failed(close)
                return False
            if row.get("extra") and '"mind_prompt"' in row["extra"]:
                self.minds.delivered(agent_id, row)   # r2.12 §3: the hub sent the frame (not yet acknowledged)
        return True

    def _end_live_delivery(self, agent_id, ws):
        """A send on ws failed or was cancelled after the mark passed its seq: ws stops being the mind's live socket
        (nothing more is sent on it). Returns ws's close method, if it has one, for the caller to run."""
        if (self.sent_upto.get(agent_id) or (None,))[0] is ws:
            self.sent_upto.pop(agent_id, None)
        close = getattr(ws, "close", None)
        return close if callable(close) else None

    @staticmethod
    async def _close_failed(close):
        """Close a socket whose send failed (code 1011), bounded, ignoring errors: the channel reconnects and resumes."""
        with contextlib.suppress(Exception):
            await asyncio.wait_for(close(code=1011), CLOSE_TIMEOUT)

    def record_agent_message(self, agent_id, frame):
        text = str(frame.get("text", ""))
        client_seq = str(frame.get("client_seq") or new_id("cs"))
        existing = self.db.one("SELECT * FROM messages WHERE agent_id = ? AND client_seq = ?", (agent_id, client_seq))
        if existing:
            return self.message_view(existing)
        message = {
            "id": new_id("m"), "agent_id": agent_id,
            "conversation_id": str(frame.get("conversation_id") or f"c_{agent_id}"),
            "direction": "out", "sender": f"agent:{agent_id}", "text": text, "client_seq": client_seq,
            "created_at": now(),
        }
        asked = message["conversation_id"].startswith("ask:")
        with self.db.transaction():   # serialized with an owner's thread deletion: a deleted Ask keeps no later content
            if asked and self.ask.deleted(message["conversation_id"]):
                return {**self.message_view({**message, "text": ""}), "dropped": True}
            self.db.insert("messages", message)
        self.db.update("agents", agent_id, {"last_active_at": message["created_at"], "last_input_at": message["created_at"]})
        try:
            self.health.on_mind_message(agent_id, message)   # the mind's answer to an open Health question, if any
        except Exception:
            log.exception("health reply record failed for %s", agent_id)
        if asked:   # a reply bound to one Ask turn by its host-issued id (ask.py)
            try:
                self.ask.reply(agent_id, message["conversation_id"], text, source_message_id=message["id"])
            except Exception:
                log.exception("ask reply failed for %s", agent_id)
        try:   # the reply lands in its room; minds it @mentions hear it (bounded by the room's turn cap)
            delivery = self.rooms.mirror_out(agent_id, message["conversation_id"], text, source_message_id=message["id"])
            if delivery is not None:
                try:
                    asyncio.get_running_loop().create_task(delivery)
                except RuntimeError:
                    delivery.close()
        except Exception:
            log.exception("room mirror failed for %s", agent_id)
        try:   # @Name of another mind in the mind's own message box: into their DM (rooms.relay_box, throughput.py)
            relay = self.rooms.relay_box(agent_id, message["conversation_id"], text)
            if relay is not None:
                try:
                    asyncio.get_running_loop().create_task(relay)
                except RuntimeError:
                    relay.close()
        except Exception:
            log.exception("mind DM failed for %s", agent_id)
        view = self.message_view(message)
        if not (asked and self.ask.deleted(message["conversation_id"])):   # deleted meanwhile: its sweep already emptied it
            self.events.publish("message", message=view)
        return view

    def _connection_lock(self, agent_id):
        """The mind's plain lock (not a transition: admitting or registering a socket is not a lifecycle change)."""
        lock = getattr(self.supervisor, "lock", None) if self.supervisor is not None else None
        return lock(agent_id) if callable(lock) else contextlib.nullcontext()

    def _lifecycle_generation(self, agent_id):
        generation = getattr(self.supervisor, "generation", None) if self.supervisor is not None else None
        return generation(agent_id) if callable(generation) else None

    def _admit_connection(self, agent_id):
        """Early refusal before the socket is accepted, on the fresh row under the mind's lock: an Admission carrying
        the lifecycle generation it saw, or None. A hive-run mind is admitted only while its desired state is awake; a
        connection racing an in-flight start or stop waits here for the recorded outcome (BYPASS-1). This decides
        nothing for good and writes nothing: the registration fence after the accept does (Review B1). External
        members (kind module) run outside the hive and are admitted as before."""
        with self._connection_lock(agent_id):
            row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if row is None or (row["kind"] != "module" and row["desired"] != "awake"):
                return None
            return Admission(agent_id, self._lifecycle_generation(agent_id))

    async def admit_connection(self, agent_id):
        """_admit_connection off the event loop: it may wait on the mind's lock for an in-flight start or stop."""
        admission = await asyncio.to_thread(self._admit_connection, agent_id)
        if admission is None:
            log.info("hub connection for %s refused: the mind is not meant to be awake", agent_id)
        return admission

    def _register_connection(self, agent_id, ws, admission):
        """The registration fence (Review B1): check and register in one section under the mind's lock, after the
        socket's accept. A hive-run mind registers only while desired is still awake and, when the admission carries a
        lifecycle generation, only while that generation is still current: a stop, sleep, delete or move after the
        admission (or a stop and a new start) refuses it. Every stop withdraws a registered connection under the same
        lock (Supervisor.stop -> withdraw_connection), so registration and withdrawal are serialized whichever wins.
        Returns (registered, previous connection)."""
        with self._connection_lock(agent_id):
            row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if row is None:
                return False, None
            if row["kind"] != "module":
                if row["desired"] != "awake":
                    return False, None
                pinned = admission.generation if isinstance(admission, Admission) else None
                if pinned is not None and pinned != self._lifecycle_generation(agent_id):
                    return False, None
            previous = self.connections.get(agent_id)
            self.connections[agent_id] = ws
            self.sent_upto[agent_id] = (ws, None)   # nothing goes live on a new socket before its resume is answered
            # A host-observed boot generation: each connection is a new one, so evidence about a process (S4 boot
            # receipts) can be bound to the connection it arrived on (OmegaReview 2026-10-04, replayed receipts).
            self.boot_generation[agent_id] = self.boot_generation.get(agent_id, 0) + 1
            # A random host-issued nonce per connection: a boot receipt must echo the nonce of the connection it
            # describes, and a hive restart issues fresh ones, so no stored receipt survives as "current".
            self.boot_nonce[agent_id] = secrets.token_hex(16)
            if row["status"] in ("created", "starting", "asleep", "stopped", "error"):
                self.db.update("agents", agent_id, {"status": "awake", "desired": "awake"})
            return True, (previous if previous is not ws else None)

    async def agent_connected(self, agent_id, ws, admitted=None):
        """Registers a hub connection through the registration fence; False (nothing registered, no nonce, the row
        unchanged) when the mind is not meant to be awake or its lifecycle moved on since the admission. admitted is
        the Admission the hub took before accepting the socket; without one the connection is admitted here first.
        Admission alone never registers: the fence re-checks after every await."""
        if not admitted:
            admitted = await self.admit_connection(agent_id)
            if not admitted:
                return False
        registered, previous = await asyncio.to_thread(self._register_connection, agent_id, ws, admitted)
        if not registered:
            log.info("hub connection for %s not registered: stopped or restarted since its admission", agent_id)
            return False
        if previous is not None:
            with contextlib.suppress(Exception):
                await previous.close(code=4000)
        self.emit_agent(agent_id)
        self.minds.connected(agent_id)
        return True

    def withdraw_connection(self, agent_id, code=4409):
        """A stop won: the mind's registered connection ends, with its nonce. Called by Supervisor.stop under the mind's
        lock, from any thread; the socket's close is scheduled on the hive's event loop."""
        ws = self.connections.pop(agent_id, None)
        self.sent_upto.pop(agent_id, None)
        self.boot_nonce.pop(agent_id, None)
        studio = getattr(self, "studio", None)
        if studio is not None:
            studio.disconnected(agent_id)   # J3 R3 (H3.1): the maker's hub registration ends with the connection
        if ws is None:
            return
        # Merge join (mind control): agent_disconnected will not see this socket any more, so a child's sent but
        # unacknowledged prompts are marked interrupted here, as they would be on a disconnect.
        with contextlib.suppress(HiveError):
            self.minds.disconnected(agent_id)
        loop = getattr(self.events, "_loop", None)
        close = getattr(ws, "close", None)
        if loop is not None and callable(close) and not loop.is_closed():
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            try:
                if running is loop:
                    loop.create_task(close(code=code))
                else:
                    asyncio.run_coroutine_threadsafe(close(code=code), loop)
            except Exception:
                log.warning("could not close the withdrawn connection of %s", agent_id)
        with contextlib.suppress(HiveError):
            self.emit_agent(agent_id)

    def agent_disconnected(self, agent_id, ws):
        if self.connections.get(agent_id) is ws:
            del self.connections[agent_id]
            self.sent_upto.pop(agent_id, None)
            # No connection, no current nonce: a receipt cannot be accepted for a connection that has ended (Kimi 2026-10-04).
            self.boot_nonce.pop(agent_id, None)
            studio = getattr(self, "studio", None)
            if studio is not None:
                studio.disconnected(agent_id)
            self.minds.disconnected(agent_id)
            try:
                self.emit_agent(agent_id)
            except HiveError:
                pass

    # ---- beliefs -------------------------------------------------------------------------------

    def _mint_stamp(self, agent_id):
        self.db.execute("UPDATE agents SET evidence_counter = evidence_counter + 1 WHERE id = ?", (agent_id,))
        counter = self.db.one("SELECT evidence_counter FROM agents WHERE id = ?", (agent_id,))["evidence_counter"]
        return [f"ev:{agent_id}:{counter}"]

    def grows_vocabulary(self, agent):
        """Whether a statement ``agent`` publishes may add its words to its swarm's vocabulary: only when the mind acts
        for someone who controls the swarm (Viewer.controls: a hive admin, the swarm's owner or its person), the rule
        app.py's vocabulary route holds people to, since the vocabulary decides which statements the commons admits.
        A mind acts for its owner (the operator, for one made before owners were recorded) and, for a person's own mind,
        that person, each with their current role. Any other mind publishes in the vocabulary as it stands, and
        hive-publish! quarantines a statement with a word outside it, naming the word, until the swarm's control adds
        it (the Psynese vocabulary in docs/omegadots/PLAN.md: an unknown symbol is quarantined)."""
        from .visibility import Viewer
        swarm = self.db.one("SELECT owner, personal_of FROM swarms WHERE id = ?", (agent["swarm_id"],))
        if swarm is None or self.person_role is None:
            return False
        for principal in (agent.get("owner") or "user:operator", agent.get("personal_of")):
            role = self.person_role(principal) if principal else None
            if role in ("admin", "member") and Viewer(principal, role == "admin").controls(swarm):
                return True
        return False

    def publish(self, agent_id, statement, f, c, evidence=None, new_evidence=False):
        """Publish a belief to the agent's swarm commons.

        Without ``evidence`` the agent's own evidence for this statement is
        reused: saying the same thing again is not a new observation, so it
        cannot inflate confidence by revising with itself.  ``new_evidence``
        mints a fresh id for a genuinely new observation.
        """
        row = self._agent_row(agent_id)
        if not row["swarm_id"]:
            raise HiveError(400, "no_swarm", "agent is not in a swarm")
        if not evidence and not new_evidence:
            try:
                canonical = self.spaces.statement_text(statement)
            except ValueError as exc:
                raise HiveError(400, "bad_statement", str(exc)) from exc
            evidence = self._evidence_for(agent_id, row["swarm_id"], canonical)
        if evidence:
            # Cited evidence must already exist: minted earlier for this agent, or
            # seen in the hive.  Otherwise an agent could fabricate "independent"
            # evidence and inflate confidence through revision.
            for item in evidence:
                kind, _, rest = str(item).partition(":")
                owner, _, number = rest.rpartition(":")
                own = owner == agent_id and number.isdigit() and 0 < int(number) <= row["evidence_counter"]
                well_formed = kind == "ev" and bool(owner) and number.isdigit()
                # Exact membership in a stored stamp, never a LIKE pattern: '%' or '_' in an id must not
                # match other evidence (security fix 2026-10-04).
                seen = well_formed and self._evidence_seen(str(item))
                if not well_formed or not (own or seen):
                    raise HiveError(400, "bad_evidence", f"unknown evidence {item}")
            stamp = list(evidence)
        else:
            stamp = self._mint_stamp(agent_id)
        try:
            result = self.spaces.publish(row["swarm_id"], agent_id, statement, f, c, stamp,
                                         open_vocab=self.grows_vocabulary(row))
        except ValueError as exc:
            raise HiveError(400, "bad_statement", str(exc)) from exc
        assertion = {
            "swarm_id": row["swarm_id"], "agent_id": agent_id, "statement": result["statement"],
            "f": float(f), "c": float(c), "stamp": json.dumps(stamp), "outcome": result["outcome"],
            "created_at": now(),
        }
        self.db.insert("assertions", assertion)
        self.db.update("agents", agent_id, {"last_active_at": assertion["created_at"], "last_input_at": assertion["created_at"]})
        view = self.assertion_view(assertion)
        if "unmapped" in result:
            view["unmapped"] = result["unmapped"]
        self.events.publish("belief.published", swarm_id=row["swarm_id"], assertion=view)
        if result["outcome"] in ("adopted", "revised", "chosen"):
            belief = self.belief(row["swarm_id"], result["statement"], detail=False)
            if belief:
                self.events.publish("belief.updated", belief=belief, outcome=result["outcome"])
        return view

    def assertion_view(self, row):
        return {"agent_id": row["agent_id"], "statement": row["statement"],
                "tv": {"f": row["f"], "c": row["c"]}, "stamp": json.loads(row["stamp"]),
                "outcome": row["outcome"], "created_at": row["created_at"]}

    def beliefs(self, swarm_id, viewer=None):
        """A swarm's beliefs as a person who can see it reads them: the commons and each member mind's own beliefs as
        their links admit, of the minds this person may see (seen_minds), with who holds each."""
        self.swarm(swarm_id)
        return [self._belief_meta(swarm_id, item)
                for item in self.spaces.beliefs(swarm_id, among=self.seen_minds(swarm_id, viewer))]

    def belief_count(self, swarm_id, viewer=None):
        return self.spaces.count(swarm_id, among=self.seen_minds(swarm_id, viewer))

    def seen_minds(self, swarm_id, viewer=None):
        """The minds of a swarm whose linked beliefs a person may see (Jon on #354): a linked belief shows only where the
        hive's visibility already lets them see its mind (Viewer.sees), less what an admin's views hide without an
        audit (another person's own mind and researchers, Visibility.hidden_ids). With no viewer, the minds every
        member may see, for views that reach whoever is listening (events, the hive's count on a new socket)."""
        from .visibility import Viewer
        viewer = viewer if viewer is not None else Viewer("public:anyone", False)
        return [r["id"] for r in self.db.all("SELECT * FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,))
                if self.link_rights(dict(r), viewer)["read_beliefs"]]

    def _belief_meta(self, swarm_id, item):
        last = self.db.one("SELECT created_at FROM assertions WHERE swarm_id = ? AND statement = ? "
                           "ORDER BY id DESC LIMIT 1", (swarm_id, item["statement"]))
        holders = item.get("holders") or []
        held = (self.db.one(f"SELECT MAX(first_seen) AS at FROM held_stamps WHERE statement = ? AND agent_id IN "
                            f"({', '.join('?' for _ in holders)})", (item["statement"], *holders)) if holders else None)
        sources = item.get("sources")
        if sources is None:
            detail = self.spaces.belief(swarm_id, item["statement"]) or {}
            sources = detail.get("sources", [])
        updated = latest_stamp(last["created_at"] if last else None, held["at"] if held else None)
        return {"swarm_id": swarm_id, "statement": item["statement"], "tv": item["tv"], "stamp": item["stamp"],
                "sources": sources, "holders": holders, "updated_at": updated or now()}

    def belief(self, swarm_id, statement, detail=True, reader=None, viewer=None):
        """One belief of a swarm's view: as the mind reader reads it, through its grants, or as a person (viewer) reads
        it, of the minds they may see."""
        try:
            item = (self.spaces.belief(swarm_id, statement, reader) if reader else
                    self.spaces.belief(swarm_id, statement, among=self.seen_minds(swarm_id, viewer)))
        except ValueError as exc:
            raise HiveError(400, "bad_statement", str(exc)) from exc
        if item is None:
            if detail:
                raise HiveError(404, "not_found", "no such belief")
            return None
        belief = self._belief_meta(swarm_id, item)
        if not detail:
            return belief
        rows = self.db.all("SELECT * FROM assertions WHERE swarm_id = ? AND statement = ? ORDER BY id",
                           (swarm_id, item["statement"]))
        since = {r["agent_id"]: r["first_seen"] for r in self.db.all(
            "SELECT agent_id, first_seen FROM held_stamps WHERE statement = ?", (item["statement"],))}
        return dict(belief, assertions=[self.assertion_view(r) for r in rows], choices=item["choices"],
                    held=[dict(h, since=since.get(h["mind"])) for h in item["held"]])

    def _note_read(self, row, statement, stamp):
        """Remember which beliefs an agent has read, with the evidence behind them."""
        if not stamp:
            return
        self.db.execute("INSERT INTO reads (agent_id, swarm_id, statement, stamp, created_at) VALUES (?, ?, ?, ?, ?) "
                        "ON CONFLICT(agent_id, statement) DO UPDATE SET stamp = excluded.stamp, "
                        "created_at = excluded.created_at",
                        (row["id"], row["swarm_id"], statement, json.dumps(stamp), now()))

    def query(self, agent_id, pattern):
        """The atoms of the mind's view of its swarm's beliefs matching a pattern; every belief it reads, the commons'
        Current or another mind's Held, is remembered with its evidence, for echo detection."""
        row = self._agent_row(agent_id)
        if not row["swarm_id"]:
            return {"results": []}
        self._refresh_held(agent_id)   # its own last save is seen before this read is noted (first sight)
        try:
            results = self.spaces.query(row["swarm_id"], pattern, agent_id)
        except ValueError as exc:
            raise HiveError(400, "bad_pattern", str(exc)) from exc
        for text in results:
            try:
                value = sexpr.read_result(text)
            except (ValueError, IndexError):
                continue
            read = None
            if isinstance(value, list) and len(value) == 4 and value[0] == "Current":
                read = value[1], value[3]
            elif isinstance(value, list) and len(value) == 5 and value[0] == "Held":
                read = value[2], value[4]
            if read:
                stamp = [f"ev:{e[1]}:{e[2]}" for e in (read[1] or []) if isinstance(e, list) and len(e) == 3]
                self._note_read(row, sexpr.render(read[0]), stamp)
        return {"results": results}

    def agent_belief(self, agent_id, statement):
        """A belief as an agent reads it; the read is remembered for echo detection."""
        row = self._agent_row(agent_id)
        if not row["swarm_id"]:
            raise HiveError(400, "no_swarm", "agent is not in a swarm")
        self._refresh_held(agent_id)
        belief = self.belief(row["swarm_id"], statement, reader=agent_id)
        self._note_read(row, belief["statement"], belief["stamp"])
        return belief

    # ---- linked beliefs: a mind's own beliefs seen through its swarm, never copied (Jon on #334) -----------------------
    # A mind keeps its beliefs in its own space and saves them to memory/beliefs.metta at each cycle's end. The hive loads
    # that save into a read-only space beside the commons and links it into the swarm's view by a read grant, written when
    # the mind joins and taken away when it leaves (SpaceService.link). Nothing is copied into a commons: a belief shows
    # for as long as its mind holds it. Jon on #354: a link never shows a belief past where the hive already lets people
    # see its mind, so a person's own mind, a researcher and a private or shared mind link nothing until their owner opts
    # in, and a person's view of a swarm holds only the minds they may see (seen_minds).

    # 20 times the runtime's default bound on a beliefs space (maxBeliefAtomsChars, 50000 characters), so a raised bound
    # still links; a file past it links nothing and the log says so.
    LINK_MAX_BYTES = 1 << 20

    def link_default_reason(self, row):
        """Why a mind's beliefs link nothing while its owner hasn't chosen (Jon on #354): "personal" for a person's own
        mind, "researcher", or its visibility, "private" or "shared"; None for a public mind of a team swarm, whose
        beliefs all link."""
        if row.get("personal_of"):
            return "personal"
        research = getattr(self, "research", None)
        if research is not None and row["id"] in research.child_ids_all():
            return "researcher"
        visibility = row.get("visibility") or "public"
        return None if visibility == "public" else visibility

    def link_default(self, row):
        """What a mind's beliefs link by while its owner hasn't chosen: "all", or "none" for a reason
        link_default_reason gives."""
        return "all" if self.link_default_reason(row) is None else "none"

    def link_setting(self, row):
        """The mind's link as it applies now: "all", "none" or the domains it's narrowed to."""
        setting = row.get("belief_link")
        chosen = None if setting is None else json.loads(setting)
        if chosen is None:
            return self.link_default(row)
        return "none" if chosen == [] else chosen

    def link_patterns(self, row):
        """The statement patterns the mind's read grants hold: every belief, those about each domain, or none."""
        linked = self.link_setting(row)
        if linked == "all":
            return ["$stmt"]
        return [] if linked == "none" else [linked_beliefs.domain_pattern(domain) for domain in linked]

    # A mind's read grants are set from its row and its membership, read just before the link. Every change to them
    # reads and links under the mind's lock (_mind_lock), the lock a move (update_agent), a placement and a mind's
    # cleanup already hold across their revoke and grant, so no change links from a row or membership another has
    # since changed: a link setting turned off can't be reopened by a change that read it on, and a mind that moved
    # can't be granted again in the swarm it left (a review of #354 forced both; test_belief_link_races). The lock is
    # re-entrant and taken before the database's, as everywhere else.
    def join_commons(self, agent_id, swarm_id):
        """The mind joins the swarm's commons, and its beliefs are linked into the swarm's view as its owner set. A mind
        already a member keeps its grant, and its link and linked space follow its row and its save as they are now."""
        with self._mind_lock(agent_id):
            self.spaces.grant(agent_id, swarm_id)
            self._link(agent_id, swarm_id)
        self._refresh_held(agent_id)

    def leave_commons(self, agent_id, swarm_id):
        """The mind leaves the swarm's commons: its read grants go with the revoke, its linked space is unloaded, and the
        stamps its beliefs held there are forgotten."""
        with self._mind_lock(agent_id):
            self.spaces.revoke(agent_id, swarm_id)
        self.forget_beliefs(agent_id)

    def _link(self, agent_id, swarm_id):
        """Link the mind's beliefs into the swarm as its row says now; callers hold the mind's lock."""
        row = self.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        self.spaces.link(agent_id, swarm_id, self.link_patterns(dict(row)) if row else [])

    def relink_beliefs(self, agent_id):
        """After the mind's link setting or visibility changes, its read grants follow."""
        with self._mind_lock(agent_id):
            row = self._agent_row(agent_id)
            if row["swarm_id"] and self.spaces.is_member(agent_id, row["swarm_id"]):
                self._link(agent_id, row["swarm_id"])

    VISIBILITY_RANK = {"private": 0, "shared": 1, "public": 2}

    def relink_after_visibility(self, agent_id, before):
        """After a mind's visibility changes from before: when it narrows, a widening its owner chose for the wider
        audience ("all" or some domains) goes back to the mind's default, which links nothing for a private or shared
        mind until its owner opts in again (Jon on #354); [] stays. Then its read grants follow."""
        with self._mind_lock(agent_id):
            row = self._agent_row(agent_id)
            rank = self.VISIBILITY_RANK
            narrowed = rank.get(row.get("visibility") or "public", 2) < rank.get(before or "public", 2)
            if narrowed and row.get("belief_link") is not None and json.loads(row["belief_link"]) != []:
                self.db.execute("UPDATE agents SET belief_link = NULL WHERE id = ?", (agent_id,))
            self.relink_beliefs(agent_id)

    def set_mind_visibility(self, agent_id, viewer, visibility=None, shared_with=None, pays=None):
        """Who can see the mind changes (Visibility.set), and its link follows (relink_after_visibility), as one change
        under the mind's lock, so the visibility it narrows from is the one it had."""
        with self._mind_lock(agent_id):
            before = (self.db.one("SELECT visibility FROM agents WHERE id = ?", (agent_id,)) or {}).get("visibility")
            self.visibility.set("agents", agent_id, viewer, visibility, shared_with, pays)
            self.relink_after_visibility(agent_id, before)

    # Who may do what with a mind's link (Jon on #354, both reviews). A person stands to a mind as one of six classes,
    # and each class may do the same with any kind of mind: the kind (a person's own mind, a researcher, a private,
    # shared or public mind) decides only the class, through Viewer.sees and what an admin's views hide, and the link's
    # default (link_default). Minds read a linked belief through the read grants alone, a member of the mind's swarm
    # as the link admits and no other mind, and have no route to the rest.
    LINK_ACTIONS = ("read_beliefs", "read_setting", "read_topics", "narrow", "widen")
    LINK_RIGHTS = {
        "owner": {"read_beliefs", "read_setting", "read_topics", "narrow", "widen"},
        "admin-audit": {"read_beliefs", "read_setting", "read_topics", "narrow"},
        "admin": {"read_beliefs", "read_setting", "narrow"},
        "admin-hidden": set(),
        "sees": {"read_beliefs"},
        "unseen": set(),
    }

    def link_class(self, row, viewer):
        """How this person stands to a mind, for LINK_RIGHTS: its owner (the person it is the own mind of, or for a mind
        made before owners were recorded, an admin), an admin auditing (?include=personal), an admin, an admin whose
        views hide the mind (another person's own mind or a researcher of their research), someone who sees it, or
        someone who doesn't."""
        people = {row.get("owner"), row.get("personal_of")} - {None}
        if viewer.principal in people or (not people and viewer.admin):
            return "owner"
        if viewer.admin:
            if viewer.audit:
                return "admin-audit"
            return "admin-hidden" if self.visibility.hides(viewer, row["id"]) else "admin"
        return "sees" if viewer.sees(row) else "unseen"

    def link_rights(self, row, viewer):
        """What this person may do with the mind's link, by LINK_RIGHTS."""
        allowed = self.LINK_RIGHTS[self.link_class(row, viewer)]
        return {action: action in allowed for action in self.LINK_ACTIONS}

    def _link_refusal(self, row, viewer):
        """The refusal for an action the table denies: not found to someone who doesn't see the mind or whose views
        hide it, as everywhere, else owner_only."""
        if self.link_class(row, viewer) in ("unseen", "admin-hidden"):
            return HiveError(404, "not_found", "no such mind")
        return HiveError(403, "owner_only", "only this mind's owner can do that with its beliefs")

    @staticmethod
    def link_widens(before, after):
        """Whether the link after admits a belief the link before didn't: "all" admits every belief, "none" none, and a
        list of domains the beliefs about each."""
        if after == "none" or before == "all":
            return False
        if after == "all" or before == "none":
            return True
        return not set(after) <= set(before)

    def link_all(self):
        """At start: link every member mind's beliefs into its swarm, since links are derived and never logged, and load
        each one's last save.

        Time: one interpreter job per mind in a swarm, plus a load for each that has saved beliefs."""
        for row in self.db.all("SELECT * FROM agents WHERE swarm_id IS NOT NULL AND deleted = 0"):
            if self.spaces.is_member(row["id"], row["swarm_id"]):
                self.spaces.link(row["id"], row["swarm_id"], self.link_patterns(dict(row)))
                self._refresh_held(row["id"])

    def belief_link(self, agent_id, viewer):
        """The mind's link as this person may read it (link_rights): domains as its owner set it (None for its default,
        "all", a list, or []), its default and why, what is linked now, the patterns its read grants hold, this person's
        rights, and the domains its saved beliefs are about now where they may read those."""
        row = self._agent_row(agent_id)
        rights = self.link_rights(row, viewer)
        if not rights["read_setting"]:
            raise self._link_refusal(row, viewer)
        setting = row.get("belief_link")
        known = None
        if rights["read_topics"]:
            try:
                text = self._memory_read(agent_id, "beliefs.metta").decode("utf-8", errors="replace")
            except OSError:   # mindfs.UnsafeMindPath is an OSError
                text = ""
            known = sorted({linked_beliefs.belief_domain(atom) for atom in self._atoms(text)} - {None})
        return {"agent_id": agent_id, "domains": None if setting is None else json.loads(setting),
                "default": self.link_default(row), "default_reason": self.link_default_reason(row),
                "linked": self.link_setting(row),
                "patterns": self.spaces.links(agent_id, row["swarm_id"]) if row["swarm_id"] else [],
                "as": self.link_class(row, viewer), "rights": rights, "known_domains": known}

    def set_belief_link(self, agent_id, data, viewer):
        """This person links the mind's beliefs, data {"domains": ...}, as its default (None), all of them ("all"), only
        those about some domains (a list), or none ([]): a change that lets more be seen needs the widen right, any
        other the narrow right (link_rights), and someone with neither learns nothing about the mind. The check, the
        stored setting and the relink are one change under the mind's lock."""
        with self._mind_lock(agent_id):
            self._set_belief_link_locked(agent_id, data, viewer)
        self.emit_agent(agent_id)
        return self.belief_link(agent_id, viewer)

    def _set_belief_link_locked(self, agent_id, data, viewer):
        row = self._agent_row(agent_id)
        rights = self.link_rights(row, viewer)
        if not (rights["narrow"] or rights["widen"]):
            raise self._link_refusal(row, viewer)
        if not isinstance(data, dict) or "domains" not in data:
            raise HiveError(400, "bad_domains", 'send domains: null for the mind\'s default, "all", a list of domains, '
                            "or [] for none")
        domains = data["domains"]
        if domains is not None and domains != "all":
            if (not isinstance(domains, list) or len(domains) > 64
                    or not all(isinstance(d, str) and d.strip() and len(d) <= 200 for d in domains)):
                raise HiveError(400, "bad_domains", 'domains is null for the mind\'s default, "all", or a list of up to 64 '
                                "domain names of up to 200 characters, empty for none")
            domains = sorted({d.strip() for d in domains})
            for domain in domains:
                try:
                    sexpr.safe_link_pattern(linked_beliefs.domain_pattern(domain))
                except ValueError as exc:
                    raise HiveError(400, "bad_domains", f"{domain!r}: {exc}") from None
        stored = None if domains is None else json.dumps(domains)
        widens = self.link_widens(self.link_setting(row), self.link_setting(dict(row, belief_link=stored)))
        if not rights["widen" if widens else "narrow"]:
            raise self._link_refusal(row, viewer)
        self.db.execute("UPDATE agents SET belief_link = ? WHERE id = ?", (stored, agent_id))
        self.relink_beliefs(agent_id)

    def refresh_all_beliefs(self):
        """The reconcile pass: reload each mind's linked space whose saved beliefs changed. A mind saves at its cycle's
        end, after its trace is posted, so this pass is what shows another mind's newest belief, within its period; read
        routes never load or write.

        Time: one fstat per mind in a swarm, plus a load for each changed file."""
        for row in self.db.all("SELECT id FROM agents WHERE swarm_id IS NOT NULL AND deleted = 0"):
            self._refresh_held(row["id"])

    def _refresh_held(self, agent_id):
        """Load the mind's last save into its linked space when the file changed: the key and the bytes come from one
        open file, so a save landing between them can't pair one file's key with another's content.

        The stamps are read and written outside _held_lock, so a caller inside a transaction (a placement) and the
        reconcile pass never wait on each other's lock. A load mounts only if no unload and no load started after it
        has finished meanwhile, so a mind that left stays unloaded and an older save never replaces a newer one."""
        from ..supervisor import mindfs
        try:
            fd = mindfs.open_read(self.settings.agents_dir / agent_id, "memory/beliefs.metta")
        except (OSError, mindfs.UnsafeMindPath):
            fd = None
        try:
            st = os.fstat(fd) if fd is not None else None
            key = (st.st_ino, st.st_size, st.st_mtime_ns) if st is not None else None
            with self._held_lock:
                if agent_id in self._held_keys and self._held_keys[agent_id] == key:
                    return
                ticket = next(self._held_tickets)
            held = self._held_beliefs(agent_id, fd, st.st_size) if key else []
            with self._held_lock:
                if ticket <= self._held_floor.get(agent_id, 0):
                    return
                self.spaces.mount_beliefs(agent_id, held)
                self._held_keys[agent_id] = key
                self._held_floor[agent_id] = ticket
        finally:
            if fd is not None:
                os.close(fd)

    def _held_beliefs(self, agent_id, fd, size):
        """The mind's saved beliefs as (statement, f, c, stamp) rows, one per statement (the more confident where it
        holds one twice), each stamped as the hive first saw it held.

        Time: linear in the file's length."""
        if size > self.LINK_MAX_BYTES:
            log.warning("mind %s: memory/beliefs.metta is %d bytes, past %d, so none of its beliefs is linked",
                        agent_id, size, self.LINK_MAX_BYTES)
            return []
        chunks = []
        while chunk := os.read(fd, 1 << 20):
            chunks.append(chunk)
        best = {}
        for atom in self._atoms(b"".join(chunks).decode("utf-8", errors="replace")):
            got = linked_beliefs.belief_statement(atom)
            if got and (got[0] not in best or got[2] > best[got[0]][1]):
                best[got[0]] = got[1:]
        stamps = self._held_stamps(agent_id, sorted(best))
        return [(statement, f, c, stamps[statement]) for statement, (f, c) in sorted(best.items())]

    def _held_stamps(self, agent_id, statements):
        """Each statement's evidence, fixed when the hive first sees the mind hold it, by the rule publish uses
        (_evidence_for), else an id minted for the mind: no later read or save changes it while the mind stays in its
        swarm, so a belief the mind formed after reading another's stays an echo, and one it held first stays its own."""
        swarm_id = self._agent_row(agent_id)["swarm_id"]
        out = {r["statement"]: json.loads(r["stamp"])
               for r in self.db.all("SELECT statement, stamp FROM held_stamps WHERE agent_id = ?", (agent_id,))}
        for statement in statements:
            if statement in out:
                continue
            stamp = self._evidence_for(agent_id, swarm_id, statement) or self._mint_stamp(agent_id)
            self.db.execute("INSERT OR IGNORE INTO held_stamps (agent_id, statement, stamp, first_seen) VALUES (?, ?, ?, ?)",
                            (agent_id, statement, json.dumps(stamp), now()))
            out[statement] = json.loads(self.db.one("SELECT stamp FROM held_stamps WHERE agent_id = ? AND statement = ?",
                                                    (agent_id, statement))["stamp"])
        return out

    def unload_beliefs(self, agent_id):
        """Unload a mind's linked space; a load of it already under way mounts nothing."""
        with self._held_lock:
            self._held_keys.pop(agent_id, None)
            self._held_floor[agent_id] = next(self._held_tickets)
            self.spaces.unmount_beliefs(agent_id)

    def forget_beliefs(self, agent_id):
        """Unload a mind's linked space and forget its held stamps, when it leaves its swarm or is deleted."""
        self.unload_beliefs(agent_id)
        self.db.execute("DELETE FROM held_stamps WHERE agent_id = ?", (agent_id,))

    def _evidence_for(self, agent_id, swarm_id, canonical):
        """The evidence a mind's statement stands on when it cites none: its own ids from its last publish of it, else
        the stamp its own space's belief in it was given, else the stamp of what it read of it, since repeating what
        it read is an echo and not a second observation; None when there's none, for a new id."""
        previous = self.db.one(
            "SELECT stamp FROM assertions WHERE swarm_id = ? AND agent_id = ? AND statement = ? "
            "AND outcome NOT IN ('denied', 'quarantined') ORDER BY id DESC LIMIT 1",
            (swarm_id, agent_id, canonical))
        own = [e for e in json.loads(previous["stamp"]) if e.startswith(f"ev:{agent_id}:")] if previous else []
        if own:
            return own
        for table in ("held_stamps", "reads"):
            seen = self.db.one(f"SELECT stamp FROM {table} WHERE agent_id = ? AND statement = ?", (agent_id, canonical))
            if seen and json.loads(seen["stamp"]):
                return json.loads(seen["stamp"])
        return None

    def _evidence_seen(self, item):
        """Whether an evidence id is already in the hive: in a publish's stamp or in a held belief's."""
        return any(self.db.one(f"SELECT 1 FROM {table}, json_each({table}.stamp) WHERE json_each.value = ? LIMIT 1",
                               (item,)) for table in ("assertions", "held_stamps"))

    # ---- usage ----------------------------------------------------------------------------------

    def _session_person(self, agent):
        """The person whose session holds this mind now, or None: J3 R4 (plan §3.6) first, while a Studio session is live,
        the session's person, for every call its maker makes (inert with Studio off); else the asker of the Ask turn open
        on this mind (at most one: ask.py admits no other person's turn or session alongside it); else the owner of an
        active ordinary Session with this mind (one payer person at a time: sessions.py refuses a second). An Ask thread
        with no open turn holds it for no one."""
        from .ask import OPEN_HOST_MIND, states_sql   # the host's mind answering; never a conductor or browser turn
        studio = getattr(self, "studio", None)
        principal = studio.call_principal(agent["id"]) if studio is not None else None
        if principal:
            return principal
        turn = self.db.one(f"SELECT principal FROM ask_turns WHERE mind_id = ? AND state IN {states_sql(OPEN_HOST_MIND)} ORDER BY created_at LIMIT 1",
                           (agent["id"],)) if getattr(self, "ask", None) else None
        if turn and str(turn["principal"]).startswith("user:u_"):
            return turn["principal"]
        s = self.db.one("SELECT owner FROM work_sessions WHERE agent_id = ? AND status = 'active' AND (purpose IS NULL OR purpose != 'ask') "
                        "ORDER BY created_at DESC LIMIT 1", (agent["id"],)) if getattr(self, "sessions", None) else None
        if s and str(s["owner"]).startswith("user:u_"):
            return s["owner"]
        return None

    def user_for(self, agent):
        """Who a mind's model call is for: the person whose session holds it (_session_person); else the mind's owner
        when that is a named person; else the hive."""
        person = self._session_person(agent)
        if person:
            return person
        owner = agent.get("owner") or ""
        return owner if owner.startswith("user:u_") else "hive"

    def _request_person(self, agent):
        """The person who asked at the root of the request a team spawned this child mind for, while its reservation is
        unreleased (Minds._release), or None: the child works for that request alone, inside its allocation, as a Code
        request's helper does from its spawn until the request ends and its allocation goes back."""
        child = self.db.one("SELECT r.from_principal FROM mind_reservations m JOIN requests r ON r.id = m.budget_root "
                            "WHERE m.child_id = ? AND m.released_at IS NULL", (agent["id"],))
        return child["from_principal"] if child and str(child["from_principal"]).startswith("user:u_") else None

    def present_for(self, agent):
        """The person whose own live work this mind's call is part of, or None when the mind acts on its own: the person
        whose session holds it (_session_person), else the person whose request a team spawned it for
        (_request_person), else the person whose live Create plan waits on it (CreatePlanEngine.waiting_on), else the
        person whose live Code request waits on its second opinion (CodeControllerEngine.waiting_on). The spend-rate
        guard paces only a call with no one present (cost_reservations.Reservations.reserve, paced): a person's own work
        is held by its limits and its own budget."""
        return (self._session_person(agent) or self._request_person(agent) or self.create_plans.waiting_on(agent["id"])
                or self.code_controller.waiting_on(agent["id"]))

    def payer_for(self, agent, key_owner=None):
        """Who pays for this mind's model call, and whether it is on their own key (user_for names who it is for):
        a person's own key -> that person, own key; a person's key used for a guest, a public visitor or someone the key's
        owner granted -> that someone, not on their own key (own hive H1: the grant, else their visitor limit, holds them;
        ownhive.py); used for an enabled person from before H1 -> the key's owner, own key (as before H1, H1.1); a
        person's key used for no one in particular (a hive mind) -> the key's owner, own key; else whoever it is for.
        The key's owner is never the payer of last resort for anyone else: a call for a disabled or unknown person stays
        theirs (them, not on their own key), and OwnHive.use_check refuses it (402 no_key_grant)."""
        user = self.user_for(agent)
        if key_owner and str(key_owner).startswith("user:u_"):
            if user == key_owner or not user.startswith("user:u_"):
                return key_owner, True
            access = self.ownhive.access(user)
            if access is None:
                return user, False   # disabled or unknown: no payer; refused at use_check, never the key owner's spend
            if access in ("guest", "public") or self.ownhive.has_grant(user, owner=key_owner):
                return user, False   # H1: a guest, a public visitor, or someone the key's owner granted is held themselves
            return key_owner, True   # H1.1: an enabled person from before H1 is billed exactly as at e1717db (the key's owner)
        return user, False

    def check_budget(self, agent, paid=False, estimate=0.0, key_id=None, payer=None, own_key=False, turn_bound=False,
                     evidence_id=None):
        """Refuse a model call that would cross any limit, and remember the refusal: a mind whose calls are
        refused never gets a trace for them, so Health and the bounded runner read it from here.
        turn_bound (gateway r1a, plan §2.6): only the personal-mind gateway passes True; every other caller is unchanged.
        evidence_id (gateway r1e): the gateway's id for this call, so a retried refusal is one observation; a turn-bound
        refusal becomes an advisory observation in the mindgateway commons AFTER the decision (it is never read here)."""
        try:
            return self._check_budget(agent, paid, estimate, key_id, payer, own_key, turn_bound)
        except HiveError as exc:
            if turn_bound:
                from .mindgateway_evidence import refusal_kind
                with contextlib.suppress(Exception):
                    # no evidence_id: a nonce, so each retry of that call counts as a new observation; the gateway's
                    # call path (r1c) must pass its request id for retries to be one observation (Kimi r1e P3)
                    self.mindgateway.call_refused(evidence_id or secrets.token_hex(16), refusal_kind(exc))
            if exc.status == 402:
                details = dict(exc.details or {}, call_usd=round(float(estimate), 6)) if estimate else exc.details
                self.note_refusal(agent, exc.code, exc.message, details)
            raise

    # What a refusal names, as budget.refused carries it and the refusal record keeps it: the limit that refused the call
    # (scope, period, limit, spend, holds) and the call's own worst case, which is why a limit with room still refused it.
    # Who may read them is limits_view.scope_visible's; limit_frame shapes each budget.refused frame for its receiver.
    REFUSAL_LIMIT = ("scope", "period", "limit_usd", "spent_usd", "held_usd", "call_usd")

    def note_refusal(self, agent, code, message, details=None):
        """Remember a model call refused for spending and announce it, whichever check refused it (Budgets.check's 402
        before the call, or the reservation's BudgetExhausted inside it): Health and the bounded runner read the record,
        and budget.refused (the first refusal, then every 20th) names the limit that refused it, its period, limit, spend
        and the worst cases held against it, so a mind's page and a notice can say which limit stopped the mind. A
        person's own month allowance running out also asks an admin for more (person_requests.auto_allowance), whichever
        check refused. A refusal naming a limit keeps a message that names none (Health shows it to anyone who reads the
        mind); the limit goes only to whoever may see it. The count starts again once a call is admitted (note_admitted),
        so a notice comes once per pause."""
        d = details or {}
        limit = {k: d[k] for k in self.REFUSAL_LIMIT if d.get(k) is not None}
        if limit.get("scope"):
            message = "A spending limit has no room for this call."
        seen = self.refusals.setdefault(agent["id"], {"count": 0})
        first = seen["count"] == 0
        seen.update(count=seen["count"] + 1, last_at=now(), code=code, message=str(message)[:300], **limit)
        if first or seen["count"] % 20 == 0:
            self.events.publish("budget.refused", agent_id=agent["id"], code=code, count=seen["count"], **limit)
        if str(d.get("scope", "")).startswith("person:u_") and d.get("period") == "month":
            self.person_requests.auto_allowance("user:" + d["scope"][7:], float(d["limit_usd"]))   # stop, notify, ask
        if d.get("period") == "month" and d.get("limit_usd") is not None:   # a month allowance or the hive cap: its 100% notice
            self.db.after_commit(lambda s=str(d.get("scope", "")), l=float(d["limit_usd"]): self.limit_notices.refused(s, "month", l))

    def note_admitted(self, agent):
        """A paid call admitted again, by Budgets.check and its reservation both: the mind is no longer paused for
        spending, so its refusal record goes and the next refusal is announced as the first of a new pause; the same for
        a pace the spend-rate guard set (spend_rate_refusal)."""
        self.refusals.pop(agent["id"], None)
        self.slowed.pop(agent["id"], None)

    def spend_rate_refusal(self, agent, exc):
        """A paid call the spend-rate guard refused (cost_reservations.SpendRateLimited): the 429 spend_rate a mind reads
        as a provider's rate limit, with the guarded limit, retry_after (whole seconds) and until (when a call of that size
        fits) in its details and the Retry-After header. budget.slowed is announced once until a call is admitted again
        (note_admitted), so a page says once that the mind is slowed and when it can carry on. Nothing was held."""
        scope, _, period = exc.scope.rpartition(":")
        until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=exc.retry_after)) \
            .isoformat(timespec="seconds").replace("+00:00", "Z")
        details = {"scope": scope, "period": period, "limit_usd": exc.limit_usd, "retry_after": exc.retry_after,
                   "until": until}
        if agent["id"] not in self.slowed:
            self.slowed[agent["id"]] = until
            self.events.publish("budget.slowed", agent_id=agent["id"], **details)
        minutes = -(-exc.retry_after // 60)
        return HiveError(429, "spend_rate", f"Spending faster than this month allows: a call this size fits again in about "
                                            f"{minutes} minute{'s' if minutes != 1 else ''}.", details)

    def _check_budget(self, agent, paid=False, estimate=0.0, key_id=None, payer=None, own_key=False, turn_bound=False):
        """Refuse an LLM call before it is made when it could overspend.

        A paid call needs a budget (0 means none, not unlimited) with room for
        the call's worst-case cost, and room under the hive-wide cap.  Every
        call counts against a per-agent calls-per-minute ceiling, which stops a
        loop that keeps re-calling the model from running up a bill.
        """
        self.person_swarms.require_current(agent["id"])
        makers = getattr(self, "studio_makers", None)
        if paid and makers is not None:
            # J3 R7.2: a person's own Studio maker pays only with that person's own key, at every paid route (chat,
            # embeddings, media, the conductor), before any reservation or dispatch; shared makers are unchanged
            refused = makers.key_refusal(agent["id"], key_id, "call")
            if refused is not None:
                raise refused
        limit = self.settings.max_llm_calls_per_minute
        if limit:
            moment = time.monotonic()
            calls = self.llm_calls.setdefault(agent["id"], collections.deque())
            while calls and moment - calls[0] > 60:
                calls.popleft()
            if len(calls) >= limit:
                raise HiveError(429, "rate_limited", f"{agent['name']} made {limit} LLM calls in the last minute")
            calls.append(moment)
        budget, spent = agent["budget_usd"] or 0.0, agent["spent_usd"] or 0.0
        if paid and turn_bound and self.budgets.monthly_total(agent, payer, own_key, key_id) is None:
            # gateway r1a (r1.1 §C, r1.2): a turn-bound call is governed by the person's one monthly total; with none,
            # refused before any reservation, with the one refusal word monthly_total_required
            raise self.budgets.total_required(own_key)
        if paid and budget <= 0 and not self.budgets.paid_without_cap(agent, None, payer, own_key, key_id, turn_bound):   # a hive cap: the payer's allowance and the caps set; a personal mind: its person's allowance
            raise HiveError(402, "no_budget", f"{agent['name']} needs a budget to use {agent['model']}")
        if budget and spent + estimate > budget:
            raise HiveError(402, "budget_exhausted", f"{agent['name']} has spent ${spent:.2f} of its "
                                                     f"${budget:.2f} budget",
                            {"scope": f"agent:{agent['id']}", "period": "total", "limit_usd": budget, "spent_usd": round(spent, 6)})
        if paid:
            self.budgets.check(agent, estimate, key_id, payer, own_key, turn_bound)
        cap = self.budgets.hard_cap() if paid else 0
        if paid and cap:
            total = self.budgets.hard_total_spent()
            if total + estimate > cap:
                raise HiveError(402, "hive_budget_exhausted", f"the hive has spent ${total:.2f} of its ${cap:.2f} cap",
                                {"scope": "hive", "period": "all-time", "limit_usd": cap, "spent_usd": round(total, 6)})

    def record_usage(self, agent, model, usage, resolved_model=None, payer=None):
        """One call's cost recorded against its mind, team, payer and key. usage may also carry estimated (1 for the
        expiry's worst-case settlement), reservation (the held call an estimate or its correction is about) and
        created_at (a correction's adjusting row takes its estimate's, so it lands in the same day and month)."""
        row = {"agent_id": agent["id"], "model": model, "prompt_tokens": usage["prompt_tokens"],
               "completion_tokens": usage["completion_tokens"], "cost_usd": usage["cost_usd"],
               "created_at": usage.get("created_at") or now(),
               "key_id": usage.get("key_id"), "swarm_id": agent.get("swarm_id"),
               "resolved_model": str(resolved_model)[:200] if resolved_model else None,
               "payer": payer or self.payer_for(agent)[0], "payer_mode": usage.get("payer_mode"),
               "estimated": 1 if usage.get("estimated") else 0, "reservation": usage.get("reservation")}
        row["key_grantee"] = self.ownhive.grantee_for(row["key_id"], row["payer"])   # H1.1: the key-limit scope it counts in
        self.db.insert("usage", row)
        # the allowance and hive cap notices, once this spend commits and outside the transaction's lock (limit_notices)
        self.db.after_commit(lambda paid_by=row["payer"]: self.limit_notices.after_usage(paid_by))
        row = {k: v for k, v in row.items() if k not in ("key_id", "swarm_id", "resolved_model", "payer", "key_grantee",
                                                         "payer_mode", "reservation")}  # the event keeps its published shape, plus estimated
        # Spend is not activity: it moves neither last_active_at nor last_input_at (a mind calling its model with no
        # input is exactly what Health's idle pass notices; see mark_input).
        self.db.execute("UPDATE agents SET spent_usd = spent_usd + ? WHERE id = ?", (usage["cost_usd"], agent["id"]))
        self.events.publish("usage", usage=row)
        if not agent.get("deleted"):   # a deleted mind's held call settled later (app.held_usage) has no mind left to show
            self.emit_agent(agent["id"])

    def own_key_ids(self, principal):
        """The keyring ids a named person owns (their own keys); empty for anyone else."""
        own = set()
        if principal.startswith("user:u_"):
            keyring = getattr(self, "keyring", None)
            for k in ((keyring.ring.get("keys") if keyring else None) or {}).values():
                if k.get("owner") == principal:
                    own.add(k["id"])
        return own

    def my_spend(self, principal):
        """One person's spend this month: what the hive paid for them (against their allowance), what calls not yet
        settled hold against that allowance (held_usd), what their own keys paid, and which minds it went to."""
        from .budgets import period_start
        start = period_start("month")
        rows = self.db.all("SELECT u.agent_id, a.name, u.key_id, u.cost_usd FROM usage u LEFT JOIN agents a ON a.id = u.agent_id "
                           "WHERE u.payer = ? AND u.created_at >= ?", (principal, start))
        own = self.own_key_ids(principal)
        hive_paid = sum(r["cost_usd"] for r in rows if r["key_id"] not in own)
        own_paid = sum(r["cost_usd"] for r in rows if r["key_id"] in own)
        by_mind = {}
        for r in rows:
            m = by_mind.setdefault(r["agent_id"], {"agent_id": r["agent_id"], "name": r["name"] or r["agent_id"], "cost_usd": 0.0})
            m["cost_usd"] += r["cost_usd"]
        allowance, origin, label = None, None, None
        if principal.startswith("user:u_"):
            label = "person:" + principal[5:] + ":month"
            rule = self.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'month'", ("person:" + principal[5:],))
            if rule:
                allowance, origin = float(rule["limit_usd"]), "rule"
            else:
                grant = self.db.one("SELECT month_usd, source, scope FROM key_limits WHERE grantee = ? AND owner = ? AND key_id = '*' "
                                    "AND revoked_at IS NULL", (principal, self.ownhive.owner())) \
                    if self.ownhive.access(principal) == "guest" else None
                if grant:   # a guest: the host's grant (their invite limit) is their allowance (own hive H1)
                    allowance = float(grant["month_usd"])
                    origin = "invite" if str(grant["source"]).startswith("invite:") else "grant"
                    label = grant["scope"] + ":month"
                else:
                    allowance = self.budgets.member_allowance(principal[5:])
                    origin = "member-default" if allowance is not None else None
        from .cost_reservations import held_usd
        return {"principal": principal, "since": start, "hive_paid_usd": round(hive_paid, 6), "own_keys_usd": round(own_paid, 6),
                "held_usd": held_usd(self.db, label) if label and allowance is not None else 0.0,
                "allowance_usd": allowance, "allowance_origin": origin, "own_keys": len(own),
                "remaining_usd": round(allowance - hive_paid, 6) if allowance is not None else None,
                "by_mind": sorted(({**m, "cost_usd": round(m["cost_usd"], 6)} for m in by_mind.values()), key=lambda m: -m["cost_usd"])}

    def usage(self, agent_id=None, since=None):
        """Usage rows, oldest first (the newest 5000), each with estimated: 1 while it is the expiry's worst-case
        settlement of a call nobody has corrected (cost_reservations.still_estimated)."""
        from .cost_reservations import still_estimated
        sql, params = ("SELECT agent_id, model, resolved_model, payer, payer_mode, prompt_tokens, completion_tokens, cost_usd, "
                       f"created_at, {still_estimated(self.db, 'usage')} AS estimated FROM usage WHERE 1=1"), []
        if agent_id:
            sql += " AND agent_id = ?"
            params.append(agent_id)
        if since:
            sql += " AND created_at >= ?"
            params.append(since)
        return self.db.all(sql + " ORDER BY id DESC LIMIT 5000", params)[::-1]

    def thinking(self, agent_id, phase, payer=None):
        self.events.publish("agent.thinking", agent_id=agent_id, phase=phase)
        with contextlib.suppress(Exception):   # the Ask turn this call is billed to hears that its mind is working
            self.ask.on_thinking(agent_id, phase, payer)

    # ---- boot ----------------------------------------------------------------------------------

    async def restore(self):
        """Bring agents back to the state they were in before the hive stopped."""
        if self.supervisor is None:
            return
        archived = {r["id"] for r in self.db.all("SELECT id FROM swarms WHERE archived_at IS NOT NULL")}
        # new-hive R1a (r1.2.1 §A): before coding readiness every restored mind is held (unknown work defaults held);
        # it keeps desired=awake and NewHive.release starts it after the completion commit
        holding = self.newhive is not None and not self.newhive.coding_ready()
        for row in self.db.all("SELECT * FROM agents WHERE deleted = 0 AND kind != 'module'"):
            if holding and row["desired"] == "awake" and not self.minds.is_child(row["id"]) \
                    and row.get("swarm_id") not in archived:
                self.newhive.hold_mind(row["id"])
                if row["status"] in ("awake", "starting"):
                    self.set_status(row["id"], "stopped")
                await asyncio.sleep(0)
                continue
            if self.minds.is_child(row["id"]):
                self.minds.restored(row)   # r2.12 §7: a child is never restarted by the host; unconfirmed means recovery
            elif row["desired"] == "awake" and row.get("swarm_id") in archived:
                self.set_status(row["id"], "stopped", desired="asleep")   # a retired swarm never wakes at boot
            elif row["desired"] == "awake":
                try:   # one mind that cannot start is recorded as an error; the hive still boots and restores the rest
                    self.lifecycle(row["id"], "start", expect=lambda fresh: fresh["desired"] == "awake")
                except HiveError as exc:
                    if exc.code == "studio_owned":   # J3 R3: Studio's own jobs start it (or its Stop releases it)
                        log.info("restore left %s to Studio: %s", row["id"], exc)
                        await asyncio.sleep(0)
                        continue
                    log.warning("restore could not start %s: %s", row["id"], exc)
                    with contextlib.suppress(HiveError):
                        self.set_status(row["id"], "error", error=f"start failed at restore: {exc}")
                except Exception as exc:
                    log.warning("restore could not start %s: %s", row["id"], exc)
                    with contextlib.suppress(HiveError):
                        self.set_status(row["id"], "error", error=f"start failed at restore: {exc}")
            elif row["status"] in ("awake", "starting"):
                self.set_status(row["id"], "stopped")
            await asyncio.sleep(0)

    # ---- phase 2: helpers -----------------------------------------------------------------

    @staticmethod
    def error(status, code, message, details=None):
        return HiveError(status, code, message, details)

    def foundation_infrastructure_bindings(self):
        """Copied stored Foundation custody for infrastructure projection, never execution admission.

        Global owner adoption can lag these records. Only their exact stored
        owner/member/coordinator chain classifies them; names and options do not.
        Missing, duplicated or drifted bindings are ordinary, not hidden.
        """
        foundation = getattr(self, "foundation", None)
        if (foundation is None or getattr(foundation, "hive", None) is not self
                or getattr(foundation, "db", None) is not self.db):
            return ()
        from .foundation import CODE, RESEARCH, REVIEW
        with self.db._lock:
            if self.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'") is None:
                return ()
            rows = self.db.all("SELECT purpose, principal, agent_id, swarm_id FROM person_minds "
                               "WHERE purpose IN (?, ?, ?)", (CODE, REVIEW, RESEARCH))
            out = []
            for purpose in (CODE, REVIEW, RESEARCH):   # the Research swarm's coordinator is host infrastructure too
                same = [b for b in rows if b["purpose"] == purpose]
                if len(same) != 1:
                    continue
                binding = same[0]
                principal, aid, sid = binding["principal"], binding["agent_id"], binding["swarm_id"]
                if (not all(isinstance(v, str) and v for v in (principal, aid, sid))
                        or sum(b["agent_id"] == aid for b in rows) != 1
                        or sum(b["swarm_id"] == sid for b in rows) != 1):
                    continue
                agent = self.db.one("SELECT * FROM agents WHERE id = ?", (aid,))
                swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (sid,))
                if (not agent or agent["deleted"] or agent["kind"] != "omega" or agent.get("driver") != "local"
                        or agent.get("moved_to") or agent.get("swarm_id") != sid or agent.get("owner") != principal
                        or not swarm or swarm.get("archived_at") or swarm.get("owner") != principal
                        or swarm.get("coordinator_id") != aid):
                    continue
                out.append({"purpose": purpose, "principal": principal, "agent_id": aid, "swarm_id": sid})
            return tuple(out)

    def stop_all(self, by="user:operator", power="stopped"):
        """Stops every mind; the count/snapshot describe ordinary minds, not bound infrastructure controllers.
        Infrastructure still receives every original stop and failure check. One whose stop fails is left as it is
        (row unchanged) and the rest still stop; the call then
        fails, naming the minds still up, so the kill switch never reports success over a mind it could not stop.
        Each mind meant to be awake (judged under its lock, before its stop) goes into the power snapshot that Wake all
        and power On restore (hive/core/power.py), durably before that stop; the snapshot is kept when some stop fails."""
        stopped, failed = 0, []
        with self.power.lock:
            archived = {r["id"] for r in self.db.all("SELECT id FROM swarms WHERE archived_at IS NOT NULL")}
            rows = self.db.all("SELECT id, status FROM agents WHERE deleted = 0")
            try:
                infrastructure = {b["agent_id"] for b in self.foundation_infrastructure_bindings()}
            except Exception:
                # Classification must never prevent a kill-switch effect.
                log.warning("foundation power classification unavailable; stopping the original census")
                infrastructure = set()
            rows.sort(key=lambda row: row["id"] in infrastructure)   # stable: ordinary custody first
            for row in rows:
                try:
                    with self._mind_lock(row["id"]):
                        fresh = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row["id"],))
                        if fresh is None:
                            continue
                        try:
                            bound = any(b["agent_id"] == row["id"] for b in self.foundation_infrastructure_bindings())
                        except Exception:
                            log.warning("foundation power classification unavailable for %s; using ordinary custody", row["id"])
                            bound = False
                        if not bound and self.power.wakeable(fresh, fresh.get("swarm_id") in archived):
                            self.power.hold(row["id"], by, power)
                        if self.supervisor:
                            self.supervisor.stop(row["id"])
                        self.set_status(row["id"], "stopped", desired="stopped")
                except Exception as exc:
                    log.warning("stop_all could not stop %s: %s", row["id"], exc)
                    failed.append({"id": row["id"], "error": str(exc)})
                    continue
                if not bound and fresh["status"] != "stopped":
                    stopped += 1
            self.power.record(by, power)
        if failed:
            raise HiveError(500, "stop_incomplete",
                            f"{len(failed)} mind(s) could not be stopped: " + ", ".join(f["id"] for f in failed),
                            {"stopped": stopped, "failed": failed})
        return {"stopped": stopped}

    # ---- traces -------------------------------------------------------------------------------

    def trace_view(self, row):
        return dict(row, commands=json.loads(row["commands"]))

    @staticmethod
    def _commands_from_results(text):
        """[{command, result}] from the loop's (RESULTS: ((COMMAND_RETURN: (cmd result)) ...))."""
        from ..spaces import sexpr

        try:
            value = sexpr.read_result(text)
        except (IndexError, ValueError):
            return []
        out = []

        def walk(node):
            if isinstance(node, list):
                if len(node) == 2 and node[0] == "COMMAND_RETURN:" and isinstance(node[1], list) and node[1]:
                    command, *rest = node[1]
                    out.append({"command": sexpr.render(command),
                                "result": " ".join(sexpr.render(r) for r in rest)})
                    return
                for item in node:
                    walk(item)

        walk(value)
        return out

    def record_trace(self, agent, data, pin=None):
        commands = []
        items = data.get("commands")
        if items is None and data.get("results"):
            items = self._commands_from_results(data["results"])
        for item in (items or [])[:20]:
            full_command, full_result = str(item.get("command", "")), str(item.get("result", ""))
            command = full_command[:TRACE_TEXT_MAX]
            entry = {"command": command, "result": full_result[:TRACE_TEXT_MAX]}
            for key, full in (("command", full_command), ("result", full_result)):
                if len(full) > TRACE_TEXT_MAX:   # never a silent cut: say so, with what a complete copy would hash to
                    entry[f"{key}_truncated"] = {"kept_chars": TRACE_TEXT_MAX, "total_chars": len(full),
                                                 "sha256": hashlib.sha256(full.encode()).hexdigest()}
            gate = self.policy.gate_of(agent["id"], command)
            if gate:
                entry["gated"] = gate
            commands.append(entry)
        llm_ms, tokens = self.last_llm.get(agent["id"], (None, None))
        row = {"agent_id": agent["id"], "iteration": int(data.get("iteration") or 0),
               "input": (str(data["input"])[:4000] if data.get("input") else None),
               "response": str(data.get("response", ""))[:8000], "commands": json.dumps(commands),
               "llm_ms": llm_ms, "tokens": tokens, "created_at": now()}
        row["id"] = self.db.insert("traces", row)
        self._refresh_held(agent["id"])   # the mind's last save, linked into its swarm's view (Jon on #334)
        try:   # older traces move to the archive, never deleted
            self.archive.archive_traces(agent["id"], slack=200)
        except Exception:
            log.exception("trace archiving failed for %s", agent["id"])
        if getattr(self, "ask", None) is not None:   # its live audience, fixed now from the host's own records (Ask B2)
            self.ask.record_trace_scope(row["id"], agent["id"], pin)   # pin: an in-process caller's (ask.py)
        trace = self.trace_view(row)
        self.events.publish("agent.trace", trace=trace)
        try:
            self.health.on_trace(agent, trace)
        except Exception:  # error checking must never break the mind it is watching
            log.exception("health check failed for %s", agent["id"])
        return trace

    def traces(self, agent_id, limit=100):
        self._agent_row(agent_id)
        rows = self.db.all("SELECT * FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
                           (agent_id, min(int(limit), 500)))
        return [self.trace_view(r) for r in rows]

    # ---- private memory: read from disk, change through the agent ----------------------------

    MEMORY_SKIP = {"history.metta"}

    def _memory_dir(self, agent_id):
        self._agent_row(agent_id)
        return self.settings.agents_dir / agent_id / "memory"

    @staticmethod
    def _atoms(text):
        """Split a saved space (one top-level expression per entry) into atom texts."""
        atoms, depth, start, in_string, escape = [], 0, None, False, False
        for i, ch in enumerate(text):
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "(":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == ")" and depth:
                depth -= 1
                if depth == 0 and start is not None:
                    atoms.append(text[start:i + 1])
        return atoms

    def _memory_read(self, agent_id, name):
        """One memory file, read without following anything the mind planted (links, hard links: mindfs)."""
        from ..supervisor import mindfs
        folder = self._memory_dir(agent_id)
        return mindfs.read_bytes(folder.parent, f"memory/{name}")

    def memory_spaces(self, agent_id):
        from ..supervisor import mindfs
        folder = self._memory_dir(agent_id)
        try:
            names = mindfs.listdir(folder.parent, "memory")
        except (FileNotFoundError, mindfs.UnsafeMindPath):
            return []
        out = []
        for name in sorted(names):
            if not name.endswith(".metta") or name.startswith(".") or name in self.MEMORY_SKIP:
                continue
            try:
                data = self._memory_read(agent_id, name)
            except (FileNotFoundError, mindfs.UnsafeMindPath):
                continue
            text = data.decode("utf-8", errors="replace")
            out.append({"name": name[:-len(".metta")], "atoms": len(self._atoms(text)), "bytes": len(data)})
        return out

    def memory_atoms(self, agent_id, space, q=None, limit=200):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", str(space)):
            raise HiveError(400, "bad_request", "bad space name")
        from ..supervisor import mindfs
        name = f"{space}.metta"
        if name in self.MEMORY_SKIP:
            raise HiveError(404, "not_found", f"no space {space}")
        try:
            data = self._memory_read(agent_id, name)
        except (FileNotFoundError, NotADirectoryError, mindfs.UnsafeMindPath):
            raise HiveError(404, "not_found", f"no space {space}") from None
        atoms = self._atoms(data.decode("utf-8", errors="replace"))
        rows = [{"index": i, "text": a} for i, a in enumerate(atoms) if not q or str(q).lower() in a.lower()]
        return rows if limit is None else rows[: min(int(limit), 1000)]

    def queue_control(self, agent_id, op):
        self._agent_row(agent_id)
        self.db.insert("control_ops", {"agent_id": agent_id, "op": json.dumps(op), "created_at": now()})
        return {"queued": True}

    def retire_atom(self, agent_id, space, atom):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", str(space)):
            raise HiveError(400, "bad_request", "bad space name")
        if str(atom) not in {a["text"] for a in self.memory_atoms(agent_id, space, limit=1000)}:
            raise HiveError(404, "not_found", "no such atom in that space")
        return self.queue_control(agent_id, {"op": "retire", "space": space, "atom": str(atom)})

    def take_control(self, agent_id):
        rows = self.db.all("SELECT id, op FROM control_ops WHERE agent_id = ? AND taken = 0 ORDER BY id", (agent_id,))
        for row in rows:
            self.db.execute("UPDATE control_ops SET taken = 1 WHERE id = ?", (row["id"],))
        return {"ops": [json.loads(r["op"]) for r in rows]}

    # ---- HTTP inbox for agents without a socket ------------------------------------------------

    def rotate_token(self, agent_id, expected_epoch, token):
        """J3 R3 (plan r1.4 G3): a narrow compare-and-swap of one mind's credential. The new hash and token_epoch + 1
        commit only if the epoch is still the expected one; zero rows -> 409 rotation_conflict, nothing else changes.
        The caller (studio_steps.prepare) has already stopped the mind and written the token file (G4)."""
        with self.db.transaction():
            moved = self.db.execute("UPDATE agents SET token_hash = ?, token_epoch = token_epoch + 1 WHERE id = ? "
                                    "AND token_epoch = ? AND deleted = 0",
                                    (token_hash(token), agent_id, expected_epoch)).rowcount
        if moved != 1:
            raise HiveError(409, "rotation_conflict", "that mind's credential changed meanwhile")
        return expected_epoch + 1

    def inbox(self, agent_id, after=0):
        studio = getattr(self, "studio", None)          # J3 R3 (r1.4 G2): REST and MCP both read the inbox here
        refused = studio.hub_only(agent_id) if studio is not None else None
        if refused is not None:
            raise refused
        rows = self.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' AND hub_seq > ? "
                           "ORDER BY hub_seq LIMIT 100", (agent_id, int(after or 0)))
        changes = {"last_active_at": now()}
        # An Iter has no hub socket (its hive channel polls this inbox over HTTP), so its first poll is what
        # _register_connection is for an omega mind: the sign that it is up.
        row = self.db.one("SELECT kind, status, desired FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if row and row["kind"] == "iter" and row["desired"] == "awake" and row["status"] == "starting":
            changes["status"] = "awake"
        self.db.update("agents", agent_id, changes)
        if "status" in changes:
            self.emit_agent(agent_id)
        return {"messages": [{"seq": r["hub_seq"], "text": self.envelope(r)} for r in rows]}

    # ---- idle sleep ----------------------------------------------------------------------------

    def idle_candidates(self, moment=None):
        moment = moment or datetime.datetime.now(datetime.timezone.utc)
        rows = self.db.all("SELECT * FROM agents WHERE deleted = 0 AND status = 'awake' AND idle_sleep_minutes > 0")
        return [row["id"] for row in rows if self._idle(row, moment)]

    @staticmethod
    def _idle(row, moment=None):
        moment = moment or datetime.datetime.now(datetime.timezone.utc)
        if row.get("deleted") or row["status"] != "awake" or not (row["idle_sleep_minutes"] or 0) > 0:
            return False
        seen = parse_stamp(latest_stamp(row.get("last_input_at"), row.get("last_active_at")) or row["created_at"])
        if seen is None:
            return False                # an unreadable stamp never sleeps a mind
        return (moment - seen).total_seconds() >= row["idle_sleep_minutes"] * 60
