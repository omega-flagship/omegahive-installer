"""Linkage spec r3.3 §L (slice 1): the lifetime data-directory lock and the one combined startup recovery.
Synthetic and disposable: temporary data directories, no port is bound (uvicorn.run is replaced in every child
process), no live hive, no model call. L-numbers are the spec's §E rows; Ask-intent parts arrive in a later slice.

Imports of hive.core.exclusive are inside the tests so that this file also runs as a baseline negative on a tree that
predates §L (every test must then fail)."""
import importlib
import os
import pathlib
import signal
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
STALE = (("r-reserved", "reserved"), ("r-dispatched", "dispatched"), ("r-unknown", "unknown"), ("r-settled", "settled"))


# ---- helpers ------------------------------------------------------------------------------------------------------

def held(data_dir):
    """A real lifetime lock on data_dir in a fresh holder (the lock fixture tests use instead of main())."""
    from hive.core import exclusive
    return exclusive.acquire(data_dir, exclusive.Held())


def release(holder):
    if holder.fd is not None:
        os.close(holder.fd)
        holder.fd = None


def recover(db):
    """Runs the combined startup recovery on db under a real lock on the data directory db actually lives in, then
    releases it (tests that relied on the old constructor sweep call this, as §L.5 requires)."""
    from hive.core import exclusive
    path = next(row[2] for row in db._conn.execute("PRAGMA database_list").fetchall() if row[1] == "main")
    holder = held(pathlib.Path(path).parent)
    try:
        return exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
    finally:
        release(holder)


def seed(db_path):
    """Stale rows a previous process left: reserved and dispatched (to recover) beside unknown and settled (kept)."""
    from hive.core.db import Database
    from hive.core.cost_reservations import Reservations
    db = Database(db_path)
    Reservations(db)
    for key, state in STALE:
        db.execute("INSERT INTO cost_reservations (id, binding, maximum, state) VALUES (?, 'b', 1000, ?)", (key, state))
    db._conn.close()


