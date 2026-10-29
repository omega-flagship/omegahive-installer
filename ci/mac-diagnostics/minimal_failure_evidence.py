"""Finite CI metadata fallback, including before bootstrap/collector admission.

Runs in the already selected trusted interpreter. No subprocess, runtime/source
execution, recursive discovery, credentials, environment bodies or file payloads.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import resource
import signal
import stat
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
PHASES = ('finalize', 'native_audit', 'copy', 'relocation', 'seal')
MAX_FILE = 2 * 1024**2
MAX_TOTAL = 12 * 1024**2
MAX_REPORT = 65536
MAX_SELF_RSS = 128 * 1024**2
WALL_SECONDS = 15
STARTED = None
READ_BYTES = 0
STOP = False

# Finite diagnostic labels from pinned Entry Source; unknown text is never echoed.
UNCLASSIFIED = "UNCLASSIFIED_DIAGNOSTIC_LABEL"
SAFE_SCHEMAS = frozenset(['studio-CI-stage2-owner-launch/1', 'studio-CI-stage2-entry-result/1', 'studio-CI-stage2-owned-phase-parent/1'])
SAFE_STATUSES = frozenset(['started', 'starting', 'worker_exit0', 'worker_failed_retained', 'failed_retained_no_retry', 'cleanup_unconfirmed_retained_allocation', 'failed_log_observation_retained', 'SEALED_RUNTIME_INPUT_PRODUCED', 'FAILED_RETAINED_NO_AUTOMATIC_RETRY', 'NOT_RUN_RESOURCE_RUN', 'NOT_RUN_RESOURCE_WAIT', 'NOT_RUN_RESOURCE_UNKNOWN'])
SAFE_ERROR_TYPES = frozenset(['Refused', 'AssertionError', 'AttributeError', 'TypeError', 'ValueError', 'RuntimeError', 'OSError', 'PermissionError', 'FileNotFoundError', 'FileExistsError', 'NotADirectoryError', 'IsADirectoryError', 'ProcessLookupError', 'InterruptedError', 'TimeoutError', 'MemoryError', 'RecursionError', 'OverflowError', 'BrokenPipeError', 'SystemExit', 'KeyboardInterrupt'])
SAFE_REASON_CODES = frozenset(['CI_parent_namespace_entry_bound', 'Darwin_positive_process_identity_required', 'JSON_object_required', 'JSON_output_byte_bound', 'MachO_header_changed_during_read', 'absolute_file_required', 'actual_arm64_Python_SWIPL_main_images_required', 'actual_bridge_child_of_phase_worker_required', 'actual_clean_copy_phase_and_relocation_content_required', 'actual_closed_runner_receipt_and_return_required', 'actual_command_birth_session_before_ACK_required', 'actual_completed_phase_observation_gap_or_deadline', 'actual_dynamic_loader_context_link_bound', 'actual_eight_audit_checks_required', 'actual_entry_must_be_sealed_subject', 'actual_finalization_required', 'actual_native_parent_receipt_link_required', 'actual_new_phase_worker_birth_required', 'actual_new_session_command_required', 'actual_owned_phase_startup_required', 'actual_owner_and_reservation_pin_links_required', 'actual_parent_census_required', 'actual_phase_GO_required', 'actual_phase_admission_context_required', 'actual_phase_session_handshake_required', 'actual_phase_worker_birth_required', 'actual_preparation_parent_phase_required', 'actual_private_phase_environment_required', 'actual_registered_phase_parent_session_required', 'actual_runner_resource_and_command_counts_required', 'actual_stage1_sealed_sources_required', 'actual_successful_runner_lifecycle_required', 'audit_or_runner_finish_failed_retained', 'bounded_command_registration_namespace_required', 'bounded_fat_architecture_table_required', 'bounded_fat_header_required', 'bounded_original_parent_release_required', 'bounded_output_bytes_required', 'bounded_owned_singlelink_regular_file_required', 'bounded_process_census_required', 'bounded_relative_path_required', 'cancelled_before_new_work_output', 'cancelled_before_phase_spawn', 'cancelled_before_stage2_materialization', 'cancelled_during_held_read', 'canonical_absolute_directory_required', 'canonical_owned_phase_context_required', 'canonical_relative_path_required', 'canonical_source_copy_changed', 'canonical_stage2_source_role_path_required', 'canonical_system_PATH_required_before_resource_probes', 'checksum_manifest_changed_or_not_LF', 'clean_actual_stage1_parent_required', 'clean_original_phase_completion_required', 'cleanup_unconfirmed', 'closed_complete_current_task_attestation_required', 'closed_current_phase_command_registration_required', 'closed_current_task_estimate_required', 'closed_kernel_command_birth_required', 'closed_owned_phase_CLI_required', 'closed_review_source_role_set_required', 'closed_stage2_phase_required', 'closed_unique_current_task_required', 'commands_only_in_actual_audit_phase', 'complete_MachO_header_required', 'complete_numeric_process_census_required', 'component_main_returned_failure', 'current_owned_kernel_process_birth_required', 'current_owner_host_phase_source_required', 'current_root_owned_ps_pin_required', 'current_task_pid_required', 'duplicate_JSON_key', 'duplicate_or_self_manifest_entry', 'every_actual_command_group_closed_cleanly_required', 'every_closed_command_kernel_birth_required', 'exact_isolated_PBS_macOS_arm64_owner_required', 'exact_phase_context_required', 'exact_resource_guide_policy_required', 'explicit_dedicated_GitHub_CI_owner_required', 'externally_pinned_source_manifest_required', 'fat_arm64_MachO_header_required', 'fat_slice_bounds_required', 'file_growth_bound', 'finalized_MachO_entry_identity_required', 'finite_current_task_peak_required', 'foreign_worker_descendant', 'fresh_actual_resource_policy_required', 'fresh_full_phase_resource_RUN_required', 'fresh_generated_cache_total_bound', 'fresh_generated_site_cache_shape_required', 'fresh_original_phase_controller_deadline_required', 'fresh_stage2_no_automatic_retry_required', 'full_phase_wall_envelope_remaining_required', 'full_worker_group_and_parent_RSS_guard', 'genuine_closed_source_review_required', 'genuine_source_review_must_be_sealed', 'held_file_identity_changed', 'held_file_pin_mismatch', 'immutable_empty_protocol_marker_required', 'immutable_existing_ack_must_match', 'kernel_process_birth_identity_unavailable', 'live_descendant_group_birth_required', 'new_genuinely_reviewed_stage1_wait_entries_required', 'nonfinite_JSON_number', 'one_exact_arm64_slice_required', 'one_fresh_actual_parent_attempt_required', 'original_group_birth_anchor_required', 'owned_log_file_required', 'owned_member_PID_birth_changed', 'owned_new_session_identity_required', 'phase_cancel_deadline_or_parent_log_guard', 'phase_cleanup_deadline', 'phase_context_metadata_bound', 'phase_original_work_deadline_required', 'phase_resource_admission_expired_before_GO', 'phase_result_metadata_bound', 'phase_terminal_parent_log_guard', 'plain_directory_required', 'plain_parent_attempt_required', 'preexisting_exact_stage2_source_required', 'private_current_owner_directory_required', 'runner_closure_actual_owner_admission_pin_required', 'sealed_stage2_sources_required', 'selected_phase_admission_pin_required', 'short_output_write', 'source_payload_checksum_mismatch', 'source_review_attribution_required', 'source_set_total_byte_bound', 'stage1_canonical_resource_sources_required', 'stage1_genuine_component_review_checksum_required', 'stage1_review_must_describe_actual_preparation', 'standard_bounded_checksum_manifest_required', 'supported_arm64_runtime_image_required', 'undeclared_dynamic_image_loader_policy', 'unique_census_PID_required', 'unregistered_or_foreign_worker_process_group', 'worker_descendant_new_session_ownership_required'])
SAFE_RESOURCE_DECISIONS = frozenset(("run", "wait", "unknown"))


class Refused(RuntimeError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def cancelled(_number, _frame):
    global STOP
    STOP = True
    raise Refused('minimal_evidence_cancel_or_alarm')


def tick():
    need(not STOP and STARTED is not None and 0 <= time.monotonic() - STARTED < WALL_SECONDS,
         'minimal_evidence_original_wall')
    scale = 1 if sys.platform == 'darwin' else 1024
    need(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale <= MAX_SELF_RSS,
         'minimal_evidence_self_RSS')


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def directory_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode))


def directory(path, *, private=False):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)),
         'canonical_absolute_directory_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            tick()
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        need(info.st_uid == os.getuid() and info.st_mode & 0o022 == 0
             and (not private or stat.S_IMODE(info.st_mode) == 0o700),
             'owned_safe_metadata_directory_required')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_json(root_fd, relative):
    """Only caller-supplied fixed literal control paths, under a held root FD."""
    global READ_BYTES
    parts = relative.split('/')
    need(parts and all(re.fullmatch('[A-Za-z0-9_.-]+', part) and part not in {'.', '..'}
                       for part in parts), 'literal_control_path_required')
    parent, leaf = os.dup(root_fd), None
    try:
        for part in parts[:-1]:
            tick()
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
            info = os.fstat(parent)
            need(info.st_uid == os.getuid() and info.st_mode & 0o022 == 0,
                 'owned_control_ancestry_required')
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(leaf)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and 0 < before.st_size <= MAX_FILE,
             'owned_bounded_control_json_required')
        need(READ_BYTES + before.st_size <= MAX_TOTAL, 'aggregate_control_read_bound')
        raw = bytearray()
        while True:
            tick()
            chunk = os.read(leaf, min(65536, MAX_FILE + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
            READ_BYTES += len(chunk)
            need(len(raw) <= MAX_FILE and READ_BYTES <= MAX_TOTAL, 'growing_control_read_bound')
        need(len(raw) == before.st_size and file_key(before) == file_key(os.fstat(leaf))
             == file_key(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)),
             'control_json_changed_during_read')
        value = json.loads(raw)
        need(type(value) is dict, 'control_json_object_required')
        return value, {'path': relative, 'bytes': len(raw),
                       'sha256': hashlib.sha256(raw).hexdigest()}
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(parent)


def bounded_text(value, maximum):
    if type(value) is not str:
        return None
    return ''.join(c if c.isprintable() else '?' for c in value[:maximum])


def verify_own_source(expected_sha):
    path = Path(__file__).absolute()
    parent = directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and 0 < before.st_size <= 65536,
             'bounded_owned_metadata_reader_source_required')
        digest, count = hashlib.sha256(), 0
        while True:
            tick()
            raw = os.read(fd, 65537 - count)
            if not raw:
                break
            count += len(raw)
            need(count <= 65536, 'metadata_reader_source_grew')
            digest.update(raw)
        need(count == before.st_size and file_key(before) == file_key(os.fstat(fd))
             == file_key(os.stat(path.name, dir_fd=parent, follow_symlinks=False))
             and digest.hexdigest() == expected_sha, 'actual_metadata_reader_source_pin_required')
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def summarize(value):
    """Finite label domains only; never echo input body/token/error text."""
    domains = {'schema': SAFE_SCHEMAS, 'status': SAFE_STATUSES,
               'phase': frozenset(PHASES), 'error_type': SAFE_ERROR_TYPES,
               'reason': SAFE_REASON_CODES | SAFE_ERROR_TYPES,
               'guard_error': SAFE_REASON_CODES | SAFE_ERROR_TYPES,
               'cleanup_error_type': SAFE_ERROR_TYPES}
    result = {}
    for key, allowed in domains.items():
        label = value.get(key)
        if type(label) is str:
            result[key] = label if label in allowed else UNCLASSIFIED
    for key in ('worker_exit', 'exit_code'):
        code = value.get(key)
        if type(code) is int:
            result[key] = code if -255 <= code <= 255 else UNCLASSIFIED
    for key in ('worker_reaped', 'group_absent', 'allocation_released'):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    resource_record = value.get('advice', value.get('resource', {}))
    if type(resource_record) is dict:
        advice = resource_record.get('advice', resource_record)
        if type(advice) is dict and type(advice.get('decision')) is str:
            label = advice['decision']
            result['resource_decision'] = label if label in SAFE_RESOURCE_DECISIONS else UNCLASSIFIED
    return result


def executable_facts(role, path):
    """Observe current interpreter/system tool traits; never execute them."""
    tick()
    path = Path(path)
    before = path.lstat()
    mode = stat.S_IMODE(before.st_mode)
    rejected = []
    predicates = [(stat.S_ISREG(before.st_mode), 'regular_file'),
        (before.st_nlink == 1, 'single_link'),
        (before.st_uid in {0, os.getuid()}, 'root_or_current_uid'),
        (bool(mode & 0o111), 'executable_mode'),
        (mode & 0o022 == 0, 'no_group_world_write'),
        (0 < before.st_size <= 64 * 1024**2, 'one_to_64MiB')]
    rejected = [name for allowed, name in predicates if not allowed]
    return {'role': role, 'basename': bounded_text(path.name, 128),
        'uid': before.st_uid, 'current_uid': os.getuid(), 'mode': f'{mode:04o}',
        'nlink': before.st_nlink, 'bytes': before.st_size,
        'regular': stat.S_ISREG(before.st_mode),
        'collector_R3_failed_predicates': rejected,
        'purpose': 'Observed metadata only; not a new executable admission or relaxed guard.'}


def collect_metadata():
    report = {'schema': 'studio-minimal-ci-failure-evidence/1',
        'qualification': 'BOUNDED_DIAGNOSTIC_METADATA_ONLY_NOT_CONTROL_CUSTODY_OR_NATIVE_PASS',
        'origin_machine': bounded_text(os.uname().nodename, 128),
        'records': [], 'errors': [], 'executables': [], 'root_state': 'unobserved'}
    for role, path in [('current_trusted_interpreter', Path(sys.executable)),
                       ('system_ps', Path('/bin/ps'))]:
        try:
            if role == 'current_trusted_interpreter':
                path = path.resolve(strict=True)
            report['executables'].append(executable_facts(role, path))
        except (OSError, Refused) as error:
            report['errors'].append({'role': role, 'error_type': type(error).__name__})
    root_fd = None
    try:
        root_fd = directory(ROOT, private=True)
        initial_root = directory_key(os.fstat(root_fd))
        report['root_state'] = 'owned_private_root'
        launch_path = 'stage2-parent/STAGE2_ENTRY_LAUNCH_R1.json'
        launch, launch_pin = read_json(root_fd, launch_path)
        report['records'].append({'pin': launch_pin, 'summary': summarize(launch)})
        owner = launch.get('owner')
        need(type(owner) is dict, 'reported_stage2_owner_object_required')
        attempt = owner.get('attempt_id')
        need(type(attempt) is str and re.fullmatch('attempt-[a-f0-9]{32}', attempt),
             'one_reported_stage2_attempt_required')
        paths = ['stage2-parent/' + attempt + '/STAGE2_RESULT.json']
        paths += ['stage2-parent/' + attempt + '/' + phase + '/' + name
                  for phase in PHASES for name in ('PARENT_RESULT.json', 'RESOURCE_ADMISSION.json')]
        for relative in paths:
            try:
                value, observed = read_json(root_fd, relative)
                report['records'].append({'pin': observed, 'summary': summarize(value)})
            except (OSError, ValueError, RecursionError, Refused) as error:
                report['errors'].append({'path': relative, 'error_type': type(error).__name__})
        check = directory(ROOT, private=True)
        try:
            need(directory_key(os.fstat(check)) == initial_root, 'CI_root_identity_changed')
        finally:
            os.close(check)
    except FileNotFoundError:
        report['root_state'] = 'root_or_stage2_launch_absent'
    except (OSError, ValueError, RecursionError, Refused) as error:
        report['root_state'] = 'metadata_refused_or_incomplete'
        report['errors'].append({'scope': 'stage2_metadata', 'error_type': type(error).__name__})
    finally:
        if root_fd is not None:
            os.close(root_fd)
    report['actual_control_bytes_read'] = READ_BYTES
    return report


def retain_report(temp, raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_REPORT, 'bounded_diagnostic_bytes_required')
    parent = directory(temp)
    parent_key = directory_key(os.fstat(parent))
    out = None
    try:
        try:
            os.mkdir('omegahive-control-receipts-r1', 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        out = os.open('omegahive-control-receipts-r1', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                      dir_fd=parent)
        info = os.fstat(out)
        need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
             'private_output_namespace_required')
        output_key = directory_key(info)
        name = 'minimal-failure-evidence-' + uuid.uuid4().hex + '.json'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=out)
        try:
            remaining = memoryview(raw)
            while remaining:
                tick()
                amount = os.write(fd, remaining[:65536])
                need(amount > 0, 'diagnostic_short_write')
                remaining = remaining[amount:]
            os.fchmod(fd, 0o400)
            os.fsync(fd)
            tick()
            completed = os.fstat(fd)
            need(stat.S_ISREG(completed.st_mode) and completed.st_uid == os.getuid()
                 and completed.st_nlink == 1 and completed.st_size == len(raw)
                 and stat.S_IMODE(completed.st_mode) == 0o400
                 and file_key(completed) == file_key(os.stat(name, dir_fd=out, follow_symlinks=False)),
                 'completed_diagnostic_leaf_changed')
        finally:
            os.close(fd)
        os.fsync(out)
        tick()
        check_parent = directory(temp)
        check_out = None
        try:
            need(directory_key(os.fstat(check_parent)) == parent_key,
                 'RUNNER_TEMP_identity_changed')
            check_out = os.open('omegahive-control-receipts-r1',
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=check_parent)
            need(directory_key(os.fstat(check_out)) == output_key
                 and file_key(os.stat(name, dir_fd=check_out, follow_symlinks=False))
                 == file_key(completed), 'retained_diagnostic_namespace_changed')
            tick()
        finally:
            if check_out is not None:
                os.close(check_out)
            os.close(check_parent)
        return name
    finally:
        if out is not None:
            os.close(out)
        os.close(parent)


def main(argv=None):
    global STARTED
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--dedicated-ci-job', action='store_true')
    args = parser.parse_args(argv)
    if not args.run:
        print(json.dumps({'status': 'MINIMAL_EVIDENCE_SOURCE_INTERFACE_ONLY',
            'worker_started': False, 'qualification': 'none'}))
        return 0
    STARTED = time.monotonic()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, cancelled)
    signal.alarm(WALL_SECONDS)
    try:
        need(args.dedicated_ci_job and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', args.owner)
             and os.getuid() == os.geteuid() > 0 and sys.flags.isolated and sys.flags.no_site
             and sys.dont_write_bytecode and not sys.flags.optimize
             and os.environ.get('PATH') == SYSTEM_PATH and os.environ.get('GITHUB_ACTIONS') == 'true',
             'explicit_isolated_dedicated_metadata_read_required')
        need(re.fullmatch('[a-f0-9]{64}', args.source_sha256), 'external_source_pin_required')
        verify_own_source(args.source_sha256)
        report = collect_metadata()
        tick()
        report['source_owner'] = args.owner
        report['source_sha256'] = args.source_sha256
        raw = (json.dumps(report, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
        need(len(raw) <= MAX_REPORT, 'diagnostic_report_bound')
        # The bounded summary reaches CI logs even when output admission fails.
        print(raw.decode(), end='', flush=True)
        temp = Path(os.environ.get('RUNNER_TEMP', ''))
        need(temp.is_absolute() and not temp.is_relative_to(ROOT), 'separate_RUNNER_TEMP_required')
        retain_report(temp, raw)
        return 0
    except BaseException as error:
        print(json.dumps({'status': 'MINIMAL_EVIDENCE_FAILED_RETAINED',
            'error_type': type(error).__name__, 'qualification': 'none'}), flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
