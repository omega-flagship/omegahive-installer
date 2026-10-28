"""The new installer hive, round R1a (boot/source, host side).

Plan of record: coordination/omegacode/NEW_HIVE_REPOMAP_AND_DONE_GATE_PLAN_R1_1.md (sha256 1a506b59) §1, §3, §4, §10 (R1),
§12, as amended by NEW_HIVE_REPOMAP_AND_DONE_GATE_PLAN_R1_2_1_NEW_USER_ADDENDUM.md §A/§B (the operation-scoped coding
barrier replaces the blanket bootstrap paid-work hold).

Everything here is inert unless the data folder carries the required-feature marker AND HIVE_LOCAL_OWNER=1. A hive
without the marker (every hive today) never constructs NewHive; a marker without HIVE_LOCAL_OWNER=1 refuses to start.

- The installed-source manifest collector (``collect_sources``): only regular, canonical, manifest-listed files inside
  the verified release source root, with exact size and sha256; refuses escapes, links anywhere in the tree, secret-like
  or unsupported paths, missing or dirty files, oversize census and unlisted importable shadows. Never deletes anything.
- The extractor adapter (``load_pinned_extractor`` / ``ExtractorAdapter``): Code's fixed entry point
  ``build_repository_map(sources, *, repo, sha, artifact_ref, generated_at=None) -> (envelope, receipt)``, loaded from
  the three hash-pinned files of the J1 dependency by executing the verified bytes themselves (no path search, no
  cached bytecode, never mutable omegacode/src).
- Finalisation (``prepare_map``): the receipt is addressed first, the envelope's receipt.artifact_ref becomes that asset
  reference, then receipt / content-without-receipt / census digests are checked and the envelope is frozen.
- The required-feature marker (``init_data_dir`` / ``check_startup``): written once into a fresh, explicitly selected
  data folder (file plus a database row); startup refuses any mismatch, never takes a folder over.
- The ``sso-bootstrap`` helper session (``NewHive``): minted through the same-uid control socket's one-use 60 s code,
  bound to this process instance, the installed binding and one attempt. The attempt's deadline is fixed at begin
  (begin + 10 minutes); the bearer's expiry is min(that deadline, exchange + 10 minutes), so it never outlives its
  attempt and nothing (polling, a renewed attempt) ever extends it; accepted only on four
  exact routes with exact digests (``admit``), never by the ordinary session lookup; retired by an exact
  token_hash/kind/principal DELETE whose rowcount decides first completion versus replay; swept on expiry and startup.
- The coding-readiness barrier (``coding_ready`` / ``require_coding``): mind start/restore, goal claims and the Code
  routes hold until the installed map is completed and mounted; the person's Ask (the conductor never wakes a mind) and
  ordinary reads are untouched.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import dataclasses
import errno
import hashlib
import json
import logging
import os
import pathlib
import re
import secrets
import sqlite3
import stat
import sys
import threading
import time
import types
from datetime import datetime, timezone

from .localowner import CODE_RE, CODE_SECONDS, LocalOwnerRefused

log = logging.getLogger("hive")

FEATURE = "repo-work-gate/1"
FEATURES = (FEATURE,)
MARKER_NAME = "required-features.json"
MARKER_SCHEMA = "omegahive-required-features/1"
MARKER_MAX = 64 * 1024
MANIFEST_SCHEMA = "omegahive-source-manifest/1"
MANIFEST_MAX = 4 * 1024 * 1024
REPO_ID = "omegahive"
BOOTSTRAP_KIND = "sso-bootstrap"
BOOTSTRAP_SECONDS = 600   # r1.1 §3: min(10 minutes, issued session expiry), never extended
NATIVE_TTL = 10.0          # seconds between native readiness counts (Kimi R1a P2-1)
NATIVE_STALE_MAX = 60.0    # how long a fresh native answer may stand while the repo lock is busy
MAX_FILES, MAX_TOTAL = 4096, 96 * 1024 * 1024   # the extractor's own census bounds (repository_map._validate_sources)
PENDING_REF = "pending:receipt-not-yet-addressed"   # never loaded: replaced before the envelope is frozen
EXTRACTOR_FILES = ("__init__.py", "repository_facts.py", "repository_map.py")

ENV_RELEASE_MANIFEST = "HIVE_RELEASE_MANIFEST"   # the verified release's code-only source manifest (J1 package)
ENV_RELEASE_SOURCE = "HIVE_RELEASE_SOURCE"       # the verified release source root that manifest describes
ENV_EXTRACTOR = "HIVE_REPOMAP_EXTRACTOR"         # the pinned 3-file extractor package folder (J1 dependency)
ENV_REQUIRED = "HIVE_REQUIRED_FEATURES"          # the launcher asserting a gated install: can require, never disable
ENV_INSTALLATION = "HIVE_INSTALLATION_ID"        # the launcher's expected installation id, when it has one

HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")

# code-only (r1.1 §3): never a source input, even when a manifest lists it
SECRET_PARTS = frozenset({".git", ".hg", ".svn", ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".config"})
SECRET_NAMES = frozenset({"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", ".netrc",
                          ".pypirc", ".npmrc", "admin-password", "hive.db", "secrets.json", "keyring.json"})
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".kdbx")
# an unlisted file Python could import in place of (or beside) a listed one
IMPORTABLE_SUFFIXES = (".py", ".pyc", ".pyo", ".pyd", ".so", ".pth", ".dylib", ".dll", ".egg-link")
PATH_CHARS = re.compile(r"[A-Za-z0-9._+@=,-]+\Z")   # one path part: no spaces, quotes, controls, colons or backslashes

# r1.1 §3: the only routes a sso-bootstrap session may reach (method, route template)
BOOTSTRAP_ROUTES = frozenset({("POST", "/api/assets"), ("GET", "/api/assets/{sha}"),
                              ("POST", "/api/admin/repo-maps"), ("GET", "/api/repo-maps/{repo}/{sha}")})
# r1.2.1 §4 default copy outside Pro
COPY = {"getting_ready": "Getting your coding tools ready", "ready": "Ready",
        "not_ready": "Coding tools aren't ready yet", "retry": "Try setup again"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS required_features (
  feature TEXT PRIMARY KEY, installation TEXT NOT NULL, marker_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS newhive_bindings (
  manifest_sha256 TEXT PRIMARY KEY, repo TEXT NOT NULL, sha TEXT NOT NULL, first_seen_at REAL NOT NULL,
  last_seen_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS local_bootstrap_codes (
  code_hash TEXT PRIMARY KEY, attempt TEXT NOT NULL, instance TEXT NOT NULL, created_at REAL NOT NULL,
  expires_at REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS local_bootstrap_sessions (
  attempt TEXT PRIMARY KEY, token_hash TEXT UNIQUE, installation TEXT NOT NULL, instance TEXT NOT NULL,
  principal TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,
  map_digest TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, envelope_sha256 TEXT NOT NULL, runtime TEXT NOT NULL,
  created_at REAL NOT NULL, deadline REAL NOT NULL, exchanged_at REAL, retired_at REAL, retired_reason TEXT);
CREATE TABLE IF NOT EXISTS newhive_timings (
  instance TEXT PRIMARY KEY, started_at REAL NOT NULL, first_signin_at REAL, first_ask_at REAL, code_ready_at REAL,
  code_ready_rss_kb INTEGER);
CREATE TABLE IF NOT EXISTS local_bootstrap_completions (
  manifest_sha256 TEXT PRIMARY KEY, attempt TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL, principal TEXT NOT NULL,
  repo TEXT NOT NULL, sha TEXT NOT NULL, map_digest TEXT NOT NULL, receipt_sha256 TEXT NOT NULL,
  envelope_sha256 TEXT NOT NULL, runtime TEXT NOT NULL, completed_at REAL NOT NULL);
"""


# Closed bootstrap refusal vocabulary shared with the launcher helper.
BEGIN_REASON_CODES = frozenset({
    "dirty", "envelope_invalid", "extraction_failed", "extractor_changed", "extractor_unavailable", "manifest_changed",
    "manifest_invalid", "manifest_missing", "map_conflict", "missing", "oversize", "receipt_mismatch",
    "retained_artifact_missing", "runtime_changed", "shadow", "source_root", "symlink", "too_large", "unsupported_file",
    "unsupported_path", "unsupported_platform", "verify_failed"})

def _begin_error(stage, code):
    """Status diagnostics expose a fixed stage/code only, never source messages or paths."""
    stage = "install" if stage == "assets" else stage
    return {"stage": stage if stage in ("source", "map", "install") else "begin",
            "code": code if isinstance(code, str) and code in BEGIN_REASON_CODES else "unexpected"}


class SourceRefused(Exception):
    """The installed source cannot be used: code names the stage-specific reason, path the file (never its bytes)."""

    def __init__(self, code, message, path=None):
        super().__init__(message)
        self.code, self.message, self.path = code, message, path

    def view(self):
        return {"code": self.code, "message": self.message, **({"path": self.path} if self.path else {})}


