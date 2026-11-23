"""Purpose: test that a mind with no cap of its own spends on its person's own key whatever the hive's month total, and
that the places that say whether a mind may spend say the same (Jon on #650: "a person's own key should just work").

Budgets.paid_without_cap lets a mind with budget_usd 0 through when the person its call is for pays, on a key that is
theirs, or, on the hive's money, once the hive has a total, a Foundation-bound mind the same way (Jon on 23 Nov: "ONE
cap for the whole hive").
The table test below walks that rule case by case on the call path (Hive.check_budget and the reservation snapshot), with
each case's payer read from Hive.payer_for rather than chosen. Synthetic people, a fake priced provider, invented keys; no
network.
"""
import pytest

from hive.core.config import Provider
from hive.core.cost_reservations import (BudgetExhausted, Reservations, host_admission_view, host_budget_snapshot,
                                         host_subjects, reservable_micros)
from hive.core.ownhive import scope_of
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1 import add_key, labels, money, refusal, total  # noqa: F401  (fixture)

KF, KH = "k_000000f1", "k_000000f2"   # Pat's own key on the priced provider, and the hive's (no named owner)


@pytest.fixture()
def own(money):  # noqa: F811
    """money's hive (no hive total) with a priced provider and two keys on it: Pat's own (KF) and the hive's (KH, the
    provider's default, applied as the keyring applies a default). Zed: Pat's ordinary mind with no cap, assigned KF. Ivy:
    Pat's, no cap and no key of its own, so the hive's default pays. Ole: the owner's ordinary mind with no cap. Hux: a
    hive mind with no person behind it and no cap."""
    http, hive = money["client"], money["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    add_key(hive, KF, money["P"], provider="fakepaid")
    add_key(hive, KH, "hive", provider="fakepaid")
    hive.keyring.ring["defaults"]["fakepaid"] = KH
    hive.keyring._apply_defaults()

    def zero(headers, name, swarm_id, options=None):
        body = {"name": name, "kind": "omega", "swarm_id": swarm_id, "model": "fakepaid/x", "budget_usd": 0}
        if options:
            body["options"] = options
        r = http.post("/api/agents", headers=headers, json=body)
        assert r.status_code in (200, 201), r.text
        row = hive._agent_row(r.json()["id"])
        assert float(row["budget_usd"] or 0) == 0
        return row

    owner_swarm = http.post("/api/swarms", headers=money["owner"], json={"name": "The owner's lab"}).json()["id"]
    pats = money["vega"]["swarm_id"]
    hux = hive._agent_row(hive.create_agent("Hux", "omega", owner_swarm, "fakepaid/x", budget_usd=0.0)["id"])
    assert hive.user_for(hux) == "hive"   # given no owner, create_agent stores user:operator, which names no person
    return {**money, "zed": zero(money["pat"], "Zed", pats, {"key": KF}), "ivy": zero(money["pat"], "Ivy", pats),
            "ole": zero(money["owner"], "Ole", owner_swarm), "hux": hux}


CASES = {   # case: (mind, key, whether the call is Pat's own, as an Ask turn or a session of Pat's makes it)
    "own-key": ("zed", KF, False),              # Pat's mind on Pat's key
    "asker-own-key": ("ole", KF, True),         # Pat asking the owner's mind, moved onto Pat's key (own_key_for)
    "hive-mind": ("hux", KF, False),            # Pat's key paying for a hive mind with no person behind it
    "another-person": ("ole", KF, False),       # the owner's own call on Pat's key, billed to Pat (H1.1)
    "hive-key": ("zed", KH, False),             # Pat's mind on the hive's key: the hive's money
}


def outcome(case, hive_total):
    """admitted when the person the call is for pays on their own key, or the hive has a total, a Foundation-bound mind
    alike; else 402 no_budget. Under a total, a call for another person on Pat's key is still refused, by
    OwnHive.person_key_check (OI-13 r1.1: own_key_needed)."""
    if not (case in ("own-key", "asker-own-key") or hive_total):
        return "no_budget"
    return "own_key_needed" if case == "another-person" else "admitted"


@pytest.mark.parametrize("hive_total", [False, True], ids=["no-total", "total"])
@pytest.mark.parametrize("foundation", [False, True], ids=["ordinary", "foundation"])
@pytest.mark.parametrize("case", list(CASES))
def test_a_mind_with_no_cap_is_admitted_on_its_persons_own_key_or_under_a_hive_total(own, monkeypatch, case, foundation,
                                                                                    hive_total):
    hive, P = own["hive"], own["P"]
    name, key_id, pats_call = CASES[case]
    mind = own[name]
    if pats_call:
        user_for = hive.user_for
        monkeypatch.setattr(hive, "user_for", lambda a: P if a.get("id") == mind["id"] else user_for(a))
    payer, own_key = hive.payer_for(mind, hive.keyring.ring["keys"][key_id]["owner"])
    assert (payer, own_key) == (P, case != "hive-key")
    if foundation:
        monkeypatch.setattr(hive.budgets, "_foundation_ids", lambda: (frozenset(), frozenset({mind["id"]})))
    if hive_total:
        hive.budgets.set("hive", "month", 100.0)
    expected, lifetime = outcome(case, hive_total), f"agent:{mind['id']}:total"
    if expected == "admitted":
        hive.check_budget(mind, True, 0.05, key_id, payer, own_key)
    else:
        assert refusal(hive.check_budget, mind, True, 0.05, key_id, payer, own_key).code == expected
    rows = {s: limit for s, limit, _spent in host_budget_snapshot(hive, mind["id"], key_id, payer, own_key)}
    # the $0 lifetime row is a reservation row exactly where no_budget refuses (one source: paid_without_cap)
    assert (rows.get(lifetime) == 0) if expected == "no_budget" else (lifetime not in rows)


def test_a_mind_on_its_persons_own_key_spends_with_no_hive_total_and_their_own_limit_holds_it(own):
    hive, P, zed = own["hive"], own["P"], own["zed"]
    assert hive.budgets.hive_cap() is None
    settled = hive.budgets.settlement(zed, zed["model"], turn_bound=False)
    assert (settled["key_id"], settled["payer"], settled["own_key"]) == (KF, P, True)
    assert settled["reason"] != "not_admitted"
    total(hive, P, 1.0)                                    # Pat's own limit on all their keys
    assert hive.budgets.settlement(zed, zed["model"], turn_bound=False)["bounded"]   # and it holds the call
    res = Reservations(hive.db)
    res.reserve("own-1", {"x": 1}, 0.6, lambda: host_budget_snapshot(hive, zed["id"], KF, P, True),
                {"agent": zed["id"], "payer": P, "key": KF}, dispatched=True)
    res.settle("own-1", 0.6, lambda: hive.record_usage(zed, "fakepaid/x", {"prompt_tokens": 1, "completion_tokens": 1,
                                                                             "cost_usd": 0.6, "key_id": KF}, None, P))
    assert hive.ownhive.spent(scope_of(P, "*", "self")) == pytest.approx(0.6)
    e = refusal(hive.check_budget, zed, True, 0.5, KF, P, True)   # 0.6 spent + 0.5 would cross Pat's $1
    assert (e.code, e.details["scope"]) == ("spend_limit", scope_of(P, "*", "self"))
    hive.check_budget(zed, True, 0.3, KF, P, True)              # what is left of it still goes


def test_an_own_key_call_nothing_limits_reserves_under_its_persons_own_keys_and_a_later_limit_counts_it(own,
                                                                                                   monkeypatch):
    """No hive total, no limit of Pat's own and no cap on the mind, its team or the key: nothing limits Pat's call on
    Pat's key, which is Pat's money to spend, so it still reserves, held under Pat's own keys' scope as a label that
    caps nothing (as an Ask turn's label is), and the limit Pat sets later counts that hold. Without the label the call
    had no reservation row at all, and Reservations.reserve refused it after Budgets.check had admitted it."""
    hive, P, zed = own["hive"], own["P"], own["zed"]
    monkeypatch.setattr(hive.settings, "swarm_monthly_usd", 0, raising=False)   # no team fallback row either
    label = scope_of(P, "*", "self") + ":month"
    assert host_budget_snapshot(hive, zed["id"], KF, P, True) == [(label, None, 0.0)]
    assert reservable_micros(hive, zed["id"], KF, P, True) is None          # no row limits it
    assert host_admission_view(hive, zed["id"], KF, P, True) == []
    hive.check_budget(zed, True, 0.4, KF, P, True)
    res = Reservations(hive.db)

    def hold(rid, usd):
        return res.reserve(rid, {"rid": rid}, usd, lambda: host_budget_snapshot(hive, zed["id"], KF, P, True),
                           {"agent": zed["id"], "payer": P, "key": KF}, dispatched=True,
                           subjects=host_subjects(hive, zed["id"], KF, P, True))
    hold("own-1", 0.4)
    hold("own-2", 0.4)
    total(hive, P, 1.0)                                    # the limit Pat sets now counts both holds
    with pytest.raises(BudgetExhausted) as e:
        hold("own-3", 0.3)
    assert (e.value.scope, e.value.held_usd) == (label, pytest.approx(0.8))


def test_the_limits_page_the_inventory_and_the_greeting_say_what_the_gateway_admits(own):
    http, hive, zed, ivy = own["client"], own["hive"], own["zed"], own["ivy"]
    minds = {m["agent_id"]: m for m in http.get("/api/budgets/limits", headers=own["owner"]).json()["minds"]}
    assert minds[zed["id"]]["paid_calls"] == "allowed"
    assert f"agent:{zed['id']}:total" not in [r["key"] for r in minds[zed["id"]]["limits"]]
    assert minds[ivy["id"]]["paid_calls"] == "no_budget"
    row = next(r for r in minds[ivy["id"]]["limits"] if r["key"] == f"agent:{ivy['id']}:total")
    assert row["limit_usd"] == 0 and row["note"] == "no paid calls on the hive's money until it has a cap or the hive has one"
    route = http.get(f"/api/agents/{zed['id']}/inventory", headers=own["pat"]).json()["provider"]
    assert f"agent:{zed['id']}:total" not in route["budget_route"] and route["budget_route_note"] is None
    route = http.get(f"/api/agents/{ivy['id']}/inventory", headers=own["pat"]).json()["provider"]
    assert f"agent:{ivy['id']}:total" in route["budget_route"]
    assert hive.onboarding.preflight(zed) is None             # the greeting can go on Pat's key
    assert refusal(hive.onboarding.preflight, ivy).code == "no_budget"   # the hive's default pays, and it has no total
