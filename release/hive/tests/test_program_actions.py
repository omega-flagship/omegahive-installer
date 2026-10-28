"""Contract 0.2: minds acting in apps. The hive sets who acts; no default allow; exact approvals; idempotent."""
import json
import textwrap

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

PROGRAM = textwrap.dedent('''
    CALLS = []

    def describe():
        return {"contract": "0.2", "kinds": [{"id": "post", "label": "Post", "role": "claim"}], "relations": [],
                "actions": [{"id": "post", "label": "Post", "applies_to": ["post"], "agents": True},
                            {"id": "trade", "label": "Trade", "applies_to": ["post"], "agents": True, "binding_params": ["quote_id", "max_cost"]},
                            {"id": "admin-only", "label": "Admin", "applies_to": ["post"]},
                            {"id": "review-correct", "label": "Correct", "applies_to": ["post"], "agents": True, "approver": "person"}]}

    def view(ctx, focus, stage):
        return {"revision": "r1", "items": [{"id": "p1", "kind": "post", "label": "p"}]}

    async def act(ctx, action, items, params):
        CALLS.append(action)
        return {"status": "done", "detail": {"actor": ctx.actor, "command": ctx.command, "calls": len(CALLS), "params": params}}

    EVENTS = []

    def on_approval(ctx, event):
        EVENTS.append(event)
''')


def setup(client, tmp_path, monkeypatch):
    folder = tmp_path / "social"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "social", "name": "Social", "capabilities": []}))
    (folder / "program.py").write_text(PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    swarm, (a, b) = make_swarm_and_agents(client)
    return swarm, a, b


def act(client, agent, **body):
    return client.post("/api/agent/programs/social/act", headers=agent_headers(agent), json=body)


def test_the_hive_sets_who_acts_and_refuses_identity_in_the_request(client, tmp_path, monkeypatch):
    _, a, _ = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:post", "mode": "allow"})
    for bad in ({"actor": "a_other"}, {"principal": "user:quinn"}, {"swarm_id": "s_x"}):
        r = act(client, a, action="post", items=["p1"], params=bad, idempotency_key="k0")
        assert r.status_code == 400 and r.json()["error"]["code"] == "identity_in_request"
    r = act(client, a, action="post", items=["p1"], params={"text": "hi"}, idempotency_key="k1", actor="a_other")
    assert r.status_code == 400
    done = act(client, a, action="post", items=["p1"], params={"text": "hi"}, idempotency_key="k1").json()
    actor = done["detail"]["actor"]
    assert actor["principal"] == f"agent:{a['id']}" and actor["kind"] == "mind" and actor["swarm_id"] == a["swarm_id"]
    assert actor["approval"] is None and actor["local_operator"] is False


def test_no_default_allow_not_even_a_hive_wide_star(client, tmp_path, monkeypatch):
    _, a, _ = setup(client, tmp_path, monkeypatch)
    r = act(client, a, action="post", items=["p1"], params={}, idempotency_key="k1")
    assert r.status_code == 403 and r.json()["error"]["code"] == "policy_refused"
    client.post("/api/policy", json={"scope": "hive", "skill": "*", "mode": "allow"})
    assert act(client, a, action="post", items=["p1"], params={}, idempotency_key="k2").status_code == 403
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:*", "mode": "allow"})
    r = act(client, a, action="admin-only", items=["p1"], params={}, idempotency_key="k3")
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_for_minds"   # the app never opened it to minds


def test_identical_retry_returns_the_record_and_a_changed_one_is_refused(client, tmp_path, monkeypatch):
    _, a, _ = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:post", "mode": "allow"})
    first = act(client, a, action="post", items=["p1"], params={"text": "hi"}, idempotency_key="k1").json()
    again = act(client, a, action="post", items=["p1"], params={"text": "hi"}, idempotency_key="k1").json()
    assert again == first                                                           # not run twice
    changed = act(client, a, action="post", items=["p1"], params={"text": "bye"}, idempotency_key="k1")
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "idempotency_conflict"
    log = client.get("/api/program-activity", params={"program": "social"}).json()
    assert [(r["action"], r["status"], r["principal"]) for r in log] == [("post", "done", f"agent:{a['id']}")]


def test_ask_files_an_exact_approval_redeemed_once_by_the_hive(client, tmp_path, monkeypatch):
    _, a, b = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:trade", "mode": "ask"})
    body = dict(action="trade", items=["p1"], params={"quote_id": "q1", "max_cost": 5, "note": "x"}, idempotency_key="t1")
    pending = act(client, a, **body).json()
    assert pending["status"] == "approval_required"
    approval = client.get("/api/approvals?status=pending").json()[0]
    assert approval["id"] == pending["approval_id"] and approval["skill"] == "program:social:trade"
    assert act(client, a, **body).json()["approval_id"] == pending["approval_id"]          # no duplicate filing
    early = act(client, a, **body, approval_id=pending["approval_id"])
    assert early.status_code == 409 and early.json()["error"]["code"] == "not_approved"
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={})
    changed = act(client, a, **dict(body, params={"quote_id": "q2", "max_cost": 5, "note": "x"}, idempotency_key="t2"),
                  approval_id=pending["approval_id"])
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "binding_mismatch"
    other = client.post("/api/agent/programs/social/act", headers=agent_headers(b), json=dict(body, approval_id=pending["approval_id"]))
    assert other.status_code in (403, 409)                                           # another mind cannot use it
    done = act(client, a, **body, approval_id=pending["approval_id"]).json()
    assert done["status"] == "done" and done["detail"]["actor"]["approval"]["id"] == pending["approval_id"]
    assert act(client, a, **body, approval_id=pending["approval_id"]).json() == done        # identical retry: the record
    reuse = act(client, a, **dict(body, idempotency_key="t3"), approval_id=pending["approval_id"])
    assert reuse.status_code == 409                                                  # an approval works once


