"""Linked local folders (hive/core/folders.py): local hives only, read-only by default, write receipts, realpath
confinement, default exclusions, the assets visibility rule, ranges, and the hard-deny list. Everything here is an
invented folder under pytest's tmp_path, with HOME pointed at an invented home."""
import hashlib
import os

import pytest

from hive.core import folders as folders_mod
from hive.tests.test_asset_streaming import asgi_call, generated
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


@pytest.fixture()
def tree(tmp_path, monkeypatch):
    home = tmp_path / "home"
    proj = home / "work" / "proj"
    (proj / "sub").mkdir(parents=True)
    (proj / ".git").mkdir()
    (proj / ".git" / "config").write_text("[core]")
    (proj / "readme.txt").write_text("hello from an invented project\n")
    (proj / ".env").write_text("TOKEN=invented")
    (proj / "id_rsa").write_text("invented key")
    (proj / "server.pem").write_text("invented cert")
    (proj / "api.KEY").write_text("invented")
    (proj / "sub" / "data.bin").write_bytes(bytes(range(256)) * 4096)   # 1 MiB
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside the root")
    os.symlink(outside / "secret.txt", proj / "link_out")
    os.symlink(outside, proj / "dir_out")
    os.symlink(proj / "readme.txt", proj / "link_in")
    os.symlink(proj / ".env", proj / "link_env")
    monkeypatch.setenv("HOME", str(home))
    return {"home": home, "proj": proj, "outside": outside, "tmp": tmp_path}


def swarm(client, headers=None, name="Makers"):
    return client.post("/api/swarms", json={"name": name}, **({"headers": headers} if headers else {})).json()


def link(client, path, swarm_id, **kw):
    return client.post("/api/folders", json={"path": str(path), "swarm_id": swarm_id, **kw})


def test_link_browse_and_default_exclusions(client, tree):
    s = swarm(client)
    f = link(client, tree["proj"], s["id"], label="Project").json()
    assert f["writable"] is False and f["scope"] == "this_machine_only" and f["root"] == os.path.realpath(tree["proj"])
    listing = client.get(f"/api/folders/{f['id']}/list").json()
    assert {i["name"] for i in listing["items"]} == {"readme.txt", "sub", "link_in"}
    assert listing["hidden"] == 8 and listing["scope"] == "this_machine_only"
    assert [i["name"] for i in client.get(f"/api/folders/{f['id']}/list?path=sub").json()["items"]] == ["data.bin"]
    r = client.get(f"/api/folders/{f['id']}/file?path=readme.txt")
    assert r.status_code == 200 and r.text.startswith("hello") and r.headers["x-hive-scope"] == "this_machine_only"
    assert r.headers["content-disposition"].startswith("attachment") and r.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/api/folders/{f['id']}/file?path=link_in").text.startswith("hello")   # a link that stays inside
    for hidden in (".env", ".git/config", "id_rsa", "server.pem", "api.KEY", "link_env", "sub/../.env"):
        got = client.get(f"/api/folders/{f['id']}/file?path={hidden}")
        assert got.status_code == 403 and got.json()["error"]["code"] in ("excluded", "path_outside"), hidden
    assert [x["id"] for x in client.get("/api/folders").json()["folders"]] == [f["id"]]


def test_escape_attempts_are_refused(client, tree):
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    for bad in ("../outside/secret.txt", "sub/../../outside/secret.txt", "../../..", str(tree["outside"] / "secret.txt"),
                "/etc/passwd", "~/work", "link_out", "dir_out/secret.txt"):
        r = client.get(f"/api/folders/{f['id']}/file", params={"path": bad})
        assert r.status_code == 403 and r.json()["error"]["code"] == "path_outside", (bad, r.text)
    assert client.get(f"/api/folders/{f['id']}/list", params={"path": "dir_out"}).status_code == 403
    # the root swapped for a link after linking is noticed
    real = tree["proj"].rename(tree["tmp"] / "moved")
    os.symlink(tree["outside"], tree["proj"])
    r = client.get(f"/api/folders/{f['id']}/list")
    assert r.status_code == 409 and r.json()["error"]["code"] == "folder_changed"
    assert real.exists()


