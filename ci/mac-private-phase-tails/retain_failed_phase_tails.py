#!/usr/bin/env python3
"""Private, bounded Stage2 failed-phase byte retention. No acquisition or execution."""
import argparse
from enum import Enum
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import stat
import sys
import time

ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = ROOT / 'runtime-job'
PARENT = ROOT / 'stage2-parent'
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
PHASES = ('finalize', 'native_audit', 'copy', 'relocation', 'seal')
PHASE_SECONDS = dict(zip(PHASES, (935, 1800, 935, 1800, 935)))
PHASE_ESTIMATE = {'ram_gb': 3.125, 'cpu_cores': 2.25, 'disk_gb': 4, 'kind': 'task'}
LOGS = ('STDOUT.log', 'STDERR.log')
LEAVES = dict(zip(LOGS, ('STDOUT.tail.bin', 'STDERR.tail.bin')))
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
    'resource_policy': 'project_graph/resource-policy.json'}
IMMUTABLE_OWNER = frozenset(('execution_owner', 'owner_uid', 'origin_machine',
    'host', 'attempt_id', 'relocation_attempt', 'preparation_bindings', 'dedicated_ci_job'))
METADATA_KEYS = frozenset(('schema', 'source_owner', 'origin_machine', 'repository',
    'run_id', 'run_attempt', 'job_id', 'execution_owner', 'stage2_manifest',
    'stage2_review', 'launch', 'stage2_result', 'capture_id'))
METADATA_SCHEMA = 'studio-owner-attested-private-phase-tail-inputs/2'
RECEIPT_SCHEMA = 'studio-private-failed-phase-tail-custody/1'
QUALIFICATION = 'PRIVATE_OPAQUE_BYTES_ONLY_NOT_RUNTIME_QUALIFICATION'
ARTIFACT_PROFILE = 'mac-private-phase-failure-tails'
MAX_CONTROL = 1024 * 1024
MAX_CONTROLS = 6 * 1024 * 1024
MAX_LOG = 32 * 1024 * 1024
PREFIX = 65536
TAIL = 16384
MAX_LOG_READS = 2 * (PREFIX + TAIL)
MAX_RECEIPT = 8192
MAX_RSS = 128 * 1024 * 1024
WHOLE_SECONDS = 15.0
WORK_SECONDS = 13.0  # The original 15s includes a 2s owned close/receipt reserve.
HEX = re.compile(r'[0-9a-f]{64}\Z')
ATTEMPT = re.compile(r'attempt-[0-9a-f]{32}\Z')
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')


class ReadPolicy(Enum):
    PRIVATE = 'PRIVATE'
    SOURCE_ONLY = 'SOURCE_ONLY'


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class SafeParser(argparse.ArgumentParser):
    def error(self, unused_message):
        raise Refused('CLI_ARGUMENTS')


def need(ok, code):
    if not ok:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def integer(value, minimum=0, maximum=2**63-1):
    return type(value) is int and minimum <= value <= maximum


def number(value, minimum=0, maximum=1_000_000):
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum


def text(value, maximum=128):
    return type(value) is str and 0 < len(value) <= maximum and all(32 <= ord(c) < 127 for c in value)


def path(value):
    need(type(value) is str and 0 < len(value) <= 4096, 'PATH_SYNTAX')
    p = Path(value)
    need(p.is_absolute() and str(p) == value and str(p) == os.path.normpath(value)
         and len(p.parts) <= 32 and all(c not in ('.', '..') for c in p.parts), 'PATH_SYNTAX')
    return p


def relative(value):
    need(type(value) is str and 0 < len(value) <= 1024
         and re.fullmatch(r'[A-Za-z0-9_./-]+', value) is not None
         and not value.startswith('/') and all(c not in ('', '.', '..') for c in value.split('/')),
         'RELATIVE_PATH')
    return value


def pin(value, expected_path=None, *, with_path=True, allow_empty=False, cap=MAX_CONTROL):
    need(type(value) is dict and set(value) == ({'path', 'bytes', 'sha256'} if with_path else {'bytes', 'sha256'})
         and integer(value['bytes'], 0 if allow_empty else 1, cap)
         and type(value['sha256']) is str and HEX.fullmatch(value['sha256']) is not None, 'PIN_SHAPE')
    if with_path:
        need(type(value['path']) is str and (expected_path is None or value['path'] == expected_path), 'PIN_PATH')
    return value


def parse(raw):
    def pairs(rows):
        result = {}
        for k, v in rows:
            need(k not in result, 'DUPLICATE_JSON_KEY')
            result[k] = v
        return result
    def floating(value):
        result = float(value)
        need(math.isfinite(result), 'NONFINITE_JSON')
        return result
    def invalid(unused):
        raise Refused('NONFINITE_JSON')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_constant=invalid, parse_float=floating)
        need(type(value) is dict, 'JSON_OBJECT')
        return value
    except Refused:
        raise
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise Refused('JSON_INVALID') from None


def encoded(value, cap):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'),
                      allow_nan=False, ensure_ascii=True) + '\n').encode('ascii')
    need(len(raw) <= cap, 'OUTPUT_BOUND')
    return raw


def same(left, right):
    # JSON equality must not treat True as 1, or silently normalize typed values.
    return encoded(left, MAX_CONTROL) == encoded(right, MAX_CONTROL)


class Guard:
    def __init__(self, started):
        self.started = started
        self.cancelled = False
        self.peak = 0

    def check(self, cleanup=False):
        elapsed = time.monotonic() - self.started
        need(0 <= elapsed < (WHOLE_SECONDS if cleanup else WORK_SECONDS), 'DEADLINE')
        if not cleanup:
            need(not self.cancelled, 'CANCELLED')
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            need(integer(rss), 'RSS_UNAVAILABLE')
            self.peak = max(self.peak, rss)
            need(rss <= MAX_RSS, 'SELF_RSS_LIMIT')


