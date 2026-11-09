"""The local-owner hive (J1 installers, round J1b): a hive installed on one person's own computer.

Everything here is inert unless HIVE_LOCAL_OWNER=1 (set only by the J1 launchers). Design: PLATFORM_J1_INSTALLER_DESIGN
r2 A/B/C/F, r3 N, r4 KM3, r4.1 K-3 (internal review notes).

- The owner (r2 A, r3 K1, r4 KM3): on first boot one ``people`` row (admin, ``owner@local.invalid``, invited_by
  ``local-install``) is created and stored as the hive owner (``hive_owner.via = 'local-install'``, plus a log row).
- The control socket (r2 A): ``<data>/run/control.sock`` in a 0700 folder; a connection is served only when the peer's
  uid is this process's uid (LOCAL_PEERCRED on macOS, SO_PEERCRED on Linux). It reports the port and issues sign-in
  codes. No reusable credential exists anywhere.
- The sign-in code (r2 A): 256 random bits, valid 60 s, tied to this process's instance id, stored hashed, consumed
  atomically once (``UPDATE ... WHERE used = 0``), exchanged for a session of kind ``sso`` with the owner's principal.
- The browser boundary (r2 B, r3 K3/N): LocalBoundary is the outermost middleware: an exact Host allowlist (421),
  no ``?token=`` anywhere (400), any Origin must be this hive's own loopback origin, and a session-authenticated
  mutating request or the events socket must carry it.
- Start refusals (r2 C, r4.1 K-3): Google or family sign-in settings present, a public base path, a non-loopback
  bind, an unsandboxed mind setting, or a data folder open to group or others.
"""

from __future__ import annotations

import asyncio
import contextlib
import getpass
import hashlib
import json
import logging
import os
import pathlib
import re
import secrets
import socket
import stat
import struct
import sys
import time

from fastapi import Request   # module level: route annotations are resolved from module globals
from fastapi.responses import JSONResponse, Response

LOCAL_EMAIL = "owner@local.invalid"   # RFC 2606 .invalid: no Google account and no family sign-in can hold it (r4 KM3)
VIA = "local-install"
CODE_SECONDS = 60
SESSION_SECONDS = 30 * 86400
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")   # secrets.token_urlsafe(32): 256 bits
EXCHANGE_PATH = "/api/auth/local/exchange"
SIGNIN_PATH = "/local-signin"
SIGNIN_SCRIPT = "/local-signin.js"
EVENTS_PATH = "/api/events"
EVENTS_AUTH_SECONDS = 5.0
EVENTS_FRAME_MAX = 4096
CONTROL_LINE_MAX = 1024
MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})
QUERY_TOKEN_NAMES = frozenset({"token", "access_token"})
# r4.1 K-3: with any of these set there would be a second way to become a person here; the launcher never sets them
SIGNIN_SETTINGS = ("HIVE_SSO_USERS", "HIVE_SSO_LOGIN_URL", "HIVE_GOOGLE_CLIENT_ID", "HIVE_SIGNIN_DOMAINS")
# never public: a local-owner hive is reachable from this computer only
PUBLIC_SETTINGS = ("HIVE_BASE_PATH", "HIVE_PUBLIC_BASE")
LOOPBACK_BINDS = ("127.0.0.1", "localhost")
STATIC = pathlib.Path(__file__).resolve().parent / "localsignin"

SCHEMA = """CREATE TABLE IF NOT EXISTS local_signin_codes (
  code_hash TEXT PRIMARY KEY, instance TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL,
  used INTEGER NOT NULL DEFAULT 0)"""

log = logging.getLogger("hive")


class LocalOwnerRefused(RuntimeError):
    """The local-owner hive will not start (or a control-socket check failed): the message says why, plainly."""


def enabled(environ=None):
    environ = os.environ if environ is None else environ
    return environ.get("HIVE_LOCAL_OWNER", "").strip() == "1"


