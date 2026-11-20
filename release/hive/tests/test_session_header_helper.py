"""Desktop sessions reconnect by themselves: the launch socket's public-base exception (session_launch.socket_mode), the
local-only rule for bridged credentials (credentials.RestrictedCredentialGate), and the headersHelper
(hive/tools/session_header_helper.py).

Synthetic hives only; every token is minted by the test hive and never printed."""

import importlib.util
import io
import json
import os
import pathlib
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import types
import urllib.error
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from hive.core import credentials as cr
from hive.core import session_launch as sl
from hive.tests.test_core_api import PETTA, FakeSupervisor, client  # noqa: F401  (fixture)
from hive.tests.test_session_credentials import BINDING, rpc, tool

HELPER_PATH = pathlib.Path(__file__).resolve().parents[1] / "tools" / "session_header_helper.py"
_spec = importlib.util.spec_from_file_location("session_header_helper", HELPER_PATH)
hh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hh)

LOOP = types.SimpleNamespace(public_url="http://127.0.0.1:8700")
PUBLIC = {"HIVE_PUBLIC_BASE": "https://hive.example.invalid", "HIVE_BASE_PATH": "omegahive,omegadot", "HIVE_HOST": "127.0.0.1"}
OPT_IN = {sl.ENV_PUBLIC_BASE: "bridge-exceptions"}
URL = "http://127.0.0.1:8700/mcp"
ENV = {"CLAUDE_CODE_MCP_SERVER_NAME": "omegahive", "CLAUDE_CODE_MCP_SERVER_URL": URL}


LOOPBACK_HOST = "127.0.0.1:8700"


@pytest.fixture(autouse=True)
def _direct_loopback_host(request):
    """Bridged credentials are accepted only with Host 127.0.0.1:<HIVE_PORT>, which a real session always sends."""
    if "client" in request.fixturenames:
        request.getfixturevalue("client").headers["host"] = LOOPBACK_HOST


class _Resp:
    def __init__(self, body, status=200):
        self.body, self.status = body, status

    def read(self, *a):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(c, prefix="", extra=None, seen=None):
    """Route the helper's urllib requests into a TestClient; ``seen`` collects (url, headers) for each."""
    def open_(req, timeout):
        headers = dict(req.header_items()) | (extra or {})
        headers.setdefault("Authorization", "")
        if seen is not None:
            seen.append((req.full_url, headers))
        r = c.post(prefix + urlsplit(req.full_url).path, content=req.data, headers=headers)
        if r.status_code >= 400:
            raise urllib.error.HTTPError(req.full_url, r.status_code, "refused", {}, io.BytesIO(r.content))
        return _Resp(r.content, r.status_code)
    return open_


def short_dir():
    """A data folder short enough for a unix socket path (< 100 bytes), outside the session temp root; removed by the test."""
    return pathlib.Path(tempfile.mkdtemp(prefix="hs-", dir=os.path.realpath(os.environ.get("TMPDIR") or "/tmp"))).resolve()


def socket_for(hive, mode):
    return lambda path, request: sl.answer(hive, LOOP, request, mode)


# ---- the socket's public-base exception -------------------------------------------------------------------------------

def test_socket_mode_is_full_only_on_a_plain_loopback_hive_and_the_exception_needs_its_exact_opt_in():
    assert sl.socket_mode(LOOP, {}) == sl.FULL
    assert sl.socket_mode(LOOP, PUBLIC) is None                                          # §A unchanged by default
    assert sl.socket_mode(LOOP, PUBLIC | OPT_IN) == sl.EXCEPTIONS_ONLY
    assert sl.socket_mode(LOOP, {"HIVE_BASE_PATH": "omegahive"} | OPT_IN) == sl.EXCEPTIONS_ONLY
    for value in ("1", "yes", "true", "full", "Bridge-Exceptions", ""):
        assert sl.socket_mode(LOOP, PUBLIC | {sl.ENV_PUBLIC_BASE: value}) is None, value
    assert sl.socket_mode(LOOP, PUBLIC | OPT_IN | {"HIVE_HOST": "0.0.0.0"}) is None       # the listener stays loopback
    assert sl.socket_mode(types.SimpleNamespace(public_url="https://hive.example.invalid"), PUBLIC | OPT_IN) is None
    assert not sl._loopback_only(LOOP, PUBLIC | OPT_IN)                                 # §A's own reading is untouched


