"""An app's home in a person's own private swarm is theirs whatever made it a home, so the app page can open the app
there by itself: a tester's own swarm, where Commons Explorer had run from their mind's panel, read as a home they could
not use (20 Nov). Synthetic people and swarms."""

from hive.tests.test_first_light import hive_app  # noqa: F401  (the real hive, PeTTa and all)
from hive.tests.test_personal_mind import _person


def test_a_home_in_the_persons_own_private_swarm_is_marked_own_whatever_made_it(hive_app):  # noqa: F811
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    own_swarm = next(s["id"] for s in hive.swarms() if s["visibility"] == "private" and s["owner"] == principal)
    shared = next(s["id"] for s in hive.swarms() if s["visibility"] == "public")
    visible = {own_swarm, shared}
    # an activation in their own swarm
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 1, ?)", ("commons-explorer", own_swarm, "user:operator"))
    assert hive.programs.homes("commons-explorer", visible, principal) == [{"swarm_id": own_swarm, "why": "activated here", "own": True}]
    # an earlier open there, the way their mind's panel leaves one (the contract fixture: a second app this line's hive
    # loads, where main's has Evolve)
    hive.db.execute("INSERT INTO program_homes (program, swarm, last_ok) VALUES (?, ?, ?)", ("contract-fixture", own_swarm, "2026-11-20T00:00:00Z"))
    assert hive.programs.homes("contract-fixture", visible, principal) == [{"swarm_id": own_swarm, "why": "opened here before", "own": True}]
    # an admin who can see their swarm gets the home, never the mark, and so does a call naming no one
    assert hive.programs.homes("commons-explorer", visible, "user:operator") == [{"swarm_id": own_swarm, "why": "activated here"}]
    assert hive.programs.homes("commons-explorer", visible) == [{"swarm_id": own_swarm, "why": "activated here"}]
    # a swarm someone else owns is never their own, an activation there included
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 1, ?)", ("contract-fixture", shared, "user:operator"))
    assert {h["swarm_id"]: h.get("own") for h in hive.programs.homes("contract-fixture", visible, principal)} == {shared: None, own_swarm: True}
