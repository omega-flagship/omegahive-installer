"""Assets (R12): content-addressed, local and S3-compatible stores, verified transfer, local-only placement, safe serving."""
import hashlib
import json

import httpx
import pytest

from hive.core.assets import S3Store
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


class FakeS3:
    """An in-memory S3 endpoint that insists on SigV4-signed requests."""
    def __init__(self):
        self.objects, self.seen = {}, []
        self.delete_status = 204

    def __call__(self, request: httpx.Request):
        auth = request.headers.get("authorization", "")
        self.seen.append((request.method, request.url.path, auth.startswith("AWS4-HMAC-SHA256 Credential=key/")))
        if not auth.startswith("AWS4-HMAC-SHA256"):
            return httpx.Response(403)
        key = request.url.path
        if request.method == "PUT":
            self.objects[key] = request.content
            return httpx.Response(200)
        if request.method in ("GET", "HEAD"):
            return httpx.Response(200, content=self.objects[key] if request.method == "GET" else b"") if key in self.objects else httpx.Response(404)
        if request.method == "DELETE":
            if self.delete_status != 204:
                return httpx.Response(self.delete_status)
            self.objects.pop(key, None)
            return httpx.Response(204)
        return httpx.Response(405)


@pytest.fixture()
def cloud(client):
    fake = FakeS3()
    hive = client.app.state.hive
    hive.assets.stores["cloud"] = S3Store("https://s3.example.test", "omegahive", "auto", "key", "secret", transport=httpx.MockTransport(fake))
    return fake


def test_local_store_transfer_to_cloud_and_back_verified(client, cloud):
    png = b"\x89PNG\r\n\x1a\n" + b"pixels" * 100
    digest = hashlib.sha256(png).hexdigest()
    up = client.post("/api/assets?name=chart.png", content=png, headers={"content-type": "image/png"}).json()
    assert up["sha256"] == digest and up["placements"] == ["local"] and up["bytes"] == len(png)
    assert {s["name"] for s in client.get("/api/asset-stores").json()} >= {"local", "cloud"}
    copied = client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud"}).json()
    assert copied["placements"] == ["cloud", "local"] and all(signed for _, _, signed in cloud.seen)
    moved = client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud", "move": True}).json()
    assert moved["placements"] == ["cloud"] and moved["history"][-1]["removed"] == ["local"]
    r = client.get(f"/api/assets/{digest}")
    assert r.content == png and r.headers["content-type"] == "image/png" and r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"] and r.headers["content-disposition"].startswith("inline")


def test_local_only_stays_home_and_html_is_never_rendered(client, cloud):
    secret = b"<html><script>steal()</script></html>"
    digest = client.post("/api/assets?name=page.html&local_only=true", content=secret, headers={"content-type": "text/html"}).json()["sha256"]
    refused = client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "local_only" and not cloud.objects
    r = client.get(f"/api/assets/{digest}")
    assert r.headers["content-type"] == "application/octet-stream" and r.headers["content-disposition"].startswith("attachment")


@pytest.mark.parametrize("status", [403, 503])
def test_failed_s3_delete_keeps_local_only_cleanup_pending(client, cloud, status):
    data = b"invented file requiring remote cleanup"
    digest = client.post("/api/assets", content=data).json()["sha256"]
    client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud"}).raise_for_status()
    cloud.delete_status = status
    result = client.post("/api/assets?local_only=true", content=data).json()
    assert result["placements"] == ["cloud", "local"]
    assert result["pending_removal"] == ["cloud"]
    assert result["history"][-1]["removed"] == []
    assert "cloud" in result["history"][-1]["failed"]
    assert cloud.objects  # a refused remote delete must stay recorded for retry
    cloud.delete_status = 204
    retried = client.app.state.hive.assets.cleanup(digest, "user:operator")
    assert retried["placements"] == ["local"]
    assert retried["pending_removal"] == []
    assert retried["history"][-1]["removed"] == ["cloud"]
    assert not cloud.objects


def test_a_corrupted_copy_is_refused(client):
    data = b"original bytes"
    digest = client.post("/api/assets", content=data, headers={"content-type": "text/plain"}).json()["sha256"]
    hive = client.app.state.hive
    hive.assets.stores["local"]._path(digest).write_bytes(b"tampered")
    assert client.get(f"/api/assets/{digest}").status_code == 500


