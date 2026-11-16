# Purpose: tests of the stored spending rules in the host: the every-mind cap, HIVE_BUDGET_USD as a seed until the hive has
# a cap, uncapped minds under a hive cap, session defaults, the Limits view's old defaults and visibility, holds against
# rules set later, legacy holds and micro-dollar exactness.
"""Spending rules in the host: Budgets.applicable / overview, admission and reservations, the env-as-seed rule (Jon
2026-10-07), session defaults, and the limits API. Nothing is derived: every row a call meets is one someone stored."""

import pytest

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL as PAID, _fake_chat, _gateway
from hive.tests.test_spend_rate_guard import MonthApart



def hive_of(client):
    return client.app.state.hive


def set_rule(client, scope, period, limit):
    r = client.post("/api/budgets", json={"scope": scope, "period": period, "limit_usd": limit})
    assert r.status_code == 200, r.text
    return r.json()


def keyed(rows):
    return {(s, p): (limit, origin) for s, p, limit, origin in rows}


def test_every_mind_is_a_month_cap_on_each_mind_not_a_pool(client):
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    h = hive_of(client)
    bad = client.post("/api/budgets", json={"scope": "every-mind", "period": "day", "limit_usd": 5})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_period"
    set_rule(client, "every-mind", "month", 20)
    rows = keyed(h.budgets.applicable(h.agent(a["id"])))
    assert rows[(f"agent:{a['id']}", "month")] == (20, "every-mind") and ("every-mind", "month") not in rows
    over = {r["scope"]: r for r in client.get("/api/budgets").json()}
    assert over["every-mind"]["spent_usd"] == 0 and over["every-mind"]["origin"] == "rule"


def chat(client, agent, max_tokens=50):
    _fake_chat(_gateway(client), delay=0)   # never a real provider call
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": max_tokens})


def cloud_like(client):
    """The cloud's settings file: one cent all-time for the hive."""
    h = hive_of(client)
    h.settings.hive_budget_usd = 0.01
    h.settings.budget_env = {"HIVE_BUDGET_USD": "0.01"}
    return h


def test_server_settings_seed_a_hive_without_a_cap(client):
    h = cloud_like(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID, budget_usd=50)
    r = chat(client, a, max_tokens=400)                      # could cost $0.03: over one cent
    assert r.status_code == 402 and r.json()["error"]["code"] in ("spend_limit", "hive_budget_exhausted")
    assert h.budgets.applicable(h.agent(a["id"])) == []      # no swarm default
    assert h.summary()["limits"]["hive_budget_usd"] == 0.01
    rows = {s["name"]: s for s in h.budgets.server_settings()}
    assert rows["HIVE_BUDGET_USD"] == {"name": "HIVE_BUDGET_USD", "value": 0.01, "set": True, "applies": True,
                                       "effect": "an all-time cap on the whole hive", "until_total": True}
    assert "HIVE_SWARM_MONTHLY_USD" not in rows and "HIVE_PERSON_REQUEST_CEILING_USD" not in rows


def test_the_hive_cap_replaces_the_server_settings(client):
    h = cloud_like(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID, budget_usd=50)
    cap = set_rule(client, "hive", "month", 1000)
    assert keyed(h.budgets.applicable(h.agent(a["id"]))) == {("hive", "month"): (1000, cap["id"])}
    assert h.budgets.hard_cap() == 0 and h.summary()["limits"]["hive_budget_usd"] == 0
    from hive.core.cost_reservations import host_budget_snapshot
    assert "hive:hard-total" not in {s for s, _, _ in host_budget_snapshot(h, a["id"])}
    assert chat(client, a).status_code == 200
    settings = {s["name"]: s for s in h.budgets.server_settings()}
    assert settings["HIVE_BUDGET_USD"]["set"] and not settings["HIVE_BUDGET_USD"]["applies"]
    assert "Limits page" in settings["HIVE_BUDGET_USD"]["effect"]


# ---- an uncapped mind under the hive cap, reservations ------------------------------------------------------------------

