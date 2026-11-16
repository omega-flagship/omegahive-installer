"""Candidate validator findings projection: synthetic disposable records only."""
import json
from copy import deepcopy
from hive.tests.test_core_api import client  # noqa: F401


def test_projection_preserves_findings_and_filters_request_family(client):
    mandate = {'id':'feasibility','version':'1'}
    swarms, (asker, planner, reviewer, foreign), root = setup(client, mandate)
    artifact = planner.create_plan('Invented context')
    first = planner.publish(artifact['id'], plan())
    review = planner.request_review(root['receiving_goal'], swarms[2]['id'], first, [mandate], ['synthetic:receipt'], .2)
    reviewer.claim(review['receiving_goal'])
    finding = reviewer.finding(review['id'], mandate, 'prepare', 'major', ['synthetic:receipt'], 'Keep objection')
    reviewer.complete_review(review['id'],'hold','Invented objection remains',[finding['id']],['prepare'])
    second_plan = deepcopy(plan());second_plan['steps'][0]['fallback']='another invented fallback'
    planner.publish(artifact['id'],second_plan,parent=1)
    planner.respond(finding['id'],2,'addressed','Planner claim only')
    other_root = asker.request_plan(root['from_goal'],swarms[1]['id'],'Other invented round',['return plan'],{},[],1)
    planner.claim(other_root['receiving_goal'])
    planner.request_review(other_root['receiving_goal'],swarms[2]['id'],first,[mandate],[],.2)
    hive = client.app.state.hive
    goal = hive.goals.view(hive.goals.get(root['receiving_goal']))
    before = len(client.supervisor.calls)
    context = hive.collab.planning_review_context(goal,root['id'],artifact['id'],2)
    assert context['latest_revision'] == 2
    assert context['findings'][0]['id'] == finding['id']
    assert context['findings'][0]['disposition'] is None
    assert context['findings'][0]['planner_response']['stance']=='addressed'
    assert context['reviews'][0]['receipt']['recommendation']=='hold'
    assert context['reviews'][0]['subject']['digest']==first['digest']
    assert len(context['reviews']) == 1  # same artifact, different request family excluded
    assert context['authority']=='none'
    assert hive.collab.planning_review_context(goal,root['id'],artifact['id'],1)['latest_revision']==2
    foreign_art = foreign.create_plan('Invented foreign context');foreign.publish(foreign_art['id'],plan())
    assert hive.collab.planning_review_context(goal,root['id'],foreign_art['id'],1) is None
    assert hive.collab.planning_review_context(goal,review['id'],artifact['id'],2) is None
    assert len(client.supervisor.calls)==before
    asker.cancel(root['id'])
    assert hive.collab.planning_review_context(goal,root['id'],artifact['id'],2) is None


def test_native_checker_receives_context_and_cannot_switch_request(client,monkeypatch,tmp_path):
    folder=tmp_path/'findings-fixture';folder.mkdir()
    (folder/'plugin.json').write_text(json.dumps({'id':'findings-fixture','name':'Synthetic findings checker','version':'1'}))
    (folder/'program.py').write_text('''def describe(): return {"kinds":[{"id":"plan","role":"other"}]}
def view(ctx,focus,stage): return {"nodes":[],"edges":[]}
def act(ctx,action,items,params): return {"ok":False}
def validate_result(ctx,goal,proposal):
    ref=proposal['plan']
    out=ctx.findings(proposal['request_id'],ref['artifact_id'],ref['n'])
    return {"ok":out is not None and out['latest_revision']==ref['n'],"errors":[] if out is not None else ["context refused"]}
''')
    monkeypatch.setenv('HIVE_PLUGIN_DIRS',str(tmp_path));hive=client.app.state.hive;hive.programs.reload()
    _, (asker,planner,_,_), root=setup(client)
    hive.db.update('requests',root['id'],{'constraints':json.dumps({'validate':'program:findings-fixture'})})
    artifact=planner.create_plan('Invented callback');revision=planner.publish(artifact['id'],plan())
    import pytest
    with pytest.raises(HiveError) as exc:
        planner.complete(root['receiving_goal'],'Wrong request',{'request_id':'rq_foreign','plan':revision})
    assert exc.value.status==422
    assert planner.complete(root['receiving_goal'],'Current context',{'request_id':root['id'],'plan':revision})['status']=='submitted'


# Local synthetic API helpers keep this platform test independent of owner packages.
class HiveError(RuntimeError):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(f"Hive refused ({status}): {code}")

