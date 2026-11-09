"""Pure projection of the existing runner's HOST observation into retained evidence.

The authenticated adapter supplies its original binding and launch record. This
module issues no grants, reads no project artifacts and persists nothing. The
adapter owns live authorization, idempotency and the existing hold settlement.
"""
import hashlib
import json
import math
import re
from datetime import datetime

SHA = re.compile(r'sha256:[0-9a-f]{64}')
RUN = re.compile(r'run_[A-Za-z0-9_-]{1,120}')
TIME = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z')
BINDING_KEYS = {'schema', 'service_id', 'capability_id', 'test_id', 'request_id', 'lease_id',
                'controller_id', 'issuer', 'repository_id', 'proposal', 'parent', 'fork',
                'test_tree_digest', 'runtime', 'argv', 'runtime_seconds'}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def _digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def _copy(value):
    return json.loads(_canonical(value))


def _binding(value):
    if not isinstance(value, dict) or set(value) != BINDING_KEYS or value['schema'] != 'omegacode-project-test-binding/1':
        raise ValueError('original host binding required')
    for key in BINDING_KEYS - {'schema', 'proposal', 'parent', 'fork', 'argv', 'runtime_seconds'}:
        if not isinstance(value[key], str) or not value[key] or len(value[key]) > 2048:
            raise ValueError('invalid original host binding field')
    if (not isinstance(value['argv'], list) or not 1 <= len(value['argv']) <= 32
            or any(not isinstance(a, str) or not a or '\x00' in a or len(a.encode()) > 4096 for a in value['argv'])
            or type(value['runtime_seconds']) is not int or not 1 <= value['runtime_seconds'] <= 120
            or SHA.fullmatch(value['test_tree_digest']) is None):
        raise ValueError('invalid bound command or runtime')
    for key, keys in (('proposal', {'proposal_id', 'proposal_digest', 'normalized_hunks_digest'}),
                      ('parent', {'workspace_id', 'generation', 'tree_digest'}),
                      ('fork', {'workspace_id', 'preparation_digest'})):
        part = value[key]
        if not isinstance(part, dict) or set(part) != keys:
            raise ValueError('invalid source/proposal binding')
        for name, field in part.items():
            if name == 'generation':
                if type(field) is not int or field < 1:
                    raise ValueError('invalid source generation')
            elif name.endswith('digest'):
                if not isinstance(field, str) or SHA.fullmatch(field) is None:
                    raise ValueError('invalid bound digest')
            elif not isinstance(field, str) or not field:
                raise ValueError('invalid bound reference')
    if len(_canonical(value)) > 65536:
        raise ValueError('binding exceeds bound')
    return _copy(value)


