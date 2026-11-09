"""Authenticated Code proposal tests through the existing pinned sandbox runner.

The existing proposal-test hold owns admission/accounting. Existing
mind_operations records own once-only dispatch and recovery; no scheduler,
principal conversion, PID adoption or alternative executor is introduced here.
"""
import asyncio
import base64
import json
import math
import os
import re
import secrets
import time

from . import sandbox_run
from .db import now
from .minds import canonical, sha, parse_time, _utc_now
from .programs import ProgramContext, _valid_pin
from .code_project_results import build_result
from .code_project_snapshot import decode_snapshot, MAX_INPUT

PROGRAM = 'code-project-test'
BODY_LIMIT = 28 * 1024 * 1024
RESPONSE_LIMIT = 512 * 1024
CLEANUP_SECONDS = 5
KEYS = {'capability_id', 'launch_key', 'runtime', 'argv', 'runtime_seconds',
        'snapshot_digest', 'snapshot_b64'}


def _fail(hive, code, message, status=409):
    raise hive.error(status, code, message)


def _operator_enabled(hive):
    """One operator opt-in predicate; no request/grant or resource probe."""
    return (hive is not None and os.environ.get('HIVE_CODE_SANDBOX_PROJECT_TESTS') == 'on'
            and getattr(getattr(hive, 'settings', None), 'proposal_test_claims', False) is True)


def _runner_configuration_present(hive):
    """Read only retained Programs metadata and syntactic operator config.

    This is NOT fresh pin/bundle/binary/Code-service/kernel validation. The
    existing actual per-target _owned/_execution/runner paths still own those
    checks before any hold/dispatch and recheck currentness at their old joins.
    """
    if not all(callable(getattr(sandbox_run, name, None)) for name in
               ('run', '_allowed_apps', '_runtimes', 'verify_bundle')):
        return False
    if PROGRAM not in sandbox_run._allowed_apps():
        return False
    configured = sandbox_run._runtimes().get('python')
    if (type(configured) is not dict or type(configured.get('exe')) is not str
            or not os.path.isabs(configured['exe'])):
        return False
    programs = getattr(hive, 'programs', None)
    if programs is None or not all(callable(getattr(programs, name, None)) for name in
                                  ('_ready', 'pinned_release', 'verified_release')):
        return False
    entries, pins = getattr(programs, 'programs', None), getattr(programs, 'pins', None)
    disabled = getattr(programs, 'disabled', None)
    if type(entries) is not dict or type(pins) is not dict or type(disabled) is not set or PROGRAM in disabled:
        return False
    entry, pin = entries.get(PROGRAM), pins.get(PROGRAM)
    return (type(entry) is dict and type(pin) is dict and _valid_pin(pin)
            and entry.get('id') == PROGRAM and not entry.get('error')
            and entry.get('digest') == pin['digest']
            and all(os.environ.get(name) == expected for name, expected in pin.get('env', {}).items())
            and type(entry.get('path')) is str and os.path.isabs(entry['path'])
            and type(entry.get('capabilities')) is list and 'sandbox:run' in entry['capabilities'])


def execution_available(hive=None):
    """Actual-Hive discovery uses the SAME necessary fresh-admission predicate.

    No backend/process/FD/FS/kernel probe, Program loading or status authority.
    No-argument Darwin True is retained only as a PLATFORM diagnostic; both
    actual production callers always pass Hive. No-hive Linux stays False.
    Per-target bytes, argv/runtime reachability, capacity/quota and live-kernel
    revalidation are not promised by this global configuration observation.
    """
    if hive is None:
        return os.sys.platform == 'darwin'
    if os.sys.platform not in ('darwin', 'linux'):
        return False
    try:
        if not _operator_enabled(hive) or not _runner_configuration_present(hive):
            return False
        if os.sys.platform == 'linux':
            owner = _original_resource_owner(hive)
            limits, resources = sandbox_run._aggregate_limits(owner, 'landlock', None, None, None)
            # Fresh-room observation only. It is NOT a reservation and is never
            # reused by an existing run's continuation/currentness checks.
            if resources.C.capacity_available(owner.attempt, limits[1], limits[2]) is not True:
                return False
    except Exception:
        return False
    return True


def _require_execution_available(hive):
    if not _operator_enabled(hive):
        _fail(hive, 'sandbox_project_tests_off', 'operator enablement required', 503)
    if not execution_available(hive):
        _fail(hive, 'sandbox_resource_unavailable',
              "Testing isn't available right now: configuration or resource capacity unavailable", 503)


