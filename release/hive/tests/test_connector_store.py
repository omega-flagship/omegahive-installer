"""Purpose: test the hive side of connector secrets (hive/core/connectors.py, sealed.py, connector_calls.py): where the key
lives on each platform and that the store never makes a new key over sealed entries; that a mind gets only its owner's
entries for connectors its owner installed on it; the Home Assistant and LibreLinkUp calls the hive makes with the
owner's secret; the entries it serves WhatsApp and Agentverse; what a mind and a container are given; and the one-time
import of the plain files a checkout or an earlier release's connectors folder holds."""

import http.server
import io
import json
import logging
import os
import pathlib
import shutil
import stat
import subprocess
import threading
import time
import urllib.error
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from hive.core import app as app_module
from hive.core import connector_calls, connectors, sealed
from hive.core import updates as updates_module
from hive.core.config import load_settings
from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_core_api import PETTA, FakeSupervisor

needs_petta = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


# ---- the key's home --------------------------------------------------------------------------------------------------

class Runner:
    """A stand-in for subprocess.run that records each command and answers from a table of (argv prefix) -> handler."""

    def __init__(self, **answers):
        self.calls, self.answers = [], answers

    def __call__(self, args, input=None, capture_output=True, text=True, check=False):
        self.calls.append((list(args), input))
        for prefix, answer in self.answers.items():
            if " ".join(args).startswith(prefix.replace("_", " ")):
                return answer(args, input)
        raise FileNotFoundError(args[0])


def done(code=0, out="", err=""):
    return subprocess.CompletedProcess([], code, out, err)


def settings_at(tmp_path, **extra):
    return SimpleNamespace(data_dir=tmp_path / "data", secrets_key_file=None, **extra)


def test_the_key_home_is_chosen_by_one_rule(tmp_path):
    s = settings_at(tmp_path)
    linux = lambda version: Runner(**{"systemd-creds --version": lambda a, i: done(0, f"systemd {version} (x)\n")})
    assert sealed.choose_home(s, False, Runner(), "darwin") == {"home": "keychain"}
    assert sealed.choose_home(s, False, linux(259), "linux") == {"home": "systemd-creds"}
    old = sealed.choose_home(s, False, linux(255), "linux")
    assert old["home"] == "fallback-file" and "systemd 255" in old["warning"] and "home folder" in old["warning"]
    assert sealed.choose_home(s, False, Runner(), "linux")["home"] == "fallback-file"   # no systemd-creds at all
    throwaway = sealed.choose_home(s, True, linux(259), "linux")
    assert throwaway["home"] == "throwaway" and "protects nothing" in throwaway["warning"]
    named = settings_at(tmp_path)
    named.secrets_key_file = tmp_path / "k"
    assert sealed.choose_home(named, True, Runner(), "darwin") == {"home": "key-file"}   # the operator's file wins


def test_a_mac_keeps_the_key_in_the_login_keychain_written_over_stdin(tmp_path):
    kept = {}

    def find(args, _input):
        return done(0, kept["key"] + "\n") if "key" in kept else done(44, "", "could not be found")

    def add(args, line):
        kept["key"] = line.split(" -w ")[1].split()[0]
        return done(0)

    runner = Runner(**{"/usr/bin/security find-generic-password": find, "/usr/bin/security -i": add})
    key, info = sealed.open_key(settings_at(tmp_path), tmp_path / "data" / "connectors", 0, False, runner, "darwin")
    assert info == {"home": "keychain"} and key.decode() == kept["key"]
    assert all(kept["key"] not in " ".join(args) for args, _ in runner.calls)   # never in a command line
    assert any(stdin and kept["key"] in stdin for _, stdin in runner.calls)     # only on stdin
    again, _ = sealed.open_key(settings_at(tmp_path), tmp_path, 3, False, runner, "darwin")
    assert again == key and sum(a[:2] == ["/usr/bin/security", "-i"] for a, _ in runner.calls) == 1


def test_a_locked_keychain_or_a_lost_key_shuts_the_store_and_never_makes_a_new_key(tmp_path):
    locked = Runner(**{"/usr/bin/security find-generic-password": lambda a, i: done(
        36, "", "security: SecKeychainCopySettings: User interaction is not allowed.")})
    with pytest.raises(sealed.StoreLocked, match="login session"):
        sealed.open_key(settings_at(tmp_path), tmp_path, 0, False, locked, "darwin")
    gone = Runner(**{"/usr/bin/security find-generic-password": lambda a, i: done(44, "", "not found"),
                     "/usr/bin/security -i": lambda a, i: pytest.fail("made a key over sealed entries")})
    with pytest.raises(sealed.StoreLocked, match="restore it"):
        sealed.open_key(settings_at(tmp_path), tmp_path, 2, False, gone, "darwin")


def creds_runner(version=259):
    """A stand-in systemd-creds that seals by writing the value base64-free beside a marker (the real one is tested
    below where this machine has it)."""
    def encrypt(args, value):
        pathlib.Path(args[-1]).write_text("SEALED:" + value)
        return done(0)

    def decrypt(args, _input):
        text = pathlib.Path(args[-2]).read_text()
        return done(0, text[len("SEALED:"):]) if text.startswith("SEALED:") else done(1, "", "Failed to decrypt")
    return Runner(**{"systemd-creds --version": lambda a, i: done(0, f"systemd {version} (x)\n"),
                     "systemd-creds --user --name=omegahive-connectors encrypt": encrypt,
                     "systemd-creds --user --name=omegahive-connectors decrypt": decrypt})


