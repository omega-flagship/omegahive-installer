"""Candidate (Studio picker, Surface slice 1): GET /api/swarms/{id}/artifacts lists exact references, metadata only,
to a viewer who sees the swarm. Invented swarms, minds and bodies only; disposable host."""
from hive.tests.test_collab import call, mind
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def test_lists_latest_exact_revisions_of_the_swarms_own_artifacts_without_bodies(client):
    ann, bob = person(client, "u_pick_ann"), person(client, "u_pick_bob")
    mine = client.post("/api/swarms", headers=ann, json={"name": "Invented studio"}).json()
    other = client.post("/api/swarms", json={"name": "Invented other"}).json()
    maker = client.post("/api/agents", headers=ann, json={"name": "Maker", "kind": "module", "swarm_id": mine["id"]}).json()
    stranger = mind(client, other, "Stranger")
    scene = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "scene", "title": "Poster"}).json()
    r1 = call(client, maker, "POST", f"/api/agent/artifacts/{scene['id']}/revisions", {"body": "SECRET-1", "parent": None}).json()
    r2 = call(client, maker, "POST", f"/api/agent/artifacts/{scene['id']}/revisions", {"body": "SECRET-2", "parent": 1}).json()
    deck = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "deck", "title": "Pitch"}).json()
    call(client, maker, "POST", f"/api/agent/artifacts/{deck['id']}/revisions", {"body": "SECRET-3", "parent": None})
    call(client, maker, "POST", "/api/agent/artifacts", {"kind": "scene", "title": "No revision yet"})   # not listed: nothing exact to name
    theirs = call(client, stranger, "POST", "/api/agent/artifacts", {"kind": "scene", "title": "Theirs"}).json()
    call(client, stranger, "POST", f"/api/agent/artifacts/{theirs['id']}/revisions", {"body": "OTHER", "parent": None})

    got = client.get(f"/api/swarms/{mine['id']}/artifacts", headers=ann)
    assert got.status_code == 200, got.text
    rows = got.json()
    assert "SECRET" not in got.text and "OTHER" not in got.text and theirs["id"] not in got.text
    assert {r["artifact_id"] for r in rows} == {scene["id"], deck["id"]}
    poster = next(r for r in rows if r["artifact_id"] == scene["id"])
    assert set(poster) == {"artifact_id", "kind", "title", "revision", "digest", "created_at", "revised_at"}
    assert poster["revision"] == 2 and poster["digest"] == r2["digest"] != r1["digest"]
    assert [r["artifact_id"] for r in client.get(f"/api/swarms/{mine['id']}/artifacts?kind=deck", headers=ann).json()] == [deck["id"]]
    assert len(client.get(f"/api/swarms/{mine['id']}/artifacts?limit=1", headers=ann).json()) == 1

    # a person who cannot see the swarm learns nothing, not even that it exists
    assert client.get(f"/api/swarms/{mine['id']}/artifacts", headers=bob).status_code == 404
    assert client.get("/api/swarms/s_nope/artifacts", headers=ann).status_code == 404


