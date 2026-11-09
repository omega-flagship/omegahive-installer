"""hive-core API against the real app, spaces and gateway (fake process driver)."""

import json
import os
import pathlib
import tempfile
import threading

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class FakeSupervisor:
    def __init__(self):
        self.calls = []
        self.hive = None

    def attach(self, hive):
        self.hive = hive

    def lock(self, agent_id):
        return self.__dict__.setdefault("_locks", {}).setdefault(agent_id, threading.RLock())

    def prepare(self, agent, token):
        self.calls.append(("prepare", agent["id"]))

    def reconfigure(self, agent):
        self.calls.append(("reconfigure", agent["id"]))

    def start(self, agent_id):
        self.calls.append(("start", agent_id))

    def stop(self, agent_id):
        self.calls.append(("stop", agent_id))

    def logs(self, agent_id, tail=200):
        return ["line one", "line two"][-tail:]

    def check(self):
        pass


@pytest.fixture()
def client(monkeypatch):
    # This shared fixture exercises the legacy API route explicitly. Conductor and first-install tests select
    # their own setting; an absent switch in production now enables Ask.
    if "HIVE_ASK_CONDUCTOR" not in os.environ:
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    # The MeTTa coding controller (on in production) is selected by its own tests; the shared fixture keeps the earlier path.
    if "HIVE_CODE_CONTROLLER_ENGINE" not in os.environ:
        monkeypatch.setenv("HIVE_CODE_CONTROLLER_ENGINE", "0")
    data = tempfile.mkdtemp(prefix="hive-test-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA)
    supervisor = FakeSupervisor()
    app = create_app(settings, supervisor=supervisor, reconcile_seconds=0)
    with TestClient(app) as test_client:
        token = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        test_client.headers["Authorization"] = f"Bearer {token}"
        test_client.operator_token = token
        test_client.supervisor = supervisor
        yield test_client


def make_swarm_and_agents(client, n=2, **agent_fields):
    swarm = client.post("/api/swarms", json={"name": "Alpha"}).json()
    agents = [client.post("/api/agents", json=dict({"name": f"Dot{i}", "swarm_id": swarm["id"]}, **agent_fields)).json()
              for i in range(n)]
    return swarm, agents


def agent_headers(agent):
    return {"Authorization": f"Bearer {agent['token']}"}


def test_login_required_and_wrong_password(client):
    assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    anonymous = TestClient(client.app)
    response = anonymous.get("/api/agents")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_non_ascii_operator_passwords_are_compared_without_server_errors(client):
    assert client.post("/api/auth/login", json={"password": "invented-wrøng"}).status_code == 401
    client.app.state.hive.settings.admin_password = "invented-corréct"
    assert client.post("/api/auth/login", json={"password": "pw"}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "invented-corréct"}).status_code == 200


