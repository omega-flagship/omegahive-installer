"""A fresh app admits and completes Ask without an install-only environment switch; no real provider or process."""
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core import conductor
from hive.tests.test_ask import ask, world
from hive.tests.test_ask_conductor import Script, script, wait, closed
from hive.tests.test_core_api import FakeSupervisor, PETTA


@pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
def test_fresh_install_completes_ask_without_conductor_switch(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR", raising=False)
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    monkeypatch.setenv("HIVE_LOCAL_OWNER", "0")
    settings = load_settings(data_dir=tmp_path, admin_password="pw", petta_path=PETTA, offline=True)
    supervisor = FakeSupervisor()
    app = create_app(settings, supervisor=supervisor, reconcile_seconds=0)
    with TestClient(app) as client:
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        client.headers["Authorization"] = f"Bearer {token}"
        w = world(client)
        fake = script(client, Script("A fresh install can answer."))
        assert conductor.memory_enabled() is False
        response = ask(client, w["ann"], "fresh-install-default-ask", context={"swarm_id": w["swarm"]["id"]})
        assert response.status_code == 202, response.text
        assert response.json()["state"] == "thinking"
        assert response.json()["conductor"] == {"model": "mock/conductor"}
        events = wait(w["hive"], "fresh-install-default-ask", closed)
        assert any(e["phase"] == "answer" and e.get("text") == "A fresh install can answer." for e in events)
        assert len(fake.bodies) == 1