class HivePlanner:
    def __init__(self, transport, token):
            self.transport = transport
            self._headers = {"Authorization": "Bearer " + token}

    def _call(self, method, path, body=None):
            response = self.transport.request(method, path, headers=self._headers, json=body)
            if response.status_code >= 400:
                error = response.json().get("error", {})
                raise HiveError(response.status_code, error.get("code", "unknown"))
            return response.json()

    def request_plan(self, held_goal, planner_swarm, title, acceptance, constraints, context_refs, budget_usd):
            return self._call("POST", "/api/agent/requests", {"from_goal": held_goal, "to_swarm": planner_swarm, "kind": "plan", "title": title, "acceptance": acceptance, "constraints": constraints, "context_refs": context_refs, "budget_usd": budget_usd})

    def claim(self, goal_id):
            return self._call("POST", f"/api/agent/goals/{goal_id}/claim")

    def create_plan(self, title):
            return self._call("POST", "/api/agent/artifacts", {"kind": "plan", "title": title})

    def publish(self, artifact_id, plan, parent=None):
                return self._call("POST", f"/api/agent/artifacts/{artifact_id}/revisions", {"body": json.dumps(plan,sort_keys=True,separators=(",",":")), "parent": parent, "dependency_graph": {s["id"]: s["depends_on"] for s in plan["steps"]}})

    def request_review(self, held_goal, review_swarm, revision, mandates, context_refs, budget_usd, *, review_by=None):
            constraints = {"mandates": mandates}
            if review_by is not None:
                constraints["review"] = review_by
            return self._call("POST", "/api/agent/requests", {"from_goal": held_goal, "to_swarm": review_swarm, "kind": "review", "title": "Review plan revision " + str(revision["n"]), "subject": {"artifact_id": revision["artifact_id"], "revision": revision["n"], "digest": revision["digest"]}, "constraints": constraints, "context_refs": context_refs, "budget_usd": budget_usd})

    def finding(self, request_id, mandate, step, severity, evidence_refs, recommendation):
            return self._call("POST", "/api/agent/findings", {"request_id": request_id, "mandate": mandate, "target": {"step": step}, "severity": severity, "evidence_refs": evidence_refs, "recommendation": recommendation})

    def respond(self, finding_id, revision, stance, note):
            return self._call("POST", f"/api/agent/findings/{finding_id}/response", {"revision": revision, "stance": stance, "note": note})

    def complete(self, goal_id, result, proposal):
            goal = self._call("GET", f"/api/agent/goals/{goal_id}")
            return self._call("POST", f"/api/agent/goals/{goal_id}/result", {"status": "done", "result": result, "data": {"binding_digest": goal["binding_digest"], "proposal": proposal}})

    def complete_review(self, request_id, recommendation, rationale, finding_ids, coverage):
            """Submit review inputs; Hive binds identity, subject and finding digests.

            List only findings raised on this request. Earlier findings remain in
            canonical history and may be dispositioned through the current review.
            """
            return self._call("POST", f"/api/agent/requests/{request_id}/review-complete", {
                "recommendation": recommendation, "rationale": rationale,
                "finding_ids": finding_ids, "coverage": coverage})

    def review_result(self, goal_id, decision, notes=""):
            """Requester accepts or returns submitted work under native review policy."""
            return self._call("POST", f"/api/agent/goals/{goal_id}/review", {
                "decision": decision, "notes": notes})

    def cancel(self, request_id):
            return self._call("POST", f"/api/agent/requests/{request_id}/cancel")

def plan():
    return {"goal": "Invented workshop", "constraints": {"synthetic": True}, "unknowns": [], "acceptance": ["recover if room unavailable"], "steps": [{"id": "prepare", "depends_on": [], "output": "room plan", "completion_check": "inspect invented plan", "owner_proposal": "unassigned", "capabilities_required": [], "resources": {}, "fallback": "ask again"}, {"id": "schedule", "depends_on": ["prepare"], "output": "schedule", "completion_check": "inspect invented schedule", "owner_proposal": "unassigned", "capabilities_required": [], "resources": {}, "fallback": "delay"}]}

def setup(client, mandate=None):
    swarms = [client.post("/api/swarms", json={"name": name}).json() for name in ["Requester", "Planner", "Review", "Foreign"]]
    agents = [client.post("/api/agents", json={"name": name, "kind": "module", "swarm_id": s["id"]}).json() for name, s in zip(["Asker", "Plan", "Critic", "Other"], swarms)]
    apis = [HivePlanner(client, a["token"]) for a in agents]
    if mandate:
        role = client.post("/api/roles", json={"name": "Invented mandate reviewer", "prompt": "Review only invented inputs", "mandate": mandate}).json()
        assert "id" in role
        assert client.patch(f"/api/agents/{agents[2]['id']}", json={"role_id": role["id"]}).status_code == 200
    for swarm, kind in [(swarms[1], "plan"), (swarms[2], "review")]:
        assert client.put(f"/api/swarms/{swarm['id']}/services", json={"kinds": [kind]}).status_code == 200
    goal = client.post(f"/api/swarms/{swarms[0]['id']}/goals", json={"title": "invented task", "assignee": agents[0]["name"]}).json()
    apis[0].claim(goal["id"])
    rq = apis[0].request_plan(goal["id"], swarms[1]["id"], "Plan workshop", ["return a plan"], {"synthetic": True}, [], 1)
    apis[1].claim(rq["receiving_goal"])
    return swarms, apis, rq


