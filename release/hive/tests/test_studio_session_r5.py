"""J3 host round R5: O1 steer interception, pause/resume, Stop's confirmation (goal, fence time, in-flight, unknown,
cancel-ack), window expiry, the self-check that can now pass, and the maker-side tools (OI-7).

Plan PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md: §3.3 controls, §4 (O1), §5 (Stop), §8 rows O1-a..e and S-a..c, §9 R5 row;
r1.1 K6 (closed-session refusal, paused queues), K10 (resume re-checks the consent payload), S5 (resume re-checks the
binding); r1.2 E2(a) (admission refuses a fenced execution); r1.3 F4 / r1.4 G5(c)(d) (A15 through the real steer route,
the controls item of the self-check); r1.5 H3.3 (a direction is a direct trigger); r1.8 L2 (Stop is release). Handoff spec
r2.4 §8.8 + r2.5. Open items OI-7 (maker tools). Synthetic only: the real Supervisor over a fake process driver
(test_studio_session_r3), a scripted provider (test_studio_session_r4), temporary data directories, no live hive."""
import hashlib
import importlib.util
import json
import pathlib
import secrets
import threading

import pytest

from hive.core.db import now
from hive.tests.test_studio_session_r3 import (Hub, connect, context, done, drive, epoch_of, in_step,  # noqa: F401
                                               maker_headers, mount, on_loop, open_session, outcome, prepare, publish, r3,
                                               ses_row, started, step_row, tick, token_now, upload)
from hive.tests.test_studio_session_r3_handoff import (SAFE_RESTART, control, handoff, past, ready2,  # noqa: F401
                                                       stop, stopped_and_released, studio, wait_for)
from hive.tests.test_studio_session_r4 import Transport, chat, in_thread, r4, reservations_of  # noqa: F401
from hive.tests.test_ask_intents import a, held, release, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, MODEL, err, record, s, submit  # noqa: F401

OP = "op-mia-turn-01"


def steer(x, steer_id=None, text="warmer", op=OP, at_seq=0, who=None):
    return x.client.post(f"/api/ask/{op}/steer", headers=who or x.mg,
                         json={"steer_id": steer_id or f"st-{secrets.token_hex(4)}", "text": text, "at_seq": at_seq})


def ledger(x, sid):
    r = x.client.get(f"/api/studio-sessions/{sid}", headers=x.mia)
    assert r.status_code == 200, r.text
    return r.json()


def maker_inbox(x):
    """Every message ever queued for the maker (the hub outbox / pull inbox)."""
    return x.hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND direction = 'in'", (x.maker["id"],))["n"]


def steer_row(x, steer_id):
    return x.hive.db.one("SELECT * FROM ask_steers WHERE principal = ? AND steer_id = ?", (MIA, steer_id))


def turns(x):
    return x.hive.db.one("SELECT COUNT(*) AS n FROM ask_turns")["n"]


def set_turn(x, state, op=OP):
    x.hive.db.execute("UPDATE ask_turns SET state = ? WHERE operation_id = ?", (state, op))


# ---- O1: interception (plan §4.1-4.3, §8 O1-a, O1-b) --------------------------------------------------------------------

def test_O1a_a_steer_on_a_conducting_turn_bound_to_a_live_session_is_queued_for_the_maker(r3):
    session, sid, m, ack, step = started(r3)
    set_turn(r3, "conducting")                         # today: 404 not_available (ask.py, conducting branch)
    inbox = maker_inbox(r3)
    r = steer(r3, "st-0001", "bigger headline")
    assert r.status_code == 202, r.text
    j = r.json()
    assert j["new_turn"] is False and j["steer_id"] == "st-0001" and j["operation_id"] == OP
    assert j["studio"] == {"session_id": sid, "seq": 1, "state": "queued", "session_state": "active"}
    row = steer_row(r3, "st-0001")
    assert (row["outcome"], row["studio_session_id"], row["studio_seq"], row["text"], row["delivery_message_id"]) == \
        ("studio", sid, 1, "bigger headline", "")
    assert maker_inbox(r3) == inbox                    # nothing pushed to the maker per remark
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["queued"]
    assert ses_row(r3, sid)["next_dir_seq"] == 2


def test_O1b_a_steer_on_a_closed_bound_turn_starts_no_turn_and_reserves_nothing(r3):
    session, sid, m, ack, step = started(r3)
    set_turn(r3, "answered")                           # today: a fresh paid turn "steer:<id>"
    before_turns = turns(r3)
    before_res = r3.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]
    r = steer(r3, "st-0002", "warmer")
    assert r.status_code == 202, r.text
    assert r.json()["new_turn"] is False and r.json()["studio"]["seq"] == 1
    assert turns(r3) == before_turns
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == before_res
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM ask_turns WHERE operation_id = 'steer:st-0002'")["n"] == 0