def test_the_exception_mode_issues_only_to_the_named_minds_with_no_ticket(client):
    hive = client.app.state.hive
    ask = lambda **r: sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, **r},  # noqa: E731
                                sl.EXCEPTIONS_ONLY)
    assert ask(mind="Dot", replace=True, sessions="per-binding")["status"] == "issued"
    assert ask(mind="Dot", replace=True) == {"status": "refused", "code": "replace_refused"}   # no per-mind replace here
    assert ask(mind="Surface", binding="0b5e5510-aaaa-4bbb-8ccc-000000000002")["status"] == "issued"
    for other in ("Omega", "dot", "Dot ", "Operator"):
        assert ask(mind=other) == {"status": "refused", "code": "exceptions_only"}, other
    swarm = client.post("/api/swarms", json={"name": "Alpha"}).json()
    agent = client.post("/api/agents", json={"name": "Helper", "swarm_id": swarm["id"]}).json()
    ticket = hive.credentials.ticket(agent["id"], "claude-code", "user:operator")
    assert ask(ticket=ticket["id"]) == {"status": "refused", "code": "exceptions_only"}
    assert hive.db.one("SELECT used_at FROM session_bridge_tickets")["used_at"] is None   # the ticket was not spent
    assert sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot"},
                     "something-else") == {"status": "refused", "code": "exceptions_only"}   # an unknown mode fails closed


def test_the_exception_socket_refuses_a_peer_of_another_uid(client, monkeypatch):
    """The real socket in exception mode answers a peer of the hive's own uid and closes on any other."""
    import asyncio
    from hive.core import code_local_enrolment as cle
    hive = client.app.state.hive
    data = short_dir()
    try:
        settings = types.SimpleNamespace(public_url="http://127.0.0.1:8700", data_dir=data)
        request = {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot", "replace": True,
                   "sessions": "per-binding"}

        async def run():
            async with sl.running(hive, settings, PUBLIC | OPT_IN):
                assert hive.session_launch is not None and hive.session_launch.mode == sl.EXCEPTIONS_ONLY
                path = sl.default_socket(data)
                ok = await asyncio.to_thread(hh.request_credential, path, request)
                ticket = await asyncio.to_thread(hh.request_credential, path, {**{k: v for k, v in request.items()
                                                                                    if k not in ("mind", "sessions")},
                                                                                 "ticket": "sb_abcdef"})
                monkeypatch.setattr(cle, "peer_uid", lambda sock: os.geteuid() + 1)
                other = await asyncio.to_thread(hh.request_credential, path, request)
                return ok, ticket, other
        ok, ticket, other = asyncio.run(run())
        assert ok["status"] == "issued" and ok["name"] == "Dot"
        assert ticket == {"status": "refused", "code": "exceptions_only"}
        assert other is None                                                         # closed with no answer
        async def off():
            async with sl.running(hive, settings, PUBLIC):
                return hive.session_launch, sl.default_socket(data).exists()
        assert asyncio.run(off()) == (None, False)                                   # no opt-in: no socket at all
    finally:
        shutil.rmtree(data, ignore_errors=True)


