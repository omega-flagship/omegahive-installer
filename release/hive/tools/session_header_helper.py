"""A Claude Code MCP ``headersHelper`` that reconnects a desktop session to this machine's hive as Dot or Surface.

Desktop sessions cannot be started by the launcher (``python -m hive.core.session_launch``), so their MCP server entry
runs this instead, with the standard library alone and by absolute path (``python -I``: no PYTHONPATH, no cwd imports)::

    "headersHelper": "/abs/python -I /abs/hive/tools/session_header_helper.py --socket /abs/<data_dir>/launch/session.sock"

Claude Code runs it fresh on every connect and reconnect, and again after a 401 during a tool call, with
CLAUDE_CODE_MCP_SERVER_NAME and CLAUDE_CODE_MCP_SERVER_URL in its environment. Each run:

1. maps the server name to one mind by a fixed table (``omegahive`` -> Dot, ``omegahive-surface`` -> Surface) and refuses
   any other name;
2. refuses unless the server URL is the hive's literal IPv4 loopback ``http://127.0.0.1:<port>/mcp``;
3. asks the hive's owner-local launch socket (served by this same OS account, checked by peer uid) for a new pending
   credential for that mind on this session's own binding (``sessions: per-binding``), which retires only this
   session's previous one. The binding is ``claude-mcp-<server>-<id>``, where <id> hashes the calling Claude process's
   pid and start time (``session_id``), so sessions sharing one config scope never take each other's credential;
4. activates it with ``hive_whoami`` under the intended identity, directly over loopback with no proxy (§R);
5. prints only ``{"Authorization": "Bearer ..."}`` on stdout.

The token lives in this process's memory and on stdout for Claude Code; it is never written to a file, argv or a log.
Any failure prints a short reason with no secret to stderr and exits non-zero, so Claude Code keeps the server flagged.
Everything finishes inside an 8-second budget (Claude Code allows 10).

``--check`` is the watcher's health probe: it takes a fresh credential on its own per-session binding
(``health-<server>``, so it never disconnects a working session), calls ``/mcp`` with it, and prints one line: ``OK`` or
``FAIL <reason>`` (``401`` when ``/mcp`` refused the fresh credential). Exit 0 for OK, 1 for FAIL. It repairs nothing:
Claude Code re-runs the helper itself on a 401.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MINDS = {"omegahive": "Dot", "omegahive-surface": "Surface"}   # fixed; no other server name gets a credential
BUDGET_SECONDS = 8
SOCKET_TIMEOUT = 3
HTTP_TIMEOUT = 3


SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "env"}
PS = next((p for p in ("/bin/ps", "/usr/bin/ps") if os.path.exists(p)), "/bin/ps")


class Refused(Exception):
    """A failure with a fixed, secret-free reason."""


def peer_uid(sock):
    """The uid at the other end of a connected unix socket (the same reading as hive.core.localowner.peer_uid)."""
    if sys.platform == "darwin":
        layout = "IIh16I"   # struct xucred
        raw = sock.getsockopt(0, 0x001, struct.calcsize(layout))   # SOL_LOCAL, LOCAL_PEERCRED
        version, uid = struct.unpack_from("II", raw)
        if version != 0:
            raise Refused("unexpected peer credential")
        return uid
    if sys.platform.startswith("linux"):
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        return struct.unpack("3i", raw)[1]
    raise Refused("no peer credential check on this platform")


def request_credential(socket_path, request, timeout=SOCKET_TIMEOUT):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(socket_path))
        if peer_uid(sock) != os.geteuid():
            raise Refused("the launch socket is not served by this account")
        sock.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
        chunks, total = [], 0
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > 1 << 20:
                raise Refused("the launch socket answer is too large")
            if chunk.endswith(b"\n"):
                break
    return json.loads(b"".join(chunks) or b"null")


def _ps(pid):
    """(ppid, start time, command name) of one process, read with ps in the C locale."""
    out = subprocess.run([PS, "-o", "ppid=,lstart=,comm=", "-p", str(int(pid))], capture_output=True, text=True,
                         timeout=2, env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}, check=True).stdout.strip()
    fields = out.split()
    if len(fields) < 7:
        raise Refused("cannot identify the calling session")
    return int(fields[0]), " ".join(fields[1:6]), os.path.basename(" ".join(fields[6:]))


def session_id(pid=None, ps=_ps):
    """A stable id for the Claude process that runs this helper: its pid and start time, hashed. Claude Code may run the
    helper through a shell, so shells (and env) between us and it are skipped; a reused pid has another start time."""
    pid = os.getppid() if pid is None else pid
    for _ in range(4):
        ppid, start, name = ps(pid)
        if name.lstrip("-") not in SHELLS or ppid <= 1:
            return hashlib.sha256(f"{pid}:{start}".encode()).hexdigest()[:16]
        pid = ppid
    raise Refused("cannot identify the calling session")


def literal_loopback(url):
    parts = urlsplit(str(url or ""))
    try:
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "http" and parts.hostname == "127.0.0.1" and parts.path == "/mcp" and not parts.username
            and not parts.password and not parts.query and not parts.fragment and port is not None)


# No proxy, ever: the token goes to 127.0.0.1 itself and nowhere else, whatever HTTP(S)_PROXY says.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(url, token, body, opener=None):
    """(status, parsed JSON or None). The token goes only into this request's header."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with (opener or _OPENER.open)(req, timeout=HTTP_TIMEOUT) as resp:
            status, raw = getattr(resp, "status", 200), resp.read(1 << 20)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, b""
        exc.close()
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


