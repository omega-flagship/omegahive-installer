"""Contract tests: the OmegaHive host against the REAL OmegaCode service, Create · Code proposal-and-test path.

Why: on 2026-11-08 OmegaCode answered request_binding.digest as bare 64-hex while the hive compared it with its own
'sha256:'-prefixed sha(). Every fixture used the hive's own format, so the suite passed while every real proposal was
refused. Here no hop is faked: a scratch hive is served on a free loopback port (uvicorn, in this process, so the test
can set up people, templates and settings) and a scratch OmegaCode service is started from its release tree on
another free loopback port, enrolled with the scratch hive, with a scratch store and a synthetic two-file git repo.
Every hop below goes over real HTTP between the two, and each asserts the wire shapes it depends on.

Synthetic only: invented person, tokens and repo; no provider calls (mock models), a fake process supervisor (no mind
process is started; the test drives the helper's and controller's own client code with their real member tokens).
Never port 8700 or 8724, never the live hive or its Code service, never a live data directory.

Skipped (not failed) when the OmegaCode release tree, PeTTa, git or macOS sandbox-exec is missing.
Release tree: $OMEGACODE_SOURCE, else $OMEGACODE_RELEASES/<INTENDED_SERVICE_RELEASE> (default
~/OmegaDot/.runtime/omegacode/releases/<pin>). The hops run in file order and share one scratch world (~5 s).
"""
import datetime
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import pytest
import re

from hive.core import code as code_module
from hive.core.db import now
from hive.core.hive import token_hash

ROOT = pathlib.Path(__file__).resolve().parents[2]
PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
RELEASES = pathlib.Path(os.environ.get("OMEGACODE_RELEASES",
                                       str(pathlib.Path.home() / "OmegaDot/.runtime/omegacode/releases")))
# OMEGACODE_SOURCE: any folder holding an omegacode package with the proposal-test plane (e.g. a src/ checkout);
# default: the exact release the hive pins (INTENDED_SERVICE_RELEASE), since that is what the relay tables describe.
RELEASE = pathlib.Path(os.environ["OMEGACODE_SOURCE"]) if os.environ.get("OMEGACODE_SOURCE") \
    else RELEASES / code_module.INTENDED_SERVICE_RELEASE
LAUNCHER = pathlib.Path(__file__).resolve().parent / "omegacode_scratch_service.py"
PLUGIN = ROOT / "hive" / "plugins" / "code_project_test"

CALCULATOR = "def add(a, b):\n    return a - b\n"          # bytes 28..29 are the '-' the person scopes
TEST_FILE = ("from calculator import add\n\nassert add(2, 3) == 5, add(2, 3)\nprint('calculator passed')\n")
REPO_ID = "calc"
HEX = re.compile(r"[0-9a-f]{64}")


def _missing():
    if not (RELEASE / "omegacode" / "purpose_startup.py").is_file():
        return f"OmegaCode release tree not found at {RELEASE}"
    if not pathlib.Path(PETTA, "src", "main.pl").exists():
        return "needs PeTTa"
    if shutil.which("git") is None:
        return "needs git"
    if sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"):
        return "needs macOS sandbox-exec for the host's sandboxed proposal test"
    try:
        import fastapi, uvicorn  # noqa: F401
    except ImportError:
        return "needs fastapi and uvicorn"
    return None


pytestmark = pytest.mark.skipif(_missing() is not None, reason=_missing() or "")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def hex_sha(raw):
    return hashlib.sha256(raw).hexdigest()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    assert port not in (8700, 8724)
    return port


def wait_http(url, seconds=30, proc=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise AssertionError(f"process exited {proc.returncode}")
        try:
            httpx.get(url, timeout=1)
            return
        except httpx.HTTPError:
            time.sleep(0.1)
    raise AssertionError(f"{url} did not answer")


class World:
    pass


def _git_repo(path):
    path.mkdir()
    (path / "calculator.py").write_text(CALCULATOR)
    (path / "test_calculator.py").write_text(TEST_FILE)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(path.parent), "GIT_CONFIG_NOSYSTEM": "1"}
    for args in (["init", "-q", "-b", "main"], ["add", "."],
                 ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "commit", "-q", "-m", "seed"]):
        subprocess.run(["git", "-C", str(path), *args], check=True, env=env)


