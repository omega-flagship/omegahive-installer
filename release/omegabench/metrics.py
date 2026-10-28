"""Semantic measures from supplied evidence; never authenticity or adoption proof."""
import statistics
from .protocol import digest, number, pin
from .tasks import brier


def calibration(probabilities, outcomes, bins=10):
    score=brier(probabilities,outcomes)
    if type(bins)!=int or not 1<=bins<=100: raise ValueError('1 to 100 bins required')
    groups=[[] for _ in range(bins)]
    for p,o in zip(probabilities,outcomes): groups[min(int(p*bins),bins-1)].append((p,o))
    points=[]; ece=0
    for values in groups:
        if values:
            predicted=statistics.fmean(p for p,_ in values)
            observed=statistics.fmean(o for _,o in values)
            ece+=len(values)/len(probabilities)*abs(predicted-observed)
            points.append({'predicted':predicted,'observed':observed,'count':len(values)})
    return {'brier':score,'weighted_ece':ece,'forecasts':len(probabilities),'bins':points}


def horizon_scores(rows):
    """No pooling away a bad long horizon. Identical horizons across comparators."""
    if not isinstance(rows,list) or not rows: raise ValueError('prediction records required')
    groups={}; seen=set()
    for row in rows:
        if not isinstance(row,dict): raise ValueError('invalid prediction record')
        key=(row.get('episode'),row.get('step'),row.get('horizon'))
        if not isinstance(key[0],str) or not key[0] or type(key[1])!=int or key[1]<0 or type(key[2])!=int or key[2]<1 or key in seen:
            raise ValueError('unique episode/step/positive horizon required')
        seen.add(key)
        brier([row.get('probability')],[row.get('outcome')])
        groups.setdefault(key[2],[]).append(row)
    return {str(h):calibration([r['probability'] for r in rs],[r['outcome'] for r in rs]) for h,rs in sorted(groups.items())}


def causal_triplet(full, sham, severed):
    """FULL/SHAM/SEVERED at an exact consumer seam, from supplied receipts.

    Admitted/action outcome digests count; log differences do not. Raw evidence
    remains externally held. A valid triplet is not a statistical causal claim.
    """
    records={'full':full,'sham':sham,'severed':severed}
    conditions=('artifact_pin','input_pin','environment_pin','route_pin','task_id','seed','boundary')
    for arm,row in records.items():
        if not isinstance(row,dict) or row.get('arm')!=arm or row.get('status')!='ok': raise ValueError('three successful declared arms required')
        for k in ('artifact_pin','input_pin','environment_pin','route_pin','outcome_digest','receipt_digest'):
            if not pin(row.get(k)): raise ValueError(f'missing causal {k}')
        for k in ('task_id','boundary'):
            if not isinstance(row.get(k),str) or not row[k]: raise ValueError(f'missing {k}')
        if type(row.get('seed'))!=int: raise ValueError('integer causal seed required')
        if any(row.get(k)!=full.get(k) for k in conditions): raise ValueError('causal single-variable contract violated')
        if row.get('outcome_kind') not in ('admitted-belief','admitted-action'): raise ValueError('downstream semantic outcome required')
        if row['outcome_kind']!=full['outcome_kind']: raise ValueError('outcome seam mismatch')
    if full.get('executed') is not True or full.get('exposed') is not True or sham.get('executed') is not True or sham.get('exposed') is not False or severed.get('executed') is not False or severed.get('exposed') is not False:
        raise ValueError('incorrect full/sham/severed execution or exposure')
    if not pin(full.get('computed_digest')) or full['computed_digest']!=sham.get('computed_digest') or severed.get('computed_digest') is not None:
        raise ValueError('sham must compute the same result; severed computes none')
    return {'exposure_changed_outcome':full['outcome_digest']!=sham['outcome_digest'],
            'execution_side_effect':sham['outcome_digest']!=severed['outcome_digest'],
            'triplet_digest':digest(records),'evidence_tier':'unverified-receipts',
            'general_usefulness':'unproven','statistical_causality':'unproven','adoption_authorized':False}


def reliability(successes, k):
    """Empirical all-k reliability across complete repeated trials per task."""
    if type(k)!=int or k<1 or not isinstance(successes,dict) or not successes: raise ValueError('tasks and positive k required')
    scores=[]
    for task,values in successes.items():
        if not isinstance(task,str) or not task or not isinstance(values,list) or len(values)!=k or any(type(v)!=bool for v in values):
            raise ValueError('exact k boolean outcomes required per task, including errors as false')
        scores.append(float(all(values)))
    return {'all_k_reliability':statistics.fmean(scores),'tasks':len(scores),'trials':k*len(scores),'k':k}
