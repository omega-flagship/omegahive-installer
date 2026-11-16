"""Purpose: minds run in the OS sandbox unless HIVE_MIND_SANDBOX is exactly 0 (#111 item 3), the hive finds at start
whether that works on this host and says so, and a host where it can't refuses minds with the reason and the opt-out
instead of running them unconfined."""

import os
import sys

import pytest

from hive.supervisor import drivers, sandbox
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def _fresh_sandbox_state():
    yield
    sandbox._REFUSED = None
    sandbox._TOOLS_REFUSED = None
    sandbox._MIND_STATUS = None


class _Stop(Exception):
    pass


def _driver(tmp_path, monkeypatch):
    """A LocalDriver whose mind command is /bin/echo and whose Popen records the argv instead of starting it."""
    from hive.core.config import load_settings
    from hive.supervisor.workspace import Workspace
    seen = {}

    def popen(argv, **kwargs):
        seen["argv"] = argv
        raise _Stop()

    monkeypatch.setattr(drivers.subprocess, "Popen", popen)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw")
    driver = drivers.LocalDriver(Workspace(settings), settings.petta_path)
    monkeypatch.setattr(driver.workspace, "command", lambda agent, petta: ["/bin/echo", "mind"])
    driver.workspace.path("a_test").mkdir(parents=True, exist_ok=True)
    return driver, seen


@pytest.mark.parametrize("value,on", [(None, True), ("1", True), ("0", False), ("", True), (" 0", True),
                                      ("false", True), ("off", True)])
def test_the_sandbox_is_on_unless_the_setting_is_exactly_0(value, on):
    """Only the exact explicit opt-out turns it off; anything else, unset included, keeps minds in the sandbox."""
    environ = {} if value is None else {"HIVE_MIND_SANDBOX": value}
    assert sandbox.mind_sandbox_requested(environ) is on


def test_a_mind_starts_in_the_sandbox_when_nothing_is_set(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    monkeypatch.setattr(drivers, "sandbox_available", lambda: True)
    driver, seen = _driver(tmp_path, monkeypatch)
    with pytest.raises(_Stop):
        driver.start({"id": "a_test", "kind": "omegaclaw"}, {})
    assert seen["argv"][-2:] == ["/bin/echo", "mind"] and seen["argv"][0] == "/usr/bin/env"   # wrapped by the launcher
    assert driver.isolation["a_test"]["os_sandbox"] is True


def test_a_host_without_the_sandbox_refuses_minds_and_names_the_opt_out(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: None)
    monkeypatch.setattr(drivers, "sandbox_available", lambda: False)
    driver, seen = _driver(tmp_path, monkeypatch)
    with pytest.raises(RuntimeError, match="HIVE_MIND_SANDBOX=0") as refused:
        driver.start({"id": "a_test", "kind": "omegaclaw"}, {})
    assert "argv" not in seen, "nothing started"
    assert "on by default" in str(refused.value)


def test_the_explicit_opt_out_starts_minds_unconfined_and_the_hive_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")
    driver, seen = _driver(tmp_path, monkeypatch)
    with pytest.raises(_Stop):
        driver.start({"id": "a_test", "kind": "omegaclaw"}, {})
    assert seen["argv"] == ["/bin/echo", "mind"] and driver.isolation["a_test"]["os_sandbox"] is False
    status = sandbox.probe_minds(tmp_path)
    assert status["state"] == "off" and "HIVE_MIND_SANDBOX=0" in status["reason"]
    assert sandbox.mind_sandbox_status() == status


def test_the_start_probe_reports_on_when_one_launch_through_wrap_works(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox, "wrap", lambda command, *a, **k: (list(command), str(tmp_path / "p")))
    status = sandbox.probe_minds(tmp_path)
    assert status == {"state": "on", "backend": "landlock", "reason": None}
    assert sandbox.refused() is None


def test_the_start_probe_refuses_minds_with_the_launchers_own_reason(tmp_path, monkeypatch):
    """Ubuntu 24.04's AppArmor userns restriction without the launcher's profile: the backend exists, the launch exits
    78 with the launcher's explanation, and minds are then refused with that explanation and the opt-out."""
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: None if sandbox.refused() else "landlock")   # as the real one does
    failing = [sys.executable, "-c", "import sys; sys.stderr.write('mind isolation failed, not starting: AppArmor "
               "refuses unprivileged user namespaces here\\n'); sys.exit(78)"]
    monkeypatch.setattr(sandbox, "wrap", lambda command, *a, **k: (failing, str(tmp_path / "p")))
    status = sandbox.probe_minds(tmp_path)
    assert status["state"] == "unavailable" and "AppArmor refuses unprivileged user namespaces" in status["reason"]
    assert sandbox.refused() == status["reason"] and sandbox.available() is False
    driver, seen = _driver(tmp_path, monkeypatch)
    with pytest.raises(RuntimeError, match="AppArmor refuses unprivileged user namespaces") as refused:
        driver.start({"id": "a_test", "kind": "omegaclaw"}, {})
    assert "HIVE_MIND_SANDBOX=0" in str(refused.value) and "argv" not in seen