def dir_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode)


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Directories:
    """One held FD per ancestor; every name is rechecked without following links."""
    def __init__(self, uid, guard):
        self.uid, self.guard = uid, guard
        self.rows = {}

    def get(self, name, *, private=False):
        self.guard.check()
        name = path(str(name))
        if name not in self.rows:
            need(len(self.rows) < 256, 'DIRECTORY_COUNT_BOUND')
            parent = None if name == Path('/') else self.get(name.parent)
            fd = os.open('/' if parent is None else name.name,
                         os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         **({} if parent is None else {'dir_fd': parent}))
            try:
                info = os.fstat(fd)
                mode = stat.S_IMODE(info.st_mode)
                sticky_tmp = name == Path('/private/tmp') and info.st_uid == 0 and mode == 0o1777
                need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, self.uid)
                     and (not mode & 0o022 or sticky_tmp), 'DIRECTORY_AUTHORITY')
                self.rows[name] = (parent, fd, dir_key(info))
            except BaseException:
                os.close(fd)
                raise
        parent, fd, key = self.rows[name]
        need(not private or (key[2] == self.uid and stat.S_IMODE(key[3]) == 0o700), 'PRIVATE_DIRECTORY')
        self.verify_one(name)
        return fd

    def verify_one(self, name):
        parent, fd, key = self.rows[name]
        need(dir_key(os.fstat(fd)) == key, 'HELD_DIRECTORY_CHANGED')
        if parent is not None:
            need(dir_key(os.stat(name.name, dir_fd=parent, follow_symlinks=False)) == key,
                 'DIRECTORY_NAMESPACE_CHANGED')

    def verify(self):
        for name in self.rows:
            self.guard.check(cleanup=True)
            self.verify_one(name)

    def private_chain(self, name, anchor):
        need(name == anchor or anchor in name.parents, 'PRIVATE_CHAIN_ANCHOR')
        self.get(anchor, private=True)
        for child in reversed(name.parents):
            if anchor in child.parents:
                self.get(child, private=True)
        return self.get(name, private=True)

    def create_private(self, name):
        parent = self.get(name.parent)
        self.guard.check()
        self.verify()
        os.mkdir(name.name, 0o700, dir_fd=parent)  # EXCLUSIVE, never replace.
        os.fsync(parent)
        return self.get(name, private=True)

    def close(self):
        errors = False
        for unused_parent, fd, unused_key in reversed(tuple(self.rows.values())):
            try:
                os.close(fd)
            except BaseException:
                errors = True
        self.rows.clear()
        return errors


class HeldFile:
    def __init__(self, store, name, cap, *, empty=False, private_anchor=None, policy=ReadPolicy.PRIVATE):
        need(type(policy) is ReadPolicy, 'READ_POLICY_TYPE')
        self.store, self.path, self.fd = store, path(str(name)), None
        self.parent = (store.dirs.get(self.path.parent) if private_anchor is None else
                       store.dirs.private_chain(self.path.parent, private_anchor))
        try:
            self.fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                              dir_fd=self.parent)
            info = os.fstat(self.fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == store.uid and info.st_nlink == 1
                 and stat.S_IMODE(info.st_mode) in ((0o400, 0o600, 0o644)
                     if policy is ReadPolicy.SOURCE_ONLY else (0o400, 0o600))
                 and (0 if empty else 1) <= info.st_size <= cap, 'FILE_AUTHORITY_OR_BOUND')
            self.key, self.size = file_key(info), info.st_size
            self.verify()
        except BaseException:
            self.close()
            raise

    def verify(self):
        self.store.dirs.verify()
        need(file_key(os.fstat(self.fd)) == self.key, 'HELD_FILE_CHANGED')
        need(file_key(os.stat(self.path.name, dir_fd=self.parent, follow_symlinks=False)) == self.key,
             'FILE_NAMESPACE_CHANGED')

    def read(self, offset, count, *, log=False):
        need(integer(offset) and integer(count, 0, PREFIX) and offset + count <= self.size,
             'READ_RANGE')
        self.store.reserve(count, log=log)
        self.verify()
        data = bytearray()
        while len(data) < count:
            self.store.guard.check()
            block = os.pread(self.fd, count - len(data), offset + len(data))
            need(bool(block), 'SHORT_READ')
            data.extend(block)
        self.verify()
        return bytes(data)

    def close(self):
        error = False
        if self.fd is not None:
            fd, self.fd = self.fd, None
            try:
                os.close(fd)
            except BaseException:
                error = True
        return error


class Store:
    def __init__(self, uid, guard):
        self.uid, self.guard = uid, guard
        self.dirs = Directories(uid, guard)
        self.held = []
        self.control_bytes = self.log_bytes = 0

    def reserve(self, count, *, log=False):
        if log:
            self.log_bytes += count
            need(self.log_bytes <= MAX_LOG_READS, 'LOG_READ_TOTAL_BOUND')
        else:
            self.control_bytes += count
            need(self.control_bytes <= MAX_CONTROLS, 'CONTROL_READ_TOTAL_BOUND')

    def open(self, name, cap=MAX_CONTROL, *, empty=False, private_anchor=None, policy=ReadPolicy.PRIVATE):
        self.guard.check()
        need(len(self.held) < 160, 'HELD_FILE_COUNT_BOUND')
        held = HeldFile(self, name, cap, empty=empty, private_anchor=private_anchor, policy=policy)
        self.held.append(held)
        return held

    def read(self, name, expected=None, *, cap=MAX_CONTROL, private_anchor=None, policy=ReadPolicy.PRIVATE):
        held = self.open(name, cap, private_anchor=private_anchor, policy=policy)
        raw = b''.join(held.read(offset, min(PREFIX, held.size-offset))
                       for offset in range(0, held.size, PREFIX))
        observed = {'path': str(held.path), 'bytes': held.size, 'sha256': sha(raw)}
        if expected is not None:
            pin(expected, cap=cap)
            need(expected == observed, 'CONTROL_PIN_MISMATCH')
        return raw, observed

    def object(self, name, expected=None):
        raw, observed = self.read(name, expected, private_anchor=ROOT)
        return parse(raw), observed

    def verify(self):
        self.guard.check(cleanup=True)
        self.dirs.verify()
        for held in self.held:
            held.verify()

    def close(self):
        errors = False
        for held in reversed(self.held):
            errors = held.close() or errors
        self.held.clear()
        return self.dirs.close() or errors


