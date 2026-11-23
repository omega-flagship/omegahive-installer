"""Purpose: Verify connector clients' standalone files and authenticated runtime calls."""
import importlib.util
import hmac
import json
import os
import pathlib
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]

def _write_files(base, files):
    for rel, data in files.items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return base


def _module(path, name, monkeypatch, **env):
    for key in ("HIVE_API_URL", "HIVE_WS_TOKEN", "OMEGACLAW_MEMORY_DIR", "OMEGACLAW_WA_AUTH", "OMEGACLAW_WA_AUTH_DIR"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)   # some modules look themselves up there while loading
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def connector_server():
    requests = []
    replies = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            size = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(size)) if size else None
            requests.append((self.command, self.path, self.headers.get("Authorization"), payload))
            status, data = replies.pop(0) if replies else (500, {"error": {"code": "unexpected_request"}})
            if callable(data):
                data = data(self.headers)
            response = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        do_GET = do_POST

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            yield SimpleNamespace(base=base, port=server.server_port, requests=requests, replies=replies,
                                  env={"HIVE_API_URL": base + "/", "HIVE_WS_TOKEN": "mind-token"})
        finally:
            server.shutdown()
            thread.join()


def _module_checkout(tmp_path, path, monkeypatch, **env):
    code = _write_files(tmp_path / "code", {path: (ROOT / path).read_bytes()})
    return _module(code / path, "connector_client", monkeypatch, **env), code


HA = "modules/home_assistant/bridge/home_assistant.py"
GLUCOSE = ("src/glucose.py", "modules/health_glucose/src/glucose.py")
AGENTVERSE = "modules/agentverse/src/agentverse_bridge.py"
WHATSAPP = ("channels/whatsapp.py", "modules/channel_whatsapp/src/whatsapp.py")


def test_home_assistant_uses_the_hive_and_preserves_upstream_status(tmp_path, monkeypatch, connector_server):
    hive = connector_server
    module, code = _module_checkout(tmp_path, HA, monkeypatch, **hive.env,
                                    OMEGACLAW_MEMORY_DIR=str(tmp_path / "mind"), OMEGACLAW_HA_TRACE="1")
    monkeypatch.setenv("HOME_ASSISTANT_URL", "http://unused.invalid")
    monkeypatch.setenv("HOME_ASSISTANT_TOKEN", "unused-token")
    detail = "device refused " * 30
    hive.replies.extend([
        (200, {"status": 200, "text": '[{"entity_id":"light.desk","state":"on"}]'}),
        (200, {"status": 200, "text": '"rendered"'}),
        (200, {"status": 204, "text": ""}),
        (200, {"status": 404, "text": detail}),
        (403, {"error": {"code": "connector_not_installed", "message": "Install this connector"}}),
    ])

    assert "light.desk" in module.observe_house_full()
    assert module._template("{{ 'rendered' }}") == "rendered"
    assert module._request("POST", "/api/services/light/turn_on", {"entity_id": "light.desk"}) is None
    with pytest.raises(RuntimeError) as upstream_error:
        module._request("GET", "/api/states/light.missing")
    assert str(upstream_error.value) == f"Home Assistant HTTP 404: {detail[:300]}"
    with pytest.raises(RuntimeError, match="Hive HTTP 403: connector_not_installed: Install this connector"):
        module._request("GET", "/api/states")
    module._append_log({"target": "light.desk"})

    assert hive.requests == [
        ("POST", "/api/agent/connectors/home_assistant/request", "Bearer mind-token", call)
        for call in (
            {"method": "GET", "path": "/api/states"},
            {"method": "POST", "path": "/api/template", "payload": {"template": "{{ 'rendered' }}"}},
            {"method": "POST", "path": "/api/services/light/turn_on", "payload": {"entity_id": "light.desk"}},
            {"method": "GET", "path": "/api/states/light.missing"},
            {"method": "GET", "path": "/api/states"},
        )
    ]
    assert module.ACTION_LOG.is_file()
    assert not (code / "memory").exists()


