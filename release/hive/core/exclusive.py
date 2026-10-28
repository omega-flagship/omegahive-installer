"""Process exclusivity and the one startup recovery (linkage spec r3.3 §L, OPEN-16 and OPEN-17).

One hive process owns a HIVE_DATA_DIR for its whole lifetime. main() takes a non-blocking exclusive flock on
<data_dir>/hive.lock before the app is built and never closes it; the kernel releases it when the process ends, crash
and SIGKILL included, so there is no stale-lock state and no pid-based decision.

startup_recovery() is the only place that rewrites state left by a previous process. It runs once, from main(), under
the lock, after create_app() and before uvicorn.run(): every step in one transaction, one marker set after commit.
Constructors, create_app(), imports and retries never recover.
"""
import errno
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path

LOCK_NAME = "hive.lock"
EXIT_IN_USE = 75      # EX_TEMPFAIL: another hive process holds the data directory
EXIT_NO_LOCK = 78     # EX_CONFIG: ownership cannot be established
EXIT_RECOVERY = 70    # EX_SOFTWARE: the startup recovery failed and rolled back


class InUse(Exception):
    """The lock is held by another open file (another process, or another open in this one)."""


class Unavailable(Exception):
    """The lock cannot be established: the file cannot be opened, or flock is unsupported or fails."""

    def __init__(self, path, error):
        self.path, self.error = path, error
        self.errno_name = errno.errorcode.get(getattr(error, "errno", None) or 0, type(error).__name__)
        super().__init__(f"{path}: {self.errno_name}")


class RecoveryRefused(Exception):
    """startup_recovery was called without a verified lifetime lock, or a second time."""


class Held:
    """The process-lifetime holder. Its fd is never closed while the process runs."""

    def __init__(self):
        self.fd = None
        self.pid = None
        self.path = None
        self.ident = None          # (st_dev, st_ino) of the locked file, as opened
        self.dir_ident = None      # (st_dev, st_ino) of the data directory that holds it
        self.boot_nonce = None
        self.attempted = False     # recovery was entered in this process (it never runs twice, even after a failure)
        self.recovered = False     # the marker: set only after the recovery transaction commits

    def verify(self):
        """Proves from kernel state that this process holds the lock now; raises RecoveryRefused otherwise.
        A stored pid or an open fd number alone proves nothing (Review r3.2): the fd must still name the locked
        file, the path must still be that file, an independent open of it must be refused the lock, and our own
        description must still be granted it (so the holder is this open file, not someone else's)."""
        if self.fd is None or self.path is None or self.ident is None:
            raise RecoveryRefused("no lifetime lock is held")
        if self.pid != os.getpid():
            raise RecoveryRefused("the lifetime lock was taken by another process")
        import fcntl
        try:
            st = os.fstat(self.fd)
            on_disk = os.stat(self.path)
        except OSError as exc:
            raise RecoveryRefused(f"the lock file descriptor is not usable: {exc}") from exc
        if (st.st_dev, st.st_ino) != self.ident or (on_disk.st_dev, on_disk.st_ino) != self.ident:
            raise RecoveryRefused("the lock file descriptor no longer names the locked file")
        if _ident(self.path.parent) != self.dir_ident:
            raise RecoveryRefused("the lock file is no longer in the locked data directory")
        try:
            probe = os.open(self.path, os.O_RDWR)
        except OSError as exc:
            raise RecoveryRefused(f"the lock file cannot be probed: {exc}") from exc
        try:
            try:
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass   # held, as it must be
            except OSError as exc:
                raise RecoveryRefused(f"the lock cannot be probed: {exc}") from exc
            else:
                raise RecoveryRefused("the data directory lock is not held")   # the probe got it: nobody held it
        finally:
            os.close(probe)   # releases the probe's lock, if it took one
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)   # a no-op for the holder; refused for anyone else
        except OSError as exc:
            raise RecoveryRefused("the data directory lock is held by another open file") from exc


HELD = Held()


def acquire(data_dir, holder=None):
    """Takes the lifetime lock on <data_dir>/hive.lock into holder (HELD by default). Raises InUse or Unavailable."""
    import fcntl
    holder = HELD if holder is None else holder
    path = Path(data_dir) / LOCK_NAME
    try:
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)   # non-inheritable: no mind process keeps it after exit
    except OSError as exc:
        raise Unavailable(path, exc) from exc
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        st = os.fstat(fd)
        directory = os.stat(path.parent)
    except BlockingIOError as exc:
        os.close(fd)
        raise InUse(str(path)) from exc
    except OSError as exc:
        os.close(fd)
        if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
            raise InUse(str(path)) from exc
        raise Unavailable(path, exc) from exc
    holder.fd, holder.pid, holder.path, holder.ident = fd, os.getpid(), path, (st.st_dev, st.st_ino)
    holder.dir_ident = (directory.st_dev, directory.st_ino)
    holder.boot_nonce, holder.attempted, holder.recovered = secrets.token_hex(16), False, False
    try:   # informational only: nothing ever reads it to decide anything
        info = json.dumps({"pid": holder.pid, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           "boot_nonce": holder.boot_nonce}).encode()
        os.ftruncate(fd, 0)
        os.pwrite(fd, info + b"\n", 0)
    except OSError:
        pass
    return holder