def _person(hive, pid):
    token = secrets.token_urlsafe(24)
    hive.db.insert("people", {"id": pid, "email": f"{pid}@example.test", "name": pid, "role": "admin", "created_at": now()})
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": f"user:{pid}"})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def world():
    import uvicorn
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.core.programs import Programs
    from hive.tests.test_core_api import FakeSupervisor

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="code-contract-")).resolve()
    hive_port, code_port = free_port(), free_port()
    hive_url = f"http://127.0.0.1:{hive_port}"
    repo = scratch / "repo"
    _git_repo(repo)
    exe = str(pathlib.Path(sys.executable).absolute())
    code_config = scratch / "omegacode.json"
    operator_token = secrets.token_urlsafe(32)
    config = {"release": str(RELEASE), "data_root": str(scratch / "code-data"), "port": code_port, "hive_url": hive_url,
              "operator_token": operator_token, "sandbox_project_tests_enabled": True,
              "copy_effect_policy_scratch": True,        # scratch stand-in for Code's (absent) copy-effect owner policy
              "repositories": {REPO_ID: {"path": str(repo), "execution_policy": "proposal-only"}}}
    mp = pytest.MonkeyPatch()
    proc = None
    server = None
    thread = None
    try:
        from hive.core.code_local_enrolment import ENV_SOCKET
        mp.delenv(ENV_SOCKET, raising=False)
        mp.setenv("HIVE_ASK_CONDUCTOR", "0")
        mp.setenv("HIVE_CODE_CONTROLLER_ENGINE", "0")   # the hops drive the controller's client by hand; the engine test turns it on
        mp.setenv("HIVE_CODE_SERVICE_CONFIG", str(code_config))
        mp.setenv("HIVE_CODE_SANDBOX_PROJECT_TESTS", "on")
        mp.setenv("HIVE_SANDBOX_RUN_APPS", "code-project-test")
        mp.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"python": {"exe": exe, "reads": sorted({sys.prefix, sys.base_prefix})}}))
        mp.setenv("HIVE_APP_PINS", json.dumps({"code-project-test": {"release": str(PLUGIN),
                                                                     "digest": Programs.source_digest(PLUGIN)}}))
        mp.setattr(code_module.Code, "_loaded_release_mismatch", lambda self: None)   # no Code LaunchAgent here
        code_config.write_text(json.dumps(config))
        code_config.chmod(0o600)
        settings = load_settings(data_dir=scratch / "hive-data", admin_password="pw", petta_path=PETTA,
                                 public_url=hive_url)
        supervisor = FakeSupervisor()
        app = create_app(settings, supervisor=supervisor, reconcile_seconds=0)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=hive_port, log_level="warning", lifespan="on"))
        server.install_signal_handlers = lambda: None
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 60
        while not server.started:
            assert thread.is_alive() and time.monotonic() < deadline, "scratch hive did not start"
            time.sleep(0.05)
        hive = app.state.hive
        w = World()
        w.scratch, w.hive, w.hive_url, w.code_port, w.repo, w.exe = scratch, hive, hive_url, code_port, repo, exe
        w.http = httpx.Client(base_url=hive_url, timeout=60)
        token = w.http.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        w.op = {"Authorization": f"Bearer {token}"}

        # Enrol the scratch Code service exactly as an owner does: a one-time token from the hive, then the service
        # registers itself over HTTP (its registration.py), then serves with the sandbox proposal-test plane on.
        enrol = w.http.post("/api/services/enrol", json={"name": "omegacode"}, headers=w.op)
        assert enrol.status_code == 200, enrol.text
        config["enrol_token"] = enrol.json()["enrol_token"]
        code_config.write_text(json.dumps(config))
        log = open(scratch / "omegacode.log", "wb")
        env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "HOME": str(scratch), "TMPDIR": os.environ.get("TMPDIR", str(scratch))}
        proc = subprocess.Popen([exe, str(LAUNCHER), str(code_config)], stdout=log, stderr=subprocess.STDOUT, env=env,
                                cwd=str(scratch))
        w.proc, w.log = proc, scratch / "omegacode.log"
        try:
            wait_http(f"http://127.0.0.1:{code_port}/v1/capabilities", 60, proc)
        except AssertionError:
            raise AssertionError("scratch OmegaCode did not start:\n" + w.log.read_text()[-4000:])

        # The live wiring the Create · Code path uses, on this scratch hive only.
        hive.settings.mind_spawn = True
        hive.settings.proposal_test_claims = True
        hive.settings.proposal_test_argv_prefixes = [[exe, "test_calculator.py"]]
        sup, running, tokens = hive.supervisor, set(), {}
        sup.start = lambda aid: (sup.calls.append(("start", aid)), running.add(aid))
        sup.stop = lambda aid: (sup.calls.append(("stop", aid)), running.discard(aid))
        sup.prepare = lambda agent, token: tokens.__setitem__(agent["id"], token)
        sup.driver = lambda agent: type("D", (), {"name": "local", "status": staticmethod(
            lambda aid: "running" if aid in running else "absent")})()
        mp.setattr(hive.health, "mind_id", lambda: None)
        w.tokens = tokens
        w.jon = _person(hive, "u_jon")
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
        else:
            print("kept", scratch)


