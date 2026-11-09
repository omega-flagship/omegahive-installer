"""A Create plan member (R3.14 plan-member) driven by the engine against the REAL scratch OmegaCode service.

Same scratch world as test_code_contract_live_service (scratch hive on a free port, scratch OmegaCode from the pinned
release, synthetic calculator repo; never 8700/8724). The engine runs in the scratch hive's own loop: adopt_member opens
the piece workspace through the real person relay, reads it, asks the assignee (played here through its real member
token and the real goal routes), writes only the piece's file with a real guarded patch and checkpoint, runs the plan's
test port, and declares member-ready; the plan's integrated delivers it. The test port is a stand-in for the plan
engine's sandboxed acceptance check (it runs the piece's test file in a scratch folder with this Python).
Skipped when the release tree, PeTTa, git or sandbox-exec is missing (the harness's own conditions)."""
import asyncio
import json
import pathlib
import subprocess
import sys
import tempfile
import time

from hive.tests import test_code_contract_live_service as live
from hive.tests.test_code_contract_live_service import REPO_ID, world  # noqa: F401  (fixture)

pytestmark = live.pytestmark
FIXED = live.CALCULATOR.replace("a - b", "a + b")


def wait_for(predicate, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("timed out")


def in_loop(hive, coro):
    """Run on the scratch hive's own event loop (where the engine, its watcher and the relay client live)."""
    return asyncio.run_coroutine_threadsafe(coro, hive.events._loop).result(120)


def test_a_plan_member_builds_its_piece_against_the_real_service(world):
    w, hive = world, world.hive
    live.test_hop1_person_opens_the_repository(w)
    live.test_hop2_workspace_through_the_person_relay(w)        # this workspace is the piece's fork
    engine = hive.code_controller
    hive.settings.code_controller_engine = True
    team = w.http.post("/api/swarms", json={"name": "Builders", "visibility": "public"}, headers=w.op).json()
    builder = w.http.post("/api/agents", json={"name": "Piece builder", "swarm_id": team["id"], "budget_usd": 5},
                          headers=w.op).json()
    seen = []
    real_publish = hive.events.publish
    hive.events.publish = lambda kind, **kw: (seen.append((kind, kw)), real_publish(kind, **kw))

    async def plan_check(run_row, cand):     # stand-in for the plan engine's sandboxed acceptance check
        files = {}
        for path in ("calculator.py", "test_calculator.py"):
            status, row = await engine.member_ports._call(run_row, "GET", f"/v1/workspaces/{w.ws['id']}/files",
                                                          query={"path": path})
            files[path] = row["content"]
        with tempfile.TemporaryDirectory(dir=str(w.scratch)) as d:
            for path, text in files.items():
                pathlib.Path(d, path).write_text(text)
            out = subprocess.run([sys.executable, "test_calculator.py"], cwd=d, capture_output=True, text=True, timeout=30)
        return {"passed": out.returncode == 0, "exit_code": out.returncode, "argv": ["python", "test_calculator.py"],
                "stdout": out.stdout, "stderr": out.stderr}
    engine.member_ports.run_test = plan_check

    async def adopt():
        return engine.adopt_member("pl_live", "calc", {"task_id": w.task_id, "grant_id": w.grant_id,
                                                       "repository_id": REPO_ID, "workspace_id": w.ws["id"]},
                                   ["calculator.py"], builder["id"], "budget.pl_live.calc", "plan-reviewed", "user:u_jon",
                                   task="task-1")
    tid = in_loop(hive, adopt())["task_id"]
    effect = wait_for(lambda: hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = "
                                          "'helper' AND state = 'waiting'", (tid,)))
    body = json.loads(effect["body"])
    auth = {"Authorization": f"Bearer {builder['token']}"}
    assert w.http.post(f"/api/agent/goals/{body['goal_id']}/claim", headers=auth).status_code == 200
    done = w.http.post(f"/api/agent/goals/{body['goal_id']}/result", headers=auth,
                       json={"status": "done", "result": "fixed add", "data": {"files": {"calculator.py": FIXED}}})
    assert done.status_code == 200, done.text

    view = wait_for(lambda: (lambda v: v if v["status"] in ("member_ready", "needs_you", "engine_error") else None)(
        engine.view(tid)), 120)
    assert view["status"] == "member_ready", view
    assert [r["kind"] for r in view["journal"]] == ["opened", "read", "think-started", "changed", "dispatched", "tests-pass"]
    assert view["test"]["exit_code"] == 0 and "calculator passed" in view["test"]["logs"]["stdout"]["text"]
    cand = view["candidate"]
    assert [kw for kind, kw in seen if kind == "code.controller.member_ready"] == [
        {"plan_id": "pl_live", "piece": "calc", "cand": cand, "task_id": tid}]
    # the real fork holds the piece's change (and only it), at the candidate checkpoint
    got = live.proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/files", params={"path": "calculator.py"})
    assert got.json()["content"] == FIXED
    test_file = live.proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/files", params={"path": "test_calculator.py"})
    assert test_file.json()["content"] == live.TEST_FILE
    out = in_loop(hive, engine.member_integrated(tid, "integrate-1", cand, "cp_plan_integration_1"))
    assert out["verdict"] == "accepted" and out["status"] == "integrated"
    hive.events.publish = real_publish
