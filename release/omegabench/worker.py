"""Prompt-only paired grading engine. The host owns execution and hard limits.

No provider, command runner, scheduler or isolation claim is implemented here.
An executor is a trusted host object, not a person-supplied program parameter.
"""
import copy
import secrets
import time
from pathlib import Path
from .protocol import digest, seal, validate_export, number


def evaluator_pin():
    return digest({'worker_source_sha256': __import__('hashlib').sha256(Path(__file__).read_bytes()).hexdigest(),
                   'rubric': 'exact type and value'})


class IncompleteExecution(ValueError):
    """No comparison may be issued when actual resource accounting is unknown."""
    def __init__(self, message, audit):
        super().__init__(message)
        self.audit = audit


def run(registration, pack, executors, *, cancelled=lambda: False):
    """Grade a sealed private pack with two trusted, pinned host executors.

    Each executor has subject_pin/environment_pin and execute(request). The
    request contains only input, coordinate, deadline and remaining arm budget.
    Response: status, response, usage(cost/tokens/seconds/attempts), floors.
    Host must enforce deadlines/limits, isolate the oracle and meter failures.
    No honest-return assertion here proves those runtime boundaries.
    """
    r = copy.deepcopy(registration)
    registration_pin = seal(r)
    if r['evaluator_pin'] != evaluator_pin() or r['rubric'] != 'exact type and value' or r['stop_rule'] != 'one response per task; no retries':
        raise ValueError('sealed worker source and exact rubric required')
    if not isinstance(pack, list) or digest(pack) != r['dataset_pin']:
        raise ValueError('sealed oracle pack required')
    tasks = {}
    for task in pack:
        if not isinstance(task, dict) or set(task) != {'id', 'family', 'input', 'expected'}:
            raise ValueError('oracle task shape required')
        if not isinstance(task['id'], str) or task['id'] in tasks:
            raise ValueError('unique oracle task required')
        tasks[task['id']] = copy.deepcopy(task)
    if set(tasks) != set(r['task_ids']) or any(tasks[t]['family'] != r['task_families'][t] for t in tasks):
        raise ValueError('oracle denominator or family mismatch')
    if set(executors) != {'baseline', 'candidate'}:
        raise ValueError('paired host executors required')
    for arm, executor in executors.items():
        if executor.subject_pin != r[arm+'_pin'] or executor.environment_pin != r['environment_pin']:
            raise ValueError('host execution binding mismatch')
    export = {k:r[k] for k in ('benchmark', 'release', 'split', 'evaluator_pin', 'dataset_pin', 'environment_pin')}
    export.update(registration_pin=registration_pin, source_kind='supplied-trials')
    audit = []
    commitment_nonce = secrets.token_hex(32)
    spent = {arm:{k:0 for k in r['limits']} for arm in executors}
    rows = {arm:[] for arm in executors}
    halted = {arm:False for arm in executors}
    stopped = False
    # Alternate arms for each coordinate; seeds are deterministic input only.
    for task_id in r['task_ids']:
        task = tasks[task_id]
        for seed in r['seeds']:
            for arm in ('baseline', 'candidate'):
                remaining = {k:max(0, r['limits'][k]-spent[arm][k]) for k in r['limits']}
                base = dict(task_id=task_id, seed=seed, pin=r[arm+'_pin'])
                stopped = stopped or bool(cancelled())
                if stopped or halted[arm] or remaining['attempts'] < 1 or remaining['seconds'] <= 0:
                    event = dict(base, status='cancelled', reason='not dispatched: cancelled or arm budget exhausted')
                    rows[arm].append(dict(base, status='cancelled', score=0, tokens=0, cost=0,
                                          seconds=0, attempts=0, floors={k:0 for k in r['floors']},
                                          receipt_digest=digest({'event':event,'nonce':commitment_nonce})))
                    audit.append(event)
                    continue
                request = dict(task_id=task_id, seed=seed, input=copy.deepcopy(task['input']),
                               subject_pin=r[arm+'_pin'], environment_pin=r['environment_pin'],
                               remaining_budget=copy.deepcopy(remaining), deadline_monotonic=time.monotonic()+remaining['seconds'])
                started = time.monotonic()
                try:
                    result = executors[arm].execute(request)
                    elapsed = time.monotonic()-started
                    if not isinstance(result, dict) or set(result) != {'status', 'response', 'usage', 'floors'}:
                        raise ValueError('complete host result and usage required')
                    status, usage, floors = result['status'], copy.deepcopy(result['usage']), result['floors']
                    if status not in ('ok', 'failed', 'error', 'timeout', 'cancelled'):
                        raise ValueError('terminal host result required')
                    if not isinstance(usage, dict) or set(usage) != set(r['limits']):
                        raise ValueError('actual host usage required, including failures')
                    for value in usage.values():number(value,0)
                    if type(usage['tokens']) != int or type(usage['attempts']) != int or usage['attempts'] != 1:
                        raise ValueError('dispatched integer usage required')
                    if not isinstance(floors, dict) or set(floors) != set(r['floors']):
                        raise ValueError('measured protected floors required')
                    for value in floors.values():number(value,0,1)
                    usage['seconds'] = max(usage['seconds'], elapsed)
                    if elapsed > remaining['seconds']:
                        status = 'timeout'
                    event = dict(base, status=status, response_digest=digest(result['response']),
                                 usage=usage, floors=copy.deepcopy(floors))
                except Exception as exc:
                    audit.append(dict(base, status='error', usage='unknown', error_type=type(exc).__name__))
                    raise IncompleteExecution('execution/accounting incomplete; export and receipt refused', audit) from exc
                audit.append(event)
                score = float(status == 'ok' and type(result['response']) == type(task['expected']) and result['response'] == task['expected'])
                rows[arm].append(dict(base, status=status, score=score, **usage,
                                      floors=copy.deepcopy(floors), receipt_digest=digest({'event':event,'nonce':commitment_nonce})))
                for k in spent[arm]:spent[arm][k] += usage[k]
                halted[arm] = any(spent[arm][k] >= r['limits'][k] and r['limits'][k] > 0 for k in spent[arm])
                # Overruns remain measured; stop further calls rather than hiding them.
                halted[arm] |= any(spent[arm][k] > r['limits'][k] for k in spent[arm])
    export.update(rows)
    validate_export(r, registration_pin, export)
    return export, {'events':audit, 'events_digest':digest(audit), 'commitment_nonce':commitment_nonce, 'oracle_custody':'unverified',
                    'host_isolation':'unverified', 'subject_execution':'host-reported',
                    'adoption_authorized':False}