def _hash(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


# ---- start refusals and process hardening ---------------------------------------------------------------------------

def check_environment(environ=None):
    """r4.1 K-3 and r2 B: refuse to start with a second sign-in path, a public address, a non-loopback bind, or minds
    that would run without the OS sandbox."""
    environ = os.environ if environ is None else environ
    present = [name for name in SIGNIN_SETTINGS if environ.get(name, "").strip()]
    if present:
        raise LocalOwnerRefused("this is a local-owner hive (HIVE_LOCAL_OWNER=1), which has no Google or family sign-in; "
                                f"unset {', '.join(present)}")
    public = [name for name in PUBLIC_SETTINGS if environ.get(name, "").strip()]
    if public:
        raise LocalOwnerRefused(f"a local-owner hive is never public; unset {', '.join(public)}")
    host = environ.get("HIVE_HOST", "127.0.0.1").strip()
    if host not in LOOPBACK_BINDS:
        raise LocalOwnerRefused(f"a local-owner hive listens on 127.0.0.1 only, not {host!r} (HIVE_HOST)")
    # J1b r1.1 (stand-in r1.0 P1): the launcher's own reading, exactly "1"; a stripped " 1" once passed here and then
    # started minds unsandboxed, because drivers.py did not strip
    from ..supervisor.sandbox import mind_sandbox_requested
    if not mind_sandbox_requested(environ):
        raise LocalOwnerRefused("a local-owner hive runs every mind in the OS sandbox; HIVE_MIND_SANDBOX must be exactly "
                                f"1 (it is {environ.get('HIVE_MIND_SANDBOX')!r})")
    ports(environ)   # a malformed port, or the gateway's port equal to the hive's, refuses here, not at the first request
    check_sandbox_python(environ)


def check_sandbox_python(environ=None):
    """J1b r1.1 (Kimi r1.0 P2-4): HIVE_SANDBOX_PYTHON, when set, is the program every Linux mind and tool is launched
    with, so it must be one only root or this account can change: a regular file (lstat: not a link), owned by root
    or this uid, with no group or other write bit. The J1d installer installs it root-owned 0755."""
    environ = os.environ if environ is None else environ
    chosen = environ.get("HIVE_SANDBOX_PYTHON", "")
    if not chosen.strip():
        return
    if chosen != chosen.strip() or not os.path.isabs(chosen):
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON must be an absolute path with no spaces around it: {chosen!r}")
    try:
        st = os.lstat(chosen)
    except OSError as exc:
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} cannot be read ({exc.strerror})") from None
    if not stat.S_ISREG(st.st_mode):
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} must be a regular file, not a link or a folder")
    if st.st_uid not in (0, os.getuid()):
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} belongs to another account (uid {st.st_uid})")
    if st.st_mode & 0o022:
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} can be changed by other accounts "
                                f"(mode {stat.S_IMODE(st.st_mode):04o}); no group or other write bit is allowed")
    # J1b r1.2 (stand-in r1.1 P1): the file alone is not enough. Another account that can write any folder above it,
    # or swap a link on the way, can replace it after this check, and on Linux it runs before Landlock. So every
    # folder from / down must be a real folder (no link anywhere in the path), owned by root or this uid, with no
    # group or other write bit.
    # J1b r1.3 (stand-in r1.2 P1): the path checked must be the path executed. A "." or ".." part (or a doubled or
    # trailing slash) makes normpath differ from what the kernel walks, so it is refused outright: only the plain
    # canonical spelling is accepted, and it must also equal its realpath (no link anywhere).
    if chosen != os.path.normpath(chosen) or any(part in (".", "..") for part in chosen.split("/")):
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} must be written in its plain form, with no '.' or '..' "
                                "parts and no doubled or trailing slashes")
    if os.path.realpath(chosen) != chosen:
        raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON {chosen} has a link in its path; name the real file")
    folder = os.path.dirname(chosen)
    while True:
        try:
            dst = os.lstat(folder)
        except OSError as exc:
            raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON's folder {folder} cannot be read ({exc.strerror})") from None
        if not stat.S_ISDIR(dst.st_mode):
            raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON's folder {folder} is not a real folder")
        if dst.st_uid not in (0, os.getuid()) or dst.st_mode & 0o022:
            raise LocalOwnerRefused(f"HIVE_SANDBOX_PYTHON's folder {folder} can be changed by other accounts "
                                    f"(uid {dst.st_uid}, mode {stat.S_IMODE(dst.st_mode):04o})")
        parent = os.path.dirname(folder)
        if parent == folder:
            break
        folder = parent


