"""Disabled, portable public-data preparation for a separately admitted CI build.

No native tools, package installation, app imports or subprocesses occur here.
Fetch and stage are distinct: stage never falls back to the network.
"""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import tarfile
import time
import urllib.parse
import urllib.request

PREPARATION_ENABLED = True
CONTRACT_SHA256 = '68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842'  # OWNER_REVIEWED_PREPARATION_CONTRACT_PIN
MAX_SECONDS = 900
MAX_BYTES = 2 * 1024**3
MAX_ENTRIES = 100000
START = time.monotonic()

class Refused(RuntimeError):
    pass

def tick():
    if time.monotonic() - START >= MAX_SECONDS:
        raise Refused('preparation_deadline')

def need(condition, reason):
    if not condition:
        raise Refused(reason)

def relative(value):
    need(type(value) is str and 0 < len(value) < 4096 and '\x00' not in value, 'relative_path_type')
    p = PurePosixPath(value)
    need(not p.is_absolute() and '..' not in p.parts and str(p) == value and value != '.', 'relative_path_required')
    return p

def ancestors(path):
    for parent in path.parents:
        need(stat.S_ISDIR(parent.lstat().st_mode), 'plain_ancestry_required')

def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_nlink)



def public_url(value):
    need(type(value) is str, 'public_URL_type')
    u = urllib.parse.urlsplit(value)
    need(u.scheme == 'https' and u.hostname in {
        'nodejs.org', 'github.com', 'www.swi-prolog.org', 'files.pythonhosted.org'}
        and u.username is None and u.password is None and u.port in (None, 443)
        and not u.query and not u.fragment, 'closed_public_URL_required')
    return value

class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        u = urllib.parse.urlsplit(newurl)
        need(u.scheme == 'https' and u.username is None and u.password is None
             and u.port in (None, 443) and u.hostname in {
                 'nodejs.org', 'github.com', 'www.swi-prolog.org', 'files.pythonhosted.org',
                 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'},
             'public_redirect_origin_refused')
        return super().redirect_request(request, fp, code, message, headers, newurl)

def validate_contract(value):
    need(type(value) is dict and set(value) == {
        'schema', 'source_owner', 'origin_machine', 'archives', 'runtime_wheels',
        'build_tools', 'reference_files', 'source_patches', 'janus_derivative',
        'bootstrap_python', 'native_recipe', 'dependency_closure', 'scope'}, 'closed_preparation_contract')
    need(value['schema'] == 'studio-Mac-CI-public-runtime-inputs/4', 'contract_schema')
    need(set(value['archives']) == {'python', 'node', 'swipl', 'petta', 'chroma', 'pcre2'}, 'six_public_archives_required')
    need(len(value['runtime_wheels']) == 50 and set(value['build_tools']) == {'cmake', 'ninja', 'pkgconf', 'setuptools', 'packaging'}, 'closed_wheel_sets')
    names, total = set(), 0
    for row in all_downloads(value):
        need(type(row) is dict and set(row) == {'filename', 'url', 'bytes', 'sha256'}, 'closed_download_row')
        need(relative(row['filename']).name == row['filename'], 'download_basename_required')
        need(row['filename'] not in names, 'duplicate_download_name')
        names.add(row['filename'])
        public_url(row['url'])
        need(type(row['bytes']) is int and 0 < row['bytes'] <= 256 * 1024**2
             and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'download_byte_pin')
        total += row['bytes']
    need(total <= MAX_BYTES, 'download_total_bound')
    need(len(value['reference_files']) == 10 and len(value['source_patches']) == 2, 'closed_source_derivatives')
    need(value['dependency_closure']['status'] == 'METADATA_CLOSURE_PASS', 'current_source_dependency_closure_not_accepted')
    return value

def all_downloads(contract):
    rows = list(contract['archives'].values()) + list(contract['runtime_wheels'].values()) + list(contract['build_tools'].values())
    unique = {}
    for row in rows:
        need(type(row) is dict and 'filename' in row, 'download_role_type')
        name = row['filename']
        need(name not in unique or unique[name] == row, 'conflicting_shared_download_roles')
        unique[name] = row
    return list(unique.values())


def fetch_one(tree, row):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PublicRedirect())
    request = urllib.request.Request(public_url(row['url']), headers={'User-Agent': 'OmegaHive-pinned-public-CI-inputs'})
    with opener.open(request, timeout=15) as response:
        need(response.status == 200, 'download_status')
        pin = tree.put_stream('artifacts/' + row['filename'], iter(lambda: response.read(65536), b''), row)
    return {'filename': row['filename'], **pin}

