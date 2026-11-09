"""Team rooms (Jon, 2026-10-08, after "Patswarm"): every swarm has a private room with its owner and its minds, so minds
can reach a swarm-mate by posting there with @Name; minds are told so; @Name tolerates missing spaces and punctuation."""
import importlib.util
import json
import pathlib
import re

from hive.core.db import new_id, now
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

ROOT = pathlib.Path(__file__).resolve().parents[2]


def team(client, swarm_id):
    return client.app.state.hive.rooms.team_room(swarm_id)


def members(client, room_id):
    return {m["member"] for m in client.app.state.hive.rooms.members(room_id)}


def team_rooms(client, swarm_id):
    return client.app.state.hive.db.all("SELECT * FROM rooms WHERE swarm_id = ? AND alias = ?", (swarm_id, f"team_{swarm_id}"))


def inbox(client, agent):
    return [json.loads(m["text"]) for m in client.get("/api/agent/inbox", headers=agent_headers(agent)).json()["messages"]]


# ---- A: every swarm has a team room, kept in step -------------------------------------------------------------------

def test_a_new_swarm_gets_a_private_team_room_with_its_owner_and_minds(client):
    sw, (a, b) = make_swarm_and_agents(client)
    r = team(client, sw["id"])
    assert r is not None and r["kind"] == "group" and r["visibility"] == "private" and r["swarm_id"] == sw["id"]
    assert r["owner"] == "user:operator" and not r["archived"]
    assert members(client, r["id"]) == {"user:operator", f"agent:{a['id']}", f"agent:{b['id']}"}
    mine = client.get("/api/agent/rooms", headers=agent_headers(a)).json()
    assert [x["team"] for x in mine if x["id"] == r["id"]] == [True]
    assert len(team_rooms(client, sw["id"])) == 1


def test_minds_joining_moving_and_deleted_keep_the_team_room_in_step(client):
    sw, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Beta"}).json()
    r = team(client, sw["id"])
    c = client.post("/api/agents", json={"name": "Dot2", "swarm_id": sw["id"]}).json()
    assert f"agent:{c['id']}" in members(client, r["id"])                       # joins with the swarm
    assert client.patch(f"/api/agents/{a['id']}", json={"swarm_id": other["id"]}).status_code == 200
    assert f"agent:{a['id']}" not in members(client, r["id"])                   # moved away: leaves
    assert f"agent:{a['id']}" in members(client, team(client, other["id"])["id"])   # and joins its new team
    assert client.delete(f"/api/agents/{b['id']}").status_code == 200
    assert members(client, r["id"]) == {"user:operator", f"agent:{c['id']}"}    # deleted: leaves
    module = client.post("/api/agents", json={"name": "Outside", "kind": "module", "swarm_id": sw["id"]}).json()
    assert f"agent:{module['id']}" not in members(client, r["id"])               # outside members are not minds


def test_startup_migration_gives_existing_swarms_one_team_room_idempotently(client):
    hive = client.app.state.hive
    sw, (a,) = make_swarm_and_agents(client, n=1)
    sid = new_id("s")      # a swarm from before team rooms: no room
    hive.db.insert("swarms", {"id": sid, "name": "Old", "description": "", "hue": 1, "created_at": now(),
                              "owner": "user:operator", "visibility": "private", "shared_with": "[]"})
    hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (sid, a["id"]))
    assert team(client, sid) is None
    from hive.core.rooms import Rooms
    Rooms(hive)            # as on a restart
    Rooms(hive)
    hive.rooms.sync_teams()
    assert len(team_rooms(client, sid)) == 1 and len(team_rooms(client, sw["id"])) == 1
    assert members(client, team(client, sid)["id"]) == {"user:operator", f"agent:{a['id']}"}
    # a team room archived by hand is never brought back or duplicated
    hive.db.execute("UPDATE rooms SET archived = 1 WHERE id = ?", (team(client, sid)["id"],))
    hive.rooms.sync_teams()
    assert len(team_rooms(client, sid)) == 1 and team(client, sid)["archived"] == 1


def test_archived_swarms_get_none_coffee_is_untouched_and_a_deleted_swarms_room_is_archived(client):
    hive = client.app.state.hive
    sid = new_id("s")
    hive.db.insert("swarms", {"id": sid, "name": "Retired", "description": "", "hue": 1, "created_at": now(),
                              "owner": "user:operator", "visibility": "private", "shared_with": "[]", "archived_at": now()})
    coffee = client.get("/api/rooms/coffee").json()
    hive.rooms.sync_teams()
    assert team(client, sid) is None                                                   # archived: no team room
    assert client.get("/api/rooms/coffee").json()["members"] == coffee["members"]      # Coffee Room as it was
    assert hive.db.one("SELECT COUNT(*) AS n FROM rooms WHERE kind = 'coffee'")["n"] == 1
    assert all(r["kind"] == "group" for r in hive.db.all("SELECT kind FROM rooms WHERE alias LIKE 'team_%'"))
    empty = client.post("/api/swarms", json={"name": "Empty"}).json()
    rid = team(client, empty["id"])["id"]
    assert client.delete(f"/api/swarms/{empty['id']}").status_code == 200
    assert hive.db.one("SELECT archived FROM rooms WHERE id = ?", (rid,))["archived"] == 1


def test_a_minds_post_reaches_a_swarm_mate_only_with_an_at_mention(client):
    sw, (a, b) = make_swarm_and_agents(client)
    rid = team(client, sw["id"])["id"]
    plain = client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "anyone there?"}).json()
    assert plain["delivered_to"] == [] and inbox(client, b) == []                     # no @: nobody woken
    out = client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "@Dot1 can you check s2?"}).json()
    assert out["delivered_to"] == [f"agent:{b['id']}"]
    got = inbox(client, b)[-1]
    assert got["text"] == "@Dot1 can you check s2?" and got["conversation_id"] == f"team_{sw['id']}" and got["room"]["kind"] == "group"


