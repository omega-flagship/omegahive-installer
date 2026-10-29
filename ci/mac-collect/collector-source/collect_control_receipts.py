"""Bounded control-receipt custody worker. Default mode does no collection.

Requires a separately reviewed CI caller, external context digest and genuine
Source review. This worker neither admits Hive members nor qualifies a runtime.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
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
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
ESTIMATE = {'ram_gb': 0.625, 'cpu_cores': 1.25, 'disk_gb': 2.125, 'kind': 'task'}
WORK_SECONDS, CLEANUP_SECONDS = 600, 20
CHUNK = 65536
MAX_DATA = 1024**3
MAX_FILES = 140000
MAX_MANIFEST = 64 * 1024**2
MAX_SELF_RSS, MAX_CHILD_RSS = 512 * 1024**2, 128 * 1024**2
QUALIFICATION = 'CONTROL_RECEIPTS_CUSTODY_ONLY_NOT_RUNTIME_QUALIFICATION'
SOURCE_NAMES = {
    'collector': 'collect_control_receipts.py',
    'selectors': 'RECEIPT_SELECTORS_R1.json',
    'resource_guide': 'project_graph/resources.py',
    'resource_policy': 'project_graph/resource-policy.json',
}
REVIEW_NAME = 'STATIC_COLLECTOR_SOURCE_REVIEW.json'
TOKENS = {
    '<32lowerhex>': '[a-f0-9]{32}',
    '<oldsha>': '[a-f0-9]{64}',
    '<newsha>': '[a-f0-9]{64}',
    '<YYYYmmddTHHMMSSZ>': '[0-9]{8}T[0-9]{6}Z',
    '<12lowerhex>': '[a-f0-9]{12}',
    '<6digits>': '[0-9]{6}',
}
STOP = False


class Refused(Exception):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def cancelled(_number, _frame):
    global STOP
    STOP = True


def digest(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def parts(relative):
    need(type(relative) is str and len(relative.encode()) <= 2048,
         'bounded_relative_control_path_required')
    values = relative.split('/')
    need(values and all(re.fullmatch('[A-Za-z0-9_.-]+', v)
                        and v not in {'.', '..'} for v in values),
         'literal_relative_control_path_required')
    return values


def identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino,
            'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def plain_file(info):
    need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
         and info.st_nlink == 1 and not info.st_mode & 0o022,
         'owned_plain_single_link_control_file_required')


def absolute_directory(path, expected=None, private=False):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)),
         'canonical_absolute_directory_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:]:
            need(name not in {'.', '..', ''}, 'canonical_directory_component_required')
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        need(info.st_uid == os.getuid() and not info.st_mode & 0o022,
             'owned_nonwritable_directory_required')
        if private:
            need(stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_required')
        if expected is not None:
            need(identity(info) == expected, 'directory_identity_changed')
        return fd
    except BaseException:
        os.close(fd)
        raise


class Tree:
    """Descriptor walks only for literal paths selected by the frozen policy."""

    def __init__(self, path, expected, private=False):
        self.path = Path(path)
        self.fd = absolute_directory(path, expected, private)
        self.initial = identity(os.fstat(self.fd))

    def close(self):
        os.close(self.fd)

    def revalidate(self):
        fd = absolute_directory(self.path, self.initial)
        os.close(fd)

    @contextmanager
    def directory(self, relative=''):
        fd = os.dup(self.fd)
        try:
            for name in (parts(relative) if relative else []):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                info = os.fstat(fd)
                need(info.st_uid == os.getuid() and not info.st_mode & 0o022,
                     'unsafe_control_directory')
            yield fd
        finally:
            os.close(fd)

    @contextmanager
    def parent(self, relative):
        values = parts(relative)
        with self.directory('/'.join(values[:-1])) as fd:
            yield fd, values[-1]

    def read(self, relative, maximum, expected=None):
        with self.parent(relative) as (parent, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                before = os.fstat(fd)
                plain_file(before)
                need(0 <= before.st_size <= maximum, 'control_metadata_size_bound')
                raw = bytearray()
                while True:
                    block = os.read(fd, CHUNK)
                    if not block:
                        break
                    raw.extend(block)
                    need(len(raw) <= maximum, 'growing_control_metadata')
                need(file_identity(before) == file_identity(os.fstat(fd))
                     == file_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)),
                     'control_metadata_identity_changed')
                data = bytes(raw)
                need(len(data) == before.st_size, 'control_metadata_short_read')
                if expected is not None:
                    need(digest(data) == {k: expected[k] for k in ('bytes', 'sha256')},
                         'external_control_pin_changed')
                return data
            finally:
                os.close(fd)

    def names(self, relative, maximum):
        with self.directory(relative) as fd:
            before = os.fstat(fd)
            values = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    need(len(values) < maximum, 'typed_namespace_entry_bound')
                    values.append(entry.name)
            after = os.fstat(fd)
            need((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns)
                 == (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns),
                 'typed_namespace_changed_during_enumeration')
            return sorted(values)


def read_absolute(path, maximum, expected=None, exact_mode=None):
    path = Path(path)
    tree = Tree(path.parent, None)
    try:
        if exact_mode is not None:
            with tree.parent(path.name) as (fd, name):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                plain_file(info)
                need(stat.S_IMODE(info.st_mode) == exact_mode, 'context_mode_required')
        return tree.read(path.name, maximum, expected)
    finally:
        tree.close()


def load_sources(context):
    base = Path(__file__).absolute().parent
    tree = Tree(base, None)
    try:
        manifest_pin = context['source_manifest']
        need(manifest_pin['path'] == str(base / 'MANIFEST.sha256'), 'fixed_source_manifest_required')
        raw = tree.read('MANIFEST.sha256', 128 * 1024, manifest_pin)
        need(raw.endswith(b'\n') and b'\r' not in raw, 'LF_source_manifest_required')
        pins, bodies = {}, {}
        allowed = set(SOURCE_NAMES.values()) | {REVIEW_NAME}
        for line in raw.decode('ascii').splitlines():
            match = re.fullmatch('([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
            need(match is not None, 'source_manifest_row_required')
            sha, name = match.groups()
            need(name in allowed and name not in pins, 'closed_auxiliary_source_set_required')
            data = tree.read(name, 256 * 1024)
            need(hashlib.sha256(data).hexdigest() == sha, 'sealed_auxiliary_source_changed')
            pins[name], bodies[name] = {'path': name, **digest(data)}, data
        need(set(pins) == allowed, 'complete_auxiliary_source_set_required')
        review = json.loads(bodies[REVIEW_NAME])
        need(set(review) == {'schema', 'verdict', 'blocking_findings', 'reviewer',
                            'source_owner', 'origin_machine', 'subjects', 'scope'}
             and review['schema'] == 'studio-Mac-CI-control-receipts-static-review/1'
             and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == [],
             'genuine_independent_source_review_required')
        need(all(type(review[k]) is str and 0 < len(review[k]) <= 4096
                 for k in ('reviewer', 'source_owner', 'origin_machine', 'scope')),
             'source_review_attribution_required')
        need(set(review['subjects']) == set(SOURCE_NAMES), 'closed_source_review_roles_required')
        for role, name in SOURCE_NAMES.items():
            need(review['subjects'][role] == pins[name], 'reviewed_source_subject_changed')
        need(context['source_review'] == dict(pins[REVIEW_NAME], path=str(base / REVIEW_NAME)),
             'external_raw_review_pin_changed')
        selectors = json.loads(bodies[SOURCE_NAMES['selectors']])
        need(selectors['schema'] == 'studio-control-receipt-selectors/1'
             and type(selectors['templates']) is list and 0 < len(selectors['templates']) <= 160,
             'finite_selector_policy_required')
        return tree, pins, bodies, selectors
    except BaseException:
        tree.close()
        raise


def validate_tasks(tasks):
    # Same closed active-task row contract as the already-declared custody exporter.
    # The enclosing immutable owner context carries observation and admission expiry.
    need(type(tasks) is list and len(tasks) <= 256, 'bounded_current_tasks_required')
    seen = set()
    for row in tasks:
        need(type(row) is dict and set(row) == {'task_id', 'state', 'pid', 'estimate'}
             and type(row['task_id']) is str and 0 < len(row['task_id']) <= 128
             and row['task_id'] not in seen and row['state'] in {'running', 'reserved'},
             'closed_active_current_task_required')
        seen.add(row['task_id'])
        need((row['state'] == 'running' and type(row['pid']) is int and row['pid'] > 0)
             or (row['state'] == 'reserved' and row['pid'] is None), 'typed_current_task_PID_required')
        estimate = row['estimate']
        need(type(estimate) is dict and set(estimate) == {'ram_gb', 'cpu_cores', 'disk_gb'},
             'closed_current_task_estimate_required')
        for key, amount in estimate.items():
            need(type(amount) in (int, float) and math.isfinite(amount)
                 and 0 <= amount <= 1000000 and (key == 'disk_gb' or amount > 0),
                 'finite_current_task_estimate_required')
    return tasks


def validate_context(context, raw_sha):
    keys = {'schema', 'execution_owner', 'origin_machine', 'authorized_action',
            'dedicated_ci_job', 'observed_at_epoch', 'valid_until_epoch',
            'complete_current_tasks', 'current_tasks', 'source_manifest', 'source_review',
            'ci_root_identity', 'output_parent', 'output_parent_identity', 'attempt_id',
            'estimate', 'work_seconds', 'cleanup_seconds'}
    need(type(context) is dict and set(context) == keys, 'closed_collector_owner_context_required')
    need(context['schema'] == 'studio-Mac-CI-control-receipts-owner-context/1'
         and context['authorized_action'] == 'COLLECT_CONTROL_RECEIPTS_ONLY'
         and context['dedicated_ci_job'] is True and context['complete_current_tasks'] is True,
         'explicit_dedicated_owner_collection_admission_required')
    need(re.fullmatch('[a-f0-9]{64}', raw_sha) and os.getuid() > 0
         and os.geteuid() == os.getuid(), 'positive_owner_and_external_context_pin_required')
    need(all(type(context[k]) is str and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', context[k])
             for k in ('execution_owner', 'origin_machine')),
         'bounded_owner_origin_attribution_required')
    now = time.time()
    need(type(context['observed_at_epoch']) in (int, float)
         and 0 <= now - context['observed_at_epoch'] < 15,
         'fresh_initial_owner_observation_required')
    need(type(context['valid_until_epoch']) in (int, float)
         and now + WORK_SECONDS + CLEANUP_SECONDS <= context['valid_until_epoch'] <= now + 3600,
         'owner_collection_lease_required')
    validate_tasks(context['current_tasks'])
    need(re.fullmatch('[a-f0-9]{32}', context['attempt_id']) is not None
         and context['estimate'] == ESTIMATE and context['work_seconds'] == WORK_SECONDS
         and context['cleanup_seconds'] == CLEANUP_SECONDS, 'fixed_collection_envelope_required')


class Budget:
    def __init__(self, context, context_path, context_sha, sources, started):
        self.context, self.context_path, self.context_sha = context, context_path, context_sha
        self.started = started
        self.next_gate = 0.0
        self.sources = sources
        self.last_advice = None
        self.peak_self = self.peak_child = 0

    def tick(self, force=False):
        need(not STOP, 'collection_cancelled')
        need(time.monotonic() - self.started < WORK_SECONDS, 'original_collection_wall_expired')
        need(time.time() < self.context['valid_until_epoch'], 'owner_collection_lease_expired')
        need(os.environ.get('PATH') == SYSTEM_PATH, 'canonical_system_PATH_required')
        scale = 1 if sys.platform == 'darwin' else 1024
        self.peak_self = max(self.peak_self, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale)
        self.peak_child = max(self.peak_child, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * scale)
        need(self.peak_self <= MAX_SELF_RSS and self.peak_child <= MAX_CHILD_RSS,
             'collector_or_observer_RSS_bound')
        if force or time.monotonic() >= self.next_gate:
            self.refresh()

    def refresh(self):
        raw = read_absolute(self.context_path, 256 * 1024, exact_mode=0o400)
        need(hashlib.sha256(raw).hexdigest() == self.context_sha,
             'owner_context_changed_during_collection')
        tasks = validate_tasks(self.context['current_tasks'])
        tree, pins, bodies, _selectors = self.sources
        for role in ('resource_guide', 'resource_policy'):
            name = SOURCE_NAMES[role]
            tree.read(name, 256 * 1024, pins[name])
        namespace = {'__name__': 'admitted_control_receipts_resource_guide',
                     '__file__': str(tree.path / SOURCE_NAMES['resource_guide'])}
        exec(compile(bodies[SOURCE_NAMES['resource_guide']], namespace['__file__'], 'exec'), namespace)
        started = time.monotonic()
        snapshot = namespace['sample'](force=True)
        disk_fd = absolute_directory(self.context['output_parent'],
                                     self.context['output_parent_identity'])
        try:
            disk = os.fstatvfs(disk_fd)
        finally:
            os.close(disk_fd)
        snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                            'free_bytes': disk.f_bavail * disk.f_frsize}
        advice = namespace['advise'](snapshot, ESTIMATE, tasks)
        checked = datetime.fromisoformat(snapshot['checked_at'].replace('Z', '+00:00'))
        need(checked.tzinfo is not None and 0 <= time.time() - checked.timestamp() < 15
             and time.monotonic() - started < 15, 'fresh_actual_resource_advice_required')
        need(advice.get('policy', {}).get('sha256') == pins[SOURCE_NAMES['resource_policy']]['sha256']
             and snapshot.get('memory', {}).get('pressure') == 'normal'
             and advice.get('decision') == 'run',
             'normal_RUN_resource_admission_required')
        self.last_advice = {'checked_at': snapshot['checked_at'],
                            'memory_pressure': snapshot['memory']['pressure'],
                            'decision': advice['decision']}
        self.next_gate = time.monotonic() + 5
        need(not STOP and time.monotonic() - self.started < WORK_SECONDS
             and time.time() < self.context['valid_until_epoch'],
             'collection_guard_changed_during_resource_probe')


def segment_pattern(segment):
    text = re.escape(segment)
    found = False
    for token, expression in TOKENS.items():
        if token in segment:
            found = True
            text = text.replace(re.escape(token), expression)
    need(not re.search('[<>]', re.sub('|'.join(map(re.escape, TOKENS)), '', segment)),
         'unknown_selector_token')
    return re.compile(text), found


def selector_trie(policy):
    trie, seen = {}, set()
    for row in policy['templates']:
        need(set(row) == {'family', 'path', 'max_bytes', 'zero_only'},
             'closed_selector_row_required')
        path = row['path']
        need(type(path) is str and not path.startswith('/') and '..' not in path.split('/'),
             'relative_selector_required')
        need(path not in seen and type(row['max_bytes']) is int
             and 0 <= row['max_bytes'] <= 64 * 1024**2 and type(row['zero_only']) is bool,
             'bounded_unique_selector_required')
        seen.add(path)
        node = trie
        for segment in path.split('/'):
            segment_pattern(segment)
            node = node.setdefault(segment, {})
        need('$file' not in node and not node, 'selector_leaf_collision')
        node['$file'] = row
    return trie


class Collector:
    def __init__(self, input_tree, output, policy, budget):
        self.input, self.output, self.policy, self.budget = input_tree, output, policy, budget
        self.files, self.namespaces, self.selected = [], [], []
        self.data_bytes = 0
        self.failed = False

    def discover(self, node, relative=''):
        self.budget.tick()
        if '$file' in node:
            need(len(self.selected) < MAX_FILES, 'selected_control_file_count_bound')
            self.selected.append((relative, node['$file']))
            return
        cached_names = None
        for segment, child in sorted(node.items()):
            regex, dynamic = segment_pattern(segment)
            if dynamic:
                if cached_names is None:
                    try:
                        cached_names = self.input.names(relative, 40000)
                        self.namespaces.append({'path': relative, 'state': 'enumerated_typed_namespace',
                                                'entry_count': len(cached_names)})
                    except FileNotFoundError:
                        self.namespaces.append({'path': relative, 'state': 'absent'})
                        cached_names = []
                matches = [name for name in cached_names if regex.fullmatch(name)]
                self.namespaces.append({'path': relative, 'selector_segment': segment,
                                        'state': 'typed_matches_only', 'matched_count': len(matches),
                                        'other_names_never_traversed': True})
                need(len(matches) <= (8202 if '<6digits>' in segment else 32),
                     'typed_attempt_or_command_count_bound')
                if '<6digits>' in segment:
                    need(all(1 <= int(re.search('[0-9]{6}', n).group()) <= 8202 for n in matches),
                         'source_command_index_bound')
                for name in matches:
                    self.discover(child, '/'.join(filter(None, (relative, name))))
            else:
                need(re.fullmatch('[A-Za-z0-9_.-]+', segment) and segment not in {'.', '..'},
                     'literal_selector_component_required')
                self.discover(child, '/'.join(filter(None, (relative, segment))))

    @contextmanager
    def output_parent(self, relative):
        values = parts(relative)
        fd = os.dup(self.output.fd)
        try:
            for name in values[:-1]:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                info = os.fstat(fd)
                need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                     'private_held_output_directory_required')
            yield fd, values[-1]
        finally:
            os.close(fd)

    def collect_one(self, relative, selector):
        record = {'path': relative, 'family': selector['family'], 'state': 'not_copied',
                  'source_bytes': None, 'copied_bytes': 0, 'copied_sha256': None}
        self.files.append(record)
        outfd = None
        sha = hashlib.sha256()
        try:
            self.budget.tick()
            with self.input.parent(relative) as (parent, name):
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = os.fstat(fd)
                    plain_file(before)
                    record['source_bytes'] = before.st_size
                    need(before.st_size <= selector['max_bytes'], 'selected_artifact_oversize')
                    need(not selector['zero_only'] or before.st_size == 0, 'nonempty_ready_marker')
                    need(self.data_bytes + before.st_size <= MAX_DATA, 'aggregate_capture_data_bound')
                    with self.output_parent('evidence/' + relative) as (output_parent, leaf):
                        outfd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                        0o600, dir_fd=output_parent)
                    record['state'] = 'partial'
                    while True:
                        self.budget.tick()
                        block = os.read(fd, CHUNK)
                        if not block:
                            break
                        need(record['copied_bytes'] + len(block) <= before.st_size,
                             'selected_artifact_grew')
                        view = memoryview(block)
                        while view:
                            self.budget.tick()
                            written = os.write(outfd, view)
                            need(written > 0, 'short_control_capture_write')
                            sha.update(view[:written])
                            record['copied_bytes'] += written
                            self.data_bytes += written
                            view = view[written:]
                    os.fsync(outfd)
                    self.budget.tick()
                    need(file_identity(before) == file_identity(os.fstat(fd))
                         == file_identity(os.stat(name, dir_fd=parent, follow_symlinks=False))
                         and record['copied_bytes'] == before.st_size,
                         'selected_artifact_changed_during_capture')
                    os.fchmod(outfd, 0o400)
                    need(os.fstat(outfd).st_size == before.st_size, 'captured_output_size_changed')
                    record['state'] = 'captured_stable_bytes'
                finally:
                    os.close(fd)
        except FileNotFoundError:
            record['state'] = 'absent' if outfd is None else 'partial_source_disappeared'
            if outfd is not None:
                self.failed = True
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            self.failed = True
            record['error'] = str(error) if isinstance(error, Refused) else type(error).__name__
            if outfd is not None:
                record['state'] = 'partial_failed_capture'
        finally:
            if outfd is not None:
                record['copied_sha256'] = sha.hexdigest()
                os.close(outfd)

    def run(self):
        if self.input is None:
            self.namespaces.append({'path': '.', 'state': 'CI_root_absent_no_collection'})
            return
        self.discover(selector_trie(self.policy))
        for index, (path, selector) in enumerate(self.selected):
            try:
                self.budget.tick()
            except Refused as error:
                self.failed = True
                self.namespaces.append({'state': 'remaining_selected_not_attempted',
                                        'count': len(self.selected) - index, 'reason': str(error)})
                self.files.extend({'path': p, 'family': s['family'],
                                   'state': 'not_attempted_guard_refusal', 'reason': str(error),
                                   'source_bytes': None, 'copied_bytes': 0, 'copied_sha256': None}
                                  for p, s in self.selected[index:])
                break
            self.collect_one(path, selector)


def write_exclusive_json(output, name, value, maximum, budget=None, completion_deadline=None):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()
    need(len(raw) <= maximum, 'capture_sidecar_size_bound')
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output.fd)
    try:
            view = memoryview(raw)
            while view:
                if completion_deadline is not None:
                    need(time.monotonic() < completion_deadline, 'failure_record_completion_deadline')
                if budget is not None:
                    budget.tick()
                written = os.write(fd, view[:CHUNK])
                need(written > 0, 'capture_sidecar_short_write')
                view = view[written:]
            os.fsync(fd)
            if completion_deadline is not None:
                need(time.monotonic() < completion_deadline, 'failure_record_completion_deadline')
            if budget is not None:
                budget.tick()
            os.fchmod(fd, 0o400)
            os.fsync(output.fd)
            if budget is not None:
                budget.tick()
    finally:
        os.close(fd)


def execute(context_path, context_sha):
    started = time.monotonic()
    need(os.environ.get('PATH') == SYSTEM_PATH, 'canonical_system_PATH_required')
    raw = read_absolute(context_path, 256 * 1024, exact_mode=0o400)
    need(re.fullmatch('[a-f0-9]{64}', context_sha) is not None
         and hashlib.sha256(raw).hexdigest() == context_sha, 'external_owner_context_pin_required')
    context = json.loads(raw)
    validate_context(context, context_sha)
    sources = load_sources(context)
    output_parent_fd = input_tree = output_tree = collector = budget = None
    output = None
    try:
        budget = Budget(context, context_path, context_sha, sources, started)
        budget.tick(force=True)
        output_parent_fd = absolute_directory(context['output_parent'], context['output_parent_identity'])
        name = 'mac-receipts-' + context['attempt_id']
        os.mkdir(name, 0o700, dir_fd=output_parent_fd)
        created_identity = identity(os.stat(name, dir_fd=output_parent_fd, follow_symlinks=False))
        os.fsync(output_parent_fd)
        output = Path(context['output_parent']) / name
        output_tree = Tree(output, created_identity, private=True)
        if context['ci_root_identity'] is None:
            need(not os.path.lexists(ROOT), 'unexpected_unadmitted_CI_root')
        else:
            input_tree = Tree(ROOT, context['ci_root_identity'], private=True)
        collector = Collector(input_tree, output_tree, sources[3], budget)
        collector.run()
        budget.tick(force=True)
        if input_tree is not None:
            input_tree.revalidate()
        output_tree.revalidate()
        manifest = {'schema': 'studio-control-receipts-custody-manifest/1',
                    'qualification': QUALIFICATION, 'execution_owner': context['execution_owner'],
                    'origin_machine': context['origin_machine'], 'context_sha256': context_sha,
                    'source_manifest': context['source_manifest'], 'source_review': context['source_review'],
                    'source_root': str(ROOT), 'root_identity': context['ci_root_identity'],
                    'attempt_id': context['attempt_id'], 'files': collector.files,
                    'namespaces': collector.namespaces, 'selected_count': len(collector.selected),
                    'copied_bytes': collector.data_bytes, 'capture_errors': collector.failed,
                    'absence_is_not_successful_phase_evidence': True,
                    'peak_self_RSS_bytes': budget.peak_self, 'peak_serial_child_RSS_bytes': budget.peak_child,
                    'resource_estimate_is_not_OS_quota': ESTIMATE,
                    'final_resource_advice': budget.last_advice}
        write_exclusive_json(output_tree, 'CUSTODY_MANIFEST.json', manifest, MAX_MANIFEST, budget)
        need(not collector.failed, 'capture_errors_retained')
        budget.tick(force=True)
        write_exclusive_json(output_tree, 'COLLECTION_RESULT.json', {
            'schema': 'studio-control-receipts-collector-result/1', 'qualification': QUALIFICATION,
            'status': 'CONTROL_CAPTURE_FINISHED', 'workflow_or_runtime_pass': False,
            'selected_count': len(collector.selected), 'copied_bytes': collector.data_bytes}, 65536, budget)
        budget.tick()
        output_tree.revalidate()
        return 0
    except BaseException as error:
        if output_tree is not None:
            # Failure metadata and descriptor cleanup do not re-enter active-work guards.
            # Earlier output is retained, including a partial sidecar/result if present.
            try:
                value = {'schema': 'studio-control-receipts-collection-failure/1',
                         'qualification': QUALIFICATION, 'status': 'FAILED_RETAINED_NO_RETRY',
                         'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
                         'context_sha256': context_sha,
                         'files': collector.files if collector is not None else [],
                         'namespaces': collector.namespaces if collector is not None else [],
                         'result_alone_never_overrides_actual_failed_exit': True}
                write_exclusive_json(output_tree, 'COLLECTION_FAILED.json', value, MAX_MANIFEST,
                                     completion_deadline=started + WORK_SECONDS + CLEANUP_SECONDS)
            except BaseException:
                pass  # An absent/partial failure sidecar is explicitly not proof of cleanup or capture.
        raise
    finally:
        if input_tree is not None:
            input_tree.close()
        if output_tree is not None:
            output_tree.close()
        if output_parent_fd is not None:
            os.close(output_parent_fd)
        sources[0].close()


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--context')
    parser.add_argument('--context-sha256')
    args = parser.parse_args(argv)
    if not args.run:
        print(json.dumps({'status': 'SOURCE_INTERFACE_PLAN_NO_COLLECTION',
                          'qualification': QUALIFICATION, 'estimate': ESTIMATE,
                          'work_seconds': WORK_SECONDS, 'cleanup_seconds': CLEANUP_SECONDS}))
        return 0
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        need(args.context and args.context_sha256, 'explicit_owner_context_arguments_required')
        return execute(args.context, args.context_sha256)
    except BaseException as error:
        print(json.dumps({'status': 'FAILED_RETAINED_NO_RETRY', 'qualification': QUALIFICATION,
                          'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
                          'workflow_or_runtime_pass': False}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
