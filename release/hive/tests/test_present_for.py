# Purpose: test Hive.present_for, the person whose own live work a mind's call is part of (their session, the request
# a team spawned it for, their live Create plan, their live Code request's second opinion, or their message it hasn't
# answered yet), and that a mind acting on its own has none.
import datetime

from hive.core.ask import ask_limits
from hive.core.create_plan_engine import goal_creator
from hive.core.db import now, stamp_of
from hive.tests.test_code_controller_engine import (  # noqa: F401  (x: fixture)
    ORIGIN, add_reviewer, fake, helper_finishes, reviewer_finishes, run, x)
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_proposal_tests import SUGGESTION
from hive.tests.test_visibility import person


def plan_run(h, person, phase="building"):
    """A Create plan's run as CreatePlanEngine.start records it (the reducer isn't run: only its row is read here)."""
    pid = "plan_" + "0a" * 16
    h.db.insert("create_plan_runs", {"plan_id": pid, "person": person, "sentence": "a tip calculator", "epoch": "ep-test",
                                     "reducer_sha256": "0" * 64, "review_policy": "review-required", "lease": 1,
                                     "piece_cap": 1, "fix_cap": 1, "phase": phase, "status": "building",
                                     "created_at": now(), "updated_at": now()})
    return pid


def test_a_mind_is_a_persons_own_work_while_their_session_or_live_plan_holds_it(client):
    h = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    mind, person = h.agent(a["id"]), "user:u_0a0b0c0d"
    assert h.present_for(mind) is None                                   # on its own
    pid = plan_run(h, person)
    goal = h.goals._create_record(swarm["id"], f"Create plan {pid}: plan", created_by=goal_creator(pid), assignee=a["id"],
                                emit=False)
    h.settings.create_plan_engine = False                                # HIVE_CREATE_PLAN_ENGINE=off
    assert h.present_for(mind) is None                                   # the plan engine is off: no plan is live
    h.settings.create_plan_engine = True
    assert h.present_for(mind) == person and h.present_for(h.agent(b["id"])) is None
    assert h.user_for(mind) == h.user_for(h.agent(b["id"]))              # who it's for and pays is unchanged
    for status, waited in (("claimed", True), ("waiting", True), ("stalled", True), ("submitted", False),
                           ("done", False), ("failed", False), ("cancelled", False), ("open", True)):
        h.db.execute("UPDATE goals SET status = ? WHERE id = ?", (status, goal["id"]))
        assert (h.present_for(mind) == person) is waited, status          # answered or ended: the plan no longer waits
    for phase, live in (("ready-to-deploy", True), ("deployed", False), ("stopped", False)):
        h.db.execute("UPDATE create_plan_runs SET phase = ? WHERE plan_id = ?", (phase, pid))
        assert (h.present_for(mind) == person) is live, phase
    h.goals._create_record(swarm["id"], "my own idea", created_by=f"agent:{b['id']}", assignee=b["id"], emit=False)
    h.db.execute("UPDATE create_plan_runs SET phase = 'building' WHERE plan_id = ?", (pid,))
    assert h.present_for(h.agent(b["id"])) is None                       # a goal no plan gave it is the mind's own
    h.db.insert("work_sessions", {"id": "ws_0a0b0c0d", "room_id": "r", "agent_id": b["id"], "owner": "user:u_0e0f0a0b",
                                  "title": "pairing", "budget_usd": 1.0, "spent_at_start": 0.0, "created_at": now()})
    assert h.present_for(h.agent(b["id"])) == "user:u_0e0f0a0b" == h.user_for(h.agent(b["id"]))   # a Session holds it


