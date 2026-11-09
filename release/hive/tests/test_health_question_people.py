"""Peter on omegahive#50: Health's question keeps its id tag where it is stored and where the mind reads it; people get
it untagged and marked health_check, made by the hive where answers and events leave for people (health.people_message,
in GET /api/agents/{id}/messages and the /api/events socket), and only for a VERIFIED Health question (sent by Health
with its health_question event). Anything else, a mind or a person quoting the tag included, is returned as written.
The client rewrites nothing (hive/ui/src/features/health/healthQuestionPlain.test.ts). Synthetic only."""
import asyncio
import json

from hive.core.health import HEALTH_QUESTION, HEALTH_QUESTION_TAG, HEALTH_SENDER, people_frame, people_message

QUESTION = "You've spent $0.03 over 1.5 hours with no input: sleep, or tell me what you're waiting for?"
TAGGED = f"{HEALTH_QUESTION_TAG}hq_709c522d] {QUESTION}"
QUOTE = f"I saw {HEALTH_QUESTION_TAG}hq_709c522d] in my notes."


def run(hive, coro):
    return asyncio.run_coroutine_threadsafe(coro, hive.events._loop).result(5)


def mind(client):
    sw = client.post("/api/swarms", json={"name": "t"}).json()
    return client.post("/api/agents", json={"name": "Wren", "swarm_id": sw["id"]}).json()


def ask(hive, agent_id, text=TAGGED, event=HEALTH_QUESTION):
    return run(hive, hive.send_to_agent(agent_id, text, sender=HEALTH_SENDER, extra={"event": event, "question_id": "hq_709c522d"}))


def listed(client, agent_id):
    return client.get(f"/api/agents/{agent_id}/messages").json()


def test_a_health_question_is_plain_and_marked_for_people_and_tagged_for_the_mind(client):
    hive = client.supervisor.hive
    a = mind(client)
    sent = ask(hive, a["id"])
    stored = hive.db.one("SELECT text FROM messages WHERE id = ?", (sent["id"],))
    assert stored["text"] == TAGGED                                               # the stored row: as the mind reads it
    raw = next(m for m in hive.messages(a["id"]) if m["id"] == sent["id"])         # the hive's own view (minds, exports)
    assert raw["text"] == TAGGED and raw["health_check"] is True
    shown = next(m for m in listed(client, a["id"]) if m["id"] == sent["id"])
    assert shown["text"] == QUESTION and shown["health_check"] is True             # people: plain, and marked


def test_text_that_quotes_the_tag_is_returned_exactly_as_written(client):
    hive = client.supervisor.hive
    a = mind(client)
    mine = client.post(f"/api/agents/{a['id']}/messages", json={"text": QUOTE}).json()          # a person quoting it
    alert = ask(hive, a["id"], text=TAGGED, event="health_alert")                                 # Health, not a question
    shown = {m["id"]: m for m in listed(client, a["id"])}
    assert shown[mine["id"]]["text"] == QUOTE and "health_check" not in shown[mine["id"]]
    assert shown[alert["id"]]["text"] == TAGGED and "health_check" not in shown[alert["id"]]
    # the people projection itself never trusts text: no mark, or not Health's, leaves it as it was
    assert people_message({"sender": "agent:a_x", "text": TAGGED, "health_check": True})["text"] == TAGGED
    assert people_message({"sender": HEALTH_SENDER, "text": TAGGED})["text"] == TAGGED


def test_the_people_socket_carries_the_same_plain_marked_message(client):
    hive = client.supervisor.hive
    a = mind(client)
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        assert ws.receive_json()["type"] == "hello"
        sent = ask(hive, a["id"])
        frame = None
        for _ in range(20):
            got = ws.receive_json()
            if got.get("type") == "message" and got["message"]["id"] == sent["id"]:
                frame = got
                break
        assert frame is not None
    shown = next(m for m in listed(client, a["id"]) if m["id"] == sent["id"])
    assert frame["message"]["text"] == shown["text"] == QUESTION
    assert frame["message"]["health_check"] is True
    assert "[HEALTH-QUESTION" not in json.dumps(frame)


def test_people_frame_changes_only_a_marked_health_message():
    marked = json.dumps({"type": "message", "at": "t", "message": {"id": "m", "sender": HEALTH_SENDER, "text": TAGGED,
                                                                     "health_check": True}})
    assert json.loads(people_frame(marked))["message"]["text"] == QUESTION
    compact = json.dumps(json.loads(marked), separators=(",", ":"))           # Kimi P3: parsed, never matched by spelling
    assert json.loads(people_frame(compact))["message"]["text"] == QUESTION
    for other in (json.dumps({"type": "message", "at": "t", "message": {"id": "m", "sender": "agent:a_x", "text": QUOTE}}),
                  json.dumps({"type": "trace", "at": "t", "text": TAGGED, "health_check": True}),
                  json.dumps({"type": "message", "at": "t", "message": {"id": "m", "sender": HEALTH_SENDER, "text": TAGGED}})):
        assert people_frame(other) == other                                       # byte for byte


def test_display_needs_the_structured_event_routing_keeps_its_fallback(client):
    """sol and Kimi on 7cf0ca57: display is decided by the stored event alone. A Health row with no extra (or an
    unreadable one) is not marked and keeps its words for people; routing (_health_question) still treats it as the
    question, failing closed about whose chat it belongs to."""
    hive = client.supervisor.hive
    a = mind(client)
    conv = f"c_{a['id']}"
    legacy = hive.enqueue_message(a["id"], TAGGED, conv, HEALTH_SENDER)                     # no extra at all
    broken = hive.enqueue_message(a["id"], TAGGED, conv, HEALTH_SENDER)
    hive.db.execute("UPDATE messages SET extra = ? WHERE id = ?", ("{not json", broken["id"]))
    for row in (legacy, broken):
        stored = hive.db.one("SELECT * FROM messages WHERE id = ?", (row["id"],))
        assert hive.verified_health_question(stored) is False and hive._health_question(stored) is True
        shown = next(m for m in listed(client, a["id"]) if m["id"] == row["id"])
        assert shown["text"] == TAGGED and "health_check" not in shown


def test_an_export_carries_canonical_rows_and_a_people_transcript(client):
    """sol and Kimi on 7cf0ca57: the migration bundle keeps the canonical tagged rows (import reads them) and adds the
    people's transcript (Health's verified question untagged, marked); the two contracts are named in the manifest."""
    import io
    import tarfile
    hive = client.supervisor.hive
    a = mind(client)
    sent = ask(hive, a["id"])
    bundle, _digest = hive.placement.export(a["id"])
    with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as tar:
        manifest = json.loads(tar.extractfile("manifest.json").read())
    canonical = next(m for m in manifest["messages"] if m["id"] == sent["id"])
    people = next(m for m in manifest["transcript"] if m["id"] == sent["id"])
    assert canonical["text"] == TAGGED
    assert people["text"] == QUESTION and people["health_check"] is True
    assert set(manifest["contracts"]) == {"messages", "transcript"}
    assert len(manifest["transcript"]) == len(manifest["messages"])


from hive.tests.test_core_api import client  # noqa: E402,F401  (fixture)
