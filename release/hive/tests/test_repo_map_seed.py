"""The hive keeps its pinned repo maps loaded by itself (hive/core/repomap_seed.py). Synthetic envelopes only."""

import copy
import json
import pathlib
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

from hive.core import repomap
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.repomap_seed import PRINCIPAL, RepoMapSeed, parse_manifest, ManifestInvalid
from hive.tests.test_core_api import PETTA, FakeSupervisor, client  # noqa: F401  (fixture)
from hive.tests.test_repo_map import SYNTHETIC, mind, mounted
from hive.tests.test_visibility import person

SHA1 = SYNTHETIC["sha"]
OTHER = dict(copy.deepcopy(SYNTHETIC), repo="fixture-other")


def entry(envelope, name, **over):
    return dict({"repo": envelope["repo"], "sha": envelope["sha"], "digest": repomap.digest_of(envelope),
                 "visibility": "hive", "pinned": True, "file": name}, **over)


def setup(tmp, revisions, files):
    tmp = pathlib.Path(tmp)
    (tmp / "src").mkdir(exist_ok=True)
    for name, envelope in files.items():
        (tmp / "src" / name).write_text(envelope if isinstance(envelope, str) else json.dumps(envelope))
    (tmp / "pins.json").write_text(json.dumps({"schema": "repo-map-pins/1", "revisions": revisions}))
    return {"HIVE_REPO_MAP_SEED_MANIFEST": str(tmp / "pins.json"), "HIVE_REPO_MAP_SEED_DIRS": str(tmp / "src")}


def by_repo(status):
    return {e["repo"]: e for e in status["entries"]}


def counts(hive):
    return [hive.db.one(f"SELECT COUNT(*) n FROM {t}")["n"] for t in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms")]


def test_missing_pinned_revisions_load_as_the_host_principal_and_reruns_change_nothing(client, tmp_path):
    hive = client.app.state.hive
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json"), entry(OTHER, "b.json", pinned=False)],
                {"a.json": SYNTHETIC, "b.json": OTHER})
    seed = RepoMapSeed(hive, environ=env)
    out = seed.run_once()
    assert out["state"] == "ready" and out["principal"] == "host:repo-maps"
    assert {r: e["state"] for r, e in by_repo(out).items()} == {"fixture-mini": "seeded", "fixture-other": "seeded"}
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'fixture-mini'")
    assert row["loaded_by"] == PRINCIPAL and row["pinned"] == 1 and row["visibility"] == "hive"
    assert row["digest"] == repomap.digest_of(SYNTHETIC)
    assert hive.db.one("SELECT pinned FROM repo_maps WHERE repo = 'fixture-other'")["pinned"] == 0
    assert not hive.db.all("SELECT 1 FROM sessions WHERE principal = ?", (PRINCIPAL,))   # never an admin session
    mounted(client, "fixture-mini", SHA1, len(repomap.atoms(SYNTHETIC)))
    before, stamp = counts(hive), row["loaded_at"]
    again = seed.run_once()
    assert again["state"] == "ready" and {e["state"] for e in again["entries"]} == {"loaded"} and again["runs"] == 2
    assert counts(hive) == before
    assert hive.db.one("SELECT loaded_at FROM repo_maps WHERE repo = 'fixture-mini'")["loaded_at"] == stamp
    # a fresh seeder (as after a restart) finds everything there and loads nothing
    assert {e["state"] for e in RepoMapSeed(hive, environ=env).run_once()["entries"]} == {"loaded"}
    assert counts(hive) == before