def test_O1_a_replayed_steer_answers_the_recorded_bytes_and_another_body_conflicts(r3):
    session, sid, m, ack, step = started(r3)
    first = steer(r3, "st-0003", "warmer")
    assert first.status_code == 202
    again = steer(r3, "st-0003", "warmer")
    assert (again.status_code, again.json()) == (202, first.json())
    set_turn(r3, "answered")                           # even after the turn closed: the same answer, no fresh turn
    assert steer(r3, "st-0003", "warmer").json() == first.json()
    assert turns(r3) == turns(r3) and r3.hive.db.one("SELECT 1 FROM ask_turns WHERE operation_id = 'steer:st-0003'") is None
    other = steer(r3, "st-0003", "cooler")
    assert (other.status_code, err(other)["code"]) == (409, "operation_conflict")
    assert ses_row(r3, sid)["next_dir_seq"] == 2


def test_O1_the_steer_frame_and_room_message_stay_in_the_conversation(r3):
    session, sid, m, ack, step = started(r3)
    t = r3.hive.db.one("SELECT * FROM ask_turns WHERE operation_id = ?", (OP,))
    r = steer(r3, "st-0004", "a bluer sky")
    row = steer_row(r3, "st-0004")
    assert row["room_message_id"] and row["seq"] is not None
    thread = r3.hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
    msg = r3.hive.db.one("SELECT * FROM room_messages WHERE id = ?", (row["room_message_id"],))
    assert msg["room_id"] == thread["room_id"] and msg["text"] == "a bluer sky"
    frame = json.loads(r3.hive.db.one("SELECT frame FROM ask_events WHERE turn_id = ? AND seq = ?", (t["id"], row["seq"]))["frame"])
    assert frame["phase"] == "steer" and frame["studio"]["session_id"] == sid and frame["studio"]["seq"] == 1
    assert r.json()["seq"] == row["seq"]


# ---- O1-c: coalesced at the step boundary (plan §4.4) ----------------------------------------------------------------------

def test_O1c_three_steers_during_a_step_push_nothing_and_the_next_step_carries_all_three(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)                                                  # step 1's own cycle started
    inbox = maker_inbox(r3)
    for i, text in enumerate(("bigger headline", "warmer", "add a sun"), 1):
        r = steer(r3, f"st-c{i:03d}", text)
        assert r.status_code == 202 and r.json()["studio"]["seq"] == i
    assert maker_inbox(r3) == inbox                                         # 0 hub messages for 3 remarks
    assert step_row(r3, sid, 2) is None
    assert done(r3, sid, 1, step["execution_id"], more=False).status_code == 200   # no work of its own: only the remarks
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    step2 = step_row(r3, sid, 2)
    assert step2 is not None and json.loads(step2["direction_seqs"]) == [1, 2, 3]
    frames = [f for f in r3.hubs[r3.maker["id"]].frames if f.get("type") == "studio_step" and f["step"] == 2]
    assert len(frames) == 1                                                  # one step message for the batch
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["delivered"] * 3
    c = in_step(r3, sid, step2)
    assert [d["text"] for d in c["directions"]] == ["bigger headline", "warmer", "add a sun"]
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["read"] * 3
    assert maker_inbox(r3) == inbox


def test_O1_a_direction_is_a_direct_trigger_for_the_next_step(r3):
    """r1.5 H3.3: right after a direction is inserted, the session advances (an attempt opens without waiting for a tick)."""
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=False)
    studio(r3).worker.wait_idle(15)
    assert handoff(r3, sid)["state"] == "done"                               # no work: no attempt
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    assert handoff(r3, sid)["state"] == "done"
    assert steer(r3, "st-trig", "warmer").status_code == 202
    h = handoff(r3, sid)
    assert h["step_n"] == 2 and h["state"] != "done"                         # opened by the steer itself


# ---- O1-d: limits (plan §4.6) ------------------------------------------------------------------------------------------

def test_O1d_the_21st_unread_direction_is_429_and_its_words_are_not_stored(r3, monkeypatch):
    from hive.core import ask as ASK
    monkeypatch.setattr(ASK, "PER_MINUTE", 1000)
    session, sid, m, ack, step = started(r3)
    for i in range(20):
        assert steer(r3, f"st-d{i:03d}", f"remark {i}").status_code == 202
    r = steer(r3, "st-d020", "one too many")
    assert (r.status_code, err(r)["code"]) == (429, "rate_limited")
    assert steer_row(r3, "st-d020") is None and ses_row(r3, sid)["next_dir_seq"] == 21


def test_O1d_studio_steers_share_the_persons_per_minute_quota_with_ask_requests(r3):
    from hive.core import ask as ASK
    session, sid, m, ack, step = started(r3)
    import time
    minute_ago = time.time() - 60
    used = r3.hive.db.one("SELECT COUNT(*) AS n FROM ask_turns WHERE principal = ? AND created_at >= ?",
                          (MIA, ASK._iso(minute_ago)))["n"]
    accepted = 0
    for i in range(ASK.PER_MINUTE + 2):
        r = steer(r3, f"st-q{i:03d}", f"remark {i}")
        if r.status_code == 429:
            assert err(r)["code"] == "rate_limited"
            break
        assert r.status_code == 202
        accepted += 1
    assert accepted == ASK.PER_MINUTE - used


