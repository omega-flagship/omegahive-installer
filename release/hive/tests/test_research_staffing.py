"""Purpose: test that the Research controller staffs its tasks. A task whose researcher is gone gets a fresh researcher,
lease and deadline; its request's last researcher lost ends it at once; a task the person reopens after it failed starts
again through the door a new request passes, and fails with its reason when it refuses; and any task reopened past its
deadline gets a fresh one as long as its first. research_task.metta makes the decision.

Synthetic people and data, disposable hives, no network."""
import datetime

from hive.core import conductor as cmod
from hive.core import research as rmod
from hive.core.db import now
from hive.tests.test_ask_conductor import on  # noqa: F401  (fixture)
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
# hive_total, like _no_network, is an autouse fixture there, so importing it gives every test here the hive total that
# research spends under since #679 (one cap for the whole hive), without which no request is admitted
from hive.tests.test_research_request import (_no_network, _person_rule, child_of, dispatch_research,  # noqa: F401
                                              hive_total, row_of, run)

BEGUN, PAST = "2026-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z"   # a 30-minute task, long over


def _lose_researcher(hive):
    """The request's researcher is deleted, as a person deleting the Helper does."""
    hive.delete_agent(row_of(hive)["child_id"], by="user:u_jon")


def _last_stop(hive, goal_id):
    return hive.db.one("SELECT cause, reason FROM goal_stops WHERE goal_id = ? ORDER BY stopped_at DESC, rowid DESC LIMIT 1",
                       (goal_id,))


def _research_frames(client, on):
    page = client.get("/api/ask/op-res-001", headers=on["ann"]).json()
    return [f["state"] for f in page["events"] if f["phase"] == "research"]


def _minutes_left(stamp):
    left = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")) - datetime.datetime.now(datetime.timezone.utc)
    return left.total_seconds() / 60


def test_the_rule_restaffs_only_a_gone_researchers_task_and_a_reopened_one(client):
    hive = client.app.state.hive

    def next_for(*facts):
        return run(hive.research._task_next(facts))
    assert next_for("open", "gone", "live", "left") == "Reassign"
    assert next_for("open", "gone", "live", "spent") == "Fail"
    assert next_for("reopened", "gone", "passed", "spent") == "Readmit"
    for kept in (("open", "running", "live", "left"), ("open", "resting", "live", "left"),
                 ("open", "none", "live", "left"), ("open", "gone", "passed", "left"), ("other", "gone", "live", "left")):
        assert next_for(*kept) is None, kept


def test_a_task_whose_researcher_is_gone_gets_a_fresh_researcher_lease_and_deadline(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    first = row_of(hive)
    deadline = hive.goals.get(first["goal_id"])["deadline_at"]
    _lose_researcher(hive)
    run(hive.goals.expire())
    fresh = row_of(hive)
    goal = hive.goals.get(first["goal_id"])
    assert fresh["state"] == "working" and fresh["child_id"] not in (None, first["child_id"])
    assert fresh["lease_id"] != first["lease_id"] and goal["deadline_at"] > deadline
    assert goal["status"] == "open" and goal["assignee"] == fresh["child_id"]
    assert child_of(hive, fresh)["deleted"] == 0
    assert hive.db.one("SELECT state FROM mind_children WHERE id = ?", (first["child_id"],))["state"] == "retired"
    assert hive.db.one("SELECT ended_reason FROM mind_leases WHERE id = ?", (first["lease_id"],))["ended_reason"] == \
        "research_restaffed"
    assert _research_frames(client, on) == []   # nothing was shown of the lost researcher, so nothing resumes


def test_the_requests_last_researcher_lost_ends_the_task_at_once(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    goal_id = row_of(hive)["goal_id"]
    for _ in range(rmod.MAX_RESEARCHERS - 1):
        _lose_researcher(hive)
        run(hive.goals.expire())
        assert hive.goals.get(goal_id)["status"] == "open"
    _lose_researcher(hive)
    run(hive.goals.expire())
    assert hive.goals.get(goal_id)["status"] == "failed" and row_of(hive)["state"] == "failed"
    assert _last_stop(hive, goal_id)["cause"] == "replies"
    assert hive.db.one("SELECT COUNT(*) AS n FROM mind_leases WHERE request_id = ?",
                       (row_of(hive)["request_id"],))["n"] == rmod.MAX_RESEARCHERS


def test_a_task_the_person_reopens_after_it_failed_starts_again_with_a_fresh_researcher(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    first = row_of(hive)
    hive.db.execute("UPDATE goals SET created_at = ?, deadline_at = ? WHERE id = ?", (BEGUN, PAST, first["goal_id"]))
    run(hive.goals.expire())   # its deadline fails it and retires its researcher
    assert row_of(hive)["state"] == "failed"
    hive.goals.update(first["goal_id"], {"status": "open"})
    run(hive.goals.expire())
    again = row_of(hive)
    goal = hive.goals.get(first["goal_id"])
    assert again["state"] == "working" and again["child_id"] not in (None, first["child_id"])
    assert goal["status"] == "open" and goal["assignee"] == again["child_id"] and goal["deadline_at"] > now()
    assert _research_frames(client, on)[-2:] == ["failed", "resumed"]


def test_a_reopen_the_limits_refuse_fails_again_with_their_reason(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    first = row_of(hive)
    hive.db.execute("UPDATE goals SET created_at = ?, deadline_at = ? WHERE id = ?", (BEGUN, PAST, first["goal_id"]))
    run(hive.goals.expire())
    _person_rule(hive, "month", 0.0)   # the asker's own month limit has no room
    hive.goals.update(first["goal_id"], {"status": "open"})
    run(hive.goals.expire())
    stop = _last_stop(hive, first["goal_id"])
    assert hive.goals.get(first["goal_id"])["status"] == "failed"
    # new research's door refuses it too, as the asker's month limit: one door, whichever body #679 gives it
    assert stop["cause"] == "research_start" and "person's month limit" in stop["reason"]
    assert row_of(hive)["child_id"] == first["child_id"]   # no fresh researcher was spawned
    _s, _fs, said = dispatch_research(client, on, op="op-res-002")   # a new request meets the same door
    assert said == [cmod.DISPATCH_REFUSED_SAY["member_allowance"]]


def test_reopening_a_task_past_its_deadline_gives_it_a_fresh_one_as_long_as_its_first(client):
    hive = client.app.state.hive
    swarm, _ = make_swarm_and_agents(client, n=1)
    goal = run(hive.goals.create(swarm["id"], "Tidy the notes", created_by="user:u_jon", deadline_minutes=30))
    hive.db.execute("UPDATE goals SET created_at = ?, deadline_at = ? WHERE id = ?",
                    (BEGUN, PAST, goal["id"]))
    run(hive.goals.expire())
    assert hive.goals.get(goal["id"])["status"] == "failed"
    hive.goals.update(goal["id"], {"status": "open"})
    assert 29.5 < _minutes_left(hive.goals.get(goal["id"])["deadline_at"]) <= 30
    run(hive.goals.expire())
    assert hive.goals.get(goal["id"])["status"] == "open"