def test_linux_seals_the_key_with_systemd_creds_in_the_connectors_folder(tmp_path):
    folder = tmp_path / "data" / "connectors"
    runner = creds_runner()
    key, info = sealed.open_key(settings_at(tmp_path), folder, 0, False, runner, "linux")
    cred = folder / sealed.CRED_FILE
    assert info == {"home": "systemd-creds"} and mode(cred) == 0o600 and mode(folder) == 0o700
    assert all(key.decode() not in " ".join(args) for args, _ in runner.calls)
    assert sealed.open_key(settings_at(tmp_path), folder, 5, False, runner, "linux")[0] == key
    cred.write_text("garbage")
    with pytest.raises(sealed.StoreLocked, match="did not open for this user"):
        sealed.open_key(settings_at(tmp_path), folder, 5, False, runner, "linux")
    cred.unlink()
    with pytest.raises(sealed.StoreLocked, match="missing"):
        sealed.open_key(settings_at(tmp_path), folder, 5, False, runner, "linux")


def test_older_linux_keeps_a_private_key_file_outside_the_data_folder_and_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    key, info = sealed.open_key(settings_at(tmp_path), tmp_path / "data" / "connectors", 0, False, creds_runner(255),
                                "linux")
    path = sealed.fallback_file(tmp_path / "data")
    assert info["home"] == "fallback-file" and "warning" in info and path.read_text().strip() == key.decode()
    assert mode(path) == 0o600 and mode(path.parent) == 0o700 and (tmp_path / "data") not in path.parents


def test_a_named_key_file_is_read_and_never_written(tmp_path):
    named = tmp_path / "secrets" / "hive.key"
    s = settings_at(tmp_path)
    s.secrets_key_file = named
    with pytest.raises(sealed.StoreLocked, match="does not exist"):
        sealed.open_key(s, tmp_path, 0, False, Runner(), "linux")
    named.parent.mkdir()
    named.write_text("not a key")
    with pytest.raises(sealed.StoreLocked, match="Fernet key"):
        sealed.open_key(s, tmp_path, 0, False, Runner(), "linux")
    good = Fernet.generate_key()
    named.write_text(good.decode() + "\n")
    assert sealed.open_key(s, tmp_path, 0, False, Runner(), "linux") == (good, {"home": "key-file"})


@pytest.mark.skipif(shutil.which("systemd-creds") is None or (sealed._systemd_version(subprocess.run) or 0) < 256,
                    reason="needs systemd-creds 256 or later")
def test_systemd_creds_really_seals_and_opens_the_key_for_this_user(tmp_path):
    folder = tmp_path / "connectors"
    key, info = sealed.open_key(settings_at(tmp_path), folder, 0, False, subprocess.run, "linux")
    assert info == {"home": "systemd-creds"} and key.decode() not in (folder / sealed.CRED_FILE).read_text()
    assert sealed.open_key(settings_at(tmp_path), folder, 1, False, subprocess.run, "linux")[0] == key


def test_the_seal_binds_each_value_to_its_owner_connector_and_name():
    seal = sealed.Seal(Fernet.generate_key())
    token = seal.seal("user:ana", "home_assistant", "settings", '{"token": "ha-secret"}')
    assert "ha-secret" not in token
    assert seal.open("user:ana", "home_assistant", "settings", token) == '{"token": "ha-secret"}'
    for other in (("user:bo", "home_assistant", "settings"), ("user:ana", "librelinkup", "settings")):
        with pytest.raises(sealed.StoreLocked):
            seal.open(*other, token)
    with pytest.raises(sealed.StoreLocked):
        sealed.Seal(Fernet.generate_key()).open("user:ana", "home_assistant", "settings", token)
    name = seal.name("user:ana", "whatsapp", "session-61400000000.0.json")
    assert "61400000000" not in name and name != seal.name("user:bo", "whatsapp", "session-61400000000.0.json")


# ---- the hive: people, installs and minds ---------------------------------------------------------------------------

class HomeAssistant(http.server.BaseHTTPRequestHandler):
    seen = []

    def _answer(self):
        self.seen.append((self.command, self.path, self.headers.get("Authorization"),
                          self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()))
        if self.path == "/api/states/redirect.me":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9/elsewhere")
            self.end_headers()
            return
        body = b"[]" if self.path == "/api/states" else b"rendered text"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = _answer

    def log_message(self, *args):
        pass


@pytest.fixture()
def home_assistant():
    HomeAssistant.seen = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HomeAssistant)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(updates_module, "_git", lambda *args: "7f4b88bb04b925ae97f804c11952f2a78496654e")
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA, offline=True)
    app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as client:
        hive = app.state.hive
        people = {}
        for person_id, name in (("u_ana", "Ana"), ("u_bo", "Bo")):
            hive.db.insert("people", {"id": person_id, "email": name.lower() + "@example.test", "name": name,
                                      "role": "member", "created_at": now(), "disabled": 0})
            token = "session-" + person_id
            hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                        "principal": "user:" + person_id, "expires_at": time.time() + 900})
            people[name] = {"principal": "user:" + person_id, "headers": {"Authorization": "Bearer " + token}}
        yield client, hive, people


def mind(hive, person, kind="omega"):
    agent = hive.create_agent("Helper", kind, None, "mock/echo", owner=person["principal"])
    return agent, {"Authorization": "Bearer " + agent["token"]}