def spend(h, agent_id, usd):
    h.db.insert("usage", {"agent_id": agent_id, "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd,
                          "created_at": "2099-01-01T00:00:00Z", "swarm_id": h.agent(agent_id)["swarm_id"]})


def test_a_zero_budget_mind_still_needs_a_hive_cap(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    r = chat(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "no_budget"
    set_rule(client, "every-mind", "month", 20)                      # an every-mind cap alone does not open it
    assert chat(client, a).json()["error"]["code"] == "no_budget"


def test_a_zero_budget_mind_is_held_by_the_caps_set_once_a_hive_cap_exists(client):
    swarm, (a, b, c) = make_swarm_and_agents(client, n=3, model=PAID)
    h = hive_of(client)
    set_rule(client, "hive", "month", 30)
    set_rule(client, "every-mind", "month", 20)
    assert chat(client, a).status_code == 200                       # admitted under the hive cap
    from hive.core.cost_reservations import host_budget_snapshot
    labels = {s: limit for s, limit, _ in host_budget_snapshot(h, a["id"])}
    assert labels == {"hive:month": 30, f"agent:{a['id']}:month": 20}
    spend(h, a["id"], 19.999)
    r = chat(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit"
    assert r.json()["error"]["scope"] == f"agent:{a['id']}" and r.json()["error"]["rule"] == "every-mind"
    # the hive cap holds the others: with $29.999 spent across the hive, c's next call can't fit its $30
    spend(h, b["id"], 10.0)
    r = chat(client, c)
    assert r.status_code == 402 and (r.json()["error"]["scope"], r.json()["error"]["period"]) == ("hive", "month")


def test_concurrent_reservations_cannot_pass_the_every_mind_cap(client):
    import asyncio
    from hive.tests.test_cost_reservations import _two_calls
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    h = hive_of(client)
    set_rule(client, "hive", "month", 1000)
    set_rule(client, "every-mind", "month", 0.10)                   # each call reserves ~$0.0527; two would be $0.105
    _fake_chat(_gateway(client))
    codes = sorted(r.status_code for r in asyncio.run(_two_calls(client.app, a, 700)))
    assert codes == [200, 402], codes
    assert h.agent(a["id"])["spent_usd"] <= 0.10


def test_lowering_the_cap_refuses_the_next_reservation(client):
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    h = hive_of(client)
    cap = set_rule(client, "hive", "month", 1000)
    res = Reservations(h.db)
    assert res.reserve("r-1", {"x": 1}, 0.5, lambda: host_budget_snapshot(h, a["id"]))["new"]
    h.budgets.set("hive", "month", 0.6)                              # mid-flight: $0.5 already held
    assert cap["id"] == h.db.one("SELECT id FROM budgets WHERE scope = 'hive' AND period = 'month'")["id"]
    with pytest.raises(ValueError, match="Shared budget exhausted"):
        res.reserve("r-2", {"x": 2}, 0.2, lambda: host_budget_snapshot(h, a["id"]))


# ---- defaults sized from what a mind has left ---------------------------------------------------------------------------

def test_a_session_given_no_budget_takes_a_tenth_of_what_the_mind_has_left(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "No cap yet"}).json()
    assert s["budget_usd"] == 1.0                                       # no hive cap: $1 as before
    client.post(f"/api/sessions/{s['id']}/end")
    set_rule(client, "hive", "month", 1000)                             # headroom: the hive cap's $1000, no day at a tenth
    assert h.budgets.headroom(h.agent(a["id"])) == 1000
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Sized"}).json()
    assert s["budget_usd"] == 100                                       # a tenth, at most $100
    client.post(f"/api/sessions/{s['id']}/end")
    mind = next(m for m in client.get("/api/budgets/limits").json()["minds"] if m["agent_id"] == a["id"])
    assert (mind["headroom_usd"], mind["session_default_usd"], mind["lease_default_usd"], mind["paid_calls"]) == \
        (1000, 100, 100, "allowed")
    # the session's cap is machinery: nothing it set outlives the session
    assert keyed(h.budgets.applicable(h.agent(a["id"]))) == {("hive", "month"): (1000, h.budgets.hive_cap()["rule_id"])}
    assert client.post("/api/sessions", json={"mind": a["id"], "title": "Given", "budget_usd": 3}).json()["budget_usd"] == 3
    spend(h, a["id"], 1000)
    r = client.post("/api/sessions", json={"mind": a["id"], "title": "Nothing left"})
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit"


def test_what_a_mind_hands_on_is_its_caps_room_or_what_its_limits_leave(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    assert h.budgets.remaining_for(h.agent(a["id"])) == 0               # no cap and no hive cap: nothing to hand on
    set_rule(client, "hive", "month", 1000)
    set_rule(client, f"swarm:{swarm['id']}", "day", 7)
    assert h.budgets.remaining_for(h.agent(a["id"])) == 7               # a $0 mind: what its limits leave
    client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 2})
    assert h.budgets.remaining_for(h.agent(a["id"])) == 2               # a capped one: what its cap leaves, as before


# ---- the limits API: old form defaults and who may read it ---------------------------------------------------------------

def test_old_defaults_are_listed_and_nothing_is_written(client):
    h = hive_of(client)
    swarm, (a, b, c) = make_swarm_and_agents(client, n=3)
    client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 5})        # a form pre-fill
    client.patch(f"/api/agents/{b['id']}", json={"budget_usd": 7})        # chosen
    role = client.post("/api/roles", json={"name": "Thrifty", "prompt": "You are {name}.", "default_budget": 1.5}).json()
    r = client.post("/api/agents", json={"name": "Roled", "swarm_id": swarm["id"], "role_id": role["id"]}).json()
    assert h.agent(r["id"])["budget_usd"] == 1.5                         # copied from the role at creation
    other = client.post("/api/swarms", json={"name": "Old"}).json()
    noted = client.post("/api/swarms", json={"name": "Noted"}).json()
    inert = client.post("/api/swarms", json={"name": "Inert"}).json()
    old = set_rule(client, f"swarm:{other['id']}", "month", 500)
    client.post("/api/budgets", json={"scope": f"swarm:{noted['id']}", "period": "month", "limit_usd": 500, "note": "chosen"})
    set_rule(client, f"swarm:{inert['id']}", "month", 0)
    s = client.post("/api/sessions", json={"mind": c["id"], "title": "Machinery", "budget_usd": 5}).json()
    before = (h.db.all("SELECT * FROM budgets ORDER BY id"), h.db.all("SELECT id, budget_usd FROM agents ORDER BY id"))

    found = {x.get("agent_id") or x.get("swarm_id"): x for x in client.get("/api/budgets/limits").json()["old_defaults"]}
    assert set(found) == {a["id"], r["id"], other["id"]}
    assert found[a["id"]]["reset"] == {"method": "PATCH", "path": f"/api/agents/{a['id']}", "body": {"budget_usd": 0}}
    assert found[a["id"]]["change"].endswith("-> no paid calls until the hive has a cap")
    assert "Thrifty" in found[r["id"]]["reasons"][0]
    assert found[other["id"]]["reset"] == {"method": "DELETE", "path": f"/api/budgets/{old['id']}"}

    set_rule(client, "hive", "month", 1000)
    found = {x.get("agent_id") or x.get("swarm_id"): x for x in client.get("/api/budgets/limits").json()["old_defaults"]}
    assert found[a["id"]]["change"].endswith("-> the hive cap, its payer's allowance and the caps set on it")
    assert found[other["id"]]["change"].endswith("-> the hive cap and each payer's allowance")
    after = (h.db.all("SELECT * FROM budgets ORDER BY id"), h.db.all("SELECT id, budget_usd FROM agents ORDER BY id"))
    assert [x for x in after[0] if not (x["scope"] == "hive")] == before[0] and after[1] == before[1]   # nothing written
    client.post(f"/api/sessions/{s['id']}/end")


