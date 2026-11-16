# Purpose: tests that a held call records why its cost is unknown, in the hive's own words, through the real chat route,
# the startup recovery and the observation that follows it.
"""A call left unknown says why (gateway.held_cause): a provider's refusal by the hive's fixed sentence for its status,
a timeout, a dropped connection, an answer without a cost, or a restart. The person settling it reads that beside the
call instead of "the provider never reported usage". Synthetic minds and a scripted provider: no network."""
import asyncio

import httpx
import pytest

from hive.core.cost_reservations import Reservations, outstanding
from hive.core.gateway import RESTART_CAUSE, held_cause
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_unbilled_refusal_release import BODY, MODEL, _failing_chat, _post, _refusal


def _mind(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=1.0)
    return a


def _cause(client):
    held = client.get("/api/budgets/reservations").json()
    assert len(held) == 1 and held[0]["state"] == "unknown"
    return (held[0]["observation"] or {}).get("cause")


@pytest.mark.parametrize("exc,cause", [
    (_refusal(429, b'{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}', "openai"),
     "OpenAI refused the request (rate_limited, 429)."),
    (httpx.ReadTimeout("t"), "No answer from Anthropic before the hive stopped waiting. A provider can still charge a call it finished."),
    (httpx.RemoteProtocolError("drop"), "The connection to Anthropic broke before its answer arrived."),
    (RuntimeError("parse"), "The hive could not read the call's answer."),
])
def test_a_failed_call_records_why_it_is_held(client, exc, cause):
    a = _mind(client)
    _failing_chat(client.app.state.gateway, exc)
    _post(client, a)
    assert _cause(client) == cause


def test_an_answer_without_a_cost_records_that(client):
    a = _mind(client)

    async def chat(agent, body):
        return {"id": "r1", "model": MODEL, "choices": [{"message": {"content": "ok"}}]}, \
            {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.0}
    client.app.state.gateway.chat = chat
    assert client.post("/llm/v1/chat/completions", json=BODY, headers=agent_headers(a)).status_code == 200
    held = client.get("/api/budgets/reservations").json()
    assert held[0]["observation"]["cause"] == "Anthropic answered without saying what the call cost."
    assert held[0]["observation"]["response_id"] == "r1"     # what was observed before stays beside the cause


def test_the_cause_survives_a_later_observation_and_a_restart_names_itself(client):
    res = Reservations(client.app.state.hive.db)
    snap = lambda: [("hive", 10.0, 0.0)]   # noqa: E731
    res.reserve("k-cause", {"p": 1}, 0.05, snap, metadata={"agent": "a_x", "model": MODEL}, dispatched=True)
    res.unknown("k-cause", "No answer from Anthropic before the hive stopped waiting.")
    res.observe("k-cause", {"response_id": "msg_1"})
    assert res.details("k-cause")["observation"] == {"response_id": "msg_1", "cause": "No answer from Anthropic before the hive stopped waiting."}
    res.reserve("k-flight", {"p": 2}, 0.05, snap, metadata={"agent": "a_x", "model": MODEL}, dispatched=True)
    db = client.app.state.hive.db
    with db.transaction():
        Reservations.recover_startup(db)
    rows = {r["id"]: r for r in outstanding(res)}
    assert rows["k-flight"]["state"] == "unknown" and rows["k-flight"]["observation"]["cause"] == RESTART_CAUSE
    assert rows["k-cause"]["observation"]["cause"] == "No answer from Anthropic before the hive stopped waiting."


@pytest.mark.parametrize("exc,model,cause", [
    (asyncio.TimeoutError(), "openrouter/x/y", "No answer from OpenRouter before the hive stopped waiting. A provider can still charge a call it finished."),
    (asyncio.CancelledError(), MODEL, "The call was stopped after it was sent."),
    (None, "somewhere/model", "Somewhere answered without saying what the call cost."),
    (None, None, "The provider answered without saying what the call cost."),
])
def test_held_cause_names_the_provider_in_the_hives_own_words(exc, model, cause):
    assert held_cause(exc, model) == cause
