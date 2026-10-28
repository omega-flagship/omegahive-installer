"""Disabled Root parent for one exact public-data fetch OR stage phase.

No target interpreter, package installer, native build or application executes.
Unchanged native-parent ownership/cleanup helpers retain their scoped evidence;
new admission and completion links require independent Source review.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import argparse
import ast
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = None  # exact private bound-controller working directory
SELF = None
PYTHON = '/Users/jon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12'
PYTHON_PIN = {'path': PYTHON, 'bytes': 18058560, 'sha256': 'd90bce0f5ac3aa40e2ee5900ad243bad0b2205ce17408278f088b34aed737840'}
CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = CI_ROOT / 'runtime-job'
WORKER = None
PROTOTYPE = None
CONTRACT = None
REFERENCES = None
RESOURCE = {'path': '/Users/jon/Documents/ChatGPT/Predega/project_graph/resources.py', 'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}
POLICY = {'path': '/Users/jon/Documents/ChatGPT/Predega/project_graph/resource-policy.json', 'bytes': 375, 'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}
PS_PIN = None
PHASE = None
EXPECTED_UID = None
EXPECTED_HOME = None
CURRENT_TASKS = None
LAUNCH_ENABLED = False
ESTIMATE = {'ram_gb': 1.125, 'cpu_cores': 1.25, 'disk_gb': 4, 'kind': 'task'}
WHOLE_SECONDS = 940
WORK_SECONDS = 900
STOP = None
FETCH_PARENT_RESULT = None  # required exact completed predecessor for stage

def now():
    return datetime.now(timezone.utc).isoformat()

def read_pin(pin):
    path = Path(pin['path'])
    for parent in path.parents:
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise RuntimeError('plain_source_ancestry_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != pin['bytes']:
            raise RuntimeError('regular_exact_source_pin_required')
        raw = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            raw.extend(block)
            if len(raw) > pin['bytes']:
                raise RuntimeError('source_grew')
        key = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) != pin['bytes'] or hashlib.sha256(raw).hexdigest() != pin['sha256'] or key(before) != key(os.fstat(fd)) or (key(before) != key(path.lstat())):
            raise RuntimeError('source_pin_changed')
        return bytes(raw)
    finally:
        os.close(fd)

def write_json(path, value):
    with path.open('x') as handle:
        os.chmod(path, 384)
        json.dump(value, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())

def cancelled(number, _frame):
    global STOP
    STOP = 'signal_' + str(number)

def census(group):
    run = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,rss=,stat='], env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, stdin=subprocess.DEVNULL, capture_output=True, timeout=2)
    if run.returncode != 0 or len(run.stdout) > 1024 ** 2 or len(run.stderr) > 4096:
        raise RuntimeError('numeric_census_failed')
    rows, seen = ([], set())
    for line in run.stdout.decode('ascii').splitlines():
        fields = line.split()
        if len(fields) != 4 or any((not value.isdecimal() for value in fields[:3])) or (not re.fullmatch('[A-Za-z+<>=?-]+', fields[3])):
            raise RuntimeError('numeric_census_schema')
        pid, pgid, kib = map(int, fields[:3])
        if pid in seen:
            raise RuntimeError('duplicate_census_PID')
        seen.add(pid)
        if pgid == group or pid == os.getpid():
            rows.append({'pid': pid, 'pgid': pgid, 'rss_bytes': kib * 1024, 'zombie': 'Z' in fields[3]})
    if not any((row['pid'] == os.getpid() and (not row['zombie']) for row in rows)):
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
    for sig in (signal.SIGTERM, signal.SIGKILL):
        rows = remaining()
        exited = process.poll() is not None
        if exited and rows == []:
            break
        if exited and rows is None:
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
            time.sleep(0.1)
    reaped = False
    try:
        process.wait(timeout=max(0.1, limit - time.monotonic()))
        reaped = True
    except subprocess.TimeoutExpired:
        errors.append('worker_wait_timeout')
    rows = remaining()
    return {'signals': actions, 'worker_reaped': reaped, 'remaining_group': rows, 'observation_errors': errors, 'group_absent': rows == []}

def finalize_owned(process, attempt, prior_status, deadline):
    errors = []
    cleanup = {'signals': [], 'worker_reaped': False, 'group_absent': False, 'remaining_group': None, 'observation_errors': []}
    try:
        cleanup = terminate_owned(process, deadline)
    except BaseException as error:
        errors.append({'stage': 'owned_cleanup', 'type': type(error).__name__})
        try:
            if process.poll() is None:
                process.kill()
                cleanup['signals'].append('direct_child_SIGKILL')
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
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
    if time.monotonic() > deadline:
        errors.append({'stage': 'cleanup', 'type': 'deadline_exceeded'})
    clean = cleanup.get('worker_reaped') is True and cleanup.get('group_absent') is True and (cleanup.get('signals') == [])
    status = 'worker_exit0' if prior_status == 'worker_exit0' and clean and (not errors) else prior_status if prior_status != 'worker_exit0' else 'failed_finalization_unverified'
    return {'status': status, 'cleanup': cleanup, 'worker_exit': process.returncode, 'final_log_bytes': sizes, 'finalization_errors': errors}

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
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != EXPECTED_UID or stat.S_IMODE(info.st_mode) != 448:
            raise RuntimeError('owned_private_CI_directory_required')
        validated[name] = key(info)
    descriptors = {}
    try:
        for name, path in (('root', ROOT), ('home', EXPECTED_HOME)):
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors[name] = fd
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != EXPECTED_UID or stat.S_IMODE(info.st_mode) != 448 or (key(info) != validated[name]) or (key(path.lstat()) != validated[name]):
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
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != EXPECTED_UID or (not 0 < before.st_size <= maximum):
            raise RuntimeError('owned_bounded_completion_file_required')
        raw = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            raw.extend(block)
            if len(raw) > maximum:
                raise RuntimeError('completion_file_growth')
        key = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if len(raw) != before.st_size or key(before) != key(os.fstat(fd)) or key(before) != key(path.lstat()):
            raise RuntimeError('completion_file_changed_during_read')
        return (bytes(raw), {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    finally:
        os.close(fd)


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def same(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return set(actual) == set(expected) and all(same(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(same(a, b) for a, b in zip(actual, expected))
    return actual == expected


def pinned(pin, maximum=32 * 1024**2):
    need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
         and type(pin['path']) is str and Path(pin['path']).is_absolute()
         and str(Path(pin['path'])) == pin['path'] and '..' not in Path(pin['path']).parts
         and type(pin['bytes']) is int and 0 < pin['bytes'] <= maximum
         and type(pin['sha256']) is str and re.fullmatch('[a-f0-9]{64}', pin['sha256']),
         'closed_bounded_Source_pin_required')
    return read_pin(pin)


def decode(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'duplicate_JSON_key')
            result[key] = value
        return result
    def bad(_value):
        raise RuntimeError('nonfinite_JSON')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=bad)
    need(type(value) is dict, 'JSON_object_required')
    return value


def directory_identity(path):
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), 'canonical_private_directory_required')
    for parent in path.parents:
        need(stat.S_ISDIR(parent.lstat().st_mode), 'plain_private_ancestry_required')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        key = lambda v: [v.st_dev, v.st_ino, v.st_uid, stat.S_IMODE(v.st_mode)]
        need(stat.S_ISDIR(before.st_mode) and key(before)[2:] == [EXPECTED_UID, 0o700]
             and key(before) == key(path.lstat()), 'stable_owned_private_directory_required')
        return key(before)
    finally:
        os.close(fd)


def reviewed_subjects(parent_pin):
    return {'parent': parent_pin, 'worker': WORKER, 'prototype': PROTOTYPE,
            'contract': CONTRACT, 'reference_files': REFERENCES,
            'phase': PHASE, 'estimate': ESTIMATE}


def source_inputs(parent_pin):
    original, derivative = ast.parse(pinned(PROTOTYPE, 128 * 1024)), ast.parse(pinned(WORKER, 128 * 1024))
    def remaining(tree, enabled):
        values, rest = {}, []
        for node in tree.body:
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id in {'PREPARATION_ENABLED', 'CONTRACT_SHA256'}):
                name = node.targets[0].id
                need(name not in values, 'duplicate_worker_binding')
                values[name] = ast.literal_eval(node.value)
            else:
                rest.append(ast.dump(node))
        need(set(values) == {'PREPARATION_ENABLED', 'CONTRACT_SHA256'}
             and values['PREPARATION_ENABLED'] is enabled
             and values['CONTRACT_SHA256'] == (CONTRACT['sha256'] if enabled else None),
             'exact_worker_enable_and_contract_literals_required')
        return rest
    need(remaining(original, False) == remaining(derivative, True),
         'worker_derivative_changed_outside_two_reviewed_literals')
    need(PROTOTYPE['bytes'] == 29288
         and PROTOTYPE['sha256'] == '511fa3c9a187f5269444f7900c05ca34b28ff668d0ed1bc9ff89f8605e23c322',
         'exact_reviewed_R6_prototype_required')
    need(CONTRACT['path'] == str(CI_ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json')
         and CONTRACT['bytes'] == 63647
         and CONTRACT['sha256'] == '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842',
         'exact_closed_public_contract_required')
    contract = decode(pinned(CONTRACT, 2 * 1024**2))
    need(set(REFERENCES) == set(contract['reference_files']), 'all_ten_reference_roles_required')
    for name, pin in REFERENCES.items():
        row = contract['reference_files'][name]
        need(Path(name).name == name == row['source_relative']
             and pin['path'] == str(CI_ROOT / 'runtime-source/reference' / name)
             and same({k: pin[k] for k in ('bytes', 'sha256')},
                      {k: row[k] for k in ('bytes', 'sha256')}), 'fixed_reference_pin_required')
        pinned(pin, 2 * 1024**2)
    pinned(PYTHON_PIN)
    need(PS_PIN['path'] == '/bin/ps', 'fixed_numeric_ps_required')
    pinned(PS_PIN, 1024**2)
    pinned(RESOURCE, 128 * 1024)
    pinned(POLICY, 65536)
    return contract


def expected_downloads(contract):
    result = {}
    for key in ('archives', 'runtime_wheels', 'build_tools'):
        for row in contract[key].values():
            name = row['filename']
            need(name not in result or same(result[name], row), 'shared_download_role_disagrees')
            result[name] = row
    return list(result.values())


def linked_preparation_completion(contract):
    fetch_raw, fetch_pin = completion_file(JOB / 'FETCH_RECEIPT_R1.json', 2 * 1024**2)
    fetch = decode(fetch_raw)
    rows = [{'filename': row['filename'], 'bytes': row['bytes'], 'sha256': row['sha256']}
            for row in expected_downloads(contract)]
    need(fetch.get('status') == 'ALL_EXACT_PUBLIC_INPUT_PINS_MATCH'
         and fetch.get('contract_sha256') == CONTRACT['sha256'] and same(fetch.get('files'), rows)
         and same(fetch.get('job_identity'), directory_identity(JOB)), 'exact_fetch_receipt_chain_required')
    if PHASE == 'fetch':
        return {'worker_receipt': fetch_pin, 'job_identity': fetch['job_identity'],
                'download_files': len(rows), 'data_preparation_only': True}
    prep_raw, prep_pin = completion_file(JOB / 'CI_PREPARATION_RECEIPT_R1.json', 2 * 1024**2)
    prep = decode(prep_raw)
    need(prep.get('schema') == 'studio-Mac-CI-public-runtime-preparation/2'
         and prep.get('status') == 'DATA_PREPARATION_ONLY_NO_NATIVE_ACTION'
         and prep.get('contract_sha256') == CONTRACT['sha256']
         and same(prep.get('downloads'), expected_downloads(contract))
         and same(prep.get('native_recipe'), contract['native_recipe']), 'exact_stage_receipt_required')
    inventory_raw, inventory_pin = completion_file(JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json', 8 * 1024**2)
    inventory = decode(inventory_raw)
    need(set(inventory) == {'python', 'swipl', 'petta', 'chroma', 'pcre2'}, 'five_prepared_inventory_roles_required')
    bootstrap = dict(contract['bootstrap_python'], path=str(JOB / 'bootstrap/python/bin/python3.12'))
    pinned(bootstrap)
    return {'worker_receipt': prep_pin, 'fetch_receipt': fetch_pin, 'prepared_inventory': inventory_pin,
            'bootstrap_python': bootstrap, 'job_identity': fetch['job_identity'],
            'data_preparation_only': True, 'target_interpreter_executed': False}


def predecessor():
    if PHASE == 'fetch':
        need(FETCH_PARENT_RESULT is None and not os.path.lexists(JOB), 'exclusive_new_fetch_job_required')
        return None
    value = decode(pinned(FETCH_PARENT_RESULT, 2 * 1024**2))
    need(value.get('schema') == 'studio-owned-public-preparation-parent/1'
         and value.get('phase') == 'fetch' and value.get('status') == 'worker_exit0'
         and type(value.get('worker_exit')) is int and value['worker_exit'] == 0
         and value.get('cleanup', {}).get('worker_reaped') is True
         and value.get('cleanup', {}).get('group_absent') is True
         and value.get('cleanup', {}).get('signals') == [] and value.get('finalization_errors') == []
         and value.get('worker_receipt', {}).get('path') == str(JOB / 'FETCH_RECEIPT_R1.json')
         and same(value.get('job_identity'), directory_identity(JOB)), 'clean_owned_fetch_predecessor_required')
    raw, pin = completion_file(JOB / 'FETCH_RECEIPT_R1.json', 2 * 1024**2)
    need(same(pin, value['worker_receipt']), 'actual_fetch_predecessor_receipt_changed')
    need(not os.path.lexists(JOB / 'STAGE_STARTED_R1.json')
         and not os.path.lexists(JOB / 'CI_PREPARATION_RECEIPT_R1.json'), 'stage_never_resumed_or_retried')
    return FETCH_PARENT_RESULT


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--review', required=True)
    parser.add_argument('--review-bytes', required=True, type=int)
    parser.add_argument('--review-sha256', required=True)
    parser.add_argument('--approval', required=True)
    parser.add_argument('--approval-bytes', required=True, type=int)
    parser.add_argument('--approval-sha256', required=True)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--current-tasks-confirmed', action='store_true')
    args = parser.parse_args()
    need(LAUNCH_ENABLED is True and PHASE in {'fetch', 'stage'} and args.run
         and args.current_tasks_confirmed and type(CURRENT_TASKS) is list
         and len(CURRENT_TASKS) <= 8 and ROOT is not None and SELF is not None
         and Path(__file__).absolute() == SELF and Path.cwd() == ROOT
         and sys.executable == PYTHON and sys.platform == 'darwin'
         and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
         and not sys.flags.optimize and type(EXPECTED_UID) is int and EXPECTED_UID > 0
         and os.getuid() == os.geteuid() == EXPECTED_UID
         and os.environ.get('HOME') == str(EXPECTED_HOME)
         and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
         'DISABLED_or_unbound_exact_Root_public_preparation')
    parent_raw, parent_pin = completion_file(SELF, 128 * 1024)
    need(re.fullmatch('[a-f0-9]{64}', args.source_sha256)
         and parent_pin['sha256'] == args.source_sha256, 'exact_actual_parent_Source_required')
    home = private_home_snapshot()
    ci_identity = directory_identity(CI_ROOT)
    contract = source_inputs(parent_pin)
    previous = predecessor()
    review_pin = {'path': args.review, 'bytes': args.review_bytes, 'sha256': args.review_sha256}
    review = decode(pinned(review_pin, 128 * 1024))
    need(review.get('schema') == 'studio-exact-public-preparation-review/1'
         and review.get('verdict') == 'PASS_SOURCE_ONLY' and review.get('blocking_findings') == []
         and same(review.get('subjects'), reviewed_subjects(parent_pin)), 'actual_review_subjects_must_match')
    approval_pin = {'path': args.approval, 'bytes': args.approval_bytes, 'sha256': args.approval_sha256}
    approval = decode(pinned(approval_pin, 65536))
    expected = {'schema': 'studio-one-public-preparation-phase-approval/1',
                'status': 'ROOT_APPROVED_EXACT_PUBLIC_DATA_PHASE', 'phase': PHASE,
                'run_id': approval.get('run_id'), 'source_owner': 'Studio Root', 'origin_machine': 'MacBook',
                'subjects': reviewed_subjects(parent_pin), 'review': review_pin,
                'current_tasks': CURRENT_TASKS, 'ci_root_identity': ci_identity,
                'previous_fetch_parent': previous,
                'previous_outer_terminal': approval.get('previous_outer_terminal'),
                'approved_at': approval.get('approved_at'), 'expires_at': approval.get('expires_at')}
    need(same(approval, expected) and type(approval['run_id']) is str
         and re.fullmatch('[a-f0-9]{32}', approval['run_id']), 'one_exact_operator_approval_required')
    if PHASE == 'fetch':
        need(approval['previous_outer_terminal'] is None, 'new_fetch_has_no_previous_terminal')
    else:
        terminal = approval['previous_outer_terminal']
        need(type(terminal) is dict and set(terminal) == {'session', 'exit', 'chunk'}
             and type(terminal['session']) is int and terminal['session'] > 0
             and type(terminal['exit']) is int and terminal['exit'] == 0
             and type(terminal['chunk']) is str and re.fullmatch('[a-f0-9]{6}', terminal['chunk']),
             'Root_attested_actual_fetch_outer_terminal_required')
    approved = datetime.fromisoformat(approval['approved_at'].replace('Z', '+00:00'))
    expires = datetime.fromisoformat(approval['expires_at'].replace('Z', '+00:00'))
    need(approved.utcoffset() == expires.utcoffset() == timedelta(0)
         and expires - approved == timedelta(seconds=15), 'exact_original_15s_approval_required')
    def fresh():
        need(approved <= datetime.now(timezone.utc) < expires, 'expired_or_future_operator_approval')
    fresh()
    namespace = {'__name__': 'Root_public_preparation_resource', '__file__': RESOURCE['path']}
    exec(compile(pinned(RESOURCE, 128 * 1024), RESOURCE['path'], 'exec'), namespace)
    snapshot = namespace['sample'](force=True)
    disk = os.statvfs(CI_ROOT)
    snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                        'free_bytes': disk.f_bavail * disk.f_frsize}
    advice = namespace['advise'](snapshot, ESTIMATE, CURRENT_TASKS)
    need(advice.get('policy', {}).get('sha256') == POLICY['sha256'], 'actual_used_resource_policy_mismatch')
    attempt = ROOT / ('attempt-' + approval['run_id'])
    attempt.mkdir(mode=0o700)
    write_json(attempt / 'RESOURCE_ADMISSION.json', {'at': snapshot['checked_at'],
               'pressure': snapshot['memory']['pressure'], 'advice': advice,
               'current_tasks': CURRENT_TASKS, 'source_review': review_pin,
               'operator_approval': approval_pin, 'estimate': ESTIMATE})
    if advice['decision'] != 'run':
        print(json.dumps({'status': 'NOT_RUN_RESOURCE_' + advice['decision'].upper(),
                          'attempt': str(attempt), 'retry': False}), flush=True)
        return 75
    fresh()
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    process = None
    result = {'schema': 'studio-owned-public-preparation-parent/1', 'phase': PHASE,
              'source_owner': 'Studio Root', 'origin_machine': 'MacBook', 'status': 'starting',
              'started_at': now(), 'estimate': ESTIMATE, 'parent': parent_pin,
              'worker': WORKER, 'review': review_pin, 'approval': approval_pin,
              'ci_root_identity': ci_identity, 'rss_peak_bytes': 0,
              'worker_rss_peak_bytes': 0, 'parent_rss_peak_bytes': 0, 'sample_count': 0,
              'max_sample_gap': 0, 'native_action': False}
    started = last = time.monotonic()
    argv = [PYTHON, '-I', '-B', '-S', WORKER['path'], PHASE, '--job', str(JOB),
            '--contract', CONTRACT['path'], '--reference', str(CI_ROOT / 'runtime-source/reference')]
    try:
        with (attempt / 'WORKER_STDOUT.log').open('xb') as out, (attempt / 'WORKER_STDERR.log').open('xb') as err:
            source_inputs(parent_pin)
            need(private_home_snapshot() == home and directory_identity(CI_ROOT) == ci_identity,
                 'private_input_directory_changed_before_worker')
            fresh()
            process = subprocess.Popen(argv, cwd=CI_ROOT,
                env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(EXPECTED_HOME),
                     'LANG': 'C', 'LC_ALL': 'C'}, stdin=subprocess.DEVNULL,
                stdout=out, stderr=err, close_fds=True, start_new_session=True)
            result.update(worker_pid=process.pid, worker_pgid=process.pid, status='running')
            write_json(attempt / 'STARTED.json', result)
            print(json.dumps({'status': 'ROOT_PUBLIC_DATA_PREPARATION_STARTED', 'phase': PHASE,
                              'worker_pid': process.pid, 'attempt': str(attempt)}), flush=True)
            while process.poll() is None:
                current = time.monotonic()
                need(not STOP and current - started < WORK_SECONDS and not (attempt / 'STOP').exists(),
                     STOP or 'work_deadline_or_STOP')
                rows = census(process.pid)
                worker_rss = sum(row['rss_bytes'] for row in rows if row['pgid'] == process.pid)
                parent_rss = sum(row['rss_bytes'] for row in rows if row['pid'] == os.getpid())
                total = worker_rss + parent_rss
                result['rss_peak_bytes'] = max(result['rss_peak_bytes'], total)
                result['worker_rss_peak_bytes'] = max(result['worker_rss_peak_bytes'], worker_rss)
                result['parent_rss_peak_bytes'] = max(result['parent_rss_peak_bytes'], parent_rss)
                result['max_sample_gap'] = max(result['max_sample_gap'], current - last)
                result['sample_count'] += 1
                need(current - last <= 2.5, 'resource_observation_gap')
                last = current
                need(worker_rss < 1024**3 and parent_rss < .125 * 1024**3
                     and total < ESTIMATE['ram_gb'] * 1024**3
                     and out.tell() + err.tell() <= 65536, 'owned_RSS_or_log_limit')
                time.sleep(.25)
            need(out.tell() + err.tell() <= 65536, 'terminal_log_limit')
            result.update(worker_exit=process.returncode,
                          status='worker_exit0' if process.returncode == 0 else 'worker_failed_retained')
    except BaseException as error:
        result.update(status='failed_retained_no_retry', error_type=type(error).__name__)
    finally:
        try:
            if process is not None:
                result.update(finalize_owned(process, attempt, result['status'],
                                             min(started + WHOLE_SECONDS, time.monotonic() + 20)))
                if result['status'] == 'worker_exit0':
                    try:
                        source_inputs(parent_pin)
                        need(directory_identity(CI_ROOT) == ci_identity, 'CI_root_changed_during_phase')
                        result.update(linked_preparation_completion(contract))
                    except BaseException as error:
                        result.update(status='failed_completion_link', completion_error=type(error).__name__)
                        result['finalization_errors'].append({'stage': 'completion_link', 'type': type(error).__name__})
        finally:
            result.update(finished_at=now(), elapsed_seconds=time.monotonic() - started,
                          qualification='Exact public data fetch/stage only; no target Python/native/CI/app execution.')
            write_json(attempt / 'PARENT_RESULT.json', result)
            print(json.dumps({'status': result['status'], 'result': str(attempt / 'PARENT_RESULT.json')}), flush=True)
    return 0 if (result['status'] == 'worker_exit0' and result['cleanup']['worker_reaped']
                 and result['cleanup']['group_absent'] and not result['finalization_errors']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