# ---- r2 (OmegaReview FIX-FIRST): admin-only limits, visibility, liabilities by subject --------------------------------

def test_limits_routes_are_admin_only_and_never_show_a_hidden_team(client):
    from hive.core.limits_view import limits, old_defaults
    from hive.core.visibility import Viewer
    from hive.tests.test_visibility import person
    h = hive_of(client)
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Ada", "kind": "module", "swarm_id": sw["id"]}).json()
    client.patch(f"/api/agents/{mind['id']}", json={"budget_usd": 5})
    set_rule(client, f"swarm:{sw['id']}", "month", 500)
    set_rule(client, "hive", "month", 1000)
    r = client.get("/api/budgets/limits", headers=bob)
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
    assert client.get("/api/budgets/limits", headers=ann).status_code == 403
    assert client.get("/api/budgets/limits").status_code == 200                # the admin
    listed = client.get("/api/budgets", headers=bob).json()
    assert not any(sw["id"] in r["scope"] or mind["id"] in r["scope"] for r in listed)
    assert any(r["scope"] == "hive" for r in listed)
    assert any(sw["id"] in r["scope"] for r in client.get("/api/budgets", headers=ann).json())
    # defence in depth: the read models filter a non-admin viewer too
    view = limits(h.budgets, Viewer("user:u_bob", False))
    assert sw["id"] not in str(view["caps"]) and mind["id"] not in str(view["minds"])
    assert old_defaults(h.budgets, Viewer("user:u_bob", False)) == []
    assert {c.get("agent_id") or c.get("swarm_id") for c in old_defaults(h.budgets)} == {mind["id"], sw["id"]}


