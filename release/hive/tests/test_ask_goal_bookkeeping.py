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
    goal = hive.db.one("SELECT * FROM goals WHERE assignee = ? AND title = 'Ask thread' ORDER BY created_at DESC LIMIT 1",
                       (w["coord"]["id"],))
    assert goal is not None and goal["status"] == "open"          # the bookkeeping goal exists, unclaimed
