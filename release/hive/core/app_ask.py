"""P1: app-scoped presentation of the existing Ask, never another Ask or transcript.

Turn transitions take a per-turn mutex before the short DB transaction. Generation
fences are independent in-memory flags set BEFORE waiting for either lock; the
final admission/handback gate checks them again. No await holds either lock.
Only consent and content-free binding metadata persist here. Lease clocks,
subscriptions, cards and act redemption live in this process and die on restart.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import logging
import re
import threading
import time
import uuid
import weakref

from .db import now
from .program_actions import named_person

MAX_BYTES = 8192
EVENT_BYTES = 61440
OUTBOX_BYTES = 61440
OUTBOX_EVENTS = 16
CHUNK_BYTES = 3072
SUBSCRIPTIONS = 16
LEASE = 15.0
RENEW = 5.0
PERMISSION = "may send to and show your Ask while open"
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,120}")
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS app_ask_consents (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, app_id TEXT NOT NULL, digest TEXT NOT NULL,
      epoch INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, initial_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS app_ask_generations (
      id TEXT PRIMARY KEY, consent_id TEXT NOT NULL, consent_epoch INTEGER NOT NULL,
      session_hash TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL,
      swarm_id TEXT, focus TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS app_ask_turns (
      turn_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, consent_id TEXT NOT NULL,
      origin TEXT NOT NULL, initial_generation TEXT, UNIQUE(consent_id, operation_id))""",
    """CREATE TABLE IF NOT EXISTS app_ask_presentations (
      turn_id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation_id TEXT,
      host_active INTEGER NOT NULL, epoch INTEGER NOT NULL)""",
)
OPS = {
    "send": ({"op", "text", "op_id"}, {"context"}),
    "resume": ({"op", "operation_id", "expected_epoch"}, set()),
    "subscribe": ({"op", "operation_id"}, set()),
    "unsubscribe": ({"op", "subscription_id"}, set()),
    "poll": ({"op", "subscription_id", "cursor"}, set()),
    "act-claim": ({"op", "operation_id", "act_id", "expected_epoch"}, set()),
    "act-result": ({"op", "operation_id", "act_id", "result"}, set()),
    "yield": ({"op", "operation_id"}, set()),
    # G2/G4 reads: the signed-in person's own notices and spend for this app's own context; no turn, no write
    "notices": ({"op"}, {"after"}),
    "spend": ({"op"}, {"days"}),
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def closed(data, required, optional=()):
    return isinstance(data, dict) and set(data) >= set(required) and not set(data) - set(required) - set(optional)


def integer(value):
    return type(value) is int and value >= 0


class AppAsk:
    def __init__(self, hive, clock=time.monotonic, wall_clock=time.time):
        self.hive, self.clock, self.wall_clock = hive, clock, wall_clock
        self.deadlines, self.cards, self.subscriptions, self.rates = {}, {}, {}, {}
        self.act_recipients, self.claimed = {}, set()
        self.live_frames = {}   # personal frames only, generation-scoped, raw canonical bytes, never persisted
        self.fenced, self.generation_index = {}, {}
        self.generation_signins = {}
        self.turn_locks = weakref.WeakValueDictionary()
        self.pending_teardown = set()
        self.lock_guard = threading.Lock()
        for statement in SCHEMA:
            hive.db.execute(statement)
        columns = {r["name"] for r in hive.db.all("PRAGMA table_info(app_ask_consents)")}
        for column in ("first_session_only", "first_session_used"):
            if column not in columns:
                hive.db.execute(f"ALTER TABLE app_ask_consents ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
        # No persisted wall-clock lease can revive a frame or an outstanding act.
        with hive.db.transaction():
            hive.db.execute("UPDATE app_ask_generations SET status = 'suspended' WHERE status = 'active'")
            hive.db.execute("UPDATE app_ask_presentations SET owner = 'host', generation_id = NULL, "
                            "host_active = 0, epoch = epoch + 1 WHERE owner = 'frame'")

    def error(self, code, status=409):
        return self.hive.error(status, code, "The app's Ask is unavailable; return to the host Ask.")

    def _person(self, viewer, session_hash):
        row = self.hive.db.one("SELECT * FROM sessions WHERE token_hash = ?", (session_hash,))
        person = self.hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (viewer.principal[5:],)) \
            if named_person(viewer.principal) else None
        if not person or person["disabled"] or person["role"] not in ("admin", "member") or not row \
                or row.get("kind") not in ("sso", "member_password") or row.get("principal") != viewer.principal \
                or (row.get("expires_at") is not None and row["expires_at"] <= self.wall_clock()):
            raise self.error("not_available", 403)
        return row

    def _release(self, app):
        release = self.hive.programs.pinned_release(app)
        if not release or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(release.get("digest", ""))):
            raise self.error("not_available")
        entry = self.hive.programs.get(app)
        if not isinstance(entry.get("name"), str) or not 0 < len(entry["name"]) <= 120 \
                or not isinstance(release.get("version"), str) or not 0 < len(release["version"]) <= 120:
            raise self.error("not_available")
        return release, entry

    @staticmethod
    def card_semantics(card):
        """Only displayed/bound meaning; never a host card nonce or expiry token."""
        fields = ("app_id", "name", "release_digest", "version", "consent_id",
            "consent_epoch", "consented", "permission", "related_apps")
        if not isinstance(card, dict) or not set(fields) <= set(card):
            raise ValueError("invalid Ask card semantic fields")
        if any(not isinstance(card[key], str) for key in ("app_id", "name", "release_digest", "version", "permission")) \
                or card["consent_id"] is not None and not isinstance(card["consent_id"], str) \
                or type(card["consent_epoch"]) is not int or card["consent_epoch"] < 0 or type(card["consented"]) is not bool \
                or not isinstance(card["related_apps"], list) or any(not isinstance(value, str) for value in card["related_apps"]):
            raise ValueError("invalid Ask card semantic values")
        return {key: card[key] for key in fields}

    def card_metadata(self, viewer, session_hash, app):
        """Read the display binding without creating, pruning or consuming cards."""
        with self.hive.db.transaction():
            self._person(viewer, session_hash)
            release, _ = self._release(app)
            manifest = self.hive.programs.link_manifest(app)
            if manifest["release_digest"] != release["digest"] or manifest["version"] != release["version"]:
                raise self.error("card_changed")
            consent = self.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? ORDER BY epoch DESC, revoked ASC, created_at DESC, id DESC LIMIT 1",
                                       (viewer.principal, app, release["digest"]))
            return {"app_id": app, "name": manifest["name"], "release_digest": release["digest"],
                "version": release["version"], "consent_id": consent["id"] if consent else None,
                "consent_epoch": consent["epoch"] if consent else 0,
                "consented": bool(consent and not consent["revoked"] and not consent.get("first_session_only")),
                "permission": PERMISSION, "related_apps": list(manifest["related_apps"])}

    def card(self, viewer, session_hash, app):
        with self.hive.db.transaction():
            metadata = self.card_metadata(viewer, session_hash, app)
            card = None
            if not metadata["consented"]:
                # Bound memory and lifetime; a card is host-only, never a frame capability.
                self.cards = {k: v for k, v in self.cards.items() if v["until"] > self.clock()}
                if len(self.cards) >= 256:
                    raise self.error("rate_limited")
                card = str(uuid.uuid4())
                self.cards[card] = {"principal": viewer.principal, "session": session_hash, "app": app,
                    "digest": metadata["release_digest"], "epoch": metadata["consent_epoch"], "until": self.clock() + 120}
            return dict(metadata, card_id=card)

    def consent(self, viewer, session_hash, app, data, *, first_session=False, defer_fences=False):
        if not closed(data, {"card_id"}) or not isinstance(data["card_id"], str):
            raise self.error("invalid", 400)
        with self.hive.db.transaction():
            self._person(viewer, session_hash)
            card = self.cards.get(data["card_id"])
            release, _ = self._release(app)
            current = self.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? ORDER BY epoch DESC, revoked ASC, created_at DESC, id DESC LIMIT 1",
                                       (viewer.principal, app, release["digest"]))
            if not card or card["until"] <= self.clock() or card["principal"] != viewer.principal \
                    or card["session"] != session_hash or card["app"] != app or card["digest"] != release["digest"] \
                    or card["epoch"] != (current["epoch"] if current else 0):
                raise self.error("card_changed")
            if current and not current["revoked"] and not current.get("first_session_only"):
                raise self.error("card_changed")
            if current and current.get("first_session_only"):
                generations = tuple(row["id"] for row in self.hive.db.all(
                    "SELECT id FROM app_ask_generations WHERE consent_id = ? AND status = 'active'", (current["id"],)))
                if generations:
                    # SQL belongs to this transaction. Process lease state must
                    # wait for the outermost commit; rollback drops the callback.
                    self.hive.db.execute("UPDATE app_ask_generations SET status = 'replaced' WHERE consent_id = ? AND status = 'active'", (current["id"],))
                    # Capture the complete old-consent scope while the SQL gate is held.
                    # Once revoked at commit, this consent cannot gain another generation.
                    all_generations = tuple(row["id"] for row in self.hive.db.all(
                        "SELECT id FROM app_ask_generations WHERE consent_id = ? ORDER BY id", (current["id"],)))
                    self.hive.db.after_commit(lambda consent_id=current["id"], generations=generations,
                        all_generations=all_generations: self._replacement_fences_after_commit(consent_id, generations, all_generations))
                self.hive.db.execute("UPDATE app_ask_consents SET revoked = 1, epoch = epoch + 1 WHERE id = ?", (current["id"],))
            self.hive.db.insert("app_ask_consents", {"id": str(uuid.uuid4()), "principal": viewer.principal,
                "app_id": app, "digest": release["digest"], "epoch": current["epoch"] + 1 if current else 1, "revoked": 0,
                "initial_used": 0, "first_session_only": int(first_session), "first_session_used": 0, "created_at": now()})
            self.cards.pop(data["card_id"], None)
        # P12's outer transaction/Link/P2 gates must all be released before
        # teardown may wait for a turn. Its caller drains in its outer finally.
        if not defer_fences:
            self.drain_fences()
        return {"granted": True} if first_session else self.card(viewer, session_hash, app)

    def _replacement_fences_after_commit(self, consent_id, generations, all_generations):
        """Guard the replaceable callback: a committed replacement must fail closed."""
        try:
            self._committed_replacement_fences(generations)
        except Exception as error:
            # Authority fences come first, even if cleanup or logging also fails.
            # Never widen this immutable SQL-captured scope to another/new consent.
            for generation in all_generations:
                self.fenced.setdefault(generation, "replaced")
                self.pending_teardown.add(generation)
            cleanup_error_type = None
            try:
                chosen = frozenset(all_generations)
                with self.hive.db._lock:  # mutex only; no SQL, transaction or turn wait
                    for generation in all_generations:
                        self.deadlines.pop(generation, None)
                        self.rates.pop(generation, None)
                    self.subscriptions = {k: v for k, v in self.subscriptions.items() if v["generation"] not in chosen}
                    self.live_frames = {k: v for k, v in self.live_frames.items() if k[0] not in chosen}
            except Exception as cleanup_error:
                cleanup_error_type = type(cleanup_error).__name__
            # Do not log arbitrary exception text or traceback/private payload.
            logger = logging.getLogger(__name__)
            logger.error("AppAsk replacement callback failed; old consent=%s error_type=%s",
                         consent_id, type(error).__name__)
            if cleanup_error_type is not None:
                logger.error("AppAsk replacement cleanup failed; old consent=%s error_type=%s",
                             consent_id, cleanup_error_type)

    def _committed_replacement_fences(self, generations):
        """Commit-dependent process metadata only; never SQL or turn teardown."""
        chosen = frozenset(generations)
        # Share the existing short map-serialization gate with normal P1 ops.
        # This is a mutex only: no transaction, SQL, application callback or wait
        # on a turn is introduced while the outer link/P2 gates remain held.
        with self.hive.db._lock:
            for generation in generations:
                self.fenced.setdefault(generation, "replaced")  # a concurrent raw reason wins
                self.deadlines.pop(generation, None)
                self.rates.pop(generation, None)
            self.subscriptions = {k: v for k, v in self.subscriptions.items() if v["generation"] not in chosen}
            self.live_frames = {k: v for k, v in self.live_frames.items() if k[0] not in chosen}
            self.pending_teardown.update(generations)

    def revoke(self, viewer, session_hash, app):
        links = getattr(self.hive, "app_links", None)
        # Preserve P1's raw early generation fence. The complete P12 revocation
        # then serializes with reviews/minting, before taking the DB gate.
        self._mark_matching(viewer.principal, app)
        with links.guard if links is not None else contextlib.nullcontext():
            if links is not None:
                links.revoke_app(viewer.principal, app)
            with self.hive.db.transaction():
                self._person(viewer, session_hash)
                self.hive.db.execute("UPDATE app_ask_consents SET revoked = 1, epoch = epoch + 1 WHERE principal = ? AND app_id = ?",
                                     (viewer.principal, app))
                generations = self.hive.db.all("SELECT g.id FROM app_ask_generations g JOIN app_ask_consents c ON c.id = g.consent_id "
                                                "WHERE c.principal = ? AND c.app_id = ? AND g.status = 'active'", (viewer.principal, app))
                for generation in generations:
                    self._fence(generation["id"], "revoked")
                self.cards = {k: v for k, v in self.cards.items() if not (v["principal"] == viewer.principal and v["app"] == app)}
        self.drain_fences()
        return {"revoked": True}

    def _lookup(self, generation):
        return self.hive.db.one("SELECT g.*, c.principal, c.app_id, c.digest, c.epoch AS current_epoch, c.revoked, c.first_session_only "
                               "FROM app_ask_generations g JOIN app_ask_consents c ON c.id = g.consent_id WHERE g.id = ?", (generation,))

    def turn_gate(self, principal, operation):
        with self.lock_guard:
            return self.turn_locks.setdefault((principal, operation), threading.RLock())

    def admission_gate(self, binding):
        return self.turn_gate(binding["principal"], binding["source"]) if binding and binding.get("source") else contextlib.nullcontext()

    def mark_fenced(self, generation, status):
        # No DB or turn lock: leave/sign-out wins even while a resume holds the turn mutex.
        self.fenced[generation] = status
        self.pending_teardown.add(generation)

    def mark_session(self, session_hash):
        links = getattr(self.hive, "app_links", None)
        if links is not None:
            links.mark_session(session_hash)
        for generation, identity in list(self.generation_index.items()):
            if identity[1] == session_hash:
                self.mark_fenced(generation, "signed_out")

    def mark_signin(self, signin_hash):
        links = getattr(self.hive, "app_links", None)
        if links is not None and signin_hash:
            links.mark_signin(signin_hash)
        if signin_hash:
            for generation, bound in list(self.generation_signins.items()):
                if bound == signin_hash:
                    self.mark_fenced(generation, "signed_out")

    def _mark_matching(self, principal, app=None):
        for generation, identity in list(self.generation_index.items()):
            if identity[0] == principal and (app is None or identity[2] == app):
                self.mark_fenced(generation, "suspended")

    def _require(self, viewer, session_hash, app, generation, rate=False):
        """Call under the common transaction gate, including after every await at Ask admission."""
        g = self._lookup(generation)
        if not g or g["principal"] != viewer.principal or g["app_id"] != app or g["session_hash"] != session_hash:
            raise self.error("not_available", 404)
        if g["status"] != "active" or generation in self.fenced:
            raise self.error("generation_fenced")
        reason = None
        try:
            self._person(viewer, session_hash)
            release, _ = self._release(app)
            if g["revoked"] or g["consent_epoch"] != g["current_epoch"] or release["digest"] != g["digest"]:
                reason = "consent_required"
            elif g.get("first_session_only") and not self.hive.app_links.first_session_current(g["consent_id"], viewer, session_hash):
                reason = "consent_required"
            elif self.deadlines.get(generation, 0) <= self.clock():
                reason = "lease_lapsed"
        except Exception:
            self._fence(generation, "suspended")
            raise
        if reason:
            self._fence(generation, "suspended")
            raise self.error(reason)
        if rate:
            stamp = self.clock()
            tokens, last = self.rates.get(generation, (40.0, stamp))
            tokens = min(40.0, tokens + max(0.0, stamp - last) * 20)
            self.rates[generation] = (tokens, stamp)
            if tokens < 1:
                raise self.error("rate_limited")
            self.rates[generation] = (tokens - 1, stamp)
        return g

    def _lease(self, g, initial=None):
        operations = self.hive.db.all("SELECT operation_id FROM app_ask_turns WHERE consent_id = ? AND origin = 'started' "
                                      "ORDER BY rowid DESC LIMIT ?", (g["consent_id"], SUBSCRIPTIONS))
        return {"generation_id": g["id"], "consent_id": g["consent_id"], "consent_epoch": g["consent_epoch"],
                "release_digest": g["digest"], "lease_ms": 15000, "renew_after_ms": 5000,
                "resumable_operations": [r["operation_id"] for r in operations], "initial_operation_id": initial}

    def frame(self, viewer, session_hash, app, data):
        try:
            return self._frame(viewer, session_hash, app, data)
        finally:
            self.drain_fences()

    def _frame(self, viewer, session_hash, app, data, *, entry_consent=None):
        if not closed(data, {"release_digest", "frame_slot_id"}, {"initial_operation_id"}) \
                or not isinstance(data["frame_slot_id"], str) or not IDENTIFIER.fullmatch(data["frame_slot_id"]):
            raise self.error("invalid", 400)
        initial = data.get("initial_operation_id")
        gate = self.turn_gate(viewer.principal, initial) if isinstance(initial, str) else contextlib.nullcontext()
        with gate, self.hive.db.transaction():
            session = self._person(viewer, session_hash)
            release, _ = self._release(app)
            if data["release_digest"] != release["digest"]:
                raise self.error("card_changed")
            consent = self.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? AND revoked = 0 ORDER BY epoch DESC, created_at DESC, id DESC LIMIT 1",
                                       (viewer.principal, app, release["digest"]))
            if not consent:
                raise self.error("consent_required")
            if entry_consent is not None and consent["id"] != entry_consent:
                raise self.error("consent_required")
            if consent.get("first_session_only"):
                if entry_consent != consent["id"] or consent.get("first_session_used"):
                    raise self.error("consent_required")
                self.hive.db.execute("UPDATE app_ask_consents SET first_session_used = 1 WHERE id = ? AND first_session_used = 0", (consent["id"],))
            if self.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations g JOIN app_ask_consents c ON c.id = g.consent_id "
                                "WHERE c.principal = ? AND g.created_at >= ?", (viewer.principal, now()[:10]))["n"] >= 128:
                raise self.error("rate_limited")
            generation = str(uuid.uuid4())
            initial = data.get("initial_operation_id")
            pref = self.hive.db.one("SELECT swarm_id FROM ask_prefs WHERE principal = ?", (viewer.principal,)) or {}
            swarm = pref.get("swarm_id")
            placed = self._person_context(viewer.principal, app)
            if initial is not None:
                if not isinstance(initial, str) or consent["initial_used"]:
                    raise self.error("not_available")
                t = self.hive.ask._own(viewer, initial)
                if t["deleted_at"] or self.hive.db.one("SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (t["id"],)):
                    raise self.error("not_available")
                swarm = t["swarm_id"]
            if placed is not None:
                swarm = placed   # P14: a person app's frame is its person's validated context, never a preference
            # Validate before fencing; a refused forged initial selector cannot destroy a current presentation.
            for old in self.hive.db.all("SELECT id FROM app_ask_generations WHERE consent_id = ? AND status = 'active'", (consent["id"],)):
                self._fence(old["id"], "replaced")
            self.hive.db.insert("app_ask_generations", {"id": generation, "consent_id": consent["id"],
                "consent_epoch": consent["epoch"], "session_hash": session_hash, "slot": data["frame_slot_id"],
                "status": "active", "swarm_id": swarm, "focus": initial, "created_at": now()})
            self.deadlines[generation] = self.clock() + LEASE
            self.generation_index[generation] = (viewer.principal, session_hash, app)
            self.generation_signins[generation] = session.get("signin_hash")
            if initial is not None:
                self.hive.db.insert("app_ask_turns", {"turn_id": t["id"], "operation_id": initial,
                    "consent_id": consent["id"], "origin": "initial", "initial_generation": generation})
                self.hive.db.execute("UPDATE app_ask_consents SET initial_used = 1 WHERE id = ?", (consent["id"],))
                self._set_owner(t, "frame", generation)
            g = self._require(viewer, session_hash, app, generation)
            return self._lease(g, initial)

    def presence(self, viewer, session_hash, app, generation):
        try:
            with self.hive.db.transaction():
                g = self._require(viewer, session_hash, app, generation, rate=True)
                self.deadlines[generation] = self.clock() + LEASE
                return self._lease(g)
        finally:
            self.drain_fences()

    def close(self, viewer, session_hash, app, generation):
        if self.generation_index.get(generation) == (viewer.principal, session_hash, app):
            self.mark_fenced(generation, "left")
        with self.hive.db.transaction():
            g = self._lookup(generation)
            # Even a lapsed generation can be closed; ownership, never a new lease.
            self._person(viewer, session_hash)
            if not g or g["principal"] != viewer.principal or g["session_hash"] != session_hash or g["app_id"] != app:
                raise self.error("not_available", 404)
            self._fence(generation, "left")
        self.drain_fences()
        return {"fenced": True}

    def _fence(self, generation, status):
        """Fence first, before presentation teardown. No yield or lock acquisition can revive it."""
        self.mark_fenced(generation, status)
        self.hive.db.execute("UPDATE app_ask_generations SET status = ? WHERE id = ?", (status, generation))
        self.deadlines.pop(generation, None)
        self.rates.pop(generation, None)
        self.subscriptions = {k: v for k, v in self.subscriptions.items() if v["generation"] != generation}
        self.live_frames = {k: v for k, v in self.live_frames.items() if k[0] != generation}
        self.pending_teardown.add(generation)

    def drain_fences(self):
        # Called only after releasing DB AND turn gates; never wait on a second turn while holding the first.
        for generation in list(self.pending_teardown):
            self._teardown(generation)
            self.pending_teardown.discard(generation)
            self.fenced.pop(generation, None)
            self.generation_index.pop(generation, None)
            self.generation_signins.pop(generation, None)

    def _teardown(self, generation):
        with self.hive.db.transaction():
            self.hive.db.execute("UPDATE app_ask_generations SET status = ? WHERE id = ? AND status = 'active'",
                                 (self.fenced.get(generation, "suspended"), generation))
        rows = self.hive.db.all("SELECT t.* FROM ask_turns t JOIN app_ask_presentations p ON p.turn_id = t.id "
                                "WHERE p.generation_id = ? AND p.owner = 'frame'", (generation,))
        for row in rows:
            with self.turn_gate(row["principal"], row["operation_id"]), self.hive.db.transaction():
                p = self._presentation(row)
                if p["owner"] == "frame" and p["generation_id"] == generation:
                    self._set_owner(row, "host", None, active=False)

    def fence_person(self, principal):
        links = getattr(self.hive, "app_links", None)
        if links is not None:
            links.fence_person(principal)
        self._mark_matching(principal)
        with self.hive.db.transaction():
            for row in self.hive.db.all("SELECT g.id FROM app_ask_generations g JOIN app_ask_consents c ON c.id = g.consent_id "
                                        "WHERE c.principal = ? AND g.status = 'active'", (principal,)):
                self._fence(row["id"], "signed_out")
        self.drain_fences()

    def sweep(self):
        """Proactive, even without a reconcile supervisor or another iframe request."""
        from .visibility import Viewer
        # Cleanup a prior refusal whose enclosing transaction rolled back: the independent fence never rolled back.
        for generation in list(self.fenced):
            self._teardown(generation)
        with self.hive.db.transaction():
            for row in self.hive.db.all("SELECT id FROM app_ask_generations WHERE status = 'active'"):
                g = self._lookup(row["id"])
                # _require already fences on every reason. The sweep is fail-closed and logs no personal payloads.
                with contextlib.suppress(Exception):
                    self._require(Viewer(g["principal"], False), g["session_hash"], g["app_id"], g["id"])
        self.drain_fences()

    def _presentation(self, t):
        p = self.hive.db.one("SELECT * FROM app_ask_presentations WHERE turn_id = ?", (t["id"],))
        if p is None:
            self.hive.db.insert("app_ask_presentations", {"turn_id": t["id"], "owner": "host", "generation_id": None,
                                                        "host_active": 1, "epoch": 0})
            p = self.hive.db.one("SELECT * FROM app_ask_presentations WHERE turn_id = ?", (t["id"],))
        return {"operation_id": t["operation_id"], "turn_id": t["id"], "owner": p["owner"],
                "generation_id": p["generation_id"], "host_active": bool(p["host_active"]), "epoch": p["epoch"]}

    def _expire_acts(self, turn_id):
        conductor = self.hive.ask.conductor
        if conductor is not None:
            conductor.expire_presentation(turn_id)

    def _set_owner(self, t, owner, generation, active=False):
        previous = self._presentation(t)
        if (previous["owner"], previous["generation_id"], previous["host_active"]) == (owner, generation, active):
            return previous
        self._expire_acts(t["id"])
        self.hive.db.execute("UPDATE app_ask_presentations SET owner = ?, generation_id = ?, host_active = ?, epoch = epoch + 1 "
                             "WHERE turn_id = ?", (owner, generation, int(active), t["id"]))
        # An old logical subscription cannot resurrect after an ownership round trip.
        self.subscriptions = {k: v for k, v in self.subscriptions.items() if v["turn_id"] != t["id"]}
        self.live_frames = {k: v for k, v in self.live_frames.items() if k[1] != t["id"]}
        return self._presentation(t)

    def presentation(self, viewer, operation, session_hash=None):
        with self.turn_gate(viewer.principal, operation), self.hive.db.transaction():
            if session_hash is not None:
                self._person(viewer, session_hash)
            t = self.hive.ask._own(viewer, operation)
            p = self._presentation(t)
            if p["owner"] == "frame":
                g = self._lookup(p["generation_id"])
                if g:
                    with contextlib.suppress(Exception):
                        self._require(viewer, g["session_hash"], g["app_id"], g["id"])
                if p["generation_id"] in self.fenced:
                    self._set_owner(t, "host", None, active=False)
            return self._presentation(t)

    def host_presentation(self, viewer, session_hash, operation, data):
        if not closed(data, {"action", "expected_epoch"}, {"generation_id"}) or not integer(data["expected_epoch"]) \
                or data["action"] not in ("claim", "handover") or (data["action"] == "claim" and "generation_id" in data) \
                or (data["action"] == "handover" and not isinstance(data.get("generation_id"), str)):
            raise self.error("invalid", 400)
        with self.turn_gate(viewer.principal, operation), self.hive.db.transaction():
            self._person(viewer, session_hash)
            t = self.hive.ask._own(viewer, operation)
            p = self._presentation(t)
            if p["epoch"] != data["expected_epoch"]:
                raise self.error("handover_required")
            if data["action"] == "claim":
                return self._set_owner(t, "host", None, active=True)
            g = self._lookup(data["generation_id"])
            if not g:
                raise self.error("not_available")
            self._require(viewer, session_hash, g["app_id"], g["id"])
            self._member(g, operation)
            return self._set_owner(t, "frame", g["id"])

    def _member(self, g, operation, started=False):
        t = self.hive.ask._own(type("Person", (), {"principal": g["principal"]})(), operation)
        b = self.hive.db.one("SELECT * FROM app_ask_turns WHERE turn_id = ? AND consent_id = ?", (t["id"], g["consent_id"]))
        if not b or t["deleted_at"] or (b["origin"] != "started" and (started or b["initial_generation"] != g["id"])):
            raise self.error("not_available", 404)
        return t

    def _owned(self, g, operation):
        t = self._member(g, operation)
        p = self._presentation(t)
        if p["owner"] != "frame" or p["generation_id"] != g["id"]:
            raise self.error("handover_required")
        return t, p

    def _resume(self, g, operation, expected=None):
        t = self._member(g, operation, started=True)
        p = self._presentation(t)
        if expected is not None and p["epoch"] != expected:
            raise self.error("handover_required")
        if p["owner"] == "frame" and p["generation_id"] == g["id"]:
            return p
        if p["owner"] != "host" or p["host_active"]:
            raise self.error("handover_required")
        # This is the commit gate, under the turn mutex. Leave can independently fence while the mutex is held.
        self._require(type("Person", (), {"principal": g["principal"]})(), g["session_hash"], g["app_id"], g["id"])
        result = self._set_owner(t, "frame", g["id"])
        self.hive.db.execute("UPDATE app_ask_generations SET focus = ? WHERE id = ?", (operation, g["id"]))
        self._require(type("Person", (), {"principal": g["principal"]})(), g["session_hash"], g["app_id"], g["id"])
        return result

    def _bounded(self, data):
        try:
            size = len(encoded(data))
        except (ValueError, TypeError, RecursionError, UnicodeError):
            raise self.error("invalid", 400) from None
        if size > MAX_BYTES:
            raise self.error("too_large", 413)

    async def op(self, viewer, session_hash, app, generation, data):
        try:
            answer = await self._op(viewer, session_hash, app, generation, data)
            with self.hive.db.transaction():
                g = self._require(viewer, session_hash, app, generation)
                if data["op"] == "poll":
                    sub = self.subscriptions.get(data["subscription_id"])
                    if not sub or sub["generation"] != generation:
                        raise self.error("handover_required")
                    _, p = self._owned(g, sub["operation"])
                    if p["epoch"] != sub["epoch"]:
                        raise self.error("handover_required")
                self._bounded(answer)
            return answer
        finally:
            self.drain_fences()

    async def _op(self, viewer, session_hash, app, generation, data):
        self._bounded(data)
        if not isinstance(data, dict) or not isinstance(data.get("op"), str) or data["op"] not in OPS \
                or not closed(data, *OPS[data["op"]]):
            raise self.error("invalid", 400)
        for key in ("operation_id", "act_id", "subscription_id"):
            if key in data and (not isinstance(data[key], str) or not IDENTIFIER.fullmatch(data[key])):
                raise self.error("invalid", 400)
        if data["op"] == "send":
            return await self.send(viewer, session_hash, app, generation, data)
        if data["op"] in ("notices", "spend"):
            return self._read_op(viewer, session_hash, app, generation, data)
        operation = data.get("operation_id")
        if data["op"] == "poll":
            operation = self.subscriptions.get(str(data["subscription_id"]), {}).get("operation")
        gate = self.turn_gate(viewer.principal, operation) if isinstance(operation, str) else contextlib.nullcontext()
        with gate, self.hive.db.transaction():
            g = self._require(viewer, session_hash, app, generation, rate=True)
            if data["op"] == "resume":
                if not integer(data["expected_epoch"]):
                    raise self.error("invalid", 400)
                return self._resume(g, data["operation_id"], data["expected_epoch"])
            if data["op"] == "subscribe":
                try:
                    t, p = self._owned(g, data["operation_id"])
                except Exception as exc:
                    if getattr(exc, "code", None) != "handover_required":
                        raise
                    p = self._resume(g, data["operation_id"])
                    t = self._member(g, data["operation_id"])
                for key, sub in self.subscriptions.items():
                    if sub["generation"] == generation and sub["turn_id"] == t["id"]:
                        return {"subscription_id": key, "operation_id": t["operation_id"],
                                "cursor": dict(sub["cursor"]), "presentation": p}
                if sum(s["generation"] == generation for s in self.subscriptions.values()) >= SUBSCRIPTIONS:
                    raise self.error("rate_limited")
                sid = str(uuid.uuid4())
                # Personal historical bodies were deliberately never retained. Begin at this generation's live boundary.
                cached = [key[2] for key in self.live_frames if key[:2] == (generation, t["id"])]
                after = (min(cached) - 1 if cached else t["next_seq"] - 1) if t["personal"] else 0
                cursor = {"after_seq": after, "offset": 0}
                self.subscriptions[sid] = {"generation": generation, "turn_id": t["id"], "operation": t["operation_id"],
                                           "epoch": p["epoch"], "floor_after": after, "cursor": cursor}
                return {"subscription_id": sid, "operation_id": t["operation_id"], "cursor": cursor, "presentation": p}
            if data["op"] in ("poll", "unsubscribe"):
                sub = self.subscriptions.get(str(data["subscription_id"]))
                if not sub or sub["generation"] != generation:
                    raise self.error("not_available", 404)
                if data["op"] == "unsubscribe":
                    self.subscriptions.pop(data["subscription_id"], None)
                    self.live_frames = {k: v for k, v in self.live_frames.items() if k[:2] != (generation, sub["turn_id"])}
                    return {"unsubscribed": True}
                t, p = self._owned(g, sub["operation"])
                if p["epoch"] != sub["epoch"]:
                    raise self.error("handover_required")
                return self._poll(g, sub, data["subscription_id"], data["cursor"], t)
            t, p = self._owned(g, data["operation_id"])
            if data["op"] == "yield":
                return self._set_owner(t, "host", None, active=False)
            if data["op"] == "act-claim":
                return self.claim_act(viewer, t, data["act_id"], data["expected_epoch"], generation)
            if data["op"] == "act-result":
                conductor = self.hive.ask.conductor
                if conductor is None:
                    raise self.error("not_available")
                return conductor.result(viewer, t, data["act_id"], data["result"], generation=generation)
        raise self.error("invalid", 400)

    def _read_op(self, viewer, session_hash, app, generation, data):
        """G2/G4: admitted exactly like every other frame op (current consent, lease, rate); answers only for the
        generation's own person and this app's own context."""
        if data["op"] == "notices" and not integer(data.get("after", 0)):
            raise self.error("invalid", 400)
        if data["op"] == "spend" and (type(data.get("days", 7)) is not int or not 1 <= data.get("days", 7) <= 31):
            raise self.error("invalid", 400)
        with self.hive.db.transaction():
            self._require(viewer, session_hash, app, generation, rate=True)
        if data["op"] == "notices":
            return self.hive.notices.frame_read(viewer.principal, app, data.get("after", 0))
        return self.hive.me_spend.frame_read(viewer.principal, app, data.get("days", 7))

    def _poll(self, g, sub, sid, cursor, t):
        if not closed(cursor, {"after_seq", "offset"}) or not all(integer(cursor[k]) for k in cursor) \
                or cursor["offset"] >= EVENT_BYTES or cursor["offset"] % CHUNK_BYTES:
            raise self.error("invalid", 400)
        if cursor["after_seq"] < sub["floor_after"]:
            if t["personal"]:
                self._fence(g["id"], "event_unavailable")
                raise self.error("event_unavailable")
            raise self.error("invalid", 400)
        if cursor["after_seq"] >= t["next_seq"]:
            raise self.error("invalid", 400)
        # Advancing after_seq is the parent forwarding a completed frame ACK. Never resurrect freed private bytes.
        sub["floor_after"] = cursor["after_seq"]
        sub["cursor"] = dict(cursor)
        self.live_frames = {k: v for k, v in self.live_frames.items()
                            if not (k[:2] == (g["id"], t["id"]) and k[2] <= cursor["after_seq"])}
        from .ask import OPEN   # gateway r1b: the one open-state constant (an app's turn is never a browser turn)
        terminal = t["state"] not in OPEN
        events = self.hive.ask.events(t["id"], cursor["after_seq"], 1)["events"]
        if not events:
            if cursor["offset"]:
                raise self.error("invalid", 400)
            return {"kind": "idle", "subscription_id": sid, "cursor": cursor, "terminal": terminal}
        event = dict(events[0])
        if t["personal"]:
            live = self.live_frames.get((g["id"], t["id"], event["seq"]))
            if live is None:
                self._fence(g["id"], "event_unavailable")
                raise self.error("event_unavailable")
            event = json.loads(live)
        event.pop("principal", None)
        # Replayed frame acts keep their ORIGINAL recipient; never relabel them on handback.
        if event.get("phase") == "act":
            recipient = event.get("recipient")
            if not isinstance(recipient, dict) or recipient.get("kind") != "frame" \
                    or recipient.get("generation_id") != g["id"] or recipient.get("owner_epoch") != sub["epoch"]:
                event = {k: v for k, v in event.items() if k != "act"}
                event["unavailable"] = True
        raw = encoded(event)
        if len(raw) > EVENT_BYTES:
            self._fence(g["id"], "slow_consumer")
            raise self.error("event_too_large")
        offset = cursor["offset"]
        if offset >= len(raw):
            raise self.error("invalid", 400)
        chunk = raw[offset:offset + CHUNK_BYTES]
        complete = offset + len(chunk) == len(raw)
        answer = {"kind": "chunk", "subscription_id": sid, "operation_id": t["operation_id"],
                "seq": event["seq"], "offset": offset, "total_bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "data_base64": base64.b64encode(chunk).decode("ascii"), "complete": complete, "terminal": terminal,
                "next_cursor": {"after_seq": event["seq"] if complete else cursor["after_seq"], "offset": 0 if complete else offset + len(chunk)}}
        from .visibility import Viewer
        self._require(Viewer(g["principal"], False), g["session_hash"], g["app_id"], g["id"])
        return answer

    def capture_live(self, frame):
        """The existing Ask live projection, personal bodies only. No new transcript or durable private fields."""
        with self.hive.db.transaction():
            t = self.hive.ask._row(frame["turn_id"])
            if not t or not t["personal"] or not self.hive.db.one("SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (t["id"],)):
                return
            p = self._presentation(t)
            if p["owner"] != "frame":
                return
            g = self._lookup(p["generation_id"])
            if not g:
                return
            from .visibility import Viewer
            try:
                self._require(Viewer(g["principal"], False), g["session_hash"], g["app_id"], g["id"])
            except Exception:
                return
            projected = {k: v for k, v in frame.items() if k != "principal"}
            raw = encoded(projected)
            key = (g["id"], t["id"], frame["seq"])
            held = {k: v for k, v in self.live_frames.items() if k[0] == g["id"] and k != key}
            if len(raw) > EVENT_BYTES or len(held) >= OUTBOX_EVENTS or sum(map(len, held.values())) + len(raw) > OUTBOX_BYTES:
                self._fence(g["id"], "slow_consumer")
                return
            # Independent leave may have fenced while the projection was encoded.
            try:
                self._require(Viewer(g["principal"], False), g["session_hash"], g["app_id"], g["id"])
            except Exception:
                return
            self.live_frames[key] = raw

    def _context(self, g, supplied):
        from .ask import forbidden
        def inspect(value, depth=0):
            if depth > 12:
                raise self.error("invalid", 400)
            if isinstance(value, dict):
                if forbidden(value) or any(k in value for k in ("session", "session_hash", "generation_id", "consent_id", "owner_epoch")):
                    raise self.error("invalid", 400)
                for child in value.values():
                    inspect(child, depth + 1)
            elif isinstance(value, list):
                for child in value:
                    inspect(child, depth + 1)
        inspect(supplied)
        self.hive.ask._check_context(supplied)
        if supplied and supplied.get("private"):
            return {"private": True}
        # The app cannot choose a target mind/swarm or masquerade as another app.
        context = {k: v for k, v in (supplied or {}).items() if k not in ("program", "swarm_id", "mind", "selection")}
        context["program"] = g["app_id"]
        if g["swarm_id"]:
            context["swarm_id"] = g["swarm_id"]
        return context

    def _person_context(self, principal, app):
        """P14: None for a swarm app; a person app's validated context, else not available (no other swarm stands in)."""
        apps = getattr(self.hive, "person_apps", None)
        if apps is None or not apps.is_person_app(app):
            return None
        try:
            return apps.frame_swarm(principal, app)
        except Exception:   # noqa: BLE001
            raise self.error("not_available") from None

    def before_admit(self, binding):
        """Host-only argument, never accepted from Ask JSON. Runs inside Ask's final admission transaction."""
        from .visibility import Viewer
        g = self._require(Viewer(binding["principal"], False), binding["session"], binding["app"], binding["generation"])
        if g["consent_id"] != binding["consent"] or g["consent_epoch"] != binding["consent_epoch"]:
            raise self.error("consent_required")
        apps = getattr(self.hive, "person_apps", None)
        if apps is not None and apps.is_person_app(binding["app"]):
            # P14 own key only: the validated context and this person's own key and total, before any message or spend
            try:
                apps.require_paid(binding["principal"], binding["app"], g["swarm_id"])
            except Exception as exc:   # noqa: BLE001
                raise self.error("key_required" if getattr(exc, "code", None) == "own_key_needed" else "not_available") from None
        if binding.get("source"):
            _, p = self._owned(g, binding["source"])
            if p["epoch"] != binding["epoch"]:
                raise self.error("handover_required")
        return g

    def admitted(self, binding, turn):
        g = self.before_admit(binding)
        old = self.hive.db.one("SELECT * FROM app_ask_turns WHERE turn_id = ?", (turn["id"],))
        if old and old["consent_id"] != g["consent_id"]:
            raise self.error("not_available")
        if not old:
            self.hive.db.insert("app_ask_turns", {"turn_id": turn["id"], "operation_id": turn["operation_id"],
                "consent_id": g["consent_id"], "origin": "started", "initial_generation": None})
            self._set_owner(turn, "frame", g["id"])
        self.hive.db.execute("UPDATE app_ask_generations SET focus = ? WHERE id = ?", (turn["operation_id"], g["id"]))
        self.before_admit(binding)

    async def send(self, viewer, session_hash, app, generation, data):
        if not isinstance(data["op_id"], str) or not IDENTIFIER.fullmatch(data["op_id"]) \
                or not isinstance(data["text"], str) or not data["text"].strip():
            raise self.error("invalid", 400)
        with self.hive.db.transaction():
            g = self._require(viewer, session_hash, app, generation, rate=True)
            scoped = "p1:" + hashlib.sha256(encoded([g["consent_id"], data["op_id"]])).hexdigest()
            context = self._context(g, data.get("context"))
            binding = {"principal": viewer.principal, "session": session_hash, "app": app, "generation": generation,
                       "consent": g["consent_id"], "consent_epoch": g["consent_epoch"], "source": None, "epoch": None,
                       "request_digest": hashlib.sha256(encoded([g["consent_id"], data])).hexdigest()}
            # Recover the original existing Ask ID before looking at a possibly changed focus.
            prior = self.hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?", (viewer.principal, scoped))
            steer = self.hive.db.one("SELECT * FROM ask_steers WHERE principal = ? AND steer_id = ?", (viewer.principal, scoped))
            if steer and steer["outcome"] == "new_turn":
                fresh = self.hive.db.one("SELECT * FROM ask_turns WHERE principal = ? AND operation_id = ?",
                                         (viewer.principal, steer["new_operation_id"]))
                if fresh:
                    if steer["body_digest"] != binding["request_digest"]:
                        raise self.error("operation_conflict")
                    _, p = self._owned(g, fresh["operation_id"])
                    return {"operation_id": fresh["operation_id"], "turn_id": fresh["id"], "new_turn": False, "presentation": p}
            source = None
            if steer:
                source = self.hive.ask._row(steer["turn_id"])
            elif not prior and g["focus"]:
                source, p = self._owned(g, g["focus"])
            if source:
                _, p = self._owned(g, source["operation_id"])
                binding.update(source=source["operation_id"], epoch=p["epoch"])
                # at_seq is part of the existing durable steer body; retries use its original value.
                at_seq = steer["at_seq"] if steer else max(0, source["next_seq"] - 1)
                body = {"steer_id": scoped, "text": data["text"], "at_seq": at_seq, "via": "typed"}
            else:
                body = {"operation_id": scoped, "text": data["text"], "context": context, "via": "typed"}
        if source:
            out = await self.hive.ask.steer(viewer, source["operation_id"], body, app_binding=binding)
        else:
            out = await self.hive.ask.create(viewer, body, app_binding=binding)
        with self.hive.db.transaction():
            g = self._require(viewer, session_hash, app, generation)
            t = self._member(g, out["operation_id"])
            _, presentation = self._owned(g, out["operation_id"])
            return {"operation_id": t["operation_id"], "turn_id": t["id"],
                    "new_turn": out.get("new_turn", source is None and prior is None), "presentation": presentation}

    def recipient(self, turn):
        """Stamp BEFORE emitting an act. Every new host act is explicit too."""
        p = self._presentation(turn)
        if p["owner"] == "frame":
            g = self._lookup(p["generation_id"])
            if g:
                from .visibility import Viewer
                with contextlib.suppress(Exception):
                    self._require(Viewer(g["principal"], False), g["session_hash"], g["app_id"], g["id"])
            if p["generation_id"] in self.fenced:
                self._set_owner(turn, "host", None, active=False)
            p = self._presentation(turn)
        return {"kind": p["owner"], "generation_id": p["generation_id"], "owner_epoch": p["epoch"]}

    def issue_act(self, turn, act_id):
        recipient = self.recipient(turn)
        self.act_recipients[(turn["id"], act_id)] = recipient
        return recipient

    def act_gate(self, viewer, turn, act_id, generation=None, result=False):
        if turn["principal"] != viewer.principal:
            raise self.error("not_available", 404)
        issued = self.act_recipients.get((turn["id"], act_id))
        # New acts are always stamped. Legacy/missing in-memory acts cannot be redeemed after restart.
        if issued is None:
            raise self.error("not_available", 404)
        current = self.recipient(turn)
        if issued != current or issued["generation_id"] != generation or issued["kind"] != ("frame" if generation else "host"):
            raise self.error("act_expired")
        managed = self.hive.db.one("SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (turn["id"],))
        if result and (managed or generation is not None) and (turn["id"], act_id) not in self.claimed:
            raise self.error("act_expired")
        return issued

    def claim_act(self, viewer, turn, act_id, epoch, generation=None, *, session_hash=None):
        if not integer(epoch):
            raise self.error("invalid", 400)
        with self.turn_gate(viewer.principal, turn["operation_id"]), self.hive.db.transaction():
            if session_hash is not None:
                self._person(viewer, session_hash)
            recipient = self.act_gate(viewer, turn, act_id, generation)
            conductor = self.hive.ask.conductor
            st = conductor.turns.get(turn["id"]) if conductor else None
            key = (turn["id"], act_id)
            if not st or st.closing or act_id not in st.pending or act_id in st.recorded or st.pending[act_id].done():
                raise self.error("act_expired")
            if recipient["owner_epoch"] != epoch:
                raise self.error("act_expired")
            if key in self.claimed:
                raise self.error("act_result_recorded")
            self.claimed.add(key)
            return {"act_id": act_id, "claimed": True}

    def forget_acts(self, turn_id):
        self.act_recipients = {k: v for k, v in self.act_recipients.items() if k[0] != turn_id}
        self.claimed = {k for k in self.claimed if k[0] != turn_id}
