"""Coordinator-run lifecycle (OmegaPurple's broker): person-issued leases, scoped delegation, observed stops, reconcile."""
import asyncio
import secrets

import pytest

from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)


@pytest.fixture()
def world(client, monkeypatch):
    hive = client.app.state.hive
    running = set()
    sup = hive.supervisor
    sup.start = lambda aid: (sup.calls.append(("start", aid)), running.add(aid))
    sup.stop = lambda aid: (sup.calls.append(("stop", aid)), running.discard(aid))
    isolation = {}
    sup.start = lambda aid: (sup.calls.append(("start", aid)), running.add(aid), isolation.__setitem__(aid, {"os_sandbox": True}))
    sup.driver = lambda agent: type("D", (), {"name": "local", "isolation": isolation,
                                              "status": staticmethod(lambda aid: "running" if aid in running else "absent")})()
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setattr("hive.supervisor.sandbox.available", lambda: True)
    token = secrets.token_urlsafe(24)
    hive.db.insert("people", {"id": "u_quinn", "email": "quinn@example.test", "name": "Quinn", "role": "admin", "created_at": now()})
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": "user:u_quinn"})
    monkeypatch.setattr(hive.health, "mind_id", lambda: None)
    swarm = client.post("/api/swarms", json={"name": "Purple"}).json()
    coord = client.post("/api/agents", json={"name": "Lead", "kind": "omega", "swarm_id": swarm["id"], "budget_usd": 1}).json()
    spec = client.post("/api/agents", json={"name": "Red", "kind": "omega", "swarm_id": swarm["id"], "budget_usd": 1}).json()
    person = {"Authorization": f"Bearer {token}"}
    return hive, swarm, coord, spec, person, running


def test_only_a_named_person_delegates_and_issues(client, world):
    hive, swarm, coord, spec, person, running = world
    assert client.put(f"/api/lifecycle/delegations/{coord['id']}", json={"specialist_ids": [spec["id"]]}).status_code == 403  # password
    assert client.put(f"/api/lifecycle/delegations/{coord['id']}", headers=person, json={"specialist_ids": [spec["id"]]}).status_code == 200
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "probe", "assignee": "Red"}).json()
    body = {"coordinator": coord["id"], "specialist": spec["id"], "task": goal["id"], "seconds": 60, "budget_usd": 0.2}
    assert client.post("/api/lifecycle/leases", json=body).status_code == 403
    assert client.post("/api/lifecycle/leases", headers=person, json=dict(body, budget_usd=5)).status_code == 403   # over its cap
    assert client.post("/api/lifecycle/leases", headers=person, json=body).status_code == 200


def test_start_result_stop_and_reconcile(client, world):
    hive, swarm, coord, spec, person, running = world
    client.put(f"/api/lifecycle/delegations/{coord['id']}", headers=person, json={"specialist_ids": [spec["id"]]})
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "probe", "assignee": "Red"}).json()
    lease = client.post("/api/lifecycle/leases", headers=person, json={"coordinator": coord["id"], "specialist": spec["id"],
                                                                       "task": goal["id"], "seconds": 120, "budget_usd": 0.3}).json()["lease"]
    act = lambda who, a: client.post(f"/api/agent/lifecycle/{a}", headers=agent_headers(who), json={"lease": lease})
    assert act(spec, "start").status_code == 403                          # only the coordinator redeems it
    assert act(coord, "start").json()["start_requested"] is True and spec["id"] in running
    assert act(coord, "start").status_code == 403                         # once
    st = act(coord, "status").json()
    assert st["lease_valid"] and not st["stop_observed"] and st["task_status"] == "open"
    # the specialist finishes its task; the hive reconciles without the coordinator
    hive.db.update("goals", goal["id"], {"status": "done"})
    receipts = asyncio.run(hive.delegation.reconcile())
    assert receipts == [{"specialist": spec["id"], "stop_observed": True}] and spec["id"] not in running
    assert act(coord, "status").json()["stop_observed"] is True


def test_no_isolation_no_start(client, world, monkeypatch):
    hive, swarm, coord, spec, person, running = world
    client.put(f"/api/lifecycle/delegations/{coord['id']}", headers=person, json={"specialist_ids": [spec["id"]]})
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "probe", "assignee": "Red"}).json()
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")
    out = client.post("/api/lifecycle/leases", headers=person, json={"coordinator": coord["id"], "specialist": spec["id"],
                                                                     "task": goal["id"], "seconds": 60, "budget_usd": 0.2})
    assert out.status_code == 403 and "isolation" in out.json()["error"]["message"]


def test_a_running_specialist_without_an_actual_sandbox_loses_its_lease(client, world):
    hive, swarm, coord, spec, person, running = world
    client.put(f"/api/lifecycle/delegations/{coord['id']}", headers=person, json={"specialist_ids": [spec["id"]]})
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "probe", "assignee": "Red"}).json()
    lease = client.post("/api/lifecycle/leases", headers=person, json={"coordinator": coord["id"], "specialist": spec["id"],
                                                                       "task": goal["id"], "seconds": 120, "budget_usd": 0.3}).json()["lease"]
    client.post("/api/agent/lifecycle/start", headers=agent_headers(coord), json={"lease": lease})
    hive.supervisor.driver(None).isolation[spec["id"]] = {"os_sandbox": False}     # the process turned out unconfined
    receipts = asyncio.run(hive.delegation.reconcile())
    assert receipts and receipts[0]["stop_observed"] is True and spec["id"] not in running


