# Purpose: tests of the limit notices: 50, 80 and 100% of a person's allowance and of the hive cap, each once a month per
# figure, again in a new month or for a new figure but never after a restart, a refusal at an allowance as its 100%
# notice with the admins asked for more, and the hive cap's notices going to the admins.
"""Limit notices (limit_notices.py, Hive.record_usage, Hive.note_refusal)."""
import json

import pytest

from hive.core import budgets as budgets_mod
from hive.core import limit_notices as notices_mod
from hive.core.limit_notices import LimitNotices
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

MEMBER, ADMIN, OTHER = "u_0a0b0c0d", "u_1a1b1c1d", "u_2a2b2c2d"


def hive_of(client):
    return client.app.state.hive


def world(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1, budget_usd=500)
    person(client, MEMBER)
    person(client, ADMIN, role="admin")
    return hive_of(client), hive_of(client).agent(a["id"])


def pay(h, agent, usd, payer=f"user:{MEMBER}"):
    h.record_usage(agent, "m", {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd}, payer=payer)


def heard(h, pid):
    return [r["text"] for r in h.db.all("SELECT text FROM notices WHERE principal = ? AND kind = 'hive' ORDER BY seq",
                                        (f"user:{pid}",))]


def test_each_threshold_notifies_once_a_month(client):
    h, a = world(client)
    pay(h, a, 20)
    assert heard(h, MEMBER) == []                                         # 40% of the $50 member default
    pay(h, a, 6)
    assert heard(h, MEMBER) == ["You've used 50% of your $50.00 monthly allowance ($26.00 spent this month)."]
    pay(h, a, 1)
    assert len(heard(h, MEMBER)) == 1                                     # still past 50%: nothing new
    pay(h, a, 14)
    assert heard(h, MEMBER)[-1] == "You've used 80% of your $50.00 monthly allowance ($41.00 spent this month)."
    assert heard(h, ADMIN) == []                                          # an allowance's 50 and 80% are the person's
    pay(h, a, 9)
    assert heard(h, MEMBER)[-1].startswith("Your $50.00 monthly allowance has no room left ($50.00 spent this month)")
    assert heard(h, ADMIN) == [f"{MEMBER}'s $50.00 monthly allowance has no room left ($50.00 spent this month). "
                               "A request for more is waiting in Requests."]
    asked = h.db.all("SELECT payload FROM person_requests WHERE requested_by = ? AND kind = 'allowance'", (f"user:{MEMBER}",))
    assert [json.loads(r["payload"])["monthly_usd"] for r in asked] == [100.0]   # the hive's own ask, once
    pay(h, a, 5)
    assert len(heard(h, MEMBER)) == 3 and len(heard(h, ADMIN)) == 1       # past 100%: nothing new this month
    assert {(r["label"], r["threshold"]) for r in h.db.all("SELECT label, threshold FROM limit_notices")} == {
        (f"person:{MEMBER}:month", t) for t in (50, 80, 100)}


def test_one_call_crossing_several_thresholds_posts_one_notice(client):
    h, a = world(client)
    pay(h, a, 42)
    assert heard(h, MEMBER) == ["You've used 80% of your $50.00 monthly allowance ($42.00 spent this month)."]
    assert {r["threshold"] for r in h.db.all("SELECT threshold FROM limit_notices")} == {50, 80}


def test_a_new_month_starts_again_and_a_restart_never_repeats_one(client, monkeypatch):
    h, a = world(client)
    pay(h, a, 30)
    assert len(heard(h, MEMBER)) == 1
    LimitNotices(h).after_usage(f"user:{MEMBER}")                        # a restart: the marks are in the database
    pay(h, a, 1)
    assert len(heard(h, MEMBER)) == 1
    later = "2099-03-01T00:00:00.000Z"                                   # a later month, its own spend
    monkeypatch.setattr(budgets_mod, "period_start", lambda period, moment=None: later if period == "month" else later)
    monkeypatch.setattr(notices_mod, "period_start", lambda period, moment=None: later)
    h.db.insert("usage", {"agent_id": a["id"], "model": "m", "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 27,
                          "created_at": "2099-03-02T00:00:00Z", "payer": f"user:{MEMBER}"})
    h.limit_notices.after_usage(f"user:{MEMBER}")
    assert heard(h, MEMBER)[-1] == "You've used 50% of your $50.00 monthly allowance ($27.00 spent this month)."


