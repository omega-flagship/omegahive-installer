"""Purpose: test that the hive's model call route holds a call's output room to its OpenRouter model's own limit, so a
mind's retry after a cut-off (twice the room, runtime/provider_features.py) never asks for more than the model gives.

Invented model only: "invented/long-thinker" on OpenRouter, its catalogue entry saying it gives at most 8000 tokens.
"""
import time

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

MODEL_ID = "invented/long-thinker"
ANSWER = ({"id": "r1", "model": MODEL_ID, "choices": [{"message": {"role": "assistant", "content": "hello"}}],
           "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
          {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.0001})


def _world(client, limit):
    hive = client.app.state.hive
    hive.providers.catalog = {"models": [{"id": MODEL_ID, "name": "Long thinker", "max_completion_tokens": limit}],
                              "fetched_at": time.time(), "error": None}
    hive.providers.provider("openrouter").prices[MODEL_ID] = {"in": 1.0, "out": 1.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=f"openrouter/{MODEL_ID}", budget_usd=5.0)
    sent = []

    async def chat(agent, body):
        sent.append(dict(body))
        return ANSWER
    client.app.state.gateway.chat = chat
    return a, sent


def _post(client, a, **room):
    body = {"messages": [{"role": "user", "content": "Say hi."}], **room}
    return client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a))


def test_a_call_asking_more_room_than_its_model_gives_is_held_to_the_models_limit(client):
    a, sent = _world(client, 8000)
    assert _post(client, a, max_tokens=24000).status_code == 200
    assert _post(client, a, max_completion_tokens=12000).status_code == 200
    assert _post(client, a, max_tokens=6000).status_code == 200
    assert [s.get("max_tokens") or s.get("max_completion_tokens") for s in sent] == [8000, 8000, 6000]


def test_a_model_the_catalogue_gives_no_limit_for_keeps_the_room_asked(client):
    a, sent = _world(client, None)
    assert _post(client, a, max_tokens=24000).status_code == 200
    assert sent[0]["max_tokens"] == 24000
