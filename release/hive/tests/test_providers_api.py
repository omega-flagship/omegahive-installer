"""Provider keys, the OpenRouter catalogue, routing options and the base-path mount.

No network: OpenRouter is answered by a fake transport.  PeTTa is still needed
because the app boots the shared spaces.
"""

import json
import os
import pathlib
import tempfile

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core import providers as providers_module
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.providers import clean_options, openrouter_routing

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

CATALOG = {"data": [
    {"id": "acme/alpha", "name": "Acme: Alpha", "context_length": 128000, "pricing": {"prompt": "0.000001", "completion": "0.000002"},
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
     "supported_parameters": ["tools", "temperature"], "top_provider": {"max_completion_tokens": 8192}},
    {"id": "acme/beta", "name": "Acme: Beta", "context_length": 32000, "pricing": {"prompt": "0", "completion": "0"},
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}, "supported_parameters": []},
]}
ENDPOINTS = {"data": {"id": "acme/alpha", "endpoints": [
    {"name": "Alpha | acme", "provider_name": "Acme Cloud", "tag": "acme", "context_length": 128000,
     "pricing": {"prompt": "0.000001", "completion": "0.000002"}, "uptime_last_30m": 99.5, "status": 0,
     "supports_tool_choice": {"auto": True}},
    {"name": "Alpha | other", "provider_name": "Other", "tag": "other", "context_length": 64000,
     "pricing": {"prompt": "0.0000005", "completion": "0.000001"}, "uptime_last_30m": 97.0, "status": 0},
]}}


class FakeOpenRouter:
    """An httpx transport that plays OpenRouter and records the chat requests it receives."""

    def __init__(self):
        self.chats = []
        self.good_keys = {"sk-or-good", "sk-or-team", "sk-or-jon-personal"}

    def handler(self, request: httpx.Request):
        auth = request.headers.get("authorization", "")
        key = auth[7:] if auth.startswith("Bearer ") else ""
        path = request.url.path
        if path.endswith("/key"):
            if key in self.good_keys:
                return httpx.Response(200, json={"data": {"label": "test key", "limit": 10, "usage": 1.5}})
            return httpx.Response(401, json={"error": {"message": "bad"}})
        if path.endswith("/models"):
            return httpx.Response(200, json=CATALOG)
        if path.endswith("/endpoints"):
            if "acme/alpha" in path:
                return httpx.Response(200, json=ENDPOINTS)
            return httpx.Response(404, json={"error": "no"})
        if path.endswith("/chat/completions"):
            body = json.loads(request.content)
            self.chats.append((key, body))
            return httpx.Response(200, json={"id": "x", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"},
                                                                    "finish_reason": "stop"}],
                                             "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
        return httpx.Response(404)


class FakeSupervisor:
    def __init__(self):
        self.hive = None

    def attach(self, hive):
        self.hive = hive

    def prepare(self, agent, token):
        pass

    def reconfigure(self, agent):
        pass

    def start(self, agent_id):
        pass

    def stop(self, agent_id):
        pass

    def logs(self, agent_id, tail=200):
        return []

    def check(self):
        pass


@pytest.fixture()
def fake():
    return FakeOpenRouter()


@pytest.fixture()
def client(fake, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    data = tempfile.mkdtemp(prefix="hive-prov-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA, offline=True,
                             allow_unpriced=False)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    gateway = app.state.gateway
    gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler), timeout=5)
    app.state.hive.providers.client = gateway.client
    with TestClient(app) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        test_client.data_dir = pathlib.Path(data)
        yield test_client


def test_options_are_validated():
    assert clean_options(None) == {}
    assert clean_options({"route": {"order": ["acme"], "allow_fallbacks": False, "sort": "price"}}) == \
        {"route": {"order": ["acme"], "allow_fallbacks": False, "sort": "price"}}
    assert clean_options({"route": {}}) == {}
    with pytest.raises(ValueError):
        clean_options({"route": {"sort": "vibes"}})
    with pytest.raises(ValueError):
        clean_options({"route": {"order": "acme"}})
    assert openrouter_routing(json.dumps({"route": {"order": ["acme"]}})) == {"order": ["acme"]}
    assert openrouter_routing({}) is None


def test_openrouter_is_disconnected_until_a_key_is_set(client):
    listing = client.get("/api/providers").json()
    by_name = {p["name"]: p for p in listing}
    assert by_name["openrouter"]["connected"] is False and by_name["openrouter"]["source"] is None
    assert by_name["mock"]["connected"] is True and by_name["mock"]["needs_key"] is False
    assert not any(m["provider"] == "openrouter" for m in client.get("/api/models").json())


def test_bad_key_is_refused_and_not_stored(client):
    response = client.put("/api/providers/openrouter/key", json={"key": "sk-or-wrong"})
    assert response.status_code == 401 and response.json()["error"]["code"] == "bad_key"
    assert not (client.data_dir / "providers.json").exists()


