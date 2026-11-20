"""Sessions reconnect to the hive by themselves: the owner-local launch socket and the per-session launcher.

Session onboarding DESIGN_R2 §3 (per-session launcher), R2.1 §A (loopback hive, the owner's OS account), §R (strict launch,
pending credential, whoami first), §S/§U/§X (legacy retire), §Z. Credentials themselves live in credentials.py.

**The socket (hive side).** ``<data_dir>/launch/session.sock`` (``HIVE_SESSION_LAUNCH_SOCKET`` overrides; ``off`` disables),
owner-only, answering only a peer of the hive's own uid, and only on a loopback hive with no public base (R2.1 §A), with
one narrow opt-in exception for a loopback-bound hive that is also served through a reverse proxy (``socket_mode``). It is
the same hardened owner-local transport as the Code enrolment socket (code_local_enrolment.py), reused. One JSON line in,
one out. ``{"op": "bridge", "harness", "binding", "replace", "mind" | "ticket", "sessions"?}`` issues a pending bridged-session
credential: for an owner's launch ticket, or with no ticket for the two named exception minds (credentials.BRIDGE_EXCEPTION).
The token travels only in that reply.

**The launcher (session side).** ``python -m hive.core.session_launch --mind Dot -- <claude args>``:
1. asks the socket for a credential (the token stays in this process's memory);
2. verifies it with ``hive_whoami`` under the intended identity, which also activates it (§R: before the model's first prompt);
3. optionally (``--migrate-legacy``) retires the mind's old member credential: retire, whoami again, then confirm, or roll
   back (§U);
4. execs the harness in strict mode with exactly one hive server, the token only in its environment (§R):
   Claude Code ``--strict-mcp-config --mcp-config`` whose header reads ``${OMEGAHIVE_TOKEN_<MIND>}``; Codex
   ``--ignore-user-config -c mcp_servers.omegahive-<mind>.url=… -c …bearer_token_env_var=…``.
Nothing is written to any config file; the token is never printed, put in argv or saved.

**Desktop sessions** cannot be exec'd by the launcher. Their MCP entry runs ``hive/tools/session_header_helper.py`` as a
``headersHelper`` instead: the same steps 1-2 on every connect, then the bearer header on stdout for Claude Code alone.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import pathlib
import re
import socket
import sys
import urllib.request
import uuid
from urllib.parse import urlsplit

try:   # the launcher runs with the standard library alone; the hive side has FastAPI
    from fastapi import Request
except ImportError:   # pragma: no cover
    Request = None

ENV_SOCKET = "HIVE_SESSION_LAUNCH_SOCKET"
# The one opt-in for the launch socket on a hive that also has a public base (socket_mode); any other value is off.
ENV_PUBLIC_BASE = "HIVE_SESSION_LAUNCH_PUBLIC_BASE"
FULL, EXCEPTIONS_ONLY = "full", "bridge-exceptions"
SOCKET_NAME = "session.sock"
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def default_socket(data_dir):
    return pathlib.Path(data_dir) / "launch" / SOCKET_NAME


# ---- hive side ---------------------------------------------------------------------------------------------------------

def _loopback_only(settings, environ):
    """R2.1 §A: a signed-in hive on the person's own machine only when bound to loopback with no public base or tunnel."""
    if environ.get("HIVE_PUBLIC_BASE", "").strip() or environ.get("HIVE_BASE_PATH", "").strip():
        return False   # a public base or a reverse-proxy prefix: not a loopback-only hive
    host = urlsplit(settings.public_url or "").hostname or ""
    return host in LOOPBACK and environ.get("HIVE_HOST", "127.0.0.1") == "127.0.0.1"