def test_scratch_services_are_up(world):
    svc = world.hive.services.by_name("omegacode")
    assert svc["address"] == f"http://127.0.0.1:{world.code_port}"


def proxy(w, method, path, body=None, params=None):
    query = {"task_id": w.task_id, "grant_id": w.grant_id, "repository_id": REPO_ID} | (params or {})
    return w.http.request(method, "/api/code/proxy" + path, params=query, headers=w.jon,
                          content=None if body is None else json.dumps(body))


def test_hop1_person_opens_the_repository(world):
    w = world
    out = w.http.post("/api/code/open", json={"target": "repo:" + REPO_ID}, headers=w.jon)
    assert out.status_code == 200, out.text
    opened = out.json()
    head = subprocess.run(["git", "-C", str(w.repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    assert opened["repository_id"] == REPO_ID and opened["base_commit"] == head
    w.task_id, w.grant_id, w.swarm_id, w.base_commit = opened["task_id"], opened["grant_id"], opened["swarm_id"], head


def test_hop2_workspace_through_the_person_relay(world):
    w = world
    out = proxy(w, "POST", "/v1/workspaces", {"operation_id": "op-ws-0001", "repository_id": REPO_ID,
                                             "task_id": w.task_id, "base_commit": w.base_commit})
    assert out.status_code == 201, out.text
    ws = out.json()
    # wire: ws_<32 hex>, generation int, tree digests bare 64-hex (never 'sha256:'), bound to this task/swarm/repo
    assert re.fullmatch(r"ws_[0-9a-f]{32}", ws["id"]) and ws["generation"] == 1
    assert HEX.fullmatch(ws["tree_digest"]) and ws["base_commit"] == w.base_commit
    assert (ws["task_id"], ws["swarm_id"], ws["repository_id"]) == (w.task_id, w.swarm_id, REPO_ID)
    assert ws["execution_policy"] == "proposal-only"
    w.ws = ws


def test_hop3_person_scopes_bytes_28_to_29(world):
    w = world
    assert CALCULATOR.encode()[28:29] == b"-"
    out = proxy(w, "POST", f"/v1/workspaces/{w.ws['id']}/suggestion-scopes",
                {"operation_id": "op-scope-0001", "expected_generation": w.ws["generation"],
                 "expected_tree_digest": w.ws["tree_digest"], "ranges": {"calculator.py": [[28, 29]]}},
                params={"include_binding": "true"})
    assert out.status_code == 200, out.text
    scope = out.json()
    # wire: the receipt's digest and file digests are bare 64-hex; the binding is the workspace's generation and tree
    assert set(scope) == {"id", "workspace_id", "digest", "author", "created_at", "binding", "ranges", "file_digests",
                          "edit_authority"}
    assert scope["id"].startswith("scope_") and HEX.fullmatch(scope["digest"]) and scope["author"] == "user:u_jon"
    assert scope["binding"] == {"workspace_id": w.ws["id"], "task_id": w.task_id, "generation": 1,
                                "tree_digest": w.ws["tree_digest"]}
    assert scope["ranges"] == {"calculator.py": [[28, 29]]} and scope["edit_authority"] is False
    assert scope["file_digests"] == {"calculator.py": hex_sha(CALCULATOR.encode())}
    w.scope = scope


def test_hop4_request_with_a_controller_lease(world):
    w, hive = world, world.hive
    team = w.http.post("/api/swarms", json={"name": "Coders", "visibility": "public"}, headers=w.op).json()
    ctl = w.http.post("/api/agents", json={"name": "Lead", "swarm_id": team["id"], "budget_usd": 5}, headers=w.op).json()
    assert w.http.patch(f"/api/swarms/{team['id']}", json={"coordinator_id": ctl["id"]}, headers=w.op).status_code == 200
    assert w.http.put(f"/api/swarms/{team['id']}/services", json={"kinds": ["code"]}, headers=w.op).status_code == 200
    hive.minds.templates = hive.minds._load_templates([
        {"template_id": "native-a", "model_id": "mock/echo", "max_allocation_usd": 0.5,
         "controls": ["interrupt", "stop", "pause", "resume", "retire"], "teams": [team["id"]]}])
    assert hive.minds.template_errors == []
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).isoformat(timespec="seconds")
    # the origin carries the scope receipt's digest in the hive's own form, as the canvas sends it (vibeSession.ts)
    origin = {"task_id": w.task_id, "repository_id": REPO_ID, "workspace_id": w.ws["id"], "scope_id": w.scope["id"],
              "scope_digest": "sha256:" + w.scope["digest"], "generation": w.ws["generation"]}
    out = w.http.post("/api/requests", headers=w.jon, json={
        "operation_id": "op-request-1", "to_swarm": team["id"], "kind": "code", "title": "Fix the calculator",
        "instruction": "add() subtracts; make it add.", "origin": origin, "budget": {"limit_usd": 0.8},
        "lifetime": {"until": until}, "lease": {"template_ids": ["native-a"], "max_children": 2}})
    assert out.status_code == 201, out.text
    w.team, w.ctl, w.rq, w.origin = team, ctl, out.json(), origin
    lease = hive.minds._request_lease(w.rq["request_id"])
    assert lease["controller_id"] == ctl["id"] and hive.minds.lease_live(lease)
    child = w.http.post("/api/agent/minds", headers={"Authorization": f"Bearer {ctl['token']}"}, json={
        "operation_id": "op-spawn-0001", "request_id": w.rq["request_id"], "team_id": team["id"],
        "template_id": "native-a", "model_id": None, "initial_prompt": "Read the scope and propose.",
        "lifecycle_mode": "ongoing", "lifecycle_limits": None, "allocation_usd": 0.2})
    assert child.status_code in (200, 201), child.text
    w.child_id = child.json()["child_id"]
    assert w.tokens.get(w.child_id), "the helper's member token is issued at spawn"


def _client_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("code_proposal_live_contract", ROOT / "modules/code/src/code_proposal.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cp():
    return _client_module()


def helper(w, cp):
    return cp.DelegatedProposalClient(w.hive_url, w.tokens[w.child_id])


def controller(w, cp):
    return cp.DelegatedProposalClient(w.hive_url, w.ctl["token"])


def test_hop5_helper_reads_context_and_the_scoped_file(world, cp):
    w = world
    c = helper(w, cp)
    try:
        context = c.context(w.ws["id"])
        read = c.read(w.ws["id"], "calculator.py")
    finally:
        c.close()
    assert context["status"] == "PERSON_SCOPE_OBSERVED" and context["repository_id"] == REPO_ID
    assert context["delegated"]["origin_scope"] == {"scope_id": w.scope["id"], "scope_digest": "sha256:" + w.scope["digest"],
                                                    "generation": 1}
    assert context["delegated"]["request_id"] == w.rq["request_id"] and context["delegated"]["controller_id"] == w.ctl["id"]
    # the service's scope read (relayed for the mind) has the bare-hex digest the client prefixes to compare
    assert context["scope"]["digest"] == w.scope["digest"] and context["scope"]["currency"] == "current"
    assert read["content"] == CALCULATOR and read["digest"] == hex_sha(CALCULATOR.encode())
    assert read["person_ranges"] == [{"start_byte": 28, "end_byte": 29, "before_digest": hex_sha(b"-")}]
    assert read["generation"] == 1 and read["tree_digest"] == w.ws["tree_digest"]


def _assert_retained(w, out, child_id):
    assert out["status"] == "RETAINED_PERSON_REVIEW_REQUIRED" and out["applied"] is False
    record, binding = out["record"], out["request_binding"]
    assert re.fullmatch(r"suggestion_[0-9a-f]{32}", record["id"]) and HEX.fullmatch(record["digest"])
    assert record["author"] == child_id and record["scope_id"] == w.scope["id"]
    # THE seam of 2026-11-08: OmegaCode's request_binding digest is BARE 64-hex of the canonical provenance
    assert HEX.fullmatch(binding["digest"]) and not binding["digest"].startswith("sha256:")
    assert binding["digest"] == hex_sha(canonical(binding["content"]).encode())
    assert binding["content"]["delegated"]["origin_scope"]["scope_digest"] == "sha256:" + w.scope["digest"]
    return record


def test_hop6_helper_proposes_an_exact_person_range_without_before_digest(world, cp):
    w = world
    c = helper(w, cp)
    try:
        out = c.propose(w.ws["id"], "op-propose-0001",
                        [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+"}])
    finally:
        c.close()
    w.proposal = _assert_retained(w, out, w.child_id)
    # the person's own readback of the same proposal through the person relay: identical bare-hex binding
    got = proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/suggestions/{w.proposal['id']}",
                params={"include_request_binding": "true"})
    assert got.status_code == 200, got.text
    saved = got.json()
    assert set(saved) == {"record", "content", "decisions", "currency", "request_binding"}
    assert saved["record"] == w.proposal and saved["decisions"] == [] and saved["currency"] == "current"
    assert saved["request_binding"] == out["request_binding"]
    assert HEX.fullmatch(saved["content"]["digest"]) and HEX.fullmatch(saved["content"]["binding"]["tree_digest"])


def test_hop7_helper_proposes_with_an_explicit_before_digest(world, cp):
    w = world
    c = helper(w, cp)
    try:
        out = c.propose(w.ws["id"], "op-propose-0002",
                        [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+",
                          "before_digest": hex_sha(b"-")}])
        # a wrong before_digest is refused before anything is posted
        with pytest.raises(cp.ProposalRefused) as refused:
            c.propose(w.ws["id"], "op-propose-0003",
                      [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+",
                        "before_digest": hex_sha(b"*")}])
    finally:
        c.close()
    assert refused.value.code == "hunk_source_or_scope"
    _assert_retained(w, out, w.child_id)


def test_hop8_controller_test_context_lookup(world, cp):
    w = world
    c = controller(w, cp)
    try:
        value = c.test_context(w.rq["request_id"], w.proposal["id"])
    finally:
        c.close()
    lease = w.hive.minds._request_lease(w.rq["request_id"])
    assert value["schema"] == "hive.controller-code-test-lookup/1" and value["lease_id"] == lease["id"]
    # the host turns OmegaCode's bare hex into its own 'sha256:' references, once, here
    assert value["proposal"] == {"proposal_id": w.proposal["id"], "proposal_digest": "sha256:" + w.proposal["digest"],
                                 "normalized_hunks_digest": value["proposal"]["normalized_hunks_digest"]}
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", value["proposal"]["normalized_hunks_digest"])
    assert value["parent"] == {"workspace_id": w.ws["id"], "generation": 1, "tree_digest": "sha256:" + w.ws["tree_digest"]}
    w.lookup = value


def test_hop8b_the_pre_fix_comparison_would_have_refused_this_real_proposal(world, cp, monkeypatch):
    """Proof that this module catches the 2026-11-08 seam: restore the old exact comparison (bare wire digest against
    the hive's own 'sha256:' sha()) and the same real proposal is refused code_test_source again."""
    from hive.core import code_test_intents
    monkeypatch.setattr(code_test_intents, "_bare", lambda digest: "sha256:" + digest if type(digest) is str else None)
    c = controller(world, cp)
    try:
        with pytest.raises(cp.ProposalRefused) as refused:
            c.test_context(world.rq["request_id"], world.proposal["id"])
    finally:
        c.close()
    assert refused.value.code == "code_test_source"


def test_hop9_controller_prepares_the_proposal_test(world, cp):
    w = world
    c = controller(w, cp)
    try:
        out = c.test_prepare_simple(w.rq["request_id"], "op-ptest-0001", w.proposal["id"])
    finally:
        c.close()
    assert out["status"] == "CONTROLLER_TEST_PREPARED" and out["filled_from"] == "host_test_context", out
    assert re.fullmatch(r"pt_[0-9a-f]{24}", out["test_id"]) and out["request_id"] == w.rq["request_id"]
    assert out["proposal"] == w.lookup["proposal"] and out["parent"] == w.lookup["parent"]
    prep = out["preparation"]
    # OmegaCode's bind receipt (relayed back through the hive) uses the hive's 'sha256:' form; a fresh fork workspace
    assert prep["test_id"] == out["test_id"] and prep["fork_workspace_id"] != w.ws["id"]
    assert re.fullmatch(r"ws_[0-9a-f]{32}", prep["fork_workspace_id"])
    for key in ("test_tree_digest", "preparation_digest"):
        assert re.fullmatch(r"sha256:[0-9a-f]{64}", prep[key]), key
    assert out["policy"]["permitted_argv_prefixes"] == [[w.exe, "test_calculator.py"]]
    assert out["launch_authority"] is False and out["accepted_source"] is False
    # the hive retained the same binding it was sent
    test = w.hive.db.one("SELECT preparation FROM proposal_tests WHERE id=?", (out["test_id"],))
    retained = json.loads(test["preparation"])
    assert (retained["fork_workspace_id"], retained["test_tree_digest"], retained["preparation_digest"]) == \
        (prep["fork_workspace_id"], prep["test_tree_digest"], prep["preparation_digest"])
    w.prepared = out


def test_hop10_controller_runs_the_default_command(world, cp):
    w = world
    c = controller(w, cp)
    try:
        out = c.test_run(w.prepared["test_id"], "launch-0001", None, simple="")
    finally:
        c.close()
    assert out["status"] == "CONTROLLER_TEST_OBSERVED" and out["outcome_unknown"] is False, out
    assert out["command"] == {"runtime": "python", "argv": [w.exe, "test_calculator.py"], "runtime_seconds": 10}
    assert out["command_outcome"] == "succeeded" and out["exit_code"] == 0
    assert out["tested"] is True and out["accepted_source"] is False and out["currency"] == "current"
    assert out["logs"]["stdout"]["text"] == "calculator passed\n" and out["logs"]["stderr"]["text"] == ""
    assert out["logs"]["stdout"]["digest"] == "sha256:" + hex_sha(b"calculator passed\n")
    for key in ("receipt_digest", "snapshot_digest"):
        assert re.fullmatch(r"sha256:[0-9a-f]{64}", out[key]), key
    assert out["policy"]["test_remaining"]["runs_remaining"] == 4      # admitted before the run
    w.run = out


def test_hop11_controller_reads_the_result(world, cp):
    w = world
    c = controller(w, cp)
    try:
        out = c.test_result(w.prepared["test_id"], "launch-0001")
    finally:
        c.close()
    assert out["status"] == "CONTROLLER_TEST_HISTORY" and out["no_work"] is True and out["accepted_source"] is False
    assert len(out["results"]) == 1
    entry = out["results"][0]
    assert entry["launch_key"] == "launch-0001" and entry["exit_code"] == 0 and entry["command_outcome"] == "succeeded"
    assert entry["logs"]["stdout"]["text"] == "calculator passed\n"
    assert entry["receipt_digest"] == w.run["receipt_digest"] and entry["snapshot_digest"] == w.run["snapshot_digest"]
    # the history is a read (no work, never tested), and the hive settled the one admitted run against the allowance
    assert entry["tested"] is False and entry["currency"] == "unknown"
    assert out["policy"]["test_remaining"]["runs_remaining"] == 3
    # and the source the person sees is still unchanged: a proposal test never edits the original workspace
    got = proxy(w, "GET", f"/v1/workspaces/{w.ws['id']}/files", params={"path": "calculator.py"})
    assert got.status_code == 200 and got.json()["content"] == CALCULATOR
