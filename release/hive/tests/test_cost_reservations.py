"""S5 budget correctness (2026-10-04): shared reservations for chat and embeddings, unknown outcomes held until a
person resolves them, and a default output cap so the reserved worst case is real.  Builds on OmegaDesign's
reservation core (cost_reservations.py)."""
import asyncio

import httpx

from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401  (fixture)

MODEL = "anthropic/claude-opus-5-5"   # priced $15/$75 per million tokens


def _fake_chat(gateway, delay=0.05, fail=False, usage=True):
    async def chat(agent, body):
        await asyncio.sleep(delay)
        if fail:
            raise RuntimeError("provider went away")
        out = int(body.get("max_tokens") or 0)
        u = {"prompt_tokens": 10, "completion_tokens": out, "cost_usd": (10 * 15 + out * 75) / 1_000_000}
        resp = {"id": "r1", "model": MODEL, "choices": [{"message": {"content": "ok"}}]}
        if usage:
            resp["usage"] = {"prompt_tokens": 10, "completion_tokens": out}
        return resp, u
    gateway.chat = chat


def _mind(client, budget):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=budget)
    return a


def _gateway(client):
    return client.app.state.gateway if hasattr(client.app.state, "gateway") else client.app.state.hive.gateway


async def _two_calls(app, a, max_tokens):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": max_tokens}
        return await asyncio.gather(*[c.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a)) for _ in range(2)])


def test_concurrent_calls_cannot_overspend_a_shared_cap(client):
    a = _mind(client, 0.10)                                # each call reserves ~$0.0527; two would be $0.105
    _fake_chat(_gateway(client))
    results = asyncio.run(_two_calls(client.app, a, 700))
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 402], codes
    spent = client.app.state.hive.agent(a["id"])["spent_usd"]
    assert spent <= 0.10


def test_unknown_outcome_holds_the_cap_until_a_person_resolves_it(client):
    a = _mind(client, 0.10)
    gw = _gateway(client)
    _fake_chat(gw, fail=True)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 700}
    try:
        client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a))
    except RuntimeError:
        pass
    held = client.get("/api/budgets/reservations").json()
    assert len(held) == 1 and held[0]["state"] == "unknown"
    _fake_chat(gw)
    assert client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a)).status_code == 402   # still held
    rid = held[0]["id"]
    assert client.post(f"/api/budgets/reservations/{rid}/resolve", json={"action": "release"}).status_code == 400  # reason required
    r = client.post(f"/api/budgets/reservations/{rid}/resolve", json={"action": "release", "reason": "provider confirmed no charge"})
    assert r.status_code == 200 and r.json()["state"] == "released"
    assert client.get("/api/budgets/reservations").json() == []
    assert client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a)).status_code == 200


def test_settling_an_unknown_call_records_its_real_cost(client):
    a = _mind(client, 1.0)
    gw = _gateway(client)
    _fake_chat(gw, usage=False)                            # delivered, but the provider sent no usage: not zero cost
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 100}
    assert client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(a)).status_code == 200
    held = client.get("/api/budgets/reservations").json()
    assert held and held[0]["state"] == "unknown"
    before = client.app.state.hive.agent(a["id"])["spent_usd"]
    r = client.post(f"/api/budgets/reservations/{held[0]['id']}/resolve",
                    json={"action": "settle", "actual_usd": 0.004, "reason": "provider dashboard"})
    assert r.status_code == 200 and r.json()["state"] == "settled"
    assert abs(client.app.state.hive.agent(a["id"])["spent_usd"] - before - 0.004) < 1e-9


def test_a_call_without_max_tokens_gets_the_cap_the_estimate_assumed(client):
    a = _mind(client, 1.0)
    seen = {}
    gw = _gateway(client)

    async def chat(agent, body):
        seen.update(body)
        return {"id": "r", "model": MODEL, "usage": {"prompt_tokens": 1, "completion_tokens": 1}}, \
            {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.0001}
    gw.chat = chat
    assert client.post("/llm/v1/chat/completions", json={"messages": []}, headers=agent_headers(a)).status_code == 200
    assert seen["max_tokens"] == 4096