def states(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return dict(conn.execute("SELECT id, state FROM cost_reservations").fetchall())
    finally:
        conn.close()


RECOVERED = {"r-reserved": "unknown", "r-dispatched": "unknown", "r-unknown": "unknown", "r-settled": "settled"}
UNCHANGED = dict(STALE)

CHILD = textwrap.dedent("""
    import os, sys, time
    sys.path.insert(0, os.environ["T_ROOT"])
    import uvicorn
    def fake_run(app, **kw):        # serving would start here: report, then hold (keeping the lock) or leave
        from hive.core import exclusive
        print("SERVING recovered=%s" % exclusive.HELD.recovered, flush=True)
        if os.environ.get("T_HOLD"):
            time.sleep(float(os.environ["T_HOLD"]))
    uvicorn.run = fake_run
    if os.environ.get("T_FAULT"):   # a second recovery step after the reservations step: raise, or hang until killed
        from hive.core import exclusive
        def step(tx):
            if os.environ["T_FAULT"] == "hang":
                print("IN-RECOVERY", flush=True)
                time.sleep(60)
            raise RuntimeError("injected fault in step 2")
        exclusive.STEPS = list(exclusive.STEPS) + [("fault", step)]
    if os.environ.get("T_APP_FAULT"):
        import hive.__main__ as m
        def broken(settings):
            raise RuntimeError("injected create_app fault")
        m.create_app = broken
    import hive.__main__ as m
    m.main()
""")


def start(data_dir, tmp_path, **env):
    script = tmp_path / "child.py"
    script.write_text(CHILD)
    full = {k: v for k, v in os.environ.items() if not k.startswith("HIVE_")}
    full.update({"T_ROOT": str(ROOT), "HIVE_DATA_DIR": str(data_dir), "HIVE_OFFLINE": "1", "HIVE_ADMIN_PASSWORD": "pw",
                 "HIVE_PORT": "1", "PYTHONUNBUFFERED": "1"})
    full.update({k: str(v) for k, v in env.items()})
    proc = subprocess.Popen([sys.executable, str(script)], cwd=str(ROOT), env=full, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    proc.out, proc.err = [], []
    proc.readers = [threading.Thread(target=lambda f=f, sink=sink: sink.extend(iter(f.readline, "")), daemon=True)
                    for f, sink in ((proc.stdout, proc.out), (proc.stderr, proc.err))]
    for reader in proc.readers:
        reader.start()
    return proc


def wait_line(proc, text, timeout=60):
    """Waits until a line of the child's stdout contains text; returns the lines so far."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        lines = list(proc.out)
        if any(text in line for line in lines):
            return lines
        if proc.poll() is not None and not any(r.is_alive() for r in proc.readers):
            break
        time.sleep(0.05)
    raise AssertionError(f"never saw {text!r}: {proc.out} / rc={proc.poll()} / {''.join(proc.err)}")


def finish(proc, timeout=60):
    proc.wait(timeout=timeout)
    for reader in proc.readers:
        reader.join(timeout=10)
    return proc.returncode, "".join(proc.out), "".join(proc.err)


def stop(proc):
    if proc.poll() is None:
        proc.kill()
    finish(proc, timeout=30)


# ---- §L lock ------------------------------------------------------------------------------------------------------

def test_L1_L12_two_processes_on_one_data_directory_exactly_one_recovers(tmp_path):
    """L1/L12: two real processes started together on one data directory with stale reservations: one takes the lock
    and recovers once; the other exits 75 with the fixed message, builds no app and changes nothing; the first is
    unaffected and still holds the lock."""
    data = tmp_path / "data"
    data.mkdir()
    seed(data / "hive.db")
    a = start(data, tmp_path, T_HOLD=60)
    b = start(data, tmp_path, T_HOLD=60)
    try:
        deadline = time.time() + 90
        while a.poll() is None and b.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        loser = a if a.poll() is not None else b
        winner = b if loser is a else a
        rc, out, err = finish(loser)
        assert rc == 75, (rc, out, err)
        assert f"[hive] data directory {data} is in use by another hive process; not starting" in err
        assert "SERVING" not in out and "startup recovery" not in out
        lines = wait_line(winner, "SERVING recovered=True")
        assert sum("startup recovery committed: reservations=2" in line for line in lines) == 1
        assert winner.poll() is None                                          # unaffected by the refused start
        assert states(data / "hive.db") == RECOVERED
        from hive.core import exclusive
        with pytest.raises(exclusive.InUse):                                  # the winner still owns the directory
            held(data)
    finally:
        stop(a)
        stop(b)


def test_L2_L6_overlapping_restart_waits_for_the_old_process_then_recovers_once(tmp_path):
    """L2: the new process starts while the old one runs: 75. L6: the old one is SIGKILLed: the kernel releases the
    lock and the next start acquires it and recovers (once)."""
    data = tmp_path / "data"
    old = start(data, tmp_path, T_HOLD=60)
    try:
        wait_line(old, "SERVING recovered=True")
        seed_more = sqlite3.connect(data / "hive.db")                       # the old process's own calls, in flight
        seed_more.execute("INSERT INTO cost_reservations (id, binding, maximum, state) VALUES ('live', 'b', 5, 'dispatched')")
        seed_more.commit()
        seed_more.close()
        rc, out, err = finish(start(data, tmp_path))
        assert rc == 75 and "in use by another hive process" in err and "SERVING" not in out
        assert states(data / "hive.db")["live"] == "dispatched"              # the refused start rewrote nothing
        old.send_signal(signal.SIGKILL)
        old.wait(timeout=30)
        rc, out, err = finish(start(data, tmp_path))
        assert rc == 0, err
        assert out.count("startup recovery committed: reservations=1") == 1 and "SERVING recovered=True" in out
        assert states(data / "hive.db")["live"] == "unknown"
    finally:
        stop(old)


def test_L3_the_lock_cannot_be_established_exits_78_without_building_anything(tmp_path, monkeypatch):
    """L3: the lock file cannot be opened (a directory stands in its place), or flock raises ENOLCK / EOPNOTSUPP."""
    import errno
    import fcntl
    data = tmp_path / "data"
    (data / "hive.lock").mkdir(parents=True)
    rc, out, err = finish(start(data, tmp_path))
    assert rc == 78, (rc, err)
    assert f"[hive] cannot establish exclusive ownership of {data}: EISDIR; not starting" in err
    assert "SERVING" not in out and not (data / "hive.db").exists()
    import hive.__main__ as main_module
    from hive.core import exclusive
    built = []
    monkeypatch.setattr(main_module, "create_app", lambda *a, **k: built.append(1))
    for code in (errno.ENOLCK, errno.EOPNOTSUPP):
        def refuse(fd, op, code=code):
            raise OSError(code, os.strerror(code))
        monkeypatch.setattr(fcntl, "flock", refuse)
        monkeypatch.setattr(exclusive, "HELD", exclusive.Held())
        monkeypatch.setenv("HIVE_DATA_DIR", str(tmp_path / f"d{code}"))
        with pytest.raises(SystemExit) as exit_:
            main_module.main()
        assert exit_.value.code == 78 and not built and exclusive.HELD.fd is None


def test_the_lock_is_not_inherited_by_child_processes(tmp_path):
    """A mind process the hive starts must never keep the data directory locked after the hive exits."""
    holder = held(tmp_path)
    try:
        assert os.get_inheritable(holder.fd) is False
        code = "import fcntl,os,sys; fd=os.open(sys.argv[1], os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)"
        probe = subprocess.run([sys.executable, "-c", code, str(tmp_path / "hive.lock")], capture_output=True, text=True,
                               close_fds=False, pass_fds=())
        assert probe.returncode != 0 and "BlockingIOError" in probe.stderr     # held by us, not given to the child
    finally:
        release(holder)


def test_the_lock_file_carries_informational_content_only(tmp_path):
    import json
    holder = held(tmp_path)
    try:
        info = json.loads((tmp_path / "hive.lock").read_text())
        assert info["pid"] == os.getpid() and info["boot_nonce"] == holder.boot_nonce and info["started_at"]
        (tmp_path / "hive.lock").write_text('{"pid": 1}')                   # editing it changes nothing
        holder.verify()
    finally:
        release(holder)


# ---- §L recovery: never implicit, once, only under a verified lock ----------------------------------------------

def _app(data_dir):
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import FakeSupervisor, PETTA
    settings = load_settings(data_dir=pathlib.Path(data_dir), admin_password="pw", petta_path=PETTA)
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


def test_L4_L9_rebuilding_the_app_in_a_running_process_never_rewrites_live_liabilities(tmp_path):
    """L4/L9: create_app() twice in one process and Reservations(db) again, with live reserved and dispatched
    reservations present: no recovery runs and the rows are unchanged."""
    from hive.core.cost_reservations import Reservations
    seed(tmp_path / "hive.db")
    first = _app(tmp_path)
    second = _app(tmp_path)
    Reservations(first.state.hive.db)
    Reservations(second.state.hive.db)
    assert states(tmp_path / "hive.db") == UNCHANGED


REIMPORT = textwrap.dedent("""
    import importlib, os, sys, types
    sys.path.insert(0, os.environ["T_ROOT"])
    from hive.core.db import Database
    import hive.core.cost_reservations as reservations
    import hive.core.exclusive as exclusive
    db = Database(sys.argv[1])
    importlib.reload(reservations).Reservations(db)              # a re-imported module's constructor: schema only
    held = exclusive.acquire(sys.argv[2])                         # this process's real lifetime lock ...
    fresh = importlib.reload(exclusive)                           # ... and a re-import, which starts an empty holder
    try:
        fresh.startup_recovery(fresh.HELD, types.SimpleNamespace(db=db))
        print("recovered")
    except fresh.RecoveryRefused:
        print("refused")
""")


def test_L4_module_re_import_never_recovers(tmp_path):
    """L4: in a separate process (a reload would leak into other tests): re-importing cost_reservations and
    constructing it changes nothing, and a re-imported exclusive has an empty holder whose recovery is refused."""
    seed(tmp_path / "hive.db")
    script = tmp_path / "reimport.py"
    script.write_text(REIMPORT)
    out = subprocess.run([sys.executable, str(script), str(tmp_path / "hive.db"), str(tmp_path)],
                         env={**os.environ, "T_ROOT": str(ROOT)}, capture_output=True, text=True, timeout=120)
    assert out.stdout.strip() == "refused", out.stderr
    assert states(tmp_path / "hive.db") == UNCHANGED


def test_L5_L10_a_second_recovery_in_the_same_process_is_refused(tmp_path):
    from hive.core import exclusive
    from hive.core.db import Database
    seed(tmp_path / "hive.db")
    db = Database(tmp_path / "hive.db")
    holder = held(tmp_path)
    try:
        assert exclusive.startup_recovery(holder, types.SimpleNamespace(db=db)) == {"reservations": 2, "ask_intents": 0, "studio": 0}
        assert holder.recovered is True
        db.execute("UPDATE cost_reservations SET state = 'dispatched' WHERE id = 'r-settled'")   # a live call since
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
        assert holder.recovered is True and states(tmp_path / "hive.db")["r-settled"] == "dispatched"
    finally:
        release(holder)


def data_dir(base, name):
    """A data directory with its own seeded hive.db and a Database on it (the shape recovery binds to)."""
    from hive.core.db import Database
    d = base / name
    d.mkdir()
    seed(d / "hive.db")
    return d, types.SimpleNamespace(db=Database(d / "hive.db"))


def test_L11_no_holder_a_closed_or_reused_fd_or_a_lost_lock_is_refused(tmp_path):
    """L11: the lock must verifiably be owned now; a stored pid or an open fd number is not proof (Review r3.2).
    Each case locks the data directory its database is in, so only the case's own defect refuses it."""
    from hive.core import exclusive
    d, hive = data_dir(tmp_path, "none")
    with pytest.raises(exclusive.RecoveryRefused):                          # no holder at all
        exclusive.startup_recovery(exclusive.Held(), hive)
    d, hive = data_dir(tmp_path, "closed")
    holder = held(d)
    os.close(holder.fd)                                                     # closed fd: the kernel released the lock
    with pytest.raises(exclusive.RecoveryRefused):
        exclusive.startup_recovery(holder, hive)
    other = os.open(d / "hive.db", os.O_RDONLY)                             # the number reused by an arbitrary file
    try:
        holder.fd = other
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, hive)
    finally:
        os.close(other)
    assert states(d / "hive.db") == UNCHANGED
    d, hive = data_dir(tmp_path, "forged")
    real = held(d)
    other = os.open(d / "hive.db", os.O_RDONLY)
    try:                                                                     # the lock really held, but the holder's fd
        forged = exclusive.Held()                                            # is an arbitrary file: not proof
        forged.fd, forged.pid, forged.path, forged.ident, forged.dir_ident = (other, os.getpid(), real.path, real.ident,
                                                                               real.dir_ident)
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(forged, hive)
    finally:
        os.close(other)
        release(real)
    assert states(d / "hive.db") == UNCHANGED
    d, hive = data_dir(tmp_path, "lost")
    holder = held(d)
    try:
        import fcntl
        fcntl.flock(holder.fd, fcntl.LOCK_UN)                                # the lock lost while the fd stays open
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, hive)
        fcntl.flock(holder.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (d / "hive.lock").unlink()                                           # the path no longer names the locked file
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, hive)
    finally:
        release(holder)
    assert states(d / "hive.db") == UNCHANGED
    d, hive = data_dir(tmp_path, "pid")
    holder = held(d)
    try:
        holder.pid = holder.pid + 1                                          # a holder from another pid
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, hive)
        holder.pid = os.getpid()                                             # control: the same holder, put right
        assert exclusive.startup_recovery(holder, hive) == {"reservations": 2, "ask_intents": 0, "studio": 0}
    finally:
        release(holder)


