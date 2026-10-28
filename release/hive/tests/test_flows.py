"""Explicit isolated host qualification; seeded synthetic identities, no live worker.
Run with the candidate snapshot first on PYTHONPATH. This isn't an IdP test.
"""
import asyncio
import copy
import json
from concurrent.futures import ThreadPoolExecutor
import pytest
from hive.tests.test_core_api import client, agent_headers, FakeSupervisor  # noqa: F401
from hive.tests.test_visibility import person
from hive.core.flows import Flows
from hive.core.hive import Hive
from hive.flow_ir.examples.garden import garden


@pytest.fixture
def setup(client):
    owner=person(client,'u_flow_owner')
    swarm=client.post('/api/swarms',headers=owner,json={'name':'Synthetic garden'}).json()
    worker=client.post('/api/agents',headers=owner,json={'name':'Garden worker','swarm_id':swarm['id']}).json()
    f=garden();es={e['id']:e for e in f['elements']}
    for e in f['elements']:e['meta']['revision_state']='adopted'
    es['submitted']['type']='run.start'
    es['accepted']['type']='goal.done';es['accepted']['props']['source_transition']='t0'
    event=copy.deepcopy(es['accepted']);event['id']='review-done';event['props']['source_transition']='t1';f['elements'].append(event)
    es['t1']['trigger']='accepted';es['t2']['trigger']='review-done';es['t2']['props']['requires_approval']=False
    schema={'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}
    for tid in ('t0','t1','t2'):
        es[tid]['action']={'kind':'goal','target':swarm['id'],'params':{'title':f'Garden {tid}','assignee':worker['id'],'result_schema':schema,'review':'person' if tid=='t1' else 'none'}}
    out=client.post(f"/api/swarms/{swarm['id']}/flows",headers=owner,json={'title':'Garden flow','body':f,'layout':{'visitor':{'x':10,'y':20}}})
    assert out.status_code==200,out.text
    flow=out.json();prefix=f"/api/flows/{flow['artifact_id']}/revisions/{flow['revision']}"
    return client,owner,swarm,worker,f,flow,prefix


def adopt_start(setup,key='run-1'):
    c,owner,_,_,_,flow,path=setup
    out=c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']});assert out.status_code==200,out.text
    out=c.post(path+'/runs',headers=owner,json={'digest':flow['digest'],'client_key':key});assert out.status_code==200,out.text
    return out.json()


def reconcile(c):asyncio.run(c.app.state.hive.flows.reconcile())


def goal_for(run,tid):return next(s['goal_id'] for s in run['steps'] if s['transition_id']==tid)


def finish(c,worker,gid,proposal=None):
    auth=agent_headers(worker)
    out=c.post(f'/api/agent/goals/{gid}/claim',headers=auth);assert out.status_code==200,out.text
    g=c.get(f'/api/agent/goals/{gid}',headers=auth).json()
    out=c.post(f'/api/agent/goals/{gid}/result',headers=auth,json={'status':'done','result':'synthetic result','data':{'binding_digest':g['binding_digest'],'proposal':proposal if proposal is not None else {'ok':True}}})
    return out


def getrun(setup,rid):
    c,owner,*_=setup
    return c.get('/api/flow-runs/'+rid,headers=owner).json()


def count(c):return c.app.state.hive.db.one("SELECT COUNT(*) AS n FROM goals WHERE id LIKE 'g_flow_%'")['n']


def test_immutable_artifact_and_layout_sidecar(setup):
    c,owner,swarm,worker,f,flow,path=setup
    assert flow['host_digest']=='sha256:'+flow['digest']
    author=c.app.state.hive.db.one('SELECT author FROM artifact_revisions WHERE artifact_id=?',(flow['artifact_id'],))['author']
    assert author=='user:u_flow_owner'
    moved=c.put(path+'/layout',headers=owner,json={'expected_version':1,'layout':{'visitor':{'x':500,'y':20}}}).json()
    assert moved['digest']==flow['digest'] and moved['layout_version']==2
    assert c.put(path+'/layout',headers=owner,json={'expected_version':1,'layout':{}}).status_code==409
    changed=copy.deepcopy(f);changed['elements'][0]['props']['label']='changed'
    nxt=c.post(f"/api/swarms/{swarm['id']}/flows",headers=owner,json={'artifact_id':flow['artifact_id'],'parent':1,'body':changed,'layout':{}}).json()
    assert nxt['revision']==2 and nxt['digest']!=flow['digest']
    assert c.get(path,headers=owner).json()['body']==f
    assert c.post(f"/api/swarms/{swarm['id']}/flows",headers=owner,json={'artifact_id':flow['artifact_id'],'parent':1,'body':f}).status_code==409
    # Same authoritative body is readable through the native C39 artifact API.
    raw=c.get(f"/api/agent/artifacts/{flow['artifact_id']}/revisions/1",headers=agent_headers(worker))
    assert raw.status_code==200,raw.text
    assert json.loads(raw.json()['body'])==f


def test_adoption_and_named_scope_required(setup):
    c,owner,_,worker,_,flow,path=setup
    assert c.post(path+'/runs',headers=owner,json={'digest':flow['digest'],'client_key':'before'}).status_code==409
    assert c.post(path+'/adopt',headers=owner,json={'digest':'a'*64}).status_code==409
    other=person(c,'u_flow_other')
    assert c.get(path,headers=other).status_code==404
    assert c.post(path+'/adopt',headers=other,json={'digest':flow['digest']}).status_code==404
    assert c.post(path+'/adopt',json={'digest':flow['digest']}).status_code==401
    assert c.post(path+'/adopt',headers=agent_headers(worker),json={'digest':flow['digest']}).status_code==401


def test_bound_goal_pipeline_waits_for_result_and_named_review(setup):
    c,owner,_,worker,_,_,_=setup
    run=adopt_start(setup);rid=run['id'];assert count(c)==1
    assert finish(c,worker,goal_for(run,'t0')).json()['status']=='done';reconcile(c);assert count(c)==2
    goal=goal_for(run,'t1');assert finish(c,worker,goal).json()['status']=='submitted'
    reconcile(c);assert count(c)==2 and getrun(setup,rid)['status']=='running'
    assert c.post(f'/api/agent/goals/{goal}/review',headers=agent_headers(worker),json={'decision':'accept'}).status_code==403
    reviewed=c.post(f'/api/goals/{goal}/review',headers=owner,json={'decision':'accept'});assert reviewed.status_code==200,reviewed.text
    reconcile(c);assert count(c)==3
    assert finish(c,worker,goal_for(run,'t2')).json()['status']=='done';reconcile(c)
    assert getrun(setup,rid)['status']=='done'
    for g in c.app.state.hive.db.all("SELECT * FROM goals WHERE id LIKE 'g_flow_%'"):
        binding=json.loads(g['binding']);assert binding['flow_run_id']==rid
        assert binding['flow_revision_digest']==run['digest'] and g['created_by']=='user:u_flow_owner'
    assert not any(call[0]=='start' for call in c.supervisor.calls)


def test_schema_refusal_stays_with_worker_without_advancing(setup):
    c,_,_,worker,_,_,_=setup;run=adopt_start(setup)
    bad=finish(c,worker,goal_for(run,'t0'),{'ok':'wrong'})
    assert bad.status_code==422
    reconcile(c);assert count(c)==1
    assert c.app.state.hive.goals.get(goal_for(run,'t0'))['status']=='claimed'


def test_review_status_tampering_does_not_advance(setup):
    c,owner,_,worker,_,_,_=setup;run=adopt_start(setup)
    finish(c,worker,goal_for(run,'t0'));reconcile(c)
    gid=goal_for(run,'t1');finish(c,worker,gid)
    # Existing operator goal edit cannot turn a flow's unreviewed result into acceptance.
    assert c.patch('/api/goals/'+gid,headers=owner,json={'status':'claimed'}).status_code==200
    assert c.patch('/api/goals/'+gid,headers=owner,json={'status':'done'}).status_code==200
    reconcile(c);out=getrun(setup,run['id'])
    assert out['status']=='blocked' and out['reason']=='completion_unreviewed' and count(c)==2


def test_repeat_start_is_idempotent_and_key_conflicts_on_new_revision(setup):
    c,owner,swarm,_,f,flow,path=setup;run=adopt_start(setup)
    again=c.post(path+'/runs',headers=owner,json={'digest':flow['digest'],'client_key':'run-1'}).json()
    assert again['id']==run['id'] and count(c)==1
    changed=copy.deepcopy(f);changed['elements'][0]['props']['label']='other'
    nextflow=c.post(f"/api/swarms/{swarm['id']}/flows",headers=owner,json={'body':changed,'layout':{},'artifact_id':flow['artifact_id'],'parent':1}).json()
    p=f"/api/flows/{flow['artifact_id']}/revisions/2"
    assert c.post(p+'/adopt',headers=owner,json={'digest':nextflow['digest']}).status_code==200
    assert c.post(p+'/runs',headers=owner,json={'digest':nextflow['digest'],'client_key':'run-1'}).status_code==409


@pytest.mark.parametrize('stage',['after-goal-insert','before-commit','after-commit'])
def test_crash_and_fresh_controller_recovery_do_not_duplicate_goals(setup,stage):
    c,owner,_,_,_,flow,path=setup;hive=c.app.state.hive
    c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']})
    session=hive.db.one("SELECT * FROM sessions WHERE principal='user:u_flow_owner'")
    run=hive.flows.start(session,flow['artifact_id'],1,{'digest':flow['digest'],'client_key':'crash-'+stage})
    class Crash(BaseException):pass
    def fault(point):
        if point==stage:raise Crash()
    hive.flows._fault=fault
    with pytest.raises(Crash):reconcile(c)
    assert count(c)==(1 if stage=='after-commit' else 0)
    fresh=Hive(hive.settings,supervisor=FakeSupervisor())
    try:
        asyncio.run(fresh.flows.reconcile());asyncio.run(fresh.flows.reconcile())
        assert count(c)==1
        assert fresh.flows.get(session,run['id'])['steps'][0]['goal_id']==goal_for(run,'t0')
    finally:fresh.db._conn.close();hive.flows._fault=lambda _:None


def test_two_controller_process_connections_admit_one_goal(setup):
    c,owner,_,_,_,flow,path=setup;hive=c.app.state.hive
    c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']})
    session=hive.db.one("SELECT * FROM sessions WHERE principal='user:u_flow_owner'")
    run=hive.flows.start(session,flow['artifact_id'],1,{'digest':flow['digest'],'client_key':'race'})
    fresh=Hive(hive.settings,supervisor=FakeSupervisor())
    try:
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(controller._advance,run['id']) for controller in (hive.flows,fresh.flows)]
            for future in futures:future.result(timeout=10)
        assert count(c)==1
    finally:fresh.db._conn.close()