def socket_mode(settings, environ):
    """What the launch socket may do on this hive: FULL, EXCEPTIONS_ONLY or None (no socket).

    R2.1 §A keeps the socket to a hive on the person's own machine: bound to loopback, with no public base or tunnel, so
    that "a process of the hive's own OS account" is the whole authority and nothing about it depends on a proxy. That
    stays the rule (FULL) and the default.

    The exception (EXCEPTIONS_ONLY): a hive that binds 127.0.0.1 but is *also* served to the outside by a reverse proxy
    (HIVE_PUBLIC_BASE / HIVE_BASE_PATH set) may run the socket when its owner opts in with
    ``HIVE_SESSION_LAUNCH_PUBLIC_BASE=bridge-exceptions``, and then only to issue credentials to the two named exception
    minds (credentials.BRIDGE_EXCEPTION) with no ticket. Tickets and every other mind are refused in this mode. Why it is
    safe: the proxy carries HTTP only and can never reach a unix socket; the socket is owner-only (0600 in a 0700 folder)
    and answers only a peer of the hive's own uid; the HTTP listener is still the IPv4 loopback alone (HIVE_HOST and
    HIVE_PUBLIC_URL are checked); what it issues is a read-only, mixed-context, /mcp-only credential, pending until its own
    hive_whoami, and RestrictedCredentialGate refuses every bridged-session credential on any request that arrived
    through the public base (credential_local_only), so a leaked one is useless from outside. Nothing an owner session or
    a ticket would grant is reachable here: the exception minds are bound by immutable id, as in FULL."""
    if _loopback_only(settings, environ):
        return FULL
    if environ.get(ENV_PUBLIC_BASE, "").strip() != EXCEPTIONS_ONLY:
        return None
    host = urlsplit(settings.public_url or "").hostname or ""
    if host in LOOPBACK and environ.get("HIVE_HOST", "127.0.0.1") == "127.0.0.1":
        return EXCEPTIONS_ONLY
    return None


ISSUE_RATE = (6, 60.0)   # at most 6 issues per mind per minute from the exception-mode socket


def _rate_ok(hive, mind):
    """A same-uid process can ask the socket in a loop; past ISSUE_RATE it gets rate_limited (429) for that mind."""
    import threading
    import time
    lock = hive.__dict__.setdefault("_session_launch_rate_lock", threading.Lock())
    with lock:
        seen = hive.__dict__.setdefault("_session_launch_rate", {})
        limit, window = ISSUE_RATE
        stamp = time.time()
        recent = [t for t in seen.get(mind, ()) if stamp - t < window]
        if len(recent) >= limit:
            seen[mind] = recent
            return False
        seen[mind] = recent + [stamp]
        return True


def answer(hive, settings, request, mode=FULL):
    """One launch request (already from a peer of the hive's own uid). Never echoes the request."""
    try:
        if (not isinstance(request, dict) or request.get("op") != "bridge"
                or set(request) - {"op", "harness", "binding", "replace", "mind", "ticket", "sessions"}
                or request.get("sessions", "per-mind") not in ("per-mind", "per-binding")
                or ("ticket" in request and "sessions" in request)
                or ("mind" in request) == ("ticket" in request)
                or not isinstance(request.get("harness"), str) or not isinstance(request.get("binding"), str)
                or not isinstance(request.get("replace", False), bool)):
            return {"status": "refused", "code": "bad_request"}
        if mode != FULL:   # socket_mode's exception: the named minds with no ticket, nothing else (fails closed)
            from .credentials import BRIDGE_EXCEPTION
            if mode != EXCEPTIONS_ONLY or "ticket" in request or request.get("mind") not in BRIDGE_EXCEPTION:
                return {"status": "refused", "code": "exceptions_only"}
            if request.get("replace") and request.get("sessions") != "per-binding":
                # a per-mind replace would disconnect the launcher's session; not from this mode
                return {"status": "refused", "code": "replace_refused"}
            if not _rate_ok(hive, request["mind"]):
                return {"status": "refused", "code": "rate_limited", "http_status": 429}
        creds, replace = hive.credentials, request.get("replace", False)
        if "ticket" in request:
            if not isinstance(request["ticket"], str) or not re.fullmatch(r"sb_[0-9a-f]{6,32}", request["ticket"]):
                return {"status": "refused", "code": "bad_request"}
            view, token = creds.redeem_ticket(request["ticket"], request["binding"], replace=replace)
        else:
            if not isinstance(request["mind"], str):
                return {"status": "refused", "code": "bad_request"}
            view, token = creds.exception_mind(request["mind"], request["harness"], request["binding"], replace=replace,
                                               per_session=request.get("sessions") == "per-binding")
        name = hive.db.one("SELECT name FROM agents WHERE id = ?", (view["agent_id"],))["name"]
        from .code_local_enrolment import _hive_url
        # the hive's own literal IPv4 loopback listener (never public_url: localhost or ::1 could be another user's port)
        return {"status": "issued", "token": token, "credential": view, "name": name, "mcp_url": _hive_url() + "/mcp"}
    except Exception as exc:   # noqa: BLE001  (a refusal carries its code only)
        code = getattr(exc, "code", None)
        if not isinstance(code, str):
            logging.getLogger("hive").warning("session launch: %s", type(exc).__name__)
            code = "internal_error"
        return {"status": "refused", "code": code}