def test_a_code_requests_helper_and_second_opinion_are_its_persons_own_work_until_they_are_done_with_it(x, monkeypatch):
    """The real engine drives a Code request. The helper is the asking person's from its spawn until the request ends
    and its allocation goes back, and the second opinion from its wake until it answers. A reviewer that has answered,
    a helper whose request has ended, and the controller mind throughout are on their own."""
    h, jon = x.hive, "user:u_jon"
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    reviewer = add_reviewer(x)
    seen, spawn, wake = {}, h.minds.spawn, h.send_to_agent

    async def spawn_and_look(agent, data, acting=None):     # the helper's first moment, before its attempt names it
        out = await spawn(agent, data, acting=acting)
        child = h.db.one("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))["id"]
        seen["helper"] = h.present_for(h.agent(child))
        return out

    async def wake_and_look(agent_id, text, **kw):           # the reviewer's first moment, before its review waits
        if agent_id == reviewer["id"]:
            seen["reviewer"] = h.present_for(h.agent(agent_id))
        return await wake(agent_id, text, **kw)
    monkeypatch.setattr(h.minds, "spawn", spawn_and_look)
    monkeypatch.setattr(h, "send_to_agent", wake_and_look)
    assert h.present_for(h.agent(x.ctl["id"])) is None

    assert run(x.engine.step(x.rid))["status"] == "writing"   # one helper attempt open
    child = h.db.one("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))["id"]
    assert seen["helper"] == jon == h.present_for(h.agent(child))
    assert h.present_for(h.agent(reviewer["id"])) is None and h.present_for(h.agent(x.ctl["id"])) is None

    helper_finishes(x, 1, SUGGESTION)                         # tested, and the reviewer woken; the helper is still theirs
    assert x.engine.view(x.rid)["status"] == "reviewing"
    assert seen["reviewer"] == jon == h.present_for(h.agent(reviewer["id"])) == h.present_for(h.agent(child))

    reviewer_finishes(x, "pass")                              # answered: the reviewer is on its own again
    assert x.engine.view(x.rid)["status"] == "ready_for_you"
    assert h.present_for(h.agent(reviewer["id"])) is None
    out = x.client.post(f"/api/requests/{x.rid}/controller/apply", headers={**x.jon, **ORIGIN})
    assert out.status_code == 200 and out.json()["status"] == "applied"   # delivered: the helper stopped, its allocation back
    assert h.present_for(h.agent(child)) is None and h.present_for(h.agent(x.ctl["id"])) is None


def test_a_mind_answering_its_persons_chat_or_room_message_is_their_live_work_until_it_answers(client):
    """A person's message the mind hasn't answered yet holds it for them, in its chat or in a room that @mentioned it,
    until it answers there or the Ask's answer time (HIVE_ASK_TIMEOUT_SECONDS) has passed since they sent it; another
    mind's message never holds it."""
    h = client.app.state.hive
    ana = person(client, "u_ana")
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    for mind in (a, b):
        h.db.update("agents", mind["id"], {"owner": "user:u_ana"})          # Ana's own minds, Dot0 and Dot1
    mind = lambda m: h.agent(m["id"])
    assert h.present_for(mind(a)) is None and h.present_for(mind(b)) is None

    said = client.post(f"/api/agents/{a['id']}/messages", headers=ana, json={"text": "what's on my list?"})
    assert said.status_code == 200, said.text
    chat = said.json()["conversation_id"]
    assert h.present_for(mind(a)) == "user:u_ana" and h.present_for(mind(b)) is None
    h.record_agent_message(a["id"], {"text": "three things", "conversation_id": chat})
    assert h.present_for(mind(a)) is None                                  # answered: on its own again

    room = client.post("/api/rooms", json={"kind": "group", "name": "Lists", "members": ["user:u_ana", f"agent:{a['id']}",
                                                                                    f"agent:{b['id']}"]}).json()
    asked = client.post(f"/api/rooms/{room['id']}/messages", headers=ana, json={"text": "@Dot1 please alphabetize the list"})
    assert asked.status_code == 200 and asked.json()["delivered_to"] == [f"agent:{b['id']}"], asked.text
    assert h.present_for(mind(b)) == "user:u_ana" and h.present_for(mind(a)) is None   # only the mind they @mentioned
    h.record_agent_message(b["id"], {"text": "done", "conversation_id": room.get("alias") or room["id"]})
    assert h.present_for(mind(b)) is None

    h.enqueue_message(b["id"], "and the next list?", f"c_{b['id']}", f"agent:{a['id']}")   # another mind asking: on its own
    assert h.present_for(mind(b)) is None
    late = client.post(f"/api/agents/{b['id']}/messages", headers=ana, json={"text": "still there?"}).json()
    assert h.present_for(mind(b)) == "user:u_ana"
    old = stamp_of(datetime.datetime.now(datetime.timezone.utc)
                   - datetime.timedelta(seconds=ask_limits(h).timeout_seconds + 1))
    h.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (old, late["id"]))
    assert h.present_for(mind(b)) is None                                  # sent longer ago than an Ask turn waits
