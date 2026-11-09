"""Root r6 (2026-10-05): a completed stop is never undone by reconciliation. Production Hive and Supervisor, fake driver."""
import asyncio
import datetime
import pathlib
import tempfile
import threading

import pytest

from hive.core.app import create_app
from hive.core.config import load_settings

from hive.supervisor.drivers import Driver, Supervisor
from hive.tests.test_core_api import PETTA, client  # noqa: F401  (fixture)


class FakeDriver(Driver):
    name = "local"

    def __init__(self):
        self.running, self.starts, self.on_stop = set(), 0, None

    def start(self, agent, env):
        self.running.add(agent["id"]); self.starts += 1

    def stop(self, agent_id):
        self.running.discard(agent_id)
        if self.on_stop:
            self.on_stop()

    def status(self, agent_id):
        return "running" if agent_id in self.running else "stopped"

    def logs(self, agent_id, tail=200):
        return []


def real_supervisor(hive):
    driver = FakeDriver()
    sup = Supervisor.__new__(Supervisor)               # the real class; no workspace or PeTTa needed for this path
    sup.drivers, sup.hive, sup._restarts = {"local": driver}, hive, {}
    sup._locks, sup._locks_guard, sup._stop = {}, threading.Lock(), threading.Event()
    sup._transitions, sup._generations = {}, {}
    sup.settings = type("S", (), {"default_driver": "local"})()
    sup.env = lambda agent: {}
    sup.prepare = lambda agent, token: None             # workspace files are not under test
    hive.supervisor = sup
    return sup, driver