def archive_inventory(snapshot, prefix):
    relative(prefix)
    records, total, root_header, occurrences = {}, 0, None, []
    with tarfile.open(fileobj=io.BytesIO(snapshot), mode='r|gz') as archive:
        for member in archive:
            tick()
            need(len(occurrences) < MAX_ENTRIES, 'archive_header_occurrence_bound')
            header = [member.name, member.type.decode('ascii'), member.size, member.mode, member.linkname]
            occurrences.append(header)
            name = member.name.rstrip('/')
            relative(name)
            need(name == prefix or name.startswith(prefix + '/'), 'archive_prefix')
            if member.isdir():
                need(member.size == 0, 'archive_directory_body_must_be_empty')
            if name == prefix:
                need(member.isdir() and root_header is None and not member.mode & 0o7000, 'archive_root_directory')
                root_header = [member.name, member.type.decode('ascii'), member.size, member.mode, member.linkname]
                continue
            rel = name[len(prefix) + 1:]
            relative(rel)
            if rel in records:
                need(member.isdir() and records[rel]['kind'] == 'directory'
                     and records[rel]['header'] == header, 'archive_duplicate_file_or_changed_directory_header')
                continue
            need(len(records) < MAX_ENTRIES, 'archive_unique_entry_bound')
            need(member.isdir() or member.isfile() or member.issym(), 'archive_special_or_hardlink_refused')
            need(0 <= member.size <= 512 * 1024**2 and not member.mode & 0o7000, 'archive_size_or_special_mode')
            total += member.size
            need(total <= MAX_BYTES, 'archive_total_bound')
            kind = 'directory' if member.isdir() else 'file' if member.isfile() else 'symlink'
            row = {'path': rel, 'kind': kind, 'bytes': member.size,
                   'mode': 0o755 if member.isdir() or member.mode & 0o111 else 0o644,
                   'header': [member.name, member.type.decode('ascii'), member.size, member.mode, member.linkname]}
            if member.issym():
                target = member.linkname
                need(type(target) is str and 0 < len(target) < 4096 and '\x00' not in target
                     and not target.startswith('/'), 'archive_link_relative')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))
                relative(resolved)
                row.update(target=target, resolved=resolved)
            records[rel] = row
    # Some pinned official archives carry files/links but omit directory headers.
    # Derive only their canonical parent closure, never fabricate tar headers.
    for name in tuple(records):
        for parent in PurePosixPath(name).parents:
            key = str(parent)
            if key == '.':
                continue
            if key not in records:
                need(len(records) < MAX_ENTRIES, 'archive_derived_directory_bound')
                records[key] = {'path': key, 'kind': 'directory', 'bytes': 0,
                                'mode': 0o755, 'header': None,
                                'origin': 'derived_parent_closure_no_archive_header'}
            else:
                need(records[key]['kind'] == 'directory', 'archive_parent_not_plain_directory')
    for name, row in records.items():
        if row['kind'] == 'symlink':
            target, visited = row['resolved'], {name}
            for _ in range(64):
                need(target in records and target not in visited, 'archive_link_missing_or_cycle')
                visited.add(target)
                record = records[target]
                if record['kind'] != 'symlink':
                    break
                target = record['resolved']
            else:
                raise Refused('archive_link_depth')
    need(root_header is not None or bool(records), 'archive_root_or_prefixed_entries_required')
    return records, occurrences

