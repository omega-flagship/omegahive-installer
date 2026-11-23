# Purpose: verify confirmed asset deletion's permissions, store failures, shared bytes, references, and upload races.
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from hive.core.visibility import Viewer
from hive.core.repomap import Caller
from hive.core.newhive import SCHEMA as SETUP_SCHEMA
from hive.tests.test_assets import cloud  # noqa: F401
from hive.tests.test_core_api import agent_headers, client  # noqa: F401
from hive.tests.test_visibility import person


def upload(client, data=b"an uploaded file", swarm=None):
    response = client.post("/api/assets", params={"swarm_id": swarm or "", "name": "notes.txt"}, content=data)
    response.raise_for_status()
    return response.json()["sha256"]


def test_delete_removes_copies_owners_and_storage_history(client, cloud):
    swarm = client.post("/api/swarms", json={"name": "Files"}).json()["id"]
    sha = upload(client, swarm=swarm)
    client.post(f"/api/assets/{sha}/transfer", json={"to": "cloud"}).raise_for_status()
    response = client.delete(f"/api/assets/{sha}")
    assert response.status_code == 200 and response.json() == {"sha256": sha, "deleted": True}
    hive = client.app.state.hive
    assert not hive.assets.stores["local"].has(sha) and not cloud.objects
    assert hive.db.one("SELECT * FROM assets WHERE sha256 = ?", (sha,)) is None
    assert hive.db.all("SELECT * FROM asset_owners WHERE sha256 = ?", (sha,)) == []
    assert client.get(f"/api/assets/{sha}").status_code == 404
    assert client.delete(f"/api/assets/{sha}").status_code == 404


@pytest.mark.parametrize("place, expected", [
    ("private", (True, False, True)),
    ("shared", (True, True, True)),
    ("public", (True, True, True)),
    ("personal", (True, False, False)),
    ("ownerless", (False, False, True)),
])
def test_delete_event_keeps_its_audience_after_the_asset_is_gone(client, place, expected):
    ann = person(client, "u_delete_event_ann", role="admin")
    hive = client.app.state.hive
    swarm = None
    if place != "ownerless":
        swarm = hive.create_swarm("Files", owner="user:u_delete_event_ann",
                                  visibility="private" if place == "personal" else place,
                                  shared_with=["user:u_delete_event_bob"] if place == "shared" else [])["id"]
        if place == "personal":
            hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", ("user:u_delete_event_ann", swarm))
    sha = hive.assets.put(b"a deleted private file", "text/plain", "user:u_delete_event_ann",
                          owner_swarm=swarm)["sha256"]
    events = []
    hive.events.listen(lambda kind, payload: events.append(dict(type=kind, **payload)))
    response = client.delete(f"/api/assets/{sha}", headers=ann)
    assert response.status_code == 200, response.text
    assert hive.db.one("SELECT * FROM assets WHERE sha256 = ?", (sha,)) is None
    assert hive.db.all("SELECT * FROM asset_owners WHERE sha256 = ?", (sha,)) == []
    deleted = [event for event in events if event["type"] == "asset.deleted"]
    assert deleted == [{"type": "asset.deleted", "sha256": sha, "owner_swarm": swarm,
                        "by": "user:u_delete_event_ann"}]
    frame = json.dumps(deleted[0])
    viewers = (Viewer("user:u_delete_event_ann", False), Viewer("user:u_delete_event_bob", False),
               Viewer("user:operator", True))
    assert tuple(hive.visibility.event_visible(viewer, frame) for viewer in viewers) == expected


def test_delete_requires_an_admin_even_for_the_visible_owner(client):
    member = person(client, "u_file_owner")
    swarm = client.post("/api/swarms", headers=member, json={"name": "My files"}).json()["id"]
    sha = upload(client, swarm=swarm)
    assert sha in {a["sha256"] for a in client.get("/api/assets", headers=member).json()}
    denied = client.delete(f"/api/assets/{sha}", headers=member)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "admin_only"
    assert client.get(f"/api/assets/{sha}").status_code == 200


def test_delete_uses_the_same_visibility_as_the_list(client, monkeypatch):
    sha = upload(client)
    assets = client.app.state.hive.assets
    monkeypatch.setattr(assets, "view_for", lambda viewer, row: None)
    assert client.get("/api/assets").json() == []
    assert client.delete(f"/api/assets/{sha}").status_code == 404
    assert assets.stores["local"].has(sha)


