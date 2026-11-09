"""Foundation projection with actual Hive/Power/Supervisor and existing synthetic fixtures.

No provider or native mind is used: awake rows, retained child rows and driver
failures below are explicit component models, not execution authority.
"""
import json

import pytest

from hive.core.db import now
from hive.core.foundation import CODE, REVIEW
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_stop_reconcile_race import real_supervisor


def bindings(hive):
    rows = {b["purpose"]: b for b in hive.foundation_infrastructure_bindings()}
    assert set(rows) == {CODE, REVIEW}
    return rows


def ordinary(hive, name="ordinary", swarm=None, desired="awake"):
    swarm = swarm or hive.create_swarm("Power regression")
    agent = hive.create_agent(name, "omega", swarm["id"], "mock/echo", "", None, 0, None, None)
    hive.db.update("agents", agent["id"], {"status": desired, "desired": desired, "driver": "local"})
    return agent["id"], swarm


def saved(hive, mid):
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (mid,))


def driver_calls(client, operation):
    return [mid for op, mid in client.supervisor.calls if op == operation]


def historical_snapshot(hive, mid):
    # Model an original pre-R7 snapshot: it held this awake mind before stopping it.
    hive.db.update("agents", mid, {"status": "awake", "desired": "awake"})
    hive.power.hold(mid, "user:operator", "off")
    hive.db.update("agents", mid, {"status": "stopped", "desired": "stopped"})


def test_projection_uses_stored_owner_chain_not_unadopted_global_owner(client):
    hive = client.app.state.hive
    before = bindings(hive)
    if hive.ownhive._row() is None:
        stamp = now()
        hive.db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, 'component', ?, ?)",
                        ("user:another_owner", stamp, stamp))
    else:
        hive.db.execute("UPDATE hive_owner SET owner = ?", ("user:another_owner",))
    assert hive.ownhive._row()["owner"] == "user:another_owner"
    assert bindings(hive) == before
    assert all(b["principal"] != "user:another_owner" for b in before.values())


def test_projection_returns_copies_not_mutable_registry_state(client):
    hive = client.app.state.hive
    first = hive.foundation_infrastructure_bindings()
    expected = {b["purpose"]: dict(b) for b in first}
    first[0]["agent_id"] = "foreign"
    assert bindings(hive) == expected


@pytest.mark.parametrize("drift", ["agent_owner", "swarm_owner", "coordinator", "membership", "driver", "kind", "deleted", "archived", "moved"])
def test_projection_refuses_drifted_or_lookalike_controller_chains(client, drift):
    hive = client.app.state.hive
    bound = bindings(hive)[CODE]
    aid, sid = bound["agent_id"], bound["swarm_id"]
    if drift == "agent_owner":
        hive.db.update("agents", aid, {"owner": "user:foreign"})
    elif drift == "swarm_owner":
        hive.db.update("swarms", sid, {"owner": "user:foreign"})
    elif drift == "coordinator":
        hive.db.update("swarms", sid, {"coordinator_id": None})
    elif drift == "membership":
        hive.db.update("agents", aid, {"swarm_id": hive.create_swarm("Other")["id"]})
    elif drift == "driver":
        hive.db.update("agents", aid, {"driver": "foreign"})
    elif drift == "kind":
        hive.db.update("agents", aid, {"kind": "module"})
    elif drift == "deleted":
        hive.db.update("agents", aid, {"deleted": 1})
    elif drift == "archived":
        hive.db.update("swarms", sid, {"archived_at": now()})
    else:
        hive.db.update("agents", aid, {"moved_to": "foreign-place"})
    assert CODE not in {b["purpose"] for b in hive.foundation_infrastructure_bindings()}
    assert REVIEW in {b["purpose"] for b in hive.foundation_infrastructure_bindings()}


def test_names_and_options_do_not_make_an_ordinary_mind_infrastructure(client):
    hive = client.app.state.hive
    expected = bindings(hive)
    mid, _ = ordinary(hive, "Create · Code controller")
    hive.db.update("agents", mid, {"options": json.dumps({"_foundation": CODE})})
    assert bindings(hive) == expected
    assert mid not in {b["agent_id"] for b in hive.foundation_infrastructure_bindings()}
    assert hive.stop_all() == {"stopped": 1}
    assert saved(hive, mid)["desired"] == "stopped"


def test_zero_ordinary_count_still_stops_every_controller_and_advances_generations(client):
    hive = client.app.state.hive
    ids = {b["agent_id"] for b in bindings(hive).values()}
    sup, driver = real_supervisor(hive)
    before = {mid: sup.generation(mid) for mid in ids}
    assert hive.stop_all() == {"stopped": 0}
    assert all(sup.generation(mid) > before[mid] for mid in ids)
    assert all(saved(hive, mid)["status"] == saved(hive, mid)["desired"] == "stopped" for mid in ids)
    assert driver.running == set() and hive.power.pending() is None


