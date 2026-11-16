"""App platform P2: a person-owned swarm made from an app's reviewed template.

An app (program) may declare swarm templates in plugin.json:
    "swarm_templates": {"<template id>": {"minds": [{"slot", "name", "persona"?, "model", "budget_usd"?}, ...],
                                          "rules": [{"skill", "mode": "deny" | "ask"}, ...]}}
pinned by digest with the app's release. A template can never carry an allow.

With the person's consent (a host card listing the minds, their model, the person's own key, their own-key monthly total
and the template digest), ctx.ensure_person_swarm(template_id) makes or reuses that person's private swarm and minds:
asleep, owned by the person, key-locked to the person's own key (P3a), bound by (principal, app, template, slot).
Consent is bound to (principal, app, template, digest, key, monthly total); any change needs new consent before any
create or repair. A numeric total-only change leaves existing helpers authorised; each paid call still checks the
current total. Any non-numeric authority change, including template/key changes and withdrawal, revokes that runtime
authority. Provisioning and withdrawal are
serialised under one lock per (principal, app); withdrawal
sets a tombstone that ensure and crash-repair both honour, and puts the minds to sleep (deleting them is the person's
separate choice). A template's rules are a ceiling the minds' other rules and durable approval answers can never lower
(ceiling(), read by Policy).
"""

from __future__ import annotations

import contextlib
import datetime
import hashlib
import json
import logging
import threading

from .db import now, parse_stamp

log = logging.getLogger("hive")

HOST_ACTOR = "hive:person-swarm"
MAX_MINDS = 8
SPEND_NOTE = ("Your monthly total is checked before each request. A single request can cost a little more than expected, "
              "so the total can be passed by up to one request.")