def awake_mind(client, hive, driver):
    sw = client.post("/api/swarms", json={"name": "Race"}).json()
    m = hive.create_agent("m", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake', driver = 'local' WHERE id = ?", (m["id"],))
    driver.running.add(m["id"])
    return m["id"]


def test_reconcile_injected_after_driver_stop_cannot_restart(client):
    """Root's reproducer: check() runs after the driver stopped, before lifecycle records desired."""
    for action, settled in (("stop", "stopped"), ("sleep", "asleep")):
        hive = client.app.state.hive
        sup, driver = real_supervisor(hive)
        mid = awake_mind(client, hive, driver)
        checker = threading.Thread(target=sup.check)
        def inject():
            driver.on_stop = None
            checker.start()
            checker.join(0.3)                          # unfixed: check restarts it here; fixed: it waits for the lock
        driver.on_stop = inject
        before = driver.starts
        hive.lifecycle(mid, action)
        checker.join(4)
        assert not checker.is_alive()
        row = hive._agent_row(mid)
        assert (row["status"], row["desired"]) == (settled, settled)
        assert mid not in driver.running and driver.starts == before, action


def test_a_check_that_listed_the_mind_before_the_stop_rereads_it(client):
    """Stale read: the pass captured its list while the mind was awake; the stop completes; the pass must not restart."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)                        # looks crashed to the pass
    real_all = hive.db.all
    def listed_then_stopped(sql, *args):
        out = real_all(sql, *args)
        if "FROM agents WHERE deleted = 0 AND kind != 'module'" in sql:
            hive.db.all = real_all
            hive.lifecycle(mid, "stop")                # completes between the listing and the decision
        return out
    hive.db.all = listed_then_stopped
    before = driver.starts
    try:
        sup.check()
    finally:
        hive.db.all = real_all
    assert driver.starts == before and hive._agent_row(mid)["desired"] == "stopped"


def test_a_crashed_awake_mind_is_still_restarted(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)
    sup.check()
    assert mid in driver.running and hive._agent_row(mid)["status"] == "starting"


def test_a_move_records_with_its_stop(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    checker = threading.Thread(target=sup.check)
    def inject():
        driver.on_stop = None
        checker.start(); checker.join(0.3)
    driver.on_stop = inject
    with sup.lock(mid):                                # the same discipline settle() uses
        sup.stop(mid)
        hive.db.execute("UPDATE agents SET status = 'moved', desired = 'stopped' WHERE id = ?", (mid,))
    checker.join(4)
    assert mid not in driver.running


def test_the_production_supervisor_provides_the_per_mind_lock():
    """Hive._mind_lock tolerates stand-in supervisors in tests; the real one must never lack the lock."""
    assert callable(getattr(Supervisor, "lock", None))
    sup, _ = real_supervisor(type("H", (), {})())
    assert sup.lock("a_x") is sup.lock("a_x") and sup.lock("a_x") is not sup.lock("a_y")


# ---- Root r6 reproducer, ported exactly: check() runs on the SAME thread from inside the driver's stop ----------------
# The per-mind lock is re-entrant, so the lock alone let this re-entrant pass restart the mind (fails at 2d7d73f).

def test_root_r6_reentrant_check_inside_driver_stop_production_supervisor():
    """Root's script verbatim in shape: create_app with the production Supervisor (its own __init__), the local driver
    replaced by a fake process; check() injected from driver.stop, before lifecycle records desired."""
    with tempfile.TemporaryDirectory(prefix="hive-r6-") as temp:
        settings = load_settings(data_dir=pathlib.Path(temp) / "hive", petta_path=PETTA, offline=True, default_driver="local")
        app = create_app(settings, reconcile_seconds=0)
        hive = app.state.hive
        sup = hive.supervisor
        assert type(sup) is Supervisor
        driver = FakeDriver()
        sup.drivers["local"] = driver
        for action, settled in (("stop", "stopped"), ("sleep", "asleep")):
            mind = hive.create_agent("Synthetic lifecycle control")
            hive.lifecycle(mind["id"], "start")
            assert mind["id"] in driver.running
            before = driver.starts
            driver.on_stop = lambda: (setattr(driver, "on_stop", None), sup.check())
            hive.lifecycle(mind["id"], action)
            row = hive._agent_row(mind["id"])
            assert (row["status"], row["desired"]) == (settled, settled), action
            assert mind["id"] not in driver.running, action
            assert driver.starts == before, action
            assert not sup.in_transition(mind["id"])
            sup.check()                                    # a later pass agrees: nothing to restart
            assert mind["id"] not in driver.running and driver.starts == before


def test_reentrant_check_inside_stop_and_sleep(client):
    for action, settled in (("stop", "stopped"), ("sleep", "asleep")):
        hive = client.app.state.hive
        sup, driver = real_supervisor(hive)
        mid = awake_mind(client, hive, driver)
        driver.on_stop = lambda: (setattr(driver, "on_stop", None), sup.check())
        before = driver.starts
        hive.lifecycle(mid, action)
        row = hive._agent_row(mid)
        assert (row["status"], row["desired"]) == (settled, settled)
        assert mid not in driver.running and driver.starts == before, action


def test_reentrant_check_inside_delete_and_stop_all(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    for op in ("delete", "stop_all"):
        mid = awake_mind(client, hive, driver)
        driver.on_stop = lambda: (setattr(driver, "on_stop", None), sup.check())
        before = driver.starts
        hive.delete_agent(mid) if op == "delete" else hive.stop_all()
        assert mid not in driver.running and driver.starts == before, op


# ---- stale reads that act later: each re-judges the fresh row under the lock -----------------------------------------

def test_restore_does_not_start_a_mind_stopped_after_it_read_the_rows(client):
    """Boot restore listed the mind while desired was awake; a stop completes before restore reaches it."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)
    real_all = hive.db.all
    def listed_then_stopped(sql, *args):
        out = real_all(sql, *args)
        if sql.startswith("SELECT * FROM agents WHERE deleted = 0 AND kind != 'module'"):
            hive.db.all = real_all
            hive.lifecycle(mid, "stop")
        return out
    hive.db.all = listed_then_stopped
    before = driver.starts
    try:
        asyncio.run(hive.restore())
    finally:
        hive.db.all = real_all
    assert driver.starts == before and mid not in driver.running
    assert hive._agent_row(mid)["desired"] == "stopped"


def test_restore_still_starts_a_mind_that_should_be_awake(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)
    asyncio.run(hive.restore())
    assert mid in driver.running and hive._agent_row(mid)["desired"] == "awake"


def test_a_message_does_not_wake_a_mind_stopped_after_it_was_read_asleep(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "sleep")
    real_deliver = hive.deliver
    async def deliver_then_stop(agent_id, message):
        await real_deliver(agent_id, message)
        hive.lifecycle(mid, "stop")                    # lands after send_to_agent read 'asleep', before its wake
    hive.deliver = deliver_then_stop
    before = driver.starts
    asyncio.run(hive.send_to_agent(mid, "hello"))
    assert driver.starts == before and mid not in driver.running
    assert hive._agent_row(mid)["status"] == "stopped"


def test_a_message_still_wakes_an_asleep_mind(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "sleep")
    asyncio.run(hive.send_to_agent(mid, "hello"))
    assert mid in driver.running and hive._agent_row(mid)["desired"] == "awake"


def test_idle_sleep_does_not_turn_a_stopped_mind_asleep(client):
    """A stale idle candidate must not promote a stopped mind to asleep (which wakes on the next message)."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.db.execute("UPDATE agents SET idle_sleep_minutes = 1, last_active_at = '2000-01-01T00:00:00Z' WHERE id = ?", (mid,))
    assert mid in hive.idle_candidates()
    hive.lifecycle(mid, "stop")                        # lands between the candidate list and the sleep
    hive.sleep_if_idle(mid)
    assert hive._agent_row(mid)["status"] == "stopped" and hive._agent_row(mid)["desired"] == "stopped"


def test_idle_sleep_still_sleeps_an_idle_awake_mind(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.db.execute("UPDATE agents SET idle_sleep_minutes = 1, last_active_at = '2000-01-01T00:00:00Z' WHERE id = ?", (mid,))
    hive.sleep_if_idle(mid)
    assert hive._agent_row(mid)["status"] == "asleep" and mid not in driver.running
    later = datetime.datetime.now(datetime.timezone.utc)
    assert mid not in hive.idle_candidates(later)


# ---- normal paths, errors and rollback --------------------------------------------------------------------------------

def test_normal_start_stop_sleep_wake(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "stop")
    assert mid not in driver.running and hive._agent_row(mid)["desired"] == "stopped"
    hive.lifecycle(mid, "start")
    assert mid in driver.running and hive._agent_row(mid)["status"] == "starting"
    hive.lifecycle(mid, "sleep")
    assert mid not in driver.running and hive._agent_row(mid)["status"] == "asleep"
    hive.lifecycle(mid, "wake")
    assert mid in driver.running and hive._agent_row(mid)["desired"] == "awake"
    assert not sup.in_transition(mid)


def test_a_failed_stop_records_nothing_and_releases_the_transition(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    def boom():
        raise RuntimeError("driver stop failed")
    driver.on_stop = boom
    with pytest.raises(RuntimeError):
        hive.lifecycle(mid, "stop")
    row = hive._agent_row(mid)
    assert (row["status"], row["desired"]) == ("awake", "awake")   # unchanged: the stop is not recorded as done
    assert not sup.in_transition(mid)
    driver.running.discard(mid)                        # the process did die: the next pass restarts it as before
    sup.check()
    assert mid in driver.running


def test_a_failed_start_releases_the_transition_and_reconcile_still_works(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "stop")
    real_start = driver.start
    driver.start = lambda agent, env: (_ for _ in ()).throw(RuntimeError("spawn failed"))
    with pytest.raises(RuntimeError):
        hive.lifecycle(mid, "start")
    assert not sup.in_transition(mid) and hive._agent_row(mid)["desired"] == "awake"
    driver.start = real_start
    sup.check()
    assert mid in driver.running


def test_reconcile_start_failure_is_recorded_as_error(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)
    driver.start = lambda agent, env: (_ for _ in ()).throw(RuntimeError("spawn failed"))
    sup.check()
    row = hive._agent_row(mid)
    assert row["status"] == "error" and "start failed" in row["last_error"]
    assert not sup.in_transition(mid)


def test_a_stale_concurrent_start_from_another_thread_waits_and_rereads(client):
    """A second thread's reconcile pass read the row awake and waits on the lock while stop is mid-way; when it gets
    the lock the stop is recorded, so it does nothing."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    reached = threading.Event()
    real_one = hive.db.one
    def gated_one(sql, *args):
        if "kind != 'module'" in sql:                  # _reconcile's fresh read happens only after the lock
            reached.set()
        return real_one(sql, *args)
    hive.db.one = gated_one
    checker = threading.Thread(target=sup.check)
    def inject():
        driver.on_stop = None
        checker.start()
        assert not reached.wait(0.3)                   # blocked on the mind's lock, not deciding
    driver.on_stop = inject
    before = driver.starts
    try:
        hive.lifecycle(mid, "stop")
        checker.join(4)
    finally:
        hive.db.one = real_one
    assert not checker.is_alive() and reached.is_set()
    assert mid not in driver.running and driver.starts == before


# ---- hub connections (BYPASS-1): a connection makes a mind awake only while it is meant to be awake ------------------

class FakeWS:
    def __init__(self):
        self.closed = None

    async def close(self, code=1000):
        self.closed = code


def test_a_late_connection_after_a_completed_stop_is_refused_and_the_mind_stays_stopped(client):
    """The handshake was sent before the kill and is handled after the stop was recorded: it must not undo the stop,
    and the next reconcile pass must not restart the mind (fails at 669e443: awake/awake, then restarted)."""
    for action, settled in (("stop", "stopped"), ("sleep", "asleep")):
        hive = client.app.state.hive
        sup, driver = real_supervisor(hive)
        mid = awake_mind(client, hive, driver)
        hive.lifecycle(mid, action)
        ws = FakeWS()
        admitted = asyncio.run(hive.agent_connected(mid, ws))
        row = hive._agent_row(mid)
        assert (row["status"], row["desired"]) == (settled, settled), action
        before = driver.starts
        sup.check()
        assert mid not in driver.running and driver.starts == before, action
        assert admitted is False and hive.connections.get(mid) is not ws and mid not in hive.boot_nonce, action


def test_a_connection_after_a_normal_start_makes_the_mind_awake(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "stop")
    hive.lifecycle(mid, "start")
    ws = FakeWS()
    assert asyncio.run(hive.agent_connected(mid, ws)) is True
    row = hive._agent_row(mid)
    assert (row["status"], row["desired"]) == ("awake", "awake") and hive.connections[mid] is ws


def test_a_connection_during_an_in_flight_start_waits_for_it_and_is_awake(client):
    """The process connects while the start that spawned it still holds the mind's transition: the admission waits for
    the lock and then sees desired awake."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    hive.lifecycle(mid, "stop")
    spawned, release = threading.Event(), threading.Event()
    real_start = driver.start
    def slow_start(agent, env):
        real_start(agent, env)
        spawned.set()
        assert release.wait(5)
    driver.start = slow_start
    starter = threading.Thread(target=hive.lifecycle, args=(mid, "start"))
    starter.start()
    assert spawned.wait(5)
    result = {}
    connector = threading.Thread(target=lambda: result.setdefault("ok", asyncio.run(hive.agent_connected(mid, FakeWS()))))
    connector.start()
    connector.join(0.3)
    assert connector.is_alive()                        # waiting on the mind's lock, not deciding on a half-made row
    release.set()
    starter.join(5); connector.join(5)
    assert result["ok"] is True
    row = hive._agent_row(mid)
    assert (row["status"], row["desired"]) == ("awake", "awake")


def test_a_connection_racing_a_stop_waits_for_the_record_and_is_refused(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    result = {}
    connector = threading.Thread(target=lambda: result.setdefault("ok", asyncio.run(hive.agent_connected(mid, FakeWS()))))
    def inject():
        driver.on_stop = None
        connector.start()
        connector.join(0.3)
        assert connector.is_alive()                    # desired is still awake here; it must wait for the record
    driver.on_stop = inject
    hive.lifecycle(mid, "stop")
    connector.join(5)
    assert result["ok"] is False
    row = hive._agent_row(mid)
    assert (row["status"], row["desired"]) == ("stopped", "stopped")


def test_an_external_member_still_connects_as_before(client):
    hive = client.app.state.hive
    real_supervisor(hive)
    mod = hive.create_agent("ext", "module", None, None, "", None, 0, None, None)
    assert asyncio.run(hive.agent_connected(mod["id"], FakeWS())) is True
    assert hive._agent_row(mod["id"])["status"] == "awake"


# ---- one failing mind never blocks the others (L1, L2, SEM-1, SEM-4) ---------------------------------------------------

def _idle(hive, mid):
    hive.db.execute("UPDATE agents SET idle_sleep_minutes = 1, last_active_at = '2000-01-01T00:00:00Z' WHERE id = ?", (mid,))


def test_idle_pass_continues_past_a_mind_whose_stop_fails_and_a_deleted_candidate(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    stuck, gone, fine = (awake_mind(client, hive, driver) for _ in range(3))
    for mid in (stuck, gone, fine):
        _idle(hive, mid)
    assert hive.idle_candidates() == [stuck, gone, fine]
    real_stop = driver.stop
    def stop(agent_id):
        if agent_id == stuck:
            raise RuntimeError("group outlived TERM and KILL")
        real_stop(agent_id)
    driver.stop = stop
    real_candidates = hive.idle_candidates
    def listed_then_deleted(moment=None):
        out = real_candidates(moment)
        hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (gone,))
        return out
    hive.idle_candidates = listed_then_deleted
    outcome = hive.sleep_idle_minds()
    assert outcome == {"slept": [fine], "failed": [stuck]}
    assert hive._agent_row(fine)["status"] == "asleep" and fine not in driver.running
    row = hive._agent_row(stuck)
    assert (row["status"], row["desired"]) == ("awake", "awake") and not sup.in_transition(stuck)


def test_the_reconcile_loop_runs_the_per_candidate_idle_pass():
    """app.py's loop calls sleep_idle_minds (TF1): the wiring, not only the method, is pinned."""
    import inspect
    from hive.core import app as app_module
    factory = getattr(app_module, "_create_app", app_module.create_app)
    if factory is not app_module.create_app:
        # Resource ownership wraps the actual routed factory; do not inspect
        # an orphan helper or mistake the wrapper for the reconcile body.
        assert "return _create_app(" in inspect.getsource(app_module.create_app)
    source = inspect.getsource(factory)
    assert "run_in_threadpool(hive.sleep_idle_minds)" in source
    assert "hive.lifecycle, agent_id, \"sleep\"" not in source


def test_stop_all_continues_past_a_mind_whose_stop_fails(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    stuck, other = awake_mind(client, hive, driver), awake_mind(client, hive, driver)
    real_stop = driver.stop
    def stop(agent_id):
        if agent_id == stuck:
            raise RuntimeError("group outlived TERM and KILL")
        real_stop(agent_id)
    driver.stop = stop
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as refused:
        hive.stop_all()
    assert refused.value.code == "stop_incomplete" and [f["id"] for f in refused.value.details["failed"]] == [stuck]
    assert hive._agent_row(other)["desired"] == "stopped" and other not in driver.running
    assert hive._agent_row(stuck)["desired"] == "awake" and not sup.in_transition(stuck)


def test_restore_records_a_start_failure_and_restores_the_rest(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    bad, good = awake_mind(client, hive, driver), awake_mind(client, hive, driver)
    driver.running.clear()
    real_start = driver.start
    def start(agent, env):
        if agent["id"] == bad:
            raise RuntimeError("docker run failed")
        real_start(agent, env)
    driver.start = start
    asyncio.run(hive.restore())
    row = hive._agent_row(bad)
    assert row["status"] == "error" and "docker run failed" in row["last_error"] and row["desired"] == "awake"
    assert good in driver.running and not sup.in_transition(bad)


# ---- shutdown (BYPASS-2 / SEM-3): an in-flight pass does not restart a mind the shutdown stops -------------------------

def test_a_pass_in_flight_at_shutdown_does_not_restart_a_mind_the_shutdown_stops(client):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    def one_pass_reaching_mid():
        with sup.lock(mid):                            # check()'s per-mind step, already past its listing
            sup._reconcile(mid)
    checker = threading.Thread(target=one_pass_reaching_mid)
    def inject():
        driver.on_stop = None
        checker.start(); checker.join(0.3)             # the pass is blocked on the lock the shutdown stop holds
    driver.on_stop = inject
    before = driver.starts
    sup.shutdown()
    sup.stop(mid)                                      # the lifespan's stop: records nothing, desired stays awake
    checker.join(5)
    assert not checker.is_alive()
    assert mid not in driver.running and driver.starts == before
    assert hive._agent_row(mid)["desired"] == "awake"  # kept for the next boot's restore
    sup.check()
    assert driver.starts == before


def test_the_lifespan_marks_the_supervisor_shut_down():
    with tempfile.TemporaryDirectory(prefix="hive-shutdown-") as temp:
        from fastapi.testclient import TestClient
        settings = load_settings(data_dir=pathlib.Path(temp) / "hive", petta_path=PETTA, offline=True, default_driver="local")
        app = create_app(settings, reconcile_seconds=0)
        sup = app.state.hive.supervisor
        sup.drivers["local"] = FakeDriver()
        with TestClient(app):
            assert not sup._stop.is_set()
        assert sup._stop.is_set()


# ---- the transition marks each guard on its own (TF2, TF3) -------------------------------------------------------------

def test_reconcile_inside_the_record_window_after_driver_stop_cannot_restart(client):
    """Hive._mind_lock must hold the transition (not only the lock) from the driver effect through the record: a pass
    re-entered after Supervisor.stop returned but before desired is written must not restart the mind (TF2)."""
    for action, settled in (("stop", "stopped"), ("sleep", "asleep")):
        hive = client.app.state.hive
        sup, driver = real_supervisor(hive)
        mid = awake_mind(client, hive, driver)
        real_set_status = hive.set_status
        def set_status(agent_id, *args, **kwargs):
            hive.set_status = real_set_status
            sup.check()                                # same thread, driver stopped, desired still awake
            return real_set_status(agent_id, *args, **kwargs)
        hive.set_status = set_status
        before = driver.starts
        try:
            hive.lifecycle(mid, action)
        finally:
            hive.set_status = real_set_status
        row = hive._agent_row(mid)
        assert (row["status"], row["desired"]) == (settled, settled), action
        assert mid not in driver.running and driver.starts == before, action


def test_a_reconcile_restart_is_not_repeated_by_a_pass_re_entered_from_the_driver_start(client):
    """Supervisor.start's own transition (TF3 path 1): check -> _reconcile -> start, with a pass re-entered from the
    driver's start, starts the mind once and charges the restart budget once."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.running.discard(mid)
    real_start = driver.start
    def start(agent, env):
        driver.start = real_start
        sup.check()                                    # before the process is visible as running
        real_start(agent, env)
    driver.start = start
    before = driver.starts
    sup.check()
    assert driver.starts == before + 1 and len(sup._restarts[mid]) == 1


def test_a_bare_supervisor_stop_is_not_undone_by_a_re_entered_pass(client):
    """Supervisor.stop's own transition (TF3 path 2, the shutdown stop with no Hive lock)."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    driver.on_stop = lambda: (setattr(driver, "on_stop", None), sup.check())
    before = driver.starts
    sup.stop(mid)
    assert mid not in driver.running and driver.starts == before


# ---- Review B1 (749b8d6): the registration fence after the accept await ------------------------------------------------
# The hub admitted, awaited ws.accept(), then registered with admitted=True, skipping the fresh check: a stop in that
# gap registered a stale socket and issued it a nonce. Registration is now one locked check-and-register against the
# current desired state and the lifecycle generation; every stop withdraws a registered connection under that lock.

def _hub_mind(client, hive, driver):
    """A started hive-run mind with its token, as a real process connects."""
    sw = client.post("/api/swarms", json={"name": "Hub"}).json()
    m = hive.create_agent("hub", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.db.execute("UPDATE agents SET driver = 'local' WHERE id = ?", (m["id"],))
    hive.lifecycle(m["id"], "start")
    assert m["id"] in driver.running
    return m["id"], {"Authorization": f"Bearer {m['token']}"}


def _registered(hive, mid, timeout=5.0):
    """The hub registers on a worker thread after accept; wait for it rather than racing it (slower hosts lose)."""
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if mid in hive.connections and mid in hive.boot_nonce:
            return True
        time.sleep(0.01)
    return False


def _delayed_accept(monkeypatch, during):
    """ws.accept() is held while `during` runs: the gap between the hub's admission and its registration."""
    from starlette.websockets import WebSocket
    real_accept = WebSocket.accept
    fired = []
    async def accept(self, *args, **kwargs):
        if self.url.path == "/agent-hub" and not fired:
            fired.append(True)
            await asyncio.to_thread(during)            # another thread, as an API stop would be
        return await real_accept(self, *args, **kwargs)
    monkeypatch.setattr(WebSocket, "accept", accept)
    return fired


@pytest.mark.parametrize("action", ["stop", "sleep", "delete"])
def test_hub_a_stop_during_the_accept_await_refuses_registration(client, monkeypatch, action):
    from starlette.websockets import WebSocketDisconnect
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid, headers = _hub_mind(client, hive, driver)
    received = []
    real_record = hive.record_agent_message
    hive.record_agent_message = lambda *a, **k: (received.append(a), real_record(*a, **k))[1]
    fired = _delayed_accept(monkeypatch, lambda: hive.delete_agent(mid) if action == "delete" else hive.lifecycle(mid, action))
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/agent-hub", headers=headers) as ws:
            ws.send_text('{"type": "agent_message", "client_seq": "late", "text": "should never be handled"}')
            ws.receive_text()
    assert fired and closed.value.code == 4409
    assert mid not in hive.connections and mid not in hive.boot_nonce
    assert received == []                              # never entered the receive loop
    assert mid not in driver.running
    if action != "delete":
        row = hive._agent_row(mid)
        assert (row["status"], row["desired"]) == ({"stop": "stopped", "sleep": "asleep"}[action],) * 2
        before = driver.starts
        sup.check()
        assert driver.starts == before


def test_hub_without_a_stop_in_the_gap_registers(client, monkeypatch):
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid, headers = _hub_mind(client, hive, driver)
    fired = _delayed_accept(monkeypatch, lambda: None)
    with client.websocket_connect("/agent-hub", headers=headers) as ws:
        ws.send_text('{"type": "resume", "last_seen_seq": null}')
        assert fired and _registered(hive, mid)
        assert hive._agent_row(mid)["status"] == "awake"


def test_hub_a_stop_after_registration_withdraws_and_closes_the_socket(client):
    from starlette.websockets import WebSocketDisconnect
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid, headers = _hub_mind(client, hive, driver)
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/agent-hub", headers=headers) as ws:
            ws.send_text('{"type": "resume", "last_seen_seq": null}')
            assert _registered(hive, mid)
            hive.lifecycle(mid, "stop")
            assert mid not in hive.connections and mid not in hive.boot_nonce
            ws.receive_text()
    assert closed.value.code == 4409
    assert hive._agent_row(mid)["status"] == "stopped"


def test_review_probe_admitted_true_after_stop_is_refused(client):
    """Review's probe (review-admit-gap.py), kept as a pin: a bare admitted=True never bypasses the fence."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    assert asyncio.run(hive.admit_connection(mid))
    hive.lifecycle(mid, "stop")
    assert asyncio.run(hive.agent_connected(mid, FakeWS(), admitted=True)) is False
    assert mid not in hive.connections and mid not in hive.boot_nonce


def test_stop_then_start_replaces_the_generation_and_the_old_admission_is_refused(client):
    """desired is awake again after the restart, so only the generation tells the old process's admission apart."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    old = asyncio.run(hive.admit_connection(mid))
    hive.lifecycle(mid, "stop")
    hive.lifecycle(mid, "start")
    assert hive._agent_row(mid)["desired"] == "awake"
    assert asyncio.run(hive.agent_connected(mid, FakeWS(), admitted=old)) is False
    assert sup.generation(mid) == old.generation + 2
    assert mid not in hive.connections and mid not in hive.boot_nonce
    new = asyncio.run(hive.admit_connection(mid))
    ws = FakeWS()
    assert asyncio.run(hive.agent_connected(mid, ws, admitted=new)) is True and hive.connections[mid] is ws


def test_competing_old_and_new_socket_callbacks(client):
    """Old process's socket admitted before a stop/start; the new process's socket registers; the old callback runs
    last and must neither replace the new socket nor its nonce. And the other order: the old socket registered first
    is withdrawn and closed by the stop, and the new one registers cleanly."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mid = awake_mind(client, hive, driver)
    # new wins, old callback late
    old_admission = asyncio.run(hive.admit_connection(mid))
    hive.lifecycle(mid, "stop"); hive.lifecycle(mid, "start")
    new_ws, old_ws = FakeWS(), FakeWS()
    assert asyncio.run(hive.agent_connected(mid, new_ws, admitted=asyncio.run(hive.admit_connection(mid)))) is True
    nonce = hive.boot_nonce[mid]
    assert asyncio.run(hive.agent_connected(mid, old_ws, admitted=old_admission)) is False
    assert hive.connections[mid] is new_ws and hive.boot_nonce[mid] == nonce and new_ws.closed is None
    # old registered first, then stop/start, then new
    first = FakeWS()
    hive.connections.pop(mid, None)
    assert asyncio.run(hive.agent_connected(mid, first)) is True
    hive.lifecycle(mid, "stop")
    assert mid not in hive.connections and mid not in hive.boot_nonce
    hive.lifecycle(mid, "start")
    second = FakeWS()
    assert asyncio.run(hive.agent_connected(mid, second)) is True
    assert hive.connections[mid] is second and second.closed is None
    # the old socket's own disconnect callback arrives last: it must not drop the new registration
    hive.agent_disconnected(mid, first)
    assert hive.connections[mid] is second and mid in hive.boot_nonce


def test_a_registration_racing_a_stop_from_another_thread_is_serialized(client):
    """The fence and stop's withdrawal share the mind's lock: whichever wins, no registered socket outlives the stop."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    for registration_first in (True, False):
        mid = awake_mind(client, hive, driver)
        admission = asyncio.run(hive.admit_connection(mid))
        ws = FakeWS()
        if registration_first:
            assert asyncio.run(hive.agent_connected(mid, ws, admitted=admission)) is True
            hive.lifecycle(mid, "stop")
        else:
            result = {}
            fence = threading.Thread(target=lambda: result.setdefault(
                "ok", asyncio.run(hive.agent_connected(mid, ws, admitted=admission))))
            def inject():
                driver.on_stop = None
                fence.start(); fence.join(0.3)
                assert fence.is_alive()                # waits on the lock held by the stop
            driver.on_stop = inject
            hive.lifecycle(mid, "stop")
            fence.join(5)
            assert result["ok"] is False
        assert mid not in hive.connections and mid not in hive.boot_nonce, registration_first


def test_an_external_member_keeps_its_connection_through_a_stop(client):
    """Module members run outside the hive: no desired/generation fence, and a stop does not withdraw them (as before)."""
    hive = client.app.state.hive
    sup, driver = real_supervisor(hive)
    mod = hive.create_agent("ext2", "module", None, None, "", None, 0, None, None)
    admission = asyncio.run(hive.admit_connection(mod["id"]))
    hive.supervisor.stop(mod["id"])
    ws = FakeWS()
    assert asyncio.run(hive.agent_connected(mod["id"], ws, admitted=admission)) is True
    hive.supervisor.stop(mod["id"])
    assert hive.connections[mod["id"]] is ws and ws.closed is None
