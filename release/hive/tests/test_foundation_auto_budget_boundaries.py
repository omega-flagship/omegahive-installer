"""R6 budget boundaries against the existing real app/DB test fixtures.

Source only, UNRUN. FakeSupervisor and the existing invented-key/service
currentness counterpart never execute a provider or native mind. All budget,
reservation, request/grant/lease and read-model methods remain actual methods.
This file is supplemental; the original three regression files are untouched.
"""
import asyncio
import datetime

import pytest

from hive.core.cost_reservations import Reservations, host_budget_snapshot
from hive.core.db import new_id, now
from hive.core.foundation import CODE, REVIEW, CHILD_TEMPLATE, foundation_budget_ids
from hive.core.hive import HiveError
from hive.core.limits_view import limits, auto_candidates
from hive.tests.test_auto_budgets import api_effective, snapshot
from hive.tests.test_hive_foundation import (  # original real-app fixture and explicit external counterpart
    available, controller, controlled_environment, f,
)
from hive.tests.test_mind_control import person
from hive.tests.test_model_route import hive_app


def ordinary(hive, name="Ordinary", count=1, budget=0):
    team = hive.create_swarm(name, visibility="public")
    actors = [hive.create_agent(name + str(i), swarm_id=team["id"],
                               model="mock/echo", budget_usd=budget) for i in range(count)]
    return team, actors


def applicable(hive, actor):
    return {(s, p): (amount, origin) for s, p, amount, origin in hive.budgets.applicable(hive.agent(actor["id"]))}


def test_two_host_bindings_do_not_change_ordinary_shares_or_store_derived_rules(f):
    team, actors = ordinary(f, count=3)
    f.budgets.set("hive", "month", 1000)
    before = f.budgets.rules()
    rows = applicable(f, actors[0])
    assert f.budgets.derive()["active_teams"] == 1
    assert rows[("swarm:" + team["id"], "month")][0] == 1000
    assert rows[("swarm:" + team["id"], "day")][0] == 100
    assert rows[("agent:" + actors[0]["id"], "month")][0] == pytest.approx(666.666666)
    ordinary(f, "Second")
    ordinary(f, "Third")
    assert f.budgets.derive()["active_teams"] == 3
    assert applicable(f, actors[0])[("swarm:" + team["id"], "month")][0] == pytest.approx(666.666666)
    assert f.budgets.rules() == before
    assert controller(f)["budget_usd"] == .50 and controller(f, REVIEW)["budget_usd"] == .25


def test_fallback_and_limits_projection_keep_ordinary_first_and_retain_host_caps(f):
    team, (actor,) = ordinary(f, budget=1)
    rows = f.budgets.overview()
    assert [(r["scope"], r["origin"], r["limit_usd"]) for r in rows] == [("swarm:" + team["id"], "default", 500)]
    view = limits(f.budgets)
    swarms, minds = foundation_budget_ids(f.db)
    assert view["teams"][0]["swarm_id"] == team["id"] and view["minds"][0]["agent_id"] == actor["id"]
    assert swarms <= {r["swarm_id"] for r in view["teams"]}
    assert minds <= {r["agent_id"] for r in view["minds"]}
    for aid in (actor["id"], *minds):
        assert api_effective(view, aid) == snapshot(f, aid)
    for row in view["teams"]:
        if row["swarm_id"] in swarms:
            assert row["month"] is None and row["day"] is None and not row["active"]


@pytest.mark.parametrize("period", ["month", "day"])
@pytest.mark.parametrize("amount", [0, .25, 500])
def test_explicit_host_rule_still_binds_but_does_not_reduce_the_ordinary_pool(f, period, amount):
    team, (actor,) = ordinary(f)
    b = f.foundation._binding(CODE)
    rule = f.budgets.set("swarm:" + b["swarm_id"], period, amount)
    f.budgets.set("hive", "month", 1000)
    assert applicable(f, actor)[("swarm:" + team["id"], "month")][0] == 1000
    bound = applicable(f, controller(f))
    assert bound[("swarm:" + b["swarm_id"], period)] == (amount, rule["id"])
    assert ("hive", "month") in bound and ("hive", "day") in bound
    if amount == 0:
        with pytest.raises(ValueError):
            Reservations(f.db).reserve("host-zero-rule", {"synthetic": 1}, .000001,
                                        lambda: host_budget_snapshot(f, b["agent_id"]))


