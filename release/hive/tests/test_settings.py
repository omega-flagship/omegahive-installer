"""Settings: an admin summary without secrets, and password rotation that ends password sessions."""
import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_settings_summary_has_no_secrets(client, monkeypatch):
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"node": "/secret/path/node"}))
    out = client.get("/api/settings").json()
    assert out["hive"]["name"] == "OmegaHive" and out["disk"]["free_bytes"] > 0
    assert out["apps"]["sandbox_runtimes"] == ["node"]                  # names only, never paths
    assert "pw" not in json.dumps(out)


def test_rotation_replaces_the_password_and_ends_password_sessions(client):
    old_headers = dict(client.headers)
    r = client.post("/api/settings/password/rotate").json()
    new = r["password"]
    assert len(new) >= 20 and r["ended_password_sessions"] >= 1
    assert client.get("/api/hive", headers=old_headers).status_code == 401     # this password session ended
    assert client.post("/api/auth/login", json={"password": "pw"}).status_code == 401
    assert client.post("/api/auth/login", json={"password": new}).status_code == 200
