"""S4: the per-mind tool inventory, read-only (platform seam contracts r2, r2.4 item 6, r2.5).

Source of truth is a **boot receipt** each native mind posts after it loads (``POST /api/agent/inventory``,
posted by ``modules/hive`` from inside the mind): the skill heads the mind's own process registered.  Without
a receipt every skill is ``unknown``.  Nothing is ever marked callable from source alone.

Statuses (what the receipt proves, no more):

- ``callable``    the mind's parser registered the head and the skill's module is loaded.  It does NOT mean provider
                  availability, remaining budget or future authority; policy is re-checked at dispatch.
- ``imported``    the module is loaded and declares the skill, but the parser did not register a head for it.
- ``configured``  the loader selects the module, but the mind did not load it.
- ``unknown``     no receipt, a receipt that no longer describes a running process, or nothing attests the skill.

Descriptive metadata (help, topic, effects, risk, declared signature) comes from Match's extractor library
(``vendor/omegamatch_skill_metadata.py``, vendored byte-for-byte, pin in ``VENDOR_PIN``) and only from module
sources whose digest equals the one in the receipt.  The policy decision, provider and budget route carry their own
``snapshot_at``.  No secrets are read or returned: only skill names, module ids and digests, scope labels.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re

from .db import now
from .policy import command_skill

SCHEMA = """
CREATE TABLE IF NOT EXISTS inventory_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, revision TEXT NOT NULL, boot_id TEXT NOT NULL,
  received_at TEXT NOT NULL, stale_at TEXT, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_receipts_agent ON inventory_receipts(agent_id, id);