def ports(environ=None):
    """The ports a browser or a mind may name in Host: the hive's own (HIVE_PORT) and, on Windows, the gateway's
    (HIVE_LOCAL_BROWSER_PORT, J1e; r4 ST2)."""
    environ = os.environ if environ is None else environ
    out = []
    for name, default in (("HIVE_PORT", "8700"), ("HIVE_LOCAL_BROWSER_PORT", "")):
        raw = (environ.get(name) or default).strip()
        if not raw:
            continue
        if not re.fullmatch(r"[0-9]{1,5}", raw) or not 1 <= int(raw) <= 65535:
            raise LocalOwnerRefused(f"{name} is not a port from 1 to 65535: {raw!r}")
        out.append(int(raw))
    if len(out) == 2 and out[0] == out[1]:   # J1b r1.1 (Kimi r1.0 P2-3): never collapse the two-port set silently
        raise LocalOwnerRefused(f"HIVE_LOCAL_BROWSER_PORT is the gateway's own port and must differ from HIVE_PORT "
                                f"(both are {out[0]})")
    return tuple(out)


def allowed_hosts(port_list):
    return frozenset(h for p in port_list for h in (f"127.0.0.1:{p}", f"localhost:{p}", f"[::1]:{p}"))


def allowed_origins(port_list):
    return frozenset(o for p in port_list for o in (f"http://127.0.0.1:{p}", f"http://localhost:{p}"))


def check_data_dir(path):
    """r2 C: the data folder is this account's alone: a real folder (not a link), owned by this uid, mode 0700 at most."""
    path = pathlib.Path(path)
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise LocalOwnerRefused(f"the data folder {path} cannot be read ({exc.strerror})") from None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise LocalOwnerRefused(f"the data folder {path} must be a real folder, not a link or a file")
    if st.st_uid != os.getuid():
        raise LocalOwnerRefused(f"the data folder {path} belongs to another account")
    if st.st_mode & 0o077:
        raise LocalOwnerRefused(f"the data folder {path} is open to other accounts (mode {stat.S_IMODE(st.st_mode):04o}); "
                                "it must be 0700")


def prepare_process():
    """Before anything is created (python -m hive, local-owner only): umask 077, no core dumps, not dumpable (Linux),
    and the one redactor on for logs and stdout/stderr (r2 C, r3 N, r2 F)."""
    os.umask(0o077)
    with contextlib.suppress(Exception):
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if sys.platform.startswith("linux"):
        with contextlib.suppress(Exception):
            import ctypes
            ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)   # PR_SET_DUMPABLE = 4, value 0
    from . import redact
    redact.enable()
    if not isinstance(sys.stdout, redact.ScrubbingStream):
        sys.stdout = redact.ScrubbingStream(sys.stdout)
    if not isinstance(sys.stderr, redact.ScrubbingStream):
        sys.stderr = redact.ScrubbingStream(sys.stderr)


# ---- peer credentials ------------------------------------------------------------------------------------------------

def peer_uid(sock):
    """The uid of the process at the other end of a connected Unix socket (getpeereid semantics)."""
    if sys.platform == "darwin":
        SOL_LOCAL, LOCAL_PEERCRED = 0, 0x001
        layout = "IIh16I"   # struct xucred: cr_version, cr_uid, cr_ngroups, cr_groups[16]
        raw = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, struct.calcsize(layout))
        version, uid = struct.unpack_from("II", raw)
        if version != 0:   # XUCRED_VERSION
            raise OSError("unexpected xucred version")
        return uid
    if sys.platform.startswith("linux"):
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
        return uid
    raise OSError("no peer credential check on this platform")