def test_a_local_owner_preflight_verdict_stands_and_nothing_more_is_launched(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: "sandbox-exec")

    def no_launch(*a, **k):
        raise AssertionError("the preflight already proved the mind path")

    monkeypatch.setattr(sandbox, "wrap", no_launch)
    assert sandbox.probe_minds(tmp_path, {"minds": True, "status": "pass"})["state"] == "on"
    failed = sandbox.probe_minds(tmp_path, {"minds": False, "reason": "sandbox checks failed: mind.read_canary"})
    assert failed == {"state": "unavailable", "backend": "sandbox-exec", "reason": "sandbox checks failed: mind.read_canary"}


def test_the_start_probe_says_when_the_host_has_no_backend(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: None)
    status = sandbox.probe_minds(tmp_path)
    assert status["state"] == "unavailable" and status["backend"] is None and "no OS sandbox" in status["reason"]


@pytest.mark.skipif(not (sys.platform.startswith("linux") or sys.platform == "darwin") or not sandbox.available(),
                    reason="needs a host with the OS sandbox backend")
def test_the_start_probe_runs_a_real_launch(tmp_path, monkeypatch):
    """On a host with the backend the probe really starts a process through the launcher: on, or unavailable with the
    launcher's own words. Under AppArmor's userns restriction (scripts/ci/release-tests.sh runs this at 1) a launcher
    inside a release, where deploy/apparmor/omegahive-mind-launcher attaches, must give on, and one the profile doesn't
    attach to, as from a checkout, is refused with the launcher's AppArmor explanation."""
    import fnmatch
    import pathlib
    from hive.supervisor import landlock
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    restricted = sys.platform.startswith("linux") and landlock.apparmor_refusal() is not None
    attached = fnmatch.fnmatch(str(pathlib.Path(landlock.__file__).resolve()),
                               "/opt/omegahive/releases/*/omegahive/hive/supervisor/landlock.py")   # the profile's path
    status = sandbox.probe_minds(tmp_path)
    if restricted and attached:
        assert status["state"] == "on", status
    if status["state"] == "on":
        assert status["backend"] == sandbox.backend() and status["reason"] is None and sandbox.refused() is None
    else:
        assert status["state"] == "unavailable" and status["reason"] and sandbox.refused() == status["reason"]
        assert not restricted or "AppArmor" in status["reason"], status


def test_the_settings_summary_reports_the_mind_sandbox(client, monkeypatch, tmp_path):
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")
    status = sandbox.probe_minds(tmp_path)
    out = client.get("/api/settings").json()["mind_sandbox"]
    assert out["state"] == "off" and "HIVE_MIND_SANDBOX=0" in out["reason"]
    assert out["summary"] == sandbox.describe(status, out["default_driver"])


_DOCKER_TAIL = "; this hive's default driver is docker, whose minds this sandbox doesn't cover"


@pytest.mark.parametrize("status,local,docker", [
    ({"state": "on", "backend": "landlock", "reason": None},
     "mind sandbox: on (landlock)",
     "mind sandbox: on (landlock) for minds on the local driver" + _DOCKER_TAIL),
    ({"state": "off", "backend": "landlock", "reason": "minds run without OS isolation (HIVE_MIND_SANDBOX=0)"},
     "mind sandbox: off: minds run without OS isolation (HIVE_MIND_SANDBOX=0)",
     "mind sandbox: off for minds on the local driver: minds run without OS isolation (HIVE_MIND_SANDBOX=0)"
     + _DOCKER_TAIL),
    ({"state": "unavailable", "backend": None, "reason": "no backend here"},
     f"mind sandbox: unavailable, so minds won't start: no backend here; {sandbox.OPT_OUT}",
     f"mind sandbox: unavailable for minds on the local driver, so they won't start: no backend here; {sandbox.OPT_OUT}"
     + _DOCKER_TAIL),
])
def test_the_sentence_names_the_driver_when_the_default_one_is_not_sandboxed(status, local, docker):
    """Only LocalDriver wraps minds (drivers.py), so a hive whose default driver is docker says the sandbox covers minds
    on the local driver only, instead of calling its minds sandboxed, or refused when the sandbox can't run."""
    assert sandbox.describe(status, "local") == local
    assert sandbox.describe(status, "docker") == docker


def test_the_start_line_and_settings_name_a_default_driver_the_sandbox_does_not_cover(monkeypatch, tmp_path, capsys):
    from fastapi.testclient import TestClient
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    for name in ("HIVE_ASK_CONDUCTOR", "HIVE_CODE_CONTROLLER_ENGINE"):   # as the shared client fixture starts the app
        if name not in os.environ:
            monkeypatch.setenv(name, "0")
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")
    monkeypatch.setenv("HIVE_DRIVER", "docker")
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)) as client:
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        out = client.get("/api/settings", headers={"Authorization": f"Bearer {token}"}).json()["mind_sandbox"]
    said = ("mind sandbox: off for minds on the local driver: minds run without OS isolation (HIVE_MIND_SANDBOX=0)"
            + _DOCKER_TAIL)
    assert f"[hive] {said}" in capsys.readouterr().err
    assert out["default_driver"] == "docker" and out["summary"] == said
