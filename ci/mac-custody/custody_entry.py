"""Source-plan by default; explicitly bind a reviewed same-job custody worker.

This caller observes current CI facts. It does not manufacture a static review,
restore a runtime, run application commands, or qualify an Assist demo.
"""
from pathlib import Path
from datetime import datetime
import argparse
import hashlib
import json
import math
import os
import re
import resource
import signal
import stat
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
NATIVE = ROOT / 'native-source'
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
PYTHON_PIN = {'bytes': 18652104, 'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
FILES = ('custody_entry.py', 'export_runtime_custody.py',
         'STATIC_CUSTODY_EXPORT_SOURCE_REVIEW.json',
         'STATIC_CUSTODY_ENTRY_SOURCE_REVIEW.json', 'README.md')
STAGE2_MANIFEST = ROOT / 'stage2-source/STAGE2_MANIFEST.sha256'
STAGE2_REVIEW = ROOT / 'stage2-source/STATIC_STAGE2_SOURCE_REVIEW.json'
STAGE2_MANIFEST_PIN = {'bytes': 1162, 'sha256': '366494ecc785188d9bf3005c9630484ac11db0dabec315323e4e9440ed1dc8b7'}
STAGE2_REVIEW_PIN = {'bytes': 3485, 'sha256': 'd66415b6eaf2bed2201c7cecdd6dbbb5e1a34395f746d2a3c1c78f0f9592aed6'}
PHASES = ('finalize', 'native_audit', 'copy', 'relocation', 'seal')
QUALIFICATION = 'CUSTODY_ONLY_NOT_RESTORED_RUNTIME_QUALIFICATION'
ENTRY_SECONDS = 45
ENTRY_RSS_BYTES = 512 * 1024**2
CHUNK = 64 * 1024
STOP = False
DEADLINE = None
WORKER = None


class Refused(RuntimeError):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def tick():
    need(not STOP, 'entry_cancelled')
    if DEADLINE is not None:
        need(time.monotonic() < DEADLINE, 'entry_wall_limit')
        need(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss <= ENTRY_RSS_BYTES,
             'entry_memory_limit')


def cancelled(_number, _frame):
    global STOP
    STOP = True
    if WORKER is not None:
        WORKER['STOP'] = True
    raise Refused('entry_cancelled_or_wall_limit')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                       allow_nan=False, ensure_ascii=True) + '\n').encode('ascii')


def object_bytes(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _value: need(False, 'nonfinite_json'))


def dir_key(info):
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def directory(path):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)),
         'canonical_absolute_path_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            tick()
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_file(path, maximum, expected=None):
    path = Path(path)
    fd_parent = directory(path.parent)
    fd = None
    try:
        parent_key = dir_key(os.fstat(fd_parent))
        before = os.stat(path.name, dir_fd=fd_parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid == os.getuid() and 0 < before.st_size <= maximum,
             'bounded_owned_single_link_regular_input_required')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=fd_parent)
        need(file_key(os.fstat(fd)) == file_key(before), 'input_changed_at_open')
        blocks, count = [], 0
        while True:
            tick()
            block = os.read(fd, min(CHUNK, maximum + 1 - count))
            if not block:
                break
            count += len(block)
            need(count <= maximum, 'input_overflow')
            blocks.append(block)
        need(count == before.st_size and file_key(os.fstat(fd)) == file_key(before)
             and file_key(os.stat(path.name, dir_fd=fd_parent,
                                  follow_symlinks=False)) == file_key(before),
             'input_changed_during_read')
        check_fd = directory(path.parent)
        try:
            need(dir_key(os.fstat(check_fd)) == parent_key, 'input_parent_changed')
        finally:
            os.close(check_fd)
        raw = b''.join(blocks)
        pin = {'path': str(path), 'bytes': count, 'sha256': digest(raw)}
        if expected is not None:
            need(pin['bytes'] == expected['bytes'] and pin['sha256'] == expected['sha256'],
                 'input_pin_mismatch')
        return raw, pin
    finally:
        if fd is not None:
            os.close(fd)
        os.close(fd_parent)


