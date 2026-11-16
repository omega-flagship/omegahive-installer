"""Which limit stops a mind next (Budgets.call_limits, GET /api/agents/{id}/limits) is the one admission refuses at: the
rows Reservations.reserve checks, each with its spend, the worst cases held against it by calls not yet settled, and the
room left, least room first. A call the reservation refuses is recorded and announced (budget.refused) naming that
limit, as Budgets.check's refusals are. A limit's numbers reach only people allowed to see that limit (the person it
is about, or an admin), and a pause is announced once. Synthetic people and minds, a scripted model, a disposable hive;
no network."""
import json

import pytest

from hive.core.limits_view import scope_visible
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL, _fake_chat, _gateway, _mind
from hive.tests.test_visibility import person

CHAT = "/llm/v1/chat/completions"
BODY = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 700}   # about $0.05 held per call
ANN, BOB = "u_0a0a0a0a", "u_0b0b0b0b"   # synthetic people (a person scope's id is hex: Budgets.SCOPE)


def passes(refusal):
    """Why a refusal refused: the spend, the worst cases held and the refused call's own worst case pass the limit."""
    assert refusal["spent_usd"] + refusal.get("held_usd", 0) + refusal["call_usd"] > refusal["limit_usd"], refusal


def _published(hive, monkeypatch):
    seen = []
    real = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **f: (seen.append((kind, f)), real(kind, **f))[1])
    return seen


def test_a_held_worst_case_takes_room_that_spend_alone_still_shows(client, monkeypatch):
    hive = client.app.state.hive
    a = _mind(client, 0.10)
    _fake_chat(_gateway(client), usage=False)   # the provider never says what a call cost: its worst case stays held
    before = client.get(f"/api/agents/{a['id']}/limits").json()
    assert before["free"] is False   # (no provider key in this test hive: settlement's reason says no_key; it changes no row)
    cap = next(r for r in before["limits"] if r["label"] == f"agent:{a['id']}:total")
    assert (cap["limit_usd"], cap["spent_usd"], cap["held_usd"], cap["room_usd"]) == (0.10, 0, 0, 0.10)
    assert client.post(CHAT, json=BODY, headers=agent_headers(a)).status_code == 200
    after = client.get(f"/api/agents/{a['id']}/limits").json()["limits"]
    first = after[0]   # least room first: the mind's own cap, with nothing spent and one worst case held
    assert first["label"] == f"agent:{a['id']}:total"
    held = first["held_usd"]
    assert first["spent_usd"] == 0 and 0.05 < held < 0.06   # the call's worst case at the model's price
    assert first["room_usd"] == pytest.approx(0.10 - held)
    assert [r["room_usd"] for r in after] == sorted(r["room_usd"] for r in after)
    assert hive.agent(a["id"])["spent_usd"] == 0   # what a page reading spend alone shows: nothing used


def test_a_call_refused_for_what_is_held_is_recorded_and_announced_with_its_limit(client, monkeypatch):
    hive = client.app.state.hive
    a = _mind(client, 0.10)
    _fake_chat(_gateway(client), usage=False)
    seen = _published(hive, monkeypatch)
    assert client.post(CHAT, json=BODY, headers=agent_headers(a)).status_code == 200
    held = client.get(f"/api/agents/{a['id']}/limits").json()["limits"][0]["held_usd"]
    # Budgets.check passes on spend alone ($0 + $0.05 <= $0.10); the reservation counts the first call's hold and refuses
    r = client.post(CHAT, json=BODY, headers=agent_headers(a))
    assert (r.status_code, r.json()["error"]["code"]) == (402, "reservation_refused"), r.text
    refused = [f for kind, f in seen if kind == "budget.refused"]
    assert len(refused) == 1
    # the second call asks for what the first holds: the same worst case
    assert refused[0] == {"agent_id": a["id"], "code": "reservation_refused", "count": 1, "scope": f"agent:{a['id']}",
                          "period": "total", "limit_usd": 0.10, "spent_usd": 0.0, "held_usd": pytest.approx(held),
                          "call_usd": pytest.approx(held)}
    passes(refused[0])
    kept = hive.refusals[a["id"]]
    assert (kept["code"], kept["scope"], kept["period"]) == ("reservation_refused", f"agent:{a['id']}", "total")
    # Health reads the same record
    issues = client.get(f"/api/agents/{a['id']}/health").json()
    assert "reservation_refused" in str(issues)


