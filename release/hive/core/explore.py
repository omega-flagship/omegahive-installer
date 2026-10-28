"""The explorer (R19): every thing in the hive as a node with facets, filtered, grouped and paged on the server.

Nodes: minds, swarms, apps and rooms (connected hives join later, as nodes that expand remotely). Each node carries the
same facets, so any facet can filter and any facet can group:
  kind, where, state, swarm, purpose, role, owner, visibility, health, spend, active
State means the same within a kind: minds and swarms are working / resting / stopped / not started / error;
apps are running / stopped / error; rooms are unread / quiet. Grouping by kind then state keeps them apart.
A query returns the total, nested groups with counts, and one page of items for the groups a person has opened. The
interface never loads "everything": a collapsed group costs one count. Views (filters, group-bys, order, pins,
collapsed groups, layout) are saved per person and never change the real structure.
"""

from __future__ import annotations

import datetime
import json

from .db import new_id, now

FACETS = ("kind", "where", "state", "swarm", "purpose", "role", "owner", "visibility", "health", "spend", "active", "tag", "group")
MULTI = {"tag", "group"}   # a node can carry several tags and sit in several of a person's groups
KINDS = ("mind", "swarm", "app", "room")
MAX_LIMIT = 200
MAX_GROUP_DEPTH = 3
META_SCHEMA = """CREATE TABLE IF NOT EXISTS node_meta (node_id TEXT PRIMARY KEY, purpose TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)"""
GROUPS_SCHEMA = """CREATE TABLE IF NOT EXISTS explore_groups (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
MAX_TAGS = 20
VIEWS_SCHEMA = """CREATE TABLE IF NOT EXISTS explore_views (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
  spec TEXT NOT NULL, arrangement TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
NONE = "(none)"


def _since(stamp):
    if not stamp:
        return None
    try:
        then = datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.datetime.now(datetime.timezone.utc) - then).total_seconds()


def _active(stamp):
    s = _since(stamp)
    if s is None:
        return "never"
    return "last hour" if s < 3600 else "today" if s < 86400 else "this week" if s < 7 * 86400 else "older"


def _spend(usd):
    usd = float(usd or 0)
    return "none" if usd <= 0 else "under $1" if usd < 1 else "under $10" if usd < 10 else "$10 or more"


