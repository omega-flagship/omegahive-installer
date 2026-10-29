"""Portable Stage2 owner entry; immutable Source and real serial phase workers.

Candidate Source. A genuine externally sealed ten-role review, independent
component validation, fresh dedicated-CI admission and all dependencies are
required before this source can execute. No source review is produced at runtime.
"""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import argparse
import ast
import ctypes
import errno
import hashlib
import json
import math
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
BUNDLE = JOB / 'OmegaHive.bundle'
HERE = ROOT / 'stage2-source'
PARENT = ROOT / 'stage2-parent'
RECEIPTS = JOB / 'receipts'
SOURCE_PATH = HERE / 'stage2_entry.py'
REVIEW_NAME = 'STATIC_STAGE2_SOURCE_REVIEW.json'
ROLES = {
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
STAGE1_ROLES = {'prep_entry', 'prep_parent_library', 'prep_worker_enabled',
    'prep_prototype', 'public_inputs', 'resource_guide', 'resource_policy',
    'native_entry', 'native_parent', 'native_worker_enabled', 'input_producer'}
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
PYTHON_PIN = {'bytes': 18652104, 'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
GUIDE_PIN = {'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}
POLICY_PIN = {'bytes': 375, 'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
ESTIMATE = {'ram_gb': 3.125, 'cpu_cores': 2.25, 'disk_gb': 4, 'kind': 'task'}
PHASE_SECONDS = {'finalize': 935, 'native_audit': 1800, 'copy': 935,
                 'relocation': 1800, 'seal': 935}
WHOLE_SECONDS = 6900
STOP = False
LIBPROC = None
PS_PIN = None
PBS_STOCK = {
    'python/bin/2to3-3.12': {'bytes': 158, 'sha256': 'f48f1c0840af7b30dac604fc0cd720b882a233b9eb571677a4df108a9eeaf32c'},
    'python/bin/idle3.12': {'bytes': 156, 'sha256': '4ee1fe32bc385f4a8c0126daef3d45fe83febf4d91b20669305392e01bcc343d'},
    'python/bin/pydoc3.12': {'bytes': 141, 'sha256': 'b09b14b62a6976902b026cb58d8fb6c1fad5fc824913e01035a8802ec3e594be'},
    'python/bin/python3.12-config': {'bytes': 2100, 'sha256': '2b10c2f47d035259835eab4c68c34b026184d52b548dbe6886911fa548648948'},
}
PBS_EXTRA = {'pip': {'version': '26.2.1',
    'metadata': 'python/lib/python3.12/site-packages/pip-26.2.1.dist-info/METADATA',
    'bytes': 4617, 'sha256': '3a561005822841f2c45f442f6c7a7505172c8c376c9fe274d876c8ac912968cb'}}


# Terminal diagnostics are observational only. Never print arbitrary exception
# bodies, argv, environment values or caller-supplied path strings.
TERMINAL_DIAGNOSTIC_SCHEMA = 'studio-CI-stage2-terminal-diagnostic/1'
TERMINAL_DIAGNOSTIC_MAX_BYTES = 2048
TERMINAL_CONTEXT = {'attempt_id': None, 'phase': None}
TERMINAL_FAILURE_STATUSES = frozenset({
    'FAILED_RETAINED_NO_AUTOMATIC_RETRY', 'NOT_RUN_RESOURCE_WAIT',
    'NOT_RUN_RESOURCE_UNKNOWN', 'NOT_RUN_RESOURCE_INVALID'})
TERMINAL_ERROR_TYPES = frozenset(('AssertionError', 'AttributeError', 'AuditRefused', 'BlockingIOError', 'BrokenPipeError', 'CalledProcessError', 'ChildProcessError', 'EOFError', 'FileExistsError', 'FileNotFoundError', 'ImportError', 'IndexError', 'InputRefused', 'InterruptedError', 'IsADirectoryError', 'JSONDecodeError', 'KeyError', 'KeyboardInterrupt', 'MemoryError', 'ModuleNotFoundError', 'NameError', 'NotADirectoryError', 'OSError', 'OverflowError', 'PermissionError', 'ProcessLookupError', 'RecursionError', 'Refused', 'RunnerRefused', 'RuntimeError', 'RuntimeRefused', 'SyntaxError', 'SystemExit', 'TimeoutError', 'TimeoutExpired', 'TypeError', 'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'ValueError'))
TERMINAL_REASON_LABELS = frozenset(('AssertionError', 'AttributeError', 'AuditRefused', 'BlockingIOError', 'BrokenPipeError', 'CI_parent_namespace_entry_bound', 'CalledProcessError', 'ChildProcessError', 'Darwin_positive_process_identity_required', 'EOFError', 'FileExistsError', 'FileNotFoundError', 'ImportError', 'IndexError', 'InputRefused', 'InterruptedError', 'IsADirectoryError', 'JSONDecodeError', 'JSON_object_required', 'JSON_output_byte_bound', 'KeyError', 'KeyboardInterrupt', 'MachO_header_changed_during_read', 'MemoryError', 'ModuleNotFoundError', 'NameError', 'NotADirectoryError', 'OSError', 'OverflowError', 'PermissionError', 'ProcessLookupError', 'RecursionError', 'Refused', 'RunnerRefused', 'RuntimeError', 'RuntimeRefused', 'SyntaxError', 'SystemExit', 'TimeoutError', 'TimeoutExpired', 'TypeError', 'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'ValueError', 'absolute_file_required', 'actual_arm64_Python_SWIPL_main_images_required', 'actual_bridge_child_of_phase_worker_required', 'actual_clean_copy_phase_and_relocation_content_required', 'actual_closed_runner_receipt_and_return_required', 'actual_command_birth_session_before_ACK_required', 'actual_completed_phase_observation_gap_or_deadline', 'actual_dynamic_loader_context_link_bound', 'actual_eight_audit_checks_required', 'actual_entry_must_be_sealed_subject', 'actual_finalization_required', 'actual_native_parent_receipt_link_required', 'actual_new_phase_worker_birth_required', 'actual_new_session_command_required', 'actual_owned_phase_startup_required', 'actual_owner_and_reservation_pin_links_required', 'actual_parent_census_required', 'actual_phase_GO_required', 'actual_phase_admission_context_required', 'actual_phase_session_handshake_required', 'actual_phase_worker_birth_required', 'actual_preparation_parent_phase_required', 'actual_private_phase_environment_required', 'actual_registered_phase_parent_session_required', 'actual_runner_resource_and_command_counts_required', 'actual_stage1_sealed_sources_required', 'actual_successful_runner_lifecycle_required', 'audit_or_runner_finish_failed_retained', 'bounded_command_registration_namespace_required', 'bounded_fat_architecture_table_required', 'bounded_fat_header_required', 'bounded_original_parent_release_required', 'bounded_output_bytes_required', 'bounded_owned_singlelink_regular_file_required', 'bounded_process_census_required', 'bounded_relative_path_required', 'cancelled_before_new_work_output', 'cancelled_before_phase_spawn', 'cancelled_before_stage2_materialization', 'cancelled_during_held_read', 'canonical_absolute_directory_required', 'canonical_owned_phase_context_required', 'canonical_relative_path_required', 'canonical_source_copy_changed', 'canonical_stage2_source_role_path_required', 'canonical_system_PATH_required_before_resource_probes', 'checksum_manifest_changed_or_not_LF', 'clean_actual_stage1_parent_required', 'clean_original_phase_completion_required', 'closed_complete_current_task_attestation_required', 'closed_current_phase_command_registration_required', 'closed_current_task_estimate_required', 'closed_kernel_command_birth_required', 'closed_owned_phase_CLI_required', 'closed_review_source_role_set_required', 'closed_stage2_phase_required', 'closed_unique_current_task_required', 'commands_only_in_actual_audit_phase', 'complete_MachO_header_required', 'complete_numeric_process_census_required', 'component_main_returned_failure', 'current_owned_kernel_process_birth_required', 'current_owner_host_phase_source_required', 'current_root_owned_ps_pin_required', 'current_task_pid_required', 'duplicate_JSON_key', 'duplicate_or_self_manifest_entry', 'every_actual_command_group_closed_cleanly_required', 'every_closed_command_kernel_birth_required', 'exact_isolated_PBS_macOS_arm64_owner_required', 'exact_phase_context_required', 'exact_resource_guide_policy_required', 'explicit_dedicated_GitHub_CI_owner_required', 'externally_pinned_source_manifest_required', 'fat_arm64_MachO_header_required', 'fat_slice_bounds_required', 'file_growth_bound', 'finalized_MachO_entry_identity_required', 'finite_current_task_peak_required', 'foreign_worker_descendant', 'fresh_actual_resource_policy_required', 'fresh_full_phase_resource_RUN_required', 'fresh_generated_cache_total_bound', 'fresh_generated_site_cache_shape_required', 'fresh_original_phase_controller_deadline_required', 'fresh_stage2_no_automatic_retry_required', 'full_phase_wall_envelope_remaining_required', 'full_worker_group_and_parent_RSS_guard', 'genuine_closed_source_review_required', 'genuine_source_review_must_be_sealed', 'held_file_identity_changed', 'held_file_pin_mismatch', 'immutable_empty_protocol_marker_required', 'immutable_existing_ack_must_match', 'kernel_process_birth_identity_unavailable', 'live_descendant_group_birth_required', 'new_genuinely_reviewed_stage1_wait_entries_required', 'nonfinite_JSON_number', 'one_exact_arm64_slice_required', 'one_fresh_actual_parent_attempt_required', 'original_group_birth_anchor_required', 'owned_log_file_required', 'owned_member_PID_birth_changed', 'owned_new_session_identity_required', 'phase_cancel_deadline_or_parent_log_guard', 'phase_cleanup_deadline', 'phase_context_metadata_bound', 'phase_original_work_deadline_required', 'phase_resource_admission_expired_before_GO', 'phase_result_metadata_bound', 'phase_terminal_parent_log_guard', 'plain_directory_required', 'plain_parent_attempt_required', 'preexisting_exact_stage2_source_required', 'private_current_owner_directory_required', 'resource_admission_not_run', 'runner_closure_actual_owner_admission_pin_required', 'sealed_stage2_sources_required', 'selected_phase_admission_pin_required', 'short_output_write', 'source_payload_checksum_mismatch', 'source_review_attribution_required', 'source_set_total_byte_bound', 'stage1_canonical_resource_sources_required', 'stage1_genuine_component_review_checksum_required', 'stage1_review_must_describe_actual_preparation', 'standard_bounded_checksum_manifest_required', 'supported_arm64_runtime_image_required', 'system_exit_nonzero', 'undeclared_dynamic_image_loader_policy', 'unique_census_PID_required', 'unregistered_or_foreign_worker_process_group', 'worker_descendant_new_session_ownership_required'))


def terminal_result_paths(attempt_id, phase):
    """Derive fixed reported targets only; no path input, resolution or reads."""
    if type(attempt_id) is not str or re.fullmatch('attempt-[a-f0-9]{32}', attempt_id) is None:
        return None, None
    result = str(PARENT / attempt_id / 'STAGE2_RESULT.json')
    phase_result = (str(PARENT / attempt_id / phase / 'PARENT_RESULT.json')
                    if type(phase) is str and phase in PHASE_SECONDS else None)
    return result, phase_result


def emit_terminal_failure(status, error_type=None, reason=None, *, worker_started=None):
    """One bounded stdout line; diagnostic failures never alter control outcome."""
    try:
        safe_status = (status if type(status) is str and status in TERMINAL_FAILURE_STATUSES
                       else 'FAILED_RETAINED_NO_AUTOMATIC_RETRY')
        safe_type = (error_type if type(error_type) is str and error_type in TERMINAL_ERROR_TYPES
                     else None if error_type is None else 'OtherException')
        safe_reason = (reason if type(reason) is str and reason in TERMINAL_REASON_LABELS
                       else 'unrecognized_or_redacted_reason')
        phase = TERMINAL_CONTEXT.get('phase')
        phase = phase if type(phase) is str and phase in PHASE_SECONDS else None
        result, phase_result = terminal_result_paths(TERMINAL_CONTEXT.get('attempt_id'), phase)
        value = {'schema': TERMINAL_DIAGNOSTIC_SCHEMA, 'status': safe_status,
            'error_type': safe_type, 'reason': safe_reason, 'result': result,
            'phase_context': phase, 'phase_result': phase_result,
            'path_scope': 'reported_fixed_targets_not_receipt_custody',
            'worker_started': False if worker_started is False else None,
            'worker_exit': None, 'worker_reaped': None, 'group_absent': None,
            'signals': None, 'qualification': 'NONE'}
        text = json.dumps(value, sort_keys=True, separators=(',', ':'),
                          ensure_ascii=True, allow_nan=False)
        if len(text.encode('ascii')) > TERMINAL_DIAGNOSTIC_MAX_BYTES:
            value.update(error_type='OtherException', reason='terminal_diagnostic_bound',
                         result=None, phase_context=None, phase_result=None)
            text = json.dumps(value, sort_keys=True, separators=(',', ':'),
                              ensure_ascii=True, allow_nan=False)
        print(text, flush=True)
    except BaseException:
        # The original outcome/exception and receipt writes remain authoritative.
        pass


class Refused(RuntimeError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def cancelled(_signal, _frame):
    global STOP
    STOP = True


def process_birth(pid):
    """Darwin's kernel process start identity detects numeric PID reuse.

    Apple's public proc_info.h declares flavor3 and proc_bsdinfo's 136-byte
    arm64 layout. Only PID and kernel start time are retained, never process
    names or account records. UID/PID/PGID are corroborated as live ownership.
    """
    global LIBPROC
    need(sys.platform == 'darwin' and type(pid) is int and pid > 0,
         'Darwin_positive_process_identity_required')
    if LIBPROC is None:
        LIBPROC = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        LIBPROC.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                        ctypes.c_void_p, ctypes.c_int]
        LIBPROC.proc_pidinfo.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(136)
    ctypes.set_errno(0)
    size = LIBPROC.proc_pidinfo(pid, 3, 0, buffer, 136)
    if size == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    need(size == 136, 'kernel_process_birth_identity_unavailable')
    actual_pid = struct.unpack_from('=I', buffer.raw, 12)[0]
    uid = struct.unpack_from('=I', buffer.raw, 20)[0]
    seconds, microseconds = struct.unpack_from('=QQ', buffer.raw, 120)
    need(actual_pid == pid and uid == os.getuid() and seconds > 0
         and 0 <= microseconds < 1_000_000, 'current_owned_kernel_process_birth_required')
    return {'pid': pid, 'start_tvsec': seconds, 'start_tvusec': microseconds}


def pin(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def relative(name):
    need(type(name) is str and 0 < len(name) <= 1024 and '\x00' not in name,
         'bounded_relative_path_required')
    value = PurePosixPath(name)
    need(not value.is_absolute() and str(value) == name and name != '.'
         and '..' not in value.parts and '\\' not in name,
         'canonical_relative_path_required')
    return name


def object_bytes(raw):
    def pairs(rows):
        value = {}
        for key, item in rows:
            need(key not in value, 'duplicate_JSON_key')
            value[key] = item
        return value
    def invalid(_value):
        raise Refused('nonfinite_JSON_number')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    need(type(value) is dict, 'JSON_object_required')
    return value


def json_bytes(value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'),
                      allow_nan=False) + '\n').encode()
    need(len(raw) <= 64 * 1024**2, 'JSON_output_byte_bound')
    return raw


def directory(path, *, private=False):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)),
         'canonical_absolute_directory_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        need(stat.S_ISDIR(info.st_mode), 'plain_directory_required')
        if private:
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                 'private_current_owner_directory_required')
        return fd, [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]
    except BaseException:
        os.close(fd)
        raise


def identity(path):
    fd, result = directory(path, private=True)
    os.close(fd)
    return result


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_file(path, maximum, expected=None, *, owner=None, keep=True,
              cancellation_independent=False):
    path = Path(path)
    need(path.is_absolute() and path.name not in {'', '.', '..'}, 'absolute_file_required')
    parent, _identity = directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and 0 < before.st_size <= maximum
             and before.st_uid == (os.getuid() if owner is None else owner),
             'bounded_owned_singlelink_regular_file_required')
        chunks, size, digest = [], 0, hashlib.sha256()
        while True:
            need(cancellation_independent or not STOP, 'cancelled_during_held_read')
            block = os.read(fd, 65536)
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'file_growth_bound')
            if keep:
                chunks.append(block)
            digest.update(block)
        need(size == before.st_size and file_key(before) == file_key(os.fstat(fd))
             == file_key(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
             'held_file_identity_changed')
        observed = {'path': str(path), 'bytes': size, 'sha256': digest.hexdigest()}
        if expected is not None:
            need(type(expected) is dict and type(expected.get('bytes')) is int
                 and all(observed[key] == expected.get(key) for key in ('bytes', 'sha256')),
                 'held_file_pin_mismatch')
        return b''.join(chunks) if keep else b'', observed
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def write_new(path, raw, *, completion_only=False):
    path = Path(path)
    need(type(raw) is bytes and 0 < len(raw) <= 64 * 1024**2,
         'bounded_output_bytes_required')
    need(completion_only or not STOP, 'cancelled_before_new_work_output')
    parent, _identity = directory(path.parent, private=True)
    fd = None
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            need(count > 0, 'short_output_write')
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, 0o400)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)
    return read_file(path, len(raw), pin(raw), keep=False,
                     cancellation_independent=True)[1]


def write_json(path, value, *, completion_only=False):
    return write_new(path, json_bytes(value), completion_only=completion_only)


def load_sources(manifest, digest, *, stage1=False):
    manifest = Path(manifest)
    need(manifest.is_absolute() and manifest.name == 'MANIFEST.sha256'
         and type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest),
         'externally_pinned_source_manifest_required')
    raw, manifest_pin = read_file(manifest, 128 * 1024)
    need(pin(raw)['sha256'] == digest and raw.endswith(b'\n')
         and b'\r' not in raw and b'\x00' not in raw, 'checksum_manifest_changed_or_not_LF')
    bodies, pins, total = {}, {}, 0
    for line in raw.decode('ascii').splitlines():
        row = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
        need(row is not None and len(bodies) < 128, 'standard_bounded_checksum_manifest_required')
        sha, name = row.groups()
        relative(name)
        need(name != 'MANIFEST.sha256' and name not in bodies, 'duplicate_or_self_manifest_entry')
        body, observed = read_file(manifest.parent / name, 256 * 1024)
        need(pin(body)['sha256'] == sha and b'\x00' not in body, 'source_payload_checksum_mismatch')
        body.decode('utf-8')
        total += len(body)
        need(total <= 3 * 1024**2, 'source_set_total_byte_bound')
        bodies[name], pins[name] = body, {'path': name, **pin(body)}
    review_name = 'STATIC_SOURCE_REVIEW.json' if stage1 else REVIEW_NAME
    need(review_name in bodies, 'genuine_source_review_must_be_sealed')
    review = object_bytes(bodies[review_name])
    fields = {'schema', 'verdict', 'blocking_findings', 'reviewer', 'source_owner',
              'origin_machine', 'subjects', 'scope'}
    if stage1:
        fields.add('native_component_review')
    need(set(review) == fields and review['schema'] ==
         ('studio-Mac-CI-stage1-static-source-review/1' if stage1 else
          'studio-Mac-CI-stage2-static-source-review/1')
         and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == [],
         'genuine_closed_source_review_required')
    need(all(type(review[key]) is str and 0 < len(review[key]) <= 128
             for key in ('reviewer', 'source_owner', 'origin_machine'))
         and type(review['scope']) is str and 0 < len(review['scope']) <= 4096,
         'source_review_attribution_required')
    subjects = review['subjects']
    need(type(subjects) is dict and set(subjects) == (STAGE1_ROLES if stage1 else set(ROLES)),
         'closed_review_source_role_set_required')
    for role, subject in subjects.items():
        need(type(subject) is dict and set(subject) == {'path', 'bytes', 'sha256'}
             and type(subject['bytes']) is int and subject['bytes'] > 0
             and subject == pins.get(subject['path']), 'review_subject_checksum_mismatch:' + role)
        if not stage1:
            need(subject['path'] == ROLES[role], 'canonical_stage2_source_role_path_required')
    if stage1:
        component = review['native_component_review']
        need(component == pins.get('STATIC_NATIVE_SOURCE_REVIEW.json'),
             'stage1_genuine_component_review_checksum_required')
    return {'root': manifest.parent, 'manifest': manifest_pin, 'manifest_raw': raw,
            'bodies': bodies, 'pins': pins, 'review': review,
            'review_raw': bodies[review_name], 'review_pin': pins[review_name]}


def source_namespace(sources, role):
    name = ROLES[role]
    raw, _pin = read_file(ROOT / name, 256 * 1024, sources['review']['subjects'][role])
    need(raw == sources['bodies'][name], 'canonical_source_copy_changed')
    value = {'__name__': 'owner_admitted_stage2_' + role, '__file__': str(ROOT / name)}
    exec(compile(raw, str(ROOT / name), 'exec'), value)
    return value


def call_main(namespace, arguments):
    prior = sys.argv
    try:
        sys.argv = [namespace['__file__'], *arguments]
        result = namespace['main']()
        need(result in (None, 0), 'component_main_returned_failure')
    finally:
        sys.argv = prior


def require_system_path():
    need(os.environ.get('PATH') == SYSTEM_PATH,
         'canonical_system_PATH_required_before_resource_probes')


def resource_admission(sources, current_tasks):
    require_system_path()
    guide = source_namespace(sources, 'resource_guide')
    read_file(ROOT / ROLES['resource_policy'], 65536, POLICY_PIN)
    need(pin(sources['bodies'][ROLES['resource_guide']]) == GUIDE_PIN
         and pin(sources['bodies'][ROLES['resource_policy']]) == POLICY_PIN,
         'exact_resource_guide_policy_required')
    started = time.monotonic()
    snapshot = guide['sample'](force=True)
    disk = os.statvfs(JOB)
    snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                        'free_bytes': disk.f_bavail * disk.f_frsize}
    advice = guide['advise'](snapshot, ESTIMATE, current_tasks)
    need(time.monotonic() - started < 15 and advice.get('policy', {}).get('sha256')
         == POLICY_PIN['sha256'], 'fresh_actual_resource_policy_required')
    return {'at': snapshot['checked_at'], 'pressure': snapshot['memory']['pressure'],
            'advice': advice, 'estimate': ESTIMATE, 'current_tasks': current_tasks}