def test_the_team_room_reveals_no_mind_the_owner_may_not_see_and_is_for_members_only(client):
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    a = client.post("/api/agents", json={"name": "Hers", "swarm_id": sw["id"], "owner": "user:u_ann"}).json()
    hive.db.execute("UPDATE agents SET owner = 'user:u_ann' WHERE id = ?", (a["id"],))
    b = client.post("/api/agents", json={"name": "Bobs", "swarm_id": sw["id"]}).json()
    hive.db.execute("UPDATE agents SET owner = 'user:u_bob', visibility = 'private' WHERE id = ?", (b["id"],))
    hive.rooms.sync_teams()
    r = team(client, sw["id"])
    assert r["owner"] == "user:u_ann"
    assert members(client, r["id"]) == {"user:u_ann", f"agent:{a['id']}"}             # Bob's private mind stays out
    assert r["id"] in [x["id"] for x in client.get("/api/rooms", headers=ann).json()]
    assert r["id"] not in [x["id"] for x in client.get("/api/rooms", headers=bob).json()]
    assert client.get(f"/api/rooms/{r['id']}/messages", headers=bob).status_code == 404
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (b["id"],))
    hive.rooms.sync_teams()
    assert f"agent:{b['id']}" in members(client, r["id"])                              # once Ann may see it, it joins


# ---- B: minds are told -------------------------------------------------------------------------------------------

_spec = importlib.util.spec_from_file_location("hive_commons_team", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)
NOTE = "to reach a swarm-mate, post in your swarm's team room and @name them"   # modules/hive/catalog.metta (the runtime's)
HOST_NOTE = "to reach a swarm-mate, post in your swarm's room and @name them"    # the host's templates (host-wording r1)


def test_the_skills_line_minds_see_lists_the_room_skills_with_the_usage_note():
    catalog = (ROOT / "modules" / "hive" / "catalog.metta").read_text(encoding="utf-8")
    hints = [line for _domain, line in re.findall(r'\(SkillContextHint\s+"([^"]+)"\s+"((?:[^"\\]|\\.)+)"\)', catalog)]
    rooms = [h for h in hints if "hive-room-post" in h]
    assert len(rooms) == 1 and "hive-rooms" in rooms[0] and NOTE in rooms[0].lower()
    assert hc.skill_hints("(" + " ".join(json.dumps(h) for h in hints) + ")") is not None
    for path in ("modules/hive/module.toml", "hive/templates/omega/prompt.txt"):
        text = (ROOT / path).read_text(encoding="utf-8")
        assert "hive-room-post" in text and ("skill:hive-rooms" in text or HOST_NOTE in text.lower()), path


def test_hive_rooms_marks_the_team_room(monkeypatch):
    rooms = [{"id": "r_team", "kind": "group", "name": "Patswarm team", "team": True, "members": ["Jon", "Patmind"]},
             {"id": "r_dm", "kind": "dm", "name": "DM", "members": ["Jon", "Patmind"]}]
    monkeypatch.setattr(hc, "_call", lambda m, p, payload=None: (rooms, None))
    assert hc.rooms() == "HIVE-ROOMS r_team group (your swarm team room) Patswarm team: Jon, Patmind | r_dm dm DM: Jon, Patmind"


# ---- C: @mentions without the spaces and punctuation ------------------------------------------------------------------

def test_at_mentions_match_names_typed_without_spaces_or_punctuation_and_never_a_prefix(client):
    hive = client.app.state.hive
    _, (a, b, c, d) = make_swarm_and_agents(client, n=4)
    for agent, name in ((a, "Devil's Advocate"), (b, "Review"), (c, "Review Intent"), (d, "Ann")):
        hive.db.execute("UPDATE agents SET name = ? WHERE id = ?", (name, agent["id"]))
    g = client.post("/api/rooms", json={"kind": "group", "name": "Names",
                                        "members": [f"agent:{x['id']}" for x in (a, b, c, d)]}).json()
    found = lambda text: hive.rooms.mentions(g["id"], text)
    dev, rev, intent, ann = (f"agent:{x['id']}" for x in (a, b, c, d))
    for text in ("@Devil'sAdvocate what now?", "@devilsadvocate", "ping @DEVILS-ADVOCATE, please", "@Devil's Advocate"):
        assert found(text) == [dev], text
    assert found("@ReviewIntent go") == [intent] and found("@Review Intent go") == [intent]
    assert found("@review go") == [rev] and found(f"@{b['id']} go") == [rev]
    for text in ("@Devil's", "@devilsadvocates", "@Revie", "@Annabel", "mail ann@devilsadvocate.com", "Ann, no at sign"):
        assert found(text) == [], text


# ---- r2: review findings (stand-in S1-S4, Kimi K1-K7 + the room-edit invariant) ---------------------------------------

def _shared_swarm(client):
    """Ann's swarm, shared with Bob, with one mind of Ann's that Bob may not see."""
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab", "visibility": "shared",
                                                       "shared_with": ["user:u_bob"]}).json()
    a = client.post("/api/agents", json={"name": "Hidden", "swarm_id": sw["id"]}).json()
    hive.db.execute("UPDATE agents SET owner = 'user:u_ann', visibility = 'private' WHERE id = ?", (a["id"],))
    hive.rooms.sync_teams()
    return hive, ann, bob, sw, a


def test_seeing_a_shared_swarm_never_joins_its_team_room(client):
    """S1 / K4: swarm visibility is not team-room membership."""
    hive, ann, bob, sw, a = _shared_swarm(client)
    r = team(client, sw["id"])
    assert client.get(f"/api/swarms/{sw['id']}", headers=bob).status_code == 200            # Bob sees the swarm
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=bob).status_code == 404       # but not its team room
    assert "user:u_bob" not in members(client, r["id"])
    assert client.get(f"/api/rooms/{r['id']}/messages", headers=bob).status_code == 404
    mine = client.post(f"/api/swarms/{sw['id']}/room", headers=ann).json()                    # the owner gets it
    assert mine["id"] == r["id"] and f"agent:{a['id']}" in {m["member"] for m in mine["members"]}
    assert client.post(f"/api/swarms/{sw['id']}/room").json()["id"] == r["id"]               # and so does an admin


