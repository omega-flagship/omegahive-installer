# Purpose: tests that every limit payload carries what calls not yet settled hold against it beside its spend: the
# Limits page rows, the limits view, a person's own spend, and the count with no reservations set up.
"""Holds beside spend: Peter's limits showed spend with room left while held worst cases filled them, so admission
refused calls the page said had room. Every payload that shows a limit's spend now carries held_usd, the count admission
adds (pending_micros). Synthetic minds and people and a scripted provider that times out: no network."""
import httpx
import pytest

from hive.core.cost_reservations import Reservations, held_usd
from hive.core.db import Database
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_unbilled_refusal_release import MODEL, _failing_chat, _post
from hive.tests.test_visibility import person


def _hold(client):
    """One mind with one call held unknown at about 5 cents (a timeout never says what it cost)."""
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=1.0)
    _failing_chat(client.app.state.gateway, httpx.ReadTimeout("no answer"))
    _post(client, a)
    held = client.get("/api/budgets/reservations").json()
    assert len(held) == 1 and held[0]["state"] == "unknown"
    return a, held[0]["held_usd"]


def test_the_limits_page_rows_carry_what_is_held(client):
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 10}).status_code == 200
    a, hold = _hold(client)
    assert client.post("/api/budgets", json={"scope": "swarm:" + a["swarm_id"], "period": "day", "limit_usd": 5}).status_code == 200
    rows = {(r["scope"], r["period"]): r for r in client.get("/api/budgets").json()}
    assert rows[("hive", "month")]["held_usd"] == pytest.approx(hold) and rows[("hive", "month")]["spent_usd"] == 0
    assert rows[("swarm:" + a["swarm_id"], "day")]["held_usd"] == pytest.approx(hold)   # a rule set after the hold counts it too


def test_the_limits_view_carries_what_is_held_on_every_row(client):
    assert client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 10}).status_code == 200
    a, hold = _hold(client)
    assert client.post("/api/budgets", json={"scope": "swarm:" + a["swarm_id"], "period": "month", "limit_usd": 5}).status_code == 200
    view = client.get("/api/budgets/limits").json()
    cap = view["hive"]["cap"]
    assert cap["held_usd"] == pytest.approx(hold) and cap["room_usd"] == pytest.approx(10 - hold)
    assert view["caps"] and all(r["held_usd"] == pytest.approx(hold) for r in view["caps"])
    mind = next(m for m in view["minds"] if m["agent_id"] == a["id"])
    assert mind["limits"] and all(r["held_usd"] == pytest.approx(hold) for r in mind["limits"])


def test_a_persons_own_spend_carries_what_is_held_against_their_allowance(client):
    member = person(client, "u_0e0e0e0e")
    hive = client.app.state.hive
    res = Reservations(hive.db)
    res.reserve("k-member", {"p": 1}, 0.05, lambda: [("person:u_0e0e0e0e:month", 50.0, 0.0)],
                metadata={"agent": "a_x", "payer": "user:u_0e0e0e0e"}, dispatched=True, subjects=["person:u_0e0e0e0e"])
    res.unknown("k-member")
    me = client.get("/api/usage/me", headers=member).json()
    assert me["allowance_usd"] == 50.0 and me["held_usd"] == pytest.approx(0.05) and me["hive_paid_usd"] == 0


def test_held_usd_is_zero_where_reservations_were_never_set_up(tmp_path):
    assert held_usd(Database(tmp_path / "h.db"), "hive:month") == 0.0
