"""A request child that stops for good returns its unspent allocation at once, not only at retire.

Found by Mesto (PhysixSNET/omegahive#38): a helper stopped by its time limit, or by its controller's close (which sends
"stop"), kept its whole allocation counted against the request until someone retired it. Spent money and unresolved
model-call holds stay counted; the release happens once. Fakes only (the test_mind_control world)."""
import asyncio
import json

from hive.tests.test_mind_control import (  # noqa: F401  (fixtures)
    accepted, allocated, call, child_status, client, control, enabled, later, settle, spawn, w)


def _expire(w, child):
    limits = json.loads(w.hive.db.one("SELECT lifecycle_limits FROM mind_children WHERE id = ?", (child,))["lifecycle_limits"])
    limits["until"] = "2000-01-01T00:00:00.000Z"
    w.hive.db.execute("UPDATE mind_children SET lifecycle_limits = ? WHERE id = ?", (json.dumps(limits), child))


def _released_at(w, child):
    return w.hive.db.one("SELECT released_at FROM mind_reservations WHERE child_id = ?", (child,))["released_at"]


def test_a_time_limited_helper_returns_its_unspent_hold_and_keeps_its_spend(w):
    enabled(w)
    rq = accepted(w)
    limits = {"until": later(minutes=30), "max_iterations": None, "idle_minutes": None}
    child = spawn(w, rq["request_id"], lifecycle_mode="bounded", lifecycle_limits=limits, allocation_usd=0.25).json()["child_id"]
    w.hive.db.execute("UPDATE agents SET spent_usd = 0.05 WHERE id = ?", (child,))
    asyncio.run(w.hive.minds.reconcile())
    assert allocated(w, rq) == 0.25 and _released_at(w, child) is None             # still live: the hold stays
    _expire(w, child)
    asyncio.run(w.hive.minds.reconcile())
    st = child_status(w, child)
    assert (st["state"], st["paused_reason"]) == ("paused", "limit_reached")
    assert allocated(w, rq) == 0.05                                                  # spent stays counted, 0.20 back
    assert st["reservation"]["spent_usd"] == 0.05 and st["reservation"]["remaining_usd"] == 0
    first = _released_at(w, child)
    assert first is not None
    for _ in range(3):                                                               # never released twice
        asyncio.run(w.hive.minds.reconcile())
        assert allocated(w, rq) == 0.05 and _released_at(w, child) == first
    assert control(w, child, "resume", "op-resume-001").json()["error"]["code"] in ("spend_limit", "unsupported_control")
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    assert control(w, child, "retire", "op-retire-001").status_code == 202
    assert allocated(w, rq) == 0.05 and _released_at(w, child) == first               # retire after: no second release


def test_a_controller_stop_returns_the_unspent_part_and_keeps_holds_and_late_charges(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"], allocation_usd=0.25).json()["child_id"]
    w.hive.db.execute("UPDATE agents SET spent_usd = 0.03 WHERE id = ?", (child,))
    calls = call(w, child, "call-1", "unknown", usd=0.1)
    assert control(w, child, "stop", "op-stop-00001").status_code == 202              # the engine's close sends this
    assert child_status(w, child)["state"] == "stopped"
    assert allocated(w, rq) == 0.13                                                  # spent 0.03 + still held 0.10
    settle(w, calls, "call-1", child, 0.04)                                          # the call settles after the stop
    for _ in range(3):
        asyncio.run(w.hive.minds.reconcile())
        assert allocated(w, rq) == 0.07                                              # spent 0.07, refunded once


def test_a_pause_that_can_resume_keeps_the_allocation(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"], allocation_usd=0.25).json()["child_id"]
    assert control(w, child, "pause", "op-pause-0001").status_code == 202
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, child)["state"] == "paused" and _released_at(w, child) is None
    assert allocated(w, rq) == 0.25
    assert control(w, child, "resume", "op-resume-001").status_code == 202


def test_a_stop_still_waiting_to_be_observed_keeps_the_allocation(w):
    enabled(w)
    rq = accepted(w)
    child = spawn(w, rq["request_id"], allocation_usd=0.25).json()["child_id"]
    w.hive.supervisor.stop = lambda aid: w.hive.supervisor.calls.append(("stop", aid))   # the process does not end yet
    assert control(w, child, "stop", "op-stop-00001").status_code == 202
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, child)["state"] == "stop_requested" and allocated(w, rq) == 0.25
    w.running.discard(child)
    asyncio.run(w.hive.minds.reconcile())
    assert child_status(w, child)["state"] == "stopped" and allocated(w, rq) == 0.0
