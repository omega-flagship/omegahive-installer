"""Surface audit 20 (2026-10-05): a reserved, not yet sent call is not 'stuck' at once; the panel gets hold age,
auto-settle time and whether a person may resolve now."""
import time

import pytest

from hive.core.cost_reservations import Reservations, UNKNOWN_EXPIRY_SECONDS, STALE_SECONDS, outstanding, resolve
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def book(client, key, dispatched=False):
    r = Reservations(client.app.state.hive.db)
    r.reserve(key, {"p": key}, 0.01, lambda: [("hive", 10.0, 0.0)], metadata={"agent": "a_x"}, dispatched=dispatched)
    return r


def test_a_just_reserved_call_cannot_be_released_before_it_is_sent(client):
    r = book(client, "k-fresh")
    with pytest.raises(ValueError):
        resolve(r, "k-fresh", "release", "looks stuck", "user:operator")
    db = client.app.state.hive.db
    db.execute("UPDATE cost_reservations SET reserved_at = ? WHERE id = 'k-fresh'", (time.time() - STALE_SECONDS - 5,))
    assert resolve(r, "k-fresh", "release", "really stuck", "user:operator")      # long-stuck: now resolvable


def test_the_panel_sees_hold_age_auto_settle_and_resolvability(client):
    r = book(client, "k-sent", dispatched=True)
    r.unknown("k-sent")
    row = next(x for x in outstanding(r) if x["id"] == "k-sent")
    assert row["state"] == "unknown" and row["resolvable"] is True and row["dispatched_at"] and row["unknown_at"]
    assert row["auto_settles_at"] == pytest.approx(row["unknown_at"] + UNKNOWN_EXPIRY_SECONDS)
    book(client, "k-wait")
    waiting = next(x for x in outstanding(r) if x["id"] == "k-wait")
    assert waiting["resolvable"] is False and waiting["dispatched_at"] is None and waiting["auto_settles_at"] is None
