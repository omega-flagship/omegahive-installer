"""With the UI built (as every deployed hive is), an unknown address answers with the hive's own 404. That answer must
never repeat a mind token found in the path: the body can end up in a client log, a proxy or an error reporter (r1c).
The suite's other gateway tests run without a built UI, so this one covers the production setup."""
import pytest

TOKEN = "mt_" + "ac5axYwZyyMwq2huvw71w-wYzkbufnPkNNY1PcxK5qQ"   # synthetic, the shape of a mind token


@pytest.fixture()
def browser(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from hive.core import app as app_module
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    dist = tmp_path / "ui"
    dist.mkdir()
    (dist / "index.html").write_text("synthetic UI")
    monkeypatch.setattr(app_module, "UI_DIST", dist)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("method", ["get", "post", "put", "patch", "delete"])
@pytest.mark.parametrize("path", [f"/api/nosuch/{TOKEN}", f"/llm/{TOKEN}/x", f"/agent-hub/{TOKEN}"])
def test_an_unknown_address_with_a_token_never_repeats_it(browser, method, path):
    response = getattr(browser, method)(path)
    assert response.status_code == 404
    assert TOKEN not in response.text
    assert response.json()["error"]["code"] == "not_found"


def test_a_missing_file_under_the_ui_never_repeats_a_token(browser):
    response = browser.get(f"/assets/{TOKEN}.js")
    assert TOKEN not in response.text
