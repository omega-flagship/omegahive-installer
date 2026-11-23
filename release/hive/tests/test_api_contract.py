# Purpose: the hive's API contract once the UI is its own image (omega-flagship/omegahive#674, hive/core/api_contract.py):
# hive/api/openapi.json is the document the app generates and states HIVE_API_VERSION, and every route the app registers
# is under HIVE_PREFIXES, the paths the proxy sends to the hive, except the page routes a UI build adds.
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core import api_contract as contract
from hive.tests.test_core_api import client  # noqa: F401  (fixture: local operator, no UI build)

OPENAPI_FILE = pathlib.Path(__file__).resolve().parents[1] / "api" / "openapi.json"
REGENERATE = "HIVE_OPENAPI_WRITE=1 python -m pytest hive/tests/test_api_contract.py -k committed"
# The page and its files, which a hive built with hive/ui/dist answers itself (dev, the installers' one process). Behind
# the proxy the UI container answers these paths, so they are the one exception to HIVE_PREFIXES.
PAGE_ROUTES = {"/{path:path}"}
# Generates the document in a fresh interpreter, built as the client fixture builds the app, and writes it to argv[2]
# (not stdout, which carries the app's log lines).
GENERATE = """
import pathlib, sys
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core import api_contract
from hive.tests.test_core_api import PETTA, FakeSupervisor
settings = load_settings(data_dir=pathlib.Path(sys.argv[1]), admin_password="pw", petta_path=PETTA)
app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
pathlib.Path(sys.argv[2]).write_text(api_contract.openapi_text(app), encoding="utf-8")
"""


@pytest.fixture()
def built(monkeypatch, tmp_path):
    """The app as every deployed hive is built: with the UI, so its page routes are registered too."""
    from hive.core import app as app_module
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    dist = tmp_path / "ui"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>synthetic UI</title>")
    monkeypatch.setattr(app_module, "UI_DIST", dist)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as test_client:
        yield test_client


def outside_prefixes(app):
    """Every route path the app registers that is not under HIVE_PREFIXES, the page routes left out: HTTP and websocket
    routes and mounts alike (a mount at the root has the path "", named here as "/")."""
    return sorted({route.path or "/" for route in app.routes
                   if route.path not in PAGE_ROUTES and not contract.under_prefixes(route.path)})


def test_the_committed_openapi_is_the_one_the_app_generates(client):
    generated = contract.openapi_text(client.app)
    if os.environ.get("HIVE_OPENAPI_WRITE") == "1":
        OPENAPI_FILE.parent.mkdir(parents=True, exist_ok=True)
        OPENAPI_FILE.write_text(generated, encoding="utf-8")
    committed = OPENAPI_FILE.read_text(encoding="utf-8") if OPENAPI_FILE.is_file() else ""
    if committed != generated:
        old, new = json.loads(committed or "{}").get("paths", {}), json.loads(generated)["paths"]
        changed = sorted(p for p in old.keys() | new.keys() if old.get(p) != new.get(p))
        pytest.fail(f"hive/api/openapi.json is not the document the app generates (paths that differ: "
                    f"{changed[:20] or 'none; the difference is outside paths'}). Regenerate it under "
                    f"hive/ci-constraints.txt with `{REGENERATE}` and commit it. If the change breaks a caller, raise "
                    f"HIVE_API_VERSION's MAJOR (hive/core/api_contract.py); if it adds to the API, its MINOR.",
                    pytrace=False)


SEEDS = ("0", "2", "5")