def acquire_or_exit(data_dir, holder=None):
    """main()'s form of acquire: prints the fixed message and exits 75 (in use) or 78 (cannot establish)."""
    try:
        return acquire(data_dir, holder)
    except InUse:
        print(f"[hive] data directory {data_dir} is in use by another hive process; not starting", file=sys.stderr)
        raise SystemExit(EXIT_IN_USE)
    except Unavailable as exc:
        print(f"[hive] cannot establish exclusive ownership of {data_dir}: {exc.errno_name}; not starting",
              file=sys.stderr)
        raise SystemExit(EXIT_NO_LOCK)


def _ident(path):
    try:
        st = os.stat(path)
    except OSError as exc:
        raise RecoveryRefused(f"{path} cannot be checked: {exc}") from exc
    return st.st_dev, st.st_ino


DB_NAME = "hive.db"   # the data directory's database (Hive opens settings.data_dir / "hive.db")


def bind(holder, hive):
    """Proves that what recovery would rewrite is covered by holder's verified lock (Review FIX-FIRST B1, 3d77e95): the
    database file the open connection actually uses (SQLite's own record of it, not a caller's claim) must be the
    data directory's hive.db, a regular file, not a link, directly inside the locked directory, compared by inode
    identity so a path alias is the same directory and a look-alike is not; and the hive's configured data directory,
    when it has settings, must be that same directory. In-memory, temporary or unverifiable databases are refused."""
    import stat as stat_
    try:
        rows = hive.db._conn.execute("PRAGMA database_list").fetchall()
    except Exception as exc:   # noqa: BLE001
        raise RecoveryRefused(f"the database cannot be identified: {exc}") from exc
    main = next((row[2] for row in rows if row[1] == "main"), "")
    if not main:
        raise RecoveryRefused("the database is in memory or temporary, not in a locked data directory")
    db_file = Path(main)
    if db_file.name != DB_NAME:
        raise RecoveryRefused(f"the database is not a data directory's {DB_NAME}")
    try:
        link = os.lstat(db_file)
    except OSError as exc:
        raise RecoveryRefused(f"the database file cannot be checked: {exc}") from exc
    if not stat_.S_ISREG(link.st_mode):
        raise RecoveryRefused("the database file is not a regular file in the data directory")
    if _ident(db_file.parent) != holder.dir_ident:
        raise RecoveryRefused("the database is not inside the locked data directory")
    settings = getattr(hive, "settings", None)
    if settings is not None and _ident(settings.data_dir) != holder.dir_ident:
        raise RecoveryRefused("the hive's data directory is not the locked data directory")


def _reservations(tx):
    from .cost_reservations import Reservations
    return Reservations.recover_startup(tx)


def _ask_intents(tx):
    from .ask import Ask
    return Ask.recover_startup(tx)


# The fixed order of recovery steps; each takes the open transaction and returns a row count. Step 2 is the Ask intent
# sweep (linkage r3.6 a.4 R2b), inside the same transaction and under the same marker.
def _studio(tx):
    from .studio_sessions import recover_startup
    return recover_startup(tx)


# Step 3 (J3 host R2.2/R3): the Studio plane (studio_sessions.recover_startup): legacy-consent holds, and open steps
# interrupted with their executions fenced.
STEPS = [("reservations", _reservations), ("ask_intents", _ask_intents), ("studio", _studio)]

_once = threading.Lock()


def startup_recovery(holder, hive):
    """The one combined startup recovery. Refuses (raises RecoveryRefused, changing nothing) unless holder verifiably
    holds the lifetime lock for this process and recovery has not been entered in this process before (a failed one
    included: main() exits and the next start retries). Every step runs in one top-level transaction; any failure
    rolls all of them back and leaves holder.recovered false."""
    with _once:
        holder.verify()
        bind(holder, hive)
        if holder.recovered or holder.attempted:
            raise RecoveryRefused("startup recovery already ran in this process")
        db = hive.db
        if db._conn.in_transaction:
            raise RecoveryRefused("startup recovery must be its own transaction")
        holder.attempted = True
        counts = {}
        with db.transaction() as tx:
            for name, step in STEPS:
                counts[name] = int(step(tx) or 0)
        holder.recovered = True
    print("[hive] startup recovery committed: " + ", ".join(f"{k}={v}" for k, v in counts.items()), flush=True)
    return counts
