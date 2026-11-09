"""Personal Ask controls the hive (Jon 2026-10-09: "It needs to control the hive!!").

A turn that speaks as the person's own personal mind keeps its conversation off the host (content-free frames, person-only
reads), but its dispatch and POST /api/ask/{op}/intents work as any turn's: the intent is recorded, the person sends it,
and the receiving swarm gets the work as a normal work item. Synthetic only: temporary data directory, scripted model.
"""
import json
import secrets

from hive.core.config import Provider
from hive.core.db import now
from hive.tests.test_ask_conductor import Script, call, closed, script, tool_results, wait
from hive.tests.test_ask_intents import JON, ORIGIN, a, request_body, submit  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)


def _personal(a, monkeypatch):
    """Conductor on, and Jon's Ask goes to his own personal mind (no page swarm, no default swarm)."""
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive = a.hive
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    hive.db.execute("DELETE FROM ask_prefs WHERE principal = ?", (JON,))
    hive.db.insert("budgets", {"id": "b_u_jon_pc", "scope": "person:u_jon", "period": "month", "limit_usd": 2.0,
                               "note": "", "created_at": now()})
    return hive.personal.ensure(JON)


def _ask(a, op, text, context=None):
    return a.client.post("/api/ask", headers=a.jon, json={"operation_id": op, "text": text, "context": context or {}})


def test_a_personal_turn_dispatches_and_the_target_swarm_receives_the_work(a, monkeypatch):
    mine = _personal(a, monkeypatch)
    hive = a.hive
    title = "Personal hand-off " + secrets.token_hex(4)
    words = "SAYMARK" + secrets.token_hex(6)
    s = script(a.client, Script([call("dispatch", kind="code.request", request=request_body(a, title=title), label="Hand it")],
                                "Handed over."))
    r = _ask(a, "op-pc-dispatch-1", words)
    assert r.status_code == 202, r.text
    assert r.json()["acting_as"]["mind_id"] == mine["id"]
    fs = wait(hive, "op-pc-dispatch-1", closed, principal=JON)
    result = tool_results(s.bodies[1])[0]
    assert result["ok"] is True and result["to"]["ref"] == a.team["id"], result
    intent = hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (result["intent_id"],))
    assert intent["state"] == "pending"
    # the person sends it: the receiving swarm gets the work as a normal work item
    out = submit(a, intent["id"])
    assert out.status_code == 201, out.text
    rq = hive.db.one("SELECT * FROM requests WHERE id = ?", (out.json()["request_id"],))
    assert rq["from_principal"] == JON
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (rq["receiving_goal"],))
    assert goal["swarm_id"] == a.team["id"] and title in json.dumps(goal, default=str)
    # the conversation itself stays content-free on the host
    t = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = 'op-pc-dispatch-1'")
    assert t["personal"] == 1 and t["text"] == "" and t["context_resolved"] == "{}"
    stored = [json.loads(e["frame"]) for e in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (t["id"],))]
    assert stored and all(f.get("personal") for f in stored)
    assert any(f["phase"] == "dispatched" for f in stored) and any(f["phase"] == "intent" for f in stored)
    dumped = json.dumps(stored)
    assert words not in dumped and "Handed over." not in dumped and "Hand it" not in dumped
    assert [f["phase"] for f in fs][-1] == "done"


def test_the_intents_route_accepts_a_personal_turn_and_another_admin_still_reads_no_conversation(a, monkeypatch):
    _personal(a, monkeypatch)
    hive = a.hive
    words, answer = "ASKMARK" + secrets.token_hex(6), "ANSMARK" + secrets.token_hex(6)
    script(a.client, Script(answer))
    r = _ask(a, "op-pc-route-001", words)
    assert r.status_code == 202, r.text
    wait(hive, "op-pc-route-001", closed, principal=JON)
    rec = a.client.post("/api/ask/op-pc-route-001/intents", headers=a.jg,
                        json={"kind": "code.request", "request": request_body(a, title="Route hand-off")})
    assert rec.status_code == 201, rec.text
    out = submit(a, rec.json()["intent_id"])
    assert out.status_code == 201, out.text
    rq = hive.db.one("SELECT * FROM requests WHERE id = ?", (out.json()["request_id"],))
    assert hive.db.one("SELECT swarm_id FROM goals WHERE id = ?", (rq["receiving_goal"],))["swarm_id"] == a.team["id"]
    # Ann, another admin, still reads none of Jon's personal conversation
    t = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = 'op-pc-route-001'")
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (t["thread_id"],))["room_id"]
    for resp in (a.client.get("/api/ask/audit", headers=a.ann), a.client.get(f"/api/ask/audit/{t['id']}", headers=a.ann),
                 a.client.get(f"/api/rooms/{room}/messages", headers=a.ann)):
        assert resp.status_code == 200, resp.text
        assert words not in resp.text and answer not in resp.text
    assert a.client.get(f"/api/rooms/{room}/messages", headers=a.ann).json() == []
