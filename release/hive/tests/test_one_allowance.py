# Purpose: tests for the one-allowance limits: a paid call meets only its payer's monthly allowance, the hive cap and the
# caps someone set, nothing derived; a request is bounded by the asker's room and its refusal names the row that bound;
# the Limits page shows the hive cap, the people and the caps set.
"""One allowance per payer and one hive cap (budgets.py, limits_view.py, Minds.instruct)."""
import asyncio
import logging
import random

import pytest

from hive.core.cost_reservations import Reservations, host_budget_snapshot, host_subjects
from hive.core.db import now
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL as PAID, _fake_chat, _gateway
from hive.tests.test_mind_control import person as admin_person, submit, w  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

MEMBER, ADMIN, KEY = "u_0a0b0c0d", "u_1a1b1c1d", "k_2a2b2c2d"


def hive_of(client):
    return client.app.state.hive


def set_rule(client, scope, period, limit, note=""):
    r = client.post("/api/budgets", json={"scope": scope, "period": period, "limit_usd": limit, "note": note})
    assert r.status_code == 200, r.text
    return r.json()


def spend(h, usd, agent_id, payer=None, key_id=None, swarm_id=None):
    h.db.insert("usage", {"agent_id": agent_id, "model": PAID, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd,
                          "created_at": now(), "key_id": key_id, "swarm_id": swarm_id, "payer": payer})


def chat(client, agent, max_tokens=50):
    _fake_chat(_gateway(client), delay=0)   # never a real provider call
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json={"messages": [{"role": "user", "content": "hi"}], "max_tokens": max_tokens})


def world(client):
    """Two swarms and four minds (one capped, one with no swarm), a member and an admin."""
    s1 = client.post("/api/swarms", json={"name": "Alpha"}).json()
    s2 = client.post("/api/swarms", json={"name": "Beta"}).json()
    mk = lambda name, swarm, budget=0: client.post("/api/agents", json={  # noqa: E731
        "name": name, "swarm_id": swarm and swarm["id"], "budget_usd": budget}).json()
    minds = [mk("Ada", s1), mk("Bo", s1, 5), mk("Cy", s2), mk("Di", None)]
    person(client, MEMBER)
    person(client, ADMIN, role="admin")
    return [s1, s2], minds


# ---- the rows a call is checked against ---------------------------------------------------------------------------------

def expected_rows(rules, agent, key_id, payer, own_key):
    """The rule, written out on its own: every stored rule on the hive, the mind, its swarm, the key and (on the hive's
    money) the paying person; the every-mind rule as the month cap of a mind with no cap of its own; and the member's
    default allowance when no rule of theirs sets it ($50; an admin has none). Nothing else."""
    person_scope = "person:" + payer[5:] if payer.startswith("user:") and not own_key else None
    scopes = {"hive", f"agent:{agent['id']}", f"key:{key_id}" if key_id else None, person_scope,
              f"swarm:{agent['swarm_id']}" if agent.get("swarm_id") else None}
    rows = {(r["scope"], r["period"], round(float(r["limit_usd"]), 6)) for r in rules if r["scope"] in scopes}
    every = [r for r in rules if r["scope"] == "every-mind"]
    if every and float(agent["budget_usd"] or 0) == 0 and not any(r["scope"] == f"agent:{agent['id']}" for r in rules):
        rows.add((f"agent:{agent['id']}", "month", round(float(every[0]["limit_usd"]), 6)))
    if person_scope == f"person:{MEMBER}" and not any(r["scope"] == person_scope and r["period"] == "month" for r in rules):
        rows.add((person_scope, "month", 50.0))
    return rows


def rule_set(scopes, rnd):
    """A random stored rule set over the world's scopes, at most one per (scope, period), every-mind a month rule, each
    figure in cents from $0 to $1,000, a fifth of them an edge ($0, a cent, $50 or $1,000)."""
    pairs = [(s, p) for s in scopes for p in ("day", "month", "total") if s != "every-mind"] + [("every-mind", "month")]
    def figure():
        return rnd.choice([0.0, 0.01, 50.0, 1000.0]) if rnd.random() < 0.2 else rnd.randrange(0, 100_001) / 100
    return {pair: figure() for pair in rnd.sample(pairs, rnd.randint(0, len(pairs)))}