def test_big_files_are_read_in_ranges(client, tree, monkeypatch):
    monkeypatch.setattr(folders_mod, "CHUNK", 4096)
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    data = (tree["proj"] / "sub" / "data.bin").read_bytes()
    whole = client.get(f"/api/folders/{f['id']}/file?path=sub/data.bin")
    assert whole.content == data and whole.headers["accept-ranges"] == "bytes"
    part = client.get(f"/api/folders/{f['id']}/file?path=sub/data.bin", headers={"Range": "bytes=1000-1999"})
    assert part.status_code == 206 and part.content == data[1000:2000]
    assert part.headers["content-range"] == f"bytes 1000-1999/{len(data)}"
    tail = client.get(f"/api/folders/{f['id']}/file?path=sub/data.bin", headers={"Range": "bytes=-10"})
    assert tail.content == data[-10:]
    assert client.get(f"/api/folders/{f['id']}/file?path=sub/data.bin", headers={"Range": f"bytes={len(data)}-"}).status_code == 416


def test_read_only_by_default_and_every_write_has_a_receipt(client, tree):
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    r = client.put(f"/api/folders/{f['id']}/file?path=notes.txt", content=b"first")
    assert r.status_code == 403 and r.json()["error"]["code"] == "read_only" and not (tree["proj"] / "notes.txt").exists()
    assert client.post(f"/api/folders/{f['id']}/write", json={"writable": True}).json()["writable"] is True
    first = client.put(f"/api/folders/{f['id']}/file?path=notes.txt", content=b"first").json()
    assert first["sha256_before"] is None and first["sha256_after"] == hashlib.sha256(b"first").hexdigest()
    assert first["by"] == "user:operator" and first["path"] == "notes.txt" and first["bytes"] == 5 and first["at"]
    second = client.put(f"/api/folders/{f['id']}/file?path=notes.txt", content=b"second").json()
    assert second["sha256_before"] == first["sha256_after"] and second["sha256_after"] == hashlib.sha256(b"second").hexdigest()
    assert (tree["proj"] / "notes.txt").read_bytes() == b"second"
    receipts = client.get(f"/api/folders/{f['id']}/receipts").json()
    assert [x["id"] for x in receipts] == [second["id"], first["id"]]
    for bad, code in (("../escape.txt", "path_outside"), (".env", "excluded"), ("new.pem", "excluded"),
                      ("link_in", "not_a_file"), ("link_out", "path_outside"), ("missing/x.txt", "not_found"), ("sub", "not_a_file")):
        got = client.put(f"/api/folders/{f['id']}/file", params={"path": bad}, content=b"x")
        assert got.json()["error"]["code"] == code, (bad, got.text)
    assert (tree["proj"] / ".env").read_text() == "TOKEN=invented" and not (tree["tmp"] / "home" / "work" / "escape.txt").exists()
    assert client.post(f"/api/folders/{f['id']}/write", json={"writable": False}).json()["writable"] is False
    assert client.put(f"/api/folders/{f['id']}/file?path=notes.txt", content=b"third").status_code == 403
    assert [h["event"] for h in client.get("/api/folders").json()["folders"][0]["history"]] == ["linked", "write_on", "write_off"]
    assert not [p for p in tree["proj"].iterdir() if p.name.startswith(".omegahive-write-")]


def test_an_aborted_write_leaves_the_file_and_no_temp(client, tree):
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    chunks, _ = generated(8 * 256 * 1024)
    out = asgi_call(client, "PUT", f"/api/folders/{f['id']}/file", "path=readme.txt", {"content-type": "application/octet-stream"}, chunks, disconnect_after=2)
    assert out["status"] != 200
    assert (tree["proj"] / "readme.txt").read_text().startswith("hello")
    assert not [p for p in tree["proj"].iterdir() if p.name.startswith(".omegahive-write-")]
    assert client.get(f"/api/folders/{f['id']}/receipts").json() == []


