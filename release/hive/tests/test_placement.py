"""Minds move between hives: export, import with the same id, tombstone, and back again (the owner, 2026-10-04)."""
import io
import json
import tarfile

import pathlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_core_api import PETTA, FakeSupervisor


class TokenSupervisor(FakeSupervisor):
    """The fake supervisor, plus the one workspace file a move depends on: the mind's token."""

    def prepare(self, agent, token):
        super().prepare(agent, token)
        root = self.hive.settings.data_dir / "agents" / agent["id"]
        root.mkdir(parents=True, exist_ok=True)
        (root / "token").write_text(token)


def _hive(data_dir):
    app = create_app(load_settings(data_dir=data_dir, admin_password="pw", petta_path=PETTA), supervisor=TokenSupervisor(),
                     reconcile_seconds=0)
    return app


@pytest.fixture
def client():  # noqa: F811  (the cloud hive, with token-writing supervisor)
    with TestClient(_hive(pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")))) as c:
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        yield c


@pytest.fixture
def home():
    """A second hive (Maren's home hive) in its own data directory."""
    with TestClient(_hive(pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")))) as c:
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        yield c


def mind_in_swarm(c, name="Helper"):
    swarm = c.post("/api/swarms", json={"name": "Household", "visibility": "public"}).json()
    mind = c.post("/api/agents", json={"name": name, "kind": "omega", "swarm_id": swarm["id"]}).json()
    return swarm, mind


def test_a_mind_moves_home_and_back_with_its_memory(client, home):
    cloud = client.app.state.hive
    swarm, mind = mind_in_swarm(client)
    ws = cloud.settings.data_dir / "agents" / mind["id"]
    (ws / "memory").mkdir(parents=True, exist_ok=True)
    (ws / "memory" / "history.metta").write_text("(remember tea)")
    cloud.db.insert("messages", {"id": "m_1", "agent_id": mind["id"], "conversation_id": "c", "direction": "in", "sender": "user:quinn",
                                 "text": "hello", "created_at": "2026-10-04T00:00:00Z"})
    body = json.loads((ws / "memory" / "runtime" / "body" / "host.json").read_text())
    assert body["placement"] == "cloud" and body["hive_id"] == cloud.placement.identity()["id"]

    r = client.post(f"/api/agents/{mind['id']}/export")
    assert r.status_code == 200, r.text
    names = tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz").getnames()
    assert "workspace/token" not in names and "workspace/memory/history.metta" in names
    assert not any(n.startswith("workspace/memory/runtime/body") for n in names)

    home.patch("/api/hive/identity", json={"name": "Maren's computer", "home": True})
    home_swarm = home.post("/api/swarms", json={"name": "Home", "visibility": "public"}).json()
    arrived = home.post(f"/api/agents/import?swarm_id={home_swarm['id']}", content=r.content)
    assert arrived.status_code == 200, arrived.text
    assert arrived.json()["agent"]["id"] == mind["id"]                                  # the same mind
    hhive = home.app.state.hive
    hws = hhive.settings.data_dir / "agents" / mind["id"]
    assert (hws / "memory" / "history.metta").read_text() == "(remember tea)"
    assert (hws / "token").exists() and (hws / "token").read_text() != (ws / "token").read_text()
    assert json.loads((hws / "memory" / "runtime" / "body" / "host.json").read_text())["placement"] == "home"
    assert [m["text"] for m in home.get(f"/api/agents/{mind['id']}/messages").json()] == ["hello"]

    settled = client.post(f"/api/agents/{mind['id']}/settle", json={"to_hive": hhive.placement.identity()["id"], "to_name": "Maren's computer",
                                                                    "manifest_sha256": r.headers["x-manifest-sha256"]}).json()
    assert settled["moved_to_name"] == "Maren's computer" and settled["status"] == "moved"
    assert client.post(f"/api/agents/{mind['id']}/start").json()["error"]["code"] == "moved"
    assert client.post(f"/api/agents/{mind['id']}/export").status_code == 409

    # and back: the cloud restores the same mind from its tombstone, with what it learned at home
    (hws / "memory" / "history.metta").write_text("(remember tea) (remember biscuits)")
    back = home.post(f"/api/agents/{mind['id']}/export")
    assert back.status_code == 200
    again = client.post("/api/agents/import", content=back.content).json()
    assert again["agent"]["id"] == mind["id"] and again["agent"]["moved_to"] is None
    assert (ws / "memory" / "history.metta").read_text() == "(remember tea) (remember biscuits)"
    assert again["agent"]["swarm_id"] == swarm["id"]
    rec = cloud.placement.evidence.track_record(f"(--> (x {mind['id']} {cloud.placement.identity()['id']}) placed)")
    assert rec["answers"] == 1


def test_bundles_are_checked(client, home):
    _, mind = mind_in_swarm(client)
    good = client.post(f"/api/agents/{mind['id']}/export").content
    sw = home.post("/api/swarms", json={"name": "Home"}).json()
    buf = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(good), mode="r:gz") as src, tarfile.open(fileobj=buf, mode="w:gz") as out:
        for m in src.getmembers():
            data = src.extractfile(m).read()
            if m.name.startswith("workspace/"):
                data = data + b" tampered"
                m.size = len(data)
            out.addfile(m, io.BytesIO(data))
        evil = tarfile.TarInfo("../escape")
        evil.size = 1
        out.addfile(evil, io.BytesIO(b"x"))
    r = home.post(f"/api/agents/import?swarm_id={sw['id']}", content=buf.getvalue())
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_bundle"
    assert home.post(f"/api/agents/import?swarm_id={sw['id']}", content=b"not a tar").status_code == 400
    # a mind already here is not imported twice
    assert home.post(f"/api/agents/import?swarm_id={sw['id']}", content=good).status_code == 200
    assert home.post(f"/api/agents/import?swarm_id={sw['id']}", content=good).json()["error"]["code"] == "already_here"


def _rebundle(bundle, edit_manifest, extra_files=None):
    """Repack a bundle with an edited manifest (and optional extra workspace files, hashed honestly)."""
    import hashlib
    src = tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz")
    files = {m.name: src.extractfile(m).read() for m in src.getmembers()}
    manifest = json.loads(files.pop("manifest.json"))
    for name, data in (extra_files or {}).items():
        files[name] = data
        manifest["files"][name] = hashlib.sha256(data).hexdigest()
    edit_manifest(manifest)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as out:
        for name, data in [("manifest.json", json.dumps(manifest).encode())] + sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            out.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_a_bundle_cannot_grant_authority_or_touch_other_minds(client, home):
    """Security fixes 2026-10-04: bundle rules are this mind's own only; rows are forced to this mind; memory is atoms only."""
    _, mind = mind_in_swarm(client)
    _, other = mind_in_swarm(client, "Other")
    good = client.post(f"/api/agents/{mind['id']}/export").content

    def forge(m):
        m["rules"] = [{"scope": "hive", "skill": "shell", "mode": "allow", "note": ""},
                      {"scope": f"agent:{mind['id']}", "skill": "hive-update-apply", "mode": "allow", "note": ""},
                      {"scope": f"agent:{mind['id']}", "skill": "write-file", "mode": "deny", "note": "keep"}]
        m["messages"] = [{"id": "m_forged", "agent_id": other["id"], "conversation_id": "c", "direction": "in",
                          "sender": "user:x", "text": "planted", "created_at": "2026-10-04T00:00:00Z"}]
        m["wakeups"] = [{"id": "w_1", "agent_id": other["id"], "tz": "UTC", "text": "x", "enabled": 1,
                         "created_at": "2026-10-04T00:00:00Z", "evil); DROP TABLE agents; --": 1}]

    sw = home.post("/api/swarms", json={"name": "Home"}).json()
    r = home.post(f"/api/agents/import?swarm_id={sw['id']}", content=_rebundle(good, forge))
    assert r.status_code == 200, r.text
    hive = home.app.state.hive
    rules = hive.db.all("SELECT scope, skill, mode FROM policy_rules")
    assert not any(x["scope"] == "hive" for x in rules)                                   # no hive-wide grant
    assert not any(x["skill"] == "hive-update-apply" for x in rules)                       # never carried
    assert any(x["skill"] == "write-file" and x["mode"] == "deny" for x in rules)          # a deny travels
    msg = hive.db.one("SELECT agent_id FROM messages WHERE id = 'm_forged'")
    assert msg["agent_id"] == mind["id"]                                                    # forced to this mind
    assert hive.db.one("SELECT agent_id FROM wakeups WHERE id = 'w_1'")["agent_id"] == mind["id"]

    fresh = client.post(f"/api/agents/{other['id']}/export").content                     # not yet on the home hive
    bang = _rebundle(fresh, lambda m: None, {"workspace/memory/beliefs.metta": b"(fact a)\n!(shell \"rm -rf ~\")\n"})
    r = home.post(f"/api/agents/import?swarm_id={sw['id']}", content=bang)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_bundle" and "atoms only" in r.json()["error"]["message"]
    assert hive.db.one("SELECT 1 FROM agents WHERE id = ?", (other["id"],)) is None      # nothing was written


def _moved_home_and_back_bundle(client, home):
    """A mind exported from the cloud, settled at home, and its bundle back: the cloud row is a tombstone."""
    swarm, mind = mind_in_swarm(client)
    r = client.post(f"/api/agents/{mind['id']}/export")
    home_swarm = home.post("/api/swarms", json={"name": "Home", "visibility": "public"}).json()
    assert home.post(f"/api/agents/import?swarm_id={home_swarm['id']}", content=r.content).status_code == 200
    hhive = home.app.state.hive
    client.post(f"/api/agents/{mind['id']}/settle", json={"to_hive": hhive.placement.identity()["id"], "to_name": "Home",
                                                          "manifest_sha256": r.headers["x-manifest-sha256"]})
    return swarm, mind, home.post(f"/api/agents/{mind['id']}/export").content


def test_a_returning_mind_is_refused_when_its_row_changed_after_the_read(client, home, monkeypatch):
    """Stand-in r5: placement read the row before taking the fences; the write re-checks it under them."""
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    real = cloud.swarm_membership
    def change_then_fence(*ids):                          # between placement's read and the fenced write
        cloud.db.execute("UPDATE agents SET moved_to = NULL WHERE id = ?", (mind["id"],))
        return real(*ids)
    monkeypatch.setattr(cloud, "swarm_membership", change_then_fence)
    r = client.post("/api/agents/import", content=back)
    assert r.status_code == 409 and r.json()["error"]["code"] == "placement_stale"
    assert cloud.db.one("SELECT deleted, moved_to FROM agents WHERE id = ?", (mind["id"],))["moved_to"] is None


def test_a_returning_mind_respects_the_source_swarm_fence(client, home):
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    other = client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()
    cloud._swarm_ops[swarm["id"]] = -1                   # a delete or restore of its source swarm is in flight
    try:
        r = client.post(f"/api/agents/import?swarm_id={other['id']}", content=back)
    finally:
        cloud._swarm_ops.pop(swarm["id"], None)
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_busy"
    assert cloud.db.one("SELECT swarm_id FROM agents WHERE id = ?", (mind["id"],))["swarm_id"] == swarm["id"]


# ---- r7: stage, fence, re-validate, swap, roll back (stand-in r6) ----------------------------------------------------

def _workspace(hive, agent_id):
    return hive.settings.data_dir / "agents" / agent_id


def _leftovers(hive, agent_id):
    return sorted(p.name for p in _workspace(hive, agent_id).parent.iterdir() if p.name.startswith(f".{agent_id}.staged-"))


def test_a_stale_import_never_touches_the_workspace(client, home, monkeypatch):
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    marker = _workspace(cloud, mind["id"]) / "OLD"
    marker.write_text("kept")
    real = cloud.swarm_membership
    def change_then_fence(*ids):
        cloud.db.execute("UPDATE agents SET moved_to = NULL WHERE id = ?", (mind["id"],))
        return real(*ids)
    monkeypatch.setattr(cloud, "swarm_membership", change_then_fence)
    assert client.post("/api/agents/import", content=back).json()["error"]["code"] == "placement_stale"
    assert marker.read_text() == "kept" and _leftovers(cloud, mind["id"]) == []


def test_a_failed_write_after_the_swap_restores_the_old_workspace(client, home, monkeypatch):
    from hive.core.hive import HiveError
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    marker = _workspace(cloud, mind["id"]) / "OLD"
    marker.write_text("kept")
    def refuse(*a, **k):
        raise HiveError(409, "swarm_archived", "that swarm was archived")
    monkeypatch.setattr(cloud, "update_in_open_swarm", refuse)
    assert client.post("/api/agents/import", content=back).json()["error"]["code"] == "swarm_archived"
    assert marker.read_text() == "kept" and _leftovers(cloud, mind["id"]) == []
    assert cloud.db.one("SELECT moved_to FROM agents WHERE id = ?", (mind["id"],))["moved_to"]
    befores = [p for p in _workspace(cloud, mind["id"]).parent.iterdir() if p.name.startswith(f".{mind['id']}.before-")]
    assert befores == []                                   # the old workspace is back in place, not left aside


def test_a_busy_source_swarm_never_touches_the_workspace(client, home):
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    marker = _workspace(cloud, mind["id"]) / "OLD"
    marker.write_text("kept")
    cloud._swarm_ops[swarm["id"]] = -1
    try:
        assert client.post("/api/agents/import", content=back).json()["error"]["code"] == "swarm_busy"
    finally:
        cloud._swarm_ops.pop(swarm["id"], None)
    assert marker.read_text() == "kept" and _leftovers(cloud, mind["id"]) == []


def test_concurrent_imports_of_one_mind_land_once(client, home):
    import threading
    import time as _time
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    lock = cloud.supervisor.lock(mind["id"])
    lock.acquire()                                        # both imports stage, then wait at the mind's lock
    results = []
    threads = [threading.Thread(target=lambda: results.append(client.post("/api/agents/import", content=back)))
               for _ in range(2)]
    try:
        for t in threads:
            t.start()
        deadline = _time.time() + 20
        while len(_leftovers(cloud, mind["id"])) < 2 and _time.time() < deadline:
            _time.sleep(0.05)
        assert len(_leftovers(cloud, mind["id"])) == 2
    finally:
        lock.release()
    for t in threads:
        t.join(30)
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409] and [r.json()["error"]["code"] for r in results if r.status_code == 409] == ["placement_stale"]
    assert _leftovers(cloud, mind["id"]) == [] and cloud._agent_row(mind["id"])["moved_to"] is None
    assert (_workspace(cloud, mind["id"]) / "token").exists()   # the winner's workspace, prepared, not overwritten


def test_a_deleted_mind_coming_back_finishes_its_pending_cleanup_first(client, home, monkeypatch):
    cloud = client.app.state.hive
    swarm, mind = mind_in_swarm(client)
    bundle = client.post(f"/api/agents/{mind['id']}/export").content
    sync, fail = cloud.rooms.sync_coffee, {"left": 1}
    def flaky(*a, **k):
        if fail["left"]:
            fail["left"] -= 1
            raise RuntimeError("room store down")
        return sync(*a, **k)
    monkeypatch.setattr(cloud.rooms, "sync_coffee", flaky)
    events = []
    original = cloud.events.publish
    monkeypatch.setattr(cloud.events, "publish", lambda kind, **kw: (events.append((kind, kw.get("agent_id"))), original(kind, **kw)))
    try:
        cloud.delete_agent(mind["id"])
    except RuntimeError:
        pass
    assert cloud.db.one("SELECT agent_id FROM mind_cleanup") == {"agent_id": mind["id"]}
    r = client.post(f"/api/agents/import?swarm_id={swarm['id']}", content=bundle)
    assert r.status_code == 200, r.text
    assert not cloud.db.one("SELECT 1 FROM mind_cleanup") and cloud._agent_row(mind["id"])["deleted"] == 0
    assert events.count(("agent.deleted", mind["id"])) == 1    # once, before it came back; never after


# ---- r8: the whole arrival under the mind's lock and fences, rolled back as one ---------------------------------------

def test_a_failing_later_effect_rolls_the_whole_arrival_back(client, home, monkeypatch):
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    marker = _workspace(cloud, mind["id"]) / "OLD"
    marker.write_text("kept")
    before = dict(cloud.db.one("SELECT * FROM agents WHERE id = ?", (mind["id"],)))
    moves = cloud.db.one("SELECT COUNT(*) AS n FROM mind_moves WHERE agent_id = ?", (mind["id"],))["n"]
    granted = []
    grant = cloud.spaces.grant
    monkeypatch.setattr(cloud.spaces, "grant", lambda *x: (granted.append(x), grant(*x)))
    def broken_body(agent_id):
        raise OSError("disk full")
    monkeypatch.setattr(cloud.placement, "write_body", broken_body)
    with pytest.raises(OSError, match="disk full"):        # the test client re-raises the server's error
        client.post("/api/agents/import", content=back)
    after = dict(cloud.db.one("SELECT * FROM agents WHERE id = ?", (mind["id"],)))
    assert after == before                                               # the row, untouched
    assert cloud.db.one("SELECT COUNT(*) AS n FROM mind_moves WHERE agent_id = ?", (mind["id"],))["n"] == moves
    assert marker.read_text() == "kept" and _leftovers(cloud, mind["id"]) == []
    assert granted == []                                                 # spaces come last; never reached


def test_nothing_else_acts_on_the_mind_during_its_arrival(client, home, monkeypatch):
    import threading
    cloud = client.app.state.hive
    swarm, mind, back = _moved_home_and_back_bundle(client, home)
    seen = {}
    prepare = cloud.supervisor.prepare
    def prepare_and_race(agent, token):
        t = threading.Thread(target=lambda: seen.setdefault("delete", client.delete(f"/api/agents/{mind['id']}")))
        t.start(); t.join(0.5)
        seen["during"] = (t.is_alive() or seen["delete"].status_code == 409)   # blocked on the lock, or fenced out
        seen["thread"] = t
        return prepare(agent, token)
    monkeypatch.setattr(cloud.supervisor, "prepare", prepare_and_race)
    r = client.post("/api/agents/import", content=back)
    assert r.status_code == 200, r.text
    assert seen["during"] is True
    seen["thread"].join(30)


def test_settle_is_fenced_and_locked(client, home, monkeypatch):
    import threading
    cloud = client.app.state.hive
    swarm, mind = mind_in_swarm(client)
    r = client.post(f"/api/agents/{mind['id']}/export")
    body = {"to_hive": "h_other", "to_name": "Home", "manifest_sha256": r.headers["x-manifest-sha256"]}
    cloud._swarm_ops[swarm["id"]] = -1                   # its swarm is being deleted or restored
    try:
        busy = client.post(f"/api/agents/{mind['id']}/settle", json=body)
    finally:
        cloud._swarm_ops.pop(swarm["id"], None)
    assert busy.status_code == 409 and busy.json()["error"]["code"] == "swarm_busy"
    assert cloud._agent_row(mind["id"])["moved_to"] is None
    monkeypatch.setattr(cloud, "supervisor", None)        # and without a supervisor it still takes the mind's lock
    out = []
    with cloud._mind_lock(mind["id"]):
        t = threading.Thread(target=lambda: out.append(client.post(f"/api/agents/{mind['id']}/settle", json=body)))
        t.start(); t.join(0.5)
        assert t.is_alive() and cloud._agent_row(mind["id"])["moved_to"] is None
    t.join(10)
    assert out[0].status_code == 200 and out[0].json()["moved_to_name"] == "Home"