def _team_mind(client, name, budget=50):
    sw = client.post("/api/swarms", json={"name": name}).json()
    return client.post("/api/agents", json={"name": name + "1", "swarm_id": sw["id"], "model": PAID, "budget_usd": budget}).json()


def _hold(h, res, mind_id, usd, tag):
    from hive.core.cost_reservations import host_budget_snapshot, host_subjects
    try:
        res.reserve(tag, {"t": tag}, usd, lambda: host_budget_snapshot(h, mind_id), subjects=host_subjects(h, mind_id))
        return True
    except ValueError as exc:
        assert "Shared budget exhausted" in str(exc)
        return False


def test_a_hold_made_before_the_total_counts_against_it(client):
    from hive.core.cost_reservations import Reservations
    h = hive_of(client)
    h.settings.hive_budget_usd = 1.0                                      # the seed cap
    a, b = _team_mind(client, "One"), _team_mind(client, "Two")
    res = Reservations(h.db)
    assert _hold(h, res, a["id"], 0.6, "r-a")                            # held under hive:hard-total
    set_rule(client, "hive", "month", 1.0)                               # the hive cap replaces the seed cap
    assert not _hold(h, res, b["id"], 0.5, "r-b")                        # another team: 0.6 held + 0.5 > 1.0
    assert _hold(h, res, b["id"], 0.4, "r-b2")


def test_a_hold_made_before_a_team_rule_counts_against_it(client):
    from hive.core.cost_reservations import Reservations
    h = hive_of(client)
    a = _team_mind(client, "One")
    a2 = client.post("/api/agents", json={"name": "One2", "swarm_id": a["swarm_id"], "model": PAID, "budget_usd": 50}).json()
    res = Reservations(h.db)
    assert _hold(h, res, a["id"], 0.6, "r-a")
    set_rule(client, f"swarm:{a['swarm_id']}", "month", 1.0)
    assert not _hold(h, res, a2["id"], 0.5, "r-a2")
    set_rule(client, f"agent:{a['id']}", "day", 0.7)                     # a mind rule after its own hold
    assert not _hold(h, res, a["id"], 0.2, "r-a3")


