"""App platform P14: apps work as soon as they're installed.

A manifest says where an app lives (plugin.json, so the release digest pins it):
    "placement": "swarm"   the default: a shared swarm an admin turns the app on in, as before;
    "placement": "person"  each allowed person's own private space;
    "person_allow": "all" | ["user:u_...", ...]   who may use a person app (default "all": every member).

Installing is the review: one act by a named signed-in admin (never the local operator) records the admin, the release
digest, the placement, the declared dependencies (capabilities, template digests, related apps) and the audience (the
manifest's, or narrower). Only a current record for exactly that release and scope is consumed; reloads, updates,
startup and members opening the app never write one. A person app declaring templates must declare exactly one.

Opening a person app never spends and never wakes anyone. The host keeps one binding per (principal, app) to that
person's context swarm, durably unique. With no template the context is an empty private swarm, created and bound in one
transaction. With its one template the context is P2's own home, made only through P2's ensure after P2's own consent
card (the card() payload, unchanged); this open path holds no host lock when it enters ensure. Every reuse validates the
binding (owner, private, unshared, open, still P2's home); a bad binding fails closed into host recovery ("Set up
again"), never a silent replacement. Opening is serialised with disable, restriction and revocation under P2's program
and person locks. A scoped person activation makes the app active in that one context only: it is never an
app_activations row, so ProgramAttachments.required() is unchanged for every other swarm.

Paid work in a context runs on the person's own key only, checked when P1 admits an Ask turn and on every paid dispatch
(Gateway.authorize_agent); there is no fallback payer, and P1's ask_prefs.swarm_id cannot redirect a person app's frame.
Failures reach the person only as the fixed reason codes in REASONS. Private to the person; hive admins can audit (the
existing admin audit visibility of swarms, minds and Ask audit is unchanged).
"""

from __future__ import annotations

import collections
import contextlib
import json
import logging
import random
import re
import threading
import time
import weakref

from .db import new_id, now, parse_stamp
from .program_actions import named_person

log = logging.getLogger("hive")

PLACEMENTS = ("swarm", "person")
PRINCIPAL = re.compile(r"user:u_[A-Za-z0-9_-]{1,64}")
MAX_AUDIENCE = 500
MAX_USE_IN = 50
CREATIONS_PER_MINUTE = 20     # hive-wide, every context creation (auto-enrolled public members included)
MAX_PENDING = 50              # hive-wide, creations in flight
RESETS_PER_DAY = 3            # "Set up again", per person and app
PRIVATE_NOTE = "Private to you; hive admins can audit."

