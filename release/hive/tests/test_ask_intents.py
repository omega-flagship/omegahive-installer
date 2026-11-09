"""Linkage r3.6 §(a) (slice 2): an Ask turn's host-owned intents and links, the §G hygiene of their routes, and the
Ask steer route with `via`. Synthetic only: temporary data directories, fake supervisor, mock models, no provider call,
no live hive. A-numbers and G-numbers are the spec's §E rows."""
import asyncio
import json
import logging
import os
import pathlib
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from hive.core import minds as minds_module
from hive.core.app import create_app
from hive.core.ask import MAX_EVENTS
from hive.core.db import now
from hive.core.hive import HiveError
from hive.core.people import SIGNIN_COOKIE
from hive.core.visibility import Viewer
from hive.tests.test_core_api import FakeSupervisor, agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import DIGEST, instruction, later, person, w  # noqa: F401  (fixture)
from hive.tests.test_startup_exclusive import finish, held, release, start

ORIGIN = {"Origin": "http://127.0.0.1:8700"}
JON = "user:u_jon"


@pytest.fixture(autouse=True)
def _origins(monkeypatch):
    monkeypatch.delenv("HIVE_PORT", raising=False)
    monkeypatch.delenv("HIVE_PUBLIC_BASE", raising=False)


@pytest.fixture()
def a(w):
    """The mind-control world plus an Ask coordinator in the origin swarm, awake, so Jon (a named admin) has turns."""
    c = w.client
    w.asker = c.post("/api/agents", json={"name": "Asker", "swarm_id": w.origin["id"]}).json()
    assert c.patch(f"/api/swarms/{w.origin['id']}", json={"coordinator_id": w.asker["id"]}).status_code == 200
    w.hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (w.asker["id"],))
    w.jg, w.ag, w.mg = ({**h, **ORIGIN} for h in (w.jon, w.ann, w.mia))
    return w


def turn(w, op="op-turn-0001", who=None, text="change add() to subtract"):
    r = w.client.post("/api/ask", headers=who or w.jon, json={"operation_id": op, "text": text, "context": {"swarm_id": w.origin["id"]}})
    assert r.status_code == 202, r.text
    return r.json()


def request_body(w, **over):
    body = instruction(w, **over)
    body.pop("operation_id")
    return body


def record(w, op="op-turn-0001", who=None, **over):
    return w.client.post(f"/api/ask/{op}/intents", headers=who or w.jg, json={"kind": "code.request", "request": request_body(w, **over)})


def submit(w, iid, who=None):
    return w.client.post(f"/api/ask/intents/{iid}/submit", headers=who or w.jg)


def row(w, iid):
    return w.hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (iid,))


def counts(hive):
    return {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"]
            for t in ("requests", "goals", "mind_leases", "mind_operations", "ask_intents", "ask_links")}


def submit_direct(w, iid):
    return asyncio.run(w.hive.ask.intents.submit(Viewer(JON, True), iid))


def drain(ws):
    ws.send_json({"type": "ping"})
    frames = []
    for _ in range(500):
        f = ws.receive_json()
        if f.get("type") == "pong":
            return frames
        frames.append(f)
    raise AssertionError("no pong")


def token_of(headers):
    return headers["Authorization"].split(" ", 1)[1]


def held_instruct(w, monkeypatch, before=None, after=None):
    """Holds Minds.instruct at its door (the dispatch is claimed, nothing is created yet) until released."""
    entered, go = threading.Event(), threading.Event()
    original = w.hive.minds.instruct

    async def wrapper(principal, data, bind=None):
        entered.set()
        assert await asyncio.to_thread(go.wait, 10)
        if before:
            before()
        out = await original(principal, data, bind=bind)
        if after:
            after()
        return out
    monkeypatch.setattr(w.hive.minds, "instruct", wrapper)
    return entered, go


# ---- A1-A2: record and submit ------------------------------------------------------------------------------------

def test_A1_admin_turn_record_submit_links_one_request_and_frames_reach_the_asker_only(a):
    c, hive = a.client, a.hive
    t = turn(a)
    before = counts(hive)
    with c.websocket_connect(f"/api/events?token={token_of(a.jon)}") as jon_ws, \
            c.websocket_connect(f"/api/events?token={token_of(a.ann)}") as ann_ws:
        for ws in (jon_ws, ann_ws):
            assert ws.receive_json()["type"] == "hello"
        r = record(a)
        assert r.status_code == 201, r.text
        intent = r.json()
        assert intent["state"] == "pending" and intent["request_operation_id"] == "ask." + intent["intent_id"]
        assert intent["turn_id"] == t["turn_id"] and intent["kind"] == "code.request"
        assert intent["destination"] == {"to_swarm": a.team["id"], "task_id": a.task["id"], "workspace_id": "ws_1",
                                         "repository_id": "synthetic"}
        s = submit(a, intent["intent_id"])
        assert s.status_code == 201, s.text
        jon = [f for f in drain(jon_ws) if f.get("type") == "ask"]
        ann = [f for f in drain(ann_ws) if f.get("type") == "ask"]
    out = s.json()
    assert row(a, intent["intent_id"])["state"] == "linked" and out["state"] == "accepted"
    after = counts(hive)
    assert {k: after[k] - before[k] for k in after} == {"requests": 1, "goals": 1, "mind_leases": 1, "mind_operations": 1,
                                                         "ask_intents": 1, "ask_links": 0}
    rq = hive.db.one("SELECT * FROM requests WHERE id = ?", (out["request_id"],))
    assert rq["idem_key"] == intent["request_operation_id"] and rq["from_principal"] == JON
    op = hive.db.one("SELECT * FROM mind_operations WHERE operation_id = ?", (intent["request_operation_id"],))
    assert op["digest"] == intent["request_digest"] and op["scope"] == JON           # the same digest instruct records
    assert s.content == op["body"].encode()                                         # the recorded 201, byte for byte
    rec = row(a, intent["intent_id"])
    assert (rec["request_id"], rec["lease_id"], rec["receiving_goal"]) == (rq["id"], out["lease_id"], rq["receiving_goal"])
    assert [(f["phase"], f["state"]) for f in jon if f["phase"] == "intent"] == [("intent", "pending"), ("intent", "dispatching"),
                                                                                ("intent", "linked")]
    assert [f["links_rev"] for f in jon if f["phase"] == "intent"] == [1, 2, 3]
    assert ann == []                                                               # another admin: nothing live
    view = c.get(f"/api/ask/{t['operation_id']}", headers=a.jon).json()
    assert view["links_rev"] == 3 and view["links"] == [{"intent_id": intent["intent_id"], "request_id": rq["id"], "state": "linked",
                                                         "to_swarm": a.team["id"], "last_refusal": None}]


