"""Purpose: a note the hive sends a mind to instruct it stays whole in the mind's own log and inbox, while every view of
it that people read is marked mind_only, so their chat pages leave it out (a Lisbon tester's own mind showed "Assigned to
you: New goal ... Read it with hive-goal-get ..." in its chat as if it had said it). Invented names only.

- goals.announce's assignment reaches the mind's inbox word for word, and is marked on GET /api/agents/{id}/messages, on
  its live message frame and on its copy in the mind's DM room, whose unread count leaves it out.
- People's words are never marked: a person's message, the mind's reply, a scheduled wakeup, Health's verified question.
- DM room copies made before the mark arrived are marked once, by the same rule.
"""
import asyncio

from hive.core.health import HEALTH_QUESTION, HEALTH_QUESTION_TAG, HEALTH_SENDER
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def _send(hive, agent_id, text, sender, extra=None):
    return asyncio.run_coroutine_threadsafe(hive.send_to_agent(agent_id, text, sender=sender, extra=extra),
                                            hive.events._loop).result(5)


def _assigned(client):
    """A mind assigned a goal through the ordinary route, and the hive's assignment note to it."""
    swarm, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Ask thread", "assignee": a["name"]}).json()
    note = hive.db.one("SELECT * FROM messages WHERE agent_id = ? AND sender = 'hive:goals'", (a["id"],))
    assert note is not None and note["text"].startswith("Assigned to you: ") and goal["id"] in note["text"]
    return hive, a, goal, note


def test_the_mind_keeps_its_goal_note_word_for_word(client):
    hive, a, goal, note = _assigned(client)
    inbox = client.get("/api/agent/inbox", headers=agent_headers(a)).json()["messages"]
    assert any(goal["id"] in m["text"] and "Assigned to you" in m["text"] and "hive-goal-get" in m["text"] for m in inbox)
    assert all("mind_only" not in m["text"] for m in inbox), "the mind's envelope is as it was"


def test_every_view_people_read_marks_the_goal_note_mind_only(client):
    hive, a, goal, note = _assigned(client)
    shown = {m["id"]: m for m in client.get(f"/api/agents/{a['id']}/messages").json()}
    assert shown[note["id"]]["mind_only"] is True and shown[note["id"]]["text"] == note["text"]
    room = hive.rooms.legacy_dm(a["id"])
    copies = {m["source_message_id"]: m for m in client.get(f"/api/rooms/{room['id']}/messages").json()}
    assert copies[note["id"]]["mind_only"] is True and copies[note["id"]]["sender"] == "system:hive"


def test_the_live_frame_is_marked_and_the_room_counts_no_unread(client):
    swarm, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    room = hive.rooms.legacy_dm(a["id"])
    client.get(f"/api/rooms/{room['id']}/messages")                              # the operator has read the room
    frames, publish = [], hive.events.publish
    hive.events.publish = lambda kind, **data: (frames.append((kind, data)), publish(kind, **data))[1]
    try:
        _send(hive, a["id"], "Assigned to you: New goal g_x (priority 0.50): Ask thread. Read it with hive-goal-get g_x.",
              "hive:goals", {"event": "goal", "goal_id": "g_x"})
    finally:
        hive.events.publish = publish
    sent = [d["message"] for k, d in frames if k == "message"]
    assert len(sent) == 1 and sent[0]["mind_only"] is True
    listed = {r["id"]: r for r in client.get("/api/rooms").json()}
    assert listed[room["id"]]["unread"] == 0, "a note only the mind reads is not news to a person"
    _send(hive, a["id"], "[WAKE wk_1] summarise my day", "hive:schedule", {"event": "wake", "wakeup_id": "wk_1"})
    listed = {r["id"]: r for r in client.get("/api/rooms").json()}
    assert listed[room["id"]]["unread"] == 1, "a person's own scheduled words are"


def test_peoples_words_are_never_marked(client):
    swarm, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "hello there"})
    client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hello back"})
    _send(hive, a["id"], "[WAKE wk_2] water the plants", "hive:schedule", {"event": "wake", "wakeup_id": "wk_2"})
    _send(hive, a["id"], f"{HEALTH_QUESTION_TAG}hq_1] You've spent $0.03 with no input: sleep?", HEALTH_SENDER,
          {"event": HEALTH_QUESTION})
    _send(hive, a["id"], "[HEALTH-ALERT] Wren (a_w): stuck at hive-search, 3x.", HEALTH_SENDER, {"event": "health_alert"})
    shown = client.get(f"/api/agents/{a['id']}/messages").json()
    def mark(start):
        hits = [m for m in shown if m["text"].startswith(start)]
        assert len(hits) == 1, (start, [m["text"] for m in shown])
        return hits[0].get("mind_only", False)
    # Health's question reaches people untagged and marked health_check (health.people_message), never mind_only
    assert [mark(t) for t in ("hello there", "hello back", "[WAKE wk_2]", "You've spent $0.03", "[HEALTH-ALERT]")] \
        == [False, False, False, False, True]
    room = hive.rooms.legacy_dm(a["id"])
    copies = client.get(f"/api/rooms/{room['id']}/messages").json()
    assert [m["text"][:14] for m in copies if m.get("mind_only")] == ["[HEALTH-ALERT]"]


def test_copies_made_before_the_mark_are_marked_once_by_the_same_rule(client):
    hive, a, goal, note = _assigned(client)
    _send(hive, a["id"], "[WAKE wk_3] call Mum", "hive:schedule", {"event": "wake", "wakeup_id": "wk_3"})
    hive.db.execute("UPDATE room_messages SET mind_only = 0")                    # as every copy was before this change
    hive.rooms._mark_mind_only_copies()
    rows = hive.db.all("SELECT r.mind_only, m.sender FROM room_messages r JOIN messages m ON m.id = r.source_message_id")
    assert {(r["sender"], r["mind_only"]) for r in rows} == {("hive:goals", 1), ("hive:schedule", 0)}
