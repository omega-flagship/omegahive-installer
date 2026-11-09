from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_only_an_empty_swarm_can_be_deleted(client):
    empty = client.post("/api/swarms", json={"name": "Probe"}).json()
    swarm, (a, _b) = make_swarm_and_agents(client)
    busy = client.delete(f"/api/swarms/{swarm['id']}")
    assert busy.status_code == 409 and busy.json()["error"]["code"] == "swarm_not_empty"
    assert client.delete(f"/api/swarms/{empty['id']}").json() == {"deleted": empty["id"]}
    assert client.get(f"/api/swarms/{empty['id']}").status_code == 404


# ---- delete with its minds (Jon 2026-10-07: a warning, not a lock) ------------------------------------------------

def _delete(client, swarm_id, payload=None, **kw):
    return client.request("DELETE", f"/api/swarms/{swarm_id}", json=payload, **kw)


def _alive(hive, swarm_id):
    return [r["id"] for r in hive.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,))]


def test_the_default_refusal_counts_what_is_there_and_offers_with_minds(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    r = client.delete(f"/api/swarms/{swarm['id']}")
    err = r.json()["error"]
    assert r.status_code == 409 and err["code"] == "swarm_not_empty"
    assert err["counts"]["minds"] == 2 and err["with_minds"] is True
    assert err["message"] == "only an empty swarm can be deleted; this one has 2 minds"   # the UI words it from this
    assert "with_minds" in err["hint"]
    assert len(_alive(client.app.state.hive, swarm["id"])) == 2                     # nothing changed
    # a body without with_minds is the default too
    assert _delete(client, swarm["id"], {"confirm": "Alpha"}).json()["error"]["code"] == "swarm_not_empty"


def test_a_wrong_or_missing_confirm_is_refused_and_changes_nothing(client):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    hive.db.update("agents", a["id"], {"status": "awake", "desired": "awake"})
    for payload in ({"with_minds": True}, {"with_minds": True, "confirm": "alpha"}, {"with_minds": True, "confirm": "Alpha "}):
        r = _delete(client, swarm["id"], payload)
        assert r.status_code == 400 and r.json()["error"]["code"] == "confirm_mismatch"
    assert len(_alive(hive, swarm["id"])) == 2
    assert hive._agent_row(a["id"])["status"] == "awake"
    assert ("stop", a["id"]) not in client.supervisor.calls
    assert hive.swarm(swarm["id"])["archived_at"] is None


def test_an_empty_history_swarm_is_deleted_with_its_minds_awake_ones_stopped_first(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    hive.db.update("agents", a["id"], {"status": "awake", "desired": "awake"})
    seen = []
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (seen.append((kind, kw)), original(kind, **kw)))
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted_minds": [a["id"], b["id"]], "swarm": "deleted", "released_tasks": 0}
    calls = client.supervisor.calls
    assert calls.count(("stop", a["id"])) == 2 and calls.count(("stop", b["id"])) == 1   # awake one: stop path, then delete
    assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (a["id"],))["deleted"] == 1
    assert client.get(f"/api/swarms/{swarm['id']}").status_code == 404
    kinds = [k for k, _ in seen]
    assert kinds.count("agent.deleted") == 2 and kinds.count("swarm.deleted") == 1 and kinds[-1] == "swarm.deleted"
    assert {kw["agent_id"] for k, kw in seen if k == "agent.deleted"} == {a["id"], b["id"]}


def test_an_unstoppable_mind_refuses_everything(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    hive.db.update("agents", a["id"], {"status": "awake", "desired": "awake"})
    stop = client.supervisor.stop
    def stubborn(agent_id):
        if agent_id == a["id"]:
            raise RuntimeError("process will not die")
        stop(agent_id)
    client.supervisor.stop = stubborn
    try:
        r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    finally:
        client.supervisor.stop = stop
    err = r.json()["error"]
    assert r.status_code == 409 and err["code"] == "minds_unstoppable"
    assert [f["id"] for f in err["failed"]] == [a["id"]] and "Dot0" in err["message"]
    assert len(_alive(hive, swarm["id"])) == 2                                       # nothing deleted
    assert hive.swarm(swarm["id"])["archived_at"] is None                            # nor archived


def test_with_history_the_swarm_is_archived_and_the_history_kept(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "history"}).json()
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted_minds": [a["id"], b["id"]], "swarm": "archived", "reason": "it has history (1 task)",
                        "released_tasks": 0}
    assert _alive(hive, swarm["id"]) == []
    assert client.get(f"/api/goals/{goal['id']}").status_code == 200                # history kept
    assert swarm["id"] not in {s["id"] for s in client.get("/api/swarms").json()}    # hidden
    restored = client.post(f"/api/swarms/{swarm['id']}/restore")                   # and restorable
    assert restored.status_code == 200 and restored.json()["archived_at"] is None


