"""Owned Darwin audit commands with pre-exec registration and real kernel evidence.

Imported definitions do no work. Construct only in an admitted fresh-session
phase worker. Direct CLI is reserved for this same pinned file's pipe-held
bootstrap bridge. No Source review or successful runtime evidence is generated.
"""
from pathlib import Path
import argparse
import ctypes
import errno
import hashlib
import json
import math
import os
import re
import select
import selectors
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

BASE = Path('/private/tmp/omegahive-ci-r12')
JOB = BASE / 'runtime-job'
SOURCE = BASE / 'stage2-parent/audit_process_runner.py'
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
PYTHON_PIN = {'path': str(PYTHON), 'bytes': 18652104,
              'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
REVIEW = BASE / 'stage2-source/STATIC_STAGE2_SOURCE_REVIEW.json'
WORK_SECONDS, WHOLE_SECONDS, CLEANUP_SECONDS = 1500, 1800, 20
RSS_LIMIT, COMMAND_LOG_LIMIT, AGGREGATE_LOG_LIMIT = 3 * 1024**3, 65536, 64 * 1024**2
MAX_COMMANDS, MAX_GROUP_PIDS, SAMPLE_INTERVAL, MAX_GAP = 8202, 8192, .25, 2.5
MAX_CLOSURE_BYTES = 8 * 1024**2
ADMISSION_NAMES = {
    'native_audit': ('NATIVE_AUDIT_ADMISSION_R1.json', 'NATIVE_AUDIT_TASK_ADMISSION_R1.json',
                     'NATIVE_AUDIT_RESOURCE_ADMISSION_R1.json'),
    'relocation': ('RELOCATION_AUDIT_ADMISSION_R1.json', 'RELOCATION_AUDIT_TASK_ADMISSION_R1.json',
                   'RELOCATION_AUDIT_RESOURCE_ADMISSION_R1.json'),
}
TOOL_PATHS = {'ps': '/bin/ps', 'lipo': '/usr/bin/lipo', 'otool': '/usr/bin/otool',
              'sh': '/bin/sh', 'dirname': '/usr/bin/dirname'}
LIBPROC = None
ACTIVE_RUNNER = None


class RunnerRefused(RuntimeError):
    pass


class ObservationUnavailable(RunnerRefused):
    pass


def need(value, reason):
    if not value:
        raise RunnerRefused(reason)


def same(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return set(actual) == set(expected) and all(same(actual[k], v) for k, v in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(same(a, b) for a, b in zip(actual, expected))
    return actual == expected


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def object_pairs(rows):
    result = {}
    for key, value in rows:
        need(key not in result, 'duplicate_JSON_key')
        result[key] = value
    return result


def object_bytes(raw):
    def invalid(_value):
        raise RunnerRefused('nonfinite_JSON')
    try:
        result = json.loads(raw, object_pairs_hook=object_pairs, parse_constant=invalid)
    except (ValueError, UnicodeError) as error:
        raise RunnerRefused('invalid_JSON') from error
    need(type(result) is dict, 'JSON_object_required')
    return result


def json_bytes(value, maximum=65536):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    need(len(raw) <= maximum, 'JSON_byte_bound')
    return raw


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def absolute(path):
    value = str(path)
    result = Path(value)
    need(result.is_absolute() and str(result) == value and '..' not in result.parts,
         'canonical_absolute_path_required')
    return result


def directory(path, owner_uid=None, private=False):
    path = absolute(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        need(stat.S_ISDIR(info.st_mode), 'real_directory_required')
        if owner_uid is not None:
            need(info.st_uid == owner_uid, 'directory_owner_mismatch')
        if private:
            need(stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_required')
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory_identity(path, owner_uid):
    fd = directory(path, owner_uid, True)
    try:
        info = os.fstat(fd)
        return {'path': str(path), 'dev': info.st_dev, 'ino': info.st_ino,
                'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}
    finally:
        os.close(fd)


def key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def pin_shape(pin, path, maximum):
    need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
         and pin.get('path') == str(path) and type(pin.get('bytes')) is int
         and 0 < pin['bytes'] <= maximum and type(pin.get('sha256')) is str
         and re.fullmatch('[a-f0-9]{64}', pin['sha256']) is not None, 'closed_exact_file_pin_required')
    return pin


def read_file(path, owner_uid, maximum, expected=None, executable=False, readonly=False):
    path = absolute(path)
    if expected is not None:
        pin_shape(expected, path, maximum)
    parent = directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == owner_uid
             and 0 < before.st_size <= maximum, 'owned_bounded_regular_file_required')
        need(not executable or before.st_mode & 0o111, 'executable_file_required')
        need(not readonly or stat.S_IMODE(before.st_mode) == 0o400, 'immutable_metadata_mode_required')
        chunks, digest, size = [], hashlib.sha256(), 0
        while True:
            block = os.read(fd, min(65536, maximum + 1 - size))
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'file_growth_bound')
            chunks.append(block)
            digest.update(block)
        need(size == before.st_size and key(before) == key(os.fstat(fd))
             == key(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
             'file_changed_during_read')
        observed = {'path': str(path), 'bytes': size, 'sha256': digest.hexdigest()}
        need(expected is None or same(observed, expected), 'file_pin_mismatch')
        return b''.join(chunks), observed
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def write_new(path, raw, owner_uid, mode=0o400):
    path = absolute(path)
    parent = directory(path.parent, owner_uid, True)
    fd = None
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        remaining = memoryview(raw)
        while remaining:
            count = os.write(fd, remaining)
            need(count > 0, 'short_output_write')
            remaining = remaining[count:]
        os.fsync(fd)
        os.fchmod(fd, mode)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == owner_uid and info.st_nlink == 1
             and info.st_size == len(raw) and key(info) == key(path.lstat()),
             'exclusive_output_identity_changed')
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)
    return {'path': str(path), 'bytes': len(raw), 'sha256': sha(raw)}


def ready(path, owner_uid):
    # Atomic empty commit marker, published only after its JSON is closed/fsynced.
    write_new(path, b'', owner_uid, mode=0o400)


def marker_present(path, owner_uid):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    need(stat.S_ISREG(info.st_mode) and info.st_uid == owner_uid and info.st_nlink == 1
         and info.st_size == 0 and stat.S_IMODE(info.st_mode) == 0o400,
         'owned_ready_marker_required')
    return True


def admission_paths(kind):
    need(type(kind) is str and kind in ADMISSION_NAMES, 'closed_audit_kind_required')
    return tuple(BASE / 'native-source' / name for name in ADMISSION_NAMES[kind])


def registration_scope(path, kind):
    admission_paths(kind)
    value = absolute(path)
    need(value.is_relative_to(BASE / 'stage2-parent'), 'fixed_phase_registration_root_required')
    relative = str(value.relative_to(BASE / 'stage2-parent'))
    need(re.fullmatch('attempt-[a-f0-9]{32}/' + kind + '/command-groups', relative),
         'fixed_phase_registration_root_required')
    return value


def libproc():
    global LIBPROC
    if LIBPROC is None:
        need(sys.platform == 'darwin' and os.uname().machine == 'arm64', 'Darwin_arm64_required')
        value = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        value.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                      ctypes.c_void_p, ctypes.c_int]
        value.proc_pidinfo.restype = ctypes.c_int
        value.proc_listpgrppids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        value.proc_listpgrppids.restype = ctypes.c_int
        LIBPROC = value
    return LIBPROC


def bsd_snapshot(pid):
    need(type(pid) is int and pid > 0, 'positive_observation_PID_required')
    buffer = ctypes.create_string_buffer(136)
    ctypes.set_errno(0)
    count = libproc().proc_pidinfo(pid, 3, 0, buffer, 136)
    if count != 136:
        code = ctypes.get_errno()
        if count <= 0 and code == errno.ESRCH:
            raise ProcessLookupError(code, 'observed_process_absent')
        raise ObservationUnavailable('exact_public_proc_bsdinfo_unavailable')
    raw = buffer.raw
    result = {'pid': struct.unpack_from('=I', raw, 12)[0],
              'ppid': struct.unpack_from('=I', raw, 16)[0],
              'uid': struct.unpack_from('=I', raw, 20)[0],
              'pgid': struct.unpack_from('=I', raw, 100)[0],
              'start_tvsec': struct.unpack_from('=Q', raw, 120)[0],
              'start_tvusec': struct.unpack_from('=Q', raw, 128)[0],
              'status': struct.unpack_from('=I', raw, 4)[0]}
    need(result['pid'] == pid and result['start_tvsec'] > 0
         and 0 <= result['start_tvusec'] < 1000000, 'kernel_birth_identity_invalid')
    return result


def birth_token(identity):
    value = {name: identity[name] for name in ('pid', 'start_tvsec', 'start_tvusec')}
    need(all(type(item) is int for item in value.values()) and value['pid'] > 0
         and value['start_tvsec'] > 0 and 0 <= value['start_tvusec'] < 1000000,
         'closed_kernel_birth_token_required')
    return value


def process_identity(pid):
    """Public kernel identity; no process spawned and no private flavor used."""
    before = bsd_snapshot(pid)
    sid = os.getsid(pid)
    after = bsd_snapshot(pid)
    need(birth_token(before) == birth_token(after)
         and before['uid'] == after['uid'] and before['pgid'] == after['pgid']
         and type(sid) is int and sid > 0, 'kernel_identity_changed_during_observation')
    return {name: after[name] for name in ('pid', 'ppid', 'uid', 'pgid', 'start_tvsec', 'start_tvusec')} | {'sid': sid}


def group_pids(pgid):
    need(type(pgid) is int and pgid > 0, 'positive_owned_PGID_required')
    values = (ctypes.c_int * MAX_GROUP_PIDS)()
    ctypes.set_errno(0)
    count = libproc().proc_listpgrppids(pgid, values, ctypes.sizeof(values))
    code = ctypes.get_errno()
    # Public libproc.c returns PID COUNT, although the input capacity is bytes.
    if count < 0 or (count == 0 and code != 0):
        raise ObservationUnavailable('owned_group_census_unavailable')
    need(type(count) is int and 0 <= count < MAX_GROUP_PIDS,
         'owned_group_census_truncated_or_invalid')
    pids = [values[index] for index in range(count)]
    need(all(pid > 0 for pid in pids), 'owned_group_census_invalid_PID')
    need(len(pids) == len(set(pids)), 'owned_group_census_duplicate_PID')
    return pids


def resident_bytes(pid, expected_birth):
    before = bsd_snapshot(pid)
    need(birth_token(before) == expected_birth, 'RSS_process_birth_changed')
    if before['status'] == 5:  # Public sys/proc.h SZOMB; accounted as zero resident bytes.
        return 0
    buffer = ctypes.create_string_buffer(96)
    ctypes.set_errno(0)
    count = libproc().proc_pidinfo(pid, 4, 0, buffer, 96)
    if count != 96:
        if count <= 0 and ctypes.get_errno() == errno.ESRCH:
            raise ProcessLookupError(errno.ESRCH, 'observed_process_absent')
        raise ObservationUnavailable('exact_public_proc_taskinfo_unavailable')
    after = bsd_snapshot(pid)
    need(birth_token(after) == expected_birth, 'RSS_process_birth_changed')
    return struct.unpack_from('=Q', buffer.raw, 8)[0]


def check_python_and_source(runner_pin, uid):
    need(Path(__file__).absolute() == SOURCE and sys.executable == str(PYTHON)
         and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
         and not sys.flags.optimize and os.getuid() == os.geteuid() == uid and uid > 0,
         'exact_isolated_runner_invocation_required')
    read_file(SOURCE, uid, 256 * 1024, runner_pin)
    read_file(PYTHON, uid, 32 * 1024**2, PYTHON_PIN, executable=True)


def private_environment_pins(env, uid):
    attempt = Path(env['HOME']).parent
    return [directory_identity(path, uid) for path in
            (BASE, attempt.parent, attempt, Path(env['HOME']), Path(env['TMPDIR']))]


def executable_owner(pin, runtime_root, uid):
    path = absolute(pin['path'])
    if str(path) in TOOL_PATHS.values():
        return 0
    need(path.is_relative_to(runtime_root) and path != runtime_root,
         'executable_outside_fixed_runtime_or_system_tools')
    return uid


def validate_ack(ack, registration, registration_sha256, supervisor_pid):
    expected = {'schema': 'studio-audit-command-group-ack/1', 'nonce': registration['nonce'],
                'command': registration['command'], 'supervisor_pid': supervisor_pid,
                'registration_sha256': registration_sha256}
    need(same(ack, expected), 'parent_ACK_mismatch')
    return ack


def expand_private_inputs(argv, inputs, tmpdir):
    need(type(argv) is list and 0 < len(argv) <= 128 and type(inputs) is dict and len(inputs) <= 4,
         'bounded_argv_and_private_inputs_required')
    pins, total, used, effective = {}, 0, set(), []
    for name, raw in inputs.items():
        need(type(name) is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name)
             and type(raw) is bytes and len(raw) <= 32768, 'private_input_shape_required')
        total += len(raw)
        pins[name] = {'bytes': len(raw), 'sha256': sha(raw)}
    need(total <= 65536, 'private_input_total_bound')
    for value in argv:
        need(type(value) is str and 0 < len(value.encode()) <= 4096 and '\x00' not in value,
             'bounded_argv_string_required')
        if value.startswith('@private_input:'):
            name = value[len('@private_input:'):]
            need(name in inputs, 'private_input_placeholder_unbound')
            used.add(name)
            effective.append(str(tmpdir / name))
        else:
            effective.append(value)
    need(used == set(inputs), 'private_input_must_have_exact_placeholder')
    return effective, pins


