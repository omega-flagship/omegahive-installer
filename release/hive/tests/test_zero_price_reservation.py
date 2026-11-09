"""Mike's audit (#56, Jon-approved reply), with sol's review of 38325250: a remote model priced at exactly $0 by its OWN
entry is a real, admitted call (it reserves the smallest positive amount and passes every check); a $0 "*" wildcard
never makes an unknown model free; a charge the provider reports is always recorded, never hidden behind a $0 rate;
and an unpriced model is refused with its reason before anything is sent, whatever HIVE_ALLOW_UNPRICED says."""
import json

import httpx

from hive.core import gateway as gateway_mod
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import _gateway

FREE = "anthropic/free-test-model"


def _upstream(gw, cost=None):
    """The real chat path over a mock transport: returns the request count and lets the billing parser run."""
    calls = []

    def handler(request):
        calls.append(request)
        usage = {"prompt_tokens": 3, "completion_tokens": 2}
        if cost is not None:
            usage["cost"] = cost
        return httpx.Response(200, json={"id": "r", "model": "free-test-model", "usage": usage,
                                         "choices": [{"message": {"content": "ok"}}]})
    gw.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    prov = gw.provider("anthropic")
    prov.stored_key = prov.stored_key or "test-key-not-real"
    return calls


def _reservations(client):
    return client.app.state.hive.db.all("SELECT state, maximum, actual FROM cost_reservations")


def test_a_zero_priced_remote_model_is_admitted_and_a_reported_charge_is_recorded(client):
    gw = _gateway(client)
    gw.provider("anthropic").prices["free-test-model"] = {"in": 0.0, "out": 0.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=FREE, budget_usd=1.0)
    paid, usd = gw.estimate({"model": FREE, "id": a["id"]}, {"messages": [], "max_tokens": 10})
    assert paid is True and usd == gateway_mod.FREE_MODEL_RESERVE_USD > 0          # still paid: every check runs
    calls = _upstream(gw, cost=0.25)                                                   # the provider charged anyway
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    rows = _reservations(client)
    assert rows and rows[-1]["state"] == "settled" and rows[-1]["actual"] == 250_000      # $0.25 in micros, not 0


def test_a_zero_wildcard_never_makes_an_unknown_model_free(client):
    gw = _gateway(client)
    gw.provider("anthropic").prices["*"] = {"in": 0.0, "out": 0.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model="anthropic/some-paid-model", budget_usd=1.0)
    calls = _upstream(gw, cost=0.5)
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 402 and r.json()["error"]["code"] == "unpriced_model", r.text
    assert calls == []                                                                  # nothing was sent


def test_an_unpriced_model_is_refused_before_dispatch_even_when_allowed(client, monkeypatch):
    hive = client.app.state.hive
    gw = _gateway(client)
    _, (a,) = make_swarm_and_agents(client, n=1, model="anthropic/unpriced-test-model", budget_usd=1.0)
    calls = _upstream(gw)
    for allow in (False, True):
        monkeypatch.setattr(hive.settings, "allow_unpriced", allow)
        r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
        assert r.status_code == 402 and r.json()["error"]["code"] == "unpriced_model", r.text
        assert "can't be reserved" in r.json()["error"]["message"]
    assert calls == []


# ---- R3 (sol on b0a08b62) ----

def _upstream_usage(gw, usage):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"id": "r", "model": "free-test-model", "usage": usage,
                                         "choices": [{"message": {"content": "ok"}}]})
    gw.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    prov = gw.provider("anthropic")
    prov.stored_key = prov.stored_key or "test-key-not-real"
    return calls


def test_a_reported_charge_without_token_counters_is_settled_not_held_at_the_floor(client):
    gw = _gateway(client)
    gw.provider("anthropic").prices["free-test-model"] = {"in": 0.0, "out": 0.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=FREE, budget_usd=1.0)
    _upstream_usage(gw, {"cost": 0.25})                                                # no prompt/completion counters
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 200, r.text
    rows = _reservations(client)
    assert rows[-1]["state"] == "settled" and rows[-1]["actual"] == 250_000
    assert abs(client.app.state.hive.agent(a["id"])["spent_usd"] - 0.25) < 1e-9