def test_a_team_rooms_alias_conversation_is_filtered_like_its_room(client):
    """S2: live message events and mind messages carrying conversation_id team_<swarm> are judged by the room."""
    hive, ann, bob, sw, a = _shared_swarm(client)
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (a["id"],))      # Bob may see the mind
    r = team(client, sw["id"])
    from hive.core.visibility import Viewer
    for conv in (r["alias"], r["id"]):
        event = json.dumps({"type": "message", "message": {"agent_id": a["id"], "conversation_id": conv, "text": "team talk"}})
        assert not hive.visibility.event_visible(Viewer("user:u_bob", False), event), conv
        assert hive.visibility.event_visible(Viewer("user:u_ann", False), event), conv


def test_punctuation_joined_names_reach_the_whole_name_not_its_prefix(client):
    """S3: '@Review.Intent' is Review Intent, never Review; '@Review's' is still Review."""
    hive = client.app.state.hive
    _, (b, c) = make_swarm_and_agents(client, n=2)
    for agent, name in ((b, "Review"), (c, "Review Intent")):
        hive.db.execute("UPDATE agents SET name = ? WHERE id = ?", (name, agent["id"]))
    g = client.post("/api/rooms", json={"kind": "group", "name": "N", "members": [f"agent:{b['id']}", f"agent:{c['id']}"]}).json()
    found = lambda text: hive.rooms.mentions(g["id"], text)
    rev, intent = f"agent:{b['id']}", f"agent:{c['id']}"
    for text in ("@Review.Intent", "@Review/Intent go", "@Review-Intent", "@Review_Intent", "@Review Intent", "@reviewintent"):
        assert found(text) == [intent], text
    for text in ("@Review's idea", "@Review, hi", "@review"):
        assert found(text) == [rev], text
    assert sorted(found("@Review and @Review.Intent")) == sorted([rev, intent])


def test_one_failing_swarm_does_not_stop_the_others_or_the_hive(client, monkeypatch, caplog):
    """S4 / K5: the startup migration is isolated per swarm, logged, and retried on the next sync."""
    hive = client.app.state.hive
    ids = []
    for name in ("One", "Two"):
        sid = new_id("s")
        hive.db.insert("swarms", {"id": sid, "name": name, "description": "", "hue": 1, "created_at": now(),
                                  "owner": "user:operator", "visibility": "private", "shared_with": "[]"})
        ids.append(sid)
    real = hive.rooms._sync_team_locked
    def broken(swarm_id):
        if swarm_id == ids[0]:
            raise RuntimeError("boom")
        return real(swarm_id)
    monkeypatch.setattr(hive.rooms, "_sync_team_locked", broken)
    from hive.core.rooms import Rooms
    import logging
    with caplog.at_level(logging.ERROR, logger="hive"):
        Rooms.sync_teams(hive.rooms)      # as Rooms.__init__ runs it
    assert team(client, ids[0]) is None and team(client, ids[1]) is not None
    assert any("swarm room sync failed" in r.getMessage() for r in caplog.records)
    monkeypatch.setattr(hive.rooms, "_sync_team_locked", real)
    hive.rooms.sync_teams()               # the next sync puts it right
    assert team(client, ids[0]) is not None


def test_a_room_already_holding_the_alias_is_never_adopted_or_archived(client, caplog):
    """K1 / K7: a squatter on team_<swarm> keeps its own members; nothing is added to it, nothing archived."""
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Mine"}).json()
    sid = new_id("s")
    hive.db.execute("UPDATE rooms SET alias = ? WHERE id = ?", (f"team_{sid}", g["id"]))
    hive.db.insert("swarms", {"id": sid, "name": "Late", "description": "", "hue": 1, "created_at": now(),
                              "owner": "user:operator", "visibility": "private", "shared_with": "[]"})
    import logging
    with caplog.at_level(logging.WARNING, logger="hive"):
        hive.rooms.sync_teams()
    assert members(client, g["id"]) == {"user:u_ann"}
    row = hive.db.one("SELECT * FROM rooms WHERE id = ?", (g["id"],))
    assert row["archived"] == 0 and row["owner"] == "user:u_ann"
    assert any("swarm room" in r.getMessage() and sid in r.getMessage() for r in caplog.records)


def test_the_team_room_follows_its_swarms_name_and_owner(client):
    """K2: a rename (and an owner changed by tooling) reaches the team room."""
    hive = client.app.state.hive
    person(client, "u_ann")
    sw, _ = make_swarm_and_agents(client, n=1)
    assert client.patch(f"/api/swarms/{sw['id']}", json={"name": "Patswarm"}).status_code == 200
    assert team(client, sw["id"])["name"] == "Patswarm room"
    hive.db.execute("UPDATE swarms SET owner = 'user:u_ann' WHERE id = ?", (sw["id"],))
    hive.rooms.sync_teams()
    r = team(client, sw["id"])
    assert r["owner"] == "user:u_ann" and "user:u_ann" in members(client, r["id"])


def test_reading_the_swarm_room_again_announces_nothing(client, monkeypatch):
    """K3: a no-op read emits no room event."""
    hive = client.app.state.hive
    sw, _ = make_swarm_and_agents(client, n=1)
    client.post(f"/api/swarms/{sw['id']}/room")
    seen = []
    monkeypatch.setattr(hive.rooms, "_event", lambda room_id, what: seen.append((room_id, what)))
    client.post(f"/api/swarms/{sw['id']}/room")
    client.post(f"/api/swarms/{sw['id']}/room")
    assert seen == []


def test_a_roster_cut_at_the_member_limit_is_logged(client, monkeypatch, caplog):
    """K6: minds left out by MAX_MEMBERS are named in a warning."""
    import logging
    from hive.core import rooms as rooms_mod
    monkeypatch.setattr(rooms_mod, "MAX_MEMBERS", 2)
    with caplog.at_level(logging.WARNING, logger="hive"):
        sw, _ = make_swarm_and_agents(client, n=3)
    assert len(members(client, team(client, sw["id"])["id"])) == 2
    assert any("member limit" in r.getMessage() and sw["id"] in r.getMessage() for r in caplog.records)


