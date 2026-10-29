"""Disabled-by-default same-job runtime byte custody export.

This source creates a bounded archive of a sealed runtime and explicitly
allowlisted provenance. It never restores or executes archived bytes and never
qualifies an application, installer, runtime, or deployment.
"""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import io
import json
import math
import os
import re
import resource
import signal
import stat
import sys
import tarfile
import time

ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
BUNDLE = JOB / 'OmegaHive.bundle'
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
PYTHON_PIN = {'bytes': 18652104, 'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
NATIVE = ROOT / 'native-source'
HERE = ROOT / 'stage2-source'
MANIFEST = HERE / 'STAGE2_MANIFEST.sha256'
STAGE2_REVIEW = HERE / 'STATIC_STAGE2_SOURCE_REVIEW.json'
OWNER_CONTEXT = NATIVE / 'CUSTODY_EXPORT_ADMISSION_R2.json'
EXPORT_REVIEW = NATIVE / 'CUSTODY_EXPORT_SOURCE_REVIEW_R2.json'
TASKS = NATIVE / 'CUSTODY_EXPORT_CURRENT_TASKS_R1.json'
RESOURCE_POLICY = ROOT / 'project_graph' / 'resource-policy.json'
RESOURCE_GUIDE = ROOT / 'project_graph' / 'resources.py'
STAGE2_RESULT_PARENT = ROOT / 'stage2-parent'
SOURCE_ROLE = 'custody_export'
SOURCE_PATH = NATIVE / 'export_runtime_custody.py'
SOURCE_REVIEW_SCHEMA = 'studio-Mac-CI-runtime-custody-export-source-review/1'
ADMISSION_SCHEMA = 'studio-Mac-CI-runtime-custody-export-admission/1'
RESULT_LABEL = 'CUSTODY_ONLY_NOT_RESTORED_RUNTIME_QUALIFICATION'
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
STAGE2_ROLES = {
    'audit_runtime': 'stage2-source/audit_runtime.py',
    'finalize_runtime': 'stage2-source/finalize_runtime.py',
    'copy_runtime': 'stage2-source/copy_runtime.py',
    'seal_runtime': 'stage2-source/seal_runtime.py',
    'stage2_entry': 'stage2-source/stage2_entry.py',
    'audit_process_runner': 'stage2-parent/audit_process_runner.py',
    'fresh_runtime_contract': 'stage2-source/fresh_runtime_contract.py',
    'package_inputs': 'stage2-source/package_inputs.py',
    'resource_guide': 'project_graph/resources.py',
    'resource_policy': 'project_graph/resource-policy.json',
}
PHASES = ('finalize', 'native_audit', 'copy', 'relocation', 'seal')
EVIDENCE = ('native_phases', 'native_parent', 'finalization',
            'finalizer_admission', 'native_audit', 'relocation')
COMPONENTS = ('PeTTa', 'lib', 'manifests', 'node', 'petta_lib_chromadb', 'python', 'swipl')
PHASE_LIMIT_SECONDS = 900
MAX_ARCHIVE_BYTES = 3 * 1024**3 + 64 * 1024**2
SIDECAR_RESERVE = 512 * 1024
MAX_RUNTIME_BYTES = 3 * 1024**3
MAX_PROVENANCE_BYTES = 32 * 1024**2
MAX_PROVENANCE_RECORDS = 38
MAX_ENTRIES = 100_000
MAX_JSON_BYTES = 32 * 1024**2
CHUNK = 64 * 1024
LOG_LIMIT = 64 * 1024
ESTIMATE = {'ram_gb': 0.625, 'cpu_cores': 1.25, 'disk_gb': 3.125, 'kind': 'task'}
STOP = False

class Refused(RuntimeError):
    pass


def need(ok, reason):
    if not ok:
        raise Refused(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                        ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def read_small(path, maximum, *, expected=None, owner=None, mode=None):
    """Bounded nofollow read with held-fd, pathname and content identity checks."""
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'canonical_absolute_input_required')
    parent = open_directory_chain(path.parent)
    fd = None
    try:
        parent_before = directory_key(os.fstat(parent))
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and 0 < before.st_size <= maximum, 'owned_regular_input_bound_required')
        if owner is not None:
            need(before.st_uid == owner, 'input_owner_mismatch')
        if mode is not None:
            need(stat.S_IMODE(before.st_mode) == mode, 'input_mode_mismatch')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened = os.fstat(fd)
        need(file_key(opened) == file_key(before), 'input_changed_at_open')
        digest, parts, count = hashlib.sha256(), [], 0
        while True:
            check_tick()
            block = os.read(fd, min(CHUNK, maximum + 1 - count))
            if not block:
                break
            count += len(block)
            need(count <= maximum, 'input_grew_past_bound')
            digest.update(block)
            parts.append(block)
        after = os.fstat(fd)
        pathname = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(count == before.st_size and file_key(after) == file_key(before)
             and file_key(pathname) == file_key(before), 'input_changed_during_read')
        parent_after = open_directory_chain(path.parent)
        try:
            need(directory_key(os.fstat(parent_after)) == parent_before,
                 'input_parent_directory_identity_changed')
        finally:
            os.close(parent_after)
        observed = {'path': str(path), 'bytes': count, 'sha256': digest.hexdigest()}
        if expected is not None:
            need(type(expected) is dict and expected.get('bytes') == count
                 and expected.get('sha256') == digest.hexdigest(), 'input_pin_mismatch')
        return b''.join(parts), observed, before
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inode_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_nlink)


def hardlink_key(info):
    return (info.st_dev, info.st_ino, info.st_uid)


def directory_key(info):
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]


def identity(path, *, owner=None, mode=None):
    fd = open_directory_chain(path)
    try:
        info = os.fstat(fd)
        need(stat.S_ISDIR(info.st_mode) and info.st_nlink >= 1, 'directory_identity_required')
        if owner is not None:
            need(info.st_uid == owner, 'directory_owner_mismatch')
        if mode is not None:
            need(stat.S_IMODE(info.st_mode) == mode, 'directory_mode_mismatch')
        return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]
    finally:
        os.close(fd)


def open_directory_chain(path):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'canonical_directory_path_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            check_tick()
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def check_tick():
    need(not STOP, 'custody_export_cancelled')
    if ACTIVE.get('started') is not None:
        now = time.monotonic()
        need(now < ACTIVE['deadline'], 'custody_export_wall_deadline')
        if ACTIVE.get('admission') is not None:
            need(int(time.time()) < ACTIVE['admission']['valid_until_epoch'],
                 'custody_export_owner_lease_expired')
        if resource.getrusage(resource.RUSAGE_SELF).ru_maxrss > ACTIVE['rss_limit']:
            raise Refused('custody_export_rss_limit')
        if ACTIVE.get('resources') is not None and now - ACTIVE.get('last_resource_check', 0) >= 10:
            refresh_gate()


ACTIVE = {'started': None, 'deadline': None, 'rss_limit': 512 * 1024**2,
          'last_resource_check': 0.0, 'task_rows': None, 'admission': None,
          'resources': None, 'policy_pin': None, 'job_identity': None,
          'attempt_fd': None, 'runtime_fd': None, 'resource_record': None,
          'started_epoch': None, 'output_parent': None, 'planned_archive_bound': 0,
          'partial_archive_path': None, 'output_parent_identity': None,
          'archive_fd': None, 'archive_state': 'not_started'}


def cancelled(_signum, _frame):
    global STOP
    STOP = True


def parse_sha(value):
    need(type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) is not None,
         'lowercase_sha256_required')
    return value


def parse_pin(value, *, expected_path=None, maximum=MAX_JSON_BYTES):
    need(type(value) is dict and set(value) == {'path', 'bytes', 'sha256'}, 'closed_file_pin_required')
    need(type(value['path']) is str and Path(value['path']).is_absolute()
         and str(Path(value['path'])) == os.path.normpath(value['path'])
         and (expected_path is None or value['path'] == str(expected_path)), 'fixed_absolute_pin_path_required')
    need(type(value['bytes']) is int and 0 < value['bytes'] <= maximum, 'bounded_pin_length_required')
    parse_sha(value['sha256'])
    return value


def read_pin(pin, *, maximum=MAX_JSON_BYTES, owner=None, mode=None):
    parse_pin(pin, maximum=maximum)
    raw, observed, _info = read_small(pin['path'], maximum, expected=pin, owner=owner, mode=mode)
    return raw, observed


def json_pin(path, raw, info=None):
    return {'path': str(path), 'bytes': len(raw), 'sha256': sha(raw)}


def load_json_pin(pin, *, maximum=MAX_JSON_BYTES, owner=None, mode=None):
    raw, observed = read_pin(pin, maximum=maximum, owner=owner, mode=mode)
    value = json.loads(raw)
    need(type(value) is dict, 'pinned_json_object_required')
    return value, raw, observed


