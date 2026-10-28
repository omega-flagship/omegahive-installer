"""J3 host R8.5: a stopped Studio session's goal no longer lingers to eat the maker's next session.

Live on the cloud, 2026-10-20: a member's own Studio maker (the copied Design Director role, "*" deny) ran session 1; Stop
cancelled its goal and queued "[GOAL-CANCELLED g_...] ... stop and acknowledge with cancel-ack" for the maker (stored,
wake=False). When session 2 started, the maker read that notice first and spent its whole first step (180 s) trying
hive-goal-cancel-ack, which its role denies; it never read the new step's context and step 1 timed out unread.

R8.5 (host only, no new grant): Stop settles the session's own goal as the host in the fence's transaction (status
cancelled with cancel_ack_at / cancel_ack_by = the host actor), and sends the maker no GOAL-CANCELLED (its step is fenced
and job S stops it; there is nothing for it to do). A Studio session's own goal-cancelled notice already stored before
R8.5 is never delivered to that session's maker (live delivery and hub replay alike; the stored row is kept). Nothing else
changes: the maker still cannot ack another mind's goal, its role still denies hive-goal-cancel-ack, and every other
cancelled goal is told and acknowledged as before. Synthetic only: temporary data directories, the R3 fake driver and
stand-in hub, invented keys, no provider call, no live hive."""
import json

from hive.core.studio_makers import HOST_ACTOR
from hive.tests.test_studio_session_r3 import (connect, drive, maker_headers, mount, on_loop, ses_row, step_row,  # noqa: F401
                                               upload)
from hive.tests.test_studio_session_r3_handoff import control, stopped_and_released  # noqa: F401
from hive.tests.test_studio_session_r7 import (card, deny_all_role, modes, open_personal, personal_world, pr, p,  # noqa: F401
                                               record_card)
from hive.tests.test_studio_session_r3 import r3  # noqa: F401  (fixture)
from hive.tests.test_ask_intents import a, turn  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import err, s, submit  # noqa: F401

ACK = "hive-goal-cancel-ack"


def admitted(x, session):
    sid = session["session_id"]
    m = mount(x, sid, session["stream_id"]).json()
    upload(x, sid, m, 1)
    drive(x)
    step = step_row(x, sid, 1)
    assert step is not None and step["state"] == "admitted", ses_row(x, sid)["state_reason"]
    return sid, step


def notice_for(gid):
    return {"sender": "hive:goals", "extra": json.dumps({"event": "goal_cancelled", "goal_id": gid})}


def stop_session_one(x):
    session = open_personal(x)
    sid, _ = admitted(x, session)
    assert control(x, sid, "stop").status_code == 200
    stopped_and_released(x, sid)
    return session, sid


def open_second(x):
    x.hive.db.execute("UPDATE ask_turns SET state = 'answered' WHERE operation_id = 'op-mia-turn-01'")
    turn(x, op="op-mia-turn-02", who=x.mia, text="another poster")
    r = submit(x, record_card(x, card(x), op="op-mia-turn-02").json()["intent_id"])
    assert r.status_code == 201, r.text
    return r.json()


def goal(x, gid):
    return x.hive.db.one("SELECT * FROM goals WHERE id = ?", (gid,))


def notices(x, agent_id, gid):
    return x.hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in' AND text LIKE ?",
                         (agent_id, f"%GOAL-CANCELLED {gid}%"))


def hub_texts(x, agent_id):
    return [f.get("text", "") for f in x.hubs[agent_id].frames if f.get("type") == "user_message"]


def pending_cancels(x, agent_id):
    """Cancelled goals held by or assigned to the mind that nothing has acknowledged: what would await its ack."""
    return x.hive.db.all("SELECT id FROM goals WHERE status = 'cancelled' AND cancel_ack_at IS NULL AND "
                         "(claimed_by = ? OR assignee = ?)", (agent_id, agent_id))


def other_goal(x, assignee, title="Unrelated task"):
    swarm = x.hive.db.one("SELECT swarm_id FROM agents WHERE id = ?", (assignee,))["swarm_id"]
    g = x.hive.goals._create_record(swarm, title, "", 0.5, None, "user:operator", assignee)
    x.hive.goals.update(g["id"], {"status": "cancelled"})
    return g["id"]


# ---- 1. stop session 1, start session 2: nothing awaits the maker's ack, nothing pre-empts step 1 ------------------------

def test_R85_a_stop_then_a_new_session_leaves_the_maker_no_pending_cancelled_goal_and_no_notice(pr):
    deny_all_role(pr)
    hive, maker = pr.hive, pr.maker["id"]
    session, sid = stop_session_one(pr)
    gid = session["goal_id"]
    g = goal(pr, gid)
    assert g["status"] == "cancelled"
    assert g["cancel_ack_at"] and g["cancel_ack_by"] == HOST_ACTOR          # settled by the host at Stop
    assert pending_cancels(pr, maker) == []
    assert notices(pr, maker, gid) == []                                   # nothing stored to pre-empt a later session
    assert hive.studio.stop_view(ses_row(pr, sid))["cancel_ack"] == "settled"   # never "the maker acknowledged"
    second = open_second(pr)
    sid2, step = admitted(pr, second)
    on_loop(pr, hive.replay, maker, 0)                                     # the real hub's hello replays from 0
    assert not [t for t in hub_texts(pr, maker) if "GOAL-CANCELLED" in t]
    assert pending_cancels(pr, maker) == []
    assert step_row(pr, sid2, 1)["state"] == "admitted"
    # no grant was widened: the role still denies the ack skill to the live maker
    assert modes(pr, maker, (ACK,)) == {ACK: "deny"}
    assert hive.policy.authorize(hive.agent(maker), f'({ACK} "{gid}")')["decision"] == "deny"