def tasks(rows):
    need(type(rows) is list and len(rows) <= 256, 'TASK_LIST')
    seen = set()
    for row in rows:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'}
             and text(row['task_id']) and row['task_id'] not in seen
             and type(row['state']) is str and row['state'] in ('running', 'reserved'), 'TASK_ROW')
        seen.add(row['task_id'])
        need((row['state'] == 'running' and integer(row['pid'], 1))
             or (row['state'] == 'reserved' and row['pid'] is None), 'TASK_PID')
        estimate = row['estimate']
        need(type(estimate) is dict and set(estimate) == {'ram_gb', 'cpu_cores', 'disk_gb'}, 'TASK_ESTIMATE')
        for key, amount in estimate.items():
            need(number(amount) and (key == 'disk_gb' or amount > 0), 'TASK_ESTIMATE_NUMBER')


def image_contexts(value):
    need(type(value) is dict and len(value) <= 8192, 'IMAGE_CONTEXT_MAP')
    links = 0
    for name, rows in value.items():
        relative(name)
        need(type(rows) is list and 1 <= len(rows) <= 2
             and all(type(row) is str for row in rows) and len(set(rows)) == len(rows), 'IMAGE_CONTEXT_ROW')
        for row in rows:
            relative(row)
        links += len(rows)
    need(links <= 16384, 'IMAGE_CONTEXT_LINK_BOUND')


def owner(value, expected_owner, uid):
    need(type(value) is dict and set(value) in (IMMUTABLE_OWNER | {'current_tasks'},
         IMMUTABLE_OWNER | {'current_tasks', 'dynamic_image_contexts'}), 'OWNER_FIELDS')
    need(value['execution_owner'] == expected_owner and type(value['execution_owner']) is str
         and integer(value['owner_uid'], 1) and value['owner_uid'] == uid
         and text(value['origin_machine']) and value['dedicated_ci_job'] is True
         and type(value['attempt_id']) is str and ATTEMPT.fullmatch(value['attempt_id']) is not None
         and type(value['relocation_attempt']) is str
         and re.fullmatch('[0-9a-f]{32}', value['relocation_attempt']) is not None, 'OWNER_IDENTITY')
    host = value['host']
    need(type(host) is dict and set(host) == {'root', 'job'}, 'OWNER_HOST')
    for ids in host.values():
        need(type(ids) is list and len(ids) == 4 and integer(ids[0]) and integer(ids[1], 1)
             and integer(ids[2], 1) and ids[2] == uid and type(ids[3]) is int and ids[3] == 0o700,
             'OWNER_HOST_IDENTITY')
    bindings = value['preparation_bindings']
    need(type(bindings) is dict and set(bindings) == {'preparation_parent', 'stage1_manifest', 'stage1_source_review'},
         'PREPARATION_BINDING_FIELDS')
    pp = pin(bindings['preparation_parent'])
    need(re.fullmatch(r'preparation-parent/stage/attempt-[0-9a-f]{32}/PARENT_RESULT\.json', pp['path']) is not None,
         'PREPARATION_PARENT_PATH')
    pin(bindings['stage1_manifest'], with_path=False)
    pin(bindings['stage1_source_review'], with_path=False)
    tasks(value['current_tasks'])
    if 'dynamic_image_contexts' in value:
        image_contexts(value['dynamic_image_contexts'])
    return {k: value[k] for k in IMMUTABLE_OWNER}


def source_catalog(store, metadata):
    expected = pin(metadata['stage2_manifest'], cap=128*1024)
    manifest = path(expected['path'])
    need(manifest.name == 'MANIFEST.sha256' and ROOT not in manifest.parents, 'SOURCE_MANIFEST_PATH')
    raw, observed = store.read(manifest, expected, cap=128*1024, policy=ReadPolicy.SOURCE_ONLY)
    need(raw.endswith(b'\n') and b'\r' not in raw and b'\x00' not in raw, 'SOURCE_MANIFEST_TEXT')
    entries, total = {}, 0
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeError:
        raise Refused('SOURCE_MANIFEST_TEXT') from None
    for line in lines:
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_./-]+)', line)
        need(match is not None and len(entries) < 128, 'SOURCE_MANIFEST_ROW')
        digest, name = match.groups()
        relative(name)
        need(name not in entries and name != 'MANIFEST.sha256', 'SOURCE_MANIFEST_DUPLICATE')
        body, p = store.read(manifest.parent / name, cap=256*1024, policy=ReadPolicy.SOURCE_ONLY)
        need(p['sha256'] == digest and b'\x00' not in body, 'SOURCE_CHECKSUM')
        try:
            body.decode('utf-8')
        except UnicodeError:
            raise Refused('SOURCE_UTF8') from None
        total += len(body)
        need(total <= 3*1024**2, 'SOURCE_TOTAL_BOUND')
        entries[name] = (body, {'path': name, 'bytes': len(body), 'sha256': digest})
    name = 'STATIC_STAGE2_SOURCE_REVIEW.json'
    need(name in entries, 'GENUINE_REVIEW_MISSING')
    review_raw, review_pin = entries[name]
    pin(metadata['stage2_review'], with_path=False, cap=256*1024)
    need({k: review_pin[k] for k in ('bytes', 'sha256')} == metadata['stage2_review'], 'REVIEW_OWNER_PIN')
    review = parse(review_raw)
    need(set(review) == {'schema', 'verdict', 'blocking_findings', 'reviewer', 'source_owner',
         'origin_machine', 'subjects', 'scope'} and review['schema'] == 'studio-Mac-CI-stage2-static-source-review/1'
         and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == [], 'GENUINE_REVIEW_SCHEMA')
    need(all(text(review[k]) for k in ('reviewer', 'source_owner', 'origin_machine'))
         and text(review['scope'], 4096), 'GENUINE_REVIEW_ATTRIBUTION')
    subjects = review['subjects']
    need(type(subjects) is dict and set(subjects) == set(ROLES), 'REVIEW_TEN_ROLES')
    for role, name in ROLES.items():
        p = pin(subjects[role], name, cap=256*1024)
        need(name in entries and p == entries[name][1], 'REVIEW_SUBJECT_BINDING')
        # Current canonical code must be the same reviewed bytes, not just an old source catalog.
        store.read(ROOT / name, dict(p, path=str(ROOT / name)), cap=256*1024,
                   private_anchor=ROOT, policy=ReadPolicy.SOURCE_ONLY)
    canonical_review, unused = store.read(ROOT / 'stage2-source/STATIC_STAGE2_SOURCE_REVIEW.json',
        dict(review_pin, path=str(ROOT / 'stage2-source/STATIC_STAGE2_SOURCE_REVIEW.json')),
        cap=256*1024, private_anchor=ROOT, policy=ReadPolicy.SOURCE_ONLY)
    need(canonical_review == review_raw, 'CANONICAL_REVIEW_BYTES')
    canonical_manifest, unused = store.read(ROOT / 'stage2-source/STAGE2_MANIFEST.sha256',
        dict(observed, path=str(ROOT / 'stage2-source/STAGE2_MANIFEST.sha256')),
        cap=128*1024, private_anchor=ROOT, policy=ReadPolicy.SOURCE_ONLY)
    need(canonical_manifest == raw, 'CANONICAL_MANIFEST_BYTES')
    return observed, review_pin, subjects