@pytest.mark.parametrize('revoke',['session','person','ownership','adoption'])
def test_revocation_blocks_run_and_cancels_outstanding_goals(setup,revoke):
    c,owner,swarm,worker,_,flow,path=setup;run=adopt_start(setup);hive=c.app.state.hive
    if revoke=='session':hive.db.execute("DELETE FROM sessions WHERE principal='user:u_flow_owner'")
    if revoke=='person':hive.db.execute("UPDATE people SET disabled=1 WHERE id='u_flow_owner'")
    if revoke=='ownership':hive.db.update('swarms',swarm['id'],{'owner':'user:u_different'})
    if revoke=='adoption':assert c.delete(path+'/adoption',headers=owner).status_code==200
    reconcile(c)
    row=hive.db.one('SELECT * FROM flow_runs WHERE id=?',(run['id'],))
    assert row['status']=='blocked' and count(c)==1
    assert hive.goals.get(goal_for(run,'t0'))['status']=='cancelled'


def test_an_expired_starter_sign_in_does_not_block_an_admitted_run(setup):
    c,owner,swarm,worker,_,flow,path=setup;run=adopt_start(setup);hive=c.app.state.hive
    hive.db.execute("UPDATE sessions SET expires_at=1 WHERE principal='user:u_flow_owner'")
    reconcile(c)
    assert hive.db.one('SELECT status FROM flow_runs WHERE id=?',(run['id'],))['status']=='running'
    assert hive.goals.get(goal_for(run,'t0'))['status']!='cancelled'
    # a new action by the same expired session is still refused; only the admitted run continues
    assert c.post(path+'/runs',headers=owner,json={'digest':flow['digest'],'client_key':'again'}).status_code==401
    hive.db.execute("UPDATE people SET disabled=1 WHERE id='u_flow_owner'")   # standing is still re-checked
    reconcile(c)
    assert hive.db.one('SELECT status FROM flow_runs WHERE id=?',(run['id'],))['status']=='blocked'