@pytest.mark.parametrize("closes", ["after the request arrives", "before the request is sent"])
@pytest.mark.parametrize("copy", ["helper", "launcher"])
def test_a_socket_that_closes_without_reading_the_request_is_no_answer(copy, closes, monkeypatch):
    """omega-flagship/omegahive#285: a refusing socket closes with the request unread. Linux reports that as a reset, or
    as a broken pipe when the close comes first, and macOS as end of file; both copies read each as no answer."""
    from hive.core import localowner
    fn, owner = (hh.request_credential, hh) if copy == "helper" else (sl.request_credential, localowner)
    data = short_dir()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        path = data / "s.sock"
        server.bind(str(path))
        server.listen(1)
        closed = threading.Event()

        def refuse():
            conn, _ = server.accept()
            if closes == "after the request arrives":
                select.select([conn], [], [], 5)                                 # the request waits unread
            conn.close()
            closed.set()

        refuser = threading.Thread(target=refuse)
        refuser.start()
        if closes == "before the request is sent":
            real = owner.peer_uid                                                # checked just before the send
            monkeypatch.setattr(owner, "peer_uid", lambda sock: (closed.wait(5), real(sock))[1])
        assert fn(path, {"op": "bridge"}) is None
        refuser.join(5)
        assert closed.is_set()
    finally:
        server.close()
        shutil.rmtree(data, ignore_errors=True)


# ---- credentials issued this way: read-only, /mcp only, loopback only ----------------------------------------------

def test_a_helper_credential_is_read_only_mcp_only_and_refused_through_the_public_base(client):
    hive = client.app.state.hive
    out, err = io.StringIO(), io.StringIO()
    assert hh.helper(["--socket", "/x/session.sock"], ENV, out, err, socket_for(hive, sl.EXCEPTIONS_ONLY),
                     opener_for(client)) == 0, err.getvalue()
    token = json.loads(out.getvalue())["Authorization"].removeprefix("Bearer ")
    row = hive.db.one("SELECT * FROM agent_credentials WHERE status = 'active'")
    assert row["mixed_context"] == 1 and row["per_session"] == 1                        # whoami activated it (§R)
    assert row["binding_id"] == "claude-mcp-omegahive-" + hh.session_id()
    assert tool(client, token, "hive_inbox")[0] is None                                    # reads work
    assert tool(client, token, "hive_send", {"text": "x"}) == ("mixed_context_refused", None)
    assert client.get("/api/agents", headers={"Authorization": f"Bearer {token}"}).status_code == 403
    for header in ("X-Forwarded-For", "Cf-Ray", "Cf-Connecting-Ip"):                         # came through the proxy
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        headers={"Authorization": f"Bearer {token}", header: "203.0.113.9"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "credential_local_only", header
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    headers={"X-Hive-Token": token, "Authorization": "", "X-Forwarded-For": "203.0.113.9"})
    assert r.status_code == 403
    assert rpc(client, token, "tools/list").status_code == 200                               # direct loopback: accepted


@pytest.fixture()
def public_hive(monkeypatch):
    """A synthetic hive configured like the Mac one: loopback bind, a public base and reverse-proxy prefixes, the opt-in."""
    for k, v in (PUBLIC | OPT_IN | {"HIVE_ASK_CONDUCTOR": "0", "HIVE_CODE_CONTROLLER_ENGINE": "0"}).items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv(sl.ENV_SOCKET, raising=False)
    from hive.core.app import create_app
    from hive.core.config import load_settings
    data = short_dir()
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA)
    try:
        with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0), base_url="http://" + LOOPBACK_HOST) as c:
            c.data_dir = data
            yield c
    finally:
        shutil.rmtree(data, ignore_errors=True)


