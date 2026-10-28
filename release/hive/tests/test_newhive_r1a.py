"""New-hive R1a (boot/source, host side): plan r1.1 §3/§10 R1 proof list + r1.2.1 addendum §A/§B/§E.1-3.

Every test uses scratch data folders and a synthetic release source; no provider, model or network call is made, and
nothing reads a real installation, Atlas or OmegaTruth. The extractor is Code's accepted J1 dependency packet r1.3
(CODE_CODING_CORE_R1_3_J1 SHIP x2): the archive j1-extractor-r13.tar.gz (sha256 pinned below) is read, its three
package members are hash-checked and written to scratch, then loaded through the host adapter; a stub with
the same signature covers the failure cases. Launcher and host share this one interpreter (runtime_identity)."""

import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

from hive.core import localowner, newhive, redact
from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.hive import HiveError, token_hash
from hive.spaces.service import RepoMountIncomplete
from hive.supervisor import preflight, sandbox
from hive.tests.test_core_api import FakeSupervisor, PETTA
from hive.tests.test_newhive_source_confinement import (   # shared fixtures and release builders (no tests imported)
    PINNED, RT, SECRET, SHA_A, SHA_B, SOURCE, STAMP, _outside_copy, _track_fstat, extractor_dir, real, work,
    write_release)

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

BASE = "http://127.0.0.1:8700"
ORIGIN = {"Origin": BASE}
PASSED = {"version": 1, "platform": "test", "pass": True, "rows": [], "reason": None}
@pytest.fixture(autouse=True)
def _restore_globals():
    yield
    redact.REDACTOR.enabled = False
    sandbox._REFUSED = None
    sandbox._TOOLS_REFUSED = None


@pytest.fixture()
def local_env(monkeypatch):
    for name in localowner.SIGNIN_SETTINGS + localowner.PUBLIC_SETTINGS + ("HIVE_HOST", "HIVE_LOCAL_BROWSER_PORT",
                                                                           newhive.ENV_REQUIRED, newhive.ENV_INSTALLATION):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HIVE_LOCAL_OWNER", "1")
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setenv("HIVE_PORT", "8700")
    monkeypatch.setattr(preflight, "run_and_record", lambda data_dir: dict(PASSED))
    return monkeypatch


def use_release(monkeypatch, src, mpath, pkg):
    monkeypatch.setenv(newhive.ENV_RELEASE_SOURCE, str(src))
    monkeypatch.setenv(newhive.ENV_RELEASE_MANIFEST, str(mpath))
    monkeypatch.setenv(newhive.ENV_EXTRACTOR, str(pkg))


def make_app(data, **kw):
    settings = load_settings(data_dir=data, admin_password="pw", petta_path=PETTA)
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0, **kw)


@pytest.fixture()
def installed(local_env, work):
    """A fresh new installation: release A, the marker in a fresh folder, one running hive."""
    pkg = extractor_dir(work)
    src, mpath = write_release(work)
    use_release(local_env, src, mpath, pkg)
    data = work / "d"
    newhive.init_data_dir(data, mpath)
    app = make_app(data)
    with TestClient(app, base_url=BASE) as client:
        client.data, client.work, client.pkg, client.src, client.mpath = data, work, pkg, src, mpath
        client.hive = app.state.hive
        client.nh = app.state.hive.newhive
        client.local = app.state.hive.local_owner
        yield client


def person_token(client):
    code = client.local.issue_code()["code"]
    out = client.post("/api/auth/local/exchange", json={"code": code}, headers=ORIGIN)
    assert out.status_code == 200, out.text
    return out.json()["token"]


def launcher_prepare(client):
    """The launcher's own, independent preparation with the same library (deterministic: same bytes as the host's)."""
    manifest = newhive.parse_manifest(newhive.read_manifest(client.mpath))
    adapter = newhive.load_pinned_extractor(client.pkg, manifest.extractor["files"])
    return newhive.prepare_map(newhive.collect_sources(str(client.src), manifest), adapter)


def wait_mounted(client, sha, token=None, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        status = client.hive.repo_maps.space("omegahive", sha)["status"]
        if status in ("mounted", "failed", "incomplete"):
            return status
        time.sleep(0.05)
    return client.hive.repo_maps.space("omegahive", sha)["status"]


STAGES = ("begin", "exchange", "receipt", "envelope", "load", "mounted")


def drive(client, stop_after=None):
    """The J1 launcher's helper, step by step. Returns what it has when it stops (launcher death at that stage)."""
    out = {}
    begin = client.local.answer({"op": "bootstrap-begin"})
    out["begin"] = begin
    assert begin["ok"], begin
    if begin.get("completed") or stop_after == "begin":
        return out
    ex = client.post("/api/auth/local/exchange", json={"code": begin["code"]}, headers=ORIGIN)
    assert ex.status_code == 200, ex.text
    token = out["token"] = ex.json()["token"]
    assert ex.json()["kind"] == "sso-bootstrap"
    if stop_after == "exchange":
        return out
    h = {"Authorization": f"Bearer {token}", **ORIGIN}
    prepared = out["prepared"] = launcher_prepare(client)
    assert (prepared.map_digest, prepared.receipt_sha256, prepared.envelope_sha256) == \
        (begin["map_digest"], begin["receipt_sha256"], begin["envelope_sha256"])
    for part, data in (("receipt", prepared.receipt_bytes), ("envelope", prepared.envelope_bytes)):
        up = client.post("/api/assets?local_only=true&name=" + part, content=data,
                         headers=dict(h, **{"Content-Type": "application/json"}))
        assert up.status_code == 200, up.text
        back = client.get(f"/api/assets/{newhive._sha(data)}", headers={"Authorization": f"Bearer {token}"})
        assert back.status_code == 200 and back.content == data   # read back before the load: custody, not a string
        if stop_after == part:
            return out
    load = client.post("/api/admin/repo-maps?visibility=hive&pinned=false", content=prepared.envelope_bytes,
                       headers=dict(h, **{"Content-Type": "application/json"}))
    assert load.status_code == 200, load.text
    out["load"] = load.json()
    if stop_after == "load":
        return out
    out["mount"] = wait_mounted(client, prepared.sha)
    header = client.get(f"/api/repo-maps/omegahive/{prepared.sha}", headers={"Authorization": f"Bearer {token}"})
    assert header.status_code == 200, header.text
    assert header.json()["digest"] == prepared.map_digest
    out["header"] = header.json()
    if stop_after == "mounted":
        return out
    out["complete"] = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": token, "repo": "omegahive",
                                           "sha": prepared.sha, "map_digest": prepared.map_digest})
    return out


def sessions(client, kind):
    return client.hive.db.all("SELECT * FROM sessions WHERE kind = ?", (kind,))


# ---- the required-feature marker -----------------------------------------------------------------------------------

def test_marker_only_in_a_fresh_folder(local_env, work):
    _, mpath = write_release(work)
    full = work / "full"
    full.mkdir(mode=0o700)
    (full / "hive.db").write_bytes(b"")
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.init_data_dir(full, mpath)
    assert (full / "hive.db").exists() and not (full / newhive.MARKER_NAME).exists()
    empty = work / "empty"
    empty.mkdir(mode=0o700)
    record = newhive.init_data_dir(empty, mpath)
    assert record["features"] == ["repo-work-gate/1"] and record["release"]["sha"] == SHA_A
    marker = newhive.check_startup(empty)
    assert marker.installation == record["installation"]
    assert not [p for p in work.iterdir() if p.name.startswith(".empty.init-")]   # no staging folder left behind


def test_startup_refuses_any_marker_mismatch(local_env, work):
    _, mpath = write_release(work)
    data = work / "d"
    newhive.init_data_dir(data, mpath)
    assert newhive.check_startup(data) is not None
    raw = (data / newhive.MARKER_NAME).read_bytes()
    local_env.setenv(newhive.ENV_INSTALLATION, "inst_" + "0" * 32)
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.check_startup(data)   # a different installation
    local_env.delenv(newhive.ENV_INSTALLATION)
    local_env.delenv("HIVE_LOCAL_OWNER")
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.check_startup(data)   # the requirement cannot be switched off by an environment toggle
    local_env.setenv("HIVE_LOCAL_OWNER", "1")
    (data / newhive.MARKER_NAME).write_bytes(raw.replace(b"repo-work-gate/1", b"repo-work-gate/9"))
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.check_startup(data)   # edited marker
    (data / newhive.MARKER_NAME).unlink()
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.check_startup(data)   # marker file deleted, database row remains
    (data / newhive.MARKER_NAME).write_bytes(raw)
    conn = sqlite3.connect(str(data / "hive.db"))
    conn.execute("DELETE FROM required_features")
    conn.commit()
    conn.close()
    with pytest.raises(localowner.LocalOwnerRefused):
        newhive.check_startup(data)   # database row deleted, file remains


def test_an_existing_folder_is_never_taken_over(local_env, work):
    """A local-owner hive started earlier (no marker) is not silently adopted when the launcher asserts the feature,
    and a marker copied into it refuses too."""
    old = work / "old"
    old.mkdir(mode=0o700)
    app = make_app(old)
    assert getattr(app.state.hive, "newhive", None) is None
    local_env.setenv(newhive.ENV_REQUIRED, newhive.FEATURE)
    with pytest.raises(localowner.LocalOwnerRefused):
        make_app(old)
    local_env.delenv(newhive.ENV_REQUIRED)
    _, mpath = write_release(work)
    fresh = work / "fresh"
    newhive.init_data_dir(fresh, mpath)
    shutil.copyfile(fresh / newhive.MARKER_NAME, old / newhive.MARKER_NAME)
    with pytest.raises(localowner.LocalOwnerRefused):
        make_app(old)