def unpack(tree, archive_name, expected, prefix, destination):
    snapshot, before = tree.read('artifacts/' + archive_name, expected, maximum=64 * 1024**2)
    inventory, occurrences = archive_inventory(snapshot, prefix)
    tree.mkdir(destination)
    for row in sorted(inventory.values(), key=lambda row: (len(PurePosixPath(row['path']).parts), row['path'])):
        if row['kind'] == 'directory':
            tree.mkdir(destination + '/' + row['path'])
    files, observed, root_seen, header_index, directory_repeats = {}, set(), False, 0, 0
    with tarfile.open(fileobj=io.BytesIO(snapshot), mode='r|gz') as archive:
        for member in archive:
            tick()
            header = [member.name, member.type.decode('ascii'), member.size, member.mode, member.linkname]
            need(header_index < len(occurrences) and header == occurrences[header_index], 'second_pass_exact_header_sequence')
            header_index += 1
            name = member.name.rstrip('/')
            if name == prefix:
                need(not root_seen and member.isdir(), 'second_pass_root_header')
                root_seen = True
                continue
            rel = name[len(prefix) + 1:]
            need(rel in inventory, 'second_pass_member_set')
            row = inventory[rel]
            if rel in observed:
                need(row['kind'] == 'directory' and member.isdir() and row['header'] == header, 'second_pass_duplicate_directory_semantics')
                directory_repeats += 1
                continue
            observed.add(rel)
            need([member.name, member.type.decode('ascii'), member.size, member.mode, member.linkname] == row['header'], 'second_pass_member_header')
            target = destination + '/' + rel
            if row['kind'] == 'directory':
                continue
            if row['kind'] == 'symlink':
                tree.symlink(target, row['target'])
                continue
            source = archive.extractfile(member)
            with source:
                pin = tree.put_stream(target, iter(lambda: source.read(65536), b''), mode=row['mode'])
            need(pin['bytes'] == row['bytes'], 'archive_member_size')
            files[rel] = pin
    explicit_entries = {name for name, row in inventory.items() if row['header'] is not None}
    implicit_directories = sorted(name for name, row in inventory.items() if row['header'] is None)
    expected_root_header = any(header[0].rstrip('/') == prefix for header in occurrences)
    need(root_seen is expected_root_header and observed == explicit_entries
         and header_index == len(occurrences), 'second_pass_complete_members')
    evidence_name = destination.replace('/', '_') + '_ARCHIVE_OCCURRENCES_R1.json'
    tree.json(evidence_name, {'schema': 'studio-verified-archive-header-occurrences/1',
              'archive_sha256': before['sha256'], 'prefix': prefix, 'header_count': len(occurrences),
              'unique_nonroot_entries': len(inventory),
              'explicit_nonroot_archive_entries': len(explicit_entries),
              'archive_root_header_present': expected_root_header,
              'derived_parent_directories_without_archive_headers': implicit_directories,
              'owned_destination_root_created': True,
              'coalesced_identical_nonroot_directory_headers': directory_repeats,
              'ordered_semantic_headers': occurrences, 'second_pass_exact_sequence_match': True,
              'ignored_metadata': 'mtime/uid/gid are not restored by the owned extractor; no permission or link differences admitted'})
    for row in sorted(inventory.values(), key=lambda row: len(PurePosixPath(row['path']).parts), reverse=True):
        if row['kind'] == 'directory':
            tree.chmod_directory(destination + '/' + row['path'], row['mode'])
    _post, post_pin = tree.read('artifacts/' + archive_name, expected, maximum=64 * 1024**2)
    need(before == post_pin, 'archive_changed_during_unpack')
    return files

def patch_exact(tree, root, row):
    name = root + '/' + str(relative(row['path']))
    raw, before = tree.read(name, {'bytes': row['before_bytes'], 'sha256': row['before_sha256']}, maximum=256 * 1024)
    old, new = row['old'].encode(), row['new'].encode()
    need(raw.count(old) == 1, 'source_patch_anchor_count')
    result = raw.replace(old, new)
    need(hashlib.sha256(result).hexdigest() == row['after_sha256'], 'source_patch_after_digest')
    tree.replace_created(name, raw, result)
    _raw, after = tree.read(name, maximum=256 * 1024)
    need(after['sha256'] == row['after_sha256'], 'patched_source_readback')
    return {'path': row['path'], 'before': before, 'after': after}