def metadata_inputs(args, store):
    need(type(args.owner) is str and TAG.fullmatch(args.owner) is not None
         and args.dedicated_ci_job is True, 'EXPLICIT_OWNER_REQUIRED')
    need(type(args.owner_metadata_sha256) is str and HEX.fullmatch(args.owner_metadata_sha256) is not None,
         'OWNER_METADATA_SHA')
    raw, m_pin = store.read(path(args.owner_metadata), cap=16384)
    need(m_pin['sha256'] == args.owner_metadata_sha256, 'OWNER_METADATA_CHECKSUM')
    value = parse(raw)
    need(set(value) == METADATA_KEYS and value['schema'] == METADATA_SCHEMA
         and text(value['source_owner']) and text(value['origin_machine'])
         and value['execution_owner'] == args.owner, 'OWNER_METADATA_SCHEMA')
    need(type(value['capture_id']) is str and re.fullmatch(r'[0-9a-f]{32}', value['capture_id']) is not None,
         'OWNER_CAPTURE_ID')
    need(type(value['repository']) is str
         and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}', value['repository']) is not None,
         'OWNER_REPOSITORY')
    for key in ('run_id', 'run_attempt'):
        need(type(value[key]) is str and re.fullmatch(r'[1-9][0-9]{0,19}', value[key]) is not None
             and os.environ.get('GITHUB_' + key.upper()) == value[key], 'OWNER_RUN_ENV')
    need(type(value['job_id']) is str and TAG.fullmatch(value['job_id']) is not None
         and os.environ.get('GITHUB_JOB') == value['job_id']
         and os.environ.get('GITHUB_REPOSITORY') == value['repository'], 'OWNER_JOB_ENV')
    for key in ('launch', 'stage2_result'):
        pin(value[key], with_path=False)
    return value, {'bytes': m_pin['bytes'], 'sha256': m_pin['sha256']}


def context(store, phase, attempt_dir, expected, projection, sources, args):
    name = attempt_dir / phase / 'PHASE_CONTEXT.json'
    pin(expected, str(name))
    value, observed = store.object(name, expected)
    need(set(value) == {'schema', 'phase', 'parent_pid', 'phase_started_monotonic',
         'phase_deadline', 'sources_manifest', 'owner', 'facts', 'resource'}
         and value['schema'] == 'studio-CI-stage2-owned-phase-context/1' and value['phase'] == phase
         and integer(value['parent_pid'], 1), 'PHASE_CONTEXT_SCHEMA')
    start, end = value['phase_started_monotonic'], value['phase_deadline']
    need(number(start, 0, 10**12) and number(end, 0, 10**12)
         and 0 < end-start <= PHASE_SECONDS[phase], 'PHASE_CONTEXT_CLOCK')
    pin(value['sources_manifest'])
    need(value['sources_manifest'] == sources and same(owner(value['owner'], args.owner, store.uid), projection),
         'PHASE_CONTEXT_CURRENT_BINDING')
    need(type(value['facts']) is dict and type(value['resource']) is dict, 'PHASE_CONTEXT_FACTS')
    r = value['resource']
    need(set(r) == {'at', 'pressure', 'advice', 'estimate', 'current_tasks'}
         and type(r['at']) is str and type(r['pressure']) is str and type(r['advice']) is dict,
         'PHASE_RESOURCE_SHAPE')
    tasks(r['current_tasks'])
    need(same(r['current_tasks'], value['owner']['current_tasks']), 'PHASE_RESOURCE_TASK_JOIN')
    need(same(r['estimate'], PHASE_ESTIMATE), 'PHASE_RESOURCE_ESTIMATE')
    return value, observed


def parent_control(store, name, phase):
    value, observed = store.object(name)
    need(value.get('schema') == 'studio-CI-stage2-owned-phase-parent/1' and value.get('phase') == phase,
         'PHASE_PARENT_SCHEMA')
    need(integer(value.get('worker_pid'), 1) and integer(value.get('worker_pgid'), 1)
         and value['worker_pgid'] == value['worker_pid'] and integer(value.get('worker_exit'), -255, 255)
         and type(value.get('worker_reaped')) is bool and type(value.get('group_absent')) is bool
         and type(value.get('signals')) is list and len(value['signals']) <= 64,
         'PHASE_WORKER_COMPLETION_TYPES')
    need(value['worker_reaped'] is True and value['group_absent'] is True
         and value.get('allocation_released') is True, 'PHASE_CLEANUP_UNCONFIRMED')
    need(type(value.get('status')) is str and value['status'] in
         ('worker_exit0', 'worker_failed_retained', 'failed_retained_no_retry',
          'failed_log_observation_retained', 'cleanup_unconfirmed_retained_allocation'), 'PHASE_PARENT_STATUS')
    need((value['worker_exit'] == 0 and value['status'] == 'worker_exit0')
         or (value['worker_exit'] != 0 and value['status'] != 'worker_exit0'), 'PHASE_EXIT_STATUS_JOIN')
    pin(value.get('context'), str(name.parent / 'PHASE_CONTEXT.json'))
    need(type(value.get('logs')) is dict and set(value['logs']) == set(LOGS), 'PHASE_LOG_ENUM')
    return value, observed


