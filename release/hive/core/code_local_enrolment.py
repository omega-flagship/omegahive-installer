"""Owner-local transport for the existing OmegaCode registration operation."""
from __future__ import annotations

import asyncio
import contextlib
import errno
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import time

from .localowner import peer_uid
from .services import LOCAL_CODE_ISSUER, LOCAL_CODE_REGISTRATION, ServiceError, _hash


ENV_SOCKET = "HIVE_CODE_LOCAL_ENROLMENT_SOCKET"
NAME = LOCAL_CODE_REGISTRATION["name"]
ADDRESS = LOCAL_CODE_REGISTRATION["address"]
MAX_LINE = 4096
MAX_CLIENTS = 8
ENROLMENT_TTL_MINUTES = 24 * 60
OPERATION = re.compile(r"[A-Za-z0-9_-]{16,128}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
HIVE_ID = re.compile(r"[0-9a-f]{32}")
REGISTRATION = {
    "service_id": re.compile(r"svc_(?:[0-9a-f]{8}|[0-9a-f]{32})"),
    "service_token": TOKEN,
    "operation_id": OPERATION,
    "request_digest": re.compile(r"[0-9a-f]{64}"),
}


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _decode(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate control field")
    return result


def _hive_url():
    # The same settings consumed by the production Hive entrypoint. An opted-in
    # Code daemon must bind this private socket's Hive to its own HTTP target.
    host = os.environ.get("HIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("HIVE_PORT", "8700"))
    if host != "127.0.0.1" or not 1 <= port <= 65535:
        raise ValueError("local Code enrolment requires the Hive's IPv4 loopback listener")
    return f"http://{host}:{port}"


class CodeLocalEnrolment:
    def __init__(self, services, path):
        self.services = services
        self.db = services.db
        self.path = Path(path)
        self.hive_url = _hive_url()
        self.hive_id = None
        self.server = None
        self._socket_identity = None
        self._lock = None
        self._clients = set()

    def _instance(self):
        # This identity belongs to the current DB, not its URL, the process,
        # the filesystem path, or the Hive's separate federation identity.
        with self.db.transaction():
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS code_local_enrolment_instance ("
                "id INTEGER PRIMARY KEY CHECK (id = 1), hive_id TEXT NOT NULL)"
            )
            row = self.db.one("SELECT hive_id FROM code_local_enrolment_instance WHERE id = 1")
            if row is None:
                value = secrets.token_hex(16)
                self.db.insert("code_local_enrolment_instance", {"id": 1, "hive_id": value})
                return value
            if not _matches(HIVE_ID, row["hive_id"]):
                raise ValueError("invalid local Code Hive identity")
            return row["hive_id"]

    def _fresh(self):
        return (self.db.one("SELECT id FROM services WHERE name = ? OR address = ?", (NAME, ADDRESS)) is None
                and self.db.one(
                    "SELECT id FROM service_enrolments WHERE name = ? AND (used_at IS NOT NULL OR expires_at > ?)",
                    (NAME, time.time())) is None)

    def _status(self, registration):
        with self.db.transaction():
            if registration is None:
                return "fresh" if self._fresh() else "hold"
            if (not isinstance(registration, dict) or registration.keys() != REGISTRATION.keys()
                    or not all(_matches(pattern, registration[key])
                               for key, pattern in REGISTRATION.items()
                               if key != "service_token" or registration[key] is not None)):
                return "hold"
            service_id = registration["service_id"]
            operation = self.db.one("SELECT * FROM service_operations WHERE operation_id = ?",
                                    (registration["operation_id"],))
            service = self.db.one("SELECT * FROM services WHERE id = ?", (service_id,))
            if operation is None and service is None and self._fresh():
                return "unrecognized"
            if (not operation or not service or operation["service_id"] != service_id
                    or operation["request_digest"] != registration["request_digest"]
                    or service["name"] != NAME or service["address"] != ADDRESS
                    or service["contract"] != LOCAL_CODE_REGISTRATION["contract"]
                    or self.db.one("SELECT id FROM services WHERE (name = ? OR address = ?) AND id != ?",
                                   (NAME, ADDRESS, service_id))):
                return "hold"
            token = registration["service_token"]
            if token is None:
                return "recognized" if service["enabled"] and operation["acked_at"] else "hold"
            try:
                self.services.operation(registration["operation_id"], token)
            except ServiceError:
                return "hold"
            if operation["acked_at"]:
                return "current" if service["enabled"] else "hold"
            enrolment = self.db.one("SELECT * FROM service_enrolments WHERE id = ?",
                                    (operation["enrolment_id"],))
            if (not service["enabled"] and operation["pending_token"] and enrolment
                    and enrolment["created_by"] == LOCAL_CODE_ISSUER + registration["operation_id"]
                    and enrolment["expires_at"] > time.time()):
                return "pending"
            return "hold"

    def _issue(self, operation, token):
        if not _matches(OPERATION, operation) or not _matches(TOKEN, token):
            return "hold"
        issuer = LOCAL_CODE_ISSUER + operation
        with self.db.transaction():
            row = self.db.one("SELECT * FROM service_enrolments WHERE token_hash = ?", (_hash(token),))
            if row is not None:
                if row["name"] != NAME or row["created_by"] != issuer:
                    return "hold"
                if row["used_at"] is None:
                    return "issued" if row["expires_at"] > time.time() else "hold"
                original = self.db.one(
                    "SELECT operation_id FROM service_operations WHERE enrolment_id = ?", (row["id"],))
                return "issued" if original and original["operation_id"] == operation else "hold"
            if (self.db.one("SELECT id FROM service_enrolments WHERE created_by = ?", (issuer,))
                    or self.db.one("SELECT operation_id FROM service_operations WHERE operation_id = ?", (operation,))
                    or not self._fresh()):
                return "hold"
            # Code already durably saved its token in the original journal.
            # The Host stores only its normal one-time token hash, so a lost
            # socket response can replay the exact request without new secrets.
            self.services.enrol(NAME, by=issuer, ttl_minutes=ENROLMENT_TTL_MINUTES, local_token=token)
            return "issued"

    def _wire(self, request):
        op, token = request["op"], request["token"]
        try:
            if not _matches(TOKEN, token):
                raise ServiceError(403, "local_code_enrolment", "invalid local Code credential")
            if op == "register":
                if not isinstance(request["body"], dict):
                    raise ServiceError(403, "local_code_enrolment", "invalid local Code registration")
                body = self.services.register(token, request["body"], "127.0.0.1", local_code=True)
            else:
                operation = request["operation_id"]
                if not _matches(OPERATION, operation):
                    raise ServiceError(403, "local_code_enrolment", "invalid local Code operation")
                if op == "ack":
                    body = self.services.acknowledge(operation, token, local_code=True)
                else:
                    body = self.services.operation(operation, token)
            return {"status": "wire", "hive_id": self.hive_id, "http_status": 200, "body": body}
        except ServiceError as error:
            return {"status": "wire", "hive_id": self.hive_id, "http_status": error.status,
                    "body": {"error": error.code}}

    def answer(self, request):
        status = "hold"
        if isinstance(request, dict):
            op = request.get("op")
            if op == "status" and request.keys() == {"op", "registration"}:
                status = self._status(request["registration"])
            elif request.get("hive_id") == self.hive_id:
                if op == "issue" and request.keys() == {"op", "hive_id", "operation_id", "token"}:
                    status = self._issue(request["operation_id"], request["token"])
                elif (op == "register" and request.keys() == {"op", "hive_id", "token", "body"}
                      or op in ("ack", "receipt") and request.keys() == {"op", "hive_id", "token", "operation_id"}):
                    return self._wire(request)
        reply = {"status": status, "hive_id": self.hive_id}
        if status != "issued":
            reply["hive_url"] = self.hive_url
        return reply

    def _owned_socket(self, info):
        return stat.S_ISSOCK(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1

    def ready(self):
        if self.server is None or not self.server.is_serving():
            return False
        try:
            info = self.path.lstat()
        except OSError:
            return False
        return (self._owned_socket(info) and stat.S_IMODE(info.st_mode) == 0o600
                and (info.st_dev, info.st_ino) == self._socket_identity)

    def _unlink(self, identity):
        try:
            current = self.path.lstat()
        except FileNotFoundError:
            return
        if (stat.S_ISSOCK(current.st_mode) and current.st_uid == os.geteuid()
                and (current.st_dev, current.st_ino) == identity):
            self.path.unlink()

    def _prepare_socket(self):
        parent = self.path.parent
        if (not self.path.is_absolute() or len(os.fsencode(self.path)) >= 100
                or parent.resolve(strict=True) != parent):
            raise ValueError("local Code socket needs a short physical absolute path")
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            raise ValueError("local Code socket needs an owner-only folder")
        for ancestor in parent.parents:
            info = ancestor.lstat()
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
                raise ValueError("local Code socket folder ancestry is not trusted")
        lock = os.open(parent / (self.path.name + ".lock"),
                       os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(lock)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.geteuid() or info.st_nlink != 1):
                raise ValueError("local Code socket lock is not owner-only")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(lock)
            raise
        self._lock = lock
        try:
            old = self.path.lstat()
        except FileNotFoundError:
            return
        if not self._owned_socket(old):
            raise ValueError("local Code socket path is occupied")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.25)
            if probe.connect_ex(str(self.path)) != errno.ECONNREFUSED:
                raise ValueError("local Code socket already has a listener")
        self._unlink((old.st_dev, old.st_ino))

    async def start(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._prepare_socket()
            self.hive_id = await asyncio.to_thread(self._instance)
            # Publish privately even if the process stops between bind and
            # validation. Restore the process mask before yielding the loop.
            previous = os.umask(0o177)
            try:
                sock.bind(str(self.path))
            finally:
                os.umask(previous)
            info = self.path.lstat()
            self._socket_identity = info.st_dev, info.st_ino
            if not self._owned_socket(info) or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("local Code socket is not owner-only")
            self.server = await asyncio.start_unix_server(self._serve, sock=sock, limit=MAX_LINE, start_serving=False)
            await self.server.start_serving()
        except BaseException:
            sock.close()
            with contextlib.suppress(Exception):
                await self.stop()
            raise

    async def stop(self):
        try:
            if self.server is not None:
                self.server.close()
                await self.server.wait_closed()
                self.server = None
            if self._clients:
                await asyncio.gather(*tuple(self._clients), return_exceptions=True)
        finally:
            try:
                if self._socket_identity is not None:
                    self._unlink(self._socket_identity)
                    self._socket_identity = None
            finally:
                if self._lock is not None:
                    os.close(self._lock)
                    self._lock = None

    async def _serve(self, reader, writer):
        task = asyncio.current_task()
        try:
            if self.server is None or not self.server.is_serving() or len(self._clients) >= MAX_CLIENTS:
                return
            self._clients.add(task)
            if peer_uid(writer.get_extra_info("socket")) != os.geteuid():
                return
            line = await asyncio.wait_for(reader.readuntil(b"\n"), 3)
            if len(line) > MAX_LINE:
                return
            request = json.loads(line, object_pairs_hook=_decode)
            answer = await asyncio.to_thread(self.answer, request)
            writer.write(json.dumps(answer, separators=(",", ":")).encode() + b"\n")
            await asyncio.wait_for(writer.drain(), 3)
        except Exception:
            # Neither malformed frames nor failures can echo credentials.
            return
        finally:
            self._clients.discard(task)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


@contextlib.asynccontextmanager
async def running(hive):
    path = os.environ.get(ENV_SOCKET)
    if not path:
        yield
        return
    hive.code_local_enrolment = None
    try:
        bridge = CodeLocalEnrolment(hive.services, path)
        await bridge.start()
    except Exception as error:
        logging.getLogger(__name__).warning("owner-local Code enrolment unavailable (%s); Code is held",
                                           type(error).__name__)
        yield
        return
    hive.code_local_enrolment = bridge
    try:
        yield
    finally:
        hive.code_local_enrolment = None
        await bridge.stop()
