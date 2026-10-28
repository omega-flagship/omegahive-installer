"""A mind outlives a hive restart: the new hive adopts it (no duplicate worker) and stop ends it (no orphan)."""
import os
import pathlib
import signal
import subprocess
import time

import pytest

from hive.supervisor.drivers import LocalDriver, ProcessObservationError


class FakeWorkspace:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.settings = type("S", (), {"data_dir": self.root, "core_root": self.root})()

    def path(self, agent_id):
        p = self.root / "agents" / agent_id
        p.mkdir(parents=True, exist_ok=True)
        return p

    def command(self, agent, petta_path):
        # a long-running stand-in whose command line names this mind's own folder, like the real run.sh does
        return ["/bin/sh", "-c", f"sleep 60; true # {self.path(agent['id'])}/run.metta"]


def _alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except OSError:
        return False


def test_a_restarted_hive_adopts_the_running_mind_and_stop_leaves_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)
    ws = FakeWorkspace(tmp_path)
    agent = {"id": "a_adopt", "kind": "omega"}
    first = LocalDriver(ws, "/nonexistent")
    first.start(agent, {})
    pgid = int((ws.path("a_adopt") / "mind.pid").read_text())
    assert _alive(pgid)

    second = LocalDriver(ws, "/nonexistent")               # the hive restarted: nothing in memory
    assert second.status("a_adopt") == "running"
    second.start(agent, {})                                 # must adopt, not start a second worker
    workers = subprocess.run(["pgrep", "-f", f"{ws.path('a_adopt')}/run.metta"], capture_output=True, text=True).stdout.split()
    assert len(workers) == 1

    second.stop("a_adopt")
    time.sleep(0.3)
    first.procs["a_adopt"].poll()                           # reap our own child (in real use launchd reaps orphans)
    assert not _alive(pgid) and second.status("a_adopt") == "absent"
    assert not (ws.path("a_adopt") / "mind.pid").exists()


def test_a_stale_pid_file_for_another_program_is_never_adopted(tmp_path):
    ws = FakeWorkspace(tmp_path)
    other = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)   # alive, but not this mind's program
    try:
        (ws.path("a_x") / "mind.pid").write_text(str(other.pid))
        d = LocalDriver(ws, "/nonexistent")
        # A nonmatching cwd/command alone cannot distinguish this foreign
        # group from a legitimate orphan that changed cwd. Keep it unresolved.
        with pytest.raises(ProcessObservationError):
            d.status("a_x")
        with pytest.raises(ProcessObservationError):
            d.stop("a_x")
        assert (ws.path("a_x") / "mind.pid").exists()
        assert other.poll() is None                         # never kills an unverified process
    finally:
        other.kill()


def test_stop_ends_a_child_that_ignores_term_and_outlives_its_leader(tmp_path, monkeypatch):
    """Found by OmegaDesign (STOP_LEADER_CHILD_REGRESSION, 2026-10-04): stop returned while a child lived on."""
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)

    class StubbornWorkspace(FakeWorkspace):
        def command(self, agent, petta_path):
            # The leader waits for a child that ignores TERM in this fixture's cwd.
            return ["/bin/sh", "-c", "(trap '' TERM; while true; do sleep 1; done) & wait"]

    ws = StubbornWorkspace(tmp_path)
    agent = {"id": "a_stub", "kind": "omega"}
    d = LocalDriver(ws, "/nonexistent")
    # A default SIGCHLD disposition keeps the direct child's PID reserved until this fixture waits.
    assert signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
    proc = None
    try:
        d.start(agent, {})
        proc = d.procs[agent["id"]]
        pgid = proc.pid
        assert int((ws.path("a_stub") / "mind.pid").read_text()) == pgid
        time.sleep(0.3)
        assert len(LocalDriver._group_members(pgid)) >= 2
        after_restart = LocalDriver(ws, "/nonexistent")
        assert after_restart.status("a_stub") == "running"
        d.stop("a_stub")
        assert LocalDriver._group_members(pgid) == []
        assert not (ws.path("a_stub") / "mind.pid").exists()
    finally:
        proc = proc if proc is not None else d.procs.get(agent["id"])
        if proc is not None:
            # Only this fixture's still-unreaped, new-session Popen reserves this PID/PGID.
            if proc.returncode is None and LocalDriver._group_members(proc.pid):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait(timeout=5)


def test_stop_ends_a_leftover_child_after_its_leader_exited(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)

    class OrphaningWorkspace(FakeWorkspace):
        def command(self, agent, petta_path):
            return ["/bin/sh", "-c", "(trap '' TERM; while true; do sleep 1; done) & exit 0"]

    ws = OrphaningWorkspace(tmp_path)
    d = LocalDriver(ws, "/nonexistent")
    agent = {"id": "a_orph", "kind": "omega"}
    # A default SIGCHLD disposition keeps the direct child's PID reserved until this fixture waits.
    assert signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
    proc = None
    try:
        d.start(agent, {})
        proc = d.procs[agent["id"]]
        pgid = proc.pid
        assert int((ws.path("a_orph") / "mind.pid").read_text()) == pgid
        time.sleep(0.5)
        # Prove the leader exited without reaping its reserved identity before fixture cleanup.
        # _group_members excludes zombies; the fresh driver still sees only the surviving child.
        assert proc.pid not in {pid for pid, _ in LocalDriver._group_members(pgid)}
        fresh = LocalDriver(ws, "/nonexistent")
        assert fresh.status("a_orph") == "running"
        fresh.stop("a_orph")
        assert LocalDriver._group_members(pgid) == []
    finally:
        proc = proc if proc is not None else d.procs.get(agent["id"])
        if proc is not None:
            # No poll/wait has reaped this fixture's new-session leader before group cleanup.
            if proc.returncode is None and LocalDriver._group_members(proc.pid):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            proc.wait(timeout=5)


def test_missing_pidfile_keeps_known_custody_after_the_leader_exits(tmp_path, monkeypatch):
    """Native owner gate: a known Popen group survives loss of its on-disk record."""
    monkeypatch.delenv("HIVE_MIND_SANDBOX", raising=False)

    class ControlledOrphanWorkspace(FakeWorkspace):
        def command(self, agent, petta_path):
            # Keep the leader until the test has removed the record; its child
            # inherits the workspace cwd and ignores TERM.
            return ["/bin/sh", "-c", "(trap '' TERM; while true; do sleep 1; done) & "
                    "while [ ! -f leader.exit ]; do sleep 0.05; done; exit 0"]

    ws = ControlledOrphanWorkspace(tmp_path)
    d = LocalDriver(ws, "/nonexistent")
    agent = {"id": "a_lost_record", "kind": "omega"}
    d.start(agent, {})
    proc = d.procs[agent["id"]]
    pgid = proc.pid
    record = ws.path(agent["id"]) / "mind.pid"
    try:
        deadline = time.monotonic() + 5
        while len(LocalDriver._group_members(pgid)) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert len(LocalDriver._group_members(pgid)) >= 2
        record.unlink()
        (ws.path(agent["id"]) / "leader.exit").touch()
        assert proc.wait(timeout=5) == 0
        assert d.status(agent["id"]) == "running"
        assert d.execution(agent["id"]).startswith(f"local:{pgid}:")
        d.stop(agent["id"])
        assert LocalDriver._group_members(pgid) == []
        assert agent["id"] not in d.procs
        assert not record.exists()
    finally:
        # Only this test's newly created process group; no broad process search.
        # Always clean it even when a qualification assertion or stop fails.
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)