def test_cancellation_before_dispatch_and_after_dispatch(setup):
    c,owner,_,worker,_,flow,path=setup;hive=c.app.state.hive
    c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']})
    session=hive.db.one("SELECT * FROM sessions WHERE principal='user:u_flow_owner'")
    pending=hive.flows.start(session,flow['artifact_id'],1,{'digest':flow['digest'],'client_key':'pending'})
    assert c.post('/api/flow-runs/'+pending['id']+'/cancel',headers=owner).json()['status']=='cancelled'
    reconcile(c);assert count(c)==0
    run=adopt_start(setup,'dispatched');gid=goal_for(run,'t0')
    c.post(f'/api/agent/goals/{gid}/claim',headers=agent_headers(worker))
    assert c.post('/api/flow-runs/'+run['id']+'/cancel',headers=owner).json()['status']=='cancelled'
    reconcile(c);assert count(c)==1 and hive.goals.get(gid)['status']=='cancelled'
    assert c.post(f'/api/agent/goals/{gid}/result',headers=agent_headers(worker),json={'status':'done','result':'late'}).status_code==409


@pytest.mark.parametrize('case',['cycle','guard','external-target','message','unknown-param','draft','trigger','source'])
def test_unsupported_forms_are_refused_before_run_or_goal_creation(setup,case):
    c,owner,swarm,_,f,_,_=setup;f=copy.deepcopy(f);es={e['id']:e for e in f['elements']}
    if case=='cycle':es['t2']['to']='visitor'
    if case=='guard':
        item=copy.deepcopy(es['visitor']);item.update(id='guard',kind='constraint',predicate='all-present',members=['visitor']);del item['type'];del item['ref'];f['elements'].append(item);es['t0']['guards']=['guard']
    if case=='external-target':es['t0']['action']['target']='external'
    if case=='message':es['t0']['action']['kind']='message'
    if case=='unknown-param':es['t0']['action']['params']['binding']={'authority':'admin'}
    if case=='draft':es['t0']['meta']['revision_state']='draft'
    if case=='trigger':es['submitted']['type']='external.event'
    if case=='source':es['accepted']['props']['source_transition']='unknown'
    out=c.post(f"/api/swarms/{swarm['id']}/flows",headers=owner,json={'title':'Unsupported','body':f,'layout':{}}).json()
    path=f"/api/flows/{out['artifact_id']}/revisions/1"
    assert c.post(path+'/adopt',headers=owner,json={'digest':out['digest']}).status_code in (400,409)
    assert count(c)==0 and c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM flow_runs')['n']==0