# ---- current hives are unaffected -----------------------------------------------------------------------------------

def test_current_hive_negative(local_env, work):
    """No marker: no NewHive, no new tables, no barrier, and a sso-bootstrap row is accepted nowhere (it is never an
    ordinary session, on any hive)."""
    data = work / "plain"
    data.mkdir(mode=0o700)
    app = make_app(data)
    hive = app.state.hive
    assert getattr(hive, "newhive", None) is None
    assert hive.db.one("SELECT 1 FROM sqlite_master WHERE name = 'local_bootstrap_sessions'") is None
    with TestClient(app, base_url=BASE) as client:
        token = "t" * 43
        hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": "x", "kind": "sso-bootstrap",
                                    "principal": hive.local_owner.principal, "expires_at": time.time() + 600})
        for path in ("/api/auth/me", "/api/assets", "/api/repo-maps", "/api/services"):
            got = client.get(path, headers={"Authorization": f"Bearer {token}"})
            assert got.status_code == 401, (path, got.text)
        person = client.local = hive.local_owner
        sso = person_token(client)
        code = client.get("/api/code/targets", headers={"Authorization": f"Bearer {sso}"})
        assert code.status_code != 409 or code.json()["error"]["code"] != "coding_not_ready"
        assert localowner.LocalOwner.answer(hive.local_owner, {"op": "bootstrap-begin"}) == {"ok": False, "error": "unknown_op"}


def test_non_local_hive_negative(monkeypatch, work):
    monkeypatch.delenv("HIVE_LOCAL_OWNER", raising=False)
    data = work / "server"
    data.mkdir(mode=0o700)
    app = make_app(data)
    assert getattr(app.state.hive, "newhive", None) is None and getattr(app.state.hive, "local_owner", None) is None


# ---- the bootstrap: happy path, retirement, replay ------------------------------------------------------------------

def test_bootstrap_completes_and_retires_only_its_own_session(installed):
    client = installed
    sso = person_token(client)   # the person's own browser session, separate from the helper's
    assert not client.nh.coding_ready(True)
    out = drive(client)
    assert out["mount"] == "mounted"
    done = out["complete"]
    assert done["ok"] and done["completed"] and done["first"] is True, done
    assert client.nh.coding_ready(True)
    assert sessions(client, "sso-bootstrap") == []
    assert [r["token_hash"] for r in sessions(client, "sso")] == [token_hash(sso)]   # never a principal-wide logout
    meta = client.hive.db.one("SELECT * FROM local_bootstrap_sessions")
    assert meta["retired_reason"] == "completed" and meta["token_hash"] == token_hash(out["token"])
    row = client.hive.db.one("SELECT * FROM repo_maps WHERE repo = 'omegahive'")
    assert (row["visibility"], row["pinned"], row["digest"]) == ("hive", 0, out["prepared"].map_digest)
    # the retired bearer opens nothing any more, even the routes it was allowed
    got = client.get(f"/api/repo-maps/omegahive/{SHA_A}", headers={"Authorization": f"Bearer {out['token']}"})
    assert got.status_code == 401
    # same-attempt replay: the committed receipt, without a live token and without opening anything new
    again = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                                 "map_digest": out["prepared"].map_digest})
    assert again["ok"] and again["first"] is False and again["receipt"] == done["receipt"]
    assert client.local.answer({"op": "bootstrap-begin"})["completed"] is True   # no new grant once complete
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {sso}"}).status_code == 200


def test_rowcount_zero_without_a_committed_completion_refuses(installed):
    client = installed
    out = drive(client, stop_after="mounted")
    client.hive.db.execute("DELETE FROM sessions WHERE kind = 'sso-bootstrap'")   # the row is gone, nothing committed
    got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                               "map_digest": out["prepared"].map_digest})
    assert got == {"ok": False, "error": "token_not_live"}
    assert client.hive.db.one("SELECT * FROM local_bootstrap_completions") is None and not client.nh.coding_ready(True)


def test_completion_refuses_changed_binding_claims(installed):
    client = installed
    out = drive(client, stop_after="mounted")
    for repo, sha, digest in (("omegahive", SHA_B, out["prepared"].map_digest), ("other", SHA_A, out["prepared"].map_digest),
                              ("omegahive", SHA_A, "sha256:" + "0" * 64)):
        got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": repo, "sha": sha,
                                   "map_digest": digest})
        assert got == {"ok": False, "error": "binding_changed"}
    assert sessions(client, "sso-bootstrap")   # a refused claim retires nothing
    unknown = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": "x" * 43, "repo": "omegahive", "sha": SHA_A,
                                   "map_digest": out["prepared"].map_digest})
    assert unknown["error"] == "unknown_attempt"


def test_completion_rechecks_the_installed_source(installed):
    client = installed
    out = drive(client, stop_after="mounted")
    (client.src / "hive/core/beta.py").write_bytes(b"def go():\n    return 3\n")   # dirty after the map was made
    got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                               "map_digest": out["prepared"].map_digest})
    assert got["ok"] is False and got["stage"] == "dirty" and not client.nh.coding_ready(True)


# ---- the restricted bootstrap session ------------------------------------------------------------------------------

def test_bootstrap_bearer_is_refused_off_its_allow_list(installed):
    client = installed
    out = drive(client, stop_after="envelope")
    token, prepared = out["token"], out["prepared"]
    bearer = {"Authorization": f"Bearer {token}"}
    h = dict(bearer, **ORIGIN)
    refused = [
        client.get("/api/auth/me", headers=bearer),
        client.get("/api/services", headers=bearer),
        client.get("/api/assets", headers=bearer),                               # no arbitrary asset list
        client.get("/api/asset-stores", headers=bearer),
        client.get("/api/swarms", headers=bearer),
        client.get("/api/people", headers=bearer),
        client.get("/api/repo-maps", headers=bearer),
        client.get(f"/api/repo-maps/omegahive/{SHA_B}", headers=bearer),        # another revision
        client.get(f"/api/repo-maps/omegahive/{SHA_A}/nodes", headers=bearer),
        client.get(f"/api/assets/{'0' * 64}", headers=bearer),                  # another asset
        client.get(f"/api/assets/{prepared.receipt_sha256}?x=1", headers=bearer),
        client.post(f"/api/assets/{prepared.receipt_sha256}/transfer", json={"to": "x"}, headers=h),
        client.post(f"/api/assets/{prepared.receipt_sha256}/cleanup", headers=h),
        client.post("/api/assets?local_only=true", content=b'{"other":1}', headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/assets?local_only=true", content=prepared.receipt_bytes, headers=dict(h, **{"Content-Type": "text/plain"})),
        client.post("/api/assets", content=prepared.receipt_bytes, headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/assets?local_only=true&swarm_id=s_x", content=prepared.receipt_bytes,
                    headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/admin/repo-maps?visibility=hive&pinned=true", content=prepared.envelope_bytes,
                    headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/admin/repo-maps", content=prepared.envelope_bytes, headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/admin/repo-maps?visibility=hive&pinned=false", content=json.dumps(dict(
            json.loads(prepared.envelope_bytes), generated_at="2026-10-18T00:00:00+00:00")).encode(),
            headers=dict(h, **{"Content-Type": "application/json"})),
        client.post("/api/swarms", json={"name": "t"}, headers=h),
        client.put("/api/providers/openrouter/key", json={"key": "x"}, headers=h),
        client.post("/api/auth/logout", headers=h),
    ]
    for got in refused:
        assert got.status_code in (401, 403), (got.request.method, got.request.url, got.status_code, got.text)
    assert client.hive.db.one("SELECT 1 FROM repo_maps") is None
    # the query-token spelling never reaches it (LocalBoundary refuses it; operator never admits a query token)
    assert client.get(f"/api/repo-maps/omegahive/{SHA_A}?token={token}").status_code in (400, 401, 403)
    # the events socket refuses it as a first-frame token
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/api/events", headers=dict({"Host": "127.0.0.1:8700"}, **ORIGIN)) as ws:
            ws.send_text(json.dumps({"type": "auth", "token": token}))
            ws.receive_text()
    assert closed.value.code == 4401


def test_bootstrap_route_admission_unit(installed):
    """The admission check itself: wrong instance, retired, a forged principal, the public flag."""
    client = installed
    out = drive(client, stop_after="exchange")
    row = client.hive.db.one("SELECT * FROM sessions WHERE kind = 'sso-bootstrap'")

    class Req:
        def __init__(self, method, template, params=None, query=None, public=False):
            import starlette.datastructures as ds
            self.method, self.path_params = method, params or {}
            self.query_params = ds.QueryParams(query or "")
            self.scope = {"route": type("R", (), {"path": template})(), "hive_public": public}
    ok = Req("GET", "/api/repo-maps/{repo}/{sha}", {"repo": "omegahive", "sha": SHA_A})
    assert client.nh.admit(row, ok, out["token"])["bootstrap_attempt"]
    for req, row2, header in ((Req("GET", "/api/repo-maps/{repo}/{sha}", {"repo": "omegahive", "sha": SHA_A}, public=True), row, out["token"]),
                              (ok, row, ""),
                              (ok, dict(row, principal="user:u_other"), out["token"]),
                              (ok, dict(row, expires_at=time.time() - 1), out["token"]),
                              (Req("GET", "/api/auth/me"), row, out["token"])):
        with pytest.raises(HiveError) as exc:
            client.nh.admit(row2, req, header)
        assert exc.value.status == 403
    client.local.instance = "other-instance"
    with pytest.raises(HiveError):
        client.nh.admit(row, ok, out["token"])


def test_denied_bootstrap_codes(installed):
    client = installed
    begin = client.local.answer({"op": "bootstrap-begin"})
    first = client.post("/api/auth/local/exchange", json={"code": begin["code"]}, headers=ORIGIN)
    assert first.status_code == 200 and first.json()["kind"] == "sso-bootstrap"
    again = client.post("/api/auth/local/exchange", json={"code": begin["code"]}, headers=ORIGIN)
    assert again.status_code == 401   # one use
    second = client.local.answer({"op": "bootstrap-begin"})
    client.local.instance = "a-later-process"   # a code from another process instance
    assert client.post("/api/auth/local/exchange", json={"code": second["code"]}, headers=ORIGIN).status_code == 401
    # a bootstrap begin is control-socket only: there is no HTTP route that issues one
    assert client.post("/api/local/bootstrap-begin", headers=ORIGIN).status_code in (404, 405)


# ---- expiry, startup sweep, stale instance --------------------------------------------------------------------------

def test_ten_minute_expiry_is_enforced_before_any_sweep(installed, monkeypatch):
    client = installed
    sso = person_token(client)
    out = drive(client, stop_after="envelope")
    row = client.hive.db.one("SELECT * FROM sessions WHERE kind = 'sso-bootstrap'")
    meta = client.hive.db.one("SELECT * FROM local_bootstrap_sessions")
    assert row["expires_at"] <= meta["created_at"] + 600 + 0.001 and meta["deadline"] - meta["created_at"] == 600
    bearer = {"Authorization": f"Bearer {out['token']}"}
    for _ in range(3):   # polling never extends it
        assert client.get(f"/api/assets/{out['prepared'].receipt_sha256}", headers=bearer).status_code == 200
    assert client.hive.db.one("SELECT expires_at FROM sessions WHERE kind = 'sso-bootstrap'")["expires_at"] == row["expires_at"]
    later = time.time() + 601
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: later)
    assert client.get(f"/api/assets/{out['prepared'].receipt_sha256}", headers=bearer).status_code == 401
    done = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                                "map_digest": out["prepared"].map_digest})
    assert done == {"ok": False, "error": "attempt_expired"}
    assert not client.nh.coding_ready(True)   # expiry never opens the barrier
    client.nh.sweep()
    assert sessions(client, "sso-bootstrap") == []
    assert client.hive.db.one("SELECT retired_reason FROM local_bootstrap_sessions")["retired_reason"] == "expired"
    monkeypatch.setattr(time, "time", real_time)
    assert [r["token_hash"] for r in sessions(client, "sso")] == [token_hash(sso)]
    assert client.nh.public_status()["state"] == "not_ready"