def validate_stage2_source(manifest_pin, review_pin, owner_uid):
    manifest_raw, manifest_observed = read_pin(manifest_pin, maximum=128 * 1024, owner=owner_uid)
    review_raw, review_observed = read_pin(review_pin, maximum=128 * 1024, owner=owner_uid)
    need(manifest_pin['path'] == str(MANIFEST) and review_pin['path'] == str(STAGE2_REVIEW),
         'fixed_stage2_source_inputs_required')
    need(manifest_raw.endswith(b'\n') and b'\r' not in manifest_raw and b'\x00' not in manifest_raw,
         'canonical_source_manifest_required')
    rows, seen = {}, set()
    for line in manifest_raw.decode('ascii').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
        need(match is not None, 'standard_sha256_manifest_row_required')
        digest, rel = match.groups()
        p = PurePosixPath(rel)
        need(not p.is_absolute() and str(p) == rel and '..' not in p.parts and rel not in seen,
             'safe_unique_source_manifest_path_required')
        seen.add(rel)
        rows[rel] = digest
    need(set(rows) == set(STAGE2_ROLES.values()) | {'STATIC_STAGE2_SOURCE_REVIEW.json', 'README.md'},
         'exact_ten_role_stage2_manifest_required')
    review = json.loads(review_raw)
    need(type(review) is dict and set(review) == {'schema', 'verdict', 'blocking_findings',
         'reviewer', 'source_owner', 'origin_machine', 'subjects', 'scope'}
         and review['schema'] == 'studio-Mac-CI-stage2-static-source-review/1'
         and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == [],
         'independent_stage2_source_review_required')
    need(all(type(review.get(key)) is str and 0 < len(review[key]) <= 4096
             for key in ('reviewer', 'source_owner', 'origin_machine', 'scope')),
         'stage2_source_review_attribution_required')
    need(type(review['subjects']) is dict and set(review['subjects']) == set(STAGE2_ROLES),
         'closed_ten_role_review_subjects_required')
    for role, rel in STAGE2_ROLES.items():
        subject = review['subjects'][role]
        need(type(subject) is dict and set(subject) == {'path', 'bytes', 'sha256'}
             and subject['path'] == rel and subject['sha256'] == rows[rel]
             and type(subject['bytes']) is int and subject['bytes'] > 0,
             'review_subject_manifest_mismatch_' + role)
        raw, pin, _info = read_small(ROOT / rel, 256 * 1024,
            expected={'bytes': subject['bytes'], 'sha256': subject['sha256']}, owner=owner_uid)
        need(b'\x00' not in raw, 'source_payload_nul_refused')
    # README.md is pinned in the source bundle manifest but is not one of the
    # ten operational roles and is not staged into this private runtime tree.
    need(rows['STATIC_STAGE2_SOURCE_REVIEW.json'] == review_observed['sha256'],
         'manifest_must_pin_stage2_review')
    return {'manifest': manifest_observed, 'review_pin': review_observed,
            'manifest_raw_sha256': manifest_observed['sha256'],
            'review_raw_sha256': review_observed['sha256'], 'review': review}


def validate_export_review(review_pin, source_pin, owner_uid):
    raw, observed = read_pin(review_pin, maximum=256 * 1024, owner=owner_uid)
    value = json.loads(raw)
    need(type(value) is dict and set(value) == {'schema', 'verdict', 'blocking_findings',
         'reviewer', 'source_owner', 'origin_machine', 'subjects', 'scope'}
         and value['schema'] == SOURCE_REVIEW_SCHEMA
         and value['verdict'] == 'PASS_SOURCE_ONLY' and value['blocking_findings'] == [],
         'independent_custody_export_source_review_required')
    need(all(type(value.get(key)) is str and 0 < len(value[key]) <= 4096
             for key in ('reviewer', 'source_owner', 'origin_machine', 'scope')),
         'custody_export_review_attribution_required')
    need(type(value['subjects']) is dict and set(value['subjects']) == {SOURCE_ROLE},
         'closed_custody_export_source_review_subject_required')
    subject = value['subjects'][SOURCE_ROLE]
    need(type(subject) is dict and set(subject) == {'path', 'bytes', 'sha256'}
         and subject['path'] == str(SOURCE_PATH)
         and subject['bytes'] == source_pin['bytes'] and subject['sha256'] == source_pin['sha256'],
         'actual_exporter_source_subject_mismatch')
    return value, observed


def load_admission(context_sha, uid):
    expected_sha = parse_sha(context_sha)
    raw, observed, info = read_small(OWNER_CONTEXT, 64 * 1024, owner=uid, mode=0o400)
    need(observed['sha256'] == expected_sha, 'externally_pinned_owner_context_required')
    value = json.loads(raw)
    fields = {'schema', 'status', 'enabled', 'source_owner', 'origin_machine',
        'attempt_id', 'valid_until_epoch', 'job_path', 'job_identity', 'root_identity',
        'runner_temp_path', 'runner_temp_identity', 'source_pin', 'source_review_pin',
        'stage2_manifest_pin', 'stage2_review_pin', 'stage2_result_pin',
        'phase_closure_pins', 'seal_result_pin',
        'task_snapshot_pin', 'task_snapshot_observed_epoch', 'task_snapshot_valid_until_epoch',
        'resource_policy_pin',
        'estimate', 'scope'}
    need(type(value) is dict and set(value) == fields
         and value['schema'] == ADMISSION_SCHEMA
         and value['status'] == 'OWNER_ADMITTED_RUNTIME_CUSTODY_EXPORT'
         and value['enabled'] is True, 'explicit_owner_run_admission_required')
    need(type(value['source_owner']) is str and re.fullmatch(r'[A-Za-z0-9_.:@-]{1,128}', value['source_owner'])
         and type(value['origin_machine']) is str and 1 <= len(value['origin_machine']) <= 128,
         'bounded_execution_attribution_required')
    need(type(value['attempt_id']) is str and re.fullmatch(r'[a-f0-9]{32}', value['attempt_id']),
         'fresh_exact_export_attempt_id_required')
    need(type(value['valid_until_epoch']) is int
         and int(time.time()) < value['valid_until_epoch'] <= int(time.time()) + PHASE_LIMIT_SECONDS,
         'unexpired_owner_run_admission_required')
    need(value['scope'] == RESULT_LABEL, 'custody_only_owner_scope_required')
    need(value['job_path'] == str(JOB) and type(value['job_identity']) is list
         and len(value['job_identity']) == 4 and all(type(x) is int for x in value['job_identity'])
         and value['job_identity'][2:] == [uid, 0o700], 'actual_private_job_identity_required')
    need(type(value['root_identity']) is list and len(value['root_identity']) == 4
         and all(type(x) is int for x in value['root_identity'])
         and value['root_identity'][2:] == [uid, 0o700], 'actual_private_ci_root_identity_required')
    need(type(value['runner_temp_path']) is str and Path(value['runner_temp_path']).is_absolute()
         and str(Path(value['runner_temp_path'])) == os.path.normpath(value['runner_temp_path'])
         and type(value['runner_temp_identity']) is list and len(value['runner_temp_identity']) == 4
         and all(type(x) is int for x in value['runner_temp_identity'])
         and value['runner_temp_identity'][0] >= 0 and value['runner_temp_identity'][1] > 0
         and value['runner_temp_identity'][2] == uid and value['runner_temp_identity'][3] & 0o022 == 0,
         'canonical_owned_nongroupwritable_runner_temp_required')
    need(type(value['task_snapshot_valid_until_epoch']) is int
         and int(time.time()) < value['task_snapshot_valid_until_epoch'] <= value['valid_until_epoch'],
         'current_task_snapshot_owner_lease_required')
    need(value['estimate'] == ESTIMATE, 'fixed_custody_export_resource_estimate_required')
    parse_pin(value['source_pin'], expected_path=SOURCE_PATH, maximum=512 * 1024)
    parse_pin(value['source_review_pin'], expected_path=EXPORT_REVIEW, maximum=256 * 1024)
    parse_pin(value['stage2_manifest_pin'], expected_path=MANIFEST, maximum=128 * 1024)
    parse_pin(value['stage2_review_pin'], expected_path=STAGE2_REVIEW, maximum=128 * 1024)
    parse_pin(value['stage2_result_pin'], maximum=2 * 1024 * 1024)
    parse_pin(value['seal_result_pin'], expected_path=JOB / 'receipts/runtime-seal-result-r1.json',
              maximum=128 * 1024)
    parse_pin(value['task_snapshot_pin'], expected_path=TASKS, maximum=256 * 1024)
    need(value['resource_policy_pin'] == {'path': str(RESOURCE_POLICY), 'bytes': 375,
         'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'},
         'exact_pinned_resource_policy_input_required')
    return value, observed


def load_current_tasks(pin, observed_epoch, uid, *, require_fresh=True):
    parse_pin(pin, expected_path=TASKS, maximum=256 * 1024)
    if require_fresh:
        need(type(observed_epoch) is int and 0 <= time.time() - observed_epoch <= 60,
             'fresh_owner_task_snapshot_required')
    raw, _observed = read_pin(pin, maximum=256 * 1024, owner=uid)
    value = json.loads(raw)
    need(type(value) is dict and set(value) == {'schema', 'complete', 'tasks'}
         and value['schema'] == 'studio-Mac-CI-current-tasks-owner-attestation/1'
         and value['complete'] is True and type(value['tasks']) is list and len(value['tasks']) <= 256,
         'complete_current_task_attestation_required')
    seen = set()
    for row in value['tasks']:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'}
             and type(row['task_id']) is str and 0 < len(row['task_id']) <= 128
             and row['task_id'] not in seen and row['state'] in {'running', 'reserved'},
             'closed_current_task_row_required')
        seen.add(row['task_id'])
        need((row['state'] == 'running' and type(row['pid']) is int and row['pid'] > 0)
             or (row['state'] == 'reserved' and row['pid'] is None), 'current_task_pid_required')
        estimate = row['estimate']
        need(type(estimate) is dict and set(estimate) == {'ram_gb', 'cpu_cores', 'disk_gb'},
             'closed_current_task_estimate_required')
        for key, amount in estimate.items():
            need(type(amount) in (int, float) and math.isfinite(amount)
                 and 0 <= amount <= 1_000_000 and (key == 'disk_gb' or amount > 0),
                 'finite_current_task_peak_required')
    return value['tasks']


def load_runtime_helpers(stage2):
    guide_raw, _gpin, _ = read_small(RESOURCE_GUIDE, 256 * 1024,
        expected={'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'},
        owner=os.getuid())
    policy_raw, _ppin, _ = read_small(RESOURCE_POLICY, 64 * 1024,
        expected={'bytes': 375, 'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'},
        owner=os.getuid())
    need(stage2['review']['subjects']['resource_guide']['sha256'] == sha(guide_raw)
         and stage2['review']['subjects']['resource_policy']['sha256'] == sha(policy_raw),
         'reviewed_resource_helper_and_policy_required')
    namespace = {'__name__': 'pinned_resource_guide', '__file__': str(RESOURCE_GUIDE)}
    exec(compile(guide_raw, str(RESOURCE_GUIDE), 'exec'), namespace)
    return namespace, {'path': str(RESOURCE_POLICY), 'bytes': len(policy_raw), 'sha256': sha(policy_raw)}


