"""Purpose: verify Coffee Room membership, which each mind's owner decides, and message delivery.

The Coffee Room (Jon, 2026-10-06; PLATFORM_COFFEE_ROOM_PLAN_20261006.md): one room per hive where every
person and every eligible mind meets; it wakes no one by itself; minds may leave one unprompted note an hour; any
message can start a DM or a group that links back to it."""
import json

from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def public_minds(client, n=2, name="Pub"):
    sw = client.post("/api/swarms", json={"name": name, "visibility": "public"}).json()
    return sw, [client.post("/api/agents", json={"name": f"{name}{i}", "swarm_id": sw["id"], "visibility": "public"}).json()
                for i in range(n)]


def coffee(client, headers=None):
    return client.get("/api/rooms/coffee", **({"headers": headers} if headers else {})).json()


def members(room):
    return {m["member"] for m in room["members"]}


def inbox(client, agent):
    return [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(agent)).json()["messages"]]


def awake(client, *agents):
    for a in agents:
        client.app.state.hive.db.execute("UPDATE agents SET status = 'awake' WHERE id = ?", (a["id"],))


def test_everyone_is_in_one_pinned_room_and_private_minds_stay_out(client):
    _, (p0, p1) = public_minds(client)
    priv_sw = client.post("/api/swarms", json={"name": "Quiet"}).json()                      # private by default
    hidden = client.post("/api/agents", json={"name": "Hidden", "swarm_id": priv_sw["id"], "visibility": "public"}).json()
    private_mind = client.post("/api/agents", json={"name": "Shy", "swarm_id": public_minds(client, 0, "Open")[0]["id"]}).json()
    module = client.post("/api/agents", json={"name": "Mod", "kind": "module", "visibility": "public"}).json()
    ann = person(client, "u_ann")
    rooms = client.get("/api/rooms", headers=ann).json()
    room = next(r for r in rooms if r["kind"] == "coffee")
    assert room["pinned"] is True and room["name"] == "Coffee Room" and room["visibility"] == "public"
    assert [r for r in rooms if r["kind"] == "coffee"] == [room]                               # exactly one
    got = members(room)
    assert {"user:operator", "user:u_ann", f"agent:{p0['id']}", f"agent:{p1['id']}"} <= got
    for outsider in (hidden, private_mind, module):                                            # never revealed by default
        assert f"agent:{outsider['id']}" not in got
    statuses = {a["id"]: a.get("coffee") for a in client.get("/api/agents").json()}
    assert statuses[p0["id"]] == "member" and statuses[hidden["id"]] == "private" and statuses[private_mind["id"]] == "private"
    assert statuses[module["id"]] == "not_a_mind"
    # a person is shown by name, never by email
    client.app.state.hive.db.execute("UPDATE people SET name = '' WHERE id = 'u_ann'")
    names = {m["member"]: m["name"] for m in coffee(client)["members"]}
    assert names["user:u_ann"] == "Member" and "@" not in "".join(names.values())


def test_new_minds_join_and_deleted_minds_leave(client):
    _, (p0,) = public_minds(client, 1)
    coffee(client)
    _, (late,) = public_minds(client, 1, "Late")
    assert f"agent:{late['id']}" in members(coffee(client))
    client.delete(f"/api/agents/{late['id']}")
    assert f"agent:{late['id']}" not in members(coffee(client))


def test_a_minds_owner_opts_it_in_and_out_and_a_member_cannot(client):
    priv_sw = client.post("/api/swarms", json={"name": "Quiet"}).json()
    shy = client.post("/api/agents", json={"name": "Shy", "swarm_id": priv_sw["id"]}).json()      # the operator's own
    bob = person(client, "u_bob")
    assert client.patch(f"/api/agents/{shy['id']}", headers=bob, json={"coffee": True}).status_code in (403, 404)
    assert client.patch(f"/api/agents/{shy['id']}", json={"coffee": "yes"}).status_code == 400
    out = client.patch(f"/api/agents/{shy['id']}", json={"coffee": True}).json()
    assert out["coffee"] == "member" and f"agent:{shy['id']}" in members(coffee(client))
    assert client.patch(f"/api/agents/{shy['id']}", json={"coffee": False}).json()["coffee"] == "opted_out"
    assert f"agent:{shy['id']}" not in members(coffee(client))


