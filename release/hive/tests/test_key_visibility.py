"""Key visibility for what leaves the hive (sol on 6dc7a837): seeing a mind or a provider never shows the key that pays.

One projection (hive/core/keyview.py, by GET /api/keys's own policy, key_permit) for HTTP and events alike:
- /api/providers and /api/providers/{name}: the default key's hint and account details only for someone who may see
  that key, and its account is never refreshed for anyone else;
- minds (lists, one mind, any JSON answer) and the agent.updated event: options.key only for someone who may see it;
- limit requests: the asker never gets the paying key's id, nor its owner when they asked about a mind.
The world: Mia and Bob are members; Ann's personal key is the provider default; Bob holds his own key. The operator is
an admin. Invented keys, synthetic people, disposable hives; no network.
"""
import json

import pytest

from hive.core.hive import token_hash as hive_token_hash

from hive.tests.test_ask_intents import ORIGIN, a, drain, held, release, token_of, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, err, s  # noqa: F401  (fixtures)
from hive.tests.test_studio_session_r7 import ANN_KEY, BOB, BOB_KEY, MODEL, personal_world


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    """No network, ever (conftest deny_network), installed before any app fixture of this module builds a hive."""


@pytest.fixture()
def p(s, monkeypatch):
    x = personal_world(s, monkeypatch)
    for prov in x.hive.keyring.providers.values():                                   # shared objects: undone afterwards
        monkeypatch.setattr(prov, "stored_key", prov.stored_key)
    x.hive.keyring._apply_defaults()                                                  # Ann's key is what pays by default
    x.hive.keyring.accounts[ANN_KEY] = {"label": "Ann's OpenRouter", "usage": 3.5, "limit": 20, "limit_remaining": 16.5}
    x.refreshed = []

    async def refresh(key_id):
        x.refreshed.append(key_id)
    monkeypatch.setattr(x.hive.keyring, "refresh_account", refresh)
    x.bobs_mind = x.client.post("/api/agents", headers=x.bob, json={"name": "Bob's helper", "kind": "omega", "model": MODEL,
                                                                     "budget_usd": 1, "options": {"key": BOB_KEY}}).json()
    assert x.client.put(f"/api/agents/{x.bobs_mind['id']}/visibility", headers=x.bob,
                        json={"visibility": "public"}).status_code == 200
    return x


def openrouter(listing):
    return next(v for v in listing if v["name"] == "openrouter")


def test_a_member_never_sees_another_members_default_key_on_the_provider_pages(p):
    c = p.client
    mine = openrouter(c.get("/api/providers", headers=p.mg).json())
    assert mine["key_hint"] == "" and mine["account"] is None
    assert mine["connected"] is True and mine["needs_key"] is True                   # what the provider can do stays
    one = c.get("/api/providers/openrouter", headers=p.mg).json()
    assert one["key_hint"] == "" and one["account"] is None
    assert p.refreshed == [], "Ann's account is never refreshed for Mia"
    admin = c.get("/api/providers/openrouter").json()                                # the operator: an admin
    assert admin["key_hint"] and admin["account"]["label"] == "Ann's OpenRouter" and p.refreshed == [ANN_KEY]


def test_a_shared_mind_never_shows_another_members_key_over_http(p):
    c, mind = p.client, p.bobs_mind
    listed = next(a for a in c.get("/api/agents", headers=p.mg).json() if a["id"] == mind["id"])
    one = c.get(f"/api/agents/{mind['id']}", headers=p.mg).json()
    for view in (listed, one):
        assert "key" not in view["options"], view["options"]
        assert BOB_KEY not in json.dumps(view)
    assert c.get(f"/api/agents/{mind['id']}", headers=p.bob).json()["options"]["key"] == BOB_KEY   # his own key
    assert c.get(f"/api/agents/{mind['id']}").json()["options"]["key"] == BOB_KEY                  # an admin


def test_the_agent_updated_event_never_carries_another_members_key(p):
    c, mind = p.client, p.bobs_mind
    with c.websocket_connect(f"/api/events?token={token_of(p.mg)}") as mia_ws, \
            c.websocket_connect(f"/api/events?token={token_of(p.bob)}") as bob_ws:
        for ws in (mia_ws, bob_ws):
            assert ws.receive_json()["type"] == "hello"
        assert c.patch(f"/api/agents/{mind['id']}", headers=p.bob, json={"persona": "Kind and brief."}).status_code == 200
        mia = [f for f in drain(mia_ws) if f.get("type") == "agent.updated" and f["agent"]["id"] == mind["id"]]
        bob = [f for f in drain(bob_ws) if f.get("type") == "agent.updated" and f["agent"]["id"] == mind["id"]]
    assert mia and all("key" not in f["agent"]["options"] and BOB_KEY not in json.dumps(f) for f in mia)
    assert bob and bob[-1]["agent"]["options"]["key"] == BOB_KEY


