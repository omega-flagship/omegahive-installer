"""Create plans against the REAL scratch OmegaCode service: the hive-owned build workspace, forks, checkpoints and
cross-fork merges over the hive's own relay, with the acceptance check in the hive sandbox.

Same scratch world as test_code_contract_live_service (a scratch hive served on a free loopback port in this process, a
scratch OmegaCode started from the pinned release with omegacode_scratch_service.py, never 8700/8724), but its synthetic
repository is the Create web scaffold. The plan engine runs inside the scratch hive's loop. The planner, test author and
reviewers are faked (test_create_plan_engine.FakeMinds). Each piece is built by a REAL R3.14 per-change member (the
coding controller's plan-member profile): its helper goal goes to the piece's assignee mind, which this test plays with
that mind's own token over the agent API. Everything else is real: the person's routes, the R4.3 and R3.14 reducers,
the journals, OmegaCode workspaces/forks/patches/checkpoints/merges through hive.code.proxy, the sandboxed check as the
plan's check AND each member's own test (red on the scaffold, red on a buggy app.js inside the app member, then green),
the preview bundle and the deploy as a hive app. Skipped when the release tree, PeTTa, git or sandbox-exec is missing.
"""
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import pytest

from hive.core import code as code_module
from hive.tests import test_code_contract_live_service as live
from hive.tests import test_create_plan_engine as fake

pytestmark = live.pytestmark
REPO = "create-web-scaffold"


def _scaffold_repo(path):
    path.mkdir()
    for name, content in fake.SCAFFOLD.items():
        (path / name).write_text(content)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(path.parent), "GIT_CONFIG_NOSYSTEM": "1"}
    for args in (["init", "-q", "-b", "main"], ["add", "."],
                 ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "commit", "-q", "-m", "seed"]):
        subprocess.run(["git", "-C", str(path), *args], check=True, env=env)


@pytest.fixture(scope="module")
def world():
    import uvicorn
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import FakeSupervisor

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="create-plan-live-", dir=os.environ.get("TMPDIR"))).resolve()
    hive_port, code_port = live.free_port(), live.free_port()
    hive_url = f"http://127.0.0.1:{hive_port}"
    repo = scratch / "repo"
    _scaffold_repo(repo)
    exe = str(pathlib.Path(sys.executable).absolute())
    code_config = scratch / "omegacode.json"
    config = {"release": str(live.RELEASE), "data_root": str(scratch / "code-data"), "port": code_port,
              "hive_url": hive_url, "operator_token": secrets.token_urlsafe(32),
              "repositories": {REPO: {"path": str(repo), "execution_policy": "proposal-only"}}}
    mp = pytest.MonkeyPatch()
    proc = server = thread = None
    try:
        from hive.core.code_local_enrolment import ENV_SOCKET
        mp.delenv(ENV_SOCKET, raising=False)
        mp.setenv("HIVE_ASK_CONDUCTOR", "0")
        mp.setenv("HIVE_CODE_CONTROLLER_ENGINE", "on")     # plan members run in the per-change engine
        mp.setenv("HIVE_CREATE_PLAN_ENGINE", "on")
        mp.setenv("HIVE_CODE_SERVICE_CONFIG", str(code_config))
        mp.setenv("HIVE_SANDBOX_RUN_APPS", "create-acceptance-check")
        mp.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"python": {"exe": exe, "reads": sorted({sys.prefix, sys.base_prefix})}}))
        mp.setenv("HIVE_PLUGIN_DIRS", str(scratch / "hive-data" / "create" / "apps"))
        mp.setattr(code_module.Code, "_loaded_release_mismatch", lambda self: None)
        code_config.write_text(json.dumps(config))
        code_config.chmod(0o600)
        settings = load_settings(data_dir=scratch / "hive-data", admin_password="pw", petta_path=live.PETTA,
                                 public_url=hive_url)
        app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=hive_port, log_level="warning", lifespan="on"))
        server.install_signal_handlers = lambda: None
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 60
        while not server.started:
            assert thread.is_alive() and time.monotonic() < deadline, "scratch hive did not start"
            time.sleep(0.05)
        hive = app.state.hive
        w = live.World()
        w.scratch, w.hive, w.hive_url = scratch, hive, hive_url
        w.http = httpx.Client(base_url=hive_url, timeout=300)
        token = w.http.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        w.op = {"Authorization": f"Bearer {token}"}
        enrol = w.http.post("/api/services/enrol", json={"name": "omegacode"}, headers=w.op)
        assert enrol.status_code == 200, enrol.text
        config["enrol_token"] = enrol.json()["enrol_token"]
        code_config.write_text(json.dumps(config))
        log = open(scratch / "omegacode.log", "wb")
        env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "HOME": str(scratch), "TMPDIR": os.environ.get("TMPDIR", str(scratch))}
        proc = subprocess.Popen([exe, str(live.LAUNCHER), str(code_config)], stdout=log, stderr=subprocess.STDOUT, env=env,
                                cwd=str(scratch))
        try:
            live.wait_http(f"http://127.0.0.1:{code_port}/v1/capabilities", 60, proc)
        except AssertionError:
            raise AssertionError("scratch OmegaCode did not start:\n" + (scratch / "omegacode.log").read_text()[-4000:])
        w.jon = {**live._person(hive, "u_jon"), "Origin": hive_url}
        yield w
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if server is not None:
            server.should_exit = True
            if thread is not None:
                thread.join(15)
        mp.undo()
        if os.environ.get("CODE_CONTRACT_KEEP") != "1":
            shutil.rmtree(scratch, ignore_errors=True)