def _socket_class():
    from .code_local_enrolment import CodeLocalEnrolment, _hive_url

    class SessionLaunchSocket(CodeLocalEnrolment):
        """The Code enrolment socket's hardened owner-local transport (owner-only folder and socket, single listener,
        peer uid == ours, bounded frames, nothing echoed), answering launch requests instead."""

        def __init__(self, hive, settings, path, mode=FULL):   # noqa: super().__init__ binds Code services; transport reused
            self.hive, self.settings, self.path, self.mode = hive, settings, pathlib.Path(path), mode
            self.hive_url = _hive_url()   # refuses anything but the IPv4 loopback listener
            self.hive_id, self.server, self._socket_identity, self._lock, self._clients = None, None, None, None, set()

        def _instance(self):
            return "session-launch"

        def answer(self, request):
            return answer(self.hive, self.settings, request, self.mode)

    return SessionLaunchSocket


@contextlib.asynccontextmanager
async def running(hive, settings, environ=None):
    environ = os.environ if environ is None else environ
    raw = environ.get(ENV_SOCKET, "").strip()
    hive.session_launch = None
    mode = socket_mode(settings, environ)
    if raw == "off" or mode is None:
        yield
        return
    path = pathlib.Path(raw) if raw else default_socket(settings.data_dir)
    try:
        if not raw:
            path.parent.mkdir(mode=0o700, exist_ok=True)
            os.chmod(path.parent, 0o700)
        bridge = _socket_class()(hive, settings, path, mode)
        await bridge.start()
        if mode != FULL:
            logging.getLogger("hive").info("session launch socket: named exception minds only (public base, %s)", ENV_PUBLIC_BASE)
    except Exception as error:   # noqa: BLE001  (never stops the hive; the admin view says unavailable)
        logging.getLogger("hive").warning("session launch socket unavailable (%s)", type(error).__name__)
        yield
        return
    hive.session_launch = bridge
    try:
        yield
    finally:
        hive.session_launch = None
        await bridge.stop()


def install_routes(app, hive, admin):
    from starlette.concurrency import run_in_threadpool
    creds = hive.credentials

    async def body(request):
        try:
            data = await request.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise hive.error(400, "bad_request", "expected a JSON object")
        return data

    @app.post("/api/admin/session-bridges")
    async def session_bridge_ticket(request: Request):
        """An owner's launch ticket for one mind (attach by agent_id). The person then runs the launcher with it."""
        principal = owner_only(request)   # R2 §3: owner-authorised
        data = await body(request)
        return await run_in_threadpool(creds.ticket, str(data.get("agent_id") or ""), str(data.get("harness") or "claude-code"),
                                       principal, data.get("mixed_context", True) is not False)

    def owner_only(request):
        session = admin(request)
        principal = session.get("principal") or "user:operator"
        if principal != hive.ownhive.owner():
            raise hive.error(403, "owner_only", "only the hive's owner manages session bridges")
        return principal

    @app.get("/api/admin/session-bridges")
    async def session_bridges(request: Request):
        owner_only(request)
        bridge = getattr(hive, "session_launch", None)
        return {"credentials": await run_in_threadpool(creds.list), "exception": await run_in_threadpool(creds.exception_view),
                "launch_socket": "ready" if bridge is not None and bridge.ready() else "unavailable"}

    @app.post("/api/admin/session-bridges/exception/end")
    async def session_bridge_exception_end(request: Request):
        """R2.1 §J / X-a: end the named exception; the migration tool stops existing."""
        principal = owner_only(request)
        return await run_in_threadpool(creds.end_exception, principal)

    @app.delete("/api/admin/session-bridges/{credential_id}")
    async def session_bridge_disconnect(credential_id: str, request: Request):
        owner_only(request)
        return await run_in_threadpool(creds.revoke, credential_id)


