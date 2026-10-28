"""Harness invitations and the MCP endpoint: invite code -> member -> tools, all through the hive's rules."""

import json
import os
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class Supervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


@pytest.fixture()
def c(monkeypatch):
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-mcp-")), admin_password="pw", petta_path=PETTA,
                             offline=True, base_path="/omegahive")
    with TestClient(create_app(settings, supervisor=Supervisor(), reconcile_seconds=0)) as client:
        client.admin = {"Authorization": "Bearer " + client.post("/api/auth/login", json={"password": "pw"}).json()["token"]}
        yield client


def rpc(c, code, method, params=None, mid=1, path="/omegahive/mcp"):
    return c.post(path, json={"jsonrpc": "2.0", "id": mid, "method": method, **({"params": params} if params is not None else {})},
                  headers={"Authorization": f"Bearer {code}"})


def tool(c, code, name, args=None):
    r = rpc(c, code, "tools/call", {"name": name, "arguments": args or {}})
    assert r.status_code == 200, r.text
    body = r.json()
    if "error" in body:  # s3-r1: tool errors are JSON-RPC errors, -32000, with data {code, http_status, message}
        assert body["error"]["code"] == -32000 and body["error"]["data"]["code"]
        return {"error": body["error"]["data"]["code"], "message": body["error"]["data"]["message"]}, True
    result = body["result"]
    assert result["isError"] is False and result["structuredContent"] is not None
    return result["structuredContent"], False


def test_invite_connect_and_work(c):
    swarm = c.post("/api/swarms", json={"name": "Team", "description": "test things"}, headers=c.admin).json()
    role = next(r for r in c.get("/api/roles", headers=c.admin).json() if r["name"] == "Reviewer")
    inv = c.post("/api/harness-invites", json={"harness": "claude-code", "name": "Claude", "swarm_id": swarm["id"], "role_id": role["id"]}, headers=c.admin).json()
    assert inv["status"] == "waiting" and inv["code"].startswith("ohv1_") and inv["mcp_url"] == "https://hive.example/omegahive/mcp"
    code = inv["code"]
    init = rpc(c, code, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()
    assert init["result"]["serverInfo"]["name"] == "omegahive" and init["result"]["capabilities"]["tools"]
    assert c.post("/omegahive/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={"Authorization": f"Bearer {code}"}).status_code == 202
    status = c.get(f"/api/harness-invites/{inv['id']}", headers=c.admin).json()
    assert status["status"] == "connected" and status["agent_id"]
    listed = rpc(c, code, "tools/list").json()["result"]
    assert listed["_meta"] == {"x-hive-schema": "s3-r1"} and init["result"]["serverInfo"]["version"] == "0.2.0"
    names = [t["name"] for t in listed["tools"]]
    assert {"hive_whoami", "hive_inbox", "hive_send", "hive_goals", "hive_goal_claim", "hive_goal_result", "hive_publish", "hive_query"} <= set(names)
    me, _ = tool(c, code, "hive_whoami")
    assert me["name"] == "Claude" and me["swarm"]["name"] == "Team" and me["role"].startswith("You are Claude, the reviewer in Team.")
    # a person writes to it; it reads and replies
    c.post(f"/api/agents/{me['id']}/messages", json={"text": "please review goal one"}, headers=c.admin)
    inbox, _ = tool(c, code, "hive_inbox")
    assert inbox["messages"][-1]["text"] == "please review goal one"
    sent, _ = tool(c, code, "hive_send", {"text": "On it.", "conversation_id": inbox["messages"][-1]["conversation_id"]})
    msgs = c.get(f"/api/agents/{me['id']}/messages", headers=c.admin).json()
    assert msgs[-1]["text"] == "On it." and msgs[-1]["direction"] == "out"
    # goals: see, claim, finish
    goal = c.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "goal one"}, headers=c.admin).json()
    goals, _ = tool(c, code, "hive_goals")
    assert [g["id"] for g in goals["goals"]] == [goal["id"]]
    claimed, _ = tool(c, code, "hive_goal_claim", {"goal_id": goal["id"]})
    assert claimed["claimed_by"] == me["id"]
    done, _ = tool(c, code, "hive_goal_result", {"goal_id": goal["id"], "status": "done", "result": "reviewed: fine"})
    assert done["status"] == "done"
    # beliefs
    pub, err = tool(c, code, "hive_publish", {"statement": "(--> sky blue)", "f": 0.9, "c": 0.8})
    assert not err and pub["outcome"] == "adopted"
    found, _ = tool(c, code, "hive_query", {"pattern": "(Current (--> sky $x) $tv $stamp)"})
    assert found["results"]


def test_codes_and_members_are_bounded(c):
    swarm = c.post("/api/swarms", json={"name": "Team"}, headers=c.admin).json()
    inv = c.post("/api/harness-invites", json={"harness": "codex", "name": "Codex", "swarm_id": swarm["id"]}, headers=c.admin).json()
    code = inv["code"]
    assert rpc(c, "ohv1_forged", "initialize").status_code == 401
    assert rpc(c, "", "initialize").status_code == 401
    assert rpc(c, code, "initialize").status_code == 200
    # the code is now the member's credential, not a second member
    assert rpc(c, code, "tools/list").status_code == 200
    members = [a for a in c.get("/api/agents", headers=c.admin).json() if a["name"] == "Codex"]
    assert len(members) == 1 and members[0]["kind"] == "module"
    # a member is not an operator, and cannot reach private agent routes from outside
    member = {"Authorization": f"Bearer {code}"}
    assert c.get("/omegahive/api/hive", headers=member).status_code == 401
    assert c.get("/omegahive/api/agent/inbox", headers=member).status_code == 404
    # unknown tools and bad input are errors, not crashes
    out, err = tool(c, code, "hive_shell", {"cmd": "ls"})
    assert err and out["error"] == "unknown_tool"
    out, err = tool(c, code, "hive_goal_claim", {"goal_id": "g_nope"})
    assert err
    # revocation ends it
    c.delete(f"/api/harness-invites/{inv['id']}", headers=c.admin)
    assert rpc(c, code, "tools/list").status_code == 401
    # expired codes never connect; names cannot be reused
    old = c.post("/api/harness-invites", json={"harness": "hermes", "name": "Old", "swarm_id": swarm["id"], "ttl_minutes": 5}, headers=c.admin).json()
    c.app.state.hive.db.execute("UPDATE harness_invites SET expires_at = 0 WHERE id = ?", (old["id"],))
    assert rpc(c, old["code"], "initialize").status_code == 401
    assert c.post("/api/harness-invites", json={"harness": "mcp", "name": "Old", "swarm_id": swarm["id"]}, headers=c.admin).status_code == 200
    taken = c.post("/api/harness-invites", json={"harness": "mcp", "name": "Team member", "swarm_id": swarm["id"]}, headers=c.admin).json()
    assert taken.get("status") == "waiting"
    assert c.post("/api/harness-invites", json={"harness": "bogus", "name": "X", "swarm_id": swarm["id"]}, headers=c.admin).json()["error"]["code"] == "bad_harness"


def test_rate_limit(c, monkeypatch):
    swarm = c.post("/api/swarms", json={"name": "Team"}, headers=c.admin).json()
    code = c.post("/api/harness-invites", json={"harness": "mcp", "name": "Busy", "swarm_id": swarm["id"]}, headers=c.admin).json()["code"]
    statuses = [rpc(c, code, "ping", mid=i).status_code for i in range(125)]
    assert statuses.count(200) == 120 and statuses[-1] == 429