def one_parent(container, phase=None):
    """Only the admitted fresh CI's immediate declared attempt-result namespace."""
    fd, _identity = directory(container, private=True)
    names = []
    try:
        with os.scandir(fd) as listing:
            for index, entry in enumerate(listing):
                need(index < 256, 'CI_parent_namespace_entry_bound')
                if re.fullmatch('attempt-[a-f0-9]{32}', entry.name):
                    need(entry.is_dir(follow_symlinks=False), 'plain_parent_attempt_required')
                    names.append(entry.name)
    finally:
        os.close(fd)
    need(len(names) == 1, 'one_fresh_actual_parent_attempt_required')
    path = container / names[0] / 'PARENT_RESULT.json'
    raw, observed = read_file(path, 2 * 1024**2)
    value = object_bytes(raw)
    need(value.get('status') == 'worker_exit0' and type(value.get('worker_exit')) is int
         and value['worker_exit'] == 0 and value.get('cleanup', {}).get('worker_reaped') is True
         and value['cleanup'].get('group_absent') is True and value['cleanup'].get('signals') == []
         and value.get('finalization_errors') == [], 'clean_actual_stage1_parent_required')
    if phase is not None:
        need(value.get('phase') == phase, 'actual_preparation_parent_phase_required')
    return value, observed


