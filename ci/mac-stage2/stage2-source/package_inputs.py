"""Pure-stdlib, no-import-side-effect checks for reviewed J1c packaging inputs."""
from pathlib import Path, PurePosixPath
import hashlib
import contextlib
import io
import json
import os
import re
import stat

class InputRefused(RuntimeError):
    pass

SHA = re.compile(r'^[a-f0-9]{64}$')
COMPONENTS = {'python', 'swipl', 'node', 'lib', 'PeTTa', 'petta_lib_chromadb', 'manifests'}
FORBIDDEN = {'.git', '.runtime', '.env', 'node_modules', '.venv', 'venv', '__pycache__', 'providers.json'}

def sha(path):
    path = Path(path)
    _, result = read_regular(path.parent, path.name)
    return result

def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)

@contextlib.contextmanager
def directory_fd(root):
    """Open every absolute parent with nofollow; caller owns only the final fd."""
    root = Path(root).absolute()
    if str(root) != os.path.normpath(str(root)):
        raise InputRefused('noncanonical_input_root')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in root.parts[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = following
        yield fd
    finally:
        os.close(fd)

@contextlib.contextmanager
def parent_fd(root, rel):
    rel = relative(rel)
    with directory_fd(root) as base:
        fd = os.dup(base)
        try:
            for part in PurePosixPath(rel).parts[:-1]:
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = following
            yield fd, PurePosixPath(rel).name
        finally:
            os.close(fd)

def read_regular(root, rel, *, expected=None, output=None, maximum=3 * 1024**3):
    """Hash/copy through one nofollow fd; pre/post pathname and fd identities agree."""
    with parent_fd(root, rel) as (parent, name):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise InputRefused('regular_file_or_size_bound_refused')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            if identity(os.fstat(fd)) != identity(before):
                raise InputRefused('file_changed_at_open')
            digest, count = hashlib.sha256(), 0
            while True:
                part = os.read(fd, 1024 * 1024)
                if not part: break
                count += len(part)
                if count > maximum: raise InputRefused('file_grew_past_bound')
                digest.update(part)
                if output is not None: output.write(part)
            if (identity(os.fstat(fd)) != identity(before)
                    or identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(before)
                    or count != before.st_size):
                raise InputRefused('file_changed_during_read')
            value = digest.hexdigest()
            if expected is not None and (value != expected['sha256'] or count != expected['bytes']
                    or bool(before.st_mode & 0o111) != expected['executable']
                    or ('mode' in expected and format(stat.S_IMODE(before.st_mode), '04o') != expected['mode'])):
                raise InputRefused('copied_file_does_not_match_reviewed_row')
            return before, value
        finally:
            os.close(fd)

def relative(value):
    if (not isinstance(value, str) or not value or '\\' in value or '\x00' in value
            or value != str(PurePosixPath(value)) or PurePosixPath(value).is_absolute()
            or any(p in ('.', '..', '') for p in value.split('/'))):
        raise InputRefused('unsafe_relative_path')
    return value

def checked_json(path, expected_sha, maximum=8 * 1024**2):
    path = Path(path)
    if not SHA.fullmatch(expected_sha or '') or path.is_symlink() or not path.is_file():
        raise InputRefused('missing_or_unpinned_json')
    content = io.BytesIO()
    _, actual_sha = read_regular(path.parent, path.name, output=content, maximum=maximum)
    raw = content.getvalue()
    if actual_sha != expected_sha:
        raise InputRefused('input_json_pin_mismatch')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise InputRefused('input_json_not_object')
    return value

def bytes_regular(root, rel, maximum=64 * 1024**2, expected_sha=None):
    content = io.BytesIO()
    _, actual_sha = read_regular(root, rel, output=content, maximum=maximum)
    if expected_sha is not None and actual_sha != expected_sha:
        raise InputRefused('read_bytes_pin_mismatch')
    return content.getvalue()

def tree(root, *, components=None, maximum=100000, max_bytes=3 * 1024**3, include_modes=False):
    """Bounded, closed tree metadata. No symlink is followed during traversal."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise InputRefused('input_root_not_real_directory')
    root = root.resolve()
    rows, size = [], 0
    def walk(fd, prefix):
        nonlocal size
        initial = os.fstat(fd)
        names = sorted(os.listdir(fd))
        if len(names) > maximum: raise InputRefused('input_tree_bound_exceeded')
        for name in names:
            if not prefix and components is not None and name not in components: continue
            rel = relative(str(PurePosixPath(prefix, name)))
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                row = {'path': rel, 'kind': 'directory', 'mode': format(stat.S_IMODE(info.st_mode), '04o')}
            elif stat.S_ISLNK(info.st_mode):
                target = os.readlink(name, dir_fd=fd)
                resolved = (root / rel).resolve(strict=True)
                if (os.path.isabs(target) or not resolved.is_relative_to(root)
                        or (components is not None and (not resolved.relative_to(root).parts
                            or resolved.relative_to(root).parts[0] not in components))):
                    raise InputRefused('symlink_leaves_selected_input')
                if identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != identity(info):
                    raise InputRefused('symlink_changed_during_read')
                row = {'path': rel, 'kind': 'symlink', 'target': target}
            elif stat.S_ISREG(info.st_mode):
                seen, digest = read_regular(root, rel)
                if identity(seen) != identity(info): raise InputRefused('file_changed_during_inventory')
                size += info.st_size
                row = {'path': rel, 'kind': 'file', 'sha256': digest,
                       'bytes': info.st_size, 'executable': bool(info.st_mode & 0o111)}
            else: raise InputRefused('special_file_refused')
            if include_modes: row['mode'] = format(stat.S_IMODE(info.st_mode), '04o')
            rows.append(row)
            if len(rows) > maximum or size > max_bytes: raise InputRefused('input_tree_bound_exceeded')
            if row['kind'] == 'directory':
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if identity(os.fstat(child)) != identity(info): raise InputRefused('directory_changed_at_open')
                    walk(child, rel)
                    if identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != identity(info):
                        raise InputRefused('directory_changed_during_inventory')
                finally: os.close(child)
        if identity(os.fstat(fd)) != identity(initial): raise InputRefused('directory_changed_during_inventory')
    with directory_fd(root) as fd:
        initial = os.fstat(fd); walk(fd, '')
        if identity(os.stat(root, follow_symlinks=False)) != identity(initial):
            raise InputRefused('input_root_changed_during_inventory')
    return sorted(rows, key=lambda row: row['path'])

def verify_tree(root, manifest, *, components=None):
    """Verify declared paths and each declared directory's immediate closure.

    Reused runtime/toolchain trees are never recursively discovered. Unknown
    children cause refusal without descent or name disclosure. `tree` is reserved
    for fresh owned output inventories, where discovery is part of the build.
    """
    expected = manifest.get('files')
    if not isinstance(expected, list) or not expected or len(expected) > 100000:
        raise InputRefused('empty_input_manifest')
    total_bytes = 0
    # Directory modes are always recorded; regular/symlink modes are either
    # complete (runtime/app) or omitted (UI/package byte maps).
    include_modes = any('mode' in row for row in expected if isinstance(row, dict) and row.get('kind') != 'directory')
    if include_modes and not all(isinstance(row, dict) and re.fullmatch(r'[0-7]{4}', row.get('mode', '')) for row in expected):
        raise InputRefused('incomplete_permission_mode_manifest')
    root = Path(root).absolute()
    by_path, children = {}, {'': set()}
    for row in expected:
        if not isinstance(row, dict):
            raise InputRefused('invalid_declared_input_row')
        rel = relative(row.get('path'))
        if (rel in by_path or row.get('kind') not in {'directory', 'file', 'symlink'}
                or (components is not None and PurePosixPath(rel).parts[0] not in components)):
            raise InputRefused('duplicate_or_unselected_declared_input')
        if row['kind'] == 'file':
            if (type(row.get('bytes')) is not int or row['bytes'] < 0
                    or not SHA.fullmatch(row.get('sha256', ''))):
                raise InputRefused('invalid_declared_file_size_or_hash')
            total_bytes += row['bytes']
            if total_bytes > 3 * 1024**3:
                raise InputRefused('declared_input_byte_bound_exceeded')
        by_path[rel] = row
        parts = PurePosixPath(rel).parts
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            children.setdefault(parent, set()).add(part)
    for rel, row in by_path.items():
        parent = str(PurePosixPath(rel).parent)
        if parent != '.' and (parent not in by_path or by_path[parent]['kind'] != 'directory'):
            raise InputRefused('undeclared_input_parent')
        if row['kind'] == 'directory':
            children.setdefault(rel, set())
    with directory_fd(root) as root_fd:
        initial = os.fstat(root_fd)
        names = set(os.listdir(root_fd))
        if components is not None:
            names &= set(components)
        if names != children['']:
            raise InputRefused('input_root_child_closure_changed')
    for rel, row in by_path.items():
        with parent_fd(root, rel) as (parent, name):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if 'mode' in row and (not re.fullmatch(r'[0-7]{4}', row['mode'])
                    or format(stat.S_IMODE(before.st_mode), '04o') != row['mode']):
                raise InputRefused('declared_input_mode_changed')
            if row['kind'] == 'directory':
                if not stat.S_ISDIR(before.st_mode):
                    raise InputRefused('declared_directory_kind_changed')
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    if (identity(os.fstat(fd)) != identity(before)
                            or set(os.listdir(fd)) != children[rel]
                            or identity(os.fstat(fd)) != identity(before)):
                        raise InputRefused('declared_directory_closure_changed')
                finally:
                    os.close(fd)
            elif row['kind'] == 'file':
                read_regular(root, rel, expected=row)
            else:
                if not stat.S_ISLNK(before.st_mode):
                    raise InputRefused('declared_link_kind_changed')
                target = os.readlink(name, dir_fd=parent)
                if target != row.get('target') or os.path.isabs(target):
                    raise InputRefused('declared_link_changed')
                # Resolve only through the declared metadata map; never follow
                # an arbitrary filesystem target or traverse a private subtree.
                pending = list(PurePosixPath(rel).parts[:-1]) + target.split('/')
                resolved, hops = [], 0
                while pending:
                    part = pending.pop(0)
                    if part in ('', '.'):
                        continue
                    if part == '..':
                        if not resolved:
                            raise InputRefused('declared_link_leaves_root')
                        resolved.pop()
                        continue
                    resolved.append(part)
                    key = '/'.join(resolved)
                    item = by_path.get(key)
                    if item is None:
                        raise InputRefused('declared_link_target_not_in_inventory')
                    if item['kind'] == 'symlink':
                        hops += 1
                        value = item.get('target')
                        if hops > 64 or not isinstance(value, str) or os.path.isabs(value):
                            raise InputRefused('declared_link_cycle_or_absolute_target')
                        resolved.pop()
                        pending = value.split('/') + pending
                    elif pending and item['kind'] != 'directory':
                        raise InputRefused('declared_link_crosses_regular_file')
                if not resolved or (components is not None and resolved[0] not in components):
                    raise InputRefused('declared_link_leaves_selection')
            if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(before):
                raise InputRefused('declared_input_changed_during_verification')
    with directory_fd(root) as root_fd:
        names = set(os.listdir(root_fd))
        if components is not None:
            names &= set(components)
        if identity(os.fstat(root_fd)) != identity(initial) or names != children['']:
            raise InputRefused('input_root_changed_during_verification')
    return expected

def verify_source(root, manifest):
    if (manifest.get('derived_commit') != 'cc45c09de9147fcfad531062463d1db1645a6c20'
            or manifest.get('derived_tree') != '2e765c441d64e1059007ab9aa7c9dfe555aa389b'
            or len(manifest.get('files', [])) != 2564):
        raise InputRefused('job9_source_pin_mismatch')
    root, seen, selected = Path(root).absolute(), set(), []
    for row in manifest['files']:
        rel = relative(row['path'])
        if rel in seen or set(PurePosixPath(rel).parts) & FORBIDDEN:
            raise InputRefused('duplicate_or_forbidden_source_path')
        seen.add(rel)
        if row['mode'] not in {'100644', '100755'}:
            raise InputRefused('source_bytes_or_modes_changed')
        read_regular(root, rel, expected={'sha256': row['sha256'], 'bytes': row['bytes'],
                                         'executable': row['mode'] == '100755'})
        # Only the tracked Hive subtree is an application payload. Repository
        # .git, owner state and unrelated programs outside Hive never enter it.
        if rel.startswith('hive/'):
            selected.append(row)
    return selected

def source_digest(root, entries):
    """Exact pinned Programs.source_digest algorithm; never import package code."""
    root = Path(root).absolute()
    files = ['plugin.json'] + sorted((row['path'] for row in entries
        if row['kind'] == 'file' and PurePosixPath(row['path']).suffix in ('.py', '.metta')
        and not (set(PurePosixPath(row['path']).parts[:-1]) &
                 {'__pycache__', '.git', 'node_modules', '.venv', 'venv', 'data', 'store', 'var'})),
        key=PurePosixPath)
    if any(row['path'] == 'ui/bundle.lock.json' and row['kind'] == 'file' for row in entries):
        files.append('ui/bundle.lock.json')
    digest = hashlib.sha256()
    for rel in files:
        digest.update(rel.encode() + b'\0' + bytes_regular(root, rel) + b'\0')
    return 'sha256:' + digest.hexdigest()

def verify_studio(root, contract):
    root = Path(root).absolute()
    expected = contract.get('package_files')
    if not isinstance(expected, dict) or not expected or len(expected) > 1000:
        raise InputRefused('studio_declared_package_required')
    rows, directories, size = [], set(), 0
    for rel, wanted in expected.items():
        relative(rel)
        if (set(PurePosixPath(rel).parts) & FORBIDDEN
                or not SHA.fullmatch(wanted or '')):
            raise InputRefused('studio_forbidden_or_unpinned_path')
        info, actual = read_regular(root, rel, maximum=64 * 1024**2)
        if actual != wanted:
            raise InputRefused('studio_declared_file_hash_mismatch')
        size += info.st_size
        if size > 64 * 1024**2:
            raise InputRefused('studio_declared_package_byte_bound')
        rows.append({'path': rel, 'kind': 'file', 'bytes': info.st_size,
                     'sha256': actual, 'executable': bool(info.st_mode & 0o111)})
        directories.update(str(p) for p in PurePosixPath(rel).parents if str(p) != '.')
    if len(rows) + len(directories) > 1000:
        raise InputRefused('studio_declared_package_entry_bound')
    for rel in sorted(directories):
        with parent_fd(root, rel) as (parent, name):
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                raise InputRefused('studio_declared_parent_not_directory')
            rows.append({'path': rel, 'kind': 'directory',
                         'mode': format(stat.S_IMODE(info.st_mode), '04o')})
    rows.sort(key=lambda row: row['path'])
    verify_tree(root, {'files': rows})
    plugin = json.loads(bytes_regular(root, 'plugin.json'))
    if (plugin.get('id') != contract['id'] or str(plugin.get('version')) != contract['version']
            or source_digest(root, rows) != contract['source_digest']):
        raise InputRefused('studio_identity_or_source_digest_mismatch')
    for rel, wanted in contract['files'].items():
        relative(rel)
        if expected.get(rel) != wanted.removeprefix('sha256:'):
            raise InputRefused('studio_host_pin_not_in_package_manifest')
    return rows

def validate_studio_contract(value):
    return validate_program_contract(value)

def verify_ui(root, receipt, source_manifest_sha):
    if (receipt.get('schema') != 'j1c-ui-build/1' or receipt.get('complete') is not True
            or receipt.get('source_commit') != 'cc45c09de9147fcfad531062463d1db1645a6c20'
            or receipt.get('source_tree') != '2e765c441d64e1059007ab9aa7c9dfe555aa389b'
            or receipt.get('source_manifest_sha256') != source_manifest_sha
            or receipt.get('commands') != [['npm', 'ci', '--offline'], ['npm', 'run', 'build']]
            or receipt.get('exits') != [0, 0]):
        raise InputRefused('ui_build_not_complete_or_wrong_source')
    rows = verify_tree(root, receipt)
    if any(r['kind'] not in {'file', 'directory'} for r in rows) or not any(r['path'] == 'index.html' for r in rows):
        raise InputRefused('ui_output_incomplete_or_linked')
    return rows

# Same reviewed contract validation as the two-program launcher core.
DIGEST = re.compile('^sha256:[a-f0-9]{64}$')
PROGRAM_IDS = ('omegaassist', 'omegadesign')
PROGRAM_VERSIONS = {'omegaassist': '0.1.0', 'omegadesign': '0.4.20'}
PROGRAM_CONTRACT_SCHEMA = 'j1c-admitted-studio-program-set/1'
HIVE_SOURCE_COMMIT = 'cc45c09de9147fcfad531062463d1db1645a6c20'
HIVE_SOURCE_TREE = '2e765c441d64e1059007ab9aa7c9dfe555aa389b'
HIVE_KIT_SHA256 = '7e7095ecd32e6024a74708734c0bf33c0afb6533e010bef36f2205043b75192d'

def _valid_model(value, *, embedding=False):
    if type(value) is not str or len(value) > 240:
        return False
    pattern = '(?:mock/hash|(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9_.:/-]*)' if embedding else '(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9_.:/-]*'
    return re.fullmatch(pattern, value) is not None

def validate_program_contract(value):
    """Validate exact Hive base and complete, reviewed pins for both UI programs."""
    required = {'schema', 'source_commit', 'source_tree', 'kit_sha256', 'programs', 'default_model', 'embedding_model'}
    if type(value) is not dict or set(value) != required or value.get('schema') != PROGRAM_CONTRACT_SCHEMA or (value.get('source_commit') != HIVE_SOURCE_COMMIT) or (value.get('source_tree') != HIVE_SOURCE_TREE) or (value.get('kit_sha256') != HIVE_KIT_SHA256):
        raise InputRefused('program_contract_base_or_schema_mismatch')
    if not _valid_model(value.get('default_model')):
        raise InputRefused('explicit_real_default_model_required')
    if not _valid_model(value.get('embedding_model'), embedding=True):
        raise InputRefused('explicit_embedding_model_required')
    programs = value.get('programs')
    if type(programs) is not dict or set(programs) != set(PROGRAM_IDS):
        raise InputRefused('two_reviewed_program_pins_required')
    release_names = set()
    for app_id in PROGRAM_IDS:
        item = programs[app_id]
        fields = {'id', 'version', 'release_directory', 'source_digest', 'files'}
        release = item.get('release_directory') if type(item) is dict else None
        if type(item) is not dict or set(item) != fields or item.get('id') != app_id or (item.get('version') != PROGRAM_VERSIONS[app_id]) or (type(release) is not str) or (not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', release)) or (release in {'.', '..'}) or (release in release_names) or (type(item.get('source_digest')) is not str) or (not DIGEST.fullmatch(item['source_digest'])):
            raise InputRefused('program_pin_invalid')
        release_names.add(release)
        files = item.get('files')
        if type(files) is not dict or not files or len(files) > 512:
            raise InputRefused('program_file_pins_missing_or_unbounded')
        for name, digest in files.items():
            relative = PurePosixPath(name) if type(name) is str else None
            if relative is None or not name or name in {'.', '..'} or name.startswith('/') or ('\\' in name) or ('\x00' in name) or (str(relative) != name) or ('..' in relative.parts) or name.endswith('/') or (type(digest) is not str) or (not DIGEST.fullmatch(digest)):
                raise InputRefused('program_file_pin_invalid')
    return value


def verify_program_set(manifest, contract):
    contract = validate_program_contract(contract)
    if (type(manifest) is not dict or set(manifest) != {'schema', 'programs'}
            or manifest['schema'] != 'j1c-mac-r12-program-package-inputs/1'
            or type(manifest['programs']) is not dict
            or set(manifest['programs']) != set(PROGRAM_IDS)):
        raise InputRefused('exact_program_package_manifest_required')
    selected = {}
    for app_id in PROGRAM_IDS:
        item = manifest['programs'][app_id]
        required = {'root', 'archive', 'source_digest', 'files',
                    'declared_regular_files', 'declared_regular_bytes'}
        if type(item) is not dict or set(item) != required:
            raise InputRefused('closed_program_package_input_required')
        root = Path(item['root'])
        if not root.is_absolute() or root != root.resolve() or not root.is_dir():
            raise InputRefused('canonical_program_input_root_required')
        rows = verify_tree(root, {'files': item['files']})
        file_rows = [row for row in rows if row['kind'] == 'file']
        if any(row['kind'] not in {'file', 'directory'} for row in rows):
            raise InputRefused('program_input_symlink_or_special_refused')
        want = contract['programs'][app_id]
        if ({row['path']: 'sha256:' + row['sha256'] for row in file_rows} != want['files']
                or len(file_rows) != item['declared_regular_files']
                or sum(row['bytes'] for row in file_rows) != item['declared_regular_bytes']
                or item['source_digest'] != want['source_digest']
                or source_digest(root, rows) != want['source_digest']):
            raise InputRefused('program_input_digest_or_complete_file_map_mismatch')
        plugin = json.loads(bytes_regular(root, 'plugin.json'))
        if plugin.get('id') != app_id or str(plugin.get('version')) != want['version']:
            raise InputRefused('program_input_identity_mismatch')
        selected[app_id] = rows
    return selected