def validate_environment(env, runtime_root):
    need(type(env) is dict and set(env) == {'HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL',
                                          'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE'}
         and all(type(value) is str for value in env.values())
         and env['PATH'] == str(runtime_root / 'swipl/bin') + ':/usr/bin:/bin'
         and env['LANG'] == env['LC_ALL'] == 'C'
         and env['PYTHONDONTWRITEBYTECODE'] == env['PYTHONNOUSERSITE'] == '1',
         'closed_private_environment_required')
    home, temp = absolute(env['HOME']), absolute(env['TMPDIR'])
    need(home.parent == temp.parent and home.name == 'HOME' and temp.name == 'TMP'
         and home.parent.parent == BASE / 'native-audit-attempts'
         and re.fullmatch('attempt-[a-f0-9]{32}', home.parent.name), 'private_environment_layout_required')
    return env


def identity_ids(identity):
    return {name: identity[name] for name in ('pid', 'pgid', 'sid')}


class ExitWatch:
    """Darwin proc exit notification without reaping the owned session leader."""
    def __init__(self, pid):
        need(hasattr(select, 'kqueue'), 'Darwin_kqueue_required')
        self.queue = select.kqueue()
        self.seen = False
        try:
            event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                 flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                                 fflags=select.KQ_NOTE_EXIT)
            self.queue.control([event], 0, 0)
        except BaseException:
            self.queue.close()
            raise

    def exited(self):
        if not self.seen:
            self.seen = any(event.fflags & select.KQ_NOTE_EXIT
                            for event in self.queue.control(None, 8, 0))
        return self.seen

    def close(self):
        self.queue.close()


