"""Motivations: the why above tasks (goals). Phase 1 of coordination/omegaui/MOTIVATIONS_TASKS_HOST_DESIGN_20261005.md (r3
plus the owner's Q1-Q7).

- A motivation is owned by a person (user:u_..), a team (swarm:s_.., scoped to that swarm) or the mind that named it
  (agent:a_.., scoped to the mind's swarm; owner Q2). Minds create only through the agent route / MCP tool, with owner,
  creator and swarm derived from the authenticated mind row inside the transaction; they read back only what they created.
- Links live in motivation_tasks (Q7: many per task). A link is association only: no goal serialiser, goal event, envelope,
  board, program ctx or mind output reads these tables (design 1.6); only this module does.
- readable/editable are the only predicates: lists, the get route, /api/tasks, its counts and cursors, link checks and both
  event rules use them. A hidden id answers exactly as a missing one.
- rev/updated_at change on content edits only; link changes bump the editor-only links_version and reach viewers only as a
  motivation.links event per (motivation, swarm), judged against stored rows (B3).
- parent_id (Q1) exists but every route refuses it while settings.motivation_hierarchy is off (the default).
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import tempfile

from fastapi import Request

from .db import new_id, now
from .goals import STATUSES
from .visibility import clean

SCHEMA = """
CREATE TABLE IF NOT EXISTS motivations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, swarm_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'private', shared_with TEXT NOT NULL DEFAULT '[]',
  rev INTEGER NOT NULL DEFAULT 1, links_version INTEGER NOT NULL DEFAULT 0, parent_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status_changed_at TEXT);
CREATE INDEX IF NOT EXISTS motivations_owner ON motivations(owner, status);
CREATE INDEX IF NOT EXISTS motivations_swarm ON motivations(swarm_id, status);
CREATE TABLE IF NOT EXISTS motivation_tasks (motivation_id TEXT NOT NULL, goal_id TEXT NOT NULL,
  linked_by TEXT NOT NULL, linked_at TEXT NOT NULL, PRIMARY KEY (motivation_id, goal_id));
CREATE INDEX IF NOT EXISTS motivation_tasks_goal ON motivation_tasks(goal_id);
CREATE TABLE IF NOT EXISTS motivation_ops (principal TEXT NOT NULL, operation_id TEXT NOT NULL, domain TEXT NOT NULL,
  digest TEXT NOT NULL, destination TEXT NOT NULL, source TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (principal, operation_id));
