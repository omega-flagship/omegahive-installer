"""A completed person request retried with the same intent key is a recovery: no second effect (found by OmegaDesign)."""
import json
import textwrap

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person
from hive.tests.test_program_confirm import confirmed

PROGRAM = textwrap.dedent('''
    def describe():
        return {"contract": "0.2", "kinds": [{"id": "doc", "label": "Doc", "role": "claim"}], "relations": [],
                "actions": [{"id": "save", "label": "Save", "applies_to": ["doc"], "person_activity": True}]}

    def view(ctx, focus, stage):
        return {"revision": "r1", "items": [{"id": "d1", "kind": "doc", "label": "d"}]}

    async def act(ctx, action, items, params):
        if (ctx.actor or {}).get("recovery"):
            return ctx.command["recorded_result"]              # recheck access here, then return the original
        out = ctx.publish("studio-source", "Saved", json.dumps(params))
        return {"status": "done", "detail": {"artifact_id": out["artifact_id"]}}
''')


def test_a_lost_save_retried_returns_the_original_and_publishes_nothing_new(client, tmp_path, monkeypatch):
    folder = tmp_path / "studio"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "studio", "name": "Studio", "capabilities": ["artifacts:read", "artifacts:write"]}))
    (folder / "program.py").write_text("import json\n" + PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    swarm = client.post("/api/swarms", json={"name": "Design", "visibility": "public"}).json()
    jon = person(client, "u_jon", role="admin")
    body = {"swarm_id": swarm["id"], "action": "save", "items": ["d1"], "params": {"text": "hello"}, "idempotency_key": "intent-1"}
    body = confirmed(client, jon, "studio", body)       # the person confirmed it in the host (§9d)
    first = client.post("/api/programs/studio/act", headers=jon, json=body)
    assert first.status_code == 200, first.text
    hive = client.app.state.hive
    before = hive.db.one("SELECT count(*) AS n FROM artifacts")["n"]
    again = client.post("/api/programs/studio/act", headers=jon, json=body)       # the response was lost; the UI retries
    assert again.status_code == 200 and again.json() == first.json()
    assert hive.db.one("SELECT count(*) AS n FROM artifacts")["n"] == before       # no second publication


def test_a4_same_key_replay_by_another_person_is_their_own_intent_never_the_originals(client, tmp_path, monkeypatch):
    """Design A4 (studio-host-seam r1): a same-key replay is bound to the ORIGINAL principal by the existing
    UNIQUE (principal, program, idempotency_key) and the principal-scoped prior lookup in person_act. Another person
    replaying the same key (with or without the original's confirm token) never gets the original's recorded result and
    never changes the original's record: the original's token is refused for them, and with their own confirm it is a
    separate row, delivered and recorded as them. Synthetic people and an invented app only."""
    folder = tmp_path / "studio"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "studio", "name": "Studio", "capabilities": ["artifacts:read", "artifacts:write"]}))
    (folder / "program.py").write_text("import json\n" + PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    swarm = client.post("/api/swarms", json={"name": "Design", "visibility": "public"}).json()
    jon, ana = person(client, "u_jon", role="admin"), person(client, "u_ana", role="admin")
    hive = client.app.state.hive
    plain = {"swarm_id": swarm["id"], "action": "save", "items": ["d1"], "params": {"text": "hello"}, "idempotency_key": "intent-1"}
    jons = confirmed(client, jon, "studio", plain)
    first = client.post("/api/programs/studio/act", headers=jon, json=jons)
    assert first.status_code == 200, first.text
    rows = lambda: hive.db.all("SELECT principal, status, result FROM program_actions WHERE program = 'studio' AND idempotency_key = 'intent-1' ORDER BY principal")  # noqa: E731
    jon_row = rows()
    assert [r["principal"] for r in jon_row] == ["user:u_jon"]
    published = hive.db.one("SELECT count(*) AS n FROM artifacts")["n"]

    # 1. Ana replays Jon's exact body, Jon's spent token included: refused (the token is Jon's principal and session)
    stolen = client.post("/api/programs/studio/act", headers=ana, json=jons)
    assert stolen.status_code == 403 and stolen.json()["error"]["code"] == "confirm_invalid", stolen.text
    assert "artifact_id" not in stolen.text
    # her lookup is scoped to her principal (no prior of Jon's to recover), and the refused token stops it before a row
    assert [(r["principal"], r["status"]) for r in rows()] == [("user:u_jon", "done")]
    assert hive.db.one("SELECT count(*) AS n FROM artifacts")["n"] == published

    # 2. with her own confirm, the same key is HER intent: a separate row and a delivery as her, never Jon's result
    hers = client.post("/api/programs/studio/act", headers=ana, json=confirmed(client, ana, "studio", plain))
    assert hers.status_code == 200, hers.text
    assert hers.json()["detail"]["artifact_id"] != first.json()["detail"]["artifact_id"]
    assert hive.db.one("SELECT count(*) AS n FROM artifacts")["n"] == published + 1
    after = {r["principal"]: r for r in rows()}
    assert set(after) == {"user:u_jon", "user:u_ana"} and after["user:u_ana"]["status"] == "done"
    assert after["user:u_jon"]["result"] == jon_row[0]["result"]          # the original's record is untouched

    # 3. Jon's own same-key retry still recovers Jon's original, unaffected by Ana's intent
    again = client.post("/api/programs/studio/act", headers=jon, json=jons)
    assert again.status_code == 200 and again.json() == first.json()
