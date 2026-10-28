"""Where a mind lives, and moving it between hives (the owner, 2026-10-04: minds and swarms move between home and cloud at will).

A mind is its workspace (memory, vector memory), its records here (who it is, its conversation, its wakeups, its own
rules) and a connection to the hive it runs under. Moving it:
  export   the source packs a bundle: manifest.json (records + sha256 of every file) + workspace/ (never its token,
           its log, its temp files or its runtime links). The mind must be stopped.
  import   the destination checks every hash, refuses anything that is not a plain file under workspace/, and
           brings the mind to life with the SAME id and a fresh token. Moving back to a hive that has its tombstone
           restores that same mind there.
  settle   the source marks the mind "moved to <hive>" (a tombstone: its history stays readable, it cannot start).
Each hive writes the mind's body descriptor (modules/body_container reads it through OMEGACLAW_BODY_CONTAINER_CONFIG):
which hive it runs under, home or cloud, whose machine. A move is a body change the mind can see in its own atoms.
Every move is evidence in the placement commons, (--> (x <mind> <hive>) placed), for NAL revision and advice later.
Truth and Atlas data never travel in a bundle: a mind's workspace is its own memory only.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import pathlib
import platform
import secrets
import shutil
import tarfile
import time

from .db import new_id, now
from .governance_evidence import GovernanceEvidence, symbol

FORMAT = "omegahive.mind/1"
SKIP_TOP = {"token", "tmp", "mind.pid", "agent.log", "repos", "run.metta"}
MAX_BUNDLE = 512 * 1024 * 1024
MAX_UNPACKED = 2 * 1024 ** 3
WAKEUP_FIELDS = ("id", "cron", "at", "tz", "text", "enabled", "next_run_at", "last_run_at", "created_at")


def _has_bang(data):
    """True when a MeTTa file has a top-level !(...) line, which PeTTa would run at load."""
    for line in data.decode("utf-8", "replace").splitlines():
        if line.lstrip().startswith("!"):
            return True
    return False
MESSAGES_KEPT = 2000


def placed_statement(agent_id, hive_id):
    return f"(--> (x {symbol(agent_id)} {symbol(hive_id)}) placed)"

log = logging.getLogger(__name__)


class Placement:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute("CREATE TABLE IF NOT EXISTS hive_identity (id TEXT PRIMARY KEY, name TEXT NOT NULL, home INTEGER NOT NULL DEFAULT 0, "
                        "owner TEXT, created_at TEXT NOT NULL)")
        hive.db.execute("CREATE TABLE IF NOT EXISTS mind_moves (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, direction TEXT NOT NULL, "
                        "other_hive TEXT, other_name TEXT, manifest_sha256 TEXT, status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)")
        cols = {r["name"] for r in hive.db.all("PRAGMA table_info(agents)")}
        for column in ("moved_to", "moved_to_name", "moved_at"):
            if column not in cols:
                hive.db.execute(f"ALTER TABLE agents ADD COLUMN {column} TEXT")
        self.evidence = GovernanceEvidence(hive, commons="placement")

    # ---- this hive -------------------------------------------------------------------------------------

    def identity(self):
        row = self.hive.db.one("SELECT * FROM hive_identity LIMIT 1")
        if row is None:
            row = {"id": "h_" + secrets.token_hex(4), "name": self.hive.name, "home": 0, "owner": None, "created_at": now()}
            self.hive.db.insert("hive_identity", row)
        return {"id": row["id"], "name": row["name"], "home": bool(row["home"]), "owner": row["owner"]}

    def set_identity(self, name=None, home=None, owner=None):
        me = self.identity()
        values = {}
        if name is not None:
            values["name"] = str(name).strip()[:80] or me["name"]
        if home is not None:
            values["home"] = 1 if home else 0
        if owner is not None:
            values["owner"] = owner
        if values:
            self.hive.db.execute("UPDATE hive_identity SET " + ", ".join(f"{k} = ?" for k in values) + " WHERE id = ?",
                                 (*values.values(), me["id"]))
        return self.identity()

    def write_body(self, agent_id):
        """The body descriptor for this mind under this hive (read by modules/body_container)."""
        me = self.identity()
        root = self.hive.settings.data_dir / "agents" / agent_id
        path = root / "memory" / "runtime" / "body" / "host.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "status": "present", "launcher": "omegahive", "hive_id": me["id"], "hive_name": me["name"],
            "placement": "home" if me["home"] else "cloud", "owner": me["owner"],
            "machine": {"system": platform.system(), "machine": platform.machine()},
            "atoms": [f"(RunsUnder {symbol(agent_id)} {symbol(me['id'])})",
                      f"(Placement {symbol(me['id'])} {'home' if me['home'] else 'cloud'})"],
            "written_at": now(),
        }, indent=2), encoding="utf-8")
        return path

    # ---- export ------------------------------------------------------------------------------------------

    def export(self, agent_id, reader=None, mark=None, by=None):
        """reader: a principal whose readable rows (Hive.reader_scope) are the only messages carried, for a personal
        mind exported by anyone but an admin's explicit audit, its person included (app.py export_mind); None carries
        them all.
        mark: detail.personal_conversations in the manifest and the move record ("excluded", "included_person",
        "included_audited"), None for a mind that is not personal."""
        row = self.hive._agent_row(agent_id)
        if row.get("moved_to"):
            raise self.hive.error(409, "moved", f"this mind now lives on {row.get('moved_to_name') or row['moved_to']}")
        if row["kind"] not in ("omega", "iter"):
            raise self.hive.error(400, "not_portable", "only minds that run in a hive can move; an outside member just reconnects")
        if row["status"] not in ("created", "stopped", "asleep", "error"):
            raise self.hive.error(409, "mind_running", "stop or sleep the mind before moving it")
        root = self.hive.settings.data_dir / "agents" / agent_id
        messages = self._messages(agent_id, reader)
        files = {}
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for path in sorted(root.rglob("*")) if root.exists() else []:
                rel = path.relative_to(root)
                if rel.parts[0] in SKIP_TOP or path.is_symlink() or not path.is_file():
                    continue
                if rel.parts[:3] == ("memory", "runtime", "body"):
                    continue                                    # the body belongs to the hive it runs under
                data = path.read_bytes()
                files["workspace/" + rel.as_posix()] = hashlib.sha256(data).hexdigest()
                info = tarfile.TarInfo("workspace/" + rel.as_posix())
                info.size, info.mode, info.mtime = len(data), 0o600, int(path.stat().st_mtime)
                tar.addfile(info, io.BytesIO(data))
            manifest = {
                "format": FORMAT, "exported_at": now(), "from": self.identity(),
                "mind": {k: row.get(k) for k in ("id", "name", "kind", "model", "persona", "options", "hue", "budget_usd",
                                                 "idle_sleep_minutes", "owner", "visibility", "shared_with", "created_at",
                                                 "personal_of")},
                "role": self._role(row),
                "swarm": self._swarm(row),
                "messages": messages,
                "conversation_owners": self._conversation_owners(agent_id, messages),
                "wakeups": self.hive.db.all("SELECT * FROM wakeups WHERE agent_id = ?", (agent_id,)),
                "rules": [r for r in self.hive.db.all("SELECT scope, skill, mode, note, expires_at, origin FROM policy_rules WHERE scope = ?",
                                                      (f"agent:{agent_id}",))
                          if not str(r["note"] or "").startswith("attachment:") and not (r["expires_at"] and r["expires_at"] < time.time())],
                "files": files,
            }
            if mark:
                manifest["detail"] = {"personal_conversations": mark}
            data = json.dumps(manifest, indent=1).encode()
            info = tarfile.TarInfo("manifest.json")
            info.size, info.mode = len(data), 0o600
            tar.addfile(info, io.BytesIO(data))
        bundle = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        self.hive.db.insert("mind_moves", {"id": new_id("mv"), "agent_id": agent_id, "direction": "out", "other_hive": None,
                                           "other_name": None, "manifest_sha256": digest, "status": "exported",
                                           "detail": json.dumps({"bytes": len(bundle), "files": len(files),
                                                                 **({"personal_conversations": mark, "by": by} if mark else {})}),
                                           "created_at": now()})
        return bundle, digest

    def _messages(self, agent_id, reader=None):
        """The rows a bundle carries (the newest MESSAGES_KEPT). With a reader, only what that person may read of the
        mind's chats (Hive.reader_scope, the transcript's own rule), and no Ask turn but their own."""
        scope, params = self.hive.reader_scope(agent_id, reader) if reader else ("", [])
        rows = self.hive.db.all(f"SELECT * FROM (SELECT * FROM messages WHERE agent_id = ?{scope} "
                                "ORDER BY created_at DESC LIMIT ?) ORDER BY created_at", (agent_id, *params, MESSAGES_KEPT))
        # A conversation owned by its first person speaker (Hive.conversation_owner) keeps that defining row even when
        # it is older than the newest MESSAGES_KEPT, so the destination attributes the conversation's tail exactly as
        # this hive does (stand-in idle-minds r2.3 P1 #3). Same reader scope: a reader never gains a row by this.
        have = {r["id"] for r in rows}
        anchors = []
        for c in sorted({r["conversation_id"] for r in rows if self._person_first(agent_id, r["conversation_id"])}):
            first = self.hive.db.one(f"SELECT * FROM messages WHERE agent_id = ?{scope} AND conversation_id = ? "
                                     "AND direction = 'in' AND sender LIKE 'user:%' ORDER BY created_at, rowid LIMIT 1",
                                     (agent_id, *params, c))
            if first and first["id"] not in have:
                anchors.append(first)
        rows = sorted(anchors, key=lambda r: r["created_at"]) + rows if anchors else rows
        if reader:
            ask = getattr(self.hive, "ask", None)
            rows = [r for r in rows if not str(r["conversation_id"] or "").startswith("ask:")
                    or (ask is not None and ask.asker(r["conversation_id"]) == reader)]
        return rows

    def _person_first(self, agent_id, conversation_id):
        """Whether Hive.conversation_owner judges this conversation by its first person speaker (not the operator's
        c_<mind>, not one named c_<mind>~<person>, not a room or an Ask turn)."""
        c = str(conversation_id or f"c_{agent_id}")
        return c != f"c_{agent_id}" and not c.startswith(f"c_{agent_id}~") and not self.hive._shared_conversation(agent_id, c)

    def _conversation_owners(self, agent_id, messages):
        """Every carried conversation's owner as this hive resolves it from its whole history, not only the carried
        rows (stand-in idle-minds r2.3 P1 #3). Import refuses a bundle whose rows would be attributed otherwise."""
        out = {}
        for c in sorted({m["conversation_id"] or f"c_{agent_id}" for m in messages}):
            owner = self.hive.conversation_owner(agent_id, c)
            if owner:
                out[c] = owner
        return out

    def _role(self, row):
        if not row.get("role_id"):
            return None
        r = self.hive.db.one("SELECT * FROM roles WHERE id = ?", (row["role_id"],)) \
            if self.hive.db.one("SELECT name FROM sqlite_master WHERE name = 'roles'") else None
        return {k: r.get(k) for k in ("id", "name")} if r else None

    def _swarm(self, row):
        if not row.get("swarm_id"):
            return None
        s = self.hive.db.one("SELECT id, name FROM swarms WHERE id = ?", (row["swarm_id"],))
        return dict(s) if s else None

    # ---- import ------------------------------------------------------------------------------------------

    def read_bundle(self, bundle):
        if len(bundle) > MAX_BUNDLE:
            raise self.hive.error(413, "too_big", "a mind bundle is at most 512 MB")
        try:
            tar = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
            members = tar.getmembers()
        except (tarfile.TarError, OSError, EOFError):
            raise self.hive.error(400, "bad_bundle", "not a mind bundle") from None
        contents = {}
        total = 0
        for m in members:
            name = m.name
            if not m.isfile() or name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts \
                    or not (name == "manifest.json" or name.startswith("workspace/")):
                raise self.hive.error(400, "bad_bundle", f"refused entry {name!r}: only plain files under workspace/")
            total += m.size
            if total > MAX_UNPACKED:
                raise self.hive.error(413, "too_big", "a mind bundle unpacks to at most 2 GB")
            contents[name] = tar.extractfile(m).read()
        try:
            manifest = json.loads(contents.pop("manifest.json"))
        except (KeyError, ValueError):
            raise self.hive.error(400, "bad_bundle", "the bundle has no readable manifest") from None
        if manifest.get("format") != FORMAT:
            raise self.hive.error(400, "bad_bundle", f"unknown bundle format {manifest.get('format')!r}")
        if set(contents) != set(manifest.get("files") or {}):
            raise self.hive.error(400, "bad_bundle", "the bundle's files do not match its manifest")
        for name, data in contents.items():
            if hashlib.sha256(data).hexdigest() != manifest["files"][name]:
                raise self.hive.error(400, "bad_bundle", f"{name} does not match its hash")
        return manifest, contents

    def import_(self, bundle, swarm_id=None, owner=None, by=None, may_use_key=None, tools_ok=True):
        manifest, contents = self.read_bundle(bundle)
        mind = manifest["mind"]
        agent_id = str(mind["id"])
        if not agent_id.startswith("a_") or not agent_id[2:].isalnum():
            raise self.hive.error(400, "bad_bundle", "bad mind id")
        existing = self.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        if existing and not existing.get("moved_to") and not existing["deleted"]:
            raise self.hive.error(409, "already_here", f"{mind['name']} already lives on this hive")
        if existing and owner and existing.get("owner") and existing["owner"] != owner:
            raise self.hive.error(403, "not_yours", "that mind id belonged to someone else here; an admin can bring it back")
        self._refuse_unbound_personal(mind, existing)
        # OI-13: the bundle's options carry the key that pays; a member never brings a mind in on another person's key
        # (may_use_key: the app's key_permit for the importer; the key the returning mind already had here is kept).
        # r1.1: then validated exactly as create validates them (Hive._options: shape, a key this hive holds for the
        # mind's provider, else 404 unknown_key), tools admin-only (tools_ok) and preflighted; stored clean.
        model = mind.get("model") or self.hive.settings.default_model
        raw = mind.get("options")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw) if raw.strip() else None
            except ValueError:
                raise self.hive.error(400, "bad_options", "options must be a JSON object") from None
        try:
            from .providers import clean_options
            wanted = clean_options(raw)
        except ValueError as exc:
            raise self.hive.error(400, "bad_options", str(exc)) from None
        self.hive.check_key_use(wanted.get("key"), may_use_key, _options_of(existing).get("key"))
        lock_owner = (existing or {}).get("owner") or owner or by
        self.hive.check_key_lock(lock_owner, _options_of(existing), wanted, by)   # app platform P3a: import too
        if wanted.get("tools") and not tools_ok:
            raise self.hive.error(403, "admin_only", "only a hive admin can do that")
        options = self.hive._options(wanted, model)
        self.hive.validate_tools(mind.get("kind"), options, model, agent_id if existing else None)
        for name, data in contents.items():               # memory files are loaded as MeTTa at boot: atoms only
            if name.startswith("workspace/memory/") and name.endswith(".metta") and _has_bang(data):
                raise self.hive.error(400, "bad_bundle", f"{name} contains executable !(...) lines; memory must be atoms only")
        swarm_id = swarm_id or (existing or {}).get("swarm_id") or ((manifest.get("swarm") or {}).get("id"))
        if not swarm_id or not self.hive.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)):
            raise self.hive.error(400, "swarm_required", "choose a swarm on this hive for the mind to join")
        self.hive.require_open_swarm(swarm_id)
        root = self.hive.settings.data_dir / "agents" / agent_id
        root.parent.mkdir(parents=True, exist_ok=True)
        # Stage first, beside the target, touching nothing live (stand-in r6): the swap happens only under the mind's
        # lock and the swarms' fences, after the row is re-validated, and is undone if the write does not land.
        staged = root.parent / f".{agent_id}.staged-{secrets.token_hex(6)}"
        try:
            staged.mkdir(mode=0o700)
            for name, data in contents.items():
                dest = staged / name[len("workspace/"):]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                dest.chmod(0o600)
        except BaseException:
            shutil.rmtree(staged, ignore_errors=True)
            raise
        token = secrets.token_urlsafe(32)
        from .hive import HiveError, token_hash
        values = {
            "name": mind["name"], "kind": mind["kind"], "swarm_id": swarm_id, "model": mind["model"] or self.hive.settings.default_model,
            "persona": mind.get("persona") or "", "options": json.dumps(options) if options else None, "hue": int(mind.get("hue") or 0) % 360,
            "budget_usd": float(mind.get("budget_usd") or 0), "idle_sleep_minutes": mind.get("idle_sleep_minutes") or 0,
            "owner": owner or mind.get("owner"), "visibility": mind.get("visibility") or "private",
            "shared_with": mind.get("shared_with") or "[]", "status": "created", "desired": "stopped",
            "token_hash": token_hash(token), "deleted": 0, "moved_to": None, "moved_to_name": None, "moved_at": None,
        }
        expect = {k: existing.get(k) for k in ("swarm_id", "moved_to", "deleted")} if existing else None
        source_swarm = (existing or {}).get("swarm_id")
        aside, rules_added = None, False
        # One operation under the mind's lock and both swarms' fences, end to end (Platform rule on 3a2a609): re-check,
        # swap, every database effect in ONE transaction with the workspace and space effects; any failure rolls all of
        # it back (database by the transaction, workspace by the swap, spaces by compensation). After the commit, still
        # under the locks, only notifications and the placement evidence follow; their failures are logged, not undone.
        try:
            with self.hive._mind_lock(agent_id), self.hive.swarm_membership(swarm_id, source_swarm):
                fresh = self.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
                if (fresh is None) != (existing is None) or (fresh and any(fresh.get(k) != v for k, v in expect.items())):
                    raise HiveError(409, "placement_stale", "this mind changed meanwhile; try again")
                self._refuse_unbound_personal(mind, fresh)
                if fresh:   # P3a: the stored lock as it stands now, under the mind's lock, before anything is written
                    self.hive.check_key_lock(fresh.get("owner") or lock_owner, _options_of(fresh), wanted, by)
                    locked_here = _options_of(fresh).get("key_locked") or wanted.get("key_locked")
                    if locked_here and fresh.get("owner") and values.get("owner") != fresh.get("owner") \
                            and by != fresh.get("owner"):
                        # a key-locked mind changes owner only by its owner: else the new owner could unlock it
                        raise HiveError(403, "key_lock_owner_only", "only this mind's owner can give a key-locked mind away")
                if fresh and not fresh["deleted"] and fresh.get("swarm_id") != swarm_id:
                    self.hive.personal.refuse_move(fresh, swarm_id)      # a personal mind stays in its own swarm
                self.hive.personal.refuse_join(swarm_id, (fresh or {}).get("personal_of"))   # and holds no other mind
                if fresh and fresh["deleted"]:
                    self.hive.settle_cleanup_before_return(agent_id)   # its old deletion's cleanup never acts on it live
                if root.exists():          # the old workspace goes aside (never merged), and comes back on any failure
                    aside = root.parent / f".{agent_id}.before-{int(time.time())}-{secrets.token_hex(3)}"
                    os.rename(root, aside)
                os.rename(staged, root)
                spaces_done = []           # (op, swarm) applied, undone in reverse on failure
                try:
                    with self.hive.db.transaction():
                        if existing:   # a returning mind joins only an existing, open swarm, re-checked in the write
                            self.hive.update_in_open_swarm("agents", agent_id, values, swarm_id, expect=expect)
                        else:
                            self.hive.insert_into_open_swarm("agents", dict(values, id=agent_id, driver=self.hive.settings.default_driver,
                                                             spent_usd=0.0, created_at=mind.get("created_at") or now()), swarm_id)
                        seen = {r["id"] for r in self.hive.db.all("SELECT id FROM messages WHERE agent_id = ?", (agent_id,))}
                        # Rows keep their conversation ids, so each conversation keeps its owner (conversation_owner). A
                        # personal mind arrives only as its person's personal mind (_refuse_unbound_personal), so no
                        # row is withheld; every carried row lands or nothing does.
                        for m in manifest.get("messages") or []:
                            if m["id"] not in seen:
                                row = {k: m.get(k) for k in ("id", "conversation_id", "direction", "sender",
                                                             "text", "hub_seq", "client_seq", "created_at", "extra")}
                                self.hive.db.insert("messages", dict(row, agent_id=agent_id))   # never another mind's history
                        self._check_owners(agent_id, manifest)   # inside the transaction: a mismatch lands nothing
                        self.hive.db.execute("DELETE FROM wakeups WHERE agent_id = ?", (agent_id,))
                        for w in manifest.get("wakeups") or []:
                            row = {k: w.get(k) for k in WAKEUP_FIELDS if k in w}
                            self.hive.db.insert("wakeups", dict(row, agent_id=agent_id))
                        self.hive.db.execute("DELETE FROM policy_rules WHERE scope = ? AND (note IS NULL OR note NOT LIKE 'attachment:%')",
                                             (f"agent:{agent_id}",))
                        from .policy import EXPLICIT_ONLY
                        for r in manifest.get("rules") or []:
                            # A bundle carries only this mind's own rules. An allow travels only when an admin brings
                            # the mind in: a member cannot grant authority by writing it into a file. Deny and ask travel.
                            if r.get("scope") != f"agent:{agent_id}" or r.get("skill") in EXPLICIT_ONLY:
                                continue
                            if r.get("mode") == "allow" and owner:
                                continue
                            self.hive.policy.add_rule(f"agent:{agent_id}", r["skill"], r["mode"],
                                                      (r["note"] or "") + " (moved with the mind)", r.get("expires_at"),
                                                      origin="" if owner else (r.get("origin") or ""), publish=False,
                                                      granted_by=by or owner)   # host-identity r1.1: who brought it in
                            rules_added = True
                        digest = hashlib.sha256(json.dumps(manifest, indent=1).encode()).hexdigest()
                        source = manifest.get("from") or {}
                        self.hive.db.insert("mind_moves", {"id": new_id("mv"), "agent_id": agent_id, "direction": "in",
                                                           "other_hive": source.get("id"), "other_name": source.get("name"),
                                                           "manifest_sha256": digest, "status": "arrived",
                                                           "detail": json.dumps({"files": len(contents)}), "created_at": now()})
                        if self.hive.supervisor:
                            self.hive.supervisor.prepare(self.hive.agent(agent_id), token)   # writes into the new workspace
                        self.write_body(agent_id)
                        if source_swarm and source_swarm != swarm_id and self.hive.spaces.is_member(agent_id, source_swarm):
                            self.hive.spaces.revoke(agent_id, source_swarm)
                            spaces_done.append(("revoke", source_swarm))
                        if not self.hive.spaces.is_member(agent_id, swarm_id):
                            self.hive.spaces.grant(agent_id, swarm_id)
                            spaces_done.append(("grant", swarm_id))
                except BaseException:
                    for op, sid in reversed(spaces_done):   # compensate the space effects, then undo the swap
                        try:
                            (self.hive.spaces.revoke if op == "grant" else self.hive.spaces.grant)(agent_id, sid)
                        except Exception:   # noqa: BLE001
                            log.exception("placement rollback: could not undo %s of %s in %s", op, agent_id, sid)
                    os.rename(root, staged)                 # the staged copy (now with any prepared files) is removed below
                    if aside is not None:
                        os.rename(aside, root)
                        aside = None
                    raise
                for notify in (lambda: rules_added and self.hive.events.publish("policy.updated", rules=self.hive.policy.rules()),
                               lambda: self.evidence.record(f"in:{agent_id}:{digest[:16]}",
                                                            placed_statement(agent_id, self.identity()["id"]), True),
                               lambda: self.hive.events.publish("swarm.updated", swarm=self.hive.swarm(swarm_id)),
                               lambda: self.hive.emit_agent(agent_id)):
                    try:
                        notify()
                    except Exception:   # noqa: BLE001  the mind has arrived; a lost notification is logged, not undone
                        log.exception("placement of %s: a notification after the commit failed", agent_id)
                return {"agent": self.hive.agent(agent_id), "from": source, "manifest_sha256": digest}
        finally:
            shutil.rmtree(staged, ignore_errors=True)

    def _refuse_unbound_personal(self, mind, row):
        """A personal mind arrives only where it is its person's personal mind already (row: its row here, or None):
        returning home. Anywhere else nothing binds it to its person (personal_of, ownership), so its person's
        conversations could only be dropped or become readable by that hive's operator; the move is refused whole,
        never imported incomplete (stand-in idle-minds r2.3 P1 #2), until an authorised destination binding exists."""
        person = (mind or {}).get("personal_of")
        if person and not (row and not row.get("deleted") and row.get("personal_of") == person):
            raise self.hive.error(409, "personal_mind_unbound",
                                  f"{mind.get('name') or 'this mind'} is a person's personal mind; it can return to its "
                                  "own hive, but another hive cannot yet bind it to its person, so it cannot move there. "
                                  "Nothing was imported.")

    def _check_owners(self, agent_id, manifest):
        """After the rows are written: every conversation the bundle names an owner for resolves to that owner here
        (stand-in idle-minds r2.3 P1 #3). A bundle whose rows would be attributed otherwise (a tail without its
        defining row, or an edited manifest) is refused, and the transaction lands nothing."""
        owners = manifest.get("conversation_owners")
        if owners is None:
            return            # a bundle from before r2.5: no map to hold it to (a personal mind's is refused above)
        if not isinstance(owners, dict):
            raise self.hive.error(400, "bad_bundle", "conversation_owners is a map")
        for c, owner in sorted(owners.items()):
            if self.hive.conversation_owner(agent_id, c) != owner:
                raise self.hive.error(409, "conversation_owner_mismatch",
                                      f"conversation {c} would not belong to {owner} here; nothing was imported")

    # ---- settle ------------------------------------------------------------------------------------------

    def settle(self, agent_id, to_hive, to_name, manifest_sha256):
        """The destination has the mind: leave a tombstone here. Its history stays; it cannot start here."""
        row = self.hive._agent_row(agent_id)
        moves = self.hive.db.one("SELECT 1 FROM mind_moves WHERE agent_id = ? AND direction = 'out' AND manifest_sha256 = ?",
                                 (agent_id, manifest_sha256))
        if not moves:
            raise self.hive.error(409, "not_exported", "that bundle was not exported from this hive")
        # a fresh unknown token: the old one stops working here
        from .hive import token_hash
        fields = {"moved_to": to_hive, "moved_to_name": to_name, "moved_at": now(), "status": "moved", "desired": "stopped",
                  "token_hash": token_hash(secrets.token_urlsafe(32))}
        # The rule (Platform, on 3a2a609): the mind's lock, with or without a supervisor, and its swarm's fence, for the
        # stop, the tombstone and its notifications; the row is re-read under them.
        with self.hive._mind_lock(agent_id):
            row = self.hive._agent_row(agent_id)
            with self.hive.swarm_membership(row.get("swarm_id")):
                if self.hive.supervisor:      # stop and record together: reconcile cannot restart it between
                    self.hive.supervisor.stop(agent_id)
                with self.hive.db.transaction():
                    self.hive.db.update("agents", agent_id, fields)
                    self.hive.db.execute("UPDATE mind_moves SET status = 'settled', other_hive = ?, other_name = ? "
                                         "WHERE agent_id = ? AND manifest_sha256 = ?", (to_hive, to_name, agent_id, manifest_sha256))
                self.hive.emit_agent(agent_id)
                if row.get("swarm_id"):
                    self.hive.events.publish("swarm.updated", swarm=self.hive.swarm(row["swarm_id"]))
                return self.hive.agent(agent_id)

    def moves(self, agent_id):
        return [dict(m, detail=json.loads(m["detail"] or "{}"))
                for m in self.hive.db.all("SELECT * FROM mind_moves WHERE agent_id = ? ORDER BY created_at", (agent_id,))]


def _options_of(mind):
    """A mind's options as a dict (rows and bundles hold them as JSON text); anything unreadable as none."""
    value = (mind or {}).get("options")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}