@needs_petta
def test_a_persons_settings_are_theirs_and_never_shown_back(env, home_assistant):
    client, hive, people = env
    ana = people["Ana"]["headers"]
    assert client.get("/api/connectors").status_code == 401
    bad = client.put("/api/connectors/home_assistant/settings", json={"url": "ftp://x", "token": "t"}, headers=ana)
    assert bad.status_code == 400
    row = client.put("/api/connectors/home_assistant/settings", json={"url": home_assistant, "token": "ha-ana-secret"},
                     headers=ana)
    assert row.status_code == 200 and row.json()["fields"] == ["token", "url"] and "ha-ana-secret" not in row.text
    status = client.get("/api/connectors", headers=ana)
    assert status.headers["cache-control"] == "no-store" and "ha-ana-secret" not in status.text
    assert next(c for c in status.json()["connectors"] if c["id"] == "home_assistant")["set"] is True
    bo = client.get("/api/connectors", headers=people["Bo"]["headers"]).json()
    assert next(c for c in bo["connectors"] if c["id"] == "home_assistant")["set"] is False
    stored = hive.db.all("SELECT value FROM connector_entries")
    assert stored and all("ha-ana-secret" not in r["value"] for r in stored)   # sealed at rest
    gone = client.delete("/api/connectors/home_assistant", headers=ana).json()
    assert gone["set"] is False and hive.db.all("SELECT * FROM connector_entries") == []


@needs_petta
def test_only_a_minds_owner_installs_on_it_and_whatsapp_goes_on_one_mind(env):
    client, hive, people = env
    ana, bo = people["Ana"], people["Bo"]
    first, _ = mind(hive, ana)
    second, _ = mind(hive, ana)
    bos, _ = mind(hive, bo)
    iter_mind, _ = mind(hive, ana, kind="iter")
    put = lambda who, agent, on: client.put(f"/api/connectors/whatsapp/minds/{agent['id']}", json={"installed": on},
                                            headers=who["headers"])
    assert put(ana, bos, True).status_code == 404       # the hive hides a mind Ana cannot see before the owner check
    with pytest.raises(Exception, match="only a mind's owner"):
        hive.connectors.install(ana["principal"], "whatsapp", bos["id"], True)   # and the store refuses it on its own
    assert put(ana, iter_mind, True).status_code == 409
    assert put(ana, first, True).json()["minds"] == [first["id"]]
    moved = put(ana, second, True).json()
    assert moved["minds"] == [second["id"]]                       # WhatsApp moved off the first mind
    assert client.put(f"/api/connectors/home_assistant/minds/{first['id']}", json={"installed": True},
                      headers=ana["headers"]).json()["minds"] == [first["id"]]
    assert client.put(f"/api/connectors/home_assistant/minds/{second['id']}", json={"installed": True},
                      headers=ana["headers"]).json()["minds"] == sorted([first["id"], second["id"]])
    assert client.put(f"/api/connectors/home_assistant/minds/{first['id']}", json={"installed": "yes"},
                      headers=ana["headers"]).status_code == 400


@needs_petta
def test_the_hive_makes_home_assistants_calls_with_the_installing_owners_token(env, home_assistant):
    client, hive, people = env
    ana = people["Ana"]
    client.put("/api/connectors/home_assistant/settings", json={"url": home_assistant, "token": "ha-ana-secret"},
               headers=ana["headers"])
    agent, as_mind = mind(hive, ana)
    call = lambda body: client.post("/api/agent/connectors/home_assistant/request", json=body, headers=as_mind)
    assert call({"method": "GET", "path": "/api/states"}).status_code == 403        # not installed yet
    assert HomeAssistant.seen == []
    client.put(f"/api/connectors/home_assistant/minds/{agent['id']}", json={"installed": True}, headers=ana["headers"])
    states = call({"method": "GET", "path": "/api/states"})
    assert states.status_code == 200 and states.json() == {"status": 200, "text": "[]"}
    assert "ha-ana-secret" not in states.text
    assert call({"method": "POST", "path": "/api/template", "payload": {"template": "{{ 1 }}"}}).json()["text"] == \
        "rendered text"
    assert HomeAssistant.seen[0][:3] == ("GET", "/api/states", "Bearer ha-ana-secret")
    for body in ({"method": "GET", "path": "/api/config"}, {"method": "POST", "path": "/api/states"},
                 {"method": "GET", "path": "/api/states/../config"}, {"method": "DELETE", "path": "/api/states"}):
        assert call(body).status_code == 400
    redirected = call({"method": "GET", "path": "/api/states/redirect.me"}).json()
    assert redirected["status"] == 302                              # refused, not followed with the token
    bo_mind, as_bo_mind = mind(hive, people["Bo"])
    client.put(f"/api/connectors/home_assistant/minds/{bo_mind['id']}", json={"installed": True},
               headers=people["Bo"]["headers"])
    refused = client.post("/api/agent/connectors/home_assistant/request", json={"method": "GET", "path": "/api/states"},
                          headers=as_bo_mind)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "connector_not_set"   # never Ana's


@needs_petta
def test_a_mind_that_changes_hands_loses_what_its_old_owner_installed(env):
    client, hive, people = env
    agent, as_mind = mind(hive, people["Ana"])
    client.put(f"/api/connectors/whatsapp/minds/{agent['id']}", json={"installed": True},
               headers=people["Ana"]["headers"])
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (people["Bo"]["principal"], agent["id"]))
    got = client.post("/api/agent/connectors/whatsapp/entries", json={"get": ["creds.json"]}, headers=as_mind)
    assert got.status_code == 403
    assert hive.connectors.installed_modules({"id": agent["id"], "kind": "omega", "owner": people["Bo"]["principal"]}) \
        == []


