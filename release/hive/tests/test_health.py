"""Error checking across minds, built from the failures minds actually hit on the shared hive."""
from hive.core.health import classify, signature
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

SEEN = [  # (command, result, kind): real results recorded on 3 October 2026
    ('(code-run "python t.py")', "HIVE-DENIED code-run: not a canonical bound operation", "denied"),
    ('(code-open "g_ebc0d184" "synthetic")', "CODE-REFUSED goal_not_owned: a mind gets a coding capability only for a goal it holds", "refused"),
    ('(code-check)', "CODE-ERROR action_forbidden: action is outside this capability", "error"),
    ('(syntax-error "code-open" "missing repository")', "['syntax-error', 'code-open', 'missing repository']", "parse"),
    ('(wait "x")', 'WAITING:ignored unknown command head code-verify; use only commands listed in SKILLS', "unknown-skill"),
    ('(code-replace "a" "b")', "CODE-STALE stale_workspace: the workspace changed since you read it", "stale"),
    ('(code-open "g" "r")', "CODE-APPROVAL-NEEDED p_41f7cc44 for code-workspace", "waiting"),
    ('(code-repos)', "CODE-UNREACHABLE ConnectError", "unreachable"),
    ('(send "x")', "HIVE-ERROR spend_limit: swarm has spent $500.00", "budget"),
    ('(hive-goal-claim "g_1")', "HIVE-ERROR not_open: goal is claimed by a_0d39ba27", "refused"),
    ('(code-status)', "CODE-STATUS workspace ws_1 generation 3 run run_2: completed, exit code 0 (PASSED)", None),
    ('(send "hi")', "HIVE-MESSAGE-QUEUED", None),
]


def test_classifies_the_failures_minds_really_hit():
    for command, result, kind in SEEN:
        assert classify(command, result) == kind, (command, result)


def test_signature_blurs_ids_and_numbers_but_keeps_the_skill():
    a = signature('(code-open "g_1")', "CODE-APPROVAL-NEEDED p_41f7cc44 for code-workspace at 12")
    b = signature('(code-open "g_2")', "CODE-APPROVAL-NEEDED p_9a9a9a9a for code-workspace at 13")
    assert a == b and a.startswith("code-open ::")
    assert a != signature('(code-exec "x")', "CODE-APPROVAL-NEEDED p_41f7cc44 for code-workspace at 12")


def trace(client, agent, i, command, result):
    return client.post("/api/agent/trace", headers=agent_headers(agent),
                       json={"iteration": i, "response": "", "commands": [{"command": command, "result": result}]})