def test_stale_instance_sweep(installed):
    client = installed
    drive(client, stop_after="exchange")
    client.local.instance = "a-later-process"
    client.nh.sweep()
    assert sessions(client, "sso-bootstrap") == []
    assert client.hive.db.one("SELECT retired_reason FROM local_bootstrap_sessions")["retired_reason"] == "stale_instance"


def test_startup_sweeps_prior_helper_sessions_but_never_browser_sessions(installed):
    client = installed
    sso = person_token(client)
    out = drive(client, stop_after="exchange")
    # an orphan helper row with no metadata, as if written by a crashed earlier process
    client.hive.db.insert("sessions", {"token_hash": token_hash("orphan"), "created_at": "x", "kind": "sso-bootstrap",
                                       "principal": client.local.principal, "expires_at": time.time() + 300})
    app2 = make_app(client.data)   # a host restart on the same data
    db = app2.state.hive.db
    assert db.all("SELECT * FROM sessions WHERE kind = 'sso-bootstrap'") == []
    assert db.one("SELECT retired_reason FROM local_bootstrap_sessions")["retired_reason"] == "startup"
    assert [r["token_hash"] for r in db.all("SELECT * FROM sessions WHERE kind = 'sso'")] == [token_hash(sso)]
    assert db.one("SELECT 1 FROM local_bootstrap_completions") is None
    assert out["token"]


# ---- native mount states ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("failure,stage", [("failed", "map_failed"), ("incomplete", "map_incomplete")])
def test_failed_or_incomplete_mount_holds_and_same_digest_remount_recovers(installed, monkeypatch, failure, stage):
    client = installed
    spaces = client.hive.spaces
    real_mount = spaces.mount_repo

    def broken(*a, **kw):
        raise RepoMountIncomplete("cleanup unknown") if failure == "incomplete" else RuntimeError("petta down")
    monkeypatch.setattr(spaces, "mount_repo", broken)
    out = drive(client, stop_after="mounted")
    assert out["mount"] == failure and out["header"]["space"]["status"] == failure
    got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                               "map_digest": out["prepared"].map_digest})
    assert got["ok"] is False and got["stage"] == stage and not client.nh.coding_ready(True)
    assert client.hive.db.one("SELECT 1 FROM repo_maps") is not None   # the map and its files are kept
    monkeypatch.setattr(spaces, "mount_repo", real_mount)
    h = {"Authorization": f"Bearer {out['token']}", **ORIGIN, "Content-Type": "application/json"}
    again = client.post("/api/admin/repo-maps?visibility=hive&pinned=false", content=out["prepared"].envelope_bytes, headers=h)
    assert again.status_code == 200 and again.json()["unchanged"] is True   # same digest: idempotent remount
    assert wait_mounted(client, SHA_A) == "mounted"
    done = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                                "map_digest": out["prepared"].map_digest})
    assert done["ok"] and done["first"] and client.nh.coding_ready(True)


@pytest.mark.parametrize("status", ["queued", "mounting", "unmounted"])
def test_queued_or_mounting_is_progress_not_readiness(installed, status):
    client = installed
    out = drive(client, stop_after="mounted")
    with client.hive.repo_maps._space_lock:
        if status == "unmounted":
            client.hive.repo_maps._spaces.pop(("omegahive", SHA_A), None)
        else:
            client.hive.repo_maps._spaces[("omegahive", SHA_A)] = {"status": status, "atoms": 0}
    got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive", "sha": SHA_A,
                               "map_digest": out["prepared"].map_digest})
    assert got == {"ok": False, "error": "not_ready", "stage": f"map_{status}"}
    assert client.nh.stage(client.hive.db.one("SELECT * FROM local_bootstrap_sessions")) == f"map_{status}"


# ---- same-SHA retry and collision ----------------------------------------------------------------------------------

def test_same_sha_collision_holds_and_keeps_the_loaded_map(installed):
    client = installed
    prepared = launcher_prepare(client)
    other = dict(json.loads(prepared.envelope_bytes), generated_at="2026-10-18T00:00:00+00:00")
    client.hive.repo_maps.load(other, "user:test", "hive", False)   # a different digest already at this SHA
    got = client.local.answer({"op": "bootstrap-begin"})
    assert got["ok"] is False and got["reason"]["code"] == "map_conflict"
    assert client.hive.db.one("SELECT digest FROM repo_maps")["digest"] == newhive.canonical_digest(other)
    assert sessions(client, "sso-bootstrap") == [] and not client.nh.coding_ready(True)


def test_same_sha_retry_is_idempotent(installed):
    client = installed
    out = drive(client, stop_after="load")
    h = {"Authorization": f"Bearer {out['token']}", **ORIGIN, "Content-Type": "application/json"}
    again = client.post("/api/admin/repo-maps?visibility=hive&pinned=false", content=out["prepared"].envelope_bytes, headers=h)
    assert again.status_code == 200 and again.json()["unchanged"] is True
    assert len(client.hive.db.all("SELECT * FROM repo_maps")) == 1


def test_retained_artifact_missing_is_a_hold_not_an_overwrite(installed):
    client = installed
    out = drive(client, stop_after="load")
    wait_mounted(client, SHA_A)
    client.hive.assets.stores["local"]._path(out["prepared"].receipt_sha256).unlink()   # the retained bytes are gone
    got = client.local.answer({"op": "bootstrap-begin"})
    assert got["ok"] is False and got["reason"]["code"] == "retained_artifact_missing"
    assert client.hive.db.one("SELECT 1 FROM repo_maps") is not None


# ---- launcher death at every stage, Resume setup without deleting data ----------------------------------------------

@pytest.mark.parametrize("stage", STAGES)
def test_launcher_death_then_resume_setup(installed, stage):
    client = installed
    person = person_token(client)
    hive = client.hive
    hive.create_swarm("Team")
    people_before = hive.db.one("SELECT COUNT(*) AS n FROM people")["n"]
    dead = drive(client, stop_after=stage)
    assets_before = {r["sha256"] for r in hive.db.all("SELECT sha256 FROM assets")}
    maps_before = [dict(r) for r in hive.db.all("SELECT repo, sha, digest FROM repo_maps")]
    assert not hive.newhive.coding_ready(True)
    assert hive.newhive.public_status()["state"] == "getting_ready"
    # Resume setup: same-uid begin retires the abandoned attempt and creates a fresh bounded one
    resumed = drive(client)
    assert resumed["complete"]["ok"] and resumed["complete"]["first"], resumed["complete"]
    old = hive.db.one("SELECT * FROM local_bootstrap_sessions WHERE attempt = ?", (dead["begin"]["attempt"],))
    assert old["retired_reason"] == "replaced"
    if dead.get("token"):
        got = client.get(f"/api/repo-maps/omegahive/{SHA_A}", headers={"Authorization": f"Bearer {dead['token']}"})
        assert got.status_code == 401
    assert assets_before <= {r["sha256"] for r in hive.db.all("SELECT sha256 FROM assets")}   # nothing deleted
    assert all(m in [dict(r) for r in hive.db.all("SELECT repo, sha, digest FROM repo_maps")] for m in maps_before)
    assert hive.db.one("SELECT COUNT(*) AS n FROM people")["n"] == people_before
    assert hive.db.one("SELECT 1 FROM swarms WHERE name = 'Team'") is not None
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {person}"}).status_code == 200
    assert hive.newhive.coding_ready(True)


