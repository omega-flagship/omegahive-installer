"""Off, On and Wake all (Jon 2026-10-05): a power snapshot of the awake minds, restored exactly. FakeSupervisor."""
import json

import pytest

from hive.core.visibility import Viewer
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def minds(client, n, swarm=None):
    hive = client.app.state.hive
    sw = swarm or client.post("/api/swarms", json={"name": "Power"}).json()
    out = []
    for i in range(n):
        m = hive.create_agent(f"p{i}", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
        hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (m["id"],))
        out.append(m["id"])
    return sw, out


def row(client, mid):
    return client.app.state.hive.db.one("SELECT * FROM agents WHERE id = ?", (mid,))


def power(client, state, op, **kw):
    return client.post("/api/hive/power", json={"state": state, "operation_id": op}, **kw)


def calls(client, kind):
    return [a for k, a in client.supervisor.calls if k == kind]


def test_off_records_only_awake_minds_then_stops_them_and_on_restores_exactly_those(client):
    hive = client.app.state.hive
    sw, (a, b, kept_stopped, gone, sleepy) = minds(client, 5)
    hive.lifecycle(kept_stopped, "stop")                       # someone stopped it before Off: it stays stopped
    hive.lifecycle(sleepy, "sleep")                            # asleep is not meant to be awake either
    off = power(client, "off", "op-off").json()
    assert off["state"] == "off" and off["failed"] == [] and off["stopped"] == 4
    assert {a, b, gone} <= set(calls(client, "stop")) and all(row(client, m)["desired"] == "stopped" for m in (a, b, gone))
    snap = hive.db.one("SELECT * FROM power_snapshots")
    assert sorted(json.loads(snap["minds"])) == sorted([a, b, gone]) and snap["state"] == "off"
    assert client.get("/api/hive/power").json() == {"state": "off", "since": snap["created_at"], "by": "user:operator",
                                                    "minds_in_snapshot": 3}
    hive.delete_agent(gone)                                    # deleted while off: skipped
    client.supervisor.calls.clear()
    on = power(client, "on", "op-on").json()
    assert sorted(on["woken"]) == sorted([a, b]) and on["skipped"] == [{"id": gone, "reason": "deleted"}] and on["failed"] == []
    assert sorted(calls(client, "start")) == sorted([a, b])
    assert row(client, kept_stopped)["status"] == "stopped" and row(client, sleepy)["status"] == "stopped"
    assert hive.db.one("SELECT restored_at FROM power_snapshots")["restored_at"] == on["since"]
    assert client.get("/api/hive/power").json() == {"state": "on", "since": on["since"], "by": "user:operator",
                                                    "minds_in_snapshot": 0}


def test_a_mind_in_a_swarm_archived_while_off_is_skipped(client):
    hive = client.app.state.hive
    sw, (a,) = minds(client, 1)
    _, (b,) = minds(client, 1)
    power(client, "off", "off-1")
    hive.archive_swarm(sw["id"], "user:operator")
    on = power(client, "on", "on-1").json()
    assert on["woken"] == [b] and on["skipped"] == [{"id": a, "reason": "swarm archived"}]
    assert calls(client, "start") == [b] and row(client, a)["desired"] == "stopped"


def test_a_mind_already_awake_again_is_skipped_not_restarted(client):
    hive = client.app.state.hive
    _, (a, b) = minds(client, 2)
    power(client, "off", "off-2")
    hive.lifecycle(a, "start")                                 # woken by hand while off
    hive.db.execute("UPDATE agents SET status = 'awake' WHERE id = ?", (a,))
    client.supervisor.calls.clear()
    on = power(client, "on", "on-2").json()
    assert on["woken"] == [b] and on["skipped"] == [{"id": a, "reason": "awake"}] and calls(client, "start") == [b]


