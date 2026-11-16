"""Mac test hive restart prepare (Jon 2026-10-18): the restart script may ask awake minds to sleep ONCE, then restart only
when they are all asleep; it never forces. The route is off unless HIVE_RESTART_PREPARE=1, answers this machine only, and
takes the one-time token the hive wrote to a 0600 file in its data folder."""

import pathlib
import stat
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import PETTA, FakeSupervisor, make_swarm_and_agents

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

ROUTE = "/api/local/restart-prepare"


def _client(enabled):
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-test-"))
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA, restart_prepare=enabled)
    supervisor = FakeSupervisor()
    test_client = TestClient(create_app(settings, supervisor=supervisor, reconcile_seconds=0))
    test_client.data_dir, test_client.supervisor = data, supervisor
    return test_client


@pytest.fixture
def enabled():
    with _client(True) as c:
        token = c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        c.operator = {"Authorization": f"Bearer {token}"}
        yield c


def _token(c):
    return (c.data_dir / "restart-prepare.token").read_text().strip()


def _auth(c):
    return {"Authorization": f"Bearer {_token(c)}"}


def _awake(c, *ids):
    for agent_id in ids:
        c.app.state.hive.db.update("agents", agent_id, {"status": "awake", "desired": "awake"})


def _status(c, agent_id):
    return c.app.state.hive.db.one("SELECT status FROM agents WHERE id = ?", (agent_id,))["status"]


def _minds(c, n=3):
    _, agents = make_swarm_and_agents(_Op(c), n=n)
    _awake(c, *[a["id"] for a in agents])
    return [a["id"] for a in agents]


class _Op:
    """make_swarm_and_agents with the operator's session on each call (the restart token is not a session)."""

    def __init__(self, c):
        self.c = c

    def post(self, url, json=None):
        return self.c.post(url, json=json, headers=self.c.operator)


def test_disabled_route_is_absent_and_no_token_file_stays():
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-test-"))
    (data / "restart-prepare.token").write_text("stale")
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA)
    assert settings.restart_prepare is False
    with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)) as c:
        r = c.post(ROUTE, headers={"Authorization": "Bearer stale"})
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert not (data / "restart-prepare.token").exists()


def test_env_switch(monkeypatch):
    monkeypatch.setenv("HIVE_RESTART_PREPARE", "1")
    assert load_settings(data_dir=pathlib.Path(tempfile.mkdtemp()), admin_password="pw").restart_prepare is True
    monkeypatch.setenv("HIVE_RESTART_PREPARE", "yes")
    assert load_settings(data_dir=pathlib.Path(tempfile.mkdtemp()), admin_password="pw").restart_prepare is False


def test_enabled_writes_a_fresh_0600_token_each_start(enabled):
    path = enabled.data_dir / "restart-prepare.token"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    first = _token(enabled)
    assert len(first) >= 40
    settings = load_settings(data_dir=enabled.data_dir, admin_password="pw", petta_path=PETTA, restart_prepare=True)
    create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    assert _token(enabled) != first and stat.S_IMODE(path.stat().st_mode) == 0o600


def test_public_request_is_refused_even_with_the_token(enabled):
    ids = _minds(enabled, 1)
    r = enabled.post(ROUTE, headers=_auth(enabled) | {"cf-ray": "abc"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "local_only"
    assert _status(enabled, ids[0]) == "awake"


@pytest.mark.parametrize("header", [None, "Bearer wrong", "Bearer "])
def test_wrong_or_missing_token_is_refused(enabled, header):
    ids = _minds(enabled, 1)
    headers = {"Authorization": header} if header is not None else {"Authorization": ""}
    r = enabled.post(ROUTE, headers=headers)
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    # an operator session is not the restart token either
    assert enabled.post(ROUTE, headers=enabled.operator).status_code == 401
    assert _status(enabled, ids[0]) == "awake"


def test_correct_token_asks_each_awake_mind_to_sleep_once(enabled):
    ids = _minds(enabled, 3)
    enabled.supervisor.calls.clear()
    r = enabled.post(ROUTE, headers=_auth(enabled))
    assert r.status_code == 200
    out = r.json()
    assert sorted(out["asked"]) == sorted(ids) and sorted(out["slept"]) == sorted(ids) and out["failed"] == []
    assert all(_status(enabled, i) == "asleep" for i in ids)
    assert sorted(enabled.supervisor.calls) == sorted(("stop", i) for i in ids)   # once each, nothing else


def test_keep_list_is_left_awake(enabled):
    ids = _minds(enabled, 3)
    r = enabled.post(ROUTE, headers=_auth(enabled), json={"keep": [ids[0]]})
    assert r.status_code == 200
    assert ids[0] not in r.json()["asked"] and sorted(r.json()["slept"]) == sorted(ids[1:])
    assert _status(enabled, ids[0]) == "awake"


def test_one_failing_mind_is_reported_and_the_others_still_sleep(enabled):
    ids = _minds(enabled, 3)
    stop = enabled.supervisor.stop

    def flaky(agent_id):
        if agent_id == ids[1]:
            raise RuntimeError("synthetic stop failure")
        return stop(agent_id)

    enabled.supervisor.stop = flaky
    out = enabled.post(ROUTE, headers=_auth(enabled)).json()
    assert out["failed"] == [{"id": ids[1], "error": "internal"}]
    assert sorted(out["slept"]) == sorted([ids[0], ids[2]])
    assert _status(enabled, ids[1]) == "awake"   # no retry, no force
    assert "synthetic stop failure" not in str(out)


def test_modules_are_never_touched(enabled):
    ids = _minds(enabled, 1)
    swarm = enabled.post("/api/swarms", json={"name": "Mods"}, headers=enabled.operator).json()
    module = enabled.post("/api/agents", json={"name": "Outside", "kind": "module", "swarm_id": swarm["id"]},
                          headers=enabled.operator).json()
    _awake(enabled, module["id"])
    out = enabled.post(ROUTE, headers=_auth(enabled)).json()
    assert module["id"] not in out["asked"] and out["slept"] == ids
    assert _status(enabled, module["id"]) == "awake"


@pytest.mark.parametrize("payload", [{"keep": [], "force": True}, {"keep": "a_1"}, {"keep": [1]},
                                     {"keep": ["a"] * 101}, ["a_1"]])
def test_body_is_closed(enabled, payload):
    ids = _minds(enabled, 1)
    r = enabled.post(ROUTE, headers=_auth(enabled), json=payload)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
    assert _status(enabled, ids[0]) == "awake"
