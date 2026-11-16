"""Tracked repo-map sources: the hive keeps its maps current by itself (slice 1.1, after repomap_seed.py).

Each pinned-manifest entry (``repomap_pinned.json``) may name a tracked source:

    "source": {"kind": "git", "url": "https://github.com/<org>/<repo>.git" | "path": "/abs/local/mirror",
               "ref": "main", "include": ["hive/"], "exclude": ["hive/tests/"]}

The entry's (sha, digest, file) is only the last-built record, used to bootstrap a fresh hive (repomap_seed.py).

- **Check.** At start (after the seed) and every ``HIVE_REPO_MAP_REFRESH_SECONDS`` (default 3600; 0 = start only), the host
  resolves the ref's head with a read-only ``git ls-remote``. Public https remotes and local paths only; no credentials
  (no helper, no prompt, no config), no pushes. A source that cannot be resolved is ``stale-unknown``, never current, and
  the old map keeps being served.
- **Build.** When the newest host-loaded revision is behind the head, the host fetches that one commit (shallow) into its
  own data folder (``<data_dir>/repo-map-sources/<repo>.git``), lists it with the release-input collector's own git
  transport and path filter (releaseinputs._git / _allowed: atlas/truth, secrets, data, bundles never read), narrows it to
  the entry's include/exclude view, and builds the map with exactly the self-map's producer: the hash-pinned extractor
  (``HIVE_REPOMAP_EXTRACTOR``, pins releaseinputs.EXTRACTOR, newhive.load_pinned_extractor) and newhive.prepare_map
  (receipt addressed, envelope frozen, census verified, loader rules). No second builder.
- **Load.** The receipt and envelope are stored as local assets, the envelope is loaded as ``host:repo-maps`` and pinned as
  current; the revision it replaces is unpinned and stays as history under the loader's retention (newest five).
- **Events.** ``repo_maps.stale`` (behind or unresolvable) and ``repo_maps.updated`` (a new current revision).
- The self-map is not tracked here: it is rebuilt at every start and deploy (newhive.InstalledMapCoordinator).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pathlib
import re
import subprocess
import threading
import time

from . import repomap

PRINCIPAL = "host:repo-maps"
ENV_REFRESH = "HIVE_REPO_MAP_REFRESH_SECONDS"
ENV_NAME = re.compile(r"HIVE_[A-Z0-9_]{1,60}")
ENV_EXTRACTOR = "HIVE_REPOMAP_EXTRACTOR"
URL = re.compile(r"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._/-]+\Z")
REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z")
PREFIX = re.compile(r"[A-Za-z0-9._/-]{1,200}\Z")
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
GIT_TIMEOUT = 120
LOCAL_SOURCES = "repo-map-sources.local.json"   # in the hive's data folder: never in the release, so never exported
LOCAL_SCHEMA = "repo-map-local-sources/1"
# Private code sources (repo maps 1.2; Atlas and OmegaTruth code repos): an explicit allowlist of code file kinds, and
# data-like folders refused by name, so corpus, records, archives, labels and health data are never read. Documented in
# the module docstring of repomap_live.py.
CODE_SUFFIXES = frozenset({".py", ".metta", ".pl", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".java",
                           ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".rb", ".sh"})
DATA_DIRS = frozenset({"data", "datasets", "dataset", "records", "corpus", "corpora", "archive", "archives", "labels",
                       "exports", "imports", "inbox", "vault", "notes", "memory", "memories", "health", "raw", "dumps",
                       "backups", "samples", "fixtures", "private", "secrets", "stores", "sessions", "transcripts"})
log = logging.getLogger("hive")


class SourceInvalid(Exception):
    pass


def parse_source(value, where="source"):
    """A tracked source, validated; raises SourceInvalid."""
    if not isinstance(value, dict) or value.get("kind") != "git" or set(value) - {"kind", "url", "path", "path_env", "ref", "include", "exclude"}:
        raise SourceInvalid(f"{where}: {{kind: git, url | path | path_env, ref, include?, exclude?}}")
    if sum(k in value for k in ("url", "path", "path_env")) != 1:
        raise SourceInvalid(f"{where}: exactly one of url (public https), path (a local mirror) or path_env (the name of "
                            "a host setting holding that path, so a shipped manifest names no machine's paths)")
    location_from_env = None
    if "path_env" in value:
        if type(value["path_env"]) is not str or not ENV_NAME.fullmatch(value["path_env"]):
            raise SourceInvalid(f"{where}.path_env: a HIVE_* setting name")
        got = os.environ.get(value["path_env"], "")
        # unset or not an absolute normalised path: the source is valid but unresolvable here (reported stale-unknown)
        location_from_env = got if got and os.path.isabs(got) and os.path.normpath(got) == got else ""
    if "url" in value and (type(value["url"]) is not str or not URL.fullmatch(value["url"]) or "@" in value["url"]):
        raise SourceInvalid(f"{where}.url: a public https URL, no user or credentials in it")
    if "path" in value and (type(value["path"]) is not str or not os.path.isabs(value["path"])
                            or os.path.normpath(value["path"]) != value["path"]):
        raise SourceInvalid(f"{where}.path: an absolute, normalised local path")
    if type(value.get("ref")) is not str or not REF.fullmatch(value["ref"]) or ".." in value["ref"]:
        raise SourceInvalid(f"{where}.ref: a branch or tag name")
    for key in ("include", "exclude"):
        items = value.get(key, [])
        if not isinstance(items, list) or len(items) > 32 or not all(type(p) is str and PREFIX.fullmatch(p) and ".." not in p for p in items):
            raise SourceInvalid(f"{where}.{key}: a list of up to 32 path prefixes")
    location = value.get("url") or value.get("path") or location_from_env
    return {"kind": "git", "location": location, "ref": value["ref"],
            "include": list(value.get("include", [])), "exclude": list(value.get("exclude", []))}


def git_env():
    """Read-only, credential-free git: no system/global config (so no credential helper), no prompts, https and local
    files only."""
    return {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "LC_ALL": "C", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false",
            "SSH_ASKPASS": "/usr/bin/false", "GIT_ALLOW_PROTOCOL": "https:file", "GIT_OPTIONAL_LOCKS": "0",
            "GIT_NO_REPLACE_OBJECTS": "1"}


def run_git(args, cwd=None, timeout=GIT_TIMEOUT):
    command = ["git", "--no-replace-objects", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
               "-c", "protocol.file.allow=always", *args]
    done = subprocess.run(command, cwd=cwd, env=git_env(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if done.returncode != 0:
        raise RuntimeError("git_failed")
    return done.stdout


def resolve_head(source):
    """The ref's current commit at the source, by ls-remote (nothing fetched)."""
    if not source.get("location"):
        raise RuntimeError("source_unresolved")   # a path_env setting not set on this host
    out = run_git(["ls-remote", "--", source["location"], source["ref"], f"refs/heads/{source['ref']}",
                   f"refs/tags/{source['ref']}^{{}}"]).decode("ascii", "replace")
    heads = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 2 and HEX40.fullmatch(parts[0]):
            heads[parts[1]] = parts[0]
    for name in (f"refs/tags/{source['ref']}^{{}}", f"refs/heads/{source['ref']}", source["ref"], f"refs/tags/{source['ref']}"):
        if name in heads:
            return heads[name]
    raise RuntimeError("ref_not_found")


