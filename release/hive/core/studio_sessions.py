"""J3 host round R2 (G1): the `studio.session` intent kind on the Ask intent plane, and its session record.

Plan: coordination/omegareview/PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md §3.1-3.2 (R2 row of §9); contract of record
coordination/omegacode/J3_ASK_SETS_UP_STUDIO_CONTRACT_R4_3.md §2, §6 (the contract wins where they differ).

- Record (ask_intents.Intents.record, kind "studio.session") keeps the person's exact consented request and creates
  nothing else. Named people record it, members included; code.request stays admin-only.
- Submit (Intents.submit) claims the intent as for code.request, then admit() does all of admission in ONE write
  transaction: every re-check, then the goal (assigned to the exact maker id, created by the person), the proposal
  artifact (created by the host, never the maker), the studio_sessions row, the recorded answer (mind_operations, so
  Intents._audit and S4 replay hold unchanged) and the intent link. A refusal commits none of them.
- Money (contract §6): the person's monthly total must exist (own key: the self/all-keys key limit; otherwise the
  person's monthly allowance), else 402 spend_limit reason monthly_total_required. The session cap must fit inside the
  current headroom of every row of the maker's reservation snapshot, and the step cap inside the session cap. This is
  a pre-check: it reserves nothing (contract: "Admission is a pre-check, not a step-wide hold").
- GET /api/studio-sessions/{sid}: the person's own ledger. Steps, directions and Stop come in R3-R5; R2 reports them
  empty/none truthfully.

Later rounds: steps (R3, studio_steps.py / studio_handoff.py); money at call time (R4, studio_gateway.py: the
user_for hook, studio:<sid>/studiostep:<sid>:<n> rows in the gateway snapshot, reserve -> SEND_GATE, L6 op ids); O1 steer
interception (studio_steer.py), pause/resume, Stop's goal cancel and confirmation view, window expiry (R5).
scope_spent/scope_held below are the exact-label readers R4 reuses.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import re
import secrets
import sqlite3

from .db import now
from .minds import canonical, sha, stamp as rfc3339_ms
from .studio_steps import StudioSteps

KIND = "studio.session"
HUB_MAKER_KINDS = ("omega",)   # R6 (OI-11): minds whose hub channel delivers studio_step frames (modules/channel_hive)
LIVE_STATES = ("active", "paused", "stopping")
STATES = ("active", "paused", "stopping", "stopped", "held")
# the owner 2026-10-17 ("i guess thats ok"), contract §6: the default backstops, always under the person's monthly headroom
DEFAULT_CAP_USD = 2.00
DEFAULT_STEP_CAP_USD = 0.25
STEP_WINDOW_SECONDS = 180
MAX_WINDOW_MINUTES = 24 * 60
MAX_STEPS = 500
PROPOSAL_KIND = "studio-proposals"
HOST_PRINCIPAL = "hive:studio:"

REQUIRED = {"swarm_id", "program_id", "app_pin", "maker_id", "title", "detail", "piece", "key_id", "model", "role_id",
            "tools", "max_steps", "window_minutes", "consent_digest"}
OPTIONAL = {"cap_usd", "step_cap_usd", "coordinator_exclusive"}
# readbacks the person confirmed, verified against host state at submit; they select nothing
READBACKS = {"key_id", "model", "role_id", "tools"}

AGENT_ID = re.compile(r"a_[0-9a-f]{8}")
SWARM_ID = re.compile(r"s_[0-9a-f]{8}")
PROGRAM_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}")
KEY_ID = re.compile(r"k_[0-9a-f]{8}|env:[a-z0-9_-]+")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SESSION_ID = re.compile(r"ss_[0-9a-f]{24}")
STREAM_ID = re.compile(r"as_[0-9a-f]{24}")
SOURCE_KIND = "studio-source"            # the kind Studio's person Keep (save-source) publishes (omegadesign source_io.py)
CONSENT_SCHEMA = "omega-studio-consent-1"
# the card's fixed disclosures (plan r1.3 F1.9, F5.4): the maker restarts between steps (its in-process context is
# dropped; each step starts from its context read), and keeps access to the unsaved piece while the session is live
DISCLOSURES = ("maker_restarts_between_steps", "maker_reads_unsaved_piece_while_live")
SETTING = "HIVE_STUDIO_SESSIONS"
# handoff spec r2.4 §8.8 activation prerequisite (Mac): the sha256 of every reviewed hive-local/safe-restart.sh that carries
# the exact-commit awake override. None is adopted yet (the Platform question to the owner of 2026-10-18), so on a Mac host the
# self-check keeps Studio off whatever HIVE_STUDIO_SESSIONS says. The cloud's gate (ALLOW_AWAKE=<SHA>) already satisfies it.
MAC_SAFE_RESTART_OVERRIDE_HASHES = ()
SAFE_RESTART_PATH = "HIVE_SAFE_RESTART_PATH"


def host_platform():
    import sys
    return sys.platform


def safe_restart_path():
    import os
    import pathlib
    return pathlib.Path(os.environ.get(SAFE_RESTART_PATH) or pathlib.Path.home() / "OmegaDot" / "hive-local" / "safe-restart.sh")


def mac_restart_override_adopted():
    """True off a Mac; on a Mac only when the adopted safe-restart.sh hashes to a reviewed override-carrying version."""
    if host_platform() != "darwin":
        return True
    try:
        digest = hashlib.sha256(safe_restart_path().read_bytes()).hexdigest()
    except OSError:
        return False
    return digest in MAC_SAFE_RESTART_OVERRIDE_HASHES

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS studio_sessions (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL,
  ask_turn_id TEXT NOT NULL, thread_id TEXT, swarm_id TEXT NOT NULL, program_id TEXT NOT NULL, app_pin TEXT NOT NULL,
  maker_id TEXT NOT NULL, goal_id TEXT NOT NULL UNIQUE, proposal_artifact_id TEXT NOT NULL UNIQUE, piece TEXT NOT NULL,
  stream_id TEXT NOT NULL UNIQUE, source_artifact_id TEXT,
  payer TEXT NOT NULL, own_key INTEGER NOT NULL, key_id TEXT NOT NULL, model TEXT NOT NULL, role_id TEXT, tools TEXT NOT NULL,
  cap_usd REAL NOT NULL, step_cap_usd REAL NOT NULL, step_window_s INTEGER NOT NULL, max_steps INTEGER NOT NULL,
  expires_at TEXT NOT NULL, consent_digest TEXT NOT NULL, consent_payload_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL, state_reason TEXT,
  next_dir_seq INTEGER NOT NULL DEFAULT 1, receiver_generation INTEGER NOT NULL DEFAULT 0, stop_control_id TEXT,
  fenced_at TEXT, stopped_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    # one live session per maker (plan §3.1): a second admission races into maker_busy, never a second session
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_live_maker ON studio_sessions(maker_id) "
    "WHERE state IN ('active', 'paused', 'stopping')",
    "CREATE INDEX IF NOT EXISTS studio_sessions_principal ON studio_sessions(principal, created_at)",
]
# R2.2 (plan r1.1 D1, S4.2): added after the R2 table shape; a table made by R2 gains the columns (never deployed, but kept
# migration-safe), then the indexes: one stream per session, and a validated piece source bound to one live session at most
MIGRATIONS = [("stream_id", "ALTER TABLE studio_sessions ADD COLUMN stream_id TEXT"),
              ("source_artifact_id", "ALTER TABLE studio_sessions ADD COLUMN source_artifact_id TEXT"),
              # plan r1.2 E6.2: R2 rows hold a client-supplied digest (version 1); R2.2 rows the host-recomputed one (2)
              ("consent_payload_version",
               "ALTER TABLE studio_sessions ADD COLUMN consent_payload_version INTEGER NOT NULL DEFAULT 1")]
CONSENT_PAYLOAD_VERSION = 2
INDEXES = [
    # Kimi R2 P2-1: one live session per person, so two Ask turns cannot stack session caps on one monthly total while
    # admission is a pre-check with no hold; a race between two admissions ends at this index. R2.3 (stand-in R2.2 P1):
    # it covers consent version 2 rows only. R2 allowed one person live sessions on several makers; those rows (version 1)
    # stay valid data, are held as consent_legacy by the startup recovery, and must never stop this index (or the hive)
    # from being built
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_live_person_v2 ON studio_sessions(principal) "
    "WHERE state IN ('active', 'paused', 'stopping') AND consent_payload_version >= 2",
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_stream ON studio_sessions(stream_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_live_source ON studio_sessions(source_artifact_id) "
    "WHERE source_artifact_id IS NOT NULL AND state IN ('active', 'paused', 'stopping')",
]


def new_stream_id():
    """The host-admitted P2a stream identity (plan r1.1 D1, Design J3_O3_REQUIRED_ADMISSION_INPUTS_R1): opaque random,
    minted in the admission transaction; never derived from the sid, a body, the maker, a revision or a mount."""
    return "as_" + secrets.token_hex(12)


def consent_payload(request, *, own_key, monthly):
    """The exact consent payload (plan r1.1 K10). Surface renders the card from this same object and the person's
    consent_digest is sha256 of its canonical JSON (sorted keys, no spaces, UTF-8). Money is integer micro-dollars so the
    bytes are the same in every language. monthly: (limit kind, limit in USD or None)."""
    from .cost_reservations import micros
    kind, limit = monthly
    return {"schema": CONSENT_SCHEMA, "swarm_id": request["swarm_id"], "program_id": request["program_id"],
            "app_pin": request["app_pin"], "maker_id": request["maker_id"], "model": request["model"],
            "key_id": request["key_id"], "role_id": request["role_id"], "tools": request["tools"],
            "payer": "own_key" if own_key else "hive_key",
            "monthly": {"kind": kind, "limit_micros": None if limit is None else micros(limit)},
            "cap_micros": micros(request["cap_usd"]), "step_cap_micros": micros(request["step_cap_usd"]),
            "step_window_s": STEP_WINDOW_SECONDS, "max_steps": request["max_steps"],
            "window_minutes": request["window_minutes"], "piece": request["piece"],
            "coordinator_exclusive": request["coordinator_exclusive"], "title": request["title"], "detail": request["detail"],
            # plan r1.3 F1.9 / F5.4: what the card says in words, as fixed ids Surface renders
            "disclosures": list(DISCLOSURES)}


def consent_digest(payload):
    return sha(canonical(payload))


def scope_label(session_id):
    """The session cap's exact reservation label (contract §6); host-derived, never chosen by a body."""
    return "studio:" + session_id


