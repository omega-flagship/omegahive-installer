"""The Coffee Room's sync takes the database lock before its own lock, like every caller that is already inside a
transaction (a model refresh updates a mind, and that update ends with a Coffee Room sync). The reverse order froze a
full test run: one thread held the Coffee lock and waited for the database, the other held the database and waited
for the Coffee lock."""
import threading
import time

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_a_sync_inside_a_transaction_and_a_plain_sync_both_finish(client):
    hive = client.app.state.hive
    hive.rooms.ensure_coffee()
    plain_done, inside_done = threading.Event(), threading.Event()

    def plain():                          # an ordinary sync with no transaction of its own (e.g. a mind being created)
        hive.rooms.sync_coffee()
        plain_done.set()

    def inside():                         # like a model refresh: a transaction, then the mind update's sync inside it
        with hive.db.transaction():
            threading.Thread(target=plain, daemon=True).start()
            time.sleep(0.3)               # the plain sync is now waiting (with the old order, holding the Coffee lock)
            hive.rooms.sync_coffee()
        inside_done.set()

    threading.Thread(target=inside, daemon=True).start()
    assert inside_done.wait(5), "the sync inside a transaction waited for ever on the Coffee Room lock"
    assert plain_done.wait(5), "the plain sync never finished"