def test_a_private_minds_owner_opts_in_even_when_the_owner_is_not_an_admin(client):
    owner = person(client, "u_wren")
    other = person(client, "u_fern")
    mind = client.post("/api/agents", headers=owner, json={"name": "Invented Juniper"}).json()
    path = f"/api/agents/{mind['id']}"
    refused = client.patch(path, json={"coffee": True})
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "owner_only"
    assert client.patch(path, headers=other, json={"coffee": True}).status_code in (403, 404)
    assert f"agent:{mind['id']}" not in members(coffee(client))
    accepted = client.patch(path, headers=owner, json={"coffee": True})
    assert accepted.status_code == 200 and accepted.json()["coffee"] == "member"
    assert f"agent:{mind['id']}" in members(coffee(client))
    assert client.patch(path, headers=owner, json={"coffee": False}).json()["coffee"] == "opted_out"
    assert f"agent:{mind['id']}" not in members(coffee(client))


def test_nonpublic_swarm_also_requires_the_mind_owners_consent(client):
    owner = person(client, "u_lyra")
    swarm = client.post("/api/swarms", headers=owner, json={"name": "Invented Quiet"}).json()
    mind = client.post("/api/agents", headers=owner,
                       json={"name": "Invented Rowan", "swarm_id": swarm["id"], "visibility": "public"}).json()
    path = f"/api/agents/{mind['id']}"
    assert client.patch(path, json={"coffee": True}).status_code == 403
    assert client.patch(path, headers=owner, json={"coffee": True}).status_code == 200
    assert f"agent:{mind['id']}" in members(coffee(client))


def test_old_admin_opt_ins_and_a_previous_owners_consent_do_not_disclose_private_minds(client):
    from hive.core.db import now
    owner = person(client, "u_moss")
    mind = client.post("/api/agents", headers=owner, json={"name": "Invented Hazel"}).json()
    db = client.app.state.hive.db
    db.execute("INSERT INTO coffee_prefs VALUES (?, 'in', 'user:operator', ?)", (mind["id"], now()))
    assert f"agent:{mind['id']}" not in members(coffee(client))
    assert client.patch(f"/api/agents/{mind['id']}", headers=owner, json={"coffee": True}).status_code == 200
    db.execute("UPDATE agents SET owner = 'user:u_new_owner' WHERE id = ?", (mind["id"],))
    assert f"agent:{mind['id']}" not in members(coffee(client))


def test_admin_can_ask_privately_but_the_request_does_not_grant_membership(client):
    owner = person(client, "u_birch")
    outsider = person(client, "u_alder")
    mind = client.post("/api/agents", headers=owner, json={"name": "Invented Ash"}).json()
    dm = client.post("/api/rooms", json={"kind": "dm", "members": ["user:u_birch"]}).json()
    request = "Please add Invented Ash to the Coffee Room only if you want everyone in the hive to see its name."
    assert client.post(f"/api/rooms/{dm['id']}/messages", json={"text": request}).status_code == 200
    messages = client.get(f"/api/rooms/{dm['id']}/messages", headers=owner).json()
    assert any(message["text"] == request for message in messages)
    assert client.get(f"/api/rooms/{dm['id']}/messages", headers=outsider).status_code == 404
    assert f"agent:{mind['id']}" not in members(coffee(client))
    assert client.patch(f"/api/agents/{mind['id']}", headers=owner, json={"coffee": True}).status_code == 200


