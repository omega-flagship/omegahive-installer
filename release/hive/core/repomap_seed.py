"""The hive keeps its pinned repository maps loaded by itself (repo-map/1 seed).

A fresh or rebuilt hive has only its own self-map (newhive.InstalledMapCoordinator). The other maps every lane searches
first (REPO_MAPS_FIRST.md) used to need an admin to post each envelope by hand, so a rebuild left them gone until someone
went to the machine. This module closes that gap without an admin session:

- A pinned manifest (``repomap_pinned.json``, shipped with the release; ``HIVE_REPO_MAP_SEED_MANIFEST`` overrides it)
  names each revision: repo, sha, the canonical envelope digest (``repomap.digest_of``), visibility, pinned, and the
  envelope's file name.
- The envelopes come from source directories (``HIVE_REPO_MAP_SEED_DIRS``, a path list; default: ``<data_dir>/repo-map-seed``
  then the coordination intake folder). The envelopes are tens of MB each, so they do not ship in git.
- At start, after the self-map job, every manifest revision that is not loaded is read, checked against the manifest's
  repo, sha and digest, and only then handed to ``RepoMaps.load`` as the host principal ``host:repo-maps``. A digest
  mismatch, a missing file or a different revision already loaded at that sha is refused and reported; nothing is guessed.
- Idempotent. A loaded revision is never changed: same digest is left alone (and pinned when the manifest pins it, through
  the existing digest-checked retention pin); a different digest is reported as a conflict and left alone.
- ``GET /api/admin/repo-maps/seed`` reports the seed status. Nothing here is a member, a mind or a permission.
"""

from __future__ import annotations

import json
import logging
import os
import pathlib
import re
import threading

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from . import repomap

PRINCIPAL = "host:repo-maps"
MANIFEST_SCHEMA = "repo-map-pins/1"
ENV_MANIFEST, ENV_DIRS = "HIVE_REPO_MAP_SEED_MANIFEST", "HIVE_REPO_MAP_SEED_DIRS"
DEFAULT_MANIFEST = pathlib.Path(__file__).resolve().with_name("repomap_pinned.json")
DEFAULT_INTAKE = pathlib.Path.home() / "OmegaDot" / "coordination" / "omegacode" / "intake" / "repo-map"
MANIFEST_MAX = 256 * 1024
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.json\Z")
ENTRY_KEYS = ("repo", "sha", "digest", "visibility", "pinned", "file")
# Entry states. Final good: loaded (was there), seeded (loaded now). Refusals: missing, too_large, unreadable,
# identity_mismatch, digest_mismatch, conflict, refused. In progress: pending, loading. stopped: the hive shut down first.
GOOD = ("loaded", "seeded")


class ManifestInvalid(Exception):
    pass


def parse_manifest(raw):
    """The manifest's revisions, validated; raises ManifestInvalid with a plain reason."""
    try:
        data = json.loads(raw)
    except ValueError:
        raise ManifestInvalid("not JSON") from None
    if (not isinstance(data, dict) or data.get("schema") != MANIFEST_SCHEMA or not isinstance(data.get("revisions"), list)
            or set(data) - {"schema", "revisions", "note"}):
        raise ManifestInvalid(f"expected {{schema: {MANIFEST_SCHEMA}, revisions: [...]}}")
    out, seen = [], set()
    for i, entry in enumerate(data["revisions"]):
        where = f"revisions[{i}]"
        if not isinstance(entry, dict) or set(entry) - set(ENTRY_KEYS) - {"note", "source"} or any(k not in entry for k in ENTRY_KEYS):
            raise ManifestInvalid(f"{where}: exactly {', '.join(ENTRY_KEYS)} (and an optional note and source)")
        repo, sha, digest, visibility, pinned, name = (entry[k] for k in ENTRY_KEYS)
        if type(repo) is not str or not repomap.REPO.fullmatch(repo):
            raise ManifestInvalid(f"{where}.repo: a repo name")
        if type(sha) is not str or not repomap.SHA.fullmatch(sha):
            raise ManifestInvalid(f"{where}.sha: a hex sha")
        if type(digest) is not str or not DIGEST.fullmatch(digest):
            raise ManifestInvalid(f"{where}.digest: sha256:<64 hex>")
        if visibility != "hive" and (type(visibility) is not str or not repomap.SWARM.fullmatch(visibility)):
            raise ManifestInvalid(f"{where}.visibility: hive or swarm:<id>")
        if type(pinned) is not bool:
            raise ManifestInvalid(f"{where}.pinned: true or false")
        if type(name) is not str or not FILE.fullmatch(name) or ".." in name:
            raise ManifestInvalid(f"{where}.file: a plain .json file name, no folders")
        if (repo, sha) in seen:
            raise ManifestInvalid(f"{where}: {repo}@{sha} is listed twice")
        if repo in {r["repo"] for r in out} and "source" in entry:
            raise ManifestInvalid(f"{where}: a tracked repo is listed once")
        source = None
        if "source" in entry:
            from .repomap_sources import SourceInvalid, parse_source
            try:
                source = parse_source(entry["source"], f"{where}.source")
            except SourceInvalid as exc:
                raise ManifestInvalid(str(exc)) from None
        seen.add((repo, sha))
        out.append({"repo": repo, "sha": sha, "digest": digest, "visibility": visibility, "pinned": pinned, "file": name,
                    "source": source})
    return out