@pytest.mark.parametrize("stage", ("begin", "exchange", "envelope", "load", "mounted"))
def test_host_restart_after_launcher_death_reenters_recovery(installed, stage):
    client = installed
    drive(client, stop_after=stage)
    app2 = make_app(client.data)
    with TestClient(app2, base_url=BASE) as c2:
        c2.data, c2.work, c2.pkg, c2.src, c2.mpath = client.data, client.work, client.pkg, client.src, client.mpath
        c2.hive, c2.nh, c2.local = app2.state.hive, app2.state.hive.newhive, app2.state.hive.local_owner
        assert not c2.nh.coding_ready(True)
        out = drive(c2)
        assert out["complete"]["ok"], out["complete"]
        assert c2.nh.coding_ready(True)


def test_crash_after_commit_replays_readiness_without_reviving_the_token(installed):
    client = installed
    out = drive(client)
    assert out["complete"]["first"]
    app2 = make_app(client.data)
    with TestClient(app2, base_url=BASE):
        nh = app2.state.hive.newhive
        assert verified(nh) and nh.hold is None   # the census is re-read before any remount or readiness
        assert app2.state.hive.db.all("SELECT * FROM sessions WHERE kind = 'sso-bootstrap'") == []
        assert wait_mounted(type("C", (), {"hive": app2.state.hive})(), SHA_A) == "mounted"   # remounted from the database
        assert nh.coding_ready(True)
        assert app2.state.hive.local_owner.answer({"op": "bootstrap-begin"})["completed"] is True
        replay = app2.state.hive.local_owner.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive",
                                                     "sha": SHA_A, "map_digest": out["prepared"].map_digest})
        assert replay["ok"] and replay["first"] is False


def test_retire_op_is_exact(installed):
    client = installed
    sso = person_token(client)
    out = drive(client, stop_after="exchange")
    assert client.local.answer({"op": "bootstrap-retire", "token": out["token"]}) == {"ok": True}
    assert sessions(client, "sso-bootstrap") == [] and [r["token_hash"] for r in sessions(client, "sso")] == [token_hash(sso)]
    assert client.hive.db.one("SELECT retired_reason FROM local_bootstrap_sessions")["retired_reason"] == "launcher"


def test_readiness_is_bound_to_the_exact_installed_manifest(installed):
    """Kimi r1.2.1 qualification (version-bound): a readiness proven for manifest N never admits a changed manifest."""
    client = installed
    assert drive(client)["complete"]["ok"] and client.nh.coding_ready(True)
    raw = client.mpath.read_bytes()
    client.mpath.write_bytes(raw + b" ")
    assert not client.nh.coding_ready(True)
    sso = person_token(client)
    code = client.get("/api/code/targets", headers={"Authorization": f"Bearer {sso}"})
    assert code.status_code == 409 and code.json()["error"]["code"] == "coding_not_ready"
    client.mpath.write_bytes(raw)
    assert client.nh.coding_ready(True)


# ---- update: a new installed SHA needs its own map; the old one is kept --------------------------------------------

def test_update_to_a_new_release_holds_coding_until_its_own_map(installed, local_env):
    client = installed
    assert drive(client)["complete"]["ok"]
    files = dict(SOURCE, **{"hive/core/beta.py": b"def go():\n    return 22\n"})
    src_b, mpath_b = write_release(client.work, sha=SHA_B, files=files, name="release-b")
    use_release(local_env, src_b, mpath_b, client.pkg)
    app2 = make_app(client.data)
    with TestClient(app2, base_url=BASE) as c2:
        c2.data, c2.work, c2.pkg, c2.src, c2.mpath = client.data, client.work, client.pkg, src_b, mpath_b
        c2.hive, c2.nh, c2.local = app2.state.hive, app2.state.hive.newhive, app2.state.hive.local_owner
        assert c2.nh.binding.sha == SHA_B and not c2.nh.coding_ready(True)   # A's completion does not count for B
        out = drive(c2)
        assert out["complete"]["ok"] and c2.nh.coding_ready(True)
        shas = {r["sha"] for r in c2.hive.db.all("SELECT sha FROM repo_maps")}
        assert shas == {SHA_A, SHA_B}   # the previous installed map is retained
    # a compatible rollback to A replays A's committed completion; no new attempt is needed
    use_release(local_env, client.src, client.mpath, client.pkg)
    app3 = make_app(client.data)
    with TestClient(app3, base_url=BASE):
        nh = app3.state.hive.newhive
        assert verified(nh) and nh.hold is None
        wait_mounted(type("C", (), {"hive": app3.state.hive})(), SHA_A)
        assert nh.binding.sha == SHA_A and nh.completion() is not None
        assert app3.state.hive.local_owner.answer({"op": "bootstrap-begin"})["completed"] is True


def test_missing_release_manifest_is_a_recovery_hold_not_a_start_refusal(installed, local_env):
    client = installed
    local_env.setenv(newhive.ENV_RELEASE_MANIFEST, str(client.work / "nope.json"))
    app2 = make_app(client.data)
    nh = app2.state.hive.newhive
    assert nh.hold["code"] == "manifest_missing" and not nh.coding_ready(True)
    got = app2.state.hive.local_owner.answer({"op": "bootstrap-begin"})
    assert got["ok"] is False and got["error"] == "setup_held" and got["reason"]["code"] == "manifest_missing"


# ---- no secrets, no model or provider calls -------------------------------------------------------------------------