def test_a_stop_failure_during_off_is_reported_the_rest_stop_and_the_snapshot_is_kept(client):
    hive = client.app.state.hive
    _, (stuck, other) = minds(client, 2)
    real = client.supervisor.stop
    def stop(agent_id):
        if agent_id == stuck:
            raise RuntimeError("group outlived TERM and KILL")
        real(agent_id)
    client.supervisor.stop = stop
    try:
        off = power(client, "off", "off-3")
    finally:
        del client.supervisor.stop                             # the fixture's own shutdown stops every mind
    assert off.status_code == 200
    off = off.json()
    assert off["state"] == "off" and off["stopped"] == 1
    assert off["failed"] == [{"id": stuck, "error": "group outlived TERM and KILL"}]
    assert row(client, other)["desired"] == "stopped" and row(client, stuck)["desired"] == "awake"
    assert sorted(json.loads(hive.db.one("SELECT minds FROM power_snapshots")["minds"])) == sorted([stuck, other])


def test_a_start_failure_during_on_is_reported_and_the_rest_still_wake(client, monkeypatch):
    hive = client.app.state.hive
    _, (bad, good) = minds(client, 2)
    power(client, "off", "off-4")
    real = client.supervisor.start
    def start(agent_id):
        if agent_id == bad:
            raise RuntimeError("docker run failed")
        real(agent_id)
    monkeypatch.setattr(client.supervisor, "start", start)
    on = power(client, "on", "on-4").json()
    assert on["woken"] == [good] and on["failed"] == [{"id": bad, "error": "docker run failed"}]
    assert row(client, bad)["status"] == "error" and "docker run failed" in row(client, bad)["last_error"]
    assert hive.db.one("SELECT state FROM power_snapshots")["state"] == "restored"


def test_replaying_an_operation_returns_the_original_result(client):
    _, (a,) = minds(client, 1)
    first = power(client, "off", "same").json()
    _, (b,) = minds(client, 1)                                 # anything new since is not swept up by a replay
    assert power(client, "off", "same").json() == first and row(client, b)["desired"] == "awake"
    assert power(client, "on", "same").status_code == 409
    on = power(client, "on", "again").json()
    client.supervisor.calls.clear()
    assert power(client, "on", "again").json() == on and calls(client, "start") == []
    assert power(client, "off", "").status_code == 400 and power(client, "sideways", "x").status_code == 400


def test_a_second_off_keeps_the_first_awake_set(client):
    hive = client.app.state.hive
    _, (a, b) = minds(client, 2)
    first = power(client, "off", "off-a").json()
    second = power(client, "off", "off-b").json()
    assert second["stopped"] == 0 and second["since"] == first["since"]
    snaps = hive.db.all("SELECT * FROM power_snapshots")
    assert len(snaps) == 1 and sorted(json.loads(snaps[0]["minds"])) == sorted([a, b])
    assert sorted(power(client, "on", "on-ab").json()["woken"]) == sorted([a, b])


def test_wake_all_restores_from_a_plain_stop_all(client):
    hive = client.app.state.hive
    _, (a, b) = minds(client, 2)
    hive.lifecycle(b, "stop")
    assert client.post("/api/hive/stop-all").json() == {"stopped": 1}
    assert client.get("/api/hive/power").json()["state"] == "on"
    assert client.get("/api/hive/power").json()["minds_in_snapshot"] == 1
    client.supervisor.calls.clear()
    on = power(client, "on", "wake-all").json()
    assert on["woken"] == [a] and calls(client, "start") == [a] and row(client, b)["desired"] == "stopped"
    # a stop all that finds nothing awake leaves no empty snapshot behind
    hive.db.execute("UPDATE agents SET desired = 'stopped', status = 'stopped'")
    client.post("/api/hive/stop-all")
    assert client.get("/api/hive/power").json()["minds_in_snapshot"] == 0