def _original_resource_owner(hive):
    """Borrow only the private owner attached by original Host construction.

    Exact type is an internal compatibility check, not a new work grant.
    Discovery and every fresh-work boundary validate original retained
    bootstrap/limits/custody; the runner keeps original kernel revalidation.
    """
    if os.sys.platform != 'linux':
        return None
    from .code_aggregate import _CodeAggregate
    owner = getattr(hive, '_code_aggregate', None)
    if type(owner) is not _CodeAggregate:
        _fail(hive, 'sandbox_resource_unavailable',
              'Original Host resource owner is unavailable', 503)
    return owner


def _runner_resource_options(hive, original, original_limits, original_bootstrap, *,
                             original_capacity_policy=None, original_workspace_policy=None):
    """Recheck original owner/limits/bootstrap AND both captured policies.

    The actual continuation producer allows known bounded quiescing
    reservations, refuses UNKNOWN, and never asks for a second fresh slot.
    Actual frozen producer dependencies remain separately held for whole
    composition review; no status/flag or fresh-slot check substitutes here.
    """
    if os.sys.platform != 'linux':
        if (original is not None or original_limits is not None
                or original_bootstrap is not None or original_capacity_policy is not None
                or original_workspace_policy is not None):
            _fail(hive, 'sandbox_resource_changed', 'Host resource context changed', 503)
        return {}  # Preserve every Darwin/generic runner argument.
    owner = _original_resource_owner(hive)
    if (owner is not original or owner.limits is not original_limits
            or owner.attempt is not original_bootstrap
            or type(original_capacity_policy) is not tuple
            or type(original_workspace_policy) is not tuple
            or getattr(owner, 'capacity_policy', None) is not original_capacity_policy
            or getattr(original_bootstrap, 'capacity_policy', None) is not original_capacity_policy
            or getattr(owner, 'workspace_policy', None) is not original_workspace_policy
            or getattr(original_bootstrap, 'workspace_policy', None) is not original_workspace_policy):
        _fail(hive, 'sandbox_resource_changed', 'Host resource context changed', 503)
    try:
        limits, _resources = sandbox_run._aggregate_continuation_limits(
            owner, 'landlock', original_limits, original_bootstrap,
            original_capacity_policy=original_capacity_policy,
            original_workspace_policy=original_workspace_policy)
    except Exception:
        _fail(hive, 'sandbox_resource_unavailable',
              "Testing isn't available right now: configuration or resource capacity unavailable", 503)
    if limits is not original_limits:
        _fail(hive, 'sandbox_resource_changed', 'Host resource context changed', 503)
    return {'_resource_owner': original}


def _json(raw):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError('duplicate JSON key')
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


async def read_body(hive, request):
    """A dedicated cap; existing small service routes are unchanged."""
    chunks, length = [], 0
    async for chunk in request.stream():
        length += len(chunk)
        if length > BODY_LIMIT:
            _fail(hive, 'request_too_large', 'sandbox snapshot request exceeds 28 MiB', 413)
        chunks.append(chunk)
    try:
        value = _json(b''.join(chunks))
    except (ValueError, UnicodeError, RecursionError):
        _fail(hive, 'bad_request', 'strict JSON object required', 400)
    if type(value) is not dict:
        _fail(hive, 'bad_request', 'strict JSON object required', 400)
    return value


def _program(hive):
    """Resolve the actual existing Programs owner, never a posted program dict."""
    entry = hive.programs._ready(PROGRAM)
    pin = hive.programs.pinned_release(PROGRAM)
    metadata = hive.programs.verified_release(PROGRAM)
    if (pin is None or metadata is None or entry['id'] != PROGRAM
            or entry['path'] != pin['path'] or pin['digest'] != metadata['release_digest']
            or 'sandbox:run' not in metadata['capabilities']
            or 'sandbox:run' not in entry['capabilities']):
        _fail(hive, 'sandbox_program_unavailable', 'reviewed pinned code-project-test is required', 503)
    sandbox_run.verify_bundle(entry['path'], 'tools')
    return entry, {'id': PROGRAM, 'release_digest': pin['digest'],
                   'version': pin['version'], 'files': pin['files']}


def _runtime(hive, runtime):
    configured = sandbox_run._runtimes().get(runtime)
    if runtime != 'python' or configured is None or not os.path.isabs(configured['exe']):
        _fail(hive, 'sandbox_runtime_unavailable', 'operator-selected Python runtime required', 503)
    return configured


def _execution(hive, runtime):
    entry, identity = _program(hive)
    configured = _runtime(hive, runtime)
    # Bind the actual operator read-root configuration as well as the exact
    # argv[0]. This is not a binary-origin or native runtime attestation.
    return entry, dict(identity, runtime_configuration=configured), configured


