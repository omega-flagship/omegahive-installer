"""Purpose: test that the hive's model call route holds a call's output room to its OpenRouter model's own limit, so a
mind's retry after a cut-off (twice the room, runtime/provider_features.py) never asks for more than the model gives,
and that a mind working on a Create plan step asks with the model's whole room from its first call, as much as its
reservation can hold.

Invented model only: "invented/long-thinker" on OpenRouter, its catalogue entry saying it gives at most 8000 tokens.
"""
import time

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

MODEL_ID = "invented/long-thinker"
ANSWER = ({"id": "r1", "model": MODEL_ID, "choices": [{"message": {"role": "assistant", "content": "hello"}}],
           "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
          {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.0001})


def _world(client, limit, budget=5.0):
    hive = client.app.state.hive
    hive.providers.catalog = {"models": [{"id": MODEL_ID, "name": "Long thinker", "max_completion_tokens": limit}],
                              "fetched_at": time.time(), "error": None}
    hive.providers.provider("openrouter").prices[MODEL_ID] = {"in": 1.0, "out": 1.0}
    _, (a,) = make_swarm_and_agents(client, n=1, model=f"openrouter/{MODEL_ID}", budget_usd=budget)
    sent = []

    async def chat(agent, body):
        sent.append(dict(body))
        return ANSWER
    client.app.state.gateway.chat = chat
    return a, sent


def _post(client, a, **room):
    body = {"messages": [{"role": "user", "content": "Say hi."}], **room}
    return client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a))


def _step(client, a, created_by="create-plan:pl_room"):
    """A goal its creator gave mind a, claimed by it: a Create plan stamps each of its steps create-plan:<plan>."""
    hive = client.app.state.hive
    gid = f"g_room_{len(hive.db.all('SELECT id FROM goals'))}"
    hive.goals._create_record(a["swarm_id"], "Create plan pl_room: test-author", "Finish with result data", 0.6,
                              created_by=created_by, assignee=a["id"], goal_id=gid)
    hive.goals.claim(hive.agent(a["id"]), gid)
    return gid


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


def test_a_mind_working_on_a_create_step_asks_with_the_models_whole_room_at_once(client):
    """A Create step's answer is whole files or a whole plan in one reply, and a reply cut off at its room is thrown
    away whole, so a mind holding one asks with the model's whole room from its first call; a mind holding other work,
    or done with its step, keeps the room it asked for."""
    a, sent = _world(client, 32000)
    assert _post(client, a, max_tokens=6000).status_code == 200            # nothing claimed
    _step(client, a, created_by="user:operator")
    assert _post(client, a, max_tokens=6000).status_code == 200            # a person's task
    gid = _step(client, a)
    assert _post(client, a, max_tokens=6000).status_code == 200
    assert _post(client, a, max_completion_tokens=6000).status_code == 200
    client.app.state.hive.db.update("goals", gid, {"status": "done"})
    assert _post(client, a, max_tokens=6000).status_code == 200            # its step answered
    assert [s.get("max_tokens") or s.get("max_completion_tokens") for s in sent] == [6000, 6000, 32000, 32000, 6000]


def test_a_create_steps_room_is_what_its_reservation_can_hold(client):
    """The whole room reserves its worst case, so it is held to what a new reservation can hold now: here a $0.02 cap at
    $1 per million tokens each way leaves 20,000 micro-dollars for the prompt and the room."""
    from hive.core.gateway import billable_tokens
    a, sent = _world(client, 32000, budget=0.02)
    _step(client, a)
    assert _post(client, a, max_tokens=6000).status_code == 200
    widest = {"messages": [{"role": "user", "content": "Say hi."}], "max_tokens": 32000}
    assert 6000 < sent[0]["max_tokens"] == 20000 - billable_tokens(widest) - 1 < 32000


def test_a_create_step_with_less_left_than_it_asked_keeps_its_room_and_its_refusal(client):
    """$0.006 left pays for fewer than the 6000 tokens asked: the mind keeps its 6000, and the hive answers as it did
    before it held a step."""
    a, sent = _world(client, 32000, budget=0.006)
    before = _post(client, a, max_tokens=6000).status_code
    _step(client, a)
    assert _post(client, a, max_tokens=6000).status_code == before
    assert all(s["max_tokens"] == 6000 for s in sent)