def refresh_gate():
    check_tick_no_refresh()
    ACTIVE['last_resource_check'] = time.monotonic()
    tasks = load_current_tasks(ACTIVE['admission']['task_snapshot_pin'],
                               ACTIVE['admission']['task_snapshot_observed_epoch'], os.getuid(),
                               require_fresh=ACTIVE['task_rows'] is None)
    need(tasks == ACTIVE['task_rows'], 'current_task_snapshot_changed_during_export')
    need(int(time.time()) < ACTIVE['admission']['task_snapshot_valid_until_epoch'],
         'current_task_snapshot_lease_expired')
    need(identity(JOB, owner=os.getuid(), mode=0o700) == ACTIVE['admission']['job_identity'],
         'runtime_job_identity_changed_during_export')
    need(identity(ACTIVE['output_parent'], owner=os.getuid())
         == ACTIVE['output_parent_identity'], 'custody_output_directory_identity_changed')
    guide = ACTIVE['resources']
    started = time.monotonic()
    snapshot = guide['sample'](force=True)
    disk = os.statvfs(ACTIVE['output_parent'])
    snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                        'free_bytes': disk.f_bavail * disk.f_frsize}
    estimate = dict(ESTIMATE)
    if ACTIVE.get('planned_archive_bound'):
        used = 0
        archive_fd = ACTIVE.get('archive_fd')
        if type(archive_fd) is int:
            used = os.fstat(archive_fd).st_size
        estimate['disk_gb'] = max(0.0,
            (ACTIVE['planned_archive_bound'] - used) / (1024**3))
    advice = guide['advise'](snapshot, estimate, tasks)
    elapsed = time.monotonic() - started
    need(elapsed < 15 and advice.get('policy', {}).get('sha256') == ACTIVE['policy_pin']['sha256'],
         'fresh_pinned_resource_policy_required')
    need(advice.get('decision') == 'run' and advice.get('estimate') == estimate,
         'fresh_resource_RUN_required')
    ACTIVE['last_resource_check'] = time.monotonic()
    ACTIVE['resource_record'] = {'at': snapshot.get('checked_at'), 'advice': advice,
        'estimate': estimate, 'max_estimate': ESTIMATE,
        'task_snapshot_sha256': ACTIVE['admission']['task_snapshot_pin']['sha256'],
        'policy_sha256': ACTIVE['policy_pin']['sha256']}


def check_tick_no_refresh():
    need(not STOP and ACTIVE['started'] is not None and time.monotonic() < ACTIVE['deadline'],
         'custody_export_cancel_or_deadline')
    if resource.getrusage(resource.RUSAGE_SELF).ru_maxrss > ACTIVE['rss_limit']:
        raise Refused('custody_export_rss_limit')


def validate_phase_parent(path, phase, expected_pin=None, owner_uid=None,
                          expected_owner=None, manifest_sha256=None,
                          expected_job_identity=None, expected_root_identity=None):
    raw, observed, _info = read_small(path, 1024 * 1024, expected=expected_pin, owner=owner_uid)
    value = json.loads(raw)
    need(type(value) is dict and value.get('schema') == 'studio-CI-stage2-owned-phase-parent/1'
         and value.get('phase') == phase and value.get('status') == 'worker_exit0'
         and type(value.get('worker_exit')) is int and value.get('worker_exit') == 0
         and value.get('worker_reaped') is True
         and type(value.get('worker_pid')) is int and value['worker_pid'] > 0
         and value.get('worker_pgid') == value['worker_pid']
         and value.get('group_absent') is True and value.get('signals') == []
         and value.get('guard_error') is None and value.get('cleanup_error_type') is None
         and value.get('allocation_released') is True, 'clean_stage2_phase_parent_required_' + phase)
    logs = value.get('logs')
    need(type(logs) is dict and set(logs) == {'STDOUT.log', 'STDERR.log'},
         'closed_phase_log_metadata_required')
    total = 0
    for log in logs.values():
        need(type(log) is dict and type(log.get('bytes_observed')) is int
             and 0 <= log['bytes_observed'] <= LOG_LIMIT
             and log.get('stable_during_read') is True, 'bounded_stable_phase_log_metadata_required')
        total += log['bytes_observed']
    need(total <= LOG_LIMIT, 'aggregate_phase_log_limit')
    context_pin = value.get('context')
    context_path = path.parent / 'PHASE_CONTEXT.json'
    parse_pin(context_pin, expected_path=context_path, maximum=1024 * 1024)
    context_value, _context_raw, _context_observed = load_json_pin(
        context_pin, maximum=1024 * 1024, owner=owner_uid)
    need(type(context_value) is dict and context_value.get('schema') == 'studio-CI-stage2-owned-phase-context/1'
         and context_value.get('phase') == phase
         and context_value.get('owner', {}).get('attempt_id') == expected_owner['attempt_id']
         and context_value.get('owner', {}).get('execution_owner') == expected_owner['execution_owner']
         and context_value.get('owner', {}).get('origin_machine') == expected_owner['origin_machine']
         and context_value.get('owner', {}).get('owner_uid') == owner_uid
         and context_value.get('owner', {}).get('host', {}).get('job') == expected_job_identity
         and context_value.get('owner', {}).get('host', {}).get('root') == expected_root_identity
         and context_value.get('sources_manifest', {}).get('sha256') == manifest_sha256,
         'phase_parent_current_stage2_context_required_' + phase)
    resource_path = path.parent / 'RESOURCE_ADMISSION.json'
    resource_raw, resource_observed, _resource_info = read_small(resource_path, 1024 * 1024,
        owner=owner_uid)
    resource_value = json.loads(resource_raw)
    need(resource_value == context_value.get('resource')
         and resource_value.get('advice', {}).get('decision') == 'run'
         and resource_value.get('advice', {}).get('policy', {}).get('sha256')
             == '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f',
         'phase_fresh_resource_admission_link_required_' + phase)
    return value, observed, context_pin, resource_observed, context_value


def validate_stage2_result(pin, owner_uid, admission):
    parse_pin(pin, maximum=2 * 1024 * 1024)
    raw, observed, _info = read_small(pin['path'], 2 * 1024 * 1024,
        expected=pin, owner=owner_uid)
    result = json.loads(raw)
    need(result.get('schema') == 'studio-CI-stage2-entry-result/1'
         and result.get('status') == 'SEALED_RUNTIME_INPUT_PRODUCED'
         and result.get('qualification') == 'Same-job native/relocation-audited sealed runtime input only; UI/app/DMG/demo/deployment remain separate.',
         'clean_stage2_terminal_result_required')
    owner = result.get('owner')
    need(type(owner) is dict and owner.get('execution_owner') == admission['source_owner']
         and owner.get('origin_machine') == admission['origin_machine']
         and owner.get('owner_uid') == os.getuid() and owner.get('dedicated_ci_job') is True,
         'stage2_owner_context_mismatch')
    need(type(owner.get('host')) is dict and owner['host'].get('root') == admission['root_identity']
         and owner['host'].get('job') == admission['job_identity'],
         'stage2_result_current_job_identity_mismatch')
    attempt_id = owner.get('attempt_id')
    need(type(attempt_id) is str and re.fullmatch(r'attempt-[a-f0-9]{32}', attempt_id),
         'actual_stage2_attempt_required')
    need(pin['path'] == str(STAGE2_RESULT_PARENT / attempt_id / 'STAGE2_RESULT.json'),
         'fixed_stage2_result_attempt_path_required')
    phase_results = result.get('phase_results')
    need(type(phase_results) is dict and set(phase_results) == set(PHASES),
         'five_completed_stage2_phases_required')
    phases, phase_pins = {}, {}
    expected_closures = admission['phase_closure_pins']
    need(type(expected_closures) is dict and set(expected_closures) == set(PHASES),
         'closed_five_phase_closure_pin_map_required')
    for phase in PHASES:
        path = STAGE2_RESULT_PARENT / attempt_id / phase / 'PARENT_RESULT.json'
        pins = expected_closures[phase]
        need(type(pins) is dict and set(pins) == {'parent', 'facts', 'context', 'resource'},
             'closed_phase_result_and_facts_pins_required')
        parse_pin(pins['parent'], expected_path=path, maximum=1024 * 1024)
        parse_pin(pins['facts'], expected_path=path.parent / 'PHASE_FACTS.json', maximum=1024 * 1024)
        parse_pin(pins['context'], expected_path=path.parent / 'PHASE_CONTEXT.json', maximum=1024 * 1024)
        parse_pin(pins['resource'], expected_path=path.parent / 'RESOURCE_ADMISSION.json', maximum=1024 * 1024)
        phase_value, phase_pin, context_pin, resource_pin, phase_context = validate_phase_parent(
            path, phase, pins['parent'], os.getuid(), owner,
            admission['stage2_manifest_pin']['sha256'], admission['job_identity'],
            admission['root_identity'])
        need(context_pin == pins['context'] and resource_pin == pins['resource'],
             'owner_phase_context_resource_pins_changed_' + phase)
        facts_path = path.parent / 'PHASE_FACTS.json'
        facts_raw, facts_pin, _ = read_small(facts_path, 1024 * 1024,
            expected=pins['facts'], owner=os.getuid())
        facts = json.loads(facts_raw)
        need(type(facts) is dict and facts == phase_results[phase], 'stage2_phase_facts_link_required_' + phase)
        phases[phase] = {'parent': phase_value, 'facts': facts,
                         'parent_pin': phase_pin, 'facts_pin': facts_pin,
                         'context': phase_context}
        phase_pins[phase] = {'parent': phase_pin, 'facts': facts_pin,
                             'context': context_pin, 'resource': resource_pin}
    evidence = phase_results['finalize']['prerequisites']
    need(type(evidence) is dict and set(evidence) == {'finalization', 'finalizer_admission',
         'native_phases', 'native_parent'}, 'finalizer_phase_evidence_closure_required')
    need(phase_results['native_audit'].get('audit_receipt') is not None
         and phase_results['relocation'].get('audit_receipt') is not None,
         'native_and_relocation_phase_receipts_required')
    seal_pin = phase_results['seal'].get('sealed_runtime_input')
    parse_pin(seal_pin, expected_path=JOB / 'receipts/sealed-runtime-input-r1.json')
    return result, phases, phase_pins, evidence, seal_pin, observed


def valid_closure(value):
    return (value.get('worker_reaped') is True and value.get('group_absent') is True
            and value.get('signals') == [] and value.get('guard_error') is None
            and value.get('cleanup_error_type') is None and value.get('allocation_released') is True)


