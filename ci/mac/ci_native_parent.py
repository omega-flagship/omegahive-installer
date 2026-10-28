"""Fixed Root parent for one fresh Mac arm64 native runtime build.

No application or service is launched. Native phases require the separately
reviewed fixed source set, exact owner-attested per-job context, complete
current-task accounting, and fresh resource advice immediately before spawn.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
HERE = ROOT / 'native-parent'
SELF = HERE / 'ci_native_parent.py'
PYTHON = '/private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12'
INPUTS = {'path': '/private/tmp/omegahive-ci-r12/native-source/NATIVE_BUILD_INPUTS_R1.json', 'bytes': None, 'sha256': None}
WORKER = {'path': '/private/tmp/omegahive-ci-r12/native-source/ci_native_worker.py', 'bytes': 29154,
          'sha256': '86f7ecc349cce6a61bd4c50b0c5922ed360a7e90a223cb191b658a6cedc21b6d'}
ROLE_PATHS = {
    'worker': str(ROOT / 'native-source/ci_native_worker.py'),
    'python': str(JOB / 'bootstrap/python/bin/python3.12'),
    'ps': '/bin/ps',
    'bash': '/bin/bash',
    'recipe': str(JOB / 'native-runtime-phases.sh'),
    'preparation': str(JOB / 'CI_PREPARATION_RECEIPT_R1.json'),
    'contract': str(ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json'),
    'prepared_inventory': str(JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json'),
}
STATIC_REVIEW_PATHS = {
    'parent': 'native-parent/ci_native_parent.py',
    'enabled_worker': 'native-source/ci_native_worker.py',
    'parent_entry_driver': 'native-source/ci_native_parent_driver.py',
    'input_producer': 'native-source/provision_native_inputs.py',
}
STATIC_SOURCE_PATHS = {
    'enabled_worker': str(ROOT / 'native-source/ci_native_worker.py'),
    'parent_entry_driver': str(ROOT / 'native-source/ci_native_parent_driver.py'),
    'input_producer': str(ROOT / 'native-source/provision_native_inputs.py'),
}
ROLE_MAX_BYTES = {
    'worker': 32 * 1024**2,
    'python': 32 * 1024**2,
    'ps': 32 * 1024**2,
    'bash': 32 * 1024**2,
    'recipe': 32 * 1024**2,
    'preparation': 2 * 1024**2,
    'contract': 32 * 1024**2,
    'prepared_inventory': 8 * 1024**2,
}
INPUTS_MAX_BYTES = 256 * 1024
SYSTEM_ROLES = {'ps': '/bin/ps', 'bash': '/bin/bash'}
CONTEXT = {'path': str(HERE / 'NATIVE_PARENT_CONTEXT_R1.json')}
REVIEW = {'path': str(HERE / 'NATIVE_PARENT_SOURCE_REVIEW_R1.json')}
POLICY = {'path': str(ROOT / 'project_graph/resource-policy.json'), 'bytes': 375,
          'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}
CONTEXT_MAX_BYTES = 256 * 1024
REVIEW_MAX_BYTES = 256 * 1024
TASKS_MAX_BYTES = 256 * 1024
CONTEXT_MAX_AGE_SECONDS = 60
OWNER_LEASE_SECONDS = 1820  # 1800-second native phase budget plus 20-second cleanup reserve.
RESOURCE = {'path': '/private/tmp/omegahive-ci-r12/project_graph/resources.py', 'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}
ESTIMATE = {'ram_gb': 3.125, 'cpu_cores': 2.25, 'disk_gb': 8, 'kind': 'task'}
EXPECTED_UID = None  # OWNER_CI_CONTEXT_UID_PIN
EXPECTED_HOME = ROOT / 'runtime-job/empty-home'
LAUNCH_ENABLED = True
CURRENT_TASKS = None
SOURCE_REVIEW = None
STOP = None


def _strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise RuntimeError('duplicate_json_key')
        value[key] = item
    return value


def _parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError('pinned_json_invalid') from error


def _absolute_parts(path):
    raw_path = str(path)
    value = Path(raw_path)
    if raw_path != str(value):
        raise RuntimeError('canonical_path_required')
    if not value.is_absolute() or any(part in ('', '.', '..') for part in value.parts[1:]):
        raise RuntimeError('plain_absolute_path_required')
    return value, value.parts[1:]


def _open_parent_dir(path):
    value, parts = _absolute_parts(path)
    if not parts:
        raise RuntimeError('file_path_required')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for component in parts[:-1]:
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return value, parts[-1], fd
    except BaseException:
        os.close(fd)
        raise


def _identity_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read_regular(path, *, max_bytes, expected_uid, expected_bytes=None,
                  expected_sha256=None):
    if type(max_bytes) is not int or max_bytes <= 0:
        raise RuntimeError('positive_byte_cap_required')
    if type(expected_uid) is not int or expected_uid < 0:
        raise RuntimeError('nonnegative_exact_owner_uid_required')
    if (expected_bytes is not None
            and (type(expected_bytes) is not int or expected_bytes <= 0)):
        raise RuntimeError('positive_exact_byte_pin_required')
    if (type(expected_sha256) is not str
            or not re.fullmatch('[a-f0-9]{64}', expected_sha256)):
        raise RuntimeError('exact_sha256_pin_required')
    value, name, parent_fd = _open_parent_dir(path)
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != expected_uid or before.st_size <= 0
                or before.st_size > max_bytes
                or (expected_bytes is not None and before.st_size != expected_bytes)):
            raise RuntimeError('owned_bounded_regular_file_required')
        raw = bytearray()
        while True:
            block = os.read(fd, min(65536, max_bytes + 1 - len(raw)))
            if not block:
                break
            raw.extend(block)
            if len(raw) > max_bytes or (expected_bytes is not None and len(raw) > expected_bytes):
                raise RuntimeError('pinned_file_growth')
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (len(raw) != before.st_size or _identity_key(before) != _identity_key(after)
                or _identity_key(before) != _identity_key(named)):
            raise RuntimeError('pinned_file_changed_during_read')
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_sha256:
            raise RuntimeError('pinned_file_sha256_mismatch')
        return bytes(raw), {'path': str(value), 'bytes': len(raw), 'sha256': digest}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent_fd)


def read_bound_json(path, *, max_bytes, expected_sha256, expected_uid, expected_bytes=None):
    raw, pin = _read_regular(path, max_bytes=max_bytes, expected_uid=expected_uid,
                             expected_bytes=expected_bytes, expected_sha256=expected_sha256)
    value = _parse_json(raw)
    if type(value) is not dict:
        raise RuntimeError('pinned_json_object_required')
    return raw, value, pin


def read_job_identity(job_path, expected_uid):
    value, parts = _absolute_parts(job_path)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    parent_fd = None
    try:
        for component in parts[:-1]:
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        parent_fd = fd
        fd = os.open(parts[-1], flags, dir_fd=parent_fd)
        before = os.fstat(fd)
        named = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        if (not stat.S_ISDIR(before.st_mode) or before.st_uid != expected_uid
                or stat.S_IMODE(before.st_mode) != 0o700
                or _identity_key(before) != _identity_key(named)):
            raise RuntimeError('owned_private_job_directory_required')
        return [before.st_dev, before.st_ino, before.st_uid, stat.S_IMODE(before.st_mode)]
    finally:
        os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _pin_shape(value, expected_path, *, allow_unbound=False):
    if type(value) is not dict or set(value) != {'path', 'bytes', 'sha256'}:
        raise RuntimeError('closed_source_pin_required')
    if type(value['path']) is not str or value['path'] != expected_path:
        raise RuntimeError('source_pin_path_mismatch')
    if allow_unbound and value['bytes'] is None and value['sha256'] is None:
        return
    if (type(value['bytes']) is not int or value['bytes'] <= 0
            or type(value['sha256']) is not str
            or not re.fullmatch('[a-f0-9]{64}', value['sha256'])):
        raise RuntimeError('complete_source_pin_required')


def _timestamp(value, label):
    if type(value) is not str:
        raise RuntimeError(label + '_timestamp_required')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise RuntimeError(label + '_timestamp_invalid') from error
    if parsed.tzinfo is None:
        raise RuntimeError(label + '_timestamp_timezone_required')
    return parsed.timestamp()


def validate_current_tasks(tasks, declared_sha256):
    if type(tasks) is not list or len(tasks) > 256:
        raise RuntimeError('bounded_current_tasks_required')
    raw = json.dumps(tasks, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if (len(raw) > TASKS_MAX_BYTES or type(declared_sha256) is not str
            or hashlib.sha256(raw).hexdigest() != declared_sha256):
        raise RuntimeError('current_tasks_sha256_mismatch')
    seen = set()
    for task in tasks:
        if type(task) is not dict or set(task) != {'task_id', 'state', 'pid', 'estimate'}:
            raise RuntimeError('closed_current_task_schema_required')
        if type(task['task_id']) is not str or not task['task_id'] or task['task_id'] in seen:
            raise RuntimeError('current_task_resource_values_invalid')
        seen.add(task['task_id'])
        if type(task['state']) is not str or task['state'] not in {'running', 'reserved'}:
            raise RuntimeError('current_task_state_invalid')
        if (task['state'] == 'running'
                and (type(task['pid']) is not int or task['pid'] <= 0)):
            raise RuntimeError('running_task_pid_required')
        if task['state'] == 'reserved' and task['pid'] is not None:
            raise RuntimeError('reserved_task_pid_must_be_null')
        estimate = task['estimate']
        if type(estimate) is not dict or set(estimate) != {'ram_gb', 'cpu_cores', 'disk_gb'}:
            raise RuntimeError('closed_task_estimate_schema_required')
        if (any(type(estimate[key]) not in (int, float) or type(estimate[key]) is bool
                or estimate[key] < 0 or estimate[key] > 1000000
                or not math.isfinite(estimate[key])
                for key in ('ram_gb', 'cpu_cores', 'disk_gb'))
                or estimate['ram_gb'] <= 0 or estimate['cpu_cores'] <= 0):
            raise RuntimeError('current_task_resource_values_invalid')
    return tasks


def validate_context(context, *, source_sha256, source_bytes, static_review_pin,
                     job_identity, inputs_pin, owner_uid, now_epoch):
    fields = {'schema', 'owner_uid', 'execution_owner', 'job_path', 'job_identity',
              'parent_source', 'static_review_pin', 'source_owner', 'origin_machine',
              'inputs', 'system_tools', 'current_tasks', 'current_tasks_sha256',
              'current_tasks_complete', 'task_admission', 'resource_admission',
              'observed_at', 'expires_at'}
    if type(context) is not dict or set(context) != fields:
        raise RuntimeError('closed_native_parent_context_required')
    if context['schema'] != 'studio-Mac-CI-native-parent-owner-context/1':
        raise RuntimeError('native_parent_context_schema_mismatch')
    if type(context['owner_uid']) is not int or context['owner_uid'] != owner_uid:
        raise RuntimeError('native_parent_context_owner_mismatch')
    identity = context['job_identity']
    if (type(identity) is not list or len(identity) != 4
            or any(type(item) is not int for item in identity)
            or identity[0] <= 0 or identity[1] <= 0 or identity[2] != owner_uid
            or identity[3] != 0o700
            or context['job_path'] != str(JOB) or identity != job_identity):
        raise RuntimeError('native_parent_context_job_identity_mismatch')
    source = context['parent_source']
    if (type(source) is not dict or set(source) != {'path', 'bytes', 'sha256'}
            or type(source['path']) is not str
            or source['path'] != STATIC_REVIEW_PATHS['parent']
            or type(source['bytes']) is not int or source['bytes'] != source_bytes
            or type(source['sha256']) is not str or source['sha256'] != source_sha256):
        raise RuntimeError('native_parent_context_source_subject_mismatch')
    if (type(context['source_owner']) is not str or not context['source_owner']
            or type(context['origin_machine']) is not str or not context['origin_machine']
            or type(context['execution_owner']) is not str or not context['execution_owner']):
        raise RuntimeError('native_parent_context_provenance_required')
    if context['current_tasks_complete'] is not True:
        raise RuntimeError('current_tasks_operator_completeness_attestation_required')
    _pin_shape(context['inputs'], INPUTS['path'])
    if context['inputs'] != inputs_pin:
        raise RuntimeError('native_parent_context_input_pin_mismatch')
    _pin_shape(context['static_review_pin'], REVIEW['path'])
    if context['static_review_pin'] != static_review_pin:
        raise RuntimeError('native_parent_context_static_review_pin_mismatch')
    tools = context['system_tools']
    if (type(tools) is not dict or set(tools) != {'ps', 'bash'}
            or any(type(tools[name]) is not dict for name in ('ps', 'bash'))
            or tools['ps'].get('path') != ROLE_PATHS['ps']
            or tools['bash'].get('path') != ROLE_PATHS['bash']):
        raise RuntimeError('native_parent_system_tool_context_required')
    if (type(source_sha256) is not str or not re.fullmatch('[a-f0-9]{64}', source_sha256)
            or type(source_bytes) is not int or source_bytes <= 0):
        raise RuntimeError('parent_source_pin_required')
    task = context['task_admission']
    task_fields = {'schema', 'status', 'valid_until_epoch', 'task_id', 'resource_id',
                   'execution_owner', 'owner_uid', 'job_path', 'job_identity',
                   'parent_source_sha256', 'static_review_sha256', 'worker_sha256',
                   'inputs_sha256', 'source_owner', 'origin_machine', 'limits'}
    resource = context['resource_admission']
    resource_fields = {'schema', 'status', 'valid_until_epoch', 'resource_id',
                       'execution_owner',
                       'owner_uid', 'job_path', 'job_identity', 'parent_source_sha256',
                       'static_review_sha256', 'worker_sha256', 'inputs_sha256',
                       'source_owner', 'origin_machine', 'reserved_limits'}
    if type(task) is not dict or set(task) != task_fields:
        raise RuntimeError('closed_parent_task_admission_required')
    if type(resource) is not dict or set(resource) != resource_fields:
        raise RuntimeError('closed_parent_resource_admission_required')
    limits = {'cpu_cores': 2.25, 'ram_bytes': 3355443200,
              'scratch_bytes': 8 * 1024**3, 'wall_seconds': 1800}
    binding = {
        'owner_uid': owner_uid, 'job_path': str(JOB), 'job_identity': job_identity,
        'parent_source_sha256': source_sha256,
        'static_review_sha256': static_review_pin['sha256'],
        'worker_sha256': WORKER['sha256'], 'inputs_sha256': inputs_pin['sha256'],
        'source_owner': context['source_owner'], 'origin_machine': context['origin_machine']}
    if (task.get('schema') != 'studio-Mac-CI-native-parent-task-admission/1'
            or task.get('status') != 'OWNER_ADMITTED_NATIVE_PARENT'
            or resource.get('schema') != 'studio-Mac-CI-native-parent-resource-admission/1'
            or resource.get('status') != 'RESERVED_NATIVE_PARENT'
            or type(task.get('valid_until_epoch')) is not int
            or type(resource.get('valid_until_epoch')) is not int
            or task['valid_until_epoch'] < now_epoch + OWNER_LEASE_SECONDS
            or resource['valid_until_epoch'] < now_epoch + OWNER_LEASE_SECONDS
            or task['valid_until_epoch'] > int(now_epoch) + 3600
            or resource['valid_until_epoch'] > int(now_epoch) + 3600
            or not all(task.get(key) == value for key, value in binding.items())
            or not all(resource.get(key) == value for key, value in binding.items())
            or resource.get('execution_owner') != context['execution_owner']
            or type(task.get('task_id')) is not str or not task['task_id']
            or type(task.get('resource_id')) is not str or not task['resource_id']
            or task['resource_id'] != resource.get('resource_id')
            or task['execution_owner'] != context['execution_owner']
            or task.get('limits') != limits or resource.get('reserved_limits') != limits):
        raise RuntimeError('parent_task_resource_admission_binding_required')
    for name, pin in tools.items():
        _pin_shape(pin, ROLE_PATHS[name])
    observed = _timestamp(context['observed_at'], 'observed')
    expires = _timestamp(context['expires_at'], 'expires')
    if (type(now_epoch) not in (int, float) or type(now_epoch) is bool
            or observed > now_epoch or expires < now_epoch or expires <= observed
            or expires - observed > CONTEXT_MAX_AGE_SECONDS):
        raise RuntimeError('native_parent_context_stale_or_invalid')
    return validate_current_tasks(context['current_tasks'], context['current_tasks_sha256'])


def validate_resource_advice_age(*, checked_at, now_epoch,
                                 sample_started_monotonic, now_monotonic):
    clocks = (now_epoch, sample_started_monotonic, now_monotonic)
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in clocks):
        raise RuntimeError('finite_resource_advice_clocks_required')
    snapshot_age = now_epoch - _timestamp(checked_at, 'resource')
    elapsed = now_monotonic - sample_started_monotonic
    if not (0 <= snapshot_age <= 15 and 0 <= elapsed <= 15):
        raise RuntimeError('resource_advice_stale_before_worker')
    return {'snapshot_age_seconds': snapshot_age,
            'elapsed_since_sample_started_seconds': elapsed}


def validate_parent_log_bytes(stdout_bytes, stderr_bytes):
    if (type(stdout_bytes) is not int or type(stderr_bytes) is not int
            or stdout_bytes < 0 or stderr_bytes < 0
            or stdout_bytes + stderr_bytes > 65536):
        raise RuntimeError('combined_parent_log_limit')
    return stdout_bytes + stderr_bytes


def validate_observation_gap(gap_seconds):
    if (type(gap_seconds) not in (int, float) or not math.isfinite(gap_seconds)
            or not 0 <= gap_seconds <= 2.5):
        raise RuntimeError('parent_resource_observation_gap')
    return gap_seconds


def validate_review(review, *, source_path, source_sha256, source_bytes,
                    owner_uid):
    fields = {'schema', 'source_owner', 'origin_machine', 'verdict',
              'blocking_findings', 'subject'}
    if type(review) is not dict or set(review) != fields:
        raise RuntimeError('closed_native_parent_static_review_required')
    if review['schema'] != 'studio-Mac-CI-native-parent-static-review/1':
        raise RuntimeError('native_parent_review_schema_mismatch')
    if (type(review['source_owner']) is not str or not review['source_owner']
            or type(review['origin_machine']) is not str or not review['origin_machine']):
        raise RuntimeError('native_parent_static_review_provenance_required')
    if (type(review['verdict']) is not str
            or review['verdict'] not in {'SHIP_SOURCE_ONLY', 'PASS_SOURCE_ONLY'}):
        raise RuntimeError('independent_Source_review_not_PASS')
    if type(review['blocking_findings']) is not list or review['blocking_findings'] != []:
        raise RuntimeError('independent_Source_review_has_blockers')
    subject = review['subject']
    if type(subject) is not dict or set(subject) != set(STATIC_REVIEW_PATHS):
        raise RuntimeError('closed_native_parent_static_review_subject_required')
    parent = subject['parent']
    if (type(parent) is not dict or set(parent) != {'path', 'bytes', 'sha256'}
            or parent != {'path': source_path, 'bytes': source_bytes, 'sha256': source_sha256}):
        raise RuntimeError('independent_Source_review_parent_subject_mismatch')
    worker = subject['enabled_worker']
    if (type(worker) is not dict or set(worker) != {'path', 'bytes', 'sha256'}
            or worker != {'path': STATIC_REVIEW_PATHS['enabled_worker'],
                          'bytes': WORKER['bytes'], 'sha256': WORKER['sha256']}):
        raise RuntimeError('independent_Source_review_enabled_worker_mismatch')
    for name in ('parent_entry_driver', 'input_producer'):
        pin = subject[name]
        if (type(pin) is not dict or set(pin) != {'path', 'bytes', 'sha256'}
                or pin.get('path') != STATIC_REVIEW_PATHS[name]
                or type(pin.get('bytes')) is not int or not 0 < pin['bytes'] <= 2 * 1024**2
                or type(pin.get('sha256')) is not str
                or not re.fullmatch('[a-f0-9]{64}', pin['sha256'])):
            raise RuntimeError('static_source_role_pin_required:' + name)
        _raw, _pin = _read_regular(STATIC_SOURCE_PATHS[name], max_bytes=2 * 1024**2,
                                   expected_uid=owner_uid, expected_bytes=pin['bytes'],
                                   expected_sha256=pin['sha256'])
    return review


def now():
    return datetime.now(timezone.utc).isoformat()


def read_pin(pin, *, role=None):
    if type(pin) is not dict or set(pin) != {'path', 'bytes', 'sha256'}:
        raise RuntimeError('closed_source_pin_required')
    if role is None:
        if pin['path'] in SYSTEM_ROLES.values():
            raise RuntimeError('system_role_requires_exact_role_name')
        expected_uid = EXPECTED_UID
    else:
        if role not in ROLE_PATHS or pin['path'] != ROLE_PATHS[role]:
            raise RuntimeError('native_role_fixed_path_mismatch')
        if type(pin['bytes']) is not int or not 0 < pin['bytes'] <= ROLE_MAX_BYTES[role]:
            raise RuntimeError('native_role_byte_cap_exceeded')
        expected_uid = 0 if role in SYSTEM_ROLES else EXPECTED_UID
    raw, _observed = _read_regular(
        pin['path'], max_bytes=pin['bytes'], expected_uid=expected_uid,
        expected_bytes=pin['bytes'], expected_sha256=pin['sha256'])
    return raw


def write_json(path, value):
    with path.open('x') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())


def cancelled(number, _frame):
    global STOP
    STOP = 'signal_' + str(number)


def census(group):
    run = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,rss=,stat='],
                         env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                         stdin=subprocess.DEVNULL, capture_output=True, timeout=2)
    if run.returncode != 0 or len(run.stdout) > 1024**2 or len(run.stderr) > 4096:
        raise RuntimeError('numeric_census_failed')
    rows, seen = [], set()
    for line in run.stdout.decode('ascii').splitlines():
        fields = line.split()
        if (len(fields) != 4 or any(not value.isdecimal() for value in fields[:3])
                or not re.fullmatch('[A-Za-z+<>=?-]+', fields[3])):
            raise RuntimeError('numeric_census_schema')
        pid, pgid, kib = map(int, fields[:3])
        if pid in seen:
            raise RuntimeError('duplicate_census_PID')
        seen.add(pid)
        if pgid == group or pid == os.getpid():
            rows.append({'pid': pid, 'pgid': pgid, 'rss_bytes': kib * 1024,
                         'zombie': 'Z' in fields[3]})
    if not any(row['pid'] == os.getpid() and not row['zombie'] for row in rows):
        raise RuntimeError('parent_missing_from_census')
    return rows


def terminate_owned(process, limit):
    actions = []
    errors = []
    def remaining():
        try:
            return [r for r in census(process.pid) if r['pgid'] == process.pid]
        except Exception as error:
            errors.append(type(error).__name__)
            return None
    # process is exclusively this parent's Popen child, born in a new session.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        rows = remaining()
        exited = process.poll() is not None
        if exited and rows == []:
            break
        if exited and rows is None:
            # A dead child plus unknown group ownership is not a signal grant.
            break
        try:
            os.killpg(process.pid, sig)
            actions.append(sig.name)
        except ProcessLookupError:
            pass
        end = min(limit, time.monotonic() + (10 if sig == signal.SIGTERM else 5))
        while time.monotonic() < end:
            process.poll()
            if remaining() == []:
                break
            time.sleep(.1)
    reaped = False
    try:
        process.wait(timeout=max(.1, limit - time.monotonic()))
        reaped = True
    except subprocess.TimeoutExpired:
        errors.append('worker_wait_timeout')
    rows = remaining()
    return {'signals': actions, 'worker_reaped': reaped, 'remaining_group': rows,
            'observation_errors': errors, 'group_absent': rows == []}


def finalize_owned(process, attempt, prior_status, deadline):
    errors = []
    cleanup = {'signals': [], 'worker_reaped': False, 'group_absent': False,
               'remaining_group': None, 'observation_errors': []}
    try:
        cleanup = terminate_owned(process, deadline)
    except BaseException as error:
        errors.append({'stage': 'owned_cleanup', 'type': type(error).__name__})
        # Last-resort API action is confined to the parent's own live Popen child.
        # Group ownership is unknown here, so do not signal a guessed group.
        try:
            if process.poll() is None:
                process.kill()
                cleanup['signals'].append('direct_child_SIGKILL')
            process.wait(timeout=max(.1, deadline - time.monotonic()))
            cleanup['worker_reaped'] = True
        except BaseException as fallback:
            errors.append({'stage': 'direct_child_cleanup', 'type': type(fallback).__name__})
        try:
            rows = [row for row in census(process.pid) if row['pgid'] == process.pid]
            cleanup['remaining_group'] = rows
            cleanup['group_absent'] = rows == []
        except BaseException as observation:
            errors.append({'stage': 'final_group_observation', 'type': type(observation).__name__})
    sizes = {}
    for name in ('WORKER_STDOUT.log', 'WORKER_STDERR.log'):
        try:
            info = (attempt / name).lstat()
            sizes[name] = info.st_size
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
                errors.append({'stage': name, 'type': 'final_log_contract'})
        except BaseException as error:
            errors.append({'stage': name, 'type': type(error).__name__})
    if len(sizes) == 2:
        try:
            validate_parent_log_bytes(sizes['WORKER_STDOUT.log'], sizes['WORKER_STDERR.log'])
        except RuntimeError as error:
            errors.append({'stage': 'combined_parent_logs', 'type': str(error)})
    if time.monotonic() > deadline:
        errors.append({'stage': 'cleanup', 'type': 'deadline_exceeded'})
    clean = (cleanup.get('worker_reaped') is True and cleanup.get('group_absent') is True
             and cleanup.get('signals') == [])
    status = 'worker_exit0' if prior_status == 'worker_exit0' and clean and not errors else (
        prior_status if prior_status != 'worker_exit0' else 'failed_finalization_unverified')
    return {'status': status, 'cleanup': cleanup, 'worker_exit': process.returncode,
            'final_log_bytes': sizes, 'finalization_errors': errors}


def private_home_snapshot():
    key = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_mode)
    validated = {}
    for name, path in (('root', ROOT), ('home', EXPECTED_HOME)):
        if path != path.resolve():
            raise RuntimeError('canonical_CI_directory_required')
        for parent in path.parents:
            if not stat.S_ISDIR(parent.lstat().st_mode):
                raise RuntimeError('plain_CI_directory_ancestry_required')
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != EXPECTED_UID
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError('owned_private_CI_directory_required')
        validated[name] = key(info)
    descriptors = {}
    try:
        for name, path in (('root', ROOT), ('home', EXPECTED_HOME)):
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors[name] = fd
            info = os.fstat(fd)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != EXPECTED_UID
                    or stat.S_IMODE(info.st_mode) != 0o700
                    or key(info) != validated[name] or key(path.lstat()) != validated[name]):
                raise RuntimeError('CI_private_directory_changed_since_validation')
        for name, path in (('root', ROOT), ('home', EXPECTED_HOME)):
            if key(os.fstat(descriptors[name])) != validated[name] or key(path.lstat()) != validated[name]:
                raise RuntimeError('CI_private_directory_identity_changed')
        return {name: list(value) for name, value in validated.items()}
    finally:
        for fd in descriptors.values():
            os.close(fd)


def completion_file(path, maximum):
    path = Path(path)
    if path != path.resolve():
        raise RuntimeError('canonical_completion_path_required')
    for parent in path.parents:
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise RuntimeError('plain_completion_ancestry_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_uid != EXPECTED_UID or not 0 < before.st_size <= maximum):
            raise RuntimeError('owned_bounded_completion_file_required')
        raw = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            raw.extend(block)
            if len(raw) > maximum:
                raise RuntimeError('completion_file_growth')
        key = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                             value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if (len(raw) != before.st_size or key(before) != key(os.fstat(fd))
                or key(before) != key(path.lstat())):
            raise RuntimeError('completion_file_changed_during_read')
        return bytes(raw), {'path': str(path), 'bytes': len(raw),
                            'sha256': hashlib.sha256(raw).hexdigest()}
    finally:
        os.close(fd)


def linked_worker_completion(attempt, worker_pid):
    stdout, stdout_pin = completion_file(attempt / 'WORKER_STDOUT.log', 65536)
    lines = stdout.decode('utf-8').splitlines()
    if len(lines) != 1:
        raise RuntimeError('single_native_completion_line_required')
    message = json.loads(lines[0])
    if set(message) != {'status', 'result'} or message['status'] != 'passed':
        raise RuntimeError('passed_native_worker_stdout_required')
    path = Path(message['result'])
    if (path.parent.parent != ROOT / 'native-build-attempts'
            or path.name != 'NATIVE_BUILD_RESULT_R1.json'
            or not re.fullmatch('[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}', path.parent.name)):
        raise RuntimeError('fixed_native_completion_namespace_required')
    raw, result_pin = completion_file(path, 1024**2)
    worker = json.loads(raw)
    if (worker.get('schema') != 'studio-Mac-CI-native-phase-result/1'
            or worker.get('status') != 'passed'
            or worker.get('worker_pid') != worker_pid or worker.get('worker_pgid') != worker_pid
            or worker.get('worker_source_sha256') != WORKER['sha256']
            or worker.get('job_manifest_sha256') != INPUTS['sha256']
            or worker.get('forced_group_exit_needed') is not False
            or worker.get('final_cleanup', {}).get('confirmed_no_group_children') is not True
            or worker.get('final_cleanup', {}).get('forced_group_exit_needed') is not False
            or worker.get('final_cleanup', {}).get('term_sent')):
        raise RuntimeError('native_completion_identity_or_cleanup_mismatch')
    receipt_path = ROOT / 'runtime-job/receipts/native-phases-r1.json'
    raw, receipt_pin = completion_file(receipt_path, 2 * 1024**2)
    receipt = json.loads(raw)
    phases = ['tools', 'python', 'node', 'pcre', 'configure', 'build', 'install', 'deps', 'janus']
    commands = receipt.get('commands')
    if (receipt.get('schema') != 'studio-Mac-CI-native-phase-completion/1'
            or receipt.get('status') != 'ALL_REQUIRED_NATIVE_PHASES_COMPLETE'
            or receipt.get('native_action') is not True or receipt.get('completed_phases') != phases
            or receipt.get('inputs_sha256') != INPUTS['sha256']
            or type(commands) is not list or len(commands) != len(phases)
            or any(command.get('phase') != phase or command.get('exit') != 0
                   or command.get('cleanup', {}).get('confirmed_no_group_children') is not True
                   or command.get('cleanup', {}).get('forced_group_exit_needed') is not False
                   or command.get('cleanup', {}).get('term_sent')
                   for command, phase in zip(commands, phases))):
        raise RuntimeError('native_receipt_phase_completion_mismatch')
    selected = json.loads(read_pin(INPUTS))
    if receipt.get('canonical_recipe') != selected['roles']['recipe']:
        raise RuntimeError('native_receipt_canonical_recipe_mismatch')
    _raw, recipe_pin = completion_file(ROOT / 'runtime-job/native-runtime-phases.enabled.sh', 64 * 1024)
    if receipt.get('executed_recipe') != recipe_pin:
        raise RuntimeError('native_executed_recipe_pin_mismatch')
    return {'worker_stdout': stdout_pin, 'worker_result': result_pin,
            'worker_receipt': receipt_pin, 'completed_phases': phases,
            'executed_recipe': recipe_pin, 'canonical_recipe': receipt['canonical_recipe']}


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--source-bytes', required=True, type=int)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--static-review-bytes', required=True, type=int)
    parser.add_argument('--static-review-sha256', required=True)
    parser.add_argument('--owner-context-bytes', required=True, type=int)
    parser.add_argument('--owner-context-sha256', required=True)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not (LAUNCH_ENABLED is True and Path(__file__).absolute() == SELF and Path.cwd() == ROOT
            and sys.executable == PYTHON and sys.platform == 'darwin'
            and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
            and not sys.flags.optimize and type(os.getuid()) is int and os.getuid() > 0
            and os.getuid() == os.geteuid()
            and os.environ.get('HOME') == str(EXPECTED_HOME)
            and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL):
        raise SystemExit('DISABLED_or_unbound_Root_invocation')
    owner_uid = os.getuid()
    if (type(args.source_bytes) is not int or args.source_bytes <= 0
            or type(args.owner_context_bytes) is not int or args.owner_context_bytes <= 0
            or type(args.static_review_bytes) is not int or args.static_review_bytes <= 0
            or not re.fullmatch('[a-f0-9]{64}', args.source_sha256)
            or not re.fullmatch('[a-f0-9]{64}', args.owner_context_sha256)
            or not re.fullmatch('[a-f0-9]{64}', args.static_review_sha256)):
        raise RuntimeError('exact_external_cli_pins_required')
    source_raw, source_file_pin = _read_regular(
        SELF, max_bytes=1024 * 1024, expected_uid=owner_uid,
        expected_bytes=args.source_bytes, expected_sha256=args.source_sha256)
    if source_file_pin['sha256'] != args.source_sha256:
        raise RuntimeError('Root_parent_source_changed')
    _raw_review, review, review_file_pin = read_bound_json(
        REVIEW['path'], max_bytes=REVIEW_MAX_BYTES, expected_bytes=args.static_review_bytes,
        expected_sha256=args.static_review_sha256, expected_uid=owner_uid)
    validate_review(review, source_path=STATIC_REVIEW_PATHS['parent'],
                    source_sha256=args.source_sha256, source_bytes=args.source_bytes,
                    owner_uid=owner_uid)
    _raw_context, context, context_file_pin = read_bound_json(
        CONTEXT['path'], max_bytes=CONTEXT_MAX_BYTES, expected_bytes=args.owner_context_bytes,
        expected_sha256=args.owner_context_sha256, expected_uid=owner_uid)
    job_identity = read_job_identity(JOB, owner_uid)
    here_identity = read_job_identity(HERE, owner_uid)
    inputs_pin = context.get('inputs')
    static_review_pin = context.get('static_review_pin')
    current_tasks = validate_context(
        context, source_sha256=args.source_sha256, source_bytes=args.source_bytes,
        static_review_pin=review_file_pin, job_identity=job_identity, inputs_pin=inputs_pin,
        owner_uid=owner_uid, now_epoch=time.time())
    global EXPECTED_UID, CURRENT_TASKS, SOURCE_REVIEW, INPUTS
    EXPECTED_UID = owner_uid
    CURRENT_TASKS = current_tasks
    SOURCE_REVIEW = review
    INPUTS = inputs_pin
    home_identity = private_home_snapshot()
    if type(INPUTS['bytes']) is not int or not 0 < INPUTS['bytes'] <= INPUTS_MAX_BYTES:
        raise RuntimeError('native_input_binding_byte_cap_exceeded')
    selected_raw = read_pin(INPUTS)
    selected = _parse_json(selected_raw)
    if type(selected) is not dict:
        raise RuntimeError('native_build_inputs_object_required')
    roles = selected.get('roles')
    if type(roles) is not dict or set(roles) != set(ROLE_PATHS):
        raise RuntimeError('closed_native_build_role_pins_required')
    for role_name, expected_path in ROLE_PATHS.items():
        _pin_shape(roles[role_name], expected_path)
    if roles['worker'] != WORKER:
        raise RuntimeError('native_worker_role_static_pin_mismatch')
    if context['system_tools'] != {'ps': roles['ps'], 'bash': roles['bash']}:
        raise RuntimeError('native_parent_system_tool_role_binding_mismatch')
    if (selected.get('source_owner') != context['source_owner']
            or selected.get('origin_machine') != context['origin_machine']):
        raise RuntimeError('native_parent_context_provenance_mismatch')
    for role_name, role_pin in roles.items():
        read_pin(role_pin, role=role_name)
    if not args.run:
        print(json.dumps({'status': 'DRY_PLAN_NO_NATIVE_ACTION',
                          'source_sha256': args.source_sha256,
                          'static_review_sha256': review_file_pin['sha256'],
                          'owner_context_sha256': context_file_pin['sha256'],
                          'worker_sha256': WORKER['sha256'],
                          'inputs_sha256': INPUTS['sha256'],
                          'task_id': context['task_admission']['task_id'],
                          'resource_id': context['resource_admission']['resource_id'],
                          'resource_sample': 'not_sampled; no launch requested'}), flush=True)
        return 0
    attempt = HERE / ('attempt-' + uuid.uuid4().hex)
    attempt.mkdir(mode=0o700)
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    process = None
    result = {'schema': 'studio-Mac-CI-Root-native-parent/1', 'source_owner': context['source_owner'],
              'origin_machine': context['origin_machine'], 'started_at': now(), 'status': 'starting',
              'execution_owner': context['execution_owner'],
              'task_id': context['task_admission']['task_id'],
              'resource_id': context['resource_admission']['resource_id'],
              'estimate': ESTIMATE, 'source_review': SOURCE_REVIEW, 'worker': WORKER,
              'parent_source_sha256': args.source_sha256,
              'inputs': INPUTS, 'context_pin': context_file_pin, 'review_pin': review_file_pin,
              'source_file_pin': source_file_pin, 'rss_peak_bytes': 0, 'sample_count': 0, 'max_sample_gap': 0}
    started = time.monotonic()
    last = started
    process = None
    resource_admission = None
    return_code = 1
    argv = [PYTHON, '-I', '-B', '-S', WORKER['path'], '--inputs', INPUTS['path'],
            '--inputs-sha256', INPUTS['sha256'], '--source-sha256', WORKER['sha256']]
    try:
        with (attempt / 'WORKER_STDOUT.log').open('xb') as out, (attempt / 'WORKER_STDERR.log').open('xb') as err:
            if private_home_snapshot() != home_identity:
                raise RuntimeError('CI_private_directory_changed_before_worker')
            resource_raw, resource_file_pin = _read_regular(
                RESOURCE['path'], max_bytes=1024 * 1024, expected_uid=owner_uid,
                expected_bytes=RESOURCE['bytes'], expected_sha256=RESOURCE['sha256'])
            policy_raw, policy_file_pin = _read_regular(
                POLICY['path'], max_bytes=POLICY['bytes'], expected_uid=owner_uid,
                expected_bytes=POLICY['bytes'], expected_sha256=POLICY['sha256'])
            namespace = {'__name__': 'Root_resource_gate', '__file__': RESOURCE['path']}
            exec(compile(resource_raw, RESOURCE['path'], 'exec'), namespace)
            resource_sample_started = time.monotonic()
            snapshot = namespace['sample'](force=True)
            disk = os.statvfs(ROOT)
            snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                                'free_bytes': disk.f_bavail * disk.f_frsize}
            advice = namespace['advise'](snapshot, ESTIMATE, CURRENT_TASKS)
            _policy_check, policy_after_pin = _read_regular(
                POLICY['path'], max_bytes=POLICY['bytes'], expected_uid=owner_uid,
                expected_bytes=POLICY['bytes'], expected_sha256=POLICY['sha256'])
            if (policy_after_pin != policy_file_pin
                    or advice.get('policy', {}).get('sha256') != POLICY['sha256']):
                raise RuntimeError('resource_policy_pin_mismatch')
            resource_admission = {
                'at': snapshot['checked_at'], 'pressure': snapshot['memory']['pressure'],
                'advice': advice, 'current_tasks': CURRENT_TASKS,
                'source_review': SOURCE_REVIEW, 'private_CI_directory_identity': home_identity,
                'context_pin': context_file_pin, 'review_pin': review_file_pin,
                'resource_pin': {'path': RESOURCE['path'], 'bytes': RESOURCE['bytes'], 'sha256': RESOURCE['sha256']},
                'resource_policy_pin': policy_after_pin}
            current_job_identity = read_job_identity(JOB, owner_uid)
            if current_job_identity != job_identity:
                raise RuntimeError('native_job_identity_changed_before_worker')
            current_source_raw, current_source_pin = _read_regular(
                SELF, max_bytes=1024 * 1024, expected_uid=owner_uid,
                expected_bytes=args.source_bytes, expected_sha256=args.source_sha256)
            if current_source_pin != source_file_pin:
                raise RuntimeError('Root_parent_source_changed_before_worker')
            _latest_review_raw, latest_review, latest_review_pin = read_bound_json(
                REVIEW['path'], max_bytes=REVIEW_MAX_BYTES,
                expected_bytes=args.static_review_bytes,
                expected_sha256=args.static_review_sha256, expected_uid=owner_uid)
            if latest_review_pin != review_file_pin:
                raise RuntimeError('native_static_review_changed_before_worker')
            validate_review(latest_review, source_path=STATIC_REVIEW_PATHS['parent'],
                            source_sha256=args.source_sha256, source_bytes=args.source_bytes,
                            owner_uid=owner_uid)
            _latest_context_raw, latest_context, latest_context_pin = read_bound_json(
                CONTEXT['path'], max_bytes=CONTEXT_MAX_BYTES,
                expected_bytes=args.owner_context_bytes,
                expected_sha256=args.owner_context_sha256, expected_uid=owner_uid)
            if latest_context_pin != context_file_pin:
                raise RuntimeError('native_owner_context_changed_before_worker')
            validate_context(
                latest_context, source_sha256=args.source_sha256, source_bytes=args.source_bytes,
                static_review_pin=latest_review_pin, job_identity=current_job_identity,
                inputs_pin=INPUTS, owner_uid=owner_uid, now_epoch=time.time())
            current_inputs_raw = read_pin(INPUTS)
            if current_inputs_raw != selected_raw:
                raise RuntimeError('native_input_binding_changed_before_worker')
            for role_name, role_pin in roles.items():
                read_pin(role_pin, role=role_name)
            if read_job_identity(HERE, owner_uid) != here_identity:
                raise RuntimeError('native_parent_directory_identity_changed')
            if private_home_snapshot() != home_identity:
                raise RuntimeError('CI_private_directory_changed_before_worker')
            if advice.get('decision') != 'run':
                result['status'] = 'NOT_RUN_RESOURCE_' + str(advice.get('decision', 'invalid')).upper()
                return_code = 75
            else:
                # These final time/STOP gates follow every source/input reread.
                validate_context(
                    latest_context, source_sha256=args.source_sha256, source_bytes=args.source_bytes,
                    static_review_pin=latest_review_pin, job_identity=current_job_identity,
                    inputs_pin=INPUTS, owner_uid=owner_uid, now_epoch=time.time())
                if STOP or (attempt / 'STOP').exists():
                    raise RuntimeError(STOP or 'STOP_before_worker')
                resource_admission['freshness_at_spawn'] = validate_resource_advice_age(
                    checked_at=snapshot['checked_at'], now_epoch=time.time(),
                    sample_started_monotonic=resource_sample_started,
                    now_monotonic=time.monotonic())
                process = subprocess.Popen(argv, cwd=ROOT, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                    'HOME': str(EXPECTED_HOME), 'LANG': 'C', 'LC_ALL': 'C'}, stdin=subprocess.DEVNULL,
                    stdout=out, stderr=err, close_fds=True, start_new_session=True)
                last = time.monotonic()
                result.update(worker_pid=process.pid, worker_pgid=process.pid, status='running')
                write_json(attempt / 'RESOURCE_ADMISSION.json', resource_admission)
                write_json(attempt / 'STARTED.json', result)
                print(json.dumps({'status': 'ROOT_OWNED_NATIVE_RUNTIME_BUILD_STARTED', 'worker_pid': process.pid,
                                  'attempt': str(attempt)}), flush=True)
                while process.poll() is None:
                    current = time.monotonic()
                    if STOP or current - started >= 1800 or (attempt / 'STOP').exists():
                        raise RuntimeError(STOP or 'work_deadline_or_STOP')
                    rows = census(process.pid)
                    current = time.monotonic()
                    total = sum(row['rss_bytes'] for row in rows)
                    result['rss_peak_bytes'] = max(result['rss_peak_bytes'], total)
                    result['max_sample_gap'] = max(result['max_sample_gap'], current - last)
                    result['sample_count'] += 1
                    validate_observation_gap(current - last)
                    last = current
                    if total >= 3.125 * 1024**3:
                        raise RuntimeError('owned_RSS_or_parent_log_limit')
                    validate_parent_log_bytes(out.tell(), err.tell())
                    time.sleep(.25)
                terminal_gap = time.monotonic() - last
                result['max_sample_gap'] = max(result['max_sample_gap'], terminal_gap)
                validate_observation_gap(terminal_gap)
                validate_parent_log_bytes(out.tell(), err.tell())
                result['worker_exit'] = process.returncode
                result['status'] = 'worker_exit0' if process.returncode == 0 else 'worker_failed_retained'
                return_code = 0 if process.returncode == 0 else 1
    except BaseException as error:
        result.update(status='failed_retained_no_retry', error_type=type(error).__name__)
        return_code = 1
    finally:
        try:
            if process is not None:
                prior_status = result['status']
                result['status'] = 'failed_finalization_unverified'
                result.update(finalize_owned(process, attempt, prior_status, time.monotonic() + 20))
                if result['status'] == 'worker_exit0':
                    try:
                        result.update(linked_worker_completion(attempt, process.pid))
                    except BaseException as error:
                        result.update(status='failed_worker_completion_link',
                                      completion_error_type=type(error).__name__)
                        result['finalization_errors'].append(
                            {'stage': 'worker_completion_link', 'type': type(error).__name__})
        finally:
            if resource_admission is not None and not (attempt / 'RESOURCE_ADMISSION.json').exists():
                write_json(attempt / 'RESOURCE_ADMISSION.json', resource_admission)
            result.update(finished_at=now(), elapsed_seconds=time.monotonic() - started,
                          source_or_application_qualification='Fresh native phases only; no runtime seal, offline UI, app/DMG or product pass')
            write_json(attempt / 'PARENT_RESULT.json', result)
            print(json.dumps({'status': result['status'], 'result': str(attempt / 'PARENT_RESULT.json')}), flush=True)
    if process is not None:
        return 0 if (result['status'] == 'worker_exit0' and result['cleanup']['group_absent']
                     and result['cleanup']['worker_reaped']) else 1
    return return_code


if __name__ == '__main__':
    raise SystemExit(main())