def test_review_submission_stops_and_return_needs_fresh_person_lease(client, world):
    hive, swarm, coord, spec, person, running = world
    client.put(f"/api/lifecycle/delegations/{coord['id']}",headers=person,json={"specialist_ids":[spec['id']]})
    goal=asyncio.run(hive.goals.create(swarm['id'],'Invented reviewed task',assignee=spec['id'],binding={'review':'person'}))
    body={"coordinator":coord['id'],"specialist":spec['id'],"task":goal['id'],"seconds":120,"budget_usd":.1}
    lease=client.post('/api/lifecycle/leases',headers=person,json=body).json()['lease']
    def action(verb,token=lease):
        return client.post('/api/agent/lifecycle/'+verb,headers=agent_headers(coord),json={'lease':token})
    assert action('start').status_code==200 and spec['id'] in running
    hive.goals.claim(spec,goal['id'])
    asyncio.run(hive.goals.result(spec,goal['id'],'done','Invented result',data={'binding':{'review':'person'}}))
    assert hive.goals.get(goal['id'])['status']=='submitted'
    assert asyncio.run(hive.delegation.reconcile())==[{'specialist':spec['id'],'stop_observed':True}]
    assert spec['id'] not in running and action('status').json()['task_status']=='submitted'
    assert client.post('/api/lifecycle/leases',headers=person,json=body).status_code==403
    asyncio.run(hive.goals.review(goal['id'],{'kind':'person','principal':'fixture-reviewer','admin':True},'return','Invented revision'))
    assert action('start').status_code==403
    fresh=client.post('/api/lifecycle/leases',headers=person,json=body).json()['lease']
    assert fresh!=lease and action('start',fresh).status_code==200
    assert action('stop',fresh).status_code==200 and spec['id'] not in running


@pytest.mark.parametrize('authority',['delegator','issuer'])
@pytest.mark.parametrize('change',[{'disabled':1},{'role':'member'}])
@pytest.mark.parametrize('started',[False,True])
def test_current_person_authority_revocation_closes_run(client,world,authority,change,started):
    hive,swarm,coord,spec,person,running=world
    client.put(f"/api/lifecycle/delegations/{coord['id']}",headers=person,json={'specialist_ids':[spec['id']]})
    token=secrets.token_urlsafe(24)
    hive.db.insert('people',{'id':'u_issuer','email':'issuer@example.test','name':'Issuer','role':'admin','created_at':now()})
    hive.db.insert('sessions',{'token_hash':token_hash(token),'created_at':now(),'kind':'sso','principal':'user:u_issuer'})
    goal=asyncio.run(hive.goals.create(swarm['id'],'Invented authority task',assignee=spec['id']))
    lease=client.post('/api/lifecycle/leases',headers={'Authorization':'Bearer '+token},json={'coordinator':coord['id'],'specialist':spec['id'],'task':goal['id'],'seconds':120,'budget_usd':.1}).json()['lease']
    def act(verb):return client.post('/api/agent/lifecycle/'+verb,headers=agent_headers(coord),json={'lease':lease})
    if started:assert act('start').status_code==200
    hive.db.update('people','u_quinn' if authority=='delegator' else 'u_issuer',change)
    assert act('status').json()['lease_valid'] is False
    assert act('start').status_code==403
    assert asyncio.run(hive.delegation.reconcile())[0]['stop_observed']
    assert spec['id'] not in running
    hive.db.update('people','u_quinn' if authority=='delegator' else 'u_issuer',{'disabled':0,'role':'admin'})
    assert act('start').status_code==403  # restoring the person cannot resurrect a consumed run


def test_detected_issuer_revocation_persists_before_cleanup(client,world):
    hive,swarm,coord,spec,person,running=world
    client.put(f"/api/lifecycle/delegations/{coord['id']}",headers=person,json={'specialist_ids':[spec['id']]})
    goal=asyncio.run(hive.goals.create(swarm['id'],'Invented restoration task',assignee=spec['id']))
    lease=client.post('/api/lifecycle/leases',headers=person,json={'coordinator':coord['id'],'specialist':spec['id'],'task':goal['id'],'seconds':120,'budget_usd':.1}).json()['lease']
    hive.db.update('people','u_quinn',{'disabled':1})
    assert client.post('/api/agent/lifecycle/status',headers=agent_headers(coord),json={'lease':lease}).json()['lease_valid'] is False
    hive.db.update('people','u_quinn',{'disabled':0})
    from hive.core.delegation import Delegation
    hive.delegation=Delegation(hive)  # persisted revocation survives adapter reconstruction
    assert client.post('/api/agent/lifecycle/start',headers=agent_headers(coord),json={'lease':lease}).status_code==403
    assert spec['id'] not in running


def test_legacy_lease_without_person_custody_fails_closed(client,world):
    hive,swarm,coord,spec,person,running=world
    client.put(f"/api/lifecycle/delegations/{coord['id']}",headers=person,json={'specialist_ids':[spec['id']]})
    goal=asyncio.run(hive.goals.create(swarm['id'],'Invented legacy task',assignee=spec['id']))
    lease=client.post('/api/lifecycle/leases',headers=person,json={'coordinator':coord['id'],'specialist':spec['id'],'task':goal['id'],'seconds':120,'budget_usd':.1}).json()['lease']
    hive.db.execute('DELETE FROM lifecycle_authorities WHERE lease=?',(lease,))
    assert client.post('/api/agent/lifecycle/start',headers=agent_headers(coord),json={'lease':lease}).status_code==403
    assert asyncio.run(hive.delegation.reconcile())[0]['stop_observed']
    assert spec['id'] not in running