"""
STATES = ("active", "paused", "achieved", "retired")
LINKABLE = ("active", "paused")
OPS = ("link", "unlink", "move")
STATUS_ORDER = ("open", "claimed", "waiting", "submitted", "stalled", "done", "failed", "cancelled")
OP_ID = re.compile(r"[A-Za-z0-9_.:-]{8,120}")
MAX_LINK_GOALS, MAX_ID, CURSOR_MAX, MAX_LIMIT, KEY_BYTES = 200, 200, 512, 200, 32
READER = ("id", "title", "why", "owner", "swarm_id", "status", "visibility", "rev", "parent_id", "created_by", "created_at",
          "updated_at", "status_changed_at")
LINK_FIELDS = {"operation_id", "op", "goal_ids", "cascade", "from_motivation_id", "expected_to_rev", "expected_from_rev",
               "expected_to_links_version", "expected_from_links_version"}
DERIVED = {"owner", "swarm_id", "visibility", "shared_with", "created_by"}   # a mind never names these (Q2)
KEY_TYPES = {"priority": ((int, float), str, str), "updated": (str, str), "created": (str, str)}


def _canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _sha(value):
    return hashlib.sha256(_canon(value).encode()).hexdigest()


def _int(value):
    return type(value) is int


def _people(row):
    try:
        out = json.loads(row.get("shared_with") or "[]")
    except ValueError:
        return []
    return out if isinstance(out, list) else []


def _id(value):
    return isinstance(value, str) and 0 < len(value) <= MAX_ID


class _Creator:
    """Who is creating a row: `authorise()` re-judges the creator's right against rows read now, and is called first
    inside the insert transaction (Review B1 on 0d97c65); `may_read_parent(row)` is the Q1 parent check."""

    def __init__(self, authorise, may_read_parent):
        self.authorise, self.may_read_parent = authorise, may_read_parent


class Motivations:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        with self.db._lock:
            self.db._conn.executescript(SCHEMA)
        self._key = self._cursor_key(hive.settings.data_dir / "motivations-cursor.key")

    @staticmethod
    def _cursor_key(path):
        """Per-hive cursor MAC key, made at first start and kept in HIVE_DATA_DIR; deleting it invalidates every cursor.
        Review R1 on 0d97c65: the key is written in full to a private temporary file and only then linked into place, so the
        key path never exists empty or partial (a failed write leaves no key; of two overlapping starts one links and both
        read the same complete key). On reopen anything other than exactly KEY_BYTES bytes is refused at start (fail
        closed: the hive does not start with a weak or truncated MAC key; delete the file to make a new one)."""
        path = pathlib.Path(path)
        if not path.exists():
            fd, tmp = tempfile.mkstemp(prefix=".motivations-cursor.", dir=path.parent)   # mode 0600
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(secrets.token_bytes(KEY_BYTES))
                    f.flush()
                    os.fsync(f.fileno())
                with contextlib.suppress(FileExistsError):
                    os.link(tmp, path)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(tmp)
        key = path.read_bytes()
        if len(key) != KEY_BYTES:
            raise RuntimeError(f"{path} holds {len(key)} bytes, not a {KEY_BYTES}-byte cursor key; delete it to make a new one")
        return key

    def _err(self, status, code, message):
        return self.hive.error(status, code, message)

    def _missing(self):
        return self._err(404, "not_found", "no such motivation")

    def _row(self, mid):
        return self.db.one("SELECT * FROM motivations WHERE id = ?", (mid,)) if _id(mid) else None

    # ---- the one read predicate and the one edit predicate (design 1.3, plus agent:<id> rows for Q2) -------------------

    def _swarm_row(self, sid, cache=None):
        if cache is not None and sid in cache:
            return cache[sid]
        row = self.db.one("SELECT id, owner, visibility, shared_with, archived_at FROM swarms WHERE id = ?", (sid,)) if _id(sid) else None
        if cache is not None:
            cache[sid] = row
        return row

    def team_swarm(self, row, cache=None):
        """The swarm a team or mind-owned row answers to; None (fail closed) when missing or inconsistent."""
        owner, sid = row.get("owner") or "", row.get("swarm_id")
        if not sid or not owner.startswith(("swarm:", "agent:")) or (owner.startswith("swarm:") and owner[6:] != sid):
            return None
        return self._swarm_row(sid, cache)

    def readable(self, viewer, row, cache=None):
        if row is None:
            return False
        if viewer.admin:
            return True
        if (row.get("owner") or "").startswith("user:"):
            return viewer.sees(row)                       # a person's own row: Viewer.sees unchanged
        swarm = self.team_swarm(row, cache)               # Viewer.sees is never called on a team row itself
        if swarm is None or not viewer.sees(swarm):
            return False
        if swarm.get("owner") and swarm["owner"] == viewer.principal:   # effective owner, read now
            return True
        vis = row.get("visibility")
        return vis == "public" or (vis == "shared" and viewer.principal in _people(row))

    def editable(self, viewer, row, cache=None):
        if not self.readable(viewer, row, cache):
            return False
        if viewer.admin:
            return True
        if row["owner"].startswith("user:"):
            return row["owner"] == viewer.principal
        swarm = self.team_swarm(row, cache)               # team and mind rows: the swarm's effective owner (Q6), never the mind
        return bool(swarm and swarm.get("owner") and swarm["owner"] == viewer.principal)

    def _sees_swarm(self, viewer, sid, cache):
        swarm = self._swarm_row(sid, cache)
        return swarm is not None and viewer.sees(swarm)

    def _archived(self, row, cache=None):
        swarm = self.team_swarm(row, cache)
        return bool(swarm and swarm.get("archived_at"))

    def readable_ids(self, viewer, cache=None):
        """R for one request. Kimi F5 on 0d97c65: a SQL superset of what `readable` can pass (own, public, shared naming the
        viewer, or a row of a swarm the viewer owns) narrows the scan; `readable` stays the only judge of every candidate,
        so a hidden row is never even examined unless it is public or names the viewer."""
        if viewer.admin:   # an admin reads every row, but lists leave out others' personal swarms (hide_others_personal)
            rows = self.hive.visibility.hide_others_personal(viewer, self.db.all("SELECT * FROM motivations"),
                                                             lambda r: [r.get("swarm_id"), (r.get("owner") or "")[6:]])
        else:
            rows = self.db.all(
                "SELECT * FROM motivations WHERE owner = ? OR visibility IS NULL OR visibility IN ('', 'public') "
                "OR (visibility = 'shared' AND instr(shared_with, ?) > 0) OR swarm_id IN (SELECT id FROM swarms WHERE owner = ?)",
                (viewer.principal, json.dumps(viewer.principal), viewer.principal))
        return {r["id"] for r in rows if self.readable(viewer, r, cache)}

    # ---- views ------------------------------------------------------------------------------------------------------

    @staticmethod
    def reader_view(row):
        """Content only: never links_version, shared_with or any link-derived figure (B3)."""
        return {k: row.get(k) for k in READER}

    def view(self, viewer, row, cache=None):
        out = self.reader_view(row)
        if self.editable(viewer, row, cache):
            out.update(shared_with=_people(row), links_version=row["links_version"], editable=True)
        else:
            out["editable"] = False
        return out

    def get(self, viewer, mid):
        row = self._row(mid)
        if not self.readable(viewer, row):
            raise self._missing()
        return self.view(viewer, row)

    def _emit(self, mid):
        row = self._row(mid)
        if row:
            self.hive.events.publish("motivation.updated", motivation=self.reader_view(row))

    # ---- create, edit, visibility ------------------------------------------------------------------------------------

    def _fields(self, data, allowed, parent_ok=True):
        if "parent_id" in data:   # Q1: the shape ships, switched off; no route accepts it while off
            if not getattr(self.hive.settings, "motivation_hierarchy", False):
                raise self._err(400, "parent_disabled", "sub-motivations are switched off on this hive")
            if not parent_ok:
                raise self._err(400, "parent_fixed", "a motivation's parent is set when it is created")
        unknown = set(data) - allowed - {"parent_id"}
        if unknown:
            raise self._err(400, "bad_request", f"unknown fields: {sorted(unknown)}")

    def _title(self, value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 200:
            raise self._err(400, "bad_request", "title is 1 to 200 characters")
        return value.strip()

    def _why(self, value):
        if not isinstance(value, str) or len(value) > 4000:
            raise self._err(400, "bad_request", "why is at most 4000 characters")
        return value

    def _new_row(self, title, why, owner, swarm_id, visibility, people, created_by):
        at = now()
        return {"id": new_id("mo"), "title": title, "why": why, "owner": owner, "swarm_id": swarm_id, "status": "active",
                "visibility": visibility, "shared_with": json.dumps(people), "rev": 1, "links_version": 0, "parent_id": None,
                "created_by": created_by, "created_at": at, "updated_at": at, "status_changed_at": None}

    def _insert(self, row, parent_id, creator):
        """Review B1 on 0d97c65: the creator's authority is judged here, first, inside the insert's own transaction, against
        rows read now (not before it); a withdrawn authority is the first-time refusal, with no row and no event."""
        with self.db.transaction():
            creator.authorise()
            if parent_id is not None:
                parent = self._row(parent_id)
                if parent is None or not creator.may_read_parent(parent):
                    raise self._missing()
                if parent["owner"] != row["owner"] or parent["swarm_id"] != row["swarm_id"]:
                    raise self._err(400, "bad_parent", "a sub-motivation has its parent's owner and scope")
                if parent["parent_id"]:
                    raise self._err(400, "too_deep", "motivations nest two levels at most")
                row["parent_id"] = parent_id
            if row["swarm_id"]:
                self.hive.insert_into_open_swarm("motivations", row, row["swarm_id"])
            else:
                self.db.insert("motivations", row)
            self.db.after_commit(lambda: self._emit(row["id"]))
        return row

    def create(self, viewer, data):
        """A person's motivation (their own; an admin may make one for a person) or a team's (its owner or an admin).
        The request's shape is checked first; every check that reads the hive (the person, the swarm, its visibility and
        owner) runs only inside the insert transaction (Review B1). viewer.admin is the request's role, as on every route.
        A seen swarm the caller does not own is 403 owner_only (it is not hidden: its owner is readable on the swarm
        routes, as Visibility.set answers); a hidden or missing swarm is the same 404 (Kimi F2 on 0d97c65, declined)."""
        self._fields(data, {"title", "why", "owner", "swarm_id", "visibility", "shared_with"})
        title, why = self._title(data.get("title")), self._why(data.get("why", ""))
        owner, sid = data.get("owner") or viewer.principal, data.get("swarm_id")
        if not isinstance(owner, str) or (sid is not None and not _id(sid)):
            raise self._err(400, "bad_scope", "owner and swarm_id are ids")
        if owner.startswith("swarm:"):
            sid, team = sid or owner[6:], True
            if owner[6:] != sid:
                raise self._err(400, "bad_scope", "a swarm's motivation is scoped to its own swarm")
        elif owner.startswith("user:") and owner != "user:operator" and len(owner) <= 80:
            team = False
            if owner != viewer.principal and not viewer.admin:
                raise self._err(403, "owner_only", "a person creates their own motivations; an admin may create one for a person")
        else:
            raise self._err(400, "bad_scope", "a motivation is owned by a person (user:u_...) or a swarm (swarm:s_...)")
        try:
            visibility, people = clean(data.get("visibility") or ("public" if team else "private"), data.get("shared_with"))
        except ValueError as exc:
            raise self._err(400, "bad_visibility", str(exc)) from None

        def authorise():
            if not team and owner != viewer.principal:
                if not (owner.startswith("user:u_") and self.db.one("SELECT 1 FROM people WHERE id = ?", (owner[5:],))):
                    raise self._err(400, "bad_scope", "no such person")
            if sid:
                swarm = self._swarm_row(sid)                  # read now, never from a cache
                if swarm is None or not viewer.sees(swarm):
                    raise self._err(404, "not_found", "no such swarm")
                if team and not (viewer.admin or (swarm.get("owner") and swarm["owner"] == viewer.principal)):
                    raise self._err(403, "owner_only", "only the swarm's owner or an admin creates its motivations")

        row = self._new_row(title, why, owner, sid, visibility, people, viewer.principal)
        self._insert(row, data.get("parent_id"), _Creator(authorise, lambda parent: self.readable(viewer, parent)))
        return self.view(viewer, self._row(row["id"]))

    def agent_create(self, agent, data):
        """owner Q2: a mind names an aim owned by itself or by its own swarm. Owner, creator and swarm come from the
        authenticated mind row, re-read inside the transaction; a supplied owner, swarm or visibility is refused.
        operation_id is required (Kimi F1 on 0d97c65), as on the links route: every mind create is replay-safe."""
        if set(data) & DERIVED:
            raise self._err(400, "bad_scope", "a mind's motivation is owned by itself or its own swarm; the hive sets both")
        self._fields(data, {"title", "why", "scope", "operation_id"})
        scope = data.get("scope", "self")
        if scope not in ("self", "team"):
            raise self._err(400, "bad_scope", "scope is self (yours) or team (your swarm's)")
        title, why = self._title(data.get("title")), self._why(data.get("why", ""))
        op_id = data.get("operation_id")
        if not (isinstance(op_id, str) and OP_ID.fullmatch(op_id)):
            raise self._err(400, "bad_request", "operation_id (8 to 120 of A-Z a-z 0-9 _ . : -) is required; a retry with it "
                                                "returns the first motivation")
        principal = f"agent:{agent['id']}"

        def mind():
            me = self.db.one("SELECT id, swarm_id FROM agents WHERE id = ? AND deleted = 0", (agent["id"],))
            if me is None:
                raise self._err(401, "unauthorized", "invalid agent token")
            if not me["swarm_id"] or self._swarm_row(me["swarm_id"]) is None:
                raise self._err(400, "no_swarm", "you are not in a swarm")
            return me["swarm_id"]

        with self.db.transaction():
            sid = mind()
            digest = _sha({"method": "POST", "domain": "motivation.create", "destination": sid, "scope": scope, "title": title,
                           "why": why, "parent_id": data.get("parent_id")})
            prior = self._op(principal, op_id)
            if prior:
                if prior["digest"] != digest:   # includes the derived swarm: a replay after a move is a conflict, never a create
                    raise self._err(409, "operation_conflict", "that operation_id was used for a different request")
                row = self._row(json.loads(prior["outcome"]).get("id"))
                if row is None or row["created_by"] != principal:
                    raise self._missing()
                return {"motivation": self.reader_view(row), "replayed": True}

            def authorise():   # the same mind, still in the swarm the row and the digest were derived from
                if mind() != sid:
                    raise self._err(409, "operation_conflict", "you moved swarm while this was being created; nothing was created")

            row = self._new_row(title, why, principal if scope == "self" else f"swarm:{sid}", sid, "public", [], principal)
            self._insert(row, data.get("parent_id"), _Creator(authorise, lambda parent: parent["created_by"] == principal))
            self._record_op(principal, op_id, "motivation.create", digest, sid, None, {"id": row["id"]})
        return {"motivation": self.reader_view(self._row(row["id"]))}

    def agent_list(self, agent):
        """A mind reads exactly the motivations it created (Q3), by its immutable id: not by name, swarm or membership."""
        rows = self.db.all("SELECT * FROM motivations WHERE created_by = ? ORDER BY created_at DESC, id DESC LIMIT 200",
                           (f"agent:{agent['id']}",))
        return {"motivations": [self.reader_view(r) for r in rows]}

    def _editable_row(self, viewer, mid):
        row = self._row(mid)
        if not self.editable(viewer, row):
            raise self._missing()
        if self._archived(row):
            raise self._err(409, "swarm_archived", "that swarm is archived; its motivations are read-only")
        return row

    def _expected(self, data):
        rev = data.get("expected_rev")
        if not _int(rev):
            raise self._err(400, "bad_request", "expected_rev (an integer) is required")
        return rev

    def _save(self, mid, row, rev, values):
        if row["rev"] != rev:
            raise self._err(409, "motivation_changed", "this motivation changed since you read it; reload and try again")
        if values:
            values.update(rev=row["rev"] + 1, updated_at=now())
            self.db.update("motivations", mid, values)
            self.db.after_commit(lambda: self._emit(mid))

    def update(self, viewer, mid, data):
        self._fields(data, {"title", "why", "status", "expected_rev"}, parent_ok=False)
        rev, values = self._expected(data), {}
        if "title" in data:
            values["title"] = self._title(data["title"])
        if "why" in data:
            values["why"] = self._why(data["why"])
        if "status" in data and data["status"] not in STATES:
            raise self._err(400, "bad_status", f"status is one of {', '.join(STATES)}")
        with self.db.transaction():
            row = self._editable_row(viewer, mid)
            if "status" in data and data["status"] != row["status"]:
                values.update(status=data["status"], status_changed_at=now())
            self._save(mid, row, rev, values)
        return self.view(viewer, self._row(mid))

    def set_visibility(self, viewer, mid, data):
        self._fields(data, {"visibility", "shared_with", "expected_rev"}, parent_ok=False)
        rev = self._expected(data)
        try:
            visibility, people = clean(data.get("visibility"), data.get("shared_with"))
        except ValueError as exc:
            raise self._err(400, "bad_visibility", str(exc)) from None
        values = {}
        if visibility:
            values["visibility"] = visibility
        if data.get("shared_with") is not None:
            values["shared_with"] = json.dumps(people)
        with self.db.transaction():
            self._save(mid, self._editable_row(viewer, mid), rev, values)
        return self.view(viewer, self._row(mid))

    # ---- cursors: host-MAC'd, bound to sort, filter, group and principal; they carry position, never authority (R1) ---

    def _cursor_make(self, viewer, sort, key, digest, group=None):
        body = {"v": 1, "sort": sort, "key": key, "filter": digest, "principal": viewer.principal}
        if group:
            body["group"] = group
        raw = base64.urlsafe_b64encode(_canon(body).encode()).decode().rstrip("=")
        return raw + "." + hmac.new(self._key, raw.encode(), "sha256").hexdigest()

    def _cursor_read(self, token, viewer, sort, digest, groups=(None,)):
        bad = self._err(400, "cursor_invalid", "that cursor is not valid for this request")
        if not isinstance(token, str) or len(token) > CURSOR_MAX or token.count(".") != 1:
            raise bad
        raw, tag = token.split(".")
        if not hmac.compare_digest(tag.encode(), hmac.new(self._key, raw.encode(), "sha256").hexdigest().encode()):
            raise bad
        try:
            body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        except (ValueError, TypeError):
            raise bad from None
        key, shape = body.get("key") if isinstance(body, dict) else None, KEY_TYPES.get(sort)
        if (not isinstance(body, dict) or body.get("v") != 1 or body.get("sort") != sort or not isinstance(key, list)
                or len(key) != len(shape) or any(type(k) is bool or not isinstance(k, t) for k, t in zip(key, shape))):
            raise bad
        if body.get("filter") != digest or body.get("principal") != viewer.principal or body.get("group") not in groups:
            raise bad
        return key, body.get("group")

    def _limit(self, value, default=50):
        if value in (None, ""):
            return default
        text = str(value).strip()
        if not text.isdigit() or not 1 <= int(text) <= MAX_LIMIT:
            raise self._err(400, "bad_request", f"limit is 1 to {MAX_LIMIT}")
        return int(text)

    def _statuses(self, value, allowed):
        if not value:
            return None
        items = sorted({s.strip() for s in str(value).split(",") if s.strip()})
        if not items or any(s not in allowed for s in items):
            raise self._err(400, "bad_status", f"status is one or more of {', '.join(sorted(allowed))}")
        return items

    # ---- GET /api/motivations ------------------------------------------------------------------------------------------

    def list(self, viewer, owner=None, swarm=None, status=None, cursor=None, limit=None):
        limit, cache = self._limit(limit), {}
        where, args = ["1=1"], []
        if swarm:
            if not self._sees_swarm(viewer, swarm, cache):
                raise self._err(404, "not_found", "no such swarm")
            where.append("swarm_id = ?")
            args.append(swarm)
        if owner:
            where.append("owner = ?")
            args.append(owner)
        statuses = self._statuses(status, STATES)
        if statuses:
            where.append("status IN (SELECT value FROM json_each(?))")
            args.append(json.dumps(statuses))
        digest = _sha({"owner": owner or None, "swarm": swarm or None, "status": statuses})
        if cursor:
            (at, mid), _ = self._cursor_read(cursor, viewer, "created", digest)
            where.append("(created_at < ? OR (created_at = ? AND id < ?))")
            args += [at, at, mid]
        items = []
        for row in self.db.all(f"SELECT * FROM motivations WHERE {' AND '.join(where)} ORDER BY created_at DESC, id DESC", args):
            if self.readable(viewer, row, cache) and not self.hive.visibility.hides(
                    viewer, row.get("swarm_id"), (row.get("owner") or "")[6:]):
                items.append(row)
                if len(items) > limit:
                    break
        more, items = len(items) > limit, items[:limit]
        nxt = self._cursor_make(viewer, "created", [items[-1]["created_at"], items[-1]["id"]], digest) if more else None
        return {"items": [self.view(viewer, r, cache) for r in items], "cursor": nxt}

    # ---- GET /api/tasks: one filter for items, counts and every group page (design 3.3) -----------------------------

    def _task_params(self, params):
        get = lambda k: params.get(k) or None
        p = {"motivation": get("motivation"), "swarm": get("swarm"), "mind": get("mind"), "q": get("q")}
        for k in ("motivation", "swarm", "mind"):
            if p[k] is not None and not _id(p[k]):
                raise self._err(400, "bad_request", f"{k} is an id")
        if p["q"] is not None and len(p["q"]) > 100:
            raise self._err(400, "bad_request", "q is at most 100 characters")
        top = (get("top") or "").lower()
        if top not in ("", "0", "1", "true", "false"):
            raise self._err(400, "bad_request", "top is true or false")
        p["top"] = top in ("1", "true")
        p["status"] = self._statuses(get("status"), STATUSES)
        p["sort"] = get("sort") or "priority"
        if p["sort"] not in ("priority", "updated"):
            raise self._err(400, "bad_request", "sort is priority or updated")
        p["group"] = get("group")
        if p["group"] not in (None, "status"):
            raise self._err(400, "bad_request", "group is status")
        return p, get("cursor"), self._limit(get("limit"))

    def _task_filter(self, viewer, p, readable, cache):
        where, args = [], []
        if not viewer.admin:
            seen = [s["id"] for s in self.db.all("SELECT id, owner, visibility, shared_with FROM swarms") if viewer.sees(s)]
            where.append("g.swarm_id IN (SELECT value FROM json_each(?))")
            args.append(json.dumps(seen))
        elif self.hive.visibility.hidden_ids(viewer):   # an admin's task list: not others' personal swarms
            where.append("g.swarm_id NOT IN (SELECT value FROM json_each(?))")
            args.append(json.dumps(sorted(self.hive.visibility.hidden_ids(viewer))))
        if p["motivation"] == "none":     # Unsorted: no link to any motivation THIS viewer can read
            where.append("NOT EXISTS (SELECT 1 FROM motivation_tasks mt WHERE mt.goal_id = g.id AND mt.motivation_id IN "
                         "(SELECT value FROM json_each(?)))")
            args.append(json.dumps(sorted(readable)))
        elif p["motivation"]:
            if p["motivation"] not in readable:   # a guessed hidden id is never a membership oracle
                raise self._missing()
            where.append("EXISTS (SELECT 1 FROM motivation_tasks mt WHERE mt.goal_id = g.id AND mt.motivation_id = ?)")
            args.append(p["motivation"])
        if p["swarm"]:
            if not self._sees_swarm(viewer, p["swarm"], cache):
                raise self._err(404, "not_found", "no such swarm")
            where.append("g.swarm_id = ?")
            args.append(p["swarm"])
        if p["mind"]:
            mind = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (p["mind"],))
            if mind is None or not viewer.sees(mind):
                raise self._err(404, "not_found", "no such mind")
            where.append("(g.assignee = ? OR g.claimed_by = ? OR g.created_by = ?)")
            args += [p["mind"], p["mind"], "agent:" + p["mind"]]
        if p["status"]:
            where.append("g.status IN (SELECT value FROM json_each(?))")
            args.append(json.dumps(p["status"]))
        if p["q"]:
            like = "%" + re.sub(r"([\\%_])", r"\\\1", p["q"]) + "%"
            where.append("(g.title LIKE ? ESCAPE '\\' OR g.detail LIKE ? ESCAPE '\\')")
            args += [like, like]
        if p["top"]:
            where.append("g.parent_id IS NULL")
        return " AND ".join(where) or "1=1", args

    def _page(self, viewer, where, args, sort, after, limit, digest, group=None):
        where, args = where, list(args)
        if after and sort == "priority":
            where += " AND (g.priority < ? OR (g.priority = ? AND (g.created_at > ? OR (g.created_at = ? AND g.id > ?))))"
            args += [after[0], after[0], after[1], after[1], after[2]]
        elif after:
            where += " AND (g.updated_at < ? OR (g.updated_at = ? AND g.id > ?))"
            args += [after[0], after[0], after[1]]
        order = "g.priority DESC, g.created_at, g.id" if sort == "priority" else "g.updated_at DESC, g.id"
        rows = self.db.all(f"SELECT g.* FROM goals g WHERE {where} ORDER BY {order} LIMIT ?", (*args, limit + 1))
        more, rows = len(rows) > limit, rows[:limit]
        last = rows[-1] if rows else None
        key = ([last["priority"], last["created_at"], last["id"]] if sort == "priority" else [last["updated_at"], last["id"]]) if last else None
        return rows, (self._cursor_make(viewer, sort, key, digest, group) if more else None)

    def _counts(self, where, args):
        by = {s: 0 for s in STATUS_ORDER}
        for r in self.db.all(f"SELECT g.status, COUNT(*) AS n FROM goals g WHERE {where} GROUP BY g.status", args):
            by[r["status"]] = r["n"]
        return {"total": sum(by.values()), "by_status": by}

    def _project(self, viewer, rows, readable):
        """Today's goal list shape plus the viewer's readable links and visible requests: the only new serialiser."""
        goals, ids = self.hive.goals, json.dumps([r["id"] for r in rows])
        links = self.db.all("SELECT mt.goal_id, m.id, m.title, m.status FROM motivation_tasks mt JOIN motivations m "
                            "ON m.id = mt.motivation_id WHERE mt.goal_id IN (SELECT value FROM json_each(?)) ORDER BY m.id", (ids,))
        reqs = self.db.all("SELECT * FROM requests WHERE from_goal IN (SELECT value FROM json_each(?)) OR receiving_goal IN "
                           "(SELECT value FROM json_each(?)) ORDER BY created_at, id", (ids, ids))
        reqs = self.hive.visibility.filter_items(viewer, [self.hive.collab.request_view(r) for r in reqs])
        out = []
        for r in rows:
            item = {**goals.view(r), "review_by": goals.review_spec(r)}
            item["motivations"] = [{"id": m["id"], "title": m["title"], "status": m["status"]}
                                   for m in links if m["goal_id"] == r["id"] and m["id"] in readable]
            item["requests"] = [{"id": q["id"], "kind": q["kind"], "state": q["state"],
                                 "direction": "out" if q["from_goal"] == r["id"] else "in"}
                                for q in reqs if r["id"] in (q["from_goal"], q["receiving_goal"])]
            out.append(item)
        return out

    def tasks(self, viewer, params):
        p, cursor, limit = self._task_params(params)
        cache = {}
        readable = self.readable_ids(viewer, cache)      # R, once per page
        where, args = self._task_filter(viewer, p, readable, cache)
        digest = _sha({k: p[k] for k in ("motivation", "swarm", "mind", "status", "q", "top", "sort", "group")})
        if p["group"] == "status":
            columns = [s for s in STATUS_ORDER if not p["status"] or s in p["status"]]
            if cursor:   # one column's next page
                after, status = self._cursor_read(cursor, viewer, p["sort"], digest, tuple(columns))
                rows, nxt = self._page(viewer, where + " AND g.status = ?", (*args, status), p["sort"], after, limit, digest, status)
                return {"group": status, "items": self._project(viewer, rows, readable), "cursor": nxt}
            groups = {}
            for status in columns:
                rows, nxt = self._page(viewer, where + " AND g.status = ?", (*args, status), p["sort"], None, limit, digest, status)
                groups[status] = {"items": self._project(viewer, rows, readable), "cursor": nxt}
            return {"counts": self._counts(where, args), "groups": groups}
        after = self._cursor_read(cursor, viewer, p["sort"], digest)[0] if cursor else None
        rows, nxt = self._page(viewer, where, args, p["sort"], after, limit, digest)
        return {"items": self._project(viewer, rows, readable), "counts": self._counts(where, args), "cursor": nxt}

    # ---- POST /api/motivations/{id}/links: link, unlink, move, cascade; one transaction (design 3.2, B1, B2) --------

    def _op(self, principal, op_id):
        return self.db.one("SELECT * FROM motivation_ops WHERE principal = ? AND operation_id = ?", (principal, op_id))

    def _record_op(self, principal, op_id, domain, digest, destination, source, outcome):
        self.db.insert("motivation_ops", {"principal": principal, "operation_id": op_id, "domain": domain, "digest": digest,
                                          "destination": destination, "source": source, "outcome": _canon(outcome),
                                          "created_at": now()})

    def _link_request(self, mid, data):
        unknown = set(data) - LINK_FIELDS
        if unknown:
            raise self._err(400, "parent_disabled" if "parent_id" in unknown else "bad_request", f"unknown fields: {sorted(unknown)}")
        op_id, op, ids, cascade = data.get("operation_id"), data.get("op"), data.get("goal_ids"), data.get("cascade")
        if not (isinstance(op_id, str) and OP_ID.fullmatch(op_id)):
            raise self._err(400, "bad_request", "operation_id is 8 to 120 of A-Z a-z 0-9 _ . : -")
        if op not in OPS:
            raise self._err(400, "bad_request", "op is link, unlink or move")
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_LINK_GOALS or not all(_id(g) for g in ids):
            raise self._err(400, "bad_request", f"goal_ids is 1 to {MAX_LINK_GOALS} task ids")
        if type(cascade) is not bool:
            raise self._err(400, "bad_request", "cascade (true or false) is required")
        src, to_rev, from_rev = data.get("from_motivation_id"), data.get("expected_to_rev"), data.get("expected_from_rev")
        to_lv, from_lv = data.get("expected_to_links_version"), data.get("expected_from_links_version")
        if not _int(to_rev):
            raise self._err(400, "bad_request", "expected_to_rev (an integer) is required")
        if op == "move":
            if not _id(src) or not _int(from_rev) or src == mid:
                raise self._err(400, "bad_request", "a move names from_motivation_id (another motivation) and expected_from_rev")
        elif src is not None or from_rev is not None or from_lv is not None:
            raise self._err(400, "bad_request", "from_motivation_id and expected_from_* belong to a move only")
        if any(v is not None and not _int(v) for v in (to_lv, from_lv)):
            raise self._err(400, "bad_request", "expected links versions are integers")
        req = {"method": "POST", "domain": "motivation.links", "destination": mid, "op": op, "goal_ids": sorted(set(ids)),
               "cascade": cascade, "from_motivation_id": src, "expected_to_rev": to_rev, "expected_from_rev": from_rev,
               "expected_to_links_version": to_lv, "expected_from_links_version": from_lv}
        return op_id, req, _sha(req)

    def _authorised(self, viewer, mid, cache):
        row = self._row(mid)
        if not self.editable(viewer, row, cache):
            raise self._missing()
        return row

    def _goal_visible(self, viewer, gid, cache):
        goal = self.db.one("SELECT id, swarm_id, parent_id FROM goals WHERE id = ?", (gid,))
        return goal if goal is not None and (viewer.admin or self._sees_swarm(viewer, goal["swarm_id"], cache)) else None

    def link(self, viewer, mid, data):
        op_id, req, digest = self._link_request(mid, data)
        op, src, cache = req["op"], req["from_motivation_id"], {}
        principal = viewer.principal
        with self.db.transaction():
            prior = self._op(principal, op_id)
            if prior:
                if prior["digest"] != digest:
                    raise self._err(409, "operation_conflict", "that operation_id was used for a different request")
                return self._replay(viewer, prior, mid, src)
            # 1. motivations: authority first (404), then state and each one's own revisions
            dest = self._authorised(viewer, mid, cache)
            source = self._authorised(viewer, src, cache) if src else None
            for row, rev, lv in ((dest, req["expected_to_rev"], req["expected_to_links_version"]),
                                 (source, req["expected_from_rev"], req["expected_from_links_version"])):
                if row is None:
                    continue
                if self._archived(row, cache):
                    raise self._err(409, "swarm_archived", "that swarm is archived; its motivations are read-only")
                if row is dest and op != "unlink" and row["status"] not in LINKABLE:
                    raise self._err(409, "motivation_closed", "only an active or paused motivation takes new links")
                if row["rev"] != rev or (lv is not None and row["links_version"] != lv):
                    raise self._err(409, "motivation_changed", "a motivation changed since you read it; reload and try again")
            # 2. the named rows: visible (404), in scope (400), open (409)
            named = []
            for gid in req["goal_ids"]:
                goal = self._goal_visible(viewer, gid, cache)
                if goal is None:
                    raise self._err(404, "not_found", "no such task")
                named.append(goal)
            for goal in named:
                if dest["swarm_id"] and goal["swarm_id"] != dest["swarm_id"]:
                    raise self._err(400, "scope_mismatch", "that motivation does not cover this task's swarm")
            for goal in named:
                if self._swarm_row(goal["swarm_id"], cache).get("archived_at"):
                    raise self._err(409, "swarm_archived", "that task's swarm is archived")
            # 3. cascade: every descendant by the same rules; a failing one refuses all, unnamed
            family = []
            if req["cascade"]:
                names = {g["id"] for g in named}
                family = [g for g in self.db.all(
                    "WITH RECURSIVE family(id) AS (SELECT value FROM json_each(?) UNION SELECT g.id FROM goals g JOIN family f "
                    "ON g.parent_id = f.id) SELECT g.id, g.swarm_id, g.parent_id FROM goals g JOIN family f ON g.id = f.id ORDER BY g.id",
                    (json.dumps(req["goal_ids"]),)) if g["id"] not in names]
                for goal in family:
                    swarm = self._swarm_row(goal["swarm_id"], cache)
                    if (not (viewer.admin or self._sees_swarm(viewer, goal["swarm_id"], cache)) or swarm is None or swarm.get("archived_at")
                            or (dest["swarm_id"] and goal["swarm_id"] != dest["swarm_id"])):
                        raise self._err(409, "cascade_refused", "a subtask cannot take this change; nothing was changed")
            # 4 + 5. prior state of every pair, then the writes, the version bumps and the operation record, together
            has = lambda m, g: self.db.one("SELECT 1 FROM motivation_tasks WHERE motivation_id = ? AND goal_id = ?", (m, g)) is not None
            at, applied, unchanged, changes = now(), [], [], {}
            change = lambda m, s, kind, g: changes.setdefault((m, s), {"linked": [], "unlinked": []})[kind].append(g)
            put = lambda g: self.db.execute("INSERT INTO motivation_tasks (motivation_id, goal_id, linked_by, linked_at) VALUES (?, ?, ?, ?)",
                                            (mid, g, principal, at))
            for goal, is_named in [(g, True) for g in named] + [(g, False) for g in family]:
                gid, sid = goal["id"], goal["swarm_id"]
                if op == "link":
                    if has(mid, gid):
                        unchanged.append(gid)
                        continue
                    put(gid)
                    change(mid, sid, "linked", gid)
                else:
                    held = mid if op == "unlink" else src
                    if not has(held, gid):
                        if is_named:
                            raise self._err(409, "link_changed", "a link changed since you read it; reload and try again")
                        unchanged.append(gid)
                        continue
                    self.db.execute("DELETE FROM motivation_tasks WHERE motivation_id = ? AND goal_id = ?", (held, gid))
                    change(held, sid, "unlinked", gid)
                    if op == "move" and not has(mid, gid):
                        put(gid)
                        change(mid, sid, "linked", gid)
                applied.append(gid)
            # Kimi F4 on 0d97c65: each bump is a compare-and-set on the rev and links_version read in step 1, so the step-1
            # preconditions hold by the UPDATE itself, not only by the connection lock; a miss refuses the whole operation
            read = {r["id"]: r for r in (dest, source) if r is not None}
            for m in sorted({m for m, _ in changes}):
                cur = self.db.execute("UPDATE motivations SET links_version = links_version + 1 WHERE id = ? AND rev = ? "
                                      "AND links_version = ?", (m, read[m]["rev"], read[m]["links_version"]))   # never rev
                if cur.rowcount != 1:
                    raise self._err(409, "motivation_changed", "a motivation changed since you read it; reload and try again")
            outcome = {"applied": applied, "unchanged": unchanged}
            self._record_op(principal, op_id, "motivation.links", digest, mid, src, outcome)
            for (m, sid), ch in sorted(changes.items()):
                self.db.after_commit(lambda m=m, sid=sid, ch=ch: self.hive.events.publish(
                    "motivation.links", motivation_id=m, swarm_id=sid, linked=sorted(ch["linked"]), unlinked=sorted(ch["unlinked"])))
            return self._outcome(viewer, op_id, outcome, mid, src, cache)

    def _outcome(self, viewer, op_id, outcome, mid, src, cache, replayed=False):
        out = {"operation_id": op_id, **outcome, "motivation": self.view(viewer, self._row(mid), cache)}
        if src:
            out["from_motivation"] = self.view(viewer, self._row(src), cache)
        if replayed:
            out["replayed"] = True
        return out

    def _replay(self, viewer, prior, mid, src):
        """Current authority, not the consumed revision preconditions: exactly the first-time refusal when it is gone, and
        never a stored view (the record holds goal ids only). One semantics (Kimi F3 on 0d97c65): every stored goal must
        still be visible, else the whole replay is the first-time 404; nothing is filtered, so a replay either returns
        every stored id or none."""
        cache = {}
        for m in (mid, src):
            if m:
                self._authorised(viewer, m, cache)
        outcome = json.loads(prior["outcome"])
        for gid in outcome["applied"] + outcome["unchanged"]:
            if self._goal_visible(viewer, gid, cache) is None:
                raise self._err(404, "not_found", "no such task")
        return self._outcome(viewer, prior["operation_id"], {"applied": outcome["applied"], "unchanged": outcome["unchanged"]},
                             mid, src, cache, replayed=True)

    # ---- live event rules (visibility.EVENT_RULES 'motivation' / 'motivation_links'), judged against stored rows -----

    def event_visible(self, viewer, event, rule):
        if rule == "motivation":
            m = event.get("motivation")
            return isinstance(m, dict) and self.readable(viewer, self._row(m.get("id")))
        mid, sid = event.get("motivation_id"), event.get("swarm_id")
        lists = [event.get("linked"), event.get("unlinked")]
        if not all(isinstance(x, list) for x in lists):
            return False
        goal_ids = lists[0] + lists[1]
        if not _id(sid) or not goal_ids or not all(_id(g) for g in goal_ids):
            return False
        cache = {}
        if not self.readable(viewer, self._row(mid), cache) or not self._sees_swarm(viewer, sid, cache):
            return False
        owners = self.db.all("SELECT id, swarm_id FROM goals WHERE id IN (SELECT value FROM json_each(?))", (json.dumps(goal_ids),))
        return len(owners) == len(set(goal_ids)) and all(o["swarm_id"] == sid for o in owners)   # every goal in the named swarm


def install_routes(app, hive, operator, agent_from, viewer, body):
    """Thin route hooks; every rule lives in Motivations."""
    from .mcp import _canon as command
    m = hive.motivations

    @app.get("/api/motivations")
    async def list_motivations(request: Request, owner: str | None = None, swarm: str | None = None, status: str | None = None,
                               cursor: str | None = None, limit: str | None = None):
        return m.list(viewer(operator(request)), owner, swarm, status, cursor, limit)

    @app.post("/api/motivations")
    async def create_motivation(request: Request):
        who = viewer(operator(request))
        return m.create(who, await body(request))

    @app.get("/api/motivations/{motivation_id}")
    async def get_motivation(motivation_id: str, request: Request):
        return m.get(viewer(operator(request)), motivation_id)

    @app.patch("/api/motivations/{motivation_id}")
    async def update_motivation(motivation_id: str, request: Request):
        who = viewer(operator(request))
        return m.update(who, motivation_id, await body(request))

    @app.put("/api/motivations/{motivation_id}/visibility")
    async def motivation_visibility(motivation_id: str, request: Request):
        who = viewer(operator(request))
        return m.set_visibility(who, motivation_id, await body(request))

    @app.post("/api/motivations/{motivation_id}/links")
    async def motivation_links(motivation_id: str, request: Request):
        who = viewer(operator(request))
        return m.link(who, motivation_id, await body(request))

    @app.get("/api/tasks")
    async def tasks(request: Request):
        return m.tasks(viewer(operator(request)), dict(request.query_params))

    @app.get("/api/agent/motivations")
    async def agent_motivations(request: Request):
        return m.agent_list(agent_from(request))

    @app.post("/api/agent/motivations")
    async def agent_create_motivation(request: Request):
        agent = agent_from(request)
        data = await body(request)
        hive.policy.enforce(agent, "hive-motivation-create", command("hive-motivation-create", data.get("title")))
        return m.agent_create(agent, data)
