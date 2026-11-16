"""The Lab API: suites, a real benchmark run streamed into history."""

import time

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def wait_run(client, run_id, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = client.get(f"/api/lab/runs/{run_id}").json()
        if run["status"] != "running":
            return run
        time.sleep(0.5)
    raise AssertionError("run did not finish")


def test_suites_are_listed_with_requirements(client):
    suites = {s["id"]: s for s in client.get("/api/lab/suites").json()}
    assert {"tests-hive", "bench-core", "bench-drift", "bench-swarm"} <= set(suites)
    assert suites["bench-drift"]["runnable"] and suites["bench-drift"]["kind"] == "bench"
    assert client.post("/api/lab/runs", json={"suite": "nope"}).status_code == 404


def test_drift_bench_runs_streams_and_builds_history(client):
    run = client.post("/api/lab/runs", json={"suite": "bench-drift"}).json()
    assert run["status"] == "running"
    assert client.post("/api/lab/runs", json={"suite": "bench-drift"}).status_code == 409
    done = wait_run(client, run["id"])
    assert done["status"] == "passed", done
    names = [c["name"] for c in done["cases"]]
    assert "Echo storm" in names and "Spend runaway" in names
    echo = next(c for c in done["cases"] if c["name"] == "Echo storm")
    assert echo["metrics"][0]["name"] == "confidence inflation" and echo["metrics"][0]["ok"] is True
    assert {s["name"] for s in echo["series"]} == {"commons confidence", "naive revision"}
    history = client.get("/api/lab/history/bench-drift").json()
    assert history["runs"][-1]["id"] == run["id"]
    assert any(m["metric"] == "confidence inflation" for m in history["metrics"])
    assert client.get("/api/lab/suites").json()  # last_run attached
    assert client.get("/api/hive").json()["limits"]["goal_lease_minutes"] == 60
    card = {d["dimension"]: d for d in client.get("/api/lab/scorecard").json()}
    assert card["drift"]["score"] == 1.0 and card["cost"]["passed"] >= 3 and "bench-drift" in card["drift"]["suites"]


def test_reopening_a_goal_clears_its_lapses(client):
    swarm = client.post("/api/swarms", json={"name": "S"}).json()
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "x"}).json()
    hive = client.app.state.hive
    hive.db.update("goals", goal["id"], {"status": "stalled", "attempts": 3})
    reopened = client.patch(f"/api/goals/{goal['id']}", json={"status": "open"}).json()
    assert reopened["status"] == "open" and reopened["attempts"] == 0 and reopened["claimed_by"] is None


def test_a_finished_goal_cannot_be_moved_or_reopened(client):
    swarm = client.post("/api/swarms", json={"name": "S"}).json()
    hive = client.app.state.hive
    for finished in ("done", "cancelled"):
        goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": finished}).json()
        hive.db.update("goals", goal["id"], {"status": finished})
        for target in ("open", "claimed", "cancelled", "done", "failed"):
            if target == finished:
                continue
            refused = client.patch(f"/api/goals/{goal['id']}", json={"status": target})
            assert refused.status_code == 409 and refused.json()["error"]["code"] == "goal_closed", (finished, target)
        assert hive.goals.get(goal["id"])["status"] == finished
        same = client.patch(f"/api/goals/{goal['id']}", json={"status": finished, "priority": 0.9})   # idempotent, other fields still editable
        assert same.status_code == 200 and same.json()["status"] == finished
    failed = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "retry"}).json()
    hive.db.update("goals", failed["id"], {"status": "failed"})
    assert client.patch(f"/api/goals/{failed['id']}", json={"status": "done"}).status_code == 409
    assert client.patch(f"/api/goals/{failed['id']}", json={"status": "open"}).json()["status"] == "open"   # a retry is a fresh start
