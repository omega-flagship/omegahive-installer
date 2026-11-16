"""The sample providers.json registers the invented `labbox` provider with its models and prices.

Run from the repository root:  python -m pytest -q examples/hello-model/tests
No network call is made: the HTTP clients are given a transport that fails the test if anything is sent.
"""

import asyncio
import json
import pathlib
import sys

import httpx
import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
PROVIDERS_FILE = HERE / "providers.json"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hive.core.config import load_settings  # noqa: E402
from hive.core.gateway import Gateway, split_model  # noqa: E402
from hive.core.providers import ProviderStore  # noqa: E402


def _no_network(request):
    raise AssertionError(f"unexpected network call to {request.url}")


def _offline_client():
    return httpx.AsyncClient(transport=httpx.MockTransport(_no_network))


@pytest.fixture
def settings(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_PROVIDERS_FILE", str(PROVIDERS_FILE))
    monkeypatch.setenv("HIVE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HIVE_OFFLINE", "1")
    monkeypatch.delenv("HIVE_LOCAL_ONLY_SWARMS", raising=False)
    monkeypatch.delenv("LABBOX_API_KEY", raising=False)
    return load_settings()


@pytest.fixture
def gateway(settings):
    gate = Gateway(settings.providers)
    unused, gate.client = gate.client, _offline_client()
    yield gate
    asyncio.run(unused.aclose())
    asyncio.run(gate.client.aclose())


@pytest.fixture
def store(settings):
    client = _offline_client()
    yield ProviderStore(settings, client=client)
    asyncio.run(client.aclose())


def test_the_file_is_a_list_of_provider_records():
    raw = json.loads(PROVIDERS_FILE.read_text())
    assert isinstance(raw, list) and [p["name"] for p in raw] == ["labbox"]


def test_provider_and_prices_are_registered(store):
    labbox = store.provider("labbox")
    assert labbox.base_url == "http://127.0.0.1:8081/v1"
    assert labbox.local is True
    assert labbox.models == ["tiny-chat-7b", "tiny-chat-1b"]
    assert labbox.price("tiny-chat-7b") == (0.05, 0.10)
    assert labbox.price("tiny-chat-1b") == (0.01, 0.02)     # no entry of its own: the "*" default
    assert labbox.priced("tiny-chat-7b") and labbox.priced("tiny-chat-1b")


def test_the_built_in_providers_are_still_there(store):
    for name in ("mock", "anthropic", "openai", "openrouter", "local"):
        assert store.provider(name).name == name


def test_status_shows_a_connected_local_provider(store):
    status = store.status("labbox")
    assert status["local"] is True
    assert status["needs_key"] is False
    assert status["connected"] is True
    assert status["models"] == ["tiny-chat-7b", "tiny-chat-1b"]
    assert "labbox" in [p["name"] for p in store.list()]


def test_a_mind_chooses_it_as_provider_slash_model(gateway):
    assert split_model("labbox/tiny-chat-7b") == ("labbox", "tiny-chat-7b")
    mind = {"id": "m1", "name": "Tester", "model": "labbox/tiny-chat-7b", "swarm_id": "s1"}
    # A local provider is never reserved against a budget (Gateway.estimate) ...
    assert gateway.estimate(mind, {"messages": [{"role": "user", "content": "hi"}]}) == (False, 0.0)
    # ... but its prices still set the cost recorded for each call (Gateway.cost).
    labbox = gateway.provider("labbox")
    assert gateway.cost(labbox, "tiny-chat-7b", 1_000_000, 1_000_000) == pytest.approx(0.15)


def test_a_local_only_swarm_accepts_this_loopback_provider(gateway, monkeypatch):
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", json.dumps(["s1"]))
    gateway.enforce_egress({"id": "m1", "model": "labbox/tiny-chat-7b", "swarm_id": "s1"}, "labbox")
