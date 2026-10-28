"""Disabled fixed nine-phase fresh Mac arm64 native build controller worker."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/private/tmp/omegahive-ci-r12')
HERE = ROOT / 'native-source'
SELF = HERE / 'ci_native_worker.py'
BINDING = HERE / 'NATIVE_BUILD_INPUTS_R1.json'
JOB = ROOT / 'runtime-job'
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
OUTPUT = ROOT / 'native-build-attempts'
RUN_ENABLED = True
PYTHON_PIN = {'bytes': 18652104, 'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
RECIPE_PIN = {'bytes': 7104, 'sha256': '450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709'}
CONTRACT_PIN = {'bytes': 63647, 'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'}
PHASES = ['tools', 'python', 'node', 'pcre', 'configure', 'build', 'install', 'deps', 'janus']
ESTIMATE = {'ram_gb': 3, 'cpu_cores': 2, 'disk_gb': 8, 'kind': 'task'}
WHOLE, RESERVE, RSS_LIMIT, LOG_LIMIT = 1800, 30, 3 * 1024**3, 32 * 1024**2
STOP = None
DEADLINE = None
NEXT_SAMPLE = 0.0
PS_PIN = None
RSS = {'limit_bytes': RSS_LIMIT, 'target_interval_seconds': .25, 'samples': 0,
       'peak_bytes': 0, 'first_sample': None, 'last_sample': None,
       'maximum_gap_seconds': 0, 'monitor_failure': None, 'stop_reason': None}

class Refused(RuntimeError):
    pass

def now():
    return datetime.now(timezone.utc).isoformat()

def cancelled(number, _frame):
    global STOP
    STOP = 'signal-' + str(number)

def ancestry(path):
    for parent in reversed(Path(path).parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise Refused('plain_directory_ancestry_required')

def identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns

def safe(value):
    if not isinstance(value, str):
        raise Refused('path_type')
    p = PurePosixPath(value)
    if (not value or value != str(p) or p.is_absolute() or '..' in p.parts or '.' == value
            or '.git' in p.parts or '\\' in value or len(value.encode()) > 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise Refused('relative_path_required')
    return Path(*p.parts)

def file_io(path, row=None, *, destination=None, maximum=128 * 1024**2, monitor=True):
    path = Path(path)
    ancestry(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    out = None
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 <= before.st_size <= maximum:
            raise Refused('regular_file_size_bound')
        if row is not None and before.st_size != row['bytes']:
            raise Refused('input_size_changed')
        if destination is not None:
            ancestry(destination)
            out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        digest, blocks, count = hashlib.sha256(), [], 0
        while True:
            if monitor:
                tick()
            block = os.read(fd, 1024**2)
            if not block:
                break
            count += len(block)
            if count > maximum:
                raise Refused('file_growth_bound')
            digest.update(block)
            if out is not None:
                view = memoryview(block)
                while view:
                    wrote = os.write(out, view)
                    if wrote <= 0:
                        raise Refused('short_copy_write')
                    view = view[wrote:]
            elif row is None:
                blocks.append(block)
        if identity(before) != identity(os.fstat(fd)) or identity(before) != identity(path.lstat()):
            raise Refused('input_changed_during_read')
        sha = digest.hexdigest()
        if count != before.st_size or (row is not None and sha != row['sha256']):
            raise Refused('input_digest_changed')
        if out is not None:
            os.fsync(out)
        return b''.join(blocks) if row is None else {'path': str(path), 'bytes': count, 'sha256': sha}
    finally:
        if out is not None:
            os.close(out)
        os.close(fd)

def json_file(path, *, monitor=False):
    return json.loads(file_io(path, maximum=2 * 1024**2, monitor=monitor))

def write_json(path, value):
    data = (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()
    ancestry(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(data)
        while view:
            wrote = os.write(fd, view)
            if wrote <= 0:
                raise Refused('short_receipt_write')
            view = view[wrote:]
        os.fsync(fd)
    finally:
        os.close(fd)

def census():
    if os.getpgrp() != os.getpid() or PS_PIN is None:
        raise Refused('Root_owned_live_group_required')
    file_io('/bin/ps', PS_PIN, monitor=False)
    child, selector = None, selectors.DefaultSelector()
    data = bytearray()
    try:
        child = subprocess.Popen(['/bin/ps', '-axo', 'pid=,pgid=,rss=,stat='],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=False, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 2
        while child.poll() is None or selector.get_map():
            if time.monotonic() >= deadline:
                raise Refused('census_deadline')
            for key, _ in selector.select(.05):
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                else:
                    data.extend(block)
                    if len(data) > 1024**2:
                        raise Refused('census_output_bound')
        if child.returncode != 0:
            raise Refused('census_failed')
        members, total, root_rows, seen_pids = [], 0, 0, set()
        for line in data.decode('ascii').splitlines():
            parts = line.split()
            if len(parts) != 4 or any(not x.isdecimal() for x in parts[:3]) or not re.fullmatch('[A-Za-z+<>=?-]+', parts[3]):
                raise Refused('census_schema')
            pid, pgid, kib = map(int, parts[:3])
            if pid in seen_pids:
                raise Refused('census_duplicate_PID')
            seen_pids.add(pid)
            if pid == os.getpid():
                if pgid != os.getpid() or kib <= 0 or 'Z' in parts[3]:
                    raise Refused('census_invalid_parent')
                root_rows += 1
            if pgid == os.getpid() and pid != child.pid:
                total += kib * 1024
                if pid != os.getpid() and 'Z' not in parts[3]:
                    members.append(pid)
        if root_rows != 1:
            raise Refused('census_missed_parent')
        return members, total
    finally:
        try:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=.2)
        finally:
            if child is not None and child.stdout is not None:
                child.stdout.close()
            selector.close()

def sample():
    global NEXT_SAMPLE
    try:
        members, total = census()
        t = time.monotonic()
        value = {'at': now(), 'monotonic': t, 'bytes': total, 'owned_children': len(members)}
        if RSS['last_sample'] is not None:
            RSS['maximum_gap_seconds'] = max(RSS['maximum_gap_seconds'], t - RSS['last_sample']['monotonic'])
        RSS['first_sample'] = RSS['first_sample'] or value
        RSS['last_sample'] = value
        RSS['samples'] += 1
        RSS['peak_bytes'] = max(RSS['peak_bytes'], total)
        NEXT_SAMPLE = t + .25
        if total >= RSS_LIMIT:
            RSS['stop_reason'] = 'sampled_owned_RSS_at_or_above_3GiB'
            raise Refused('RSS_limit')
    except Exception as error:
        RSS['monitor_failure'] = type(error).__name__
        raise

def tick():
    if STOP or (DEADLINE is not None and time.monotonic() >= DEADLINE):
        raise Refused(STOP or 'work_deadline')
    if PS_PIN is not None and time.monotonic() >= NEXT_SAMPLE:
        sample()

def cleanup():
    try:
        return cleanup_inner()
    except BaseException as error:
        return {'confirmed_no_group_children': False, 'forced_group_exit_needed': True,
                'cleanup_error_type': type(error).__name__}

def cleanup_inner():
    try:
        if not census()[0]:
            return {'confirmed_no_group_children': True, 'forced_group_exit_needed': False}
    except Exception:
        pass
    os.killpg(os.getpid(), signal.SIGTERM)
    end = time.monotonic() + 5
    while time.monotonic() < end:
        try:
            if not census()[0]:
                return {'confirmed_no_group_children': True, 'forced_group_exit_needed': False, 'term_sent': True}
        except Exception:
            break
        time.sleep(.05)
    return {'confirmed_no_group_children': False, 'forced_group_exit_needed': True, 'term_sent': True}

def pinned_json_role(row, maximum):
    raw = file_io(row['path'], maximum=maximum)
    if len(raw) != row['bytes'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
        raise Refused('native_JSON_role_changed_at_consumption')
    return json.loads(raw)


def verify_janus_input_closure(expected_files, *, allow_generated=False):
    root = JOB / 'janus-wheel-source'
    ancestry(root / '_check')
    before = root.lstat()
    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid():
        raise Refused('owned_Janus_input_root_required')
    expected_directories, children = {''}, {'': set()}
    for name in expected_files:
        path = safe(name)
        parts = path.parts
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            children.setdefault(parent, set()).add(part)
            if index < len(parts) - 1:
                expected_directories.add('/'.join(parts[:index + 1]))
    for name in expected_directories:
        children.setdefault(name, set())
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    key = lambda info: (info.st_dev, info.st_ino, info.st_uid, stat.S_IFMT(info.st_mode))
    generated, count = [], 0
    try:
        if key(before) != key(os.fstat(rootfd)):
            raise Refused('Janus_input_root_changed')
        for directory in sorted(expected_directories):
            fd = os.dup(rootfd)
            try:
                for part in PurePosixPath(directory).parts:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = child
                if os.fstat(fd).st_uid != os.getuid():
                    raise Refused('Janus_input_directory_owner')
                names = set()
                with os.scandir(fd) as listing:
                    for entry in listing:
                        tick()
                        count += 1
                        if count > 10000:
                            raise Refused('Janus_input_entry_bound')
                        name = (directory + '/' if directory else '') + entry.name
                        safe(name)
                        info = entry.stat(follow_symlinks=False)
                        if entry.name in children[directory]:
                            names.add(entry.name)
                            if name in expected_directories:
                                if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                                    raise Refused('Janus_expected_directory_kind_or_owner')
                            elif (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                                  or info.st_uid != os.getuid()):
                                raise Refused('Janus_expected_regular_input_kind_or_owner')
                        elif (allow_generated and directory == ''
                              and entry.name in {'build', 'janus_swi.egg-info'}):
                            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                                    or info.st_mode & 0o7000):
                                raise Refused('Janus_generated_directory_kind_or_owner')
                            generated.append({'path': name, 'device': info.st_dev,
                                              'inode': info.st_ino, 'uid': info.st_uid})
                        else:
                            raise Refused('unlisted_Janus_build_input')
                if names != children[directory]:
                    raise Refused('Janus_declared_input_missing')
            finally:
                os.close(fd)
        if key(root.lstat()) != key(before) or key(os.fstat(rootfd)) != key(before):
            raise Refused('Janus_input_root_changed_after_closure')
        return {'declared_regular_inputs': len(expected_files),
                'generated_directories': sorted(generated, key=lambda row: row['path']),
                'policy': 'Before the first native phase and immediately before Janus: exact declared regular-file/directory closure, no extra input. After successful Janus only: retain the owned build and janus_swi.egg-info directories as opaque fresh build output, without descending or reusing them. Original declared files remain pinned. These directories are outside the runtime bundle; no cleanup or complete residue-inventory claim.'}
    finally:
        os.close(rootfd)


def validated_inputs(args):
    if Path(args.inputs) != BINDING:
        raise Refused('fixed_native_inputs_path')
    raw = file_io(BINDING, maximum=256 * 1024, monitor=False)
    if hashlib.sha256(raw).hexdigest() != args.inputs_sha256:
        raise Refused('native_inputs_pin_changed')
    binding = json.loads(raw)
    if (set(binding) != {'schema', 'source_owner', 'origin_machine', 'job_path', 'roles', 'scope'}
            or binding['schema'] != 'studio-Mac-CI-native-phase-inputs/1'
            or binding['job_path'] != str(JOB)
            or any(type(binding[key]) is not str or not 1 <= len(binding[key]) <= 128
                   for key in ('source_owner', 'origin_machine'))):
        raise Refused('closed_native_input_contract')
    expected = {'worker': SELF, 'python': PYTHON, 'ps': Path('/bin/ps'), 'bash': Path('/bin/bash'),
                'recipe': JOB / 'native-runtime-phases.sh',
                'preparation': JOB / 'CI_PREPARATION_RECEIPT_R1.json',
                'contract': ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json',
                'prepared_inventory': JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json'}
    roles = binding['roles']
    if type(roles) is not dict or set(roles) != set(expected):
        raise Refused('closed_native_roles')
    for name, row in roles.items():
        if (type(row) is not dict or set(row) != {'path', 'bytes', 'sha256'}
                or row['path'] != str(expected[name]) or type(row['bytes']) is not int
                or not 0 < row['bytes'] <= 32 * 1024**2
                or not re.fullmatch('[a-f0-9]{64}', row['sha256'])):
            raise Refused('closed_native_role_pin')
        file_io(row['path'], row, monitor=False)
    if (roles['worker']['sha256'] != args.source_sha256
            or roles['python'] != {'path': sys.executable, **PYTHON_PIN}
            or sys.executable != str(PYTHON)
            or {k: roles['recipe'][k] for k in ('bytes', 'sha256')} != RECIPE_PIN
            or {k: roles['contract'][k] for k in ('bytes', 'sha256')} != CONTRACT_PIN):
        raise Refused('native_canonical_source_or_python_pin')
    preparation = pinned_json_role(roles['preparation'], 2 * 1024**2)
    if (preparation.get('schema') != 'studio-Mac-CI-public-runtime-preparation/2'
            or preparation.get('status') != 'DATA_PREPARATION_ONLY_NO_NATIVE_ACTION'
            or preparation.get('contract_sha256') != CONTRACT_PIN['sha256']):
        raise Refused('exact_preparation_receipt_required')
    return binding


def verify_prepared_inputs(binding, *, allow_generated_janus=False):
    roles = binding['roles']
    contract = pinned_json_role(roles['contract'], 2 * 1024**2)
    inventory = pinned_json_role(roles['prepared_inventory'], 8 * 1024**2)
    roots = {'python': 'bootstrap/python', 'swipl': 'sources/swipl-src',
             'petta': 'OmegaHive.bundle/PeTTa', 'chroma': 'OmegaHive.bundle/petta_lib_chromadb',
             'pcre2': 'sources/pcre2-src'}
    if type(inventory) is not dict or set(inventory) != set(roots):
        raise Refused('closed_prepared_source_inventory')
    patches = {}
    for row in contract['source_patches']:
        rel = 'sources/swipl-src/' + str(safe(row['path']))
        patches[rel] = {'bytes': row['before_bytes'] + len(row['new'].encode()) - len(row['old'].encode()),
                        'sha256': row['after_sha256']}
    row = contract['janus_derivative']
    janus_patch = {'bytes': row['before_bytes'] + len(row['new'].encode()) - len(row['old'].encode()),
                   'sha256': row['after_sha256']}
    count, total, janus_files = 0, 0, 0
    janus_expected = {}
    for label, records in inventory.items():
        if type(records) is not dict or not records:
            raise Refused('prepared_source_records_required')
        for name, pin in records.items():
            safe(name)
            if (type(pin) is not dict or type(pin.get('bytes')) is not int
                    or not 0 <= pin['bytes'] <= 128 * 1024**2
                    or not re.fullmatch('[a-f0-9]{64}', pin.get('sha256', ''))):
                raise Refused('prepared_source_pin_shape')
            relative_name = roots[label] + '/' + name
            expected = patches.get(relative_name, pin)
            count += 1
            total += expected['bytes']
            if count > 50000 or total > 512 * 1024**2:
                raise Refused('prepared_source_global_bound')
            file_io(JOB / relative_name, expected)
            if label == 'swipl' and name.startswith('packages/swipy/'):
                janus_name = name[len('packages/swipy/'):]
                safe(janus_name)
                expected = janus_patch if janus_name == row['path'] else pin
                file_io(JOB / 'janus-wheel-source' / janus_name, expected)
                janus_expected[janus_name] = expected
                janus_files += 1
    if janus_files == 0:
        raise Refused('Janus_Source_inventory_missing')
    janus_closure = verify_janus_input_closure(janus_expected, allow_generated=allow_generated_janus)
    downloads = {}
    for entry in (list(contract['archives'].values()) + list(contract['runtime_wheels'].values())
                  + list(contract['build_tools'].values())):
        name = str(safe(entry['filename']))
        if '/' in name or (name in downloads and downloads[name] != entry):
            raise Refused('closed_download_basename_or_shared_pin')
        downloads[name] = entry
    for name, pin in downloads.items():
        file_io(JOB / 'artifacts' / name, pin)
    for pin in roles.values():
        file_io(pin['path'], pin)
    return {'declared_source_files_verified': count, 'declared_source_bytes_verified': total,
            'Janus_files_verified': janus_files, 'artifact_files_verified': len(downloads),
            'Janus_input_closure': janus_closure,
            'scope': 'Exact declared fresh preparation file bodies and public archive/wheel pins. No prior runtime tree or account configuration walk; not native qualification.'}


def enabled_recipe(binding):
    row = binding['roles']['recipe']
    raw = file_io(row['path'], maximum=64 * 1024)
    if len(raw) != row['bytes'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
        raise Refused('canonical_recipe_changed')
    if raw.count(b'RUN_ENABLED=false\n') != 1:
        raise Refused('single_recipe_enable_literal_required')
    enabled = raw.replace(b'RUN_ENABLED=false\n', b'RUN_ENABLED=true\n')
    path = JOB / 'native-runtime-phases.enabled.sh'
    ancestry(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(enabled)
        while view:
            tick()
            count = os.write(fd, view)
            if count <= 0:
                raise Refused('enabled_recipe_short_write')
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, 0o500)
    finally:
        os.close(fd)
    pin = {'path': str(path), 'bytes': len(enabled), 'sha256': hashlib.sha256(enabled).hexdigest()}
    file_io(path, pin)
    return pin


def main():
    global DEADLINE, PS_PIN
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--inputs-sha256', required=True)
    parser.add_argument('--source-sha256', required=True)
    args = parser.parse_args()
    if (RUN_ENABLED is not True or not sys.flags.isolated or not sys.flags.no_site
            or not sys.dont_write_bytecode or sys.flags.optimize):
        raise Refused('DISABLED_or_nonisolated_native_worker')
    started = time.monotonic()
    DEADLINE = started + WHOLE - RESERVE
    binding = validated_inputs(args)
    if os.getpgrp() != os.getpid() or os.uname().machine != 'arm64':
        raise Refused('Root_owned_arm64_group_required')
    ancestry(JOB / '_check')
    info = JOB.lstat()
    if (JOB != JOB.resolve() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise Refused('owned_private_native_job_required')
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    os.umask(0o077)
    PS_PIN = binding['roles']['ps']
    ancestry(OUTPUT)
    OUTPUT.mkdir(exist_ok=True, mode=0o700)
    ancestry(OUTPUT / '_check')
    attempt = OUTPUT / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:12])
    attempt.mkdir(mode=0o700)
    state = {'schema': 'studio-Mac-CI-native-phase-result/1', 'status': 'started',
             'source_owner': binding['source_owner'], 'origin_machine': binding['origin_machine'],
             'started_at': now(), 'job_manifest_sha256': args.inputs_sha256,
             'worker_pid': os.getpid(), 'worker_pgid': os.getpgrp(),
             'worker_source_sha256': args.source_sha256, 'commands': [], 'rss': RSS}
    force, receipt = False, None
    try:
        sample()
        if census()[0]:
            raise Refused('initial_native_group_not_clean')
        state['prepared_input_verification'] = verify_prepared_inputs(binding)
        recipe = enabled_recipe(binding)
        state['canonical_recipe'] = binding['roles']['recipe']
        state['executed_recipe'] = recipe
        environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
            'HOME': str(JOB / 'empty-home'), 'TMPDIR': str(JOB / 'tmp'), 'LANG': 'C', 'LC_ALL': 'C',
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
            'PIP_CONFIG_FILE': '/dev/null', 'PIP_NO_INDEX': '1', 'PIP_DISABLE_PIP_VERSION_CHECK': '1',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_CONFIG_COUNT': '0', 'GIT_TERMINAL_PROMPT': '0',
            'MACOSX_DEPLOYMENT_TARGET': '15.0', 'HF_HUB_OFFLINE': '1',
            'TRANSFORMERS_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1', 'OMP_NUM_THREADS': '2'}
        completed = []
        for name in PHASES:
            if name == 'janus':
                state['immediate_Janus_input_preflight'] = verify_prepared_inputs(binding)
            for pin in binding['roles'].values():
                file_io(pin['path'], pin)
            file_io(recipe['path'], recipe)
            if census()[0]:
                raise Refused('native_group_not_clean_before_phase')
            log = attempt / (name + '.log')
            phase = {'phase': name, 'argv': ['/bin/bash', recipe['path'], name], 'started_at': now()}
            state['commands'].append(phase)
            process = None
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                process = subprocess.Popen(phase['argv'], cwd=JOB, env=environment,
                    stdin=subprocess.DEVNULL, stdout=fd, stderr=subprocess.STDOUT,
                    close_fds=True, start_new_session=False)
                while process.poll() is None:
                    tick()
                    if os.fstat(fd).st_size > LOG_LIMIT:
                        raise Refused('native_phase_log_bound')
                    time.sleep(.05)
                drain = min(DEADLINE, time.monotonic() + .5)
                while time.monotonic() < drain and census()[0]:
                    tick()
                    time.sleep(.05)
            finally:
                os.close(fd)
                try:
                    sample()
                finally:
                    clean = cleanup()
                    force |= clean['forced_group_exit_needed']
                    phase['cleanup'] = clean
                    if process is not None:
                        try:
                            phase['exit'] = process.wait(timeout=.2)
                        except subprocess.TimeoutExpired:
                            phase['exit'] = None
                    phase['finished_at'] = now()
                    info = log.lstat()
                    phase['log'] = {'path': log.name, 'bytes': info.st_size, 'sha256': None,
                                    'over_limit': info.st_size > LOG_LIMIT}
                    if not stat.S_ISREG(info.st_mode):
                        raise Refused('native_log_regular_file_required')
                    if info.st_size <= LOG_LIMIT:
                        raw = file_io(log, maximum=LOG_LIMIT, monitor=False)
                        phase['log']['sha256'] = hashlib.sha256(raw).hexdigest()
                    else:
                        phase['log']['retention'] = 'oversized_raw_file_retained_metadata_only'
            if phase['log']['over_limit'] or force or STOP or phase.get('exit') != 0:
                raise Refused('native_phase_failed_retained_no_retry')
            completed.append(name)
        state['prepared_input_postverification'] = verify_prepared_inputs(binding, allow_generated_janus=True)
        file_io(recipe['path'], recipe)
        receipt = {'schema': 'studio-Mac-CI-native-phase-completion/1',
            'status': 'ALL_REQUIRED_NATIVE_PHASES_COMPLETE', 'native_action': True,
            'source_owner': binding['source_owner'], 'origin_machine': binding['origin_machine'],
            'job_path': str(JOB), 'completed_phases': completed, 'commands': state['commands'],
            'inputs_sha256': args.inputs_sha256, 'canonical_recipe': binding['roles']['recipe'],
            'executed_recipe': recipe, 'preparation': binding['roles']['preparation'],
            'contract': binding['roles']['contract'],
            'qualification': 'Native build and offline dependency installation only. Separate owner finalization, native audit, relocation, runtime seal, UI and DMG/app qualification remain required.'}
        state['status'] = 'passed'
    except BaseException as error:
        state.update(status='failed_retained_no_retry', error_type=type(error).__name__, reason=str(error))
    finally:
        try:
            try:
                sample()
            except BaseException as error:
                state.update(status='failed_retained_no_retry', final_sample_error=type(error).__name__)
            clean = cleanup()
            force |= clean['forced_group_exit_needed']
            state.update(final_cleanup=clean, forced_group_exit_needed=force,
                         finished_at=now(), elapsed_seconds=time.monotonic() - started)
            if STOP or force or clean.get('term_sent') or state['elapsed_seconds'] >= WHOLE:
                state['status'] = 'failed_retained_no_retry'
            if state['status'] == 'passed' and receipt is not None:
                write_json(JOB / 'receipts/native-phases-r1.json', receipt)
            write_json(attempt / 'NATIVE_BUILD_RESULT_R1.json', state)
            print(json.dumps({'status': state['status'], 'result': str(attempt / 'NATIVE_BUILD_RESULT_R1.json')}), flush=True)
        finally:
            if force:
                os.killpg(os.getpid(), signal.SIGKILL)
    return 0 if state['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'INVOCATION_OR_RECEIPT_FAILURE_RETAINED', 'error_type': type(error).__name__}), flush=True)
        raise SystemExit(64)
