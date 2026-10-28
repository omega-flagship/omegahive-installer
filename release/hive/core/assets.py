"""Binary assets: images, PDFs, decks, media, design originals and previews (R12).

Content-addressed: every file is its sha256, wherever it lives, so moving it never changes what it is and every read
and transfer is checked against the hash. Stores are pluggable:

- local: the hive's data directory (default; outside every mind's sandbox)
- s3:    any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO...), signed with SigV4 by the hive itself;
         credentials come from the hive's environment, never from minds

Configure extra stores with HIVE_ASSET_STORES='{"cloud": {"kind": "s3", "endpoint": "https://<acct>.r2.cloudflarestorage.com",
"bucket": "omegahive", "region": "auto", "key_env": "HIVE_S3_KEY", "secret_env": "HIVE_S3_SECRET"}}'.

Placement: a file marked local_only is refused by any non-local store (private app data stays on this machine).
Access follows the artifacts: the swarm that owns the file, admins, or a mind holding a live request on an artifact
revision whose manifest lists the file. Serving is safe: images and PDFs inline, anything else (HTML included) as a
download, always nosniff and a sandboxing content security policy.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import mimetypes
import threading
import os
import pathlib
import urllib.parse

import httpx

from .db import now

MAX_BYTES = 100 * 1024 * 1024
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

    def get(self, digest):
        path = self._path(digest)
        return path.read_bytes() if path.exists() else None

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
        self.http.delete(self.endpoint + path, headers=self._sign("DELETE", path, "UNSIGNED-PAYLOAD", {}))


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
        return [{"name": n, "kind": s.kind} for n, s in self.stores.items()]

    # ---- writing and reading ---------------------------------------------------------------------

    def put(self, data: bytes, mime, by, owner_swarm=None, name="", local_only=False, store="local"):
        with self._placement:
            return self._put(data, mime, by, owner_swarm, name, local_only, store)

    def _put(self, data, mime, by, owner_swarm, name, local_only, store):
        if not isinstance(data, (bytes, bytearray)) or not data:
            raise self.hive.error(400, "bad_request", "an asset needs content")
        if len(data) > MAX_BYTES:
            raise self.hive.error(413, "too_large", f"assets are limited to {MAX_BYTES // (1024 * 1024)} MB")
        mime = str(mime or "application/octet-stream").split(";")[0].strip().lower()[:100]
        target = self._store(store)
        digest = sha256(bytes(data))
        existing = self.hive.db.one("SELECT * FROM assets WHERE sha256 = ?", (digest,))
        # Effective restriction = the new flag OR the stored one, checked before any write (OmegaReview 2026-10-04:
        # a duplicate put of a local-only file to a remote store leaked the bytes off the machine).
        if (local_only or (existing and existing["local_only"])) and target.kind != "local":
            raise self.hive.error(403, "local_only", "this asset must stay on this machine")
        target.put(digest, bytes(data))
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
                             (digest, mime, len(data), str(name)[:200], owner_swarm, by, now(), int(bool(local_only)),
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
        for name in json.loads(row["placements"]):
            store = self.stores.get(name)
            data = store.get(digest) if store else None
            if data is not None:
                if sha256(data) != digest:
                    raise self.hive.error(500, "corrupt_asset", f"the copy in {name} does not match its hash")
                return row, data
        raise self.hive.error(404, "not_found", "no store holds this asset now")

    def transfer(self, digest, to, by, move=False):
        """Copy (or move) a file to another store; verified by hash on both ends; logged."""
        with self._placement:
            return self._transfer(digest, to, by, move)

    def _transfer(self, digest, to, by, move):
        row = self.row(digest)
        target = self._store(to)
        if row["local_only"] and target.kind != "local":
            raise self.hive.error(403, "local_only", "this asset must stay on this machine")
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
                "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename=\"{(name or row['sha256'][:12]).replace(chr(34), '')}\"",
                "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
                "Cache-Control": "private, max-age=3600", "ETag": f"\"{row['sha256']}\""}
