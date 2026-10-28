from copy import deepcopy
import pytest
from omegabench.demo import example
from omegabench.protocol import digest,seal
from omegabench.adapters import swe_summary_arm,arc_grid_arm


def swe_packet():
    r,_,_=example(); r['benchmark']='swe-bench-verified'; ids=r['task_ids']
    report=dict(schema_version=2,total_instances=len(ids),resolved_ids=ids[:3],unresolved_ids=ids[3:6],
                error_ids=ids[6:8],incomplete_ids=ids[8:10],empty_patch_ids=ids[10:],infra_failure_ids=[ids[6]])
    ledger={t:dict(cost=.01,tokens=10,seconds=1,attempts=1,floors={'authority':1},receipt_digest=digest(t)) for t in ids}
    return r,report,ledger


def test_swe_report_retains_every_failure_category():
    r,report,ledger=swe_packet()
    rows=swe_summary_arm(r,'candidate',report,ledger,0)
    assert len(rows)==12 and sum(x['score'] for x in rows)==3
    assert sum(x['status']=='error' for x in rows)==2
    assert rows[6]['score']==0 and all(x['cost']==.01 for x in rows)

@pytest.mark.parametrize('bad',['duplicate','overlap','omit','extra','schema','denominator','infra','unknown-cost','missing-resource'])
def test_swe_report_refuses_ambiguous_or_unmeasured_results(bad):
    r,report,ledger=swe_packet(); task=r['task_ids'][0]
    if bad=='duplicate': report['resolved_ids'].append(task)
    elif bad=='overlap': report['unresolved_ids'].append(task)
    elif bad=='omit': report['resolved_ids'].pop()
    elif bad=='extra': report['error_ids'].append('not-planned')
    elif bad=='schema': report['schema_version']=1
    elif bad=='denominator': report['total_instances']=11
    elif bad=='infra': report['infra_failure_ids']=[task]
    elif bad=='unknown-cost': ledger[task]['cost']=None
    else: ledger.pop(task)
    with pytest.raises(ValueError): swe_summary_arm(r,'baseline',report,ledger,0)


def arc_packet():
    r,_,_=example();r.update(benchmark='arc-agi-2',rubric='arc-grid-exact-pass@2')
    solutions={t:[[[1,2]],[[3,4]]] for t in r['task_ids']}
    predictions={t:[{'attempt_1':[[0]],'attempt_2':[[1,2]]},{'attempt_1':[[3,4]]}] for t in r['task_ids']}
    ledger={t:dict(cost=0,tokens=0,seconds=1,attempts=2,floors={'authority':1},receipt_digest=digest(t)) for t in r['task_ids']}
    return r,solutions,predictions,ledger


def test_arc_requires_every_grid_and_holds_missing_predictions_in_denominator():
    r,s,p,l=arc_packet();p.pop(r['task_ids'][0]);p[r['task_ids'][1]][1]={'attempt_1':[[0]]}
    rows=arc_grid_arm(r,'candidate',s,p,l,0)
    assert len(rows)==12 and rows[0]['status']=='error' and rows[1]['score']==0
    assert sum(x['score'] for x in rows)==10

@pytest.mark.parametrize('bad',['extra-attempt','missing-test','invalid-target','wrong-rubric','missing-ledger'])
def test_arc_refuses_changed_rubric_or_denominator(bad):
    r,s,p,l=arc_packet();t=r['task_ids'][0]
    if bad=='extra-attempt':p[t][0]['attempt_3']=[[1,2]]
    elif bad=='missing-test':p[t].pop()
    elif bad=='invalid-target':s[t]=[[]]
    elif bad=='wrong-rubric':r['rubric']='arc-grid-exact-pass@1'
    else:l.pop(t)
    with pytest.raises(ValueError):arc_grid_arm(r,'candidate',s,p,l,0)