def review(value, schema, subjects):
    need(type(value) is dict and set(value) == {'schema', 'verdict', 'blocking_findings',
         'reviewer', 'source_owner', 'origin_machine', 'subjects', 'scope'}
         and value['schema'] == schema and value['verdict'] == 'PASS_SOURCE_ONLY'
         and value['blocking_findings'] == [] and value['subjects'] == subjects,
         'genuine_exact_independent_source_review_required')
    need(all(type(value[key]) is str and 0 < len(value[key]) <= 4096
             for key in ('reviewer', 'source_owner', 'origin_machine', 'scope')),
         'source_review_attribution_required')


def load_sources(manifest_path, expected_sha):
    need(type(expected_sha) is str and re.fullmatch('[a-f0-9]{64}', expected_sha),
         'external_source_manifest_sha256_required')
    manifest_path = Path(manifest_path)
    need(manifest_path.name == 'MANIFEST.sha256', 'fixed_source_manifest_name_required')
    raw, manifest_pin = read_file(manifest_path, 16 * 1024)
    need(manifest_pin['sha256'] == expected_sha, 'external_source_manifest_mismatch')
    rows = {}
    for line in raw.decode('ascii').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        need(match is not None and match[2] in FILES and match[2] not in rows,
             'closed_auxiliary_source_manifest_required')
        rows[match[2]] = match[1]
    need(set(rows) == set(FILES), 'complete_auxiliary_source_manifest_required')
    payload, pins = {}, {}
    for name in FILES:
        payload[name], pins[name] = read_file(manifest_path.parent / name, 512 * 1024)
        need(pins[name]['sha256'] == rows[name], 'auxiliary_source_hash_mismatch')
    own_raw, own_pin = read_file(Path(__file__).absolute(), 512 * 1024)
    need(own_pin == pins['custody_entry.py'], 'actual_entry_must_be_reviewed_source_subject')
    worker_subject = dict(pins['export_runtime_custody.py'],
                          path=str(NATIVE / 'export_runtime_custody.py'))
    review(object_bytes(payload['STATIC_CUSTODY_EXPORT_SOURCE_REVIEW.json']),
           'studio-Mac-CI-runtime-custody-export-source-review/1',
           {'custody_export': worker_subject})
    subjects = {role: dict(pins[name], path=name) for role, name in
                [('custody_entry', 'custody_entry.py'),
                 ('custody_export', 'export_runtime_custody.py')]}
    review(object_bytes(payload['STATIC_CUSTODY_ENTRY_SOURCE_REVIEW.json']),
           'studio-Mac-CI-runtime-custody-entry-source-review/1', subjects)
    return {'payload': payload, 'pins': pins, 'manifest': manifest_pin}


def task_rows(args):
    if args.current_tasks is None:
        return []  # Explicit dedicated-job completeness attestation, as in Stage2.
    raw, _pin = read_file(Path(args.current_tasks), 256 * 1024)
    value = object_bytes(raw)
    need(type(value) is dict and set(value) == {'schema', 'complete', 'tasks'}
         and value['schema'] == 'studio-Mac-CI-current-tasks-owner-attestation/1'
         and value['complete'] is True and type(value['tasks']) is list
         and len(value['tasks']) <= 256, 'complete_owner_task_attestation_required')
    seen = set()
    for row in value['tasks']:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'}
             and type(row['task_id']) is str and 0 < len(row['task_id']) <= 128
             and row['task_id'] not in seen and row['state'] in {'running', 'reserved'},
             'closed_unique_current_task_required')
        seen.add(row['task_id'])
        need((row['state'] == 'running' and type(row['pid']) is int and row['pid'] > 0)
             or (row['state'] == 'reserved' and row['pid'] is None), 'task_pid_required')
        estimate = row['estimate']
        need(type(estimate) is dict and set(estimate) == {'ram_gb', 'cpu_cores', 'disk_gb'},
             'closed_task_estimate_required')
        need(all(type(amount) in (int, float) and math.isfinite(amount)
                 and 0 <= amount <= 1_000_000 and (key == 'disk_gb' or amount > 0)
                 for key, amount in estimate.items()), 'finite_task_estimate_required')
    return value['tasks']