def test_a_repeated_failure_is_a_loop_with_one_alert_and_a_hint(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    alerts = []
    original = hive.events.publish
    hive.events.publish = lambda kind, **kw: alerts.append(kw["alert"]) if kind == "health.alert" else original(kind, **kw)
    for i in range(5):
        trace(client, a, i, '(code-check)', "CODE-ERROR action_forbidden: action is outside this capability")
    trace(client, b, 1, '(send "hi")', "HIVE-MESSAGE-QUEUED")
    assert len(alerts) == 1 and alerts[0]["kind"] == "loop" and alerts[0]["agent_id"] == a["id"]
    report = client.get(f"/api/agents/{a['id']}/health").json()
    kinds = {i["kind"]: i for i in report["issues"]}
    assert report["health"] == "high" and kinds["loop"]["count"] >= 3 and kinds["loop"]["hint"]
    assert kinds["error"]["count"] == 5 and "action_forbidden" in kinds["error"]["example"]["result"]
    overview = client.get("/api/health").json()
    names = [m["name"] for m in overview["minds"]]
    assert names.index(a["name"]) < names.index(b["name"])            # worst first
    assert next(m for m in overview["minds"] if m["id"] == b["id"])["health"] == "ok"


def alerts_of(hive):
    """The health.alert events the hive publishes from now on, each event still published."""
    alerts, original = [], hive.events.publish

    def publish(kind, **kw):
        if kind == "health.alert":
            alerts.append(kw["alert"])
        return original(kind, **kw)
    hive.events.publish = publish
    return alerts


def test_the_same_command_with_the_same_result_four_times_is_a_repeat_with_one_alert(client):
    _, (a, _) = make_swarm_and_agents(client)
    alerts = alerts_of(client.app.state.hive)
    for i in range(3):
        trace(client, a, i, '(shell "ls /data")', "notes.txt")
    assert alerts == []                                           # three times is not yet a repeat
    for i in range(3, 6):
        trace(client, a, i, '(shell "ls /data")', "notes.txt")
    assert [(x["kind"], x["severity"], x["count"]) for x in alerts] == [("repeat", "medium", 4)]   # once, then quiet
    report = client.get(f"/api/agents/{a['id']}/health").json()
    repeat = next(i for i in report["issues"] if i["kind"] == "repeat")
    assert report["health"] == "medium" and repeat["count"] >= 4 and repeat["example"]["command"] == '(shell "ls /data")'


def test_a_repeat_alert_goes_out_even_if_the_presence_check_fails(client, monkeypatch):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    alerts = alerts_of(hive)
    command, result = '(shell "ls /data")', "notes.txt"

    def unavailable(_agent):
        raise RuntimeError("presence unavailable")

    for i in range(3):
        assert trace(client, a, i, command, result).status_code == 200
    with monkeypatch.context() as fault:
        fault.setattr(hive, "present_for", unavailable)
        assert trace(client, a, 3, command, result).status_code == 200
    assert [(alert["agent_id"], alert["kind"], alert["count"]) for alert in alerts] == [(a["id"], "repeat", 4)]

    assert trace(client, a, 4, command, result).status_code == 200
    assert len(alerts) == 1


def test_a_repeat_alert_retries_after_publication_fails(client, monkeypatch):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    alerts = alerts_of(hive)
    publish = hive.events.publish
    command, result = '(shell "ls /data")', "notes.txt"

    def fail_alert(kind, **payload):
        if kind == "health.alert":
            raise RuntimeError("alert publication unavailable")
        return publish(kind, **payload)

    for i in range(3):
        assert trace(client, a, i, command, result).status_code == 200
    with monkeypatch.context() as fault:
        fault.setattr(hive.events, "publish", fail_alert)
        assert trace(client, a, 3, command, result).status_code == 200
    assert alerts == []

    assert trace(client, a, 4, command, result).status_code == 200
    assert trace(client, a, 5, command, result).status_code == 200
    assert [(alert["agent_id"], alert["kind"], alert["count"]) for alert in alerts] == [(a["id"], "repeat", 5)]


def test_a_changing_result_or_a_wait_is_never_a_repeat(client):
    _, (a, _) = make_swarm_and_agents(client)
    alerts = alerts_of(client.app.state.hive)
    for i in range(6):     # a job's progress: the same command, a result that moves
        trace(client, a, i, '(code-status)', f"CODE-STATUS workspace ws_1 run run_2: running, {i * 10}% done")
    for i in range(6, 12):   # a mind waiting
        trace(client, a, i, '(wait "600")', "WAITING:600")
    assert alerts == []
    issues = client.get(f"/api/agents/{a['id']}/health").json()["issues"]
    assert not [i for i in issues if i["kind"] in ("repeat", "loop")]


def test_waiting_approvals_and_crashes_show_up(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post("/api/agent/authorize", headers=agent_headers(a), json={"command": '(shell-confirm "ls")'})
    client.app.state.hive.db.update("agents", a["id"], {"status": "error", "last_error": "crashed 5 times in 5 minutes"})
    kinds = {i["kind"] for i in client.get(f"/api/agents/{a['id']}/health").json()["issues"]}
    assert {"waiting", "crash"} <= kinds


def test_health_needs_a_signed_in_operator(client):
    client.headers.pop("Authorization", None)
    assert client.get("/api/health").status_code == 401


def test_old_problems_are_listed_as_earlier_and_do_not_count(client):
    _, (a, _) = make_swarm_and_agents(client)
    for i in range(4):
        trace(client, a, i, '(code-check)', "CODE-ERROR action_forbidden: action is outside this capability")
    hive = client.app.state.hive
    hive.db.execute("UPDATE traces SET created_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = ?", (a["id"],))
    report = client.get(f"/api/agents/{a['id']}/health").json()
    assert report["health"] == "ok" and report["issues"] and not any(i["recent"] for i in report["issues"])
    trace(client, a, 9, '(code-check)', "CODE-ERROR action_forbidden: action is outside this capability")
    fresh = client.get(f"/api/agents/{a['id']}/health").json()
    assert fresh["health"] == "high"   # the same failure again: the old loop is still going, so it counts now
    assert {i["kind"] for i in fresh["issues"] if i["recent"]} >= {"loop", "error"}


def test_refused_model_calls_show_as_a_budget_problem(client):
    import pytest
    from hive.core.hive import HiveError
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    client.post("/api/budgets", json={"scope": f"agent:{a['id']}", "period": "total", "limit_usd": 0})
    with pytest.raises(HiveError):
        hive.check_budget(hive.agent(a["id"]), paid=True, estimate=0.01)
    report = client.get(f"/api/agents/{a['id']}/health").json()
    budget = [i for i in report["issues"] if i["kind"] == "budget"]
    assert report["health"] == "high" and budget and budget[0]["recent"] and any(c in budget[0]["example"]["result"] for c in ("spend_limit", "no_budget"))


def test_the_health_mind_hears_alerts_and_alone_reads_the_overview(client):
    import asyncio
    _, (a, doctor) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    assert client.get("/api/agent/health", headers=agent_headers(doctor)).status_code == 403
    client.put("/api/health/mind", json={"agent_id": doctor["id"]})
    assert client.get("/api/health/mind").json()["agent_id"] == doctor["id"]
    for i in range(4):
        trace(client, a, i, '(code-check)', "CODE-ERROR action_forbidden: action is outside this capability")
    assert asyncio.run(hive.health.deliver()) == 1
    texts = [m["text"] for m in client.get("/api/agent/inbox", headers=agent_headers(doctor)).json()["messages"]]
    assert any("[HEALTH-ALERT]" in t and a["id"] in t for t in texts)
    overview = client.get("/api/agent/health", headers=agent_headers(doctor))
    assert overview.status_code == 200 and any(m["id"] == a["id"] and m["health"] == "high" for m in overview.json()["minds"])
    assert client.get("/api/agent/health", headers=agent_headers(a)).status_code == 403


def test_a_mind_that_never_connected_after_starting_is_reported(client):
    """2026-10-08: cloud minds dialled an address the server does not listen on and sat at 'starting' while health
    said ok. A start that has not reached the hub after UNCONNECTED_S is a high issue with one live alert per start;
    a fresh start, a restart (set_status stamps its moment) and a connected mind are not."""
    from hive.core.health import _stamp_ago
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    limit = hive.health.UNCONNECTED_S
    old, fresh = _stamp_ago(limit + 60), _stamp_ago(limit - 60)
    hive.db.update("agents", a["id"], {"status": "starting", "last_active_at": old})
    hive.db.update("agents", b["id"], {"status": "starting", "last_active_at": fresh})
    report = client.get(f"/api/agents/{a['id']}/health").json()
    kinds = {i["kind"]: i for i in report["issues"]}
    assert report["health"] == "high" and kinds["unconnected"]["recent"] and kinds["unconnected"]["hint"]
    assert f"starting since {old}" in kinds["unconnected"]["example"]["result"]
    assert client.get(f"/api/agents/{b['id']}/health").json()["health"] == "ok"
    alerts = []
    original = hive.events.publish
    hive.events.publish = lambda kind, **kw: alerts.append(kw["alert"]) if kind == "health.alert" else original(kind, **kw)
    assert [x["agent_id"] for x in hive.health.check_unconnected()] == [a["id"]]
    assert hive.health.check_unconnected() == [] and len(alerts) == 1 and alerts[0]["kind"] == "unconnected"   # once per start
    hive.set_status(a["id"], "starting")              # an automatic restart: a new start, not yet overdue
    assert client.get(f"/api/agents/{a['id']}/health").json()["health"] == "ok"
    hive.db.update("agents", a["id"], {"status": "awake"})
    assert client.get(f"/api/agents/{a['id']}/health").json()["health"] == "ok"
