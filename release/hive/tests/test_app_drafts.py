"""Per-person app drafts (Surface Studio slice 2)."""
import json

import pytest

from hive.tests.test_core_api import client  # noqa: F401  (fixture: local operator)
from hive.tests.test_visibility import person


def an_app(client):
    progs = client.get("/api/programs").json()
    items = progs if isinstance(progs, list) else progs.get("programs", [])
    pid = next((p["id"] for p in items if p.get("enabled", True)), None)
    if pid is None:
        pytest.skip("no enabled app in the test hive")
    return pid


def home(monkeypatch, pid, *swarms):
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({pid: list(swarms)}))


def admit(client, principal, pid, swarm_id):
    """As if the app's own view had just admitted this person here (the HTTP path is tested below)."""
    from hive.core.db import now
    client.app.state.hive.db.execute("INSERT OR REPLACE INTO app_admissions (principal, program, swarm, admitted_at) "
                                     "VALUES (?, ?, ?, ?)", (principal, pid, swarm_id, now()))


def test_drafts_are_private_versioned_and_bounded(client, monkeypatch):
    pid = an_app(client)
    sw = client.post("/api/swarms", json={"name": "Studio", "visibility": "public"}).json()
    home(monkeypatch, pid, sw["id"])
    ana, ben = person(client, "u_ana", "admin"), person(client, "u_ben", "admin")
    admit(client, "user:u_ana", pid, sw["id"]); admit(client, "user:u_ben", pid, sw["id"])
    url = f"/api/apps/{pid}/drafts/deck-1"
    r = client.put(url, json={"swarm_id": sw["id"], "expected_revision": None, "body": {"v": 1}}, headers=ana)
    assert r.status_code == 200 and r.json()["revision"] == 1, r.text
    r = client.put(url, json={"swarm_id": sw["id"], "expected_revision": None, "body": {"v": 2}}, headers=ana)
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_conflict"
    assert r.json()["error"]["current_revision"] == 1
    assert client.put(url, json={"swarm_id": sw["id"], "expected_revision": 1, "body": {"v": 2}}, headers=ana).json()["revision"] == 2
    assert client.get(f"{url}?swarm_id={sw['id']}", headers=ana).json()["body"] == {"v": 2}
    assert client.get(f"{url}?swarm_id={sw['id']}", headers=ben).status_code == 404          # never another person's
    assert client.get(f"/api/apps/{pid}/drafts?swarm_id={sw['id']}", headers=ben).json()["drafts"] == []
    big = {"x": "a" * (256 * 1024)}
    assert client.put(url, json={"swarm_id": sw["id"], "expected_revision": 2, "body": big}, headers=ana).status_code == 413
    assert client.delete(f"{url}?swarm_id={sw['id']}", headers=ana).status_code == 200
    assert client.get(f"{url}?swarm_id={sw['id']}", headers=ana).status_code == 404


def test_only_the_last_twenty_revisions_are_kept(client, monkeypatch):
    pid = an_app(client)
    sw = client.post("/api/swarms", json={"name": "Keep", "visibility": "public"}).json()
    home(monkeypatch, pid, sw["id"])
    ana = person(client, "u_ana2", "admin")
    admit(client, "user:u_ana2", pid, sw["id"])
    rev = None
    for i in range(25):
        rev = client.put(f"/api/apps/{pid}/drafts/k", json={"swarm_id": sw["id"], "expected_revision": rev, "body": {"i": i}},
                         headers=ana).json()["revision"]
    n = client.app.state.hive.db.one("SELECT COUNT(*) n FROM app_drafts WHERE draft_key = 'k' AND principal = 'user:u_ana2'")["n"]
    assert rev == 25 and n == 20


def test_no_drafts_for_an_app_in_a_swarm_it_does_not_live_in(client, monkeypatch):
    pid = an_app(client)
    here = client.post("/api/swarms", json={"name": "Here", "visibility": "public"}).json()
    there = client.post("/api/swarms", json={"name": "There", "visibility": "public"}).json()
    home(monkeypatch, pid, here["id"])
    ana = person(client, "u_ana4", "admin")
    admit(client, "user:u_ana4", pid, here["id"]); admit(client, "user:u_ana4", pid, there["id"])
    url = f"/api/apps/{pid}/drafts/k"
    r = client.put(url, json={"swarm_id": there["id"], "expected_revision": None, "body": {}}, headers=ana)
    assert r.status_code == 404 and r.json()["error"]["code"] == "app_not_here"
    assert client.get(f"/api/apps/{pid}/drafts?swarm_id={there['id']}", headers=ana).status_code == 404
    assert client.put(url, json={"swarm_id": here["id"], "expected_revision": None, "body": {}}, headers=ana).status_code == 200