def test_a_running_flow_refuses_before_anything_is_stopped(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    hive.db.update("agents", a["id"], {"status": "awake", "desired": "awake"})
    from hive.core.hive import HiveError
    def live(swarm_id):
        raise HiveError(409, "swarm_busy", "a flow is still running here; let it finish or cancel it first")
    monkeypatch.setattr(hive, "_refuse_live_flow", live)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "swarm_busy"
    assert hive._agent_row(a["id"])["status"] == "awake" and len(_alive(hive, swarm["id"])) == 2


def test_child_swarms_of_its_minds_are_kept_and_detached_as_a_single_delete_does(client):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    child = client.post("/api/swarms", json={"name": "Child"}).json()
    hive.db.execute("UPDATE swarms SET parent_mind_id = ? WHERE id = ?", (a["id"], child["id"]))
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.status_code == 200 and r.json()["swarm"] == "deleted" and r.json()["detached_swarms"] == [child["id"]]
    assert client.get(f"/api/swarms/{child['id']}").json()["parent_mind_id"] is None


def test_external_members_are_not_deleted_so_the_swarm_is_archived(client):
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Mixed"}).json()
    mind = client.post("/api/agents", json={"name": "Dot", "swarm_id": swarm["id"]}).json()
    member = client.post("/api/agents", json={"name": "Ext", "kind": "module", "swarm_id": swarm["id"]}).json()
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Mixed"})
    assert r.json() == {"deleted_minds": [mind["id"]], "swarm": "archived", "reason": "it has history (1 external member)", "released_tasks": 0}
    assert _alive(hive, swarm["id"]) == [member["id"]]


def test_only_an_admin_may_delete_with_minds(client):
    from hive.tests.test_visibility import person
    hive = client.app.state.hive
    member = person(client, "u_member")
    private, _ = make_swarm_and_agents(client)
    public = client.post("/api/swarms", json={"name": "Open", "visibility": "public"}).json()
    client.post("/api/agents", json={"name": "Pub", "swarm_id": public["id"]})
    # a private swarm stays unrevealed (404); a visible one is refused as admin-only (403); nothing changes either way
    assert _delete(client, private["id"], {"with_minds": True, "confirm": "Alpha"}, headers=member).status_code == 404
    r = _delete(client, public["id"], {"with_minds": True, "confirm": "Open"}, headers=member)
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
    assert len(_alive(hive, private["id"])) == 2 and len(_alive(hive, public["id"])) == 1


# ---- r2: interleavings (stand-in FIX-FIRST on 065e22d) ---------------------------------------------------------------

def _during_archive(monkeypatch, hive, action):
    """Run action right after the archive fence goes up, inside the operation, as a racing request would."""
    import threading
    real = hive.archive_swarm
    def archive_then(swarm_id, by):
        out = real(swarm_id, by)
        racer = threading.Thread(target=action)   # another request: a thread other than the operation's
        racer.start()
        racer.join(30)
        return out
    monkeypatch.setattr(hive, "archive_swarm", archive_then)


def test_a_mind_cannot_be_moved_out_mid_delete_the_roster_is_frozen(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    from hive.core.hive import HiveError
    seen = []
    def move_out():
        try:
            hive.update_agent(b["id"], {"swarm_id": other["id"]})
        except HiveError as exc:
            seen.append(exc.code)
    _during_archive(monkeypatch, hive, move_out)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert seen == ["swarm_busy"]
    assert r.status_code == 200 and r.json()["deleted_minds"] == [a["id"], b["id"]] and r.json()["swarm"] == "deleted"
    assert _alive(hive, other["id"]) == []


def test_delete_agent_never_deletes_a_mind_outside_the_expected_swarm(client):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.delete_agent(a["id"], expect_swarm=other["id"])
    assert e.value.code == "mind_moved" and _alive(hive, swarm["id"]) == [a["id"], _b["id"]]


def test_a_restore_during_the_delete_is_refused_and_the_fence_holds(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "history"})
    seen = []
    def racing_restore():
        seen.append(client.post(f"/api/swarms/{swarm['id']}/restore"))
    _during_archive(monkeypatch, hive, racing_restore)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert seen[0].status_code == 409 and seen[0].json()["error"]["code"] == "swarm_busy"
    assert r.json()["swarm"] == "archived" and hive.swarm(swarm["id"])["archived_at"]


def test_concurrent_deletes_are_serialized(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    seen = []
    def racing():
        seen.append(_delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}))
        seen.append(client.delete(f"/api/swarms/{swarm['id']}"))
    _during_archive(monkeypatch, hive, racing)
    events = []
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append(kind), original(kind, **kw)))
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert first.status_code == 200 and first.json()["swarm"] == "deleted"
    assert [s.json()["error"]["code"] for s in seen] == ["swarm_busy", "swarm_busy"]
    assert events.count("swarm.deleted") == 1 and events.count("agent.deleted") == 2
    after = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert after.status_code == 404                                                  # a clean not-found once it is gone


def test_unfinished_assignments_are_released_and_claimable_after_restore(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    assigned = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]}).json()
    claimed = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "held by Dot1"}).json()
    assert client.post(f"/api/agent/goals/{claimed['id']}/claim", headers=agent_headers(b)).status_code == 200
    finished = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "done"}).json()
    hive.db.update("goals", finished["id"], {"status": "done", "claimed_by": a["id"], "result": "kept"})
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.status_code == 200 and r.json()["swarm"] == "archived" and r.json()["released_tasks"] == 2
    for gid in (assigned["id"], claimed["id"]):
        row = hive.db.one("SELECT * FROM goals WHERE id = ?", (gid,))
        assert row["status"] == "open" and row["assignee"] is None and row["claimed_by"] is None
        note = hive.db.one("SELECT * FROM goal_reviews WHERE goal_id = ? AND action = 'released'", (gid,))
        assert note and "deleted" in note["notes"]
    done = hive.db.one("SELECT * FROM goals WHERE id = ?", (finished["id"],))
    assert done["status"] == "done" and done["claimed_by"] == a["id"] and done["result"] == "kept"   # history kept
    assert client.post(f"/api/swarms/{swarm['id']}/restore").status_code == 200
    newcomer = client.post("/api/agents", json={"name": "New", "swarm_id": swarm["id"]}).json()
    for gid in (assigned["id"], claimed["id"]):
        got = client.post(f"/api/agent/goals/{gid}/claim", headers=agent_headers(newcomer))
        assert got.status_code == 200 and got.json()["claimed_by"] == newcomer["id"]


