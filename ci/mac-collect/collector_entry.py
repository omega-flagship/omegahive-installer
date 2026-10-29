"""Explicit CI custody caller and owned-process parent for control collection.

Default mode checks only sealed Source and reviews. No target runtime is needed.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import math
import os
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
ENTRY_SECONDS, WORKER_SECONDS, CLEANUP_SECONDS = 45, 620, 20
ENTRY_RSS_BYTES = 128 * 1024**2
CHUNK = 65536
WORKER_ESTIMATE = {'ram_gb': 0.625, 'cpu_cores': 1.25, 'disk_gb': 2.125, 'kind': 'task'}
PARENT_ESTIMATE = {'ram_gb': 0.125, 'cpu_cores': 0.25, 'disk_gb': 0.0625}
ESTIMATE = {'ram_gb': 0.75, 'cpu_cores': 1.5, 'disk_gb': 2.1875, 'kind': 'task'}
GUIDE_PIN = {'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}
POLICY_PIN = {'bytes': 375, 'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}
SOURCE_NAMES = {
 'collector_entry': 'collector_entry.py',
 'collector': 'collector-source/collect_control_receipts.py',
 'selectors': 'collector-source/RECEIPT_SELECTORS_R1.json',
 'resource_guide': 'collector-source/project_graph/resources.py',
 'resource_policy': 'collector-source/project_graph/resource-policy.json',
}
ENTRY_REVIEW = 'STATIC_COLLECTOR_ENTRY_SOURCE_REVIEW.json'
WORKER_REVIEW = 'collector-source/STATIC_COLLECTOR_SOURCE_REVIEW.json'
FILES = set(SOURCE_NAMES.values()) | {ENTRY_REVIEW, WORKER_REVIEW,
 'collector-source/MANIFEST.sha256', 'README.md'}
QUALIFICATION = 'CONTROL_RECEIPTS_CUSTODY_ONLY_NOT_RUNTIME_QUALIFICATION'
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


def parse_manifest(raw, allowed):
    need(raw.endswith(b'\n') and b'\r' not in raw, 'LF_source_manifest_required')
    rows = {}
    for line in raw.decode('ascii').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
        need(match is not None and match[2] in allowed and match[2] not in rows,
             'closed_source_manifest_required')
        rows[match[2]] = match[1]
    need(set(rows) == set(allowed), 'complete_source_manifest_required')
    return rows


def check_review(value, schema, subjects):
    need(type(value) is dict and set(value) == {'schema', 'verdict', 'blocking_findings',
         'reviewer', 'source_owner', 'origin_machine', 'subjects', 'scope'}
         and value['schema'] == schema and value['verdict'] == 'PASS_SOURCE_ONLY'
         and value['blocking_findings'] == [] and value['subjects'] == subjects,
         'genuine_exact_independent_source_review_required')
    need(all(type(value[key]) is str and 0 < len(value[key]) <= 4096
             for key in ('reviewer', 'source_owner', 'origin_machine', 'scope')),
         'source_review_attribution_required')


def load_sources(path, external_sha):
    need(type(external_sha) is str and re.fullmatch('[a-f0-9]{64}', external_sha),
         'external_source_manifest_sha256_required')
    path = Path(path)
    need(path.name == 'MANIFEST.sha256', 'fixed_outer_manifest_name_required')
    raw, manifest_pin = read_file(path, 16384)
    need(manifest_pin['sha256'] == external_sha, 'external_source_manifest_mismatch')
    rows = parse_manifest(raw, FILES)
    bodies, pins = {}, {}
    for name in sorted(FILES):
        bodies[name], pins[name] = read_file(path.parent / name, 512 * 1024)
        need(pins[name]['sha256'] == rows[name], 'sealed_source_changed')
    need(read_file(Path(__file__).absolute(), 512 * 1024)[1] == pins['collector_entry.py'],
         'actual_entry_must_be_sealed_subject')
    worker_names = {value.removeprefix('collector-source/') for role, value in
                    SOURCE_NAMES.items() if role != 'collector_entry'}
    worker_names.add('STATIC_COLLECTOR_SOURCE_REVIEW.json')
    inner = parse_manifest(bodies['collector-source/MANIFEST.sha256'], worker_names)
    need(all(inner[name] == pins['collector-source/' + name]['sha256']
             for name in worker_names), 'inner_and_outer_source_seals_must_agree')
    worker_subjects = {role: dict(pins[name], path=name.removeprefix('collector-source/'))
                       for role, name in SOURCE_NAMES.items() if role != 'collector_entry'}
    check_review(object_bytes(bodies[WORKER_REVIEW]),
        'studio-Mac-CI-control-receipts-static-review/1', worker_subjects)
    check_review(object_bytes(bodies[ENTRY_REVIEW]),
        'studio-Mac-CI-control-receipts-entry-static-review/1',
        {role: dict(pins[name], path=name) for role, name in SOURCE_NAMES.items()})
    for role, expected in [('resource_guide', GUIDE_PIN), ('resource_policy', POLICY_PIN)]:
        need({key: pins[SOURCE_NAMES[role]][key] for key in expected} == expected,
             'unchanged_reviewed_resource_guide_and_policy_required')
    return {'path': path, 'manifest': manifest_pin, 'pins': pins, 'bodies': bodies}


def identity(path, private=False):
    fd = directory(path)
    try:
        info = os.fstat(fd)
        need(info.st_uid == os.getuid() and info.st_mode & 0o022 == 0
             and (not private or stat.S_IMODE(info.st_mode) == 0o700),
             'owned_nongroupwritable_directory_required')
        return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
                'mode': stat.S_IMODE(info.st_mode)}
    finally:
        os.close(fd)


def executable_pin(path, allowed_owners):
    """Hash one explicitly selected interpreter/system executable, without profiles."""
    path = Path(path)
    parent = directory(path.parent)
    fd = None
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid in allowed_owners
             and before.st_nlink == 1 and before.st_mode & 0o111
             and not before.st_mode & 0o022 and 0 < before.st_size <= 64 * 1024**2,
             'trusted_bounded_executable_required')
        sha, count = hashlib.sha256(), 0
        while True:
            tick()
            block = os.read(fd, CHUNK)
            if not block:
                break
            count += len(block)
            need(count <= 64 * 1024**2, 'executable_size_bound')
            sha.update(block)
        need(count == before.st_size and file_key(before) == file_key(os.fstat(fd))
             == file_key(os.stat(path.name, dir_fd=parent, follow_symlinks=False)),
             'executable_identity_changed')
        return {'path': str(path), 'bytes': count, 'sha256': sha.hexdigest()}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def write_new(parent_fd, name, raw, maximum=4 * 1024**2):
    need(re.fullmatch('[A-Za-z0-9_.-]+', name) and 0 < len(raw) <= maximum,
         'bounded_control_output_required')
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent_fd)
    try:
        remaining = memoryview(raw)
        while remaining:
            count = os.write(fd, remaining[:CHUNK])
            need(count > 0, 'control_output_made_no_progress')
            remaining = remaining[count:]
        os.fchmod(fd, 0o400)
        os.fsync(fd)
        need(file_key(os.fstat(fd)) == file_key(os.stat(name, dir_fd=parent_fd,
                                                     follow_symlinks=False)),
             'control_output_identity_changed')
    finally:
        os.close(fd)
    os.fsync(parent_fd)
    return {'bytes': len(raw), 'sha256': digest(raw)}


def root_identity():
    try:
        os.lstat(ROOT)
    except FileNotFoundError:
        return None
    return identity(ROOT, private=True)


def sample_gate(guide, output_parent, tasks):
    started = time.monotonic()
    snapshot = guide['sample'](force=True)
    fs = os.statvfs(output_parent)
    snapshot['disk'] = {'total_bytes': fs.f_blocks * fs.f_frsize,
                        'free_bytes': fs.f_bavail * fs.f_frsize}
    advice = guide['advise'](snapshot, ESTIMATE, tasks)
    stamp = datetime.fromisoformat(snapshot['checked_at'].replace('Z', '+00:00'))
    need(stamp.tzinfo is not None and 0 <= time.time() - stamp.timestamp() < 15
         and time.monotonic() - started < 15 and snapshot['memory']['pressure'] == 'normal'
         and advice.get('decision') == 'run' and advice.get('estimate') == ESTIMATE
         and advice.get('policy', {}).get('sha256') == POLICY_PIN['sha256'],
         'fresh_normal_full_collector_resource_RUN_required')
    tick()
    return {'snapshot': snapshot, 'advice': advice, 'current_tasks': tasks,
            'gate_completed_monotonic': time.monotonic(), 'sample_checked_epoch': stamp.timestamp()}


def census(group):
    observed = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,uid=,rss=,stat='],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=2,
        env={'PATH': SYSTEM_PATH, 'LC_ALL': 'C'})
    need(observed.returncode == 0 and len(observed.stdout) <= 1024**2
         and len(observed.stderr) <= 4096, 'bounded_complete_ps_observation_required')
    rows = []
    for line in observed.stdout.decode('ascii').splitlines():
        fields = line.split()
        need(len(fields) == 6 and all(x.isdecimal() for x in fields[:5]),
             'complete_numeric_ps_row_required')
        pid, ppid, pgid, uid, kib = map(int, fields[:5])
        if pgid == group or pid == os.getpid() or ppid == os.getpid():
            rows.append({'pid': pid, 'ppid': ppid, 'pgid': pgid, 'uid': uid,
                         'rss_bytes': kib * 1024, 'zombie': fields[5].startswith('Z')})
    need(sum(row['pid'] == os.getpid() for row in rows) == 1, 'parent_observation_required')
    return rows


def leader(rows, child):
    found = [row for row in rows if row['pid'] == child.pid]
    need(len(found) == 1 and found[0]['ppid'] == os.getpid()
         and found[0]['pgid'] == child.pid and found[0]['uid'] == os.getuid(),
         'held_direct_child_group_identity_required')
    return found[0]


def supervise(child, out, stdout, stderr, result, child_started, selector):
    """Keep the direct leader unreaped until all owned group cleanup is finished."""
    streams = {}
    total_retained = 0

    def pump(timeout=0):
        nonlocal total_retained
        for key, _mask in selector.select(timeout):
            stream = streams[key.data]
            raw = os.read(key.fd, CHUNK)
            if not raw:
                selector.unregister(key.fileobj)
                continue
            stream['observed'] += len(raw)
            kept = raw[:max(0, 65536 - total_retained)]
            if kept:
                view = memoryview(kept)
                while view:
                    size = os.write(stream['fd'], view)
                    need(size > 0, 'log_write_made_no_progress')
                    view = view[size:]
                stream['sha'].update(kept)
                stream['retained'] += len(kept)
                total_retained += len(kept)

    def observe():
        before = time.monotonic()
        rows = census(child.pid)
        now = time.monotonic()
        held = leader(rows, child)
        worker_rss = sum(row['rss_bytes'] for row in rows if row['pgid'] == child.pid)
        parent_rss = sum(row['rss_bytes'] for row in rows if row['pid'] == os.getpid()
                         or row['ppid'] == os.getpid() and row['pgid'] != child.pid)
        result['sample_count'] += 1
        result['worker_group_rss_peak_bytes'] = max(result['worker_group_rss_peak_bytes'], worker_rss)
        result['parent_and_observer_rss_peak_bytes'] = max(result['parent_and_observer_rss_peak_bytes'], parent_rss)
        gap = now - result['last_sample_monotonic']
        result['max_sample_gap_seconds'] = max(result['max_sample_gap_seconds'], gap)
        result['last_sample_monotonic'] = now
        result['max_census_seconds'] = max(result['max_census_seconds'], now - before)
        return rows, held, worker_rss, parent_rss, gap

    try:
        try:
            for name, pipe, fd in [('STDOUT.log', child.stdout, stdout), ('STDERR.log', child.stderr, stderr)]:
                streams[name] = {'pipe': pipe, 'fd': fd, 'observed': 0, 'retained': 0,
                                 'sha': hashlib.sha256()}
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            need(os.getpgid(child.pid) == child.pid and os.getsid(child.pid) == child.pid,
                 'fresh_child_session_required')
            while True:
                pump(.1)
                rows, held, worker_rss, parent_rss, gap = observe()
                need(not STOP and time.monotonic() - child_started < WORKER_SECONDS,
                     'collection_parent_cancel_or_worker_wall')
                need(gap <= 2.5 and worker_rss <= 640 * 1024**2
                     and parent_rss <= 128 * 1024**2, 'collection_parent_observation_or_RSS_limit')
                need(sum(s['observed'] for s in streams.values()) <= 65536,
                     'combined_worker_log_bound')
                if held['zombie']:
                    break
        except BaseException as error:
            result['guard_error'] = str(error) if isinstance(error, Refused) else type(error).__name__
        finally:
            cleanup_until = time.monotonic() + CLEANUP_SECONDS
            try:
                # No poll/wait precedes these checks. The fresh-session direct
                # child's unreaped PID prevents reuse of its numeric PGID.
                for sig, allowance in [(signal.SIGTERM, 8), (signal.SIGKILL, 5)]:
                    rows, held, _wr, _pr, _gap = observe()
                    members = [row for row in rows if row['pgid'] == child.pid]
                    if held['zombie'] and len(members) == 1:
                        break
                    need(os.getpgid(child.pid) == child.pid and os.getsid(child.pid) == child.pid,
                         'owned_fresh_session_before_signal_required')
                    os.killpg(child.pid, sig)
                    result['signals'].append(sig.name)
                    until = min(cleanup_until - 4, time.monotonic() + allowance)
                    while time.monotonic() < until:
                        pump(.05)
                        rows, held, _wr, _pr, _gap = observe()
                        if held['zombie'] and not any(row['pgid'] == child.pid and
                                                     row['pid'] != child.pid for row in rows):
                            break
                rows, held, _wr, _pr, _gap = observe()
                need(held['zombie'] and not any(row['pgid'] == child.pid and row['pid'] != child.pid
                                                for row in rows), 'owned_group_not_clean_before_reap')
                child.wait(timeout=max(.1, min(2, cleanup_until - time.monotonic())))
                result['worker_reaped'] = True
                result['worker_exit'] = child.returncode
                result['group_absent'] = not any(row['pgid'] == child.pid for row in census(child.pid))
                until = min(cleanup_until, time.monotonic() + 2)
                while selector.get_map() and time.monotonic() < until:
                    pump(.05)
                need(not selector.get_map(), 'worker_log_pipes_not_closed')
            except BaseException as error:
                result['cleanup_error'] = str(error) if isinstance(error, Refused) else type(error).__name__
    finally:
        selector.close()
        for stream in streams.values():
            stream['pipe'].close()
            os.fsync(stream['fd'])
        result['logs'] = {name: {'bytes_observed': s['observed'], 'bytes_retained': s['retained'],
            'retained_sha256': s['sha'].hexdigest(), 'full_capture': s['observed'] == s['retained']}
            for name, s in streams.items()}
    return (result['guard_error'] is None and result['cleanup_error'] is None
            and result['worker_reaped'] and result['worker_exit'] == 0 and result['group_absent']
            and result['signals'] == [] and sum(s['observed'] for s in streams.values()) <= 65536
            and time.monotonic() - child_started < WORKER_SECONDS + CLEANUP_SECONDS)


def run(args, sources):
    global DEADLINE
    need(DEADLINE is not None, 'original_caller_clock_required')
    started = DEADLINE - ENTRY_SECONDS
    tick()
    need(args.dedicated_ci_job and type(args.owner) is str
         and re.fullmatch('[A-Za-z0-9_.:@-]{1,128}', args.owner)
         and sys.platform == 'darwin' and os.uname().machine == 'arm64'
         and sys.version_info[:2] == (3, 12) and sys.flags.isolated
         and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize
         and os.getuid() == os.geteuid() > 0
         and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
         and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('PATH') == SYSTEM_PATH,
         'dedicated_owner_and_trusted_setup_python_required')
    # This is the sole explicitly trusted symlink resolution: the interpreter
    # already running this reviewed caller, selected by official setup-python.
    python_path = Path(sys.executable).resolve(strict=True)
    python_pin = executable_pin(python_path, {0, os.getuid()})
    ps_pin = executable_pin(Path('/bin/ps'), {0})
    temp = Path(os.environ.get('RUNNER_TEMP', ''))
    need(temp.is_absolute() and str(temp) == os.path.normpath(str(temp))
         and not temp.is_relative_to(ROOT), 'canonical_separate_RUNNER_TEMP_required')
    temp_id = identity(temp)
    input_identity = root_identity()
    tasks = task_rows(args)
    guide_path = sources['pins'][SOURCE_NAMES['resource_guide']]['path']
    guide = {'__name__': 'reviewed_collector_entry_resource_guide', '__file__': guide_path}
    exec(compile(sources['bodies'][SOURCE_NAMES['resource_guide']], guide_path, 'exec'), guide)
    os.environ.clear()
    os.environ.update({'PATH': SYSTEM_PATH, 'GITHUB_ACTIONS': 'true', 'LANG': 'C', 'LC_ALL': 'C',
                       'HOME': str(temp), 'TMPDIR': str(temp), 'RUNNER_TEMP': str(temp)})
    initial = sample_gate(guide, temp, tasks)
    os.umask(0o077)
    temp_fd = directory(temp)
    try:
        name = 'omegahive-control-receipts-r1'
        try:
            os.mkdir(name, 0o700, dir_fd=temp_fd)
        except FileExistsError:
            pass
    finally:
        os.close(temp_fd)
    output_parent = temp / name
    output_id = identity(output_parent, private=True)
    parent_fd = directory(output_parent)
    attempt_id = uuid.uuid4().hex
    parent_name = 'collector-parent-' + attempt_id
    try:
        os.mkdir(parent_name, 0o700, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    out = output_parent / parent_name
    out_fd = directory(out)
    try:
        for leaf in ('home', 'tmp'):
            os.mkdir(leaf, 0o700, dir_fd=out_fd)
        need(len(tasks) < 256, 'space_for_actual_parent_reservation_required')
        worker_tasks = tasks + [{'task_id': 'collector-parent-' + attempt_id,
            'state': 'running', 'pid': os.getpid(), 'estimate': PARENT_ESTIMATE}]
        context = {'schema': 'studio-Mac-CI-control-receipts-owner-context/1',
            'execution_owner': args.owner, 'origin_machine': os.uname().nodename,
            'authorized_action': 'COLLECT_CONTROL_RECEIPTS_ONLY', 'dedicated_ci_job': True,
            'observed_at_epoch': time.time(), 'valid_until_epoch': time.time() + 900,
            'complete_current_tasks': True, 'current_tasks': worker_tasks,
            'source_manifest': sources['pins']['collector-source/MANIFEST.sha256'],
            'source_review': sources['pins'][WORKER_REVIEW],
            'ci_root_identity': input_identity, 'output_parent': str(output_parent),
            'output_parent_identity': output_id, 'attempt_id': attempt_id,
            'estimate': WORKER_ESTIMATE, 'work_seconds': 600, 'cleanup_seconds': 20}
        context_raw = encode(context)
        write_new(out_fd, 'OWNER_CONTEXT.json', context_raw, 256 * 1024)
        final = sample_gate(guide, output_parent, tasks)
        need(identity(temp) == temp_id and identity(output_parent, private=True) == output_id
             and root_identity() == input_identity, 'bound_directory_identity_changed')
        for pin in sources['pins'].values():
            read_file(Path(pin['path']), 512 * 1024, pin)
        need(executable_pin(python_path, {0, os.getuid()}) == python_pin
             and executable_pin(Path('/bin/ps'), {0}) == ps_pin, 'actual_tool_pin_changed')
        write_new(out_fd, 'LAUNCH.json', encode({'schema': 'studio-control-collector-entry-launch/1',
            'source_owner': args.owner, 'origin_machine': os.uname().nodename,
            'source_manifest': sources['manifest'], 'owner_context_sha256': digest(context_raw),
            'interpreter': python_pin, 'ps': ps_pin, 'initial_resource': initial,
            'final_resource': final, 'estimate': ESTIMATE,
            'worker_estimate': WORKER_ESTIMATE, 'parent_estimate': PARENT_ESTIMATE,
            'entry_seconds': ENTRY_SECONDS, 'worker_seconds': WORKER_SECONDS,
            'parent_cleanup_seconds': CLEANUP_SECONDS, 'qualification': QUALIFICATION}))
        tick()
        need(0 <= time.time() - context['observed_at_epoch'] < 15,
             'fresh_owner_context_immediately_before_spawn_required')
        stdout = os.open('STDOUT.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=out_fd)
        stderr = None
        try:
            stderr = os.open('STDERR.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=out_fd)
            result = {'schema': 'studio-control-collector-owned-parent/1', 'qualification': QUALIFICATION,
                'source_owner': args.owner, 'origin_machine': os.uname().nodename,
                'worker_reaped': False, 'worker_exit': None, 'group_absent': False,
                'signals': [], 'guard_error': None, 'cleanup_error': None,
                'sample_count': 0, 'max_sample_gap_seconds': 0, 'max_census_seconds': 0,
                'worker_group_rss_peak_bytes': 0, 'parent_and_observer_rss_peak_bytes': 0,
                'owner_context_sha256': digest(context_raw), 'source_manifest': sources['manifest']}
            env = {'PATH': SYSTEM_PATH, 'GITHUB_ACTIONS': 'true', 'LANG': 'C', 'LC_ALL': 'C',
                   'HOME': str(out / 'home'), 'TMPDIR': str(out / 'tmp'), 'RUNNER_TEMP': str(temp)}
            child_started = time.monotonic()
            need(0 <= child_started - final['gate_completed_monotonic'] < 15
                 and 0 <= time.time() - final['sample_checked_epoch'] < 15
                 and 0 <= time.time() - context['observed_at_epoch'] < 15,
                 'fresh_actual_final_gate_and_owner_context_at_spawn_required')
            selector = selectors.DefaultSelector()
            try:
                tick()
                child = subprocess.Popen([str(python_path), '-I', '-B', '-S',
                    sources['pins'][SOURCE_NAMES['collector']]['path'], '--run',
                    '--context', str(out / 'OWNER_CONTEXT.json'), '--context-sha256', digest(context_raw)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=out, env=env, start_new_session=True)
            except BaseException:
                selector.close()
                raise
            # Never poll/wait here. The unreaped leader anchors group ownership.
            result.update(worker_pid=child.pid, worker_pgid=child.pid,
                          last_sample_monotonic=child_started)
            DEADLINE = None  # The explicit worker and cleanup clocks now govern.
            clean = supervise(child, out, stdout, stderr, result, child_started, selector)
            result['status'] = 'CONTROL_CAPTURE_PARENT_CLEAN' if clean else 'FAILED_RETAINED_NO_RETRY'
            result['workflow_or_runtime_pass'] = False
            result['elapsed_seconds'] = time.monotonic() - started
            result.pop('last_sample_monotonic', None)
            write_new(out_fd, 'PARENT_RESULT.json', encode(result))
            print(json.dumps({'status': result['status'], 'result': str(out / 'PARENT_RESULT.json'),
                              'qualification': QUALIFICATION}, sort_keys=True), flush=True)
            return 0 if clean else 1
        finally:
            os.fchmod(stdout, 0o400)
            os.close(stdout)
            if stderr is not None:
                os.fchmod(stderr, 0o400)
                os.close(stderr)
    finally:
        os.close(out_fd)


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
        sources = load_sources(args.source_manifest, args.expected_manifest_sha256)
        if not args.run:
            print(json.dumps({'status': 'REVIEWED_COLLECTOR_SOURCE_PLAN_ONLY',
                'worker_started': False, 'manifest': sources['manifest'], 'qualification': QUALIFICATION},
                sort_keys=True), flush=True)
            return 0
        return run(args, sources)
    except BaseException as error:
        print(json.dumps({'status': 'FAILED_RETAINED_NO_AUTOMATIC_RETRY',
            'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
            'qualification': QUALIFICATION, 'workflow_or_runtime_pass': False}, sort_keys=True),
            file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())