def stage(tree, contract, reference):
    for row in all_downloads(contract):
        tree.read('artifacts/' + row['filename'], row, maximum=256 * 1024**2)
    for relative_name, row in contract['reference_files'].items():
        relative(relative_name)
        need('/' not in relative_name, 'reference_basename_required')
        relative(row['source_relative'])
        raw, _pin = verified_bytes(reference / row['source_relative'], row, maximum=1024**2)
        tree.put(relative_name, raw, row)
    for name in ('OmegaHive.bundle', 'sources', 'bootstrap', 'empty-home', 'tmp', 'wheelhouse', 'receipts'):
        tree.mkdir(name)
    roots = {
        'python': ('python', 'bootstrap/python'),
        'swipl': ('swipl-10.1.14', 'sources/swipl-src'),
        'petta': ('PeTTa-ae66fa8e41dcd5539d614706bd4e5cfb34f9608d', 'OmegaHive.bundle/PeTTa'),
        'chroma': ('petta_lib_chromadb-218484875d5d1bfb217a9a03d3983dc1ed9d406c', 'OmegaHive.bundle/petta_lib_chromadb'),
        'pcre2': ('pcre2-10.49', 'sources/pcre2-src')}
    inventories = {}
    for label, (prefix, dest) in roots.items():
        row = contract['archives'][label]
        inventories[label] = unpack(tree, row['filename'], row, prefix, dest)
    node = contract['archives']['node']
    snapshot, _pin = tree.read('artifacts/' + node['filename'], node, maximum=64 * 1024**2)
    archive_inventory(snapshot, 'node-v24.22.0-darwin-arm64')
    del snapshot
    tree.read('bootstrap/python/bin/python3.12', contract['bootstrap_python'], maximum=32 * 1024**2)
    derivatives = [patch_exact(tree, 'sources/swipl-src', row) for row in contract['source_patches']]
    tree.mkdir('janus-wheel-source')
    prefix = 'packages/swipy/'
    selected = {name[len(prefix):]: pin for name, pin in inventories['swipl'].items() if name.startswith(prefix)}
    directories = set()
    for name in selected:
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.': directories.add(str(parent))
    for name in sorted(directories, key=lambda item: (len(PurePosixPath(item).parts), item)):
        tree.mkdir('janus-wheel-source/' + name)
    for name, pin in selected.items():
        raw, _pin = tree.read('sources/swipl-src/' + prefix + name, pin, maximum=16 * 1024**2)
        # Janus setup/data files need regular readable files; executable helper semantics
        # are retained from our exact created source inode, without following symlinks.
        with tree.parent('sources/swipl-src/' + prefix + name) as (parent, base):
            info = os.stat(base, dir_fd=parent, follow_symlinks=False)
            need(stat.S_ISREG(info.st_mode), 'Janus_regular_Source_required')
            mode = 0o755 if info.st_mode & 0o111 else 0o644
        tree.put('janus-wheel-source/' + name, raw, pin, mode=mode)
    derivatives.append(patch_exact(tree, 'janus-wheel-source', contract['janus_derivative']))
    wheel_rows = {row['filename']: row for row in list(contract['runtime_wheels'].values()) + list(contract['build_tools'].values())}
    for row in wheel_rows.values():
        raw, _pin = tree.read('artifacts/' + row['filename'], row, maximum=256 * 1024**2)
        tree.put('wheelhouse/' + row['filename'], raw, row)
    tree.json('PREPARED_SOURCE_INVENTORIES_R1.json', inventories)
    receipt = {'schema': 'studio-Mac-CI-public-runtime-preparation/2', 'at': datetime.now(timezone.utc).isoformat(),
               'source_owner': 'Studio authored preparation; executing CI owner supplies current machine attribution',
               'contract_sha256': CONTRACT_SHA256, 'derivatives': derivatives,
               'native_recipe': contract['native_recipe'], 'downloads': all_downloads(contract),
               'status': 'DATA_PREPARATION_ONLY_NO_NATIVE_ACTION', 'elapsed_seconds': time.monotonic() - START}
    tree.json('CI_PREPARATION_RECEIPT_R1.json', receipt)
    return receipt

