"""Portable, explicitly admitted CI parent for pinned public fetch then stage.

Static review is immutable source evidence. The CI owner admits the current
dedicated runner; fresh resource advice independently admits each data phase.
No target Python, native build, package installer or application is executed.
"""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import argparse
import ast
import hashlib
import json
import os
import platform
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
ESTIMATE = {'ram_gb': 1.125, 'cpu_cores': 1.25, 'disk_gb': 4, 'kind': 'task'}
WORK_SECONDS = 900
WHOLE_SECONDS = 940
ROLES = {'prep_entry', 'prep_parent_library', 'prep_worker_enabled',
         'prep_prototype', 'public_inputs', 'resource_guide', 'resource_policy',
         'native_entry', 'native_parent', 'native_worker_enabled', 'input_producer'}
CONTRACT_PIN = {'bytes': 63647, 'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'}
PROTOTYPE_PIN = {'bytes': 30505, 'sha256': 'a350127907f78776fb7352e4e2a794e66891fe851b64ae6fc6cd77280ccef4b2'}
LIBRARY_PIN = {'bytes': 29428, 'sha256': '1bbb0da1f89b6d0af32fedd68b21edc5127719e7d3b46ea40274ac893991ac34'}
GUIDE_PIN = {'bytes': 19590, 'sha256': '76d503d65fab968c6894f7ac5698178f8811f3aeb08cda2a3c0f9006a15b0fbb'}
POLICY_PIN = {'bytes': 375, 'sha256': '3add848d3756762ddffa9a817a3bebbf26b41674cb5ccf885028f499a627884f'}


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def pin(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def relative(name):
    need(type(name) is str and 0 < len(name) < 1024 and '\x00' not in name,
         'bounded_relative_path_required')
    value = PurePosixPath(name)
    need(not value.is_absolute() and '..' not in value.parts
         and str(value) == name and name != '.', 'canonical_relative_path_required')
    return name


def read_file(path, maximum):
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), 'plain_absolute_file_required')
    for parent in path.parents:
        need(stat.S_ISDIR(parent.lstat().st_mode), 'plain_file_ancestry_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and 0 < before.st_size <= maximum, 'bounded_regular_file_required')
        key = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_uid,
                           row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        chunks, size = [], 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'file_grew')
            chunks.append(block)
        need(size == before.st_size and key(before) == key(os.fstat(fd))
             == key(path.lstat()), 'file_changed_during_read')
        return b''.join(chunks)
    finally:
        os.close(fd)


def decode(raw):
    def pairs(rows):
        result = {}
        for name, value in rows:
            need(name not in result, 'duplicate_JSON_key')
            result[name] = value
        return result
    def invalid(_value):
        raise RuntimeError('nonfinite_JSON')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    need(type(value) is dict, 'JSON_object_required')
    return value