def test_the_team_room_cannot_be_reshaped_or_hand_managed(client):
    """The invariant (private, the swarm's owner and minds) holds through the room API, as for the Coffee Room."""
    sw, (a, b) = make_swarm_and_agents(client)
    _, (c,) = make_swarm_and_agents(client, n=1)
    rid = team(client, sw["id"])["id"]
    for change in ({"visibility": "public"}, {"settings": {"minds_follow": True}}, {"settings": {"turn_cap": 9}},
                   {"kind": "channel"}, {"name": "Other"}, {"swarm_id": None}):
        assert client.patch(f"/api/rooms/{rid}", json=change).status_code == 400, change
    assert client.post(f"/api/rooms/{rid}/members", json={"members": [f"agent:{c['id']}"]}).status_code == 400
    assert client.delete(f"/api/rooms/{rid}/members/agent:{a['id']}").status_code == 400
    assert client.post(f"/api/rooms/{rid}/swarm", json={}).status_code in (400, 409)
    assert client.patch(f"/api/rooms/{rid}", json={"topic": "Shipping s2 this week"}).status_code == 200
    r = team(client, sw["id"])
    assert r["visibility"] == "private" and r["kind"] == "group" and json.loads(r["settings"]) == {}
    assert members(client, rid) == {"user:operator", f"agent:{a['id']}", f"agent:{b['id']}"}


# ---- r3: review findings (stand-in R1-R4 on a9d05e3, Kimi K1-K6) -----------------------------------------------------

def test_a_direct_message_can_never_land_in_a_team_room(client):
    """Stand-in R1: the direct-message route refuses a team room (alias or id); the room post path is the only way in."""
    hive, ann, bob, sw, a = _shared_swarm(client)
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (a["id"],))      # Bob may see the mind
    r = team(client, sw["id"])
    for conv in (r["alias"], r["id"]):
        for headers in (bob, ann, None):
            out = client.post(f"/api/agents/{a['id']}/messages", **({"headers": headers} if headers else {}),
                              json={"text": "injected", "conversation_id": conv})
            assert out.status_code == 400, (conv, headers)
    assert hive.db.one("SELECT COUNT(*) AS n FROM room_messages WHERE room_id = ?", (r["id"],))["n"] == 0
    assert client.post(f"/api/agents/{a['id']}/messages", json={"text": "plain chat"}).status_code == 200   # classic chat still works


def test_a_mind_leaving_a_retired_swarm_leaves_its_team_room(client):
    """Stand-in R2: a retired swarm's room keeps its history but still loses minds that moved away or were deleted."""
    hive = client.app.state.hive
    sw, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Next"}).json()
    rid = team(client, sw["id"])["id"]
    client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "kept"})
    assert client.post(f"/api/swarms/{sw['id']}/archive").status_code == 200
    assert client.patch(f"/api/agents/{a['id']}", json={"swarm_id": other["id"]}).status_code == 200
    hive.rooms.sync_teams()
    assert f"agent:{a['id']}" not in members(client, rid) and f"agent:{b['id']}" in members(client, rid)
    assert client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "still here?"}).status_code == 404
    assert [m["text"] for m in client.get(f"/api/rooms/{rid}/messages").json()] == ["kept"]           # history kept
    assert len(team_rooms(client, sw["id"])) == 1 and team(client, sw["id"])["archived"] == 0


def test_a_delivery_in_flight_skips_a_mind_that_lost_its_place(client, monkeypatch):
    """Stand-in R3: membership is re-checked, under the team lock, just before each mind is sent the message."""
    hive = client.app.state.hive
    sw, (a, b, c) = make_swarm_and_agents(client, n=3)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    rid = team(client, sw["id"])["id"]
    real = hive.send_to_agent
    calls = []
    async def racing(agent_id, *args, **kw):
        calls.append(agent_id)
        if len(calls) == 1:     # while the first mind is being sent to, the second one moves away
            hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (other["id"], c["id"]))
        return await real(agent_id, *args, **kw)
    monkeypatch.setattr(hive, "send_to_agent", racing)
    out = client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "@Dot1 @Dot2 status?"}).json()
    assert out["delivered_to"] == [f"agent:{b['id']}"] and inbox(client, c) == []
    # the same for an ordinary room: a member removed mid-delivery is skipped, never sent history from the start
    g = client.post("/api/rooms", json={"kind": "group", "name": "G", "members": [f"agent:{b['id']}", f"agent:{c['id']}"]}).json()
    calls.clear()
    async def removing(agent_id, *args, **kw):
        calls.append(agent_id)
        if len(calls) == 1:
            hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (g["id"], f"agent:{c['id']}"))
        return await real(agent_id, *args, **kw)
    monkeypatch.setattr(hive, "send_to_agent", removing)
    out = client.post(f"/api/rooms/{g['id']}/messages", json={"text": "@Dot1 @Dot2 hello"}).json()
    assert out["delivered_to"] == [f"agent:{b['id']}"] and inbox(client, c) == []


def test_ids_and_names_resolve_together_once_per_at_in_text_order(client):
    """Stand-in R4: an @id names that mind only (even if another's name is that id); results follow the text."""
    hive = client.app.state.hive
    _, (a, b) = make_swarm_and_agents(client, n=2)
    hive.db.execute("UPDATE agents SET name = ? WHERE id = ?", (a["id"], b["id"]))          # B is named after A's id
    g = client.post("/api/rooms", json={"kind": "group", "name": "Ids", "members": [f"agent:{a['id']}", f"agent:{b['id']}"]}).json()
    found = lambda text: hive.rooms.mentions(g["id"], text)
    assert found(f"@{a['id']} look") == [f"agent:{a['id']}"]
    assert found(f"@{b['id']} then @{a['id']}") == [f"agent:{b['id']}", f"agent:{a['id']}"]
    assert found(f"@{a['id']}, @{a['id']}") == [f"agent:{a['id']}"]


def test_the_older_swarm_room_never_admits_a_viewer_who_only_sees_the_swarm(client):
    """Kimi K1: swarms with an older bound channel get the same rule: seeing the swarm is not membership."""
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    ch = client.post("/api/rooms", headers=ann, json={"kind": "channel", "name": "Lab chat"}).json()
    out = client.post(f"/api/rooms/{ch['id']}/swarm", headers=ann, json={}).json()
    sw = out["swarm"]
    hive.visibility.set("swarms", sw["id"], __import__("hive.core.visibility", fromlist=["Viewer"]).Viewer("user:operator", True),
                        "shared", ["user:u_bob"])
    assert client.get(f"/api/swarms/{sw['id']}", headers=bob).status_code == 200
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=bob).status_code == 404
    assert "user:u_bob" not in members(client, ch["id"])
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=ann).json()["id"] == ch["id"]