def test_A2_the_same_body_twice_is_the_same_intent_and_a_different_body_conflicts(a):
    turn(a)
    first = record(a)
    again = record(a)
    assert (first.status_code, again.status_code) == (201, 200) and again.json()["intent_id"] == first.json()["intent_id"]
    other = record(a, title="Something else")
    assert other.status_code == 409 and other.json()["error"]["code"] == "intent_pending"
    assert other.json()["error"]["intent_id"] == first.json()["intent_id"]
    assert counts(a.hive)["ask_intents"] == 1


# ---- A3-A6: recovery, faults, replay and the clock ---------------------------------------------------------------

def test_A3_a_recorded_intent_survives_a_restart_and_submits_once(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    settings = a.hive.settings                                         # "kill": a new process on the same data directory
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as c2:
        h2 = app.state.hive
        h2.minds.templates = a.hive.minds.templates
        listed = c2.get("/api/ask/intents?state=pending", headers=a.jon).json()["intents"]
        assert [(i["intent_id"], i["last_dispatch"]) for i in listed] == [(iid, None)]
        before = counts(h2)
        r = c2.post(f"/api/ask/intents/{iid}/submit", headers=a.jg)
        assert r.status_code == 201, r.text
        assert counts(h2)["requests"] - before["requests"] == 1


def test_A4_a_fault_in_the_post_commit_announce_still_answers_the_recorded_201(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]

    async def broken(goal):
        raise RuntimeError("announce failed")
    monkeypatch.setattr(a.hive.goals, "announce", broken)
    status, content = submit_direct(a, iid)
    op = a.hive.db.one("SELECT * FROM mind_operations WHERE operation_id = ?", ("ask." + iid,))
    assert status == 201 and content == op["body"].encode()
    assert row(a, iid)["state"] == "linked"


def test_A5_a_dropped_201_resubmitted_is_the_same_bytes_and_one_request(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    first = submit(a, iid)
    before = counts(a.hive)
    again = submit(a, iid)
    assert again.status_code == 201 and again.content == first.content
    assert counts(a.hive) == before


def test_A6_replay_after_until_is_the_original_and_a_first_submit_after_until_is_refused(a, monkeypatch):
    turn(a)
    linked = record(a).json()["intent_id"]
    first = submit(a, linked)
    a.client.post("/api/ask/op-turn-0001/stop", headers=a.jon)
    turn(a, op="op-turn-0002", text="another")
    late = record(a, op="op-turn-0002").json()["intent_id"]
    import datetime
    future = minds_module._utc_now() + datetime.timedelta(hours=3)
    monkeypatch.setattr(minds_module, "_utc_now", lambda: future)
    replay = submit(a, linked)
    assert replay.status_code == 201 and replay.content == first.content
    before = counts(a.hive)
    refused = submit(a, late)
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "bad_request"
    assert row(a, late)["state"] == "refused" and counts(a.hive) == before


# ---- A7-A10: reserved keys, other people, members, smuggled fields -------------------------------------------------

def test_A7_a_direct_request_cannot_spend_an_ask_key(a):
    before = counts(a.hive)
    r = a.client.post("/api/requests", headers=a.jon, json=instruction(a, operation_id="ask.ai_000000000000000000000000"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "operation_reserved"
    assert counts(a.hive) == before


def test_A8_another_person_gets_404_everywhere_nothing_live_and_the_audit_shows_the_link(a):
    c = a.client
    t = turn(a)
    iid = record(a).json()["intent_id"]
    with c.websocket_connect(f"/api/events?token={token_of(a.ann)}") as ann_ws:
        assert ann_ws.receive_json()["type"] == "hello"
        assert record(a, who=a.ag).status_code == 404
        assert submit(a, iid, who=a.ag).status_code == 404
        assert c.post(f"/api/ask/intents/{iid}/abandon", headers=a.ag).status_code == 404
        assert c.get(f"/api/ask/intents/{iid}", headers=a.ann).status_code == 404
        assert c.get(f"/api/ask/{t['operation_id']}/links", headers=a.ann).status_code == 404
        assert c.get("/api/ask/intents", headers=a.ann).json() == {"intents": []}
        assert row(a, iid)["state"] == "pending"
        assert submit(a, iid).status_code == 201                           # Jon's own submit, while Ann listens
        ann = [f for f in drain(ann_ws) if f.get("type") == "ask"]
    assert ann == []
    audit = c.get(f"/api/ask/audit/{t['turn_id']}", headers=a.ann).json()  # Ann is an admin: the audit route
    assert [(x["intent_id"], x["state"]) for x in audit["links"]] == [(iid, "linked")] and audit["links_rev"] == 3


def test_A9_a_members_turn_cannot_record_an_intent(a):
    c = a.client
    c.put(f"/api/swarms/{a.origin['id']}/visibility", json={"visibility": "shared", "shared_with": ["user:u_mia"]})
    c.put(f"/api/agents/{a.asker['id']}/visibility", json={"visibility": "shared", "shared_with": ["user:u_mia"]})
    turn(a, op="op-mia-turn-01", who=a.mia)
    before = counts(a.hive)
    r = record(a, op="op-mia-turn-01", who=a.mg)
    assert r.status_code == 403 and r.json()["error"]["code"] == "person_required"
    assert counts(a.hive) == before


@pytest.mark.parametrize("where,key,value", [
    ("top", "lease_id", "ls_x"), ("top", "confirm_token", "ct_x"), ("top", "principal", "user:u_ann"), ("top", "budget_usd", 1),
    ("request", "lease_id", "ls_x"), ("request", "confirm_token", "ct_x"), ("request", "principal", "user:u_ann"),
    ("request", "budget_usd", 1), ("request", "operation_id", "op-mine-0001")])
def test_A10_smuggled_authority_or_an_operation_id_is_refused_and_nothing_is_stored(a, where, key, value):
    turn(a)
    body = {"kind": "code.request", "request": request_body(a)}
    (body if where == "top" else body["request"])[key] = value
    before = counts(a.hive)
    r = a.client.post("/api/ask/op-turn-0001/intents", headers=a.jg, json=body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
    assert counts(a.hive) == before


# ---- A11-A12: refusals and the atomic link --------------------------------------------------------------------------

@pytest.mark.parametrize("over,status,code", [({"lease": {"template_ids": ["nope"], "max_children": 1}}, 422, "template_unknown"),
                                              ({"budget": {"limit_usd": 5}}, 402, "spend_limit")])
def test_A11_a_refused_submit_creates_nothing_and_a_new_record_is_allowed(a, over, status, code):
    turn(a)
    iid = record(a, **over).json()["intent_id"]
    before = counts(a.hive)
    r = submit(a, iid)
    assert r.status_code == status and r.json()["error"]["code"] == code
    assert counts(a.hive) == before
    rec = row(a, iid)
    assert rec["state"] == "refused" and json.loads(rec["last_refusal"])["code"] == code
    assert json.loads(rec["last_dispatch"])["outcome"] == "refused"
    fresh = record(a)
    assert fresh.status_code == 201 and row(a, iid)["state"] == "abandoned"


def test_A12_a_fault_after_the_link_cas_rolls_back_the_request_and_the_intent(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    from hive.core.ask_intents import Intents
    original = Intents._link

    def faulty(self, intent_id, dispatch_id, recorded):
        original(self, intent_id, dispatch_id, recorded)
        raise RuntimeError("fault after the link CAS")
    monkeypatch.setattr(Intents, "_link", faulty)
    before = counts(a.hive)
    with pytest.raises(RuntimeError):
        submit_direct(a, iid)
    assert counts(a.hive) == before
    rec = row(a, iid)
    assert rec["state"] == "pending" and rec["request_id"] is None
    assert json.loads(rec["last_dispatch"])["outcome"] == "not_committed"


# ---- A13: deletion -----------------------------------------------------------------------------------------------

def test_A13_deleting_a_thread_abandons_pending_keeps_linked_and_never_cancels_the_request(a):
    c, hive = a.client, a.hive
    t = turn(a)
    linked = record(a).json()["intent_id"]
    rq = submit(a, linked).json()["request_id"]
    pending = record(a, title="And another").json()["intent_id"]
    assert c.delete(f"/api/ask/threads/{t['thread']['id']}", headers=a.jon).status_code == 200
    p, l = row(a, pending), row(a, linked)
    assert (p["state"], p["body"]) == ("abandoned", "{}") and p["deleted_at"]
    assert (l["state"], l["body"], l["request_id"]) == ("linked", "{}", rq) and l["request_digest"] and l["deleted_at"]
    assert hive.db.one("SELECT cancelled_at FROM requests WHERE id = ?", (rq,))["cancelled_at"] is None
    assert submit(a, pending).json()["error"]["code"] == "intent_closed"


# ---- A14: links ------------------------------------------------------------------------------------------------------

def test_A14_attach_own_foreign_and_cancelled_requests(a):
    c, hive = a.client, a.hive
    t = turn(a)
    own = c.post("/api/requests", headers=a.jon, json=instruction(a, operation_id="op-direct-0001")).json()["request_id"]
    gone = c.post("/api/requests", headers=a.jon, json=instruction(a, operation_id="op-direct-0002")).json()["request_id"]
    assert c.post(f"/api/requests/{gone}/cancel", headers=a.jon).status_code == 200
    ann_task = asyncio.run(hive.goals.create(a.origin["id"], "Ann's synthetic edit", created_by="user:u_ann"))
    hive.services.grant(ann_task["id"], "user:u_ann", "edit", None, 120, by="user:u_ann")
    foreign = c.post("/api/requests", headers=a.ann, json=instruction(a, operation_id="op-direct-0003",
                     origin={**instruction(a)["origin"], "task_id": ann_task["id"]})).json()["request_id"]
    snapshot = {r: hive.db.one("SELECT * FROM requests WHERE id = ?", (r,)) for r in (own, gone)}
    leases = counts(hive)["mind_leases"]
    first = c.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": own})
    again = c.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": own})
    assert (first.status_code, again.status_code) == (201, 200) and first.json()["state"] == "linked"
    assert c.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": foreign}).status_code == 404
    cancelled = c.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": gone})
    assert cancelled.status_code == 201 and cancelled.json()["state"] == "linked"
    assert {r: hive.db.one("SELECT * FROM requests WHERE id = ?", (r,)) for r in (own, gone)} == snapshot   # nothing changed
    assert counts(hive)["mind_leases"] == leases                                                        # nothing granted
    links = c.get(f"/api/ask/{t['operation_id']}/links", headers=a.jon).json()
    assert [(x["intent_id"], x["request_id"]) for x in links["links"]] == [(None, own), (None, gone)] and links["links_rev"] == 2


# ---- A15-A20: concurrency around the dispatch ------------------------------------------------------------------------

def test_A15_abandon_while_held_in_flight_is_refused_then_it_links_once(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    entered, go = held_instruct(a, monkeypatch)
    before = counts(a.hive)

    async def run():
        task = asyncio.create_task(a.hive.ask.intents.submit(Viewer(JON, True), iid))
        assert await asyncio.to_thread(entered.wait, 10)
        with pytest.raises(HiveError) as refused:
            a.hive.ask.intents.abandon(Viewer(JON, True), iid)
        go.set()
        return refused.value, await task
    try:
        refused, (status, _) = asyncio.run(run())
    finally:
        go.set()
    assert (refused.status, refused.code) == (409, "intent_in_flight") and status == 201
    assert row(a, iid)["state"] == "linked" and counts(a.hive)["requests"] - before["requests"] == 1


def test_A16_two_submits_on_the_event_loop_and_a_worker_thread_dispatch_once(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    entered, go = held_instruct(a, monkeypatch)
    before = counts(a.hive)

    def second():
        try:
            return asyncio.run(a.hive.ask.intents.submit(Viewer(JON, True), iid))
        except HiveError as exc:
            return exc

    async def run():
        task = asyncio.create_task(a.hive.ask.intents.submit(Viewer(JON, True), iid))
        assert await asyncio.to_thread(entered.wait, 10)
        other = await asyncio.to_thread(second)
        go.set()
        return other, await task
    try:
        other, (status, _) = asyncio.run(run())
    finally:
        go.set()
    assert isinstance(other, HiveError) and (other.status, other.code) == (409, "intent_in_flight") and status == 201
    assert counts(a.hive)["requests"] - before["requests"] == 1


def test_A17_a_record_during_the_dispatch_is_refused_then_allowed_with_a_new_key(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    entered, go = held_instruct(a, monkeypatch)
    viewer = Viewer(JON, True)
    body = {"kind": "code.request", "request": request_body(a, title="Second instruction")}

    async def run():
        task = asyncio.create_task(a.hive.ask.intents.submit(viewer, iid))
        assert await asyncio.to_thread(entered.wait, 10)
        with pytest.raises(HiveError) as during:
            a.hive.ask.intents.record(viewer, "op-turn-0001", body)
        go.set()
        await task
        return during.value
    try:
        during = asyncio.run(run())
    finally:
        go.set()
    assert (during.status, during.code) == (409, "intent_in_flight")
    status, view = a.hive.ask.intents.record(viewer, "op-turn-0001", body)
    assert status == 201 and view["intent_id"] != iid and view["request_operation_id"] == "ask." + view["intent_id"]


def test_A18_deletion_during_a_dispatch_that_commits_leaves_it_linked_deleted_and_keyed(a, monkeypatch):
    t = turn(a)
    iid = record(a).json()["intent_id"]
    entered, go = held_instruct(a, monkeypatch)

    async def run():
        task = asyncio.create_task(a.hive.ask.intents.submit(Viewer(JON, True), iid))
        assert await asyncio.to_thread(entered.wait, 10)
        a.hive.ask.delete_thread(Viewer(JON, True), t["thread"]["id"])
        mid = row(a, iid)
        go.set()
        return mid, await task
    try:
        mid, (status, _) = asyncio.run(run())
    finally:
        go.set()
    assert (mid["state"], mid["body"]) == ("dispatching", "{}") and mid["deleted_at"]
    rec = row(a, iid)
    assert status == 201 and rec["state"] == "linked" and rec["deleted_at"] and rec["body"] == "{}"
    assert rec["request_operation_id"] == "ask." + iid and rec["request_id"]


def test_A19_deletion_during_a_dispatch_that_is_refused_abandons_it(a, monkeypatch):
    t = turn(a)
    iid = record(a, lease={"template_ids": ["nope"], "max_children": 1}).json()["intent_id"]
    entered, go = held_instruct(a, monkeypatch)

    async def run():
        task = asyncio.create_task(a.hive.ask.intents.submit(Viewer(JON, True), iid))
        assert await asyncio.to_thread(entered.wait, 10)
        a.hive.ask.delete_thread(Viewer(JON, True), t["thread"]["id"])
        go.set()
        with pytest.raises(HiveError) as refused:
            await task
        return refused.value
    try:
        refused = asyncio.run(run())
    finally:
        go.set()
    assert refused.code == "template_unknown" and row(a, iid)["state"] == "abandoned"
    with pytest.raises(HiveError) as closed:
        submit_direct(a, iid)
    assert (closed.value.status, closed.value.code) == (409, "intent_closed")


def test_A20_a_row_forced_out_of_dispatching_before_bind_creates_nothing(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    original = a.hive.minds.instruct

    async def forced(principal, data, bind=None):
        a.hive.db.execute("UPDATE ask_intents SET state = 'pending' WHERE id = ?", (iid,))
        return await original(principal, data, bind=bind)
    monkeypatch.setattr(a.hive.minds, "instruct", forced)
    before = counts(a.hive)
    with pytest.raises(HiveError) as conflict:
        submit_direct(a, iid)
    assert conflict.value.code == "operation_conflict"
    assert counts(a.hive) == before                                    # no request, goal, lease or operation row


# ---- A21-A22: the §L startup recovery step --------------------------------------------------------------------------

def seed_intents(db_path):
    from hive.core.ask_intents import SCHEMA
    conn = sqlite3.connect(db_path)
    for s in SCHEMA:
        conn.execute(s)
    for iid, state, deleted in (("ai_live", "dispatching", None), ("ai_gone", "dispatching", "2026-10-07T00:00:00.000Z"),
                                ("ai_done", "linked", None)):
        conn.execute("INSERT INTO ask_intents (id, turn_id, principal, kind, request_operation_id, body, request_digest, destination, "
                     "instruction_digest, state, dispatch_id, deleted_at, created_at, updated_at, expires_at) VALUES "
                     "(?, ?, 'user:u_jon', 'code.request', ?, '{}', 'sha256:x', '{}', 'sha256:y', ?, 'ad_1', ?, 'n', 'n', 'n')",
                     (iid, "at_" + iid, "ask." + iid, state, deleted))
    conn.commit()
    conn.close()


def test_A21_A22_main_sweeps_uncommitted_dispatches_once_and_never_a_linked_intent(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    seed_intents(data / "hive.db")
    rc, out, err = finish(start(data, tmp_path))
    assert rc == 0, err
    assert out.count("startup recovery committed: reservations=0, ask_intents=2") == 1 and "SERVING recovered=True" in out
    conn = sqlite3.connect(data / "hive.db")
    got = {r[0]: (r[1], json.loads(r[2])["outcome"] if r[2] else None)
           for r in conn.execute("SELECT id, state, last_dispatch FROM ask_intents")}
    conn.close()
    assert got == {"ai_live": ("pending", "not_committed_restart"), "ai_gone": ("abandoned", "not_committed_restart"),
                   "ai_done": ("linked", None)}


def test_A21_a_claim_killed_before_instruct_is_pending_after_recovery_and_resubmits_with_the_same_key(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    # the S1 claim committed, then the process died before instruct: the row a previous process leaves
    a.hive.db.execute("UPDATE ask_intents SET state = 'dispatching', dispatch_id = 'ad_dead', dispatch_started_at = ? WHERE id = ?",
                      (now(), iid))
    from hive.core import exclusive
    holder = held(a.hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, a.hive)["ask_intents"] == 1
    finally:
        release(holder)
    rec = row(a, iid)
    assert rec["state"] == "pending" and json.loads(rec["last_dispatch"])["outcome"] == "not_committed_restart"
    r = submit(a, iid)
    assert r.status_code == 201
    assert a.hive.db.one("SELECT idem_key FROM requests WHERE id = ?", (r.json()["request_id"],))["idem_key"] == "ask." + iid


def test_A22_a_dispatch_that_committed_is_linked_not_swept_and_replays_its_201(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    first = submit(a, iid)
    from hive.core import exclusive
    holder = held(a.hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, a.hive)["ask_intents"] == 0
    finally:
        release(holder)
    assert row(a, iid)["state"] == "linked"
    assert submit(a, iid).content == first.content


# ---- A23-A25: settle by row state, the integrity audit, the frame quota ----------------------------------------------

def test_A23_a_4xx_raised_after_the_commit_is_answered_by_the_record(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]
    original = a.hive.minds.instruct

    async def late_refusal(principal, data, bind=None):
        await original(principal, data, bind=bind)
        raise HiveError(409, "operation_conflict", "a refusal after the commit")
    monkeypatch.setattr(a.hive.minds, "instruct", late_refusal)
    status, content = submit_direct(a, iid)
    assert status == 201 and json.loads(content)["state"] == "accepted" and row(a, iid)["state"] == "linked"


def test_A24_a_planted_operation_row_for_an_unlinked_key_is_a_logged_conflict_and_changes_nothing(a, caplog):
    turn(a)
    iid = record(a).json()["intent_id"]
    a.hive.db.execute("INSERT INTO mind_operations VALUES (?, ?, ?, 201, '{}', ?)", (JON, "ask." + iid, row(a, iid)["request_digest"], now()))
    before, rec = counts(a.hive), row(a, iid)
    with caplog.at_level(logging.ERROR, logger="hive"):
        r = submit(a, iid)
        ab = a.client.post(f"/api/ask/intents/{iid}/abandon", headers=a.jg)
    assert r.status_code == 409 and r.json()["error"]["code"] == "operation_conflict"
    assert ab.status_code == 409 and ab.json()["error"]["code"] == "operation_conflict"
    assert counts(a.hive) == before and row(a, iid) == rec
    assert any("does not match its operation record" in m for m in caplog.messages)


def test_A25_with_the_frame_quota_spent_intent_frames_drop_answer_and_done_stay_and_the_view_is_final(a):
    hive = a.hive
    t = turn(a)
    hive.db.execute("UPDATE ask_turns SET next_seq = ? WHERE id = ?", (MAX_EVENTS - 1, t["turn_id"]))
    revs = []
    iid = record(a).json()["intent_id"]
    revs.append(hive.db.one("SELECT links_rev FROM ask_turns WHERE id = ?", (t["turn_id"],))["links_rev"])
    assert submit(a, iid).status_code == 201
    revs.append(hive.db.one("SELECT links_rev FROM ask_turns WHERE id = ?", (t["turn_id"],))["links_rev"])
    hive.record_agent_message(a.asker["id"], {"text": "Sent to the Code team.", "conversation_id": f"ask:{t['turn_id']}"})
    view = a.client.get(f"/api/ask/{t['operation_id']}", headers=a.jon).json()
    phases = [e["phase"] for e in view["events"]]
    assert "intent" not in phases and phases[-2:] == ["answer", "done"]
    assert revs == [1, 3] and view["links_rev"] == 3
    assert view["links"] == [{"intent_id": iid, "request_id": row(a, iid)["request_id"], "state": "linked", "to_swarm": a.team["id"],
                              "last_refusal": None}]


# ---- §G hygiene on every new person route ------------------------------------------------------------------------------

def g_routes(a, iid):
    return [("post", "/api/ask/op-turn-0001/intents", {"kind": "code.request", "request": request_body(a)}),
            ("post", f"/api/ask/intents/{iid}/submit", None), ("post", f"/api/ask/intents/{iid}/abandon", None),
            ("post", "/api/ask/op-turn-0001/links", {"request_id": "rq_x"})]


def test_G1_missing_or_foreign_origin_is_refused_before_anything_is_written(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    before, rec = counts(a.hive), row(a, iid)
    for method, path, body in g_routes(a, iid):
        missing = a.client.request(method, path, headers=a.jon, json=body)
        foreign = a.client.request(method, path, headers={**a.jon, "Origin": "https://evil.example"}, json=body)
        assert (missing.status_code, missing.json()["error"]["code"]) == (403, "origin_required"), path
        assert (foreign.status_code, foreign.json()["error"]["code"]) == (403, "origin_refused"), path
    assert counts(a.hive) == before and row(a, iid) == rec


def test_G1_the_public_base_origin_is_allowed(a, monkeypatch):
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example.test/omegadot")
    turn(a)
    app = create_app(a.hive.settings, supervisor=FakeSupervisor(), reconcile_seconds=0)   # the set is fixed at build
    with TestClient(app) as c2:
        app.state.hive.minds.templates = a.hive.minds.templates
        r = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "https://hive.example.test"},
                    json={"kind": "code.request", "request": request_body(a)})
    assert r.status_code == 201, r.text


def test_G2_query_token_or_cookie_alone_is_unauthorized(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    token = token_of(a.jon)
    anonymous = TestClient(a.client.app)                         # no operator header
    for method, path, body in g_routes(a, iid) + [("get", "/api/ask/intents", None), ("get", f"/api/ask/intents/{iid}", None)]:
        q = anonymous.request(method, path + ("&" if "?" in path else "?") + f"token={token}", headers=ORIGIN, json=body)
        anonymous.cookies.set(SIGNIN_COOKIE, token)
        k = anonymous.request(method, path, headers=ORIGIN, json=body)
        anonymous.cookies.clear()
        assert (q.status_code, k.status_code) == (401, 401), path


def test_G3_content_type_and_body_caps(a):
    turn(a)
    iid = record(a).json()["intent_id"]
    plain = a.client.post("/api/ask/op-turn-0001/intents", headers={**a.jg, "Content-Type": "text/plain"},
                          content=json.dumps({"kind": "code.request", "request": request_body(a)}))
    assert plain.status_code == 415 and plain.json()["error"]["code"] == "bad_content_type"
    big = {"kind": "code.request", "request": request_body(a, instruction="x" * (49 * 1024))}
    over = a.client.post("/api/ask/op-turn-0001/intents", headers=a.jg, json=big)
    assert over.status_code == 413 and over.json()["error"]["code"] == "request_too_large"
    small = a.client.post("/api/ask/op-turn-0001/links", headers=a.jg, json={"request_id": "r" * 2000})
    assert small.status_code == 413
    body = a.client.post(f"/api/ask/intents/{iid}/submit", headers=a.jg, json={"anything": 1})
    assert body.status_code == 400 and row(a, iid)["state"] == "pending"


# ---- the steer route, with via ---------------------------------------------------------------------------------------

@pytest.fixture()
def s(client):
    from hive.tests.test_ask import world
    return world(client)


def steer(client, headers, op, steer_id="st_abcdef01", text="only the research swarm", at_seq=1, **extra):
    return client.post(f"/api/ask/{op}/steer", headers=headers, json={"steer_id": steer_id, "text": text, "at_seq": at_seq, **extra})


def ask_turn(client, s, op="op-steer-0001"):
    r = client.post("/api/ask", headers=s["ann"], json={"operation_id": op, "text": "find the notes", "context": {"swarm_id": s["swarm"]["id"]}})
    assert r.status_code == 202, r.text
    return r.json()


def test_a_steer_joins_the_open_turn_records_via_and_reaches_the_coordinator(client, s):
    hive = s["hive"]
    t = ask_turn(client, s)
    r = steer(client, s["ann"], t["operation_id"], via="voice")
    assert r.status_code == 202, r.text
    out = r.json()
    assert out == {"steer_id": "st_abcdef01", "operation_id": t["operation_id"], "turn_id": t["turn_id"], "new_turn": False,
                   "seq": 2, "via": "voice"}
    frame = client.get(f"/api/ask/{t['operation_id']}", headers=s["ann"]).json()["events"][-1]
    assert (frame["phase"], frame["via"], frame["text"], frame["at_seq"]) == ("steer", "voice", "only the research swarm", 1)
    rec = hive.db.one("SELECT * FROM ask_steers WHERE steer_id = 'st_abcdef01'")
    assert (rec["via"], rec["turn_id"], rec["principal"]) == ("voice", t["turn_id"], "user:u_ann")
    msg = hive.db.one("SELECT * FROM messages WHERE id = ?", (rec["delivery_message_id"],))
    assert msg["conversation_id"] == f"ask:{t['turn_id']}" and msg["agent_id"] == s["coord"]["id"]
    assert json.loads(msg["extra"])["ask"]["steer"] == {"steer_id": "st_abcdef01", "at_seq": 1, "via": "voice"}
    assert hive.db.one("SELECT COUNT(*) AS n FROM ask_turns")["n"] == 1        # no new turn
    again = steer(client, s["ann"], t["operation_id"], via="voice")
    assert again.status_code == 202 and again.json() == out and hive.db.one("SELECT COUNT(*) AS n FROM ask_steers")["n"] == 1
    other = steer(client, s["ann"], t["operation_id"], text="something else", via="voice")
    assert other.status_code == 409 and other.json()["error"]["code"] == "operation_conflict"


def test_a_steer_without_via_is_typed(client, s):
    t = ask_turn(client, s)
    assert steer(client, s["ann"], t["operation_id"]).json()["via"] == "typed"
    assert s["hive"].db.one("SELECT via FROM ask_steers")["via"] == "typed"


@pytest.mark.parametrize("via", ["keyboard", "VOICE", "", 1, None, True])
def test_a_steer_with_any_other_via_is_refused_and_nothing_is_written(client, s, via):
    hive = s["hive"]
    t = ask_turn(client, s)
    before = {k: hive.db.one(f"SELECT COUNT(*) AS n FROM {k}")["n"] for k in ("ask_steers", "ask_events", "messages", "room_messages")}
    r = steer(client, s["ann"], t["operation_id"], via=via)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"
    assert {k: hive.db.one(f"SELECT COUNT(*) AS n FROM {k}")["n"] for k in before} == before


def test_a_steer_on_a_closed_turn_starts_a_fresh_turn_with_its_via(client, s):
    t = ask_turn(client, s)
    client.post(f"/api/ask/{t['operation_id']}/stop", headers=s["ann"])
    r = steer(client, s["ann"], t["operation_id"], steer_id="st_closed01", via="voice")
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["new_turn"] is True and out["operation_id"] == "steer:st_closed01" and out["turn_id"] != t["turn_id"]
    fresh = client.get("/api/ask/steer:st_closed01", headers=s["ann"]).json()
    assert fresh["via"] == "voice" and fresh["text"] == "only the research swarm" and fresh["state"] == "accepted"
    again = steer(client, s["ann"], t["operation_id"], steer_id="st_closed01", via="voice")
    assert again.json()["turn_id"] == out["turn_id"]                       # idempotent: the same fresh turn


def test_steers_are_capped_per_turn_and_bound_to_the_asker(client, s):
    t = ask_turn(client, s)
    from hive.core.ask import MAX_STEERS
    for i in range(MAX_STEERS):
        assert steer(client, s["ann"], t["operation_id"], steer_id=f"st_cap{i:04d}").status_code == 202
    over = steer(client, s["ann"], t["operation_id"], steer_id="st_cap9999")
    assert over.status_code == 429 and over.json()["error"]["code"] == "rate_limited"
    assert steer(client, s["jon"], t["operation_id"], steer_id="st_jon00001").status_code == 404


# ---- FIX-FIRST regressions (stand-in verdict on 1b7aca8) -----------------------------------------------------------

def test_fix1_submit_replay_is_the_recorded_201_exactly_across_links_rev_and_deletion(a):
    t = turn(a)
    iid = record(a).json()["intent_id"]
    first = submit(a, iid)
    op = a.hive.db.one("SELECT * FROM mind_operations WHERE operation_id = ?", ("ask." + iid,))
    assert first.status_code == op["status"] == 201 and first.content == op["body"].encode()   # the record, nothing else
    assert record(a, title="Next instruction").status_code == 201                          # links_rev advances
    assert submit(a, iid).content == first.content
    assert a.client.delete(f"/api/ask/threads/{t['thread']['id']}", headers=a.jon).status_code == 200
    again = submit(a, iid)
    assert again.status_code == 201 and again.content == first.content
    assert a.client.get(f"/api/ask/intents/{iid}", headers=a.jon).json()["state"] == "linked"   # metadata: the reads


def test_fix2_steers_share_the_frame_quota_and_answer_done_stay_within_it(client, s):
    hive = s["hive"]
    t = ask_turn(client, s)
    hive.db.execute("UPDATE ask_turns SET next_seq = ? WHERE id = ?", (MAX_EVENTS - 1, t["turn_id"]))
    one = steer(client, s["ann"], t["operation_id"], steer_id="st_quota001", text="first", at_seq=1)
    two = steer(client, s["ann"], t["operation_id"], steer_id="st_quota002", text="second", at_seq=1)
    assert (one.status_code, two.status_code) == (202, 202) and one.json()["seq"] is None and two.json()["seq"] is None
    assert steer(client, s["ann"], t["operation_id"], steer_id="st_quota001", text="first", at_seq=1).json() == one.json()
    rows = hive.db.all("SELECT * FROM ask_steers WHERE turn_id = ? ORDER BY steer_id", (t["turn_id"],))
    msgs = [hive.db.one("SELECT text, conversation_id FROM messages WHERE id = ?", (r["delivery_message_id"],)) for r in rows]
    assert [m["text"] for m in msgs] == ["first", "second"] and {m["conversation_id"] for m in msgs} == {f"ask:{t['turn_id']}"}
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (t["thread"]["id"],))["room_id"]
    assert {"first", "second"} <= {m["text"] for m in hive.db.all("SELECT text FROM room_messages WHERE room_id = ?", (room,))}
    hive.record_agent_message(s["coord"]["id"], {"text": "Done.", "conversation_id": f"ask:{t['turn_id']}"})
    events = client.get(f"/api/ask/{t['operation_id']}", headers=s["ann"]).json()["events"]
    assert [e["phase"] for e in events][-2:] == ["answer", "done"] and max(e["seq"] for e in events) <= MAX_EVENTS


def test_fix3_a_closed_turn_steer_is_bound_to_its_source_turn_and_full_body(client, s):
    a1 = ask_turn(client, s, op="op-steer-a001")
    client.post("/api/ask/op-steer-a001/stop", headers=s["ann"])
    first = steer(client, s["ann"], "op-steer-a001", steer_id="st_bound001", at_seq=1, via="voice")
    assert first.status_code == 202 and first.json()["new_turn"] is True
    assert steer(client, s["ann"], "op-steer-a001", steer_id="st_bound001", at_seq=1, via="voice").json() == first.json()
    client.post(f"/api/ask/{first.json()['operation_id']}/stop", headers=s["ann"])
    ask_turn(client, s, op="op-steer-b001")
    client.post("/api/ask/op-steer-b001/stop", headers=s["ann"])
    for op, over in (("op-steer-b001", {}), ("op-steer-a001", {"at_seq": 2}), ("op-steer-a001", {"via": "typed"}),
                     ("op-steer-a001", {"text": "other words"})):
        body = {"steer_id": "st_bound001", "at_seq": 1, "via": "voice", **over}
        r = client.post(f"/api/ask/{op}/steer", headers=s["ann"], json={"text": "only the research swarm", **body})
        assert r.status_code == 409 and r.json()["error"]["code"] == "operation_conflict", (op, over, r.text)
    assert a1["turn_id"] != first.json()["turn_id"]


def test_fix4_reads_audit_every_intent_and_change_nothing(a):
    t = turn(a)
    iid = record(a).json()["intent_id"]
    a.hive.db.execute("INSERT INTO mind_operations VALUES (?, ?, ?, 201, '{}', ?)", (JON, "ask." + iid, row(a, iid)["request_digest"], now()))
    rec = row(a, iid)
    for path in (f"/api/ask/intents/{iid}", "/api/ask/intents", f"/api/ask/{t['operation_id']}/links"):
        r = a.client.get(path, headers=a.jon)
        assert r.status_code == 409 and r.json()["error"]["code"] == "operation_conflict", path
    same = record(a)                                                    # the same body as the inconsistent pending intent
    assert same.status_code == 409 and same.json()["error"]["code"] == "operation_conflict"
    assert row(a, iid) == rec


def test_fix4_a_refused_predecessor_is_audited_before_it_is_abandoned(a):
    turn(a)
    iid = record(a, lease={"template_ids": ["nope"], "max_children": 1}).json()["intent_id"]
    assert submit(a, iid).status_code == 422 and row(a, iid)["state"] == "refused"
    a.hive.db.execute("INSERT INTO mind_operations VALUES (?, ?, ?, 201, '{}', ?)", (JON, "ask." + iid, row(a, iid)["request_digest"], now()))
    before, rec = counts(a.hive), row(a, iid)
    r = record(a)
    assert r.status_code == 409 and r.json()["error"]["code"] == "operation_conflict"
    assert counts(a.hive) == before and row(a, iid) == rec


# ---- Kimi FIX-FIRST regressions (verdict on 1b7aca8) ---------------------------------------------------------------

def test_kimi1_a_raced_409_from_instruct_relinks_from_the_winners_record_never_refused(a, monkeypatch):
    """Forced interleaving at instruct's boundary: this dispatch's insert loses to a winner whose record was not yet
    visible (instruct's _raced raises 409 operation_conflict), and the winner, a bind-less instruct, commits just
    after. The loser must not settle refused: it re-reads the record and links."""
    turn(a)
    iid = record(a).json()["intent_id"]
    original = a.hive.minds.instruct

    async def raced(principal, data, bind=None):
        await original(principal, data)               # the winner commits without a link
        raise HiveError(409, "operation_conflict", "the same operation_id was used concurrently; retry to read the answer")
    monkeypatch.setattr(a.hive.minds, "instruct", raced)
    status, content = submit_direct(a, iid)
    op = a.hive.db.one("SELECT * FROM mind_operations WHERE operation_id = ?", ("ask." + iid,))
    rec = row(a, iid)
    assert status == 201 and content == op["body"].encode()
    assert rec["state"] == "linked" and rec["request_id"] == json.loads(op["body"])["request_id"]
    assert a.client.get(f"/api/ask/intents/{iid}", headers=a.jon).status_code == 200      # the audit agrees


def test_kimi1_a_raced_409_with_no_record_returns_to_pending_not_refused(a, monkeypatch):
    turn(a)
    iid = record(a).json()["intent_id"]

    async def raced(principal, data, bind=None):
        raise HiveError(409, "operation_conflict", "the same operation_id was used concurrently; retry to read the answer")
    monkeypatch.setattr(a.hive.minds, "instruct", raced)
    with pytest.raises(HiveError):
        submit_direct(a, iid)
    rec = row(a, iid)
    assert rec["state"] == "pending" and json.loads(rec["last_dispatch"])["outcome"] == "not_committed" and rec["last_refusal"] is None


def test_kimi2_a_closed_turn_steer_replays_after_its_turn_is_deleted(client, s):
    t = ask_turn(client, s, op="op-steer-d001")
    client.post("/api/ask/op-steer-d001/stop", headers=s["ann"])
    first = steer(client, s["ann"], "op-steer-d001", steer_id="st_durable1", via="voice")
    assert first.status_code == 202 and first.json()["new_turn"] is True
    row_ = s["hive"].db.one("SELECT * FROM ask_steers WHERE steer_id = 'st_durable1'")
    assert (row_["outcome"], row_["turn_id"]) == ("new_turn", t["turn_id"])           # durable before the fresh turn
    assert client.delete(f"/api/ask/threads/{t['thread']['id']}", headers=s["ann"]).status_code == 200
    turns = s["hive"].db.one("SELECT COUNT(*) AS n FROM ask_turns")["n"]
    again = steer(client, s["ann"], "op-steer-d001", steer_id="st_durable1", via="voice")
    assert again.status_code == 202 and again.json()["turn_id"] == first.json()["turn_id"]
    assert again.json()["operation_id"] == first.json()["operation_id"] and s["hive"].db.one("SELECT COUNT(*) AS n FROM ask_turns")["n"] == turns
    other = steer(client, s["ann"], "op-steer-d001", steer_id="st_durable1", via="typed")
    assert other.status_code == 409 and other.json()["error"]["code"] == "operation_conflict"


def test_kimi3_origin_is_checked_before_any_session_lookup(a, monkeypatch):
    turn(a)
    seen = []
    from hive.core import app as appmod
    original = appmod.token_hash
    monkeypatch.setattr(appmod, "token_hash", lambda t: (seen.append(t), original(t))[1])
    body = {"kind": "code.request", "request": request_body(a)}
    foreign = a.client.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "https://evil.example"}, json=body)
    anonymous = a.client.post("/api/ask/op-turn-0001/intents", headers={"Authorization": "Bearer nope", "Origin": "https://evil.example"}, json=body)
    assert (foreign.status_code, foreign.json()["error"]["code"]) == (403, "origin_refused")
    assert (anonymous.status_code, anonymous.json()["error"]["code"]) == (403, "origin_refused")
    assert seen == []                                                   # the session store was never consulted


def test_kimi3_an_unparseable_public_base_fails_the_build(a, monkeypatch):
    for bad in ("hive.example.com", "ftp://hive.example", "https://", "not a url"):
        monkeypatch.setenv("HIVE_PUBLIC_BASE", bad)
        with pytest.raises(RuntimeError, match="HIVE_PUBLIC_BASE"):
            create_app(a.hive.settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


def test_kimi3_the_allowed_origins_are_fixed_when_the_app_is_built(a, monkeypatch):
    turn(a)
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://late.example")       # after the build: no effect
    r = record(a, who={**a.jon, "Origin": "https://late.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "origin_refused"


def test_kimi4_an_intents_lifetime_is_clamped_to_its_turns_24_hours(a):
    import datetime
    t = turn(a)
    created = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=23)
    a.hive.db.execute("UPDATE ask_turns SET created_at = ? WHERE id = ?",
                      (created.isoformat(timespec="milliseconds").replace("+00:00", "Z"), t["turn_id"]))
    r = record(a, lifetime={"until": later(hours=2)})
    assert r.status_code == 201, r.text
    until = datetime.datetime.fromisoformat(r.json()["until"].replace("Z", "+00:00"))
    assert abs((until - (created + datetime.timedelta(hours=24))).total_seconds()) < 1
    assert row(a, r.json()["intent_id"])["expires_at"] == r.json()["until"]
    assert record(a, lifetime={"until": later(hours=2)}).status_code == 200        # the same request is the same intent
    a.hive.db.execute("UPDATE ask_turns SET created_at = ? WHERE id = ?",
                      ((created - datetime.timedelta(hours=1, minutes=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z"), t["turn_id"]))
    assert record(a, title="Too late").status_code == 400


def team_turn(a, op="op-team-turn-1"):
    a.hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (a.ctl["id"],))
    r = a.client.post("/api/ask", headers=a.jon, json={"operation_id": op, "text": "link my request", "context": {"swarm_id": a.team["id"]}})
    assert r.status_code == 202, r.text
    return r.json()


def test_kimi5_a_direct_link_has_its_own_link_frame(a):
    t = team_turn(a)
    rq = a.client.post("/api/requests", headers=a.jon, json=instruction(a, operation_id="op-direct-0101")).json()["request_id"]
    assert a.client.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": rq}).status_code == 201
    frames = [e for e in a.client.get(f"/api/ask/{t['operation_id']}", headers=a.jon).json()["events"] if e["phase"] in ("intent", "link")]
    assert [(f["phase"], f["request_id"], f["links_rev"]) for f in frames] == [("link", rq, 1)]
    assert "intent_id" not in frames[0]


def test_followup1_a_cross_swarm_link_succeeds_grants_nothing_and_names_its_to_swarm(a):
    t = turn(a)                                                         # the origin swarm's turn
    assert t["thread"]["mind"]["id"] == a.asker["id"] and a.asker["swarm_id"] == a.origin["id"]
    rq = a.client.post("/api/requests", headers=a.jon, json=instruction(a, operation_id="op-direct-0201")).json()["request_id"]
    snapshot, leases = a.hive.db.one("SELECT * FROM requests WHERE id = ?", (rq,)), counts(a.hive)["mind_leases"]
    r = a.client.post(f"/api/ask/{t['operation_id']}/links", headers=a.jg, json={"request_id": rq})
    assert r.status_code == 201, r.text
    assert (r.json()["to_swarm"], r.json()["state"]) == (a.team["id"], "linked") and a.team["id"] != a.origin["id"]
    assert a.hive.db.one("SELECT * FROM requests WHERE id = ?", (rq,)) == snapshot and counts(a.hive)["mind_leases"] == leases
    a.client.post("/api/ask/op-turn-0001/stop", headers=a.jon)
    iid = record(a).json()["intent_id"]
    links = a.client.get(f"/api/ask/{t['operation_id']}/links", headers=a.jon).json()["links"]
    assert {(x["intent_id"], x["request_id"], x["to_swarm"]) for x in links} == {(None, rq, a.team["id"]), (iid, None, a.team["id"])}
    audit = a.client.get(f"/api/ask/audit/{t['turn_id']}", headers=a.ann).json()["links"]
    assert {x["to_swarm"] for x in audit} == {a.team["id"]}


def origin_client(a, monkeypatch, public_url, base=None, port=None):
    import dataclasses
    for k, v in (("HIVE_PUBLIC_BASE", base), ("HIVE_PORT", port)):
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    app = create_app(dataclasses.replace(a.hive.settings, public_url=public_url), supervisor=FakeSupervisor(), reconcile_seconds=0)
    app.state.hive.minds.templates = a.hive.minds.templates
    return TestClient(app)


def test_followup2_the_cloud_shaped_env_accepts_its_tunnel_origin(a, monkeypatch):
    turn(a)
    body = {"kind": "code.request", "request": request_body(a)}
    with origin_client(a, monkeypatch, "http://127.0.0.1:8710", port="8700") as c2:
        ok = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "http://127.0.0.1:8710"}, json=body)
        bad = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "http://127.0.0.1:9999"}, json=body)
        loop = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "http://localhost:8700"}, json=body)
    assert ok.status_code == 201, ok.text
    assert (bad.status_code, bad.json()["error"]["code"]) == (403, "origin_refused")
    assert loop.status_code == 200                                      # loopback on HIVE_PORT still allowed (same body)


def test_followup2_the_mac_shaped_env_accepts_the_https_base_origin(a, monkeypatch):
    turn(a)
    body = {"kind": "code.request", "request": request_body(a)}
    with origin_client(a, monkeypatch, "http://127.0.0.1:8700", base="https://hive.example.test/omegadot") as c2:
        ok = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "https://hive.example.test"}, json=body)
        local = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "http://127.0.0.1:8700"}, json=body)
        bad = c2.post("/api/ask/op-turn-0001/intents", headers={**a.jon, "Origin": "https://evil.example"}, json=body)
    assert (ok.status_code, local.status_code) == (201, 200), ok.text
    assert bad.json()["error"]["code"] == "origin_refused"


def test_followup2_an_unparseable_public_url_fails_the_build(a, monkeypatch):
    import dataclasses
    monkeypatch.delenv("HIVE_PUBLIC_BASE", raising=False)
    for bad in ("127.0.0.1:8710", "ftp://hive.example", "http://", "not a url"):
        with pytest.raises(RuntimeError, match="HIVE_PUBLIC_URL"):
            create_app(dataclasses.replace(a.hive.settings, public_url=bad), supervisor=FakeSupervisor(), reconcile_seconds=0)


# ---- stand-in FIX-FIRST on 5c12cd9 ---------------------------------------------------------------------------------

def test_standin1_turn_and_audit_reads_audit_every_intent_in_links(a):
    t = turn(a)
    iid = record(a).json()["intent_id"]
    a.hive.db.execute("INSERT INTO mind_operations VALUES (?, ?, ?, 201, '{}', ?)", (JON, "ask." + iid, row(a, iid)["request_digest"], now()))
    rec = row(a, iid)
    own = a.client.get(f"/api/ask/{t['operation_id']}", headers=a.jon)
    audit = a.client.get(f"/api/ask/audit/{t['turn_id']}", headers=a.ann)
    assert (own.status_code, own.json()["error"]["code"]) == (409, "operation_conflict")
    assert (audit.status_code, audit.json()["error"]["code"]) == (409, "operation_conflict")
    assert row(a, iid) == rec


@pytest.mark.parametrize("port", ["abc", "0", "70000", "-1", "8700x"])
def test_standin2_an_invalid_hive_port_fails_the_build(a, monkeypatch, port):
    monkeypatch.setenv("HIVE_PORT", port)
    with pytest.raises(RuntimeError, match="HIVE_PORT"):
        create_app(a.hive.settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


@pytest.mark.parametrize("port", ["1", "8700", "65535"])
def test_standin2_a_valid_hive_port_builds(a, monkeypatch, port):
    monkeypatch.setenv("HIVE_PORT", port)
    create_app(a.hive.settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
