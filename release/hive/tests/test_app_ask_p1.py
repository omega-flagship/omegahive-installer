"""P1 source regressions. Synthetic catalog, deterministic clock and no model/provider calls.

These are proposed tests, not execution evidence. The existing real API fixture
provides Hive/SQLite/Ask; the catalog seam supplies a deliberately synthetic pin.
"""
import asyncio
import base64
import hashlib
import json
import os
import threading
from types import SimpleNamespace

import pytest

from hive.core.app_ask import AppAsk, CHUNK_BYTES, MAX_BYTES, encoded
from hive.core.hive import HiveError, token_hash
from hive.core.visibility import Viewer
from hive.tests.test_ask import ask, counts, world
from hive.tests.test_core_api import client  # noqa: F401

DIGEST = "sha256:" + "a" * 64
OTHER_DIGEST = "sha256:" + "b" * 64
APP = "p1-fixture"


@pytest.fixture()
def p1(client, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")   # source regressions never request a real/model turn
    w = world(client)
    hive = w["hive"]
    origin = "http://127.0.0.1:" + os.environ.get("HIVE_PORT", "8700")
    w["headers"] = dict(w["ann"], Origin=origin)
    w["bob_headers"] = dict(w["bob"], Origin=origin)
    w["session"] = token_hash(w["ann"]["Authorization"].split(" ", 1)[1])
    w["viewer"] = Viewer("user:u_ann", False)
    w["time"] = [100.0]
    hive.app_ask.clock = lambda: w["time"][0]
    releases = {APP: {"digest": DIGEST, "version": "1", "files": {}},
                "other-fixture": {"digest": DIGEST, "version": "1", "files": {}}}
    w["releases"] = releases
    monkeypatch.setattr(hive.programs, "pinned_release", lambda name: releases.get(name))
    monkeypatch.setattr(hive.programs, "get", lambda name: {"name": name, "version": "1"})
    # Synthetic P1 catalog also supplies the new host-only pinned declaration accessor.
    monkeypatch.setattr(hive.programs, "link_manifest", lambda name: {"id": name, "name": name, "version": "1",
        "release_digest": releases[name]["digest"], "related_apps": [], "capabilities": [], "swarm_templates": {}})
    assert client.put("/api/me/ask", headers=w["ann"], json={"swarm_id": w["swarm"]["id"]}).status_code == 200
    return w


def consent(client, w, app=APP, headers=None):
    headers = headers or w["headers"]
    card = client.get(f"/api/programs/{app}/ask/consent", headers=headers).json()
    if not card["consented"]:
        response = client.post(f"/api/programs/{app}/ask/consent", headers=headers, json={"card_id": card["card_id"]})
        assert response.status_code == 200, response.text
        card = response.json()
    return card


def frame(client, w, app=APP, initial=None):
    card = consent(client, w, app)
    body = {"release_digest": card["release_digest"], "frame_slot_id": "slot-1234"}
    if initial is not None:
        body["initial_operation_id"] = initial
    response = client.post(f"/api/programs/{app}/ask/frames", headers=w["headers"], json=body)
    assert response.status_code == 200, response.text
    return response.json()


def op(client, w, f, kind, app=APP, headers=None, **body):
    return client.post(f"/api/programs/{app}/ask/frames/{f['generation_id']}/ops",
                       headers=headers or w["headers"], json={"op": kind, **body})


def sent(client, w, f, op_id="first-send", text="A synthetic question"):
    response = op(client, w, f, "send", op_id=op_id, text=text)
    assert response.status_code == 200, response.text
    return response.json()


def test_consent_named_session_origin_card_digest_and_principal_are_bound(client, p1):
    w = p1
    path = f"/api/programs/{APP}/ask/consent"
    card = client.get(path, headers=w["headers"]).json()
    assert card["permission"] == "may send to and show your Ask while open" and card["release_digest"] == DIGEST
    assert client.post(path, headers=w["ann"], json={"card_id": card["card_id"]}).json()["error"]["code"] == "origin_required"
    assert client.post(path, headers=dict(w["headers"], Origin="https://foreign.test"), json={"card_id": card["card_id"]}).status_code == 403
    assert client.post(path, headers=w["bob_headers"], json={"card_id": card["card_id"]}).json()["error"]["code"] == "card_changed"
    w["releases"][APP]["digest"] = OTHER_DIGEST
    assert client.post(path, headers=w["headers"], json={"card_id": card["card_id"]}).json()["error"]["code"] == "card_changed"
    assert client.get(path).status_code == 403  # password operator is never app-scoped personal Ask


def test_consent_persists_but_new_digest_needs_fresh_consent(client, p1):
    w = p1
    old = consent(client, w)
    assert consent(client, w)["consent_id"] == old["consent_id"]
    w["releases"][APP]["digest"] = OTHER_DIGEST
    card = client.get(f"/api/programs/{APP}/ask/consent", headers=w["headers"]).json()
    assert not card["consented"] and card["consent_id"] is None
    wrong = client.post(f"/api/programs/{APP}/ask/frames", headers=w["headers"],
                        json={"release_digest": DIGEST, "frame_slot_id": "slot"})
    assert wrong.json()["error"]["code"] == "card_changed"


def test_send_reuses_existing_ask_idempotency_and_marker_without_second_transcript(client, p1):
    w = p1
    f = frame(client, w)
    before = counts(w["hive"])
    result = sent(client, w, f)
    after = counts(w["hive"])
    replay = sent(client, w, f)
    assert replay["operation_id"] == result["operation_id"] and not replay["new_turn"]
    assert counts(w["hive"]) == after and after["ask_turns"] == before["ask_turns"] + 1
    conflict = op(client, w, f, "send", op_id="first-send", text="Different body")
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "operation_conflict"
    view = client.get(f"/api/ask/{result['operation_id']}", headers=w["ann"]).json()
    assert view["app_ask"] is True and view["events"][0]["app_ask"] is True
    metadata = w["hive"].db.all("SELECT * FROM app_ask_turns")
    assert len(metadata) == 1 and "text" not in metadata[0] and "context" not in metadata[0]


def test_cross_person_other_app_and_arbitrary_own_turn_have_no_membership(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    assert op(client, w, f, "subscribe", operation_id=result["operation_id"], headers=w["bob_headers"]).status_code == 404
    other = frame(client, w, "other-fixture")
    assert op(client, w, other, "subscribe", app="other-fixture", operation_id=result["operation_id"]).status_code == 404
    client.post(f"/api/ask/{result['operation_id']}/stop", headers=w["ann"])
    own = ask(client, w["ann"], "host-other-01", context={"swarm_id": w["swarm"]["id"]}).json()
    assert op(client, w, f, "subscribe", operation_id=own["operation_id"]).status_code == 404


def test_initial_handoff_is_exact_one_generation_and_not_resumed_as_a_new_thread(client, p1):
    w = p1
    own = ask(client, w["ann"], "host-initial-01", context={"swarm_id": w["swarm"]["id"]}).json()
    f = frame(client, w, initial=own["operation_id"])
    assert f["initial_operation_id"] == own["operation_id"] and f["resumable_operations"] == []
    assert op(client, w, f, "subscribe", operation_id=own["operation_id"]).status_code == 200
    fresh = frame(client, w)
    assert fresh["initial_operation_id"] is None and own["operation_id"] not in fresh["resumable_operations"]
    assert op(client, w, fresh, "subscribe", operation_id=own["operation_id"]).status_code == 404
    again = client.post(f"/api/programs/{APP}/ask/frames", headers=w["headers"],
                        json={"release_digest": DIGEST, "frame_slot_id": "new-slot", "initial_operation_id": own["operation_id"]})
    assert again.status_code == 409


def test_lease_lapse_offers_same_nonterminal_turn_and_old_generation_cannot_renew(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    sid = op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()["subscription_id"]
    w["time"][0] += 15.001
    w["hive"].app_ask.sweep()
    presentation = client.get(f"/api/ask/{result['operation_id']}/presentation", headers=w["ann"]).json()
    assert presentation["owner"] == "host" and not presentation["host_active"]
    assert w["hive"].ask._row(result["turn_id"])["state"] == "accepted"
    assert op(client, w, f, "poll", subscription_id=sid, cursor={"after_seq": 0, "offset": 0}).status_code == 409
    renew = client.post(f"/api/programs/{APP}/ask/frames/{f['generation_id']}/presence", headers=w["headers"], json={})
    assert renew.status_code == 409
    fresh = frame(client, w)
    assert result["operation_id"] in fresh["resumable_operations"]
    resumed = op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=presentation["epoch"])
    assert resumed.json()["owner"] == "frame" and resumed.json()["turn_id"] == result["turn_id"]


def test_host_active_requires_explicit_person_handback_and_epoch_cas(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    path = f"/api/ask/{result['operation_id']}/presentation"
    claimed = client.post(path, headers=w["headers"], json={"action": "claim", "expected_epoch": result["presentation"]["epoch"]}).json()
    assert claimed["host_active"]
    fresh = frame(client, w)
    refused = op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=claimed["epoch"])
    assert refused.json()["error"]["code"] == "handover_required"
    # A frame op cannot pretend a human handback: closed op schema has no such action.
    assert op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=claimed["epoch"], action="handover").status_code == 400
    handback = client.post(path, headers=w["headers"], json={"action": "handover", "generation_id": fresh["generation_id"], "expected_epoch": claimed["epoch"]})
    assert handback.status_code == 200 and handback.json()["owner"] == "frame"
    assert client.post(path, headers=w["headers"], json={"action": "claim", "expected_epoch": claimed["epoch"]}).status_code == 409


def test_leave_fences_before_waiting_on_resume_turn_gate(client, p1, monkeypatch):
    w = p1
    old = frame(client, w)
    result = sent(client, w, old)
    op(client, w, old, "yield", operation_id=result["operation_id"])
    fresh = frame(client, w)
    api = w["hive"].app_ask
    epoch = api.presentation(w["viewer"], result["operation_id"])["epoch"]
    inside, continue_commit, leave_marked = threading.Event(), threading.Event(), threading.Event()
    real_require, real_mark = api._require, api.mark_fenced
    visits = [0]
    def delayed(*args, **kwargs):
        if threading.current_thread().name == "p1-resume":
            visits[0] += 1
            if visits[0] == 2:  # _op holds the turn mutex and DB gate; immediately before _resume final check
                inside.set()
                assert continue_commit.wait(3)
        return real_require(*args, **kwargs)
    def marked(generation, status):
        real_mark(generation, status)
        if generation == fresh["generation_id"]:
            leave_marked.set()
    monkeypatch.setattr(api, "_require", delayed)
    monkeypatch.setattr(api, "mark_fenced", marked)
    outcomes = []
    def resume():
        try:
            asyncio.run(api.op(w["viewer"], w["session"], APP, fresh["generation_id"],
                               {"op": "resume", "operation_id": result["operation_id"], "expected_epoch": epoch}))
        except HiveError as exc:
            outcomes.append(exc.code)
    worker = threading.Thread(target=resume, name="p1-resume")
    worker.start()
    assert inside.wait(3)
    closer = threading.Thread(target=lambda: api.close(w["viewer"], w["session"], APP, fresh["generation_id"]))
    closer.start()
    assert leave_marked.wait(3)  # close did NOT wait for the DB/turn lock before fencing
    continue_commit.set()
    worker.join(3)
    closer.join(3)
    assert not worker.is_alive() and not closer.is_alive() and outcomes == ["generation_fenced"]
    assert api.presentation(w["viewer"], result["operation_id"])["owner"] == "host"


def test_final_admission_rechecks_generation_after_thread_creation_await(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    api = w["hive"].app_ask
    original = w["hive"].sessions.create
    async def delayed(*args, **kwargs):
        answer = await original(*args, **kwargs)
        api.mark_fenced(f["generation_id"], "left")
        return answer
    monkeypatch.setattr(w["hive"].sessions, "create", delayed)
    before = counts(w["hive"])
    refusal = op(client, w, f, "send", op_id="await-race", text="Must never be admitted")
    assert refusal.status_code == 409
    after = counts(w["hive"])
    for key in ("ask_turns", "room_messages", "messages", "ask_events"):
        assert after[key] == before[key]
    assert w["hive"].db.all("SELECT * FROM app_ask_turns") == []


def test_revoke_destroys_identity_and_subscriptions_but_new_consent_is_distinct(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    sid = op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()["subscription_id"]
    assert client.request("DELETE", f"/api/programs/{APP}/ask/consent", headers=w["headers"], json={}).status_code == 200
    assert op(client, w, f, "poll", subscription_id=sid, cursor={"after_seq": 0, "offset": 0}).status_code == 409
    fresh = frame(client, w)
    assert fresh["consent_id"] != f["consent_id"] and fresh["resumable_operations"] == []
    assert op(client, w, fresh, "subscribe", operation_id=result["operation_id"]).status_code == 404


def test_release_removal_and_signout_proactively_restore_host(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    w["releases"].pop(APP)
    w["hive"].app_ask.sweep()
    assert w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["owner"] == "host"
    w["releases"][APP] = {"digest": DIGEST, "version": "1", "files": {}}
    fresh = frame(client, w)
    assert client.post("/api/auth/logout", headers=w["ann"]).status_code == 200
    row = w["hive"].db.one("SELECT status FROM app_ask_generations WHERE id = ?", (fresh["generation_id"],))
    assert row["status"] != "active"


def test_restart_keeps_consent_but_never_revives_generation_or_frame_presentation(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    restored = AppAsk(w["hive"], clock=lambda: 100.0)
    assert restored.card(w["viewer"], w["session"], APP)["consent_id"] == f["consent_id"]
    assert restored.presentation(w["viewer"], result["operation_id"])["owner"] == "host"
    with pytest.raises(HiveError) as refused:
        restored.presence(w["viewer"], w["session"], APP, f["generation_id"])
    assert refused.value.code == "generation_fenced"


def test_utf8_closed_request_and_recursive_authority_refusal(client, p1):
    w = p1
    f = frame(client, w)
    before = counts(w["hive"])
    huge = op(client, w, f, "send", op_id="utf8-max", text="🌳" * 3000)
    assert huge.status_code == 413
    for extra in ({"principal": "user:u_bob"}, {"context": {"view": {"summary": "x", "token": "no"}}},
                  {"context": {"selection": [{"kind": "mind", "ref": "x", "key_id": "no"}]}}):
        body = {"op": "send", "op_id": "bad-body", "text": "x", **extra}
        response = client.post(f"/api/programs/{APP}/ask/frames/{f['generation_id']}/ops", headers=w["headers"], json=body)
        assert response.status_code == 400
    assert counts(w["hive"]) == before


def test_chunks_have_exact_cursors_digest_and_no_cross_subscription_access(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    hive = w["hive"]
    # Real canonical Ask events; no P1 transcript is manufactured.
    with hive.db.transaction():
        large = hive.ask._frame(result["turn_id"], "thinking", step="界" * 4000)
    sub = op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()
    cursor = {"after_seq": large["seq"] - 1, "offset": 0}
    chunks = []
    while True:
        response = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor=cursor)
        assert response.status_code == 200
        chunk = response.json()
        assert len(encoded(chunk)) <= MAX_BYTES and len(chunk["data_base64"]) <= 4096
        replay = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor=cursor).json()
        assert replay == chunk
        chunks.append(base64.b64decode(chunk["data_base64"]))
        cursor = chunk["next_cursor"]
        if chunk["complete"]:
            break
    raw = b"".join(chunks)
    assert hashlib.sha256(raw).hexdigest() == chunk["sha256"] and json.loads(raw)["step"] == large["step"]
    assert cursor == {"after_seq": large["seq"], "offset": 0}
    assert op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor={"after_seq": 0, "offset": 1}).status_code == 400
    other = frame(client, w, "other-fixture")
    assert op(client, w, other, "poll", app="other-fixture", subscription_id=sub["subscription_id"], cursor=cursor).status_code == 404


class Future:
    def __init__(self):
        self.values = []
    def done(self):
        return bool(self.values)
    def set_result(self, value):
        self.values.append(value)


def pending_act(w, result, act_id="ac_p1_test"):
    hive = w["hive"]
    future = Future()
    st = SimpleNamespace(principal="user:u_ann", closing=False, pending={act_id: future}, recorded=set(),
                         loop=SimpleNamespace(call_soon_threadsafe=lambda fn: fn()), private_page=False)
    hive.ask.conductor.turns[result["turn_id"]] = st
    hive.db.execute("UPDATE ask_turns SET state = 'conducting', conductor_model = 'mock/conductor' WHERE id = ?", (result["turn_id"],))
    turn = hive.ask._row(result["turn_id"])
    with hive.app_ask.turn_gate(turn["principal"], turn["operation_id"]), hive.db.transaction():
        recipient = hive.app_ask.issue_act(turn, act_id)
        hive.ask._frame(turn["id"], "act", act={"act_id": act_id, "kind": "navigate", "route": "#/goals"}, recipient=recipient)
    return act_id, st, future, recipient


def test_frame_act_claim_exact_recipient_once_only_and_no_old_host_route_bypass(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    act_id, st, future, recipient = pending_act(w, result)
    assert recipient["generation_id"] == f["generation_id"]
    claim_path = f"/api/ask/{result['operation_id']}/acts/{act_id}/claim"
    assert client.post(claim_path, headers=w["headers"], json={"owner_epoch": recipient["owner_epoch"]}).status_code == 409
    assert op(client, w, f, "act-result", operation_id=result["operation_id"], act_id=act_id, result={"ok": True}).status_code == 409
    assert op(client, w, f, "act-claim", operation_id=result["operation_id"], act_id=act_id, expected_epoch=recipient["owner_epoch"]).status_code == 200
    assert op(client, w, f, "act-claim", operation_id=result["operation_id"], act_id=act_id, expected_epoch=recipient["owner_epoch"]).status_code == 409
    host_result = client.post(f"/api/ask/{result['operation_id']}/acts/{act_id}/result", headers=w["headers"], json={"ok": True})
    assert host_result.status_code == 409
    assert op(client, w, f, "act-result", operation_id=result["operation_id"], act_id=act_id, result={"ok": True}).status_code == 200
    assert op(client, w, f, "act-result", operation_id=result["operation_id"], act_id=act_id, result={"ok": True}).status_code == 409
    assert future.values == [{"ok": True}] and act_id in st.recorded


def test_claim_lost_reply_then_lapse_settles_once_and_never_reassigns_old_act(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    act_id, st, future, recipient = pending_act(w, result)
    assert op(client, w, f, "act-claim", operation_id=result["operation_id"], act_id=act_id, expected_epoch=recipient["owner_epoch"]).status_code == 200
    # Treat response as lost: no retry/effect by the caller. The outstanding claim is never made available again.
    w["time"][0] += 16
    w["hive"].app_ask.sweep()
    w["hive"].app_ask.sweep()
    assert future.values == [{"ok": False, "reason": "no_result"}] and act_id in st.recorded
    fresh = frame(client, w)
    epoch = w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["epoch"]
    assert op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=epoch).status_code == 200
    assert op(client, w, fresh, "act-claim", operation_id=result["operation_id"], act_id=act_id, expected_epoch=epoch + 1).status_code == 409
    assert w["hive"].app_ask.act_recipients[(result["turn_id"], act_id)] == recipient


def test_returned_host_act_requires_claim_and_wrong_epoch_cannot_execute(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    op(client, w, f, "yield", operation_id=result["operation_id"])
    act_id, st, future, recipient = pending_act(w, result)
    assert recipient["kind"] == "host" and recipient["generation_id"] is None
    path = f"/api/ask/{result['operation_id']}/acts/{act_id}"
    assert client.post(path + "/result", headers=w["headers"], json={"ok": True}).status_code == 409
    assert client.post(path + "/claim", headers=w["headers"], json={"owner_epoch": recipient["owner_epoch"] + 1}).status_code == 409
    assert client.post(path + "/claim", headers=w["headers"], json={"owner_epoch": recipient["owner_epoch"]}).status_code == 200
    assert client.post(path + "/claim", headers=w["headers"], json={"owner_epoch": recipient["owner_epoch"]}).status_code == 409
    assert client.post(path + "/result", headers=w["headers"], json={"ok": True}).status_code == 200
    assert future.values == [{"ok": True}]


def test_atomic_ui_response_hashes_returned_bytes_against_captured_reviewed_lock(client, p1, monkeypatch):
    programs = p1["hive"].programs
    entry = {"path": "/synthetic-review-only", "digest": DIGEST, "version": "1"}
    files = {"index.html": "<body>exact</body>", "app.js": "void 0", "style.css": "body{}"}
    lock = {"files": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()}}
    monkeypatch.setattr(programs, "_ready", lambda app: entry)
    monkeypatch.setattr(programs, "source_digest", lambda *args, **kwargs: DIGEST)
    bundle = programs._ui_identity(APP, entry, lock, encoded(lock), {"program": APP, "files": files})
    assert bundle["release"] == {"digest": DIGEST, "version": "1"}
    with pytest.raises(HiveError) as refused:
        programs._ui_identity(APP, entry, lock, encoded(lock), {"program": APP, "files": dict(files, **{"app.js": "tampered"})})
    assert refused.value.code == "app_integrity"
    p1["releases"][APP]["digest"] = OTHER_DIGEST
    with pytest.raises(HiveError) as changed:
        programs._ui_identity(APP, entry, lock, encoded(lock), {"program": APP, "files": files})
    assert changed.value.code == "app_integrity"


def test_same_consent_new_frame_cannot_claim_or_answer_old_frame_act(client, p1):
    w = p1
    old = frame(client, w)
    result = sent(client, w, old)
    act_id, st, future, recipient = pending_act(w, result)
    fresh = frame(client, w)
    epoch = w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["epoch"]
    assert op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=epoch).status_code == 200
    assert fresh["consent_id"] == old["consent_id"]
    assert op(client, w, fresh, "act-claim", operation_id=result["operation_id"], act_id=act_id,
              expected_epoch=recipient["owner_epoch"]).status_code == 409
    assert op(client, w, fresh, "act-result", operation_id=result["operation_id"], act_id=act_id, result={"ok": True}).status_code == 409
    assert future.values == [{"ok": False, "reason": "no_result"}]


def test_result_racing_independent_fence_is_checked_at_final_redemption(client, p1, monkeypatch):
    from hive.core import conductor
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    act_id, st, future, recipient = pending_act(w, result)
    assert op(client, w, f, "act-claim", operation_id=result["operation_id"], act_id=act_id,
              expected_epoch=recipient["owner_epoch"]).status_code == 200
    check = conductor.check_result
    def fence_after_validation(data):
        problem = check(data)
        w["hive"].app_ask.mark_fenced(f["generation_id"], "left")
        return problem
    monkeypatch.setattr(conductor, "check_result", fence_after_validation)
    rejected = op(client, w, f, "act-result", operation_id=result["operation_id"], act_id=act_id, result={"ok": True})
    assert rejected.status_code == 409
    assert future.values == [{"ok": False, "reason": "no_result"}] and act_id in st.recorded


def test_new_host_act_gets_new_host_epoch_while_old_frame_act_is_never_relabelled(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    old_id, old_st, old_future, old_recipient = pending_act(w, result)
    returned = op(client, w, f, "yield", operation_id=result["operation_id"]).json()
    new_id, st, future, recipient = pending_act(w, result, "ac_host_new")
    assert recipient == {"kind": "host", "generation_id": None, "owner_epoch": returned["epoch"]}
    assert w["hive"].app_ask.act_recipients[(result["turn_id"], old_id)] == old_recipient
    assert old_future.values == [{"ok": False, "reason": "no_result"}]
    path = f"/api/ask/{result['operation_id']}/acts"
    assert client.post(f"{path}/{old_id}/claim", headers=w["headers"], json={"owner_epoch": returned["epoch"]}).status_code == 409
    assert client.post(f"{path}/{new_id}/claim", headers=w["headers"], json={"owner_epoch": returned["epoch"]}).status_code == 200


def test_subscription_count_and_operation_rate_are_bounded(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    api = w["hive"].app_ask
    # A full set of other logical subscriptions, without manufacturing sixteen provider turns.
    for index in range(16):
        api.subscriptions[f"full-{index}"] = {"generation": f["generation_id"], "turn_id": f"other-{index}",
                                               "operation": f"other-op-{index}", "epoch": 1}
    assert op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()["error"]["code"] == "rate_limited"
    api.rates[f["generation_id"]] = (0, w["time"][0])
    refused = client.post(f"/api/programs/{APP}/ask/frames/{f['generation_id']}/presence", headers=w["headers"], json={})
    assert refused.json()["error"]["code"] == "rate_limited"


def test_oversized_event_fails_closed_and_restores_same_host_turn(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    hive = w["hive"]
    sub = op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()
    with hive.db.transaction():
        event = hive.ask._frame(result["turn_id"], "thinking", step="🌳" * 17000)
    refused = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor={"after_seq": event["seq"] - 1, "offset": 0})
    assert refused.json()["error"]["code"] == "event_too_large" and "data_base64" not in refused.json()
    assert hive.app_ask.presentation(w["viewer"], result["operation_id"])["owner"] == "host"
    assert hive.ask._row(result["turn_id"])["state"] == "accepted"


def personal_event(w, result, text="PRIVATE_LIVE_BODY"):
    hive = w["hive"]
    hive.db.execute("UPDATE ask_turns SET personal = 1 WHERE id = ?", (result["turn_id"],))
    with hive.db.transaction():
        event = hive.ask._frame(result["turn_id"], "answer", text=text, delta=True)
    hive.ask._publish([event])
    return event


def test_personal_live_body_only_in_generation_memory_ack_frees_it_no_old_cursor_fallback(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    event = personal_event(w, result)
    stored = w["hive"].db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (result["turn_id"],))
    assert "PRIVATE_LIVE_BODY" not in json.dumps(stored)
    sub = op(client, w, f, "subscribe", operation_id=result["operation_id"]).json()
    assert sub["cursor"] == {"after_seq": event["seq"] - 1, "offset": 0}
    chunk = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor=sub["cursor"]).json()
    assert json.loads(base64.b64decode(chunk["data_base64"]))["text"] == "PRIVATE_LIVE_BODY"
    assert chunk["complete"]
    idle = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor=chunk["next_cursor"])
    assert idle.json()["kind"] == "idle" and w["hive"].app_ask.live_frames == {}
    stale = op(client, w, f, "poll", subscription_id=sub["subscription_id"], cursor=sub["cursor"])
    assert stale.json()["error"]["code"] == "event_unavailable"
    assert w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["owner"] == "host"


def test_personal_fence_and_reload_clear_body_and_resume_begins_at_live_boundary(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    old = personal_event(w, result, "PRIVATE_OLD_GENERATION")
    assert w["hive"].app_ask.live_frames
    fresh = frame(client, w)
    assert w["hive"].app_ask.live_frames == {}
    epoch = w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["epoch"]
    assert op(client, w, fresh, "resume", operation_id=result["operation_id"], expected_epoch=epoch).status_code == 200
    sub = op(client, w, fresh, "subscribe", operation_id=result["operation_id"]).json()
    assert sub["cursor"]["after_seq"] == old["seq"]
    assert op(client, w, fresh, "poll", subscription_id=sub["subscription_id"], cursor=sub["cursor"]).json()["kind"] == "idle"
    new = personal_event(w, result, "PRIVATE_NEW_GENERATION")
    chunk = op(client, w, fresh, "poll", subscription_id=sub["subscription_id"], cursor=sub["cursor"]).json()
    assert json.loads(base64.b64decode(chunk["data_base64"]))["text"] == "PRIVATE_NEW_GENERATION"
    assert chunk["seq"] == new["seq"]
    assert op(client, w, fresh, "unsubscribe", subscription_id=sub["subscription_id"]).status_code == 200
    assert w["hive"].app_ask.live_frames == {}


def test_personal_outbox_overflow_restores_host_without_persisting_private_bodies(client, p1):
    w = p1
    f = frame(client, w)
    result = sent(client, w, f)
    for index in range(17):
        personal_event(w, result, f"PRIVATE_OVERFLOW_{index}")
    w["hive"].app_ask.sweep()
    assert w["hive"].app_ask.live_frames == {}
    assert w["hive"].app_ask.presentation(w["viewer"], result["operation_id"])["owner"] == "host"
    stored = w["hive"].db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (result["turn_id"],))
    assert "PRIVATE_OVERFLOW" not in json.dumps(stored)


def test_proactive_watchdog_recovers_after_transient_sweep_faults_without_requests(client, p1, monkeypatch, caplog):
    # The real client fixture starts the real lifespan with reconcile_seconds=0. No ordinary reconcile,
    # HTTP request or manual sweep after expiry is allowed to restore this presentation for the watcher.
    w = p1
    f = frame(client, w)
    turn = sent(client, w, f, op_id="watchdog-fault-recovery")
    hive, api = w["hive"], w["hive"].app_ask
    original = api.sweep
    entered, recovered = threading.Event(), threading.Event()
    gate = threading.Lock()
    state = {"armed": False, "failures": 0, "before_recovery": None, "after_recovery": None}
    private_fault = "INVENTED_PRIVATE_SWEEP_FAULT_MUST_NOT_BE_LOGGED"
    caplog.set_level("WARNING", logger="hive")

    def transient_sweep():
        with gate:
            if recovered.is_set():
                original()
                return
            if not state["armed"]:
                original()
                # The serial lifespan task has completed any older callback before this point.
                entered.set()
                return
            if state["failures"] < 2:
                state["failures"] += 1
                raise RuntimeError(private_fault)
            state["before_recovery"] = hive.db.one(
                "SELECT * FROM app_ask_presentations WHERE turn_id = ?", (turn["turn_id"],))
            original()
            state["after_recovery"] = hive.db.one(
                "SELECT * FROM app_ask_presentations WHERE turn_id = ?", (turn["turn_id"],))
            recovered.set()

    monkeypatch.setattr(api, "sweep", transient_sweep)
    assert entered.wait(2), "the independent lifespan watchdog never called the sweep seam"
    with gate:
        state["armed"] = True
        w["time"][0] += 15.001
    assert recovered.wait(3), "a transient sweep fault permanently killed proactive lease recovery"
    with gate:
        assert state["failures"] == 2
        before, after = state["before_recovery"], state["after_recovery"]
        assert before["owner"] == "frame" and before["generation_id"] == f["generation_id"]
        assert after["owner"] == "host" and after["generation_id"] is None and not after["host_active"]
        assert after["epoch"] > before["epoch"]
    row = hive.ask._row(turn["turn_id"])
    assert row["operation_id"] == turn["operation_id"] and row["state"] == "accepted"
    generation = hive.db.one("SELECT status FROM app_ask_generations WHERE id = ?", (f["generation_id"],))
    assert generation["status"] != "active" and f["generation_id"] not in api.deadlines
    warnings = [r for r in caplog.records if r.getMessage().startswith("app Ask expiry sweep failed")]
    assert len(warnings) == 1   # repeated failures in one30s window cannot flood the log
    assert warnings[0].getMessage() == "app Ask expiry sweep failed (RuntimeError); retrying"
    assert warnings[0].exc_info is None and private_fault not in caplog.text


# Failed R1 qualification: preparation must remain write-free across awaits.
def _p1_admission_counts(hive):
    return {table: hive.db.one(f"SELECT COUNT(*) AS n FROM {table}")["n"]
            for table in ("goals", "rooms", "room_members", "work_sessions", "session_caps",
                          "budgets", "ask_turns", "room_messages", "messages", "ask_events", "app_ask_turns")}


def test_fenced_prepared_thread_leaves_no_goal_room_cap_or_publication(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    api, hive = w["hive"].app_ask, w["hive"]
    create = hive.sessions.create
    published = []
    publish = hive.events.publish
    def observed(kind, **payload):
        published.append(kind)
        return publish(kind, **payload)
    async def delayed(*args, **kwargs):
        assert kwargs.get("_prepare_ask") is True
        answer = await create(*args, **kwargs)
        api.mark_fenced(f["generation_id"], "left")
        return answer
    monkeypatch.setattr(hive.events, "publish", observed)
    monkeypatch.setattr(hive.sessions, "create", delayed)
    before = _p1_admission_counts(hive)
    response = op(client, w, f, "send", op_id="fenced-prepared", text="No write from a departed frame")
    assert response.status_code == 409
    assert _p1_admission_counts(hive) == before
    assert not set(published) & {"goal.updated", "room", "message", "ask"}


def test_final_binding_failure_rolls_back_prepared_thread_and_deferred_events(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    hive, api = w["hive"], w["hive"].app_ask
    admitted = api.admitted
    published = []
    publish = hive.events.publish
    def observed(kind, **payload):
        published.append(kind)
        return publish(kind, **payload)
    def fail_after_thread(binding, turn):
        # Thread/goal/cap and Ask writes have happened, but the outer
        # transaction must still roll them back and drop its callbacks.
        assert hive.db.one("SELECT COUNT(*) AS n FROM work_sessions")["n"] > before["work_sessions"]
        api.mark_fenced(f["generation_id"], "left")
        return admitted(binding, turn)
    monkeypatch.setattr(hive.events, "publish", observed)
    monkeypatch.setattr(api, "admitted", fail_after_thread)
    before = _p1_admission_counts(hive)
    response = op(client, w, f, "send", op_id="rollback-prepared", text="Never publish a rejected turn")
    assert response.status_code == 409
    assert _p1_admission_counts(hive) == before
    assert not set(published) & {"goal.updated", "room", "message", "ask"}


def test_concurrent_preparations_replay_one_thread_goal_and_ask_delivery(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    hive, api = w["hive"], w["hive"].app_ask
    create = hive.sessions.create
    async def run():
        ready = asyncio.Event()
        prepared = 0
        async def held(*args, **kwargs):
            nonlocal prepared
            result = await create(*args, **kwargs)
            prepared += 1
            if prepared == 2:
                ready.set()
            await asyncio.wait_for(ready.wait(), 3)
            return result
        monkeypatch.setattr(hive.sessions, "create", held)
        data = {"op": "send", "op_id": "prepared-idempotent", "text": "One canonical turn"}
        return await asyncio.gather(*(api.op(w["viewer"], w["session"], APP, f["generation_id"], data) for _ in range(2)))
    before = _p1_admission_counts(hive)
    first, second = asyncio.run(run())
    assert first["operation_id"] == second["operation_id"] and first["turn_id"] == second["turn_id"]
    after = _p1_admission_counts(hive)
    for key in ("goals", "rooms", "work_sessions", "ask_turns", "room_messages", "messages", "app_ask_turns"):
        assert after[key] == before[key] + 1


def test_ui_identity_preserves_legacy_shape_extra_pin_and_closed_parts(client, p1, monkeypatch):
    programs = p1["hive"].programs
    entry = {"path": "/synthetic-review-only", "digest": DIGEST, "version": "1"}
    files = {"index.html": "<body>legacy</body>", "app.js": "void 0", "style.css": "body{}"}
    lock = {"files": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()}}
    lock["files"]["extra.js"] = hashlib.sha256(b"unserved").hexdigest()
    monkeypatch.setattr(programs, "_ready", lambda app: entry)
    monkeypatch.setattr(programs, "source_digest", lambda *args, **kwargs: DIGEST)
    monkeypatch.setattr(programs, "pinned_release", lambda app: None)
    bundle = {"program": APP, "files": files}
    assert programs._ui_identity(APP, entry, lock, encoded(lock), bundle) == bundle
    assert "release" not in bundle
    with pytest.raises(HiveError) as refused:
        programs._ui_identity(APP, entry, dict(lock, scripts=["app.js"]), encoded(lock), dict(bundle, scripts=["app.js"]))
    assert refused.value.code == "app_integrity"



def _p1_synthetic_conductor(hive, monkeypatch):
    # Retain lifecycle methods while replacing every model execution seam.
    conductor = hive.ask.conductor
    assert conductor is not None
    monkeypatch.setattr(conductor, "model_for", lambda *args: "synthetic:offline")
    monkeypatch.setattr(conductor, "deadline", lambda: 9999999999.0)
    monkeypatch.setattr(conductor, "start", lambda *args, **kwargs: None)
    monkeypatch.setattr(conductor, "expire_presentation", lambda *args: None)


def test_conducted_preflight_fence_never_expires_or_rescopes_before_admission(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    hive, api = w["hive"], w["hive"].app_ask
    _p1_synthetic_conductor(hive, monkeypatch)
    monkeypatch.setattr(hive.ask, "_conducting", lambda: True)
    maintenance = []
    def forbidden(*args, **kwargs):
        maintenance.append(True)
        raise AssertionError("P1 preflight performed maintenance or scope writes")
    monkeypatch.setattr(hive.ask, "expire", forbidden)
    monkeypatch.setattr(hive.sessions, "rescope", forbidden)
    create = hive.sessions.create
    async def delayed(*args, **kwargs):
        prepared = await create(*args, **kwargs)
        api.mark_fenced(f["generation_id"], "left")
        return prepared
    monkeypatch.setattr(hive.sessions, "create", delayed)
    before = _p1_admission_counts(hive)
    response = op(client, w, f, "send", op_id="conducted-preflight", text="No scope changes before authority")
    assert response.status_code == 409
    assert _p1_admission_counts(hive) == before and maintenance == []


def test_conducted_scope_and_fresh_spend_check_run_inside_final_transaction(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    hive, api = w["hive"], w["hive"].app_ask
    _p1_synthetic_conductor(hive, monkeypatch)
    monkeypatch.setattr(hive.ask, "_conducting", lambda: True)
    calls = []
    rescope = hive.sessions.rescope
    def checked_scope(*args, **kwargs):
        assert hive.db._conn.in_transaction
        api.before_admit(current_binding[0])
        calls.append(args)
        return rescope(*args, **kwargs)
    current_binding = []
    before_admit = api.before_admit
    def remember_binding(binding):
        current_binding[:] = [binding]
        return before_admit(binding)
    monkeypatch.setattr(api, "before_admit", remember_binding)
    monkeypatch.setattr(hive.sessions, "rescope", checked_scope)
    result = sent(client, w, f, op_id="conducted-final-scope")
    assert calls and all(args[1] == "thread" for args in calls)
    turn = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = ?", (result["operation_id"],))
    thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (turn["thread_id"],))
    assert thread["cap_scope"] == "thread" and turn["state"] == "conducting"



def test_conducted_final_spend_refusal_rolls_back_thread_scope_and_notices(client, p1, monkeypatch):
    w = p1
    f = frame(client, w)
    hive = w["hive"]
    _p1_synthetic_conductor(hive, monkeypatch)
    monkeypatch.setattr(hive.ask, "_conducting", lambda: True)
    held_calls = []
    def exhausted(thread):
        assert hive.db._conn.in_transaction and thread["cap_scope"] == "thread"
        held_calls.append(thread["id"])
        return float(thread["budget_usd"]) + 1.0
    monkeypatch.setattr(hive.sessions, "thread_held", exhausted)
    published = []
    publish = hive.events.publish
    def observed(kind, **payload):
        published.append(kind)
        return publish(kind, **payload)
    monkeypatch.setattr(hive.events, "publish", observed)
    before = _p1_admission_counts(hive)
    response = op(client, w, f, "send", op_id="conducted-held-refusal", text="Do not bypass a held liability")
    assert response.status_code == 402 and response.json()["error"]["code"] == "spend_limit"
    assert held_calls and _p1_admission_counts(hive) == before
    assert not set(published) & {"goal.updated", "room", "message", "ask"}



def test_duplicate_empty_threads_never_publish_cleanup_from_a_refused_p1_admission(client, p1, monkeypatch):
    w = p1
    hive, api = w["hive"], w["hive"].app_ask
    async def empty_threads():
        for title in ("older empty Ask", "newer empty Ask"):
            await hive.sessions.create(w["viewer"], {"mind": w["coord"]["id"], "title": title,
                                        "budget_usd": 2.0}, purpose="ask")
    asyncio.run(empty_threads())
    f = frame(client, w)
    tables = ("goals", "rooms", "room_members", "work_sessions", "session_caps", "budgets",
              "ask_turns", "room_messages", "messages", "ask_events", "app_ask_turns")
    def snapshot():
        return {table: hive.db.all(f"SELECT * FROM {table} ORDER BY rowid") for table in tables}
    admitted = api.admitted
    def refuse_at_binding(binding, turn):
        api.mark_fenced(f["generation_id"], "left")
        return admitted(binding, turn)
    published = []
    publish = hive.events.publish
    def observed(kind, **payload):
        published.append(kind)
        return publish(kind, **payload)
    monkeypatch.setattr(api, "admitted", refuse_at_binding)
    monkeypatch.setattr(hive.events, "publish", observed)
    before = snapshot()
    assert len(before["work_sessions"]) == 2
    response = op(client, w, f, "send", op_id="duplicate-empty-rollback", text="No cleanup notice from this refusal")
    assert response.status_code == 409
    assert snapshot() == before
    assert not set(published) & {"goal.updated", "room", "message", "ask"}
