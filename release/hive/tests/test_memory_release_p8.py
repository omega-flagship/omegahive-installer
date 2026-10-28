"""P8 release metadata: real host load/UI/event seams with invented temporary app files only."""
import json

import pytest

from hive.tests.test_app_ui import install
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_visibility import person
from hive.core.hive import HiveError
from hive.core.visibility import Viewer


def declare(client, app, **themes):
    manifest = {"id": "demo", "name": "Demo", "version": "0.1", **themes}
    (app / "plugin.json").write_text(json.dumps(manifest))
    client.app.state.hive.programs.programs["demo"]["digest"] = client.app.state.hive.programs.source_digest(app)
    return manifest


@pytest.mark.parametrize("theme", [
    {"memory_theme": {"surface": "url(https://example.invalid/pixel)"}},
    {"memory_theme_dark": {"font": "https://example.invalid/font.woff"}},
    {"memory_theme": {"calm": {"dark": {"radius": 33}}}},
    {"memory_theme": {"a": {}, "b": {}, "c": {}, "d": {}, "e": {}}},
])
def test_invalid_theme_is_refused_before_app_code_import(client, tmp_path, theme):
    app = install(client, tmp_path)
    declare(client, app, **theme)
    (app / "program.py").write_text("raise RuntimeError('APP_MODULE_IMPORTED')\n")
    entry = client.app.state.hive.programs._load(app, app / "plugin.json", "test")
    assert entry["module"] is None
    assert "memory theme" in entry["error"] or "memory_theme" in entry["error"]
    assert "APP_MODULE_IMPORTED" not in entry["error"]


def test_ui_release_uses_hashed_manifest_not_mutable_program_context(client, tmp_path):
    app = install(client, tmp_path)
    themes = {"memory_theme": {"accent": "#123456", "calm": {"font": "mono", "dark": {"surface": "#010101"}}},
              "memory_theme_dark": {"surface": "#020202"}}
    declare(client, app, **themes)
    hive = client.app.state.hive
    entry = hive.programs.programs["demo"]
    entry["memory_themes"] = {"memory_theme": {"font": "https://invalid.example/font"}}
    response = client.get("/api/programs/demo/ui")
    assert response.status_code == 200, response.text
    assert response.json()["release"] == {"digest": hive.programs.source_digest(app), **themes}
    assert set(response.json()) == {"program", "files", "release"}


@pytest.mark.parametrize("changed", [
    {"memory_theme": {"accent": "#123456"}},
    {"memory_theme_dark": {"accent": "#123456"}},
    {"memory_theme": {"calm": {"accent": "#123456"}}},
])
def test_every_theme_branch_changes_release_and_refuses_old_loaded_bundle(client, tmp_path, changed):
    app = install(client, tmp_path)
    hive = client.app.state.hive
    old_digest = hive.programs.programs["demo"]["digest"]
    manifest = json.loads((app / "plugin.json").read_text())
    (app / "plugin.json").write_text(json.dumps({**manifest, **changed}))
    assert hive.programs.source_digest(app) != old_digest
    response = client.get("/api/programs/demo/ui")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "app_integrity"


def test_ui_snapshot_recheck_refuses_manifest_change_during_bundle_read(client, tmp_path, monkeypatch):
    app = install(client, tmp_path)
    hive = client.app.state.hive
    original = hive.programs._ui_identity
    injected = []

    def change_after_capture(program_id, entry, lock, lock_bytes, bundle):
        assert not injected
        injected.append("manifest changed")
        manifest = json.loads((app / "plugin.json").read_text())
        (app / "plugin.json").write_text(json.dumps({**manifest, "memory_theme": {"accent": "#123456"}}))
        return original(program_id, entry, lock, lock_bytes, bundle)

    monkeypatch.setattr(hive.programs, "_ui_identity", change_after_capture)
    response = client.get("/api/programs/demo/ui")
    assert injected == ["manifest changed"]
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "app_integrity"