def _canon_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def canonical_digest(value):
    """The extractor's and the loader's canonical digest (repository_map.canonical_digest == repomap.digest_of)."""
    return "sha256:" + hashlib.sha256(_canon_bytes(value)).hexdigest()


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def runtime_identity():
    """The interpreter that runs the extractor (Code R1a binding: facts.parser embeds sys.version_info[:3], so the
    launcher and the host must run the same J1-pinned Python implementation and patch version)."""
    return f"{sys.implementation.name}-{'.'.join(str(v) for v in sys.version_info[:3])}"


def asset_ref(hexdigest):
    """The receipt's custody reference: the local content-addressed Assets plane."""
    return f"hive-asset:sha256:{hexdigest}"


# ---- the release's code-only source manifest ------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Manifest:
    sha256: str
    repo: str
    sha: str
    generated_at: str
    files: tuple            # ((path, size, sha256hex), ...) sorted by path
    extractor: dict | None  # {"files": {name: sha256hex}} for the pinned 3-file extractor package


def _check_part(part, where):
    if not part or part in (".", "..") or not PATH_CHARS.fullmatch(part):
        raise SourceRefused("unsupported_path", f"{where}: not a canonical relative path", where)


def check_path(path):
    """A manifest path: relative POSIX, canonical, no '.'/'..'/empty parts, no secret-like or unsupported name."""
    if not isinstance(path, str) or not path or len(path) > 1024 or path.startswith("/") or path.endswith("/"):
        raise SourceRefused("unsupported_path", "a manifest path must be a canonical relative path", str(path)[:200])
    parts = path.split("/")
    for part in parts:
        _check_part(part, path)
    lowered = [p.lower() for p in parts]
    leaf = lowered[-1]
    if (any(p in SECRET_PARTS for p in lowered) or leaf in SECRET_NAMES or leaf.startswith(".env")
            or leaf.endswith(SECRET_SUFFIXES) or "__pycache__" in lowered):
        raise SourceRefused("unsupported_path", "this path is not code-only source (secret, data or cache)", path)
    return path


def parse_manifest(raw):
    """The manifest's exact bytes -> Manifest. Its sha256 is over these exact bytes."""
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > MANIFEST_MAX:
        raise SourceRefused("manifest_invalid", "the release source manifest is missing or too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise SourceRefused("manifest_invalid", "the release source manifest is not JSON") from None
    if not isinstance(data, dict) or set(data) - {"schema", "repo", "sha", "generated_at", "files", "extractor"} \
            or not {"schema", "repo", "sha", "generated_at", "files"} <= set(data):
        raise SourceRefused("manifest_invalid", "the release source manifest has unexpected or missing fields")
    if data["schema"] != MANIFEST_SCHEMA:
        raise SourceRefused("manifest_invalid", f"this host reads {MANIFEST_SCHEMA} manifests only")
    if data["repo"] != REPO_ID:
        raise SourceRefused("manifest_invalid", f"the installed source is repo {REPO_ID!r}")
    if not isinstance(data["sha"], str) or not HEX40.fullmatch(data["sha"]):
        raise SourceRefused("manifest_invalid", "the installed source needs its exact full 40-character Git SHA")
    stamp = data["generated_at"]
    if not isinstance(stamp, str) or not stamp or len(stamp) > 64:
        raise SourceRefused("manifest_invalid", "generated_at is the release's recorded generation time")
    try:
        datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        raise SourceRefused("manifest_invalid", "generated_at is not an ISO 8601 time") from None
    files = data["files"]
    if not isinstance(files, list) or not files:
        raise SourceRefused("manifest_invalid", "the manifest lists no files")
    if len(files) > MAX_FILES:
        raise SourceRefused("oversize", f"the manifest lists more than {MAX_FILES} files")
    out, seen, total = [], set(), 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise SourceRefused("manifest_invalid", "each manifest file is exactly {path, size, sha256}")
        path = check_path(entry["path"])
        size, digest = entry["size"], entry["sha256"]
        if path in seen:
            raise SourceRefused("manifest_invalid", "a path is listed twice", path)
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise SourceRefused("manifest_invalid", "a file size is a whole number of bytes", path)
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise SourceRefused("manifest_invalid", "a file sha256 is 64 lowercase hex characters", path)
        total += size
        if size > MAX_TOTAL or total > MAX_TOTAL:
            raise SourceRefused("oversize", f"the source census is larger than {MAX_TOTAL // 1048576} MiB", path)
        seen.add(path)
        out.append((path, size, digest))
    lowered = {}
    for path, _, _ in out:   # a case-insensitive file system would read two listed paths as one file
        key = path.lower()
        if key in lowered:
            raise SourceRefused("manifest_invalid", "two listed paths differ only by case", path)
        lowered[key] = path
    extractor = data.get("extractor")
    if extractor is not None:
        if (not isinstance(extractor, dict) or set(extractor) != {"files"} or not isinstance(extractor["files"], dict)
                or set(extractor["files"]) != set(EXTRACTOR_FILES)
                or not all(isinstance(v, str) and HEX64.fullmatch(v) for v in extractor["files"].values())):
            raise SourceRefused("manifest_invalid", "extractor pins are exactly the three package files' sha256")
        extractor = {"files": dict(extractor["files"])}
    return Manifest(_sha(bytes(raw)), data["repo"], data["sha"], stamp, tuple(sorted(out)), extractor)


def read_manifest(path):
    """The manifest file's exact bytes (a regular file, not a link)."""
    path = str(path or "")
    if not path or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise SourceRefused("manifest_missing", f"{ENV_RELEASE_MANIFEST} must name the release's source manifest")
    folder, name = os.path.split(path)
    try:   # R1a.2: the manifest's folder is acquired from "/" by descriptor, the file opened relative to it
        dir_fd = _anchored_dir(folder, code="manifest_missing")
    except SourceRefused as exc:
        if exc.code == "symlink":
            raise SourceRefused("symlink", "a folder on the release source manifest's path is a link") from None
        raise SourceRefused(exc.code if exc.code == "unsupported_platform" else "manifest_missing",
                            "the release source manifest is missing or unreachable") from None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=dir_fd)
    except FileNotFoundError:
        raise SourceRefused("manifest_missing", "the release source manifest is missing") from None
    except OSError as exc:
        code = "symlink" if exc.errno == errno.ELOOP else "manifest_missing"
        raise SourceRefused(code, f"the release source manifest cannot be read ({exc.strerror})") from None
    finally:
        os.close(dir_fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise SourceRefused("manifest_invalid", "the release source manifest must be a regular file")
        chunks, left = [], MANIFEST_MAX + 1
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


# ---- the verified installed-source collector ------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Sources:
    manifest: Manifest
    files: dict          # path -> exact bytes (only manifest-listed regular files)
    diagnostics: dict    # counts of what was seen but not read (unlisted non-importable files, ignored caches)


# R1a.1 (stand-in P1-3, Code conformance 3): every read is confined by descriptors. The root is opened once and
# checked against the path that was verified; every folder below it is opened relative to its parent's descriptor
# with O_NOFOLLOW|O_DIRECTORY, and the file relative to its verified folder with O_NOFOLLOW. Nothing is resolved by
# full pathname after the root, so a parent or the root swapped for a link between a check and an open is never
# followed. Without the descriptor primitives the collector refuses (no path-based fallback).
_O_DIR = getattr(os, "O_DIRECTORY", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)


_DESCRIPTORS = bool(_O_DIR and _O_NOFOLLOW and os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
                    and os.stat in os.supports_follow_symlinks and os.listdir in os.supports_fd and hasattr(os, "fwalk"))


def _descriptor_support():
    return _DESCRIPTORS


def _anchored_dir(path, code="source_root"):
    """R1a.2 (stand-in R1a.1 P1): a folder acquired by walking EVERY component from "/" (the trusted anchor) with
    openat(O_DIRECTORY|O_NOFOLLOW): no full pathname is ever resolved, so no ancestor can be swapped for a link
    between a check and the open. A link at any component refuses. Returns the held descriptor."""
    if not _descriptor_support():
        raise SourceRefused("unsupported_platform", "this system cannot confine source reads by descriptor; refused")
    path = canonical_abs(path, code)
    fd = os.open("/", os.O_RDONLY | _O_DIR | _O_CLOEXEC)
    try:
        for part in [p for p in path.split("/") if p]:
            if part in (".", ".."):
                raise SourceRefused(code, "the path must be absolute and canonical")
            try:
                nxt = os.open(part, os.O_RDONLY | _O_DIR | _O_NOFOLLOW | _O_CLOEXEC, dir_fd=fd)
            except OSError as exc:
                if exc.errno == errno.ELOOP:   # Linux: O_NOFOLLOW on a link; it cannot arise from a real folder
                    raise SourceRefused("symlink", "a folder on the path is a link") from None
                if exc.errno == errno.ENOTDIR:   # macOS answers ENOTDIR for O_DIRECTORY|O_NOFOLLOW on a link
                    with contextlib.suppress(OSError):
                        if stat.S_ISLNK(os.stat(part, dir_fd=fd, follow_symlinks=False).st_mode):
                            raise SourceRefused("symlink", "a folder on the path is a link") from None
                    raise SourceRefused(code, "a folder on the path is not a folder") from None
                raise SourceRefused(code, f"a folder on the path cannot be opened ({exc.strerror})") from None
            os.close(fd)
            fd = nxt
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise SourceRefused(code, "not a folder")
        return fd
    except BaseException:
        os.close(fd)
        raise


def canonical_abs(path, code="source_root"):
    """The one canonical-path rule (Kimi R1a.2 P3-4: a single source): absolute, POSIX, no '.', '..', empty part or
    trailing slash. Anything else refuses with ``code``."""
    path = str(path or "")
    parts = path.split("/")
    if (not path or not path.startswith("/") or os.path.normpath(path) != path
            or (path != "/" and path.endswith("/")) or "//" in path or any(p in (".", "..") for p in parts[1:])):
        raise SourceRefused(code, "the path must be absolute and canonical")
    return path


def _open_root(root):
    """The release source root (or extractor package folder) as a held descriptor, acquired component by component
    from "/" with no link followed anywhere."""
    return _anchored_dir(root, "source_root")


def _importable(name):
    return name.lower().endswith(IMPORTABLE_SUFFIXES)


def _walk(root_fd, listed):
    """Every entry under the held root, by descriptor, never following links: a link anywhere refuses, an unlisted
    importable file refuses (a shadow), anything else unlisted is counted and never read. __pycache__ folders are
    interpreter caches of listed sources: ignored, counted, never read. (PEP 420 namespace folders are not a shadow
    here: the adapter executes verified bytes and never imports through a path.)"""
    unlisted, caches = 0, 0

    def unreadable(exc):
        raise SourceRefused("source_root", f"cannot list the release source ({exc.strerror})")

    for dirpath, dirnames, filenames, dirfd in os.fwalk(".", topdown=True, onerror=unreadable, follow_symlinks=False,
                                                        dir_fd=root_fd):
        rel_dir = "" if dirpath == "." else dirpath[2:].replace(os.sep, "/")
        for name in list(dirnames):
            rel = f"{rel_dir}/{name}" if rel_dir else name
            st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode):
                raise SourceRefused("symlink", "the release source contains a link", rel)
            if name == "__pycache__":
                dirnames.remove(name)
                caches += 1
        for name in filenames:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode):
                raise SourceRefused("symlink", "the release source contains a link", rel)
            if not stat.S_ISREG(st.st_mode):
                raise SourceRefused("unsupported_file", "the release source contains a non-regular file", rel)
            if rel in listed:
                continue
            if _importable(name):
                raise SourceRefused("shadow", "an unlisted importable file is in the release source", rel)
            unlisted += 1
    return {"unlisted_files_not_read": unlisted, "ignored_cache_folders": caches}


