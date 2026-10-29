"""Disabled data-only seal of an actually audited fresh CI runtime.

No subprocess, native tool, package import or network path is used. Pinned
build/finalization/audit/relocation receipts are required, never synthesized.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import time


ROOT = Path('/private/tmp/omegahive-ci-r12')
HERE = ROOT / 'stage2-source'
JOB = ROOT / 'runtime-job'
BUNDLE = JOB / 'OmegaHive.bundle'
INPUTS = HERE / 'SEAL_INPUTS_R1.json'
ADMISSION = JOB / 'receipts/runtime-seal-admission-r1.json'
OUTPUT = JOB / 'receipts/sealed-runtime-input-r1.json'
RESULT = JOB / 'receipts/runtime-seal-result-r1.json'
PYTHON = JOB / 'bootstrap/python/bin/python3.12'
SEAL_ENABLED = False
EXPECTED_UID = None
PACKAGE_PIN = {'bytes': 24785, 'sha256': 'fd70211ac0ead5974ebc39e4be0c57a193eb770579eb0d88ca54f61d067ffe4d'}
CONTRACT_PIN = {'bytes': 12637, 'sha256': '2dade1e85f653b733f2a4111bd9428d79f8a86a1b352202671ec7dc6ee9dac5c'}
PYTHON_PIN = {'bytes': 18652104, 'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
START = time.monotonic()


class Refused(RuntimeError):
    pass


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def tick():
    need(time.monotonic() - START < 900, 'seal_data_deadline')


def key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def open_parent(path):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path))
         and '..' not in path.parts, 'canonical_seal_path_required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            tick()
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, path.name
    except BaseException:
        os.close(fd)
        raise


def read_file(path, expected=None, maximum=32 * 1024**2):
    parent, name = open_parent(path)
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == EXPECTED_UID
             and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'owned_bounded_seal_input')
        raw, digest = bytearray(), hashlib.sha256()
        while True:
            tick()
            block = os.read(fd, 65536)
            if not block:
                break
            raw.extend(block)
            need(len(raw) <= maximum, 'seal_input_growth')
            digest.update(block)
        need(len(raw) == before.st_size and key(before) == key(os.fstat(fd))
             == key(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'seal_input_changed_during_read')
        pin = {'path': str(path), 'bytes': len(raw), 'sha256': digest.hexdigest()}
        if expected is not None:
            need(all(pin[field] == expected[field] for field in ('bytes', 'sha256')), 'seal_input_pin_mismatch')
        return bytes(raw), pin
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def write_new_json(path, value):
    raw = (json.dumps(value, indent=2, allow_nan=False) + '\n').encode()
    need(len(raw) <= 32 * 1024**2, 'seal_output_byte_bound')
    parent, name = open_parent(path)
    fd = None
    try:
        info = os.fstat(parent)
        need(info.st_uid == EXPECTED_UID and stat.S_IMODE(info.st_mode) == 0o700,
             'private_owned_receipt_directory_required')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        view = memoryview(raw)
        while view:
            tick()
            count = os.write(fd, view)
            need(count > 0, 'seal_output_short_write')
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, 0o400)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)
    return read_file(path, {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})[1]


def load_pinned_helper(name, expected):
    path = HERE / name
    raw, _pin = read_file(path, expected, maximum=128 * 1024)
    namespace = {'__name__': 'owner_admitted_seal_helper', '__file__': str(path)}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace


def initial_rows(final, package):
    inventory = final.get('component_inventory')
    need(type(inventory) is dict and 0 < len(inventory) <= 100000, 'finalized_inventory_required')
    rows, identities = [], {}
    for name, record in sorted(inventory.items()):
        tick()
        package['relative'](name)
        need(type(record) is dict and record.get('kind') in {'file', 'directory', 'symlink'},
             'finalized_entry_kind')
        with package['parent_fd'](BUNDLE, name) as (parent, leaf):
            info = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            need(info.st_uid == EXPECTED_UID and not info.st_mode & 0o7000,
                 'runtime_entry_owner_or_special_mode')
            identities[name] = key(info)
            row = {'path': name, 'kind': record['kind'], 'mode': f'{stat.S_IMODE(info.st_mode):04o}'}
            if record['kind'] == 'file':
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'runtime_regular_singlelink_required')
                need(type(record.get('mode')) is int and record['mode'] == stat.S_IMODE(info.st_mode),
                     'finalized_file_mode_changed')
                row.update(bytes=record['bytes'], sha256=record['sha256'], executable=bool(info.st_mode & 0o111))
            elif record['kind'] == 'directory':
                need(stat.S_ISDIR(info.st_mode) and type(record.get('mode')) is int
                     and record['mode'] == stat.S_IMODE(info.st_mode), 'finalized_directory_mode_changed')
            else:
                need(stat.S_ISLNK(info.st_mode) and os.readlink(leaf, dir_fd=parent) == record['target'],
                     'finalized_runtime_link_changed')
                row['target'] = record['target']
            rows.append(row)
    package['verify_tree'](BUNDLE, {'files': rows})
    return rows, identities


def seal_modes(rows, identities, package):
    sealed = []
    for original in rows:
        tick()
        row = dict(original)
        if row['kind'] == 'symlink':
            sealed.append(row)
            continue
        row['mode'] = '0500' if row['kind'] == 'directory' or row.get('executable') else '0400'
        sealed.append(row)
    ordered = [row for row in sealed if row['kind'] == 'file']
    ordered += sorted((row for row in sealed if row['kind'] == 'directory'),
                      key=lambda row: (row['path'].count('/'), row['path']), reverse=True)
    for row in ordered:
        tick()
        with package['parent_fd'](BUNDLE, row['path']) as (parent, leaf):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if row['kind'] == 'directory':
                flags |= os.O_DIRECTORY
            fd = os.open(leaf, flags, dir_fd=parent)
            try:
                need(key(os.fstat(fd)) == identities[row['path']], 'runtime_identity_changed_before_mode_seal')
                os.fchmod(fd, int(row['mode'], 8))
            finally:
                os.close(fd)
    with package['directory_fd'](BUNDLE) as fd:
        need(os.fstat(fd).st_uid == EXPECTED_UID, 'runtime_root_owner_changed')
        os.fchmod(fd, 0o500)
    package['verify_tree'](BUNDLE, {'files': sealed})
    return sealed


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--inputs-sha256', required=True)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--admission-bytes', required=True, type=int)
    parser.add_argument('--admission-sha256', required=True)
    args = parser.parse_args()
    need(SEAL_ENABLED is True and type(EXPECTED_UID) is int and EXPECTED_UID > 0
         and os.getuid() == os.geteuid() == EXPECTED_UID and sys.platform == 'darwin'
         and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
         and not sys.flags.optimize and sys.executable == str(PYTHON)
         and Path(__file__).absolute() == HERE / 'seal_runtime.py' and Path.cwd() == ROOT,
         'DISABLED_or_unbound_runtime_seal')
    need(all(re.fullmatch('[a-f0-9]{64}', value) for value in
             (args.inputs_sha256, args.source_sha256, args.admission_sha256))
         and 0 < args.admission_bytes <= 65536, 'explicit_seal_Source_input_admission_pins')
    _raw, source_pin = read_file(__file__, maximum=128 * 1024)
    need(source_pin['sha256'] == args.source_sha256, 'seal_source_changed')
    _raw, _pin = read_file(PYTHON, PYTHON_PIN)
    raw, input_pin = read_file(INPUTS, maximum=1024**2)
    need(input_pin['sha256'] == args.inputs_sha256, 'seal_input_changed')
    inputs = json.loads(raw)
    need(set(inputs) == {'schema', 'source_owner', 'origin_machine', 'job_path', 'roles', 'scope'}
         and inputs['schema'] == 'studio-Mac-CI-runtime-seal-inputs/1'
         and inputs['job_path'] == str(JOB), 'closed_runtime_seal_inputs')
    for name in ('source_owner', 'origin_machine'):
        need(type(inputs[name]) is str and 1 <= len(inputs[name]) <= 128, 'concrete_execution_attribution')
    package = load_pinned_helper('package_inputs.py', PACKAGE_PIN)
    contract = load_pinned_helper('fresh_runtime_contract.py', CONTRACT_PIN)
    with package['directory_fd'](ROOT) as fd:
        info = os.fstat(fd)
        need(info.st_uid == EXPECTED_UID and stat.S_IMODE(info.st_mode) == 0o700, 'private_CI_root_required')
    with package['directory_fd'](JOB) as fd:
        info = os.fstat(fd)
        need(info.st_uid == EXPECTED_UID and stat.S_IMODE(info.st_mode) == 0o700, 'private_CI_job_required')
        job_identity = [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]
    raw, admission_pin = read_file(ADMISSION, {'bytes': args.admission_bytes, 'sha256': args.admission_sha256}, 65536)
    admission = json.loads(raw)
    admission_identity = admission.get('job_identity')
    need(type(admission_identity) is list and len(admission_identity) == 4
         and all(type(value) is int for value in admission_identity)
         and admission.get('status') == 'OWNER_ADMITTED_RUNTIME_SEAL'
         and admission.get('candidate_source_sha256') == args.source_sha256
         and admission.get('inputs_sha256') == args.inputs_sha256
         and admission.get('job_path') == str(JOB) and admission_identity == job_identity
         and admission.get('execution_owner') == inputs['source_owner']
         and admission.get('origin_machine') == inputs['origin_machine'], 'owner_seal_admission_mismatch')
    for name in ('source_review_sha256', 'resource_advice_sha256', 'current_tasks_sha256'):
        need(type(admission.get(name)) is str and re.fullmatch('[a-f0-9]{64}', admission[name]),
             'owner_review_resource_task_attestation_required')
    need(not os.path.lexists(OUTPUT) and not os.path.lexists(RESULT), 'fresh_exclusive_seal_outputs_required')
    def reader(pin):
        return read_file(pin['path'], pin)[0]
    final_pin = inputs['roles'].get('finalization')
    contract['pin_shape'](final_pin, path=JOB / 'receipts/finalization_r1.json')
    final = contract['read_pinned_json'](final_pin, reader)
    final_identity = final.get('job_identity')
    need(type(final_identity) is list and len(final_identity) == 4
         and all(type(value) is int for value in final_identity)
         and final_identity == job_identity, 'finalization_current_job_identity_required')
    rows, identities = initial_rows(final, package)
    content = contract['content_inventory_sha256'](rows)
    contract['verify_evidence'](inputs['roles'], content, reader)
    write_new_json(JOB / 'receipts/runtime-seal-started-r1.json',
                   {'source': source_pin, 'inputs': input_pin, 'owner_admission': admission_pin,
                    'content_inventory_sha256': content, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    changed = False
    try:
        changed = True
        sealed = seal_modes(rows, identities, package)
        manifest = {'schema': 'studio-Mac-CI-runtime-input/1', 'status': contract['STATUS'],
                    'root': str(BUNDLE), 'source_owner': inputs['source_owner'],
                    'origin_machine': inputs['origin_machine'], 'components': sorted(contract['COMPONENTS']),
                    'files': sealed, 'content_inventory_sha256': content,
                    'evidence': inputs['roles'], 'qualification': contract['QUALIFICATION']}
        contract['validate_manifest'](manifest, str(BUNDLE), reader)
        output_pin = write_new_json(OUTPUT, manifest)
        result = {'schema': 'studio-Mac-CI-runtime-seal-result/1', 'status': 'SEALED_DATA_INPUT_ONLY',
                  'source': source_pin, 'inputs': input_pin, 'admission': admission_pin,
                  'output': output_pin, 'job_identity': job_identity,
                  'native_commands_run_by_sealer': False, 'runtime_root_mode': '0500',
                  'qualification': contract['QUALIFICATION']}
    except BaseException as error:
        result = {'schema': 'studio-Mac-CI-runtime-seal-result/1', 'status': 'FAILED_RETAINED_NO_RETRY',
                  'mode_mutation_started': changed, 'error_type': type(error).__name__,
                  'reason': str(error), 'source': source_pin, 'inputs': input_pin,
                  'scope': 'Partial mode changes and all evidence retained; no retry or runtime admission.'}
    write_new_json(RESULT, result)
    print(json.dumps({'status': result['status'], 'result': str(RESULT)}), flush=True)
    return 0 if result['status'] == 'SEALED_DATA_INPUT_ONLY' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'REFUSED_OR_RECEIPT_FAILURE_RETAINED', 'error_type': type(error).__name__}), flush=True)
        raise SystemExit(64)
