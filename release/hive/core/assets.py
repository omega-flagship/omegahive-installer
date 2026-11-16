"""Binary assets: images, PDFs, decks, media, design originals and previews (R12).

Content-addressed: every file is its sha256, wherever it lives, so moving it never changes what it is and every read
and transfer is checked against the hash. Stores are pluggable:

- local: the hive's data directory (default; outside every mind's sandbox)
- s3:    any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO...), signed with SigV4 by the hive itself;
         credentials come from the hive's environment, never from minds

Configure extra stores with HIVE_ASSET_STORES='{"cloud": {"kind": "s3", "endpoint": "https://<acct>.r2.cloudflarestorage.com",
"bucket": "omegahive", "region": "auto", "key_env": "HIVE_S3_KEY", "secret_env": "HIVE_S3_SECRET"}}'.

Size: uploads stream to disk in chunks, hashed as they arrive (Spool), then move into the local store atomically, so
the local store has no practical cap and memory stays flat. An operator may set one (HIVE_ASSET_MAX_BYTES, default none).
Whole-file-in-memory paths keep MEMORY_MAX_BYTES: put(bytes), read(), and every non-local (cloud) store.

Placement: a file marked local_only is refused by any non-local store (private app data stays on this machine).
Access follows the artifacts: the swarm that owns the file, admins, or a mind holding a live request on an artifact
revision whose manifest lists the file. Serving is safe: images and PDFs inline, anything else (HTML included) as a
download, always nosniff and a sandboxing content security policy.
"""

from __future__ import annotations

import contextlib
import datetime
import hashlib
import hmac
import json
import mimetypes
import threading
import os
import pathlib
import secrets
import shutil
import tempfile
import urllib.parse

import httpx

from .db import now

# Whole-file-in-memory paths only (put(bytes), read(), cloud stores); streamed local uploads have no built-in cap.
MEMORY_MAX_BYTES = 100 * 1024 * 1024
CHUNK = 1024 * 1024
# downloads larger than this stream from the local store (hash checked at the end) instead of being verified whole first
STREAM_FROM = 16 * 1024 * 1024
INLINE = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"}
SCHEMA = """CREATE TABLE IF NOT EXISTS assets (
  sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
  owner_swarm TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, local_only INTEGER NOT NULL DEFAULT 0,
  placements TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]')"""
# The same bytes can belong to several swarms; `assets.owner_swarm` stays as the first owner for older readers.
OWNERS_SCHEMA = """CREATE TABLE IF NOT EXISTS asset_owners (
  sha256 TEXT NOT NULL, owner_swarm TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (sha256, owner_swarm))"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Spool:
    """A body arriving in chunks: written to a private temp file beside its destination and hashed (sha256) as it
    arrives, so memory stays flat whatever the size. finish() flushes and fsyncs; the caller then moves the file into
    place with os.replace (atomic on one filesystem). abort() closes and removes it; it is safe to call more than once
    and after the file was moved away. `too_large` is raised (never caught here) once `limit` bytes would be passed."""

    GUARD_EVERY = 64 * 1024 * 1024

    def __init__(self, folder=None, limit=None, too_large=None, prefix="up-", dir_fd=None, guard=None):
        """In `folder`, or (dir_fd given) directly inside an already-verified open directory: the temp file is created
        relative to that descriptor with O_EXCL|O_NOFOLLOW, so no path is resolved again. `guard()` (the free-space
        floor) runs before the first byte and every GUARD_EVERY bytes after."""
        self.dir_fd = dir_fd
        if dir_fd is not None:
            name = f"{prefix}{secrets.token_hex(8)}.part"
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                         0o600, dir_fd=dir_fd)
        else:
            folder = pathlib.Path(folder)
            folder.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(dir=folder, prefix=prefix, suffix=".part")
            os.fchmod(fd, 0o600)
        self.file, self.path = os.fdopen(fd, "wb"), pathlib.Path(name)
        self.limit, self.too_large, self.guard = (int(limit) if limit else None), too_large, guard
        self.hash, self.size, self.writes, self.digest = hashlib.sha256(), 0, 0, None
        self._guarded_at = -1

    def write(self, chunk):
        if not chunk:
            return
        if self.limit is not None and self.size + len(chunk) > self.limit:
            raise self.too_large() if self.too_large else ValueError("too large")
        if self.guard is not None and (self._guarded_at < 0 or self.size - self._guarded_at >= self.GUARD_EVERY):
            self.guard(len(chunk))
            self._guarded_at = self.size
        self.hash.update(chunk)
        self.file.write(chunk)
        self.size += len(chunk)
        self.writes += 1

    def finish(self):
        if self.digest is None:
            self.file.flush()
            os.fsync(self.file.fileno())
            self.file.close()
            self.digest = self.hash.hexdigest()
        return self.digest

    def abort(self):
        with contextlib.suppress(OSError):
            self.file.close()
        if self.dir_fd is not None:
            with contextlib.suppress(FileNotFoundError, OSError):
                os.unlink(self.path.name, dir_fd=self.dir_fd)
        else:
            self.path.unlink(missing_ok=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.abort()


def file_sha256(path, chunk=CHUNK):
    """sha256 of a file read in chunks (never whole into memory)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def content_disposition(kind, name):
    """A Content-Disposition header that is always Latin-1 safe: an ASCII fallback `filename` (non-ASCII, quotes,
    backslashes and control characters replaced) plus RFC 5987 `filename*=UTF-8''...` carrying the real name."""
    name = str(name or "file")
    fallback = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in name) or "file"
    clean = "".join(c for c in name if ord(c) >= 32 and ord(c) != 127)
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{urllib.parse.quote(clean, safe='')}"