def _read_listed(root_fd, path, size, digest):
    """One listed file, opened component by component relative to the held root (no pathname resolution)."""
    parts = path.split("/")
    opened = []
    try:
        cur = root_fd
        for part in parts[:-1]:
            try:
                nxt = os.open(part, os.O_RDONLY | _O_DIR | _O_NOFOLLOW | _O_CLOEXEC, dir_fd=cur)
            except FileNotFoundError:
                raise SourceRefused("missing", "a listed file is missing", path) from None
            except OSError as exc:
                if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                    with contextlib.suppress(OSError):
                        if stat.S_ISLNK(os.stat(part, dir_fd=cur, follow_symlinks=False).st_mode):
                            raise SourceRefused("symlink", "a listed file's folder is a link", path) from None
                    raise SourceRefused("missing", "a listed file's folder is not a folder", path) from None
                raise SourceRefused("missing", f"a listed file's folder cannot be opened ({exc.strerror})", path) from None
            opened.append(nxt)
            cur = nxt
        try:
            fd = os.open(parts[-1], os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC | _O_NONBLOCK, dir_fd=cur)
        except FileNotFoundError:
            raise SourceRefused("missing", "a listed file is missing", path) from None
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SourceRefused("symlink", "a listed file is a link", path) from None
            raise SourceRefused("missing", f"a listed file cannot be read ({exc.strerror})", path) from None
    finally:
        for d in opened:
            os.close(d)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise SourceRefused("unsupported_file", "a listed path is not a regular file", path)
        if st.st_size > MAX_TOTAL:
            raise SourceRefused("oversize", "a listed file is larger than the census allows", path)
        chunks, left = [], size + 1   # never more than one byte past what the manifest says
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    if len(data) != size or _sha(data) != digest:
        raise SourceRefused("dirty", "a listed file does not match the release manifest", path)
    return data


def collect_sources(root, manifest: Manifest):
    """The verified installed source: only manifest-listed regular files, each exactly as the manifest says, read
    through descriptors anchored at the held root. Refuses; never repairs, deletes or invents a SHA."""
    root_fd = _open_root(root)
    try:
        listed = {p for p, _, _ in manifest.files}
        diagnostics = _walk(root_fd, listed)
        files, total = {}, 0
        for path, size, digest in manifest.files:
            data = _read_listed(root_fd, path, size, digest)
            total += len(data)
            if total > MAX_TOTAL:
                raise SourceRefused("oversize", f"the source census is larger than {MAX_TOTAL // 1048576} MiB", path)
            files[path] = data
    finally:
        os.close(root_fd)
    return Sources(manifest, files, diagnostics)


# ---- the extractor adapter (Code's fixed entry point) ---------------------------------------------------------------

class ExtractorAdapter:
    """``build_repository_map(sources, *, repo, sha, artifact_ref, generated_at=None) -> (envelope, receipt)``."""

    def __init__(self, build, identity="stub"):
        if not callable(build):
            raise TypeError("the extractor entry point must be callable")
        self._build, self.identity = build, identity

    def build(self, sources, *, repo, sha, artifact_ref, generated_at):
        return self._build(sources, repo=repo, sha=sha, artifact_ref=artifact_ref, generated_at=generated_at)


def load_pinned_extractor(package_dir, pins):
    """The J1 extractor dependency, hash-pinned: exactly the three package files, regular, unlinked, matching pins.
    The verified bytes themselves are compiled and run as an anonymous package (no sys.path entry, no file search for
    submodules, no cached bytecode), so what was checked is what runs."""
    if not isinstance(pins, dict) or set(pins) != set(EXTRACTOR_FILES):
        raise SourceRefused("extractor_unavailable", "the release names no pinned extractor package")
    root_fd = _open_root(str(package_dir or ""))
    try:
        present = {n for n in os.listdir(root_fd) if n != "__pycache__"}
        extra = sorted(n for n in present - set(EXTRACTOR_FILES))
        if extra:
            raise SourceRefused("extractor_unavailable", "the extractor package holds unexpected files", extra[0])
        code = {}
        for name in EXTRACTOR_FILES:
            st = os.stat(name, dir_fd=root_fd, follow_symlinks=False) if name in present else None
            if st is None:
                raise SourceRefused("extractor_unavailable", "an extractor package file is missing", name)
            if st.st_size > 4 * 1048576:
                raise SourceRefused("extractor_unavailable", "an extractor package file is too large", name)
            code[name] = _read_listed(root_fd, name, st.st_size, pins[name])
    finally:
        os.close(root_fd)
    package = "_hive_pinned_repomap_" + _sha(b"".join(pins[n].encode() for n in EXTRACTOR_FILES))[:16]
    modules = {}
    try:
        for name, mod in (("__init__.py", package), ("repository_facts.py", f"{package}.repository_facts"),
                          ("repository_map.py", f"{package}.repository_map")):
            module = types.ModuleType(mod)
            module.__file__ = f"<pinned {pins[name][:12]}>/{name}"
            module.__package__ = package
            if mod == package:
                module.__path__ = []   # a package for relative imports, with no folder to search
            sys.modules[mod] = module
            modules[mod] = module
            exec(compile(code[name], module.__file__, "exec"), module.__dict__)
    except Exception as exc:
        for mod in modules:
            sys.modules.pop(mod, None)
        raise SourceRefused("extractor_unavailable", f"the pinned extractor failed to load ({type(exc).__name__})") from None
    build = getattr(modules[f"{package}.repository_map"], "build_repository_map", None)
    return ExtractorAdapter(build, identity=package)


# ---- finalisation: address the receipt, then freeze the envelope -----------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Prepared:
    repo: str
    sha: str
    manifest_sha256: str
    receipt_bytes: bytes
    receipt_sha256: str
    envelope_bytes: bytes
    envelope_sha256: str
    map_digest: str
    state: str
    counts: dict


