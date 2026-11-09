"""R18: updates are detected and shown, owners can ask and hold, admins or an explicitly allowed mind apply them."""
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