def step_label(session_id, n):
    return f"studiostep:{session_id}:{int(n)}"


def _money(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _authority_keys(value, depth=0):
    """Authority-shaped keys anywhere inside an opaque value (ask.forbidden at every level)."""
    from .ask import forbidden
    if depth > 8:
        return ["<too deep>"]
    out = []
    if isinstance(value, dict):
        out += forbidden(value)
        for v in value.values():
            out += _authority_keys(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            out += _authority_keys(v, depth + 1)
    return out


class StudioSessions(StudioSteps):
    def __init__(self, hive, gateway=None, reservations=None, budget_snapshot=None):
        self.hive = hive
        self.gateway = gateway
        self.reservations = reservations
        self.budget_snapshot = budget_snapshot
        for statement in SCHEMA:
            hive.db.execute(statement)
        have = {r["name"] for r in hive.db.all("SELECT name FROM pragma_table_info('studio_sessions')")}
        for column, statement in MIGRATIONS:
            if column not in have:
                hive.db.execute(statement)
        self.index_failures = []
        for statement in INDEXES:
            # R2.3: startup never fails on existing data. An index existing rows contradict is reported, and the
            # self-check keeps Studio off without it (admission's own pre-checks still refuse)
            try:
                hive.db.execute(statement)
            except sqlite3.IntegrityError as exc:
                import logging
                name = statement.split(" ON ")[0].rsplit(" ", 1)[-1]
                self.index_failures.append(name)
                logging.getLogger("hive").warning("studio: index %s not built over existing rows (%s)", name, exc)
        self._init_steps()                      # R3: steps, piece custody, mounts, executions (studio_steps.py)
        self.enabled, self.missing = self.self_check()

    # ---- plan r1.3 F4.2: Studio stays off until the whole paid path exists ------------------------------------------

    def components(self):
        """What this build has of the Studio path, by name. R3 built the step plane, the fence table and token rotation;
        R4 the gateway execution hook and SEND_GATE wiring (studio_gateway.py); R5 pause and resume. Off a Mac every part
        is present, so HIVE_STUDIO_SESSIONS alone decides (default off). On a Mac the reviewed exact-commit safe-restart
        override is still missing (none adopted), so the switch cannot turn on there."""
        db = self.hive.db
        tables = {r["name"] for r in db.all("SELECT name FROM sqlite_master WHERE type = 'table'")}
        return {"studio_sessions table": "studio_sessions" in tables,
                "studio_steps table": "studio_steps" in tables,
                "studio_fenced_executions table": "studio_fenced_executions" in tables,
                "gateway session/execution hook": bool(getattr(self, "GATEWAY_EXECUTION_HOOK", False)),
                "SEND_GATE session wiring": bool(getattr(self, "SEND_GATE_WIRING", False)),
                "supervisor token rotation": bool(getattr(self, "TOKEN_ROTATION", False)),
                "studio_sessions unique indexes": not getattr(self, "index_failures", []),
                # r1.4 G5d: the switch never turns on without a way out of a paused or live session
                "controls: pause, resume, stop": {"pause", "resume", "stop"} <= set(getattr(self, "CONTROL_ACTIONS", ())),
                # handoff spec r2.4 §8.8: a Mac hive needs the reviewed exact-commit safe-restart override first
                "mac safe-restart exact-commit override": mac_restart_override_adopted()}

    def self_check(self):
        """The startup self-check (F4.2): Studio sessions are enabled only when HIVE_STUDIO_SESSIONS is on AND every
        component exists; otherwise off, logging what is missing. Returns (enabled, missing)."""
        import logging
        import os
        wanted = os.environ.get(SETTING, "").strip().lower() in ("1", "true", "on", "yes")
        missing = [name for name, ok in self.components().items() if not ok]
        if wanted and missing:
            logging.getLogger("hive").warning("%s is on but this build lacks: %s; Studio sessions stay off",
                                              SETTING, ", ".join(missing))
        if wanted and not missing and not self._maker_template_set():
            # R7.1: sessions run, but members' own makers cannot be made (setup: 409 studio_maker_unavailable) and the
            # hive does not advertise capabilities.studio_sessions until the template is set
            logging.getLogger("hive").warning("%s is on but HIVE_STUDIO_MAKER_TEMPLATE does not name a usable Omega "
                                              "mind; members' own Studio makers can't be made", SETTING)
        return wanted and not missing, missing

    def _maker_template_set(self):
        import os
        mind_id = os.environ.get("HIVE_STUDIO_MAKER_TEMPLATE", "").strip()
        row = self.hive.db.one("SELECT kind FROM agents WHERE id = ? AND deleted = 0", (mind_id,)) if mind_id else None
        return bool(row) and (row["kind"] or "omega") in HUB_MAKER_KINDS

    def require_enabled(self):
        """Record and submit of a studio.session intent (and step admission, R3) while Studio is off: 404."""
        if not self.enabled:
            raise self._not_available()

    # ---- errors --------------------------------------------------------------------------------------------------

    def _err(self, status, code, message, **details):
        return self.hive.error(status, code, message, details or None)

    def _bad(self, message, **details):
        return self._err(400, "bad_request", message, **details)

    def _not_available(self):
        return self._err(404, "not_available", "That isn't available.")

    # ---- record: the exact consented request ------------------------------------------------------------------------

    def clean_request(self, request):
        """The canonical stored request: the exact key set, shapes and bounds, the default backstops filled in so the
        recorded body shows the actual values. Creates nothing. 400 bad_request otherwise."""
        if not isinstance(request, dict):
            raise self._bad("request is the studio.session request object")
        keys = set(request)
        if not REQUIRED <= keys or keys - REQUIRED - OPTIONAL:
            raise self._bad("request has exactly the studio.session keys", missing=sorted(REQUIRED - keys),
                            unknown=sorted(keys - REQUIRED - OPTIONAL))
        smuggled = sorted(set(_authority_keys({k: v for k, v in request.items() if k not in READBACKS})))
        if smuggled:
            raise self._bad("authority, identity and money are derived by the hive", fields=smuggled)
        r = dict(request)
        if not isinstance(r["swarm_id"], str) or not SWARM_ID.fullmatch(r["swarm_id"]):
            raise self._bad("swarm_id is a swarm id")
        if not isinstance(r["maker_id"], str) or not AGENT_ID.fullmatch(r["maker_id"]):
            # an exact id, never a name (goals.py also matches assignees by name; plan §10.11)
            raise self._bad("maker_id is the maker's exact mind id, not a name", reason="maker_id_not_id")
        if not isinstance(r["program_id"], str) or not PROGRAM_ID.fullmatch(r["program_id"]):
            raise self._bad("program_id is an app id")
        pin = r["app_pin"]
        if not (isinstance(pin, dict) and set(pin) == {"id", "version", "digest"}
                and all(isinstance(pin[k], str) and 0 < len(pin[k]) <= 200 for k in pin) and pin["id"] == r["program_id"]):
            raise self._bad("app_pin is exactly {id, version, digest} of the app named by program_id")
        if not isinstance(r["title"], str) or not 0 < len(r["title"].strip()) <= 300:
            raise self._bad("title is 1-300 characters")
        if not isinstance(r["detail"], str) or len(r["detail"]) > 4000:
            raise self._bad("detail is at most 4000 characters")
        piece = r["piece"]
        source = piece.get("source_ref", ...) if isinstance(piece, dict) else ...
        if not (isinstance(piece, dict) and set(piece) == {"scene_id", "source_ref"} and isinstance(piece["scene_id"], str)
                and 0 < len(piece["scene_id"]) <= 200
                and (source is None or (isinstance(source, dict) and isinstance(source.get("artifact_id"), str)
                                        and 0 < len(source["artifact_id"]) <= 200))
                and len(canonical(piece)) <= 2048):
            raise self._bad("piece is exactly {scene_id, source_ref: null or {artifact_id, ...}}, at most 2 KB")
        if not isinstance(r["key_id"], str) or not KEY_ID.fullmatch(r["key_id"]):
            raise self._bad("key_id is the paying key's id as shown on the card")
        if not isinstance(r["model"], str) or not 0 < len(r["model"]) <= 200:
            raise self._bad("model is the maker's model as shown on the card")
        if r["role_id"] is not None and (not isinstance(r["role_id"], str) or not 0 < len(r["role_id"]) <= 120):
            raise self._bad("role_id is the maker's effective role id, or null for none")
        tools = r["tools"]
        if not (isinstance(tools, list) and len(tools) <= 20 and all(isinstance(t, str) and 0 < len(t) <= 200 for t in tools)):
            raise self._bad("tools is the maker's effective options.tools list ([] for none)")
        r.setdefault("cap_usd", DEFAULT_CAP_USD)
        r.setdefault("step_cap_usd", DEFAULT_STEP_CAP_USD)
        if not _money(r["cap_usd"]) or not _money(r["step_cap_usd"]):
            raise self._bad("cap_usd and step_cap_usd are positive amounts")
        if r["step_cap_usd"] > r["cap_usd"]:
            raise self._bad("step_cap_usd is at most cap_usd")
        if type(r["max_steps"]) is not int or not 1 <= r["max_steps"] <= MAX_STEPS:
            raise self._bad(f"max_steps is 1 to {MAX_STEPS}")
        if type(r["window_minutes"]) is not int or not 1 <= r["window_minutes"] <= MAX_WINDOW_MINUTES:
            raise self._bad(f"window_minutes is 1 to {MAX_WINDOW_MINUTES}")
        if not isinstance(r["consent_digest"], str) or not DIGEST.fullmatch(r["consent_digest"]):
            raise self._bad("consent_digest is sha256:<64 hex> of the exact card the person confirmed")
        r.setdefault("coordinator_exclusive", False)
        if type(r["coordinator_exclusive"]) is not bool:
            raise self._bad("coordinator_exclusive is true or false")
        return r

    # ---- submit: one-transaction admission --------------------------------------------------------------------------

    def _person_ok(self, principal):
        """Still a named person who is not disabled (re-checked inside the admission transaction)."""
        from .program_actions import named_person
        if not named_person(principal):
            return False
        if principal.startswith("user:u_"):
            p = self.hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
            return bool(p) and not p["disabled"] and p["role"] in ("admin", "member")
        return True

    def _app_attached(self, request):
        hive, pin = self.hive, request["app_pin"]
        try:
            entry = hive.programs._ready(request["program_id"])
        except Exception:   # noqa: BLE001  (any refusal to open the app: not attached at that pin)
            return False
        if str(entry.get("version")) != pin["version"] or entry.get("digest") != pin["digest"]:
            return False
        attachments = hive.app_attachments
        makers = getattr(hive, "studio_makers", None)
        personal = makers is not None and makers.person_of(request["maker_id"]) is not None
        # R7: a person's own Studio maker is attached by the host with no activation row (one would make the app's
        # attachments required in every swarm); for it, the activation is required only where the app requires
        # attachments at all. The shared (admin-attached) maker path is unchanged.
        activated = attachments.active(request["program_id"], request["swarm_id"]) or (
            personal and not attachments.required(entry))
        if not activated:
            return False
        row = hive.db.one("SELECT * FROM app_attachments WHERE program = ? AND mind = ? AND status = 'active'",
                          (request["program_id"], request["maker_id"]))
        return bool(row) and row["swarm"] == request["swarm_id"] and not attachments.expired(row["expires"])

    def refuse_others_maker(self, principal, maker_id):
        """R7: another person's own Studio maker (studio_makers.py binding) is never anyone else's maker, admins included:
        409 maker_not_yours, nothing written. Shared makers (no binding) are unaffected."""
        makers = getattr(self.hive, "studio_makers", None)
        owner = makers.person_of(maker_id) if makers is not None else None
        if owner is not None and owner != principal:
            raise self._err(409, "maker_not_yours", "That maker is someone else's own Studio maker; use your own.")

    def _payer_as_if(self, principal, key_owner):
        """Hive.payer_for evaluated as if this session already existed (plan §3.2, §6.4): the call is for the person."""
        hive = self.hive
        if key_owner and str(key_owner).startswith("user:u_"):
            if principal == key_owner:
                return key_owner, True
            if hive.ownhive.access(principal) in ("guest", "public") or hive.ownhive.has_grant(principal, owner=key_owner):
                return principal, False
            return key_owner, True
        return principal, False

    def _monthly_total(self, principal, maker, key_id, own_key, cap_usd):
        """Contract §6: the required person-wide monthly total. Own key: the key owner's self limit on all keys
        (grantee self, key_id *); per-key rows never substitute. On the hive's key (R2.1, Platform's ruling): the
        person's month allowance, i.e. their person month rule, else the member default allowance (budgets.py);
        refused when neither applies, or when the session cap does not fit what is left of it."""
        hive = self.hive
        if own_key:
            rows = hive.db.all("SELECT * FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                               "AND revoked_at IS NULL", (principal,))
            live = hive.ownhive._active(rows)
            if live:
                return "own_key_limit", min(float(r["month_usd"]) for r in live)
            self._missing_total("own_key_limit")
        scope = "person:" + principal[5:]
        rules = [float(r["limit_usd"]) for r in hive.budgets.rules() if r["scope"] == scope and r["period"] == "month"]
        allowance = min(rules) if rules else (hive.budgets.member_allowance(principal[5:]) if principal.startswith("user:u_") else None)
        if allowance is None:
            self._missing_total("member_allowance")
        from .cost_reservations import ROUND_FLOOR, micros
        spent = hive.budgets.spent(scope, "month")
        held = self.reservations.pending(scope + ":month")
        room = micros(allowance, ROUND_FLOOR) - micros(spent) - held
        if micros(cap_usd) > room:
            raise self._err(402, "spend_limit", "That session doesn't fit what is left of your month allowance.",
                            limit={"kind": "member_allowance", "limit_usd": allowance, "spent_usd": round(spent, 6),
                                   "held_usd": held / 1_000_000}, reason="monthly_total_required",
                            headroom_usd=max(0, room) / 1_000_000, cap_usd=cap_usd)
        return "member_allowance", float(allowance)

    def _missing_total(self, kind):
        raise self._err(402, "spend_limit", "Set your monthly total first; Studio spends under it.",
                        limit={"kind": kind, "limit_usd": None, "spent_usd": None, "held_usd": None},
                        reason="monthly_total_required")

    def _headroom(self, maker_id, key_id, payer, own_key, cap_usd):
        """Every row of the maker's reservation snapshot for this payer must have room for the whole session cap
        (limit - spent - open holds, the arithmetic of cost_reservations.reserve, with nothing inserted)."""
        from .cost_reservations import ROUND_FLOOR, micros
        rows = self.budget_snapshot(self.hive, maker_id, key_id, payer, own_key)
        out = []
        for label, limit, spent in rows:
            held = self.reservations.pending(label)
            room = micros(limit, ROUND_FLOOR) - micros(spent) - held
            out.append((label, float(limit), float(spent), held / 1_000_000, room / 1_000_000))
            if micros(cap_usd) > room:
                raise self._err(402, "budget_exhausted", "There isn't room for that session under your limits.",
                                scope=label, limit_usd=float(limit), spent_usd=round(float(spent), 6),
                                held_usd=held / 1_000_000, headroom_usd=max(0, room) / 1_000_000, cap_usd=cap_usd)
        return out

    def _source(self, viewer, request, session_id=None):
        """Plan r1.1 S4.2: piece.source_ref is null, or the person's Studio source artifact in the session's swarm that no
        other live session binds. Only a validated id is ever fenced (a foreign id could otherwise block its swarm's
        minds). The person's read is the swarm visibility already checked (the person program-read path's own rule).
        409 source_not_bindable otherwise. Returns the artifact id or None."""
        ref = request["piece"]["source_ref"]
        if ref is None:
            return None
        art = self.hive.db.one("SELECT * FROM artifacts WHERE id = ?", (ref["artifact_id"],))
        if art is None or art["owner_swarm"] != request["swarm_id"] or art["kind"] != SOURCE_KIND:
            raise self._err(409, "source_not_bindable", "That piece's saved source can't be bound to this Studio session.")
        if self.hive.db.one("SELECT 1 FROM studio_sessions WHERE source_artifact_id = ? AND state IN ('active', 'paused', "
                            "'stopping') AND id != ?", (art["id"], session_id or "")):
            raise self._err(409, "source_not_bindable", "That piece is already being made in another live Studio session.")
        return art["id"]

    def execution_qualified(self, maker):
        """Plan r1.3 F1.8: the maker must be a supervisor-managed mind the host can stop, give a new token and observe a
        new execution boundary for: its driver is one of the supervisor's, with stop/start and real execution evidence
        (a driver whose execution() is the base no-op gives none). A mind with no supervisor driver is unqualified."""
        from ..supervisor.drivers import Driver
        drivers = getattr(self.hive.supervisor, "drivers", None) if self.hive.supervisor is not None else None
        if not isinstance(drivers, dict):
            return False
        driver = drivers.get(maker.get("driver") or getattr(self.hive.settings, "default_driver", None))
        return (driver is not None and callable(getattr(driver, "stop", None)) and callable(getattr(driver, "start", None))
                and type(driver).execution is not Driver.execution)

    def _busy(self, maker_id, turn):
        db = self.hive.db
        if db.one("SELECT 1 FROM studio_sessions WHERE maker_id = ? AND state IN ('active', 'paused', 'stopping')", (maker_id,)):
            return True
        if db.one("SELECT 1 FROM ask_turns WHERE mind_id = ? AND state IN ('accepted', 'thinking')", (maker_id,)):
            return True
        return bool(db.one("SELECT 1 FROM work_sessions WHERE agent_id = ? AND status = 'active' "
                           "AND (purpose IS NULL OR purpose != 'ask')", (maker_id,)))

    def admit(self, viewer, intent, bind):
        """The single admission transaction for one claimed studio intent (Intents.submit S2). Returns the new goal row
        for the post-commit announce. bind(recorded) is Intents._link: dispatching -> linked in this same transaction."""
        from .gateway import GatewayError, split_model
        hive, db = self.hive, self.hive.db
        principal = viewer.principal
        body = json.loads(intent["body"])
        request = body["request"]
        turn = db.one("SELECT * FROM ask_turns WHERE id = ?", (intent["turn_id"],))
        sid = "ss_" + secrets.token_hex(12)
        try:
            with db.transaction():
                if not self._person_ok(principal):
                    raise self._err(403, "person_required", "a named, signed-in person does this")
                if turn is None or turn["deleted_at"]:
                    raise self._not_available()
                if datetime.datetime.now(datetime.timezone.utc) >= _aware(intent["expires_at"]):
                    raise self._bad("that Ask turn is more than 24 hours old; ask again", reason="turn_too_old")
                try:
                    hive.visibility.check_path(viewer, {"swarm_id": request["swarm_id"]})
                    hive.swarm(request["swarm_id"])
                except Exception:   # noqa: BLE001  (an unseen or missing swarm is not available, whichever)
                    raise self._not_available() from None
                maker = db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (request["maker_id"],))
                self.refuse_others_maker(principal, request["maker_id"])   # R7: a personal maker is its person's alone
                if maker is None or maker["swarm_id"] != request["swarm_id"]:
                    raise self._err(409, "maker_not_member", "That maker isn't a mind of that Studio home.")
                if not self._app_attached(request):
                    raise self._err(409, "app_not_attached", "Studio isn't attached to that maker at the confirmed version.")
                if maker["model"] != request["model"]:
                    raise self._err(409, "model_drift", "The maker's model changed since you confirmed; confirm again.",
                                    model=maker["model"])
                options = _options(maker)
                if (maker.get("role_id") or None) != request["role_id"] or list(options.get("tools") or []) != request["tools"]:
                    raise self._err(409, "role_drift", "The maker's role or tools changed since you confirmed; confirm again.",
                                    role_id=maker.get("role_id"), tools=list(options.get("tools") or []))
                provider = split_model(maker["model"])[0]
                try:
                    key_id = self.gateway.paying_key(maker, provider)[0]
                except GatewayError:
                    key_id = None
                if key_id != request["key_id"]:
                    raise self._err(409, "key_drift", "The key paying for the maker changed since you confirmed; confirm again.")
                makers = getattr(hive, "studio_makers", None)
                refused = makers.key_refusal(maker["id"], key_id, "admission") if makers is not None else None
                if refused is not None:        # R7.2: a person's own maker pays only with that person's own key
                    raise refused
                record = ((getattr(self.gateway, "keyring", None) and self.gateway.keyring.ring.get("keys")) or {}).get(key_id) or {}
                payer, own_key = self._payer_as_if(principal, record.get("owner"))
                if makers is not None and makers.person_of(maker["id"]) is not None and not own_key:
                    raise makers.key_refusal(maker["id"], None, "admission")   # never billed as anything but own key
                if payer != principal:
                    raise self._err(409, "payer_mismatch", "That maker's calls wouldn't be billed to you; choose your own key.")
                hive.ownhive.use_check(maker, key_id, payer, user=principal)   # 402 as a call for them would (OI-13 r1.1)
                if (maker.get("kind") or "omega") not in HUB_MAKER_KINDS:
                    # R6 (OI-11): a step reaches its maker only as a hub frame, and a live maker may not read the pull
                    # inbox (R3 studio_hub_only). An Iter-template mind polls that inbox and never registers on the hub
                    # (so proof (b) never comes); an outside member (module) has no hub channel. Refused, nothing written.
                    raise self._err(409, "maker_kind_unsupported", "That maker can't take Studio steps yet; choose an "
                                    "Omega mind.", kind=maker.get("kind"))
                if not self.execution_qualified(maker):
                    raise self._err(409, "execution_binding_unqualified",
                                    "That maker can't be restarted between steps by this hive; choose a hive-run maker.")
                if self._busy(maker["id"], turn):
                    raise self._err(409, "maker_busy", "That maker is busy with other work; choose another or wait.")
                # R5 (plan r1.2 E2(a), r1.8 L2): a new session never takes a maker Studio still owns (a held session, a
                # stopping or unreleased one, an open handoff), nor one whose current execution is fenced; Stop releases
                # it onto a fresh, unfenced epoch first
                if self.studio_owns(maker["id"]):
                    raise self._err(409, "maker_busy", "That maker is still held by another Studio session; stop it first.",
                                    reason="studio_owned")
                if self.fenced(maker["id"], maker.get("token_epoch")):
                    raise self._err(409, "execution_fenced", "That maker's current run has ended for Studio; start it "
                                    "again first.")
                if db.one("SELECT 1 FROM studio_sessions WHERE principal = ? AND state IN ('active', 'paused', 'stopping')",
                          (principal,)):
                    raise self._err(409, "person_session_live", "You already have a live Studio session; finish it first.")
                if turn["mind_id"] == maker["id"] and not request["coordinator_exclusive"]:
                    # contract §6: one mind as coordinator and maker only when the card accepted the temporary exclusivity
                    raise self._err(409, "maker_is_coordinator", "That maker is your Ask mind; confirm it may be dedicated.")
                monthly = self._monthly_total(principal, maker, key_id, own_key, float(request["cap_usd"]))
                payload = consent_payload(request, own_key=own_key, monthly=monthly)
                if consent_digest(payload) != request["consent_digest"]:
                    # plan r1.1 K10: the host recomputes the card the person confirmed; any difference is a new consent
                    raise self._err(409, "consent_mismatch", "What you confirmed no longer matches; confirm again.",
                                    consent_digest=consent_digest(payload), consent=payload)
                self._headroom(maker["id"], key_id, payer, own_key, float(request["cap_usd"]))
                source_artifact_id = self._source(viewer, request, sid)
                expires = min(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=request["window_minutes"]),
                              _aware(intent["expires_at"]))
                goal = hive.goals._create_record(request["swarm_id"], request["title"], request["detail"], 0.5,
                                                 created_by=principal, assignee=maker["id"],
                                                 binding={"kind": KIND, "studio_session_id": sid}, emit=False)
                if goal["assignee"] != maker["id"]:                  # exactly the id, never a name match
                    raise self._err(409, "operation_conflict", "That task could not be assigned exactly; nothing was created.")
                artifact = hive.collab.create_artifact(maker, {"kind": PROPOSAL_KIND, "title": request["title"]},
                                                       principal=HOST_PRINCIPAL + sid)
                stamp = now()
                row = {"id": sid, "intent_id": intent["id"], "principal": principal, "ask_turn_id": turn["id"],
                       "thread_id": turn["thread_id"], "swarm_id": request["swarm_id"], "program_id": request["program_id"],
                       "app_pin": canonical(request["app_pin"]), "maker_id": maker["id"], "goal_id": goal["id"],
                       "proposal_artifact_id": artifact["id"], "piece": canonical(request["piece"]), "payer": payer,
                       "stream_id": new_stream_id(), "source_artifact_id": source_artifact_id,
                       "own_key": 1 if own_key else 0, "key_id": key_id, "model": maker["model"], "role_id": request["role_id"],
                       "tools": canonical(request["tools"]), "cap_usd": float(request["cap_usd"]),
                       "step_cap_usd": float(request["step_cap_usd"]), "step_window_s": STEP_WINDOW_SECONDS,
                       "max_steps": request["max_steps"], "expires_at": rfc3339_ms(expires),
                       "consent_digest": request["consent_digest"], "consent_payload_version": CONSENT_PAYLOAD_VERSION,
                       "state": "active", "state_reason": None,
                       "next_dir_seq": 1, "receiver_generation": 0, "stop_control_id": None, "fenced_at": None,
                       "stopped_at": None, "created_at": stamp, "updated_at": stamp,
                       "maker_released": 0}     # handoff spec r2.4 §2: Studio owns the maker until Stop releases it
                db.insert("studio_sessions", row)
                answer = self.answer(row)
                hive.minds._record(intent["principal"], intent["request_operation_id"], intent["request_digest"], 201, answer)
                bind({"request_id": None, "lease_id": None, "receiving_goal": goal["id"], "session_id": sid})
                notice = self.notice(row, turn)
                db.after_commit(lambda: hive.events.publish("studio.session", **notice))
                # R3 seam: step 1 is admitted after this commit (plan §3.4); R2 admits no steps.
        except sqlite3.IntegrityError as exc:
            # a live index raced another admission (the intent claim makes a same-intent race impossible)
            if "studio_sessions.principal" in str(exc):
                raise self._err(409, "person_session_live",
                                "You already have a live Studio session; finish it first.") from None
            if "source_artifact_id" in str(exc):
                raise self._err(409, "source_not_bindable",
                                "That piece is already being made in another live Studio session.") from None
            raise self._err(409, "maker_busy", "That maker is busy with other work; choose another or wait.") from None
        return goal

    @staticmethod
    def notice(row, turn):
        """The body-free studio.session event (visibility rule studio_person: the session's person, and admins): the ids a
        receipt card links (turn operation, intent, goal, maker, proposal artifact) and the state. Never a body or money
        figure; the card fetches GET /api/studio-sessions/{sid} for those."""
        return {"session_id": row["id"], "intent_id": row["intent_id"], "operation_id": turn["operation_id"],
                "turn_id": turn["id"], "goal_id": row["goal_id"], "agent_id": row["maker_id"], "swarm_id": row["swarm_id"],
                "proposal_artifact_id": row["proposal_artifact_id"], "stream_id": row["stream_id"], "state": row["state"],
                "updated_at": row["updated_at"]}

    @staticmethod
    def answer(row):
        """The recorded 201 of a studio submit (replayed byte for byte, S4)."""
        return {"kind": KIND, "session_id": row["id"], "intent_id": row["intent_id"], "goal_id": row["goal_id"],
                "proposal_artifact_id": row["proposal_artifact_id"], "stream_id": row["stream_id"], "maker_id": row["maker_id"],
                "swarm_id": row["swarm_id"], "program_id": row["program_id"], "state": row["state"],
                "cap_usd": row["cap_usd"], "step_cap_usd": row["step_cap_usd"], "step_window_s": row["step_window_s"],
                "max_steps": row["max_steps"], "expires_at": row["expires_at"], "budget_scope": scope_label(row["id"]),
                "created_at": row["created_at"]}

    # ---- the person's ledger ---------------------------------------------------------------------------------------

    def scope_spent(self, label):
        """Settled actual cost under one exact label (the sessions.thread_spent pattern)."""
        return self.hive.db.one("SELECT COALESCE(SUM(r.actual), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
                                "ON c.reservation = r.id WHERE c.scope = ? AND r.state = 'settled'", (label,))["n"] / 1_000_000

    def scope_held(self, label, states=("reserved", "dispatched", "unknown")):
        marks = ", ".join("?" for _ in states)
        return self.hive.db.one("SELECT COALESCE(SUM(r.maximum), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
                                f"ON c.reservation = r.id WHERE c.scope = ? AND r.state IN ({marks})", (label, *states))["n"] / 1_000_000

    def _own(self, viewer, session_id):
        row = self.hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (str(session_id),)) \
            if SESSION_ID.fullmatch(str(session_id)) else None
        if row is None or row["principal"] != viewer.principal:
            raise self._not_available()
        try:            # plan r1.1 K1: every person route re-checks that the person still sees the Studio home's swarm
            self.hive.visibility.check_path(viewer, {"swarm_id": row["swarm_id"]})
        except Exception:   # noqa: BLE001  (a scope revoked or a swarm gone: not available, whichever)
            raise self._not_available() from None
        return row

    def ledger(self, viewer, session_id):
        """GET /api/studio-sessions/{sid}: the owner's ledger. Anyone else (admins included) gets 404 not_available."""
        row = self._own(viewer, session_id)
        label = scope_label(row["id"])
        monthly = []
        try:
            monthly = [{"scope": s, "limit": lim, "spent": round(sp, 6), "held": held, "headroom": room}
                       for s, lim, sp, held, room in self._snapshot_view(row)]
        except Exception:   # noqa: BLE001  (a deleted maker: the binding and money below still read)
            monthly = []
        return {"session_id": row["id"], "kind": KIND, "intent_id": row["intent_id"], "ask_turn_id": row["ask_turn_id"],
                "thread_id": row["thread_id"], "swarm_id": row["swarm_id"], "program_id": row["program_id"],
                "app_pin": json.loads(row["app_pin"]), "maker_id": row["maker_id"], "goal_id": row["goal_id"],
                "proposal_artifact_id": row["proposal_artifact_id"], "stream_id": row["stream_id"],
                "piece": json.loads(row["piece"]), "source_artifact_id": row["source_artifact_id"],
                "key_id": row["key_id"], "model": row["model"], "role_id": row["role_id"], "tools": json.loads(row["tools"]),
                "own_key": bool(row["own_key"]), "consent_digest": row["consent_digest"], "expires_at": row["expires_at"],
                "max_steps": row["max_steps"], "step_window_s": row["step_window_s"],
                "state": row["state"], "state_reason": row["state_reason"],
                "steps": self.steps_view(row), "directions": self.directions_view(row), "piece_custody": self.piece_view(row),
                "budget": {"scope": label, "cap": row["cap_usd"], "spent": round(self.scope_spent(label), 6),
                           "held": self.scope_held(label, ("reserved", "dispatched")),
                           "unknown": self.scope_held(label, ("unknown",)), "step_cap": row["step_cap_usd"],
                           "step_spent": None, "monthly": monthly},
                "stop": {**self.stop_view(row), "fenced_at": row["fenced_at"], "stopped_at": row["stopped_at"]},
                "handoff": self.handoff_view(row),
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def _snapshot_view(self, row):
        from .cost_reservations import ROUND_FLOOR, micros
        out = []
        for label, limit, spent in self.budget_snapshot(self.hive, row["maker_id"], row["key_id"], row["payer"], bool(row["own_key"])):
            held = self.reservations.pending(label)
            out.append((label, float(limit), float(spent), held / 1_000_000,
                        (micros(limit, ROUND_FLOOR) - micros(spent) - held) / 1_000_000))
        return out


def _options(agent):
    options = agent.get("options")
    if isinstance(options, str):
        try:
            options = json.loads(options)
        except ValueError:
            options = None
    return options if isinstance(options, dict) else {}


def _aware(text):
    return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))