def test_auth_me_reports_person_kind(client):
    ana = person(client, "u_ana3", "member")
    me = client.get("/api/auth/me", headers=ana).json()
    assert me["person_kind"] == "person" and me["local_operator"] is False
    op = client.get("/api/auth/me").json()
    assert op["person_kind"] == "operator" and op["local_operator"] is True


GATED = """
ALLOWED = {"user:u_owner"}

def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [], "actions": []}

def view(ctx, focus, stage):
    if (ctx.viewer or {}).get("principal") not in ALLOWED:
        raise PermissionError("owner person required")
    return {"revision": "r1", "items": [{"id": "i1", "kind": "k", "label": "i"}]}

def act(ctx, action, items, params):
    raise PermissionError("no actions")
"""


def gated_app(client, tmp_path, monkeypatch, swarm_id):
    folder = tmp_path / "gated"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "gated", "name": "Gated", "capabilities": []}))
    (folder / "program.py").write_text(GATED)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    home(monkeypatch, "gated", swarm_id)
    client.post("/api/programs/reload").raise_for_status()
    return "gated"


def ops(client, who, pid, swarm_id):
    url = f"/api/apps/{pid}/drafts/k"
    return [client.put(url, json={"swarm_id": swarm_id, "expected_revision": None, "body": {"v": 1}}, headers=who).status_code,
            client.get(f"/api/apps/{pid}/drafts?swarm_id={swarm_id}", headers=who).status_code,
            client.get(f"{url}?swarm_id={swarm_id}", headers=who).status_code,
            client.delete(f"{url}?swarm_id={swarm_id}", headers=who).status_code]


def test_drafts_follow_the_apps_own_decision_about_this_person(client, tmp_path, monkeypatch):
    """OmegaReview next8 B1: a person the app refuses gets no drafts there, on any of the four operations."""
    sw = client.post("/api/swarms", json={"name": "Gated", "visibility": "public"}).json()["id"]
    pid = gated_app(client, tmp_path, monkeypatch, sw)
    owner, other = person(client, "u_owner", "member"), person(client, "u_other", "member")
    assert ops(client, owner, pid, sw) == [403, 403, 403, 403]           # not opened yet: the app has not admitted anyone
    assert client.post(f"/api/programs/{pid}/view", json={"swarm_id": sw}, headers=other).status_code == 403
    assert ops(client, other, pid, sw) == [403, 403, 403, 403]
    assert client.post(f"/api/programs/{pid}/view", json={"swarm_id": sw}, headers=owner).status_code == 200
    assert ops(client, owner, pid, sw) == [200, 200, 200, 200]           # save, list, read, delete
    module = client.app.state.hive.programs.programs[pid]["module"]
    module.ALLOWED.clear()                                                # the app now refuses its owner too
    assert client.post(f"/api/programs/{pid}/view", json={"swarm_id": sw}, headers=owner).status_code == 403
    assert ops(client, owner, pid, sw) == [403, 403, 403, 403]


def test_a_deleted_or_expired_draft_never_reuses_a_revision(client, monkeypatch):
    """OmegaReview next8 B2: a stale editor's expected_revision cannot match a recreated draft."""
    pid = an_app(client)
    sw = client.post("/api/swarms", json={"name": "Reuse", "visibility": "public"}).json()
    home(monkeypatch, pid, sw["id"])
    ana = person(client, "u_ana5", "admin")
    admit(client, "user:u_ana5", pid, sw["id"])
    url = f"/api/apps/{pid}/drafts/k"
    save = lambda expected, v: client.put(url, json={"swarm_id": sw["id"], "expected_revision": expected, "body": {"v": v}},
                                          headers=ana)
    assert save(None, 1).json()["revision"] == 1
    assert client.delete(f"{url}?swarm_id={sw['id']}", headers=ana).status_code == 200
    assert save(None, 2).json()["revision"] == 2                          # recreated: a fresh number
    stale = save(1, 3)                                                    # the other tab still holds revision 1
    assert stale.status_code == 409 and stale.json()["error"]["current_revision"] == 2
    db = client.app.state.hive.db
    db.execute("UPDATE app_drafts SET saved_at = '2000-01-01T00:00:00Z' WHERE draft_key = 'k' AND principal = 'user:u_ana5'")
    assert save(None, 4).json()["revision"] == 3                          # expired and recreated: still never reused
    assert save(2, 5).status_code == 409