@pytest.mark.parametrize("which", ["controller", "member"])
def test_zero_host_actor_cannot_gain_a_panel_allowance_after_exclusion(f, which):
    b = f.foundation._binding(CODE)
    if which == "controller":
        actor = controller(f)
        f.db.execute("UPDATE agents SET budget_usd=0 WHERE id=?", (actor["id"],))
    else:
        # Synthetic member, not an admitted child or a delegated capability.
        actor = f.create_agent("Zero member", swarm_id=b["swarm_id"], model="mock/echo", budget_usd=0)
    _, (normal,) = ordinary(f)
    f.budgets.set("hive", "month", 1000)
    current = f.agent(actor["id"])
    assert not f.budgets.paid_without_cap(current)
    assert f.budgets.remaining_for(current) == 0
    assert f.budgets.paid_without_cap(f.agent(normal["id"]))
    rows = {key: amount for key, amount, _ in host_budget_snapshot(f, actor["id"])}
    assert rows["agent:" + actor["id"] + ":total"] == 0
    with pytest.raises(ValueError):
        Reservations(f.db).reserve("zero-host-actor", {"synthetic": 1}, .000001,
                                    lambda: host_budget_snapshot(f, actor["id"]))


def test_original_person_allowance_and_own_key_gate_remain_explicit(f, monkeypatch):
    pid = "u_" + "a" * 32
    person(f, pid, role="member")
    principal = "user:" + pid
    f.budgets.set("hive", "month", 1000)
    f.budgets.set("person:" + pid, "month", .07)
    actor = dict(controller(f), budget_usd=0, personal_of=principal)
    # An interface input, not a conversion/admission of the actual controller
    # into a personal mind. Real stored person rule drives the allowance gate.
    assert f.budgets.paid_without_cap(actor, payer=principal)
    assert not f.budgets.paid_without_cap(actor, payer="user:u_wrong")
    # Only key/total read facts are synthetic here; original own_key_bound and
    # monthly_total perform the exact payer/key/turn-bound conjunction.
    monkeypatch.setattr(f.ownhive, "key_owner", lambda key: principal if key == "synthetic-key" else None)
    monkeypatch.setattr(f.ownhive, "total_row", lambda who: {"scope": "keyuse:synthetic", "month_usd": .08} if who == principal else None)
    assert f.budgets.paid_without_cap(actor, payer=principal, own_key=True,
                                      key_id="synthetic-key", turn_bound=True)
    assert not f.budgets.paid_without_cap(actor, payer=principal, own_key=True,
                                          key_id="wrong-key", turn_bound=True)
    assert not f.budgets.paid_without_cap(actor, payer=principal, own_key=True,
                                          key_id="synthetic-key", turn_bound=False)


@pytest.mark.parametrize("state", ["reserved", "dispatched", "unknown"])
def test_host_usage_and_holds_still_exhaust_the_one_global_pool(f, state):
    team, (actor,) = ordinary(f, budget=1)
    ctl = controller(f)
    f.budgets.set("hive", "month", .25)
    f.budgets.set("hive", "day", 1000)
    f.budgets.set("swarm:" + team["id"], "day", 1000)
    f.db.insert("usage", {"agent_id": ctl["id"], "model": "synthetic/no-provider",
        "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": .02,
        "created_at": now(), "swarm_id": ctl["swarm_id"]})
    f.db.execute("UPDATE agents SET spent_usd=.02 WHERE id=?", (ctl["id"],))
    res = Reservations(f.db)
    res.reserve("host-held", {"synthetic": 1}, .20, lambda: host_budget_snapshot(f, ctl["id"]),
                metadata={"agent": ctl["id"]})
    if state in ("dispatched", "unknown"):
        res.dispatch("host-held")
    if state == "unknown":
        res.unknown("host-held")
    assert f.budgets.spent("hive", "month") == .02
    assert res.pending("hive:month") == 200000
    with pytest.raises(ValueError, match="hive:month"):
        res.reserve("ordinary-over", {"synthetic": 2}, .04, lambda: host_budget_snapshot(f, actor["id"]))
    assert res.reserve("ordinary-fits", {"synthetic": 3}, .03,
                       lambda: host_budget_snapshot(f, actor["id"]))["new"]
    assert res.pending("hive:month") == 230000


