"""R15: DMs, groups and channels as rooms; minds hear only what is addressed to them; bounded mind-to-mind talk."""
import json

from hive.core.db import new_id, now
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def inbox(client, agent):
    return [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(agent)).json()["messages"]]


def test_dm_with_a_mind_round_trip(client):
    _, (a, _b) = make_swarm_and_agents(client)
    dm = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{a['id']}"]}).json()
    assert dm["kind"] == "dm" and {m["member"] for m in dm["members"]} == {"user:operator", f"agent:{a['id']}"}
    again = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{a['id']}"]}).json()
    assert again["id"] == dm["id"]                                        # one DM per pair
    sent = client.post(f"/api/rooms/{dm['id']}/messages", json={"text": "hello"}).json()
    assert sent["delivered_to"] == [f"agent:{a['id']}"]                   # in a DM the mind always hears
    got = inbox(client, a)
    assert got[-1]["text"] == "hello" and got[-1]["conversation_id"] == dm["id"] and got[-1]["room"]["kind"] == "dm"
    # the mind's ordinary reply carries the conversation and lands in the room
    client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hi Jon", "conversation_id": dm["id"]})
    msgs = client.get(f"/api/rooms/{dm['id']}/messages").json()
    assert [(m["sender"], m["text"]) for m in msgs] == [("user:operator", "hello"), (f"agent:{a['id']}", "hi Jon")]
    assert client.patch(f"/api/rooms/{dm['id']}", json={"name": "x"}).status_code == 400   # a DM is fixed


def test_group_minds_hear_only_mentions_with_a_short_digest(client):
    _, (a, b) = make_swarm_and_agents(client)
    g = client.post("/api/rooms", json={"kind": "group", "name": "Plan", "members": [f"agent:{a['id']}", f"agent:{b['id']}"]}).json()
    for i in range(3):
        assert client.post(f"/api/rooms/{g['id']}/messages", json={"text": f"thinking aloud {i}"}).json()["delivered_to"] == []
    assert inbox(client, a) == [] and inbox(client, b) == []              # nobody woken, nothing spent
    out = client.post(f"/api/rooms/{g['id']}/messages", json={"text": "@Dot1 what do you think?"}).json()
    assert out["delivered_to"] == [f"agent:{b['id']}"] and out["mentions"] == [f"agent:{b['id']}"]
    got = inbox(client, b)[-1]
    assert got["text"] == "@Dot1 what do you think?" and got["earlier"] == [f"You: thinking aloud {i}" for i in range(3)]
    assert inbox(client, a) == []
    # the digest covers only what the mind missed since it last heard
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": f"@{b['id']} and now?"})
    assert "earlier" not in inbox(client, b)[-1]
    # follow mode: every person's message reaches every mind
    client.patch(f"/api/rooms/{g['id']}", json={"settings": {"minds_follow": True}})
    assert sorted(client.post(f"/api/rooms/{g['id']}/messages", json={"text": "all hands"}).json()["delivered_to"]) == \
        sorted([f"agent:{a['id']}", f"agent:{b['id']}"])
    assert client.patch(f"/api/rooms/{g['id']}", json={"settings": {"turn_cap": 99}}).status_code == 400


def test_minds_talking_to_each_other_stop_at_the_turn_cap(client):
    _, (a, b) = make_swarm_and_agents(client)
    g = client.post("/api/rooms", json={"kind": "group", "name": "Duo", "members": [f"agent:{a['id']}", f"agent:{b['id']}"],
                                        "settings": {"turn_cap": 2}}).json()
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": "@Dot0 start"})
    one = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 your turn"}).json()
    two = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(b), json={"text": "@Dot0 back to you"}).json()
    three = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 again"}).json()
    assert one["delivered_to"] == [f"agent:{b['id']}"] and two["delivered_to"] == [f"agent:{a['id']}"]
    assert three["delivered_to"] == []                                     # third mind turn in a row: held
    msgs = client.get(f"/api/rooms/{g['id']}/messages").json()
    assert msgs[-1]["sender"] == "system:hive" and "waits for a person" in msgs[-1]["text"]
    # a person speaking resets the run
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": "carry on"})
    assert client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 ok"}).json()["delivered_to"] == [f"agent:{b['id']}"]
    # a mind outside the room cannot speak in it
    _, (c,) = make_swarm_and_agents(client, n=1)
    assert client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(c), json={"text": "hi"}).status_code == 404


def test_privacy_groups_for_members_channels_by_visibility(client):
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    _, (a,) = make_swarm_and_agents(client, n=1)
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (a["id"],))
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Ann only", "members": [f"agent:{a['id']}"]}).json()
    client.post(f"/api/rooms/{g['id']}/messages", headers=ann, json={"text": "@Dot0 secret plan"})
    assert g["id"] not in [r["id"] for r in client.get("/api/rooms", headers=bob).json()]
    assert client.get(f"/api/rooms/{g['id']}/messages", headers=bob).status_code == 404
    # bob can see the public mind, but not the room's words delivered to it
    assert all("secret" not in m["text"] for m in client.get(f"/api/agents/{a['id']}/messages", headers=bob).json())
    assert any("secret" in m["text"] for m in client.get(f"/api/agents/{a['id']}/messages").json())   # admins keep sight
    assert client.post(f"/api/rooms/{g['id']}/members", headers=bob, json={"members": ["user:u_bob"]}).status_code == 404
    # a public channel: listed, joinable, then speakable
    ch = client.post("/api/rooms", headers=ann, json={"kind": "channel", "name": "general", "visibility": "public"}).json()
    listed = {r["id"]: r for r in client.get("/api/rooms", headers=bob).json()}
    assert ch["id"] in listed and listed[ch["id"]]["joined"] is False
    assert client.post(f"/api/rooms/{ch['id']}/messages", headers=bob, json={"text": "hi"}).status_code == 403
    assert client.post(f"/api/rooms/{ch['id']}/members", headers=bob, json={"members": ["user:u_bob"]}).status_code == 200
    assert client.post(f"/api/rooms/{ch['id']}/messages", headers=bob, json={"text": "hi"}).status_code == 200
    # bob may join himself but not add others, and cannot change the room
    assert client.post(f"/api/rooms/{ch['id']}/members", headers=bob, json={"members": [f"agent:{a['id']}"]}).status_code == 403
    assert client.patch(f"/api/rooms/{ch['id']}", headers=bob, json={"name": "mine"}).status_code == 403
    unread = {r["id"]: r for r in client.get("/api/rooms", headers=ann).json()}[ch["id"]]["unread"]
    assert unread == 1


