"""J1b: the local-owner hive (HIVE_LOCAL_OWNER=1). Design PLATFORM_J1_INSTALLER_DESIGN r2 A/B/C/F, r3 K1/N, r4 KM3,
r4.1 K-3. Every behaviour here is inert without HIVE_LOCAL_OWNER=1 (the regression tests at the end)."""

import asyncio
import json
import logging
import os
import pathlib
import shutil
import socket
import stat
import sys
import tempfile
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hive.core import localowner, redact
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.supervisor import preflight, sandbox
from hive.tests.test_core_api import FakeSupervisor, PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

BASE = "http://127.0.0.1:8700"
ORIGIN = {"Origin": BASE}
PASSED = {"version": 1, "platform": "test", "pass": True, "rows": [], "reason": None}


@pytest.fixture(autouse=True)
def _restore_globals():
    yield
    redact.REDACTOR.enabled = False
    sandbox._REFUSED = None
    sandbox._TOOLS_REFUSED = None


@pytest.fixture()
def local_env(monkeypatch):
    for name in localowner.SIGNIN_SETTINGS + localowner.PUBLIC_SETTINGS + ("HIVE_HOST", "HIVE_LOCAL_BROWSER_PORT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HIVE_LOCAL_OWNER", "1")
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setenv("HIVE_PORT", "8700")
    monkeypatch.setattr(preflight, "run_and_record", lambda data_dir: dict(PASSED))
    return monkeypatch


def short_dir():
    """Unix socket paths are limited to ~100 bytes: the data folder lives under /tmp (mode 0700 from mkdtemp)."""
    return pathlib.Path(tempfile.mkdtemp(prefix="j1b-", dir="/tmp"))


def make_app(data=None):
    data = data or short_dir()
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA)
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0), data


@pytest.fixture()
def local(local_env):
    app, data = make_app()
    with TestClient(app, base_url=BASE) as client:
        client.data = data
        client.local = app.state.hive.local_owner
        yield client
    shutil.rmtree(data, ignore_errors=True)


def sign_in(client):
    code = client.local.issue_code()["code"]
    out = client.post("/api/auth/local/exchange", json={"code": code}, headers=ORIGIN)
    assert out.status_code == 200, out.text
    return out.json()["token"]


# ---- A: the owner, the code, the control socket ---------------------------------------------------------------------

def test_first_boot_creates_one_named_admin_owner(local):
    hive = local.app.state.hive
    people = hive.db.all("SELECT * FROM people")
    assert len(people) == 1
    person = people[0]
    assert (person["email"], person["role"], person["invited_by"], person["disabled"]) == \
        ("owner@local.invalid", "admin", "local-install", 0)
    owner = hive.db.one("SELECT * FROM hive_owner WHERE id = 1")
    assert owner["owner"] == f"user:{person['id']}" and owner["via"] == "local-install"
    assert hive.db.one("SELECT * FROM hive_owner_log WHERE owner = ?", (owner["owner"],))["by"] == "local-install"


def test_operator_throttle_never_changes_local_owner_password_refusal(local):
    attempts = local.app.state.password_attempts
    attempts.failures = attempts.LIMIT
    before = local.app.state.hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"]
    for payload in [b'{"password":"pw"}', b'{"password":"invented-wrong"}', b'not-json']:
        response = local.post("/api/auth/login", content=payload, headers={"Content-Type": "application/json", **ORIGIN})
        assert response.status_code == 403 and response.json()["error"]["code"] == "password_signin_off"
    assert attempts.failures == attempts.LIMIT
    assert local.app.state.hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"] == before


def test_a_second_boot_keeps_the_same_owner(local_env):
    app, data = make_app()
    first = app.state.hive.local_owner.principal
    app2, _ = make_app(data)
    assert app2.state.hive.local_owner.principal == first
    assert len(app2.state.hive.db.all("SELECT id FROM people")) == 1
    shutil.rmtree(data, ignore_errors=True)


