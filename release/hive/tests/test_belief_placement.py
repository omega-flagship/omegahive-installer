"""Purpose: a mind brought in from another hive links its beliefs into the swarm it arrives in, as its row there says, at
once and with no restart, as a mind moved within a hive does; an arrival that fails after joining leaves no grant, link
or loaded belief behind."""

import pytest

from hive.tests.test_belief_links import SKY, SKY_STMT, found, hold, pytestmark  # noqa: F401
from hive.tests.test_placement import client, home  # noqa: F401  (fixtures: two hives)


def arrival(client, home):
    """Ada, a public mind holding SKY in a public swarm of one hive, exported; Bo, a public mind of a public swarm of
    the other hive, which she is about to join."""
    swarm = client.post("/api/swarms", json={"name": "Family", "visibility": "public"}).json()
    ada = client.post("/api/agents", json={"name": "Ada", "kind": "omega", "swarm_id": swarm["id"],
                                           "visibility": "public"}).json()
    hold(client, ada, SKY)
    bundle = client.post(f"/api/agents/{ada['id']}/export")
    assert bundle.status_code == 200, bundle.text
    there = home.post("/api/swarms", json={"name": "Home", "visibility": "public"}).json()
    bo = home.post("/api/agents", json={"name": "Bo", "kind": "omega", "swarm_id": there["id"],
                                        "visibility": "public"}).json()
    return ada, bundle.content, there, bo


def test_a_mind_brought_in_links_its_beliefs_into_its_new_swarm_at_once(client, home):
    ada, bundle, there, bo = arrival(client, home)
    assert found(home, bo, f"(Held $m {SKY_STMT} $t $st)") == []
    arrived = home.post(f"/api/agents/import?swarm_id={there['id']}", content=bundle)
    assert arrived.status_code == 200, arrived.text
    assert found(home, bo, f"(Held $m {SKY_STMT} $t $st)") == [
        f"(Held {ada['id']} {SKY_STMT} (stv 1.0 0.9) ((ev {ada['id']} 1)))"]


def test_an_arrival_that_fails_after_joining_leaves_no_link_behind(client, home, monkeypatch):
    ada, bundle, there, bo = arrival(client, home)
    hive = home.app.state.hive
    join = hive.join_commons

    def join_then_fail(agent_id, swarm_id):
        join(agent_id, swarm_id)
        raise RuntimeError("the arrival fails after joining")
    monkeypatch.setattr(hive, "join_commons", join_then_fail)
    with pytest.raises(RuntimeError, match="after joining"):
        home.post(f"/api/agents/import?swarm_id={there['id']}", content=bundle)
    assert not hive.spaces.is_member(ada["id"], there["id"]) and hive.spaces.links(ada["id"], there["id"]) == []
    assert found(home, bo, "(Held $m $s $t $st)") == []
    assert hive.db.all("SELECT * FROM held_stamps WHERE agent_id = ?", (ada["id"],)) == []
    assert hive.db.one("SELECT 1 FROM agents WHERE id = ?", (ada["id"],)) is None