def test_the_artifacts_page_lists_every_artifact_of_the_swarms_a_person_sees_saved_or_not(client):
    """GET /api/artifacts: what a mind made in a swarm the person sees, newest first, including one with nothing saved
    yet (the picker above leaves those out). Metadata only; the maker is named only while it is a mind the person sees."""
    ann, bob = person(client, "u_area_ann"), person(client, "u_area_bob")
    mine = client.post("/api/swarms", headers=ann, json={"name": "Invented trips"}).json()
    other = client.post("/api/swarms", json={"name": "Invented elsewhere"}).json()
    maker = client.post("/api/agents", headers=ann, json={"name": "Juniper", "kind": "module", "swarm_id": mine["id"]}).json()
    helper = client.post("/api/agents", headers=ann, json={"name": "Wren", "kind": "module", "swarm_id": mine["id"]}).json()
    stranger = mind(client, other, "Stranger")
    plan = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Walk by the river"}).json()
    deck = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "deck", "title": "Pitch"}).json()
    note = call(client, helper, "POST", "/api/agent/artifacts", {"kind": "note", "title": "Packing list"}).json()
    r1 = call(client, maker, "POST", f"/api/agent/artifacts/{deck['id']}/revisions", {"body": "SECRET-1", "parent": None}).json()
    theirs = call(client, stranger, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Theirs"}).json()
    assert client.delete(f"/api/agents/{helper['id']}").status_code == 200
    # timestamps are to the millisecond and these calls often share one: give each event its own known time, so
    # "newest first" has one right answer (plan made, then deck made, then note made, then deck saved)
    db = client.app.state.hive.db
    for art, stamp in ((plan, "2026-11-11T09:00:00.000Z"), (deck, "2026-11-11T09:00:01.000Z"),
                       (note, "2026-11-11T09:00:02.000Z")):
        db.execute("UPDATE artifacts SET created_at = ? WHERE id = ?", (stamp, art["id"]))
    db.execute("UPDATE artifact_revisions SET created_at = ? WHERE artifact_id = ?", ("2026-11-11T09:00:03.000Z", deck["id"]))

    got = client.get("/api/artifacts", headers=ann)
    assert got.status_code == 200, got.text
    rows = got.json()
    assert "SECRET" not in got.text and theirs["id"] not in got.text
    assert [r["artifact_id"] for r in rows] == [deck["id"], note["id"], plan["id"]]   # newest first: saved, then made
    by_id = {r["artifact_id"]: r for r in rows}
    assert set(by_id[plan["id"]]) == {"artifact_id", "kind", "title", "swarm_id", "mind_id", "revision", "digest", "created_at", "revised_at"}
    assert by_id[plan["id"]] | {"created_at": None} == {"artifact_id": plan["id"], "kind": "plan", "title": "Walk by the river",
                                                        "swarm_id": mine["id"], "mind_id": maker["id"], "revision": None,
                                                        "digest": None, "created_at": None, "revised_at": None}
    assert (by_id[deck["id"]]["revision"], by_id[deck["id"]]["digest"]) == (1, r1["digest"])
    assert by_id[note["id"]]["mind_id"] is None   # its maker was deleted: the row stays, unnamed

    assert client.get("/api/artifacts", headers=bob).json() == []                # sees neither swarm
    assert theirs["id"] in {r["artifact_id"] for r in client.get("/api/artifacts").json()}   # the operator sees every swarm
    assert len(client.get("/api/artifacts?limit=1", headers=ann).json()) == 1


def test_recent_saved_pictures_filter_before_the_limit_for_each_viewer(client):
    ann, bob = person(client, "u_picture_ann"), person(client, "u_picture_bob")
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>'
    mine = client.post("/api/swarms", headers=ann, json={"name": "Invented home"}).json()
    shared = client.post("/api/swarms", headers=ann, json={"name": "Invented work"}).json()
    other = client.post("/api/swarms", headers=bob, json={"name": "Invented other"}).json()
    maker, helper, stranger = (client.post("/api/agents", headers=who, json={
        "name": "Maker", "kind": "module", "swarm_id": swarm["id"],
    }).json() for who, swarm in ((ann, mine), (ann, shared), (bob, other)))

    def make(agent, title, *, kind="image", body=svg):
        data = {"kind": kind, "title": title}
        if body is not None:
            data["body"] = body
        response = call(client, agent, "POST", "/api/agent/artifacts", data)
        assert response.is_success, response.text
        return response.json()["id"]

    first = make(maker, "First picture")
    second = make(helper, "Second picture")
    call(client, helper, "POST", f"/api/agent/artifacts/{second}/revisions", {"body": svg, "parent": 1})
    make(maker, "No saved revision", body=None)
    make(maker, "Newer note", kind="note", body="A note.")
    theirs = make(stranger, "Private picture")
    db = client.app.state.hive.db
    for artifact_id, stamp in ((first, "2026-11-11T09:00:00Z"), (second, "2026-11-11T09:00:01Z")):
        db.execute("UPDATE artifact_revisions SET created_at = ? WHERE artifact_id = ?", (stamp, artifact_id))

    query = "/api/artifacts?kind=image&saved=true"
    got = client.get(query + "&limit=1", headers=ann)
    assert got.is_success, got.text
    assert [(row["artifact_id"], row["revision"]) for row in got.json()] == [(second, 2)]
    assert "<svg" not in got.text
    assert [row["artifact_id"] for row in client.get(query, headers=ann).json()] == [second, first]
    assert [row["artifact_id"] for row in client.get(query, headers=bob).json()] == [theirs]


def test_a_member_signed_in_with_a_password_sees_the_creations_of_a_swarm_shared_with_them(client):
    """GET /api/artifacts for a member who signed in with e-mail and password, as testers on staging do
    (omega-flagship/omegahive#69): the creations of a swarm shared with them come back."""
    made = client.post("/api/people/members", json={"email": "rui@example.test", "name": "Rui"})
    assert made.status_code == 201, made.text
    signed_in = client.post("/api/auth/login", json={"email": "rui@example.test", "password": made.json()["password"]})
    rui = {"Authorization": f"Bearer {signed_in.json()['token']}"}
    assert client.get("/api/auth/me", headers=rui).json()["kind"] == "member_password"
    principal = "user:" + made.json()["person"]["id"]
    kitchen = client.post("/api/swarms", json={"name": "Invented kitchen", "visibility": "shared", "shared_with": [principal]}).json()
    client.put(f"/api/swarms/{kitchen['id']}/visibility", json={"visibility": "shared", "shared_with": [principal]})
    cook = client.post("/api/agents", json={"name": "Cook", "kind": "module", "swarm_id": kitchen["id"]}).json()
    plan = call(client, cook, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Menu for Friday"}).json()

    got = client.get("/api/artifacts", headers=rui)
    assert got.status_code == 200, got.text
    assert [r["artifact_id"] for r in got.json()] == [plan["id"]]


def test_a_person_shown_an_artifact_reads_its_saved_text_and_no_one_else_learns_it_exists(client):
    """GET /api/artifacts/{id}/revisions/{n}: the Artifacts page's reader, for exactly the swarms GET /api/artifacts
    lists for that person. On a fresh install a saved plan's only way to open was Design, which such a hive doesn't
    offer."""
    ann, bob = person(client, "u_read_ann"), person(client, "u_read_bob")
    mine = client.post("/api/swarms", headers=ann, json={"name": "Invented trips"}).json()
    maker = client.post("/api/agents", headers=ann, json={"name": "Juniper", "kind": "module", "swarm_id": mine["id"]}).json()
    plan = call(client, maker, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Walk by the river"}).json()
    r1 = call(client, maker, "POST", f"/api/agent/artifacts/{plan['id']}/revisions", {"body": "Day 1: the north bank; lunch at the weir", "parent": None}).json()

    got = client.get(f"/api/artifacts/{plan['id']}/revisions/1", headers=ann)
    assert got.status_code == 200, got.text
    assert got.json() | {"created_at": None} == {"artifact_id": plan["id"], "kind": "plan", "title": "Walk by the river",
                                                 "swarm_id": mine["id"], "revision": 1, "digest": r1["digest"],
                                                 "body": "Day 1: the north bank; lunch at the weir", "created_at": None}
    assert client.get(f"/api/artifacts/{plan['id']}/revisions/1").status_code == 200   # the operator sees every swarm
    # one who doesn't see the swarm, a revision never saved and an artifact that doesn't exist all read as missing
    for who, path in ((bob, f"/api/artifacts/{plan['id']}/revisions/1"), (ann, f"/api/artifacts/{plan['id']}/revisions/2"),
                      (ann, "/api/artifacts/ar_nope/revisions/1")):
        missing = client.get(path, headers=who)
        assert missing.status_code == 404 and "Day 1" not in missing.text