def _owned(hive, service, tid, cap):
    owner = hive.services.by_name('omegacode')
    if service['id'] != owner['id']:
        _fail(hive, 'service_mismatch', 'registered OmegaCode service required', 403)
    hive.code.require_intended_release()
    tests = hive.proposal_tests
    test = tests._owned_test(service, tid)
    pt = tests._owned_capability(service, test, cap)
    tests._withdrawn(service, cap, 'run', pt)
    status = hive.services.capability_status(service, cap)
    claims = status['claims']
    if (claims.get('actions') != ['proposal-test'] or claims.get('kind') != 'agent'
            or any(k in claims for k in ('delegated', 'copy_apply', 'copy_apply_consent'))
            or claims.get('paths') != [] or claims.get('max_runs') != 0
            or pt.get('controller_id') != claims.get('actor') or pt.get('stage') != 'run'):
        _fail(hive, 'purpose_exclusive', 'exclusive original proposal-test run claim required', 403)
    return test, claims, pt


def _binding(service, claims, pt, runtime, argv, seconds):
    return {'schema': 'omegacode-project-test-binding/1', 'service_id': service['id'],
            'capability_id': claims['id'], 'test_id': pt['test_id'],
            'request_id': pt['request_id'], 'lease_id': pt['lease_id'],
            'controller_id': pt['controller_id'], 'issuer': pt['issuer'],
            'repository_id': claims['repository_id'], 'proposal': pt['proposal'],
            'parent': pt['parent'], 'fork': pt['fork'],
            'test_tree_digest': pt['test_tree_digest'], 'runtime': runtime,
            'argv': argv, 'runtime_seconds': seconds}