def test_O1d_text_over_4000_characters_is_413(r3):
    session, sid, m, ack, step = started(r3)
    r = steer(r3, "st-big1", "x" * 4001)
    assert r.status_code == 413 and steer_row(r3, "st-big1") is None


# ---- K6: paused queues; stopping/stopped refuse; a later turn is ordinary -------------------------------------------------

def test_K6_a_steer_while_paused_queues_and_says_paused(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=False)
    assert control(r3, sid, "pause").status_code == 200
    r = steer(r3, "st-p001", "warmer")
    assert r.status_code == 202 and r.json()["studio"] == {"session_id": sid, "seq": 1, "state": "queued",
                                                          "session_state": "paused"}
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert step_row(r3, sid, 2) is None                                     # paused: nothing is admitted, nothing spent


def test_K6_a_steer_on_a_stopping_or_stopped_session_is_409_and_writes_nothing(r3):
    session, sid, m, ack, step = started(r3)
    stop(r3, sid)
    r = steer(r3, "st-k001", "warmer")
    assert (r.status_code, err(r)["code"]) == (409, "studio_session_closed")
    assert steer_row(r3, "st-k001") is None
    stopped_and_released(r3, sid)
    before = turns(r3)
    r = steer(r3, "st-k002", "warmer")
    assert (r.status_code, err(r)["code"]) == (409, "studio_session_closed")
    assert steer_row(r3, "st-k002") is None and turns(r3) == before         # no fresh turn, no silent queue


def test_K6_a_turn_begun_after_the_session_ended_steers_as_before(r3):
    """Decision (handoff): only turns of the session's own time are bound to it; a later turn on the same thread is an
    ordinary Ask turn again."""
    session, sid, m, ack, step = started(r3)
    stop(r3, sid)
    stopped_and_released(r3, sid)
    set_turn(r3, "answered")
    turn(r3, op="op-mia-turn-02", who=r3.mia, text="something else")
    r = steer(r3, "st-k003", "and also this", op="op-mia-turn-02")
    assert r.status_code == 202, r.text
    row = steer_row(r3, "st-k003")
    assert row["outcome"] == "joined" and row["studio_session_id"] is None


def test_K6_a_steer_while_held_queues_and_says_held(r3):
    session, sid, m, ack, step = started(r3)
    studio(r3)._hold(sid, "maker_unresponsive")
    r = steer(r3, "st-h001", "warmer")
    assert r.status_code == 202 and r.json()["studio"]["session_state"] == "held"
    assert steer_row(r3, "st-h001")["studio_session_id"] == sid


# ---- O1-e: no live session, or Studio off: byte-identical behaviour ---------------------------------------------------------

def test_O1e_without_a_studio_session_a_steer_joins_the_open_turn_as_before(s):
    r = steer(s, "st-e001", "warmer")
    assert r.status_code == 202, r.text
    row = steer_row(s, "st-e001")
    assert row["outcome"] == "joined" and row["delivery_message_id"] and row["studio_session_id"] is None
    assert set(r.json()) == {"steer_id", "operation_id", "turn_id", "new_turn", "seq", "via"}