def write_new(parent_fd, name, raw):
    tick()
    need(type(name) is str and re.fullmatch('[A-Za-z0-9_.-]+', name)
         and 0 < len(raw) <= 512 * 1024, 'bounded_new_control_output_required')
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent_fd)
    try:
        view = memoryview(raw)
        while view:
            tick()
            count = os.write(fd, view[:CHUNK])
            need(count > 0, 'control_write_made_no_progress')
            view = view[count:]
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
             and info.st_uid == os.getuid() and info.st_size == len(raw)
             and file_key(os.stat(name, dir_fd=parent_fd, follow_symlinks=False))
                 == file_key(info), 'new_control_file_identity_changed')
    finally:
        os.close(fd)
    os.fsync(parent_fd)
    tick()
    return {'path': str(NATIVE / name), 'bytes': len(raw), 'sha256': digest(raw)}


def run(args, sources):
    global WORKER
    need(DEADLINE is not None, 'original_caller_clock_required')
    tick()
    need(args.dedicated_ci_job and type(args.owner) is str
         and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', args.owner)
         and os.getuid() == os.geteuid() > 0 and sys.platform == 'darwin'
         and os.uname().machine == 'arm64' and sys.version_info[:2] == (3, 12)
         and sys.executable == str(PYTHON) and sys.flags.isolated
         and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize
         and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('PATH') == SYSTEM_PATH and Path.cwd() == ROOT,
         'explicit_dedicated_same_job_owner_and_isolated_prepared_python_required')
    temp = Path(os.environ.get('RUNNER_TEMP', ''))
    need(temp.is_absolute() and str(temp) == os.path.normpath(str(temp))
         and not temp.is_relative_to(ROOT), 'canonical_separate_RUNNER_TEMP_required')
    uid = os.getuid()
    read_file(PYTHON, 32 * 1024**2, PYTHON_PIN)
    WORKER = {'__name__': 'reviewed_custody_worker_for_entry',
              '__file__': sources['pins']['export_runtime_custody.py']['path']}
    exec(compile(sources['payload']['export_runtime_custody.py'], WORKER['__file__'], 'exec'), WORKER)
    w = WORKER
    w['ACTIVE'].update(started=time.monotonic(), deadline=DEADLINE,
                       rss_limit=ENTRY_RSS_BYTES)
    need(w['ESTIMATE'] == {'ram_gb': 0.625, 'cpu_cores': 1.25, 'disk_gb': 3.125, 'kind': 'task'}
         and w['PHASE_LIMIT_SECONDS'] == 900, 'reviewed_caller_worker_resource_contract_required')
    root_id = w['identity'](ROOT, owner=uid, mode=0o700)
    job_id = w['identity'](JOB, owner=uid, mode=0o700)
    temp_id = w['identity'](temp, owner=uid)
    need(temp_id[3] & 0o022 == 0, 'owned_nongroupwritable_RUNNER_TEMP_required')
    _manifest_raw, manifest_pin = read_file(STAGE2_MANIFEST, 128 * 1024, STAGE2_MANIFEST_PIN)
    _review_raw, stage_review_pin = read_file(STAGE2_REVIEW, 128 * 1024, STAGE2_REVIEW_PIN)
    stage_sources = w['validate_stage2_source'](manifest_pin, stage_review_pin, uid)
    launch_raw, launch_pin = read_file(ROOT / 'stage2-parent/STAGE2_ENTRY_LAUNCH_R1.json', 2 * 1024**2)
    launch = object_bytes(launch_raw)
    need(launch.get('schema') == 'studio-CI-stage2-owner-launch/1', 'actual_stage2_launch_required')
    owner = launch.get('owner', {})
    attempt = owner.get('attempt_id')
    need(type(attempt) is str and re.fullmatch('attempt-[a-f0-9]{32}', attempt)
         and owner.get('execution_owner') == args.owner and owner.get('owner_uid') == uid
         and owner.get('origin_machine') == os.uname().nodename
         and owner.get('dedicated_ci_job') is True
         and owner.get('host', {}).get('root') == root_id
         and owner.get('host', {}).get('job') == job_id, 'same_owner_stage2_launch_identity_required')
    result_path = ROOT / 'stage2-parent' / attempt / 'STAGE2_RESULT.json'
    result_raw, result_pin = read_file(result_path, 2 * 1024**2)
    result = object_bytes(result_raw)
    need(result.get('schema') == 'studio-CI-stage2-entry-result/1'
         and result.get('status') == 'SEALED_RUNTIME_INPUT_PRODUCED'
         and result.get('owner', {}).get('attempt_id') == attempt,
         'successful_same_job_stage2_result_required')
    phase_pins = {}
    for phase in PHASES:
        phase_dir = result_path.parent / phase
        phase_pins[phase] = {role: read_file(phase_dir / name, 1024 * 1024)[1]
            for role, name in [('parent', 'PARENT_RESULT.json'), ('facts', 'PHASE_FACTS.json'),
                               ('context', 'PHASE_CONTEXT.json'), ('resource', 'RESOURCE_ADMISSION.json')]}
    seal_result_pin = read_file(JOB / 'receipts/runtime-seal-result-r1.json', 128 * 1024)[1]
    tasks = task_rows(args)
    guide, policy_pin = w['load_runtime_helpers'](stage_sources)
    os.environ.clear()
    os.environ.update({'PATH': SYSTEM_PATH, 'GITHUB_ACTIONS': 'true',
        'LANG': 'C', 'LC_ALL': 'C', 'HOME': str(ROOT), 'RUNNER_TEMP': str(temp), 'TMPDIR': str(temp)})

    def gate():
        tick()
        started = time.monotonic()
        snapshot = guide['sample'](force=True)
        disk = os.statvfs(temp)
        snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                            'free_bytes': disk.f_bavail * disk.f_frsize}
        advice = guide['advise'](snapshot, w['ESTIMATE'], tasks)
        tick()
        completed = time.monotonic()
        checked = datetime.fromisoformat(snapshot['checked_at'].replace('Z', '+00:00'))
        need(checked.tzinfo is not None and 0 <= time.time() - checked.timestamp() < 15
             and 0 <= completed - started < 15 and advice.get('decision') == 'run'
             and advice.get('estimate') == w['ESTIMATE']
             and advice.get('policy', {}).get('sha256') == policy_pin['sha256'],
             'fresh_pinned_full_export_resource_RUN_required')
        return {'sample': snapshot, 'advice': advice, 'current_tasks': tasks,
                'gate_completed_monotonic': completed, 'sample_checked_epoch': checked.timestamp()}

    initial = gate()
    native_fd = directory(NATIVE)
    try:
        native_id = dir_key(os.fstat(native_fd))
        need(native_id[2:] == [uid, 0o700], 'private_owned_native_source_directory_required')
        worker_pin = write_new(native_fd, 'export_runtime_custody.py',
                               sources['payload']['export_runtime_custody.py'])
        worker_review_pin = write_new(native_fd, 'CUSTODY_EXPORT_SOURCE_REVIEW_R2.json',
                               sources['payload']['STATIC_CUSTODY_EXPORT_SOURCE_REVIEW.json'])
        observed_epoch = int(time.time())
        tasks_pin = write_new(native_fd, 'CUSTODY_EXPORT_CURRENT_TASKS_R1.json', encode({
            'schema': 'studio-Mac-CI-current-tasks-owner-attestation/1', 'complete': True, 'tasks': tasks}))
        context = {'schema': 'studio-Mac-CI-runtime-custody-export-admission/1',
            'status': 'OWNER_ADMITTED_RUNTIME_CUSTODY_EXPORT', 'enabled': True,
            'source_owner': args.owner, 'origin_machine': os.uname().nodename,
            'attempt_id': uuid.uuid4().hex, 'valid_until_epoch': observed_epoch + 900,
            'job_path': str(JOB), 'job_identity': job_id, 'root_identity': root_id,
            'runner_temp_path': str(temp), 'runner_temp_identity': temp_id,
            'source_pin': worker_pin, 'source_review_pin': worker_review_pin,
            'stage2_manifest_pin': manifest_pin, 'stage2_review_pin': stage_review_pin,
            'stage2_result_pin': result_pin, 'phase_closure_pins': phase_pins,
            'seal_result_pin': seal_result_pin, 'task_snapshot_pin': tasks_pin,
            'task_snapshot_observed_epoch': observed_epoch,
            'task_snapshot_valid_until_epoch': observed_epoch + 900,
            'resource_policy_pin': policy_pin, 'estimate': w['ESTIMATE'], 'scope': QUALIFICATION}
        context_pin = write_new(native_fd, 'CUSTODY_EXPORT_ADMISSION_R2.json', encode(context))
        final_admission = gate()
        need(0 <= time.time() - observed_epoch < 15, 'fresh_bound_admission_before_exec_required')
        for path, identity in [(ROOT, root_id), (JOB, job_id), (temp, temp_id), (NATIVE, native_id)]:
            need(w['identity'](path, owner=uid) == identity, 'bound_directory_identity_changed')
        for pin in (worker_pin, worker_review_pin, tasks_pin, context_pin, manifest_pin,
                    stage_review_pin, result_pin, launch_pin, seal_result_pin):
            read_file(Path(pin['path']), max(pin['bytes'], 1), pin)
        write_new(native_fd, 'CUSTODY_ENTRY_LAUNCH_R1.json', encode({
            'schema': 'studio-Mac-CI-custody-entry-launch/1', 'status': 'BINDINGS_CREATED_EXEC_PENDING',
            'source_owner': args.owner, 'origin_machine': os.uname().nodename,
            'manifest': sources['manifest'], 'entry_review': sources['pins']['STATIC_CUSTODY_ENTRY_SOURCE_REVIEW.json'],
            'admission': context_pin, 'stage2_launch': launch_pin,
            'initial_resource': initial, 'final_resource': final_admission,
            'entry_seconds': ENTRY_SECONDS, 'export_seconds': 900,
            'scope': QUALIFICATION}))
    finally:
        os.close(native_fd)
    tick()
    need(0 <= time.time() - observed_epoch < 15
         and 0 <= time.time() - final_admission['sample_checked_epoch'] < 15
         and 0 <= time.monotonic() - final_admission['gate_completed_monotonic'] < 15,
         'fresh_owner_task_and_actual_final_gate_at_exec_required')
    # The wrapper becomes the worker: no untracked application child or parallel allocation.
    signal.alarm(0)
    os.execve(str(PYTHON), [str(PYTHON), '-I', '-B', '-S', str(NATIVE / 'export_runtime_custody.py'),
                          '--run', '--context-sha256', context_pin['sha256']], dict(os.environ))
    raise Refused('execve_returned')


