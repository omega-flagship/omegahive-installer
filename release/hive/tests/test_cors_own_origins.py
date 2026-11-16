"""Purpose: tests that CORS answers the hive's own origins and no other (flagship review #111, should fix soon: CORS
allow_origins=["*"]).

CORS answers exactly the origins the hive serves its page at (its public base, its public URL, loopback on its port, and
on a local-owner hive its browser port too) and no others, so a page on another origin cannot read what the hive
answers; native callers (MCP clients, minds, scripts) send no Origin and are not affected. Every Origin check reads the
same set (app.py own_origins).
"""

import pathlib

import pytest
from starlette.testclient import TestClient

from hive.core import app as app_module
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import PETTA, FakeSupervisor

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

PUBLIC_URL = "https://hive.example.test/staging/"
PUBLIC_BASE = "https://public.example.test"
OWN = ("https://hive.example.test", "https://public.example.test", "http://127.0.0.1:8711", "http://localhost:8711")
FOREIGN = ("https://evil.example", "null", "http://localhost:5173", "https://hive.example.test:8443",
           "http://hive.example.test", "http://127.0.0.1:8700")


@pytest.fixture()
def hive_at(monkeypatch, tmp_path):
    """hive_at(page=None, **env) -> a TestClient on a hive built with exactly these address settings and, given `page`,
    a UI build whose index.html is that text."""
    clients = []

    def make(page=None, **env):
        for name in ("HIVE_PUBLIC_BASE", "HIVE_PUBLIC_URL", "HIVE_PORT", "HIVE_BASE_PATH", "HIVE_LOCAL_OWNER",
                     "HIVE_LOCAL_BROWSER_PORT"):
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        root = tmp_path / f"h{len(clients)}"
        if page is not None:
            dist = root / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_text(page)
            (dist / "assets" / "index-abc.js").write_text("console.log('ui')")
            monkeypatch.setattr(app_module, "UI_DIST", dist)
        (root / "data").mkdir(parents=True)
        settings = load_settings(data_dir=root / "data", admin_password="pw", petta_path=PETTA)
        client = TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0))
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)


def preflight(client, origin):
    return client.options("/api/swarms", headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                                                  "Access-Control-Request-Headers": "authorization, content-type"})


# ---- CORS: the hive's own origins only ------------------------------------------------------------------------------

def test_cors_answers_the_hives_own_origins(hive_at):
    hive = hive_at(HIVE_PUBLIC_URL=PUBLIC_URL, HIVE_PUBLIC_BASE=PUBLIC_BASE, HIVE_PORT="8711")
    for origin in OWN:
        read = hive.get("/api/auth/methods", headers={"Origin": origin})
        assert read.status_code == 200 and read.headers.get("access-control-allow-origin") == origin, origin
        asked = preflight(hive, origin)
        assert asked.status_code == 200 and asked.headers.get("access-control-allow-origin") == origin, origin
    exposed = hive.get("/api/auth/methods", headers={"Origin": OWN[0]}).headers.get("access-control-expose-headers")
    # the error id is exposed too, so a page on one of the hive's own origins can quote it in a report (feedback.py)
    assert exposed == "X-Hive-Person-Swarm-Consent-Required, X-Hive-Error-Id"


def test_cors_answers_no_other_origin(hive_at):
    hive = hive_at(HIVE_PUBLIC_URL=PUBLIC_URL, HIVE_PUBLIC_BASE=PUBLIC_BASE, HIVE_PORT="8711")
    for origin in FOREIGN:
        read = hive.get("/api/auth/methods", headers={"Origin": origin})
        assert read.status_code == 200 and "access-control-allow-origin" not in read.headers, origin
        asked = preflight(hive, origin)
        assert asked.status_code == 400 and "access-control-allow-origin" not in asked.headers, origin


def test_a_caller_with_no_origin_is_unchanged(hive_at):
    """MCP clients, minds and scripts are not browsers: they send no Origin, and CORS adds nothing to their answers."""
    hive = hive_at(HIVE_PUBLIC_URL=PUBLIC_URL)
    token = hive.post("/api/auth/login", json={"password": "pw"}).json()["token"]
    out = hive.get("/api/swarms", headers={"Authorization": f"Bearer {token}"})
    assert out.status_code == 200 and "access-control-allow-origin" not in out.headers


def test_a_default_hive_answers_its_loopback_origin_only(hive_at):
    hive = hive_at()
    assert preflight(hive, "http://127.0.0.1:8700").headers.get("access-control-allow-origin") == "http://127.0.0.1:8700"
    assert preflight(hive, "http://localhost:8700").headers.get("access-control-allow-origin") == "http://localhost:8700"
    assert preflight(hive, "https://anywhere.example").status_code == 400
