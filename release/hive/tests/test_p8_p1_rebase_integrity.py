"""Unrun P1/P8 integration source regressions using invented app bytes only.

These cover the joined captured-UI-lock and hashed-manifest boundary, not a
new application capability or any model/provider execution.
"""
import json

import pytest

from hive.core.programs import Programs
from hive.tests.test_app_ui import install as install_single
from hive.tests.test_app_ui_parts import bundle as parts_bundle, install as install_parts
from hive.tests.test_core_api import client  # noqa: F401


def install_theme(client, tmp_path, mode):
    app = (install_parts(client, tmp_path, parts_bundle()) if mode == "parts"
           else install_single(client, tmp_path))
    themes = {"memory_theme": {"accent": "#123456"},
              "memory_theme_dark": {"surface": "#010101"}}
    (app / "plugin.json").write_text(json.dumps({"id": "demo", "name": "Demo", "version": "0.1", **themes}))
    programs = client.app.state.hive.programs
    entry = programs.programs["demo"]
    entry["digest"] = programs.source_digest(app)
    return app, programs, entry, themes


def test_source_snapshot_keeps_manifest_capture_and_ui_lock_override(tmp_path):
    app = tmp_path / "snapshot"
    (app / "ui").mkdir(parents=True)
    manifest = b'{"id":"demo","memory_theme":{"accent":"#123456"}}'
    (app / "plugin.json").write_bytes(manifest)
    (app / "program.py").write_text("def view(ctx, focus, stage): return {}\n")
    lock = app / "ui" / "bundle.lock.json"
    captured_lock = b'{"files":{"app.js":"reviewed-fixture"}}'
    lock.write_bytes(captured_lock)
    expected = Programs.source_digest(app)
    lock.write_bytes(b'{"files":{"app.js":"other-fixture"}}')
    digest, captured_manifest = Programs._source_snapshot(app, ui_lock_bytes=captured_lock)
    assert isinstance(expected, str) and digest == expected
    assert captured_manifest == manifest
    assert Programs.source_digest(app, ui_lock_bytes=captured_lock) == expected
    assert Programs.source_digest(app) != expected
    changed_manifest = b'{"id":"demo","memory_theme":{"accent":"#abcdef"}}'
    (app / "plugin.json").write_bytes(changed_manifest)
    changed_digest, changed_capture = Programs._source_snapshot(app, ui_lock_bytes=captured_lock)
    assert changed_capture == changed_manifest and changed_digest != expected


@pytest.mark.parametrize("mode", ["single", "parts"])
def test_pinned_ui_keeps_p1_identity_and_p8_hashed_theme(client, tmp_path, monkeypatch, mode):
    _app, programs, entry, themes = install_theme(client, tmp_path, mode)
    expected = {"digest": entry["digest"], "version": entry["version"], **themes}
    # This is the same synthetic catalog seam as the retained P1 source tests.
    monkeypatch.setattr(programs, "pinned_release",
                        lambda _program: {"digest": entry["digest"], "version": entry["version"], "files": {}})
    entry["memory_themes"] = {"memory_theme": {"font": "https://invalid.example/font"}}
    response = client.get("/api/programs/demo/ui")
    assert response.status_code == 200, response.text
    assert response.json()["release"] == expected
    assert response.json()["files"]["app.js"]


@pytest.mark.parametrize("mode", ["single", "parts"])
def test_memory_metadata_never_bypasses_returned_ui_lock(client, tmp_path, monkeypatch, mode):
    _app, programs, _entry, _themes = install_theme(client, tmp_path, mode)
    original = programs._ui_identity
    injected = []

    def changed_returned_bytes(program_id, entry, lock, lock_bytes, bundle):
        assert not injected
        injected.append("returned bytes changed")
        changed = dict(bundle, files={**bundle["files"], "app.js": "console.log('different synthetic bytes')"})
        return original(program_id, entry, lock, lock_bytes, changed)

    monkeypatch.setattr(programs, "_ui_identity", changed_returned_bytes)
    response = client.get("/api/programs/demo/ui")
    assert injected == ["returned bytes changed"]
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "app_integrity"