def test_a_hive_owned_by_someone_else_is_not_taken_over(local_env, monkeypatch):
    monkeypatch.delenv("HIVE_LOCAL_OWNER")
    app, data = make_app()
    hive = app.state.hive
    hive.db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, 'user:u_other', 'claimed', 'x', 'x')")
    monkeypatch.setenv("HIVE_LOCAL_OWNER", "1")
    with pytest.raises(localowner.LocalOwnerRefused):
        make_app(data)
    shutil.rmtree(data, ignore_errors=True)


def test_the_code_becomes_an_sso_session_for_the_named_owner(local):
    token = sign_in(local)
    headers = {"Authorization": f"Bearer {token}"}
    me = local.get("/api/auth/me", headers=headers).json()
    assert me["kind"] == "sso" and me["principal"] == local.local.principal
    assert me["local_operator"] is False and me["person_kind"] == "person" and me["role"] == "admin"
    hive = local.app.state.hive
    row = hive.db.one("SELECT * FROM sessions WHERE principal = ?", (local.local.principal,))
    assert row["kind"] == "sso"
    # r3 K1 / r4 KM3: admin(), the hive owner, named-admin gates, app attachments' admin and onboarding all accept it
    assert local.get("/api/services", headers=headers).status_code == 200
    assert hive.ownhive.is_owner(local.local.principal)
    named = local.put("/api/lifecycle/delegations/nobody", json={"specialist_ids": []}, headers=dict(headers, **ORIGIN))
    assert named.status_code != 403, named.text
    from hive.core.program_actions import ProgramActions
    hive.app_attachments.admin(ProgramActions.person_actor(row, "admin", None))
    from hive.core.visibility import Viewer
    hive.onboarding.person(Viewer(local.local.principal, True))


def test_a_code_is_single_use_short_lived_and_bound_to_this_process(local, monkeypatch):
    code = local.local.issue_code()["code"]
    assert len(code) == 43   # 256 bits, url-safe
    assert local.post("/api/auth/local/exchange", json={"code": code}, headers=ORIGIN).status_code == 200
    again = local.post("/api/auth/local/exchange", json={"code": code}, headers=ORIGIN)
    assert again.status_code == 401 and again.json()["error"]["code"] == "code_refused"
    stale = local.local.issue_code()["code"]
    real = time.time
    monkeypatch.setattr(localowner.time, "time", lambda: real() + localowner.CODE_SECONDS + 1)
    assert local.post("/api/auth/local/exchange", json={"code": stale}, headers=ORIGIN).status_code == 401
    monkeypatch.setattr(localowner.time, "time", real)
    other = local.local.issue_code()["code"]
    local.local.instance = "another-process"
    assert local.post("/api/auth/local/exchange", json={"code": other}, headers=ORIGIN).status_code == 401
    stored = local.app.state.hive.db.all("SELECT code_hash FROM local_signin_codes")
    assert all(code not in r["code_hash"] and len(r["code_hash"]) == 64 for r in stored)   # hashed, never the code


def test_the_exchange_sets_no_cookie_and_is_not_cached(local):
    code = local.local.issue_code()["code"]
    out = local.post("/api/auth/local/exchange", json={"code": code}, headers=ORIGIN)
    assert "set-cookie" not in out.headers and out.headers["cache-control"] == "no-store"


