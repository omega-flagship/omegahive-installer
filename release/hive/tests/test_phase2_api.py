"""Phase 2 server features: policy, approvals, goals, traces, wakeups, memory, inbox."""

import asyncio
import datetime
import json

import pytest

from hive.core.schedule import CronError, next_run, parse_cron
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

UTC = datetime.timezone.utc


def authorize(client, agent, command):
    return client.post("/api/agent/authorize", headers=agent_headers(agent), json={"command": command}).json()


def test_default_policy_and_human_only(client):
    _, (a, _) = make_swarm_and_agents(client)
    assert authorize(client, a, '(send "hi")')["decision"] == "allow"
    assert authorize(client, a, '(hive-publish "(--> a b)" 0.9 0.8)')["decision"] == "allow"
    pending = authorize(client, a, '(shell-confirm "rm -rf /tmp/x")')
    assert pending["decision"] == "pending" and pending["approval_id"].startswith("p_")
    assert authorize(client, a, '(transfer-funds "acct" 100)')["decision"] == "deny"
    assert authorize(client, a, "not a command")["decision"] == "deny"
    # a hive-wide allow rule cannot open a human-only action
    client.post("/api/policy", json={"scope": "hive", "skill": "*", "mode": "allow"})
    assert authorize(client, a, '(transfer-funds "acct" 100)')["decision"] == "deny"


def test_ask_approve_allows_exactly_once(client):
    _, (a, _) = make_swarm_and_agents(client)
    command = '(shell-confirm "ls /")'
    first = authorize(client, a, command)
    again = authorize(client, a, command)
    assert first["decision"] == again["decision"] == "pending" and first["approval_id"] == again["approval_id"]
    approval = client.post(f"/api/approvals/{first['approval_id']}/approve").json()
    assert approval["status"] == "approved"
    notes = [m["text"] for m in client.get(f"/api/agents/{a['id']}/messages").json()]
    assert any(n.startswith(f"[APPROVED {first['approval_id']}]") for n in notes)
    assert authorize(client, a, command)["decision"] == "allow"
    assert authorize(client, a, command)["decision"] == "pending"  # used up: asks again
    assert client.get("/api/approvals", params={"status": "used"}).json()[0]["id"] == first["approval_id"]
    assert client.post(f"/api/approvals/{first['approval_id']}/deny").status_code == 409


def test_rule_specificity_and_remember(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": "hive", "skill": "shell*", "mode": "deny"})
    client.post("/api/policy", json={"scope": f"swarm:{swarm['id']}", "skill": "shell", "mode": "allow"})
    assert authorize(client, a, '(shell "ls")')["decision"] == "allow"            # swarm beats hive
    assert authorize(client, a, '(shell-confirm "ls")')["decision"] == "deny"     # only the hive glob matches
    pending = authorize(client, b, '(write-file "x.txt" "y")')
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={"remember": True})
    authorize(client, b, '(write-file "x.txt" "y")')                             # uses the one-shot grant
    assert authorize(client, b, '(write-file "other.txt" "z")')["decision"] == "allow"   # remembered rule
    assert authorize(client, a, '(write-file "other.txt" "z")')["decision"] == "pending"  # only for b
    rules = client.get("/api/policy").json()
    assert any(r["scope"] == f"agent:{b['id']}" and r["skill"] == "write-file" for r in rules)
    assert client.post("/api/policy", json={"scope": "planet", "skill": "x", "mode": "allow"}).status_code == 400


