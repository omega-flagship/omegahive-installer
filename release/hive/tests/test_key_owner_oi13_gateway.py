"""OI-13 r1.1 (stand-in P1): a person's key pays only for its owner, someone the owner granted, or a hive mind with no
person behind it, whether the key is assigned to the mind or is the provider default. The gateway refuses anyone else
with 402 own_key_needed before any reservation or dispatch, on chat, embeddings and media alike. Hive-held keys
(environment keys, owner hive or the operator) are unchanged. the owner 2026-10-19: "everyone needs studio, they just need to
use their own keys".
"""
import time

import pytest

from hive.tests.test_core_api import agent_headers
from hive.tests.test_media_route import _mind as media_mind, _req as media_req, m  # noqa: F401  (fixture)
from hive.tests.test_providers_api import client, fake  # noqa: F401  (fixtures)
from hive.tests.test_visibility import person

ANN, BOB = "u_0a0a0a0a", "u_0b0b0b0b"
K_ANN, K_BOB = "k_000a0a0a", "k_000b0b0b"
MODEL = "openrouter/acme/alpha"
CHAT = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}


def add_key(hive, key_id, owner, secret, provider="openrouter", default=False):
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": secret, "created_at": time.time()}
    if default:
        hive.keyring.ring["defaults"][provider] = key_id
    hive.keyring._apply_defaults()


def code(response):
    return response.json().get("error", {}).get("code") if response.status_code >= 400 else None


def reservations(hive):
    return hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]


@pytest.fixture()
def g(client, fake):  # noqa: F811
    hive = client.app.state.hive
    client.get("/api/providers/openrouter/catalog")            # prices for acme/alpha
    person(client, ANN, role="admin")                          # the first admin: the hive's owner
    person(client, BOB)
    add_key(hive, K_ANN, f"user:{ANN}", "sk-or-ann-personal", default=True)   # Ann's own key is the provider default
    swarm = hive.create_swarm("Lab")
    bob_mind = hive.create_agent("Bix", "omega", swarm["id"], MODEL, "", None, 1.0, None, None, f"user:{BOB}", "private", None)
    hive_mind = hive.create_agent("Hivey", "omega", swarm["id"], MODEL, "", None, 1.0, None, None, None, "private", None)
    ann_mind = hive.create_agent("Ada", "omega", swarm["id"], MODEL, "", None, 1.0, None, None, f"user:{ANN}", "private", None)
    return type("G", (), dict(client=client, fake=fake, hive=hive, bob_mind=bob_mind, hive_mind=hive_mind, ann_mind=ann_mind))


def chat(g, mind):
    return g.client.post("/llm/v1/chat/completions", json=CHAT, headers=agent_headers(mind))


def test_person_owned_default_refuses_another_member_before_anything(g):
    before = len(g.fake.chats)
    r = chat(g, g.bob_mind)
    assert r.status_code == 402 and code(r) == "own_key_needed", r.text
    assert "own key" in r.json()["error"]["message"]
    assert len(g.fake.chats) == before and reservations(g.hive) == 0    # nothing reserved, nothing sent
    assert g.hive.db.one("SELECT COUNT(*) AS n FROM usage WHERE key_id = ?", (K_ANN,))["n"] == 0


def test_person_owned_key_assigned_by_an_admin_refuses_another_member(g):
    g.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", ('{"key": "%s"}' % K_ANN, g.bob_mind["id"]))
    r = chat(g, g.bob_mind)
    assert code(r) == "own_key_needed", r.text
    assert reservations(g.hive) == 0


def test_member_with_own_key_is_paid_by_it_not_refused(g):
    add_key(g.hive, K_BOB, f"user:{BOB}", "sk-or-team")
    r = chat(g, g.bob_mind)
    assert r.status_code == 200, r.text
    assert g.fake.chats[-1][0] == "sk-or-team"                           # Bob's own key paid, not Ann's default


def test_a_grant_from_the_owner_lets_the_member_use_it(g):
    ann = g.client.app.state.hive
    from hive.core.visibility import Viewer
    ann.ownhive.set_limit(Viewer(f"user:{ANN}", True), f"user:{BOB}", {"grantee": f"user:{BOB}", "key_id": K_ANN, "month_usd": 5})
    r = chat(g, g.bob_mind)
    assert r.status_code == 200, r.text
    assert g.fake.chats[-1][0] == "sk-or-ann-personal"


def test_the_owner_and_a_hive_mind_are_allowed(g):
    assert chat(g, g.ann_mind).status_code == 200
    assert chat(g, g.hive_mind).status_code == 200


def test_hive_held_default_is_unchanged(g):
    add_key(g.hive, "k_000e0e0e", "user:operator", "sk-or-good", default=True)
    r = chat(g, g.bob_mind)
    assert r.status_code == 200, r.text
    assert g.fake.chats[-1][0] == "sk-or-good"


