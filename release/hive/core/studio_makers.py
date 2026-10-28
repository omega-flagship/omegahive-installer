"""J3 host R7: a personal Studio maker for every member, on that member's own key.

the owner 2026-10-19: "everyone needs studio, they just need to use their own keys"; and, asked whether each member gets their
own Studio maker mind on their own key: "Yes: each member gets their own Studio maker mind that runs on their own key."

- One maker per named person, made by the host on demand (setup), never by an admin by hand, and reused while it lives.
  It is found by its binding (person_minds: principal + purpose 'studio_maker'), never by name.
- Its shape is the reviewed Design maker's: the template mind HIVE_STUDIO_MAKER_TEMPLATE gives kind (omega only: the hub
  channel and R6.1's native Studio skills), role, persona (prompt), tools and budget; the model is HIVE_STUDIO_MAKER_MODEL
  (default the reviewed maker's openrouter/anthropic/claude-sonnet-5.5, the owner's standing Sonnet 5.5 for making minds).
- It lives in a private Studio swarm the person owns (their personal swarm holds their personal mind alone, personal.py),
  owned by them and private, so only they and the existing admin views see it. It is written asleep; the Studio handoff
  starts it per step, as for any maker.
- options.key is the person's OWN key for the model's provider: the provider default when that is theirs, else their
  earliest key for that provider (own_key_for's choice). No own key: 402 own_key_needed before anything is created,
  attached or reserved; never the hive's key or anyone else's. Each setup re-resolves it (a changed or removed key), so
  a card confirmed before then meets key_drift at admission and the client reads a fresh card.
- The host attaches it to the Studio program itself (ProgramAttachments.host_attach_studio_maker): the one audited
  exception to admin-only attachment, for this host-made, person-bound maker and the Studio program only.
- With HIVE_STUDIO_SESSIONS off nothing here creates, attaches or changes anything (setup answers 404 not_available).
"""

from __future__ import annotations

import json
import logging
import os
import threading

from .db import new_id, now

log = logging.getLogger("hive")