def test_bootstrap_makes_no_network_or_model_call_and_carries_no_secret(installed, monkeypatch):
    client = installed
    import httpx
    import socket as socket_mod
    calls = []

    def blocked(*a, **kw):
        calls.append(a)
        raise AssertionError("no network during bootstrap")
    monkeypatch.setattr(httpx.Client, "send", blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", blocked)
    monkeypatch.setattr(socket_mod, "create_connection", blocked)
    (client.src / ".env").write_text(f"OPENROUTER_API_KEY={SECRET}\n")
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    out = drive(client)
    assert out["complete"]["ok"] and calls == []
    assert client.hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0
    assert client.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == 0   # no spend, no hold, no payer
    for blob in (out["prepared"].receipt_bytes, out["prepared"].envelope_bytes):
        assert SECRET.encode() not in blob and b".env" not in blob and b"admin-password" not in blob
    assert out["token"].encode() not in (client.data / "hive.db").read_bytes()   # hash only on disk


# ---- the operation-scoped coding barrier (r1.2.1 §A, §E.1-3) -------------------------------------------------------

def test_no_map_dependent_wake_before_the_mount_then_release(local_env, work):
    pkg = extractor_dir(work)
    src, mpath = write_release(work)
    use_release(local_env, src, mpath, pkg)
    data = work / "d"
    newhive.init_data_dir(data, mpath)
    app = make_app(data)
    hive = app.state.hive
    swarm = hive.create_swarm("Team")
    mind = hive.create_agent("Worker", swarm_id=swarm["id"])
    hive.db.execute("UPDATE agents SET desired = 'awake', status = 'awake' WHERE id = ?", (mind["id"],))
    with TestClient(app, base_url=BASE) as client:
        client.data, client.work, client.pkg, client.src, client.mpath = data, work, pkg, src, mpath
        client.hive, client.nh, client.local = hive, hive.newhive, hive.local_owner
        sup = hive.supervisor
        assert ("start", mind["id"]) not in sup.calls   # restore held it
        row = hive.db.one("SELECT * FROM agents WHERE id = ?", (mind["id"],))
        assert row["desired"] == "awake" and row["status"] == "stopped" and client.nh.held() == [mind["id"]]
        with pytest.raises(HiveError) as exc:
            hive.lifecycle(mind["id"], "start")
        assert exc.value.code == "coding_not_ready"
        sso = person_token(client)
        h = {"Authorization": f"Bearer {sso}", **ORIGIN}
        woke = client.post(f"/api/agents/{mind['id']}/start", headers=h)
        assert woke.status_code == 409 and woke.json()["error"]["code"] == "coding_not_ready", woke.text
        code = client.get("/api/code/targets", headers=h)
        assert code.status_code == 409 and code.json()["error"]["code"] == "coding_not_ready"
        assert client.get("/api/agent/code/capability", headers=h).status_code == 409
        import asyncio
        goal = hive.goals._create_record(swarm["id"], "a task", emit=False)
        with pytest.raises(HiveError) as exc:
            hive.goals.claim(hive.agent(mind["id"]), goal["id"])
        assert exc.value.code == "coding_not_ready"
        # ordinary use stays available: status, the person's own session, reads
        status = client.get("/api/local/status", headers=h).json()["coding"]
        assert status["state"] == "not_ready" and "map" not in json.dumps(status).lower()
        assert client.get("/api/auth/me", headers=h).status_code == 200
        assert client.get("/api/swarms", headers=h).status_code == 200
        assert sup.calls.count(("start", mind["id"])) == 0
        out = drive(client)
        assert out["complete"]["ok"]
        started = asyncio.run(client.nh.release())
        assert started == [mind["id"]] and ("start", mind["id"]) in sup.calls
        assert client.get("/api/local/status", headers=h).json()["coding"]["state"] == "ready"
        after = client.get("/api/code/targets", headers=h)
        assert after.status_code != 409 or after.json()["error"]["code"] != "coding_not_ready"


def test_the_ask_is_not_behind_the_coding_barrier(installed):
    """r1.2.1 §A/§E.1: the person's own Ask is available pre-mount; the barrier adds no paid allowance and no hold.
    The conductor turn never wakes a mind (ask.py _decide), and the barrier never sees /api/ask. Spend checks are the
    existing ones (no provider is configured here, so no call can be made)."""
    client = installed
    sso = person_token(client)
    h = {"Authorization": f"Bearer {sso}", **ORIGIN}
    assert not client.nh.coding_ready(True)
    got = client.post("/api/ask", json={"operation_id": "op-1", "text": "hello"}, headers=h)
    assert got.json().get("error", {}).get("code") != "coding_not_ready", got.text
    listed = client.get("/api/ask", headers=h)
    assert listed.status_code != 409 or listed.json()["error"]["code"] != "coding_not_ready"
    assert client.hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0
    assert all(call[0] != "start" for call in client.hive.supervisor.calls)


# ---- R1a.1: restart re-verifies the actual installed census (stand-in P1-1, Code conformance 1) --------------------

def verified(nh, timeout=60):
    wait = getattr(nh, "wait_verified", None)   # absent before R1a.1: nothing to wait for
    return wait(timeout) if wait else True


def _restart(client, **kw):
    app = make_app(client.data, **kw)
    c = TestClient(app, base_url=BASE)
    c.__enter__()
    c.data, c.work, c.pkg, c.src, c.mpath = client.data, client.work, client.pkg, client.src, client.mpath
    c.hive, c.nh, c.local = app.state.hive, app.state.hive.newhive, app.state.hive.local_owner
    return c


@pytest.mark.parametrize("damage,code", [("dirty", "dirty"), ("removed", "missing"), ("shadow", "shadow"),
                                         ("link", "symlink")])
def test_restart_reverifies_the_installed_census_before_readiness(installed, damage, code):
    client = installed
    hive = client.hive
    swarm = hive.create_swarm("Team")
    mind = hive.create_agent("Worker", swarm_id=swarm["id"])
    assert drive(client)["complete"]["first"]
    hive.db.execute("UPDATE agents SET desired = 'awake', status = 'awake' WHERE id = ?", (mind["id"],))
    before = dict(hive.db.one("SELECT * FROM local_bootstrap_completions"))
    beta = client.src / "hive/core/beta.py"
    if damage == "dirty":
        beta.write_bytes(b"def go():\n    return 9\n")   # same manifest, changed byte
    elif damage == "removed":
        beta.unlink()
    elif damage == "shadow":
        (client.src / "hive/core/gamma.py").write_text("x = 1\n")
    elif damage == "link":
        (client.src / "hive/core/extra").symlink_to(client.work)
    c2 = _restart(client)
    try:
        assert verified(c2.nh)
        assert c2.nh.hold["code"] == code and c2.nh.hold["stage"] == "restart"
        assert not c2.nh.coding_ready(True)
        assert ("start", mind["id"]) not in c2.hive.supervisor.calls and c2.nh.held() == [mind["id"]]
        assert dict(c2.hive.db.one("SELECT * FROM local_bootstrap_completions")) == before   # kept, not rewritten
        assert c2.hive.db.one("SELECT 1 FROM repo_maps WHERE sha = ?", (SHA_A,)) is not None   # map kept
        got = c2.local.answer({"op": "bootstrap-begin"})
        assert got["ok"] is False and got["error"] == "setup_held" and got["reason"]["code"] == code
        sso = person_token(c2)
        code_route = c2.get("/api/code/targets", headers={"Authorization": f"Bearer {sso}"})
        assert code_route.status_code == 409 and code_route.json()["error"]["code"] == "coding_not_ready"
    finally:
        c2.__exit__(None, None, None)


def test_clean_restart_replays_and_remounts(installed):
    client = installed
    assert drive(client)["complete"]["first"]
    c2 = _restart(client)
    try:
        assert verified(c2.nh) and c2.nh.hold is None
        assert wait_mounted(c2, SHA_A) == "mounted" and c2.nh.coding_ready(True)
    finally:
        c2.__exit__(None, None, None)


def test_runtime_change_holds_on_restart_and_complete_refuses_a_mismatch(installed, monkeypatch):
    client = installed
    out = drive(client, stop_after="mounted")
    wrong = client.local.answer({"op": "bootstrap-complete", "runtime": "cpython-3.9.6", "token": out["token"],
                                 "repo": "omegahive", "sha": SHA_A, "map_digest": out["prepared"].map_digest})
    assert wrong["error"] == "runtime_mismatch" and sessions(client, "sso-bootstrap")
    assert client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive",
                                "sha": SHA_A, "map_digest": out["prepared"].map_digest})["first"]
    monkeypatch.setattr(newhive, "runtime_identity", lambda: "cpython-3.99.0")
    c2 = _restart(client)
    try:
        assert verified(c2.nh) and c2.nh.hold["code"] == "runtime_changed" and not c2.nh.coding_ready(True)
    finally:
        c2.__exit__(None, None, None)


# ---- R1a.1: the installed map is protected by the installed-release binding (stand-in P1-2, Code conformance 2) ------

def _other_revision(prepared, n):
    env = json.loads(prepared.envelope_bytes)
    env["sha"] = f"{n:x}" * 40 if n < 16 else ("c" + f"{n:039x}")
    return env


def test_installed_map_survives_more_than_five_same_repo_admissions(installed):
    client = installed
    out = drive(client)
    assert out["complete"]["first"]
    row = dict(client.hive.db.one("SELECT repo, sha, digest, pinned, visibility FROM repo_maps WHERE sha = ?", (SHA_A,)))
    assert (row["pinned"], row["visibility"]) == (0, "hive")   # the bearer's exact load stays pinned=false
    others = [_other_revision(out["prepared"], n) for n in (1, 2, 3, 4, 5, 6, 7)]
    for env in others:
        client.hive.repo_maps.load(env, "user:test", "hive", False)
    shas = {r["sha"] for r in client.hive.db.all("SELECT sha FROM repo_maps")}
    assert SHA_A in shas                                    # protected by the installed-release binding
    assert others[0]["sha"] not in shas                    # ordinary retention still prunes the unprotected oldest
    assert len(shas) == 6                                   # newest five + the installed revision
    assert client.nh.coding_ready(True)


def test_resume_restores_a_lost_map_without_rewriting_the_historical_completion(installed):
    client = installed
    out = drive(client)
    before = dict(client.hive.db.one("SELECT * FROM local_bootstrap_completions"))
    for table in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms"):   # e.g. an earlier prune
        client.hive.db.execute(f"DELETE FROM {table} WHERE sha = ?", (SHA_A,))
    client.hive.repo_maps._unmount("omegahive", SHA_A)
    assert not client.nh.coding_ready(True)
    again = drive(client)
    assert again["begin"]["recovery"] is True and again["begin"]["completed"] is False
    done = again["complete"]
    assert done["ok"] and done["recovered"] and done["first"] is False, done
    assert dict(client.hive.db.one("SELECT * FROM local_bootstrap_completions")) == before
    assert client.nh.coding_ready(True)
    replay = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": again["token"], "repo": "omegahive",
                                  "sha": SHA_A, "map_digest": out["prepared"].map_digest})
    assert replay["ok"] and replay["recovered"] and replay["first"] is False   # idempotent, no live token needed
    assert client.local.answer({"op": "bootstrap-retire", "token": again["token"]}) == {"ok": True}   # retire stays exact
    assert client.nh.coding_ready(True) and sessions(client, "sso-bootstrap") == []
    # the old, already retired first token is never demanded or revived
    first = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive",
                                 "sha": SHA_A, "map_digest": out["prepared"].map_digest})
    assert first["ok"] and first["first"] is False


def test_failed_remount_after_a_committed_restart_recovers_through_resume(installed, monkeypatch):
    client = installed
    assert drive(client)["complete"]["first"]
    from hive.spaces.service import SpaceService
    real_mount = SpaceService.mount_repo

    def broken(self, *a, **kw):
        raise RuntimeError("petta down")
    monkeypatch.setattr(SpaceService, "mount_repo", broken)
    c2 = _restart(client)
    try:
        assert verified(c2.nh) and c2.nh.hold is None
        assert wait_mounted(c2, SHA_A) == "failed" and not c2.nh.coding_ready(True)
        monkeypatch.setattr(SpaceService, "mount_repo", real_mount)
        out = drive(c2)
        assert out["begin"]["recovery"] and out["complete"]["recovered"], out["complete"]
        assert c2.nh.coding_ready(True)
    finally:
        c2.__exit__(None, None, None)




# ==== R1b-1 ==========================================================================================================

# ---- the J1 launcher helper contract, through the real control socket ------------------------------------------------

class ClientTransport:
    """The helper's HTTP transport over the in-process TestClient (the real one is loopback HTTP to 127.0.0.1)."""

    def __init__(self, client, fail_on=None):
        self.client, self.fail_on, self.bearers = client, fail_on, set()

    def request(self, method, path, headers=None, body=None, timeout=60.0):
        auth = (headers or {}).get("Authorization", "")
        if auth:
            self.bearers.add(auth[7:])
        if self.fail_on and self.fail_on in path:
            return 500, b'{"error": {"code": "boom"}}'
        got = self.client.request(method, path, headers=headers, content=body)
        return got.status_code, got.content