def test_only_a_minds_owner_moves_it_over_every_viewer_visibility_and_stored_choice(client):
    """Jon on #265, under #615 (each person is their own admin): the owner alone puts a mind in or takes it out, public or
    private, with the member role or the admin one. The rule, every cell: anyone else is refused, 403 when they see the
    mind and 404 when they don't, and nothing changes; an owner's request decides; an opt-out stays whoever stored it;
    an opt-in counts for a private mind only when its owner made it. Each case starts from a stored choice set directly."""
    from hive.core.db import now
    hive = client.app.state.hive
    who = {"wren": "user:u_wren", "oak": "user:u_oak", "fern": "user:u_fern", "elm": "user:u_elm", "operator": "user:operator"}
    heads = {"wren": person(client, "u_wren"), "oak": person(client, "u_oak", "admin"), "fern": person(client, "u_fern"),
             "elm": person(client, "u_elm", "admin"), "operator": {}}
    admins = {"oak", "elm", "operator"}
    minds = {}
    for owner in ("wren", "oak"):                      # a member owner and an admin owner, each with three kinds of mind
        open_sw = client.post("/api/swarms", headers=heads[owner], json={"name": f"Invented Open {owner}", "visibility": "public"}).json()
        quiet_sw = client.post("/api/swarms", headers=heads[owner], json={"name": f"Invented Quiet {owner}"}).json()
        assert open_sw["visibility"] == "public" and quiet_sw["visibility"] == "private"
        for shape, sw, vis in (("public", open_sw, "public"), ("private_mind", open_sw, "private"), ("private_swarm", quiet_sw, "public")):
            m = client.post("/api/agents", headers=heads[owner], json={"name": f"Invented {owner} {shape}", "swarm_id": sw["id"],
                                                                        "visibility": vis}).json()
            assert m["owner"] == who[owner], m
            minds[(owner, shape)] = m
    stored = {"none": None, "in_by_owner": ("in", True), "in_by_other": ("in", False),
              "out_by_owner": ("out", True), "out_by_other": ("out", False)}
    wrong = []
    for (owner, shape), m in minds.items():
        public = shape == "public"
        for name, pref in stored.items():
            if pref is None:
                before = "member" if public else "private"
            else:
                before = "opted_out" if pref[0] == "out" else "member" if public or pref[1] else "private"
            for viewer in who:
                for want in (True, False):
                    hive.db.execute("DELETE FROM coffee_prefs WHERE agent_id = ?", (m["id"],))
                    if pref is not None:
                        hive.db.execute("INSERT INTO coffee_prefs VALUES (?, ?, ?, ?)",
                                        (m["id"], pref[0], who[owner] if pref[1] else "user:u_elm", now()))
                    r = client.patch(f"/api/agents/{m['id']}", headers=heads[viewer], json={"coffee": want})
                    if viewer == owner:
                        expect = (200, None, "member" if want else "opted_out")
                    elif viewer in admins or shape != "private_mind":
                        expect = (403, "owner_only", before)
                    else:                                  # a member who doesn't see a private mind isn't told it exists
                        expect = (404, "not_found", before)
                    hive.rooms.sync_coffee()
                    row = hive.db.one("SELECT * FROM agents WHERE id = ?", (m["id"],))
                    got = (r.status_code, None if r.status_code == 200 else r.json()["error"]["code"], hive.rooms.coffee_status(row))
                    if got != expect or (got[2] == "member") != (f"agent:{m['id']}" in rows(client)):
                        wrong.append((owner, shape, name, viewer, want, got, expect))
    assert wrong == [], wrong[:8]


def test_an_admin_keeps_the_rooms_own_controls_and_a_member_has_none(client):
    elm, fern = person(client, "u_elm", "admin"), person(client, "u_fern")
    room = coffee(client)
    path = f"/api/rooms/{room['id']}"
    assert client.patch(path, headers=elm, json={"name": "Invented Lounge", "topic": "Mornings at nine",
                                                 "settings": {"turn_cap": 4}}).status_code == 200
    got = coffee(client)
    assert got["name"] == "Invented Lounge" and got["topic"] == "Mornings at nine"
    assert client.patch(path, headers=fern, json={"topic": "mine"}).status_code == 400
    _, (a,) = public_minds(client, 1)
    assert client.post(f"{path}/members", headers=elm, json={"members": [f"agent:{a['id']}"]}).status_code == 400
    assert client.delete(f"{path}/members/agent:{a['id']}", headers=elm).status_code == 400


def test_the_room_wakes_no_one_unless_addressed_and_here_reaches_at_most_five_awake_minds(client):
    _, minds = public_minds(client, 8)
    room = coffee(client)
    quiet = client.post(f"/api/rooms/{room['id']}/messages", json={"text": "morning all"}).json()
    assert quiet["delivered_to"] == [] and quiet["here_reached"] == []
    assert all(inbox(client, m) == [] for m in minds)                                          # nothing spent
    named = client.post(f"/api/rooms/{room['id']}/messages", json={"text": "@Pub3 coffee?"}).json()
    assert named["delivered_to"] == [f"agent:{minds[3]['id']}"]
    got = inbox(client, minds[3])[-1]
    assert got["notice"].startswith("Everyone in the hive can read the Coffee Room") and got["room"]["kind"] == "coffee"
    awake(client, *minds[:7])                                                                  # seven awake, one asleep
    here = client.post(f"/api/rooms/{room['id']}/messages", json={"text": "@here who is around?"}).json()
    assert len(here["here_reached"]) == 5 and f"agent:{minds[7]['id']}" not in here["here_reached"]
    assert set(here["delivered_to"]) == set(here["here_reached"])
    # a mind's @here does not fan out (only people may call the room)
    said = client.post(f"/api/agent/rooms/coffee/messages", headers=agent_headers(minds[0]), json={"text": "@here hi"}).json()
    assert said["delivered_to"] == [] and said["here_reached"] == []