def _control(path, request):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(str(path))
    s.sendall((json.dumps(request) + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data) if data else None


def test_the_control_socket_is_private_and_issues_codes(local):
    run = local.data / "run"
    assert stat.S_IMODE(os.lstat(run).st_mode) == 0o700
    sock = run / "control.sock"
    assert stat.S_ISSOCK(os.lstat(sock).st_mode) and stat.S_IMODE(os.lstat(sock).st_mode) == 0o600
    hello = _control(sock, {"op": "hello"})
    assert hello["ok"] and hello["port"] == 8700 and hello["owner"] == local.local.principal and hello["pid"] == os.getpid()
    # self identity (localowner.self_identity): Linux states exe {dev, ino} and listener_inode; elsewhere neither key
    if sys.platform.startswith("linux"):
        exe = os.stat("/proc/self/exe")
        assert hello["exe"] == {"dev": exe.st_dev, "ino": exe.st_ino} and "listener_inode" in hello
    else:
        assert "exe" not in hello and "listener_inode" not in hello
    issued = _control(sock, {"op": "signin"})
    assert issued["url"] == f"{BASE}/local-signin#{issued['code']}" and issued["expires_in"] == 60
    assert local.post("/api/auth/local/exchange", json={"code": issued["code"]}, headers=ORIGIN).status_code == 200
    assert _control(sock, {"op": "nope"}) == {"ok": False, "error": "unknown_op"}


def test_the_control_socket_answers_only_its_own_uid(local, monkeypatch):
    monkeypatch.setattr(localowner, "peer_uid", lambda sock: os.getuid() + 1)
    assert _control(local.data / "run" / "control.sock", {"op": "signin"}) is None
    assert local.app.state.hive.db.all("SELECT * FROM local_signin_codes") == []


def test_peer_uid_reads_the_real_peer(tmp_path):
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        assert localowner.peer_uid(a) == os.getuid()
    finally:
        a.close()
        b.close()


@pytest.mark.parametrize("name", localowner.SIGNIN_SETTINGS)
def test_k3_any_google_or_family_signin_setting_refuses_start(local_env, name):
    local_env.setenv(name, "x")
    with pytest.raises(localowner.LocalOwnerRefused, match=name):
        make_app()


@pytest.mark.parametrize("name,value", [("HIVE_BASE_PATH", "/omegahive"), ("HIVE_PUBLIC_BASE", "https://x.example"),
                                        ("HIVE_HOST", "0.0.0.0"), ("HIVE_MIND_SANDBOX", "0")])
def test_a_public_or_unsandboxed_local_hive_refuses_start(local_env, name, value):
    local_env.setenv(name, value)
    with pytest.raises(localowner.LocalOwnerRefused):
        make_app()


# ---- B: the browser boundary ----------------------------------------------------------------------------------------

def test_only_this_hives_own_host_is_answered(local):
    assert local.get("/api/auth/methods").status_code == 200
    for host in ("evil.example", "127.0.0.1:8701", "evil.example:8700", "127.0.0.1.nip.io:8700"):
        out = local.get("/api/auth/methods", headers={"Host": host})
        assert out.status_code == 421 and out.json()["error"]["code"] == "wrong_host", host
    assert local.get("/api/auth/methods", headers={"Host": "localhost:8700"}).status_code == 200


def test_cors_allows_only_the_loopback_origin(local):
    good = local.options("/api/swarms", headers={"Origin": BASE, "Access-Control-Request-Method": "POST"})
    assert good.headers.get("access-control-allow-origin") == BASE
    bad = local.options("/api/swarms", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert bad.status_code == 403 and "access-control-allow-origin" not in bad.headers
    plain = local.get("/api/auth/methods", headers=ORIGIN)
    assert plain.headers.get("access-control-allow-origin") == BASE


def test_no_token_is_accepted_in_the_address(local):
    token = sign_in(local)
    out = local.get(f"/api/auth/me?token={token}")
    assert out.status_code == 400 and out.json()["error"]["code"] == "query_token_refused"
    assert local.get("/api/auth/me?access_token=x").status_code == 400


def test_session_mutations_need_this_hives_origin(local):
    auth = {"Authorization": f"Bearer {sign_in(local)}"}
    assert local.post("/api/swarms", json={"name": "A"}, headers=auth).json()["error"]["code"] == "origin_required"
    assert local.post("/api/swarms", json={"name": "A"}, headers=dict(auth, Origin="https://evil.example")).status_code == 403
    assert local.post("/api/swarms", json={"name": "A"}, headers=dict(auth, **ORIGIN)).status_code == 200
    # the code exchange is inside the Origin check (r3 N), even with no session yet
    code = local.local.issue_code()["code"]
    assert local.post("/api/auth/local/exchange", json={"code": code}).status_code == 403
    assert local.post("/api/auth/local/exchange", json={"code": code},
                      headers={"Origin": "http://localhost:8701"}).status_code == 403


def test_minds_without_origin_still_reach_their_routes(local):
    """A mind's own token is not a session: the Origin rule is for browser sessions (minds send no Origin)."""
    out = local.post("/llm/v1/chat/completions", json={}, headers={"Authorization": "Bearer not-a-session"})
    assert out.status_code == 401   # reached the route's own agent check, not the boundary


HOST = {"Host": "127.0.0.1:8700"}   # starlette's TestClient sends Host "testserver" on websockets whatever the base_url


def _events(client, headers=None):
    return client.websocket_connect("/api/events", headers=dict(HOST, **(headers if headers is not None else ORIGIN)))


def test_events_take_the_token_in_the_first_frame(local):
    token = sign_in(local)
    with _events(local) as ws:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        assert json.loads(ws.receive_text())["type"] == "hello"
        ws.send_text(json.dumps({"type": "ping"}))
        assert json.loads(ws.receive_text())["type"] == "pong"


def test_events_refuse_a_bad_token_a_big_frame_and_a_query_token(local):
    with _events(local) as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "wrong"}))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 4401
    with _events(local) as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "x" * 5000}))
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 1009
    token = sign_in(local)
    with pytest.raises(WebSocketDisconnect):
        with local.websocket_connect(f"/api/events?token={token}", headers=dict(HOST, **ORIGIN)) as ws:
            ws.receive_text()
    with pytest.raises(WebSocketDisconnect):
        with _events(local, headers={}) as ws:   # no Origin
            ws.receive_text()
    with pytest.raises(WebSocketDisconnect):
        with _events(local, headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()


def test_events_close_when_no_auth_arrives_in_time(local, monkeypatch):
    monkeypatch.setattr(localowner, "EVENTS_AUTH_SECONDS", 0.2)
    subscribers = len(local.app.state.hive.events._queues)
    with _events(local) as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 4408
    assert len(local.app.state.hive.events._queues) == subscribers   # nothing was ever subscribed


def test_events_frames_after_auth_are_bounded(local):
    token = sign_in(local)
    with _events(local) as ws:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        ws.receive_text()
        ws.send_text("x" * 5000)
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(5):
                ws.receive_text()
        assert closed.value.code == 1009


def test_the_signin_page_is_static_strict_and_uncached(local):
    page = local.get("/local-signin")
    assert page.status_code == 200
    csp = page.headers["content-security-policy"]
    assert "default-src 'self'" in csp and "unsafe-inline" not in csp and "frame-ancestors 'none'" in csp
    assert page.headers["cache-control"] == "no-store" and page.headers["referrer-policy"] == "no-referrer"
    html = page.text
    assert '<script src="/local-signin.js"></script>' in html
    assert html.count("<script") == 1   # no inline code: the one script is the same-origin file
    script = local.get("/local-signin.js")
    assert script.headers["content-type"].startswith("text/javascript") and script.headers["cache-control"] == "no-store"
    first = [line for line in script.text.splitlines() if line.strip() and not line.lstrip().startswith("//")][0]
    assert "history.replaceState" in first and "location.hash" in first   # the first statement strips the code
    assert "omegadots.hive.token" in script.text and "/api/auth/local/exchange" in script.text


def test_auth_methods_tells_the_welcome_page_it_is_local(local):
    assert local.get("/api/auth/methods").json()["local_owner"] is True


def test_the_welcome_status_needs_a_session(local):
    assert local.get("/api/local/status").status_code == 401
    out = local.get("/api/local/status", headers={"Authorization": f"Bearer {sign_in(local)}"}).json()
    assert out["local_owner"] is True and out["port"] == 8700 and out["preflight"]["pass"] is True
    assert "instance" not in out


# ---- C: private writes ----------------------------------------------------------------------------------------------

def test_an_open_data_folder_refuses_start(local_env):
    data = short_dir()
    os.chmod(data, 0o755)
    with pytest.raises(localowner.LocalOwnerRefused, match="0700"):
        make_app(data)
    os.chmod(data, 0o700)
    link = data.parent / (data.name + "-link")
    link.symlink_to(data)
    try:
        with pytest.raises(localowner.LocalOwnerRefused):
            localowner.check_data_dir(link)
    finally:
        link.unlink()
        shutil.rmtree(data, ignore_errors=True)


def test_prepare_process_sets_umask_077_and_no_core_dumps(monkeypatch):
    import resource
    import sys
    old_umask = os.umask(0o022)
    old_core = resource.getrlimit(resource.RLIMIT_CORE)
    out, err = sys.stdout, sys.stderr
    try:
        localowner.prepare_process()
        assert os.umask(0o077) == 0o077
        assert resource.getrlimit(resource.RLIMIT_CORE)[0] == 0
        assert redact.REDACTOR.enabled
    finally:
        os.umask(old_umask)
        sys.stdout, sys.stderr = out, err
        try:
            resource.setrlimit(resource.RLIMIT_CORE, old_core)
        except (ValueError, OSError):
            pass


# ---- F: one redactor -------------------------------------------------------------------------------------------------

def test_a_registered_key_never_reaches_a_log_line(caplog):
    redact.enable()
    key = "sk-or-v1-" + "a" * 40
    redact.register(key)
    with caplog.at_level(logging.INFO, logger="hive"):
        logging.getLogger("hive").info("calling with %s", key)
        logging.getLogger("hive").info("Authorization: Bearer abcdefghijklmnop")
        try:
            raise ValueError(f"upstream said {key}")
        except ValueError:
            logging.getLogger("hive").exception("failed")
    text = "\n".join(r.getMessage() + (r.exc_text or "") for r in caplog.records)
    assert key not in text and "abcdefghijklmnop" not in text and "[redacted]" in text


def test_a_submitted_key_is_registered_before_verification(local):
    providers = local.app.state.hive.providers
    secret = "zz-custom-provider-secret-1234567890"
    seen = {}

    async def verify(name, key):
        seen["registered"] = redact.scrub(f"echo {key}") == "echo [redacted]"
        raise providers_error(name, key)

    from hive.core.providers import ProviderError

    def providers_error(name, key):
        return ProviderError(502, "provider_error", f"{name} said {key}")

    providers.verify = verify
    with pytest.raises(ProviderError):
        asyncio.run(providers.add_key("openrouter", secret))
    assert seen["registered"] is True


def test_provider_errors_carry_status_and_code_only(local):
    import httpx
    redact.enable()
    response = httpx.Response(500, json={"error": {"code": "server_error", "message": "key sk-or-v1-" + "b" * 30 + " is bad"}})
    text = redact.provider_error_text("openrouter", response)
    assert text == "openrouter answered 500 (unavailable)"   # keyview R8: this hive's own category, never the provider's code


def test_the_keyring_is_written_privately_without_following_links(tmp_path, monkeypatch):
    from hive.core.providers import ProviderStore
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    store = ProviderStore(settings)
    store.ring["keys"]["k_00000000"] = {"id": "k_00000000", "provider": "openrouter", "label": "x", "owner": "user:operator",
                                        "secret": "sk-or-v1-secret", "created_at": 0}
    victim = tmp_path / "victim"
    victim.write_text("untouched")
    monkeypatch.setattr("hive.core.providers.secrets.token_hex", lambda n=None: "f" * 16)
    for planted in (store.path.with_suffix(".tmp"), store.path.with_name(f".{store.path.name}.{'f' * 16}.tmp")):
        planted.symlink_to(victim)
    fsynced = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (fsynced.append(fd), real_fsync(fd))[1])
    old = os.umask(0)
    try:
        with pytest.raises(FileExistsError):
            store._write()   # the planted name is refused (O_EXCL), never followed
        assert victim.read_text() == "untouched" and not store.path.exists()
        monkeypatch.setattr("hive.core.providers.secrets.token_hex", lambda n=None: "e" * 16)
        store._write()
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600
    assert json.loads(store.path.read_text())["keys"]["k_00000000"]["secret"] == "sk-or-v1-secret"
    assert len(fsynced) >= 2   # the file and its folder
    assert not list(store.path.parent.glob(".providers.json.e*.tmp"))


