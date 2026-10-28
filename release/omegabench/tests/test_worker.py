import copy
from types import SimpleNamespace
import pytest
from omegabench.demo import example
from omegabench.protocol import digest, seal, compare
from omegabench.tasks import tasks
from omegabench.worker import evaluator_pin, run, IncompleteExecution


def setup():
    r,_,_=example()
    pack=[dict(id=t['id'], family=t['id'].rsplit('-',1)[0], input=t['input'],expected=t['expected']) for t in tasks()]
    r.update(evaluator_pin=evaluator_pin(), dataset_pin=digest(pack),
             limits={'cost':1,'tokens':10000,'seconds':60,'attempts':12})
    requests=[]
    def execute(request):
        requests.append(copy.deepcopy(request))
        inp=request['input']
        if 'events' in inp:answer='unknown'
        elif 'reports' in inp:answer=len({row['origin'] for row in inp['reports']})
        else:answer=[inp['start'],inp['rules'][0][1],inp['target']]
        return {'status':'ok','response':answer,'usage':{'cost':0,'tokens':5,'seconds':0,'attempts':1},'floors':{'authority':1}}
    executors={arm:SimpleNamespace(subject_pin=r[arm+'_pin'],environment_pin=r['environment_pin'],execute=execute) for arm in ('baseline','candidate')}
    return r,pack,executors,requests


def test_prompt_only_paired_grading_and_resource_accounting():
    r,pack,executors,requests=setup();export,audit=run(r,pack,executors)
    assert len(requests)==24
    assert all(set(q)=={'task_id','seed','input','subject_pin','environment_pin','remaining_budget','deadline_monotonic'} for q in requests)
    assert all('expected' not in q for q in requests)
    assert all(x['score']==1 for arm in executors for x in export[arm])
    result=compare(r,seal(r),export)
    assert result['arms']['candidate']['tokens']==60
    assert result['arms']['candidate']['seconds']>0
    assert audit['oracle_custody']=='unverified' and not audit['adoption_authorized']
    assert 'response' not in audit['events'][0] and 'expected' not in str(audit)


@pytest.mark.parametrize('status',['failed','error','timeout','cancelled'])
def test_accounted_failure_stays_in_denominator(status):
    r,p,e,q=setup()
    e['baseline'].execute=lambda request:dict(status=status,response=None,usage={'cost':0.01,'tokens':2,'seconds':0,'attempts':1},floors={'authority':1})
    export,_=run(r,p,e)
    assert len(export['baseline'])==12
    assert all(row['status']==status and row['score']==0 for row in export['baseline'])


def test_unknown_failure_usage_refuses_export():
    r,p,e,q=setup()
    def crash(request):raise RuntimeError('synthetic failure')
    e['baseline'].execute=crash
    with pytest.raises(IncompleteExecution) as caught:run(r,p,e)
    assert caught.value.audit[-1]['usage']=='unknown'
    assert 'response' not in caught.value.audit[-1]


def test_measured_overrun_stops_arm_and_preserves_denominator():
    r,p,e,q=setup()
    e['baseline'].execute=lambda request:dict(status='error',response=None,usage={'cost':2,'tokens':2,'seconds':0,'attempts':1},floors={'authority':1})
    export,_=run(r,p,e)
    assert export['baseline'][0]['cost']==2
    assert all(row['status']=='cancelled' and row['attempts']==0 for row in export['baseline'][1:])
    assert 'baseline exceeds cost cap' in compare(r,seal(r),export)['reasons']
    assert len(export['candidate'])==12


def test_cancelled_pack_never_dispatches_and_does_not_claim_floors():
    r,p,e,q=setup();export,_=run(r,p,e,cancelled=lambda:True)
    assert not q
    assert all(row['status']=='cancelled' and row['floors']['authority']==0 for arm in e for row in export[arm])


@pytest.mark.parametrize('change',['oracle','family','subject','evaluator'])
def test_pins_and_cohort_must_match(change):
    r,p,e,q=setup()
    if change=='oracle':p[0]['expected']='wrong'
    if change=='family':r['task_families'][p[0]['id']]='wrong'
    if change=='subject':e['candidate'].subject_pin='a'*64
    if change=='evaluator':r['evaluator_pin']='a'*64
    with pytest.raises(ValueError):run(r,p,e)
    assert not q


def test_host_receives_independent_input_copy():
    r,p,e,q=setup()
    original=e['baseline'].execute
    def mutate(request):
        result=original(request);request['input'].clear();request['remaining_budget']['cost']=1000
        return result
    e['baseline'].execute=mutate
    export,_=run(r,p,e)
    assert all(row['score']==1 for arm in e for row in export[arm])


def test_late_success_is_timeout_not_a_pass():
    import time
    r,p,e,q=setup();r['limits']['seconds']=0.001
    original=e['baseline'].execute
    def late(request):
        result=original(request);time.sleep(0.01);return result
    e['baseline'].execute=late
    export,_=run(r,p,e)
    assert export['baseline'][0]['status']=='timeout' and export['baseline'][0]['score']==0
    assert all(row['status']=='cancelled' for row in export['baseline'][1:])


def test_cancellation_is_latched():
    r,p,e,q=setup();calls=iter([True]+[False]*100)
    export,_=run(r,p,e,cancelled=lambda:next(calls))
    assert not q
    assert all(row['status']=='cancelled' for arm in e for row in export[arm])


def test_retry_usage_violates_sealed_stop_rule():
    r,p,e,q=setup()
    e['baseline'].execute=lambda request:dict(status='ok',response=None,usage={'cost':0,'tokens':2,'seconds':0,'attempts':2},floors={'authority':1})
    with pytest.raises(IncompleteExecution):run(r,p,e)


def test_private_nonce_never_enters_export():
    r,p,e,q=setup();export,audit=run(r,p,e)
    assert audit['commitment_nonce'] not in str(export)
    first=export['candidate'][0]
    event=next(event for event in audit['events'] if event['pin']==r['candidate_pin'])
    assert first['receipt_digest']==digest({'event':event,'nonce':audit['commitment_nonce']})
    assert first['receipt_digest']!=digest(event)
