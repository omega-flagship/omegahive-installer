from types import SimpleNamespace
import pytest
from hive.core.evolve import EvolveRegistry
from hive.core.db import Database
from hive.core.programs import ProgramContext,validate_graph
from hive.plugins.omegaevolve import program
from hive.tests.test_evolve import actor
from omegabench.demo import example
from omegabench.evolve_bridge import register,assess


@pytest.fixture
def registry(tmp_path):
    return EvolveRegistry(SimpleNamespace(db=Database(tmp_path/'benchmark.sqlite')))


def test_evolve_retains_immutable_assessment_and_no_adoption(registry):
    r,e,_=example();a=actor(owner=True)
    record=register(registry,'s1',a,r)
    receipt=assess(registry,'s1',a,record['id'],e)
    assert receipt['body']['assessment']['independent_units']==3
    assert receipt['body']['assessment']['evidence_tier']=='unverified-import'
    assert not receipt['body']['candidate_evaluated'] and not receipt['body']['adoption_authorized']
    assert registry.records('s1',record['id'])[0]==record
    assert assess(registry,'s1',a,record['id'],e)['id']==receipt['id']
    registry.hive.db._conn.close()

@pytest.mark.parametrize('identity',[actor(),actor('other',owner=True),dict(actor(owner=True),local_operator=True),None])
def test_mind_or_wrong_owner_cannot_register_or_score(registry,identity):
    r,e,_=example()
    with pytest.raises(PermissionError):register(registry,'s1',identity,r)
    record=register(registry,'s1',actor(owner=True),r)
    with pytest.raises(PermissionError):assess(registry,'s1',identity,record['id'],e)


def test_other_swarm_and_changed_export_refused(registry):
    r,e,_=example();a=actor(owner=True);record=register(registry,'s1',a,r)
    with pytest.raises(ValueError):assess(registry,'s2',actor('s2',owner=True),record['id'],e)
    e['candidate'].pop()
    with pytest.raises(ValueError):assess(registry,'s1',a,record['id'],e)
    assert len(registry.records('s1'))==1


def test_program_graph_contains_separate_benchmark_and_assessment(registry):
    r,e,_=example();a=actor(owner=True);record=register(registry,'s1',a,r)
    assess(registry,'s1',a,record['id'],e)
    ctx=SimpleNamespace(evolve_snapshot=lambda focus:registry.snapshot('s1',focus))
    graph=program.view(ctx,None,'unfold')
    def fail(msg):raise AssertionError(msg)
    validate_graph('omegaevolve',program.describe(),graph,'unfold',fail)
    assert {'benchmark','benchmark-assessment'}<={i['kind'] for i in graph['items']}
    assert program.validate_result(None,{},{}).get('errors')


def test_wrong_program_cannot_use_benchmark_bridge(registry):
    registry.hive.swarm=lambda sid:{'id':sid}
    ctx=ProgramContext(registry.hive,'s1',{'id':'other','capabilities':['evolve:write']})
    ctx.actor=actor(owner=True)
    r,e,_=example()
    with pytest.raises(PermissionError):ctx.evolve_benchmark_register(r)


def test_program_actions_follow_revision_binding(registry):
    r,e,_=example();a=actor(owner=True)
    ctx=SimpleNamespace(evolve_snapshot=lambda focus:registry.snapshot('s1',focus),
                        evolve_benchmark_register=lambda r:register(registry,'s1',a,r),
                        evolve_benchmark_assess=lambda i,e:assess(registry,'s1',a,i,e))
    graph=program.view(ctx,None,'unfold')
    first=program.act(ctx,'register-benchmark',['objective'],{'registration':r,'base_revision':graph['revision']})
    assert first['status']=='done'
    identifier=first['detail']['record_id']
    stale=program.act(ctx,'assess-benchmark',[identifier],{'export':e,'base_revision':graph['revision']})
    assert stale['status']=='stale'
    current=program.view(ctx,None,'unfold')
    done=program.act(ctx,'assess-benchmark',[identifier],{'export':e,'base_revision':current['revision']})
    assert done['status']=='done'

from hive.tests.omegabench_fixtures import client


def test_real_api_registers_and_retains_named_owner_assessment(client):
    from hive.tests.test_visibility import person
    headers=person(client,'u_bench_owner',role='owner')
    swarm=client.post('/api/swarms',headers=headers,json={'name':'Disposable benchmark research'}).json()
    r,e,_=example()
    def view():
        result=client.post('/api/programs/omegaevolve/view',headers=headers,json={'swarm_id':swarm['id']})
        assert result.status_code==200,result.text
        return result.json()
    graph=view()
    response=client.post('/api/programs/omegaevolve/act',headers=headers,json={'swarm_id':swarm['id'],
        'action':'register-benchmark','items':['objective'],'base_revision':graph['revision'],'params':{'registration':r}})
    assert response.status_code==200,response.text
    first=response.json();assert first['status']=='done',first
    identifier=first['detail']['record_id']
    graph=view()
    response=client.post('/api/programs/omegaevolve/act',headers=headers,json={'swarm_id':swarm['id'],
        'action':'assess-benchmark','items':[identifier],'base_revision':graph['revision'],'params':{'export':e}})
    assert response.status_code==200,response.text
    done=response.json();assert done['status']=='done',done
    item=next(i for i in done['graph']['items'] if i['kind']=='benchmark-assessment')
    assert item['meta']['assessment']['independent_units']==3
    assert item['meta']['lineage_assessment'].get('status', 'current')=='current'
    assert 'independent_units' not in item['meta']['lineage_assessment']
    assert item['meta']['assessment']['evidence_tier']=='unverified-import'
    assert not item['meta']['adoption_authorized']


def test_local_operator_cannot_seal_benchmark_and_malformed_input_refused(client):
    swarm=client.post('/api/swarms',json={'name':'Disposable unowned trial'}).json()
    graph=client.post('/api/programs/omegaevolve/view',json={'swarm_id':swarm['id']}).json()
    r,e,_=example()
    response=client.post('/api/programs/omegaevolve/act',json={'swarm_id':swarm['id'],'action':'register-benchmark',
        'items':['objective'],'base_revision':graph['revision'],'params':{'registration':r}})
    assert response.status_code==200 and response.json()['status']=='refused',response.text
    from hive.tests.test_visibility import person
    headers=person(client,'u_bench_owner',role='owner')
    own=client.post('/api/swarms',headers=headers,json={'name':'Malformed comparison'}).json()
    g=client.post('/api/programs/omegaevolve/view',headers=headers,json={'swarm_id':own['id']}).json()
    response=client.post('/api/programs/omegaevolve/act',headers=headers,json={'swarm_id':own['id'],'action':'register-benchmark',
        'items':['objective'],'base_revision':g['revision'],'params':{'registration':['wrong-shape']}})
    assert response.status_code==200 and response.json()['status']=='refused',response.text


@pytest.mark.parametrize('role,ok',[('owner',True),('admin',True),('member',False)])
def test_bridge_owner_matches_evolve_named_owner(registry,role,ok):
    # The bridge and the Evolve registry share one owner rule: a named admin stands for the hive owner (2026-10-04).
    r,e,_=example();a=dict(actor(owner=True),role=role)
    if ok:
        record=register(registry,'s1',a,r);assess(registry,'s1',a,record['id'],e)
    else:
        with pytest.raises(PermissionError):register(registry,'s1',a,r)


def test_bridge_refuses_unnamed_principal(registry):
    r,_,_=example()
    for principal in ('user:operator','agent:a_x',''):
        with pytest.raises(PermissionError):register(registry,'s1',dict(actor(owner=True),principal=principal),r)
