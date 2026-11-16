from copy import deepcopy
import pytest
from omegabench.metrics import calibration,horizon_scores,causal_triplet,reliability
from omegabench.protocol import digest


def test_calibration_is_frequency_weighted():
    a=calibration([.1]*9+[.9],[0]*9+[0],bins=2)
    assert a['weighted_ece']==pytest.approx(.18)
    assert a['brier']==pytest.approx(.09)
    assert a['forecasts']==10


def test_horizon_error_is_not_pooled_away():
    rows=[dict(episode='e',step=0,horizon=1,probability=0.,outcome=0),
          dict(episode='e',step=0,horizon=10,probability=1.,outcome=0)]
    scores=horizon_scores(rows)
    assert scores['1']['brier']==0 and scores['10']['brier']==1
    with pytest.raises(ValueError):horizon_scores(rows+[rows[0]])


def triplet():
    base={k:digest(k) for k in ('artifact_pin','input_pin','environment_pin','route_pin','outcome_digest','receipt_digest')}
    base.update(status='ok',task_id='task',seed=0,boundary='admission',outcome_kind='admitted-belief')
    full=dict(base,arm='full',executed=True,exposed=True,computed_digest=digest('computed'))
    sham=dict(base,arm='sham',executed=True,exposed=False,computed_digest=digest('computed'))
    severed=dict(base,arm='severed',executed=False,exposed=False,computed_digest=None)
    return full,sham,severed


def test_log_difference_is_not_causal_bite():
    f,h,s=triplet();f['log_digest']=digest('full-log');h['log_digest']=digest('sham-log')
    a=causal_triplet(f,h,s)
    assert not a['exposure_changed_outcome'] and not a['execution_side_effect']


def test_consumer_effect_and_execution_side_effect_are_separate():
    f,h,s=triplet();f['outcome_digest']=digest('new admission')
    a=causal_triplet(f,h,s)
    assert a['exposure_changed_outcome'] and not a['execution_side_effect']
    assert a['statistical_causality']=='unproven' and not a['adoption_authorized']
    s['outcome_digest']=digest('side effect');assert causal_triplet(f,h,s)['execution_side_effect']

@pytest.mark.parametrize('field,value',[('input_pin',digest('other')),('seed',1),('boundary','other'),
    ('outcome_kind','log'),('computed_digest',digest('other')),('exposed',True),('status','error')])
def test_causal_triplet_refuses_extra_changes(field,value):
    f,h,s=triplet();h[field]=value
    with pytest.raises(ValueError):causal_triplet(f,h,s)


def test_all_k_reliability_is_not_pass_at_k_selection():
    a=reliability({'a':[True,True],'b':[True,False]},2)
    assert a['all_k_reliability']==.5 and a['trials']==4
    with pytest.raises(ValueError):reliability({'a':[True]},2)
