# Purpose: linked local folders, shown in the hive from the hive's own machine, with their read and write rules.
"""Linked local folders: a folder on the hive's own machine, shown in the hive without copying anything.

- Local hives only, decided per request: the hive machine must be local (bound to loopback, and with
  HIVE_LINKED_FOLDERS_REMOTE off also loopback-only by session_launch._loopback_only), AND the request must be local
  (not marked hive_public by the public gate, sso.py: no public prefix, no proxy's header, and straight from this
  machine) unless HIVE_LINKED_FOLDERS_REMOTE=on
  (Jon's decision; off by default). Every view says `scope: "this_machine_only"`.
- An admin links a folder and names the swarm that owns it. Read-only by default; writing is a separate per-folder
  switch, and every write leaves a receipt (who, path, sha256 before and after, bytes, when). Who may write is a second
  per-folder setting: "admins" (the default) or "swarm_members" (anyone who sees the owner swarm). Minds never write.
- Leftover write temp files (.omegahive-write-*.part, from a crash mid-write) are swept from each linked folder's tree
  at hive start and when a folder is linked: that exact pattern only, older than an hour, regular files only, no
  symlink followed, each sweep logged.
- Reads follow the assets rule: a person reads through the owner swarm (Visibility.check_path, as asset_visible does);
  a mind reads through its own swarm, or a live request on an artifact revision of the owner swarm whose manifest lists
  the folder ({"folders": [{"id": ...}]}), the same test as Assets.agent_may_read. Minds never write here.
- Paths: every request path is relative, has no '..' and is joined to the stored root, then resolved with realpath;
  anything outside the root (a symlink pointing out included) is refused, and the opened descriptor's own path is
  checked again after open (macOS F_GETPATH, Linux /proc/self/fd), so a link swapped in between is caught.
- Excluded by default, at every level: dotfiles and dot-folders (.git, .env, .ssh...), private keys (id_*, *.pem,
  *.key, *.p12, *.pfx) and keychain files. They are not listed, not read and not written.
- Hard-denied whatever an admin asks: any path part starting "atlas" (case-insensitive), any OmegaTruth-named part,
  any root with a dot part (~/.omegadots, ~/.config...), Library trees (~/Library, /Library, /System/Library: browser
  profiles, Keychains), credential stores (~/.ssh, ~/.claude*, ~/.gnupg, ~/.aws...), system configuration and the
  hive's own data folder. A folder that is, is inside, or contains one of them cannot be linked; a path under one is
  refused at read and write as well (HIVE_FOLDER_DENY adds more). HIVE_LINKED_FOLDERS_ALLOW (absolute prefixes,
  separated by the path separator), when set, is the only place roots may be linked from.
- Files with more than one hard link are refused on read and write (a hard link can alias a file outside the root).
- Writes are anchored on the verified parent folder's descriptor: opened O_DIRECTORY|O_NOFOLLOW and checked, the temp
  file created and renamed relative to it, so a parent swapped for a link mid-write is never followed.
- Big files are read in chunks, with HTTP Range (one range per request) for partial reads. Writes stream in chunks to a
  hidden temp file beside the target and replace it atomically (assets.Spool).
"""

from __future__ import annotations

import contextlib
import errno
import fnmatch
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import stat
import sys
import threading
import time

from fastapi import Request

from . import session_launch
from .assets import CHUNK, INLINE, Spool, content_disposition, floor_guard, max_upload_bytes
from .db import now

SCHEMA = """CREATE TABLE IF NOT EXISTS linked_folders (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, label TEXT NOT NULL, owner_swarm TEXT NOT NULL,
  writable INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]')"""
RECEIPTS = """CREATE TABLE IF NOT EXISTS linked_folder_receipts (
  id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, path TEXT NOT NULL, by TEXT NOT NULL,
  sha256_before TEXT, sha256_after TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL)"""