def preparation_bindings(stage1):
    stage, parent = one_parent(ROOT / 'preparation-parent/stage', 'stage')
    need(stage['static_source_context']['manifest_sha256'] == stage1['manifest']['sha256']
         and stage['static_source_context']['review'] == pin(stage1['review_raw']),
         'stage1_review_must_describe_actual_preparation')
    manifest_pin = write_new(RECEIPTS / 'stage1-MANIFEST.sha256', stage1['manifest_raw'])
    review_pin = write_new(RECEIPTS / 'stage1-source-review-r1.json', stage1['review_raw'])
    return {'preparation_parent': dict(parent, path=str(Path(parent['path']).relative_to(ROOT))),
            'stage1_manifest': {k: manifest_pin[k] for k in ('bytes', 'sha256')},
            'stage1_source_review': {k: review_pin[k] for k in ('bytes', 'sha256')}}


def finalizer_phase(sources, owner):
    finalizer = source_namespace(sources, 'finalize_runtime')
    prep_raw, prep_pin = read_file(JOB / 'CI_PREPARATION_RECEIPT_R1.json', 2 * 1024**2)
    native_raw, native_pin = read_file(RECEIPTS / 'native-phases-r1.json', 2 * 1024**2)
    native = object_bytes(native_raw)
    parent, parent_pin = one_parent(ROOT / 'native-parent')
    need(parent['worker_receipt'] == native_pin and native.get('status') ==
         'ALL_REQUIRED_NATIVE_PHASES_COMPLETE', 'actual_native_parent_receipt_link_required')
    bindings = owner['preparation_bindings']
    finalizer.update(FINALIZER_ENABLED=True, EXPECTED_OWNER_UID=os.getuid(),
        PREPARATION_RECEIPT_PIN=pin(prep_raw),
        NATIVE_PHASE_RECEIPT_PIN=dict(native_pin, path='receipts/native-phases-r1.json'),
        PBS_STOCK_TOOL_PINS=PBS_STOCK, PBS_EXTRA_DISTRIBUTION_PINS=PBS_EXTRA,
        PREPARATION_PARENT_PIN=bindings['preparation_parent'],
        STAGE1_MANIFEST_PIN=bindings['stage1_manifest'],
        STAGE1_SOURCE_REVIEW_PIN=bindings['stage1_source_review'])
    bundle_fd = finalizer['open_directory_chain'](BUNDLE)
    try:
        inventory = finalizer['inventory_bundle'](bundle_fd, os.getuid())
    finally:
        os.close(bundle_fd)
    cache = {}
    for name, row in inventory.items():
        if name.startswith('python/lib/python3.12/site-packages/') and '/__pycache__/' in name:
            need(row['kind'] == 'file' and name.endswith('.pyc'),
                 'fresh_generated_site_cache_shape_required')
            cache[name] = {k: row[k] for k in ('bytes', 'sha256')}
    need(sum(row['bytes'] for row in cache.values()) <= 64 * 1024**2,
         'fresh_generated_cache_total_bound')
    finalizer['OWNED_PYCACHE_RESIDUE_PINS'] = cache
    candidate = sources['review']['subjects']['finalize_runtime']['sha256']
    admission = {'status': 'OWNER_ADMITTED_FINALIZATION', 'job_path': str(JOB),
        'job_identity': identity(JOB), 'candidate_source_sha256': candidate,
        'execution_owner': owner['execution_owner'], 'origin_machine': owner['origin_machine'],
        **bindings}
    admitted = write_json(RECEIPTS / 'finalizer-admission-r1.json', admission)
    call_main(finalizer, ['--source-sha256', candidate, '--admission-bytes', str(admitted['bytes']),
                         '--admission-sha256', admitted['sha256']])
    final_raw, final_pin = read_file(RECEIPTS / 'finalization_r1.json', 32 * 1024**2)
    final = object_bytes(final_raw)
    need(final.get('status') == 'FINALIZED_BUNDLE_DERIVATIVE_ONLY', 'actual_finalization_required')
    return {'finalization': final_pin, 'finalizer_admission': admitted,
            'native_phases': native_pin, 'native_parent': parent_pin}


def copy_phase(sources, owner):
    raw, _pin = read_file(RECEIPTS / 'finalization_r1.json', 32 * 1024**2)
    copy = source_namespace(sources, 'copy_runtime')
    copy.update(COPY_ENABLED=True, EXPECTED_UID=os.getuid())
    result = copy['copy_fresh_runtime'](object_bytes(raw), owner['relocation_attempt'],
        source_namespace(sources, 'package_inputs'),
        source_namespace(sources, 'fresh_runtime_contract'))
    write_json(RECEIPTS / 'runtime-copy-facts-r1.json', result)
    return result


