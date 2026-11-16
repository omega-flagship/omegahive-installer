from copy import deepcopy
import pytest
from omegabench.demo import example
from omegabench.protocol import seal, compare, digest
from omegabench.tasks import brier, evaluate_responses


def test_demo_cannot_claim_improvement_or_adoption():
    r,e,a=example()
    assert a["gain"]==1 and a["state"]=="held"
    assert a["agi"]==a["live_improvement"]==a["recursive_improvement"]=="unproven"
    assert not a["adoption_authorized"] and a["evidence_tier"]=="unverified-import"

@pytest.mark.parametrize("change",["drop", "duplicate", "score-error", "wrong-arm", "wrong-seed", "missing-floor", "nan"])
def test_reject_corrupted_export(change):
    r,e,_=example(); p=seal(r); row=e["candidate"][0]
    if change=="drop": e["candidate"].pop()
    elif change=="duplicate": e["candidate"][1]=deepcopy(row)
    elif change=="score-error": row.update(status="error",score=1)
    elif change=="wrong-arm": row["pin"]=r["baseline_pin"]
    elif change=="wrong-seed": row["seed"]=False
    elif change=="missing-floor": row["floors"]={}
    else: row["cost"]=float("nan")
    with pytest.raises(ValueError): compare(r,p,e)

@pytest.mark.parametrize("key",["release","split","evaluator_pin","dataset_pin","environment_pin","registration_pin"])
def test_refuse_unmatched_harness_or_dataset(key):
    r,e,_=example(); p=seal(r); e[key]="wrong"
    with pytest.raises(ValueError): compare(r,p,e)

@pytest.mark.parametrize("key",["task_ids","baseline_pin","custody","floors","limits"])
def test_registration_is_sealed(key):
    r,e,_=example(); p=seal(r)
    if key=="task_ids": r[key]=[]
    elif key=="baseline_pin": r[key]=r["candidate_pin"]
    elif key=="custody": r[key]="claimed-secret"
    elif key=="floors": r[key]={}
    else: r[key]={"cost":0}
    with pytest.raises(ValueError): compare(r,p,e)


def test_gain_cannot_buy_floor_or_budget_violation():
    r,e,_=example(); e["candidate"][0]["floors"]["authority"]=0
    e["candidate"][0]["cost"]=1
    a=compare(r,seal(r),e)
    assert "candidate violates authority floor" in a["reasons"]
    assert "candidate exceeds cost cap" in a["reasons"]


def test_seed_replication_is_not_independence():
    r,e,_=example(); r["seeds"]=[0,1]
    for arm in ("baseline","candidate"):
        e[arm] += [dict(x,seed=1) for x in deepcopy(e[arm])]
    r["limits"]["attempts"]*=2; e["registration_pin"]=seal(r)
    a=compare(r,seal(r),e)
    assert a["independent_tasks"]==12 and a["arms"]["candidate"]["trials"]==24


def test_even_heldout_import_is_unverified_and_requires_review():
    r,e,_=example(); r["custody"]="heldout-independent"
    r["task_families"]={t:t for t in r["task_ids"]}
    e["registration_pin"]=seal(r)
    a=compare(r,seal(r),e)
    assert a["state"]=="ready-for-independent-review"
    assert a["receipt_custody"]=="unresolved" and not a["adoption_authorized"]


def test_missing_responses_stay_in_denominator():
    rows=evaluate_responses({},digest("subject"))
    assert len(rows)==12 and all(x["status"]=="error" and x["score"]==0 for x in rows)


def test_calibration_scores():
    assert brier([0,1],[0,1])==0
    assert brier([.5,.5],[0,1])==.25
    with pytest.raises(ValueError): brier([float("nan")],[0])


def test_generated_siblings_do_not_inflate_uncertainty():
    r,e,_=example()
    a=compare(r,seal(r),e)
    assert a['independent_tasks']==12 and a['independent_units']==3
    assert any('independent task families' in x for x in a['reasons'])


def test_generation_families_are_sealed_and_complete():
    r,e,_=example(); p=seal(r)
    r['task_families'].pop(r['task_ids'][0])
    with pytest.raises(ValueError): compare(r,p,e)


@pytest.mark.parametrize('value',[None,[],"not-an-object",True])
def test_malformed_registration_refused(value):
    with pytest.raises(ValueError): seal(value)


def test_authority_fields_not_allowed_in_registration():
    r,e,_=example();r['adopter']='self'
    with pytest.raises(ValueError):seal(r)
    r.pop('adopter')
    with pytest.raises(ValueError):compare(r,seal(r),[])