class OwnedAuditRunner:
    def __init__(self, *, admission, context, whole_attempt_started_monotonic,
                 cancelled, registration_root):
        global ACTIVE_RUNNER
        need(ACTIVE_RUNNER is None, 'one_runner_per_fresh_phase_worker_required')
        need(type(admission) is dict and type(context) is dict and callable(cancelled)
             and finite(whole_attempt_started_monotonic), 'closed_runner_constructor_required')
        self.uid = os.geteuid()
        need(self.uid > 0 and os.getuid() == self.uid, 'positive_equal_owner_UID_required')
        self.admission, self.context = admission, context
        self.kind = context.get('audit_kind')
        self.owner_path, self.task_path, self.resource_path = admission_paths(self.kind)
        self.source_path = str(SOURCE)
        self.runner_pin = pin_shape(admission.get('process_runner_pin'), SOURCE, 256 * 1024)
        self.source_sha256 = self.runner_pin['sha256']
        check_python_and_source(self.runner_pin, self.uid)
        self.phase_start = whole_attempt_started_monotonic
        self.whole_attempt_deadline = self.phase_start + WHOLE_SECONDS
        need(self.phase_start <= time.monotonic() < self.whole_attempt_deadline - 300,
             'original_fresh_whole_phase_start_required')
        self.cancelled = cancelled
        self.registration_root = registration_scope(registration_root, self.kind)
        self.registration_identity = directory_identity(self.registration_root, self.uid)
        self.output_root = self.registration_root.parent / 'command-results'
        phasefd = directory(self.registration_root.parent, self.uid, True)
        try:
            os.mkdir('command-results', 0o700, dir_fd=phasefd)
        finally:
            os.close(phasefd)
        fd = directory(self.registration_root, self.uid, True)
        try:
            with os.scandir(fd) as entries:
                need(next(iter(entries), None) is None, 'fresh_empty_registration_root_required')
        finally:
            os.close(fd)
        self.worker = process_identity(os.getpid())
        need(self.worker['uid'] == self.uid and self.worker['pid'] == self.worker['pgid']
             == self.worker['sid'], 'actual_fresh_session_worker_required')
        self.worker_birth = birth_token(self.worker)
        self.supervisor_pid = os.getppid()
        self.supervisor = process_identity(self.supervisor_pid)
        need(self.supervisor['uid'] == self.uid and self.worker['ppid'] == self.supervisor_pid
             and self.supervisor_pid != self.worker['pid'], 'actual_owner_supervisor_required')
        self.supervisor_birth = birth_token(self.supervisor)
        self.groups = {}
        self.lock = threading.RLock()
        self.stop_sampler = threading.Event()
        self.guard_error = None
        self.last_sample = None
        self.rss_peak = 0
        self.command_rss_peak = 0
        self.max_sample_gap = 0
        self.sample_count = 0
        self.log_bytes = 0
        self.retained_bytes = 0
        self.command_index = 0
        self.closed = False
        self.running_command = False
        self.env = None
        self.runtime_root = None
        self._verify_admissions(initial=True)
        self._sample()
        ACTIVE_RUNNER = self
        self.sampler = threading.Thread(target=self._sample_loop, name='owned-audit-RSS', daemon=True)
        self.sampler.start()

    def _verify_admissions(self, initial=False):
        owner_pin = pin_shape(self.context.get('owner_admission'), self.owner_path, 65536)
        raw, _pin = read_file(self.owner_path, self.uid, 65536, owner_pin)
        actual = object_bytes(raw)
        owner_fields = {'schema', 'status', 'enabled', 'valid_until_epoch', 'job_path', 'job_identity',
                        'audit_kind', 'source_bundle_root', 'candidate_source_sha256',
                        'review_manifest_sha256', 'execution_owner', 'origin_machine', 'owner_uid',
                        'task_admission', 'resource_admission', 'process_runner_pin', 'tool_pins',
                        'native_worker_source_pin', 'petta_entrypoint', 'finalizer_source_pin',
                        'dynamic_image_contexts', 'task_id', 'resource_id', 'preparation_parent',
                        'stage1_manifest', 'stage1_source_review'}
        need(set(actual) == owner_fields, 'closed_owner_admission_required')
        need(same(actual, self.admission), 'actual_owner_admission_changed')
        need(actual.get('schema') == 'studio-Mac-CI-native-audit-admission/1'
             and actual.get('status') == 'OWNER_ADMITTED_NATIVE_AUDIT' and actual.get('enabled') is True
             and type(actual.get('owner_uid')) is int and actual.get('owner_uid') == self.uid
             and actual.get('audit_kind') == self.kind
             and actual.get('job_path') == str(JOB)
             and actual.get('job_identity') == self.context.get('job_identity')
             and actual.get('candidate_source_sha256') == self.context.get('candidate_source_sha256')
             and actual.get('execution_owner') == self.context.get('execution_owner')
             and actual.get('origin_machine') == self.context.get('origin_machine'),
             'owner_phase_context_mismatch')
        identity = directory_identity(JOB, self.uid)
        need([identity['dev'], identity['ino'], identity['uid'], identity['mode']]
             == self.context['job_identity'], 'actual_private_job_identity_mismatch')
        read_file(SOURCE, self.uid, 256 * 1024, self.runner_pin)
        review_raw, _review_pin = read_file(REVIEW, self.uid, 256 * 1024)
        review = object_bytes(review_raw)
        need(sha(review_raw) == actual.get('review_manifest_sha256')
             and set(review) == {'schema', 'verdict', 'blocking_findings', 'reviewer',
                                 'source_owner', 'origin_machine', 'subjects', 'scope'}
             and review.get('schema') == 'studio-Mac-CI-stage2-static-source-review/1'
             and review.get('verdict') == 'PASS_SOURCE_ONLY' and review.get('blocking_findings') == [],
             'genuine_stage2_source_review_required')
        subject = review.get('subjects', {}).get('audit_process_runner')
        need(same(subject, {'path': 'stage2-parent/audit_process_runner.py',
                            'bytes': self.runner_pin['bytes'], 'sha256': self.source_sha256}),
             'actual_runner_static_source_subject_required')
        task_pin = pin_shape(actual.get('task_admission'), self.task_path, 65536)
        resource_pin = pin_shape(actual.get('resource_admission'), self.resource_path, 65536)
        task = object_bytes(read_file(self.task_path, self.uid, 65536, task_pin)[0])
        resource = object_bytes(read_file(self.resource_path, self.uid, 65536, resource_pin)[0])
        for value in (actual, task, resource):
            need(type(value.get('valid_until_epoch')) is int
                 and time.time() + (WORK_SECONDS if initial else 0) < value['valid_until_epoch']
                 and value['valid_until_epoch'] <= int(time.time()) + WHOLE_SECONDS,
                 'fresh_current_owner_task_resource_lease_required')
        need(set(task) == {'schema', 'status', 'valid_until_epoch', 'task_id', 'task_owner',
                           'job_path', 'job_identity', 'audit_kind', 'candidate_source_sha256',
                           'review_manifest_sha256', 'owner_uid', 'limits'}
             and set(resource) == {'schema', 'status', 'valid_until_epoch', 'resource_id',
                                  'job_path', 'job_identity', 'audit_kind', 'candidate_source_sha256',
                                  'review_manifest_sha256', 'owner_uid', 'reserved_limits'},
             'closed_task_resource_admission_required')
        shared = ('job_path', 'job_identity', 'audit_kind', 'candidate_source_sha256',
                  'review_manifest_sha256', 'owner_uid')
        need(all(same(task.get(name), actual[name]) and same(resource.get(name), actual[name])
                 for name in shared), 'task_resource_owner_phase_mismatch')
        limits = {'cpu_cores': 2.25, 'ram_bytes': 3355443200, 'scratch_bytes': 4 * 1024**3,
                  'wall_seconds': WHOLE_SECONDS, 'max_commands': MAX_COMMANDS,
                  'max_macho_files': 2048, 'max_log_bytes': AGGREGATE_LOG_LIMIT,
                  'combined_rss_bytes': RSS_LIMIT}
        need(task.get('schema') == 'studio-Mac-CI-native-audit-task/1'
             and task.get('status') == 'ADMITTED_NATIVE_AUDIT'
             and task.get('task_id') == actual.get('task_id')
             and task.get('task_owner') == actual.get('execution_owner')
             and resource.get('schema') == 'studio-Mac-CI-native-audit-resource/1'
             and resource.get('status') == 'RESERVED_NATIVE_AUDIT'
             and resource.get('resource_id') == actual.get('resource_id')
             and same(task.get('limits'), limits) and same(resource.get('reserved_limits'), limits),
             'full_task_resource_ownership_and_limits_required')
        self.lease_end = min(value['valid_until_epoch'] for value in (actual, task, resource))
        self.owner_pin = owner_pin
        self.ownership_pins = {'task_admission': task_pin, 'resource_admission': resource_pin}

    def _tick(self, deadline, *, cleanup=False):
        need(finite(deadline) and time.monotonic() < min(deadline, self.whole_attempt_deadline),
             'actual_phase_or_command_deadline')
        if cleanup:
            return
        need(not self.closed, 'runner_already_closed')
        need(not self.cancelled() and not os.path.lexists(self.registration_root.parent / 'STOP'),
             'phase_cancelled_or_STOP')
        need(self.guard_error is None, self.guard_error or 'sampler_guard_failure')
        need(time.time() < self.lease_end, 'owner_task_resource_lease_expired')
        need(birth_token(process_identity(self.worker['pid'])) == self.worker_birth
             and birth_token(process_identity(self.supervisor_pid)) == self.supervisor_birth,
             'worker_or_supervisor_birth_changed')
        need(directory_identity(self.registration_root, self.uid) == self.registration_identity,
             'registration_root_identity_changed')

    def _sample(self):
        with self.lock:
            groups = [(self.worker['pid'], self.worker['sid'], None)]
            groups += [(pid, row['sid'], row) for pid, row in self.groups.items() if row['active']]
            seen, total = set(), 0
            for pgid, sid, registration in groups:
                for pid in group_pids(pgid):
                    need(pid not in seen, 'duplicate_owned_census_PID')
                    seen.add(pid)
                    try:
                        identity = process_identity(pid)
                        need(identity['uid'] == self.uid and identity['pgid'] == pgid
                             and identity['sid'] == sid, 'owned_census_identity_mismatch')
                        token = birth_token(identity)
                        total += resident_bytes(pid, token)
                        if registration is not None:
                            registration['members'][pid] = token
                    except ProcessLookupError:
                        continue
            need(self.worker['pid'] in seen, 'phase_worker_missing_from_census')
            observed = time.monotonic()
            if self.last_sample is not None:
                gap = observed - self.last_sample
                self.max_sample_gap = max(self.max_sample_gap, gap)
                need(0 <= gap <= MAX_GAP, 'owned_RSS_observation_gap')
            self.last_sample = observed
            self.sample_count += 1
            self.rss_peak = max(self.rss_peak, total)
            if self.running_command:
                self.command_rss_peak = max(self.command_rss_peak, total)
            need(0 < total < RSS_LIMIT, 'owned_worker_and_registered_group_RSS_limit')
            return total

    def _sample_loop(self):
        while not self.stop_sampler.wait(SAMPLE_INTERVAL):
            try:
                self._tick(self.whole_attempt_deadline)
                self._sample()
            except BaseException as error:
                self.guard_error = str(error) if isinstance(error, RunnerRefused) else type(error).__name__
                # Source-owned self notification; external parent independently owns cleanup.
                try:
                    os.kill(os.getpid(), signal.SIGTERM)
                except OSError:
                    pass
                return

    def environment(self, *, profile, runtime_root, owner_uid, attempt_parent,
                    no_bytecode, no_user_site):
        self._tick(self.whole_attempt_deadline - 300)
        need(self.env is None and profile == 'private-closed-offline' and owner_uid == self.uid
             and attempt_parent == str(BASE / 'native-audit-attempts')
             and no_bytecode is True and no_user_site is True, 'one_private_closed_environment_required')
        root = absolute(runtime_root)
        if self.kind == 'native_audit':
            need(root == JOB / 'OmegaHive.bundle', 'fixed_native_runtime_root_required')
        else:
            need(root.name == 'OmegaHive.bundle' and root.parent.parent == BASE / 'runtime-relocation-attempts'
                 and re.fullmatch('attempt-[a-f0-9]{32}', root.parent.name), 'fixed_relocated_runtime_root_required')
        parent = directory(BASE / 'native-audit-attempts', self.uid, True)
        try:
            name = 'attempt-' + uuid.uuid4().hex
            os.mkdir(name, 0o700, dir_fd=parent)
        finally:
            os.close(parent)
        attempt = BASE / 'native-audit-attempts' / name
        fd = directory(attempt, self.uid, True)
        try:
            os.mkdir('HOME', 0o700, dir_fd=fd)
            os.mkdir('TMP', 0o700, dir_fd=fd)
        finally:
            os.close(fd)
        env = {'HOME': str(attempt / 'HOME'), 'TMPDIR': str(attempt / 'TMP'),
               'PATH': str(root / 'swipl/bin') + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
               'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}
        validate_environment(env, root)
        self.runtime_root, self.env = root, env
        self.env_pins = private_environment_pins(env, self.uid)
        return dict(env)

    def _metadata(self, path, value, *, maximum=65536, closure=False):
        raw = json_bytes(value, maximum)
        with self.lock:
            limit = AGGREGATE_LOG_LIMIT if closure else AGGREGATE_LOG_LIMIT - 8 * 1024**2
            need(self.retained_bytes + len(raw) <= limit, 'actual_aggregate_retained_log_limit')
            result = write_new(path, raw, self.uid)
            self.retained_bytes += len(raw)
        return result

    def _register_command(self, identity, executable_pin, index, nonce):
        need(identity['uid'] == self.uid and identity['ppid'] == self.worker['pid']
             and identity['pid'] == identity['pgid'] == identity['sid'],
             'actual_owned_command_session_required')
        record = {'schema': 'studio-audit-command-group-registration/1', 'nonce': nonce,
                  'audit_kind': self.kind, 'command_index': index,
                  'supervisor_pid': self.supervisor_pid,
                  'phase_worker': identity_ids(self.worker), 'command': identity_ids(identity),
                  'phase_worker_birth': self.worker_birth, 'command_birth': birth_token(identity),
                  'runner_pin': self.runner_pin, 'owner_admission_pin': self.owner_pin,
                  'task_admission_pin': self.ownership_pins['task_admission'],
                  'resource_admission_pin': self.ownership_pins['resource_admission'],
                  'executable_pin': executable_pin, 'registered_at_monotonic': time.monotonic(),
                  'whole_attempt_started_monotonic': self.phase_start,
                  'whole_attempt_deadline': self.whole_attempt_deadline}
        prefix = self.registration_root / ('command-' + format(index, '06d'))
        record_pin = self._metadata(Path(str(prefix) + '.json'), record)
        ready(Path(str(prefix) + '.ready'), self.uid)
        return prefix, record, record_pin

    def _wait_for_parent_ack(self, prefix, record, record_pin, deadline, pump):
        path = Path(str(prefix) + '.ack.json')
        marker = Path(str(prefix) + '.ack.ready')
        while not marker_present(marker, self.uid):
            self._tick(deadline)
            pump()
            time.sleep(.01)
        raw, _pin = read_file(path, self.uid, 65536, readonly=True)
        ack = validate_ack(object_bytes(raw), record, record_pin['sha256'], self.supervisor_pid)
        with self.lock:
            need(self.retained_bytes + len(raw) <= AGGREGATE_LOG_LIMIT - 8 * 1024**2,
                 'actual_aggregate_retained_log_limit')
            self.retained_bytes += len(raw)
        # A valid old ACK cannot authorize GO after cancellation/STOP/cleanup.
        self._tick(deadline)
        return ack

    def _safe_signal(self, row, number):
        """Signal only a still-unreaped owned leader birth; never numeric fallback."""
        need(not row['reaped'], 'cannot_signal_reaped_leader_group')
        identity = process_identity(row['pid'])
        need(birth_token(identity) == row['birth'] and identity['uid'] == self.uid
             and identity['pgid'] == row['pid'] == identity['sid']
             and row['pid'] not in (self.worker['pid'], self.supervisor['pgid'], os.getpgrp()),
             'owned_signal_birth_or_session_mismatch')
        # Every observed member must still belong to this admitted UID/session.
        for member in group_pids(row['pid']):
            try:
                current = process_identity(member)
            except ProcessLookupError:
                continue
            need(current['uid'] == self.uid and current['pgid'] == row['pid']
                 and current['sid'] == row['sid'], 'foreign_member_blocks_group_signal')
            token = birth_token(current)
            prior = row['members'].get(member)
            need(prior is None or same(prior, token), 'member_birth_changed_before_signal')
            row['members'][member] = token
        # Recheck the anchor immediately before the sole group signal.
        need(birth_token(process_identity(row['pid'])) == row['birth'],
             'leader_birth_changed_before_signal')
        os.killpg(row['pid'], number)
        row['signals'].append(signal.Signals(number).name)

    def _cleanup_owned(self, row, deadline, pump):
        errors = []
        # No RSS/log/cancellation guards here: they cannot disable owned cleanup.
        try:
            for number in (None, signal.SIGTERM, signal.SIGKILL):
                remaining = group_pids(row['pid'])
                others = [pid for pid in remaining if pid != row['pid']]
                if row['watch'].exited() and not others:
                    break
                if number is not None:
                    try:
                        self._safe_signal(row, number)
                    except ProcessLookupError:
                        pass
                    except BaseException as error:
                        errors.append(str(error) if isinstance(error, RunnerRefused) else type(error).__name__)
                        break
                until = min(deadline, time.monotonic() + (.15 if number is None else 1.0))
                while time.monotonic() < until:
                    pump(cleanup=True)
                    remaining = group_pids(row['pid'])
                    if row['watch'].exited() and not any(pid != row['pid'] for pid in remaining):
                        break
                    time.sleep(.01)
                if time.monotonic() >= deadline:
                    errors.append('owned_cleanup_deadline')
                    break
            remaining_time = deadline - time.monotonic()
            remaining = group_pids(row['pid'])
            if remaining_time > 0 and row['watch'].exited() and not any(
                    pid != row['pid'] for pid in remaining):
                # Hold the leader unreaped until every other group member is gone.
                row['exit'] = row['process'].wait(timeout=remaining_time)
                row['reaped'] = True
            else:
                errors.append('owned_reap_or_descendant_cleanup_unconfirmed')
            row['absent'] = row['reaped'] and group_pids(row['pid']) == []
        except BaseException as error:
            errors.append(str(error) if isinstance(error, RunnerRefused) else type(error).__name__)
        row['cleanup_errors'] = errors
        row['active'] = not (row['reaped'] and row['absent'])
        return errors

    def run(self, *, executable, executable_pin, argv, cwd, environment,
            timeout_seconds, output_limit_bytes, private_inputs, merge_stderr,
            environment_profile, whole_attempt_deadline, command_deadline,
            combined_rss_limit_bytes, aggregate_log_limit_bytes, start_new_session, close_fds):
        command_started = time.monotonic()
        process = None
        row = None
        selector = None
        pipes = []
        record = None
        buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        overflow = False
        pipes_complete = False
        observed_bytes = 0
        guard = None
        effective = []
        input_pins = {}
        self.command_index += 1
        index = self.command_index

        def pump(cleanup=False):
            nonlocal overflow, observed_bytes
            if selector is None:
                return
            for event, _mask in selector.select(0):
                stream = event.fileobj
                try:
                    raw = os.read(stream.fileno(), 65536)
                except BlockingIOError:
                    continue
                if not raw:
                    selector.unregister(stream)
                    stream.close()
                    continue
                observed_bytes += len(raw)
                remaining = COMMAND_LOG_LIMIT - sum(len(value) for value in buffers.values())
                if len(raw) > remaining:
                    overflow = True
                kept = raw[:max(0, remaining)]
                buffers[event.data].extend(kept)
                with self.lock:
                    self.log_bytes += len(kept)
                    self.retained_bytes += len(kept)
                    too_large = self.retained_bytes > AGGREGATE_LOG_LIMIT - 8 * 1024**2
                if not cleanup:
                    need(not overflow, 'combined_command_output_limit')
                    need(not too_large, 'actual_aggregate_retained_log_limit')
            if not cleanup:
                self._tick(command_deadline)

        try:
            self._tick(self.whole_attempt_deadline - 300)
            need(not self.running_command and index <= MAX_COMMANDS, 'serial_bounded_command_required')
            need(self.env is not None and same(environment, self.env)
                 and environment_profile == 'private-closed-offline'
                 and cwd == str(self.runtime_root), 'fixed_command_environment_and_cwd_required')
            validate_environment(environment, self.runtime_root)
            need(type(timeout_seconds) is int and 0 < timeout_seconds <= 60
                 and output_limit_bytes == COMMAND_LOG_LIMIT and type(output_limit_bytes) is int
                 and combined_rss_limit_bytes == RSS_LIMIT and type(combined_rss_limit_bytes) is int
                 and aggregate_log_limit_bytes == AGGREGATE_LOG_LIMIT
                 and type(aggregate_log_limit_bytes) is int and start_new_session is True
                 and close_fds is True and type(merge_stderr) is bool,
                 'exact_command_resource_profile_required')
            need(finite(whole_attempt_deadline) and finite(command_deadline)
                 and command_started < command_deadline <= whole_attempt_deadline
                 <= self.whole_attempt_deadline - 300
                 and command_deadline <= command_started + timeout_seconds + .01,
                 'bounded_earlier_audit_work_deadline_required')
            self._verify_admissions()
            need(time.time() + (command_deadline - time.monotonic()) < self.lease_end,
                 'lease_must_cover_command_and_cleanup')
            owner = executable_owner(executable_pin, self.runtime_root, self.uid)
            pin_shape(executable_pin, absolute(executable), 1024**3)
            read_file(executable, owner, 1024**3, executable_pin, executable=True)
            read_file(SOURCE, self.uid, 256 * 1024, self.runner_pin)
            read_file(PYTHON, self.uid, 32 * 1024**2, PYTHON_PIN, executable=True)
            effective, input_pins = expand_private_inputs(argv, private_inputs, Path(environment['TMPDIR']))
            for name, raw in private_inputs.items():
                write_new(Path(environment['TMPDIR']) / name, raw, self.uid, mode=0o600)
            env_pins = private_environment_pins(environment, self.uid)
            need(env_pins == self.env_pins, 'private_environment_identity_changed')
            nonce = uuid.uuid4().hex
            self.running_command = True
            self.command_rss_peak = 0
            config_read, config_write = os.pipe()
            hello_read, hello_write = os.pipe()
            go_read, go_write = os.pipe()
            pipes.extend((config_read, config_write, hello_read, hello_write, go_read, go_write))
            process = subprocess.Popen([str(PYTHON), '-I', '-B', '-S', str(SOURCE),
                '--exec-bridge', '--config-fd', str(config_read), '--hello-fd', str(hello_write),
                '--go-fd', str(go_read)], cwd=str(self.runtime_root), env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                close_fds=True, pass_fds=(config_read, hello_write, go_read),
                start_new_session=True, bufsize=0)
            for fd in (config_read, hello_write, go_read):
                os.close(fd)
                pipes.remove(fd)
            watch = ExitWatch(process.pid)
            identity = process_identity(process.pid)
            need(identity['uid'] == self.uid and identity['ppid'] == self.worker['pid']
                 and identity['pid'] == identity['pgid'] == identity['sid'],
                 'actual_new_session_command_identity_required')
            row = {'pid': identity['pid'], 'pgid': identity['pgid'], 'sid': identity['sid'], 'birth': birth_token(identity),
                   'members': {process.pid: birth_token(identity)}, 'process': process,
                   'watch': watch, 'active': True, 'signals': [], 'reaped': False,
                   'absent': False, 'exit': None, 'guard_error': None, 'cleanup_errors': []}
            with self.lock:
                self.groups[process.pid] = row
            self._sample()
            selector = selectors.DefaultSelector()
            for stream, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                if stream is not None:
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, name)

            config = {'schema': 'studio-audit-exec-bridge-config/1', 'nonce': nonce, 'command_index': index,
                      'runner_pin': self.runner_pin, 'python_pin': PYTHON_PIN,
                      'owner_admission_pin': self.owner_pin, 'audit_kind': self.kind,
                      'task_admission_pin': self.ownership_pins['task_admission'],
                      'resource_admission_pin': self.ownership_pins['resource_admission'],
                      'worker_identity': self.worker, 'worker_birth': self.worker_birth,
                      'supervisor_pid': self.supervisor_pid, 'supervisor_birth': self.supervisor_birth,
                      'registration_root': str(self.registration_root),
                      'executable': executable, 'executable_pin': executable_pin,
                      'effective_argv': effective, 'cwd': cwd, 'environment': environment,
                      'private_input_pins': input_pins,
                      'phase_start': self.phase_start, 'phase_deadline': self.whole_attempt_deadline,
                      'command_deadline': command_deadline}
            _write_pipe(config_write, json_bytes(config, 256 * 1024), command_deadline, pump)
            os.close(config_write)
            pipes.remove(config_write)
            hello_raw = _read_pipe(hello_read, 8192, command_deadline, pump)
            hello = object_bytes(hello_raw)
            need(set(hello) == {'schema', 'nonce', 'identity', 'birth'}
                 and hello['schema'] == 'studio-audit-exec-bridge-ready/1'
                 and hello['nonce'] == nonce
                 and same(hello['identity'], identity)
                 and same(hello['birth'], row['birth']), 'actual_bridge_hello_identity_mismatch')
            need(same(process_identity(process.pid), identity), 'bridge_identity_changed_before_registration')
            prefix, record, record_pin = self._register_command(identity, executable_pin, index, nonce)
            self._wait_for_parent_ack(prefix, record, record_pin, command_deadline, pump)
            self._tick(command_deadline)
            # Last gate after ACK. The held bridge also checks STOP/parents before exec.
            need(birth_token(process_identity(process.pid)) == row['birth'], 'bridge_birth_changed_before_GO')
            os.write(go_write, b'G')
            os.close(go_write)
            pipes.remove(go_write)
            reserve = min(5.0, timeout_seconds / 4)
            work_deadline = command_deadline - reserve
            while True:
                pump()
                if watch.exited() and not selector.get_map():
                    break
                need(time.monotonic() < work_deadline, 'command_work_deadline_cleanup_reserved')
                time.sleep(.01)
        except BaseException as error:
            guard = str(error) if isinstance(error, RunnerRefused) else type(error).__name__
        finally:
            # Closing GO without the byte makes a pre-GO bridge exit without target exec.
            for fd in list(pipes):
                try:
                    os.close(fd)
                except OSError:
                    pass
            if row is not None:
                cleanup_deadline = min(command_deadline, self.whole_attempt_deadline,
                                       time.monotonic() + CLEANUP_SECONDS)
                cleanup_errors = self._cleanup_owned(row, cleanup_deadline, pump)
                if cleanup_errors:
                    guard = guard or 'owned_cleanup_unconfirmed'
                try:
                    pump(cleanup=True)
                except BaseException:
                    guard = guard or 'terminal_pipe_drain_unconfirmed'
                row['guard_error'] = guard
                if not row['active']:
                    row['watch'].close()
                    row['watch_closed'] = True
            elif process is not None:
                # Before identity/registration, only the pipe-held trusted bridge exists.
                # Popen owns this unreaped direct child; do not signal an unknown PGID.
                try:
                    process.kill()
                    process.wait(timeout=max(.01, min(2, self.whole_attempt_deadline - time.monotonic())))
                except BaseException:
                    guard = guard or 'unregistered_bridge_reap_unconfirmed'
            if selector is not None:
                pipes_complete = not bool(selector.get_map())
                selector.close()
            for stream in (() if process is None else (process.stdout, process.stderr)):
                if stream is not None and not stream.closed:
                    stream.close()
            self.running_command = False
        if row is None:
            self.guard_error = guard or 'no_observed_command_identity'
            self._metadata(self.output_root / ('command-' + format(index, '06d') + '.rejected.json'),
                           {'schema': 'studio-audit-command-rejection/1', 'guard_error': self.guard_error,
                            'command_index': index, 'actual_process_created': process is not None})
            raise RunnerRefused(self.guard_error)
        stdout, stderr = bytes(buffers['stdout']), bytes(buffers['stderr'])
        finished = time.monotonic()
        if overflow:
            guard = guard or 'combined_command_output_limit'
        if finished > command_deadline:
            guard = guard or 'command_deadline_exceeded_in_finalization'
        row['guard_error'] = guard
        result = {'exit': row['exit'], 'pid': row['pid'], 'pgid': row['pgid'], 'sid': row['sid'],
                  'stdout': stdout, 'stderr': stderr, 'stdout_bytes': len(stdout), 'stderr_bytes': len(stderr),
                  'stdout_sha256': sha(stdout), 'stderr_sha256': sha(stderr),
                  'worker_reaped': row['reaped'], 'group_absent': row['absent'],
                  'signals': list(row['signals']), 'guard_error': guard, 'effective_argv': effective,
                  'effective_cwd': cwd, 'executable_pin': executable_pin, 'controller_pin': self.runner_pin,
                  'ownership_evidence_pins': self.ownership_pins, 'private_input_pins': input_pins,
                  'combined_rss_peak_bytes': self.command_rss_peak,
                  'environment_sha256': sha(json.dumps(environment, sort_keys=True, separators=(',', ':')).encode()),
                  'private_environment_pins': env_pins, 'stderr_merged': merge_stderr,
                  'elapsed_seconds': finished - command_started}
        try:
            for name, raw in (('stdout', stdout), ('stderr', stderr)):
                write_new(self.output_root / ('command-' + format(index, '06d') + '.' + name + '.log'),
                          raw, self.uid, mode=0o600)
            self._metadata(self.output_root / ('command-' + format(index, '06d') + '.result.json'),
                           {'schema': 'studio-audit-command-result/1',
                            **{key: value for key, value in result.items() if key not in {'stdout', 'stderr', 'elapsed_seconds'}},
                            'elapsed_seconds_through_cleanup': result['elapsed_seconds'],
                            'observed_output_bytes': observed_bytes,
                            'captured_output_complete': not overflow and pipes_complete})
        except BaseException as error:
            result['guard_error'] = guard or 'command_evidence_retention_failed'
            row['guard_error'] = result['guard_error']
        result['elapsed_seconds'] = time.monotonic() - command_started
        if time.monotonic() > command_deadline or time.time() >= self.lease_end:
            result['guard_error'] = result['guard_error'] or 'deadline_or_lease_expired_during_retention'
            row['guard_error'] = result['guard_error']
        if result['guard_error'] is not None:
            self.guard_error = result['guard_error']
        return result

    def finish(self):
        if self.closed:
            need(self.closure['status'] == 'CLOSED_OWNED_GROUPS_ABSENT', 'runner_failed_retained')
            return self.closure
        errors = []
        if self.guard_error is not None:
            errors.append(self.guard_error)
        self.stop_sampler.set()
        join_budget = min(2.0, max(0, self.whole_attempt_deadline - time.monotonic()))
        self.sampler.join(join_budget)
        if self.sampler.is_alive():
            errors.append('sampler_join_unconfirmed')
        # Final resource observation is truthful even if over limit; cleanup still proceeds.
        try:
            self._sample()
        except BaseException as error:
            errors.append(str(error) if isinstance(error, RunnerRefused) else type(error).__name__)
        for row in self.groups.values():
            if row['active']:
                cleanup_deadline = min(self.whole_attempt_deadline, time.monotonic() + CLEANUP_SECONDS)
                self._cleanup_owned(row, cleanup_deadline, lambda cleanup=False: None)
            if not row.get('watch_closed'):
                row['watch'].close()
                row['watch_closed'] = True
            if row['guard_error'] is not None:
                errors.append(row['guard_error'])
            if not (row['reaped'] and row['absent'] and row['signals'] == []):
                errors.append('registered_command_not_cleanly_closed')
        rows = [{'pid': row['pid'], 'pgid': row['pgid'], 'sid': row['sid'],
                 'birth': row['birth'], 'worker_reaped': row['reaped'],
                 'group_absent': row['absent'], 'signals': list(row['signals']),
                 'guard_error': row['guard_error']} for row in self.groups.values()]
        finished = time.monotonic()
        if finished > self.whole_attempt_deadline:
            errors.append('whole_phase_deadline_exceeded')
        if self.command_index != len(rows):
            errors.append('attempt_count_and_registered_groups_differ')
        errors = sorted(set(value[:256] for value in errors))
        closure = {'schema': 'studio-audit-runner-closure/1',
                   'status': 'FAILED_RETAINED' if errors else 'CLOSED_OWNED_GROUPS_ABSENT',
                   'audit_kind': self.kind, 'phase_worker': identity_ids(self.worker),
                   'phase_worker_birth': self.worker_birth, 'supervisor_pid': self.supervisor_pid,
                   'runner_pin': self.runner_pin, 'owner_admission_pin': self.owner_pin,
                   'ownership_evidence_pins': self.ownership_pins,
                   'whole_attempt_started_monotonic': self.phase_start,
                   'whole_attempt_deadline': self.whole_attempt_deadline,
                   'finished_at_monotonic': finished, 'elapsed_seconds': finished - self.phase_start,
                   'command_count': len(self.groups), 'aggregate_output_bytes': self.log_bytes,
                   'combined_rss_peak_bytes': self.rss_peak, 'sample_count': self.sample_count,
                   'max_sample_gap': self.max_sample_gap, 'registered_groups': rows,
                   'guard_errors': errors,
                   'qualification': 'Owned command runner closure only; no native audit/product pass'}
        while True:
            try:
                raw = json_bytes(closure, MAX_CLOSURE_BYTES)
                if self.retained_bytes + len(raw) <= AGGREGATE_LOG_LIMIT:
                    break
            except RunnerRefused:
                pass
            kept = len(closure['registered_groups'])
            need(kept > 0, 'bounded_failure_closure_cannot_be_retained')
            closure['registered_groups'] = closure['registered_groups'][:kept // 2]
            closure['status'] = 'FAILED_RETAINED'
            closure['guard_errors'] = errors + [
                'closure_vector_truncated_' + str(len(closure['registered_groups'])) + '_of_' + str(len(rows))]
        write_new(self.registration_root.parent / 'RUNNER_CLOSED.json', raw, self.uid)
        self.retained_bytes += len(raw)
        self.closure, self.closed = closure, True
        need(closure['status'] == 'CLOSED_OWNED_GROUPS_ABSENT', 'runner_failed_retained')
        return closure


def _write_pipe(fd, raw, deadline, pump):
    os.set_blocking(fd, False)
    remaining = memoryview(raw)
    while remaining:
        need(time.monotonic() < deadline, 'bridge_pipe_write_deadline')
        pump()
        try:
            count = os.write(fd, remaining)
            need(count > 0, 'bridge_pipe_short_write')
            remaining = remaining[count:]
        except BlockingIOError:
            time.sleep(.01)


def _read_pipe(fd, maximum, deadline, pump):
    os.set_blocking(fd, False)
    raw = bytearray()
    while True:
        need(time.monotonic() < deadline, 'bridge_pipe_read_deadline')
        pump()
        try:
            block = os.read(fd, min(65536, maximum + 1 - len(raw)))
        except BlockingIOError:
            time.sleep(.01)
            continue
        if not block:
            break
        raw.extend(block)
        need(len(raw) <= maximum, 'bridge_pipe_byte_bound')
    return bytes(raw)


def _bridge_guard(config, uid):
    need(type(config) is dict and set(config) == {
        'schema', 'nonce', 'command_index', 'runner_pin', 'python_pin', 'owner_admission_pin', 'audit_kind',
        'task_admission_pin', 'resource_admission_pin', 'worker_identity', 'worker_birth',
        'supervisor_pid', 'supervisor_birth', 'registration_root', 'executable', 'executable_pin',
        'effective_argv', 'cwd', 'environment', 'private_input_pins', 'phase_start',
        'phase_deadline', 'command_deadline'}
        and config['schema'] == 'studio-audit-exec-bridge-config/1'
        and type(config['nonce']) is str and re.fullmatch('[a-f0-9]{32}', config['nonce']),
        'closed_bridge_configuration_required')
    need(type(config['command_index']) is int and 0 < config['command_index'] <= MAX_COMMANDS,
         'bridge_bounded_command_index_required')
    need(finite(config['phase_start']) and finite(config['phase_deadline'])
         and config['phase_deadline'] == config['phase_start'] + WHOLE_SECONDS
         and finite(config['command_deadline']) and time.monotonic() < config['command_deadline']
         <= config['phase_deadline'] - 300, 'bridge_actual_deadline_required')
    check_python_and_source(config['runner_pin'], uid)
    need(same(config['python_pin'], PYTHON_PIN), 'fixed_bridge_PBS_pin_required')
    kind = config['audit_kind']
    owner_path, task_path, resource_path = admission_paths(kind)
    registration_root = registration_scope(config['registration_root'], kind)
    directory_identity(registration_root, uid)
    need(not os.path.lexists(registration_root.parent / 'STOP'), 'bridge_STOP_before_exec')
    worker = process_identity(config['worker_identity']['pid'])
    need(same(birth_token(worker), config['worker_birth']) and worker['uid'] == uid
         and identity_ids(worker) == identity_ids(config['worker_identity'])
         and worker['pid'] == os.getppid()
         and worker['ppid'] == config['supervisor_pid'], 'bridge_worker_birth_or_parent_mismatch')
    supervisor = process_identity(config['supervisor_pid'])
    need(same(birth_token(supervisor), config['supervisor_birth']) and supervisor['uid'] == uid,
         'bridge_supervisor_birth_mismatch')
    owner = object_bytes(read_file(owner_path, uid, 65536,
                                   config['owner_admission_pin'])[0])
    need(owner.get('owner_uid') == uid and owner.get('audit_kind') == kind
         and same(owner.get('process_runner_pin'), config['runner_pin'])
         and same(owner.get('task_admission'), config['task_admission_pin'])
         and same(owner.get('resource_admission'), config['resource_admission_pin']),
         'bridge_actual_owner_pins_mismatch')
    for path, pin in ((task_path, config['task_admission_pin']),
                      (resource_path, config['resource_admission_pin'])):
        evidence = object_bytes(read_file(path, uid, 65536, pin)[0])
        need(evidence.get('audit_kind') == kind and type(evidence.get('valid_until_epoch')) is int
             and time.time() < evidence['valid_until_epoch'], 'bridge_kind_or_lease_expired')
    need(type(owner.get('valid_until_epoch')) is int and time.time() < owner['valid_until_epoch'],
         'bridge_owner_lease_expired')
    root = absolute(config['cwd'])
    if kind == 'native_audit':
        need(root == JOB / 'OmegaHive.bundle', 'bridge_fixed_native_root_required')
    else:
        need(root.name == 'OmegaHive.bundle' and root.parent.parent == BASE / 'runtime-relocation-attempts'
             and re.fullmatch('attempt-[a-f0-9]{32}', root.parent.name), 'bridge_fixed_relocated_root_required')
    validate_environment(config['environment'], root)
    private_environment_pins(config['environment'], uid)
    need(type(config['effective_argv']) is list and 0 < len(config['effective_argv']) <= 128
         and all(type(value) is str and 0 < len(value.encode()) <= 4096 and '\x00' not in value
                 and not value.startswith('@private_input:') for value in config['effective_argv']),
         'bridge_effective_argv_required')
    need(type(config['private_input_pins']) is dict and len(config['private_input_pins']) <= 4,
         'bridge_private_input_pin_map_required')
    total = 0
    for name, pin in config['private_input_pins'].items():
        need(type(name) is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name)
             and type(pin) is dict and set(pin) == {'bytes', 'sha256'}
             and type(pin['bytes']) is int and 0 <= pin['bytes'] <= 32768,
             'bridge_private_input_shape_required')
        path = Path(config['environment']['TMPDIR']) / name
        need(str(path) in config['effective_argv'], 'bridge_private_input_not_used')
        # Private inputs may be empty, unlike executable/Source byte pins.
        info = path.lstat()
        need(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1
             and info.st_size == pin['bytes'] and stat.S_IMODE(info.st_mode) == 0o600,
             'bridge_private_input_identity_required')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            need(key(before) == key(info), 'bridge_private_input_changed_at_open')
            raw = os.read(fd, 32769)
            need(len(raw) == pin['bytes'] and sha(raw) == pin['sha256']
                 and key(before) == key(os.fstat(fd)) == key(path.lstat()),
                 'bridge_private_input_pin_mismatch')
        finally:
            os.close(fd)
        total += pin['bytes']
    need(total <= 65536, 'bridge_private_input_total_bound')
    owner_uid = executable_owner(config['executable_pin'], root, uid)
    pin_shape(config['executable_pin'], absolute(config['executable']), 1024**3)
    read_file(config['executable'], owner_uid, 1024**3, config['executable_pin'], executable=True)
    need(time.monotonic() < config['command_deadline']
         and not os.path.lexists(registration_root.parent / 'STOP'), 'bridge_expired_or_STOP_before_exec')