def build_provenance(stage2, phases, phase_pins, evidence, stage2_result_pin,
                     seal_manifest_pin, seal_result_pin, seal_inputs_pin,
                     seal_admission_pin, source_inputs, supporting_items):
    items = []
    def add(logical, pin, maximum=MAX_JSON_BYTES):
        parse_pin(pin, maximum=maximum)
        need(pin['path'] not in {row['pin']['path'] for row in items}, 'duplicate_provenance_path')
        need(len(items) < MAX_PROVENANCE_RECORDS, 'provenance_record_count_bound')
        items.append({'name': logical, 'pin': pin, 'maximum': maximum})
    add('provenance/stage2/STAGE2_MANIFEST.sha256', source_inputs['manifest_pin'], 128 * 1024)
    add('provenance/stage2/STATIC_STAGE2_SOURCE_REVIEW.json', source_inputs['review_pin'], 128 * 1024)
    add('provenance/exporter/export_runtime_custody.py', source_inputs['source_pin'], 512 * 1024)
    add('provenance/exporter/CUSTODY_EXPORT_SOURCE_REVIEW_R2.json', source_inputs['export_review_pin'], 256 * 1024)
    add('provenance/stage2/STAGE2_RESULT.json', stage2_result_pin, 2 * 1024 * 1024)
    add('provenance/seal/sealed-runtime-input-r1.json', seal_manifest_pin, MAX_JSON_BYTES)
    add('provenance/seal/runtime-seal-result-r1.json', seal_result_pin, 128 * 1024)
    add('provenance/seal/SEAL_INPUTS_R1.json', seal_inputs_pin, 1024 * 1024)
    add('provenance/seal/runtime-seal-admission-r1.json', seal_admission_pin, 64 * 1024)
    for phase in PHASES:
        add('provenance/phases/' + phase + '/PARENT_RESULT.json', phase_pins[phase]['parent'], 1024 * 1024)
        add('provenance/phases/' + phase + '/PHASE_FACTS.json', phase_pins[phase]['facts'], 1024 * 1024)
        add('provenance/phases/' + phase + '/PHASE_CONTEXT.json', phase_pins[phase]['context'], 1024 * 1024)
        add('provenance/phases/' + phase + '/RESOURCE_ADMISSION.json', phase_pins[phase]['resource'], 1024 * 1024)
    for role in EVIDENCE:
        add('provenance/runtime-evidence/' + role + '.json', evidence[role], MAX_JSON_BYTES)
    for item in supporting_items:
        add(item['name'], item['pin'], item['maximum'])
    total = sum(row['pin']['bytes'] for row in items)
    need(total <= MAX_PROVENANCE_BYTES, 'aggregate_provenance_byte_limit')
    return items


def validate_supporting_provenance(admission, stage2_result, phases, seal_manifest, owner_uid):
    """Read and bind the runner-closure and copy-facts records referenced by Stage2."""
    supporting = []
    attempt_id = stage2_result['owner']['attempt_id']
    for phase, role, filename, schema, status in (
            ('native_audit', 'native_audit', 'runtime-native-audit-r1.json',
             'studio-Mac-CI-native-audit/1', 'NATIVE_RUNTIME_CHECKS_PASS'),
            ('relocation', 'relocation', 'runtime-relocation-r1.json',
             'studio-Mac-CI-runtime-relocation/1', 'RELOCATED_RUNTIME_CHECKS_PASS')):
        receipt_path = JOB / 'receipts' / filename
        receipt_pin = seal_manifest['evidence'][role]
        parse_pin(receipt_pin, expected_path=receipt_path, maximum=MAX_JSON_BYTES)
        receipt_raw, receipt_observed, _ = read_small(receipt_path, MAX_JSON_BYTES,
            expected=receipt_pin, owner=owner_uid)
        receipt = json.loads(receipt_raw)
        need(type(receipt) is dict and receipt.get('schema') == schema
             and receipt.get('status') == status,
             'actual_' + phase + '_receipt_required')
        closure_path = STAGE2_RESULT_PARENT / attempt_id / phase / 'RUNNER_CLOSED.json'
        closure_pin = receipt.get('runner_closure_pin')
        parse_pin(closure_pin, expected_path=closure_path, maximum=8 * 1024**2)
        closure_raw, closure_observed, _ = read_small(closure_path, 8 * 1024**2,
            expected=closure_pin, owner=owner_uid)
        closure = json.loads(closure_raw)
        closure_fields = {'schema', 'status', 'audit_kind', 'phase_worker',
            'phase_worker_birth', 'supervisor_pid', 'runner_pin', 'owner_admission_pin',
            'ownership_evidence_pins', 'whole_attempt_started_monotonic',
            'whole_attempt_deadline', 'finished_at_monotonic', 'elapsed_seconds',
            'command_count', 'aggregate_output_bytes', 'combined_rss_peak_bytes',
            'sample_count', 'max_sample_gap', 'registered_groups', 'guard_errors',
            'qualification'}
        need(type(closure) is dict and set(closure) == closure_fields
             and closure.get('schema') == 'studio-audit-runner-closure/1'
             and closure.get('status') == 'CLOSED_OWNED_GROUPS_ABSENT'
             and closure.get('audit_kind') == phase
             and closure.get('qualification') == 'Owned command runner closure only; no native audit/product pass'
             and closure.get('guard_errors') == [],
             'closed_actual_' + phase + '_runner_record_required')
        worker = closure['phase_worker']
        context = phases[phase]['context']
        parent = phases[phase]['parent']
        start = context.get('phase_started_monotonic')
        deadline = context.get('phase_deadline')
        runner_deadline = closure.get('whole_attempt_deadline')
        finished = closure.get('finished_at_monotonic')
        elapsed = closure.get('elapsed_seconds')
        need(type(worker) is dict and set(worker) == {'pid', 'pgid', 'sid'}
             and type(worker['pid']) is int and worker['pid'] > 0
             and worker['pid'] == worker['pgid'] == worker['sid'] == parent.get('worker_pid')
             and type(closure['supervisor_pid']) is int
             and closure['supervisor_pid'] == context.get('parent_pid')
             and type(start) in (int, float) and type(deadline) in (int, float)
             and closure.get('whole_attempt_started_monotonic') == start
             and type(runner_deadline) in (int, float)
             and runner_deadline == start + 1800
             and start < deadline <= runner_deadline
             and deadline - start >= 1799
             and type(finished) in (int, float) and start < finished < deadline
             and type(elapsed) in (int, float) and 0 < elapsed <= 1800
             and abs(elapsed - (finished - start)) <= .25,
             'actual_' + phase + '_runner_timing_and_process_link_required')
        birth = closure.get('phase_worker_birth')
        need(type(birth) is dict and set(birth) == {'pid', 'start_tvsec', 'start_tvusec'}
             and all(type(value) is int for value in birth.values())
             and birth['pid'] == worker['pid'] and birth['start_tvsec'] > 0
             and 0 <= birth['start_tvusec'] < 1_000_000,
             'actual_' + phase + '_runner_worker_birth_required')
        groups = closure['registered_groups']
        need(type(groups) is list and 0 < len(groups) <= 8202
             and type(closure['command_count']) is int
             and type(receipt.get('command_count')) is int and receipt['command_count'] > 0
             and closure['command_count'] == len(groups) == receipt['command_count']
             and type(closure['aggregate_output_bytes']) is int
             and 0 <= closure['aggregate_output_bytes'] <= 64 * 1024**2
             and type(closure['combined_rss_peak_bytes']) is int
             and 0 < closure['combined_rss_peak_bytes'] <= 3 * 1024**3
             and type(closure['sample_count']) is int and closure['sample_count'] > 0
             and type(closure['max_sample_gap']) in (int, float)
             and 0 <= closure['max_sample_gap'] <= 2.5,
             'bounded_actual_' + phase + '_runner_summary_required')
        for row in groups:
            need(type(row) is dict and set(row) == {'pid', 'pgid', 'sid', 'birth',
                 'worker_reaped', 'group_absent', 'signals', 'guard_error'}
                 and type(row['pid']) is int and row['pid'] > 0
                 and row['pid'] == row['pgid'] == row['sid']
                 and row['worker_reaped'] is True and row['group_absent'] is True
                 and row['signals'] == [] and row['guard_error'] is None,
                 'closed_actual_' + phase + '_runner_group_required')
            birth = row['birth']
            need(type(birth) is dict and set(birth) == {'pid', 'start_tvsec', 'start_tvusec'}
                 and all(type(value) is int for value in birth.values())
                 and birth['pid'] == row['pid'] and birth['start_tvsec'] > 0
                 and 0 <= birth['start_tvusec'] < 1_000_000,
                 'actual_' + phase + '_runner_birth_required')
        supporting.append({'name': 'provenance/runner/' + phase + '/RUNNER_CLOSED.json',
                           'pin': closure_observed, 'maximum': 8 * 1024**2})

    copy_path = JOB / 'receipts/runtime-copy-facts-r1.json'
    copy_raw, copy_pin, _ = read_small(copy_path, MAX_JSON_BYTES, owner=owner_uid)
    copy_facts = json.loads(copy_raw)
    expected_copy = phases['copy']['facts'].get('copy')
    relocation_attempt = stage2_result['owner'].get('relocation_attempt')
    need(type(relocation_attempt) is str and re.fullmatch(r'[a-f0-9]{32}', relocation_attempt),
         'actual_copy_attempt_identity_required')
    need(type(copy_facts) is dict and set(copy_facts) == {'status', 'source_root',
         'relocated_bundle_root', 'fresh_output_created', 'job_identity', 'target_identity',
         'content_inventory_sha256', 'entries', 'native_commands_run', 'scope'}
         and copy_facts == expected_copy
         and copy_facts['status'] == 'CLOSED_RUNTIME_DATA_COPY_ONLY'
         and copy_facts['source_root'] == str(BUNDLE)
         and copy_facts['relocated_bundle_root'] == str(ROOT / 'runtime-relocation-attempts'
             / ('attempt-' + relocation_attempt) / 'OmegaHive.bundle')
         and copy_facts['fresh_output_created'] is True
         and copy_facts['job_identity'] == admission['job_identity']
         and type(copy_facts['target_identity']) is list and len(copy_facts['target_identity']) == 4
         and all(type(value) is int for value in copy_facts['target_identity'])
         and copy_facts['target_identity'][2:] == [owner_uid, 0o700]
         and type(copy_facts['content_inventory_sha256']) is str
         and re.fullmatch(r'[a-f0-9]{64}', copy_facts['content_inventory_sha256'])
         and copy_facts['content_inventory_sha256'] == seal_manifest.get('content_inventory_sha256')
         and type(copy_facts['entries']) is int and 7 <= copy_facts['entries'] <= MAX_ENTRIES
         and copy_facts['native_commands_run'] is False
         and copy_facts['scope'] == 'Declared bytes, links and modes only; relocation audit/receipt and native qualification absent.',
         'actual_phase_bound_runtime_copy_facts_required')
    supporting.append({'name': 'provenance/copy/runtime-copy-facts-r1.json',
                       'pin': copy_pin, 'maximum': MAX_JSON_BYTES})
    return supporting