def test_O1e_with_studio_off_a_live_sessions_turn_steers_exactly_as_before(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    r = steer(r3, "st-e002", "warmer")
    assert r.status_code == 202, r.text
    row = steer_row(r3, "st-e002")
    assert row["outcome"] == "joined" and row["studio_session_id"] is None and row["delivery_message_id"]
    assert set(r.json()) == {"steer_id", "operation_id", "turn_id", "new_turn", "seq", "via"}
    set_turn(r3, "conducting")
    r = steer(r3, "st-e003", "warmer")
    assert (r.status_code, err(r)["code"]) == (404, "not_available")         # the old conducting refusal
    assert ses_row(r3, sid)["next_dir_seq"] == 1


# ---- A15 through the real steer route and the real controls (r1.4 G5c: only this run is acceptance #15) -------------------

def test_A15_real_paused_context_read_then_resume_keeps_queued_directions(r3):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    done(r3, sid, 1, step["execution_id"], more=False)
    r = control(r3, sid, "pause")
    assert (r.status_code, r.json()["state"]) == (200, "paused"), r.text
    assert steer(r3, "st-a001", "bigger headline").status_code == 202
    assert steer(r3, "st-a002", "warmer").status_code == 202
    seen = context(r3, sid).json()                                        # the done execution is fenced: nothing at all
    assert seen["directions"] == []
    prepare(r3, sid)
    assert step_row(r3, sid, 2) is None and hive.studio._latest_handoff(sid)["state"] == "done"   # paused: no attempt
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["queued"] * 2
    r = control(r3, sid, "resume")
    assert (r.status_code, r.json()["state"]) == (200, "active"), r.text
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    step2 = step_row(r3, sid, 2)
    assert step2 is not None and json.loads(step2["direction_seqs"]) == [1, 2]
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["delivered"] * 2
    c = in_step(r3, sid, step2)
    assert [d["text"] for d in c["directions"]] == ["bigger headline", "warmer"]
    assert [d["state"] for d in ledger(r3, sid)["directions"]] == ["read"] * 2


def test_A15_real_context_with_old_execution_id_is_preview_only(r3):
    session, sid, m, ack, step = started(r3)
    assert steer(r3, "st-a003", "warmer").status_code == 202
    r = context(r3, sid, "ex_" + "f" * 24).json()
    assert r["preview"] is True and step_row(r3, sid, 1)["read_at"] is None
    row = steer_row(r3, "st-a003")
    assert (row["outcome"], row["studio_session_id"], row["studio_read_at"]) == ("studio", sid, None)


# ---- pause / resume (plan §3.3, r1.1 S5, K10; r1.8 L2.4) ---------------------------------------------------------------------

def test_pause_lets_the_open_step_finish_and_admits_nothing_new_until_resume(r3):
    session, sid, m, ack, step = started(r3)
    c = in_step(r3, sid, step)
    r = control(r3, sid, "pause", cid="pause-0001")
    assert (r.status_code, r.json()["state"]) == (200, "paused")
    assert control(r3, sid, "pause", cid="pause-0001").json() == r.json()        # idempotent per control_id
    assert ses_row(r3, sid)["state_reason"] == "paused_by_person"
    assert publish(r3, session, step["execution_id"], parent=c["parent"]).status_code == 200   # the open step goes on
    assert done(r3, sid, 1, step["execution_id"], more=True).status_code == 200
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": step_row(r3, sid, 1)["proposal_n"],
            "digest": step_row(r3, sid, 1)["proposal_digest"]}
    ack2 = upload(r3, sid, m, 2, gen=2).json()
    assert outcome(r3, sid, 1, m, prop, ack2).status_code == 200
    drive(r3)
    assert step_row(r3, sid, 2) is None and handoff(r3, sid)["state"] == "done"
    r = control(r3, sid, "resume", cid="resume-001")
    assert (r.status_code, r.json()["state"]) == (200, "active")
    upload(r3, sid, m, 3, gen=3)
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_resume_rechecks_the_binding_and_a_drift_needs_a_new_consent(r3):
    session, sid, m, ack, step = started(r3)
    control(r3, sid, "pause")
    r3.hive.db.execute("UPDATE agents SET model = 'openrouter/test/other' WHERE id = ?", (r3.maker["id"],))
    r = control(r3, sid, "resume")
    assert (r.status_code, err(r)["code"]) == (409, "model_drift")
    assert ses_row(r3, sid)["state"] == "paused"


def test_resume_rechecks_the_consent_payload(r3):
    """K10: the monthly total the person confirmed changed: resume needs a new intent."""
    session, sid, m, ack, step = started(r3)
    control(r3, sid, "pause")
    assert r3.client.put("/api/me/key-limits/self", headers=r3.mia, json={"month_usd": 9}).status_code == 200
    r = control(r3, sid, "resume")
    assert (r.status_code, err(r)["code"]) == (409, "consent_mismatch")
    assert ses_row(r3, sid)["state"] == "paused"


def test_resume_rechecks_the_budget(r4):
    session, sid, m, ack, step = started(r4)
    r4.hive.db.execute("UPDATE studio_sessions SET step_cap_usd = 0.001 WHERE id = ?", (sid,))
    assert chat(r4).status_code == 402
    assert (ses_row(r4, sid)["state"], ses_row(r4, sid)["state_reason"]) == ("paused", "budget_exhausted")
    r4.hive.db.execute("UPDATE studio_sessions SET cap_usd = 0.0001 WHERE id = ?", (sid,))      # no room for a step left
    r4.hive.db.execute("UPDATE studio_sessions SET step_cap_usd = 0.25 WHERE id = ?", (sid,))
    r = control(r4, sid, "resume")
    assert (r.status_code, err(r)["code"]) == (402, "budget_exhausted")
    assert ses_row(r4, sid)["state"] == "paused"


def test_resume_is_refused_while_stopping_and_from_held(r3):
    session, sid, m, ack, step = started(r3)
    studio(r3)._hold(sid, "maker_unresponsive")
    r = control(r3, sid, "resume")
    assert (r.status_code, err(r)["code"]) == (409, "not_paused")
    r = control(r3, sid, "pause")
    assert (r.status_code, err(r)["code"]) == (409, "not_active")
    stop(r3, sid)
    r = control(r3, sid, "resume")
    assert r.status_code == 409 and err(r)["code"] in ("studio_stopping", "session_closed")
    stopped_and_released(r3, sid)
    r = control(r3, sid, "resume")
    assert (r.status_code, err(r)["code"]) == (409, "session_closed")