def test_split_work_cancels_with_run_and_cannot_delegate_outside_subset(setup):
    c,owner,_,worker,_,_,_=setup;run=adopt_start(setup);gid=goal_for(run,'t0');auth=agent_headers(worker)
    assert c.post(f'/api/agent/goals/{gid}/claim',headers=auth).status_code==200
    child=c.post('/api/agent/goals',headers=auth,json={'title':'Synthetic child','parent_id':gid}).json()
    assert child['id'] and c.post(f"/api/agent/goals/{child['id']}/claim",headers=auth).status_code==200
    receiving=c.post('/api/swarms',json={'name':'Synthetic receiving'}).json()
    c.put(f"/api/swarms/{receiving['id']}/services",json={'kinds':['design']})
    request=c.post('/api/agent/requests',headers=auth,json={'kind':'design','to_swarm':receiving['id'],'title':'must refuse','from_goal':child['id']})
    assert request.status_code==409 and request.json()['error']['code']=='unsupported_flow_delegation'
    assert c.post('/api/flow-runs/'+run['id']+'/cancel',headers=owner).status_code==200
    assert c.app.state.hive.goals.get(child['id'])['status']=='cancelled'
    late=c.post('/api/agent/goals',headers=auth,json={'title':'late child','parent_id':gid})
    assert late.status_code==409 and late.json()['error']['code']=='parent_inactive'


def test_parent_completion_with_unfinished_child_does_not_advance(setup):
    c,_,_,worker,_,_,_=setup;run=adopt_start(setup);gid=goal_for(run,'t0');auth=agent_headers(worker)
    assert c.post(f'/api/agent/goals/{gid}/claim',headers=auth).status_code==200
    child=c.post('/api/agent/goals',headers=auth,json={'title':'Unfinished child','parent_id':gid}).json()
    g=c.get(f'/api/agent/goals/{gid}',headers=auth).json()
    assert c.post(f'/api/agent/goals/{gid}/result',headers=auth,json={'status':'done','result':'premature','data':{'binding_digest':g['binding_digest'],'proposal':{'ok':True}}}).status_code==200
    reconcile(c);out=getrun(setup,run['id'])
    assert out['status']=='blocked' and out['reason']=='delegated_work_incomplete' and count(c)==1
    assert c.app.state.hive.goals.get(child['id'])['status']=='cancelled'


def test_template_catalogue_requires_auth_and_does_not_create_state(client):
    assert client.get('/api/flows/templates', headers={'Authorization':'Bearer invalid'}).status_code == 401
    owner = person(client, 'u_template_reader')
    before = {table: client.app.state.hive.db.one(f'SELECT COUNT(*) AS n FROM {table}')["n"]
              for table in ('goals', 'artifacts', 'artifact_revisions')}
    response = client.get('/api/flows/templates', headers=owner)
    assert response.status_code == 200
    templates = response.json()['templates']
    assert len(templates) == 5
    assert all(t['revision']['execution_authority'] == 'none' for t in templates)
    assert before == {table: client.app.state.hive.db.one(f'SELECT COUNT(*) AS n FROM {table}')["n"] for table in before}


def test_agent_authoring_is_scoped_and_inert(setup):
    c,owner,swarm,worker,_,_,_=setup
    auth=agent_headers(worker); f=garden()
    out=c.post('/api/agent/flows',headers=auth,json={'title':'Agent draft','body':f})
    assert out.status_code==200,out.text
    draft=out.json();path=f"/api/agent/flows/{draft['artifact_id']}/revisions"
    assert draft['execution_authorized'] is False
    author=c.app.state.hive.db.one('SELECT author FROM artifact_revisions WHERE artifact_id=?',(draft['artifact_id'],))['author']
    assert author=='agent:'+worker['id']
    assert c.get(path+'/1',headers=auth).json()['body']==f
    assert any(a['artifact_id']==draft['artifact_id'] for a in c.get('/api/agent/flows/drafts',headers=auth).json())
    changed=copy.deepcopy(f);changed['elements'][0]['props']['label']='Changed'
    assert c.post(path,headers=auth,json={'body':changed,'parent':1}).json()['revision']==2
    assert c.post(path,headers=auth,json={'body':f,'parent':1}).status_code==409
    other=c.post('/api/swarms',headers=owner,json={'name':'Other'}).json()
    stranger=c.post('/api/agents',headers=owner,json={'name':'Other mind','swarm_id':other['id']}).json()
    assert c.get(path+'/1',headers=agent_headers(stranger)).status_code==404
    assert c.post(path,headers=agent_headers(stranger),json={'body':f,'parent':2}).status_code==404
    assert count(c)==0
    assert c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM flow_runs')['n']==0
    assert c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM flow_adoptions')['n']==0


