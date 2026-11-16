# Purpose: tests that nobody settles a held call by hand: each held call says how and when it settles itself, the
# hand-settle routes are gone and Correct all takes estimates only, the reconcile pass settles from OpenRouter's record
# with any overrun marked as the provider's, and a deleted mind's held call still settles against its team, through the
# real routes, the store and the reconcile pass.
"""Held calls settle themselves. The operator, on the Usage page (2026-11-12): settling every held call by hand is
"very annoying", "you can set a budget, right?". A held call settles from its answer, from OpenRouter's record of it,
or, when its outcome stays unknown, at its worst case an hour on as an estimate a person may correct; the one place a
person is asked is a call that would cross a limit they set, which admission refuses.

Synthetic minds and a scripted provider that times out: no network and no provider calls.
"""
import time

import httpx
import pytest

from hive.core.cost_reservations import UNKNOWN_EXPIRY_SECONDS, Reservations
from hive.core.db import Database
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_unbilled_refusal_release import MODEL, _failing_chat, _ok_chat, _post  # noqa: F401  (_ok_chat for importers)

ROUTE = "/api/budgets/reservations/correct"   # Correct all: estimates only


def _held(client, n, budget=1.0, swarm=None):
    """A mind with n calls held unknown at about 5 cents each: a timeout never says what it cost."""
    if swarm is None:
        _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=budget)
    else:
        a = client.post("/api/agents", json={"name": "Later", "swarm_id": swarm, "model": MODEL, "budget_usd": budget}).json()
    _failing_chat(client.app.state.gateway, httpx.ReadTimeout("no answer"))
    for _ in range(n):
        _post(client, a)
    held = [h for h in client.get("/api/budgets/reservations").json() if h["metadata"].get("agent") == a["id"]]
    assert len(held) == n and {h["state"] for h in held} == {"unknown"}
    return a, held


def _expire(client):
    """Age every unknown outcome past the hour and run one reconcile pass."""
    client.app.state.hive.db.execute("UPDATE cost_reservations SET unknown_at = ? WHERE state = 'unknown'",
                                     (time.time() - UNKNOWN_EXPIRY_SECONDS - 1,))
    client.portal.call(client.app.state.reconcile_once)


def test_each_held_call_says_how_and_when_it_settles_itself(client):
    a, (timed_out,) = _held(client, 1)                      # a timeout leaves no record to read: an estimate at the hour
    res = Reservations(client.app.state.hive.db)
    res.reserve("k-record", {"p": 1}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": a["id"], "model": "openrouter/x/y"},
                dispatched=True)
    res.observe("k-record", {"response_id": "gen-abc123"})   # an OpenRouter answer with its id but no usage
    res.unknown("k-record")
    res.reserve("k-flight", {"p": 2}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": a["id"]}, dispatched=True)
    rows = {r["id"]: r for r in client.get("/api/budgets/reservations").json()}
    est = rows[timed_out["id"]]
    assert est["settles"] == "estimate" and est["auto_settles_at"] == pytest.approx(est["unknown_at"] + UNKNOWN_EXPIRY_SECONDS)
    assert rows["k-record"]["settles"] == "record" and rows["k-record"]["auto_settles_at"]   # the hour stays its backstop
    assert rows["k-flight"]["settles"] == "answer" and rows["k-flight"]["auto_settles_at"] is None
    assert not any("resolvable" in r for r in rows.values())                                 # nothing waits on a person


def test_nobody_settles_a_held_call_by_hand(client):
    a, (h,) = _held(client, 1)
    assert client.post(f"/api/budgets/reservations/{h['id']}/resolve",
                       json={"action": "release", "reason": "billing shows nothing"}).status_code in (404, 405)
    assert client.post("/api/budgets/reservations/resolve",
                       json={"action": "release", "ids": [h["id"]], "reason": "billing shows nothing"}).status_code in (404, 405)
    r = client.post(ROUTE, json={"action": "release", "ids": [h["id"]], "reason": "billing shows nothing"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_correctable"
    assert "not settled at an estimate" in r.json()["error"]["message"]
    assert [x["state"] for x in client.get("/api/budgets/reservations").json()] == ["unknown"]   # nothing changed
    _expire(client)                                         # an hour on it settles by itself, and then it can be corrected
    r = client.post(ROUTE, json={"action": "release", "ids": [h["id"]], "reason": "billing shows nothing"})
    assert r.status_code == 200 and r.json()["count"] == 1 and r.json()["estimate_usd"] == pytest.approx(h["held_usd"])
    assert [x["actual"] for x in r.json()["corrected"]] == [0]
    assert client.app.state.hive.agent(a["id"])["spent_usd"] == pytest.approx(0)


def test_a_record_above_the_hold_settles_and_is_an_overrun_the_provider_reported(tmp_path):
    from hive.core.cost_reservations import overruns, settle_from_record
    db = Database(tmp_path / "h.db")
    res = Reservations(db)
    res.reserve("k", {"p": 1}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": "a", "model": "openrouter/x/y"},
                dispatched=True)
    res.observe("k", {"response_id": "gen-1"})
    res.unknown("k")
    recorded, flagged = [], []
    reason = "OpenRouter's record of gen-1 reports $0.080000"
    assert settle_from_record(res, "k", 0.08, reason, recorded.append, flagged.append) is True
    assert recorded == [0.08] and res.get("k")["state"] == "settled" and res.get("k")["actual"] == 80_000
    (over,) = overruns(res)
    assert over["source"] == "provider-record" and [f["source"] for f in flagged] == ["provider-record"]
    assert db.one("SELECT decided_by, reason FROM cost_reservation_resolutions WHERE reservation = 'k'") == \
        {"decided_by": "hive:provider-record", "reason": "OpenRouter's record of gen-1 reports $0.080000"}
    assert settle_from_record(res, "k", 0.08, reason, recorded.append) is False and recorded == [0.08]   # settled already


def test_the_expiry_settles_a_deleted_minds_call_against_its_team_and_carries_on_to_the_next(client):
    a, first = _held(client, 1)
    b, second = _held(client, 1, swarm=a["swarm_id"])
    assert client.delete(f"/api/agents/{a['id']}").status_code == 200
    hive = client.app.state.hive
    _expire(client)
    states = {r["id"]: r["state"] for r in hive.db.all("SELECT id, state FROM cost_reservations")}
    assert states == {first[0]["id"]: "settled", second[0]["id"]: "settled"}
    assert hive.agent(b["id"])["spent_usd"] == pytest.approx(second[0]["held_usd"])
    team = hive.db.one("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE swarm_id = ?", (a["swarm_id"],))["c"]
    assert team == pytest.approx(first[0]["held_usd"] + second[0]["held_usd"])