def test_a_tampered_envelope_is_refused_and_nothing_is_loaded(client, tmp_path):
    hive = client.app.state.hive
    tampered = copy.deepcopy(SYNTHETIC)
    tampered["nodes"][1]["label"] = "add_two"
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json")], {"a.json": tampered})
    out = RepoMapSeed(hive, environ=env).run_once()
    e = by_repo(out)["fixture-mini"]
    assert out["state"] == "partial" and e["state"] == "digest_mismatch"
    assert e["actual_digest"] == repomap.digest_of(tampered) != e["digest"]
    assert counts(hive) == [0, 0, 0, 0]
    # an envelope that names another revision than its manifest entry is refused before the digest
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json", sha="f" * 40)], {"a.json": SYNTHETIC})
    assert by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]["state"] == "identity_mismatch"
    for raw, state in (("{not json", "unreadable"),):
        env = setup(tmp_path, [entry(SYNTHETIC, "a.json")], {"a.json": raw})
        assert by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]["state"] == state
    assert counts(hive) == [0, 0, 0, 0]


def test_a_missing_file_is_reported_and_the_others_still_load(client, tmp_path):
    hive = client.app.state.hive
    env = setup(tmp_path, [entry(SYNTHETIC, "gone.json"), entry(OTHER, "b.json")], {"b.json": OTHER})
    out = RepoMapSeed(hive, environ=env).run_once()
    assert out["state"] == "partial" and out["counts"] == {"missing": 1, "seeded": 1}
    assert by_repo(out)["fixture-mini"]["state"] == "missing"
    assert [r["repo"] for r in hive.db.all("SELECT repo FROM repo_maps")] == ["fixture-other"]
    # the file arrives later: the next run loads it, the other is left as it is
    (tmp_path / "src" / "gone.json").write_text(json.dumps(SYNTHETIC))
    out = RepoMapSeed(hive, environ=env).run_once()
    assert out["state"] == "ready" and {r: e["state"] for r, e in by_repo(out).items()} == {"fixture-mini": "seeded", "fixture-other": "loaded"}


def test_the_first_source_folder_holding_the_file_wins(client, tmp_path):
    hive = client.app.state.hive
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json")], {})
    (tmp_path / "first").mkdir()
    (tmp_path / "first" / "a.json").write_text(json.dumps(SYNTHETIC))
    env["HIVE_REPO_MAP_SEED_DIRS"] = f"{tmp_path / 'nowhere'}:{tmp_path / 'first'}:{tmp_path / 'src'}"
    out = RepoMapSeed(hive, environ=env).run_once()
    assert by_repo(out)["fixture-mini"]["state"] == "seeded"
    assert by_repo(out)["fixture-mini"]["source"] == str(tmp_path / "first" / "a.json")


def test_a_loaded_revision_is_never_changed_only_pinned(client, tmp_path):
    hive = client.app.state.hive
    other_content = dict(copy.deepcopy(SYNTHETIC), reason="a different build of the same sha")
    assert client.post("/api/admin/repo-maps", json=other_content).status_code == 200   # unpinned, different digest
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json")], {"a.json": SYNTHETIC})
    e = by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]
    assert e["state"] == "conflict"
    row = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'fixture-mini'")
    assert row["digest"] == repomap.digest_of(other_content) and row["pinned"] == 0 and row["loaded_by"] != PRINCIPAL
    # same content loaded by an admin, unpinned: the seed pins it through the digest-checked retention pin, nothing else
    env = setup(tmp_path, [entry(other_content, "a.json")], {"a.json": other_content})
    e = by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]
    assert e["state"] == "loaded"
    after = hive.db.one("SELECT * FROM repo_maps WHERE repo = 'fixture-mini'")
    assert after["pinned"] == 1 and {k: after[k] for k in after.keys() if k != "pinned"} == {k: row[k] for k in row.keys() if k != "pinned"}


def test_the_loaders_own_refusals_are_reported_without_loading(client, tmp_path):
    hive = client.app.state.hive
    bad = dict(copy.deepcopy(SYNTHETIC), state="green")       # passes the digest (it is what the manifest pins) but not the loader
    env = setup(tmp_path, [entry(bad, "a.json")], {"a.json": bad})
    e = by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]
    assert e["state"] == "refused" and e["reason"] == "bad_request"
    env = setup(tmp_path, [entry(SYNTHETIC, "a.json", visibility="swarm:s_doesnotexist")], {"a.json": SYNTHETIC})
    e = by_repo(RepoMapSeed(hive, environ=env).run_once())["fixture-mini"]
    assert e["state"] == "refused" and e["reason"] == "bad_request"
    assert counts(hive) == [0, 0, 0, 0]