def test_only_admins_see_or_resolve_reservations(client):
    from hive.tests.test_visibility import person
    ann = person(client, "u_ann")
    assert client.get("/api/budgets/reservations", headers=ann).status_code == 403
    assert client.post("/api/budgets/reservations/x/resolve", headers=ann, json={"action": "release", "reason": "x"}).status_code == 403


def test_paid_embeddings_are_budgeted_and_recorded(client):
    """Embeddings used to bypass every budget, the rate limit and usage recording."""
    hive = client.app.state.hive
    gw = _gateway(client)
    gw.providers["openai"].prices["text-embedding-3-small"] = {"in": 20, "out": 0}
    object.__setattr__(hive.settings, "embedding_model", "openai/text-embedding-3-small")

    async def embeddings(model, body, agent=None):
        return {"object": "list", "data": [{"embedding": [0.0]}], "usage": {"prompt_tokens": 1000, "total_tokens": 1000}}
    gw.embeddings = embeddings
    a = _mind(client, 1.0)
    r = client.post("/llm/v1/embeddings", json={"input": ["hello world"]}, headers=agent_headers(a))
    assert r.status_code == 200
    assert abs(hive.agent(a["id"])["spent_usd"] - 1000 * 20 / 1_000_000) < 1e-9
    poor = _mind(client, 0.0)                               # a mind with no budget cannot pay for embeddings
    assert client.post("/llm/v1/embeddings", json={"input": ["x"]}, headers=agent_headers(poor)).status_code == 402


def test_restart_starts_the_unknown_expiry_clock(tmp_path):
    """Design budget_restart_expiry r1 (5d2c2a6b): a reservation left reserved/dispatched by a restart, or an older
    unknown row with no clock, gets unknown_at at recovery, so the 24-hour worst-case settlement can run; an existing
    clock is kept on a second restart, and settled rows are untouched."""
    import time
    from hive.core.cost_reservations import Reservations
    from hive.core.db import Database
    db = Database(tmp_path / "h.db")
    Reservations(db)
    rows = [("r1", "reserved", None), ("r2", "dispatched", None), ("r3", "unknown", None), ("r4", "unknown", 100.0),
            ("r5", "settled", None)]
    for key, state, at in rows:
        db.execute("INSERT INTO cost_reservations (id, binding, maximum, state, unknown_at) VALUES (?,?,?,?,?)",
                   (key, "b", 1, state, at))
    before = time.time()

    def recover():   # linkage slice 1: recovery is the one startup step, never a side effect of construction
        with db._lock:
            Reservations.recover_startup(db._conn)
            db._conn.commit()
    # Kimi r10 finding 3: a row that does have a dispatch time still gets recovery time, never the earlier dispatch time
    db.execute("INSERT INTO cost_reservations (id, binding, maximum, state, dispatched_at) VALUES (?,?,?,?,?)",
               ("r6", "b", 1, "dispatched", before - 100000))
    recover()
    got = {r["id"]: (r["state"], r["unknown_at"]) for r in db.all("SELECT id, state, unknown_at FROM cost_reservations")}
    for key in ("r1", "r2", "r3", "r6"):
        assert got[key][0] == "unknown" and got[key][1] >= before, key
    assert got["r4"] == ("unknown", 100.0), "an existing clock is never moved"
    assert got["r5"] == ("settled", None), "settled rows are untouched"
    first = got["r1"][1]
    recover()
    assert db.one("SELECT unknown_at FROM cost_reservations WHERE id='r1'")["unknown_at"] == first


def test_an_unknown_expired_alert_can_be_published():
    """Design budget_expiry_event r1 (b4cb65de): the expiry alert carries a `kind` field; publishing it must not
    collide with publish()'s own event-kind parameter (it raised TypeError, so the alert was silently lost)."""
    import asyncio
    import json
    from hive.core.events import EventBus

    async def main():
        bus = EventBus()
        bus.bind(asyncio.get_running_loop())
        queue = bus.subscribe()
        bus.publish("budget.overrun", kind="unknown-expired", reservation="r1", held_usd=0.01)
        return json.loads(await asyncio.wait_for(queue.get(), 1))

    frame = asyncio.run(main())
    assert frame["type"] == "budget.overrun" and frame["kind"] == "unknown-expired" and frame["reservation"] == "r1"
