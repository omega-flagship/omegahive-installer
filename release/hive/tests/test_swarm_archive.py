"""Archiving a swarm with history (the owner, 2026-10-05: retire the old Apps local swarm)."""
import threading

from hive.tests.test_core_api import client  # noqa: F401  (fixture: local operator, admin)


def test_a_swarm_with_history_archives_and_restores_without_losing_anything(client):
    sw = client.post("/api/swarms", json={"name": "Old apps"}).json()
    goal = client.post(f"/api/swarms/{sw['id']}/goals", json={"title": "history"}).json()
    assert client.delete(f"/api/swarms/{sw['id']}").status_code == 409            # history: cannot delete
    r = client.post(f"/api/swarms/{sw['id']}/archive")
    assert r.status_code == 200 and r.json()["archived_at"]
    assert sw["id"] not in {s["id"] for s in client.get("/api/swarms").json()}    # hidden by default
    assert sw["id"] in {s["id"] for s in client.get("/api/swarms?archived=1").json()}
    assert client.get(f"/api/goals/{goal['id']}").status_code == 200              # history kept
    r = client.post(f"/api/swarms/{sw['id']}/restore")
    assert r.status_code == 200 and r.json()["archived_at"] is None
    assert sw["id"] in {s["id"] for s in client.get("/api/swarms").json()}