SCOPE = "this_machine_only"
WRITERS = ("admins", "swarm_members")
TEMP_PATTERN = ".omegahive-write-*.part"
TEMP_MAX_AGE = 3600
log = logging.getLogger("hive.folders")
LIST_MAX = 2000
EXCLUDED_PATTERNS = ("id_*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keychain", "*.keychain-db")
# Under the home folder of the user the hive runs as (compared case-insensitively: macOS folders are case-insensitive)
HOME_DENIED = ("Library", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".codex", ".password-store",
               ".config/gh", ".config/gcloud", "Library/Keychains", "Library/Application Support/Claude")
SYSTEM_DENIED = ("/Library", "/System/Library", "/etc", "/private/etc", "/var/root",
                 "/private/var/root", "/private/var/db")
TRUTH_NAME = re.compile(r"omega[\s._-]*truth", re.IGNORECASE)
ATLAS_NAME = re.compile(r"atlas", re.IGNORECASE)   # matched at the start of any path part: atlas, Atlas-demo, ATLAS2
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_F_GETPATH = 50   # macOS fcntl F_GETPATH


def denied_part(part):
    return bool(ATLAS_NAME.match(part) or TRUTH_NAME.search(part))


def excluded(name):
    """A single path component that is never shown, read or written."""
    return name.startswith(".") or any(fnmatch.fnmatchcase(name.lower(), p) for p in EXCLUDED_PATTERNS)


def _fold(path):
    return os.path.normpath(path).casefold()


