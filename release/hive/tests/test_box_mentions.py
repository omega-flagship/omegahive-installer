"""Minds reach each other through their DM: @Name of another mind in a mind's own message box lands in the DM between the
two (made on first use) and is delivered to the named mind; its reply in that DM reaches the first one. Bounded by
throughput per mind and per swarm, refused (never queued) when over (rooms.relay_box, throughput.py)."""
import json
import time

from hive.core import throughput
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def inbox(client, agent):
    return [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(agent)).json()["messages"]]


def reply(client, agent, text, conversation_id=None):
    client.post("/api/agent/messages", headers=agent_headers(agent),
                json={"text": text, "conversation_id": conversation_id or f"c_{agent['id']}"})
    time.sleep(0.05)   # the delivery runs as a task on the app's loop


def from_minds(client, agent):
    return [m for m in inbox(client, agent) if m["sender"].startswith("agent:")]


def notices(client, agent):
    return [m for m in inbox(client, agent) if m["sender"] == throughput.SENDER]


def dm_of(client, a, b):
    return client.app.state.hive.rooms.mind_dm(a["id"], b["id"])


def test_an_at_mention_in_a_minds_box_opens_their_dm_and_the_reply_comes_back(client):
    _, (a, b) = make_swarm_and_agents(client)
    reply(client, a, "@Dot1 can you check the sources?")
    dm = dm_of(client, a, b)
    got = from_minds(client, b)
    assert [(m["sender"], m["text"], m["conversation_id"]) for m in got] == \
        [(f"agent:{a['id']}", "@Dot1 can you check the sources?", dm["id"])]
    assert got[0]["sender_name"] == "Dot0" and got[0]["room"]["kind"] == "dm"
    reply(client, b, "checked, two are solid", conversation_id=dm["id"])      # an ordinary reply in the DM: no @ needed
    back = from_minds(client, a)
    assert [(m["sender"], m["text"], m["conversation_id"]) for m in back] == [(f"agent:{b['id']}", "checked, two are solid", dm["id"])]
    # on record: who sent what to whom, and when, in the DM the operator can open
    msgs = client.get(f"/api/rooms/{dm['id']}/messages").json()
    assert [(m["sender"], m["text"]) for m in msgs] == [(f"agent:{a['id']}", "@Dot1 can you check the sources?"),
                                                       (f"agent:{b['id']}", "checked, two are solid")]
    assert all(m["created_at"] for m in msgs)
    assert dm["id"] in [r["id"] for r in client.get("/api/rooms").json()]
    reply(client, a, "thanks, noted")                                     # no @mention in its box: nobody else hears it
    assert len(from_minds(client, b)) == 1


def test_minds_of_other_swarms_are_reachable_too(client):
    _, (a,) = make_swarm_and_agents(client, n=1)
    _, (c,) = make_swarm_and_agents(client, n=1)
    client.patch(f"/api/agents/{c['id']}", json={"name": "Other"})
    reply(client, a, "@Other hello")
    assert [m["text"] for m in from_minds(client, c)] == ["@Other hello"]


def test_no_turn_cap_by_default_but_the_mind_limit_refuses_and_tells_the_sender(client):
    _, (a, b) = make_swarm_and_agents(client)
    client.patch(f"/api/agents/{a['id']}", json={"messages_per_hour": 3})
    assert client.get(f"/api/agents/{a['id']}").json()["throughput"] == \
        {"messages_per_hour": 3, "messages_per_hour_effective": 3, "messages_last_hour": 0}
    reply(client, a, "@Dot1 one")
    dm = dm_of(client, a, b)
    for i in range(5):                                                    # well past the old turn cap of 3
        reply(client, b, f"answer {i}", conversation_id=dm["id"])
    assert len(from_minds(client, a)) == 5                                # b is under its default 20
    reply(client, a, "two", conversation_id=dm["id"])
    reply(client, a, "three", conversation_id=dm["id"])
    reply(client, a, "four", conversation_id=dm["id"])                    # a's fourth this hour: refused now
    reply(client, a, "five", conversation_id=dm["id"])
    assert [m["text"] for m in from_minds(client, b)] == ["@Dot1 one", "two", "three"]
    told = notices(client, a)
    assert len(told) == 1 and "sent its 3 messages to minds this hour" in told[0]["text"] and "Try again in" in told[0]["text"]
    msgs = client.get(f"/api/rooms/{dm['id']}/messages").json()
    assert [m["text"] for m in msgs if m["sender"] == "system:hive"][0].startswith("Not delivered to Dot1")
    assert client.get(f"/api/agents/{a['id']}").json()["throughput"]["messages_last_hour"] == 3