def test_visibility_follows_the_owner_swarm(client, tree):
    ann, bob = person(client, "u_ann_lf"), person(client, "u_bob_lf")
    s = swarm(client, ann, "Ann's")
    assert link(client, tree["proj"], s["id"]).status_code == 200
    assert client.post("/api/folders", headers=ann, json={"path": str(tree["outside"]), "swarm_id": s["id"]}).status_code == 403   # admins link
    f = client.get("/api/folders").json()["folders"][0]
    assert [x["id"] for x in client.get("/api/folders", headers=ann).json()["folders"]] == [f["id"]]
    assert client.get("/api/folders", headers=bob).json()["folders"] == []
    assert client.get(f"/api/folders/{f['id']}/list", headers=ann).status_code == 200
    for route in ("list", "file?path=readme.txt", "receipts"):
        assert client.get(f"/api/folders/{f['id']}/{route}", headers=bob).status_code == 404
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    assert client.put(f"/api/folders/{f['id']}/file?path=b.txt", headers=bob, content=b"x").status_code == 404
    # admins write by default; a member who sees the swarm is refused until the folder lets swarm members write
    assert f["writers"] == "admins"
    refused = client.put(f"/api/folders/{f['id']}/file?path=a.txt", headers=ann, content=b"x")
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "admins_write_only"
    assert not (tree["proj"] / "a.txt").exists()
    assert client.post(f"/api/folders/{f['id']}/write", headers=ann, json={"writers": "swarm_members"}).status_code == 403
    assert client.post(f"/api/folders/{f['id']}/write", json={"writers": "everyone"}).status_code == 400
    changed = client.post(f"/api/folders/{f['id']}/write", json={"writers": "swarm_members"}).json()
    assert changed["writers"] == "swarm_members" and changed["writable"] is True and changed["history"][-1]["event"] == "writers"
    assert client.put(f"/api/folders/{f['id']}/file?path=a.txt", headers=ann, content=b"x").json()["by"] == "user:u_ann_lf"
    assert client.put(f"/api/folders/{f['id']}/file?path=b.txt", headers=bob, content=b"x").status_code == 404   # still unseen
    client.post(f"/api/folders/{f['id']}/write", json={"writers": "admins"})
    assert client.put(f"/api/folders/{f['id']}/file?path=a.txt", headers=ann, content=b"y").status_code == 403
    assert client.delete(f"/api/folders/{f['id']}", headers=ann).status_code == 403
    assert client.post(f"/api/folders/{f['id']}/write", headers=bob, json={"writable": True}).status_code == 403
    # minds: their own swarm only
    own = client.post("/api/agents", json={"name": "Reader", "kind": "module", "swarm_id": s["id"]}).json()
    other = client.post("/api/agents", json={"name": "Other", "kind": "module", "swarm_id": swarm(client, name="Else")["id"]}).json()
    assert client.get(f"/api/agent/folders/{f['id']}/file?path=readme.txt", headers=agent_headers(own)).text.startswith("hello")
    assert [x["id"] for x in client.get("/api/agent/folders", headers=agent_headers(own)).json()] == [f["id"]]
    assert client.get(f"/api/agent/folders/{f['id']}/list", headers=agent_headers(other)).status_code == 404
    assert client.get("/api/agent/folders", headers=agent_headers(other)).json() == []
    assert client.delete(f"/api/folders/{f['id']}").json()["unlinked"] is True
    assert client.get(f"/api/folders/{f['id']}/list", headers=ann).status_code == 404