def test_a_delete_failure_after_the_archive_is_a_structured_answer_and_a_retry_finishes(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    stop = client.supervisor.stop
    def failing(agent_id):
        if agent_id == b["id"]:
            raise RuntimeError("disk busy")
        stop(agent_id)
    client.supervisor.stop = failing
    try:
        r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    finally:
        client.supervisor.stop = stop
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["swarm"] == "archived" and body["deleted_minds"] == [a["id"]] and body["remaining_minds"] == [b["id"]]
    assert body["error"]["mind"] == b["id"] and "again" in body["hint"]
    assert hive._agent_row(b["id"])["status"] != "awake"
    again = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert again.json() == {"deleted_minds": [b["id"]], "swarm": "deleted", "released_tasks": 0}


# ---- r3: Kimi FIX-FIRST on 065e22d (K1, K2, K4) ---------------------------------------------------------------------

def test_a_swarm_less_mind_cannot_be_pulled_in_mid_delete(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    loner = client.post("/api/agents", json={"name": "Loner"}).json()
    from hive.core.hive import HiveError
    seen = []
    def pull_in():
        try:
            hive.update_agent(loner["id"], {"swarm_id": swarm["id"]})
        except HiveError as exc:
            seen.append(exc.code)
    _during_archive(monkeypatch, hive, pull_in)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.json()["swarm"] == "deleted" and seen == ["swarm_busy"]
    assert hive._agent_row(loner["id"])["swarm_id"] is None


def test_no_write_lands_in_a_swarm_that_no_longer_exists(client, monkeypatch):
    """K1: the open-swarm condition requires the swarm row, so a check read before the delete cannot carry a write in."""
    import pytest
    from hive.core.hive import HiveError
    hive = client.app.state.hive
    gone = client.post("/api/swarms", json={"name": "Gone"}).json()
    loner = client.post("/api/agents", json={"name": "Loner"}).json()
    assert client.delete(f"/api/swarms/{gone['id']}").status_code == 200
    real = hive.swarm
    monkeypatch.setattr(hive, "swarm", lambda sid: {"id": sid} if sid == gone["id"] else real(sid))   # a stale read
    with pytest.raises(HiveError) as e:                                     # a move in
        hive.update_agent(loner["id"], {"swarm_id": gone["id"]})
    assert e.value.status == 404 and hive._agent_row(loner["id"])["swarm_id"] is None
    with pytest.raises(HiveError) as e:                                     # a create there
        hive.create_agent("Late", "omega", gone["id"], "mock/echo", "", None, 0, None, None)
    assert e.value.status == 404
    assert not hive.db.one("SELECT 1 FROM agents WHERE swarm_id = ?", (gone["id"],))
    with pytest.raises(HiveError) as e:                                     # a returning mind's join (placement)
        hive.update_in_open_swarm("agents", loner["id"], {"swarm_id": gone["id"]}, gone["id"])
    assert e.value.status == 404 and hive._agent_row(loner["id"])["swarm_id"] is None
    archived = client.post("/api/swarms", json={"name": "Shut"}).json()
    client.post(f"/api/swarms/{archived['id']}/archive")
    with pytest.raises(HiveError) as e:
        hive.update_in_open_swarm("agents", loner["id"], {"swarm_id": archived["id"]}, archived["id"])
    assert e.value.code == "swarm_archived"


def test_detached_swarms_come_from_the_final_state(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    late = client.post("/api/swarms", json={"name": "Late child"}).json()
    _during_archive(monkeypatch, hive, lambda: hive.db.execute(
        "UPDATE swarms SET parent_mind_id = ? WHERE id = ?", (a["id"], late["id"])))
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.json()["detached_swarms"] == [late["id"]]


def test_a_confirm_mismatch_names_the_expected_name(client):
    sw = client.post("/api/swarms", json={"name": "Alpha"}).json()
    r = _delete(client, sw["id"], {"with_minds": True, "confirm": "Alpha "})
    assert r.status_code == 400 and r.json()["error"]["expected"] == "Alpha"



# ---- r3: Platform ruling (one fence) and stand-in findings on 94b5cff -------------------------------------------------

def test_the_fence_refuses_every_membership_change_while_a_delete_holds_it(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    loner = client.post("/api/agents", json={"name": "Loner"}).json()
    from hive.core.hive import HiveError
    seen = {}
    def race():
        attempts = {
            "create mind": lambda: hive.create_agent("Late", "omega", swarm["id"], "mock/echo", "", None, 0, None, None),
            "move in": lambda: hive.update_agent(loner["id"], {"swarm_id": swarm["id"]}),
            "move out": lambda: hive.update_agent(a["id"], {"swarm_id": None}),
            "start": lambda: hive.lifecycle(a["id"], "start"),
            "restore": lambda: hive.restore_swarm(swarm["id"]),
        }
        for what, attempt in attempts.items():
            try:
                attempt()
                seen[what] = "landed"
            except HiveError as exc:
                seen[what] = exc.code
        seen["create task"] = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "late"}).json()["error"]["code"]
    _during_archive(monkeypatch, hive, race)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert set(seen.values()) == {"swarm_busy"}, seen
    assert r.json() == {"deleted_minds": [a["id"], b["id"]], "swarm": "deleted", "released_tasks": 0}
    assert hive._agent_row(loner["id"])["swarm_id"] is None


def test_a_delete_is_refused_while_a_membership_write_is_in_flight(client):
    hive = client.app.state.hive
    swarm, _ = make_swarm_and_agents(client)
    with hive.swarm_membership(swarm["id"]):
        import threading
        out = []
        t = threading.Thread(target=lambda: out.append(_delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})))
        t.start(); t.join(30)
    assert out[0].status_code == 409 and out[0].json()["error"]["code"] == "swarm_busy"
    assert len(_alive(hive, swarm["id"])) == 2


def test_a_move_that_loses_its_condition_writes_nothing(client, monkeypatch):
    """Pre-existing: update_agent wrote swarm_id a second time, unconditionally, and a move to no swarm skipped the
    condition. A stale read (stopped) of a mind now awake must leave the mind exactly where it is, other fields too."""
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    stale = dict(hive._agent_row(a["id"]))
    hive.db.update("agents", a["id"], {"status": "awake"})
    real = hive._agent_row
    monkeypatch.setattr(hive, "_agent_row", lambda aid: stale if aid == a["id"] and calls.append(1) is None and len(calls) == 1 else real(aid))
    from hive.core.hive import HiveError
    import pytest
    for target in (other["id"], None):
        calls = []
        with pytest.raises(HiveError) as e:
            hive.update_agent(a["id"], {"swarm_id": target, "name": "Renamed"})
        assert e.value.code == "mind_running"
        row = real(a["id"])
        assert row["swarm_id"] == swarm["id"] and row["name"] == "Dot0"