def test_swarm_and_agent_lifecycle(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    assert a["token"] and a["model"] == "mock/echo" and a["status"] == "created"
    assert client.get(f"/api/swarms/{swarm['id']}").json()["member_ids"] == [a["id"], b["id"]]
    assert client.post(f"/api/agents/{a['id']}/start").json()["status"] == "starting"
    assert client.post(f"/api/agents/{a['id']}/sleep").json()["status"] == "asleep"
    patched = client.patch(f"/api/agents/{a['id']}", json={"persona": "curious", "hue": 400}).json()
    assert patched["persona"] == "curious" and patched["hue"] == 40
    assert client.delete(f"/api/agents/{b['id']}").json() == {"ok": True}
    assert client.get(f"/api/swarms/{swarm['id']}").json()["member_ids"] == [a["id"]]
    assert ("start", a["id"]) in client.supervisor.calls
    assert client.get(f"/api/agents/{a['id']}/logs").json() == {"lines": ["line one", "line two"]}


def test_hub_delivers_replays_and_records_replies(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")       # a hive-run mind connects only once started (desired awake)
    sent = client.post(f"/api/agents/{a['id']}/messages", json={"text": "hello dot"}).json()
    assert sent["direction"] == "in"
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        assert client.get(f"/api/agents/{a['id']}").json()["connected"] is True
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": None}))
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "user_message" and frame["seq"] == 1
        envelope = json.loads(frame["text"])
        assert envelope["hive"] == 1 and envelope["text"] == "hello dot"
        ws.send_text(json.dumps({"type": "agent_message", "client_seq": "x1", "text": "hi!",
                                 "conversation_id": envelope["conversation_id"]}))
        assert json.loads(ws.receive_text())["type"] == "ack"
        ws.send_text(json.dumps({"type": "agent_message", "client_seq": "x1", "text": "hi!"}))  # retry
        json.loads(ws.receive_text())
    history = client.get(f"/api/agents/{a['id']}/messages").json()
    assert [(m["direction"], m["text"]) for m in history] == [("in", "hello dot"), ("out", "hi!")]
    with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
        ws.send_text(json.dumps({"type": "resume", "last_seen_seq": 1}))
        client.post(f"/api/agents/{a['id']}/messages", json={"text": "second"})
        assert json.loads(json.loads(ws.receive_text())["text"])["text"] == "second"


def test_hub_refuses_a_stopped_mind_and_keeps_it_stopped(client):
    """A late connection from a process a completed stop was ending: refused (4409), the row stays stopped."""
    from starlette.websockets import WebSocketDisconnect
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/start")
    client.post(f"/api/agents/{a['id']}/stop")
    hive = client.app.state.hive
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/agent-hub", headers=agent_headers(a)) as ws:
            row = hive._agent_row(a["id"])             # checked before receiving: an accepted socket would block here
            assert (row["status"], row["desired"], a["id"] in hive.connections) == ("stopped", "stopped", False)
            ws.receive_text()
    assert closed.value.code == 4409
    row = hive._agent_row(a["id"])
    assert (row["status"], row["desired"]) == ("stopped", "stopped")
    assert client.get(f"/api/agents/{a['id']}").json()["connected"] is False


def test_hub_rejects_bad_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/agent-hub", headers={"Authorization": "Bearer nope"}) as ws:
            ws.receive_text()


def test_gateway_mock_model_meters_usage(client):
    _, (a, _) = make_swarm_and_agents(client)
    prompt = "PROMPT ... HUMAN-MSG: CHANNEL_EVENT\nchannel=hive\ntext=believe (--> sky blue) 0.9 0.8"
    response = client.post("/llm/v1/chat/completions", headers=agent_headers(a),
                           json={"model": "x", "messages": [{"role": "user", "content": prompt}]}).json()
    text = response["choices"][0]["message"]["content"]
    assert text.startswith("hive-publish (--> sky blue) 0.9 0.8")
    idle = client.post("/llm/v1/chat/completions", headers=agent_headers(a),
                       json={"messages": [{"role": "user", "content": "no news"}]}).json()
    assert idle["choices"][0]["message"]["content"] == "wait idle"
    assert len(client.get(f"/api/usage?agent_id={a['id']}").json()) == 2
    vectors = client.post("/llm/v1/embeddings", headers=agent_headers(a), json={"input": ["a", "b"]}).json()
    assert len(vectors["data"]) == 2 and len(vectors["data"][0]["embedding"]) == 384


def test_budget_is_enforced(client):
    _, (a,) = make_swarm_and_agents(client, n=1, budget_usd=0.01)
    client.app.state.hive.db.execute("UPDATE agents SET spent_usd = 0.02 WHERE id = ?", (a["id"],))
    response = client.post("/llm/v1/chat/completions", headers=agent_headers(a), json={"messages": []})
    assert response.status_code == 402
    assert response.json()["error"]["code"] == "budget_exhausted"


def test_publish_echo_revision_and_provenance(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    first = client.post("/api/agent/publish", headers=agent_headers(a),
                        json={"statement": "(--> sky blue)", "f": 0.9, "c": 0.8}).json()
    assert first["outcome"] == "adopted" and first["stamp"] == [f"ev:{a['id']}:1"]
    echo = client.post("/api/agent/publish", headers=agent_headers(b),
                       json={"statement": "(--> sky blue)", "f": 0.9, "c": 0.8, "evidence": first["stamp"]}).json()
    assert echo["outcome"] == "kept"
    forged = client.post("/api/agent/publish", headers=agent_headers(b),
                         json={"statement": "(--> sky blue)", "f": 0.9, "c": 0.8, "evidence": ["ev:zzz:9"]})
    assert forged.status_code == 400 and forged.json()["error"]["code"] == "bad_evidence"
    for wildcard in ("ev:%:1", "ev:a_%:1", "ev:_______:1", f"ev:{a['id']}:%"):   # LIKE wildcards are not evidence
        r = client.post("/api/agent/publish", headers=agent_headers(b),
                        json={"statement": "(--> grass green)", "f": 0.9, "c": 0.8, "evidence": [wildcard]})
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_evidence", wildcard
    third = client.post("/api/agent/publish", headers=agent_headers(b),
                        json={"statement": "(--> sky blue)", "f": 0.1, "c": 0.6}).json()
    assert third["outcome"] == "revised"
    beliefs = client.get(f"/api/swarms/{swarm['id']}/beliefs").json()
    assert len(beliefs) == 1 and beliefs[0]["tv"] == {"f": 0.681818, "c": 0.846154}
    assert sorted(beliefs[0]["sources"]) == sorted([a["id"], b["id"]])
    detail = client.get(f"/api/swarms/{swarm['id']}/beliefs/detail",
                        params={"statement": "(--> sky blue)"}).json()
    assert [x["outcome"] for x in detail["assertions"]] == ["adopted", "kept", "revised"]
    assert client.get(f"/api/swarms/{swarm['id']}/vocab").json() == ["blue", "sky"]
    query = client.post("/api/agent/query", headers=agent_headers(a), json={"pattern": "(Current $s $t $st)"}).json()
    assert len(query["results"]) == 1
    bad = client.post("/api/agent/publish", headers=agent_headers(a), json={"statement": "!(add-atom &hive_acl x)"})
    assert bad.status_code == 400


def test_live_events_stream(client):
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        swarm = client.post("/api/swarms", json={"name": "Beta"}).json()
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "swarm.updated" and frame["swarm"]["id"] == swarm["id"]
        assert json.loads(ws.receive_text())["type"] == "room"     # its team room (rooms.py)
        client.post("/api/agents", json={"name": "Nova", "swarm_id": swarm["id"]})
        kinds = {json.loads(ws.receive_text())["type"] for _ in range(2)}
        assert kinds == {"swarm.updated", "agent.updated"}


def test_repeating_a_belief_does_not_inflate_confidence(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    for _ in range(5):
        client.post("/api/agent/publish", headers=agent_headers(a), json={"statement": "(--> sky blue)", "f": 0.9, "c": 0.8})
    beliefs = client.get(f"/api/swarms/{swarm['id']}/beliefs").json()
    assert beliefs[0]["tv"] == {"f": 0.9, "c": 0.8} and beliefs[0]["stamp"] == [f"ev:{a['id']}:1"]
    fresh = client.post("/api/agent/publish", headers=agent_headers(a),
                        json={"statement": "(--> sky blue)", "f": 0.9, "c": 0.8, "new_evidence": True}).json()
    assert fresh["outcome"] == "revised" and fresh["stamp"] == [f"ev:{a['id']}:2"]


def test_a_stopped_outside_member_becomes_a_native_mind_in_place(client):
    swarm = client.post("/api/swarms", json={"name": "Reviewers"}).json()
    m = client.post("/api/agents", json={"name": "Reviewer", "kind": "module", "swarm_id": swarm["id"]}).json()
    old = {"Authorization": f"Bearer {m['token']}"}
    assert client.get("/api/agent/goals", headers=old).status_code == 200
    out = client.post(f"/api/agents/{m['id']}/convert-native").json()
    assert out["id"] == m["id"] and out["kind"] == "omega" and out["swarm_id"] == swarm["id"]
    assert client.get("/api/agent/goals", headers=old).status_code == 401          # the outside token stops working
    assert client.post(f"/api/agents/{m['id']}/convert-native").status_code == 409  # only once
    assert client.post(f"/api/agents/{m['id']}/start").json()["status"] == "starting"   # and now it can run