def test_a_mind_may_leave_one_unprompted_note_an_hour_that_wakes_no_one(client):
    _, (a, b) = public_minds(client)
    awake(client, b)
    note = client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a),
                       json={"text": "Learned: @Pub1 the build cache halves test time", "note": True}).json()
    assert note["note"] is True and note["delivered_to"] == [] and note["mentions"] == []
    assert inbox(client, b) == []                                                              # a note never wakes anyone
    again = client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a), json={"text": "and another", "note": True})
    assert again.status_code == 429 and again.json()["error"]["code"] == "note_too_soon"
    group = client.post("/api/rooms", json={"kind": "group", "name": "G", "members": [f"agent:{a['id']}"]}).json()
    elsewhere = client.post(f"/api/agent/rooms/{group['id']}/messages", headers=agent_headers(a), json={"text": "x", "note": True})
    assert elsewhere.status_code == 400
    # an hour later the mind may note again
    client.app.state.hive.db.execute("UPDATE room_messages SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", (note["id"],))
    assert client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a),
                       json={"text": "next thought", "note": True}).status_code == 200


def test_break_off_into_a_dm_or_group_that_links_back(client):
    _, (a, b) = public_minds(client)
    room = coffee(client)
    msg = client.post(f"/api/rooms/{room['id']}/messages", json={"text": "who wants to plan the garden?"}).json()
    origin = {"room_id": room["id"], "message_id": msg["id"]}
    dm = client.post("/api/rooms", json={"kind": "dm", "members": [f"agent:{a['id']}"], "origin": origin}).json()
    assert dm["kind"] == "dm" and dm["origin"] == origin
    grp = client.post("/api/rooms", json={"kind": "group", "name": "Garden", "origin": origin,
                                          "members": [f"agent:{a['id']}", f"agent:{b['id']}"]}).json()
    assert grp["origin"] == origin and members(grp) == {"user:operator", f"agent:{a['id']}", f"agent:{b['id']}"}
    assert client.post("/api/rooms", json={"kind": "group", "name": "X", "origin": {"room_id": room["id"]}}).status_code == 400
    assert client.post("/api/rooms", json={"kind": "group", "name": "X",
                                           "origin": {"room_id": room["id"], "message_id": "rm_nope"}}).status_code == 404
    # a message in a room the person cannot see cannot be named
    ann = person(client, "u_ann")
    secret = client.post("/api/rooms", json={"kind": "group", "name": "Secret"}).json()
    hidden = client.post(f"/api/rooms/{secret['id']}/messages", json={"text": "private"}).json()
    leak = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Y",
                                                         "origin": {"room_id": secret["id"], "message_id": hidden["id"]}})
    assert leak.status_code == 404


def test_the_room_cannot_be_copied_left_reshaped_or_hand_managed(client):
    _, (a,) = public_minds(client, 1)
    room = coffee(client)
    ann = person(client, "u_ann")
    assert client.post("/api/rooms", json={"kind": "coffee", "name": "Second"}).status_code == 400
    assert client.delete(f"/api/rooms/{room['id']}/members/user:u_ann", headers=ann).status_code == 400
    assert client.post(f"/api/rooms/{room['id']}/members", json={"members": [f"agent:{a['id']}"]}).status_code == 400
    assert client.patch(f"/api/rooms/{room['id']}", json={"kind": "channel"}).status_code == 400
    assert client.patch(f"/api/rooms/{room['id']}", json={"visibility": "private"}).status_code == 400
    assert client.patch(f"/api/rooms/{room['id']}", headers=ann, json={"topic": "mine"}).status_code == 400
    assert client.patch(f"/api/rooms/{room['id']}", json={"topic": "Mornings at nine"}).json()["topic"] == "Mornings at nine"
    assert client.post(f"/api/rooms/{room['id']}/swarm", json={}).status_code == 400
    # a person can speak there without joining anything first
    assert client.post(f"/api/rooms/{room['id']}/messages", headers=ann, json={"text": "hello hive"}).status_code == 200