@needs_petta
def test_the_hive_serves_whatsapp_and_agentverse_entries_only_to_installed_minds(env):
    client, hive, people = env
    ana = people["Ana"]
    agent, as_mind = mind(hive, ana)
    entries = lambda c, body, who=as_mind: client.post(f"/api/agent/connectors/{c}/entries", json=body, headers=who)
    assert entries("whatsapp", {"get": ["creds.json"]}).status_code == 403
    for connector in ("whatsapp", "agentverse"):
        client.put(f"/api/connectors/{connector}/minds/{agent['id']}", json={"installed": True}, headers=ana["headers"])
    creds = json.dumps({"registered": True, "me": {"id": "61400000000:7@s.whatsapp.net"}})
    assert entries("whatsapp", {"set": {"creds.json": creds, "pre-key-1.json": "{}"}, "get": ["creds.json"]}).json() == \
        {"values": {"creds.json": creds}}
    assert entries("whatsapp", {"delete": ["pre-key-1.json"], "get": ["pre-key-1.json", "nothing.json"]}).json() == \
        {"values": {"pre-key-1.json": None, "nothing.json": None}}
    assert entries("whatsapp", {"get": ["../creds.json"]}).status_code == 400
    assert entries("home_assistant", {"get": ["settings"]}).status_code == 400   # the hive calls it; it serves nothing
    seed = entries("agentverse", {"get": ["seed"]}).json()["values"]["seed"]
    assert seed.startswith("omega agentverse local listener ")
    assert entries("agentverse", {"get": ["seed"]}).json()["values"]["seed"] == seed      # made once, then kept
    for body in ({"set": {"seed": "mine now"}}, {"delete": ["seed"]}, {"get": ["notes.txt"]}):
        assert entries("agentverse", body).status_code == 400                             # the seed is the hive's
    assert entries("agentverse", {"get": ["seed"]}).json()["values"]["seed"] == seed
    other, as_other = mind(hive, people["Bo"])
    client.put(f"/api/connectors/whatsapp/minds/{other['id']}", json={"installed": True},
               headers=people["Bo"]["headers"])
    assert entries("whatsapp", {"get": ["creds.json"]}, as_other).json() == {"values": {"creds.json": None}}


def test_librelinkup_calls_log_in_keep_the_session_and_log_in_again_once():
    calls, sessions = [], []

    class Answer(io.BytesIO):
        def __init__(self, status, body):
            super().__init__(json.dumps(body).encode())
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Opener:
        expired = True

        def open(self, request, timeout):
            calls.append((request.get_method(), request.full_url, request.headers.get("Authorization")))
            if request.full_url.endswith("/llu/auth/login"):
                return Answer(200, {"data": {"authTicket": {"token": f"llu-{len(calls)}",
                                                            "expires": int(time.time()) + 3600},
                                             "user": {"id": "user-1"}}})
            if Opener.expired:
                Opener.expired = False
                raise urllib.error.HTTPError(request.full_url, 401, "expired", {}, io.BytesIO(b"expired"))
            return Answer(200, {"data": [{"patientId": "p-1", "firstName": "Ana"}]})

    login = {"username": "ana@example.test", "password": "llu-password"}
    answer = connector_calls.librelinkup(login, "connections", None, lambda: sessions[-1] if sessions else None,
                                         sessions.append, Opener())
    assert answer == {"data": [{"patientId": "p-1", "firstName": "Ana"}]}
    logins = [c for c in calls if c[1].endswith("/llu/auth/login")]
    assert len(logins) == 2 and calls[0][1].startswith(connector_calls.LIBRELINKUP_BASES[0])   # once, then once again
    assert calls[-1][2] == f"Bearer {sessions[-1]['token']}" and len(sessions) == 2
    assert "llu-password" not in json.dumps(connector_calls.librelinkup_public(login))
    with pytest.raises(connector_calls.NotAllowed):
        connector_calls.librelinkup(login, "graph", "../x", lambda: sessions[-1], sessions.append, Opener())


# ---- what a mind and a container are given ---------------------------------------------------------------------------

def test_a_container_gets_no_connectors_mount_or_folder_variable(tmp_path):
    from hive.supervisor.drivers import DockerDriver
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw")
    root = tmp_path / "mind"
    (root / "memory").mkdir(parents=True)
    workspace = SimpleNamespace(path=lambda agent_id: root, settings=settings, runtime_core=lambda: tmp_path / "core",
                                chromadb_lib=lambda: tmp_path / "chromadb")
    driver = DockerDriver(workspace, image="omegadots/agent:test")
    calls = []
    driver._docker = lambda *args, **kw: calls.append(args) or SimpleNamespace(returncode=0, stdout="")
    driver.status = lambda agent_id: "absent"
    driver.start({"id": "a_one", "kind": "omega"}, {"HIVE_API_URL": "http://hive:8700", "HIVE_WS_TOKEN": "t"})
    run = " ".join(next(args for args in calls if args and args[0] == "run"))
    assert "/agent/connectors" not in run and "CONNECTORS" not in run and "HIVE_API_URL=http://hive:8700" in run


def test_a_mind_is_told_no_connectors_folder_only_how_to_ask_its_hive(tmp_path):
    from hive.supervisor.workspace import Workspace
    workspace = Workspace(load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA))
    workspace.path("a_one").mkdir(parents=True)
    (workspace.path("a_one") / "token").write_text("mind-token")
    env = workspace.env({"id": "a_one", "kind": "omega", "options": {}}, "ws://h/ws", "http://h")
    assert not [key for key in env if "CONNECTORS" in key]
    assert env["HIVE_API_URL"] == "http://h" and env["HIVE_WS_TOKEN"] == "mind-token"


def test_a_native_mind_may_read_no_connector_folder(tmp_path):
    from hive.supervisor.drivers import LocalDriver
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw")
    driver = LocalDriver(SimpleNamespace(settings=settings), "/nonexistent")
    assert not any(connectors.FOLDER in pathlib.Path(root).parts for root in driver.read_roots())
    assert str(settings.data_dir.resolve()) not in driver.read_roots()   # never the whole data folder