# ---- Correction 1 (Review FIX-FIRST B1 on 3d77e95): the lock must cover the database recovery rewrites ------------

REVIEW_PROBE_CHILD = ("from hive.core import exclusive; import sys; exclusive.acquire(sys.argv[1]); print('READY',flush=True); "
                      "sys.stdin.readline()")


def test_review_probe_a_lock_on_A_never_recovers_B_held_by_another_process(tmp_path):
    """Review's probe (review_lock_binding.py), kept
    as a regression: a child process holds B's lifetime lock, this process holds A's; recovery with A's holder on B's
    database must refuse and change nothing (3d77e95 committed reservations=1)."""
    from hive.core import exclusive
    from hive.core.db import Database
    from hive.core.cost_reservations import Reservations
    a = tmp_path / "a"
    b = tmp_path / "b"
    b.mkdir()
    db = Database(b / "hive.db")
    Reservations(db)
    db.execute("INSERT INTO cost_reservations(id,binding,maximum,state) VALUES('original','b',1000,'dispatched')")
    child = subprocess.Popen([sys.executable, "-c", REVIEW_PROBE_CHILD, str(b)], cwd=str(ROOT), stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, text=True)
    holder = exclusive.acquire(a, exclusive.Held())
    try:
        assert child.stdout.readline().strip() == "READY"
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
        assert db.execute("SELECT state FROM cost_reservations WHERE id='original'").fetchone()[0] == "dispatched"
        assert holder.attempted is False and holder.recovered is False   # refused before the marker
    finally:
        child.stdin.close()
        child.wait(timeout=10)
        os.close(holder.fd)
        db._conn.close()