def recover_startup(tx):
    """A step of the one combined startup recovery (exclusive.STEPS, plan r1.2 E6.2): a live session recorded under the
    R2 consent meaning (version 1: a client-supplied digest the host never recomputed) is held with state_reason
    consent_legacy; continuing it needs a new intent. Nothing is rewritten. Returns the count."""
    if not tx.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'studio_sessions'"):
        return 0
    interrupted = StudioSteps.recover_startup(tx)     # R3: open steps are interrupted and their executions fenced
    if tx.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goals'") and \
            tx.one("SELECT 1 FROM pragma_table_info('goals') WHERE name = 'cancel_ack_by'"):
        # R8.5 r1: a session stopped before R8.5 left its cancelled goal unacknowledged; the host settles it once, as at Stop
        from .studio_makers import HOST_ACTOR
        interrupted += tx.execute("UPDATE goals SET cancel_ack_at = ?, cancel_ack_by = ? WHERE status = 'cancelled' AND "
                                  "cancel_ack_at IS NULL AND id IN (SELECT goal_id FROM studio_sessions WHERE state = 'stopped' "
                                  "AND goal_id IS NOT NULL)", (now(), HOST_ACTOR)).rowcount
    if not tx.one("SELECT 1 FROM pragma_table_info('studio_sessions') WHERE name = 'consent_payload_version'"):
        return interrupted
    return interrupted + tx.execute("UPDATE studio_sessions SET state = 'held', state_reason = 'consent_legacy', updated_at = ? "
                      "WHERE consent_payload_version < ? AND state IN ('active', 'paused')",
                      (now(), CONSENT_PAYLOAD_VERSION)).rowcount
