"""Person-owned Google consent, separate from People identity sign-in.

The host passes trusted session rows for person operations, and the live mind
owner string plus agent_id for an authenticated agent operation. Session rows are
re-read, never treated as durable authority. This service has no write operation,
generic Google dispatcher, policy override or implicit admin access to a token.
"""

from __future__ import annotations

import base64
import copy
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import pathlib
import re
import secrets
import stat
import threading
import time
import urllib.parse
from collections.abc import Mapping

from .google_backend import CALENDAR_SCOPE, CalendarPage, GoogleLibraryBackend
from .redact import register as register_secret

STATE_TTL = 600
MAX_PENDING = 128
MAX_INTERVAL = dt.timedelta(days=31)
MAX_LIMIT = 100
MAX_PAGES = 4
PAGE_SIZE = 50
DEFAULT_LIMIT = 20
MAX_STORE_BYTES = 2 * 1024 * 1024
CALLBACK_PATH = "/api/connectors/google/callback"
_SESSION_FIELDS = ("token_hash", "created_at", "kind", "principal", "expires_at", "signin_hash")
_RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\Z")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")


class GoogleConnectorError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _error(status, code, message):
    return GoogleConnectorError(status, code, message)


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text(value, maximum):
    return isinstance(value, str) and 0 < len(value) <= maximum


def _rfc3339(value):
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        raise _error(400, "invalid_query", "Calendar times must be timezone-aware RFC3339 values.")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError()
        return parsed
    except ValueError:
        raise _error(400, "invalid_query", "Calendar times must be timezone-aware RFC3339 values.") from None