def test_only_a_data_folder_in_the_temporary_folder_is_a_throwaway(tmp_path):
    import tempfile
    assert connectors._throwaway(os.path.join(tempfile.gettempdir(), "hive-test-x", "connectors"))
    assert connectors._throwaway(tmp_path / "data" / "connectors")      # pytest's own folder, in the system's
    assert not connectors._throwaway(os.path.expanduser("~/.omegadots/hive/connectors"))   # a real hive's default


def test_a_throwaway_hive_says_loudly_that_its_key_protects_nothing(tmp_path, caplog):
    from hive.core.db import Database
    db = Database(tmp_path / "hive.db")
    with caplog.at_level(logging.WARNING, logger="hive"):
        store = connectors.ConnectorStore(SimpleNamespace(db=db), settings_at(tmp_path))   # pytest's folder: temporary
    assert "is in a temporary folder" in caplog.text and "imports nothing a checkout holds" in caplog.text
    assert store.info()["home"] == "throwaway" and "protects nothing" in store.info()["warning"]


def test_an_installed_connector_loads_its_module_and_one_the_host_loads_is_left_alone(tmp_path, monkeypatch):
    from hive.supervisor.workspace import RUN_METTA, Workspace, module_import
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA, offline=True)
    workspace = Workspace(settings)
    root = workspace.path("a_one")
    root.mkdir(parents=True)
    (root / "run.metta").write_text(RUN_METTA)
    agent = {"id": "a_one", "kind": "omega"}
    workspace.write_module_imports(agent, {"hive_studio": False, "channel_whatsapp": True, "home_assistant": False})
    text = (root / "run.metta").read_text()
    assert module_import("channel_whatsapp") in text and module_import("home_assistant") not in text
    assert text.index(module_import("channel_whatsapp")) < text.index("!(omegaclaw)")
    workspace.write_module_imports(agent, {"channel_whatsapp": False})
    assert module_import("channel_whatsapp") not in (root / "run.metta").read_text()
    store = connectors.ConnectorStore.__new__(connectors.ConnectorStore)
    store.hive = SimpleNamespace(db=SimpleNamespace(all=lambda sql, params: [{"connector": "whatsapp"},
                                                                              {"connector": "home_assistant"}]))
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: {"home_assistant"})
    assert store.installed_modules({"id": "a_one", "kind": "omega", "owner": "user:ana"}) == ["channel_whatsapp"]
    assert store.installed_modules({"id": "a_one", "kind": "iter", "owner": "user:ana"}) == []


# ---- the one-time import --------------------------------------------------------------------------------------------

LEGACY_FILES = {
    "memory/home_assistant.json": json.dumps({"url": "http://homeassistant.local:8123", "token": "ha-legacy-token"}),
    "modules/health_glucose/memory/librelinkup.json": json.dumps({"email": "ana@example.test", "password": "llu-pw"}),
    "modules/health_glucose/memory/librelinkup_cache.json": json.dumps({
        "base_url": "https://api-eu.libreview.io", "token": "llu-session", "expires": 1999999999, "account_id": "a",
        "seen_rings": {"ana": "2026-11-18T00:00:00Z"}}),
    "memory/runtime/agentverse/local_seed.txt": "omega agentverse local listener legacyseed\n",
    "modules/channel_whatsapp/src/whatsapp_bridge/auth/creds.json": json.dumps({"registered": True}),
    "modules/channel_whatsapp/src/whatsapp_bridge/auth/pre-key-1.json": json.dumps({"private": "k"}),
}


def legacy(base, files=LEGACY_FILES):
    for rel, text in files.items():
        (base / rel).parent.mkdir(parents=True, exist_ok=True)
        (base / rel).write_text(text)
    return base


@pytest.fixture()
def importing(tmp_path, monkeypatch):
    """A hive store whose data folder counts as a real one (not a throwaway), its key in a named key file."""
    monkeypatch.setattr(connectors, "_throwaway", lambda folder: False)
    key = tmp_path / "hive.key"
    key.write_text(Fernet.generate_key().decode())
    from hive.core.db import Database
    db = Database(tmp_path / "hive.db")
    db.execute("CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, "
               "invited_by TEXT, created_at TEXT, last_seen_at TEXT, disabled INTEGER NOT NULL DEFAULT 0, google_sub TEXT)")
    for column in ("owner TEXT", "personal_of TEXT"):
        try:
            db.execute(f"ALTER TABLE agents ADD COLUMN {column}")
        except Exception:   # noqa: BLE001 - the column exists in this schema already
            pass
    from hive.core import person_swarms, studio_makers
    for statement in (*studio_makers.SCHEMA, *person_swarms.SCHEMA):   # person_minds, app_person_minds
        db.execute(statement)
    settings = SimpleNamespace(data_dir=tmp_path / "data", secrets_key_file=key, agents_dir=tmp_path / "data" / "agents")
    store = connectors.ConnectorStore(SimpleNamespace(db=db), settings)
    return store, db, tmp_path


def add_mind(db, agent_id, owner, created):
    db.execute("INSERT INTO agents (id, name, kind, model, hue, status, driver, token_hash, created_at, owner) "
               "VALUES (?, 'm', 'omega', 'mock/echo', 0, 'stopped', 'local', 'x', ?, ?)", (agent_id, created, owner))