"""

VENDOR_PIN = "c8b4a4c59621678b8b5c544b20ebd0149ebddae004e03ea44f0c4c5dc1a43ca0"   # omegamatch skill_metadata.py 0.1.1-candidate
CORE_GLOBS = ("skill_affordance*.metta", "skill_catalog*.metta", "skill_signatures*.metta")
MAX_BODY = 512 * 1024
MAX_SKILLS, MAX_MODULES = 2048, 64
NAME = re.compile(r"[A-Za-z0-9_.:+*<>=!?/-]{1,96}\Z")
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
DIR = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
RECEIPT_KEYS = {"boot_id", "boot_nonce", "pid", "loader", "core", "modules", "provides", "parser"}
MODULE_KEYS = {"dir", "id", "version", "source_digest", "configured", "loaded", "signature_heads"}

# Skills that reach a model provider other than the mind's own chat loop.  The mind calls the vendor directly with
# its own environment key, and this build has no host-side metering route for media: the route is unknown, never guessed.
PROVIDER_SKILLS = {"generate-image": "image", "generate-image-quality": "image", "generate-video": "video",
                   "observe-image": "vision", "inspect-image": "vision"}

# Reasoning activity, counted from a mind's recorded commands (traces).
REASONING = {"nal": lambda s: s == "nal-step", "pln": lambda s: s == "pln-step",
             "nars": lambda s: s.startswith("nars-"), "metta": lambda s: s == "metta"}
BELIEF_WRITES = {"mind": {"belief-claim", "belief-derived", "assimilate-belief"}, "commons": {"hive-publish"}}


def source_digest(files):
    """sha256 over (name, sha256 of bytes) of the given files in name order; identical on the mind side."""
    h = hashlib.sha256()
    for path in sorted(files, key=lambda p: p.name):
        h.update(path.name.encode() + b"\0" + hashlib.sha256(path.read_bytes()).hexdigest().encode() + b"\n")
    return "sha256:" + h.hexdigest()


def module_files(root, directory):
    return sorted((pathlib.Path(root) / "modules" / directory).glob("*.metta"))


def core_files(root):
    return sorted(p for pattern in CORE_GLOBS for p in (pathlib.Path(root) / "src").glob(pattern))


def revision_of(body):
    return "sha256:" + hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Inventory:
    def __init__(self, hive):
        self.hive = hive
        with hive.db._lock:
            hive.db._conn.executescript(SCHEMA)
            cols = {r[1] for r in hive.db._conn.execute("PRAGMA table_info(inventory_receipts)")}
            if "generation" not in cols:
                hive.db._conn.execute("ALTER TABLE inventory_receipts ADD COLUMN generation INTEGER")
            if "boot_nonce" not in cols:
                # TEXT, not the INTEGER generation column: SQLite would coerce an all-digit hex nonce (OmegaReview P3).
                # Rows from before this column have no nonce and so are never current.
                hive.db._conn.execute("ALTER TABLE inventory_receipts ADD COLUMN boot_nonce TEXT")
        self.cache = {}   # (module id, source digest) -> extracted metadata offers

    @property
    def db(self):
        return self.hive.db

    # ---- the boot receipt ------------------------------------------------------------------

    def _bad(self, message):
        return self.hive.error(400, "invalid_receipt", message)

    def validate(self, data):
        """The receipt in its canonical form, or a 400.  Exact shape: unknown keys are refused, so a mind cannot
        put free text in front of its owner."""
        if not isinstance(data, dict) or set(data) - RECEIPT_KEYS or not {"boot_id", "modules", "parser"} <= set(data):
            raise self._bad("a receipt has boot_id, modules and parser, and optionally pid, loader, core and provides")
        boot_id = data["boot_id"]
        if not isinstance(boot_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", boot_id):
            raise self._bad("boot_id is 1-64 letters, digits, dashes or underscores")
        out = {"boot_id": boot_id}
        nonce = data.get("boot_nonce")
        if nonce is not None:
            if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32}", nonce):
                raise self._bad("boot_nonce is the 32-hex nonce the hive issued for this connection")
            out["boot_nonce"] = nonce
        if data.get("pid") is not None:
            if not isinstance(data["pid"], int) or isinstance(data["pid"], bool) or not 0 < data["pid"] < 2 ** 31:
                raise self._bad("pid is a positive integer")
            out["pid"] = data["pid"]
        for key in ("loader", "core"):
            if data.get(key) is not None:
                value = data[key]
                if not isinstance(value, dict) or set(value) - {"ref", "source_digest"} or not HASH.match(str(value.get("source_digest"))):
                    raise self._bad(f"{key} is {{ref?, source_digest: sha256:...}}")
                if "ref" in value and (not isinstance(value["ref"], str) or not 0 < len(value["ref"]) <= 200):
                    raise self._bad(f"{key}.ref is a short string")
                out[key] = value
        modules = data["modules"]
        if not isinstance(modules, list) or len(modules) > MAX_MODULES:
            raise self._bad(f"modules is a list of at most {MAX_MODULES}")
        clean = []
        for m in modules:
            if not isinstance(m, dict) or set(m) - MODULE_KEYS or not DIR.match(str(m.get("dir"))):
                raise self._bad("each module has a dir and only dir, id, version, source_digest, configured, loaded, signature_heads")
            if m.get("id") is not None and not NAME.match(str(m["id"])):
                raise self._bad("module id is a plain name")
            if m.get("version") is not None and not re.fullmatch(r"[A-Za-z0-9._+-]{1,32}", str(m["version"])):
                raise self._bad("module version is a plain version string")
            if m.get("source_digest") is not None and not HASH.match(str(m["source_digest"])):
                raise self._bad("module source_digest is sha256:<hex>")
            if not all(isinstance(m.get(k, False), bool) for k in ("configured", "loaded")):
                raise self._bad("configured and loaded are booleans")
            heads = m.get("signature_heads") or []
            if not isinstance(heads, list) or len(heads) > MAX_SKILLS or not all(NAME.match(str(h)) for h in heads):
                raise self._bad("signature_heads is a list of skill names")
            clean.append({**m, "configured": bool(m.get("configured", True)), "loaded": bool(m.get("loaded", False)),
                          "signature_heads": sorted(set(heads))})
        out["modules"] = clean
        provides = data.get("provides") or []
        if not isinstance(provides, list) or len(provides) > MAX_SKILLS:
            raise self._bad(f"provides is a list of at most {MAX_SKILLS} [module id, skill] pairs")
        pairs = set()
        for pair in provides:
            if not isinstance(pair, list) or len(pair) != 2 or not all(NAME.match(str(x)) for x in pair):
                raise self._bad("provides holds [module id, skill] pairs of plain names")
            pairs.add((pair[0], pair[1]))
        out["provides"] = sorted([list(p) for p in pairs])
        parser = data["parser"]
        if not isinstance(parser, dict) or len(parser) > MAX_SKILLS:
            raise self._bad(f"parser maps at most {MAX_SKILLS} skill heads to their argument lists")
        heads = {}
        for name, args in parser.items():
            if not NAME.match(str(name)) or not isinstance(args, list) or len(args) > 32:
                raise self._bad("parser heads are plain names with short argument lists")
            rows = []
            for arg in args:
                if (not isinstance(arg, list) or len(arg) != 2 or not NAME.match(str(arg[0]))
                        or not (isinstance(arg[1], str) and len(arg[1]) <= 64 or isinstance(arg[1], list) and len(arg[1]) <= 16
                                and all(isinstance(x, str) and len(x) <= 64 for x in arg[1]))):
                    raise self._bad("a parser argument is [type, name]")
                rows.append([arg[0], arg[1]])
            heads[str(name)] = rows
        out["parser"] = dict(sorted(heads.items()))
        if len(json.dumps(out)) > MAX_BODY:
            raise self._bad("receipt too large")
        return out

    def record(self, agent, data):
        """Store a boot receipt for this mind.  An identical receipt that is still current is not stored twice."""
        if agent.get("kind") == "module":
            raise self.hive.error(400, "external_member", "an outside member has no boot receipt; it runs no skills of ours")
        body = self.validate(data)
        revision = revision_of(body)
        current = getattr(self.hive, "boot_nonce", {}).get(agent["id"])
        if not current or body.get("boot_nonce") != current:
            # Built for another connection (delayed, replayed or from before a restart): not evidence about this one.
            raise self.hive.error(409, "stale_boot", "the receipt must echo the hive's nonce for this connection; fetch it and resend")
        latest = self.db.one("SELECT * FROM inventory_receipts WHERE agent_id = ? ORDER BY id DESC LIMIT 1", (agent["id"],))
        if (latest and latest["revision"] == revision and latest["stale_at"] is None
                and latest.get("boot_nonce") == current and latest["boot_id"] == body["boot_id"]):
            return {"inventory_revision": revision, "loaded_at": latest["received_at"], "stored": False}
        # A boot id this mind already reported belongs to an earlier boot: a replay or a late delivery, never evidence
        # about the current process (OmegaReview 2026-10-04).  Status stays stale/unknown instead.
        if self.db.one("SELECT 1 FROM inventory_receipts WHERE agent_id = ? AND boot_id = ?", (agent["id"], body["boot_id"])):
            raise self.hive.error(409, "receipt_replayed", "this boot id was already reported; a new boot sends a new receipt")
        at = now()
        self.db.insert("inventory_receipts", {"agent_id": agent["id"], "revision": revision, "boot_id": body["boot_id"],
                                              "received_at": at, "body": json.dumps(body, sort_keys=True),
                                              "boot_nonce": current})
        return {"inventory_revision": revision, "loaded_at": at, "stored": True}

    def invalidate(self, agent_id, reason=None):
        """A mind that is starting, stopped or failed no longer matches its last receipt.  The receipt is kept; it just
        stops being evidence about a running process."""
        self.db.execute("UPDATE inventory_receipts SET stale_at = ? WHERE agent_id = ? AND stale_at IS NULL", (now(), agent_id))

    # ---- source metadata (Match's extractor, digest-checked) ---------------------------------

    def _extract(self, module_id, files, expected):
        """Match's offers for a module source set, only when the bytes on this host are the bytes the mind loaded."""
        if not files or expected is None or source_digest(files) != expected:
            return None
        key = (module_id, expected)
        if key not in self.cache:
            from .vendor import omegamatch_skill_metadata as match
            sources = [{"ref": p.name, "text": p.read_text(encoding="utf-8", errors="replace")} for p in files]
            self.cache[key] = {o["name"]: o for o in match.project_module_metadata(module_id, sources)["offers"]}
            if len(self.cache) > 128:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def _offers(self, receipt):
        """({skill: (module id or 'core', offer)}, {module dir: verified}) from sources that match the receipt."""
        root = self.hive.settings.core_root
        found, verified = {}, {}
        if receipt and receipt.get("core"):
            offers = self._extract("core", core_files(root), receipt["core"]["source_digest"])
            verified["core"] = offers is not None
            for name, offer in (offers or {}).items():
                found[name] = ("core", offer)
        for m in (receipt or {}).get("modules", []):
            offers = self._extract(m.get("id") or m["dir"], module_files(root, m["dir"]), m.get("source_digest")) if m.get("id") else None
            verified[m["dir"]] = offers is not None
            for name, offer in (offers or {}).items():
                found.setdefault(name, (m["id"], offer))
        return found, verified

    # ---- the view --------------------------------------------------------------------------

    def _provider(self, agent, at):
        hive = self.hive
        payer, _ = hive.payer_for(agent)
        owner = agent.get("owner") or ""
        kind = "hive" if payer == "hive" else "mind-owner" if payer == owner else "session-owner"
        scopes = [f"{s}:{p}" for s, p, _l, _o in hive.budgets.applicable(agent, None, payer, False)]
        scopes = (["agent:%s:total" % agent["id"]] if hive.budgets.lifetime_cap_applies(agent, None, payer, False) else []) + scopes + (["hive:hard-total"] if hive.budgets.hard_cap() else [])
        last = self.db.one("SELECT resolved_model FROM usage WHERE agent_id = ? AND resolved_model IS NOT NULL ORDER BY id DESC LIMIT 1",
                           (agent["id"],))
        return {"model": agent["model"], "resolved_model": last["resolved_model"] if last else None, "payer_kind": kind,
                "budget_route": list(dict.fromkeys(scopes)), "budget_route_note": "key and person scopes join when a call is made with a key",
                "snapshot_at": at}

    def _route(self, skill, provider):
        kind = PROVIDER_SKILLS.get(skill)
        if kind is None:
            return {"kind": "none-declared"}
        settings = getattr(self.hive, "settings", None)
        if getattr(settings, "media_route", False):
            from .media import OPS, MediaError, pin
            op = next((o for o, s in OPS.items() if s == skill), None)
            try:
                pinned = pin(settings, op) if op else None
            except MediaError:
                pinned = None
            if pinned:
                return {"kind": kind, "budget_route": "reservations", "host_metered": True, "route": "/llm/v1/media",
                        "op": op, "model": pinned["model"], "endpoint_provider": pinned["endpoint"]["provider_slug"]}
        return {"kind": kind, "budget_route": "unknown", "host_metered": False,
                "note": "the mind calls the vendor directly; no host metering route for media in this build"}

    def _dynamic(self, agent):
        provider = getattr(self.hive.flows, "agent_dynamic_inventory", None)
        if provider is None:
            return [], "not-installed"
        try:
            rows = provider(agent)
        except Exception as exc:   # the flow policy refusing, or a token no longer current
            return [], "refused:" + str(getattr(exc, "code", "error"))[:60]
        return [{"kind": r["kind"], "id": r["id"], "registry_revision": r["registry_revision"],
                 "swarm_id": agent.get("swarm_id"), "status": "unknown"} for r in rows], "ok"

    def view(self, agent_id):
        hive = self.hive
        agent = hive._agent_row(agent_id)
        at = now()
        row = self.db.one("SELECT * FROM inventory_receipts WHERE agent_id = ? ORDER BY id DESC LIMIT 1", (agent_id,))
        receipt = json.loads(row["body"]) if row else None
        running = agent["status"] == "awake"
        if receipt is None:
            availability, stale_reason = "no-boot-receipt", None
        elif (row["stale_at"] is not None or not running
              or row.get("boot_nonce") != getattr(self.hive, "boot_nonce", {}).get(agent_id)):
            availability = "receipt-stale"
            stale_reason = "the mind restarted or stopped since this receipt" if row["stale_at"] is not None else f"the mind is {agent['status']}"
        else:
            availability, stale_reason = "boot-receipt", None
        attested = availability == "boot-receipt"
        found, verified = self._offers(receipt)
        provider = self._provider(agent, at)
        dynamic, dynamic_status = self._dynamic(agent)
        module_rows = {m["id"]: m for m in (receipt or {}).get("modules", []) if m.get("id")}
        owner_of = {}
        for m in (receipt or {}).get("modules", []):
            for head in m["signature_heads"]:
                owner_of[head] = m
        provides = {tuple(p) for p in (receipt or {}).get("provides", [])}
        parser = (receipt or {}).get("parser", {})
        names = set(parser) | {s for _m, s in provides} | set(found)
        if receipt is None and agent["kind"] == "module":
            names = set()   # an outside member runs none of our skills; nothing to list
        skills = []
        for name in sorted(names):
            module_id, offer = found.get(name, (None, None))
            m = owner_of.get(name) or module_rows.get(module_id)
            if m is None:
                module_id = next((mid for mid, s in sorted(provides) if s == name), module_id)
                m = module_rows.get(module_id)
            if m is not None:
                module_id = m.get("id") or m["dir"]
            declared = module_id is not None and (module_id, name) in provides
            in_parser = name in parser
            status = "unknown"
            if attested and receipt is not None:
                if m is None:
                    status = "callable" if in_parser else "unknown"   # a core head
                elif not m["loaded"]:
                    status = "configured" if m["configured"] else "unknown"
                elif in_parser:
                    status = "callable"
                elif declared or offer is not None:
                    status = "imported"
            mode, reason = hive.policy.decide(agent, name)
            skills.append({
                "id": name, "module": module_id or ("core" if in_parser and receipt else None),
                "signature": {"parser": parser.get(name), "declared": None if offer is None else {
                    "rule_head_shapes": offer["rule_head_shapes"], "typed_signature_declarations": offer["typed_signature_declarations"],
                    "signature_conflict_unresolved": offer["signature_conflict_unresolved"], "basis": offer["signature_basis"]}},
                "help": None if offer is None else offer["skill_help"], "topic": None if offer is None else offer["topics"],
                "effects": None if offer is None else offer["effects"], "risk": None if offer is None else offer["risks"],
                "metadata": "verified-source" if offer is not None else "unverified",
                "status": status, "policy": {"decision": mode, "reason": reason, "snapshot_at": at},
                "route": self._route(name, provider)})
        return {"mind_id": agent_id, "kind": agent["kind"], "availability": availability, "stale_reason": stale_reason,
                "inventory_revision": row["revision"] if row else None, "loaded_at": row["received_at"] if row else None,
                "process": {"boot_id": receipt["boot_id"], "pid": receipt.get("pid")} if receipt else None,
                "modules": [{"id": m.get("id") or m["dir"], "version": m.get("version"), "source_digest": m.get("source_digest"),
                             "configured": m["configured"], "loaded": m["loaded"], "source_verified": verified.get(m["dir"], False)}
                            for m in (receipt or {}).get("modules", [])],
                "core": {"source_digest": receipt["core"]["source_digest"], "source_verified": verified.get("core", False)}
                if receipt and receipt.get("core") else None,
                "skills": skills, "dynamic": dynamic, "dynamic_status": dynamic_status, "provider": provider,
                "snapshot_at": at, "vendor_pin": VENDOR_PIN}

    # ---- reasoning activity (the dormancy meter) -------------------------------------------

    def activity(self, agent_id, cycles=30):
        """Per mind, over its last ``cycles`` recorded cycles: how often it ran NAL, PLN, NARS and MeTTa, and wrote beliefs.
        Counted from recorded commands.  ``ran`` excludes commands the policy gate denied or held for an answer;
        ``attempted`` includes them.  Dormant means none ran in the window; it says nothing about quality."""
        self.hive._agent_row(agent_id)
        cycles = min(max(int(cycles), 1), 200)
        rows = self.db.all("SELECT id, iteration, commands, created_at FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
                           (agent_id, cycles))
        counts = {k: {"attempted": 0, "ran": 0} for k in REASONING}
        writes = {k: {"attempted": 0, "ran": 0} for k in BELIEF_WRITES}
        for r in rows:
            try:
                commands = json.loads(r["commands"])
            except ValueError:
                continue
            for c in commands:
                skill = command_skill(c.get("command", ""))
                if not skill:
                    continue
                ran = c.get("gated") in (None, "allow")
                for k, test in REASONING.items():
                    if test(skill):
                        counts[k]["attempted"] += 1
                        counts[k]["ran"] += ran
                for k, names in BELIEF_WRITES.items():
                    if skill in names:
                        writes[k]["attempted"] += 1
                        writes[k]["ran"] += ran
        total = {k: sum(v["ran"] for v in group.values()) for k, group in (("reasoning", counts), ("belief_writes", writes))}
        return {"mind_id": agent_id, "cycles_requested": cycles, "cycles_observed": len(rows),
                "since": rows[-1]["created_at"] if rows else None, "until": rows[0]["created_at"] if rows else None,
                "reasoning": counts, "belief_writes": writes, "belief_writes_ran": total["belief_writes"],
                "reasoning_ran": total["reasoning"],
                "dormant": bool(rows) and total["reasoning"] == 0 and total["belief_writes"] == 0,
                "basis": "recorded commands in this mind's traces (not the mind's own memory)"}
