"""Mind programs: plugins that supply a work graph for the adaptive host UI.

See hive/PROGRAMS.md for the contract. A program is a directory with a
plugin.json manifest and a Python module defining describe(), view() and
act(). Built-in programs live in hive/plugins/; more come from the directories
in HIVE_PLUGIN_DIRS, so private programs stay in their owners' repositories.
"""

from __future__ import annotations

import hashlib
import contextlib
import contextvars
import importlib.util
import json
import os
import asyncio
import pathlib
import re
import threading
import traceback

BUILTIN_DIR = pathlib.Path(__file__).resolve().parents[1] / "plugins"
PIN_REFUSALS = {"release_mismatch", "duplicate_discovery", "pin_conflict", "unpinned", "pins_invalid"}


class ValidationCheck(list):
    """Errors plus internal host read guards; never accepted from plugin output."""
    def __init__(self, errors, read_guards):
        super().__init__(errors)
        self.read_guards = tuple(read_guards)


FINDING_HOOK_TIMEOUT = 30.0   # seconds a validate_finding_target hook may take (it may call ctx.sandbox_run)
CONTRACT = "0.1"
STAGES = ("unfold", "map", "compare", "detail")
ROLES = {"question", "claim", "evidence", "hypothesis", "assessment", "explanation", "gap", "source", "other"}
POLARITIES = {"support", "oppose", "qualify", "neutral"}
ITEM_STATUSES = {"current", "corrected", "superseded", "retracted"}
SOURCE_STATUSES = {"retrieved", "inspected", "cited", "unavailable"}
RESULT_STATUSES = {"done", "started", "needs_input", "stale", "refused", "error"}
TYPE_PAIRINGS = {"editorial", "technical", "humanist", "mono"}
MOTIFS = {"none", "constellation", "strata", "lattice", "grain", "rings", "ruled", "blueprint"}
DENSITIES = {"airy", "regular", "dense"}
TRANSPORT = {"validated", "stale", "refused", "expired", "cancelled"}
REVIEW = {"pending", "accepted", "rejected", "superseded"}
DEFAULT_THEME = {"accent": "#8b9cff", "accent_2": "#f2c46b", "surface": "#0b0d1a", "ink": "#e8eaf6",
                 "type": "humanist", "motif": "none", "density": "regular"}


def _luminance(hex_color):
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def check_app(app):
    """The optional manifest `app` block: identity for the mind-to-app morph. Data only; the host renders it.

    Returns (app, warnings). Bad values fall back to defaults with a warning instead of failing the load,
    and colours that would be unreadable are replaced: the host owns legibility.
    """
    app = dict(app or {})
    warnings = []
    theme = dict(DEFAULT_THEME)
    for key, value in (app.get("theme") or {}).items():
        if key in ("accent", "accent_2", "surface", "ink"):
            if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                theme[key] = value.lower()
            else:
                warnings.append(f"theme.{key} must be #rrggbb")
        elif key == "type" and value in TYPE_PAIRINGS or key == "motif" and value in MOTIFS \
                or key == "density" and value in DENSITIES:
            theme[key] = value
        else:
            warnings.append(f"theme.{key}={value!r} is not supported")
    if contrast(theme["ink"], theme["surface"]) < 7.0:
        warnings.append("ink on surface is below 7:1; using the default ink and surface")
        theme["ink"], theme["surface"] = DEFAULT_THEME["ink"], DEFAULT_THEME["surface"]
    for key in ("accent", "accent_2"):
        if contrast(theme[key], theme["surface"]) < 3.0:
            warnings.append(f"{key} on surface is below 3:1; using the default {key}")
            theme[key] = DEFAULT_THEME[key]
    out = {"theme": theme, "home": app.get("home") if isinstance(app.get("home"), str) else None,
           "open_stage": app.get("open_stage") if app.get("open_stage") in STAGES else "unfold",
           "tagline": str(app.get("tagline") or "")[:140]}
    return out, warnings
MAX_ITEMS, MAX_LINKS = 400, 1200
CAPABILITIES = {"commons:read", "goals:read", "goals:write", "exhibits:write", "evolve:read", "evolve:write", "sandbox:run",
                "artifacts:read", "artifacts:write", "person_swarm"}


_PERSON_SWARM_ACT = contextvars.ContextVar("person_swarm_act", default=None)


class _PersonSwarmAct:
    """Host-held call identity, never attached to the mutable app context.

    This is an in-process integrity boundary, not a Python/OS sandbox. Only a
    recorded host person_activity call can provision; copied background task
    contexts share the active flag, which is cleared before act() returns.
    """
    def __init__(self, ctx, hive, program_id, swarm_id, action, actor, command, items, read_only, capabilities,
                 on_consent_required=None):
        self.ctx, self.hive = ctx, hive
        self.program_id, self.swarm_id, self.action = program_id, swarm_id, action
        self.read_only, self.capabilities = bool(read_only), frozenset(capabilities)
        self.active, self.identity = True, None
        # Only the route's captured host callback reaches this private call record.
        # No Context field or app result can set the advisory response hint.
        self._on_consent_required = on_consent_required if callable(on_consent_required) else None
        self._consent_noticed = False
        self.principal = actor.get("principal") if isinstance(actor, dict) else None
        self.actor_kind = actor.get("kind") if isinstance(actor, dict) else None
        self.items = tuple(items)
        if not isinstance(command, dict):
            return
        fields = (command.get("record_id"), command.get("idempotency_key"), command.get("params_digest"))
        if all(isinstance(value, str) and value for value in fields):
            self.identity = fields
        if not self._current():
            self.identity = None

    def _current(self):
        if self.identity is None or self.actor_kind != "person" or not isinstance(self.principal, str):
            return False
        try:
            row = self.hive.db.one("SELECT * FROM program_actions WHERE id = ?", (self.identity[0],))
            actor = json.loads(row["actor"]) if row else None
            return bool(row and isinstance(actor, dict) and actor.get("kind") == "person"
                and actor.get("principal") == row["principal"] == self.principal
                and (row["id"], row["idempotency_key"], row["params_digest"]) == self.identity
                and row["program"] == self.program_id and row["swarm_id"] == self.swarm_id
                and row["action"] == self.action and tuple(json.loads(row["items"])) == self.items
                and row["status"] == "running")
        except Exception:  # malformed/missing/unknown host identity never becomes a person
            return False

    def ensure(self, ctx, template_id):
        if not self.active or self.ctx is not ctx or self.identity is None or not self._current():
            raise self.hive.error(403, "person_required", "a live recorded person action is required")
        if self.read_only:
            raise self.hive.error(403, "read_only", "this check is read-only")
        if "person_swarm" not in self.capabilities:
            raise self.hive.error(403, "capability_missing", "the app did not declare person_swarm")
        out = self.hive.person_swarms.ensure(self.principal, self.program_id, str(template_id))
        if out.get("status") == "consent_required":
            if self._on_consent_required is not None and not self._consent_noticed:
                self._consent_noticed = True
                self._on_consent_required()
            return {"status": "consent_required"}
        return out


