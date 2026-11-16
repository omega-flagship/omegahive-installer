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


def test_a_minds_reply_keeps_its_message_id_in_its_room_which_opens_by_its_conversation_alias(client):
    _, (a, _b) = make_swarm_and_agents(client)
    dm = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{a['id']}"]}).json()
    reply = client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hi", "conversation_id": dm["id"]}).json()
    copy = client.get(f"/api/rooms/{dm['id']}/messages").json()[-1]
    assert copy["text"] == "hi" and copy["id"] != reply["id"] and copy["source_message_id"] == reply["id"]
    # the mind's classic chat (conversation c_<mind>) is this DM: the room opens by that id and names it as its alias
    again = client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "and again"}).json()
    assert again["conversation_id"] == f"c_{a['id']}"
    room = client.get(f"/api/rooms/c_{a['id']}").json()
    assert room["id"] == dm["id"] and room["alias"] == f"c_{a['id']}"
    assert client.get(f"/api/rooms/c_{a['id']}/messages").json()[-1]["source_message_id"] == again["id"]
    # a person's message has no source; a room with no alias names none
    assert client.post(f"/api/rooms/{dm['id']}/messages", json={"text": "thanks"}).json()["source_message_id"] is None
    g = client.post("/api/rooms", json={"kind": "group", "name": "Plain", "members": []}).json()
    assert "alias" not in client.get(f"/api/rooms/{g['id']}").json()
    # the other way round: a room message delivered to a mind lands in its messages naming that room message
    asked = client.post("/api/rooms", json={"kind": "group", "name": "Asked", "members": [f"agent:{a['id']}"]}).json()
    question = client.post(f"/api/rooms/{asked['id']}/messages", json={"text": "@Dot0 a question"}).json()
    delivered = [m for m in client.get(f"/api/agents/{a['id']}/messages").json() if m["conversation_id"] == asked["id"]]
    assert delivered[-1]["direction"] == "in" and delivered[-1]["source_message_id"] == question["id"]


def test_a_minds_chat_by_its_conversation_name_is_not_found_to_a_person_who_cannot_see_the_mind(client):
    """An activity line links a mind's chat by its conversation, c_<mind>. Someone who cannot see that mind gets "not
    found" for it, by the room and by its messages, exactly as for a mind that does not exist."""
    from hive.core.visibility import Viewer
    hive = client.app.state.hive
    _, (a, _b) = make_swarm_and_agents(client)
    client.post("/api/agent/messages", headers=agent_headers(a), json={"text": "hello"})   # its classic chat, c_<mind>
    assert client.get(f"/api/rooms/c_{a['id']}").status_code == 200
    bob = person(client, "u_bob")
    assert hive.visibility.agents(Viewer("user:u_bob", False), [hive.agent(a["id"])]) == []
    for link in (f"/api/rooms/c_{a['id']}", "/api/rooms/c_a_nosuchmind"):
        assert client.get(link, headers=bob).status_code == 404
        assert client.get(f"{link}/messages", headers=bob).status_code == 404


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
    assert msgs[-1]["sender"] == "system:hive" and "waiting for you" in msgs[-1]["text"]
    # a person's plain reply after the stop reaches the mind the limit held back, so the minds go on, and resets the run
    carry = client.post(f"/api/rooms/{g['id']}/messages", json={"text": "carry on"}).json()
    assert carry["delivered_to"] == [f"agent:{b['id']}"] and inbox(client, b)[-1]["text"] == "carry on"
    assert client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 ok"}).json()["delivered_to"] == [f"agent:{b['id']}"]
    # only the first reply after a stop goes to the minds held back; after it, plain words wake nobody again
    assert client.post(f"/api/rooms/{g['id']}/messages", json={"text": "thinking aloud"}).json()["delivered_to"] == []
    # a mind outside the room cannot speak in it
    _, (c,) = make_swarm_and_agents(client, n=1)
    assert client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(c), json={"text": "hi"}).status_code == 404


def test_only_a_stop_holds_minds_back_and_raising_the_cap_keeps_them_held(client, monkeypatch):
    hive = client.app.state.hive
    _, (a, b) = make_swarm_and_agents(client)
    g = client.post("/api/rooms", json={"kind": "group", "name": "Duo", "members": [f"agent:{a['id']}", f"agent:{b['id']}"],
                                        "settings": {"turn_cap": 2}}).json()
    send = hive.send_to_agent

    async def refuse_b(agent_id, *args, **kwargs):
        if agent_id == b["id"]:
            raise RuntimeError("cannot receive now")
        return await send(agent_id, *args, **kwargs)

    monkeypatch.setattr(hive, "send_to_agent", refuse_b)
    failed = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 look"}).json()
    monkeypatch.setattr(hive, "send_to_agent", send)
    assert failed["delivered_to"] == [] and failed["mind_run"] == 1
    # a delivery that failed is no stop, so a person's plain words do not send it again
    assert client.post(f"/api/rooms/{g['id']}/messages", json={"text": "thinking aloud"}).json()["delivered_to"] == []
    for agent, text in ((a, "@Dot1 one"), (b, "@Dot0 two"), (a, "@Dot1 three")):
        last = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(agent), json={"text": text}).json()
    assert last["delivered_to"] == [] and last["mind_run"] == 3          # stopped
    # the limit raised after the stop: the mind it held back still waits, and a plain reply reaches it
    assert client.patch(f"/api/rooms/{g['id']}", json={"settings": {"turn_cap": 8}}).status_code == 200
    carry = client.post(f"/api/rooms/{g['id']}/messages", json={"text": "carry on"}).json()
    assert carry["delivered_to"] == [f"agent:{b['id']}"] and carry["mind_run"] == 0