import pytest


@pytest.mark.parametrize('change', ['finding', 'revision'])
def test_changed_review_context_cannot_be_saved_after_validation(client, monkeypatch, tmp_path, change):
    folder=tmp_path/'custody-fixture';folder.mkdir()
    (folder/'plugin.json').write_text(json.dumps({'id':'custody-fixture','name':'Synthetic custody checker','version':'1'}))
    (folder/'program.py').write_text('''def describe(): return {"kinds":[{"id":"plan","role":"other"}]}
def view(ctx,focus,stage): return {"nodes":[],"edges":[]}
def act(ctx,action,items,params): return {"ok":False}
def validate_result(ctx,goal,proposal):
    ref=proposal['plan']
    out=ctx.findings(goal['binding']['request_id'],ref['artifact_id'],ref['n'])
    return {"ok":out is not None}
''')
    monkeypatch.setenv('HIVE_PLUGIN_DIRS',str(tmp_path));hive=client.app.state.hive;hive.programs.reload()
    mandate={'id':'feasibility','version':'1'}
    swarms,(_,planner,reviewer,_),root=setup(client,mandate)
    hive.db.update('requests',root['id'],{'constraints':json.dumps({'validate':'program:custody-fixture'})})
    artifact=planner.create_plan('Invented race');revision=planner.publish(artifact['id'],plan())
    review=planner.request_review(root['receiving_goal'],swarms[2]['id'],revision,[mandate],['synthetic:receipt'],.2)
    reviewer.claim(review['receiving_goal'])
    finding=reviewer.finding(review['id'],mandate,'prepare','major',['synthetic:receipt'],'Initial objection')
    original=hive.goals._run_validator
    async def changed_after_check(goal,agent,proposal):
        result=await original(goal,agent,proposal)
        assert not result and result.read_guards
        if change=='finding':
            hive.db.update('findings',finding['id'],{'recommendation':'Changed after checker passed'})
        else:
            row=hive.db.one('SELECT * FROM artifact_revisions WHERE artifact_id = ? AND n = 1',(artifact['id'],))
            row.update(n=2,parent=1)
            hive.db.insert('artifact_revisions',row)
        return result
    monkeypatch.setattr(hive.goals,'_run_validator',changed_after_check)
    with pytest.raises(HiveError) as exc:
        planner.complete(root['receiving_goal'],'Checked before change',{'plan':revision})
    assert exc.value.code=='validation_context_changed'
    goal=client.get(f"/api/goals/{root['receiving_goal']}").json()
    assert goal['status']=='claimed' and goal['result'] is None
    assert client.get(f"/api/goals/{root['receiving_goal']}/reviews").json()==[]
    monkeypatch.setattr(hive.goals,'_run_validator',original)
    assert planner.complete(root['receiving_goal'],'Fresh context',{'plan':revision})['status']=='submitted'


def test_native_projection_only_current_holding_planner(client):
    swarms, (asker, planner, reviewer, foreign), root = setup(client)
    artifact = planner.create_plan('Invented native projection')
    planner.publish(artifact['id'], plan())
    path = f"/api/agent/requests/{root['id']}/review-context"
    params = {'artifact_id': artifact['id'], 'revision': 1}
    response = client.get(path, params=params, headers=planner._headers)
    assert response.status_code == 200
    assert response.json()['authority'] == 'none'
    for other in (asker, reviewer, foreign):
        assert client.get(path, params=params, headers=other._headers).status_code == 403
    peer = client.post('/api/agents', json={'name': 'Peer planner', 'kind': 'module', 'swarm_id': swarms[1]['id']}).json()
    assert client.get(path, params=params, headers={'Authorization': 'Bearer ' + peer['token']}).status_code == 403
    params['artifact_id'] = 'ar_missing'
    assert client.get(path, params=params, headers=planner._headers).status_code == 409
    params['artifact_id'] = artifact['id']
    client.app.state.hive.db.update('goals', root['receiving_goal'], {'lease_until': '2000-01-01T00:00:00'})
    assert client.get(path, params=params, headers=planner._headers).status_code == 409