def test_end_to_end_on_a_public_base_hive_the_real_socket_issues_and_the_prefix_refuses(public_hive):
    c = public_hive
    hive = c.app.state.hive
    assert hive.session_launch is not None and hive.session_launch.ready()
    sock = str(sl.default_socket(c.data_dir))
    seen = []
    out, err = io.StringIO(), io.StringIO()
    assert hh.helper(["--socket", sock], ENV, out, err, opener=opener_for(c, seen=seen)) == 0, err.getvalue()
    header = json.loads(out.getvalue())
    assert list(header) == ["Authorization"] and header["Authorization"].startswith("Bearer ohb1_")
    token = header["Authorization"][7:]
    assert [u for u, _ in seen] == [URL] and token not in err.getvalue()
    for prefix in ("/omegahive", "/omegadot"):
        r = c.post(prefix + "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                   headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "credential_local_only", prefix
    assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                  headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # a reconnect of the same session retires its own previous credential; the old one is now a 401
    out2 = io.StringIO()
    assert hh.helper(["--socket", sock], ENV, out2, io.StringIO(), opener=opener_for(c)) == 0
    assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                  headers={"Authorization": f"Bearer {token}"}).status_code == 401
    # another session in the same config scope gets its own Dot credential and takes nothing from this one
    other = io.StringIO()
    assert hh.helper(["--socket", sock], ENV, other, io.StringIO(), opener=opener_for(c), ident=lambda: "0123456789abcdef") == 0
    for h in (json.loads(out2.getvalue()), json.loads(other.getvalue())):
        assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=h).status_code == 200
    # Surface on its own server name; a ticket over the real socket is refused in this mode
    out3 = io.StringIO()
    env = {"CLAUDE_CODE_MCP_SERVER_NAME": "omegahive-surface", "CLAUDE_CODE_MCP_SERVER_URL": URL}
    assert hh.helper(["--socket", sock], env, out3, io.StringIO(), opener=opener_for(c)) == 0
    assert {r["name"] for r in hive.db.all("SELECT a.name FROM agent_credentials k JOIN agents a ON a.id = k.agent_id "
                                           "WHERE k.status = 'active'")} == {"Dot", "Surface"}
    assert hh.request_credential(sock, {"op": "bridge", "harness": "claude-code", "binding": BINDING,
                                        "ticket": "sb_abcdef"}) == {"status": "refused", "code": "exceptions_only"}
    # the health check uses its own binding and never disconnects a working session
    line = io.StringIO()
    assert hh.check(["--socket", sock, "--check"], ENV, line, opener=opener_for(c)) == 0
    assert line.getvalue().startswith("OK Dot")
    assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                  headers=json.loads(out2.getvalue())).status_code == 200


# ---- the helper's own contract ------------------------------------------------------------------------------------

def test_helper_prints_only_the_header_and_activates_with_whoami():
    token = "ohb1_" + "s" * 43
    calls = []

    def connect(path, request):
        calls.append(("socket", path, request))
        return {"status": "issued", "token": token, "name": "Surface", "mcp_url": URL, "credential": {"id": "cr_1"}}

    def opener(req, timeout):
        calls.append(("http", req.full_url, json.loads(req.data)["params"]["name"], req.get_header("Authorization")))
        return _Resp(json.dumps({"result": {"structuredContent": {"name": "Surface"}}}).encode())

    out, err = io.StringIO(), io.StringIO()
    env = {"CLAUDE_CODE_MCP_SERVER_NAME": "omegahive-surface", "CLAUDE_CODE_MCP_SERVER_URL": URL}
    assert hh.helper(["--socket", "/s/session.sock"], env, out, err, connect, opener, ident=lambda: "feedc0de00000001") == 0
    assert json.loads(out.getvalue()) == {"Authorization": "Bearer " + token} and err.getvalue() == ""
    assert calls[0] == ("socket", "/s/session.sock", {"op": "bridge", "harness": "claude-code", "replace": True,
                                                      "binding": "claude-mcp-omegahive-surface-feedc0de00000001",
                                                      "mind": "Surface", "sessions": "per-binding"})
    assert calls[1] == ("http", URL, "hive_whoami", "Bearer " + token)


@pytest.mark.parametrize("case", ["unknown_server", "no_server", "public_url", "localhost_url", "https_url",
                                  "socket_refused", "socket_missing", "wrong_mind", "other_address", "whoami_401",
                                  "whoami_other", "whoami_down", "bad_args", "relative_socket"])