# ---- regression: nothing changes without HIVE_LOCAL_OWNER ------------------------------------------------------------

def test_without_local_owner_every_behaviour_is_as_before(monkeypatch):
    monkeypatch.delenv("HIVE_LOCAL_OWNER", raising=False)
    called = []
    monkeypatch.setattr(preflight, "run_and_record", lambda d: called.append(d))
    app, data = make_app()
    hive = app.state.hive
    assert getattr(hive, "local_owner", None) is None
    with TestClient(app) as client:   # Host "testserver": no allowlist
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        assert client.get(f"/api/auth/me?token={token}").status_code == 200   # query token still works here
        cors = client.get("/api/auth/methods", headers={"Origin": "https://anywhere.example"})
        assert cors.headers.get("access-control-allow-origin") == "*"
        assert "local_owner" not in cors.json()
        auth = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/swarms", json={"name": "A"}, headers=auth).status_code == 200   # no Origin needed
        assert client.post("/api/auth/local/exchange", json={"code": "x" * 43}).status_code in (404, 405)
        assert client.get("/api/local/status", headers=auth).status_code in (404, 405)
        page = client.get("/local-signin")
        assert "content-security-policy" not in page.headers
        with client.websocket_connect(f"/api/events?token={token}") as ws:
            assert json.loads(ws.receive_text())["type"] == "hello"
    assert called == [] and not (data / "run").exists()
    assert hive.db.all("SELECT * FROM people") == []
    assert hive.db.one("SELECT name FROM sqlite_master WHERE name = 'local_signin_codes'") is None
    assert redact.REDACTOR.enabled is False and sandbox.refused() is None
    shutil.rmtree(data, ignore_errors=True)