# ---- the owner, the codes, the control socket ------------------------------------------------------------------------

class LocalOwner:
    def __init__(self, settings, hive, environ=None):
        environ = os.environ if environ is None else environ
        self.settings, self.hive = settings, hive
        self.instance = secrets.token_hex(16)   # this process: a code from any earlier run of the hive is never accepted
        self.ports = ports(environ)
        self.port = self.ports[0]
        self.hosts = allowed_hosts(self.ports)
        self.origins = allowed_origins(self.ports)
        self.run_dir = pathlib.Path(settings.data_dir) / "run"
        self.socket_path = self.run_dir / "control.sock"
        self.server = None
        self.preflight = None   # the latest preflight receipt (hive/supervisor/preflight.py)
        self.principal = None
        hive.db.execute(SCHEMA)

    # the owner (r3 K1, r4 KM3) ----------------------------------------------------------------------------------------

    def ensure_owner(self):
        """First boot: one named admin person, stored as the hive owner via 'local-install'. Later boots: the same
        person. A hive whose stored owner is someone else is not silently taken over: start is refused."""
        from .db import new_id, now
        db = self.hive.db
        with db.transaction():
            person = db.one("SELECT * FROM people WHERE email = ?", (LOCAL_EMAIL,))
            if person is None:
                person = {"id": new_id("u"), "email": LOCAL_EMAIL, "name": _os_name()[:100], "role": "admin",
                          "invited_by": VIA, "created_at": now(), "disabled": 0}
                db.insert("people", person)
                log.warning("local owner: created the local owner person %s", person["id"])
            principal = f"user:{person['id']}"
            row = db.one("SELECT * FROM hive_owner WHERE id = 1")
            stamp = now()
            if row is None or row["owner"] == "user:operator":
                if row is None:
                    db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, ?, ?, ?)",
                               (principal, VIA, stamp, stamp))
                else:
                    db.execute("UPDATE hive_owner SET owner = ?, via = ?, set_at = ?, updated_at = ? WHERE id = 1",
                               (principal, VIA, stamp, stamp))
                db.execute("INSERT INTO hive_owner_log (at, previous, owner, by, reason) VALUES (?, ?, ?, ?, ?)",
                           (stamp, row["owner"] if row else None, principal, VIA, "first boot of a local-owner hive"))
                log.warning("local owner: %s is this hive's owner (via %s)", principal, VIA)
            elif row["owner"] != principal:
                raise LocalOwnerRefused("this hive already has an owner who is not this computer's local owner; "
                                        "a local-owner hive starts only on its own data folder")
            if (person.get("disabled") or person.get("role") != "admin") and person.get("invited_by") == VIA:
                # J1b r1.1 (Kimi r1.0 P2-2): the installer's own owner, still the stored owner, was disabled or demoted
                # (another admin can do that; people.py only blocks doing it to yourself). Refusing to start would
                # leave sqlite surgery as the only way back, so the row is restored, in the owner log and the hive log.
                was = "disabled" if person.get("disabled") else f"role {person.get('role')}"
                db.execute("UPDATE people SET disabled = 0, role = 'admin' WHERE id = ?", (person["id"],))
                db.execute("INSERT INTO hive_owner_log (at, previous, owner, by, reason) VALUES (?, ?, ?, ?, ?)",
                           (stamp, principal, principal, VIA, f"restored the local owner at boot (was {was})"))
                log.warning("local owner: restored the local owner %s at boot (was %s)", principal, was)
                person = db.one("SELECT * FROM people WHERE id = ?", (person["id"],))
        if person.get("disabled") or person.get("role") != "admin":
            raise LocalOwnerRefused("the local owner has been disabled or is no longer an admin")
        self.principal = principal
        return principal

    # the sign-in code (r2 A) ------------------------------------------------------------------------------------------

    def issue_code(self):
        code = secrets.token_urlsafe(32)
        at = time.time()
        db = self.hive.db
        with db.transaction():
            db.execute("DELETE FROM local_signin_codes WHERE expires_at <= ? OR used = 1", (at,))
            db.insert("local_signin_codes", {"code_hash": _hash(code), "instance": self.instance, "created_at": at,
                                             "expires_at": at + CODE_SECONDS, "used": 0})
        return {"code": code, "url": f"http://127.0.0.1:{self.port}{SIGNIN_PATH}#{code}", "expires_in": CODE_SECONDS}

    def consume(self, code):
        """True exactly once for a code this process issued in the last 60 s."""
        if not isinstance(code, str) or not CODE_RE.fullmatch(code):
            return False
        cur = self.hive.db.execute(
            "UPDATE local_signin_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND instance = ? AND expires_at > ?",
            (_hash(code), self.instance, time.time()))
        return cur.rowcount == 1

    def exchange(self, code):
        """A consumed code becomes a session of kind 'sso' for the owner (r4 KM3: the shape of app.py's sign-in)."""
        from .db import now
        from .hive import token_hash
        newhive = getattr(self.hive, "newhive", None)
        if newhive is not None:   # new-hive R1a: a bootstrap-purpose code becomes the attempt's sso-bootstrap bearer
            out = newhive.exchange(code)
            if out is not None:
                return None if out.get("refused") else out
        if not self.consume(code):
            return None
        person = self.hive.db.one("SELECT * FROM people WHERE id = ?", (self.principal[5:],))
        if person is None or person["disabled"] or person["role"] != "admin":
            return None
        token = secrets.token_urlsafe(32)
        expires = time.time() + SESSION_SECONDS
        self.hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                         "principal": self.principal, "expires_at": expires})
        return {"token": token, "expires_at": expires,
                "user": {"id": person["id"], "email": person["email"], "name": person["name"] or person["email"],
                         "role": person["role"]}}

    def is_session(self, token):
        from .hive import token_hash
        return bool(token) and self.hive.db.one("SELECT 1 AS one FROM sessions WHERE token_hash = ?", (token_hash(token),)) is not None

    def status(self):
        return {"local_owner": True, "instance": self.instance, "port": self.port, "pid": os.getpid(),
                "owner": self.principal, "preflight": self.preflight}

    # the control socket (r2 A) ----------------------------------------------------------------------------------------

    def _prepare_run_dir(self):
        self.run_dir.mkdir(mode=0o700, exist_ok=True)
        st = os.lstat(self.run_dir)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            raise LocalOwnerRefused(f"{self.run_dir} must be this account's own folder")
        os.chmod(self.run_dir, 0o700)
        with contextlib.suppress(FileNotFoundError):
            existing = os.lstat(self.socket_path)
            if not stat.S_ISSOCK(existing.st_mode):
                raise LocalOwnerRefused(f"{self.socket_path} exists and is not a socket")
            os.unlink(self.socket_path)
        if len(os.fsencode(str(self.socket_path))) >= 100:
            raise LocalOwnerRefused(f"the control socket path is too long for this system: {self.socket_path}")

    async def start(self):
        self._prepare_run_dir()
        old = os.umask(0o077)
        try:
            self.server = await asyncio.start_unix_server(self._serve, path=str(self.socket_path),
                                                          limit=CONTROL_LINE_MAX * 2)
        finally:
            os.umask(old)
        os.chmod(self.socket_path, 0o600)

    async def stop(self):
        if self.server is not None:
            self.server.close()
            with contextlib.suppress(Exception):
                await self.server.wait_closed()
            self.server = None
        with contextlib.suppress(OSError):
            if stat.S_ISSOCK(os.lstat(self.socket_path).st_mode):
                os.unlink(self.socket_path)

    def answer(self, request):
        """One control request (a JSON object with "op") -> one JSON answer. The caller already passed the uid check."""
        op = request.get("op") if isinstance(request, dict) else None
        if op == "hello":
            return dict(self.status(), ok=True)
        if op == "signin":
            if self.principal is None:
                return {"ok": False, "error": "no_owner"}
            return dict(self.issue_code(), ok=True)
        if op == "preflight":
            return {"ok": True, "preflight": self.preflight}
        newhive = getattr(self.hive, "newhive", None)
        if newhive is not None and isinstance(op, str) and op.startswith("bootstrap-"):
            out = newhive.answer(request)   # new-hive R1a: bootstrap-begin / -complete / -retire / -status
            if out is not None:
                return out
        return {"ok": False, "error": "unknown_op"}

    async def _serve(self, reader, writer):
        try:
            sock = writer.get_extra_info("socket")
            try:
                uid = peer_uid(sock)
            except OSError:
                uid = None
            if uid != os.getuid():
                log.warning("local owner: refused a control connection from uid %s", uid)
                return
            try:
                line = await asyncio.wait_for(reader.readline(), 5)
            except (asyncio.TimeoutError, ValueError, asyncio.LimitOverrunError):
                return
            if not line or len(line) > CONTROL_LINE_MAX:
                return
            try:
                request = json.loads(line)
            except ValueError:
                request = None
            # off the event loop: a bootstrap-begin verifies and prepares the installed source (r1.2.1 §1: never blocks Ask)
            answer = await asyncio.to_thread(self.answer, request)
            writer.write((json.dumps(answer) + "\n").encode())
            await writer.drain()
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()