def test_correction1_foreign_databases_are_refused_before_the_marker(tmp_path):
    """A database outside the locked directory (no other holder), a look-alike file name in the locked directory, an
    in-memory database, a hive.db that is a link to another directory's database, and a hive whose configured data
    directory is another one: all refused, nothing changed, the marker untouched."""
    from hive.core import exclusive
    from hive.core.cost_reservations import Reservations
    from hive.core.db import Database
    a, _ = data_dir(tmp_path, "a")
    b, foreign = data_dir(tmp_path, "b")
    holder = held(a)
    try:
        def refused(hive):
            with pytest.raises(exclusive.RecoveryRefused):
                exclusive.startup_recovery(holder, hive)
            assert holder.attempted is False and holder.recovered is False
        refused(foreign)                                                     # B's database under A's lock
        other_name = Database(a / "other.db")
        Reservations(other_name)
        other_name.execute("INSERT INTO cost_reservations(id,binding,maximum,state) VALUES('x','b',1,'dispatched')")
        refused(types.SimpleNamespace(db=other_name))                       # not the directory's hive.db
        memory = Database(":memory:")
        Reservations(memory)
        refused(types.SimpleNamespace(db=memory))                           # in memory: no directory at all
        linked = tmp_path / "linked"
        linked.mkdir()
        os.symlink(b / "hive.db", linked / "hive.db")
        held_linked = held(linked)
        try:
            with pytest.raises(exclusive.RecoveryRefused):                  # linked/hive.db -> b/hive.db
                exclusive.startup_recovery(held_linked, types.SimpleNamespace(db=Database(linked / "hive.db")))
        finally:
            release(held_linked)
        own = Database(a / "hive.db")
        refused(types.SimpleNamespace(db=own, settings=types.SimpleNamespace(data_dir=b)))   # configured elsewhere
        assert states(a / "hive.db") == UNCHANGED and states(b / "hive.db") == UNCHANGED
        assert other_name.execute("SELECT state FROM cost_reservations").fetchone()[0] == "dispatched"
        # control: the same holder, its own database and settings, recovers
        assert exclusive.startup_recovery(holder, types.SimpleNamespace(db=own, settings=types.SimpleNamespace(data_dir=a))) \
            == {"reservations": 2, "ask_intents": 0, "studio": 0}
        assert states(a / "hive.db") == RECOVERED and states(b / "hive.db") == UNCHANGED
    finally:
        release(holder)