def test_a_new_figure_notifies_again(client):
    h, a = world(client)
    pay(h, a, 26)
    assert len(heard(h, MEMBER)) == 1
    h.budgets.set(f"person:{MEMBER}", "month", 100)                       # raised: its own thresholds
    pay(h, a, 1)
    assert len(heard(h, MEMBER)) == 1                                     # 27% of $100
    pay(h, a, 24)
    assert heard(h, MEMBER)[-1] == "You've used 50% of your $100.00 monthly allowance ($51.00 spent this month)."


def test_a_refusal_at_the_allowance_is_the_100_percent_notice(client):
    h, a = world(client)
    h.budgets.set(f"person:{MEMBER}", "month", 1)
    pay(h, a, 0.95)
    assert heard(h, MEMBER) == ["You've used 80% of your $1.00 monthly allowance ($0.95 spent this month)."]
    with pytest.raises(Exception) as refused:
        h.check_budget(h.agent(a["id"]), paid=True, estimate=0.1, payer=f"user:{MEMBER}")
    assert refused.value.code == "spend_limit" and refused.value.details["scope"] == f"person:{MEMBER}"
    assert heard(h, MEMBER)[-1].startswith("Your $1.00 monthly allowance has no room left ($0.95 spent this month)")
    assert len(heard(h, ADMIN)) == 1
    assert h.db.one("SELECT COUNT(*) AS n FROM person_requests WHERE requested_by = ? AND kind = 'allowance'",
                    (f"user:{MEMBER}",))["n"] == 1                       # asked once, by the refusal (note_refusal)
    with pytest.raises(Exception):
        h.check_budget(h.agent(a["id"]), paid=True, estimate=0.1, payer=f"user:{MEMBER}")
    assert len(heard(h, MEMBER)) == 2 and len(heard(h, ADMIN)) == 1       # the next refusal posts nothing new


def test_the_hive_caps_notices_go_to_admins(client):
    h, a = world(client)
    person(client, OTHER, role="admin")
    h.budgets.set("hive", "month", 10)
    pay(h, a, 5, payer="hive")                                            # a hive mind's call, nobody's allowance
    for pid in (ADMIN, OTHER):
        assert heard(h, pid) == ["The hive has used 50% of its $10.00 monthly cap ($5.00 spent this month)."]
    assert heard(h, MEMBER) == []
    pay(h, a, 5, payer="hive")
    assert heard(h, ADMIN)[-1] == ("The hive's $10.00 monthly cap has no room left ($10.00 spent this month), so paid "
                                   "calls wait until it's raised or the month ends.")
    h.budgets.set("hive", "day", 1)
    h.db.execute("DELETE FROM budgets WHERE scope = 'hive' AND period = 'month'")
    pay(h, a, 1, payer="hive")
    assert len(heard(h, ADMIN)) == 2                                      # a day cap has no monthly notice


def test_an_admins_own_allowance_is_theirs_once_and_a_notice_that_cannot_post_never_stops_a_call(client, monkeypatch, caplog):
    from hive.core.hive import HiveError
    h, a = world(client)
    h.budgets.set(f"person:{ADMIN}", "month", 2)
    pay(h, a, 2, payer=f"user:{ADMIN}")
    assert len(heard(h, ADMIN)) == 1                                      # their own notice, not a second admin copy

    def refuse(principal, text):
        raise HiveError(429, "rate_limited", "at most 200 notices a day reach one person")
    monkeypatch.setattr(h.notices, "from_hive", refuse)
    pay(h, a, 30)                                                         # 60%: the notice can't be posted
    assert h.db.one("SELECT COUNT(*) AS n FROM usage WHERE payer = ?", (f"user:{MEMBER}",))["n"] == 1
    assert "limit notice to user:u_0a0b0c0d not posted: rate_limited" in caplog.text
    assert (f"person:{MEMBER}:month", 50) in {(r["label"], r["threshold"]) for r in h.db.all("SELECT * FROM limit_notices")}