def test_a_checkouts_plain_secrets_become_the_first_admins_sealed_entries(importing, monkeypatch):
    store, db, tmp_path = importing
    code = legacy(tmp_path / "code")
    db.execute("INSERT INTO people (id, email, role, created_at) VALUES ('u_admin', 'a@x', 'admin', '2026-01-01')")
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    report = store.import_legacy(code)
    assert sorted(report) == sorted([
        "imported memory/home_assistant.json as user:u_admin's home_assistant",
        "imported modules/health_glucose/memory/librelinkup.json as user:u_admin's librelinkup",
        "imported modules/health_glucose/memory/librelinkup_cache.json as user:u_admin's librelinkup",
        "imported memory/runtime/agentverse/local_seed.txt as user:u_admin's agentverse",
        "imported modules/channel_whatsapp/src/whatsapp_bridge/auth as user:u_admin's whatsapp"])
    assert not any((code / rel).exists() for rel in LEGACY_FILES)
    assert json.loads(store._get("user:u_admin", "home_assistant", "settings")) == {
        "url": "http://homeassistant.local:8123", "token": "ha-legacy-token"}
    assert json.loads(store._get("user:u_admin", "librelinkup", "session"))["token"] == "llu-session"
    assert store._get("user:u_admin", "whatsapp", "pre-key-1.json") == json.dumps({"private": "k"})
    assert store._get("user:u_admin", "agentverse", "seed") == "omega agentverse local listener legacyseed"
    assert all(t not in r["value"] for r in db.all("SELECT value FROM connector_entries")
               for t in ("ha-legacy-token", "llu-pw", "legacyseed"))
    assert db.all("SELECT * FROM connector_installs") == []      # the host's loader loads none of them: none used
    assert store.import_legacy(code) == []                         # every start after the first finds nothing


def test_an_installer_update_carries_the_old_code_folders_secrets_to_the_next_starts_import(importing, monkeypatch):
    """The Mac and Windows installer deletes the code folder an update replaces before the hive starts; what it carried
    out of that folder first (connector_files.carry) is what the new hive's start imports."""
    from hive.core import connector_files
    store, db, tmp_path = importing
    old, new = legacy(tmp_path / "app.old"), tmp_path / "app"
    new.mkdir()
    db.execute("INSERT INTO people (id, email, role, created_at) VALUES ('u_admin', 'a@x', 'admin', '2026-01-01')")
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    lines, kept = connector_files.carry(old, tmp_path / "data", new)
    assert kept == 0 and all(line.startswith("carried ") for line in lines)
    report = store.import_legacy(new)
    assert sorted(report) == sorted([
        "imported connectors/memory/home_assistant.json as user:u_admin's home_assistant",
        "imported connectors/modules/health_glucose/memory/librelinkup.json as user:u_admin's librelinkup",
        "imported connectors/modules/health_glucose/memory/librelinkup_cache.json as user:u_admin's librelinkup",
        "imported connectors/memory/runtime/agentverse/local_seed.txt as user:u_admin's agentverse",
        "imported connectors/modules/channel_whatsapp/src/whatsapp_bridge/auth as user:u_admin's whatsapp"])
    assert json.loads(store._get("user:u_admin", "home_assistant", "settings")) == {
        "url": "http://homeassistant.local:8123", "token": "ha-legacy-token"}
    assert not any((store.folder / rel).exists() or (old / rel).exists() for rel in LEGACY_FILES)
    assert store.import_legacy(new) == []


def test_the_bridges_own_hive_auth_file_beside_a_pairing_is_code_and_never_imported_or_reported(importing, monkeypatch):
    """*auth* names the bridges' pairing folders; the hive-auth.mjs every release ships beside them is code, which the
    import neither takes nor reports on each start."""
    store, db, tmp_path = importing
    shipped = {"modules/channel_whatsapp/src/whatsapp_bridge/hive-auth.mjs": "// the bridge's own code\n",
               "channels/whatsapp_bridge/hive-auth.mjs": "// the bridge's own code\n"}
    code = legacy(tmp_path / "code", {**LEGACY_FILES, **shipped})
    db.execute("INSERT INTO people (id, email, role, created_at) VALUES ('u_admin', 'a@x', 'admin', '2026-01-01')")
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    report = store.import_legacy(code)
    assert len(report) == 5 and not any("hive-auth" in line for line in report)
    assert all((code / rel).read_text() == text for rel, text in shipped.items())
    assert store.import_legacy(code) == []


def test_what_the_host_loads_stays_installed_on_the_persons_own_minds_and_whatsapp_on_the_oldest(importing, monkeypatch):
    store, db, tmp_path = importing
    code = legacy(tmp_path / "code")
    db.execute("INSERT INTO people (id, email, role, created_at) VALUES ('u_admin', 'a@x', 'admin', '2025-01-01')")
    # the minds the hive made for itself and the person, older than any the person made: Create · Code's, an app's, and
    # the person's personal mind
    add_mind(db, "a_code", "user:u_admin", "2025-12-01")
    db.execute("INSERT INTO person_minds (principal, purpose, agent_id, created_at, updated_at) "
               "VALUES ('user:u_admin', 'foundation_create_code', 'a_code', '2025-12-01', '2025-12-01')")
    add_mind(db, "a_app", "user:u_admin", "2025-12-02")
    db.execute("INSERT INTO app_person_minds (principal, program_id, template_id, slot, agent_id, template_digest, "
               "created_at) VALUES ('user:u_admin', 'p_home', 't_home', 'main', 'a_app', 'digest', '2025-12-02')")
    add_mind(db, "a_personal", "user:u_admin", "2025-12-03")
    db.execute("UPDATE agents SET personal_of = 'user:u_admin' WHERE id = 'a_personal'")
    add_mind(db, "a_old", "user:u_admin", "2026-01-01")
    add_mind(db, "a_new", "user:u_admin", "2026-02-01")
    hive_made = ("a_code", "a_app", "a_personal")
    for agent_id in (*hive_made, "a_old", "a_new"):
        (tmp_path / "data" / "agents" / agent_id / "memory").mkdir(parents=True)
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: {"channel_whatsapp", "home_assistant",
                                                                    "health_glucose"})
    store.import_legacy(code)
    installs = {(r["agent_id"], r["connector"]) for r in db.all("SELECT agent_id, connector FROM connector_installs")}
    assert installs == {("a_old", "whatsapp"), ("a_old", "home_assistant"), ("a_new", "home_assistant"),
                        ("a_old", "librelinkup"), ("a_new", "librelinkup")}
    state = json.loads((tmp_path / "data" / "agents" / "a_new" / "memory" / "glucose_state.json").read_text())
    assert state == {"seen_rings": {"ana": "2026-11-18T00:00:00Z"}}   # the reader's own state, no session in it
    assert not any((tmp_path / "data" / "agents" / a / "memory" / "glucose_state.json").exists() for a in hive_made)


