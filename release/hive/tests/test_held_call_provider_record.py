# Purpose: tests that an unknown OpenRouter answer the hive holds a generation id for is settled at the cost
# OpenRouter's own record reports, on the reconcile pass and before the expiry, and that nothing else is looked up:
# only a record of that generation counts, each read has a short timeout, and a pass reads a bounded number.
"""Reconciliation against the provider's own record: an OpenRouter answer that came back without usage the hive could
price stays held at its worst case until a person types its cost or the hour's expiry charges the worst case.
OpenRouter keeps a record of every generation's cost, so the reconcile pass asks it and settles the call at that.
Synthetic minds and a mock OpenRouter transport: no network."""
import httpx
import pytest

from hive.core.cost_reservations import Reservations, outstanding
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)

MODEL = "openrouter/vendor/model"


def _held(client, generation="gen-abc123", model=MODEL):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=1.0)
    res = Reservations(client.app.state.hive.db)
    key = f"held-{generation}"
    res.reserve(key, {"p": key}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": a["id"], "model": model},
                dispatched=True)
    if generation:
        res.observe(key, {"response_id": generation, "usage_origin": "usage-unverified"})
    res.unknown(key)
    return a, res, key


def _openrouter(client, monkeypatch, answers):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    asked = []

    def handler(request):
        asked.append(request)
        return answers(request)
    client.app.state.gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return asked


def test_an_unknown_openrouter_answer_settles_at_its_generation_records_cost(client, monkeypatch):
    a, res, key = _held(client)
    asked = _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": {"id": "gen-abc123", "total_cost": 0.0123}}))
    client.portal.call(client.app.state.reconcile_once)
    assert len(asked) == 1 and asked[0].url.path.endswith("/generation") and asked[0].url.params["id"] == "gen-abc123"
    assert asked[0].headers["authorization"] == "Bearer sk-or-test"
    row = res.get(key)
    assert (row["state"], row["actual"]) == ("settled", 12_300)
    hive = client.app.state.hive
    resolution = hive.db.one("SELECT * FROM cost_reservation_resolutions WHERE reservation = ?", (key,))
    assert resolution["decided_by"] == "hive:provider-record" and "gen-abc123" in resolution["reason"]
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(0.0123)


def test_no_record_yet_keeps_the_hold_and_the_next_pass_settles_it(client, monkeypatch):
    _, res, key = _held(client)
    ready = []
    _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": {"id": "gen-abc123", "total_cost": 0.02}}) if ready
                else httpx.Response(404, json={"error": {"code": 404, "message": "Generation not found"}}))
    client.portal.call(client.app.state.reconcile_once)
    assert res.get(key)["state"] == "unknown"
    ready.append(True)
    client.portal.call(client.app.state.reconcile_once)
    assert (res.get(key)["state"], res.get(key)["actual"]) == ("settled", 20_000)


@pytest.mark.parametrize("answer", [
    httpx.Response(200, json={"data": {"id": "gen-abc123", "total_cost": -1}}),
    httpx.Response(200, json={"data": {"id": "gen-abc123", "total_cost": "0.01"}}),
    httpx.Response(200, json={"data": {}}), httpx.Response(200, content=b"not json"), httpx.Response(500, json={}),
])
def test_a_record_without_a_usable_cost_settles_nothing(client, monkeypatch, answer):
    _, res, key = _held(client)
    _openrouter(client, monkeypatch, lambda r: answer)
    client.portal.call(client.app.state.reconcile_once)
    assert res.get(key)["state"] == "unknown"


@pytest.mark.parametrize("generation,model", [(None, MODEL), ("gen-abc", "anthropic/claude-sonnet-5-5"), ("msg_01", MODEL)])
def test_only_an_openrouter_call_with_a_generation_id_is_looked_up(client, monkeypatch, generation, model):
    _, res, key = _held(client, generation, model)
    asked = _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": {"total_cost": 0.01}}))
    client.portal.call(client.app.state.reconcile_once)
    assert asked == [] and [r["state"] for r in outstanding(res)] == ["unknown"]


@pytest.mark.parametrize("record", [{"id": "gen-other", "total_cost": 0.01}, {"total_cost": 0.01}])
def test_a_record_of_another_generation_settles_nothing(client, monkeypatch, record):
    _, res, key = _held(client)
    _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": record}))
    client.portal.call(client.app.state.reconcile_once)
    assert res.get(key)["state"] == "unknown"


def test_each_lookup_gets_the_short_timeout(client, monkeypatch):
    _held(client)
    asked = _openrouter(client, monkeypatch, lambda r: httpx.Response(404, json={"error": {"code": 404, "message": "x"}}))
    client.portal.call(client.app.state.reconcile_once)
    limit = client.app.state.gateway.GENERATION_LOOKUP_TIMEOUT_S
    assert limit <= 10 and asked[0].extensions["timeout"] == {"connect": limit, "read": limit, "write": limit, "pool": limit}


def test_a_pass_reads_at_most_ten_records_and_the_next_goes_on_round_all_of_them(client, monkeypatch):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=5.0)
    res = Reservations(client.app.state.hive.db)
    for i in range(12):
        key = f"held-{i}"
        res.reserve(key, {"p": key}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": a["id"], "model": MODEL},
                    dispatched=True)
        res.observe(key, {"response_id": f"gen-{i}", "usage_origin": "usage-unverified"})
        res.unknown(key)
    asked = _openrouter(client, monkeypatch, lambda r: httpx.Response(404, json={"error": {"code": 404, "message": "x"}}))
    passes = []
    for _ in range(2):
        before = len(asked)
        client.portal.call(client.app.state.reconcile_once)
        passes.append([r.url.params["id"] for r in asked[before:]])
    assert [len(p) for p in passes] == [10, 10]
    assert sorted(passes[0]) == sorted(f"gen-{i}" for i in range(10))
    assert {"gen-10", "gen-11"} <= set(passes[1])        # the two the first pass left are read next, not starved


def test_one_failing_lookup_never_stops_the_others(client, monkeypatch):
    _, res, failing = _held(client, "gen-fails")
    _, _, settles = _held(client, "gen-settles")
    gateway = client.app.state.gateway

    async def cost(key_id, generation):
        if generation == "gen-fails":
            raise RuntimeError("keyring unavailable")
        return 0.004
    monkeypatch.setattr(gateway, "generation_cost", cost)
    client.portal.call(client.app.state.reconcile_once)
    assert res.get(failing)["state"] == "unknown"
    assert (res.get(settles)["state"], res.get(settles)["actual"]) == ("settled", 4_000)