def test_without_local_owner_provider_errors_and_logs_are_unchanged(caplog):
    import httpx
    assert redact.REDACTOR.enabled is False
    key = "sk-or-v1-" + "c" * 40
    redact.register(key)
    response = httpx.Response(500, text="raw upstream text")
    # keyview R8 (sol on 1edef3b4): a provider's own text is never relayed on any hive, local-owner or not
    assert redact.provider_error_text("openrouter", response) == "openrouter answered 500 (unavailable)"
    assert redact.scrub(f"x {key}") == f"x {key}"


# ---- r1.1 (review fixes: stand-in r1.0 P1, P2-2, P2-3; Kimi r1.0 P2-2, P2-3, P2-4) --------------------------------

def _env(**extra):
    env = {"HIVE_LOCAL_OWNER": "1", "HIVE_MIND_SANDBOX": "1", "HIVE_PORT": "8700"}
    env.update(extra)
    return env


NEAR_MISSES = [" 1", "1 ", "\t1", "1\n", " 1 ", "01", "1.0", "+1", "true", "yes", "on", "１", "", "0"]


@pytest.mark.parametrize("value", NEAR_MISSES)
def test_r11_only_an_exact_1_starts_a_local_hive(value):
    """Stand-in r1.0 P1: " 1" and "1 " passed the start check (which stripped) yet the launcher (exact "1") then ran
    minds without the OS sandbox. Now both read one helper, so a value the start check accepts is one that sandboxes."""
    assert sandbox.mind_sandbox_requested({"HIVE_MIND_SANDBOX": value}) is False
    with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_MIND_SANDBOX"):
        localowner.check_environment(_env(HIVE_MIND_SANDBOX=value))