def test_helper_failures_exit_non_zero_with_nothing_on_stdout_and_no_secret_on_stderr(case):
    token = "ohb1_" + "z" * 43
    env, argv = dict(ENV), ["--socket", "/s/session.sock"]
    reply = {"status": "issued", "token": token, "name": "Dot", "mcp_url": URL, "credential": {"id": "cr_1"}}
    who = {"name": "Dot"}
    connect = lambda p, r: reply  # noqa: E731
    http_status = 200
    if case == "unknown_server":
        env["CLAUDE_CODE_MCP_SERVER_NAME"] = "omegahive-omega"
    elif case == "no_server":
        env = {}
    elif case == "public_url":
        env["CLAUDE_CODE_MCP_SERVER_URL"] = "https://hive.example.invalid/omegahive/mcp"
    elif case == "localhost_url":
        env["CLAUDE_CODE_MCP_SERVER_URL"] = "http://localhost:8700/mcp"
    elif case == "https_url":
        env["CLAUDE_CODE_MCP_SERVER_URL"] = "https://127.0.0.1:8700/mcp"
    elif case == "socket_refused":
        connect = lambda p, r: {"status": "refused", "code": "already_bridged"}  # noqa: E731
    elif case == "socket_missing":
        def connect(p, r):
            raise FileNotFoundError("no socket at " + token)                       # even a message with a secret
    elif case == "wrong_mind":
        reply["name"] = "Surface"
    elif case == "other_address":
        reply["mcp_url"] = "http://127.0.0.1:9999/mcp"
    elif case == "whoami_401":
        http_status = 401
    elif case == "whoami_other":
        who = {"name": "Surface"}
    elif case == "whoami_down":
        http_status = None
    elif case == "bad_args":
        argv = ["--socket", "/s/session.sock", "--extra"]
    elif case == "relative_socket":
        argv = ["--socket", "session.sock"]
    sent = []

    def opener(req, timeout):
        sent.append(req.full_url)
        if http_status is None:
            raise ConnectionRefusedError("down " + token)
        if http_status != 200:
            raise urllib.error.HTTPError(req.full_url, http_status, token, {}, io.BytesIO(token.encode()))
        return _Resp(json.dumps({"result": {"structuredContent": who}}).encode())

    out, err = io.StringIO(), io.StringIO()
    assert hh.helper(argv, env, out, err, connect, opener) != 0
    assert out.getvalue() == "" and token not in err.getvalue() and err.getvalue().count("\n") == 1
    if case in ("unknown_server", "no_server", "public_url", "localhost_url", "https_url", "socket_refused",
                "socket_missing", "wrong_mind", "other_address", "bad_args", "relative_socket"):
        assert sent == []                                                            # the token went nowhere


def test_the_helper_runs_standalone_under_python_isolated_mode():
    """python -I by absolute path, from an unrelated cwd: stdlib only, and a refusal is a non-zero exit, stdout empty."""
    env = {"PATH": os.environ.get("PATH", ""), "HOME": tempfile.gettempdir(),
           "CLAUDE_CODE_MCP_SERVER_NAME": "omegahive", "CLAUDE_CODE_MCP_SERVER_URL": URL}
    missing = str(pathlib.Path(tempfile.gettempdir()).resolve() / "no-such-hive" / "session.sock")
    r = subprocess.run([sys.executable, "-I", str(HELPER_PATH), "--socket", missing], env=env, cwd=tempfile.gettempdir(),
                       capture_output=True, text=True, timeout=20)
    assert r.returncode != 0 and r.stdout == "" and "launch socket unavailable" in r.stderr
    r = subprocess.run([sys.executable, "-I", str(HELPER_PATH), "--socket", missing, "--check"], env=env,
                       cwd=tempfile.gettempdir(), capture_output=True, text=True, timeout=20)
    assert r.returncode == 1 and r.stdout.startswith("FAIL ")
    src = HELPER_PATH.read_text()
    assert "import hive" not in src and "from hive" not in src


