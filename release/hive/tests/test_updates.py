"""R18: updates are detected and shown, owners can ask and hold, admins or an explicitly allowed mind apply them."""
import datetime
import json
import pathlib
import tempfile

from hive.core import updates as updates_mod
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

PROGRAM = '''
def describe():
    return {"kinds": [{"id": "note", "role": "other"}]}
def view(ctx, request):
    return {"version": VERSION}
def act(ctx, action, params):
    return {"ok": True}
VERSION = "%s"
'''


def _app(tmp, version):
    folder = pathlib.Path(tmp) / "demo-app"
    folder.mkdir(exist_ok=True)
    (folder / "plugin.json").write_text(json.dumps({"id": "demo-app", "name": "Demo", "version": version}))
    (folder / "program.py").write_text(PROGRAM % version)


def _setup(client, monkeypatch):
    tmp = tempfile.mkdtemp(prefix="hive-app-")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", tmp)
    _app(tmp, "1.0.0")
    client.app.state.hive.programs.reload()
    return tmp


def _app_row(client):
    return next(a for a in client.get("/api/updates").json()["apps"] if a["id"] == "demo-app")


def test_a_changed_app_is_detected_and_reloads_alone(client, monkeypatch):
    tmp = _setup(client, monkeypatch)
    assert _app_row(client)["update_available"] is False
    _app(tmp, "1.1.0")
    row = _app_row(client)
    assert row["update_available"] and row["loaded_version"] == "1.0.0" and row["disk_version"] == "1.1.0"
    req = client.post("/api/updates/requests", json={"target": "program:demo-app", "note": "adds schemas", "receipts": ["r.json"]}).json()
    assert _app_row(client)["request"]["id"] == req["id"]
    assert client.post("/api/updates/requests", json={"target": "program:nope"}).status_code == 400
    out = client.post("/api/updates/apply", json={"target": "program:demo-app"}).json()
    assert out["ok"] and out["before"]["version"] == "1.0.0" and out["after"]["version"] == "1.1.0"
    row = _app_row(client)
    assert row["update_available"] is False and row["request"] is None
    hist = client.get("/api/updates").json()["history"][0]
    assert hist["target"] == "program:demo-app" and hist["by"] == "user:operator" and hist["ok"]
    # a code change with the same version number is still an update
    (pathlib.Path(tmp) / "demo-app" / "helper.py").write_text("X = 1\n")
    assert _app_row(client)["update_available"] is True


def test_holds_block_everyone_and_only_a_person_admin_may_override(client, monkeypatch):
    tmp = _setup(client, monkeypatch)
    _app(tmp, "2.0.0")
    hold = client.post("/api/updates/holds", json={"scope": "program:demo-app", "reason": "Truth phase running"}).json()
    assert client.post("/api/updates/holds", json={"scope": "restart"}).status_code == 400     # a hold says why
    refused = client.post("/api/updates/apply", json={"target": "program:demo-app"})
    assert refused.status_code == 409 and "Truth phase running" in refused.json()["error"]["message"]
    # the hive password is not a person: it cannot override
    assert client.post("/api/updates/apply", json={"target": "program:demo-app", "override": True, "confirm": "program:demo-app"}).status_code == 409
    jon = person(client, "u_jon", role="admin")
    assert client.post("/api/updates/apply", headers=jon, json={"target": "program:demo-app", "override": True, "confirm": "wrong"}).status_code == 409
    ok = client.post("/api/updates/apply", headers=jon, json={"target": "program:demo-app", "override": True, "confirm": "program:demo-app"}).json()
    assert ok["ok"] and client.get("/api/updates").json()["history"][0]["overrode"] == [hold["id"]]
    client.delete(f"/api/updates/holds/{hold['id']}")
    assert client.get("/api/updates").json()["holds"] == []


