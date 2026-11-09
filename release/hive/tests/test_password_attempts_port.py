"""Port of flagship operator-throttle controls; member-password/scrypt feature remains a separate pending port."""
import os
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient
from hive.core import app as app_module
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import FakeSupervisor, PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src/main.pl").exists(), reason="needs PeTTa")
OUTSIDE_LOGIN = "/omegahive/api/auth/login"

@pytest.fixture(autouse=True)
def isolated_auth_environment(monkeypatch, tmp_path, deny_network):
    for name in ("HIVE_LOCAL_OWNER", "HIVE_PUBLIC_PASSWORD", "HIVE_ADMIN_PASSWORD", "HIVE_BASE_PATH",
                 "HIVE_GOOGLE_CLIENT_ID", "HIVE_GOOGLE_CLIENT_SECRET", "HIVE_GOOGLE_REDIRECT_URI", "HIVE_SSO_USERS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(tmp_path / "invented-sso"))
    monkeypatch.setenv("HIVE_OFFLINE", "1")

def _public_password_app(monkeypatch, clock):
    """A hive with HIVE_PUBLIC_PASSWORD=1 under the /omegahive base path, its password attempts on a clock the test moves."""
    monkeypatch.setenv("HIVE_PUBLIC_PASSWORD", "1")
    data = tempfile.mkdtemp(prefix="hive-prov-attempts-")
    settings = load_settings(data_dir=pathlib.Path(data), admin_password="pw", petta_path=PETTA, offline=True,
                             base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    app.state.password_attempts.clock = lambda: clock[0]
    return app


def test_a_non_ascii_password_is_a_wrong_password_not_a_crash(monkeypatch):
    """hmac.compare_digest raises TypeError for a str with a non-ASCII character, which answered 500; bytes give 401."""
    with TestClient(_public_password_app(monkeypatch, [0.0])) as test_client:
        assert test_client.post("/api/auth/login", json={"password": "pässword"}).status_code == 401
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "密码"}).status_code == 401


def test_each_wrong_password_from_outside_makes_the_next_wait_longer(monkeypatch):
    """NIST SP 800-63B 5.2.2: no wait after one typo, then 1 s after two wrong, 3 s after three; even the right password
    waits, and once it signs in the count starts again."""
    clock = [1000.0]
    with TestClient(_public_password_app(monkeypatch, clock)) as test_client:
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        early = test_client.post(OUTSIDE_LOGIN, json={"password": "pw"})
        assert early.status_code == 429 and early.headers["Retry-After"] == "1"
        assert early.json()["error"]["code"] == "too_many_attempts" and early.json()["error"]["retry_after_seconds"] == 1
        clock[0] += 1
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).headers["Retry-After"] == "3"
        clock[0] += 3
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).status_code == 200
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).status_code == 200


def test_the_wait_stops_growing_at_an_hour(monkeypatch):
    clock = [0.0]
    with TestClient(_public_password_app(monkeypatch, clock)) as test_client:
        for _ in range(20):
            clock[0] += 3600
            assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).headers["Retry-After"] == "3600"


def test_a_hundred_wrong_from_outside_close_it_until_the_operator_signs_in_on_the_machine(monkeypatch):
    clock = [0.0]
    with TestClient(_public_password_app(monkeypatch, clock)) as test_client:
        for _ in range(100):
            clock[0] += 3600
            assert test_client.post(OUTSIDE_LOGIN, json={"password": "nope"}).status_code == 401
        clock[0] += 3600
        closed = test_client.post(OUTSIDE_LOGIN, json={"password": "pw"})
        assert closed.status_code == 429 and closed.json()["error"]["code"] == "password_login_closed"
        assert test_client.post("/api/auth/login", json={"password": "pw"}).status_code == 200
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).status_code == 200


def test_rotating_the_password_opens_a_closed_outside_login(monkeypatch):
    clock = [0.0]
    with TestClient(_public_password_app(monkeypatch, clock)) as test_client:
        local = test_client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        for _ in range(100):
            clock[0] += 3600
            test_client.post(OUTSIDE_LOGIN, json={"password": "nope"})
        rotated = test_client.post("/api/settings/password/rotate", headers={"Authorization": f"Bearer {local}"})
        assert rotated.status_code == 200
        assert test_client.post(OUTSIDE_LOGIN, json={"password": rotated.json()["password"]}).status_code == 200


def test_wrong_passwords_on_the_hives_own_machine_never_wait_or_count(monkeypatch):
    """Only outside attempts are limited, so nobody outside can lock the operator out of the machine itself."""
    app = _public_password_app(monkeypatch, [0.0])
    with TestClient(app) as test_client:
        for _ in range(5):
            assert test_client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
        assert app.state.password_attempts.failures == 0
        assert test_client.post(OUTSIDE_LOGIN, json={"password": "pw"}).status_code == 200


def test_rate_limited_requests_do_not_compare_passwords_or_create_sessions(monkeypatch):
    app = _public_password_app(monkeypatch, [0.0])
    compared = [0]
    original = app_module.hmac.compare_digest
    def compare(first, second):
        compared[0] += 1
        return original(first, second)
    with TestClient(app) as client:
        monkeypatch.setattr(app_module.hmac, "compare_digest", compare)
        for _ in range(2):
            assert client.post(OUTSIDE_LOGIN, json={"password": "invented-wrong"}).status_code == 401
        assert compared[0] == 2
        before = app.state.hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"]
        for password in ["pw", "invented-wrong", "invented-nonascii-密码"]:
            response = client.post(OUTSIDE_LOGIN, json={"password": password})
            assert response.status_code == 429
        assert compared[0] == 2
        assert app.state.hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"] == before


def test_public_password_disabled_refuses_before_the_counter_or_comparison(monkeypatch):
    # PublicGate captures this choice at creation; construct the original app in the disabled state.
    monkeypatch.delenv("HIVE_PUBLIC_PASSWORD", raising=False)
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-prov-off-")),
                             admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as client:
        def unexpected(*_): raise AssertionError("public password refusal must precede comparison")
        monkeypatch.setattr(app_module.hmac, "compare_digest", unexpected)
        for _ in range(3):
            response = client.post(OUTSIDE_LOGIN, json={"password": "pw"})
            assert response.status_code == 403 and response.json()["error"]["code"] == "password_login_local_only"
        assert app.state.password_attempts.failures == 0