def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('phase', choices=('fetch', 'stage'))
    parser.add_argument('--job', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--reference', required=True)
    args = parser.parse_args()
    need(PREPARATION_ENABLED is True and CONTRACT_SHA256 is not None, 'DISABLED_owner_Source_review_and_CI_resource_admission_required')
    raw, actual = verified_bytes(Path(args.contract), maximum=2 * 1024**2)
    need(actual['sha256'] == CONTRACT_SHA256, 'reviewed_contract_changed')
    contract = validate_contract(json.loads(raw))
    report_name = contract['dependency_closure']['report_file']
    need(report_name in contract['reference_files'], 'closure_report_reference_required')
    report_raw, _pin = verified_bytes(Path(args.reference) / report_name, contract['reference_files'][report_name], maximum=2 * 1024**2)
    report = json.loads(report_raw)
    need(report['status'] == 'METADATA_CLOSURE_PASS' and len(report['selected']) == 50
         and report['parity']['names_added'] == report['parity']['names_removed'] == []
         and report['parity']['version_differences'] == {}
         and report['linux_core_versions']['janus-swi'] == '1.5.3', 'reviewed_core_parity_report_required')
    expected_rows = {key: {'filename': row['file'], **{field: row[field] for field in ('url', 'bytes', 'sha256')}} for key, row in report['selected'].items()}
    need(expected_rows == contract['runtime_wheels'], 'current_core_wheel_roles_match_reviewed_report')
    job = Path(args.job)
    need(job.is_absolute() and job == job.resolve(), 'canonical_absolute_job')
    os.umask(0o077)
    if args.phase == 'fetch':
        with directory_fd(job.parent) as parent:
            os.mkdir(job.name, 0o700, dir_fd=parent)
    tree = SafeTree(job)
    try:
        if args.phase == 'fetch':
            tree.mkdir('artifacts')
            tree.json('FETCH_STARTED_R1.json', {'phase': 'fetch', 'contract_sha256': CONTRACT_SHA256})
            results = [fetch_one(tree, row) for row in all_downloads(contract)]
            tree.json('FETCH_RECEIPT_R1.json', {'status': 'ALL_EXACT_PUBLIC_INPUT_PINS_MATCH', 'files': results,
                      'contract_sha256': CONTRACT_SHA256, 'elapsed_seconds': time.monotonic() - START,
                      'job_identity': list(tree.directories['']), 'artifact_directory_identity': list(tree.directories['artifacts'])})
        else:
            fetched_raw, _pin = tree.read('FETCH_RECEIPT_R1.json', maximum=2 * 1024**2)
            fetched = json.loads(fetched_raw)
            need(fetched['status'] == 'ALL_EXACT_PUBLIC_INPUT_PINS_MATCH' and fetched['contract_sha256'] == CONTRACT_SHA256
                 and tuple(fetched['job_identity']) == tree.directories[''], 'exact_fetch_predecessor_required')
            tree.adopt_artifacts(fetched['artifact_directory_identity'])
            expected_files = [{'filename': row['filename'], 'bytes': row['bytes'], 'sha256': row['sha256']} for row in all_downloads(contract)]
            need(fetched['files'] == expected_files, 'complete_fetch_provenance_manifest_required')
            tree.json('STAGE_STARTED_R1.json', {'phase': 'stage', 'contract_sha256': CONTRACT_SHA256})
            stage(tree, contract, Path(args.reference))
    except BaseException as error:
        failed = {'status': 'FAILED_RETAINED_NO_AUTOMATIC_RETRY', 'phase': args.phase,
                  'at': datetime.now(timezone.utc).isoformat(), 'error_type': type(error).__name__,
                  'reason': str(error) if isinstance(error, Refused) else 'details_omitted',
                  'elapsed_seconds': time.monotonic() - START, 'native_action': False}
        try:
            tree.json(args.phase.upper() + '_FAILED_R1.json', failed)
            failed['terminal_receipt_written'] = True
        except BaseException:
            failed['terminal_receipt_written'] = False
        print(json.dumps(failed), flush=True)
        raise
    finally:
        tree.close()
    print(json.dumps({'phase': args.phase, 'job': str(job), 'status': 'DATA_PHASE_COMPLETE_NO_NATIVE_ACTION'}))

"""Source template merged into the standalone preparation worker; never imported."""
import contextlib
import io

def directory_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode))

def read_fd(fd, expected=None, maximum=MAX_BYTES):
    before = os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'bounded_regular_snapshot')
    chunks, h, size = [], hashlib.sha256(), 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        tick()
        block = os.read(fd, 65536)
        if not block:
            break
        size += len(block)
        need(size <= maximum, 'snapshot_byte_bound')
        chunks.append(block)
        h.update(block)
    need(size == before.st_size and identity(before) == identity(os.fstat(fd)), 'snapshot_object_changed')
    pin = {'bytes': size, 'sha256': h.hexdigest()}
    if expected is not None:
        need(pin == {key: expected[key] for key in ('bytes', 'sha256')}, 'snapshot_pin_changed')
    return b''.join(chunks), before, pin

def verified_bytes(path, expected=None, maximum=MAX_BYTES):
    path = Path(path)
    with directory_fd(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            raw, before, pin = read_fd(fd, expected, maximum)
            need(identity(before) == identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)), 'snapshot_path_changed')
            return raw, pin
        finally:
            os.close(fd)

@contextlib.contextmanager
def directory_fd(path):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'absolute_directory_anchor')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)