def min_free_bytes(settings):
    """The free-space floor (HIVE_MIN_FREE_GB, default 25 GB): uploads and folder writes stop before it."""
    value = getattr(settings, "min_free_bytes", None)
    return 25 * 1024 ** 3 if value is None else int(value)


def floor_guard(hive, path, declared=0):
    """A guard(extra) that refuses (507) when writing `extra` more bytes in `path`'s filesystem would leave less than
    the floor. Checked once now with the declared length, then by Spool as the body arrives."""
    floor = min_free_bytes(hive.settings)

    def guard(extra=0):
        if floor <= 0:
            return
        free = shutil.disk_usage(path).free
        if free - int(extra or 0) < floor:
            raise hive.error(507, "insufficient_storage",
                             f"this would leave less than {floor / 1024 ** 3:.0f} GB free on the hive's disk; nothing was stored")
    guard(declared)
    return guard


def max_upload_bytes(settings):
    """The operator's optional cap on one stored file (HIVE_ASSET_MAX_BYTES); None = no cap (the default)."""
    value = getattr(settings, "asset_max_bytes", None)
    return int(value) if value else None


class LocalStore:
    kind = "local"

    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root.chmod(0o700)

    def _path(self, digest):
        return self.root / digest[:2] / digest[2:4] / digest

    def put(self, digest, data):
        path = self._path(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def adopt(self, digest, source):
        """Move a finished spool file into place: one atomic rename, no copy (the spool lives under this root)."""
        path = self._path(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, path)

    def get(self, digest):
        path = self._path(digest)
        return path.read_bytes() if path.exists() else None

    def size(self, digest):
        try:
            return self._path(digest).stat().st_size
        except FileNotFoundError:
            return None

    def has(self, digest):
        return self._path(digest).exists()

    def delete(self, digest):
        self._path(digest).unlink(missing_ok=True)


class S3Store:
    """Minimal S3-compatible store with AWS Signature V4 (no extra dependency)."""
    kind = "s3"

    def __init__(self, endpoint, bucket, region, key, secret, transport=None):
        self.endpoint, self.bucket, self.region = endpoint.rstrip("/"), bucket, region or "auto"
        self.key, self.secret = key, secret
        self.http = httpx.Client(timeout=120, transport=transport)

    def _sign(self, method, path, payload_hash, headers):
        t = datetime.datetime.now(datetime.timezone.utc)
        amz, day = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
        host = urllib.parse.urlparse(self.endpoint).netloc
        headers = dict(headers, host=host, **{"x-amz-date": amz, "x-amz-content-sha256": payload_hash})
        names = sorted(k.lower() for k in headers)
        canonical_headers = "".join(f"{k}:{str(headers[k] if k in headers else headers[[h for h in headers if h.lower() == k][0]]).strip()}\n" for k in names)
        signed = ";".join(names)
        request = "\n".join([method, urllib.parse.quote(path), "", canonical_headers, signed, payload_hash])
        scope = f"{day}/{self.region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(request.encode()).hexdigest()])
        k = hmac.new(("AWS4" + self.secret).encode(), day.encode(), hashlib.sha256).digest()
        for part in (self.region, "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = f"AWS4-HMAC-SHA256 Credential={self.key}/{scope}, SignedHeaders={signed}, Signature={signature}"
        return headers

    def _path(self, digest):
        return f"/{self.bucket}/assets/{digest}"

    def put(self, digest, data):
        path = self._path(digest)
        r = self.http.put(self.endpoint + path, content=data, headers=self._sign("PUT", path, sha256(data), {}))
        r.raise_for_status()

    def get(self, digest):
        path = self._path(digest)
        r = self.http.get(self.endpoint + path, headers=self._sign("GET", path, "UNSIGNED-PAYLOAD", {}))
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content

    def has(self, digest):
        path = self._path(digest)
        r = self.http.head(self.endpoint + path, headers=self._sign("HEAD", path, "UNSIGNED-PAYLOAD", {}))
        return r.status_code == 200

    def delete(self, digest):
        path = self._path(digest)
        r = self.http.delete(self.endpoint + path, headers=self._sign("DELETE", path, "UNSIGNED-PAYLOAD", {}))
        r.raise_for_status()


class Assets:
    def __init__(self, hive, stores=None):
        self.hive = hive
        hive.db.execute(SCHEMA)
        hive.db.execute(OWNERS_SCHEMA)
        # each owner keeps the filename it put the file under (stand-in r4: a team's duplicate put showed the first,
        # possibly private, owner's filename); NULL for rows from before this column, which fall back in view_for
        if "name" not in {r["name"] for r in hive.db.all("PRAGMA table_info(asset_owners)")}:
            hive.db.execute("ALTER TABLE asset_owners ADD COLUMN name TEXT")
        self.stores = {"local": LocalStore(hive.settings.data_dir / "assets")}
        # One lock for every placement change (put, transfer): the local-only check and the write it guards are one
        # step, so a concurrent duplicate put or copy cannot ship a file that is becoming local-only (Kimi 2026-10-04).
        self._placement = threading.RLock()
        config = os.environ.get("HIVE_ASSET_STORES", "")
        for name, c in (json.loads(config) if config else {}).items():
            if c.get("kind") == "s3":
                self.stores[name] = S3Store(c["endpoint"], c["bucket"], c.get("region", "auto"),
                                            os.environ.get(c.get("key_env", ""), ""), os.environ.get(c.get("secret_env", ""), ""))
        self.stores.update(stores or {})
        # uploads in flight spool here (same filesystem as the local store: the final move is a rename); anything left
        # by a crash is removed at start
        self.incoming = self.stores["local"].root / ".incoming"
        if self.incoming.is_dir():
            for leftover in self.incoming.glob("*.part"):
                leftover.unlink(missing_ok=True)

    # ---- records ---------------------------------------------------------------------------------

    def row(self, digest):
        row = self.hive.db.one("SELECT * FROM assets WHERE sha256 = ?", (str(digest),))
        if row is None:
            raise self.hive.error(404, "not_found", "no such asset")
        return row

    def owners(self, digest):
        """Every swarm that has put this exact file (the first owner included)."""
        found = {r["owner_swarm"] for r in self.hive.db.all("SELECT owner_swarm FROM asset_owners WHERE sha256 = ?", (str(digest),))}
        first = self.hive.db.one("SELECT owner_swarm FROM assets WHERE sha256 = ?", (str(digest),))
        return found | ({first["owner_swarm"]} if first and first["owner_swarm"] else set())

    def _add_owner(self, digest, owner_swarm, by, name=""):
        if owner_swarm:
            self.hive.db.execute("INSERT OR IGNORE INTO asset_owners (sha256, owner_swarm, created_by, created_at, name) "
                                 "VALUES (?,?,?,?,?)", (digest, owner_swarm, by, now(), str(name or "")[:200]))

    def owner_name(self, row, owner_swarm):
        """The filename this owner put the file under: its own asset_owners name; for the first owner of a row from before
        that column, the asset's name."""
        r = self.hive.db.one("SELECT name FROM asset_owners WHERE sha256 = ? AND owner_swarm = ?", (row["sha256"], owner_swarm))
        if r and r["name"]:
            return r["name"]
        return row["name"] if owner_swarm == row.get("owner_swarm") else ""

    @staticmethod
    def neutral_name(mime):
        """A name that says nothing about any owner: 'file' plus the extension of the (already visible) mime type."""
        return "file" + (mimetypes.guess_extension(str(mime or "")) or "")

    def view(self, row):
        out = dict(row)
        out["owners"] = sorted(self.owners(row["sha256"]))
        out["placements"], out["history"] = json.loads(row["placements"]), json.loads(row["history"])
        out["local_only"] = bool(row["local_only"])
        # copies a local-only file still has off this machine: recorded until a delete is confirmed (OmegaReview B2)
        out["pending_removal"] = self._remote(out["placements"]) if out["local_only"] else []
        return out

    def view_for(self, viewer, row):
        """One asset as this viewer may read it from a list, or None when they see none of its owner swarms (access is
        unchanged: any visible owner admits it, as before). Owner swarms the viewer may not see (for an admin: another
        person's hidden personal swarm, Visibility.hidden_ids; for a member: Viewer.sees), and minds hidden from them,
        are redacted from `owners`, `owner_swarm`, `created_by` and `history` (stand-in r3 P1: a mixed-owner asset carried
        another person's personal swarm through a team swarm's listing)."""
        out = self.view(row)
        vis = self.hive.visibility
        hidden = vis.hidden_ids(viewer)

        def shown(swarm_id):
            if viewer.admin:
                return swarm_id not in hidden
            return viewer.sees(vis._swarm(swarm_id))

        def hidden_by(by):
            return isinstance(by, str) and by.startswith("agent:") and (
                by[6:] in hidden if viewer.admin else not viewer.sees(vis._agent(by[6:])))

        if not out["owners"]:
            return out
        owners = [o for o in out["owners"] if shown(o)]
        if not owners:
            return None
        redacted_creator = None
        if out.get("owner_swarm") and out["owner_swarm"] not in owners:
            redacted_creator = out.get("created_by")
            first = self.hive.db.one("SELECT owner_swarm, created_by FROM asset_owners WHERE sha256 = ? AND owner_swarm IN "
                                     "(SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 1", (row["sha256"], json.dumps(owners)))
            out["owner_swarm"], out["created_by"] = (first["owner_swarm"], first["created_by"]) if first else (owners[0], None)
            # the name a visible owner put it under, never the hidden first owner's (stand-in r4 P1)
            out["name"] = self.owner_name(row, out["owner_swarm"]) or self.neutral_name(row.get("mime"))
        if hidden_by(out.get("created_by")):
            out["created_by"] = None
        out["owners"] = owners
        out["history"] = [h for h in out["history"] if isinstance(h, dict)
                          and not (h.get("owner_swarm") and h["owner_swarm"] not in owners)
                          and not hidden_by(h.get("by"))
                          and not (redacted_creator and h.get("by") == redacted_creator and h.get("event") == "stored")]
        return out

    def _remote(self, placements):
        return sorted(n for n in placements if self.stores.get(n) is None or self.stores[n].kind != "local")

    def store_info(self):
        return [{"name": n, "kind": s.kind, "max_bytes": self.limit_for(s)} for n, s in self.stores.items()]

    def limit_for(self, target):
        """The most one file may hold in this store: the operator's cap (none by default) for the local store; cloud
        stores keep their own whole-file limit (they are written from memory)."""
        cap = max_upload_bytes(self.hive.settings)
        if target.kind != "local":
            cap = min(cap or MEMORY_MAX_BYTES, MEMORY_MAX_BYTES)
        return cap

    def _too_large(self, cap):
        return self.hive.error(413, "too_large", f"files in this store are limited to {cap // (1024 * 1024) or 1} MB"
                               if cap >= 1024 * 1024 else f"files in this store are limited to {cap} bytes")

    def spool(self, store="local", declared=0):
        """Start receiving one upload for `store` in chunks (Spool); the limit is that store's (limit_for), and the
        free-space floor applies to the declared length now and to the body as it arrives."""
        cap = self.limit_for(self._store(store))
        self.incoming.mkdir(parents=True, exist_ok=True)
        guard = floor_guard(self.hive, self.incoming, declared)
        return Spool(self.incoming, cap, (lambda: self._too_large(cap)) if cap else None, guard=guard)

    # ---- writing and reading ---------------------------------------------------------------------

    def put(self, data: bytes, mime, by, owner_swarm=None, name="", local_only=False, store="local"):
        with self._placement:
            out = self._put(data, mime, by, owner_swarm, name, local_only, store)
        return self._stored(out, owner_swarm, by)

    def put_spooled(self, spool, mime, by, owner_swarm=None, name="", local_only=False, store="local"):
        """Store a finished upload (Spool) without loading it: the local store takes it by rename; a cloud store, within
        its own limit, from memory. The spool file is removed whatever happens."""
        try:
            digest = spool.finish()
            if not spool.size:
                raise self.hive.error(400, "bad_request", "an asset needs content")
            target = self._store(store)
            cap = self.limit_for(target)
            if cap and spool.size > cap:
                raise self._too_large(cap)
            place = ((lambda: target.adopt(digest, spool.path)) if hasattr(target, "adopt")
                     else (lambda: target.put(digest, spool.path.read_bytes())))
            with self._placement:
                out = self._record(digest, spool.size, mime, by, owner_swarm, name, local_only, store, place)
        finally:
            spool.abort()
        return self._stored(out, owner_swarm, by)

    def _stored(self, out, owner_swarm, by):
        # repo maps 1.2 (repomap_live.py): what was stored, never its bytes; after a surrounding transaction commits
        notice = {"sha256": out.get("sha256"), "owner_swarm": owner_swarm, "by": by}
        self.hive.db.after_commit(lambda: self.hive.events.publish("asset.stored", **notice))
        return out

    def _put(self, data, mime, by, owner_swarm, name, local_only, store):
        if not isinstance(data, (bytes, bytearray)) or not data:
            raise self.hive.error(400, "bad_request", "an asset needs content")
        target = self._store(store)
        cap = self.limit_for(target)
        if cap and len(data) > cap:
            raise self._too_large(cap)
        digest = sha256(bytes(data))
        return self._record(digest, len(data), mime, by, owner_swarm, name, local_only, store,
                            lambda: target.put(digest, bytes(data)))

    def _record(self, digest, size, mime, by, owner_swarm, name, local_only, store, place):
        """The one placement-and-record step for both ways in (bytes, spool); `place()` writes the file into `store`."""
        mime = str(mime or "application/octet-stream").split(";")[0].strip().lower()[:100]
        target = self._store(store)
        existing = self.hive.db.one("SELECT * FROM assets WHERE sha256 = ?", (digest,))
        # Effective restriction = the new flag OR the stored one, checked before any write (OmegaReview 2026-10-04:
        # a duplicate put of a local-only file to a remote store leaked the bytes off the machine).
        if (local_only or (existing and existing["local_only"])) and target.kind != "local":
            raise self.hive.error(403, "local_only", "this asset must stay on this machine")
        place()
        if existing:
            placements = set(json.loads(existing["placements"])) | {store}
            history = json.loads(existing["history"])
            if owner_swarm and owner_swarm not in self.owners(digest):
                history.append({"at": now(), "by": by, "event": "owner_added", "owner_swarm": owner_swarm})
            self._add_owner(digest, owner_swarm, by, name)
            tighten = bool(local_only) and not existing["local_only"]
            if tighten:
                history.append({"at": now(), "by": by, "event": "local_only", "pending": self._remote(placements)})
            self.hive.db.execute("UPDATE assets SET placements = ?, history = ?, local_only = ? WHERE sha256 = ?",
                                 (json.dumps(sorted(placements)), json.dumps(history), int(bool(existing["local_only"]) or tighten), digest))
            if (existing["local_only"] or tighten) and self._remote(placements):
                # A local-only file's copies in other stores are removed, and a later put retries what is still pending. The
                # record keeps each copy until its delete succeeds. Inside a transaction (a publication) the deletes wait for
                # the commit, outside the connection lock but under placement, and never happen on rollback.
                self.hive.db.after_commit(lambda: self._cleanup(digest, by))
            out = self.view(self.row(digest))
            out["name"] = str(name or "")[:200] or self.owner_name(existing, owner_swarm) or self.neutral_name(mime)
            return out   # the uploader's own name, never the first owner's
        self.hive.db.execute("INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (digest, mime, size, str(name)[:200], owner_swarm, by, now(), int(bool(local_only)),
                              json.dumps([store]), json.dumps([{"at": now(), "by": by, "event": "stored", "store": store}])))
        self._add_owner(digest, owner_swarm, by, name)
        return self.view(self.row(digest))

    def cleanup(self, digest, by):
        """Retry removing a local-only file's copies in other stores (owner recovery: one attempt per store). Never call
        inside a database transaction: the deletes are remote calls."""
        with self._placement:
            return self._cleanup(str(digest), by)

    def _cleanup(self, digest, by):
        row = self.row(digest)
        placements, history = set(json.loads(row["placements"])), json.loads(row["history"])
        pending = self._remote(placements) if row["local_only"] else []
        if not pending:
            return self.view(row)
        removed, failed = [], {}
        for name in pending:
            try:
                if self.stores.get(name) is None:
                    raise LookupError("store not configured")
                self.stores[name].delete(digest)
            except Exception as exc:  # the copy stays recorded and pending; a later put or cleanup retries it
                failed[name] = str(exc)[:200] or type(exc).__name__
                continue
            placements.discard(name)
            removed.append(name)
        history.append({"at": now(), "by": by, "event": "local_only_cleanup", "removed": removed, "failed": failed})
        self.hive.db.execute("UPDATE assets SET placements = ?, history = ? WHERE sha256 = ?",
                             (json.dumps(sorted(placements)), json.dumps(history), digest))
        if failed:
            print(f"[hive] asset {digest} still in {', '.join(sorted(failed))} after local_only cleanup (pending, retried by a later put)")
        return self.view(self.row(digest))

    def _store(self, name):
        if name not in self.stores:
            raise self.hive.error(400, "bad_store", f"no store {name!r}; stores: {', '.join(self.stores)}")
        return self.stores[name]

    def read(self, digest):
        row = self.row(digest)
        if row["bytes"] > MEMORY_MAX_BYTES:
            raise self.hive.error(413, "too_large_to_load", "this file is too large to load whole; download it as a stream")
        for name in json.loads(row["placements"]):
            store = self.stores.get(name)
            data = store.get(digest) if store else None
            if data is not None:
                if sha256(data) != digest:
                    raise self.hive.error(500, "corrupt_asset", f"the copy in {name} does not match its hash")
                return row, data
        raise self.hive.error(404, "not_found", "no store holds this asset now")

    def stream(self, digest):
        """(row, size, chunks) for a file in the local store, read in CHUNK pieces and hashed as it goes; the size is
        checked against the record first, and a hash mismatch at the end raises (the connection is cut, so a client never
        takes a tampered file as complete). None when no local copy exists."""
        row = self.row(digest)
        local = [n for n in json.loads(row["placements"]) if getattr(self.stores.get(n), "kind", "") == "local"]
        for name in local:
            store = self.stores[name]
            size = store.size(digest)
            if size is None:
                continue
            if size != row["bytes"]:
                raise self.hive.error(500, "corrupt_asset", f"the copy in {name} does not match its record")
            path = store._path(digest)

            def chunks(path=path, name=name):
                # the last block is held back until the whole file has matched its hash, so a tampered copy never
                # reaches the client complete: it gets fewer bytes than Content-Length and a cut connection
                h, held = hashlib.sha256(), None
                with open(path, "rb") as f:
                    for block in iter(lambda: f.read(CHUNK), b""):
                        h.update(block)
                        if held is not None:
                            yield held
                        held = block
                if h.hexdigest() != digest:
                    raise RuntimeError(f"asset {digest} in {name} does not match its hash; stream cut before the end")
                if held is not None:
                    yield held
            return row, size, chunks()
        return None

    def transfer(self, digest, to, by, move=False):
        """Copy (or move) a file to another store; verified by hash on both ends; logged."""
        with self._placement:
            return self._transfer(digest, to, by, move)

    def _transfer(self, digest, to, by, move):
        row = self.row(digest)
        target = self._store(to)
        if row["local_only"] and target.kind != "local":
            raise self.hive.error(403, "local_only", "this asset must stay on this machine")
        cap = self.limit_for(target)
        if cap and row["bytes"] > cap:
            raise self._too_large(cap)
        _, data = self.read(digest)
        target.put(digest, data)
        check = target.get(digest)
        if check is None or sha256(check) != digest:
            raise self.hive.error(502, "transfer_unverified", "the copy could not be verified; nothing was removed")
        placements = set(json.loads(row["placements"])) | {to}
        removed = []
        if move:
            for name in list(placements - {to}):
                self.stores[name].delete(digest)
                placements.discard(name)
                removed.append(name)
        history = json.loads(row["history"]) + [{"at": now(), "by": by, "event": "moved" if move else "copied", "to": to, "removed": removed}]
        self.hive.db.execute("UPDATE assets SET placements = ?, history = ? WHERE sha256 = ?", (json.dumps(sorted(placements)), json.dumps(history), digest))
        return self.view(self.row(digest))

    # ---- who may read ------------------------------------------------------------------------------

    def agent_may_read(self, agent, digest, artifact_id=None, revision=None):
        row = self.row(digest)
        owners = self.owners(digest)
        if agent.get("swarm_id") and agent["swarm_id"] in owners:
            return True
        if artifact_id is None or revision is None:
            return False
        # a manifest can only grant files of its own swarm: anyone can write a hash into their own artifact
        # (found by OmegaDesign: a forged manifest listing another swarm's sha read that swarm's file)
        art = self.hive.collab.artifact(artifact_id)
        if art["owner_swarm"] not in owners:
            return False
        rev = self.hive.collab.read_revision(agent, artifact_id, int(revision))   # raises unless readable
        try:
            manifest = json.loads(rev["body"])
        except ValueError:
            return False
        listed = {o.get("sha256") for o in (manifest.get("originals") or []) + (manifest.get("previews") or []) if isinstance(o, dict)}
        return digest in listed

    def download_name(self, viewer, row):
        """The filename a download carries for this viewer: the one view_for shows them (a visible owner's own name),
        else the neutral 'file' + extension; never a hidden owner's (stand-in/Kimi r5 P1: Content-Disposition)."""
        view = self.view_for(viewer, row)
        return (view or {}).get("name") or self.neutral_name(row.get("mime"))

    def agent_download_name(self, agent, row):
        """For a mind's download: the name its own swarm put the file under, else the neutral name."""
        swarm = agent.get("swarm_id")
        if swarm and swarm in self.owners(row["sha256"]):
            return self.owner_name(row, swarm) or self.neutral_name(row.get("mime"))
        return self.neutral_name(row.get("mime"))

    @staticmethod
    def headers(row, name):
        mime = row["mime"]
        inline = mime in INLINE
        return {"Content-Type": mime if inline else "application/octet-stream",
                "Content-Disposition": content_disposition('inline' if inline else 'attachment', name or row['sha256'][:12]),
                "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
                "Cache-Control": "private, max-age=3600", "ETag": f"\"{row['sha256']}\"",
                # the stored type as recorded (Content-Type above stays octet-stream for anything not safe inline): a
                # mind's hive-asset-get reads it to show a text file's content (mind_files.py)
                "X-Hive-Asset-Type": mime}