def _bridge_validate_ack(config, identity, uid):
    root = Path(config['registration_root'])
    prefix = root / ('command-' + format(config['command_index'], '06d'))
    need(marker_present(Path(str(prefix) + '.ready'), uid)
         and marker_present(Path(str(prefix) + '.ack.ready'), uid),
         'bridge_parent_registration_and_ACK_required')
    raw, record_pin = read_file(Path(str(prefix) + '.json'), uid, 65536, readonly=True)
    record = object_bytes(raw)
    expected = {'schema': 'studio-audit-command-group-registration/1',
                'nonce': config['nonce'], 'audit_kind': config['audit_kind'],
                'command_index': config['command_index'], 'supervisor_pid': config['supervisor_pid'],
                'phase_worker': identity_ids(config['worker_identity']), 'command': identity_ids(identity),
                'phase_worker_birth': config['worker_birth'], 'command_birth': birth_token(identity),
                'runner_pin': config['runner_pin'], 'owner_admission_pin': config['owner_admission_pin'],
                'task_admission_pin': config['task_admission_pin'],
                'resource_admission_pin': config['resource_admission_pin'],
                'executable_pin': config['executable_pin'],
                'registered_at_monotonic': record.get('registered_at_monotonic'),
                'whole_attempt_started_monotonic': config['phase_start'],
                'whole_attempt_deadline': config['phase_deadline']}
    need(same(record, expected) and finite(record['registered_at_monotonic'])
         and config['phase_start'] <= record['registered_at_monotonic'] <= time.monotonic(),
         'bridge_actual_registration_binding_required')
    ack_raw, _pin = read_file(Path(str(prefix) + '.ack.json'), uid, 65536, readonly=True)
    validate_ack(object_bytes(ack_raw), record, record_pin['sha256'], config['supervisor_pid'])
    need(not os.path.lexists(root.parent / 'STOP') and time.monotonic() < config['command_deadline'],
         'bridge_cleanup_or_deadline_after_ACK')