def test_r11_exactly_1_is_accepted_by_both_the_start_check_and_the_launcher():
    localowner.check_environment(_env())
    assert sandbox.mind_sandbox_requested({"HIVE_MIND_SANDBOX": "1"}) is True


@pytest.mark.parametrize("value", [" 1", "1 "])
def test_r11_a_whitespace_sandbox_setting_refuses_the_whole_hive(local_env, value):
    local_env.setenv("HIVE_MIND_SANDBOX", value)
    with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_MIND_SANDBOX"):
        make_app()


def test_r11_every_reader_of_the_sandbox_setting_uses_the_one_helper():
    """The drift guard: nothing outside hive/supervisor/sandbox.py decides on HIVE_MIND_SANDBOX itself (compares or
    normalises it); showing its value in a refusal message is fine."""
    import re
    root = pathlib.Path(localowner.__file__).resolve().parents[1]
    reader = re.compile(r"""HIVE_MIND_SANDBOX["']\s*(?:\]|,[^)]*\)|\))\s*(?:==|!=|\.strip|\.lower|\bin\b|\bnot\s+in\b)""")
    offenders = [str(p.relative_to(root)) for p in root.rglob("*.py")
                 if "tests" not in p.parts and p.name != "sandbox.py" and reader.search(p.read_text())]
    assert offenders == []