def bind_failure(store, args, metadata):
    sources, review, subjects = source_catalog(store, metadata)
    launch_path = PARENT / 'STAGE2_ENTRY_LAUNCH_R1.json'
    launch, launch_pin = store.object(launch_path, dict(metadata['launch'], path=str(launch_path)))
    need(set(launch) == {'schema', 'owner', 'stage1_manifest', 'stage2_manifest', 'source_review',
         'initial_resource', 'whole_wall_seconds', 'estimate', 'scope'}
         and launch['schema'] == 'studio-CI-stage2-owner-launch/1', 'LAUNCH_SCHEMA')
    projection = owner(launch['owner'], args.owner, store.uid)
    need('dynamic_image_contexts' not in launch['owner'], 'FROZEN_LAUNCH_NO_DYNAMIC_FIELDS')
    need(projection['origin_machine'] == os.uname().nodename, 'CURRENT_ORIGIN_MACHINE')
    for key, name in (('root', ROOT), ('job', JOB)):
        fd = store.dirs.get(name, private=True)
        info = os.fstat(fd)
        need(projection['host'][key] == [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)],
             'CURRENT_HOST_IDENTITY')
    pin(launch['stage2_manifest'])
    pin(launch['source_review'], 'STATIC_STAGE2_SOURCE_REVIEW.json', cap=256*1024)
    pin(launch['stage1_manifest'], cap=128*1024)
    need(launch['stage2_manifest'] == sources and launch['source_review'] == review
         and {k: launch['stage1_manifest'][k] for k in ('bytes', 'sha256')} ==
         projection['preparation_bindings']['stage1_manifest']
         and type(launch['whole_wall_seconds']) is int and launch['whole_wall_seconds'] == 6900,
         'LAUNCH_SOURCE_BINDING')
    attempt_dir = PARENT / projection['attempt_id']
    result_path = attempt_dir / 'STAGE2_RESULT.json'
    result, result_pin = store.object(result_path, dict(metadata['stage2_result'], path=str(result_path)))
    need(result.get('schema') == 'studio-CI-stage2-entry-result/1'
         and result.get('status') == 'FAILED_RETAINED_NO_AUTOMATIC_RETRY'
         and result.get('qualification') == 'NONE'
         and same(owner(result.get('owner'), args.owner, store.uid), projection),
         'CURRENT_FAILED_STAGE2_RESULT')
    phase_results = result.get('phase_results')
    need(type(phase_results) is dict and set(phase_results) <= set(PHASES)
         and all(type(v) is dict for v in phase_results.values()), 'SUCCESSFUL_PHASE_FACTS_MAP')
    records, controls = {}, {'launch': launch_pin, 'stage2_result': result_pin}
    for phase in PHASES:
        store.guard.check()
        name = attempt_dir / phase / 'PARENT_RESULT.json'
        try:
            records[phase] = parent_control(store, name, phase)
        except FileNotFoundError:
            # Missing fixed leaves are observations only; no scan or replacement.
            continue
    failed = [phase for phase, (value, unused) in records.items() if value['worker_exit'] != 0]
    need(len(failed) == 1, 'NO_FAILED_COMPLETED_WORKER' if not failed else 'AMBIGUOUS_FAILED_WORKERS')
    phase = failed[0]
    index = PHASES.index(phase)
    need(set(records) == set(PHASES[:index+1]) and set(phase_results) == set(PHASES[:index]),
         'SERIAL_PHASE_RESULT_SEQUENCE')
    contexts = {}
    for prior in PHASES[:index+1]:
        value, observed = records[prior]
        ctx, ctx_pin = context(store, prior, attempt_dir, value['context'], projection, sources, args)
        contexts[prior] = ctx
        controls[prior + '_parent'] = observed
        controls[prior + '_context'] = ctx_pin
        if prior != phase:
            need(value['worker_exit'] == 0 and value['status'] == 'worker_exit0' and value['signals'] == [],
                 'PRECEDING_PHASE_NOT_CLEAN')
        if prior == 'finalize':
            need('dynamic_image_contexts' not in ctx['owner'], 'FINALIZE_CONTEXT_NO_DYNAMIC_FIELDS')
        need(value.get('origin_machine') == projection['origin_machine']
             and type(value.get('source_owner')) is str and text(value['source_owner'])
             and same(value.get('estimate'), PHASE_ESTIMATE), 'PARENT_PROVENANCE_ESTIMATE')
    selected_context = contexts[phase]
    if phase == 'finalize':
        need('dynamic_image_contexts' not in result['owner'], 'FAILED_FINALIZE_NO_DYNAMIC_FIELDS')
    else:
        final, final_pin = store.object(attempt_dir / 'finalize/PHASE_FACTS.json')
        need(set(final) == {'prerequisites', 'dynamic_image_contexts'}
             and type(final['prerequisites']) is dict and same(final, phase_results['finalize']),
             'FINALIZE_FACTS_PROVENANCE')
        image_contexts(final['dynamic_image_contexts'])
        need(set(final['prerequisites']) == {'finalization', 'finalizer_admission', 'native_phases', 'native_parent'},
             'FINALIZE_PREREQUISITE_FIELDS')
        for role, leaf in (('finalization', 'finalization_r1.json'),
                           ('finalizer_admission', 'finalizer-admission-r1.json'),
                           ('native_phases', 'native-phases-r1.json')):
            pin(final['prerequisites'][role], str(JOB / 'receipts' / leaf), cap=32*1024**2)
        native_pin = pin(final['prerequisites']['native_parent'], cap=2*1024**2)
        need(re.fullmatch(re.escape(str(ROOT)) + r'/native-parent/attempt-[0-9a-f]{32}/PARENT_RESULT\.json',
                          native_pin['path']) is not None, 'FINALIZE_NATIVE_PARENT_PIN')
        need(contexts['finalize']['facts'] == {}, 'FINALIZE_INITIAL_FACTS')
        for prior in PHASES[1:index+1]:
            need('dynamic_image_contexts' in contexts[prior]['owner']
                 and same(contexts[prior]['owner']['dynamic_image_contexts'], final['dynamic_image_contexts'])
                 and same(contexts[prior]['facts'].get('prerequisites'), final['prerequisites']),
                 'LATER_PHASE_DYNAMIC_IMAGE_PROVENANCE')
        need('dynamic_image_contexts' in result['owner']
             and same(result['owner']['dynamic_image_contexts'], final['dynamic_image_contexts']),
             'RESULT_DYNAMIC_IMAGE_PROVENANCE')
        controls['finalize_facts'] = final_pin
    # Reconstruct the exact serial facts visible to each phase. This binds later
    # image contexts to successful finalize facts, while task lists remain mutable.
    facts, evidence = {}, {}
    for prior in PHASES[:index+1]:
        need(same(contexts[prior]['facts'], facts), 'SERIAL_CONTEXT_FACTS_JOIN')
        if prior == phase:
            break
        successful = phase_results[prior]
        if prior == 'finalize':
            facts['prerequisites'] = successful['prerequisites']
            evidence.update(successful['prerequisites'])
        elif prior in ('native_audit', 'relocation'):
            need(set(successful) == {'audit_receipt'} and type(successful['audit_receipt']) is dict,
                 'SUCCESSFUL_AUDIT_FACTS')
            pin(successful['audit_receipt'], str(JOB / 'receipts' /
                ('runtime-native-audit-r1.json' if prior == 'native_audit' else 'runtime-relocation-r1.json')),
                cap=64*1024**2)
            evidence[prior] = successful['audit_receipt']
        elif prior == 'copy':
            need(set(successful) == {'copy'} and type(successful['copy']) is dict, 'SUCCESSFUL_COPY_FACTS')
        facts['evidence'] = dict(evidence)
    store.verify()
    return {'phase': phase, 'attempt_id': projection['attempt_id'], 'directory': attempt_dir / phase,
        'parent': records[phase][0], 'context': selected_context, 'control_pins': controls,
        'stage2_manifest': sources, 'source_review': review, 'source_roles': subjects}