def _os_name():
    try:
        import pwd
        gecos = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
        if gecos:
            return gecos
    except Exception:
        pass
    with contextlib.suppress(Exception):
        return getpass.getuser()
    return "Owner"


# ---- the browser boundary (r2 B) -------------------------------------------------------------------------------------

def _refusal(status, code, message):
    body = json.dumps({"error": {"code": code, "message": message}}).encode()
    return status, body


class LocalBoundary:
    """ASGI middleware, outermost: Host allowlist, no query tokens, Origin checks. Installed only when local."""

    def __init__(self, app, local: LocalOwner):
        self.app, self.local = app, local

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        refused = self.check(scope)
        if refused is not None:
            status, code, message = refused
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4403 if status == 403 else 4400})
                return
            status, body = _refusal(status, code, message)
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                    (b"cache-control", b"no-store")]})
            await send({"type": "http.response.body", "body": body})
            return
        return await self.app(scope, receive, send)

    def check(self, scope):
        headers = {}
        for name, value in scope.get("headers") or []:
            name = name.decode("latin-1").lower()
            if name in headers:   # a repeated Host, Origin or Authorization is never guessed between
                if name in ("host", "origin", "authorization"):
                    return 400, "duplicate_header", f"one {name} header only"
                continue
            headers[name] = value.decode("latin-1")
        host = headers.get("host")
        if host is None or host.lower() not in self.local.hosts:
            return 421, "wrong_host", "this hive answers only at its own local address"
        from urllib.parse import parse_qsl
        query = scope.get("query_string", b"").decode("latin-1")
        if any(k.lower() in QUERY_TOKEN_NAMES for k, _ in parse_qsl(query, keep_blank_values=True)):
            return 400, "query_token_refused", "send the token in the Authorization header, never in the address"
        origin = headers.get("origin")
        if origin is not None and origin not in self.local.origins:
            return 403, "origin_refused", "this request's Origin is not this hive"
        path = scope.get("path", "")
        if scope["type"] == "websocket":
            if path == EVENTS_PATH and origin is None:
                return 403, "origin_required", "the live events socket needs its Origin"
            return None
        if scope.get("method", "GET").upper() in MUTATING and origin is None:
            if path == EXCHANGE_PATH:
                return 403, "origin_required", "this request needs its Origin"
            auth = headers.get("authorization", "")
            token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
            if token and self.local.is_session(token):
                return 403, "origin_required", "this request needs its Origin"
        return None


