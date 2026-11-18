"""Purpose: verify the operator password login through the HTTP routes: on the hive's own machine a wrong or malformed
password is a 401 that creates nothing, and from outside the login is refused before the password is read, with
HIVE_PUBLIC_PASSWORD=1 or without it."""
import json
import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient
from hive.core import app as app_module
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import FakeSupervisor, PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src/main.pl").exists(), reason="needs PeTTa")
OUTSIDE = "/omegahive"   # a request under the base path is from outside (PublicGate)
REFUSED = {"error": {"code": "password_login_local_only", "message": "sign in with your Google account"}}

@pytest.fixture(autouse=True)
def isolated_auth_environment(monkeypatch, tmp_path, deny_network):
    for name in ("HIVE_LOCAL_OWNER", "HIVE_PUBLIC_PASSWORD", "HIVE_ADMIN_PASSWORD", "HIVE_BASE_PATH",
                 "HIVE_GOOGLE_CLIENT_ID", "HIVE_GOOGLE_CLIENT_SECRET", "HIVE_GOOGLE_REDIRECT_URI", "HIVE_SSO_USERS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(tmp_path / "invented-sso"))
    monkeypatch.setenv("HIVE_OFFLINE", "1")

def _app(monkeypatch, public=True):
    """A hive under the /omegahive base path, with HIVE_PUBLIC_PASSWORD=1 (PublicGate reads it at creation) or without."""
    monkeypatch.setenv("HIVE_PUBLIC_PASSWORD", "1") if public else monkeypatch.delenv("HIVE_PUBLIC_PASSWORD", raising=False)
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-operator-login-")), admin_password="pw",
                             petta_path=PETTA, offline=True, base_path="/omegahive")
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


def _sessions(app):
    return app.state.hive.db.one("SELECT COUNT(*) AS n FROM sessions")["n"]


def _escaped(password):
    # Escaped JSON: an HTTP client may reject a lone surrogate before it reaches the server otherwise.
    return {"content": json.dumps({"password": password}), "headers": {"Content-Type": "application/json"}}


def test_a_non_ascii_password_is_a_wrong_password_not_a_crash(monkeypatch):
    """hmac.compare_digest raises TypeError for a str with a non-ASCII character, which answered 500; bytes give 401."""
    with TestClient(_app(monkeypatch)) as test_client:
        assert test_client.post("/api/auth/login", json={"password": "pässword"}).status_code == 401
        assert test_client.post("/api/auth/login", json={"password": "密码"}).status_code == 401


@pytest.mark.parametrize("password", ["\ud800", "\udfff", "pw\ud800"],
                         ids=["high-surrogate", "low-surrogate", "embedded-surrogate"])
def test_lone_surrogate_passwords_are_wrong_passwords(monkeypatch, password):
    app = _app(monkeypatch)
    with TestClient(app) as client:
        before = _sessions(app)
        response = client.post("/api/auth/login", **_escaped(password))
        assert response.status_code == 401
        assert response.json() == {"error": {"code": "unauthorized", "message": "wrong password"}}
        assert _sessions(app) == before
        assert client.post("/api/auth/login", json={"password": "pw"}).status_code == 200


@pytest.mark.parametrize("public", [True, False], ids=["public-password-on", "public-password-off"])
def test_the_operator_login_from_outside_is_refused_before_the_password_is_read(monkeypatch, public):
    """The operator's session never counts from outside, and #82 asked to keep the operator refused there: from outside
    the right password, a wrong one and a malformed one all get the refusal a member's login gets there without
    HIVE_PUBLIC_PASSWORD=1, with no token and no session, and the password is never compared, HIVE_PUBLIC_PASSWORD=1 or not. On the hive's own machine the right
    password still signs in, and that session still doesn't count from outside."""
    app = _app(monkeypatch, public=public)
    with TestClient(app) as client:
        before = _sessions(app)
        original = app_module.hmac.compare_digest
        def unexpected(*_):
            raise AssertionError("an outside operator login must be refused before the comparison")
        monkeypatch.setattr(app_module.hmac, "compare_digest", unexpected)
        answers = [client.post(OUTSIDE + "/api/auth/login", json={"password": "pw"}),
                   client.post(OUTSIDE + "/api/auth/login", json={"password": "invented-wrong"}),
                   client.post(OUTSIDE + "/api/auth/login", **_escaped("\ud800"))]
        assert [(r.status_code, r.json()) for r in answers] == [(403, REFUSED)] * 3
        assert _sessions(app) == before
        monkeypatch.setattr(app_module.hmac, "compare_digest", original)
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/auth/me", headers=headers).json()["principal"] == "user:operator"
        assert client.get(OUTSIDE + "/api/auth/me", headers=headers).status_code == 401


def test_wrong_passwords_on_the_hives_own_machine_never_make_the_right_one_wait(monkeypatch):
    """Nothing counts operator passwords: wrong ones on the hive's own machine are each a 401, and the right one then
    signs in at once."""
    with TestClient(_app(monkeypatch)) as test_client:
        for _ in range(5):
            assert test_client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
        assert test_client.post("/api/auth/login", json={"password": "pw"}).status_code == 200