def validate_inventory(manifest):
    files = manifest.get('files')
    need(type(files) is list and 0 < len(files) <= MAX_ENTRIES,
         'sealed_runtime_closed_inventory_required')
    by_path, children, total = {}, {'': set()}, 0
    for row in files:
        need(type(row) is dict and type(row.get('path')) is str, 'closed_inventory_row_required')
        rel = row['path']
        pure = PurePosixPath(rel)
        need(0 < len(rel.encode('utf-8')) <= 1024
             and not pure.is_absolute() and str(pure) == rel and '..' not in pure.parts
             and '\\' not in rel and not any(ord(c) < 32 or ord(c) == 127 for c in rel),
             'canonical_runtime_relative_path_required')
        need(rel not in by_path and pure.parts[0] in COMPONENTS, 'unique_runtime_component_path_required')
        kind = row.get('kind')
        need(kind in {'directory', 'file', 'symlink'}, 'runtime_entry_kind_required')
        need(type(row.get('mode')) is str and re.fullmatch(r'[0-7]{4}', row['mode']) is not None,
             'runtime_entry_mode_required')
        by_path[rel] = row
        for index, part in enumerate(pure.parts):
            parent = '/'.join(pure.parts[:index])
            children.setdefault(parent, set()).add(part)
        if kind == 'file':
            need(type(row.get('bytes')) is int and 0 <= row['bytes'] <= 1024**3
                 and type(row.get('sha256')) is str and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
                 and row.get('mode') in {'0400', '0500'}, 'runtime_file_pin_mode_required')
            total += row['bytes']
            need(total <= MAX_RUNTIME_BYTES, 'runtime_total_bytes_exceeded')
        elif kind == 'directory':
            need(row.get('mode') == '0500', 'sealed_runtime_directory_mode_required')
        else:
            target = row.get('target')
            need(type(target) is str and 0 < len(target) <= 4096 and not target.startswith('/')
                 and '\\' not in target and '\x00' not in target
                 and not any(ord(c) < 32 or ord(c) == 127 for c in target),
                 'relative_runtime_symlink_required')
    need({pure.parts[0] for pure in (PurePosixPath(path) for path in by_path)} == set(COMPONENTS)
         and all(by_path.get(name, {}).get('kind') == 'directory' for name in COMPONENTS),
         'exact_seven_runtime_components_required')
    for rel, row in by_path.items():
        parent = str(PurePosixPath(rel).parent)
        if parent != '.':
            need(by_path.get(parent, {}).get('kind') == 'directory', 'declared_runtime_parent_required')
        if row['kind'] == 'directory':
            children.setdefault(rel, set())
    return by_path, children, total


def resolve_link(rel, target, by_path):
    pending = list(PurePosixPath(rel).parts[:-1]) + target.split('/')
    resolved, hops = [], 0
    while pending:
        part = pending.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            need(bool(resolved), 'runtime_symlink_escapes_bundle')
            resolved.pop()
            continue
        resolved.append(part)
        row = by_path.get('/'.join(resolved))
        need(row is not None, 'runtime_symlink_target_outside_inventory')
        if row['kind'] == 'symlink':
            hops += 1
            need(hops <= 64, 'runtime_symlink_hop_bound')
            resolved.pop()
            pending = row['target'].split('/') + pending
        elif pending:
            need(row['kind'] == 'directory', 'runtime_symlink_crosses_regular_file')
    need(bool(resolved) and resolved[0] in COMPONENTS, 'runtime_symlink_component_escape')
    return '/'.join(resolved)


def check_closed_dirs(by_path, children, root_fd, root_info):
    root_names = set(os.listdir(root_fd))
    need(root_names == children[''], 'runtime_root_has_unlisted_entries')
    for rel, row in by_path.items():
        check_tick()
        parent_fd, leaf = open_parent_fd(root_fd, rel)
        try:
            before = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            need(row.get('mode') == format(stat.S_IMODE(before.st_mode), '04o'),
                 'runtime_entry_mode_changed')
            if row['kind'] == 'directory':
                need(stat.S_ISDIR(before.st_mode), 'runtime_directory_type_changed')
                fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                try:
                    held = os.fstat(fd)
                    need(file_key(held) == file_key(before) and set(os.listdir(fd)) == children[rel],
                         'runtime_directory_child_closure_changed')
                    if row.get('_identity') is None:
                        row['_identity'] = file_key(held)
                    else:
                        need(row['_identity'] == file_key(held), 'runtime_directory_identity_changed')
                finally:
                    os.close(fd)
            elif row['kind'] == 'file':
                need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                     and before.st_size == row['bytes'], 'runtime_regular_file_identity_required')
                old = row.get('_identity')
                if old is None:
                    row['_identity'] = file_key(before)
                else:
                    need(old == file_key(before), 'runtime_regular_file_identity_changed')
            else:
                need(stat.S_ISLNK(before.st_mode), 'runtime_symlink_kind_changed')
                target = os.readlink(leaf, dir_fd=parent_fd)
                need(target == row['target'], 'runtime_symlink_target_changed')
                resolve_link(rel, target, by_path)
                old = row.get('_identity')
                if old is None:
                    row['_identity'] = file_key(before)
                else:
                    need(old == file_key(before), 'runtime_symlink_identity_changed')
        finally:
            os.close(parent_fd)
    need(file_key(os.fstat(root_fd)) == file_key(root_info)
         and set(os.listdir(root_fd)) == children[''], 'runtime_root_identity_changed')


def open_parent_fd(root_fd, rel):
    parts = PurePosixPath(rel).parts
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


class PinnedInput:
    def __init__(self, fd, size, expected_sha, before, parent_fd, leaf, path):
        self.fd = fd
        self.size = size
        self.expected_sha = expected_sha
        self.before = before
        self.parent_fd = parent_fd
        self.leaf = leaf
        self.path = path
        self.count = 0
        self.digest = hashlib.sha256()

    def read(self, requested=-1):
        check_tick()
        left = self.size - self.count
        if left <= 0:
            return b''
        block = os.read(self.fd, min(CHUNK, left, requested if requested >= 0 else CHUNK))
        self.count += len(block)
        need(len(block) > 0 and self.count <= self.size, 'runtime_file_short_read')
        self.digest.update(block)
        return block

    def finish(self):
        need(self.count == self.size and self.digest.hexdigest() == self.expected_sha,
             'runtime_file_content_pin_mismatch')
        after_fd = os.fstat(self.fd)
        after_path = os.stat(self.leaf, dir_fd=self.parent_fd, follow_symlinks=False)
        need(file_key(after_fd) == file_key(self.before) == file_key(after_path),
             'runtime_file_changed_while_streaming')


class ArchiveSink:
    def __init__(self, fd):
        self.fd = fd
        self.count = 0
        self.digest = hashlib.sha256()

    def write(self, data):
        view = memoryview(data)
        total = 0
        while view:
            check_tick()
            need(self.count + len(view) <= MAX_ARCHIVE_BYTES, 'archive_size_cap_exceeded')
            written = os.write(self.fd, view)
            need(type(written) is int and written > 0, 'archive_short_write')
            self.count += written
            total += written
            self.digest.update(view[:written])
            view = view[written:]
        return total

    def tell(self):
        return self.count

    def flush(self):
        os.fsync(self.fd)


def tar_info(name, kind, mode, size=0, linkname=''):
    info = tarfile.TarInfo(name)
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = 0
    info.mode = mode
    info.size = size
    if kind == 'directory':
        info.type = tarfile.DIRTYPE
    elif kind == 'symlink':
        info.type = tarfile.SYMTYPE
        info.linkname = linkname
    else:
        info.type = tarfile.REGTYPE
    return info


def preflight_tar(by_path, provenance):
    total = 3 * tarfile.RECORDSIZE + SIDECAR_RESERVE
    directories = archive_directories(by_path, provenance)
    for name in directories:
        check_tick()
        info = tar_info(name + '/', 'directory', 0o500)
        header = info.tobuf(format=tarfile.PAX_FORMAT, encoding='utf-8', errors='surrogateescape')
        total += len(header)
        need(total <= MAX_ARCHIVE_BYTES, 'tar_preflight_directory_cap')
    for name in sorted(by_path):
        check_tick()
        row = by_path[name]
        if row['kind'] == 'directory':
            continue
        arc = 'runtime/OmegaHive.bundle/' + name
        kind = row['kind']
        size = row['bytes'] if kind == 'file' else 0
        info = tar_info(arc + ('/' if kind == 'directory' else ''), kind,
                        int(row['mode'], 8), size, row.get('target', ''))
        header = info.tobuf(format=tarfile.PAX_FORMAT, encoding='utf-8', errors='surrogateescape')
        total += len(header) + size + ((-size) % 512)
        need(total <= MAX_ARCHIVE_BYTES, 'tar_preflight_archive_cap')
    for item in provenance:
        check_tick()
        info = tar_info(item['name'], 'file', 0o400, item['pin']['bytes'])
        header = info.tobuf(format=tarfile.PAX_FORMAT, encoding='utf-8', errors='surrogateescape')
        size = item['pin']['bytes']
        total += len(header) + size + ((-size) % 512)
        need(total <= MAX_ARCHIVE_BYTES, 'tar_preflight_provenance_cap')
    return total