def same(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return set(actual) == set(expected) and all(same(actual[k], v) for k, v in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(same(a, b) for a, b in zip(actual, expected))
    return actual == expected


def sealed_sources(manifest, manifest_sha256, review_path):
    manifest = Path(manifest).absolute()
    need(manifest.name == 'MANIFEST.sha256' and manifest == manifest.resolve(),
         'sealed_MANIFEST_sha256_required')
    bundle = manifest.parent
    raw = read_file(manifest, 65536)
    need(type(manifest_sha256) is str and re.fullmatch('[a-f0-9]{64}', manifest_sha256)
         and pin(raw)['sha256'] == manifest_sha256, 'external_manifest_digest_mismatch')
    rows, sources, total = {}, {}, 0
    for line in raw.decode('ascii').splitlines():
        match = re.fullmatch('([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
        need(match is not None, 'standard_checksum_manifest_line_required')
        digest, name = match.groups()
        relative(name)
        need(name != manifest.name and name not in rows and len(rows) < 128,
             'manifest_duplicate_self_or_count')
        body = read_file(bundle / name, 256 * 1024)
        total += len(body)
        need(total <= 3 * 1024**2 and pin(body)['sha256'] == digest,
             'manifest_payload_digest_or_total')
        rows[name], sources[name] = pin(body), body
    need(rows, 'empty_source_manifest')
    review_path = Path(review_path).absolute()
    need(review_path == review_path.resolve() and review_path.parent == bundle
         and review_path.name == 'STATIC_SOURCE_REVIEW.json'
         and review_path.name in sources, 'sealed_whole_static_review_required')
    review = decode(sources[review_path.name])
    need(review.get('schema') == 'studio-Mac-CI-stage1-static-source-review/1'
         and review.get('verdict') == 'PASS_SOURCE_ONLY'
         and same(review.get('blocking_findings'), [])
         and type(review.get('subjects')) is dict and set(review['subjects']) == ROLES,
         'whole_static_source_review_required')
    for field in ('reviewer', 'source_owner', 'origin_machine', 'scope'):
        need(type(review.get(field)) is str and 0 < len(review[field]) <= 4096,
             'review_provenance_required')
    subjects = review['subjects']
    for subject in list(subjects.values()) + [review.get('native_component_review')]:
        need(type(subject) is dict and set(subject) == {'path', 'bytes', 'sha256'},
             'closed_static_subject_required')
        name = relative(subject['path'])
        need(name in rows and same({k: subject[k] for k in ('bytes', 'sha256')}, rows[name]),
             'review_subject_not_actual_sealed_source')
    component = review['native_component_review']
    need(component['path'] == 'STATIC_NATIVE_SOURCE_REVIEW.json',
         'presealed_component_review_required')
    actual_entry = Path(__file__).absolute()
    need(actual_entry == actual_entry.resolve()
         and actual_entry == bundle / subjects['prep_entry']['path'],
         'actual_entry_must_be_reviewed_subject')
    expected = {'prep_prototype': PROTOTYPE_PIN, 'public_inputs': CONTRACT_PIN,
                'prep_parent_library': LIBRARY_PIN, 'resource_guide': GUIDE_PIN,
                'resource_policy': POLICY_PIN}
    for role, expected_pin in expected.items():
        need(same(rows[subjects[role]['path']], expected_pin), 'fixed_reviewed_component_changed')
    need(Path(subjects['resource_policy']['path']).name == 'resource-policy.json'
         and Path(subjects['resource_guide']['path']).parent
         == Path(subjects['resource_policy']['path']).parent,
         'guide_and_actual_adjacent_policy_required')
    def worker_ast(body, enabled):
        values, rest = {}, []
        for node in ast.parse(body).body:
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id in {'PREPARATION_ENABLED', 'CONTRACT_SHA256'}):
                name = node.targets[0].id
                need(name not in values, 'duplicate_worker_binding')
                values[name] = ast.literal_eval(node.value)
            else:
                rest.append(ast.dump(node))
        need(same(values, {'PREPARATION_ENABLED': enabled,
                          'CONTRACT_SHA256': CONTRACT_PIN['sha256'] if enabled else None}),
             'only_two_worker_enable_bindings_allowed')
        return rest
    need(worker_ast(sources[subjects['prep_prototype']['path']], False)
         == worker_ast(sources[subjects['prep_worker_enabled']['path']], True),
         'worker_changed_outside_reviewed_enable_bindings')
    contract = decode(sources[subjects['public_inputs']['path']])
    need(contract.get('schema') == 'studio-Mac-CI-public-runtime-inputs/4'
         and type(contract.get('reference_files')) is dict
         and len(contract['reference_files']) == 10, 'ten_fixed_public_references_required')
    for name, row in contract['reference_files'].items():
        need(relative(name) == Path(name).name == row['source_relative'],
             'reference_basename_required')
        need('reference/' + name in rows
             and same(rows['reference/' + name], {k: row[k] for k in ('bytes', 'sha256')}),
             'sealed_reference_pin_mismatch')
    return bundle, rows, sources, review, contract


def write_new(path, raw, mode=0o400):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        remaining = memoryview(raw)
        while remaining:
            count = os.write(fd, remaining)
            need(count > 0, 'short_output_write')
            remaining = remaining[count:]
        os.fsync(fd)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)
    need(pin(read_file(path, max(1, len(raw)))) == pin(raw), 'written_source_readback_failed')


def write_json(path, value):
    write_new(path, (json.dumps(value, indent=2) + '\n').encode(), 0o600)


def resource_admission(guide_path, guide_raw, policy_path, estimate):
    need(same(pin(read_file(policy_path, 65536)), POLICY_PIN), 'actual_policy_source_changed')
    namespace = {'__name__': 'studio_CI_preparation_resource', '__file__': str(guide_path)}
    exec(compile(guide_raw, str(guide_path), 'exec'), namespace)
    started = time.monotonic()
    snapshot = namespace['sample'](force=True)
    disk = os.statvfs(CI_ROOT.parent)
    snapshot['disk'] = {'total_bytes': disk.f_blocks * disk.f_frsize,
                        'free_bytes': disk.f_bavail * disk.f_frsize}
    advice = namespace['advise'](snapshot, estimate, [])
    need(time.monotonic() - started <= 15
         and advice.get('policy', {}).get('sha256') == POLICY_PIN['sha256'],
         'fresh_actual_resource_policy_required')
    return {'at': snapshot['checked_at'], 'pressure': snapshot['memory']['pressure'],
            'advice': advice, 'estimate': estimate, 'current_tasks': [],
            'current_tasks_basis': 'CI owner explicitly attests this dedicated job has no other Studio reservation'}


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


def run_phase(namespace, phase, owner, sources_context, previous=None):
    need(not namespace['STOP'], 'cancelled_before_phase')
    root = CI_ROOT / 'preparation-parent' / phase
    root.mkdir(mode=0o700)
    home = root / 'home'
    home.mkdir(mode=0o700)
    temporary = home / 'tmp'
    temporary.mkdir(mode=0o700)
    namespace.update(ROOT=root, EXPECTED_HOME=home, EXPECTED_UID=os.getuid(),
                     PHASE=phase, JOB=CI_ROOT / 'runtime-job', CI_ROOT=CI_ROOT,
                     CONTRACT=sources_context['contract'])
    attempt = root / ('attempt-' + uuid.uuid4().hex)
    attempt.mkdir(mode=0o700)
    advice = wait_resource_admission(
        lambda: resource_admission(sources_context['guide_path'], sources_context['guide_raw'],
                                   sources_context['policy_path'], ESTIMATE),
        sources_context['wait_budget'],
        lambda: ADMISSION_STOP or namespace['STOP'] or os.path.lexists(attempt / 'STOP'), phase)
    write_json(attempt / 'RESOURCE_ADMISSION.json', advice)
    if advice['advice']['decision'] != 'run':
        write_json(attempt / 'PARENT_RESULT.json', {
            'schema': 'studio-owned-public-preparation-parent/1', 'phase': phase,
            'status': 'NOT_RUN_RESOURCE_' + advice['advice']['decision'].upper(),
            'worker_pid': None, 'native_action': False, 'source_owner': owner})
        return None
    private_identity = namespace['private_home_snapshot']()
    ci_identity = namespace['directory_identity'](CI_ROOT)
    job = CI_ROOT / 'runtime-job'
    if phase == 'fetch':
        need(previous is None and not os.path.lexists(job), 'exclusive_fetch_job_required')
    else:
        need(previous is not None and previous['status'] == 'worker_exit0'
             and previous['cleanup']['worker_reaped'] is True
             and previous['cleanup']['group_absent'] is True
             and previous['cleanup']['signals'] == []
             and same(previous['job_identity'], namespace['directory_identity'](job))
             and not os.path.lexists(job / 'STAGE_STARTED_R1.json')
             and not os.path.lexists(job / 'CI_PREPARATION_RECEIPT_R1.json'),
             'clean_fetch_only_once_before_stage_required')
        _raw, actual = namespace['completion_file'](job / 'FETCH_RECEIPT_R1.json', 2 * 1024**2)
        need(same(actual, previous['worker_receipt']), 'fetch_receipt_changed_between_phases')
    worker = sources_context['worker']
    argv = [sys.executable, '-I', '-B', '-S', worker['path'], phase,
            '--job', str(job), '--contract', sources_context['contract']['path'],
            '--reference', str(CI_ROOT / 'runtime-source/reference')]
    process = None
    result = {'schema': 'studio-owned-public-preparation-parent/1', 'phase': phase,
              'source_owner': owner, 'origin_machine': 'dedicated macOS arm64 CI runner',
              'status': 'starting', 'started_at': namespace['now'](), 'estimate': ESTIMATE,
              'worker': worker, 'static_source_context': sources_context['static_context'],
              'ci_root_identity': ci_identity, 'rss_peak_bytes': 0,
              'worker_rss_peak_bytes': 0, 'parent_rss_peak_bytes': 0,
              'sample_count': 0, 'max_sample_gap': 0, 'native_action': False}
    started = last = time.monotonic()
    try:
        with (attempt / 'WORKER_STDOUT.log').open('xb') as out, (attempt / 'WORKER_STDERR.log').open('xb') as err:
            need(pin(read_file(worker['path'], 128 * 1024))
                 == {k: worker[k] for k in ('bytes', 'sha256')}, 'worker_changed_before_launch')
            need(namespace['private_home_snapshot']() == private_identity
                 and namespace['directory_identity'](CI_ROOT) == ci_identity,
                 'private_directories_changed_before_launch')
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(advice['at'].replace('Z', '+00:00'))).total_seconds()
            need(not namespace['STOP'] and not os.path.lexists(attempt / 'STOP')
                 and 0 <= age < 15,
                 'cancelled_or_resource_admission_expired_before_launch')
            process = subprocess.Popen(argv, cwd=CI_ROOT,
                env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home),
                     'TMPDIR': str(temporary), 'LANG': 'C', 'LC_ALL': 'C'},
                stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                close_fds=True, start_new_session=True)
            result.update(worker_pid=process.pid, worker_pgid=process.pid, status='running')
            write_json(attempt / 'STARTED.json', result)
            print(json.dumps({'status': 'CI_PUBLIC_DATA_PHASE_STARTED', 'phase': phase,
                              'worker_pid': process.pid, 'attempt': str(attempt)}), flush=True)
            while process.poll() is None:
                current = time.monotonic()
                need(not namespace['STOP'] and current - started < WORK_SECONDS
                     and not os.path.lexists(attempt / 'STOP'), 'cancelled_or_work_deadline')
                rows = namespace['census'](process.pid)
                worker_rss = sum(row['rss_bytes'] for row in rows if row['pgid'] == process.pid)
                parent_rss = sum(row['rss_bytes'] for row in rows if row['pid'] == os.getpid())
                total = worker_rss + parent_rss
                for key, value in [('rss_peak_bytes', total), ('worker_rss_peak_bytes', worker_rss),
                                   ('parent_rss_peak_bytes', parent_rss), ('max_sample_gap', current - last)]:
                    result[key] = max(result[key], value)
                result['sample_count'] += 1
                need(current - last <= 2.5 and worker_rss < 1024**3
                     and parent_rss < .125 * 1024**3 and total < 1.125 * 1024**3
                     and out.tell() + err.tell() <= 65536, 'RSS_log_or_observation_guard')
                last = current
                time.sleep(.25)
            need(out.tell() + err.tell() <= 65536, 'terminal_log_limit')
            result.update(worker_exit=process.returncode,
                          status='worker_exit0' if process.returncode == 0 else 'worker_failed_retained')
    except BaseException as error:
        result.update(status='failed_retained_no_retry', error_type=type(error).__name__)
    finally:
        try:
            if process is not None:
                result.update(namespace['finalize_owned'](process, attempt, result['status'],
                    min(started + WHOLE_SECONDS, time.monotonic() + 20)))
                if result['status'] == 'worker_exit0':
                    try:
                        need(namespace['directory_identity'](CI_ROOT) == ci_identity,
                             'CI_root_changed_during_phase')
                        result.update(namespace['linked_preparation_completion'](sources_context['contract_data']))
                    except BaseException as error:
                        result.update(status='failed_completion_link', completion_error=type(error).__name__)
                        result['finalization_errors'].append({'stage': 'completion_link', 'type': type(error).__name__})
        finally:
            result.update(finished_at=namespace['now'](), elapsed_seconds=time.monotonic() - started,
                          qualification='Public data preparation only; target interpreter and native tools not executed.')
            write_json(attempt / 'PARENT_RESULT.json', result)
            print(json.dumps({'status': result['status'], 'phase': phase,
                              'result': str(attempt / 'PARENT_RESULT.json')}), flush=True)
    return result if result['status'] == 'worker_exit0' else None


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--static-review', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--dedicated-ci-job', action='store_true')
    parser.add_argument('--admission-wait-seconds', type=int, default=600)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    need(args.run and args.dedicated_ci_job and re.fullmatch('[A-Za-z0-9_.-]{1,80}', args.owner)
         and sys.platform == 'darwin' and platform.machine() == 'arm64'
         and os.getuid() == os.geteuid() > 0 and sys.flags.isolated and sys.flags.no_site
         and sys.dont_write_bytecode and not sys.flags.optimize
         and os.environ.get('GITHUB_ACTIONS') == 'true'
         and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
         'explicit_dedicated_macOS_arm64_CI_owner_admission_required')
    bundle, rows, sources, review, contract = sealed_sources(
        args.manifest, args.manifest_sha256, args.static_review)
    need(0 <= args.admission_wait_seconds <= 600, 'admission_wait_limit_0_to_600_required')
    signal.signal(signal.SIGTERM, admission_cancelled)
    signal.signal(signal.SIGINT, admission_cancelled)
    wait_budget = {'remaining_seconds': args.admission_wait_seconds}
    subjects = review['subjects']
    guide_path = bundle / subjects['resource_guide']['path']
    policy_path = bundle / subjects['resource_policy']['path']
    initial = wait_resource_admission(
        lambda: resource_admission(guide_path, sources[subjects['resource_guide']['path']], policy_path, ESTIMATE),
        wait_budget, lambda: ADMISSION_STOP, 'initial')
    if initial['advice']['decision'] != 'run':
        print(json.dumps({'status': 'NOT_RUN_RESOURCE_' + initial['advice']['decision'].upper(),
                          'admission': initial, 'retry': False}), flush=True)
        return 75
    need(not ADMISSION_STOP and not os.path.lexists(CI_ROOT),
         'uncancelled_exclusive_fresh_CI_root_required_no_resume')
    os.umask(0o077)
    CI_ROOT.mkdir(mode=0o700)
    source = CI_ROOT / 'runtime-source'
    source.mkdir(mode=0o700)
    (source / 'reference').mkdir(mode=0o700)
    (CI_ROOT / 'preparation-parent').mkdir(mode=0o700)
    (CI_ROOT / 'project_graph').mkdir(mode=0o700)
    write_new(CI_ROOT / 'project_graph/resources.py', sources[subjects['resource_guide']['path']])
    write_new(CI_ROOT / 'project_graph/resource-policy.json', sources[subjects['resource_policy']['path']])
    for role, name in [('prep_worker_enabled', 'prepare_ci_runtime.py'),
                       ('prep_prototype', 'prepare_ci_runtime_prototype.py'),
                       ('public_inputs', 'PUBLIC_RUNTIME_INPUTS_R4.json')]:
        write_new(source / name, sources[subjects[role]['path']])
    for name in contract['reference_files']:
        write_new(source / 'reference' / name, sources['reference/' + name])
    namespace = {'__name__': 'studio_CI_preparation_parent_library',
                 '__file__': str(bundle / subjects['prep_parent_library']['path'])}
    exec(compile(sources[subjects['prep_parent_library']['path']], namespace['__file__'], 'exec'), namespace)
    signal.signal(signal.SIGTERM, namespace['cancelled'])
    signal.signal(signal.SIGINT, namespace['cancelled'])
    context = {'contract': {'path': str(source / 'PUBLIC_RUNTIME_INPUTS_R4.json'), **CONTRACT_PIN},
               'contract_data': contract,
               'worker': {'path': str(source / 'prepare_ci_runtime.py'),
                          **rows[subjects['prep_worker_enabled']['path']]},
               'wait_budget': wait_budget,
               'guide_path': guide_path, 'guide_raw': sources[subjects['resource_guide']['path']],
               'policy_path': policy_path,
               'static_context': {'manifest_sha256': args.manifest_sha256,
                                  'review': rows['STATIC_SOURCE_REVIEW.json'],
                                  'owner_admission': args.owner, 'dedicated_ci_job': True}}
    write_json(CI_ROOT / 'PREPARATION_OWNER_CONTEXT_R1.json', {
        'schema': 'studio-Mac-CI-preparation-owner-context/1', 'owner': args.owner,
        'origin_machine': 'dedicated macOS arm64 CI runner', 'uid': os.getuid(),
        'static_source_context': context['static_context'], 'initial_admission': initial,
        'qualification': 'Owner admission and source identity; no execution pass claimed.'})
    fetched = run_phase(namespace, 'fetch', args.owner, context)
    if fetched is None:
        return 1
    return 0 if run_phase(namespace, 'stage', args.owner, context, fetched) is not None else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'FAILED_RETAINED_NO_RETRY', 'error_type': type(error).__name__,
                          'native_action': False}), flush=True)
        raise SystemExit(1)