def test_manifest_validation_and_a_missing_manifest(client, tmp_path):
    hive = client.app.state.hive
    good = entry(SYNTHETIC, "a.json")
    for bad in ({**good, "file": "../a.json"}, {**good, "file": "sub/a.json"}, {**good, "digest": "md5:x"},
                {**good, "sha": "NOT-HEX"}, {**good, "pinned": "yes"}, {**good, "visibility": "public"},
                {**good, "extra": 1}, {k: v for k, v in good.items() if k != "digest"}):
        with pytest.raises(ManifestInvalid):
            parse_manifest(json.dumps({"schema": "repo-map-pins/1", "revisions": [bad]}))
    with pytest.raises(ManifestInvalid):
        parse_manifest(json.dumps({"schema": "repo-map-pins/1", "revisions": [good, good]}))
    env = setup(tmp_path, [{**good, "file": "../pins.json"}], {"a.json": SYNTHETIC})
    out = RepoMapSeed(hive, environ=env).run_once()
    assert out["state"] == "error" and out["error_code"] == "manifest_invalid" and out["entries"] == []
    env["HIVE_REPO_MAP_SEED_MANIFEST"] = str(tmp_path / "absent.json")
    out = RepoMapSeed(hive, environ=env).run_once()
    assert out["state"] == "unavailable" and out["error_code"] == "manifest_missing"
    assert counts(hive) == [0, 0, 0, 0]


def test_the_shipped_manifest_pins_the_five_public_maps():
    revisions = parse_manifest(pathlib.Path(repomap.__file__).with_name("repomap_pinned.json").read_bytes())
    assert {r["repo"] for r in revisions} == {"physixsnet-omegahive", "omegahive-core", "omegahive-rest",
                                              "omegahive-tests", "omegahive-ui"}
    assert all(r["pinned"] and r["visibility"] == "hive" for r in revisions)


def test_the_admin_status_route_is_admin_only(client):
    _, mind_headers, _ = mind(client, "Alpha")
    member = person(client, "u_mem")
    r = client.get("/api/admin/repo-maps/seed")
    assert r.status_code == 200 and r.json()["principal"] == PRINCIPAL
    assert {e["state"] for e in r.json()["entries"]} == {"missing"}   # conftest: the default seed folder is empty
    assert client.get("/api/admin/repo-maps/seed", headers=member).status_code == 403
    assert client.get("/api/admin/repo-maps/seed", headers=mind_headers).status_code == 401


def test_the_hive_seeds_its_pinned_maps_at_start_by_itself(monkeypatch, tmp_path):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    monkeypatch.setenv("HIVE_CODE_CONTROLLER_ENGINE", "0")
    for k, v in setup(tmp_path, [entry(SYNTHETIC, "a.json")], {"a.json": SYNTHETIC}).items():
        monkeypatch.setenv(k, v)
    data = tempfile.mkdtemp(prefix="hive-test-")
    app = create_app(load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA),
                     supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as c:
        hive = app.state.hive
        for _ in range(400):
            if hive.repo_map_seed.status()["state"] in ("ready", "partial", "error", "unavailable"):
                break
            time.sleep(0.05)
        token = c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        status = c.get("/api/admin/repo-maps/seed", headers={"Authorization": f"Bearer {token}"}).json()
        assert status["state"] == "ready" and status["entries"][0]["state"] == "seeded", status
        assert hive.db.one("SELECT loaded_by FROM repo_maps WHERE repo = 'fixture-mini'")["loaded_by"] == PRINCIPAL
        listed = c.get("/api/repo-maps", headers={"Authorization": f"Bearer {token}"}).json()
        assert [(m["repo"], m["pinned"]) for m in listed] == [("fixture-mini", True)]
