"""The files a mind may read, listed; and a notice to a swarm's minds when a person adds one (tester report 11-09).

A person uploaded a file and assigned it to a swarm, but its minds never saw it: a mind could fetch a file only by its
sha256, and nothing told it one had arrived. This module adds no new access rule; it lists, and notifies, by the ones
that exist:

- Assets.agent_may_read (assets.py): a file is a mind's to read when its own swarm is one of the file's owners, or a
  live request to its swarm names an artifact revision of an owner swarm whose manifest lists the file. GET
  /api/agent/assets enumerates exactly those two sources (the second by walking the swarm's live requests, each file
  then checked by agent_may_read itself) and pages them.
- Linked folders (folders.py) are a separate source: the mind's own swarm's folders and any a live request's manifest
  lists (Folders.agent_may_read), with their read-only agent routes. Minds never write there.
- A person's own mind (agents.personal_of) also reads by its person's rule: the person's list rule (Assets.view_for)
  for the listing and their download rule (asset_visible in app.py: any owner swarm they may see) for a read. The
  person's role is read afresh at each call; a disabled or unknown person gives their mind nothing extra.

A PDF's text: hive-asset-get shows a text file's content from its bytes, and asks GET /api/agent/assets/{sha}/text for
a PDF's (pdf_text): the same read rule, the text read by the hive's PDF tool in the sandbox (webtools.pdf_text).

Notices: when a person stores a file for a swarm (POST /api/assets) or an admin links a folder for one, every live mind
of that swarm (at most NOTICE_MAX) gets one hive note in its inbox, as goals and shares do (Hive.send_to_agent), never
waking it: "<person> added <name> (<type>, <size>); read it with hive-asset-get <sha> -". Each (file or folder, swarm,
mind) is noticed once (mind_file_notices). A notice carries the name, type and size, never the file's contents.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

from fastapi import Request

from .db import now
from .visibility import Viewer

log = logging.getLogger("hive.mind_files")

PAGE_DEFAULT = 50
PAGE_MAX = 100
SCAN = 500            # candidate rows read per source, newest first (the people list's own cap)
REQUEST_SCAN = 50     # live requests walked for manifest-listed files
MANIFEST_SCAN = 200   # manifest entries checked in all, across those requests
NOTICE_MAX = 25       # minds told about one file
NAME_MAX = 120
PDF_TYPE = "application/pdf"   # the one stored type whose text the host reads for a mind (pdf_text)

SCHEMA = """CREATE TABLE IF NOT EXISTS mind_file_notices (
  subject TEXT NOT NULL, swarm_id TEXT NOT NULL, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (subject, swarm_id, agent_id))"""


def plain_name(name, fallback="a file"):
    """One line, no control characters or brackets (a notice is a single [tagged] line), at most NAME_MAX."""
    text = re.sub(r"[\x00-\x1f\x7f\[\]]+", " ", str(name or "")).strip()
    text = re.sub(r"\s+", " ", text)
    return (text[:NAME_MAX - 1] + "…") if len(text) > NAME_MAX else (text or fallback)


def human_size(n):
    n = int(n or 0)
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n} {unit}" if unit == "bytes" else f"{n:.1f} {unit}".replace(".0 ", " ")
        n /= 1024
    return f"{n} bytes"


class MindFiles:
    def __init__(self, hive, role_of):
        self.hive, self.db = hive, hive.db
        self.role_of = role_of            # app.role_of: a principal's current role (None: not a person, or disabled)
        self.db.execute(SCHEMA)

    # ---- who reads ---------------------------------------------------------------------------------------

    def person_viewer(self, agent):
        """The Viewer of the person whose own mind this is, with their current role; None for any other mind."""
        principal = agent.get("personal_of")
        if not principal:
            return None
        role = self.role_of({"principal": principal, "kind": "sso"})
        if role not in ("admin", "member"):
            return None
        return Viewer(principal, role == "admin")

    def person_may_read(self, viewer, digest):
        """The person's own download rule (app.asset_visible): any owner swarm they may see admits it."""
        owners = sorted(self.hive.assets.owners(digest))
        if not owners:
            return True        # as asset_visible: a file with no owner swarm is readable by any signed-in person
        for owner in owners:
            try:
                self.hive.visibility.check_path(viewer, {"swarm_id": owner})
                return True
            except Exception:  # noqa: BLE001  (HiveError 404: this owner is not theirs)
                continue
        return False

    def may_read(self, agent, digest, artifact_id=None, revision=None):
        """GET /api/agent/assets/{sha}: the minds' rule, then (a person's own mind only) its person's rule. Returns the
        download name, or None when the mind may not read it."""
        assets = self.hive.assets
        row = assets.row(digest)
        if assets.agent_may_read(agent, digest, artifact_id, revision):
            return assets.agent_download_name(agent, row)
        viewer = self.person_viewer(agent)
        if viewer is not None and self.person_may_read(viewer, digest):
            return assets.download_name(viewer, row)
        return None

    async def pdf_text(self, agent, digest, artifact_id=None, revision=None):
        """GET /api/agent/assets/{sha}/text: the text of a PDF this mind may read (may_read, the download's own rule), for
        hive-asset-get to show (tester report 11-13: no mind could read a PDF a person added; a fetched PDF came back as
        bytes alone). The hive's PDF reader reads it, as it does for web-fetch: its own tool, which the run backend runs
        inside the sandbox with CPU, memory, output and deadline limits, one read at a time per mind. 404 for a file this mind may not read
        (as the download), 415 for a file that is not a PDF or a hive with no PDF reader installed, the reader's own
        refusal otherwise (busy, too slow, unreadable)."""
        if self.may_read(agent, digest, artifact_id, revision) is None:
            raise self.hive.error(404, "not_found", "no such asset for you")
        row, data = self.hive.assets.read(digest)
        if str(row.get("mime") or "").split(";")[0].strip().lower() != PDF_TYPE:
            raise self.hive.error(415, "not_a_pdf", "only a PDF's text is read here; a text file comes with its content")
        from . import webtools
        try:
            text = await webtools.pdf_text(data, webtools.TOTAL_SECONDS, agent["id"])
        except webtools.WebError as exc:
            raise self.hive.error(exc.status, exc.code, exc.message) from None
        if text is None:
            raise self.hive.error(415, "no_pdf_reader", "this hive cannot read PDF text yet")
        text = await asyncio.to_thread(webtools._tidy, text)
        return {"sha256": digest, "mime": row["mime"], "chars": len(text), "text": text}

    # ---- the listing ---------------------------------------------------------------------------------------

    def _entry(self, row, name, by, at, source, where):
        return {"sha256": row["sha256"], "name": name or self.hive.assets.neutral_name(row.get("mime")),
                "mime": row["mime"], "bytes": row["bytes"], "added_at": at, "added_by": by,
                "added_by_name": self.hive.sender_name(by) if by else None, "source": source, "where": where,
                "read": f"hive-asset-get {row['sha256']} {where}"}

    def _swarm_files(self, swarm_id):
        """Files this swarm owns, each under the name, uploader and time of the swarm's own put."""
        rows = self.db.all(
            "SELECT a.*, COALESCE(o.name, CASE WHEN a.owner_swarm = ? THEN a.name END) AS own_name, "
            "COALESCE(o.created_by, a.created_by) AS own_by, COALESCE(o.created_at, a.created_at) AS own_at "
            "FROM assets a LEFT JOIN asset_owners o ON o.sha256 = a.sha256 AND o.owner_swarm = ? "
            "WHERE o.owner_swarm IS NOT NULL OR a.owner_swarm = ? ORDER BY own_at DESC, a.sha256 DESC LIMIT ?",
            (swarm_id, swarm_id, swarm_id, SCAN))
        return [self._entry(r, r["own_name"], r["own_by"], r["own_at"], "swarm", "-") for r in rows]

    def _live_manifests(self, agent):
        """(artifact_id, revision, manifest) for each live request to this mind's swarm whose revision it may read."""
        collab = getattr(self.hive, "collab", None)
        if collab is None or not agent.get("swarm_id"):
            return []
        out = []
        for r in self.db.all("SELECT subject FROM requests WHERE to_swarm = ? AND cancelled_at IS NULL "
                             "ORDER BY created_at DESC LIMIT ?", (agent["swarm_id"], REQUEST_SCAN)):
            try:
                subject = json.loads(r["subject"]) if r["subject"] else {}
                art, n = subject.get("artifact_id"), subject.get("revision")
                if not art or not isinstance(n, int):
                    continue
                manifest = json.loads(collab.read_revision(agent, art, n)["body"])   # raises unless live and readable
            except Exception:  # noqa: BLE001  (not readable now, or not a manifest)
                continue
            if isinstance(manifest, dict):
                out.append((art, n, manifest))
        return out

    def _request_files(self, agent, manifests):
        assets, out, checked = self.hive.assets, [], 0
        for art, n, manifest in manifests:
            listed = [o for o in (manifest.get("originals") or []) + (manifest.get("previews") or []) if isinstance(o, dict)]
            for item in listed:
                sha = item.get("sha256")
                if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                    continue
                checked += 1
                if checked > MANIFEST_SCAN:
                    return out
                try:
                    if not assets.agent_may_read(agent, sha, art, n):   # the very rule the download applies
                        continue
                    row = assets.row(sha)
                except Exception:  # noqa: BLE001
                    continue
                name = plain_name(item.get("path") or "", "") or assets.neutral_name(row.get("mime"))
                out.append(self._entry(row, name, None, row["created_at"], "request", f"{art} {n}"))
        return out

    def _person_files(self, viewer):
        """What the person's own list (GET /api/assets) would show them, newest first."""
        assets, out = self.hive.assets, []
        for row in self.db.all("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?", (SCAN,)):
            view = assets.view_for(viewer, row)
            if view is None:
                continue
            out.append(self._entry(row, view.get("name"), view.get("created_by"), view.get("created_at") or row["created_at"],
                                   "person", "-"))
        return out

    def _folders(self, agent, manifests, request):
        folders = getattr(self.hive, "folders", None)
        if folders is None or not folders.local(request):
            return []
        rows = {r["id"]: (r, None) for r in self.db.all("SELECT * FROM linked_folders WHERE owner_swarm = ? ORDER BY created_at DESC",
                                                         (agent.get("swarm_id") or "",))} if agent.get("swarm_id") else {}
        for art, n, manifest in manifests:
            for f in manifest.get("folders") or []:
                fid = f.get("id") if isinstance(f, dict) else None
                if not isinstance(fid, str) or fid in rows:
                    continue
                row = self.db.one("SELECT * FROM linked_folders WHERE id = ?", (fid,))
                try:
                    if row is not None and folders.agent_may_read(agent, row, art, n):
                        rows[fid] = (row, f"{art} {n}")
                except Exception:  # noqa: BLE001
                    continue
        out = []
        for fid, (row, where) in rows.items():
            q = "" if where is None else "&artifact={}&revision={}".format(*where.split())
            out.append({"id": fid, "label": row["label"], "owner_swarm": row["owner_swarm"], "writable": False,
                        "added_at": row["created_at"], "added_by": row["created_by"],
                        "added_by_name": self.hive.sender_name(row["created_by"]), "source": "request" if where else "swarm",
                        "list": f"/api/agent/folders/{fid}/list?path={q}", "file": f"/api/agent/folders/{fid}/file?path=<path>{q}"})
        return out

    def listing(self, agent, request=None, limit=PAGE_DEFAULT, cursor=None):
        try:
            limit = max(1, min(PAGE_MAX, int(limit)))
        except (TypeError, ValueError):
            raise self.hive.error(400, "bad_request", "limit is a number from 1 to 100")
        start = 0
        if cursor not in (None, "", "-"):
            if not str(cursor).isdigit() or int(cursor) > 3 * SCAN + MANIFEST_SCAN:
                raise self.hive.error(400, "bad_request", "cursor is the next_cursor of an earlier page")
            start = int(cursor)
        manifests = self._live_manifests(agent)
        sources = [self._swarm_files(agent["swarm_id"]) if agent.get("swarm_id") else [], self._request_files(agent, manifests)]
        viewer = self.person_viewer(agent)
        if viewer is not None:
            sources.append(self._person_files(viewer))
        seen, files = set(), []
        for source in sources:          # the first source to name a file keeps it: swarm, then request, then person
            for entry in source:
                if entry["sha256"] not in seen:
                    seen.add(entry["sha256"])
                    files.append(entry)
        files.sort(key=lambda e: (str(e["added_at"] or ""), e["sha256"]), reverse=True)
        page = files[start:start + limit]
        more = start + limit < len(files)
        return {"files": page, "next_cursor": str(start + limit) if more else None, "total": len(files),
                "folders": self._folders(agent, manifests, request) if start == 0 else [],
                "person": viewer.principal if viewer is not None else None}

    # ---- notices -------------------------------------------------------------------------------------------

    async def _tell(self, subject, swarm_id, text, extra, skip=None):
        sent = 0
        for member in self.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0 ORDER BY created_at LIMIT ?",
                                  (swarm_id, NOTICE_MAX)):
            if member["id"] == skip:
                continue
            fresh = self.db.execute("INSERT OR IGNORE INTO mind_file_notices (subject, swarm_id, agent_id, at) VALUES (?,?,?,?)",
                                    (subject, swarm_id, member["id"], now())).rowcount
            if not fresh:
                continue           # told already: one notice per file, swarm and mind
            try:
                await self.hive.send_to_agent(member["id"], text, sender="hive:files", extra=extra, wake=False)
                sent += 1
            except Exception:  # noqa: BLE001  (one mind's refusal never stops the others, nor the upload)
                log.warning("file notice to %s not delivered", member["id"], exc_info=True)
        return sent

    def _who(self, by):
        return self.hive.sender_name(by) or ("The hive operator" if by == "user:operator" else "A person")

    async def asset_stored(self, view, swarm_id, by):
        """After a person's upload for a swarm: tell that swarm's minds once. Never raises."""
        try:
            if not swarm_id or not str(by or "").startswith("user:") or not view or not view.get("sha256"):
                return 0
            sha = view["sha256"]
            name = plain_name(view.get("name") or self.hive.assets.neutral_name(view.get("mime")))
            text = (f"[FILE-ADDED {sha[:12]}] {self._who(by)} added {name} ({view.get('mime')}, {human_size(view.get('bytes'))}); "
                    f"read it with hive-asset-get {sha} -")
            return await self._tell(f"asset:{sha}", swarm_id, text,
                                    {"event": "file_added", "sha256": sha, "swarm_id": swarm_id})
        except Exception:  # noqa: BLE001
            log.warning("file notice for %s failed", (view or {}).get("sha256"), exc_info=True)
            return 0

    async def folder_linked(self, view, by):
        try:
            if not view or not view.get("owner_swarm"):
                return 0
            label = plain_name(view.get("label"), "a folder")
            text = (f"[FOLDER-LINKED {view['id']}] {self._who(by)} linked the folder {label} (read-only); "
                    f"see it with hive-asset-list -")
            return await self._tell(f"folder:{view['id']}", view["owner_swarm"], text,
                                    {"event": "folder_linked", "folder_id": view["id"], "swarm_id": view["owner_swarm"]})
        except Exception:  # noqa: BLE001
            log.warning("folder notice for %s failed", (view or {}).get("id"), exc_info=True)
            return 0


def install_routes(app, hive, agent_from, role_of):
    files = MindFiles(hive, role_of)
    hive.mind_files = files

    @app.get("/api/agent/assets")
    async def agent_list_assets(request: Request, limit: int = PAGE_DEFAULT, cursor: str | None = None):
        agent = agent_from(request)
        return files.listing(agent, request, limit, cursor)

    @app.get("/api/agent/assets/{sha}/text")
    async def agent_asset_text(sha: str, request: Request, artifact: str | None = None, revision: int | None = None):
        return await files.pdf_text(agent_from(request), sha, artifact, revision)

    return files