def test_key_is_verified_stored_and_hinted(client):
    status = client.put("/api/providers/openrouter/key", json={"key": "sk-or-good"}).json()
    assert status["connected"] is True and status["source"] == "stored"
    assert status["key_hint"] == "…good" and status["account"]["label"] == "test key"
    assert "sk-or-good" not in json.dumps(status)
    path = client.data_dir / "providers.json"
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    ring = json.loads(path.read_text())
    default = ring["defaults"]["openrouter"]
    assert ring["version"] == 2 and ring["keys"][default]["secret"] == "sk-or-good"
    assert any(m["provider"] == "openrouter" for m in client.get("/api/models").json())
    removed = client.delete("/api/providers/openrouter/key").json()
    assert removed["connected"] is False and removed["key_hint"] == ""


def test_catalog_and_endpoints(client):
    client.put("/api/providers/openrouter/key", json={"key": "sk-or-good"})
    catalog = client.get("/api/providers/openrouter/catalog").json()
    ids = [m["id"] for m in catalog["models"]]
    assert ids == ["acme/alpha", "acme/beta"]
    alpha = catalog["models"][0]
    assert alpha["in_per_m"] == 1.0 and alpha["out_per_m"] == 2.0 and alpha["tools"] is True
    assert alpha["inputs"] == ["text", "image"] and alpha["context_length"] == 128000
    endpoints = client.get("/api/providers/openrouter/endpoints/acme/alpha").json()["endpoints"]
    assert [e["tag"] for e in endpoints] == ["acme", "other"]
    assert endpoints[1]["in_per_m"] == 0.5
    missing = client.get("/api/providers/openrouter/endpoints/acme/nope")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "unknown_model"


def test_catalog_prices_meter_a_dot_and_routing_reaches_openrouter(client, fake):
    client.put("/api/providers/openrouter/key", json={"key": "sk-or-good"})
    client.get("/api/providers/openrouter/catalog")
    swarm = client.post("/api/swarms", json={"name": "Alpha"}).json()
    created = client.post("/api/agents", json={
        "name": "Vega", "kind": "omega", "swarm_id": swarm["id"], "model": "openrouter/acme/alpha", "budget_usd": 1,
        "options": {"route": {"order": ["acme"], "allow_fallbacks": False}},
    }).json()
    assert created["options"] == {"route": {"order": ["acme"], "allow_fallbacks": False}}
    headers = {"Authorization": f"Bearer {created['token']}"}
    response = client.post("/llm/v1/chat/completions", json={"messages": [{"role": "user", "content": "hello"}], "max_tokens": 10},
                           headers=headers)
    assert response.status_code == 200, response.text
    key, body = fake.chats[-1]
    assert key == "sk-or-good" and body["model"] == "acme/alpha"
    assert body["provider"] == {"order": ["acme"], "allow_fallbacks": False}
    agent = client.get(f"/api/agents/{created['id']}").json()
    assert agent["spent_usd"] == pytest.approx((10 * 1.0 + 5 * 2.0) / 1_000_000)
    # routing can be cleared, and a bad option is refused
    patched = client.patch(f"/api/agents/{created['id']}", json={"options": {}}).json()
    assert patched["options"] == {}
    bad = client.patch(f"/api/agents/{created['id']}", json={"options": {"route": {"sort": "vibes"}}})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_options"


def test_unpriced_openrouter_model_is_still_refused(client):
    client.put("/api/providers/openrouter/key", json={"key": "sk-or-good"})
    created = client.post("/api/agents", json={"name": "Nix", "kind": "omega", "model": "openrouter/acme/unknown", "budget_usd": 1}).json()
    response = client.post("/llm/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]},
                           headers={"Authorization": f"Bearer {created['token']}"})
    assert response.status_code == 402 and response.json()["error"]["code"] == "unpriced_model"


