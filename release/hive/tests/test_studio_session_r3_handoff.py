"""J3 host R3: the maker handoff, Stop and step delivery (PLATFORM_J3R4_HOST_HANDOFF_SPEC_R2.md r2.4, §10's list).

Synthetic only: temporary data directories, the real Supervisor (locks, transition, check, stop, verify_stopped) over
the fake process driver of test_studio_session_r3.py, stand-in hub sockets, invented keys and reservations, no provider
call, no live hive, no real restart: the safe-restart and cloud gates run only their decision lines, against a copy of
the test database, with the process query stubbed. A "crash" is a BaseException thrown at the named point (a worker
thread dies there, its transaction rolls back) followed by a simulated restart: the startup recovery under the new
process, a new owner_boot, new in-process locks and worker, no hub connections."""
import asyncio
import datetime
import json
import os
import pathlib
import secrets
import sqlite3
import subprocess
import sys
import threading
import time

import pytest

from hive.tests.test_studio_session_r3 import (SH, Hub, connect, done, drive, epoch_of, in_step, maker_headers,  # noqa: F401
                                               mount, on_loop, open_session, outcome, publish, r3, ses_row, started,
                                               step_row, tick, token_now, upload)
from hive.tests.test_studio_session_r3 import _direction  # noqa: F401
from hive.tests.test_ask_intents import a, held, release  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MODEL, err, s  # noqa: F401

try:
    from hive.core.studio_steps import StudioSteps
except ImportError:
    StudioSteps = None


class Crash(BaseException):
    """The process dies here (not an Exception: nothing in the job handles it; its open transaction rolls back)."""


# ---- helpers -----------------------------------------------------------------------------------------------------------

def studio(x):
    return x.hive.studio


def handoff(x, sid):
    return studio(x)._latest_handoff(sid)


def files(x, agent_id=None):
    root = x.workspace.path(agent_id or x.maker["id"])
    return sorted(p.name for p in root.iterdir() if p.name.startswith(("token", "pending", "current")))


def credential_ok(x, agent_id=None):
    """token-e<current> hashes to agents.token_hash (what ownership waits for before it clears)."""
    from hive.core.hive import token_hash
    aid = agent_id or x.maker["id"]
    row = x.hive.db.one("SELECT token_hash FROM agents WHERE id = ?", (aid,))
    return token_hash(token_now(x, aid)) == row["token_hash"]


def ready2(x):
    """Step 1 done with more work; the next upload opens the attempt for step 2."""
    session, sid, m, ack, step = started(x)
    in_step(x, sid, step)
    done(x, sid, 1, step["execution_id"], more=True)
    return session, sid, m, step


def control(x, sid, action, cid=None, **extra):
    return x.client.post(f"/api/studio-sessions/{sid}/controls", headers=x.mg,
                         json={"control_id": cid or f"{action[:6]}-{secrets.token_hex(4)}", "action": action, **extra})


def stop(x, sid):
    r = control(x, sid, "stop")
    assert r.status_code == 200, r.text
    return r


def wait_for(pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def hook(*rules, only=None):
    """SH.HOOK from (kind, name-prefix, action) rules; action is an exception to raise or a (gate, entered) pair. only:
    the maker whose workspace the rules apply to (every workspace when None)."""
    def h(kind, path):
        owner = path.name if kind in ("dirsync", "final") else path.parent.name
        if only is not None and owner != only:
            return
        for k, prefix, action in rules:
            if kind == k and path.name.startswith(prefix):
                if isinstance(action, tuple):
                    action[1].set()
                    assert action[0].wait(60)
                else:
                    raise action
    SH.HOOK = h


def gate_pair():
    return threading.Event(), threading.Event()


def restart(x):
    """A hive restart, in process: the startup recovery (under the new process's flock in production), a new owner_boot,
    new in-process owners and worker, and no hub connection survives."""
    st = studio(x)
    st.worker.wait_idle(15)
    with x.hive.db.transaction() as tx:
        StudioSteps.recover_startup(tx)
    st.boot = secrets.token_hex(8)
    st._owners = {}
    st.worker = SH.StudioWorker()
    x.sup._locks.clear()                                                   # every in-process lock dies with the process
    x.sup._transitions.clear()
    for aid in list(x.hive.connections):
        x.hive.connections.pop(aid, None)
        x.hive.boot_nonce.pop(aid, None)
    x.hive.db.execute("DELETE FROM studio_hub_registrations")
    SH.HOOK = None


def wake_refused(x):
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        x.hive.lifecycle(x.maker["id"], "wake")
    assert e.value.code == "studio_owned"
    starts = [c for c in x.driver.calls if c == ("start", x.maker["id"])]
    x.hive.db.execute("UPDATE agents SET status = 'asleep' WHERE id = ? AND status != 'awake'", (x.maker["id"],))
    on_loop(x, x.hive.send_to_agent, x.maker["id"], "are you there?")     # an inbound message: stored, never a wake
    assert [c for c in x.driver.calls if c == ("start", x.maker["id"])] == starts


def new_mind(x, name, session_maker=False):
    m = x.client.post("/api/agents", json={"name": name, "swarm_id": x.home["id"], "model": MODEL, "budget_usd": 5,
                                           "options": {"key": KEY}}).json()
    root = x.workspace.path(m["id"])
    root.mkdir(parents=True, exist_ok=True)
    (root / "token").write_text(m["token"])
    x.driver.known.add(m["id"])
    x.hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (m["id"],))
    return m


def crashed_mind(x):
    """Another mind that should be awake and whose process has died: check() restarts it."""
    return new_mind(x, "Crashed " + secrets.token_hex(2))


def clone_session(x, sid, maker_id, **over):
    """A second consent-v2 session row for another maker (and another person), for multi-maker isolation tests."""
    row = dict(ses_row(x, sid))
    h = secrets.token_hex(12)
    row.update({"id": "ss_" + h, "intent_id": "int_" + h, "goal_id": "g_" + h[:8], "proposal_artifact_id": "art_" + h,
                "stream_id": "as_" + h, "principal": "user:u_" + h[:8], "maker_id": maker_id, "source_artifact_id": None,
                "maker_released": 0, "stop_verified": 0, "release_phase": "none", "release_epoch": None,
                "release_token_hash": None, "current_handoff": None, **over})
    x.hive.db.insert("studio_sessions", row)
    return row["id"]


def reserve(x, label=None, dispatched=True, agent_id=None, key=None):
    """An invented liability of the maker's (no provider call), optionally under a step label."""
    from hive.core.cost_reservations import Reservations
    res = Reservations(x.hive.db)
    key = key or "res-" + secrets.token_hex(6)
    aid = agent_id or x.maker["id"]
    budgets = [("hive:month", 1000, 0)] + ([(label, 1000, 0)] if label else [])
    res.reserve(key, {"agent": aid, "n": key}, 0.05, lambda: budgets, metadata={"agent": aid, "model": MODEL},
                dispatched=dispatched, subjects=["agent:" + aid])
    return res, key


def past(seconds=10):
    from hive.core.minds import stamp
    return stamp(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds))


def until_released(x, sid, rounds=40):
    """Tick until the session is released, without waiting for the whole worker to be idle (other jobs are stuck)."""
    for _ in range(rounds):
        if released(x, sid):
            break
        wait_for(lambda: not studio(x).worker.outstanding(x.maker["id"]), 5)
        tick(x)
    assert released(x, sid) and credential_ok(x)


def released(x, sid):
    row = ses_row(x, sid)
    return row["state"] == "stopped" and row["maker_released"] == 1


def stopped_and_released(x, sid, rounds=6):
    drive(x, rounds=rounds)
    row = ses_row(x, sid)
    assert released(x, sid), {k: row[k] for k in ("state", "stop_verified", "stop_failed", "release_stale", "release_phase",
                                                   "credential_reason")}
    assert credential_ok(x) and not studio(x).studio_owns(x.maker["id"])
    agent = x.hive.db.one("SELECT * FROM agents WHERE id = ?", (x.maker["id"],))
    assert (agent["desired"], agent["status"]) == ("asleep", "asleep")
    assert not studio(x).fenced(x.maker["id"], agent["token_epoch"])        # an ordinary sleeping mind, unfenced
    return row


# ---- §2 ownership guard: every caller of lifecycle, and _reconcile ---------------------------------------------------------

def test_lifecycle_callers_are_pinned_and_each_action_is_refused_while_owned(r3):
    """J2: the guard sits inside Hive.lifecycle, so every caller is covered; the caller list is pinned so a new one is
    noticed (and reviewed) rather than assumed covered."""
    import re
    core = pathlib.Path(__file__).resolve().parents[1] / "core"
    calls = {}
    for path in sorted(core.glob("*.py")):
        n = len(re.findall(r"\.lifecycle[(,]", path.read_text()))
        if n:
            calls[path.name] = n
    # 14 call sites at 3a993362 (the spec counted 9 at de2e201d), 15 at fccbe846 (Hive.sleep_for_restart, the Mac
    # restart-prepare pass): each passes through Hive.lifecycle's guard
    assert calls == {"app.py": 1, "delegation.py": 2, "hive.py": 5, "minds.py": 4, "newhive.py": 1, "onboarding.py": 1,
                     "power.py": 1}, calls
    session, sid, m, ack, step = started(r3)
    from hive.core.hive import HiveError
    for action in ("start", "wake", "stop", "sleep"):
        with pytest.raises(HiveError) as e:
            r3.hive.lifecycle(r3.maker["id"], action)
        assert (e.value.status, e.value.code) == (409, "studio_owned")
    assert r3.hive._agent_row(r3.maker["id"])["status"] == "awake"            # the Mac restart-prepare pass refuses an owned maker
    out = r3.hive.sleep_for_restart()
    assert {"id": r3.maker["id"], "error": "studio_owned"} in out["failed"], out
    r = r3.client.post(f"/api/agents/{r3.maker['id']}/stop")                # the admin route
    assert (r.status_code, err(r)["code"]) == (409, "studio_owned")
    r3.driver.procs.pop(r3.maker["id"])                                    # its process died
    starts = r3.driver.calls.count(("start", r3.maker["id"]))
    for _ in range(3):
        r3.sup.check()
    assert r3.driver.calls.count(("start", r3.maker["id"])) == starts and r3.maker["id"] not in r3.driver.procs


def test_studio_off_changes_nothing_for_ordinary_minds(r3, monkeypatch):
    session = open_session(r3)
    monkeypatch.setattr(studio(r3), "enabled", False)
    assert not studio(r3).studio_owns(r3.maker["id"])
    assert not studio(r3).holds_messages(r3.maker["id"])
    on_loop(r3, studio(r3).tick)                                           # inert
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs")["n"] == 0
    other = crashed_mind(r3)
    r3.sup.check()                                                         # the blocking pass, as before
    assert ("start", other["id"]) in r3.driver.calls
    assert session["session_id"]


# ---- isolation (§8) ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("park", ["pending-token-e", "current.tmp", "dirsync"])
def test_iso_parked_release_fsync_via_production_reconcile(r3, park):
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    root = r3.workspace.path(r3.maker["id"])
    gate, entered = gate_pair()
    if park == "dirsync":
        hook(("dirsync", root.name, (gate, entered)), only=r3.maker["id"])
    else:
        hook(("fsync", park, (gate, entered)), only=r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)                                                # job S parked on its own fsync
    other = crashed_mind(r3)
    b = new_mind(r3, "Maker B")
    sid_b = clone_session(r3, sid, b["id"], state="stopping", stopping_deadline=past(-700))
    hive.db.execute("UPDATE studio_sessions SET stopping_deadline = ? WHERE id = ?", (past(), sid))
    started_at = time.monotonic()
    on_loop(r3, r3.client.app.state.reconcile_once)                        # the production reconcile pass
    assert time.monotonic() - started_at < 10
    assert ("start", other["id"]) in r3.driver.calls                       # the crashed mind was restarted
    for _ in range(6):                                                     # the other stopping row, on a second worker
        if released(r3, sid_b):
            break
        wait_for(lambda: not studio(r3).worker.outstanding(b["id"]))
        on_loop(r3, r3.client.app.state.reconcile_once)
    assert released(r3, sid_b) and credential_ok(r3, b["id"])
    assert ses_row(r3, sid)["release_stale"] == 1                          # flipped while the first is still parked
    assert studio(r3).worker.outstanding(r3.maker["id"]) and not gate.is_set()
    gate.set()
    SH.HOOK = None
    stopped_and_released(r3, sid)


