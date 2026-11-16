"""Who pays, and each person's allowance (Jon 2026-10-04: $50/month per family member; own keys are theirs)."""
import pytest

from hive.core.db import now
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def spend(hive, agent_id, payer, usd, key_id=None):
    hive.db.insert("usage", {"agent_id": agent_id, "model": "m", "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": usd,
                             "created_at": now(), "key_id": key_id, "swarm_id": None, "payer": payer})


def test_a_members_mind_bills_the_member_and_the_default_allowance_holds(client):
    hive = client.app.state.hive
    lyd = person(client, "u_1a2b3c4d")
    sw = client.post("/api/swarms", headers=lyd, json={"name": "Garden", "visibility": "private"}).json()
    mind = client.post("/api/agents", headers=lyd, json={"name": "Planner", "kind": "omega", "swarm_id": sw["id"]}).json()
    agent = hive.agent(mind["id"])
    payer, own = hive.payer_for(agent)
    assert payer == "user:u_1a2b3c4d" and own is False
    spend(hive, mind["id"], payer, 49.9)
    with pytest.raises(Exception) as e:
        hive.budgets.check(agent, 0.5, None, payer, own)            # would cross the $50 member default
    assert "person:u_1a2b3c4d" in str(e.value)
    hive.budgets.check(agent, 0.05, None, payer, own)               # still room
    me = client.get("/api/usage/me", headers=lyd).json()
    assert me["allowance_usd"] == 50 and me["allowance_origin"] == "member-default" and abs(me["hive_paid_usd"] - 49.9) < 1e-6
    client.post("/api/budgets", json={"scope": "person:u_1a2b3c4d", "period": "month", "limit_usd": 100})
    hive.budgets.check(agent, 0.5, None, payer, own)                # an explicit rule replaces the default


def test_own_key_spend_is_not_capped_and_admins_have_no_default(client):
    hive = client.app.state.hive
    lyd = person(client, "u_2b3c4d5e")
    sw = client.post("/api/swarms", headers=lyd, json={"name": "Mine"}).json()
    mind = client.post("/api/agents", headers=lyd, json={"name": "Own", "kind": "omega", "swarm_id": sw["id"]}).json()
    agent = hive.agent(mind["id"])
    payer, own = hive.payer_for(agent, key_owner="user:u_2b3c4d5e")
    assert own is True
    spend(hive, mind["id"], payer, 500)
    hive.budgets.check(agent, 5, None, payer, own)                  # her own money: no allowance applies
    boss = person(client, "u_3c4d5e6f", role="admin")
    sw2 = client.post("/api/swarms", headers=boss, json={"name": "Boss"}).json()
    m2 = client.post("/api/agents", headers=boss, json={"name": "B", "kind": "omega", "swarm_id": sw2["id"]}).json()
    p2, o2 = hive.payer_for(hive.agent(m2["id"]))
    spend(hive, m2["id"], p2, 500)
    hive.budgets.check(hive.agent(m2["id"]), 5, None, p2, o2)        # admins carry no member default


def test_a_session_bills_its_owner(client):
    hive = client.app.state.hive
    _, (a, _b) = make_swarm_and_agents(client)                       # a hive mind
    assert hive.payer_for(hive.agent(a["id"]))[0] == "hive"
    lyd = person(client, "u_4d5e6f70")
    hive.db.execute("UPDATE swarms SET visibility = 'public' WHERE id = ?", (a["swarm_id"],))
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (a["id"],))
    s = client.post("/api/sessions", headers=lyd, json={"mind": a["id"], "title": "Help me", "budget_usd": 1})
    assert s.status_code == 200, s.text
    assert hive.payer_for(hive.agent(a["id"]))[0] == "user:u_4d5e6f70"