def seal_phase(sources, owner, evidence, resource):
    seal = source_namespace(sources, 'seal_runtime')
    seal.update(SEAL_ENABLED=True, EXPECTED_UID=os.getuid())
    inputs = {'schema': 'studio-Mac-CI-runtime-seal-inputs/1',
        'source_owner': owner['execution_owner'], 'origin_machine': owner['origin_machine'],
        'job_path': str(JOB), 'roles': evidence,
        'scope': 'Actual same-job phase receipts; no runtime or deployment pass synthesized.'}
    inputs_pin = write_json(HERE / 'SEAL_INPUTS_R1.json', inputs)
    source_sha = sources['review']['subjects']['seal_runtime']['sha256']
    admission = {'status': 'OWNER_ADMITTED_RUNTIME_SEAL',
        'candidate_source_sha256': source_sha, 'inputs_sha256': inputs_pin['sha256'],
        'job_path': str(JOB), 'job_identity': identity(JOB),
        'execution_owner': owner['execution_owner'], 'origin_machine': owner['origin_machine'],
        'source_review_sha256': sources['review_pin']['sha256'],
        'resource_advice_sha256': pin(json_bytes(resource))['sha256'],
        'current_tasks_sha256': hashlib.sha256(json_bytes({'tasks': owner['current_tasks']})).hexdigest()}
    admitted = write_json(RECEIPTS / 'runtime-seal-admission-r1.json', admission)
    call_main(seal, ['--inputs-sha256', inputs_pin['sha256'], '--source-sha256', source_sha,
        '--admission-bytes', str(admitted['bytes']), '--admission-sha256', admitted['sha256']])
    _raw, result_pin = read_file(RECEIPTS / 'sealed-runtime-input-r1.json', 32 * 1024**2)
    return result_pin