def test_a_call_is_checked_only_against_its_payers_allowance_the_hive_cap_and_caps_set(client):
    h = hive_of(client)
    swarms, minds = world(client)
    scopes = (["hive", "every-mind", f"person:{MEMBER}", f"person:{ADMIN}", f"key:{KEY}"]
              + [f"swarm:{s['id']}" for s in swarms] + [f"agent:{m['id']}" for m in minds])

    rnd = random.Random(107)                                              # seeded: a failing case repeats, and is named
    for case in range(60):
        chosen = rule_set(scopes, rnd)
        h.db.execute("DELETE FROM budgets")
        for (scope, period), limit in chosen.items():
            h.budgets.set(scope, period, limit)
        rules = h.budgets.rules()
        has_cap = any(r["scope"] == "hive" and r["period"] in ("month", "day") for r in rules)
        for m in minds:
            agent = h.agent(m["id"])
            for payer in ("hive", f"user:{MEMBER}", f"user:{ADMIN}"):
                for own_key in (False, True):
                    for key_id in (None, KEY):
                        rows = h.budgets.applicable(agent, key_id, payer, own_key)
                        assert not {o for *_, o in rows} & {"auto", "default"}
                        got = {(s, p, round(float(limit), 6)) for s, p, limit, _ in rows}
                        assert got == expected_rows(rules, agent, key_id, payer, own_key), (case, agent["name"], payer, own_key, key_id)
            if float(agent["budget_usd"]) == 0:   # an uncapped mind is paid only under a hive cap
                assert h.budgets.paid_without_cap(agent) is has_cap, case
        assert {r["origin"] for r in h.budgets.overview()} <= {"rule"} and len(h.budgets.overview()) == len(rules), case


SCOPES = ("hive", "swarm", "agent", "person", "key")


@pytest.mark.parametrize("period", ["day", "month", "total"])
@pytest.mark.parametrize("kind", SCOPES)
def test_every_stored_rule_still_applies(client, kind, period):
    h = hive_of(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, budget_usd=50)
    person(client, MEMBER)
    scope = {"hive": "hive", "swarm": f"swarm:{swarm['id']}", "agent": f"agent:{a['id']}", "person": f"person:{MEMBER}",
             "key": f"key:{KEY}"}[kind]
    rule = set_rule(client, scope, period, 1.0)
    spend(h, 0.9, a["id"], f"user:{MEMBER}", KEY, swarm["id"])    # counts under every one of the five scopes
    agent, payer = h.agent(a["id"]), f"user:{MEMBER}"
    h.budgets.check(agent, 0.05, KEY, payer, False)
    with pytest.raises(Exception) as refused:
        h.budgets.check(agent, 0.2, KEY, payer, False)
    assert refused.value.code == "spend_limit"
    assert (refused.value.details["scope"], refused.value.details["period"], refused.value.details["rule"]) == \
        (scope, period, rule["id"])


def test_the_every_mind_rule_is_the_month_cap_of_each_mind_with_none_of_its_own(client):
    h = hive_of(client)
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    set_rule(client, "hive", "month", 100)
    set_rule(client, "every-mind", "month", 1.0)
    set_rule(client, f"agent:{b['id']}", "day", 3)                  # a cap of its own: the every-mind rule stays off it
    spend(h, 0.9, a["id"], swarm_id=swarm["id"])
    with pytest.raises(Exception) as refused:
        h.budgets.check(h.agent(a["id"]), 0.2)
    assert (refused.value.details["scope"], refused.value.details["period"], refused.value.details["rule"]) == \
        (f"agent:{a['id']}", "month", "every-mind")
    assert (f"agent:{b['id']}", "month") not in {(s, p) for s, p, _, _ in h.budgets.applicable(h.agent(b["id"]))}
    s = client.post("/api/sessions", json={"mind": b["id"], "title": "Machinery", "budget_usd": 2}).json()
    client.post(f"/api/sessions/{s['id']}/end")
    c = client.post("/api/agents", json={"name": "Cy", "swarm_id": swarm["id"]}).json()
    s = client.post("/api/sessions", json={"mind": c["id"], "title": "Machinery only", "budget_usd": 2}).json()
    assert (f"agent:{c['id']}", "month", 1.0, "every-mind") in h.budgets.applicable(h.agent(c["id"]))   # a session's cap is machinery
    client.post(f"/api/sessions/{s['id']}/end")