class GoogleConnector:
    def __init__(self, hive, settings, backend=None, person_role=None):
        self.hive, self.settings = hive, settings
        self._person_role = person_role
        self.backend = backend if backend is not None else GoogleLibraryBackend()
        self._lock = threading.RLock()
        self._pending = {}  # one-use state hashes; verifiers never enter persistent storage
        self._read_locks = {}  # separate per-person I/O locks; disconnect never waits for these
        self._broken = False
        self._directory = pathlib.Path(settings.data_dir) / "google-connector"
        self._path = self._directory / "secrets.json"
        # This optional connector must not make an existing LAN/HTTP Hive fail
        # startup. Such a host can report status, but cannot configure or start
        # OAuth until its trusted public URL is secure.
        try:
            self.redirect_uri = self._callback(settings.public_url)
        except GoogleConnectorError:
            self.redirect_uri = None
        self._data = self._read()
        self._epochs = {owner: record["epoch"] for owner, record in self._data["people"].items()}
        register_secret(self._data["client"].get("client_secret"))
        for record in self._data["people"].values():
            register_secret(record.get("refresh_token"))

    @property
    def db(self):
        return self.hive.db

    @staticmethod
    def _callback(public_url):
        if not isinstance(public_url, str) or any(ord(c) <= 32 or ord(c) == 127 for c in public_url):
            raise _error(503, "invalid_public_url", "The hive public URL must be configured securely.")
        try:
            parsed = urllib.parse.urlsplit(public_url)
            port = parsed.port
        except ValueError:
            raise _error(503, "invalid_public_url", "The hive public URL must be configured securely.") from None
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or port == 0
                or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})):
            raise _error(503, "invalid_public_url", "The hive public URL must be configured securely.")
        return str(public_url).rstrip("/") + CALLBACK_PATH

    def _storage_error(self):
        return _error(503, "connector_storage", "The private Google connector store is unavailable.")

    def _check_directory(self, create=False):
        if create:
            self._directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = self._directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise self._storage_error()

    def _read(self):
        empty = {"version": 1, "client": {}, "people": {}}
        try:
            try:
                self._check_directory()
            except FileNotFoundError:
                return empty
            try:
                fd = os.open(self._path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            except FileNotFoundError:
                return empty
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                info = os.fstat(handle.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_STORE_BYTES):
                    raise self._storage_error()
                data = json.loads(handle.read(MAX_STORE_BYTES + 1))
            if (not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("client"), dict)
                    or not isinstance(data.get("people"), dict)):
                raise ValueError()
            client = data["client"]
            if client and (set(client) != {"client_id", "client_secret"}
                           or not _text(client["client_id"], 1024) or not _text(client["client_secret"], 4096)):
                raise ValueError()
            for owner, record in data["people"].items():
                if (not _text(owner, 256) or not owner.startswith("user:") or not isinstance(record, dict)
                        or set(record) != {"owner", "epoch", "refresh_token", "allowed_minds", "revocation"}
                        or record["owner"] != owner or type(record["epoch"]) is not int or record["epoch"] < 0
                        or not isinstance(record["allowed_minds"], list)
                        or len(record["allowed_minds"]) > 1000
                        or any(not _text(a, 128) for a in record["allowed_minds"])
                        or len(set(record["allowed_minds"])) != len(record["allowed_minds"])
                        or record["revocation"] not in {"confirmed", "unconfirmed", "not_needed"}
                        or (record["refresh_token"] is not None and not _text(record["refresh_token"], 16384))
                        or (not record["refresh_token"] and record["allowed_minds"])):
                    raise ValueError()
            return data
        except GoogleConnectorError:
            raise
        except (OSError, ValueError, TypeError, KeyError, UnicodeError):
            raise self._storage_error() from None

    def _save(self, candidate):
        """0600 from the first byte, exclusive temp, fsync, atomic replace, dir fsync."""
        tmp = self._path.with_name(".secrets." + secrets.token_hex(16) + ".tmp")
        fd = None
        try:
            body = json.dumps(candidate, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
            if len(body) > MAX_STORE_BYTES:
                raise self._storage_error()
            self._check_directory(create=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_CLOEXEC", 0), 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                fd = None
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self._path)
            directory = os.open(self._directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                                | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            self._data = candidate
        except (OSError, ValueError, GoogleConnectorError):
            self._broken = True  # never continue using an uncertain persisted grant
            raise self._storage_error() from None
        finally:
            if fd is not None:
                os.close(fd)
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                self._broken = True

    def _available(self):
        try:
            return self.backend.name == "B" and bool(self.backend.available)
        except Exception:
            return False

    def _ready(self):
        return bool(self.redirect_uri and self._data["client"]) and self._available() and not self._broken

    def _require_ready(self):
        if self._broken:
            raise self._storage_error()
        if self.redirect_uri is None:
            raise _error(503, "invalid_public_url", "The hive public URL must be configured securely.")
        if not self._ready():
            raise _error(503, "connector_unavailable", "The Google connector is not ready.")

    def _person(self, principal):
        if (not _text(principal, 128) or not principal.startswith("user:") or not principal[5:]
                or principal == "user:operator" or any(ord(c) < 32 or ord(c) == 127 for c in principal)):
            raise _error(401, "person_required", "Sign in as a current hive person.")
        person = self.db.one("SELECT id, role, disabled FROM people WHERE id = ?", (principal[5:],))
        if person is not None and (person.get("disabled") or person.get("role") not in {"admin", "member"}):
            raise _error(401, "person_required", "Sign in as a current hive person.")
        if principal.startswith("user:u_") and person is None:
            raise _error(401, "person_required", "Sign in as a current hive person.")
        if self._person_role is not None:
            try:
                role = self._person_role(principal)
            except Exception:
                role = None
            if (role not in {"admin", "member"}
                    or (principal.startswith("user:u_") and person is not None and role != person["role"])):
                raise _error(401, "person_required", "Sign in as a current hive person.")
        elif person is None:
            raise _error(401, "person_required", "Sign in as a current hive person.")
        return principal

    def _session(self, saved):
        if not isinstance(saved, Mapping) or not _text(saved.get("token_hash"), 256):
            raise _error(401, "session_changed", "The signed-in session changed; connect again.")
        current = self.db.one("SELECT * FROM sessions WHERE token_hash = ?", (saved["token_hash"],))
        if (current is None or any(current.get(k) != saved.get(k) for k in _SESSION_FIELDS)
                or current.get("kind") not in ("sso", "member_password") or type(current.get("expires_at")) not in {int, float}
                or not math.isfinite(current["expires_at"]) or current["expires_at"] <= time.time()):
            raise _error(401, "session_changed", "The signed-in session changed; connect again.")
        principal = self._person(current.get("principal"))
        if current["kind"] == "member_password" and not principal.startswith("user:u_"):
            raise _error(401, "session_changed", "The signed-in session changed; connect again.")
        signin_hash = current.get("signin_hash")
        if signin_hash:
            signin = self.db.one("SELECT person_id, expires_at FROM signins WHERE token_hash = ?", (signin_hash,))
            if (signin is None or signin.get("person_id") != principal[5:]
                    or type(signin.get("expires_at")) not in {int, float}
                    or not math.isfinite(signin["expires_at"]) or signin["expires_at"] <= time.time()):
                raise _error(401, "session_changed", "The signed-in session changed; connect again.")
        return principal

    def _principal(self, principal):
        return self._session(principal) if isinstance(principal, Mapping) else self._person(principal)

    def _mind(self, principal, agent_id):
        if not _text(agent_id, 128):
            raise _error(403, "mind_consent_required", "This mind has no current Google consent from its owner.")
        row = self.db.one("SELECT id, owner, deleted FROM agents WHERE id = ?", (agent_id,))
        if row is None or row.get("deleted") or row.get("owner") != principal:
            raise _error(403, "mind_consent_required", "This mind has no current Google consent from its owner.")
        return row

    def _epoch(self, principal):
        return self._epochs.get(principal, 0)

    def _record(self, principal):
        return self._data["people"].get(principal)

    def _status(self, principal):
        record = self._record(principal)
        connected = bool(record and record["refresh_token"] and not self._broken)
        allowed = []
        if connected:
            for agent_id in record["allowed_minds"]:
                try:
                    self._mind(principal, agent_id)
                except GoogleConnectorError:
                    continue
                allowed.append(agent_id)
        return {"ready": self._ready(), "connected": connected, "backend": "B",
                "allowed_minds": sorted(allowed), "calendar_scope": CALENDAR_SCOPE}

    def configure_client(self, client_id, client_secret):
        """The host's admin-only route owns authorization for this admin setting."""
        if self.redirect_uri is None:
            raise _error(503, "invalid_public_url", "The hive public URL must be configured securely.")
        if (not _text(client_id, 1024) or not _text(client_secret, 4096)
                or client_id != client_id.strip() or client_secret != client_secret.strip()
                or any(c.isspace() for c in client_id)):
            raise _error(400, "invalid_client", "A valid Google web client ID and secret are required.")
        register_secret(client_secret)
        client = {"client_id": client_id, "client_secret": client_secret}
        with self._lock:
            if self._broken:
                raise self._storage_error()
            if client != self._data["client"]:
                if any(record["refresh_token"] for record in self._data["people"].values()):
                    raise _error(409, "client_in_use", "Disconnect all Google accounts before changing the client.")
                self._pending.clear()
                candidate = copy.deepcopy(self._data)
                candidate["client"] = client
                self._save(candidate)
            return {"ready": self._ready(), "backend": "B", "calendar_scope": CALENDAR_SCOPE}

    def status(self, principal):
        with self._lock, self.db.transaction():
            try:
                owner = self._principal(principal)
            except GoogleConnectorError:
                # Password-only administrators may configure the web client but
                # cannot inherit any person's connection or consent.
                return {"ready": self._ready(), "connected": False, "backend": "B",
                        "allowed_minds": [], "calendar_scope": CALENDAR_SCOPE}
            return self._status(owner)

    def start(self, session, browser_nonce):
        if not isinstance(browser_nonce, str) or not 32 <= len(browser_nonce) <= 256:
            raise _error(400, "invalid_browser_binding", "A browser binding is required to connect Google.")
        with self._lock, self.db.transaction():
            self._require_ready()
            owner = self._session(session)
            at = time.time()
            self._pending = {key: value for key, value in self._pending.items()
                             if value["expires_at"] > at and value["owner"] != owner}
            if len(self._pending) >= MAX_PENDING:
                raise _error(429, "connector_busy", "Try connecting Google again later.")
            state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
            pending = {"owner": owner, "session": {k: session.get(k) for k in _SESSION_FIELDS},
                       "browser_hash": _hash(browser_nonce), "verifier": verifier,
                       "expires_at": at + STATE_TTL, "epoch": self._epoch(owner),
                       "client": dict(self._data["client"])}
            self._pending[_hash(state)] = pending
        try:
            url = self.backend.authorization_url(pending["client"], self.redirect_uri, state, verifier)
            parsed = urllib.parse.urlsplit(url)
            query = urllib.parse.parse_qs(parsed.query)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode().rstrip("=")
            if (parsed.scheme != "https" or parsed.netloc != "accounts.google.com"
                    or parsed.path != "/o/oauth2/v2/auth" or parsed.fragment
                    or query.get("state") != [state] or query.get("redirect_uri") != [self.redirect_uri]
                    or query.get("client_id") != [pending["client"]["client_id"]]
                    or query.get("response_type") != ["code"] or query.get("scope") != [CALENDAR_SCOPE]
                    or query.get("code_challenge_method") != ["S256"] or query.get("code_challenge") != [challenge]
                    or query.get("access_type") != ["offline"]):
                raise ValueError()
            with self._lock, self.db.transaction():
                self._session(pending["session"])
                if self._pending.get(_hash(state)) is not pending or self._epoch(owner) != pending["epoch"]:
                    raise _error(409, "connection_changed", "Google consent changed; connect again.")
            return {"authorization_url": url, "expires_at": pending["expires_at"]}
        except Exception as exc:
            with self._lock:
                self._pending.pop(_hash(state), None)
            if isinstance(exc, GoogleConnectorError):
                raise exc from None
            raise _error(502, "google_unavailable", "Google could not complete this request.") from None

    def _revoke(self, token):
        try:
            return "confirmed" if self.backend.revoke(token) is True else "unconfirmed"
        except Exception:
            return "unconfirmed"

    def complete(self, state, code, browser_nonce):
        if not _text(state, 256):
            raise _error(400, "invalid_state", "The Google connection request is invalid or expired.")
        with self._lock, self.db.transaction():
            pending = self._pending.pop(_hash(state), None)  # consumed even on binding/exchange failure
            if (pending is None or pending["expires_at"] <= time.time() or not _text(browser_nonce, 256)
                    or not hmac.compare_digest(pending["browser_hash"], _hash(browser_nonce))):
                raise _error(400, "invalid_state", "The Google connection request is invalid or expired.")
            self._require_ready()
            owner = self._session(pending["session"])
            if self._epoch(owner) != pending["epoch"] or pending["client"] != self._data["client"]:
                raise _error(409, "connection_changed", "Google consent changed; connect again.")
            if not _text(code, 4096):
                raise _error(400, "invalid_code", "The Google connection request is invalid or expired.")
        token = None
        try:
            result = self.backend.exchange(pending["client"], self.redirect_uri, state, code, pending["verifier"])
            if not isinstance(result, dict):
                raise ValueError()
            token = result.get("refresh_token")
            if not _text(token, 16384):
                raise ValueError()
            register_secret(token)
            if not isinstance(result.get("scopes"), (list, tuple)) or set(result["scopes"]) != {CALENDAR_SCOPE}:
                raise _error(403, "scope_refused", "Only Calendar read-only consent is supported.")
            with self._lock, self.db.transaction():
                self._require_ready()
                self._session(pending["session"])
                if self._epoch(owner) != pending["epoch"] or pending["client"] != self._data["client"]:
                    raise _error(409, "connection_changed", "Google consent changed; connect again.")
                candidate = copy.deepcopy(self._data)
                epoch = self._epoch(owner) + 1
                candidate["people"][owner] = {"owner": owner, "epoch": epoch, "refresh_token": token,
                                               "allowed_minds": [], "revocation": "not_needed"}
                self._save(candidate)
                self._epochs[owner] = epoch
                return self._status(owner)
        except Exception as exc:
            if token:
                self._revoke(token)  # never retain a token returned to a now-invalid session
            if isinstance(exc, GoogleConnectorError):
                raise exc from None
            raise _error(502, "google_unavailable", "Google could not complete this request.") from None
        finally:
            pending.pop("verifier", None)

    def grant_mind(self, principal, agent_id, allowed):
        if type(allowed) is not bool:
            raise _error(400, "invalid_consent", "Google mind consent must be a boolean.")
        with self._lock, self.db.transaction():
            self._require_ready()
            owner = self._principal(principal)
            self._mind(owner, agent_id)
            record = self._record(owner)
            if not record or not record["refresh_token"]:
                raise _error(409, "not_connected", "Connect your Google account first.")
            grants = set(record["allowed_minds"])
            grants.add(agent_id) if allowed else grants.discard(agent_id)
            if len(grants) > 1000:
                raise _error(409, "consent_limit", "The Google mind consent limit was reached.")
            candidate = copy.deepcopy(self._data)
            epoch = self._epoch(owner) + 1
            candidate["people"][owner].update(allowed_minds=sorted(grants), epoch=epoch)
            self._save(candidate)
            self._epochs[owner] = epoch
            return self._status(owner)

    def disconnect(self, principal):
        storage_error = None
        with self._lock, self.db.transaction():
            owner = self._principal(principal)
            if self._broken:
                raise self._storage_error()
            record = self._record(owner)
            token = record["refresh_token"] if record else None
            epoch = self._epoch(owner) + 1
            self._epochs[owner] = epoch  # independent in-memory fence before any provider call
            self._pending = {key: value for key, value in self._pending.items() if value["owner"] != owner}
            candidate = copy.deepcopy(self._data)
            candidate["people"][owner] = {"owner": owner, "epoch": epoch, "refresh_token": None,
                                           "allowed_minds": [], "revocation": "unconfirmed" if token else "not_needed"}
            try:
                self._save(candidate)
            except GoogleConnectorError as exc:
                storage_error = exc
                # Keep the local process fenced even if durable removal failed.
                self._data = candidate
        revocation = self._revoke(token) if token else "not_needed"
        if storage_error:
            raise storage_error from None
        with self._lock, self.db.transaction():
            # A concurrent reconnect gets a new epoch and is never overwritten.
            if self._epoch(owner) == epoch:
                candidate = copy.deepcopy(self._data)
                candidate["people"][owner]["revocation"] = revocation
                self._save(candidate)
            if self._principal(principal) != owner:
                raise _error(401, "session_changed", "The signed-in session changed; connect again.")
            result = self._status(owner)
            result["revocation"] = revocation
            return result

    def mind_allowed(self, agent):
        try:
            agent_id = agent.get("id") if isinstance(agent, Mapping) else agent
            with self._lock, self.db.transaction():
                self._require_ready()
                row = self.db.one("SELECT id, owner, deleted FROM agents WHERE id = ?", (agent_id,))
                if row is None or row.get("deleted"):
                    return False
                owner = self._person(row.get("owner"))
                record = self._record(owner)
                return bool(record and record["refresh_token"] and agent_id in record["allowed_minds"])
        except GoogleConnectorError:
            return False

    @staticmethod
    def _query(query):
        if not isinstance(query, dict) or set(query) - {"op", "time_min", "time_max", "limit"}:
            raise _error(400, "invalid_query", "A bounded Calendar read query is required.")
        if "op" in query and query["op"] != "calendar.read":
            raise _error(400, "unsupported_operation", "Only calendar.read is supported.")
        start, end = _rfc3339(query.get("time_min")), _rfc3339(query.get("time_max"))
        limit = query.get("limit", DEFAULT_LIMIT)
        if end <= start or end - start > MAX_INTERVAL or type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
            raise _error(400, "invalid_query", "Calendar reads allow at most 31 days and 1 to 100 items.")
        return query["time_min"], query["time_max"], limit

    @staticmethod
    def _event(raw):
        if not isinstance(raw, dict):
            raise ValueError()
        if raw.get("status") == "cancelled":
            return None, False
        values = []
        for key in ("start", "end"):
            value = raw.get(key)
            if not isinstance(value, dict):
                raise ValueError()
            stamp = value.get("dateTime") or value.get("date")
            if not isinstance(stamp, str):
                raise ValueError()
            if _DATE.fullmatch(stamp):
                dt.date.fromisoformat(stamp)
            else:
                _rfc3339(stamp)
            values.append(stamp)
        title = raw.get("summary", "")
        if not isinstance(title, str):
            raise ValueError()
        return ({"title": title[:200], "start": values[0], "end": values[1],
                 "busy": raw.get("transparency") != "transparent"}, len(title) > 200)

    def _read_guard(self, principal, owner, epoch, token, agent_id):
        self._require_ready()
        if self._principal(principal) != owner or self._epoch(owner) != epoch:
            raise _error(409, "connection_changed", "Google consent changed; try again.")
        record = self._record(owner)
        if not record or record["refresh_token"] != token:
            raise _error(409, "connection_changed", "Google consent changed; try again.")
        if agent_id is not None:
            self._mind(owner, agent_id)
            if agent_id not in record["allowed_minds"]:
                raise _error(403, "mind_consent_required", "This mind has no current Google consent from its owner.")

    def calendar_read(self, principal, query, agent_id=None):
        time_min, time_max, limit = self._query(query)
        # A bare principal is exclusively the authenticated-agent path. A human
        # read must carry its original host session for the post-I/O fence.
        if agent_id is None and not isinstance(principal, Mapping):
            raise _error(401, "session_required", "A current person session is required to read Calendar.")
        with self._lock, self.db.transaction():
            self._require_ready()
            owner = self._principal(principal)
            owner_lock = self._read_locks.setdefault(owner, threading.Lock())
        # Never wait for a provider-read lock while holding the store/DB lock.
        # A queued read takes its token snapshot only after the prior read has
        # persisted any rotation; unrelated people can read independently.
        with owner_lock:
            return self._calendar_read(principal, owner, time_min, time_max, limit, agent_id)

    def _calendar_read(self, principal, owner, time_min, time_max, limit, agent_id):
        with self._lock, self.db.transaction():
            self._require_ready()
            if self._principal(principal) != owner:
                raise _error(401, "session_changed", "The signed-in session changed; connect again.")
            record = self._record(owner)
            if not record or not record["refresh_token"]:
                raise _error(409, "not_connected", "Connect your Google account first.")
            epoch, token, client = self._epoch(owner), record["refresh_token"], dict(self._data["client"])
            self._read_guard(principal, owner, epoch, token, agent_id)
        events, page_token, seen_tokens, scanned = [], None, set(), 0
        truncated = False
        for page in range(MAX_PAGES):
            page_size = min(PAGE_SIZE, limit - scanned)
            if page_size <= 0:
                truncated = True
                break
            try:
                response = self.backend.calendar_page(client, token, time_min, time_max, page_token, page_size)
                # Recheck immediately after *each* I/O before processing or
                # requesting another page, and again at final publication.
                with self._lock, self.db.transaction():
                    self._read_guard(principal, owner, epoch, token, agent_id)
                    if (not isinstance(response, CalendarPage) or not isinstance(response.page, dict)
                            or not _text(response.refresh_token, 16384) or type(response.failed) is not bool):
                        raise ValueError()
                    if response.refresh_token != token:
                        register_secret(response.refresh_token)
                        candidate = copy.deepcopy(self._data)
                        candidate["people"][owner]["refresh_token"] = response.refresh_token
                        # Rotation changes no consent, owner or consent epoch.
                        self._save(candidate)
                        token = response.refresh_token
                    if response.failed:
                        raise _error(502, "google_unavailable", "Google could not complete this request.")
                result = response.page
                if not isinstance(result, dict) or not isinstance(result.get("items", []), list):
                    raise ValueError()
                items = result.get("items", [])
                if len(items) > page_size:
                    raise ValueError()
                for raw in items:
                    item, clipped = self._event(raw)
                    truncated = truncated or clipped
                    if item is not None:
                        events.append(item)
                scanned += len(items)
                next_page = result.get("nextPageToken")
                if next_page is not None and not _text(next_page, 2048):
                    raise ValueError()
                if not next_page:
                    break
                if next_page in seen_tokens:
                    raise ValueError()
                seen_tokens.add(next_page)
                page_token = next_page
                if scanned >= limit or page == MAX_PAGES - 1:
                    truncated = True
                    break
            except GoogleConnectorError:
                # _event's validation error is local response validation, not a
                # query error. Never expose upstream data or parser diagnostics.
                with self._lock, self.db.transaction():
                    self._read_guard(principal, owner, epoch, token, agent_id)
                raise _error(502, "google_unavailable", "Google could not complete this request.") from None
            except Exception:
                with self._lock, self.db.transaction():
                    self._read_guard(principal, owner, epoch, token, agent_id)
                raise _error(502, "google_unavailable", "Google could not complete this request.") from None
        with self._lock, self.db.transaction():
            self._read_guard(principal, owner, epoch, token, agent_id)
            return {"op": "calendar.read", "events": events, "truncated": truncated}