def test_a_hive_that_is_not_local_refuses(client, tree, monkeypatch):
    s = swarm(client)
    f = link(client, tree["proj"], s["id"]).json()
    client.app.state.hive.settings.public_url = "https://hive.example.test"
    r = link(client, tree["outside"], s["id"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "local_hive_only"
    assert client.get("/api/folders").json() == {"local": False, "scope": "this_machine_only", "folders": []}
    assert client.get(f"/api/folders/{f['id']}/list").status_code == 403
    client.app.state.hive.settings.public_url = "http://127.0.0.1:8700"
    monkeypatch.setenv("HIVE_HOST", "0.0.0.0")
    assert client.get(f"/api/folders/{f['id']}/file?path=readme.txt").status_code == 403


def test_the_hard_deny_list_cannot_be_linked(client, tree):
    s = swarm(client)["id"]
    home = tree["home"]
    for name in ("atlas", "ATLAS/inner", ".ssh", ".claude", ".claude-sessions", ".gnupg", "Library/Keychains", "work/OmegaTruth-demo",
                 "work/omega_truth/x"):
        (home / name).mkdir(parents=True, exist_ok=True)
    (home / "work" / "holder").mkdir()
    (home / "work" / "holder" / "OmegaTruth").mkdir()
    os.symlink(home / "atlas", home / "work" / "alias")
    data_dir = client.app.state.hive.settings.data_dir
    for bad in (home / "atlas", home / "ATLAS" / "inner", home / ".ssh", home / ".claude", home / ".claude-sessions", home / ".gnupg",
                home / "Library" / "Keychains", home / "work" / "OmegaTruth-demo", home / "work" / "omega_truth" / "x",
                home / "work" / "holder", home / "work" / "alias", home, home / "work" / "..", "/", "/etc", data_dir, "~/.ssh"):
        r = link(client, bad, s)
        assert r.status_code == 403 and r.json()["error"]["code"] == "folder_denied", (bad, r.text)
    assert link(client, "relative/path", s).status_code == 400
    assert link(client, tree["proj"], "s_nope").status_code == 400
    assert link(client, home / "work" / "nowhere", s).status_code == 404
    ok = link(client, tree["proj"], s)
    assert ok.status_code == 200 and link(client, tree["proj"], s).status_code == 409


def test_leftover_write_temp_files_are_swept(client, tree, caplog):
    import logging
    import time
    proj, outside = tree["proj"], tree["outside"]
    old_time = time.time() - 2 * 3600
    stale = [proj / ".omegahive-write-abc.part", proj / "sub" / ".omegahive-write-def.part"]
    for p in stale:
        p.write_bytes(b"left by a crash")
        os.utime(p, (old_time, old_time))
    fresh = proj / ".omegahive-write-new.part"
    fresh.write_bytes(b"a write still arriving")
    lookalikes = [proj / "omegahive-write-x.part", proj / ".omegahive-write-x.partial", proj / "notes.part"]
    for p in lookalikes:
        p.write_bytes(b"not ours")
        os.utime(p, (old_time, old_time))
    beyond = outside / ".omegahive-write-out.part"     # reachable only through the dir_out symlink
    beyond.write_bytes(b"outside")
    os.utime(beyond, (old_time, old_time))
    os.symlink(beyond, proj / ".omegahive-write-link.part")  # a matching link is never removed
    os.utime(proj / ".omegahive-write-link.part", (old_time, old_time), follow_symlinks=False)
    caplog.set_level(logging.INFO, logger="hive.folders")
    f = link(client, proj, swarm(client)["id"]).json()           # linking sweeps (in the background)
    for t in client.app.state.hive.folders.sweeps:
        t.join(10)
    assert not any(p.exists() for p in stale)
    assert fresh.exists() and all(p.exists() for p in lookalikes) and beyond.exists()
    assert os.path.islink(proj / ".omegahive-write-link.part")
    assert any("folder sweep" in r.message and "removed 2" in r.message for r in caplog.records)
    # the start-of-hive sweep covers every linked folder
    again = proj / ".omegahive-write-later.part"
    again.write_bytes(b"x")
    os.utime(again, (old_time, old_time))
    t = client.app.state.hive.folders.sweep_later()
    t.join(10)
    assert not again.exists() and f["id"]


def test_review_deny_rules_atlas_prefix_dot_roots_library_and_allowlist(client, tree, monkeypatch):
    s = swarm(client)["id"]
    home, proj = tree["home"], tree["proj"]
    for name in ("work/Atlas-demo", "work/atlas2/x", "work/.hidden", ".omegadots/hive2", ".config",
                 "Library/Application Support/Google", "Library/Keychains"):
        (home / name).mkdir(parents=True, exist_ok=True)
        r = link(client, home / name, s)
        assert r.status_code == 403 and r.json()["error"]["code"] == "folder_denied", (name, r.text)
    # an atlas-named file inside a linked folder is neither listed nor read
    (proj / "Atlas-notes.txt").write_text("invented")
    f = link(client, proj, s).json()
    assert "Atlas-notes.txt" not in {i["name"] for i in client.get(f"/api/folders/{f['id']}/list").json()["items"]}
    assert client.get(f"/api/folders/{f['id']}/file?path=Atlas-notes.txt").json()["error"]["code"] == "folder_denied"
    # the operator allowlist: only roots under it may be linked, and a folder outside it stops being readable
    allowed = home / "work" / "allowed"
    allowed.mkdir()
    monkeypatch.setenv("HIVE_LINKED_FOLDERS_ALLOW", str(allowed))
    assert link(client, tree["outside"], s).json()["error"]["code"] == "folder_not_allowed"
    assert link(client, allowed, s).status_code == 200
    assert client.get(f"/api/folders/{f['id']}/list").json()["error"]["code"] == "folder_not_allowed"
    monkeypatch.setenv("HIVE_LINKED_FOLDERS_ALLOW", "relative/only")   # set but unusable: nothing may be linked
    assert link(client, home / "work" / "nowhere-else", s).status_code in (403, 404)
    (home / "work" / "other").mkdir()
    assert link(client, home / "work" / "other", s).json()["error"]["code"] == "folder_not_allowed"


def test_a_parent_swapped_for_a_link_mid_write_is_refused(client, tree):
    hive = client.app.state.hive
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    row = hive.folders.row(f["id"])
    job = hive.folders.begin_write(row, "sub/evil.txt", True)
    job.spool.write(b"must not land outside")
    moved = tree["tmp"] / "sub_moved"
    os.rename(tree["proj"] / "sub", moved)            # the held parent leaves the root...
    os.symlink(tree["outside"], tree["proj"] / "sub")  # ...and a link to the outside takes its place
    with pytest.raises(Exception) as exc:
        hive.folders.finish_write(row, job, "user:operator", True)
    assert getattr(exc.value, "code", "") == "path_outside" or "path_outside" in str(exc.value)
    assert not (tree["outside"] / "evil.txt").exists() and not (moved / "evil.txt").exists()
    assert not [p for p in list(moved.iterdir()) + list(tree["outside"].iterdir()) if p.name.endswith(".part")]
    assert job.parent_fd is None   # the descriptor was released


def test_hard_links_are_refused_on_read_and_write(client, tree):
    os.link(tree["outside"] / "secret.txt", tree["proj"] / "hl.txt")
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    r = client.get(f"/api/folders/{f['id']}/file?path=hl.txt")
    assert r.status_code == 403 and r.json()["error"]["code"] == "hard_link" and b"outside" not in r.content
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    w = client.put(f"/api/folders/{f['id']}/file?path=hl.txt", content=b"overwrite")
    assert w.status_code == 403 and w.json()["error"]["code"] == "hard_link"
    assert (tree["outside"] / "secret.txt").read_text() == "outside the root"


def test_non_latin1_filenames_are_served(client, tree):
    (tree["proj"] / "café 日本.txt").write_text("bonjour")
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    r = client.get(f"/api/folders/{f['id']}/file", params={"path": "café 日本.txt"})
    assert r.status_code == 200 and r.text == "bonjour"
    cd = r.headers["content-disposition"]
    assert "filename*=UTF-8''caf%C3%A9%20%E6%97%A5%E6%9C%AC.txt" in cd and 'filename="caf_ __.txt"' in cd
    sha = client.post("/api/assets", params={"name": "café 日本.txt"}, content=b"x", headers={"content-type": "text/plain"}).json()["sha256"]
    assert "filename*=UTF-8''caf%C3%A9" in client.get(f"/api/assets/{sha}").headers["content-disposition"]


def test_the_free_space_floor_refuses_folder_writes(client, tree):
    import shutil
    hive = client.app.state.hive
    f = link(client, tree["proj"], swarm(client)["id"]).json()
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    hive.settings.min_free_bytes = shutil.disk_usage(tree["proj"]).free + 10 * 1024 ** 3
    r = client.put(f"/api/folders/{f['id']}/file?path=new.txt", content=b"x")
    assert r.status_code == 507 and r.json()["error"]["code"] == "insufficient_storage"
    assert not (tree["proj"] / "new.txt").exists() and not [p for p in tree["proj"].iterdir() if p.name.endswith(".part")]
    hive.settings.min_free_bytes = 0
    assert client.put(f"/api/folders/{f['id']}/file?path=new.txt", content=b"x").status_code == 200


def test_requests_through_a_proxy_are_refused_unless_remote_is_on(client, tree):
    ann = person(client, "u_ann_px")
    s = swarm(client, ann, "Ann's proxy")
    f = link(client, tree["proj"], s["id"]).json()
    proxied = dict(ann, **{"X-Forwarded-For": "203.0.113.9"})
    assert client.get(f"/api/folders/{f['id']}/file?path=readme.txt", headers=ann).status_code == 200
    r = client.get(f"/api/folders/{f['id']}/file?path=readme.txt", headers=proxied)
    assert r.status_code == 403 and r.json()["error"]["code"] == "local_hive_only"
    assert client.get("/api/folders", headers=proxied).json()["local"] is False
    client.app.state.hive.settings.linked_folders_remote = True
    assert client.get(f"/api/folders/{f['id']}/file?path=readme.txt", headers=proxied).text.startswith("hello")
    client.post(f"/api/folders/{f['id']}/write", json={"writable": True})
    w = client.put(f"/api/folders/{f['id']}/file?path=r.txt", headers=proxied, content=b"x")
    assert w.status_code == 403 and w.json()["error"]["code"] == "admins_write_only"   # writes still admin-or-setting