def test_pause_and_resume_with_studio_off_are_404_and_change_nothing(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    before = ses_row(r3, sid)
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    for action in ("pause", "resume"):
        r = control(r3, sid, action)
        assert (r.status_code, err(r)["code"]) == (404, "not_available")
        r = r3.client.post(f"/api/studio-sessions/{sid}/controls", headers=r3.mg,
                           json={"control_id": "badbody-01", "action": action, "junk": 1})
        assert r.status_code == 404                                          # before any body check
    assert ses_row(r3, sid) == before


# ---- Stop's confirmation (plan §5, §8 S-a..c, r1.8 L2) -------------------------------------------------------------------------

def test_Sa_stop_with_a_dispatched_call_is_stopping_with_one_in_flight_then_stopped_after_it_settles(r4):
    session, sid, m, ack, step = started(r4)
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)
    assert entered.wait(15)
    r = stop(r4, sid)
    assert r.json()["stop"]["in_flight"] == 1 and r.json()["stop"]["fenced_at"]
    drive(r4)
    view = ledger(r4, sid)["stop"]
    assert (ledger(r4, sid)["state"], view["in_flight"]) == ("stopping", 1)
    go.set()
    t.join(15)
    assert out["r"].status_code == 200
    stopped_and_released(r4, sid)
    view = ledger(r4, sid)["stop"]
    assert (view["state"], view["in_flight"], view["unknown_usd"]) == ("stopped", 0, 0)
    [res] = reservations_of(r4)
    assert res["state"] == "settled"


def test_Sb_stop_with_a_call_that_never_answers_ends_stopped_with_unknown_billing_not_released(r4):
    session, sid, m, ack, step = started(r4)
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)
    assert entered.wait(15)
    stop(r4, sid)
    drive(r4)
    r4.hive.db.execute("UPDATE studio_sessions SET settle_deadline = ? WHERE id = ?", (past(), sid))
    stopped_and_released(r4, sid)
    view = ledger(r4, sid)["stop"]
    assert view["state"] == "stopped" and view["in_flight"] == 0 and view["unknown_usd"] > 0
    [res] = reservations_of(r4)
    assert res["state"] == "unknown"                                          # a liability, never released or refunded
    go.set()
    t.join(15)


def test_Sc_stop_is_idempotent_cancels_the_goal_and_settles_it_as_the_host(r3):
    session, sid, m, ack, step = started(r3)
    gid = session["goal_id"]
    first = control(r3, sid, "stop", cid="stop-00001")
    assert first.status_code == 200
    assert control(r3, sid, "stop", cid="stop-00001").json() == first.json()
    assert r3.hive.db.one("SELECT status FROM goals WHERE id = ?", (gid,))["status"] == "cancelled"
    row = ses_row(r3, sid)
    assert row["fenced_at"] and row["stop_control_id"] == "stop-00001"
    # R8.5: the host settles the goal at Stop; the maker is told nothing (a stored notice ate its next session's step)
    assert ledger(r3, sid)["stop"]["cancel_ack"] == "settled"
    stopped_and_released(r3, sid)
    assert r3.hive.db.one("SELECT 1 FROM messages WHERE agent_id = ? AND text LIKE ?",
                          (r3.maker["id"], f"%GOAL-CANCELLED {gid}%")) is None
    agent = r3.hive.db.one("SELECT desired FROM agents WHERE id = ?", (r3.maker["id"],))
    assert agent["desired"] == "asleep"                                       # r1.8 L2: Stop leaves it asleep, released
    r = r3.client.post(f"/api/agent/goals/{gid}/cancel-ack", headers=maker_headers(r3))
    assert r.status_code == 200, r.text                                       # a late ack is harmless and changes nothing
    assert ledger(r3, sid)["stop"]["cancel_ack"] == "settled"


