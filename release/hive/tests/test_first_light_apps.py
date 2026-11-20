"""First Light's greeting note names the apps the everyday menus offer, the list a mind's own Open in... shows and opens
in its swarm, named as people see them: switched on and not a test app, Create as Create. A tester's fresh hive named
Studio, whose canvas said the hive offers no live drawing (20 Nov). Synthetic people and apps only."""

import logging

from hive.core import my_apps, onboarding
from hive.tests.test_first_light import hive_app  # noqa: F401  (the real hive, PeTTa and all)
from hive.tests.test_personal_mind import _person


def test_the_greeting_names_the_apps_the_everyday_menus_offer_and_no_test_fixture(hive_app):  # noqa: F811
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    listed = {p["id"]: p for p in hive.programs.list()}
    assert listed["commons-explorer"]["enabled"] and not listed["commons-explorer"].get("test")
    assert listed["contract-fixture"]["enabled"] and listed["contract-fixture"]["test"]
    named = hive.onboarding._apps_on()
    assert "Commons Explorer" in named and "Contract fixture" not in named
    assert named == [p["name"] for p in listed.values() if p["enabled"] and not p.get("test")][:12]
    # and the hello's note to their mind says so
    assert c.post("/api/me/personal-mind/hello", headers=ana).status_code == 200
    mind = hive.personal.mind_row(f"user:{ana_id}")
    notes = hive.db.all("SELECT text FROM messages WHERE agent_id = ? AND direction = 'in'", (mind["id"],))
    assert len(notes) == 1 and "Apps they can use now: " in notes[0]["text"]
    assert "Commons Explorer" in notes[0]["text"] and "Contract fixture" not in notes[0]["text"]


class Makers:
    def __init__(self, on, ready):
        self.on, self.ready = on, ready

    def enabled(self):
        return self.on

    def template_ready(self):
        return self.ready


class Programs:
    def __init__(self, rows, broken=False):
        self.rows, self.broken = rows, broken

    def list(self):
        if self.broken:
            raise RuntimeError("an app failed to load")
        return self.rows


class Hive:
    def __init__(self, programs, makers):
        self.programs, self.studio_makers = programs, makers


def apps_on(rows, makers, broken=False):
    ob = onboarding.Onboarding.__new__(onboarding.Onboarding)
    ob.hive = Hive(Programs(rows, broken), makers)
    return ob._apps_on()


ROWS = [{"id": my_apps.CREATE, "name": "Studio", "enabled": True},
        {"id": "notes", "name": "Notes", "enabled": True},
        {"id": "off", "name": "Switched Off", "enabled": False},
        {"id": "fixture", "name": "Contract fixture", "enabled": True, "test": True}]


def test_create_is_named_create_and_the_note_says_when_its_live_drawing_is_off():
    assert apps_on(ROWS, Makers(True, True)) == ["Create", "Notes"]
    off = ["Create (its live drawing is off on this hive)", "Notes"]
    # off as the Ask's capabilities are: Studio sessions off, members' makers not set up, or no Studio at all
    assert apps_on(ROWS, Makers(False, True)) == off
    assert apps_on(ROWS, Makers(True, False)) == off
    assert apps_on(ROWS, None) == off
    assert apps_on(ROWS[1:], Makers(False, False)) == ["Notes"]
    assert len(apps_on([{"id": f"a{i}", "name": f"A{i}", "enabled": True} for i in range(20)], None)) == 12


def test_apps_that_fail_to_list_never_stop_a_hello_and_the_log_says_why(caplog):
    with caplog.at_level(logging.ERROR, logger="hive"):
        assert apps_on(ROWS, None, broken=True) == []
    assert "could not be listed" in caplog.text and "an app failed to load" in caplog.text


def test_the_note_names_the_usable_apps_as_usable_and_leaves_the_line_out_without_them():
    ob = onboarding.Onboarding.__new__(onboarding.Onboarding)
    assert "Apps they can use now: Create, Notes." in ob.note("Ana", None, ["Create", "Notes"])
    assert "Apps" not in ob.note("Ana", None, [])