def test_release_shares_the_soft_delete_transaction(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]})
    def broken(*args, **kw):
        raise RuntimeError("release failed")
    monkeypatch.setattr(hive.goals, "release_rows", broken)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    body = r.json()
    assert body["swarm"] == "archived" and body["deleted_minds"] == [] and body["remaining_minds"] == [a["id"], b["id"]]
    assert len(_alive(hive, swarm["id"])) == 2                                       # the soft delete rolled back with it


def test_a_cleanup_failure_is_reported_and_finished_by_the_retry_once(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    revoke = hive.spaces.revoke
    failures = {"left": 1}
    def flaky(agent_id, swarm_id):
        if agent_id == b["id"] and failures["left"]:
            failures["left"] -= 1
            raise RuntimeError("spaces unavailable")
        revoke(agent_id, swarm_id)
    monkeypatch.setattr(hive.spaces, "revoke", flaky)
    events = []
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append((kind, kw.get("agent_id"))), original(kind, **kw)))
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert first["swarm"] == "archived" and first["deleted_minds"] == [a["id"], b["id"]]   # both committed
    assert first["cleanup_pending"] == [b["id"]] and first["remaining_minds"] == [] and first["error"]["code"] == "cleanup_failed"
    assert _alive(hive, swarm["id"]) == []
    again = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert again == {"deleted_minds": [b["id"]], "swarm": "deleted", "released_tasks": 0}
    assert events.count(("agent.deleted", b["id"])) == 1 and events.count(("agent.deleted", a["id"])) == 1
    assert not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_submitted_work_stays_for_review_and_a_return_reopens_it(client):
    import asyncio
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals",
                       json={"title": "reviewed", "assignee": a["id"], "binding": {"review": "person"}}).json()
    hive.db.update("goals", goal["id"], {"status": "submitted", "claimed_by": a["id"], "result": "the answer"})
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.json()["swarm"] == "archived" and r.json()["released_tasks"] == 1
    row = hive.db.one("SELECT * FROM goals WHERE id = ?", (goal["id"],))
    assert row["status"] == "submitted" and row["assignee"] is None and row["result"] == "the answer"
    client.post(f"/api/swarms/{swarm['id']}/restore")
    reviewer = {"kind": "person", "principal": "user:u_jon", "admin": True}
    back = asyncio.run(hive.goals.review(goal["id"], reviewer, "return", "try again"))
    assert back["status"] == "open" and back["claimed_by"] is None                   # never back to the deleted mind


def test_stalled_work_is_reopened(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "stuck"}).json()
    hive.db.update("goals", goal["id"], {"status": "stalled", "claimed_by": a["id"], "assignee": a["id"], "attempts": 3})
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert r.json()["released_tasks"] == 1
    row = hive.db.one("SELECT * FROM goals WHERE id = ?", (goal["id"],))
    assert (row["status"], row["assignee"], row["claimed_by"], row["attempts"]) == ("open", None, None, 3)



# ---- r3: delete-preview (Surface) ------------------------------------------------------------------------------------

def _table_counts(hive):
    tables = [r["name"] for r in hive.db.all("SELECT name FROM sqlite_master WHERE type = 'table'")]
    return {t: hive.db.one(f'SELECT COUNT(*) AS n FROM "{t}"')["n"] for t in tables}


def test_the_preview_says_what_would_happen_and_writes_nothing(client):
    hive = client.app.state.hive
    empty = client.post("/api/swarms", json={"name": "Empty"}).json()
    swarm, (a, b) = make_swarm_and_agents(client)
    hive.db.update("agents", a["id"], {"status": "awake", "desired": "awake"})
    client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]})
    before = _table_counts(hive)
    p = client.get(f"/api/swarms/{swarm['id']}/delete-preview").json()
    assert p == {"name": "Alpha", "counts": {"minds": 2, "members": 0, "goals": 1, "artifacts": 0, "child_swarms": 0},
                 "awake_minds": [{"id": a["id"], "name": "Dot0"}], "would": "archive",
                 "reason": "it has history (1 task)", "released_tasks_estimate": 1, "busy": False}
    e = client.get(f"/api/swarms/{empty['id']}/delete-preview").json()
    assert e["would"] == "delete" and e["counts"]["minds"] == 0 and e["busy"] is False
    assert _table_counts(hive) == before and client.get(f"/api/swarms/{empty['id']}").status_code == 200
    assert hive._agent_row(a["id"])["status"] == "awake"
    real = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()   # the same judgement
    assert real["swarm"] == p["would"] + "d" and real["reason"] == p["reason"] and real["released_tasks"] == 1


def test_the_preview_reports_busy(client, monkeypatch):
    hive = client.app.state.hive
    swarm, _ = make_swarm_and_agents(client)
    with hive.swarm_membership(swarm["id"]):
        assert client.get(f"/api/swarms/{swarm['id']}/delete-preview").json()["busy"]
    monkeypatch.setattr(hive, "_live_flow", lambda sid: True)
    assert client.get(f"/api/swarms/{swarm['id']}/delete-preview").json()["busy"] == "a flow is still running here"


def test_the_preview_is_admin_only_with_the_visibility_rule(client):
    from hive.tests.test_visibility import person
    member = person(client, "u_member")
    private, _ = make_swarm_and_agents(client)
    public = client.post("/api/swarms", json={"name": "Open", "visibility": "public"}).json()
    assert client.get(f"/api/swarms/{private['id']}/delete-preview", headers=member).status_code == 404
    assert client.get(f"/api/swarms/{public['id']}/delete-preview", headers=member).status_code == 403