def macho_filetype(name, row):
    """Read only current finalized inventory entries, never discover a tree."""
    path = BUNDLE / relative(name)
    parent, _identity = directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and before.st_size == row['bytes'],
             'finalized_MachO_entry_identity_required')
        prefix = os.read(fd, min(4096, before.st_size))
        offset = 0
        fat = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
               b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}
        if prefix[:4] in fat:
            endian, wide = fat[prefix[:4]]
            need(len(prefix) >= 8, 'bounded_fat_header_required')
            count = struct.unpack(endian + 'I', prefix[4:8])[0]
            width = 32 if wide else 20
            need(0 < count <= 64 and 8 + count * width <= len(prefix),
                 'bounded_fat_architecture_table_required')
            choices = []
            for index in range(count):
                start = 8 + index * width
                cpu = struct.unpack(endian + 'I', prefix[start:start + 4])[0]
                location, size = struct.unpack(endian + ('QQ' if wide else 'II'),
                    prefix[start + 8:start + (24 if wide else 16)])
                need(location >= 8 + count * width and size >= 16
                     and location + size <= before.st_size, 'fat_slice_bounds_required')
                if cpu == 0x0100000C:
                    choices.append(location)
            need(len(choices) == 1, 'one_exact_arm64_slice_required')
            offset = choices[0]
            os.lseek(fd, offset, os.SEEK_SET)
            prefix = os.read(fd, 16)
        magics = {b'\xcf\xfa\xed\xfe': '<', b'\xce\xfa\xed\xfe': '<',
                  b'\xfe\xed\xfa\xcf': '>', b'\xfe\xed\xfa\xce': '>'}
        if prefix[:4] not in magics:
            need(offset == 0, 'fat_arm64_MachO_header_required')
            result = None
        else:
            need(len(prefix) >= 16, 'complete_MachO_header_required')
            _magic, cpu, _subtype, result = struct.unpack(magics[prefix[:4]] + 'IIII', prefix[:16])
            need(cpu == 0x0100000C and result in {2, 6, 8},
                 'supported_arm64_runtime_image_required')
        need(file_key(before) == file_key(os.fstat(fd))
             == file_key(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
             'MachO_header_changed_during_read')
        return result
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def dynamic_image_contexts(sources):
    raw, _pin = read_file(RECEIPTS / 'finalization_r1.json', 32 * 1024**2)
    inventory = object_bytes(raw)['component_inventory']
    audit = source_namespace(sources, 'audit_runtime')
    python = audit['_resolve_inventory_path']('python/bin/python3.12', inventory)
    swipl = audit['_resolve_inventory_path']('swipl/bin/swipl', inventory)
    images = {name: kind for name, row in inventory.items() if row['kind'] == 'file'
              and (kind := macho_filetype(name, row)) is not None}
    need(0 < len(images) <= audit['MAX_MACHO_FILES'] and images.get(python) == 2
         and images.get(swipl) == 2, 'actual_arm64_Python_SWIPL_main_images_required')
    contexts = {}
    for name, kind in images.items():
        if kind == 2:
            continue
        if name.startswith('python/'):
            contexts[name] = [python]
        else:
            need(name.startswith(('swipl/', 'lib/')), 'undeclared_dynamic_image_loader_policy')
            # The admitted probes load SWI directly and through Python Janus.
            contexts[name] = sorted({python, swipl})
    need(sum(len(value) for value in contexts.values()) <= audit['MAX_DYNAMIC_CONTEXT_LINKS'],
         'actual_dynamic_loader_context_link_bound')
    return contexts


def verify_runner_closure(closure, actual, admission, owner, phase, phase_started):
    path = PARENT / owner['attempt_id'] / phase / 'RUNNER_CLOSED.json'
    raw, observed = read_file(path, 8 * 1024**2)
    recorded = object_bytes(raw)
    need(type(closure) is dict and recorded == closure and set(closure) == {
        'schema', 'status', 'audit_kind', 'phase_worker', 'phase_worker_birth',
        'supervisor_pid', 'runner_pin', 'owner_admission_pin', 'ownership_evidence_pins',
        'whole_attempt_started_monotonic', 'whole_attempt_deadline', 'finished_at_monotonic',
        'elapsed_seconds', 'command_count', 'aggregate_output_bytes', 'combined_rss_peak_bytes',
        'sample_count', 'max_sample_gap', 'registered_groups', 'guard_errors', 'qualification'},
        'actual_closed_runner_receipt_and_return_required')
    need(closure['schema'] == 'studio-audit-runner-closure/1'
         and closure['status'] == 'CLOSED_OWNED_GROUPS_ABSENT'
         and closure['audit_kind'] == phase
         and closure['phase_worker'] == {'pid': os.getpid(), 'pgid': os.getpid(), 'sid': os.getpid()}
         and closure['phase_worker_birth'] == process_birth(os.getpid())
         and closure['supervisor_pid'] == os.getppid()
         and closure['runner_pin'] == admission['process_runner_pin']
         and closure['ownership_evidence_pins'] == {
             'task_admission': admission['task_admission'], 'resource_admission': admission['resource_admission']}
         and closure['whole_attempt_started_monotonic'] == phase_started
         and closure['whole_attempt_deadline'] == phase_started + 1800
         and type(closure['finished_at_monotonic']) in (int, float)
         and phase_started < closure['finished_at_monotonic'] <= time.monotonic()
         and closure['finished_at_monotonic'] < phase_started + 1800
         and type(closure['elapsed_seconds']) in (int, float)
         and 0 < closure['elapsed_seconds'] <= 1800
         and abs(closure['elapsed_seconds'] - (closure['finished_at_monotonic'] - phase_started)) <= .25
         and closure['guard_errors'] == []
         and closure['qualification'] == 'Owned command runner closure only; no native audit/product pass',
         'actual_successful_runner_lifecycle_required')
    groups = closure['registered_groups']
    need(type(groups) is list and 0 < len(groups) <= 8202
         and type(closure['command_count']) is int
         and closure['command_count'] == len(groups) == actual['command_count']
         and type(closure['aggregate_output_bytes']) is int
         and 0 <= closure['aggregate_output_bytes'] <= 64 * 1024**2
         and type(closure['combined_rss_peak_bytes']) is int
         and 0 < closure['combined_rss_peak_bytes'] <= 3 * 1024**3
         and type(closure['sample_count']) is int and closure['sample_count'] > 0
         and type(closure['max_sample_gap']) in (int, float)
         and 0 <= closure['max_sample_gap'] <= 2.5, 'actual_runner_resource_and_command_counts_required')
    for row in groups:
        need(type(row) is dict and set(row) == {'pid', 'pgid', 'sid', 'birth',
             'worker_reaped', 'group_absent', 'signals', 'guard_error'}
             and type(row['pid']) is int and row['pid'] > 0
             and row['pid'] == row['pgid'] == row['sid']
             and row['worker_reaped'] is True and row['group_absent'] is True
             and row['signals'] == [] and row['guard_error'] is None,
             'every_actual_command_group_closed_cleanly_required')
        birth = row['birth']
        need(type(birth) is dict and set(birth) == {'pid', 'start_tvsec', 'start_tvusec'}
             and all(type(value) is int for value in birth.values())
             and birth['pid'] == row['pid'] and birth['start_tvsec'] > 0
             and 0 <= birth['start_tvusec'] < 1_000_000,
             'every_closed_command_kernel_birth_required')
    prefix = 'NATIVE_AUDIT' if phase == 'native_audit' else 'RELOCATION_AUDIT'
    _raw, admitted = read_file(ROOT / 'native-source' / (prefix + '_ADMISSION_R1.json'), 65536)
    need(closure['owner_admission_pin'] == admitted, 'runner_closure_actual_owner_admission_pin_required')
    return observed


def audit_phase(sources, owner, phase, phase_started, evidence):
    audit = source_namespace(sources, 'audit_runtime')
    native = phase == 'native_audit'
    prefix = 'NATIVE_AUDIT' if native else 'RELOCATION_AUDIT'
    original = str(BUNDLE)
    root = BUNDLE if native else ROOT / 'runtime-relocation-attempts' / (
        'attempt-' + owner['relocation_attempt']) / 'OmegaHive.bundle'
    source = sources['review']['subjects']['audit_runtime']
    review_sha = sources['review_pin']['sha256']
    uid = os.getuid()
    shared = {'job_path': str(JOB), 'job_identity': identity(JOB), 'audit_kind': phase,
              'candidate_source_sha256': source['sha256'],
              'review_manifest_sha256': review_sha, 'owner_uid': uid}
    limits = {'cpu_cores': 2.25, 'ram_bytes': 3355443200, 'scratch_bytes': 4 * 1024**3,
        'wall_seconds': audit['CONTROLLER_SECONDS'], 'max_commands': audit['MAX_COMMANDS'],
        'max_macho_files': audit['MAX_MACHO_FILES'], 'max_log_bytes': audit['AGGREGATE_LOG_LIMIT'],
        'combined_rss_bytes': audit['COMBINED_RSS_LIMIT']}
    lease = int(time.time()) + audit['CONTROLLER_SECONDS']
    task_id = 'stage2-' + phase + '-' + owner['attempt_id']
    resource_id = 'stage2-serial-' + owner['attempt_id']
    task = {'schema': 'studio-Mac-CI-native-audit-task/1', 'status': 'ADMITTED_NATIVE_AUDIT',
        'valid_until_epoch': lease, 'task_id': task_id, 'task_owner': owner['execution_owner'],
        **shared, 'limits': limits}
    resource = {'schema': 'studio-Mac-CI-native-audit-resource/1', 'status': 'RESERVED_NATIVE_AUDIT',
        'valid_until_epoch': lease, 'resource_id': resource_id, **shared, 'reserved_limits': limits}
    native_source = ROOT / 'native-source'
    task_pin = write_json(native_source / (prefix + '_TASK_ADMISSION_R1.json'), task)
    resource_pin = write_json(native_source / (prefix + '_RESOURCE_ADMISSION_R1.json'), resource)
    tools = {name: read_file(Path(path), 128 * 1024**2, owner=0, keep=False)[1]
        for name, path in {'ps': '/bin/ps', 'lipo': '/usr/bin/lipo', 'otool': '/usr/bin/otool',
                           'sh': '/bin/sh', 'dirname': '/usr/bin/dirname'}.items()}
    def source_pin(role):
        subject = sources['review']['subjects'][role]
        return dict(subject, path=str(ROOT / subject['path']))
    admission = {'schema': 'studio-Mac-CI-native-audit-admission/1',
        'status': 'OWNER_ADMITTED_NATIVE_AUDIT', 'enabled': True,
        'valid_until_epoch': lease, **shared, 'source_bundle_root': original,
        'execution_owner': owner['execution_owner'], 'origin_machine': owner['origin_machine'],
        'task_admission': task_pin, 'resource_admission': resource_pin,
        'process_runner_pin': source_pin('audit_process_runner'), 'tool_pins': tools,
        'native_worker_source_pin': read_file(native_source / 'ci_native_worker.py', 128 * 1024)[1],
        'petta_entrypoint': audit['PETTA_SCRIPT_PIN'],
        'finalizer_source_pin': source_pin('finalize_runtime'),
        'dynamic_image_contexts': owner['dynamic_image_contexts'],
        'task_id': task_id, 'resource_id': resource_id, **owner['preparation_bindings']}
    admission_pin = write_json(native_source / (prefix + '_ADMISSION_R1.json'), admission)
    context = {'schema': 'studio-Mac-CI-native-audit-context/1', **{
        name: shared[name] for name in ('audit_kind', 'job_path', 'job_identity', 'candidate_source_sha256')},
        'source_bundle_root': original,
        'native_inputs': read_file(native_source / 'NATIVE_BUILD_INPUTS_R1.json', 256 * 1024)[1],
        'evidence': evidence, 'execution_owner': owner['execution_owner'],
        'origin_machine': owner['origin_machine'], 'owner_admission': admission_pin}
    runner_source = source_namespace(sources, 'audit_process_runner')
    # This fixed constructor and registry protocol belong in the whole Source review.
    runner = runner_source['OwnedAuditRunner'](admission=admission, context=context,
        whole_attempt_started_monotonic=phase_started, cancelled=lambda: STOP,
        registration_root=PARENT / owner['attempt_id'] / phase / 'command-groups')
    actual, closure, failure, original_error = None, None, {}, None
    try:
        actual = audit['audit_bundle'](root, context, runner)
    except BaseException as error:
        original_error = error
        failure['audit_error_type'] = type(error).__name__
        if isinstance(error, audit['AuditRefused']):
            failure['audit_reason'] = str(error)[:512]
    finally:
        try:
            closure = runner.finish()
        except BaseException as error:
            if original_error is None:
                original_error = error
            failure['runner_finish_error_type'] = type(error).__name__
        if failure:
            write_json(PARENT / owner['attempt_id'] / phase / 'AUDIT_FAILURE.json', {
                'schema': 'studio-stage2-audit-and-runner-failure/1',
                'audit_kind': phase, **failure, 'qualification': 'NONE'}, completion_only=True)
    if original_error is not None:
        raise Refused('audit_or_runner_finish_failed_retained') from original_error
    need(actual.get('status') == 'EIGHT_RUNTIME_CHECKS_PASS', 'actual_eight_audit_checks_required')
    closure_pin = verify_runner_closure(closure, actual, admission, owner, phase, phase_started)
    result = dict(actual, runner_closure_pin=closure_pin)
    if native:
        result.update(schema='studio-Mac-CI-native-audit/1', status='NATIVE_RUNTIME_CHECKS_PASS')
    else:
        copy_raw, _copy_pin = read_file(RECEIPTS / 'runtime-copy-facts-r1.json', 32 * 1024**2)
        copied = object_bytes(copy_raw)
        closure_raw, _closure_pin = read_file(PARENT / owner['attempt_id'] / 'copy' / 'PARENT_RESULT.json', 256 * 1024)
        closure = object_bytes(closure_raw)
        need(closure['status'] == 'worker_exit0' and closure['worker_reaped'] is True
             and closure['group_absent'] is True and closure['signals'] == []
             and closure['guard_error'] is None and type(closure['worker_exit']) is int
             and closure['worker_exit'] == 0
             and copied['status'] == 'CLOSED_RUNTIME_DATA_COPY_ONLY'
             and copied['relocated_bundle_root'] == str(root)
             and copied['content_inventory_sha256'] == actual['content_inventory_sha256'],
             'actual_clean_copy_phase_and_relocation_content_required')
        result.update(schema='studio-Mac-CI-runtime-relocation/1',
            status='RELOCATED_RUNTIME_CHECKS_PASS', relocated_bundle_root=str(root),
            fresh_output_created=copied['fresh_output_created'])
        result['checks'] = dict(actual['checks'], copy_manifest={
            'status': 'passed', 'exit': closure['worker_exit'], 'worker_reaped': closure['worker_reaped'],
            'group_absent': closure['group_absent'], 'signals': closure['signals'],
            'guard_error': closure['guard_error'], 'actual_copy_phase_result': _closure_pin})
    target = RECEIPTS / ('runtime-native-audit-r1.json' if native else 'runtime-relocation-r1.json')
    return write_json(target, result)


def ensure_private(path):
    parent, _identity = directory(path.parent, private=True)
    try:
        try:
            os.mkdir(path.name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    finally:
        os.close(parent)
    return identity(path)


def stage_sources(sources):
    ensure_private(HERE)
    ensure_private(PARENT)
    for role, name in ROLES.items():
        destination = ROOT / name
        body = sources['bodies'][name]
        if os.path.lexists(destination):
            actual, _pin = read_file(destination, 256 * 1024, pin(body))
            need(actual == body, 'preexisting_exact_stage2_source_required')
        else:
            need(role not in {'resource_guide', 'resource_policy'},
                 'stage1_canonical_resource_sources_required')
            write_new(destination, body)
    write_new(HERE / REVIEW_NAME, sources['review_raw'])
    write_new(HERE / 'STAGE2_MANIFEST.sha256', sources['manifest_raw'])


def current_tasks(args):
    if args.current_tasks is None:
        return []  # Explicit dedicated-job completeness attestation in --run.
    raw, _pin = read_file(Path(args.current_tasks), 256 * 1024)
    value = object_bytes(raw)
    need(set(value) == {'schema', 'complete', 'tasks'}
         and value['schema'] == 'studio-Mac-CI-current-tasks-owner-attestation/1'
         and value['complete'] is True and type(value['tasks']) is list
         and len(value['tasks']) <= 256, 'closed_complete_current_task_attestation_required')
    seen = set()
    for row in value['tasks']:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'}
             and type(row['task_id']) is str and 0 < len(row['task_id']) <= 128
             and row['task_id'] not in seen and row['state'] in {'running', 'reserved'},
             'closed_unique_current_task_required')
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


def census():
    need(PS_PIN is not None, 'current_root_owned_ps_pin_required')
    read_file(Path('/bin/ps'), 32 * 1024**2, PS_PIN, owner=0, keep=False,
              cancellation_independent=True)
    observed = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,uid=,rss='],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=2)
    need(observed.returncode == 0 and len(observed.stdout) <= 1024**2
         and len(observed.stderr) <= 4096, 'bounded_process_census_required')
    result = {}
    for line in observed.stdout.decode('ascii').splitlines():
        parts = line.split()
        need(len(parts) == 5 and all(part.isdecimal() for part in parts),
             'complete_numeric_process_census_required')
        pid, ppid, pgid, uid, kib = map(int, parts)
        need(pid not in result, 'unique_census_PID_required')
        result[pid] = {'pid': pid, 'ppid': ppid, 'pgid': pgid, 'uid': uid, 'rss': kib * 1024}
    need(os.getpid() in result, 'actual_parent_census_required')
    return result


def empty_marker(path, *, create=False):
    parent, _identity = directory(path.parent, private=True)
    fd = None
    try:
        if create:
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o400, dir_fd=parent)
            os.fsync(fd)
        else:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
             and info.st_size == 0 and stat.S_IMODE(info.st_mode) == 0o400,
             'immutable_empty_protocol_marker_required')
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def registrations(phase_dir, worker, known, expected, *, allow_ack=True):
    """Registry files grant no ownership until actual live SID/UID corroboration."""
    root = phase_dir / 'command-groups'
    fd, _identity = directory(root, private=True)
    try:
        with os.scandir(fd) as listing:
            ready_indices = []
            for index, entry in enumerate(listing):
                match = re.fullmatch(r'command-([0-9]{6})([.]json|[.]ready|[.]ack[.]json|[.]ack[.]ready)', entry.name)
                need(index < 4 * 8202 and match is not None and 1 <= int(match[1]) <= 8202,
                     'bounded_command_registration_namespace_required')
                if match[2] == '.ready':
                    ready_indices.append(int(match[1]))
    finally:
        os.close(fd)
    registered_indices = expected.setdefault('registered_indices', set())
    for index in sorted(ready_indices):
        stem = 'command-' + f'{index:06d}'
        if index in registered_indices:
            continue
        need(expected['phase'] in {'native_audit', 'relocation'},
             'commands_only_in_actual_audit_phase')
        empty_marker(root / (stem + '.ready'))
        raw, registration_pin = read_file(root / (stem + '.json'), 65536,
                                          cancellation_independent=not allow_ack)
        record = object_bytes(raw)
        need(set(record) == {'schema', 'nonce', 'audit_kind', 'command_index', 'supervisor_pid',
             'phase_worker', 'command', 'runner_pin', 'owner_admission_pin', 'task_admission_pin',
             'resource_admission_pin', 'executable_pin', 'registered_at_monotonic',
             'whole_attempt_started_monotonic', 'whole_attempt_deadline',
             'command_birth', 'phase_worker_birth'}
             and record['schema'] == 'studio-audit-command-group-registration/1'
             and type(record['nonce']) is str and re.fullmatch('[a-f0-9]{32}', record['nonce'])
             and type(record['command_index']) is int and record['command_index'] == index
             and record['audit_kind'] == expected['phase']
             and record['supervisor_pid'] == os.getpid()
             and record['runner_pin'] == expected['runner_pin']
             and record['whole_attempt_started_monotonic'] == expected['phase_start']
             and record['whole_attempt_deadline'] == expected['phase_start'] + 1800
             and type(record['registered_at_monotonic']) in (int, float)
             and expected['phase_start'] <= record['registered_at_monotonic'] <= time.monotonic(),
             'closed_current_phase_command_registration_required')
        need(record['phase_worker'] == {'pid': worker, 'pgid': worker, 'sid': worker}
             and record['phase_worker_birth'] == known[worker]['birth']
             and process_birth(worker) == known[worker]['birth'], 'actual_phase_worker_birth_required')
        command = record['command']
        need(type(command) is dict and set(command) == {'pid', 'pgid', 'sid'}
             and type(command['pid']) is int and command['pid'] > 0
             and command['pid'] == command['pgid'] == command['sid'],
             'actual_new_session_command_required')
        group = command['pid']
        for field, path in expected['admission_paths'].items():
            value = record[field]
            need(type(value) is dict and set(value) == {'path', 'bytes', 'sha256'}
                 and value['path'] == str(path), 'selected_phase_admission_pin_required')
            held, _pin = read_file(path, 65536, value,
                                   cancellation_independent=not allow_ack)
            admitted = object_bytes(held)
            need(admitted['audit_kind'] == expected['phase']
                 and admitted['owner_uid'] == os.getuid()
                 and admitted['candidate_source_sha256'] == expected['audit_sha'],
                 'actual_phase_admission_context_required')
            if field == 'owner_admission_pin':
                need(admitted['process_runner_pin'] == expected['runner_pin']
                     and admitted['task_admission'] == record['task_admission_pin']
                     and admitted['resource_admission'] == record['resource_admission_pin'],
                     'actual_owner_and_reservation_pin_links_required')
        birth = record['command_birth']
        need(type(birth) is dict and set(birth) == {'pid', 'start_tvsec', 'start_tvusec'}
             and all(type(value) is int for value in birth.values()) and birth['pid'] == group
             and birth['start_tvsec'] > 0 and 0 <= birth['start_tvusec'] < 1_000_000,
             'closed_kernel_command_birth_required')
        need(process_birth(group) == birth and os.getpgid(group) == group
             and os.getsid(group) == group, 'actual_command_birth_session_before_ACK_required')
        rows = census()
        need(group in rows and rows[group]['ppid'] == worker and rows[group]['uid'] == os.getuid(),
             'actual_bridge_child_of_phase_worker_required')
        known[group] = dict(command, birth=birth, member_births={group: birth},
            command_index=index, registration_pin=registration_pin)
        registered_indices.add(index)
        if not allow_ack or STOP:
            continue
        ack = {'schema': 'studio-audit-command-group-ack/1', 'nonce': record['nonce'],
               'command': command, 'supervisor_pid': os.getpid(),
               'registration_sha256': registration_pin['sha256']}
        ack_path = root / (stem + '.ack.json')
        if os.path.lexists(ack_path):
            held, _pin = read_file(ack_path, 65536)
            need(held == json_bytes(ack), 'immutable_existing_ack_must_match')
        else:
            write_json(ack_path, ack)
        ready = root / (stem + '.ack.ready')
        if os.path.lexists(ready):
            empty_marker(ready)
        else:
            empty_marker(ready, create=True)
    return known