def archive_directories(by_path, provenance):
    result = {'runtime', 'runtime/OmegaHive.bundle', 'provenance'}
    for rel, row in by_path.items():
        if row['kind'] == 'directory':
            result.add('runtime/OmegaHive.bundle/' + rel)
    for item in provenance:
        parts = PurePosixPath(item['name']).parts
        for index in range(1, len(parts)):
            result.add('/'.join(parts[:index]))
    return sorted(result, key=lambda value: (value.count('/'), value))


def add_file_from_path(tf, root_fd, rel, row):
    parent, leaf = open_parent_fd(root_fd, rel)
    fd = None
    try:
        before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_size == row['bytes'] and file_key(before) == row['_identity'],
             'runtime_file_preopen_identity_mismatch')
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        need(file_key(os.fstat(fd)) == file_key(before), 'runtime_file_fd_identity_mismatch')
        reader = PinnedInput(fd, row['bytes'], row['sha256'], before, parent, leaf, rel)
        info = tar_info('runtime/OmegaHive.bundle/' + rel, 'file', int(row['mode'], 8), row['bytes'])
        tf.addfile(info, reader)
        reader.finish()
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def add_pinned_provenance(tf, item, uid):
    pin = item['pin']
    path = Path(pin['path'])
    parent = open_directory_chain(path.parent)
    fd = None
    try:
        parent_identity = directory_key(os.fstat(parent))
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
             and before.st_size == pin['bytes'], 'provenance_file_identity_required')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        need(file_key(os.fstat(fd)) == file_key(before), 'provenance_fd_identity_required')
        reader = PinnedInput(fd, pin['bytes'], pin['sha256'], before, parent, path.name, pin['path'])
        tf.addfile(tar_info(item['name'], 'file', 0o400, pin['bytes']), reader)
        reader.finish()
        check_parent = open_directory_chain(path.parent)
        try:
            need(directory_key(os.fstat(check_parent)) == parent_identity,
                 'provenance_parent_directory_identity_changed')
        finally:
            os.close(check_parent)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def create_output_root(admission, uid):
    runner_temp = Path(os.environ.get('RUNNER_TEMP', ''))
    need(runner_temp.is_absolute() and str(runner_temp) == os.path.normpath(str(runner_temp))
         and str(runner_temp) == admission['runner_temp_path'], 'owner_bound_runner_temp_required')
    need(not runner_temp.is_relative_to(ROOT) and runner_temp != JOB,
         'custody_output_must_be_outside_runtime_job')
    run_id = identity(runner_temp, owner=uid)
    need(run_id[3] & 0o022 == 0, 'runner_temp_must_not_be_group_or_world_writable')
    need(run_id == admission['runner_temp_identity'], 'runner_temp_identity_changed')
    rootfd = open_directory_chain(runner_temp)
    try:
        try:
            os.mkdir('omegahive-runtime-custody-r1', 0o700, dir_fd=rootfd)
        except FileExistsError:
            pass
        outfd = os.open('omegahive-runtime-custody-r1', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
        try:
            info = os.fstat(outfd)
            need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
                 'private_custody_output_parent_required')
            attempt = 'attempt-' + admission['attempt_id']
            os.mkdir(attempt, 0o700, dir_fd=outfd)
            attemptfd = os.open(attempt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=outfd)
            try:
                attempt_info = os.fstat(attemptfd)
                need(attempt_info.st_uid == uid and stat.S_IMODE(attempt_info.st_mode) == 0o700,
                     'fresh_private_custody_attempt_required')
                os.fsync(outfd)
                absolute = runner_temp / 'omegahive-runtime-custody-r1' / attempt
                return absolute, attemptfd
            except BaseException:
                os.close(attemptfd)
                raise
        finally:
            os.close(outfd)
    finally:
        os.close(rootfd)


def validate_sealed_manifest(stage2, admission, stage2_result, phases, evidence, seal_pin, stage2_inputs):
    raw, observed, _info = read_small(seal_pin['path'], MAX_JSON_BYTES, expected=seal_pin, owner=os.getuid())
    manifest = json.loads(raw)
    contract = stage2['helper']['contract']
    contract['validate_manifest'](manifest, str(BUNDLE), lambda pin: read_small(
        pin['path'], pin.get('bytes', MAX_JSON_BYTES), expected=pin, owner=os.getuid())[0])
    seal_result_path = JOB / 'receipts/runtime-seal-result-r1.json'
    parse_pin(admission['seal_result_pin'], expected_path=seal_result_path, maximum=128 * 1024)
    seal_result_raw, seal_result_obs, _ = read_small(seal_result_path, 128 * 1024,
        expected=admission['seal_result_pin'], owner=os.getuid())
    seal_result = json.loads(seal_result_raw)
    need(seal_result.get('schema') == 'studio-Mac-CI-runtime-seal-result/1'
         and seal_result.get('status') == 'SEALED_DATA_INPUT_ONLY'
         and seal_result.get('qualification') == contract['QUALIFICATION']
         and seal_result.get('job_identity') == admission['job_identity']
         and seal_result.get('output') == seal_pin, 'same_job_clean_seal_result_required')
    source_subject = stage2_inputs['review']['subjects']['seal_runtime']
    need(type(seal_result.get('source')) is dict
         and seal_result['source'].get('sha256') == source_subject['sha256']
         and seal_result['source'].get('bytes') == source_subject['bytes'],
         'sealed_result_reviewed_sealer_source_required')
    seal_inputs_pin = seal_result.get('inputs')
    seal_admission_pin = seal_result.get('admission')
    inputs_path = HERE / 'SEAL_INPUTS_R1.json'
    admission_path = JOB / 'receipts/runtime-seal-admission-r1.json'
    parse_pin(seal_inputs_pin, expected_path=inputs_path, maximum=1024 * 1024)
    parse_pin(seal_admission_pin, expected_path=admission_path, maximum=64 * 1024)
    seal_inputs, _inputs_raw, _inputs_observed = load_json_pin(seal_inputs_pin,
        maximum=1024 * 1024, owner=os.getuid())
    seal_admission, _admission_raw, _admission_observed = load_json_pin(seal_admission_pin,
        maximum=64 * 1024, owner=os.getuid())
    need(set(seal_inputs) == {'schema', 'source_owner', 'origin_machine', 'job_path', 'roles', 'scope'}
         and seal_inputs['schema'] == 'studio-Mac-CI-runtime-seal-inputs/1'
         and seal_inputs['source_owner'] == admission['source_owner']
         and seal_inputs['origin_machine'] == admission['origin_machine']
         and seal_inputs['job_path'] == str(JOB)
         and seal_inputs['roles'] == manifest['evidence'], 'closed_same_job_seal_inputs_required')
    resource_path = STAGE2_RESULT_PARENT / stage2_result['owner']['attempt_id'] / 'seal' / 'RESOURCE_ADMISSION.json'
    resource_raw, _resource_observed, _resource_info = read_small(resource_path, 1024 * 1024,
        owner=os.getuid())
    resource_value = json.loads(resource_raw)
    current_task_sha = sha(json_bytes({'tasks': phases['seal']['context']['owner']['current_tasks']}))
    need(seal_admission.get('status') == 'OWNER_ADMITTED_RUNTIME_SEAL'
         and seal_admission.get('candidate_source_sha256') == source_subject['sha256']
         and seal_admission.get('inputs_sha256') == seal_inputs_pin['sha256']
         and seal_admission.get('job_path') == str(JOB)
         and seal_admission.get('job_identity') == admission['job_identity']
         and seal_admission.get('execution_owner') == admission['source_owner']
         and seal_admission.get('origin_machine') == admission['origin_machine']
         and seal_admission.get('source_review_sha256') == stage2_inputs['review_raw_sha256']
         and seal_admission.get('resource_advice_sha256') == sha(json_bytes(resource_value))
         and seal_admission.get('current_tasks_sha256') == current_task_sha,
         'same_job_seal_admission_context_chain_required')
    phase_seal = phases['seal']['facts'].get('sealed_runtime_input')
    need(phase_seal == seal_pin and stage2_result.get('sealed_runtime_input') == seal_pin,
         'stage2_terminal_seal_link_required')
    expected_evidence = {
        'finalization': evidence['finalization'],
        'finalizer_admission': evidence['finalizer_admission'],
        'native_phases': evidence['native_phases'],
        'native_parent': evidence['native_parent'],
        'native_audit': phases['native_audit']['facts'].get('audit_receipt'),
        'relocation': phases['relocation']['facts'].get('audit_receipt'),
    }
    need(manifest.get('evidence') == expected_evidence, 'six_sealed_evidence_roles_match_stage2_closures')
    # The source bundle's current review + manifest are independently bound by admission.
    need(stage2_inputs['manifest_raw_sha256'] == admission['stage2_manifest_pin']['sha256']
         and stage2_inputs['review_raw_sha256'] == admission['stage2_review_pin']['sha256'],
         'admitted_stage2_source_pair_changed')
    return manifest, {'path': str(seal_result_path), 'bytes': len(seal_result_raw),
                      'sha256': seal_result_obs['sha256']}, seal_result, seal_inputs_pin, seal_admission_pin


def validate_owner_context(admission, source_path, source_bytes, export_review, stage2_inputs, uid):
    source_pin = {'path': str(source_path), 'bytes': len(source_bytes), 'sha256': sha(source_bytes)}
    parse_pin(admission['source_pin'], expected_path=source_path, maximum=512 * 1024)
    need(admission['source_pin'] == source_pin, 'owner_admitted_export_source_pin_mismatch')
    review_pin = admission['source_review_pin']
    parse_pin(review_pin, expected_path=EXPORT_REVIEW, maximum=256 * 1024)
    need(review_pin['sha256'] == export_review['sha256'], 'owner_admitted_export_review_pin_mismatch')
    parse_pin(admission['stage2_manifest_pin'], expected_path=MANIFEST, maximum=128 * 1024)
    parse_pin(admission['stage2_review_pin'], expected_path=STAGE2_REVIEW, maximum=128 * 1024)
    job_identity = identity(JOB, owner=uid, mode=0o700)
    need(job_identity == admission['job_identity'] and Path(admission['job_path']) == JOB,
         'current_runtime_job_identity_mismatch')
    need(identity(ROOT, owner=uid, mode=0o700) == admission['root_identity'],
         'current_ci_root_identity_mismatch')
    return source_pin, review_pin, job_identity


