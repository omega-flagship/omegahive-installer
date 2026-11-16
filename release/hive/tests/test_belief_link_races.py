"""Purpose: test that a mind's read grants end as its link setting and its membership say, however a change to its link,
its visibility or its swarm interleaves with another. A review of #354 found two interleavings: a change that has read
the mind's row and membership but not yet linked, while a move takes the mind out of its swarm or a second change turns
its link off. Each test pauses the first change inside spaces.link, after its reads, and runs the second meanwhile."""

import re
import threading

from hive.tests.test_belief_links import pytestmark, team  # noqa: F401  (pytestmark: needs PeTTa)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


class Interleaving:
    """Pauses the first spaces.link made after it is armed until released, and notes when any later spaces.link runs."""

    def __init__(self, hive, monkeypatch):
        self.paused, self.entered, self.release = threading.Event(), threading.Event(), threading.Event()
        real, calls, guard = hive.spaces.link, [], threading.Lock()

        def link(agent_id, swarm_id, patterns):
            with guard:
                calls.append((agent_id, swarm_id))
                first = len(calls) == 1
            if first:
                self.paused.set()
                assert self.release.wait(30), "never released"
            else:
                self.entered.set()
            return real(agent_id, swarm_id, patterns)
        monkeypatch.setattr(hive.spaces, "link", link)

    def run(self, first, second):
        """first runs until its spaces.link pauses; then second runs and, when nothing holds it back, links while first
        is paused and finishes; then first goes on. Both must end without raising.

        Time: one wait of two seconds when something holds second back, none otherwise."""
        errors = []

        def guarded(fn):
            def run():
                try:
                    fn()
                except BaseException as exc:   # re-raised below in the test's own thread
                    errors.append(exc)
            return run
        t1 = threading.Thread(target=guarded(first))
        t1.start()
        assert self.paused.wait(30), "the first change never reached spaces.link"
        t2 = threading.Thread(target=guarded(second))
        t2.start()
        if self.entered.wait(2):   # nothing serializes the two: second links while first is paused
            t2.join(30)
        self.release.set()
        t1.join(30)
        t2.join(30)
        assert not t1.is_alive() and not t2.is_alive() and not errors, errors


def put_ok(client, path, body):
    r = client.put(path, json=body)
    assert r.status_code == 200, r.text


def test_a_link_turned_off_while_another_change_is_linking_stays_off(client, monkeypatch):
    """The owner sets the mind's link to sky and, at once, turns it off. Whichever lands last, the read grants end as the
    stored setting says, never sky with the setting off."""
    hive = client.app.state.hive
    swarm, (a, _) = team(client)
    race = Interleaving(hive, monkeypatch)
    race.run(lambda: put_ok(client, f"/api/agents/{a['id']}/belief-link", {"domains": ["sky"]}),
             lambda: hive.set_belief_link(a["id"], {"domains": []}, hive_viewer()))
    row = hive._agent_row(a["id"])
    assert canon(hive.spaces.links(a["id"], swarm["id"])) == canon(hive.link_patterns(row)), (row["belief_link"],)


def test_a_mind_moved_while_its_link_widens_keeps_no_grant_in_its_old_swarm(client, monkeypatch):
    """The owner links all of a private mind's beliefs while the mind moves to another swarm: its old swarm keeps no read
    grant for a mind that is no longer its member, and its new swarm gets what the link says."""
    hive = client.app.state.hive
    old, (a, _) = team(client, visibility="private")
    new = client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()
    race = Interleaving(hive, monkeypatch)
    race.run(lambda: put_ok(client, f"/api/agents/{a['id']}/belief-link", {"domains": "all"}),
             lambda: hive.update_agent(a["id"], {"swarm_id": new["id"]}))
    moved(hive, a, old, new)


def test_a_mind_moved_while_its_visibility_widens_keeps_no_grant_in_its_old_swarm(client, monkeypatch):
    """The same through the visibility route: a private mind made public links all its beliefs by default, while it
    moves to another swarm."""
    hive = client.app.state.hive
    old, (a, _) = team(client, visibility="private")
    new = client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()
    race = Interleaving(hive, monkeypatch)
    race.run(lambda: put_ok(client, f"/api/agents/{a['id']}/visibility", {"visibility": "public"}),
             lambda: hive.update_agent(a["id"], {"swarm_id": new["id"]}))
    moved(hive, a, old, new)


def moved(hive, mind, old, new):
    row = hive._agent_row(mind["id"])
    assert row["swarm_id"] == new["id"] and not hive.spaces.is_member(mind["id"], old["id"])
    assert hive.spaces.links(mind["id"], old["id"]) == [], "a stale read grant in the swarm the mind left"
    assert canon(hive.spaces.links(mind["id"], new["id"])) == canon(hive.link_patterns(row))


def canon(patterns):
    """Patterns with each variable named by its first place, as the space reads a stored $stmt back as $_0."""
    def one(pattern):
        names = {}
        return re.sub(r"\$[A-Za-z0-9_]+", lambda m: names.setdefault(m.group(0), f"$v{len(names)}"), pattern)
    return sorted(one(p) for p in patterns)


def hive_viewer():
    from hive.core.visibility import Viewer
    return Viewer("user:operator", True)