def observe_owned(worker, phase_dir, known, expected, *, allow_ack=True):
    registrations(phase_dir, worker, known, expected, allow_ack=allow_ack)
    rows = census()
    descendants = {worker}
    for _index in range(len(rows) + 1):
        more = {pid for pid, row in rows.items() if row['ppid'] in descendants}
        if more <= descendants:
            break
        descendants |= more
    # A real descendant can be observed between its Popen and registry write.
    # Establish new-session ownership from actual ancestry/UID/SID in that case.
    for pid in descendants:
        row = rows.get(pid)
        if row is None or row['pgid'] in known:
            continue
        need(row['uid'] == os.getuid(), 'foreign_worker_descendant')
        try:
            sid = os.getsid(pid)
        except ProcessLookupError:
            continue
        need(sid == row['pgid'] and row['pgid'] in descendants,
             'worker_descendant_new_session_ownership_required')
        birth = process_birth(row['pgid'])
        need(birth is not None, 'live_descendant_group_birth_required')
        known[row['pgid']] = {'pid': row['pgid'], 'pgid': row['pgid'], 'sid': sid,
                             'birth': birth, 'member_births': {row['pgid']: birth},
                             'owner_uid': os.getuid(), 'actual_ancestry_observed': True}
    owned = [row for row in rows.values() if row['pid'] in descendants or row['pgid'] in known]
    for row in owned:
        need(row['uid'] == os.getuid() and row['pgid'] in known,
             'unregistered_or_foreign_worker_process_group')
        try:
            observed_sid = os.getsid(row['pid'])
        except ProcessLookupError:
            continue
        need(observed_sid == row['pgid'], 'owned_new_session_identity_required')
        birth = process_birth(row['pid'])
        if birth is None:
            continue
        registration = known[row['pgid']]
        members = registration.setdefault('member_births', {})
        if row['pid'] in members:
            need(birth == members[row['pid']], 'owned_member_PID_birth_changed')
        else:
            leader = process_birth(row['pgid'])
            anchored = leader == registration['birth'] or any(
                process_birth(pid) == prior for pid, prior in members.items())
            need(anchored, 'original_group_birth_anchor_required')
            members[row['pid']] = birth
    group_rss = sum(row['rss'] for row in owned)
    parent_rss = sum(row['rss'] for row in rows.values()
                     if row['pid'] == os.getpid() or (row['ppid'] == os.getpid()
                     and row['pid'] != worker and row not in owned))
    return owned, group_rss, parent_rss


def cleanup_phase(process, phase_dir, known, deadline, result, expected):
    """Only actual registered/corroborated groups; no foreign force fallback."""
    stop = phase_dir / 'STOP'
    if not os.path.lexists(stop):
        empty_marker(stop, create=True)
    for sig, allowance in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
        process.poll()
        owned, _group, _parent = observe_owned(process.pid, phase_dir, known, expected, allow_ack=False)
        if process.returncode is not None and not owned:
            break
        need(time.monotonic() < deadline, 'phase_cleanup_deadline')
        for group in sorted({row['pgid'] for row in owned}, reverse=True):
            # Reobserve immediately before signalling; registration alone is insufficient.
            current, _group, _parent = observe_owned(process.pid, phase_dir, known, expected, allow_ack=False)
            if not any(row['pgid'] == group for row in current):
                continue
            try:
                os.killpg(group, sig)
                result['signals'].append({'pgid': group, 'signal': sig.name})
            except ProcessLookupError:
                pass
        end = min(deadline, time.monotonic() + allowance)
        while time.monotonic() < end:
            process.poll()
            owned, _group, _parent = observe_owned(process.pid, phase_dir, known, expected, allow_ack=False)
            if process.returncode is not None and not owned:
                break
            time.sleep(.1)
    process.wait(timeout=max(.001, min(2, deadline - time.monotonic())))
    remaining, _group, _parent = observe_owned(process.pid, phase_dir, known, expected, allow_ack=False)
    result.update(worker_exit=process.returncode, worker_reaped=True,
                  group_absent=not remaining, registered_groups=sorted(known))


def log_metadata(path):
    """Bounded observation even on overrun or unconfirmed writer cleanup."""
    parent, _identity = directory(path.parent, private=True)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1, 'owned_log_file_required')
        body = bytearray()
        while len(body) < 65536:
            block = os.read(fd, min(4096, 65536 - len(body)))
            if not block:
                break
            body.extend(block)
        after = os.fstat(fd)
        stable = file_key(before) == file_key(after) == file_key(
            os.stat(path.name, dir_fd=parent, follow_symlinks=False))
        full = stable and before.st_size == len(body)
        return {'path': str(path), 'bytes_observed': after.st_size,
            'captured_prefix_bytes': len(body), 'prefix_sha256': hashlib.sha256(body).hexdigest(),
            'over_limit': after.st_size > 65536, 'stable_during_read': stable,
            'full_file_pin': {'path': str(path), **pin(body)} if full else None}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def active_observation(process, phase_dir, known, expected, last, deadline, result):
    _owned, rss, overhead = observe_owned(process.pid, phase_dir, known, expected)
    completed = time.monotonic()
    result['rss_peak_bytes'] = max(result['rss_peak_bytes'], rss)
    result['parent_rss_peak_bytes'] = max(result['parent_rss_peak_bytes'], overhead)
    result['max_sample_gap'] = max(result['max_sample_gap'], completed - last)
    need(not STOP and completed < deadline - 20 and 0 <= completed - last <= 2.5,
         'actual_completed_phase_observation_gap_or_deadline')
    need(rss <= 3 * 1024**3 and overhead <= .125 * 1024**3,
         'full_worker_group_and_parent_RSS_guard')
    return completed