def test_an_earlier_releases_folder_is_imported_first_and_a_different_copy_is_kept(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    data_folder = legacy(tmp_path / "data" / "connectors", {"memory/home_assistant.json": LEGACY_FILES[
        "memory/home_assistant.json"]})
    code = legacy(tmp_path / "code", {"memory/home_assistant.json": json.dumps({"url": "http://other:8123",
                                                                                "token": "other"}),
                                      "memory/runtime/agentverse/local_seed.txt": "x"})
    (tmp_path / "data" / "connectors" / "memory" / "runtime" / "agentverse").mkdir(parents=True)
    os.symlink(code / "memory/runtime/agentverse/local_seed.txt",
               tmp_path / "data" / "connectors" / "memory/runtime/agentverse/local_seed.txt")
    report = store.import_legacy(code)
    assert "imported connectors/memory/home_assistant.json as user:operator's home_assistant" in report
    assert "kept memory/home_assistant.json: it differs from the copy imported before it" in report
    assert "kept connectors/memory/runtime/agentverse/local_seed.txt: it holds a link, which is never followed" in report
    assert (code / "memory/home_assistant.json").exists() and not (data_folder / "memory/home_assistant.json").exists()


def test_an_incomplete_or_unreadable_legacy_file_stays_where_it_is(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    code = legacy(tmp_path / "code", {"memory/home_assistant.json": json.dumps({"url": "http://ha:8123"}),
                                      "modules/channel_whatsapp/src/whatsapp_bridge/auth/notes.txt": "no creds"})
    (code / "memory/librelinkup.json").write_bytes(b"\xff\xfe not text")
    report = store.import_legacy(code)
    assert any(line.startswith("kept memory/home_assistant.json: it is not a complete login") for line in report)
    assert "kept modules/channel_whatsapp/src/whatsapp_bridge/auth: it holds no creds.json, so it is no pairing" in report
    assert "kept memory/librelinkup.json: it is not UTF-8 text" in report
    assert db.all("SELECT * FROM connector_entries") == []


def test_a_shut_store_keeps_every_legacy_file_and_the_next_start_that_opens_it_imports_them(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    code = legacy(tmp_path / "code")
    key = store.settings.secrets_key_file
    store.settings.secrets_key_file = tmp_path / "not-there.key"     # as a locked Keychain or a lost key file is
    report = store.import_legacy(code)
    assert len(report) == 5 and all(line.startswith("kept ") and "the connector store is shut" in line for line in report)
    assert all((code / rel).exists() for rel in LEGACY_FILES)
    assert db.all("SELECT * FROM connector_entries") == []
    store.settings.secrets_key_file = key
    assert all(line.startswith("imported ") for line in store.import_legacy(code))
    assert not any((code / rel).exists() for rel in LEGACY_FILES)


BRIDGE = "modules/channel_whatsapp/src/whatsapp_bridge"


def test_every_pairing_folder_is_imported_auth_the_live_one_and_each_other_sealed_aside(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    work = json.dumps({"registered": True, "me": {"id": "61400000001:2@s.whatsapp.net"}})
    code = legacy(tmp_path / "code", {**LEGACY_FILES, f"{BRIDGE}/auth_work/creds.json": work,
                                      f"{BRIDGE}/auth_work/session-61400000009.0.json": '{"s": "work-session"}',
                                      f"{BRIDGE}/auth_empty/notes.txt": "no pairing here",
                                      f"channels/whatsapp_bridge/auth_old/creds.json": json.dumps({"registered": False})})
    report = store.import_legacy(code)
    assert f"imported {BRIDGE}/auth as user:operator's whatsapp" in report
    assert (f"imported {BRIDGE}/auth_work as user:operator's whatsapp, kept aside: a person's minds use one pairing, "
            "auth") in report
    assert ("imported channels/whatsapp_bridge/auth_old as user:operator's whatsapp, kept aside: a person's minds use "
            "one pairing, auth") in report
    assert f"kept {BRIDGE}/auth_empty: it holds no creds.json, so it is no pairing" in report   # every match: imported or reported
    assert not (code / BRIDGE / "auth").exists() and not (code / BRIDGE / "auth_work").exists()
    assert (code / BRIDGE / "auth_empty" / "notes.txt").exists()
    assert store._get("user:operator", "whatsapp", "creds.json") == json.dumps({"registered": True})   # the live one
    assert json.loads(store._get("user:operator", "whatsapp", "pairings/auth_work")) == {
        "creds.json": work, "session-61400000009.0.json": '{"s": "work-session"}'}
    assert all("work-session" not in r["value"] for r in db.all("SELECT value FROM connector_entries"))   # sealed


def test_without_an_auth_folder_the_pairing_baileys_wrote_last_is_the_live_one(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    old, new = json.dumps({"registered": True, "me": {"id": "old"}}), json.dumps({"registered": True, "me": {"id": "new"}})
    code = legacy(tmp_path / "code", {f"{BRIDGE}/auth_a/creds.json": new, f"{BRIDGE}/auth_b/creds.json": old})
    os.utime(code / BRIDGE / "auth_a" / "creds.json", (2_000_000_000, 2_000_000_000))   # auth_a ran most recently
    os.utime(code / BRIDGE / "auth_b" / "creds.json", (1_000_000_000, 1_000_000_000))
    report = store.import_legacy(code)
    assert f"imported {BRIDGE}/auth_a as user:operator's whatsapp" in report
    assert store._get("user:operator", "whatsapp", "creds.json") == new
    assert json.loads(store._get("user:operator", "whatsapp", "pairings/auth_b")) == {"creds.json": old}


def test_the_pairing_the_hive_gave_its_minds_stays_live_over_auth(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    work = json.dumps({"registered": True, "me": {"id": "work"}})
    code = legacy(tmp_path / "code", {**LEGACY_FILES, f"{BRIDGE}/auth_work/creds.json": work})
    monkeypatch.setenv("OMEGACLAW_WA_AUTH_DIR", str(code / BRIDGE / "auth_work"))   # the variable reaches every mind
    report = store.import_legacy(code)
    assert f"imported {BRIDGE}/auth_work as user:operator's whatsapp" in report
    assert f"imported {BRIDGE}/auth as user:operator's whatsapp, kept aside: a person's minds use one pairing, auth_work" in report
    assert store._get("user:operator", "whatsapp", "creds.json") == work


def test_a_copy_an_interrupted_move_left_is_removed_and_its_original_imported(importing, monkeypatch):
    store, db, tmp_path = importing
    monkeypatch.setattr(connectors, "host_loader_modules", lambda: set())
    legacy(tmp_path / "data" / "connectors", {"memory/.home_assistant.json.moving": '{"url": "http://ha.loc',
                                              f"{BRIDGE}/.auth.moving/creds.json": "{}"})
    code = legacy(tmp_path / "code", {"memory/home_assistant.json": LEGACY_FILES["memory/home_assistant.json"]})
    report = store.import_legacy(code)
    for rel in ("memory/.home_assistant.json.moving", f"{BRIDGE}/.auth.moving"):
        assert f"removed connectors/{rel}: a copy an interrupted move left, its original imported instead" in report
        assert not (tmp_path / "data" / "connectors" / rel).exists()
    assert "imported memory/home_assistant.json as user:operator's home_assistant" in report
    assert store.import_legacy(code) == []


class _Minds:
    """A stand-in driver for every mind: which run (by execution id) and how many starts it made."""

    name = "local"

    def __init__(self, running=()):
        self.running, self.starts = {agent_id: f"old:{agent_id}" for agent_id in running}, 0

    def start(self, agent, env):
        if agent["id"] not in self.running:
            self.starts += 1
            self.running[agent["id"]] = f"new:{self.starts}"

    def stop(self, agent_id):
        self.running.pop(agent_id, None)

    def status(self, agent_id):
        return "running" if agent_id in self.running else "absent"

    def execution(self, agent_id):
        return self.running.get(agent_id)


def test_a_mind_still_running_from_an_older_hive_is_stopped_before_the_import_and_only_it(env, monkeypatch):
    from hive.supervisor.drivers import Supervisor
    client, hive, people = env
    old, child, current = (mind(hive, people["Ana"])[0]["id"] for _ in range(3))
    driver = _Minds(running=(old, child))           # adopted from a hive that recorded no start contract
    sup = Supervisor(hive.settings, drivers={"local": driver, "docker": driver})
    sup.attach(hive)
    sup.env = lambda agent: {}
    sup.start(current)                                # started by this hive: its contract is recorded
    monkeypatch.setattr(hive.minds, "is_child", lambda agent_id: agent_id == child)
    assert sup.stop_older_starts() == ([old], [child])  # the child runs on until it ends; the current one is left alone
    assert set(driver.running) == {child, current}
    sup.start(old)                                    # as the reconcile pass does, under this hive's contract
    assert sup.stop_older_starts() == ([], [child]) and set(driver.running) == {old, child, current}
    assert (hive.settings.data_dir / "sandbox" / f"{old}.contract").read_text().strip() == Supervisor.START_CONTRACT


def test_settings_are_checked_before_anything_is_sealed():
    clean = connectors.clean_settings
    assert clean("home_assistant", {"url": "http://ha.local:8123/", "token": " t "}) == {"url": "http://ha.local:8123",
                                                                                      "token": "t"}
    login = {"username": "ana@example.test", "password": "pw"}
    assert clean("librelinkup", {**login, "url": "https://api-eu.libreview.io"})["url"] == "https://api-eu.libreview.io"
    assert clean("librelinkup", {**login, "url": "http://127.0.0.1:18124"})["url"] == "http://127.0.0.1:18124"
    for connector_id, bad in (("home_assistant", {"url": "ha.local", "token": "t"}),
                              ("home_assistant", {"url": "http://user:pw@ha.local", "token": "t"}),
                              ("home_assistant", {"url": "http://ha.local", "token": "t", "extra": 1}),
                              ("librelinkup", {**login, "url": "http://api.libreview.io"}),   # plain http off the machine
                              ("librelinkup", {**login, "unit": "kg"}),
                              ("librelinkup", {"username": "ana@example.test"}),
                              ("whatsapp", {"creds": "x"})):
        with pytest.raises(Exception) as caught:
            clean(connector_id, bad)
        assert getattr(caught.value, "status", None) == 400, (connector_id, bad)