def test_a_limit_request_about_a_mind_never_tells_the_asker_whose_key_pays(p):
    c, mind = p.client, p.bobs_mind
    r = c.post("/api/me/limit-requests", headers=p.mg, json={"agent_id": mind["id"], "amount_usd": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"].startswith("lr_") and body["amount_usd"] == 5 and body["status"] == "pending"
    assert "key_id" not in body and "owner" not in body and BOB_KEY not in r.text and BOB not in r.text
    asked = c.get("/api/me/limit-requests", headers=p.mg).json()["asked"]
    assert asked and all("key_id" not in q and "owner" not in q for q in asked)
    to_bob = c.get("/api/me/limit-requests", headers=p.bob).json()["to_decide"]
    assert to_bob and to_bob[0]["key_id"] == BOB_KEY and to_bob[0]["owner"] == BOB   # his own key: he sees it all


def test_saving_a_shared_mind_with_the_options_as_shown_never_drops_its_hidden_key(p):
    """The projection hides Bob's key from Mia; if she may edit his mind, sending back the options she was shown (no
    key) must leave his key assignment exactly as it was, never move his mind onto another payer."""
    c, mind = p.client, p.bobs_mind
    shown = c.get(f"/api/agents/{mind['id']}", headers=p.mg).json()
    r = c.patch(f"/api/agents/{mind['id']}", headers=p.mg, json={"options": shown["options"], "persona": "Brief."})
    stored = json.loads(p.hive._agent_row(mind["id"])["options"] or "{}")
    assert stored.get("key") == BOB_KEY, (r.status_code, r.text, stored)


# ---- R2 (sol on f06f2915): error words, exports, live sockets, guests, the projector's own edge ---------------------

def test_moving_bobs_mind_to_another_provider_is_refused_in_words_that_name_no_key(p):
    c, mind = p.client, p.bobs_mind
    shown = c.get(f"/api/agents/{mind['id']}", headers=p.mg).json()
    r = c.patch(f"/api/agents/{mind['id']}", headers=p.mg, json={"options": shown["options"], "model": "anthropic/claude-sonnet-5-5"})
    assert (r.status_code, err(r)["code"]) == (400, "key_provider_mismatch")
    assert BOB_KEY not in r.text and "openrouter" not in r.text.lower(), r.text
    assert json.loads(p.hive._agent_row(mind["id"])["options"])["key"] == BOB_KEY       # nothing changed


def _bundle_text(response):
    import gzip
    return gzip.decompress(response.content).decode("latin-1")


def test_an_exported_mind_never_carries_a_key_its_exporter_may_not_see(p):
    c, hive = p.client, p.hive
    mine = c.post("/api/agents", headers=p.mg, json={"name": "Mia's notes", "kind": "omega", "model": MODEL, "budget_usd": 1}).json()
    assert c.patch(f"/api/agents/{mine['id']}", json={"options": {"key": BOB_KEY}}).status_code == 200   # an admin's doing
    out = c.post(f"/api/agents/{mine['id']}/export", headers=p.mg)
    assert out.status_code == 200, out.text
    assert BOB_KEY not in _bundle_text(out), "the bundle never carries Bob's key id"
    admin = c.post(f"/api/agents/{mine['id']}/export")
    assert admin.status_code == 200 and BOB_KEY in _bundle_text(admin), "an admin's export is whole"


def test_a_signed_out_socket_is_closed_at_its_next_frame_never_fed_more(p):
    from starlette.websockets import WebSocketDisconnect
    c, hive = p.client, p.hive
    ws = c.websocket_connect(f"/api/events?token={token_of(p.mg)}").__enter__()
    got, code = None, None
    try:
        assert ws.receive_json()["type"] == "hello"
        hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (hive_token_hash(token_of(p.mg)),))   # signed out
        hive.events.publish("agent.updated", agent=hive.agent(p.bobs_mind["id"]))   # a frame she would see, signed in
        try:
            got = ws.receive_json()   # the next thing the socket does: a frame (wrong) or its close (right)
        except WebSocketDisconnect as gone:
            code = gone.code
    finally:
        with __import__("contextlib").suppress(BaseException):
            if got is not None:   # a socket still streaming: close it from this side so the test fails, never hangs
                ws.close()
        with __import__("contextlib").suppress(BaseException):
            ws.__exit__(None, None, None)
    assert got is None, f"a signed-out socket was still fed: {got.get('type')}"
    assert code == 4401


def test_a_guest_never_sees_the_environment_keys_hint(p, monkeypatch):
    c, hive = p.client, p.hive
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-env-invented-0042")
    hive.keyring.ring["defaults"].pop("openrouter", None)
    hive.keyring._apply_defaults()
    guest = person(hive, "u_0e0e0e0e", role="member")
    hive.db.execute("UPDATE people SET access = 'guest' WHERE id = 'u_0e0e0e0e'")
    seen = openrouter(c.get("/api/providers", headers=guest).json())
    assert seen["key_hint"] == "" and seen["account"] is None and "0042" not in json.dumps(seen)
    assert openrouter(c.get("/api/providers").json())["key_hint"] == "…0042"           # an admin sees it


def test_the_projector_drops_what_lies_deeper_than_it_looks():
    from hive.core import keyview
    deep = {"options": {"key": "k_hidden"}, "id": "a_00000001"}
    for _ in range(keyview.MAX_DEPTH + 2):
        deep = {"child": deep}
    out = keyview.project(deep, lambda key: False, lambda name: None)
    assert "k_hidden" not in json.dumps(out)


# ---- R3 (sol on 59dfe1ff): a key named in the request is authorized before anything that would describe it ----------

def test_naming_someone_elses_key_or_a_made_up_one_reads_the_same_and_names_nothing(p):
    c = p.client
    mine = c.post("/api/agents", headers=p.mg, json={"name": "Mia's notes", "kind": "omega", "model": MODEL, "budget_usd": 1}).json()
    other_provider = "anthropic/claude-sonnet-5-5"
    answers = {}
    for name, key in (("bobs", BOB_KEY), ("madeup", "k_0000beef")):
        for model in (MODEL, other_provider):
            r = c.patch(f"/api/agents/{mine['id']}", headers=p.mg, json={"options": {"key": key}, "model": model})
            answers[(name, model)] = (r.status_code, r.text.replace(key, "<id>"))
            assert BOB_KEY not in r.text or key == BOB_KEY       # only the id she sent herself is echoed
            assert "openrouter" not in r.text.lower() and BOB_KEY + "'" not in r.text   # no provider, no label
    assert answers[("bobs", MODEL)] == answers[("madeup", MODEL)] == answers[("bobs", other_provider)] == \
        answers[("madeup", other_provider)], answers
    assert answers[("bobs", MODEL)][0] == 404
    assert json.loads(p.hive._agent_row(mine["id"])["options"] or "{}").get("key") is None   # nothing changed


def test_a_kept_key_the_caller_cannot_see_is_judged_in_words_that_name_nothing(p):
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as quiet:
        p.hive._options({"key": BOB_KEY}, "anthropic/claude-sonnet-5-5", hidden_key=True)
    assert quiet.value.code == "key_provider_mismatch" and "openrouter" not in str(quiet.value).lower()
    assert BOB_KEY not in str(quiet.value)
    with pytest.raises(HiveError) as plain:                                         # its owner or an admin: as before
        p.hive._options({"key": BOB_KEY}, "anthropic/claude-sonnet-5-5")
    assert "openrouter" in str(plain.value)


# ---- R4 (sol on 16842acb): the gateway's own words, and a model-only edit that would strand a kept key --------------

def test_the_gateway_never_names_an_assigned_key_to_whoever_calls_for_the_mind(p, monkeypatch):
    from hive.tests.test_core_api import agent_headers
    c, hive = p.client, p.hive
    router = hive.keyring.provider("openrouter")
    monkeypatch.setattr(router, "prices", {**router.prices, MODEL.partition("/")[2]: {"in": 1, "out": 1}})   # priced
    mine = c.post("/api/agents", headers=p.mg, json={"name": "Mia's harness", "kind": "omega", "model": MODEL, "budget_usd": 1}).json()
    assert c.patch(f"/api/agents/{mine['id']}", json={"options": {"key": BOB_KEY}}).status_code == 200   # an admin's doing
    del hive.keyring.ring["keys"][BOB_KEY]                                          # the key is gone
    r = c.post("/llm/v1/chat/completions", headers=agent_headers(mine),
               json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": 20})
    assert r.status_code == 402 and err(r)["code"] == "key_unavailable", r.text
    assert BOB_KEY not in r.text


def test_a_model_only_edit_never_strands_the_key_a_mind_keeps(p):
    c, hive, mind = p.client, p.hive, p.bobs_mind
    r = c.patch(f"/api/agents/{mind['id']}", headers=p.mg, json={"model": "anthropic/claude-sonnet-5-5"})   # no options
    assert (r.status_code, err(r)["code"]) == (400, "key_provider_mismatch")
    assert BOB_KEY not in r.text and "openrouter" not in r.text.lower()           # Mia may not see Bob's key
    admin = c.patch(f"/api/agents/{mind['id']}", json={"model": "anthropic/claude-sonnet-5-5"})
    assert (admin.status_code, err(admin)["code"]) == (400, "key_provider_mismatch") and "openrouter" in admin.text
    assert hive._agent_row(mind["id"])["model"] == MODEL                             # nothing changed
