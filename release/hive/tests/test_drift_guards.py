"""Anti-drift guards (docs/omegadots/DRIFT.md): echoes, spend, goal leases."""

import asyncio

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def publish(client, agent, statement="(--> sky blue)", f=0.9, c=0.8):
    return client.post("/api/agent/publish", headers=agent_headers(agent),
                       json={"statement": statement, "f": f, "c": c}).json()


def chat(client, agent, **body):
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json=dict({"messages": [{"role": "user", "content": "no news"}]}, **body))


# ---- the commons: repeating what you read is not new evidence -----------------------------------

def test_echo_after_query_inherits_the_read_stamp(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    first = publish(client, a)
    client.post("/api/agent/query", headers=agent_headers(b), json={"pattern": "(Current $s $t $st)"})
    echo = publish(client, b)
    assert echo["outcome"] == "kept" and echo["stamp"] == first["stamp"]
    belief = client.get(f"/api/swarms/{swarm['id']}/beliefs").json()[0]
    assert belief["tv"] == {"f": 0.9, "c": 0.8}


def test_echo_after_reading_a_belief_inherits_the_read_stamp(client):
    swarm, (a, b, c) = make_swarm_and_agents(client, n=3)
    publish(client, a)
    client.get("/api/agent/belief", headers=agent_headers(b), params={"statement": "(--> sky blue)"})
    assert publish(client, b)["outcome"] == "kept"
    # a dot that never read it is independent evidence and revises the belief
    assert publish(client, c)["outcome"] == "revised"


# ---- spend: refused before the call, never after ------------------------------------------------

def test_paid_model_needs_a_budget_and_a_price(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model="anthropic/claude-haiku-4-5-20251001")
    refused = chat(client, a)
    assert refused.status_code == 402 and refused.json()["error"]["code"] == "no_budget"
    _, (b,) = make_swarm_and_agents(client, n=1, model="openai/gpt-6.1", budget_usd=5)
    unpriced = chat(client, b)
    assert unpriced.status_code == 402 and unpriced.json()["error"]["code"] == "unpriced_model"


def test_worst_case_cost_is_reserved_before_the_call(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model="anthropic/claude-opus-5-5", budget_usd=0.05)
    # 4096 output tokens at $75/M could cost $0.31: more than the budget left
    refused = chat(client, a, max_tokens=4096)
    assert refused.status_code == 402 and refused.json()["error"]["code"] == "budget_exhausted"


def test_hive_wide_cap(client):
    hive = client.app.state.hive
    hive.settings.hive_budget_usd = 1.0
    _, (a,) = make_swarm_and_agents(client, n=1, model="anthropic/claude-haiku-4-5-20251001", budget_usd=50)
    hive.db.insert("usage", {"agent_id": a["id"], "model": "x", "prompt_tokens": 0, "completion_tokens": 0,
                             "cost_usd": 0.999, "created_at": "2026-10-03T00:00:00Z"})
    refused = chat(client, a, max_tokens=1000)
    assert refused.status_code == 402 and refused.json()["error"]["code"] == "hive_budget_exhausted"


def test_calls_per_minute_ceiling_stops_retry_storms(client):
    client.app.state.hive.settings.max_llm_calls_per_minute = 3
    _, (a,) = make_swarm_and_agents(client, n=1)
    assert [chat(client, a).status_code for _ in range(3)] == [200, 200, 200]
    storm = chat(client, a)
    assert storm.status_code == 429 and storm.json()["error"]["code"] == "rate_limited"


# ---- goals: claims are leases, waiting is not failing -------------------------------------------

def goal(client, swarm, title="Map the sky"):
    return client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": title}).json()


def claim(client, agent, g):
    return client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(agent))


def result(client, agent, g, status, text=""):
    return client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(agent),
                       json={"status": status, "result": text})


def expire_now(client, g):
    hive = client.app.state.hive
    hive.db.update("goals", g["id"], {"lease_until": "2000-01-01T00:00:00.000Z"})
    return asyncio.run(hive.goals.expire())


def test_lapsed_claim_goes_back_to_the_swarm_then_stalls(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    g = goal(client, swarm)
    assert claim(client, a, g).json()["lease_until"]
    assert expire_now(client, g) == [g["id"]]
    reopened = client.get(f"/api/swarms/{swarm['id']}/goals").json()[0]
    assert reopened["status"] == "open" and reopened["claimed_by"] is None
    for agent in (b, a):
        assert claim(client, agent, g).status_code == 200
        expire_now(client, g)
    stalled = client.get(f"/api/swarms/{swarm['id']}/goals").json()[0]
    assert stalled["status"] == "stalled" and stalled["attempts"] == 3 and "stalled" in stalled["result"]
    assert claim(client, b, g).status_code == 409


def test_waiting_pauses_the_lease_and_heartbeat_resumes(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    g = goal(client, swarm)
    claim(client, a, g)
    waiting = result(client, a, g, "waiting", "sent Jon the draft; waiting on his reply").json()
    assert waiting["status"] == "waiting" and waiting["lease_until"] is None
    assert asyncio.run(client.app.state.hive.goals.expire()) == []
    assert client.post(f"/api/agent/goals/{g['id']}/heartbeat", headers=agent_headers(b)).status_code == 409
    resumed = client.post(f"/api/agent/goals/{g['id']}/heartbeat", headers=agent_headers(a)).json()
    assert resumed["status"] == "claimed" and resumed["lease_until"]


def test_done_needs_a_result(client):
    swarm, (a, _) = make_swarm_and_agents(client)
    g = goal(client, swarm)
    claim(client, a, g)
    empty = result(client, a, g, "done", "  ")
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "no_result"
    assert result(client, a, g, "done", "mapped 12 constellations").json()["status"] == "done"
    assert result(client, a, g, "done", "again").status_code == 409


def test_splitting_is_bounded(client):
    swarm, (a, _) = make_swarm_and_agents(client)
    parent = goal(client, swarm, "Big project")
    for _ in range(3):  # depth 0 -> 3 is the deepest allowed
        claim(client, a, parent)
        parent = client.post("/api/agent/goals", headers=agent_headers(a),
                             json={"title": "deeper", "parent_id": parent["id"]}).json()
        assert parent["status"] == "open", parent
    claim(client, a, parent)
    too_deep = client.post("/api/agent/goals", headers=agent_headers(a),
                           json={"title": "deeper", "parent_id": parent["id"]})
    assert too_deep.status_code == 400 and too_deep.json()["error"]["code"] == "too_deep"
    wide = goal(client, swarm, "Wide project")
    claim(client, a, wide)
    codes = [client.post("/api/agent/goals", headers=agent_headers(a),
                         json={"title": f"part {i}", "parent_id": wide["id"]}).status_code for i in range(13)]
    assert codes[:12] == [200] * 12 and codes[12] == 400