# ---- the events socket's first-frame sign-in (r2 B3, r3 N) -----------------------------------------------------------

async def events_auth(ws, session_for):
    """Accept, then wait up to 5 s for one frame of at most 4 KiB: {"type": "auth", "token": "..."}. Returns the session,
    or None after closing the socket (4401 unauthorized, 1009 too big, 4408 too slow). Nothing is subscribed before."""
    await ws.accept()
    try:
        message = await asyncio.wait_for(ws.receive(), EVENTS_AUTH_SECONDS)
    except asyncio.TimeoutError:
        with contextlib.suppress(Exception):
            await ws.close(code=4408)
        return None
    except Exception:
        return None
    if message.get("type") != "websocket.receive":
        return None
    raw = message.get("text")
    if raw is None:
        data = message.get("bytes") or b""
        size = len(data)
        raw = None
    else:
        size = len(raw.encode("utf-8"))
    if size > EVENTS_FRAME_MAX:
        with contextlib.suppress(Exception):
            await ws.close(code=1009)
        return None
    session = None
    if raw is not None:
        try:
            frame = json.loads(raw)
        except ValueError:
            frame = None
        if isinstance(frame, dict) and frame.get("type") == "auth" and isinstance(frame.get("token"), str):
            session = session_for(frame["token"], ws.scope.get("hive_public", False))
    if session is None:
        with contextlib.suppress(Exception):
            await ws.close(code=4401)
        return None
    return session