def rows(client):
    """Coffee Room membership as stored, without the refresh a room read performs (reviewers: don't mask hooks)."""
    db = client.app.state.hive.db
    room = db.one("SELECT id FROM rooms WHERE alias = 'coffee'")
    return {m["member"] for m in db.all("SELECT member FROM room_members WHERE room_id = ?", (room["id"],))}


def test_no_room_can_become_a_second_coffee_room(client):
    ann = person(client, "u_ann")
    mine = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Private"}).json()
    assert client.patch(f"/api/rooms/{mine['id']}", headers=ann, json={"kind": "coffee"}).status_code == 400
    assert client.patch(f"/api/rooms/{mine['id']}", json={"kind": "coffee"}).status_code == 400      # not even an admin
    assert [r["id"] for r in client.get("/api/rooms").json() if r["kind"] == "coffee"] == [coffee(client)["id"]]
    # follow mode never applies in the Coffee Room
    assert client.patch(f"/api/rooms/{coffee(client)['id']}", json={"settings": {"minds_follow": True}}).status_code == 400


def test_minds_never_receive_an_email_from_the_coffee_room(client):
    _, (a,) = public_minds(client, 1)
    ann = person(client, "u_ann")
    client.app.state.hive.db.execute("UPDATE people SET name = '' WHERE id = 'u_ann'")
    room = coffee(client)
    client.post(f"/api/rooms/{room['id']}/messages", headers=ann, json={"text": "first thought"})
    client.post(f"/api/rooms/{room['id']}/messages", headers=ann, json={"text": "@Pub0 what do you think?"})
    got = inbox(client, a)[-1]
    assert got["sender_name"] == "Member" and all("@example.test" not in line for line in got.get("earlier", [])), got
    listed = client.get("/api/agent/rooms", headers=agent_headers(a)).json()
    cafe = next(r for r in listed if r["kind"] == "coffee")
    assert "Member" in cafe["members"] and not any("@" in m for m in cafe["members"])


def test_the_privacy_notice_reaches_the_minds_prompt_text():
    from modules.channel_hive.src.hive_channel import _room_text
    text = _room_text({"text": "hi", "room": {"name": "Coffee Room", "kind": "coffee"}, "sender_name": "Jon",
                       "notice": "Everyone in the hive can read the Coffee Room; keep private memory out of it."})
    assert "Everyone in the hive can read the Coffee Room" in text and text.rstrip().endswith("Jon: hi")


def test_membership_follows_every_change_immediately(client):
    sw, (a, b) = public_minds(client)
    coffee(client)
    assert {f"agent:{a['id']}", f"agent:{b['id']}"} <= rows(client)                                  # create hook
    _, (late,) = public_minds(client, 1, "Late")
    assert f"agent:{late['id']}" in rows(client)                                                       # stored, no read
    client.put(f"/api/agents/{a['id']}/visibility", json={"visibility": "private"})
    assert f"agent:{a['id']}" not in rows(client)                                                      # mind made private
    client.put(f"/api/swarms/{sw['id']}/visibility", json={"visibility": "shared", "shared_with": []})
    assert f"agent:{b['id']}" not in rows(client)                                                      # swarm made shared
    quiet = client.post("/api/swarms", json={"name": "Quiet"}).json()
    client.patch(f"/api/agents/{late['id']}", json={"swarm_id": quiet["id"]})
    assert f"agent:{late['id']}" not in rows(client)                                                   # moved: update hook
    names = [r for r in client.get("/api/agent/rooms", headers=agent_headers(late)).json() if r["kind"] == "coffee"]
    assert names == []                                                                                 # nor in its own list


def test_a_note_cannot_reopen_a_room_waiting_for_a_person(client):
    _, (a, b) = public_minds(client)
    room = coffee(client)
    assert client.patch(f"/api/rooms/{room['id']}", json={"settings": {"turn_cap": 3}}).status_code == 200   # an admin's choice
    client.post(f"/api/rooms/{room['id']}/messages", json={"text": "@Pub0 start"})
    for i in range(3):                                    # a turn cap of 3 mind turns in a row
        sender, target = (a, "Pub1") if i % 2 == 0 else (b, "Pub0")
        client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(sender), json={"text": f"@{target} turn {i}"})
    held = client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a), json={"text": "@Pub1 more"}).json()
    assert held["delivered_to"] == []
    client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(b), json={"text": "a thought", "note": True})
    after = client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a), json={"text": "@Pub1 again"}).json()
    assert after["delivered_to"] == []                                                                 # still waiting


