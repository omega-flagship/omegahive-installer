"""App seams (r2.6-r2.10) at L0, offline, on a disposable host with a synthetic program."""
import asyncio
import hashlib
import json

from hive.tests.test_collab import call, held_goal, mind
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

PROGRAM = '''
import asyncio
SEEN, BINDS = [], []
BIND_ACCEPTS_BINDING = True

def describe():
    return {"contract": "0.2", "kinds": [{"id": "n", "role": "other"}], "relations": [],
            "actions": [{"id": "note", "label": "Note", "agents": True, "binding_params": []}]}
def view(ctx, focus=None, stage="unfold"):
    return {"nodes": [], "edges": []}
async def act(ctx, action, items, params):
    return {"status": "done", "detail": {"actor": ctx.actor}}
def offer(ctx, mind):
    return {"actions_offered": ["note"], "channels_offered": []}
def bind(ctx, mind, scope, at_id, *binding):
    BINDS.append(binding)
    return {"actor": "bound-" + at_id}
def unbind(ctx, attachment, at_id):
    return {}
async def validate_finding_target(ctx, rev, target):
    SEEN.append({"actor": ctx.actor["id"], "read_only": ctx.read_only, "keys": sorted(rev), "target": target})
    if target.get("element_id") == "slow":
        await asyncio.sleep(5)
    if target.get("element_id") == "boom":
        raise RuntimeError("private detail")
    if target in ({"scene_id": "sc1", "element_id": "el1"}, {"page_id": "p1"}, {"whole": True}):
        return {"ok": True}
    return {"ok": False, "reason": "no such element"}
async def validate_result(ctx, goal, proposal):
    await asyncio.sleep(0)
    return {"ok": bool(proposal.get("good")), "errors": [] if proposal.get("good") else ["$.good: needed"]}
'''


def install(client, tmp_path, monkeypatch, program=PROGRAM):
    folder = tmp_path / "seamapp"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "seamapp", "name": "Seam", "capabilities": []}))
    (folder / "program.py").write_text(program)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    assert client.post("/api/programs/reload").status_code == 200
    return client.app.state.hive.programs._ready("seamapp")["module"]


def review(client, validate="program:seamapp", kind="scene", tag=""):
    R, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("Owner" + tag, "Reviewers" + tag))
    p, v = mind(client, R, "Maker" + tag), mind(client, V, "Critic" + tag, {"id": "m", "version": "1"})
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    g = held_goal(client, R, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": kind, "title": "deck"}).json()
    call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps({"originals": []}), "parent": None})
    constraints = {"mandates": [{"id": "m", "version": "1"}]}
    if validate:
        constraints["validate"] = validate
    rq = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "r", "from_goal": g["id"],
                                                        "subject": {"artifact_id": art["id"], "revision": 1}, "constraints": constraints}).json()
    assert call(client, v, "POST", f"/api/agent/goals/{rq['receiving_goal']}/claim").status_code == 200
    return rq, v


def finding(client, rq, v, target):
    return call(client, v, "POST", "/api/agent/findings", {"request_id": rq["id"], "mandate": {"id": "m", "version": "1"},
                                                           "target": target, "severity": "note", "recommendation": "look"})