def test_a_hold_made_then_the_total_lowered_counts_for_every_team(client):
    from hive.core.cost_reservations import Reservations
    h = hive_of(client)
    a, b = _team_mind(client, "One"), _team_mind(client, "Two")
    set_rule(client, "hive", "month", 1000)
    set_rule(client, "hive", "day", 1000)
    res = Reservations(h.db, clock=MonthApart())                          # the guard full at each call: admission alone
    assert _hold(h, res, a["id"], 0.5, "r-a")
    for period in ("month", "day"):
        set_rule(client, f"swarm:{b['swarm_id']}", period, 10)
    set_rule(client, "hive", "month", 0.6)
    assert not _hold(h, res, b["id"], 0.2, "r-b")
    assert _hold(h, res, b["id"], 0.1, "r-b2")


def test_property_rule_changes_between_admissions_never_hide_a_hold(client):
    """Random admissions with random rule changes in between. After every admission, for every row it was checked
    against, the holds on that row's subject (tallied here, independently of the host) are within its limit."""
    import random
    from hive.core.cost_reservations import Reservations, host_budget_snapshot, subject_of
    h = hive_of(client)
    rnd = random.Random(7)
    minds = [_team_mind(client, f"T{i}", budget=rnd.choice([0, 3, 50])) for i in range(3)]
    minds.append(client.post("/api/agents", json={"name": "Extra", "swarm_id": minds[0]["swarm_id"], "model": PAID}).json())
    teams = sorted({m["swarm_id"] for m in minds})
    res, holds = Reservations(h.db, clock=MonthApart()), []              # the guard full at each call: admission alone
    for step in range(120):
        if rnd.random() < 0.35:
            what = rnd.choice(["total", "total-day", "total-off", "team", "team-off", "cap", "cap-off", "every"])
            if what == "total":
                h.budgets.set("hive", "month", rnd.choice([1, 2, 5, 20]))
            elif what == "total-day":
                h.budgets.set("hive", "day", rnd.choice([0.05, 0.2, 1]))
            elif what == "total-off":
                h.db.execute("DELETE FROM budgets WHERE scope = 'hive'")
            elif what == "team":
                h.budgets.set("swarm:" + rnd.choice(teams), rnd.choice(["month", "day"]), rnd.choice([0.5, 1, 3]))
            elif what == "team-off":
                h.db.execute("DELETE FROM budgets WHERE scope LIKE 'swarm:%'")
            elif what == "cap":
                h.settings.hive_budget_usd = rnd.choice([1, 4])
            elif what == "cap-off":
                h.settings.hive_budget_usd = 0
            else:
                h.budgets.set("every-mind", "month", rnd.choice([0.5, 2]))
            continue
        m = rnd.choice(minds)
        usd = rnd.choice([0.1, 0.3, 0.7])
        rows = host_budget_snapshot(h, m["id"])
        if _hold(h, res, m["id"], usd, f"p-{step}"):
            holds.append((h.agent(m["id"])["swarm_id"], m["id"], usd))
            for label, limit, _spent in rows:
                subject = subject_of(label)
                held = sum(u for s, a, u in holds if subject == "hive" or subject in (f"swarm:{s}", f"agent:{a}"))
                assert held <= limit + 1e-9, (step, label, held, limit)
    assert holds


# ---- r3: open holds made before subjects were recorded ----------------------------------------------------------------

def _legacy_hold(h, rid, usd, meta, scopes):
    """A hold exactly as the pre-r2 code left it: scope labels and metadata, no subject rows."""
    import json
    h.db.execute("INSERT INTO cost_reservations(id,binding,maximum,state,reserved_at) VALUES(?,?,?,?,?)",
                 (rid, "x", int(usd * 1_000_000), "unknown", 0))
    h.db.execute("INSERT INTO cost_reservation_details(reservation,metadata) VALUES(?,?)", (rid, json.dumps(meta)))
    for s in scopes:
        h.db.execute("INSERT INTO cost_reservation_scopes(reservation,scope) VALUES(?,?)", (rid, s))