def _minds_with_tokens(w, hive, engine, tag):
    """The person's Make mind and a Code mind the hive offers, each with its own token (the test plays them)."""
    from hive.core.db import now
    make = w.http.post("/api/swarms", json={"name": f"Make {tag}"}, headers=w.op).json()
    maker = w.http.post("/api/agents", json={"name": f"Maker {tag}", "swarm_id": make["id"]}, headers=w.op).json()
    coders = w.http.post("/api/swarms", json={"name": f"Coders {tag}"}, headers=w.op).json()
    coder = w.http.post("/api/agents", json={"name": f"Coder {tag}", "swarm_id": coders["id"]}, headers=w.op).json()
    hive.db.execute("DELETE FROM person_minds WHERE purpose = 'studio_maker' AND principal = 'user:u_jon'")
    hive.db.execute("INSERT INTO person_minds (principal, purpose, agent_id, swarm_id, created_at, updated_at) VALUES "
                    "('user:u_jon', 'studio_maker', ?, ?, ?, ?)", (maker["id"], make["id"], now(), now()))
    for table, rid in (("swarms", make["id"]), ("agents", maker["id"])):
        hive.db.execute(f"UPDATE {table} SET owner = 'user:u_jon' WHERE id = ?", (rid,))
    for table, rid in (("swarms", coders["id"]), ("agents", coder["id"])):
        hive.db.execute(f"UPDATE {table} SET visibility = 'public' WHERE id = ?", (rid,))
    engine.assignees.set_default("capability:code", [{"selector": ["mind", coder["id"]]}], "the test's Code mind")
    return {maker["id"]: maker["token"], coder["id"]: coder["token"]}


def _play_members(w, hive, pid, tokens, seconds=240):
    """Answer each member helper goal as its assignee mind would (claim, then a result with the piece's files): the
    first app.js is buggy, the repair fixes it. Returns (view, app_builds, packets)."""
    answered, app_builds, packets = set(), 0, []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        view = w.http.get(f"/api/create/plans/{pid}", headers=w.jon).json()
        if view["phase"] in ("ready-to-deploy", "blocked", "stopped"):
            break
        goals = hive.db.all("SELECT * FROM goals WHERE created_by = ? AND status NOT IN ('done', 'submitted', 'failed', "
                            "'cancelled')", (f"create-plan:{pid}",))
        for g in goals:
            if g["id"] in answered or g["assignee"] not in tokens:
                continue
            piece = g["title"].rsplit("build ", 1)[-1]
            if piece == "page":
                files = {"index.html": fake.PAGE}
            elif piece == "style":
                files = {"style.css": fake.STYLE}
            else:
                app_builds += 1
                files = {"app.js": fake.APP_BUGGY if app_builds == 1 else fake.APP_FIXED}
            msg = hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND text LIKE ? ORDER BY created_at DESC "
                              "LIMIT 1", (g["assignee"], f"%{g['id']}%"))
            packets.append((piece, msg["text"] if msg else None))
            auth = {"Authorization": f"Bearer {tokens[g['assignee']]}"}
            assert w.http.post(f"/api/agent/goals/{g['id']}/claim", headers=auth).status_code == 200
            done = w.http.post(f"/api/agent/goals/{g['id']}/result", headers=auth,
                               json={"status": "done", "result": f"built {piece}", "data": {"files": files}})
            assert done.status_code == 200, done.text
            answered.add(g["id"])
        time.sleep(0.5)
    return w.http.get(f"/api/create/plans/{pid}", headers=w.jon).json(), app_builds, packets