def test_correction1_a_path_alias_of_the_locked_directory_is_the_same_directory(tmp_path):
    """Identity, not string: locked through a symlinked alias, the database opened through the real path (and the
    settings naming the alias) is inside the locked directory and recovers."""
    from hive.core import exclusive
    real, _ = data_dir(tmp_path, "real")
    alias = tmp_path / "alias"
    os.symlink(real, alias)
    from hive.core.db import Database
    holder = held(alias)
    try:
        hive = types.SimpleNamespace(db=Database(real / "hive.db"), settings=types.SimpleNamespace(data_dir=alias))
        assert exclusive.startup_recovery(holder, hive) == {"reservations": 2, "ask_intents": 0, "studio": 0}
    finally:
        release(holder)
    assert states(real / "hive.db") == RECOVERED


def test_correction1_the_app_main_builds_is_bound_to_the_lock(tmp_path):
    """The real app: create_app's hive (settings and database) binds to a lock on its own data directory, and is
    refused under a lock on any other one."""
    from hive.core import exclusive
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    seed(a / "hive.db")
    app = _app(a)
    elsewhere = held(b)
    try:
        with pytest.raises(exclusive.RecoveryRefused):
            exclusive.startup_recovery(elsewhere, app.state.hive)
        assert elsewhere.attempted is False
    finally:
        release(elsewhere)
    assert states(a / "hive.db") == UNCHANGED
    own = held(a)
    try:
        assert exclusive.startup_recovery(own, app.state.hive) == {"reservations": 2, "ask_intents": 0, "studio": 0}
    finally:
        release(own)