def test_an_existing_database_is_upgraded_in_place(tmp_path):
    """A hive created before the Coffee Room (no origin/note/here_reached columns) starts, keeps its messages and gains
    the new columns."""
    import pathlib
    import sqlite3
    from fastapi.testclient import TestClient
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    db = sqlite3.connect(tmp_path / "hive.db")
    db.executescript("""
      CREATE TABLE rooms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', shared_with TEXT NOT NULL DEFAULT '[]', alias TEXT UNIQUE,
        swarm_id TEXT, settings TEXT NOT NULL DEFAULT '{}', seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE room_messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
        sender TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', delivered_to TEXT NOT NULL DEFAULT '[]',
        mind_run INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (room_id, seq));
      INSERT INTO rooms VALUES ('r_old', 'group', 'Old', '', 'user:operator', 'private', '[]', NULL, NULL, '{}', 1, '2026-01-01', '2026-01-01', 0);
      INSERT INTO room_messages VALUES ('rm_old', 'r_old', 1, 'user:operator', 'kept', '[]', '[]', 0, '2026-01-01');
    """)
    db.commit()
    db.close()
    settings = load_settings(data_dir=pathlib.Path(tmp_path), admin_password="pw", petta_path=PETTA)
    with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)) as c:
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        old = c.get("/api/rooms/r_old/messages").json()
        assert [m["text"] for m in old] == ["kept"] and old[0]["note"] is False and old[0]["here_reached"] == []
        assert c.get("/api/rooms/r_old").json()["origin"] is None
        assert c.get("/api/rooms/coffee").json()["kind"] == "coffee"


def test_the_classic_message_route_cannot_reach_into_the_coffee_room(client):
    """Stand-in r2 P1: a direct message addressed to the Coffee Room conversation would mirror into the room and wake a
    sleeping mind with no mention and no public-room notice. It is refused; only the room delivers."""
    _, (a,) = public_minds(client, 1)
    room = coffee(client)
    before = len(client.get(f"/api/rooms/{room['id']}/messages").json())
    for conv in ("coffee", room["id"]):
        r = client.post(f"/api/agents/{a['id']}/messages", json={"text": "hello", "conversation_id": conv})
        assert r.status_code == 400, r.text
    assert inbox(client, a) == [] and len(client.get(f"/api/rooms/{room['id']}/messages").json()) == before
    assert client.get("/api/rooms/coffee").json()["alias"] == "coffee"          # the view names its alias (Surface UI)


def test_a_stale_membership_sync_cannot_restore_a_private_mind(client):
    """Stand-in r2 P2: two syncs racing — one read eligibility while the mind was public, then the mind was made private
    and a second sync ran. With the lock the stale sync finishes first and the later one removes the mind."""
    import threading
    hive = client.app.state.hive
    _, (a,) = public_minds(client, 1)
    coffee(client)
    hive.db.execute("DELETE FROM room_members WHERE member = ?", (f"agent:{a['id']}",))   # as if not yet synced
    snapshot_taken, release = threading.Event(), threading.Event()
    real = hive.rooms._coffee_wanted
    calls = {"n": 0}

    def slow_wanted():
        calls["n"] += 1
        wanted = real()
        if calls["n"] == 1:              # the first sync snapshots "public" and is held before applying it
            snapshot_taken.set()
            release.wait(5)
        return wanted

    hive.rooms._coffee_wanted = slow_wanted
    try:
        stale = threading.Thread(target=hive.rooms.sync_coffee)
        stale.start()
        assert snapshot_taken.wait(5)
        hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = ?", (a["id"],))
        later = threading.Thread(target=hive.rooms.sync_coffee)   # the visibility change's own sync
        later.start()
        later.join(1.0)      # without the lock it finishes here, before the stale sync applies; with it, it must wait
        release.set()
        stale.join(5)
        later.join(5)
    finally:
        hive.rooms._coffee_wanted = real
    assert f"agent:{a['id']}" not in rows(client)


def test_many_first_visits_at_once_create_exactly_one_room(client):
    """Stand-in r3 P2: concurrent first use (a worker-thread opt-in and a room read) never collides on the alias."""
    import threading
    hive = client.app.state.hive
    hive.db.execute("DELETE FROM rooms WHERE alias = 'coffee'")
    start, errors = threading.Barrier(12), []

    def visit():
        start.wait()
        try:
            hive.rooms.ensure_coffee()
        except Exception as exc:   # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=visit) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert errors == [] and len(hive.db.all("SELECT id FROM rooms WHERE alias = 'coffee'")) == 1