def test_goals_are_announced_claimed_and_finished(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    for agent in (a, b):
        hive.db.update("agents", agent["id"], {"status": "awake"})
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Map the sky", "priority": 0.8}).json()
    assert goal["status"] == "open"
    inbox = client.get("/api/agent/inbox", headers=agent_headers(a)).json()["messages"]
    envelope = json.loads(inbox[-1]["text"])
    assert envelope["event"] == "goal" and envelope["goal_id"] == goal["id"]
    claimed = client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a)).json()
    assert claimed["status"] == "claimed" and claimed["claimed_by"] == a["id"]
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(b)).status_code == 409
    sub = client.post("/api/agent/goals", headers=agent_headers(a),
                      json={"title": "Survey the north", "parent_id": goal["id"]}).json()
    assert sub["parent_id"] == goal["id"] and sub["created_by"] == f"agent:{a['id']}"
    assert client.post(f"/api/agent/goals/{goal['id']}/result", headers=agent_headers(b),
                       json={"status": "done", "result": "x"}).status_code == 403
    done = client.post(f"/api/agent/goals/{goal['id']}/result", headers=agent_headers(a),
                       json={"status": "done", "result": "mapped"}).json()
    assert done["status"] == "done" and done["result"] == "mapped"
    assert [g["id"] for g in client.get(f"/api/agent/goals", headers=agent_headers(b)).json()] == [sub["id"]]


def test_traces_carry_gate_decisions(client):
    _, (a, _) = make_swarm_and_agents(client)
    authorize(client, a, '(shell-confirm "ls")')
    client.post("/llm/v1/chat/completions", headers=agent_headers(a), json={"messages": [{"role": "user", "content": "x"}]})
    trace = client.post("/api/agent/trace", headers=agent_headers(a), json={
        "iteration": 7, "input": "do it", "response": "shell-confirm ls",
        "commands": [{"command": '(shell-confirm "ls")', "result": "HIVE-APPROVAL-PENDING"}]}).json()
    assert trace["commands"][0]["gated"] == "ask" and trace["llm_ms"] is not None and trace["tokens"] > 0
    assert client.get(f"/api/agents/{a['id']}/traces").json()[0]["iteration"] == 7


def test_cron_parsing_and_next_run():
    assert parse_cron("*/15 9-17 * * mon-fri")["minute"] == {0, 15, 30, 45}
    start = datetime.datetime(2026, 10, 3, 8, 59, tzinfo=UTC)  # a Saturday
    assert next_run("0 9 * * 1-5", start) == datetime.datetime(2026, 10, 5, 9, 0, tzinfo=UTC)
    assert next_run("30 6 * * *", start, "Europe/London") == datetime.datetime(2026, 10, 4, 5, 30, tzinfo=UTC)
    with pytest.raises(CronError):
        parse_cron("61 * * * *")


def test_wakeups_fire_and_reschedule(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    w = client.post(f"/api/agents/{a['id']}/wakeups", json={"cron": "*/5 * * * *", "text": "check the sky"}).json()
    assert w["enabled"] and w["next_run_at"]
    assert client.post(f"/api/agents/{a['id']}/wakeups", json={"text": "x"}).status_code == 400
    assert client.post(f"/api/agents/{a['id']}/wakeups", json={"cron": "* * *", "text": "x"}).status_code == 400
    due = datetime.datetime.fromisoformat(w["next_run_at"].replace("Z", "+00:00"))
    fired = asyncio.run(hive.scheduler.tick(at=due))
    assert fired == [w["id"]]
    text = client.get(f"/api/agents/{a['id']}/messages").json()[-1]["text"]
    assert text == f"[WAKE {w['id']}] check the sky"
    after = client.get(f"/api/agents/{a['id']}/wakeups").json()[0]
    assert after["next_run_at"] > w["next_run_at"]
    once = client.post(f"/api/agents/{a['id']}/wakeups",
                       json={"at": "2099-01-01T00:00:00Z", "text": "far future"}).json()
    assert once["cron"] is None and once["next_run_at"].startswith("2099")
    assert client.patch(f"/api/wakeups/{once['id']}", json={"enabled": False}).json()["enabled"] is False


def test_memory_inspection_and_control_queue(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    memory = hive.settings.agents_dir / a["id"] / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    (memory / "persistent.metta").write_text('(Note "one (with) parens")\n(Fact sky blue)\n')
    (memory / "history.metta").write_text("(skip me)")
    spaces = client.get(f"/api/agents/{a['id']}/memory").json()
    assert [(s["name"], s["atoms"]) for s in spaces] == [("persistent", 2)]
    atoms = client.get(f"/api/agents/{a['id']}/memory/persistent", params={"q": "sky"}).json()
    assert atoms == [{"index": 1, "text": "(Fact sky blue)"}]
    assert client.post(f"/api/agents/{a['id']}/memory/persistent/retire", json={"atom": "(Nope)"}).status_code == 404
    client.post(f"/api/agents/{a['id']}/memory/persistent/retire", json={"atom": "(Fact sky blue)"})
    client.post(f"/api/agents/{a['id']}/memory/reset")
    ops = client.get("/api/agent/control", headers=agent_headers(a)).json()["ops"]
    assert ops == [{"op": "retire", "space": "persistent", "atom": "(Fact sky blue)"}, {"op": "reset"}]
    assert client.get("/api/agent/control", headers=agent_headers(a)).json()["ops"] == []
    assert client.get(f"/api/agents/{a['id']}/memory/..%2Fsecret").status_code in (400, 404)


def test_http_inbox_and_replies(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "one"})
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "two"})
    inbox = client.get("/api/agent/inbox", headers=agent_headers(a)).json()["messages"]
    assert [json.loads(m["text"])["text"] for m in inbox] == ["one", "two"]
    later = client.get("/api/agent/inbox", params={"after": inbox[0]["seq"]}, headers=agent_headers(a)).json()
    assert [m["seq"] for m in later["messages"]] == [inbox[1]["seq"]]
    reply = client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hi", "client_seq": "c1"}).json()
    again = client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hi", "client_seq": "c1"}).json()
    assert reply["id"] == again["id"] and reply["direction"] == "out"