SHARED = textwrap.dedent("""
    import fcntl, json, os, sys, types
    sys.path.insert(0, os.environ["T_ROOT"])
    from hive.core import exclusive
    from hive.core.db import Database
    given = json.loads(sys.argv[2])
    holder = exclusive.Held()                                     # the parent's holder, as a forked child would see it
    holder.fd, holder.pid, holder.path, holder.ident = given["fd"], given["pid"], given["path"], tuple(given["ident"])
    fcntl.flock(holder.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)         # the shared open file: the kernel grants it here too
    try:
        exclusive.startup_recovery(holder, types.SimpleNamespace(db=Database(sys.argv[1])))
        print("recovered")
    except exclusive.RecoveryRefused:
        print("refused")
""")


def test_L11_a_child_process_sharing_the_locked_open_file_cannot_recover(tmp_path):
    """L11 (forked child): a child that shares the parent's locked open file is granted the lock by the kernel, so only
    the pid binding refuses it. Passed with pass_fds, which shares the open file exactly as fork does, without
    forking the multi-threaded test process."""
    import json
    seed(tmp_path / "hive.db")
    holder = held(tmp_path)
    try:
        script = tmp_path / "shared.py"
        script.write_text(SHARED)
        given = json.dumps({"fd": holder.fd, "pid": holder.pid, "path": str(holder.path), "ident": list(holder.ident)})
        out = subprocess.run([sys.executable, str(script), str(tmp_path / "hive.db"), given], pass_fds=(holder.fd,),
                             env={**os.environ, "T_ROOT": str(ROOT)}, capture_output=True, text=True, timeout=120)
        assert out.stdout.strip() == "refused", out.stderr
        holder.verify()                                                      # the parent still owns it
    finally:
        release(holder)
    assert states(tmp_path / "hive.db") == UNCHANGED