@pytest.mark.parametrize("mode", ["patch", "fork-merge"])
def test_slice1_with_real_per_change_members(world, mode, monkeypatch):
    """Each piece is a real R3.14 per-change member on the real OmegaCode build space: its own fork, adopt_member with
    the plan's brief, the member's helper goal for the piece's assignee mind, the plan's sandboxed acceptance check as
    the member's test, code.controller.member_ready waking the plan, member_integrated after the plan's merge.
    patch: what the relay serves today. fork-merge: OmegaCode's own cross-fork merge, run here with the forks route
    added to the relay table FOR THIS TEST ONLY (Code holds that route until it names its actions; see SEAMS item 1)."""
    from hive.core import sandbox_run
    from hive.core.create_plan_members import PerChangeBuilds
    from hive.core.create_plan_ports import AppReleases, OmegaCodeSpace, Ports, SandboxChecks
    w, hive = world, world.hive
    engine = hive.create_plans
    assert engine.enabled()
    hive.settings.code_controller_engine = True
    tokens = _minds_with_tokens(w, hive, engine, mode)
    minds = fake.FakeMinds(engine, question=False)
    checks = SandboxChecks() if sandbox_run.available() else fake.SubprocessChecks()
    if mode == "fork-merge":
        from hive.core import code as code_mod
        monkeypatch.setattr(code_mod, "PROXY_ROUTES", code_mod.PROXY_ROUTES + [
            ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/forks$", ("read", "workspace"))])
    space_port = OmegaCodeSpace(engine)
    assert space_port._mode() == mode
    engine.ports = Ports(engine, minds, space_port, checks, AppReleases(engine))
    assert isinstance(engine.ports.members, PerChangeBuilds)                      # the only builder
    assert hive.code_controller.member_ports.run_test == engine.ports.members.run_test

    out = w.http.post("/api/create/plans", json={"sentence": fake.SENTENCE}, headers=w.jon)
    assert out.status_code == 200, out.text
    pid = out.json()["plan_id"]
    view, app_builds, packets = _play_members(w, hive, pid, tokens)
    members = [(p["id"], p["member"], dict((k, hive.code_controller._run(p["member"])[k]) for k in (
        "phase", "status", "next_action", "last_error")) if p["member"] else None) for p in view["pieces"]]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"],
                                                [(r["kind"], r["verdict"]) for r in view["journal"]][-8:], members,
                                                [(e["kind"], e["state"]) for e in view["effects"]][-6:])
    assert not [c for c in minds.calls if c[0] == "build"]                         # no typed-goal build anywhere
    pieces = {p["id"]: p for p in view["pieces"]}
    assert all(p["member"] and p["member"].startswith("mt_") for p in pieces.values())
    # the buggy app.js was caught by the member's own test (the plan's check on its candidate) and repaired there
    assert app_builds == 2
    for p in pieces.values():
        mrun = hive.code_controller._run(p["member"])
        assert mrun["profile"] == "plan-member" and mrun["phase"] == "delivered", (p["id"], mrun["phase"], mrun["status"])
        member = json.loads(mrun["member"])
        assert member["brief"]["sentence"] == fake.SENTENCE and member["brief"]["title"] == p["title"]
    app_member = [r["kind"] for r in hive.code_controller._journal(pieces["app"]["member"])]
    assert "tests-fail" in app_member and "tests-pass" in app_member and app_member[-1] == "integrated"
    assert [c["state"] for c in view["checks"]][0] == "fail" and view["checks"][-1]["state"] == "pass"
    # the plan's brief reached the mind in its helper packet (what to build, not only which files)
    app_packets = [body for piece, body in packets if piece == "app"]
    assert app_packets and all(b and "Fill the list" in b and "List the eight phases" in b for b in app_packets)
    space = engine._space(engine._run(pid))
    assert space["integration"].startswith("ws_") and set(space["merged"]) == {"page", "style", "app"}
    assert set(space["fork_origin"]) == {"page", "style", "app"} and space["forks"] == {}   # each merged fork retired
    # the integration workspace really holds every piece's work (read back through the person's relay)
    for name, want in (("app.js", fake.APP_FIXED), ("index.html", fake.PAGE), ("style.css", fake.STYLE)):
        assert w.http.get(f"/api/create/plans/{pid}/files", params={"path": name}, headers=w.jon).json()["content"] == want
    # every OmegaCode call went through the relay on the person's own grant for this plan's task
    assert hive.db.one("SELECT 1 FROM goal_grants WHERE goal_id = ? AND principal = 'user:u_jon'", (space["task_id"],))
    pv = w.http.get(f"/api/create/plans/{pid}/preview", headers=w.jon).json()
    assert pv["files"]["app.js"] == fake.APP_FIXED

    deployed = w.http.post(f"/api/create/plans/{pid}/deploy", headers=w.jon)
    assert deployed.status_code == 200, deployed.text
    view = deployed.json()
    assert view["phase"] == "deployed", (view["last_error"], view["journal"][-1])
    assert hive.programs.ui_bundle(view["installed"]["program_id"])["files"]["index.html"] == fake.PAGE