def export_archive(attempt_dir, attempt_fd, by_path, provenance, root_fd, admission, uid):
    archive_name = 'runtime-custody.tar'
    partial_name = 'runtime-custody.partial.tar'
    fd = os.open(partial_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=attempt_fd)
    ACTIVE['archive_fd'] = fd
    ACTIVE['partial_archive_path'] = str(attempt_dir / partial_name)
    ACTIVE['archive_state'] = 'partial_retained'
    file_before = os.fstat(fd)
    need(stat.S_ISREG(file_before.st_mode) and file_before.st_uid == uid
         and file_before.st_nlink == 1, 'owned_exclusive_archive_file_required')
    sink = ArchiveSink(fd)
    completed = False
    try:
        # Resource/owner/job identity and the entire declared directory closure
        # are rechecked immediately before the first archive byte.
        need(int(time.time()) < admission['valid_until_epoch'], 'owner_admission_expired_before_stream')
        need(identity(JOB, owner=uid, mode=0o700) == admission['job_identity'],
             'runtime_job_identity_changed_before_stream')
        refresh_gate()
        root_info = os.fstat(root_fd)
        check_closed_dirs(by_path, ACTIVE['children'], root_fd, root_info)
        with tarfile.open(fileobj=sink, mode='w|', format=tarfile.PAX_FORMAT,
                          bufsize=CHUNK) as tf:
            for name in archive_directories(by_path, provenance):
                check_tick()
                tf.addfile(tar_info(name + '/', 'directory', 0o500))
            for name in sorted(by_path):
                check_tick()
                row = by_path[name]
                if row['kind'] == 'file':
                    add_file_from_path(tf, root_fd, name, row)
                elif row['kind'] == 'symlink':
                    arc_name = 'runtime/OmegaHive.bundle/' + name
                    info = tar_info(arc_name, 'symlink', int(row['mode'], 8),
                                    0, row.get('target', ''))
                    tf.addfile(info)
            for item in provenance:
                check_tick()
                add_pinned_provenance(tf, item, uid)
        sink.flush()
        need(sink.count <= ACTIVE['planned_archive_bound']
             and sink.count <= MAX_ARCHIVE_BYTES, 'final_archive_byte_cap')
        check_closed_dirs(by_path, ACTIVE['children'], root_fd, root_info)
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        file_after = os.fstat(fd)
        partial_after = os.stat(partial_name, dir_fd=attempt_fd, follow_symlinks=False)
        need(inode_key(file_before) == inode_key(file_after) == inode_key(partial_after)
             and file_after.st_size == partial_after.st_size == sink.count
             and stat.S_IMODE(file_after.st_mode) == 0o400,
             'archive_partial_identity_size_or_mode_changed')
        os.close(fd)
        fd = None
        ACTIVE['archive_fd'] = None
        publish_exclusive(attempt_fd, partial_name, archive_name, file_after,
                          sink.count, 0o400, success_commit=True,
                          committed_state='archive_complete_receipt_pending')
        completed = True
        ACTIVE['archive_state'] = 'archive_complete_receipt_pending'
        return {'archive': str(attempt_dir / archive_name), 'archive_bytes': sink.count,
                'archive_sha256': sink.digest.hexdigest(),
                'member_count': sum(row['kind'] != 'directory' for row in by_path.values())
                                + len(provenance) + len(archive_directories(by_path, provenance))}
    finally:
        if fd is not None:
            os.fsync(fd)
            try:
                os.fchmod(fd, 0o400)
            except OSError:
                pass
            os.close(fd)
            ACTIVE['archive_fd'] = None
        if not completed:
            # The partial archive is intentionally retained for diagnosis. It
            # is never renamed to the successful artifact name.
            pass


def build_receipt(admission, stage2, stage2_inputs, stage2_result_pin, phase_pins,
                  seal_pin, seal_result_pin, manifest, source_pin, review_pin,
                  archive_result, resource_record, owner_context_pin,
                  started_epoch, completed_epoch):
    return {'schema': 'studio-Mac-CI-runtime-custody-receipt/1',
        'status': 'CUSTODY_ARCHIVE_COMPLETE', 'qualification': RESULT_LABEL,
        'source_owner': admission['source_owner'], 'origin_machine': admission['origin_machine'],
        'attempt_id': admission['attempt_id'], 'job_path': str(JOB),
        'job_identity': admission['job_identity'], 'runtime_content_inventory_sha256': manifest['content_inventory_sha256'],
        'runtime_entry_count': len(manifest['files']),
        'runtime_bytes': sum(row['bytes'] for row in manifest['files'] if row['kind'] == 'file'),
        'stage2_manifest_pin': admission['stage2_manifest_pin'],
        'stage2_review_pin': admission['stage2_review_pin'],
        'stage2_result_pin': stage2_result_pin, 'phase_closure_pins': phase_pins,
        'sealed_manifest_pin': seal_pin, 'seal_result_pin': seal_result_pin,
        'source_pin': source_pin, 'source_review_pin': review_pin,
        'owner_context_pin': owner_context_pin,
        'task_snapshot_pin': admission['task_snapshot_pin'],
        'task_snapshot_observed_epoch': admission['task_snapshot_observed_epoch'],
        'task_snapshot_valid_until_epoch': admission['task_snapshot_valid_until_epoch'],
        'resource_policy_pin': admission['resource_policy_pin'],
        'resource_gate': resource_record, 'started_epoch': started_epoch,
        'completed_epoch': completed_epoch, 'archive': archive_result,
        'scope': RESULT_LABEL + '; byte custody only; this artifact is not a restored runtime input.'}


def publish_exclusive(attempt_fd, partial_name, final_name, expected_info, expected_size,
                      expected_mode, *, success_commit=False, committed_state=None):
    if success_commit:
        check_tick()
    # linkat is an atomic no-replace publication on the same filesystem. If
    # the destination already exists, retain the partial and refuse.
    os.link(partial_name, final_name, src_dir_fd=attempt_fd, dst_dir_fd=attempt_fd,
            follow_symlinks=False)
    if committed_state is not None:
        ACTIVE['archive_state'] = committed_state
    linked = os.stat(final_name, dir_fd=attempt_fd, follow_symlinks=False)
    need(hardlink_key(expected_info) == hardlink_key(linked)
         and linked.st_nlink == 2 and linked.st_size == expected_size
         and stat.S_IMODE(linked.st_mode) == expected_mode,
         'exclusive_published_file_identity_required')
    os.unlink(partial_name, dir_fd=attempt_fd)
    os.fsync(attempt_fd)
    final_info = os.stat(final_name, dir_fd=attempt_fd, follow_symlinks=False)
    need(hardlink_key(expected_info) == hardlink_key(final_info)
         and final_info.st_nlink == 1 and final_info.st_size == expected_size
         and stat.S_IMODE(final_info.st_mode) == expected_mode,
         'exclusive_final_file_identity_required')
    if success_commit:
        # Publication is not the success commit by itself. Recheck active
        # guards after the final directory fsync and pathname identity check.
        # If this refuses, retain the published file and let outer_main write
        # the bounded failure record instead of returning a success receipt.
        check_tick()


