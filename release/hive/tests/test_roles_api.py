"""Roles: reusable prompt, model, budget and approval-rule bundles for minds."""

import os
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class Supervisor:
    def __init__(self):
        self.prompts = {}
    def attach(self, hive): self.hive = hive
    def prepare(self, agent, token): self.prompts[agent["id"]] = agent.get("role_prompt", "")
    def reconfigure(self, agent): self.prompts[agent["id"]] = agent.get("role_prompt", "")
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


@pytest.fixture()
def c():
    sup = Supervisor()
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-roles-")), admin_password="pw", petta_path=PETTA, offline=True)
    with TestClient(create_app(settings, supervisor=sup, reconcile_seconds=0)) as client:
        client.headers["Authorization"] = "Bearer " + client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        client.sup = sup
        yield client


def test_builtin_roles_and_assignment(c):
    roles = {r["name"]: r for r in c.get("/api/roles").json()}
    assert {"Coordinator", "Sceptic", "Builder", "Judge"} <= roles.keys() and roles["Sceptic"]["builtin"]
    swarm = c.post("/api/swarms", json={"name": "Watch", "description": "follow markets"}).json()
    mind = c.post("/api/agents", json={"name": "Vega", "kind": "omega", "swarm_id": swarm["id"], "model": "mock/echo",
                                       "role_id": roles["Sceptic"]["id"], "persona": "Focus on energy markets."}).json()
    assert mind["role_id"] == roles["Sceptic"]["id"]
    assert mind["role_prompt"].startswith("You are Vega, the sceptic in Watch.")
    assert c.sup.prompts[mind["id"]] == mind["role_prompt"]
    assert roles["Sceptic"]["id"] in [r["id"] for r in c.get("/api/roles").json() if mind["id"] in r["minds"]]


def test_role_defaults_rules_and_live_edits(c):
    role = c.post("/api/roles", json={"name": "Careful researcher", "summary": "asks first", "prompt": "You are {name} in {swarm}: {purpose}.",
                                      "default_model": "mock/echo", "default_budget": 3, "rules": [{"skill": "web-search", "mode": "ask"}]}).json()
    swarm = c.post("/api/swarms", json={"name": "Lab", "description": "test ideas"}).json()
    mind = c.post("/api/agents", json={"name": "Nova", "kind": "omega", "swarm_id": swarm["id"], "role_id": role["id"]}).json()
    assert mind["model"] == "mock/echo" and mind["budget_usd"] == 3
    assert mind["role_prompt"] == "You are Nova in Lab: test ideas."
    rules = [r for r in c.get("/api/policy").json() if r["scope"] == f"agent:{mind['id']}"]
    assert [(r["skill"], r["mode"], r["note"]) for r in rules] == [("web-search", "ask", "role:Careful researcher")]
    # editing the role updates the mind's prompt and rules
    c.patch(f"/api/roles/{role['id']}", json={"prompt": "You are {name}, careful.", "rules": [{"skill": "shell*", "mode": "deny"}]})
    assert c.get(f"/api/agents/{mind['id']}").json()["role_prompt"] == "You are Nova, careful."
    assert c.sup.prompts[mind["id"]] == "You are Nova, careful."
    rules = [(r["skill"], r["mode"]) for r in c.get("/api/policy").json() if r["scope"] == f"agent:{mind['id']}"]
    assert rules == [("shell*", "deny")]
    # a person's own rule for the mind is not touched by the role
    c.post("/api/policy", json={"scope": f"agent:{mind['id']}", "skill": "metta", "mode": "allow", "note": "mine"})
    c.patch(f"/api/agents/{mind['id']}", json={"role_id": None})
    rules = [(r["skill"], r["note"]) for r in c.get("/api/policy").json() if r["scope"] == f"agent:{mind['id']}"]
    assert rules == [("metta", "mine")] and c.get(f"/api/agents/{mind['id']}").json()["role_prompt"] == ""
    # duplicate, validation, removal
    copy = c.post(f"/api/roles/{role['id']}/duplicate").json()
    assert copy["name"] == "Careful researcher copy" and copy["prompt"] == "You are {name}, careful."
    assert c.post("/api/roles", json={"name": "Careful researcher", "prompt": "x"}).json()["error"]["code"] == "name_taken"
    assert c.post("/api/roles", json={"name": "Bad", "prompt": "x", "rules": [{"skill": "a b", "mode": "allow"}]}).json()["error"]["code"] == "bad_rules"
    c.patch(f"/api/agents/{mind['id']}", json={"role_id": copy["id"]})
    assert c.delete(f"/api/roles/{copy['id']}").json() == {"ok": True, "unassigned": 1}
    assert c.get(f"/api/agents/{mind['id']}").json()["role_id"] is None


def test_rules_are_never_dropped_silently(c):
    rules = [{"skill": f"skill-{i}", "mode": "allow"} for i in range(60)]
    role = c.post("/api/roles", json={"name": "Many", "prompt": "p", "rules": rules})
    assert role.status_code == 200 and len(role.json()["rules"]) == 60
    too_many = c.post("/api/roles", json={"name": "Too many", "prompt": "p", "rules": rules * 2})
    assert too_many.status_code == 400 and too_many.json()["error"]["code"] == "too_many_rules"


def test_roles_declare_the_media_they_work_in(c):
    role = c.post("/api/roles", json={"name": "Deck maker", "prompt": "p", "media": ["deck", "image", "deck"]}).json()
    assert role["media"] == ["deck", "image"]
    assert c.post("/api/roles", json={"name": "Bad", "prompt": "p", "media": ["Not OK!"]}).status_code == 400
    assert c.patch(f"/api/roles/{role['id']}", json={"media": []}).json()["media"] == []