class RepoMapSeed:
    def __init__(self, hive, data_dir=None, environ=None):
        environ = os.environ if environ is None else environ
        self.hive = hive
        self.manifest_path = pathlib.Path(environ.get(ENV_MANIFEST, "").strip() or DEFAULT_MANIFEST)
        raw_dirs = environ.get(ENV_DIRS)
        if raw_dirs is not None:
            self.dirs = [pathlib.Path(p) for p in raw_dirs.split(os.pathsep) if p.strip()]
        else:
            self.dirs = ([pathlib.Path(data_dir) / "repo-map-seed"] if data_dir else []) + [DEFAULT_INTAKE]
        self._lock, self._stop = threading.Lock(), threading.Event()
        self._state, self._error, self._entries, self._runs = "idle", None, [], 0
        self.revisions = []   # the manifest's parsed entries from the last run (the tracked sources read them)
        from .repomap_sources import RepoMapSources
        self.sources = RepoMapSources(hive, data_dir or ".", environ=environ)

    # ---- status --------------------------------------------------------------------------------------------------------

    def _set_entry(self, i, **fields):
        with self._lock:
            self._entries[i].update(fields)

    def status(self, sees_private=True):
        maps = self.hive.repo_maps
        with self._lock:
            entries = [dict(e) for e in self._entries]
            out = {"principal": PRINCIPAL, "state": self._state, "error_code": self._error, "runs": self._runs,
                   "manifest": str(self.manifest_path), "source_dirs": [str(d) for d in self.dirs]}
        for e in entries:   # the loader's own space observation for every revision that is in the database
            if e.get("state") in GOOD:
                try:
                    e["space"] = maps.space(e["repo"], e["sha"]).get("status")
                except Exception:   # noqa: BLE001  (status never fails)
                    e["space"] = "unknown"
        out["entries"] = entries
        out["currency"] = self.sources.status(sees_private)   # 1.1: source head, built sha, state, last check per map
        live = getattr(self.hive, "repo_map_live", None)
        if live is not None:
            out["live"] = live.status(sees_private)                # 1.2: stored files and artifacts, mapped as they change
        out["counts"] = {s: sum(1 for e in entries if e.get("state") == s) for s in sorted({e.get("state") for e in entries})}
        return out

    def stop(self):
        self._stop.set()
        self.sources.stop()

    # ---- the seed ------------------------------------------------------------------------------------------------------

    def _find(self, name):
        for folder in self.dirs:
            path = folder / name
            try:
                if path.is_file():
                    return path
            except OSError:
                continue
        return None

    def run_once(self):
        """Load every pinned revision that is missing. Safe to call again; it never changes a loaded revision."""
        with self._lock:
            if self._state == "running":
                return self.status()
            self._state, self._error, self._runs = "running", None, self._runs + 1
        try:
            try:
                raw = self.manifest_path.read_bytes()[:MANIFEST_MAX + 1]
                if len(raw) > MANIFEST_MAX:
                    raise ManifestInvalid("too large")
                revisions = parse_manifest(raw)
            except FileNotFoundError:
                with self._lock:
                    self._state, self._error, self._entries = "unavailable", "manifest_missing", []
                return self.status()
            except (OSError, ManifestInvalid) as exc:
                logging.getLogger("hive").warning("repo map seed: manifest refused (%s)", exc)
                with self._lock:
                    self._state, self._error, self._entries = "error", "manifest_invalid", []
                return self.status()
            self.revisions = revisions
            with self._lock:
                self._entries = [{"repo": r["repo"], "sha": r["sha"], "digest": r["digest"], "visibility": r["visibility"],
                                  "pinned": r["pinned"], "file": r["file"], "state": "pending"} for r in revisions]
            for i, rev in enumerate(revisions):
                if self._stop.is_set():
                    self._set_entry(i, state="stopped")
                    continue
                try:
                    self._seed_one(i, rev)
                except Exception as exc:   # noqa: BLE001  (one revision never stops the others or the hive)
                    logging.getLogger("hive").warning("repo map seed %s@%s: %s", rev["repo"], rev["sha"], type(exc).__name__)
                    self._set_entry(i, state="refused", reason="internal_error")
            with self._lock:
                bad = [e for e in self._entries if e["state"] not in GOOD]
                self._state = "stopped" if self._stop.is_set() else ("partial" if bad else "ready")
        except BaseException:
            with self._lock:
                self._state, self._error = "error", "worker_failed"
            raise
        return self.status()

    def _seed_one(self, i, rev):
        maps, db = self.hive.repo_maps, self.hive.db
        repo, sha, digest = rev["repo"], rev["sha"], rev["digest"]
        row = db.one("SELECT digest, pinned FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
        if row is not None:
            if row["digest"] != digest:
                # a different revision is loaded at this sha: never replaced, said so
                self._set_entry(i, state="conflict", reason="a different envelope is loaded at this repo@sha; left unchanged")
                return
            if rev["pinned"] and not row["pinned"]:
                maps._pin_retained_revision(repo, sha, digest)
            self._set_entry(i, state="loaded")
            return
        path = self._find(rev["file"])
        if path is None:
            self._set_entry(i, state="missing", reason="the envelope file is in none of the source folders")
            return
        self._set_entry(i, state="loading", source=str(path))
        try:
            with path.open("rb") as fh:
                raw = fh.read(repomap.MAX_BODY + 1)
        except OSError:
            self._set_entry(i, state="unreadable", reason="the envelope file could not be read")
            return
        if len(raw) > repomap.MAX_BODY:
            self._set_entry(i, state="too_large", reason=f"the envelope is over {repomap.MAX_BODY // 1048576} MiB")
            return
        try:
            envelope = json.loads(raw)
        except ValueError:
            self._set_entry(i, state="unreadable", reason="the envelope file is not JSON")
            return
        del raw
        if not isinstance(envelope, dict) or envelope.get("repo") != repo or envelope.get("sha") != sha:
            self._set_entry(i, state="identity_mismatch", reason="the envelope names a different repo or sha than the manifest")
            return
        actual = repomap.digest_of(envelope)
        if actual != digest:
            self._set_entry(i, state="digest_mismatch", actual_digest=actual,
                            reason="the envelope's digest differs from the manifest; refused, nothing loaded")
            return
        try:
            result = maps.load(envelope, PRINCIPAL, rev["visibility"], rev["pinned"])
        except Exception as exc:   # the loader's own refusal (HTTPException with its code), recorded without its body
            self._set_entry(i, state="refused", reason=str(getattr(exc, "code", None) or type(exc).__name__)[:80])
            return
        self._set_entry(i, state="loaded" if result.get("unchanged") else "seeded")


def install_routes(app, hive, admin):
    @app.get("/api/admin/repo-maps/seed")
    async def repo_map_seed_status(request: Request):
        session = admin(request)
        owner = hive.ownhive.owner() if getattr(hive, "ownhive", None) is not None else None
        sees = (session.get("principal") or "user:operator") == owner   # private sources: no names or paths to others
        return await run_in_threadpool(hive.repo_map_seed.status, sees)