def test_a_free_call_with_an_unknown_outcome_blocks_further_calls_to_that_model(client):
    gw = _gateway(client)
    gw.provider("anthropic").prices["free-test-model"] = {"in": 0.0, "out": 0.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=FREE, budget_usd=1.0)
    calls = _upstream_usage(gw, {})                                                     # neither counters nor a charge
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 200 and _reservations(client)[-1]["state"] == "unknown"
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 402 and r.json()["error"]["code"] == "free_model_unreconciled", r.text
    assert len(calls) == 1                                                              # the second was never sent


def _embedding_mind(client, price, monkeypatch, allow=False):
    hive = client.app.state.hive
    gw = _gateway(client)
    if price is not None:
        gw.providers["openai"].prices["text-embedding-free"] = price
    object.__setattr__(hive.settings, "embedding_model", "openai/text-embedding-free")
    monkeypatch.setattr(hive.settings, "allow_unpriced", allow)
    sent = []

    async def embeddings(model, body, agent=None):
        sent.append(model)
        return {"object": "list", "data": [{"embedding": [0.0]}], "usage": {"prompt_tokens": 5, "cost": 0.1}}
    gw.embeddings = embeddings
    _, (a,) = make_swarm_and_agents(client, n=1, model="mock/echo", budget_usd=1.0)
    return hive, a, sent


def test_unpriced_embeddings_are_refused_even_when_allowed(client, monkeypatch):
    hive, a, sent = _embedding_mind(client, None, monkeypatch, allow=True)
    r = client.post("/llm/v1/embeddings", json={"input": ["x"]}, headers=agent_headers(a))
    assert r.status_code == 402 and r.json()["error"]["code"] == "unpriced_model", r.text
    assert sent == []


def test_free_embeddings_reserve_and_record_the_reported_charge(client, monkeypatch):
    hive, a, sent = _embedding_mind(client, {"in": 0.0, "out": 0.0}, monkeypatch)
    r = client.post("/llm/v1/embeddings", json={"input": ["x"]}, headers=agent_headers(a))
    assert r.status_code == 200, r.text
    rows = _reservations(client)
    assert rows[-1]["state"] == "settled" and rows[-1]["actual"] == 100_000
    assert abs(hive.agent(a["id"])["spent_usd"] - 0.1) < 1e-9


# ---- R4 (sol on 63842281) ----

def test_null_token_counters_never_discard_a_reported_charge(client):
    gw = _gateway(client)
    gw.provider("anthropic").prices["free-test-model"] = {"in": 0.0, "out": 0.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=FREE, budget_usd=1.0)
    _upstream_usage(gw, {"prompt_tokens": None, "completion_tokens": None, "cost": 0.25})
    r = client.post("/llm/v1/chat/completions", json={"messages": [], "max_tokens": 10}, headers=agent_headers(a))
    assert r.status_code == 200, r.text
    rows = _reservations(client)
    assert rows[-1]["state"] == "settled" and rows[-1]["actual"] == 250_000


def test_an_unknown_free_hold_is_never_auto_settled_at_expiry_and_keeps_blocking(tmp_path):
    from hive.core.cost_reservations import Reservations, expire_unknown
    from hive.core.db import Database
    res = Reservations(Database(tmp_path / "h.db"))
    for key, usd in (("free", gateway_mod.FREE_MODEL_RESERVE_USD), ("paid", 0.05)):
        res.reserve(key, {"k": key}, usd, lambda: [("hive:total", 10.0, 0.0)], metadata={"model": f"anthropic/{key}"},
                    dispatched=True)
        res.unknown(key)
    settled = expire_unknown(res, lambda meta, usd: None, now=10**12)
    assert "paid" in settled and "free" not in settled                   # the worst case expires; the floor does not
    assert res.get("free")["state"] == "unknown" and res.free_unknown("anthropic/free")