# ---- r4: stand-in FIX-FIRST on 021ef16 -------------------------------------------------------------------------------

def test_a_claim_authenticated_before_the_delete_cannot_land_after_the_release(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]}).json()
    authenticated = dict(hive._agent_row(a["id"]))                 # the request's agent row, read before the delete
    assert _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()["released_tasks"] == 1
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.goals.claim(authenticated, goal["id"])
    assert e.value.status == 409 and e.value.code == "mind_deleted"
    row = hive.db.one("SELECT * FROM goals WHERE id = ?", (goal["id"],))
    assert row["status"] == "open" and row["claimed_by"] is None


def test_a_review_return_whose_holder_is_deleted_mid_review_reopens_it(client, monkeypatch):
    import asyncio
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "reviewed", "binding": {"review": "person"}}).json()
    hive.db.update("goals", goal["id"], {"status": "submitted", "claimed_by": a["id"], "result": "r"})
    record = hive.goals._record_review
    def record_then_delete(*args, **kw):                          # between the review's read and its write
        record(*args, **kw)
        hive.delete_agent(a["id"])
    monkeypatch.setattr(hive.goals, "_record_review", record_then_delete)
    out = asyncio.run(hive.goals.review(goal["id"], {"kind": "person", "principal": "user:u_jon", "admin": True},
                                        "return", "again"))
    assert out["status"] == "open" and out["claimed_by"] is None
    assert hive.db.one("SELECT claimed_by, status FROM goals WHERE id = ?", (goal["id"],)) == {"claimed_by": None, "status": "open"}


def test_a_review_return_to_a_live_holder_is_unchanged(client):
    import asyncio
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "reviewed", "binding": {"review": "person"}}).json()
    hive.db.update("goals", goal["id"], {"status": "submitted", "claimed_by": a["id"], "result": "r"})
    out = asyncio.run(hive.goals.review(goal["id"], {"kind": "person", "principal": "user:u_jon", "admin": True},
                                        "return", "again"))
    assert out["status"] == "claimed" and out["claimed_by"] == a["id"]


def test_rename_and_child_attachment_are_fenced(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    outside = client.post("/api/swarms", json={"name": "Outside"}).json()
    host = client.post("/api/agents", json={"name": "Host", "swarm_id": outside["id"]}).json()
    loose = client.post("/api/swarms", json={"name": "Loose"}).json()
    from hive.core.hive import HiveError
    seen = {}
    def race():
        for what, attempt in {
            "rename": lambda: hive.update_swarm(swarm["id"], {"name": "Beta"}),
            "attach under its mind": lambda: hive.update_swarm(loose["id"], {"parent_mind_id": a["id"]}),
            "attach it elsewhere": lambda: hive.update_swarm(swarm["id"], {"parent_mind_id": host["id"]}),
        }.items():
            try:
                attempt()
                seen[what] = "landed"
            except HiveError as exc:
                seen[what] = exc.code
    _during_archive(monkeypatch, hive, race)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert seen == {"rename": "swarm_busy", "attach under its mind": "swarm_busy", "attach it elsewhere": "swarm_busy"}
    assert r.json()["swarm"] == "deleted" and "detached_swarms" not in r.json()
    assert client.get(f"/api/swarms/{loose['id']}").json()["parent_mind_id"] is None


def test_an_attach_revalidates_inside_the_fence(client, monkeypatch):
    hive = client.app.state.hive
    first = client.post("/api/swarms", json={"name": "First"}).json()
    second = client.post("/api/swarms", json={"name": "Second"}).json()
    child = client.post("/api/swarms", json={"name": "Child"}).json()
    host = client.post("/api/agents", json={"name": "Host", "swarm_id": first["id"]}).json()
    real = hive.swarm_membership
    def move_then_fence(*ids):                                     # the parent moves between the read and the fence
        hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (second["id"], host["id"]))
        return real(*ids)
    monkeypatch.setattr(hive, "swarm_membership", move_then_fence)
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.update_swarm(child["id"], {"parent_mind_id": host["id"]})
    assert e.value.code == "parent_moved"
    assert hive.db.one("SELECT parent_mind_id FROM swarms WHERE id = ?", (child["id"],))["parent_mind_id"] is None


def test_a_notification_failure_after_the_commit_is_cleanup_pending_not_unstoppable(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]})
    emit = hive.goals._emit
    def failing(goal_id):
        raise RuntimeError("event bus down")
    monkeypatch.setattr(hive.goals, "_emit", failing)
    body = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert body["error"]["code"] == "cleanup_failed" and body["error"]["mind"] == a["id"]
    assert body["deleted_minds"] == [a["id"]] and body["cleanup_pending"] == [a["id"]] and body["released_tasks"] == 1
    assert body["remaining_minds"] == [b["id"]]
    monkeypatch.setattr(hive.goals, "_emit", emit)
    again = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert again["deleted_minds"] == [a["id"], b["id"]] and again["swarm"] == "archived"   # the released task is history



# ---- r5: Kimi FIX-FIRST on 021ef16 (K1, K3, K4) ----------------------------------------------------------------------

class _Driver:
    """A driver whose stop does nothing for minds it does not track; status is what the process table would say."""
    def __init__(self, running):
        self.running = set(running)
        self.stopped = []
    def stop(self, agent_id):
        self.stopped.append(agent_id)          # untracked: nothing to signal, so nothing happens
    def status(self, agent_id):
        return "running" if agent_id in self.running else "absent"


def _real_supervisor(client, driver):
    from hive.supervisor.drivers import Supervisor
    hive = client.app.state.hive
    sup = Supervisor(hive.settings, drivers={"local": driver, "docker": driver})
    sup.attach(hive)
    return sup