def test_a_swarm_with_an_awake_mind_cannot_be_archived(client):
    sw = client.post("/api/swarms", json={"name": "Busy"}).json()
    hive = client.app.state.hive
    mind = hive.create_agent("Busy mind", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.db.update("agents", mind["id"], {"status": "awake"})
    r = client.post(f"/api/swarms/{sw['id']}/archive")
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_busy"


def test_an_archived_swarm_is_retired_not_just_hidden(client):
    """Kimi 2026-10-05: nothing new starts, joins or is asked there, and a boot never wakes its minds."""
    import asyncio
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Retired"}).json()
    mind = hive.create_agent("Sleeper", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert client.post(f"/api/swarms/{sw['id']}/archive").status_code == 200
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.create_agent("New", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    assert e.value.code == "swarm_archived"
    r = client.post(f"/api/swarms/{sw['id']}/goals", json={"title": "new work"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_archived"
    with pytest.raises(HiveError) as e:
        hive.require_open_swarm(sw["id"])
    hive.db.update("agents", mind["id"], {"desired": "awake"})       # left wanting to wake before the hive stopped
    class Sup:
        started = []
        def start(self, agent_id): self.started.append(agent_id)
    hive.supervisor = Sup()
    asyncio.run(hive.restore())
    assert mind["id"] not in Sup.started and hive._agent_row(mind["id"])["desired"] == "asleep"


def test_a_mind_that_wants_to_wake_blocks_archiving(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Pending"}).json()
    mind = hive.create_agent("Pending", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.db.update("agents", mind["id"], {"desired": "awake", "status": "stopped"})
    r = client.post(f"/api/swarms/{sw['id']}/archive")
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_busy"


def test_only_admins_see_archived_swarms(client):
    from hive.tests.test_visibility import person
    sw = client.post("/api/swarms", json={"name": "Old"}).json()
    client.post(f"/api/swarms/{sw['id']}/archive")
    headers = person(client, "u_member")
    assert client.get("/api/swarms?archived=1", headers=headers).status_code == 403


def test_no_route_brings_new_work_or_members_into_an_archived_swarm(client):
    """Kimi 2026-10-05 re-check: moving a mind in, asking it for work, or inviting a harness are all refused."""
    hive = client.app.state.hive
    home = client.post("/api/swarms", json={"name": "Home"}).json()
    old = client.post("/api/swarms", json={"name": "Old"}).json()
    mind = hive.create_agent("Mover", "omega", home["id"], "mock/echo", "", None, 0, None, None)
    assert client.post(f"/api/swarms/{old['id']}/archive").status_code == 200
    r = client.patch(f"/api/agents/{mind['id']}", json={"swarm_id": old["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_archived"
    r = client.post("/api/harness-invites", json={"harness": "claude-code", "name": "Late", "swarm_id": old["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_archived"
    import pytest
    from hive.core.hive import HiveError
    hive.collab.set_services(old["id"], ["plan-check"], "test")
    goal = client.post(f"/api/swarms/{home['id']}/goals", json={"title": "mine"}).json()
    hive.db.update("goals", goal["id"], {"status": "claimed", "claimed_by": mind["id"]})
    import asyncio
    with pytest.raises(HiveError) as e:
        asyncio.run(hive.collab.create_request(hive._agent_row(mind["id"]), {"kind": "plan-check", "to_swarm": old["id"], "title": "t", "from_goal": goal["id"]}))
    assert e.value.code == "swarm_archived"


def test_moving_a_mind_is_enforced_by_the_host(client):
    """Kimi 2026-10-05: destination visibility and a stopped mind are host rules, not UI promises."""
    from hive.tests.test_visibility import person
    hive = client.app.state.hive
    open_sw = client.post("/api/swarms", json={"name": "Open", "visibility": "public"}).json()
    secret = client.post("/api/swarms", json={"name": "Secret", "visibility": "private"}).json()
    member = person(client, "u_mover")
    mind = hive.create_agent("Movable", "omega", open_sw["id"], "mock/echo", "", None, 0, None, None,
                             owner="user:u_mover", visibility="public")
    r = client.patch(f"/api/agents/{mind['id']}", json={"swarm_id": secret["id"]}, headers=member)
    assert r.status_code in (403, 404)                                  # a swarm the member cannot see
    other = client.post("/api/swarms", json={"name": "Other", "visibility": "public"}).json()
    hive.db.update("agents", mind["id"], {"status": "awake"})
    r = client.patch(f"/api/agents/{mind['id']}", json={"swarm_id": other["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mind_running"
    hive.db.update("agents", mind["id"], {"status": "stopped"})
    assert client.patch(f"/api/agents/{mind['id']}", json={"swarm_id": other["id"]}).status_code == 200


def test_a_running_flow_blocks_archiving(client):
    """Kimi round 3: work already running would keep writing into a retired swarm."""
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Flowing"}).json()
    hive.flows   # ensure the flow tables exist
    hive.db.execute("INSERT INTO flow_runs (id, artifact_id, revision, digest, swarm_id, actor, session_hash, client_key, status, created_at, updated_at) "
                    "VALUES ('fr_1','art',1,'d',?,'user:x','h','k','running','t','t')", (sw["id"],))
    r = client.post(f"/api/swarms/{sw['id']}/archive")
    assert r.status_code == 409 and "flow" in r.json()["error"]["message"]


def test_archive_and_start_are_atomic_either_way_round(client):
    """OmegaReview 2026-10-05: the start reservation is one conditional write, so whichever commits first wins."""
    hive = client.app.state.hive
    launched = []

    class Sup:
        drivers = {}
        def prepare(self, agent, token): pass
        def start(self, agent_id): launched.append(agent_id)
        def lock(self, agent_id): return threading.RLock()
    hive.supervisor = Sup()
    a = client.post("/api/swarms", json={"name": "Start first"}).json()
    m1 = hive.create_agent("First", "omega", a["id"], "mock/echo", "", None, 0, None, None)
    hive.lifecycle(m1["id"], "start")                                     # reservation lands first
    r = client.post(f"/api/swarms/{a['id']}/archive")
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_busy"
    b = client.post("/api/swarms", json={"name": "Archive first"}).json()
    m2 = hive.create_agent("Second", "omega", b["id"], "mock/echo", "", None, 0, None, None)
    assert client.post(f"/api/swarms/{b['id']}/archive").status_code == 200   # archive lands first
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.lifecycle(m2["id"], "start")
    assert e.value.code == "swarm_archived"
    assert launched == [m1["id"]] and hive._agent_row(m2["id"])["status"] != "starting"


def test_the_reservation_itself_refuses_a_retired_swarm(client):
    """The write carries the condition: even if the archive commits after every earlier read, nothing launches."""
    hive = client.app.state.hive
    launched = []

    class Sup:
        drivers = {}
        def prepare(self, agent, token): pass
        def start(self, agent_id): launched.append(agent_id)
        def lock(self, agent_id): return threading.RLock()
    hive.supervisor = Sup()
    sw = client.post("/api/swarms", json={"name": "Late"}).json()
    m = hive.create_agent("Late", "omega", sw["id"], "mock/echo", "", None, 0, None, None)
    hive.db.execute("UPDATE swarms SET archived_at = 'now' WHERE id = ?", (sw["id"],))   # archive slips in after reads
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError):
        hive.lifecycle(m["id"], "start")
    assert launched == [] and hive._agent_row(m["id"])["status"] != "starting"


def test_a_flow_run_row_cannot_land_in_an_archived_swarm(client):
    """Kimi 2026-10-05: the flow run insert itself carries the open-swarm condition."""
    import pytest
    from hive.core.hive import HiveError
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "No flows"}).json()
    hive.flows
    hive.db.execute("UPDATE swarms SET archived_at = 'now' WHERE id = ?", (sw["id"],))
    run = {"id": "fr_x", "artifact_id": "a", "revision": 1, "digest": "d", "swarm_id": sw["id"], "actor": "user:x",
           "session_hash": "h", "client_key": "k9", "status": "running", "reason": None, "created_at": "t", "updated_at": "t"}
    with pytest.raises(HiveError) as e:
        hive.insert_into_open_swarm("flow_runs", run, sw["id"])
    assert e.value.code == "swarm_archived"
    assert hive.db.one("SELECT 1 FROM flow_runs WHERE id = 'fr_x'") is None
def test_a_wedged_run_whose_work_has_ended_does_not_block_archiving(client):
    """Kimi 2026-10-05: only a run with live step goals blocks archiving."""
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Wedged"}).json()
    hive.flows
    goal = client.post(f"/api/swarms/{sw['id']}/goals", json={"title": "step"}).json()
    hive.db.update("goals", goal["id"], {"status": "done"})
    hive.db.execute("INSERT INTO flow_runs (id, artifact_id, revision, digest, swarm_id, actor, session_hash, client_key, status, created_at, updated_at) "
                    "VALUES ('fr_w','art',1,'d',?,'user:x','h','k2','running','t','t')", (sw["id"],))
    hive.db.execute("INSERT INTO flow_steps (run_id, transition_id, goal_id, status, binding) VALUES ('fr_w','t1',?,'done','{}')", (goal["id"],))
    assert client.post(f"/api/swarms/{sw['id']}/archive").status_code == 200
