"""Purpose: verify settled spending alerts and explicit pauses at the API and shared liability boundary."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json

import pytest

from hive.core.cost_reservations import Reservations
from hive.core.conductor import _Stop, check_detail, limit_frame, stop_say
from hive.core.db import stamp_of
from hive.core.hive import HiveError
from hive.core.spend_monitor import SPEND_PAUSE_WORDS, SpendMonitor
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401
from hive.tests.test_cost_reservations import MODEL, _fake_chat, _gateway
from hive.tests.test_visibility import person


AT = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
API = "/api/usage/spend-alerts"


def _ledger(db, mind, amount, at, key_person=None):
    db.insert("usage", {
        "agent_id": mind["id"], "swarm_id": mind.get("swarm_id"), "model": mind["model"],
        "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": amount, "created_at": stamp_of(at),
        "key_person": key_person,
    })


def _own_key(hive, key_id, owner):
    # the secret is split so the repository's secret scan (tests/test_repo_boundary.py) never reads it as a real key
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": "openrouter", "label": "own", "owner": owner,
                                         "secret": "sk-or-" + "v1-synthetic"}


def _cap(db, amount, period="month"):
    db.insert("budgets", {"id": "hive-test-cap", "scope": "hive", "period": period,
                          "limit_usd": amount, "created_at": stamp_of(AT)})


def _alerts(client, headers=None):
    result = client.get(API, headers=headers)
    assert result.status_code == 200, result.text
    return result.json()["alerts"]


def _control(client, alert, action, headers=None):
    return client.post(f"{API}/{alert['id']}/control", json={"action": action}, headers=headers)


def test_only_committed_paid_usage_is_counted_and_incidents_survive_restart(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, (first, second) = make_swarm_and_agents(client)
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    _ledger(hive.db, first, 0, AT)
    manager = Reservations(hive.db)
    budgets = lambda: [("hive:month", 50, 0)]
    manager.reserve("held", {}, 5, budgets, metadata={"agent": first["id"]}, dispatched=True)
    with pytest.raises(RuntimeError):
        with hive.db.transaction():
            _ledger(hive.db, second, 10, AT)
            monitor.sweep()
            raise RuntimeError("rollback")
    monitor.sweep()
    assert _alerts(client) == []
    assert manager.settle("held", 1, lambda: _ledger(hive.db, first, 1, AT))
    assert not manager.settle("held", 1, lambda: pytest.fail("settlement replay wrote usage"))
    with ThreadPoolExecutor(2) as executor:
        list(executor.map(lambda _: monitor.sweep(), range(2)))
    initial = _alerts(client)
    assert {(alert["scope"], alert["spent_usd"]) for alert in initial} == {("hive", 1), ("mind", 1)}
    assert all(alert["opened_at"] == stamp_of(AT) for alert in initial)
    SpendMonitor(hive, clock=lambda: AT + timedelta(seconds=5)).sweep()
    for opened, current in zip(initial, _alerts(client), strict=True):
        assert {**current, "projected_usd": opened["projected_usd"]} == opened
        if opened["scope"] == "hive":
            assert 50 < current["projected_usd"] < opened["projected_usd"]
        else:
            assert current["projected_usd"] is None

    monitor.clock = lambda: AT + timedelta(hours=7)
    monitor.sweep()
    assert _alerts(client) == []
    _ledger(hive.db, first, 1.2, monitor.clock() + timedelta(seconds=1))
    monitor.clock = lambda: AT + timedelta(hours=7, seconds=5)
    monitor.sweep()
    assert {alert["id"] for alert in _alerts(client)}.isdisjoint(alert["id"] for alert in initial)


def test_same_time_history_leaves_usual_spend_quiet_and_catches_a_burst(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, (mind,) = make_swarm_and_agents(client, n=1)
    _cap(hive.db, 500)
    monitor.clock = lambda: AT
    _ledger(hive.db, mind, 0.2, AT - timedelta(days=8))
    for day in range(8):
        _ledger(hive.db, mind, 0.2, AT - timedelta(days=day, seconds=30))
    monitor.sweep()
    assert _alerts(client) == []
    _ledger(hive.db, mind, 0.9, AT + timedelta(seconds=1))
    monitor.clock = lambda: AT + timedelta(seconds=5)
    monitor.sweep()
    result = _alerts(client)
    assert {(row["scope"], row["spent_usd"]) for row in result} == {("hive", 1.1), ("mind", 1.1)}
    assert next(row for row in result if row["scope"] == "hive")["projected_usd"] is None


def test_distributed_spend_triggers_only_the_hive_and_names_the_cap_forecast(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, minds = make_swarm_and_agents(client, n=3)
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    for mind in minds:
        _ledger(hive.db, mind, 0.4, AT - timedelta(seconds=5))
    monitor.sweep()
    [alert] = _alerts(client)
    assert (alert["scope"], alert["spent_usd"], alert["limit_usd"]) == ("hive", 1.2, 50)
    assert alert["projected_usd"] > 50
    assert alert["agent_id"] is None and alert["name"] is None


def test_an_open_alert_refreshes_its_spend_window_and_cap_forecast(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, (mind,) = make_swarm_and_agents(client, n=1)
    _cap(hive.db, 2)
    now = AT.replace(day=30, hour=18)
    monitor.clock = lambda: now
    hints = []
    hive.events.publish = lambda kind, **data: hints.append((kind, data))

    def hive_alert():
        return next(alert for alert in _alerts(client) if alert["scope"] == "hive")

    _ledger(hive.db, mind, 0.061, now)
    monitor.sweep()
    opening = hive_alert()
    assert (opening["spent_usd"], opening["window_seconds"], opening["projected_usd"]) == (0.061, 3600, None)
    hints.clear()

    now += timedelta(seconds=5)
    monitor.sweep()
    assert hive_alert() == opening
    assert hints == []

    _ledger(hive.db, mind, 1.1, now)
    now += timedelta(minutes=10)
    monitor.sweep()
    updated = hive_alert()
    assert (updated["id"], updated["opened_at"], updated["closed_at"]) == (opening["id"], opening["opened_at"], None)
    assert (updated["spent_usd"], updated["window_seconds"], updated["limit_usd"]) == (1.161, 21600, 2)
    assert updated["projected_usd"] > 2
    expected_hint = ("spend.alert", {"principal": hive.ownhive.owner(), "alert_id": opening["id"]})
    assert hints.count(expected_hint) == 1
    hints.clear()

    hive.db.update("budgets", "hive-test-cap", {"limit_usd": 4})
    now += timedelta(seconds=5)
    monitor.sweep()
    raised_cap = hive_alert()
    assert raised_cap == {**updated, "limit_usd": 4, "projected_usd": None}
    assert hints == [expected_hint]


def test_current_owners_control_only_their_spending_scope(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    system = person(client, "u_system", role="admin")
    assert hive.ownhive.owner() == "user:u_system"
    other_admin = person(client, "u_other", role="admin")
    member = person(client, "u_member")
    _, (mind,) = make_swarm_and_agents(client, n=1)
    hive.db.update("agents", mind["id"], {"owner": "user:u_member"})
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    _ledger(hive.db, mind, 2, AT - timedelta(seconds=1))
    frames = []
    hive.events.publish = lambda kind, **data: frames.append({"type": kind, **data})
    monitor.sweep()
    [hive_alert] = _alerts(client, system)
    [mind_alert] = _alerts(client, member)
    assert (hive_alert["scope"], mind_alert["agent_id"], mind_alert["name"]) == ("hive", mind["id"], mind["name"])
    assert _alerts(client, other_admin) == []
    assert _control(client, mind_alert, "pause", system).status_code == 404
    assert _control(client, mind_alert, "pause", other_admin).status_code == 404
    assert _control(client, hive_alert, "pause", member).status_code == 404
    assert _control(client, hive_alert, "pause", system).json()["paused"]
    assert [a for a in _alerts(client, member) if a["paused"]] == []
    assert _control(client, mind_alert, "pause", member).json()["paused"]
    assert not _control(client, hive_alert, "resume", system).json()["paused"]
    assert _alerts(client, member)[0]["paused"]
    assert _control(client, mind_alert, "pause", member).json()["paused"]
    assert hive.db.one("SELECT COUNT(*) AS n FROM spend_pause_receipts")["n"] == 3
    frame = next(row for row in frames if row["type"] == "spend.alert" and row["alert_id"] == mind_alert["id"])
    text = json.dumps(frame)
    assert hive.visibility.event_visible(Viewer("user:u_member", False), text)
    assert not hive.visibility.event_visible(Viewer("user:u_system", True), text)
    hive.db.update("agents", mind["id"], {"owner": "user:u_other"})
    assert _control(client, mind_alert, "resume", member).status_code == 404
    assert _alerts(client, member) == []
    assert _alerts(client, other_admin) == []
    monitor.require_new_paid_call(mind["id"])
    monitor.clock = lambda: AT + timedelta(seconds=5)
    monitor.sweep()
    assert _alerts(client, other_admin) == []    # a new owner never inherits the prior owner's spending alert
    assert _alerts(client, system)[0]["spent_usd"] == 2
    hive.db.update("agents", mind["id"], {"owner": "user:u_member"})
    monitor.require_new_paid_call(mind["id"])   # returning to the prior owner cannot resurrect its earlier pause


def test_alert_alone_admits_calls_then_explicit_pause_and_resume_reach_gateway(client):
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, (target, other) = make_swarm_and_agents(client, model=MODEL, budget_usd=20)
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    _ledger(hive.db, target, 2, AT - timedelta(seconds=1))
    monitor.sweep()
    alerts = {row["scope"]: row for row in _alerts(client)}
    assert set(alerts) == {"mind", "hive"}
    _fake_chat(_gateway(client), delay=0)
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 10}

    def call(mind):
        return client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(mind))

    assert call(target).status_code == 200
    manager = Reservations(hive.db, admission=monitor.require_new_paid_call)
    budgets = lambda: [("hive:month", 50, 2)]
    manager.reserve("preexisting", {}, 0.1, budgets, {"agent": target["id"]})
    assert _control(client, alerts["mind"], "pause").json()["paused"]
    refused = call(target)
    assert (refused.status_code, refused.json()["error"]["code"]) == (402, "mind_spend_paused")
    assert call(other).status_code == 200
    manager.dispatch("preexisting")
    assert manager.settle("preexisting", 0.05, lambda: _ledger(hive.db, target, 0.05, AT))
    with pytest.raises(HiveError, match="owner paused"):
        manager.reserve("after", {}, 0.01, budgets, {"agent": target["id"]})
    assert _control(client, alerts["hive"], "pause").json()["paused"]
    assert call(other).json()["error"]["code"] == "hive_spend_paused"
    assert _control(client, alerts["hive"], "resume").status_code == 200
    assert call(other).status_code == 200
    assert call(target).json()["error"]["code"] == "mind_spend_paused"

    monitor.clock = lambda: AT + timedelta(hours=7)
    monitor.sweep()
    [closed] = _alerts(client)
    assert closed["closed_at"] and closed["paused"] and closed["can_control"]
    assert _control(client, closed, "resume").status_code == 200
    assert _alerts(client) == []
    assert _control(client, closed, "pause").status_code == 409
    assert call(target).status_code == 200


def test_a_members_own_key_spend_is_theirs_and_the_hive_pause_leaves_it(client):
    """Jon's desk on #706, under #615's own-admin rule: the hive's totals and its pause cover the hive's money alone,
    its keys and its owner's. A member's own-key spend opens only their mind's alert, a hive pause lets their calls
    on their own key go on, and only their own mind's pause holds them."""
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    system = person(client, "u_system", role="admin")
    member = person(client, "u_member")
    _, (mind, hive_mind) = make_swarm_and_agents(client, n=2)
    hive.db.update("agents", mind["id"], {"owner": "user:u_member"})
    _own_key(hive, "k_0a0a0a0a", "user:u_member")
    _own_key(hive, "k_0b0b0b0b", "user:u_system")
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    _ledger(hive.db, mind, 2, AT - timedelta(seconds=1), key_person="user:u_member")
    monitor.sweep()
    assert _alerts(client, system) == []                 # the member's own key is not the hive's money
    [mind_alert] = _alerts(client, member)
    assert (mind_alert["scope"], mind_alert["spent_usd"]) == ("mind", 2)

    _ledger(hive.db, hive_mind, 2, AT, key_person="user:u_system")   # the owner's own key is the hive's
    monitor.clock = lambda: AT + timedelta(seconds=5)
    monitor.sweep()
    [hive_alert] = [alert for alert in _alerts(client, system) if alert["scope"] == "hive"]
    assert hive_alert["spent_usd"] == 2
    assert _control(client, hive_alert, "pause", system).json()["paused"]
    manager = Reservations(hive.db, admission=monitor.require_new_paid_call)
    budgets = lambda: [("hive:month", 50, 4)]
    manager.reserve("own key", {}, 0.1, budgets, {"agent": mind["id"], "key": "k_0a0a0a0a"})
    for n, key in enumerate((None, "k_0b0b0b0b")):     # the hive's key and the owner's own key: held
        with pytest.raises(HiveError, match="hive owner paused"):
            manager.reserve(f"hive money {n}", {}, 0.1, budgets, {"agent": mind["id"], "key": key})
    assert _control(client, mind_alert, "pause", member).json()["paused"]
    with pytest.raises(HiveError, match="owner paused"):
        monitor.require_new_paid_call(mind["id"], "k_0a0a0a0a")   # their own pause holds their own key


