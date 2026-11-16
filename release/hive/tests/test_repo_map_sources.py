"""Tracked repo-map sources stay current by themselves (hive/core/repomap_sources.py). Invented local git repos only."""

import hashlib
import json
import pathlib
import shutil
import subprocess

import pytest

from hive.core import newhive as nh
from hive.core import repomap
from hive.core.repomap_seed import RepoMapSeed
from hive.core.repomap_sources import PRINCIPAL, RepoMapSources, SourceInvalid, parse_source
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")


def stub_build(files, *, repo, sha, artifact_ref, generated_at):
    """A minimal extractor with the pinned package's entry point: one file node per source file."""
    census = [{"path": p, "size": len(b), "digest": "sha256:" + hashlib.sha256(b).hexdigest()} for p, b in sorted(files.items())]
    envelope = {"schema": "repo-map/1", "repo": repo, "sha": sha, "snapshot_digest": nh.canonical_digest(census),
                "extractor": {"id": "stub", "version": "1", "parser": "none"}, "generated_at": generated_at,
                "receipt": {"digest": None, "artifact_ref": artifact_ref}, "state": "partial", "reason": "stub",
                "coverage": {"kinds": ["file"], "languages": [], "unresolved": []},
                "nodes": [{"id": f"file:{c['path']}", "kind": "file", "label": c["path"], "source_digest": c["digest"],
                           "refs": []} for c in census],
                "edges": [], "truncated": False, "next_cursor": None}
    receipt = {"schema": "repo-map-extraction-receipt/1", "repo": repo, "sha": sha,
               "snapshot_digest": envelope["snapshot_digest"], "census": census,
               "envelope_content_digest": nh.canonical_digest({k: v for k, v in envelope.items() if k != "receipt"})}
    envelope["receipt"]["digest"] = nh.canonical_digest(receipt)
    return envelope, receipt


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                          check=True, capture_output=True).stdout.decode().strip()


def make_repo(path):
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    (path / "pkg").mkdir()
    (path / "pkg" / "core.py").write_text("def add(a, b):\n    return a + b\n")
    (path / "docs.md").write_text("# docs\n")
    (path / "atlas_notes.py").write_text("SECRET = 1\n")           # never read: the collector's atlas/truth filter
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "one")
    return git(path, "rev-parse", "HEAD")


def commit(path, name, text):
    (path / name).write_text(text)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", name)
    return git(path, "rev-parse", "HEAD")


def rev(path, repo="fixture-src", **source):
    return {"repo": repo, "sha": "0" * 40, "digest": "sha256:" + "0" * 64, "visibility": "hive", "pinned": True,
            "file": "none.json", "source": parse_source({"kind": "git", "path": str(path), "ref": "main", **source})}


def tracked(client, tmp_path, build=stub_build):
    hive = client.app.state.hive
    events = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **payload: (kind.startswith("repo_maps.") and events.append((kind, payload)),
                                                   real(kind, **payload))[1]
    return RepoMapSources(hive, tmp_path / "data", environ={}, extractor=nh.ExtractorAdapter(build)), events


def test_behind_is_rebuilt_and_current_and_an_unchanged_head_builds_nothing(client, tmp_path):
    hive = client.app.state.hive
    first = make_repo(tmp_path / "src")
    sources, events = tracked(client, tmp_path)
    entry = rev(tmp_path / "src")
    (state,) = sources.check_all([entry])
    assert state["state"] == "current" and state["head"] == first and state["built_sha"] == first and state["last_check"]
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'fixture-src'")
    assert row["sha"] == first and row["loaded_by"] == PRINCIPAL and row["pinned"] == 1
    paths = {n["label"] for n in json.loads(json.dumps(hive.repo_maps.nodes(
        repomap.Caller("user:operator", admin=True), "fixture-src", first)["nodes"]))}
    assert paths == {"pkg/core.py", "docs.md"}                                      # atlas-named file never read
    assert [k for k, _ in events] == ["repo_maps.stale", "repo_maps.updated"]
    events.clear()
    count = hive.db.one("SELECT COUNT(*) n FROM repo_maps")["n"]
    (state,) = sources.check_all([entry])
    assert state["state"] == "current" and events == [] and hive.db.one("SELECT COUNT(*) n FROM repo_maps")["n"] == count
    second = commit(tmp_path / "src", "pkg/extra.py", "X = 2\n")
    (state,) = sources.check_all([entry])
    assert state["state"] == "current" and state["built_sha"] == second
    pins = {r["sha"]: r["pinned"] for r in hive.db.all("SELECT sha, pinned FROM repo_maps WHERE repo = 'fixture-src'")}
    assert pins == {first: 0, second: 1}                                             # the old one is history
    assert events[-1] == ("repo_maps.updated", {"repo": "fixture-src", "sha": second, "digest": state["digest"], "previous": first})


def test_a_view_keeps_only_its_prefixes(client, tmp_path):
    hive = client.app.state.hive
    make_repo(tmp_path / "src")
    sources, _ = tracked(client, tmp_path)
    (state,) = sources.check_all([rev(tmp_path / "src", repo="fixture-view", include=["pkg/"])])
    nodes = hive.repo_maps.nodes(repomap.Caller("user:operator", admin=True), "fixture-view", state["built_sha"])["nodes"]
    assert [n["label"] for n in nodes] == ["pkg/core.py"]


