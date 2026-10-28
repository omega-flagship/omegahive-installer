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
