"""Live check: the commands a Code target says a person's run may start are the ones the REAL OmegaCode service runs.

Why: the Code page's Tests offered python3 -m pytest -q on hives that grant no command, and OmegaCode refused every run
(a staging hive on 11 November: its stored run capability had argv_prefixes [], and both commands the page offered came
back "argv is outside the explicitly granted command prefixes"). The page now offers only what the target's `run`
reports, so `run` has to be the service's own verdict. No hop is faked here: a scratch hive on a free loopback port
relays to a scratch OmegaCode service started from the published release tree and enrolled with it, over a synthetic
one-file repository whose execution is trusted-native, and a granted command really runs.

Synthetic only: invented person, tokens and repository; mock models. Never port 8700 or 8724, never a live hive or its
data. Skipped (not failed) when the release tree, PeTTa or git is missing. Release tree: $OMEGACODE_SOURCE, else
$OMEGACODE_RELEASES/<PUBLISHED_SERVICE_RELEASE>, the release the installer ships.
"""
import json
import os
import pathlib
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import pytest

from hive.core import code as code_module
from hive.tests.test_code_contract_live_service import LAUNCHER, PETTA, _person, free_port, wait_http

RELEASES = pathlib.Path(os.environ.get("OMEGACODE_RELEASES", str(pathlib.Path.home() / "omegacode-releases")))
RELEASE = pathlib.Path(os.environ["OMEGACODE_SOURCE"]) if os.environ.get("OMEGACODE_SOURCE") \
    else RELEASES / code_module.PUBLISHED_SERVICE_RELEASE
REPO_ID = "small-app"
CHECK = "print('small app ok')\n"


def _missing():
    if not (RELEASE / "omegacode" / "purpose_startup.py").is_file():
        return f"OmegaCode release tree not found at {RELEASE}"
    if code_module.Code._module_digest(RELEASE / "omegacode") != code_module.PUBLISHED_SERVICE_RELEASE:
        return f"{RELEASE} is not the published release {code_module.PUBLISHED_SERVICE_RELEASE[:8]}"
    if not pathlib.Path(PETTA, "src", "main.pl").exists():
        return "needs PeTTa"
    if shutil.which("git") is None:
        return "needs git"
    try:
        import fastapi, uvicorn  # noqa: F401
    except ImportError:
        return "needs fastapi and uvicorn"
    return None


pytestmark = pytest.mark.skipif(_missing() is not None, reason=_missing() or "")


class World:
    pass