def test_a_zero_cap_mind_is_paid_only_under_a_hive_cap(client):
    h = hive_of(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, model=PAID)
    assert chat(client, a).json()["error"]["code"] == "no_budget"
    set_rule(client, "every-mind", "month", 20)                      # a cap on every mind alone does not open it
    assert chat(client, a).json()["error"]["code"] == "no_budget"
    day = set_rule(client, "hive", "day", 5)                         # a hive day rule is a hive cap
    assert chat(client, a).status_code == 200
    labels = {label: limit for label, limit, _ in host_budget_snapshot(h, a["id"])}
    assert labels == {"hive:day": 5, f"agent:{a['id']}:month": 20}   # no lifetime row, no swarm or hive month derived
    client.delete(f"/api/budgets/{day['id']}")
    set_rule(client, "hive", "month", 50)
    labels = {label: limit for label, limit, _ in host_budget_snapshot(h, a["id"])}
    assert labels == {"hive:month": 50, f"agent:{a['id']}:month": 20}   # no hive day at a tenth
    assert h.budgets.hive_cap()["limit_usd"] == 50 and h.budgets.hard_cap() == 0


def test_a_retired_setting_is_logged_once_and_changes_nothing(client, monkeypatch, tmp_path, caplog):
    from hive.core import config
    monkeypatch.setattr(config, "_RETIRED_NOTED", set())
    monkeypatch.setenv("HIVE_SWARM_MONTHLY_USD", "500")
    monkeypatch.setenv("HIVE_PERSON_REQUEST_CEILING_USD", "1")
    with caplog.at_level(logging.WARNING, logger="hive.config"):
        settings_ = config.load_settings(data_dir=tmp_path)
        config.load_settings(data_dir=tmp_path)
    retired = [r.getMessage() for r in caplog.records if "is retired" in r.getMessage()]
    assert len(retired) == 2 and not hasattr(settings_, "swarm_monthly_usd") and "HIVE_SWARM_MONTHLY_USD" not in settings_.budget_env
    h = hive_of(client)
    swarm, (a,) = make_swarm_and_agents(client, n=1, budget_usd=5)
    assert h.budgets.applicable(h.agent(a["id"])) == []              # no swarm month default
    assert {s["name"] for s in h.budgets.server_settings()} == {
        "HIVE_BUDGET_USD", "HIVE_MEMBER_MONTHLY_USD", "HIVE_ASK_CONDUCTOR_TURN_USD", "HIVE_START_LIMIT_MONTH_USD"}


# ---- a person's instruction: the asker's room, the hive cap and the caps set ----------------------------------------------

def asker(w, pid=ADMIN):
    """An admin with a task of their own to instruct from (the route takes admins; a member reaches instruct from Ask)."""
    headers = admin_person(w.hive, pid)
    task = asyncio.run(w.hive.goals.create(w.origin["id"], "Edit code: theirs", created_by=f"user:{pid}"))
    w.hive.services.grant(task["id"], f"user:{pid}", "edit", None, 120, by=f"user:{pid}")
    return headers, task


def refused_by(w, headers, task, op, limit=0.8):
    origin = {"task_id": task["id"], "repository_id": "synthetic", "workspace_id": "ws_1", "scope_id": "sc_1",
              "scope_digest": "sha256:" + "ab" * 32, "generation": 1}
    out = submit(w, headers=headers, operation_id=op, origin=origin, budget={"limit_usd": limit})
    if out.status_code == 201:
        return None
    assert out.status_code == 402 and out.json()["error"]["code"] == "spend_limit", out.text
    return out.json()["error"]


def test_a_request_is_bounded_by_the_askers_room_and_the_teams_own_cap(w):
    h, headers, task = w.hive, *asker(w)
    team = w.team["id"]
    assert refused_by(w, headers, task, "op-bound-001") is None           # no cap anywhere but the controller's own $5
    cap = h.budgets.set("hive", "month", 10)
    spend(h, 9.5, w.helper["id"])
    assert refused_by(w, headers, task, "op-bound-002")["limit"]["label"] == "hive:month"
    h.budgets.set("hive", "month", 1000)
    mine = h.budgets.set(f"person:{ADMIN}", "month", 2)
    spend(h, 1.5, w.helper["id"], payer=f"user:{ADMIN}")
    row = refused_by(w, headers, task, "op-bound-003")["limit"]
    assert (row["label"], row["kind"], row["room_usd"]) == (f"person:{ADMIN}:month", "member_allowance", 0.5)
    assert refused_by(w, headers, task, "op-bound-004", limit=0.5) is None   # exactly the room left
    h.budgets.remove(mine["id"])
    day = h.budgets.set(f"swarm:{team}", "day", 0.6)
    row = refused_by(w, headers, task, "op-bound-005")["limit"]
    assert (row["label"], row["kind"]) == (f"swarm:{team}:day", "swarm_cap")
    h.budgets.remove(day["id"])
    w.client.patch(f"/api/agents/{w.ctl['id']}", json={"budget_usd": 0.7})
    row = refused_by(w, headers, task, "op-bound-006")["limit"]
    assert (row["label"], row["kind"]) == (f"agent:{w.ctl['id']}:total", "mind_cap")
    h.budgets.remove(cap["id"])


