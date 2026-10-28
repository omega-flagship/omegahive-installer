"""Automatic limits from the hive total, in the host: Budgets.applicable / overview, admission and reservations, the
env-as-seed rule (the owner, 2026-10-07), session and request defaults, and the limits API (PLATFORM_AUTO_BUDGET_LIMITS_PLAN)."""

import pytest

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL as PAID, _fake_chat, _gateway



def hive_of(client):
    return client.app.state.hive


def set_rule(client, scope, period, limit):
    r = client.post("/api/budgets", json={"scope": scope, "period": period, "limit_usd": limit})
    assert r.status_code == 200, r.text
    return r.json()


def keyed(rows):
    return {(s, p): (limit, origin) for s, p, limit, origin in rows}


def test_no_total_keeps_the_fallback_swarm_month(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    rows = keyed(hive_of(client).budgets.applicable(hive_of(client).agent(a["id"])))
    assert rows == {(f"swarm:{swarm['id']}", "month"): (500, "default")}
    assert [b["origin"] for b in client.get("/api/budgets").json()] == ["default"]


def test_a_hive_total_derives_every_limit_on_read(client):
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    h = hive_of(client)
    total = set_rule(client, "hive", "month", 1000)
    rows = keyed(h.budgets.applicable(h.agent(a["id"])))
    s = f"swarm:{swarm['id']}"
    assert rows[("hive", "month")] == (1000, total["id"])
    assert rows[("hive", "day")] == (100, "auto")
    assert rows[(s, "month")] == (1000, "auto") and rows[(s, "day")] == (100, "auto")    # one active team: the whole pool
    assert rows[(f"agent:{a['id']}", "month")] == (1000, "auto")                            # 2 minds: min(1, 2/2)
    over = {(r["scope"], r["period"]): r for r in client.get("/api/budgets").json()}
    assert over[(s, "month")]["origin"] == "auto" and "1,000.00" in over[(s, "month")]["basis"]
    assert all(r["origin"] in ("rule", "auto") for r in over.values())
    # a second active team halves nothing (2/2), a third takes each to 2/3; no restart, no stored row
    for name in ("Beta", "Gamma"):
        sw = client.post("/api/swarms", json={"name": name}).json()
        client.post("/api/agents", json={"name": name + "1", "swarm_id": sw["id"]})
    assert keyed(h.budgets.applicable(h.agent(a["id"])))[(s, "month")][0] == pytest.approx(666.6667)
    set_rule(client, "hive", "month", 300)                                                   # T changes: next read
    assert keyed(h.budgets.applicable(h.agent(a["id"])))[(s, "month")][0] == pytest.approx(200)
    assert h.db.one("SELECT COUNT(*) n FROM budgets")["n"] == 1


def test_a_stored_rule_wins_at_its_own_key(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    set_rule(client, "hive", "month", 1000)
    own = set_rule(client, f"swarm:{swarm['id']}", "month", 40)
    mine = set_rule(client, f"agent:{a['id']}", "day", 3)
    rows = keyed(h.budgets.applicable(h.agent(a["id"])))
    assert rows[(f"swarm:{swarm['id']}", "month")] == (40, own["id"])
    assert rows[(f"swarm:{swarm['id']}", "day")] == (4, "auto")
    assert rows[(f"agent:{a['id']}", "day")] == (3, mine["id"])
    assert (f"agent:{a['id']}", "month") not in rows                  # a limit of its own: no auto month


def test_every_mind_is_a_month_default_not_a_pool(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    bad = client.post("/api/budgets", json={"scope": "every-mind", "period": "day", "limit_usd": 5})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_period"
    set_rule(client, "every-mind", "month", 20)
    set_rule(client, "hive", "month", 1000)
    rows = keyed(h.budgets.applicable(h.agent(a["id"])))
    assert rows[(f"agent:{a['id']}", "month")] == (20, "auto") and ("every-mind", "month") not in rows
    over = {r["scope"]: r for r in client.get("/api/budgets").json() if r["origin"] == "rule"}
    assert over["every-mind"]["spent_usd"] == 0


# ---- server settings only seed a hive with no total (the owner, 2026-10-07) -------------------------------------------------

def chat(client, agent, max_tokens=50):
    _fake_chat(_gateway(client), delay=0)   # never a real provider call
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": max_tokens})


def cloud_like(client):
    """The cloud's settings file: one cent for every team and one cent all-time for the hive."""
    h = hive_of(client)
    h.settings.hive_budget_usd, h.settings.swarm_monthly_usd = 0.01, 0.01
    h.settings.budget_env = {"HIVE_BUDGET_USD": "0.01", "HIVE_SWARM_MONTHLY_USD": "0.01"}
    return h


def test_server_settings_seed_a_hive_without_a_total(client):
    h = cloud_like(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID, budget_usd=50)
    r = chat(client, a, max_tokens=400)                      # could cost $0.03: over one cent
    assert r.status_code == 402 and r.json()["error"]["code"] in ("spend_limit", "hive_budget_exhausted")
    assert keyed(h.budgets.applicable(h.agent(a["id"])))[(f"swarm:{swarm['id']}", "month")] == (0.01, "default")
    assert h.summary()["limits"]["hive_budget_usd"] == 0.01
    rows = {s["name"]: s for s in h.budgets.server_settings()}
    assert rows["HIVE_BUDGET_USD"] == {"name": "HIVE_BUDGET_USD", "value": 0.01, "set": True, "applies": True,
                                       "effect": "an all-time cap on the whole hive"}
    assert rows["HIVE_SWARM_MONTHLY_USD"]["applies"] and rows["HIVE_PERSON_REQUEST_CEILING_USD"]["set"] is False


def test_the_panel_total_replaces_the_server_settings(client):
    h = cloud_like(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID, budget_usd=50)
    set_rule(client, "hive", "month", 1000)
    rows = keyed(h.budgets.applicable(h.agent(a["id"])))
    assert rows[(f"swarm:{swarm['id']}", "month")] == (1000, "auto")
    assert h.budgets.hard_cap() == 0 and h.summary()["limits"]["hive_budget_usd"] == 0
    from hive.core.cost_reservations import host_budget_snapshot
    assert "hive:hard-total" not in {s for s, _, _ in host_budget_snapshot(h, a["id"])}
    assert chat(client, a).status_code == 200
    settings = {s["name"]: s for s in h.budgets.server_settings()}
    assert settings["HIVE_BUDGET_USD"]["set"] and not settings["HIVE_BUDGET_USD"]["applies"]
    assert not settings["HIVE_SWARM_MONTHLY_USD"]["applies"]
    assert "Limits page" in settings["HIVE_BUDGET_USD"]["effect"]


# ---- H3 the plan's one loosening, H4 reservations ---------------------------------------------------------------------

def spend(h, agent_id, usd):
    h.db.insert("usage", {"agent_id": agent_id, "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd,
                          "created_at": "2099-01-01T00:00:00Z", "swarm_id": h.agent(agent_id)["swarm_id"]})


def roomy(client, swarm):
    """Day limits out of the way, so a test reaches the month limit it is about."""
    set_rule(client, "hive", "day", 10_000)
    set_rule(client, f"swarm:{swarm['id']}", "day", 10_000)


def test_a_zero_budget_mind_still_needs_a_hive_total(client):
    _, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    r = chat(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "no_budget"
    set_rule(client, "every-mind", "month", 20)                      # an every-mind limit alone does not open it
    assert chat(client, a).json()["error"]["code"] == "no_budget"


def test_a_zero_budget_mind_gets_its_auto_month_once_a_total_exists(client):
    swarm, (a, b, c) = make_swarm_and_agents(client, n=3, model=PAID)
    h = hive_of(client)
    set_rule(client, "hive", "month", 30)
    roomy(client, swarm)
    assert chat(client, a).status_code == 200                       # admitted: auto month 30 x 2/3 = $20
    from hive.core.cost_reservations import host_budget_snapshot
    labels = {s: limit for s, limit, _ in host_budget_snapshot(h, a["id"])}
    assert f"agent:{a['id']}:total" not in labels and labels[f"agent:{a['id']}:month"] == pytest.approx(20)
    spend(h, a["id"], 19.999)
    r = chat(client, a)
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit"
    assert r.json()["error"]["scope"] == f"agent:{a['id']}" and r.json()["error"]["rule"] == "auto"
    # the team and the total still hold: b and c together cannot pass the team's $30
    spend(h, b["id"], 10.0)
    r = chat(client, c)
    assert r.status_code == 402 and r.json()["error"]["scope"] in (f"swarm:{swarm['id']}", "hive")


def test_concurrent_reservations_cannot_pass_a_derived_limit(client):
    import asyncio
    from hive.tests.test_cost_reservations import _two_calls
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    h = hive_of(client)
    set_rule(client, "hive", "month", 1000)
    set_rule(client, "every-mind", "month", 0.10)                   # each call reserves ~$0.0527; two would be $0.105
    roomy(client, swarm)
    _fake_chat(_gateway(client))
    codes = sorted(r.status_code for r in asyncio.run(_two_calls(client.app, a, 700)))
    assert codes == [200, 402], codes
    assert h.agent(a["id"])["spent_usd"] <= 0.10


def test_lowering_the_total_refuses_the_next_reservation(client):
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    h = hive_of(client)
    total = set_rule(client, "hive", "month", 1000)
    roomy(client, swarm)
    res = Reservations(h.db)
    assert res.reserve("r-1", {"x": 1}, 0.5, lambda: host_budget_snapshot(h, a["id"]))["new"]
    h.budgets.set("hive", "month", 0.6)                              # mid-flight: $0.5 already held
    assert total["id"] == h.db.one("SELECT id FROM budgets WHERE scope = 'hive' AND period = 'month'")["id"]
    with pytest.raises(ValueError, match="Shared budget exhausted"):
        res.reserve("r-2", {"x": 2}, 0.2, lambda: host_budget_snapshot(h, a["id"]))


# ---- H5 derived defaults ------------------------------------------------------------------------------------------------

def test_a_session_given_no_budget_takes_a_tenth_of_what_the_mind_has_left(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "No total yet"}).json()
    assert s["budget_usd"] == 1.0                                       # no total: $1 as before
    client.post(f"/api/sessions/{s['id']}/end")
    set_rule(client, "hive", "month", 1000)                             # headroom: the auto hive and team day, $100
    assert h.budgets.headroom(h.agent(a["id"])) == 100
    s = client.post("/api/sessions", json={"mind": a["id"], "title": "Auto"}).json()
    assert s["budget_usd"] == 10
    client.post(f"/api/sessions/{s['id']}/end")
    # the session's cap is machinery: the mind keeps its auto month, and nothing it set outlives the session
    assert (f"agent:{a['id']}", "month") in keyed(h.budgets.applicable(h.agent(a["id"])))
    assert client.post("/api/sessions", json={"mind": a["id"], "title": "Given", "budget_usd": 3}).json()["budget_usd"] == 3
    spend(h, a["id"], 100)
    r = client.post("/api/sessions", json={"mind": a["id"], "title": "Nothing left"})
    assert r.status_code == 402 and r.json()["error"]["code"] == "spend_limit"


def test_the_request_ceiling_is_the_receiving_teams_day_once_a_total_exists(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    h = hive_of(client)
    h.settings.person_request_ceiling_usd, h.settings.budget_env = 0.25, {"HIVE_PERSON_REQUEST_CEILING_USD": "0.25"}
    assert h.budgets.request_ceiling(swarm["id"]) == (0.25, "server-settings")
    set_rule(client, "hive", "month", 1000)
    assert h.budgets.request_ceiling(swarm["id"]) == (100, "auto")      # the env value no longer wins
    set_rule(client, f"swarm:{swarm['id']}", "day", 7)
    assert h.budgets.request_ceiling(swarm["id"]) == (7, "set")
    # a $0 controller hands on what its auto limits leave; a capped one what its cap leaves, as before
    assert h.budgets.remaining_for(h.agent(a["id"])) == 7
    client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 2})
    assert h.budgets.remaining_for(h.agent(a["id"])) == 2


# ---- the limits API: what the page shows is what is enforced --------------------------------------------------------

def api_effective(view, mind_id):
    mind = next(m for m in view["minds"] if m["agent_id"] == mind_id)
    rows = list(view["hive"]) + list(mind["limits"])
    for t in view["teams"]:
        if t["swarm_id"] == mind["swarm_id"]:
            rows += [r for r in (t["month"], t["day"], t["total"]) if r]
    out = {}
    for r in rows:
        if r["key"] in mind["checked"]:
            out[r["key"]] = min(out.get(r["key"], float("inf")), r["limit_usd"])
    assert set(out) == set(mind["checked"])
    return out


def snapshot(h, mind_id):
    from hive.core.cost_reservations import host_budget_snapshot
    return {label: round(limit, 6) for label, limit, _ in host_budget_snapshot(h, mind_id)}


def test_an_env_value_never_makes_an_effective_limit_differ_from_the_limits_api(client):
    h = cloud_like(client)
    h.settings.person_request_ceiling_usd = 0.3
    h.settings.budget_env["HIVE_PERSON_REQUEST_CEILING_USD"] = "0.3"
    swarm, (a, b, c, d) = make_swarm_and_agents(client, n=4, model=PAID)
    client.patch(f"/api/agents/{b['id']}", json={"budget_usd": 5})
    set_rule(client, f"agent:{c['id']}", "day", 2)
    loner = client.post("/api/agents", json={"name": "Loner", "model": PAID, "budget_usd": 3}).json()
    ids = [a["id"], b["id"], c["id"], d["id"], loner["id"]]

    def agree():
        view = client.get("/api/budgets/limits").json()
        for i in ids:
            assert api_effective(view, i) == snapshot(h, i), i
        return view

    view = agree()                                                    # no total: the env values are the limits
    assert view["auto"] is False and view["total"] is None
    assert {r["key"]: r["source"] for r in view["hive"]} == {"hive:hard-total": "server-settings"}
    assert view["teams"][0]["month"]["source"] == "server-settings" and view["teams"][0]["month"]["limit_usd"] == 0.01
    assert view["request_ceiling"] == {"source": "server-settings", "limit_usd": 0.3, "basis": "one figure for every swarm"}
    assert next(m for m in view["minds"] if m["agent_id"] == a["id"])["paid_calls"] == "no_budget"

    set_rule(client, "hive", "month", 1000)                           # the panel total: env values reported, never used
    view = agree()
    assert view["auto"] and view["total"]["limit_usd"] == 1000 and view["total"]["source"] == "set"
    assert all(r["setting"] != "HIVE_BUDGET_USD" for r in view["hive"] if "setting" in r)
    assert all(r["limit_usd"] != 0.01 for t in view["teams"] for r in (t["month"], t["day"]) if r)
    assert {s["name"]: (s["set"], s["applies"]) for s in view["server_settings"]} == {
        "HIVE_BUDGET_USD": (True, False), "HIVE_SWARM_MONTHLY_USD": (True, False),
        "HIVE_PERSON_REQUEST_CEILING_USD": (True, False), "HIVE_MEMBER_MONTHLY_USD": (False, True),
        "HIVE_ASK_CONDUCTOR_TURN_USD": (False, True)}
    s = client.post("/api/sessions", json={"mind": d["id"], "title": "Held", "budget_usd": 2}).json()
    view = agree()                                                    # a session's cap: shown as session, still agreed
    sources = {r["key"]: r["source"] for r in next(m for m in view["minds"] if m["agent_id"] == d["id"])["limits"]}
    assert sources[f"agent:{d['id']}:total"] == "session" and sources[f"agent:{d['id']}:month"] == "auto"
    client.post(f"/api/sessions/{s['id']}/end")
    set_rule(client, "every-mind", "month", 20)
    view = agree()
    assert view["every_mind"]["applies"] and next(m for m in view["minds"] if m["agent_id"] == a["id"])["paid_calls"] == "allowed"


def test_limits_api_shape_for_the_page(client):
    swarm, (a,) = make_swarm_and_agents(client, n=1)
    total = set_rule(client, "hive", "month", 1000)
    view = client.get("/api/budgets/limits").json()
    assert view["total"] == {"key": "hive:month", "limit_usd": 1000, "period": "month", "monthly_usd": 1000,
                             "rule_id": total["id"], "source": "set", "basis": "hive total $1,000.00 a month", "spent_usd": 0}
    team = view["teams"][0]
    assert team["active"] and team["month"]["source"] == "auto" and team["month"]["basis"]
    assert team["request_ceiling"] == {"limit_usd": 100, "source": "auto"}
    mind = view["minds"][0]
    assert mind["auto"] and mind["session_default_usd"] == 10 and mind["lease_default_usd"] == 10 and mind["headroom_usd"] == 100
    assert {r["name"] for r in view["rulings"]} == {"ask_thread", "conductor_turn", "member_month"}
    anon = client.get("/api/budgets/limits", headers={"Authorization": ""})
    assert anon.status_code == 401


# ---- H6 read-only "looks like an old default" list ---------------------------------------------------------------------

def test_auto_candidates_lists_old_defaults_and_writes_nothing(client):
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
    client.post("/api/budgets", json={"scope": f"swarm:{noted['id']}", "period": "month", "limit_usd": 500, "note": "Quinn chose"})
    set_rule(client, f"swarm:{inert['id']}", "month", 0)
    s = client.post("/api/sessions", json={"mind": c["id"], "title": "Machinery", "budget_usd": 5}).json()
    before = (h.db.all("SELECT * FROM budgets ORDER BY id"), h.db.all("SELECT id, budget_usd FROM agents ORDER BY id"))

    view = client.get("/api/budgets/auto-candidates").json()
    assert view["auto"] is False
    found = {x.get("agent_id") or x.get("swarm_id"): x for x in view["candidates"]}
    assert set(found) == {a["id"], r["id"], other["id"]}
    assert found[a["id"]]["reset"] == {"method": "PATCH", "path": f"/api/agents/{a['id']}", "body": {"budget_usd": 0}}
    assert "until the hive has a total" in found[a["id"]]["change"] and found[a["id"]]["auto_usd"] is None
    assert "Thrifty" in found[r["id"]]["reasons"][0]
    assert found[other["id"]]["reset"] == {"method": "DELETE", "path": f"/api/budgets/{old['id']}"}

    set_rule(client, "hive", "month", 1000)
    view = client.get("/api/budgets/auto-candidates").json()
    found = {x.get("agent_id") or x.get("swarm_id"): x for x in view["candidates"]}
    assert view["auto"] and found[a["id"]]["auto_usd"] > 0 and "-> Auto ($" in found[a["id"]]["change"]
    assert found[other["id"]]["auto_usd"] > 0
    after = (h.db.all("SELECT * FROM budgets ORDER BY id"), h.db.all("SELECT id, budget_usd FROM agents ORDER BY id"))
    assert [x for x in after[0] if not (x["scope"] == "hive")] == before[0] and after[1] == before[1]   # nothing written
    client.post(f"/api/sessions/{s['id']}/end")


# ---- r2 (OmegaReview FIX-FIRST): admin-only limits, visibility, liabilities by subject --------------------------------

def test_limits_routes_are_admin_only_and_never_show_a_hidden_team(client):
    from hive.core.limits_view import auto_candidates, limits
    from hive.core.visibility import Viewer
    from hive.tests.test_visibility import person
    h = hive_of(client)
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Ada", "kind": "module", "swarm_id": sw["id"]}).json()
    client.patch(f"/api/agents/{mind['id']}", json={"budget_usd": 5})
    set_rule(client, f"swarm:{sw['id']}", "month", 500)
    set_rule(client, "hive", "month", 1000)
    for path in ("/api/budgets/limits", "/api/budgets/auto-candidates"):
        r = client.get(path, headers=bob)
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only"
        assert client.get(path, headers=ann).status_code == 403
        assert client.get(path).status_code == 200                          # the admin
    listed = client.get("/api/budgets", headers=bob).json()
    assert not any(sw["id"] in r["scope"] or mind["id"] in r["scope"] for r in listed)
    assert any(r["scope"] == "hive" for r in listed)
    assert any(sw["id"] in r["scope"] for r in client.get("/api/budgets", headers=ann).json())
    # defence in depth: the read models filter a non-admin viewer too
    view = limits(h.budgets, Viewer("user:u_bob", False))
    assert sw["id"] not in str(view["teams"]) and mind["id"] not in str(view["minds"])
    assert auto_candidates(h.budgets, Viewer("user:u_bob", False))["candidates"] == []
    assert {c.get("agent_id") or c.get("swarm_id") for c in auto_candidates(h.budgets)["candidates"]} == {mind["id"], sw["id"]}


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
    h.settings.hive_budget_usd, h.settings.swarm_monthly_usd = 1.0, 0      # the seed cap; no team rows
    a, b = _team_mind(client, "One"), _team_mind(client, "Two")
    res = Reservations(h.db)
    assert _hold(h, res, a["id"], 0.6, "r-a")                            # held under hive:hard-total
    set_rule(client, "hive", "month", 1.0)                               # the total replaces the seed cap
    set_rule(client, "hive", "day", 1.0)
    for period in ("month", "day"):                                       # b's own team limits are roomy: only T binds
        set_rule(client, f"swarm:{b['swarm_id']}", period, 10)
    assert not _hold(h, res, b["id"], 0.5, "r-b")                        # another team: 0.6 held + 0.5 > 1.0
    assert _hold(h, res, b["id"], 0.4, "r-b2")


def test_a_hold_made_before_a_team_rule_counts_against_it(client):
    from hive.core.cost_reservations import Reservations
    h = hive_of(client)
    h.settings.swarm_monthly_usd = 0                                     # no team row when the hold is made
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
    res = Reservations(h.db)
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
    h.settings.swarm_monthly_usd = 0
    rnd = random.Random(7)
    minds = [_team_mind(client, f"T{i}", budget=rnd.choice([0, 3, 50])) for i in range(3)]
    minds.append(client.post("/api/agents", json={"name": "Extra", "swarm_id": minds[0]["swarm_id"], "model": PAID}).json())
    teams = sorted({m["swarm_id"] for m in minds})
    res, holds = Reservations(h.db), []
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
    h.settings.swarm_monthly_usd = 0                                      # nothing but the rule under test binds
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


# ---- r4: a day-only total holds the month; team all-time rules in the API --------------------------------------------

def test_a_day_only_total_is_held_across_the_month(client, monkeypatch):
    """$1 a day stands for $30 a month. Two teams alternating over earlier days of the month cannot pass $30: the
    month is a row of its own (calendar rollover: yesterday's spend leaves today's day limit free, not the month's)."""
    from hive.core import budgets as budgets_mod
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    h = hive_of(client)
    a, b = _team_mind(client, "One"), _team_mind(client, "Two")
    set_rule(client, "hive", "day", 1.0)
    month_start = budgets_mod.period_start("month")
    real = budgets_mod.period_start
    monkeypatch.setattr(budgets_mod, "period_start", lambda period, moment=None:
                        "9999-12-31T00:00:00.000Z" if period == "day" else real(period, moment))   # today: nothing spent yet
    for i in range(30):                                                    # 30 earlier days, $0.99 each, teams alternating
        m = (a, b)[i % 2]
        h.db.insert("usage", {"agent_id": m["id"], "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.99,
                              "created_at": month_start, "swarm_id": m["swarm_id"]})
    rows = {label: limit for label, limit, _ in host_budget_snapshot(h, a["id"])}
    assert rows["hive:month"] == 30 and rows["hive:day"] == 1
    r = chat(client, b, max_tokens=8000)                                   # could cost $0.60: within today's $1, not the month's
    assert r.status_code == 402 and r.json()["error"]["scope"] == "hive" and r.json()["error"]["period"] == "month"
    assert r.json()["error"]["rule"] == "auto"
    with pytest.raises(ValueError, match="hive:month"):
        Reservations(h.db).reserve("r-31", {"x": 1}, 0.5, lambda: host_budget_snapshot(h, b["id"]))
    assert Reservations(h.db).reserve("r-ok", {"x": 2}, 0.2, lambda: host_budget_snapshot(h, b["id"]))["new"]
    view = client.get("/api/budgets/limits").json()
    assert {r["key"]: r["source"] for r in view["hive"]} == {"hive:month": "auto", "hive:day": "set"}


def test_a_team_all_time_rule_is_in_the_api_and_agrees_with_the_snapshot(client):
    swarm, (a, b) = make_swarm_and_agents(client, n=2, model=PAID)
    h = hive_of(client)
    client.patch(f"/api/agents/{b['id']}", json={"budget_usd": 5})
    own = set_rule(client, f"swarm:{swarm['id']}", "total", 3)
    for with_total in (False, True):
        if with_total:
            set_rule(client, "hive", "month", 1000)
        view = client.get("/api/budgets/limits").json()
        team = view["teams"][0]
        assert team["total"]["key"] == f"swarm:{swarm['id']}:total" and team["total"]["rule_id"] == own["id"]
        assert team["total"]["source"] == "set" and team["total"]["limit_usd"] == 3
        for m in (a, b):
            mind = next(x for x in view["minds"] if x["agent_id"] == m["id"])
            assert f"swarm:{swarm['id']}:total" in mind["checked"]
            assert api_effective(view, m["id"]) == snapshot(h, m["id"])


def test_a_fractional_day_total_is_enforced_to_the_micro_dollar(client, monkeypatch):
    """r5: $0.010002 a day is $0.30006 a month, enforced exactly (4-place rounding enforced $0.3001)."""
    from hive.core import budgets as budgets_mod
    from hive.core.cost_reservations import Reservations, host_budget_snapshot
    h = hive_of(client)
    a = _team_mind(client, "One")
    for period in ("month", "day"):
        set_rule(client, f"swarm:{a['swarm_id']}", period, 10)
    set_rule(client, "hive", "day", 0.010002)
    real = budgets_mod.period_start
    monkeypatch.setattr(budgets_mod, "period_start", lambda period, moment=None:
                        "9999-12-31T00:00:00.000Z" if period == "day" else real(period, moment))
    h.db.insert("usage", {"agent_id": a["id"], "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.30005,
                          "created_at": real("month"), "swarm_id": a["swarm_id"]})
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
    set_rule(client, "hive", "month", 1000)                                # and an auto default on the same start
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
    for spent in (0.2499999996, 99.9999999):                  # an auto default never exceeds the headroom
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