def main(argv=None):
    global DEADLINE
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--source-manifest', required=True)
    parser.add_argument('--expected-manifest-sha256', required=True)
    parser.add_argument('--owner')
    parser.add_argument('--dedicated-ci-job', action='store_true')
    parser.add_argument('--current-tasks')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.run:
            need(DEADLINE is None, 'fresh_caller_process_required')
            DEADLINE = time.monotonic() + ENTRY_SECONDS
            signal.signal(signal.SIGTERM, cancelled)
            signal.signal(signal.SIGINT, cancelled)
            signal.signal(signal.SIGALRM, cancelled)
            signal.alarm(ENTRY_SECONDS)
        sources = load_sources(args.source_manifest, args.expected_manifest_sha256)
        if not args.run:
            print(json.dumps({'status': 'REVIEWED_CUSTODY_SOURCE_PLAN_ONLY',
                'manifest': sources['manifest'], 'worker_started': False,
                'qualification': 'Source integrity and reviews only; no runtime/job read or resource probe.'},
                sort_keys=True), flush=True)
            return 0
        return run(args, sources)
    except BaseException as error:
        print(json.dumps({'status': 'FAILED_RETAINED_NO_AUTOMATIC_RETRY',
            'error_type': type(error).__name__,
            'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
            'scope': 'Any exclusive partial binding files remain; no runtime/app qualification.'},
            sort_keys=True), file=sys.stderr, flush=True)
        return 1
    finally:
        if DEADLINE is not None:
            signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