def test_iso_slow_fsync_in_job_a_does_not_block_reconcile(r3):
    session, sid, m, step = ready2(r3)
    gate, entered = gate_pair()
    hook(("fsync", "pending-token-e", (gate, entered)))
    upload(r3, sid, m, 2, gen=2)
    assert entered.wait(15)
    other = crashed_mind(r3)
    t0 = time.monotonic()
    r3.sup.check()
    on_loop(r3, studio(r3).tick)
    assert time.monotonic() - t0 < 3 and ("start", other["id"]) in r3.driver.calls
    gate.set()
    SH.HOOK = None
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_iso_blocked_send_holds_no_db_or_supervisor_lock(r3, monkeypatch):
    monkeypatch.setattr(SH, "DELIVERY_BUDGET_S", 1.5)
    session, sid, m, step = ready2(r3)
    blocked = threading.Event()

    class Wedged(Hub):
        async def send_text(self, text):
            blocked.set()
            await asyncio.sleep(3600)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    tick(r3)                                                               # B
    studio(r3).worker.wait_idle(15)
    aid, token = r3.driver.pending.pop(0)
    agent = r3.hive.authenticate_agent(token)
    hub = Wedged()
    r3.hive._register_connection(aid, hub, None)
    studio(r3).connected(agent, hub)
    on_loop(r3, studio(r3).tick)                                           # admission + a delivery task (not awaited)
    assert blocked.wait(5)
    lock = r3.sup.lock(aid)
    got = []
    t = threading.Thread(target=lambda: got.append(lock.acquire(blocking=False)) or (got[-1] and lock.release()))
    t.start()
    t.join(2)
    assert got == [True]                                                   # the send holds no supervisor lock
    with r3.hive.db.transaction():                                         # nor the database
        r3.hive.db.execute("UPDATE agents SET last_active_at = last_active_at WHERE id = ?", (aid,))
    on_loop(r3, studio(r3).settle_deliveries)
    assert step_row(r3, sid, 2)["delivery_outcome"] == "maker_unresponsive"


def test_iso_settling_parked_call_other_minds_reconcile(r3):
    session, sid, m, step = ready2(r3)
    res, key = reserve(r3)                                                 # a dispatched call of the old epoch
    upload(r3, sid, m, 2, gen=2)
    drive(r3, connect_started=False)
    assert handoff(r3, sid)["state"] == "settling"
    other = crashed_mind(r3)
    r3.sup.check()
    assert ("start", other["id"]) in r3.driver.calls and r3.maker["id"] not in r3.driver.procs
    drive(r3)
    assert handoff(r3, sid)["state"] == "settling" and step_row(r3, sid, 2) is None
    res.settle(key, 0.01, lambda: None)
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_iso_check_skips_busy_mind_lock(r3):
    session, sid, m, step = ready2(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    upload(r3, sid, m, 2, gen=2)
    assert entered.wait(15)                                                # job A holds the maker's lock in a stop
    other = crashed_mind(r3)
    t0 = time.monotonic()
    r3.sup.check()
    assert time.monotonic() - t0 < 3 and ("start", other["id"]) in r3.driver.calls
    gate.set()
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_iso_delivery_never_blocks_loop_on_busy_lock(r3, monkeypatch):
    monkeypatch.setattr(SH, "DELIVERY_BUDGET_S", 1.0)
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    studio(r3).worker.wait_idle(15)
    for aid, token in r3.driver.pending:
        connect(r3, aid, token)
    r3.driver.pending.clear()
    hold, holding = threading.Event(), threading.Event()

    def holder():
        with r3.sup.lock(r3.maker["id"]):
            holding.set()
            hold.wait(10)
    t = threading.Thread(target=holder)
    t.start()
    assert holding.wait(5)
    on_loop(r3, studio(r3).tick)                                           # admission; the delivery polls the lock
    t0 = time.monotonic()
    assert r3.client.get("/api/agents").status_code == 200                 # the loop keeps serving
    assert time.monotonic() - t0 < 1.0
    on_loop(r3, studio(r3).settle_deliveries)
    assert step_row(r3, sid, 2)["delivery_outcome"] == "delivery_uncertain"
    hold.set()
    t.join(5)


def test_iso_four_wedged_sends_hub_still_serves_others(r3, monkeypatch):
    monkeypatch.setattr(SH, "DELIVERY_BUDGET_S", 1.0)
    hive, st = r3.hive, studio(r3)
    sent = []

    class Wedged(Hub):
        def __init__(self, name):
            super().__init__()
            self.name = name

        async def send_text(self, text):
            sent.append(self.name)
            await asyncio.sleep(3600)
    for i in range(5):
        aid = f"a_fake{i:04d}"
        hive.connections[aid] = Wedged(aid)
        hive.boot_nonce[aid] = f"n{i}"

    async def go():
        for i in range(5):
            st._start_delivery(f"ss_none{i}", 1, f"a_fake{i:04d}", f"dl_{i}", f"n{i}", "{}")
        await asyncio.sleep(0.3)
        return st._sends, list(sent)
    in_flight, first = on_loop(r3, go)
    assert in_flight == 4 and len(first) == 4 and "a_fake0004" not in first   # the fifth waits for a slot
    assert r3.client.get("/api/agents").status_code == 200                     # the hub answers others meanwhile
    on_loop(r3, st.settle_deliveries)
    assert "a_fake0004" in sent and st._sends == 0 and st.deliveries == {}
    for i in range(5):
        hive.connections.pop(f"a_fake{i:04d}", None)


def test_iso_two_stuck_jobs_third_stop_still_runs(r3):
    session, sid, m, ack, step = started(r3)
    st = studio(r3)
    stuck = threading.Event()
    for i in range(2):
        st.worker.submit(f"a_stuck{i:03d}", "attempt", "A", lambda: stuck.wait(30))
    stop(r3, sid)
    until_released(r3, sid)
    stuck.set()


def test_iso_job_stuck_marked_after_300s(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    monkeypatch.setattr(SH, "JOB_STUCK_S", 0.05)
    time.sleep(0.1)
    on_loop(r3, studio(r3).tick)
    assert ses_row(r3, sid)["job_stuck_at"] is not None
    view = r3.client.get(f"/api/studio-sessions/{sid}/audit", headers=r3.jon).json()
    assert view["worker"]["classes"]["S"]["stuck"] == 1 and view["worker"]["stuck_makers"] == [r3.maker["id"]]
    assert view["worker"]["stuck_processes"][r3.maker["id"]] == r3.driver.procs[r3.maker["id"]]   # for an OS stop
    assert "restart the hive" in view["worker"]["message"]
    assert "stuck work" in r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["stop"]["message"]
    assert studio(r3).worker.outstanding(r3.maker["id"])                    # never killed
    gate.set()
    stopped_and_released(r3, sid)


def test_iso_ten_running_stuck_attempts_plus_queued_unrelated_stop_runs(r3):
    """Through the real stop entry point: the S job's verified stop is Supervisor.stop (drivers.py)."""
    session, sid, m, ack, step = started(r3)
    st = studio(r3)
    stuck = threading.Event()
    for i in range(11):                                                    # 10 running, 1 queued
        st.worker.submit(f"a_att{i:04d}", "attempt", "A", lambda: stuck.wait(30))
    assert st.worker.counts()["attempt"] == {"running": 10, "queued": 1, "stuck": 0}
    stop(r3, sid)
    until_released(r3, sid)
    assert ("stop", r3.maker["id"]) in r3.driver.calls
    stuck.set()


def test_iso_two_running_stuck_cleanups_plus_queued_unrelated_stop_runs(r3):
    session, sid, m, ack, step = started(r3)
    st = studio(r3)
    stuck = threading.Event()
    for i in range(3):
        st.worker.submit(f"a_cln{i:04d}", "cleanup", "cleanup", lambda: stuck.wait(30))
    assert st.worker.counts()["cleanup"]["running"] == 2 and st.worker.counts()["cleanup"]["queued"] == 1
    stop(r3, sid)
    until_released(r3, sid)
    stuck.set()


def test_iso_class_precedence_s_over_attempts_over_cleanup():
    worker = SH.StudioWorker()
    worker.pause()
    go = threading.Event()
    for maker, cls in (("m-clean", "cleanup"), ("m-att", "attempt"), ("m-stop", "S")):
        worker.submit(maker, cls, cls, lambda: go.wait(5))
    assert not worker.submit("m-att", "S", "S", lambda: None)              # one outstanding job per maker
    worker.resume()
    go.set()
    assert worker.wait_idle(5)
    assert [h[0] for h in worker.history] == ["S", "attempt", "cleanup"]


def test_iso_restart_recovers_stuck_jobs_from_persisted_state(r3):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)                                                # S stuck in the kernel/driver
    old_worker = studio(r3).worker
    restart(r3)                                                            # progress is in the DB
    del r3.driver.gates[("stop", r3.maker["id"])]                          # the new process's stop is not stuck
    stopped_and_released(r3, sid)
    epoch = epoch_of(r3)
    gate.set()                                                             # the old thread returns late: inert
    assert old_worker.wait_idle(15)
    assert released(r3, sid) and epoch_of(r3) == epoch and credential_ok(r3)


def test_iso_nonstudio_mind_skipped_while_busy_then_reconciled_with_fresh_reread(r3):
    other = crashed_mind(r3)
    mid, holding = threading.Event(), threading.Event()

    def mid_stop():                                                        # an ordinary stop in progress on its lock
        with r3.sup.lock(other["id"]):
            holding.set()
            mid.wait(10)
            r3.hive.db.execute("UPDATE agents SET desired = 'asleep', status = 'asleep' WHERE id = ?", (other["id"],))
    t = threading.Thread(target=mid_stop)
    t.start()
    assert holding.wait(5)
    t0 = time.monotonic()
    r3.sup.check()                                                         # skipped, not waited for
    assert time.monotonic() - t0 < 3 and ("start", other["id"]) not in r3.driver.calls
    mid.set()
    t.join(5)
    r3.sup.check()                                                         # fresh re-read under the lock: asleep
    assert ("start", other["id"]) not in r3.driver.calls


# ---- attempts (§4) -------------------------------------------------------------------------------------------------------

def test_A_write_failure_leaves_maker_running_on_k(r3):
    session, sid, m, step = ready2(r3)
    k, running = epoch_of(r3), r3.driver.procs[r3.maker["id"]]
    stops = r3.driver.calls.count(("stop", r3.maker["id"]))
    hook(("write", "pending-token-e", OSError("disk full")))
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    h = handoff(r3, sid)
    assert (h["state"], h["reason"]) == ("held", "credential_write_failed")
    assert epoch_of(r3) == k and r3.driver.procs[r3.maker["id"]] == running
    assert r3.driver.calls.count(("stop", r3.maker["id"])) == stops       # nothing was stopped
    assert credential_ok(r3)


def test_A_stop_failure_holds_no_install(r3):
    session, sid, m, step = ready2(r3)
    k, before_files, current = epoch_of(r3), files(r3), token_now(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("group survived KILL")
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert (handoff(r3, sid)["state"], handoff(r3, sid)["reason"]) == ("held", "execution_retirement_failed")
    assert epoch_of(r3) == k and token_now(r3) == current                  # no rotate, no rename, no pointer change
    now_files = files(r3)
    assert f"token-e{k + 1}" not in now_files and set(now_files) - set(before_files) <= {f"pending-token-e{k + 1}", "current.tmp"}
    assert not r3.hive.db.one("SELECT 1 FROM studio_fenced_executions WHERE maker_id = ? AND reason = 'handoff' "
                              "AND token_epoch = ?", (r3.maker["id"], k))  # no handoff fence: nothing was stopped


def test_A_fence_marks_unreported_steps_interrupted(r3):
    """SIMULATED DIRECTIONS: a direction bound to the open step goes back to the queue when its step is interrupted."""
    session, sid, m, ack, step = started(r3)
    _direction(r3, sid, 1, "warmer")
    in_step(r3, sid, step)
    st, db = studio(r3), r3.hive.db
    k = epoch_of(r3)
    db.insert("studio_handoffs", {"id": "ho_manual0001", "maker_id": r3.maker["id"], "session_id": sid, "step_n": 2,
                                  "attempt": 1, "from_epoch": k, "to_epoch": k + 1, "token_hash": None, "state": "in_progress",
                                  "owner_boot": st.boot, "window_s": 60, "created_at": SH.now(), "updated_at": SH.now()})
    st.job_a("ho_manual0001")
    assert step_row(r3, sid, 1)["state"] == "interrupted" and st.fenced(r3.maker["id"], k)
    assert handoff(r3, sid)["state"] == "settling"
    assert db.one("SELECT studio_step FROM ask_steers WHERE studio_seq = 1")["studio_step"] is None


def test_B_revalidation_stale_exits(r3):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    h = handoff(r3, sid)
    assert h["state"] == "settling"
    r3.hive.rotate_token(r3.maker["id"], h["from_epoch"], "someone-else")   # the DB epoch moved under the row
    studio(r3).job_b(h["id"])
    assert (handoff(r3, sid)["state"], handoff(r3, sid)["reason"]) == ("held", "handoff_stale")
    assert ("start", r3.maker["id"]) not in r3.driver.calls[-1:]


def test_B_reconcile_cannot_start_between_start_and_proof(r3):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, connect_started=False)
    assert handoff(r3, sid)["state"] in ("settling", "awaiting_proof")
    drive(r3, connect_started=False)
    assert handoff(r3, sid)["state"] == "awaiting_proof"
    starts = r3.driver.calls.count(("start", r3.maker["id"]))
    r3.driver.procs.pop(r3.maker["id"])                                    # the new process died before its proof
    for _ in range(3):
        r3.sup.check()
    assert r3.driver.calls.count(("start", r3.maker["id"])) == starts      # reconcile never starts an owned maker


def test_admission_requires_zero_old_reservations(r3):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    assert handoff(r3, sid)["state"] == "awaiting_proof"
    res, key = reserve(r3, dispatched=False)                               # an old-epoch reservation appears
    for aid, token in r3.driver.pending:
        connect(r3, aid, token)
    r3.driver.pending.clear()
    tick(r3)
    assert step_row(r3, sid, 2) is None and handoff(r3, sid)["proven_at"] is not None
    res.abort_before_dispatch(key)
    tick(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_proof_window_doubles_and_holds(r3):
    session, sid, m, step = ready2(r3)
    windows = []
    for i in range(4):
        if i:
            r = control(r3, sid, "retry_retirement")
            assert r.status_code == 200 and "attempt_opened" not in r.json(), r.text
        else:
            upload(r3, sid, m, 2, gen=2)
        drive(r3, rounds=2, connect_started=False)
        h = handoff(r3, sid)
        assert h["state"] == "awaiting_proof", (h, ses_row(r3, sid)["state_reason"])
        windows.append(h["window_s"])
        r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h["id"]))
        r3.driver.pending.clear()
        tick(r3)
        assert (handoff(r3, sid)["state"], ses_row(r3, sid)["state_reason"]) == ("held", "boundary_unobserved")
    assert windows[:3] == [60, 120, 240]
    # r2.5 §4: attempts 2-4 were the three retries of the hour; a fourth retry is refused
    assert control(r3, sid, "retry_retirement").json()["state_reason"] == "handoff_retry_exhausted"