def _in_view(path, source):
    if source["include"] and not any(path.startswith(p) for p in source["include"]):
        return False
    return not any(path.startswith(p) for p in source["exclude"])


def code_only(name):
    """The private-source filter: code file kinds only, no data-like folder, no secret-like name, canonical path."""
    from . import newhive as nh
    from . import releaseinputs as ri
    parts = name.lower().split("/")
    if pathlib.PurePosixPath(name).suffix.lower() not in CODE_SUFFIXES:
        return False
    if any(p in DATA_DIRS or p in ri.BLOCKED_DIRS for p in parts[:-1]) or any(p.startswith(".env") or p in ri.BLOCKED_NAMES for p in parts):
        return False
    try:
        nh.check_path(name)
    except nh.SourceRefused:
        return False
    return True


def parse_local(raw):
    """The data folder's private registrations: git paths only, owner visibility only, code files only."""
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schema") != LOCAL_SCHEMA or not isinstance(data.get("sources"), list):
        raise SourceInvalid(f"expected {{schema: {LOCAL_SCHEMA}, sources: [...]}}")
    out = []
    for i, entry in enumerate(data["sources"]):
        if not isinstance(entry, dict) or set(entry) - {"repo", "source", "visibility", "files"} or "url" in (entry.get("source") or {}):
            raise SourceInvalid(f"sources[{i}]: {{repo, source (a local git path), visibility: owner, files: code}}")
        if entry.get("visibility", "owner") != "owner" or entry.get("files", "code") != "code":
            raise SourceInvalid(f"sources[{i}]: private sources are owner-only and code-only")
        if type(entry.get("repo")) is not str or not repomap.REPO.fullmatch(entry["repo"]):
            raise SourceInvalid(f"sources[{i}].repo: a repo name")
        out.append({"repo": entry["repo"], "visibility": "owner", "pinned": True, "files": "code",
                    "source": parse_source(entry["source"], f"sources[{i}].source")})
    return out