def test_an_untracked_but_running_mind_refuses_everything(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    driver = _Driver(running=[b["id"]])                # its row says stopped; its process lives on, untracked
    monkeypatch.setattr(hive, "supervisor", _real_supervisor(client, driver))
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    err = r.json()["error"]
    assert r.status_code == 409 and err["code"] == "minds_unstoppable"
    assert [f["id"] for f in err["failed"]] == [b["id"]] and "still running" in err["failed"][0]["error"]
    assert err["stopped_minds"] == []
    assert len(_alive(hive, swarm["id"])) == 2 and hive.swarm(swarm["id"])["archived_at"] is None
    driver.running.clear()                              # once it is really gone, the same request goes through
    assert _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()["swarm"] == "deleted"


def test_the_soft_delete_verifies_the_stop_itself(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, _b) = make_swarm_and_agents(client)
    driver = _Driver(running=[a["id"]])
    monkeypatch.setattr(hive, "supervisor", _real_supervisor(client, driver))
    import pytest
    with pytest.raises(RuntimeError, match="still running"):
        hive.delete_agent(a["id"])
    assert hive._agent_row(a["id"])["deleted"] == 0


def test_a_refusal_lists_the_minds_it_did_stop(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    for m in (a, b):
        hive.db.update("agents", m["id"], {"status": "awake", "desired": "awake"})
    stop = client.supervisor.stop
    def stubborn(agent_id):
        if agent_id == b["id"]:
            raise RuntimeError("will not die")
        stop(agent_id)
    client.supervisor.stop = stubborn
    try:
        err = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()["error"]
    finally:
        client.supervisor.stop = stop
    assert err["code"] == "minds_unstoppable" and err["stopped_minds"] == [{"id": a["id"], "name": "Dot0"}]
    assert hive._agent_row(a["id"])["status"] == "stopped" and len(_alive(hive, swarm["id"])) == 2


def test_a_released_stalled_task_keeps_its_returns_and_attempts_and_is_claimable(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "stuck"}).json()
    hive.db.update("goals", goal["id"], {"status": "stalled", "claimed_by": a["id"], "assignee": a["id"],
                                         "attempts": 3, "returns": 2, "result": "stalled: 3 claims lapsed"})
    assert _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()["released_tasks"] == 1
    row = hive.db.one("SELECT * FROM goals WHERE id = ?", (goal["id"],))
    assert (row["status"], row["claimed_by"], row["assignee"], row["returns"], row["attempts"]) == ("open", None, None, 2, 3)
    assert row["result"] == "stalled: 3 claims lapsed"
    client.post(f"/api/swarms/{swarm['id']}/restore")
    newcomer = client.post("/api/agents", json={"name": "New", "swarm_id": swarm["id"]}).json()
    got = client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(newcomer))
    assert got.status_code == 200 and got.json()["claimed_by"] == newcomer["id"]


# ---- r5: stand-in FIX-FIRST on 02ada0d -------------------------------------------------------------------------------

def test_a_heartbeat_racing_the_release_cannot_reclaim_the_task(client, monkeypatch):
    import hive.core.goals as goals_module
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "held"}).json()
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(b)).status_code == 200
    holder = dict(hive._agent_row(b["id"]))
    later = goals_module._later
    def release_mid_heartbeat(minutes):                 # between the heartbeat's read and its write
        hive._locked_soft_delete(b["id"], swarm["id"], "user:operator", "released: test")
        return later(minutes)
    monkeypatch.setattr(goals_module, "_later", release_mid_heartbeat)
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.goals.heartbeat(holder, goal["id"])
    assert e.value.code == "not_claimed"                # the same answer as a lapsed lease
    row = hive.db.one("SELECT status, claimed_by FROM goals WHERE id = ?", (goal["id"],))
    assert row == {"status": "open", "claimed_by": None}