def test_only_a_mind_with_the_exact_rule_may_apply_and_never_under_a_hold(client, monkeypatch):
    tmp = _setup(client, monkeypatch)
    _, (a, _b) = make_swarm_and_agents(client)
    _app(tmp, "3.0.0")
    h = agent_headers(a)
    assert client.get("/api/agent/updates", headers=h).json()["apps"]
    assert client.post("/api/agent/updates/apply", headers=h, json={"target": "program:demo-app"}).status_code == 403
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "hive-*", "mode": "allow"})
    client.post("/api/policy", json={"scope": "hive", "skill": "hive-update-apply", "mode": "allow"})
    assert client.post("/api/agent/updates/apply", headers=h, json={"target": "program:demo-app"}).status_code == 403   # no glob, no hive rule
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "hive-update-apply", "mode": "allow", "note": "upgrade mind"})
    hold = client.post("/api/updates/holds", json={"scope": "program:demo-app", "reason": "busy"}).json()
    assert client.post("/api/agent/updates/apply", headers=h, json={"target": "program:demo-app", "override": True}).status_code == 409
    client.delete(f"/api/updates/holds/{hold['id']}")
    out = client.post("/api/agent/updates/apply", headers=h, json={"target": "program:demo-app"}).json()
    assert out["ok"] and client.get("/api/updates").json()["history"][0]["by"] == f"agent:{a['id']}"


def test_platform_restart_only_when_supervised_and_not_held(client, monkeypatch):
    up = client.app.state.hive.updates
    up.supervised = False
    assert client.post("/api/updates/apply", json={"target": "platform"}).json()["error"]["code"] == "not_supervised"
    up.supervised = True
    killed = []
    monkeypatch.setattr(updates_mod.os, "kill", lambda pid, sig: killed.append(sig))
    hold = client.post("/api/updates/holds", json={"scope": "restart", "reason": "phase active"}).json()
    assert client.post("/api/updates/apply", json={"target": "platform"}).status_code == 409
    client.delete(f"/api/updates/holds/{hold['id']}")
    out = client.post("/api/updates/apply", json={"target": "platform"}).json()
    assert out["restarting"] and client.get("/api/updates").json()["history"][0]["target"] == "platform"
    plat = client.get("/api/updates").json()["platform"]
    assert "running_build" in plat and "commits_waiting" in plat


def test_an_installed_release_names_itself_and_a_checkout_names_none(client, monkeypatch, tmp_path):  # noqa: F811
    """An own hive runs ~/OmegaHive/app, a release folder and no git checkout, so its build read 'unknown' (Kay's round
    1, 10 November). It names the release from the RELEASE_COMMIT and RELEASE_VERSION beside hive/, read at start."""
    hive = client.app.state.hive
    assert client.get("/api/updates").json()["platform"]["running_release"] is None    # this checkout has neither file
    commit = "c09333acbaf84622124dcb103fd54943fa7f59d8"
    (tmp_path / "RELEASE_COMMIT").write_text(commit + "\n")
    monkeypatch.setattr(updates_mod, "ROOT", tmp_path)
    assert updates_mod.Updates(hive).platform()["running_release"] == {"version": None, "commit": commit}
    (tmp_path / "RELEASE_VERSION").write_text("0.21\n")
    hive.updates = updates_mod.Updates(hive)       # a hive started from the folder
    assert client.get("/api/updates").json()["platform"]["running_release"] == {"version": "0.21", "commit": commit}
    _, (a, _b) = make_swarm_and_agents(client)
    assert client.get("/api/agent/updates", headers=agent_headers(a)).json()["platform"]["running_release"]["version"] == "0.21"
    (tmp_path / "RELEASE_COMMIT").write_text("")
    assert updates_mod._release() is None       # an empty RELEASE_COMMIT names nothing


def _installed_mac(client, monkeypatch, tmp_path, version="0.22", state=None):
    """A hive started from an installed Mac release: RELEASE_COMMIT and RELEASE_VERSION beside hive/, the updater in
    install/macos, and the updater's state file, which the launcher names in HIVE_UPDATE_STATE."""
    home = tmp_path / "OmegaHive"
    app = home / "app"
    (app / "install" / "macos").mkdir(parents=True)
    (app / "install" / "macos" / "update.py").write_text("# stands in for the updater\n")
    (app / "RELEASE_COMMIT").write_text("300234fe5ab2899bf2ef2c03d8e380b9341529d2\n")
    (app / "RELEASE_VERSION").write_text(version + "\n")
    (home / "run").mkdir()
    if state is not None:
        (home / "run" / "update-state.json").write_text(state if isinstance(state, str) else json.dumps(state))
    monkeypatch.setattr(updates_mod, "ROOT", app)
    monkeypatch.setenv("HIVE_UPDATE_STATE", str(home / "run" / "update-state.json"))
    hive = client.app.state.hive
    hive.updates = updates_mod.Updates(hive)
    return home


