"""Release pinning (HIVE_APP_PINS, plan 2026-10-05; Review's Purple disposition 2026-10-06). Synthetic apps only."""
import hashlib
import json

import pytest

from hive.core.hive import HiveError
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

APP = """RAN = True

def describe():
    return {'contract': '0.2', 'kinds': [{'id': 'k', 'role': 'claim'}], 'relations': [], 'actions': []}

def view(ctx, focus=None, stage=None):
    return {'revision': 'r1', 'items': []}

def act(ctx, action, items, params):
    return {'status': 'done'}
"""


def make_app(root, app_id="pinned", body=APP):
    folder = root / app_id
    folder.mkdir(parents=True)
    (folder / "plugin.json").write_text(json.dumps({"id": app_id, "name": app_id.title(), "capabilities": []}))
    (folder / "program.py").write_text(body)
    (folder / "deployment.json").write_text('{"synthetic": true}')
    return folder


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pin_for(programs, folder, **over):
    return {"release": str(folder), "digest": programs.source_digest(folder),
            "files": {"deployment.json": sha(folder / "deployment.json"), "program.py": "sha256:" + sha(folder / "program.py")},
            "env": {"PINNED_SWARMS": '["s_x"]'}, **over}


def mount(client, monkeypatch, dirs, pins, required=False):
    import os
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", os.pathsep.join(str(d) for d in dirs))
    monkeypatch.setenv("HIVE_APP_PINS", json.dumps(pins))
    monkeypatch.setenv("HIVE_APP_PINS_REQUIRED", "1" if required else "0")
    monkeypatch.setenv("PINNED_SWARMS", '["s_x"]')
    client.post("/api/programs/reload").raise_for_status()
    return client.app.state.hive.programs


def listed(client):
    return {p["id"]: p for p in client.get("/api/programs").json()}


def refused(programs, pid, code):
    with pytest.raises(HiveError) as e:
        programs._ready(pid)
    assert e.value.code == code, e.value.code


def test_a_pinned_app_loads_from_its_release(client, tmp_path, monkeypatch):
    release = make_app(tmp_path / "release")
    programs = client.app.state.hive.programs
    programs = mount(client, monkeypatch, [release], {"pinned": pin_for(programs, release)})
    app = listed(client)["pinned"]
    assert app["enabled"] and app["error"] is None and app["digest"] == programs.source_digest(release)
    assert programs._ready("pinned")["module"].RAN


