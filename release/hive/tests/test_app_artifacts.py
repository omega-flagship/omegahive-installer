"""Apps read and publish artifacts as the acting mind, through the real path: a mind calls an app action
(ProgramActions.agent_act gives ctx.actor kind 'mind'), and the app uses ctx.publish / read_revision / read_asset.
Publication is atomic. Persons and minds of another swarm are refused."""
import json
import textwrap

import pytest

from hive.core.programs import ProgramContext
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

PROGRAM = textwrap.dedent('''
    def describe():
        return {"contract": "0.2", "kinds": [{"id": "doc", "label": "Doc", "role": "claim"}], "relations": [],
                "actions": [{"id": "export", "label": "Export", "applies_to": ["doc"], "agents": True},
                            {"id": "peek", "label": "Peek", "applies_to": ["doc"], "agents": True}]}

    def view(ctx, focus, stage):
        return {"revision": "r1", "items": [{"id": "d1", "kind": "doc", "label": "d"}]}

    async def act(ctx, action, items, params):
        if action == "export":
            out = ctx.publish("studio-export", "Export", '{"originals": []}',
                              assets=[{"data": b"<svg/>", "mime": "image/svg+xml", "name": "o.svg"}])
            rev = ctx.read_revision(out["artifact_id"], out["revision"])
            data = ctx.read_asset(out["assets"][0]["sha256"])["data"]
            return {"status": "done", "detail": {"out": out, "rev_digest": rev["digest"], "asset": data.decode()}}
        rev = ctx.read_revision(params["artifact_id"], 1)
        return {"status": "done", "detail": {"digest": rev["digest"]}}
''')


def setup(client, tmp_path, monkeypatch, caps=("artifacts:read", "artifacts:write")):
    folder = tmp_path / "studio"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "studio", "name": "Studio", "capabilities": list(caps)}))
    (folder / "program.py").write_text(PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")


def act(client, agent, action, params=None, key="k"):
    client.post("/api/policy", json={"scope": f"agent:{agent['id']}", "skill": f"program:studio:{action}", "mode": "allow"})
    return client.post("/api/agent/programs/studio/act", headers=agent_headers(agent),
                       json={"action": action, "items": ["d1"], "params": params or {}, "idempotency_key": key})


def test_a_mind_publishes_and_reads_back_through_a_real_app_action(client, tmp_path, monkeypatch):
    setup(client, tmp_path, monkeypatch)
    _, (a, _b) = make_swarm_and_agents(client)
    r = act(client, a, "export")
    assert r.status_code == 200, r.text
    d = r.json()["detail"]
    assert d["out"]["revision"] == 1 and d["rev_digest"] == d["out"]["digest"] and d["asset"] == "<svg/>"
    _, (x, _y) = make_swarm_and_agents(client)                       # a mind of another swarm cannot read it
    r2 = act(client, x, "peek", {"artifact_id": d["out"]["artifact_id"]}, key="k2")
    assert r2.status_code >= 400


def test_without_declared_capabilities_the_app_cannot_publish(client, tmp_path, monkeypatch):
    setup(client, tmp_path, monkeypatch, caps=())
    _, (a, _b) = make_swarm_and_agents(client)
    assert act(client, a, "export").status_code >= 400


def test_a_failed_publication_leaves_nothing_and_an_unidentified_caller_is_refused(client):
    hive = client.app.state.hive
    _, (a, _b) = make_swarm_and_agents(client)
    c = ProgramContext(hive, a["swarm_id"], {"id": "demo", "capabilities": ["artifacts:read", "artifacts:write"]})
    c.actor = {"kind": "mind", "id": a["id"]}
    before = hive.db.one("SELECT count(*) AS n FROM artifacts")["n"]
    with pytest.raises(Exception):
        c.publish("studio-export", "Broken", "")                      # empty body: the revision is refused
    assert hive.db.one("SELECT count(*) AS n FROM artifacts")["n"] == before
    c.actor = None
    with pytest.raises(Exception):
        c.publish("k", "t", "b")                                      # no actor and no viewer: refused
    c.viewer = {"principal": "user:operator", "swarm_id": a["swarm_id"], "kind": "operator"}
    with pytest.raises(Exception):
        c.publish("k", "t", "b")                                      # a viewer may read, never write


def test_a_person_publishes_through_the_real_app_route_under_their_own_name(client, tmp_path, monkeypatch):
    setup(client, tmp_path, monkeypatch)
    swarm, (a, _b) = make_swarm_and_agents(client)
    r = client.post("/api/programs/studio/act", json={"swarm_id": swarm["id"], "action": "export", "items": ["d1"],
                                                       "params": {}, "idempotency_key": "p1"})
    assert r.status_code == 200, r.text
    out = r.json()["detail"]["out"]
    hive = client.app.state.hive
    rev = hive.db.one("SELECT author FROM artifact_revisions WHERE artifact_id = ?", (out["artifact_id"],))
    assert rev["author"] == "user:operator" and r.json()["detail"]["asset"] == "<svg/>"