def test_the_cleanup_record_stays_until_agent_deleted_is_published(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    original = hive.events.publish
    published, fail = [], {"agent.deleted": 1}
    def flaky(kind, **kw):
        if kind == "agent.deleted" and kw.get("agent_id") == b["id"] and fail["agent.deleted"]:
            fail["agent.deleted"] -= 1
            raise RuntimeError("bus down")
        published.append((kind, kw.get("agent_id")))
        return original(kind, **kw)
    monkeypatch.setattr(hive.events, "publish", flaky)
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert first["cleanup_pending"] == [b["id"]] and first["error"]["code"] == "cleanup_failed"
    assert hive.db.one("SELECT agent_id FROM mind_cleanup") == {"agent_id": b["id"]}   # kept: the publish failed
    again = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert again["swarm"] == "deleted" and again["deleted_minds"] == [b["id"]]
    assert published.count(("agent.deleted", b["id"])) == 1 and not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_released_task_notifications_are_replayed_until_published(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    g1 = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "one", "assignee": a["id"]}).json()
    g2 = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "two", "assignee": a["id"]}).json()
    emit, sent, fail = hive.goals._emit, [], {"left": 1}
    def flaky(goal_id):
        if goal_id == g2["id"] and fail["left"]:
            fail["left"] -= 1
            raise RuntimeError("bus down")
        sent.append(goal_id)
        return emit(goal_id)
    monkeypatch.setattr(hive.goals, "_emit", flaky)
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert first["cleanup_pending"] == [a["id"]] and first["released_tasks"] == 2
    import json
    assert json.loads(hive.db.one("SELECT released FROM mind_cleanup WHERE agent_id = ?", (a["id"],))["released"]) == [g2["id"]]
    _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert sent.count(g1["id"]) == 1 and sent.count(g2["id"]) == 1 and not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_a_coffee_room_sync_failure_keeps_the_cleanup_record(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    sync, fail = hive.rooms.sync_coffee, {"left": 1}
    def flaky(*args, **kw):
        if fail["left"]:
            fail["left"] -= 1
            raise RuntimeError("room store down")
        return sync(*args, **kw)
    monkeypatch.setattr(hive.rooms, "sync_coffee", flaky)
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert first["cleanup_pending"] == [a["id"]] and first["error"]["code"] == "cleanup_failed"
    assert hive.db.one("SELECT agent_id FROM mind_cleanup") == {"agent_id": a["id"]}
    assert _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()["swarm"] == "deleted"
    assert not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_ordinary_callers_still_swallow_a_coffee_room_failure(client, monkeypatch):
    hive = client.app.state.hive
    monkeypatch.setattr(hive.rooms, "sync_coffee", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    hive._coffee_sync()                                   # no exception


# ---- r7: cleanup generation and persisted steps (stand-in r6) --------------------------------------------------------

def test_a_stale_cleanup_never_acts_on_a_mind_that_is_live_again(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    sync = hive.rooms.sync_coffee
    monkeypatch.setattr(hive.rooms, "sync_coffee", lambda *x, **k: (_ for _ in ()).throw(RuntimeError("down")))
    try:
        hive.delete_agent(a["id"])
    except RuntimeError:
        pass
    monkeypatch.setattr(hive.rooms, "sync_coffee", sync)
    hive.db.execute("UPDATE agents SET deleted = 0 WHERE id = ?", (a["id"],))    # it came back before the retry
    revoked, events = [], []
    monkeypatch.setattr(hive.spaces, "revoke", lambda *x: revoked.append(x))
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append(kind), original(kind, **kw)))
    assert hive.finish_mind_cleanup(a["id"]) is False
    assert revoked == [] and "agent.deleted" not in events and not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_a_cleanup_from_an_older_deletion_is_stale_after_a_new_one(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    hive.db.execute("INSERT INTO mind_cleanup (agent_id, swarm_id, created_at, generation) VALUES (?, ?, 'x', 0)",
                    (a["id"], swarm["id"]))
    hive.db.execute("UPDATE agents SET deleted = 1, deletion_gen = 2 WHERE id = ?", (a["id"],))
    assert hive.finish_mind_cleanup(a["id"]) is False and not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_a_retry_runs_only_the_steps_left_and_publishes_agent_deleted_once(client, monkeypatch):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    sync, fail = hive.rooms.sync_coffee, {"left": 1}
    def flaky(*x, **k):
        if fail["left"]:
            fail["left"] -= 1
            raise RuntimeError("down")
        return sync(*x, **k)
    monkeypatch.setattr(hive.rooms, "sync_coffee", flaky)
    revoke, revoked = hive.spaces.revoke, []
    monkeypatch.setattr(hive.spaces, "revoke", lambda *x: (revoked.append(x), revoke(*x)))
    events = []
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append((kind, kw.get("agent_id"))), original(kind, **kw)))
    first = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert first["cleanup_pending"] == [a["id"]]
    rec = hive.db.one("SELECT * FROM mind_cleanup WHERE agent_id = ?", (a["id"],))
    assert (rec["spaces_revoked"], rec["agent_deleted_published"], rec["coffee_synced"]) == (1, 1, 0)
    _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"})
    assert events.count(("agent.deleted", a["id"])) == 1 and revoked.count((a["id"], swarm["id"])) == 1


# ---- r8: one rule, mind lock + fences end to end (Platform rule on 3a2a609) ------------------------------------------

def test_concurrent_cleanup_finishers_publish_agent_deleted_once(client, monkeypatch):
    import threading
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    sync = hive.rooms.sync_coffee
    monkeypatch.setattr(hive.rooms, "sync_coffee", lambda *x, **k: (_ for _ in ()).throw(RuntimeError("down")))
    try:
        hive.delete_agent(a["id"])
    except RuntimeError:
        pass
    hive.db.execute("UPDATE mind_cleanup SET agent_deleted_published = 0 WHERE agent_id = ?", (a["id"],))
    inside, go = threading.Event(), threading.Event()
    def slow(*x, **k):                                    # the first finisher pauses inside its run
        inside.set()
        go.wait(10)
        return sync(*x, **k)
    monkeypatch.setattr(hive.rooms, "sync_coffee", slow)
    events = []
    original = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append((kind, kw.get("agent_id"))), original(kind, **kw)))
    results = []
    t1 = threading.Thread(target=lambda: results.append(hive.finish_mind_cleanup(a["id"])))
    t1.start()
    assert inside.wait(10)
    t2 = threading.Thread(target=lambda: results.append(hive.finish_mind_cleanup(a["id"])))
    t2.start()
    t2.join(0.5)
    assert t2.is_alive()                                  # waits on the mind's lock, not racing the first
    go.set()
    t1.join(10); t2.join(10)
    assert sorted(results) == [False, True] and events.count(("agent.deleted", a["id"])) == 1


def test_a_single_delete_releases_its_tasks_in_the_same_transaction(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "for Dot0", "assignee": a["id"]}).json()
    assert client.delete(f"/api/agents/{a['id']}").json() == {"ok": True}
    row = hive.db.one("SELECT status, assignee FROM goals WHERE id = ?", (goal["id"],))
    assert row == {"status": "open", "assignee": None}
    assert hive.db.one("SELECT deletion_gen FROM agents WHERE id = ?", (a["id"],))["deletion_gen"] == 1
    assert not hive.db.one("SELECT 1 FROM mind_cleanup")


def test_a_single_delete_is_fenced_by_its_swarm(client, monkeypatch):
    import threading
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    out = []
    hive._swarm_ops[swarm["id"]] = -1                     # a delete or restore of its swarm is in flight
    try:
        t = threading.Thread(target=lambda: out.append(client.delete(f"/api/agents/{a['id']}")))
        t.start(); t.join(30)
    finally:
        hive._swarm_ops.pop(swarm["id"], None)
    assert out[0].status_code == 409 and out[0].json()["error"]["code"] == "swarm_busy"
    assert hive._agent_row(a["id"])["deleted"] == 0


def test_a_swarm_delete_repairs_tasks_left_on_tombstones(client):
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "orphan", "assignee": a["id"]}).json()
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (a["id"],))   # deleted before releases existed
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json()
    assert r["released_tasks"] == 1 and r["swarm"] == "archived"
    row = hive.db.one("SELECT status, assignee, claimed_by FROM goals WHERE id = ?", (goal["id"],))
    assert row == {"status": "open", "assignee": None, "claimed_by": None}