@pytest.fixture(scope="module")
def world():
    import uvicorn
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.core.code_local_enrolment import ENV_SOCKET
    from hive.tests.test_core_api import FakeSupervisor

    scratch = pathlib.Path(tempfile.mkdtemp(prefix="code-run-authority-")).resolve()
    hive_port, code_port = free_port(), free_port()
    hive_url = f"http://127.0.0.1:{hive_port}"
    repo = scratch / "repo"
    repo.mkdir()
    (repo / "check_app.py").write_text(CHECK)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(scratch), "GIT_CONFIG_NOSYSTEM": "1"}
    for args in (["init", "-q", "-b", "main"], ["add", "."],
                 ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "commit", "-q", "-m", "seed"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True, env=env)
    code_config = scratch / "omegacode.json"
    config = {"release": str(RELEASE), "data_root": str(scratch / "code-data"), "port": code_port, "hive_url": hive_url,
              "operator_token": secrets.token_urlsafe(32), "sandbox_project_tests_enabled": False,
              "repositories": {REPO_ID: {"path": str(repo)}}}            # no execution_policy: trusted-native
    mp = pytest.MonkeyPatch()
    proc = server = thread = None
    try:
        mp.delenv(ENV_SOCKET, raising=False)
        mp.delenv("HIVE_CODE_REPOS", raising=False)
        mp.setenv("HIVE_ASK_CONDUCTOR", "0")
        mp.setenv("HIVE_CODE_CONTROLLER_ENGINE", "0")
        mp.setenv("HIVE_CODE_SERVICE_CONFIG", str(code_config))
        mp.setenv("HIVE_CODE_SERVICE_RELEASE", code_module.PUBLISHED_SERVICE_RELEASE)   # as an installed own hive
        mp.setattr(code_module.Code, "_loaded_release_mismatch", lambda self: None)  # no Code launch job here
        code_config.write_text(json.dumps(config))
        code_config.chmod(0o600)
        settings = load_settings(data_dir=scratch / "hive-data", admin_password="pw", petta_path=PETTA,
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
        w = World()
        w.scratch, w.hive, w.repo, w.code_data = scratch, app.state.hive, repo, scratch / "code-data"
        w.exe = str(pathlib.Path(sys.executable).absolute())
        w.http = httpx.Client(base_url=hive_url, timeout=60)
        token = w.http.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        w.op = {"Authorization": f"Bearer {token}"}
        enrol = w.http.post("/api/services/enrol", json={"name": "omegacode"}, headers=w.op)
        assert enrol.status_code == 200, enrol.text
        config["enrol_token"] = enrol.json()["enrol_token"]
        code_config.write_text(json.dumps(config))
        log = open(scratch / "omegacode.log", "wb")
        proc = subprocess.Popen([w.exe, str(LAUNCHER), str(code_config)], stdout=log, stderr=subprocess.STDOUT, cwd=str(scratch),
                                env={"PATH": "/usr/bin:/bin", "HOME": str(scratch), "PYTHONDONTWRITEBYTECODE": "1",
                                     "TMPDIR": os.environ.get("TMPDIR", str(scratch))})
        try:
            wait_http(f"http://127.0.0.1:{code_port}/v1/capabilities", 60, proc)
        except AssertionError:
            raise AssertionError("scratch OmegaCode did not start:\n" + (scratch / "omegacode.log").read_text()[-4000:])
        w.jon = _person(w.hive, "u_jon")
        opened = w.http.post("/api/code/open", json={"target": "repo:" + REPO_ID}, headers=w.jon)
        assert opened.status_code == 200, opened.text
        w.opened = opened.json()
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        ws = proxy(w, "POST", "/v1/workspaces", {"operation_id": "op-ws-run-authority", "repository_id": REPO_ID,
                                                 "task_id": w.opened["task_id"], "base_commit": head})
        assert ws.status_code == 201, ws.text
        w.ws = ws.json()
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
        shutil.rmtree(scratch, ignore_errors=True)


def proxy(w, method, path, body=None):
    query = {"task_id": w.opened["task_id"], "grant_id": w.opened["grant_id"], "repository_id": REPO_ID}
    return w.http.request(method, "/api/code/proxy" + path, params=query, headers=w.jon,
                          content=None if body is None else json.dumps(body))


def grant(w, prefixes):
    """The operator's HIVE_CODE_REPOS argv_prefixes for the repository, as the hive holds them; minted anew."""
    w.hive.code.repos[REPO_ID].pop("argv_prefixes", None)
    if prefixes is not None:
        w.hive.code.repos[REPO_ID]["argv_prefixes"] = prefixes
    w.hive.code._caps.clear()
    targets = {t["id"]: t for t in w.http.get("/api/code/targets", headers=w.jon).json()}
    return targets["repo:" + REPO_ID]["run"]


def start(w, argv):
    return proxy(w, "POST", "/v1/runs", {"operation_id": f"run-{secrets.token_hex(6)}", "workspace_id": w.ws["id"],
                                         "expected_generation": w.ws["generation"],
                                         "expected_tree_digest": w.ws["tree_digest"], "argv": argv, "timeout_seconds": 120})


def stored_run_prefixes(w):
    """The argv_prefixes of every run capability OmegaCode stored for this task's grant, in the order it stored them:
    its own grant metadata (omegacode store.py keeps them in <data_root>/index.sqlite3, table grants)."""
    with sqlite3.connect(f"file:{w.code_data / 'index.sqlite3'}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT body FROM grants ORDER BY rowid").fetchall()
    return [claims["argv_prefixes"] for claims in map(json.loads, (body for (body,) in rows))
            if claims.get("grant_id") == w.opened["grant_id"] and "run" in claims.get("actions", [])]


def test_no_granted_command_is_said_and_the_service_refuses_what_the_page_used_to_guess(world):
    w = world
    run = grant(world, None)
    assert run == {"available": False, "why_not": "the hive's operator has allowed no commands for this repository", "argv_prefixes": []}
    out = start(w, ["python3", "-m", "pytest", "-q"])
    assert out.status_code == 403, out.text
    assert out.json()["error"]["code"] == "command_forbidden"
    assert out.json()["error"]["message"] == "argv is outside the explicitly granted command prefixes"
    assert stored_run_prefixes(w) == [[]]                       # Code's own record: this run grant allows nothing


def test_a_granted_command_is_offered_and_really_runs_and_nothing_else_does(world):
    w = world
    prefixes = [[w.exe, "check_app.py"]]
    run = grant(w, prefixes)
    assert run == {"available": True, "why_not": None, "argv_prefixes": prefixes}
    refused = start(w, ["python3", "-m", "pytest", "-q"])
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "command_forbidden", refused.text
    out = start(w, run["argv_prefixes"][0])                     # the one command the page's Test runs
    assert out.status_code in (200, 201), out.text
    record = out.json()
    deadline = time.monotonic() + 60
    while record["status"] in ("prepared", "starting", "running", "cancel_requested"):
        assert time.monotonic() < deadline, record
        time.sleep(0.2)
        record = proxy(w, "GET", f"/v1/runs/{record['id']}").json()
    # OmegaCode's own pass rule for a run (service.py verification): completed, exit 0, every descendant ended
    assert (record["status"], record["exit_code"], record["descendants_terminated"], record["argv"]) \
        == ("completed", 0, True, [w.exe, "check_app.py"]), record
    assert stored_run_prefixes(w)[-1] == prefixes               # the capability Code checked: what the target said