def test_authority_admin_member_and_mind_token(client):
    member = person(client, "u_pmember")
    admin = person(client, "u_padmin", role="admin")
    _, (a,) = minds(client, 1)
    token = client.app.state.hive.create_agent("tok", "module", None, "mock/echo", "", None, 0, None, None)["token"]
    assert power(client, "off", "m-1", headers=member).status_code == 403
    assert power(client, "off", "t-1", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert client.get("/api/hive/power", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert row(client, a)["desired"] == "awake"
    off = power(client, "off", "a-1", headers=admin).json()
    assert off["state"] == "off" and row(client, a)["desired"] == "stopped"
    seen = client.get("/api/hive/power", headers=member).json()
    assert seen == {"state": "off", "since": off["since"], "by": "user:u_padmin"}   # no mind count, no mind names
    assert client.get("/api/hive/power", headers=admin).json()["minds_in_snapshot"] == 1


def test_get_before_any_power_change(client):
    assert client.get("/api/hive/power").json() == {"state": "on", "since": None, "by": None, "minds_in_snapshot": 0}


def test_the_power_event_carries_state_and_since_only_and_reaches_every_signed_in_person(client):
    hive = client.app.state.hive
    seen = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **payload: (seen.append((kind, payload)), real(kind, **payload))
    minds(client, 1)
    off = power(client, "off", "ev-off").json()
    on = power(client, "on", "ev-on").json()
    power(client, "on", "ev-on")                              # a replay announces nothing
    events = [p for k, p in seen if k == "hive.power"]
    assert events == [{"state": "off", "since": off["since"]}, {"state": "on", "since": on["since"]}]
    frame = json.dumps({"type": "hive.power", "at": "t", **events[0]})
    assert hive.visibility.event_visible(Viewer("user:u_anyone", False), frame)


# ---- custody before effect (Review FIX-FIRST on 293fe18, B1) ------------------------------------------------------------

class ProcessLost(BaseException):
    """Ends the pass the way process loss would: nothing in stop_all catches it."""


def test_a_pass_cut_short_after_some_stops_keeps_every_stopped_mind_survives_reopen_and_a_retry_finishes(client):
    from hive.core.hive import Hive
    hive = client.app.state.hive
    _, (a, b, c) = minds(client, 3)
    real, seen = client.supervisor.stop, []
    def stop(agent_id):
        seen.append(agent_id)
        if len(seen) == 2:
            raise ProcessLost()
        real(agent_id)
    client.supervisor.stop = stop
    try:
        try:
            hive.power.set("off", "cut", "user:operator")
        except ProcessLost:
            pass
    finally:
        del client.supervisor.stop
    first, second = seen
    assert row(client, first)["desired"] == "stopped" and row(client, second)["desired"] == "awake"
    held = json.loads(hive.power.pending()["minds"])
    assert first in held and second in held                    # held before its stop, even the one that never landed
    assert hive.db.one("SELECT status FROM power_operations WHERE operation_id = 'cut'")["status"] == "running"
    reopened = Hive(hive.settings, supervisor=client.supervisor)  # a restart reads the same custody back
    assert reopened.power.pending()["minds"] == hive.power.pending()["minds"]
    assert reopened.power.view(True)["state"] == "off"
    retried = power(client, "off", "cut").json()               # incomplete work is redone, not replayed
    assert retried["state"] == "off" and all(row(client, m)["desired"] == "stopped" for m in (a, b, c))
    assert sorted(json.loads(hive.power.pending()["minds"])) == sorted([a, b, c])
    assert power(client, "off", "cut").json() == retried       # now finished: a replay returns it as it was
    assert sorted(power(client, "on", "cut-on").json()["woken"]) == sorted([a, b, c])


def test_a_failure_after_the_stops_never_erases_a_stopped_mind_from_the_restore_set(client, monkeypatch):
    hive = client.app.state.hive
    _, (a, b) = minds(client, 2)
    real = hive.power.record
    def lost(*args, **kwargs):
        raise RuntimeError("simulated process loss before recording")
    monkeypatch.setattr(hive.power, "record", lost)
    with pytest.raises(RuntimeError):
        hive.power.set("off", "late", "user:operator")
    assert all(row(client, m)["desired"] == "stopped" for m in (a, b))
    assert sorted(json.loads(hive.power.pending()["minds"])) == sorted([a, b])
    monkeypatch.setattr(hive.power, "record", real)
    assert power(client, "off", "late").json()["state"] == "off"            # retry: both already stopped
    assert power(client, "off", "later").json()["stopped"] == 0              # and a fresh Off
    assert sorted(json.loads(hive.power.pending()["minds"])) == sorted([a, b])
    assert sorted(power(client, "on", "late-on").json()["woken"]) == sorted([a, b])