# ---- the static sign-in page (r2 B5, r3 N) ---------------------------------------------------------------------------

SIGNIN_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; "
                               "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def install_routes(app, local: LocalOwner, hive, run_in_threadpool, operator):
    """The sign-in page, its script, and the code exchange. Registered only on a local-owner hive."""
    from .hive import HiveError

    @app.get(SIGNIN_PATH, include_in_schema=False)
    async def local_signin_page():
        return Response((STATIC / "local-signin.html").read_bytes(), media_type="text/html; charset=utf-8",
                        headers=SIGNIN_HEADERS)

    @app.get(SIGNIN_SCRIPT, include_in_schema=False)
    async def local_signin_script():
        return Response((STATIC / "local-signin.js").read_bytes(), media_type="text/javascript; charset=utf-8",
                        headers=SIGNIN_HEADERS)

    @app.post(EXCHANGE_PATH)
    async def local_exchange(request: Request):
        if request.headers.get("origin") not in local.origins:   # explicit, besides LocalBoundary (r3 N)
            raise HiveError(403, "origin_required", "this request needs this hive's Origin")
        ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise HiveError(415, "bad_content_type", "send application/json")
        raw = await request.body()
        if len(raw) > 1024:
            raise HiveError(413, "request_too_large", "this request is limited to 1024 bytes")
        try:
            data = json.loads(raw or b"null")
        except ValueError:
            data = None
        code = data.get("code") if isinstance(data, dict) else None
        out = await run_in_threadpool(local.exchange, code)
        if out is None:
            raise HiveError(401, "code_refused", "this sign-in link has expired or was already used; open OmegaHive again")
        if out.get("kind") == "sso-bootstrap":   # new-hive R1a: the setup helper's bearer, nothing else happens
            return JSONResponse(out, headers={"Cache-Control": "no-store"})
        if getattr(hive, "newhive", None) is not None:   # new-hive R1b-2: time to the person's first sign-in
            hive.newhive.note("first_signin_at")
        with contextlib.suppress(Exception):
            await run_in_threadpool(hive.personal.ensure_quietly, local.principal)
        return JSONResponse(out, headers={"Cache-Control": "no-store"})

    @app.get("/api/local/status")
    async def local_status(request: Request):
        """For the Welcome page (Surface): this hive is local-owner, who owns it, and the sandbox preflight's result.
        Any signed-in session of this hive may read it (it holds no secret)."""
        operator(request)
        out = local.status()
        out.pop("instance", None)
        newhive = getattr(hive, "newhive", None)
        if newhive is not None:   # new-hive R1a: plain setup state for the Welcome page (r1.2.1 §4 copy)
            out["coding"] = await run_in_threadpool(newhive.public_status)
        return JSONResponse(out, headers={"Cache-Control": "no-store"})
