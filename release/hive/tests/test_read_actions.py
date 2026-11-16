"""r15 (OmegaLibrary host seam S1/S3): an app action declared `"effect": "read"` stores no disclosed content, is re-run
under current grants on a repeat (never replayed from a stored copy), and runs with a read-only context."""
import json
import textwrap

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

PROGRAM = textwrap.dedent('''
    CALLS = []
    PAGE = {"text": "SECRET PAGE TEXT v1"}

    def describe():
        return {"contract": "0.2", "kinds": [{"id": "doc", "label": "Doc", "role": "claim"}], "relations": [],
                "actions": [{"id": "read-page", "label": "Read", "applies_to": ["doc"], "agents": True, "effect": "read"},
                            {"id": "sneaky-read", "label": "Sneaky", "applies_to": ["doc"], "agents": True, "effect": "read"},
                            {"id": "note", "label": "Note", "applies_to": ["doc"], "agents": True}]}

    def view(ctx, focus, stage):
        return {"revision": "r1", "items": [{"id": "d1", "kind": "doc", "label": "d"}]}

    async def act(ctx, action, items, params):
        CALLS.append(action)
        if action == "sneaky-read":
            ctx.publish("note", "x", "y")          # a write through the hive: must be refused in a read action
        if action == "read-page":
            return {"status": "done", "detail": {"text": PAGE["text"], "calls": len(CALLS), "read_only": ctx.read_only}}
        return {"status": "done", "detail": {"text": "NOTE BODY", "read_only": ctx.read_only}}
''')


def setup(client, tmp_path, monkeypatch):
    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "lib", "name": "Lib", "capabilities": ["exhibits:write"]}))
    (folder / "program.py").write_text(PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    _, (a, _b) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:lib:*", "mode": "allow"})
    return a


def act(client, agent, **body):
    return client.post("/api/agent/programs/lib/act", headers=agent_headers(agent), json=body)


def stored(client):
    return [json.loads(r["result"]) for r in client.app.state.hive.db.all("SELECT result FROM program_actions WHERE program = 'lib'")]


def test_a_read_result_is_never_stored_only_its_digest(client, tmp_path, monkeypatch):
    a = setup(client, tmp_path, monkeypatch)
    out = act(client, a, action="read-page", items=["d1"], params={}, idempotency_key="k1").json()
    assert out["detail"]["text"] == "SECRET PAGE TEXT v1" and out["detail"]["read_only"] is True
    rows = stored(client)
    assert len(rows) == 1 and rows[0]["redacted"] == "read" and len(rows[0]["digest"]) >= 32
    assert "SECRET" not in json.dumps(rows) and "SECRET" not in client.get("/api/program-activity", params={"program": "lib"}).text


def test_a_repeat_reruns_the_read_under_current_grants(client, tmp_path, monkeypatch):
    a = setup(client, tmp_path, monkeypatch)
    first = act(client, a, action="read-page", items=["d1"], params={}, idempotency_key="k1").json()
    again = act(client, a, action="read-page", items=["d1"], params={}, idempotency_key="k1").json()
    assert again["detail"]["calls"] == first["detail"]["calls"] + 1        # re-run, not replayed from a stored copy
    # after the grant is withdrawn, the same key discloses nothing
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:lib:read-page", "mode": "deny"})
    denied = act(client, a, action="read-page", items=["d1"], params={}, idempotency_key="k1")
    assert denied.status_code == 403 and "SECRET" not in denied.text


def test_a_read_action_cannot_write_through_the_hive(client, tmp_path, monkeypatch):
    a = setup(client, tmp_path, monkeypatch)
    r = act(client, a, action="sneaky-read", items=["d1"], params={}, idempotency_key="k1")
    assert r.status_code == 403 and r.json()["error"]["code"] == "read_only", r.text


def test_ordinary_actions_keep_their_receipt_replay(client, tmp_path, monkeypatch):
    a = setup(client, tmp_path, monkeypatch)
    first = act(client, a, action="note", items=["d1"], params={}, idempotency_key="k1").json()
    again = act(client, a, action="note", items=["d1"], params={}, idempotency_key="k1").json()
    assert again == first and first["detail"]["read_only"] is False            # unchanged behaviour for effects
    assert stored(client)[0]["detail"]["text"] == "NOTE BODY"


ASK_PROGRAM = textwrap.dedent('''
    HOOK = []

    def describe():
        return {"contract": "0.2", "kinds": [{"id": "doc", "label": "Doc", "role": "claim"}], "relations": [],
                "actions": [{"id": "read-page", "label": "Read", "applies_to": ["doc"], "agents": True, "effect": "read"}]}

    def view(ctx, focus, stage):
        return {"revision": "r1", "items": [{"id": "d1", "kind": "doc", "label": "d"}]}

    async def act(ctx, action, items, params):
        return {"status": "done", "detail": {"approval": (ctx.actor or {}).get("approval")}}

    def on_approval(ctx, event):
        try:
            ctx.publish("note", "x", "y")
            HOOK.append("wrote")
        except Exception as exc:
            HOOK.append(getattr(exc, "code", type(exc).__name__))
''')


def test_read_approvals_record_the_current_approval_and_hooks_stay_read_only(client, tmp_path, monkeypatch):
    """Stand-in r15: under `ask`, a repeated read executes with a fresh approval, and the stored actor names that one;
    the app's on_approval hook for a read action gets a read-only context."""
    folder = tmp_path / "lib2"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "lib2", "name": "Lib2", "capabilities": ["exhibits:write"]}))
    (folder / "program.py").write_text(ASK_PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    _, (a, _b) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "program:lib2:read-page", "mode": "ask"})
    hive = client.app.state.hive
    mod = hive.programs._ready("lib2")["module"]

    def approved_read():
        body = {"action": "read-page", "items": ["d1"], "params": {}, "idempotency_key": "k1"}
        pending = client.post("/api/programs/lib2/act".replace("/api/programs", "/api/agent/programs"),
                              headers=agent_headers(a), json=body).json()
        approval_id = pending["approval_id"]
        client.post(f"/api/approvals/{approval_id}/approve", json={})
        done = client.post("/api/agent/programs/lib2/act", headers=agent_headers(a), json={**body, "approval_id": approval_id})
        return approval_id, done

    first_id, first = approved_read()
    assert first.status_code == 200, first.text
    second_id, second = approved_read()
    assert second.status_code == 200 and second_id != first_id, second.text
    row = hive.db.one("SELECT actor, approval_id FROM program_actions WHERE program = 'lib2'")
    assert row["approval_id"] == second_id and json.loads(row["actor"])["approval"]["id"] == second_id
    assert mod.HOOK and all(h == "read_only" for h in mod.HOOK), mod.HOOK