def collect_commit(git_dir, sha, repo, source, files_filter=None):
    """(Manifest, Sources) of one fetched commit: the release-input collector's transport and path filter, then the view."""
    from . import newhive as nh
    from . import releaseinputs as ri
    until = time.monotonic() + GIT_TIMEOUT
    stamp = ri._git(git_dir, ["show", "--no-patch", "--format=%cI", sha, "--"], until, limit=128).decode("ascii").strip()
    listing = ri._git(git_dir, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha], until)
    entries, total = [], 0
    for record in listing.split(b"\0"):
        if not record:
            continue
        meta, raw_path = record.split(b"\t", 1)
        try:
            name = raw_path.decode("utf-8", "strict")
        except UnicodeError:
            continue
        if not _in_view(name, source) or not (files_filter(name) if files_filter else ri._allowed(name)):
            continue
        mode, kind, oid, size = meta.decode("ascii").split()
        if mode not in ("100644", "100755") or kind != "blob":
            continue
        total += int(size)
        entries.append((name, oid, int(size)))
        if len(entries) > nh.MAX_FILES or total > nh.MAX_TOTAL:
            raise nh.SourceRefused("oversize", "the source is larger than the map limits")
    if not entries:
        raise nh.SourceRefused("manifest_invalid", "the source view holds no mappable files")
    request = b"".join(oid.encode("ascii") + b"\n" for _, oid, _ in entries)
    overhead = sum(len(oid) + len(str(size)) + 8 for _, oid, size in entries)
    stream = ri._git(git_dir, ["cat-file", "--batch"], until, data=request, limit=total + overhead)
    files, contents, offset = [], {}, 0
    for name, oid, size in entries:
        end = stream.find(b"\n", offset)
        if end < offset or stream[offset:end].decode("ascii").split() != [oid, "blob", str(size)]:
            raise nh.SourceRefused("git_source_refused", "the object stream did not match the listing")
        body = stream[end + 1:end + 1 + size]
        offset = end + 1 + size + 1
        if hashlib.sha1(b"blob " + str(size).encode() + b"\0" + body, usedforsecurity=False).hexdigest() != oid:
            raise nh.SourceRefused("git_source_refused", "an object did not match its id")
        files.append((name, size, hashlib.sha256(body).hexdigest()))
        contents[name] = body
    pins = {n: pin[1] for n, pin in ri.EXTRACTOR.items()}
    raw = nh._canon_bytes({"schema": nh.MANIFEST_SCHEMA, "repo": repo, "sha": sha, "generated_at": stamp,
                           "files": [{"path": p, "size": s, "sha256": d} for p, s, d in sorted(files)],
                           "extractor": {"files": pins}})
    manifest = nh.Manifest(nh._sha(raw), repo, sha, stamp, tuple(sorted(files)), {"files": pins})
    return manifest, nh.Sources(manifest, contents, {})