PURPOSE = "studio_maker"
MODEL_SETTING = "HIVE_STUDIO_MAKER_MODEL"
DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-5.5"   # the reviewed Design maker's (a_e6ccf6f5), on OpenRouter's list
TEMPLATE_SETTING = "HIVE_STUDIO_MAKER_TEMPLATE"            # the reviewed Design maker's mind id on this hive
PROGRAM_SETTING = "HIVE_STUDIO_PROGRAM"
DEFAULT_PROGRAM = "omegadesign"
HOST_ACTOR = "hive:studio-maker"                           # who the host's own acts are recorded as
HOST_ATTACH_KEY = "host:studio_maker"                      # app_attachments.request_key of the host's attachment rows
TEMPLATE_KINDS = ("omega",)                                # studio_sessions.HUB_MAKER_KINDS
SETUP_KEYS = {"title", "detail", "piece", "max_steps", "window_minutes", "cap_usd", "step_cap_usd", "coordinator_exclusive",
              "program_id"}

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS person_minds (
  principal TEXT NOT NULL, purpose TEXT NOT NULL, agent_id TEXT, swarm_id TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (principal, purpose))""",
    "CREATE UNIQUE INDEX IF NOT EXISTS person_minds_agent ON person_minds(agent_id) WHERE agent_id IS NOT NULL",
    """CREATE TABLE IF NOT EXISTS studio_maker_audit (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, agent_id TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)""",
]


def model_setting():
    return os.environ.get(MODEL_SETTING, "").strip() or DEFAULT_MODEL


def program_setting():
    return os.environ.get(PROGRAM_SETTING, "").strip() or DEFAULT_PROGRAM


class StudioMakers:
    def __init__(self, hive):
        self.hive = hive
        for statement in SCHEMA:
            hive.db.execute(statement)
        self._lock = threading.RLock()     # one setup at a time (the binding's primary key is the backstop)

    # ---- errors and switches ----------------------------------------------------------------------------------------

    def _err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    def _studio(self):
        return getattr(self.hive, "studio", None)

    def enabled(self):
        studio = self._studio()
        return bool(studio is not None and getattr(studio, "enabled", False))

    def _audit(self, principal, agent_id, action, **detail):
        """The exception's audit trail (metadata only: ids, key ids, never a secret)."""
        self.hive.db.insert("studio_maker_audit", {"id": new_id("sma"), "principal": principal, "agent_id": agent_id,
                                                   "action": action, "detail": json.dumps(detail, sort_keys=True) if detail else None,
                                                   "created_at": now()})

    # ---- the binding --------------------------------------------------------------------------------------------------

    def binding(self, principal):
        return self.hive.db.one("SELECT * FROM person_minds WHERE principal = ? AND purpose = ?", (principal, PURPOSE))

    def bound(self, principal):
        """The person's live Studio maker row, or None (no binding, or its mind was deleted)."""
        b = self.binding(principal)
        if b is None or not b["agent_id"]:
            return None
        return self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (b["agent_id"],))

    def person_of(self, agent_id):
        """The person whose Studio maker this mind is (bound by the host), else None."""
        row = self.hive.db.one("SELECT principal FROM person_minds WHERE agent_id = ? AND purpose = ?", (agent_id, PURPOSE))
        return row["principal"] if row else None

    # ---- the key: the person's own, for the maker model's provider ---------------------------------------------------

    def own_key(self, principal, provider):
        """The key the person's maker runs on: the provider default when it is the person's own, else their earliest own
        key for that provider (OwnHive.own_key_for's choice). None when they have none. Never a hive key or a key someone
        else owns or granted: the owner's rule is their own key."""
        keyring = getattr(self.hive, "keyring", None) or getattr(getattr(self._studio(), "gateway", None), "keyring", None)
        if keyring is None:
            return None
        ownhive = self.hive.ownhive
        default = (keyring.ring.get("defaults") or {}).get(provider)
        if default and ownhive.key_person(default) == principal:
            record = (keyring.ring.get("keys") or {}).get(default) or {}
            if record.get("provider") == provider:
                return default
        own = sorted((r for r in (keyring.ring.get("keys") or {}).values()
                      if r.get("owner") == principal and r.get("provider") == provider),
                     key=lambda r: r.get("created_at") or 0)
        return own[0]["id"] if own else None

    def key_label(self, key_id):
        keyring = getattr(self.hive, "keyring", None) or getattr(getattr(self._studio(), "gateway", None), "keyring", None)
        record = ((keyring.ring.get("keys") if keyring else None) or {}).get(key_id) or {}
        return str(record.get("label") or key_id)[:80]

    # ---- the reviewed template ------------------------------------------------------------------------------------------

    def template(self):
        """The reviewed Design maker this hive's personal makers copy. 409 studio_maker_unavailable when unset, missing or
        not an Omega mind (so nothing is created)."""
        mind_id = os.environ.get(TEMPLATE_SETTING, "").strip()
        row = self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (mind_id,)) if mind_id else None
        if row is None or (row.get("kind") or "omega") not in TEMPLATE_KINDS or self.person_of(row["id"]):
            raise self._err(409, "studio_maker_unavailable", "Studio's maker isn't set up on this hive yet; ask an admin.",
                            reason="template_unset" if not mind_id else "template_unusable")
        return row

    # ---- R7.2: own keys only, at every boundary ------------------------------------------------------------------------

    OWN_KEY_SAY = "This mind would run on someone else's key. Add your own key in Keys, then try again."

    def key_refusal(self, agent_id, key_id, where):
        """For a person's own Studio maker: the paying key must be a key that person owns (the owner: own keys only). A hive or
        environment key, no key, or another person's key is refused. None for every other mind (shared makers unchanged).
        where: 'admission' (another person's key is 409 key_drift: the card's key is no longer theirs) or 'call' / 'patch'."""
        bound = self.person_of(agent_id)
        if bound is None:
            return None
        holder = self.hive.ownhive.key_person(key_id) if key_id else None
        if holder == bound:
            return None
        if where == "patch":
            return self._err(403, "own_key_only", "A Studio maker runs only on its person's own key; choose one of "
                             "their keys, or remove the key.", scope="studio_maker")
        if where == "admission" and holder is not None:
            return self._err(409, "key_drift", "The key paying for the maker changed since you confirmed; confirm again.",
                             reason="not_own_key")
        return self._err(402, "own_key_needed", self.OWN_KEY_SAY, scope="studio_maker", pays="own-key")

    # ---- J3 host R8: image generation for a person's own maker, inside its live session only ----------------------------

    def live_media_person(self, agent):
        """The person whose own Studio maker this mind is (the host binding, never a name or an allowlist entry) while it is
        the maker of THAT person's live, admitted session: Studio on, the session active or paused (not stopping, stopped,
        held or ended), its window not passed, and the token epoch this request authenticated with not fenced. Else None.
        It is what admits the maker's media calls (media.MediaRoute.handle) and opens its two image skills under a glob
        deny or ask (policy.STUDIO_MEDIA_SKILLS). No other mind is ever answered: shared makers, templates and every
        ordinary mind get None, so HIVE_MEDIA_ALLOW stays exact for them. Fails closed on any error."""
        try:
            studio = self._studio()
            if studio is None or not getattr(studio, "enabled", False) or not isinstance(agent, dict) or not agent.get("id"):
                return None
            person = self.person_of(agent["id"])
            if person is None:
                return None
            row = studio.live_session_of(agent["id"])
            if row is None or row["state"] not in ("active", "paused") or row["principal"] != person:
                return None
            from .studio_handoff import _passed
            if _passed(row.get("expires_at")):
                return None             # the window has ended (the expiry Stop may not have run yet)
            if studio.fenced(agent["id"], agent.get("token_epoch")):
                return None
            return person
        except Exception:   # noqa: BLE001
            return None

    def media_key(self, agent, principal, provider):
        """R8: the key a live personal maker's media call pays with: its assigned key when that is the person's own key
        for the media provider (the key the session was consented on, as its chat), else the person's own key for that
        provider (own_key's choice). None when they have none: the route answers 402 own_key_needed. Never the hive's key
        or another person's (R7.2's check_budget guard refuses those again)."""
        keyring = getattr(self.hive, "keyring", None) or getattr(getattr(self._studio(), "gateway", None), "keyring", None)
        options = agent.get("options") if isinstance(agent, dict) else None
        if isinstance(options, str):
            try:
                options = json.loads(options)
            except ValueError:
                options = None
        assigned = options.get("key") if isinstance(options, dict) else None
        record = ((keyring.ring.get("keys") if keyring else None) or {}).get(assigned) if assigned else None
        if record and record.get("provider") == provider and self.hive.ownhive.key_person(assigned) == principal:
            return assigned
        return self.own_key(principal, provider)

    def template_ready(self):
        """True when the template setting names a usable Omega mind AND the Studio program is loaded, ready and attachable
        by the host (hook-free), i.e. when setup could succeed for a member with a key (R7.1 capability, R7.2 stand-in
        follow-up; also the startup log). J3 host R8.3: a hooked Studio app counts as attachable only with a valid
        member_attach declaration; the one check is ProgramAttachments.host_scope, the same one setup's attach makes,
        and it calls no app hook. A malformed declaration is no declaration (False)."""
        try:
            self.template()
            entry = self.hive.programs._ready(program_setting())
            return self.hive.app_attachments.host_scope(entry) is not None
        except Exception:   # noqa: BLE001
            return False

    # ---- setup: made on demand, reused, re-resolved --------------------------------------------------------------------

    def ensure(self, principal):
        """The person's Studio maker, attached and on their own key: (row, created). 404 while Studio is off; 403 for
        anyone who is not a named, enabled person; 402 own_key_needed with nothing created, attached or reserved."""
        from .gateway import split_model
        studio = self._studio()
        if not self.enabled():
            raise self._err(404, "not_available", "That isn't available.")
        if not studio._person_ok(principal):
            raise self._err(403, "person_required", "a named, signed-in person does this")
        model = model_setting()
        provider = split_model(model)[0]
        key = self.own_key(principal, provider)
        if key is None:
            # OI-13's code and words (ownhive.person_key_check): nothing is made, attached or reserved
            raise self._err(402, "own_key_needed", "This mind would run on someone else's key. Add your own key in Keys, "
                            "then try again.", scope="studio_maker", pays="own-key", provider=provider)
        template = self.template()
        with self._lock:
            row = self.bound(principal)
            created = False
            if row is None:
                row = self._create(principal, template, model, key)
                created = True
            else:
                row = self._resolve(principal, row, model, key)
            self.hive.app_attachments.host_attach_studio_maker(program_setting(), row["id"], principal)
        return self.hive.db.one("SELECT * FROM agents WHERE id = ?", (row["id"],)), created

    def _home(self, principal, name):
        """The person's private Studio swarm: the one their binding names while it is open and theirs, else a new one."""
        hive = self.hive
        b = self.binding(principal)
        if b and b["swarm_id"]:
            swarm = hive.db.one("SELECT * FROM swarms WHERE id = ? AND archived_at IS NULL", (b["swarm_id"],))
            if swarm and swarm.get("owner") == principal and not swarm.get("personal_of"):
                return swarm["id"]
        made = hive.create_swarm(f"{name}'s Studio", "Studio: your own maker, on your own key", owner=principal,
                                 visibility="private")
        return made["id"]

    def _create(self, principal, template, model, key):
        hive = self.hive
        self.forget_stale(principal)
        person = hive.personal.person(principal)
        name = hive.personal.display_name(person) if person else "Me"
        swarm_id = self._home(principal, name)
        options = {"key": key}
        tools = (json.loads(template["options"]) if template.get("options") else {}).get("tools")
        if tools:
            options["tools"] = list(tools)
        agent = hive.create_agent(f"{name}'s Studio maker", template.get("kind") or "omega", swarm_id, model,
                                  template.get("persona") or "", None, float(template.get("budget_usd") or 0), options,
                                  template.get("role_id"), principal, "private", None, by=HOST_ACTOR, privileged=True)
        stamp = now()
        with hive.db.transaction():
            # written asleep (as personal.py writes a personal mind); the Studio handoff starts it per step
            hive.db.execute("UPDATE agents SET status = 'asleep', desired = 'asleep' WHERE id = ? AND status IN "
                            "('created', 'stopped')", (agent["id"],))
            hive.db.execute("INSERT INTO person_minds (principal, purpose, agent_id, swarm_id, created_at, updated_at) "
                            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(principal, purpose) DO UPDATE SET agent_id = excluded.agent_id, "
                            "swarm_id = excluded.swarm_id, updated_at = excluded.updated_at",
                            (principal, PURPOSE, agent["id"], swarm_id, stamp, stamp))
            self._audit(principal, agent["id"], "created", template=template["id"], model=model, key_id=key, swarm_id=swarm_id)
        hive.emit_agent(agent["id"])
        log.info("studio maker %s made for %s", agent["id"], principal)
        return hive.db.one("SELECT * FROM agents WHERE id = ?", (agent["id"],))

    def _resolve(self, principal, row, model, key):
        """A later setup: the key (and the model setting) re-resolved. Never under a session Studio still owns (S5: the
        binding the person consented to stays; admission then answers as it does today)."""
        studio = self._studio()
        options = json.loads(row["options"]) if row.get("options") else {}
        if options.get("key") == key and row["model"] == model:
            return row
        if studio is not None and studio.studio_owns(row["id"]):
            return row
        changes = {"options": {**options, "key": key}}
        if row["model"] != model:
            changes["model"] = model
        self.hive.update_agent(row["id"], changes, by=HOST_ACTOR)
        self._audit(principal, row["id"], "resolved", key_id=key, previous_key_id=options.get("key"), model=model)
        return self.hive.db.one("SELECT * FROM agents WHERE id = ?", (row["id"],))

    # ---- no orphans ---------------------------------------------------------------------------------------------------

    def forget_stale(self, principal):
        """A binding whose mind was deleted: its host attachment rows end and the binding goes (the next setup rebinds)."""
        b = self.binding(principal)
        if b is None or not b["agent_id"]:
            return
        live = self.hive.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (b["agent_id"],))
        if live is None:
            self.forget(b["agent_id"])

    def forget(self, agent_id):
        """Called inside a mind's soft delete (Hive._soft_delete_locked), and for a stale binding: the host's attachment
        rows for this mind end (revoked; they have no app hooks to run) and the binding lets go of the mind (it keeps the
        person's Studio home, which the next setup reuses). Nothing else."""
        db = self.hive.db
        principal = self.person_of(agent_id)
        if principal is None:
            return False
        db.execute("UPDATE app_attachments SET status = 'revoked', revoked_by = ? WHERE mind = ? AND request_key = ? "
                   "AND status IN ('binding', 'active', 'unbind_pending')", (HOST_ACTOR, agent_id, f"{HOST_ATTACH_KEY}:{agent_id}"))
        db.execute("UPDATE person_minds SET agent_id = NULL, updated_at = ? WHERE agent_id = ? AND purpose = ?",
                   (now(), agent_id, PURPOSE))
        self._audit(principal, agent_id, "forgotten")
        return True

    def retire_for(self, principal):
        """The person's access ended (disabled): their maker is deleted, unless Studio still owns it (its session's own
        Stop releases it; the startup sweep retires it after). Inert with Studio off."""
        if not self.enabled():
            return None
        row = self.bound(principal)
        if row is None:
            self.forget_stale(principal)
            return None
        studio = self._studio()
        if studio is not None and studio.studio_owns(row["id"]):
            log.info("studio maker %s of %s is still owned by a Studio session; retired after its Stop", row["id"], principal)
            return None
        self.hive.delete_agent(row["id"], by=HOST_ACTOR)     # the soft delete calls forget (binding, attachment)
        return row["id"]

    def sweep(self):
        """Once at startup, with Studio on: bindings to deleted minds are dropped, and makers of people who no longer have
        access (disabled or gone) are retired. One failure never stops the rest."""
        if not self.enabled():
            return 0
        done = 0
        for b in self.hive.db.all("SELECT * FROM person_minds WHERE purpose = ?", (PURPOSE,)):
            try:
                person = self.hive.personal.person(b["principal"])
                if person is None:
                    if self.retire_for(b["principal"]) is not None:
                        done += 1
                else:
                    self.forget_stale(b["principal"])
            except Exception:   # noqa: BLE001
                log.exception("studio maker sweep: %s", b["principal"])
        return done

    # ---- the setup card ------------------------------------------------------------------------------------------------

    def maker_view(self, row, created):
        options = json.loads(row["options"]) if row.get("options") else {}
        attachment = self.hive.db.one("SELECT id FROM app_attachments WHERE program = ? AND mind = ? AND status = 'active'",
                                      (program_setting(), row["id"]))
        return {"id": row["id"], "name": row["name"], "swarm_id": row["swarm_id"], "kind": row["kind"], "model": row["model"],
                "key_id": options.get("key"), "key_label": self.key_label(options.get("key")),
                "own_key": bool(options.get("key")) and self.hive.ownhive.key_person(options.get("key")) == row.get("owner"),
                "role_id": row.get("role_id"), "tools": list(options.get("tools") or []), "status": row["status"],
                "program_id": program_setting(), "attachment_id": attachment["id"] if attachment else None,
                "created": bool(created)}

    def setup(self, viewer, data):
        """POST /api/studio/setup {request?: {title, detail, piece, max_steps, window_minutes, [cap_usd, step_cap_usd,
        coordinator_exclusive, program_id]}}: the person's maker (made if missing, reused, its key re-resolved, attached)
        and, with a request, the setup card: the full studio.session request the host derived (maker, Studio home, app
        pin, key, model, role, tools) with the host's consent payload and digest, ready to record unchanged."""
        from .studio_sessions import consent_digest, consent_payload
        studio = self._studio()
        if not self.enabled():
            raise self._err(404, "not_available", "That isn't available.")
        if not isinstance(data, dict) or set(data) - {"request"}:
            raise self._err(400, "bad_request", "the body is {} or {request}")
        partial = data.get("request")
        if partial is not None and (not isinstance(partial, dict) or set(partial) - SETUP_KEYS):
            raise self._err(400, "bad_request", "request carries only what the person chose; the hive derives the rest",
                            allowed=sorted(SETUP_KEYS))
        if partial is not None and partial.get("program_id", program_setting()) != program_setting():
            raise self._err(409, "app_not_attached", "Studio isn't attached to that app here.")
        row, created = self.ensure(viewer.principal)
        out = {"maker": self.maker_view(row, created)}
        if partial is None:
            return out
        request = self.fill(viewer.principal, {k: v for k, v in partial.items() if k != "program_id"}, row)
        request["consent_digest"] = "sha256:" + "0" * 64          # a shape placeholder for the checks; replaced below
        request = studio.clean_request(request)
        maker = row
        options = json.loads(maker["options"]) if maker.get("options") else {}
        key_id = options.get("key")
        refused = self.key_refusal(maker["id"], key_id, "admission")      # R7.2: the bound person's own key only
        if refused is not None:
            raise refused
        payer, own_key = studio._payer_as_if(viewer.principal, self.hive.ownhive.key_person(key_id))
        if payer != viewer.principal or not own_key:
            raise self._err(409, "payer_mismatch", "That maker's calls wouldn't be billed to you; choose your own key.")
        monthly = studio._monthly_total(viewer.principal, maker, key_id, own_key, float(request["cap_usd"]))
        payload = consent_payload(request, own_key=own_key, monthly=monthly)
        request["consent_digest"] = consent_digest(payload)
        out.update(request=request, consent=payload, consent_digest=request["consent_digest"],
                   maker_name=maker["name"], key_label=self.key_label(key_id))
        return out

    def fill(self, principal, request, row=None):
        """The host-derived fields of a personal-maker request (maker, Studio home, app and pin, key, model, role, tools);
        a field the caller gave must already equal it (a stale value is drift the card shows, never kept silently)."""
        studio = self._studio()
        row = row or self.bound(principal)
        if row is None:
            raise self._err(409, "studio_maker_missing", "Set up your Studio maker first.")
        program = program_setting()
        try:
            entry = self.hive.programs._ready(program)
        except Exception:   # noqa: BLE001  (an app that will not open is not attached)
            raise self._err(409, "app_not_attached", "Studio isn't available on this hive right now.") from None
        options = json.loads(row["options"]) if row.get("options") else {}
        derived = {"maker_id": row["id"], "swarm_id": row["swarm_id"], "program_id": program,
                   "app_pin": {"id": program, "version": str(entry.get("version")), "digest": entry.get("digest")},
                   "key_id": options.get("key"), "model": row["model"], "role_id": row.get("role_id") or None,
                   "tools": list(options.get("tools") or [])}
        out = dict(request)
        for field in ("maker_id", "swarm_id"):
            if field in out and out[field] is not None and out[field] != derived[field]:
                raise studio._err(409, "maker_not_yours", "That maker isn't your Studio maker.")
            out[field] = derived[field]
        for field in ("program_id", "app_pin", "key_id", "model", "role_id", "tools"):
            out.setdefault(field, derived[field])
        return out
