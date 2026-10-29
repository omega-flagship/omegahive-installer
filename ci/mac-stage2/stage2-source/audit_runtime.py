"""Owner-admitted bounded audit logic for a fresh macOS native runtime bundle.

No process is created by this module. All execution is delegated to the
injected owner-reviewed process_runner protocol below. Actual owner/tool facts and all ten frozen Source roles must be externally
bound and independently reviewed; no runtime Source review is synthesized.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time


CI_ROOT = Path('/private/tmp/omegahive-ci-r12')
JOB = CI_ROOT / 'runtime-job'
ORIGINAL_BUNDLE = JOB / 'OmegaHive.bundle'
RELOCATION_ROOT = CI_ROOT / 'runtime-relocation-attempts'
NATIVE_INPUTS_PATH = CI_ROOT / 'native-source/NATIVE_BUILD_INPUTS_R1.json'
OWNER_ADMISSION_PATH = CI_ROOT / 'native-source/NATIVE_AUDIT_ADMISSION_R1.json'
TASK_ADMISSION_PATH = CI_ROOT / 'native-source/NATIVE_AUDIT_TASK_ADMISSION_R1.json'
RESOURCE_ADMISSION_PATH = CI_ROOT / 'native-source/NATIVE_AUDIT_RESOURCE_ADMISSION_R1.json'
RELOCATION_OWNER_ADMISSION_PATH = CI_ROOT / 'native-source/RELOCATION_AUDIT_ADMISSION_R1.json'
RELOCATION_TASK_ADMISSION_PATH = CI_ROOT / 'native-source/RELOCATION_AUDIT_TASK_ADMISSION_R1.json'
RELOCATION_RESOURCE_ADMISSION_PATH = CI_ROOT / 'native-source/RELOCATION_AUDIT_RESOURCE_ADMISSION_R1.json'
SOURCE_PATH = CI_ROOT / 'stage2-source/audit_runtime.py'
STAGE2_SOURCE_REVIEW_PATH = CI_ROOT / 'stage2-source/STATIC_STAGE2_SOURCE_REVIEW.json'
STAGE2_SOURCE_ROLES = {
    'audit_runtime': 'stage2-source/audit_runtime.py',
    'finalize_runtime': 'stage2-source/finalize_runtime.py',
    'copy_runtime': 'stage2-source/copy_runtime.py',
    'seal_runtime': 'stage2-source/seal_runtime.py',
    'stage2_entry': 'stage2-source/stage2_entry.py',
    'audit_process_runner': 'stage2-parent/audit_process_runner.py',
    'fresh_runtime_contract': 'stage2-source/fresh_runtime_contract.py',
    'package_inputs': 'stage2-source/package_inputs.py',
    'resource_guide': 'project_graph/resources.py',
    'resource_policy': 'project_graph/resource-policy.json',
}
RECEIPTS = JOB / 'receipts'
COMPONENTS = frozenset({
    'python', 'swipl', 'node', 'lib', 'PeTTa', 'petta_lib_chromadb', 'manifests',
})
PHASES = ('tools', 'python', 'node', 'pcre', 'configure', 'build', 'install', 'deps', 'janus')
CHECKS = frozenset({
    'macho_arm64', 'macho_dependencies', 'macho_rpaths', 'python_core_imports',
    'node_version', 'swipl_version', 'janus_bridge', 'petta_eval',
})
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
EXPECTED_NODE_VERSION = 'v24.22.0'
EXPECTED_SWIPL_VERSION = 'SWI-Prolog version 10.1.14'
EXPECTED_PYTHON_VERSION = '3.12.15'
CORE_IMPORTS = ('fastapi', 'starlette', 'httpx', 'uvicorn', 'pytest')
PETTA_PROGRAM = b'(= (f $x) (+ $x 1))\n!(f 41)\n'
PETTA_PROGRAM_SHA256 = 'c9c07e098325bf340ec8f2fb0d7fd1fa53a3ceda8bc3de012ba9efcd8e6f17dd'
PETTA_SCRIPT_PIN = {'path': 'PeTTa/run.sh', 'bytes': 326,
                    'sha256': 'b0ee9930c7fbca5d221ff2e31a7cce30bc8e8902f463c5f80be2a971414e3aae'}
EXPECTED_UPSTREAM_FINALIZER_REFERENCE_SHA256 = '20fbf3744318f4866884366f88809b1931a4fcf6d26fa583b8e7e20d92eea54a'
FINALIZER_R4_SHA256 = 'dd0268e92cc79feb2695b68e845bb40155a3ac3eed58b9ed1ea576b17281aa9d'
PREPARATION_R6_MANIFEST_SHA256 = '512fb886e716d2d8bd6f6796e7436dfa0a2bd47d2485919d8ad4346d01f07be7'
PREPARATION_R6_MANIFEST_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/studio/20261028/mac-ci-runtime-preparation-source-root-r6/REVIEW_MANIFEST_R6.json',
    'bytes': 2501,
    'sha256': PREPARATION_R6_MANIFEST_SHA256}
NATIVE_WORKER_R2_PIN = {'path': str(CI_ROOT / 'native-source/ci_native_worker.py'),
                        'bytes': 29155,
                        'sha256': '9184ce506a6be23537743f6197683f937dae37ac6697956946bd2aea35327264'}
NATIVE_WORKER_R2_REVIEW_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/studio/20261028/mac-ci-native-controller-source-root-r2/ci_native_worker.py',
    'bytes': 29155,
    'sha256': '9184ce506a6be23537743f6197683f937dae37ac6697956946bd2aea35327264'}
PBS_PYTHON_ROLE_PIN = {'path': str(JOB / 'bootstrap/python/bin/python3.12'),
                       'bytes': 18652104,
                       'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'}
NATIVE_RECIPE_ROLE_PIN = {'path': str(JOB / 'native-runtime-phases.sh'),
                          'bytes': 7104,
                          'sha256': '450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709'}
PREPARATION_CONTRACT_ROLE_PIN = {
    'path': str(CI_ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json'),
    'bytes': 63647,
    'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'}
FINALIZER_R4_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/remote-control/20261028/mac-ci-runtime-finalizer-source-r4/finalize_bundle_r4.py',
    'bytes': 47882,
    'sha256': 'dd0268e92cc79feb2695b68e845bb40155a3ac3eed58b9ed1ea576b17281aa9d'}
SHARED_CONTRACT_R4_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/studio/20261028/mac-ci-fresh-runtime-assembly-source-root-r6/fresh_runtime_contract.py',
    'bytes': 12637,
    'sha256': '2dade1e85f653b733f2a4111bd9428d79f8a86a1b352202671ec7dc6ee9dac5c'}
RESEARCH_R2_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/remote-control/20261028/mac-ci-native-audit-source-research-r2/SOURCE_RESEARCH_R2.json',
    'bytes': 13625,
    'sha256': '660c8485739a4714925b18494990aee354925bf1104aef97a4a9287946f0d594'}
PETTA_DATA_REVIEW_PIN = {
    'path': '/Users/jon/Downloads/OmegaHive/coordination/remote-control/20261028/petta-entrypoint-pinned-data-review-r1/RESULT_R1.json',
    'bytes': 2391,
    'sha256': 'f181524134a28a21ac5527ff2f7e5ca285b6411ead22af9af5a65df84ed6b328'}
NATIVE_INPUT_SCOPE = 'Exact owner-bound native worker inputs only; no execution authority or native qualification.'
RUN_ENABLED = True
MAX_TREE_ENTRIES = 100000
MAX_TREE_BYTES = 3 * 1024**3
MAX_FILE_BYTES = 1024**3
MAX_MACHO_FILES = 2048
MAX_DYNAMIC_CONTEXT_ROWS = 2048
MAX_DYNAMIC_CONTEXT_LINKS = 8192
MAX_COMMANDS = 8202
MAX_COMMAND_SECONDS = 60
MAX_AUDIT_SECONDS = 1500
CONTROLLER_SECONDS = 1800
COMBINED_RSS_LIMIT = 3 * 1024**3
COMMAND_OUTPUT_LIMIT = 64 * 1024
AGGREGATE_LOG_LIMIT = 64 * 1024**2

# Per-job owner/tool facts and actual candidate/runner/finalizer identities are
# supplied externally. Neither this module nor any review embeds its own hash.
UNBOUND_OWNER_ADMISSION = None

# R6 and worker-R2 origin locators above are historical design data only.
# Actual R7 preparation is proved from the sealed Stage1 review and stage result.
CURRENT_PREPARER_ROLES = {
    'prep_entry': {'bytes': 26212, 'sha256': '3f188e98270d9f0914a1734ba9af2b019d87314ffd265486cd1d1939087aaf3a'},
    'prep_worker_enabled': {'bytes': 30566, 'sha256': '3d095d31c80974ff33ffa1efa8c72cd2532a495446f151c03413d532a9825727'},
    'prep_prototype': {'bytes': 30505, 'sha256': 'a350127907f78776fb7352e4e2a794e66891fe851b64ae6fc6cd77280ccef4b2'},
    'public_inputs': {'bytes': 63647, 'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'},
}
STAGE1_ROLES = frozenset({'prep_entry', 'prep_parent_library', 'prep_worker_enabled',
    'prep_prototype', 'public_inputs', 'resource_guide', 'resource_policy',
    'native_entry', 'native_parent', 'native_worker_enabled', 'input_producer'})

MACHO_MAGICS = {
    b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe',
    b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
    b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
    b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca',
}
BUILD_PATH_MARKERS = (
    '/private/tmp/omegahive-ci-r12', '/tmp/omegahive-ci-r12',
    '/Users/', '/opt/homebrew/', '/opt/local/',
)
SYSTEM_LIBRARY_ROOTS = ('/usr/lib/', '/System/Library/')


class AuditRefused(RuntimeError):
    """Stable refusal with a bounded reason; never includes process output."""


def _need(condition, reason):
    if not condition:
        raise AuditRefused(reason)


def _valid_sha(value):
    return type(value) is str and SHA256.fullmatch(value) is not None


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        _need(type(key) is str and key not in value, 'duplicate_or_nonstring_json_key')
        value[key] = item
    return value


def _reject_json_constant(value):
    raise AuditRefused('nonstandard_json_constant_refused')


def _canonical_absolute(value):
    _need(type(value) is str and value.startswith('/') and '..' not in Path(value).parts,
          'canonical_absolute_path_required')
    path = Path(value)
    _need(path.is_absolute() and str(path) == value, 'canonical_absolute_path_required')
    return path


def _safe_relative(value):
    _need(type(value) is str and 0 < len(value.encode()) <= 1024,
          'bounded_relative_runtime_path_required')
    path = PurePosixPath(value)
    _need(not path.is_absolute() and str(path) == value and value != '.'
          and '..' not in path.parts and '\\' not in value
          and all(ord(char) >= 32 and ord(char) != 127 for char in value),
          'bounded_relative_runtime_path_required')
    _need(path.parts and path.parts[0] in COMPONENTS, 'declared_runtime_component_required')
    return path


def _check_plain_ancestry(path):
    path = Path(path)
    for ancestor in reversed(path.parents):
        info = ancestor.lstat()
        _need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
              'plain_directory_ancestry_required')


def _open_directory_chain(path):
    """Open every absolute directory component without following a link."""
    path = _canonical_absolute(str(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY |
                            getattr(os, 'O_NOFOLLOW', 0), dir_fd=fd)
            info = os.fstat(child)
            _need(stat.S_ISDIR(info.st_mode), 'directory_chain_component_required')
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_regular(path, *, maximum, expected_bytes=None, owner_uid=None, keep_bytes=False):
    path = _canonical_absolute(str(path))
    parentfd = _open_directory_chain(path.parent)
    parent_before = os.fstat(parentfd)
    try:
        fd = os.open(path.name, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) |
                     getattr(os, 'O_NONBLOCK', 0), dir_fd=parentfd)
    except BaseException:
        os.close(parentfd)
        raise
    try:
        before = os.fstat(fd)
        _need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
              and 0 <= before.st_size <= maximum, 'bounded_regular_file_required')
        if expected_bytes is not None:
            _need(before.st_size == expected_bytes, 'pinned_file_size_mismatch')
        if owner_uid is not None:
            _need(before.st_uid == owner_uid, 'pinned_file_owner_mismatch')
        digest, size, chunks, prefix = hashlib.sha256(), 0, [], b''
        while True:
            block = os.read(fd, min(65536, maximum + 1 - size))
            if not block:
                break
            size += len(block)
            _need(size <= maximum, 'bounded_file_read_exceeded')
            if len(prefix) < 4:
                prefix += block[:4 - len(prefix)]
            digest.update(block)
            if keep_bytes:
                chunks.append(block)
        after = os.fstat(fd)
        named_after = os.stat(path.name, dir_fd=parentfd, follow_symlinks=False)
        parent_after = os.fstat(parentfd)
        current_parentfd = _open_directory_chain(path.parent)
        try:
            current_parent = os.fstat(current_parentfd)
        finally:
            os.close(current_parentfd)
        key = lambda info: (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
                            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)
        _need(key(before) == key(after) == key(named_after)
              and (parent_before.st_dev, parent_before.st_ino, parent_before.st_uid,
                   parent_before.st_mtime_ns, parent_before.st_ctime_ns) ==
                  (parent_after.st_dev, parent_after.st_ino, parent_after.st_uid,
                   parent_after.st_mtime_ns, parent_after.st_ctime_ns)
              and (parent_before.st_dev, parent_before.st_ino, parent_before.st_uid) ==
                  (current_parent.st_dev, current_parent.st_ino, current_parent.st_uid)
              and size == before.st_size,
              'file_changed_during_read')
        return (b''.join(chunks) if keep_bytes else b''), digest.hexdigest(), prefix, before
    finally:
        os.close(fd)
        os.close(parentfd)


def _read_pinned_json(pin, expected_path, *, maximum, owner_uid):
    _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
          and pin.get('path') == str(expected_path)
          and type(pin.get('bytes')) is int and 0 < pin['bytes'] <= maximum
          and _valid_sha(pin.get('sha256')),
          'exact_receipt_pin_required')
    raw, digest, _prefix, _info = _read_regular(
        pin['path'], maximum=maximum, expected_bytes=pin['bytes'], owner_uid=owner_uid, keep_bytes=True)
    _need(digest == pin['sha256'], 'held_receipt_pin_mismatch')
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise AuditRefused('pinned_receipt_json_invalid') from error
    _need(type(value) is dict, 'receipt_object_required')
    return value


def _job_identity(value):
    _need(type(value) is list and len(value) == 4
          and all(type(part) is int for part in value)
          and value[0] >= 0 and value[1] > 0 and value[2] > 0 and value[3] == 0o700,
          'exact_job_identity_required')


def _admission_paths(audit_kind):
    _need(type(audit_kind) is str and audit_kind in {'native_audit', 'relocation'},
          'audit_kind_required')
    if audit_kind == 'native_audit':
        return OWNER_ADMISSION_PATH, TASK_ADMISSION_PATH, RESOURCE_ADMISSION_PATH
    return (RELOCATION_OWNER_ADMISSION_PATH, RELOCATION_TASK_ADMISSION_PATH,
            RELOCATION_RESOURCE_ADMISSION_PATH)


def _check_context(root, context):
    _need(type(context) is dict and set(context) == {
        'schema', 'audit_kind', 'job_path', 'source_bundle_root', 'native_inputs',
        'evidence', 'job_identity', 'execution_owner', 'origin_machine', 'candidate_source_sha256',
        'owner_admission',
    }, 'closed_native_audit_context_required')
    _need(context['schema'] == 'studio-Mac-CI-native-audit-context/1',
          'native_audit_context_schema_required')
    owner_path, _task_path, _resource_path = _admission_paths(context['audit_kind'])
    _need(context['job_path'] == str(JOB)
          and context['source_bundle_root'] == str(ORIGINAL_BUNDLE),
          'fixed_original_ci_job_and_bundle_required')
    _job_identity(context['job_identity'])
    _need(type(context['owner_admission']) is dict
          and context['owner_admission'].get('path') == str(owner_path),
          'fixed_owner_admission_path_required')
    for pin, fixed_path, maximum in [
            (context['owner_admission'], owner_path, 64 * 1024),
            (context['native_inputs'], NATIVE_INPUTS_PATH, 256 * 1024)]:
        _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
              and pin.get('path') == str(fixed_path) and type(pin.get('bytes')) is int
              and 0 < pin['bytes'] <= maximum
              and _valid_sha(pin.get('sha256')),
              'closed_context_pin_shape_required')
    _need(type(context['execution_owner']) is str and 1 <= len(context['execution_owner']) <= 128
          and type(context['origin_machine']) is str and 1 <= len(context['origin_machine']) <= 128,
          'owner_and_origin_attribution_required')
    _need(_valid_sha(context['candidate_source_sha256']),
          'candidate_source_digest_required')
    actual = _canonical_absolute(str(root))
    if context['audit_kind'] == 'native_audit':
        _need(actual == ORIGINAL_BUNDLE, 'original_bundle_root_required')
    else:
        attempt = actual.parent
        _need(actual.name == 'OmegaHive.bundle' and attempt.parent == RELOCATION_ROOT
              and re.fullmatch(r'attempt-[0-9a-f]{32}', attempt.name) is not None
              and actual != ORIGINAL_BUNDLE, 'fixed_distinct_relocation_root_required')
    evidence = context['evidence']
    _need(type(evidence) is dict and set(evidence) == {
        'native_phases', 'native_parent', 'finalization', 'finalizer_admission',
    }, 'closed_prerequisite_evidence_roles_required')
    fixed = {
        'native_phases': RECEIPTS / 'native-phases-r1.json',
        'finalization': RECEIPTS / 'finalization_r1.json',
        'finalizer_admission': RECEIPTS / 'finalizer-admission-r1.json',
    }
    for name in ('native_phases', 'finalization', 'finalizer_admission'):
        maximum = 2 * 1024**2 if name == 'native_phases' else (32 * 1024**2 if name == 'finalization' else 64 * 1024)
        _need(type(evidence[name]) is dict and set(evidence[name]) == {'path', 'bytes', 'sha256'}
              and evidence[name].get('path') == str(fixed[name])
              and type(evidence[name].get('bytes')) is int
              and 0 < evidence[name]['bytes'] <= maximum
              and _valid_sha(evidence[name].get('sha256')),
              'fixed_prerequisite_receipt_path_required')
    parent_pin = evidence['native_parent']
    _need(type(parent_pin) is dict and type(parent_pin.get('path')) is str,
          'native_parent_receipt_pin_required')
    parent_path = Path(parent_pin['path'])
    _need(parent_path.parent.parent == CI_ROOT / 'native-parent'
          and parent_path.name == 'PARENT_RESULT.json'
          and re.fullmatch(r'attempt-[0-9a-f]{32}', parent_path.parent.name) is not None
          and set(parent_pin) == {'path', 'bytes', 'sha256'}
          and type(parent_pin.get('bytes')) is int and 0 < parent_pin['bytes'] <= 2 * 1024**2
          and _valid_sha(parent_pin.get('sha256')),
          'native_parent_attempt_namespace_required')


def _lineage_relative(value):
    _need(type(value) is str and 0 < len(value.encode('utf-8')) <= 4096,
          'bounded_source_relative_path_required')
    path = PurePosixPath(value)
    _need(not path.is_absolute() and str(path) == value and value != '.'
          and '..' not in path.parts and '\\' not in value
          and all(ord(char) >= 32 and ord(char) != 127 for char in value),
          'canonical_source_relative_path_required')
    return path


def _lineage_pin(pin, *, maximum, path=None):
    fields = {'bytes', 'sha256'} if path is None else {'path', 'bytes', 'sha256'}
    _need(type(pin) is dict and set(pin) == fields
          and type(pin.get('bytes')) is int and 0 < pin['bytes'] <= maximum
          and _valid_sha(pin.get('sha256')), 'closed_preparation_lineage_pin_required')
    if path is not None:
        _need(pin['path'] == path, 'preparation_lineage_path_mismatch')
    return {key: pin[key] for key in ('bytes', 'sha256')}


def _read_lineage_file(root, relative, pin, *, maximum, owner_uid):
    name = _lineage_relative(relative)
    expected = _lineage_pin(pin, maximum=maximum)
    raw, digest, _prefix, info = _read_regular(
        root / name, maximum=maximum, expected_bytes=expected['bytes'],
        owner_uid=owner_uid, keep_bytes=True)
    _need(digest == expected['sha256'], 'preparation_lineage_file_pin_mismatch')
    return raw, {'path': str(name), 'bytes': info.st_size, 'sha256': digest}


def _lineage_object(raw):
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object,
                           parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise AuditRefused('preparation_lineage_json_invalid') from error
    _need(type(value) is dict, 'preparation_lineage_object_required')
    return value


def _preparation_owner_bindings(admission):
    parent = admission.get('preparation_parent')
    _need(type(parent) is dict and type(parent.get('path')) is str
          and re.fullmatch(r'preparation-parent/stage/attempt-[a-f0-9]{32}/PARENT_RESULT\.json',
                           parent['path']) is not None,
          'preparation_parent_namespace_required')
    _lineage_pin(parent, maximum=2 * 1024**2, path=parent['path'])
    _lineage_pin(admission.get('stage1_manifest'), maximum=65536)
    _lineage_pin(admission.get('stage1_source_review'), maximum=128 * 1024)
    return {name: admission[name] for name in
            ('preparation_parent', 'stage1_manifest', 'stage1_source_review')}


def _verify_preparation_execution(final, owner_admission, roles, finalizer_admission,
                                  job_identity):
    """Independently rebuild Root R5's closed, scoped preparation proof from held data."""
    bindings = _preparation_owner_bindings(owner_admission)
    _need(all(finalizer_admission.get(name) == value for name, value in bindings.items()),
          'finalizer_and_audit_preparation_owner_bindings_mismatch')
    owner_uid = owner_admission['owner_uid']
    basefd = _open_directory_chain(CI_ROOT)
    jobfd = None
    try:
        jobfd = _open_directory_chain(JOB)
        base_info = os.fstat(basefd)
        actual_base = [base_info.st_dev, base_info.st_ino, base_info.st_uid,
                       stat.S_IMODE(base_info.st_mode)]
        actual_job = os.fstat(jobfd)
        _need(base_info.st_uid == owner_uid and stat.S_IMODE(base_info.st_mode) == 0o700,
              'preparation_lineage_private_base_required')
        _need([actual_job.st_dev, actual_job.st_ino, actual_job.st_uid,
               stat.S_IMODE(actual_job.st_mode)] == job_identity,
              'preparation_lineage_current_job_mismatch')
        manifest_raw, manifest_pin = _read_lineage_file(
            JOB, 'receipts/stage1-MANIFEST.sha256', bindings['stage1_manifest'],
            maximum=65536, owner_uid=owner_uid)
        review_raw, review_pin = _read_lineage_file(
            JOB, 'receipts/stage1-source-review-r1.json', bindings['stage1_source_review'],
            maximum=128 * 1024, owner_uid=owner_uid)
        _need(manifest_raw.endswith(b'\n') and b'\r' not in manifest_raw
              and b'\x00' not in manifest_raw, 'stage1_lineage_checksum_LF_required')
        checksums = {}
        try:
            lines = manifest_raw.decode('ascii').splitlines()
        except UnicodeDecodeError as error:
            raise AuditRefused('stage1_lineage_checksum_ascii_required') from error
        for line in lines:
            match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_./-]+)', line)
            _need(match is not None, 'stage1_lineage_checksum_row_required')
            digest, name = match.groups()
            _lineage_relative(name)
            _need(name != 'MANIFEST.sha256' and name not in checksums and len(checksums) < 128,
                  'stage1_lineage_checksum_duplicate_self_or_bound')
            checksums[name] = digest
        _need(checksums.get('STATIC_SOURCE_REVIEW.json') == review_pin['sha256'],
              'stage1_lineage_manifest_review_binding_required')
        review = _lineage_object(review_raw)
        _need(set(review) == {'schema', 'verdict', 'blocking_findings', 'reviewer',
                             'source_owner', 'origin_machine', 'subjects',
                             'native_component_review', 'scope'}
              and review['schema'] == 'studio-Mac-CI-stage1-static-source-review/1'
              and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == []
              and type(review['subjects']) is dict and set(review['subjects']) == STAGE1_ROLES,
              'genuine_stage1_lineage_static_review_required')
        _need(all(type(review[name]) is str and 0 < len(review[name]) <= 128
                  for name in ('reviewer', 'source_owner', 'origin_machine'))
              and type(review['scope']) is str and 0 < len(review['scope']) <= 4096,
              'stage1_lineage_review_provenance_required')
        for row in list(review['subjects'].values()) + [review['native_component_review']]:
            _need(type(row) is dict and type(row.get('path')) is str,
                  'stage1_lineage_review_role_required')
            _lineage_relative(row['path'])
            _lineage_pin(row, maximum=256 * 1024, path=row['path'])
            _need(checksums.get(row['path']) == row['sha256'],
                  'stage1_lineage_review_role_checksum_mismatch')
        _need(review['native_component_review']['path'] == 'STATIC_NATIVE_SOURCE_REVIEW.json',
              'stage1_lineage_component_review_path_required')
        for name, expected in CURRENT_PREPARER_ROLES.items():
            _need({key: review['subjects'][name][key] for key in ('bytes', 'sha256')} == expected,
                  'stage1_lineage_current_preparer_source_required')
        _need({key: roles['worker'][key] for key in ('bytes', 'sha256')}
              == {key: review['subjects']['native_worker_enabled'][key]
                  for key in ('bytes', 'sha256')}, 'stage1_lineage_actual_native_worker_mismatch')
        parent_binding = bindings['preparation_parent']
        parent_raw, parent_pin = _read_lineage_file(
            CI_ROOT, parent_binding['path'],
            _lineage_pin(parent_binding, maximum=2 * 1024**2, path=parent_binding['path']),
            maximum=2 * 1024**2, owner_uid=owner_uid)
        parent = _lineage_object(parent_raw)
        cleanup = parent.get('cleanup')
        _need(parent.get('schema') == 'studio-owned-public-preparation-parent/1'
              and parent.get('phase') == 'stage' and parent.get('status') == 'worker_exit0'
              and type(parent.get('worker_exit')) is int and parent['worker_exit'] == 0
              and type(parent.get('worker_pid')) is int and parent['worker_pid'] > 0
              and type(parent.get('worker_pgid')) is int and parent['worker_pgid'] == parent['worker_pid']
              and parent.get('native_action') is False and type(cleanup) is dict
              and cleanup.get('worker_reaped') is True and cleanup.get('group_absent') is True
              and cleanup.get('signals') == [] and cleanup.get('observation_errors') == []
              and parent.get('finalization_errors') == [], 'clean_preparation_stage_parent_required')
        _job_identity(parent.get('job_identity'))
        _job_identity(parent.get('ci_root_identity'))
        _need(parent['job_identity'] == job_identity and parent['ci_root_identity'] == actual_base
              and job_identity[0] > 0 and actual_base[0] > 0,
              'preparation_stage_same_job_and_base_required')
        _need(all(type(parent.get(name)) is str and 0 < len(parent[name]) <= 128
                  for name in ('source_owner', 'origin_machine')),
              'preparation_stage_owner_origin_required')
        expected_worker = {'path': str(CI_ROOT / 'runtime-source/prepare_ci_runtime.py'),
                           **CURRENT_PREPARER_ROLES['prep_worker_enabled']}
        _lineage_pin(parent.get('worker'), maximum=128 * 1024, path=expected_worker['path'])
        _need(parent['worker'] == expected_worker, 'actual_preparation_worker_mismatch')
        _need(parent.get('worker_receipt') == roles['preparation'],
              'actual_preparation_receipt_link_required')
        _lineage_pin(parent.get('prepared_inventory'), maximum=8 * 1024**2,
                     path=str(JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json'))
        _need(parent['prepared_inventory'] == roles['prepared_inventory'],
              'actual_preparation_inventory_link_required')
        _inventory_raw, inventory_pin = _read_lineage_file(
            JOB, 'PREPARED_SOURCE_INVENTORIES_R1.json',
            _lineage_pin(roles['prepared_inventory'], maximum=8 * 1024**2,
                         path=str(JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json')),
            maximum=8 * 1024**2, owner_uid=owner_uid)
        _need(set(_lineage_object(_inventory_raw)) == {'python', 'swipl', 'petta', 'chroma', 'pcre2'},
              'actual_preparation_five_inventory_roles_required')
        context = parent.get('static_source_context')
        _need(type(context) is dict and set(context) == {'manifest_sha256', 'review',
                                                       'owner_admission', 'dedicated_ci_job'}
              and context['manifest_sha256'] == manifest_pin['sha256']
              and context['review'] == {key: review_pin[key] for key in ('bytes', 'sha256')}
              and context['dedicated_ci_job'] is True
              and type(context['owner_admission']) is str and 0 < len(context['owner_admission']) <= 128,
              'actual_preparation_static_context_required')
        _lineage_pin(context['review'], maximum=128 * 1024)
        _worker_raw, worker_pin = _read_lineage_file(
            CI_ROOT, 'runtime-source/prepare_ci_runtime.py', CURRENT_PREPARER_ROLES['prep_worker_enabled'],
            maximum=128 * 1024, owner_uid=owner_uid)
        _prototype_raw, prototype_pin = _read_lineage_file(
            CI_ROOT, 'runtime-source/prepare_ci_runtime_prototype.py', CURRENT_PREPARER_ROLES['prep_prototype'],
            maximum=128 * 1024, owner_uid=owner_uid)
        preparation_pin = {'path': 'CI_PREPARATION_RECEIPT_R1.json',
                           **_lineage_pin(roles['preparation'], maximum=2 * 1024**2,
                                         path=str(JOB / 'CI_PREPARATION_RECEIPT_R1.json'))}
        expected = {'schema': 'studio-verified-preparation-execution-lineage/1',
                    'source_owner': parent['source_owner'], 'origin_machine': parent['origin_machine'],
                    'parent': parent_pin, 'stage1_manifest': manifest_pin,
                    'stage1_source_review': review_pin, 'actual_worker': worker_pin,
                    'actual_prototype': prototype_pin,
                    'reviewed_prep_entry': review['subjects']['prep_entry'],
                    'preparation_receipt': preparation_pin, 'prepared_inventory': inventory_pin,
                    'job_identity': list(job_identity),
                    'qualification': 'Preparation data lineage only; no native/product qualification'}
        # Typed equality prevents bool/int JSON substitutions in the proof.
        actual_proof = final.get('preparation_execution')
        _need(type(actual_proof) is dict and _typed_same(actual_proof, expected),
              'finalizer_actual_preparation_execution_proof_mismatch')
        after_job = os.fstat(jobfd)
        after_base = os.fstat(basefd)
        _need([after_job.st_dev, after_job.st_ino, after_job.st_uid,
               stat.S_IMODE(after_job.st_mode)] == job_identity
              and [after_base.st_dev, after_base.st_ino, after_base.st_uid,
                   stat.S_IMODE(after_base.st_mode)] == actual_base,
              'preparation_lineage_directory_identity_changed')
        named_basefd = _open_directory_chain(CI_ROOT)
        named_jobfd = None
        try:
            named_jobfd = _open_directory_chain(JOB)
            named_base, named_job = os.fstat(named_basefd), os.fstat(named_jobfd)
            _need([named_base.st_dev, named_base.st_ino, named_base.st_uid,
                   stat.S_IMODE(named_base.st_mode)] == actual_base
                  and [named_job.st_dev, named_job.st_ino, named_job.st_uid,
                       stat.S_IMODE(named_job.st_mode)] == job_identity,
                  'preparation_lineage_named_directory_changed')
        finally:
            if named_jobfd is not None:
                os.close(named_jobfd)
            os.close(named_basefd)
        return expected
    finally:
        if jobfd is not None:
            os.close(jobfd)
        os.close(basefd)


def _typed_same(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return set(actual) == set(expected) and all(_typed_same(actual[key], value)
                                                   for key, value in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(_typed_same(a, b) for a, b in zip(actual, expected))
    return actual == expected


def _read_stage2_source_review(admission, source_sha, source_info):
    """Read the genuine frozen whole review; no runtime fact belongs in its subjects."""
    raw, digest, _prefix, _info = _read_regular(
        STAGE2_SOURCE_REVIEW_PATH, maximum=256 * 1024,
        owner_uid=admission['owner_uid'], keep_bytes=True)
    _need(digest == admission['review_manifest_sha256'], 'static_stage2_review_pin_mismatch')
    review = _lineage_object(raw)
    _need(set(review) == {'schema', 'verdict', 'blocking_findings', 'reviewer',
                         'source_owner', 'origin_machine', 'subjects', 'scope'}
          and review['schema'] == 'studio-Mac-CI-stage2-static-source-review/1'
          and review['verdict'] == 'PASS_SOURCE_ONLY' and review['blocking_findings'] == []
          and type(review['subjects']) is dict
          and set(review['subjects']) == set(STAGE2_SOURCE_ROLES),
          'genuine_closed_ten_role_stage2_source_review_required')
    _need(all(type(review[name]) is str and 0 < len(review[name]) <= 128
              for name in ('reviewer', 'source_owner', 'origin_machine'))
          and type(review['scope']) is str and 0 < len(review['scope']) <= 4096,
          'stage2_static_review_provenance_required')
    total = 0
    for role, relative in STAGE2_SOURCE_ROLES.items():
        subject = review['subjects'][role]
        expected = _lineage_pin(subject, maximum=256 * 1024, path=relative)
        held, observed = _read_lineage_file(CI_ROOT, relative, expected,
                                          maximum=256 * 1024,
                                          owner_uid=admission['owner_uid'])
        total += len(held)
        _need(total <= 3 * 1024**2 and b'\x00' not in held,
              'stage2_static_source_text_or_total_bound')
        try:
            held.decode('utf-8')
        except UnicodeDecodeError as error:
            raise AuditRefused('stage2_static_source_UTF8_required') from error
        _need(observed == subject, 'stage2_static_source_subject_mismatch:' + role)
    subjects = review['subjects']
    _need(subjects['audit_runtime'] == {'path': STAGE2_SOURCE_ROLES['audit_runtime'],
                                       'bytes': source_info.st_size, 'sha256': source_sha},
          'stage2_static_review_actual_audit_source_mismatch')
    for role, field in (('finalize_runtime', 'finalizer_source_pin'),
                        ('audit_process_runner', 'process_runner_pin')):
        subject = subjects[role]
        _need(_typed_same(admission.get(field), {
            'path': str(CI_ROOT / subject['path']), 'bytes': subject['bytes'],
            'sha256': subject['sha256']}), 'stage2_static_review_active_owner_source_mismatch:' + role)
    _need({key: subjects['fresh_runtime_contract'][key] for key in ('bytes', 'sha256')}
          == {key: SHARED_CONTRACT_R4_PIN[key] for key in ('bytes', 'sha256')},
          'stage2_static_review_fresh_contract_revision_required')
    return review


def _read_owner_admission(context):
    owner_path, task_path, resource_path = _admission_paths(context['audit_kind'])
    pin = context['owner_admission']
    _need(RUN_ENABLED is True, 'native_audit_disabled')
    admission = _read_pinned_json(pin, owner_path, maximum=64 * 1024,
                                  owner_uid=os.geteuid())
    fields = {
        'schema', 'status', 'enabled', 'valid_until_epoch', 'job_path', 'job_identity',
        'audit_kind', 'source_bundle_root', 'candidate_source_sha256',
        'review_manifest_sha256', 'execution_owner', 'origin_machine', 'owner_uid',
        'task_admission', 'resource_admission', 'process_runner_pin', 'tool_pins',
        'native_worker_source_pin',
        'petta_entrypoint', 'finalizer_source_pin', 'dynamic_image_contexts',
        'task_id', 'resource_id',
        'preparation_parent', 'stage1_manifest', 'stage1_source_review',
    }
    _need(set(admission) == fields
          and admission.get('schema') == 'studio-Mac-CI-native-audit-admission/1'
          and admission.get('status') == 'OWNER_ADMITTED_NATIVE_AUDIT'
          and admission.get('enabled') is True
          and type(admission.get('valid_until_epoch')) is int
          and time.time() < admission['valid_until_epoch']
          and time.time() + MAX_AUDIT_SECONDS <= admission['valid_until_epoch']
          and admission['valid_until_epoch'] <= int(time.time()) + CONTROLLER_SECONDS,
          'fresh_native_audit_owner_admission_required')
    _preparation_owner_bindings(admission)
    _need(admission['job_path'] == str(JOB)
          and admission['source_bundle_root'] == str(ORIGINAL_BUNDLE)
          and admission['audit_kind'] == context['audit_kind']
          and admission['job_identity'] == context['job_identity']
          and admission['candidate_source_sha256'] == context['candidate_source_sha256']
          and admission['execution_owner'] == context['execution_owner']
          and admission['origin_machine'] == context['origin_machine']
          and type(admission['owner_uid']) is int and admission['owner_uid'] > 0
          and os.getuid() == admission['owner_uid']
          and os.geteuid() == admission['owner_uid'],
          'current_owner_job_source_uid_binding_required')
    _need(type(admission['task_id']) is str and 1 <= len(admission['task_id']) <= 128
          and type(admission['resource_id']) is str and 1 <= len(admission['resource_id']) <= 128,
          'current_task_resource_ids_required')
    source_path = Path(__file__).absolute()
    _need(source_path == SOURCE_PATH, 'fixed_candidate_source_path_required')
    _raw, source_sha, _prefix, source_info = _read_regular(
        source_path, maximum=2 * 1024**2, owner_uid=admission['owner_uid'])
    _need(source_sha == admission['candidate_source_sha256'], 'candidate_source_pin_mismatch')
    _read_stage2_source_review(admission, source_sha, source_info)
    _need(type(admission['process_runner_pin']) is dict
          and set(admission['process_runner_pin']) == {'path', 'bytes', 'sha256'}
          and admission['process_runner_pin']['path'] == str(CI_ROOT / 'stage2-parent/audit_process_runner.py')
          and type(admission['process_runner_pin']['bytes']) is int
          and 0 < admission['process_runner_pin']['bytes'] <= 2 * 1024**2
          and _valid_sha(admission['process_runner_pin'].get('sha256')),
          'pinned_process_runner_source_required')
    worker_pin = admission['native_worker_source_pin']
    _need(type(worker_pin) is dict
          and set(worker_pin) == {'path', 'bytes', 'sha256'}
          and worker_pin.get('path') == str(CI_ROOT / 'native-source/ci_native_worker.py')
          and type(worker_pin.get('bytes')) is int and 0 < worker_pin['bytes'] <= 2 * 1024**2
          and _valid_sha(worker_pin.get('sha256'))
          and worker_pin != NATIVE_WORKER_R2_PIN,
          'exact_active_native_worker_derivative_pin_required')
    finalizer_pin = admission['finalizer_source_pin']
    _need(type(finalizer_pin) is dict and set(finalizer_pin) == {'path', 'bytes', 'sha256'}
          and type(finalizer_pin.get('path')) is str
          and finalizer_pin['path'] == str(CI_ROOT / 'stage2-source/finalize_runtime.py')
          and type(finalizer_pin.get('bytes')) is int and 0 < finalizer_pin['bytes'] <= 2 * 1024**2
          and _valid_sha(finalizer_pin.get('sha256')),
          'exact_active_finalizer_source_pin_required')
    _finalizer_source, finalizer_sha, _prefix, _info = _read_regular(
        finalizer_pin['path'], maximum=2 * 1024**2, expected_bytes=finalizer_pin['bytes'],
        owner_uid=admission['owner_uid'])
    _need(finalizer_sha == finalizer_pin['sha256'], 'active_finalizer_source_pin_mismatch')
    _need(type(admission['tool_pins']) is dict
          and set(admission['tool_pins']) == {'ps', 'lipo', 'otool', 'sh', 'dirname'},
          'exact_system_tool_pins_unbound')
    tool_paths = {'ps': '/bin/ps', 'lipo': '/usr/bin/lipo',
                  'otool': '/usr/bin/otool', 'sh': '/bin/sh', 'dirname': '/usr/bin/dirname'}
    for name, path in tool_paths.items():
        pin = admission['tool_pins'][name]
        _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
              and pin.get('path') == path and type(pin.get('bytes')) is int
              and 0 < pin['bytes'] <= 128 * 1024**2
              and _valid_sha(pin.get('sha256')),
              'exact_system_tool_input_pin_required:' + name)
    petta = admission['petta_entrypoint']
    _need(type(petta) is dict and petta == PETTA_SCRIPT_PIN,
          'pinned_petta_entrypoint_role_required')
    image_contexts = admission['dynamic_image_contexts']
    _need(type(image_contexts) is dict and len(image_contexts) <= MAX_DYNAMIC_CONTEXT_ROWS,
          'bounded_dynamic_image_context_map_required')
    context_links = 0
    for image, mains in image_contexts.items():
        _safe_relative(image)
        _need(type(mains) is list and 1 <= len(mains) <= 32
              and all(type(main) is str for main in mains)
              and len(set(mains)) == len(mains) and mains == sorted(mains),
              'bounded_dynamic_image_main_contexts_required')
        for main in mains:
            _safe_relative(main)
            context_links += 1
            _need(context_links <= MAX_DYNAMIC_CONTEXT_LINKS,
                  'dynamic_image_context_link_bound')
    task_pin, resource_pin = admission['task_admission'], admission['resource_admission']
    _need(type(task_pin) is dict and task_pin.get('path') == str(task_path)
          and type(resource_pin) is dict and resource_pin.get('path') == str(resource_path),
          'fixed_task_and_resource_admission_paths_required')
    task = _read_pinned_json(task_pin, task_path, maximum=64 * 1024,
                             owner_uid=admission['owner_uid'])
    resource = _read_pinned_json(resource_pin, resource_path, maximum=64 * 1024,
                                 owner_uid=admission['owner_uid'])
    shared = {'job_path': str(JOB), 'job_identity': context['job_identity'],
              'audit_kind': context['audit_kind'],
              'candidate_source_sha256': admission['candidate_source_sha256'],
              'review_manifest_sha256': admission['review_manifest_sha256'],
              'owner_uid': admission['owner_uid']}
    _need(type(task) is dict and set(task) == {
        'schema', 'status', 'valid_until_epoch', 'task_id', 'task_owner',
        'job_path', 'job_identity', 'audit_kind', 'candidate_source_sha256',
        'review_manifest_sha256', 'owner_uid', 'limits'}
        and task.get('schema') == 'studio-Mac-CI-native-audit-task/1'
        and task.get('status') == 'ADMITTED_NATIVE_AUDIT'
        and type(task.get('valid_until_epoch')) is int
        and time.time() + MAX_AUDIT_SECONDS <= task.get('valid_until_epoch', 0)
        and task.get('valid_until_epoch', 0) <= admission['valid_until_epoch']
        and task.get('task_id') == admission['task_id']
        and task.get('task_owner') == admission['execution_owner']
        and all(task.get(key) == value for key, value in shared.items()),
        'fresh_task_admission_required')
    limits = task['limits']
    _need(type(limits) is dict and set(limits) == {
        'cpu_cores', 'ram_bytes', 'scratch_bytes', 'wall_seconds', 'max_commands',
        'max_macho_files', 'max_log_bytes', 'combined_rss_bytes'}
        and limits == {'cpu_cores': 2.25, 'ram_bytes': 3355443200,
                       'scratch_bytes': 4 * 1024**3,
                       'wall_seconds': CONTROLLER_SECONDS, 'max_commands': MAX_COMMANDS,
                       'max_macho_files': MAX_MACHO_FILES,
                       'max_log_bytes': AGGREGATE_LOG_LIMIT,
                       'combined_rss_bytes': COMBINED_RSS_LIMIT},
        'exact_full_audit_resource_budget_required')
    _need(type(resource) is dict and set(resource) == {
        'schema', 'status', 'valid_until_epoch', 'resource_id', 'job_path',
        'job_identity', 'audit_kind', 'candidate_source_sha256',
        'review_manifest_sha256', 'owner_uid', 'reserved_limits'}
        and resource.get('schema') == 'studio-Mac-CI-native-audit-resource/1'
        and resource.get('status') == 'RESERVED_NATIVE_AUDIT'
        and type(resource.get('valid_until_epoch')) is int
        and time.time() + MAX_AUDIT_SECONDS <= resource.get('valid_until_epoch', 0)
        and resource.get('valid_until_epoch', 0) <= admission['valid_until_epoch']
        and resource.get('resource_id') == admission['resource_id']
        and all(resource.get(key) == value for key, value in shared.items())
        and resource.get('reserved_limits') == limits,
        'fresh_exact_resource_reservation_required')
    _job_identity(admission['job_identity'])
    jobfd = _open_directory_chain(JOB)
    try:
        job_info = os.fstat(jobfd)
        observed = [job_info.st_dev, job_info.st_ino, job_info.st_uid, stat.S_IMODE(job_info.st_mode)]
        _need(observed == admission['job_identity'] and observed[2] == admission['owner_uid']
              and observed[3] == 0o700, 'current_job_directory_identity_mismatch')
    finally:
        os.close(jobfd)
    return admission, task['valid_until_epoch'], resource['valid_until_epoch']


def _read_context_evidence(context, owner_admission):
    pins = context['evidence']
    parent_path = Path(pins['native_parent']['path'])
    values = {
        'native_phases': _read_pinned_json(pins['native_phases'], RECEIPTS / 'native-phases-r1.json', maximum=2 * 1024**2, owner_uid=owner_admission['owner_uid']),
        'native_parent': _read_pinned_json(pins['native_parent'], parent_path, maximum=2 * 1024**2, owner_uid=owner_admission['owner_uid']),
        'finalization': _read_pinned_json(pins['finalization'], RECEIPTS / 'finalization_r1.json', maximum=32 * 1024**2, owner_uid=owner_admission['owner_uid']),
        'finalizer_admission': _read_pinned_json(pins['finalizer_admission'], RECEIPTS / 'finalizer-admission-r1.json', maximum=64 * 1024, owner_uid=owner_admission['owner_uid']),
    }
    native, parent, final, admission = (values[key] for key in
        ('native_phases', 'native_parent', 'finalization', 'finalizer_admission'))
    native_pin = pins['native_phases']
    inputs_pin = context['native_inputs']
    _need(native.get('schema') == 'studio-Mac-CI-native-phase-completion/1'
          and native.get('status') == 'ALL_REQUIRED_NATIVE_PHASES_COMPLETE'
          and native.get('native_action') is True and native.get('completed_phases') == list(PHASES)
          and native.get('job_path') == str(JOB), 'fresh_native_phase_receipt_required')
    commands = native.get('commands')
    _need(type(commands) is list and len(commands) == len(PHASES), 'native_phase_command_vector_required')
    for command, phase in zip(commands, PHASES):
        _need(type(command) is dict and type(command.get('cleanup')) is dict
              and command.get('phase') == phase
              and type(command.get('exit')) is int and command.get('exit') == 0
              and command.get('cleanup', {}).get('confirmed_no_group_children') is True
              and command.get('cleanup', {}).get('forced_group_exit_needed') is False
              and not command.get('cleanup', {}).get('term_sent'),
              'clean_native_phase_required:' + phase)
    _need(type(parent.get('cleanup')) is dict
          and parent.get('schema') == 'studio-Mac-CI-Root-native-parent/1'
          and parent.get('status') == 'worker_exit0'
          and type(parent.get('worker_exit')) is int and parent.get('worker_exit') == 0
          and parent.get('cleanup', {}).get('worker_reaped') is True
          and parent.get('cleanup', {}).get('group_absent') is True
          and parent.get('cleanup', {}).get('signals') == []
          and parent.get('finalization_errors') == []
          and parent.get('worker_receipt') == native_pin,
          'clean_linked_native_parent_required')
    _need(inputs_pin.get('path') == str(NATIVE_INPUTS_PATH)
          and type(inputs_pin.get('bytes')) is int and 0 < inputs_pin['bytes'] <= 256 * 1024
          and _valid_sha(inputs_pin.get('sha256'))
          and native.get('inputs_sha256') == inputs_pin['sha256']
          and parent.get('inputs') == inputs_pin,
          'held_native_inputs_receipt_binding_required')
    native_inputs = _read_pinned_json(inputs_pin, NATIVE_INPUTS_PATH, maximum=256 * 1024,
                                      owner_uid=owner_admission['owner_uid'])
    _need(type(native_inputs) is dict
          and set(native_inputs) == {'schema', 'source_owner', 'origin_machine', 'job_path', 'roles', 'scope'}
          and native_inputs.get('schema') == 'studio-Mac-CI-native-phase-inputs/1'
          and native_inputs.get('job_path') == str(JOB)
          and type(native_inputs.get('source_owner')) is str
          and type(native_inputs.get('origin_machine')) is str
          and type(native_inputs.get('scope')) is str
          and native_inputs.get('scope') == NATIVE_INPUT_SCOPE
          and native.get('source_owner') == native_inputs.get('source_owner')
          and native.get('origin_machine') == native_inputs.get('origin_machine')
          and parent.get('source_owner') == native_inputs.get('source_owner')
          and parent.get('origin_machine') == native_inputs.get('origin_machine'),
          'closed_native_inputs_schema_required')
    role_paths = {
        'worker': CI_ROOT / 'native-source/ci_native_worker.py',
        'python': JOB / 'bootstrap/python/bin/python3.12',
        'ps': Path('/bin/ps'),
        'bash': Path('/bin/bash'),
        'recipe': JOB / 'native-runtime-phases.sh',
        'preparation': JOB / 'CI_PREPARATION_RECEIPT_R1.json',
        'contract': CI_ROOT / 'runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json',
        'prepared_inventory': JOB / 'PREPARED_SOURCE_INVENTORIES_R1.json',
    }
    roles = native_inputs.get('roles')
    _need(type(roles) is dict and set(roles) == set(role_paths)
          and parent.get('worker') == roles.get('worker')
          and native.get('canonical_recipe') == roles.get('recipe'),
          'native_worker_and_closed_input_roles_must_match_parent')
    active_worker_pin = owner_admission['native_worker_source_pin']
    _need(roles.get('worker') == active_worker_pin
          and parent.get('worker') == active_worker_pin
          and active_worker_pin != NATIVE_WORKER_R2_PIN,
          'current_owner_bound_worker_role_and_parent_required')
    fixed_role_pins = {
        'python': {'bytes': 18652104,
                   'sha256': 'aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d'},
        'recipe': {'bytes': 7104,
                   'sha256': '450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709'},
        'contract': {'bytes': 63647,
                     'sha256': '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'},
    }
    for name, path in role_paths.items():
        pin = roles[name]
        _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
              and pin.get('path') == str(path) and type(pin.get('bytes')) is int
              and 0 < pin['bytes'] <= 32 * 1024**2
              and _valid_sha(pin.get('sha256')),
              'native_input_role_pin_shape:' + name)
        if name in fixed_role_pins:
            _need({key: pin[key] for key in ('bytes', 'sha256')} == fixed_role_pins[name],
                  'native_input_fixed_source_pin:' + name)
        if name == 'ps':
            _need(pin == owner_admission['tool_pins']['ps'], 'native_ps_role_and_tool_pin_mismatch')
        expected_owner = 0 if name in {'ps', 'bash'} else owner_admission['owner_uid']
        _raw_role, role_sha, _role_prefix, _role_info = _read_regular(
            path, maximum=32 * 1024**2, expected_bytes=pin['bytes'], owner_uid=expected_owner)
        _need(role_sha == pin['sha256'], 'native_input_role_held_hash_mismatch:' + name)
    _need(roles['preparation']['bytes'] <= 2 * 1024**2
          and roles['prepared_inventory']['bytes'] <= 8 * 1024**2,
          'native_preparation_json_role_bounds')
    preparation = _read_pinned_json(roles['preparation'], role_paths['preparation'],
                                    maximum=2 * 1024**2, owner_uid=owner_admission['owner_uid'])
    _need(preparation.get('schema') == 'studio-Mac-CI-public-runtime-preparation/2'
          and preparation.get('status') == 'DATA_PREPARATION_ONLY_NO_NATIVE_ACTION'
          and preparation.get('contract_sha256') == fixed_role_pins['contract']['sha256'],
          'exact_native_preparation_prerequisite_required')
    _read_pinned_json(roles['prepared_inventory'], role_paths['prepared_inventory'],
                      maximum=8 * 1024**2, owner_uid=owner_admission['owner_uid'])
    _need(type(final.get('evidence_pins')) is dict
          and final.get('schema') == 'omegahive-ci-runtime-finalization/1'
          and final.get('status') == 'FINALIZED_BUNDLE_DERIVATIVE_ONLY'
          and final.get('job_path') == str(JOB)
          and final.get('bundle_components') == sorted(COMPONENTS)
          and final.get('evidence_pins', {}).get('native_phases') == {
              key: native_pin[key] for key in ('bytes', 'sha256')}
          and final.get('owner_admission') == {
              key: pins['finalizer_admission'][key] for key in ('bytes', 'sha256')},
          'fresh_finalization_prerequisite_required')
    source_pins = final.get('source_pins')
    _need(type(source_pins) is dict
          and source_pins.get('prep_R6_manifest') == PREPARATION_R6_MANIFEST_SHA256
          and source_pins.get('preparation_contract') == fixed_role_pins['contract']['sha256']
          and source_pins.get('reference_finalizer') == EXPECTED_UPSTREAM_FINALIZER_REFERENCE_SHA256,
          'finalizer_historical_reference_lineage_required')
    identity = final.get('job_identity')
    _job_identity(identity)
    _need(identity == context['job_identity'] and admission.get('job_identity') == identity
          and admission.get('status') == 'OWNER_ADMITTED_FINALIZATION'
          and admission.get('job_path') == str(JOB)
          and admission.get('execution_owner') == context['execution_owner']
          and admission.get('origin_machine') == context['origin_machine']
          and admission.get('candidate_source_sha256') == owner_admission['finalizer_source_pin']['sha256'],
          'current_owner_finalizer_admission_required')
    _verify_preparation_execution(final, owner_admission, roles, admission, context['job_identity'])
    inventory = final.get('component_inventory')
    _need(type(inventory) is dict and 0 < len(inventory) <= MAX_TREE_ENTRIES,
          'bounded_finalizer_component_inventory_required')
    canonical_rows = []
    for name, row in inventory.items():
        path = _safe_relative(name)
        _need(type(row) is dict and row.get('kind') in {'directory', 'file', 'symlink'},
              'finalizer_inventory_row_required')
        if row['kind'] in {'directory', 'file'}:
            _need(type(row.get('mode')) is int and 0 <= row['mode'] <= 0o7777,
                  'finalizer_preseal_mode_required')
        item = {'path': str(path), 'kind': row['kind']}
        if row['kind'] == 'file':
            _need(type(row.get('bytes')) is int and 0 <= row['bytes'] <= MAX_FILE_BYTES
                  and _valid_sha(row.get('sha256')),
                  'finalizer_file_pin_required')
            item.update(bytes=row['bytes'], sha256=row['sha256'])
        elif row['kind'] == 'symlink':
            _need(type(row.get('target')) is str and 0 < len(row['target']) < 4096
                  and not row['target'].startswith('/') and '\\' not in row['target'],
                  'finalizer_internal_symlink_required')
            item['target'] = row['target']
        canonical_rows.append(item)
    content_sha = _content_inventory_sha256(canonical_rows)
    return values, native_inputs, inventory, content_sha


def _content_inventory_sha256(rows):
    _need(type(rows) is list and 0 < len(rows) <= MAX_TREE_ENTRIES, 'bounded_inventory_required')
    seen, total = set(), 0
    for row in rows:
        path = _safe_relative(row.get('path'))
        _need(row['path'] not in seen, 'duplicate_inventory_path')
        seen.add(row['path'])
        if row['kind'] == 'file':
            total += row['bytes']
            _need(total <= MAX_TREE_BYTES, 'runtime_total_byte_bound')
    roots = {PurePosixPath(name).parts[0] for name in seen}
    _need(roots == COMPONENTS, 'seven_runtime_components_required')
    root_rows = {row['path']: row['kind'] for row in rows if '/' not in row['path']}
    _need(set(root_rows) == COMPONENTS and all(kind == 'directory' for kind in root_rows.values()),
          'seven_runtime_component_roots_required')
    encoded = json.dumps(sorted(rows, key=lambda item: item['path']), sort_keys=True,
                         separators=(',', ':'), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def _inventory_bundle(root, expected, deadline, owner_uid, audit_kind):
    """Closed descriptor walk; hashes files and records actual Mach-O magic."""
    root = _canonical_absolute(str(root))
    expected_names = set(expected)
    expected_children = {}
    for name in expected_names:
        parts = PurePosixPath(name).parts
        parent = '/'.join(parts[:-1])
        expected_children.setdefault(parent, set()).add(parts[-1])
    actual = {}
    macho = []
    total = 0
    rootfd = _open_directory_chain(root)
    root_info = os.fstat(rootfd)
    _need(stat.S_ISDIR(root_info.st_mode) and root_info.st_uid == owner_uid,
          'runtime_root_must_be_owned_real_directory')

    def tick():
        _need(time.monotonic() < deadline, 'audit_wall_deadline')

    def walk(fd, prefix):
        nonlocal total
        tick()
        start = os.fstat(fd)
        with os.scandir(fd) as entries:
            names = []
            for entry in entries:
                tick()
                _need(len(actual) + len(names) < MAX_TREE_ENTRIES, 'runtime_entry_bound')
                names.append(entry.name)
        _need(set(names) == expected_children.get(prefix, set()),
              'runtime_declared_children_mismatch_before_descent')
        for name in sorted(names):
            tick()
            _need(name not in {'', '.', '..'} and '/' not in name and '\\' not in name,
                  'safe_runtime_entry_name_required')
            relative = str(PurePosixPath(prefix, name))
            _safe_relative(relative)
            _need(relative in expected, 'runtime_unlisted_entry')
            want = expected[relative]
            _need(type(want) is dict and want.get('kind') in {'directory', 'file', 'symlink'},
                  'declared_runtime_entry_kind_required')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            _need(info.st_uid == owner_uid, 'runtime_entry_owner_mismatch')
            if stat.S_ISDIR(info.st_mode):
                _need(want['kind'] == 'directory', 'runtime_entry_kind_mismatch_before_descent')
                row = {'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)}
                actual[relative] = row
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0), dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    _need((opened.st_dev, opened.st_ino, opened.st_uid) ==
                          (info.st_dev, info.st_ino, info.st_uid), 'runtime_directory_changed_at_open')
                    walk(child, relative)
                    after = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    _need((after.st_dev, after.st_ino, after.st_uid, after.st_mtime_ns, after.st_ctime_ns) ==
                          (info.st_dev, info.st_ino, info.st_uid, info.st_mtime_ns, info.st_ctime_ns),
                          'runtime_directory_changed_during_walk')
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                _need(want['kind'] == 'file', 'runtime_entry_kind_mismatch_before_read')
                _need(info.st_nlink == 1 and 0 <= info.st_size <= MAX_FILE_BYTES,
                      'runtime_regular_file_bounds')
                filefd = os.open(name, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) |
                                 getattr(os, 'O_NONBLOCK', 0), dir_fd=fd)
                digest, size, prefix_bytes = hashlib.sha256(), 0, b''
                try:
                    opened = os.fstat(filefd)
                    _need((opened.st_dev, opened.st_ino, opened.st_uid, opened.st_size) ==
                          (info.st_dev, info.st_ino, info.st_uid, info.st_size),
                          'runtime_file_changed_at_open')
                    while True:
                        tick()
                        block = os.read(filefd, min(65536, MAX_FILE_BYTES + 1 - size))
                        if not block:
                            break
                        size += len(block)
                        _need(size <= MAX_FILE_BYTES, 'runtime_file_byte_bound')
                        if len(prefix_bytes) < 4:
                            prefix_bytes += block[:4 - len(prefix_bytes)]
                        digest.update(block)
                    after = os.fstat(filefd)
                    key = lambda item: (item.st_dev, item.st_ino, item.st_uid, item.st_mode,
                                        item.st_size, item.st_mtime_ns, item.st_ctime_ns, item.st_nlink)
                    _need(size == info.st_size and key(opened) == key(after),
                          'runtime_file_changed_during_read')
                finally:
                    os.close(filefd)
                total += size
                _need(total <= MAX_TREE_BYTES, 'runtime_total_byte_bound')
                actual[relative] = {'kind': 'file', 'bytes': size, 'sha256': digest.hexdigest(),
                                    'mode': stat.S_IMODE(info.st_mode)}
                if prefix_bytes in MACHO_MAGICS:
                    macho.append(relative)
            elif stat.S_ISLNK(info.st_mode):
                _need(want['kind'] == 'symlink', 'runtime_entry_kind_mismatch')
                target = os.readlink(name, dir_fd=fd)
                _need(type(target) is str and 0 < len(target) < 4096 and not target.startswith('/')
                      and '\\' not in target, 'internal_runtime_symlink_required')
                actual[relative] = {'kind': 'symlink', 'target': target}
                after = os.stat(name, dir_fd=fd, follow_symlinks=False)
                _need((after.st_dev, after.st_ino, after.st_uid, after.st_mtime_ns, after.st_ctime_ns) ==
                      (info.st_dev, info.st_ino, info.st_uid, info.st_mtime_ns, info.st_ctime_ns),
                      'runtime_symlink_changed_during_read')
            else:
                raise AuditRefused('runtime_special_file_refused')
            _need(len(actual) <= MAX_TREE_ENTRIES, 'runtime_entry_bound')
            got = actual[relative]
            for key in ('kind', 'bytes', 'sha256', 'target'):
                if key in want:
                    _need(got.get(key) == want[key], 'runtime_inventory_mismatch')
            if got['kind'] in {'directory', 'file'}:
                _need(got['mode'] == want['mode'], 'runtime_permission_mode_mismatch')
        end = os.fstat(fd)
        _need((start.st_dev, start.st_ino, start.st_uid, start.st_mtime_ns, start.st_ctime_ns) ==
              (end.st_dev, end.st_ino, end.st_uid, end.st_mtime_ns, end.st_ctime_ns),
              'runtime_directory_changed_during_walk')

    try:
        walk(rootfd, '')
        current_rootfd = _open_directory_chain(root)
        try:
            current_root = os.fstat(current_rootfd)
        finally:
            os.close(current_rootfd)
        _need((root_info.st_dev, root_info.st_ino, root_info.st_uid) ==
              (current_root.st_dev, current_root.st_ino, current_root.st_uid),
              'runtime_root_path_identity_changed')
        _need(set(actual) == expected_names, 'runtime_missing_declared_entries')
        _need({name for name, row in actual.items() if '/' not in name and row['kind'] == 'directory'} == COMPONENTS,
              'runtime_component_roots_mismatch')
        for name, row in actual.items():
            if row['kind'] == 'symlink':
                _resolve_inventory_path(name, actual)
        return actual, sorted(macho), total
    finally:
        os.close(rootfd)


def _tool_pins(owner_admission):
    expected_paths = {'ps': '/bin/ps', 'lipo': '/usr/bin/lipo',
                      'otool': '/usr/bin/otool', 'sh': '/bin/sh', 'dirname': '/usr/bin/dirname'}
    pins = owner_admission['tool_pins']
    _need(type(pins) is dict and set(pins) == set(expected_paths), 'exact_system_tool_pin_map_required')
    result = {}
    for name, path in expected_paths.items():
        pin = pins[name]
        _need(type(pin) is dict and set(pin) == {'path', 'bytes', 'sha256'}
              and pin['path'] == path and type(pin['bytes']) is int
              and 0 < pin['bytes'] <= 128 * 1024**2
              and _valid_sha(pin.get('sha256')),
              'exact_system_tool_pin_required:' + name)
        _raw, digest, _prefix, info = _read_regular(path, maximum=128 * 1024**2,
            expected_bytes=pin['bytes'], owner_uid=0)
        _need(digest == pin['sha256'] and info.st_uid == 0, 'system_tool_pin_mismatch:' + name)
        result[name] = path
    return result


def _private_environment(runner, root, owner_uid):
    """Ask the admitted runner for its private closed environment profile."""
    factory = getattr(runner, 'environment', None)
    _need(callable(factory), 'runner_private_environment_interface_required')
    env = factory(profile='private-closed-offline', runtime_root=str(root),
                  owner_uid=owner_uid, attempt_parent=str(CI_ROOT / 'native-audit-attempts'),
                  no_bytecode=True, no_user_site=True)
    _need(type(env) is dict and set(env) == {
              'HOME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL',
              'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE'}
          and env.get('PYTHONDONTWRITEBYTECODE') == '1'
          and env.get('PYTHONNOUSERSITE') == '1'
          and env.get('LANG') == 'C' and env.get('LC_ALL') == 'C'
          and env.get('PATH') == str(root / 'swipl/bin') + ':/usr/bin:/bin',
          'closed_private_environment_required')
    for key in ('HOME', 'TMPDIR'):
        _need(type(env.get(key)) is str and Path(env[key]).is_absolute(),
              'private_home_tmpdir_required')
    home, temp = Path(env['HOME']), Path(env['TMPDIR'])
    _need(str(home) == str(home.absolute()) and str(temp) == str(temp.absolute())
          and '..' not in home.parts and '..' not in temp.parts
          and home.parent == temp.parent
          and home.parent.parent == CI_ROOT / 'native-audit-attempts'
          and re.fullmatch(r'attempt-[0-9a-f]{32}', home.parent.name) is not None
          and home.name == 'HOME' and temp.name == 'TMP',
          'fixed_private_audit_attempt_layout_required')
    for path in (home.parent, home, temp):
        fd = _open_directory_chain(path)
        try:
            info = os.fstat(fd)
            _need(info.st_uid == owner_uid and stat.S_IMODE(info.st_mode) == 0o700,
                  'private_audit_directory_identity_required')
            if path in (home, temp):
                with os.scandir(fd) as entries:
                    _need(next(iter(entries), None) is None,
                          'fresh_private_environment_directory_required')
        finally:
            os.close(fd)
    return env


def _private_environment_pins(env, owner_uid):
    attempt = Path(env['HOME']).parent
    paths = (CI_ROOT, attempt.parent, attempt,
             Path(env['HOME']), Path(env['TMPDIR']))
    rows = []
    for path in paths:
        fd = _open_directory_chain(path)
        try:
            info = os.fstat(fd)
            _need(info.st_uid == owner_uid and stat.S_IMODE(info.st_mode) == 0o700,
                  'private_audit_directory_identity_required')
            rows.append({'path': str(path), 'dev': info.st_dev, 'ino': info.st_ino,
                         'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)})
        finally:
            os.close(fd)
    return rows


def _invoke(runner, executable, executable_pin, argv, cwd, env, owner_admission, *, check_name,
            timeout=MAX_COMMAND_SECONDS, private_inputs=None, merge_stderr=False, trace):
    _need(len(trace) - 1 < MAX_COMMANDS, 'audit_command_count_bound')
    remaining = trace[0]['deadline'] - time.monotonic()
    _need(remaining > 0, 'audit_wall_deadline')
    timeout = min(timeout, max(1, int(remaining)))
    method = getattr(runner, 'run', None)
    _need(callable(method), 'owned_process_runner_required')
    _need(type(executable_pin) is dict and set(executable_pin) == {'path', 'bytes', 'sha256'}
          and executable_pin.get('path') == executable and Path(executable).is_absolute()
          and str(Path(executable)) == executable and '..' not in Path(executable).parts
          and type(executable_pin.get('bytes')) is int and 0 < executable_pin['bytes'] <= MAX_FILE_BYTES
          and _valid_sha(executable_pin.get('sha256')),
          'pinned_absolute_executable_required')
    _need(type(argv) is list and argv and all(type(item) is str and 0 < len(item.encode()) <= 4096
          and '\x00' not in item for item in argv), 'fixed_bounded_argv_required')
    _need(str(Path(cwd)) == str(cwd) and Path(cwd).is_absolute(), 'canonical_command_cwd_required')
    private_env_pins = _private_environment_pins(env, owner_admission['owner_uid'])
    env_sha256 = hashlib.sha256(json.dumps(env, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    inputs = private_inputs or {}
    _need(type(inputs) is dict and len(inputs) <= 4, 'private_input_map_bound')
    input_bytes, input_pins = 0, {}
    for name, raw in inputs.items():
        _need(type(name) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name)
              and type(raw) is bytes and len(raw) <= 32 * 1024,
              'safe_private_input_required')
        input_bytes += len(raw)
        input_pins[name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
    _need(input_bytes <= 64 * 1024, 'private_input_total_bound')
    command_started = time.monotonic()
    command_deadline = min(trace[0]['deadline'], command_started + timeout)
    result = method(executable=executable, executable_pin=executable_pin,
                    argv=list(argv), cwd=str(cwd), environment=env,
                    timeout_seconds=timeout, output_limit_bytes=COMMAND_OUTPUT_LIMIT,
                    private_inputs=inputs, merge_stderr=merge_stderr,
                    environment_profile='private-closed-offline',
                    whole_attempt_deadline=trace[0]['deadline'],
                    command_deadline=command_deadline,
                    combined_rss_limit_bytes=COMBINED_RSS_LIMIT,
                    aggregate_log_limit_bytes=AGGREGATE_LOG_LIMIT,
                    start_new_session=True, close_fds=True)
    command_finished = time.monotonic()
    observed_duration = command_finished - command_started
    required = {
        'exit', 'pid', 'pgid', 'sid', 'stdout', 'stderr', 'stdout_bytes', 'stderr_bytes',
        'stdout_sha256', 'stderr_sha256', 'worker_reaped', 'group_absent', 'signals',
        'guard_error', 'effective_argv', 'effective_cwd', 'executable_pin',
        'controller_pin', 'ownership_evidence_pins', 'private_input_pins',
        'combined_rss_peak_bytes', 'environment_sha256', 'private_environment_pins',
        'stderr_merged', 'elapsed_seconds',
    }
    _need(type(result) is dict and set(result) == required, 'owned_process_result_shape_required')
    _need(command_finished <= command_deadline
          and time.time() < owner_admission['valid_until_epoch']
          and time.time() < trace[0]['task_valid_until_epoch']
          and time.time() < trace[0]['resource_valid_until_epoch'],
          'audit_command_wall_deadline_or_owner_admission_expired')
    _need(type(result['exit']) is int and type(result['pid']) is int and result['pid'] > 0
          and type(result['pgid']) is int and result['pgid'] == result['pid']
          and type(result['sid']) is int and result['sid'] == result['pid']
          and type(result['stdout']) is bytes and type(result['stderr']) is bytes
          and type(result['stdout_bytes']) is int and result['stdout_bytes'] == len(result['stdout'])
          and type(result['stderr_bytes']) is int and result['stderr_bytes'] == len(result['stderr'])
          and len(result['stdout']) <= COMMAND_OUTPUT_LIMIT
          and len(result['stderr']) <= COMMAND_OUTPUT_LIMIT
          and len(result['stdout']) + len(result['stderr']) <= COMMAND_OUTPUT_LIMIT
          and type(result['combined_rss_peak_bytes']) is int
          and 0 < result['combined_rss_peak_bytes'] <= COMBINED_RSS_LIMIT
          and type(result['elapsed_seconds']) in {int, float}
          and 0 < result['elapsed_seconds'] <= timeout
          and result['elapsed_seconds'] <= observed_duration + 0.25
          and type(result['stderr_merged']) is bool and result['stderr_merged'] is merge_stderr
          and result['environment_sha256'] == env_sha256
          and result['private_environment_pins'] == private_env_pins
          and result['stdout_sha256'] == hashlib.sha256(result['stdout']).hexdigest()
          and result['stderr_sha256'] == hashlib.sha256(result['stderr']).hexdigest()
          and result['worker_reaped'] is True and result['group_absent'] is True
          and type(result['signals']) is list and result['signals'] == [] and result['guard_error'] is None
          and type(result['effective_argv']) is list and len(result['effective_argv']) == len(argv)
          and type(result['effective_cwd']) is str and result['effective_cwd'] == str(cwd)
          and result['executable_pin'] == executable_pin
          and executable_pin.get('path') == executable
          and result['controller_pin'] == owner_admission['process_runner_pin']
          and result['ownership_evidence_pins'] == {
              'task_admission': owner_admission['task_admission'],
              'resource_admission': owner_admission['resource_admission']}
          and result['private_input_pins'] == input_pins,
          'owned_process_identity_cleanup_or_output_bound_failed')
    _need(_private_environment_pins(env, owner_admission['owner_uid']) == private_env_pins,
          'private_environment_identity_changed_during_command')
    for declared, effective in zip(argv, result['effective_argv']):
        if declared.startswith('@private_input:'):
            basename = declared[len('@private_input:'):]
            _need(basename in inputs and type(effective) is str
                  and Path(effective) == Path(env['TMPDIR']) / basename,
                  'private_input_placeholder_expansion_invalid')
        else:
            _need(type(effective) is str and effective == declared,
                  'runner_effective_argv_mismatch')
    row = {'check': check_name, 'exit': result['exit'], 'pid': result['pid'],
           'pgid': result['pgid'], 'sid': result['sid'],
           'stdout_bytes': result['stdout_bytes'], 'stdout_sha256': result['stdout_sha256'],
           'stderr_bytes': result['stderr_bytes'], 'stderr_sha256': result['stderr_sha256'],
           'worker_reaped': result['worker_reaped'], 'group_absent': result['group_absent'],
           'signals': [], 'guard_error': None, 'effective_argv': result['effective_argv'],
           'effective_cwd': str(cwd), 'executable_pin': executable_pin,
           'controller_pin': result['controller_pin'],
           'environment_sha256': env_sha256,
           'private_environment_pins': private_env_pins,
           'combined_rss_peak_bytes': result['combined_rss_peak_bytes'],
           'elapsed_seconds': result['elapsed_seconds'], 'stderr_merged': merge_stderr,
           'ownership_evidence_pins': result['ownership_evidence_pins'],
           'private_input_pins': input_pins}
    trace.append(row)
    trace[0]['log_bytes'] += result['stdout_bytes'] + result['stderr_bytes']
    trace[0]['combined_rss_peak_bytes'] = max(trace[0]['combined_rss_peak_bytes'],
                                               result['combined_rss_peak_bytes'])
    _need(trace[0]['log_bytes'] <= AGGREGATE_LOG_LIMIT, 'audit_aggregate_output_bound')
    _need(result['exit'] == 0, 'audit_command_nonzero_exit')
    return result['stdout']


def _command_check(name, commands):
    _need(commands and all(item['exit'] == 0 and item['worker_reaped'] is True
          and item['group_absent'] is True and item['signals'] == []
          and item['guard_error'] is None for item in commands), 'audit_check_not_clean:' + name)
    return {'status': 'passed', 'exit': 0, 'worker_reaped': True,
            'group_absent': True, 'signals': [], 'guard_error': None,
            'command_count': len(commands), 'commands': commands}


def _decode(output, reason):
    try:
        return output.decode('utf-8', 'strict')
    except UnicodeDecodeError as error:
        raise AuditRefused(reason) from error


def _parse_otool_header(output):
    text = _decode(output, 'otool_header_not_utf8')
    recognized = {'MH_MAGIC', 'MH_MAGIC_64', 'MH_CIGAM', 'MH_CIGAM_64'}
    filetypes = []
    for line in text.splitlines():
        columns = line.split()
        if columns and columns[0] in recognized:
            _need(len(columns) >= 8, 'otool_header_row_incomplete')
            filetypes.append(columns[4])
    _need(filetypes and len(set(filetypes)) == 1
          and filetypes[0] in {'EXECUTE', 'DYLIB', 'BUNDLE'},
          'macho_filetype_missing_ambiguous_or_unsupported')
    return filetypes[0]


def _parse_otool_l(output):
    text = _decode(output, 'otool_load_commands_not_utf8')
    rpaths, install_id, command = [], None, None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('cmd '):
            command = stripped[4:]
        elif command == 'LC_RPATH' and stripped.startswith('path '):
            rpaths.append(stripped[5:].split(' (offset ', 1)[0])
            command = None
        elif command == 'LC_ID_DYLIB' and stripped.startswith('name '):
            install_id = stripped[5:].split(' (offset ', 1)[0]
            command = None
    return rpaths, install_id


def _parse_otool_libraries(output, install_id):
    text = _decode(output, 'otool_libraries_not_utf8')
    rows = []
    for line in text.splitlines()[1:]:
        stripped = line.strip()
        if not stripped:
            continue
        name = stripped.split(' (compatibility version ', 1)[0]
        _need(name and not any(ord(char) < 32 or ord(char) == 127 for char in name),
              'otool_dependency_line_invalid')
        rows.append(name)
    if install_id is not None:
        _need(rows and rows[0] == install_id, 'otool_install_id_position_mismatch')
        rows = rows[1:]
    return rows


def _normalize_runtime_candidate(root, candidate):
    candidate = Path(os.path.normpath(str(candidate)))
    _need(candidate.is_absolute() and candidate.is_relative_to(root),
          'dependency_path_outside_bundle')
    relative = candidate.relative_to(root).as_posix()
    _safe_relative(relative)
    return relative


def _resolve_inventory_path(relative, actual):
    """Follow only the finalizer-pinned symlink inventory; never walk by resolve()."""
    current = relative
    seen = set()
    for _index in range(32):
        _need(current not in seen, 'runtime_symlink_cycle')
        seen.add(current)
        row = actual.get(current)
        _need(row is not None, 'runtime_symlink_target_unlisted')
        if row['kind'] in {'file', 'directory'}:
            return current
        _need(row['kind'] == 'symlink', 'runtime_symlink_target_not_declared')
        target = row['target']
        parts = list(PurePosixPath(current).parent.parts)
        for token in target.split('/'):
            if token in ('', '.'):
                continue
            if token == '..':
                _need(len(parts) > 0, 'runtime_symlink_escapes_bundle_root')
                parts.pop()
            else:
                parts.append(token)
        current = '/'.join(parts)
        _safe_relative(current)
    raise AuditRefused('runtime_symlink_chain_bound')


def _expand_loader_path(value, image_path, executable_path, root):
    if value == '@loader_path' or value.startswith('@loader_path/'):
        suffix = value[len('@loader_path'):].lstrip('/')
        return Path(root, image_path).parent / suffix
    if value == '@executable_path' or value.startswith('@executable_path/'):
        suffix = value[len('@executable_path'):].lstrip('/')
        return Path(root, executable_path).parent / suffix
    if value.startswith('/'):
        return Path(value)
    raise AuditRefused('unresolved_rpath_token')


def _resolve_dependency(dep, image_path, executable_path, rpath_stack, root, actual):
    _need(not any(marker in dep for marker in BUILD_PATH_MARKERS), 'build_path_in_load_command')
    if dep.startswith(SYSTEM_LIBRARY_ROOTS):
        return None
    if dep.startswith('/'):
        raise AuditRefused('absolute_non_system_dependency_refused')
    if (dep == '@loader_path' or dep.startswith('@loader_path/')
            or dep == '@executable_path' or dep.startswith('@executable_path/')):
        candidate = _expand_loader_path(dep, image_path, executable_path, root)
        resolved = _resolve_inventory_path(_normalize_runtime_candidate(root, candidate), actual)
        _need(actual[resolved]['kind'] == 'file', 'dependency_target_not_regular_file')
        return resolved
    if dep.startswith('@rpath/'):
        suffix = dep[len('@rpath/'):]
        _need(suffix and '..' not in PurePosixPath(suffix).parts, 'unsafe_rpath_dependency')
        hits = set()
        for rpath, rpath_image in rpath_stack:
            if rpath.startswith(SYSTEM_LIBRARY_ROOTS):
                candidate = Path(rpath) / suffix
                if str(candidate).startswith(SYSTEM_LIBRARY_ROOTS):
                    hits.add(None)
                continue
            expanded = _expand_loader_path(rpath, rpath_image, executable_path, root)
            candidate = expanded / suffix
            try:
                resolved = _resolve_inventory_path(
                    _normalize_runtime_candidate(root, candidate), actual)
                if actual[resolved]['kind'] == 'file':
                    hits.add(resolved)
            except AuditRefused:
                continue
        _need(len(hits) == 1, 'rpath_dependency_unresolved_or_ambiguous_in_image_context')
        return next(iter(hits))
    raise AuditRefused('relative_or_unknown_dependency_name')


def _verify_rpath_syntax(rpaths, image_path, executable_path, root, actual):
    for value in rpaths:
        _need(type(value) is str and value and not any(marker in value for marker in BUILD_PATH_MARKERS),
              'build_path_in_rpath')
        if value.startswith(SYSTEM_LIBRARY_ROOTS):
            continue
        _need(value == '@loader_path' or value.startswith('@loader_path/')
              or value == '@executable_path' or value.startswith('@executable_path/'),
              'unsupported_rpath_token')
        candidate = _expand_loader_path(value, image_path, executable_path, root)
        normalized = _normalize_runtime_candidate(root, candidate)
        resolved = _resolve_inventory_path(normalized, actual)
        _need(actual[resolved]['kind'] == 'directory', 'rpath_not_a_declared_directory')


def _analyze_macho_graph(root, actual, macho_rows, runner, env, tools, owner_admission, trace):
    images = {}
    contexts = owner_admission['dynamic_image_contexts']
    _need(set(contexts) <= set(macho_rows), 'dynamic_image_context_names_undeclared_macho')
    arm_commands = []
    dependency_commands = []
    rpath_commands = []
    for relative in macho_rows:
        _need(len(images) < MAX_MACHO_FILES, 'macho_file_count_bound')
        path = root / relative
        arm = _invoke(runner, tools['lipo'], owner_admission['tool_pins']['lipo'],
                      ['-archs', str(path)], root, env, owner_admission,
                      check_name='macho_arm64', trace=trace)
        architectures = set(_decode(arm, 'lipo_output_not_utf8').split())
        _need('arm64' in architectures, 'macho_arm64_missing')
        arm_commands.extend(trace[-1:])
        header = _invoke(runner, tools['otool'], owner_admission['tool_pins']['otool'],
                         ['-arch', 'arm64', '-hv', str(path)], root, env, owner_admission,
                         check_name='macho_arm64', trace=trace)
        filetype = _parse_otool_header(header)
        if filetype == 'EXECUTE':
            _need(relative not in contexts, 'main_executable_must_not_have_dynamic_context_row')
        else:
            _need(relative in contexts, 'dynamic_macho_context_missing')
        arm_commands.extend(trace[-1:])
        load = _invoke(runner, tools['otool'], owner_admission['tool_pins']['otool'],
                       ['-arch', 'arm64', '-l', str(path)], root, env, owner_admission,
                       check_name='macho_rpaths', trace=trace)
        rpath_commands.append(trace[-1])
        rpaths, install_id = _parse_otool_l(load)
        libraries = _invoke(runner, tools['otool'], owner_admission['tool_pins']['otool'],
                            ['-arch', 'arm64', '-L', str(path)], root, env, owner_admission,
                            check_name='macho_dependencies', trace=trace)
        dependency_commands.append(trace[-1])
        dependencies = _parse_otool_libraries(libraries, install_id)
        images[relative] = {'rpaths': rpaths, 'dependencies': dependencies,
                            'filetype': filetype, 'executable': filetype == 'EXECUTE'}
    _need(images, 'macho_images_required')
    executables = {name for name, row in images.items() if row['executable']}
    _need(executables, 'macho_main_executable_context_required')
    dynamic_images = set(images) - executables
    _need(set(contexts) == dynamic_images, 'exact_owner_reviewed_dynamic_image_contexts_required')
    reached = set()
    reached_by_main = {}
    for main in sorted(executables):
        def visit(image, inherited, visiting, main_image):
            _need(image in images, 'macho_dependency_not_scanned')
            reached.add(image)
            reached_by_main.setdefault(image, set()).add(main_image)
            if image in visiting:
                return
            row = images[image]
            _verify_rpath_syntax(row['rpaths'], image, main_image, root, actual)
            stack = tuple(inherited) + tuple((rpath, image) for rpath in row['rpaths'])
            for dependency in row['dependencies']:
                target = _resolve_dependency(dependency, image, main_image, stack, root, actual)
                if target is not None and target in images:
                    visit(target, stack, visiting | {image}, main_image)
                elif target is not None:
                    _need(target in images, 'macho_dependency_not_scanned')
        visit(main, (), set(), main)
    for image in sorted(dynamic_images):
        declared_mains = set(contexts[image])
        _need(declared_mains and declared_mains <= executables,
              'dynamic_image_context_must_name_verified_MH_EXECUTE')
        _need(reached_by_main.get(image, set()) <= declared_mains,
              'dynamic_image_static_context_not_owner_declared')
        for main in sorted(declared_mains):
            main_row = images[main]
            main_stack = tuple((rpath, main) for rpath in main_row['rpaths'])
            visit(image, main_stack, set(), main)
    _need(reached == set(images), 'macho_image_without_main_executable_context')
    context_digest = hashlib.sha256(json.dumps(contexts, sort_keys=True,
        separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
    return (_command_check('macho_arm64', arm_commands),
            _command_check('macho_dependencies', dependency_commands),
            _command_check('macho_rpaths', rpath_commands), images, context_digest)


def _run_small_check(name, executable, argv, root, env, runner, trace, *, timeout=MAX_COMMAND_SECONDS,
                     executable_pin, owner_admission, private_inputs=None, merge_stderr=False):
    before = len(trace)
    output = _invoke(runner, executable, executable_pin, argv, root, env, owner_admission,
                     check_name=name, timeout=timeout, private_inputs=private_inputs,
                     merge_stderr=merge_stderr, trace=trace)
    return output, _command_check(name, trace[before:])


def _verify_tools_and_petta_role(root, actual, owner_admission):
    # actual is the complete, declared-child-checked inventory from _inventory_bundle.
    swi_bin = actual.get('swipl/bin')
    _need(type(swi_bin) is dict and swi_bin.get('kind') == 'directory',
          'petta_PATH_swi_bin_real_directory_required')
    _need(not any(name.casefold() == 'swipl/bin/dirname' for name in actual),
          'petta_PATH_dirname_shadow_refused')
    tools = _tool_pins(owner_admission)
    petta = owner_admission['petta_entrypoint']
    _need(type(petta) is dict and petta == PETTA_SCRIPT_PIN,
          'exact_petta_run_sh_pin_unbound')
    row = actual.get(petta['path'])
    _need(row is not None and row['kind'] == 'file' and row['bytes'] == petta['bytes']
          and row['sha256'] == petta['sha256'] and row['mode'] & 0o111,
          'pinned_petta_entrypoint_inventory_mismatch')
    return tools


def _bundle_pin(root, relative, actual):
    _safe_relative(relative)
    resolved = _resolve_inventory_path(relative, actual)
    row = actual.get(resolved)
    _need(row is not None and row.get('kind') == 'file'
          and type(row.get('bytes')) is int and _valid_sha(row.get('sha256')),
          'bundle_executable_pin_required:' + relative)
    _need(row.get('mode', 0) & 0o111, 'bundle_executable_mode_required:' + relative)
    return {'path': str(root / resolved), 'bytes': row['bytes'], 'sha256': row['sha256']}


def _verify_environment_checks(root, actual, runner, env, trace, tools, owner_admission):
    python_pin = _bundle_pin(root, 'python/bin/python3.12', actual)
    node_pin = _bundle_pin(root, 'node/bin/node', actual)
    swipl_pin = _bundle_pin(root, 'swipl/bin/swipl', actual)
    # Inventory resolution may identify a pinned in-bundle symlink. Execute the
    # exact regular target whose held bytes were inventoried, never an
    # unpinned alias that the adapter would have to resolve independently.
    python, node, swipl = (python_pin['path'], node_pin['path'], swipl_pin['path'])
    checks = {}
    import_code = (
        "import importlib,sys; assert sys.version_info[:3]==(3,12,15); "
        "names=('fastapi','starlette','httpx','uvicorn','pytest'); "
        "[importlib.import_module(name) for name in names]; "
        "print(sys.version.split()[0]); print('\\n'.join(names))"
    )
    output, checks['python_core_imports'] = _run_small_check(
        'python_core_imports', python, ['-I', '-B', '-c', import_code],
        root, env, runner, trace, executable_pin=python_pin, owner_admission=owner_admission)
    _need(_decode(output, 'core_import_output_not_utf8').splitlines()
          == [EXPECTED_PYTHON_VERSION, *CORE_IMPORTS],
          'representative_core_import_matrix_failed')
    output, checks['node_version'] = _run_small_check(
        'node_version', node, ['--version'], root, env, runner, trace,
        executable_pin=node_pin, owner_admission=owner_admission)
    _need(_decode(output, 'node_version_output_not_utf8').strip() == EXPECTED_NODE_VERSION,
          'pinned_node_version_mismatch')
    output, checks['swipl_version'] = _run_small_check(
        'swipl_version', swipl, ['--version'], root, env, runner, trace,
        executable_pin=swipl_pin, owner_admission=owner_admission)
    _need(_decode(output, 'swipl_version_output_not_utf8').startswith(EXPECTED_SWIPL_VERSION),
          'pinned_swipl_version_mismatch')
    py_code = 'import janus_swi as j; r=j.query_once("X is 1+1"); assert r.get("X")==2, r'
    output, py_check = _run_small_check(
        'janus_bridge', python, ['-I', '-B', '-c', py_code], root, env, runner, trace,
        executable_pin=python_pin, owner_admission=owner_admission)
    _need(output == b'', 'janus_python_prolog_output_unexpected')
    prolog_goal = 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt'
    output, prolog_check = _run_small_check(
        'janus_bridge', swipl, ['-g', prolog_goal], root, env, runner, trace,
        executable_pin=swipl_pin, owner_admission=owner_admission)
    _need(output == b'42\n', 'janus_prolog_python_result_mismatch')
    checks['janus_bridge'] = _command_check('janus_bridge',
        py_check['commands'] + prolog_check['commands'])
    petta_program = PETTA_PROGRAM
    _need(len(petta_program) == 28 and hashlib.sha256(petta_program).hexdigest() == PETTA_PROGRAM_SHA256,
          'source_pinned_petta_program_mismatch')
    petta_script = str(root / 'PeTTa/run.sh')
    output, checks['petta_eval'] = _run_small_check(
        'petta_eval', '/bin/sh', [petta_script, '@private_input:petta-smoke.metta'],
        root, env, runner, trace, timeout=60,
        executable_pin=owner_admission['tool_pins']['sh'], owner_admission=owner_admission,
        private_inputs={'petta-smoke.metta': petta_program}, merge_stderr=True)
    text = _decode(output, 'petta_output_not_utf8')
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', text)
    lines = [line for line in text.splitlines() if line.strip()]
    _need(lines and lines[-1] == '42', 'petta_evaluation_result_mismatch')
    return checks


def _audit_bundle(root, context, process_runner):
    started = time.monotonic()
    _check_context(root, context)
    admission, task_valid_until, resource_valid_until = _read_owner_admission(context)
    controller_deadline = getattr(process_runner, 'whole_attempt_deadline', None)
    _need(type(controller_deadline) in {int, float}
          and started < controller_deadline - 300
          and controller_deadline <= started + CONTROLLER_SECONDS,
          'fresh_whole_controller_deadline_with_cleanup_reserve_required')
    runner_pin = admission['process_runner_pin']
    _need(getattr(process_runner, 'source_path', None) == runner_pin['path'],
          'pinned_process_runner_path_mismatch')
    _runner_source, runner_sha, _prefix, _runner_info = _read_regular(
        runner_pin['path'], maximum=2 * 1024**2, expected_bytes=runner_pin['bytes'],
        owner_uid=admission['owner_uid'])
    _need(runner_sha == runner_pin['sha256'], 'pinned_process_runner_source_mismatch')
    _need(callable(getattr(process_runner, 'run', None))
          and callable(getattr(process_runner, 'environment', None)),
          'pinned_owned_process_runner_required')
    _need(getattr(process_runner, 'source_sha256', None) == runner_pin['sha256'],
          'loaded_process_runner_source_digest_mismatch')
    values, native_inputs, expected_inventory, content_sha = _read_context_evidence(context, admission)
    _need(type(native_inputs) is dict, 'held_native_input_object_required')
    _need(time.time() + MAX_AUDIT_SECONDS <= admission['valid_until_epoch']
          and time.time() + MAX_AUDIT_SECONDS <= task_valid_until
          and time.time() + MAX_AUDIT_SECONDS <= resource_valid_until,
          'owner_admission_expired_before_runtime_inventory')
    actual_root = Path(root)
    deadline = min(started + MAX_AUDIT_SECONDS, controller_deadline - 300)
    actual, macho_rows, byte_count = _inventory_bundle(
        actual_root, expected_inventory, deadline, admission['owner_uid'], context['audit_kind'])
    actual_rows = []
    for name, row in actual.items():
        item = {'path': name, 'kind': row['kind']}
        item.update({key: row[key] for key in ('bytes', 'sha256', 'target') if key in row})
        actual_rows.append(item)
    _need(_content_inventory_sha256(actual_rows) == content_sha,
          'audited_runtime_content_differs_from_finalization')
    _need(len(macho_rows) <= MAX_MACHO_FILES, 'macho_file_count_bound')
    tools = _verify_tools_and_petta_role(actual_root, actual, admission)
    env = _private_environment(process_runner, actual_root, admission['owner_uid'])
    trace = [{'started': started, 'deadline': deadline, 'controller_deadline': controller_deadline,
              'log_bytes': 0,
              'combined_rss_peak_bytes': 0,
              'task_valid_until_epoch': task_valid_until,
              'resource_valid_until_epoch': resource_valid_until}]
    arm_check, dependency_check, rpath_check, _images, image_context_sha256 = _analyze_macho_graph(
        actual_root, actual, macho_rows, process_runner, env, tools, admission, trace)
    checks = {
        'macho_arm64': arm_check,
        'macho_dependencies': dependency_check,
        'macho_rpaths': rpath_check,
    }
    checks.update(_verify_environment_checks(
        actual_root, actual, process_runner, env, trace, tools, admission))
    _need(set(checks) == CHECKS, 'exact_eight_check_matrix_required')
    # Detect any probe that changed, added, or removed runtime content.
    after, _after_macho, after_bytes = _inventory_bundle(
        actual_root, expected_inventory, deadline, admission['owner_uid'], context['audit_kind'])
    after_rows = []
    for name, row in after.items():
        item = {'path': name, 'kind': row['kind']}
        item.update({key: row[key] for key in ('bytes', 'sha256', 'target') if key in row})
        after_rows.append(item)
    _need(after_bytes == byte_count and _content_inventory_sha256(after_rows) == content_sha,
          'runtime_content_changed_during_audit')
    _need(time.monotonic() < deadline, 'audit_wall_deadline')
    _need(time.time() < admission['valid_until_epoch'], 'owner_admission_expired_during_audit')
    _need(time.time() < task_valid_until and time.time() < resource_valid_until,
          'task_or_resource_admission_expired_during_audit')
    native_pin = context['evidence']['native_phases']
    final_pin = context['evidence']['finalization']
    result = {
        'schema': 'studio-Mac-CI-native-audit-check-result/1',
        'status': 'EIGHT_RUNTIME_CHECKS_PASS',
        'source_bundle_root': str(ORIGINAL_BUNDLE),
        'audited_bundle_root': str(actual_root),
        'content_inventory_sha256': content_sha,
        'finalization_receipt_sha256': final_pin['sha256'],
        'native_phase_receipt_sha256': native_pin['sha256'],
        'job_identity': context['job_identity'],
        'execution_owner': context['execution_owner'],
        'origin_machine': context['origin_machine'],
        'audit_kind': context['audit_kind'],
        'candidate_source_sha256': admission['candidate_source_sha256'],
        'review_manifest_sha256': admission['review_manifest_sha256'],
        'owner_admission_pin': context['owner_admission'],
        'active_finalizer_source_pin': admission['finalizer_source_pin'],
        'process_runner_pin': admission['process_runner_pin'],
        'task_id': admission['task_id'],
        'resource_id': admission['resource_id'],
        'runtime_file_count': len(actual),
        'runtime_bytes': byte_count,
        'macho_file_count': len(macho_rows),
        'dynamic_image_contexts_sha256': image_context_sha256,
        'checks': checks,
        'command_count': len(trace) - 1,
        'elapsed_seconds': time.monotonic() - started,
        'qualification': 'Native runtime input checks only; app, UI, installer, and release qualification remain separate.',
    }
    _need(len(json.dumps(result, sort_keys=True, separators=(',', ':'),
                         ensure_ascii=True).encode()) <= AGGREGATE_LOG_LIMIT,
          'audit_result_metadata_byte_bound')
    return result


def audit_bundle(root, finalization_context, process_runner):
    """Rerunnable eight-check API for original or fresh relocated bundle.

    The source root remains the original native output in both modes; `root`
    names the actual image under audit. It never invokes the shared full
    evidence validator because that contract requires this audit and relocation
    receipts as inputs. A separate owner wrapper must retain failed attempts and
    write the exclusive receipt only after this API returns.
    """
    return _audit_bundle(root, finalization_context, process_runner)


def main():
    raise AuditRefused('audit_API_requires_fresh_owner_admission_and_reviewed_stage2_wrapper')


if __name__ == '__main__':
    main()