def test_R85_b_a_notice_stored_before_R85_for_an_ended_sessions_goal_never_reaches_the_maker_others_still_do(pr):
    """The cloud's g_1ee2c808 case: a GOAL-CANCELLED for session 1's goal already sits in the maker's hub outbox. It is
    not delivered (live or by replay) to the maker of that (stopped) session; the stored row is kept. A cancelled goal that is
    not a Studio session's own goal still reaches the same maker."""
    hive, maker = pr.hive, pr.maker["id"]
    session, sid = stop_session_one(pr)
    gid = session["goal_id"]
    hive.db.execute("UPDATE goals SET cancel_ack_at = NULL, cancel_ack_by = NULL WHERE id = ?", (gid,))   # pre-R8.5 row
    legacy = hive.enqueue_message(maker, f"[GOAL-CANCELLED {gid}] Poster - stop and acknowledge with cancel-ack", None,
                                  "hive:goals", {"event": "goal_cancelled", "goal_id": gid})
    # R8.5 r1 (Kimi): while the goal is unsettled its notice is NOT dropped (a cancel ack is never silently owed) ...
    assert hive.studio.stale_goal_notice(maker, legacy) is False
    # ... and the next start's recovery settles a stopped session's cancelled goal as the host, once
    from hive.core import studio_sessions as SS
    with hive.db.transaction() as tx:
        assert SS.recover_startup(tx) >= 1
    assert (goal(pr, gid)["cancel_ack_by"]) == HOST_ACTOR
    with hive.db.transaction() as tx:
        SS.recover_startup(tx)                       # idempotent: an already settled goal is left alone
    assert (goal(pr, gid)["cancel_ack_by"]) == HOST_ACTOR
    unrelated = other_goal(pr, maker)
    on_loop(pr, hive.goals.notify_cancelled, unrelated)
    second = open_second(pr)
    admitted(pr, second)
    on_loop(pr, hive.replay, maker, 0)
    texts = hub_texts(pr, maker)
    assert not [t for t in texts if f"GOAL-CANCELLED {gid}" in t]
    assert [t for t in texts if f"GOAL-CANCELLED {unrelated}" in t]        # an ordinary cancel is still told
    assert hive.db.one("SELECT 1 FROM messages WHERE id = ?", (legacy["id"],)) is not None   # the record is kept
    assert hive.studio.stale_goal_notice(maker, legacy) is True
    assert hive.studio.stale_goal_notice(pr.template["id"], legacy) is False   # only to that session's own maker


# ---- 2. the maker cannot ack another mind's goal ------------------------------------------------------------------------

def test_R85_c_the_maker_cannot_ack_another_minds_cancelled_goal(pr):
    hive, maker = pr.hive, pr.maker["id"]
    session, sid = stop_session_one(pr)
    theirs = other_goal(pr, pr.template["id"], "The template's task")
    r = pr.client.post(f"/api/agent/goals/{theirs}/cancel-ack", headers=maker_headers(pr))
    assert r.status_code == 403 and err(r)["code"] == "forbidden", r.text
    assert goal(pr, theirs)["cancel_ack_at"] is None
    deny_all_role(pr)
    assert hive.policy.authorize(hive.agent(maker), f'({ACK} "{theirs}")')["decision"] == "deny"
    # its own (host-settled) session goal: an ack is harmless and changes nothing recorded
    before = goal(pr, session["goal_id"])
    r = pr.client.post(f"/api/agent/goals/{session['goal_id']}/cancel-ack", headers=maker_headers(pr))
    assert r.status_code == 200, r.text
    after = goal(pr, session["goal_id"])
    assert (after["cancel_ack_at"], after["cancel_ack_by"]) == (before["cancel_ack_at"], HOST_ACTOR)


# ---- 3. non-Studio minds are unaffected ---------------------------------------------------------------------------------

def test_R85_d_an_ordinary_minds_cancelled_goal_is_told_and_awaits_its_own_ack_as_before(pr):
    hive = pr.hive
    other = pr.template["id"]
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (other,))   # a running mind
    hub = connect(pr, other, pr.template["token"])
    assert hub is not None
    gid = other_goal(pr, other, "Ordinary work")
    on_loop(pr, hive.goals.notify_cancelled, gid)
    assert len(notices(pr, other, gid)) == 1
    assert [f for f in hub.frames if f.get("type") == "user_message" and f"GOAL-CANCELLED {gid}" in f.get("text", "")]
    assert goal(pr, gid)["cancel_ack_at"] is None                         # nothing settles it for the mind
    assert [r["id"] for r in pending_cancels(pr, other)] == [gid]
    r = pr.client.post(f"/api/agent/goals/{gid}/cancel-ack", headers={"Authorization": f"Bearer {pr.template['token']}"})
    assert r.status_code == 200, r.text
    g = goal(pr, gid)
    assert g["cancel_ack_at"] and g["cancel_ack_by"] == other
    assert hive.studio.stale_goal_notice(other, notice_for(gid)) is False


def test_R85_e_while_its_session_is_live_the_sessions_own_goal_notice_is_still_delivered(pr):
    """Only a stopping or ended session's notice is stale. A live session's goal cancelled by another path (a person
    cancelling the goal itself) still reaches its maker as before."""
    hive, maker = pr.hive, pr.maker["id"]
    session = open_personal(pr)
    admitted(pr, session)
    assert hive.studio.stale_goal_notice(maker, notice_for(session["goal_id"])) is False
    assert control(pr, session["session_id"], "stop").status_code == 200
    assert hive.studio.stale_goal_notice(maker, notice_for(session["goal_id"])) is True     # stopping: stale from here