def test_r11_password_signin_is_off_on_a_local_hive(local):
    """Stand-in r1.0 P2-3: no reusable credential and no user:operator session on a local-owner hive."""
    assert local.get("/api/auth/methods").json()["password"] is False
    out = local.post("/api/auth/login", json={"password": "pw"}, headers=ORIGIN)
    assert out.status_code == 403 and out.json()["error"]["code"] == "password_signin_off"
    assert local.app.state.hive.db.all("SELECT * FROM sessions WHERE kind = 'password'") == []


def test_r11_password_signin_is_unchanged_without_local_owner(monkeypatch):
    monkeypatch.delenv("HIVE_LOCAL_OWNER", raising=False)
    monkeypatch.setattr(preflight, "run_and_record", lambda d: None)
    app, data = make_app()
    with TestClient(app) as client:
        assert client.get("/api/auth/methods").json()["password"] is True
        assert client.post("/api/auth/login", json={"password": "pw"}).status_code == 200
        assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    shutil.rmtree(data, ignore_errors=True)


@pytest.mark.parametrize("change", [{"disabled": 1}, {"role": "member"}, {"disabled": 1, "role": "member"}])
def test_r11_a_disabled_or_demoted_local_owner_is_restored_at_boot(local_env, change, caplog):
    """Kimi r1.0 P2-2: the installer's own owner row is restored (and logged) instead of the hive refusing to start."""
    app, data = make_app()
    hive = app.state.hive
    principal = hive.local_owner.principal
    hive.db.update("people", principal[5:], change)
    with caplog.at_level(logging.WARNING, logger="hive"):
        app2, _ = make_app(data)
    person = app2.state.hive.db.one("SELECT * FROM people WHERE id = ?", (principal[5:],))
    assert (person["disabled"], person["role"]) == (0, "admin")
    assert app2.state.hive.local_owner.principal == principal
    assert any("restored the local owner" in r.getMessage() for r in caplog.records)
    log_row = app2.state.hive.db.one("SELECT * FROM hive_owner_log WHERE reason LIKE 'restored%'")
    assert log_row is not None and log_row["by"] == "local-install" and log_row["owner"] == principal
    shutil.rmtree(data, ignore_errors=True)


def test_r11_a_hive_handed_to_someone_else_is_still_not_taken_back(local_env, monkeypatch):
    """The restore covers only the installer's own owner, still the stored owner; a handed-over hive keeps refusing."""
    app, data = make_app()
    hive = app.state.hive
    hive.db.update("people", hive.local_owner.principal[5:], {"disabled": 1})
    hive.db.execute("UPDATE hive_owner SET owner = 'user:u_other', via = 'claimed' WHERE id = 1")
    with pytest.raises(localowner.LocalOwnerRefused):
        make_app(data)
    shutil.rmtree(data, ignore_errors=True)


@pytest.mark.parametrize("env", [{"HIVE_LOCAL_BROWSER_PORT": "8700"},
                                 {"HIVE_PORT": "", "HIVE_LOCAL_BROWSER_PORT": "8700"},
                                 {"HIVE_PORT": "9100", "HIVE_LOCAL_BROWSER_PORT": " 9100"}])
def test_r11_the_browser_port_must_differ_from_the_hive_port(env):
    """Kimi r1.0 P2-3: the two-port set no longer collapses silently to one."""
    with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_LOCAL_BROWSER_PORT"):
        localowner.check_environment(_env(**env))


def test_r11_two_distinct_ports_give_six_hosts():
    env = _env(HIVE_LOCAL_BROWSER_PORT="8701")
    localowner.check_environment(env)
    assert len(localowner.allowed_hosts(localowner.ports(env))) == 6


def _interp(tmp_path, mode=0o755):
    path = tmp_path / "python3.12"
    path.write_text("#!/bin/sh\n")
    os.chmod(path, mode)
    return path


def test_r11_a_private_sandbox_python_is_accepted(tmp_path):
    localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(_interp(tmp_path))))   # owned by this uid, 0755


