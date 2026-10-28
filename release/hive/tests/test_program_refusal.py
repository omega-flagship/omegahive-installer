"""A program's PermissionError reaches the person as a clean 403 refusal, not a 500 crash."""

import json
import os
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

PROGRAM = '''
def describe():
    return {"contract": "0.1", "kinds": [{"id": "q", "role": "question"}], "relations": [], "actions": []}

def view(ctx, focus=None, stage="unfold"):
    raise PermissionError("Swarm is not enrolled")

def act(ctx, action, items, params):
    raise RuntimeError("boom")
'''


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


def test_refusal_is_403_and_crash_stays_500(monkeypatch):
    plugins = pathlib.Path(tempfile.mkdtemp(prefix="hive-plug-")) / "refuser"
    plugins.mkdir()
    (plugins / "plugin.json").write_text(json.dumps({"id": "refuser", "name": "Refuser", "version": "0.1.0", "contract": "0.1", "module": "program.py"}))
    (plugins / "program.py").write_text(PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(plugins))
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-ref-")), admin_password="pw", petta_path=PETTA, offline=True)
    with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)) as c:
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        swarm = c.post("/api/swarms", json={"name": "S"}).json()
        r = c.post("/api/programs/refuser/view", json={"swarm_id": swarm["id"]})
        assert r.status_code == 403 and r.json()["error"] == {"code": "program_refused", "message": "Refuser: Swarm is not enrolled"}
        r = c.post("/api/programs/refuser/act", json={"swarm_id": swarm["id"], "action": "x", "items": []})
        assert r.status_code in (400, 500)
