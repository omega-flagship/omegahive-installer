"""Health's question reaches the mind with its id tag (the mind names the question it answers) and reaches people, in
the mind's DM room, as plain words: no "[HEALTH-QUESTION" and no "hq_" in the room copy. Synthetic only."""
from hive.core.health import HEALTH_QUESTION_TAG, HEALTH_SENDER, for_people


def test_for_people_drops_only_healths_own_tag():
    assert for_people(HEALTH_SENDER, f"{HEALTH_QUESTION_TAG}hq_709c522d] You've spent $0.03: sleep?") == "You've spent $0.03: sleep?"
    assert for_people("user:u_ann", f"{HEALTH_QUESTION_TAG}hq_1] not Health's") == f"{HEALTH_QUESTION_TAG}hq_1] not Health's"
    assert for_people(HEALTH_SENDER, "plain words") == "plain words"
    assert for_people(HEALTH_SENDER, f"{HEALTH_QUESTION_TAG}unterminated") == f"{HEALTH_QUESTION_TAG}unterminated"


def test_the_dm_room_copy_has_no_tag_while_the_mind_keeps_it(client):
    """sol and Kimi on 7cf0ca57: the copy is judged by the source message's EVENT, never its text. A verified question
    goes into the DM room untagged, from Health, marked health_check, with its source message's id; a Health alert
    that quotes the tag goes in exactly as sent, unmarked."""
    import asyncio
    from hive.core.health import HEALTH_QUESTION
    hive = client.supervisor.hive
    sw = client.post("/api/swarms", json={"name": "t"}).json()
    a = client.post("/api/agents", json={"name": "a", "swarm_id": sw["id"]}).json()
    text = f"{HEALTH_QUESTION_TAG}hq_709c522d] You've spent $0.03 over 1.5 hours with no input: sleep, or tell me?"
    send = lambda event: asyncio.run_coroutine_threadsafe(   # noqa: E731
        hive.send_to_agent(a["id"], text, sender=HEALTH_SENDER, extra={"event": event}), hive.events._loop).result(5)
    question, alert = send(HEALTH_QUESTION), send("health_alert")
    mind = {r["id"]: r["text"] for r in hive.db.all("SELECT id, text FROM messages WHERE agent_id = ? AND direction = 'in'", (a["id"],))}
    assert mind[question["id"]] == mind[alert["id"]] == text                    # the mind still gets the tag, both times
    rows = {r["source_message_id"]: r for r in hive.db.all("SELECT * FROM room_messages WHERE source_message_id IS NOT NULL")}
    q, al = rows[question["id"]], rows[alert["id"]]
    assert (q["sender"], q["health_check"], q["text"]) == (HEALTH_SENDER, 1, for_people(HEALTH_SENDER, text))
    assert "[HEALTH-QUESTION" not in q["text"] and "hq_" not in q["text"]
    assert (al["sender"], al["health_check"], al["text"]) == ("system:hive", 0, text)   # not a question: as sent
    room = hive.db.one("SELECT room_id FROM room_messages WHERE id = ?", (q["id"],))["room_id"]
    shown = {m["id"]: m for m in client.get(f"/api/rooms/{room}/messages").json()}
    assert shown[q["id"]]["health_check"] is True and shown[q["id"]]["name"] == "Health"
    assert "health_check" not in shown[al["id"]] and shown[al["id"]]["text"] == text


from hive.tests.test_core_api import client  # noqa: E402,F401  (fixture)