def helper_run(client, **kw):
    from hive.core import newhive_helper
    sock = client.data / "run" / "control.sock"
    kw.setdefault("prepare", lambda: newhive_helper.launcher_prepare(str(client.mpath), str(client.src), str(client.pkg)))
    kw.setdefault("poll_seconds", 0.05)
    transport = kw.pop("transport", None) or ClientTransport(client)
    return newhive_helper.run_setup(sock, transport=transport, **kw), transport


def test_helper_runs_setup_end_to_end_through_the_control_socket(installed, caplog):
    client = installed
    out, transport = helper_run(client)
    assert out["ok"], out
    assert out["url"].startswith("http://127.0.0.1:8700/local-signin#") and out["receipt"]["sha"] == SHA_A
    assert client.nh.coding_ready(True) and sessions(client, "sso-bootstrap") == []
    assert len(transport.bearers) == 1
    token = next(iter(transport.bearers))
    for path in client.data.rglob("*"):   # the bearer is in memory only: no file, no log line
        if path.is_file() and not path.is_socket():
            assert token.encode() not in path.read_bytes(), path
    assert token not in caplog.text
    again, _ = helper_run(client)   # a second run on a ready installation: no new attempt, just the browser link
    assert again["ok"] and again["url"] and client.hive.db.one("SELECT COUNT(*) AS n FROM local_bootstrap_sessions")["n"] == 1


@pytest.mark.parametrize("fail_on,stage", [("/api/admin/repo-maps", "map"), ("/api/assets", "assets")])
def test_helper_retires_its_own_token_when_it_stops(installed, fail_on, stage):
    client = installed
    sso = person_token(client)
    out, transport = helper_run(client, transport=ClientTransport(client, fail_on=fail_on))
    assert out == {"ok": False, "stage": stage, "reason": out["reason"], "text": "Coding tools aren't ready yet",
                   "action": "Try setup again"}
    assert sessions(client, "sso-bootstrap") == []
    assert client.hive.db.one("SELECT retired_reason FROM local_bootstrap_sessions")["retired_reason"] == "launcher"
    assert [r["token_hash"] for r in sessions(client, "sso")] == [token_hash(sso)]
    assert helper_run(client)[0]["ok"]   # running it again is Resume setup


def test_helper_stops_before_any_bearer_on_a_runtime_mismatch(installed, monkeypatch):
    client = installed
    from hive.core import newhive_helper
    monkeypatch.setattr(newhive_helper.newhive, "runtime_identity", lambda: "cpython-0.0.0")
    out, transport = helper_run(client)
    assert out["ok"] is False and out["stage"] == "runtime" and transport.bearers == set()
    assert sessions(client, "sso-bootstrap") == []


def test_helper_stops_at_the_attempt_deadline_and_never_extends_it(installed, monkeypatch):
    client = installed
    from hive.spaces.service import SpaceService
    import threading
    gate = threading.Event()
    real_mount = SpaceService.mount_repo

    def slow(self, *a, **kw):
        gate.wait(30)
        return real_mount(self, *a, **kw)
    monkeypatch.setattr(SpaceService, "mount_repo", slow)
    ticks = iter([0, 0, 0] + [10 ** 12] * 100)
    out, _ = helper_run(client, clock=lambda: next(ticks) or time.time())
    gate.set()
    assert out["ok"] is False and out["stage"] == "expired"
    assert sessions(client, "sso-bootstrap") == [] and not client.nh.coding_ready(True)


def test_helper_uses_a_staged_candidate_only_when_it_is_the_hosts_expected_bytes(installed):
    client = installed
    good = launcher_prepare(client)
    staged = type("Staged", (), {"prepared": good})()
    out, _ = helper_run(client, staged=staged, prepare=None)
    assert out["ok"], out
    client2_bad = dataclasses_replace(good, map_digest="sha256:" + "0" * 64)
    # a wrong staged cache is never sent: with no fallback preparation the helper stops before signing in
    for table in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms"):
        client.hive.db.execute(f"DELETE FROM {table} WHERE sha = ?", (SHA_A,))
    client.hive.repo_maps._unmount("omegahive", SHA_A)
    bad, transport = helper_run(client, staged=type("Staged", (), {"prepared": client2_bad})(), prepare=None)
    assert bad["ok"] is False and bad["stage"] == "prepare" and transport.bearers == set()


def dataclasses_replace(obj, **kw):
    import dataclasses
    return dataclasses.replace(obj, **kw)


# ---- Kimi R1a P2-1: readiness asks the native space, not only the cached projection ---------------------------------

def test_readiness_uses_a_fresh_native_check(installed, monkeypatch):
    client = installed
    assert drive(client)["complete"]["first"] and client.nh.coding_ready(True)
    client.hive.spaces.unmount_repo("omegahive", SHA_A)   # the native space loses its atoms; the projection still says mounted
    assert client.hive.repo_maps.space("omegahive", SHA_A)["status"] == "mounted"
    monkeypatch.setattr(newhive, "NATIVE_TTL", 0.0)
    assert not client.nh.coding_ready(True)
    assert client.hive.repo_maps.space("omegahive", SHA_A)["status"] == "failed"   # so Resume can remount
    out = drive(client)
    assert out["complete"]["recovered"] and client.nh.coding_ready(True)


# ---- Kimi R1a P2-4: a message to an asleep mind is refused before anything lands -------------------------------------

def test_message_to_an_asleep_mind_is_not_stored_or_mirrored_before_readiness(installed):
    client = installed
    hive = client.hive
    swarm = hive.create_swarm("Team")
    mind = hive.create_agent("Worker", swarm_id=swarm["id"])
    hive.db.execute("UPDATE agents SET status = 'asleep' WHERE id = ?", (mind["id"],))
    sso = person_token(client)
    mirrored, published = [], []
    real_mirror, real_publish = hive.rooms.mirror_in, hive.events.publish
    hive.rooms.mirror_in = lambda *a, **kw: (mirrored.append(a), real_mirror(*a, **kw))[1]
    hive.events.publish = lambda kind, **kw: (published.append(kind), real_publish(kind, **kw))[1]
    got = client.post(f"/api/agents/{mind['id']}/messages", json={"text": "hello"},
                      headers={"Authorization": f"Bearer {sso}", **ORIGIN})
    assert got.status_code == 409 and got.json()["error"]["code"] == "coding_not_ready", got.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?", (mind["id"],))["n"] == 0
    assert mirrored == [] and "message" not in published
    assert ("start", mind["id"]) not in hive.supervisor.calls


# ---- Kimi R1a.2: unconditional manifest re-hash, fresh re-verification, verify-in-progress gate ---------------------

def test_manifest_rewritten_in_place_with_the_same_size_and_mtime_drops_readiness(installed):
    client = installed
    assert drive(client)["complete"]["first"] and client.nh.coding_ready(True)
    st = os.stat(client.mpath)
    raw = client.mpath.read_bytes()
    forged = raw.replace(b"2026-10-17T00:00:00Z", b"2026-10-17T00:00:01Z")
    assert len(forged) == len(raw) and forged != raw
    with open(client.mpath, "r+b") as f:   # same inode, same size
        f.write(forged)
    os.utime(client.mpath, ns=(st.st_atime_ns, st.st_mtime_ns))   # same mtime
    assert not client.nh.coding_ready(True)


def test_restart_verification_never_uses_the_warm_cache(installed):
    client = installed
    assert drive(client)["complete"]["first"]
    assert client.nh._prepared   # warm from this process's begin/complete
    (client.src / "hive/core/beta.py").write_bytes(b"def go():\n    return 8\n")
    client.nh._verifying.set()
    client.nh._restart_verify(dict(client.nh.completion()))
    assert client.nh.hold and client.nh.hold["code"] == "dirty"


def test_complete_waits_while_the_restart_check_runs(installed):
    client = installed
    out = drive(client, stop_after="mounted")
    client.nh._verifying.set()
    got = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": out["token"], "repo": "omegahive",
                               "sha": SHA_A, "map_digest": out["prepared"].map_digest})
    client.nh._verifying.clear()
    assert got == {"ok": False, "error": "setup_busy", "stage": "verifying"}
    assert sessions(client, "sso-bootstrap")   # nothing retired


# ==== R1b-2 ==========================================================================================================

# ---- J1f update hooks: the updater lock, candidate staging, the compatible-rollback check ---------------------------

def _state(work):
    state = work / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    return state


def _release_b(work):
    files = dict(SOURCE, **{"hive/core/beta.py": b"def go():\n    return 22\n"})
    return write_release(work, sha=SHA_B, files=files, name="release-b")


def test_updater_lock_is_exclusive_and_staging_requires_it(work):
    from hive.core import newhive_update as up
    pkg = extractor_dir(work)
    src_b, mpath_b = _release_b(work)
    state = _state(work)
    with pytest.raises(up.StageRefused) as exc:
        up.stage_candidate(object(), str(mpath_b), str(src_b), str(pkg))
    assert exc.value.code == "lock_required"
    with up.updater_lock(state) as lock:
        with pytest.raises(up.UpdaterBusy):
            with up.updater_lock(state):
                pass
        staged = up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
    assert not lock.held
    with pytest.raises(up.StageRefused):   # the lock is released with its block
        up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
    assert staged.record["label"] == "candidate" and staged.prepared.sha == SHA_B
    assert sorted(p.name for p in staged.folder.iterdir()) == ["envelope.json", "receipt.json", "stage.json"]
    again = up.load_staged(state, staged.manifest_sha256)
    assert again.prepared == staged.prepared