def test_people_act_with_a_person_actor(client, tmp_path, monkeypatch):
    swarm, _, _ = setup(client, tmp_path, monkeypatch)
    out = client.post("/api/programs/social/act", json={"swarm_id": swarm["id"], "action": "post", "items": ["p1"], "params": {}}).json()
    actor = out["detail"]["actor"]
    assert actor["kind"] == "person" and actor["route"] == "operator" and actor["local_operator"] is True
    bad = client.post("/api/programs/social/act", json={"swarm_id": swarm["id"], "action": "post", "items": ["p1"], "params": {"actor": "x"}})
    assert bad.status_code == 400


def test_the_program_receives_the_trusted_command_on_both_routes(client, tmp_path, monkeypatch):
    swarm, a, _ = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:post", "mode": "allow"})
    out = act(client, a, action="post", items=["p1"], params={"t": 1}, idempotency_key="k-7").json()
    command = out["detail"]["command"]
    assert command["idempotency_key"] == "k-7" and command["route"] == "agent" and command["record_id"].startswith("pa_")
    assert command["params_digest"].startswith("sha256:") and "idempotency_key" not in out["detail"]["params"]
    person = client.post("/api/programs/social/act", json={"swarm_id": swarm["id"], "action": "post", "items": ["p1"],
                                                          "params": {}, "idempotency_key": "op-1"}).json()
    assert person["detail"]["command"]["idempotency_key"] == "op-1" and person["detail"]["command"]["route"] == "operator"


def test_person_only_actions_need_a_named_person_and_the_program_hears_decisions(client, tmp_path, monkeypatch):
    swarm, a, _ = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:review-correct", "mode": "ask"})
    body = dict(action="review-correct", items=["p1"], params={"to": 0.4}, idempotency_key="rc1")
    pending = act(client, a, **body).json()
    assert client.post(f"/api/approvals/{pending['approval_id']}/approve", json={"remember": True}).status_code == 400
    client.post(f"/api/approvals/{pending['approval_id']}/approve", json={})
    hive = client.app.state.hive
    events = hive.programs.programs["social"]["module"].EVENTS
    assert events[-1]["approval_id"] == pending["approval_id"] and events[-1]["decision"] == "approved"
    assert events[-1]["decided_by_named_person"] is False and events[-1]["idempotency_key"] == "rc1"
    refused = act(client, a, **body, approval_id=pending["approval_id"])          # the loopback operator approved it
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "person_approval_required"
    hive.db.execute("UPDATE approvals SET decided_by = 'user:u_quinn' WHERE id = ?", (pending["approval_id"],))
    done = act(client, a, **body, approval_id=pending["approval_id"]).json()
    assert done["detail"]["actor"]["approval"]["approved_by"] == "user:u_quinn"
    direct = client.post("/api/programs/social/act", json={"swarm_id": swarm["id"], "action": "review-correct", "items": ["p1"], "params": {}})
    assert direct.status_code == 403 and direct.json()["error"]["code"] == "person_required"


def test_a_drifted_app_does_not_hear_decisions(client, tmp_path, monkeypatch):
    """Kimi next7: on_approval runs program code, so it passes the same integrity gate as every other entry."""
    _, a, _ = setup(client, tmp_path, monkeypatch)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:social:review-correct", "mode": "ask"})
    pending = act(client, a, action="review-correct", items=["p1"], params={}, idempotency_key="rc-drift").json()
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"social": {"release": "/nowhere/release", "digest": "sha256:" + "0" * 64}}))
    events = client.app.state.hive.programs.programs["social"]["module"].EVENTS
    before = len(events)
    assert client.post(f"/api/approvals/{pending['approval_id']}/approve", json={}).status_code == 200
    assert len(events) == before

def test_result_envelopes_pending_and_unknown_receipts_need_no_task():
    from hive.core.programs import validate_result
    fail = lambda m: ValueError(m)
    ok = lambda r: validate_result("p", {}, r, fail)
    import pytest
    assert ok({"status": "started", "receipt": {"state": "unknown", "id": "rc1"}})
    assert ok({"status": "started", "receipt": {"state": "pending", "id": "rc1", "at": "t"}})
    assert ok({"status": "started", "task": {"id": "g_1"}})
    assert ok({"status": "done", "receipt": {"state": "committed", "id": "rc1", "digest": "sha256:x"}})
    for bad in [{"status": "started"}, {"status": "started", "receipt": {"state": "committed", "id": "rc1"}},
                {"status": "done", "receipt": {"state": "unknown", "id": "rc1"}},
                {"status": "done", "receipt": {"state": "refused", "id": "rc1"}},
                {"status": "started", "receipt": {"state": "maybe", "id": "rc1"}},
                {"status": "started", "receipt": {"state": "pending"}}]:
        with pytest.raises(ValueError):
            ok(bad)


def test_apps_hold_their_own_credentials_so_callers_cannot_send_one():
    from hive.core.program_actions import ProgramActions

    class H:
        @staticmethod
        def error(status, code, message):
            return RuntimeError(code)
    for bad in ({"api_key": "x"}, {"token": "x"}, {"Authorization": "x"}, {"db_password": "x"}, {"key": "x"}, {"signing_key": "x"}):
        try:
            ProgramActions.refuse_identity(H, {}, bad)
            raise AssertionError(f"not refused: {bad}")
        except RuntimeError as exc:
            assert str(exc) == "credential_in_request"
    ProgramActions.refuse_identity(H, {"idempotency_key": "k"}, {"forecast": 0.3, "client_key": "c", "keywords": ["a"]})   # allowed