def test_recovery_refuses_to_be_nested_in_another_transaction(tmp_path):
    from hive.core import exclusive
    from hive.core.db import Database
    seed(tmp_path / "hive.db")
    db = Database(tmp_path / "hive.db")
    holder = held(tmp_path)
    try:
        with pytest.raises(exclusive.RecoveryRefused):
            with db.transaction():
                exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
        assert holder.recovered is False
    finally:
        release(holder)
    assert states(tmp_path / "hive.db") == UNCHANGED


# ---- §L failure: roll back everything, serve nothing, the next start recovers ------------------------------------

def test_L7_create_app_failing_after_the_lock_recovers_nothing_and_the_next_start_succeeds(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    seed(data / "hive.db")
    rc, out, err = finish(start(data, tmp_path, T_APP_FAULT=1))
    assert rc != 0 and "injected create_app fault" in err and "SERVING" not in out and "startup recovery" not in out
    assert states(data / "hive.db") == UNCHANGED
    rc, out, err = finish(start(data, tmp_path))
    assert rc == 0 and "startup recovery committed: reservations=2" in out and "SERVING recovered=True" in out
    assert states(data / "hive.db") == RECOVERED


def test_L8_L13_a_fault_in_step_2_rolls_back_step_1_and_nothing_is_served(tmp_path):
    """L8/L13: step 1 (reservations) succeeds, step 2 raises in the same transaction: both roll back, the process exits
    non-zero without serving, and the next start recovers both."""
    data = tmp_path / "data"
    data.mkdir()
    seed(data / "hive.db")
    rc, out, err = finish(start(data, tmp_path, T_FAULT="raise"))
    assert rc == 70, (rc, err)
    assert "startup recovery failed and was rolled back: RuntimeError: injected fault in step 2; not starting" in err
    assert "SERVING" not in out and "startup recovery committed" not in out
    assert states(data / "hive.db") == UNCHANGED
    rc, out, err = finish(start(data, tmp_path))
    assert rc == 0 and out.count("startup recovery committed: reservations=2") == 1 and "SERVING recovered=True" in out
    assert states(data / "hive.db") == RECOVERED


def test_L8_in_process_failure_leaves_the_marker_false(tmp_path, monkeypatch):
    from hive.core import exclusive
    from hive.core.db import Database
    seed(tmp_path / "hive.db")
    db = Database(tmp_path / "hive.db")
    holder = held(tmp_path)

    def boom(tx):
        raise RuntimeError("fault")
    monkeypatch.setattr(exclusive, "STEPS", list(exclusive.STEPS) + [("fault", boom)])
    try:
        with pytest.raises(RuntimeError):
            exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
        assert holder.recovered is False and states(tmp_path / "hive.db") == UNCHANGED
        monkeypatch.setattr(exclusive, "STEPS", [s for s in exclusive.STEPS if s[0] != "fault"])
        with pytest.raises(exclusive.RecoveryRefused):                       # never an in-process retry, even now
            exclusive.startup_recovery(holder, types.SimpleNamespace(db=db))
        assert holder.recovered is False and states(tmp_path / "hive.db") == UNCHANGED
    finally:
        release(holder)


def test_L14_sigkill_during_recovery_before_commit_then_a_full_recovery(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    seed(data / "hive.db")
    proc = start(data, tmp_path, T_FAULT="hang")
    try:
        wait_line(proc, "IN-RECOVERY")                                       # step 1 done, inside the open transaction
        proc.send_signal(signal.SIGKILL)
        proc.wait(timeout=30)
    finally:
        stop(proc)
    assert states(data / "hive.db") == UNCHANGED                             # nothing committed
    rc, out, err = finish(start(data, tmp_path))
    assert rc == 0 and out.count("startup recovery committed: reservations=2") == 1
    assert states(data / "hive.db") == RECOVERED


def test_L15_a_clean_start_commits_zero_counts_before_serving(tmp_path):
    rc, out, err = finish(start(tmp_path / "fresh", tmp_path))
    assert rc == 0, err
    lines = out.splitlines()
    committed = lines.index("[hive] startup recovery committed: reservations=0, ask_intents=0, studio=0")
    assert lines.index("SERVING recovered=True") > committed
