"""Repo maps 1.2: what the hive makes or receives is mapped as it happens.

Sources beyond git (repomap_sources.py handles git refs, including private code repos):

- **Stored files** (hive assets, ``hive-asset:sha256:<hex>`` refs): one map per owner team, ``assets-<swarm_id>``, visible
  to that team (its owner and shares, the loader's swarm rule); files with no owner team go to ``assets-host``, owner-only.
- **Artifacts** (collaboration artifacts and their revisions): one map per team, ``artifacts-<swarm_id>``, visible to it.

Updates are event-driven: the in-process EventBus listener sees ``asset.stored`` and ``artifact.revision`` (and, when those
lanes publish them, ``code.controller.applied`` and ``create.plan.*``, recorded as waiting for a producer), marks the
source dirty, and one worker rebuilds only the dirty sources into a new revision, after a short quiet period. Each
revision is content-addressed (its sha is the digest of its nodes), so an unchanged source never makes a new revision.

**Node producers are pluggable per kind** (``PRODUCERS``: a mime prefix to (node kind, type)). Files are never opened:
a node carries metadata only (mime, size, time, the store reference), so documents become ``doc`` nodes and images, data
and everything else typed ``file`` nodes. Code keeps the pinned extractor's depth through the git sources.

**Private code sources (Atlas, OmegaTruth).** Registered only in ``<data_dir>/repo-map-sources.local.json`` (schema
``repo-map-local-sources/1``: repo, a local git path, visibility owner, files code), never in the release manifest (whose
parser refuses owner visibility), so the release, the GitHub mirror export and cloud deploys never carry them. Only code
file kinds are read (repomap_sources.CODE_SUFFIXES) and data-like folders are refused by name (DATA_DIRS: corpus,
records, archives, labels, health, data, ...). The map's visibility is ``owner``: the hive's owner and the principals the
owner grants (``POST /api/repo-maps/{repo}/grants``); an admin is not enough, and status views show such a source to
anyone else as "private" with no name or path. Never hive-wide.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time

from . import repomap
from .db import now

PRINCIPAL = "host:repo-maps"
QUIET_SECONDS = 2.0
SELF_WRITERS = ("host:repo-maps", "hive:installed-source")   # the maps' own receipts and envelopes are not re-mapped
WAITING_KINDS = ("code.controller.applied", "create.plan.")
log = logging.getLogger("hive")
# mime prefix -> (node kind, type label); the first match wins, the empty prefix is the default
PRODUCERS = [
    ("text/markdown", ("doc", "document")), ("text/plain", ("doc", "document")), ("application/pdf", ("doc", "document")),
    ("text/html", ("doc", "document")), ("application/vnd.openxmlformats", ("doc", "document")),
    ("image/", ("file", "image")), ("video/", ("file", "video")), ("audio/", ("file", "audio")),
    ("application/json", ("file", "data")), ("text/csv", ("file", "data")),
    ("text/x-python", ("file", "code")), ("application/javascript", ("file", "code")),
    ("", ("file", "file")),
]


def produce(mime):
    for prefix, result in PRODUCERS:
        if str(mime or "").startswith(prefix):
            return result
    return "file", "file"


def _canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _digest(value):
    return "sha256:" + hashlib.sha256(_canon(value).encode()).hexdigest()


def envelope_for(repo, nodes, kinds):
    """A repo-map/1 envelope over metadata nodes, content-addressed (same nodes, same sha)."""
    nodes = sorted(nodes, key=lambda n: n["id"])
    snapshot = _digest(nodes)
    sha = snapshot.split(":", 1)[1][:40]
    receipt = {"schema": "repo-map-live-receipt/1", "repo": repo, "sha": sha, "snapshot_digest": snapshot,
               "producer": "hive.repomap_live/1", "nodes": len(nodes)}
    return {"schema": "repo-map/1", "repo": repo, "sha": sha, "snapshot_digest": snapshot,
            "extractor": {"id": "hive.repomap_live", "version": "1", "parser": "metadata"},
            "generated_at": now(), "receipt": {"digest": _digest(receipt), "artifact_ref": f"hive-repo-map-live:{repo}@{sha}"},
            "state": "ready", "reason": None, "coverage": {"kinds": kinds, "languages": [], "unresolved": []},
            "nodes": nodes, "edges": [], "truncated": False, "next_cursor": None}


class LiveMaps:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self._lock, self._wake, self._stop = threading.Lock(), threading.Event(), threading.Event()
        self._dirty, self._state, self._waiting = set(), {}, {}
        self._thread = None
        hive.events.listen(self.observe)

    # ---- events -----------------------------------------------------------------------------------------------------

    def observe(self, kind, payload):
        """The EventBus listener: only enqueues."""
        if kind == "asset.stored":
            if payload.get("by") in SELF_WRITERS:
                return
            self.mark(("assets", payload.get("owner_swarm") or None))
        elif kind == "artifact.revision" and payload.get("swarm_id"):
            self.mark(("artifacts", payload["swarm_id"]))
        elif kind.startswith(WAITING_KINDS):
            with self._lock:
                self._waiting[kind] = now()   # seen; no producer for this source kind on this hive yet

    def mark(self, key):
        with self._lock:
            self._dirty.add(key)
        self._wake.set()

    def mark_all(self):
        """Every existing store, once (at start)."""
        for row in self.db.all("SELECT DISTINCT owner_swarm FROM asset_owners"):
            self.mark(("assets", row["owner_swarm"]))
        if self.db.one("SELECT 1 FROM assets WHERE sha256 NOT IN (SELECT sha256 FROM asset_owners) LIMIT 1"):
            self.mark(("assets", None))
        try:
            for row in self.db.all("SELECT DISTINCT owner_swarm FROM artifacts"):
                self.mark(("artifacts", row["owner_swarm"]))
        except Exception:   # noqa: BLE001  (no collaboration tables on this hive)
            pass

    # ---- the worker -------------------------------------------------------------------------------------------------

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="repo-map-live", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait()
            if self._stop.is_set():
                return
            time.sleep(QUIET_SECONDS)   # a burst of stores becomes one revision
            self._wake.clear()
            self.drain()

    def drain(self):
        with self._lock:
            dirty, self._dirty = self._dirty, set()
        for key in sorted(dirty, key=lambda k: (k[0], k[1] or "")):
            try:
                self.rebuild(key)
            except Exception as exc:   # noqa: BLE001
                log.warning("repo map live %s: %s", key[0], type(exc).__name__)
                self._record(key, state="failed", error_code="build_failed")

    # ---- producers --------------------------------------------------------------------------------------------------

    def _swarm_exists(self, swarm_id):
        return bool(swarm_id) and self.db.one("SELECT 1 FROM swarms WHERE id = ?", (swarm_id,)) is not None

    def _asset_nodes(self, swarm_id):
        from .newhive import asset_ref
        if swarm_id:
            rows = self.db.all("SELECT a.sha256, a.mime, a.bytes, a.created_at, COALESCE(o.name, a.name) AS name FROM assets a "
                               "JOIN asset_owners o ON o.sha256 = a.sha256 WHERE o.owner_swarm = ? AND a.created_by NOT IN (?, ?)",
                               (swarm_id, *SELF_WRITERS))
        else:
            rows = self.db.all("SELECT sha256, mime, bytes, created_at, name FROM assets WHERE sha256 NOT IN "
                               "(SELECT sha256 FROM asset_owners) AND created_by NOT IN (?, ?)", SELF_WRITERS)
        nodes = []
        for r in rows:
            kind, label = produce(r["mime"])
            nodes.append({"id": f"asset:{r['sha256']}", "kind": kind, "label": (r["name"] or r["sha256"][:12])[:200],
                          "source_digest": f"sha256:{r['sha256']}", "refs": [],
                          "declaration": {"type": label, "mime": r["mime"], "bytes": r["bytes"], "stored_at": r["created_at"],
                                          "ref": asset_ref(r["sha256"])}})
        return nodes

    def _artifact_nodes(self, swarm_id):
        rows = self.db.all("SELECT a.id, a.kind, a.title, r.n, r.digest, r.created_at FROM artifacts a JOIN artifact_revisions r "
                           "ON r.artifact_id = a.id AND r.n = (SELECT MAX(n) FROM artifact_revisions WHERE artifact_id = a.id) "
                           "WHERE a.owner_swarm = ?", (swarm_id,))
        return [{"id": f"artifact:{r['id']}", "kind": "doc", "label": (r["title"] or r["id"])[:200],
                 "source_digest": str(r["digest"])[:200], "refs": [],
                 "declaration": {"type": "artifact", "artifact_kind": r["kind"], "revision": r["n"], "updated_at": r["created_at"]}}
                for r in rows]

    def rebuild(self, key):
        kind, swarm_id = key
        if kind == "assets":
            repo = f"assets-{swarm_id}" if swarm_id else "assets-host"
            nodes, kinds = self._asset_nodes(swarm_id), ["file", "doc"]
        else:
            repo, nodes, kinds = f"artifacts-{swarm_id}", self._artifact_nodes(swarm_id), ["doc"]
        visibility = f"swarm:{swarm_id}" if self._swarm_exists(swarm_id) else "owner"   # private by default
        self._record(key, repo=repo, private=visibility == "owner", visibility=visibility, last_check=now())
        if not nodes:
            self._record(key, state="current", nodes=0)
            return
        envelope = envelope_for(repo, nodes, kinds)
        maps = self.hive.repo_maps
        previous = self.db.one("SELECT sha FROM repo_maps WHERE repo = ? AND pinned = 1 AND loaded_by = ? ORDER BY rowid DESC LIMIT 1",
                               (repo, PRINCIPAL))
        if previous is not None and previous["sha"] == envelope["sha"]:
            self._record(key, state="current", built_sha=envelope["sha"], nodes=len(nodes))
            return
        result = maps.load(envelope, PRINCIPAL, visibility, True)
        self.db.execute("UPDATE repo_maps SET pinned = 0 WHERE repo = ? AND sha != ? AND loaded_by = ? AND pinned = 1",
                        (repo, envelope["sha"], PRINCIPAL))
        self._record(key, state="current", built_sha=envelope["sha"], digest=result["digest"], nodes=len(nodes), built_at=now(),
                     error_code=None)
        self.hive.events.publish("repo_maps.updated", repo=repo, sha=envelope["sha"], digest=result["digest"],
                                 previous=previous["sha"] if previous else None)

    # ---- status -----------------------------------------------------------------------------------------------------

    def _record(self, key, **fields):
        with self._lock:
            self._state.setdefault(key, {"source": key[0]}).update(fields)

    def status(self, sees_private=True):
        with self._lock:
            rows = [dict(v) for _, v in sorted(self._state.items(), key=lambda kv: (kv[0][0], kv[0][1] or ""))]
            waiting = dict(self._waiting)
        if not sees_private:
            rows = [r if not r.get("private") else {"source": r["source"], "repo": "private", "private": True,
                                                       "state": r.get("state")} for r in rows]
        return {"sources": rows, "waiting_for_producer": waiting}