@pytest.mark.parametrize("cap", [.50, .10, 0])
def test_limits_projection_matches_snapshot_for_original_and_lower_host_caps(f, cap):
    team, (normal,) = ordinary(f, budget=1)
    ctl = controller(f)
    f.db.execute("UPDATE agents SET budget_usd=? WHERE id=?", (cap, ctl["id"]))
    f.budgets.set("hive", "month", 1000)
    view = limits(f.budgets)
    assert view["teams"][0]["swarm_id"] == team["id"]
    assert view["minds"][0]["agent_id"] == normal["id"]
    for aid in (normal["id"], ctl["id"], controller(f, REVIEW)["id"]):
        assert api_effective(view, aid) == snapshot(f, aid)
    row = next(m for m in view["minds"] if m["agent_id"] == ctl["id"])
    assert row["budget_usd"] == cap and not row["auto"]


def test_auto_candidate_projection_uses_the_same_ordinary_participants(f):
    team, (actor,) = ordinary(f, "First", budget=5)
    ordinary(f, "Second", budget=5)
    ordinary(f, "Third", budget=5)
    ctl = controller(f)
    f.db.execute("UPDATE agents SET budget_usd=5 WHERE id=?", (ctl["id"],))
    f.budgets.set("swarm:" + ctl["swarm_id"], "month", 500)
    f.budgets.set("hive", "month", 1000)
    view = auto_candidates(f.budgets)
    candidate = next(r for r in view["candidates"] if r.get("agent_id") == actor["id"])
    assert candidate["auto_usd"] == pytest.approx(666.666666)
    swarms, minds = foundation_budget_ids(f.db)
    assert not [r for r in view["candidates"] if r.get("agent_id") in minds or r.get("swarm_id") in swarms]


def test_names_other_purposes_and_removed_bindings_are_not_exclusion_authority(f):
    one, _ = ordinary(f, "Create · Code")
    two, _ = ordinary(f, "Review")
    three, (actor,) = ordinary(f, "Third")
    stamp = now()
    f.db.insert("person_minds", {"principal": "user:synthetic", "purpose": "foundation_review_old",
        "swarm_id": one["id"], "agent_id": actor["id"], "created_at": stamp, "updated_at": stamp})
    f.budgets.set("hive", "month", 1000)
    excluded, _ = foundation_budget_ids(f.db)
    assert not {one["id"], two["id"], three["id"]} & excluded
    assert f.budgets.derive()["active_teams"] == 3
    old = f.foundation._binding(REVIEW)
    f.db.execute("DELETE FROM person_minds WHERE purpose=?", (REVIEW,))
    assert old["swarm_id"] not in foundation_budget_ids(f.db)[0]
    assert f.budgets.derive()["active_teams"] == 4
    assert applicable(f, actor)[("swarm:" + three["id"], "month")][0] == 500


def test_exact_bound_actor_drift_is_not_auto_admission_or_a_new_share(f):
    team = f.create_swarm("Other membership", visibility="public")
    ctl = controller(f)
    f.db.execute("UPDATE agents SET swarm_id=?,budget_usd=0 WHERE id=?", (team["id"], ctl["id"]))
    f.budgets.set("hive", "month", 1000)
    assert f.budgets.derive()["active_teams"] == 0
    assert not f.budgets.paid_without_cap(f.agent(ctl["id"]))
    assert not [r for r in f.budgets.derive()["limits"] if r[0] == "agent:" + ctl["id"]]
    row = next(t for t in limits(f.budgets)["teams"] if t["swarm_id"] == team["id"])
    assert row["minds"] == 1 and not row["active"]
    with pytest.raises(HiveError, match="budget binding"):
        host_budget_snapshot(f, ctl["id"])


def request_setup(hive_app, monkeypatch):
    hive, client, _operator, _google, _supervisor = hive_app
    pid = new_id("u")
    headers = person(hive, pid)  # original synthetic named-admin fixture, not a lease/controller fabrication
    principal = "user:" + pid
    hive.foundation.ensure()
    available(hive, monkeypatch)  # existing explicit service/key-price counterpart; never a provider call
    hive.foundation.ensure()
    hive.budgets.set("hive", "month", 1000)
    origin = hive.create_swarm("Synthetic request origin", owner=principal, visibility="public")
    task = asyncio.run(hive.goals.create(origin["id"], "Budget boundary", created_by=principal))
    grant = hive.services.grant(task["id"], principal, "edit", None, 120, by=principal)
    binding = hive.foundation._binding(CODE)
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=120)).isoformat()
    body = {"operation_id": "op-foundation-budget-0001", "to_swarm": binding["swarm_id"],
        "kind": "code", "title": "Synthetic calculator", "instruction": "Propose only; do not apply.",
        "origin": {"task_id": task["id"], "repository_id": "synthetic", "workspace_id": "ws_synthetic",
                   "scope_id": "scope_synthetic", "scope_digest": "sha256:" + "ab" * 32, "generation": 1},
        "budget": {"limit_usd": .20}, "lifetime": {"until": until},
        "lease": {"template_ids": [CHILD_TEMPLATE], "max_children": 1}}
    return hive, client, headers, principal, binding, grant, body