def test_idle_sleep_and_stop_all(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    client.patch(f"/api/agents/{a['id']}", json={"idle_sleep_minutes": 10})
    old = (datetime.datetime.now(UTC) - datetime.timedelta(minutes=30)).isoformat()
    for agent in (a, b):
        hive.db.update("agents", agent["id"], {"status": "awake", "last_active_at": old})
    assert hive.idle_candidates() == [a["id"]]
    assert client.get(f"/api/agents/{a['id']}").json()["idle_sleep_minutes"] == 10
    assert client.post("/api/hive/stop-all").json() == {"stopped": 2}
    assert {x["status"] for x in client.get("/api/agents").json()} == {"stopped"}


def test_only_the_claimer_can_split_a_goal(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Big job"}).json()
    client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a))
    refused = client.post("/api/agent/goals", headers=agent_headers(b), json={"title": "part", "parent_id": goal["id"]})
    assert refused.status_code == 403
    assert client.post("/api/agent/goals", headers=agent_headers(a), json={"title": "part", "parent_id": goal["id"]}).status_code == 200


def test_external_member_uses_the_agent_api_and_is_never_started(client):
    swarm, _ = make_swarm_and_agents(client, n=1)
    ext = client.post("/api/agents", json={"name": "Codex", "kind": "module", "swarm_id": swarm["id"]}).json()
    assert client.post(f"/api/agents/{ext['id']}/start").json()["error"]["code"] == "external_member"
    client.post(f"/api/agents/{ext['id']}/messages", json={"text": "please check claim 1"})
    inbox = client.get("/api/agent/inbox", headers=agent_headers(ext)).json()["messages"]
    assert json.loads(inbox[0]["text"])["text"] == "please check claim 1"
    client.post("/api/agent/messages", headers=agent_headers(ext), json={"text": "on it"})
    published = client.post("/api/agent/publish", headers=agent_headers(ext),
                            json={"statement": "(--> claim-1 unverified)", "f": 0.5, "c": 0.3}).json()
    assert published["outcome"] == "adopted"
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "trace source of claim 1"}).json()
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(ext)).json()["claimed_by"] == ext["id"]


def test_a_stopped_assignee_still_learns_of_its_goal(client):
    swarm, (a, _) = make_swarm_and_agents(client)
    client.app.state.hive.db.update("agents", a["id"], {"status": "stopped", "kind": "omega"})
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "while asleep", "assignee": a["name"]}).json()
    texts = [m["text"] for m in client.get("/api/agent/inbox", headers=agent_headers(a)).json()["messages"]]
    assert any(goal["id"] in t and "Assigned to you" in t for t in texts)
