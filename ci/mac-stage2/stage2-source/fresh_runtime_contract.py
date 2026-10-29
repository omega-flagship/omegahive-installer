"""Fresh CI runtime evidence contract. Pure validation; never runs native tools.

Receipt schema validation does not create evidence. Actual admitted producers
must supply the pinned same-job build, finalization, audit and relocation facts.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import re


CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
COMPONENTS = {'python', 'swipl', 'node', 'lib', 'PeTTa', 'petta_lib_chromadb', 'manifests'}
PHASES = ['tools', 'python', 'node', 'pcre', 'configure', 'build', 'install', 'deps', 'janus']
CHECKS = {'macho_arm64', 'macho_dependencies', 'macho_rpaths', 'python_core_imports',
          'node_version', 'swipl_version', 'janus_bridge', 'petta_eval'}
SHA = re.compile('[a-f0-9]{64}')
STATUS = 'SEALED_WITH_FRESH_NATIVE_AND_RELOCATION_EVIDENCE'
QUALIFICATION = 'Native runtime input checks only; application, browser, installer and release qualification remain separate.'


class RuntimeRefused(RuntimeError):
    pass


def need(condition, reason):
    if not condition:
        raise RuntimeRefused(reason)


def relative(name):
    need(type(name) is str and 0 < len(name.encode()) <= 1024, 'runtime_relative_path_type')
    path = PurePosixPath(name)
    need(not path.is_absolute() and str(path) == name and name != '.' and '..' not in path.parts
         and '\\' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name),
         'runtime_relative_path_required')
    return path


def content_inventory_sha256(files):
    """Portable content/link identity; permission sealing and inodes excluded."""
    need(type(files) is list and 0 < len(files) <= 100000, 'bounded_runtime_file_vector')
    seen, total, values = set(), 0, []
    for row in files:
        need(type(row) is dict, 'runtime_row_object_required')
        path = relative(row.get('path'))
        name = str(path)
        need(name not in seen and path.parts[0] in COMPONENTS, 'duplicate_or_nonruntime_path')
        seen.add(name)
        kind = row.get('kind')
        item = {'path': name, 'kind': kind}
        if kind == 'file':
            need(type(row.get('bytes')) is int and 0 <= row['bytes'] <= 1024**3
                 and type(row.get('sha256')) is str and SHA.fullmatch(row['sha256']),
                 'runtime_file_byte_pin')
            total += row['bytes']
            need(total <= 3 * 1024**3, 'runtime_total_byte_bound')
            item.update(bytes=row['bytes'], sha256=row['sha256'])
        elif kind == 'symlink':
            target = row.get('target')
            need(type(target) is str and 0 < len(target) <= 4096 and not target.startswith('/')
                 and '\x00' not in target and '\\' not in target, 'relative_runtime_link_required')
            item['target'] = target
        else:
            need(kind == 'directory', 'runtime_kind_required')
        values.append(item)
    need({PurePosixPath(name).parts[0] for name in seen} == COMPONENTS, 'seven_runtime_components_required')
    roots = {row['path']: row['kind'] for row in values if '/' not in row['path']}
    need(set(roots) == COMPONENTS and all(kind == 'directory' for kind in roots.values()),
         'seven_runtime_directory_roots_required')
    raw = json.dumps(sorted(values, key=lambda row: row['path']), sort_keys=True,
                     separators=(',', ':'), ensure_ascii=True).encode()
    return hashlib.sha256(raw).hexdigest()


def pin_shape(pin, *, path=None, maximum=32 * 1024**2):
    need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
         and type(pin.get('path')) is str and Path(pin['path']).is_absolute()
         and str(Path(pin['path'])) == pin['path'] and '..' not in Path(pin['path']).parts
         and type(pin.get('bytes')) is int and 0 < pin['bytes'] <= maximum
         and type(pin.get('sha256')) is str and SHA.fullmatch(pin['sha256']), 'exact_evidence_pin_required')
    if path is not None:
        need(pin['path'] == str(path), 'fixed_evidence_path_required')
    return pin


def read_pinned_json(pin, reader):
    pin_shape(pin)
    raw = reader(pin)
    need(type(raw) is bytes and len(raw) == pin['bytes']
         and hashlib.sha256(raw).hexdigest() == pin['sha256'], 'held_evidence_pin_mismatch')
    value = json.loads(raw)
    need(type(value) is dict, 'evidence_object_required')
    return value


def checks_passed(receipt, expected):
    checks = receipt.get('checks')
    need(type(checks) is dict and set(checks) == expected, 'exact_runtime_check_matrix_required')
    for name, check in checks.items():
        need(type(check) is dict and check.get('status') == 'passed'
             and type(check.get('exit')) is int and check['exit'] == 0
             and check.get('worker_reaped') is True and check.get('group_absent') is True
             and check.get('signals') == [] and 'guard_error' in check and check['guard_error'] is None,
             'runtime_check_not_cleanly_complete:' + name)


def verify_evidence(evidence, content_sha256, reader):
    job = CI_ROOT / 'runtime-job'
    keys = {'native_phases', 'native_parent', 'finalization', 'finalizer_admission',
            'native_audit', 'relocation'}
    need(type(evidence) is dict and set(evidence) == keys, 'closed_fresh_runtime_evidence_roles')
    fixed = {'native_phases': job / 'receipts/native-phases-r1.json',
             'finalization': job / 'receipts/finalization_r1.json',
             'finalizer_admission': job / 'receipts/finalizer-admission-r1.json',
             'native_audit': job / 'receipts/runtime-native-audit-r1.json',
             'relocation': job / 'receipts/runtime-relocation-r1.json'}
    for name, pin in evidence.items():
        pin_shape(pin, path=fixed.get(name))
    parent_path = Path(evidence['native_parent']['path'])
    need(parent_path.parent.parent == CI_ROOT / 'native-parent'
         and parent_path.name == 'PARENT_RESULT.json'
         and re.fullmatch('attempt-[a-f0-9]{32}', parent_path.parent.name), 'native_parent_namespace_required')
    values = {name: read_pinned_json(pin, reader) for name, pin in evidence.items()}
    native, parent, final = (values[name] for name in ('native_phases', 'native_parent', 'finalization'))
    need(native.get('schema') == 'studio-Mac-CI-native-phase-completion/1'
         and native.get('status') == 'ALL_REQUIRED_NATIVE_PHASES_COMPLETE'
         and native.get('native_action') is True and native.get('completed_phases') == PHASES
         and native.get('job_path') == str(job), 'fresh_native_phase_completion_required')
    commands = native.get('commands')
    need(type(commands) is list and len(commands) == len(PHASES), 'native_command_history_required')
    for command, name in zip(commands, PHASES):
        need(type(command) is dict and command.get('phase') == name
             and type(command.get('exit')) is int and command['exit'] == 0
             and command.get('cleanup', {}).get('confirmed_no_group_children') is True
             and command.get('cleanup', {}).get('forced_group_exit_needed') is False
             and not command.get('cleanup', {}).get('term_sent'), 'native_phase_not_clean:' + name)
    need(parent.get('schema') == 'studio-Mac-CI-Root-native-parent/1'
         and parent.get('status') == 'worker_exit0' and type(parent.get('worker_exit')) is int
         and parent['worker_exit'] == 0 and parent.get('cleanup', {}).get('worker_reaped') is True
         and parent.get('cleanup', {}).get('group_absent') is True
         and parent.get('cleanup', {}).get('signals') == [] and parent.get('finalization_errors') == []
         and parent.get('worker_receipt') == evidence['native_phases'], 'linked_clean_native_parent_required')
    inputs = parent.get('inputs')
    pin_shape(inputs, path=CI_ROOT / 'native-source/NATIVE_BUILD_INPUTS_R1.json', maximum=256 * 1024)
    need(native.get('inputs_sha256') == inputs['sha256'], 'native_parent_inputs_chain_required')
    need(final.get('schema') == 'omegahive-ci-runtime-finalization/1'
         and final.get('status') == 'FINALIZED_BUNDLE_DERIVATIVE_ONLY'
         and final.get('job_path') == str(job) and final.get('bundle_components') == sorted(COMPONENTS)
         and final.get('owner_admission') == {key: evidence['finalizer_admission'][key] for key in ('bytes', 'sha256')}
         and final.get('evidence_pins', {}).get('native_phases') == {
             key: evidence['native_phases'][key] for key in ('bytes', 'sha256')}, 'fresh_finalization_chain_required')
    inventory = final.get('component_inventory')
    need(type(inventory) is dict and 0 < len(inventory) <= 100000, 'finalized_runtime_inventory_required')
    final_files = []
    for name, row in inventory.items():
        need(type(row) is dict and 'path' not in row, 'finalization_inventory_row_shape')
        final_files.append(dict(row, path=name))
    need(content_inventory_sha256(final_files) == content_sha256,
         'finalization_and_audited_runtime_content_differ')
    admission = values['finalizer_admission']
    need(admission.get('status') == 'OWNER_ADMITTED_FINALIZATION'
         and admission.get('job_path') == str(job)
         and type(admission.get('candidate_source_sha256')) is str
         and SHA.fullmatch(admission['candidate_source_sha256']), 'finalizer_admission_required')
    identity = final.get('job_identity')
    admission_identity = admission.get('job_identity')
    need(type(identity) is list and len(identity) == 4
         and all(type(value) is int for value in identity)
         and identity[0] >= 0 and identity[1] > 0 and identity[2] > 0 and identity[3] == 0o700
         and type(admission_identity) is list and len(admission_identity) == 4
         and all(type(value) is int for value in admission_identity)
         and admission_identity == identity, 'finalization_admission_job_identity_required')
    for name, schema, status, checks in (
            ('native_audit', 'studio-Mac-CI-native-audit/1', 'NATIVE_RUNTIME_CHECKS_PASS', CHECKS),
            ('relocation', 'studio-Mac-CI-runtime-relocation/1', 'RELOCATED_RUNTIME_CHECKS_PASS', CHECKS | {'copy_manifest'})):
        receipt = values[name]
        need(receipt.get('schema') == schema and receipt.get('status') == status
             and receipt.get('source_bundle_root') == str(job / 'OmegaHive.bundle')
             and receipt.get('content_inventory_sha256') == content_sha256
             and receipt.get('finalization_receipt_sha256') == evidence['finalization']['sha256']
             and receipt.get('native_phase_receipt_sha256') == evidence['native_phases']['sha256'],
             'same_fresh_runtime_audit_required:' + name)
        checks_passed(receipt, checks)
    relocated = values['relocation'].get('relocated_bundle_root')
    need(type(relocated) is str and Path(relocated).is_absolute() and str(Path(relocated)) == relocated
         and Path(relocated).is_relative_to(CI_ROOT / 'runtime-relocation-attempts')
         and Path(relocated).name == 'OmegaHive.bundle'
         and '..' not in Path(relocated).parts and relocated != str(job / 'OmegaHive.bundle')
         and values['relocation'].get('fresh_output_created') is True,
         'fresh_distinct_relocation_namespace_required')
    return values


def validate_manifest(value, root, reader):
    fields = {'schema', 'status', 'root', 'source_owner', 'origin_machine', 'components',
              'files', 'content_inventory_sha256', 'evidence', 'qualification'}
    need(type(value) is dict and set(value) == fields
         and value.get('schema') == 'studio-Mac-CI-runtime-input/1' and value.get('status') == STATUS
         and value.get('root') == str(root) == str(CI_ROOT / 'runtime-job/OmegaHive.bundle')
         and value.get('components') == sorted(COMPONENTS) and value.get('qualification') == QUALIFICATION
         and all(type(value.get(key)) is str and 1 <= len(value[key]) <= 128
                 for key in ('source_owner', 'origin_machine')), 'fresh_sealed_runtime_manifest_required')
    content = content_inventory_sha256(value['files'])
    need(value.get('content_inventory_sha256') == content, 'runtime_content_vector_changed')
    for row in value['files']:
        mode = row.get('mode')
        need(type(mode) is str and re.fullmatch('[0-7]{4}', mode), 'complete_runtime_mode_vector_required')
        if row['kind'] == 'directory':
            need(mode == '0500', 'sealed_runtime_directory_mode')
        elif row['kind'] == 'file':
            need(mode in {'0400', '0500'} and type(row.get('executable')) is bool
                 and row['executable'] == (mode == '0500'), 'sealed_runtime_file_mode')
    return verify_evidence(value['evidence'], content, reader)