OFFER = {"channel": "test", "seen": "0.23", "checked": "2026-11-10T11:00:00Z",
         "offer": {"version": "0.23", "label": "v0.23", "notes": "A shorter install."}}


def test_an_installed_mac_release_shows_what_its_updater_has_on_offer(client, monkeypatch, tmp_path):  # noqa: F811
    """Kay's round 1 (10 November): the Updates page of an own hive never showed the release its updater offered."""
    assert client.get("/api/updates").json()["platform"]["installer"] is None     # no launcher named an updater
    _installed_mac(client, monkeypatch, tmp_path, state=OFFER)
    inst = client.get("/api/updates").json()["platform"]["installer"]
    assert inst == {"newest": "0.23", "offer": {"version": "0.23", "label": "v0.23", "notes": "A shorter install."},
                    "checked_at": "2026-11-10T11:00:00Z", "check_failed": None, "checking": False,
                    "deferred_until": None, "failed": None, "updating": False}
    # up to date: the newest release taken is the one running, and 0.9 is below 0.10 number by number
    for seen, running in (("0.22", "0.22"), ("0.9", "0.10")):
        _installed_mac(client, monkeypatch, tmp_path / seen, version=running, state=dict(OFFER, seen=seen))
        inst = client.get("/api/updates").json()["platform"]["installer"]
        assert inst["newest"] == seen and inst["offer"] is None and inst["checked_at"] == "2026-11-10T11:00:00Z"
    # a Not now and a failed update of the release on offer are shown with it; the label the updater kept for another
    # version is not
    _installed_mac(client, monkeypatch, tmp_path / "later", state=dict(
        OFFER, seen="0.24", deferred={"version": "0.24", "until": 1794373200},
        failed={"version": "0.24", "error": "the download is not the release the statement names", "at": "2026-11-10T12:00:00Z"}))
    inst = client.get("/api/updates").json()["platform"]["installer"]
    assert inst["offer"] == {"version": "0.24", "label": "v0.24", "notes": ""}
    assert inst["deferred_until"] == "2026-11-11T05:00:00Z"
    assert inst["failed"] == {"version": "0.24", "error": "the download is not the release the statement names",
                              "at": "2026-11-10T12:00:00Z"}
    # an updater that has not checked yet, or a state file nobody can read, offers nothing
    for state in (None, "not json", "[]"):
        _installed_mac(client, monkeypatch, tmp_path / f"s{len(str(state))}", state=state)
        inst = client.get("/api/updates").json()["platform"]["installer"]
        assert inst["newest"] is None and inst["offer"] is None and inst["updating"] is False


class _Run:
    """Stands in for the updater's process: running until finish(code) ends it with that status."""
    started = []

    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs, self.code = argv, kwargs, None
        _Run.started.append(self)

    def finish(self, code):
        self.code = code

    def poll(self):
        return self.code

    def wait(self):
        assert self.code is not None, "the stand-in run is waited on only once it has finished"
        return self.code


class _Thread:
    """Stands in for the thread that waits on the updater's run: the test runs it once the run has finished."""
    waiting = []

    def __init__(self, target, args=(), daemon=None):
        self.target, self.args = target, args

    def start(self):
        _Thread.waiting.append(self)

    def run(self):
        self.target(*self.args)