def bridge_main(config_fd, hello_fd, go_fd):
    need(len({config_fd, hello_fd, go_fd}) == 3 and all(type(value) is int and value >= 3
                                                     for value in (config_fd, hello_fd, go_fd)),
         'three_private_bridge_FDs_required')
    # A pipe-held Source bridge does not create child processes or target inputs.
    for fd in (config_fd, hello_fd, go_fd):
        need(stat.S_ISFIFO(os.fstat(fd).st_mode), 'bridge_pipe_FD_required')
    read_deadline = time.monotonic() + 60
    config = object_bytes(_read_pipe(config_fd, 256 * 1024, read_deadline, lambda: None))
    os.close(config_fd)
    uid = os.geteuid()
    _bridge_guard(config, uid)
    identity = process_identity(os.getpid())
    need(identity['uid'] == uid and identity['pid'] == identity['pgid'] == identity['sid'],
         'bridge_actual_new_session_required')
    hello = {'schema': 'studio-audit-exec-bridge-ready/1', 'nonce': config['nonce'],
             'identity': identity, 'birth': birth_token(identity)}
    _write_pipe(hello_fd, json_bytes(hello, 8192), config['command_deadline'], lambda: None)
    os.close(hello_fd)
    os.set_blocking(go_fd, False)
    while True:
        need(time.monotonic() < config['command_deadline'], 'bridge_GO_deadline')
        try:
            value = os.read(go_fd, 2)
        except BlockingIOError:
            time.sleep(.01)
            continue
        need(value == b'G', 'bridge_no_target_without_exact_GO')
        break
    os.close(go_fd)
    # GO is not sufficient after Parent cleanup or worker/supervisor death.
    _bridge_guard(config, uid)
    _bridge_validate_ack(config, identity, uid)
    need(same(birth_token(process_identity(os.getpid())), hello['birth']),
         'bridge_birth_changed_before_exec')
    os.chdir(config['cwd'])
    os.execve(config['executable'], [config['executable'], *config['effective_argv']], config['environment'])
    raise RunnerRefused('target_exec_returned')


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--exec-bridge', action='store_true')
    parser.add_argument('--config-fd', type=int, required=True)
    parser.add_argument('--hello-fd', type=int, required=True)
    parser.add_argument('--go-fd', type=int, required=True)
    args = parser.parse_args()
    need(args.exec_bridge, 'direct_runner_CLI_refused')
    try:
        bridge_main(args.config_fd, args.hello_fd, args.go_fd)
    except BaseException as error:
        os.write(2, json_bytes({'status': 'BRIDGE_REFUSED_NO_RUNTIME_PASS',
                               'error_type': type(error).__name__}, 4096))
        return 125
    return 125


if __name__ == '__main__':
    raise SystemExit(main())
