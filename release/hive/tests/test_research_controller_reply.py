# Purpose: tests that whoever writes to the Research controller gets the hive's answer of where research starts, in the
# same conversation, and that the controller is never woken by it or handed the message.
"""The Research controller answers people with where research starts (tester report 11-13).

A tester asked her Research controller to research governance for an AI-native blockchain. It answered with a model
turn that it lacked the hive-request skill and asked her to get "an administrator" to enable it. She owns the hive,
no rule can give the coordinator a skill (policy denies it every one, a host rule), and research starts from Ask.

Invented lives: Jon owns the hive and its Research swarm.
"""
from hive.core import research as rmod
from hive.core.foundation import RESEARCH
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def _research(client):
    hive = client.app.state.hive
    jon = person(client, "u_jon", "admin")    # the first admin owns the foundation swarms once ensure() runs
    hive.foundation.ensure()
    binding = hive.foundation._binding(RESEARCH)
    coord = hive.db.one("SELECT * FROM agents WHERE id = ?", (binding["agent_id"],))
    return hive, jon, coord, binding["swarm_id"]


def _messages(hive, agent_id):
    return hive.db.all("SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at, hub_seq", (agent_id,))


def test_a_person_writing_to_the_research_controller_is_told_where_research_starts_and_it_never_wakes(client):
    hive, jon, coord, _ = _research(client)
    status = coord["status"]
    asked = "Please research governance for an AI-native blockchain"
    assert client.post(f"/api/agents/{coord['id']}/messages", headers=jon, json={"text": asked}).status_code == 200
    rows = _messages(hive, coord["id"])
    [said] = [r for r in rows if r["direction"] == "in"]
    answers = [r for r in rows if r["direction"] == "out"]
    assert said["text"] == asked and said["sender"] == "user:u_jon"                  # the person's words are kept
    assert len(answers) == 1, "the hive answered nothing for the Research controller"
    answer = answers[0]
    assert answer["text"] == rmod.COORDINATOR_REPLY and answer["conversation_id"] == said["conversation_id"]
    assert "Ask on the home page" in answer["text"] and "administrator" not in answer["text"]
    # the controller never reads it: not now, and not on a later connection's replay, nor is it woken for it
    assert hive._never_delivered(coord["id"], said)
    assert hive.db.one("SELECT status FROM agents WHERE id = ?", (coord["id"],))["status"] == status
    assert ("start", coord["id"]) not in client.supervisor.calls
    # the person reads both in their own chat with it
    shown = [m["text"] for m in client.get(f"/api/agents/{coord['id']}/messages", headers=jon).json()]
    assert asked in shown and rmod.COORDINATOR_REPLY in shown


def test_a_mention_in_the_research_room_gets_the_same_answer_in_the_room(client):
    hive, jon, coord, swarm_id = _research(client)
    room = hive.rooms.sync_team(swarm_id)    # Jon became the swarm's owner after the room was made: seat him, as a sync does
    out = client.post(f"/api/rooms/{room['id']}/messages", headers=jon,
                      json={"text": "@ResearchController look into governance for an AI-native blockchain"})
    assert out.status_code == 200, out.text
    texts = [(m["sender"], m["text"]) for m in hive.db.all("SELECT sender, text FROM room_messages WHERE room_id = ? ORDER BY seq",
                                                           (room["id"],))]
    answers = [t for sender, t in texts if sender == f"agent:{coord['id']}"]
    assert len(answers) == 1 and "Ask on the home page" in answers[0], texts
    assert answers == [rmod.COORDINATOR_REPLY]
    assert ("start", coord["id"]) not in client.supervisor.calls


def test_the_hives_own_notes_to_it_are_kept_unanswered_and_never_wake_it(client):
    hive, _, coord, _ = _research(client)
    client.portal.call(hive.send_to_agent, coord["id"], "[FILE-ADDED abc] a note", None, "hive:files")
    rows = _messages(hive, coord["id"])
    assert [r["direction"] for r in rows] == ["in"] and hive._never_delivered(coord["id"], rows[0])
    assert ("start", coord["id"]) not in client.supervisor.calls