def verify_pair(envelope, receipt, sources: Sources | None = None):
    """The frozen envelope and its receipt agree: receipt digest, content-without-receipt digest, census digest, custody
    reference, and (with sources) the census is exactly the verified bytes. Raises SourceRefused('receipt_mismatch')."""
    def bad(why):
        raise SourceRefused("receipt_mismatch", why)
    if not isinstance(envelope, dict) or not isinstance(receipt, dict):
        bad("the envelope and receipt are JSON objects")
    if envelope.get("schema") != "repo-map/1" or receipt.get("schema") != "repo-map-extraction-receipt/1":
        bad("unexpected envelope or receipt schema")
    for key in ("repo", "sha", "snapshot_digest"):
        if envelope.get(key) != receipt.get(key):
            bad(f"the envelope and receipt disagree on {key}")
    head = envelope.get("receipt")
    if not isinstance(head, dict) or set(head) != {"digest", "artifact_ref"}:
        bad("the envelope's receipt field is exactly {digest, artifact_ref}")
    if head["digest"] != canonical_digest(receipt):
        bad("the receipt digest does not match the receipt")
    if head["artifact_ref"] != asset_ref(_sha(_canon_bytes(receipt))):
        bad("the receipt reference is not the receipt's own asset")
    content = {k: v for k, v in envelope.items() if k != "receipt"}
    if receipt.get("envelope_content_digest") != canonical_digest(content):
        bad("the envelope content digest does not match")
    census = receipt.get("census")
    if canonical_digest(census) != receipt["snapshot_digest"]:
        bad("the census digest does not match")
    if sources is not None:
        expected = [{"path": p, "size": len(b), "digest": "sha256:" + _sha(b)} for p, b in sorted(sources.files.items())]
        if census != expected:
            bad("the census is not the verified installed source")
        if envelope["repo"] != sources.manifest.repo or envelope["sha"] != sources.manifest.sha:
            bad("the envelope is not the installed repo and SHA")
        if envelope.get("generated_at") != sources.manifest.generated_at:
            bad("generated_at is not the release's recorded generation input")


def prepare_map(sources: Sources, adapter: ExtractorAdapter):
    """Extract (pure, no model, no network), address the receipt, freeze the final envelope, validate it with the
    loader's own rules and limits. The temporary reference never leaves this function."""
    from . import repomap
    m = sources.manifest
    try:
        envelope, receipt = adapter.build(dict(sources.files), repo=m.repo, sha=m.sha, artifact_ref=PENDING_REF,
                                          generated_at=m.generated_at)
    except SourceRefused:
        raise
    except Exception as exc:
        raise SourceRefused("extraction_failed", f"the extractor refused this source ({type(exc).__name__})") from None
    if not isinstance(envelope, dict) or not isinstance(receipt, dict) or not isinstance(envelope.get("receipt"), dict):
        raise SourceRefused("extraction_failed", "the extractor returned no envelope and receipt")
    receipt_bytes = _canon_bytes(receipt)
    receipt_sha = _sha(receipt_bytes)
    final = copy.deepcopy(envelope)
    final["receipt"] = {"digest": envelope["receipt"].get("digest"), "artifact_ref": asset_ref(receipt_sha)}
    verify_pair(final, receipt, sources)
    try:
        counts = repomap.validate(final)
    except repomap._TooLarge as exc:
        raise SourceRefused("too_large", str(exc)[:300]) from None
    except repomap._Invalid as exc:
        raise SourceRefused("envelope_invalid", str(exc)[:300]) from None
    if counts is None:
        raise SourceRefused("envelope_invalid", "not a repo-map/1 envelope")
    if counts["nodes"] > repomap.MAX_NODES or counts["edges"] > repomap.MAX_EDGES:
        raise SourceRefused("too_large", "the map is larger than the loader's node or edge limit")
    envelope_bytes = _canon_bytes(final)
    if len(envelope_bytes) > repomap.MAX_BODY:
        raise SourceRefused("too_large", "the envelope is larger than the loader's body limit")
    envelope_sha = _sha(envelope_bytes)
    if repomap.digest_of(final) != "sha256:" + envelope_sha:
        raise SourceRefused("envelope_invalid", "the envelope's canonical bytes do not give its loader digest")
    return Prepared(m.repo, m.sha, m.sha256, receipt_bytes, receipt_sha, envelope_bytes, envelope_sha,
                    "sha256:" + envelope_sha, final["state"], counts)


# ---- the required-feature marker ------------------------------------------------------------------------------------

def _fsync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _marker_record(installation, manifest: Manifest, created_at):
    return {"schema": MARKER_SCHEMA, "features": list(FEATURES), "installation": installation, "created_at": created_at,
            "release": {"repo": manifest.repo, "sha": manifest.sha, "manifest_sha256": manifest.sha256}}


