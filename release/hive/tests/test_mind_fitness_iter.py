"""Mind fitness fix 4 (2026-10-06): the Iter hive kit can work a goal and a review, and an Iter without Docker
refuses to start with a clear, recorded error.

Before: inbox/send, open-goal titles, claim, done/failed, publish, query. No goal detail or result schema, no
heartbeat, cancel-ack, propose, revision read, finding or review result, no view of its own goals, and the role
prompt never reached the Iter. Each tool here is loaded the way iter.py loads it and driven through the real routes."""
import importlib.util
import inspect
import json
import pathlib
import subprocess

import pytest

from hive.core.config import load_settings
from hive.supervisor import drivers
from hive.supervisor import workspace as ws
from hive.tests.test_collab import call, held_goal
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_fitness_feedback import MANDATE, _setup

TOOLS = ws.ITER_TEMPLATE / "tools"
KIT = {"hive_goals": [], "hive_goal_get": ["goal_id"], "hive_goal_claim": ["goal_id"], "hive_goal_heartbeat": ["goal_id"],
       "hive_goal_cancel_ack": ["goal_id"], "hive_goal_propose": ["goal_id", "proposal"],
       "hive_goal_done": ["goal_id", "status", "result"], "hive_revision_read": ["artifact_id", "revision"],
       "hive_finding": ["finding"], "hive_review_complete": ["request_id", "result"],
       "hive_publish": ["statement", "f", "c"], "hive_query": ["pattern"],
       # J3 R5 (OI-7): the Studio maker's three tools
       "hive_studio_context": ["session_id", "execution_id", "after_dir"],
       "hive_studio_publish": ["artifact_id", "body", "execution_id", "parent"],
       "hive_studio_done": ["session_id", "n", "execution_id", "more"]}


def tool(name):
    """As iter.py's dynamic_worker loads a tool: by file, with its own _hive helper."""
    spec = importlib.util.spec_from_file_location("_dynamic_" + name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def through(client, agent, module):
    def call_(method, path, payload=None, timeout=4):
        r = client.request(method, path, headers=agent_headers(agent), json=payload)
        if r.status_code >= 400:
            e = r.json()["error"]
            return None, f"HIVE-ERROR {e['code']}: {e['message']}"
        return r.json(), None
    module._hive.call = call_
    return module


def test_the_kit_has_every_tool_with_iters_metadata_limits():
    found = {p.stem for p in TOOLS.glob("*.py") if not p.name.startswith("_")}
    assert found == set(KIT)
    for name, params in KIT.items():
        module = tool(name)
        assert len(module.DESCRIPTION) <= 500, name                  # iter.py cuts longer descriptions
        assert [p.name for p in inspect.signature(module.run).parameters.values()] == params, name
    assert len(found) + 2 <= 30                                      # + send, nop; iter.py loads at most 30 tools


def test_an_iter_works_a_goal_with_detail_heartbeat_and_a_proposal(client, monkeypatch):
    swarm = client.post("/api/swarms", json={"name": "IterSwarm"}).json()
    ivy = client.post("/api/agents", json={"name": "Ivy", "kind": "module", "swarm_id": swarm["id"]}).json()
    monkeypatch.setenv("HIVE_AGENT_ID", ivy["id"])
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Find the opening date", "detail": "Cite two sources.",
                                                               "assignee": "Ivy"}).json()
    other = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Free work"}).json()
    listing = through(client, ivy, tool("hive_goals")).run()
    assert listing.startswith(f"yours: {g['id']} open") and f"open: {other['id']} open" in listing
    assert "claimed" in through(client, ivy, tool("hive_goal_claim")).run(g["id"])
    detail = through(client, ivy, tool("hive_goal_get")).run(g["id"])
    assert "DETAIL:\nCite two sources." in detail and f"claimed_by={ivy['id']}" in detail
    assert through(client, ivy, tool("hive_goal_heartbeat")).run(g["id"]).startswith(f"held {g['id']} claimed lease_until=")
    assert through(client, ivy, tool("hive_goals")).run().startswith(f"yours: {g['id']} claimed")
    done = through(client, ivy, tool("hive_goal_propose")).run(g["id"], json.dumps({"answer": "1932", "sources": ["a", "b"]}))
    assert done == f"proposed {g['id']} done", done
    stored = call(client, ivy, "GET", f"/api/agent/goals/{g['id']}").json()
    assert stored["status"] == "done" and stored["result_data"]["proposal"] == {"answer": "1932", "sources": ["a", "b"]}


def test_an_iter_acknowledges_a_cancelled_goal(client):
    swarm = client.post("/api/swarms", json={"name": "IterCancel"}).json()
    ike = client.post("/api/agents", json={"name": "Ike", "kind": "module", "swarm_id": swarm["id"]}).json()
    g = held_goal(client, swarm, ike)
    assert "not_cancelled" in through(client, ike, tool("hive_goal_cancel_ack")).run(g["id"])
    assert client.patch(f"/api/goals/{g['id']}", json={"status": "cancelled"}).status_code == 200
    assert through(client, ike, tool("hive_goal_cancel_ack")).run(g["id"]) == f"cancel acknowledged {g['id']}"