def whoami(url, token, opener=None):
    status, out = post(url, token, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                    "params": {"name": "hive_whoami", "arguments": {}}}, opener)
    if status == 401:
        raise Refused("401")
    if status != 200 or not isinstance(out, dict) or "result" not in out:
        raise Refused(f"identity check failed (HTTP {status})")
    return (out["result"] or {}).get("structuredContent") or {}


def issue(mind, server_url, socket_path, binding, replace, connect=request_credential, opener=None, per_binding=True):
    """Steps 3-4: a credential for ``mind``, activated by its own hive_whoami. Returns the token."""
    request = {"op": "bridge", "harness": "claude-code", "binding": binding, "replace": replace, "mind": mind}
    if per_binding:
        request["sessions"] = "per-binding"
    try:
        reply = connect(socket_path, request)
    except Refused:
        raise
    except Exception as exc:   # noqa: BLE001  (no socket, refused connection, timeout): the type only, never the text
        raise Refused(f"launch socket unavailable ({type(exc).__name__})") from None
    if not isinstance(reply, dict) or reply.get("status") != "issued":
        code = (reply or {}).get("code") if isinstance(reply, dict) else None
        raise Refused(f"the hive refused ({code if isinstance(code, str) and code.isidentifier() else 'no answer'})")
    token, name, mcp_url = reply.get("token"), reply.get("name"), reply.get("mcp_url")
    if not isinstance(token, str) or not token.startswith("ohb1_") or name != mind:
        raise Refused("the hive answered for a different mind")
    if not literal_loopback(mcp_url) or mcp_url != server_url:
        raise Refused("the hive's address is not this server's 127.0.0.1 URL; nothing was sent")
    try:
        me = whoami(mcp_url, token, opener)
    except Refused:
        raise
    except Exception as exc:   # noqa: BLE001
        raise Refused(f"identity check failed ({type(exc).__name__})") from None
    if me.get("name") != mind:
        raise Refused("identity check answered a different mind")
    return token


def _target(environ):
    server = environ.get("CLAUDE_CODE_MCP_SERVER_NAME", "")
    mind = MINDS.get(server)
    if mind is None:
        raise Refused("not a hive server this helper serves")
    url = environ.get("CLAUDE_CODE_MCP_SERVER_URL", "")
    if not literal_loopback(url):
        raise Refused("the server URL is not the hive's http://127.0.0.1:<port>/mcp")
    return server, mind, url


def _socket_arg(argv):
    if len(argv) >= 2 and argv[0] == "--socket" and os.path.isabs(argv[1]):
        return argv[1], argv[2:]
    raise Refused("usage: session_header_helper.py --socket /abs/launch/session.sock [--check]")


def helper(argv, environ, out, err, connect=request_credential, opener=None, ident=session_id):
    try:
        socket_path, rest = _socket_arg(argv)
        if rest:
            raise Refused("unexpected arguments")
        server, mind, url = _target(environ)
        token = issue(mind, url, socket_path, f"claude-mcp-{server}-{ident()}", True, connect, opener)
    except Refused as exc:
        print(f"omegahive header helper: {exc}", file=err)
        return 2
    except Exception as exc:   # noqa: BLE001  (never a traceback: it could carry a value)
        print(f"omegahive header helper: failed ({type(exc).__name__})", file=err)
        return 3
    out.write(json.dumps({"Authorization": "Bearer " + token}, separators=(",", ":")))
    out.flush()
    return 0


def check(argv, environ, out, connect=request_credential, opener=None):
    try:
        socket_path, rest = _socket_arg(argv)
        if rest != ["--check"]:
            raise Refused("unexpected arguments")
        server, mind, url = _target(environ)
        issue(mind, url, socket_path, "health-" + server, True, connect, opener)
    except Refused as exc:
        print(f"FAIL {exc}", file=out)
        return 1
    except Exception as exc:   # noqa: BLE001
        print(f"FAIL {type(exc).__name__}", file=out)
        return 1
    print(f"OK {mind}: /mcp accepted a fresh credential", file=out)
    return 0


def _deadline(*_):
    raise TimeoutError("budget")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _deadline)
        signal.alarm(BUDGET_SECONDS)
    if "--check" in argv:
        return check(argv, os.environ, sys.stdout)
    return helper(argv, os.environ, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