def init_data_dir(path, manifest_path, installation=None):
    """The J1 launcher's one explicit step for a NEW installation: a fresh folder (absent, or empty and this account's
    0700) gets the marker file and its database row. Built in a staging sibling and renamed into place, so a crash
    leaves either nothing at ``path`` or a complete marker. Never adopts a folder that holds anything."""
    path = pathlib.Path(path)
    if not path.is_absolute():
        raise LocalOwnerRefused("choose the new installation's data folder by its absolute path")
    manifest = parse_manifest(read_manifest(manifest_path))
    if os.path.lexists(path):
        st = os.lstat(path)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise LocalOwnerRefused(f"{path} is not this account's own private folder")
        if os.listdir(path):
            raise LocalOwnerRefused(f"{path} already holds data; a new installation starts only in a fresh folder")
    installation = installation or "inst_" + secrets.token_hex(16)
    if not re.fullmatch(r"inst_[0-9a-f]{32}", installation):
        raise LocalOwnerRefused("an installation id is inst_ and 32 hex characters")
    created = datetime.now(timezone.utc).isoformat()
    record = _marker_record(installation, manifest, created)
    raw = _canon_bytes(record)
    stage = path.parent / f".{path.name}.init-{secrets.token_hex(6)}"
    os.mkdir(stage, 0o700)
    try:
        fd = os.open(stage / MARKER_NAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        conn = sqlite3.connect(str(stage / "hive.db"), isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            conn.executescript(SCHEMA)
            conn.execute("BEGIN IMMEDIATE")
            for feature in FEATURES:
                conn.execute("INSERT INTO required_features VALUES (?,?,?,?)", (feature, installation, _sha(raw), created))
            conn.commit()
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
        _fsync_dir(stage)
        if os.path.lexists(path):
            os.rmdir(path)   # only ever an empty folder (checked above); rmdir refuses anything else
        os.rename(stage, path)
        _fsync_dir(path.parent)
    except BaseException:
        if os.path.lexists(stage):
            for name in os.listdir(stage):   # only the files this function itself just created in its own staging folder
                with contextlib.suppress(OSError):
                    os.unlink(stage / name)
            with contextlib.suppress(OSError):
                os.rmdir(stage)
        raise
    return record


@dataclasses.dataclass(frozen=True)
class Marker:
    installation: str
    features: tuple
    marker_sha256: str
    release: dict
    created_at: str


def _feature_rows(db_path):
    if not os.path.lexists(db_path):
        return []
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'required_features'").fetchone() is None:
            return []
        return [dict(r) for r in conn.execute("SELECT * FROM required_features ORDER BY feature")]
    finally:
        conn.close()


def _read_marker(marker_path):
    try:
        fd = os.open(marker_path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        raise LocalOwnerRefused(f"the installation marker cannot be read ({exc.strerror}); start refused") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise LocalOwnerRefused("the installation marker is not a regular file; start refused")
        raw = os.read(fd, MARKER_MAX + 1)
    finally:
        os.close(fd)
    try:
        record = json.loads(raw) if len(raw) <= MARKER_MAX else None
    except ValueError:
        record = None
    if (not isinstance(record, dict) or record.get("schema") != MARKER_SCHEMA or not isinstance(record.get("features"), list)
            or not isinstance(record.get("installation"), str) or not isinstance(record.get("release"), dict)
            or raw != _canon_bytes(record)):
        raise LocalOwnerRefused("the installation marker is damaged; start refused (the data is left as it is)")
    return raw, record


def check_startup(data_dir, environ=None):
    """Before anything opens the data folder for real. None: no marker and none asserted (today's hives, inert).
    A Marker: the folder is a new installation, and it matches. Otherwise LocalOwnerRefused, with no change."""
    environ = os.environ if environ is None else environ
    data_dir = pathlib.Path(data_dir)
    marker_path = data_dir / MARKER_NAME
    has_file = os.path.lexists(marker_path)
    rows = _feature_rows(data_dir / "hive.db")
    asserted = [f.strip() for f in environ.get(ENV_REQUIRED, "").split(",") if f.strip()]
    if not has_file and not rows:
        if asserted:
            raise LocalOwnerRefused("this data folder was not set up as a new OmegaHive installation; choose a fresh folder "
                                    "for it (an existing folder is never taken over)")
        return None
    if not has_file or not rows:
        raise LocalOwnerRefused("this data folder's installation marker and its database disagree; start refused "
                                "(nothing was changed)")
    raw, record = _read_marker(marker_path)
    marker_sha = _sha(raw)
    features = tuple(record["features"])
    if (sorted(r["feature"] for r in rows) != sorted(features) or any(r["installation"] != record["installation"] for r in rows)
            or any(r["marker_sha256"] != marker_sha for r in rows)):
        raise LocalOwnerRefused("this data folder's installation marker and its database disagree; start refused "
                                "(nothing was changed)")
    unknown = [f for f in features if f not in FEATURES]
    if unknown:   # a newer release's required feature: this binary cannot honour it (J1f: no silent downgrade)
        raise LocalOwnerRefused(f"this data folder requires {', '.join(unknown)}, which this release does not know; "
                                "start a compatible release")
    missing = [f for f in asserted if f not in features]
    if missing:
        raise LocalOwnerRefused(f"this data folder was not set up with {', '.join(missing)}; start refused")
    if environ.get("HIVE_LOCAL_OWNER", "").strip() != "1":
        raise LocalOwnerRefused("this data folder belongs to a local OmegaHive installation; start it with the OmegaHive app "
                                "(the installation's requirements cannot be switched off)")
    expected = environ.get(ENV_INSTALLATION, "").strip()
    if expected and expected != record["installation"]:
        raise LocalOwnerRefused("this data folder is a different OmegaHive installation; start refused")
    return Marker(record["installation"], features, marker_sha, dict(record["release"]), record.get("created_at", ""))


# ---- the running new hive: binding, helper sessions, completion, barrier --------------------------------------------

class NewHive:
    def __init__(self, settings, hive, local, marker: Marker, environ=None, extractor=None):
        environ = os.environ if environ is None else environ
        self.settings, self.hive, self.local, self.marker = settings, hive, local, marker
        self.db = hive.db
        self.started_at = time.time()
        self.code_ready_at = None
        self._extractor_override = extractor
        self._prepared = {}
        self._prep_lock = threading.Lock()
        self._held, self._held_lock = set(), threading.Lock()
        self.last_error = None
        with self.db._lock:
            self.db._conn.executescript(SCHEMA)
        self.manifest_path = environ.get(ENV_RELEASE_MANIFEST, "")
        self.source_root = environ.get(ENV_RELEASE_SOURCE, "")
        self.extractor_dir = environ.get(ENV_EXTRACTOR, "")
        self.binding, self.hold = None, None
        try:
            manifest = parse_manifest(read_manifest(self.manifest_path))
            self.binding = manifest
            stamp = time.time()
            self.db.execute("INSERT INTO newhive_bindings (manifest_sha256, repo, sha, first_seen_at, last_seen_at) "
                            "VALUES (?,?,?,?,?) ON CONFLICT(manifest_sha256) DO UPDATE SET last_seen_at = excluded.last_seen_at",
                            (manifest.sha256, manifest.repo, manifest.sha, stamp, stamp))
        except SourceRefused as exc:
            self.hold = exc.view()   # a recovery hold with its reason: the hive still starts, coding stays unavailable
            log.warning("new hive: installed source binding held (%s)", exc.code)
        self.runtime = runtime_identity()
        self._native = {}
        self._verified = None            # the manifest sha whose installed bytes this process verified, digests matching
        self._verifying = threading.Event()
        self.db.execute("INSERT OR IGNORE INTO newhive_timings (instance, started_at) VALUES (?, ?)",
                        (local.instance, self.started_at))
        self.sweep(startup=True)
        comp = self.completion()
        if comp is not None and self.hold is None:
            # R1a.1 (stand-in P1-1, Code conformance 1): a committed completion is historical; before any remount or
            # readiness this process re-reads the actual installed census (bytes, sizes, shadows, links) and re-derives
            # the exact digests with this runtime. Off the event loop: the person's Ask is not delayed.
            self._verifying.set()
            threading.Thread(target=self._restart_verify, args=(dict(comp),), name="newhive-verify", daemon=True).start()

    def _restart_verify(self, comp):
        try:
            if comp["runtime"] != self.runtime:
                raise SourceRefused("runtime_changed", f"the extractor runtime changed ({comp['runtime']} -> {self.runtime}); "
                                    "coding stays held until a compatible runtime or a reviewed migration")
            prepared = self.prepare(fresh=True)   # verified_sources(): the full census, read by descriptor, now
            if (prepared.map_digest, prepared.receipt_sha256, prepared.envelope_sha256) != \
                    (comp["map_digest"], comp["receipt_sha256"], comp["envelope_sha256"]):
                raise SourceRefused("extractor_changed", "the installed source no longer derives the committed map; kept as it is")
            self._verified = comp["manifest_sha256"]
            with contextlib.suppress(Exception):   # a clean replay remounts the retained exact map
                self.hive.repo_maps.space(comp["repo"], comp["sha"], on_demand=True)
        except SourceRefused as exc:
            self.hold = dict(exc.view(), stage="restart")   # completion and work are kept; coding and restore stay held
            log.warning("new hive: restart source check held coding (%s)", exc.code)
        except Exception as exc:
            self.hold = {"code": "verify_failed", "message": f"the restart source check failed ({type(exc).__name__})",
                         "stage": "restart"}
        finally:
            self._verifying.clear()

    def wait_verified(self, timeout=None):
        """Tests and the status view: wait for the restart source check to finish."""
        end = None if timeout is None else time.time() + timeout
        while self._verifying.is_set() and (end is None or time.time() < end):
            time.sleep(0.02)
        return not self._verifying.is_set()

    def retained_revisions(self, repo):
        """R1a.1 (stand-in P1-2, Code conformance 2): the revisions retention must keep for this installation, from the
        host's own installed-release binding: the current installed SHA, every committed completion (rollback targets)
        and any live attempt's SHA. A host-side guard; the bearer's exact load stays visibility=hive, pinned=false."""
        shas = {r["sha"] for r in self.db.all("SELECT sha FROM local_bootstrap_completions WHERE repo = ?", (repo,))}
        shas |= {r["sha"] for r in self.db.all("SELECT sha FROM local_bootstrap_sessions WHERE repo = ? AND retired_at IS NULL",
                                               (repo,))}
        if self.binding is not None and self.binding.repo == repo:
            shas.add(self.binding.sha)
        return shas

    # binding and readiness -------------------------------------------------------------------------------------------

    def completion(self):
        if self.binding is None:
            return None
        return self.db.one("SELECT * FROM local_bootstrap_completions WHERE manifest_sha256 = ?", (self.binding.sha256,))

    def coding_ready(self, refresh=False):
        """True only when this installed binding's bootstrap is committed AND its exact map is loaded AND fully mounted.
        r1-int (stand-in R1b P1): request paths pass refresh=False and never touch the interpreter; only the watch loop
        (in a worker thread) refreshes the native count. A missing or too-old native answer reads as not ready."""
        comp = self.completion()
        if comp is None or self.hold is not None or self._verified != comp["manifest_sha256"] \
                or not self._manifest_unchanged():
            return False
        row = self.db.one("SELECT digest FROM repo_maps WHERE repo = ? AND sha = ?", (comp["repo"], comp["sha"]))
        if row is None or row["digest"] != comp["map_digest"]:
            return False
        ready = (self.hive.repo_maps.space(comp["repo"], comp["sha"])["status"] == "mounted"
                 and self._native_mounted(comp["repo"], comp["sha"], refresh=refresh))
        if ready and self.code_ready_at is None:
            self.code_ready_at = time.time()
            self.note("code_ready_at", self.code_ready_at)
        return ready

    def _manifest_unchanged(self):
        """Readiness is bound to the exact installed manifest (r1.2.1 qualification: a version-N readiness never admits
        version N+1). Kimi R1a.2 P3-1: re-hashed on every readiness check (a bounded read through the anchored
        descriptor walk), never a stat-identity shortcut. The listed bytes are re-verified at begin/complete/restart."""
        if self.binding is None:
            return False
        try:
            return _sha(read_manifest(self.manifest_path)) == self.binding.sha256
        except SourceRefused:
            return False

    def _native_mounted(self, repo, sha, refresh=False):
        """Kimi R1a P2-1: readiness asks the native space itself, not only the cached projection: the space must hold
        exactly the revision's stored atom count. Throttled to one native count per NATIVE_TTL seconds; while another
        repo operation holds the interpreter's repo lock, the last fresh answer stands for at most NATIVE_STALE_MAX.
        A disagreement marks the projection failed, so Resume can remount the retained exact map."""
        key, at = (repo, sha), time.monotonic()
        last = self._native.get(key)
        if last is not None and at - last[0] < NATIVE_TTL:
            return last[1]
        if not refresh:   # never block a caller on the interpreter; fail closed once the last answer is too old
            return bool(last is not None and last[1] and at - last[0] < NATIVE_STALE_MAX)
        spaces = self.hive.spaces
        if not spaces.repo_lock.acquire(timeout=1.0):
            return bool(last is not None and last[1] and at - last[0] < NATIVE_STALE_MAX)
        try:
            expected = self.db.one("SELECT COUNT(*) AS n FROM repo_map_atoms WHERE repo = ? AND sha = ?", (repo, sha))["n"]
            try:
                held = spaces._repo_count(spaces.repo_space(repo, sha)[1])
            except Exception:
                held = None
        finally:
            spaces.repo_lock.release()
        ok = held is not None and held == expected and expected > 0
        self._native[key] = (time.monotonic(), ok)
        if not ok:
            maps = self.hive.repo_maps
            with maps._space_lock:
                if (maps._spaces.get(key) or {}).get("status") == "mounted":
                    maps._spaces[key] = {"status": "failed", "atoms": 0,
                                         "reason": "native check: the space no longer holds every atom"}
            log.warning("new hive: native check found %s@%s not fully mounted (%s of %s atoms)", repo, sha, held, expected)
        return ok

    def note(self, what, at=None):
        """R1b-2 timing (r1.2.1 §4): first person sign-in, first accepted Ask turn and code-ready, measured per process
        instance from its start; the first value of each is kept. code-ready also records this process's peak RSS."""
        if what not in ("first_signin_at", "first_ask_at", "code_ready_at"):
            return
        at = at or time.time()
        extra, params = "", [at]
        if what == "code_ready_at":
            with contextlib.suppress(Exception):
                import resource
                peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                extra, params = ", code_ready_rss_kb = ?", [at, int(peak // 1024 if sys.platform == "darwin" else peak)]
        with contextlib.suppress(Exception):
            self.db.execute(f"UPDATE newhive_timings SET {what} = ?{extra} WHERE instance = ? AND {what} IS NULL",
                            (*params, self.local.instance))

    def timing(self):
        row = self.db.one("SELECT * FROM newhive_timings WHERE instance = ?", (self.local.instance,)) or {}
        start = row.get("started_at") or self.started_at
        out = {"started_at": start}
        for key in ("first_signin_at", "first_ask_at", "code_ready_at"):
            out[key] = row.get(key)
            out[key.replace("_at", "_seconds")] = None if row.get(key) is None else round(row[key] - start, 3)
        out["code_ready_rss_kb"] = row.get("code_ready_rss_kb")
        return out

    def require_coding(self, operation):
        """r1.2.1 §A: a code-bound / map-dependent / not-proven-ordinary effect boundary, rechecked at each boundary."""
        if not self.coding_ready():
            raise self.hive.error(409, "coding_not_ready", COPY["not_ready"], {"operation": operation,
                                                                               "setup": self.public_status()})

    def hold_mind(self, agent_id):
        with self._held_lock:
            self._held.add(agent_id)

    def held(self):
        with self._held_lock:
            return sorted(self._held)

    async def release(self):
        """After the completion commit (or a restart's replayed readiness and remount): restore the held minds through
        the ordinary lifecycle, which rechecks the barrier at that boundary."""
        if not await asyncio.to_thread(self.coding_ready, True):
            return []
        started = []
        for agent_id in self.held():
            try:
                self.hive.lifecycle(agent_id, "start", expect=lambda fresh: fresh["desired"] == "awake")
                started.append(agent_id)
            except Exception as exc:
                log.warning("new hive: held mind %s did not start after readiness: %s", agent_id, exc)
            with self._held_lock:
                self._held.discard(agent_id)
            await asyncio.sleep(0)
        return started

    async def watch(self, every=1.0):
        """The lifespan's quiet loop: expiry sweep, and releasing held minds once ready. Never blocks the event loop."""
        tick = 0
        while True:
            await asyncio.sleep(every)
            tick += 1
            try:
                if tick % 5 == 0:
                    await asyncio.to_thread(self.sweep)
                # r1-int: the only place the native count is refreshed, off the event loop
                ready = await asyncio.to_thread(self.coding_ready, True)
                if self.held() and ready:
                    await self.release()
            except Exception as exc:
                log.warning("new hive: watch pass failed (%s)", type(exc).__name__)

    # preparation -----------------------------------------------------------------------------------------------------

    def _adapter(self):
        if self._extractor_override is not None:
            return self._extractor_override
        pins = (self.binding.extractor or {}).get("files") if self.binding else None
        return load_pinned_extractor(self.extractor_dir, pins)

    def verified_sources(self):
        if self.hold is not None or self.binding is None:
            raise SourceRefused(self.hold["code"] if self.hold else "manifest_missing",
                                self.hold["message"] if self.hold else "no installed binding")
        raw = read_manifest(self.manifest_path)
        if _sha(raw) != self.binding.sha256:
            raise SourceRefused("manifest_changed", "the release source manifest changed after this hive started")
        return collect_sources(self.source_root, self.binding)

    def prepare(self, fresh=False):
        """The host's own, independent preparation of the exact expected envelope/receipt for the installed binding.
        fresh=True (restart verification, completion): never served from the cache; the census is read again now."""
        with self._prep_lock:
            cached = None if fresh else self._prepared.get(self.binding.sha256 if self.binding else None)
            if cached is not None:
                return cached
            prepared = prepare_map(self.verified_sources(), self._adapter())
            self._prepared[prepared.manifest_sha256] = prepared
            return prepared

    # helper attempts -------------------------------------------------------------------------------------------------

    def _retire(self, meta, reason, at=None):
        """Exact: this attempt's own helper session row (kind sso-bootstrap) and its metadata. Never any other session."""
        at = at or time.time()
        if meta.get("token_hash"):
            self.db.execute("DELETE FROM sessions WHERE token_hash = ? AND kind = ?", (meta["token_hash"], BOOTSTRAP_KIND))
        self.db.execute("UPDATE local_bootstrap_sessions SET retired_at = ?, retired_reason = ? WHERE attempt = ? "
                        "AND retired_at IS NULL", (at, reason, meta["attempt"]))
        self.db.execute("DELETE FROM local_bootstrap_codes WHERE attempt = ?", (meta["attempt"],))

    def sweep(self, startup=False):
        """Expiry and stale-instance cleanup; at startup every prior helper session. Normal browser sso rows are never
        touched: every DELETE names kind sso-bootstrap and an exact token hash, or kind sso-bootstrap alone at startup."""
        at = time.time()
        with self.db.transaction():
            rows = self.db.all("SELECT * FROM local_bootstrap_sessions WHERE retired_at IS NULL")
            for meta in rows:
                if startup:
                    self._retire(meta, "startup", at)
                elif meta["instance"] != self.local.instance:
                    self._retire(meta, "stale_instance", at)
                elif meta["deadline"] <= at:
                    self._retire(meta, "expired", at)
            if startup:
                self.db.execute("DELETE FROM sessions WHERE kind = ?", (BOOTSTRAP_KIND,))
            self.db.execute("DELETE FROM local_bootstrap_codes WHERE expires_at <= ? OR used = 1 OR instance != ?",
                            (at, self.local.instance))

    def _assets_present(self, *digests):
        """Each retained asset is recorded AND readable with its own digest (a row alone is not custody)."""
        for digest in digests:
            if self.db.one("SELECT 1 FROM assets WHERE sha256 = ?", (digest,)) is None:
                return False
            try:
                self.hive.assets.read(digest)
            except Exception:
                return False
        return True

    def begin(self):
        """Control op bootstrap-begin (same-uid only): a fresh bounded attempt for the installed binding, or the committed
        completion. Abandoned attempts are retired first (Resume setup). Returns a one-use 60 s sign-in code with a
        bootstrap purpose; the bearer itself is minted only at the exchange and only into the launcher's memory."""
        if self.hold is not None:
            return {"ok": False, "error": "setup_held", "stage": self.hold.get("stage", "source"), "reason": self.hold}
        if self._verifying.is_set():
            return {"ok": False, "error": "setup_busy", "stage": "verifying"}
        comp = self.completion()
        # R1a.1 (stand-in P1-2): historically completed is not currently ready. Only a ready installation answers
        # completed; a completed one whose map is gone, failed or unmounted gets a recovery attempt for the SAME
        # committed digests (byte-identical artifacts), and its historical completion is never rewritten.
        if comp is not None and self.coding_ready(True):   # control-socket op: already off the event loop
            return {"ok": True, "completed": True, "receipt": self._receipt(comp)}
        if self.local.principal is None:
            return {"ok": False, "error": "no_owner"}
        try:
            prepared = self.prepare()
        except SourceRefused as exc:
            self.last_error = _begin_error("source", exc.code)
            return {"ok": False, "error": "setup_held", "stage": "source", "reason": exc.view()}
        if comp is not None and (prepared.map_digest, prepared.receipt_sha256, prepared.envelope_sha256) != \
                (comp["map_digest"], comp["receipt_sha256"], comp["envelope_sha256"]):
            reason = {"code": "extractor_changed", "message": "the installed source no longer derives the committed map"}
            self.last_error = _begin_error("source", reason["code"])
            return {"ok": False, "error": "setup_held", "stage": "source", "reason": reason}
        row = self.db.one("SELECT digest FROM repo_maps WHERE repo = ? AND sha = ?", (prepared.repo, prepared.sha))
        if row is not None and row["digest"] != prepared.map_digest:
            # r1.1 §3: never regenerate over a loaded revision; a different digest is a reviewed-migration conflict
            reason = {"code": "map_conflict", "message": "this SHA is already loaded with a different map; kept as it is"}
            self.last_error = _begin_error("map", reason["code"])
            return {"ok": False, "error": "setup_held", "stage": "map", "reason": reason}
        if row is not None and not self._assets_present(prepared.receipt_sha256, prepared.envelope_sha256):
            reason = {"code": "retained_artifact_missing",
                      "message": "the loaded map's retained receipt or envelope is missing; kept as it is"}
            self.last_error = _begin_error("assets", reason["code"])
            return {"ok": False, "error": "setup_held", "stage": "assets", "reason": reason}
        attempt = "bsa_" + secrets.token_hex(12)
        code = secrets.token_urlsafe(32)
        at = time.time()
        with self.db.transaction():
            for meta in self.db.all("SELECT * FROM local_bootstrap_sessions WHERE retired_at IS NULL"):
                self._retire(meta, "replaced", at)
            self.db.insert("local_bootstrap_sessions", {
                "attempt": attempt, "token_hash": None, "installation": self.marker.installation,
                "instance": self.local.instance, "principal": self.local.principal,
                "manifest_sha256": prepared.manifest_sha256, "repo": prepared.repo, "sha": prepared.sha,
                "map_digest": prepared.map_digest, "receipt_sha256": prepared.receipt_sha256,
                "envelope_sha256": prepared.envelope_sha256, "runtime": self.runtime, "created_at": at,
                "deadline": at + BOOTSTRAP_SECONDS, "exchanged_at": None, "retired_at": None, "retired_reason": None})
            self.db.insert("local_bootstrap_codes", {"code_hash": _sha(code.encode()), "attempt": attempt,
                                                     "instance": self.local.instance, "created_at": at,
                                                     "expires_at": at + CODE_SECONDS, "used": 0})
        self.last_error = None
        return {"ok": True, "completed": False, "recovery": comp is not None, "attempt": attempt, "code": code,
                "expires_in": CODE_SECONDS, "deadline": at + BOOTSTRAP_SECONDS, "repo": prepared.repo, "sha": prepared.sha,
                "map_digest": prepared.map_digest, "receipt_sha256": prepared.receipt_sha256,
                "envelope_sha256": prepared.envelope_sha256, "runtime": self.runtime}

    def exchange(self, code):
        """A bootstrap-purpose code -> the attempt's sso-bootstrap bearer (None: not a bootstrap code, or refused)."""
        from .hive import token_hash
        if not isinstance(code, str) or not CODE_RE.fullmatch(code):
            return None
        at = time.time()
        with self.db.transaction():
            row = self.db.one("SELECT * FROM local_bootstrap_codes WHERE code_hash = ?", (_sha(code.encode()),))
            if row is None:
                return None
            used = self.db.execute("UPDATE local_bootstrap_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND "
                                   "instance = ? AND expires_at > ?", (row["code_hash"], self.local.instance, at)).rowcount
            if used != 1:
                return {"refused": True}
            meta = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE attempt = ?", (row["attempt"],))
            if (meta is None or meta["retired_at"] is not None or meta["token_hash"] is not None
                    or meta["instance"] != self.local.instance or meta["deadline"] <= at
                    or meta["principal"] != self.local.principal):
                return {"refused": True}
            person = self.db.one("SELECT * FROM people WHERE id = ?", (meta["principal"][5:],))
            if person is None or person["disabled"] or person["role"] != "admin":
                return {"refused": True}
            token = secrets.token_urlsafe(32)
            expires = min(meta["deadline"], at + BOOTSTRAP_SECONDS)
            self.db.insert("sessions", {"token_hash": token_hash(token), "created_at": datetime.now(timezone.utc).isoformat(),
                                        "kind": BOOTSTRAP_KIND, "principal": meta["principal"], "expires_at": expires})
            self.db.execute("UPDATE local_bootstrap_sessions SET token_hash = ?, exchanged_at = ? WHERE attempt = ? "
                            "AND token_hash IS NULL", (token_hash(token), at, meta["attempt"]))
        return {"token": token, "expires_at": expires, "kind": BOOTSTRAP_KIND, "attempt": meta["attempt"]}

    # the auth boundary -----------------------------------------------------------------------------------------------

    def admit(self, row, request, token_from_header):
        """r1.1 §3: a sso-bootstrap session reaches only the four allow-listed routes, with exact path/query values,
        from loopback, as a header bearer, inside its attempt's deadline and this process instance. Raises 403 otherwise."""
        def refuse(why):
            raise self.hive.error(403, "bootstrap_session_restricted", f"this setup session cannot do that ({why})")
        if request.scope.get("hive_public"):
            refuse("not from this computer")
        if not token_from_header:
            refuse("header bearer only")
        route = request.scope.get("route")
        template = getattr(route, "path", None)
        method = request.method.upper()
        if (method, template) not in BOOTSTRAP_ROUTES:
            refuse("route not allowed")
        at = time.time()
        if row.get("expires_at") is None or row["expires_at"] <= at:
            refuse("expired")
        meta = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE token_hash = ?", (row["token_hash"],))
        if (meta is None or meta["retired_at"] is not None or meta["instance"] != self.local.instance
                or meta["deadline"] <= at or meta["principal"] != row.get("principal")
                or self.binding is None or meta["manifest_sha256"] != self.binding.sha256):
            refuse("attempt not current")
        params, query = request.path_params, request.query_params
        keys = set(query.keys())
        if template == "/api/assets/{sha}":
            if keys or params.get("sha") not in (meta["receipt_sha256"], meta["envelope_sha256"]):
                refuse("not this attempt's asset")
        elif template == "/api/repo-maps/{repo}/{sha}":
            if keys or params.get("repo") != meta["repo"] or params.get("sha") != meta["sha"]:
                refuse("not this attempt's map")
        elif template == "/api/assets":
            if (keys - {"name", "local_only", "store"} or query.get("store", "local") != "local"
                    or query.get("local_only") not in ("true", "1")):
                refuse("local code-only asset upload only")
        elif template == "/api/admin/repo-maps":
            if keys - {"visibility", "pinned"} or query.get("visibility") != "hive" or query.get("pinned") not in ("false", "0"):
                refuse("visibility=hive&pinned=false only")
        return dict(row, bootstrap_attempt=meta["attempt"])

    def _meta_for(self, session):
        meta = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE attempt = ? AND token_hash = ? AND retired_at IS NULL",
                           (session.get("bootstrap_attempt"), session.get("token_hash")))
        if meta is None:
            raise self.hive.error(403, "bootstrap_session_restricted", "this setup session is no longer current")
        return meta

    def check_upload(self, session, data, content_type):
        meta = self._meta_for(session)
        ctype = str(content_type or "").split(";")[0].strip().lower()
        if ctype != "application/json" or _sha(bytes(data)) not in (meta["receipt_sha256"], meta["envelope_sha256"]):
            raise self.hive.error(403, "bootstrap_session_restricted", "only this attempt's exact receipt and envelope")

    def check_load(self, session, envelope):
        from .repomap import digest_of
        meta = self._meta_for(session)
        if (not isinstance(envelope, dict) or envelope.get("repo") != meta["repo"] or envelope.get("sha") != meta["sha"]
                or digest_of(envelope) != meta["map_digest"]):
            raise self.hive.error(403, "bootstrap_session_restricted", "only this attempt's exact installed map")

    # completion ------------------------------------------------------------------------------------------------------

    def _receipt(self, comp):
        return {k: comp[k] for k in ("attempt", "repo", "sha", "map_digest", "receipt_sha256", "envelope_sha256",
                                     "manifest_sha256", "completed_at")}

    def _verify_installed(self, meta):
        """Outside any lock: the host's own checks, never the caller's claims."""
        if self.hold is not None or self.binding is None or meta["manifest_sha256"] != self.binding.sha256:
            return "binding_changed"
        if set(self.marker.features) != set(FEATURES):
            return "feature_mismatch"
        try:
            prepared = self.prepare(fresh=True)   # the installed bytes, read again now (never the cache)
        except SourceRefused as exc:
            return exc.code
        if (prepared.map_digest, prepared.receipt_sha256, prepared.envelope_sha256) != \
                (meta["map_digest"], meta["receipt_sha256"], meta["envelope_sha256"]):
            return "binding_changed"
        row = self.db.one("SELECT * FROM repo_maps WHERE repo = ? AND sha = ?", (meta["repo"], meta["sha"]))
        if row is None:
            return "map_not_loaded"
        if row["digest"] != meta["map_digest"]:
            return "map_conflict"
        if row["visibility"] != "hive" or row["pinned"]:
            return "map_conflict"
        space = self.hive.repo_maps.space(meta["repo"], meta["sha"])
        if space["status"] != "mounted":
            return f"map_{space['status']}"   # queued / mounting / failed / incomplete / unmounted: never ready
        try:
            _, receipt_bytes = self.hive.assets.read(meta["receipt_sha256"])
            _, envelope_bytes = self.hive.assets.read(meta["envelope_sha256"])
        except Exception:
            return "assets_missing"
        try:
            envelope, receipt = json.loads(envelope_bytes), json.loads(receipt_bytes)
            verify_pair(envelope, receipt)
        except (ValueError, SourceRefused):
            return "receipt_mismatch"
        if canonical_digest(envelope) != meta["map_digest"] or json.loads(row["header"])["receipt"] != envelope["receipt"]:
            return "receipt_mismatch"
        return None

    def complete(self, token, repo, sha, map_digest, runtime=None):
        """Control op bootstrap-complete. One short transaction: the exact DELETE of this helper session (token_hash,
        kind sso-bootstrap, principal) decides it: rowcount 1 is the first completion (or, for a recovery attempt of an
        already completed installation, its recovery, which never rewrites the historical completion); rowcount 0 is
        accepted only with this attempt's own committed outcome (a replay, returned without a live token)."""
        from .hive import token_hash
        if not isinstance(token, str) or not token or len(token) > 200:
            return {"ok": False, "error": "bad_request"}
        th = token_hash(token)
        meta = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE token_hash = ?", (th,))
        if meta is None:
            return {"ok": False, "error": "unknown_attempt"}
        if (repo, sha, map_digest) != (meta["repo"], meta["sha"], meta["map_digest"]):
            return {"ok": False, "error": "binding_changed"}
        if runtime != meta["runtime"] or runtime != self.runtime:
            return {"ok": False, "error": "runtime_mismatch", "runtime": self.runtime}
        if self._verifying.is_set():   # Kimi R1a.2 P3-3: never commit while the restart check may still hold this binding
            return {"ok": False, "error": "setup_busy", "stage": "verifying"}
        done = self.db.one("SELECT * FROM local_bootstrap_completions WHERE attempt = ?", (meta["attempt"],))
        if done is not None:
            return {"ok": True, "completed": True, "first": False, "receipt": self._receipt(done)}
        if meta["retired_reason"] == "recovered":
            historical = self._historical_same(meta)
            if historical is not None:
                return {"ok": True, "completed": True, "first": False, "recovered": True, "recovered_by": meta["attempt"],
                        "receipt": self._receipt(historical)}
        if meta["retired_at"] is not None:
            return {"ok": False, "error": "attempt_retired", "reason": meta["retired_reason"]}
        if meta["deadline"] <= time.time() or meta["instance"] != self.local.instance:
            return {"ok": False, "error": "attempt_expired"}
        problem = self._verify_installed(meta)
        if problem:
            self.last_error = {"stage": "complete", "code": problem}
            return {"ok": False, "error": "not_ready", "stage": problem}
        self._verified = meta["manifest_sha256"]   # this process just re-read the installed census and re-derived it
        at = time.time()
        try:
            outcome = self._commit_completion(meta, th, at)
        except _Abort as exc:
            return {"ok": False, "error": str(exc)}
        self.last_error = None
        if outcome == "recovered":
            return {"ok": True, "completed": True, "first": False, "recovered": True, "recovered_by": meta["attempt"],
                    "receipt": self._receipt(self._historical_same(meta))}
        done = self.db.one("SELECT * FROM local_bootstrap_completions WHERE attempt = ?", (meta["attempt"],))
        if done is None:
            return {"ok": False, "error": "token_not_live"}
        return {"ok": True, "completed": True, "first": outcome == "first", "receipt": self._receipt(done)}

    def _historical_same(self, meta):
        row = self.db.one("SELECT * FROM local_bootstrap_completions WHERE manifest_sha256 = ?", (meta["manifest_sha256"],))
        if row is None or (row["repo"], row["sha"], row["map_digest"], row["receipt_sha256"], row["envelope_sha256"]) != \
                (meta["repo"], meta["sha"], meta["map_digest"], meta["receipt_sha256"], meta["envelope_sha256"]):
            return None
        return row

    def _commit_completion(self, meta, th, at):
        """'first', 'recovered' or 'none' (rowcount 0); raises _Abort for a refused completion."""
        try:
            with self.db.transaction():
                gone = self.db.execute("DELETE FROM sessions WHERE token_hash = ? AND kind = ? AND principal = ?",
                                       (th, BOOTSTRAP_KIND, meta["principal"])).rowcount
                if gone != 1:
                    return "none"
                fresh = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE attempt = ?", (meta["attempt"],))
                if fresh["retired_at"] is not None or fresh["deadline"] <= at:
                    raise _Abort("attempt_retired")
                other = self.db.one("SELECT * FROM local_bootstrap_completions WHERE manifest_sha256 = ?",
                                    (meta["manifest_sha256"],))
                if other is not None:
                    if self._historical_same(meta) is None:
                        raise _Abort("superseded")
                    reason, outcome = "recovered", "recovered"   # the historical completion stays exactly as it was
                else:
                    self.db.insert("local_bootstrap_completions", {
                        "manifest_sha256": meta["manifest_sha256"], "attempt": meta["attempt"], "token_hash": th,
                        "principal": meta["principal"], "repo": meta["repo"], "sha": meta["sha"],
                        "map_digest": meta["map_digest"], "receipt_sha256": meta["receipt_sha256"],
                        "envelope_sha256": meta["envelope_sha256"], "runtime": meta["runtime"], "completed_at": at})
                    reason, outcome = "completed", "first"
                self.db.execute("UPDATE local_bootstrap_sessions SET retired_at = ?, retired_reason = ? WHERE attempt = ?",
                                (at, reason, meta["attempt"]))
                self.db.execute("DELETE FROM local_bootstrap_codes WHERE attempt = ?", (meta["attempt"],))
                return outcome
        except sqlite3.IntegrityError:   # Kimi R1a P3-6: a concurrent completion for this binding won; refused, explicitly
            raise _Abort("superseded") from None

    def retire_token(self, token):
        """Control op bootstrap-retire: the launcher's finally. Exact token hash and kind; never the person's session."""
        from .hive import token_hash
        if not isinstance(token, str) or not token:
            return {"ok": False, "error": "bad_request"}
        meta = self.db.one("SELECT * FROM local_bootstrap_sessions WHERE token_hash = ?", (token_hash(token),))
        if meta is None:
            return {"ok": False, "error": "unknown_attempt"}
        with self.db.transaction():
            self._retire(meta, "launcher")
        return {"ok": True}

    # status ----------------------------------------------------------------------------------------------------------

    def stage(self, meta):
        if meta is None:
            return "none"
        if self.db.one("SELECT 1 FROM local_bootstrap_completions WHERE attempt = ?", (meta["attempt"],)):
            return "completed"
        if meta["retired_at"] is not None:
            return f"retired:{meta['retired_reason']}"
        if meta["deadline"] <= time.time():
            return "expired"
        if meta["token_hash"] is None:
            return "begun"
        row = self.db.one("SELECT digest FROM repo_maps WHERE repo = ? AND sha = ?", (meta["repo"], meta["sha"]))
        if row is not None and row["digest"] == meta["map_digest"]:
            return "map_" + self.hive.repo_maps.space(meta["repo"], meta["sha"])["status"]
        if self._assets_present(meta["receipt_sha256"], meta["envelope_sha256"]):
            return "assets_stored"
        return "signed_in"

    def status(self):
        """Control op bootstrap-status / local recovery view: binding, hold, last attempt and stage, readiness."""
        last = self.db.one("SELECT * FROM local_bootstrap_sessions ORDER BY created_at DESC LIMIT 1")
        comp = self.completion()
        return {"ok": True, "installation": self.marker.installation, "features": list(self.marker.features),
                "binding": ({"repo": self.binding.repo, "sha": self.binding.sha, "manifest_sha256": self.binding.sha256}
                            if self.binding else None),
                "hold": self.hold, "last_error": self.last_error, "coding_ready": self.coding_ready(),
                "completed": self._receipt(comp) if comp else None,
                "attempt": ({"attempt": last["attempt"], "stage": self.stage(last), "deadline": last["deadline"]}
                            if last else None),
                "verifying": self._verifying.is_set(), "runtime": self.runtime, "held_minds": len(self.held()), "started_at": self.started_at, "code_ready_at": self.code_ready_at,
                "timing": self.timing()}

    def public_status(self):
        """Plain copy for the Welcome page (no map/NAL/contract/trace words)."""
        if self.coding_ready():
            return {"state": "ready", "text": COPY["ready"]}
        last = self.db.one("SELECT * FROM local_bootstrap_sessions ORDER BY created_at DESC LIMIT 1")
        busy = (last is not None and last["retired_at"] is None and last["deadline"] > time.time()) or self._verifying.is_set()
        if self.hold is None and (busy or (self.completion() is not None)):
            return {"state": "getting_ready", "text": COPY["getting_ready"]}
        return {"state": "not_ready", "text": COPY["not_ready"], "action": COPY["retry"]}

    def answer(self, request):
        """Control-socket ops (the caller already passed the same-uid check)."""
        op = request.get("op")
        if op == "bootstrap-begin":
            return self.begin()
        if op == "bootstrap-complete":
            return self.complete(request.get("token"), request.get("repo"), request.get("sha"), request.get("map_digest"),
                                 request.get("runtime"))
        if op == "bootstrap-retire":
            return self.retire_token(request.get("token"))
        if op == "bootstrap-status":
            return self.status()
        return None


class _Abort(Exception):
    pass


CODE_PREFIXES = ("/api/code/", "/api/agent/code/")


class CodingRoutesBarrier:
    """ASGI: the Code routes (person and agent) answer 409 coding_not_ready until the installed map is ready. Installed
    only on a new-hive installation; every other path passes untouched (the Ask, sign-in, status, reads, Stop)."""

    def __init__(self, app, newhive):
        self.app, self.newhive = app, newhive

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            if (path.startswith(CODE_PREFIXES) or path in ("/api/code", "/api/agent/code")) and \
                    not await asyncio.to_thread(self.newhive.coding_ready):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4409})
                    return
                body = json.dumps({"error": {"code": "coding_not_ready", "message": COPY["not_ready"],
                                             "setup": self.newhive.public_status()}}).encode()
                await send({"type": "http.response.start", "status": 409,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": body})
                return
        return await self.app(scope, receive, send)
