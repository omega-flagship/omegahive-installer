# Purpose: tests that the hive's own notice to a person is a kind of its own from no mind, never uses one of their daily
# pop-ups, waits through quiet hours for the digest like any other notice, and reaches only a current person.
"""The hive's own notice to a person (Notices.from_hive): what the hive itself has to tell someone, such as a day's
estimated calls or a limit they are nearing, through the notices they already read. Invented people, no minds."""
import datetime

import pytest

from hive.tests.test_core_api import client  # noqa: F401  (fixture)

UTC = datetime.timezone.utc
PERSON = "u_0c1d2e3f"


def _person(hive, role="member"):
    hive.db.execute("INSERT INTO people (id, email, role, created_at) VALUES (?, ?, ?, ?)",
                    (PERSON, f"{PERSON}@example.com", role, "2026-11-01T00:00:00.000Z"))


def test_the_hives_notice_is_its_own_kind_and_never_uses_a_pop_up(client):
    hive = client.app.state.hive
    _person(hive)
    hive.notices.set_prefs("user:" + PERSON, {"cap": 0, "quiet_start": None, "quiet_end": None})
    out = hive.notices.from_hive("user:" + PERSON, "Yesterday, 3 calls were estimated at $0.15.")
    assert out["state"] == "delivered"                       # a cap of 0 holds every counted notice; this one isn't counted
    row = hive.db.one("SELECT kind, agent_id, swarm_id, counted FROM notices WHERE id = ?", (out["id"],))
    assert (row["kind"], row["agent_id"], row["swarm_id"], row["counted"]) == ("hive", None, None, 0)
    listed = hive.notices.list("user:" + PERSON)["notices"]
    assert [(n["kind"], n["from"], n["text"]) for n in listed] == [("hive", None, "Yesterday, 3 calls were estimated at $0.15.")]


def test_quiet_hours_hold_it_for_the_digest(client):
    hive = client.app.state.hive
    _person(hive)
    night = datetime.datetime(2026, 11, 12, 3, 0, tzinfo=UTC)
    hive.notices.clock = lambda: night                        # default quiet hours: 21:00 to 07:00 in UTC
    out = hive.notices.from_hive("user:" + PERSON, "a line from the hive")
    assert out == {"id": out["id"], "state": "held", "held": "quiet"}
    hive.notices.clock = lambda: night.replace(hour=7, minute=30)
    hive.notices.sweep()
    (digest,) = hive.notices.list("user:" + PERSON)["notices"]
    assert digest["kind"] == "digest" and [(i["kind"], i["text"]) for i in digest["items"]] == [("hive", "a line from the hive")]


def test_only_a_current_person_gets_one_and_its_text_is_checked(client):
    hive = client.app.state.hive
    _person(hive)
    with pytest.raises(Exception) as empty:
        hive.notices.from_hive("user:" + PERSON, "   ")
    assert getattr(empty.value, "status", None) == 400
    hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", (PERSON,))
    for principal in ("user:" + PERSON, "user:operator", "user:u_99999999"):
        with pytest.raises(Exception) as refused:
            hive.notices.from_hive(principal, "a line from the hive")
        assert getattr(refused.value, "status", None) == 403
    assert hive.db.one("SELECT COUNT(*) AS n FROM notices")["n"] == 0