def _validate(hive, service, tid, data):
    if (type(data) is not dict or set(data) != KEYS or data['runtime'] != 'python'
            or type(data['runtime_seconds']) is not int
            or not CLEANUP_SECONDS + 1 <= data['runtime_seconds'] <= 120
            or type(data['argv']) is not list or not 1 <= len(data['argv']) <= 32
            or any(type(a) is not str or not a or '\x00' in a or len(a.encode()) > 4096 for a in data['argv'])
            or type(data['snapshot_b64']) is not str
            or len(data['snapshot_b64']) > 4 * ((MAX_INPUT + 2) // 3)
            or type(data['snapshot_digest']) is not str
            or re.fullmatch(r'sha256:[0-9a-f]{64}', data['snapshot_digest']) is None
            or hive.proposal_tests.minds._operation({'operation_id': data['launch_key']}) != data['launch_key']):
        _fail(hive, 'sandbox_request', 'exact bounded sandbox request required', 400)
    test, claims, pt = _owned(hive, service, tid, data['capability_id'])
    configured = _runtime(hive, data['runtime'])
    if (data['argv'][0] != configured['exe']
            or not any(data['argv'][:len(p)] == p for p in claims['argv_prefixes'])):
        _fail(hive, 'sandbox_argv', 'exact configured runtime and original argv prefix required', 403)
    try:
        raw = base64.b64decode(data['snapshot_b64'], validate=True)
        if len(raw) > MAX_INPUT or base64.b64encode(raw).decode('ascii') != data['snapshot_b64']:
            raise ValueError('snapshot length or encoding')
        payload, _ = decode_snapshot(raw, expected_digest=data['snapshot_digest'])
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail(hive, 'sandbox_snapshot', 'authenticated snapshot refused', 400)
    if test['preparation'] is None:
        _fail(hive, 'not_bound', 'original preparation required')
    prepared = json.loads(test['preparation'])
    # test_tree_digest is owned by the existing preparation record, not the
    # posted snapshot or an extra signed-claim field.
    pt = dict(pt, test_tree_digest=prepared['test_tree_digest'])
    binding = _binding(service, claims, pt, data['runtime'], data['argv'], data['runtime_seconds'])
    expected_fork = {'workspace_id': prepared['fork_workspace_id'],
                     'preparation_digest': prepared['preparation_digest']}
    if (pt['fork'] != expected_fork or payload['binding'] != binding
            or 'sha256:' + payload['tree_digest'] != binding['test_tree_digest']
            or payload['argv'] != data['argv'] or payload['interpreter'] != configured['exe']):
        _fail(hive, 'sandbox_binding', 'snapshot differs from original retained preparation')
    entry, identity, fresh_runtime = _execution(hive, data['runtime'])
    if fresh_runtime != configured:
        _fail(hive, 'sandbox_runtime_changed', 'operator runtime changed during snapshot admission')
    return raw, binding, claims, entry, identity, configured


def _scope(service, tid, phase):
    return 'code-sandbox-' + phase + ':' + service['id'] + ':' + tid


def _admitted_deadline(loop, request_deadline, claims, admission_until):
    # Observe loop time BEFORE wall time, making translation conservative even
    # across these two original clock observations. Never reset at probe return.
    mono, wall = loop.time(), time.time()
    until = parse_time(claims['proposal_test']['allowance']['until'])
    current_until = parse_time(admission_until)
    if until is None or current_until is None:
        raise ValueError('original lease expiry required')
    return min(request_deadline, mono + claims['exp'] - wall,
               mono + until.timestamp() - wall, mono + current_until.timestamp() - wall)


def _finish(hive, service, tid, result):
    # The original observation is durable before settlement. Identical retry
    # settles/replays that observation; it never launches another child.
    status, raw = hive.proposal_tests.settle(service, tid, result['hold_id'], result['observation'])
    answer = dict(result, hold=json.loads(raw))
    encoded = canonical(answer).encode()
    if len(encoded) > RESPONSE_LIMIT:
        _fail(hive, 'sandbox_result_oversize', 'bounded original result retained; response refused', 503)
    return status, encoded


def read_result(hive, service, tid, launch_key):
    """Historical evidence read, without renewing a run claim or dispatch."""
    hive.proposal_tests._owned_test(service, tid)
    op = hive.minds._operation({'operation_id': launch_key})
    row = hive.db.one('SELECT body FROM mind_operations WHERE scope = ? AND operation_id = ?',
                      (_scope(service, tid, 'end'), op))
    if row is None:
        _fail(hive, 'sandbox_result_unavailable', 'no retained original terminal observation', 404)
    result = json.loads(row['body'])
    receipt = result['receipt']
    currency, current_program, interpreter = 'unknown', None, None
    try:
        _, current_program, configured = _execution(hive, receipt['binding']['runtime'])
        interpreter = configured['exe']
        currency = ('current' if current_program == receipt['program_identity']
                    and interpreter == receipt['binding']['argv'][0] else 'stale')
    except Exception:
        # Retain historical evidence. Missing actual owner/current operator
        # configuration is UNKNOWN, never replaced with the recorded values.
        pass
    return 200, canonical({'schema': 'omegacode-sandbox-result-read/1',
        'result': result, 'execution_currency': currency,
        'current_program_identity': current_program, 'current_interpreter': interpreter}).encode()


async def launch(hive, service, tid, data):
    if type(data) is not dict or set(data) != KEYS:
        _fail(hive, 'sandbox_request', 'exact sandbox request required', 400)
    op = hive.minds._operation({'operation_id': data['launch_key']})
    fingerprint = sha(canonical(data))
    # Authentication/test ownership remain mandatory on replay. Current work
    # authorization is not needed to read a previously owned immutable result.
    hive.proposal_tests._owned_test(service, tid)
    with hive.db.transaction():
        ended = hive.minds._replay(_scope(service, tid, 'end'), op, fingerprint)
        if ended is not None:
            result = json.loads(ended[1])
        else:
            started = hive.minds._replay(_scope(service, tid, 'start'), op, fingerprint)
            if started is not None:
                return started
            result = None
    if result is not None:
        return _finish(hive, service, tid, result)
    _require_execution_available(hive)
    resource_owner = _original_resource_owner(hive)
    original_limits = resource_owner.limits if resource_owner is not None else None
    original_bootstrap = resource_owner.attempt if resource_owner is not None else None
    original_capacity_policy = resource_owner.capacity_policy if resource_owner is not None else None
    original_workspace_policy = resource_owner.workspace_policy if resource_owner is not None else None
    raw, binding, claims, entry, identity, configured = _validate(hive, service, tid, data)
    _runner_resource_options(hive, resource_owner, original_limits, original_bootstrap,
            original_capacity_policy=original_capacity_policy,
            original_workspace_policy=original_workspace_policy)  # before a new work hold/dispatch latch
    admitted = {'capability_id': claims['id'], 'launch_key': op,
                'argv_digest': sha(canonical(data['argv'])), 'runtime_seconds': data['runtime_seconds']}
    with hive.db.transaction():
        started = hive.minds._replay(_scope(service, tid, 'start'), op, fingerprint)
        if started is not None:
            return started
        _, admitted_raw = hive.proposal_tests.admit(service, tid, admitted)
        original_admission = json.loads(admitted_raw)
        hold_id = original_admission['hold_id']
        reserved_run_id = 'run_sbx_' + secrets.token_hex(16)
        start = {'schema': 'omegacode-sandbox-dispatch/1', 'state': 'dispatch_unresolved',
                 'test_id': tid, 'launch_key': op, 'hold_id': hold_id,
                 'run_id': reserved_run_id, 'binding': binding, 'revision': 1}
        hive.minds._record(_scope(service, tid, 'start'), op, fingerprint, 202, start)
    # No await precedes the durable original dispatch latch. A crash after it is
    # UNKNOWN, not evidence of no spawn and never an automatic retry.
    loop = asyncio.get_running_loop()
    deadline = loop.time() + data['runtime_seconds']
    task = None
    host_error = None
    runner = None
    try:
        _owned(hive, service, tid, claims['id'])
        current_entry, current_identity, current_runtime = _execution(hive, 'python')
        if current_identity != identity or current_runtime != configured:
            _fail(hive, 'sandbox_program_changed', 'runtime or pinned program changed')
        deadline = _admitted_deadline(loop, deadline, claims, original_admission['allowance']['until'])
        timeout = deadline - loop.time() - CLEANUP_SECONDS
        if timeout < 1:
            _fail(hive, 'sandbox_deadline', 'no original work plus cleanup budget remains')
        ctx = ProgramContext(hive, claims['swarm_id'], current_entry)
        # The caller's existing purpose authority was checked above. This
        # context is the real admitted program; no fake actor or person grant.
        ctx._need('sandbox:run')
        resource_options = _runner_resource_options(hive, resource_owner, original_limits, original_bootstrap,
            original_capacity_policy=original_capacity_policy,
            original_workspace_policy=original_workspace_policy)
        task = asyncio.create_task(sandbox_run.run(current_entry, 'run.py', args=[data['snapshot_digest']],
            inputs={'snapshot.json': raw}, outputs=(), runtime='python', bundle='tools',
            cpu_seconds=max(1, min(60, math.floor(timeout))), timeout=timeout,
            cleanup_seconds=CLEANUP_SECONDS, absolute_until=deadline,
            child_processes=(os.sys.platform != 'darwin'),
            require_complete_cleanup=True, artifact_bytes=1024, **resource_options))
        while not task.done():
            await asyncio.wait({task}, timeout=min(.25, max(0, deadline-loop.time())))
            if task.done():
                break
            if loop.time() >= deadline:
                _fail(hive, 'sandbox_deadline', 'original admitted absolute deadline reached')
            _owned(hive, service, tid, claims['id'])
            _runner_resource_options(hive, resource_owner, original_limits, original_bootstrap,
            original_capacity_policy=original_capacity_policy,
            original_workspace_policy=original_workspace_policy)
            if _execution(hive, 'python')[1] != identity:
                _fail(hive, 'sandbox_program_changed', 'runtime or pinned program changed')
        runner = await task
        _owned(hive, service, tid, claims['id'])
        _runner_resource_options(hive, resource_owner, original_limits, original_bootstrap,
            original_capacity_policy=original_capacity_policy,
            original_workspace_policy=original_workspace_policy)
        if _execution(hive, 'python')[1] != identity:
            _fail(hive, 'sandbox_program_changed', 'runtime or pinned program changed before result')
    except BaseException as error:
        host_error = {'phase': 'host_dispatch', 'type': type(error).__name__}
        if task is not None:
            if not task.done():
                task.cancel()
            try:
                runner = await task
            except BaseException as runner_error:
                runner = getattr(runner_error, 'sandbox_result', None)
    # No guessed exit/CPU/cleanup on a missing or partial result. The reserved
    # run identity is evidence identity only; it never authorizes PID cleanup.
    if type(runner) is not dict:
        runner = {}
    measured = runner.get('elapsed_seconds')
    actual_run_id = None if runner.get('spawn_attempted') is False else reserved_run_id
    record_state = 'never_spawning' if runner.get('spawn_attempted') is False else 'ended'
    projected = build_result(binding, runner, run_id=actual_run_id,
        snapshot_digest=data['snapshot_digest'], program_identity=identity,
        elapsed_seconds=measured, observed_at=now(), launch_record_rev=2,
        launch_record_state=record_state, authorization_error=host_error)
    result = {'schema': 'omegacode-sandbox-dispatch-result/1', 'test_id': tid,
              'launch_key': op, 'hold_id': hold_id, **projected,
              'captures': {k: base64.b64encode(runner[k]).decode('ascii')
                           for k in ('stdout', 'stderr') if type(runner.get(k)) is bytes},
              'revision': 2}
    with hive.db.transaction():
        hive.minds._record(_scope(service, tid, 'end'), op, fingerprint, 200, result)
    return _finish(hive, service, tid, result)