def test_staging_a_bad_candidate_refuses_and_leaves_nothing(work):
    from hive.core import newhive_update as up
    pkg = extractor_dir(work)
    src_b, mpath_b = _release_b(work)
    (src_b / "hive/core/beta.py").write_bytes(b"tampered\n")
    state = _state(work)
    with up.updater_lock(state) as lock:
        with pytest.raises(up.StageRefused) as exc:
            up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
    assert exc.value.code == "dirty"
    assert not (state / "staged").exists() or not [p for p in (state / "staged").iterdir() if not p.name.startswith(".")]


def test_a_stage_is_idempotent_never_overwritten_and_re_checked_on_load(work, monkeypatch):
    from hive.core import newhive_update as up
    pkg = extractor_dir(work)
    src_b, mpath_b = _release_b(work)
    state = _state(work)
    with up.updater_lock(state) as lock:
        one = up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
        two = up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
    assert one.prepared == two.prepared
    envelope = one.folder / "envelope.json"
    raw = envelope.read_bytes()
    envelope.write_bytes(raw.replace(b'"partial"', b'"ready"  '))
    assert up.load_staged(state, one.manifest_sha256) is None   # a changed byte is never served
    with up.updater_lock(state) as lock:
        with pytest.raises(up.StageRefused) as exc:
            up.stage_candidate(lock, str(mpath_b), str(src_b), str(pkg))
    assert exc.value.code == "stage_conflict" and envelope.read_bytes() != raw   # kept as it is, for inspection
    envelope.write_bytes(raw)
    monkeypatch.setattr(up.newhive, "runtime_identity", lambda: "cpython-0.0.0")
    assert up.load_staged(state, one.manifest_sha256) is None   # another runtime's bytes are not this runtime's


def test_staging_never_touches_the_installation(installed):
    from hive.core import newhive_update as up
    client = installed
    assert drive(client)["complete"]["first"]
    before = {p: p.stat().st_mtime_ns for p in client.data.rglob("*") if p.is_file() and not p.is_socket()}
    rows = client.hive.db.all("SELECT * FROM newhive_bindings")
    src_b, mpath_b = _release_b(client.work)
    with up.updater_lock(_state(client.work)) as lock:
        staged = up.stage_candidate(lock, str(mpath_b), str(src_b), str(client.pkg))
    assert client.nh.binding.sha == SHA_A and client.nh.coding_ready(True)   # not labelled current
    assert client.hive.db.all("SELECT * FROM newhive_bindings") == rows
    assert client.hive.db.one("SELECT 1 FROM repo_maps WHERE sha = ?", (SHA_B,)) is None   # never loaded by staging
    assert all(p.stat().st_mtime_ns == m for p, m in before.items() if p.exists() and p.suffix not in (".db-wal", ".db-shm"))
    assert str(staged.folder).startswith(str(client.work / "state"))


def test_update_with_a_staged_candidate_then_compatible_rollback(installed, local_env):
    from hive.core import newhive_update as up
    client = installed
    assert drive(client)["complete"]["first"]
    src_b, mpath_b = _release_b(client.work)
    state = _state(client.work)
    with up.updater_lock(state) as lock:
        staged = up.stage_candidate(lock, str(mpath_b), str(src_b), str(client.pkg))
    use_release(local_env, src_b, mpath_b, client.pkg)
    c2 = _restart(client)
    try:
        c2.src, c2.mpath = src_b, mpath_b
        assert c2.nh.binding.sha == SHA_B and not c2.nh.coding_ready(True)
        out, _ = helper_run(c2, staged=up.load_staged(state, staged.manifest_sha256), prepare=None)
        assert out["ok"], out
        assert c2.nh.coding_ready(True) and {r["sha"] for r in c2.hive.db.all("SELECT sha FROM repo_maps")} == {SHA_A, SHA_B}
        manifest_a = newhive.parse_manifest(newhive.read_manifest(str(client.mpath))).sha256
    finally:
        c2.__exit__(None, None, None)
    old = up.check_rollback(client.data, [])   # a release that cannot answer `features` (e.g. 1f5)
    assert old["ok"] is False and old["reason"] == "feature_unsupported" and old["missing"] == ["repo-work-gate/1"]
    ok = up.check_rollback(client.data, up.supported_features(), manifest_a)
    assert ok["ok"] and ok["target_completed"] is True
    fresh = up.check_rollback(client.data, up.supported_features(), "0" * 64)
    assert fresh["ok"] and fresh["target_completed"] is False


def test_rollback_check_cli_answers_for_the_target_release(installed):
    import subprocess
    import sys as sys_mod
    client = installed
    root = pathlib.Path(__file__).resolve().parents[2]
    env = dict(os.environ, PYTHONPATH=str(root))
    feats = subprocess.run([sys_mod.executable, "-m", "hive.core.newhive_update", "features"], cwd=root, env=env,
                           capture_output=True, text=True, timeout=60)
    assert feats.returncode == 0 and json.loads(feats.stdout)["features"] == ["repo-work-gate/1"]
    refused = subprocess.run([sys_mod.executable, "-m", "hive.core.newhive_update", "check-rollback", "--data-dir",
                              str(client.data), "--features", "[]"], cwd=root, env=env, capture_output=True, text=True,
                             timeout=60)
    assert refused.returncode == 3 and json.loads(refused.stdout)["reason"] == "feature_unsupported"


# ---- native mount cancellation and cleanup -------------------------------------------------------------------------

def _hung_mount(monkeypatch):
    import threading
    from hive.spaces.service import SpaceService
    gate, calls, real_mount = threading.Event(), [], SpaceService.mount_repo

    def hung(self, repo, sha, atoms, progress=None):
        calls.append((repo, sha))
        gate.wait(60)
        return real_mount(self, repo, sha, atoms, progress)
    monkeypatch.setattr(SpaceService, "mount_repo", hung)
    return gate, calls


def test_a_hung_mount_is_fenced_not_replaced_and_never_blocks_the_ask(installed, monkeypatch):
    client = installed
    sso = person_token(client)
    gate, calls = _hung_mount(monkeypatch)
    first = drive(client, stop_after="load")
    time.sleep(0.3)
    assert calls == [("omegahive", SHA_A)]
    started = time.monotonic()   # the event loop answers while the interpreter is busy mounting
    status = client.get("/api/local/status", headers={"Authorization": f"Bearer {sso}"})
    assert status.status_code == 200 and status.json()["coding"]["state"] == "getting_ready"
    assert time.monotonic() - started < 2.0
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {sso}"}).status_code == 200
    # Resume while the first mount is still running: the same retained exact map, no second mount
    second = drive(client, stop_after="load")
    assert second["load"]["unchanged"] is True and second["load"]["space"]["status"] in ("queued", "mounting")
    client.nh.sweep()
    assert calls == [("omegahive", SHA_A)]
    old = client.hive.db.one("SELECT * FROM local_bootstrap_sessions WHERE attempt = ?", (first["begin"]["attempt"],))
    assert old["retired_reason"] == "replaced"
    gate.set()
    assert wait_mounted(client, SHA_A) == "mounted"
    done = client.local.answer({"op": "bootstrap-complete", "runtime": RT, "token": second["token"], "repo": "omegahive",
                                "sha": SHA_A, "map_digest": second["prepared"].map_digest})
    assert done["ok"] and done["first"] and calls == [("omegahive", SHA_A)]


def test_shutdown_during_a_hung_mount_is_prompt_and_restart_recovers(installed, monkeypatch):
    client = installed
    gate, calls = _hung_mount(monkeypatch)
    drive(client, stop_after="load")
    time.sleep(0.2)
    app2 = make_app(client.data)
    started = time.monotonic()
    with TestClient(app2, base_url=BASE):
        pass   # a lifespan start and stop while the old process's mount is still stuck
    assert time.monotonic() - started < 15.0
    gate.set()   # from here the patched mount runs straight through to the real one
    c3 = _restart(client)
    try:
        assert c3.hive.repo_maps.space("omegahive", SHA_A)["status"] in ("unmounted", "queued", "mounting", "mounted")
        out = drive(c3)
        assert out["complete"]["ok"] and c3.nh.coding_ready(True)
    finally:
        c3.__exit__(None, None, None)


# ---- time to first Ask versus time to code-ready -------------------------------------------------------------------

def test_time_to_first_ask_is_measured_apart_from_code_ready(installed, monkeypatch):
    client = installed
    sso = person_token(client)

    async def accepted(viewer, data):   # the conductor's acceptance, without any provider call
        return {"id": "turn_1", "state": "accepted"}
    monkeypatch.setattr(client.hive.ask, "create", accepted)
    got = client.post("/api/ask", json={"operation_id": "op-1", "text": "hello"},
                      headers={"Authorization": f"Bearer {sso}", **ORIGIN})
    assert got.status_code == 202
    timing = client.nh.status()["timing"]
    assert timing["first_signin_seconds"] is not None and timing["first_ask_seconds"] is not None
    assert timing["code_ready_seconds"] is None   # the Ask came first, while coding was still being prepared
    assert drive(client)["complete"]["first"] and client.nh.coding_ready(True)
    timing = client.nh.status()["timing"]
    assert timing["code_ready_seconds"] >= timing["first_ask_seconds"] >= 0
    assert timing["code_ready_rss_kb"] and timing["code_ready_rss_kb"] > 0
    second = client.post("/api/ask", json={"operation_id": "op-2", "text": "again"},
                         headers={"Authorization": f"Bearer {sso}", **ORIGIN})
    assert second.status_code == 202 and client.nh.status()["timing"]["first_ask_at"] == timing["first_ask_at"]


# ---- the browser handoff is its own confirmed step (Code R1B_HELPER_SIGNIN_HANDOFF finding; mirrors its probe) ------