@pytest.mark.parametrize('mutation',['policy','error','deleted','token','moved'])
def test_agent_authoring_rechecks_authority(setup,mutation):
    c,_,_,worker,*_=setup;h=c.app.state.hive;auth=agent_headers(worker)
    if mutation=='policy':h.policy.add_rule('agent:'+worker['id'],'hive-flow-draft','deny','test')
    else:h.db.update('agents',worker['id'],{'status':'error'} if mutation=='error' else {'deleted':1} if mutation=='deleted' else {'token_hash':'rotated'} if mutation=='token' else {'moved_to':'other'})
    out=c.post('/api/agent/flows',headers=auth,json={'title':'Refused','body':garden()})
    assert out.status_code in (401,403),out.text


@pytest.mark.parametrize('mutation',['adopted','unknown','oversized','invalid','parent'])
def test_agent_draft_invalid_inputs_create_no_artifact(setup,mutation):
    c,_,_,worker,*_=setup;data={'title':'Draft','body':garden()};db=c.app.state.hive.db
    if mutation=='adopted':data['body']['elements'][0]['meta']['revision_state']='adopted'
    elif mutation=='unknown':data['execute']=True
    elif mutation=='oversized':data['body']['elements'][0]['props']['label']='x'*270000
    elif mutation=='invalid':data['body']={}
    else:data['parent']=1
    before=db.one('SELECT COUNT(*) AS n FROM artifacts')['n']
    assert c.post('/api/agent/flows',headers=agent_headers(worker),json=data).status_code in (400,413)
    assert db.one('SELECT COUNT(*) AS n FROM artifacts')['n']==before


def test_agent_read_policy_refusal_rolls_back_draft(setup):
    c,_,_,worker,*_=setup;h=c.app.state.hive
    before=h.db.one('SELECT COUNT(*) AS n FROM artifacts')['n']
    h.policy.add_rule('agent:'+worker['id'],'hive-flow-read','deny','test')
    assert c.post('/api/agent/flows',headers=agent_headers(worker),json={'title':'Draft','body':garden()}).status_code==403
    assert h.db.one('SELECT COUNT(*) AS n FROM artifacts')['n']==before
    h.policy.add_rule('agent:'+worker['id'],'hive-flows','deny','test')
    assert c.get('/api/agent/flows',headers=agent_headers(worker)).status_code==403


def test_native_flow_bridge_preserves_exact_content(setup,monkeypatch):
    from hive.tests.test_hive_module_semicolons import hc
    c,_,_,worker,*_=setup;auth=agent_headers(worker)
    def call(method,path,payload=None):
        out=c.request(method,path,headers=auth,json=payload)
        return (out.json(),None) if out.status_code<400 else (None,'HIVE-ERROR '+str(out.status_code))
    monkeypatch.setattr(hc,'_call',call)
    f=garden();f['elements'][0]['props']['label']='Literal ; ⁏ unicode 🌱'
    made=hc.decode(hc.flow_draft(hc.encode(json.dumps({'title':'Bridge','body':f}))))
    draft=json.loads(made.split(' ',1)[1]);art=draft['artifact_id']
    value=json.loads(hc.decode(hc.flow_read(art,1)).split(' ',1)[1]);assert value['body']==f
    f['elements'][0]['props']['label']='Revised ; value'
    assert json.loads(hc.decode(hc.flow_revise(art,hc.encode(json.dumps({'parent':1,'body':f})))).split(' ',1)[1])['revision']==2
    assert art in hc.decode(hc.flow_drafts())
    assert hc.decode(hc.flow_draft('[]')).startswith('HIVE-ERROR')


def register(setup,name='garden-skill'):
    c,owner,swarm,worker,f,flow,path=setup
    c.app.state.hive.policy.add_rule('agent:'+worker['id'],'hive-flow-publish','allow','synthetic exact permission')
    response=c.post('/api/agent/flows/skills',headers=agent_headers(worker),json={'name':name,'purpose':'Synthetic procedure','artifact_id':flow['artifact_id'],'revision':flow['revision'],'digest':flow['digest']})
    assert response.status_code==200,response.text
    return name


def agent_start(setup,name='garden-skill',key='agent-run'):
    c,owner,_,worker,_,flow,path=setup
    assert c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']}).status_code==200
    out=c.post(f'/api/agent/flows/skills/{name}/runs',headers=agent_headers(worker),json={'params':{},'client_key':key})
    assert out.status_code==200,out.text
    return out.json()