@pytest.mark.parametrize("change", ["reload", "reload_one", "uninstall"])
def test_release_change_event_reaches_member_and_contains_no_theme_or_memory(client, tmp_path, monkeypatch, change):
    app = install(client, tmp_path)
    (app / "program.py").write_text(
        "def describe():\n    return {'kinds': [{'id': 'note', 'role': 'claim'}], 'relations': [], 'actions': []}\n"
        "def view(ctx, focus, stage):\n    return {}\n"
        "def act(ctx, action, items, params):\n    return {}\n")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    hive = client.app.state.hive
    hive.programs.reload()
    headers = person(client, "u_p8_member")
    token = headers["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        if change == "uninstall":
            hive.programs.uninstall("demo", by="user:operator")
        else:
            manifest = json.loads((app / "plugin.json").read_text())
            (app / "plugin.json").write_text(json.dumps({**manifest, "memory_theme_dark": {"accent": "#123456"}}))
            (hive.programs.reload if change == "reload" else lambda: hive.programs.reload_one("demo"))()
        hive.events.publish("programs.updated", programs=[], p8_marker="after change")
        events = []
        for _ in range(20):
            event = json.loads(ws.receive_text())
            if event.get("p8_marker") == "after change":
                break
            events.append(event)
        else:
            raise AssertionError("same-queue marker missing")
    changed = [e for e in events if e["type"] == "program.release_changed" and e["program"] == "demo"]
    assert len(changed) == 1
    assert set(changed[0]) == {"type", "at", "program", "digest"}
    assert changed[0]["digest"] == (None if change == "uninstall" else hive.programs.programs["demo"]["digest"])


@pytest.mark.parametrize("change", ["disable", "uninstall", "missing_reload_one"])
def test_member_teardown_event_stays_visible_after_authority_or_source_is_removed(client, tmp_path, monkeypatch, change):
    app = install(client, tmp_path)
    (app / "program.py").write_text(
        "def describe():\n    return {'kinds': [{'id': 'note', 'role': 'claim'}], 'relations': [], 'actions': []}\n"
        "def view(ctx, focus, stage):\n    return {}\n"
        "def act(ctx, action, items, params):\n    return {}\n")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    hive = client.app.state.hive
    hive.programs.reload()
    captured = []
    publish = hive.events.publish

    def capture(kind, **payload):
        captured.append(dict(type=kind, at="2026-10-25T00:00:00Z", **payload))
        publish(kind, **payload)

    monkeypatch.setattr(hive.events, "publish", capture)
    if change == "disable":
        hive.programs.set_enabled("demo", False, by="user:operator")
        event = next(e for e in captured if e["type"] == "program.updated")
        assert event["program"]["id"] == "demo" and event["program"]["enabled"] is False
        assert set(event["program"]).isdisjoint({"path", "memory_theme", "memory_theme_dark"})
    else:
        if change == "uninstall":
            hive.programs.uninstall("demo", by="user:operator")
        else:
            (app / "plugin.json").unlink()
            with pytest.raises(HiveError):
                hive.programs.reload_one("demo")
        assert "demo" not in hive.programs.programs
        event = next(e for e in captured if e["type"] == "program.release_changed")
        assert set(event) == {"type", "at", "program", "digest"}
        assert event["program"] == "demo" and event["digest"] is None
    # The real public event rule must not look up an enabled/current program after it has just disappeared.
    assert hive.visibility.event_visible(Viewer("user:u_p8_member", False), json.dumps(event)) is True


@pytest.mark.parametrize("reload_kind", ["reload", "reload_one"])
def test_unchanged_reload_does_not_publish_release_change(client, tmp_path, monkeypatch, reload_kind):
    app = install(client, tmp_path)
    (app / "program.py").write_text(
        "def describe():\n    return {'kinds': [{'id': 'note', 'role': 'claim'}], 'relations': [], 'actions': []}\n"
        "def view(ctx, focus, stage):\n    return {}\n"
        "def act(ctx, action, items, params):\n    return {}\n")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path))
    hive = client.app.state.hive
    hive.programs.reload()
    digest = hive.programs.programs["demo"]["digest"]
    events = []
    publish = hive.events.publish

    def capture(kind, **payload):
        events.append(dict(type=kind, **payload))
        publish(kind, **payload)

    monkeypatch.setattr(hive.events, "publish", capture)
    (hive.programs.reload if reload_kind == "reload" else lambda: hive.programs.reload_one("demo"))()
    assert hive.programs.programs["demo"]["digest"] == digest
    assert not [e for e in events if e["type"] == "program.release_changed" and e["program"] == "demo"]