MAX_RULES = 64
TEMPLATE_MODES = ("deny", "ask")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS app_person_consents (
  principal TEXT NOT NULL, program_id TEXT NOT NULL, template_id TEXT NOT NULL, template_digest TEXT NOT NULL,
  key_id TEXT NOT NULL, month_usd REAL NOT NULL, granted_at TEXT NOT NULL, withdrawn_at TEXT,
  PRIMARY KEY (principal, program_id, template_id))""",
    """CREATE TABLE IF NOT EXISTS app_person_swarms (
  principal TEXT NOT NULL, program_id TEXT NOT NULL, template_id TEXT NOT NULL, swarm_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (principal, program_id, template_id))""",
    """CREATE TABLE IF NOT EXISTS app_person_minds (
  principal TEXT NOT NULL, program_id TEXT NOT NULL, template_id TEXT NOT NULL, slot TEXT NOT NULL,
  agent_id TEXT NOT NULL, template_digest TEXT NOT NULL, finished INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY (principal, program_id, template_id, slot))""",
    "CREATE INDEX IF NOT EXISTS app_person_minds_agent ON app_person_minds (agent_id)",
    """CREATE TABLE IF NOT EXISTS app_template_rules (
  agent_id TEXT NOT NULL, skill TEXT NOT NULL, mode TEXT NOT NULL, program_id TEXT NOT NULL,
  template_digest TEXT NOT NULL, PRIMARY KEY (agent_id, skill))""",
]


def _glob(pattern, skill):
    from .policy import _matches
    return _matches(pattern, skill)


def parse_templates(value):
    """plugin.json swarm_templates -> {id: template with its digest}. Raises ValueError (the app does not load)."""
    if value in (None, {}):
        return {}
    if not isinstance(value, dict):
        raise ValueError("swarm_templates must be an object")
    out = {}
    for tid, t in value.items():
        if not isinstance(tid, str) or not tid.replace("-", "").replace("_", "").isalnum() or len(tid) > 40:
            raise ValueError(f"bad swarm template id {tid!r}")
        if not isinstance(t, dict):
            raise ValueError(f"swarm template {tid} must be an object")
        minds, rules = t.get("minds") or [], t.get("rules") or []
        if not isinstance(minds, list) or not 1 <= len(minds) <= MAX_MINDS:
            raise ValueError(f"swarm template {tid}: 1 to {MAX_MINDS} minds")
        slots, clean_minds = set(), []
        for m in minds:
            if not isinstance(m, dict) or not str(m.get("slot", "")).strip() or not str(m.get("name", "")).strip():
                raise ValueError(f"swarm template {tid}: every mind needs a slot and a name")
            slot = str(m["slot"]).strip()
            if slot in slots:
                raise ValueError(f"swarm template {tid}: slot {slot} twice")
            slots.add(slot)
            model = str(m.get("model", "")).strip()
            if "/" not in model:
                raise ValueError(f"swarm template {tid}: {slot} needs a provider/model")
            budget = m.get("budget_usd", 0)
            if not isinstance(budget, (int, float)) or budget < 0:
                raise ValueError(f"swarm template {tid}: {slot} budget_usd must be zero or more")
            clean_minds.append({"slot": slot, "name": str(m["name"]).strip()[:60], "persona": str(m.get("persona", ""))[:8000],
                                "model": model, "budget_usd": float(budget)})
        if not isinstance(rules, list) or len(rules) > MAX_RULES:
            raise ValueError(f"swarm template {tid}: at most {MAX_RULES} rules")
        clean_rules, skills = [], set()
        for r in rules:
            if not isinstance(r, dict) or not str(r.get("skill", "")).strip():
                raise ValueError(f"swarm template {tid}: every rule needs a skill")
            if r.get("mode") not in TEMPLATE_MODES:
                raise ValueError(f"swarm template {tid}: rules may only deny or ask (never allow)")
            skill = str(r["skill"]).strip()
            if skill in skills:
                raise ValueError(f"swarm template {tid}: duplicate skill pattern {skill!r}")
            skills.add(skill)
            clean_rules.append({"skill": skill, "mode": r["mode"]})
        body = {"minds": clean_minds, "rules": clean_rules}
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        out[tid] = {**body, "digest": digest}
    return out


def _strongest_rules(rules):
    """Defensive storage boundary if a caller bypasses the manifest parser."""
    strongest = {}
    for rule in rules:
        skill, mode = str(rule.get("skill", "")).strip(), rule.get("mode")
        if not skill or mode not in TEMPLATE_MODES:
            raise ValueError("template storage rules need a skill and deny/ask mode")
        if skill not in strongest or mode == "deny":
            strongest[skill] = mode
    return [{"skill": skill, "mode": mode} for skill, mode in strongest.items()]


class PersonSwarms:
    def __init__(self, hive):
        self.hive = hive
        for statement in SCHEMA:
            hive.db.execute(statement)
        self._locks, self._program_locks, self._guard = {}, {}, threading.Lock()
        self._reading, self._quiesced = threading.local(), set()
        for row in hive.db.all("SELECT DISTINCT program_id FROM app_person_consents"):
            if row["program_id"] not in hive.programs.programs:
                hive.db.execute("UPDATE app_person_consents SET withdrawn_at = ? WHERE program_id = ?",
                                 (now(), row["program_id"]))
                hive.db.execute("DELETE FROM app_template_rules WHERE program_id = ?", (row["program_id"],))

    def _err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    def _lock(self, principal, program_id, template_id=None):
        with self._guard:
            return self._locks.setdefault((principal, program_id), threading.RLock())

    def _program_lock(self, program_id):
        with self._guard:
            return self._program_locks.setdefault(program_id, threading.RLock())

    def _bindings(self, program_id, principal=None):
        sql = "SELECT * FROM app_person_minds WHERE program_id = ?"
        return self.hive.db.all(sql + (" AND principal = ?" if principal else ""),
                                (program_id, principal) if principal else (program_id,))

    @contextlib.contextmanager
    def authority_change(self, program_id, uninstall=False):
        """Publish authority only after existing lifecycle transitions finish.

        Order: program -> principal/app -> sorted mind locks -> short DB transaction.
        Run/read guards take only the mind lock and raw DB/current-release reads: never
        acquire either P2 fence from inside a mind transition (ensure holds them first).
        """
        with self._program_lock(program_id), contextlib.ExitStack() as stack:
            bindings = self._bindings(program_id)
            principals = {b["principal"] for b in bindings}
            principals.update(r["principal"] for r in self.hive.db.all(
                "SELECT principal FROM app_person_consents WHERE program_id = ?", (program_id,)))
            for principal in sorted(principals):
                stack.enter_context(self._lock(principal, program_id))
            for agent_id in sorted({b["agent_id"] for b in bindings}):
                stack.enter_context(self.hive._mind_lock(agent_id))
            yield
            if uninstall:
                with self.hive.db.transaction():
                    self.hive.db.execute("UPDATE app_person_consents SET withdrawn_at = ? WHERE program_id = ?",
                                         (now(), program_id))
                    self.hive.db.execute("DELETE FROM app_template_rules WHERE program_id = ?", (program_id,))
            for binding in bindings:
                self.read_row(self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0",
                                               (binding["agent_id"],)))

    def uninstall(self, program_id):
        """Host hook: retain bindings/tombstones; remove rules, sleep, never delete a mind."""
        with self.authority_change(program_id, uninstall=True):
            pass
        return {"program": program_id, "withdrawn": True, "deleted_minds": False}

    def current(self, agent_id):
        """(binding, refusal reason), with None binding meaning genuinely unbound.

        Raw only: safe inside a mind transition or short reservation transaction.
        Missing/unknown current authority for a recorded binding never means unbound.
        """
        bindings = self.hive.db.all("SELECT * FROM app_person_minds WHERE agent_id = ?", (agent_id,))
        if not bindings:
            return None, None
        binding = bindings[0]
        if len(bindings) != 1:
            return binding, "the mind has conflicting app bindings"
        try:
            _program, template = self.template(binding["program_id"], binding["template_id"])
            consent = self._runtime_consent(binding["principal"], binding["program_id"], binding["template_id"], template)
            if consent is None or binding["template_digest"] != template["digest"]:
                return binding, "the template or its consent is no longer current"
            row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if row is None or row.get("owner") != binding["principal"]:
                return binding, "the bound mind is no longer owned by this person"
            options = json.loads(row.get("options") or "{}")
            if options.get("key_locked") is not True or options.get("key") != consent["key_id"]:
                return binding, "the bound mind needs its currently approved own key"
            if not binding["finished"]:
                return binding, "setup is incomplete"
            return binding, None
        except Exception:   # readiness, integrity, missing template or a failed authority read: closed
            return binding, "the template authority is unavailable"

    def _quiesce(self, agent_id):
        """No P2 fence and no public reads; positive stop evidence before saying asleep."""
        active = getattr(self._reading, "active", set())
        if agent_id in active:
            return
        self._reading.active = active | {agent_id}
        acquired = None
        try:
            lock_for = getattr(self.hive.supervisor, "lock", None)
            lock = lock_for(agent_id) if callable(lock_for) else self.hive._mind_lock(agent_id)
            # A read may already hold a different mind's lock. Never wait in
            # that inverse order; report pending and refuse effects until a
            # subsequent host read/reconciliation can confirm this stop.
            if not callable(getattr(lock, "acquire", None)) or not lock.acquire(blocking=False):
                self.hive.db.update("agents", agent_id, {"status": "error", "desired": "asleep",
                    "last_error": "App setup revoked; sleep pending a busy transition"})
                return
            acquired = lock
            with self.hive._mind_lock(agent_id):
                binding, reason = self.current(agent_id)
                row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
                if binding is None or reason is None or row is None:
                    return
                if reason == "setup is incomplete" and row["status"] == row["desired"] == "asleep":
                    return
                if agent_id in self._quiesced and row["status"] == row["desired"] == "asleep":
                    return
                self.hive.db.update("agents", agent_id, {"desired": "asleep", "last_error": "App setup revoked: " + reason})
                try:
                    supervisor = self.hive.supervisor
                    supervisor.stop(agent_id)
                    verify = getattr(supervisor, "verify_stopped", None)
                    if not callable(verify):
                        raise RuntimeError("stopped execution could not be verified")
                    verify(agent_id)
                except Exception as exc:
                    self.hive.db.update("agents", agent_id, {"status": "error", "desired": "asleep",
                        "last_error": "App setup revoked; stop unconfirmed (" + type(exc).__name__ + ")"})
                    return
                self.hive.db.update("agents", agent_id, {"status": "asleep", "desired": "asleep"})
                self._quiesced.add(agent_id)
                self.hive.emit_agent(agent_id)
        finally:
            if acquired is not None:
                acquired.release()
            self._reading.active = active

    def read_row(self, row):
        """Host safety on a read; never ensure, mint, repair, or serialize a stale awake row."""
        if row is None:
            return row
        binding, reason = self.current(row["id"])
        if binding is None or reason is None:
            return row
        # A reservation may read inside the DB lock. Never invert DB -> mind:
        # stop outside the outer transaction; a rollback drops the callback.
        self.hive.db.after_commit(lambda: self._quiesce(row["id"]))
        refreshed = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row["id"],))
        if refreshed is not None and refreshed["status"] not in ("asleep", "error"):
            return dict(refreshed, status="error", desired="asleep", last_error="App setup revoked; sleep pending")
        return refreshed or row

    def require_current(self, agent_id):
        binding, reason = self.current(agent_id)
        if binding is not None and reason is not None:
            row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            self.read_row(row)
            raise self._err(409, "app_swarm_revoked", reason)
        if binding is not None:
            self._quiesced.discard(agent_id)

    # ---- the template and what the person is shown -----------------------------------------------------------------

    def template(self, program_id, template_id):
        program = self.hive.programs._ready(program_id)
        if "person_swarm" not in program.get("capabilities", []):
            raise self._err(403, "capability_missing", f"{program_id} did not declare person_swarm")
        t = (program.get("swarm_templates") or {}).get(template_id)
        if t is None:
            raise self._err(404, "not_found", f"{program_id} has no swarm template {template_id}")
        return program, t

    def _providers(self, t):
        return sorted({m["model"].partition("/")[0] for m in t["minds"]})

    def _own_key(self, principal, providers):
        """The person's own key that every mind's provider uses: one key, so it must serve one provider."""
        if len(providers) != 1:
            return None
        keyring = getattr(self.hive, "keyring", None)
        own = sorted((r for r in ((keyring.ring.get("keys") if keyring else None) or {}).values()
                      if r.get("owner") == principal and r.get("provider") == providers[0]),
                     key=lambda r: r.get("created_at") or 0)
        return own[0]["id"] if own else None

    def _month_total(self, principal):
        row = self.hive.db.one("SELECT * FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                               "AND revoked_at IS NULL", (principal,))
        active = self.hive.ownhive._active([row]) if row else []
        return float(active[0]["month_usd"]) if active else None

    def card(self, principal, program_id, template_id):
        """What the consent card shows; exactly these values are what consent binds."""
        program, t = self.template(program_id, template_id)
        name = program.get("name") or program_id
        # The new host flow admits only pinned manifest templates. For a declared
        # pin, display data is captured from that manifest, never mutable ctx._program.
        # Legacy unpinned P2 callers retain their existing behavior; they expose no
        # verified Programs.detail host-entry metadata.
        if program_id in (getattr(self.hive.programs, "pins", None) or {}):
            verified = self.hive.programs.verified_person_swarm_template(program_id, template_id)
            if verified is None:
                raise self._err(403, "app_integrity", "This app's pinned helper template is unavailable.")
            name, t = verified["program_name"], verified["template"]
        providers = self._providers(t)
        prior = self.hive.db.one("SELECT granted_at, withdrawn_at FROM app_person_consents WHERE principal = ? AND "
                                 "program_id = ? AND template_id = ?", (principal, program_id, template_id))
        authority = self.hive.programs._authority(program_id) or {}
        return {"program_id": program_id, "program_name": name, "template_id": template_id,
                "template_digest": t["digest"], "key_id": self._own_key(principal, providers), "providers": providers,
                "month_usd": self._month_total(principal),
                "spend_note": SPEND_NOTE,
                "consent_revision": prior, "authority_revision": authority.get("at"),
                # Advisory setup freshness only; the locked POST still compares all five shown fields.
                "consent_current": self._live_consent(principal, program_id, template_id, t) is not None,
                "minds": [{k: m[k] for k in ("slot", "name", "persona", "model", "budget_usd")} for m in t["minds"]],
                "rules": t["rules"]}

    # ---- consent and withdrawal --------------------------------------------------------------------------------------

    def _consent_stamp(self, principal, program_id, template_id):
        """Advance the existing revision even across a same-clock withdraw/reconsent."""
        prior = self.hive.db.one("SELECT granted_at, withdrawn_at FROM app_person_consents WHERE principal = ? AND "
                                 "program_id = ? AND template_id = ?", (principal, program_id, template_id)) or {}
        moment = parse_stamp(now())
        previous = [v for v in (parse_stamp(prior.get("granted_at")), parse_stamp(prior.get("withdrawn_at"))) if v]
        if previous and moment <= max(previous):
            moment = max(previous) + datetime.timedelta(microseconds=1)
        return moment.isoformat(timespec="microseconds").replace("+00:00", "Z")

    def consent(self, principal, program_id, template_id, shown, *, grant_revision=None):
        """The person approves the card they were shown; it must still match what the host would show now."""
        if not str(principal).startswith("user:u_"):
            raise self._err(403, "person_required", "only a named person can set up minds of their own")
        with self._program_lock(program_id), self._lock(principal, program_id):
            card = self.card(principal, program_id, template_id)
            if card["key_id"] is None:
                raise self._err(402, "own_key_needed", "Add your own key for this app's model provider first.",
                                providers=card["providers"])
            if card["month_usd"] is None:
                raise self._err(402, "monthly_total_required", "Set a monthly total for your own keys first.")
            for field in ("template_digest", "key_id", "month_usd", "consent_revision", "authority_revision"):
                if (shown or {}).get(field) != card[field]:
                    raise self._err(409, "card_changed", "What this app would set up has changed; look again.", card=card)
            stamp = self._consent_stamp(principal, program_id, template_id)
            if grant_revision is not None:
                prior = card.get("consent_revision") or {}
                parsed = parse_stamp(grant_revision) if isinstance(grant_revision, str) else None
                previous = [parse_stamp(v) for v in (prior.get("granted_at"), prior.get("withdrawn_at")) if v]
                if parsed is None or any(parsed <= v for v in previous if v is not None):
                    raise self._err(409, "card_changed", "The displayed consent revision is no longer current.")
                stamp = grant_revision   # host-reserved and displayed by P12; never taken from app params
            self.hive.db.execute(
                "INSERT INTO app_person_consents (principal, program_id, template_id, template_digest, key_id, month_usd, "
                "granted_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(principal, program_id, "
                "template_id) DO UPDATE SET template_digest = excluded.template_digest, key_id = excluded.key_id, "
                "month_usd = excluded.month_usd, granted_at = excluded.granted_at, withdrawn_at = NULL",
                (principal, program_id, template_id, card["template_digest"], card["key_id"], card["month_usd"], stamp))
        return card

    def withdraw(self, principal, program_id, template_id):
        """The tombstone, then every bound mind to sleep. Ensure and repair honour the tombstone."""
        if not str(principal).startswith("user:u_"):
            raise self._err(403, "person_required", "only a named person can withdraw their own setup")
        links = getattr(self.hive, "app_links", None)
        # Match P12 admission order: link guard -> program/person/mind -> DB.
        # Hold the guard through the canonical tombstone, not just its marker.
        with links.guard if links is not None else contextlib.nullcontext():
            if links is not None:
                links.revoke_app(principal, program_id)
            with self._program_lock(program_id), self._lock(principal, program_id), contextlib.ExitStack() as stack:
                bindings = self._bindings(program_id, principal)
                for agent_id in sorted({b["agent_id"] for b in bindings}):
                    stack.enter_context(self.hive._mind_lock(agent_id))
                stamp = self._consent_stamp(principal, program_id, template_id)
                self.hive.db.execute("INSERT INTO app_person_consents (principal, program_id, template_id, template_digest, "
                    "key_id, month_usd, granted_at, withdrawn_at) VALUES (?, ?, ?, '', '', 0, ?, ?) "
                    "ON CONFLICT(principal, program_id, template_id) DO UPDATE SET withdrawn_at = excluded.withdrawn_at",
                    (principal, program_id, template_id, stamp, stamp))
                slept = self._sleep_all(principal, program_id, template_id)
        return {"withdrawn": True, "slept": slept}

    def _sleep_all(self, principal, program_id, template_id):
        slept = []
        for b in self.hive.db.all("SELECT agent_id FROM app_person_minds WHERE principal = ? AND program_id = ? AND "
                                  "template_id = ?", (principal, program_id, template_id)):
            self._quiesce(b["agent_id"])
            row = self.hive.db.one("SELECT status FROM agents WHERE id = ? AND deleted = 0", (b["agent_id"],))
            if row is not None and row["status"] == "asleep":
                slept.append(b["agent_id"])
        return slept

    def _runtime_consent(self, principal, program_id, template_id, t):
        """Fresh authority for existing helpers; numeric total changes are enforced by paid-call budgets.

        Missing/revoked totals retain the previous refusal. Only a different numeric value is allowed to outlive
        the value shown at consent; a template/key change or withdrawal still revokes existing helpers.
        """
        c = self.hive.db.one("SELECT * FROM app_person_consents WHERE principal = ? AND program_id = ? AND template_id = ?",
                             (principal, program_id, template_id))
        if c is None or c["withdrawn_at"]:
            return None
        if c["template_digest"] != t["digest"] or c["key_id"] != self._own_key(principal, self._providers(t)):
            return None
        if self._month_total(principal) is None:
            return None
        return c

    def _live_consent(self, principal, program_id, template_id, t):
        """Setup/repair also needs consent to the numeric total currently shown on the host card."""
        c = self._runtime_consent(principal, program_id, template_id, t)
        return c if c is not None and self._month_total(principal) == c["month_usd"] else None

    # ---- ensure (the context method) -------------------------------------------------------------------------------

    def ensure(self, principal, program_id, template_id):
        """{'status': 'ready', 'swarm_id', 'minds'} or {'status': 'consent_required', 'card'}. Nothing is written before
        a live consent. Idempotent; each slot atomic; a half-made slot is removed and made again."""
        if not str(principal).startswith("user:u_"):
            raise self._err(403, "person_required", "only a named person can set up minds of their own")
        with self._program_lock(program_id), self._lock(principal, program_id):
            try:
                program, t = self.template(program_id, template_id)
            except Exception:
                self._sleep_all(principal, program_id, template_id)
                raise
            consent = self._live_consent(principal, program_id, template_id, t)
            if consent is None:
                if self._runtime_consent(principal, program_id, template_id, t) is None:
                    self._sleep_all(principal, program_id, template_id)
                return {"status": "consent_required", "card": self.card(principal, program_id, template_id)}
            home = self._home(principal, program, template_id)
            minds = {}
            for m in t["minds"]:
                agent_id = self._slot(principal, program_id, template_id, m, t, home, consent["key_id"])
                if agent_id is None:  # a numeric total changed after entry, before this slot's setup effects
                    return {"status": "consent_required", "card": self.card(principal, program_id, template_id)}
                minds[m["slot"]] = agent_id
            if self._live_consent(principal, program_id, template_id, t) is None:
                if self._runtime_consent(principal, program_id, template_id, t) is None:
                    self._sleep_all(principal, program_id, template_id)
                return {"status": "consent_required", "card": self.card(principal, program_id, template_id)}
            ready = {"status": "ready", "swarm_id": home, "minds": minds}
            current_total = self._month_total(principal)
            if current_total is None:
                self._sleep_all(principal, program_id, template_id)
                return {"status": "consent_required", "card": self.card(principal, program_id, template_id)}
            runtime = self._runtime_consent(principal, program_id, template_id, t)
            if runtime != consent:
                if runtime is None:
                    self._sleep_all(principal, program_id, template_id)
                return {"status": "consent_required", "card": self.card(principal, program_id, template_id)}
            if current_total != consent["month_usd"]:
                # Advisory only: no new setup follows this read and no card values are exposed.
                ready["total_changed_during_setup"] = True
            return ready

    def _home(self, principal, program, template_id):
        hive = self.hive
        b = hive.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ? AND program_id = ? AND template_id = ?",
                        (principal, program["id"], template_id))
        if b is not None and hive.db.one("SELECT 1 FROM swarms WHERE id = ? AND archived_at IS NULL", (b["swarm_id"],)):
            return b["swarm_id"]
        made = hive.create_swarm(str(program.get("name") or program["id"])[:60], "Set up for you by an app",
                                 owner=principal, visibility="private")
        hive.db.execute("INSERT INTO app_person_swarms (principal, program_id, template_id, swarm_id, created_at) VALUES "
                        "(?, ?, ?, ?, ?) ON CONFLICT(principal, program_id, template_id) DO UPDATE SET swarm_id = "
                        "excluded.swarm_id", (principal, program["id"], template_id, made["id"], now()))
        return made["id"]

    def _slot(self, principal, program_id, template_id, m, t, home, key_id):
        hive = self.hive
        consent = self._live_consent(principal, program_id, template_id, t)
        # Compare with the key captured by ensure's entry consent; repair cannot silently follow a later key selection.
        if consent is None or consent["key_id"] != key_id:
            authority = self._runtime_consent(principal, program_id, template_id, t)
            if authority is not None and authority["key_id"] == key_id:
                return None  # ask again at setup; never stop already-authorised helpers for a numeric total change
            self._sleep_all(principal, program_id, template_id)
            raise self._err(409, "card_changed", "Consent changed before repair; look at the setup again.")
        b = hive.db.one("SELECT * FROM app_person_minds WHERE principal = ? AND program_id = ? AND template_id = ? AND "
                        "slot = ?", (principal, program_id, template_id, m["slot"]))
        row = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (b["agent_id"],)) if b else None
        if row is not None and b["finished"]:
            # update_agent below shares the global tools-choice fence with
            # ordinary updates. Take that fence before the mind lock, as _make
            # and update_agent do; repair must not invert tools -> mind.
            with hive._tools_choices_lock, hive._mind_lock(row["id"]):
                row = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row["id"],))
                if row is None or row["swarm_id"] != home or row.get("owner") != principal:
                    raise self._err(409, "person_swarm_repair_required", "A finished mind moved or changed owner; its owner must resolve it.")
                # Explicit fresh consent may repair an owned finished slot in place,
                # preserving its identity/history. Never silently delete a finished mind.
                options = json.loads(row.get("options") or "{}")
                if b["template_digest"] != t["digest"] or options.get("key") != key_id or options.get("key_locked") is not True:
                    self._quiesce(row["id"])
                    stopped = hive.db.one("SELECT status FROM agents WHERE id = ?", (row["id"],))
                    if stopped["status"] != "asleep":
                        raise self._err(409, "person_swarm_repair_required", "The old mind could not be confirmed asleep.")
                    options.update(key=key_id, key_locked=True)
                    hive.update_agent(row["id"], {"name": m["name"], "persona": m["persona"], "model": m["model"],
                        "budget_usd": m["budget_usd"], "options": options}, by=principal)
                    with hive.db.transaction():
                        hive.db.execute("UPDATE app_person_minds SET template_digest = ? WHERE agent_id = ?", (t["digest"], row["id"]))
                        hive.db.execute("DELETE FROM app_template_rules WHERE agent_id = ?", (row["id"],))
                        self._store_rules(row["id"], program_id, t)
                        hive.db.update("agents", row["id"], {"last_error": None})
                    self.require_current(row["id"])
                return row["id"]
        if row is not None:   # unfinished, moved, or made under another template: removed, then made again
            hive.delete_agent(row["id"], by=HOST_ACTOR)
        hive.db.execute("DELETE FROM app_person_minds WHERE principal = ? AND program_id = ? AND template_id = ? AND slot = ?",
                        (principal, program_id, template_id, m["slot"]))
        return self._make(principal, program_id, template_id, m, t, home, key_id)

    def _store_rules(self, agent_id, program_id, template):
        for rule in _strongest_rules(template["rules"]):
            self.hive.db.execute(
                "INSERT INTO app_template_rules (agent_id, skill, mode, program_id, template_digest) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, skill) DO UPDATE SET "
                "mode = CASE WHEN app_template_rules.mode = 'deny' OR excluded.mode = 'deny' THEN 'deny' ELSE 'ask' END, "
                "program_id = excluded.program_id, template_digest = excluded.template_digest",
                (agent_id, rule["skill"], rule["mode"], program_id, template["digest"]))

    def _make(self, principal, program_id, template_id, m, t, home, key_id):
        """The mind's row (asleep, key-locked), its binding and its template rules commit in one transaction before any
        setup that can fail; a failure after that deletes it (its soft delete drops the binding); finished is set last."""
        hive = self.hive
        options = {"key": key_id, "key_locked": True}
        hive.check_key_lock(principal, {}, options, principal)   # P3a: the person's own key, nothing else
        row, token, role = hive.new_agent_row(m["name"], "omega", home, m["model"], m["persona"], None, m["budget_usd"],
                                              options, None, principal, "private", None)
        row.update(status="asleep", desired="asleep")
        try:
            with hive._tools_choices_lock, hive._mind_lock(row["id"]), hive.swarm_membership(home):
                stamp = now()
                with hive.roles.lock, hive.db.transaction():
                    hive.insert_into_open_swarm("agents", row, home)
                    hive.db.execute("INSERT INTO app_person_minds (principal, program_id, template_id, slot, agent_id, "
                                    "template_digest, finished, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                                    (principal, program_id, template_id, m["slot"], row["id"], t["digest"], stamp))
                    self._store_rules(row["id"], program_id, t)
                hive.finish_agent(row, token, role, by=HOST_ACTOR)
            hive.db.execute("UPDATE app_person_minds SET finished = 1 WHERE agent_id = ?", (row["id"],))
        except Exception:
            if hive.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (row["id"],)):
                try:
                    hive.delete_agent(row["id"], by=HOST_ACTOR)
                except Exception:   # noqa: BLE001  (unfinished: the next ensure removes and remakes it)
                    log.exception("person swarm: %s not cleaned after a failed setup", row["id"])
            raise
        return row["id"]

    # ---- the ceiling and cleanup (read by Policy and the soft delete) ------------------------------------------------

    def ceiling(self, agent_id, skill):
        """'deny', 'ask' or None: the strongest template rule matching this skill (exact or glob) for a template-bound mind."""
        if not agent_id:
            return None
        binding, reason = self.current(agent_id)
        if binding is not None and reason is not None:
            self.read_row(self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,)))
            return "deny"
        rows = self.hive.db.all("SELECT skill, mode FROM app_template_rules WHERE agent_id = ?", (agent_id,))
        modes = {r["mode"] for r in rows if r["skill"] == skill or _glob(r["skill"], skill)}
        return "deny" if "deny" in modes else "ask" if "ask" in modes else None

    def forget(self, agent_id):
        """Inside a mind's soft delete: its binding and template rules go with it."""
        self.hive.db.execute("DELETE FROM app_person_minds WHERE agent_id = ?", (agent_id,))
        self.hive.db.execute("DELETE FROM app_template_rules WHERE agent_id = ?", (agent_id,))