@pytest.mark.parametrize('scope,skill',[(None,None),('hive','hive-flow-publish'),('swarm','hive-flow-publish'),('agent','hive-*')])
def test_flow_skill_publication_requires_exact_agent_rule(setup,scope,skill):
    c,_,swarm,worker,_,flow,_=setup
    if scope:c.app.state.hive.policy.add_rule('swarm:'+swarm['id'] if scope=='swarm' else 'agent:'+worker['id'] if scope=='agent' else scope,skill,'allow')
    out=c.post('/api/agent/flows/skills',headers=agent_headers(worker),json={'name':'garden','purpose':'Purpose','artifact_id':flow['artifact_id'],'revision':1,'digest':flow['digest']})
    assert out.status_code==403,out.text
    assert c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM flow_skills')['n']==0


def test_agent_skill_adoption_and_person_expiry_are_separate(setup):
    c,owner,_,worker,_,flow,path=setup;name=register(setup)
    request={'params':{},'client_key':'run'};auth=agent_headers(worker)
    assert c.post(f'/api/agent/flows/skills/{name}/runs',headers=auth,json=request).status_code==409
    run=agent_start(setup,name,'run')
    assert run['actor_kind']=='agent' and run['actor_ref']==worker['id'] and 'actor_token_hash' not in run
    assert c.post(f'/api/agent/flows/skills/{name}/runs',headers=auth,json=request).json()['id']==run['id']
    c.app.state.hive.db.execute('UPDATE sessions SET expires_at=1')
    reconcile(c);updated=c.get('/api/agent/flow-runs/'+run['id'],headers=auth).json()
    assert updated['status']=='running'
    goal=c.app.state.hive.db.one('SELECT * FROM goals WHERE id=?',(goal_for(run,'t0'),))
    assert goal['created_by']=='agent:'+worker['id']
    assert count(c)==1
    # Fresh controller carries migrated actor fields and pinned skill across restart.
    c.app.state.hive.flows=Flows(c.app.state.hive);reconcile(c);assert count(c)==1


@pytest.mark.parametrize('change',['retired','policy','deleted','error','token','moved','adoption'])
def test_agent_run_revocation_cancels_work(setup,change):
    c,owner,_,worker,_,flow,path=setup;name=register(setup);run=agent_start(setup,name);reconcile(c);h=c.app.state.hive
    if change=='retired':
        assert c.post(f'/api/agent/flows/skills/{name}/retire',headers=agent_headers(worker),json={}).status_code==200
    elif change=='policy':h.policy.add_rule('agent:'+worker['id'],'hive-flow-run','deny','test')
    elif change=='adoption':h.db.execute('DELETE FROM flow_adoptions WHERE artifact_id=?',(flow['artifact_id'],))
    else:h.db.update('agents',worker['id'],{'deleted':1} if change=='deleted' else {'status':'error'} if change=='error' else {'token_hash':'rotated'} if change=='token' else {'moved_to':'elsewhere'})
    reconcile(c)
    assert h.db.one('SELECT status FROM flow_runs WHERE id=?',(run['id'],))['status'] in ('blocked','cancelled')
    assert h.db.one('SELECT status FROM goals WHERE id=?',(goal_for(run,'t0'),))['status']=='cancelled'
    assert count(c)==1
    if change in ('retired','adoption'):
        ack=c.post('/api/agent/goals/'+goal_for(run,'t0')+'/cancel-ack',headers=agent_headers(worker),json={})
        assert ack.status_code==200,ack.text


@pytest.mark.parametrize('data',[{'params':{'extra':1},'client_key':'x'},{'params':{},'client_key':'x','execute':True},{'params':[],'client_key':'x'},{'params':{}},{'params':{},'client_key':''}])
def test_agent_invocation_rejects_parameters(setup,data):
    c,_,_,worker,*_=setup;name=register(setup)
    assert c.post(f'/api/agent/flows/skills/{name}/runs',headers=agent_headers(worker),json=data).status_code==400
    assert c.app.state.hive.db.one('SELECT COUNT(*) AS n FROM flow_runs')['n']==0


def test_skill_registry_pins_revision_and_preserves_retirement(setup):
    c,owner,_,worker,f,flow,path=setup;name=register(setup);auth=agent_headers(worker)
    entries=c.get('/api/agent/flows',headers=auth).json();assert entries[0]['digest']=='sha256:'+flow['digest']
    changed=copy.deepcopy(f);changed['elements'][0]['props']['label']='Different'
    newer=c.post('/api/swarms/'+flow['swarm_id']+'/flows',headers=owner,json={'artifact_id':flow['artifact_id'],'parent':1,'body':changed}).json()
    assert newer['revision']==2
    run=agent_start(setup,name);assert run['revision']==1
    assert c.post(f'/api/agent/flows/skills/{name}/retire',headers=auth,json={}).status_code==200
    assert c.get('/api/agent/flows',headers=auth).json()==[]
    assert c.post(f'/api/agent/flows/skills/{name}/runs',headers=auth,json={'params':{},'client_key':'new'}).status_code==404
    assert c.app.state.hive.db.one('SELECT status FROM flow_skills WHERE name=?',(name,))['status']=='retired'