def test_generating_the_openapi_again_gives_the_same_bytes_whatever_the_hash_seed():
    """The committed-file test samples one hash seed per run; this compares generations under three seeds, so an
    order that follows set or dict iteration (FastAPI's default operation id for a multi-method route did) fails here."""
    root = pathlib.Path(__file__).resolve().parents[2]
    texts = []
    # Not just 0 and 1: under those two a set of GET, POST and DELETE (/mcp) iterates from the same method. Under 0, 2
    # and 5 it starts at GET, POST and DELETE in turn (64-bit CPython), so a regression shows on every run.
    for seed in SEEDS:
        env = dict(os.environ, PYTHONHASHSEED=seed, HIVE_ASK_CONDUCTOR=os.environ.get("HIVE_ASK_CONDUCTOR", "0"),
                   HIVE_CODE_CONTROLLER_ENGINE=os.environ.get("HIVE_CODE_CONTROLLER_ENGINE", "0"))
        with tempfile.TemporaryDirectory(prefix="hive-openapi-") as data:
            out = pathlib.Path(data) / "openapi.json"
            done = subprocess.run([sys.executable, "-c", GENERATE, data, str(out)], cwd=root, env=env,
                                  capture_output=True, text=True, timeout=300)
            assert done.returncode == 0, f"PYTHONHASHSEED={seed}: generating the document failed:\n{done.stderr[-2000:]}"
            texts.append(out.read_text(encoding="utf-8"))
    assert texts[0], "the document came out empty"
    for seed, text in zip(SEEDS[1:], texts[1:]):
        if text != texts[0]:
            a, b = json.loads(texts[0])["paths"], json.loads(text)["paths"]
            differ = sorted(p for p in a.keys() | b.keys() if a.get(p) != b.get(p))
            pytest.fail(f"the OpenAPI document differs between PYTHONHASHSEED {SEEDS[0]} and {seed} (paths that differ: "
                        f"{differ[:20] or 'none; the difference is outside paths'})", pytrace=False)


def test_the_committed_openapi_states_the_api_version(client):
    assert re.fullmatch(r"[0-9]+\.[0-9]+", contract.HIVE_API_VERSION), "HIVE_API_VERSION is MAJOR.MINOR"
    assert client.app.version == contract.HIVE_API_VERSION
    committed = json.loads(OPENAPI_FILE.read_text(encoding="utf-8"))
    assert committed["info"]["version"] == contract.HIVE_API_VERSION, (
        f"hive/api/openapi.json states version {committed['info']['version']!r}, HIVE_API_VERSION is "
        f"{contract.HIVE_API_VERSION!r}: regenerate it with `{REGENERATE}`")


def test_the_live_schema_is_served_under_api_with_the_same_version(client):
    served = client.get("/api/openapi.json")
    assert served.status_code == 200
    assert served.json()["info"]["version"] == contract.HIVE_API_VERSION
    for gone in ("/openapi.json", "/docs", "/redoc"):   # outside the prefixes, so no longer registered
        assert client.get(gone).status_code == 404, gone


def test_every_route_is_under_the_prefixes_the_proxy_sends_to_the_hive(built):
    outside = outside_prefixes(built.app)
    assert not outside, (
        f"the app registers {outside}, outside HIVE_PREFIXES {contract.HIVE_PREFIXES}: behind the proxy those paths "
        f"go to the UI, not the hive. Serve the route under one of the prefixes, or add its prefix to HIVE_PREFIXES "
        f"(hive/core/api_contract.py) and to {contract.CADDY_MATCHER}.")


def test_the_prefix_check_names_a_route_outside_them(built):
    # the check itself, on deliberate violations: an HTTP route at the root (the way a health check is often added),
    # a websocket route, a mount beside the prefixes and a mount at the root
    async def nothing(scope, receive, send):
        return None

    async def socket(websocket):
        await websocket.close()

    built.app.router.add_api_route("/healthz", lambda: {"ok": True}, methods=["GET"])
    built.app.router.add_websocket_route("/events", socket)
    built.app.mount("/static", nothing)
    built.app.mount("/", nothing)
    assert outside_prefixes(built.app) == ["/", "/events", "/healthz", "/static"]


@pytest.mark.parametrize("path", ["/mcp/nosuch", "/flow-studio/no/such", "/api/nosuch", "/llm/nosuch", "/agent-hub/x"])
def test_an_unserved_path_under_a_prefix_is_the_apis_404_never_the_page(built, path):
    response = built.get(path)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert "synthetic UI" not in response.text


def test_a_page_path_is_still_the_page(built):
    response = built.get("/settings")
    assert response.status_code == 200
    assert "synthetic UI" in response.text