def test_element_page_and_whole_targets_go_through_the_requests_validator(client, tmp_path, monkeypatch):
    module = install(client, tmp_path, monkeypatch)
    rq, v = review(client)
    ok = finding(client, rq, v, {"scene_id": "sc1", "element_id": "el1"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["target"] == {"scene_id": "sc1", "element_id": "el1"}
    assert ok.json()["raised_on"]["revision"] == 1 and ok.json()["raised_on"]["digest"].startswith("sha256:")
    assert finding(client, rq, v, {"page_id": "p1"}).status_code == 200
    assert finding(client, rq, v, {"whole": True}).status_code == 200
    refused = finding(client, rq, v, {"scene_id": "sc1", "element_id": "nope"})
    assert refused.status_code == 400 and "no such element" in refused.json()["error"]["message"]
    last = module.SEEN[-1]
    assert last["actor"] == v["id"] and last["read_only"] is True and last["keys"] == ["artifact_id", "body", "assets", "digest", "revision"] or \
        last["keys"] == sorted(["artifact_id", "body", "assets", "digest", "revision"])
    for bad in ({"scene_id": "sc1"}, {"page_id": "p1", "x": 1}, {"whole": 1}, {"whole": False}, {"step": ""}, "whole", None):
        assert finding(client, rq, v, bad).status_code == 400, bad


def test_without_a_validator_only_whole_is_accepted_and_the_artifact_cannot_choose(client, tmp_path, monkeypatch):
    install(client, tmp_path, monkeypatch)
    rq, v = review(client, validate=None, kind="program:seamapp")   # a kind string never selects a validator
    assert finding(client, rq, v, {"whole": True}).status_code == 200
    for target in ({"page_id": "p1"}, {"scene_id": "sc1", "element_id": "el1"}):
        r = finding(client, rq, v, target)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_target"
    client.post("/api/programs/seamapp/disable")
    rq2, v2 = review(client, tag='2')
    assert finding(client, rq2, v2, {"page_id": "p1"}).status_code == 400   # a disabled program is no validator


def test_a_slow_or_failing_validator_is_unavailable_and_recorded(client, tmp_path, monkeypatch):
    install(client, tmp_path, monkeypatch)
    monkeypatch.setattr("hive.core.programs.FINDING_HOOK_TIMEOUT", 0.2)
    rq, v = review(client)
    for element in ("slow", "boom"):
        r = finding(client, rq, v, {"scene_id": "sc1", "element_id": element})
        assert r.status_code == 503 and r.json()["error"]["code"] == "validator_unavailable"
        assert "private detail" not in r.text
    rows = client.app.state.hive.db.all("SELECT ok, reason FROM finding_target_checks WHERE request_id = ?", (rq["id"],))
    assert [(r["ok"], r["reason"]) for r in rows] == [(0, "validator_unavailable")] * 2
    assert call(client, v, "GET", f"/api/agent/artifacts/{rq['subject']['artifact_id']}/findings").json() == [] \
        or not call(client, v, "GET", f"/api/agent/artifacts/{rq['subject']['artifact_id']}/findings").json().get("findings")


def test_an_async_validate_result_is_awaited(client, tmp_path, monkeypatch):
    install(client, tmp_path, monkeypatch)
    sw = client.post("/api/swarms", json={"name": "W"}).json()
    a = client.post("/api/agents", json={"name": "Worker", "swarm_id": sw["id"]}).json()
    g = client.post(f"/api/swarms/{sw['id']}/goals", json={"title": "t", "binding": {"validate": "program:seamapp"}}).json()
    client.post(f"/api/agent/goals/{g['id']}/claim", headers=agent_headers(a))
    digest = client.get(f"/api/agent/goals/{g['id']}", headers=agent_headers(a)).json()["binding_digest"]
    def send(proposal):
        return client.post(f"/api/agent/goals/{g['id']}/result", headers=agent_headers(a),
                           json={"status": "done", "result": "r", "data": {"binding_digest": digest, "proposal": proposal}})
    refused = send({"good": False})
    assert refused.status_code == 422 and "$.good: needed" in refused.text
    assert send({"good": True}).status_code == 200


def test_a_revision_emits_a_body_free_notice_and_subscription_access_is_per_swarm(client):
    hive = client.app.state.hive
    seen = hive.events.subscribe()
    loop = asyncio.new_event_loop()
    hive.events.bind(loop)
    R = client.post("/api/swarms", json={"name": "Owner"}).json()
    O = client.post("/api/swarms", json={"name": "Other"}).json()
    p = mind(client, R, "Maker")
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "scene", "title": "t"}).json()
    rev = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": "SECRET", "parent": None}).json()
    loop.run_until_complete(asyncio.sleep(0))
    frames = []
    while not seen.empty():
        frames.append(json.loads(seen.get_nowait()))
    notice = [f for f in frames if f["type"] == "artifact.revision"]
    assert len(notice) == 1 and "SECRET" not in json.dumps(notice)
    assert {k: notice[0][k] for k in ("swarm_id", "artifact_id", "revision", "digest")} == \
        {"swarm_id": R["id"], "artifact_id": art["id"], "revision": 1, "digest": rev["digest"]}
    ok = client.get(f"/api/swarms/{R['id']}/artifacts/{art['id']}/subscription")
    assert ok.status_code == 200 and set(ok.json()) == {"artifact_id", "swarm_id"}
    assert client.get(f"/api/swarms/{O['id']}/artifacts/{art['id']}/subscription").status_code == 404
    assert client.get(f"/api/swarms/{R['id']}/artifacts/nope/subscription").status_code == 404
    hive.events.unsubscribe(seen)
    loop.close()


