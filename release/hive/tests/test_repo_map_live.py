"""Repo maps 1.2: stored files and artifacts mapped as they change; private code sources owner-only (repomap_live.py,
repomap_sources.py). Invented data and invented fixture repos only."""

import json
import pathlib
import shutil

import pytest

from hive.core import newhive as nh
from hive.core import repomap
from hive.core.repomap_seed import ManifestInvalid, parse_manifest
from hive.core.repomap_sources import LOCAL_SOURCES, RepoMapSources, SourceInvalid, code_only, parse_local
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_repo_map import mind
from hive.tests.test_repo_map_sources import git, stub_build
from hive.tests.test_visibility import person

ADMIN = repomap.Caller("user:operator", admin=True)


def listen(hive):
    seen = []
    hive.events.listen(lambda kind, payload: seen.append((kind, payload)))
    return seen


def test_stored_files_are_mapped_per_team_as_typed_nodes_and_only_changes_make_revisions(client):
    hive, live = client.app.state.hive, client.app.state.hive.repo_map_live
    seen = listen(hive)
    sw, headers, _ = mind(client, "Alpha")
    other_sw, other_headers, _ = mind(client, "Beta")
    hive.assets.put(b"# plan\n", "text/markdown", "user:operator", owner_swarm=sw["id"], name="plan.md")
    hive.assets.put(b"\x89PNG....", "image/png", "user:operator", owner_swarm=sw["id"], name="logo.png")
    hive.assets.put(b'{"a": 1}', "application/json", "user:operator", owner_swarm=sw["id"], name="data.json")
    live.drain()
    repo = f"assets-{sw['id']}"
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = ?", (repo,))
    assert row["visibility"] == f"swarm:{sw['id']}" and row["loaded_by"] == "host:repo-maps" and row["pinned"] == 1
    nodes = {n["label"]: n for n in hive.repo_maps.nodes(ADMIN, repo, row["sha"])["nodes"]}
    assert {k: (n["kind"], n["declaration"]["type"]) for k, n in nodes.items()} == {
        "plan.md": ("doc", "document"), "logo.png": ("file", "image"), "data.json": ("file", "data")}
    assert nodes["plan.md"]["declaration"]["ref"].startswith("hive-asset:")
    assert client.get(f"/api/repo-maps/{repo}/{row['sha']}", headers=headers).status_code == 200      # its own team
    assert client.get(f"/api/repo-maps/{repo}/{row['sha']}", headers=other_headers).status_code == 404  # private to it
    assert ("repo_maps.updated", {"repo": repo, "sha": row["sha"], "digest": row["digest"], "previous": None}) in seen
    live.mark(("assets", sw["id"]))
    live.drain()
    assert hive.db.one("SELECT COUNT(*) n FROM repo_maps WHERE repo = ?", (repo,))["n"] == 1        # unchanged: nothing new
    hive.assets.put(b"notes", "text/plain", "user:operator", owner_swarm=sw["id"], name="notes.txt")
    live.drain()
    pins = [r["pinned"] for r in hive.db.all("SELECT pinned FROM repo_maps WHERE repo = ? ORDER BY rowid", (repo,))]
    assert pins == [0, 1]                                                                              # history + current


def test_the_maps_own_writes_are_not_mapped_and_unowned_files_are_owner_only(client):
    hive, live = client.app.state.hive, client.app.state.hive.repo_map_live
    hive.assets.put(b"receipt", "application/json", "host:repo-maps", name="r.json")
    live.drain()
    assert hive.db.one("SELECT COUNT(*) n FROM repo_maps")["n"] == 0
    hive.assets.put(b"loose file", "text/plain", "user:operator", name="loose.txt")
    live.drain()
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'assets-host'")
    assert row["visibility"] == "owner"
    member = person(client, "u_mem")
    _, headers, agent = mind(client, "Gamma")
    assert client.get(f"/api/repo-maps/assets-host/{row['sha']}").status_code == 200                # the owner
    assert client.get(f"/api/repo-maps/assets-host/{row['sha']}", headers=member).status_code == 404
    assert client.get(f"/api/repo-maps/assets-host/{row['sha']}", headers=headers).status_code == 404
    assert client.post("/api/repo-maps/assets-host/grants", json={"principal": f"agent:{agent['id']}"}, headers=member).status_code == 403
    assert client.post("/api/repo-maps/assets-host/grants", json={"principal": f"agent:{agent['id']}"}).status_code == 200
    assert client.get(f"/api/repo-maps/assets-host/{row['sha']}", headers=headers).status_code == 200  # granted
    assert client.delete(f"/api/repo-maps/assets-host/grants/agent:{agent['id']}").status_code == 200
    assert client.get(f"/api/repo-maps/assets-host/{row['sha']}", headers=headers).status_code == 404