def log_tail(store, name, metadata):
    """Verify a whole small source, or the declared weaker stable-path large range."""
    need(type(metadata) is dict and set(metadata) == {'path', 'bytes_observed', 'captured_prefix_bytes',
         'prefix_sha256', 'over_limit', 'stable_during_read', 'full_file_pin'}, 'LOG_PARENT_METADATA')
    need(metadata['path'] == str(name) and metadata['stable_during_read'] is True
         and integer(metadata['bytes_observed'], 0, MAX_LOG)
         and integer(metadata['captured_prefix_bytes'], 0, PREFIX)
         and type(metadata['prefix_sha256']) is str and HEX.fullmatch(metadata['prefix_sha256']) is not None
         and type(metadata['over_limit']) is bool, 'LOG_PARENT_STABILITY')
    held = store.open(name, MAX_LOG, empty=True, private_anchor=ROOT)
    need(metadata['bytes_observed'] == held.size, 'LOG_OBSERVED_SIZE_CHANGED')
    offset = max(0, held.size-TAIL)
    if held.size <= PREFIX:
        need(metadata['full_file_pin'] is not None, 'NOT_CAPTURED_UNBOUND')
        whole = pin(metadata['full_file_pin'], str(name), allow_empty=True, cap=PREFIX)
        need(whole['bytes'] == held.size and metadata['over_limit'] is False
             and metadata['captured_prefix_bytes'] == held.size, 'LOG_SMALL_METADATA')
        raw = held.read(0, held.size, log=True)
        digest = sha(raw)
        need(whole['sha256'] == digest == metadata['prefix_sha256'], 'LOG_FULL_SHA_MISMATCH')
        tail = raw[offset:]
        scope, verified, full_sha = 'FULL_SOURCE_VERIFIED', True, digest
    else:
        need(metadata['full_file_pin'] is None and metadata['over_limit'] is True
             and metadata['captured_prefix_bytes'] == PREFIX, 'LOG_LARGE_PREFIX_METADATA')
        raw_prefix = held.read(0, PREFIX, log=True)
        need(sha(raw_prefix) == metadata['prefix_sha256'], 'LOG_PREFIX_SHA_MISMATCH')
        tail = held.read(offset, held.size-offset, log=True)
        scope, verified, full_sha = 'CURRENT_STABLE_PATH_RANGE_WITH_PARENT_PREFIX_CONSISTENCY', False, None
    held.verify()
    return tail, {'state': 'CAPTURED_EMPTY' if not tail else 'CAPTURED',
        'source_bytes': held.size, 'range_offset': offset, 'range_bytes': len(tail),
        'range_sha256': sha(tail), 'range_truncated': offset > 0,
        'source_identity': dict(zip(('dev', 'ino', 'uid', 'mode', 'nlink', 'size',
                                    'mtime_ns', 'ctime_ns'), held.key)),
        'source_full_verification': verified, 'source_full_sha256': full_sha,
        'parent_prefix_bytes': metadata['captured_prefix_bytes'],
        'parent_prefix_sha256': metadata['prefix_sha256'], 'hash_scope': scope,
        'historical_worker_tail_authenticated': False}


