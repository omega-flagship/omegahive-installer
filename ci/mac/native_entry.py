"""Sealed Stage 1 native entry. Default is a read-only source plan.

Only --run binds CI-owner runtime facts and execs the independently reviewed
Parent with unchanged source/review bytes. No runtime code patching occurs.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import sys
import time


ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
NATIVE = ROOT / 'native-source'
PARENT_DIR = ROOT / 'native-parent'
DRIVER_TARGET = NATIVE / 'ci_native_parent_driver.py'
PRODUCER_TARGET = NATIVE / 'provision_native_inputs.py'
WORKER_TARGET = NATIVE / 'ci_native_worker.py'
INPUTS_TARGET = NATIVE / 'NATIVE_BUILD_INPUTS_R1.json'
STATIC_REVIEW = PARENT_DIR / 'NATIVE_PARENT_SOURCE_REVIEW_R1.json'
OWNER_CONTEXT = PARENT_DIR / 'NATIVE_PARENT_CONTEXT_R1.json'
PARENT_SOURCE = PARENT_DIR / 'ci_native_parent.py'
MANIFEST_NAME = 'MANIFEST.sha256'
COMMON_REVIEW_NAME = 'STATIC_SOURCE_REVIEW.json'
COMPONENT_REVIEW_NAME = 'STATIC_NATIVE_SOURCE_REVIEW.json'

# The checksum manifest includes all role files and both genuine reviews.
# It excludes itself; an external sealed SHA256 authenticates the whole set.
REVIEW_SCHEMA = 'studio-Mac-CI-native-parent-static-review/1'
CONTEXT_SCHEMA = 'studio-Mac-CI-native-parent-owner-context/1'
OWNER_TASK_SCHEMA = 'studio-Mac-CI-native-parent-task-admission/1'
OWNER_RESOURCE_SCHEMA = 'studio-Mac-CI-native-parent-resource-admission/1'
INPUT_ADMISSION_SCHEMA = 'studio-Mac-CI-native-input-owner-admission/1'
INPUT_PRODUCER_SHA256 = 'bc00666a386b3268092796aa3340d30fb4e7ed52a3b599fddfbaf348ff5329c7'
INPUT_PRODUCER_BYTES = 15015
ENABLED_WORKER_SHA256 = '86f7ecc349cce6a61bd4c50b0c5922ed360a7e90a223cb191b658a6cedc21b6d'
ENABLED_WORKER_BYTES = 29154
RECIPE = {'path': str(JOB / 'native-runtime-phases.sh'), 'bytes': 7104,
          'sha256': '450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709'}
PYTHON = {'path': str(JOB / 'bootstrap/python/bin/python3.12'), 'bytes': 18652104,
          'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
CONTRACT = {'path': str(ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json'),
            'bytes': 63647,
            'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'}
PARENT_REL = 'native-parent/ci_native_parent.py'
DRIVER_REL = 'native-source/ci_native_parent_driver.py'
WORKER_REL = 'native-source/ci_native_worker.py'
PRODUCER_REL = 'native-source/provision_native_inputs.py'
TASK_LIMITS = {'cpu_cores': 2.25, 'ram_bytes': 3355443200,
               'scratch_bytes': 8589934592, 'wall_seconds': 1800}
INPUT_LIMIT = 256 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
MAX_MANIFEST_ROWS = 128
MAX_BUNDLE_FILE_BYTES = 256 * 1024
MAX_BUNDLE_TOTAL_BYTES = 3 * 1024**2



class Refused(RuntimeError):
    pass

def need(ok, reason):
    if not ok:
        raise Refused(reason)

def _pairs(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate_json_key')
        result[key] = value
    return result

def _no_constant(value):
    raise Refused('nonfinite_json_number')

def parse_object(raw, reason):
    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=_no_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Refused(reason) from error
    need(type(value) is dict, reason + '_object_required')
    return value

def canonical_json(value, maximum):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')
    need(len(raw) <= maximum, 'canonical_json_byte_bound')
    return raw

def _absolute(path):
    raw = str(path)
    value = Path(raw)
    need(value.is_absolute() and raw == str(value)
         and all(part not in {'', '.', '..'} for part in value.parts[1:]),
         'canonical_absolute_path_required')
    return value

def _open_dir(path):
    value = _absolute(path)
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open('/', flags)
    try:
        for part in value.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        need(stat.S_ISDIR(info.st_mode), 'plain_directory_required')
        return fd, info
    except BaseException:
        os.close(fd)
        raise

def directory_identity(path, owner_uid, *, private=False):
    fd, info = _open_dir(path)
    try:
        need(info.st_uid == owner_uid, 'directory_owner_mismatch')
        mode = stat.S_IMODE(info.st_mode)
        if private:
            need(mode == 0o700, 'private_directory_mode_required')
        return [info.st_dev, info.st_ino, info.st_uid, mode]
    finally:
        os.close(fd)

def _open_parent(path):
    value = _absolute(path)
    parent, name = value.parent, value.name
    need(name not in {'', '.', '..'}, 'file_basename_required')
    fd, _info = _open_dir(parent)
    return value, name, fd

def read_regular(path, *, maximum, owner_uid, expected_bytes=None, expected_sha256=None,
                 keep_bytes=True):
    value, name, parentfd = _open_parent(path)
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                     | getattr(os, 'O_NONBLOCK', 0), dir_fd=parentfd)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid == owner_uid and 0 < before.st_size <= maximum,
             'bounded_owned_regular_file_required')
        if expected_bytes is not None:
            need(type(expected_bytes) is int and before.st_size == expected_bytes,
                 'exact_file_size_pin_mismatch')
        chunks, digest, size = [], hashlib.sha256(), 0
        while True:
            block = os.read(fd, min(65536, maximum + 1 - size))
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'file_growth_bound')
            chunks.append(block)
            digest.update(block)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
        key = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid,
                            item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        need(size == before.st_size and key(before) == key(after) == key(named),
             'file_changed_during_held_read')
        sha = digest.hexdigest()
        if expected_sha256 is not None:
            need(sha == expected_sha256, 'exact_file_sha256_pin_mismatch')
        pin = {'path': str(value), 'bytes': size, 'sha256': sha}
        return (b''.join(chunks) if keep_bytes else b''), pin
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parentfd)

def write_new(path, raw, *, owner_uid, mode=0o400):
    value, name, parentfd = _open_parent(path)
    fd = None
    try:
        parent_info = os.fstat(parentfd)
        need(parent_info.st_uid == owner_uid and stat.S_IMODE(parent_info.st_mode) == 0o700,
             'exclusive_output_private_parent_required')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=parentfd)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            need(count > 0, 'short_output_write')
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, mode)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=parentfd, follow_symlinks=False)
        key = lambda item: (item.st_dev, item.st_ino, item.st_uid, item.st_nlink,
                            item.st_size, item.st_mode, item.st_mtime_ns, item.st_ctime_ns)
        need(stat.S_ISREG(after.st_mode) and after.st_uid == owner_uid
             and after.st_nlink == 1 and after.st_size == len(raw)
             and key(after) == key(named), 'exclusive_output_identity_mismatch')
        return {'path': str(value), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parentfd)

def refresh_owner_context(raw, owner_uid):
    try:
        old_raw, old_pin = read_regular(OWNER_CONTEXT, maximum=256 * 1024,
                                        owner_uid=owner_uid)
    except FileNotFoundError:
        return write_new(OWNER_CONTEXT, raw, owner_uid=owner_uid, mode=0o400)
    old_context = parse_object(old_raw, 'prior_owner_context_invalid')
    new_context = parse_object(raw, 'new_owner_context_invalid')
    # A still-valid snapshot is immutable too. Compare its complete binding
    # after separating only the observation/expiry and admission-lease clocks.
    old_binding = dict(old_context)
    new_binding = dict(new_context)
    for value in (old_binding, new_binding):
        value.pop('observed_at', None)
        value.pop('expires_at', None)
        for name in ('task_admission', 'resource_admission'):
            need(type(value.get(name)) is dict, 'prior_context_admission_required')
            value[name] = dict(value[name])
            value[name].pop('valid_until_epoch', None)
    need(old_binding == new_binding, 'prior_context_binding_mismatch')
    try:
        observed = datetime.fromisoformat(old_context['observed_at'].replace('Z', '+00:00'))
        expires = datetime.fromisoformat(old_context['expires_at'].replace('Z', '+00:00'))
        need(observed.tzinfo is not None and expires.tzinfo is not None,
             'prior_context_timezone_required')
        checked = time.time()
        need(observed.timestamp() <= checked and 0 < (expires - observed).total_seconds() <= 60,
             'prior_context_snapshot_invalid')
        leases = [old_context[name]['valid_until_epoch']
                  for name in ('task_admission', 'resource_admission')]
        need(all(type(lease) is int and lease <= int(checked) + 3600 for lease in leases),
             'prior_context_lease_invalid')
        if expires.timestamp() >= checked and all(lease >= checked + 1820 for lease in leases):
            return old_pin
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise Refused('prior_owner_context_invalid') from error
    history = PARENT_DIR / ('NATIVE_PARENT_CONTEXT_SUPERSEDED_' + old_pin['sha256'] + '.json')
    try:
        held_history, history_pin = read_regular(history, maximum=256 * 1024,
                                                 owner_uid=owner_uid)
        need(held_history == old_raw and history_pin['sha256'] == old_pin['sha256'],
             'existing_context_history_pin_mismatch')
    except FileNotFoundError:
        write_new(history, old_raw, owner_uid=owner_uid, mode=0o400)
    new_pin = {'path': str(OWNER_CONTEXT), 'bytes': len(raw),
               'sha256': hashlib.sha256(raw).hexdigest()}
    temporary = PARENT_DIR / ('NATIVE_PARENT_CONTEXT_REFRESH_' + new_pin['sha256'] + '.tmp')
    write_new(temporary, raw, owner_uid=owner_uid, mode=0o400)
    dirfd, dirinfo = _open_dir(PARENT_DIR)
    try:
        need(dirinfo.st_uid == owner_uid and stat.S_IMODE(dirinfo.st_mode) == 0o700,
             'context_refresh_private_directory_required')
        current = os.stat(OWNER_CONTEXT.name, dir_fd=dirfd, follow_symlinks=False)
        need(stat.S_ISREG(current.st_mode) and current.st_uid == owner_uid
             and current.st_nlink == 1 and current.st_size == old_pin['bytes'],
             'current_owner_context_changed_before_refresh')
        os.rename(temporary.name, OWNER_CONTEXT.name,
                  src_dir_fd=dirfd, dst_dir_fd=dirfd)
    finally:
        os.close(dirfd)
    held_new, verified = read_regular(OWNER_CONTEXT, maximum=256 * 1024,
                                      owner_uid=owner_uid,
                                      expected_bytes=new_pin['bytes'],
                                      expected_sha256=new_pin['sha256'])
    need(held_new == raw, 'refreshed_owner_context_held_bytes_mismatch')
    return verified

def pinned_input(path, pin, owner_uid, maximum):
    need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
         and pin.get('path') == str(path)
         and type(pin.get('bytes')) is int and 0 < pin['bytes'] <= maximum
         and type(pin.get('sha256')) is str and re.fullmatch('[a-f0-9]{64}', pin['sha256']),
         'exact_input_pin_required')
    raw, observed = read_regular(path, maximum=maximum, owner_uid=owner_uid,
                                 expected_bytes=pin['bytes'], expected_sha256=pin['sha256'])
    return raw, observed

def load_bundle(manifest_path, manifest_sha256, review_path):
    requested = _absolute(Path.cwd() / manifest_path if not Path(manifest_path).is_absolute()
                          else manifest_path)
    need(requested.name == MANIFEST_NAME
         and type(manifest_sha256) is str
         and re.fullmatch('[a-f0-9]{64}', manifest_sha256),
         'sealed_checksum_manifest_required')
    bundle_root = requested.parent
    checksum_raw, checksum_pin = read_regular(
        requested, maximum=MAX_MANIFEST_BYTES, owner_uid=os.getuid(),
        expected_sha256=manifest_sha256)
    need(checksum_raw.endswith(b'\n') and b'\r' not in checksum_raw
         and b'\x00' not in checksum_raw, 'checksum_manifest_LF_text_required')
    try:
        checksum_lines = checksum_raw.decode('ascii').splitlines()
    except UnicodeDecodeError as error:
        raise Refused('checksum_manifest_ascii_required') from error
    need(0 < len(checksum_lines) <= MAX_MANIFEST_ROWS, 'checksum_manifest_row_bound')
    rows, total = {}, 0
    for line in checksum_lines:
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)', line)
        need(match is not None, 'checksum_manifest_row_invalid')
        digest, relative = match.groups()
        parts = PurePosixPath(relative).parts
        need(relative != MANIFEST_NAME and relative not in rows and all(part not in {'', '.', '..'} for part in parts),
             'checksum_manifest_path_duplicate_or_unsafe')
        held_raw, _pin = read_regular(bundle_root.joinpath(*parts),
                                      maximum=MAX_BUNDLE_FILE_BYTES,
                                      owner_uid=os.getuid(), expected_sha256=digest)
        need(b'\x00' not in held_raw, 'bundle_NUL_forbidden')
        try:
            held_raw.decode('utf-8')
        except UnicodeDecodeError as error:
            raise Refused('bundle_UTF8_required') from error
        total += len(held_raw)
        need(total <= MAX_BUNDLE_TOTAL_BYTES, 'checksum_manifest_aggregate_byte_bound')
        rows[relative] = {'path': relative, 'bytes': len(held_raw),
                          'sha256': digest, 'raw': held_raw}
    common_path = _absolute(bundle_root / review_path if not Path(review_path).is_absolute()
                            else review_path)
    need(common_path.parent == bundle_root and common_path.name == COMMON_REVIEW_NAME,
         'fixed_common_review_bundle_path_required')
    common_row = rows.get(COMMON_REVIEW_NAME)
    component_row = rows.get(COMPONENT_REVIEW_NAME)
    need(common_row is not None and component_row is not None,
         'both_real_source_reviews_must_be_manifested')
    common = parse_object(common_row['raw'], 'common_source_review_invalid')
    common_fields = {'schema', 'verdict', 'blocking_findings', 'reviewer',
                     'source_owner', 'origin_machine', 'subjects',
                     'native_component_review', 'scope'}
    expected_roles = {'prep_entry', 'prep_parent_library', 'prep_worker_enabled',
                      'prep_prototype', 'public_inputs', 'resource_guide',
                      'resource_policy', 'native_entry', 'native_parent',
                      'native_worker_enabled', 'input_producer'}
    need(set(common) == common_fields
         and common.get('schema') == 'studio-Mac-CI-stage1-static-source-review/1'
         and common.get('verdict') == 'PASS_SOURCE_ONLY'
         and common.get('blocking_findings') == []
         and all(type(common.get(key)) is str and 1 <= len(common[key]) <= 128
                 for key in ('reviewer', 'source_owner', 'origin_machine'))
         and type(common.get('scope')) is str and 1 <= len(common['scope']) <= 4096,
         'presealed_whole_stage1_source_review_required')
    subjects = common.get('subjects')
    need(type(subjects) is dict and set(subjects) == expected_roles,
         'exact_eleven_source_subjects_required')
    for role, subject in subjects.items():
        need(type(subject) is dict and set(subject) == {'path', 'bytes', 'sha256'}
             and type(subject.get('path')) is str
             and type(subject.get('bytes')) is int and subject['bytes'] > 0
             and type(subject.get('sha256')) is str
             and re.fullmatch('[a-f0-9]{64}', subject['sha256']),
             'stage1_source_subject_pin_invalid:' + role)
        row = rows.get(subject['path'])
        need(row is not None and row['bytes'] == subject['bytes']
             and row['sha256'] == subject['sha256'],
             'checksum_manifest_source_subject_mismatch:' + role)
    component_pin = common.get('native_component_review')
    need(type(component_pin) is dict and set(component_pin) == {'path', 'bytes', 'sha256'}
         and component_pin == {key: component_row[key] for key in ('path', 'bytes', 'sha256')},
         'whole_review_component_review_pin_mismatch')
    component = parse_object(component_row['raw'], 'native_component_review_invalid')
    component_fields = {'schema', 'source_owner', 'origin_machine', 'verdict',
                        'blocking_findings', 'subject'}
    component_roles = {'parent', 'enabled_worker', 'parent_entry_driver', 'input_producer'}
    need(set(component) == component_fields
         and component.get('schema') == REVIEW_SCHEMA
         and component.get('verdict') in {'PASS_SOURCE_ONLY', 'SHIP_SOURCE_ONLY'}
         and component.get('blocking_findings') == []
         and type(component.get('source_owner')) is str and component['source_owner']
         and type(component.get('origin_machine')) is str and component['origin_machine'],
         'presealed_native_parent_component_review_required')
    component_subject = component.get('subject')
    need(type(component_subject) is dict and set(component_subject) == component_roles,
         'native_parent_review_subjects_closed')
    expected_component = {
        'parent': ('native_parent', PARENT_REL),
        'enabled_worker': ('native_worker_enabled', WORKER_REL),
        'parent_entry_driver': ('native_entry', DRIVER_REL),
        'input_producer': ('input_producer', PRODUCER_REL),
    }
    for role, (whole_role, target_path) in expected_component.items():
        row = component_subject[role]
        whole = subjects[whole_role]
        need(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'}
             and row.get('path') == target_path and row.get('bytes') == whole['bytes']
             and row.get('sha256') == whole['sha256'],
             'component_whole_review_role_link_mismatch:' + role)
    return {'root': bundle_root, 'checksum_pin': checksum_pin,
            'rows': rows, 'common': common, 'common_pin': {
                'path': str(common_path), 'bytes': common_row['bytes'],
                'sha256': common_row['sha256']},
            'component': component, 'component_raw': component_row['raw'],
            'component_pin': {'path': str(STATIC_REVIEW),
                'bytes': component_row['bytes'], 'sha256': component_row['sha256']},
            'subjects': subjects}

def review_roles(bundle, driver_raw):
    rows, subjects = bundle['rows'], bundle['subjects']
    for role in ('native_entry', 'native_parent', 'native_worker_enabled', 'input_producer'):
        row = subjects[role]
        need(hashlib.sha256(rows[row['path']]['raw']).hexdigest() == row['sha256'],
             'held_static_role_digest_changed:' + role)
    driver_row = subjects['native_entry']
    need(len(driver_raw) == driver_row['bytes']
         and hashlib.sha256(driver_raw).hexdigest() == driver_row['sha256'],
         'static_review_native_entry_source_mismatch')
    parent_pin = {'path': str(PARENT_SOURCE),
                  'bytes': subjects['native_parent']['bytes'],
                  'sha256': subjects['native_parent']['sha256']}
    worker_pin = {'path': str(WORKER_TARGET),
                  'bytes': subjects['native_worker_enabled']['bytes'],
                  'sha256': subjects['native_worker_enabled']['sha256']}
    producer_pin = {'path': str(PRODUCER_TARGET),
                    'bytes': subjects['input_producer']['bytes'],
                    'sha256': subjects['input_producer']['sha256']}
    return parent_pin, worker_pin, producer_pin

def _ensure_exact_or_write(path, raw, pin, owner_uid):
    try:
        existing, current = read_regular(path, maximum=2 * 1024**2, owner_uid=owner_uid)
    except FileNotFoundError:
        return write_new(path, raw, owner_uid=owner_uid)
    need(current['bytes'] == pin['bytes'] and current['sha256'] == pin['sha256']
         and existing == raw, 'existing_bound_source_mismatch')
    return current

def _task_digest(tasks):
    raw = json.dumps(tasks, sort_keys=True, separators=(',', ':'),
                     ensure_ascii=False, allow_nan=False).encode('utf-8')
    need(len(raw) <= 256 * 1024, 'current_tasks_byte_bound')
    return hashlib.sha256(raw).hexdigest()

def validate_tasks(tasks):
    need(type(tasks) is list and len(tasks) <= 256, 'bounded_current_tasks_required')
    seen = set()
    for row in tasks:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'},
             'current_task_closed_shape_required')
        need(type(row['task_id']) is str and 1 <= len(row['task_id']) <= 128
             and row['task_id'] not in seen, 'unique_current_task_id_required')
        seen.add(row['task_id'])
        need(type(row['state']) is str and row['state'] in {'running', 'reserved'}, 'current_task_state_required')
        if row['state'] == 'running':
            need(type(row['pid']) is int and row['pid'] > 0, 'running_task_pid_required')
        else:
            need(row['pid'] is None, 'reserved_task_pid_must_be_null')
        estimate = row['estimate']
        need(type(estimate) is dict and set(estimate) == {'ram_gb', 'cpu_cores', 'disk_gb'},
             'current_task_estimate_shape_required')
        for key in ('ram_gb', 'cpu_cores', 'disk_gb'):
            value = estimate[key]
            need(type(value) in {int, float} and type(value) is not bool
                 and math.isfinite(value) and 0 <= value <= 1_000_000
                 and (key == 'disk_gb' or value > 0), 'current_task_estimate_invalid')
    return tasks

def _producer_admission(owner, job_identity, review, review_pin, worker_pin):
    return {
        'schema': INPUT_ADMISSION_SCHEMA,
        'approval': 'OWNER_ADMITTED_INPUT_BINDING_ONLY',
        'source_owner': owner['source_owner'], 'origin_machine': owner['origin_machine'],
        'expected_uid': owner['owner_uid'], 'job_path': str(JOB),
        'job_identity': job_identity, 'bound_worker_sha256': worker_pin['sha256'],
        'preparation_receipt_sha256': owner['preparation_receipt']['sha256'],
        'producer_source_sha256': INPUT_PRODUCER_SHA256,
        'prepared_inventory_sha256': owner['prepared_inventory']['sha256'],
        'source_review_sha256': review_pin['sha256'],
        'source_review_verdict': review['verdict'],
        'source_review_blocking_findings': review['blocking_findings'],
        'resource_context_sha256': owner['resource_context_sha256'],
        'current_tasks_sha256': owner['current_tasks_sha256'],
        'resource_decision': owner['resource_decision'],
    }

def _relative_pin(role, pin):
    need(type(pin) is dict and type(pin.get('bytes')) is int
         and type(pin.get('sha256')) is str, 'source_role_pin_required:' + role)
    return {'path': role, 'bytes': pin['bytes'], 'sha256': pin['sha256']}

def _producer_namespace(producer_raw, target, owner, worker_pin, manifest):
    namespace = {'__name__': 'ci_native_input_producer_r2_pinned', '__file__': str(target)}
    exec(compile(producer_raw, str(target), 'exec'), namespace)
    namespace['PRODUCER_ENABLED'] = True
    namespace['EXPECTED_UID'] = owner['owner_uid']
    namespace['SOURCE_OWNER'] = owner['source_owner']
    namespace['ORIGIN_MACHINE'] = owner['origin_machine']
    namespace['APPROVED_BOUND_WORKER_PIN'] = {
        'bytes': worker_pin['bytes'], 'sha256': worker_pin['sha256']}
    namespace['FRESH_PREPARATION_RECEIPT_PIN'] = {
        'bytes': owner['preparation_receipt']['bytes'],
        'sha256': owner['preparation_receipt']['sha256']}
    namespace['PREPARED_INVENTORY_PIN'] = {
        'bytes': owner['prepared_inventory']['bytes'],
        'sha256': owner['prepared_inventory']['sha256']}
    return namespace

def safe_relative(value):
    need(type(value) is str and 0 < len(value.encode('utf-8')) <= 1024,
         'safe_relative_path_type_required')
    path = PurePosixPath(value)
    need(not path.is_absolute() and str(path) == value and value != '.'
         and '..' not in path.parts and '.git' not in path.parts and '\\' not in value
         and not any(ord(char) < 32 or ord(char) == 127 for char in value),
         'safe_relative_path_required')
    return value


def raw_pin(path, raw):
    return {'path': str(path), 'bytes': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest()}


def role_raw(bundle, role):
    return bundle['rows'][bundle['subjects'][role]['path']]['raw']


def same_pin(left, right):
    return left['bytes'] == right['bytes'] and left['sha256'] == right['sha256']


def check_source_set(bundle):
    uid = os.getuid()
    entry = bundle['subjects']['native_entry']
    self_raw, _pin = read_regular(Path(__file__).absolute(), maximum=256 * 1024,
                                  owner_uid=uid, expected_bytes=entry['bytes'],
                                  expected_sha256=entry['sha256'])
    pins = review_roles(bundle, self_raw)
    need(same_pin(pins[1], {'bytes': ENABLED_WORKER_BYTES,
                          'sha256': ENABLED_WORKER_SHA256}),
         'exact_static_enabled_worker_required')
    need(same_pin(pins[2], {'bytes': INPUT_PRODUCER_BYTES,
                          'sha256': INPUT_PRODUCER_SHA256}),
         'exact_static_input_producer_R2_required')
    public = bundle['subjects']['public_inputs']
    need(same_pin(public, CONTRACT), 'exact_public_contract_R4_required')
    need(same_pin(bundle['subjects']['resource_guide'], {
        'bytes': 19590,
        'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}),
        'exact_resource_guide_required')
    need(same_pin(bundle['subjects']['resource_policy'], {
        'bytes': 375,
        'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}),
        'exact_resource_policy_required')
    return pins


def check_host(uid):
    need(uid > 0 and os.getuid() == os.geteuid() == uid,
         'positive_CI_owner_UID_required')
    need(os.uname().sysname == 'Darwin' and os.uname().machine == 'arm64',
         'macOS_arm64_required')
    need(sys.executable == PYTHON['path'] and sys.flags.isolated
         and sys.flags.no_site and sys.dont_write_bytecode
         and not sys.flags.optimize,
         'exact_PBS_isolated_interpreter_required')
    need(os.environ.get('HOME') == str(JOB / 'empty-home'),
         'fixed_empty_CI_HOME_required')
    return {str(path): directory_identity(path, uid, private=True)
            for path in (ROOT, JOB, JOB / 'empty-home')}


def verify_preparation(bundle, uid):
    # Only fixed receipt/inventory/contract/reference files are read here.
    # The Worker independently verifies all declared source/artifact bodies.
    contract_raw, _contract_pin = pinned_input(Path(CONTRACT['path']), CONTRACT, uid, 256 * 1024)
    need(contract_raw == role_raw(bundle, 'public_inputs'), 'canonical_contract_bundle_mismatch')
    contract = parse_object(contract_raw, 'public_contract_invalid')
    need(contract.get('schema') == 'studio-Mac-CI-public-runtime-inputs/4',
         'public_contract_schema_required')
    prep_raw, prep_pin = read_regular(JOB / 'CI_PREPARATION_RECEIPT_R1.json',
                                     maximum=2 * 1024**2, owner_uid=uid)
    prep = parse_object(prep_raw, 'fresh_preparation_receipt_invalid')
    need(set(prep) == {'schema', 'at', 'source_owner', 'contract_sha256', 'derivatives',
                       'native_recipe', 'downloads', 'status', 'elapsed_seconds'}
         and prep['schema'] == 'studio-Mac-CI-public-runtime-preparation/2'
         and prep['status'] == 'DATA_PREPARATION_ONLY_NO_NATIVE_ACTION'
         and prep['contract_sha256'] == CONTRACT['sha256']
         and prep['native_recipe'] == contract['native_recipe']
         and type(prep['source_owner']) is str and prep['source_owner']
         and type(prep['elapsed_seconds']) in (int, float)
         and math.isfinite(prep['elapsed_seconds']) and prep['elapsed_seconds'] >= 0,
         'fresh_successful_preparation_required')
    try:
        stamp = datetime.fromisoformat(prep['at'].replace('Z', '+00:00'))
        need(stamp.tzinfo is not None and 0 <= time.time() - stamp.timestamp() <= 3600,
             'preparation_receipt_freshness_required')
    except (TypeError, ValueError, AttributeError) as error:
        raise Refused('preparation_timestamp_invalid') from error
    inventory_raw, inventory_pin = read_regular(JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json',
                                               maximum=8 * 1024**2, owner_uid=uid)
    inventory = parse_object(inventory_raw, 'prepared_inventory_invalid')
    need(set(inventory) == {'python', 'swipl', 'petta', 'chroma', 'pcre2'},
         'closed_prepared_inventory_required')
    count, size = 0, 0
    for records in inventory.values():
        need(type(records) is dict and records, 'nonempty_source_inventory_required')
        for path, pin in records.items():
            safe_relative(path)
            need(type(pin) is dict and set(pin) == {'bytes', 'sha256'}
                 and type(pin['bytes']) is int and 0 <= pin['bytes'] <= 128 * 1024**2
                 and type(pin['sha256']) is str and re.fullmatch('[a-f0-9]{64}', pin['sha256']),
                 'source_inventory_pin_invalid')
            count += 1
            size += pin['bytes']
            need(count <= 50000 and size <= 512 * 1024**2, 'source_inventory_bound')
    for path, pin in ((Path(PYTHON['path']), PYTHON), (Path(RECIPE['path']), RECIPE)):
        pinned_input(path, pin, uid, 32 * 1024**2)
    refs = contract['reference_files']
    need(type(refs) is dict and len(refs) == 10, 'exact_ten_reference_files_required')
    for name, pin in refs.items():
        safe_relative(name)
        need('/' not in name, 'reference_basename_required')
        read_regular(JOB / name, maximum=1024**2, owner_uid=uid,
                     expected_bytes=pin['bytes'], expected_sha256=pin['sha256'])
    for role, dest in (('resource_guide', ROOT / 'project_graph/resources.py'),
                       ('resource_policy', ROOT / 'project_graph/resource-policy.json')):
        source = bundle['subjects'][role]
        actual, _pin = read_regular(dest, maximum=256 * 1024, owner_uid=uid,
                                    expected_bytes=source['bytes'],
                                    expected_sha256=source['sha256'])
        need(actual == role_raw(bundle, role), 'canonical_resource_source_mismatch')
    # Bind actual root-owned binaries as data. They are never executed here.
    tools = {}
    for name in ('ps', 'bash'):
        _raw, tools[name] = read_regular(Path('/bin') / name, maximum=32 * 1024**2,
                                         owner_uid=0)
    return prep_pin, inventory_pin, tools


def wait_resource_admission(sample, budget, cancelled, phase):
    """Retry admission only, sharing one finite wait budget; never retry work."""
    need(type(budget) is dict and set(budget) == {'remaining_seconds'}
         and type(budget['remaining_seconds']) in (int, float)
         and 0 <= budget['remaining_seconds'] <= 600,
         'bounded_admission_wait_budget_required')
    started = time.monotonic()
    available = budget['remaining_seconds']
    deadline = started + available
    waited, observations = False, []
    for index in range(121):
        need(not cancelled(), 'cancelled_before_resource_admission')
        admission = sample()
        need(not cancelled(), 'cancelled_during_resource_admission')
        decision = admission['advice']['decision']
        need(type(decision) is str and decision in {'run', 'wait', 'unknown'},
             'closed_resource_decision_required')
        now = time.monotonic()
        need(now >= started, 'monotonic_resource_wait_clock_required')
        observations.append({'sample': index + 1, 'decision': decision,
                             'elapsed_seconds': now - started})
        waited = waited or decision == 'wait'
        expired = waited and now >= deadline
        if decision != 'wait' or expired:
            if waited:
                budget['remaining_seconds'] = max(0, available - (now - started))
            # An admission that arrives after its wait deadline grants no launch.
            if expired:
                admission = dict(admission)
                admission['advice'] = dict(admission['advice'], decision='wait')
            admission['admission_wait'] = {
                'schema': 'studio-CI-before-work-admission-wait/1',
                'phase': phase, 'waited': waited, 'expired': expired,
                'remaining_seconds': budget['remaining_seconds'],
                'observations': observations, 'worker_retries': 0}
            return admission
        print(json.dumps({'status': 'RESOURCE_WAIT_BEFORE_WORK', 'phase': phase,
                          'sample': index + 1, 'elapsed_seconds': now - started,
                          'remaining_seconds': max(0, deadline - now)}), flush=True)
        pause_until = min(deadline, now + 5)
        while time.monotonic() < pause_until:
            need(not cancelled(), 'cancelled_while_waiting_for_resource_admission')
            time.sleep(min(.25, max(0, pause_until - time.monotonic())))
    raise RuntimeError('resource_wait_sample_cap_no_launch')


ADMISSION_STOP = False


def admission_cancelled(_signum, _frame):
    global ADMISSION_STOP
    ADMISSION_STOP = True


def current_task_attestation(args, uid):
    if args.current_tasks is None:
        return []
    raw, _pin = read_regular(_absolute(args.current_tasks), maximum=256 * 1024,
                             owner_uid=uid)
    value = parse_object(raw, 'current_tasks_attestation_invalid')
    need(set(value) == {'schema', 'complete', 'tasks'}
         and value['schema'] == 'studio-Mac-CI-current-tasks-owner-attestation/1'
         and value['complete'] is True, 'explicit_task_completeness_required')
    return validate_tasks(value['tasks'])


def before_native_admission(args, bundle, uid):
    need(args.dedicated_ci_job is True and 0 <= args.admission_wait_seconds <= 600,
         'explicit_dedicated_CI_bounded_wait_required')
    guide_path = ROOT / 'project_graph/resources.py'
    policy_path = ROOT / 'project_graph/resource-policy.json'
    guide_pin = bundle['subjects']['resource_guide']
    policy_pin = bundle['subjects']['resource_policy']
    estimate = {'ram_gb': 3.125, 'cpu_cores': 2.25, 'disk_gb': 8, 'kind': 'task'}
    def sample():
        guide_raw, _pin = read_regular(guide_path, maximum=256 * 1024, owner_uid=uid,
            expected_bytes=guide_pin['bytes'], expected_sha256=guide_pin['sha256'])
        policy_raw, _pin = read_regular(policy_path, maximum=65536, owner_uid=uid,
            expected_bytes=policy_pin['bytes'], expected_sha256=policy_pin['sha256'])
        need(guide_raw == role_raw(bundle, 'resource_guide')
             and policy_raw == role_raw(bundle, 'resource_policy'),
             'canonical_resource_source_mismatch')
        namespace = {'__name__': 'studio_CI_native_entry_resource', '__file__': str(guide_path)}
        exec(compile(guide_raw, str(guide_path), 'exec'), namespace)
        started = time.monotonic()
        snapshot = namespace['sample'](force=True)
        disk = os.statvfs(ROOT)
        snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                            'free_bytes': disk.f_bavail * disk.f_frsize}
        tasks = current_task_attestation(args, uid)
        advice = namespace['advise'](snapshot, estimate, tasks)
        need(time.monotonic() - started <= 15
             and advice.get('policy', {}).get('sha256') == policy_pin['sha256'],
             'fresh_actual_resource_policy_required')
        return {'at': snapshot['checked_at'], 'pressure': snapshot['memory']['pressure'],
                'advice': advice, 'estimate': estimate, 'current_tasks': tasks}
    signal.signal(signal.SIGTERM, admission_cancelled)
    signal.signal(signal.SIGINT, admission_cancelled)
    advice = wait_resource_admission(sample,
        {'remaining_seconds': args.admission_wait_seconds},
        lambda: ADMISSION_STOP, 'native-before-owner-facts')
    if advice['advice']['decision'] != 'run':
        print(json.dumps({'status': 'NOT_RUN_RESOURCE_' + advice['advice']['decision'].upper(),
                          'admission': advice, 'worker_retry': False}), flush=True)
        return None
    need(not ADMISSION_STOP, 'cancelled_before_native_owner_facts')
    return advice


def owner_facts(args, uid, job_identity, prep_pin, inventory_pin, bundle):
    # The dedicated-job switch is the operator's explicit completeness and
    # reservation attestation; it is not an independent source review or a
    # distributed Hive admission. Parent samples resources again before Popen.
    need(args.dedicated_ci_job is True, 'explicit_dedicated_CI_attestation_required')
    tasks = current_task_attestation(args, uid)
    now = int(time.time())
    source_owner = bundle['common']['source_owner']
    origin = os.uname().nodename
    need(type(origin) is str and 1 <= len(origin) <= 128, 'origin_machine_required')
    resource_context = {
        'schema': 'studio-Mac-CI-native-entry-owner-resource-facts/1',
        'status': 'CI_OWNER_ATTESTED', 'execution_owner': args.owner,
        'owner_uid': uid, 'origin_machine': origin, 'job_identity': job_identity,
        'dedicated_ci_job': True, 'current_tasks': tasks,
        'current_tasks_complete': True, 'current_tasks_sha256': _task_digest(tasks),
        'limits': TASK_LIMITS,
        'scope': 'CI owner reservation attestation; Parent samples resources before spawn.'}
    resource_raw = canonical_json(resource_context, 256 * 1024)
    return {
        'source_owner': source_owner, 'origin_machine': origin,
        'execution_owner': args.owner, 'owner_uid': uid, 'job_identity': job_identity,
        'task_id': 'native-runtime-' + bundle['checksum_pin']['sha256'][:24],
        'resource_id': 'dedicated-ci-' + str(uid) + '-' + str(job_identity[0]) + '-' + str(job_identity[1]),
        'current_tasks': tasks, 'current_tasks_sha256': _task_digest(tasks),
        'current_tasks_complete': True, 'preparation_receipt': prep_pin,
        'prepared_inventory': inventory_pin,
        'resource_context_sha256': hashlib.sha256(resource_raw).hexdigest(),
        'resource_decision': 'run', 'observed_at_epoch': now,
        'valid_until_epoch': now + 1900,
        'attestation_kind': 'CI_OWNER_ATTESTED', 'resource_context': resource_context}


def ensure_private(path, uid):
    # Create only canonical native-source/native-parent, after all source and
    # preparation validation. Never change an existing directory's permissions.
    need(path in (NATIVE, PARENT_DIR), 'fixed_native_directory_required')
    fd, info = _open_dir(ROOT)
    try:
        need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
             'private_CI_ROOT_required')
        try:
            os.mkdir(path.name, 0o700, dir_fd=fd)
        except FileExistsError:
            pass
    finally:
        os.close(fd)
    return directory_identity(path, uid, private=True)


def make_context(owner, review_pin, parent_pin, worker_pin, inputs_pin, tools):
    # Generate the snapshot immediately before exec, separately from the lease.
    epoch = time.time()
    lease = int(epoch) + 1900
    observed = datetime.fromtimestamp(epoch, timezone.utc).isoformat()
    expires = datetime.fromtimestamp(epoch + 60, timezone.utc).isoformat()
    common = {
        'valid_until_epoch': lease, 'resource_id': owner['resource_id'],
        'execution_owner': owner['execution_owner'], 'owner_uid': owner['owner_uid'],
        'job_path': str(JOB), 'job_identity': owner['job_identity'],
        'parent_source_sha256': parent_pin['sha256'],
        'static_review_sha256': review_pin['sha256'],
        'worker_sha256': worker_pin['sha256'], 'inputs_sha256': inputs_pin['sha256'],
        'source_owner': owner['source_owner'], 'origin_machine': owner['origin_machine']}
    return {
        'schema': CONTEXT_SCHEMA, 'owner_uid': owner['owner_uid'],
        'execution_owner': owner['execution_owner'], 'job_path': str(JOB),
        'job_identity': owner['job_identity'],
        'parent_source': _relative_pin(PARENT_REL, parent_pin),
        'static_review_pin': review_pin, 'inputs': inputs_pin,
        'system_tools': tools, 'source_owner': owner['source_owner'],
        'origin_machine': owner['origin_machine'],
        'current_tasks': owner['current_tasks'],
        'current_tasks_sha256': owner['current_tasks_sha256'], 'current_tasks_complete': True,
        'task_admission': {'schema': OWNER_TASK_SCHEMA, 'status': 'OWNER_ADMITTED_NATIVE_PARENT',
                           **common, 'task_id': owner['task_id'], 'limits': dict(TASK_LIMITS)},
        'resource_admission': {'schema': OWNER_RESOURCE_SCHEMA, 'status': 'RESERVED_NATIVE_PARENT',
                               **common, 'reserved_limits': dict(TASK_LIMITS)},
        'observed_at': observed, 'expires_at': expires}


def bind_and_exec(args, bundle, pins):
    uid = os.getuid()
    identities = check_host(uid)
    need(not os.path.lexists(PARENT_DIR / 'NATIVE_ENTRY_LAUNCH_R1.json'),
         'prior_native_launch_retained_new_CI_job_required')
    prep_pin, inventory_pin, tools = verify_preparation(bundle, uid)
    resource_admission = before_native_admission(args, bundle, uid)
    if resource_admission is None:
        return 75
    # Preparation, fixed binaries and identities may have changed during a wait.
    prep_pin, inventory_pin, tools = verify_preparation(bundle, uid)
    for path, identity in identities.items():
        need(directory_identity(Path(path), uid, private=True) == identity,
             'CI_directory_identity_changed_during_admission_wait')
    need(not ADMISSION_STOP, 'cancelled_before_native_owner_facts')
    owner = owner_facts(args, uid, identities[str(JOB)], prep_pin, inventory_pin, bundle)
    parent_pin, worker_pin, producer_pin = pins
    ensure_private(NATIVE, uid)
    ensure_private(PARENT_DIR, uid)
    for role, destination in (('native_parent', PARENT_SOURCE),
                               ('native_worker_enabled', WORKER_TARGET),
                               ('native_entry', DRIVER_TARGET),
                               ('input_producer', PRODUCER_TARGET)):
        raw = role_raw(bundle, role)
        _ensure_exact_or_write(destination, raw, raw_pin(destination, raw), uid)
    review_raw = bundle['component_raw']
    review_pin = _ensure_exact_or_write(STATIC_REVIEW, review_raw,
                                        bundle['component_pin'], uid)
    producer = _producer_namespace(role_raw(bundle, 'input_producer'), PRODUCER_TARGET,
                                   owner, worker_pin, bundle)
    admission = _producer_admission(owner, owner['job_identity'], bundle['component'],
                                    review_pin, worker_pin)
    admission_raw = canonical_json(admission, 64 * 1024)
    admission_sha = hashlib.sha256(admission_raw).hexdigest()
    producer['validate_static_gates'](argparse.Namespace(
        source_sha256=producer_pin['sha256'], owner_admission_bytes=len(admission_raw),
        owner_admission_sha256=admission_sha))
    producer['validate_owner_admission'](admission, owner['job_identity'], producer_pin['sha256'])
    # Never refresh or rewrite input bindings. A pre-existing exact binding may
    # be reused only before the Parent has created any attempt evidence.
    try:
        inputs_raw, inputs_pin = read_regular(INPUTS_TARGET, maximum=INPUT_LIMIT, owner_uid=uid)
        existing = parse_object(inputs_raw, 'existing_native_inputs_invalid')
        expected_roles = {'worker': worker_pin, 'python': PYTHON, 'ps': tools['ps'],
                          'bash': tools['bash'], 'recipe': RECIPE, 'preparation': prep_pin,
                          'contract': CONTRACT, 'prepared_inventory': inventory_pin}
        need(set(existing) == {'schema', 'source_owner', 'origin_machine', 'job_path', 'roles', 'scope'}
             and existing['schema'] == 'studio-Mac-CI-native-phase-inputs/1'
             and existing['source_owner'] == owner['source_owner']
             and existing['origin_machine'] == owner['origin_machine']
             and existing['job_path'] == str(JOB) and existing['roles'] == expected_roles,
             'existing_native_input_binding_mismatch')
    except FileNotFoundError:
        inputs_pin = producer['produce_binding'](admission, producer_pin['sha256'])
        inputs_raw, _pin = pinned_input(INPUTS_TARGET, inputs_pin, uid, INPUT_LIMIT)
    binding = parse_object(inputs_raw, 'native_inputs_invalid')
    need(set(binding['roles']) == {'worker', 'python', 'ps', 'bash', 'recipe', 'preparation',
                                  'contract', 'prepared_inventory'}, 'exact_eight_native_roles_required')
    need(binding['roles']['ps'] == tools['ps'] and binding['roles']['bash'] == tools['bash'],
         'system_tools_changed_during_binding')
    # Retain owner admission facts as immutable evidence, never call them a new
    # independent PASS or synthesize any source review at runtime.
    facts_raw = canonical_json({'schema': 'studio-Mac-CI-native-entry-owner-facts/1',
        'status': 'CI_OWNER_ATTESTED', 'owner': owner, 'producer_admission': admission,
        'whole_review': bundle['common_pin'], 'component_review': review_pin,
        'manifest': bundle['checksum_pin'], 'inputs': inputs_pin,
        'prelaunch_resource_admission': resource_admission}, 256 * 1024)
    facts_path = PARENT_DIR / ('OWNER_FACTS_' + hashlib.sha256(facts_raw).hexdigest() + '.json')
    _ensure_exact_or_write(facts_path, facts_raw, raw_pin(facts_path, facts_raw), uid)
    for path, identity in identities.items():
        need(directory_identity(Path(path), uid, private=True) == identity,
             'CI_directory_identity_changed_before_exec')
    # Recheck exact executable bytes and every immutable role before the final
    # context snapshot and exec, so no producer module remains resident.
    pinned_input(Path(PYTHON['path']), PYTHON, uid, 32 * 1024**2)
    for pin in (parent_pin, worker_pin, producer_pin, review_pin):
        pinned_input(Path(pin['path']), pin, uid, 256 * 1024)
    need(not ADMISSION_STOP, 'cancelled_before_native_context_lease')
    context = make_context(owner, review_pin, parent_pin, worker_pin, inputs_pin, tools)
    context_pin = refresh_owner_context(canonical_json(context, 256 * 1024), uid)
    argv = [PYTHON['path'], '-I', '-B', '-S', str(PARENT_SOURCE),
            '--source-bytes', str(parent_pin['bytes']), '--source-sha256', parent_pin['sha256'],
            '--static-review-bytes', str(review_pin['bytes']),
            '--static-review-sha256', review_pin['sha256'],
            '--owner-context-bytes', str(context_pin['bytes']),
            '--owner-context-sha256', context_pin['sha256'], '--run']
    launch_raw = canonical_json({'schema': 'studio-Mac-CI-native-entry-launch/1',
        'status': 'OWNER_ATTESTED_HANDOFF_ATTEMPT', 'owner_context': context_pin,
        'inputs': inputs_pin, 'parent': parent_pin, 'component_review': review_pin,
        'scope': 'Exclusive launch intent; Parent result determines actual native outcome.'}, 64 * 1024)
    write_new(PARENT_DIR / 'NATIVE_ENTRY_LAUNCH_R1.json', launch_raw, owner_uid=uid)
    env = {'HOME': str(JOB / 'empty-home'), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'LANG': 'C', 'LC_ALL': 'C'}
    os.chdir(ROOT)
    need(not ADMISSION_STOP, 'cancelled_before_native_exec')
    os.execve(PYTHON['path'], argv, env)
    raise Refused('parent_exec_returned')


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False,
        description='Validate sealed Stage 1 sources; --run binds owner facts and execs Parent.')
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--static-review', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--dedicated-ci-job', action='store_true')
    parser.add_argument('--current-tasks', help='Optional closed owner task attestation JSON (absolute path).')
    parser.add_argument('--admission-wait-seconds', type=int, default=600)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args(argv)
    try:
        need(type(args.owner) is str and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', args.owner),
             'safe_owner_tag_required')
        need(os.getuid() > 0 and os.geteuid() == os.getuid(), 'positive_current_owner_required')
        bundle = load_bundle(args.manifest, args.manifest_sha256, args.static_review)
        pins = check_source_set(bundle)
        if not args.run:
            print(json.dumps({'status': 'READ_ONLY_SOURCE_PLAN_NO_NATIVE_ACTION',
                'manifest_sha256': bundle['checksum_pin']['sha256'],
                'whole_review_sha256': bundle['common_pin']['sha256'],
                'component_review_sha256': bundle['component_pin']['sha256'],
                'next': 'Same public CLI plus --run after successful portable preparation.'}, sort_keys=True))
            return 0
        result = bind_and_exec(args, bundle, pins)
        return 75 if result == 75 else 0
    except (Refused, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'status': 'REFUSED_NO_AUTOMATIC_RETRY',
                          'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
                          'qualification': 'NONE'}, sort_keys=True), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