class RepoMapSources:
    def __init__(self, hive, data_dir, environ=None, extractor=None):
        environ = os.environ if environ is None else environ
        self.hive, self.data_dir = hive, pathlib.Path(data_dir)
        try:
            self.interval = max(0, int(environ.get(ENV_REFRESH, "3600") or 0))
        except ValueError:
            self.interval = 3600
        self.extractor_dir = environ.get(ENV_EXTRACTOR, "")
        self.enabled = environ.get("HIVE_REPO_MAP_TRACKING", "on").strip().lower() not in ("0", "off", "false", "no")
        self._extractor = extractor      # tests inject an ExtractorAdapter; production loads the pinned package
        self._lock, self._stop, self._run_lock = threading.Lock(), threading.Event(), threading.Lock()
        self._state = {}                 # repo -> currency record

    def local_revisions(self):
        """Private registrations from the data folder (a config entry the owner enables; no content in it)."""
        path = self.data_dir / LOCAL_SOURCES
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return []
        except OSError:
            return []
        try:
            return parse_local(raw)
        except (ValueError, SourceInvalid):
            log.warning("repo map sources: the local source registrations were refused")
            return []

    # ---- status ---------------------------------------------------------------------------------------------------

    def _set(self, repo, **fields):
        with self._lock:
            self._state.setdefault(repo, {"repo": repo}).update(fields)

    def status(self, sees_private=True):
        """sees_private False (anyone but the owner): private sources show as private, with no name, path or sha."""
        with self._lock:
            rows = [dict(v) for _, v in sorted(self._state.items())]
        if not sees_private:
            rows = [r if not r.get("private") else {"repo": "private", "private": True, "state": r.get("state"),
                                                       "last_check": r.get("last_check")} for r in rows]
        return rows

    def stop(self):
        self._stop.set()

    # ---- the check ------------------------------------------------------------------------------------------------

    def _current(self, repo):
        """The newest revision loaded for this repo (the one reads should use), or None."""
        return self.hive.db.one("SELECT sha, digest, pinned, loaded_by FROM repo_maps WHERE repo = ? ORDER BY pinned DESC, rowid DESC "
                                "LIMIT 1", (repo,))

    def _adapter(self):
        if self._extractor is not None:
            return self._extractor
        from . import newhive as nh
        from . import releaseinputs as ri
        if not self.extractor_dir:
            raise nh.SourceRefused("extractor_unavailable", "this hive names no pinned extractor package")
        return nh.load_pinned_extractor(self.extractor_dir, {n: pin[1] for n, pin in ri.EXTRACTOR.items()})

    def check_all(self, revisions):
        """revisions: the manifest's parsed entries (repomap_seed.parse_manifest). One pass; never raises."""
        if not self._run_lock.acquire(blocking=False):
            return self.status()
        try:
            for rev in revisions:
                if self._stop.is_set():
                    break
                if rev.get("source") is None:
                    continue
                try:
                    self.check_one(rev)
                except Exception as exc:   # noqa: BLE001  (one source never stops the others or the hive)
                    log.warning("repo map source %s: %s", rev["repo"], type(exc).__name__)
                    self._set(rev["repo"], state="failed", error_code="internal_error")
        finally:
            self._run_lock.release()
        return self.status()

    def check_one(self, rev):
        from . import newhive as nh
        repo, source, events = rev["repo"], rev["source"], self.hive.events
        current = self._current(repo)
        self._set(repo, private=rev["visibility"] == "owner", source=source["location"] if rev["visibility"] == "hive" else "private",
                  ref=source["ref"], built_sha=current["sha"] if current else None, last_check=_now())
        try:
            head = resolve_head(source)
        except Exception:   # noqa: BLE001  (unreachable, unknown ref, timeout: never current)
            self._set(repo, state="stale-unknown", head=None, error_code="source_unresolved")
            events.publish("repo_maps.stale", repo=repo, state="stale-unknown", built_sha=current["sha"] if current else None)
            return
        self._set(repo, head=head)
        if current is not None and current["sha"] == head:
            self._set(repo, state="current", error_code=None)
            return
        self._set(repo, state="behind", error_code=None)
        events.publish("repo_maps.stale", repo=repo, state="behind", head=head, built_sha=current["sha"] if current else None)
        self._set(repo, state="building")
        try:
            result = self._build(rev, head)
        except nh.SourceRefused as exc:
            self._set(repo, state="failed", error_code=exc.code)
            return
        except Exception as exc:   # noqa: BLE001
            self._set(repo, state="failed", error_code=getattr(exc, "code", None) if isinstance(getattr(exc, "code", None), str)
                      else str(exc)[:40] if isinstance(exc, RuntimeError) else "build_failed")
            return
        self._set(repo, state="current", built_sha=result["sha"], digest=result["digest"], error_code=None, built_at=_now())
        events.publish("repo_maps.updated", repo=repo, sha=result["sha"], digest=result["digest"],
                       previous=current["sha"] if current else None)

    def _fetch(self, repo, source, head):
        git_dir = self.data_dir / "repo-map-sources" / f"{repo}.git"
        if not (git_dir / "HEAD").exists():
            git_dir.parent.mkdir(parents=True, exist_ok=True)
            run_git(["init", "--bare", "-q", str(git_dir)])
        run_git(["fetch", "-q", "--no-tags", "--depth=1", "--", source["location"],
                 f"+{source['ref']}:refs/tracked/{source['ref']}"], cwd=str(git_dir))
        fetched = run_git(["rev-parse", "--verify", f"refs/tracked/{source['ref']}^{{commit}}"], cwd=str(git_dir)).decode().strip()
        if not HEX40.fullmatch(fetched):
            raise RuntimeError("fetch_failed")
        return git_dir, fetched   # the ref may have moved since ls-remote: the fetched commit is what gets built

    def _build(self, rev, head):
        from . import newhive as nh
        repo, source, maps = rev["repo"], rev["source"], self.hive.repo_maps
        try:
            git_dir, sha = self._fetch(repo, source, head)
        except Exception:   # noqa: BLE001
            raise nh.SourceRefused("fetch_failed", "the source could not be fetched") from None
        self._set(repo, head=sha)
        existing = self.hive.db.one("SELECT digest FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
        if existing is None:
            manifest, sources = collect_commit(git_dir, sha, repo, source, code_only if rev.get("files") == "code" else None)
            prepared = nh.prepare_map(sources, self._adapter())   # the self-map's producer: verified, loader-valid
            self._store(prepared.receipt_bytes, prepared.receipt_sha256, f"Repo map receipt {repo}")
            self._store(prepared.envelope_bytes, prepared.envelope_sha256, f"Repo map {repo}")
            result = maps.load(json.loads(prepared.envelope_bytes), PRINCIPAL, rev["visibility"], True)
            digest = result["digest"]
        else:
            digest = existing["digest"]
            maps._pin_retained_revision(repo, sha, digest)
        # the new revision is current; the previous host pins become history under the loader's retention
        self.hive.db.execute("UPDATE repo_maps SET pinned = 0 WHERE repo = ? AND sha != ? AND loaded_by = ? AND pinned = 1",
                             (repo, sha, PRINCIPAL))
        return {"sha": sha, "digest": digest}

    def _store(self, raw, expected, name):
        assets = getattr(self.hive, "assets", None)
        if assets is None:
            return
        result = assets.put(raw, "application/json", PRINCIPAL, name=name, store="local")
        if result.get("sha256") != expected:
            from . import newhive as nh
            raise nh.SourceRefused("retained_artifact_missing", "the stored map artifact did not match")

    # ---- the schedule ---------------------------------------------------------------------------------------------

    def loop(self, revisions_fn):
        """Runs on its own thread: one pass now, then every interval until stopped."""
        while self.enabled and not self._stop.is_set():
            try:
                self.check_all(list(revisions_fn()) + self.local_revisions())
            except Exception:   # noqa: BLE001
                log.warning("repo map sources: pass failed")
            if not self.interval or self._stop.wait(self.interval):
                return


def _now():
    from .db import now
    return now()