def poster(client, room_id):
    def post(agent, text):
        return client.post(f"/api/agent/rooms/{room_id}/messages", headers=agent_headers(agent), json={"text": text}).json()
    return post


def swarm_room_with_cap(client, minds, cap=3):
    """A group of these minds that chose a turn cap, made a swarm's room with the minds moved into that swarm: a room
    where its swarm's coordinator carries held minds on. A room has no turn cap unless it chooses one (omega-flagship
    #75: hourly limits per mind and per swarm bound minds instead), and a swarm's own team room takes no settings, so
    it has none. Returns (room, swarm)."""
    g = client.post("/api/rooms", json={"kind": "group", "name": "Crew", "members": [f"agent:{m['id']}" for m in minds],
                                        "settings": {"turn_cap": cap}}).json()
    out = client.post(f"/api/rooms/{g['id']}/swarm", json={"move_minds": [m["id"] for m in minds]}).json()
    return out["room"], out["swarm"]


def test_the_rooms_own_coordinator_carries_held_minds_on_once_since_a_person_spoke(client):
    _, (a, b, c) = make_swarm_and_agents(client, n=3)
    room, s = swarm_room_with_cap(client, (a, b, c))               # the swarm's own room: its minds, a limit of 3
    assert client.patch(f"/api/swarms/{s['id']}", json={"coordinator_id": c["id"]}).status_code == 200   # the Ask answers through c
    post = poster(client, room["id"])
    client.post(f"/api/rooms/{room['id']}/messages", json={"text": "@Dot0 start"})
    assert post(c, "@Dot0 go ahead")["mind_run"] == 1             # nothing held: the coordinator counts like any mind
    post(a, "@Dot1 your turn")
    post(b, "@Dot0 back to you")
    assert post(a, "@Dot1 again")["delivered_to"] == []            # fourth in a row: held
    assert post(b, "@Dot0 still here")["delivered_to"] == []       # a mind that coordinates nothing is stopped too
    carry = post(c, "carry on, both of you")
    assert carry["mind_run"] == 0 and carry["delivered_to"] == [f"agent:{b['id']}", f"agent:{a['id']}"]
    assert inbox(client, a)[-1]["text"] == inbox(client, b)[-1]["text"] == "carry on, both of you"
    post(a, "@Dot1 ok")                                            # a new run, until the limit stops it again
    post(b, "@Dot0 ok")
    post(a, "@Dot1 ok")
    assert post(b, "@Dot0 more")["delivered_to"] == []
    # a second carry-on with no person speaking in between is refused: the coordinator counts like any mind again
    again = post(c, "carry on again")
    assert again["mind_run"] == 5 and again["delivered_to"] == []
    # a person's plain word still lets the held mind go on
    assert client.post(f"/api/rooms/{room['id']}/messages", json={"text": "go on"}).json()["delivered_to"] == [f"agent:{a['id']}"]


def test_a_coordinator_never_lifts_a_stop_it_is_caught_in_nor_carries_on_outside_its_swarms_room(client):
    _, (a, c) = make_swarm_and_agents(client, n=2)
    room, s = swarm_room_with_cap(client, (a, c))
    assert client.patch(f"/api/swarms/{s['id']}", json={"coordinator_id": c["id"]}).status_code == 200
    post = poster(client, room["id"])
    client.post(f"/api/rooms/{room['id']}/messages", json={"text": "@Dot1 start"})
    post(c, "@Dot0 one")
    post(a, "@Dot1 two")
    post(c, "@Dot0 three")
    assert post(a, "@Dot1 four")["delivered_to"] == []             # only the coordinator is held
    for _ in range(5):                                             # its own replies never lift the stop it is in
        reply = post(c, "@Dot0 and again")
        assert reply["delivered_to"] == [] and reply["mind_run"] > 3
    # in a group that is not its swarm's room, a coordinator carries nobody on
    g = client.post("/api/rooms", json={"kind": "group", "name": "Pair", "members": [f"agent:{a['id']}", f"agent:{c['id']}"],
                                        "settings": {"turn_cap": 1}}).json()
    gpost = poster(client, g["id"])
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": "@Dot0 hi"})
    gpost(a, "@Dot1 one")
    assert gpost(a, "@Dot1 two")["delivered_to"] == []             # c held
    assert gpost(c, "carry on")["delivered_to"] == []
    assert client.post(f"/api/rooms/{g['id']}/messages", json={"text": "go on"}).json()["delivered_to"] == [f"agent:{c['id']}"]


def test_a_members_own_mind_carries_held_minds_on_once(client):
    _, (a, b, p) = make_swarm_and_agents(client, n=3)
    client.app.state.hive.db.update("agents", p["id"], {"personal_of": "user:operator"})   # the operator's own mind: their Ask
    g = client.post("/api/rooms", json={"kind": "group", "name": "Mine", "members": [f"agent:{m['id']}" for m in (a, b, p)],
                                        "settings": {"turn_cap": 1}}).json()
    post = poster(client, g["id"])
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": "@Dot0 start"})
    post(a, "@Dot1 one")
    assert post(b, "@Dot0 two")["delivered_to"] == []              # a held
    carry = post(p, "carry on")
    assert carry["mind_run"] == 0 and carry["delivered_to"] == [f"agent:{a['id']}"]
    post(a, "@Dot1 three")
    assert post(b, "@Dot0 four")["delivered_to"] == []             # a held again
    assert post(p, "carry on")["delivered_to"] == []               # once since a person spoke


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