def write_sidecar(attempt_fd, name, value, *, success_commit=False):
    raw = json_bytes(value)
    need(0 < len(raw) <= 256 * 1024, 'bounded_custody_receipt_required')
    partial_name = name + '.partial'
    fd = os.open(partial_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=attempt_fd)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1, 'owned_sidecar_regular_file_required')
        view = memoryview(raw)
        while view:
            if success_commit:
                check_tick()
            need(len(view) <= 256 * 1024, 'sidecar_write_bound')
            count = os.write(fd, view)
            need(type(count) is int and count > 0, 'sidecar_short_write')
            view = view[count:]
        os.fsync(fd)
        if success_commit:
            check_tick()
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        after = os.fstat(fd)
        path_after = os.stat(partial_name, dir_fd=attempt_fd, follow_symlinks=False)
        need(inode_key(before) == inode_key(after) == inode_key(path_after)
             and after.st_size == path_after.st_size == len(raw)
             and stat.S_IMODE(after.st_mode) == 0o400,
             'sidecar_identity_or_size_changed')
        named_parent = open_directory_chain(ACTIVE['output_dir'])
        try:
            need(directory_key(os.fstat(named_parent)) == directory_key(os.fstat(attempt_fd)),
                 'sidecar_parent_path_identity_changed')
        finally:
            os.close(named_parent)
        publish_exclusive(attempt_fd, partial_name, name, after, len(raw), 0o400,
                          success_commit=success_commit,
                          committed_state=('custody_receipt_published'
                                            if success_commit else None))
    finally:
        os.close(fd)
    return {'bytes': len(raw), 'sha256': sha(raw)}


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--context-sha256', required=True)
    args = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    need(args.run is True, 'explicit_custody_export_run_required')
    ACTIVE['started'] = time.monotonic()
    ACTIVE['deadline'] = ACTIVE['started'] + PHASE_LIMIT_SECONDS
    ACTIVE['started_epoch'] = int(time.time())
    ACTIVE['last_resource_check'] = ACTIVE['started']
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64'
         and sys.version_info[:2] == (3, 12) and sys.executable == str(PYTHON)
         and os.getuid() == os.geteuid() > 0
         and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
         and not sys.flags.optimize and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('PATH') == SYSTEM_PATH,
         'dedicated_ci_isolated_owner_and_canonical_PATH_required')
    uid = os.getuid()
    read_small(PYTHON, 32 * 1024**2, expected=PYTHON_PIN, owner=uid)
    root_identity = identity(ROOT, owner=uid, mode=0o700)
    job_identity = identity(JOB, owner=uid, mode=0o700)
    need(Path.cwd() == ROOT, 'canonical_ci_root_working_directory_required')
    source_path = SOURCE_PATH
    need(Path(__file__).absolute() == SOURCE_PATH and not source_path.is_symlink(),
         'fixed_staged_exporter_source_path_required')
    source_bytes, source_observed, _ = read_small(source_path, 512 * 1024, owner=uid)
    context, context_pin = load_admission(args.context_sha256, uid)
    ACTIVE['admission'] = context
    need(root_identity == context['root_identity'] and job_identity == context['job_identity'],
         'owner_context_root_or_job_identity_mismatch')
    export_review, export_review_pin = validate_export_review(
        context['source_review_pin'], context['source_pin'], uid)
    source_pin, review_pin, job_identity = validate_owner_context(
        context, source_path, source_bytes, export_review_pin, {}, uid)
    need(context['job_identity'] == job_identity, 'owner_context_job_identity_changed')
    stage2_inputs = validate_stage2_source(context['stage2_manifest_pin'],
                                           context['stage2_review_pin'], uid)
    need(context['stage2_manifest_pin']['sha256'] == stage2_inputs['manifest_raw_sha256']
         and context['stage2_review_pin']['sha256'] == stage2_inputs['review_raw_sha256'],
         'owner_admitted_stage2_source_pair_mismatch')
    need(context['valid_until_epoch'] > int(time.time()), 'owner_context_expired')
    stage2_result, phases, phase_pins, evidence, seal_pin, stage2_result_obs = validate_stage2_result(
        context['stage2_result_pin'], uid, context)
    # The sealed contract is a reviewed helper, loaded only after exact source checks.
    stage2 = stage2_inputs
    stage2['helper'] = load_helpers_for_validation(uid)
    seal_manifest, seal_result_pin, seal_result, seal_inputs_pin, seal_admission_pin = validate_sealed_manifest(
        stage2, context, stage2_result, phases, evidence, seal_pin, stage2_inputs)
    supporting_items = validate_supporting_provenance(
        context, stage2_result, phases, seal_manifest, uid)
    by_path, children, runtime_bytes = validate_inventory(seal_manifest)
    for row in by_path.values():
        if row['kind'] == 'symlink':
            resolve_link(row['path'], row['target'], by_path)
    stage2['runtime_bytes'] = runtime_bytes
    stage2['stage2_result'] = stage2_result
    provenance = build_provenance(stage2, phases, phase_pins, seal_manifest['evidence'],
        context['stage2_result_pin'], seal_pin, seal_result_pin,
        seal_inputs_pin, seal_admission_pin, {
            'manifest_pin': context['stage2_manifest_pin'],
            'review_pin': context['stage2_review_pin'],
            'source_pin': source_pin,
            'export_review_pin': review_pin}, supporting_items)
    archive_bound = preflight_tar(by_path, provenance)
    need(archive_bound <= MAX_ARCHIVE_BYTES and archive_bound <= int(ESTIMATE['disk_gb'] * 1024**3),
         'bounded_archive_plus_failure_reserve_required')
    ACTIVE['planned_archive_bound'] = archive_bound
    need(identity(JOB, owner=uid, mode=0o700) == context['job_identity'],
         'current_job_identity_changed_before_resource_gate')
    temp_path = Path(os.environ.get('RUNNER_TEMP', ''))
    ACTIVE['output_parent'] = temp_path
    ACTIVE['output_parent_identity'] = context['runner_temp_identity']
    ACTIVE['task_rows'] = load_current_tasks(context['task_snapshot_pin'],
                     context['task_snapshot_observed_epoch'], uid)
    guide, policy_pin = load_runtime_helpers(stage2_inputs)
    ACTIVE['resources'] = guide
    ACTIVE['policy_pin'] = policy_pin
    need(policy_pin == context['resource_policy_pin'], 'owner_and_helper_resource_policy_pin_mismatch')
    ACTIVE['output_parent'] = temp_path
    # The pinned resource guide launches only bounded system probes; give those
    # children a closed environment without CI secrets, user profiles, proxies
    # or arbitrary caller-provided variables.
    os.environ.clear()
    os.environ.update({'PATH': SYSTEM_PATH, 'LANG': 'C', 'LC_ALL': 'C',
        'GITHUB_ACTIONS': 'true', 'RUNNER_TEMP': str(temp_path),
        'HOME': str(ROOT), 'TMPDIR': str(temp_path)})
    # No artifact path is created unless a fresh resource sample permits RUN.
    refresh_gate()
    output_dir, attempt_fd = create_output_root(context, uid)
    ACTIVE['attempt_fd'] = attempt_fd
    ACTIVE['output_dir'] = output_dir
    ACTIVE['output_parent'] = output_dir
    ACTIVE['output_parent_identity'] = identity(output_dir, owner=uid, mode=0o700)
    ACTIVE['last_resource_check'] = 0.0
    refresh_gate()
    runtime_fd = open_directory_chain(BUNDLE)
    ACTIVE['runtime_fd'] = runtime_fd
    root_info = os.fstat(runtime_fd)
    need(root_info.st_uid == uid and stat.S_IMODE(root_info.st_mode) == 0o500,
         'sealed_runtime_root_owner_mode_required')
    check_closed_dirs(by_path, children, runtime_fd, root_info)
    # Bind identities once before archive creation. The copy pass hashes every
    # regular file while streaming; no recursive discovery is performed.
    ACTIVE['children'] = children
    need(context['valid_until_epoch'] > int(time.time()), 'owner_admission_expired_before_export')
    archive_result = export_archive(output_dir, attempt_fd, by_path, provenance,
                                    runtime_fd, context, uid)
    completed = int(time.time())
    receipt = build_receipt(context, stage2, stage2_inputs, context['stage2_result_pin'],
        phase_pins, seal_pin, seal_result_pin, seal_manifest, source_pin, review_pin,
        archive_result, ACTIVE['resource_record'], context_pin,
        ACTIVE['started_epoch'], completed)
    sidecar = write_sidecar(attempt_fd, 'CUSTODY_RECEIPT.json', receipt,
                            success_commit=True)
    ACTIVE['archive_state'] = 'custody_receipt_complete'
    os.close(runtime_fd)
    ACTIVE['runtime_fd'] = None
    os.close(attempt_fd)
    ACTIVE['attempt_fd'] = None
    print(json.dumps({'status': 'CUSTODY_ARCHIVE_COMPLETE', 'qualification': RESULT_LABEL,
        'archive': archive_result['archive'], 'archive_sha256': archive_result['archive_sha256'],
        'receipt': str(output_dir / 'CUSTODY_RECEIPT.json'), 'receipt_sha256': sidecar['sha256']},
        sort_keys=True), flush=True)
    return 0


def load_helpers_for_validation(uid):
    # Helper bytes have already been independently reviewed and are copied in
    # the Stage2 private source tree. Their exact hashes are checked here.
    package_path = ROOT / STAGE2_ROLES['package_inputs']
    contract_path = ROOT / STAGE2_ROLES['fresh_runtime_contract']
    package_raw, package_pin, _ = read_small(package_path, 256 * 1024,
        expected={'bytes': 24785, 'sha256': 'fd70211ac0ead5974ebc39e4be0c57a193eb770579eb0d88ca54f61d067ffe4d'}, owner=uid)
    contract_raw, contract_pin, _ = read_small(contract_path, 256 * 1024,
        expected={'bytes': 12637, 'sha256': '2dade1e85f653b733f2a4111bd9428d79f8a86a1b352202671ec7dc6ee9dac5c'}, owner=uid)
    package_ns = {'__name__': 'pinned_stage2_package_inputs', '__file__': str(package_path)}
    contract_ns = {'__name__': 'pinned_fresh_runtime_contract', '__file__': str(contract_path)}
    exec(compile(package_raw, str(package_path), 'exec'), package_ns)
    exec(compile(contract_raw, str(contract_path), 'exec'), contract_ns)
    return {'package': package_ns, 'contract': contract_ns,
            'package_pin': package_pin, 'contract_pin': contract_pin}


def outer_main(argv=None):
    output_dir = None
    attempt_fd = None
    try:
        return main(argv)
    except BaseException as error:
        if ACTIVE.get('archive_state') == 'custody_receipt_complete':
            # The no-replace receipt publication is the success commit point.
            # A later stdout/descriptor-close problem does not revoke it.
            return 0
        # Once an attempt directory exists, keep partial bytes and write only a
        # bounded sanitized failure record. Never clean up or automatically retry.
        if ACTIVE.get('attempt_fd') is not None:
            try:
                record = {'schema': 'studio-Mac-CI-runtime-custody-failure/1',
                    'status': 'FAILED_PARTIAL_RETAINED_NO_RETRY', 'qualification': RESULT_LABEL,
                    'error_type': type(error).__name__, 'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
                    'source_owner': ACTIVE['admission'].get('source_owner'),
                    'origin_machine': ACTIVE['admission'].get('origin_machine'),
                    'attempt_id': ACTIVE['admission'].get('attempt_id'),
                    'archive_state': ACTIVE.get('archive_state'),
                    'retained_archive': ('runtime-custody.partial.tar'
                        if ACTIVE.get('archive_state') == 'partial_retained' else
                        'runtime-custody.tar' if ACTIVE.get('archive_state') in {
                            'archive_complete_receipt_pending', 'custody_receipt_published',
                            'custody_receipt_complete'}
                        else None),
                    'retained_receipt': ('CUSTODY_RECEIPT.json'
                        if ACTIVE.get('archive_state') in {'custody_receipt_published',
                                                           'custody_receipt_complete'} else None),
                    'scope': 'Partial output retained; no restore or runtime qualification.'}
                write_sidecar(ACTIVE['attempt_fd'], 'FAILURE_RECORD.json', record)
            except BaseException:
                pass
        print(json.dumps({'status': 'FAILED_PARTIAL_RETAINED_NO_RETRY',
            'qualification': RESULT_LABEL, 'error_type': type(error).__name__,
            'reason': str(error) if isinstance(error, Refused) else type(error).__name__},
            sort_keys=True), file=sys.stderr, flush=True)
        return 1
    finally:
        for key in ('runtime_fd', 'archive_fd', 'attempt_fd'):
            fd = ACTIVE.get(key)
            if type(fd) is int:
                try:
                    if key == 'archive_fd':
                        os.fchmod(fd, 0o400)
                        os.fsync(fd)
                    os.close(fd)
                except OSError:
                    pass
                ACTIVE[key] = None


if __name__ == '__main__':
    raise SystemExit(outer_main())