def test_the_helper_never_uses_a_proxy(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example.invalid:3128")
    monkeypatch.setenv("http_proxy", "http://proxy.example.invalid:3128")
    # build_opener drops its default (environment-reading) ProxyHandler when given one; an empty one installs nothing
    assert not any(hasattr(h, "proxies") or type(h).__name__ == "ProxyHandler" for h in hh._OPENER.handlers)
    assert any(type(h).__name__ == "HTTPHandler" for h in hh._OPENER.handlers)


def test_check_reports_ok_and_401():
    token = "ohb1_" + "c" * 43
    connect = lambda p, r: {"status": "issued", "token": token, "name": "Dot", "mcp_url": URL, "credential": {}}  # noqa: E731
    seen = []

    def ok(req, timeout):
        seen.append(json.loads(req.data))
        return _Resp(json.dumps({"result": {"structuredContent": {"name": "Dot"}}}).encode())

    def unauthorized(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "no", {}, io.BytesIO(b""))

    out = io.StringIO()
    assert hh.check(["--socket", "/s/session.sock", "--check"], ENV, out, lambda p, r: seen.append(r) or connect(p, r), ok) == 0
    assert out.getvalue().startswith("OK Dot") and token not in out.getvalue()
    assert seen[0]["binding"] == "health-omegahive" and seen[0]["sessions"] == "per-binding"   # its own binding only
    out = io.StringIO()
    assert hh.check(["--socket", "/s/session.sock", "--check"], ENV, out, connect, unauthorized) == 1
    assert out.getvalue().strip() == "FAIL 401"


def test_the_exception_list_and_the_helper_table_agree():
    assert set(hh.MINDS.values()) == set(cr.BRIDGE_EXCEPTION)


# ---- one live credential per (mind, session) ------------------------------------------------------------------------

def _per_session(hive, binding, mind="Dot"):
    reply = sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": binding, "mind": mind,
                                   "replace": True, "sessions": "per-binding"})
    assert reply["status"] == "issued", reply
    return reply


def test_sessions_keep_their_own_credentials_up_to_the_cap_and_the_least_recently_used_goes(client, monkeypatch):
    hive = client.app.state.hive
    clock = [1_000_000.0]
    monkeypatch.setattr(cr.time, "time", lambda: clock[0])
    tokens = {}
    for i in range(cr.MAX_SESSIONS_PER_MIND):
        clock[0] += 10
        tokens[i] = _per_session(hive, f"claude-mcp-omegahive-{i:016x}")["token"]
        assert tool(client, tokens[i], "hive_whoami")[0] is None
    clock[0] += 120
    assert tool(client, tokens[0], "hive_inbox")[0] is None                        # session 0 is now the most recent
    live = lambda: hive.db.one("SELECT COUNT(*) n FROM agent_credentials WHERE status IN ('pending','active')")["n"]  # noqa: E731
    assert live() == cr.MAX_SESSIONS_PER_MIND
    clock[0] += 10
    new = _per_session(hive, "claude-mcp-omegahive-" + "f" * 16)["token"]
    assert live() == cr.MAX_SESSIONS_PER_MIND
    assert tool(client, tokens[1], "hive_whoami")[0] == 401                        # least recently used: retired
    assert hive.db.one("SELECT revoked_reason FROM agent_credentials WHERE revoked_reason = 'session_cap'")
    for i in (0, 2, 7):
        assert tool(client, tokens[i], "hive_whoami")[0] is None
    assert tool(client, new, "hive_whoami")[0] is None
    # the same session reconnecting replaces only its own
    again = _per_session(hive, "claude-mcp-omegahive-" + "f" * 16)["token"]
    assert tool(client, new, "hive_whoami")[0] == 401 and tool(client, again, "hive_whoami")[0] is None
    assert tool(client, tokens[2], "hive_whoami")[0] is None