def test_a_wedged_or_archived_team_room_shows_in_health_and_logs_once(client, caplog):
    """Kimi K2 / K3: a squatted alias or a hand-archived team room is a health issue for the swarm's minds, logged once."""
    import logging
    hive = client.app.state.hive
    sw, (a,) = make_swarm_and_agents(client, n=1)
    ann = person(client, "u_ann")
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Squat"}).json()
    hive.db.execute("UPDATE rooms SET archived = 1 WHERE id = ?", (team(client, sw["id"])["id"],))
    sw2, (b,) = make_swarm_and_agents(client, n=1)
    hive.db.execute("DELETE FROM rooms WHERE id = ?", (team(client, sw2["id"])["id"],))
    hive.db.execute("UPDATE rooms SET alias = ? WHERE id = ?", (f"team_{sw2['id']}", g["id"]))
    with caplog.at_level(logging.WARNING, logger="hive"):
        hive.rooms.sync_teams()
        hive.rooms.sync_teams()
    kinds = lambda agent: {i["kind"] for i in client.get("/api/health").json()["minds"] if i["id"] == agent["id"] for i in i["issues"]}
    assert "team-room" in kinds(a) and "team-room" in kinds(b)
    for sid in (sw["id"], sw2["id"]):
        assert sum(sid in r.getMessage() for r in caplog.records) == 1, sid
    fine, _ = make_swarm_and_agents(client, n=1)
    assert all("team-room" not in kinds(m) for m in (_[0],))


def test_the_coordinator_is_kept_when_the_roster_is_cut(client, monkeypatch):
    """Kimi K5: owner, then the coordinator, then the rest."""
    from hive.core import rooms as rooms_mod
    hive = client.app.state.hive
    sw, minds = make_swarm_and_agents(client, n=3)
    last = max(minds, key=lambda m: m["id"])
    client.patch(f"/api/swarms/{sw['id']}", json={"coordinator_id": last["id"]})
    monkeypatch.setattr(rooms_mod, "MAX_MEMBERS", 2)
    hive.db.execute("DELETE FROM room_members WHERE room_id = ?", (team(client, sw["id"])["id"],))
    hive.rooms.sync_teams()
    assert members(client, team(client, sw["id"])["id"]) == {"user:operator", f"agent:{last['id']}"}


def test_reading_an_older_swarm_room_again_announces_nothing(client, monkeypatch):
    """Kimi K6: the older-channel branch, like the team branch, emits no event on a read that changes nothing."""
    hive = client.app.state.hive
    _, (a,) = make_swarm_and_agents(client, n=1)
    ch = client.post("/api/rooms", json={"kind": "channel", "name": "Old chat", "members": [f"agent:{a['id']}"]}).json()
    sw = client.post(f"/api/rooms/{ch['id']}/swarm", json={"move_minds": [a["id"]]}).json()["swarm"]
    client.post(f"/api/swarms/{sw['id']}/room")
    seen = []
    monkeypatch.setattr(hive.rooms, "_event", lambda room_id, what: seen.append((room_id, what)))
    assert client.post(f"/api/swarms/{sw['id']}/room").json()["id"] == ch["id"]
    assert seen == []


# ---- r4: review findings (stand-in P1 on c50e9e2, Kimi r3 K1-K5) ----------------------------------------------------

def test_a_move_racing_the_enqueue_waits_until_the_delivery_is_stored(client):
    """Stand-in r3 P1: the eligibility check and the stored message are one database transaction, so a move or delete
    of the recipient lands wholly before (the mind is skipped) or wholly after (it was still a member when sent)."""
    import threading
    hive = client.app.state.hive
    sw, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Away"}).json()
    rid = team(client, sw["id"])["id"]
    real = hive.enqueue_message
    seen = {}
    def enqueue(agent_id, *args, **kw):
        if agent_id == b["id"] and "moved_first" not in seen:
            mover = threading.Thread(target=hive.db.execute, args=("UPDATE agents SET swarm_id = ? WHERE id = ?", (other["id"], b["id"])))
            mover.start()
            mover.join(0.3)
            seen["moved_first"] = not mover.is_alive()     # the move committed inside the check-to-store window
            seen["mover"] = mover
        return real(agent_id, *args, **kw)
    hive.enqueue_message = enqueue
    try:
        out = client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "@Dot1 secret plan"}).json()
    finally:
        hive.enqueue_message = real
        seen.get("mover") and seen["mover"].join(5)
    stored = [m for m in inbox(client, b) if m.get("text") == "@Dot1 secret plan"]
    assert not (seen.get("moved_first") and stored), "the moved mind was sent the team's text after it left"
    assert seen.get("moved_first") is False and out["delivered_to"] == [f"agent:{b['id']}"]


def test_creating_and_deleting_a_mind_keeps_the_team_room_with_no_hand_sync(client):
    """Kimi r3 K1 (checked: already true through finish_agent and finish_mind_cleanup); pinned through the API only."""
    sw, (a,) = make_swarm_and_agents(client, n=1)
    rid = team(client, sw["id"])["id"]
    b = client.post("/api/agents", json={"name": "New", "swarm_id": sw["id"]}).json()
    assert f"agent:{b['id']}" in members(client, rid)
    assert client.delete(f"/api/agents/{a['id']}").status_code == 200
    assert f"agent:{a['id']}" not in members(client, rid)
    assert client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "x"}).status_code in (401, 404)


