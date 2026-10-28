"""Explicit offline adapters for official report shapes; no harness execution."""
from .protocol import digest, number, pin, seal
from .imports import grid_exact


def _row(registration, arm, task, seed, status, score, resource, receipt):
    if arm not in ('baseline', 'candidate'):
        raise ValueError('baseline or candidate arm required')
    if not isinstance(resource, dict):
        raise ValueError('measured resource ledger required for every planned task')
    for key in ('cost', 'tokens', 'seconds', 'attempts'):
        number(resource.get(key), 0)
    if type(resource['tokens']) != int or type(resource['attempts']) != int:
        raise ValueError('integer tokens and attempts required')
    floors = resource.get('floors')
    if not isinstance(floors, dict) or set(floors) != set(registration['floors']):
        raise ValueError('separate protected-floor assessment required')
    for value in floors.values():
        number(value, 0, 1)
    if not pin(resource.get('receipt_digest')):
        raise ValueError('resource/floor ledger receipt digest required')
    return dict(task_id=task, seed=seed, pin=registration[arm + '_pin'], status=status,
                score=score, **{k:resource[k] for k in ('cost','tokens','seconds','attempts')},
                floors=dict(floors), receipt_digest=digest({'grading':receipt, 'resources':resource}))


def swe_summary_arm(registration, arm, report, resources, seed):
    """SWE-bench summary schema 2 -> complete normalized arm. Not a rescorer.

    Infrastructure faults remain zero-scored. The official report provides no
    spend or protected-floor assessment, so those must come from a separate ledger.
    """
    seal(registration)
    if registration['benchmark'] != 'swe-bench-verified' or seed not in registration['seeds'] or type(seed)!=int:
        raise ValueError('registered SWE-bench arm and seed required')
    if report.get('schema_version') != 2:
        raise ValueError('supported SWE-bench summary schema_version is 2')
    categories = ('resolved', 'unresolved', 'error', 'incomplete', 'empty_patch')
    groups = {}
    for name in categories:
        ids = report.get(name + '_ids')
        if not isinstance(ids, list) or any(not isinstance(x,str) or not x for x in ids) or len(set(ids)) != len(ids):
            raise ValueError(f'invalid {name} ids')
        groups[name] = set(ids)
    planned = set(registration['task_ids'])
    union=set().union(*groups.values())
    if union != planned or sum(len(g) for g in groups.values()) != len(planned):
        raise ValueError('official categories must partition the preregistered tasks')
    if type(report.get('total_instances'))!=int or report['total_instances'] != len(planned):
        raise ValueError('official total disagrees with planned denominator')
    infra = report.get('infra_failure_ids', [])
    if not isinstance(infra,list) or any(not isinstance(x,str) for x in infra) or len(set(infra))!=len(infra) or not set(infra) <= groups['unresolved'] | groups['error']:
        raise ValueError('infrastructure classification cannot remove or resolve tasks')
    if not isinstance(resources,dict) or set(resources) != planned:
        raise ValueError('complete measured resource ledger required')
    rows=[]
    for task in registration['task_ids']:
        category=next(k for k,v in groups.items() if task in v)
        state='ok' if category=='resolved' else 'error' if category=='error' else 'failed'
        rows.append(_row(registration,arm,task,seed,state,float(category=='resolved'),resources[task],
                         {'report_digest':digest(report),'task':task,'category':category,'infra':task in infra}))
    return rows


def arc_grid_arm(registration, arm, solutions, predictions, resources, seed, max_attempts=2):
    """Local ARC grid-match diagnostic from supplied solutions/predictions.

    A task passes only if every test grid has a correct prediction within the
    declared attempt cap. No public/semi-private/official status is inferred.
    Predictions use task -> [{attempt_1: grid, attempt_2: grid}, ...].
    """
    seal(registration)
    if registration['benchmark'] != 'arc-agi-2' or type(seed)!=int or seed not in registration['seeds']:
        raise ValueError('registered ARC-AGI-2 seed required')
    if type(max_attempts)!=int or max_attempts not in (1,2):
        raise ValueError('one or two preregistered attempts required')
    if registration['rubric'] != f'arc-grid-exact-pass@{max_attempts}':
        raise ValueError('attempt selection must be fixed in the sealed rubric')
    planned=set(registration['task_ids'])
    if not isinstance(solutions,dict) or set(solutions)!=planned or not isinstance(resources,dict) or set(resources)!=planned:
        raise ValueError('complete solution and resource denominators required')
    if not isinstance(predictions,dict) or set(predictions)-planned:
        raise ValueError('unexpected prediction tasks')
    rows=[]
    for task in registration['task_ids']:
        targets=solutions[task]
        if not isinstance(targets,list) or not targets: raise ValueError('nonempty test grids required')
        for grid in targets: grid_exact(grid,grid)
        attempts=predictions.get(task)
        if attempts is None:
            score=0.; state='error'
        else:
            if not isinstance(attempts,list) or len(attempts)!=len(targets): raise ValueError('test-grid denominator mismatch')
            checks=[]
            for actual,expected in zip(attempts,targets):
                allowed={f'attempt_{i+1}' for i in range(max_attempts)}
                if not isinstance(actual,dict) or set(actual)-allowed: raise ValueError('prediction exceeds attempt cap')
                checks.append(any(grid_exact(g,expected)==1 for g in actual.values()))
            score=float(all(checks)); state='ok' if score else 'failed'
        rows.append(_row(registration,arm,task,seed,state,score,resources[task],
                         {'solutions':digest(targets),'predictions':digest(attempts),'rubric':registration['rubric']}))
    return rows