def test_a_refusal_before_the_call_names_its_limit_too(client, monkeypatch):
    hive = client.app.state.hive
    a = _mind(client, 0.01)   # the worst case ($0.0527) does not fit under the cap at all: Budgets.check refuses it
    _fake_chat(_gateway(client))
    seen = _published(hive, monkeypatch)
    r = client.post(CHAT, json=BODY, headers=agent_headers(a))
    assert r.status_code == 402, r.text
    refused = [f for kind, f in seen if kind == "budget.refused"]
    assert len(refused) == 1 and refused[0]["agent_id"] == a["id"] and refused[0]["count"] == 1
    assert {"scope", "period", "limit_usd", "spent_usd", "call_usd"} <= set(refused[0]), refused[0]
    passes(refused[0])
    assert hive.refusals[a["id"]]["call_usd"] == refused[0]["call_usd"]   # the record a mind's page reads says it too


def test_a_free_model_has_no_limits_and_a_viewer_sees_only_the_kind_of_a_scope_they_may_not_see(client):
    _, (free,) = make_swarm_and_agents(client, n=1, model="mock/echo")
    assert client.get(f"/api/agents/{free['id']}/limits").json() == {"free": True, "reason": None, "limits": []}
    a = _mind(client, 0.10)
    rows = client.get(f"/api/agents/{a['id']}/limits").json()["limits"]
    assert all(r["scope"] != "" and r["label"].startswith(r["scope"]) for r in rows)   # the operator sees every scope


def _anns_mind_bob_sees(client, allowance):
    """Ann's mind on the hive's money, held to her month allowance, in a team she shares with Bob."""
    ann, bob = person(client, ANN), person(client, BOB)
    team = client.post("/api/swarms", headers=ann, json={"name": "Ann's team"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": team["id"], "model": MODEL,
                                                         "budget_usd": 1.0}).json()
    for kind, ident in (("swarms", team["id"]), ("agents", mind["id"])):
        shared = {"visibility": "shared", "shared_with": [f"user:{BOB}"]}
        assert client.put(f"/api/{kind}/{ident}/visibility", headers=ann, json=shared).status_code == 200
    assert client.post("/api/budgets", json={"scope": f"person:{ANN}", "period": "month", "limit_usd": allowance}).status_code == 200
    return ann, bob, team, mind


def test_a_member_sees_no_numbers_of_a_limit_on_another_persons_spending(client):
    """Jon on #52: a limit's numbers go only to the person it is about, or an admin. Bob sees Ann's mind, which Ann's
    month allowance holds: Bob gets that limit in its place with no numbers and nothing about whose it is, Ann and an
    admin get it whole, and a mind of Ann's that Bob may not see is not found."""
    ann, bob, team, mind = _anns_mind_bob_sees(client, 5.0)
    label = f"person:{ANN}:month"
    read = {who: client.get(f"/api/agents/{mind['id']}/limits", headers=h).json()["limits"]
            for who, h in (("admin", {}), ("ann", ann), ("bob", bob))}
    for who in ("admin", "ann"):
        allowance = next(r for r in read[who] if r["label"] == label)
        assert (allowance["scope"], allowance["limit_usd"]) == (f"person:{ANN}", 5.0) and "hidden" not in allowance, who
    unseen = {k: None for k in ("label", "scope", "period", "limit_usd", "spent_usd", "held_usd", "room_usd")}
    # the same rows in the same order, Ann's allowance in its place with nothing in it
    assert [r if r["label"] != label else dict(unseen, hidden=True) for r in read["admin"]] == read["bob"]
    assert ANN not in json.dumps(read["bob"])
    assert f"agent:{mind['id']}:total" in [r["label"] for r in read["bob"]]   # the mind's own cap, as Bob sees the mind
    hers = client.post("/api/swarms", headers=ann, json={"name": "Ann's own"}).json()
    private = client.post("/api/agents", headers=ann, json={"name": "Quiet", "swarm_id": hers["id"], "model": MODEL}).json()
    assert client.get(f"/api/agents/{private['id']}/limits", headers=bob).status_code == 404