def _hold_as(h, res, mind_id, usd, tag, key_id=None, payer=None):
    from hive.core.cost_reservations import host_budget_snapshot, host_subjects
    try:
        res.reserve(tag, {"t": tag}, usd, lambda: host_budget_snapshot(h, mind_id, key_id, payer, False),
                    subjects=host_subjects(h, mind_id, key_id, payer, False))
        return True
    except ValueError as exc:
        assert "Shared budget exhausted" in str(exc)
        return False


def _backfill(h):
    from hive.core.cost_reservations import Reservations
    with h.db.transaction() as tx:
        return Reservations.backfill_subjects(tx)


def _legacy_setup(client):
    from hive.core.cost_reservations import Reservations
    h = hive_of(client)
    a = _team_mind(client, "One")
    a2 = client.post("/api/agents", json={"name": "One2", "swarm_id": a["swarm_id"], "model": PAID, "budget_usd": 50}).json()
    b = _team_mind(client, "Two")
    return h, Reservations(h.db), a, a2, b


@pytest.mark.parametrize("backfilled", [False, True])
def test_a_legacy_hold_counts_against_a_key_rule_added_later(client, backfilled):
    h, res, a, _a2, b = _legacy_setup(client)
    _legacy_hold(h, "legacy-k", 0.6, {"agent": a["id"], "model": PAID, "payer": "hive", "key": "k_0000abcd"},
                 [f"agent:{a['id']}:total"])
    if backfilled:
        assert _backfill(h) == (1, 0)
    set_rule(client, "key:k_0000abcd", "month", 1.0)
    assert not _hold_as(h, res, b["id"], 0.5, "k-1", key_id="k_0000abcd")   # the stand-in's case: 0.6 + 0.5 > 1.0
    assert _hold_as(h, res, b["id"], 0.4, "k-2", key_id="k_0000abcd")
    if backfilled:                                                        # attributed: another key is not charged
        set_rule(client, "key:k_0000ef01", "month", 0.5)
        assert _hold_as(h, res, b["id"], 0.5, "k-3", key_id="k_0000ef01")


def test_a_legacy_hold_counts_against_a_person_or_team_rule_added_later(client):
    h, res, a, a2, b = _legacy_setup(client)
    _legacy_hold(h, "legacy-p", 0.6, {"agent": a["id"], "model": PAID, "payer": "user:u_0000beef", "key": None},
                 [f"agent:{a['id']}:total"])
    assert _backfill(h) == (1, 0)
    subjects = {r["subject"] for r in h.db.all("SELECT subject FROM cost_reservation_subjects WHERE reservation = 'legacy-p'")}
    assert subjects == {"hive", f"agent:{a['id']}", f"swarm:{a['swarm_id']}", "person:u_0000beef"}
    set_rule(client, "person:u_0000beef", "month", 1.0)
    assert not _hold_as(h, res, b["id"], 0.5, "p-1", payer="user:u_0000beef")
    assert _hold_as(h, res, b["id"], 0.4, "p-2", payer="user:u_0000beef")
    set_rule(client, f"swarm:{a['swarm_id']}", "month", 1.0)               # the team (its current team)
    assert not _hold_as(h, res, a2["id"], 0.5, "t-1")
    assert _hold_as(h, res, a2["id"], 0.4, "t-2")


def test_an_unattributable_legacy_hold_counts_against_every_rule(client):
    h, res, a, _a2, b = _legacy_setup(client)
    _legacy_hold(h, "legacy-x", 0.6, {"model": PAID}, ["hive:hard-total"])  # no mind, payer or key recorded
    assert _backfill(h) == (1, 1)
    assert "*" in {r["subject"] for r in h.db.all("SELECT subject FROM cost_reservation_subjects WHERE reservation = 'legacy-x'")}
    set_rule(client, "key:k_0000ef01", "month", 1.0)
    set_rule(client, f"swarm:{b['swarm_id']}", "month", 1.0)
    assert not _hold_as(h, res, b["id"], 0.5, "x-1", key_id="k_0000ef01")
    h.db.execute("DELETE FROM budgets WHERE scope LIKE 'key:%'")
    assert not _hold_as(h, res, b["id"], 0.5, "x-2")                       # the team rule counts it too