def test_environment_key_counts_as_connected(monkeypatch, fake):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-good")
    data = tempfile.mkdtemp(prefix="hive-prov-env-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA, offline=True)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        status = next(p for p in test_client.get("/api/providers").json() if p["name"] == "openrouter")
        assert status["connected"] is True and status["source"] == "env" and status["key_hint"] == "…good"


def test_base_path_serves_the_api_at_root_and_under_the_prefix():
    data = tempfile.mkdtemp(prefix="hive-prov-base-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive,/omegadot")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as test_client:
        # the password works only from this machine (no prefix, no proxy header)
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert test_client.get("/api/hive", headers=headers).json()["name"] == "OmegaHive"
        refused = test_client.post("/omegahive/api/auth/login", json={"password": "pw"})
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "password_login_local_only"
        # a password session is not an operator session from outside
        assert test_client.get("/omegahive/api/hive", headers=headers).status_code == 401
        assert test_client.get("/omegadot/api/hive", headers=headers).status_code == 401
        # the page itself is served under both prefixes
        assert test_client.get("/omegahive/api/auth/methods").json()["password"] is False


# ---- the keyring: many keys per provider, assigned to minds ------------------------------------

def _mind(client, name, model="openrouter/acme/alpha", **options):
    return client.post("/api/agents", json={"name": name, "kind": "omega", "model": model, "budget_usd": 1,
                                            **({"options": options} if options else {})})


def test_keys_are_listed_with_hints_owner_and_default(client):
    first = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-good", "label": "Choir"}).json()
    second = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-team", "label": "Team"}).json()
    assert first["default"] is True and second["default"] is False  # the first key of a provider becomes its default
    assert first["owner"] == "user:operator" and first["hint"] == "…good"
    listing = client.get("/api/keys").json()
    assert [k["label"] for k in listing] == ["Choir", "Team"]
    assert "sk-or-good" not in json.dumps(listing) and "secret" not in json.dumps(listing)
    dup = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-team"})
    if os.environ.get("HIVE_MIND_GATEWAY") == "1":
        # gateway r1ab.4 (Dot's T-KEY1 ruling): the same person sending their own stored key again carries on with it
        assert dup.status_code == 200 and dup.json()["id"] == second["id"], dup.text
        assert [k["id"] for k in client.get("/api/keys").json()] == [first["id"], second["id"]]   # nothing added
    else:
        assert dup.status_code == 409 and dup.json()["error"]["code"] == "duplicate_key"
    # anyone else sending a key someone already stores is not told so (sol on 46f13f98: duplicates are per owner): it
    # is verified and stored as their own row, exactly as a key nobody holds
    from hive.tests.test_visibility import person
    other = client.post("/api/keys", headers=person(client, "u_0d0d0d0d"), json={"provider": "openrouter", "key": "sk-or-team"})
    assert other.status_code == 200, other.text
    assert other.json()["owner"] == "user:u_0d0d0d0d" and other.json()["id"] not in (first["id"], second["id"])
    assert "Team" not in other.text
    bad = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-wrong"})
    assert bad.status_code == 401
    renamed = client.patch(f"/api/keys/{second['id']}", json={"label": "Team budget", "default": True}).json()
    assert renamed["label"] == "Team budget" and renamed["default"] is True
    assert next(k for k in client.get("/api/keys").json() if k["id"] == first["id"])["default"] is False


def test_a_mind_pays_with_its_assigned_key_and_usage_records_it(client, fake):
    client.get("/api/providers/openrouter/catalog")
    choir = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-good", "label": "Choir"}).json()
    team = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-team", "label": "Team"}).json()
    client.get("/api/providers/openrouter/catalog")
    on_default = _mind(client, "Vega").json()
    on_team = _mind(client, "Lyra", key=team["id"]).json()
    assert on_team["options"] == {"key": team["id"]}
    for mind in (on_default, on_team):
        r = client.post("/llm/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
                        headers={"Authorization": f"Bearer {mind['token']}"})
        assert r.status_code == 200, r.text
    assert [k for k, _ in fake.chats[-2:]] == ["sk-or-good", "sk-or-team"]
    listing = {k["id"]: k for k in client.get("/api/keys").json()}
    assert listing[team["id"]]["spent_usd"] > 0 and listing[choir["id"]]["spent_usd"] > 0
    assert [m["name"] for m in listing[team["id"]]["minds"]] == ["Lyra"]
    assert [(m["name"], m["assigned"]) for m in listing[choir["id"]]["minds"]] == [("Vega", False)]


def test_assignment_is_checked_and_removal_falls_back_to_the_default(client, fake):
    client.get("/api/providers/openrouter/catalog")
    client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-good", "label": "Choir"})
    team = client.post("/api/keys", json={"provider": "openrouter", "key": "sk-or-team", "label": "Team"}).json()
    client.get("/api/providers/openrouter/catalog")
    wrong = _mind(client, "Echo", model="mock/echo", key=team["id"])
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "key_provider_mismatch"
    missing = _mind(client, "Nix", key="k_00000000")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "unknown_key"
    lyra = _mind(client, "Lyra", key=team["id"]).json()
    gone = client.delete(f"/api/keys/{team['id']}").json()
    assert gone == {"ok": True, "unassigned": 1}
    assert client.get(f"/api/agents/{lyra['id']}").json()["options"] == {}
    r = client.post("/llm/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 5},
                    headers={"Authorization": f"Bearer {lyra['token']}"})
    assert r.status_code == 200 and fake.chats[-1][0] == "sk-or-good"


def test_version_one_store_is_migrated(fake, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-prov-v1-"))
    (data / "providers.json").write_text(json.dumps({"openrouter": {"key": "sk-or-good", "set_at": 1}}))
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA, offline=True)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        keys = test_client.get("/api/keys").json()
        assert len(keys) == 1 and keys[0]["default"] and keys[0]["hint"] == "…good"
        assert next(p for p in test_client.get("/api/providers").json() if p["name"] == "openrouter")["connected"]