def test_home_assistant_standalone_reads_its_checkout_token(tmp_path, monkeypatch, connector_server):
    for name in ("HOME_ASSISTANT_URL", "HA_URL", "HOME_ASSISTANT_TOKEN", "HA_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    service = connector_server
    module, code = _module_checkout(tmp_path, HA, monkeypatch, HIVE_API_URL=service.base)
    _write_files(code, {"memory/home_assistant.json": json.dumps({"url": service.base, "token": "ha-token"}).encode()})
    service.replies.append((200, [{"entity_id": "light.desk"}]))
    assert module._states() == [{"entity_id": "light.desk"}]
    assert service.requests == [("GET", "/api/states", "Bearer ha-token", None)]


@pytest.mark.parametrize("copy", GLUCOSE)
def test_glucose_uses_the_hive_and_keeps_watch_state_in_mind_memory(tmp_path, monkeypatch, connector_server, copy):
    hive = connector_server
    mind = tmp_path / "mind"
    module, code = _module_checkout(tmp_path, copy, monkeypatch, **hive.env, OMEGACLAW_MEMORY_DIR=str(mind))
    patient = {"patientId": "patient-1", "firstName": "Example", "uom": 2}
    sample = {"Timestamp": "5/19/2026 12:34:00 AM", "Value": 6.2, "TrendArrow": 3, "GlucoseUnits": 2}
    reply = {"data": {"connection": {**patient, "glucoseMeasurement": sample}}}
    hive.replies.extend([
        (200, {"unit": "mmol/L", "connections": {"Example": "patient-1"}, "version": "4.16.0"}),
        (200, {"data": [patient]}),
        (200, reply),
    ])

    module.set_glucose_watch("Example", 4, 12, 0, "", "")
    module.pending_glucose_rings()

    assert hive.requests == [
        ("POST", "/api/agent/connectors/librelinkup/request", "Bearer mind-token", call)
        for call in ({"op": "settings"}, {"op": "connections"}, {"op": "graph", "patient_id": "patient-1"})
    ]
    state = json.loads((mind / "glucose_state.json").read_text())
    assert state["app_state"]["Example"]["last_good_observation"]["value"] == 6.2
    assert set(state) == {"app_state", "seen_rings", "seen_measurements"}
    assert not (code / "memory").exists()
    assert not (code / copy).parents[1].joinpath("memory").exists()


@pytest.mark.parametrize(("message", "classification"), [
    ("LibreLinkUp HTTP 429: try again", "rate_limited"),
    ("LibreLinkUp login failed: check credentials", "login_failed"),
])
def test_glucose_classifies_hive_service_errors(tmp_path, monkeypatch, connector_server, message, classification):
    hive = connector_server
    module, _ = _module_checkout(tmp_path, GLUCOSE[0], monkeypatch, **hive.env)
    hive.replies.append((502, {"error": {"code": "connector_error", "message": message}}))
    with pytest.raises(RuntimeError) as error:
        module._connections({})
    assert str(error.value) == message
    assert module._classify_error(error.value) == classification


@pytest.mark.parametrize("copy", GLUCOSE)
def test_standalone_glucose_keeps_its_login_and_private_session_file(tmp_path, monkeypatch, connector_server, copy):
    prefixes = ("LIBRE_LINK_UP_", "LIBRELINKUP_", "LIBREVIEW_")
    for name in tuple(os.environ):
        if name.startswith(prefixes):
            monkeypatch.delenv(name)
    service = connector_server
    module, code = _module_checkout(tmp_path, copy, monkeypatch, HIVE_WS_TOKEN="unused-token")
    memory = (code / copy).parents[1] / "memory"
    conf = {"url": service.base, "username": "owner@example.invalid", "password": "example-password"}
    _write_files(code, {str((memory / "librelinkup.json").relative_to(code)): json.dumps(conf).encode()})
    service.replies.extend([
        (200, {"data": {"authTicket": {"token": "llu-token", "expires": 4102444800}, "user": {"id": "me"}}}),
        (200, {"data": [{"patientId": "patient-1"}]}),
    ])
    opened = []
    real_open = os.open
    monkeypatch.setattr(module.os, "open",
                        lambda path, flags, mode=0o777: opened.append(mode) or real_open(path, flags, mode))
    assert module._connections(module._config()) == [{"patientId": "patient-1"}]
    assert service.requests == [
        ("POST", "/llu/auth/login", None, {"email": conf["username"], "password": conf["password"]}),
        ("GET", "/llu/connections", "Bearer llu-token", None),
    ]
    cache = memory / "librelinkup_cache.json"
    assert json.loads(cache.read_text())["token"] == "llu-token"
    assert opened == [0o600] and stat.S_IMODE(cache.stat().st_mode) == 0o600


def test_agentverse_starts_with_the_hive_seed_without_a_checkout_file(tmp_path, monkeypatch, connector_server):
    hive = connector_server
    mind = tmp_path / "mind"
    module, code = _module_checkout(tmp_path, AGENTVERSE, monkeypatch, **hive.env, OMEGACLAW_MEMORY_DIR=str(mind),
                                    OMEGACLAW_AGENTVERSE_SEED="unused-local-seed",
                                    OMEGACLAW_AGENTVERSE_ENDPOINT="https://listener.invalid")
    hive.replies.append((200, {"values": {"seed": "synthesized-listener-seed\n"}}))
    seen = {}
    monkeypatch.setattr(module.subprocess, "Popen", lambda args, **kwargs: seen.update(kwargs) or SimpleNamespace(pid=42))

    assert module.agentverse_start_listener().startswith("AGENTVERSE-LISTENER-STARTED pid=42")
    assert seen["env"]["OMEGACLAW_AGENTVERSE_SEED"] == "synthesized-listener-seed"
    assert hive.requests == [("POST", "/api/agent/connectors/agentverse/entries", "Bearer mind-token", {"get": ["seed"]})]
    assert module.TRACE_FILE.is_file()
    assert not (code / "memory").exists()


def test_standalone_agentverse_persists_its_listener_seed(tmp_path, monkeypatch):
    for name in ("OMEGACLAW_AGENTVERSE_SEED", "AGENTVERSE_SEED_PHRASE"):
        monkeypatch.delenv(name, raising=False)
    module, code = _module_checkout(tmp_path, AGENTVERSE, monkeypatch)
    seed = module._listener_seed()
    saved = code / "memory/runtime/agentverse/local_seed.txt"
    assert saved.read_text() == seed + "\n"
    assert stat.S_IMODE(saved.stat().st_mode) == 0o600
    assert module._listener_seed() == seed


@pytest.mark.parametrize("copy", WHATSAPP)
@pytest.mark.parametrize("auth_mode", ["hive", "standalone-default", "standalone-override"])
def test_whatsapp_starts_the_bridge_with_the_selected_auth_backend(tmp_path, monkeypatch, connector_server, copy, auth_mode):
    hive = connector_server
    extra = hive.env if auth_mode == "hive" else {"HIVE_API_URL": hive.base}
    module, code = _module_checkout(tmp_path, copy, monkeypatch, **extra)
    configured_auth = str(tmp_path / "custom-auth")
    if auth_mode != "standalone-default":
        monkeypatch.setenv("OMEGACLAW_WA_AUTH_DIR", configured_auth)
    seen = {}
    monkeypatch.setattr(module, "_bridge_alive", lambda: False)
    monkeypatch.setattr(module.subprocess, "Popen", lambda args, **kwargs: seen.update(kwargs) or "process")

    assert module.start_whatsapp() == "process"
    env = seen["env"]
    if auth_mode == "hive":
        assert env["OMEGACLAW_WA_AUTH"] == "hive"
        assert "OMEGACLAW_WA_AUTH_DIR" not in env
        assert all(env[key] == value for key, value in hive.env.items())
    else:
        assert "OMEGACLAW_WA_AUTH" not in env
        default = str((code / copy).parent / "whatsapp_bridge/auth")
        assert env["OMEGACLAW_WA_AUTH_DIR"] == (configured_auth if auth_mode == "standalone-override" else default)


@pytest.mark.parametrize("copy", WHATSAPP)
def test_hive_whatsapp_reuses_only_an_authenticated_bridge(tmp_path, monkeypatch, connector_server, copy):
    bridge = connector_server
    module, _ = _module_checkout(tmp_path, copy, monkeypatch, **bridge.env)
    key = hmac.digest(b"mind-token", b"omegahive whatsapp bridge/1", "sha256")

    def status(headers):
        nonce = headers["X-Hive-WhatsApp-Challenge"].encode("ascii")
        ask = hmac.digest(key, b"status-request:" + nonce, "sha256").hex()
        assert headers["Authorization"] == f"Bearer {ask}"
        return {"ok": True, "proof": hmac.digest(key, b"status-response:" + nonce, "sha256").hex()}

    bridge.replies.extend([(200, status), (200, {"ok": True})])
    assert module.start_whatsapp(port=bridge.port, primary_jid="100@s.whatsapp.net") == "WHATSAPP-BRIDGE-EXISTING"
    assert [call[:2] for call in bridge.requests] == [("GET", "/status"), ("POST", "/primary")]
    assert bridge.requests[1][2] == f"Bearer {key.hex()}"


@pytest.mark.parametrize("copy", WHATSAPP)
@pytest.mark.parametrize(("http_status", "reply"), [(401, {"ok": False}), (200, {"ok": True})])
def test_hive_whatsapp_refuses_an_unverified_listener(
    tmp_path, monkeypatch, connector_server, copy, http_status, reply
):
    bridge = connector_server
    module, _ = _module_checkout(tmp_path, copy, monkeypatch, **bridge.env)
    bridge.replies.extend([(http_status, reply), (http_status, reply)])
    with pytest.raises(RuntimeError, match=rf"port {bridge.port}: .* did not authenticate"):
        module.start_whatsapp(port=bridge.port, primary_jid="100@s.whatsapp.net")
    assert "did not authenticate" in module.status()
    assert [call[:2] for call in bridge.requests] == [("GET", "/status"), ("GET", "/status")]
    key = hmac.digest(b"mind-token", b"omegahive whatsapp bridge/1", "sha256").hex()
    assert all(auth != f"Bearer {key}" for _, _, auth, _ in bridge.requests)


#: every runtime state path the move put in the mind's memory folder, by module
STATE = [
    ("modules/home_assistant/bridge/home_assistant.py", ["ACTION_LOG"]),
    ("src/glucose.py", ["TRACE_LOG", "WATCH_FILE"]),
    ("modules/health_glucose/src/glucose.py", ["TRACE_LOG", "WATCH_FILE"]),
    ("modules/assume/src/assume_client.py", ["TRACE_PATH", "ASSUME_PATH", "STDERR_PATH"]),
    ("modules/codex_code/src/codex_code.py", ["TRACE_FILE", "JOBS_DIR", "EVENTS_FILE"]),
    ("modules/body_container/src/body_container.py", ["STATE_DIR"]),
    ("modules/omega_vm/src/omega_vm.py", ["STATE_DIR"]),
    ("modules/vm_policy/src/vm_policy.py", ["TRACE_FILE"]),
    ("modules/gameboy/src/gameboy.py", ["STATE_DIR"]),
    ("modules/agentverse/src/agentverse_bridge.py", ["TRACE_FILE", "REGISTRY_FILE", "LISTENER_STATE_FILE",
                                                     "LISTENER_INBOX_FILE", "LISTENER_COMMAND_FILE"]),
]


@pytest.mark.parametrize("rel,names", STATE, ids=[rel for rel, _ in STATE])
def test_a_minds_runtime_state_goes_in_its_own_memory_folder(tmp_path, monkeypatch, rel, names):
    monkeypatch.syspath_prepend(str(ROOT / "modules/assume/src"))   # assume_client imports its sibling
    mind = tmp_path / "mind"
    hived = _module(ROOT / rel, "state_hive", monkeypatch, OMEGACLAW_MEMORY_DIR=str(mind))
    plain = _module(ROOT / rel, "state_plain", monkeypatch)
    home = (ROOT / rel).parents[1] if rel.endswith("glucose.py") else ROOT   # each glucose copy's own ROOT
    for name in names:
        assert pathlib.Path(getattr(hived, name)).is_relative_to(mind), name
        assert pathlib.Path(getattr(plain, name)).is_relative_to(home / "memory"), name