def _inside(path, root):
    path, root = _fold(path), _fold(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


class WriteJob:
    """One write in progress: the verified root, the held parent folder descriptor, the target name in it, the
    relative path for the receipt, and the spool (created inside the parent descriptor)."""

    def __init__(self, root, parent_fd, name, rel, spool):
        self.root, self.parent_fd, self.name, self.rel, self.spool = root, parent_fd, name, rel, spool

    def close(self):
        self.spool.abort()
        if self.parent_fd is not None:
            with contextlib.suppress(OSError):
                os.close(self.parent_fd)
            self.parent_fd = None


def _fd_path(fd):
    """The real path of an open descriptor, or None where the system cannot say."""
    try:
        if sys.platform == "darwin":
            import fcntl
            raw = fcntl.fcntl(fd, _F_GETPATH, b"\0" * 1024)
            return os.fsdecode(raw.split(b"\0", 1)[0])
        if os.path.isdir("/proc/self/fd"):
            return os.readlink(f"/proc/self/fd/{fd}")
    except OSError:
        return None
    return None


class Folders:
    def __init__(self, hive):
        self.hive = hive
        hive.db.execute(SCHEMA)
        hive.db.execute(RECEIPTS)
        if "writers" not in {r["name"] for r in hive.db.all("PRAGMA table_info(linked_folders)")}:
            hive.db.execute("ALTER TABLE linked_folders ADD COLUMN writers TEXT NOT NULL DEFAULT 'admins'")
        self.sweeps = []   # the background sweep threads started (tests join them)

    # ---- rules -------------------------------------------------------------------------------------

    def remote_on(self):
        return bool(getattr(self.hive.settings, "linked_folders_remote", False))

    def machine_local(self):
        """The hive itself runs on this machine: bound to loopback; with remote use off, also loopback-only (no public
        base, proxy prefix or non-loopback public URL). With remote use on (Jon's switch) a same-machine proxy is allowed."""
        if os.environ.get("HIVE_HOST", "127.0.0.1").strip() not in ("127.0.0.1", "localhost", "::1"):
            return False
        return self.remote_on() or session_launch._loopback_only(self.hive.settings, os.environ)

    def local(self, request=None):
        """Linked folders may be used for this request: the machine is local AND (the request is local OR remote is on).
        A request is not local when the public gate marked it hive_public (a public prefix, a proxy's header, or a
        request not straight from this machine: sso.py)."""
        if not self.machine_local():
            return False
        public = bool(request is not None and request.scope.get("hive_public"))
        return not public or self.remote_on()

    def require_local(self, request=None):
        if not self.local(request):
            raise self.hive.error(403, "local_hive_only", "linked folders are used on the hive's own machine only")

    def denied_roots(self):
        home = os.path.realpath(os.path.expanduser("~"))
        roots = [os.path.join(home, d) for d in HOME_DENIED] + list(SYSTEM_DENIED)
        roots.append(os.path.realpath(str(self.hive.settings.data_dir)))
        roots += [p for p in os.environ.get("HIVE_FOLDER_DENY", "").split(os.pathsep) if p.strip()]
        out = set()
        for r in roots:
            out.add(os.path.normpath(r))
            out.add(os.path.realpath(r))   # a denied folder reached through a link (macOS /etc -> /private/etc)
        return home, sorted(out)

    def denied(self, path):
        """True for a path that is, or is under, a hard-denied place (path is already realpath'd)."""
        home, roots = self.denied_roots()
        if any(_inside(path, r) for r in roots):
            return True
        if any(denied_part(part) for part in path.split("/")):
            return True
        if _inside(path, home) and _fold(path) != _fold(home):
            first = _fold(path)[len(_fold(home).rstrip("/")) + 1:].split("/", 1)[0]
            if first.startswith(".claude"):   # ~/.claude, ~/.claude.json, ~/.claude-anything
                return True
        return False

    def contains_denied(self, root):
        """True when linking `root` would expose a hard-denied place below it (linking the home folder, for example)."""
        home, roots = self.denied_roots()
        if _fold(root) == "/":
            return True
        below = [r for r in roots if _inside(r, root)]
        if below:
            return True
        if _inside(home, root):
            return True   # ~/.claude* and ~/Library live directly under home
        with contextlib.suppress(OSError):
            for entry in os.scandir(root):   # a direct atlas/OmegaTruth child is caught by name; deeper ones at access time
                if denied_part(entry.name) and entry.is_dir(follow_symlinks=False):
                    return True   # a denied-named file is refused at access instead
        return False

    def allowed_roots(self):
        raw = os.environ.get("HIVE_LINKED_FOLDERS_ALLOW", "")
        return [os.path.realpath(p.strip()) for p in raw.split(os.pathsep) if p.strip() and os.path.isabs(p.strip())]

    def outside_allowlist(self, root):
        allow = self.allowed_roots()
        if not allow and os.environ.get("HIVE_LINKED_FOLDERS_ALLOW", "").strip():
            return True   # set but with no usable absolute prefix: nothing may be linked (fail closed)
        return bool(allow) and not any(_inside(root, a) for a in allow)

    # ---- records -----------------------------------------------------------------------------------

    def row(self, folder_id):
        row = self.hive.db.one("SELECT * FROM linked_folders WHERE id = ?", (str(folder_id),))
        if row is None:
            raise self.hive.error(404, "not_found", "no such linked folder")
        return row

    def view(self, row):
        return {"id": row["id"], "label": row["label"], "root": row["root"], "owner_swarm": row["owner_swarm"],
                "writable": bool(row["writable"]), "writers": row["writers"] or "admins", "created_by": row["created_by"], "created_at": row["created_at"],
                "scope": SCOPE, "available": os.path.isdir(row["root"]), "history": json.loads(row["history"] or "[]")}

    def link(self, path, owner_swarm, by, label="", request=None):
        self.require_local(request)
        if not isinstance(path, str) or not path.strip() or "\0" in path:
            raise self.hive.error(400, "bad_request", "name a folder on this machine")
        if not isinstance(owner_swarm, str) or not owner_swarm or self.hive.db.one("SELECT id FROM swarms WHERE id = ?", (owner_swarm,)) is None:
            raise self.hive.error(400, "bad_request", "name the swarm that owns this folder")
        raw = os.path.expanduser(path.strip())
        if not os.path.isabs(raw):
            raise self.hive.error(400, "bad_request", "give the folder's full path")
        # the spelled path and the resolved one are both checked: a link to a denied place is denied too
        root = os.path.realpath(raw)
        dotted = any(part.startswith(".") for part in (os.path.normpath(raw).split("/") + root.split("/")) if part)
        if dotted or self.denied(os.path.normpath(raw)) or self.denied(root) or self.contains_denied(root):
            raise self.hive.error(403, "folder_denied", "this folder cannot be linked: it is, holds or sits inside a protected place")
        if self.outside_allowlist(root):
            raise self.hive.error(403, "folder_not_allowed", "this hive links folders only from the places its operator allows")
        if not os.path.isdir(root):
            raise self.hive.error(404, "not_found", "no such folder on this machine")
        if self.hive.db.one("SELECT id FROM linked_folders WHERE root = ? AND owner_swarm = ?", (root, owner_swarm)):
            raise self.hive.error(409, "already_linked", "this folder is already linked for that swarm")
        fid = "lf_" + secrets.token_hex(8)
        label = str(label or os.path.basename(root) or root)[:120]
        history = [{"at": now(), "by": by, "event": "linked"}]
        self.hive.db.insert("linked_folders", {"id": fid, "root": root, "label": label, "owner_swarm": owner_swarm,
                                               "writable": 0, "created_by": by, "created_at": now(), "history": json.dumps(history)})
        self.sweep_later([fid])
        return self.view(self.row(fid))

    # ---- leftover write temp files -----------------------------------------------------------------

    def sweep(self, root, max_age=TEMP_MAX_AGE):
        """Remove .omegahive-write-*.part files older than max_age seconds under root: that exact pattern, regular
        files only (lstat), never following a symlink (os.walk followlinks=False, links never descended). Logged."""
        removed, kept, failed = 0, 0, 0
        cutoff = time.time() - max_age
        if not os.path.isdir(root) or os.path.islink(root):
            log.info("folder sweep %s: root missing or a link; nothing swept", root)
            return {"root": root, "removed": 0, "kept": 0, "failed": 0}
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            for name in filenames:
                if not fnmatch.fnmatchcase(name, TEMP_PATTERN):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    st = os.lstat(path)
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    if st.st_mtime > cutoff:
                        kept += 1   # may be a write still arriving
                        continue
                    os.unlink(path)
                    removed += 1
                except OSError:
                    failed += 1
        log.info("folder sweep %s: removed %d leftover write temp file(s), kept %d recent, %d failed", root, removed, kept, failed)
        print(f"[hive] linked folder sweep {root}: removed {removed}, kept {kept} recent, failed {failed}", flush=True)
        return {"root": root, "removed": removed, "kept": kept, "failed": failed}

    def sweep_later(self, folder_ids=None):
        """Sweep the given linked folders (all when None) on a background thread: a large tree never blocks a request
        or the hive's start."""
        if folder_ids is None:
            roots = [r["root"] for r in self.hive.db.all("SELECT root FROM linked_folders")]
        else:
            roots = [self.row(f)["root"] for f in folder_ids]
        if not roots:
            return None

        def run():
            for root in roots:
                try:
                    self.sweep(root)
                except Exception as exc:   # a sweep never takes the hive down
                    log.warning("folder sweep %s failed: %s", root, exc)
        t = threading.Thread(target=run, name="linked-folder-sweep", daemon=True)
        self.sweeps.append(t)
        t.start()
        return t

    def unlink(self, folder_id, by, request=None):
        self.require_local(request)
        row = self.row(folder_id)
        self.hive.db.execute("DELETE FROM linked_folders WHERE id = ?", (row["id"],))   # receipts stay
        return {"id": row["id"], "unlinked": True, "by": by}

    def set_writable(self, folder_id, writable, by, writers=None, request=None):
        """The write switch and, optionally, who may write ("admins" or "swarm_members"); either may be given alone."""
        self.require_local(request)
        if writable is not None and not isinstance(writable, bool):
            raise self.hive.error(400, "bad_request", "writable is true or false")
        if writers is not None and writers not in WRITERS:
            raise self.hive.error(400, "bad_request", "writers is admins or swarm_members")
        if writable is None and writers is None:
            raise self.hive.error(400, "bad_request", "give writable, writers or both")
        row = self.row(folder_id)
        history = json.loads(row["history"] or "[]")
        if writable is not None and bool(row["writable"]) != writable:
            history.append({"at": now(), "by": by, "event": "write_on" if writable else "write_off"})
        if writers is not None and (row["writers"] or "admins") != writers:
            history.append({"at": now(), "by": by, "event": "writers", "writers": writers})
        new_writable = int(writable) if writable is not None else row["writable"]
        new_writers = writers or row["writers"] or "admins"
        self.hive.db.execute("UPDATE linked_folders SET writable = ?, writers = ?, history = ? WHERE id = ?",
                             (new_writable, new_writers, json.dumps(history), row["id"]))
        return self.view(self.row(row["id"]))

    def receipts(self, folder_id, limit=200):
        return self.hive.db.all("SELECT * FROM linked_folder_receipts WHERE folder_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
                                (str(folder_id), max(1, min(int(limit), 1000))))

    # ---- paths -------------------------------------------------------------------------------------

    def _root(self, row):
        root = row["root"]
        if os.path.realpath(root) != root or not os.path.isdir(root):
            raise self.hive.error(409, "folder_changed", "the linked folder moved, became a link or is gone; link it again")
        if self.outside_allowlist(root) or self.denied(root):
            raise self.hive.error(403, "folder_not_allowed", "this linked folder is no longer in an allowed place")
        return root

    def resolve(self, row, rel, *, must_exist=True):
        """(root, real path, relative parts) for a request path, or a refusal. Never follows a path out of the root."""
        root = self._root(row)
        rel = "" if rel is None else str(rel)
        if "\0" in rel or "\\" in rel:
            raise self.hive.error(400, "bad_path", "a path uses / between names")
        if rel.startswith("/") or rel.startswith("~"):
            raise self.hive.error(403, "path_outside", "paths are relative to the linked folder")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise self.hive.error(403, "path_outside", "a path cannot leave the linked folder")
        if any(excluded(p) for p in parts):
            raise self.hive.error(403, "excluded", "hidden files, keys and secrets are never shown here")
        real = os.path.realpath(os.path.join(root, *parts))
        if not _inside(real, root):
            raise self.hive.error(403, "path_outside", "this path leads outside the linked folder")
        if self.denied(real):
            raise self.hive.error(403, "folder_denied", "this path is protected")
        inner = [] if _fold(real) == _fold(root) else os.path.relpath(real, root).split("/")
        if any(excluded(p) for p in inner):   # a link inside the root pointing at .env or a key
            raise self.hive.error(403, "excluded", "hidden files, keys and secrets are never shown here")
        if must_exist and not os.path.lexists(real):
            raise self.hive.error(404, "not_found", "no such file in the linked folder")
        return root, real, parts

    def _check_fd(self, fd, root):
        actual = _fd_path(fd)
        if actual is not None and (not _inside(os.path.realpath(actual), root) or self.denied(os.path.realpath(actual))):
            raise self.hive.error(403, "path_outside", "this path leads outside the linked folder")

    def _open_read(self, row, rel):
        root, real, _ = self.resolve(row, rel)
        try:
            fd = os.open(real, os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise self.hive.error(403, "path_outside", "the file changed into a link") from None
            raise self.hive.error(404, "not_found", "this file cannot be opened") from None
        try:
            self._check_fd(fd, root)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise self.hive.error(400, "not_a_file", "only files can be read")
            if st.st_nlink > 1:
                raise self.hive.error(403, "hard_link", "a file with more than one hard link is not read here")
        except BaseException:
            os.close(fd)
            raise
        return fd, st.st_size, real

    # ---- reading -----------------------------------------------------------------------------------

    def listing(self, row, rel=""):
        root, real, parts = self.resolve(row, rel)
        if not os.path.isdir(real):
            raise self.hive.error(400, "not_a_folder", "this is a file; read it instead")
        items, hidden, truncated = [], 0, False
        with os.scandir(real) as entries:
            for entry in sorted(entries, key=lambda e: e.name.casefold()):
                if excluded(entry.name):
                    hidden += 1
                    continue
                target = os.path.realpath(entry.path)
                if not _inside(target, root) or self.denied(target) or any(
                        excluded(p) for p in ([] if _fold(target) == _fold(root) else os.path.relpath(target, root).split("/"))):
                    hidden += 1   # a link pointing out of the folder or at something excluded is not shown
                    continue
                try:
                    st = os.stat(target)
                except OSError:
                    continue
                if len(items) >= LIST_MAX:
                    truncated = True
                    break
                kind = "folder" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else None
                if kind is None:
                    continue
                items.append({"name": entry.name, "path": "/".join(parts + [entry.name]), "kind": kind,
                              "bytes": st.st_size if kind == "file" else None,
                              "modified_at": int(st.st_mtime), "link": entry.is_symlink()})
        return {"folder": self.view(row), "path": "/".join(parts), "items": items, "hidden": hidden,
                "truncated": truncated, "scope": SCOPE}

    @staticmethod
    def parse_range(header, size):
        """One `bytes=` range -> (start, end inclusive), None for no header; ValueError when unsatisfiable."""
        if not header:
            return None
        m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", header)
        if not m or (m.group(1) == "" and m.group(2) == ""):
            raise ValueError("bad range")
        if m.group(1) == "":
            n = int(m.group(2))
            if n == 0:
                raise ValueError("empty suffix")
            return max(0, size - n), size - 1
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        if start >= size or end < start:
            raise ValueError("outside the file")
        return start, min(end, size - 1)

    def read(self, row, rel, range_header=None):
        """(status, headers, chunk iterator) for a file, read in CHUNK pieces; one Range honoured."""
        fd, size, real = self._open_read(row, rel)
        try:
            span = self.parse_range(range_header, size)
        except ValueError:
            os.close(fd)
            raise self.hive.error(416, "range_not_satisfiable", f"this file holds {size} bytes")
        start, end = span if span else (0, size - 1)
        length = max(0, end - start + 1)

        def chunks():
            with os.fdopen(fd, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    block = f.read(min(CHUNK, left))
                    if not block:
                        break
                    left -= len(block)
                    yield block

        mime = mimetypes.guess_type(real)[0] or "application/octet-stream"
        inline = mime in INLINE
        headers = {"Content-Type": mime if inline else "application/octet-stream", "Content-Length": str(length),
                   "Content-Disposition": content_disposition("inline" if inline else "attachment", os.path.basename(real)),
                   "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
                   "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store",
                   "X-Hive-Scope": SCOPE}
        if span:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return (206 if span else 200), headers, chunks()

    # ---- writing -----------------------------------------------------------------------------------

    def may_write(self, row, is_admin):
        return bool(is_admin) or (row["writers"] or "admins") == "swarm_members"

    def begin_write(self, row, rel, is_admin=False, request=None, declared=0):
        """Checks before any byte is accepted. Returns a WriteJob holding the verified parent folder's descriptor and a
        spool created inside it; the caller writes the body into job.spool, then calls finish_write (or job.close())."""
        self.require_local(request)
        if not row["writable"]:
            raise self.hive.error(403, "read_only", "this linked folder is read-only; an admin can turn on writing")
        if not self.may_write(row, is_admin):
            raise self.hive.error(403, "admins_write_only", "only admins write to this linked folder")
        root, real, parts = self.resolve(row, rel, must_exist=False)
        if not parts:
            raise self.hive.error(400, "bad_path", "name a file inside the linked folder")
        parent, name = os.path.dirname(real), parts[-1]
        if not _inside(parent, root):
            raise self.hive.error(404, "not_found", "the folder for this file does not exist")
        try:
            parent_fd = os.open(parent, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _O_CLOEXEC)
        except OSError:
            raise self.hive.error(404, "not_found", "the folder for this file does not exist") from None
        try:
            self._check_dir_fd(parent_fd, root)
            self._target_ok(parent_fd, name)
            guard = floor_guard(self.hive, parent, declared)
            cap = max_upload_bytes(self.hive.settings)
            spool = Spool(limit=cap, too_large=(lambda: self.hive.error(413, "too_large", "this file is over the hive's size limit")) if cap else None,
                          prefix=".omegahive-write-", dir_fd=parent_fd, guard=guard)
        except BaseException:
            os.close(parent_fd)
            raise
        return WriteJob(root, parent_fd, name, "/".join(parts), spool)

    def _check_dir_fd(self, fd, root):
        """The held parent folder is still inside the root, not denied and not under an excluded part."""
        actual = _fd_path(fd)
        if actual is None:
            return
        real = os.path.realpath(actual)
        if not _inside(real, root) or self.denied(real):
            raise self.hive.error(403, "path_outside", "the folder for this file is no longer inside the linked folder")
        inner = [] if _fold(real) == _fold(root) else os.path.relpath(real, root).split("/")
        if any(excluded(p) for p in inner):
            raise self.hive.error(403, "excluded", "hidden files, keys and secrets are never shown here")

    def _target_ok(self, parent_fd, name):
        """An existing target must be a plain file with one link (never a symlink, folder or hard link)."""
        try:
            st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise self.hive.error(403, "not_a_file", "only a plain file can be written; links and folders are not")
        if st.st_nlink > 1:
            raise self.hive.error(403, "hard_link", "a file with more than one hard link is not written here")
        return st

    def finish_write(self, row, job, by, is_admin=False):
        """Rename the finished spool over the target inside the held parent folder (renameat, atomic) and record the
        receipt. The parent is checked again first, so a folder swapped or moved mid-write refuses. Always cleans up."""
        try:
            after = job.spool.finish()
            self._check_dir_fd(job.parent_fd, job.root)
            before = None
            if self._target_ok(job.parent_fd, job.name) is not None:
                fd = os.open(job.name, os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC, dir_fd=job.parent_fd)
                try:
                    h = hashlib.sha256()
                    for block in iter(lambda: os.read(fd, CHUNK), b""):
                        h.update(block)
                    before = h.hexdigest()
                finally:
                    os.close(fd)
            fresh = self.row(row["id"])   # the switch may have been turned off while the body arrived
            if not fresh["writable"]:
                raise self.hive.error(403, "read_only", "this linked folder became read-only")
            if not self.may_write(fresh, is_admin):
                raise self.hive.error(403, "admins_write_only", "only admins write to this linked folder")
            os.rename(job.spool.path.name, job.name, src_dir_fd=job.parent_fd, dst_dir_fd=job.parent_fd)
            receipt = {"id": "lfr_" + secrets.token_hex(8), "folder_id": row["id"], "path": job.rel, "by": by,
                       "sha256_before": before, "sha256_after": after, "bytes": job.spool.size, "at": now()}
            self.hive.db.insert("linked_folder_receipts", receipt)
            return dict(receipt, scope=SCOPE)
        finally:
            job.close()

    # ---- who may read ------------------------------------------------------------------------------

    def person_may_read(self, viewer, row):
        self.hive.visibility.check_path(viewer, {"swarm_id": row["owner_swarm"]})   # raises 404 as not found

    def agent_may_read(self, agent, row, artifact_id=None, revision=None):
        """The assets rule for minds: its own swarm, or a live request on a revision of the owner swarm's artifact whose
        manifest lists this folder."""
        if agent.get("swarm_id") and agent["swarm_id"] == row["owner_swarm"]:
            return True
        if artifact_id is None or revision is None:
            return False
        art = self.hive.collab.artifact(artifact_id)
        if art["owner_swarm"] != row["owner_swarm"]:
            return False   # a manifest can only grant its own swarm's folders
        rev = self.hive.collab.read_revision(agent, artifact_id, int(revision))   # raises unless readable
        try:
            manifest = json.loads(rev["body"])
        except ValueError:
            return False
        listed = {f.get("id") for f in (manifest.get("folders") or []) if isinstance(f, dict)} if isinstance(manifest, dict) else set()
        return row["id"] in listed


def install_routes(app, hive, operator, admin, agent_from, viewer):
    from fastapi.responses import StreamingResponse
    from .hive import HiveError

    folders = Folders(hive)
    hive.folders = folders
    if folders.machine_local():
        folders.sweep_later()   # leftovers from a crash mid-write, at hive start

    def who(session):
        return session.get("principal") or "user:operator"

    def readable(request, folder_id):
        session = operator(request)
        folders.require_local(request)
        row = folders.row(folder_id)
        folders.person_may_read(viewer(session), row)
        return session, row

    def agent_readable(request, folder_id, artifact, revision):
        agent = agent_from(request)
        folders.require_local(request)
        row = folders.row(folder_id)
        if not folders.agent_may_read(agent, row, artifact, revision):
            raise HiveError(404, "not_found", "no such linked folder for you")
        return agent, row

    async def json_body(request):
        raw = b""
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > 16384:
                raise HiveError(413, "request_too_large", "this request is too large")
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            raise HiveError(400, "bad_request", "expected a JSON body")
        if not isinstance(data, dict):
            raise HiveError(400, "bad_request", "expected a JSON object")
        return data

    def stream(status, headers, chunks):
        return StreamingResponse(chunks, status_code=status, headers=headers)

    @app.get("/api/folders")
    async def list_folders(request: Request, swarm_id: str | None = None):
        session = operator(request)
        v = viewer(session)
        out = {"local": folders.local(request), "scope": SCOPE, "folders": []}
        if not out["local"]:
            return out   # nothing is linked or shown on a hive that is not on this machine
        rows = hive.db.all("SELECT * FROM linked_folders" + (" WHERE owner_swarm = ?" if swarm_id else "") + " ORDER BY created_at DESC",
                           (swarm_id,) if swarm_id else ())
        for row in rows:
            try:
                folders.person_may_read(v, row)
            except HiveError:
                continue
            out["folders"].append(folders.view(row))
        return out

    @app.post("/api/folders")
    async def link_folder(request: Request):
        session = admin(request)
        data = await json_body(request)
        linked = folders.link(data.get("path"), data.get("swarm_id"), who(session), data.get("label") or "", request)
        notices = getattr(hive, "mind_files", None)   # the owner swarm's minds hear of it once (mind_files.py)
        if notices is not None:
            await notices.folder_linked(linked, who(session))
        return linked

    @app.delete("/api/folders/{folder_id}")
    async def unlink_folder(folder_id: str, request: Request):
        session = admin(request)
        return folders.unlink(folder_id, who(session), request)

    @app.post("/api/folders/{folder_id}/write")
    async def folder_write_switch(folder_id: str, request: Request):
        session = admin(request)
        data = await json_body(request)
        return folders.set_writable(folder_id, data.get("writable"), who(session), data.get("writers"), request)

    @app.get("/api/folders/{folder_id}/list")
    async def browse_folder(folder_id: str, request: Request, path: str = ""):
        _, row = readable(request, folder_id)
        return folders.listing(row, path)

    @app.get("/api/folders/{folder_id}/file")
    async def read_folder_file(folder_id: str, request: Request, path: str = ""):
        _, row = readable(request, folder_id)
        return stream(*folders.read(row, path, request.headers.get("range")))

    @app.put("/api/folders/{folder_id}/file")
    async def write_folder_file(folder_id: str, request: Request, path: str = ""):
        session, row = readable(request, folder_id)
        is_admin = viewer(session).admin
        declared = request.headers.get("content-length") or ""
        job = folders.begin_write(row, path, is_admin, request, int(declared) if declared.isdigit() else 0)
        try:
            if declared.isdigit() and job.spool.limit is not None and int(declared) > job.spool.limit:
                raise job.spool.too_large()
            async for chunk in request.stream():
                job.spool.write(chunk)
        except BaseException:
            job.close()   # a disconnect or refusal leaves nothing behind
            raise
        return folders.finish_write(row, job, who(session), is_admin)

    @app.get("/api/folders/{folder_id}/receipts")
    async def folder_receipts(folder_id: str, request: Request, limit: int = 200):
        readable(request, folder_id)
        return folders.receipts(folder_id, limit)

    @app.get("/api/agent/folders")
    async def agent_folders(request: Request):
        agent = agent_from(request)
        if not folders.local(request) or not agent.get("swarm_id"):
            return []
        return [folders.view(r) for r in hive.db.all("SELECT * FROM linked_folders WHERE owner_swarm = ?", (agent["swarm_id"],))]

    @app.get("/api/agent/folders/{folder_id}/list")
    async def agent_browse_folder(folder_id: str, request: Request, path: str = "", artifact: str | None = None, revision: int | None = None):
        _, row = agent_readable(request, folder_id, artifact, revision)
        return folders.listing(row, path)

    @app.get("/api/agent/folders/{folder_id}/file")
    async def agent_read_folder_file(folder_id: str, request: Request, path: str = "", artifact: str | None = None, revision: int | None = None):
        _, row = agent_readable(request, folder_id, artifact, revision)
        return stream(*folders.read(row, path, request.headers.get("range")))

    return folders