def test_classic_chat_is_a_dm_room_with_its_history(client):
    hive = client.app.state.hive
    _, (a, b) = make_swarm_and_agents(client)
    # history from before rooms existed
    for direction, sender, text in [("in", "user:operator", "old hello"), ("out", f"agent:{b['id']}", "old reply")]:
        hive.db.insert("messages", {"id": new_id("m"), "agent_id": b["id"], "conversation_id": f"c_{b['id']}", "direction": direction,
                                    "sender": sender, "text": text, "hub_seq": 1 if direction == "in" else None, "created_at": now()})
    hive.rooms._migrate_dms()
    hive.rooms._migrate_dms()                                             # once only
    dm = hive.rooms.legacy_dm(b["id"])
    assert [m["text"] for m in client.get(f"/api/rooms/{dm['id']}/messages").json()] == ["old hello", "old reply"]
    # the classic chat keeps working and stays in the same room
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "classic"})
    client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "classic reply"})
    room = hive.rooms.legacy_dm(a["id"])
    assert [m["text"] for m in client.get(f"/api/rooms/{room['id']}/messages").json()] == ["classic", "classic reply"]
    assert [r for r in client.get("/api/rooms").json() if r["kind"] == "dm" and r["id"] == room["id"]]


def test_room_events_reach_only_those_who_can_see(client):
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "g"}).json()
    from hive.core.visibility import Viewer
    event = json.dumps({"type": "room", "room_id": g["id"], "what": "message"})
    assert hive.visibility.event_visible(Viewer("user:u_ann", False), event)
    assert not hive.visibility.event_visible(Viewer("user:u_bob", False), event)
    assert not hive.visibility.event_visible(Viewer("user:u_bob", False), json.dumps({"message": {"conversation_id": g["id"]}}))


def test_a_mind_sees_the_room_who_spoke_and_what_it_missed():
    from modules.channel_hive.src.hive_channel import _room_text
    text = _room_text({"hive": 1, "text": "@Dot1 thoughts?", "sender": "user:operator", "sender_name": "You",
                       "room": {"id": "r_1", "kind": "group", "name": "Plan"}, "earlier": ["You: idea one", "Dot0: idea two"]})
    assert text == "Earlier in this room:\n- You: idea one\n- Dot0: idea two\n[Plan (group)] You: @Dot1 thoughts?"
    assert _room_text({"hive": 1, "text": "plain"}) == "plain"


def test_a_dm_becomes_a_group_and_a_group_becomes_a_channel_keeping_history(client):
    _, (a, _b) = make_swarm_and_agents(client)
    dm = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{a['id']}"]}).json()
    client.post(f"/api/rooms/{dm['id']}/messages", json={"text": "first"})
    assert client.patch(f"/api/rooms/{dm['id']}", json={"kind": "group"}).status_code == 400        # needs a name
    g = client.patch(f"/api/rooms/{dm['id']}", json={"kind": "group", "name": "Plan"}).json()
    assert g["kind"] == "group" and g["name"] == "Plan" and g["id"] == dm["id"]
    ch = client.patch(f"/api/rooms/{dm['id']}", json={"kind": "channel"}).json()
    assert ch["kind"] == "channel"
    assert [m["text"] for m in client.get(f"/api/rooms/{dm['id']}/messages").json()] == ["first"]
    assert client.patch(f"/api/rooms/{dm['id']}", json={"kind": "dm"}).status_code == 400


def test_a_channel_becomes_a_swarm_and_a_swarm_has_its_room(client):
    _, (a, b) = make_swarm_and_agents(client)
    ch = client.post("/api/rooms", json={"kind": "channel", "name": "Telescope time", "members": [f"agent:{a['id']}"]}).json()
    client.post(f"/api/rooms/{ch['id']}/messages", json={"text": "kept"})
    out = client.post(f"/api/rooms/{ch['id']}/swarm", json={"move_minds": [a["id"]]}).json()
    sw = out["swarm"]
    assert out["room"]["swarm_id"] == sw["id"] and sw["name"] == "Telescope time" and a["id"] in sw["member_ids"]
    assert client.post(f"/api/rooms/{ch['id']}/swarm", json={}).status_code == 409
    assert client.post(f"/api/rooms/{ch['id']}/swarm", json={"move_minds": [b["id"]]}).status_code == 409
    room = client.post(f"/api/swarms/{sw['id']}/room").json()
    assert room["id"] == ch["id"]                                              # the swarm's room is that channel
    other = client.post(f"/api/swarms/{b['swarm_id']}/room").json()
    assert other["swarm_id"] == b["swarm_id"] and f"agent:{b['id']}" in {m["member"] for m in other["members"]}
    detached = client.patch(f"/api/rooms/{ch['id']}", json={"swarm_id": None, "kind": "group"}).json()
    assert detached["swarm_id"] is None and detached["kind"] == "group"
    assert [m["text"] for m in client.get(f"/api/rooms/{ch['id']}/messages").json()] == ["kept"]