def run_phase(sources, args, owner, phase, facts, whole_deadline):
    phase_dir = PARENT / owner['attempt_id'] / phase
    phase_dir.mkdir(mode=0o700)
    for name in ('HOME', 'TMP', 'command-groups'):
        (phase_dir / name).mkdir(mode=0o700)
    owner = dict(owner, current_tasks=current_tasks(args))
    resource = resource_admission(sources, owner['current_tasks'])
    write_json(phase_dir / 'RESOURCE_ADMISSION.json', resource)
    need(resource['advice']['decision'] == 'run' and not STOP,
         'fresh_full_phase_resource_RUN_required')
    start = time.monotonic()
    deadline = min(whole_deadline, start + PHASE_SECONDS[phase])
    need(deadline - start >= PHASE_SECONDS[phase] - 1,
         'full_phase_wall_envelope_remaining_required')
    context = {'schema': 'studio-CI-stage2-owned-phase-context/1', 'phase': phase,
        'parent_pid': os.getpid(), 'phase_started_monotonic': start,
        'phase_deadline': deadline, 'sources_manifest': sources['manifest'],
        'owner': owner, 'facts': facts, 'resource': resource}
    need(len(json_bytes(context)) <= 1024**2, 'phase_context_metadata_bound')
    context_pin = write_json(phase_dir / 'PHASE_CONTEXT.json', context)
    argv = [str(PYTHON), '-I', '-B', '-S', str(SOURCE_PATH), '--owned-phase', phase,
            '--phase-context', context_pin['path'], '--phase-context-sha256', context_pin['sha256']]
    result = {'schema': 'studio-CI-stage2-owned-phase-parent/1', 'phase': phase,
        'status': 'starting', 'signals': [], 'worker_reaped': False, 'group_absent': False,
        'worker_exit': None, 'guard_error': None,
        'rss_peak_bytes': 0, 'parent_rss_peak_bytes': 0, 'max_sample_gap': 0,
        'estimate': ESTIMATE, 'source_owner': 'Studio Root observed phase parent',
        'origin_machine': os.uname().nodename, 'context': context_pin}
    runner_subject = sources['review']['subjects']['audit_process_runner']
    prefix = 'NATIVE_AUDIT' if phase == 'native_audit' else 'RELOCATION_AUDIT'
    verification = {'phase': phase, 'phase_start': start,
        'registered_indices': set(),
        'runner_pin': dict(runner_subject, path=str(ROOT / runner_subject['path'])),
        'audit_sha': sources['review']['subjects']['audit_runtime']['sha256'],
        'admission_paths': {field: ROOT / 'native-source' / (prefix + suffix)
            for field, suffix in {'owner_admission_pin': '_ADMISSION_R1.json',
                'task_admission_pin': '_TASK_ADMISSION_R1.json',
                'resource_admission_pin': '_RESOURCE_ADMISSION_R1.json'}.items()}}
    process, known, last = None, {}, start
    with (phase_dir / 'STDOUT.log').open('xb') as out, (phase_dir / 'STDERR.log').open('xb') as err:
        try:
            read_file(PYTHON, 32 * 1024**2, PYTHON_PIN, keep=False)
            need(not STOP, 'cancelled_before_phase_spawn')
            process = subprocess.Popen(argv, cwd=ROOT, stdin=subprocess.DEVNULL,
                stdout=out, stderr=err, close_fds=True, start_new_session=True,
                env={'PATH': SYSTEM_PATH, 'HOME': str(phase_dir / 'HOME'),
                     'TMPDIR': str(phase_dir / 'TMP'), 'LANG': 'C', 'LC_ALL': 'C'})
            birth = process_birth(process.pid)
            need(birth is not None, 'actual_new_phase_worker_birth_required')
            known[process.pid] = {'pid': process.pid, 'pgid': process.pid,
                'sid': process.pid, 'owner_uid': os.getuid(), 'birth': birth,
                'member_births': {process.pid: birth}}
            result.update(worker_pid=process.pid, worker_pgid=process.pid)
            write_json(phase_dir / 'STARTED.json', result)
            ready = phase_dir / 'READY.json'
            while not os.path.lexists(ready):
                need(process.poll() is None and time.monotonic() - start < 15
                     and not STOP, 'actual_owned_phase_startup_required')
                last = active_observation(process, phase_dir, known, verification,
                                          last, deadline, result)
                time.sleep(.1)
            ready_raw, _ready_pin = read_file(ready, 65536)
            proof = object_bytes(ready_raw)
            need(proof == {'pid': process.pid, 'pgid': process.pid, 'sid': process.pid,
                'parent_pid': os.getpid(), 'owner_uid': os.getuid(), 'context_sha256': context_pin['sha256'],
                'worker_birth': known[process.pid]['birth']},
                'actual_phase_session_handshake_required')
            last = active_observation(process, phase_dir, known, verification,
                                      last, deadline, result)
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(resource['at'].replace('Z', '+00:00'))).total_seconds()
            need(not STOP and 0 <= age < 15, 'phase_resource_admission_expired_before_GO')
            write_json(phase_dir / 'GO.json', {'context_sha256': context_pin['sha256'], 'worker_pid': process.pid})
            while process.poll() is None:
                now = time.monotonic()
                need(not STOP and now < deadline - 20 and out.tell() + err.tell() <= 65536,
                     'phase_cancel_deadline_or_parent_log_guard')
                last = active_observation(process, phase_dir, known, verification,
                                          last, deadline, result)
                time.sleep(.25)
            need(out.tell() + err.tell() <= 65536, 'phase_terminal_parent_log_guard')
            last = active_observation(process, phase_dir, known, verification,
                                      last, deadline, result)
            result['status'] = 'worker_exit0' if process.returncode == 0 else 'worker_failed_retained'
        except BaseException as error:
            result.update(status='failed_retained_no_retry', error_type=type(error).__name__,
                          reason=str(error) if isinstance(error, Refused) else type(error).__name__,
                          guard_error=str(error) if isinstance(error, Refused) else type(error).__name__)
        finally:
            if process is not None:
                try:
                    cleanup_phase(process, phase_dir, known, deadline, result, verification)
                except BaseException as error:
                    result.update(status='cleanup_unconfirmed_retained_allocation',
                                  cleanup_error_type=type(error).__name__,
                                  guard_error='cleanup_unconfirmed')
            result.update(elapsed_seconds=time.monotonic() - start,
                          allocation_released=result['worker_reaped'] and result['group_absent'])
            result['logs'] = {}
            for name in ('STDOUT.log', 'STDERR.log'):
                try:
                    result['logs'][name] = log_metadata(phase_dir / name)
                except BaseException as error:
                    result['logs'][name] = {'metadata_error_type': type(error).__name__,
                                            'full_file_pin': None}
                    result['status'] = 'failed_log_observation_retained'
            write_json(phase_dir / 'PARENT_RESULT.json', result, completion_only=True)
    need(result['status'] == 'worker_exit0' and result['worker_reaped']
         and result['group_absent'] and result['signals'] == [], 'clean_original_phase_completion_required')
    raw, _pin = read_file(phase_dir / 'PHASE_FACTS.json', 1024**2)
    return object_bytes(raw)


def host_basics():
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64'
         and os.getuid() == os.geteuid() > 0 and sys.flags.isolated
         and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize
         and sys.executable == str(PYTHON), 'exact_isolated_PBS_macOS_arm64_owner_required')
    read_file(PYTHON, 32 * 1024**2, PYTHON_PIN, keep=False)
    return {'root': identity(ROOT), 'job': identity(JOB)}


