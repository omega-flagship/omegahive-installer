"""Personal minds P2: the Ask speaks as the person's own personal mind (plan PLATFORM_PERSONAL_MIND_ASK_PLAN_R1_20261008).

- No addressed mind, page swarm, thread or default swarm: the Ask goes to the asker's personal mind.
- Conductor on: the conductor runs as it (its model, its usage rows and swarm), paid by the person from their month
  allowance although its own cap is $0; the turn view and the accepted frame say acting_as {mind_id, name}.
- Conductor off: mind_asleep, never woken (woken: not_available; r3 keeps its turns content-free). No held copy of a personal-mind turn. A personal mind answers its person only.
"""
import json

import pytest

from hive.core.config import Provider
from hive.core.cost_reservations import host_budget_snapshot
from hive.core.db import now
from hive.core.hive import HiveError
from hive.tests.test_ask import ask, counts, world
from hive.tests.test_ask_conductor import Script, call, closed, frames, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def _on(client, monkeypatch, conductor=True):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1" if conductor else "")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    w = world(client)
    hive = w["hive"]
    # the host's own key for it (invented): a pin is a person's mind's model only when the host pays for it (First Light)
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}},
                                                   stored_key="sk-fakepaid-invented")
    w["mine"] = hive.personal.ensure("user:u_ann")
    return w


def _month(hive, pid, limit):
    """A person's month rule (the test people's ids are not the 8-hex shape Budgets.set's route checks)."""
    hive.db.insert("budgets", {"id": f"b_{pid}", "scope": f"person:{pid}", "period": "month", "limit_usd": limit,
                               "note": "", "created_at": now()})


def _accepted(hive, op, principal="user:u_ann"):
    return next(f for f in frames(hive, op, principal) if f["phase"] == "accepted")


def test_no_default_swarm_goes_to_the_personal_mind_and_the_conductor_runs_as_it(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    assert mine["model"] == "fakepaid/x" and float(mine["budget_usd"]) == 0          # made with the conductor's model, $0 cap
    hive.db.execute("UPDATE agents SET model = 'fakepaid/mine' WHERE id = ?", (mine["id"],))   # the mind's own model is used
    starts = list(client.supervisor.calls)
    s = script(client, Script([call("say", text="Hi Ann.")], "I'm here.", cost=0.004))
    r = ask(client, w["ann"], "op-p2-route-01", text="hello")                          # no context, no default swarm
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["thread"]["mind"]["id"] == mine["id"] and body["conductor"] == {"model": "fakepaid/mine"}
    assert body["acting_as"] == {"mind_id": mine["id"], "name": mine["name"]}
    # the stored frame is content-free (r4 allowlist): the mind's id only; the live frame and the view carry its name
    assert _accepted(hive, "op-p2-route-01")["acting_as"] == {"mind_id": mine["id"]}
    fs = wait(hive, "op-p2-route-01", closed)
    assert fs[-1]["outcome"] == "complete" and [b["model"] for b in s.bodies] == ["fakepaid/mine", "fakepaid/mine"]
    # billing: usage rows on the personal mind (and its swarm), paid by Ann; nothing on the swarm's coordinator
    usage = hive.db.all("SELECT agent_id, swarm_id, payer, model, cost_usd FROM usage")
    assert [(u["agent_id"], u["swarm_id"], u["payer"], u["model"]) for u in usage] == \
        [(mine["id"], mine["swarm_id"], "user:u_ann", "fakepaid/mine")] * 2
    meta = [json.loads(d["metadata"]) for d in hive.db.all("SELECT metadata FROM cost_reservation_details")]
    assert [(m["agent"], m["payer"], m["kind"]) for m in meta] == [(mine["id"], "user:u_ann", "ask-conductor")] * 2
    assert hive.my_spend("user:u_ann")["hive_paid_usd"] == pytest.approx(0.008)
    view = client.get("/api/ask/op-p2-route-01", headers=w["ann"]).json()
    assert view["acting_as"] == {"mind_id": mine["id"], "name": mine["name"]} and view["state"] == "done"
    assert view["turn_spent_usd"] == pytest.approx(0.008)
    # never woken, nothing delivered to it, and no held copy of its own turn
    assert hive.agent(mine["id"])["status"] == "asleep" and client.supervisor.calls == starts
    assert hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mine["id"],)) == []
    assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []
    assert client.get("/api/me/mind/inbox", headers=w["ann"]).json()["items"] == []