# ---- settlement (§4) -----------------------------------------------------------------------------------------------------

def test_settle_before_move_counts_as_settled(r3):
    session, sid, m, step = ready2(r3)
    res, key = reserve(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=1, connect_started=False)
    h = handoff(r3, sid)
    assert h["state"] == "settling"
    res.settle(key, 0.02, lambda: None)                                    # settled concurrently
    r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h["id"]))
    with r3.hive.db.transaction():
        assert studio(r3).unknown_move(r3.maker["id"]) == 0                # rowcount 0 counts as success
    assert res.get(key)["state"] == "settled"
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_move_then_late_settle_records_once_on_step_n_labels(r3):
    from hive.core.studio_sessions import step_label
    session, sid, m, step = ready2(r3)
    res, key = reserve(r3, label=step_label(sid, 1))                       # step 1's call, still dispatched
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=1, connect_started=False)
    r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), handoff(r3, sid)["id"]))
    drive(r3)
    assert res.get(key)["state"] == "unknown" and step_row(r3, sid, 2)["state"] == "admitted"
    recorded = []
    assert res.settle(key, 0.03, lambda: recorded.append(1)) is True       # late, through the existing settle()
    assert res.settle(key, 0.03, lambda: recorded.append(1)) is False      # once
    assert recorded == [1]
    assert studio(r3).scope_spent(step_label(sid, 1)) == pytest.approx(0.03)
    assert studio(r3).scope_spent(step_label(sid, 2)) == 0


def test_deadline_move_by_sweep_and_by_job_b(r3):
    session, sid, m, step = ready2(r3)
    res, key = reserve(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    h = handoff(r3, sid)
    tick(r3)
    assert res.get(key)["state"] == "dispatched" and handoff(r3, sid)["state"] == "settling"   # before the deadline
    r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h["id"]))
    tick(r3)                                                               # by the sweep
    assert res.get(key)["state"] == "unknown"
    studio(r3).worker.wait_idle(15)
    assert handoff(r3, sid)["state"] in ("awaiting_proof", "done")
    # by job B itself, the sweep not having run
    drive(r3)
    s2 = step_row(r3, sid, 2)
    in_step(r3, sid, s2)
    done(r3, sid, 2, s2["execution_id"], more=True)
    res2, key2 = reserve(r3)
    upload(r3, sid, m, 3, gen=3)
    studio(r3).worker.wait_idle(15)
    h2 = handoff(r3, sid)
    r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h2["id"]))
    studio(r3).job_b(h2["id"])                                             # B applies the due move first
    assert res2.get(key2)["state"] == "unknown" and handoff(r3, sid)["state"] == "awaiting_proof"


def test_hung_dispatched_unknowned_after_660s(r3):
    session, sid, m, step = ready2(r3)
    res, key = reserve(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    h = handoff(r3, sid)
    left = (datetime.datetime.fromisoformat(h["deadline"].replace("Z", "+00:00"))
            - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    assert 650 < left <= 660
    for _ in range(3):
        tick(r3)
    assert res.get(key)["state"] == "dispatched" and step_row(r3, sid, 2) is None
    r3.hive.db.execute("UPDATE studio_handoffs SET deadline = ? WHERE id = ?", (past(), h["id"]))
    drive(r3)
    assert res.get(key)["state"] == "unknown" and step_row(r3, sid, 2)["state"] == "admitted"


# ---- Stop (§5) -----------------------------------------------------------------------------------------------------------

def _into(x, where):
    """Bring a session to `where`; returns (sid, release-later callable or None)."""
    if where == "live":
        session, sid, m, ack, step = started(x)
        return sid, None
    session, sid, m, step = ready2(x)
    if where in ("held", "exhausted"):
        x.driver.fail[("stop", x.maker["id"])] = RuntimeError("stubborn")
        upload(x, sid, m, 2, gen=2)
        drive(x)
        del x.driver.fail[("stop", x.maker["id"])]
        if where == "exhausted":
            x.hive.db.execute("UPDATE studio_sessions SET state_reason = 'handoff_retry_exhausted' WHERE id = ?", (sid,))
        return sid, None
    if where == "settling":
        reserve(x)
        upload(x, sid, m, 2, gen=2)
        drive(x, rounds=1, connect_started=False)
        assert handoff(x, sid)["state"] == "settling"
        x.hive.db.execute("UPDATE cost_reservations SET state = 'settled', actual = 1 WHERE state = 'dispatched'")
        return sid, None
    if where == "awaiting_proof":
        upload(x, sid, m, 2, gen=2)
        drive(x, rounds=2, connect_started=False)
        assert handoff(x, sid)["state"] == "awaiting_proof"
        return sid, None
    if where == "mid-job-A":
        gate, entered = x.driver.park("stop", x.maker["id"])
        upload(x, sid, m, 2, gen=2)
        assert entered.wait(15)
        return sid, gate.set
    if where == "mid-job-B":
        gate, entered = x.driver.park("start", x.maker["id"])
        upload(x, sid, m, 2, gen=2)
        studio(x).worker.wait_idle(1)
        tick(x)
        assert entered.wait(15)
        return sid, gate.set
    raise AssertionError(where)


@pytest.mark.parametrize("where", ["live", "held", "exhausted", "settling", "awaiting_proof", "mid-job-A", "mid-job-B"])
def test_S_stop_in_each_state(r3, where):
    sid, let_go = _into(r3, where)
    rows_before = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    stop(r3, sid)
    row = ses_row(r3, sid)
    assert row["state"] == "stopping"                                      # admission refused at once
    agent = r3.hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))
    assert r3.hive.studio.gateway_fence(agent) is not None
    assert studio(r3).admit_from(handoff(r3, sid)["id"]) is None if handoff(r3, sid) else True
    if let_go:
        let_go()
    rotations = []
    stopped_and_released(r3, sid, rounds=8)
    after = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    assert after == rows_before                                            # no J6 charge: Stop opens no attempt
    assert step_row(r3, sid, 2) is None and rotations == []
    if where == "mid-job-B":                                               # B's start was authorised before Stop
        assert r3.driver.calls.count(("start", r3.maker["id"])) >= 2


def test_S_stop_then_checks_and_inbound_wake_refused_until_released_then_normal_wake(r3):
    session, sid, m, ack, step = started(r3)
    gate, entered = gate_pair()
    hook(("dirsync", r3.workspace.path(r3.maker["id"]).name, (gate, entered)))
    stop(r3, sid)
    assert entered.wait(15)                                                # released but not yet durable
    for _ in range(3):
        r3.sup.check()
    wake_refused(r3)
    gate.set()
    SH.HOOK = None
    stopped_and_released(r3, sid)
    starts = r3.driver.calls.count(("start", r3.maker["id"]))
    on_loop(r3, r3.hive.send_to_agent, r3.maker["id"], "hello again")       # an ordinary sleeping mind: it wakes
    assert r3.driver.calls.count(("start", r3.maker["id"])) == starts + 1


def test_S_resume_during_stopping_refused(r3):
    session, sid, m, ack, step = started(r3)
    gate, entered = gate_pair()
    hook(("dirsync", r3.maker["id"], (gate, entered)))                    # parked outside the mind lock
    stop(r3, sid)
    assert entered.wait(15)
    r = control(r3, sid, "retry_retirement")
    assert (r.status_code, err(r)["code"]) == (409, "not_held_for_retirement")
    r = r3.client.post(f"/api/agents/{r3.maker['id']}/start")
    assert (r.status_code, err(r)["code"]) == (409, "studio_owned")
    gate.set()
    SH.HOOK = None
    stopped_and_released(r3, sid)


def test_S_already_empty_settle_released_next_tick(r3):
    session, sid, m, ack, step = started(r3)
    stop(r3, sid)
    assert studio(r3).worker.wait_idle(15)
    assert released(r3, sid)                                              # the route's own job S finished it


def test_S_stop_failed_not_resubmitted_finish_stopping_retries_once_then_admin_message(r3):
    session, sid, m, ack, step = started(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("group still running after TERM/KILL")
    stop(r3, sid)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["stop_failed"]) == ("stopping", 1)
    stops = r3.driver.calls.count(("stop", r3.maker["id"]))
    drive(r3)
    assert r3.driver.calls.count(("stop", r3.maker["id"])) == stops        # never resubmitted
    ledger = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["stop"]
    assert ledger["message"].startswith("Studio's mind couldn't be stopped") and ledger["finish_stopping"] is True
    assert control(r3, sid, "finish_stopping").status_code == 200
    studio(r3).worker.wait_idle(15)
    assert r3.driver.calls.count(("stop", r3.maker["id"])) == stops + 1    # exactly once
    drive(r3)
    assert r3.driver.calls.count(("stop", r3.maker["id"])) == stops + 1
    assert "An administrator must stop the process" in r3.client.get(f"/api/studio-sessions/{sid}",
                                                                       headers=r3.mia).json()["stop"]["message"]
    del r3.driver.fail[("stop", r3.maker["id"])]
    adm = r3.client.post(f"/api/studio-sessions/{sid}/admin-controls", headers=r3.jg,
                         json={"control_id": "admin-fin-01", "action": "finish_stopping"})
    assert adm.status_code == 200, adm.text
    stopped_and_released(r3, sid)