def test_agent_run_full_completion_and_stalled_attention(setup):
    c,_,_,worker,*_=setup;name=register(setup);run=agent_start(setup,name);reconcile(c)
    gid=goal_for(run,'t0');assert finish(c,worker,gid).status_code==200;reconcile(c)
    assert c.app.state.hive.db.one('SELECT status FROM goals WHERE id=?',(goal_for(run,'t1'),))['status']=='open'
    c.app.state.hive.db.update('goals',goal_for(run,'t1'),{'status':'stalled'})
    reconcile(c)
    row=c.app.state.hive.db.one('SELECT * FROM flow_runs WHERE id=?',(run['id'],))
    assert row['status']=='blocked' and row['reason']=='step_stalled'


def test_agent_pipeline_requires_person_review(setup):
    c,owner,_,worker,*_=setup;name=register(setup);run=agent_start(setup,name);reconcile(c)
    assert finish(c,worker,goal_for(run,'t0')).status_code==200;reconcile(c)
    gid=goal_for(run,'t1');assert finish(c,worker,gid).json()['status']=='submitted';reconcile(c)
    assert count(c)==2
    assert c.post('/api/goals/'+gid+'/review',headers=owner,json={'decision':'accept'}).status_code==200
    reconcile(c);assert count(c)==3
    assert finish(c,worker,goal_for(run,'t2')).status_code==200;reconcile(c)
    assert c.get('/api/agent/flow-runs/'+run['id'],headers=agent_headers(worker)).json()['status']=='done'


def test_legacy_person_run_actor_migration(setup):
    c,_,_,_,_,_,_=setup;run=adopt_start(setup);db=c.app.state.hive.db
    for column in ('actor_kind','actor_ref','actor_token_hash','skill_name'):
        db.execute('ALTER TABLE flow_runs DROP COLUMN '+column)
    c.app.state.hive.flows=Flows(c.app.state.hive)
    row=db.one('SELECT * FROM flow_runs WHERE id=?',(run['id'],))
    assert row['actor_kind']=='person' and row['actor_ref']==row['actor']
    reconcile(c);assert count(c)==1


def test_registry_digest_and_foreign_run_refusals(setup):
    c,owner,swarm,worker,_,flow,_=setup;name=register(setup);run=agent_start(setup,name)
    bad={'name':'wrong-digest','purpose':'Synthetic','artifact_id':flow['artifact_id'],'revision':1,'digest':'0'*64}
    assert c.post('/api/agent/flows/skills',headers=agent_headers(worker),json=bad).status_code==409
    stranger=c.post('/api/agents',headers=owner,json={'name':'Other mind','swarm_id':swarm['id']}).json()
    assert c.get('/api/agent/flow-runs/'+run['id'],headers=agent_headers(stranger)).status_code==404
    assert c.post('/api/agent/flow-runs/'+run['id']+'/cancel',headers=agent_headers(stranger),json={}).status_code==404
    assert c.app.state.hive.db.one('SELECT status FROM flow_runs WHERE id=?',(run['id'],))['status']=='running'


def test_validation_labels_representation_only_actions(setup):
    c,owner,_,_,f,*_=setup
    for element in f['elements']:
        if element['kind']=='transition':element['action']={'kind':'message','target':'example','params':{}}
    out=c.post('/api/flows/validate',headers=owner,json={'body':f})
    assert out.status_code==200,out.text
    preflight=out.json()['preflight']
    assert not preflight['structurally_eligible'] and preflight['host_supported_actions']==['goal']
    assert sum(item['code']=='unsupported-host-action' for item in preflight['findings'])==3


def test_native_registry_and_invocation_bridge(setup,monkeypatch):
    from hive.tests.test_hive_module_semicolons import hc
    c,owner,_,worker,_,flow,path=setup;h=c.app.state.hive
    h.policy.add_rule('agent:'+worker['id'],'hive-flow-publish','allow','synthetic')
    def call(method,path,payload=None):
        out=c.request(method,path,headers=agent_headers(worker),json=payload)
        return (out.json(),None) if out.status_code<400 else (None,'HIVE-ERROR '+str(out.status_code))
    monkeypatch.setattr(hc,'_call',call)
    data={'name':'native-skill','purpose':'Literal ; unicode 🌱','artifact_id':flow['artifact_id'],'revision':1,'digest':flow['digest']}
    assert hc.decode(hc.flow_publish(hc.encode(json.dumps(data)))).startswith('HIVE-FLOW-SKILL ')
    assert 'native-skill' in hc.decode(hc.flows())
    assert c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']}).status_code==200
    value=hc.decode(hc.flow_run('native-skill',hc.encode(json.dumps({'params':{},'client_key':'native'}))))
    rid=json.loads(value.split(' ',1)[1])['id'];reconcile(c)
    assert rid in hc.decode(hc.flow_run_get(rid))
    assert hc.decode(hc.flow_cancel(rid)).startswith('HIVE-FLOW-CANCELLED ')
    assert hc.decode(hc.flow_retire('native-skill')).startswith('HIVE-FLOW-RETIRED ')