def test_an_addressed_or_page_swarm_still_goes_to_its_coordinator(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    script(client, Script("ok", "ok", repeat_last=True))
    for op, extra in (("op-p2-page-001", {"context": {"swarm_id": w["swarm"]["id"]}}),
                      ("op-p2-addr-001", {"context": {"mind": w["worker"]["id"]}})):
        r = ask(client, w["ann"], op, **extra)
        assert r.status_code == 202, r.text
        assert r.json()["thread"]["mind"]["id"] == w["coord"]["id"] and r.json()["acting_as"] is None
        assert r.json()["conductor"] == {"model": "fakepaid/x"}                          # the conductor's model, as today
        assert _accepted(hive, op)["acting_as"] is None
        wait(hive, op, closed)
    assert {u["agent_id"] for u in hive.db.all("SELECT agent_id FROM usage")} <= {w["coord"]["id"]}


def test_an_explicit_default_swarm_wins_over_the_personal_mind(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    script(client, Script("ok", repeat_last=True))
    assert client.put("/api/me/ask", headers=w["ann"], json={"swarm_id": w["swarm"]["id"]}).status_code == 200
    r = ask(client, w["ann"], "op-p2-pref-001").json()
    assert r["thread"]["mind"]["id"] == w["coord"]["id"] and r["acting_as"] is None
    wait(hive, "op-p2-pref-001", closed)
    assert client.put("/api/me/ask", headers=w["ann"], json={"swarm_id": None}).status_code == 200   # cleared: hers again
    r = ask(client, w["ann"], "op-p2-pref-002").json()
    assert r["thread"]["mind"]["id"] == w["mine"]["id"] and r["acting_as"]["mind_id"] == w["mine"]["id"]
    wait(hive, "op-p2-pref-002", closed)


def test_a_zero_budget_personal_mind_is_paid_from_the_persons_allowance_and_refused_when_it_is_spent(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    mine = hive._agent_row(w["mine"]["id"])
    assert hive.budgets.panel_total() is None                                          # no hive total: the strict case
    hive.check_budget(mine, True, 0.01, None, "user:u_ann", False)                      # Ann's $50 member allowance admits it
    labels = [s for s, _l, _sp in host_budget_snapshot(hive, mine["id"], None, "user:u_ann", False)]
    assert "person:u_ann:month" in labels and f"agent:{mine['id']}:total" not in labels
    for payer, own in (("hive", False), ("user:u_bob", False), ("user:u_ann", True)):  # only its own person, from the hive's money
        with pytest.raises(HiveError) as e:
            hive.check_budget(mine, True, 0.01, None, payer, own)
        assert e.value.code == "no_budget"
    # an admin has no allowance unless a month rule gives one: the usual rules apply (no_budget without a hive total)
    jons = hive._agent_row(hive.personal.ensure("user:u_jon")["id"])
    with pytest.raises(HiveError) as e:
        hive.check_budget(jons, True, 0.01, None, "user:u_jon", False)
    assert e.value.code == "no_budget"
    _month(hive, "u_jon", 2.0)
    hive.check_budget(jons, True, 0.01, None, "user:u_jon", False)
    # the allowance spent: refused with the existing code, and a conductor turn ends spend_cap with no model call
    _month(hive, "u_ann", 0.001)
    with pytest.raises(HiveError) as e:
        hive.check_budget(mine, True, 0.01, None, "user:u_ann", False)
    assert e.value.status == 402 and e.value.code == "spend_limit" and e.value.details["scope"] == "person:u_ann"
    s = script(client, Script("never", cost=0.004))
    r = ask(client, w["ann"], "op-p2-spent-01")
    assert r.status_code == 202 and r.json()["acting_as"]["mind_id"] == mine["id"]
    fs = wait(hive, "op-p2-spent-01", closed)
    assert fs[-1]["outcome"] == "spend_cap" and s.bodies == [] and hive.db.all("SELECT * FROM usage") == []
    assert float(hive._agent_row(mine["id"])["budget_usd"]) == 0                      # no one's limit was raised


def test_conductor_off_the_personal_mind_is_asleep_and_never_woken(client, monkeypatch):
    w = _on(client, monkeypatch, conductor=False)
    hive, mine = w["hive"], w["mine"]
    starts, before = list(client.supervisor.calls), counts(hive)
    r = ask(client, w["ann"], "op-p2-sleep-01")
    assert r.status_code == 409 and r.json()["error"]["code"] == "mind_asleep"
    assert r.json()["error"]["mind"] == {"id": mine["id"], "name": mine["name"]}
    assert hive.agent(mine["id"])["status"] == "asleep" and client.supervisor.calls == starts and counts(hive) == before
    # woken, it is still not asked through the hub (r3): that path would keep the person's words in the outbox and the
    # room, and a personal mind's turn keeps no content on the host. Refused, and nothing is written.
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (mine["id"],))
    r = ask(client, w["ann"], "op-p2-awake-01")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"
    assert counts(hive) == before and hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []


def test_a_personal_mind_answers_its_own_person_only(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    script(client, Script("ok", repeat_last=True))
    before = counts(hive)
    for extra in ({"context": {"swarm_id": mine["swarm_id"]}}, {"context": {"mind": mine["id"]}}):   # Jon is an admin
        r = ask(client, w["jon"], "op-p2-other-01", **extra)
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed", extra
    assert counts(hive) == before
    assert client.put("/api/me/ask", headers=w["jon"], json={"swarm_id": mine["swarm_id"]}).json()["error"]["code"] == "not_allowed"
    jons = hive.personal.ensure("user:u_jon")
    eligible = [s["id"] for s in client.get("/api/me/ask", headers=w["jon"]).json()["eligible"]]
    assert mine["swarm_id"] not in eligible and jons["swarm_id"] in eligible
    # Ann may still address her own from its page
    r = ask(client, w["ann"], "op-p2-own-001", context={"swarm_id": mine["swarm_id"]})
    assert r.status_code == 202 and r.json()["acting_as"]["mind_id"] == mine["id"]
    wait(hive, "op-p2-own-001", closed)


def test_a_new_personal_minds_model_is_the_conductors_else_the_hive_default(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    assert hive.personal.ensure("user:u_bob")["model"] == hive.settings.default_model, "no key pays for the pin: not used"
    hive.settings.providers["fakepaid"].stored_key = "sk-fakepaid-invented"
    assert hive.personal.ensure("user:u_ann")["model"] == "fakepaid/x"
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR_MODEL")
    assert hive.personal.ensure("user:u_jon")["model"] == hive.settings.default_model


def test_an_admins_ab_pick_still_wins_on_a_personal_mind_turn(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    jons = hive.personal.ensure("user:u_jon")
    hive.db.execute("UPDATE agents SET model = 'fakepaid/mine' WHERE id = ?", (jons["id"],))
    _month(hive, "u_jon", 2.0)
    script(client, Script("ok", repeat_last=True))
    r = ask(client, w["jon"], "op-p2-ab-0001", conductor={"model": "fakepaid/x"})
    assert r.status_code == 202, r.text
    assert r.json()["conductor"] == {"model": "fakepaid/x"} and r.json()["acting_as"]["mind_id"] == jons["id"]
    wait(hive, "op-p2-ab-0001", closed, principal="user:u_jon")


def test_a_conductor_turn_on_an_asleep_coordinator_leaves_it_asleep(client, monkeypatch):
    """Found in P2: a new Ask thread's goal note (sessions.create -> goals.announce -> send_to_agent) woke an asleep mind.
    A conductor turn never wakes or uses the mind, whether it is a swarm's coordinator or a personal mind."""
    w = _on(client, monkeypatch)
    hive = w["hive"]
    hive.db.execute("UPDATE agents SET status = 'asleep', desired = 'asleep' WHERE id = ?", (w["coord"]["id"],))
    starts = list(client.supervisor.calls)
    script(client, Script("ok"))
    r = ask(client, w["ann"], "op-p2-wake-001", context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202 and r.json()["acting_as"] is None
    wait(hive, "op-p2-wake-001", closed)
    assert hive.agent(w["coord"]["id"])["status"] == "asleep" and client.supervisor.calls == starts
    goal = hive.db.one("SELECT g.* FROM goals g JOIN work_sessions s ON s.goal_id = g.id WHERE s.agent_id = ?", (w["coord"]["id"],))
    assert goal and goal["assignee"] == w["coord"]["id"]                    # the thread's goal is still recorded