@pytest.mark.parametrize("signin,ok", [({"ok": False, "error": "no_owner"}, False), ({"ok": True}, False),
                                       ({"ok": True, "url": ""}, False),
                                       ({"ok": True, "url": "http://evil.example/local-signin#x"}, False),
                                       ({"ok": True, "url": "http://127.0.0.1:8700/local-signin#synthetic"}, True)])
def test_helper_reports_a_browser_handoff_only_with_a_real_link(monkeypatch, signin, ok):
    from hive.core import newhive_helper as helper
    replies = iter([{"ok": True, "port": 8700}, {"ok": True, "completed": True, "receipt": {"attempt": "synthetic"}},
                    signin])
    calls = []

    def control(path, request, timeout=None):
        calls.append(request)
        return next(replies)
    monkeypatch.setattr(helper, "control", control)
    out = helper.run_setup("/synthetic/no-socket")
    assert calls[-1] == {"op": "signin"}
    assert out["receipt"] == {"attempt": "synthetic"}   # the completed setup is kept either way
    if ok:
        assert out["ok"] is True and out["url"] == signin["url"] and out["state"] == "link_ready"
        assert out["signed_in"] is False and out["heading"] == "Your hive is ready to open"   # a link is not a sign-in
    else:
        assert out["ok"] is False and not (out.get("url")) and out["stage"] == "browser_signin"
        assert out["setup_completed"] is True and out["signed_in"] is False
        if signin.get("error") == "no_owner":
            assert (out["state"], out["heading"], out["action"]) == ("finish_signin", "Finish signing in", "Continue sign-in")
        else:
            assert out["state"] == "signin_unprepared" and out["heading"] == "Your coding tools are ready"
            assert out["text"] == "Sign-in couldn\u2019t be prepared. Your completed setup is saved."
            assert out["action"] == "Try opening your hive again"
        assert "aren't ready" not in out["text"] and "Try setup again" not in json.dumps(out)
        assert "evil" not in json.dumps(out)   # the rejected link is never echoed back


def test_retry_signin_asks_only_for_the_owners_link(installed):
    from hive.core import newhive_helper as helper
    client = installed
    assert helper_run(client)[0]["ok"]
    attempts = client.hive.db.one("SELECT COUNT(*) AS n FROM local_bootstrap_sessions")["n"]
    out = helper.retry_signin(client.data / "run" / "control.sock")
    assert out["ok"] and out["state"] == "link_ready" and out["url"].startswith("http://127.0.0.1:8700/local-signin#")
    assert client.hive.db.one("SELECT COUNT(*) AS n FROM local_bootstrap_sessions")["n"] == attempts
    assert client.nh.coding_ready(True) and sessions(client, "sso-bootstrap") == []


# ---- stand-in R1b P1: a stalled native count never blocks a request path --------------------------------------------

def test_request_path_readiness_never_waits_on_a_stalled_native_count(installed, monkeypatch):
    import time as _time
    client = installed
    assert drive(client)["complete"]["first"] and client.nh.coding_ready(True)
    stalls = []
    def stalled(*_a, **_kw):
        stalls.append(1)
        _time.sleep(2.0)   # a stuck interpreter
        return 0
    monkeypatch.setattr(client.hive.spaces, "_repo_count", stalled)
    monkeypatch.setattr(newhive, "NATIVE_TTL", 0.0)
    monkeypatch.setattr(newhive, "NATIVE_STALE_MAX", 0.0)   # the last fresh answer has expired
    t0 = _time.monotonic()
    ready = client.nh.coding_ready()          # what send_to_agent / restore / public_status use
    took = _time.monotonic() - t0
    assert took < 0.5, took                   # never touches the interpreter
    assert ready is False                     # fails closed while the answer is stale
    assert stalls == []                       # the request path made no native call


# ---- R1b.2 (Design launcher-retry-signin-rebase-readback-r1): retry stays browser sign-in recovery -------------------

import pytest as _pytest


@_pytest.mark.parametrize("hello", ["refused", "oserror", "none", "badport"])
@_pytest.mark.parametrize("known", [True, None])
def test_retry_signin_failure_stays_in_signin_recovery(monkeypatch, hello, known):
    from hive.core import newhive_helper as helper
    def fake_control(_path, request, timeout=None):
        assert request == {"op": "hello"}   # only hello is asked; nothing re-enters setup
        if hello == "oserror":
            raise OSError("socket gone")
        if hello == "none":
            return None
        if hello == "badport":
            return {"ok": True, "port": "8700"}
        return {"ok": False, "error": "control_unavailable"}
    monkeypatch.setattr(helper, "control", fake_control)
    receipt = {"receipt": "kept"} if known else None
    out = helper.retry_signin("/nonexistent.sock", receipt=receipt, setup_completed=known)
    assert out["ok"] is False and out["stage"] == "browser_signin" and out["state"] == "signin_unprepared"
    assert out["action"] == "Try opening your hive again" and out["signed_in"] is False
    assert out["receipt"] == receipt and out["setup_completed"] is known   # the caller's status, unchanged
    text = json.dumps(out)
    assert "Try setup again" not in text and "aren't ready" not in text and "aren\\u2019t ready" not in text
    if known:
        assert out["heading"] == "Your coding tools are ready"
    else:   # unknown completion: Design's exact neutral copy, claims neither readiness nor loss
        assert (out["heading"], out["text"]) == ("Let\u2019s open your hive", "Sign-in couldn\u2019t be prepared.")


@_pytest.mark.parametrize("known", [True, False, None])
def test_retry_signin_keeps_caller_status_on_link_and_missing_owner(monkeypatch, known):
    from hive.core import newhive_helper as helper
    replies = {"hello": {"ok": True, "port": 8700}}
    def fake_control(_path, request, timeout=None):
        return replies[request["op"]]
    monkeypatch.setattr(helper, "control", fake_control)
    receipt = {"receipt": "kept"} if known else None
    replies["signin"] = {"ok": True, "url": "http://127.0.0.1:8700/local-signin#x"}
    ok = helper.retry_signin("/x.sock", receipt=receipt, setup_completed=known)
    assert ok["ok"] and ok["state"] == "link_ready"
    assert ok["setup_completed"] is known and ok["receipt"] == receipt   # a link is not completion evidence
    replies["signin"] = {"ok": False, "error": "no_owner"}
    miss = helper.retry_signin("/x.sock", receipt=receipt, setup_completed=known)
    assert miss["state"] == "finish_signin" and miss["setup_completed"] is known
    if known is True:
        assert "saved" in miss["text"]
    else:
        assert (miss["heading"], miss["text"], miss["action"]) == (
            "Finish signing in", "Continue sign-in in the OmegaHive launcher.", "Continue sign-in")


# ---- a refused begin passes on only a fixed stage and a known code (Kimi R1b.3 P2; Code reason-code inventory) --------

@pytest.mark.parametrize("begin,stage,reason", [
    ({"ok": False, "error": "setup_held", "stage": "source",
      "reason": {"code": "symlink", "message": "a link at " + "/" + "Users/someone/secret", "path": "/" + "Users/someone/secret"}},
     "source", "symlink"),
    ({"ok": False, "error": "setup_held", "stage": "map", "reason": {"code": "map_conflict", "message": "x"}}, "map", "map_conflict"),
    ({"ok": False, "error": "setup_held", "stage": "assets", "reason": {"code": "retained_artifact_missing"}},
     "install", "retained_artifact_missing"),
    ({"ok": False, "error": "setup_held", "stage": "restart", "reason": {"code": "verify_failed", "stage": "restart"}},
     "source", "verify_failed"),
    ({"ok": False, "error": "setup_busy", "stage": "verifying"}, "begin", "setup_busy"),
    ({"ok": False, "error": "no_owner"}, "begin", "no_owner"),
    ({"ok": False, "error": "setup_held", "stage": "/tmp/evil path", "reason": {"code": "made up", "message": "m"}},
     "begin", "setup_held"),
    ({"ok": False, "error": "something new", "stage": {"x": 1}, "reason": "free text with /a/path"}, "begin", "unexpected"),
    ({"ok": False, "reason": ["code"]}, "begin", "unexpected"),
])
def test_helper_passes_on_a_refused_begin_as_known_stage_and_code_only(monkeypatch, begin, stage, reason):
    from hive.core import newhive_helper as helper
    replies = iter([{"ok": True, "port": 8700}, begin])
    monkeypatch.setattr(helper, "control", lambda path, request, timeout=None: next(replies))
    out = helper.run_setup("/synthetic/no-socket")
    assert out == {"ok": False, "stage": stage, "reason": reason, "text": newhive.COPY["not_ready"],
                   "action": newhive.COPY["retry"]}


def test_begin_reason_codes_cover_every_source_refusal_in_newhive():
    import re
    from hive.core import newhive_helper as helper
    text = pathlib.Path(newhive.__file__).read_text()
    literal = set(re.findall(r'SourceRefused\(\s*"([a-z_]+)"', text))
    import ast
    tree = ast.parse(text)
    # begin()'s explicit refusal dicts and _restart_verify's fallback close the non-SourceRefused set.
    explicit = {value.value for node in ast.walk(tree)
                if isinstance(node, ast.FunctionDef) and node.name in ("begin", "_restart_verify")
                for entry in ast.walk(node) if isinstance(entry, ast.Dict)
                for key, value in zip(entry.keys, entry.values)
                if isinstance(key, ast.Constant) and key.value == "code"
                and isinstance(value, ast.Constant) and isinstance(value.value, str)}
    assert literal and literal | explicit == helper.BEGIN_REASON_CODES
