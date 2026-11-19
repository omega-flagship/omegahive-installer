# Purpose: verify that Ask bookkeeping never becomes work for a mind.
"""An Ask thread's goal is bookkeeping: the asked question is the mind's first and only prompt.

Found in the 2026-11-11 Create end-to-end run: asking an awake Create · Code controller first sent it the session goal's
assignment note, a task titled "Ask thread" with no detail. The mind claimed it, found nothing to act on, and gave up,
so the request never reached the Code team. The note must never be sent for an Ask thread, awake mind or not.
"""
import json

from hive.tests.test_ask import ask, token_of, world  # noqa: F401
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)


def test_the_first_delivery_to_an_awake_mind_is_the_question_not_an_empty_goal(client):
    w = world(client)
    hive = w["hive"]
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (w["coord"]["id"],))
    with client.websocket_connect("/agent-hub", headers=agent_headers(w["coord"])) as mind:
        mind.send_text(json.dumps({"type": "resume", "last_seen_seq": None}))
        r = ask(client, w["ann"], "op-bookkeep-0001", text="make me a tip calculator",
                context={"swarm_id": w["swarm"]["id"]}).json()
        first = json.loads(json.loads(mind.receive_text())["text"])
        assert "ask" in first, f"the first delivery was not the Ask turn: {str(first)[:200]}"
        assert first["text"] == "make me a tip calculator" and first["ask"]["turn_id"] == r["turn_id"]
    session = hive.db.one("SELECT goal_id FROM work_sessions WHERE id = ?", (r["thread"]["id"],))
    goal = hive.goals.get(session["goal_id"])
    assert goal is not None and goal["status"] == "open"          # the bookkeeping goal exists, unclaimed
    assert goal["title"] == "make me a tip calculator" and goal["assignee"] is None
    assert all(g["id"] != goal["id"] for g in hive.goals.list(w["swarm"]["id"]))
    page = client.get("/api/tasks", headers=w["ann"], params={"swarm": w["swarm"]["id"]}).json()
    assert page["items"] == [] and page["counts"]["total"] == 0
    assert client.get("/api/boards/grand").json()["goals"] == []
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(w["coord"])).status_code == 409
    assert client.post(f"/api/agent/goals/{goal['id']}/result", headers=agent_headers(w["coord"]),
                       json={"status": "failed", "result": "nothing to do"}).status_code == 409
    assert client.post(f"/api/sessions/{r['thread']['id']}/end", headers=w["ann"]).status_code == 200
    assert hive.goals.get(goal["id"])["status"] == "done"