def test_backfill_twice_changes_nothing_and_runs_in_startup_recovery(client):
    from hive.core.cost_reservations import Reservations
    h, res, a, _a2, _b = _legacy_setup(client)
    _legacy_hold(h, "legacy-1", 0.2, {"agent": a["id"], "payer": "hive", "key": "k_0000abcd"}, [])
    _legacy_hold(h, "legacy-2", 0.2, "not json", [])
    assert _hold_as(h, res, a["id"], 0.1, "new-1")                         # a new hold: subjects already recorded
    before = h.db.all("SELECT * FROM cost_reservation_subjects WHERE reservation = 'new-1' ORDER BY subject")
    with h.db.transaction() as tx:
        moved = Reservations.recover_startup(tx)                           # the startup step runs the backfill
    assert moved == 1                                                      # new-1 was reserved, now unknown
    first = h.db.all("SELECT * FROM cost_reservation_subjects ORDER BY reservation, subject")
    assert {r["reservation"] for r in first} == {"legacy-1", "legacy-2", "new-1"}
    assert _backfill(h) == (0, 0)
    assert h.db.all("SELECT * FROM cost_reservation_subjects ORDER BY reservation, subject") == first
    assert h.db.all("SELECT * FROM cost_reservation_subjects WHERE reservation = 'new-1' ORDER BY subject") == before


# ---- r4: a swarm's all-time rule in the API ---------------------------------------------------------------------------

def test_a_team_all_time_rule_is_in_the_api_and_agrees_with_the_snapshot(client):
    from hive.tests.test_foundation_auto_budget_boundaries import agree
    swarm, (a, b) = make_swarm_and_agents(client, n=2, model=PAID)
    h = hive_of(client)
    client.patch(f"/api/agents/{b['id']}", json={"budget_usd": 5})
    own = set_rule(client, f"swarm:{swarm['id']}", "total", 3)
    for with_cap in (False, True):
        if with_cap:
            set_rule(client, "hive", "month", 1000)
        view = client.get("/api/budgets/limits").json()
        row = next(r for r in view["caps"] if r["key"] == f"swarm:{swarm['id']}:total")
        assert row["rule_id"] == own["id"] and row["source"] == "set" and row["limit_usd"] == 3
        for m in (a, b):
            mind = next(x for x in view["minds"] if x["agent_id"] == m["id"])
            assert f"swarm:{swarm['id']}:total" in mind["checked"]
            agree(h, view, m["id"])


def test_a_fractional_cap_is_enforced_to_the_micro_dollar(client):
    """r5: a $0.30006 month cap is enforced exactly (4-place rounding enforced $0.3001)."""
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    h = hive_of(client)
    a = _team_mind(client, "One")
    set_rule(client, "hive", "month", 0.30006)
    h.db.insert("usage", {"agent_id": a["id"], "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.30005,
                          "created_at": "2099-01-01T00:00:00Z", "swarm_id": a["swarm_id"]})
    assert {l: lim for l, lim, _ in host_budget_snapshot(h, a["id"])}["hive:month"] == 0.30006
    res = Reservations(h.db)
    with pytest.raises(ValueError, match="hive:month"):
        res.reserve("over", {"x": 1}, 0.00002, lambda: host_budget_snapshot(h, a["id"]))
    assert res.reserve("exact", {"x": 2}, 0.00001, lambda: host_budget_snapshot(h, a["id"]))["new"]


def test_a_session_cap_on_a_fractional_starting_spend_is_floored(client):
    """r6: $0.0000006 spent plus a $0.25 session used to install round(0.2500006, 6) = $0.250001; the cap is floored."""
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    h.db.execute("UPDATE agents SET spent_usd = 0.0000006 WHERE id = ?", (a["id"],))
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Fractional", "budget_usd": 0.25}).json()
    cap = h.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))["limit_usd"]
    assert cap == 0.25 and cap <= 0.0000006 + 0.25
    set_rule(client, "hive", "month", 1000)                                # and a default sized from the hive cap
    client.post(f"/api/sessions/{s['id']}/end")
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Auto"}).json()
    cap = h.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))["limit_usd"]
    assert cap <= 0.0000006 + s["budget_usd"] and cap == round(cap, 6)