def test_an_unused_per_session_credential_expires_and_tickets_keep_one_per_mind(client, monkeypatch):
    hive = client.app.state.hive
    clock = [2_000_000.0]
    monkeypatch.setattr(cr.time, "time", lambda: clock[0])
    old = _per_session(hive, "claude-mcp-omegahive-" + "a" * 16)["token"]
    assert tool(client, old, "hive_whoami")[0] is None
    clock[0] += cr.SESSION_IDLE_SECONDS - 30
    assert tool(client, old, "hive_inbox")[0] is None                              # use resets the idle clock
    clock[0] += cr.SESSION_IDLE_SECONDS - 30
    assert tool(client, old, "hive_inbox")[0] is None
    clock[0] += cr.SESSION_IDLE_SECONDS + 1
    assert tool(client, old, "hive_inbox")[0] == 401                               # idle past the limit
    _per_session(hive, "claude-mcp-omegahive-" + "b" * 16)
    assert hive.db.one("SELECT revoked_reason FROM agent_credentials WHERE binding_id LIKE '%aaaa'")["revoked_reason"] == "idle"
    # the classes are apart: helper rows never block the launcher's one-per-mind row, nor does it replace them
    helper_row = _per_session(hive, "claude-mcp-omegahive-" + "c" * 16)["token"]
    launcher = sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot"})
    assert launcher["status"] == "issued"
    assert sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "mind": "Dot",
                                  "binding": "0b5e5510-aaaa-4bbb-8ccc-00000000000e"}) == {
        "status": "refused", "code": "already_bridged"}                              # R2 §3 within its own class
    replaced = sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "mind": "Dot", "replace": True,
                                      "binding": "0b5e5510-aaaa-4bbb-8ccc-00000000000e"})
    assert replaced["status"] == "issued" and tool(client, launcher["token"], "hive_whoami")[0] == 401
    assert tool(client, helper_row, "hive_whoami")[0] is None                       # untouched by the launcher's replace
    assert sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "ticket": "sb_abcdef",
                                  "sessions": "per-binding"}) == {"status": "refused", "code": "bad_request"}
    assert sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot",
                                  "sessions": "everyone"}) == {"status": "refused", "code": "bad_request"}


def test_session_id_skips_shells_and_tells_a_reused_pid_apart():
    table = {500: (400, "Mon Nov 9 10:00:00 2026", "sh"), 400: (300, "Mon Nov 9 09:00:00 2026", "-zsh"),
             300: (1, "Mon Nov 9 08:00:00 2026", "claude")}
    ident = hh.session_id(500, ps=lambda pid: table[pid])
    assert ident == hh.session_id(300, ps=lambda pid: table[pid]) and len(ident) == 16
    table[300] = (1, "Mon Nov 9 11:00:00 2026", "claude")                           # the pid reused by a later process
    assert hh.session_id(500, ps=lambda pid: table[pid]) != ident
    assert hh.session_id() == hh.session_id()                                       # the real ps: stable per caller


def test_the_launcher_never_sends_its_token_through_a_proxy():
    opener = sl._NO_PROXY_OPEN.__self__
    assert not any(hasattr(h, "proxies") or type(h).__name__ == "ProxyHandler" for h in opener.handlers)
    assert sl.call_tool.__defaults__[-1] is sl._NO_PROXY_OPEN and sl.launch.__defaults__[1] is sl._NO_PROXY_OPEN