def test_update_now_runs_the_updater_under_the_holds_and_one_at_a_time(client, monkeypatch, tmp_path):  # noqa: F811
    import fcntl
    import sys
    home = _installed_mac(client, monkeypatch, tmp_path, state=OFFER)
    _Run.started, _Thread.waiting = [], []
    monkeypatch.setattr(updates_mod, "Popen", _Run)
    monkeypatch.setattr(updates_mod, "Thread", _Thread)
    monkeypatch.setenv("HIVE_SECRET_FOR_THE_TEST", "never handed on")
    hold = client.post("/api/updates/holds", json={"scope": "restart", "reason": "a long task"}).json()
    assert client.post("/api/updates/apply", json={"target": "platform"}).status_code == 409   # held like a restart
    client.delete(f"/api/updates/holds/{hold['id']}")
    out = client.post("/api/updates/apply", json={"target": "platform"}).json()
    assert out == {"target": "platform", "ok": True, "updating": True, "from": "0.22", "to": "0.23", "label": "v0.23"}
    run = _Run.started[0]
    assert run.argv == [sys.executable, "-I", str(home / "app" / "install" / "macos" / "update.py"), "check", "--home",
                        str(home), "--job", "--answer", "Update"]
    assert run.kwargs["start_new_session"] is True and run.kwargs["cwd"] == str(home)
    assert "HIVE_SECRET_FOR_THE_TEST" not in run.kwargs["env"] and "HIVE_UPDATE_STATE" not in run.kwargs["env"]
    hist = client.get("/api/updates").json()["history"][0]
    assert hist["target"] == "platform" and hist["after"] == {"release": "0.23", "installer": True}
    # while it runs the page says so, and a second press is refused
    assert client.get("/api/updates").json()["platform"]["installer"]["updating"] is True
    again = client.post("/api/updates/apply", json={"target": "platform"})
    assert again.status_code == 409 and again.json()["error"]["code"] == "updating"
    run.finish(0)
    _Thread.waiting[0].run()
    assert client.get("/api/updates").json()["platform"]["installer"]["updating"] is False
    assert client.get("/api/updates").json()["history"][0]["ok"] is True   # handed on: nothing failed
    # the updater's own lock, held by its hourly job, reads as updating too
    with open(home / "run" / "update.lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        assert client.get("/api/updates").json()["platform"]["installer"]["updating"] is True
        assert client.post("/api/updates/apply", json={"target": "platform"}).json()["error"]["code"] == "updating"
    assert len(_Run.started) == 1
    # an updater that is not where the launcher said is refused rather than guessed
    (home / "app" / "install" / "macos" / "update.py").unlink()
    assert client.post("/api/updates/apply", json={"target": "platform"}).json()["error"]["code"] == "no_updater"


def test_an_update_now_run_that_fails_says_why_on_the_page(client, monkeypatch, tmp_path):  # noqa: F811
    """Dora's Mac run of 10 November: Update now's updater aborted in macOS's libcrypto before it could write why, and
    the page offered the update again with no word of it."""
    home = _installed_mac(client, monkeypatch, tmp_path, state=OFFER)
    _Run.started, _Thread.waiting = [], []
    monkeypatch.setattr(updates_mod, "Popen", _Run)
    monkeypatch.setattr(updates_mod, "Thread", _Thread)
    log = home / "logs" / "update-now.log"
    log.parent.mkdir()
    log.write_text("an earlier run's last line\n")

    def press_and_end(code, output="", failed=None):
        assert client.post("/api/updates/apply", json={"target": "platform"}).json()["updating"] is True
        with open(log, "a") as out:            # what the run printed
            out.write(output)
        if failed is not None:                 # what the run wrote into its state before ending
            (home / "run" / "update-state.json").write_text(json.dumps(dict(OFFER, failed=failed)))
        _Run.started[-1].finish(code)
        _Thread.waiting[-1].run()
        got = client.get("/api/updates").json()
        return got["platform"]["installer"], got["history"][0]

    # a crash: no failed in the state, so the run's own last line and how it ended say why
    inst, row = press_and_end(-6, "WARNING: venv/bin/python is loading libcrypto in an unsafe way\n")
    why = "the updater was stopped by SIGABRT: WARNING: venv/bin/python is loading libcrypto in an unsafe way"
    assert row["ok"] is False and row["error"] == why
    assert inst["failed"] == {"version": "0.23", "error": why, "at": row["at"]} and inst["updating"] is False
    assert inst["offer"]["version"] == "0.23"  # and it is still offered, so Update now can try again
    # a run that says why itself, in the state: that reason, the newer one
    later = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    inst, row = press_and_end(1, "Not updated: could not check the feed\n",
                              failed={"version": "0.23", "error": "could not check the feed", "at": later})
    assert row["ok"] is False and row["error"] == "could not check the feed"
    assert inst["failed"] == {"version": "0.23", "error": "could not check the feed", "at": later}
    # a run that ended without output: how it ended
    (home / "run" / "update-state.json").write_text(json.dumps(OFFER))
    inst, row = press_and_end(1)
    assert row["error"] == "the updater ended with status 1" and inst["failed"]["error"] == row["error"]
    # a run that hands the release on clears it: the updater dropped its failed, and this run did not fail
    inst, row = press_and_end(0, "")
    assert row["ok"] is True and inst["failed"] is None


def _stamp(seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


class _Checker:
    """Stands in for the updater's check (run_updater, subprocess.run): writes what the check found into the state file as
    update.py does, made when it runs (state is a function, so a time in it is the run's), then ends with its status;
    runs holds the argv and keywords of each run."""

    def __init__(self, home, state=None, code=0, stdout="", stderr=""):
        self.home, self.state, self.code, self.stdout, self.stderr, self.runs = home, state, code, stdout, stderr, []

    def __call__(self, argv, **kwargs):
        import subprocess
        self.runs.append((argv, kwargs))
        if self.state is not None:
            (self.home / "run" / "update-state.json").write_text(json.dumps(self.state()))
        return subprocess.CompletedProcess(argv, self.code, self.stdout, self.stderr)


def test_check_now_runs_the_updaters_check_and_answers_what_it_found(client, monkeypatch, tmp_path):  # noqa: F811
    """A tester in Lisbon (16 November), back on wifi, waited for the hourly check to see v0.31: Check now runs the
    updater's own check at once and answers with the release on offer, up to date, or why it could not check."""
    import sys
    home = _installed_mac(client, monkeypatch, tmp_path, state=dict(OFFER, seen="0.22"))
    monkeypatch.setenv("HIVE_SECRET_FOR_THE_TEST", "never handed on")
    found = _Checker(home, lambda: dict(OFFER, checked=_stamp()))
    monkeypatch.setattr(updates_mod, "run_updater", found)
    out = client.post("/api/updates/check").json()
    assert out["result"] == "offer" and out["error"] is None
    assert out["installer"]["offer"]["label"] == "v0.23" and out["installer"]["checking"] is False
    argv, kwargs = found.runs[0]
    assert argv == [sys.executable, "-I", str(home / "app" / "install" / "macos" / "update.py"), "check", "--home",
                    str(home), "--job", "--page"]
    assert kwargs["cwd"] == str(home) and kwargs["timeout"] == updates_mod.CHECK_WAIT
    assert "HIVE_SECRET_FOR_THE_TEST" not in kwargs["env"] and "HIVE_UPDATE_STATE" not in kwargs["env"]
    assert client.get("/api/updates").json()["history"] == []     # a check applies nothing, so it records nothing
    # up to date: the newest release taken is the one running, checked just now
    monkeypatch.setattr(updates_mod, "run_updater", _Checker(home, lambda: dict(OFFER, seen="0.22", checked=_stamp())))
    out = client.post("/api/updates/check").json()
    assert out["result"] == "current" and out["installer"]["newest"] == "0.22" and out["installer"]["offer"] is None
    # could not check: the updater's own plain reason and detail, kept in its state, which the page shows until a check
    # takes a statement; what an earlier check took still stands beside it
    detail = "could not check https://example.test/feed.json: <urlopen error [Errno 8] nodename nor servname provided>"
    monkeypatch.setattr(updates_mod, "run_updater", _Checker(home, lambda: dict(OFFER, check_failed={
        "at": _stamp(), "reason": "the release feed couldn't be reached", "detail": detail})))
    out = client.post("/api/updates/check").json()
    assert out["result"] == "failed" and out["error"] == "the release feed couldn't be reached"
    assert out["installer"]["check_failed"]["detail"] == detail and out["installer"]["offer"]["version"] == "0.23"
    assert out["installer"]["checked_at"] == OFFER["checked"]
    # a run that crashed says how it ended and its last line; one that wrote nothing new says it did not check
    monkeypatch.setattr(updates_mod, "run_updater", _Checker(home, code=-6, stderr="libcrypto loaded unsafely\n"))
    assert client.post("/api/updates/check").json()["error"] == "the updater was stopped by SIGABRT: libcrypto loaded unsafely"
    monkeypatch.setattr(updates_mod, "run_updater", _Checker(home, lambda: dict(OFFER, checked="2026-11-10T11:00:00Z")))
    assert client.post("/api/updates/check").json() == {"result": "failed", "error": "the updater ended without checking",
                                                        "installer": client.get("/api/updates").json()["platform"]["installer"]}

    def stuck(argv, **kwargs):
        import subprocess
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
    monkeypatch.setattr(updates_mod, "run_updater", stuck)
    assert client.post("/api/updates/check").json()["error"] == "the updater's check went on past 60 seconds and was stopped"


def test_check_now_waits_for_a_check_under_way_and_never_runs_two(client, monkeypatch, tmp_path):  # noqa: F811
    import fcntl
    import threading
    home = _installed_mac(client, monkeypatch, tmp_path, state=OFFER)
    up = client.app.state.hive.updates
    started, release, runs = threading.Event(), threading.Event(), []

    def slow(argv, **kwargs):
        import subprocess
        runs.append(argv)
        with open(home / "run" / "update.lock", "w") as lock:    # the updater holds its lock while it checks
            fcntl.flock(lock, fcntl.LOCK_EX)
            started.set()
            assert release.wait(10)
            (home / "run" / "update-state.json").write_text(json.dumps(dict(OFFER, checked=_stamp())))
        return subprocess.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(updates_mod, "run_updater", slow)
    answers = []
    first = threading.Thread(target=lambda: answers.append(up.check()))
    first.start()
    assert started.wait(10)
    # while it runs: the page says checking, not updating, though the updater's lock is held
    inst = client.get("/api/updates").json()["platform"]["installer"]
    assert inst["checking"] is True and inst["updating"] is False
    second = threading.Thread(target=lambda: answers.append(up.check()))     # a second press waits for that run
    second.start()
    release.set()
    first.join(10)
    second.join(10)
    assert len(runs) == 1 and len(answers) == 2
    assert [a["result"] for a in answers] == ["offer", "offer"] and answers[0]["installer"]["checking"] is False
    # the updater busy on its own (its hourly job): refused, since what it finds reaches the page anyway
    with open(home / "run" / "update.lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        refused = client.post("/api/updates/check")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "updating"
    assert len(runs) == 1
    # the updater found its lock taken in the instant after this asked: the same refusal
    monkeypatch.setattr(updates_mod, "run_updater", _Checker(home, code=updates_mod.BUSY))
    assert client.post("/api/updates/check").json()["error"]["code"] == "updating"
    # an updater that is not where the launcher said, or none at all, is refused rather than guessed
    (home / "app" / "install" / "macos" / "update.py").unlink()
    assert client.post("/api/updates/check").json()["error"]["code"] == "no_updater"
    monkeypatch.delenv("HIVE_UPDATE_STATE")
    client.app.state.hive.updates = updates_mod.Updates(client.app.state.hive)
    assert client.post("/api/updates/check").json()["error"]["code"] == "no_updater"


def test_check_now_with_the_real_updater_and_a_signed_feed(client, monkeypatch):  # noqa: F811
    """The route and install/macos/update.py together, the updater run as the hive runs it: it takes a statement signed
    for this hive's trust from a loopback feed and the page offers its release; with the feed gone it says why."""
    import functools
    import http.server
    import shutil
    import socket
    import subprocess
    import sys
    import threading
    macos = pathlib.Path(updates_mod.__file__).resolve().parents[2] / "install" / "macos"
    sys.path.insert(0, str(macos))
    try:
        import release_sig
    finally:
        sys.path.remove(str(macos))
    # a short folder: the updater asks the hive's control socket whether it runs, and a socket path has a length limit
    base = pathlib.Path(tempfile.mkdtemp(prefix="hive-uc-"))
    try:
        home = _installed_mac(client, monkeypatch, base, version="0.22")
        app_macos = home / "app" / "install" / "macos"
        for name in ("update.py", "release_sig.py", "publish-update.py"):
            shutil.copy(macos / name, app_macos / name)
        serve = base / "serve"
        serve.mkdir()
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=str(serve)))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        feed = f"http://127.0.0.1:{httpd.server_address[1]}/feed.json"
        key = base / "key.json"
        pubkey = release_sig.new_key_file(key, "test")
        subprocess.run([sys.executable, str(macos / "publish-update.py"), "trust", "--channel", "test", "--feed", feed,
                        "--pubkey", pubkey, "--out", str(app_macos / "update-trust.json")], check=True, capture_output=True)
        expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        st = {"app": "omegahive-mac", "channel": "test", "version": "0.23", "label": "v0.23", "notes": "A shorter install.",
              "url": feed.replace("feed.json", "release.zip"), "zip_sha256": "a" * 64, "zip_length": 1000,
              "tree_sha256": "b" * 64, "expires": expires}
        (serve / "feed.json").write_text(json.dumps({"statement": st, "sig": release_sig.load_key_file(key).sign(
            release_sig.message(st))}))
        (home / "data" / "run").mkdir(parents=True)
        running = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)    # the hive's control socket: it runs
        running.bind(str(home / "data" / "run" / "control.sock"))
        running.listen(4)
        try:
            out = client.post("/api/updates/check").json()
            assert out["result"] == "offer", out
            assert out["installer"]["offer"] == {"version": "0.23", "label": "v0.23", "notes": "A shorter install."}
            assert "for the Updates page" in (home / "logs" / "update.log").read_text()
            (serve / "feed.json").unlink()
            out = client.post("/api/updates/check").json()
            assert out["result"] == "failed" and out["error"] == "the release feed couldn't be reached"
            assert out["installer"]["check_failed"]["detail"].startswith(f"could not check {feed}: HTTP Error 404")
            assert out["installer"]["offer"]["version"] == "0.23"     # what the first check took still stands
        finally:
            running.close()
            httpd.shutdown()
            httpd.server_close()
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_check_now_is_for_admins_and_the_owner(client, monkeypatch, tmp_path):  # noqa: F811
    home = _installed_mac(client, monkeypatch, tmp_path, state=OFFER)
    checker = _Checker(home, lambda: dict(OFFER, checked=_stamp()))
    monkeypatch.setattr(updates_mod, "run_updater", checker)
    assert client.post("/api/updates/check", headers=person(client, "u_mo", role="member")).status_code == 403
    assert checker.runs == []
    assert client.post("/api/updates/check", headers=person(client, "u_jon", role="admin")).json()["result"] == "offer"
    assert client.post("/api/updates/check").json()["result"] == "offer"        # the hive's owner


def test_a_hold_until_is_an_exact_time_that_lapses(client):
    """Surface 2026-10-05: free text like "tomorrow" was stored and never lapsed; until is now an exact UTC time."""
    import datetime
    post = lambda until: client.post("/api/updates/holds", json={"scope": "restart", "reason": "run", "until": until})
    for bad in ("tomorrow", "2026-10-06T09:00:00", "2000-01-01T00:00:00Z", 5):
        assert post(bad).status_code == 400, bad
    soon = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=2)).astimezone(
        datetime.timezone(datetime.timedelta(hours=1))).isoformat()                  # any offset is normalized to UTC
    hold = post(soon).json()
    assert hold["until"].endswith("Z") and len(hold["until"]) == len("2026-10-05T12:00:00.000Z")
    hive = client.app.state.hive
    hive.db.execute("UPDATE update_holds SET until = ? WHERE id = ?", ("2000-01-01T00:00:00.000Z", hold["id"]))
    assert hold["id"] not in {h["id"] for h in client.get("/api/updates").json()["holds"]}   # lapsed