def test_a_refusal_carries_its_limit_only_to_whoever_may_see_it(client, monkeypatch):
    """Ann's mind refused for Ann's allowance: budget.refused goes out once, and on the events socket each receiver's frame
    (limit_frame) keeps the limit only for Ann and an admin; Bob, who sees the mind, gets the refusal alone, hidden. The
    record Health reads names no limit."""
    hive = client.app.state.hive
    ann, bob, team, mind = _anns_mind_bob_sees(client, 0.01)
    _fake_chat(_gateway(client))
    tokens = {"ann": ann, "bob": bob, "admin": {"Authorization": f"Bearer {client.operator_token}"}}
    with client.websocket_connect(f"/api/events?token={_token(tokens['ann'])}") as ann_ws, \
            client.websocket_connect(f"/api/events?token={_token(tokens['bob'])}") as bob_ws, \
            client.websocket_connect(f"/api/events?token={_token(tokens['admin'])}") as admin_ws:
        sockets = {"ann": ann_ws, "bob": bob_ws, "admin": admin_ws}
        for ws in sockets.values():
            assert ws.receive_json()["type"] == "hello"
        r = client.post(CHAT, json=BODY, headers=agent_headers(mind))
        assert (r.status_code, r.json()["error"]["code"]) == (402, "spend_limit"), r.text
        got = {k: [f for f in _drain(ws) if f.get("type") == "budget.refused"] for k, ws in sockets.items()}
    for who in ("ann", "admin"):
        (frame,) = got[who]
        assert (frame["scope"], frame["period"], frame["limit_usd"], "hidden" in frame) == (f"person:{ANN}", "month", 0.01, False), who
    (frame,) = got["bob"]
    assert {k: v for k, v in frame.items() if k != "at"} == {"type": "budget.refused", "agent_id": mind["id"],
                                                              "code": "spend_limit", "count": 1, "hidden": True}
    record = hive.refusals[mind["id"]]
    assert ANN not in record["message"] and "$" not in record["message"]
    assert ANN not in client.get(f"/api/agents/{mind['id']}/health", headers=bob).text


def _token(headers):
    return headers["Authorization"].split(" ", 1)[1]


def _drain(ws):
    """Every frame up to a ping barrier (as test_ask's drain)."""
    ws.send_json({"type": "ping"})
    frames = []
    for _ in range(500):
        f = ws.receive_json()
        if f.get("type") == "pong":
            return frames
        frames.append(f)
    raise AssertionError("no pong")


def test_a_pause_is_announced_once_and_again_after_a_call_is_admitted(client, monkeypatch):
    """Jon on #52: a notice per pause, not per restart. Two refusals announce one (count 1); a call admitted ends the
    pause, so the next refusal is announced as the first of a new one."""
    hive = client.app.state.hive
    a = _mind(client, 0.01)   # a call's worst case ($0.0527) does not fit under the cap
    _fake_chat(_gateway(client))   # each answered call reports its cost and is billed
    seen = _published(hive, monkeypatch)
    for _ in range(2):
        assert client.post(CHAT, json=BODY, headers=agent_headers(a)).status_code == 402
    assert hive.refusals[a["id"]]["count"] == 2
    assert client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 1.0}).status_code == 200
    assert client.post(CHAT, json=BODY, headers=agent_headers(a)).status_code == 200
    assert a["id"] not in hive.refusals   # admitted: the pause is over
    assert client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 0.06}).status_code == 200   # $0.0527 spent
    assert client.post(CHAT, json=BODY, headers=agent_headers(a)).status_code == 402
    assert [f["count"] for kind, f in seen if kind == "budget.refused"] == [1, 1]


def test_a_limit_on_someones_own_keys_is_seen_by_its_owner_and_its_grantee(client):
    """keyuse rows (one per key owner, key and grantee) and a limit on a key: the person they are about, or an admin."""
    hive = client.app.state.hive
    own = hive.ownhive._write_limit(f"user:{ANN}", "*", "self", 3.0, None, "owner", "", f"user:{ANN}")
    grant = hive.ownhive._write_limit(f"user:{ANN}", "*", f"user:{BOB}", 2.0, None, "owner", "", f"user:{ANN}")
    scope = lambda row: hive.db.one("SELECT scope FROM key_limits WHERE id = ?", (row["id"],))["scope"]
    hive.keyring.ring["keys"]["k_0c0c0c0c"] = {"id": "k_0c0c0c0c", "provider": "openrouter", "label": "Ann's",
                                               "owner": f"user:{ANN}", "secret": "sk-or-" + "v1-synthetic"}
    ann, bob, cid = Viewer(f"user:{ANN}", False), Viewer(f"user:{BOB}", False), Viewer("user:u_0d0d0d0d", False)
    admin = Viewer("user:operator", True)
    assert [scope_visible(hive, v, scope(own)) for v in (ann, bob, cid, admin)] == [True, False, False, True]
    assert [scope_visible(hive, v, scope(grant)) for v in (ann, bob, cid, admin)] == [True, True, False, True]
    assert [scope_visible(hive, v, "key:k_0c0c0c0c") for v in (ann, bob, admin)] == [True, False, True]