@pytest.mark.parametrize("mode", [0o775, 0o757, 0o777, 0o722])
def test_r11_a_group_or_other_writable_sandbox_python_refuses_start(tmp_path, mode):
    """Kimi r1.0 P2-4: the launcher interpreter is checked for trust, not only for shape."""
    with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_SANDBOX_PYTHON"):
        localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(_interp(tmp_path, mode))))


def test_r11_a_linked_missing_relative_or_folder_sandbox_python_refuses_start(tmp_path):
    real = _interp(tmp_path)
    link = tmp_path / "link"
    link.symlink_to(real)
    for value in (str(link), str(tmp_path / "missing"), "bin/python3", str(tmp_path)):
        with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_SANDBOX_PYTHON"):
            localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=value))


def test_r11_a_sandbox_python_owned_by_another_account_refuses_start(tmp_path, monkeypatch):
    path = _interp(tmp_path)
    monkeypatch.setattr(localowner.os, "getuid", lambda: os.stat(path).st_uid + 1)   # neither root nor "this uid"
    if os.stat(path).st_uid == 0:
        pytest.skip("running as root")
    with pytest.raises(localowner.LocalOwnerRefused, match="HIVE_SANDBOX_PYTHON"):
        localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(path)))


def test_r11_a_root_owned_sandbox_python_is_accepted():
    root_owned = next((p for p in ("/bin/sh", "/usr/bin/env") if os.lstat(p).st_uid == 0
                       and stat.S_ISREG(os.lstat(p).st_mode) and not os.lstat(p).st_mode & 0o022), None)
    if root_owned is None:
        pytest.skip("no root-owned regular file here")
    localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=root_owned))


def test_r12_a_sandbox_python_under_a_group_or_other_writable_folder_refuses_start(tmp_path):
    """Stand-in r1.1 P1: a trusted file under a folder another account can write can be replaced after the check."""
    folder = tmp_path / "shared"
    folder.mkdir()
    path = folder / "python3.12"
    path.write_text("#!/bin/sh\n")
    os.chmod(path, 0o755)
    for mode in (0o775, 0o757, 0o777):
        os.chmod(folder, mode)
        with pytest.raises(localowner.LocalOwnerRefused, match="folder .*shared.* can be changed by other accounts"):
            localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(path)))
    os.chmod(folder, 0o755)
    localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(path)))


def test_r12_a_sandbox_python_reached_through_a_linked_folder_refuses_start(tmp_path):
    """Stand-in r1.1 P1: a link anywhere on the path (not only the file itself) can be swapped."""
    real = tmp_path / "real"
    real.mkdir()
    (real / "python3.12").write_text("#!/bin/sh\n")
    os.chmod(real / "python3.12", 0o755)
    (tmp_path / "via").symlink_to(real)
    with pytest.raises(localowner.LocalOwnerRefused, match="link in its path"):
        localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(tmp_path / "via" / "python3.12")))


def test_r12_a_sandbox_python_under_a_folder_owned_by_another_account_refuses_start(tmp_path, monkeypatch):
    path = _interp(tmp_path)
    real_lstat = os.lstat
    def lstat(p, *a, **k):
        st = real_lstat(p, *a, **k)
        if os.fspath(p) == os.fspath(tmp_path):
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, 4242, st.st_gid, st.st_size,
                                   st.st_atime, st.st_mtime, st.st_ctime))
        return st
    monkeypatch.setattr(localowner.os, "lstat", lstat)
    with pytest.raises(localowner.LocalOwnerRefused, match="uid 4242"):
        localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(path)))


def test_r13_a_sandbox_python_path_with_dot_parts_refuses_start(tmp_path):
    """Stand-in r1.2 P1: '..' lets the checked (normalised) path differ from the one the kernel walks."""
    real = _interp(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    for value in (f"{other}/../{real.name}", f"{tmp_path}/./{real.name}", f"{tmp_path}//{real.name}"):
        with pytest.raises(localowner.LocalOwnerRefused, match="plain form"):
            localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=value))
    localowner.check_environment(_env(HIVE_SANDBOX_PYTHON=str(real)))
