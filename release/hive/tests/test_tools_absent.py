# Purpose: tests of GET /api/tools on a hive without the Tools package: no Tools app at all is an empty catalogue, which
# the Tools page shows as "No tools yet", while a Tools app pinned but not found still needs its admin (409).
import json
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import PETTA, FakeSupervisor

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def tools_answer(monkeypatch, pins=None):
    for name in ("HIVE_PLUGIN_DIRS", "HIVE_APP_PINS", "HIVE_APP_PINS_REQUIRED"):
        monkeypatch.delenv(name, raising=False)
    if pins is not None:
        monkeypatch.setenv("HIVE_APP_PINS", json.dumps(pins))
    # the hive's data folder lives only as long as this test's client: removed afterwards, never left behind
    with tempfile.TemporaryDirectory(prefix="hive-test-", ignore_cleanup_errors=True) as folder:
        app = create_app(load_settings(data_dir=pathlib.Path(folder), admin_password="pw", petta_path=PETTA),
                         supervisor=FakeSupervisor(), reconcile_seconds=0)
        with TestClient(app) as client:
            token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
            return client.get("/api/tools", headers={"Authorization": f"Bearer {token}"})


def test_a_hive_without_the_tools_app_has_an_empty_catalogue(monkeypatch):
    answer = tools_answer(monkeypatch)
    assert answer.status_code == 200 and answer.json()["items"] == [], answer.json()


def test_a_tools_app_pinned_but_not_found_still_needs_its_admin(monkeypatch, tmp_path):
    pin = {"release": str(tmp_path / "omega-tools"), "digest": "sha256:" + "0" * 64}
    answer = tools_answer(monkeypatch, {"omega-tools": pin})
    assert answer.status_code == 409, answer.json()
    assert answer.json()["error"]["code"] == "tools_review_required"