def test_the_reservation_snapshot_uses_the_stored_spend_not_the_rounded_view(client):
    """r6: the agent view rounds spent_usd to 6 places, so $0.0000004 showed as $0 and a $0.000001 cap looked free."""
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    h = hive_of(client)
    a = _team_mind(client, "One", budget=0.000001)
    h.db.execute("UPDATE agents SET spent_usd = 0.0000004 WHERE id = ?", (a["id"],))
    assert h.agent(a["id"])["spent_usd"] == 0                                  # the view rounds it away
    with pytest.raises(ValueError, match=f"agent:{a['id']}:total"):
        Reservations(h.db).reserve("tiny", {"x": 1}, 0.000001, lambda: host_budget_snapshot(h, a["id"]))
    assert h.budgets.remaining_for(h.agent(a["id"])) == 0                      # 0.0000006 left, floored


def test_a_composed_session_cap_never_exceeds_its_exact_inputs(client):
    """r7: the cap is to_micros(spent at start) + to_micros(budget), each floored once, so it is never above the exact
    sum, even just under a micro boundary."""
    from decimal import Decimal
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    for spent, budget in ((0.2499999996, 0.25), (0.0000009996, 0.2500009996), (0.3, 0.2), (0.1234567891, 1.0000001)):
        h.db.execute("UPDATE agents SET spent_usd = ? WHERE id = ?", (spent, a["id"]))
        s = client.post("/api/sessions", json={"mind": a["id"], "title": "Exact", "budget_usd": budget}).json()
        cap = h.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{a['id']}",))["limit_usd"]
        assert Decimal(repr(cap)) <= Decimal(repr(spent)) + Decimal(repr(budget)), (spent, budget, cap)
        assert Decimal(repr(cap)) * 1_000_000 == int(Decimal(repr(cap)) * 1_000_000)
        client.post(f"/api/sessions/{s['id']}/end")
    set_rule(client, "hive", "month", 1000)
    for spent in (0.2499999996, 99.9999999):                  # a sized default never exceeds the headroom
        h.db.execute("UPDATE agents SET spent_usd = ? WHERE id = ?", (spent, a["id"]))
        assert h.budgets.session_default(h.agent(a["id"])) <= h.budgets.headroom(h.agent(a["id"]))


def test_an_ask_preference_just_under_a_micro_boundary_is_floored_into_the_thread_cap(client):
    """r8: PUT /api/me/ask stored round(value, 6), so 0.2499999996 became 0.25 and fed the thread's session cap."""
    from hive.tests.test_ask import ask, cap, world
    w = world(client)
    h = w["hive"]
    me = client.put("/api/me/ask", headers=w["ann"], json={"swarm_id": w["swarm"]["id"], "thread_budget_usd": 0.2499999996}).json()
    assert me["thread_budget_usd"] == 0.249999
    assert client.put("/api/me/ask", headers=w["ann"], json={"thread_budget_usd": 0.0000004}).json()["error"]["code"] == "invalid"
    t = ask(client, w["ann"], "op-floor", context={"swarm_id": w["swarm"]["id"]}).json()["thread"]
    assert t["budget_usd"] == 0.249999 and cap(h, w["coord"]) <= 0.249999 + float(h._agent_row(w["coord"]["id"])["spent_usd"] or 0)


def test_an_allowance_raise_request_is_floored_to_the_cent(client):
    h = hive_of(client)
    h.person_requests.auto_allowance("user:u_0000aaaa", 12.345)
    import json
    payload = json.loads(h.db.one("SELECT payload FROM person_requests WHERE requested_by = 'user:u_0000aaaa'")["payload"])
    assert payload == {"monthly_usd": 37.34}                                # 12.345 + 25 = 37.345, never 37.35