def build_result(binding, runner_result, *, run_id, snapshot_digest, program_identity,
                 elapsed_seconds, observed_at, launch_record_rev, launch_record_state='ended',
                 authorization_error=None):
    """Never accepts candidate-written result files or treats stored DATA as authority.

    A nonzero/partial/unknown observation cannot become a tested success. Cleanup
    uncertainty keeps the existing budget hold unknown with its maximum charge.
    """
    binding = _binding(binding)
    if (not isinstance(runner_result, dict)
            or (run_id is not None and (not isinstance(run_id, str) or RUN.fullmatch(run_id) is None))
            or not isinstance(snapshot_digest, str) or SHA.fullmatch(snapshot_digest) is None
            or not isinstance(program_identity, dict) or not program_identity
            or len(_canonical(program_identity)) > 16384
            or type(launch_record_rev) is not int or not 0 <= launch_record_rev <= 2**53
            or launch_record_state not in ('never_spawning', 'spawning', 'running', 'ended')
            or not isinstance(observed_at, str) or TIME.fullmatch(observed_at) is None):
        raise ValueError('original host observation identity required')
    datetime.fromisoformat(observed_at.removesuffix('Z') + '+00:00')
    if elapsed_seconds is not None and (type(elapsed_seconds) not in (int, float)
            or not math.isfinite(elapsed_seconds) or not 0 <= elapsed_seconds <= 86400):
        raise ValueError('invalid measured elapsed time')
    streams = {}
    for name, limit in (('stdout', 256*1024), ('stderr', 16*1024)):
        data = runner_result.get(name)
        count = runner_result.get(name+'_bytes')
        eof = runner_result.get(name+'_eof') is True
        truncated = runner_result.get(name+'_truncated') is True
        if data is not None and (type(data) is not bytes or len(data) > limit):
            raise ValueError('runner capture exceeds fixed live bound')
        count_valid = type(count) is int and data is not None and count >= len(data)
        streams[name] = {'digest': _digest(data) if data is not None else None,
                         'retained_bytes': len(data) if data is not None else None,
                         'observed_bytes': count if count_valid else None, 'eof': eof,
                         'truncated': truncated,
                         'complete': count_valid and count == len(data) and eof
                                     and runner_result.get(name+'_truncated') is False}
    cleanup = runner_result.get('cleanup', {})
    if not isinstance(cleanup, dict):
        raise ValueError('invalid runner cleanup observation')
    cleanup_complete = (cleanup.get('complete') is True and cleanup.get('original_process_reaped') is True
                        and cleanup.get('original_group_absent') is True and cleanup.get('job_removed') is True
                        and cleanup.get('errors') == []
                        and cleanup.get('descendants') in ('PID_NAMESPACE_TERMINATED', 'FORK_DENIED'))
    exit_code = runner_result.get('exit')
    exit_known = type(exit_code) is int
    primary = runner_result.get('primary_error')
    output_complete = (all(row['complete'] for row in streams.values())
                       and runner_result.get('missing_outputs') == [] and runner_result.get('outputs') == {})
    actual_boundary = (runner_result.get('spawn_attempted') is True and
                       ((runner_result.get('backend') == 'landlock' and cleanup.get('descendants') == 'PID_NAMESPACE_TERMINATED')
                        or (runner_result.get('backend') == 'sandbox-exec' and cleanup.get('descendants') == 'FORK_DENIED')))
    never_started = (run_id is None and launch_record_state == 'never_spawning'
                     and runner_result.get('spawn_attempted') is False
                     and runner_result.get('exit', 'missing') is None
                     and cleanup.get('prelaunch_complete') is True and cleanup.get('job_removed') is True
                     and cleanup.get('errors') == [] and cleanup.get('original_process_reaped') is False
                     and cleanup.get('original_group_absent') is False)
    settled_observation = (run_id is not None and actual_boundary and launch_record_state == 'ended'
                           and exit_known and cleanup_complete and elapsed_seconds is not None
                           and primary is None and authorization_error is None)
    outcome = 'not_started' if never_started else (('completed' if exit_code == 0 else 'failed') if settled_observation else 'unknown')
    success = settled_observation and exit_code == 0 and output_complete
    receipt = {'schema': 'omegacode-sandbox-test-result/1', 'binding': binding,
               'binding_digest': _digest(_canonical(binding)), 'run_id': run_id,
               'snapshot_digest': snapshot_digest, 'program_identity': _copy(program_identity),
               'execution_backend': runner_result.get('backend'), 'streams': streams,
               'exit_code': exit_code if exit_known else None, 'elapsed_seconds': elapsed_seconds,
               'cleanup': _copy(cleanup), 'configured_limits': _copy(runner_result.get('configured_limits', {})),
               'limit_availability': _copy(runner_result.get('limit_availability', {})),
               'primary_error': _copy(primary), 'output_complete': output_complete,
               'authorization_error': _copy(authorization_error), 'never_started_proven': never_started,
               'command_outcome': 'succeeded' if success else 'not_succeeded' if outcome in ('failed', 'not_started') else 'unknown',
               'observed_at': observed_at, 'accepted_source': False, 'independent_evaluation': False}
    receipt['digest'] = _digest(_canonical(receipt))
    observation = {'outcome': outcome, 'run_id': run_id,
                   'runtime': {'seconds': 0 if never_started else max(1, math.ceil(elapsed_seconds)) if elapsed_seconds is not None else None,
                               'provenance': 'wall_clock_bound' if never_started or elapsed_seconds is not None else 'unknown'},
                   'cleanup': {'descendants_stopped': never_started or (cleanup_complete and actual_boundary),
                               'observed_at': observed_at if never_started or (cleanup_complete and actual_boundary) else None},
                   'evidence': {'launch_record_state': launch_record_state, 'launch_record_rev': launch_record_rev},
                   'receipt_digest': receipt['digest']}
    return {'receipt': receipt, 'observation': observation}


def current_result(receipt, binding, *, program_identity, snapshot_digest):
    """The caller obtains current binding from live records, never the browser.

    Stored evidence stays immutable. Editing any bound source/proposal/command or
    changing the actual runtime/program/snapshot makes this projection stale.
    """
    body = {k: v for k, v in receipt.items() if k != 'digest'}
    if receipt.get('digest') != _digest(_canonical(body)):
        raise ValueError('retained result integrity changed')
    current = (receipt['binding'] == _binding(binding) and receipt['program_identity'] == program_identity
               and receipt['snapshot_digest'] == snapshot_digest)
    return {'receipt': _copy(receipt), 'currency': 'current' if current else 'stale',
            'tested': current and receipt['command_outcome'] == 'succeeded'}