class ProgramContext:
    """What a program may touch, limited to its declared capabilities and one swarm."""

    actor = None    # contract 0.2: the trusted actor, set by the hive for act() only (see program_actions.py)
    viewer = None   # proposed read context: host-derived person, never action authority
    view_input = None  # P13 structured untrusted_intent only in view(); never act/rule authority
    command = None  # contract 0.2: the trusted request identity (idempotency key, record id), set by the hive
    read_only = False  # r2.10: a finding-target check reads and may sandbox, but never writes
    file = None     # Surface G2: one file from the person's device for this act(); its bytes are never stored by the hive

    def __init__(self, hive, swarm_id, program):
        self._hive, self._program = hive, program
        self.swarm_id = swarm_id
        self.swarm = hive.swarm(swarm_id)

    WRITE_CAPABILITIES = frozenset({"goals:write", "exhibits:write", "artifacts:write", "evolve:write", "person_swarm"})

    def ensure_person_swarm(self, template_id):
        """Use only this live host-recorded person act, never mutable ctx.actor/command.

        The program receives bare consent_required; the authenticated person's
        host card route alone returns key/monthly/template details.
        """
        call = _PERSON_SWARM_ACT.get()
        if call is None or call.ctx is not self:
            raise self._hive.error(403, "person_required", "a live recorded person action is required")
        return call.ensure(self, template_id)

    def _need(self, capability):
        actor = self.actor or {}
        if actor.get("kind") == "mind" and actor.get("id"):
            self._hive.person_swarms.require_current(actor["id"])
        # One central guard (found by OmegaReview 2026-10-04): a read-only context (a finding-target check)
        # refuses every write capability, so no context mutator can be reached from it.
        if self.read_only and capability in self.WRITE_CAPABILITIES:
            raise self._hive.error(403, "read_only", "this check is read-only")
        if capability not in self._program["capabilities"]:
            raise self._hive.error(403, "capability_missing",
                                   f"{self._program['id']} did not declare {capability} in plugin.json")

    # ---- artifacts for app actions, always as the acting mind (never with more reach than the mind has) ----------

    def _acting(self, write=False):
        """Who artifact access runs as, never with more reach than they have:
        - a mind acting through the app (ctx.actor kind 'mind', in this swarm);
        - a person acting through the app (ctx.actor kind 'person'): the host already checked they can see this swarm,
          so they act within it, recorded under their own principal;
        - for reads only, the person or operator viewing this swarm (ctx.viewer)."""
        actor = getattr(self, "actor", None) or {}
        if actor.get("kind") == "mind" and actor.get("id"):   # the host's trusted mind actor (ProgramActions.mind_actor)
            agent = self._hive.agent(actor["id"])
            if agent.get("swarm_id") != self.swarm_id:
                raise self._hive.error(403, "forbidden", "the acting mind is not in this swarm")
            return agent, f"agent:{agent['id']}"
        if actor.get("kind") == "person" and actor.get("principal"):
            return {"id": None, "swarm_id": self.swarm_id}, actor["principal"]
        viewer = getattr(self, "viewer", None) or {}
        if not write and viewer.get("principal") and viewer.get("swarm_id") == self.swarm_id:
            return {"id": None, "swarm_id": self.swarm_id}, viewer["principal"]
        raise self._hive.error(403, "actor_required", "artifact access from an app runs as the mind or person acting in this swarm")

    def read_revision(self, artifact_id, n):
        """An exact artifact revision the acting mind may read (its swarm's, or one a live request exhibits)."""
        self._need("artifacts:read")
        return self._hive.collab.read_revision(self._acting()[0], str(artifact_id), int(n))

    def read_asset(self, sha256, artifact_id=None, revision=None):
        """Asset bytes the acting mind may read: its swarm's, or listed in a readable revision's manifest."""
        self._need("artifacts:read")
        agent, _ = self._acting()
        if not self._hive.assets.agent_may_read(agent, str(sha256), artifact_id, revision):
            raise self._hive.error(403, "forbidden", "this asset is not readable by the acting mind")
        row, data = self._hive.assets.read(str(sha256))
        return {"sha256": row["sha256"], "mime": row["mime"], "bytes": row["bytes"], "data": data}

    def publish(self, kind, title, body, assets=(), artifact_id=None, parent=None):
        """Store output atomically as the acting mind: assets (content-addressed, local-only) first, then the artifact
        and its revision in ONE database transaction, so a crash never leaves a revision without its record or a
        half-created artifact. A new revision of an existing artifact passes artifact_id and the expected parent."""
        self._need("artifacts:write")
        if self.read_only:
            raise self._hive.error(403, "read_only", "this check is read-only")
        agent, principal = self._acting(write=True)
        for a in assets or ():
            if not isinstance(a, dict) or not isinstance(a.get("data"), (bytes, bytearray)):
                raise self._hive.error(400, "bad_request", "each asset is {data: bytes, mime, name}")
        # Asset metadata commits with the artifact and revision or not at all; content-addressed bytes may stay behind.
        # Placement before the database, the order every asset write takes (OmegaReview 2026-10-05 B1).
        with self._hive.assets._placement, self._hive.db.transaction():
            stored = [self._hive.assets.put(bytes(a["data"]), a.get("mime"), principal, agent["swarm_id"],
                                            str(a.get("name") or ""), local_only=True) for a in assets or ()]
            art = self._hive.collab.artifact(artifact_id) if artifact_id else \
                self._hive.collab.create_artifact(agent, {"kind": kind, "title": title}, principal=principal)
            rev = self._hive.collab.add_revision(agent, art["id"], {"body": body, "parent": parent if artifact_id else None},
                                                 principal=principal)
        return {"artifact_id": art["id"], "revision": rev["n"], "digest": rev["digest"],
                "assets": [{k: s[k] for k in ("sha256", "mime", "bytes")} for s in stored]}

    async def sandbox_run(self, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools", **limits):
        """Run this app's own pinned tool bundle inside the OS sandbox (see hive/core/sandbox_run.py)."""
        self._need("sandbox:run")
        from . import sandbox_run
        try:
            return await sandbox_run.run(self._program, entry, args, inputs, outputs, runtime, bundle, **limits)
        except PermissionError as e:
            raise self._hive.error(403, "sandbox_not_allowed", str(e))
        except RuntimeError as e:
            raise self._hive.error(503, "sandbox_unavailable", str(e))
        except ValueError as e:
            raise self._hive.error(400, "sandbox_request", str(e))

    def _evolve(self, capability):
        self._need(capability)
        if self._program["id"] != "omegaevolve":
            raise PermissionError("OmegaEvolve registry is owned by its program")
        from .evolve import EvolveRegistry
        return EvolveRegistry(self._hive)

    def evolve_records(self, focus=None):
        return self._evolve("evolve:read").records(self.swarm_id, focus)

    def evolve_snapshot(self, focus=None):
        return self._evolve("evolve:read").snapshot(self.swarm_id, focus)

    def evolve_figures(self):
        """{record_id: [figure]} for this swarm's recorded reports that have figures (hive/core/evolve_figures.py)."""
        self._evolve("evolve:read")
        return self._hive.evolve_figures.for_swarm(self.swarm_id)

    def evolve_contribute(self, payload):
        return self._evolve("evolve:write").contribute(self.swarm_id, getattr(self, "actor", None), payload)

    def evolve_register(self, registration):
        return self._evolve("evolve:write").register(self.swarm_id, getattr(self, "actor", None), registration)

    def evolve_benchmark_register(self, registration):
        from omegabench.evolve_bridge import register
        return register(self._evolve("evolve:write"), self.swarm_id, getattr(self, "actor", None), registration)

    def evolve_benchmark_assess(self, benchmark_id, export):
        from omegabench.evolve_bridge import assess
        return assess(self._evolve("evolve:write"), self.swarm_id, getattr(self, "actor", None), benchmark_id, export)

    def evolve_benchmark_receipt(self, benchmark_id, export, packet):
        from omegabench.evolve_bridge import assess_receipt
        registry = self._evolve("evolve:write")
        verifier = getattr(self._hive, "benchmark_receipt_verifier", None)
        if verifier is None:
            raise PermissionError("benchmark evaluator trust is not configured by the host")
        return assess_receipt(registry, self.swarm_id, getattr(self, "actor", None),
                              benchmark_id, export, packet, verifier)

    def evolve_lab_receipt(self, experiment_id, run_id):
        return self._evolve("evolve:write").lab_receipt(self.swarm_id, getattr(self, "actor", None), experiment_id, run_id)

    def beliefs(self):
        self._need("commons:read")
        return self._hive.beliefs(self.swarm_id)

    def belief(self, statement):
        self._need("commons:read")
        try:
            return self._hive.belief(self.swarm_id, statement)
        except Exception as exc:  # unknown belief or bad statement
            if getattr(exc, "status", None) in (400, 404):
                return None
            raise

    def _person(self):
        """The person this call is for (the viewer of a view or read, the person acting), or None for a mind's call."""
        who = getattr(self, "viewer", None) or {}
        actor = getattr(self, "actor", None) or {}
        if actor.get("kind") == "person":
            who = actor
        if not who.get("principal"):
            return None
        from .visibility import Viewer
        return Viewer(who["principal"], who.get("role") == "admin")

    def agents(self):
        """The minds of this swarm, only those the person this call is for may see (r16.1: visibility holds at the
        mind-read boundary too, not only for names the host finds in the request; stand-in r16 #3)."""
        self._need("commons:read")
        person = self._person()
        rows = [a for a in self._hive.agents() if a["swarm_id"] == self.swarm_id]
        if person is not None:
            rows = self._hive.visibility.agents(person, rows)
        return [{"id": a["id"], "name": a["name"], "kind": a["kind"], "hue": a["hue"]} for a in rows]

    def mind(self, ref):
        """The host-authorized way for an app to resolve a mind it was asked about: ``ref`` is `mind:<id>`,
        `agent:<id>` (with any `:<part>` after it) or a bare id. Returns the mind as agents() shows it, or refuses
        404 not found, identically, when it is unknown, deleted, in another swarm or not visible to the person."""
        from .visibility import MIND_REF
        ref = str(ref or "")
        m = MIND_REF.match(ref)
        agent_id = m.group(1) if m else ref
        found = next((a for a in self.agents() if a["id"] == agent_id), None)
        if found is None:
            raise self._hive.error(404, "not_found", "no such mind")
        return found

    def goals(self):
        self._need("goals:read")
        return self._hive.goals.list(self.swarm_id)

    def goal(self, goal_id):
        self._need("goals:read")
        goal = self._hive.goals.view(self._hive.goals.get(goal_id))
        if goal["swarm_id"] != self.swarm_id:
            raise self._hive.error(403, "forbidden", "task is in another swarm")
        return goal

    async def create_goal(self, title, detail="", assignee=None, binding=None, priority=0.5, deadline_minutes=None):
        """Post a goal; with assignee only that mind may claim it, with binding its result must echo it,
        with deadline_minutes it fails (and its snapshot shares are revoked) when time runs out."""
        self._need("goals:write")
        return await self._hive.goals.create(self.swarm_id, title, detail, priority,
                                             created_by=f"program:{self._program['id']}",
                                             assignee=assignee, binding=binding, deadline_minutes=deadline_minutes)

    async def cancel_goal(self, goal_id):
        self._need("goals:write")
        goal = self.goal(goal_id) if "goals:read" in self._program["capabilities"] else \
            self._hive.goals.view(self._hive.goals.get(goal_id))
        if goal["swarm_id"] != self.swarm_id or goal["created_by"] != f"program:{self._program['id']}":
            raise self._hive.error(403, "forbidden", "a program can only cancel tasks it created")
        self._hive.goals.update(goal_id, {"status": "cancelled"})
        await self._hive.goals.notify_cancelled(goal_id)
        return self._hive.goals.view(self._hive.goals.get(goal_id))

    async def revoke_exhibit(self, exhibit_id):
        """Withdraw an exhibit this program created: every reader's share closes now."""
        self._need("exhibits:write")
        return await self._hive.shares.revoke_program_exhibit(self._program["id"], self.swarm_id, exhibit_id)

    async def bound_request(self, title, assignee, snapshot, binding, detail="", minutes=30, deadline_minutes=None,
                            priority=0.5):
        """Show a snapshot to one named mind and post the goal bound to it, as one step.

        snapshot = {title, body?, atoms?}; binding = the program's own fields (e.g. request_id,
        base_revision). The hive adds snapshot_digest and share_ids. If the goal cannot be posted, the
        exhibit is revoked before the error is raised, so no snapshot outlives a failed request.
        """
        self._need("exhibits:write")
        self._need("goals:write")
        shown = await self.exhibit(snapshot.get("title") or title, [assignee], minutes,
                                   snapshot.get("body", ""), snapshot.get("atoms"))
        full = dict(binding or {}, snapshot_digest=shown["digest"], share_ids=[s["id"] for s in shown["shares"]])
        try:
            goal = await self.create_goal(title, detail, assignee=assignee, binding=full, priority=priority,
                                          deadline_minutes=deadline_minutes)
        except Exception:
            await self.revoke_exhibit(shown["exhibit_id"])
            raise
        return {"goal": goal, "exhibit": shown, "binding": full}

    async def exhibit(self, title, to, minutes=30, body="", atoms=None):
        """Show a snapshot to named minds for a while; returns its content digest and share ids."""
        self._need("exhibits:write")
        return await self._hive.shares.program_exhibit(self._program["id"], self.swarm_id, title, to, minutes,
                                                       body, atoms)


READ_ID = re.compile(r"[\w.-]{1,64}")
READ_MAX_BYTES = 4 * 1024 * 1024          # one read's JSON answer (Surface G1)
MIME = re.compile(r"[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*")
FILE_MAX_BYTES = 20 * 1024 * 1024         # one file handed to an app action (Surface G2)


class Programs:
    def __init__(self, hive):
        self.hive = hive
        self.programs: dict[str, dict] = {}
        self.disabled: set[str] = set()
        self._authority_guard, self._authority_locks = threading.Lock(), {}
        # where each app last showed a view successfully: so opening an app lands where it works, not on whichever
        # swarm sorts first (the owner could not see inside apps, 2026-10-04)
        hive.db.execute("CREATE TABLE IF NOT EXISTS program_homes (program TEXT NOT NULL, swarm TEXT NOT NULL, "
                        "last_ok TEXT NOT NULL, PRIMARY KEY (program, swarm))")
        # Which person an app's own view admitted, where, and when; a refusal from the app removes it (OmegaReview
        # next8 B1). The host never runs a view just to find out: features such as drafts follow the app's last answer.
        hive.db.execute("CREATE TABLE IF NOT EXISTS app_admissions (principal TEXT NOT NULL, program TEXT NOT NULL, "
                        "swarm TEXT NOT NULL, admitted_at TEXT NOT NULL, PRIMARY KEY (principal, program, swarm))")
        # Disable and grant revocation are owner decisions that must survive a restart (Atlas, 2026-10-05): the
        # launcher mints grants at every start, so a revoked app's grant vars are dropped here, before any app runs.
        # Who owns an app's grants, and which vars they are, is snapshotted here too, from the launcher's environment
        # before any app module is loaded: apps can write the environment later, so authority never reads it again
        # (Kimi next8-r1).
        hive.db.execute("CREATE TABLE IF NOT EXISTS app_authority (program TEXT PRIMARY KEY, disabled INTEGER NOT NULL "
                        "DEFAULT 0, grants_revoked INTEGER NOT NULL DEFAULT 0, owner TEXT, grant_vars TEXT, by TEXT, "
                        "at TEXT, restored_at TEXT, restore_applied_at TEXT)")
        self._snapshot_grant_owners()
        from .db import now
        for r in hive.db.all("SELECT * FROM app_authority"):
            if r["disabled"]:
                self.disabled.add(r["program"])
            if r["grants_revoked"]:
                self._drop_grants(r["program"])
            elif r["restored_at"] and not r["restore_applied_at"]:
                hive.db.execute("UPDATE app_authority SET restore_applied_at = ? WHERE program = ?", (now(), r["program"]))
                hive.events.publish("app.grants_restore_applied", program=r["program"], restored_by=r["by"])
        self.reload()

    @staticmethod
    def _renewal_config(program_id):
        try:
            config = json.loads(os.environ.get("HIVE_APP_GRANT_RENEWAL") or "{}").get(program_id)
        except (ValueError, AttributeError):
            return None
        return config if isinstance(config, dict) else None

    def _snapshot_grant_owners(self):
        try:
            configs = json.loads(os.environ.get("HIVE_APP_GRANT_RENEWAL") or "{}")
        except ValueError:
            configs = {}
        for program_id, config in (configs.items() if isinstance(configs, dict) else []):
            owner, names = (config or {}).get("owner"), (config or {}).get("vars")
            if not (isinstance(owner, str) and owner.startswith("user:") and isinstance(names, list)
                    and names and all(isinstance(n, str) and n for n in names)):
                continue
            self.hive.db.execute("INSERT INTO app_authority (program, owner, grant_vars) VALUES (?, ?, ?) ON CONFLICT(program) "
                                 "DO UPDATE SET owner = excluded.owner, grant_vars = excluded.grant_vars",
                                 (program_id, owner, json.dumps(sorted(names))))

    def _authority_lock(self, program_id):
        """Per-app lock for grant writes (OmegaReview next8 R3): one process only; several processes need a shared fence."""
        with self._authority_guard:
            return self._authority_locks.setdefault(program_id, threading.RLock())

    def _authority(self, program_id):
        return self.hive.db.one("SELECT * FROM app_authority WHERE program = ?", (program_id,))

    def grant_owner(self, program_id):
        """The owner recorded from the launcher at this start, or None."""
        return (self._authority(program_id) or {}).get("owner")

    def _drop_grants(self, program_id):
        row = self._authority(program_id) or {}
        for name in json.loads(row["grant_vars"]) if row.get("grant_vars") else []:
            os.environ.pop(str(name), None)

    def _record_authority(self, program_id, column, value, by):
        from .db import now
        assert column in ("disabled", "grants_revoked")
        self.hive.db.execute(f"INSERT INTO app_authority (program, {column}, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(program) "
                             f"DO UPDATE SET {column} = excluded.{column}, by = excluded.by, at = excluded.at",
                             (program_id, int(value), by, now()))

    def admitted(self, principal, program_id, swarm_id, within_seconds=86400):
        """Did this app's own view admit this person in this swarm recently (default: a day, the grant lifetime)?"""
        row = self.hive.db.one("SELECT admitted_at FROM app_admissions WHERE principal = ? AND program = ? AND swarm = ?",
                               (principal, program_id, swarm_id))
        if not row:
            return False
        import datetime
        try:
            at = datetime.datetime.fromisoformat(str(row["admitted_at"]).replace("Z", "+00:00"))
        except ValueError:
            return False
        return (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds() <= within_seconds

    def grants_revoked(self, program_id):
        row = self._authority(program_id)
        return bool(row and row["grants_revoked"])

    def revoke_grants(self, program_id, viewer):
        """The owner (or the local operator, break-glass) revokes an app's grants: dropped now, dropped again at every
        start, and never renewed by the owner opening the app. Restoring is the owner's alone. The owner and the grant
        vars are the ones recorded from the launcher at start, never read from the live environment."""
        self.get(program_id)
        owner = self.grant_owner(program_id)
        if owner is None:
            raise self.hive.error(404, "no_grants", f"{program_id} has no host-managed grants")
        viewer, principal = viewer or {}, (viewer or {}).get("principal")
        if not (viewer.get("local_operator") or viewer.get("kind") == "person" and principal == owner):
            raise self.hive.error(403, "owner_required", "only the app's owner can revoke its grants")
        links = getattr(self.hive, "app_links", None)
        if links is not None:
            links.revoke_program(program_id)
        with self._authority_lock(program_id):          # never interleaves with a renewal's write
            self._record_authority(program_id, "grants_revoked", True, principal)
            self._drop_grants(program_id)
        self.hive.events.publish("app.grants_revoked", program=program_id, by=principal)
        return {"program": program_id, "grants_revoked": True}

    def restore_grants(self, program_id, viewer):
        self.get(program_id)
        owner = self.grant_owner(program_id)
        viewer, principal = viewer or {}, (viewer or {}).get("principal")
        if owner is None or viewer.get("kind") != "person" or viewer.get("local_operator") or principal != owner:
            raise self.hive.error(403, "owner_required", "only the app's owner can restore its grants")
        from .db import now
        self._record_authority(program_id, "grants_revoked", False, principal)
        self.hive.db.execute("UPDATE app_authority SET restored_at = ?, restore_applied_at = NULL WHERE program = ?",
                             (now(), program_id))
        self.hive.events.publish("app.grants_restored", program=program_id, by=principal)
        # the launcher mints fresh grants at the next start, which records restore_applied_at; nothing is recreated now
        return {"program": program_id, "grants_revoked": False, "takes_effect": "next restart"}

    def homes(self, program_id, visible):
        """The swarms this app works in, best first, limited to swarms the caller can see (``visible``: ids).
        Sources: the app's own ``home_swarms()`` hook (no arguments; returns swarm ids), the operator's
        HIVE_APP_HOMES, its activations, then where a view last succeeded."""
        entry = self._ready(program_id)
        out, seen = [], set()
        def add(swarm_id, why):
            if swarm_id in visible and swarm_id not in seen:
                seen.add(swarm_id); out.append({"swarm_id": swarm_id, "why": why})
        hook = getattr(entry["module"], "home_swarms", None)
        if callable(hook):
            try:
                for sid in hook() or []:
                    add(str(sid), "the app is set up here")
            except Exception:
                pass
        try:   # operator config: {"<app id>": ["s_..."]} for apps enrolled outside the hive (e.g. by their own env)
            configured = json.loads(os.environ.get("HIVE_APP_HOMES", "") or "{}").get(program_id, [])
        except (ValueError, AttributeError):
            configured = []
        for sid in configured if isinstance(configured, list) else []:
            add(str(sid), "the app is set up here")
        for r in self.hive.db.all("SELECT swarm FROM app_activations WHERE program = ? AND active = 1", (program_id,)):
            add(r["swarm"], "activated here")
        for r in self.hive.db.all("SELECT swarm FROM program_homes WHERE program = ? ORDER BY last_ok DESC", (program_id,)):
            add(r["swarm"], "opened here before")
        return out

    # ---- loading ------------------------------------------------------------------------------

    def _dirs(self):
        dirs = [(BUILTIN_DIR, "built-in")]
        for part in filter(None, os.environ.get("HIVE_PLUGIN_DIRS", "").split(os.pathsep)):
            dirs.append((pathlib.Path(part).expanduser(), "plugin-dir"))
        return dirs

    def _folders(self):
        for base, source in self._dirs():
            if not base.exists():
                continue
            candidates = [base] if (base / "plugin.json").exists() else sorted(p for p in base.iterdir() if p.is_dir())
            for folder in candidates:
                if (folder / "plugin.json").exists():
                    yield folder, source

    @staticmethod
    def _manifest_id(folder):
        try:
            return json.loads((folder / "plugin.json").read_text()).get("id", folder.name)
        except (OSError, ValueError, AttributeError):
            return folder.name

    def _discover(self):
        """{app id: [(folder, source), ...]} in discovery order, without running anything."""
        seen = {}
        for folder, source in self._folders():
            seen.setdefault(self._manifest_id(folder), []).append((folder, source))
        return seen

    def _person_authority(self, program_id, uninstall=False):
        swarms = getattr(self.hive, "person_swarms", None)
        return swarms.authority_change(program_id, uninstall=uninstall) if swarms is not None else contextlib.nullcontext()

    def _release_changed(self, program_id, entry):
        """A content-free host invalidation; never themes, memory or source paths."""
        links = getattr(self.hive, "app_links", None)
        if links is not None:
            links.revoke_program(program_id)
        events = getattr(self.hive, "events", None)
        if events is not None:
            digest = entry.get("digest") if entry and not entry.get("error") and program_id not in self.disabled else None
            events.publish("program.release_changed", program=program_id, digest=digest)

    def reload(self):
        before = {pid: (entry.get("digest"), entry.get("error")) for pid, entry in self.programs.items()}
        self._snapshot_pins()
        found = {}
        for pid, copies in self._discover().items():
            for folder, source in copies:          # an unpinned id found twice: the last one wins, as before pins
                entry = self._admit(pid, folder, source, len(copies))
                found[entry["id"]] = entry
        for pid in set(self.pins or {}) - set(found):
            found[pid] = self._missing(pid)
        with contextlib.ExitStack() as stack:
            for pid in sorted(set(self.programs) | set(found)):
                stack.enter_context(self._person_authority(pid, uninstall=pid not in found))
            self.programs = found
        after = {pid: (entry.get("digest"), entry.get("error")) for pid, entry in found.items()}
        for pid in sorted(set(before) | set(after)):
            if before.get(pid) != after.get(pid):
                self._release_changed(pid, found.get(pid))
        return self.list()

    @staticmethod
    def source_digest(folder, *, ui_lock_bytes=None):
        """Bind manifest, Python/MeTTa and the reviewed UI lock (not app data).

        ui_bundle separately verifies every UI byte against this pinned lock;
        replacing both a UI file and its lock must change the program digest.
        """
        return Programs._source_snapshot(folder, ui_lock_bytes=ui_lock_bytes)[0]

    @staticmethod
    def _source_snapshot(folder, *, ui_lock_bytes=None):
        """The existing digest together with the exact manifest bytes included in it.

        P8 metadata must not come from a second, potentially different manifest
        read, or from the mutable context entry exposed to program code.
        """
        h = hashlib.sha256()
        manifest_bytes = None
        skip = {"__pycache__", ".git", "node_modules", ".venv", "venv", "data", "store", "var"}
        files = [folder / "plugin.json"] + sorted(p for p in folder.rglob("*") if p.suffix in (".py", ".metta") and p.is_file()
                                                  and not (set(p.relative_to(folder).parts[:-1]) & skip))
        ui_lock = folder / "ui" / "bundle.lock.json"
        if ui_lock.is_file():
            files.append(ui_lock)
        for f in files:
            try:
                raw = ui_lock_bytes if f == ui_lock and ui_lock_bytes is not None else f.read_bytes()
                if f == folder / "plugin.json":
                    manifest_bytes = raw
                h.update(str(f.relative_to(folder)).encode() + b"\0" + raw + b"\0")
            except OSError:
                continue
        return "sha256:" + h.hexdigest(), manifest_bytes

    def scan(self):
        """What is on disk now, without loading anything: {id: {version, digest, path}}."""
        out = {}
        for folder, source in self._folders():
            try:
                manifest = json.loads((folder / "plugin.json").read_text())
            except (OSError, ValueError):
                continue
            pid = manifest.get("id", folder.name)
            out[pid] = {"id": pid, "version": str(manifest.get("version", "0")), "digest": self.source_digest(folder),
                        "path": str(folder), "source": source}
        return out

    def reload_one(self, program_id):
        """Reload just one app from its folder, in place; the others are untouched. The pins stay those of the last full
        reload: an app already running can write the environment, so it never re-reads HIVE_APP_PINS for itself."""
        previous = self.programs.get(program_id)
        before = (previous.get("digest"), previous.get("error")) if previous is not None else None
        copies = self._discover().get(program_id)
        if copies:
            entry = self._admit(program_id, *copies[0], len(copies))
        elif program_id in (self.pins or {}):
            entry = self._missing(program_id)
        else:
            if program_id in self.programs:
                with self._person_authority(program_id, uninstall=True):
                    self.programs.pop(program_id, None)
                self._release_changed(program_id, None)
            raise self.hive.error(404, "not_found", f"no app {program_id!r} on disk")
        with self._person_authority(program_id):
            self.programs[entry["id"]] = entry
        if before != (entry.get("digest"), entry.get("error")):
            self._release_changed(program_id, entry)
        return self.view_of(entry)

    # ---- release pins (HIVE_APP_PINS, plan 2026-10-05; Review's Purple disposition 2026-10-06) -------------------

    def _snapshot_pins(self):
        """Read once per full reload, before any app in it runs. None: the setting is not a JSON object (fail closed)."""
        try:
            pins = json.loads(os.environ.get("HIVE_APP_PINS") or "{}")
        except ValueError:
            pins = None
        self.pins = pins if isinstance(pins, dict) else None
        self.pins_required = os.environ.get("HIVE_APP_PINS_REQUIRED") == "1"

    def _admit(self, pid, folder, source, copies):
        """Load one discovered app, unless its pin refuses it; a refused app's code never runs."""
        return self._load(folder, folder / "plugin.json", source, refusal=self._pin_refusal(pid, folder, source, copies))

    def _missing(self, pid):
        return {"id": pid, "name": pid, "version": "0", "description": "", "icon": "spark", "capabilities": [],
                "source": "pinned", "path": None, "module": None, "digest": None,
                "error": "release_mismatch: not found at its pinned release"}

    def _pin_refusal(self, pid, folder, source, copies=1):
        """Why this app may not load (None: it may). Builtins are never required to be pinned."""
        if self.pins is None:
            return None if source == "built-in" else "pins_invalid: HIVE_APP_PINS is not a JSON object"
        if pid not in self.pins:                   # only an absent id is unpinned; a declared null or other value is checked
            return "unpinned: HIVE_APP_PINS_REQUIRED is on" if self.pins_required and source != "built-in" else None
        pin = self.pins[pid]
        if copies > 1:                             # never silently pick one copy (Review, Purple disposition)
            return f"duplicate_discovery: {pid} is pinned but found in {copies} places"
        if not isinstance(pin, dict):
            return self._pin_mismatch(pin, folder)
        renewal = self._renewal_config(pid) or {}  # Atlas: its renewal release and digest must agree with the pin
        r_release, r_digest = renewal.get("release"), renewal.get("digest")
        release = pin.get("release")
        if (isinstance(r_digest, str) and r_digest and r_digest != pin.get("digest")) or (
                isinstance(r_release, str) and r_release and not _within(release, r_release)):
            return "pin_conflict: HIVE_APP_PINS and HIVE_APP_GRANT_RENEWAL name different releases"
        return self._pin_mismatch(pin, folder)

    def _pin_mismatch(self, pin, folder):
        """What differs between a folder and its pin: the folder, its source digest, any pinned file, any pinned env
        value. Reasons name only files inside the release and env var names, never values or outside paths."""
        if not _valid_pin(pin):
            return ("release_mismatch: the pin is {release: absolute path, digest: sha256:<64 hex>, files?: {relpath: "
                    "<64 hex>}, env?: {VAR: non-empty string}}")
        release, digest, files, env = pin["release"], pin["digest"], pin.get("files", {}), pin.get("env", {})
        if folder.resolve() != pathlib.Path(release).resolve():
            return "release_mismatch: not loaded from its pinned release"
        if self.source_digest(folder) != digest:
            return "release_mismatch: source digest differs from the pin"
        for rel, want in files.items():
            p = folder / rel
            if pathlib.PurePath(rel).is_absolute() or ".." in pathlib.PurePath(rel).parts or p.is_symlink() or not p.is_file():
                return f"release_mismatch: pinned file {rel} is missing"
            if hashlib.sha256(p.read_bytes()).hexdigest() != want.removeprefix("sha256:"):
                return f"release_mismatch: file {rel} differs from its pin"
        for var, want in env.items():
            if os.environ.get(var) != want:
                return f"release_mismatch: environment {var} is not its pinned value"
        return None

    def _load(self, folder, manifest_path, source, refusal=None):
        digest, manifest_bytes = self._source_snapshot(folder)
        entry = {"id": folder.name, "name": folder.name, "version": "0", "description": "", "icon": "spark",
                 "capabilities": [], "source": source, "path": str(folder), "module": None, "error": None,
                 "digest": digest}
        try:
            manifest = json.loads(manifest_bytes)
            entry.update({k: manifest[k] for k in ("id", "name", "version", "description", "icon") if k in manifest})
            if refusal:                            # listed with its reason; nothing of it is imported
                entry["error"] = refusal
                return entry
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", entry["id"]):
                raise ValueError(f"bad program id {entry['id']!r}")
            caps = list(manifest.get("capabilities", []))
            unknown = set(caps) - CAPABILITIES
            if unknown:
                raise ValueError(f"unknown capabilities: {', '.join(sorted(unknown))}")
            entry["capabilities"] = caps
            from .app_links import parse_related_apps
            # P12: the declaration is reviewed with this exact manifest release.
            # Reject overbroad/malformed lists before importing any app code.
            entry["related_apps"] = parse_related_apps(manifest.get("related_apps"))
            from .person_swarms import parse_templates   # app platform P2: reviewed, digest-pinned swarm templates
            entry["swarm_templates"] = parse_templates(manifest.get("swarm_templates"))
            if entry["swarm_templates"] and "person_swarm" not in caps:
                raise ValueError("swarm_templates needs the person_swarm capability")
            from .person_apps import parse_placement   # P14: where the app lives and who may use it, digest-pinned
            entry["placement"], entry["person_allow"] = parse_placement(manifest)
            from .memory_theme import parse_memory_themes
            # P8 fails closed before importing app code; all named/dark branches
            # are part of plugin.json and therefore this release's source digest.
            entry["memory_themes"] = parse_memory_themes(manifest)
            entry["app"], entry["app_warnings"] = check_app(manifest.get("app"))
            module_path = folder / manifest.get("module", "program.py")
            spec = importlib.util.spec_from_file_location(f"hive_program_{entry['id'].replace('-', '_')}", module_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            for name in ("describe", "view", "act"):
                if not callable(getattr(module, name, None)):
                    raise ValueError(f"{module_path.name} has no {name}()")
            entry["module"] = module
            entry["describe"] = self._check_description(module.describe())
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
        return entry

    @staticmethod
    def _check_description(desc):
        kinds = desc.get("kinds") or []
        if not kinds:
            raise ValueError("describe() must list kinds")
        for kind in kinds:
            if kind.get("role") not in ROLES:
                raise ValueError(f"kind {kind.get('id')} has role {kind.get('role')!r}; use one of {sorted(ROLES)}")
        for rel in desc.get("relations") or []:
            if rel.get("polarity") not in POLARITIES:
                raise ValueError(f"relation {rel.get('id')} needs polarity support, oppose or neutral")
        reads = desc.get("reads") or []
        for r in reads:
            if not isinstance(r, dict) or not READ_ID.fullmatch(str(r.get("id", ""))):
                raise ValueError("each read is {id: 1-64 letters, digits, dots, dashes or underscores, label?}")
        actions = []
        for action in desc.get("actions") or []:
            accepts = action.get("accepts_file") if isinstance(action, dict) else None
            if accepts is not None:
                mimes, cap = (accepts or {}).get("mimes"), (accepts or {}).get("max_bytes")
                if (not isinstance(mimes, list) or not mimes or not all(isinstance(m, str) and MIME.fullmatch(m) for m in mimes)
                        or type(cap) is not int or not 1 <= cap <= FILE_MAX_BYTES):
                    raise ValueError(f"action {action.get('id')}: accepts_file is {{mimes: [type/subtype], "
                                     f"max_bytes: 1..{FILE_MAX_BYTES}}}")
                if action.get("person_activity") is not True:   # files always pass the full named-person intent gate
                    raise ValueError(f"action {action.get('id')}: accepts_file needs person_activity: true")
            if isinstance(action, dict):
                if "confirm" in action and type(action["confirm"]) is not bool:
                    raise ValueError(f"action {action.get('id')}: confirm is true or false")
                if action.get("confirm") is False and action.get("person_activity") is True:   # no opt-out
                    raise ValueError(f"action {action.get('id')}: a person_activity action is always confirmed; drop confirm: false")
                action = dict(action, confirm=confirms(action))   # the effective value, as the host's frame sees it
            actions.append(action)
        return {"contract": str(desc.get("contract", CONTRACT)), "kinds": kinds,
                "relations": desc.get("relations") or [], "actions": actions, "reads": reads}

    # ---- reading ------------------------------------------------------------------------------

    def view_of(self, entry, admin=False):
        """Admins see why a pinned app was refused; everyone else only its code (Kimi K2 on f254127)."""
        error = entry["error"]
        if error and not admin and error.split(":", 1)[0] in PIN_REFUSALS:
            error = error.split(":", 1)[0] + ": not its pinned release"
        return {"id": entry["id"], "name": entry["name"], "version": entry["version"],
                "description": entry["description"], "icon": entry["icon"], "capabilities": entry["capabilities"],
                "source": entry["source"], "enabled": entry["id"] not in self.disabled and not entry["error"],
                "error": error, "app": entry.get("app") or check_app(None)[0],
                "placement": entry.get("placement") or "swarm",   # P14: "person" opens in each person's own space
                "app_warnings": entry.get("app_warnings", []), "digest": entry.get("digest"),
                "ui": bool(entry.get("path")) and (pathlib.Path(entry["path"]) / "ui" / "bundle.lock.json").is_file()}

    UI_FILES = ("index.html", "app.js", "style.css")

    def _memory_release(self, entry):
        """Host-only display metadata from the same manifest bytes as its digest."""
        from .memory_theme import parse_memory_themes
        digest, manifest_bytes = self._source_snapshot(pathlib.Path(entry["path"]))
        if digest != entry["digest"] or manifest_bytes is None:
            raise self.hive.error(403, "app_integrity", f"{entry['id']}'s interface changed since loading")
        return {"digest": digest, **parse_memory_themes(json.loads(manifest_bytes))}

    def ui_bundle(self, program_id):
        """An app's own interface from its ui/ folder, each file checked against ui/bundle.lock.json. By default exactly
        index.html, app.js and style.css. r17 "app frame parts": the lock may list ``"scripts": [...]`` (rules in
        ui_parts). Still code-only, pinned, with the same isolated, tokenless srcdoc; no bridge or API data here.
        """
        entry = self._ready(program_id)
        # P8 captures display metadata from the exact manifest bytes included in
        # this loaded digest, rather than from a mutable program context entry.
        release = self._memory_release(entry)
        try:
            lock_bytes = (pathlib.Path(entry["path"]) / "ui" / "bundle.lock.json").read_bytes()
            captured_lock = json.loads(lock_bytes)
        except (OSError, ValueError):
            raise self.hive.error(404, "no_app_ui", f"{program_id} has no verified interface") from None
        # P1 binds the bytes actually returned, including an ABA file/lock swap,
        # to the SAME reviewed lock; memory metadata does not replace this check.
        if self.source_digest(pathlib.Path(entry["path"]), ui_lock_bytes=lock_bytes) != entry["digest"]:
            raise self.hive.error(403, "app_integrity", "the interface lock changed")
        if isinstance(captured_lock, dict) and "scripts" in captured_lock:
            bundle = self._ui_parts(program_id, entry["path"], captured_lock)
        else:
            from .sandbox_run import verify_bundle      # unchanged single-file contract (no "scripts" key)
            try:
                root = verify_bundle(entry["path"], "ui")
            except (ValueError, OSError) as exc:
                raise self.hive.error(404, "no_app_ui", f"{program_id} has no verified interface ({exc})")
            files = {}
            for name in self.UI_FILES:
                f = root / name
                if not f.is_file() or f.stat().st_size > 600_000:
                    raise self.hive.error(422, "bad_app_ui", f"{program_id}'s ui/ needs {', '.join(self.UI_FILES)} (each at most 600 KB)")
                files[name] = f.read_bytes().decode("utf-8")
            bundle = {"program": program_id, "files": files}
        bundle = self._ui_identity(program_id, entry, captured_lock, lock_bytes, bundle)
        # Retain P8's final current-release check as well as P1's captured-lock
        # check. A changed manifest/lock or a reloaded entry closes the overlay.
        if self._ready(program_id) is not entry or self.source_digest(pathlib.Path(entry["path"])) != release["digest"]:
            raise self.hive.error(403, "app_integrity", f"{program_id}'s interface changed while reading")
        # The pinned P1 identity, when present, adds version to P8's display-only
        # metadata. Both have already been bound to this entry's same digest.
        return dict(bundle, release={**release, **bundle.get("release", {})})
    def _ui_identity(self, program_id, entry, lock, lock_bytes, bundle):
        pinned = lock.get("files") if isinstance(lock, dict) else None
        # Parts mode is closed. Legacy single-file mode historically permits
        # extra pinned files that are verified but never served to the frame.
        if not isinstance(pinned, dict) or not set(bundle["files"]) <= set(pinned) or (
                "scripts" in lock and set(pinned) != set(bundle["files"])) or any(
                hashlib.sha256(text.encode("utf-8")).hexdigest() != pinned.get(name)
                for name, text in bundle["files"].items()):
            raise self.hive.error(403, "app_integrity", "the returned interface differs from its reviewed lock")
        fresh = self._ready(program_id)
        if fresh is not entry or self.source_digest(pathlib.Path(entry["path"]), ui_lock_bytes=lock_bytes) != entry["digest"]:
            raise self.hive.error(403, "app_integrity", "the interface release changed")
        release = self.pinned_release(program_id)
        if release is not None and (release["digest"] != entry["digest"] or release["version"] != entry["version"]):
            raise self.hive.error(403, "app_integrity", "the release identity changed during interface delivery")
        # Preserve the exact pre-P1 response shape for unpinned legacy apps.
        return {**bundle, "release": {"digest": release["digest"], "version": release["version"]}} if release else bundle


    @staticmethod
    def _parts_lock(app_path):
        """The lock, when it is a readable object with a "scripts" key inside the app's own ui/ folder; else None,
        and the single-file path (verify_bundle) decides."""
        app_dir = pathlib.Path(app_path).resolve()
        root = (app_dir / "ui").resolve()
        if app_dir not in root.parents or not root.is_dir():
            return None
        try:
            lock = json.loads((root / "bundle.lock.json").read_text())
        except (ValueError, OSError):
            return None
        return lock if isinstance(lock, dict) and "scripts" in lock else None

    def _ui_parts(self, program_id, app_path, lock):
        """The r17 declared-parts bundle. Every broken rule, pins and disk included, is 422 bad_app_ui with its
        reason; only bytes that differ from their pin keep the 404 no_app_ui of verify_bundle."""
        from . import ui_parts
        from .sandbox_run import verify_bundle

        def check(reason):
            if reason:
                raise self.hive.error(422, "bad_app_ui", f"{program_id}'s ui/: {reason}")
        check(ui_parts.lock_reason(lock))
        scripts, pinned = lock["scripts"], lock["files"]
        root = (pathlib.Path(app_path).resolve() / "ui").resolve()
        present = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() or p.is_symlink()} - {"bundle.lock.json"}
        check(ui_parts.disk_reason(present, pinned))
        try:
            root = verify_bundle(app_path, "ui")
        except (ValueError, OSError) as exc:
            raise self.hive.error(404, "no_app_ui", f"{program_id} has no verified interface ({exc})")
        names = ("index.html", *scripts, "style.css")
        check(ui_parts.size_reason({name: (root / name).stat().st_size for name in names}))
        files = {name: (root / name).read_bytes().decode("utf-8") for name in names}
        for name in scripts:
            check(ui_parts.part_reason(name, files[name]))
        check(ui_parts.html_reason(files["index.html"], scripts))
        return {"program": program_id, "files": files, "scripts": scripts}

    def list(self, admin=False):
        return [self.view_of(e, admin) for e in sorted(self.programs.values(), key=lambda e: e["name"])]

    def get(self, program_id):
        entry = self.programs.get(program_id)
        if entry is None:
            raise self.hive.error(404, "not_found", f"no program {program_id}")
        return entry

    @staticmethod
    def _captured_manifest_digest(folder):
        """P2 display uses P8's exact manifest-and-digest snapshot.

        Keep source_digest's public signature, input set and captured-lock path
        unchanged; never reconstruct the older pre-P8 digest implementation.
        """
        digest, raw = Programs._source_snapshot(folder)
        if raw is None or len(raw) > 1024 * 1024:
            raise ValueError("the pinned manifest is unavailable or too large")
        return raw, digest

    def _verified_person_swarm_manifest(self, program_id):
        """A host pin and its captured manifest, never mutable ctx._program data."""
        try:
            pin = (self.pins or {}).get(program_id)
            if not _valid_pin(pin):
                return None
            self._ready(program_id)   # disabled/refused releases expose no host trigger
            folder = pathlib.Path(pin["release"])
            if self._pin_mismatch(pin, folder):
                return None
            raw, digest = self._captured_manifest_digest(folder)
            if digest != pin["digest"]:
                return None
            manifest = json.loads(raw)
            if not isinstance(manifest, dict) or manifest.get("id", folder.name) != program_id:
                return None
            caps = manifest.get("capabilities")
            if not isinstance(caps, list) or "person_swarm" not in caps:
                return None
            from .person_swarms import parse_templates
            templates = parse_templates(manifest.get("swarm_templates"))
            name = manifest.get("name")
            return {"release_digest": digest, "program_name": name if isinstance(name, str) and name else program_id,
                    "templates": templates}
        except Exception:   # missing, malformed, unpinned or moving source fails closed
            return None

    def verified_release(self, program_id):
        """P14: the pinned release's own manifest, read and hashed in one capture (never mutable entry data): its digest,
        placement, audience and declared dependencies. None when the app is unpinned, refused, disabled or its source
        moved (fails closed). Install review records exactly this; opening a person app consumes it unchanged."""
        try:
            pin = (self.pins or {}).get(program_id)
            if not _valid_pin(pin):
                return None
            entry = self.get(program_id)       # disabled is the caller's own check: an admin reviews a disabled app
            folder = pathlib.Path(pin["release"])
            if entry.get("error") or entry.get("digest") != pin["digest"] or self._pin_mismatch(pin, folder):
                return None
            raw, digest = self._captured_manifest_digest(folder)
            if digest != pin["digest"]:
                return None
            manifest = json.loads(raw)
            if not isinstance(manifest, dict) or manifest.get("id", folder.name) != program_id:
                return None
            from .app_links import parse_related_apps
            from .person_apps import parse_placement
            from .person_swarms import parse_templates
            caps = manifest.get("capabilities", [])
            if not isinstance(caps, list) or set(caps) - CAPABILITIES:
                return None
            templates = parse_templates(manifest.get("swarm_templates"))
            placement, person_allow = parse_placement(manifest)
            return {"release_digest": digest, "placement": placement, "person_allow": person_allow,
                    "capabilities": sorted(caps), "related_apps": parse_related_apps(manifest.get("related_apps")),
                    "templates": {tid: t["digest"] for tid, t in sorted(templates.items())}}
        except Exception:   # missing, malformed, unpinned or moving source fails closed
            return None

    def _person_swarm_metadata(self, program_id):
        found = self._verified_person_swarm_manifest(program_id)
        if found is None:
            return None
        templates = found["templates"]
        return {"release_digest": found["release_digest"], "template_ids": sorted(templates),
                "template_digests": {tid: templates[tid]["digest"] for tid in sorted(templates)}}

    def verified_person_swarm_template(self, program_id, template_id):
        """The host card's display copy; this changes no ensure/current/sleep policy."""
        found = self._verified_person_swarm_manifest(program_id)
        if found is None or template_id not in found["templates"]:
            return None
        return {"program_name": found["program_name"], "template": found["templates"][template_id]}

    def detail(self, program_id, admin=False):
        entry = self.get(program_id)
        return self.view_of(entry, admin) | {"describe": entry.get("describe"),
                                           "person_swarm": self._person_swarm_metadata(program_id)}

    def set_enabled(self, program_id, enabled, by=None):
        self.get(program_id)
        links = getattr(self.hive, "app_links", None)
        if not enabled and links is not None:
            links.revoke_program(program_id)
        with self._person_authority(program_id):
            (self.disabled.discard if enabled else self.disabled.add)(program_id)
            self._record_authority(program_id, "disabled", not enabled, by)     # survives a restart
        out = self.view_of(self.get(program_id))
        self.hive.events.publish("program.updated", program=out)
        return out

    def uninstall(self, program_id, by=None):
        """Logical host uninstall: close the app, retain consent tombstones and minds.

        This removes no source files. A later reload/enable cannot reuse withdrawn
        person-swarm consent, even when the same release is installed again.
        """
        self.get(program_id)
        with self._person_authority(program_id, uninstall=True):
            self.disabled.add(program_id)
            self._record_authority(program_id, "disabled", True, by)
            self.programs.pop(program_id, None)
        self._release_changed(program_id, None)
        return {"program": program_id, "uninstalled": True, "deleted_minds": False}

    def _ready(self, program_id):
        entry = self.get(program_id)
        if entry["error"]:
            code = entry["error"].split(":", 1)[0]
            if code in PIN_REFUSALS:               # a host refusal, not a crash: closed until a reviewed release loads
                raise self.hive.error(403, code, f"{program_id} is not its pinned release; it stays closed")
            raise self.hive.error(500, "program_error", f"{program_id} failed to load: {entry['error']}")
        if program_id in self.disabled:
            raise self.hive.error(409, "program_disabled", f"{program_id} is disabled")
        self.check_integrity(entry)        # every entry: view, act, result validation, UI bundle (Kimi 2026-10-05)
        return entry

    def pinned_release(self, program_id):
        """Public identity for an admitted pinned app; no second discovery path.

        Root adapter prototype of Platform's agreed accessor. _ready checks
        disabled/errors and revalidates the existing HIVE_APP_PINS binding.
        Unpinned apps never supply a trusted Tools package.
        """
        from .hive import HiveError
        try:
            entry = self._ready(program_id)
        except HiveError:
            return None
        pin = (self.pins or {}).get(program_id)
        if not isinstance(pin, dict):
            return None
        return {"path": entry["path"], "digest": pin["digest"], "version": entry["version"],
                "files": dict(pin.get("files", {}))}

    def link_manifest(self, program_id):
        """Host-only link display metadata from the pinned, hashed manifest.

        This is not target readiness, consent, or activation. A future dispatcher
        must first consume a genuine generation-bound host activation and enforce
        the caller's declaration before looking up any target. No route or frame
        handler is installed by this accessor.
        """
        from .app_links import parse_related_apps
        entry = self._ready(program_id)
        release = self.pinned_release(program_id)
        if not release or release.get("digest") != entry.get("digest"):
            raise self.hive.error(403, "app_integrity", "the app has no current pinned link metadata")
        digest, raw = self._source_snapshot(pathlib.Path(entry["path"]))
        if digest != release["digest"] or raw is None:
            raise self.hive.error(403, "app_integrity", "the app's link metadata changed")
        manifest = json.loads(raw)
        if not isinstance(manifest, dict):
            raise self.hive.error(403, "app_integrity", "the app's link metadata is invalid")
        name = manifest.get("name", program_id)
        if manifest.get("id", pathlib.Path(entry["path"]).name) != program_id \
                or manifest.get("version", "0") != release["version"] \
                or not isinstance(name, str) or not 0 < len(name) <= 120:
            raise self.hive.error(403, "app_integrity", "the app's link identity changed")
        related = parse_related_apps(manifest.get("related_apps"))
        if self._ready(program_id) is not entry or entry.get("digest") != digest:
            raise self.hive.error(403, "app_integrity", "the app's link release changed")
        from .person_swarms import parse_templates
        return {"id": program_id, "name": name, "version": manifest.get("version", "0"), "release_digest": digest,
                "related_apps": related, "capabilities": list(manifest.get("capabilities", [])),
                "swarm_templates": parse_templates(manifest.get("swarm_templates"))}

    def check_integrity(self, entry, seen_by=None):
        """An app whose grant renewal is configured opens only from its reviewed release with its reviewed source
        digest; otherwise it stays closed (403 app_integrity), whoever is looking, and the refusal is published.
        A pinned app (HIVE_APP_PINS) is rechecked against its whole pin here too; a mismatch marks it errored until the
        next reload (403 release_mismatch)."""
        pins = getattr(self, "pins", None) or {}
        if entry["id"] in pins and entry.get("path"):
            reason = self._pin_mismatch(pins[entry["id"]], pathlib.Path(entry["path"]))
            if reason:
                entry["error"] = reason
                self.hive.events.publish("app.release_refused", program=entry["id"], by=seen_by, reason=reason)
                raise self.hive.error(403, "release_mismatch", f"{entry['id']} is not its pinned release; it stays closed")
        try:
            config = json.loads(os.environ.get("HIVE_APP_GRANT_RENEWAL") or "{}").get(entry["id"])
        except (ValueError, AttributeError):
            return
        if not isinstance(config, dict):
            return
        release, digest = config.get("release"), config.get("digest")
        reason = None
        if isinstance(release, str) and release and not str(entry.get("path") or "").startswith(release.rstrip("/") + "/"):
            reason = "app not loaded from the reviewed release"
        elif isinstance(digest, str) and digest and entry.get("digest") != digest:
            reason = "app source differs from the reviewed release"
        if reason:
            self.hive.events.publish("app.grants_refused", program=entry["id"], by=seen_by, reason=reason)
            raise self.hive.error(403, "app_integrity", f"{entry['id']} is not its reviewed release; it stays closed")

    # ---- running ------------------------------------------------------------------------------

    async def _call(self, entry, fn, *args):
        """Run a program function, sync or async; any exception that is not a hive error becomes a clean
        500 program_error, including ones raised after an await inside an async program."""
        try:
            value = fn(*args)
            if hasattr(value, "__await__"):
                value = await value
            return value
        except PermissionError as exc:
            # A program refusing this swarm or request (e.g. not enrolled) is a refusal, not a crash.
            raise self.hive.error(403, "program_refused", f"{entry['name']}: {str(exc)[:300] or 'refused'}") from exc
        except Exception as exc:
            if getattr(exc, "status", None):
                raise
            tail = traceback.format_exc().strip().splitlines()[-4:]
            raise self.hive.error(500, "program_error", f"{entry['id']}: " + " | ".join(tail)) from exc

    def renew_grants(self, entry, viewer, swarm_id):
        """Renew an app's short-lived read grants when its configured owner opens it (Atlas, 2026-10-05).

        HIVE_APP_GRANT_RENEWAL = {"<app>": {"owner": "user:<person>", "release": "<dir>", "digest": "<source digest>",
        "swarms": [...], "scope": {field: exact value}, "fields": {var: [exact keys]}, "vars": [...], "ttl": s}}. All or
        nothing, and only the expiry changes. Every listed var must be present (the authorization is a bundle); every
        item must have exactly its reviewed keys; and every scope field in that shape must equal the reviewed value:
        - the viewer is exactly the owner, a person (never the local operator or a mind);
        - the app loaded from that release directory AND its source digest is the reviewed one;
        - the view is in one of the app's enrolled swarms;
        - every grant item is read-only and, where it names a principal, names the owner. A grant with no principal or
          operations key (Atlas's synthetic grant) is scope-locked by the app itself, so these checks pass vacuously.
        An app whose renewal is configured but whose code is not the reviewed release does not open at all (fail closed,
        Kimi 2026-10-05), whoever is looking. A var that is absent was revoked and is never recreated. Any failed check renews nothing and is published as
        app.grants_refused; a renewal is published as app.grants_renewed. Renewal runs before the app's own view so an
        expired grant can be reissued to its owner, which is Atlas's decision (expiry is not revocation).
        Known limit: grants and this config live in the process environment, which every loaded app can read AND write.
        So this guards against mistakes and stale or revoked grants, not against a hostile app in the same process;
        that boundary is code review of every mounted app."""
        try:
            config = json.loads(os.environ.get("HIVE_APP_GRANT_RENEWAL") or "{}").get(entry["id"])
        except (ValueError, AttributeError):
            return
        if not isinstance(config, dict):
            return
        owner = config.get("owner")
        seen_by = (viewer or {}).get("principal") if isinstance(viewer, dict) else None

        def refuse(reason):
            self.hive.events.publish("app.grants_refused", program=entry["id"], by=seen_by, reason=reason)

        release, digest, swarms = config.get("release"), config.get("digest"), config.get("swarms")
        # Integrity first, whoever is looking: a swapped release is a property of the deployment (Kimi round 3).
        self.check_integrity(entry, seen_by)
        if not isinstance(viewer, dict) or viewer.get("kind") != "person" or viewer.get("local_operator") \
                or viewer.get("principal") != owner:
            return                                          # not the owner: nothing to renew
        if self.grants_revoked(entry["id"]):
            return refuse("grants revoked by the owner")
        if owner != self.grant_owner(entry["id"]):
            return refuse("renewal owner differs from the owner recorded at start")
        names, ttl = config.get("vars"), config.get("ttl", 86000)
        if (not isinstance(owner, str) or not owner.startswith("user:") or not isinstance(release, str) or not release
                or not isinstance(digest, str) or not digest or not isinstance(swarms, list)
                or not isinstance(names, list) or not names or not isinstance(ttl, int) or not 60 <= ttl <= 86000):
            return refuse("renewal configuration incomplete")
        if swarm_id not in swarms:
            return refuse("not one of the app's enrolled swarms")
        scope, fields = config.get("scope"), config.get("fields")
        if not isinstance(scope, dict) or not scope or not all(isinstance(v, str) and v for v in scope.values()):
            return refuse("renewal scope not configured")
        if not isinstance(fields, dict) or set(fields) != {str(n) for n in names} or not all(
                isinstance(f, list) and "expires_at" in f and all(isinstance(k, str) for k in f) for f in fields.values()):
            return refuse("renewal grant shapes not configured")
        import time as _time
        planned = {}
        missing = [str(n) for n in names if not os.environ.get(str(n))]
        if missing:                                         # the authorization is a bundle: one revoked part stops it all
            return refuse("every grant is revoked" if len(missing) == len(names) else "grant bundle incomplete: " + ", ".join(missing))
        for name in names:
            raw = os.environ.get(str(name))
            try:
                value = json.loads(raw)
            except ValueError:
                return refuse(f"{name} is not JSON")
            items = value if isinstance(value, list) else [value]
            if not items or not all(isinstance(i, dict) and isinstance(i.get("expires_at"), (int, float))
                                    and not isinstance(i.get("expires_at"), bool) for i in items):
                return refuse(f"{name} has an item without an expiry")
            if any("operations" in i and i["operations"] != ["read"] for i in items):
                return refuse(f"{name} is not read-only")
            if any("principal" in i and i["principal"] != owner for i in items):
                return refuse(f"{name} names another principal")
            # Exact shape (the app's own key set) and exact scope: a missing, extra or different field refuses.
            shape = set(fields[str(name)])
            if any(set(i) != shape for i in items):
                return refuse(f"{name} does not have the reviewed shape")
            if any(i[k] != v for i in items for k, v in scope.items() if k in shape):
                return refuse(f"{name} is outside the reviewed scope")
            planned[str(name)] = value
        until = int(_time.time()) + ttl
        with self._authority_lock(entry["id"]):         # a revoke that landed during the checks above wins
            if self.grants_revoked(entry["id"]):
                return refuse("grants revoked by the owner")
            for name, value in planned.items():             # every check passed: apply all together
                for i in (value if isinstance(value, list) else [value]):
                    i["expires_at"] = until
                os.environ[name] = json.dumps(value, separators=(",", ":"))
        self.hive.events.publish("app.grants_renewed", program=entry["id"], by=owner, grants=sorted(planned))

    async def view(self, program_id, swarm_id, focus=None, stage=None, viewer=None, untrusted_intent=None):
        if untrusted_intent is not None and (not isinstance(untrusted_intent, str) or len(untrusted_intent) > 200):
            raise self.hive.error(400, "bad_request", "invalid view intent")
        entry = self._ready(program_id)
        self.renew_grants(entry, viewer, swarm_id)
        stage = stage if stage in STAGES else "unfold"
        ctx = ProgramContext(self.hive, swarm_id, entry)
        ctx.viewer = dict(viewer) if viewer else None
        # P13: a separate read-only view input. Never focus, actor, params or rule input.
        from types import MappingProxyType
        ctx.view_input = MappingProxyType({"untrusted_intent": untrusted_intent}) if untrusted_intent is not None else MappingProxyType({})
        out = await self._admitting(entry, swarm_id, viewer, lambda graph: self.validate(entry, graph, stage),
                                    entry["module"].view, ctx, focus or None, stage)
        from .db import now
        self.hive.db.execute("INSERT INTO program_homes (program, swarm, last_ok) VALUES (?, ?, ?) "
                             "ON CONFLICT(program, swarm) DO UPDATE SET last_ok = excluded.last_ok", (program_id, swarm_id, now()))
        return out

    async def _admitting(self, entry, swarm_id, viewer, check, fn, *args):
        """Run a person-facing app function and keep the record of the app's own answer: a deliverable answer (one that
        passes ``check``) admits this person here, the app's refusal (program_refused) withdraws it (OmegaReview next8
        B1). An answer that fails its check admits nothing (Kimi next9 #2, #5)."""
        principal = (viewer or {}).get("principal") if isinstance(viewer, dict) else None
        try:
            out = check(await self._call(entry, fn, *args))
        except Exception as exc:
            if getattr(exc, "code", None) == "program_refused" and principal:
                self.hive.db.execute("DELETE FROM app_admissions WHERE principal = ? AND program = ? AND swarm = ?",
                                     (principal, entry["id"], swarm_id))
            raise
        if principal:
            from .db import now
            self.hive.db.execute("INSERT INTO app_admissions (principal, program, swarm, admitted_at) VALUES (?, ?, ?, ?) "
                                 "ON CONFLICT(principal, program, swarm) DO UPDATE SET admitted_at = excluded.admitted_at",
                                 (principal, entry["id"], swarm_id, now()))
        return out

    async def read(self, program_id, swarm_id, query, params=None, viewer=None):
        """A named, read-only query an app declares in describe().reads and answers with its read(ctx, query, params)
        hook: JSON that is not a work graph (a map with layout, a long timeline). The person is the viewer, exactly as
        for view; the answer is bounded and never stored by the hive (Surface G1, 2026-10-05)."""
        entry = self._ready(program_id)
        hook = getattr(entry["module"], "read", None)
        declared = {r["id"] for r in entry["describe"].get("reads") or []}
        if not callable(hook) or query not in declared:
            raise self.hive.error(404, "unknown_read", f"{program_id} does not declare the read {query!r}")
        if params is not None and not isinstance(params, dict):
            raise self.hive.error(400, "bad_request", "read params are a JSON object")
        self.renew_grants(entry, viewer, swarm_id)
        ctx = ProgramContext(self.hive, swarm_id, entry)
        ctx.viewer = dict(viewer) if viewer else None
        ctx.read_only = True        # a read writes nothing through the hive (OmegaReview next9 B1)
        def deliverable(out):
            if not isinstance(out, dict):
                raise self.hive.error(500, "bad_result", f"{program_id}'s read {query!r} must return a JSON object")
            try:
                # strict JSON, exactly what the response can carry: NaN and infinities are undeliverable (B3)
                size = len(json.dumps(out, separators=(",", ":"), allow_nan=False).encode())
            except (TypeError, ValueError):
                raise self.hive.error(500, "bad_result", f"{program_id}'s read {query!r} did not return JSON")
            if size > READ_MAX_BYTES:
                raise self.hive.error(413, "read_too_large", f"{program_id}'s read {query!r} is over {READ_MAX_BYTES // 1048576} MB")
            return out
        out = await self._admitting(entry, swarm_id, viewer, deliverable, hook, ctx, query, dict(params or {}))
        return {"program": program_id, "query": query, "result": out}

    async def act(self, program_id, swarm_id, action, items, params=None, base_revision=None, actor=None, command=None,
                  file=None, read_only=False, *, _on_person_swarm_consent_required=None):
        from .app_links import contains_untrusted_intent
        if contains_untrusted_intent(params):
            raise self.hive.error(400, "bad_request", "view input cannot enter an action")
        actor_snapshot = dict(actor) if isinstance(actor, dict) else None
        command_snapshot = dict(command) if isinstance(command, dict) else None
        if actor_snapshot and actor_snapshot.get("kind") == "mind" and actor_snapshot.get("id"):
            self.hive.person_swarms.require_current(actor_snapshot["id"])
        entry = self._ready(program_id)
        known = {a["id"] for a in entry["describe"]["actions"]}
        if action not in known:
            raise self.hive.error(400, "bad_request", f"{program_id} has no action {action!r}")
        ctx = ProgramContext(self.hive, swarm_id, entry)
        ctx.actor = dict(actor_snapshot) if actor_snapshot else None
        ctx.command = dict(command_snapshot) if command_snapshot else None
        ctx.file = dict(file) if file else None             # {name, mime, size, sha256, bytes}; never stored by the hive
        ctx.read_only = bool(read_only)   # r15: an action declared effect "read" can write nothing through the hive
        params = dict(params or {}, base_revision=base_revision)
        call = _PersonSwarmAct(ctx, self.hive, program_id, swarm_id, action, actor_snapshot,
                               command_snapshot, list(items or []), read_only, entry.get("capabilities") or (),
                               on_consent_required=_on_person_swarm_consent_required)
        token = _PERSON_SWARM_ACT.set(call)
        try:
            if actor_snapshot and actor_snapshot.get("kind") == "mind" and actor_snapshot.get("id"):
                self.hive.person_swarms.require_current(actor_snapshot["id"])
            out = await self._call(entry, entry["module"].act, ctx, action, list(items or []), params)
            return validate_result(entry["id"], entry["describe"], out,
                                   lambda m: self.hive.error(400, "bad_result", f"{entry['id']}: {m}"))
        finally:
            call.active = False
            _PERSON_SWARM_ACT.reset(token)

    def finding_validator(self, program_id):
        """r2.10: the program's validate_finding_target hook, or None (unknown, failed, disabled or no hook)."""
        try:
            entry = self._ready(program_id)
        except Exception:
            return None
        fn = getattr(entry["module"], "validate_finding_target", None)
        return (entry, fn) if callable(fn) else None

    async def validate_finding_target(self, program_id, agent, revision, target):
        """Run the chosen program's validate_finding_target(ctx, artifact_revision, target) as that program, with the
        reviewing mind as a read-only ctx.actor. Returns {"ok": True} or {"ok": False, "reason"}; a timeout or any
        failure is {"ok": False, "reason": "validator_unavailable"}, never an acceptance."""
        found = self.finding_validator(program_id)
        if found is None:
            return {"ok": False, "reason": "validator_unavailable"}
        entry, fn = found
        try:
            from .program_actions import ProgramActions
            ctx = ProgramContext(self.hive, agent["swarm_id"], entry)
            ctx.actor = ProgramActions.mind_actor(agent)
            ctx.read_only = True
            out = await asyncio.wait_for(self._call(entry, fn, ctx, dict(revision), dict(target)), FINDING_HOOK_TIMEOUT)
        except Exception:   # includes TimeoutError and hive errors: unavailable is a refusal, recorded by the caller
            return {"ok": False, "reason": "validator_unavailable"}
        if not isinstance(out, dict) or out.get("ok") not in (True, False):
            return {"ok": False, "reason": "validator_unavailable"}
        if out["ok"] is True:
            return {"ok": True}
        return {"ok": False, "reason": str(out.get("reason") or "refused")[:300]}

    async def validate_goal_result(self, program_id, goal, proposal):
        """R17: an app's own rule check of a mind's result, before the goal can be done. Returns a list of problems.
        The app gets the goal as the hive holds it (binding, request) and the raw proposal; it returns {"ok": true} or
        {"errors": [...]}. An app without validate_result refuses completion rather than waving results through."""
        entry = self._ready(program_id)
        fn = getattr(entry["module"], "validate_result", None)
        if not callable(fn):
            return [f"$: {program_id} cannot check results (it has no validate_result)"]
        ctx = ProgramContext(self.hive, goal["swarm_id"], entry)
        binding = goal.get("binding") or {}
        # Only a real cross-swarm request (the hive wrote from_swarm) has a host record; an app's own request ids
        # (Truth's bound requests) are the app's to resolve, so their absence here is never an error (found by OmegaTruth).
        req = None
        if binding.get("request_id") and binding.get("from_swarm"):
            req = self.hive.db.one("SELECT * FROM requests WHERE id = ?", (binding["request_id"],))
        ctx.validation = {"goal": goal, "request": self.hive.collab.request_view(req) if req else None,
                          "request_state": self.hive.collab.request_view(req).get("state") if req else None,
                          "requester_swarm": binding.get("from_swarm"), "deadline": goal.get("deadline_at"),
                          "attempts_so_far": len(self.hive.goals.attempts(goal["id"]))}
        ctx.validation_context = lambda _goal=None: ctx.validation   # the method form OmegaMatch codes against

        # The real request supplies scope; neither a producer nor an app chooses another swarm.
        if req is not None:
            if req["receiving_goal"] != goal["id"] or req["to_swarm"] != goal["swarm_id"] or req["from_swarm"] != binding.get("from_swarm"):
                return ["$: request binding does not match this goal"]
            requester = req["from_swarm"]
            ctx.viewer_for_requester = self.hive.collab.requester_viewer(requester)

            def catalogue(scope):
                if scope != requester:
                    raise self.hive.error(403, "requester_scope_mismatch", "catalogue scope must match the request")
                return self.hive.collab.capability_catalogue(requester)
            ctx.catalogue = catalogue

        def artifact_revision(artifact_id, n):
            """The hive's own record of an artifact revision the goal's swarm may read (Design checks a proposal against
            what was actually stored, never against the worker's claim). None if absent or not readable."""
            art = self.hive.db.one("SELECT * FROM artifacts WHERE id = ?", (str(artifact_id),))
            if art is None:
                return None
            readable = art["owner_swarm"] == goal["swarm_id"] or (req is not None and art["owner_swarm"] in (binding.get("from_swarm"), req["to_swarm"]))
            if not readable:
                return None
            rev = self.hive.db.one("SELECT * FROM artifact_revisions WHERE artifact_id = ? AND n = ?", (art["id"], int(n)))
            if rev is None:
                return None
            return {"artifact_id": art["id"], "kind": art["kind"], "owner_swarm": art["owner_swarm"], "created_by": art["created_by"],
                    "revision": rev["n"], "digest": rev["digest"], "parent": rev.get("parent"), "author": rev.get("author") or rev.get("created_by"),
                    "body": rev["body"], "created_at": rev["created_at"]}
        ctx.artifact_revision = artifact_revision
        # Explicit artifact/revision because a planning request has no artifact subject.
        read_guards = []
        def findings(request_id, artifact_id, revision):
            read = lambda: self.hive.collab.planning_review_context(goal, request_id, artifact_id, revision)
            projection = read()
            if projection is not None:
                encoded = json.dumps(projection, sort_keys=True, separators=(",", ":"))
                read_guards.append(lambda: json.dumps(read(), sort_keys=True, separators=(",", ":")) == encoded)
            return projection
        ctx.findings = findings
        out = fn(ctx, goal, proposal)
        if hasattr(out, "__await__"):   # r2.9: an app's validator may be async (it may call ctx.sandbox_run)
            out = await out
        if not isinstance(out, dict):
            return [f"$: {program_id} returned an unreadable check result"]
        if out.get("ok") is True and not out.get("errors"):
            return ValidationCheck([], read_guards)
        errors = [str(e)[:300] for e in (out.get("errors") or [])][:12]
        return errors or [f"$: {program_id} did not accept the result"]

    def validate(self, entry, graph, stage):
        return validate_graph(entry["id"], entry["describe"], graph, stage,
                              lambda message: self.hive.error(400, "bad_graph", f"{entry['id']}: {message}"))


def confirms(action):
    """An act on this action needs a host confirm token: it opts in with confirm: true, or it is person_activity."""
    return isinstance(action, dict) and (action.get("confirm") is True or action.get("person_activity") is True)


_HEX64 = re.compile(r"(sha256:)?[0-9a-f]{64}")


def _valid_pin(pin):
    """A present pin is exactly well formed: an omitted files/env means no such check, but a present one that is not
    a mapping of non-empty names to non-empty values (null, false, [], "", a short hash) refuses (Review B1 on ca07d66)."""
    if not isinstance(pin, dict) or set(pin) - {"release", "digest", "files", "env"}:
        return False
    release, digest, files, env = pin.get("release"), pin.get("digest"), pin.get("files", {}), pin.get("env", {})
    return (_normal_abs(release) and isinstance(digest, str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None
            and isinstance(files, dict) and all(isinstance(k, str) and k and isinstance(v, str) and _HEX64.fullmatch(v)
                                                for k, v in files.items())
            and isinstance(env, dict) and all(isinstance(k, str) and k and isinstance(v, str) and v for k, v in env.items()))


def _normal_abs(path):
    """An absolute path already in normal form: no '..' or '.', no doubled or trailing slash (Kimi K4 on f254127)."""
    return isinstance(path, str) and os.path.isabs(path) and os.path.normpath(path) == path and path.count("//") == 0


def _within(path, root):
    """Both normal absolute paths, and path resolves to root or inside it."""
    return _normal_abs(path) and _normal_abs(root) and pathlib.Path(path).resolve().is_relative_to(pathlib.Path(root).resolve())


def _unit(value):
    try:
        return 0.0 <= float(value) <= 1.0
    except (TypeError, ValueError):
        return False


def check_uncertainty(u):
    """Uncertainty is optional and labelled with its method; it is never converted into another calculus."""
    if not isinstance(u, dict) or not str(u.get("method", "")).strip():
        return "uncertainty needs a method (e.g. nal, pln, qualitative)"
    method = u["method"]
    if method == "nal" and not (_unit(u.get("f")) and _unit(u.get("c"))):
        return "nal uncertainty needs f and c in [0, 1]"
    if method == "pln" and not (_unit(u.get("strength")) and _unit(u.get("confidence"))):
        return "pln uncertainty needs strength and confidence in [0, 1]"
    if method == "qualitative" and not str(u.get("status", "")).strip():
        return "qualitative uncertainty needs a status"
    return None


def validate_graph(program_id, describe, graph, stage, fail):
    """Check a work graph against contract 0.1; raises fail(message) on the first problem."""
    def bad(message):
        raise fail(message)

    if not isinstance(graph, dict):
        bad("view() must return a dict")
    if not str(graph.get("revision", "")).strip():
        bad("a work graph needs a revision (any string that changes when the content changes)")
    items, links, groups = graph.get("items") or [], graph.get("links") or [], graph.get("groups") or []
    if len(items) > MAX_ITEMS or len(links) > MAX_LINKS:
        bad(f"a view holds at most {MAX_ITEMS} items and {MAX_LINKS} links "
            f"(got {len(items)} and {len(links)}); narrow the view instead of cutting it")
    kinds = {k["id"] for k in describe["kinds"]}
    rels = {r["id"] for r in describe["relations"]}
    ids = set()
    for item in items:
        if not item.get("id") or item["id"] in ids:
            bad(f"item ids must be present and unique ({item.get('id')!r})")
        ids.add(item["id"])
        if item.get("kind") not in kinds:
            bad(f"item {item['id']} has unknown kind {item.get('kind')!r}")
        if item.get("uncertainty") is not None:
            problem = check_uncertainty(item["uncertainty"])
            if problem:
                bad(f"item {item['id']}: {problem}")
        status = item.setdefault("status", "current")
        if status not in ITEM_STATUSES:
            bad(f"item {item['id']} has status {status!r}; use one of {sorted(ITEM_STATUSES)}")
        for source in item.setdefault("sources", []):
            if not source.get("id") or not source.get("label"):
                bad(f"item {item['id']} has a source without id or label")
            if source.get("status", "cited") not in SOURCE_STATUSES:
                bad(f"source {source['id']} has status {source.get('status')!r}; use one of {sorted(SOURCE_STATUSES)}")
        item.setdefault("label", item["id"])
        item.setdefault("flags", [])
        proposal = item.get("proposal")
        if proposal is not None:
            if not isinstance(proposal, dict) or proposal.get("transport") not in TRANSPORT \
                    or proposal.get("review") not in REVIEW:
                bad(f"item {item['id']}: proposal needs transport in {sorted(TRANSPORT)} "
                    f"and review in {sorted(REVIEW)}")
    link_ids = set()
    for link in links:
        if link.get("from") not in ids or link.get("to") not in ids:
            bad(f"link {link.get('from')} -> {link.get('to')} points outside the graph")
        if link.get("rel") not in rels:
            bad(f"link uses unknown relation {link.get('rel')!r}")
        link.setdefault("id", f"{link['from']}|{link['rel']}|{link['to']}")
        if link["id"] in link_ids:
            bad(f"link ids must be unique ({link['id']!r})")
        link_ids.add(link["id"])
    for group in groups:
        missing = [i for i in group.get("items", []) if i not in ids]
        if missing:
            bad(f"group {group.get('id')} names items not in the graph: {missing[:3]}")
    if graph.get("focus") and graph["focus"] not in ids:
        bad(f"focus {graph['focus']!r} is not an item")
    selected = [i for i in (graph.get("selected") or []) if i in ids]
    return {"contract": CONTRACT, "program": program_id, "revision": str(graph["revision"]), "stage": stage,
            "focus": graph.get("focus"), "selected": selected, "title": graph.get("title") or program_id,
            "suggested_stage": graph.get("suggested_stage") if graph.get("suggested_stage") in STAGES else None,
            "items": items, "links": links, "groups": groups, "notes": list(graph.get("notes") or [])}


RECEIPT_STATES = {"committed", "pending", "unknown", "refused"}


def validate_result(program_id, describe, result, fail):
    if not isinstance(result, dict) or result.get("status") not in RESULT_STATUSES:
        raise fail(f"act() must return a dict with status in {sorted(RESULT_STATUSES)}")
    out = dict(result)
    if out.get("graph") is not None:
        out["graph"] = validate_graph(program_id, describe, out["graph"],
                                      out["graph"].get("suggested_stage") or "unfold", fail)
    receipt = out.get("receipt")
    if receipt is not None:
        # contract 0.2 receipt: {state: committed|pending|unknown|refused, id, digest?, at?}
        if not isinstance(receipt, dict) or receipt.get("state") not in RECEIPT_STATES or not isinstance(receipt.get("id"), str) or not receipt["id"]:
            raise fail(f"receipt must be an object with state in {sorted(RECEIPT_STATES)} and an id")
        if receipt["state"] == "unknown" and out["status"] == "done":
            raise fail("a receipt whose effect is unknown cannot be reported as done; use started")
        if receipt["state"] == "refused" and out["status"] in ("done", "started"):
            raise fail("a refused receipt goes with status refused or failed")
    awaiting = receipt is not None and receipt["state"] in ("pending", "unknown")
    if out["status"] == "started" and not (out.get("task") or {}).get("id") and not awaiting:
        raise fail("a started action must return task.id (a task id, so its status can be followed), "
                   "or a pending/unknown receipt to reconcile")
    return out
