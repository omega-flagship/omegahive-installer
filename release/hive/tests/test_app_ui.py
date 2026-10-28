"""An app's own interface: three pinned files from ui/, served only when they match ui/bundle.lock.json."""
import hashlib
import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)

FILES = {"index.html": '<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>',
         "app.js": "console.log('hi')", "style.css": "body{}"}


def install(client, tmp_path, files=FILES, lock=True):
    app = tmp_path / "demo-app"
    (app / "ui").mkdir(parents=True)
    (app / "plugin.json").write_text(json.dumps({"id": "demo", "name": "Demo", "version": "0.1"}))
    for n, t in files.items():
        (app / "ui" / n).write_text(t)
    if lock:
        (app / "ui" / "bundle.lock.json").write_text(json.dumps({"files": {n: hashlib.sha256(t.encode()).hexdigest() for n, t in files.items()}}))
    hive = client.app.state.hive
    hive.programs.programs["demo"] = {"id": "demo", "name": "Demo", "version": "0.1", "description": "", "icon": None,
                                      "capabilities": [], "source": "test", "path": str(app), "module": None, "error": None,
                                      "digest": hive.programs.source_digest(app)}
    return app


def test_verified_ui_is_served_and_listed(client, tmp_path):
    install(client, tmp_path)
    out = client.get("/api/programs/demo/ui").json()
    assert out["files"]["app.js"] == "console.log('hi')"
    assert client.app.state.hive.programs.view_of(client.app.state.hive.programs.programs["demo"])["ui"] is True


def test_changed_or_unlocked_ui_is_refused(client, tmp_path):
    app = install(client, tmp_path)
    (app / "ui" / "app.js").write_text("fetch('https://evil')")
    assert client.get("/api/programs/demo/ui").status_code == 404
    install(client, tmp_path / "b", lock=False)
    assert client.get("/api/programs/demo/ui").status_code == 404