def test_delete_refuses_bytes_another_swarm_also_owns(client):
    swarms = [client.post("/api/swarms", json={"name": name}).json()["id"] for name in ("One", "Two")]
    sha = upload(client, swarm=swarms[0])
    upload(client, swarm=swarms[1])
    denied = client.delete(f"/api/assets/{sha}")
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "asset_shared"
    assert client.app.state.hive.assets.owners(sha) == set(swarms)
    assert client.get(f"/api/assets/{sha}").content == b"an uploaded file"


def test_delete_hides_personal_files_and_refuses_a_shared_sha_even_when_one_owner_is_redacted(client):
    person(client, "u_private_files")
    hive = client.app.state.hive
    private = hive.create_swarm("Personal", owner="user:u_private_files", visibility="private")["id"]
    hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", ("user:u_private_files", private))
    sha = hive.assets.put(b"a private file", "text/plain", "user:u_private_files", owner_swarm=private)["sha256"]
    assert sha not in {row["sha256"] for row in client.get("/api/assets").json()}
    assert client.delete(f"/api/assets/{sha}").status_code == 404
    team = client.post("/api/swarms", json={"name": "Shared team"}).json()["id"]
    upload(client, data=b"a private file", swarm=team)
    visible = next(row for row in client.get("/api/assets").json() if row["sha256"] == sha)
    assert visible["owners"] == [team]
    refused = client.delete(f"/api/assets/{sha}")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "asset_shared"
    assert private not in refused.text and team not in refused.text
    assert hive.assets.stores["local"].has(sha)


@pytest.mark.parametrize("failure", [403, 503, "unconfigured"])
def test_delete_store_failure_is_a_hard_error_and_can_be_retried(client, cloud, failure):
    sha = upload(client)
    client.post(f"/api/assets/{sha}/transfer", json={"to": "cloud"}).raise_for_status()
    assets = client.app.state.hive.assets
    store = assets.stores["cloud"]
    if failure == "unconfigured":
        del assets.stores["cloud"]
    else:
        cloud.delete_status = failure
    response = client.delete(f"/api/assets/{sha}")
    assert response.status_code == 503 and response.json()["error"]["code"] == "asset_delete_failed"
    assert "cloud" in response.json()["error"]["message"]
    assert json.loads(assets.row(sha)["placements"]) == ["cloud", "local"]
    assert client.get(f"/api/assets/{sha}").content == b"an uploaded file"
    assets.stores["cloud"] = store
    cloud.delete_status = 204
    assert client.delete(f"/api/assets/{sha}").status_code == 200


def test_delete_keeps_a_record_of_copies_already_removed_when_a_later_store_fails(client, cloud, monkeypatch):
    sha = upload(client)
    client.post(f"/api/assets/{sha}/transfer", json={"to": "cloud"}).raise_for_status()
    assets = client.app.state.hive.assets
    original = assets.stores["local"].delete

    def denied(digest):
        raise PermissionError("disk refuses deletion")

    monkeypatch.setattr(assets.stores["local"], "delete", denied)
    response = client.delete(f"/api/assets/{sha}")
    assert response.status_code == 503 and "disk refuses deletion" in response.json()["error"]["message"]
    row = assets.view(assets.row(sha))
    assert row["placements"] == ["local"] and not cloud.objects
    assert row["history"][-1]["removed"] == ["cloud"]
    monkeypatch.setattr(assets.stores["local"], "delete", original)
    assert client.delete(f"/api/assets/{sha}").status_code == 200


def test_delete_leaves_saved_artifact_revisions_and_mind_messages_with_their_reference(client):
    swarm = client.post("/api/swarms", json={"name": "Studio"}).json()["id"]
    mind = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm}).json()
    sha = upload(client, swarm=swarm)
    artifact = client.post("/api/agent/artifacts", headers=agent_headers(mind), json={"kind": "deck", "title": "Saved deck"}).json()
    manifest = json.dumps({"originals": [{"sha256": sha, "path": "notes.txt"}]})
    revision = client.post(f"/api/agent/artifacts/{artifact['id']}/revisions", headers=agent_headers(mind), json={"body": manifest, "parent": None})
    revision.raise_for_status()
    hive = client.app.state.hive
    messages = hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mind["id"],))
    assert client.delete(f"/api/assets/{sha}").status_code == 200
    assert hive.collab.read_revision(mind, artifact["id"], 1)["body"] == manifest
    assert hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mind["id"],)) == messages
    assert client.get(f"/api/agent/assets/{sha}", headers=agent_headers(mind)).status_code == 404