def named_admin(client):
    db = client.app.state.hive.db
    db.insert("people", {"id": "u_fixture", "email": "invented@example.invalid", "name": "Invented admin", "role": "admin", "created_at": "fixture"})
    db.execute("UPDATE sessions SET kind='sso',principal='user:u_fixture' WHERE token_hash=?", (hashlib.sha256(client.operator_token.encode()).hexdigest(),))


BINDING = {"kind": "improvement-package", "id": "pkg1", "version": "1.0.0", "artifact_id": "art_x", "revision": 2, "digest": "sha256:abc"}


def test_attachment_binding_is_stored_hashed_passed_exposed_and_approval_bound(client, tmp_path, monkeypatch):
    module = install(client, tmp_path, monkeypatch)
    swarm, (a, _b) = make_swarm_and_agents(client)
    named_admin(client)
    assert client.post("/api/programs/seamapp/activations", json={"swarm_id": swarm["id"]}).status_code == 200
    data = {"mind_id": a["id"], "actions": ["note"], "channels": [], "policy": {"note": "ask"}, "idempotency_key": "k1"}
    for bad in (dict(BINDING, revision=0), {k: v for k, v in BINDING.items() if k != "digest"}, dict(BINDING, extra=1), dict(BINDING, id="")):
        assert client.post("/api/programs/seamapp/attachments", json=dict(data, binding=bad)).status_code == 400
    made = client.post("/api/programs/seamapp/attachments", json=dict(data, binding=BINDING))
    assert made.status_code == 200, made.text
    assert made.json()["binding"] == BINDING and module.BINDS == [(BINDING,)]
    assert client.post("/api/programs/seamapp/attachments", json=dict(data, binding=BINDING)).json() == made.json()   # same payload: retry
    changed = client.post("/api/programs/seamapp/attachments", json=dict(data, binding=dict(BINDING, revision=3)))
    assert changed.status_code == 409                                                    # the binding is in the payload hash
    pending = client.post("/api/agent/programs/seamapp/act", headers=agent_headers(a),
                          json={"action": "note", "items": [], "params": {}, "idempotency_key": "a1"}).json()
    assert pending["status"] == "approval_required"
    approval = client.get("/api/approvals?status=pending").json()[0]
    assert json.loads(approval["binding"])["attachment_binding"] == BINDING                # approvals bind it
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={})
    done = client.post("/api/agent/programs/seamapp/act", headers=agent_headers(a), json={
        "action": "note", "items": [], "params": {}, "idempotency_key": "a1", "approval_id": pending["approval_id"]}).json()
    assert done["detail"]["actor"]["attachment"]["binding"] == BINDING                    # ctx.actor.attachment.binding


def test_a_hook_that_does_not_opt_in_is_never_handed_a_binding(client, tmp_path, monkeypatch):
    module = install(client, tmp_path, monkeypatch, PROGRAM.replace("BIND_ACCEPTS_BINDING = True", "").replace("def bind(ctx, mind, scope, at_id, *binding):\n    BINDS.append(binding)", "def bind(ctx, mind, scope, at_id):\n    BINDS.append(())"))
    swarm, (a, _b) = make_swarm_and_agents(client)
    named_admin(client)
    client.post("/api/programs/seamapp/activations", json={"swarm_id": swarm["id"]})
    data = {"mind_id": a["id"], "actions": ["note"], "channels": [], "policy": {"note": "allow"}, "idempotency_key": "k1"}
    refused = client.post("/api/programs/seamapp/attachments", json=dict(data, binding=BINDING))
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "binding_unsupported"
    plain = client.post("/api/programs/seamapp/attachments", json=dict(data, idempotency_key="k2"))
    assert plain.status_code == 200 and "binding" not in plain.json() and module.BINDS == [()]


def test_db_after_commit_runs_only_on_durable_outermost_commit(tmp_path):
    """OmegaDesign 2026-10-04: a revision notice escaped a rolled-back publication."""
    from hive.core.db import Database
    db = Database(tmp_path / "x.db")
    fired = []
    with db.transaction():
        db.after_commit(lambda: fired.append("outer"))
        try:
            with db.transaction():                      # savepoint rolls back: its notice is dropped
                db.after_commit(lambda: fired.append("inner-rolled-back"))
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        assert fired == []                               # nothing before the outermost commit
    assert fired == ["outer"]
    try:
        with db.transaction():
            db.after_commit(lambda: fired.append("never"))
            raise RuntimeError("outer boom")
    except RuntimeError:
        pass
    assert fired == ["outer"]
    db.after_commit(lambda: fired.append("now"))         # outside a transaction: immediately
    assert fired == ["outer", "now"]