def test_an_unreachable_source_is_stale_unknown_and_the_old_map_is_still_served(client, tmp_path):
    hive = client.app.state.hive
    first = make_repo(tmp_path / "src")
    sources, events = tracked(client, tmp_path)
    entry = rev(tmp_path / "src")
    sources.check_all([entry])
    shutil.rmtree(tmp_path / "src")
    (state,) = sources.check_all([entry])
    assert state["state"] == "stale-unknown" and state["error_code"] == "source_unresolved" and state["built_sha"] == first
    assert events[-1][0] == "repo_maps.stale" and events[-1][1]["state"] == "stale-unknown"
    assert client.get(f"/api/repo-maps/fixture-src/{first}").status_code == 200


def test_a_failed_or_tampered_build_keeps_the_old_map_with_an_error(client, tmp_path):
    hive = client.app.state.hive
    first = make_repo(tmp_path / "src")
    ok, _ = tracked(client, tmp_path)
    entry = rev(tmp_path / "src")
    ok.check_all([entry])
    commit(tmp_path / "src", "pkg/more.py", "Y = 3\n")

    def failing(files, **kw):
        raise ValueError("boom")

    def lying(files, **kw):   # a census that is not the fetched source: refused by the self-map's own verification
        envelope, receipt = stub_build({**files, "extra.py": b"invented"}, **kw)
        return envelope, receipt

    for build, code in ((failing, "extraction_failed"), (lying, "receipt_mismatch")):
        broken, _ = tracked(client, tmp_path, build)
        (state,) = broken.check_all([entry])
        assert state["state"] == "failed" and state["error_code"] == code, state
        assert [r["sha"] for r in hive.db.all("SELECT sha FROM repo_maps WHERE repo = 'fixture-src'")] == [first]
        assert hive.db.one("SELECT pinned FROM repo_maps WHERE repo = 'fixture-src'")["pinned"] == 1


def test_sources_are_public_https_or_local_paths_without_credentials():
    for bad in ({"kind": "git", "url": "http://example.com/x.git", "ref": "main"},
                {"kind": "git", "url": "https://user:pw@github.com/x/y.git", "ref": "main"},
                {"kind": "git", "url": "git@github.com:x/y.git", "ref": "main"},
                {"kind": "git", "path": "relative/path", "ref": "main"},
                {"kind": "git", "path": "/a", "url": "https://github.com/x/y.git", "ref": "main"},
                {"kind": "git", "path": "/a", "ref": "../x"},
                {"kind": "git", "path": "/a", "ref": "main", "include": ["../up"]},
                {"kind": "svn", "path": "/a", "ref": "main"}):
        with pytest.raises(SourceInvalid):
            parse_source(bad)


def test_the_shipped_manifest_tracks_every_public_map():
    from hive.core.repomap_seed import parse_manifest
    revisions = parse_manifest(pathlib.Path(repomap.__file__).with_name("repomap_pinned.json").read_bytes())
    assert all(r["source"] is not None for r in revisions)
    assert {r["repo"]: r["source"]["location"].startswith("https://") for r in revisions}["physixsnet-omegahive"]


def test_the_admin_status_shows_currency(client, tmp_path, monkeypatch):
    hive = client.app.state.hive
    make_repo(tmp_path / "src")
    seed = RepoMapSeed(hive, data_dir=tmp_path / "data", environ={"HIVE_REPO_MAP_SEED_DIRS": str(tmp_path / "none")})
    seed.sources = RepoMapSources(hive, tmp_path / "data", environ={}, extractor=nh.ExtractorAdapter(stub_build))
    hive.repo_map_seed = seed
    seed.sources.check_all([rev(tmp_path / "src")])
    currency = client.get("/api/admin/repo-maps/seed").json()["currency"]
    assert [(c["repo"], c["state"]) for c in currency] == [("fixture-src", "current")]
    assert set(currency[0]) >= {"head", "built_sha", "state", "last_check"}


def test_a_path_env_source_names_no_path_and_resolves_from_the_host_setting(monkeypatch, tmp_path):
    """The shipped manifest must not carry a machine's paths (mirror scrub): the release-repo views use path_env."""
    src = {"kind": "git", "path_env": "HIVE_REPO_MAP_RELEASE_REPO", "ref": "main"}
    monkeypatch.delenv("HIVE_REPO_MAP_RELEASE_REPO", raising=False)
    assert parse_source(src)["location"] == ""          # valid, unresolvable here: reported stale-unknown, never current
    monkeypatch.setenv("HIVE_REPO_MAP_RELEASE_REPO", str(tmp_path))
    assert parse_source(src)["location"] == str(tmp_path)
    monkeypatch.setenv("HIVE_REPO_MAP_RELEASE_REPO", "relative/path")
    assert parse_source(src)["location"] == ""
    import json, pathlib
    manifest = pathlib.Path(__file__).resolve().parents[1] / "core" / "repomap_pinned.json"
    assert "/Users/" not in manifest.read_text() and "/home/" not in manifest.read_text()
    with pytest.raises(SourceInvalid):
        parse_source({"kind": "git", "path_env": "PATH", "ref": "main"})