def test_an_ask_thread_on_the_controller_never_bounds_a_request(w):
    """An Ask thread tightens the controller's total rule for its own calls while it runs (a work session's machinery);
    that is no cap someone set on what the swarm's minds may be handed, so the request is held to the controller's own
    cap, as before."""
    h, headers, task = w.hive, *asker(w)
    s = w.client.post("/api/sessions", json={"mind": w.ctl["id"], "title": "Ask thread", "budget_usd": 0.25}).json()
    assert h.db.one("SELECT limit_usd FROM budgets WHERE scope = ? AND period = 'total'", (f"agent:{w.ctl['id']}",))["limit_usd"] == 0.25
    assert refused_by(w, headers, task, "op-bound-201") is None      # $0.80 under the controller's own $5
    w.client.post(f"/api/sessions/{s['id']}/end")


def test_a_request_refusal_names_the_row_that_bound(w):
    h, headers, task = w.hive, *asker(w)
    h.budgets.set(f"person:{ADMIN}", "month", 2)
    spend(h, 1.0, w.helper["id"], payer=f"user:{ADMIN}")
    res = Reservations(h.db)
    agent = h.agent(w.helper["id"])
    h.db.execute("UPDATE agents SET budget_usd = 50 WHERE id = ?", (agent["id"],))
    res.reserve("r-held", {"t": 1}, 0.4, lambda: host_budget_snapshot(h, agent["id"], None, f"user:{ADMIN}"),
                subjects=host_subjects(h, agent["id"], None, f"user:{ADMIN}"))   # a call not yet settled, paid by the asker
    error = refused_by(w, headers, task, "op-bound-101")
    assert error["limit"] == {"label": f"person:{ADMIN}:month", "scope": f"person:{ADMIN}", "period": "month",
                              "limit_usd": 2.0, "spent_usd": 1.0, "held_usd": 0.4, "room_usd": 0.6, "kind": "member_allowance"}
    assert error["ceiling_usd"] == 0.6 and "has $0.60 of room left" in error["message"]
    assert h.db.one("SELECT COUNT(*) AS n FROM requests")["n"] == 0  # refused before anything is written


def test_a_members_request_is_bounded_by_their_member_default(w):
    h = w.hive
    from hive.tests.test_mind_control import person as mk
    mk(h, MEMBER, role="member")
    rows = h.budgets.request_bound(w.team["id"], f"user:{MEMBER}", h.agent(w.ctl["id"]))
    assert {r["label"]: (r["limit_usd"], r["kind"]) for r in rows} == {
        f"person:{MEMBER}:month": (50.0, "member_allowance"), f"agent:{w.ctl['id']}:total": (5.0, "mind_cap")}
    assert [r["label"] for r in h.budgets.request_bound(w.team["id"], "user:u_jon", h.agent(w.ctl["id"]))] == \
        [f"agent:{w.ctl['id']}:total"]                                # an admin with no rule of their own has no allowance


# ---- the Limits page ------------------------------------------------------------------------------------------------------

