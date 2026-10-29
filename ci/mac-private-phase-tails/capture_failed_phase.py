"""One original-clock CI caller for private failed-phase diagnostics.

Source candidate only. This code neither acquires artifacts nor admits native
work. A reviewed workflow must authenticate this caller, helper and source pins.
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
import types
import uuid

CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
REPOSITORY = 'omega-flagship/omegahive-installer'
OWNER = 'dot-mac-ci'
WHOLE_SECONDS = 15.0
WORK_SECONDS = 13.0
MAX_RSS = 128 * 1024**2
PRODUCER_READ_CAP = 3 * 1024**2
HELPER_READ_CAP = 6 * 1024**2
HEX = re.compile(r'[a-f0-9]{64}\Z')
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
ATTEMPT = re.compile(r'attempt-[a-f0-9]{32}\Z')
QUALIFICATION = 'PRIVATE_DIAGNOSTIC_CALLER_ONLY_NOT_RUNTIME_QUALIFICATION'

# Frozen offline literal domains; no exception body or regex-only reason acceptance.
REVIEWED_HELPER_SHA256 = '6b8e7badf5b2be1bc32bcd3ff7650ef12821271f46993187a3b2af8996a7b480'
CALLER_REASON_CODES = frozenset(('ABSOLUTE_PATH', 'CANCELLED', 'CANONICAL_PATH', 'CAPTURE_ID', 'CLI_ARGUMENTS', 'CLOSED_METADATA_FIELDS', 'CURRENT_ATTEMPT', 'CURRENT_FAILED_RESULT', 'CURRENT_LAUNCH_SCHEMA', 'CURRENT_STEP_OUTPUT_CHANGED', 'CURRENT_STEP_OUTPUT_FILE', 'CURRENT_STEP_OUTPUT_NAMESPACE', 'DEADLINE', 'EXISTING_ALARM', 'EXPLICIT_CI_OWNER', 'EXTERNAL_SHA_REQUIRED', 'FIXED_CALLER_SOURCE_PATH', 'HELPER_NAMESPACE_ALREADY_PRESENT', 'ISOLATED_DARWIN_OWNER', 'LOGICAL_JOB_ID', 'METADATA_COMPLETION', 'METADATA_RETAINED_BYTES', 'METADATA_SHORT_WRITE', 'ORIGINAL_DEADLINE', 'OUTPUT_POINTER_BOUND', 'OUTPUT_POINTER_SHORT_WRITE', 'OWNER_SELECTED_PYTHON', 'OWNER_SOURCE_BINDING', 'PRODUCER_AGGREGATE_READ_CAP', 'PRODUCER_READ_CAP', 'PUBLIC_OUTPUT_BOUND', 'PUBLIC_SHORT_WRITE', 'REVIEWED_HELPER_LIMITS', 'REVIEWED_HELPER_SOURCE_REQUIRED', 'REVIEW_BYTE_BOUND', 'RUN_IDENTITY', 'SELF_RSS_LIMIT', 'SEPARATE_NAMESPACES', 'SOURCE_DIRECTORY_AUTHORITY', 'SOURCE_DIRECTORY_CHANGED', 'SOURCE_DIRECTORY_COUNT', 'SOURCE_DIRECTORY_NAMESPACE', 'SOURCE_FILE_AUTHORITY', 'SOURCE_FILE_CHANGED', 'SOURCE_FILE_COUNT', 'SOURCE_SHA', 'SOURCE_SHA_MISMATCH', 'SOURCE_SHORT_READ', 'WHOLE_DEADLINE'))
HELPER_REASON_CODES = frozenset(('CANCELLED', 'CANONICAL_MANIFEST_BYTES', 'CANONICAL_REVIEW_BYTES', 'CI_ENVIRONMENT', 'CLI_ARGUMENTS', 'CONTROL_PIN_MISMATCH', 'CONTROL_READ_TOTAL_BOUND', 'CURRENT_FAILED_STAGE2_RESULT', 'CURRENT_HOST_IDENTITY', 'CURRENT_ORIGIN_MACHINE', 'DEADLINE', 'DIRECTORY_AUTHORITY', 'DIRECTORY_COUNT_BOUND', 'DIRECTORY_NAMESPACE_CHANGED', 'DUPLICATE_JSON_KEY', 'EXISTING_ALARM_REFUSED', 'EXPLICIT_OWNER_REQUIRED', 'FAILED_FINALIZE_NO_DYNAMIC_FIELDS', 'FILE_AUTHORITY_OR_BOUND', 'FILE_NAMESPACE_CHANGED', 'FINALIZE_CONTEXT_NO_DYNAMIC_FIELDS', 'FINALIZE_FACTS_PROVENANCE', 'FINALIZE_INITIAL_FACTS', 'FINALIZE_NATIVE_PARENT_PIN', 'FINALIZE_PREREQUISITE_FIELDS', 'FIXED_OUTPUT_LEAF_BOUND', 'FROZEN_LAUNCH_NO_DYNAMIC_FIELDS', 'GENUINE_REVIEW_ATTRIBUTION', 'GENUINE_REVIEW_MISSING', 'GENUINE_REVIEW_SCHEMA', 'HELD_DIRECTORY_CHANGED', 'HELD_FILE_CHANGED', 'HELD_FILE_COUNT_BOUND', 'IMAGE_CONTEXT_LINK_BOUND', 'IMAGE_CONTEXT_MAP', 'IMAGE_CONTEXT_ROW', 'ISOLATED_DARWIN_OWNER', 'JSON_INVALID', 'JSON_OBJECT', 'LATER_PHASE_DYNAMIC_IMAGE_PROVENANCE', 'LAUNCH_SCHEMA', 'LAUNCH_SOURCE_BINDING', 'LOG_FULL_SHA_MISMATCH', 'LOG_LARGE_PREFIX_METADATA', 'LOG_OBSERVED_SIZE_CHANGED', 'LOG_PARENT_METADATA', 'LOG_PARENT_STABILITY', 'LOG_PREFIX_SHA_MISMATCH', 'LOG_READ_TOTAL_BOUND', 'LOG_SMALL_METADATA', 'NONFINITE_JSON', 'NOT_CAPTURED_UNBOUND', 'OUTPUT_BOUND', 'OUTPUT_CAPTURE_ID', 'OUTPUT_CHANGED', 'OUTPUT_IDENTITY', 'OWNER_CAPTURE_ID', 'OWNER_FIELDS', 'OWNER_HOST', 'OWNER_HOST_IDENTITY', 'OWNER_IDENTITY', 'OWNER_JOB_ENV', 'OWNER_METADATA_CHECKSUM', 'OWNER_METADATA_SCHEMA', 'OWNER_METADATA_SHA', 'OWNER_REPOSITORY', 'OWNER_RUN_ENV', 'PARENT_PROVENANCE_ESTIMATE', 'PATH_SYNTAX', 'PHASE_CLEANUP_UNCONFIRMED', 'PHASE_CONTEXT_CLOCK', 'PHASE_CONTEXT_CURRENT_BINDING', 'PHASE_CONTEXT_FACTS', 'PHASE_CONTEXT_SCHEMA', 'PHASE_EXIT_STATUS_JOIN', 'PHASE_LOG_ENUM', 'PHASE_PARENT_SCHEMA', 'PHASE_PARENT_STATUS', 'PHASE_RESOURCE_ESTIMATE', 'PHASE_RESOURCE_SHAPE', 'PHASE_RESOURCE_TASK_JOIN', 'PHASE_WORKER_COMPLETION_TYPES', 'PIN_PATH', 'PIN_SHAPE', 'PRECEDING_PHASE_NOT_CLEAN', 'PREPARATION_BINDING_FIELDS', 'PREPARATION_PARENT_PATH', 'PRIVATE_CHAIN_ANCHOR', 'PRIVATE_DIRECTORY', 'READ_POLICY_TYPE', 'READ_RANGE', 'RELATIVE_PATH', 'RESULT_DYNAMIC_IMAGE_PROVENANCE', 'REVIEW_OWNER_PIN', 'REVIEW_SUBJECT_BINDING', 'REVIEW_TEN_ROLES', 'RSS_UNAVAILABLE', 'RUNNER_TEMP_OWNER', 'RUNNER_TEMP_SEPARATE_FROM_CI_ROOT', 'SELF_RSS_LIMIT', 'SELF_SHA_SYNTAX', 'SELF_SOURCE_PIN', 'SERIAL_CONTEXT_FACTS_JOIN', 'SERIAL_PHASE_RESULT_SEQUENCE', 'SHORT_READ', 'SHORT_WRITE', 'SOURCE_CHECKSUM', 'SOURCE_MANIFEST_DUPLICATE', 'SOURCE_MANIFEST_PATH', 'SOURCE_MANIFEST_ROW', 'SOURCE_MANIFEST_TEXT', 'SOURCE_TOTAL_BOUND', 'SOURCE_UTF8', 'STDOUT_SHORT_WRITE', 'SUCCESSFUL_AUDIT_FACTS', 'SUCCESSFUL_COPY_FACTS', 'SUCCESSFUL_PHASE_FACTS_MAP', 'TAIL_TOTAL_BOUND', 'TASK_ESTIMATE', 'TASK_ESTIMATE_NUMBER', 'TASK_LIST', 'TASK_PID', 'TASK_ROW', 'WHOLE_DEADLINE'))
PUBLIC_REASON_CODES = CALLER_REASON_CODES | HELPER_REASON_CODES | frozenset(('REQUIRED_INPUT_MISSING', 'FILE_ACCESS_REFUSED', 'FILE_IO_REFUSED', 'UNRECOGNIZED_CALLER_ERROR'))


class Refused(Exception):
    """Caller errors carry fixed internal codes only; never print exception text."""


class SafeParser(argparse.ArgumentParser):
    def error(self, unused_message):
        raise Refused('CLI_ARGUMENTS')


def need(ok, code):
    if not ok:
        raise Refused(code)


def canonical(value):
    need(type(value) is str and 0 < len(value) <= 4096
         and '\x00' not in value and '\n' not in value and '\r' not in value,
         'ABSOLUTE_PATH')
    p = Path(value)
    need(p.is_absolute() and str(p) == value and os.path.normpath(value) == value
         and '..' not in p.parts, 'CANONICAL_PATH')
    return p


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_key(info):
    return tuple(getattr(info, 'st_' + name) for name in
        ('dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtime_ns', 'ctime_ns'))


def dir_key(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_mode


class BootstrapGuard:
    """Protect the original scope before the authenticated helper is imported."""
    def __init__(self, started):
        self.started, self.cancelled, self.peak = started, False, 0

    def check(self, cleanup=False):
        elapsed = time.monotonic() - self.started
        need(0 <= elapsed < (WHOLE_SECONDS if cleanup else WORK_SECONDS), 'DEADLINE')
        if not cleanup:
            need(not self.cancelled, 'CANCELLED')
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            need(type(rss) is int and 0 <= rss <= MAX_RSS, 'SELF_RSS_LIMIT')
            self.peak = max(self.peak, rss)


class SourceFiles:
    """Held, authenticated Source only; 0644 is never a private-input waiver."""
    def __init__(self, uid, guard):
        self.uid, self.guard, self.read_bytes = uid, guard, 0
        self.directories, self.files = {}, []

    def directory(self, name):
        self.guard.check()
        if name not in self.directories:
            need(len(self.directories) < 128, 'SOURCE_DIRECTORY_COUNT')
            parent = None if name == Path('/') else self.directory(name.parent)
            fd = os.open('/' if parent is None else name.name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                **({} if parent is None else {'dir_fd': parent}))
            try:
                info = os.fstat(fd)
                mode = stat.S_IMODE(info.st_mode)
                sticky = name == Path('/private/tmp') and info.st_uid == 0 and mode == 0o1777
                need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, self.uid)
                     and (not mode & 0o022 or sticky), 'SOURCE_DIRECTORY_AUTHORITY')
                self.directories[name] = parent, fd, dir_key(info)
            except BaseException:
                os.close(fd)
                raise
        self.verify_directory(name)
        return self.directories[name][1]

    def verify_directory(self, name):
        parent, fd, key = self.directories[name]
        need(dir_key(os.fstat(fd)) == key, 'SOURCE_DIRECTORY_CHANGED')
        if parent is not None:
            need(dir_key(os.stat(name.name, dir_fd=parent, follow_symlinks=False)) == key,
                 'SOURCE_DIRECTORY_NAMESPACE')

    def read(self, name, digest, maximum):
        self.guard.check()
        need(type(digest) is str and HEX.fullmatch(digest) is not None, 'SOURCE_SHA')
        need(len(self.files) < 8, 'SOURCE_FILE_COUNT')
        parent = self.directory(name.parent)
        fd = os.open(name.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1
                 and stat.S_IMODE(info.st_mode) in (0o400, 0o600, 0o644)
                 and 0 < info.st_size <= maximum, 'SOURCE_FILE_AUTHORITY')
            key, raw = file_key(info), bytearray()
            while len(raw) < info.st_size:
                self.guard.check()
                block = os.read(fd, min(65536, info.st_size - len(raw)))
                need(bool(block), 'SOURCE_SHORT_READ')
                self.read_bytes += len(block)
                need(self.read_bytes <= PRODUCER_READ_CAP, 'PRODUCER_READ_CAP')
                raw.extend(block)
            need(file_key(os.fstat(fd)) == key ==
                 file_key(os.stat(name.name, dir_fd=parent, follow_symlinks=False)),
                 'SOURCE_FILE_CHANGED')
            need(sha(raw) == digest, 'SOURCE_SHA_MISMATCH')
            self.files.append((name, parent, fd, key))
            fd = None
            self.verify()
            return bytes(raw), {'path': str(name), 'bytes': len(raw), 'sha256': digest}
        finally:
            if fd is not None:
                os.close(fd)

    def verify(self):
        self.guard.check(cleanup=True)
        for name in self.directories:
            self.verify_directory(name)
        for name, parent, fd, key in self.files:
            need(file_key(os.fstat(fd)) == key ==
                 file_key(os.stat(name.name, dir_fd=parent, follow_symlinks=False)),
                 'SOURCE_FILE_CHANGED')

    def close(self):
        failed = False
        for unused_name, unused_parent, fd, unused_key in reversed(self.files):
            try:
                os.close(fd)
            except BaseException:
                failed = True
        self.files.clear()
        for unused_parent, fd, unused_key in reversed(tuple(self.directories.values())):
            try:
                os.close(fd)
            except BaseException:
                failed = True
        self.directories.clear()
        return failed


def write_private_metadata(helper, store, directory, value, guard):
    """A separate producer namespace; never write into or mutate Stage2 controls."""
    raw = helper.encoded(value, 16384)
    fd = None
    parent = store.dirs.get(directory, private=True)
    name = 'OWNER_METADATA_R1.json'
    try:
        guard.check()
        store.verify()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        offset = 0
        while offset < len(raw):
            guard.check()
            count = os.write(fd, raw[offset:])
            need(type(count) is int and count > 0, 'METADATA_SHORT_WRITE')
            offset += count
        os.fsync(fd)
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == store.uid
             and info.st_nlink == 1 and info.st_size == len(raw)
             and stat.S_IMODE(info.st_mode) == 0o400, 'METADATA_COMPLETION')
        before = file_key(info)
    finally:
        if fd is not None:
            os.close(fd)
    retained, observed = store.read(directory / name, cap=16384, private_anchor=directory)
    need(retained == raw and file_key(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before,
         'METADATA_RETAINED_BYTES')
    store.verify()
    return observed


def write_upload_pointer(store, runner_temp, capture_dir, guard):
    """Only a known caller-created path, written to the current step output file."""
    output = canonical(os.environ.get('GITHUB_OUTPUT', ''))
    need(output.parent == runner_temp / '_runner_file_commands'
         and re.fullmatch(r'set_output_[A-Za-z0-9_-]{1,128}', output.name) is not None,
         'CURRENT_STEP_OUTPUT_NAMESPACE')
    parent = store.dirs.get(output.parent)
    guard.check()
    fd = os.open(output.name, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK,
                 dir_fd=parent)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == store.uid and before.st_nlink == 1
             and stat.S_IMODE(before.st_mode) in (0o600, 0o644) and before.st_size == 0,
             'CURRENT_STEP_OUTPUT_FILE')
        raw = ('capture_dir=' + str(capture_dir) + '\n').encode('ascii')
        need(len(raw) <= 4096, 'OUTPUT_POINTER_BOUND')
        done = 0
        while done < len(raw):
            guard.check()
            count = os.write(fd, raw[done:])
            need(type(count) is int and count > 0, 'OUTPUT_POINTER_SHORT_WRITE')
            done += count
        os.fsync(fd)
        after = os.fstat(fd)
        need(after.st_size == len(raw) and after.st_dev == before.st_dev
             and after.st_ino == before.st_ino and after.st_mode == before.st_mode
             and after.st_uid == before.st_uid and after.st_nlink == 1
             and file_key(after) == file_key(os.stat(output.name, dir_fd=parent, follow_symlinks=False)),
             'CURRENT_STEP_OUTPUT_CHANGED')
        store.dirs.verify()
    finally:
        os.close(fd)


def producer_budget(sources, store):
    need(sources.read_bytes + store.control_bytes <= PRODUCER_READ_CAP,
         'PRODUCER_AGGREGATE_READ_CAP')


def load_helper(raw, helper_path):
    """Execute only the already hash-verified Source buffer under a non-main name."""
    name = 'owner_admitted_private_phase_helper'
    need(name not in sys.modules, 'HELPER_NAMESPACE_ALREADY_PRESENT')
    module = types.ModuleType(name)
    module.__file__ = str(helper_path)
    sys.modules[name] = module
    try:
        exec(compile(raw, str(helper_path), 'exec'), module.__dict__)
        return module
    except BaseException:
        if sys.modules.get(name) is module:
            del sys.modules[name]
        raise


def safe_reason(error, helper=None):
    if type(error) is Refused:
        args = error.args
        if (type(args) is tuple and len(args) == 1 and type(args[0]) is str
                and args[0] in CALLER_REASON_CODES):
            return args[0]
    if helper is not None and type(error) is getattr(helper, 'Refused', None):
        code = getattr(error, 'code', None)
        if type(code) is str and code in HELPER_REASON_CODES:
            return code
    if isinstance(error, FileNotFoundError):
        return 'REQUIRED_INPUT_MISSING'
    if isinstance(error, PermissionError):
        return 'FILE_ACCESS_REFUSED'
    if isinstance(error, OSError):
        return 'FILE_IO_REFUSED'
    return 'UNRECOGNIZED_CALLER_ERROR'


def invoke(args, started, state):
    """The only helper invocation is direct run(args, same original-clock Guard)."""
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64'
         and os.getuid() == os.geteuid() > 0 and sys.flags.isolated and sys.flags.no_site
         and sys.dont_write_bytecode and not sys.flags.optimize, 'ISOLATED_DARWIN_OWNER')
    need(os.environ.get('PATH') == SYSTEM_PATH and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
         and args.owner == OWNER and args.dedicated_ci_job is True,
         'EXPLICIT_CI_OWNER')
    need(sys.executable == args.python and canonical(args.python).is_absolute(),
         'OWNER_SELECTED_PYTHON')
    for label in ('source_sha256', 'helper_source_sha256', 'stage2_manifest_sha256', 'stage2_review_sha256'):
        need(type(getattr(args, label)) is str and HEX.fullmatch(getattr(args, label)) is not None,
             'EXTERNAL_SHA_REQUIRED')
    need(args.helper_source_sha256 == REVIEWED_HELPER_SHA256, 'REVIEWED_HELPER_SOURCE_REQUIRED')
    need(type(args.stage2_review_bytes) is int and 0 < args.stage2_review_bytes <= 256*1024,
         'REVIEW_BYTE_BOUND')
    workspace = canonical(os.environ.get('GITHUB_WORKSPACE', ''))
    runner_temp = canonical(os.environ.get('RUNNER_TEMP', ''))
    need(CI_ROOT not in workspace.parents and workspace != CI_ROOT
         and workspace not in CI_ROOT.parents and workspace != runner_temp
         and workspace not in runner_temp.parents and runner_temp not in workspace.parents
         and CI_ROOT != runner_temp and CI_ROOT not in runner_temp.parents
         and runner_temp not in CI_ROOT.parents, 'SEPARATE_NAMESPACES')
    caller_path = workspace / 'ci/mac-private-phase-tails/capture_failed_phase.py'
    helper_path = workspace / 'ci/mac-private-phase-tails/retain_failed_phase_tails.py'
    need(Path(__file__).absolute() == caller_path, 'FIXED_CALLER_SOURCE_PATH')
    guard = state['guard']
    source_files = SourceFiles(os.getuid(), guard)
    store, module = None, None
    status, result = 1, {'status': 'REFUSED', 'payload_logged': False, 'qualification': QUALIFICATION}
    try:
        source_files.read(caller_path, args.source_sha256, 65536)
        raw, unused = source_files.read(helper_path, args.helper_source_sha256, 256*1024)
        guard.check()
        source_files.verify()
        module = load_helper(raw, helper_path)
        need(module.WHOLE_SECONDS == WHOLE_SECONDS and module.WORK_SECONDS == WORK_SECONDS
             and module.MAX_RSS == MAX_RSS and module.MAX_CONTROLS == HELPER_READ_CAP,
             'REVIEWED_HELPER_LIMITS')
        # The original clock and cancellation survive authenticated Source import.
        shared = module.Guard(started)
        shared.peak = guard.peak
        state['guard'] = shared
        shared.cancelled = state['cancelled']
        guard = shared
        source_files.guard = guard
        guard.check()
        source_files.verify()
        # Producer Store: never passed into helper.run; it has its own 3MiB role cap.
        store = module.Store(os.getuid(), guard)
        launch_path = CI_ROOT / 'stage2-parent/STAGE2_ENTRY_LAUNCH_R1.json'
        launch, launch_pin = store.object(launch_path)
        producer_budget(source_files, store)
        need(launch.get('schema') == 'studio-CI-stage2-owner-launch/1', 'CURRENT_LAUNCH_SCHEMA')
        projection = module.owner(launch.get('owner'), args.owner, os.getuid())
        attempt = projection['attempt_id']
        need(type(attempt) is str and ATTEMPT.fullmatch(attempt) is not None, 'CURRENT_ATTEMPT')
        result_path = CI_ROOT / 'stage2-parent' / attempt / 'STAGE2_RESULT.json'
        stage2_result, result_pin = store.object(result_path)
        producer_budget(source_files, store)
        need(stage2_result.get('schema') == 'studio-CI-stage2-entry-result/1'
             and stage2_result.get('status') == 'FAILED_RETAINED_NO_AUTOMATIC_RETRY'
             and stage2_result.get('qualification') == 'NONE', 'CURRENT_FAILED_RESULT')
        manifest_path = workspace / 'ci/mac-stage2/MANIFEST.sha256'
        manifest_raw, manifest_pin = source_files.read(manifest_path, args.stage2_manifest_sha256, 128*1024)
        review_raw, review_pin = source_files.read(manifest_path.with_name('STATIC_STAGE2_SOURCE_REVIEW.json'),
            args.stage2_review_sha256, 256*1024)
        producer_budget(source_files, store)
        need(len(review_raw) == args.stage2_review_bytes and launch.get('stage2_manifest') == manifest_pin
             and launch.get('source_review') == {**review_pin, 'path': 'STATIC_STAGE2_SOURCE_REVIEW.json'},
             'OWNER_SOURCE_BINDING')
        capture_id = uuid.uuid4().hex
        need(re.fullmatch('[a-f0-9]{32}', capture_id) is not None, 'CAPTURE_ID')
        metadata = {'schema': 'studio-owner-attested-private-phase-tail-inputs/2',
            'source_owner': 'Studio CI failed-phase caller', 'origin_machine': 'CI_OWNER_ATTESTED',
            'repository': REPOSITORY, 'run_id': os.environ.get('GITHUB_RUN_ID'),
            'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'job_id': os.environ.get('GITHUB_JOB'),
            'execution_owner': args.owner, 'stage2_manifest': manifest_pin,
            'stage2_review': {k: review_pin[k] for k in ('bytes', 'sha256')},
            'launch': {k: launch_pin[k] for k in ('bytes', 'sha256')},
            'stage2_result': {k: result_pin[k] for k in ('bytes', 'sha256')}, 'capture_id': capture_id}
        need(set(metadata) == module.METADATA_KEYS, 'CLOSED_METADATA_FIELDS')
        for key in ('run_id', 'run_attempt'):
            need(type(metadata[key]) is str and re.fullmatch('[1-9][0-9]{0,19}', metadata[key]) is not None,
                 'RUN_IDENTITY')
        need(type(metadata['job_id']) is str and TAG.fullmatch(metadata['job_id']) is not None,
             'LOGICAL_JOB_ID')
        store.dirs.get(runner_temp)
        producer_base = runner_temp / 'omegahive-private-phase-owner-inputs-r1'
        try:
            store.dirs.get(producer_base, private=True)
        except FileNotFoundError:
            store.dirs.create_private(producer_base)
        producer_dir = producer_base / capture_id
        store.dirs.create_private(producer_dir)
        metadata_pin = write_private_metadata(module, store, producer_dir, metadata, guard)
        producer_budget(source_files, store)
        capture_dir = runner_temp / 'omegahive-private-phase-failure-r1' / capture_id
        write_upload_pointer(store, runner_temp, capture_dir, guard)
        source_files.verify()
        store.verify()
        producer_budget(source_files, store)
        guard.check()
        child_args = argparse.Namespace(source_sha256=args.helper_source_sha256,
            owner_metadata=metadata_pin['path'], owner_metadata_sha256=metadata_pin['sha256'],
            owner=args.owner, dedicated_ci_job=True, run=True)
        # No subprocess, fresh timer, retry, clock renewal, or helper.main call.
        # run constructs a SECOND local Store, independently capped to6MiB.
        # These counters never alias: producer<=3MiB + helper<=6MiB implies<=9MiB.
        # The post-call producer check below still refers only to our first Store.
        result, status = module.run(child_args, guard)
        source_files.verify()
        store.verify()
        producer_budget(source_files, store)
        if status == 0:
            guard.check()
    except BaseException as error:
        result = {'status': 'CALLER_FAILED_RETAINED_OR_UNKNOWN', 'payload_logged': False,
                  'qualification': QUALIFICATION, 'reason_code': safe_reason(error, module)}
        status = 1
    finally:
        failed = store.close() if store is not None else False
        failed = source_files.close() or failed
        if module is not None and sys.modules.get(module.__name__) is module:
            del sys.modules[module.__name__]
        if failed:
            result = {'status': 'CALLER_CLOSE_UNCONFIRMED', 'payload_logged': False,
                      'qualification': QUALIFICATION}
            status = 1
    if status == 0:
        try:
            state['guard'].check()
        except BaseException:
            result = {'status': 'CALLER_LATE_GUARD_FAILED', 'payload_logged': False,
                      'qualification': QUALIFICATION}
            status = 1
    # Only closed finite labels and bounded numeric/opaque-hash fields leave this caller.
    allowed = {'REFUSED', 'CAPTURED_BOTH', 'PARTIAL_OR_NOT_CAPTURED', 'FAILED_RETAINED',
        'FAILED_RETAINED_RECEIPT_UNCONFIRMED', 'FAILED_RETAINED_CLOSE_UNCONFIRMED',
        'FAILED_RETAINED_FINAL_GUARD', 'CALLER_FAILED_RETAINED_OR_UNKNOWN',
        'CALLER_CLOSE_UNCONFIRMED', 'CALLER_LATE_GUARD_FAILED'}
    summary = {'status': result.get('status') if result.get('status') in allowed else 'REFUSED',
        'payload_logged': False, 'qualification': QUALIFICATION,
        'producer_read_bytes': source_files.read_bytes + (store.control_bytes if store is not None else 0),
        'combined_control_source_read_cap_bytes': PRODUCER_READ_CAP + HELPER_READ_CAP,
        'private_log_range_read_cap_bytes': 2 * (65536 + 16384)}
    for key, maximum in (('captured_logs', 2), ('captured_bytes', 32768)):
        value = result.get(key)
        if type(value) is int and 0 <= value <= maximum:
            summary[key] = value
    value = result.get('receipt_sha256')
    if type(value) is str and HEX.fullmatch(value) is not None:
        summary['receipt_sha256'] = value
    value = result.get('reason_code')
    if type(value) is str and value in PUBLIC_REASON_CODES:
        summary['reason_code'] = value
    return summary, status


def main(argv=None):
    started = time.monotonic()
    parser = SafeParser(allow_abbrev=False)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--source-sha256')
    parser.add_argument('--helper-source-sha256')
    parser.add_argument('--stage2-manifest-sha256')
    parser.add_argument('--stage2-review-sha256')
    parser.add_argument('--stage2-review-bytes', type=int)
    parser.add_argument('--python')
    parser.add_argument('--owner')
    parser.add_argument('--dedicated-ci-job', action='store_true')
    try:
        args = parser.parse_args(argv)
    except Refused:
        print(json.dumps({'status': 'REFUSED', 'reason_code': 'CLI_ARGUMENTS',
                          'inputs_opened': False, 'payload_logged': False}))
        return 2
    if not args.run:
        print(json.dumps({'status': 'SOURCE_INTERFACE_ONLY', 'inputs_opened': False,
                          'worker_started': False, 'network_action': False}))
        return 0
    state = {'guard': BootstrapGuard(started), 'cancelled': False}
    previous, timer_owned = {}, False
    status = 1
    result = {'status': 'REFUSED', 'payload_logged': False, 'qualification': QUALIFICATION}
    def stop(unused_signal, unused_frame):
        state['cancelled'] = True
        state['guard'].cancelled = True
    def alarm(unused_signal, unused_frame):
        raise Refused('WHOLE_DEADLINE')
    try:
        need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_ALARM')
        for kind in (signal.SIGINT, signal.SIGTERM):
            previous[kind] = signal.signal(kind, stop)
        previous[signal.SIGALRM] = signal.signal(signal.SIGALRM, alarm)
        remaining = WHOLE_SECONDS - (time.monotonic() - started)
        need(remaining > 0, 'ORIGINAL_DEADLINE')
        signal.setitimer(signal.ITIMER_REAL, remaining)
        timer_owned = True
        result, status = invoke(args, started, state)
    except BaseException as error:
        result = {'status': 'REFUSED', 'payload_logged': False, 'qualification': QUALIFICATION,
                  'reason_code': safe_reason(error)}
        status = 1
    try:
        raw = (json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')
        need(len(raw) <= 2048, 'PUBLIC_OUTPUT_BOUND')
        offset = 0
        while offset < len(raw):
            state['guard'].check(cleanup=True)
            count = os.write(1, raw[offset:])
            need(type(count) is int and count > 0, 'PUBLIC_SHORT_WRITE')
            offset += count
    except BaseException:
        status = 1
    finally:
        if timer_owned:
            signal.setitimer(signal.ITIMER_REAL, 0)
        for kind, handler in previous.items():
            signal.signal(kind, handler)
    if status == 0:
        try:
            state['guard'].check()
        except BaseException:
            status = 1
    return status


if __name__ == '__main__':
    raise SystemExit(main())