# ---- session side: the launcher --------------------------------------------------------------------------------------

def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "mind"


def env_name(name):
    return "OMEGAHIVE_TOKEN_" + re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")


def check_peer(sock):
    """Only a hive running as this same OS account may hand this launcher a credential."""
    from .localowner import peer_uid
    if peer_uid(sock) != os.geteuid():
        raise OSError("the launch socket is not served by this account")


def request_credential(socket_path, request, timeout=10):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(socket_path))
        check_peer(sock)
        chunks = []
        # A socket that refuses closes without reading the request. Linux reports that close as a reset, or as a broken
        # pipe when it comes before the request is sent, and macOS as end of file: each is a close with no answer.
        try:
            sock.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                if chunk.endswith(b"\n"):
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass
    return json.loads(b"".join(chunks) or b"null")


def literal_loopback(mcp_url):
    """The launcher sends the token only to the hive's literal IPv4 loopback listener."""
    parts = urlsplit(str(mcp_url or ""))
    return parts.scheme == "http" and parts.hostname == "127.0.0.1" and parts.path == "/mcp" and not parts.username


def safe_call(*args, **kwargs):
    """call_tool that never raises: a transport failure is an error answer, so a migration can always roll back."""
    try:
        return call_tool(*args, **kwargs)
    except Exception as exc:   # noqa: BLE001
        return None, {"code": "transport_" + type(exc).__name__}


# The token goes to 127.0.0.1 itself, never through a proxy, whatever HTTP(S)_PROXY says (an empty ProxyHandler
# replaces build_opener's environment-reading default and installs nothing).
_NO_PROXY_OPEN = urllib.request.build_opener(urllib.request.ProxyHandler({})).open