@pytest.mark.parametrize("table", ["local_bootstrap_sessions", "local_bootstrap_completions"])
@pytest.mark.parametrize("field", ["receipt_sha256", "envelope_sha256"])
def test_delete_refuses_files_the_coding_tools_setup_still_requires(client, table, field):
    sha = upload(client)
    db = client.app.state.hive.db
    with db._lock:
        db._conn.executescript(SETUP_SCHEMA)
    row = {"manifest_sha256": "manifest", "attempt": "attempt", "token_hash": "invented", "principal": "user:operator",
           "repo": "invented", "sha": "revision", "map_digest": "map", "receipt_sha256": "receipt", "envelope_sha256": "envelope", "runtime": "invented"}
    row[field] = sha
    if table == "local_bootstrap_sessions":
        row.update(installation="invented", instance="invented", created_at=1, deadline=2)
    else:
        row["completed_at"] = 1
    db.insert(table, row)
    response = client.delete(f"/api/assets/{sha}")
    assert response.status_code == 409 and response.json()["error"]["code"] == "asset_required"
    assert client.get(f"/api/assets/{sha}").status_code == 200


@pytest.mark.parametrize("ownerless_first", [False, True])
def test_delete_updates_the_live_file_map_and_allows_a_reupload_notice(client, ownerless_first):
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Studio"}).json()["id"]
    mind = client.post("/api/agents", json={"name": "Reader", "kind": "module", "swarm_id": swarm}).json()
    if ownerless_first:
        upload(client)
        hive.repo_map_live.drain()
    sha = upload(client, swarm=swarm)
    hive.repo_map_live.drain()
    repo = f"assets-{swarm}"
    old = hive.db.one("SELECT * FROM repo_maps WHERE repo = ? ORDER BY rowid DESC LIMIT 1", (repo,))
    assert hive.repo_maps.nodes(Caller("user:operator", admin=True), repo, old["sha"])["nodes"]
    assert hive.db.one("SELECT * FROM mind_file_notices WHERE subject = ?", (f"asset:{sha}",))
    messages = hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mind["id"],))
    assert client.delete(f"/api/assets/{sha}").status_code == 200
    assert not hive.db.one("SELECT * FROM mind_file_notices WHERE subject = ?", (f"asset:{sha}",))
    hive.repo_map_live.drain()
    current = hive.db.one("SELECT * FROM repo_maps WHERE repo = ? ORDER BY rowid DESC LIMIT 1", (repo,))
    assert current["sha"] != old["sha"]
    assert hive.repo_maps.nodes(Caller("user:operator", admin=True), repo, current["sha"])["nodes"] == []
    if ownerless_first:
        host = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'assets-host' ORDER BY rowid DESC LIMIT 1")
        assert hive.repo_maps.nodes(Caller("user:operator", admin=True), "assets-host", host["sha"])["nodes"] == []
    assert upload(client, swarm=swarm) == sha
    assert len(hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mind["id"],))) == len(messages) + 1


def test_upload_of_the_same_sha_waits_until_deletion_finishes(client, monkeypatch):
    sha = upload(client)
    assets = client.app.state.hive.assets
    deleting, release, uploading = threading.Event(), threading.Event(), threading.Event()
    original = assets.stores["local"].delete

    def held_delete(digest):
        deleting.set()
        release.wait()
        original(digest)

    def put_again():
        uploading.set()
        return assets.put(b"an uploaded file", "text/plain", "user:operator")

    monkeypatch.setattr(assets.stores["local"], "delete", held_delete)
    with ThreadPoolExecutor(max_workers=2) as pool:
        deletion = pool.submit(assets.delete, sha, "user:operator", Viewer("user:operator", True))
        deletion.add_done_callback(lambda _: deleting.set())
        deleting.wait()
        try:
            if deletion.done():
                deletion.result()
            replacement = pool.submit(put_again)
            uploading.wait()
            assert not replacement.done()
        finally:
            release.set()
        assert deletion.result()["deleted"] is True
        assert replacement.result()["sha256"] == sha
    assert assets.read(sha)[1] == b"an uploaded file"
