"""Timed, consented sharing of private memory between minds.

A mind's spaces are private. Another mind in the same swarm can see them only
through a share, which is always time-limited and always the owner's choice:

- **request**: the reader asks for one space (optionally filtered) for N
  minutes and says why; the owner grants or denies;
- **offer**: the owner opens a space to a reader for N minutes;
- **exhibit**: the owner publishes a fixed piece of work (atoms and/or text,
  or a filtered snapshot of a space) to named minds or the whole swarm for N
  minutes. One read replaces a long thread of messages.

Every read is logged. Shares lapse on their own; the owner or the operator can
revoke them at any time. Sharing never crosses swarms (federation comes later).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re

from .db import new_id, now

SCHEMA = """
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, swarm_id TEXT NOT NULL, owner_id TEXT NOT NULL, grantee_id TEXT NOT NULL,
  space TEXT, pattern TEXT, exhibit_id TEXT, minutes REAL NOT NULL, reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, initiated_by TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT,
  reads INTEGER NOT NULL DEFAULT 0, last_read_at TEXT
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id, status);
CREATE INDEX IF NOT EXISTS shares_grantee ON shares(grantee_id, status);
CREATE TABLE IF NOT EXISTS exhibits (
  id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  atoms TEXT NOT NULL, source TEXT, bytes INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  digest TEXT
);
CREATE TABLE IF NOT EXISTS share_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, reader_id TEXT NOT NULL, q TEXT,
  returned INTEGER NOT NULL, created_at TEXT NOT NULL
);
"""
STATUSES = {"requested", "active", "denied", "revoked", "expired"}
DEFAULT_MINUTES = 30
MAX_MINUTES = 240
REQUEST_TTL_MINUTES = 60
MAX_OPEN_REQUESTS = 20
MAX_EXHIBIT_BYTES = 256 * 1024
MAX_EXHIBIT_ATOMS = 2000
MAX_READ_ATOMS = 500


def _canon(skill, *args):
    """A stable command text for an HTTP sharing action, so a person approves exactly what runs."""
    clean = [re.sub(r"[^A-Za-z0-9 _.,:@/-]", "", str(a if a is not None else ""))[:120] for a in args]
    return "(" + skill + "".join(f' "{c}"' for c in clean) + ")"


def exhibit_digest(title, body, atoms):
    """sha256 over the exhibit's exact content, so a reader can bind its work to what it read."""
    payload = json.dumps({"title": title, "body": body, "atoms": atoms}, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()


def _at(minutes):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Shares:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.db._conn.executescript(SCHEMA)
        if "digest" not in {r[1] for r in self.db._conn.execute("PRAGMA table_info(exhibits)")}:
            self.db._conn.execute("ALTER TABLE exhibits ADD COLUMN digest TEXT")
        if "revoked_by" not in {r[1] for r in self.db._conn.execute("PRAGMA table_info(shares)")}:
            self.db._conn.execute("ALTER TABLE shares ADD COLUMN revoked_by TEXT")   # who withdrew it (Surface audit 37)
        # shares revoked before revoked_by existed say so explicitly, never a silent null (Kimi hotfix #2)
        self.db._conn.execute("UPDATE shares SET revoked_by = 'unknown' WHERE status = 'revoked' AND revoked_by IS NULL")

    # ---- helpers --------------------------------------------------------------------------------

    def _minutes(self, minutes):
        try:
            value = float(minutes if minutes not in (None, "") else DEFAULT_MINUTES)
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_request", "minutes must be a number") from None
        if value <= 0:
            raise self.hive.error(400, "bad_request", "minutes must be positive")
        return min(value, MAX_MINUTES)

    def _member(self, swarm_id, who, me):
        """Resolve another mind of the same swarm by id or (case-insensitive) name."""
        who = str(who or "").strip()
        rows = self.db.all("SELECT id, name, swarm_id FROM agents WHERE deleted = 0 AND swarm_id = ?", (swarm_id,))
        match = [r for r in rows if r["id"] == who] or [r for r in rows if r["name"].lower() == who.lower()]
        if not match:
            raise self.hive.error(404, "not_found", f"no mind {who!r} in your swarm")
        if match[0]["id"] == me:
            raise self.hive.error(400, "bad_request", "that is you")
        return match[0]

    def _space(self, owner_id, space):
        space = str(space or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", space):
            raise self.hive.error(400, "bad_request", "bad space name")
        names = {s["name"] for s in self.hive.memory_spaces(owner_id)}
        if space not in names:
            raise self.hive.error(404, "not_found", f"no space {space!r}; spaces: {', '.join(sorted(names)) or 'none'}")
        return space

    def get(self, share_id):
        row = self.db.one("SELECT * FROM shares WHERE id = ?", (share_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no share {share_id}")
        return row

    def view(self, row):
        names = {r["id"]: r["name"] for r in self.db.all("SELECT id, name FROM agents WHERE id IN (?, ?)",
                                                         (row["owner_id"], row["grantee_id"]))}
        out = dict(row, owner_name=names.get(row["owner_id"], row["owner_id"]), grantee_name=names.get(row["grantee_id"]))
        if row["exhibit_id"]:
            ex = self.db.one("SELECT title, bytes, atoms FROM exhibits WHERE id = ?", (row["exhibit_id"],))
            if ex:
                out["exhibit"] = {"title": ex["title"], "bytes": ex["bytes"], "atoms": len(json.loads(ex["atoms"]))}
        return out

    def _emit(self, share_id):
        share = self.view(self.get(share_id))
        self.hive.events.publish("share.updated", share=share)
        return share

    async def _tell(self, agent_id, text, share_id, event):
        await self.hive.send_to_agent(agent_id, text, sender="hive:shares", extra={"event": event, "share_id": share_id})

    def _insert(self, **values):
        row = dict(dict(id=new_id("sh"), space=None, pattern=None, exhibit_id=None, reason="", decided_at=None,
                        expires_at=None, reads=0, last_read_at=None, created_at=now()), **values)
        self.db.insert("shares", row)
        return row["id"]

    # ---- request / grant / deny / offer / revoke ------------------------------------------------

    def _enforce(self, agent, skill, *args):
        self.hive.policy.enforce(agent, skill, _canon(skill, *args))

    async def request(self, agent, owner, space, minutes=None, pattern=None, reason=""):
        self._enforce(agent, "hive-share-request", owner, space, pattern)
        if not agent["swarm_id"]:
            raise self.hive.error(400, "no_swarm", "agent is not in a swarm")
        target = self._member(agent["swarm_id"], owner, agent["id"])
        space = self._space(target["id"], space)
        minutes = self._minutes(minutes)
        existing = self.db.one("SELECT * FROM shares WHERE kind = 'space' AND owner_id = ? AND grantee_id = ? "
                               "AND space = ? AND status IN ('requested', 'active')",
                               (target["id"], agent["id"], space))
        if existing:
            return self.view(existing)
        open_requests = self.db.one("SELECT COUNT(*) AS n FROM shares WHERE grantee_id = ? AND status = 'requested'",
                                    (agent["id"],))["n"]
        if open_requests >= MAX_OPEN_REQUESTS:
            raise self.hive.error(429, "too_many_requests", f"you have {open_requests} unanswered share requests")
        share_id = self._insert(kind="space", swarm_id=agent["swarm_id"], owner_id=target["id"],
                                grantee_id=agent["id"], space=space, pattern=(str(pattern).strip() or None)
                                if pattern else None, minutes=minutes, reason=str(reason or "")[:500],
                                status="requested", initiated_by="grantee", expires_at=_at(REQUEST_TTL_MINUTES))
        what = f"your space '{space}'" + (f" (only atoms containing {pattern!r})" if pattern else "")
        await self._tell(target["id"], f"[SHARE-REQUEST {share_id}] {agent['name']} asks to read {what} for "
                                       f"{minutes:g} min" + (f": {reason}" if reason else "") +
                         f". Answer with hive-share-grant {share_id} or hive-share-deny {share_id}.",
                         share_id, "share_request")
        return self._emit(share_id)

    async def grant(self, agent, share_id, minutes=None):
        share = self.get(share_id)
        if share["owner_id"] != agent["id"]:
            raise self.hive.error(403, "forbidden", "only the owner can grant access")
        self._enforce(agent, "hive-share-grant", share_id)
        if share["status"] != "requested":
            raise self.hive.error(409, "not_requested", f"share is {share['status']}")
        minutes = self._minutes(minutes if minutes not in (None, "") else share["minutes"])
        self.db.update("shares", share_id, {"status": "active", "minutes": minutes, "decided_at": now(),
                                            "expires_at": _at(minutes)})
        await self._tell(share["grantee_id"], f"[SHARE-GRANTED {share_id}] {agent['name']} lets you read their "
                                              f"space '{share['space']}' for {minutes:g} min. Read it with "
                                              f"hive-shared {share_id} <filter or *>.", share_id, "share_granted")
        return self._emit(share_id)

    async def deny(self, agent, share_id, reason=""):
        share = self.get(share_id)
        if share["owner_id"] != agent["id"]:
            raise self.hive.error(403, "forbidden", "only the owner can deny access")
        self._enforce(agent, "hive-share-deny", share_id)
        if share["status"] != "requested":
            raise self.hive.error(409, "not_requested", f"share is {share['status']}")
        self.db.update("shares", share_id, {"status": "denied", "decided_at": now(), "reason": share["reason"]
                                            + (f" | denied: {reason}" if reason else "")})
        await self._tell(share["grantee_id"], f"[SHARE-DENIED {share_id}] {agent['name']} declined"
                                              + (f": {reason}" if reason else "."), share_id, "share_denied")
        return self._emit(share_id)

    async def offer(self, agent, grantee, space, minutes=None, pattern=None, note=""):
        self._enforce(agent, "hive-share-offer", grantee, space, pattern)
        if not agent["swarm_id"]:
            raise self.hive.error(400, "no_swarm", "agent is not in a swarm")
        target = self._member(agent["swarm_id"], grantee, agent["id"])
        space = self._space(agent["id"], space)
        minutes = self._minutes(minutes)
        share_id = self._insert(kind="space", swarm_id=agent["swarm_id"], owner_id=agent["id"],
                                grantee_id=target["id"], space=space,
                                pattern=(str(pattern).strip() or None) if pattern else None, minutes=minutes,
                                reason=str(note or "")[:500], status="active", initiated_by="owner",
                                decided_at=now(), expires_at=_at(minutes))
        await self._tell(target["id"], f"[SHARE-OFFERED {share_id}] {agent['name']} opened their space '{space}' to "
                                       f"you for {minutes:g} min" + (f": {note}" if note else "") +
                         f". Read it with hive-shared {share_id} <filter or *>.", share_id, "share_offered")
        return self._emit(share_id)

    async def revoke(self, share_id, by_agent=None, by_person=None, viewer=None):
        # Revoking only ever narrows access, so no policy can block it. A person's revoke checks visibility here,
        # with no await before the write, so the check and the write cannot be separated (Kimi hotfix #1).
        share = self.visible_share(viewer, share_id) if by_person is not None else self.get(share_id)
        if by_agent is not None and share["owner_id"] != by_agent["id"]:
            raise self.hive.error(403, "forbidden", "only the owner can revoke access")
        if share["status"] not in ("requested", "active"):
            raise self.hive.error(409, "not_open", f"share is {share['status']}")
        by = f"agent:{by_agent['id']}" if by_agent is not None else (by_person or "hive")   # hive = goal/connection ended
        self.db.update("shares", share_id, {"status": "revoked", "decided_at": now(), "revoked_by": by})
        await self._tell(share["grantee_id"], f"[SHARE-REVOKED {share_id}] access was withdrawn.", share_id,
                         "share_revoked")
        return self._emit(share_id)

    # ---- exhibits -------------------------------------------------------------------------------

    async def exhibit(self, agent, title, grantees, minutes=None, body="", atoms=None, space=None, pattern=None):
        """Publish a fixed piece of work to some minds (or 'swarm') for a while."""
        skill = "hive-exhibit-space" if space else "hive-exhibit"
        to = grantees if isinstance(grantees, str) else ",".join(map(str, grantees or []))
        self._enforce(agent, skill, title, to, space, pattern)
        if not agent["swarm_id"]:
            raise self.hive.error(400, "no_swarm", "agent is not in a swarm")
        title = str(title or "").strip()[:200]
        if not title:
            raise self.hive.error(400, "bad_request", "an exhibit needs a title")
        items = [str(a) for a in (atoms or []) if str(a).strip()]
        source = None
        if space:
            space = self._space(agent["id"], space)
            snapshot = self.hive.memory_atoms(agent["id"], space, pattern, limit=MAX_EXHIBIT_ATOMS)
            items += [row["text"] for row in snapshot]
            source = f"{space}" + (f" filtered by {pattern!r}" if pattern else "")
        body = str(body or "")
        size = len(body.encode()) + sum(len(a.encode()) for a in items)
        if not body.strip() and not items:
            raise self.hive.error(400, "bad_request", "an exhibit needs text, atoms or a space")
        if size > MAX_EXHIBIT_BYTES or len(items) > MAX_EXHIBIT_ATOMS:
            raise self.hive.error(413, "too_large", f"exhibits are limited to {MAX_EXHIBIT_BYTES // 1024} KB and "
                                                   f"{MAX_EXHIBIT_ATOMS} atoms")
        minutes = self._minutes(minutes)
        if grantees in ("swarm", ["swarm"], "*"):
            readers = [r for r in self.db.all("SELECT id, name FROM agents WHERE deleted = 0 AND swarm_id = ?",
                                              (agent["swarm_id"],)) if r["id"] != agent["id"]]
        else:
            names = grantees if isinstance(grantees, list) else re.split(r"[,\s]+", str(grantees or ""))
            readers = [self._member(agent["swarm_id"], n, agent["id"]) for n in names if str(n).strip()]
        if not readers:
            raise self.hive.error(400, "bad_request", "name at least one mind, or 'swarm'")
        return await self._publish(agent["id"], agent["name"], agent["swarm_id"], title, readers, minutes, body,
                                   items, source, size)

    async def program_exhibit(self, program_id, swarm_id, title, to, minutes=None, body="", atoms=None):
        """An exhibit owned by a mind program (e.g. a revision-bound snapshot for a named Scientist)."""
        title = str(title or "").strip()[:200]
        items = [str(a) for a in (atoms or []) if str(a).strip()]
        body = str(body or "")
        size = len(body.encode()) + sum(len(a.encode()) for a in items)
        if not title or (not body.strip() and not items):
            raise self.hive.error(400, "bad_request", "an exhibit needs a title and text or atoms")
        if size > MAX_EXHIBIT_BYTES or len(items) > MAX_EXHIBIT_ATOMS:
            raise self.hive.error(413, "too_large", "exhibit too large")
        names = to if isinstance(to, list) else re.split(r"[,\s]+", str(to or ""))
        readers = [self._member(swarm_id, n, None) for n in names if str(n).strip()]
        if not readers:
            raise self.hive.error(400, "bad_request", "name at least one mind")
        return await self._publish(f"program:{program_id}", program_id, swarm_id, title, readers,
                                   self._minutes(minutes), body, items, f"program {program_id}", size)

    async def revoke_program_exhibit(self, program_id, swarm_id, exhibit_id):
        ex = self.db.one("SELECT * FROM exhibits WHERE id = ?", (exhibit_id,))
        if ex is None or ex["owner_id"] != f"program:{program_id}" or ex["swarm_id"] != swarm_id:
            raise self.hive.error(404, "not_found", f"no exhibit {exhibit_id} of this program")
        closed = []
        for share in self.db.all("SELECT id FROM shares WHERE exhibit_id = ? AND status IN ('requested', 'active')",
                                 (exhibit_id,)):
            closed.append((await self.revoke(share["id"]))["id"])
        return {"exhibit_id": exhibit_id, "revoked": closed}

    async def _publish(self, owner_id, owner_name, swarm_id, title, readers, minutes, body, items, source, size):
        exhibit_id = new_id("ex")
        digest = exhibit_digest(title, body, items)
        self.db.insert("exhibits", {"id": exhibit_id, "swarm_id": swarm_id, "owner_id": owner_id,
                                    "title": title, "body": body, "atoms": json.dumps(items), "source": source,
                                    "bytes": size, "created_at": now(), "expires_at": _at(minutes), "digest": digest})
        shares = []
        for reader in readers:
            share_id = self._insert(kind="exhibit", swarm_id=swarm_id, owner_id=owner_id,
                                    grantee_id=reader["id"], exhibit_id=exhibit_id, minutes=minutes, status="active",
                                    initiated_by="owner", decided_at=now(), expires_at=_at(minutes))
            await self._tell(reader["id"], f"[EXHIBIT {share_id}] {owner_name} shares '{title}' ({len(items)} "
                                           f"atoms, {size // 1024 or 1} KB) for {minutes:g} min. Read it with "
                                           f"hive-shared {share_id} *.", share_id, "exhibit")
            shares.append(self._emit(share_id))
        return {"exhibit_id": exhibit_id, "title": title, "atoms": len(items), "bytes": size, "digest": digest,
                "shares": shares}

    # ---- reading --------------------------------------------------------------------------------

    def read(self, agent, share_id, q=None, limit=200, offset=0):
        """One page of a share. Every page says how much exists and where the next one starts,
        so a reader can never take a partial read for the whole thing."""
        share = self.get(share_id)
        if share["grantee_id"] != agent["id"]:
            raise self.hive.error(403, "forbidden", "this share is not yours")
        if share["status"] != "active" or (share["expires_at"] and share["expires_at"] < now()):
            raise self.hive.error(410, "share_closed", f"share is {share['status']}"
                                  + (" (expired)" if share["status"] == "active" else ""))
        self._enforce(agent, "hive-shared", share_id)
        q = None if q in (None, "", "*") else str(q)
        try:
            requested, offset = int(limit or 200), max(0, int(offset or 0))
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_request", "limit and offset must be integers") from None
        limit = max(1, min(requested, MAX_READ_ATOMS))
        if share["kind"] == "exhibit":
            ex = self.db.one("SELECT * FROM exhibits WHERE id = ?", (share["exhibit_id"],))
            atoms = [a for a in json.loads(ex["atoms"]) if not q or q.lower() in a.lower()]
            result = {"kind": "exhibit", "title": ex["title"], "source": ex["source"], "digest": ex["digest"],
                      # the text body comes whole, on the first page only
                      "body": ex["body"] if offset == 0 and not q else "",
                      "body_bytes": len(ex["body"].encode())}
        else:
            rows = self.hive.memory_atoms(share["owner_id"], share["space"], share["pattern"], limit=None)
            atoms = [r["text"] for r in rows if not q or q.lower() in r["text"].lower()]
            result = {"kind": "space", "space": share["space"], "pattern": share["pattern"]}
        page = atoms[offset:offset + limit]
        end = offset + len(page)
        result.update(atoms=page, total=len(atoms), offset=offset, limit=limit, returned=len(page),
                      complete=offset == 0 and end >= len(atoms), next_offset=end if end < len(atoms) else None,
                      limit_clamped=requested > limit)
        self.db.insert("share_reads", {"share_id": share_id, "reader_id": agent["id"], "q": q,
                                       "returned": len(page), "created_at": now()})
        self.db.execute("UPDATE shares SET reads = reads + 1, last_read_at = ? WHERE id = ?", (now(), share_id))
        self._emit(share_id)
        owner = self.db.one("SELECT name FROM agents WHERE id = ?", (share["owner_id"],))
        return dict(result, share_id=share_id, owner=owner["name"] if owner else share["owner_id"],
                    expires_at=share["expires_at"])

    def mine(self, agent):
        rows = self.db.all("SELECT * FROM shares WHERE (owner_id = ? OR grantee_id = ?) "
                           "AND status IN ('requested', 'active') ORDER BY created_at DESC LIMIT 100",
                           (agent["id"], agent["id"]))
        return [self.view(r) for r in rows]

    def visible(self, viewer, share):
        """A person sees a share only if they may see its owner, its grantee and its swarm (admins see all).
        Before this, any signed-in member could list, read the log of and revoke any share (Surface, 2026-10-05).
        No viewer sees nothing: internal callers that mean everything pass an admin viewer (Kimi hotfix #4)."""
        if viewer is None:
            return False
        if viewer.admin:
            return True
        vis = self.hive.visibility
        return (viewer.sees(vis._agent(share["owner_id"])) and viewer.sees(vis._agent(share["grantee_id"]))
                and viewer.sees(vis._swarm(share["swarm_id"])))

    def visible_share(self, viewer, share_id):
        share = self.db.one("SELECT * FROM shares WHERE id = ?", (share_id,))
        if share is None or not self.visible(viewer, share):
            raise self.hive.error(404, "not_found", "no such share")
        return share

    def list(self, status=None, agent_id=None, limit=200, viewer=None):
        sql, params = "SELECT * FROM shares WHERE 1=1", []
        if status:
            sql, params = sql + " AND status = ?", params + [status]
        if agent_id:
            sql, params = sql + " AND (owner_id = ? OR grantee_id = ?)", params + [agent_id, agent_id]
        # fill the page with visible rows, so hidden shares neither shorten it nor push visible ones off (Kimi hotfix #3)
        rows, offset = [], 0
        while len(rows) < limit:
            batch = self.db.all(sql + " ORDER BY created_at DESC, id LIMIT ? OFFSET ?", (*params, limit, offset))
            rows += self.hive.visibility.hide_others_personal(   # an admin's default list: not others' personal minds
                viewer, [r for r in batch if self.visible(viewer, r)], lambda r: [r["owner_id"], r["grantee_id"], r["swarm_id"]])
            if len(batch) < limit:
                break
            offset += limit
        return [self.view(r) for r in rows[:limit]]

    def reads(self, share_id, viewer=None):
        self.visible_share(viewer, share_id)
        rows = self.db.all("SELECT * FROM share_reads WHERE share_id = ? ORDER BY id DESC LIMIT 200", (share_id,))
        if viewer.admin:
            return rows
        # the log names its readers: keep only readers this person may see (Kimi hotfix, sharpest finding)
        vis = self.hive.visibility
        return [r for r in rows if viewer.sees(vis._agent(r["reader_id"]))]

    async def expire(self, moment=None):
        moment = moment or now()
        closed = []
        for share in self.db.all("SELECT * FROM shares WHERE status IN ('requested', 'active') AND expires_at < ?",
                                 (moment,)):
            self.db.update("shares", share["id"], {"status": "expired"})
            if share["status"] == "active":
                await self._tell(share["grantee_id"], f"[SHARE-EXPIRED {share['id']}] your access has ended.",
                                 share["id"], "share_expired")
            self._emit(share["id"])
            closed.append(share["id"])
        return closed