def test_the_hive_forecast_counts_only_the_hive_money(client):
    """A member's own-key spend earlier in the month is theirs, so it never brings the hive's cap forecast forward."""
    hive = client.app.state.hive
    monitor = client.app.state.spend_monitor
    _, (mind,) = make_swarm_and_agents(client, n=1)
    _cap(hive.db, 50)
    monitor.clock = lambda: AT
    _ledger(hive.db, mind, 0.01, AT - timedelta(seconds=5))
    _ledger(hive.db, mind, 49.5, AT - timedelta(days=13), key_person="user:u_member")
    monitor.sweep()
    assert [alert for alert in _alerts(client) if alert["scope"] == "hive"] == []
    _ledger(hive.db, mind, 49.5, AT - timedelta(days=13))   # the same spend on the hive's money
    monitor.clock = lambda: AT + timedelta(seconds=5)
    monitor.sweep()
    [forecast] = [alert for alert in _alerts(client) if alert["scope"] == "hive"]
    assert forecast["projected_usd"] > 50


def test_each_usage_row_records_whose_own_key_paid(client):
    hive = client.app.state.hive
    _, (mind,) = make_swarm_and_agents(client, n=1)
    _own_key(hive, "k_0a0a0a0a", "user:u_member")
    for key, paid_by in (("k_0a0a0a0a", "user:u_member"), (None, None)):
        hive.record_usage(mind, mind["model"], {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.01,
                                                "key_id": key})
        assert hive.db.one("SELECT key_person FROM usage ORDER BY id DESC LIMIT 1")["key_person"] == paid_by


@pytest.mark.parametrize("code", SPEND_PAUSE_WORDS)
def test_ask_preserves_the_pause_scope_and_names_who_can_resume(code):
    detail = check_detail(None, {}, HiveError(402, code, SPEND_PAUSE_WORDS[code]), 0.02)
    assert limit_frame(detail)["kind"] == code
    assert stop_say(_Stop("spend_cap", detail)) == SPEND_PAUSE_WORDS[code]
