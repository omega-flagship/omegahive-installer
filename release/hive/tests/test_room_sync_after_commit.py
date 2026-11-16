"""A mind or swarm change inside a transaction syncs the rooms after that transaction commits, never inside it.
The room syncs take their own locks (the team-room lock, the Coffee Room lock) and then the database. A model refresh
holds the database and updates a mind, and the update syncs the rooms; doing that inside the transaction froze full
test runs twice: one thread held a room lock and waited for the database, the other held the database and waited for
the room lock."""
import threading
import time

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_a_team_sync_inside_a_transaction_waits_for_the_commit(client):
    hive = client.app.state.hive
    holder_done, inside_done = threading.Event(), threading.Event()

    def holder():                          # like sync_team: the team-room lock first, then the database
        with hive.rooms._team_lock, hive.db.transaction():
            pass
        holder_done.set()

    def inside():                          # like a model refresh: a transaction, then a mind update's room syncs
        with hive.db.transaction():
            threading.Thread(target=holder, daemon=True).start()
            time.sleep(0.3)                # the holder now has the team-room lock and waits for the database
            hive._coffee_sync()            # must not take a room lock in here
            hive._team_sync()
        inside_done.set()

    threading.Thread(target=inside, daemon=True).start()
    assert inside_done.wait(5), "a room sync inside a transaction waited for a room lock"
    assert holder_done.wait(5), "the room-lock holder never got the database"


def test_outside_a_transaction_the_sync_still_runs_at_once(client):
    hive = client.app.state.hive
    calls = []
    real = hive.rooms.sync_teams
    hive.rooms.sync_teams = lambda: calls.append("teams") or real()
    try:
        hive._team_sync()
        assert calls == ["teams"]
        with hive.db.transaction():
            hive._team_sync()
            assert calls == ["teams"]     # queued, not run, while the transaction is open
        assert calls == ["teams", "teams"]  # run once it committed
    finally:
        hive.rooms.sync_teams = real
