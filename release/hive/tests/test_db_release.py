"""A Database that nobody holds any more closes its connection and file handles.

SQLite keeps the agent-namespace callback in C, where the garbage collector cannot see a cycle; a strong reference
from that callback back to the Database kept every one open for the life of the process (a long test run hit the
per-process open-file limit). The callback must hold the Database only weakly, and must still count identity writes.
"""
import gc
import weakref

from hive.core.db import Database


def test_a_dropped_database_is_freed(tmp_path):
    db = Database(tmp_path / "hive.db")
    ref = weakref.ref(db)
    del db
    gc.collect()
    assert ref() is None


def test_identity_writes_still_move_the_namespace_revision(tmp_path):
    db = Database(tmp_path / "hive.db")
    before = db._agent_namespace_epoch
    db._conn.execute("CREATE TEMP TABLE probe_rows (x)")      # an unrelated write leaves it alone
    assert db._agent_namespace_epoch == before
    db._conn.execute("SELECT hive_agent_names_changed()")
    assert db._agent_namespace_epoch == before + 1
