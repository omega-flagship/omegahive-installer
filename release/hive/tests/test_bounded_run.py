"""The bounded runner: refuses unsafe starts, stops every mind on the first end condition, metadata-only receipt."""
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tools.bounded_run import Runner


def setup(client, caps=(0.5, 0.5)):
    swarm, (a, b) = make_swarm_and_agents(client)
    for mind, cap in zip((a, b), caps):
        if cap is not None:
            client.post("/api/budgets", json={"scope": f"agent:{mind['id']}", "period": "total", "limit_usd": cap})
    g1 = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "hypotheses", "assignee": a["name"]}).json()
    g2 = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "challenge", "assignee": b["name"]}).json()
    return a, b, g1, g2


def test_refuses_without_hard_caps_or_above_the_ceiling(client):
    a, b, g1, g2 = setup(client, caps=(0.5, None))
    out = Runner(client, [a["id"], b["id"]], [g1["id"], g2["id"]], 1.0, 60, sleep=lambda s: None).run()
    assert out["started"] is False and any("no hard total spending rule" in p for p in out["refused"])
    client.post("/api/budgets", json={"scope": f"agent:{b['id']}", "period": "total", "limit_usd": 0.75})
    out = Runner(client, [a["id"], b["id"]], [g1["id"], g2["id"]], 1.0, 60, sleep=lambda s: None).run()
    assert out["started"] is False and any("above the $1.00 ceiling" in p for p in out["refused"])


def test_stops_everyone_when_the_goals_finish_and_keeps_text_out_of_the_receipt(client):
    a, b, g1, g2 = setup(client)
    ticks = []

    def work(_):
        ticks.append(1)
        if len(ticks) == 1:
            for mind, goal in ((a, g1), (b, g2)):
                client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(mind))
                client.post(f"/api/agent/goals/{goal['id']}/result", headers=agent_headers(mind),
                            json={"status": "done", "result": "SECRET-TEXT", "data": {"x": 1}})
    out = Runner(client, [a["id"], b["id"]], [g1["id"], g2["id"]], 1.0, 600, sleep=work).run()
    assert out["started"] and out["stop_reason"] == "all goals finished"
    assert [e["event"] for e in out["events"]].count("stopped") == 2
    assert all(client.get(f"/api/agents/{m}").json()["status"] in ("stopped", "created") for m in (a["id"], b["id"]))
    assert "SECRET-TEXT" not in str(out) and out["goals"][g1["id"]]["result_digest"].startswith("sha256:")


def test_timeout_stops_everyone(client):
    a, b, g1, g2 = setup(client)
    t = [0.0]
    out = Runner(client, [a["id"], b["id"]], [g1["id"], g2["id"]], 1.0, 10, sleep=lambda s: t.__setitem__(0, t[0] + 6),
                 clock=lambda: t[0]).run()
    assert out["stop_reason"] == "timeout" and [e["event"] for e in out["events"]].count("stopped") == 2


def test_a_failing_start_still_stops_everyone_and_an_unconfirmed_stop_is_reported(client, monkeypatch):
    a, b, g1, g2 = setup(client)
    runner = Runner(client, [a["id"], b["id"]], [g1["id"], g2["id"]], 1.0, 600, sleep=lambda s: None)
    real_post = client.post

    def post(path, *args, **kw):
        if path == f"/api/agents/{b['id']}/start":
            raise RuntimeError("start failed")
        return real_post(path, *args, **kw)
    monkeypatch.setattr(client, "post", post)
    import pytest
    with pytest.raises(RuntimeError):
        runner.run()
    assert [e["mind"] for e in runner.events if e["event"] == "stopped"] == [a["id"], b["id"]]

    runner2 = Runner(client, [a["id"]], [g1["id"]], 1.0, 600, sleep=lambda s: None)
    real_get = client.get
    monkeypatch.setattr(client, "get", lambda path, *x, **k: _awake(real_get(path, *x, **k)) if path == f"/api/agents/{a['id']}" else real_get(path, *x, **k))
    runner2.stop_all()
    assert runner2.events[-1]["event"] == "stop-unconfirmed"


def _awake(response):
    import httpx
    data = response.json()
    data["status"] = "awake"
    return httpx.Response(200, json=data, request=response.request)


def test_the_run_stops_at_the_goals_own_deadline(client):
    a, b, g1, g2 = setup(client)
    client.app.state.hive.db.update("goals", g1["id"], {"deadline_at": "2000-01-01T00:00:00.000Z"})
    t = [0.0]
    out = Runner(client, [a["id"]], [g1["id"]], 1.0, 3600, sleep=lambda s: t.__setitem__(0, t[0] + 5), clock=lambda: t[0]).run()
    assert any(e["event"] == "deadline-bound" for e in out["events"]) and out["stop_reason"] in ("timeout", "all goals finished")


def test_a_new_spending_refusal_stops_the_run(client):
    import pytest
    from hive.core.hive import HiveError
    a, b, g1, g2 = setup(client)
    hive = client.app.state.hive

    def refuse(_):
        hive.db.update("agents", a["id"], {"budget_usd": 0.0001, "spent_usd": 0.0001})
        with pytest.raises(HiveError):
            hive.check_budget(hive.agent(a["id"]), paid=True, estimate=0.01)
    out = Runner(client, [a["id"]], [g1["id"]], 1.0, 600, sleep=refuse).run()
    assert "refused a model call" in out["stop_reason"] and any(e["event"] == "budget-refused" for e in out["events"])