class Output:
    """Three fixed leaves only. Partial writes stay under their fixed leaf, never complete by inference."""
    def __init__(self, store, runner_temp, capture_id):
        self.store = store
        self.fd = None
        self.files = {}
        self.keys = {}
        need(type(capture_id) is str and re.fullmatch(r'[0-9a-f]{32}', capture_id) is not None, 'OUTPUT_CAPTURE_ID')
        self.capture_id = capture_id
        self.created = False
        need(ROOT != runner_temp and ROOT not in runner_temp.parents and runner_temp not in ROOT.parents,
             'RUNNER_TEMP_SEPARATE_FROM_CI_ROOT')
        store.dirs.get(runner_temp)
        need(os.fstat(store.dirs.get(runner_temp)).st_uid == store.uid, 'RUNNER_TEMP_OWNER')
        base = runner_temp / 'omegahive-private-phase-failure-r1'
        try:
            store.dirs.get(base, private=True)
        except FileNotFoundError:
            store.dirs.create_private(base)
        self.directory = base / self.capture_id

    def create(self):
        self.store.guard.check()
        self.store.dirs.verify()
        parent = self.store.dirs.get(self.directory.parent, private=True)
        os.mkdir(self.directory.name, 0o700, dir_fd=parent)
        self.created = True
        os.fsync(parent)
        self.fd = self.store.dirs.get(self.directory, private=True)

    def verify(self):
        self.store.verify()
        for name, key in self.keys.items():
            need(file_key(os.fstat(self.files[name])) == key and
                 file_key(os.stat(name, dir_fd=self.fd, follow_symlinks=False)) == key, 'OUTPUT_CHANGED')

    def write(self, name, raw, *, cleanup=False):
        need(name in ('STDOUT.tail.bin', 'STDERR.tail.bin', 'PRIVATE_TAIL_RECEIPT_R1.json')
             and name not in self.files and len(raw) <= (MAX_RECEIPT if name.endswith('.json') else TAIL),
             'FIXED_OUTPUT_LEAF_BOUND')
        self.store.guard.check(cleanup=cleanup)
        self.verify()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.fd)
        self.files[name] = fd
        done = 0
        while done < len(raw):
            self.store.guard.check(cleanup=cleanup)
            count = os.write(fd, raw[done:])
            need(type(count) is int and count > 0, 'SHORT_WRITE')
            done += count
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        info = os.fstat(fd)
        need(info.st_size == len(raw) and stat.S_ISREG(info.st_mode) and info.st_uid == self.store.uid
             and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o400, 'OUTPUT_IDENTITY')
        self.keys[name] = file_key(info)
        self.verify()
        os.fsync(self.fd)
        return {'bytes': len(raw), 'sha256': sha(raw)}

    def close(self):
        errors = False
        for name, fd in self.files.items():
            try:
                # Owned partial files are frozen, not deleted or promoted.
                if name not in self.keys:
                    os.fchmod(fd, 0o400)
                    os.fsync(fd)
            except BaseException:
                errors = True
            finally:
                try:
                    os.close(fd)
                except BaseException:
                    errors = True
        self.files.clear()
        return errors