def test_an_admin_repairs_a_wedged_team_room_and_a_new_wedge_is_logged_again(client, caplog):
    """Kimi r3 K2: the Health advice names a real remedy (an admin repair), the issue clears, and a re-wedge logs again."""
    import logging
    hive = client.app.state.hive
    sw, (a,) = make_swarm_and_agents(client, n=1)
    ann = person(client, "u_ann")
    kinds = lambda: {i["kind"] for m in client.get("/api/health").json()["minds"] if m["id"] == a["id"] for i in m["issues"]}
    hint = lambda: next(i["hint"] for m in client.get("/api/health").json()["minds"] if m["id"] == a["id"]
                        for i in m["issues"] if i["kind"] == "team-room")
    old = team(client, sw["id"])["id"]
    with caplog.at_level(logging.WARNING, logger="hive"):
        hive.db.execute("UPDATE rooms SET archived = 1 WHERE id = ?", (old,))
        hive.rooms.sync_teams()
        assert "team-room" in kinds() and "repair" in hint().lower() and "unarchive the team room" not in hint().lower()
        assert client.post(f"/api/swarms/{sw['id']}/team-room/repair", headers=ann).status_code in (403, 404)   # admins only
        fixed = client.post(f"/api/swarms/{sw['id']}/team-room/repair").json()
        assert fixed["id"] == old and f"agent:{a['id']}" in {m["member"] for m in fixed["members"]}      # history kept
        assert "team-room" not in kinds()
        hive.db.execute("UPDATE rooms SET archived = 1 WHERE id = ?", (old,))
        hive.rooms.sync_teams()
    assert sum(sw["id"] in r.getMessage() and "archived by hand" in r.getMessage() for r in caplog.records) == 2
    # a squatter: the repair frees the alias from it (it keeps its own members and history) and makes the team room
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Squat"}).json()
    hive.db.execute("DELETE FROM rooms WHERE id = ?", (old,))
    hive.db.execute("UPDATE rooms SET alias = ? WHERE id = ?", (f"team_{sw['id']}", g["id"]))
    hive.rooms.sync_teams()
    assert "team-room" in kinds()
    made = client.post(f"/api/swarms/{sw['id']}/team-room/repair").json()
    assert made["id"] != g["id"] and team(client, sw["id"])["id"] == made["id"] and "team-room" not in kinds()
    assert hive.db.one("SELECT alias FROM rooms WHERE id = ?", (g["id"],))["alias"] is None and members(client, g["id"]) == {"user:u_ann"}


def test_an_admin_joining_through_the_swarm_room_is_one_locked_change(client, monkeypatch):
    """Kimi r3 K3: the join re-checks and adds under the team lock, and announces once."""
    hive = client.app.state.hive
    admin = person(client, "u_boss", role="admin")
    sw, _ = make_swarm_and_agents(client, n=1)
    rid = team(client, sw["id"])["id"]
    held = []
    real_add = hive.rooms._add
    def add(room_id, member, role="member"):
        held.append(hive.rooms._team_lock.locked())
        return real_add(room_id, member, role)
    monkeypatch.setattr(hive.rooms, "_add", add)
    seen = []
    monkeypatch.setattr(hive.rooms, "_event", lambda room_id, what: seen.append(what))
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=admin).json()["id"] == rid
    assert held == [True] and seen == ["members"]
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=admin).status_code == 200 and seen == ["members"]


def test_the_older_swarm_channel_never_takes_in_a_mind_its_owner_may_not_see(client):
    """Kimi r3 K4: the older-channel branch adds only minds the swarm's owner may see, as the team room does."""
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    ch = client.post("/api/rooms", headers=ann, json={"kind": "channel", "name": "Lab chat"}).json()
    sw = client.post(f"/api/rooms/{ch['id']}/swarm", headers=ann, json={}).json()["swarm"]
    mine = client.post("/api/agents", json={"name": "Hers", "swarm_id": sw["id"]}).json()
    hidden = client.post("/api/agents", json={"name": "Bobs", "swarm_id": sw["id"]}).json()
    hive.db.execute("UPDATE agents SET owner = 'user:u_ann' WHERE id = ?", (mine["id"],))
    hive.db.execute("UPDATE agents SET owner = 'user:u_bob', visibility = 'private' WHERE id = ?", (hidden["id"],))
    room = client.post(f"/api/swarms/{sw['id']}/room", headers=ann).json()
    got = {m["member"] for m in room["members"]}
    assert room["id"] == ch["id"] and f"agent:{mine['id']}" in got and f"agent:{hidden['id']}" not in got


def test_a_mind_hidden_from_the_owner_mid_delivery_is_not_sent_the_message(client, monkeypatch):
    """Kimi r3 K5: the delivery fence re-checks that the swarm's owner may still see the mind, as the sync does."""
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    a, b, c = (client.post("/api/agents", json={"name": f"Dot{i}", "swarm_id": sw["id"]}).json() for i in range(3))
    for m in (a, b, c):
        hive.db.execute("UPDATE agents SET owner = 'user:u_ann' WHERE id = ?", (m["id"],))
    hive.rooms.sync_teams()
    rid = team(client, sw["id"])["id"]
    assert members(client, rid) >= {f"agent:{m['id']}" for m in (a, b, c)}
    real = hive.send_to_agent
    calls = []
    async def hiding(agent_id, *args, **kw):
        calls.append(agent_id)
        if len(calls) == 1:     # while Dot1 is being sent to, Dot2 becomes Bob's private mind
            hive.db.execute("UPDATE agents SET owner = 'user:u_bob', visibility = 'private' WHERE id = ?", (c["id"],))
        return await real(agent_id, *args, **kw)
    monkeypatch.setattr(hive, "send_to_agent", hiding)
    out = client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "@Dot1 @Dot2 plan"}).json()
    assert out["delivered_to"] == [f"agent:{b['id']}"] and inbox(client, c) == []


# ---- r5: review findings (stand-in r4 P1, Kimi r4 K1-K3) ------------------------------------------------------------

def test_a_moved_mind_loses_its_old_team_seat_in_the_same_commit_as_the_move(client, monkeypatch):
    """Stand-in r4 P1: paused after the committed move and before any sync, the mind can no longer list, post in or be
    counted a member of its former team room (and the same for a delete)."""
    hive = client.app.state.hive
    sw, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Away"}).json()
    rid = team(client, sw["id"])["id"]
    client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(b), json={"text": "private plan"})
    monkeypatch.setattr(hive, "_coffee_sync", lambda strict=False: None)     # no membership sync runs after the move
    monkeypatch.setattr(hive, "_team_sync", lambda swarm_id=None: None)
    assert client.patch(f"/api/agents/{a['id']}", json={"swarm_id": other["id"]}).status_code == 200
    assert f"agent:{a['id']}" not in members(client, rid)
    assert rid not in [r["id"] for r in client.get("/api/agent/rooms", headers=agent_headers(a)).json()]
    assert client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "@Dot1 hi"}).status_code == 404
    assert [m["text"] for m in client.get(f"/api/rooms/{rid}/messages").json()] == ["private plan"]
    hive.delete_agent(b["id"])
    assert f"agent:{b['id']}" not in members(client, rid)