def test_artifact_revisions_are_mapped_and_unproduced_kinds_are_recorded(client):
    hive, live = client.app.state.hive, client.app.state.hive.repo_map_live
    sw = client.post("/api/swarms", json={"name": "Docs"}).json()
    hive.db.execute("INSERT INTO artifacts (id, kind, title, owner_swarm, created_by, created_at) VALUES (?,?,?,?,?,?)",
                    ("ar_1", "plan", "Launch plan", sw["id"], "user:operator", "2026-11-08T00:00:00Z"))
    hive.db.execute("INSERT INTO artifact_revisions (artifact_id, n, digest, parent, author, body, changed_steps, affected_steps, "
                    "created_at) VALUES ('ar_1', 1, 'sha256:aa', NULL, 'user:operator', '{}', '[]', '[]', '2026-11-08T00:00:00Z')")
    hive.events.publish("artifact.revision", swarm_id=sw["id"], artifact_id="ar_1", revision=1, digest="sha256:aa", created_at="x")
    hive.events.publish("code.controller.applied", workspace_id="ws_1", paths=["a.py"], after="abc")
    live.drain()
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = ?", (f"artifacts-{sw['id']}",))
    (node,) = hive.repo_maps.nodes(ADMIN, row["repo"], row["sha"])["nodes"]
    assert node["label"] == "Launch plan" and node["declaration"]["revision"] == 1
    assert "code.controller.applied" in live.status()["waiting_for_producer"]


def make_private_repo(path):
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    files = {"app/core.py": "def run():\n    return 1\n", "app/health/vitals.py": "X = 1\n", "corpus/entry.py": "Y = 2\n",
             "labels/tag.py": "Z = 3\n", "data/records.csv": "a,b\n", "notes.md": "# private\n", "app/ui.ts": "export {}\n"}
    for name, text in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "one")


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_a_private_code_source_maps_code_only_and_is_owner_only(client, tmp_path):
    hive = client.app.state.hive
    make_private_repo(tmp_path / "invented-health-twin")
    data = tmp_path / "data"
    data.mkdir()
    (data / LOCAL_SOURCES).write_text(json.dumps({"schema": "repo-map-local-sources/1", "sources": [
        {"repo": "private-twin", "source": {"kind": "git", "path": str(tmp_path / "invented-health-twin"), "ref": "main"},
         "visibility": "owner", "files": "code"}]}))
    sources = RepoMapSources(hive, data, environ={}, extractor=nh.ExtractorAdapter(stub_build))
    (state,) = sources.check_all(sources.local_revisions())
    assert state["state"] == "current" and state["private"] is True
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'private-twin'")
    assert row["visibility"] == "owner"
    owner_view = client.get(f"/api/repo-maps/private-twin/{row['sha']}/nodes").json()
    assert sorted(n["label"] for n in owner_view["nodes"]) == ["app/core.py", "app/ui.ts"]   # code only, no data folders
    member = person(client, "u_mem")
    _, headers, _ = mind(client, "Lane")
    for h in (member, headers):
        assert client.get(f"/api/repo-maps/private-twin/{row['sha']}", headers=h).status_code == 404
        assert all(m["repo"] != "private-twin" for m in client.get("/api/repo-maps", headers=h).json())
    hidden = sources.status(sees_private=False)
    assert hidden == [{"repo": "private", "private": True, "state": "current", "last_check": state["last_check"]}]
    assert str(tmp_path) not in json.dumps(hidden)


def test_private_registrations_live_only_in_the_data_folder():
    for bad in ({"repo": "x", "source": {"kind": "git", "url": "https://github.com/a/b.git", "ref": "main"}},
                {"repo": "x", "source": {"kind": "git", "path": "/a", "ref": "main"}, "visibility": "hive"},
                {"repo": "x", "source": {"kind": "git", "path": "/a", "ref": "main"}, "files": "all"}):
        with pytest.raises(SourceInvalid):
            parse_local(json.dumps({"schema": "repo-map-local-sources/1", "sources": [bad]}))
    shipped = pathlib.Path(repomap.__file__).with_name("repomap_pinned.json")
    raw = json.loads(shipped.read_text())
    raw["revisions"][0]["visibility"] = "owner"
    with pytest.raises(ManifestInvalid):              # the release manifest (exported, deployed) cannot carry one
        parse_manifest(json.dumps(raw))
    root = pathlib.Path(repomap.__file__).resolve().parents[2]
    assert not list(root.glob(f"**/{LOCAL_SOURCES}"))  # never in the release tree the mirror and cloud deploys copy
    assert code_only("app/core.py") and not code_only("app/notes.md") and not code_only("corpus/a.py") \
        and not code_only("app/records/x.py") and not code_only("labels/y.py") and not code_only(".env.py")