# The only failure projections a person sees: status, fixed text, one host action. Never another person's context, key
# metadata, connector accounts, paths or exception text.
REASONS = {
    "not_available_to_you": (403, "This app isn't available to you.", "back"),
    "app_turned_off": (409, "This app was turned off by an admin.", "ask_admin"),
    "not_reviewed": (409, "An admin hasn't finished installing this app yet.", "ask_admin"),
    "release_changed": (409, "This app was updated and needs an admin to review it again.", "ask_admin"),
    "space_needs_setup": (409, "Your space for this app can't be used any more.", "set_up_again"),
    "space_failed": (503, "Your hive couldn't create your space.", "try_again"),
    "busy": (429, "Your hive is busy. Try again in a moment.", "try_again"),
}

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS app_install_reviews (
  program TEXT PRIMARY KEY, release_digest TEXT NOT NULL, placement TEXT NOT NULL, deps TEXT NOT NULL,
  audience TEXT NOT NULL, by_person TEXT NOT NULL, at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT)""",
    # the binding: one context per (principal, app); a swarm is never two people's or two apps' context
    """CREATE TABLE IF NOT EXISTS app_person_contexts (
  principal TEXT NOT NULL, program_id TEXT NOT NULL, swarm_id TEXT NOT NULL UNIQUE, template_id TEXT,
  release_digest TEXT NOT NULL, created_at TEXT NOT NULL, key_id TEXT, PRIMARY KEY (principal, program_id))""",
    """CREATE TABLE IF NOT EXISTS app_person_contexts_retired (
  principal TEXT NOT NULL, program_id TEXT NOT NULL, swarm_id TEXT NOT NULL, retired_at TEXT NOT NULL)""",
    # the scoped host activation: this app, this one context, for this person; never read by required()
    """CREATE TABLE IF NOT EXISTS app_person_activations (
  program TEXT NOT NULL, swarm TEXT NOT NULL, principal TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (program, swarm))""",
)


def parse_placement(manifest):
    """plugin.json placement and person_allow -> (placement, audience). Raises ValueError (the app does not load)."""
    placement = manifest.get("placement", "swarm")
    if placement not in PLACEMENTS:
        raise ValueError('placement is "person" or "swarm"')
    if "person_allow" in manifest and placement != "person":
        raise ValueError('person_allow needs placement "person"')
    return placement, audience(manifest.get("person_allow", "all"))


def audience(value):
    if value == "all":
        return "all"
    if (not isinstance(value, list) or not 1 <= len(value) <= MAX_AUDIENCE or len(set(map(str, value))) != len(value)
            or any(not isinstance(p, str) or not PRINCIPAL.fullmatch(p) for p in value)):
        raise ValueError(f'person_allow is "all" or 1 to {MAX_AUDIENCE} unique signed-in people (user:u_...)')
    return sorted(value)


def within(narrow, wide):
    return wide == "all" or (narrow != "all" and set(narrow) <= set(wide))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class PersonApps:
    def __init__(self, hive, clock=time.monotonic):
        self.hive, self.db, self.clock = hive, hive.db, clock
        for statement in SCHEMA:
            hive.db.execute(statement)
        if "key_id" not in {c["name"] for c in hive.db.all("PRAGMA table_info(app_person_contexts)")}:
            hive.db.execute("ALTER TABLE app_person_contexts ADD COLUMN key_id TEXT")
        self._open_locks, self._open_guard = weakref.WeakValueDictionary(), threading.Lock()
        self._rate_guard = threading.Lock()
        self._created = collections.deque(maxlen=CREATIONS_PER_MINUTE)   # bounded: start times within the last minute
        self._pending = 0

    # ---- failures and who may ask ---------------------------------------------------------------------------------

    def failure(self, reason):
        status, text, action = REASONS[reason]
        return self.hive.error(status, "app_unavailable", text, {"reason": reason, "action": action})

    def _person(self, principal):
        """A current member or admin session's own principal, never the local operator."""
        row = self.db.one("SELECT role, disabled FROM people WHERE id = ?", (str(principal)[5:],)) \
            if named_person(principal) and str(principal).startswith("user:u_") else None
        if row is None or row["disabled"] or row["role"] not in ("admin", "member"):
            raise self.hive.error(403, "person_required", "only a signed-in member can open their own app space")

    # ---- install review --------------------------------------------------------------------------------------------

    @staticmethod
    def _deps(verified):
        return {"capabilities": verified["capabilities"], "related_apps": verified["related_apps"],
                "templates": verified["templates"]}

    def _review(self, program_id):
        return self.db.one("SELECT * FROM app_install_reviews WHERE program = ?", (program_id,))

    def review(self, actor, program_id, data):
        """The install-and-review act: a named signed-in admin, one pinned release, its placement, deps and audience."""
        self.hive.app_attachments.admin(actor)
        if not isinstance(data, dict) or set(data) - {"release_digest", "placement", "person_allow", "use_in"}:
            raise self.hive.error(400, "bad_request", "install takes release_digest, placement, person_allow and use_in")
        self.hive.programs.get(program_id)
        verified = self.hive.programs.verified_release(program_id)
        if verified is None:
            raise self.hive.error(409, "not_pinned", "only a pinned, loaded release can be installed")
        if data.get("release_digest") != verified["release_digest"] or data.get("placement") != verified["placement"]:
            raise self.hive.error(409, "card_changed", "this release changed since it was shown; look again")
        placement = verified["placement"]
        if placement == "person" and len(verified["templates"]) > 1:
            raise self.hive.error(409, "placement_templates", "a person app declares at most one swarm template")
        try:
            allowed = audience(data["person_allow"]) if data.get("person_allow") is not None else verified["person_allow"]
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc)) from None
        if placement != "person" and data.get("person_allow") is not None:
            raise self.hive.error(400, "bad_request", "person_allow is for person apps")
        if not within(allowed, verified["person_allow"]):
            raise self.hive.error(409, "audience_wider", "the audience may only narrow what the app declares")
        use_in = data.get("use_in") or []
        if (not isinstance(use_in, list) or len(use_in) > MAX_USE_IN or len(set(map(str, use_in))) != len(use_in)
                or any(not isinstance(s, str) for s in use_in)):
            raise self.hive.error(400, "bad_request", f"use_in is a list of at most {MAX_USE_IN} swarm ids")
        if use_in and placement != "swarm":
            raise self.hive.error(400, "bad_request", "a person app runs in each person's own space, not in chosen swarms")
        for swarm_id in use_in:
            if self.hive.swarm(swarm_id).get("archived_at"):
                raise self.hive.error(409, "swarm_archived", "an archived swarm cannot use an app")
        principal = actor["principal"]
        with self.hive.person_swarms._program_lock(program_id):   # serialised with opens of this app
            with self.db.transaction():
                self.db.execute(
                    "INSERT INTO app_install_reviews (program, release_digest, placement, deps, audience, by_person, at, "
                    "revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(program) DO UPDATE SET "
                    "release_digest = excluded.release_digest, placement = excluded.placement, deps = excluded.deps, "
                    "audience = excluded.audience, by_person = excluded.by_person, at = excluded.at, revoked_at = NULL, "
                    "revoked_by = NULL",
                    (program_id, verified["release_digest"], placement, canonical(self._deps(verified)),
                     canonical(allowed), principal, now()))
                for swarm_id in use_in:   # "Use in": today's per-swarm activation, recorded in the same admin act
                    self.db.execute("INSERT INTO app_activations VALUES (?,?,1,?) ON CONFLICT(program,swarm) DO UPDATE "
                                    "SET active=1,by_person=excluded.by_person", (program_id, swarm_id, principal))
        if program_id in self.hive.programs.disabled:
            self.hive.programs.set_enabled(program_id, True, principal)
        for swarm_id in use_in:
            self.hive.events.publish("program.activation", program=program_id, swarm_id=swarm_id, active=True)
        self.hive.events.publish("program.install_reviewed", program=program_id, placement=placement)
        return self.status(program_id, admin=True)

    def restrict(self, actor, program_id, data):
        """The admin narrows who may use a person app; fenced at once (every open, admission and paid call reads it)."""
        self.hive.app_attachments.admin(actor)
        if not isinstance(data, dict) or set(data) != {"person_allow"}:
            raise self.hive.error(400, "bad_request", "restrict takes person_allow")
        try:
            allowed = audience(data["person_allow"])
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc)) from None
        with self.hive.person_swarms._program_lock(program_id):
            row = self._review(program_id)
            if row is None or row["revoked_at"] or row["placement"] != "person":
                raise self.hive.error(409, "not_reviewed", "install this person app first")
            if not within(allowed, json.loads(row["audience"])):
                raise self.hive.error(409, "audience_wider", "widening who may use the app needs a new install review")
            self.db.execute("UPDATE app_install_reviews SET audience = ? WHERE program = ?", (canonical(allowed), program_id))
        self._fence_frames(program_id)
        self.hive.events.publish("program.install_reviewed", program=program_id, placement="person")
        return self.status(program_id, admin=True)

    def revoke(self, actor, program_id):
        """Withdraw the review: no person context opens or runs until a new admin install."""
        self.hive.app_attachments.admin(actor)
        with self.hive.person_swarms._program_lock(program_id):
            self.db.execute("UPDATE app_install_reviews SET revoked_at = ?, revoked_by = ? WHERE program = ? AND "
                            "revoked_at IS NULL", (now(), actor["principal"], program_id))
        self._fence_frames(program_id)
        self.hive.events.publish("program.install_reviewed", program=program_id, placement=None)
        return self.status(program_id, admin=True)

    def _fence_frames(self, program_id):
        links = getattr(self.hive, "app_links", None)
        if links is not None:
            links.revoke_program(program_id)

    def status(self, program_id, admin=False, principal=None):
        """What the install screen shows. Members see only the placement and whether it is installed for them (audience
        first: someone outside a person app's audience sees it as not installed)."""
        entry = self.hive.programs.get(program_id)
        verified = self.hive.programs.verified_release(program_id)
        row = self._review(program_id)
        installed = self._current(row, verified) is not None
        if not admin and installed and row["placement"] == "person":
            allowed = json.loads(row["audience"])
            installed = allowed == "all" or principal in allowed
        out = {"program": program_id, "placement": entry.get("placement") or "swarm", "installed": installed}
        if admin:
            out["release_digest"] = verified["release_digest"] if verified else None
            out["person_allow"] = verified["person_allow"] if verified else None
            out["templates"] = len(verified["templates"]) if verified else None
            out["review"] = None if row is None else {
                "release_digest": row["release_digest"], "placement": row["placement"], "by": row["by_person"],
                "at": row["at"], "person_allow": json.loads(row["audience"]), "revoked": bool(row["revoked_at"])}
        return out

    def _current(self, row, verified):
        """The review record consumed for this release and scope, or None."""
        if row is None or verified is None or row["revoked_at"]:
            return None
        if (row["release_digest"] != verified["release_digest"] or row["placement"] != verified["placement"]
                or row["deps"] != canonical(self._deps(verified))
                or not within(json.loads(row["audience"]), verified["person_allow"])):
            return None
        return row

    # ---- authority for a person ------------------------------------------------------------------------------------

    def is_person_app(self, program_id):
        entry = self.hive.programs.programs.get(program_id)
        return bool(entry) and entry.get("placement") == "person"

    def _authorized(self, principal, program_id):
        """(verified release, review) for this person and app, or a fixed failure. Audience first: a person outside it
        learns nothing more about the app's state."""
        entry = self.hive.programs.programs.get(program_id)
        if entry is None or entry.get("placement") != "person":
            raise self.failure("not_available_to_you")
        row = self._review(program_id)
        allowed = json.loads(row["audience"]) if row is not None and not row["revoked_at"] else entry.get("person_allow", "all")
        if allowed != "all" and principal not in allowed:
            raise self.failure("not_available_to_you")
        if program_id in self.hive.programs.disabled:
            raise self.failure("app_turned_off")
        if row is None:
            raise self.failure("not_reviewed")
        if row["revoked_at"]:
            raise self.failure("app_turned_off")
        verified = self.hive.programs.verified_release(program_id)
        if self._current(row, verified) is None:
            raise self.failure("release_changed")
        try:
            self.hive.programs._ready(program_id)
        except Exception:   # noqa: BLE001  (refused or moved since: the release no longer stands)
            raise self.failure("release_changed") from None
        return verified, row

    @staticmethod
    def _template_id(verified):
        ids = sorted(verified["templates"])
        return ids[0] if len(ids) == 1 else None

    # ---- the binding ---------------------------------------------------------------------------------------------

    def binding(self, principal, program_id):
        return self.db.one("SELECT * FROM app_person_contexts WHERE principal = ? AND program_id = ?", (principal, program_id))

    def _valid(self, b, template_id):
        """Owner, private, unshared, open; for a template app, still P2's home for its one template."""
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (b["swarm_id"],))
        if swarm is None or swarm.get("archived_at") or swarm.get("owner") != b["principal"] \
                or swarm.get("visibility") != "private" or json.loads(swarm.get("shared_with") or "[]"):
            return False
        if b["template_id"] != template_id:
            return False
        if template_id is not None:
            home = self.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ? AND program_id = ? AND "
                               "template_id = ?", (b["principal"], b["program_id"], template_id))
            if home is None or home["swarm_id"] != b["swarm_id"]:
                return False
        return True

    def _fresh_swarm(self, principal, swarm_id):
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        return bool(swarm) and not swarm.get("archived_at") and swarm.get("owner") == principal \
            and swarm.get("visibility") == "private" and not json.loads(swarm.get("shared_with") or "[]")

    def _bind(self, principal, program_id, swarm_id, template_id, verified):
        """One transaction: the binding and its scoped activation (a unique swarm per binding)."""
        stamp = now()
        self.db.insert("app_person_contexts", {"principal": principal, "program_id": program_id, "swarm_id": swarm_id,
                                               "template_id": template_id, "release_digest": verified["release_digest"],
                                               "created_at": stamp})
        self.db.execute("INSERT INTO app_person_activations (program, swarm, principal, at) VALUES (?, ?, ?, ?) "
                        "ON CONFLICT(program, swarm) DO NOTHING", (program_id, swarm_id, principal, stamp))

    @contextlib.contextmanager
    def _fence(self, principal, program_id):
        """P2's own order (program -> person): the same locks disable, uninstall and withdrawal take."""
        swarms = self.hive.person_swarms
        with swarms._program_lock(program_id), swarms._lock(principal, program_id):
            yield

    def _open_lock(self, principal, program_id):
        """P14's own per-(principal, app) lock: concurrent first opens make one context and one P2 ensure. Nothing else
        takes it, so it cannot invert P2's or P12's lock order."""
        with self._open_guard:
            lock = self._open_locks.get((principal, program_id))
            if lock is None:
                lock = self._open_locks[(principal, program_id)] = threading.RLock()
            return lock

    @contextlib.contextmanager
    def _creation_slot(self):
        """Hive-wide: at most CREATIONS_PER_MINUTE starts a minute and MAX_PENDING in flight; over either, busy with
        nothing made."""
        at = self.clock()
        with self._rate_guard:
            while self._created and at - self._created[0] >= 60:
                self._created.popleft()
            if len(self._created) >= CREATIONS_PER_MINUTE or self._pending >= MAX_PENDING:
                raise self.failure("busy")
            self._created.append(at)
            self._pending += 1
        try:
            yield
        finally:
            with self._rate_guard:
                self._pending -= 1

    # ---- opening -------------------------------------------------------------------------------------------------

    def open(self, principal, program_id):
        """{'state': 'ready', 'swarm_id', 'needs', 'helpers', ...} or a fixed failure. Free: nothing spends or wakes.
        The app always opens in the person's own context; helpers ('none' | 'ready' | 'consent_required' |
        'key_required') says what the app's one template, if any, still needs."""
        self._person(principal)
        with self._open_lock(principal, program_id):
            verified, _review = self._authorized(principal, program_id)
            template_id = self._template_id(verified)
            if template_id is None and verified["templates"]:
                raise self.failure("release_changed")   # refused at review; never pick one of several
            swarm_id = self._context(principal, program_id, template_id)
            if template_id is None:
                return self._ready(principal, program_id, swarm_id, "none")
            return self._helpers(principal, program_id, template_id, swarm_id)

    def _context(self, principal, program_id, template_id):
        """The person's context, bound before any helper exists: a valid binding is reused; P2's existing open home for
        the template is adopted (nothing made, no creation slot); otherwise one empty private swarm is created and bound
        in one transaction (for a template app it is also recorded as P2's home, so P2's ensure later fills this same
        swarm). An invalid binding or an unusable P2 home fails closed; nothing is replaced here."""
        with self._fence(principal, program_id):
            verified, _review = self._authorized(principal, program_id)
            b = self.binding(principal, program_id)
            if b is not None:
                if not self._valid(b, template_id):
                    raise self.failure("space_needs_setup")
                return b["swarm_id"]
            home = self._p2_home(principal, program_id, template_id) if template_id is not None else None
            if home is not None:
                if not self._fresh_swarm(principal, home) or self._bound(home) is not None:
                    raise self.failure("space_failed")   # never a second home beside one P2 still holds helpers in
                try:
                    with self.db.transaction():
                        self._bind(principal, program_id, home, template_id, verified)
                except Exception:   # noqa: BLE001
                    raise self.failure("space_failed") from None
                return home
            with self._creation_slot():   # only a real create counts against the hive-wide limits
                name = str(self.hive.programs.get(program_id).get("name") or program_id).strip()[:60] or program_id
                row = {"id": new_id("s"), "name": name, "description": "Your own space for this app",
                       "hue": random.randrange(360), "created_at": now(),
                       **self.hive._visibility_fields(principal, "private", None)}
                try:
                    with self.db.transaction():   # atomic create-and-bind: all or nothing
                        self.db.insert("swarms", row)
                        if template_id is not None:
                            self.db.execute("INSERT INTO app_person_swarms (principal, program_id, template_id, swarm_id, "
                                            "created_at) VALUES (?, ?, ?, ?, ?)",
                                            (principal, program_id, template_id, row["id"], row["created_at"]))
                        self._bind(principal, program_id, row["id"], template_id, verified)
                except Exception:   # noqa: BLE001
                    log.exception("person app: %s context not created", program_id)
                    raise self.failure("space_failed") from None
            self.hive.events.publish("swarm.updated", swarm=self.hive.swarm_view(row))
            self.hive._team_sync(row["id"])
            return row["id"]

    def _p2_home(self, principal, program_id, template_id):
        row = self.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ? AND program_id = ? AND template_id = ?",
                          (principal, program_id, template_id))
        return row["swarm_id"] if row else None

    def _helpers(self, principal, program_id, template_id, swarm_id):
        """The app's one template in the bound context: P2's card (unchanged) until consent, then P2's own ensure."""
        swarms = self.hive.person_swarms
        try:
            card = swarms.card(principal, program_id, template_id)   # the host card() payload, unchanged
        except Exception:   # noqa: BLE001
            raise self.failure("space_failed") from None
        if card["key_id"] is None or card["month_usd"] is None:
            return self._ready(principal, program_id, swarm_id, "key_required")
        if not card["consent_current"]:
            return self._consent_required(principal, program_id, swarm_id, card)
        if self._deployed(principal, program_id, template_id):
            return self._ready(principal, program_id, swarm_id, "ready")
        try:
            # P2's own ensure, into the home bound above: its locks, tombstones and key lock. No host lock held here.
            out = swarms.ensure(principal, program_id, template_id)
        except Exception as exc:   # noqa: BLE001
            if getattr(exc, "code", None) == "card_changed":
                return self._consent_required(principal, program_id, swarm_id, swarms.card(principal, program_id, template_id))
            log.info("person app: %s ensure refused (%s)", program_id, getattr(exc, "code", type(exc).__name__))
            raise self.failure("space_failed") from None
        if out.get("status") != "ready":
            return self._consent_required(principal, program_id, swarm_id, out["card"])
        with self._fence(principal, program_id):
            try:
                self._authorized(principal, program_id)   # a disable, revocation or restriction meanwhile wins
                b = self.binding(principal, program_id)
                if b is None or b["swarm_id"] != out["swarm_id"] or not self._valid(b, template_id):
                    raise self.failure("space_needs_setup")
            except Exception:
                self._sleep_helpers(principal, program_id, template_id)   # fresh helpers never outlive withdrawn access
                raise
        return self._ready(principal, program_id, swarm_id, "ready")

    def _sleep_helpers(self, principal, program_id, template_id):
        """P2's sleep half without a tombstone: every helper of this template asleep and stopped. (Dispatch is refused
        anyway: authorize_agent fails closed for helpers whose access no longer stands.)"""
        for r in self.db.all("SELECT agent_id FROM app_person_minds WHERE principal = ? AND program_id = ? AND "
                             "template_id = ?", (principal, program_id, template_id)):
            row = self.db.one("SELECT status, desired FROM agents WHERE id = ? AND deleted = 0", (r["agent_id"],))
            if row is None or row["status"] == row["desired"] == "asleep":
                continue
            self.db.update("agents", r["agent_id"], {"desired": "asleep", "last_error": "App access ended"})
            try:
                self.hive.supervisor.stop(r["agent_id"])
            except Exception:   # noqa: BLE001
                log.exception("person app: helper %s not stopped", r["agent_id"])

    def _deployed(self, principal, program_id, template_id):
        """Every slot of the template has a finished mind P2 calls current: nothing for ensure to make or repair."""
        swarms = self.hive.person_swarms
        try:
            _program, template = swarms.template(program_id, template_id)
        except Exception:   # noqa: BLE001  (ensure decides, and its refusal is projected as a fixed reason)
            return False
        rows = {r["slot"]: r for r in swarms._bindings(program_id, principal) if r["template_id"] == template_id}
        return all(m["slot"] in rows and swarms.current(rows[m["slot"]]["agent_id"])[1] is None for m in template["minds"])

    def _consent_required(self, principal, program_id, swarm_id, card):
        names = [m["name"] for m in card["minds"]]
        listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
        month = card["month_usd"]
        total = "" if month is None else f", within ${month:,.2f} a month"
        # display only: consent binds the card's five fields, never this sentence
        line = f"{card['program_name']} will set up your space with {listed}, on your own AI key{total}."
        return dict(self._ready(principal, program_id, swarm_id, "consent_required"), card=card, space_line=line)

    def _ready(self, principal, program_id, swarm_id, helpers):
        return {"state": "ready", "program": program_id, "swarm_id": swarm_id, "needs": self._key_needs(principal),
                "helpers": helpers, "private": PRIVATE_NOTE}

    def _own_keys(self, principal):
        keyring = getattr(self.hive, "keyring", None)
        return {r["id"]: r for r in (((keyring.ring.get("keys") if keyring else None) or {}).values())
                if r.get("owner") == principal}

    def _key_needs(self, principal):
        needs = []
        if not self._own_keys(principal):
            needs.append("ai_key")
        if self.hive.person_swarms._month_total(principal) is None:
            needs.append("monthly_total")
        return needs

    def reset(self, principal, program_id):
        """"Set up again": the one host action out of recovery for an app without a template. Retires an unusable
        binding (its swarm is left as it is, never deleted), then opens as usual. A usable binding is never replaced.
        A template app is refused up front with nothing changed: P2 keeps finished helpers in their home and has no
        repair that moves them, so a replacement home would only be left behind (space_failed)."""
        self._person(principal)
        with self._open_lock(principal, program_id):
            verified, _review = self._authorized(principal, program_id)
            template_id = self._template_id(verified)
            with self._fence(principal, program_id):
                b = self.binding(principal, program_id)
                if b is not None and not self._valid(b, template_id):
                    if template_id is not None or b["template_id"] is not None:
                        raise self.failure("space_failed")
                    since = parse_stamp(now()).timestamp() - 86400
                    recent = [r for r in self.db.all("SELECT retired_at FROM app_person_contexts_retired WHERE principal = ? "
                                                     "AND program_id = ?", (principal, program_id))
                              if (parse_stamp(r["retired_at"]) and parse_stamp(r["retired_at"]).timestamp() > since)]
                    if len(recent) >= RESETS_PER_DAY:
                        raise self.failure("busy")
                    with self.db.transaction():
                        self.db.insert("app_person_contexts_retired", {"principal": principal, "program_id": program_id,
                                                                       "swarm_id": b["swarm_id"], "retired_at": now()})
                        self.db.execute("DELETE FROM app_person_contexts WHERE principal = ? AND program_id = ?",
                                        (principal, program_id))
                        self.db.execute("DELETE FROM app_person_activations WHERE program = ? AND swarm = ?",
                                        (program_id, b["swarm_id"]))
            return self.open(principal, program_id)

    # ---- read by the host: activation, frames, admission and paid dispatch ------------------------------------------

    def _bound(self, swarm_id):
        return self.db.one("SELECT * FROM app_person_contexts WHERE swarm_id = ?", (swarm_id,)) if swarm_id else None

    def _usable(self, b):
        """The binding still stands and its person still may use the app (no writes, no locks)."""
        try:
            verified, _review = self._authorized(b["principal"], b["program_id"])
        except Exception:   # noqa: BLE001
            return False
        return self._valid(b, self._template_id(verified))

    def active_here(self, program_id, swarm_id):
        """The scoped activation: true only in that one context swarm, while its binding and authority stand."""
        try:
            act = self.db.one("SELECT principal FROM app_person_activations WHERE program = ? AND swarm = ?",
                              (program_id, swarm_id))
            b = self._bound(swarm_id)
            return bool(act and b and b["program_id"] == program_id and b["principal"] == act["principal"]
                        and self._usable(b))
        except Exception:   # noqa: BLE001
            return False

    def frame_swarm(self, principal, program_id):
        """P1: a person app's frame is bound to the person's validated context; ask_prefs.swarm_id never redirects it.
        None for a swarm app (unchanged). Raises a fixed failure when there is no usable context."""
        if not self.is_person_app(program_id):
            return None
        self._authorized(principal, program_id)
        b = self.binding(principal, program_id)
        if b is None or not self._usable(b):
            raise self.failure("space_needs_setup")
        return b["swarm_id"]

    def _pinned_key(self, b):
        """The one own key this context pays with: a template app's current P2 consent key; otherwise the first own key
        a mind in the context dispatched with (recorded on the binding). None until there is one."""
        if b["template_id"] is not None:
            c = self.db.one("SELECT key_id FROM app_person_consents WHERE principal = ? AND program_id = ? AND "
                            "template_id = ? AND withdrawn_at IS NULL", (b["principal"], b["program_id"], b["template_id"]))
            return c["key_id"] if c else None
        return b.get("key_id")

    def require_paid(self, principal, program_id, swarm_id):
        """At P1 admission of a person app's Ask turn: the validated context, the person's own key and monthly total,
        and (once pinned) that exact key. There is no other payer to fall back to."""
        if not self.is_person_app(program_id):
            return
        if self.frame_swarm(principal, program_id) != swarm_id:
            raise self.failure("space_needs_setup")
        pinned = self._pinned_key(self.binding(principal, program_id))
        if self._key_needs(principal) or (pinned is not None and pinned not in self._own_keys(principal)):
            raise self.hive.error(402, "own_key_needed", "Add your own AI key and a monthly total to use this app.")

    def _person_placed(self, program_id):
        """A P2 provenance row's app is a person app, or no longer loaded (then fail closed too)."""
        entry = self.hive.programs.programs.get(program_id)
        return entry is None or entry.get("placement") == "person"

    def authorize_agent(self, agent_id):
        """Every paid dispatch (Gateway.authorize_agent): P2's own check, then the person-app fence. A mind in a person
        context, or any P2 helper or home of a person app (durable P2 provenance: app_person_minds, app_person_swarms),
        runs only while that person's P14 binding for that app names this swarm and still stands, and only on the
        context's one pinned own key. A helper made before its binding (a revocation or crash between P2's ensure and
        the bind) therefore fails closed. Errors here are deliberately generic: routes outside the app show them."""
        self.hive.person_swarms.require_current(agent_id)
        row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if row is None:
            return
        b = self._bound(row["swarm_id"])
        provenance = self.db.all("SELECT principal, program_id FROM app_person_minds WHERE agent_id = ?", (agent_id,)) + \
            (self.db.all("SELECT principal, program_id FROM app_person_swarms WHERE swarm_id = ?", (row["swarm_id"],))
             if row["swarm_id"] else [])
        for p in provenance:
            if self._person_placed(p["program_id"]) and (b is None or b["principal"] != p["principal"]
                                                         or b["program_id"] != p["program_id"]):
                raise self.hive.error(409, "app_unavailable", "This app can't run here any more.")
        if b is None:
            return
        if not self._usable(b):
            raise self.hive.error(409, "app_unavailable", "This app can't run here any more.")
        options = json.loads(row.get("options") or "{}")
        key = self._own_keys(b["principal"]).get(options.get("key"))
        if options.get("key_locked") is not True or key is None or row.get("owner") != b["principal"]:
            raise self.hive.error(402, "own_key_needed", "This app runs only on its person's own AI key.")
        pinned = self._pinned_key(b)
        if pinned is None and b["template_id"] is None:   # the first own key used here is the context's key from now on
            self.db.execute("UPDATE app_person_contexts SET key_id = ? WHERE principal = ? AND program_id = ? AND "
                            "key_id IS NULL", (options["key"], b["principal"], b["program_id"]))
            pinned = self._pinned_key(self.binding(b["principal"], b["program_id"]))
        if pinned != options.get("key"):
            raise self.hive.error(402, "own_key_needed", "This app runs only on the own AI key it was set up with.")
        if self.hive.person_swarms._month_total(b["principal"]) is None:
            raise self.hive.error(402, "monthly_total_required", "Set a monthly total for your own keys first.")