def call_tool(mcp_url, token, name, arguments=None, opener=_NO_PROXY_OPEN):
    """One MCP tools/call; returns (structuredContent, error data). The token goes only into the request header."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments or {}}}).encode()
    req = urllib.request.Request(mcp_url, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    with opener(req, timeout=15) as resp:
        out = json.loads(resp.read())
    if "error" in out:
        return None, out["error"].get("data") or {"code": "error"}
    return out["result"]["structuredContent"], None


def harness_argv(harness, name, mcp_url, extra):
    """The strict launch argv (§R). It names the environment variable, never the token."""
    server, var = "omegahive-" + slug(name), env_name(name)
    if harness == "codex":
        return ["codex", "--ignore-user-config", "-c", f"mcp_servers.{server}.url={json.dumps(mcp_url)}",
                "-c", f"mcp_servers.{server}.bearer_token_env_var={json.dumps(var)}", *extra]
    config = {"mcpServers": {server: {"type": "http", "url": mcp_url, "headers": {"Authorization": "Bearer ${" + var + "}"}}}}
    return ["claude", "--strict-mcp-config", "--mcp-config", json.dumps(config, separators=(",", ":")), *extra]


def launch(args, extra, out=sys.stdout, opener=_NO_PROXY_OPEN, execvpe=os.execvpe, connect=request_credential):
    harness = args.harness
    resumed = next((extra[i + 1] for i, a in enumerate(extra[:-1]) if a in ("--resume", "-r")), None)
    binding = args.session or resumed or str(uuid.uuid4())
    if harness == "claude-code" and not resumed and not any(a in ("--continue", "-c", "--session-id") for a in extra):
        extra = ["--session-id", binding, *extra]
    request = {"op": "bridge", "harness": harness, "binding": binding, "replace": bool(args.replace)}
    request.update({"ticket": args.ticket} if args.ticket else {"mind": args.mind})
    sock = args.socket or os.environ.get(ENV_SOCKET) or default_socket(
        args.data_dir or os.environ.get("HIVE_DATA_DIR") or pathlib.Path.home() / ".omegadots" / "hive")
    try:
        reply = connect(sock, request)
    except Exception as exc:   # noqa: BLE001  (no socket, or not this account's hive)
        reply = {"status": "refused", "code": "socket_" + type(exc).__name__}
    if not isinstance(reply, dict) or reply.get("status") != "issued":
        print(f"The hive did not connect this session ({(reply or {}).get('code', 'no answer')}).", file=out)
        return 2
    token, name, mcp_url = reply.pop("token"), reply["name"], reply["mcp_url"]
    if not literal_loopback(mcp_url):
        print("The hive named an address that is not this machine's 127.0.0.1; nothing was sent or launched.", file=out)
        return 4
    me, err = safe_call(mcp_url, token, "hive_whoami", opener=opener)
    if err or not me or me.get("name") != name:
        print(f"The hive's identity check failed ({(err or {}).get('code', 'wrong identity')}); nothing was launched.", file=out)
        return 3
    print(f"Connected to the hive as {name} (read-only bridge, credential {reply['credential']['id']}).", file=out)
    if args.migrate_legacy:
        state, err = safe_call(mcp_url, token, "hive_migrate_retire_legacy", {"op": "retire"}, opener=opener)
        again, err2 = (safe_call(mcp_url, token, "hive_whoami", opener=opener) if not err else (None, err))
        if err or err2 or not again or again.get("name") != name:
            back, err3 = safe_call(mcp_url, token, "hive_migrate_retire_legacy", {"op": "rollback"}, opener=opener)
            outcome = (back or {}).get("state")
            if not err3 and outcome in ("rolled_back", "none"):
                print("The old credential was not retired (any change was rolled back); both stay valid.", file=out)
            else:
                print(f"The migration stopped and its rollback did not confirm ({(err3 or {}).get('code') or outcome}); "
                      "rerun the launcher with --migrate-legacy to finish or roll back.", file=out)
        else:
            done, err4 = safe_call(mcp_url, token, "hive_migrate_retire_legacy", {"op": "confirm"}, opener=opener)
            if not err4 and (done or {}).get("state") == "done":
                print("The old member credential is retired. Remove its entry from the client config when convenient.", file=out)
            else:
                print("The old credential is retired but the migration was not confirmed; rerun with --migrate-legacy.", file=out)
    argv = harness_argv(harness, name, mcp_url, extra)
    env = dict(os.environ)
    env[env_name(name)] = token
    out.flush()
    execvpe(argv[0], argv, env)
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    extra = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1:]
    p = argparse.ArgumentParser(prog="python -m hive.core.session_launch",
                                description="Start an AI session connected to this machine's hive as one mind.")
    who = p.add_mutually_exclusive_group(required=True)
    who.add_argument("--mind", help="one of the named exception minds (Dot, Surface)")
    who.add_argument("--ticket", help="an owner's launch ticket id (sb_...)")
    p.add_argument("--harness", choices=("claude-code", "codex"), default="claude-code")
    p.add_argument("--data-dir", help="the hive's data folder (default HIVE_DATA_DIR or ~/.omegadots/hive)")
    p.add_argument("--socket", help="the launch socket (default <data-dir>/launch/session.sock)")
    p.add_argument("--session", help="bind to this provider session id (default: --resume's id, else a new one)")
    p.add_argument("--replace", action="store_true", help="disconnect the mind's other session first")
    p.add_argument("--migrate-legacy", action="store_true", help="retire the mind's old member credential once verified")
    return launch(p.parse_args(argv), extra)


if __name__ == "__main__":
    sys.exit(main())