@pytest.mark.parametrize("purpose", [CODE, REVIEW])
def test_active_controller_is_really_stopped_but_not_generically_restored(client, purpose):
    hive = client.app.state.hive
    bound = bindings(hive)
    controller = bound[purpose]["agent_id"]
    hive.db.update("agents", controller, {"status": "awake", "desired": "awake"})
    mid, _ = ordinary(hive)
    client.supervisor.calls.clear()
    off = hive.power.set("off", "active-infra-off", "user:operator")
    assert off["stopped"] == 1 and off["failed"] == []
    assert set(driver_calls(client, "stop")) == {mid} | {b["agent_id"] for b in bound.values()}
    assert all(saved(hive, aid)["desired"] == "stopped" for aid in driver_calls(client, "stop"))
    assert json.loads(hive.power.pending()["minds"]) == [mid]
    client.supervisor.calls.clear()
    on = hive.power.set("on", "active-infra-on", "user:operator")
    assert on["woken"] == [mid] and on["skipped"] == [] and on["failed"] == []
    assert driver_calls(client, "start") == [mid]
    assert saved(hive, controller)["desired"] == "stopped"


@pytest.mark.parametrize("purpose", [CODE, REVIEW])
def test_active_controller_stop_failure_remains_visible_and_does_not_block_other_stops(client, monkeypatch, purpose):
    hive = client.app.state.hive
    controller = bindings(hive)[purpose]["agent_id"]
    hive.db.update("agents", controller, {"status": "awake", "desired": "awake"})
    mid, _ = ordinary(hive)
    original = client.supervisor.stop

    def fail_controller(aid):
        if aid == controller:
            raise RuntimeError("controller group remains")
        original(aid)

    with monkeypatch.context() as patch:
        patch.setattr(client.supervisor, "stop", fail_controller)
        off = hive.power.set("off", "failed-infra-off", "user:operator")
    assert off["stopped"] == 1
    assert off["failed"] == [{"id": controller, "error": "controller group remains"}]
    assert saved(hive, controller)["status"] == saved(hive, controller)["desired"] == "awake"
    assert saved(hive, mid)["desired"] == "stopped"
    assert json.loads(hive.power.pending()["minds"]) == [mid]


def test_ordinary_sleepers_keep_original_stop_count_and_awake_only_restore(client):
    hive = client.app.state.hive
    awake, _ = ordinary(hive, "awake")
    asleep, _ = ordinary(hive, "ordinary sleeper", desired="asleep")
    off = hive.power.set("off", "ordinary-off", "user:operator")
    assert off["stopped"] == 2 and off["failed"] == []
    assert saved(hive, asleep)["status"] == saved(hive, asleep)["desired"] == "stopped"
    assert json.loads(hive.power.pending()["minds"]) == [awake]
    on = hive.power.set("on", "ordinary-on", "user:operator")
    assert on["woken"] == [awake] and saved(hive, asleep)["desired"] == "stopped"


def test_historical_review_snapshot_is_skipped_before_any_start(client):
    hive = client.app.state.hive
    review = bindings(hive)[REVIEW]["agent_id"]
    historical_snapshot(hive, review)
    client.supervisor.calls.clear()
    on = hive.power.set("on", "old-review-on", "user:operator")
    assert on["woken"] == [] and on["failed"] == []
    assert on["skipped"] == [{"id": review, "reason": "foundation infrastructure; use its original request admission"}]
    assert driver_calls(client, "start") == [] and saved(hive, review)["desired"] == "stopped"


def test_historical_invalid_original_binding_requires_repair_not_generic_start(client):
    hive = client.app.state.hive
    review = bindings(hive)[REVIEW]
    historical_snapshot(hive, review["agent_id"])
    hive.db.update("swarms", review["swarm_id"], {"owner": "user:foreign"})
    assert REVIEW not in {b["purpose"] for b in hive.foundation_infrastructure_bindings()}
    client.supervisor.calls.clear()
    on = hive.power.set("on", "invalid-review-on", "user:operator")
    assert on["woken"] == [] and on["failed"] == []
    assert on["skipped"] == [{"id": review["agent_id"], "reason": "foundation binding changed; repair required"}]
    assert driver_calls(client, "start") == []


def test_drifted_binding_is_not_hidden_from_stop_count_or_failure_custody(client):
    hive = client.app.state.hive
    code = bindings(hive)[CODE]
    hive.db.update("swarms", code["swarm_id"], {"coordinator_id": None})
    client.supervisor.calls.clear()
    assert hive.stop_all() == {"stopped": 1}
    assert code["agent_id"] in driver_calls(client, "stop")
    assert saved(hive, code["agent_id"])["desired"] == "stopped"