def run(args, guard):
    need(sys.platform == 'darwin' and os.uname().machine == 'arm64'
         and os.getuid() == os.geteuid() > 0 and sys.flags.isolated and sys.flags.no_site
         and sys.dont_write_bytecode and not sys.flags.optimize, 'ISOLATED_DARWIN_OWNER')
    need(os.environ.get('PATH') == SYSTEM_PATH and os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_ENVIRONMENT')
    uid = os.getuid()
    store = Store(uid, guard)
    out = None
    result = {'status': 'REFUSED', 'phase': None, 'captured_logs': 0, 'captured_bytes': 0,
              'receipt_sha256': None, 'attempt_created': False, 'payload_logged': False,
              'qualification': QUALIFICATION}
    receipt = None
    exit_code = 1
    try:
        guard.check()
        need(type(args.source_sha256) is str and HEX.fullmatch(args.source_sha256) is not None, 'SELF_SHA_SYNTAX')
        self_raw, self_pin = store.read(path(str(Path(__file__).absolute())),
                                        cap=256*1024, policy=ReadPolicy.SOURCE_ONLY)
        need(sha(self_raw) == args.source_sha256, 'SELF_SOURCE_PIN')
        metadata, metadata_pin = metadata_inputs(args, store)
        bound = bind_failure(store, args, metadata)
        result['phase'] = bound['phase']
        runner_temp = path(os.environ.get('RUNNER_TEMP', ''))
        out = Output(store, runner_temp, metadata['capture_id'])
        out.create()
        result['attempt_created'] = out.created
        receipt = {'schema': RECEIPT_SCHEMA, 'capture_id': out.capture_id, 'attempt_id': bound['attempt_id'],
            'phase': bound['phase'], 'worker_pid': bound['parent']['worker_pid'],
            'worker_exit': bound['parent']['worker_exit'], 'worker_reaped': True, 'group_absent': True,
            'parent_signal_count': len(bound['parent']['signals']),
            'parent_guard_recorded': bound['parent'].get('guard_error') is not None,
            'source_owner': 'Private failed-phase Source helper', 'origin_machine': 'CI_OWNER_ATTESTED',
            'artifact_profile': ARTIFACT_PROFILE, 'classification': 'PRIVATE_OPAQUE_DO_NOT_RENDER',
            'closure_scope': 'BYTE_COMMIT_BEFORE_DESCRIPTOR_CLOSE_NO_CLOSE_SUCCESS_CLAIM',
            'qualification': QUALIFICATION, 'owner_metadata_pin': metadata_pin,
            'helper_source_pin': {'bytes': self_pin['bytes'], 'sha256': self_pin['sha256']},
            'stage2_manifest_pin': {k: bound['stage2_manifest'][k] for k in ('bytes', 'sha256')},
            'stage2_review_pin': {k: bound['source_review'][k] for k in ('bytes', 'sha256')},
            'control_pins': {k: {x: v[x] for x in ('bytes', 'sha256')} for k,v in bound['control_pins'].items()},
            'logs': {}, 'status': 'STARTED', 'cause': 'UNKNOWN'}
        for name in LOGS:
            try:
                tail, row = log_tail(store, bound['directory'] / name, bound['parent']['logs'][name])
                row['output_pin'] = out.write(LEAVES[name], tail)
                result['captured_logs'] += 1
                result['captured_bytes'] += len(tail)
                receipt['logs'][name] = row
            except FileNotFoundError:
                receipt['logs'][name] = {'state': 'NOT_CAPTURED_MISSING'}
            except Refused as error:
                # Fixed code only, never exception text or raw controls.
                state = ('PARTIAL_RETAINED_UNVERIFIED' if LEAVES[name] in out.files else
                    'NOT_CAPTURED_UNBOUND' if error.code == 'NOT_CAPTURED_UNBOUND' else 'NOT_CAPTURED_REFUSED')
                receipt['logs'][name] = {'state': state, 'reason_code': error.code}
                if error.code in ('CANCELLED', 'DEADLINE', 'SELF_RSS_LIMIT'):
                    raise
        need(result['captured_bytes'] <= 2*TAIL, 'TAIL_TOTAL_BOUND')
        out.verify()
        receipt['status'] = 'CAPTURED_BOTH' if result['captured_logs'] == 2 else 'PARTIAL_OR_NOT_CAPTURED'
        receipt['read_bytes'] = {'controls': store.control_bytes, 'logs': store.log_bytes}
        guard.check()
        receipt_pin = out.write('PRIVATE_TAIL_RECEIPT_R1.json', encoded(receipt, MAX_RECEIPT))
        out.verify()
        result.update(status=receipt['status'], receipt_sha256=receipt_pin['sha256'])
        exit_code = 0 if result['captured_logs'] == 2 else 1
    except BaseException as error:
        code = (error.code if type(error) is Refused else
                'REQUIRED_INPUT_MISSING' if isinstance(error, FileNotFoundError) else
                'FILE_ACCESS_REFUSED' if isinstance(error, PermissionError) else
                'FILE_IO_REFUSED' if isinstance(error, OSError) else 'INTERNAL_ERROR')
        result.update(status='FAILED_RETAINED' if out is not None else 'REFUSED',
                      reason_code=code)
        if receipt is not None and out is not None and 'PRIVATE_TAIL_RECEIPT_R1.json' not in out.files:
            try:
                receipt.update(status='FAILED_RETAINED', reason_code=result['reason_code'])
                receipt_pin = out.write('PRIVATE_TAIL_RECEIPT_R1.json', encoded(receipt, MAX_RECEIPT), cleanup=True)
                result['receipt_sha256'] = receipt_pin['sha256']
            except BaseException:
                result['status'] = 'FAILED_RETAINED_RECEIPT_UNCONFIRMED'
        exit_code = 1
    finally:
        errors = False
        if out is not None:
            result['attempt_created'] = out.created
            errors = out.close()
        errors = store.close() or errors
        if errors:
            result.update(status='FAILED_RETAINED_CLOSE_UNCONFIRMED')
            exit_code = 1
    if exit_code == 0:
        try:
            # Success is decided only after every owned close was attempted.
            # This is the original active clock/RSS/cancel guard, never a renewal.
            guard.check()
        except BaseException as error:
            result.update(status='FAILED_RETAINED_FINAL_GUARD',
                          reason_code=error.code if type(error) is Refused else 'INTERNAL_ERROR')
            exit_code = 1
    return result, exit_code


def main(argv=None):
    started = time.monotonic()
    parser = SafeParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--source-sha256')
    parser.add_argument('--owner-metadata')
    parser.add_argument('--owner-metadata-sha256')
    parser.add_argument('--owner')
    parser.add_argument('--dedicated-ci-job', action='store_true')
    try:
        args = parser.parse_args(argv)
    except Refused:
        print(json.dumps({'status': 'REFUSED', 'reason_code': 'CLI_ARGUMENTS',
                          'attempt_created': False, 'payload_logged': False}))
        return 2
    if not args.run:
        print(json.dumps({'status': 'SOURCE_INTERFACE_ONLY', 'inputs_opened': False,
                          'worker_started': False, 'network_action': False}))
        return 0
    if not all((args.source_sha256, args.owner_metadata, args.owner_metadata_sha256,
                args.owner, args.dedicated_ci_job)):
        print(json.dumps({'status': 'REFUSED', 'reason_code': 'ALL_EXPLICIT_INPUTS_REQUIRED',
                          'attempt_created': False, 'payload_logged': False}))
        return 1
    guard = Guard(started)
    previous, timer_owned, run_entered = {}, False, False
    def stop(unused_signal, unused_frame):
        guard.cancelled = True
    def alarm(unused_signal, unused_frame):
        raise Refused('WHOLE_DEADLINE')
    status = 1
    try:
        need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_ALARM_REFUSED')
        for kind in (signal.SIGINT, signal.SIGTERM):
            previous[kind] = signal.signal(kind, stop)
        previous[signal.SIGALRM] = signal.signal(signal.SIGALRM, alarm)
        remaining = WHOLE_SECONDS - (time.monotonic()-started)
        need(remaining > 0, 'DEADLINE')
        signal.setitimer(signal.ITIMER_REAL, remaining)
        timer_owned = True
        run_entered = True
        result, status = run(args, guard)
    except BaseException:
        result = {'status': 'FAILED_ATTEMPT_STATE_UNKNOWN' if run_entered else 'REFUSED',
            'attempt_created': None if run_entered else False, 'payload_logged': False,
            'qualification': QUALIFICATION}
    try:
        raw = encoded(result, 2048)
        # No exception body, metadata owner strings, paths, tail or Base64 is printed.
        offset = 0
        while offset < len(raw):
            guard.check(cleanup=(status != 0))
            count = os.write(1, raw[offset:])
            need(type(count) is int and count > 0, 'STDOUT_SHORT_WRITE')
            offset += count
        guard.check(cleanup=(status != 0))
    except BaseException:
        status = 1
    finally:
        if timer_owned:
            signal.setitimer(signal.ITIMER_REAL, 0)
        for kind, handler in previous.items():
            signal.signal(kind, handler)
    if status == 0:
        try:
            # Timer/handler restoration can itself admit a pending cancellation;
            # an already printed byte-commit summary is never exit authority.
            guard.check()
        except BaseException:
            status = 1
    return status


if __name__ == '__main__':
    raise SystemExit(main())