def test_embeddings_refuse_a_person_owned_default_for_another_member(g, monkeypatch):
    settings = g.hive.settings
    monkeypatch.setattr(settings, "embedding_model", MODEL)
    sent = []
    gw = g.client.app.state.gateway

    async def fake_embeddings(*a, **k):
        sent.append(a)
        return {"data": []}
    monkeypatch.setattr(gw, "embeddings", fake_embeddings)
    r = g.client.post("/llm/v1/embeddings", json={"input": "hello"}, headers=agent_headers(g.bob_mind))
    assert r.status_code == 402 and code(r) == "own_key_needed", r.text
    assert sent == [] and reservations(g.hive) == 0
    r = g.client.post("/llm/v1/embeddings", json={"input": "hello"}, headers=agent_headers(g.ann_mind))
    assert r.status_code == 200 and len(sent) == 1


def test_media_refuses_a_person_owned_default_for_another_member(m):  # noqa: F811
    hive = m.hive
    person(m, ANN, role="admin")
    person(m, BOB)
    add_key(hive, K_ANN, f"user:{ANN}", "sk-or-ann-media", default=True)
    _swarm, a = media_mind(m)
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", a["id"]))
    r = m.post("/llm/v1/media", json=media_req(), headers=agent_headers(a))
    assert r.status_code == 402 and code(r) == "own_key_needed", r.text
    assert m.vendor.posts == [] and reservations(hive) == 0
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{ANN}", a["id"]))
    r = m.post("/llm/v1/media", json=media_req("op-0002-abcdef"), headers=agent_headers(a))
    assert r.status_code == 200, r.text
    assert m.vendor.posts[-1]["auth"] == "Bearer sk-or-ann-media"


# ---- r1.2 (stand-in P1): embeddings carry the resolved default key through payer, limits, reservation and usage ------

def grant(g, month_usd):
    from hive.core.visibility import Viewer
    return g.hive.ownhive.set_limit(Viewer(f"user:{ANN}", True), f"user:{BOB}",
                                    {"grantee": f"user:{BOB}", "key_id": K_ANN, "month_usd": month_usd})


@pytest.fixture()
def emb(g, monkeypatch):
    """Embeddings on Ann's own key (the openrouter default), priced; the provider answered by a stub that records."""
    monkeypatch.setattr(g.hive.settings, "embedding_model", MODEL)
    g.sent = []
    gw = g.client.app.state.gateway

    async def fake_embeddings(model, body, agent=None):
        g.sent.append((model, agent and agent["id"], gw.provider("openrouter").api_key))
        return {"data": [{"embedding": [0.0]}], "usage": {"prompt_tokens": 7, "total_tokens": 7}}
    monkeypatch.setattr(gw, "embeddings", fake_embeddings)
    return g


def embed(g, mind):
    return g.client.post("/llm/v1/embeddings", json={"input": ["hello world"] * 3}, headers=agent_headers(mind))


def test_embeddings_zero_grant_is_refused_with_nothing_reserved_or_sent(emb):
    grant(emb, 0)
    r = embed(emb, emb.bob_mind)
    assert r.status_code == 402, r.text
    assert emb.sent == [] and reservations(emb.hive) == 0
    assert emb.hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0


def test_embeddings_exhausted_grant_is_refused(emb):
    grant(emb, 0.01)
    agent = emb.hive.agent(emb.bob_mind["id"])
    emb.hive.record_usage(agent, MODEL, {"prompt_tokens": 1, "completion_tokens": 0, "cost_usd": 0.01, "key_id": K_ANN},
                          None, f"user:{BOB}")                    # Bob's grant on Ann's key is used up
    r = embed(emb, emb.bob_mind)
    assert r.status_code == 402, r.text
    assert emb.sent == [] and reservations(emb.hive) == 0


def test_embeddings_grant_with_room_reserves_and_records_against_the_key(emb):
    grant(emb, 5)
    r = embed(emb, emb.bob_mind)
    assert r.status_code == 200, r.text
    assert len(emb.sent) == 1 and emb.sent[0][2] == "sk-or-ann-personal"
    (res,) = emb.hive.db.all("SELECT id FROM cost_reservations")
    meta = emb.client.app.state.hive.db.one("SELECT metadata FROM cost_reservation_details WHERE reservation = ?", (res["id"],))
    import json
    assert json.loads(meta["metadata"]).get("key") == K_ANN
    row = emb.hive.db.one("SELECT key_id, payer, key_grantee FROM usage ORDER BY id DESC LIMIT 1")
    assert row["key_id"] == K_ANN and row["payer"] == f"user:{BOB}" and row["key_grantee"] == f"user:{BOB}"


def test_embeddings_on_a_hive_held_default_are_unchanged_but_name_the_key(emb):
    add_key(emb.hive, "k_000e0e0e", "user:operator", "sk-or-good", default=True)
    r = embed(emb, emb.bob_mind)
    assert r.status_code == 200, r.text
    assert emb.sent[-1][2] == "sk-or-good"
    row = emb.hive.db.one("SELECT key_id, payer FROM usage ORDER BY id DESC LIMIT 1")
    assert row["key_id"] == "k_000e0e0e" and row["payer"] == f"user:{BOB}"    # the member, on the hive's key, as before


def test_first_light_says_own_key_needed_not_spend_limit(g):
    """Kimi follow-up 1: the greeting preflight names the real refusal."""
    from hive.core import onboarding
    with pytest.raises(Exception) as e:
        g.hive.onboarding.preflight(g.hive.agent(g.bob_mind["id"]))
    assert getattr(e.value, "code", None) == "own_key_needed"
    assert e.value.message == onboarding.SAY["own_key_needed"]