def test_the_limits_view_has_no_derived_rows(client):
    h = hive_of(client)
    swarm, (a, b) = make_swarm_and_agents(client, n=2)
    member, admin = person(client, MEMBER), person(client, ADMIN, role="admin")
    cap = set_rule(client, "hive", "month", 50)
    rules = [set_rule(client, "hive", "day", 4), set_rule(client, f"swarm:{swarm['id']}", "month", 500),
             set_rule(client, f"agent:{b['id']}", "total", 2), set_rule(client, "every-mind", "month", 10),
             set_rule(client, f"key:{KEY}", "month", 30), set_rule(client, f"person:{MEMBER}", "day", 1)]
    allowance = set_rule(client, f"person:{ADMIN}", "month", 25)
    client.patch(f"/api/agents/{a['id']}", json={"budget_usd": 5})   # an old form's pre-filled cap
    spend(h, 3.0, a["id"], f"user:{MEMBER}", swarm_id=swarm["id"])
    view = client.get("/api/budgets/limits").json()
    assert view["hive"]["cap"]["rule_id"] == cap["id"] and view["hive"]["cap"]["spent_usd"] == 3.0
    assert view["hive"]["cap"]["room_usd"] == 47.0 and view["hive"]["all_time"] is None
    assert view["hive"]["pace_usd_per_day"] > 0
    people = {p["person_id"]: p for p in view["people"]}
    assert people[MEMBER]["source"] == "member-default" and people[MEMBER]["allowance"]["limit_usd"] == 50
    assert people[MEMBER]["allowance"]["spent_usd"] == 3.0 and people[MEMBER]["allowance"]["room_usd"] == 47.0
    assert people[ADMIN]["source"] == "set" and people[ADMIN]["allowance"]["rule_id"] == allowance["id"]
    assert {p["source"] for p in view["people"] if p["person_id"] not in (MEMBER, ADMIN)} <= {"none", "member-default"}
    assert {c["rule_id"] for c in view["caps"]} == {r["id"] for r in rules}   # every other stored rule, once
    shown = [view["hive"]["cap"]["rule_id"]] + [c["rule_id"] for c in view["caps"]] + \
        [p["allowance"]["rule_id"] for p in view["people"] if p["allowance"] and "rule_id" in p["allowance"]]
    assert sorted(shown) == sorted(r["id"] for r in h.budgets.rules())       # each stored rule in exactly one part
    mind = {m["agent_id"]: m for m in view["minds"]}
    every_row = [view["hive"]["cap"]] + view["caps"] + [p["allowance"] for p in view["people"] if p["allowance"]] + \
        [r for m in view["minds"] for r in m["limits"]]
    assert {r["source"] for r in every_row} <= {"set", "session", "member-default", "visitor", "every-mind", "default"}
    assert not any("basis" in r for r in every_row)                   # nothing is worked out from another figure
    assert not {"teams", "total", "every_mind", "active_teams", "pool_usd", "request_ceiling", "others", "auto"} & set(view)
    assert (f"agent:{b['id']}:month", "every-mind") not in {(r["key"], r["source"]) for r in mind[b["id"]]["limits"]}
    olds = {o.get("agent_id") or o.get("swarm_id"): o for o in view["old_defaults"]}
    assert set(olds) == {a["id"], swarm["id"]} and olds[swarm["id"]]["kind"] == "swarm"
    assert olds[a["id"]]["reset"] == {"method": "PATCH", "path": f"/api/agents/{a['id']}", "body": {"budget_usd": 0}}
    assert "every-mind cap ($10.00 a month)" in olds[a["id"]]["change"]
    assert client.get("/api/budgets/limits", headers=member).status_code == 403
    assert client.get("/api/budgets/auto-candidates").status_code in (404, 405)   # its list is the view's old_defaults
    del admin


def test_the_limits_view_agrees_with_what_each_mind_is_checked_against(client):
    h = hive_of(client)
    h.settings.hive_budget_usd, h.settings.budget_env = 0.5, {"HIVE_BUDGET_USD": "0.5"}
    swarm, (a, b, c) = make_swarm_and_agents(client, n=3, model=PAID)
    client.patch(f"/api/agents/{b['id']}", json={"budget_usd": 5})
    set_rule(client, f"agent:{c['id']}", "day", 2)
    set_rule(client, f"swarm:{swarm['id']}", "day", 3)

    def agree():
        view = client.get("/api/budgets/limits").json()
        rows = [r for r in (view["hive"]["cap"], view["hive"]["all_time"]) if r] + view["caps"]
        for m in view["minds"]:
            if m["agent_id"] not in (a["id"], b["id"], c["id"]):
                continue
            effective = {}
            for r in rows + m["limits"]:
                if r["key"] in m["checked"]:
                    effective[r["key"]] = min(effective.get(r["key"], float("inf")), r["limit_usd"])
            assert set(effective) == set(m["checked"])
            assert effective == {label: round(limit, 6) for label, limit, _ in host_budget_snapshot(h, m["agent_id"])}
        return view

    view = agree()                                                    # no cap: the server's all-time cap holds the hive
    assert view["hive"]["cap"] is None and view["hive"]["all_time"]["source"] == "server-settings"
    set_rule(client, "hive", "month", 100)
    set_rule(client, "every-mind", "month", 1)
    view = agree()
    assert view["hive"]["all_time"] is None
    sources = {r["key"]: r["source"] for r in next(m for m in view["minds"] if m["agent_id"] == a["id"])["limits"]}
    assert sources == {f"agent:{a['id']}:month": "every-mind"}