# ---- r9: the last two paths under the rule -----------------------------------------------------------------------------

def test_a_move_waits_on_the_minds_lock(client):
    import threading
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    lock = hive._mind_lock(a["id"])
    out = []
    with lock:                                            # e.g. a delete or a cleanup holding the mind
        t = threading.Thread(target=lambda: out.append(hive.update_agent(a["id"], {"swarm_id": other["id"]})))
        t.start(); t.join(0.5)
        assert t.is_alive() and hive._agent_row(a["id"])["swarm_id"] == swarm["id"]
    t.join(10)
    assert out and out[0]["swarm_id"] == other["id"]


def test_the_hive_has_a_mind_lock_without_a_supervisor(client, monkeypatch):
    hive = client.app.state.hive
    monkeypatch.setattr(hive, "supervisor", None)
    first, again = hive._mind_lock("a_x"), hive._mind_lock("a_x")
    assert first is again and hasattr(first, "acquire")


# ---- r10: the move and creation held end to end (stand-in r9) --------------------------------------------------------

def test_a_delete_cannot_finish_mid_move_and_strand_a_destination_grant(client, monkeypatch):
    """The stand-in's reproducer: a delete finishing cleanup mid-move left the destination grant on a deleted mind."""
    import threading
    hive = client.app.state.hive
    swarm, (a, b) = make_swarm_and_agents(client)
    other = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    grant, seen = hive.spaces.grant, {}
    def grant_and_race(agent_id, swarm_id):
        if agent_id == a["id"] and swarm_id == other["id"] and "t" not in seen:
            seen["t"] = threading.Thread(target=lambda: seen.setdefault("del", _try_delete(hive, a["id"])))
            seen["t"].start(); seen["t"].join(0.5)
            seen["blocked"] = seen["t"].is_alive() or seen.get("del") == "swarm_busy"
        return grant(agent_id, swarm_id)
    monkeypatch.setattr(hive.spaces, "grant", grant_and_race)
    hive.update_agent(a["id"], {"swarm_id": other["id"]})
    seen["t"].join(30)
    assert seen["blocked"] is True
    if seen.get("del") == "ok":                          # the delete ran after the move: it revoked the new grant too
        assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (a["id"],))["deleted"] == 1
        assert not hive.spaces.is_member(a["id"], other["id"])


def _try_delete(hive, agent_id):
    from hive.core.hive import HiveError
    try:
        hive.delete_agent(agent_id)
        return "ok"
    except HiveError as exc:
        return exc.code


def test_creation_holds_the_fence_and_the_new_minds_lock_through_finish(client, monkeypatch):
    import threading
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Alpha"}).json()
    seen = {}
    finish = hive.finish_agent
    def finish_and_race(row, token, role, **kw):   # kw: by (host-identity r1.1)
        seen["writers"] = hive._swarm_writers.get(swarm["id"], 0)
        out = []
        t = threading.Thread(target=lambda: out.append(_try_delete(hive, row["id"])))
        t.start(); t.join(0.5)
        seen["delete_blocked"] = t.is_alive()
        seen["t"] = t
        busy = []
        t2 = threading.Thread(target=lambda: busy.append(
            _delete(client, swarm["id"], {"with_minds": True, "confirm": "Alpha"}).json().get("error", {}).get("code")))
        t2.start(); t2.join(10)
        seen["swarm_op"] = busy[0] if busy else None
        return finish(row, token, role, **kw)
    monkeypatch.setattr(hive, "finish_agent", finish_and_race)
    made = hive.create_agent("New", "omega", swarm["id"], "mock/echo", "", None, 0, None, None)
    seen["t"].join(30)
    assert seen["writers"] == 1 and seen["delete_blocked"] is True and seen["swarm_op"] == "swarm_busy"
    assert made["id"]


# ---- r11: convert_to_native under the rule (stand-in r10) ------------------------------------------------------------

def test_a_conversion_during_a_held_delete_is_refused(client, monkeypatch):
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Mixed"}).json()
    mind = client.post("/api/agents", json={"name": "Dot", "swarm_id": swarm["id"]}).json()
    member = client.post("/api/agents", json={"name": "Ext", "kind": "module", "swarm_id": swarm["id"]}).json()
    from hive.core.hive import HiveError
    seen = []
    def convert():
        try:
            hive.convert_to_native(member["id"])
            seen.append("converted")
        except HiveError as exc:
            seen.append(exc.code)
    _during_archive(monkeypatch, hive, convert)
    r = _delete(client, swarm["id"], {"with_minds": True, "confirm": "Mixed"}).json()
    assert seen == ["swarm_busy"]
    assert hive._agent_row(member["id"])["kind"] == "module"            # still the excluded external member
    assert r["swarm"] == "archived" and r["deleted_minds"] == [mind["id"]]


def test_a_conversion_waits_on_the_minds_lock(client):
    import threading
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Open"}).json()
    member = client.post("/api/agents", json={"name": "Ext", "kind": "module", "swarm_id": swarm["id"]}).json()
    out = []
    with hive._mind_lock(member["id"]):                   # e.g. a delete or a placement holding it
        t = threading.Thread(target=lambda: out.append(hive.convert_to_native(member["id"])))
        t.start(); t.join(0.5)
        assert t.is_alive() and hive._agent_row(member["id"])["kind"] == "module"
    t.join(10)
    assert out[0]["kind"] == "omega"


def test_no_conversion_in_a_retired_swarm(client):
    hive = client.app.state.hive
    swarm = client.post("/api/swarms", json={"name": "Old"}).json()
    member = client.post("/api/agents", json={"name": "Ext", "kind": "module", "swarm_id": swarm["id"]}).json()
    client.post(f"/api/swarms/{swarm['id']}/archive")
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as e:
        hive.convert_to_native(member["id"])
    assert e.value.code == "swarm_archived" and hive._agent_row(member["id"])["kind"] == "module"
