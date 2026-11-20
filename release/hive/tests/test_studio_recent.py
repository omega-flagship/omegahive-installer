"""Purpose: verify Studio's three recent creations with personal provenance and open targets."""

import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import _plan_row, person


ROUTE = "/api/me/studio-recent"
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>'
ALICE = "user:u_recent_alice"
BOB = "user:u_recent_bob"


def stamp(minute):
    return f"2026-11-20T10:{minute:02}:00.000Z"


def save(hive, swarm, principal, kind, title, minute, *, body="Saved design"):
    actor = {"id": "a_recent_fixture", "swarm_id": swarm}
    data = {"kind": kind, "title": title}
    if body is not None:
        data["body"] = body
    artifact = hive.collab.create_artifact(actor, data, principal=principal)
    hive.db.execute("UPDATE artifact_revisions SET created_at = ? WHERE artifact_id = ?",
                    (stamp(minute), artifact["id"]))
    return artifact


def deploy(hive, program, principal, swarm, minute, *, active=True, readback=False):
    at = stamp(minute)
    plan = f"cp_{program}"
    _plan_row(hive, plan, principal)
    receipt = {"program_id": program, "deployed": True} if readback else {"program_id": program, "installed_at": at}
    hive.db.execute("UPDATE create_plan_runs SET phase = 'deployed', installed = ? WHERE plan_id = ?",
                    (json.dumps(receipt), plan))
    if readback:
        hive.db.insert("create_plan_journal", {"plan_id": plan, "seq": 1, "obs_id": "deployed-confirmed:fixture",
                                               "kind": "deployed-confirmed", "fields": "[]", "verdict": "accepted", "at": at})
    hive.programs.programs[program] = {"id": program, "name": "Weather app", "placement": "swarm"}
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, ?, ?)", (program, swarm, int(active), principal))


def test_recent_creations_are_personal_openable_and_ranked_together(client):
    alice = person(client, "u_recent_alice")
    bob = person(client, "u_recent_bob")
    hive = client.app.state.hive
    personal = client.post("/api/swarms", headers=alice, json={"name": "Personal studio"}).json()["id"]
    hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (ALICE, personal))
    shared = client.post("/api/swarms", headers=alice, json={"name": "Shared studio",
                         "visibility": "shared", "shared_with": [BOB]}).json()["id"]
    private = client.post("/api/swarms", headers=bob, json={"name": "Private studio"}).json()["id"]

    save(hive, shared, ALICE, "image", "Older picture", 1, body=SVG)
    design = save(hive, shared, ALICE, "studio-source", "Saved poster", 2)
    deploy(hive, "weather", ALICE, shared, 3, readback=True)
    picture = save(hive, personal, "agent:a_recent_fixture", "image", "Saved invitation", 0, body=SVG)
    latest = hive.collab.add_revision({"id": "a_recent_fixture", "swarm_id": personal}, picture["id"],
                                      {"parent": 1, "body": SVG.replace('width="12"', 'width="14"')})
    hive.db.execute("UPDATE artifact_revisions SET created_at = ? WHERE artifact_id = ? AND n = 2",
                    (stamp(4), picture["id"]))
    other = save(hive, shared, BOB, "image", "Another person's picture", 5, body=SVG)
    deploy(hive, "another-app", BOB, shared, 6)
    deploy(hive, "disabled-weather", ALICE, shared, 7, active=False)
    save(hive, shared, ALICE, "image", "Unsaved draft", 8, body=None)
    save(hive, shared, ALICE, "note", "Newer note", 9)
    save(hive, private, ALICE, "studio-source", "No longer visible", 10)
    save(hive, shared, "agent:a_recent_fixture", "image", "Shared mind's picture", 11, body=SVG)

    response = client.get(ROUTE, headers=alice)
    assert response.is_success, response.text
    assert response.json() == [
        {"kind": "image", "id": picture["id"], "title": "Saved invitation", "swarm_id": personal,
         "revision": 2, "digest": latest["digest"], "at": stamp(4)},
        {"kind": "app", "id": "weather", "title": "Weather app", "swarm_id": shared, "at": stamp(3)},
        {"kind": "design", "id": design["id"], "title": "Saved poster", "swarm_id": shared,
         "revision": 1, "digest": design["digest"], "at": stamp(2)},
    ]
    opened = client.get(f"/api/artifacts/{picture['id']}/revisions/2", headers=alice)
    assert opened.is_success and opened.json()["digest"] == latest["digest"]
    assert [(r["kind"], r["id"]) for r in client.get(ROUTE, headers=bob).json()] == [
        ("app", "another-app"), ("image", other["id"]),
    ]
    assert client.get(ROUTE + "?include=personal").json() == []


def test_recent_creations_require_a_signed_in_person(client):
    assert client.get(ROUTE, headers={"Authorization": "Bearer invalid"}).status_code == 401