def test_minds_read_their_swarms_files_or_files_listed_in_a_revision_they_review(client):
    R, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("Studio", "Critics"))
    maker = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": R["id"]}).json()
    critic_role = client.post("/api/roles", json={"name": "Craft r", "prompt": "p", "mandate": {"id": "craft", "version": "1"}}).json()["id"]
    critic = client.post("/api/agents", json={"name": "Critic", "kind": "module", "swarm_id": V["id"], "role_id": critic_role}).json()
    third = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    outsider = client.post("/api/agents", json={"name": "Other", "kind": "module", "swarm_id": third["id"]}).json()   # reads are per swarm; writes need the held review
    deck = b"PK\x03\x04 fake pptx"
    up = client.post("/api/agent/assets?name=deck.pptx", content=deck, headers={**agent_headers(maker), "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}).json()
    assert up["owner_swarm"] == R["id"]
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(maker)).content == deck
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(critic)).status_code == 404
    # the maker's swarm publishes a revision whose manifest lists the deck, and asks for a review of exactly it
    g = client.post(f"/api/swarms/{R['id']}/goals", json={"title": "deck", "assignee": "Maker"}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(maker))
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    art = client.post("/api/agent/artifacts", headers=agent_headers(maker), json={"kind": "deck", "title": "Pitch"}).json()
    manifest = {"originals": [{"path": "deck.pptx", "sha256": up["sha256"], "mime": up["mime"], "editable": True}], "previews": []}
    client.post(f"/api/agent/artifacts/{art['id']}/revisions", headers=agent_headers(maker), json={"body": json.dumps(manifest), "parent": None})
    rq = client.post("/api/agent/requests", headers=agent_headers(maker), json={"kind": "review", "to_swarm": V["id"], "title": "review deck",
         "from_goal": g["id"], "subject": {"artifact_id": art["id"], "revision": 1}, "constraints": {"mandates": [{"id": "craft", "version": "1"}]}}).json()
    client.post(f"/api/agent/goals/{rq['receiving_goal']}/claim", headers=agent_headers(critic))
    got = client.get(f"/api/agent/assets/{up['sha256']}?artifact={art['id']}&revision=1", headers=agent_headers(critic))
    assert got.status_code == 200 and got.content == deck
    assert client.get(f"/api/agent/assets/{up['sha256']}?artifact={art['id']}&revision=1", headers=agent_headers(outsider)).status_code in (403, 404)


def test_a_forged_manifest_cannot_reach_another_swarms_file(client):
    A, B = (client.post("/api/swarms", json={"name": n}).json() for n in ("Owner", "Thief"))
    owner = client.post("/api/agents", json={"name": "Own", "kind": "module", "swarm_id": A["id"]}).json()
    thief = client.post("/api/agents", json={"name": "Thief", "kind": "module", "swarm_id": B["id"]}).json()
    secret = b"restricted original"
    sha = client.post("/api/agent/assets?name=s.bin", content=secret, headers={**agent_headers(owner), "content-type": "application/octet-stream"}).json()["sha256"]
    art = client.post("/api/agent/artifacts", headers=agent_headers(thief), json={"kind": "deck", "title": "forged"}).json()
    client.post(f"/api/agent/artifacts/{art['id']}/revisions", headers=agent_headers(thief),
                json={"body": json.dumps({"originals": [{"path": "x", "sha256": sha, "mime": "application/octet-stream"}]}), "parent": None})
    r = client.get(f"/api/agent/assets/{sha}?artifact={art['id']}&revision=1", headers=agent_headers(thief))
    assert r.status_code == 404 and r.content != secret


def test_identical_bytes_belong_to_every_swarm_that_put_them(client):
    first, (a, _) = make_swarm_and_agents(client)
    second = client.post("/api/swarms", json={"name": "Second"}).json()
    b = client.post("/api/agents", json={"name": "Other", "model": "mock/echo", "swarm_id": second["id"]}).json()
    data = b"identical bytes in two swarms"
    digest = hashlib.sha256(data).hexdigest()
    up_a = client.post("/api/agent/assets?name=a.bin", content=data, headers=agent_headers(a) | {"content-type": "application/octet-stream"}).json()
    assert up_a["owners"] == [first["id"]] and up_a["owner_swarm"] == first["id"]
    assert client.get(f"/api/agent/assets/{digest}", headers=agent_headers(b)).status_code == 404   # not yet theirs
    up_b = client.post("/api/agent/assets?name=b.bin", content=data, headers=agent_headers(b) | {"content-type": "application/octet-stream"}).json()
    assert up_b["owners"] == sorted([first["id"], second["id"]]) and up_b["owner_swarm"] == first["id"]
    assert client.get(f"/api/agent/assets/{digest}", headers=agent_headers(b)).content == data      # a second swarm reads its own upload
    assert client.get(f"/api/agent/assets/{digest}", headers=agent_headers(a)).content == data
    assert {r["sha256"] for r in client.get(f"/api/assets?swarm_id={second['id']}").json()} == {digest}
    assert [h["event"] for h in up_b["history"]] == ["stored", "owner_added"]
    # a third swarm that never put it still cannot read it
    third = client.post("/api/swarms", json={"name": "Third"}).json()
    c = client.post("/api/agents", json={"name": "Third", "model": "mock/echo", "swarm_id": third["id"]}).json()
    assert client.get(f"/api/agent/assets/{digest}", headers=agent_headers(c)).status_code == 404


def test_a_later_local_only_put_pulls_the_file_home(client, cloud):
    swarm, (a, _) = make_swarm_and_agents(client)
    data = b"first shared, later private"
    digest = hashlib.sha256(data).hexdigest()
    client.post("/api/assets", content=data, headers={"content-type": "application/octet-stream"})
    assert client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud"}).json()["placements"] == ["cloud", "local"]
    again = client.post("/api/agent/assets?local_only=true", content=data, headers=agent_headers(a) | {"content-type": "application/octet-stream"}).json()
    assert again["local_only"] is True and again["placements"] == ["local"] and again["history"][-1]["removed"] == ["cloud"]
    assert client.post(f"/api/assets/{digest}/transfer", json={"to": "cloud"}).status_code == 403
    # the flag only tightens: a later ordinary put does not lift it
    assert client.post("/api/agent/assets", content=data, headers=agent_headers(a) | {"content-type": "application/octet-stream"}).json()["local_only"] is True