def test_a_wedged_team_room_never_makes_a_fallback_channel(client):
    """Kimi r4 K1: while the team room is archived or its alias taken, the swarm-room button refuses (409, naming the
    repair) instead of making a channel shared like the swarm; after the repair it opens the team room."""
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Lab", "visibility": "shared", "shared_with": ["user:u_bob"]}).json()
    rid = team(client, sw["id"])["id"]
    hive.db.execute("UPDATE rooms SET archived = 1 WHERE id = ?", (rid,))
    before = hive.db.one("SELECT COUNT(*) AS n FROM rooms WHERE swarm_id = ?", (sw["id"],))["n"]
    out = client.post(f"/api/swarms/{sw['id']}/room", headers=ann)
    assert out.status_code == 409 and "repair" in out.json()["error"]["message"].lower()
    assert hive.db.one("SELECT COUNT(*) AS n FROM rooms WHERE swarm_id = ?", (sw["id"],))["n"] == before
    assert client.post(f"/api/swarms/{sw['id']}/team-room/repair").status_code == 200
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=ann).json()["id"] == rid
    assert client.post(f"/api/swarms/{sw['id']}/room", headers=bob).status_code == 404


def test_a_repaired_squatter_is_no_longer_bound_to_the_swarm(client):
    """Kimi r4 K2: the squatter gives up the alias and the swarm link; it stays an ordinary group with its members."""
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    sw, (a,) = make_swarm_and_agents(client, n=1)
    sw2, (b,) = make_swarm_and_agents(client, n=1)
    g = client.post("/api/rooms", headers=ann, json={"kind": "group", "name": "Squat"}).json()
    hive.db.execute("DELETE FROM rooms WHERE id = ?", (team(client, sw["id"])["id"],))
    # the squatter holds sw's alias but is bound to sw2, older than sw2's own team room
    hive.db.execute("UPDATE rooms SET alias = ?, swarm_id = ?, created_at = '2000-01-01' WHERE id = ?",
                    (f"team_{sw['id']}", sw2["id"], g["id"]))
    made = client.post(f"/api/swarms/{sw['id']}/team-room/repair").json()
    row = hive.db.one("SELECT alias, swarm_id, archived FROM rooms WHERE id = ?", (g["id"],))
    assert row == {"alias": None, "swarm_id": None, "archived": 0} and members(client, g["id"]) == {"user:u_ann"}
    assert client.post(f"/api/swarms/{sw['id']}/room").json()["id"] == made["id"]          # the button opens the team room
    assert client.post(f"/api/swarms/{sw2['id']}/room").json()["id"] == team(client, sw2["id"])["id"]   # not the ex-squatter
    assert f"agent:{b['id']}" not in members(client, g["id"])


# ---- r6: authorise and write atomically, every path (stand-in r5 P1/P2 and the class) -------------------------------
# Each test runs a revocation on a second thread at the moment the write is about to happen. Either the revocation
# waits for the write's transaction (the write was authorised and the revocation follows it) or it lands first and the
# write must not happen. Never both: revoked, then written.

def _interleave(target, revoke, when=lambda *a, **k: True):
    """Wrap target so that, the first time `when` holds, `revoke` runs on another thread just before the write."""
    import threading
    state = {}
    def wrapped(*args, **kw):
        if "first" not in state and when(*args, **kw):
            t = threading.Thread(target=revoke)
            t.start()
            t.join(0.3)
            state["first"] = not t.is_alive()        # the revocation committed inside the check-to-write window
            state["thread"] = t
        return target(*args, **kw)
    return wrapped, state


def _move(hive, agent_id, to_swarm):
    def go():
        with hive.db.transaction():                 # as update_agent moves: the move and the seat revocation, one commit
            hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (to_swarm, agent_id))
            hive.rooms.revoke_team_seats(agent_id)
    return go


def _drop(hive, room_id, member):
    return lambda: hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (room_id, member))


def _stored(hive, room_id, text):
    return hive.db.one("SELECT 1 FROM room_messages WHERE room_id = ? AND text = ?", (room_id, text)) is not None


def test_a_sync_never_restores_a_seat_revoked_while_it_ran(client, monkeypatch):
    """r5 P1: a move committing while a sync applies its roster cannot be undone by that sync."""
    hive = client.app.state.hive
    sw, (a,) = make_swarm_and_agents(client, n=1)
    other = client.post("/api/swarms", json={"name": "Away"}).json()
    rid = team(client, sw["id"])["id"]
    hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (rid, f"agent:{a['id']}"))
    wrapped, state = _interleave(hive.rooms._add, _move(hive, a["id"], other["id"]),
                                 when=lambda room_id, member, role="member": member == f"agent:{a['id']}")
    monkeypatch.setattr(hive.rooms, "_add", wrapped)
    hive.rooms.sync_team(sw["id"])
    state["thread"].join(5)
    assert state["first"] is False                                    # the move waited for the sync's transaction
    assert f"agent:{a['id']}" not in members(client, rid)            # and then revoked the seat the sync had just given


def test_a_minds_post_never_lands_after_its_seat_was_revoked(client, monkeypatch):
    """r5 P2: the mind's seat (its current swarm) and its post are one transaction."""
    hive = client.app.state.hive
    sw, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Away"}).json()
    rid = team(client, sw["id"])["id"]
    wrapped, state = _interleave(hive.rooms._append, _move(hive, a["id"], other["id"]),
                                 when=lambda room_id, sender, *x, **k: sender == f"agent:{a['id']}")
    monkeypatch.setattr(hive.rooms, "_append", wrapped)
    client.post(f"/api/agent/rooms/{rid}/messages", headers=agent_headers(a), json={"text": "post during a move"})
    state["thread"].join(5)
    assert not (state["first"] and _stored(hive, rid, "post during a move"))
    assert state["first"] is False