def test_agent_concurrent_starts_and_controllers_are_idempotent(setup):
    c,owner,_,worker,_,flow,path=setup;name=register(setup);h=c.app.state.hive
    assert c.post(path+'/adopt',headers=owner,json={'digest':flow['digest']}).status_code==200
    agent=h.db.one('SELECT * FROM agents WHERE id=?',(worker['id'],))
    fresh=Hive(h.settings,supervisor=FakeSupervisor())
    try:
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(controller.agent_start,agent,name,{'params':{},'client_key':'race'}) for controller in (h.flows,fresh.flows)]
            runs=[future.result(timeout=10) for future in futures]
        assert runs[0]['id']==runs[1]['id']
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(controller._advance,runs[0]['id']) for controller in (h.flows,fresh.flows)]
            for future in futures:future.result(timeout=10)
        assert count(c)==1 and h.db.one('SELECT COUNT(*) AS n FROM flow_runs')['n']==1
    finally:fresh.db._conn.close()


def test_registry_concurrent_name_collision_preserves_one_binding(setup):
    from hive.core.hive import HiveError
    c,_,_,worker,_,flow,_=setup;h=c.app.state.hive
    h.policy.add_rule('agent:'+worker['id'],'hive-flow-publish','allow','synthetic')
    agent=h.db.one('SELECT * FROM agents WHERE id=?',(worker['id'],))
    data={'name':'race-skill','purpose':'Synthetic','artifact_id':flow['artifact_id'],'revision':1,'digest':flow['digest']}
    fresh=Hive(h.settings,supervisor=FakeSupervisor())
    def publish(controller):
        try:return controller.register_skill(agent,data)['name']
        except HiveError as exc:return exc.code
    try:
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(publish,(h.flows,fresh.flows)))
        assert sorted(results)==['race-skill','skill_name_exists']
        assert h.db.one('SELECT COUNT(*) AS n FROM flow_skills')['n']==1
    finally:fresh.db._conn.close()


def test_newer_adoption_does_not_authorize_older_skill(setup):
    c,owner,swarm,worker,f,flow,_=setup;name=register(setup)
    changed=copy.deepcopy(f);changed['elements'][0]['props']['label']='New revision'
    newer=c.post('/api/swarms/'+swarm['id']+'/flows',headers=owner,json={'artifact_id':flow['artifact_id'],'parent':1,'body':changed}).json()
    path='/api/flows/'+flow['artifact_id']+'/revisions/2'
    assert c.post(path+'/adopt',headers=owner,json={'digest':newer['digest']}).status_code==200
    out=c.post('/api/agent/flows/skills/'+name+'/runs',headers=agent_headers(worker),json={'params':{},'client_key':'stale'})
    assert out.status_code==409 and out.json()['error']['code']=='not_adopted'
    assert count(c)==0


def test_dynamic_inventory_binds_catalogue_without_callable_claim(setup):
    c,_,_,worker,*_=setup;h=c.app.state.hive
    agent=h.db.one('SELECT * FROM agents WHERE id=?',(worker['id'],))
    assert h.flows.agent_dynamic_inventory(agent)==[]
    register(setup,'first')
    initial=h.flows.agent_dynamic_inventory(agent)
    assert initial==h.flows.agent_dynamic_inventory(agent)
    assert set(initial[0])=={'kind','id','registry_revision'}
    assert initial[0]['kind']=='flow-skill' and initial[0]['id']=='first'
    assert initial[0]['registry_revision'].startswith('sha256:')
    register(setup,'second')
    expanded=h.flows.agent_dynamic_inventory(agent)
    assert [r['id'] for r in expanded]==['first','second']
    assert expanded[0]['registry_revision']!=initial[0]['registry_revision']
    assert expanded[0]['registry_revision']==expanded[1]['registry_revision']
    assert c.post('/api/agent/flows/skills/second/retire',headers=agent_headers(worker),json={}).status_code==200
    assert h.flows.agent_dynamic_inventory(agent)==initial
    # A catalogue hash describes content, not a monotonic event counter.
    h.policy.add_rule('agent:'+worker['id'],'hive-flows','deny','synthetic')
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as denied:h.flows.agent_dynamic_inventory(agent)
    assert denied.value.code=='flow_policy_denied'


def test_dynamic_inventory_never_crosses_swarm(setup):
    c,owner,_,worker,*_=setup;register(setup);h=c.app.state.hive
    other=c.post('/api/swarms',headers=owner,json={'name':'Other synthetic scope'}).json()
    mind=c.post('/api/agents',headers=owner,json={'name':'Other worker','swarm_id':other['id']}).json()
    agent=h.db.one('SELECT * FROM agents WHERE id=?',(mind['id'],))
    assert h.flows.agent_dynamic_inventory(agent)==[]