def test_budgeted_original_person_request_gets_its_original_lease_without_native_payment(hive_app, monkeypatch):
    hive, client, headers, principal, binding, grant, body = request_setup(hive_app, monkeypatch)
    response = client.post("/api/requests", headers=headers, json=body)
    assert response.status_code == 201, response.text
    result = response.json()
    request = hive.db.one("SELECT * FROM requests WHERE id=?", (result["request_id"],))
    lease = hive.db.one("SELECT * FROM mind_leases WHERE id=?", (result["lease_id"],))
    assert request["from_principal"] == principal and request["limit_usd"] == .20
    assert lease["controller_id"] == binding["agent_id"] and lease["grant_id"] == grant["id"]
    assert lease["max_children"] == 1 and lease["ceiling_usd"] == .20
    assert hive.db.all("SELECT * FROM mind_children") == [] and hive.db.all("SELECT * FROM usage") == []


@pytest.mark.parametrize("refusal", ["stored_zero", "lower_seed", "host_cap", "policy", "unfunded"])
def test_original_request_refusals_still_create_no_lease_or_paid_work(hive_app, monkeypatch, refusal):
    hive, client, headers, principal, binding, _grant, body = request_setup(hive_app, monkeypatch)
    if refusal == "stored_zero":
        hive.budgets.set("swarm:" + binding["swarm_id"], "day", 0)
    elif refusal == "lower_seed":
        hive.settings.person_request_ceiling_usd = .10
        hive.settings.budget_env = {"HIVE_PERSON_REQUEST_CEILING_USD": ".10"}
    elif refusal == "host_cap":
        body["budget"] = {"limit_usd": .250001}
    elif refusal == "policy":
        hive.policy.add_rule("agent:" + binding["agent_id"], "code-mind-spawn", "deny", granted_by=principal)
    else:
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    before = tuple(hive.db.one("SELECT COUNT(*) n FROM " + t)["n"] for t in ("requests", "mind_leases", "mind_children", "usage"))
    response = client.post("/api/requests", headers=headers, json=body)
    assert response.status_code in (402, 403, 409), response.text
    code = response.json()["error"]["code"]
    if refusal in ("stored_zero", "lower_seed"):
        assert code == "spend_limit"
    elif refusal == "host_cap":
        assert code == "foundation_limits"
    else:
        assert code in ("foundation_unavailable", "not_offered")
    after = tuple(hive.db.one("SELECT COUNT(*) n FROM " + t)["n"] for t in ("requests", "mind_leases", "mind_children", "usage"))
    assert after == before
    if refusal == "stored_zero":
        assert hive.budgets.request_ceiling(binding["swarm_id"])[0] == 0
    elif refusal == "lower_seed":
        assert hive.budgets.request_ceiling(binding["swarm_id"])[0] == .10


def test_the_team_templates_read_states_the_limits_a_request_is_admitted_within(hive_app, monkeypatch):
    """A person composes the request inside the host-bound limits (Create's Code bench reads them) instead of guessing
    and being refused 403 foundation_limits; a request one step over any of them is still refused."""
    hive, client, headers, principal, binding, grant, body = request_setup(hive_app, monkeypatch)
    out = client.get(f"/api/teams/{binding['swarm_id']}/templates", headers=headers).json()
    assert out["request_limits"] == {"limit_usd": 0.25, "max_children": 1, "lifetime_seconds": 600,
                                     "template_ids": [CHILD_TEMPLATE]}
    over = dict(body, operation_id="op-foundation-budget-over", budget={"limit_usd": 0.5})
    r = client.post("/api/requests", headers=headers, json=over)
    assert r.status_code == 403 and r.json()["error"]["code"] == "foundation_limits"
    at = dict(body, operation_id="op-foundation-budget-at", budget={"limit_usd": out["request_limits"]["limit_usd"]})
    assert client.post("/api/requests", headers=headers, json=at).status_code == 201


def test_a_generic_team_states_no_request_limits(hive_app):
    hive, client, _operator, _google, _supervisor = hive_app
    pid = new_id("u")
    headers = person(hive, pid)
    team = hive.create_swarm("Generic team", owner="user:" + pid, visibility="public")
    assert "request_limits" not in client.get(f"/api/teams/{team['id']}/templates", headers=headers).json()