class Explorer:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(VIEWS_SCHEMA)
        hive.db.execute(META_SCHEMA)
        hive.db.execute(GROUPS_SCHEMA)

    # ---- nodes ---------------------------------------------------------------------------------------

    def _mind_state(self, a, working_ids):
        status = a.get("status")
        if status == "error" or a.get("last_error") and status not in ("awake", "starting"):
            return "error"
        if status in ("awake", "starting"):
            return "working" if a["id"] in working_ids or (_since(a.get("last_active_at")) or 1e9) < 120 else "resting"
        if status == "asleep":
            return "resting"
        return "not started" if status == "created" else "stopped"

    def nodes(self, viewer):
        db, vis = self.hive.db, self.hive.visibility
        swarms = {s["id"]: s for s in db.all("SELECT * FROM swarms")}
        roles = {r["id"]: r for r in db.all("SELECT id, name FROM roles")}
        working = {r["claimed_by"] for r in db.all("SELECT claimed_by FROM goals WHERE status = 'claimed' AND claimed_by IS NOT NULL")}
        try:
            health = {m["id"]: m["health"] for m in self.hive.health.overview()["minds"]}
        except Exception:
            health = {}
        out, swarm_state = [], {}
        for a in db.all("SELECT * FROM agents WHERE deleted = 0"):
            if not viewer.sees(a) or self.hive.visibility.hides(viewer, a["id"], a.get("swarm_id")):
                continue
            sw = swarms.get(a.get("swarm_id")) or {}
            state = self._mind_state(a, working)
            swarm_state.setdefault(a.get("swarm_id"), []).append(state)
            out.append({"id": a["id"], "kind": "mind", "name": a["name"], "parent": a.get("swarm_id"),
                        "facets": {"kind": "mind", "where": "this hive", "state": state, "swarm": sw.get("name") or NONE,
                                   "purpose": (sw.get("description") or NONE)[:120], "role": (roles.get(a.get("role_id")) or {}).get("name") or NONE,
                                   "owner": a.get("owner") or "user:operator", "visibility": a.get("visibility") or "public",
                                   "health": health.get(a["id"], "ok"), "spend": _spend(a.get("spent_usd")), "active": _active(a.get("last_active_at"))},
                        "detail": {"status": a.get("status"), "model": a.get("model"), "spent_usd": a.get("spent_usd") or 0,
                                   "coordinates": [s["id"] for s in swarms.values() if s.get("coordinator_id") == a["id"]]}})
        for s in swarms.values():
            if not viewer.sees(s) or self.hive.visibility.hides(viewer, s["id"]):
                continue
            states = swarm_state.get(s["id"], [])
            state = ("error" if "error" in states else "working" if "working" in states else "resting" if "resting" in states
                     else "not started" if states and all(x == "not started" for x in states) else "stopped" if states else "empty")
            parent_swarm = None
            if s.get("parent_mind_id"):
                pm = db.one("SELECT swarm_id FROM agents WHERE id = ?", (s["parent_mind_id"],))
                parent_swarm = pm["swarm_id"] if pm else None
            out.append({"id": s["id"], "kind": "swarm", "name": s["name"], "parent": parent_swarm,
                        "facets": {"kind": "swarm", "where": "this hive", "state": state, "swarm": s["name"],
                                   "purpose": (s.get("description") or NONE)[:120], "role": NONE, "owner": s.get("owner") or "user:operator",
                                   "visibility": s.get("visibility") or "public", "health": "ok", "spend": NONE, "active": NONE},
                        "detail": {"members": len(states), "coordinator_id": s.get("coordinator_id"), "parent_mind_id": s.get("parent_mind_id")}})
        for p in self.hive.programs.list():
            out.append({"id": f"program:{p['id']}", "kind": "app", "name": p["name"], "parent": None,
                        "facets": {"kind": "app", "where": "this hive", "state": "error" if p.get("error") else "running" if p.get("enabled") else "stopped",
                                   "swarm": NONE, "purpose": (p.get("description") or NONE)[:120], "role": NONE, "owner": NONE,
                                   "visibility": "public", "health": "high" if p.get("error") else "ok", "spend": NONE, "active": NONE},
                        "detail": {"version": p.get("version")}})
        rooms = getattr(self.hive, "rooms", None)
        if rooms is not None:
            for r in rooms.list(viewer):
                out.append({"id": r["id"], "kind": "room", "name": r["name"] or "DM", "parent": r.get("swarm_id"),
                            "facets": {"kind": "room", "where": "this hive", "state": "unread" if r.get("unread") else "quiet",
                                       "swarm": NONE, "purpose": (r.get("topic") or NONE)[:120], "role": r["kind"], "owner": r.get("owner") or NONE,
                                       "visibility": r.get("visibility") or "private", "health": "ok", "spend": NONE, "active": _active(r.get("updated_at"))},
                            "detail": {"room_kind": r["kind"], "members": len(r.get("members") or []), "unread": r.get("unread", 0)}})
        meta = {m["node_id"]: m for m in db.all("SELECT * FROM node_meta")}
        groups = self.groups(viewer)
        for n in out:
            m = meta.get(n["id"])
            if m and m["purpose"]:
                n["facets"]["purpose"] = m["purpose"][:120]
            n["facets"]["tag"] = json.loads(m["tags"]) if m else []
            n["facets"]["group"] = [g["name"] for g in groups if n["id"] in g["members"]]
        return out

    # ---- query ---------------------------------------------------------------------------------------

    def _clean(self, spec):
        spec = spec or {}
        kinds = [k for k in (spec.get("kinds") or KINDS) if k in KINDS]
        filters = {}
        for facet, values in (spec.get("filters") or {}).items():
            if facet not in FACETS:
                raise self.hive.error(400, "bad_facet", f"facet is one of {', '.join(FACETS)}")
            values = values if isinstance(values, list) else [values]
            filters[facet] = {str(v) for v in values}
        group_by = [g for g in (spec.get("group_by") or [])]
        if any(g not in FACETS for g in group_by) or len(group_by) > MAX_GROUP_DEPTH:
            raise self.hive.error(400, "bad_group", f"group by up to {MAX_GROUP_DEPTH} of: {', '.join(FACETS)}")
        q = str(spec.get("q") or "").strip().lower()[:200]
        limit = min(max(int(spec.get("limit") or 50), 1), MAX_LIMIT)
        opened = {str(p) for p in (spec.get("open") or [])}
        cursor = {str(k): int(v) for k, v in (spec.get("cursor") or {}).items()} if isinstance(spec.get("cursor"), dict) else {}
        sort = spec.get("sort") if spec.get("sort") in ("name", "active", "state") else "name"
        return kinds, filters, group_by, q, limit, opened, cursor, sort

    @staticmethod
    def _values(n, facet):
        v = n["facets"][facet]
        if facet in MULTI:
            return v or [NONE]
        return [v]

    def _match(self, n, facet, wanted):
        return any(v in wanted for v in self._values(n, facet))

    def query(self, viewer, spec):
        """{total, facets: {facet: {value: count}}, groups: [...nested...] | items: [...], next}"""
        kinds, filters, group_by, q, limit, opened, cursor, sort = self._clean(spec)
        nodes = [n for n in self.nodes(viewer) if n["kind"] in kinds]
        if q:
            nodes = [n for n in nodes if q in n["name"].lower() or q in n["facets"]["purpose"].lower() or q in n["id"].lower()]
        # facet counts reflect every filter except the facet's own, so a person sees what each choice would give
        facet_counts = {}
        for facet in FACETS:
            others = {f: v for f, v in filters.items() if f != facet}
            pool = [n for n in nodes if all(self._match(n, f, v) for f, v in others.items())]
            counts = {}
            for n in pool:
                for v in self._values(n, facet):
                    counts[v] = counts.get(v, 0) + 1
            facet_counts[facet] = dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
        nodes = [n for n in nodes if all(self._match(n, f, v) for f, v in filters.items())]
        key = {"name": lambda n: n["name"].lower(), "state": lambda n: (n["facets"]["state"], n["name"].lower()),
               "active": lambda n: (n["facets"]["active"], n["name"].lower())}[sort]
        nodes.sort(key=key)

        def page(items, path):
            start = cursor.get(path, 0)
            chunk = items[start:start + limit]
            return chunk, (start + limit if start + limit < len(items) else None)

        def group(items, depth, path):
            if depth == len(group_by):
                if path and path not in opened:
                    return {"items": None, "next": None}
                chunk, nxt = page(items, path)
                return {"items": chunk, "next": nxt}
            facet, buckets = group_by[depth], {}
            for n in items:
                for v in self._values(n, facet):   # a node in two groups (or with two tags) appears under each
                    buckets.setdefault(v, []).append(n)
            groups = []
            for value in sorted(buckets, key=lambda v: (-len(buckets[v]), v)):
                sub = f"{path}/{facet}={value}" if path else f"{facet}={value}"
                g = {"facet": facet, "value": value, "path": sub, "count": len(buckets[value])}
                if depth + 1 < len(group_by) and sub not in opened:
                    g["groups"] = None            # collapsed: one count, nothing more
                elif depth + 1 < len(group_by):
                    g["groups"] = group(buckets[value], depth + 1, sub)["groups"]
                else:
                    g.update(group(buckets[value], depth + 1, sub))
                groups.append(g)
            return {"groups": groups}

        out = {"total": len(nodes), "facets": facet_counts, "facet_names": list(FACETS)}
        if group_by:
            out.update(group(nodes, 0, ""))
        else:
            chunk, nxt = page(nodes, "")
            out.update(items=chunk, next=nxt)
        return out

    # ---- saved views (per person; never change the real structure) -------------------------------------

    def views(self, viewer):
        rows = self.hive.db.all("SELECT * FROM explore_views WHERE owner = ? ORDER BY name", (viewer.principal,))
        return [self._view(r) for r in rows]

    @staticmethod
    def _view(r):
        return {**r, "spec": json.loads(r["spec"]), "arrangement": json.loads(r["arrangement"])}

    def save_view(self, viewer, data, view_id=None):
        name = str(data.get("name") or "").strip()[:80]
        if not name:
            raise self.hive.error(400, "bad_request", "a view needs a name")
        spec, arrangement = data.get("spec") or {}, data.get("arrangement") or {}
        self._clean(spec)   # refuse an unusable spec now, not when it is opened
        if not isinstance(arrangement, dict) or len(json.dumps(arrangement)) > 64 * 1024:
            raise self.hive.error(400, "bad_request", "arrangement is an object of at most 64 KB")
        if view_id:
            row = self.hive.db.one("SELECT * FROM explore_views WHERE id = ? AND owner = ?", (view_id, viewer.principal))
            if row is None:
                raise self.hive.error(404, "not_found", "no such view")
            self.hive.db.execute("UPDATE explore_views SET name = ?, spec = ?, arrangement = ?, updated_at = ? WHERE id = ?",
                                 (name, json.dumps(spec), json.dumps(arrangement), now(), view_id))
        else:
            view_id = new_id("view")
            self.hive.db.insert("explore_views", {"id": view_id, "owner": viewer.principal, "name": name, "spec": json.dumps(spec),
                                                  "arrangement": json.dumps(arrangement), "created_at": now(), "updated_at": now()})
        return self._view(self.hive.db.one("SELECT * FROM explore_views WHERE id = ?", (view_id,)))

    def delete_view(self, viewer, view_id):
        row = self.hive.db.one("SELECT * FROM explore_views WHERE id = ? AND owner = ?", (view_id, viewer.principal))
        if row is None:
            raise self.hive.error(404, "not_found", "no such view")
        self.hive.db.execute("DELETE FROM explore_views WHERE id = ?", (view_id,))
        return {"id": view_id, "deleted": True}

    # ---- purpose and tags (shared, on the thing itself) and a person's own groups --------------------------

    def _node_owner(self, node_id):
        """(row, table) for a mind or swarm the hive knows, for permission checks."""
        if node_id.startswith("a_"):
            return self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (node_id,)), "agents"
        if node_id.startswith("s_"):
            return self.hive.db.one("SELECT * FROM swarms WHERE id = ?", (node_id,)), "swarms"
        return None, None

    def set_meta(self, viewer, node_id, data):
        """A mind's or swarm's purpose and tags: shared with everyone who can see it; its owner or an admin edits."""
        row, _ = self._node_owner(node_id)
        if row is None or not viewer.sees(row):
            raise self.hive.error(404, "not_found", "no such mind or swarm")
        if not viewer.admin and row.get("owner") != viewer.principal:
            raise self.hive.error(403, "owner_only", "only its owner or an admin changes its purpose or tags")
        cur = self.hive.db.one("SELECT * FROM node_meta WHERE node_id = ?", (node_id,))
        purpose = str(data["purpose"])[:300].strip() if "purpose" in data else (cur["purpose"] if cur else "")
        if "tags" in data:
            tags = data["tags"]
            if not isinstance(tags, list) or len(tags) > MAX_TAGS:
                raise self.hive.error(400, "bad_request", f"tags is a list of at most {MAX_TAGS}")
            tags = sorted({str(t).strip().lower()[:40] for t in tags if str(t).strip()})
        else:
            tags = json.loads(cur["tags"]) if cur else []
        self.hive.db.execute("INSERT INTO node_meta VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET purpose = excluded.purpose, "
                             "tags = excluded.tags, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                             (node_id, purpose, json.dumps(tags), viewer.principal, now()))
        return {"node_id": node_id, "purpose": purpose, "tags": tags}

    def groups(self, viewer):
        rows = self.hive.db.all("SELECT * FROM explore_groups WHERE owner = ? ORDER BY name", (viewer.principal,))
        return [{**r, "members": json.loads(r["members"])} for r in rows]

    def _group(self, viewer, group_id):
        row = self.hive.db.one("SELECT * FROM explore_groups WHERE id = ? AND owner = ?", (group_id, viewer.principal))
        if row is None:
            raise self.hive.error(404, "not_found", "no such group")
        return row

    def save_group(self, viewer, data, group_id=None):
        name = str(data.get("name") or "").strip()[:60]
        if not name:
            raise self.hive.error(400, "bad_request", "a group needs a name")
        clash = self.hive.db.one("SELECT id FROM explore_groups WHERE owner = ? AND lower(name) = lower(?) AND id != ?",
                                 (viewer.principal, name, group_id or ""))
        if clash:
            raise self.hive.error(409, "exists", "you already have a group with that name")
        if group_id:
            self._group(viewer, group_id)
            self.hive.db.execute("UPDATE explore_groups SET name = ?, updated_at = ? WHERE id = ?", (name, now(), group_id))
        else:
            group_id = new_id("grp")
            self.hive.db.insert("explore_groups", {"id": group_id, "owner": viewer.principal, "name": name,
                                                   "members": "[]", "created_at": now(), "updated_at": now()})
        return next(g for g in self.groups(viewer) if g["id"] == group_id)

    def group_members(self, viewer, group_id, add=None, remove=None):
        row = self._group(viewer, group_id)
        members = json.loads(row["members"])
        visible = {n["id"] for n in self.nodes(viewer)}
        for node_id in add or []:
            if node_id not in visible:
                raise self.hive.error(404, "not_found", f"no such thing {node_id}")
            if node_id not in members:
                members.append(node_id)
        members = [m for m in members if m not in set(remove or [])][:5000]
        self.hive.db.execute("UPDATE explore_groups SET members = ?, updated_at = ? WHERE id = ?", (json.dumps(members), now(), group_id))
        return next(g for g in self.groups(viewer) if g["id"] == group_id)

    def delete_group(self, viewer, group_id):
        self._group(viewer, group_id)
        self.hive.db.execute("DELETE FROM explore_groups WHERE id = ?", (group_id,))
        return {"id": group_id, "deleted": True}