def test_S_release_stale_visible_and_finish_stopping_completes(r3):
    session, sid, m, ack, step = started(r3)
    res, key = reserve(r3)
    stop(r3, sid)
    drive(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET stopping_deadline = ? WHERE id = ?", (past(), sid))
    tick(r3)
    row = ses_row(r3, sid)
    assert (row["state"], row["release_stale"]) == ("stopping", 1)
    assert r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["stop"]["message"] == \
        "Studio didn't finish stopping."
    res.settle(key, 0.01, lambda: None)
    assert control(r3, sid, "finish_stopping").status_code == 200
    assert ses_row(r3, sid)["release_stale"] in (0, 1)
    row = stopped_and_released(r3, sid)
    assert row["release_stale"] == 0


def test_S_pending_reuse_no_extra_epoch(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    k = epoch_of(r3)
    real = studio(r3)._rotate_to
    calls = []

    def crash_once(*args):
        calls.append(args)
        if len(calls) == 1:
            raise Crash("died after prepare, before install")
        return real(*args)
    monkeypatch.setattr(studio(r3), "_rotate_to", crash_once)
    stop(r3, sid)
    studio(r3).worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert (row["release_phase"], row["release_epoch"], epoch_of(r3)) == ("prepared", k + 1, k)
    digest = row["release_token_hash"]
    stopped_and_released(r3, sid)
    assert epoch_of(r3) == k + 1 and calls[1][2] == digest                 # the same pending credential, no extra epoch


def test_S_competing_continuations_both_orders_one_release(r3):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    k = epoch_of(r3)
    other = threading.Thread(target=studio(r3).job_s, args=(sid,))        # a second continuation: no owner, exits
    other.start()
    other.join(5)
    assert not other.is_alive()
    gate.set()
    stopped_and_released(r3, sid)
    studio(r3).job_s(sid)                                                  # after: inert
    assert epoch_of(r3) == k + 1


# ---- crash points (§7), each with an inbound wake refused while owned -------------------------------------------------------

ATTEMPT_POINTS = ["A-before-prepare", "A-after-stop-txn", "B-between-rotate-and-renames", "B-after-renames-before-dirsync",
                  "B-after-start", "B-after-install-auth-before-start-auth"]
STOP_POINTS = ["S-before-stop-verified", "S-after-verified-before-prepare", "S-after-prepare", "S-after-install-before-token-rename",
               "S-after-token-rename-before-pointer", "S-after-renames-before-dirsync", "S-after-fsync-before-final"]


def _crash_attempt(x, point):
    session, sid, m, step = ready2(x)
    root = x.workspace.path(x.maker["id"])
    if point == "A-before-prepare":
        hook(("write", "pending-token-e", Crash()))
    elif point == "B-between-rotate-and-renames":
        hook(("rename", "token-e", Crash()))
    elif point == "B-after-install-auth-before-start-auth":
        hook(("rename", "current", Crash()))
    elif point == "B-after-renames-before-dirsync":
        hook(("dirsync", root.name, Crash()))
    upload(x, sid, m, 2, gen=2)
    rounds = {"A-before-prepare": 1, "A-after-stop-txn": 0}.get(point, 2)
    studio(x).worker.wait_idle(15)
    if rounds:
        drive(x, rounds=rounds, connect_started=False)
    return sid, m


@pytest.mark.parametrize("point", ATTEMPT_POINTS)
def test_crash_point_attempt(r3, point):
    sid, m = _crash_attempt(r3, point)
    restart(r3)
    wake_refused(r3)
    h = handoff(r3, sid)
    assert (h["state"], h["reason"]) == ("held", "handoff_interrupted")
    assert ses_row(r3, sid)["state_reason"] == "handoff_interrupted"
    r = control(r3, sid, "retry_retirement")
    assert r.status_code == 200, r.text
    upload(r3, sid, m, 3, gen=3)
    drive(r3, rounds=6)
    s2 = step_row(r3, sid, 2)
    assert s2 is not None and s2["state"] == "admitted", (handoff(r3, sid), ses_row(r3, sid)["state_reason"])
    assert s2["token_epoch"] == epoch_of(r3) and credential_ok(r3)
    assert all(studio(r3).fenced(r3.maker["id"], e) for e in range(1, s2["token_epoch"]))


def _crash_stop(x, point, monkeypatch):
    session, sid, m, ack, step = started(x)
    root = x.workspace.path(x.maker["id"])
    if point == "S-before-stop-verified":
        x.driver.fail[("stop", x.maker["id"])] = Crash()
    elif point == "S-after-verified-before-prepare":
        hook(("write", "pending-token-e", Crash()))
    elif point == "S-after-prepare":
        real = studio(x)._rotate_to
        state = {"n": 0}

        def once(*args):
            state["n"] += 1
            if state["n"] == 1:
                raise Crash()
            return real(*args)
        monkeypatch.setattr(studio(x), "_rotate_to", once)
    elif point == "S-after-install-before-token-rename":
        hook(("rename", "token-e", Crash()))
    elif point == "S-after-token-rename-before-pointer":
        hook(("rename", "current", Crash()))
    elif point == "S-after-renames-before-dirsync":
        hook(("dirsync", root.name, Crash()))
    elif point == "S-after-fsync-before-final":
        hook(("final", root.name, Crash()))
    k = epoch_of(x)
    stop(x, sid)
    studio(x).worker.wait_idle(15)
    x.driver.fail.pop(("stop", x.maker["id"]), None)
    return sid, k


def _recover_stop(x, sid, k):
    restart(x)
    assert ses_row(x, sid)["state"] == "stopping"
    wake_refused(x)
    stopped_and_released(x, sid, rounds=6)
    assert epoch_of(x) == k + 1                                            # one release rotation in total


@pytest.mark.parametrize("point", STOP_POINTS)
def test_crash_point_stop(r3, point, monkeypatch):
    sid, k = _crash_stop(r3, point, monkeypatch)
    _recover_stop(r3, sid, k)


def test_S_one_release_rotation_across_crashes(r3, monkeypatch):
    """Every S row of §7 in one session's life is the parametrized test above; here, crash after crash in one release:
    prepare, then install, then the directory fsync, then the final commit. Still exactly one release rotation."""
    session, sid, m, ack, step = started(r3)
    root = r3.workspace.path(r3.maker["id"])
    k = epoch_of(r3)
    for rule in (("rename", "token-e", Crash()), ("rename", "current", Crash()), ("dirsync", root.name, Crash()),
                 ("final", root.name, Crash())):
        hook(rule)
        if ses_row(r3, sid)["state"] != "stopping":
            stop(r3, sid)
        else:
            tick(r3)
        studio(r3).worker.wait_idle(15)
        restart(r3)
        wake_refused(r3)
    stopped_and_released(r3, sid)
    assert epoch_of(r3) == k + 1


# ---- delivery (§6) -------------------------------------------------------------------------------------------------------

def _to_admission(x, monkeypatch):
    """Step 2 proven and admitted, its delivery captured (not run) so a test can act between admission and send."""
    session, sid, m, step = ready2(x)
    captured = []
    monkeypatch.setattr(studio(x), "_start_delivery", lambda *args: captured.append(args))
    upload(x, sid, m, 2, gen=2)
    drive(x)
    assert step_row(x, sid, 2)["state"] == "admitted" and len(captured) == 1
    studio(x).__dict__.pop("_start_delivery", None)
    _to_admission.mount = m
    return sid, captured[0]


def _deliver(x, args):
    on_loop(x, studio(x)._deliver, *args)


def test_D_reconnect_between_proof_and_send_uncertain(r3, monkeypatch):
    sid, args = _to_admission(r3, monkeypatch)
    connect(r3, r3.maker["id"])                                            # a new connection: a new nonce
    _deliver(r3, args)
    s2 = step_row(r3, sid, 2)
    assert (s2["state"], s2["delivery_outcome"]) == ("interrupted", "delivery_uncertain")
    assert (ses_row(r3, sid)["state"], ses_row(r3, sid)["state_reason"]) == ("held", "delivery_uncertain")
    assert not [f for f in r3.hubs[r3.maker["id"]].frames if f.get("type") == "studio_step"]


def test_D_disconnect_during_send_uncertain(r3, monkeypatch):
    sid, args = _to_admission(r3, monkeypatch)

    async def gone(text):
        raise ConnectionResetError("the socket was withdrawn")
    r3.hive.connections[r3.maker["id"]].send_text = gone
    _deliver(r3, args)
    assert step_row(r3, sid, 2)["delivery_outcome"] == "delivery_uncertain"


def test_D_socket_held_open_timeout_maker_unresponsive_no_retry_storm(r3, monkeypatch):
    sid, args = _to_admission(r3, monkeypatch)
    monkeypatch.setattr(SH, "DELIVERY_BUDGET_S", 0.5)
    sends = []

    async def wedged(text):
        sends.append(text)
        await asyncio.sleep(3600)
    r3.hive.connections[r3.maker["id"]].send_text = wedged
    _deliver(r3, args)
    assert step_row(r3, sid, 2)["delivery_outcome"] == "maker_unresponsive"
    assert ses_row(r3, sid)["state_reason"] == "maker_unresponsive"
    shown = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["handoff"]
    assert shown["message"] == "Studio's mind isn't responding." and shown["retries_left"] == 3   # first attempts never count
    rows = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    drive(r3)
    assert len(sends) == 1                                                 # never re-sent
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"] == rows


def test_D_admission_commit_failure_sends_nothing(r3, monkeypatch):
    session, sid, m, step = ready2(r3)
    real = studio(r3)._step_event

    def fail(session_id, n, phase):
        if phase == "admitted":
            raise RuntimeError("fault inside the admission transaction")
        return real(session_id, n, phase)
    monkeypatch.setattr(studio(r3), "_step_event", fail)
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert step_row(r3, sid, 2) is None and handoff(r3, sid)["state"] == "awaiting_proof"
    assert not [f for f in r3.hubs[r3.maker["id"]].frames if f.get("type") == "studio_step"]
    studio(r3).__dict__.pop("_step_event", None)
    drive(r3)
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_D_never_in_messages(r3):
    hive = r3.hive
    before = hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?", (r3.maker["id"],))["n"]
    session, sid, m, ack, step = started(r3)
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?", (r3.maker["id"],))["n"] == before
    hub = r3.hubs[r3.maker["id"]]
    count = len(hub.frames)
    on_loop(r3, hive.replay, r3.maker["id"], 0)                            # a reconnect's replay
    assert not [f for f in hub.frames[count:] if "studio" in json.dumps(f)]


@pytest.mark.parametrize("result", ["delivered", "delivery_uncertain"])
def test_D_old_callback_after_stop_release_changes_nothing(r3, monkeypatch, result):
    sid, args = _to_admission(r3, monkeypatch)
    _, n, _, delivery_id = args[0], args[1], args[2], args[3]
    stop(r3, sid)
    stopped_and_released(r3, sid)
    before = (dict(step_row(r3, sid, 2)), dict(ses_row(r3, sid)))
    studio(r3).delivery_outcome(sid, n, delivery_id, result)              # races Stop's commit and the release
    assert (dict(step_row(r3, sid, 2)), dict(ses_row(r3, sid))) == before
    on_loop(r3, r3.hive.send_to_agent, r3.maker["id"], "wake up")         # and a wake
    studio(r3).delivery_outcome(sid, n, delivery_id, result)
    assert dict(step_row(r3, sid, 2)) == before[0] and ses_row(r3, sid)["state"] == "stopped"


def test_D_old_callback_after_a_new_admission_changes_nothing(r3, monkeypatch):
    sid, args = _to_admission(r3, monkeypatch)
    _deliver(r3, args)
    s2 = step_row(r3, sid, 2)
    in_step(r3, sid, s2)
    done(r3, sid, 2, s2["execution_id"], more=True)
    upload(r3, sid, _to_admission.mount, 3, gen=3)
    drive(r3)
    s3 = dict(step_row(r3, sid, 3))
    studio(r3).delivery_outcome(sid, 2, args[3], "delivery_uncertain")    # step 2's old delivery callback, late
    assert dict(step_row(r3, sid, 3)) == s3 and step_row(r3, sid, 2)["state"] == "finished"
    assert ses_row(r3, sid)["state"] == "active"


def test_D_fast_outcome_survives_late_failure_both_orders(r3, monkeypatch):
    sid, args = _to_admission(r3, monkeypatch)
    _deliver(r3, args)                                                     # delivered
    studio(r3).delivery_outcome(sid, 2, args[3], "maker_unresponsive")    # a late failure for the same delivery
    assert step_row(r3, sid, 2)["state"] == "admitted" and ses_row(r3, sid)["state"] == "active"
    s2 = step_row(r3, sid, 2)
    in_step(r3, sid, s2)
    done(r3, sid, 2, s2["execution_id"], more=False)                       # the fast outcome: finished
    studio(r3).delivery_outcome(sid, 2, args[3], "delivery_uncertain")
    assert step_row(r3, sid, 2)["state"] == "finished" and ses_row(r3, sid)["state"] == "active"


def test_deliveries_entry_removed_on_outcome(r3):
    session, sid, m, ack, step = started(r3)
    assert studio(r3).deliveries == {} and step_row(r3, sid, 1)["delivered_at"] is not None


def test_K7_ordinary_messages_held_while_owned_mid_handoff_then_delivered_after_admission(r3):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    assert handoff(r3, sid)["state"] == "awaiting_proof"
    for aid, token in r3.driver.pending:
        hub = connect(r3, aid, token)
    r3.driver.pending.clear()
    on_loop(r3, r3.hive.send_to_agent, r3.maker["id"], "an ordinary note")
    assert not [f for f in hub.frames if f.get("type") == "user_message"]   # held back mid-handoff
    tick(r3)
    on_loop(r3, asyncio.sleep, 0.2)
    kinds = [f.get("type") for f in hub.frames]
    assert "studio_step" in kinds and "user_message" in kinds               # the step, then the held note


# ---- Stop races job B, job B failures, credential loss (r2.1) --------------------------------------------------------------

def test_stop_races_B_right_after_revalidation_no_rotation_no_start(r3, monkeypatch):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    k = epoch_of(r3)
    gate, entered = gate_pair()
    real = studio(r3)._verify
    monkeypatch.setattr(studio(r3), "_verify", lambda aid: (entered.set(), gate.wait(30), real(aid)))
    starts = r3.driver.calls.count(("start", r3.maker["id"]))
    tick(r3)                                                               # B: revalidated, now at verify
    assert entered.wait(15)
    stop(r3, sid)                                                          # Stop commits first
    gate.set()
    studio(r3).__dict__.pop("_verify", None)
    stopped_and_released(r3, sid)
    assert r3.driver.calls.count(("start", r3.maker["id"])) == starts      # never started
    assert epoch_of(r3) == k + 1                                           # only the release rotation


def test_stop_races_B_between_install_and_start_authorisation(r3, monkeypatch):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    k = epoch_of(r3)
    gate, entered = gate_pair()
    original_install = studio(r3)._install_files
    def installed_then_wait(*args):
        original_install(*args)
        # The namespace transaction must cover the actual renames. Park after it, at the boundary named by this test,
        # so Stop really commits before start authorization instead of merely timing out a stalled rename.
        assert not r3.hive.db._conn.in_transaction
        entered.set()
        assert gate.wait(15), "Stop did not reach the post-install boundary"
    monkeypatch.setattr(studio(r3), "_install_files", installed_then_wait)
    starts = r3.driver.calls.count(("start", r3.maker["id"]))
    tick(r3)
    assert entered.wait(15)                                                # installed (DB k+1), not yet start-authorised
    assert SH._read_epoch(r3.workspace.path(r3.maker["id"]) / "current") == k + 1
    stop(r3, sid)
    gate.set()
    SH.HOOK = None
    stopped_and_released(r3, sid)
    assert r3.driver.calls.count(("start", r3.maker["id"])) == starts      # no start
    assert studio(r3).fenced(r3.maker["id"], k + 1) and epoch_of(r3) == k + 2   # S fenced k+1, released to k+2


def test_stop_races_B_after_start_S_stops_fences_releases(r3):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    assert handoff(r3, sid)["state"] == "awaiting_proof" and r3.maker["id"] in r3.driver.procs
    k1 = epoch_of(r3)
    stop(r3, sid)
    stopped_and_released(r3, sid)
    assert r3.maker["id"] not in r3.driver.procs and studio(r3).fenced(r3.maker["id"], k1) and epoch_of(r3) == k1 + 1


@pytest.mark.parametrize("failure,reason", [("verify", "execution_retirement_failed"), ("rotate", "rotation_conflict"),
                                            ("rename", "credential_missing"), ("start", "restart_failed")])
def test_B_failures_hold_with_consistent_epochs(r3, monkeypatch, failure, reason):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(15)
    k = epoch_of(r3)
    if failure == "verify":
        r3.driver.procs[r3.maker["id"]] = "local:9999:9.5"                 # something is running again
    elif failure == "rotate":
        monkeypatch.setattr(studio(r3), "_rotate_to", lambda *a: False)
    elif failure == "rename":
        hook(("rename", "token-e", OSError("rename failed")))
    else:
        r3.driver.fail[("start", r3.maker["id"])] = RuntimeError("start refused")
    tick(r3)
    studio(r3).worker.wait_idle(15)
    h = handoff(r3, sid)
    assert (h["state"], h["reason"]) == ("held", reason)
    expected = k + 1 if failure in ("rename", "start") else k
    assert epoch_of(r3) == expected
    studio(r3).__dict__.pop("_rotate_to", None)
    SH.HOOK = None
    r3.driver.fail.clear()
    r3.driver.procs.pop(r3.maker["id"], None)
    assert control(r3, sid, "retry_retirement").status_code == 200
    studio(r3).worker.wait_idle(15)
    assert handoff(r3, sid)["from_epoch"] == epoch_of(r3) == expected       # the next attempt is from the DB epoch
    upload(r3, sid, m, 3, gen=3)
    drive(r3, rounds=6)
    assert step_row(r3, sid, 2)["state"] == "admitted" and credential_ok(r3)


def _lose(x, what):
    root = x.workspace.path(x.maker["id"])
    k = epoch_of(x)
    if what == "current-missing":
        (root / f"token-e{k}").unlink()
    elif what == "current-corrupt":
        (root / f"token-e{k}").write_text("corrupted")


@pytest.mark.parametrize("what", ["current-missing", "current-corrupt", "pending-corrupt"])
def test_credential_loss_continues_to_a_successful_retry(r3, what):
    session, sid, m, step = ready2(r3)
    if what != "pending-corrupt":
        _lose(r3, what)
        upload(r3, sid, m, 2, gen=2)
    else:
        upload(r3, sid, m, 2, gen=2)
        studio(r3).worker.wait_idle(15)
        k = epoch_of(r3)
        (r3.workspace.path(r3.maker["id"]) / f"pending-token-e{k + 1}").write_text("corrupted")
    drive(r3, rounds=6)
    assert step_row(r3, sid, 2)["state"] == "admitted" and credential_ok(r3)


@pytest.mark.parametrize("what", ["current-missing", "current-corrupt", "pending-corrupt"])
def test_credential_loss_continues_to_a_successful_stop_release(r3, what, monkeypatch):
    session, sid, m, ack, step = started(r3)
    if what == "pending-corrupt":
        real = studio(r3)._rotate_to
        state = {"n": 0}

        def once(*args):
            state["n"] += 1
            if state["n"] == 1:
                raise Crash()
            return real(*args)
        monkeypatch.setattr(studio(r3), "_rotate_to", once)
        stop(r3, sid)
        studio(r3).worker.wait_idle(15)
        k = epoch_of(r3)
        (r3.workspace.path(r3.maker["id"]) / f"pending-token-e{k + 1}").write_text("corrupted")
        restart(r3)
    else:
        _lose(r3, what)
        stop(r3, sid)
    stopped_and_released(r3, sid)


def test_cleanup_is_a_worker_job_never_the_sweep(r3):
    session, sid, m, step = ready2(r3)
    loop_ops = []
    main = threading.main_thread()

    def watch(kind, path):
        if not threading.current_thread().name.startswith("studio-"):
            loop_ops.append((kind, path.name, threading.current_thread().name))
    SH.HOOK = watch
    st = studio(r3)
    k = epoch_of(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    st.worker.pause()
    drive_rounds = 0
    while step_row(r3, sid, 2) is None and drive_rounds < 4:
        for aid, token in r3.driver.pending:
            connect(r3, aid, token)
        r3.driver.pending.clear()
        tick(r3)
        drive_rounds += 1
    assert step_row(r3, sid, 2) is not None
    assert f"token-e{k}" in files(r3)                                      # admitted, queued, nothing deleted yet
    assert r3.hive.db.one("SELECT keep_epoch FROM studio_cleanups WHERE maker_id = ?", (r3.maker["id"],))["keep_epoch"] == k + 1
    st.worker.resume()
    tick(r3)
    st.worker.wait_idle(15)
    assert f"token-e{k}" not in files(r3) and ("cleanup", "cleanup", r3.maker["id"]) in st.worker.history
    assert loop_ops == [] and main is not None


# ---- r2.2 ----------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("phase", ["durable", "installed"])
def test_S_durable_credential_loss_resets_phase_and_releases_once_more(r3, phase):
    session, sid, m, ack, step = started(r3)
    root = r3.workspace.path(r3.maker["id"])
    k = epoch_of(r3)
    hook(("final", root.name, Crash())) if phase == "durable" else hook(("dirsync", root.name, Crash()))
    stop(r3, sid)
    studio(r3).worker.wait_idle(15)
    assert ses_row(r3, sid)["release_phase"] == phase and epoch_of(r3) == k + 1
    (root / f"token-e{k + 1}").unlink()                                   # the installed credential is lost
    (root / f"pending-token-e{k + 1}").unlink(missing_ok=True)
    restart(r3)
    wake_refused(r3)
    stopped_and_released(r3, sid)
    assert epoch_of(r3) == k + 2 and ses_row(r3, sid)["credential_reason"] == "credential_missing"


def test_S_durable_credential_loss_then_crash_during_the_replacement(r3):
    session, sid, m, ack, step = started(r3)
    root = r3.workspace.path(r3.maker["id"])
    k = epoch_of(r3)
    hook(("final", root.name, Crash()))
    stop(r3, sid)
    studio(r3).worker.wait_idle(15)
    (root / f"token-e{k + 1}").unlink()
    restart(r3)
    hook(("rename", "current", Crash()))                                   # the replacement crashes after its install
    tick(r3)
    studio(r3).worker.wait_idle(15)
    restart(r3)
    wake_refused(r3)
    stopped_and_released(r3, sid)
    assert epoch_of(r3) == k + 2


def test_S_deadline_never_clears_stop_failed_and_never_resubmits(r3):
    session, sid, m, ack, step = started(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stuck group")
    stop(r3, sid)
    drive(r3)
    stops = r3.driver.calls.count(("stop", r3.maker["id"]))
    r3.hive.db.execute("UPDATE studio_sessions SET stopping_deadline = ? WHERE id = ?", (past(), sid))
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["stop_failed"], row["release_stale"]) == (1, 1)
    assert r3.driver.calls.count(("stop", r3.maker["id"])) == stops


def test_S_second_verify_failure_sets_stop_failed_no_install(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    k = epoch_of(r3)
    real = studio(r3)._verify
    n = {"calls": 0}

    def second_fails(aid):
        n["calls"] += 1
        if n["calls"] == 2:
            raise RuntimeError("running again")
        return real(aid)
    monkeypatch.setattr(studio(r3), "_verify", second_fails)
    stop(r3, sid)
    studio(r3).worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert (row["stop_failed"], row["stop_verified"], epoch_of(r3)) == (1, 0, k)
    studio(r3).__dict__.pop("_verify", None)
    assert control(r3, sid, "finish_stopping").status_code == 200        # re-runs the full verified stop
    stopped_and_released(r3, sid)


def test_S_db_epoch_mismatch_in_revalidation(r3):
    session, sid, m, ack, step = started(r3)
    k = epoch_of(r3)
    fired = []

    def rotate_under(kind, path):
        if kind == "fsync" and path.name == "current.tmp" and not fired:
            fired.append(1)
            r3.hive.rotate_token(r3.maker["id"], k, "rotated-by-someone-else")
    SH.HOOK = rotate_under
    stop(r3, sid)
    studio(r3).worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert row["state"] == "stopping" and row["release_phase"] == "none" and row["credential_reason"] == "credential_missing"
    SH.HOOK = None
    stopped_and_released(r3, sid)
    assert epoch_of(r3) == k + 2


def test_B_admission_while_dir_fsync_parked_then_crash(r3):
    session, sid, m, step = ready2(r3)
    root = r3.workspace.path(r3.maker["id"])
    gate, entered = gate_pair()
    hook(("dirsync", root.name, (gate, entered)))
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(5)
    tick(r3)
    assert entered.wait(15)                                                # B parked after awaiting_proof
    for aid, token in r3.driver.pending:
        connect(r3, aid, token)
    r3.driver.pending.clear()
    tick(r3)
    s2 = step_row(r3, sid, 2)
    assert s2["state"] == "admitted"                                       # admitted while the fsync is parked
    old_worker = studio(r3).worker
    st = studio(r3)
    with r3.hive.db.transaction() as tx:                                   # the crash: restart
        StudioSteps.recover_startup(tx)
    st.boot, st._owners, st.worker = secrets.token_hex(8), {}, SH.StudioWorker()
    r3.hive.connections.clear()
    r3.hive.db.execute("DELETE FROM studio_hub_registrations")
    assert step_row(r3, sid, 2)["state"] == "interrupted" and st.fenced(r3.maker["id"], s2["token_epoch"])
    gate.set()
    SH.HOOK = None
    old_worker.wait_idle(15)
    assert ses_row(r3, sid)["state"] == "active"                          # its row was done; nothing retries by itself
    _direction(r3, sid, 1, "try again")                                    # SIMULATED DIRECTION: new work
    upload(r3, sid, m, 3, gen=3)
    drive(r3, rounds=6)
    assert step_row(r3, sid, 3) is not None, (handoff(r3, sid), dict(ses_row(r3, sid)))
    assert step_row(r3, sid, 3)["state"] == "admitted" and credential_ok(r3)


# ---- r2.3 / r2.4: restart gates (decision lines only), flock, flags, Mac activation ---------------------------------------

SAFE_RESTART = pathlib.Path(os.environ.get("HIVE_SAFE_RESTART_PATH")
                            or pathlib.Path.home() / "OmegaDot" / "hive-local" / "safe-restart.sh")
CLOUD_DEPLOY = SAFE_RESTART.parent / "cloud-deploy.sh"


def _db_copy(x, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    main = next(r[2] for r in x.hive.db._conn.execute("PRAGMA database_list").fetchall() if r[1] == "main")
    src = sqlite3.connect(main)
    out = sqlite3.connect(str(dest))
    src.backup(out)
    out.execute("PRAGMA journal_mode=DELETE")                              # a plain file the read-only gate can open
    src.close()
    out.close()


def mac_gate(x, tmp_path):
    """The Mac safe-restart.sh decision: every line of the adopted script before its `launchctl kickstart` (the restart
    itself is never run), against a copy of this hive's database; the bounded-runner query is stubbed to 'none' and curl
    can only fail (TRY_SLEEP_ONCE is unset, so no sleep request is ever sent)."""
    if not SAFE_RESTART.exists():
        pytest.skip("hive-local/safe-restart.sh is not on this machine")
    lines = SAFE_RESTART.read_text().splitlines()
    end = next(i for i, line in enumerate(lines) if line.lstrip().startswith("launchctl"))
    db = tmp_path / "gate" / "hive.db"
    _db_copy(x, db)
    body = [f'DB="{db}"' if line.startswith("DB=") else line for line in lines[1:end]]
    assert not any("launchctl" in line for line in body)
    script = tmp_path / "gate" / "mac-gate.sh"
    script.write_text("#!/bin/sh\npgrep() { return 1; }\ncurl() { echo 000; return 7; }\n" + "\n".join(body)
                      + "\necho GATE_PASSED\n")
    residents = ",".join(r["id"] for r in x.hive.db.all("SELECT id FROM agents WHERE id != ?", (x.maker["id"],)))
    env = {k: v for k, v in os.environ.items() if k != "TRY_SLEEP_ONCE"}
    env["HIVE_RESIDENT_MINDS"] = residents
    done_ = subprocess.run(["/bin/sh", str(script)], capture_output=True, text=True, env=env, timeout=30)
    return done_.returncode, done_.stdout


def cloud_gate(x, tmp_path, allow):
    """cloud-deploy.sh's gate() function lines (simulated: the local test DB copy, pgrep stubbed)."""
    if not CLOUD_DEPLOY.exists():
        pytest.skip("hive-local/cloud-deploy.sh is not on this machine")
    text = CLOUD_DEPLOY.read_text().splitlines()
    start = next(i for i, line in enumerate(text) if line.startswith("DB=/var/lib/omegahive"))
    gate_at = next(i for i, line in enumerate(text) if line.startswith("gate() {"))
    end = next(i for i in range(gate_at, len(text)) if text[i] == "}")
    db = tmp_path / "cloud" / "hive.db"
    _db_copy(x, db)
    x_db = sqlite3.connect(str(db))
    x_db.execute("UPDATE agents SET status = 'asleep', desired = 'asleep' WHERE id != ?", (x.maker["id"],))
    x_db.commit()
    x_db.close()
    body = [f'DB="{db}"'] + text[start + 1:end + 1]
    script = tmp_path / "cloud" / "gate.sh"
    script.write_text("#!/bin/bash\npgrep() { return 1; }\n" + "\n".join(body) + '\ngate test && echo GATE_PASSED\n')
    sha = "a" * 40
    env = {**os.environ, "SHA": sha, "ALLOW_AWAKE": sha if allow else "0"}
    out = subprocess.run(["/bin/bash", str(script)], capture_output=True, text=True, env=env, timeout=30)
    return "GATE_PASSED" in out.stdout


def test_S_stuck_before_asleep_commit_safe_restart_refuses_then_os_stop_unblocks(r3, tmp_path):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)                                                # S stuck before its asleep commit
    rc, out = mac_gate(r3, tmp_path)
    assert rc == 3 and "NOT restarting" in out and r3.maker["id"] in out, (rc, out, r3.hive.db.one(
        "SELECT status, desired FROM agents WHERE id = ?", (r3.maker["id"],)))   # the awake maker blocks the restart
    gate.set()                                                             # an OS-level group stop unblocks the stop
    stopped_and_released(r3, sid)
    rc, out = mac_gate(r3, tmp_path)
    assert rc == 0 and "GATE_PASSED" in out


def test_S_stuck_restart_with_exact_sha_override_on_cloud_gate(r3, tmp_path):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    assert cloud_gate(r3, tmp_path, allow=False) is False                  # awake maker: refused without Jon's OK
    assert cloud_gate(r3, tmp_path, allow=True) is True                    # ALLOW_AWAKE=<that exact SHA>: passes
    gate.set()
    stopped_and_released(r3, sid)


def test_S_os_stop_succeeds_S_still_parked_all_others_asleep_mac_gate_refuses(r3, tmp_path):
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    r3.driver.procs.pop(r3.maker["id"], None)                              # the OS stop succeeded; S is still parked
    r3.hive.db.execute("UPDATE agents SET status = 'asleep' WHERE id != ?", (r3.maker["id"],))
    rc, out = mac_gate(r3, tmp_path)
    assert rc == 3 and r3.maker["id"] in out                               # why the activation prerequisite exists
    gate.set()
    stopped_and_released(r3, sid)


def test_F4_mac_self_check_refuses_studio_without_override_hash(r3, monkeypatch, tmp_path):
    import hashlib
    from hive.core import studio_sessions as SS
    st = studio(r3)
    item = "mac safe-restart exact-commit override"
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    script = tmp_path / "safe-restart.sh"
    script.write_text("#!/bin/sh\n# reviewed exact-commit override\n")
    monkeypatch.setenv("HIVE_SAFE_RESTART_PATH", str(script))
    monkeypatch.setattr(SS, "host_platform", lambda: "darwin")
    assert item in st.self_check()[1]
    monkeypatch.setattr(SS, "MAC_SAFE_RESTART_OVERRIDE_HASHES", (hashlib.sha256(script.read_bytes()).hexdigest(),))
    assert item not in st.self_check()[1]
    monkeypatch.setattr(SS, "MAC_SAFE_RESTART_OVERRIDE_HASHES", ())
    monkeypatch.setattr(SS, "host_platform", lambda: "linux")              # the cloud already has ALLOW_AWAKE=<SHA>
    assert item not in st.self_check()[1]


def test_S_settle_deadline_separate_from_stopping_deadline(r3):
    from hive.core.studio_sessions import step_label
    session, sid, m, ack, step = started(r3)
    res, key = reserve(r3, label=step_label(sid, 1))
    stop(r3, sid)
    drive(r3)
    row = ses_row(r3, sid)
    left = lambda t: (datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))  # noqa: E731
                      - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    assert 650 < left(row["settle_deadline"]) <= 660 and 770 < left(row["stopping_deadline"]) <= 780
    r3.hive.db.execute("UPDATE studio_sessions SET stopping_deadline = ? WHERE id = ?", (past(), sid))
    drive(r3)
    assert res.get(key)["state"] == "dispatched" and ses_row(r3, sid)["release_stale"] == 1   # no move on the 780 s one
    r3.hive.db.execute("UPDATE studio_sessions SET settle_deadline = ? WHERE id = ?", (past(), sid))
    drive(r3)
    assert res.get(key)["state"] == "unknown"
    stopped_and_released(r3, sid)
    assert res.settle(key, 0.02, lambda: None) is True                     # late, on step 1's own labels
    assert studio(r3).scope_spent(step_label(sid, 1)) == pytest.approx(0.02)


def test_restart_new_process_waits_for_flock_then_boot_fences_before_reconcile(r3, tmp_path):
    from hive.core import exclusive
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=2, connect_started=False)
    assert handoff(r3, sid)["state"] == "awaiting_proof"
    data = r3.hive.settings.data_dir
    ready = tmp_path / "locked"
    holder_src = ("import sys, time, pathlib\nfrom hive.core import exclusive\n"
                  f"exclusive.acquire({str(data)!r})\npathlib.Path({str(ready)!r}).write_text('1')\ntime.sleep(60)\n")
    old = subprocess.Popen([sys.executable, "-c", holder_src], cwd=str(pathlib.Path(__file__).resolve().parents[2]))
    try:
        assert wait_for(ready.exists, 20)
        with pytest.raises(exclusive.InUse):
            exclusive.acquire(data, exclusive.Held())                      # not while the old process lives
    finally:
        old.kill()
        old.wait(10)
    holder = exclusive.acquire(data, exclusive.Held())
    try:
        counts = exclusive.startup_recovery(holder, r3.hive)               # before any request or reconcile
    finally:
        import fcntl
        fcntl.flock(holder.fd, fcntl.LOCK_UN)
        os.close(holder.fd)
    assert counts["studio"] >= 1
    h = handoff(r3, sid)
    assert (h["state"], h["reason"]) == ("held", "handoff_interrupted")


def test_flags_both_set_neither_cleared_by_repair_or_reason(r3):
    session, sid, m, ack, step = started(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stuck")
    stop(r3, sid)
    drive(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET release_stale = 1 WHERE id = ?", (sid,))
    st = studio(r3)
    st._repair(r3.maker["id"], sid)
    st._phase_reset(sid)
    st.job_s(sid)
    drive(r3)
    row = ses_row(r3, sid)
    assert (row["stop_failed"], row["release_stale"]) == (1, 1)
    del r3.driver.fail[("stop", r3.maker["id"])]
    assert control(r3, sid, "finish_stopping").status_code == 200
    row = stopped_and_released(r3, sid)
    assert (row["stop_failed"], row["release_stale"]) == (0, 0)


# ---- retries and boot (J6) -----------------------------------------------------------------------------------------------

def test_J6_only_retries_count(r3):
    """Spec r2.5 §4 (Platform ruling 2026-10-18): the first handoff of each new step never counts; retries do, 3 per
    rolling hour per session."""
    session, sid, m, ack, step = started(r3)
    for n in range(1, 5):                                                  # four successful steps in the hour
        s_n = step_row(r3, sid, n)
        in_step(r3, sid, s_n)
        done(r3, sid, n, s_n["execution_id"], more=True)
        upload(r3, sid, m, n + 1, gen=n + 1)
        drive(r3)
        assert step_row(r3, sid, n + 1)["state"] == "admitted", ses_row(r3, sid)["state_reason"]
    assert studio(r3).retries_this_hour(sid) == 0 and ses_row(r3, sid)["state"] == "active"
    s5 = step_row(r3, sid, 5)
    in_step(r3, sid, s5)
    done(r3, sid, 5, s5["execution_id"], more=True)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stubborn")
    upload(r3, sid, m, 6, gen=6)
    drive(r3)                                                              # step 6, first attempt: held, not counted
    for retry in range(1, 4):
        assert control(r3, sid, "retry_retirement").status_code == 200   # retries 1..3
        drive(r3)
        assert studio(r3).retries_this_hour(sid) == retry
    r = control(r3, sid, "retry_retirement")                               # a fourth retry in the hour: refused
    assert r.json()["attempt_opened"] is False and r.json()["state_reason"] == "handoff_retry_exhausted"
    shown = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).json()["handoff"]
    assert (shown["retries_this_hour"], shown["retries_left"]) == (3, 0)


def test_J6_no_reopen_after_held(r3):
    session, sid, m, step = ready2(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stubborn")
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    del r3.driver.fail[("stop", r3.maker["id"])]
    rows = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    r3.hive.db.execute("UPDATE studio_sessions SET state = 'active', state_reason = NULL WHERE id = ?", (sid,))
    drive(r3, rounds=4)                                                    # live again, work queued: still no reopen
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"] == rows


def test_J6_override_one_attempt(r3):
    session, sid, m, step = ready2(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stubborn")
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    for _ in range(3):
        control(r3, sid, "retry_retirement")
        drive(r3)
    del r3.driver.fail[("stop", r3.maker["id"])]
    assert control(r3, sid, "retry_retirement").json()["state_reason"] == "handoff_retry_exhausted"
    rows = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    r = control(r3, sid, "retry_retirement", override=True)
    assert r.status_code == 200 and r.json()["override"] is True and "attempt_opened" not in r.json()
    drive(r3)
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"] == rows + 1
    assert step_row(r3, sid, 2)["state"] == "admitted"


def test_done_more_can_open_the_next_handoff_before_a_manual_crash_seed(r3):
    session, sid, m, step = ready2(r3)
    # Force the already scheduled work to run. This is the ordinary product behavior on the live base too;
    # a boot-recovery test must isolate its synthetic row insertion from this valid admission.
    on_loop(r3, studio(r3).advance, sid)
    row = studio(r3)._latest_handoff(sid)
    assert row["step_n"] == 2 and row["owner_boot"] == studio(r3).boot


def test_boot_interrupted_and_dead_worker_stale(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    # This test seeds its own interrupted handoffs. done(more=True) normally queues advance(), which may correctly
    # open step2 before the test inserts its synthetic row. Capture that one scheduled call while seeding the crash;
    # tick() and the real recovery logic below remain intact. No product ordering/transaction behavior is changed.
    async def defer_advance(session_id):
        assert session_id == sid
    with monkeypatch.context() as setup:
        setup.setattr(studio(r3), "advance", defer_advance)
        done(r3, sid, 1, step["execution_id"], more=True)
    st, db = studio(r3), r3.hive.db
    k = epoch_of(r3)
    row = {"maker_id": r3.maker["id"], "session_id": sid, "step_n": 2, "attempt": 1, "from_epoch": k, "to_epoch": k + 1,
           "token_hash": None, "state": "in_progress", "window_s": 60, "created_at": SH.now()}
    db.insert("studio_handoffs", {**row, "id": "ho_oldboot0001", "owner_boot": "another-boot", "updated_at": SH.now()})
    tick(r3)
    h = st._handoff("ho_oldboot0001")
    assert (h["state"], h["reason"]) == ("held", "handoff_interrupted")
    db.execute("UPDATE studio_sessions SET state = 'active', state_reason = NULL WHERE id = ?", (sid,))
    db.insert("studio_handoffs", {**row, "id": "ho_deadjob0001", "owner_boot": st.boot, "updated_at": past(200)})
    tick(r3)
    h = st._handoff("ho_deadjob0001")
    assert (h["state"], h["reason"]) == ("held", "handoff_stale")


# ---- H2 adopted processes ------------------------------------------------------------------------------------------------

def test_H2a_restart_with_an_adopted_running_maker_and_an_admitted_step(r3):
    session, sid, m, ack, step = started(r3)
    r3.driver.procs[r3.maker["id"]] = f"local:{4242}:adopted"              # after the restart it is an adopted group
    restart(r3)
    assert step_row(r3, sid, 1)["state"] == "interrupted" and studio(r3).fenced(r3.maker["id"], step["token_epoch"])
    _direction(r3, sid, 1, "carry on")                                     # SIMULATED DIRECTION: new work
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=6)
    s2 = step_row(r3, sid, 2)
    assert s2 is not None, (handoff(r3, sid), ses_row(r3, sid)["state"], ses_row(r3, sid)["state_reason"])
    assert s2["state"] == "admitted" and not s2["maker_execution"].endswith(":adopted")


def test_H2b_an_adopted_identity_after_the_start_is_no_proof(r3, monkeypatch):
    session, sid, m, step = ready2(r3)
    monkeypatch.setattr(SH, "PROOF_WINDOW_S", 0)
    real_start = r3.driver.start

    def adopted_start(agent, env):
        real_start(agent, env)
        r3.driver.procs[agent["id"]] = "local:777:adopted"
    monkeypatch.setattr(r3.driver, "start", adopted_start)
    upload(r3, sid, m, 2, gen=2)
    drive(r3, rounds=6)
    assert step_row(r3, sid, 2) is None and ses_row(r3, sid)["state_reason"] == "boundary_unobserved"


def test_H2c_an_adopted_group_that_cannot_be_stopped_holds_with_nothing_installed(r3):
    session, sid, m, step = ready2(r3)
    r3.driver.procs[r3.maker["id"]] = "local:888:adopted"
    r3.driver.survive.add(r3.maker["id"])
    k = epoch_of(r3)
    upload(r3, sid, m, 2, gen=2)
    drive(r3)
    assert ses_row(r3, sid)["state_reason"] == "execution_retirement_failed" and epoch_of(r3) == k
    assert f"token-e{k + 1}" not in files(r3)


# ---- r3.1: fixes against the R3 verdicts (stand-in FIX-FIRST #1-#2; Kimi #1, #2, #4, #5) ---------------------------------

def test_r31_studio_off_inbox_and_an_ordinary_minds_source_revision_unchanged(r3, monkeypatch):
    """Stand-in #1: a persisted active consent-v2 session with Studio OFF restricts nothing ordinary."""
    hive, c = r3.hive, r3.client
    src = hive.collab.create_artifact({"id": r3.maker["id"], "swarm_id": r3.home["id"]}, {"kind": "studio-source", "title": "P"},
                                      principal="user:u_mia")
    session = open_session(r3, piece={"scene_id": "scene-1", "source_ref": {"artifact_id": src["id"]}})
    other = c.post("/api/agents", json={"name": "Other", "swarm_id": r3.home["id"], "model": MODEL}).json()
    row = ses_row(r3, session["session_id"])
    assert (row["state"], row["consent_payload_version"]) == ("active", 2)
    monkeypatch.setattr(studio(r3), "enabled", False)
    assert "messages" in hive.inbox(r3.maker["id"])                       # the function MCP's inbox tool calls
    r = c.get("/api/agent/inbox", headers=maker_headers(r3))               # and the REST route
    assert r.status_code == 200, r.text
    r = c.post(f"/api/agent/artifacts/{src['id']}/revisions", headers={"Authorization": f"Bearer {other['token']}"},
               json={"body": "x", "parent": None})
    assert r.status_code == 200, r.text                                    # no session_piece_person_only


def test_r31_studio_off_stop_and_finish_stopping_change_nothing(r3, monkeypatch):
    """Stand-in #2: with Studio OFF neither Stop nor Finish stopping changes state or dispatches job S."""
    session, sid, m, ack, step = started(r3)
    st = studio(r3)
    monkeypatch.setattr(st, "enabled", False)
    before = dict(ses_row(r3, sid))
    history = len(st.worker.history)
    r = control(r3, sid, "stop")
    assert r.status_code == 404
    a = r3.client.post(f"/api/studio-sessions/{sid}/admin-controls", headers=r3.jg,
                       json={"control_id": "admin-stop-off", "action": "stop"})
    assert a.status_code == 404
    assert dict(ses_row(r3, sid)) == before and len(st.worker.history) == history
    # a session already stopping when Studio was switched off: Finish stopping changes nothing either
    monkeypatch.setattr(st, "enabled", True)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    gate.set()
    st.worker.wait_idle(15)
    r3.hive.db.execute("UPDATE studio_sessions SET state = 'stopping', stop_failed = 1, release_stale = 1 WHERE id = ?", (sid,))
    monkeypatch.setattr(st, "enabled", False)
    before = dict(ses_row(r3, sid))
    history = len(st.worker.history)
    assert control(r3, sid, "finish_stopping").status_code == 404
    assert r3.client.post(f"/api/studio-sessions/{sid}/admin-controls", headers=r3.jg,
                          json={"control_id": "admin-fin-off", "action": "finish_stopping"}).status_code == 404
    assert control(r3, sid, "retry_retirement").status_code == 404
    on_loop(r3, st.tick)
    assert dict(ses_row(r3, sid)) == before and len(st.worker.history) == history


def test_r31_delivery_failure_hold_reopens_only_on_explicit_retry_with_work_queued(r3, monkeypatch):
    """Kimi #1: a session held by a failed delivery (not by Stop), with work queued, never reopens by itself; an explicit
    retry_retirement opens exactly one attempt and the queued direction reaches the next step."""
    sid, args = _to_admission(r3, monkeypatch)
    connect(r3, r3.maker["id"])                                            # the delivery's nonce is stale: uncertain
    _deliver(r3, args)
    assert (ses_row(r3, sid)["state"], ses_row(r3, sid)["state_reason"]) == ("held", "delivery_uncertain")
    _direction(r3, sid, 1, "warmer")                                       # SIMULATED DIRECTION: work queued
    rows = r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"]
    drive(r3, rounds=4)
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM studio_handoffs WHERE session_id = ?", (sid,))["n"] == rows
    r = control(r3, sid, "retry_retirement")
    assert r.status_code == 200 and "attempt_opened" not in r.json(), r.text
    upload(r3, sid, _to_admission.mount, 3, gen=3)
    drive(r3)
    s3 = step_row(r3, sid, 3)
    assert s3["state"] == "admitted" and json.loads(s3["direction_seqs"]) == [1]


def test_r31_stops_held_row_never_blocks_a_later_session_of_the_same_maker(r3):
    """Kimi #1 / r2.5 §4: Stop's own `held stopped` latest row blocks no later explicitly admitted session or attempt,
    and holds back no ordinary message once a new session's handoff completes."""
    from hive.tests.test_ask_intents import turn
    from hive.tests.test_studio_session_g1 import record
    session, sid, m, step = ready2(r3)
    gate, entered = r3.driver.park("start", r3.maker["id"])
    upload(r3, sid, m, 2, gen=2)
    studio(r3).worker.wait_idle(1)
    tick(r3)
    assert entered.wait(15)
    stop(r3, sid)                                                          # closes the open row `held stopped`
    gate.set()
    stopped_and_released(r3, sid)
    assert (handoff(r3, sid)["state"], handoff(r3, sid)["reason"]) == ("held", "stopped")
    r3.hive.db.execute("UPDATE ask_turns SET state = 'answered' WHERE operation_id = 'op-mia-turn-01'")
    turn(r3, op="op-mia-turn-02", who=r3.mia, text="another")
    r = record(r3, op="op-mia-turn-02")
    assert r.status_code in (200, 201), r.text
    from hive.tests.test_studio_session_g1 import submit
    second = submit(r3, r.json()["intent_id"])
    assert second.status_code == 201, second.text
    sid2 = second.json()["session_id"]
    assert studio(r3).studio_owns(r3.maker["id"])
    assert not studio(r3).holds_messages(r3.maker["id"])                 # the old `held stopped` row holds nothing back
    m2 = mount(r3, sid2, second.json()["stream_id"]).json()
    upload(r3, sid2, m2, 1)
    drive(r3, rounds=6)
    assert step_row(r3, sid2, 1)["state"] == "admitted"
    assert not studio(r3).holds_messages(r3.maker["id"])


def test_r31_delivery_succeeds_after_a_briefly_busy_lock(r3, monkeypatch):
    """Kimi #2: the lock is busy for ~0.5 s (a worker mid-stop), then free: the delivery polls, then sends."""
    sid, args = _to_admission(r3, monkeypatch)
    hold, holding = threading.Event(), threading.Event()

    def holder():
        with r3.sup.lock(r3.maker["id"]):
            holding.set()
            time.sleep(0.5)
    t = threading.Thread(target=holder)
    t.start()
    assert holding.wait(5)
    _deliver(r3, args)
    t.join(5)
    s2 = step_row(r3, sid, 2)
    assert (s2["state"], s2["delivery_outcome"]) == ("admitted", "delivered") and s2["delivered_at"] is not None
    assert [f for f in r3.hubs[r3.maker["id"]].frames if f.get("type") == "studio_step" and f["step"] == 2]


def test_r31_finish_stopping_does_not_churn_an_outstanding_job(r3):
    """Kimi #4: Finish stopping against a maker whose job is still outstanding submits nothing new."""
    session, sid, m, ack, step = started(r3)
    gate, entered = r3.driver.park("stop", r3.maker["id"])
    stop(r3, sid)
    assert entered.wait(15)
    st = studio(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET release_stale = 1 WHERE id = ?", (sid,))
    history = len(st.worker.history)
    keep = ("stopping_deadline", "finish_count", "release_stale", "stop_failed")
    before = {k: ses_row(r3, sid)[k] for k in keep}
    for i in range(3):
        assert control(r3, sid, "finish_stopping", cid=f"finish-churn-{i}").status_code == 200
    assert len(st.worker.history) == history and st.worker.outstanding(r3.maker["id"])
    assert {k: ses_row(r3, sid)[k] for k in keep} == before          # Kimi R3.1 #2: no flag, deadline or count churn
    gate.set()
    stopped_and_released(r3, sid)


def test_r31_stop_status_shows_the_driver_status_word_never_exception_text(r3):
    """Kimi #5: the raw exception stays in the log; the person sees the driver's status word."""
    session, sid, m, ack, step = started(r3)
    r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("group 4242 survived KILL; env HIVE_TOKEN=/secret/path")
    stop(r3, sid)
    drive(r3)
    row = ses_row(r3, sid)
    assert row["stop_failed"] == 1 and row["stop_status"] == "running"
    shown = r3.client.get(f"/api/studio-sessions/{sid}", headers=r3.mia).text
    audit = r3.client.get(f"/api/studio-sessions/{sid}/audit", headers=r3.jon).text
    for text in (shown, audit):
        assert "secret" not in text and "HIVE_TOKEN" not in text and "survived KILL" not in text
    assert "(running)" in json.loads(shown)["stop"]["message"]


# ---- r3.2: no driver I/O inside a database transaction (stand-in R3.1 #1) ---------------------------------------------------

@pytest.mark.parametrize("where", ["verified-stop", "release-verify"])
def test_r32_a_parked_status_read_never_holds_the_database(r3, monkeypatch, where):
    """The person-visible stop status reads the driver's status(), which may block (process or Docker I/O). While it is
    parked, unrelated database work proceeds; past STATUS_TIMEOUT_S the status reads "unknown" and the stop fails
    visibly, without waiting for the driver."""
    monkeypatch.setattr(SH, "STATUS_TIMEOUT_S", 1.0, raising=False)
    session, sid, m, ack, step = started(r3)
    gate, entered = threading.Event(), threading.Event()
    if where == "verified-stop":
        r3.driver.fail[("stop", r3.maker["id"])] = RuntimeError("stubborn group")
        r3.driver.gates[("status", r3.maker["id"])], r3.driver.entered[("status", r3.maker["id"])] = gate, entered
    else:
        real = studio(r3)._verify
        n = {"calls": 0}

        def second_fails(aid):
            n["calls"] += 1
            if n["calls"] == 2:                                            # park status() only for the status word
                r3.driver.gates[("status", aid)], r3.driver.entered[("status", aid)] = gate, entered
                raise RuntimeError("running again")
            return real(aid)
        monkeypatch.setattr(studio(r3), "_verify", second_fails)
    stop(r3, sid)
    assert entered.wait(15)                                                # S is inside the status read
    finished = threading.Event()

    def unrelated():
        with r3.hive.db.transaction():
            r3.hive.db.one("SELECT 1 AS one")
        finished.set()
    t = threading.Thread(target=unrelated, daemon=True)
    t.start()
    assert finished.wait(0.5), "unrelated database work waited on a driver status read"
    assert wait_for(lambda: ses_row(r3, sid)["stop_failed"] == 1, 10)      # bounded: no wait for the driver
    assert ses_row(r3, sid)["stop_status"] == "unknown"
    gate.set()
    r3.driver.fail.pop(("stop", r3.maker["id"]), None)
    studio(r3).__dict__.pop("_verify", None)
    del r3.driver.gates[("status", r3.maker["id"])]
    assert control(r3, sid, "finish_stopping").status_code == 200
    stopped_and_released(r3, sid)



def namespace_alias_before_install(x, monkeypatch):
    """Raw synthetic historical row appears after the durable rotate authorization, before the protected renames."""
    from hive.tests.test_identity_namespace import historical
    st, maker = studio(x), x.maker['id']
    original = st._install_files
    def install(aid, root, epoch, digest):
        alias = 'A_' + maker[2:]
        if not x.hive.db.one('SELECT id FROM agents WHERE id=?', (alias,)):
            historical(x.hive, maker, alias)
        return original(aid, root, epoch, digest)
    monkeypatch.setattr(st, '_install_files', install)


def test_handoff_install_namespace_refusal_is_held_as_namespace_conflict(r3, monkeypatch):
    session, sid, m, step = ready2(r3)
    upload(r3, sid, m, 2, gen=2)
    assert studio(r3).worker.wait_idle(15)
    starts = r3.driver.calls.count(('start', r3.maker['id']))
    namespace_alias_before_install(r3, monkeypatch)
    tick(r3)
    assert studio(r3).worker.wait_idle(15)
    row = handoff(r3, sid)
    assert (row['state'], row['reason']) == ('held', 'namespace_conflict')
    assert r3.driver.calls.count(('start', r3.maker['id'])) == starts


def test_release_install_namespace_refusal_cannot_reset_a_credential_phase(r3, monkeypatch):
    session, sid, m, ack, step = started(r3)
    namespace_alias_before_install(r3, monkeypatch)
    stop(r3, sid)
    assert studio(r3).worker.wait_idle(15)
    before = ses_row(r3, sid)
    assert before['credential_reason'] == 'namespace_conflict'
    assert before['release_phase'] == 'installed'
    epoch = epoch_of(r3)
    assert studio(r3)._phase_reset(sid) is False
    after = ses_row(r3, sid)
    assert (after['release_phase'], after['release_epoch'], after['release_token_hash']) == (before['release_phase'], before['release_epoch'], before['release_token_hash'])
    assert epoch_of(r3) == epoch


# Explicit owner recovery of the original installed release; no identity migration or second rotation.
def namespace_release_held(x, monkeypatch):
    session, sid, m, ack, step = started(x)
    st = studio(x); install = st._install_files
    namespace_alias_before_install(x, monkeypatch)
    stop(x, sid)
    assert st.worker.wait_idle(15)
    monkeypatch.setattr(st, '_install_files', install)
    row = ses_row(x, sid)
    assert (row['state'], row['credential_reason'], row['release_phase']) == ('stopping', 'namespace_conflict', 'installed')
    return sid, 'A_' + x.maker['id'][2:]


def test_owner_namespace_repair_resumes_installed_release_without_another_rotation_and_replays_one_control(r3, monkeypatch):
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); before = ses_row(r3, sid); epoch = epoch_of(r3)
    status = r3.client.get(f'/api/studio-sessions/{sid}', headers=r3.mg).json()
    assert status['credential_reason'] == 'namespace_conflict' and status['stop']['release_phase'] == 'installed'
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    tick(r3); assert st.worker.wait_idle(15)
    assert ses_row(r3, sid)['credential_reason'] == 'namespace_conflict'  # no automatic resume after external repair
    history = len(st.worker.history)
    first = control(r3, sid, 'repair_handoff', cid='repair-owner-0001')
    assert first.status_code == 200, first.text
    assert st.worker.wait_idle(15)
    after = ses_row(r3, sid)
    assert after['maker_released'] and after['state'] == SH.ENDED
    assert after['credential_reason'] is None
    assert epoch_of(r3) == epoch == before['release_epoch']
    assert after['release_token_hash'] == before['release_token_hash']
    assert credential_ok(r3)
    assert len(st.worker.history) == history + 1
    again = control(r3, sid, 'repair_handoff', cid='repair-owner-0001')
    assert again.status_code == 200 and again.json() == first.json()
    assert len(st.worker.history) == history + 1
    assert control(r3, sid, 'stop', cid='repair-owner-0001').status_code == 409


def test_owner_namespace_repair_refuses_a_remaining_conflict_without_touching_credentials_or_dispatching(r3, monkeypatch):
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); before = ses_row(r3, sid); history = len(st.worker.history)
    root = r3.workspace.path(r3.maker['id'])
    saved = {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}
    result = control(r3, sid, 'repair_handoff')
    assert result.status_code == 409 and result.json()['error']['code'] == 'workspace_identity_conflict'
    assert ses_row(r3, sid) == before and len(st.worker.history) == history
    assert {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()} == saved


def test_namespace_repair_uses_only_the_owner_control_and_is_closed_when_studio_is_off(r3, monkeypatch):
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); before = ses_row(r3, sid); history = len(st.worker.history)
    payload = {'control_id': 'repair-authority-0001', 'action': 'repair_handoff'}
    from hive.tests.test_studio_session_g1 import session_headers
    other = session_headers(r3.hive, 'user:u_ann')
    assert r3.client.post(f'/api/studio-sessions/{sid}/controls', headers=other, json=payload).status_code == 404
    assert r3.client.post(f'/api/studio-sessions/{sid}/controls', headers=r3.jg, json=payload).status_code == 404
    assert r3.client.post(f'/api/studio-sessions/{sid}/admin-controls', headers=r3.jg, json=payload).status_code == 400
    assert control(r3, sid, 'repair_handoff', extra=True).status_code == 400
    assert r3.client.get(f'/api/studio-sessions/{sid}', headers=r3.jg).status_code == 404
    monkeypatch.setattr(st, 'enabled', False)
    assert control(r3, sid, 'repair_handoff').status_code == 404
    assert control(r3, sid, 'repair_handoff', extra=True).status_code == 404
    assert ses_row(r3, sid) == before and len(st.worker.history) == history


@pytest.mark.parametrize('phase,reason', [('none', 'namespace_conflict'), ('prepared', 'namespace_conflict'),
                                        ('durable', 'namespace_conflict'), ('installed', 'credential_missing')])
def test_owner_repair_rejects_other_release_states(r3, phase, reason):
    session, sid, m, ack, step = started(r3)
    r3.hive.db.execute("UPDATE studio_sessions SET state='stopping', release_phase=?, credential_reason=? WHERE id=?", (phase, reason, sid))
    before = ses_row(r3, sid)
    result = control(r3, sid, 'repair_handoff')
    assert result.status_code == 409 and result.json()['error']['code'] == 'handoff_not_held'
    assert ses_row(r3, sid) == before


def test_repair_reholds_if_the_namespace_changes_after_the_owner_control_commits(r3, monkeypatch):
    from hive.tests.test_identity_namespace import historical
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); epoch = epoch_of(r3)
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    submit = st.submit_stop
    def changed(session_id):
        historical(r3.hive, r3.maker['id'], alias)
        return submit(session_id)
    monkeypatch.setattr(st, 'submit_stop', changed)
    result = control(r3, sid, 'repair_handoff')
    assert result.status_code == 200, result.text
    assert st.worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert row['credential_reason'] == 'namespace_conflict' and row['release_phase'] == 'installed'
    assert not row['maker_released'] and epoch_of(r3) == epoch


def test_owner_repair_does_not_clear_a_hold_while_the_existing_worker_is_busy(r3, monkeypatch):
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); gate = threading.Event(); entered = threading.Event()
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    before = ses_row(r3, sid)
    def occupied():
        entered.set(); gate.wait(15)
    assert st.worker.submit(r3.maker['id'], 'S', 'synthetic-busy', occupied, sid)
    try:
        assert entered.wait(15)
        result = control(r3, sid, 'repair_handoff')
        assert result.status_code == 409 and result.json()['error']['code'] == 'handoff_in_progress'
        assert ses_row(r3, sid) == before
    finally:
        gate.set(); assert st.worker.wait_idle(15)



def test_namespace_conflict_before_first_stop_uses_guarded_retry_without_an_inapplicable_owner_gate(r3):
    from hive.tests.test_identity_namespace import historical
    session, sid, m, ack, step = started(r3)
    st = studio(r3); alias = 'A_' + r3.maker['id'][2:]; epoch = epoch_of(r3)
    historical(r3.hive, r3.maker['id'], alias)
    stop(r3, sid); assert st.worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert row['credential_reason'] == 'namespace_conflict' and row['release_phase'] == 'none'
    assert not row['stop_verified'] and not row['maker_released']
    assert control(r3, sid, 'repair_handoff').status_code == 409
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    tick(r3); assert st.worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert row['state'] == SH.ENDED and row['maker_released']
    assert row['credential_reason'] is None and epoch_of(r3) == epoch + 1
    assert credential_ok(r3)


@pytest.mark.parametrize('stage', ['first-match', 'sync', 'final-match'])
def test_namespace_refusal_anywhere_in_installed_release_reholds_until_another_owner_action(r3, monkeypatch, stage):
    from hive.tests.test_identity_namespace import historical
    sid, alias = namespace_release_held(r3, monkeypatch)
    st = studio(r3); epoch = epoch_of(r3)
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    match, sync = st._files_match, st._sync_files
    calls = 0
    def matching(*args):
        nonlocal calls
        calls += 1
        if (stage == 'first-match' and calls == 1) or (stage == 'final-match' and calls == 2):
            historical(r3.hive, r3.maker['id'], alias)
        return match(*args)
    def syncing(*args):
        if stage == 'sync': historical(r3.hive, r3.maker['id'], alias)
        return sync(*args)
    monkeypatch.setattr(st, '_files_match', matching); monkeypatch.setattr(st, '_sync_files', syncing)
    result = control(r3, sid, 'repair_handoff', cid='repair-late-0001')
    assert result.status_code == 200, result.text
    assert st.worker.wait_idle(15)
    row = ses_row(r3, sid)
    assert (row['credential_reason'], row['release_phase']) == ('namespace_conflict', 'installed')
    assert not row['maker_released'] and epoch_of(r3) == epoch
    assert row['finish_count'] == 0
    r3.hive.db.execute('DELETE FROM agents WHERE id=?', (alias,))
    monkeypatch.setattr(st, '_files_match', match); monkeypatch.setattr(st, '_sync_files', sync)
    history = len(st.worker.history); before = ses_row(r3, sid)
    for _ in range(3): tick(r3)
    assert st.worker.wait_idle(15)
    assert len(st.worker.history) == history and ses_row(r3, sid) == before
    result = control(r3, sid, 'repair_handoff', cid='repair-late-0002')
    assert result.status_code == 200, result.text
    assert st.worker.wait_idle(15)
    assert ses_row(r3, sid)['maker_released'] and epoch_of(r3) == epoch
    assert ses_row(r3, sid)['finish_count'] == 0 and credential_ok(r3)