class SafeTree:
    """Outputs stay on anchored, owned directory objects and exclusive files."""
    def __init__(self, root):
        self.root = Path(root)
        self.anchor = directory_fd(self.root)
        self.fd = self.anchor.__enter__()
        info = os.fstat(self.fd)
        need(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'owned_private_output_root')
        self.directories = {'': directory_key(info)}
        self.files = {}
        self.written = 0

    def close(self):
        self.anchor.__exit__(None, None, None)

    def root_check(self):
        need(directory_key(os.fstat(self.fd)) == self.directories['']
             == directory_key(self.root.lstat()), 'output_root_identity_changed')

    @contextlib.contextmanager
    def parent(self, name):
        rel = relative(name)
        self.root_check()
        fd = os.dup(self.fd)
        traversed = []
        try:
            for part in rel.parts[:-1]:
                traversed.append(part)
                key = '/'.join(traversed)
                need(key in self.directories, 'undeclared_output_directory')
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
                need(directory_key(os.fstat(fd)) == self.directories[key], 'output_directory_replaced')
            yield fd, rel.name
            self.root_check()
        finally:
            os.close(fd)

    def mkdir(self, name):
        with self.parent(name) as (parent, base):
            os.mkdir(base, 0o700, dir_fd=parent)
            fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(fd)
                need(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'fresh_owned_output_directory')
                self.directories[name] = directory_key(info)
            finally:
                os.close(fd)

    def adopt_artifacts(self, expected_key):
        with self.parent('artifacts') as (parent, base):
            fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                need(directory_key(os.fstat(fd)) == tuple(expected_key), 'fetch_artifact_directory_replaced')
                self.directories['artifacts'] = directory_key(os.fstat(fd))
            finally:
                os.close(fd)

    def put_stream(self, name, blocks, expected=None, mode=0o400):
        with self.parent(name) as (parent, base):
            fd = os.open(base, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            h, size = hashlib.sha256(), 0
            try:
                for block in blocks:
                    tick()
                    size += len(block)
                    self.written += len(block)
                    need(self.written <= MAX_BYTES and size <= (expected['bytes'] if expected else MAX_BYTES), 'output_total_or_file_byte_bound')
                    view = memoryview(block)
                    while view:
                        count = os.write(fd, view)
                        need(count > 0, 'output_short_write')
                        view = view[count:]
                    h.update(block)
                pin = {'bytes': size, 'sha256': h.hexdigest()}
                if expected:
                    need(pin == {key: expected[key] for key in ('bytes', 'sha256')}, 'output_pin_changed')
                os.fsync(fd)
                os.fchmod(fd, mode)
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                     and identity(info) == identity(os.stat(base, dir_fd=parent, follow_symlinks=False)), 'output_file_identity_changed')
                self.files[name] = (info.st_dev, info.st_ino, info.st_uid)
                return pin
            finally:
                os.close(fd)

    def put(self, name, data, expected=None, mode=0o400):
        return self.put_stream(name, [data], expected, mode)

    def json(self, name, value):
        raw = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
        need(len(raw) <= 32 * 1024**2, 'JSON_output_bound')
        return self.put(name, raw, mode=0o600)

    def read(self, name, expected=None, maximum=MAX_BYTES):
        with self.parent(name) as (parent, base):
            fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                raw, info, pin = read_fd(fd, expected, maximum)
                need(identity(info) == identity(os.stat(base, dir_fd=parent, follow_symlinks=False)), 'input_path_replaced')
                if name in self.files:
                    need((info.st_dev, info.st_ino, info.st_uid) == self.files[name], 'created_output_object_replaced')
                return raw, pin
            finally:
                os.close(fd)

    def symlink(self, name, target):
        with self.parent(name) as (parent, base):
            os.symlink(target, base, dir_fd=parent)

    def chmod_directory(self, name, mode):
        with self.parent(name) as (parent, base):
            fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                need(directory_key(os.fstat(fd)) == self.directories[name], 'directory_changed_before_finalization')
                os.fchmod(fd, mode)
                self.directories[name] = directory_key(os.fstat(fd))
            finally:
                os.close(fd)

    def replace_created(self, name, before, after):
        with self.parent(name) as (parent, base):
            fd = os.open(base, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                raw, info, _pin = read_fd(fd, maximum=256 * 1024)
                need(name in self.files and (info.st_dev, info.st_ino, info.st_uid) == self.files[name]
                     and raw == before, 'created_source_patch_object_changed')
                os.lseek(fd, 0, os.SEEK_SET)
                view = memoryview(after)
                while view:
                    count = os.write(fd, view)
                    need(count > 0, 'source_patch_short_write')
                    view = view[count:]
                os.ftruncate(fd, len(after))
                os.fsync(fd)
                need(identity(os.fstat(fd)) == identity(os.stat(base, dir_fd=parent, follow_symlinks=False)), 'patched_source_path_changed')
            finally:
                os.close(fd)

if __name__ == '__main__':
    main()