def test_restore_classification_error_never_falls_back_to_start(client, monkeypatch):
    hive = client.app.state.hive
    review = bindings(hive)[REVIEW]["agent_id"]
    historical_snapshot(hive, review)

    def unavailable():
        raise RuntimeError("classification unavailable")

    client.supervisor.calls.clear()
    with monkeypatch.context() as patch:
        patch.setattr(hive, "foundation_infrastructure_bindings", unavailable)
        on = hive.power.set("on", "unavailable-review-on", "user:operator")
    assert on["woken"] == [] and on["skipped"] == []
    assert on["failed"] == [{"id": review, "error": "classification unavailable"}]
    assert driver_calls(client, "start") == []


def test_no_retained_foundation_reference_preserves_ordinary_historical_restore(client):
    hive = client.app.state.hive
    mid, _ = ordinary(hive)
    historical_snapshot(hive, mid)
    client.supervisor.calls.clear()
    on = hive.power.set("on", "ordinary-history-on", "user:operator")
    assert on["woken"] == [mid] and on["skipped"] == [] and on["failed"] == []
    assert driver_calls(client, "start") == [mid]


def test_noncontroller_member_of_foundation_swarm_keeps_ordinary_custody(client):
    hive = client.app.state.hive
    code = bindings(hive)[CODE]
    mid, _ = ordinary(hive, "another member", swarm=hive.swarm(code["swarm_id"]))
    assert mid not in {b["agent_id"] for b in hive.foundation_infrastructure_bindings()}
    off = hive.power.set("off", "member-off", "user:operator")
    assert off["stopped"] == 1 and off["failed"] == []
    assert json.loads(hive.power.pending()["minds"]) == [mid]


def test_retained_paused_child_is_counted_but_original_minds_start_guard_still_refuses_restore(client):
    hive = client.app.state.hive
    controller = bindings(hive)[CODE]["agent_id"]
    child, swarm = ordinary(hive, "retained paused child")
    stamp = now()
    # Synthetic retained component record; no live request, grant, lease or authority is fabricated.
    hive.db.insert("mind_children", {"id": child, "seq": 1, "controller_id": controller,
        "team_id": swarm["id"], "request_id": "rq_component", "lease_id": "lease_component",
        "template_id": "component", "model_id": "mock/echo", "lifecycle_mode": "bounded",
        "lifecycle_limits": None, "state": "paused", "paused_reason": "component",
        "recovery_needed": 0, "prompt_rev": 0, "stop_requested_at": None, "stopped_at": None,
        "created_at": stamp, "updated_at": stamp})
    assert hive.minds.is_child(child)
    off = hive.power.set("off", "paused-child-off", "user:operator")
    assert off["stopped"] == 1 and json.loads(hive.power.pending()["minds"]) == [child]
    client.supervisor.calls.clear()
    on = hive.power.set("on", "paused-child-on", "user:operator")
    assert on["woken"] == [] and on["skipped"] == []
    assert len(on["failed"]) == 1 and on["failed"][0]["id"] == child and "paused" in on["failed"][0]["error"]
    assert driver_calls(client, "start") == []


def test_classification_failure_never_skips_any_kill_switch_effect(client, monkeypatch):
    hive = client.app.state.hive
    ids = {b["agent_id"] for b in bindings(hive).values()}
    mid, _ = ordinary(hive)

    def unavailable():
        raise RuntimeError("classification unavailable")

    client.supervisor.calls.clear()
    with monkeypatch.context() as patch:
        patch.setattr(hive, "foundation_infrastructure_bindings", unavailable)
        stopped = hive.stop_all()
    assert stopped == {"stopped": len(ids) + 1}
    assert set(driver_calls(client, "stop")) == ids | {mid}
    assert all(saved(hive, aid)["desired"] == "stopped" for aid in ids | {mid})


def test_replayed_off_does_not_stop_newer_work(client):
    hive = client.app.state.hive
    first = hive.power.set("off", "original-off", "user:operator")
    mid, _ = ordinary(hive, "newer work")
    client.supervisor.calls.clear()
    assert hive.power.set("off", "original-off", "user:operator") == first
    assert driver_calls(client, "stop") == [] and saved(hive, mid)["desired"] == "awake"


def test_reconcile_ignores_asleep_infrastructure_and_keeps_original_awake_repair(client):
    hive = client.app.state.hive
    ids = {b["agent_id"] for b in bindings(hive).values()}
    sup, driver = real_supervisor(hive)
    mid, _ = ordinary(hive)
    sup.check()
    assert driver.running == {mid} and driver.starts == 1
    assert all(saved(hive, aid)["desired"] == "asleep" for aid in ids)
