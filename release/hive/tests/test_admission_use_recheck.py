"""money port r1.2: a payer's use of a key is read again inside the reservation transaction (host_use_check).

The preflight (Budgets.check -> OwnHive.use_check) can pass, and the person then be disabled or their grant revoked,
before the reservation: on the hive's keys that leaves (payer, own_key) unchanged, so the payer re-check alone let the
call reserve and dispatch. Each paid path that reserves (chat, embeddings, media, the Ask conductor) now refuses there,
with nothing held and no provider call. Deterministic: the change is made right after the real preflight returns.
Synthetic people, disposable hives; no network.
"""
from hive.core.db import now
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, on, script, wait  # noqa: F401  (fixture)
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL, _fake_chat, _gateway
from hive.tests.test_media_route import _mind as media_mind, _req, _states, m  # noqa: F401  (fixture)
from hive.tests.test_own_hive import BOB, OWNER, _keyed_mind, make_guest, world  # noqa: F401  (fixture)


def after_preflight(monkeypatch, hive, change):
    """Run `change` once, right after the call's real preflight (Hive.check_budget) has passed."""
    real, done = hive.check_budget, []

    def checked(*args, **kwargs):
        out = real(*args, **kwargs)
        if not done:
            done.append(1)
            change()
        return out
    monkeypatch.setattr(hive, "check_budget", checked)
    return done


def disable(hive, pid):
    return lambda: hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", (pid,))


def held(hive):
    return hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]


def counted(gw):
    calls, real = [], gw.chat

    async def chat(agent, body):
        calls.append(agent["id"])
        return await real(agent, body)
    gw.chat = chat
    return calls


def test_chat_on_the_hive_key_refuses_a_person_disabled_after_preflight(world, client, monkeypatch):  # noqa: F811
    hive = world["hive"]
    _, (mind,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=10)
    hive.db.execute("UPDATE agents SET owner = ?, options = '{}' WHERE id = ?", (f"user:{BOB}", mind["id"]))
    gw = _gateway(client)
    _fake_chat(gw)
    calls = counted(gw)
    done = after_preflight(monkeypatch, hive, disable(hive, BOB))
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(mind),
                    json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 50})
    assert done and r.status_code == 402 and r.json()["error"]["code"] == "no_key_grant", r.text
    assert calls == [] and held(hive) == 0


def test_chat_refuses_a_guest_whose_grant_was_revoked_after_preflight(world, client, monkeypatch):  # noqa: F811
    """A guest on the owner's stored key with a live grant (no visitor allowance to fall back on): the grant is revoked
    between preflight and reservation; nothing is held or sent."""
    hive = world["hive"]
    _view, guest = make_guest(client, hive, limit=3.0)
    mind, calls = _keyed_mind(client, f"user:{guest['id']}")
    revoke = lambda: hive.db.execute("UPDATE key_limits SET revoked_at = ? WHERE grantee = ?",   # noqa: E731
                                     (now(), f"user:{guest['id']}"))
    done = after_preflight(monkeypatch, hive, revoke)
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(mind),
                    json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 50})
    assert done and r.status_code == 402 and r.json()["error"]["code"] == "no_key_grant", r.text
    assert calls == [] and held(hive) == 0


def test_embeddings_refuse_a_person_disabled_after_preflight(world, client, monkeypatch):  # noqa: F811
    hive = world["hive"]
    gw = _gateway(client)
    gw.providers["openai"].prices["text-embedding-3-small"] = {"in": 20, "out": 0}
    object.__setattr__(hive.settings, "embedding_model", "openai/text-embedding-3-small")
    sent = []

    async def embeddings(model, body, agent=None, **kwargs):
        sent.append(model)
        return {"object": "list", "data": [{"embedding": [0.0]}], "usage": {"prompt_tokens": 1000, "total_tokens": 1000}}
    gw.embeddings = embeddings
    _, (mind,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=10)
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", mind["id"]))
    done = after_preflight(monkeypatch, hive, disable(hive, BOB))
    r = client.post("/llm/v1/embeddings", json={"input": ["hello"]}, headers=agent_headers(mind))
    assert done and r.status_code == 402 and r.json()["error"]["code"] == "no_key_grant", r.text
    assert sent == [] and held(hive) == 0


def test_media_refuses_a_person_disabled_after_preflight(m, monkeypatch):  # noqa: F811
    hive = m.hive
    hive.db.insert("people", {"id": "u_media_bob", "email": "mb@example.test", "name": "MB", "role": "member",
                              "created_at": now()})
    _, a = media_mind(m)
    hive.db.execute("UPDATE agents SET owner = 'user:u_media_bob' WHERE id = ?", (a["id"],))
    done = after_preflight(monkeypatch, hive, disable(hive, "u_media_bob"))
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert done and r.status_code == 402 and r.json()["error"]["code"] == "no_key_grant", r.text
    assert m.vendor.posts == [] and _states(m) == []


def test_the_ask_conductor_refuses_an_asker_disabled_after_preflight(client, on, monkeypatch):  # noqa: F811
    from hive.core.config import Provider
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    s = script(client, Script([call("say", text="one")], "never", cost=0.004))
    done = after_preflight(monkeypatch, hive, disable(hive, "u_ann"))
    ask(client, on["ann"], "op-r12-disabled", context=on["ctx"])
    fs = wait(hive, "op-r12-disabled", closed)
    assert done and s.bodies == [] and fs[-1]["outcome"] == "spend_cap", fs[-1]
    assert held(hive) == 0