def test_the_swarm_limit_and_the_priority_of_minds_that_sent_less(client):
    hive = client.app.state.hive
    sw, (a, b, c) = make_swarm_and_agents(client, n=3)
    client.patch(f"/api/swarms/{sw['id']}", json={"messages_per_hour": 10})
    client.patch(f"/api/agents/{a['id']}", json={"messages_per_hour": 10})
    assert client.get(f"/api/swarms/{sw['id']}").json()["throughput"]["messages_per_hour_effective"] == 10
    target = [f"agent:{c['id']}"]
    for _ in range(8):                                                    # a takes 8 of 10: the swarm is at 80%
        assert hive.throughput.admit(a["id"], target)[0] == target
    # at 80% of the swarm, a mind may have used all of its own to go; a is at 8/10
    assert hive.throughput.admit(a["id"], target)[0] == target            # 9 of 10: now only minds under 50% of their own
    refused = hive.throughput.admit(a["id"], target)[1]
    assert refused and "minds that have sent less go first" in refused[0][1]
    assert hive.throughput.admit(b["id"], target)[0] == target            # b has sent nothing: it goes first
    assert "its swarm has sent its 10" in hive.throughput.admit(b["id"], target)[1][0][1]


def test_hive_defaults_are_inherited_and_admin_only(client):
    _, (a,) = make_swarm_and_agents(client, n=1)
    assert client.get("/api/hive/throughput").json()["defaults"] == {"mind": throughput.DEFAULT_MIND, "swarm": throughput.DEFAULT_SWARM}
    client.patch("/api/hive/throughput", json={"mind": 7, "swarm": 50})
    assert client.get(f"/api/agents/{a['id']}").json()["throughput"]["messages_per_hour_effective"] == 7
    client.patch(f"/api/agents/{a['id']}", json={"messages_per_hour": 2})
    assert client.get(f"/api/agents/{a['id']}").json()["throughput"]["messages_per_hour_effective"] == 2
    client.patch(f"/api/agents/{a['id']}", json={"messages_per_hour": None})     # back to the hive default
    assert client.get(f"/api/agents/{a['id']}").json()["throughput"]["messages_per_hour_effective"] == 7
    assert client.patch("/api/hive/throughput", json={"mind": -1}).status_code == 400
    assert client.patch(f"/api/agents/{a['id']}", json={"messages_per_hour": "lots"}).status_code == 400


def test_a_room_owner_may_still_choose_a_turn_cap(client):
    _, (a, b) = make_swarm_and_agents(client)
    g = client.post("/api/rooms", json={"kind": "group", "name": "Duo", "members": [f"agent:{a['id']}", f"agent:{b['id']}"]}).json()
    assert g["settings"]["turn_cap"] is None
    for i in range(5):                                                    # off: throughput alone bounds them
        sender, other = (a, "Dot1") if i % 2 == 0 else (b, "Dot0")
        out = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(sender), json={"text": f"@{other} {i}"}).json()
        assert out["delivered_to"] != []
    client.patch(f"/api/rooms/{g['id']}", json={"settings": {"turn_cap": 1}})
    client.post(f"/api/rooms/{g['id']}/messages", json={"text": "reset"})
    one = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(a), json={"text": "@Dot1 x"}).json()
    two = client.post(f"/api/agent/rooms/{g['id']}/messages", headers=agent_headers(b), json={"text": "@Dot0 y"}).json()
    assert one["delivered_to"] == [f"agent:{b['id']}"] and two["delivered_to"] == []
    client.patch(f"/api/rooms/{g['id']}", json={"settings": {"turn_cap": None}})
    assert client.get(f"/api/rooms/{g['id']}").json()["settings"]["turn_cap"] is None