def owned_phase(args):
    require_system_path()
    host = host_basics()
    context_path = Path(args.phase_context)
    need(context_path.name == 'PHASE_CONTEXT.json' and context_path.parent.name == args.owned_phase
         and context_path.parent.parent.parent == PARENT
         and re.fullmatch('attempt-[a-f0-9]{32}', context_path.parent.parent.name),
         'canonical_owned_phase_context_required')
    raw, context_pin = read_file(context_path, 1024**2)
    need(context_pin['sha256'] == args.phase_context_sha256, 'exact_phase_context_required')
    context = object_bytes(raw)
    need(set(context) == {'schema', 'phase', 'parent_pid', 'phase_started_monotonic',
         'phase_deadline', 'sources_manifest', 'owner', 'facts', 'resource'}
         and context['schema'] == 'studio-CI-stage2-owned-phase-context/1'
         and context['phase'] == args.owned_phase and type(context['parent_pid']) is int
         and context['parent_pid'] == os.getppid()
         and os.getpid() == os.getpgid(0) == os.getsid(0),
         'actual_registered_phase_parent_session_required')
    start, deadline = context['phase_started_monotonic'], context['phase_deadline']
    now = time.monotonic()
    need(type(start) in (int, float) and type(deadline) in (int, float)
         and math.isfinite(start) and math.isfinite(deadline)
         and 0 <= now - start < 15 and 0 < deadline - start <= PHASE_SECONDS[args.owned_phase],
         'fresh_original_phase_controller_deadline_required')
    owner = context['owner']
    need(type(owner) is dict and owner['host'] == host
         and owner['attempt_id'] == context_path.parent.parent.name
         and owner['owner_uid'] == os.getuid() and Path(__file__).absolute() == SOURCE_PATH,
         'current_owner_host_phase_source_required')
    phase_dir = context_path.parent
    for name in ('HOME', 'TMP', 'command-groups'):
        identity(phase_dir / name)
    need(os.environ.get('HOME') == str(phase_dir / 'HOME')
         and os.environ.get('TMPDIR') == str(phase_dir / 'TMP'), 'actual_private_phase_environment_required')
    sources = load_sources(context['sources_manifest']['path'], context['sources_manifest']['sha256'])
    source_namespace(sources, 'stage2_entry')
    write_json(phase_dir / 'READY.json', {'pid': os.getpid(), 'pgid': os.getpgid(0),
        'sid': os.getsid(0), 'parent_pid': os.getppid(), 'owner_uid': os.getuid(),
        'context_sha256': context_pin['sha256'], 'worker_birth': process_birth(os.getpid())})
    while not os.path.lexists(phase_dir / 'GO.json'):
        need(not STOP and time.monotonic() - start < 15 and os.getppid() == context['parent_pid'],
             'bounded_original_parent_release_required')
        time.sleep(.1)
    released, _pin = read_file(phase_dir / 'GO.json', 65536)
    need(object_bytes(released) == {'context_sha256': context_pin['sha256'], 'worker_pid': os.getpid()}
         and not STOP and os.getppid() == context['parent_pid'], 'actual_phase_GO_required')
    phase, facts = args.owned_phase, context['facts']
    if phase == 'finalize':
        result = {'prerequisites': finalizer_phase(sources, owner),
                  'dynamic_image_contexts': dynamic_image_contexts(sources)}
    elif phase in {'native_audit', 'relocation'}:
        result = {'audit_receipt': audit_phase(sources, owner, phase, start, facts['prerequisites'])}
    elif phase == 'copy':
        result = {'copy': copy_phase(sources, owner)}
    else:
        need(phase == 'seal', 'closed_stage2_phase_required')
        result = {'sealed_runtime_input': seal_phase(sources, owner, facts['evidence'], context['resource'])}
    need(not STOP and time.monotonic() < deadline - 20, 'phase_original_work_deadline_required')
    need(len(json_bytes(result)) <= 1024**2, 'phase_result_metadata_bound')
    write_json(phase_dir / 'PHASE_FACTS.json', result)
    return 0


def parent_entry(args, sources):
    global PS_PIN
    require_system_path()
    need(args.dedicated_ci_job is True and os.environ.get('GITHUB_ACTIONS') == 'true'
         and type(args.owner) is str and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', args.owner),
         'explicit_dedicated_GitHub_CI_owner_required')
    host = host_basics()
    PS_PIN = read_file(Path('/bin/ps'), 32 * 1024**2, owner=0, keep=False)[1]
    need(not os.path.lexists(PARENT / 'STAGE2_ENTRY_LAUNCH_R1.json'),
         'fresh_stage2_no_automatic_retry_required')
    stage1 = load_sources(args.stage1_manifest, args.stage1_manifest_sha256, stage1=True)
    need({k: stage1['review']['subjects']['prep_entry'][k] for k in ('bytes', 'sha256')} ==
         {'bytes': 26212, 'sha256': '3f188e98270d9f0914a1734ba9af2b019d87314ffd265486cd1d1939087aaf3a'}
         and {k: stage1['review']['subjects']['native_entry'][k] for k in ('bytes', 'sha256')} ==
         {'bytes': 51152, 'sha256': '363864ae97f7cbcfdf6f7c9842f12dbc2fba7cb8a4acb3011d731e47710e7d70'},
         'new_genuinely_reviewed_stage1_wait_entries_required')
    actual_entry_raw, _pin = read_file(Path(__file__).absolute(), 256 * 1024)
    need(pin(actual_entry_raw) == {k: sources['review']['subjects']['stage2_entry'][k]
         for k in ('bytes', 'sha256')}, 'actual_entry_must_be_sealed_subject')
    tasks = current_tasks(args)
    initial = resource_admission(sources, tasks)
    if initial['advice']['decision'] != 'run':
        emit_terminal_failure('NOT_RUN_RESOURCE_' + initial['advice']['decision'].upper(),
                              reason='resource_admission_not_run', worker_started=False)
        return 75
    need(not STOP, 'cancelled_before_stage2_materialization')
    os.umask(0o077)
    stage_sources(sources)
    attempt_id = 'attempt-' + uuid.uuid4().hex
    attempt = PARENT / attempt_id
    attempt.mkdir(mode=0o700)
    TERMINAL_CONTEXT['attempt_id'] = attempt_id
    ensure_private(ROOT / 'runtime-relocation-attempts')
    ensure_private(ROOT / 'native-audit-attempts')
    bindings = preparation_bindings(stage1)
    owner = {'execution_owner': args.owner, 'owner_uid': os.getuid(),
        'origin_machine': os.uname().nodename, 'host': host, 'attempt_id': attempt_id,
        'relocation_attempt': uuid.uuid4().hex, 'preparation_bindings': bindings,
        'current_tasks': tasks, 'dedicated_ci_job': True}
    launch = {'schema': 'studio-CI-stage2-owner-launch/1', 'owner': owner,
        'stage1_manifest': stage1['manifest'], 'stage2_manifest': sources['manifest'],
        'source_review': sources['review_pin'], 'initial_resource': initial,
        'whole_wall_seconds': WHOLE_SECONDS, 'estimate': ESTIMATE,
        'scope': 'Owner-attested serial phase admission only; actual phase results decide qualification.'}
    write_json(PARENT / 'STAGE2_ENTRY_LAUNCH_R1.json', launch)
    started = time.monotonic()
    facts, evidence = {}, {}
    result = {'schema': 'studio-CI-stage2-entry-result/1', 'status': 'started',
              'owner': owner, 'phase_results': {}, 'qualification': 'NONE'}
    try:
        for phase in PHASE_SECONDS:
            TERMINAL_CONTEXT['phase'] = phase
            phase_facts = run_phase(sources, args, owner, phase, facts, started + WHOLE_SECONDS)
            result['phase_results'][phase] = phase_facts
            if phase == 'finalize':
                facts['prerequisites'] = phase_facts['prerequisites']
                evidence.update(phase_facts['prerequisites'])
                owner['dynamic_image_contexts'] = phase_facts['dynamic_image_contexts']
            elif phase == 'native_audit':
                evidence['native_audit'] = phase_facts['audit_receipt']
            elif phase == 'relocation':
                evidence['relocation'] = phase_facts['audit_receipt']
            facts['evidence'] = evidence
        TERMINAL_CONTEXT['phase'] = None
        result.update(status='SEALED_RUNTIME_INPUT_PRODUCED',
            sealed_runtime_input=result['phase_results']['seal']['sealed_runtime_input'],
            qualification='Same-job native/relocation-audited sealed runtime input only; UI/app/DMG/demo/deployment remain separate.')
    except BaseException as error:
        result.update(status='FAILED_RETAINED_NO_AUTOMATIC_RETRY',
            error_type=type(error).__name__, reason=str(error) if isinstance(error, Refused) else type(error).__name__)
    finally:
        result['elapsed_seconds'] = time.monotonic() - started
        write_json(attempt / 'STAGE2_RESULT.json', result, completion_only=True)
    if result['status'] == 'SEALED_RUNTIME_INPUT_PRODUCED':
        print(json.dumps({'status': result['status'], 'result': str(attempt / 'STAGE2_RESULT.json')}), flush=True)
    else:
        emit_terminal_failure(result['status'], result.get('error_type'), result.get('reason'))
    return 0 if result['status'] == 'SEALED_RUNTIME_INPUT_PRODUCED' else 1


def _main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--manifest')
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--stage1-manifest')
    parser.add_argument('--stage1-manifest-sha256')
    parser.add_argument('--owner')
    parser.add_argument('--current-tasks')
    parser.add_argument('--dedicated-ci-job', action='store_true')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--owned-phase', choices=tuple(PHASE_SECONDS))
    parser.add_argument('--phase-context')
    parser.add_argument('--phase-context-sha256')
    args = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        if args.owned_phase is not None:
            TERMINAL_CONTEXT['phase'] = args.owned_phase
            need(not args.run and args.phase_context and args.phase_context_sha256,
                 'closed_owned_phase_CLI_required')
            return owned_phase(args)
        need(args.manifest and args.manifest_sha256, 'sealed_stage2_sources_required')
        sources = load_sources(args.manifest, args.manifest_sha256)
        if not args.run:
            print(json.dumps({'status': 'READ_ONLY_STAGE2_SOURCE_PLAN',
                'manifest_sha256': sources['manifest']['sha256'], 'roles': sorted(ROLES),
                'phase_work_seconds': PHASE_SECONDS, 'whole_wall_seconds': WHOLE_SECONDS,
                'estimate': ESTIMATE, 'native_action': False}), flush=True)
            return 0
        need(args.stage1_manifest and args.stage1_manifest_sha256,
             'actual_stage1_sealed_sources_required')
        return parent_entry(args, sources)
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        emit_terminal_failure('FAILED_RETAINED_NO_AUTOMATIC_RETRY', type(error).__name__,
            str(error) if isinstance(error, Refused) else type(error).__name__)
        return 1


def main(argv=None):
    """Preserve dispatch outcomes; also diagnose failures before its inner try."""
    TERMINAL_CONTEXT.update(attempt_id=None, phase=None)
    try:
        return _main(argv)
    except BaseException as error:
        if isinstance(error, SystemExit):
            code = error.code
            if code is None or (type(code) in (int, bool) and code == 0):
                raise
            reason = 'system_exit_nonzero'
        else:
            reason = str(error) if isinstance(error, Refused) else type(error).__name__
        emit_terminal_failure('FAILED_RETAINED_NO_AUTOMATIC_RETRY', type(error).__name__, reason)
        raise


if __name__ == '__main__':
    raise SystemExit(main())