@pytest.mark.parametrize("change, reason", [
    (lambda pin: pin.update(digest="sha256:" + "0" * 64), "source digest differs"),
    (lambda pin: pin["files"].update({"deployment.json": "0" * 64}), "file deployment.json differs"),
    (lambda pin: pin["files"].update({"missing.json": "0" * 64}), "pinned file missing.json is missing"),
    (lambda pin: pin["env"].update(PINNED_SWARMS='["s_other"]'), "environment PINNED_SWARMS is not its pinned value"),
    (lambda pin: pin["env"].update(PINNED_ABSENT="x"), "environment PINNED_ABSENT is not its pinned value"),
    (lambda pin: pin.update(release="/elsewhere/pinned"), "not loaded from its pinned release"),
    (lambda pin: pin.pop("digest"), "the pin is"),
])
def test_any_mismatch_refuses_without_running_the_app(client, tmp_path, monkeypatch, change, reason):
    release = make_app(tmp_path / "release", body=APP + "\nimport os\nos.environ['PINNED_APP_RAN'] = '1'\n")
    monkeypatch.delenv("PINNED_APP_RAN", raising=False)
    pin = pin_for(client.app.state.hive.programs, release)
    change(pin)
    programs = mount(client, monkeypatch, [release], {"pinned": pin})
    app = listed(client)["pinned"]
    assert not app["enabled"] and app["error"].startswith("release_mismatch: ") and reason in app["error"], app["error"]
    assert str(tmp_path) not in app["error"] and "s_x" not in app["error"]           # no outside paths, no values
    import os
    assert "PINNED_APP_RAN" not in os.environ and programs.programs["pinned"]["module"] is None   # never ran
    refused(programs, "pinned", "release_mismatch")
    swarm = client.post("/api/swarms", json={"name": "Pins"}).json()
    r = client.post("/api/programs/pinned/view", json={"swarm_id": swarm["id"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "release_mismatch", r.text


def test_a_pinned_app_not_at_its_release_is_listed_closed(client, tmp_path, monkeypatch):
    release = make_app(tmp_path / "release")
    pin = pin_for(client.app.state.hive.programs, release)
    programs = mount(client, monkeypatch, [], {"pinned": pin})
    assert listed(client)["pinned"]["error"] == "release_mismatch: not found at its pinned release"
    refused(programs, "pinned", "release_mismatch")


def test_a_duplicate_editable_copy_refuses_both(client, tmp_path, monkeypatch):
    release = make_app(tmp_path / "release", body=APP + "\nimport os\nos.environ['PINNED_APP_RAN'] = '1'\n")
    editable = make_app(tmp_path / "editable", body=APP + "\nimport os\nos.environ['PINNED_APP_RAN'] = '1'\n")
    monkeypatch.delenv("PINNED_APP_RAN", raising=False)
    pin = pin_for(client.app.state.hive.programs, release)
    for dirs in ([release, tmp_path / "editable"], [tmp_path / "editable", release]):   # never picks one, either order
        programs = mount(client, monkeypatch, dirs, {"pinned": pin})
        assert listed(client)["pinned"]["error"] == "duplicate_discovery: pinned is pinned but found in 2 places"
        refused(programs, "pinned", "duplicate_discovery")
    import os
    assert "PINNED_APP_RAN" not in os.environ
    assert programs.reload_one("pinned")["error"].startswith("duplicate_discovery")   # reload_one refuses the same way
    assert programs.programs["pinned"]["module"] is None and "PINNED_APP_RAN" not in os.environ


def test_the_atlas_renewal_and_a_pin_must_agree(client, tmp_path, monkeypatch):
    root = tmp_path / "atlas-release"
    release = make_app(root / "programs", "atlas")
    programs = client.app.state.hive.programs
    digest = programs.source_digest(release)
    renewal = {"owner": "user:u_owner", "release": str(root), "digest": digest}
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": renewal}))
    pin = pin_for(programs, release)
    mount(client, monkeypatch, [root / "programs"], {"atlas": pin})
    assert listed(client)["atlas"]["enabled"]                                           # agreeing: loads
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": renewal | {"digest": "sha256:" + "1" * 64}}))
    programs = mount(client, monkeypatch, [root / "programs"], {"atlas": pin})
    assert listed(client)["atlas"]["error"].startswith("pin_conflict: ")
    refused(programs, "atlas", "pin_conflict")
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": renewal | {"release": str(tmp_path / "other")}}))
    programs = mount(client, monkeypatch, [root / "programs"], {"atlas": pin})
    refused(programs, "atlas", "pin_conflict")
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": renewal}))       # renewal alone: as today
    programs = mount(client, monkeypatch, [root / "programs"], {})
    assert listed(client)["atlas"]["enabled"] and programs._ready("atlas")


def test_unpinned_apps_are_unchanged(client, tmp_path, monkeypatch):
    editable = make_app(tmp_path / "editable", "loose")
    release = make_app(tmp_path / "release")
    programs = mount(client, monkeypatch, [editable, release], {"pinned": pin_for(client.app.state.hive.programs, release)})
    apps = listed(client)
    assert apps["loose"]["enabled"] and apps["pinned"]["enabled"] and apps["contract-fixture"]["enabled"]
    (editable / "program.py").write_text(APP + "\n# edited\n")                         # no pin: nothing new rechecked
    assert programs._ready("loose")


def test_the_strict_guard_refuses_every_unpinned_non_builtin_app(client, tmp_path, monkeypatch):
    editable = make_app(tmp_path / "editable", "loose")
    release = make_app(tmp_path / "release")
    pin = {"pinned": pin_for(client.app.state.hive.programs, release)}
    programs = mount(client, monkeypatch, [editable, release], pin, required=True)
    apps = listed(client)
    assert apps["loose"]["error"] == "unpinned: HIVE_APP_PINS_REQUIRED is on"
    assert apps["pinned"]["enabled"] and apps["contract-fixture"]["enabled"]          # builtins are exempt
    refused(programs, "loose", "unpinned")
    monkeypatch.setenv("HIVE_APP_PINS", "not json")                                     # a broken setting fails closed
    client.post("/api/programs/reload").raise_for_status()
    apps = listed(client)
    assert apps["loose"]["error"].startswith("pins_invalid") and apps["pinned"]["error"].startswith("pins_invalid")
    assert apps["contract-fixture"]["enabled"]


def test_a_file_changed_after_loading_closes_the_app_at_serve_and_act_time(client, tmp_path, monkeypatch):
    release = make_app(tmp_path / "release")
    programs = mount(client, monkeypatch, [release], {"pinned": pin_for(client.app.state.hive.programs, release)})
    swarm = client.post("/api/swarms", json={"name": "Pins"}).json()
    assert programs._ready("pinned")
    events = []
    monkeypatch.setattr(programs.hive.events, "publish", lambda kind, **kw: events.append((kind, kw.get("reason"))))
    (release / "deployment.json").write_text('{"synthetic": false}')    # outside the source digest, but pinned
    r = client.post("/api/programs/pinned/act", json={"swarm_id": swarm["id"], "action": "x", "items": []})
    assert r.status_code == 403 and r.json()["error"]["code"] == "release_mismatch", r.text
    assert ("app.release_refused", "release_mismatch: file deployment.json differs from its pin") in events
    (release / "deployment.json").write_text('{"synthetic": true}')     # put back: still closed until a reload
    with pytest.raises(HiveError) as e:
        programs.ui_bundle("pinned")
    assert e.value.code == "release_mismatch"
    client.post("/api/programs/reload").raise_for_status()
    assert programs._ready("pinned")
    monkeypatch.setenv("PINNED_SWARMS", '["s_other"]')                   # the environment is rechecked too
    with pytest.raises(HiveError) as e:
        programs.ui_bundle("pinned")
    assert e.value.code == "release_mismatch"


MARKER = "\nimport os\nos.environ['PINNED_APP_RAN'] = '1'\n"


@pytest.mark.parametrize("required", [False, True])
def test_review_probe_a_declared_null_pin_refuses_before_import(client, tmp_path, monkeypatch, required):
    """Review B1 on ca07d66 (probe review_null_pin.py, adapted: Programs keeps entries in .programs). Only an absent
    id is unpinned; a declared null is a malformed pin and refuses, whether or not pins are required."""
    import os
    release = make_app(tmp_path / "release", body=APP + MARKER)
    monkeypatch.delenv("PINNED_APP_RAN", raising=False)
    programs = mount(client, monkeypatch, [release], {"pinned": None}, required=required)
    assert os.environ.get("PINNED_APP_RAN") is None, "declared malformed pin imported app"
    assert programs.programs["pinned"]["error"].startswith("release_mismatch: the pin is")
    refused(programs, "pinned", "release_mismatch")


BAD = [None, False, [], "", "x", 0, {}, {"release": "relative/path"}]
BAD_FIELDS = [("digest", "sha256:"), ("digest", "sha256:" + "0" * 63), ("digest", "0" * 64), ("release", ""),
              ("files", None), ("files", False), ("files", []), ("files", ""), ("files", {"program.py": ""}),
              ("files", {"program.py": "abc"}), ("files", {"program.py": None}), ("files", {"": "0" * 64}),
              ("env", None), ("env", False), ("env", []), ("env", ""), ("env", {"PINNED_SWARMS": ""}),
              ("env", {"PINNED_SWARMS": None}), ("env", {"PINNED_SWARMS": 0}), ("env", {"": "x"}), ("file", {})]


@pytest.mark.parametrize("required", [False, True])
def test_every_malformed_present_pin_or_field_refuses_before_import(client, tmp_path, monkeypatch, required):
    """Review B1 on ca07d66: a present files/env (or any field) that is malformed refuses; it never becomes 'no check'."""
    import os
    release = make_app(tmp_path / "release", body=APP + MARKER)
    good = pin_for(client.app.state.hive.programs, release)
    cases = [(repr(b), b) for b in BAD] + [(f"{k}={v!r}", {**good, k: v}) for k, v in BAD_FIELDS]
    for label, pin in cases:
        monkeypatch.delenv("PINNED_APP_RAN", raising=False)
        programs = mount(client, monkeypatch, [release], {"pinned": pin}, required=required)
        assert os.environ.get("PINNED_APP_RAN") is None, label
        assert programs.programs["pinned"]["error"].startswith("release_mismatch: the pin is"), (label, programs.programs["pinned"]["error"])
    del good["files"], good["env"]                                     # omitted optional fields keep their meaning
    programs = mount(client, monkeypatch, [release], {"pinned": good}, required=required)
    assert programs.programs["pinned"]["error"] is None and os.environ.get("PINNED_APP_RAN") == "1"


def test_incremental_rollout_reload_one_refuses_a_malformed_pin_before_import(client, tmp_path, monkeypatch):
    """Review B1: with pins not required (the rollout), an app update (reload_one) must refuse a declared null or
    malformed pin before import, like a full reload; an unpinned neighbour still updates as today."""
    import os
    release = make_app(tmp_path / "release", body=APP + MARKER)
    loose = make_app(tmp_path / "editable", "loose")
    for pin in (None, {**pin_for(client.app.state.hive.programs, release), "env": None}):
        monkeypatch.delenv("PINNED_APP_RAN", raising=False)
        programs = mount(client, monkeypatch, [release, loose], {"pinned": pin})
        monkeypatch.delenv("PINNED_APP_RAN", raising=False)
        after = programs.reload_one("pinned")
        assert after["error"] == "release_mismatch: not its pinned release" and not after["enabled"]   # public view
        assert programs.programs["pinned"]["error"].startswith("release_mismatch: the pin is")
        assert os.environ.get("PINNED_APP_RAN") is None and programs.programs["pinned"]["module"] is None
        assert programs.reload_one("loose")["enabled"]
        refused(programs, "pinned", "release_mismatch")


def test_non_admins_see_only_the_code_admins_see_why(client, tmp_path, monkeypatch):
    """Kimi K2 on f254127: env var and file names stay with admins (list/detail, admin-only event); 403 bodies, the
    public program events and a non-admin's app list carry only the code and 'not its pinned release'."""
    from hive.tests.test_visibility import person
    release = make_app(tmp_path / "release")
    pin = pin_for(client.app.state.hive.programs, release)
    pin["env"]["PINNED_SWARMS"] = '["s_other"]'
    programs = mount(client, monkeypatch, [release], {"pinned": pin})
    detail = "release_mismatch: environment PINNED_SWARMS is not its pinned value"
    assert listed(client)["pinned"]["error"] == detail                                    # the local operator is admin
    assert client.get("/api/programs/pinned").json()["error"] == detail
    member = person(client, "u_member", "member")
    generic = "release_mismatch: not its pinned release"
    assert {p["id"]: p for p in client.get("/api/programs", headers=member).json()}["pinned"]["error"] == generic
    assert client.get("/api/programs/pinned", headers=member).json()["error"] == generic
    assert programs.view_of(programs.programs["pinned"])["error"] == generic             # what public events carry
    swarm = client.post("/api/swarms", json={"name": "Pins"}).json()
    r = client.post("/api/programs/pinned/view", json={"swarm_id": swarm["id"]})
    assert r.status_code == 403 and "PINNED_SWARMS" not in r.text and "not its pinned release" in r.text
    # a recheck refusal: the 403 is generic, the detail goes to the admin-only event
    programs = mount(client, monkeypatch, [release], {"pinned": pin_for(programs, release)})
    events = []
    monkeypatch.setattr(programs.hive.events, "publish", lambda kind, **kw: events.append((kind, kw.get("reason"))))
    monkeypatch.setenv("PINNED_SWARMS", '["s_other"]')
    r = client.post("/api/programs/pinned/view", json={"swarm_id": swarm["id"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "release_mismatch" and "PINNED_SWARMS" not in r.text
    assert ("app.release_refused", detail) in events
    from hive.core.visibility import event_rule
    assert event_rule("app.release_refused") == "admin"


@pytest.mark.parametrize("release", ["{r}/../evil", "{r}/./x", "{r}/", "{r}//x"])
def test_a_pin_release_not_in_normal_form_refuses(client, tmp_path, monkeypatch, release):
    """Kimi K4 on f254127: a release with '..', '.', or doubled/trailing slashes refuses before resolve, even when it
    would resolve to the very folder discovered."""
    import os
    root = tmp_path / "releases"
    evil = make_app(root / "evil", "pinned", body=APP + "\nimport os\nos.environ['PINNED_APP_RAN'] = '1'\n")
    (root / "x").mkdir()
    monkeypatch.delenv("PINNED_APP_RAN", raising=False)
    pin = pin_for(client.app.state.hive.programs, evil, release=release.format(r=str(root / "x")))
    programs = mount(client, monkeypatch, [root / "evil"], {"pinned": pin})
    assert programs.programs["pinned"]["error"].startswith("release_mismatch: the pin is")
    assert "PINNED_APP_RAN" not in os.environ


def test_a_renewal_release_with_dot_dot_conflicts(client, tmp_path, monkeypatch):
    """Kimi K4: /releases/x/../evil is never inside /releases/x, and a renewal release not in normal form conflicts."""
    from hive.core.programs import _within
    assert not _within("/releases/x/../evil", "/releases/x") and not _within("/releases/evil", "/releases/x/..")
    assert _within("/releases/x/programs/a", "/releases/x") and _within("/releases/x", "/releases/x")
    root = tmp_path / "atlas-release"
    release = make_app(root / "programs", "atlas")
    programs = client.app.state.hive.programs
    for bad in (str(root / "programs" / ".."), str(root) + "/"):
        monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": {"release": bad, "digest": programs.source_digest(release)}}))
        programs = mount(client, monkeypatch, [root / "programs"], {"atlas": pin_for(programs, release)})
        assert programs.programs["atlas"]["error"].startswith("pin_conflict"), bad