def test_an_iter_reads_the_revision_raises_a_finding_and_completes_the_review(client):
    rq, v = _setup(client)
    subject = rq["subject"]
    read = through(client, v, tool("hive_revision_read")).run(subject["artifact_id"], str(subject["revision"]))
    assert read.startswith(f"{subject['artifact_id']} r1 sha256:") and '"steps"' in read
    bad = through(client, v, tool("hive_finding")).run("s1 lacks a threat model")
    assert bad.startswith("HIVE-ERROR bad_request: give a JSON object") and "description" in bad
    wrong = through(client, v, tool("hive_finding")).run(json.dumps({"request_id": rq["id"], "mandate": MANDATE,
                                                                      "target": {"step": "nine"}, "severity": "major", "recommendation": "x"}))
    assert "Corrected example: hive-finding" in wrong                 # the hive's guidance reaches an Iter too
    raised = through(client, v, tool("hive_finding")).run(json.dumps({"request_id": rq["id"], "mandate": MANDATE,
                                                                       "target": {"step": "s1"}, "severity": "major", "recommendation": "threat model first"}))
    assert raised.startswith("finding fd_") and raised.endswith("major on r1"), raised
    fid = raised.split()[1]
    out = through(client, v, tool("hive_review_complete")).run(rq["id"], json.dumps({"recommendation": "revise", "rationale": "s1",
                                                                                     "finding_ids": [fid]}))
    assert out == f"review complete {rq['id']} findings=1 recommendation=revise"


def _iter_source(tmp_path):
    src = tmp_path / "iter-src"
    (src / "tools").mkdir(parents=True)
    for name in ws.ITER_FILES:
        (src / name).write_text("# synthetic stand-in\n" + ("def run():\n    return ''\nDESCRIPTION = 'x'\n" if name.startswith("tools/") else ""))
    return src


def test_the_role_reaches_the_iter_note_bounded_and_follows_role_changes(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_ITER_SRC", str(_iter_source(tmp_path)))
    w = ws.Workspace(load_settings(data_dir=tmp_path / "hive", admin_password="pw"))
    agent = {"id": "a_iterfit", "name": "Ivy", "kind": "iter", "role_prompt": "You find primary sources.", "persona": "Curious."}
    root = w.create(agent, "tok")
    note = (root / "memory" / "hive.txt").read_text(encoding="utf-8")
    assert note.startswith("Your name is Ivy.\n") and "Your role: You find primary sources." in note and "Persona: Curious." in note
    assert {p.name for p in (root / "tools").glob("hive_*.py")} == {f"{n}.py" for n in KIT}
    w.write_prompt(dict(agent, role_prompt="R" * 5000, persona="P" * 5000))   # a reconfigure: long role and persona
    note = (root / "memory" / "hive.txt").read_text(encoding="utf-8")
    assert len(note) <= ws.ITER_NOTE_CHARS and "R [cut: 5000 characters in all]" in note and "Persona" not in note
    assert not (root / "memory" / "prompt.txt").exists()               # an Iter never gets the omega prompt


class Ran:
    def __init__(self, *codes, timeout_at=None):
        self.codes, self.timeout_at, self.calls = list(codes), timeout_at, []

    def __call__(self, args, **kw):
        self.calls.append(args[:3])
        if self.timeout_at == len(self.calls):
            raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        return subprocess.CompletedProcess(args, self.codes.pop(0), "", "")


@pytest.mark.parametrize("which, run, says", [
    (lambda _: None, Ran(), "docker command is not installed"),
    (lambda _: "/usr/bin/docker", Ran(1), "Docker daemon is not running"),
    (lambda _: "/usr/bin/docker", Ran(timeout_at=1), "did not answer within 10 s"),
    (lambda _: "/usr/bin/docker", Ran(0, 1), "image omegadots/iter:dev is not on this machine: build it with docker build -f hive/docker/iter.Dockerfile"),
])
def test_the_iter_preflight_refuses_plainly(which, run, says):
    with pytest.raises(drivers.StartRefused) as refused:
        drivers.iter_preflight("omegadots/iter:dev", run=run, which=which)
    assert says in str(refused.value)


def test_the_iter_preflight_passes_with_daemon_and_image():
    run = Ran(0, 0)
    drivers.iter_preflight("omegadots/iter:dev", run=run, which=lambda _: "/usr/bin/docker")
    assert run.calls == [["docker", "info", "--format"], ["docker", "image", "inspect"]]


def test_the_docker_driver_checks_before_it_runs_an_iter_and_not_for_omega(tmp_path, monkeypatch):
    w = ws.Workspace(load_settings(data_dir=tmp_path / "hive", admin_password="pw"))
    driver = drivers.DockerDriver(w)
    docker_calls = []
    monkeypatch.setattr(driver, "_docker", lambda *a, **k: docker_calls.append(a) or subprocess.CompletedProcess(a, 1, "", ""))
    monkeypatch.setattr(drivers, "iter_preflight", lambda image: (_ for _ in ()).throw(drivers.StartRefused("the Docker daemon is not running")))
    with pytest.raises(drivers.StartRefused):
        driver.start({"id": "a_i", "kind": "iter"}, {})
    assert docker_calls == []                                          # refused before any container command
    assert issubclass(drivers.StartRefused, RuntimeError)              # every existing 'start failed' path still records it


def test_a_refused_start_is_recorded_on_the_mind_and_left_stopped(client, monkeypatch):
    swarm = client.post("/api/swarms", json={"name": "IterStart"}).json()
    ivy = client.post("/api/agents", json={"name": "Ivy", "kind": "iter", "swarm_id": swarm["id"], "driver": "docker"}).json()

    def refuse(agent_id):
        raise drivers.StartRefused("the Docker daemon is not running: start Docker, then start this Iter again")
    monkeypatch.setattr(client.supervisor, "start", refuse)
    out = client.post(f"/api/agents/{ivy['id']}/start")
    assert out.status_code == 409 and out.json()["error"]["code"] == "start_refused"
    row = client.get(f"/api/agents/{ivy['id']}").json()
    assert row["status"] == "error" and row["last_error"].startswith("start refused: the Docker daemon is not running")
    assert client.app.state.hive.db.one("SELECT desired FROM agents WHERE id = ?", (ivy["id"],))["desired"] == "stopped"
