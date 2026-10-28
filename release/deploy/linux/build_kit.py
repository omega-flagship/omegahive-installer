"""Build one reviewed offline payload kit; never fetch or execute package code.

This template is disabled. Release owners bind the complete input manifest in a
reviewed source successor. Browser authentication is never reused by a fetcher.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
from urllib.parse import urlsplit
import zipfile

FINAL_RELEASE_BOUND = False
INPUTS_BYTES = None
INPUTS_SHA256 = None
HERE = Path(__file__).resolve().parent
INPUTS = HERE / 'kit-inputs.json'
INPUT_ROOT = HERE / 'kit-inputs'
OUTPUT = HERE / 'kit-output'
MARKER = b'\n__OMEGAHIVE_BUNDLE_BASE64__\n'
SOURCE_CAP = 256 * 1024**2
SOURCE_TAR_CAP = SOURCE_CAP + 32 * 1024**2
OUTER_CAP = 128 * 1024**2
COMPRESSED_CAP = 64 * 1024**2
SCRIPT_CAP = 96 * 1024**2
UI_CAP = 32 * 1024**2
UI_TAR_CAP = UI_CAP + 8 * 1024**2
ROOTS = {'fastapi', 'uvicorn', 'httpx', 'websockets', 'pytest', 'pillow'}
TEXT_SUFFIXES = {'.py', '.sh', '.md', '.txt', '.json', '.yaml', '.yml', '.toml',
                 '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.html', '.htm',
                 '.css', '.svg', '.metta'}
PUBLIC_HOSTS = {'github.com', 'files.pythonhosted.org',
                'www.swi-prolog.org', 'download.swi-prolog.org', 'astral.sh',
                'releases.astral.sh'}


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    def invalid(_):
        raise Refused('nonfinite_json')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def relative_name(value):
    require(type(value) is str and value and len(value.encode()) <= 4096
            and not any(c in value for c in '\x00\r\n\\'), 'invalid_member_name')
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value
            and '..' not in path.parts and path.parts, 'nonrelative_member_name')
    return value


def no_placeholders(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'files' and isinstance(item, list):
                # Hash-pinned file inventories name real repository files (e.g. a test called
                # askPlaceholder.test.ts); they are screened separately by the public-text checks.
                for row in item:
                    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256', 'mode'},
                            'unbound_release_metadata')
                    no_placeholders(row['sha256']); no_placeholders(row['mode'])
                continue
            no_placeholders(key)
            no_placeholders(item)
    elif isinstance(value, list):
        for item in value:
            no_placeholders(item)
    elif isinstance(value, str):
        require(not re.search(r'(?i)(unbound|placeholder|<[^>]+>|\$\{)', value),
                'unbound_release_metadata')


def public_text(raw, terms):
    # Structural platform-path check; no person's path is baked into this tool.
    mac_prefix = bytes((47, 85, 115, 101, 114, 115, 47))
    require(mac_prefix not in raw, 'private_platform_path_in_public_text')
    text = raw.decode('utf-8').casefold()
    require(not any(term.casefold() in text for term in terms), 'private_term_in_public_text')


def public_file(name, raw, terms):
    require(len(raw) <= 8 * 1024**2, 'public_file_screen_bound')
    if PurePosixPath(name).suffix.casefold() in TEXT_SUFFIXES:
        public_text(raw, terms)
        return
    # Unknown/extensionless UTF-8 files are also screened. Non-UTF-8 bytes (for
    # example binary fonts) remain hash-checked binary data, not decoded text.
    try:
        raw.decode('utf-8')
    except UnicodeDecodeError:
        return
    public_text(raw, terms)


def row_map(rows, *, allow_empty=False, maximum=128):
    require(type(rows) is list and 0 < len(rows) <= maximum, 'finite_rows_required')
    result = {}
    for row in rows:
        require(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'}, 'closed_artifact_pin')
        name = relative_name(row['path'])
        require(name not in result and type(row['bytes']) is int
                and (0 if allow_empty else 1) <= row['bytes'] <= COMPRESSED_CAP
                and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']),
                'artifact_pin_invalid')
        result[name] = row
    require(sum(row['bytes'] for row in rows) <= OUTER_CAP, 'outer_payload_size')
    return result


def read_exact(root, row):
    require(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'}
            and type(row['bytes']) is int and 0 < row['bytes'] <= COMPRESSED_CAP
            and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']),
            'closed_bounded_input_pin')
    name = relative_name(row['path'])
    path = root / name
    for parent in (path.parent, *path.parent.parents):
        require(stat.S_ISDIR(parent.lstat().st_mode), 'plain_input_ancestry')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_uid == os.getuid() and not before.st_mode & 0o022
                and before.st_size == row['bytes'], 'owned_regular_input_required')
        data = bytearray()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            data.extend(block)
            require(len(data) <= row['bytes'], 'input_growth')
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
                              s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(before) == identity(os.fstat(fd)) == identity(path.lstat())
                and len(data) == row['bytes']
                and hashlib.sha256(data).hexdigest() == row['sha256'], 'input_pin_changed')
        return bytes(data)
    finally:
        os.close(fd)


def plain_github_url(value, repository=None):
    require(type(value) is str and len(value) <= 1024, 'github_url_required')
    parsed = urlsplit(value)
    require(parsed.scheme == 'https' and parsed.hostname == 'github.com'
            and not parsed.username and not parsed.password and not parsed.query
            and not parsed.fragment and parsed.port in (None, 443), 'private_or_signed_url_refused')
    if repository is not None:
        require(value.startswith(repository + '/releases/download/'), 'fixed_release_asset_url_required')


def source_rows(rows):
    require(type(rows) is list and 0 < len(rows) <= 5000, 'source_inventory_required')
    result = {}
    for row in rows:
        require(type(row) is dict and set(row) == {'path', 'bytes', 'sha256', 'mode'}, 'source_row_shape')
        name = relative_name(row['path'])
        require(name not in result and type(row['bytes']) is int and 0 <= row['bytes'] <= 8 * 1024**2
                and row['mode'] in ('100644', '100755')
                and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']), 'source_row_pin')
        result[name] = row
    require(all(str(parent) not in result for name in result
                for parent in PurePosixPath(name).parents if str(parent) != '.'),
            'source_file_ancestor_collision')
    require(sum(row['bytes'] for row in rows) <= SOURCE_CAP, 'source_expansion_cap')
    return result


def source_prefix(payload, owner_prefix):
    require(type(payload) is dict and 'prefix' in payload, 'explicit_source_prefix_required')
    prefix = relative_name(payload['prefix'])
    require('/' not in prefix and prefix == owner_prefix, 'exact_shared_source_prefix_required')
    return prefix


def archive_directories(prefix, names):
    result = {prefix}
    for name in names:
        path = PurePosixPath(prefix) / name
        result.update(str(parent) for parent in path.parents if str(parent) != '.')
    return result


def git_tree(entries):
    tree = {}
    for name, mode, digest in entries:
        parts = relative_name(name).split('/')
        node = tree
        for part in parts[:-1]:
            child = node.setdefault(part, {})
            require(type(child) is dict, 'source_file_directory_collision')
            node = child
        require(parts[-1] not in node, 'source_tree_duplicate')
        node[parts[-1]] = (mode, digest)
    def seal(node):
        items = []
        for name, value in node.items():
            is_dir = type(value) is dict
            mode, digest = ('40000', seal(value)) if is_dir else value
            items.append((name.encode() + (b'/' if is_dir else b''),
                          mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(digest)))
        body = b''.join(value for _, value in sorted(items))
        return hashlib.sha1(b'tree ' + str(len(body)).encode() + b'\0' + body).hexdigest()
    return seal(tree)


def inspect_source(raw, prefix, rows, tree_sha, terms):
    require(relative_name(prefix) == prefix and '/' not in prefix, 'single_source_prefix_required')
    expected = source_rows(rows)
    seen = set()
    directories = archive_directories(prefix, expected)
    seen_directories = set()
    entries = []
    with gzip.GzipFile(fileobj=io.BytesIO(raw), mode='rb') as compressed:
        expanded = compressed.read(SOURCE_TAR_CAP + 1)
    require(len(expanded) <= SOURCE_TAR_CAP, 'source_tar_expansion_cap')
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for index, member in enumerate(archive):
            require(index < 20000, 'source_member_count')
            name = relative_name(member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name)
            public_text(name.encode(), terms)
            require(name == prefix or name.startswith(prefix + '/'), 'source_prefix_mismatch')
            if member.isdir():
                require(member.size == 0 and name in directories and name not in seen_directories,
                        'source_extra_nonempty_or_duplicate_directory')
                seen_directories.add(name)
                continue
            rel = relative_name(name[len(prefix) + 1:])
            require(member.isfile() and rel in expected and rel not in seen, 'source_extra_or_link')
            row = expected[rel]
            require(member.size == row['bytes'], 'source_member_size')
            handle = archive.extractfile(member)
            require(handle is not None, 'source_member_missing')
            with handle:
                body = handle.read(row['bytes'] + 1)
            mode = '100755' if member.mode & 0o111 else '100644'
            require(len(body) == row['bytes'] and hashlib.sha256(body).hexdigest() == row['sha256']
                    and mode == row['mode'], 'source_member_digest_or_mode')
            public_file(rel, body, terms)
            blob = hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest()
            entries.append((rel, mode, blob))
            seen.add(rel)
    require(seen == set(expected) and git_tree(entries) == tree_sha, 'source_inventory_or_tree_mismatch')


def inspect_app(raw, spec, terms):
    expected = source_rows(spec['files'])
    prefix = relative_name(spec['prefix'].rstrip('/')) + '/'
    seen = set()
    directories = archive_directories(prefix.rstrip('/'), expected)
    seen_directories = set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        require(len(archive.infolist()) <= 20000, 'app_member_count')
        for member in archive.infolist():
            name = relative_name(member.filename.rstrip('/'))
            public_text(name.encode(), terms)
            if member.is_dir():
                require(member.filename == name + '/'
                        and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFDIR)
                        and member.file_size == 0 and member.CRC == 0
                        and archive.read(member) == b'', 'app_directory_type_or_body')
                require(name in directories and name not in seen_directories, 'app_extra_or_duplicate_directory')
                seen_directories.add(name)
                continue
            require(member.filename.startswith(prefix), 'app_prefix_mismatch')
            rel = relative_name(member.filename[len(prefix):])
            require(rel in expected and rel not in seen
                    and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG), 'app_extra_or_link')
            row = expected[rel]
            require(member.file_size == row['bytes'], 'app_member_size')
            body = archive.read(member)
            require(len(body) == row['bytes'] and hashlib.sha256(body).hexdigest() == row['sha256'], 'app_member_digest')
            mode = '100755' if (member.external_attr >> 16) & 0o111 else '100644'
            require(mode == row['mode'], 'app_member_mode')
            public_file(rel, body, terms)
            seen.add(rel)
    require(seen == set(expected), 'app_inventory_mismatch')


def ui_rows(rows):
    require(type(rows) is list and 0 < len(rows) <= 5000, 'ui_inventory_required')
    result = {}
    for row in rows:
        require(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'}, 'ui_row_shape')
        name = relative_name(row['path'])
        require(name not in result and type(row['bytes']) is int
                and 0 <= row['bytes'] <= 8 * 1024**2
                and type(row['sha256']) is str and re.fullmatch('[a-f0-9]{64}', row['sha256']),
                'ui_row_pin')
        result[name] = row
    require(all(str(parent) not in result for name in result
                for parent in PurePosixPath(name).parents if str(parent) != '.'),
            'ui_file_ancestor_collision')
    require(sum(row['bytes'] for row in rows) <= UI_CAP, 'ui_expansion_cap')
    return result


def plain_ui_tar(expanded):
    require(len(expanded) % 512 == 0, 'ui_tar_alignment')
    offset, count = 0, 0
    while offset + 512 <= len(expanded):
        block = expanded[offset:offset + 512]
        if block == bytes(512):
            require(offset + 1024 <= len(expanded)
                    and not any(expanded[offset:]), 'ui_tar_end_or_hidden_tail')
            return
        require(count < 20000, 'ui_member_count')
        # Inspect every physical header before tarfile can consume extensions.
        require(block[156:157] in (b'0', b'\0', b'5'), 'ui_tar_extension_or_special')
        member = tarfile.TarInfo.frombuf(block, 'utf-8', 'strict')
        require(0 <= member.size <= 8 * 1024**2, 'ui_member_size')
        body_end = offset + 512 + member.size
        next_header = offset + 512 + ((member.size + 511) // 512) * 512
        require(next_header <= len(expanded)
                and not any(expanded[body_end:next_header]), 'ui_tar_body_or_padding')
        offset = next_header
        count += 1
    require(False, 'ui_tar_missing_end')


def inspect_ui_manifest(raw, spec, terms):
    require(0 < len(raw) <= 2 * 1024**2, 'ui_manifest_size')
    public_text(raw, terms)
    value = strict_json(raw)
    require(type(value) is dict and set(value) == {'built_with', 'file_count', 'files',
            'format', 'source_commit', 'source_tree'}
            and value['format'] == 'omegahive.ui-prebuilt/1', 'ui_manifest_shape')
    require(type(value['built_with']) is str and 0 < len(value['built_with']) <= 2048,
            'ui_build_provenance_required')
    require(all(type(spec[k]) is str and re.fullmatch('[a-f0-9]{40}', spec[k])
                for k in ('source_revision', 'source_tree'))
            and value['source_commit'] == spec['source_revision']
            and value['source_tree'] == spec['source_tree'], 'ui_source_identity_mismatch')
    require(type(value['files']) is dict and type(value['file_count']) is int
            and 0 < value['file_count'] == len(value['files']) <= 5000, 'ui_file_count')
    rows = []
    for name, row in value['files'].items():
        require(type(row) is dict and set(row) == {'bytes', 'sha256'}, 'ui_manifest_row_shape')
        rows.append(dict(path=name, bytes=row['bytes'], sha256=row['sha256']))
    ui_rows(rows)
    return rows


def inspect_ui_archive(raw, rows, terms):
    expected = ui_rows(rows)
    directories = archive_directories('dist', expected)
    seen, seen_directories = set(), set()
    with gzip.GzipFile(fileobj=io.BytesIO(raw), mode='rb') as compressed:
        expanded = compressed.read(UI_TAR_CAP + 1)
    require(len(expanded) <= UI_TAR_CAP, 'ui_tar_expansion_cap')
    plain_ui_tar(expanded)
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for index, member in enumerate(archive):
            require(index < 20000, 'ui_member_count')
            name = relative_name(member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name)
            public_text(name.encode(), terms)
            require(not member.pax_headers and not member.mode & 0o7000
                    and member.uid == member.gid == 0, 'ui_header_metadata')
            if member.isdir():
                require(member.size == 0 and name in directories and name not in seen_directories,
                        'ui_extra_nonempty_or_duplicate_directory')
                seen_directories.add(name)
                continue
            require(member.isfile() and not member.mode & 0o111
                    and name.startswith('dist/'), 'ui_extra_or_link')
            rel = relative_name(name[len('dist/'):])
            require(rel in expected and rel not in seen, 'ui_extra_or_link')
            row = expected[rel]
            require(member.size == row['bytes'], 'ui_member_size')
            handle = archive.extractfile(member)
            require(handle is not None, 'ui_member_missing')
            with handle:
                body = handle.read(row['bytes'] + 1)
            require(len(body) == row['bytes'] and hashlib.sha256(body).hexdigest() == row['sha256'],
                    'ui_member_digest')
            public_file(rel, body, terms)
            seen.add(rel)
    require(seen == set(expected), 'ui_inventory_mismatch')


def validate_lock(raw, core=False):
    require(0 < len(raw) <= 2 * 1024**2, 'lock_size')
    logical, current = [], ''
    for line in raw.decode('ascii').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        current += ' ' + line.rstrip('\\').strip()
        if not line.endswith('\\'):
            logical.append(current.strip())
            current = ''
    require(logical and not current, 'lock_incomplete')
    names = set()
    for line in logical:
        hashes = re.findall(r'(?:^|\s)--hash=sha256:([a-f0-9]{64})(?=\s|$)', line)
        requirement = re.sub(r'(?:^|\s)--hash=sha256:[a-f0-9]{64}(?=\s|$)', '', line).strip()
        match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9.!+_-]+(?:\s*;[^\r\n]+)?', requirement)
        require(hashes and match and '--' not in requirement and '#' not in requirement, 'unhashed_or_unpinned_lock')
        names.add(match.group(1).lower().replace('_', '-'))
    require(not core or ROOTS | {'janus-swi'} <= names, 'core_lock_roots_missing')


def references(release):
    required = {'schema', 'ready', 'release_id', 'source_revision', 'source_tree', 'min_free_bytes',
                'core_roots', 'python_version', 'uv_version', 'ui_prebuilt', 'swipl_version',
                'petta_commit', 'platforms', 'apps', 'bootstrap', 'module_files',
                'default_model', 'embedding_model', 'ssh_target'}
    require(type(release) is dict and set(release) == required
            and release.get('ready') is True and release.get('schema') == 'studio-linux-user-release/2', 'release_not_ready')
    require(type(release['release_id']) is str and re.fullmatch('[a-z0-9][a-z0-9._-]{1,79}', release['release_id'])
            and all(type(release[k]) is str and re.fullmatch('[a-f0-9]{40}', release[k])
                    for k in ('source_revision', 'source_tree', 'petta_commit')), 'release_identity_missing')
    require(type(release['core_roots']) is list and len(release['core_roots']) == 6
            and set(release['core_roots']) == ROOTS
            and type(release['min_free_bytes']) is int and release['min_free_bytes'] >= 5 * 1024**3,
            'core_roots_or_disk_missing')
    require(type(release['python_version']) is str and re.fullmatch(r'3\.12\.[0-9]+', release['python_version'])
            and all(type(release[k]) is str and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', release[k])
                    for k in ('uv_version', 'swipl_version')), 'runtime_versions_missing')
    require(type(release['default_model']) is str
            and re.fullmatch(r'openrouter/[A-Za-z0-9][A-Za-z0-9._:/-]{1,200}', release['default_model'])
            and type(release['embedding_model']) is str
            and re.fullmatch(r'(?:mock/hash|(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9._:/-]{0,200})', release['embedding_model'])
            and (release['ssh_target'] is None or type(release['ssh_target']) is str
                 and re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}', release['ssh_target'])),
            'runtime_model_or_target_missing')
    require(type(release.get('platforms')) is dict
            and set(release['platforms']) == {'x86_64', 'aarch64'}, 'both_platforms_required')
    refs = {'install.py', 'release-manifest.json'}
    ui = release['ui_prebuilt']
    require(type(ui) is dict and set(ui) == {'archive', 'manifest', 'source_revision', 'source_tree'}
            and all(type(ui[k]) is str and re.fullmatch('[a-f0-9]{40}', ui[k])
                    for k in ('source_revision', 'source_tree')), 'ui_prebuilt_inputs_required')
    ui_pins = row_map([ui['archive'], ui['manifest']])
    require(ui['archive']['path'] != ui['manifest']['path']
            and ui['manifest']['bytes'] <= 2 * 1024**2, 'ui_artifact_paths_or_manifest_size')
    refs.update(ui_pins)
    payload = None
    for platform in release['platforms'].values():
        require(type(platform) is dict and set(platform) == {'uv', 'python', 'swipl_source',
                'petta_source', 'source_payload', 'core_lock', 'build_lock'}, 'closed_platform_inputs')
        if payload is None:
            payload = platform['source_payload']
        require(platform['source_payload'] == payload, 'one_identical_source_tarball_required')
        for key in ('source_payload', 'core_lock', 'build_lock'):
            refs.add(relative_name(platform[key]['path']))
        for key in ('uv', 'python', 'swipl_source', 'petta_source'):
            item = platform[key]
            url = urlsplit(item['url'])
            require(url.scheme == 'https' and url.hostname in PUBLIC_HOSTS and not url.username
                    and not url.password and not url.query and not url.fragment
                    and url.port in (None, 443)
                    and type(item.get('bytes')) is int and 0 < item['bytes'] <= 512 * 1024**2
                    and type(item.get('sha256')) is str and re.fullmatch('[a-f0-9]{64}', item['sha256']),
                    'public_runtime_pin_required')
    require(type(release.get('apps')) is list and len(release['apps']) == 2
            and {item['id'] for item in release['apps']} == {'omegaassist', 'omegadesign'}, 'both_apps_required')
    for item in release['apps']:
        require(type(item.get('digest')) is str and re.fullmatch('sha256:[a-f0-9]{64}', item['digest']),
                'program_digest_required')
        refs.add(relative_name(item['path']))
    require(type(release.get('bootstrap')) is dict and set(release['bootstrap']) == {'helper', 'seed'}, 'bootstrap_inputs_required')
    for item in release['bootstrap'].values():
        refs.add(relative_name(item['path']))
    return refs, payload


def render_script(template, compressed):
    require(0 < len(compressed) <= COMPRESSED_CAP and template.endswith(MARKER)
            and template.count(MARKER) == 1, 'fixed_wrapper_template_required')
    changes = [(b'ROOT_BOUND_RELEASE=0\n', b'ROOT_BOUND_RELEASE=1\n'),
               (b'BUNDLE_BYTES=0\n', ('BUNDLE_BYTES=' + str(len(compressed)) + '\n').encode()),
               (b'BUNDLE_SHA256=UNBOUND\n', ('BUNDLE_SHA256=' + hashlib.sha256(compressed).hexdigest() + '\n').encode())]
    for old, new in changes:
        require(template.count(old) == 1, 'wrapper_binding_seam_required')
        template = template.replace(old, new, 1)
    require(b'UNBOUND' not in template and b'PLACEHOLDER' not in template, 'wrapper_unbound')
    result = template + base64.b64encode(compressed) + b'\n'
    require(len(result) <= SCRIPT_CAP, 'script_size_cap')
    return result


def main():
    require(not sys.flags.optimize and FINAL_RELEASE_BOUND is True
            and type(INPUTS_BYTES) is int and 0 < INPUTS_BYTES <= 8 * 1024**2
            and type(INPUTS_SHA256) is str and re.fullmatch('[a-f0-9]{64}', INPUTS_SHA256), 'build_source_unbound')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-reviewed-kit', action='store_true')
    args = parser.parse_args()
    require(args.build_reviewed_kit, 'explicit_build_required')
    input_pin = {'path': INPUTS.name, 'bytes': INPUTS_BYTES, 'sha256': INPUTS_SHA256}
    raw = read_exact(HERE, input_pin)
    spec = strict_json(raw)
    require(type(spec) is dict and set(spec) == {'schema', 'ready', 'github', 'forbidden_public_terms',
            'installer_template', 'release_manifest', 'artifacts'}
            and spec['schema'] == 'omegahive-linux-kit-inputs/1' and spec['ready'] is True, 'closed_bound_kit_inputs')
    no_placeholders(spec)
    github = spec['github']
    require(type(github) is dict and set(github) == {'repository', 'branch', 'commit', 'tree',
            'source_tarball_url', 'source_prefix'}, 'closed_github_subject')
    plain_github_url(github['repository'])
    require(re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', github['repository'])
            and github['branch'] == 'release/linux-test-20261028'
            and all(type(github[k]) is str and re.fullmatch('[a-f0-9]{40}', github[k]) for k in ('commit', 'tree')),
            'exact_release_branch_commit_tree_required')
    plain_github_url(github['source_tarball_url'], github['repository'])
    terms = spec['forbidden_public_terms']
    require(type(terms) is list and 0 < len(terms) <= 64
            and all(type(x) is str and 0 < len(x) <= 128 for x in terms), 'reviewed_scrub_terms_required')
    artifacts = row_map(spec['artifacts'])
    for name in artifacts:
        public_text(name.encode(), terms)
    public_text(json.dumps(github).encode(), terms)
    require(spec['release_manifest']['path'] == 'release-manifest.json'
            and artifacts.get('release-manifest.json') == spec['release_manifest'], 'release_manifest_member_required')
    bodies = {name: read_exact(INPUT_ROOT, row) for name, row in artifacts.items()}
    release = strict_json(bodies['release-manifest.json'])
    no_placeholders(release)
    require(release.get('source_revision') == github['commit'] and release.get('source_tree') == github['tree'], 'github_release_subject_mismatch')
    refs, payload = references(release)
    prefix = source_prefix(payload, github['source_prefix'])
    require(set(artifacts) == refs, 'extra_or_missing_outer_member')
    modules = source_rows(release['module_files'])
    require({'deploy/linux/install.py', 'deploy/linux/control.py', 'deploy/linux/serve.py',
             'deploy/linux/omegahive.service.in'} <= set(modules)
            and all(name.startswith('deploy/linux/') for name in modules)
            and all(modules['deploy/linux/install.py'][k] == artifacts['install.py'][k] for k in ('bytes', 'sha256')),
            'top_installer_module_mismatch')
    for name, body in bodies.items():
        if PurePosixPath(name).suffix.casefold() in TEXT_SUFFIXES:
            public_text(body, terms)
    inspect_source(bodies[payload['path']], prefix, payload['files'], github['tree'], terms)
    for platform in release['platforms'].values():
        for key in ('source_payload', 'core_lock', 'build_lock'):
            item = platform[key]
            require(all(artifacts[item['path']][k] == item[k] for k in ('bytes', 'sha256')), 'local_payload_pin_mismatch')
        validate_lock(bodies[platform['core_lock']['path']], core=True)
        validate_lock(bodies[platform['build_lock']['path']])
        inventory = source_rows(platform['source_payload']['files'])
        require(all(inventory.get(name) == row for name, row in modules.items()), 'module_source_vector_mismatch')
    for item in release['apps']:
        require(all(artifacts[item['path']][k] == item[k] for k in ('bytes', 'sha256')), 'app_archive_pin_mismatch')
        inspect_app(bodies[item['path']], item, terms)
    for item in release['bootstrap'].values():
        require(all(artifacts[item['path']][k] == item[k] for k in ('bytes', 'sha256')), 'bootstrap_pin_mismatch')
    ui = release['ui_prebuilt']
    for key in ('archive', 'manifest'):
        item = ui[key]
        require(artifacts.get(item['path']) == item, 'ui_artifact_pin_mismatch')
    ui_files = inspect_ui_manifest(bodies[ui['manifest']['path']], ui, terms)
    inspect_ui_archive(bodies[ui['archive']['path']], ui_files, terms)
    template = read_exact(INPUT_ROOT, spec['installer_template'])
    public_text(template, terms)
    archive_bytes = io.BytesIO()
    with gzip.GzipFile(fileobj=archive_bytes, mode='wb', filename='', mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w') as archive:
            for name in sorted(bodies):
                info = tarfile.TarInfo(name)
                info.size = len(bodies[name]); info.mode = 0o600; info.mtime = 0
                info.uid = info.gid = 0; info.uname = info.gname = ''
                archive.addfile(info, io.BytesIO(bodies[name]))
    script = render_script(template, archive_bytes.getvalue())
    # Recheck every supplied body before creating any output. No caller code ran.
    require(read_exact(HERE, input_pin) == raw, 'input_manifest_changed')
    for name, row in artifacts.items():
        require(read_exact(INPUT_ROOT, row) == bodies[name], 'artifact_changed_before_output')
    require(read_exact(INPUT_ROOT, spec['installer_template']) == template, 'template_changed_before_output')
    os.umask(0o077)
    OUTPUT.mkdir(mode=0o700, exist_ok=False)
    name = 'omegahive-linux.sh'
    for filename, body, mode in [(name, script, 0o700),
            (name + '.sha256', (hashlib.sha256(script).hexdigest() + '  ' + name + '\n').encode(), 0o600)]:
        fd = os.open(OUTPUT / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps({'status': 'LOCAL_KIT_SEALED_NOT_PUBLISHED', 'file': name,
                      'bytes': len(script), 'sha256': hashlib.sha256(script).hexdigest(),
                      'source_commit': github['commit'], 'source_tree': github['tree'],
                      'embedded_members': sorted(bodies), 'publication_performed': False}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Refused as error:
        print('kit: ' + str(error), file=sys.stderr)
        raise SystemExit(64)
    except Exception:
        print('kit: build_refused_no_publication', file=sys.stderr)
        raise SystemExit(64)