def test_the_launcher_row_is_outside_the_session_cap_and_helper_rows_cannot_migrate(client, monkeypatch):
    hive = client.app.state.hive
    clock = [3_000_000.0]
    monkeypatch.setattr(cr.time, "time", lambda: clock[0])
    launcher = sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING, "mind": "Dot"})["token"]
    assert tool(client, launcher, "hive_whoami")[0] is None
    for i in range(cr.MAX_SESSIONS_PER_MIND + 3):
        clock[0] += 5
        assert tool(client, _per_session(hive, f"claude-mcp-omegahive-{i:016x}")["token"], "hive_whoami")[0] is None
    assert tool(client, launcher, "hive_whoami")[0] is None                          # never counted, never capped
    assert hive.db.one("SELECT COUNT(*) n FROM agent_credentials WHERE per_session = 1 AND status = 'active'")["n"] == \
        cr.MAX_SESSIONS_PER_MIND
    helper = _per_session(hive, "claude-mcp-omegahive-" + "d" * 16)["token"]
    tool(client, helper, "hive_whoami")
    listed = {t["name"] for t in rpc(client, helper, "tools/list").json()["result"]["tools"]}
    assert cr.MIGRATION_TOOL not in listed and listed == cr.MIXED_CONTEXT_READS
    assert tool(client, helper, cr.MIGRATION_TOOL, {"op": "retire"}) == ("mixed_context_refused", None)
    assert hive.db.one("SELECT COUNT(*) n FROM legacy_credential_migrations")["n"] == 0
    assert cr.MIGRATION_TOOL in {t["name"] for t in rpc(client, launcher, "tools/list").json()["result"]["tools"]}


def test_the_exception_socket_rate_limits_issuance_per_mind(client, monkeypatch):
    hive = client.app.state.hive
    clock = [4_000_000.0]
    monkeypatch.setattr(cr.time, "time", lambda: clock[0])
    ask = lambda mind, i: sl.answer(hive, LOOP, {"op": "bridge", "harness": "claude-code", "mind": mind,  # noqa: E731
                                                 "binding": f"claude-mcp-x-{i:016x}", "sessions": "per-binding"},
                                    sl.EXCEPTIONS_ONLY)
    limit, window = sl.ISSUE_RATE
    for i in range(limit):
        assert ask("Dot", i)["status"] == "issued"
    assert ask("Dot", 99) == {"status": "refused", "code": "rate_limited", "http_status": 429}
    assert ask("Surface", 1)["status"] == "issued"                                  # per mind
    clock[0] += window + 1
    assert ask("Dot", 100)["status"] == "issued"


@pytest.mark.parametrize("headers,code", [
    ({"host": "omega.example.invalid"}, 403), ({"host": "localhost:8700"}, 403), ({"host": "127.0.0.1:8701"}, 403),
    ({"host": "127.0.0.1"}, 403), ({"host": "[::1]:8700"}, 403),
    ({"forwarded": "for=203.0.113.9"}, 403), ({"x-real-ip": "203.0.113.9"}, 403), ({"true-client-ip": "203.0.113.9"}, 403),
    ({"x-forwarded-host": "omega.example.invalid"}, 403), ({}, 200)])
def test_a_bridged_credential_needs_the_exact_loopback_host_and_no_proxy_header(client, headers, code):
    token = sl.answer(client.app.state.hive, LOOP, {"op": "bridge", "harness": "claude-code", "binding": BINDING,
                                                     "mind": "Dot"})["token"]
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    headers={"Authorization": f"Bearer {token}", **headers})
    assert r.status_code == code
    if code == 403:
        assert r.json()["error"]["code"] == "credential_local_only"


def test_a_missing_host_fails_closed():
    import asyncio
    gate = cr.RestrictedCredentialGate(app=None, hive=None, port=8700)
    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request", "body": b""}
    scope = {"type": "http", "path": "/mcp", "method": "POST", "headers": [(b"authorization", b"Bearer ohb1_x")]}
    asyncio.run(gate(scope, receive, send))
    assert sent[0]["status"] == 403
    assert gate._public({"headers": [(b"host", b"127.0.0.1:8700"), (b"host", b"evil.example")]})   # two Hosts: refused
    assert not gate._public({"headers": [(b"host", b"127.0.0.1:8700")]})