def test_window_expiry_runs_the_same_stop_as_control_expiry(r3):
    session, sid, m, ack, step = started(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET expires_at = ? WHERE id = ?", (past(), sid))
    stopped_and_released(r3, sid)
    c = r3.hive.db.one("SELECT * FROM studio_controls WHERE session_id = ? AND control_id = 'expiry'", (sid,))
    assert c is not None and c["action"] == "stop"
    assert r3.hive.db.one("SELECT status FROM goals WHERE id = ?", (session["goal_id"],))["status"] == "cancelled"


def test_window_expiry_does_nothing_with_studio_off(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET expires_at = ? WHERE id = ?", (past(), sid))
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    tick(r3)
    assert ses_row(r3, sid)["state"] == "active"
    assert r3.hive.db.one("SELECT 1 FROM studio_controls WHERE session_id = ?", (sid,)) is None


# ---- release path (a): a new session never takes a maker Studio still owns or a fenced execution (r1.2 E2(a)) -----------

def test_E2a_a_new_session_is_refused_while_a_held_session_still_owns_the_maker(r3):
    session, sid, m, ack, step = started(r3)
    studio(r3)._hold(sid, "maker_unresponsive")
    set_turn(r3, "answered")
    turn(r3, op="op-mia-turn-02", who=r3.mia, text="another")
    r = record(r3, op="op-mia-turn-02")
    assert r.status_code in (200, 201), r.text
    second = submit(r3, r.json()["intent_id"])
    assert (second.status_code, err(second)["code"]) == (409, "maker_busy")
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_sessions")["n"] == 1


def test_E2a_a_new_session_is_refused_while_the_makers_current_execution_is_fenced(s):
    hive = s.hive
    epoch = hive.db.one("SELECT token_epoch FROM agents WHERE id = ?", (s.maker["id"],))["token_epoch"]
    hive.db.execute("INSERT INTO studio_fenced_executions (maker_id, token_epoch, execution, session_id, step, reason, at) "
                    "VALUES (?,?,?,?,?,?,?)", (s.maker["id"], epoch, "local:1:1", "ss_" + "0" * 24, 1, "stopped", now()))
    r = submit(s, record(s).json()["intent_id"])
    assert (r.status_code, err(r)["code"]) == (409, "execution_fenced")
    assert hive.db.one("SELECT COUNT(*) AS n FROM studio_sessions")["n"] == 0


# ---- the self-check (r1.3 F4, r1.4 G5d, handoff spec r2.4 §8.8) -----------------------------------------------------------

def test_R5_the_controls_item_passes_and_off_a_mac_the_self_check_passes_with_studio_still_off_by_default(s, monkeypatch):
    from hive.core import studio_sessions as SS
    studio = s.hive.studio
    assert {"pause", "resume", "stop"} <= set(studio.CONTROL_ACTIONS)
    monkeypatch.setattr(SS, "host_platform", lambda: "linux")
    monkeypatch.delenv("HIVE_STUDIO_SESSIONS", raising=False)
    assert studio.self_check() == (False, [])                                # every part present, the setting off
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    assert studio.self_check() == (True, [])


def test_R5_a_fresh_hive_off_a_mac_turns_on_only_when_asked(monkeypatch, tmp_path):
    from hive.core import studio_sessions as SS
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    monkeypatch.setattr(SS, "host_platform", lambda: "linux")

    def fresh(sub):
        return create_app(load_settings(data_dir=pathlib.Path(tmp_path / sub), admin_password="pw", petta_path=PETTA),
                          supervisor=FakeSupervisor(), reconcile_seconds=0).state.hive.studio
    monkeypatch.delenv("HIVE_STUDIO_SESSIONS", raising=False)
    off = fresh("a")
    assert (off.enabled, off.missing) == (False, [])
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    on = fresh("b")
    assert (on.enabled, on.missing) == (True, [])


def test_R5_on_a_mac_only_the_safe_restart_override_is_missing_and_the_adopted_script_does_not_carry_one(s, monkeypatch):
    """Handoff spec r2.4 §8.8: a Mac hive needs a reviewed safe-restart.sh carrying an exact-commit awake override. The
    adopted script (TRY_SLEEP_ONCE) asks minds to sleep through restart-prepare, which a Studio-owned maker refuses, and
    has no exact-commit override, so its hash is not adopted and Studio stays off on a Mac."""
    from hive.core import studio_sessions as SS
    if not SAFE_RESTART.exists():
        pytest.skip("no adopted hive-local/safe-restart.sh on this machine")
    digest = hashlib.sha256(SAFE_RESTART.read_bytes()).hexdigest()
    assert digest not in SS.MAC_SAFE_RESTART_OVERRIDE_HASHES
    text = SAFE_RESTART.read_text()
    assert "ALLOW_AWAKE" not in text                                          # no exact-commit awake override in it
    monkeypatch.setattr(SS, "host_platform", lambda: "darwin")
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    assert s.hive.studio.self_check() == (False, ["mac safe-restart exact-commit override"])


# ---- Kimi R3.2 F2: one status probe per maker -------------------------------------------------------------------------------

def test_F2_a_parked_status_read_never_starts_a_second_thread_for_the_same_maker(r3, monkeypatch):
    from hive.core import studio_handoff as SH
    monkeypatch.setattr(SH, "STATUS_TIMEOUT_S", 0.2)
    gate, entered = r3.driver.park("status", r3.maker["id"])
    st = studio(r3)
    assert st._status_word(r3.maker["id"]) == "unknown"
    assert entered.wait(5)
    assert st._status_word(r3.maker["id"]) == "unknown"
    assert st._status_word(r3.maker["id"]) == "unknown"
    name = f"studio-status-{r3.maker['id']}"
    assert sum(1 for t in threading.enumerate() if t.name == name) == 1
    gate.set()
    assert wait_for(lambda: not any(t.name == name for t in threading.enumerate()), 5)
    assert st._status_word(r3.maker["id"]) in SH.StudioHandoffs.STATUS_WORDS


# ---- OI-7: the maker's tools (hive/templates/iter/tools) ----------------------------------------------------------------------

TOOLS = pathlib.Path(__file__).resolve().parents[1] / "templates" / "iter" / "tools"


def tool(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def recording(monkeypatch, module, answer=None):
    calls = []

    def call(method, path, payload=None, timeout=4):
        calls.append((method, path, payload))
        return (answer if answer is not None else {}), None
    monkeypatch.setattr(module._hive, "call", call)
    return calls


@pytest.mark.parametrize("name", ["hive_studio_context", "hive_studio_publish", "hive_studio_done"])
def test_OI7_the_maker_tools_exist_in_the_iter_template(name):
    module = tool(name)
    assert isinstance(module.DESCRIPTION, str) and module.DESCRIPTION and callable(module.run)


def test_OI7_publish_sends_the_body_unchanged_with_execution_id_and_the_bodys_op_ids_outside_it(monkeypatch):
    module = tool("hive_studio_publish")
    calls = recording(monkeypatch, module, {"artifact_id": "ar_x", "revision": 3, "digest": "sha256:" + "a" * 64})
    body = json.dumps({"schema": "omega-maker-revision-2", "items": [{"op_id": "op-b", "x": 1}, {"op_id": "op-a"}]})
    out = module.run("ar_x", body, "ex_" + "1" * 24, "2")
    assert calls == [("POST", "/api/agent/artifacts/ar_x/revisions",
                      {"body": body, "parent": 2, "execution_id": "ex_" + "1" * 24, "op_ids": ["op-b", "op-a"]})]
    assert "r3" in out
    calls.clear()
    module.run("ar_x", body, "ex_" + "1" * 24, "")
    assert calls[0][2]["parent"] is None


@pytest.mark.parametrize("items", [[], [{"op_id": "a"}, {"op_id": "a"}], [{"op_id": f"op-{i}"} for i in range(17)],
                                   [{"op_id": 3}], [{"x": 1}], "nope"])
def test_OI7_publish_refuses_a_body_without_1_to_16_distinct_op_ids_and_sends_nothing(monkeypatch, items):
    module = tool("hive_studio_publish")
    calls = recording(monkeypatch, module)
    out = module.run("ar_x", json.dumps({"schema": "omega-maker-revision-2", "items": items}), "ex_" + "1" * 24, "")
    assert calls == [] and out.startswith("REFUSED")
    assert module.run("ar_x", "not json", "ex_" + "1" * 24, "").startswith("REFUSED") and calls == []


def test_OI7_context_and_done_call_the_maker_routes(monkeypatch):
    ctx = tool("hive_studio_context")
    calls = recording(monkeypatch, ctx, {"state": "active"})
    ctx.run("ss_" + "a" * 24, "ex_" + "1" * 24, "4")
    assert calls == [("GET", f"/api/agent/studio-sessions/ss_{'a' * 24}/context?execution_id=ex_{'1' * 24}&after_dir=4", None)]
    fin = tool("hive_studio_done")
    calls = recording(monkeypatch, fin, {"n": 2, "state": "finished"})
    fin.run("ss_" + "a" * 24, "2", "ex_" + "1" * 24, "false")
    assert calls == [("POST", f"/api/agent/studio-sessions/ss_{'a' * 24}/steps/2/done",
                      {"more": False, "execution_id": "ex_" + "1" * 24})]


def test_OI7_the_tools_run_a_real_step_end_to_end_over_the_maker_rest_routes(r3, monkeypatch):
    """The tools use the template's _hive.call (REST with the execution's own HIVE_TOKEN): exactly the transport R3 requires
    for context/publication/done (hub-only governs message consumption, Hive.inbox; done is REST only, r1.4 G2)."""
    session, sid, m, ack, step = started(r3)

    def via_host(method, path, payload=None, timeout=4):
        r = r3.client.request(method, path, headers=maker_headers(r3), json=payload)
        if r.status_code >= 400:
            e = r.json().get("error", {})
            return None, f"HIVE-ERROR {e.get('code')}: {e.get('message')}"
        return r.json(), None
    ctx, pub, fin = tool("hive_studio_context"), tool("hive_studio_publish"), tool("hive_studio_done")
    for module in (ctx, pub, fin):
        monkeypatch.setattr(module._hive, "call", via_host)
    seen = json.loads(ctx.run(sid, step["execution_id"], ""))
    assert seen["preview"] is False and seen["step"]["n"] == 1
    body = json.dumps({"schema": "omega-maker-revision-2", "items": [{"op_id": "op-tool-1"}]})
    out = pub.run(session["proposal_artifact_id"], body, step["execution_id"], "" if seen["parent"] is None else seen["parent"])
    assert not out.startswith(("HIVE-ERROR", "REFUSED")), out
    s1 = step_row(r3, sid, 1)
    assert s1["proposal_n"] is not None and json.loads(s1["op_ids"]) == ["op-tool-1"]
    out = fin.run(sid, "1", step["execution_id"], "true")
    assert not out.startswith("HIVE-ERROR"), out
    assert step_row(r3, sid, 1)["state"] == "finished"


# ---- r5.1 (stand-in R5 P1; Kimi R5 #1, #2; stand-in follow-up) ------------------------------------------------------------

def test_r51_a_goal_cancelled_event_after_release_never_wakes_or_restarts_the_maker(r4, monkeypatch):
    """Stand-in R5 P1: Stop's goal event runs independently of job S. When it lands after the release (the maker is then
    an ordinary sleeping mind on a fresh, unfenced credential): no wake, no start, no paid call. R8.5: it is the goal's
    update event only; the maker is sent no GOAL-CANCELLED (Stop settled the goal as the host)."""
    st = studio(r4)
    session, sid, m, ack, step = started(r4)
    gid = session["goal_id"]
    delayed, real = [], st._goal_cancelled
    monkeypatch.setattr(st, "_goal_cancelled", lambda goal_id: delayed.append(goal_id))   # hold the event back
    stop(r4, sid)
    stopped_and_released(r4, sid)
    assert delayed == [gid]
    starts = r4.driver.calls.count(("start", r4.maker["id"]))
    reservations = r4.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]
    on_loop(r4, asyncio_wrap(real), gid)                      # the event, after the release
    drive(r4)
    r4.sup.check()
    assert r4.hive.db.one("SELECT 1 FROM messages WHERE agent_id = ? AND text LIKE ?",
                          (r4.maker["id"], f"%GOAL-CANCELLED {gid}%")) is None     # nothing queued to pre-empt later
    assert r4.driver.calls.count(("start", r4.maker["id"])) == starts                   # never woken or restarted
    agent = r4.hive.db.one("SELECT status, desired FROM agents WHERE id = ?", (r4.maker["id"],))
    assert (agent["status"], agent["desired"]) == ("asleep", "asleep")
    assert r4.hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == reservations and r4.transport.sent == []


def asyncio_wrap(fn):
    async def go(*args):
        return fn(*args)
    return go


def test_r51_a_dispatched_call_is_stamped_with_the_session_and_step_labels_and_counts_in_flight(r4):
    """Kimi R5 #1: the reservation of a Studio call carries both studio:<sid> and studiostep:<sid>:<n> in
    cost_reservation_scopes, so the Stop view's in_flight / unknown_usd (read on studio:<sid>) see it."""
    from hive.core.studio_sessions import scope_label, step_label
    session, sid, m, ack, step = started(r4)
    entered, go = threading.Event(), threading.Event()
    r4.transport.park[r4.maker["id"]] = (entered, go)
    t, out = in_thread(chat, r4)
    assert entered.wait(15)
    [res] = reservations_of(r4)
    assert res["state"] == "dispatched" and {scope_label(sid), step_label(sid, 1)} <= set(res["scopes"])
    assert studio(r4).stop_view(ses_row(r4, sid))["in_flight"] == 1
    go.set()
    t.join(15)
    assert studio(r4).stop_view(ses_row(r4, sid))["in_flight"] == 0


def test_r51_an_outcome_reported_after_stop_is_a_receipt_only(r3):
    """Stand-in R5 follow-up, pinned (plan §3.3: "accepted after Stop only for a revision published before the fence"):
    the person's frame may still report the outcome of a proposal published before Stop, while its mount is current. It
    is recorded as a frame-reported receipt, so the lineage is complete; it admits nothing, opens no attempt and does not
    change the session's state. A revision after the fence is refused, so no later proposal can get here."""
    session, sid, m, ack, step = started(r3)
    c = in_step(r3, sid, step)
    assert publish(r3, session, step["execution_id"], parent=c["parent"]).status_code == 200
    s1 = step_row(r3, sid, 1)
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": s1["proposal_n"], "digest": s1["proposal_digest"]}
    ack2 = upload(r3, sid, m, 2, gen=2).json()
    stop(r3, sid)
    assert publish(r3, session, step["execution_id"]).status_code == 409             # nothing new after the fence
    state = ses_row(r3, sid)["state"]
    rows = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    r = outcome(r3, sid, 1, m, prop, ack2)
    assert r.status_code == 200 and r.json()["frame_reported"] is True, r.text
    assert step_row(r3, sid, 1)["outcome"] == "applied" and step_row(r3, sid, 2) is None
    assert ses_row(r3, sid)["state"] in (state, "stopped")                          # Stop goes on; never re-opened
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"] == rows
    stopped_and_released(r3, sid)
    assert step_row(r3, sid, 2) is None


def test_r51_a_status_probe_that_answers_during_the_wait_is_used_and_no_second_thread_starts(r3, monkeypatch):
    """Kimi R5 #2: while the earlier probe is alive nothing new starts; when it answers during the wait, its answer is
    the word."""
    from hive.core import studio_handoff as SH
    monkeypatch.setattr(SH, "STATUS_TIMEOUT_S", 0.3)
    gate, entered = r3.driver.park("status", r3.maker["id"])
    st = studio(r3)
    name = f"studio-status-{r3.maker['id']}"
    assert st._status_word(r3.maker["id"]) == "unknown"
    threading.Timer(0.1, gate.set).start()                                  # answers inside the next call's wait
    assert st._status_word(r3.maker["id"]) == "running"
    assert sum(1 for t in threading.enumerate() if t.name == name) == 0