def test_a_persons_post_never_lands_after_their_seat_was_revoked(client, monkeypatch):
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    g = client.post("/api/rooms", json={"kind": "group", "name": "G", "members": ["user:u_ann"]}).json()
    wrapped, state = _interleave(hive.rooms._append, _drop(hive, g["id"], "user:u_ann"),
                                 when=lambda room_id, sender, *x, **k: sender == "user:u_ann")
    monkeypatch.setattr(hive.rooms, "_append", wrapped)
    client.post(f"/api/rooms/{g['id']}/messages", headers=ann, json={"text": "said while removed"})
    state["thread"].join(5)
    assert not (state["first"] and _stored(hive, g["id"], "said while removed")) and state["first"] is False


def test_a_coffee_note_never_lands_after_its_seat_was_revoked(client, monkeypatch):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Pub", "visibility": "public"}).json()
    a = client.post("/api/agents", json={"name": "Pub0", "swarm_id": sw["id"], "visibility": "public"}).json()
    coffee = client.get("/api/rooms/coffee").json()["id"]
    hive.db.execute("UPDATE agents SET status = 'awake' WHERE id = ?", (a["id"],))
    wrapped, state = _interleave(hive.rooms._append, _drop(hive, coffee, f"agent:{a['id']}"),
                                 when=lambda room_id, sender, *x, **k: sender == f"agent:{a['id']}")
    monkeypatch.setattr(hive.rooms, "_append", wrapped)
    monkeypatch.setattr(hive.rooms, "_coffee_fresh", lambda room_id: hive.rooms.row(coffee))   # no re-sync re-adds it
    client.post("/api/agent/rooms/coffee/messages", headers=agent_headers(a), json={"text": "note while removed", "note": True})
    state["thread"].join(5)
    assert not (state["first"] and _stored(hive, coffee, "note while removed")) and state["first"] is False


def test_a_mirrored_message_never_lands_after_the_minds_seat_was_revoked(client, monkeypatch):
    hive = client.app.state.hive
    _, (a,) = make_swarm_and_agents(client, n=1)
    dm = hive.rooms.legacy_dm(a["id"])
    wrapped, state = _interleave(hive.rooms._append, _drop(hive, dm["id"], f"agent:{a['id']}"),
                                 when=lambda room_id, *x, **k: room_id == dm["id"])
    monkeypatch.setattr(hive.rooms, "_append", wrapped)
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "mirrored while removed"})
    state["thread"].join(5)
    assert not (state["first"] and _stored(hive, dm["id"], "mirrored while removed")) and state["first"] is False


def test_a_coffee_sync_never_adds_a_mind_made_private_while_it_ran(client, monkeypatch):
    """The same class in the Coffee Room's sync: the roster it read and the seats it adds are one transaction."""
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Pub", "visibility": "public"}).json()
    a = client.post("/api/agents", json={"name": "Pub0", "swarm_id": sw["id"], "visibility": "public"}).json()
    coffee = client.get("/api/rooms/coffee").json()["id"]
    hive.db.execute("DELETE FROM room_members WHERE room_id = ? AND member = ?", (coffee, f"agent:{a['id']}"))
    hide = lambda: hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = ?", (a["id"],))
    wrapped, state = _interleave(hive.rooms._add, hide, when=lambda room_id, member, role="member": member == f"agent:{a['id']}")
    monkeypatch.setattr(hive.rooms, "_add", wrapped)
    hive.rooms.sync_coffee()
    state["thread"].join(5)
    assert state["first"] is False      # the visibility change waited for the sync; the next sync removes the mind
    monkeypatch.undo()
    hive.rooms.sync_coffee()
    assert f"agent:{a['id']}" not in members(client, coffee)


# ---- host-wording r1: a swarm's room is never called a team; stored rooms are shown in the new words, never rewritten ----

def test_a_new_swarm_room_is_named_and_described_in_swarm_words(client):
    sw, _ = make_swarm_and_agents(client, n=1)
    r = team(client, sw["id"])
    assert r["name"] == f"{sw['name']} room"[:80]
    assert r["topic"] == "Your swarm's own room: minds reach each other here with @Name."


def test_a_stored_team_named_room_is_shown_as_a_room_and_left_as_stored(client):
    hive = client.app.state.hive
    sw, (a,) = make_swarm_and_agents(client, n=1)
    rid = team(client, sw["id"])["id"]
    old_name, old_topic = f"{sw['name']} team"[:80], "Your swarm's team room: minds reach each other here with @Name."
    hive.db.execute("UPDATE rooms SET name = ?, topic = ? WHERE id = ?", (old_name, old_topic, rid))   # as made before r1
    hive.rooms.sync_teams()                                  # the sync takes the old name as current: nothing rewritten
    stored = hive.db.one("SELECT name, topic FROM rooms WHERE id = ?", (rid,))
    assert (stored["name"], stored["topic"]) == (old_name, old_topic)
    shown = next(r for r in client.get("/api/rooms").json() if r["id"] == rid)
    assert shown["name"] == f"{sw['name']} room"[:80]
    assert shown["topic"] == "Your swarm's own room: minds reach each other here with @Name."
    mine = hive.rooms.agent_rooms(a["id"])
    assert [(r["name"], r["topic"]) for r in mine if r["id"] == rid] == [(shown["name"], shown["topic"])]
    # a topic its owner wrote is shown as written; the swarm renamed takes the new form in storage
    hive.db.execute("UPDATE rooms SET topic = ? WHERE id = ?", ("our team plans here", rid))
    assert next(r for r in client.get("/api/rooms").json() if r["id"] == rid)["topic"] == "our team plans here"
    assert client.patch(f"/api/swarms/{sw['id']}", json={"name": "Renamed"}).status_code == 200
    assert hive.db.one("SELECT name FROM rooms WHERE id = ?", (rid,))["name"] == "Renamed room"


def test_only_a_swarms_own_room_is_relabelled(client):
    g = client.post("/api/rooms", json={"kind": "group", "name": "Blue team", "topic": "Your swarm's team room: minds reach each other here with @Name."}).json()
    shown = next(r for r in client.get("/api/rooms").json() if r["id"] == g["id"])
    assert shown["name"] == "Blue team" and shown["topic"].startswith("Your swarm's team room")
