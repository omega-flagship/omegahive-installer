"""Purpose: Jon on #334, a mind's beliefs are seen through permissions instead of passed around, and on #354, a link never
shows a belief past where the hive already lets people see its mind. A belief a public mind of a team swarm holds in its
own space reaches its swarm with no publish: another mind finds it with hive-query, and the swarm's page lists and
counts it. A person's own mind, a researcher and a private mind link nothing until their owner opts in; a person's view
holds only the swarms and minds they may see, and an admin's leaves out another person's own mind and researchers unless
it audits.
The link follows the mind out of a swarm, its owner can narrow it to some domains, and read routes never load or write:
the reconcile pass (refresh_all_beliefs, `tick` here) and a mind's own read load its last save."""

import json
import os
from pathlib import Path

import pytest

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401
from hive.tests.test_visibility import person

PETTA = os.environ.get("PETTA_PATH", str(Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
SKY = '(Belief "sky" "color" "blue" (stv 1.0 0.9) "omega")'
TEA = '(Belief "user" "likes" "green tea" (stv 0.9 0.8) "omega")'
SKY_STMT, TEA_STMT = "(--> (x sky blue) color)", '(--> (x user "green tea") likes)'


def team(client, n=2, headers=None, visibility="public"):
    """A public swarm of n minds of the given visibility, as its members' owner made them."""
    swarm = client.post("/api/swarms", headers=headers, json={"name": "Team", "visibility": "public"}).json()
    minds = [client.post("/api/agents", headers=headers, json={"name": f"Dot{i}", "swarm_id": swarm["id"],
                                                                "visibility": visibility}).json() for i in range(n)]
    return swarm, minds


def hold(client, mind, *atoms):
    """Save a mind's beliefs as its runtime does at a cycle's end: a whole file renamed over the old one."""
    memory = client.app.state.hive.settings.agents_dir / mind["id"] / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    tmp = memory / ".beliefs.metta.tmp"
    tmp.write_text("".join(f"{a}\n" for a in atoms))
    tmp.replace(memory / "beliefs.metta")


def tick(client):
    """What the reconcile pass does for beliefs: load each mind's changed save."""
    client.app.state.hive.refresh_all_beliefs()


def found(client, mind, pattern="(Current $s $t $st)"):
    r = client.post("/api/agent/query", headers=agent_headers(mind), json={"pattern": pattern})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def listed(client, swarm, headers=None, params=None):
    r = client.get(f"/api/swarms/{swarm['id']}/beliefs", headers=headers, params=params)
    return r.status_code, (r.json() if r.status_code == 200 else None)


def link(client, mind, domains, headers=None):
    r = client.put(f"/api/agents/{mind['id']}/belief-link", headers=headers, json={"domains": domains})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_belief_a_public_mind_holds_reaches_its_swarm_with_no_publish(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    assert found(client, b, "(Current (--> (x sky $v) color) $t $st)") == [
        f"(Current {SKY_STMT} (stv 1.0 0.9) ((ev {a['id']} 1)))"]
    assert found(client, b, f"(Held $m {SKY_STMT} $t $st)") == [f"(Held {a['id']} {SKY_STMT} (stv 1.0 0.9) ((ev {a['id']} 1)))"]
    status, rows = listed(client, swarm)
    assert status == 200 and [(r["statement"], r["holders"], r["sources"]) for r in rows] == [(SKY_STMT, [a["id"]], [a["id"]])]
    assert client.get("/api/hive").json()["beliefs"] >= 1
    assert client.app.state.hive.db.all("SELECT * FROM assertions") == []   # nothing was published
    detail = client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": SKY_STMT}).json()
    assert [(h["mind"], h["stamp"], h["tv"]) for h in detail["held"]] == [(a["id"], [f"ev:{a['id']}:1"], {"f": 1.0, "c": 0.9})]
    assert detail["assertions"] == []


def test_read_routes_never_load_or_write_a_minds_beliefs(client):
    hive = client.app.state.hive
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    assert listed(client, swarm)[1] == [] and client.get("/api/hive").status_code == 200
    assert hive.db.all("SELECT * FROM held_stamps") == []                    # people's reads loaded nothing
    tick(client)
    assert [r["statement"] for r in listed(client, swarm)[1]] == [SKY_STMT]


def test_a_belief_shows_for_as_long_as_its_mind_holds_it(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY, TEA)
    tick(client)
    assert {r["statement"] for r in listed(client, swarm)[1]} == {SKY_STMT, TEA_STMT}
    hold(client, a, TEA)
    tick(client)
    assert [r["statement"] for r in listed(client, swarm)[1]] == [TEA_STMT]
    assert found(client, b, "(Current (--> (x sky $v) color) $t $st)") == []


def test_the_link_follows_the_mind_out_of_its_swarm_and_away_when_deleted(client):
    hive = client.app.state.hive
    swarm, (a, b) = team(client)
    other, (c,) = team(client, 1)
    hold(client, a, SKY)
    tick(client)
    assert found(client, b) != [] and found(client, c) == []
    assert client.patch(f"/api/agents/{a['id']}", json={"swarm_id": other["id"]}).status_code == 200
    assert found(client, b) == [] and listed(client, swarm)[1] == []
    assert [r["statement"] for r in listed(client, other)[1]] == [SKY_STMT] and found(client, c) != []
    assert client.delete(f"/api/agents/{a['id']}").status_code == 200
    assert listed(client, other)[1] == [] and found(client, c) == []
    assert hive.db.all("SELECT * FROM held_stamps WHERE agent_id = ?", (a["id"],)) == []   # forgotten when it leaves


def test_a_private_mind_in_a_visible_swarm_links_nothing_until_its_owner_opts_in(client):
    """Jon on #354, P1: a private mind's beliefs reach neither its swarm's minds nor people who can't see it."""
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    swarm, (private,) = team(client, 1, headers=ann, visibility="private")
    public = client.post("/api/agents", headers=ann, json={"name": "Pub", "swarm_id": swarm["id"], "visibility": "public"}).json()
    hold(client, private, SKY)
    tick(client)
    got = client.get(f"/api/agents/{private['id']}/belief-link", headers=ann).json()
    assert got["domains"] is None and got["default"] == "none" and got["linked"] == "none" and got["patterns"] == []
    assert got["default_reason"] == "private"
    assert found(client, public) == [] and listed(client, swarm, ann)[1] == [] and listed(client, swarm, bob)[1] == []
    link(client, private, "all", headers=ann)
    assert found(client, public) != []                                   # its swarm's minds see it once opted in
    assert [r["statement"] for r in listed(client, swarm, ann)[1]] == [SKY_STMT]
    assert listed(client, swarm, bob) == (200, [])                       # bob sees the swarm, not the mind
    assert client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", headers=bob, params={"statement": SKY_STMT}).status_code == 404
    assert client.put(f"/api/agents/{private['id']}/belief-link", headers=bob, json={"domains": []}).status_code in (403, 404)


def test_a_person_who_cant_see_a_swarm_sees_none_of_its_linked_beliefs(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    swarm = client.post("/api/swarms", headers=ann, json={"name": "Ann's", "visibility": "private"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Pub", "swarm_id": swarm["id"], "visibility": "public"}).json()
    hold(client, mind, SKY)
    tick(client)
    assert [r["statement"] for r in listed(client, swarm, ann)[1]] == [SKY_STMT]   # linked, and its owner sees it
    assert client.get("/api/hive", headers=ann).json()["beliefs"] == 1
    assert listed(client, swarm, bob)[0] == 404
    assert client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", headers=bob, params={"statement": SKY_STMT}).status_code == 404
    assert client.get("/api/hive", headers=bob).json()["beliefs"] == 0


def test_only_its_owner_lets_more_of_a_minds_beliefs_be_seen(client):
    """Jon on #354, second review P1: an admin widened Ann's private mind to "all" and Bo's mind read her belief. An
    admin may narrow a mind's link, audited or not, but only its owner widens it."""
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    swarm, (private,) = team(client, 1, headers=ann, visibility="private")
    bo = client.post("/api/agents", json={"name": "Bo", "swarm_id": swarm["id"], "visibility": "public"}).json()
    hold(client, private, SKY)
    tick(client)
    for params in (None, {"include": "personal"}):
        r = client.put(f"/api/agents/{private['id']}/belief-link", params=params, json={"domains": "all"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    assert found(client, bo) == []
    got = client.get(f"/api/agents/{private['id']}/belief-link").json()
    assert got["as"] == "admin" and (got["rights"]["widen"], got["rights"]["narrow"]) == (False, True)
    assert link(client, private, "all", headers=ann)["linked"] == "all" and found(client, bo) != []
    assert link(client, private, ["sky"])["linked"] == ["sky"]                   # an admin may narrow it
    r = client.put(f"/api/agents/{private['id']}/belief-link", json={"domains": ["sky", "user"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"    # but not widen it again
    pat = person(client, "u_pat")
    own = hive.personal.ensure("user:u_pat")
    assert client.put(f"/api/agents/{own['id']}/belief-link", json={"domains": "all"}).status_code == 404
    r = client.put(f"/api/agents/{own['id']}/belief-link", params={"include": "personal"}, json={"domains": "all"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"    # another person's own mind
    assert link(client, own, "all", headers=pat)["linked"] == "all"


def test_the_topics_of_a_minds_beliefs_go_only_to_whoever_decides_its_link(client):
    """Jon on #354, second review P2: known_domains names what a mind's beliefs are about, so only someone who controls
    the mind reads it, and an admin reads another person's own mind's link only in an audit."""
    hive = client.app.state.hive
    pat = person(client, "u_pat")
    own = hive.personal.ensure("user:u_pat")
    hold(client, own, SKY)
    assert client.get(f"/api/agents/{own['id']}/belief-link").status_code == 404     # an admin, no audit
    audited = client.get(f"/api/agents/{own['id']}/belief-link", params={"include": "personal"}).json()
    assert audited["known_domains"] == ["sky"] and (audited["rights"]["widen"], audited["rights"]["narrow"]) == (False, True)
    mine = client.get(f"/api/agents/{own['id']}/belief-link", headers=pat).json()
    assert mine["known_domains"] == ["sky"] and (mine["rights"]["widen"], mine["rights"]["narrow"]) == (True, True)
    ann = person(client, "u_ann")
    _, (a,) = team(client, 1)   # a public mind of a public swarm, which ann sees but doesn't control
    hold(client, a, SKY)
    r = client.get(f"/api/agents/{a['id']}/belief-link", headers=ann)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"   # she sees it, but doesn't decide its link


def test_making_a_mind_private_drops_its_owners_widening(client):
    """Jon on #354, second review P3: an owner's "all" was chosen for a public mind's audience. Made private, the mind
    goes back to its default and links nothing until its owner opts in again; an owner's none stays."""
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    link(client, a, "all")
    assert found(client, b) != []
    assert client.put(f"/api/agents/{a['id']}/visibility", json={"visibility": "private"}).status_code == 200
    got = client.get(f"/api/agents/{a['id']}/belief-link").json()
    assert (got["domains"], got["linked"]) == (None, "none") and found(client, b) == []
    assert client.get(f"/api/agents/{a['id']}").json()["belief_link"] is None
    link(client, a, [])
    assert client.put(f"/api/agents/{a['id']}/visibility", json={"visibility": "public"}).status_code == 200
    assert client.get(f"/api/agents/{a['id']}/belief-link").json()["domains"] == []   # its owner's none stays


def test_researchers_of_different_people_never_see_each_others_beliefs(client, monkeypatch):
    """Jon on #354, P1: researchers share the Research swarm, and personal research stays with the person who asked."""
    hive = client.app.state.hive
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    research = client.post("/api/swarms", json={"name": "Research", "visibility": "public"}).json()
    ra = client.post("/api/agents", headers=ann, json={"name": "Ra", "swarm_id": research["id"], "visibility": "public"}).json()
    rb = client.post("/api/agents", headers=bob, json={"name": "Rb", "swarm_id": research["id"], "visibility": "public"}).json()
    monkeypatch.setattr(hive.research, "child_ids_all", lambda: {ra["id"], rb["id"]})
    for mind in (ra, rb):
        hive.relink_beliefs(mind["id"])
    hold(client, ra, SKY)
    tick(client)
    got = client.get(f"/api/agents/{ra['id']}/belief-link", headers=ann).json()
    assert (got["default"], got["default_reason"]) == ("none", "researcher")
    assert found(client, rb) == [] and found(client, rb, "(Held $m $s $t $st)") == []
    assert listed(client, research, bob)[1] == [] and listed(client, research)[1] == []


def test_an_admin_sees_a_persons_own_minds_beliefs_only_in_an_audit(client):
    """Jon on #354, P2: another person's own mind is kept out of an admin's views unless the admin audits."""
    hive = client.app.state.hive
    pat = person(client, "u_pat")
    own = hive.personal.ensure("user:u_pat")
    hold(client, own, SKY)
    tick(client)
    got = client.get(f"/api/agents/{own['id']}/belief-link", headers=pat).json()
    assert (got["default"], got["default_reason"]) == ("none", "personal")
    link(client, own, "all", headers=pat)
    swarm = {"id": own["swarm_id"]}
    assert [r["statement"] for r in listed(client, swarm, pat)[1]] == [SKY_STMT]       # its person sees it
    assert listed(client, swarm)[1] == []                                              # an admin, no audit
    assert [r["statement"] for r in listed(client, swarm, params={"include": "personal"})[1]] == [SKY_STMT]
    _, (c,) = team(client, 1)
    assert found(client, c, "(Held $m $s $t $st)") == [] and found(client, c) == []   # no other mind


def test_an_owner_narrows_the_link_to_domains_or_turns_it_off(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY, TEA)
    tick(client)
    first = client.get(f"/api/agents/{a['id']}/belief-link").json()
    assert (first["domains"], first["default"], first["linked"], first["known_domains"]) == (None, "all", "all", ["sky", "user"])
    assert first["default_reason"] is None
    assert client.get(f"/api/agents/{a['id']}").json()["belief_link"] is None   # its default
    narrowed = link(client, a, ["sky"])
    assert narrowed["domains"] == ["sky"] and narrowed["patterns"] == ["(--> (x sky $_0) $_1)"]
    assert client.get(f"/api/agents/{a['id']}").json()["belief_link"] == ["sky"]   # agent events carry it too
    assert [r["statement"] for r in listed(client, swarm)[1]] == [SKY_STMT]
    assert found(client, b, "(Current (--> (x user $v) likes) $t $st)") == []
    assert link(client, a, [])["patterns"] == [] and listed(client, swarm)[1] == [] and found(client, b) == []
    assert link(client, a, "all")["linked"] == "all" and len(listed(client, swarm)[1]) == 2
    assert link(client, a, None)["linked"] == "all"                       # back to its default, a public mind's
    bad = client.put(f"/api/agents/{a['id']}/belief-link", json={"domains": ['say "hi"']})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_domains"
    ann = person(client, "u_ann")
    assert client.put(f"/api/agents/{a['id']}/belief-link", headers=ann, json={"domains": []}).status_code in (403, 404)


def test_a_mind_made_private_stops_linking_by_default(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    assert found(client, b) != []
    assert client.put(f"/api/agents/{a['id']}/visibility", json={"visibility": "private"}).status_code == 200
    assert found(client, b) == []


def test_a_belief_held_after_reading_another_is_an_echo_and_one_held_before_is_evidence(client):
    """The stamp a held belief gets is fixed when the hive first sees it: a mind that read the statement first inherits
    the stamp it read, so the swarm's confidence stays; a mind that held it before reading revises it."""
    swarm, (a, b, c) = team(client, 3)
    hold(client, a, SKY)
    hold(client, c, SKY)                                   # c holds it before any read: its own evidence
    found(client, c)                                       # c's own read loads its save first, so it stays evidence
    tick(client)
    found(client, b, f"(Current {SKY_STMT} $t $st)")       # b reads, then holds the same
    hold(client, b, SKY)
    tick(client)
    detail = client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": SKY_STMT}).json()
    stamps = {h["mind"]: h["stamp"] for h in detail["held"]}
    assert stamps[c["id"]] == [f"ev:{c['id']}:1"]
    assert stamps[b["id"]] == sorted([f"ev:{a['id']}:1", f"ev:{c['id']}:1"])   # what b read: a's and c's evidence
    assert detail["stamp"] == sorted([f"ev:{a['id']}:1", f"ev:{c['id']}:1"])
    assert detail["tv"]["c"] == 0.947368                    # a and c revise; b adds nothing


def test_publishing_what_a_mind_read_from_a_linked_belief_is_an_echo_the_hive_accepts(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    found(client, b, f"(Current {SKY_STMT} $t $st)")
    echo = client.post("/api/agent/publish", headers=agent_headers(b), json={"statement": SKY_STMT, "f": 1.0, "c": 0.9})
    assert echo.status_code == 200 and echo.json()["stamp"] == [f"ev:{a['id']}:1"]
    assert [(r["tv"], r["stamp"]) for r in listed(client, swarm)[1]] == [({"f": 1.0, "c": 0.9}, [f"ev:{a['id']}:1"])]
    again = client.post("/api/agent/publish", headers=agent_headers(a), json={"statement": SKY_STMT, "f": 1.0, "c": 0.9})
    assert again.json()["stamp"] == [f"ev:{a['id']}:1"]    # a's publish of what it holds is the same evidence


def test_links_are_rebuilt_at_start_and_compaction_skips_them(client):
    hive = client.app.state.hive
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    for mind in (a, b):
        hive.spaces.link(mind["id"], swarm["id"], [])     # what a fresh interpreter holds before the host links
    assert listed(client, swarm)[1] == []
    hive.link_all()
    assert [r["statement"] for r in listed(client, swarm)[1]] == [SKY_STMT]
    hive.spaces.compact()
    assert [r["statement"] for r in listed(client, swarm)[1]] == [SKY_STMT]
    row = hive.db.one("SELECT stamp, first_seen FROM held_stamps WHERE agent_id = ?", (a["id"],))
    assert json.loads(row["stamp"]) == [f"ev:{a['id']}:1"] and row["first_seen"]


def test_the_commons_explorer_names_each_mind_holding_a_belief(client):
    swarm, (a, b) = team(client)
    hold(client, a, SKY)
    tick(client)
    focus = f"b:{SKY_STMT}"
    one = client.post("/api/programs/commons-explorer/view",
                      json={"swarm_id": swarm["id"], "focus": focus, "stage": "unfold"}).json()
    held = [i for i in one["items"] if i["kind"] == "report"]
    assert [(i["id"], i["label"], i["sources"][0]["id"]) for i in held] == [
        (f"h:{SKY_STMT}:0", f"{a['name']} holds it f=1 c=0.9", f"dot:{a['id']}")]
    assert [(x["to"], x["rel"], x["weight"]) for x in one["links"] if x["from"] == held[0]["id"]] == [(focus, "supports", 0.9)]
    opened = client.post("/api/programs/commons-explorer/act", json={
        "swarm_id": swarm["id"], "action": "inspect-source", "items": [held[0]["id"]], "base_revision": one["revision"]}).json()
    assert opened["status"] == "done" and opened["detail"]["sources"][0]["record"]["held"] is True
    detail = client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": SKY_STMT}).json()
    assert detail["held"][0]["tv"] == {"f": 1.0, "c": 0.9} and detail["held"][0]["since"]


# What each class may do with a mind's link, written out apart from Hive.LINK_RIGHTS, so a changed cell fails the test
# below: Jon's rulings on #354, and where he hasn't ruled, the closed choice (an auditing admin never widens, an admin
# without audit reads no topics, someone who only sees a mind doesn't read its setting).
RIGHTS = {
    "owner": {"read_beliefs", "read_setting", "read_topics", "narrow", "widen"},
    "admin-audit": {"read_beliefs", "read_setting", "read_topics", "narrow"},
    "admin": {"read_beliefs", "read_setting", "narrow"},
    "admin-hidden": set(),
    "sees": {"read_beliefs"},
    "unseen": set(),
}

# The class each person stands in to each kind of Ann's minds, written out apart from Hive.link_class, so the test
# below checks the classification as well as what each class may do.
CLASSES = {
    "ann": dict.fromkeys(("personal", "researcher", "private", "shared", "public"), "owner"),
    "admin": {"personal": "admin-hidden", "researcher": "admin-hidden", "private": "admin", "shared": "admin",
              "public": "admin"},
    "audit": dict.fromkeys(("personal", "researcher", "private", "shared", "public"), "admin-audit"),
    "bob": {"personal": "unseen", "researcher": "unseen", "private": "unseen", "shared": "sees", "public": "sees"},
    "cy": {"personal": "unseen", "researcher": "unseen", "private": "unseen", "shared": "unseen", "public": "sees"},
}


def test_every_cell_of_the_link_table_holds_on_the_routes(client, monkeypatch):
    """Jon on #354: who may read a mind's linked beliefs, its link setting and its topics, and narrow or widen its link,
    is one table (Hive.LINK_RIGHTS) over how the person stands to the mind. For each person and each kind of Ann's
    minds, every action is tried on its route and must be allowed exactly where the table says, refused as not found
    where the person doesn't see the mind or an admin's views hide it, and as owner_only elsewhere. Minds read through
    the read grants: a mind of the same swarm sees what the link admits, a mind of another swarm nothing."""
    hive = client.app.state.hive
    ann, bob, cy = person(client, "u_ann"), person(client, "u_bob"), person(client, "u_cy")
    team_swarm = client.post("/api/swarms", headers=ann, json={"name": "Team", "visibility": "public"}).json()
    research = client.post("/api/swarms", headers=ann, json={"name": "Research", "visibility": "public"}).json()

    def mind(name, swarm, visibility):
        return client.post("/api/agents", headers=ann, json={"name": name, "swarm_id": swarm["id"],
                                                            "visibility": visibility}).json()
    minds = {"personal": hive.personal.ensure("user:u_ann"), "researcher": mind("Res", research, "private"),
             "private": mind("Priv", team_swarm, "private"), "shared": mind("Shar", team_swarm, "private"),
             "public": mind("Pub", team_swarm, "public")}
    shared = client.put(f"/api/agents/{minds['shared']['id']}/visibility", headers=ann,
                        json={"visibility": "shared", "shared_with": ["user:u_bob"]})
    assert shared.status_code == 200, shared.text
    researcher = minds["researcher"]["id"]
    monkeypatch.setattr(hive.research, "child_ids_all", lambda: {researcher})
    monkeypatch.setattr(hive.research, "children_from", lambda swarms: {researcher})
    statements = {}
    for kind, m in minds.items():
        hold(client, m, f'(Belief "{kind}" "is" "held" (stv 1.0 0.9) "omega")')
        statements[kind] = f"(--> (x {kind} held) is)"
        hive.relink_beliefs(m["id"])
    tick(client)
    people = {"ann": (ann, None), "admin": (None, None), "audit": (None, {"include": "personal"}),
              "bob": (bob, None), "cy": (cy, None)}

    def owner_sets(m, domains):
        link(client, m, domains, headers=ann)

    for kind, m in minds.items():
        owner_sets(m, "all")
        swarm_id = hive.agent(m["id"])["swarm_id"]
        for who, (headers, params) in people.items():
            cls = CLASSES[who][kind]
            rights = RIGHTS[cls]
            refusal = 404 if cls in ("unseen", "admin-hidden") else 403
            where = f"{who} on {kind} ({cls})"
            listed_rows = client.get(f"/api/swarms/{swarm_id}/beliefs", headers=headers, params=params)
            reads = listed_rows.status_code == 200 and any(
                r["statement"] == statements[kind] and m["id"] in r["holders"] for r in listed_rows.json())
            assert reads == ("read_beliefs" in rights), where
            got = client.get(f"/api/agents/{m['id']}/belief-link", headers=headers, params=params)
            if "read_setting" in rights:
                assert got.status_code == 200 and got.json()["as"] == cls, (where, got.text)
                assert got.json()["rights"] == {a: a in rights for a in hive.LINK_ACTIONS}, where
                assert (got.json()["known_domains"] is not None) == ("read_topics" in rights), where
            else:
                assert got.status_code == refusal, (where, got.text)
            narrowed = client.put(f"/api/agents/{m['id']}/belief-link", headers=headers, params=params,
                                  json={"domains": []})
            assert narrowed.status_code == (200 if "narrow" in rights else refusal), (where, narrowed.text)
            owner_sets(m, [])
            widened = client.put(f"/api/agents/{m['id']}/belief-link", headers=headers, params=params,
                                 json={"domains": "all"})
            assert widened.status_code == (200 if "widen" in rights else refusal), (where, widened.text)
            owner_sets(m, "all")

    mo = client.post("/api/agents", json={"name": "Mo", "swarm_id": team_swarm["id"], "visibility": "public"}).json()
    elsewhere = client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()
    xo = client.post("/api/agents", json={"name": "Xo", "swarm_id": elsewhere["id"], "visibility": "public"}).json()
    for reader, sees_kinds in ((mo, {"private", "shared", "public"}), (xo, set())):
        held = " ".join(found(client, reader, "(Held $m $s $t $st)"))
        for kind, m in minds.items():
            assert (statements[kind] in held) == (kind in sees_kinds), (reader["name"], kind)
